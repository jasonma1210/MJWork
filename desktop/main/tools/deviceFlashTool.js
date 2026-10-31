// device_flash 的工具实现（2026-10-31）：把 deviceFlash 的决策层接到真实的 esptool 上。
//
// 七档 action —— 递进而非并列，是保护策略的核心：
//   · list_targets：只读。列可烧磁盘（排除系统盘/内置盘/虚拟盘）与串口。不弹审批卡。
//   · chip_id     ：只读。用 esptool `--chip auto` 跟芯片同步一次，查出它到底是哪颗
//                   （桥芯片后面可能是 ESP32/STM32/AVR，光看 VID 永远不知道）。不弹审批卡。
//   · plan        ：纯计算。装配 argv、生成审批卡、算出 plan_digest。**不执行**。不弹卡。
//   · flash       ：写设备。必须回传 plan 阶段拿到的 plan_digest。**每次弹卡，L1 不可豁免**。
//   · verify      ：回读校验（esptool verify_flash）。与 flash 共用同一条前置门与同一个 digest，
//                   只把设备内容与本地文件逐字节比对，**不写设备**——烧完拿它自证，别信「成功」两个字。
//   · backup      ：整片备份（esptool read_flash）。读设备、**写磁盘**，因此额外两条约束：
//                   输出路径必须显式给、已存在则拒绝覆盖（把唯一一份恢复镜像写坏＝毁掉回滚手段）。
//   · logs        ：抓串口启动输出（L5）。verify 证明「写对了」，它证明「能跑」——
//                   判据是启动链路的证据（ROM banner / entry / IDF 日志行），不是「有输出」。
//                   会独占串口并复位板子以便从 0 抓，因此与 chip_id 同档（L1）。
// 分档的理由：若一把执行，用户在被问「要不要烧」时看不到 argv（审批卡只渲染 tool + target），
// 只能凭模型口述作判断。先 plan 后 flash 让「将要执行什么」以 tool result 的形式落到对话里，
// 用户和 digest 校验各有一份证据。
//
// 六道保护（缺任何一道都可被绕过）：
//   ① argv 化执行（execFile）：firmware 路径即使含 `; rm -rf /` 也只是一个文件名，不过 shell。
//   ② plan_digest：flash 时按当前参数重算并比对，换 port / 换固件必须重走 plan。
//   ③ 串口白名单：port 必须在**本次实时枚举**的串口列表里，防模型编一个不存在的设备名。
//   ④ 固件存在性：不存在直接拒绝（否则 esptool 会在板子上跑到一半才报错，那时已经动了 flash）。
//   ⑤ 审批卡五要素：影响面 / 失败后果 / 回滚方式，缺一项 approvalCard 直接抛错。
//   ⑥ L1 分级（main/approval.js 特判）：任何档位都弹卡、不接受「始终允许」、不进规则库。
//
// 边界：只做 esptool 串口烧固件。**不做**磁盘镜像烧写（dd / diskutil restore）——那条路径
// 破坏面是整盘，需要独立的审批与回滚设计，`partitionCandidates` 目前只用于「列给人看」。

const fs = require('fs');
const { execFile } = require('child_process');
const {
  CHIP_ARGS, partitionCandidates, buildFlashPlan, buildBackupPlan, approvalCard, planDigest,
  checkSegmentsFit, parseFlashIdInfo, normalizeSegments, parseSize, parseVidPid,
  resolveImageFormat, esptoolFormatCheck, parseHandshake, HANDSHAKE_VERDICTS,
} = require('../deviceFlash');
const { parseUsbTree, classifyPorts } = require('../deviceProbe');
const { splitPyserialOutput } = require('../devicePorts');
const { listDisks } = require('../diskList');
const { PROBES, defaultExec, parseLinuxUsb, parseWinUsb, resolveEsptoolFromPath } = require('./deviceProbeTool');
const { uf2ChannelHandler, readVolumes } = require('./deviceUf2Tool');
const { isUf2Volume } = require('../deviceUf2');
// DFU 通道（2026-10-31）：纯逻辑在 deviceDfu.js，执行器在 deviceDfuTool.js。
// 这里只做分流，不重复任何 DFU 判据——`resolveFlashRoute` 是「走哪条通道」的唯一判据。
const { resolveFlashRoute } = require('../deviceDfu');
const { dfuChannelHandler } = require('./deviceDfuTool');
const {
  CAPTURE_SCRIPT, VERDICTS, parseCapture, expectTokens, analyzeLog, previewOf,
} = require('../deviceSerial');

const FLASH_TIMEOUT_MS = 300000; // esptool 烧 4MB 固件在 921600 波特率下约 40s；留足余量
// 握手要比烧写短得多：它只做一次 ROM 同步，正常 3–8s，失败时 esptool 自己在 10s 内超时。
// 若沿用 300s，一块不存在的板子会让模型静默卡五分钟——用户只会以为工具挂了。
const HANDSHAKE_TIMEOUT_MS = 30000;
const FLASH_MAX_BUFFER = 4 * 1024 * 1024; // esptool 输出很长，4MB 足够
const TAIL_CHARS = 4000;

/**
 * 串口枚举 + 分类（与 device_probe 共用同一份命令表与 classifyPorts 判据）。
 *
 * 为什么要分类而不是直接返回 `ls /dev/cu.*` 的全量：实测（2026-10-31，macOS）机器上
 * 并存 5 个**蓝牙虚拟串口**（Bluetooth-Incoming-Port / QCYMeloBudsN70 / ROSEAMBRIAN /
 * picunF6 / debug-console）与 1 个真实板子（usbmodem1301）。全量返回会让白名单形同虚设——
 * 它只挡得住「编造的设备名」，挡不住「真实存在但根本不是板子」。用户的原话风险是
 * 「误判会让人对着耳机刷固件」，而 device_flash 这层原本零覆盖。
 *
 * 返回三份，各有用途，不可互相替代：
 *   · all      —— 系统里真实存在的全部口。用于回答「这个口根本不存在」；
 *   · serial   —— classifyPorts 认出的可刷机串口（带 chip/driver 提示）；
 *   · flashable—— serial 的 port 列表，是**硬闸**的唯一依据。
 */
async function readPorts({ exec, platform = process.platform } = {}) {
  const p = PROBES[platform];
  if (!p) return { all: [], serial: [], flashable: [], note: `暂不支持的平台：${platform}` };
  try {
    const r = await exec(p.ports);
    const all = String(r?.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const cls = classifyPorts(all);
    return { all, serial: cls.serial, flashable: cls.serial.map((s) => s.port), note: '' };
  } catch (e) {
    // C-001：枚举失败不能与「一个口都没有」同形 —— 后者用户会去插线，前者再插也没用
    return { all: [], serial: [], flashable: [], note: `串口枚举失败：${String(e?.message || e).slice(0, 120)}（不是「没插设备」）` };
  }
}

/**
 * 探测实际可用的 esptool 命令名（`esptool` 优先，回退 `esptool.py`）。
 * 为什么要探测而不是写死：v5 起 `.py` 后缀被官方标记废弃（本机实测就在打
 * "WARNING: DEPRECATED: 'esptool.py' is deprecated"），未来 major 会移除。
 * 写死的失败形态是「命令根本起不来」，离根因很远；探测后可以 fail-fast 说清楚。
 * 取不到返回 ''，由调用方拒绝并给出安装指引。
 */
async function resolveTool({ exec, platform = process.platform } = {}) {
  const p = PROBES[platform];
  if (!p) return '';
  try {
    return resolveEsptoolFromPath((await exec(p.esptool))?.stdout);
  } catch {
    // 探测失败等价于「没找到」：下面统一按「没装」处理并给出指引（不是静默降级）
    return '';
  }
}

const NO_TOOL_ERROR = '没找到 esptool：需要先安装（pip install esptool）。'
  + 'v5 起命令名是 `esptool`，旧版才是 `esptool.py`——两个都会自动识别，装任一个即可。';

/**
 * esptool 子命令的两种写法（真机实测 2026-10-31）：
 *   v5+ : write-flash / verify-flash / read-flash / flash-id（连字符），下划线形式仅保留兼容并打
 *         "WARNING: Deprecated: Command 'verify_flash' is deprecated. Use 'verify-flash' instead."
 *   v4- : 只认 write_flash / verify_flash / read_flash / flash_id（下划线）
 * 所以不能写死任何一种：写死连字符会打死 v4，写死下划线是在等 v6 把兼容层删掉。
 * 用 `--help` 的输出判断，结果按 (平台, 工具名) 缓存 —— 每个进程只探一次。
 */
const SUBCOMMANDS = {
  dash: { write: 'write-flash', verify: 'verify-flash', read: 'read-flash', id: 'flash-id' },
  underscore: { write: 'write_flash', verify: 'verify_flash', read: 'read_flash', id: 'flash_id' },
};
const SUB_STYLE_CACHE = new Map();

async function resolveSubcommands(tool, { exec, platform = process.platform } = {}) {
  const key = `${platform}:${tool}`;
  if (SUB_STYLE_CACHE.has(key)) return SUB_STYLE_CACHE.get(key);
  // 缺省下划线：v5 也接受（只是告警），v4 只接受；探测失败时这是唯一两边都不炸的选择
  let style = 'underscore';
  try {
    const r = await exec(`${tool} --help`);
    const out = `${r?.stdout || ''}\n${r?.stderr || ''}`;
    if (/\bwrite-flash\b/.test(out)) style = 'dash';
  } catch {
    // 探测失败保持缺省：宁可多一条 deprecation 告警，也不要因为探测问题让烧写路径不可用
  }
  const subs = SUBCOMMANDS[style];
  // style 一并带出：`--before/--after` 的取值在 v5 也换成了连字符（default-reset），
  // 只转子命令名不转取值，仍会打 deprecation 告警——真机实测踩到。
  const out = { ...subs, style };
  SUB_STYLE_CACHE.set(key, out);
  return out;
}

/** 把 `--before/--after` 的取值按探测到的写法转换（default_reset ↔ default-reset）。 */
const sepFor = (style) => (v) => (style === 'dash' ? String(v).replace(/_/g, '-') : String(v));

/** 仅供测试：清掉子命令写法缓存，让同一次进程里能分别验证 v4/v5 两条分支。 */
function resetSubcommandCacheForTest() {
  SUB_STYLE_CACHE.clear();
}

/**
 * 硬闸：port 必须落在**可刷机串口**里（不是「系统里存在」就算）。
 * 抽成函数而不是在两处各写一遍：判据分化是这类闸最典型的失效方式——
 * 一处改了另一处没改，而测试只覆盖其中一处时全绿。
 * @param {string} verb 用于文案（"写入" / "读取"），让报错说清「没做成什么事」
 */
function portGate(port, portRes, verb) {
  if (portRes.flashable.includes(port)) return null;
  const list = portRes.flashable.join(' / ') || '一个都没有';
  const excluded = portRes.all.filter((p) => !portRes.flashable.includes(p));
  const isReal = portRes.all.includes(port);
  const error = isReal
    ? `串口 ${port} 在系统里存在，但不是可刷机串口（可刷：${list}）：拒绝${verb}一个非目标设备。`
      + '它可能是蓝牙音频口或调试口——对着它操作既做不成，还会让人误以为设备有问题。'
    : `串口 ${port} 不在当前枚举列表里（可刷：${list}）：拒绝${verb}到一个未经验证的目标`;
  return { ok: false, error, ports: portRes.flashable, excludedPorts: excluded };
}

/**
 * 固件校验。返回 `{ ok, errors, warnings }` —— 不抛错，让上层一次把问题说全。
 * 注入 stat 便于单测（不必真造文件）。
 */
function checkFirmware(firmware, { stat = fs.statSync } = {}) {
  const errors = [];
  const warnings = [];
  const fw = String(firmware || '');
  if (!fw) return { ok: false, errors: ['缺少固件路径'], warnings };
  try {
    const st = stat(fw);
    if (!st.isFile()) errors.push(`固件路径不是文件：${fw}`);
    else if (st.size === 0) errors.push(`固件是空文件（0 字节）：${fw}`);
    else {
      const fmtRes = esptoolFormatCheck(fw);
      if (!fmtRes.ok) errors.push(fmtRes.error);
      else if (fmtRes.warning) warnings.push(fmtRes.warning);
    }
  } catch (e) {
    // 区分「不存在」与「没权限」：两者对用户下一步动作完全不同
    errors.push(e && e.code === 'ENOENT' ? `固件不存在：${fw}` : `固件不可读：${fw}（${String(e?.message || e).slice(0, 80)}）`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 枚举本机 USB 设备的 VID:PID（与 device_probe 共用同一份命令表与解析器）。
 * 存在的意义：`port` 是**字符串**，`/dev/cu.usbmodem1301` 可能明天指向另一块板子；
 * VID:PID 是**硬件身份**，能钉住「烧的确实是这块芯片」。两者一起用才敢说目标没错。
 */
async function readUsbIdentities({ exec, platform = process.platform } = {}) {
  const p = PROBES[platform];
  if (!p) return { items: [], note: `暂不支持的平台：${platform}` };
  try {
    const r = await exec(p.usb);
    const out = String(r?.stdout || '');
    const tree = platform === 'linux' ? parseLinuxUsb(out)
      : platform === 'win32' ? parseWinUsb(out) : JSON.parse(out || '{}');
    return { items: parseUsbTree(tree) };
  } catch (e) {
    // C-001：枚举失败不能与「没有这个 VID:PID」同形 —— 前者重插没用，后者插对就行
    return { items: [], note: `USB 身份枚举失败：${String(e?.message || e).slice(0, 120)}（不是「没这块板」）` };
  }
}

/**
 * 目标身份核对（fail-closed）。
 * 没给 expect_vid_pid 就跳过（不强制，只是少了这道保险）；给了就必须在**本次实时枚举**里出现，
 * 且写法非法直接拒绝——「我以为我写的是对的」比「没写」更危险。
 */
async function checkIdentity(expect, { exec, platform }) {
  const raw = String(expect || '').trim();
  if (!raw) return { ok: true, skipped: true };
  const want = parseVidPid(raw);
  if (!want) return { ok: false, error: `expect_vid_pid 写法不合法：\`${raw}\`（应为 \`1a86:7523\` 这种 VID:PID）` };
  const res = await readUsbIdentities({ exec, platform });
  if (res.note) return { ok: false, error: `${res.note}；无法核对 VID:PID=${want}，拒绝在身份未知的情况下动硬件` };
  const hit = res.items.find((d) => `${d.vid}:${d.pid}` === want);
  if (!hit) {
    const seen = res.items.map((d) => `${d.vid}:${d.pid}`).slice(0, 8).join(' / ') || '一个都没枚举到';
    return { ok: false, error: `没找到 VID:PID=${want} 的设备（当前枚举到：${seen}）：拒绝烧到一个身份不符的目标`, matched: null };
  }
  return { ok: true, matched: { name: hit.name, vid: hit.vid, pid: hit.pid, board: hit.board?.name || '' } };
}

/**
 * 多段固件校验：逐段查存在性/非空/扩展名，并带回 sizeBytes（容量校验要用）。
 * 一段有问题就整体不可烧——半套固件烧进去比不烧更糟。
 */
function inspectSegments(segments, { stat = fs.statSync } = {}) {
  const errors = [];
  const warnings = [];
  const ok = [];
  for (const [i, s] of (segments || []).entries()) {
    const label = `第 ${i + 1} 段（${s.offset}）`;
    try {
      const st = stat(s.file);
      if (!st.isFile()) errors.push(`${label}不是文件：${s.file}`);
      else if (st.size === 0) errors.push(`${label}是空文件（0 字节）：${s.file}`);
      else {
        ok.push({ ...s, sizeBytes: st.size });
        // 格式闸与通道分流**共用** deviceFlash.esptoolFormatCheck 这一份判据：
        // 两处各写一套是这类闸最典型的失效方式（一处改了另一处没改，测试只覆盖其中一处）。
        const fmtRes = esptoolFormatCheck(s.file);
        if (!fmtRes.ok) errors.push(`${label}${fmtRes.error}`);
        else if (fmtRes.warning) warnings.push(`${label}${fmtRes.warning}`);
      }
    } catch (e) {
      errors.push(e && e.code === 'ENOENT' ? `${label}固件不存在：${s.file}` : `${label}不可读：${s.file}（${String(e?.message || e).slice(0, 80)}）`);
    }
  }
  return { ok: errors.length === 0, segments: ok, errors, warnings };
}

function makeCard({ port, firmware, chip, offset, segCount = 1, flashSizeBytes = 0 }) {
  const isMulti = segCount > 1;
  return approvalCard({
    action: isMulti ? `烧写 ${segCount} 段固件到板子` : '烧写固件到板子',
    target: `${port} ← ${firmware}`,
    impact: isMulti
      ? `覆盖串口 ${port} 上设备的 ${segCount} 个地址区间（芯片 ${chip}${flashSizeBytes ? `，容量 ${(flashSizeBytes / 1024 ** 2).toFixed(0)}MB` : ''}）`
      : `覆盖串口 ${port} 上设备的 flash（芯片 ${chip}，偏移 ${offset}）`,
    consequence: '烧写中断或参数不符会导致板子无法启动（写错偏移/芯片最常见）',
    rollback: `按住 BOOT 键重新进下载模式后重刷（${port}）；原有固件已被覆盖，无自动回滚`,
    reversible: false,
  });
}

/** verify 档的卡：reversible=true（只读），但仍要求五要素齐全。 */
function makeVerifyCard({ port, firmware, chip, offset, segCount = 1, flashSizeBytes = 0 }) {
  const isMulti = segCount > 1;
  return approvalCard({
    action: isMulti ? `回读校验 ${segCount} 段固件` : '回读校验固件',
    target: `${port} ⇄ ${firmware}`,
    impact: `读串口 ${port} 上设备的 ${isMulti ? `${segCount} 个地址区间` : `flash（偏移 ${offset}）`}并与本地文件逐字节比对（芯片 ${chip}${flashSizeBytes ? `，容量 ${(flashSizeBytes / 1024 ** 2).toFixed(0)}MB` : ''}）`,
    consequence: '只读不写：校验不一致说明设备内容与本地文件不同（烧写没成功或被改过），不影响板子本身可用',
    rollback: `无需回滚（不写入任何内容）；要修正就重新走 plan → flash（${port}）`,
    reversible: true,
  });
}

/** backup 档的卡：必须写明「备份里有什么」，否则用户不知道自己正在把设备秘密存一份到磁盘。 */
function makeBackupCard({ port, out, chip, sizeBytes }) {
  return approvalCard({
    action: '整片备份设备 flash',
    target: `${port} → ${out}`,
    impact: `从串口 ${port} 上设备读出整片 ${(sizeBytes / 1024 ** 2).toFixed(2)}MB flash 写成 ${out}（芯片 ${chip}）`,
    consequence: '设备内容不受影响（只读）；但备份含设备全部数据（配网信息 / NVS 等），落到磁盘后等于把设备里的秘密存了一份',
    rollback: `删掉 ${out} 即可（不影响设备）；但它可能是唯一的回滚素材，删了就恢复不了原厂固件`,
    reversible: true,
  });
}

/** 默认执行器：argv 化 + 超时 + 输出上限。 */
function defaultRun(argv, timeoutMs = FLASH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: FLASH_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), signal: err && err.signal }));
  });
}

/**
 * 执行一次设备烧写动作。
 * @param {object} args
 * @param {'list_targets'|'plan'|'flash'} [args.action] 默认 list_targets（最安全的档）
 * @param {string} [args.port] 串口
 * @param {string} [args.firmware] 固件本地路径
 * @param {string} [args.chip] 芯片族
 * @param {string} [args.offset] 烧写偏移
 * @param {string} [args.plan_digest] plan 阶段返回的摘要（flash 必填）
 * @param {object} [deps] 注入 exec / run / platform / stat，便于单测
 */
async function deviceFlashHandler(args = {}, deps = {}) {
  const action = String(args.action || 'list_targets');
  const platform = deps.platform || process.platform;
  const exec = deps.exec || defaultExec;
  const port = String(args.port || '').trim();
  const firmware = String(args.firmware || '').trim();
  const chip = String(args.chip || 'esp32').toLowerCase();
  const offset = String(args.offset || '0x0');
  // 提前定义：backup 分支也要用；若留在下面会造成「先用后定义」的 TDZ 崩溃（不是 undefined）
  const tail = (s) => String(s || '').slice(-TAIL_CHARS);

  // ── L4：按镜像格式分流（2026-10-31）────────────────────────────────────────
  // 不靠调用方声明通道，靠**文件本身**决定：`.uf2` 是 512 字节块容器，esptool 的 write_flash
  // 只认裸二进制，硬写进去等于把容器字节灌进 flash（板子起不来，而 esptool 仍返回 0）。
  // 所以哪怕模型传了 port 也想走串口，只要固件是 .uf2 就改走 UF2 通道——选错通道不该能写坏设备。
  const fmt = resolveImageFormat(firmware);
  // 通道判据收敛到 deviceDfu.resolveFlashRoute 一处：`.bin` 是 esptool 与 DFU **共用**的裸二进制
  // （esptool 用 offset 参数、DFU 用 `-s addr`），光看扩展名判不出来 ⇒ 必须允许显式 channel。
  // 而 `.uf2` / `.dfu` 是容器，只有一条通道能收 ⇒ 扩展名优先于显式 channel（容器字节写错地方
  // 设备不会报错）。两条判据合在一个纯函数里，避免「扩展名分支」与「channel 分支」各写一套后漂移。
  const route = resolveFlashRoute({ channel: args.channel, fmt, port });
  if (route.error) return { ok: false, action, error: route.error };
  const routeWarnings = route.warnings;
  if (route.channel === 'uf2-copy' && (action === 'plan' || action === 'flash')) {
    return uf2ChannelHandler({ ...args, action }, deps);
  }
  if (route.channel === 'uf2-copy' && (action === 'verify' || action === 'backup')) {
    return {
      ok: false, action, channel: 'uf2-copy',
      error: `UF2 通道不支持 ${action}：bootloader 盘只写不读，没有回读校验也没有整片备份。`
        + '要留回滚素材，请在设备处于串口下载模式时用 action=backup（esptool 通道）。',
    };
  }
  if (route.channel === 'dfu-util') {
    if (action !== 'plan' && action !== 'flash') {
      return {
        ok: false, action, channel: 'dfu-util',
        error: `DFU 通道不支持 ${action}：它只接 plan / flash。DFU 设备枚举成 0483:df11，`
          + '没有串口节点，所以 chip_id / logs / verify / backup 都不适用——'
          + '这些动作要等板子进串口下载模式（esptool 通道）。这次没有对设备做任何操作。',
      };
    }
    const r = await dfuChannelHandler({ ...args, action }, deps);
    return { ...r, warnings: [...routeWarnings, ...(r.warnings || [])] };
  }
  // 已知的「不能走串口」格式（.hex 文本 / .img 整盘镜像）在**解析工具之前**就拒。
  // 放在后面的话，机器上没装 esptool 时用户看到的是「没找到 esptool」——而他手里的文件
  // 本来就不该走这条路，先装工具等于白装一次。错误信息要指向真正的下一步。
  // 注意 .hex 的 channel 是 null（没有任何通道支持它），不是 'disk'——判据要用「不是这两条通道」，
  // 而不是「channel 非空」：后者会把 .hex 漏过去。
  if (fmt.known && fmt.channel !== 'esptool-serial' && fmt.channel !== 'uf2-copy' && fmt.channel !== 'dfu-util'
      && (action === 'plan' || action === 'flash')) {
    return { ok: false, action, error: `格式与通道不匹配：${fmt.why}（${firmware}）` };
  }

  if (action === 'list_targets') {
    const diskRes = await listDisks({ exec, platform });
    const { candidates, rejected } = partitionCandidates(diskRes.disks);
    const portRes = await readPorts({ exec, platform });
    // UF2 bootloader 盘也一并列出：它是「整盘」之外的另一种可写目标，
    // 不列出来用户就只能靠猜卷名（而卷名可以改，INFO_UF2.TXT 才是判据）。
    const volumes = readVolumes({ platform });
    const uf2Volumes = volumes.filter((v) => isUf2Volume(v)).map((v) => v.path);
    const notes = [...diskRes.notes, ...(portRes.note ? [portRes.note] : [])];
    if (!candidates.length) notes.push('没有可烧的物理盘：合成容器与磁盘映像已按虚拟盘排除；要烧 SD 卡请插入后重试。');
    if (!portRes.flashable.length) notes.push('没发现可刷机的串口：检查数据线（不是充电线）、是否装了 CH34x 驱动，再跑一次 device_probe。');
    if (portRes.flashable.length) {
      notes.push(`烧固件下一步：action=plan，port 从 ${portRes.flashable.join(' / ')} 里选一个。`);
      // 明确列出被排除的口，否则用户会以为枚举坏了（"我明明看到 cu.xxx 在系统里"）
      const why = portRes.serial.map((s) => `${s.port}（${s.chip}${s.driver === 'builtin' ? '，免驱' : '，需厂商驱动'}）`);
      if (why.length) notes.push(`可刷机串口判据：${why.join(' / ')}。`);
    }
    if (uf2Volumes.length) {
      notes.push(`发现 UF2 bootloader 盘：${uf2Volumes.join(' / ')}——烧 .uf2 用 action=plan + volume 指定它（不需要串口）。`);
    }
    return {
      ok: true, action, platform,
      disks: { candidates, rejected },
      ports: portRes.flashable,
      uf2Volumes,
      // excludedPorts 不是「噪音」而是证据：审批与排查都要能看出「系统里有口，但不是板子」
      excludedPorts: portRes.all.filter((p) => !portRes.flashable.includes(p)),
      notes,
    };
  }

  // ── chip_id：跟芯片对一次话，把「桥芯片后面是什么」查清（L4b，2026-10-31）─────
  // device_probe 的 probe-required 结论只能说到「可能是任意 MCU」。跨过这一步唯一的办法
  // 是真的跟芯片同步一次（esptool 的 ROM 握手），而不是继续看 VID 猜。
  // 只读：读芯片型号 / MAC / flash 容量，**不写任何字节**。唯一的副作用是把 MCU 复位进
  // 下载模式（这也是 esptool 唯一能读到 ROM 的方式），因此不进审批面——与 device_probe 同档。
  if (action === 'chip_id') {
    if (!port) return { ok: false, action, error: '缺少 port：握手必须指定一个串口（取自 device_probe 的 ports）' };
    const portRes = await readPorts({ exec, platform });
    // 与 flash/verify 共用同一道硬闸，只换文案。判据分化是这类闸最典型的失效方式：
    // 一处改了另一处没改，而测试只覆盖其中一处时全绿。
    const gate = portGate(port, portRes, '探测');
    if (gate) return { ...gate, action };
    const tool = await resolveTool({ exec, platform });
    if (!tool) return { ok: false, action, error: NO_TOOL_ERROR };
    const subs = await resolveSubcommands(tool, { exec, platform });
    // `--chip auto` 是这一步的全部意义：由芯片自己报身份，而不是我们猜一个型号去对话。
    // 写死型号时 esp32 会去连 ESP32-S3 也报错退出，得到的结论是「连不上」而不是「它是 S3」。
    // 波特率固定 115200：握手阶段只有一个目标「对上话」，高速率是同步成功之后才谈的事。
    const argv = [
      tool, '--chip', 'auto', '--port', port,
      '--baud', '115200', '--before', sepFor(subs.style)('default_reset'), subs.id,
    ];
    const run = deps.run || defaultRun;
    const r = await run(argv, HANDSHAKE_TIMEOUT_MS);
    const hs = parseHandshake(`${r.stdout || ''}\n${r.stderr || ''}`, { exitCode: r.code });
    const res = {
      ok: hs.verdict === HANDSHAKE_VERDICTS.esp,
      action, port, argv,
      verdict: hs.verdict,
      // confidence 只描述「身份是否确定」，不描述「能不能烧」——后者是 runnable/installed 的事。
      // esp-need-bootloader 也算 certain：esptool 认出了 boot mode，说明它确实是 ESP。
      confidence: hs.esp ? 'certain' : 'unknown',
      channel: hs.esp ? 'esptool-serial' : null,
      chip: hs.chip, chipKey: hs.chipKey, mac: hs.mac, flashSizeBytes: hs.flashSizeBytes,
      exitCode: r.code, stderr: tail(r.stderr),
    };
    const keyHint = hs.chipKey
      ? `chip=${hs.chipKey}`
      : '该型号未登记在 CHIP_ARGS：烧写会退回默认参数（波特率/复位时序），请先确认是否本版本支持';
    if (hs.verdict === HANDSHAKE_VERDICTS.esp) {
      return {
        ...res,
        next: `身份已确认：${hs.chip}${hs.flashSizeBytes ? `，flash ${(hs.flashSizeBytes / 1024 ** 2).toFixed(0)}MB` : ''}。`
          + `下一步 action=plan，port=${port}，${keyHint}。`,
        warnings: hs.chipKey ? [] : [keyHint],
      };
    }
    if (hs.verdict === HANDSHAKE_VERDICTS.needBoot) {
      return {
        ...res,
        error: `是 ESP 芯片（esptool 认出了 boot mode），但它没在下载模式，因此读不到 flash 容量。`
          + '请让板子进下载模式（按住 BOOT 再点 RST 或重新上电；有些板子没有自动复位电路，必须手动），然后重跑本动作。这次没有写入任何字节。',
      };
    }
    if (hs.verdict === HANDSHAKE_VERDICTS.port) {
      return {
        ...res,
        error: `串口 ${port} 打不开（被占用 / 无权限 / 已拔掉）：先 \`lsof ${port}\` 看谁占着，或换一根数据线。`
          + '**这与芯片身份无关**，不能据此认为它不是 ESP。',
      };
    }
    if (hs.verdict === HANDSHAKE_VERDICTS.noResponse) {
      return {
        ...res,
        error: '芯片没有响应。可能它根本不是 ESP（桥芯片后面常是 STM32 / AVR / 打印机芯片），'
          + '也可能是 ESP 但没进下载模式、自动复位电路没接、或供电不足。'
          + '**不能据此判定它不是 ESP**——若你确认这是 ESP 板，请手动进下载模式后重试；'
          + '若不是，改走同口的 stm32flash / avrdude 通道（见 device_probe 的 alternatives）。',
      };
    }
    return {
      ...res,
      error: '握手没能得出结论（esptool 输出里没有可识别的芯片身份行）：原始输出见 stderr。'
        + '常见原因是 esptool 版本行为变化，或板子进入了非预期的启动模式。',
    };
  }

  // ── logs：抓串口启动输出，回答「烧完到底跑起来了没有」（L5，2026-10-31）──────
  // 与 verify 的分工：verify 逐字节比对，证明「写对了」；logs 看启动链路，证明「能跑」。
  // 「烧录成功但不开机」是这条链上最难排查的一类，两个判据缺一不可。
  // 只读：不发任何写命令。但会**独占串口**并把板子复位（否则抓不到从 0 开始的启动日志），
  // 因此与 chip_id 同档（L1）——复位是对硬件状态的改变，不是纯读取。
  if (action === 'logs') {
    if (!port) return { ok: false, action, error: '缺少 port：抓日志必须指定一个串口（取自 device_probe 的 ports）' };
    const probe = PROBES[platform];
    if (!probe || !probe.serialDetailed) {
      return {
        ok: false, action,
        error: `暂不支持 ${platform} 的串口抓取（该平台尚未接线解释器探测）：`
          + '未在真机验证过的命令不写进来，请用系统自带串口工具确认启动。',
      };
    }
    const portRes = await readPorts({ exec, platform });
    const gate = portGate(port, portRes, '读取日志');
    if (gate) return { ...gate, action };
    // 解释器必须复用 device_probe 的同一套发现逻辑，不能写死 `python3`：
    // 本机实测 /usr/bin/python3 没有 pyserial，只有 anaconda 的解释器有。
    // 写死的结果是「抓日志永远说没装 pyserial」，而装不装取决于用户用哪个 python。
    let interp = '';
    try {
      interp = splitPyserialOutput(String((await exec(probe.serialDetailed))?.stdout || '')).interpreter || '';
    } catch {
      // 探测失败等价于「没有可用解释器」：下面统一报需要 pyserial（不是静默降级）
    }
    if (!interp) {
      return {
        ok: false, action, port,
        error: '没找到带 pyserial 的 python：抓日志需要 pyserial（pip install pyserial）。'
          + 'macOS 自带的 /usr/bin/python3 通常没有，装到 anaconda/homebrew 的解释器即可。',
      };
    }
    const secs = clampNum(args.seconds, 8, 2, 30);
    const baud = clampNum(args.baud, 115200, 1200, 2000000);
    // 脚本作为单个 argv 元素传入（不经 shell）：脚本里的引号/反引号都不是注入面。
    const argv = [interp, '-c', CAPTURE_SCRIPT, '--port', port, '--baud', String(baud), '--secs', String(secs)];
    const run = deps.run || defaultRun;
    const cap = parseCapture(`${(await run(argv, Math.round((secs + 8) * 1000))).stdout || ''}`);
    if (!cap.ok) {
      return {
        ok: false, action, port, argv, portError: Boolean(cap.portError), error: cap.error,
        // 端口打不开与「抓到了但没输出」是两件事：前者重试没用，后者要去看固件
        hint: cap.portError ? `先 lsof ${port} 看是不是被别的串口工具占着` : '检查解释器与 pyserial 安装',
      };
    }
    const an = analyzeLog({ buf: cap.buf, expect: expectTokens(args.expect) });
    const booted = an.verdict === VERDICTS.booted;
    const res = {
      ok: booted && an.expect.missing.length === 0,
      action, port, argv, seconds: secs, baud,
      verdict: an.verdict,
      bytes: an.bytes,
      signals: an.signals,
      expect: an.expect,
      // 复位前残留的字节数：它被排除在判据之外，但要报出来，否则「8 秒抓到 7KB」会让人
      // 以为全是本次启动的输出（真机首次实现就踩到：开头是上一份固件的尾流）。
      staleBytes: an.staleBytes,
      // 只作为证据：USB-CDC 口的波特率是建议值，改动不影响数据（真机实测），
      // 所以「比例高」不能推成「波特率不对」——只有真正的 UART 桥口才会因速率不匹配产生乱码。
      nonPrintableRatio: an.nonPrintableRatio,
      preview: previewOf(an.text),
    };
    const warnings = [];
    res.warnings = warnings;
    if (an.staleBytes > 0) {
      warnings.push(`抓到了复位前的残留输出 ${an.staleBytes} 字节（已排除在判据之外）：`
        + '打开端口时驱动缓冲里还压着上一份固件的输出。判据只认最后一次启动横幅之后的内容，'
        + '否则旧日志能冒充本次启动、把 expect 蒙混过去');
    }
    if (an.nonPrintableRatio > 0.15) {
      warnings.push(`输出里非可打印字符占 ${(an.nonPrintableRatio * 100).toFixed(0)}%：`
        + '若是 UART 桥口（ch34x/cp210x/ftdi）优先怀疑波特率；若是原生 USB 口（usbmodem）'
        + '波特率一般不影响，更可能是设备在输出二进制协议');
    }
    if (an.verdict === VERDICTS.download) {
      return {
        ...res,
        error: '板子停在**下载模式**，没有跑 app（输出里有下载模式标记）。'
          + '烧完仍停在这里，通常意味着它没被正常复位、或 BOOTSEL/BOOT 引脚被按住/接错。'
          + '先松开按键再上电复位后重抓；这时的 flash 内容对不对要另用 verify 判断。',
      };
    }
    if (an.verdict === VERDICTS.noOutput) {
      return {
        ...res,
        error: `${secs} 秒内没有任何串口输出：没有启动证据。可能是固件没启用日志、日志走了别的口，`
          + '或者板子根本没启动。注意：原生 USB 口改波特率不影响数据，所以「波特率不对」通常不是原因。',
      };
    }
    if (an.verdict === VERDICTS.unknown) {
      return {
        ...res,
        error: `有 ${an.bytes} 字节输出，但没识别到启动证据（ROM banner / entry / IDF 日志行）：`
          + '看 preview 里的原文判断它是自研格式日志还是别的东西。',
      };
    }
    if (an.expect.missing.length) {
      return {
        ...res,
        error: `启动证据齐了（${[
          an.signals.rom ? 'ROM' : '', an.signals.entry ? 'entry' : '', an.signals.idfLog ? 'IDF 日志' : '',
        ].filter(Boolean).join(' / ')}），但期望的特征串没出现：${an.expect.missing.join(' | ')}`
          + '——固件跑起来了，但不是你预期的那个固件/分支，或者这几行打在更后面（可加大 seconds）。',
      };
    }
    return {
      ...res,
      next: '启动证据齐了：烧进去的固件确实在跑。'
        + (an.expect.checked ? `期望的 ${an.expect.checked} 个特征串全部命中。` : '如需更严格的判据，可用 expect 指定特征串。'),
    };
  }

  if (action === 'plan') {
    const segsIn = normalizeSegments({ firmware, offset, segments: args.segments });
    const tool = await resolveTool({ exec, platform });
    if (!tool) return { ok: false, action, error: NO_TOOL_ERROR };
    const subs = await resolveSubcommands(tool, { exec, platform });
    const built = buildFlashPlan({ port, segments: segsIn, chip, tool, command: subs.write, subStyle: subs.style });
    if (!built.ok) return { ok: false, action, error: built.error };
    const segs = inspectSegments(built.segments, deps);
    if (!segs.ok) return { ok: false, action, error: segs.errors.join('；'), warnings: built.warnings };
    const warnings = [...built.warnings, ...segs.warnings];
    // 段间重叠是纯逻辑冲突（不需要设备在场）：重叠 = 后一段盖掉前一段，必然写坏。
    // 越界要等 flash 阶段实测容量才能判，这里只查重叠。
    const fit = checkSegmentsFit(segs.segments, 0);
    if (fit.overlaps.length) {
      const o = fit.overlaps[0];
      return {
        ok: false, action,
        error: `段与段重叠：${o.later}（${o.laterOffset}）会盖掉 ${o.earlier} 的尾部（止于 0x${o.earlierEnd.toString(16)}），请检查偏移`,
      };
    }
    // 串口白名单在 plan 阶段只**告警**（不拒绝）：板子可能确实还没插，用户仍想先看到将要执行的命令。
    // 但判据必须是「枚举出了别的口，却没有这个口」——ports 为空时「不在列表」恒真，会变成误报。
    const portRes = await readPorts({ exec, platform });
    if (port && portRes.flashable.length && !portRes.flashable.includes(port)) {
      const isReal = portRes.all.includes(port);
      warnings.push(isReal
        ? `串口 ${port} 在系统里存在，但不是可刷机串口（${portRes.flashable.join(' / ')} 才是）：flash 会被拒绝，它可能是蓝牙/调试口`
        : `串口 ${port} 不在当前枚举列表里（现有：${portRes.flashable.join(' / ') || '一个都没有'}）：flash 会被拒绝，请先确认设备名`);
    }
    // expect_vid_pid 在 plan 阶段只做「写法校验 + 在场告警」，不拒绝：
    //   写法错要**立刻**说——等到 flash 才报，等于让用户先点一次审批卡再看自己的错字；
    //   不在场只告警——板子可能确实还没插，用户仍想先看到将要执行的命令。
    const rawId = String(args.expect_vid_pid || '').trim();
    const wantId = parseVidPid(rawId);
    if (rawId && !wantId) {
      return { ok: false, action, error: `expect_vid_pid 写法不合法：\`${rawId}\`（应为 \`1a86:7523\` 这种 VID:PID）` };
    }
    if (wantId) {
      const ids = await readUsbIdentities({ exec, platform });
      if (ids.note) warnings.push(`${ids.note}：无法确认 VID:PID=${wantId} 是否在场`);
      else if (!ids.items.some((d) => `${d.vid}:${d.pid}` === wantId)) {
        warnings.push(`当前枚举里没有 VID:PID=${wantId}：flash 会被拒绝，请先确认插的是哪块板`);
      }
    }
    const digest = planDigest({ port, firmware, chip, offset, argv: built.argv, segments: built.segments });
    const isMulti = segs.segments.length > 1;
    const fileLabel = isMulti ? `${segs.segments.length} 段（${segs.segments.map((s) => s.file.split('/').pop()).join(' + ')}）` : firmware;
    return {
      ok: true,
      action,
      argv: built.argv,
      plan_digest: digest,
      segments: segs.segments.map((s) => ({ offset: s.offset, file: s.file, sizeBytes: s.sizeBytes })),
      warnings,
      card: makeCard({ port, firmware: fileLabel, chip, offset, segCount: segs.segments.length }),
      next: `请把上述 argv 给你的人类看；他确认后调用 action=flash 并回传 plan_digest="${digest}"。`
        + 'flash 会先实测 flash 容量并校验每段不越界，再写入。'
        + `烧完建议用同一个 plan_digest 调 action=verify 回读校验（参数一致，无需再 plan）；`
        + '若要留回滚素材，先调 action=backup（需 out 路径）再 flash。',
    };
  }

  // ── backup：整片备份，不写设备，但**写磁盘**（且写的是设备全部数据）────────────
  if (action === 'backup') {
    const out = String(args.out || '').trim();
    if (!out) {
      return { ok: false, action, error: '缺少 out：整片备份必须指定落盘文件（否则读出来没地方放）' };
    }
    const stat = deps.stat || fs.statSync;
    // 不覆盖已有文件：备份的唯一用途是回滚，把已有的一副本静态覆盖掉＝把回滚手段毁掉
    try {
      stat(out);
      return { ok: false, action, error: `备份目标已存在：${out}（不覆盖已有文件，请换一个文件名）` };
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) {
        return { ok: false, action, error: `备份路径不可用：${out}（${String(e?.message || e).slice(0, 80)}）` };
      }
    }
    const portRes = await readPorts({ exec, platform });
    const gate = portGate(port, portRes, '读取');
    if (gate) return { ...gate, action };
    const tool = await resolveTool({ exec, platform });
    if (!tool) return { ok: false, action, error: NO_TOOL_ERROR };
    const subs = await resolveSubcommands(tool, { exec, platform });
    const idRes = await checkIdentity(args.expect_vid_pid, { exec, platform });
    if (!idRes.ok) return { ok: false, action, error: idRes.error };

    const run = deps.run || defaultRun;
    // 长度优先用显式 size，否则实测 —— 绝不猜默认值（读少了要到恢复时才发现）
    let sizeBytes = parseSize(args.size);
    let precheck = { ok: true, chip: '', flashSizeBytes: sizeBytes, source: sizeBytes ? 'args.size' : '' };
    if (!sizeBytes) {
      // 注意：这里必须用 CHIP_ARGS 而不能复用后面 flash 分支的 `built`——
      // 那个变量在本函数里后置声明，提前引用是 TDZ 崩溃（不是 undefined），
      // 而且崩在备份这种「救命」路径上最难排查。
      const ca = CHIP_ARGS[chip] || {};
      const pre = await run([
        tool, '--chip', chip, '--port', port,
        '--baud', String(ca.baud || 460800), '--before', sepFor(subs.style)(ca.before || 'default_reset'), subs.id,
      ]);
      const info = parseFlashIdInfo(`${pre.stdout || ''}\n${pre.stderr || ''}`);
      if (pre.code !== 0) {
        return { ok: false, action, error: `容量预检失败（flash_id 退出码 ${pre.code}）：没进 bootloader / 串口被占用 / 供电或数据线问题。未读取任何内容。`, stderr: tail(pre.stderr) };
      }
      if (!info.flashSizeBytes) {
        return { ok: false, action, error: '容量预检没能解析出 flash 大小：拒绝在未知长度下备份（读一半的备份比没备份更危险）。可显式传 size，如 "4MB"。', raw: tail(pre.stdout) };
      }
      sizeBytes = info.flashSizeBytes;
      precheck = { ok: true, chip: info.chip, flashSizeBytes: sizeBytes, source: 'flash_id' };
    }
    const bp = buildBackupPlan({ port, chip, sizeBytes, out, tool, readCommand: subs.read, subStyle: subs.style });
    if (!bp.ok) return { ok: false, action, error: bp.error };
    const r = await run(bp.argv);
    // 落地校验：文件必须在、且大小等于读到的长度 —— 少了就是半份备份，必须报出来而不是报「成功」
    let bytes = 0;
    try { bytes = stat(out).size; } catch { /* 下面按 bytes=0 处理，等价于「没落地」 */ }
    const complete = r.code === 0 && bytes === sizeBytes;
    return {
      ok: complete,
      action,
      argv: bp.argv,
      out,
      sizeBytes,
      bytes,
      precheck,
      exitCode: r.code,
      stdout: tail(r.stdout),
      stderr: tail(r.stderr),
      warnings: bp.warnings,
      card: makeBackupCard({ port, out, chip, sizeBytes }),
      error: complete ? undefined : (r.code !== 0
        ? `备份命令失败（exit=${r.code}）：看 stderr；串口被占用/驱动缺失最常见。`
        : `备份文件不完整：期望 ${sizeBytes} 字节，实际 ${bytes} 字节 —— 这份备份不能用于恢复，请重跑。`),
    };
  }

  if (action !== 'flash' && action !== 'verify') {
    return { ok: false, action, error: `未知 action：${action}（只支持 list_targets / chip_id / plan / flash / verify / backup / logs）` };
  }

  // ── flash / verify：共用同一条前置门，差别只在最后那条子命令 ──────────────────
  // 为什么共用：两者的参数面完全一致（端口/芯片/段/波特率），分成两套校验必然漂移，
  // 而「能烧却不能校验」这种裂缝不会有测试去覆盖。digest 也统一按 write_flash 的 argv 算，
  // 所以 plan 拿到的 digest 在 flash 和 verify 上都成立 —— 一次确认，两处可用。
  if (!args.plan_digest) {
    return { ok: false, action, error: '缺少 plan_digest：必须先调用 action=plan，把人确认过的摘要一起带回来（防参数在确认后被改）' };
  }
  const segsIn = normalizeSegments({ firmware, offset, segments: args.segments });
  const tool = await resolveTool({ exec, platform });
  if (!tool) return { ok: false, action, error: NO_TOOL_ERROR };
  const subs = await resolveSubcommands(tool, { exec, platform });
  const built = buildFlashPlan({ port, segments: segsIn, chip, tool, command: subs.write, subStyle: subs.style });
  if (!built.ok) return { ok: false, action, error: built.error };
  const current = planDigest({ port, firmware, chip, offset, argv: built.argv, segments: built.segments });
  if (current !== String(args.plan_digest)) {
    return { ok: false, action, error: `plan_digest 不匹配（当前参数算出 ${current}）：参数在确认后变过，请重新 plan 并让人类再看一眼` };
  }
  const segs = inspectSegments(built.segments, deps);
  if (!segs.ok) return { ok: false, action, error: segs.errors.join('；') };
  const portRes = await readPorts({ exec, platform });
  const portGateRes = portGate(port, portRes, action === 'verify' ? '校验' : '写入');
  if (portGateRes) return { ...portGateRes, action };

  const idRes = await checkIdentity(args.expect_vid_pid, { exec, platform });
  if (!idRes.ok) return { ok: false, action, error: idRes.error };

  // ── 容量预检（fail-closed）──────────────────────────────────────────────────
  // 为什么必须先跑：分区偏移写超出实际 flash 容量时，esptool 会"烧到一半成功"，
  // 表现为「烧录成功但不开机」——这是最难排查的一类故障（文档 §9 单列了这一行）。
  // 代价：flash_id 会把芯片复位进 bootloader（有副作用但不是破坏），所以只在执行档做，
  // plan 档保持纯计算。verify 也跑：它同时给出「这块板到底多大」的证据，让校验结论可解释。
  const verb = action === 'verify' ? '校验' : '写入';
  const run = deps.run || defaultRun;
  const preArgv = [
    tool, '--chip', chip, '--port', port,
    '--baud', String(built.params.baud), '--before', built.params.before, subs.id,
  ];
  const pre = await run(preArgv);
  const info = parseFlashIdInfo(`${pre.stdout || ''}\n${pre.stderr || ''}`);
  if (pre.code !== 0) {
    return {
      ok: false, action, precheck: { ok: false, exitCode: pre.code },
      error: `容量预检失败（flash_id 退出码 ${pre.code}）：常见原因是没进 bootloader、串口被占用（lsof ${port}）或供电/数据线问题。未${verb}任何内容。`,
      stderr: tail(pre.stderr),
    };
  }
  if (!info.flashSizeBytes) {
    return {
      ok: false, action, precheck: { ok: false, chip: info.chip, flashSizeBytes: 0 },
      error: `容量预检没能解析出 flash 大小（esptool 输出格式可能变了）：拒绝在未知容量下${verb}。`,
      raw: tail(pre.stdout),
    };
  }
  const fit = checkSegmentsFit(segs.segments, info.flashSizeBytes);
  if (!fit.ok) {
    const mb = (n) => `${(n / 1024 ** 2).toFixed(1)}MB`;
    const why = fit.overflows.length
      ? fit.overflows.map((o) => `${o.file}（${o.offset} + ${mb(o.end - parseOffsetSafe(o.offset))}）止于 ${mb(o.end)}，超出实测容量 ${mb(o.flash)}`).join('；')
      : `段与段重叠：${fit.overlaps.map((o) => `${o.later} 盖到 ${o.earlier}`).join('；')}`;
    return {
      ok: false, action, precheck: { ok: true, chip: info.chip, flashSizeBytes: info.flashSizeBytes },
      error: `容量校验不通过：${why}。未${verb}任何内容。`,
    };
  }

  const isVerify = action === 'verify';
  // 执行用的 argv：verify 走同参数装配出的 verify_flash，flash 用 plan 阶段那个 write_flash。
  // 两个 argv 由同一份 params 推导，所以 digest 只用 write_flash 那份算一次就够。
  const execPlan = isVerify ? buildFlashPlan({ port, segments: segsIn, chip, command: subs.verify, tool, subStyle: subs.style }) : built;
  if (!execPlan.ok) return { ok: false, action, error: execPlan.error };
  const label = segs.segments.length > 1 ? `${segs.segments.length} 段` : firmware;
  const card = isVerify
    ? makeVerifyCard({ port, firmware: label, chip, offset, segCount: segs.segments.length, flashSizeBytes: info.flashSizeBytes })
    : makeCard({ port, firmware: label, chip, offset, segCount: segs.segments.length, flashSizeBytes: info.flashSizeBytes });
  const r = await run(execPlan.argv);
  return {
    ok: r.code === 0,
    action,
    argv: execPlan.argv,
    segments: segs.segments.map((s) => ({ offset: s.offset, file: s.file, sizeBytes: s.sizeBytes })),
    precheck: { ok: true, chip: info.chip, flashSizeBytes: info.flashSizeBytes },
    identity: idRes.skipped ? null : idRes.matched,
    exitCode: r.code,
    signal: r.signal || null,
    stdout: tail(r.stdout),
    stderr: tail(r.stderr),
    warnings: [...execPlan.warnings, ...segs.warnings],
    card,
    // 失败时下一步要可执行：esptool 的失败原因集中在 stderr，但「怎么办」不该让用户自己猜
    hint: r.code === 0
      ? (isVerify ? '回读校验通过：设备上这几段的内容与本地文件逐字节一致。' : null)
      : `${isVerify ? '校验' : '烧写'}失败（exit=${r.code}）：先按上面 stderr 定位；串口被占用/驱动缺失最常见，可先跑 device_probe 复查。`,
  };
}

/** 越界文案里算「本段有多大」用：偏移已知，直接相减。 */
function parseOffsetSafe(text) {
  const m = /^(?:0x)?([0-9a-f]+)$/i.exec(String(text || '').trim());
  return m ? parseInt(m[1], 16) : 0;
}

/**
 * 数值参数收敛到区间内（缺省/非法一律回落 default）。
 * 为什么要夹：`seconds` 是模型可控输入，不夹的话 `seconds=3600` 会把一次工具调用挂成
 * 一小时（看门狗超时后还要等子进程），`seconds=0` 则永远抓不到启动日志——两头都是坏结果，
 * 而两头的表象完全不同，靠看日志很难看出是参数问题。
 */
function clampNum(raw, dflt, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 宿主侧入口：真实 exec + 真实 child_process（main/scheduledTools.js 的 deviceFlash 通道调它）。 */
function flashDevice(args) {
  return deviceFlashHandler(args, {});
}

module.exports = {
  deviceFlashHandler, flashDevice, checkFirmware, inspectSegments, readPorts, readUsbIdentities, checkIdentity,
  makeCard, makeVerifyCard, makeBackupCard, defaultRun, resetSubcommandCacheForTest,
};
