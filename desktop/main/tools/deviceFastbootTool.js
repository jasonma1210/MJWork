// Android fastboot 通道的执行器（2026-10-31）：列设备 → 读身份 → 校验分区 → 算摘要 → 刷分区 → 判结果。
//
// 真机实测（fastboot 37.0.0，本机不接设备）决定了这里的两个硬约束：
//   ① `devices -l` 空输出 + exit 0 ⇒ 只能靠「空」判没有设备；
//   ② `getvar` / `flash` 在没有设备时**会无限等待**（`< waiting for SERIAL >`），带 -s 也一样。
//      所以每个命令都带超时，超时被杀单独判一档（verdict='waiting'）——它表示「根本没开始写」，
//      与「写到一半失败」的下一步完全不同（前者去看手机，后者去查线/存储）。
//
// 只做一件事：`fastboot flash <白名单分区> <img>`。不做解锁、erase、format、flashall、-w。

const fs = require('fs');
const { execFile } = require('child_process');
const {
  parseFastbootDevices, parseGetvar, pickDevice, resolvePartition,
  buildFbPlan, parseFastbootFlash, FB_VERDICTS, FB_MAX_BUFFER,
} = require('../deviceFastboot');

// 探测类命令给 8s：正常设备 getvar 是毫秒级；等 8s 还没回来说明设备不在 fastboot 模式，
// 继续等只会把工具调用挂死（实测无设备时会一直等下去）。
const FB_PROBE_TIMEOUT_MS = 8000;
// 写分区给 180s：system/super 动辄几 GB，USB2 下几 MB/s 是常态。
const FB_FLASH_TIMEOUT_MS = 180000;
const TAIL_CHARS = 3000;

const NO_TOOL_ERROR = '没找到 fastboot：需要先安装 Android platform-tools'
  + '（brew install --cask android-platform-tools）。装了之后 device_probe 会把它算进通道能力。';

/** 默认执行器：argv 化（镜像路径即使是 `; rm -rf /` 也只是一个文件名，不过 shell）。 */
function defaultFbRun(argv, timeoutMs = FB_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: FB_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        // killed 必须带出来：超时被杀与「命令自己失败」的下一步相反
        killed: Boolean(err && err.killed),
        spawnError: err && err.code === 'ENOENT' ? 'ENOENT' : null,
      }));
  });
}

async function fbDevices({ run = defaultFbRun } = {}) {
  let r;
  try {
    r = await run(['fastboot', 'devices', '-l']);
  } catch (e) {
    // 注入的执行器自己抛错：必须报出来，否则会被读成「一台设备都没有」
    return { ok: false, installed: null, devices: [], error: `fastboot 调用失败：${String(e && e.message ? e.message : e).slice(0, 200)}` };
  }
  if (r && r.spawnError === 'ENOENT') return { ok: false, installed: false, devices: [], error: NO_TOOL_ERROR };
  const parsed = parseFastbootDevices(r?.stdout || '');
  if (r && r.killed) {
    return { ok: false, installed: true, devices: [], error: 'fastboot devices 超时未返回：工具卡住（重装 platform-tools 或检查 USB 连接）' };
  }
  return { ...parsed, installed: parsed.ok ? true : null, exitCode: r?.code };
}

/**
 * 读设备身份：product / current-slot / unlocked。
 * 分开调用而不是 `getvar all`：all 在新版 fastboot 上已被标记弃用，且输出量随设备差异极大。
 */
async function fbGetvars(serial, { run = defaultFbRun } = {}) {
  const vars = {};
  const errors = [];
  for (const key of ['product', 'current-slot', 'unlocked', 'secure']) {
    const r = await run(['fastboot', '-s', String(serial), 'getvar', key]);
    if (r && r.spawnError === 'ENOENT') return { ok: false, vars, errors: [NO_TOOL_ERROR] };
    if (r && r.killed) {
      // 挂住 = 设备已经从 bootloader 掉了（或根本没进）。继续问下一个 key 会再各挂 8s。
      return {
        ok: false, vars, errors,
        error: `读设备信息超时（fastboot getvar ${key}）：设备可能已退出 fastboot 模式。`
          + '重新进 bootloader 后再试；这一轮没有对设备做任何写入。',
      };
    }
    const parsed = parseGetvar(`${r?.stdout || ''}\n${r?.stderr || ''}`);
    if (!parsed.ok) {
      // 单个 key 读不到不算失败（很多设备没有 unlocked / secure），只记下来
      errors.push(`${key}: ${parsed.error.slice(0, 120)}`);
      continue;
    }
    Object.assign(vars, parsed.vars);
  }
  return { ok: true, vars, errors };
}

function explainFailure(verdict, extra = {}) {
  if (verdict === FB_VERDICTS.waiting) {
    return '设备从头到尾没连上（fastboot 一直在「waiting for device」）：确认手机停在 bootloader 界面'
      + '（不是普通开机、也不是只开了 USB 调试），换一根能传数据的线再试。**本次没有写入任何分区**。';
  }
  if (verdict === FB_VERDICTS.locked) {
    return '设备处于锁定状态，fastboot 拒绝了写入。解锁要在手机上做（开发者选项 → OEM 解锁 → '
      + '`fastboot flashing unlock`，多数机型会清空数据）。本工具不做解锁。';
  }
  if (verdict === FB_VERDICTS.partition) {
    return '设备上找不到这个分区：分区名拼错，或这台设备没有这个分区（例如没有独立 dtbo）。'
      + '先用 action=plan 看 getvar 返回的 product / current-slot，再确认分区名。';
  }
  if (verdict === FB_VERDICTS.remote) {
    return `设备侧拒绝：${extra.remote || 'FAILED (remote: ...)'}。这类错误来自设备固件自身的策略`
      + '（防回滚、分区尺寸不符、未解锁），不是 USB 问题，重试无用。';
  }
  if (verdict === FB_VERDICTS.transfer) {
    return '传输中断：换成直连 USB 口（别用集线器）、换线。解锁设备可以重进 bootloader 再刷一次。';
  }
  return `fastboot 执行失败（exit=${extra.exitCode ?? '?'}）：看下面的原始输出。`
    + '注意「退出码 0」不等于刷成功——判据是 Finished. Total time 且没有 FAILED。';
}

/**
 * 执行 fastboot 通道的 plan / flash。
 * @param {object} args { action, firmware, partition, serial, slot, plan_digest }
 * @param {object} deps 注入 run / stat
 */
async function fastbootChannelHandler(args = {}, deps = {}) {
  const action = String(args.action || 'plan');
  const run = deps.run || defaultFbRun;
  const stat = deps.stat || fs.statSync;
  const firmware = String(args.firmware || '').trim();
  const base = { ok: false, channel: 'fastboot', action };

  if (action !== 'plan' && action !== 'flash') {
    return {
      ...base,
      error: `fastboot 通道不支持 ${action}：只接 plan / flash。回读校验（fastboot fetch）非标准、多数设备不支持，`
        + '整片备份也要靠厂商工具，故不接线。验收要看设备能否正常开机，不是在主机侧比字节。',
    };
  }
  if (!firmware) return { ...base, error: '缺少 firmware：fastboot 通道需要 .img 分区镜像' };
  const partitionName = String(args.partition || '').trim();
  if (!partitionName) {
    return { ...base, error: '缺少 partition：必须显式说明刷哪个分区（boot / recovery / system …），不猜' };
  }

  let st;
  try {
    st = stat(firmware);
  } catch (e) {
    return { ...base, error: `镜像不可读：${firmware}（${String(e && e.message ? e.message : e).slice(0, 80)}）` };
  }
  if (!st.isFile()) return { ...base, error: `镜像路径不是文件：${firmware}` };
  if (!st.size) return { ...base, error: `镜像是空文件（0 字节）：${firmware}` };

  const listed = await fbDevices({ run });
  if (!listed.ok) return { ...base, error: listed.error, installed: listed.installed };
  const picked = pickDevice(listed.devices, args.serial);
  if (!picked.ok) return { ...base, error: picked.error, devices: listed.devices };
  const device = picked.device;

  // 读身份：拿 current-slot 决定分区后缀，拿 unlock 状态决定要不要提前拒。
  // 读失败（超时）直接终止：那说明设备在执行过程中掉了，此时继续装配命令毫无意义。
  const got = await fbGetvars(device.serial, { run });
  if (!got.ok) return { ...base, error: got.error, serial: device.serial };

  const partitionInfo = resolvePartition(partitionName, {
    slot: args.slot, currentSlot: got.vars['current-slot'],
  });
  if (!partitionInfo.ok) return { ...base, error: partitionInfo.error, serial: device.serial };

  const built = buildFbPlan({
    device, partitionInfo, firmware, fileSize: st.size, vars: got.vars,
  });
  if (!built.ok) return { ...base, error: built.error, warnings: built.warnings, serial: device.serial };

  const info = {
    ...base, ok: true,
    serial: built.serial,
    product: built.product,
    currentSlot: built.slot,
    partition: built.partition,
    firmware,
    sizeBytes: st.size,
    warnings: [...built.warnings, ...(got.errors.length ? [`部分 getvar 未读到：${got.errors.join('; ')}`] : [])],
  };
  if (action === 'plan') {
    return { ...info, argv: built.argv, plan_digest: built.digest, card: built.card, next: built.next };
  }

  // flash：摘要必须在**本次实时探测**的前提下重算并比对
  const digest = String(args.plan_digest || '').trim();
  if (!digest) {
    return { ...info, ok: false, error: '缺少 plan_digest：必须先 action=plan，把人确认过的摘要一起带回来' };
  }
  if (digest !== built.digest) {
    return {
      ...info, ok: false,
      error: `plan_digest 不匹配（当前参数算出 ${built.digest}）：设备、分区或镜像在确认后变过，请重新 plan`,
    };
  }

  const r = await run(built.argv, FB_FLASH_TIMEOUT_MS);
  const res = parseFastbootFlash(r?.stdout, r?.stderr, { exitCode: r?.code, killed: r?.killed });
  const warnings = [...info.warnings];
  const raw = `${r?.stdout || ''}${r?.stderr || ''}`;
  if (res.ok && !/Sending .*OKAY/i.test(raw)) {
    // 成功但没看到 Sending ... OKAY：不判失败（各版本措辞不同），但提示别把「没报错」当证据
    warnings.push('输出里没有典型的 Sending ... OKAY 行：建议重启设备确认实际跑的是新镜像');
  }
  return {
    ...info,
    ok: res.ok,
    argv: built.argv,
    plan_digest: digest,
    verdict: res.verdict,
    finished: res.finished,
    remote: res.remote,
    exitCode: r?.code,
    stdout: String(r?.stdout || '').slice(-TAIL_CHARS),
    stderr: String(r?.stderr || '').slice(-TAIL_CHARS),
    warnings,
    card: built.card,
    error: res.ok ? undefined : explainFailure(res.verdict, { remote: res.remote, exitCode: r?.code }),
    hint: res.ok
      ? `已刷入 ${built.partition}（${st.size} 字节）。请让设备重启确认能正常开机——`
        + 'fastboot 的「成功」只代表字节送达，不代表系统能起来。'
      : '本次未确认写入成功；解锁设备可重进 bootloader 重试。',
  };
}

module.exports = {
  fastbootChannelHandler, fbDevices, fbGetvars, defaultFbRun,
  explainFailure, NO_TOOL_ERROR, FB_PROBE_TIMEOUT_MS, FB_FLASH_TIMEOUT_MS,
};
