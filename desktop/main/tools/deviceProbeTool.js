// device_probe 的工具实现（2026-10-31）：把 deviceProbe 的纯判定接到真实的系统命令上。
//
// 为什么先写 handler、暂不登记进 BASE_TOOLS：
//   新增 agent 工具要同一次改 6 处（schema / TOOL_HANDLER_NAMES / 超时表 / registry 通道 /
//   TOOL_LEVEL / UI 标签），而 `tool-registration-matrix` 是**双向差集**——少一处就是红一片。
//   本文件把「实现」先做扎实并用注入式 exec 单测，登记那 6 处是纯机械补录。
//
// 纪律：
//   · 只读：本 handler **不写任何东西**，只跑三条只读命令（列 USB、列串口、查 esptool）；
//   · exec 由调用方注入：便于单测（给假输出）与权限控制（走宿主既有 shell 通道）；
//   · 失败不抛：探测失败只体现在 notes 里 —— 探测是「给出信息」，不该因为一条命令失败就中断任务。

const { summarizeProbe } = require('../deviceProbe'); // deviceProbe.js 在 main/ 下，本文件在 main/tools/

/** 各平台的三条只读命令。新增平台只需在这里加一行。 */
const PROBES = {
  darwin: {
    usb: 'system_profiler SPUSBDataType -json',
    ports: 'ls /dev/cu.* 2>/dev/null || true',
    esptool: 'command -v esptool.py || command -v esptool || true',
  },
  linux: {
    // /sys 比 lsusb 更可靠（不依赖 usbutils 安装）
    usb: 'for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && echo "$(cat $d/idVendor) $(cat $d/idProduct) $(cat $d/product 2>/dev/null)"; done',
    ports: 'ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true',
    esptool: 'command -v esptool.py || command -v esptool || true',
  },
  win32: {
    usb: 'powershell -NoProfile -Command "Get-PnpDevice -Class Ports | Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress"',
    ports: 'powershell -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames() -join \\"`n\\""',
    esptool: 'where esptool.py 2>nul || where esptool 2>nul',
  },
};

/** 解析 linux /sys 那三列输出成 USB 树形状（供 summarizeProbe 复用同一条判定链）。 */
function parseLinuxUsb(stdout) {
  const items = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = /^([0-9a-f]{4})\s+([0-9a-f]{4})\s*(.*)$/i.exec(line.trim());
    if (!m) continue;
    items.push({ _name: m[3] || 'USB device', vendor_id: m[1], product_id: m[2] });
  }
  return { SPUSBDataType: items };
}

function parseWinUsb(stdout) {
  // Get-PnpDevice 的输出里没有 VID/PID 字段；从 InstanceId（USB\VID_1A86&PID_7523\...）里抠。
  const items = [];
  let arr = [];
  try { const j = JSON.parse(String(stdout || '[]')); arr = Array.isArray(j) ? j : [j]; } catch {
    // 输出不是 JSON（PowerShell 报错文本 / 老版本格式）⇒ 当作空列表；上层会通过 devices=0 与 notes 体现出来
    arr = [];
  }
  for (const it of arr) {
    const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(String(it?.InstanceId || ''));
    if (!m) continue;
    items.push({ _name: String(it?.FriendlyName || 'USB device'), vendor_id: m[1], product_id: m[2] });
  }
  return { SPUSBDataType: items };
}

/**
 * 执行一次设备探测（只读）。
 * @param {object} p
 * @param {(cmd: string) => Promise<{stdout?: string}>} p.exec 注入的命令执行器
 * @param {string} [p.platform] 默认 process.platform
 * @returns {Promise<{ok: boolean, platform: string, devices: Array, ports: Array, flashable: Array, notes: string[], toolchain: {esptool: boolean}}>}
 */
async function deviceProbeHandler({ exec, platform = process.platform } = {}) {
  const notes = [];
  const p = PROBES[platform];
  if (!p) {
    return { ok: false, platform, devices: [], ports: [], flashable: [], notes: [`暂不支持的平台：${platform}（已支持 darwin / linux / win32）`], toolchain: { esptool: false } };
  }
  if (typeof exec !== 'function') {
    return { ok: false, platform, devices: [], ports: [], flashable: [], notes: ['缺少 exec 注入：探测需要执行只读命令'], toolchain: { esptool: false } };
  }
  const run = async (cmd, what) => {
    try {
      const r = await exec(cmd);
      return String(r?.stdout || '');
    } catch (e) {
      // 单条命令失败不该让整个探测失败：记一条 note 继续（探测的价值在于「尽量说清现状」）
      notes.push(`${what} 命令执行失败：${String(e?.message || e).slice(0, 120)}`);
      return '';
    }
  };

  const usbRaw = await run(p.usb, 'USB 枚举');
  const portsRaw = await run(p.ports, '串口枚举');
  const esptoolRaw = await run(p.esptool, 'esptool 检测');

  let usbTree = null;
  try {
    usbTree = platform === 'linux' ? parseLinuxUsb(usbRaw) : platform === 'win32' ? parseWinUsb(usbRaw) : JSON.parse(usbRaw || '{}');
  } catch (e) {
    notes.push(`USB 输出解析失败（返回可能不是 JSON）：${String(e?.message || e).slice(0, 120)}`);
  }
  const ports = String(portsRaw || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const result = summarizeProbe({ usbTree, ports, esptool: Boolean(String(esptoolRaw || '').trim()) });
  return { ok: true, platform, ...result, notes: [...notes, ...result.notes], toolchain: { esptool: Boolean(String(esptoolRaw || '').trim()) } };
}

module.exports = { deviceProbeHandler, PROBES, parseLinuxUsb, parseWinUsb };
