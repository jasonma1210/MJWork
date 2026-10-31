// USB 设备识别（2026-10-31）：把「插了什么板、什么芯片、哪个串口、要不要驱动」判定成结构化事实。
//
// 为什么单独成纯函数模块：
//   ① 判定规则必须可单测——VID/PID → 型号 是查表，不该靠模型猜；
//   ② 本文件零依赖（不 require node:fs / 不 require electron）：解析输入由调用方给
//     （主进程跑 `system_profiler SPUSBDataType -json` / `ls /dev/cu.*` 后传进来），
//     这样渲染层打包不会断，也便于用固定样本做回归。
//
// 边界（写清以免被当成「全能设备管理」）：
//   · 本模块只做**识别**，不刷机、不装驱动、不碰 sudo；
//   · 刷机属不可逆动作，必须在工具层登记为 REVERSIBILITY.reversible=false，走 never 档审批；
//   · macOS 装 CH34x/CP210x kext 需要 sudo + 允许系统扩展 + 可能重启 —— 这条**不自动化**，
//     只输出「装哪个、去哪下」，让人自己点。

// 板卡表：VID/PID → 芯片与驱动要求。
// 依据：Espressif 原生 USB CDC（303a）免驱；CH340/CP210x/FTDI 是常见 USB-串口桥，需厂商 kext。
const BOARDS = [
  // —— 原生 USB（免驱，ESP32-S3/C3/C6 常见）——
  { vid: '303a', pid: null, chip: 'esp32-native', name: 'Espressif 原生 USB（S3/C3/C6 等）', driver: 'builtin', note: '免驱：走 USB CDC，macOS 直接出现 cu.usbmodem*' },
  // —— USB-串口桥（需厂商驱动）——
  { vid: '1a86', pid: '7523', chip: 'ch340', name: 'CH340/CH341（多数国产 ESP32 开发板）', driver: 'wch-ch34x', note: '需装 WCH CH34x 驱动，串口名形如 cu.wchusbserial*' },
  { vid: '1a86', pid: '55d4', chip: 'ch9102', name: 'CH9102（CH340 后继，部分新板）', driver: 'wch-ch34x', note: '同 CH34x 驱动族' },
  { vid: '10c4', pid: 'ea60', chip: 'cp210x', name: 'CP2102/CP2104（NodeMCU 常见）', driver: 'silabs-cp210x', note: '需装 Silicon Labs CP210x VCP 驱动' },
  { vid: '0403', pid: '6001', chip: 'ftdi', name: 'FTDI FT232', driver: 'ftdi-vcp', note: 'macOS 10.15+ 多数已内置' },
];

/** 依 VID/PID 查板卡（纯函数）。vid/pid 传字符串，大小写与 0x 前缀都会归一化。 */
function matchBoard(vid, pid) {
  const v = normHex(vid);
  const p = normHex(pid);
  if (!v) return null;
  // 先精确匹配 (vid,pid)，再退到「同 vid 且 pid 为 null」的通配条目
  const exact = BOARDS.find((b) => b.vid === v && b.pid && b.pid === p);
  if (exact) return { ...exact };
  const wildcard = BOARDS.find((b) => b.vid === v && !b.pid);
  return wildcard ? { ...wildcard } : { vid: v, pid: p, chip: 'unknown', name: '未识别的 USB 设备', driver: 'unknown', note: '不在板卡表内，需人工确认' };
}

const normHex = (x) => String(x ?? '').trim().toLowerCase().replace(/^0x/, '').padStart(4, '0').slice(-4);

/**
 * 解析 `system_profiler SPUSBDataType -json` 的输出（已 JSON.parse 的对象），
 * 拍平成 [{ name, vid, pid, serial, board }]。
 * 该命令的树形结构分 SPUSBDataType / _items，字段名随 macOS 版本略有差异，
 * 所以这里只依赖 `_name` + `vendor_id`/`product_id` 三个稳定字段，其余可选。
 */
function parseUsbTree(tree) {
  const out = [];
  // 通用下探：macOS 把设备数组挂在 `SPUSBDataType` 键下，子设备又可能是 `_items`；
  // 只认 `_items` 会漏掉顶层（实测踩到：devices 空）。这里对任意对象/数组都递归。
  const walk = (node) => {
    if (Array.isArray(node)) { for (const it of node) walk(it); return; }
    if (!node || typeof node !== 'object') return;
    const name = String(node._name || '').trim();
    const vid = node.vendor_id;
    const pid = node.product_id;
    if (vid && pid) {
      const board = matchBoard(String(vid).match(/0x([0-9a-f]+)/i)?.[1] || vid, String(pid).match(/0x([0-9a-f]+)/i)?.[1] || pid);
      out.push({ name, vid: normHex(String(vid).match(/0x([0-9a-f]+)/i)?.[1] || vid), pid: normHex(String(pid).match(/0x([0-9a-f]+)/i)?.[1] || pid), serial: String(node.serial_num || ''), board });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(tree);
  return out;
}

// 串口名 → 桥芯片族（macOS 命名习惯）。用于「没插板子也能从残留端口名判断驱动装没装」。
const PORT_RULES = [
  // Linux 命名：ttyACM = CDC ACM（原生 USB 免驱），ttyUSB = USB-串口桥（CH340/CP210x 等，需 udev/组权限）
  { re: /^\/dev\/ttyACM\d+$/, chip: 'esp32-native', driver: 'builtin' },
  { re: /^\/dev\/ttyUSB\d+$/, chip: 'ch34x-or-cp210x', driver: 'vendor-vcp' },
  { re: /^\/dev\/(?:cu|tty)\.usbmodem/i, chip: 'esp32-native', driver: 'builtin' },
  { re: /^\/dev\/(?:cu|tty)\.wchusbserial/i, chip: 'ch34x', driver: 'wch-ch34x' },
  { re: /^\/dev\/(?:cu|tty)\.usbserial/i, chip: 'cp210x-or-ftdi', driver: 'vendor-vcp' },
  { re: /^\/dev\/(?:cu|tty)\.SLAB_USBtoUART/i, chip: 'cp210x', driver: 'silabs-cp210x' },
];

/**
 * 把 `ls /dev/cu.*` 的路径列表分类成「可能可刷机的串口」。
 * 只做命名推断——真正是不是 ESP32 还要 probe 到 VID/PID 才能定。
 */
function classifyPorts(paths) {
  const list = Array.isArray(paths) ? paths.map((p) => String(p).trim()).filter(Boolean) : [];
  const serial = [];
  for (const p of list) {
    const rule = PORT_RULES.find((r) => r.re.test(p));
    if (rule) serial.push({ port: p, chip: rule.chip, driver: rule.driver });
  }
  return { serial, others: list.filter((p) => !serial.some((s) => s.port === p)) };
}

/**
 * 汇总一次探测结论（纯函数）：给主进程工具用，也便于测试。
 * @returns {{devices: Array, ports: Array, flashable: Array, needsDriver: Array, notes: string[]}}
 */
function summarizeProbe({ usbTree = null, ports = [], esptool = false } = {}) {
  const devices = usbTree ? parseUsbTree(usbTree) : [];
  const { serial } = classifyPorts(ports);
  const flashable = serial.filter((s) => s.chip !== 'unknown');
  const needsDriver = devices.filter((d) => d.board && d.board.driver !== 'builtin' && d.board.driver !== 'unknown');
  const notes = [];
  if (!devices.length) notes.push('未发现带 VID/PID 的 USB 设备：请确认线是数据线而非充电线，且已插紧。');
  if (devices.length && !serial.length) notes.push('发现了 USB 设备但没有对应串口：多半是驱动未安装，或该设备不是串口类（如纯 HID）。');
  if (needsDriver.length) notes.push(`需安装厂商驱动：${[...new Set(needsDriver.map((d) => d.board.driver))].join(', ')}（需 sudo + 允许系统扩展，本工具不自动安装）。`);
  if (!esptool) notes.push('未检测到 esptool：刷机前需先安装（pip install esptool）。');
  return { devices, ports: serial, flashable, needsDriver, notes };
}

// 主进程是 CJS（main/ 目录统一 module.exports）：这里不能用 ESM export。
module.exports = { matchBoard, parseUsbTree, classifyPorts, summarizeProbe, BOARDS };
