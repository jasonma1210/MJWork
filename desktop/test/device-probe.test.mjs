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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
