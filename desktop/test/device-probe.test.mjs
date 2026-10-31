#!/usr/bin/env node
// USB 设备识别回归（2026-10-31）：插了什么板 / 什么芯片 / 哪个串口 / 要不要驱动。
//
// 为什么守这几条：
//   ① `system_profiler` 的 JSON 把设备数组挂在 SPUSBDataType 键下，子设备又可能是 _items——
//      只认 _items 会得到空列表（实测踩到）；用真实形状的样本锁住「通用下探」。
//   ② 蓝牙耳机等非串口设备的 /dev/cu.* 不能被当成可刷机串口——误判会让人对着耳机刷固件。
//   ③ 板卡表必须能区分「免驱（原生 USB）」与「需厂商 kext」，这决定要不要 sudo。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// main/ 是 CJS：用具名 import 会被 cjs-module-lexer 判定失败，这里显式 require。
const { matchBoard, parseUsbTree, classifyPorts, summarizeProbe } = require('../main/deviceProbe.js');
const { partitionCandidates, buildFlashPlan, approvalCard } = require('../main/deviceFlash.js');
const { deviceProbeHandler, parseLinuxUsb, parseWinUsb } = require('../main/tools/deviceProbeTool.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 真实形状：顶层键 SPUSBDataType → 数组
const TREE = {
  SPUSBDataType: [
    { _name: 'USB2.0-Serial', vendor_id: '0x1a86', product_id: '0x7523' },
    { _name: 'USB JTAG/serial debug unit', vendor_id: '0x303a', product_id: '0x1001' },
    { _name: 'Some Hub', vendor_id: '0x05e3', product_id: '0x0610', _items: [{ _name: 'Nested CH340', vendor_id: '0x1a86', product_id: '0x7523' }] },
  ],
};

check('板卡表：CH340 / 原生 USB / 未识别 三类能分开',
  matchBoard('0x1a86', '0x7523').chip === 'ch340'
  && matchBoard('303a', '1001').chip === 'esp32-native'
  && matchBoard('ffff', '0001').chip === 'unknown');
check('板卡表：区分「免驱」与「需厂商 kext」（决定要不要 sudo）',
  matchBoard('303a', '1001').driver === 'builtin' && matchBoard('1a86', '7523').driver !== 'builtin');

const devices = parseUsbTree(TREE);
check('解析：顶层数组（SPUSBDataType 键下）也能取到设备（只认 _items 会得到空列表）',
  devices.length === 4, `devices=${devices.length}`);
check('解析：嵌套 _items 里的设备不会漏（Hub 下的 CH340）',
  devices.filter((d) => d.board.chip === 'ch340').length === 2);

const { serial, others } = classifyPorts(['/dev/cu.wchusbserial110', '/dev/cu.usbmodem1101', '/dev/cu.QCYMeloBudsN70', '/dev/tty.usbserial-1']);
check('串口分类：wchusbserial / usbmodem 认作可刷机，耳机不认',
  serial.length === 3 && others.includes('/dev/cu.QCYMeloBudsN70'), `serial=${serial.length}`);

const r = summarizeProbe({ usbTree: TREE, ports: ['/dev/cu.wchusbserial110', '/dev/cu.usbmodem1101'], esptool: true });
check('汇总：需驱动提示指向 CH34x（且说明不自动安装）',
  r.needsDriver.length >= 1 && r.notes.some((n) => n.includes('ch34x') || n.includes('不自动安装')),
  JSON.stringify(r.notes));
check('汇总：没有 esptool 时给出明确提示（刷机前必装）',
  summarizeProbe({ usbTree: TREE, ports: [], esptool: false }).notes.some((n) => n.includes('esptool')));
check('汇总：什么都没插时提示「数据线 vs 充电线」（最常见的排查点）',
  summarizeProbe({ usbTree: { SPUSBDataType: [] }, ports: [], esptool: true }).notes.some((n) => n.includes('数据线')));

// ── 烧写层（2026-10-31）：参数由工具算，模型只能选 ──
{
  const disks = [
    { id: 'disk0', sizeBytes: 500 * 1024 ** 3, mediaName: 'APPLE SSD', mountpoints: ['/'], internal: true },
    { id: 'disk4', sizeBytes: 32 * 1024 ** 3, mediaName: 'SanDisk Ultra', mountpoints: [], removable: true },
    { id: 'disk5', sizeBytes: 8 * 1024 ** 3, mediaName: 'NO NAME', mountpoints: ['/Volumes/UNTITLED'], removable: true },
    { id: 'disk6', sizeBytes: 200 * 1024 ** 2, mediaName: 'Tiny', mountpoints: [], removable: true },
  ];
  const { candidates, rejected } = partitionCandidates(disks);
  check('烧盘候选：系统盘（挂着 /）与内置盘一律排除',
    !candidates.some((c) => c.id === 'disk0') && rejected.some((r) => r.id === 'disk0' && r.why.includes('系统盘')),
    `candidates=${candidates.map((c) => c.id).join(',')}`);
  check('烧盘候选：可移动 SD 卡进入候选（含已挂载 /Volumes 的卡）',
    candidates.some((c) => c.id === 'disk4') && candidates.some((c) => c.id === 'disk5'));
  check('烧盘候选：过小的盘被排除并说明原因（避免把 200MB 的分区当卡烧）',
    rejected.some((r) => r.id === 'disk6' && r.why.includes('容量过小')));

  const plan = buildFlashPlan({ port: '/dev/cu.wchusbserial110', firmware: '/tmp/fw.bin', chip: 'esp32s3' });
  check('刷机参数：按芯片装配（esp32s3 用 921600 且带 --chip/--port/write_flash）',
    plan.ok && plan.argv.includes('esp32s3') && plan.argv.includes('921600') && plan.argv.includes('write_flash'),
    JSON.stringify(plan.argv.slice(0, 6)));
  check('刷机参数：缺串口/固件直接拒绝（不许模型自己拼设备名）',
    buildFlashPlan({ firmware: '/tmp/fw.bin' }).ok === false && buildFlashPlan({ port: '/dev/cu.x' }).ok === false);
  check('刷机参数：未登记芯片不猜，走默认并明确告警',
    buildFlashPlan({ port: '/dev/cu.x', firmware: '/tmp/a.bin', chip: 'esp32p4' }).warnings.some((w) => w.includes('未登记芯片')));

  const card = approvalCard({ action: '烧写 SD 镜像', target: 'disk4（SanDisk Ultra · 32GB）', impact: '整盘覆盖', consequence: '盘上原有数据不可恢复', rollback: '无（需重新制作镜像）' });
  check('审批卡：不可逆动作标记为 never 档（每次都要弹）', card.level === 'never' && card.reversible === false);
  check('审批卡：缺回滚说明直接抛错（不允许出现无回滚的不可逆卡）',
    (() => { try { approvalCard({ action: 'a', target: 't', impact: 'i', consequence: 'c' }); return false; } catch (e) { return String(e.message).includes('rollback'); } })());
}

// ── probe handler（2026-10-31）：注入式 exec，真命令形状已覆盖 ──
{
  const darwinExec = async (cmd) => {
    if (cmd.includes('SPUSBDataType')) return { stdout: JSON.stringify({ SPUSBDataType: [{ _name: 'USB2.0-Serial', vendor_id: '0x1a86', product_id: '0x7523' }] }) };
    if (cmd.startsWith('ls /dev/cu')) return { stdout: '/dev/cu.wchusbserial110\n/dev/cu.QCYMeloBudsN70\n' };
    if (cmd.startsWith('command -v esptool')) return { stdout: '/opt/anaconda3/bin/esptool.py\n' };
    return { stdout: '' };
  };
  const r = await deviceProbeHandler({ exec: darwinExec, platform: 'darwin' });
  check('probe(darwin)：认出 CH340 板 + 串口 + esptool 已装',
    r.ok && r.devices.some((d) => d.board.chip === 'ch340') && r.flashable.length === 1 && r.toolchain.esptool === true,
    `devices=${r.devices.length} flashable=${r.flashable.length}`);

  const linuxExec = async (cmd) => {
    if (cmd.includes('/sys/bus/usb')) return { stdout: '1a86 7523 USB2.0-Serial\n303a 1001 USB JTAG\n' };
    if (cmd.startsWith('ls /dev/ttyUSB')) return { stdout: '/dev/ttyUSB0\n/dev/ttyACM1\n' };
    return { stdout: '' };
  };
  const rl = await deviceProbeHandler({ exec: linuxExec, platform: 'linux' });
  check('probe(linux)：/sys 三列输出能解析成两块板（CH340 + 原生 USB）',
    rl.ok && rl.devices.length === 2 && rl.flashable.length >= 1, `devices=${rl.devices.length}`);

  const rw = await deviceProbeHandler({
    exec: async () => ({ stdout: JSON.stringify([{ FriendlyName: 'USB-SERIAL CH340 (COM3)', InstanceId: 'USB\\VID_1A86&PID_7523\\5&1' }]) }),
    platform: 'win32',
  });
  check('probe(win32)：从 InstanceId 抠出 VID/PID 并认出 CH340',
    rw.ok && rw.devices.some((d) => d.board.chip === 'ch340'), `devices=${rw.devices.length}`);

  const rFail = await deviceProbeHandler({ exec: async () => { throw new Error('permission denied'); }, platform: 'darwin' });
  check('probe：单条命令失败不抛，变成 notes 里的可读原因',
    rFail.ok === true && rFail.notes.some((n) => n.includes('失败')), JSON.stringify(rFail.notes.slice(0, 2)));

  check('probe：不支持的平台明确拒绝（不假装能探测）',
    (await deviceProbeHandler({ exec: async () => ({ stdout: '' }), platform: 'aix' })).ok === false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
