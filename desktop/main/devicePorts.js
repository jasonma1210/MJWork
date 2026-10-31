// L2 桥接驱动层（2026-10-31，参考 hardware_flash_workflow.md §1.2 / §1.4）
//
// 这一层只回答一个问题：**USB 上这个设备，背后到底有没有一个能开出来的串口？**
//
// 判据按可信度分三级，必须分级而不是糅成一条：
//   ① hwid 里的 VID:PID（`python3 -m serial.tools.list_ports -v`）—— 来自设备描述符，最可信；
//   ② USB 总线枚举（system_profiler / /sys）—— 只说「设备在」，不保证有串口；
//   ③ 端口命名（cu.usbmodem* / cu.wchusbserial*）—— 最弱，只在完全没有 ① 时兜底。
//
// 为什么「只看命名」会错两次（都是实测，不是设想）：
//   · 假阳性：本机 5 个蓝牙虚拟口都叫 /dev/cu.*，命名规则认不出它们背后没有设备；
//   · 假阴性：板载 0x1a86:0x7522（CH34x，产品串就叫 "USB Serial"）没装驱动时**一个口都不出现**，
//     命名规则会判成「没插设备」—— 而真相是「设备在、驱动缺」，两者下一步动作完全相反。
// 所以：hwid 一旦存在就以它为准；「hwid 说没有」≠「未查到」。
//
// 三种「没有」必须分开（否则就是 C-001 那类同形错误：把「查失败」压成「查不到」）：
//   real === true   有 VID:PID          → 真设备
//   real === false  明确写着 n/a        → 确认不是 USB 串口（蓝牙耳机 / debug-console）
//   real === null   根本没有 hwid 字段  → 查不到（pyserial 太老 / 没装），**不可**当作「不是设备」
//
// 边界（写清以免被当成「驱动管家」）：
//   · 本模块只**判定与给建议**，不装驱动、不 sudo、不碰设备；
//   · 装 CH34x/CP210x 驱动需要 sudo + 允许系统扩展 + 可能重启 —— 这条不自动化。

const { classifyPorts, matchBoard } = require('./deviceProbe'); // 同一 main/ 目录

const norm4 = (x) => String(x ?? '').trim().toLowerCase().replace(/^0x/, '').padStart(4, '0').slice(-4);

/** 端口名是否像一个真串口（挡掉混进 stdout 的 python 告警/报错）。 */
const isPortName = (s) => /^\/dev\/\S+$/.test(s) || /^COM\d+$/i.test(s);

/**
 * 从 pyserial 的 hwid 串里抠身份。
 * 形如 `USB VID:PID=303A:1001 SER=D0:CF:13:06:DC:74 LOCATION=0-1.3`。
 * 注意 SER 里本来就带冒号（MAC 风格序列号），所以不能按 `:` 切分——只能整段正则。
 * 取不到 VID:PID 返回 null（这是「查不到身份」，不是「没有身份」）。
 */
function parseHwid(hwid) {
  const s = String(hwid ?? '');
  const m = /VID:PID=([0-9A-Fa-f]{1,4}):([0-9A-Fa-f]{1,4})/.exec(s);
  if (!m) return null;
  const field = (k) => {
    const r = new RegExp(`${k}=([^\\s]*)`).exec(s);
    return r ? r[1] : '';
  };
  return { vid: norm4(m[1]), pid: norm4(m[2]), serial: field('SER'), location: field('LOCATION') };
}

/**
 * 把「找解释器 + 列详细端口」那一条命令的输出拆成两部分。
 * 命令形状（见 deviceProbeTool 的 PROBES）：
 *   成功 → `INTERP=<路径>` + pyserial 的详细列表
 *   失败 → `INTERP=`（空）——这就是「pyserial 不可用」的唯一信号，
 *          不能靠「端口列表为空」判断，因为「装了 pyserial 但当前 0 个端口」也长这样。
 */
function splitPyserialOutput(raw) {
  const lines = String(raw ?? '').split('\n');
  const head = lines.find((l) => l.trim().startsWith('INTERP=')) || '';
  const interpreter = head ? head.trim().slice('INTERP='.length).trim() : '';
  const body = lines.filter((l) => !l.trim().startsWith('INTERP=')).join('\n');
  return { interpreter, body, available: Boolean(interpreter) };
}

/**
 * 解析 pyserial `-v` 的详细输出 → 端口记录数组。
 *
 * 实测原文（macOS 26 / Apple Silicon，2026-10-31）：
 * ```
 * 6 ports found
 * /dev/cu.Bluetooth-Incoming-Port
 *     desc: n/a
 *     hwid: n/a
 * /dev/cu.usbmodem1301
 *     desc: USB JTAG/serial debug unit
 *     hwid: USB VID:PID=303A:1001 SER=D0:CF:13:06:DC:74 LOCATION=0-1.3
 * ```
 * 三个坑：
 *   · 首行 `N ports found` 不是端口，直接跳过；
 *   · 顶格 = 端口名，缩进 = 属性——不能按固定行数取，因为老版本只有端口名没有属性；
 *   · 端口名可能带**尾随空格**（实测 `/dev/cu.picunF6     `），不 trim 会得到一个打不开的路径。
 */
function parsePyserialDetailed(body) {
  const raw = [];
  let cur = null;
  for (const line of String(body ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^\d+\s+ports?\s+found$/i.test(t)) continue;
    if (!/^\s/.test(line)) {
      // 顶格行只接受像端口名的：python 的 warning/traceback 也会顶格出现，
      // 放过它们会让「解析失败」伪装成「发现了一个叫 xxx 的设备」。
      if (!isPortName(t)) { cur = null; continue; }
      cur = { port: t, desc: '', hwid: '' };
      raw.push(cur);
      continue;
    }
    if (!cur) continue; // 缩进属性出现在任何端口之前：不是 -v 详细格式，忽略
    const m = /^(desc|hwid)\s*:\s*(.*)$/i.exec(t);
    if (m) cur[m[1].toLowerCase()] = m[2].trim();
  }
  return raw.map((p) => {
    const id = parseHwid(p.hwid);
    const named = classifyPorts([p.port]).serial[0] || null;
    const board = id ? matchBoard(id.vid, id.pid) : null;
    const hadDetail = Boolean(p.hwid || p.desc);
    return {
      port: p.port,
      desc: p.desc === 'n/a' ? '' : p.desc,
      hwid: p.hwid,
      vid: id ? id.vid : '',
      pid: id ? id.pid : '',
      serial: id ? id.serial : '',
      location: id ? id.location : '',
      real: id ? true : (hadDetail ? false : null),
      chip: board ? board.chip : (named ? named.chip : 'unknown'),
      driver: board ? board.driver : (named ? named.driver : 'unknown'),
      kind: board ? (board.kind || 'unknown') : 'unknown',
    };
  });
}

// 驱动族：键必须与 deviceProbe.js 的 BOARDS[].driver 对得上，否则「已加载」永远判 false。
const DRIVER_FAMILIES = [
  { key: 'builtin', re: /usb\.cdc|AppleUSBACM|cdc_acm|IOUSBHostFamily/i, label: 'Apple 内置 USB CDC（免驱路径）' },
  { key: 'wch-ch34x', re: /wch|ch34\d?x?|ch9102|ch343/i, label: 'WCH CH34x（CH340/CH343/CH9102）' },
  { key: 'silabs-cp210x', re: /silabs|cp210|SLAB_USBtoUART/i, label: 'Silicon Labs CP210x' },
  { key: 'ftdi-vcp', re: /ftdi/i, label: 'FTDI VCP' },
];

// grep 没命中时探测命令会 echo 这个哨兵：用来区分「查过了，确实没有」与「命令失败/没输出」。
const NO_DRIVER_SENTINEL = 'NO_SERIAL_DRIVERS';
// 命令本身挂掉（kmutil/lsmod 无输出）时 echo 这个：必须与「确实没有」分开，
// 否则会得出「驱动没装」这个**错误结论**，让人白装一次驱动（还要 sudo + 重启）。
const DRIVER_PROBE_FAILED = 'DRIVER_PROBE_FAILED';

/**
 * 解析「已加载的串口驱动」输出（macOS: `kmutil showloaded | grep -E ...`；Linux: `lsmod | grep -E ...`）。
 *
 * 为什么返回 ok 而不是直接给 families：空输出有两种含义——「一条都没匹配」和「命令挂了」。
 * 把后者当成「驱动没装」会给出**错误建议**（让人白装一次驱动），所以宁可说「查不到」。
 * 真有输出时（哪怕只有哨兵行）ok 才为 true。
 *
 * 注意 Linux 上 lsmod 只能说明「模块在内存里」，不代表设备已绑定 —— 这里的结论只是佐证，
 * 最终判据始终是「端口有没有出来」。
 */
function parseLoadedDrivers(stdout) {
  const lines = String(stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const failed = lines.includes(DRIVER_PROBE_FAILED);
  const bundles = [];
  for (const l of lines) {
    if (l === NO_DRIVER_SENTINEL || l === DRIVER_PROBE_FAILED) continue;
    const id = (/\b(com\.[A-Za-z0-9_.]+)\b/.exec(l) || /^([a-z0-9_]{3,})\s+\d+/.exec(l) || [])[1];
    if (id && !bundles.includes(id)) bundles.push(id);
  }
  const ok = lines.length > 0 && !failed;
  const families = {};
  const labels = {};
  for (const f of DRIVER_FAMILIES) {
    families[f.key] = ok && lines.some((l) => f.re.test(l));
    labels[f.key] = f.label;
  }
  return { ok, bundles, families, labels };
}

const KIND_LABEL = {
  dfu: 'DFU（芯片 ROM 下载模式）',
  uf2: 'UF2（枚举成 U 盘，不是串口）',
  'debug-probe': '调试探针（ST-LINK / J-Link / DAPLink）',
  fastboot: 'Android bootloader（fastboot 模式）',
  hub: 'USB 集线器',
};

const VERDICT_LABEL = {
  ready: '可用（已出现串口）',
  'need-driver': 'USB 在但串口没出：缺驱动',
  'driver-loaded-no-port': 'USB 在、驱动也在，但没出现串口：设备当前模式不支持串口',
  'not-serial': '非串口设备（没有串口是正常的）',
  unknown: '身份未知，无法判断',
  ignored: '已忽略（集线器等非终端设备）',
};

/**
 * 逐个 USB 设备给出「能不能开串口」的结论（纯函数，L2 的全部价值在这里）。
 *
 * @param {object} p
 * @param {Array} p.devices   parseUsbTree 的结果（device 带 board）
 * @param {Array} p.ports     parsePyserialDetailed 的结果；也可以是 hand-built 的 {port, real:null}
 * @param {object|null} p.drivers parseLoadedDrivers 的结果；null = 未查询
 * @returns {{bridges: Array, portIndex: Array, notes: string[]}}
 */
function assessBridges({ devices = [], ports = [], drivers = null } = {}) {
  // 归一化：调用方可能只给 `{ port, real: null }`（比如退回 `ls /dev/cu.*` 的场合），
  // 这时用命名规则补齐 chip/driver —— 否则下面的命名兜底会因为 driver 字段缺失永远不命中。
  const list = (Array.isArray(ports) ? ports : []).map((p) => {
    if (p && p.driver) return p;
    const named = classifyPorts([p && p.port]).serial[0] || null;
    return {
      port: String((p && p.port) || ''), real: p && p.real !== undefined ? p.real : null,
      vid: '', pid: '', serial: '', location: '',
      chip: named ? named.chip : 'unknown', driver: named ? named.driver : 'unknown', kind: 'unknown',
    };
  }).filter((p) => p.port);
  // real === false 的口（hwid 明确 n/a）不参与任何匹配：它们背后没有 USB 设备
  const candidates = list.filter((p) => p.real !== false);
  const noHwidAtAll = candidates.length > 0 && candidates.every((p) => p.real === null);
  const used = new Set();
  const bridges = [];
  const notes = [];

  for (const dev of devices) {
    const board = dev.board || {};
    const kind = board.kind || 'unknown';
    const base = {
      vid: dev.vid, pid: dev.pid, serial: dev.serial || '',
      name: board.name || dev.name || '', chip: board.chip || 'unknown',
      kind, driver: board.driver || 'unknown',
      ports: [], evidence: '', driverLoaded: null, verdict: 'unknown', advice: '',
    };

    if (kind === 'hub') {
      bridges.push({ ...base, verdict: 'ignored', advice: 'USB 集线器，不是串口设备（板子可能挂在它下面）' });
      continue;
    }
    if (kind !== 'serial' && kind !== 'unknown') {
      const label = KIND_LABEL[kind] || kind;
      bridges.push({
        ...base, verdict: 'not-serial',
        advice: `${label}：本来就没有串口，不要按「缺驱动」处理`,
      });
      continue;
    }

    // ① 先按 hwid 精确匹配（带序列号），再退到 (vid,pid)
    let hit = candidates.filter((p) => !used.has(p.port) && p.vid === dev.vid && p.pid === dev.pid
      && p.serial && dev.serial && p.serial === dev.serial);
    let evidence = hit.length ? 'hwid+serial' : '';
    let ambiguous = false;
    if (!hit.length) {
      const loose = candidates.filter((p) => !used.has(p.port) && p.vid === dev.vid && p.pid === dev.pid);
      // 只认领**一个**口：两块同型号板子（VID:PID 相同、系统序列号都报 "Not Provided"）时，
      // 若把 loose 全给第一块，第二块必然被判成「缺驱动」——那是假故障。
      hit = loose.slice(0, 1);
      ambiguous = loose.length > 1;
      evidence = hit.length ? (ambiguous ? 'hwid-ambiguous' : 'hwid') : '';
    }
    // ② 只有在**完全没有** hwid 信息时才退回命名规则：
    //    一旦 hwid 能查到，它的「没有」就是结论——再用命名去猜等于绕过权威判据。
    if (!hit.length && noHwidAtAll) {
      const guess = candidates.filter((p) => !used.has(p.port)
        && (p.driver === base.driver || (p.driver === 'vendor-vcp' && base.driver !== 'builtin')));
      if (guess.length === 1) { hit = guess; evidence = 'naming'; }
      else if (guess.length > 1) evidence = 'naming-ambiguous';
    }
    for (const p of hit) used.add(p.port);

    // 驱动加载状态：'builtin' 不需要装任何东西，恒为「在」
    const famKey = base.driver;
    const driverLoaded = drivers && drivers.ok
      ? (famKey === 'builtin' ? true : Boolean(drivers.families[famKey]))
      : null;

    let verdict;
    let advice;
    if (hit.length) {
      verdict = 'ready';
      advice = `串口已就绪：${hit.map((p) => p.port).join(' ')}`;
    } else if (kind === 'unknown') {
      // 板卡都没认出来，谈驱动是空话——这一档必须排在驱动判断**前面**
      verdict = 'unknown';
      advice = '不在板卡表内：先确认 VID:PID 属于哪种桥芯片，再决定装哪个驱动';
    } else if (!drivers || !drivers.ok) {
      // 查不到驱动状态时不要下「缺驱动」的硬结论，但也别装作没事
      verdict = 'need-driver';
      advice = 'USB 在但串口没出，最常见原因是缺厂商驱动（本次未查到驱动加载状态，无法确认）';
    } else if (driverLoaded) {
      verdict = 'driver-loaded-no-port';
      advice = famKey === 'builtin'
        ? '免驱设备却没有串口：多半是当前不进 CDC 模式（如 ROM bootloader 只开 JTAG），或线是充电线'
        : '驱动已加载但没出串口：重插一次；仍无则确认设备未被别的进程独占';
    } else {
      verdict = 'need-driver';
      advice = `需装驱动：${(drivers.labels && drivers.labels[famKey]) || famKey}（需 sudo + 允许系统扩展，本工具不自动安装）`;
    }

    bridges.push({ ...base, ports: hit.map((p) => p.port), evidence, driverLoaded, verdict, advice });
  }

  // —— 证据型 notes（不改变结论，只解释「为什么这么判」）——
  const fakes = list.filter((p) => p.real === false);
  if (fakes.length) {
    notes.push(`已排除 ${fakes.length} 个非 USB 串口（hwid=n/a）：${fakes.map((p) => p.port).join(' ')}`);
  }
  if (noHwidAtAll) {
    notes.push('pyserial 未给出 hwid：端口判定已退回命名规则，可信度下降（建议升级 pyserial 或用带 pyserial 的解释器）');
  }
  const missing = bridges.filter((b) => b.verdict === 'need-driver');
  if (missing.length) {
    notes.push(`${missing.length} 个设备「USB 在但串口没出」：${missing.map((b) => `${b.name || `${b.vid}:${b.pid}`}`).join('、')}`);
  }
  const odd = bridges.filter((b) => b.verdict === 'driver-loaded-no-port');
  if (odd.length) {
    notes.push(`${odd.length} 个设备驱动在但没出串口（不是缺驱动，别装驱动）：${odd.map((b) => `${b.vid}:${b.pid}`).join('、')}`);
  }
  const amb = bridges.filter((b) => b.evidence === 'hwid-ambiguous');
  if (amb.length) {
    notes.push(`${amb.length} 个设备的 VID:PID 相同且无序列号可区分：端口按枚举顺序分配，可能张冠李戴（建议只插一块板）`);
  }
  if (!drivers || !drivers.ok) notes.push('未查到串口驱动加载状态：结论只基于「设备在 / 串口有没有出来」');
  return { bridges, portIndex: list, notes };
}

module.exports = {
  parseHwid, splitPyserialOutput, parsePyserialDetailed, parseLoadedDrivers, assessBridges,
  DRIVER_FAMILIES, KIND_LABEL, VERDICT_LABEL, NO_DRIVER_SENTINEL, DRIVER_PROBE_FAILED,
};
