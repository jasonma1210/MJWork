// DFU 写入通道的执行器（L4，2026-10-31）：列设备 → 挑目标 → 挑 alt → 算摘要 → 写入 → 判结果。
//
// 为什么单独成文件而不是塞进 deviceFlashTool：
//   · deviceFlashTool 已 835 行，再往里加就走 max-lines 软档（800 code 行）红线；
//   · 这里要 require child_process —— deviceFlashTool 也 require 本模块，同文件互 require 会成环，
//     环上的 `const { defaultRun } = require(...)` 拿到的是**半成品导出**（undefined），
//     表现为「烧到一半 TypeError」，而不是启动就报错。
//
// 「写成功」在这里定义成三件事同时成立（缺一就只是「命令跑完了」）：
//   ① 输出里有 `Download done.` 或 `File downloaded successfully`（退出码 0 不算证据：
//      dfu-util 在设备中途掉线时也可能返回 0）；
//   ② 退出码 0（有成功行但退出码非零的场合按失败处理，两者矛盾时取更保守的那个）；
//   ③ 目标与地址都来自**本次实时枚举**，且摘要与 plan 阶段一致（设备换过就必须重走 plan）。
//
// 有意不做的事：
//   · verify / backup：dfu-util 的回读（`-U`）长度语义依赖设备实现，本机无 DFU 板可验，
//     宁可不接线也不写一条没在真机上验证过的命令（同 deviceProbe 的「未验过不写」纪律）；
//   · 手动指定 alt：写错 alt 会落在 Option Bytes 上把板子锁住，这条口子绝不能开。

const fs = require('fs');
const { execFile } = require('child_process');
const {
  parseDfuList, pickTarget, pickAlt, buildDfuPlan, parseDfuFlash, DFU_FLASH_VERDICTS,
} = require('../deviceDfu');
const { parseVidPid } = require('../deviceFlash');

const DFU_TIMEOUT_MS = 180000; // 256KB 固件实测在 10s 量级；留足余量给小 flash 的整片擦除
const DFU_MAX_BUFFER = 4 * 1024 * 1024;
const TAIL_CHARS = 4000;

const NO_TOOL_ERROR = '没找到 dfu-util：需要先安装（brew install dfu-util）。'
  + '装了之后 device_probe 会把它算进通道能力，本通道才能执行。';

/** 默认执行器：argv 化（firmware 路径即使含 `; rm -rf /` 也只是一个文件名，不过 shell）。 */
function defaultDfuRun(argv, timeoutMs = DFU_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: DFU_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        signal: err && err.signal,
        // ENOENT 要单独带出来：它与「命令跑了但失败」的下一步完全不同
        // （前者去装 dfu-util，后者去看 USB 权限/线材）。混淆会让人白装一次。
        spawnError: err && err.code === 'ENOENT' ? 'ENOENT' : null,
      }));
  });
}

/**
 * 枚举 DFU 设备。
 * `-l` 在没有设备时退出码是 74(EX_IOERR)，但输出里会明说 "No DFU capable USB device"——
 * 所以判据是**输出**而不是退出码：只看退出码会把「没插设备」当成「工具坏了」。
 */
async function dfuList({ run = defaultDfuRun } = {}) {
  let r;
  try {
    r = await run(['dfu-util', '-l']);
  } catch (e) {
    // 注入的执行器自己抛错（不是 dfu-util 的退出码）：必须报出来，否则会被读成「一个设备都没有」
    return { ok: false, installed: null, targets: [], error: `dfu-util 调用失败：${String(e && e.message ? e.message : e).slice(0, 200)}` };
  }
  if (r && r.spawnError === 'ENOENT') return { ok: false, installed: false, targets: [], error: NO_TOOL_ERROR };
  const parsed = parseDfuList(`${r?.stdout || ''}\n${r?.stderr || ''}`);
  return { ...parsed, installed: parsed.ok ? true : null, exitCode: r?.code };
}

/** 失败档 → 下一步动作。每一档的下一步都不同，压成一句「失败」等于把定位工作丢回给用户。 */
function explainFailure(verdict, exitCode) {
  if (verdict === DFU_FLASH_VERDICTS.device) {
    return 'DFU 设备不在了或打不开（被拔掉、或 USB 权限不足）：重插后重跑 action=plan —— '
      + '这次的 plan_digest 已作废，不要拿旧摘要重试。';
  }
  if (verdict === DFU_FLASH_VERDICTS.addr) {
    return '地址不在设备的任何可写区间：确认这块板的内存映射（STM32 主 flash 通常是 0x08000000，'
      + '写 0x0 会落到别名区或直接越界）。DfuSe 只接受整块 element 的起始地址。';
  }
  if (verdict === DFU_FLASH_VERDICTS.transfer) {
    return '传输中途失败：多数是供电不足、劣质线材，或擦除过程中被插拔。'
      + '让板子重新进 DFU 后再写一次——半写的设备仍然能进 bootloader，不会变砖。';
  }
  if (verdict === DFU_FLASH_VERDICTS.noEvidence) {
    return '命令返回 0，但输出里没有 "File downloaded successfully"：这**不能**当成写成功。'
      + '看下面的 stdout/stderr 原文判断它到底做了什么（也可能什么都没做）。';
  }
  return `dfu-util 执行失败（exit=${exitCode}）：看下面的 stderr，并且确认 dfu-util 版本支持 DfuSe（0.9+）。`;
}

/**
 * 执行 DFU 通道的 plan / flash。
 * @param {object} args { action, firmware, offset, channel, plan_digest, expect_vid_pid, port? }
 * @param {object} deps 注入 run / stat，便于单测（不碰真实设备）
 */
async function dfuChannelHandler(args = {}, deps = {}) {
  const action = String(args.action || 'plan');
  const run = deps.run || defaultDfuRun;
  const stat = deps.stat || fs.statSync;
  const firmware = String(args.firmware || '').trim();
  // 每个失败分支都要**显式**带 ok:false —— 缺字段时调用方写 `r.ok === false` 会得到 false
  // （undefined !== false），于是一次被拒绝的写入会被上层当成"没有失败"，这是同一类空过的温床。
  const base = { ok: false, channel: 'dfu-util', action };

  if (action !== 'plan' && action !== 'flash') {
    return {
      ...base,
      error: `DFU 通道不支持 ${action}：dfu-util 的回读（-U）长度语义依赖设备实现，本机没有 DFU 板验证过，`
        + '故不接线。要回读校验/整片备份，请让板子进串口下载模式走 esptool 通道。',
    };
  }
  if (!firmware) return { ...base, error: '缺少 firmware：DFU 通道必须指定固件路径（.bin / .dfu）' };

  let st;
  try {
    st = stat(firmware);
  } catch (e) {
    return { ...base, error: `固件不可读：${firmware}（${String(e && e.message ? e.message : e).slice(0, 80)}）` };
  }
  if (!st.isFile()) return { ...base, error: `固件路径不是文件：${firmware}` };
  if (!st.size) return { ...base, error: `固件是空文件（0 字节）：${firmware}` };

  const listed = await dfuList({ run });
  if (!listed.ok) return { ...base, error: listed.error, installed: listed.installed };
  const picked = pickTarget(listed.targets);
  if (!picked.ok) return { ...base, error: picked.error, targets: listed.targets };
  const target = picked.target;

  // 身份钉子（可选但给了就必须对上）：DFU 设备在 plan 与 flash 之间可能被换成另一块板，
  // 那时刻在摘要里的 vid:pid 会变 —— 但若模型显式指定了 expect_vid_pid，就要在这里也核一次，
  // 免得「摘要因为两块板参数相同而仍然匹配」这种极端情况被漏过。
  const wantId = parseVidPid(args.expect_vid_pid);
  if (String(args.expect_vid_pid || '').trim() && !wantId) {
    return { ...base, error: `expect_vid_pid 写法不合法：\`${args.expect_vid_pid}\`（应为 \`0483:df11\` 这种 VID:PID）` };
  }
  if (wantId && wantId !== `${target.vid}:${target.pid}`) {
    return {
      ...base,
      error: `当前 DFU 设备是 ${target.vid}:${target.pid}，与 expect_vid_pid=${wantId} 不符：拒绝写入身份不符的目标`,
    };
  }

  const alt = pickAlt(target);
  if (!alt.ok) return { ...base, error: alt.error, candidates: alt.candidates };

  const built = buildDfuPlan({
    target, alt: alt.alt, altName: alt.name, addr: args.offset, firmware, fileSize: st.size,
  });
  if (!built.ok) return { ...base, error: built.error, warnings: built.warnings };

  const warnings = [...built.warnings, ...(args.port ? [`DFU 不经串口：port=${args.port} 已忽略（DFU 设备没有串口节点）`] : [])];
  if (Array.isArray(args.segments) && args.segments.length) {
    warnings.push('DFU 通道只写单一文件：segments 已忽略（多段烧写走 esptool 通道）');
  }

  const info = {
    ...base,
    target: `${target.vid}:${target.pid}`,
    serial: target.serial || '',
    alt: built.alt,
    altName: built.altName,
    addr: built.addr,
    firmware,
    sizeBytes: st.size,
    warnings,
  };

  if (action === 'plan') {
    return {
      ...info,
      ok: true,
      argv: built.argv,
      plan_digest: built.digest,
      card: built.card,
      next: built.next,
    };
  }

  // ── flash：摘要必须在**本次实时枚举**的前提下重算并比对 ──────────────────────
  const digest = String(args.plan_digest || '').trim();
  if (!digest) {
    return { ...info, ok: false, error: '缺少 plan_digest：必须先 action=plan，把人确认过的摘要一起带回来（防参数在确认后被改）' };
  }
  if (digest !== built.digest) {
    return {
      ...info,
      ok: false,
      error: `plan_digest 不匹配（当前参数算出 ${built.digest}）：目标设备、alt、地址或固件在确认后变过，请重新 plan 并让人再看一眼`,
    };
  }

  const r = await run(built.argv);
  const res = parseDfuFlash(`${r?.stdout || ''}\n${r?.stderr || ''}`, { exitCode: r?.code });
  const post = [];
  if (res.ok && !res.left) {
    // 写进去了但设备没接受 leave 请求：用户会看到「烧成功但板子不动」，必须提前说清
    post.push('写入完成，但输出里没有 leave 请求（Submitting leave request）：设备可能仍停在 bootloader，不会跑新固件。'
      + '按一下复位键或重新上电即可。');
  }
  if (res.bytes && res.bytes !== st.size) {
    post.push(`设备报告的写入长度 ${res.bytes} 与文件大小 ${st.size} 不一致：确认 offset 与设备报告的是同一片区间`);
  }
  return {
    ...info,
    ok: res.ok,
    argv: built.argv,
    plan_digest: digest,
    verdict: res.verdict,
    downloaded: res.downloaded,
    leftBootloader: res.left,
    manifest: res.manifest,
    wroteBytes: res.bytes,
    exitCode: r?.code,
    signal: r?.signal || null,
    stdout: String(r?.stdout || '').slice(-TAIL_CHARS),
    stderr: String(r?.stderr || '').slice(-TAIL_CHARS),
    warnings: [...warnings, ...post],
    card: built.card,
    error: res.ok ? undefined : explainFailure(res.verdict, r?.code),
    hint: res.ok
      ? `写入成功（${res.bytes ? `${res.bytes} 字节` : '设备已确认'}，设备已退出 DFU 开始跑新固件）。`
        + 'DFU 通道没有回读校验：要证明字节完全一致，让板子进串口下载模式走 esptool 的 verify。'
      : '本次未确认写入成功；板子仍可进 DFU 重试（bootloader 在 ROM 里，半写不会变砖）。',
  };
}

module.exports = { dfuChannelHandler, dfuList, defaultDfuRun, explainFailure, NO_TOOL_ERROR, DFU_TIMEOUT_MS };
