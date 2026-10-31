// device_probe 的工具实现（2026-10-31）：把 deviceProbe 的纯判定接到真实的系统命令上。
//
// 登记状态（2026-10-31 补齐）：7 环节已全接线——schema/超时/通道映射在 agent-core，
//   通道白名单在 main/engineProcess/registry.js，宿主 handler 在 main/scheduledTools.js
//   （交互/定时/Worker 同源），审批分级在 approval.js（READONLY_TOOLS），
//   UI 标签在 ToolTrace.tsx + 双语 toolTrace.json。
//   权威清单以 test/tool-registration-matrix.test.mjs 为准（它从 BASE_TOOLS ∪ TOOL_HANDLER_NAMES
//   推导驱动集逐环节比对），别只信本注释——注释会漂，门禁不会。
//
// 纪律：
//   · 只读：本 handler **不写任何东西**，只跑五条只读命令（列 USB、列串口、查 esptool、
//     详细串口枚举、驱动加载状态）；
//   · exec 由调用方注入：便于单测（给假输出）与权限控制（走宿主既有 shell 通道）；
//   · 失败不抛：探测失败只体现在 notes 里 —— 探测是「给出信息」，不该因为一条命令失败就中断任务。

const { exec: execCb } = require('child_process');
const { summarizeProbe } = require('../deviceProbe'); // deviceProbe.js 在 main/ 下，本文件在 main/tools/
const { splitPyserialOutput, parsePyserialDetailed, parseLoadedDrivers, assessBridges } = require('../devicePorts');
const {
  EXECUTOR_NAMES, EXECUTOR_PROBE_SENTINEL, parseExecutors, resolveChannels,
} = require('../deviceChannels');

// 「pyserial 可用」的唯一信号是这条 echo：装了 pyserial 但当前 0 个端口，与没装 pyserial，
// 输出**都是空列表**——只看列表长度会把「没装」误判成「没插设备」。
// 解释器顺序不是随便排的：macOS 上系统自带的 `python3`（/usr/bin）通常没有 pyserial，
// 而 anaconda/homebrew 的会有（实测 2026-10-31：本机只有 /opt/anaconda3 有）。
const PYSERIAL_LOOP = (cands) => `for p in ${cands}; do if "$p" -c 'import serial' >/dev/null 2>&1; then echo "INTERP=$p"; "$p" -m serial.tools.list_ports -v 2>&1; exit 0; fi; done; echo 'INTERP='`;

// 驱动加载状态：成功且 grep 无命中 → NO_SERIAL_DRIVERS；命令本身挂掉 → DRIVER_PROBE_FAILED。
// 两者必须分开：把「查失败」当成「没装驱动」会让人白装一次驱动（还得 sudo + 重启）。
const DRIVER_PROBE = (listCmd, pattern) => `out=$(${listCmd} 2>/dev/null); if [ -z "$out" ]; then echo DRIVER_PROBE_FAILED; else printf '%s\\n' "$out" | grep -E -i "${pattern}" || echo NO_SERIAL_DRIVERS; fi`;

// 执行器探测：名单直接由 deviceChannels 的 EXECUTOR_NAMES 生成（**不在 shell 里再抄一遍**），
// 这样新增通道时漏登记会立刻被单测抓到，而不是等运行时发现「这个通道永远 installed=false」。
const EXECUTOR_SCAN = `for c in ${EXECUTOR_NAMES.join(' ')}; do command -v "$c" >/dev/null 2>&1 && echo "HAVE=$c"; done; echo ${EXECUTOR_PROBE_SENTINEL}`;

/** 各平台的只读命令。新增平台只需在这里加一行。 */
const PROBES = {
  darwin: {
    // 实测（2026-10-31，Apple Silicon M4 Pro / macOS 26）：`system_profiler SPUSBDataType -json`
    // 返回 `{"SPUSBDataType":[]}` —— **空数组**，设备全丢。而 `SPUSBHostDataType` 数据完整，
    // 字段名换成 USBDeviceKeyVendorID / USBDeviceKeyProductID / USBDeviceKeySerialNumber。
    // 这意味着「devices 为空」曾经被误读成「没插设备」，实际是枚举源在这个平台上失效。
    usb: 'system_profiler SPUSBHostDataType -json',
    ports: 'ls /dev/cu.* 2>/dev/null || true',
    // esptool 优先、回退 .py：v5 起 `.py` 后缀被官方标记 deprecated，
    // 「未来 major 会移除」⇒ 硬编码 esptool.py 迟早 ENOENT。
    esptool: 'command -v esptool || command -v esptool.py || true',
    serialDetailed: PYSERIAL_LOOP('python3 /opt/anaconda3/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3'),
    // kextstat 在 Apple Silicon 上仍在，但 kmutil 是官方替代且输出同格式；用 kmutil 少一层兼容。
    drivers: DRIVER_PROBE('kmutil showloaded', 'usb\\.cdc|wch|ch34|slab|cp210|ftdi'),
    executors: EXECUTOR_SCAN,
  },
  linux: {
    // /sys 比 lsusb 更可靠（不依赖 usbutils 安装）
    usb: 'for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && echo "$(cat $d/idVendor) $(cat $d/idProduct) $(cat $d/product 2>/dev/null)"; done',
    ports: 'ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true',
    esptool: 'command -v esptool || command -v esptool.py || true',
    serialDetailed: PYSERIAL_LOOP('python3 /usr/bin/python3 /usr/local/bin/python3'),
    // 注意：lsmod 只能说明模块在内存里，不代表设备已绑定 —— 结论以「端口有没有出来」为准。
    drivers: DRIVER_PROBE('lsmod', 'cdc_acm|ch34|cp210|ftdi|wch|usbserial'),
    executors: EXECUTOR_SCAN,
  },
  win32: {
    usb: 'powershell -NoProfile -Command "Get-PnpDevice -Class Ports | Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress"',
    ports: 'powershell -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames() -join \\"`n\\""',
    esptool: 'where esptool 2>nul || where esptool.py 2>nul',
    // serialDetailed / drivers / executors 暂不接线：POSIX 的 for 循环与 $(...) 在 cmd.exe 下语义不同，
    // 未在真机验证过的命令不写进来（宁可少一个信号，也不要给出错的结论）。
    // 代价是 win32 上 installed 恒为 null（未知）而不是 false——这个区别由 deviceChannels 保留，
    // 结论会写成「未探测」而不是「没装」。
  },
};

/**
 * 从 `PROBES[platform].esptool` 的输出里算出**实际可执行的命令名**。
 * 为什么不直接写死 'esptool.py'：那是 v5 起被废弃的入口（官方提示未来 major 移除），
 * 写死会在某天变成 ENOENT，而错误表现是「烧写命令根本起不来」——离根因很远。
 * 取不到返回 ''，调用方据此 fail-fast 说「没装 esptool」，而不是让 execFile 抛一个 ENOENT。
 */
function resolveEsptoolFromPath(stdout) {
  const first = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  const base = first.split(/[\\/]/).pop() || '';
  if (base === 'esptool' || base === 'esptool.exe') return 'esptool';
  if (base === 'esptool.py' || base === 'esptool.py.exe') return 'esptool.py';
  return '';
}

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
      return { out: String(r?.stdout || ''), note: '' };
    } catch (e) {
      // 单条命令失败不该让整个探测失败：记一条 note 继续（探测的价值在于「尽量说清现状」）
      return { out: '', note: `${what} 命令执行失败：${String(e?.message || e).slice(0, 120)}` };
    }
  };

  // 六条命令彼此独立且都是只读 ⇒ 并发跑：最坏情况从「6×10s 串行」降到 10s（工具看门狗 60s 留足余量），
  // 而 notes 仍按规格表的固定顺序拼接、不随完成先后漂——否则测试断言与用户看到的原因顺序都会抖。
  const specs = [
    [p.usb, 'USB 枚举'],
    [p.ports, '串口枚举'],
    [p.esptool, 'esptool 检测'],
    [p.serialDetailed, '串口详细枚举'],
    [p.drivers, '驱动加载状态'],
    [p.executors, '执行器探测'],
  ].filter(([cmd]) => Boolean(cmd));
  const outs = await Promise.all(specs.map(([cmd, what]) => run(cmd, what)));
  const byName = new Map(specs.map(([, what], i) => [what, outs[i]]));
  const get = (what) => (byName.get(what) || {}).out || '';

  let usbTree = null;
  try {
    const usbRaw = get('USB 枚举');
    usbTree = platform === 'linux' ? parseLinuxUsb(usbRaw) : platform === 'win32' ? parseWinUsb(usbRaw) : JSON.parse(usbRaw || '{}');
  } catch (e) {
    notes.push(`USB 输出解析失败（返回可能不是 JSON）：${String(e?.message || e).slice(0, 120)}`);
  }
  const names = String(get('串口枚举') || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const esptool = Boolean(String(get('esptool 检测') || '').trim());
  const result = summarizeProbe({ usbTree, ports: names, esptool });

  // —— L2：桥接驱动层 ——
  // 端口记录优先取 pyserial 的详细输出（带 hwid，能钉住「这条口背后是不是真设备」）；
  // 只有在拿不到详细输出时，才退回 `ls` 的名字列表（此时 real 一律 null = 查不到，不是「不是设备」）。
  const { interpreter, body, available: pyserial } = splitPyserialOutput(get('串口详细枚举'));
  const detailed = parsePyserialDetailed(body);
  const portRecords = detailed.length ? detailed : names.map((port) => ({ port, real: null }));
  const drivers = p.drivers ? parseLoadedDrivers(get('驱动加载状态')) : null;
  const bridge = assessBridges({ devices: result.devices, ports: portRecords, drivers });

  // —— L3：协议识别 / 刷写通道决策 ——
  // 输入是 L2 的结论（kind + ports + verdict），输出是「该用哪把钥匙 + 有没有这把钥匙 + 缺什么」。
  // executors 未探测（这个平台没接线）时传 null：installed 一律 null（未知），不能写成 false（没装）。
  const executors = p.executors ? parseExecutors(get('执行器探测')) : null;
  const chan = resolveChannels({ bridges: bridge.bridges, executors });

  const allNotes = [...outs.map((o) => o.note).filter(Boolean), ...result.notes, ...bridge.notes, ...chan.notes];
  if (p.serialDetailed && !pyserial) {
    allNotes.push('未找到带 pyserial 的 python3：串口身份只能按命名推断（装 pyserial 后可钉住 VID:PID）');
  }
  if (!p.serialDetailed) {
    allNotes.push(`平台 ${platform} 暂未接线串口详细枚举：端口身份按命名推断，VID:PID 需另行确认`);
  }
  return {
    ok: true,
    platform,
    ...result,
    bridges: bridge.bridges,
    portDetails: bridge.portIndex,
    channels: chan.targets,
    primaryChannel: chan.primary,
    interpreter,
    drivers: drivers ? { ok: drivers.ok, families: drivers.families } : null,
    executors: executors ? { ok: executors.ok, have: executors.have } : null,
    notes: allNotes,
    toolchain: { esptool, pyserial },
  };
}

// ── 真实执行器（2026-10-31 接线）──────────────────────────────────────────────
// 为什么用 child_process.exec（shell 字符串）而不是走 main/tools/exec.js 的沙箱执行器：
//   · exec.js 是**argv 化**的（execFile），而这里几条命令是 shell 复合式
//     （`ls /dev/cu.* 2>/dev/null || true`、`command -v a || command -v b`、/sys 下的 for 循环），
//     argv 化会把这些语义拆没；改写成等价 argv 要给三个平台各写一套解析，收益为零。
//   · 注入面为零：命令串全部来自上面 PROBES 里的常量，**不含任何模型输入**（schema 无参数、
//     handler 也不读 args）。这与「模型给命令走 toolShell」是两回事，别把两者混为一谈。
//   · 单条命令 10s 自断：插着一堆 USB 设备时 `system_profiler` 可能很慢，探测不该拖住一轮对话；
//     引擎看门狗 60s（agent-core 的 TOOL_TIMEOUT_OVERRIDES.device_probe）留一倍余量。
const PROBE_CMD_TIMEOUT_MS = 10000;
const PROBE_CMD_MAX_BUFFER = 2 * 1024 * 1024;

function defaultExec(cmd) {
  return new Promise((resolve, reject) => {
    execCb(cmd, { timeout: PROBE_CMD_TIMEOUT_MS, maxBuffer: PROBE_CMD_MAX_BUFFER, windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve({ stdout });
    });
  });
}

/** 宿主侧入口：用真实命令跑一次探测（main/scheduledTools.js 的 deviceProbe 通道调它）。 */
function probeDevice({ platform = process.platform } = {}) {
  return deviceProbeHandler({ exec: defaultExec, platform });
}

module.exports = {
  deviceProbeHandler, probeDevice, defaultExec, PROBES, parseLinuxUsb, parseWinUsb, resolveEsptoolFromPath,
};
