// USB DFU 通道的纯逻辑（2026-10-31）：解析 `dfu-util -l`、挑目标、装配命令、生成摘要与审批卡。
//
// 为什么单独成纯函数模块：DFU 的两个致命错误都不能靠「跑一遍看看」发现——
//   ① 挑错目标/挑错 alt setting：同一块板子枚举出多个 alt（Internal Flash / Option Bytes），
//      写进 Option Bytes 会直接把板子锁死；
//   ② 加载地址猜错：`-s 0x0` 对 STM32 是写到地址 0，而主 flash 在 0x08000000。
//      设备不会报错（DFU 只按你给的地址写），表现是「烧完了但板子跑的是旧的/根本不启动」。
// 所以地址必须显式给、目标必须唯一、alt 必须能认出是主 flash —— 三条都不满足就拒绝，
// 不做「合理默认」。这与 deviceProbe 的「解析不出就拒绝而不是猜」是同一条纪律。
//
// 边界：本模块**不执行**任何命令（不 require child_process），只产出「要执行什么 + 卡上写什么」。

const crypto = require('crypto');
const { approvalCard, parseOffset } = require('./deviceFlash');
// 通道别名表跟着通道自己的模块走（fastboot 的在 deviceFastboot.js）。这里只 import 数据，
// 不 import 执行器 —— 路由函数必须保持纯函数，能被单测直接调用。
const { FASTBOOT_CHANNEL_ALIASES } = require('./deviceFastboot');

// dfu-util 接受的输入：裸二进制（STM32 最常见）与带后缀的 .dfu 容器。
// 刻意不接受 .hex / .uf2 / .img：写进去的是容器/文本字节，设备照单全收但固件是废的
// ——这是「工具链不替你说」的那一类错误，必须在这里拦。
const DFU_ALLOWED_EXT = ['.bin', '.dfu'];

// dfu-util 的 `-l` 输出（v0.9–0.11 真机形状）：
//   Found DFU: [0483:df11] ver=2200, devnum=3, cfg=1, intf=0, path="20-1", alt=0,
//     name="@Internal Flash  /0x08000000/040*001Ka,004*001Kg", serial="FFFFFFFEFFFF"
// 一块板子的每个 alt setting 各占一行，除 alt/name 外其余字段相同。
const FOUND_RE = /Found DFU:\s*\[([0-9a-f]{4}):([0-9a-f]{4})\]/i;
// 「一个都没插」与「命令根本没跑成」必须分开：dfu-util 找不到设备时退出码是 74(EX_IOERR)，
// 只看退出码会把「没插设备」当成「工具坏了」，用户会去重装 dfu-util。
const NO_DEVICE_RE = /no dfu capable usb device|no device available/i;
// 主 flash 的 alt 名。ST 的写法是 "@Internal Flash  /0x08000000/...", 其它实现多为 "@Flash"。
const FLASH_ALT_RE = /internal\s*flash|^\s*@?\s*flash\b/i;

/**
 * 解析 `dfu-util -l` 的输出。
 * @param {string} stdout
 * @returns {{ok: boolean, targets?: Array, error?: string, note?: string}}
 *   targets 按「物理设备」去重（vid:pid + serial + path 相同即同一块板），alts 内联。
 */
function parseDfuList(stdout) {
  const text = String(stdout ?? '');
  const byDevice = new Map();
  let lines = 0;
  for (const line of text.split('\n')) {
    const head = FOUND_RE.exec(line);
    if (!head) continue;
    lines += 1;
    const vid = head[1].toLowerCase();
    const pid = head[2].toLowerCase();
    const altM = /,\s*alt=(\d+)/.exec(line);
    const nameM = /name="([^"]*)"/.exec(line);
    const serialM = /serial="([^"]*)"/.exec(line);
    const pathM = /path="([^"]*)"/.exec(line);
    const serial = serialM ? serialM[1] : '';
    const path = pathM ? pathM[1] : '';
    const key = `${vid}:${pid}|${serial}|${path}`;
    if (!byDevice.has(key)) byDevice.set(key, { vid, pid, serial, path, alts: [] });
    byDevice.get(key).alts.push({ alt: altM ? Number(altM[1]) : 0, name: nameM ? nameM[1].trim() : '' });
  }
  if (!lines) {
    if (NO_DEVICE_RE.test(text)) return { ok: true, targets: [], note: 'no-device' };
    return {
      ok: false, targets: [],
      error: 'dfu-util 输出不可识别：既没有 Found DFU 行、也没有 "No DFU capable USB device" 提示，'
        + '无法区分「没插设备」与「命令没跑成」（后者要去看 dfu-util 是否可执行、USB 权限是否正常）',
    };
  }
  return { ok: true, targets: [...byDevice.values()] };
}

const describeTarget = (t) => `${t.vid}:${t.pid}${t.serial ? ` serial=${t.serial}` : ''}${t.path ? ` path=${t.path}` : ''}`;

/**
 * 从解析结果里挑出唯一的 DFU 设备。
 * 多块时**拒绝而不是挑第一块**：烧错板子的代价是不可逆的，而「挑第一块」在
 * 两块板插在同一 hub 上时完全不稳定（枚举顺序随插入顺序变）。
 */
function pickTarget(targets) {
  const list = Array.isArray(targets) ? targets : [];
  if (!list.length) {
    return {
      ok: false,
      error: '没有处于 DFU 模式的设备：先让板子进 DFU（STM32 是 BOOT0 拉高后复位，USB 上枚举成 0483:df11），'
        + '再重跑一次。若板子已经写着固件在跑，DFU 只在进入 bootloader 时才存在。',
    };
  }
  if (list.length > 1) {
    return {
      ok: false,
      error: `同时发现 ${list.length} 个 DFU 设备：请只接一块再烧。`
        + `（${list.map(describeTarget).join(' / ')}）`,
    };
  }
  return { ok: true, target: list[0] };
}

/**
 * 挑 alt setting：只认名字像主 flash 的那个。
 * 为什么不能默认 alt=0：STM32 的 alt=1 常常是 Option Bytes（读写保护位就在那里），
 * 写进去不是「固件没生效」，而是板子被锁成不可读/不可写。宁可拒绝也不猜。
 */
function pickAlt(target) {
  const alts = Array.isArray(target?.alts) ? target.alts : [];
  if (!alts.length) return { ok: false, error: '该 DFU 设备没有 alt setting：dfu-util 输出异常，拒绝写入' };
  const flash = alts.filter((a) => FLASH_ALT_RE.test(a.name || ''));
  if (flash.length === 1) return { ok: true, alt: flash[0].alt, name: flash[0].name, candidates: alts };
  if (!flash.length && alts.length === 1) {
    // 只有一个 alt 且名字不含 flash 字样：没有歧义可犯，取它（有些板子的 alt 名就叫 "@DFU"）
    return { ok: true, alt: alts[0].alt, name: alts[0].name, candidates: alts };
  }
  return {
    ok: false,
    error: `无法确定哪个 alt setting 是主 flash（认出 ${flash.length} 个候选人，共 ${alts.length} 个）：`
      + `${alts.map((a) => `alt=${a.alt} ${a.name || '(无名)'}`).join(' / ')}。`
      + '写错 alt 可能落在 Option Bytes 上把板子锁住，故拒绝。',
    candidates: alts,
  };
}

/** 十六进制地址归一化（`0x08000000` / `8000000` / `0x8000000` 都认）。非法返回 ''。 */
function normalizeAddr(text) {
  const n = parseOffset(text);
  if (!Number.isFinite(n) || n < 0) return '';
  // 补足 8 位：0x08000000 与 0x8000000 是同一个地址，但前者是器件手册和用户输入的写法。
  // 归一化是为了让「用户看到的」与「实际执行的」逐字一致（digest 也压在归一化后的值上）。
  const hex = n.toString(16);
  return `0x${hex.length <= 8 ? hex.padStart(8, '0') : hex}`;
}

/**
 * 计划摘要：把「人确认过的参数」压成一个短串。
 * 与 esptool / uf2 两条通道各算各的（不共用）：参数集不同，混用会让「换了通道」也能复用旧摘要。
 */
function dfuPlanDigest({ vid = '', pid = '', alt = 0, addr = '', firmware = '', fileSize = 0 } = {}) {
  const payload = JSON.stringify([
    'dfu-util', String(vid), String(pid), Number(alt), String(addr), String(firmware), Number(fileSize) || 0,
  ]);
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/**
 * 本次动作对应的 argv。flash 与 verify 只差尾部参数，集中在这里装配：
 *   flash  → `-s <addr>:leave -D <firmware>`（:leave = 写完后设备退出 DFU 并运行新固件）
 *   verify → `-s <addr> -U <out>`（把设备内容上传回本地再逐字节比对）
 * 为什么 `:leave` 必须有：没有它，「成功」只代表字写进去了，设备还停在 bootloader 里
 * 不跑新固件 —— 而 dfu-util 照样返回 0，用户看到的是「烧成功了但板子不动」。
 */
function buildDfuArgv({ vid, pid, alt, spec, firmware = '', action = 'flash', uploadTo = '' }) {
  const head = ['dfu-util', '-d', `${vid}:${pid}`, '-a', String(alt), '-s', String(spec)];
  if (action === 'verify') return [...head, '-U', String(uploadTo)];
  return [...head, '-D', String(firmware)];
}

/**
 * 装配 DFU 烧写计划（不执行）。
 * @returns {{ok:boolean, error?:string, digest?:string, argv?:string[], card?:object, warnings:string[], next?:string}}
 */
function buildDfuPlan({ target, alt, altName = '', addr = '', firmware = '', fileSize = 0, card = null } = {}) {
  const warnings = [];
  if (!target || !target.vid || !target.pid) return { ok: false, error: '缺少 DFU 目标设备（vid:pid）', warnings };
  if (!firmware) return { ok: false, error: '缺少固件路径', warnings };
  const ext = (/\.([A-Za-z0-9]+)$/.exec(firmware) || [])[0] || '';
  if (!DFU_ALLOWED_EXT.includes(ext.toLowerCase())) {
    return {
      ok: false, warnings,
      error: `DFU 通道只接受 ${DFU_ALLOWED_EXT.join(' / ')}：${firmware} 是 ${ext || '（无扩展名）'}。`
        + '.hex 要先 objcopy 成 .bin，.uf2 属于 UF2 通道（写进去的是容器字节，设备不报错但固件是废的）',
    };
  }
  if (!(Number(fileSize) > 0)) return { ok: false, error: '固件为空或大小未知：拒绝写入', warnings };
  const a = normalizeAddr(addr);
  if (!a) {
    return {
      ok: false, warnings,
      error: 'DFU 必须显式给 offset（加载地址）：它是器件相关的（STM32 主 flash 通常是 0x08000000），'
        + '猜一个就是写到别的区域——设备不会报错，表现是「烧完了但板子跑的还是旧的」。',
    };
  }
  if (a === '0x00000000') {
    // 允许，但必须说清风险：0x0 在 STM32 上不是主 flash，在别的实现里可能是别名。
    warnings.push('加载地址是 0x0：多数 STM32 的主 flash 在 0x08000000。确认这块板子的内存映射再继续。');
  }
  const digest = dfuPlanDigest({ vid: target.vid, pid: target.pid, alt, addr: a, firmware, fileSize });
  const argv = buildDfuArgv({ vid: target.vid, pid: target.pid, alt, spec: `${a}:leave`, firmware });
  const name = String(firmware).split(/[\\/]/).pop();
  return {
    ok: true,
    digest,
    argv,
    warnings,
    alt, altName, addr: a,
    // 复用 deviceFlash 的 approvalCard：那张卡有五要素必填与 reversible ⇒ level 推导，
    // 自己拼一份迟早少一个字段而没人发现（uf2 通道同款理由）。
    card: card || approvalCard({
      action: '把固件写入 DFU 设备的 flash',
      target: `${target.vid}:${target.pid}${altName ? ` (${altName.slice(0, 40)})` : ''} @${a} ← ${name}`,
      impact: `覆盖 ${a} 起的 ${(Number(fileSize) / 1024).toFixed(1)}KB（alt=${alt}）`,
      consequence: '写入中断电/拔线会让设备停在半写状态；DFU 通道**没有写前备份**，回滚只能靠再进 DFU 重写',
      rollback: '重新进 DFU（BOOT0 + 复位，枚举出 0483:df11）后，用同一份固件再写一次',
      reversible: false,
    }),
    next: `请把目标（${target.vid}:${target.pid} alt=${alt} @${a}）与文件给人类确认；`
      + `确认后调用 action=flash 并回传 plan_digest="${digest}"。`
      + '写完后设备会自动退出 DFU 并开始跑新固件（:leave）。',
  };
}

// 写入结果的判定档。为什么会分这么多档：dfu-util 的失败在**不同层**发生，而用户的下一步
// 完全相反——设备没了要重插，地址错了要查内存映射，传输失败要换线，命令返回 0 但没写进去
// 要去看原文。压成一句「失败」等于把定位工作全丢回给用户。
const DFU_FLASH_VERDICTS = {
  ok: 'ok',
  noEvidence: 'no-evidence',
  device: 'device',
  addr: 'addr',
  transfer: 'transfer',
  error: 'error',
};

// 成功证据：`Download done.` 与 `File downloaded successfully` 是 dfu-util 0.9–0.11 真机形状。
// 刻意**不**用 `DFU state(2) = dfuIDLE` 当判据：它在失败输出里同样出现（那是"开始下载前"的状态）。
const DFU_DONE_RE = /Download\s+done\./i;
const DFU_FILE_OK_RE = /File downloaded successfully/i;
// `Submitting leave request` / `Transitioning to dfuMANIFEST state`：设备接受退出请求的证据。
// 没有它只说明"字写进去了"，设备还停在 bootloader 里不跑新固件。
const DFU_LEAVE_RE = /Submitting leave request/i;
const DFU_MANIFEST_RE = /Transitioning to dfuMANIFEST state/i;
const DFU_ADDR_RE = /Download(?:ing element)? to address\s*=\s*(0x[0-9a-f]+)\s*,\s*size\s*=\s*(\d+)/i;

/**
 * 解析 `dfu-util -D` 的输出。
 * @param {string} text  stdout + stderr 合并
 * @param {{exitCode?: number}} [meta]
 */
function parseDfuFlash(text, { exitCode = 0 } = {}) {
  const out = String(text ?? '');
  const done = DFU_DONE_RE.test(out);
  const downloaded = DFU_FILE_OK_RE.test(out);
  const left = DFU_LEAVE_RE.test(out);
  const manifest = DFU_MANIFEST_RE.test(out);
  const hit = DFU_ADDR_RE.exec(out);
  let verdict = DFU_FLASH_VERDICTS.ok;
  if (!done && !downloaded) {
    if (/no dfu capable usb device|no device available|cannot open dfu device|libusb_error|permission denied/i.test(out)) {
      verdict = DFU_FLASH_VERDICTS.device;
    } else if (/out of range|exceeds available size|not within any/i.test(out)) {
      verdict = DFU_FLASH_VERDICTS.addr;
    } else if (/error during download|error during erase|dfu_status|stalled|broken pipe/i.test(out)) {
      verdict = DFU_FLASH_VERDICTS.transfer;
    } else {
      // 退出码 0 但没有任何成功证据：这是最危险的一档——「看起来成功了」。
      // 唯一诚实的结论是"没证据"，而不是"成功"。
      verdict = exitCode === 0 ? DFU_FLASH_VERDICTS.noEvidence : DFU_FLASH_VERDICTS.error;
    }
  } else if (exitCode !== 0) {
    // 有成功行但退出码非零（例如 leave 请求发出后设备断开）：按失败处理，不能报成功
    verdict = DFU_FLASH_VERDICTS.error;
  }
  return {
    ok: verdict === DFU_FLASH_VERDICTS.ok,
    verdict, downloaded, done, left, manifest,
    address: hit ? normalizeAddr(hit[1]) : '',
    bytes: hit ? Number(hit[2]) : 0,
    exitCode,
  };
}

// 通道别名的写法人人都不同（模型会写 dfu / dfu-util / stm32-dfu），但**路由结果必须唯一**。
const DFU_CHANNEL_ALIASES = ['dfu', 'dfu-util', 'stm32-dfu', 'usb-dfu'];
const ESPTOOL_CHANNEL_ALIASES = ['esptool', 'esptool-serial', 'serial', 'esp', 'uart'];

/**
 * 「这次烧写走哪条通道」的唯一判据（纯函数）。
 *
 * 为什么需要显式 channel：`.bin` 是 esptool 与 DFU **共用**的裸二进制（esptool 用 write_flash
 * 的 offset 参数，DFU 用 `-s addr`），光看扩展名判不出来。`.uf2` / `.dfu` 则相反——它们是容器，
 * 只有一条通道能收，所以**扩展名优先**：选错通道不该能写坏设备（把 .uf2 当裸二进制灌进 flash
 * 的后果是板子起不来，而工具照样返回 0）。
 *
 * 优先级：容器扩展名（.uf2/.dfu）> 显式 channel > 缺省 esptool。
 *
 * `.img` 刻意**不**按扩展名归入 fastboot：同一个 .img 既可能是要写到 SD 卡的整盘镜像
 * （disk 通道），也可能是要 flash 到某个分区的 boot/system 镜像，字节级区分不出来 ——
 * 猜错的代价是整盘覆盖。所以 .img 缺省仍归 disk（由 deviceFlashTool 拒绝并给出指引），
 * 只有显式 channel=fastboot 才走 Android 通道。
 * @returns {{channel?:string, error?:string, warnings:string[]}}
 */
function resolveFlashRoute({ channel = '', fmt = {}, port = '' } = {}) {
  const warnings = [];
  const raw = String(channel || '').trim().toLowerCase();
  const byFmt = fmt && fmt.channel ? fmt.channel : '';
  if (byFmt === 'uf2-copy') {
    if (raw && !['uf2', 'uf2-copy'].includes(raw)) {
      warnings.push(`固件是 .uf2 容器：按扩展名走 UF2 通道，channel=${raw} 已忽略（.uf2 写进 flash 等于灌容器字节）`);
    }
    return { channel: 'uf2-copy', warnings };
  }
  if (byFmt === 'dfu-util') {
    if (raw && ESPTOOL_CHANNEL_ALIASES.includes(raw)) {
      warnings.push(`固件是 .dfu 容器：按扩展名走 DFU 通道，channel=${raw} 已忽略（.dfu 的头部字节不是固件本体）`);
    }
    return { channel: 'dfu-util', warnings };
  }
  if (raw) {
    if (DFU_CHANNEL_ALIASES.includes(raw)) {
      // DFU 设备枚举成 0483:df11，没有串口节点。模型容易顺手把上一步的 port 带过来，
      // 这不算错（它确实想烧同一块板），但要说清参数被忽略了，否则用户以为那是生效的。
      if (port) warnings.push(`DFU 不经串口：port=${port} 已忽略（DFU 设备没有串口节点）`);
      return { channel: 'dfu-util', warnings };
    }
    // Android fastboot（2026-10-31）：**只能显式指定**，不能靠扩展名判——
    // `.img` 既可能是要拷到 SD 卡的整盘镜像（disk 通道），也可能是要 flash 到某个分区的
    // boot/system 镜像，两者字节级无法区分，猜错就是整盘覆盖。所以缺省仍归 disk（拒绝），
    // 只有调用方明确说 channel=fastboot 才进这条通道。
    if (FASTBOOT_CHANNEL_ALIASES.includes(raw)) {
      if (port) warnings.push(`fastboot 不经串口：port=${port} 已忽略（fastboot 设备走 USB，由 serial 定位）`);
      return { channel: 'fastboot', warnings };
    }
    if (ESPTOOL_CHANNEL_ALIASES.includes(raw)) return { channel: 'esptool-serial', warnings };
    return {
      warnings,
      error: `未知 channel：\`${channel}\`（可写 ${[
        ...DFU_CHANNEL_ALIASES, ...ESPTOOL_CHANNEL_ALIASES, ...FASTBOOT_CHANNEL_ALIASES,
      ].join(' / ')}；.uf2 / .dfu 按扩展名自动分流，不用传 channel）`,
    };
  }
  // .bin / 无扩展名 / 未登记扩展名：缺省仍是 esptool（保持历史行为，不因新通道改变旧路径）
  return { channel: byFmt === 'esptool-serial' || !byFmt ? 'esptool-serial' : byFmt, warnings };
}

module.exports = {
  DFU_ALLOWED_EXT, FLASH_ALT_RE, DFU_FLASH_VERDICTS, DFU_CHANNEL_ALIASES, ESPTOOL_CHANNEL_ALIASES,
  parseDfuList, pickTarget, pickAlt, parseDfuFlash, resolveFlashRoute,
  normalizeAddr, dfuPlanDigest, buildDfuArgv, buildDfuPlan,
};
