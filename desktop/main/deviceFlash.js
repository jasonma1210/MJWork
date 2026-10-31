// 刷机 / 烧盘的「参数装配 + 审批卡」纯逻辑（2026-10-31）。
//
// 为什么单独成模块、且坚持纯函数：
//   用户裁决是「全自动执行，但每一步都要确认授权 + 给出警告」。这套机制能不能站得住，
//   取决于**卡里的参数由工具算出来，而不是模型口述**——模型说「刷 /dev/disk4」而实际
//   那块盘是系统盘，就是灾难。所以：
//     · 目标盘候选由 `partitionCandidates` 从系统枚举结果里筛出，**显式排除系统卷**；
//     · 刷机命令由 `buildFlashPlan` 按芯片装配，模型只能选，不能拼；
//     · 审批卡由 `approvalCard` 统一生成，强制带上「影响面 + 失败后果 + 回滚方式」。
//   全部纯函数 ⇒ 可用固定样本回归，不依赖真机。
//
// 边界：本模块**不执行**任何命令（不 require child_process），只产出「要执行什么 + 卡上写什么」。

const crypto = require('crypto');

// 各芯片的 esptool 参数差异（只列与烧写有关的项）。
// 依据 esptool 的 chip 名：esp32 / esp32s2 / esp32s3 / esp32c3 / esp32c6 …
const CHIP_ARGS = {
  esp32: { baud: 460800, before: 'default_reset', after: 'hard_reset' },
  esp32s2: { baud: 460800, before: 'default_reset', after: 'hard_reset' },
  esp32s3: { baud: 921600, before: 'default_reset', after: 'hard_reset' },
  esp32c3: { baud: 460800, before: 'default_reset', after: 'hard_reset' },
  esp32c6: { baud: 460800, before: 'default_reset', after: 'hard_reset' },
};

const MIN_CANDIDATE_BYTES = 1 * 1024 * 1024 * 1024; // 1GB：小于这个不可能是可烧镜像的卡

/**
 * 从系统枚举出的磁盘里筛出「可安全烧写」的候选，并给出被排除的原因。
 * @param {Array<{id:string,sizeBytes:number,mediaName?:string,mountpoints?:string[],removable?:boolean,internal?:boolean}>} disks
 * @returns {{candidates:Array, rejected:Array}}
 */
function partitionCandidates(disks) {
  const list = Array.isArray(disks) ? disks : [];
  const candidates = [];
  const rejected = [];
  for (const d of list) {
    const id = String(d?.id || '').trim();
    if (!id) continue;
    const size = Number(d?.sizeBytes) || 0;
    const mps = Array.isArray(d?.mountpoints) ? d.mountpoints.map((m) => String(m)) : [];
    const label = [d?.mediaName || '未知介质', size ? `${(size / 1024 ** 3).toFixed(0)}GB` : '容量未知'].join(' · ');
    const reject = (why) => rejected.push({ id, label, why });
    // ① 系统盘一律排除：根挂载点、或挂着系统卷
    if (mps.includes('/') || mps.some((m) => m.startsWith('/System'))) { reject('系统盘（挂着根或系统卷）'); continue; }
    // ② 内置盘默认排除：烧镜像的目标应是可移动介质（外接硬盘可显式放行，见 allowInternal）
    if (d?.internal === true) { reject('内置磁盘（如需烧外接硬盘请显式允许）'); continue; }
    // ③ 虚拟盘：APFS 合成容器 / 磁盘映像。**这条是实测补的**（2026-10-31）：真机上
    //    `disk4` 是 18.4GB 的 iOS Simulator 磁盘映像，它 internal=false、容量 >1GB、不挂 `/`
    //    ⇒ 上面两条判据全放行，会被列成「可安全烧写」的候选。判据只能来自枚举层
    //    （diskutil 文本里的 `(synthesized)` / `(disk image)`），决策层无从自行推断。
    if (d?.virtual === true) { reject('虚拟盘（合成容器 / 磁盘映像），不是物理介质'); continue; }
    // ④ 太小
    if (size > 0 && size < MIN_CANDIDATE_BYTES) { reject(`容量过小（${(size / 1024 ** 2).toFixed(0)}MB）`); continue; }
    candidates.push({ id, label, sizeBytes: size, removable: d?.removable === true });
  }
  return { candidates, rejected };
}

// 十六进制偏移 → 字节数。`0x` 前缀可有可无；非十六进制返回 null（由调用方判为不合法）。
function parseOffset(text) {
  const t = String(text || '').trim();
  const m = /^(?:0x)?([0-9a-f]+)$/i.exec(t);
  if (!m) return null;
  return parseInt(m[1], 16);
}

/**
 * 镜像格式 ↔ 通道匹配表（L4，2026-10-31）。
 *
 * 为什么必须有这张表：esptool 的 `write_flash` **只接受裸二进制**。而旧实现里
 * `.hex`（Intel HEX，文本）与 `.uf2`（512 字节块容器，每块带 3 个魔数）都能通过校验被直接
 * 送进 write_flash —— 写进去的是「文件本身的字节」，不是它描述的固件内容。
 * 后果不是报错，而是**烧进去一坨废数据、板子起不来**，而且看起来一切正常（esptool 返回 0）。
 * 这是本层最隐蔽的一类错误：格式错了，工具链不会替你说。
 *
 * `.img` 单独一类：它是整盘镜像（SD 卡/eMMC），该走 list_targets 的磁盘通道，不是串口 flash。
 */
const IMAGE_FORMATS = [
  { ext: 'bin', channel: 'esptool-serial', note: '裸二进制，esptool 直接写' },
  { ext: 'uf2', channel: 'uf2-copy', note: 'UF2 是 512 字节块容器：只能拷到 bootloader 盘，当裸二进制写会写坏 flash' },
  { ext: 'hex', channel: null, note: 'Intel HEX 是文本：esptool 只收裸二进制，先用 objcopy -I ihex -O binary in.hex out.bin 转换' },
  { ext: 'img', channel: 'disk', note: '整盘镜像（SD 卡/eMMC）：走磁盘通道（list_targets），不写串口 flash' },
];

/**
 * 按扩展名判镜像格式与目标通道。
 * 返回 `{ ext, channel, known, why }`：
 *   known=false 表示「不认识这个扩展名」——此时**不能**断言它错了（可能就是个没有后缀的裸 bin），
 *   只能提醒；known=true 且 channel 不是 esptool 时才是确定的格式错误。
 * 这个区分是刻意的：把「不认识」和「确定不对」压成同一个错误，会让合法用法被拦死。
 */
function resolveImageFormat(file) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(file ?? ''));
  const ext = m ? m[1].toLowerCase() : '';
  if (!ext) {
    return { ext: '', channel: null, known: false, why: '没有扩展名：无法判断是裸二进制还是容器格式，请确认后重试' };
  }
  const hit = IMAGE_FORMATS.find((f) => f.ext === ext);
  if (!hit) return { ext, channel: null, known: false, why: `未登记的镜像格式 .${ext}：确认它是裸二进制再烧（已登记：${IMAGE_FORMATS.map((f) => `.${f.ext}`).join(' ')}）` };
  return { ext, channel: hit.channel, known: true, why: hit.note };
}

/** esptool 通道的格式闸：已知容器/文本格式硬拒，未知扩展名只提醒（同上原则）。 */
function esptoolFormatCheck(file) {
  const fmt = resolveImageFormat(file);
  if (fmt.channel === 'esptool-serial') return { ok: true };
  if (fmt.known) return { ok: false, error: `格式与通道不匹配：${fmt.why}（${file}）` };
  return { ok: true, warning: fmt.why };
}

/**
 * 规范化 VID:PID。`1a86:7523` / `1A86-7523` / `0x1a86:0x7523` 都接受，统一成 `1a86:7523`。
 * 为什么自己解析而不是直接字符串比较：同一块板子这四种写法用户和模型都会写出来，
 * 直接比较会把「同一个设备」判成不同，导致「插的就是这块板却被拒绝」。
 * 非法写法返回 null —— 调用方据此 fail-closed，不去猜他指的是哪块板。
 */
function parseVidPid(text) {
  const m = /^(?:0x)?([0-9a-f]{1,4})\s*[:-]\s*(?:0x)?([0-9a-f]{1,4})$/i.exec(String(text || '').trim());
  if (!m) return null;
  const pad = (x) => x.padStart(4, '0').toLowerCase();
  return `${pad(m[1])}:${pad(m[2])}`;
}

/**
 * 容量字符串 → 字节数。认 `4MB` / `4096KB` / `4194304` / `0x400000`。
 * **裸数字按十进制**（`400000` = 400000 字节），要十六进制必须写 `0x`——
 * 这与 offset 的口径有意不同：容量写成 `800000` 时人多半指 800KB 而不是 8MB。
 * 解析不出返回 0，不猜。
 */
function parseSize(text) {
  const t = String(text ?? '').trim();
  if (!t) return 0;
  const hex = /^0x([0-9a-f]+)$/i.exec(t);
  if (hex) return parseInt(hex[1], 16);
  const dec = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(t);
  if (!dec) return 0;
  const mul = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(Number(dec[1]) * (mul[dec[2].toUpperCase()] || 1));
}

/**
 * 把「单个 firmware + offset」与「segments 数组」归一成段列表。
 * 为什么两种形态都要支持：真实 ESP-IDF 工程是 4 段（bootloader / partition-table / app /
 * assets），而「烧一个裸 bin」也是最常见的用法。归一之后后面只有一条代码路径。
 */
function normalizeSegments({ firmware = '', offset = '0x0', segments } = {}) {
  if (Array.isArray(segments) && segments.length) {
    return segments.map((s) => ({ offset: String(s?.offset ?? '0x0'), file: String(s?.file || '') }));
  }
  return firmware ? [{ offset: String(offset), file: String(firmware) }] : [];
}

/**
 * 装配 esptool 烧写命令（不执行）。
 * @param {object} p
 * @param {string} p.port 串口（如 /dev/cu.wchusbserial110）
 * @param {string} [p.firmware] 单段固件路径（与 segments 二选一）
 * @param {Array<{offset:string,file:string}>} [p.segments] 多段烧写（ESP-IDF 产物）
 * @param {string} [p.chip] 芯片族（esp32 / esp32s3 / …），缺省按 esp32
 * @param {string} [p.offset] 单段模式下的烧写偏移，缺省 0x0
 * @param {'write_flash'|'verify_flash'} [p.command] 末尾子命令：写还是回读校验。缺省 write_flash。
 * @param {string} [p.tool] 可执行文件名（`esptool` / `esptool.py`）。缺省 `esptool`。
 * @returns {{ok:boolean, argv?:string[], segments?:Array, warnings:string[], error?:string}}
 *
 * 为什么用同一个函数装配两种子命令：`verify_flash` 的**参数面与 write_flash 完全一致**
 * （端口/芯片/波特率/复位方式/「偏移 文件」成对），差别只在最后那条子命令。
 * 分成两个函数会逼出两套段校验，而两套校验迟早漂移——「能烧但不能校验」这种裂缝没人会写测试。
 * warnings 按子命令分支：verify 不该出现「每段都会覆盖原有内容」这种吓人的话，它不写。
 */
function buildFlashPlan({ port = '', firmware = '', segments, chip = 'esp32', offset = '0x0', command = 'write_flash', tool = 'esptool', subStyle = 'underscore' } = {}) {
  // 按「是不是校验」判，不按字面量比对：v5 用 write-flash / verify-flash，v4 用下划线，
  // 写死 'write_flash' 会把 v5 的写入当成校验，于是「覆盖原有内容」的警告不会被发出——
  // 这是最坏的一类静默：卡还在弹，但风险描述丢了。
  const isWrite = !/verify/.test(command);
  // v5 连 `--before`/`--after` 的取值也换成了连字符（default-reset / hard-reset），
  // 下划线形式仅剩兼容并打 "WARNING: Deprecated"。真实告警是能看到的，所以必须跟着探测走。
  const sep = (v) => (subStyle === 'dash' ? String(v).replace(/_/g, '-') : String(v));
  const warnings = [];
  if (!port) return { ok: false, argv: [], warnings, error: '缺少串口：请先 probe 确认接到哪个 /dev/cu.*' };
  const segs = normalizeSegments({ firmware, offset, segments });
  if (!segs.length) return { ok: false, argv: [], warnings, error: '缺少固件路径（firmware 或 segments 至少给一个）' };
  const missing = segs.findIndex((s) => !s.file);
  if (missing >= 0) return { ok: false, argv: [], warnings, error: `第 ${missing + 1} 段缺少 file 路径` };
  const badOffset = segs.findIndex((s) => parseOffset(s.offset) === null);
  if (badOffset >= 0) return { ok: false, argv: [], warnings, error: `第 ${badOffset + 1} 段偏移不合法：\`${segs[badOffset].offset}\`（应为 0x 开头的十六进制）` };
  const base = CHIP_ARGS[String(chip).toLowerCase()];
  if (!base) {
    // 未知芯片：不猜参数，退到 esptool 默认值并明确告警
    warnings.push(`未登记芯片 \`${chip}\`：按 esptool 默认波特率/复位方式执行，若失败请改用 \`--chip\` 显式指定。`);
  }
  if (segs.length > 1) {
    // 多段时顺序即写入顺序；esptool 自己按偏移排序，但乱序的输入说明调用方可能填错了
    const offs = segs.map((s) => parseOffset(s.offset));
    if (offs.some((v, i) => i > 0 && v < offs[i - 1])) warnings.push('段的偏移不是递增的：esptool 会按偏移自行排序，请确认段与文件的对应关系没有错位。');
    if (isWrite) warnings.push(`多段烧写（${segs.length} 段）：每段都会覆盖目标偏移处的原有内容。`);
  }
  const argv = [
    tool, '--chip', String(chip).toLowerCase(), '--port', port,
    '--baud', String(base?.baud || 460800), '--before', sep(base?.before || 'default_reset'), '--after', sep(base?.after || 'hard_reset'),
    command,
    ...segs.flatMap((s) => [s.offset, s.file]),
  ];
  // 固件不存在的检查交给调用方（本模块不碰 fs）；这里只提示风险面
  warnings.push(isWrite
    ? '刷写会覆盖目标地址原有内容；中断可能导致无法启动（可重新进 bootloader 重刷，一般可恢复）。'
    : '回读校验（verify-flash）：只把设备上对应区间的实际内容与本地文件逐字节比对，不写入任何内容。');
  return { ok: true, argv, segments: segs, params: { baud: base?.baud || 460800, before: sep(base?.before || 'default_reset'), after: sep(base?.after || 'hard_reset') }, warnings };
}

/**
 * 装配整片备份命令 `<tool> read_flash 0x0 <size> <out>`（不执行）。
 * 为什么必须知道精确长度：read_flash 不给长度就不读，而「读少了」的备份等到真正要恢复时才发现——
 * 那是回滚链上最致命的一环。所以长度只能来自实测（flash_id）或用户显式给，绝不猜默认值。
 * @param {{port?:string, chip?:string, sizeBytes?:number, out?:string, tool?:string, readCommand?:string}} p
 * @param {string} [p.readCommand] 读子命令名。v5 是 `read-flash`、v4 是 `read_flash`，由调用方探测后传入。
 */
function buildBackupPlan({ port = '', chip = 'esp32', sizeBytes = 0, out = '', tool = 'esptool', readCommand = 'read_flash', subStyle = 'underscore' } = {}) {
  const warnings = [];
  if (!port) return { ok: false, argv: [], warnings, error: '缺少串口：请先 probe 确认接到哪个 /dev/cu.*' };
  if (!out) return { ok: false, argv: [], warnings, error: '缺少备份输出路径 out（整片备份要落到一个文件，否则读出来没地方放）' };
  const n = Number(sizeBytes) || 0;
  if (n <= 0) return { ok: false, argv: [], warnings, error: '缺少 flash 容量：备份必须知道读多长（先由 flash_id 实测，或显式给 size）' };
  const base = CHIP_ARGS[String(chip).toLowerCase()];
  if (!base) warnings.push(`未登记芯片 \`${chip}\`：按 esptool 默认波特率/复位方式执行，若失败请显式指定 \`--chip\`。`);
  const sep = (v) => (subStyle === 'dash' ? String(v).replace(/_/g, '-') : String(v));
  const argv = [
    tool, '--chip', String(chip).toLowerCase(), '--port', port,
    '--baud', String(base?.baud || 460800), '--before', sep(base?.before || 'default_reset'), '--after', sep(base?.after || 'hard_reset'),
    readCommand, '0x0', `0x${n.toString(16)}`, out,
  ];
  warnings.push(`整片备份 ${(n / 1024 ** 2).toFixed(2)}MB → ${out}：这是唯一的回滚素材，同一任务里不要用同名文件再写第二次。`);
  warnings.push('备份内容包含设备上的全部数据（含配网信息 / NVS 等可能敏感的字段）：不要上传到公开位置。');
  return { ok: true, argv, sizeBytes: n, params: { baud: base?.baud || 460800, before: base?.before || 'default_reset', after: base?.after || 'hard_reset' }, warnings };
}

/**
 * 段与 flash 实际容量是否相容（纯逻辑，不跑命令）。
 * 同时查「段与段之间是否重叠」——重叠意味着后一段会盖掉前一段，是填错偏移最典型的表现，
 * 且这个判断**不需要容量**，所以容量未知时也能拦。
 * @param {Array<{offset:string,sizeBytes:number,file:string}>} segments 已带文件大小的段
 * @param {number} flashSizeBytes 实测容量；0/未知时跳过越界判定
 * @returns {{ok:boolean, overflows:Array, overlaps:Array, unknownOffset:Array}}
 */
function checkSegmentsFit(segments, flashSizeBytes) {
  const flash = Number(flashSizeBytes) || 0;
  const list = segments || [];
  const overflows = [];
  const overlaps = [];
  const unknownOffset = [];
  const spans = [];
  for (const s of list) {
    const off = parseOffset(s?.offset);
    if (off === null) { unknownOffset.push(s); continue; }
    const end = off + (Number(s?.sizeBytes) || 0);
    spans.push({ file: s.file, offset: s.offset, start: off, end });
    if (flash > 0 && end > flash) overflows.push({ file: s.file, offset: s.offset, end, flash });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) {
      overlaps.push({ later: spans[i].file, laterOffset: spans[i].offset, earlier: spans[i - 1].file, earlierEnd: spans[i - 1].end });
    }
  }
  return { ok: overflows.length === 0 && overlaps.length === 0 && unknownOffset.length === 0, overflows, overlaps, unknownOffset };
}

/**
 * 从 `esptool flash_id` 的输出里取芯片名与 flash 容量。
 * 三种写法都会出现，所以都要认（真机实测，别只照文档写）：
 *   · v5 起：`Chip type:          ESP32-S3 (QFN56) (revision v0.2)` —— 带 OLED 对齐空格
 *   · 更早：  `Chip is ESP32-S3 (revision v0.2)`
 *   · 容量：  `Detected flash size: 16MB`（v3+）与 `Flash size: 4MB`（更早）
 * 只认一种的后果不是报错而是**静默拿到空串**——chip 只用于展示，所以不会崩，
 * 但审批卡与结果里会缺「到底是哪块芯片」，人就没法核对了。
 * @returns {{chip:string, flashSizeBytes:number}} 取不到的字段为 '' / 0
 */
function parseFlashIdInfo(stdout) {
  const text = String(stdout || '');
  const chip = (/(?:Chip is|Chip type:)\s+([A-Za-z0-9\-_()\s.]+?)(?:\s*\(revision|\s*\n|$)/.exec(text) || [])[1] || '';
  const sizeM = /(?:Detected\s+flash\s+size|Flash\s+size)\s*:\s*(\d+(?:\.\d+)?)\s*([KMG]B)/i.exec(text);
  let flashSizeBytes = 0;
  if (sizeM) {
    const mul = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[sizeM[2].toUpperCase()] || 1;
    flashSizeBytes = Math.round(Number(sizeM[1]) * mul);
  }
  return { chip: String(chip).trim(), flashSizeBytes };
}

// ── chip_id 握手：把「桥芯片后面可能是任意 MCU」变成「这块到底是哪颗」──────────
// device_probe 只能说到「这个桥串口背后可能是 ESP32 / STM32 / AVR」。要跨过这一步，
// 唯一的办法是真的跟芯片对一次话（esptool 的 ROM 同步），而不是继续看 VID 猜。
//
// 判据全部来自**真机实测**（2026-10-31，ESP32-S3 经 /dev/cu.usbmodem1301）：
//   成功：Detecting chip type... ESP32-S3
//         Chip type:          ESP32-S3 (QFN56) (revision v0.2)
//         MAC:                d0:cf:13:06:dc:74
//         Detected flash size: 16MB
//   端口层失败：ERROR: A fatal error occurred: Could not open /dev/cu.x, the port is busy or doesn't exist.
//
// **这一节最重要的一条诚实**：握手失败**不能**推出「不是 ESP」。
// 桥芯片后面挂 STM32 会得到 no-response；一块没有自动复位电路的 ESP 板同样会得到
// no-response（它只是没被拉进下载模式）。两种情况在输出上不可区分，所以失败一律给
// unknown，绝不给 not-esp —— 把「没查到」写成「查到了没有」，就是 C-001 那类同形错误。
const HANDSHAKE_VERDICTS = {
  esp: 'esp',
  needBoot: 'esp-need-bootloader',
  port: 'port-error',
  noResponse: 'no-response',
  unknown: 'unknown',
};

/**
 * 芯片名 → CHIP_ARGS 的键（esp32s3 这种）。
 * 为什么要映射而不是直接透传 "ESP32-S3"：后续 flash 的参数（波特率/复位时序）是按 CHIP_ARGS
 * 的键取的，键对不上就退回默认值 —— 那正是「用错波特率烧到一半」的来源。
 * 归一化后**最长前缀匹配**：ESP32-D0WD-V3 要命中 esp32 而不是被 esp32s3 之类的短键吃掉，
 * 而 ESP32-S3 必须命中 esp32s3 而不是更短的 esp32。
 */
function chipKeyOf(chipName, keys = Object.keys(CHIP_ARGS)) {
  const norm = String(chipName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return '';
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  return sorted.find((k) => norm.startsWith(k)) || '';
}

/**
 * 把一次 `esptool --chip auto ... flash-id` 的输出翻译成身份结论。
 * 用 `--chip auto` 而不是写死型号，是这一步的全部意义：**由芯片自己报身份**。
 * @param {string} stdout 合并后的 stdout+stderr（esptool 把两种都往 stderr 打）
 * @param {{exitCode?:number, chipKeys?:string[]}} [opts]
 * @returns {{verdict:string, esp:boolean, chip:string, chipKey:string, mac:string,
 *            flashSizeBytes:number, detected:string}}
 */
function parseHandshake(stdout, { exitCode = 0, chipKeys = Object.keys(CHIP_ARGS) } = {}) {
  const text = String(stdout || '');
  const out = {
    verdict: HANDSHAKE_VERDICTS.unknown, esp: false, chip: '', chipKey: '', mac: '', flashSizeBytes: 0, detected: '',
    exitCode,
  };
  // ① 成功：esptool 只有真的同步上才会打 "Detecting chip type..."（--chip auto 专用）
  const det = /Detecting chip type\.\.\.\s*([A-Za-z0-9\-_]+)/i.exec(text);
  const info = parseFlashIdInfo(text);
  const chips = info.chip || (det ? det[1] : '');
  if (chips) {
    out.verdict = HANDSHAKE_VERDICTS.esp;
    out.esp = true;
    out.chip = chips;
    out.detected = det ? det[1] : chips;
    out.chipKey = chipKeyOf(chips, chipKeys);
    out.flashSizeBytes = info.flashSizeBytes;
    out.mac = (/MAC:\s*([0-9a-fA-F:]{11,17})/.exec(text) || [])[1] || '';
    return out;
  }
  // ② 是 ESP，但没进下载模式：esptool 认出了 boot mode 才会这么报 ⇒ 身份仍然是确定的
  if (/Wrong boot mode detected|needs to be in download mode/i.test(text)) {
    out.verdict = HANDSHAKE_VERDICTS.needBoot;
    out.esp = true;
    out.chip = (/(?:Failed to connect to|Chip is)\s*([A-Za-z0-9\-_]+)/i.exec(text) || [])[1] || '';
    out.chipKey = chipKeyOf(out.chip, chipKeys);
    return out;
  }
  // ③ 端口层失败：与「这块芯片是什么」无关，尤其不能当成「不是 ESP」。
  //    顺序放在 no-response 之前：占用/权限失败的信息里也常带 "failed to connect"，
  //    先判 no-response 会把「口被别的程序占了」误报成「芯片没响应」。
  if (/Could not open|the port is busy|Permission denied|Resource busy|Errno 13|Errno 16/i.test(text)) {
    out.verdict = HANDSHAKE_VERDICTS.port;
    return out;
  }
  // ④ 没响应：可能是非 ESP，也可能是 ESP 但没进下载模式 ⇒ 只能给 unknown
  if (/No serial data received|Timed out waiting for packet header|Failed to connect/i.test(text)) {
    out.verdict = HANDSHAKE_VERDICTS.noResponse;
    return out;
  }
  return out;
}

/**
 * 生成审批卡（强制三要素：影响面 / 失败后果 / 回滚方式）。
 * 缺任一项直接抛错——不允许出现「没有回滚说明的不可逆操作卡」。
 */
function approvalCard({ action = '', target = '', impact = '', consequence = '', rollback = '', reversible = false } = {}) {
  const missing = [];
  if (!action) missing.push('action');
  if (!target) missing.push('target');
  if (!impact) missing.push('impact');
  if (!consequence) missing.push('consequence');
  if (!rollback) missing.push('rollback');
  if (missing.length) throw new Error(`审批卡缺少必填项：${missing.join(', ')}（不可逆操作必须写清回滚方式）`);
  return { action, target, impact, consequence, rollback, reversible: reversible === true, level: reversible === true ? 'high' : 'never' };
}

/**
 * 参数摘要（plan → flash 的一致性锁）。
 * 为什么需要：用户看过 plan 里的 argv 并同意之后，模型仍可能在**下一次调用**里改 port
 * （把固件烧到另一块板子）。宿主分不清「参数变了」与「用户换了主意」，因此要求 flash 回传
 * plan 阶段的摘要，宿主按**当前**参数重算并比对；不一致即拒绝 —— 换目标必须重新走一次 plan，
 * 让人再看一眼。摘要只覆盖「决定烧什么、烧到哪」的字段，不含时间戳等易变量。
 */
function planDigest({ port = '', firmware = '', chip = 'esp32', offset = '0x0', argv = [], segments } = {}) {
  const segs = (segments || []).map((s) => [String(s?.offset ?? ''), String(s?.file ?? '')]);
  const payload = [String(port), String(firmware), String(chip), String(offset), (argv || []).map(String), segs];
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

module.exports = {
  CHIP_ARGS, MIN_CANDIDATE_BYTES, partitionCandidates, buildFlashPlan, buildBackupPlan, approvalCard, planDigest,
  parseOffset, parseSize, parseVidPid, normalizeSegments, checkSegmentsFit, parseFlashIdInfo,
  IMAGE_FORMATS, resolveImageFormat, esptoolFormatCheck,
  HANDSHAKE_VERDICTS, chipKeyOf, parseHandshake,
};
