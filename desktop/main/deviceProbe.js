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
// 依据：Espressif 原生 USB CDC（303a）免驱；CH340/CP210x/FTDI 是常见 USB-串口桥，需厂商 kext；
// DFU/UF2/调试探针**本来就没有串口**——把它们标成 serial 会让人对着 DFU 模式去装串口驱动。
//
// kind 字段是 L2 判定的分水岭（见 devicePorts.js）：
//   'serial'        应该有串口；没有 = 异常，要看驱动
//   'hub'           集线器，忽略
//   'dfu' / 'uf2' / 'debug-probe' / 'fastboot'  非串口通道，没有串口是**正常**的
const BOARDS = [
  // —— 串口类：原生 USB（免驱，ESP32-S3/C3/C6、Pico、Teensy 常见）——
  { vid: '303a', pid: null, kind: 'serial', chip: 'esp32-native', name: 'Espressif 原生 USB（S3/C3/C6 等）', driver: 'builtin', note: '免驱：走 USB CDC，macOS 直接出现 cu.usbmodem*' },
  { vid: '2e8a', pid: '000a', kind: 'serial', chip: 'rp2040-cdc', name: 'Raspberry Pi Pico（运行态 CDC）', driver: 'builtin', note: '免驱；只有固件启用 USB CDC 时才出现串口' },
  { vid: '16c0', pid: '0483', kind: 'serial', chip: 'teensy-cdc', name: 'Teensy / 自定义 CDC-ACM', driver: 'builtin', note: '免驱' },
  // —— 串口类：USB-串口桥（需厂商驱动）——
  { vid: '1a86', pid: '7523', kind: 'serial', chip: 'ch340', name: 'CH340/CH341（多数国产 ESP32 开发板）', driver: 'wch-ch34x', note: '需装 WCH CH34x 驱动，串口名形如 cu.wchusbserial*' },
  // 实测（2026-10-31）：本机板载第二路是 0x1a86:0x7522，产品串只写 "USB Serial"，
  // 与 7523 同属 CH34x 族但 PID 不同 —— 不登记就会被判成「未识别的 USB 设备」。
  { vid: '1a86', pid: '7522', kind: 'serial', chip: 'ch34x-family', name: 'WCH USB 串口（"USB Serial"，CH340/CH343 族）', driver: 'wch-ch34x', note: '需装 WCH CH34x 驱动（本机实测：没装时一个串口都不出现）' },
  { vid: '1a86', pid: '55d4', kind: 'serial', chip: 'ch9102', name: 'CH9102（CH340 后继，部分新板）', driver: 'wch-ch34x', note: '同 CH34x 驱动族' },
  { vid: '10c4', pid: 'ea60', kind: 'serial', chip: 'cp210x', name: 'CP2102/CP2104（NodeMCU 常见）', driver: 'silabs-cp210x', note: '需装 Silicon Labs CP210x VCP 驱动' },
  { vid: '10c4', pid: 'ea70', kind: 'serial', chip: 'cp210x', name: 'CP2105/CP2108（双/四串口版）', driver: 'silabs-cp210x', note: '同 CP210x 驱动族' },
  { vid: '0403', pid: '6001', kind: 'serial', chip: 'ftdi', name: 'FTDI FT232', driver: 'ftdi-vcp', note: 'macOS 10.15+ 多数已内置' },
  // —— 非串口类：没有串口是正常的，别当缺驱动 ——
  { vid: '1a86', pid: '8091', kind: 'hub', chip: 'hub', name: 'WCH USB HUB', driver: 'builtin', note: '集线器：板子可能挂在它下面，但它自己不是串口' },
  { vid: '05e3', pid: '0610', kind: 'hub', chip: 'hub', name: 'Genesys Logic USB2.0 HUB', driver: 'builtin', note: '集线器' },
  { vid: '05e3', pid: '0620', kind: 'hub', chip: 'hub', name: 'Genesys Logic USB3.0 HUB', driver: 'builtin', note: '集线器' },
  { vid: '0483', pid: 'df11', kind: 'dfu', chip: 'stm32-dfu', name: 'STM32 系统 DFU 模式', driver: 'builtin', note: '进 BOOT0 后才出现；无串口，走 dfu-util（L3 协议层）' },
  { vid: '2e8a', pid: '0003', kind: 'uf2', chip: 'rp2040-bootsel', name: 'RP2040 BOOTSEL / UF2', driver: 'builtin', note: '枚举成 U 盘而非串口；烧写走拷贝 .uf2（L4）' },
  // Android bootloader（2026-10-31）：18d1 是 Google 的厂商号，4ee0 是它自报的 fastboot 接口。
  // **只登记这一条**：其它厂商（小米/三星/OPPO…）在 bootloader 模式下用各自的 VID:PID，
  // 我没有可核实的样本，凭印象编一张表比不登记更糟——认错设备就是把分区写到不该写的地方。
  // 未登记时仍落到 kind='unknown'，用户看到的是「不在板卡表内」，而不是一个假的「大概是安卓」。
  { vid: '18d1', pid: '4ee0', kind: 'fastboot', chip: 'android-fastboot', name: 'Android bootloader（fastboot 模式）', driver: 'builtin', note: '无串口；刷分区走 fastboot（L4，须 OEM 解锁 + 显式 channel=fastboot）' },
  { vid: '0483', pid: '3748', kind: 'debug-probe', chip: 'stlink', name: 'ST-LINK V2', driver: 'builtin', note: '调试探针：无串口，走 openocd（L3）' },
  { vid: '0483', pid: '374b', kind: 'debug-probe', chip: 'stlink', name: 'ST-LINK V2-1', driver: 'builtin', note: '调试探针' },
  { vid: '0483', pid: '3752', kind: 'debug-probe', chip: 'stlink', name: 'ST-LINK V3', driver: 'builtin', note: '调试探针' },
  { vid: '1366', pid: '0101', kind: 'debug-probe', chip: 'jlink', name: 'SEGGER J-Link', driver: 'builtin', note: '调试探针' },
  { vid: '0d28', pid: '0204', kind: 'debug-probe', chip: 'daplink', name: 'ARM DAPLink / CMSIS-DAP', driver: 'builtin', note: '调试探针' },
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
  return wildcard ? { ...wildcard } : { vid: v, pid: p, kind: 'unknown', chip: 'unknown', name: '未识别的 USB 设备', driver: 'unknown', note: '不在板卡表内，需人工确认' };
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
    // 两套字段名都要认，因为 macOS 两个数据类给的键不同（实测 2026-10-31）：
    //   SPUSBDataType     → vendor_id / product_id / serial_num
    //   SPUSBHostDataType → USBDeviceKeyVendorID / USBDeviceKeyProductID / USBDeviceKeySerialNumber
    // 只认一套的后果是「换了枚举源就 devices 全空」，而这看起来像「没插设备」。
    const vid = node.vendor_id ?? node.USBDeviceKeyVendorID;
    const pid = node.product_id ?? node.USBDeviceKeyProductID;
    if (vid && pid) {
      const board = matchBoard(String(vid).match(/0x([0-9a-f]+)/i)?.[1] || vid, String(pid).match(/0x([0-9a-f]+)/i)?.[1] || pid);
      const serial = node.serial_num ?? node.USBDeviceKeySerialNumber;
      out.push({ name, vid: normHex(String(vid).match(/0x([0-9a-f]+)/i)?.[1] || vid), pid: normHex(String(pid).match(/0x([0-9a-f]+)/i)?.[1] || pid), serial: String(serial || ''), board });
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
