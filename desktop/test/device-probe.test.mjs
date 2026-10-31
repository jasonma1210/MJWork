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
const {
  partitionCandidates, buildFlashPlan, buildBackupPlan, approvalCard, planDigest, checkSegmentsFit,
  parseFlashIdInfo, parseVidPid, parseSize, resolveImageFormat, esptoolFormatCheck,
  parseHandshake, chipKeyOf, HANDSHAKE_VERDICTS,
} = require('../main/deviceFlash.js');
const { parseDiskutilListText } = require('../main/diskList.js');
const { deviceProbeHandler, parseLinuxUsb, parseWinUsb, resolveEsptoolFromPath, PROBES } = require('../main/tools/deviceProbeTool.js');
const { deviceFlashHandler, inspectSegments } = require('../main/tools/deviceFlashTool.js');
const {
  parseHwid, splitPyserialOutput, parsePyserialDetailed, parseLoadedDrivers, assessBridges,
  NO_DRIVER_SENTINEL, DRIVER_PROBE_FAILED,
} = require('../main/devicePorts.js');
const {
  CHANNELS, EXECUTOR_NAMES, UNASSIGNED_EXECUTORS, EXECUTOR_PROBE_SENTINEL, parseExecutors, resolveChannels,
} = require('../main/deviceChannels.js');
const {
  parseUf2, isUf2Volume, pickUf2Volume, buildUf2Plan, uf2PlanDigest, UF2_VOLUME_MARKER,
} = require('../main/deviceUf2.js');
const { uf2ChannelHandler, isAllowedVolumePath } = require('../main/tools/deviceUf2Tool.js');
const {
  parseDfuList, pickTarget, pickAlt, parseDfuFlash, resolveFlashRoute, buildDfuPlan,
  dfuPlanDigest, normalizeAddr, DFU_FLASH_VERDICTS,
} = require('../main/deviceDfu.js');
const { dfuChannelHandler, dfuList } = require('../main/tools/deviceDfuTool.js');

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
    if (cmd.includes('SPUSB')) return { stdout: JSON.stringify({ SPUSBDataType: [{ _name: 'USB2.0-Serial', vendor_id: '0x1a86', product_id: '0x7523' }] }) };
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

// ── 虚拟盘判据 + 摘要 + 枚举解析 + 三档 handler（2026-10-31 烧写接线）──
// 这一段守的是「保护策略真的在，而不是写在注释里」。每个 check 对应一条可被单独摘掉的机制。
{
  // ① virtual 判据：真机上 disk4 是 18.4GB 的 Simulator 磁盘映像——internal=false、
  //    容量 >1GB、不挂 `/` ⇒ 旧三条判据全放行。这条补的是「它不是物理介质」。
  const withVirtual = partitionCandidates([
    { id: 'disk4', sizeBytes: 18.4e9, mediaName: 'Disk Image', internal: false, virtual: true },
    { id: 'disk8', sizeBytes: 64e9, mediaName: 'SanDisk Ultra', removable: true },
  ]);
  check('烧盘候选：虚拟盘（合成容器/磁盘映像）被排除并说明原因',
    !withVirtual.candidates.some((c) => c.id === 'disk4')
    && withVirtual.rejected.some((r) => r.id === 'disk4' && r.why.includes('虚拟盘')));
  // 正样本（反向验证）：没有 virtual 字段的老调用方行为不变——加严不得误伤既有路径
  check('烧盘候选：不带 virtual 字段的样本仍按原判据进入候选（加严不误伤）',
    withVirtual.candidates.some((c) => c.id === 'disk8'));

  // ② 摘要：同参数稳定、换目标必变。它锁的是「人确认过的参数 == 实际执行的参数」。
  const base = { port: '/dev/cu.wchusbserial110', firmware: '/tmp/fw.bin', chip: 'esp32s3',
    argv: buildFlashPlan({ port: '/dev/cu.wchusbserial110', firmware: '/tmp/fw.bin', chip: 'esp32s3' }).argv };
  check('plan_digest：同参数同摘要（可复算）', planDigest(base) === planDigest({ ...base }));
  check('plan_digest：换串口即变（确认后偷偷改设备名会被拒）',
    planDigest(base) !== planDigest({ ...base, port: '/dev/cu.usbmodem1101' }));
  check('plan_digest：换固件/芯片即变',
    planDigest(base) !== planDigest({ ...base, firmware: '/tmp/other.bin' })
    && planDigest(base) !== planDigest({ ...base, chip: 'esp32' }));

  // ③ 枚举解析：样本是 macOS 真机输出（四种介质类型齐全）
  const SAMPLE = [
    '/dev/disk0 (internal, physical):',
    '   #:                       TYPE NAME                    SIZE       IDENTIFIER',
    '   0:      GUID_partition_scheme                        *4.0 TB     disk0',
    '   1:             Apple_APFS_ISC Container disk1         524.3 MB   disk0s1',
    '',
    '/dev/disk3 (synthesized):',
    '   0:      APFS Container Scheme -                      +4.0 TB     disk3',
    '                                 Physical Store disk0s2',
    '',
    '/dev/disk4 (disk image):',
    '   0:      GUID_partition_scheme                        +18.4 GB    disk4',
    '',
    '/dev/disk8 (external, physical):',
    '   0:      FDisk_partition_scheme                        *64.0 GB    disk8',
    '',
  ].join('\n');
  const parsed = parseDiskutilListText(SAMPLE);
  check('枚举解析：四种介质类型都能识别成整盘（分区行不冒充整盘）',
    parsed.length === 4 && parsed.map((d) => d.id).join(',') === 'disk0,disk3,disk4,disk8',
    `got=${parsed.map((d) => d.id).join(',')}`);
  check('枚举解析：内置盘 internal=true / 虚拟盘 virtual=true / 外接物理盘两者皆 false',
    parsed[0].internal === true && parsed[0].virtual === false
    && parsed[1].virtual === true && parsed[2].virtual === true
    && parsed[3].internal === false && parsed[3].virtual === false);
  check('枚举解析：容量按十进制解析（4.0 TB → 4e12，与 diskutil 显示口径一致）',
    parsed[0].sizeBytes === 4e12 && parsed[3].sizeBytes === 64e9,
    `disk0=${parsed[0].sizeBytes} disk8=${parsed[3].sizeBytes}`);

  // ④ 三档 handler：注入 exec / run / stat，全程不碰真设备
  const fakeExec = async (cmd) => {
    if (cmd === 'diskutil list') return { stdout: SAMPLE };
    if (cmd.startsWith('ls /dev/cu')) return { stdout: '/dev/cu.wchusbserial110\n' };
    if (cmd.includes('command -v esptool')) return { stdout: '/usr/local/bin/esptool\n' };
    return { stdout: '' };
  };
  const statOk = () => ({ isFile: () => true, size: 1024 });
  // calls 记全部 run（含 flash_id 预检）；writeCalls 只记真正写入的那次——
  // 「是否执行过写入」必须与「是否跑过预检」分开数，否则断言会被预检调用干扰。
  const calls = [];
  const writeCalls = [];
  const fakeRun = async (argv) => {
    calls.push(argv);
    if (argv.includes('flash_id')) {
      return { code: 0, stdout: 'Chip is ESP32-S3 (revision v0.2)\nDetected flash size: 8MB', stderr: '' };
    }
    writeCalls.push(argv);
    return { code: 0, stdout: 'Hash of data verified.', stderr: '' };
  };

  const listed = await deviceFlashHandler({ action: 'list_targets' }, { exec: fakeExec, run: fakeRun, stat: statOk, platform: 'darwin' });
  check('list_targets：只把外接物理盘列为候选，虚拟盘/内置盘进 rejected',
    listed.ok && listed.disks.candidates.length === 1 && listed.disks.candidates[0].id === 'disk8',
    `candidates=${listed.disks.candidates.map((c) => c.id).join(',')}`);
  check('list_targets：不给串口就明确提示，不静默返回空', listed.ports.includes('/dev/cu.wchusbserial110'));

  const planned = await deviceFlashHandler(
    { action: 'plan', port: '/dev/cu.wchusbserial110', firmware: '/tmp/fw.bin', chip: 'esp32s3' },
    { exec: fakeExec, run: fakeRun, stat: statOk, platform: 'darwin' });
  check('plan：返回装配好的 argv + 摘要 + 审批卡，且**不执行**',
    planned.ok && planned.argv.includes('write_flash') && planned.plan_digest && planned.card.level === 'never'
    && writeCalls.length === 0, `argv=${planned.argv && planned.argv.join(' ')}`);

  calls.length = 0; writeCalls.length = 0; // 每个用例独立计数：否则前一条失败会污染后一条的「是否执行过」判定
  const noDigest = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.wchusbserial110', firmware: '/tmp/fw.bin' },
    { exec: fakeExec, run: fakeRun, stat: statOk, platform: 'darwin' });
  check('flash：缺 plan_digest 直接拒绝（不许跳过 preview 直接烧）',
    noDigest.ok === false && noDigest.error.includes('plan_digest') && writeCalls.length === 0);

  calls.length = 0; writeCalls.length = 0;
  const wrongDigest = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.wchusbserial110', firmware: '/tmp/fw.bin', plan_digest: 'deadbeefdeadbeef' },
    { exec: fakeExec, run: fakeRun, stat: statOk, platform: 'darwin' });
  check('flash：摘要不匹配拒绝执行（参数在确认后被改）',
    wrongDigest.ok === false && wrongDigest.error.includes('不匹配') && writeCalls.length === 0);

  // 先对假串口 plan 拿到合法 digest，再验证 flash 是被**白名单**拦住（而不是被 digest 拦住——
  // 那是另一道锁，混在一起就测不出白名单是否真的存在）
  const badPlan = await deviceFlashHandler(
    { action: 'plan', port: '/dev/cu.invented', firmware: '/tmp/fw.bin' },
    { exec: fakeExec, run: fakeRun, stat: statOk, platform: 'darwin' });
  check('plan：串口不在枚举时告警（不拒绝——板子可能还没插）',
    badPlan.ok === true && badPlan.warnings.some((w) => w.includes('不在当前枚举')));

  calls.length = 0; writeCalls.length = 0;
  const badPort = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.invented', firmware: '/tmp/fw.bin', plan_digest: badPlan.plan_digest },
    { exec: fakeExec, run: fakeRun, stat: statOk, platform: 'darwin' });
  check('flash：串口不在实时枚举里拒绝（防模型编设备名）',
    badPort.ok === false && badPort.error.includes('不在当前枚举') && writeCalls.length === 0);

  const noFw = await deviceFlashHandler(
    { action: 'plan', port: '/dev/cu.wchusbserial110', firmware: '/tmp/missing.bin' },
    { exec: fakeExec, run: fakeRun, platform: 'darwin',
      stat: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } });
  check('plan：固件不存在直接拒绝（否则 esptool 会在板子上跑到一半才报错）',
    noFw.ok === false && noFw.error.includes('不存在'));

  calls.length = 0; writeCalls.length = 0;
  const okRun = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.wchusbserial110', firmware: '/tmp/fw.bin', chip: 'esp32s3', plan_digest: planned.plan_digest },
    { exec: fakeExec, run: fakeRun, stat: statOk, platform: 'darwin' });
  check('flash：摘要与白名单都通过才真正执行，argv 与 plan 一致',
    okRun.ok === true && writeCalls.length === 1 && writeCalls[0].join(' ') === planned.argv.join(' '),
    writeCalls[0] && writeCalls[0].join(' '));
  check('flash：返回体带审批卡（影响面/后果/回滚）与失败提示位',
    okRun.card.rollback.length > 0 && okRun.exitCode === 0 && okRun.hint === null);

  // ⑤ 审批分级：这是整条链路的地基——分级错了，上面六道保护全白做
  const approval = require('../main/approval.js');
  const modes = ['never', 'auto-safe', 'on-request', 'always'];
  check('审批：action=flash 在**所有**档位都弹卡且级别 L1（含 never 档）',
    modes.every((m) => {
      const r = approval.needsApproval({ tool: 'device_flash', args: { action: 'flash' }, approvalMode: m });
      return r.need === true && r.level === 'L1';
    }));
  check('审批：action 缺省/未知也判 L1（漏传参数不会变成免审批执行）',
    approval.toolLevel('device_flash', {}) === 'L1' && approval.toolLevel('device_flash', { action: 'wat' }) === 'L1');
  check('审批：list_targets / plan 不进审批面（只读与纯计算不该打扰用户）',
    approval.toolLevel('device_flash', { action: 'list_targets' }) === null
    && approval.toolLevel('device_flash', { action: 'plan' }) === null);
  check('审批：device_flash 不可记忆（审批 UI 不给「始终允许」按钮）',
    approval.isRememberable('device_flash') === false);
  check('审批：卡面目标含「往哪个口烧哪个文件」（用户唯一能核对的信息）',
    approval.approvalTarget('device_flash', { port: '/dev/cu.a', firmware: '/tmp/f.bin' }) === '/dev/cu.a ← /tmp/f.bin');

  // ── 多段烧写 + 容量预检（阶段 1）────────────────────────────────────────────
  // 背景：真实 ESP-IDF 工程是 4 段，而旧实现只能烧「单文件单偏移」——接不了真实产物。
  // 预检的意义：「偏移超出实际容量」在 esptool 侧表现为「烧到一半成功」，
  // 最终症状是「烧录成功但不开机」，是最难排查的一类故障。
  const multi = buildFlashPlan({
    port: '/dev/cu.usbmodem1301', chip: 'esp32s3',
    segments: [
      { offset: '0x0', file: '/b/bootloader.bin' },
      { offset: '0x8000', file: '/b/partition-table.bin' },
      { offset: '0x20000', file: '/b/app.bin' },
    ],
  });
  check('多段：装配成 write_flash 后按「偏移 文件」成对展开',
    multi.ok && multi.argv.slice(-6).join(' ') === '0x0 /b/bootloader.bin 0x8000 /b/partition-table.bin 0x20000 /b/app.bin',
    multi.argv.slice(-6).join(' '));
  const singleSeg = buildFlashPlan({ port: '/dev/cu.x', firmware: '/tmp/fw.bin' });
  check('多段：单段调用逐字保持旧行为（0x0 + 文件）',
    singleSeg.ok && singleSeg.argv.slice(-2).join(' ') === '0x0 /tmp/fw.bin');
  check('多段：偏移不是十六进制直接拒绝',
    buildFlashPlan({ port: '/dev/cu.x', segments: [{ offset: '0xZZ', file: '/a.bin' }] }).ok === false);
  check('多段：某段缺 file 直接拒绝',
    buildFlashPlan({ port: '/dev/cu.x', segments: [{ offset: '0x0', file: '' }] }).ok === false);

  const i1 = parseFlashIdInfo('Chip is ESP32-S3 (revision v0.2)\nDetected flash size: 8MB');
  const i2 = parseFlashIdInfo('Chip is ESP32 (revision 3)\nFlash size: 4MB');
  check('预检解析：新旧两种 flash size 写法都能取到容量',
    i1.flashSizeBytes === 8 * 1024 ** 2 && i2.flashSizeBytes === 4 * 1024 ** 2, `${i1.flashSizeBytes}/${i2.flashSizeBytes}`);
  check('预检解析：芯片名能取到', i1.chip.includes('ESP32-S3'), i1.chip);
  check('预检解析：输出里没有容量时返回 0（不猜数字）', parseFlashIdInfo('Connecting...').flashSizeBytes === 0);
  // 真机原始输出（2026-10-31，esptool v5.6.0 + ESP32-S3 DevKit，逐字抄下来的）：
  // v5 用 `Chip type:` + 一堆对齐空格，与文档里的 `Chip is` 不同；只认后者会静默拿到空串。
  const REAL_FLASH_ID = `Connected to ESP32-S3 on /dev/cu.usbmodem1301:
Chip type:          ESP32-S3 (QFN56) (revision v0.2)
Features:           Wi-Fi, BT 5 (LE), Dual Core + LP Core, 240MHz, Embedded PSRAM 8MB (AP_3v3)
Crystal frequency:  40MHz
USB mode:           USB-Serial/JTAG
MAC:                d0:cf:13:06:dc:74

Uploading stub flasher...
Flash Memory Information:
=========================
Manufacturer: 46
Device: 4018
Detected flash size: 16MB
Flash type set in eFuse: quad (4 data lines)`;
  const real = parseFlashIdInfo(REAL_FLASH_ID);
  check('预检解析：真实 v5 输出能取到容量（16MB）', real.flashSizeBytes === 16 * 1024 ** 2, String(real.flashSizeBytes));
  check('预检解析：真实 v5 输出能取到芯片名（`Chip type:` 写法，不是只认 `Chip is`）',
    real.chip.includes('ESP32-S3') && real.chip.includes('QFN56'), JSON.stringify(real.chip));

  const fitOverflow = checkSegmentsFit([{ offset: '0x800000', file: 'assets.bin', sizeBytes: 2 * 1024 ** 2 }], 8 * 1024 ** 2);
  check('容量校验：8MB flash 上写 0x800000+2MB 判越界',
    fitOverflow.ok === false && fitOverflow.overflows.length === 1);
  check('容量校验：容量内放行',
    checkSegmentsFit([{ offset: '0x20000', file: 'app.bin', sizeBytes: 1024 ** 2 }], 8 * 1024 ** 2).ok === true);
  const fitOverlap = checkSegmentsFit([
    { offset: '0x0', file: 'a.bin', sizeBytes: 0x9000 },
    { offset: '0x8000', file: 'b.bin', sizeBytes: 0x1000 },
  ], 0);
  check('段重叠：后一段起点落在前一段区间内即报错（不需要容量也能拦）',
    fitOverlap.ok === false && fitOverlap.overlaps.length === 1);
  check('容量未知时不判越界（不猜）',
    checkSegmentsFit([{ offset: '0x0', file: 'a.bin', sizeBytes: 10 }], 0).overflows.length === 0);
  check('plan_digest：改段偏移即变（防确认后偷换段）',
    planDigest({ port: 'p', argv: [], segments: [{ offset: '0x0', file: 'a' }] })
    !== planDigest({ port: 'p', argv: [], segments: [{ offset: '0x1000', file: 'a' }] }));

  const segExec = async (cmd) => {
    if (cmd === 'diskutil list') return { stdout: '' };
    if (cmd.startsWith('ls /dev/cu')) return { stdout: '/dev/cu.usbmodem1301\n' };
    if (cmd.includes('command -v esptool')) return { stdout: '/usr/local/bin/esptool\n' };
    return { stdout: '' };
  };
  const sizes = { '/b/boot.bin': 0x7000, '/b/part.bin': 0x1000, '/b/app.bin': 1024 ** 2 };
  const statOf = (path) => {
    if (sizes[path] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => true, size: sizes[path] };
  };
  const SEGS = [
    { offset: '0x0', file: '/b/boot.bin' },
    { offset: '0x8000', file: '/b/part.bin' },
    { offset: '0x20000', file: '/b/app.bin' },
  ];
  const mp = await deviceFlashHandler(
    { action: 'plan', port: '/dev/cu.usbmodem1301', segments: SEGS, chip: 'esp32s3' },
    { exec: segExec, stat: statOf, platform: 'darwin' });
  check('plan 多段：返回每段偏移与大小，argv 里三段齐全',
    mp.ok && mp.segments.length === 3 && mp.segments.every((x) => x.sizeBytes > 0)
    && mp.argv.filter((a) => a.startsWith('0x')).length === 3);

  // 下面两条守的是**接线**，不是 checkSegmentsFit 纯函数：
  // 纯函数有断言（'段重叠：后一段起点…'）不代表 handler 里那两个 if 分支被执行。
  // 2026-10-31 变异实测：把 plan 档的 `if (fit.overlaps.length)` 短路成 false，套件仍 60/60 全绿——
  // 补此断言后同一变异精确报红 1 条。
  const OVLAP = [
    { offset: '0x0', file: '/b/boot.bin' },    // 0x0 起、长 0x7000 → 止于 0x7000
    { offset: '0x6000', file: '/b/part.bin' }, // 起点落进上一段尾部
  ];
  const ovPlan = await deviceFlashHandler(
    { action: 'plan', port: '/dev/cu.usbmodem1301', segments: OVLAP, chip: 'esp32s3' },
    { exec: segExec, stat: statOf, platform: 'darwin' });
  check('plan 档接线：重叠段直接拒绝（不需要设备容量，plan 阶段就能拦住）',
    ovPlan.ok === false && ovPlan.error.includes('段与段重叠'), ovPlan.error);

  const ovBuilt = buildFlashPlan({ port: '/dev/cu.usbmodem1301', chip: 'esp32s3', segments: OVLAP });
  const ovDigest = planDigest({
    port: '/dev/cu.usbmodem1301', chip: 'esp32s3', argv: ovBuilt.argv, segments: ovBuilt.segments,
  });
  const ovWrites = [];
  const ovFlash = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: OVLAP, chip: 'esp32s3', plan_digest: ovDigest },
    {
      exec: segExec, stat: statOf, platform: 'darwin',
      run: async (argv) => {
        if (argv.includes('flash_id')) return { code: 0, stdout: 'Detected flash size: 8MB', stderr: '' };
        ovWrites.push(argv); return { code: 0 };
      },
    });
  check('flash 档接线：容量够也要拦重叠，且一次都不写（越界与重叠走同一条 fit 判据）',
    ovFlash.ok === false && ovFlash.error.includes('段与段重叠') && ovWrites.length === 0,
    ovFlash.error);

  const writes = [];
  const tinyRun = async (argv) => {
    if (argv.includes('flash_id')) return { code: 0, stdout: 'Chip is ESP32-S3 (revision v0.2)\nDetected flash size: 1MB', stderr: '' };
    writes.push(argv);
    return { code: 0, stdout: 'written', stderr: '' };
  };
  const overflow = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: SEGS, chip: 'esp32s3', plan_digest: mp.plan_digest },
    { exec: segExec, run: tinyRun, stat: statOf, platform: 'darwin' });
  check('flash 越界：实测 1MB 容量时 0x20000+1MB 超界必须拒绝且一次都不写',
    overflow.ok === false && overflow.error.includes('容量校验') && writes.length === 0,
    overflow.error);

  const preFail = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: SEGS, chip: 'esp32s3', plan_digest: mp.plan_digest },
    { exec: segExec, run: async () => ({ code: 2, stdout: '', stderr: 'Failed to connect' }), stat: statOf, platform: 'darwin' });
  check('flash 预检失败：拒绝执行并指出排查方向（不是静默继续）',
    preFail.ok === false && preFail.error.includes('容量预检失败'));

  const noSize = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: SEGS, chip: 'esp32s3', plan_digest: mp.plan_digest },
    { exec: segExec, run: async (argv) => (argv.includes('flash_id') ? { code: 0, stdout: 'Connecting...' } : { code: 0 }), stat: statOf, platform: 'darwin' });
  check('flash 容量未知：拒绝在未知容量下写入',
    noSize.ok === false && noSize.error.includes('未知容量'));
}

// ── 阶段 2（2026-10-31）：回读校验 verify / 整片备份 backup / VID:PID 身份钉 ──
// 这一段守的东西与上面不同：上面守「别烧坏」，这里守「烧完能自证」与「读到的确实是这块板」。
// 每条断言对应一个可被单独摘掉的分支——其中 backup 的「不覆盖已有文件」与「落地字节数」
// 是两条独立的 fail-closed，摘掉任一条都该只红一条。
{
  const approval = require('../main/approval.js');

  check('VID:PID：四种写法归一成同一个值（同一块板不该被判成不同）',
    ['1a86:7523', '1A86-7523', '0x1a86:0x7523', ' 1a86 : 7523 '].every((s) => parseVidPid(s) === '1a86:7523'));
  check('VID:PID：非法写法返回 null（不猜他指的是哪块板）',
    parseVidPid('ch340') === null && parseVidPid('1a86:') === null && parseVidPid('') === null);

  check('容量字符串：带单位与十六进制都认', parseSize('4MB') === 4 * 1024 ** 2 && parseSize('0x400000') === 4 * 1024 ** 2);
  check('容量字符串：裸数字按十进制（800000 是 800KB 不是 8MB，与 offset 口径有意不同）', parseSize('800000') === 800000);
  check('容量字符串：小数与 KiB 也认，解析不出返回 0 不猜',
    parseSize('1.5MB') === 1.5 * 1024 ** 2 && parseSize('4194304') === 4194304 && parseSize('4KiB') === 4096 && parseSize('大') === 0);

  const vp = buildFlashPlan({ port: '/dev/cu.x', chip: 'esp32s3', command: 'verify_flash', segments: [{ offset: '0x0', file: '/b/a.bin' }] });
  check('verify 装配：末尾子命令是 verify_flash（不是 write_flash）且段对齐全',
    vp.ok && vp.argv[vp.argv.indexOf('verify_flash') + 1] === '0x0' && vp.argv.slice(-2).join(' ') === '0x0 /b/a.bin');
  check('verify 装配：不出现「每段都会覆盖原有内容」这种吓人的话（它不写）',
    vp.ok && !vp.warnings.some((w) => w.includes('覆盖')) && vp.warnings.some((w) => w.includes('不写入')));

  const bp = buildBackupPlan({ port: '/dev/cu.x', chip: 'esp32', sizeBytes: 4 * 1024 ** 2, out: '/tmp/bk.bin' });
  check('backup 装配：read_flash 0x0 <size> <out>',
    bp.ok && bp.argv.slice(-4).join(' ') === 'read_flash 0x0 0x400000 /tmp/bk.bin');
  check('backup 装配：缺 out 直接拒绝（读出来得有地方放）', buildBackupPlan({ port: '/dev/cu.x', sizeBytes: 1024 }).ok === false);
  check('backup 装配：缺长度直接拒绝（不猜默认值，读一半的备份比没备份更危险）',
    buildBackupPlan({ port: '/dev/cu.x', sizeBytes: 0, out: '/tmp/bk.bin' }).ok === false);
  check('backup：告警里写明「含设备全部数据」——这不是普通读文件，是信息披露',
    bp.warnings.some((w) => w.includes('敏感') || w.includes('配网信息')));

  // ── handler 层（下面几条守的是接线分支，不是上面的纯函数）──
  const exec = async (cmd) => {
    if (cmd === 'diskutil list') return { stdout: '' };
    if (cmd.startsWith('ls /dev/cu')) return { stdout: '/dev/cu.usbmodem1301\n' };
    if (cmd.includes('command -v esptool')) return { stdout: '/usr/local/bin/esptool\n' };
    if (cmd.includes('SPUSB')) {
      return { stdout: JSON.stringify({ SPUSBDataType: [{ _name: 'USB2.0-Serial', vendor_id: '0x1a86', product_id: '0x7523' }] }) };
    }
    return { stdout: '' };
  };
  const files = { '/b/a.bin': 0x1000 };
  const stat = (p) => {
    if (files[p] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => true, size: files[p] };
  };
  const S = [{ offset: '0x0', file: '/b/a.bin' }];
  const deps = { exec, stat, platform: 'darwin' };
  const plan = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32' }, deps);

  const vcalls = [];
  const vRun = async (argv) => {
    vcalls.push(argv);
    if (argv.includes('flash_id')) return { code: 0, stdout: 'Chip is ESP32 (revision 3)\nDetected flash size: 4MB' };
    return { code: 0, stdout: 'verify ok' };
  };
  const vr = await deviceFlashHandler(
    { action: 'verify', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: plan.plan_digest },
    { ...deps, run: vRun });
  check('verify 接线：走 verify_flash 子命令，且一次 write_flash 都没发',
    vr.ok && vr.argv.includes('verify_flash') && !vcalls.some((a) => a.includes('write_flash')), vr.error);
  check('verify 接线：同一个 plan_digest 在 flash 与 verify 上都成立（一次确认，两处可用）',
    vr.ok && plan.plan_digest.length === 16
    && (await deviceFlashHandler(
      { action: 'flash', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: plan.plan_digest },
      { ...deps, run: vRun })).ok === true);
  check('verify 接线：通过的 hint 明确说「逐字节一致」，而不是只报成功两字',
    vr.ok && String(vr.hint || '').includes('逐字节'));

  const vbad = await deviceFlashHandler(
    { action: 'verify', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: 'deadbeefdeadbeef' },
    { ...deps, run: vRun });
  check('verify 接线：digest 不符仍然拒绝（校验也必须针对「人确认过的那一组参数」）',
    vbad.ok === false && String(vbad.error).includes('plan_digest'));

  const vfail = await deviceFlashHandler(
    { action: 'verify', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: plan.plan_digest },
    { ...deps, run: async (argv) => (argv.includes('flash_id') ? { code: 0, stdout: 'Detected flash size: 4MB' } : { code: 1, stderr: 'Verify mismatch' }) });
  check('verify 接线：比对失败时 hint 说「校验失败」而不是「烧写失败」（口径不能混）',
    vfail.ok === false && String(vfail.hint || '').includes('校验失败'));

  // backup：三条独立的 fail-closed
  const bfiles = {};
  const bstat = (p) => {
    if (bfiles[p] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => true, size: bfiles[p] };
  };
  const bkRun = async (argv) => {
    if (argv.includes('flash_id')) return { code: 0, stdout: 'Detected flash size: 1MB' };
    bfiles[argv[argv.length - 1]] = 1024 ** 2; // 模拟 esptool 写出整片
    return { code: 0, stdout: 'read ok' };
  };
  const bk = await deviceFlashHandler(
    { action: 'backup', port: '/dev/cu.usbmodem1301', chip: 'esp32', out: '/tmp/bk1.bin' },
    { exec, stat: bstat, platform: 'darwin', run: bkRun });
  check('backup 接线：长度来自 flash_id 实测，落地后字节数必须等于它',
    bk.ok && bk.sizeBytes === 1024 ** 2 && bk.bytes === 1024 ** 2, bk.error);
  check('backup 接线：卡面方向是「板子 → 文件」，不是「往板子写」',
    bk.ok && approval.approvalTarget('device_flash', { port: '/dev/cu.usbmodem1301', action: 'backup', out: '/tmp/bk1.bin' }) === '/dev/cu.usbmodem1301 → /tmp/bk1.bin');

  const bshort = await deviceFlashHandler(
    { action: 'backup', port: '/dev/cu.usbmodem1301', chip: 'esp32', out: '/tmp/bk2.bin' },
    { exec, stat: bstat, platform: 'darwin', run: async (argv) => (argv.includes('flash_id') ? { code: 0, stdout: 'Detected flash size: 1MB' } : { code: 0 }) });
  check('backup 接线：命令成功但文件没落地/字节数不符 → 报「不完整」，不许算成功',
    bshort.ok === false && String(bshort.error).includes('不完整'), bshort.error);

  const bover = await deviceFlashHandler(
    { action: 'backup', port: '/dev/cu.usbmodem1301', chip: 'esp32', out: '/tmp/bk1.bin' },
    { exec, stat: bstat, platform: 'darwin', run: bkRun });
  check('backup 接线：目标已存在拒绝覆盖（写坏唯一一份恢复镜像＝毁掉回滚手段）',
    bover.ok === false && String(bover.error).includes('已存在'));

  const bnoout = await deviceFlashHandler({ action: 'backup', port: '/dev/cu.usbmodem1301' }, { exec, stat: bstat, platform: 'darwin', run: bkRun });
  check('backup 接线：缺 out 拒绝', bnoout.ok === false && String(bnoout.error).includes('out'));

  const bsize = [];
  const bs = await deviceFlashHandler(
    { action: 'backup', port: '/dev/cu.usbmodem1301', chip: 'esp32', out: '/tmp/bk3.bin', size: '2MB' },
    { exec, stat: bstat, platform: 'darwin', run: async (argv) => { bsize.push(argv); bfiles['/tmp/bk3.bin'] = 2 * 1024 ** 2; return { code: 0 }; } });
  check('backup 接线：显式给 size 时不再跑 flash_id（省一次复位）',
    bs.ok && !bsize.some((a) => a.includes('flash_id')) && bs.sizeBytes === 2 * 1024 ** 2);

  // VID:PID 身份钉
  const okId = await deviceFlashHandler(
    { action: 'plan', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', expect_vid_pid: '1A86:7523' },
    deps);
  check('身份钉：plan 阶段不拦（设备可能还没插），但写法非法要立刻拒绝',
    okId.ok === true
    && (await deviceFlashHandler({ action: 'plan', port: '/dev/cu.usbmodem1301', segments: S, expect_vid_pid: 'ch340' }, deps)).ok === false);

  const idOk = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: plan.plan_digest, expect_vid_pid: '1a86:7523' },
    { ...deps, run: vRun });
  check('身份钉：VID:PID 命中时放行，并把命中的设备名带进结果',
    idOk.ok === true && !!idOk.identity && idOk.identity.vid === '1a86', JSON.stringify(idOk.identity));

  const idMiss = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: plan.plan_digest, expect_vid_pid: '303a:1001' },
    { ...deps, run: vRun });
  check('身份钉：VID:PID 不命中直接拒绝，并列出当前枚举到什么（让人能自查）',
    idMiss.ok === false && String(idMiss.error).includes('303a:1001') && String(idMiss.error).includes('1a86:7523'));

  const idSkip = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: plan.plan_digest },
    { ...deps, run: vRun });
  check('身份钉：没给 expect_vid_pid 就跳过（不强制），identity 字段为 null 而不是假装核对过',
    idSkip.ok === true && idSkip.identity === null);

  const idDown = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: plan.plan_digest, expect_vid_pid: '1a86:7523' },
    { exec: async (cmd) => { if (cmd.includes('SPUSB')) throw new Error('permission denied'); return exec(cmd); }, stat, platform: 'darwin', run: vRun });
  check('身份钉：枚举本身失败时拒绝（不能把「查不到」当成「没这块板」）',
    idDown.ok === false && String(idDown.error).includes('失败'));

  check('卡面 target：多段时把段数与文件名带上（否则渲染成「/dev/cu.x ← 」空白）',
    approval.approvalTarget('device_flash', { port: '/dev/cu.x', action: 'flash', segments: [{ offset: '0x0', file: '/a/boot.bin' }, { offset: '0x8000', file: '/a/app.bin' }] })
      === '/dev/cu.x ← 2 段（boot.bin + app.bin）');
  check('卡面 target：verify 用 ⇄ 表示双向比对，与 flash 的 ← 可区分',
    approval.approvalTarget('device_flash', { port: '/dev/cu.x', action: 'verify', firmware: '/a/f.bin' }) === '/dev/cu.x ⇄ /a/f.bin');
}

// ── 真机发现的三处缺口（2026-10-31，接上 ESP32-S3 后实测暴露）──
// 这三条都是「单测全绿但真实机器上是坏的」，共同原因是：被测代码没有接触真实输出的形状。
//   ① 端口白名单直接用了 `ls /dev/cu.*` 全量 ⇒ 蓝牙虚拟口被当成可烧目标推荐给模型；
//   ② esptool.py 写死 ⇒ v5 起该入口 deprecated，未来 major 移除即 ENOENT；
//   ③ macOS `system_profiler SPUSBDataType` 在 Apple Silicon 上返回空数组 ⇒ devices 全空、
//      身份钉永远失败，而字段名也换成了 USBDeviceKeyVendorID/PID。
{
  const { parseUsbTree: parseTree } = require('../main/deviceProbe.js');

  // ③ 字段兼容：两种形状都要能解析，且都拿到 vid/pid
  const newShape = parseTree({ SPUSBHostDataType: [{ _name: 'USB JTAG/serial debug unit', USBDeviceKeyVendorID: '0x303a', USBDeviceKeyProductID: '0x1001', USBDeviceKeySerialNumber: 'D0:CF:13:06:DC:74' }] });
  check('USB 解析：认 SPUSBHostDataType 的 USBDeviceKey* 字段（Apple Silicon 唯一有数据的源）',
    newShape.length === 1 && newShape[0].vid === '303a' && newShape[0].pid === '1001' && newShape[0].serial === 'D0:CF:13:06:DC:74',
    JSON.stringify(newShape));
  check('USB 解析：老形状 vendor_id/product_id 仍然认（正样本，别为了新源把旧源改坏）',
    parseTree({ SPUSBDataType: [{ _name: 'x', vendor_id: '0x1a86', product_id: '0x7523' }] })[0]?.vid === '1a86');

  // ② esptool 名探测
  check('esptool 探测：裸名优先、.py 回退、都没有返回空',
    resolveEsptoolFromPath('/opt/anaconda3/bin/esptool\n') === 'esptool'
    && resolveEsptoolFromPath('/opt/anaconda3/bin/esptool.py\n') === 'esptool.py'
    && resolveEsptoolFromPath('C:\\Python\\Scripts\\esptool.exe\r\n') === 'esptool'
    && resolveEsptoolFromPath('') === '' && resolveEsptoolFromPath('garbage') === '');

  const baseExec = (esptoolOut, ports) => async (cmd) => {
    if (cmd === 'diskutil list') return { stdout: '' };
    if (cmd.startsWith('ls /dev/cu')) return { stdout: ports.join('\n') };
    if (cmd.includes('command -v esptool')) return { stdout: esptoolOut };
    if (cmd.includes('SPUSB')) {
      return { stdout: JSON.stringify({ SPUSBHostDataType: [{ _name: 'USB JTAG/serial debug unit', USBDeviceKeyVendorID: '0x303a', USBDeviceKeyProductID: '0x1001' }] }) };
    }
    return { stdout: '' };
  };
  // 真实场景复刻：1 个板子 + 3 个蓝牙虚拟口
  const PORTS = ['/dev/cu.Bluetooth-Incoming-Port', '/dev/cu.QCYMeloBudsN70', '/dev/cu.debug-console', '/dev/cu.usbmodem1301'];
  const files = { '/b/a.bin': 0x1000 };
  const stat = (p) => {
    if (files[p] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => true, size: files[p] };
  };
  const deps = { exec: baseExec('/usr/local/bin/esptool\n', PORTS), stat, platform: 'darwin' };
  const S = [{ offset: '0x0', file: '/b/a.bin' }];

  // ① 列表只推荐可刷机口，且把排除项作为证据交出来
  const lt = await deviceFlashHandler({ action: 'list_targets' }, deps);
  check('list_targets：ports 只给可刷机口，蓝牙虚拟口一个都不推荐',
    lt.ok && lt.ports.length === 1 && lt.ports[0] === '/dev/cu.usbmodem1301', JSON.stringify(lt.ports));
  check('list_targets：被排除的口单独列出（否则用户以为枚举坏了——"系统里明明有 cu.xxx"）',
    lt.excludedPorts.length === 3 && lt.excludedPorts.includes('/dev/cu.QCYMeloBudsN70'), JSON.stringify(lt.excludedPorts));

  // ① 硬闸：真实存在但不是板子 → 必须拒绝，且文案要区分「不是可刷机口」与「根本没有这个口」
  const planBt = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.QCYMeloBudsN70', segments: S, chip: 'esp32' }, deps);
  check('plan：蓝牙口只告警（板子可能还没插），并说明它不是可刷机口',
    planBt.ok === true && planBt.warnings.some((w) => w.includes('不是可刷机串口')), JSON.stringify(planBt.warnings));
  const flashBt = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.QCYMeloBudsN70', segments: S, chip: 'esp32', plan_digest: planBt.plan_digest }, deps);
  check('flash 硬闸：真实存在但非可刷机口 → 拒绝（这是原来的缺口：白名单只挡编造的名字）',
    flashBt.ok === false && String(flashBt.error).includes('不是可刷机串口'), flashBt.error);
  // 幽灵口要单独 plan 拿 digest：digest 是按 port 算的，拿蓝牙口的 digest 会被 digest 先拦住，
  // 那样测到的就不是端口硬闸了（这正是「断言要落在目标那层」的实例）。
  const planGhost = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.ghost9', segments: S, chip: 'esp32' }, deps);
  const flashGhost = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.ghost9', segments: S, chip: 'esp32', plan_digest: planGhost.plan_digest }, deps);
  check('flash 硬闸：根本不存在的口 → 文案说「不在枚举列表」，与上一条可区分',
    flashGhost.ok === false && String(flashGhost.error).includes('不在当前枚举列表里'), flashGhost.error);

  const okPlan = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32' }, deps);
  check('flash 硬闸：可刷机口正常放行（正样本，别为了拦蓝牙把真板子也拦掉）',
    okPlan.ok === true && okPlan.argv[0] === 'esptool', JSON.stringify(okPlan.argv?.slice(0, 2)));

  const onlyBt = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.QCYMeloBudsN70', segments: S, chip: 'esp32' },
    { ...deps, exec: baseExec('/usr/local/bin/esptool\n', ['/dev/cu.QCYMeloBudsN70']) });
  check('plan：只插了蓝牙设备时不产生任何"可刷"提示（空列表 ≠ 可以随便挑）',
    onlyBt.ok === true && !onlyBt.warnings.some((w) => w.includes('可刷：')));

  // ② argv 第一项来自探测结果，且进 digest（换了解释器必须重走 plan）
  const planPy = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32' },
    { ...deps, exec: baseExec('/opt/anaconda3/bin/esptool.py\n', PORTS) });
  check('esptool 探测：只装了旧版时 argv 用 esptool.py（回退分支真的会走到）',
    planPy.ok === true && planPy.argv[0] === 'esptool.py', planPy.argv?.[0]);
  const crossRun = await deviceFlashHandler(
    { action: 'flash', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: okPlan.plan_digest },
    { ...deps, exec: baseExec('/opt/anaconda3/bin/esptool.py\n', PORTS), run: async () => ({ code: 0 }) });
  check('esptool 探测：解释器变了 digest 就变（人看到的是 esptool，实际却跑 esptool.py ⇒ 必须重新确认）',
    crossRun.ok === false && String(crossRun.error).includes('plan_digest'), crossRun.error);

  const noTool = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32' },
    { ...deps, exec: baseExec('', PORTS) });
  check('esptool 未安装：plan 阶段就 fail-fast 并给安装指引（不是等到 execFile 抛 ENOENT）',
    noTool.ok === false && String(noTool.error).includes('pip install esptool'), noTool.error);

  // ── 子命令写法：v5 连字符 / v4 下划线，两条都要能装配 ──
  // 真机实测：v5.6.0 只认 write-flash 一族，下划线形式仅剩兼容并打 deprecation；
  // v4 只认下划线。写死任何一种都会打死另一半用户。
  const { resetSubcommandCacheForTest } = require('../main/tools/deviceFlashTool.js');
  const withHelp = (helpOut, esptoolOut) => async (cmd) => {
    if (cmd.includes('--help')) return { stdout: helpOut };
    return baseExec(esptoolOut, PORTS)(cmd);
  };
  const V5_HELP = '  write-flash         Write a binary blob to flash.\n  verify-flash        Verify\n  read-flash          Read\n  flash-id            Print ID\n';

  resetSubcommandCacheForTest();
  const dashPlan = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32' },
    { ...deps, exec: withHelp(V5_HELP, '/usr/local/bin/esptool\n') });
  check('子命令写法：探测到 v5 连字符时装配 write-flash（不再触发 deprecation）',
    dashPlan.ok === true && dashPlan.argv.includes('write-flash') && !dashPlan.argv.includes('write_flash'),
    JSON.stringify(dashPlan.argv?.slice(-4)));
  check('子命令写法：v5 的 write-flash 仍然带「会覆盖原有内容」的警告（不能因为改了字面量就丢掉风险描述）',
    dashPlan.ok === true && dashPlan.warnings.some((w) => w.includes('覆盖')));
  check('子命令写法：v5 连 --before/--after 的取值也转连字符（真机实测不转仍打 deprecation）',
    dashPlan.ok === true && dashPlan.argv.includes('default-reset') && dashPlan.argv.includes('hard-reset')
    && !dashPlan.argv.includes('default_reset'), JSON.stringify(dashPlan.argv?.slice(4, 8)));

  resetSubcommandCacheForTest();
  const dashVerify = await deviceFlashHandler(
    { action: 'verify', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32', plan_digest: dashPlan.plan_digest },
    { ...deps, exec: withHelp(V5_HELP, '/usr/local/bin/esptool\n'), run: async (argv) => (argv.includes('flash-id') ? { code: 0, stdout: 'Detected flash size: 4MB' } : { code: 0 }) });
  check('子命令写法：v5 下 verify 用 verify-flash，且预检用 flash-id',
    dashVerify.ok === true && dashVerify.argv.includes('verify-flash'), dashVerify.error || JSON.stringify(dashVerify.argv?.slice(-3)));

  resetSubcommandCacheForTest();
  const dashBackup = await deviceFlashHandler(
    { action: 'backup', port: '/dev/cu.usbmodem1301', chip: 'esp32', out: '/tmp/bk-v5.bin' },
    { ...deps, exec: withHelp(V5_HELP, '/usr/local/bin/esptool\n'), run: async (argv) => (argv.includes('flash-id') ? { code: 0, stdout: 'Detected flash size: 1MB' } : (files['/tmp/bk-v5.bin'] = 1024 ** 2, { code: 0 })) });
  check('子命令写法：v5 下 backup 用 read-flash',
    dashBackup.ok === true && dashBackup.argv.includes('read-flash'), dashBackup.error || JSON.stringify(dashBackup.argv?.slice(-4)));

  resetSubcommandCacheForTest();
  const undPlan = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.usbmodem1301', segments: S, chip: 'esp32' },
    { ...deps, exec: withHelp('  write_flash   Write\n', '/opt/anaconda3/bin/esptool.py\n') });
  check('子命令写法：v4（只能下划线）仍然装配 write_flash + default_reset（正样本，别为了新版本打死旧版本）',
    undPlan.ok === true && undPlan.argv.includes('write_flash') && undPlan.argv[0] === 'esptool.py'
    && undPlan.argv.includes('default_reset'),
    JSON.stringify(undPlan.argv?.slice(0, 1).concat(undPlan.argv?.slice(-3))));
  resetSubcommandCacheForTest();
}

// ── L2 桥接驱动层（2026-10-31）：usb 在 ↔ 串口没出，这两种「有设备」必须能分开 ──
// 下面所有样本都是**真机原文**（macOS 26 / Apple Silicon，2026-10-31 采集），不是手搓的理想格式。
// 夹具放模块作用域：L3 的端到端复用同一份，避免两套样本各自漂移。
//
// pyserial `-v` 原文：注意 /dev/cu.picunF6 后面有 5 个尾随空格（真机就是这样）
const PYSERIAL_DARWIN = [
  '6 ports found',
  '/dev/cu.Bluetooth-Incoming-Port', '    desc: n/a', '    hwid: n/a',
  '/dev/cu.QCYMeloBudsN70', '    desc: n/a', '    hwid: n/a',
  '/dev/cu.ROSECAMBRIAN', '    desc: n/a', '    hwid: n/a',
  '/dev/cu.debug-console', '    desc: n/a', '    hwid: n/a',
  '/dev/cu.picunF6     ', '    desc: n/a', '    hwid: n/a',
  '/dev/cu.usbmodem1301', '    desc: USB JTAG/serial debug unit',
  '    hwid: USB VID:PID=303A:1001 SER=D0:CF:13:06:DC:74 LOCATION=0-1.3',
].join('\n');
// kmutil showloaded | grep 的真实形状
const KMUTIL = [
  '  270    1 0xfffffe000789bbe0 0x44a5     0x44a5     com.apple.driver.usb.cdc (5.0.0) 04EB9B32 <234 122 72 7 6 5 3>',
  '  272    0 0xfffffe0007897a90 0x4f88     0x4f88     com.apple.driver.usb.cdc.acm (5.0.0) 3C34B1D8 <271 270 234 122 72 63 7 6 5 3>',
].join('\n');
// system_profiler SPUSBHostDataType 的真实字段名（与 SPUSBDataType 不同）
const HOST_TREE = {
  SPUSBHostDataType: [
    { _name: 'USB HUB', USBDeviceKeyVendorID: '0x1a86', USBDeviceKeyProductID: '0x8091', USBDeviceKeySerialNumber: 'Not Provided' },
    { _name: 'USB JTAG/serial debug unit', USBDeviceKeyVendorID: '0x303a', USBDeviceKeyProductID: '0x1001', USBDeviceKeySerialNumber: 'D0:CF:13:06:DC:74' },
    { _name: 'USB Serial', USBDeviceKeyVendorID: '0x1a86', USBDeviceKeyProductID: '0x7522', USBDeviceKeySerialNumber: 'Not Provided' },
  ],
};
// 真机六条命令的输出（executors 用「全装」形状，不依赖跑测试的机器上装了什么）
const hostExec = async (cmd) => {
  if (cmd.includes('SPUSBHostDataType')) return { stdout: JSON.stringify(HOST_TREE) };
  if (cmd.startsWith('ls /dev/cu')) return { stdout: PYSERIAL_DARWIN.split('\n').filter((l) => l.startsWith('/dev/')).map((l) => l.trim()).join('\n') };
  if (cmd.startsWith('command -v esptool')) return { stdout: '/opt/anaconda3/bin/esptool\n' };
  if (cmd.includes('serial.tools.list_ports')) return { stdout: `INTERP=/opt/anaconda3/bin/python3\n${PYSERIAL_DARWIN}` };
  if (cmd.includes('kmutil showloaded')) return { stdout: KMUTIL };
  if (cmd.includes('EXECUTOR_PROBE_DONE')) return { stdout: `HAVE=esptool\n${EXECUTOR_PROBE_SENTINEL}` };
  return { stdout: '' };
};

{
  // ① hwid 解析：SER 里本来就带冒号，按 `:` 切会把它截成 "D0"
  const id1 = parseHwid('USB VID:PID=303A:1001 SER=D0:CF:13:06:DC:74 LOCATION=0-1.3');
  check('hwid：VID/PID 归一化成小写 4 位，SER 的冒号原样保留（按 ":" 切会截成 D0）',
    id1 && id1.vid === '303a' && id1.pid === '1001' && id1.serial === 'D0:CF:13:06:DC:74' && id1.location === '0-1.3',
    JSON.stringify(id1));
  check('hwid：n/a 解析为 null（「查不到身份」不等于「身份是 n/a」）', parseHwid('n/a') === null);

  // ② 「装了 pyserial 但 0 个口」与「没装 pyserial」必须分开——两者端口列表都是空
  const s1 = splitPyserialOutput('INTERP=/opt/anaconda3/bin/python3\n0 ports found\n');
  const s2 = splitPyserialOutput('INTERP=\n0 ports found\n');
  check('pyserial 可用性：INTERP 为空才算不可用（端口列表为空不能作为判据）',
    s1.available === true && s1.interpreter === '/opt/anaconda3/bin/python3' && s2.available === false,
    `可用=${s1.available}/${s2.available}`);
  check('pyserial 可用性：INTERP 行不能混进端口列表（它不是端口）', !s1.body.includes('INTERP='));

  // ③ 详细输出解析
  const parsed = parsePyserialDetailed(PYSERIAL_DARWIN);
  check('端口解析：6 个口全在，且只有 usbmodem1301 被判为真设备',
    parsed.length === 6 && parsed.filter((p) => p.real === true).length === 1
    && parsed.find((p) => p.real === true).port === '/dev/cu.usbmodem1301',
    `ports=${parsed.length} real=${parsed.filter((p) => p.real).length}`);
  check('端口解析：首行 "6 ports found" 不会被当成端口',
    !parsed.some((p) => /ports found/.test(p.port)));
  check('端口解析：端口名的尾随空格被去掉（真机 picunF6 带 5 个空格，不去掉就是打不开的路径）',
    parsed.some((p) => p.port === '/dev/cu.picunF6') && !parsed.some((p) => p.port !== p.port.trim()));
  check('端口解析：hwid=n/a 的口 real===false（确认不是 USB 串口，蓝牙/调试控制台）',
    parsed.filter((p) => p.real === false).length === 5);
  check('端口解析：真设备带上板卡表的 chip/driver（303a:1001 → 原生 USB 免驱）',
    parsed.find((p) => p.port === '/dev/cu.usbmodem1301').chip === 'esp32-native'
    && parsed.find((p) => p.port === '/dev/cu.usbmodem1301').driver === 'builtin');

  const oldFmt = parsePyserialDetailed('/dev/ttyUSB0\n/dev/ttyUSB1\n');
  check('端口解析：老版 pyserial 只有端口名时 real===null（查不到 ≠ 不是设备）',
    oldFmt.length === 2 && oldFmt.every((p) => p.real === null), JSON.stringify(oldFmt.map((p) => p.real)));
  const noisy = parsePyserialDetailed('Traceback (most recent call last):\n  File "x.py", line 1\n/dev/cu.usbmodem1\n    hwid: USB VID:PID=303A:1001\n');
  check('端口解析：混进 stdout 的 python 报错不被当成端口（顶格行只接受像端口名的）',
    noisy.length === 1 && noisy[0].port === '/dev/cu.usbmodem1', JSON.stringify(noisy.map((p) => p.port)));
  const win = parsePyserialDetailed('COM3\n    desc: USB-SERIAL CH340 (COM3)\n    hwid: USB VID:PID=1A86:7523 SER= LOCATION=1-1\n');
  check('端口解析：Windows 形状（COM3 + 空 SER）也能认，空序列号给空串而不是 undefined',
    win.length === 1 && win[0].vid === '1a86' && win[0].serial === '' && win[0].chip === 'ch340');

  // ④ 驱动加载状态：三种「没有」必须分开
  const drv = parseLoadedDrivers(KMUTIL);
  check('驱动状态：kmutil 原文能认出内置 CDC 已加载、WCH 未加载',
    drv.ok === true && drv.families.builtin === true && drv.families['wch-ch34x'] === false,
    JSON.stringify(drv.families));
  check('驱动状态：grep 无命中（哨兵）算「查过了，确实没有」',
    parseLoadedDrivers(NO_DRIVER_SENTINEL).ok === true
    && parseLoadedDrivers(NO_DRIVER_SENTINEL).families['wch-ch34x'] === false);
  check('驱动状态：命令失败必须是 ok=false（当成「没装驱动」会让人白装一次驱动）',
    parseLoadedDrivers(DRIVER_PROBE_FAILED).ok === false && parseLoadedDrivers('').ok === false);
  check('驱动状态：Linux lsmod 形状也能认（ch341 模块）',
    parseLoadedDrivers('ch341                  24576  0\ncdc_acm                40960  1').families['wch-ch34x'] === true);

  // ⑤ 端到端：真机三设备 → 三种不同结论（夹具在模块作用域，L3 复用同一份）
  const l2 = await deviceProbeHandler({ exec: hostExec, platform: 'darwin' });
  const bridge = (v, p) => l2.bridges.find((b) => b.vid === v && b.pid === p);
  check('L2 端到端：集线器被判为「忽略」而不是「缺驱动」',
    bridge('1a86', '8091')?.verdict === 'ignored', bridge('1a86', '8091')?.verdict);
  check('L2 端到端：原生 USB 凭 hwid+序列号精确绑定到 /dev/cu.usbmodem1301',
    bridge('303a', '1001')?.verdict === 'ready' && bridge('303a', '1001')?.evidence === 'hwid+serial'
    && bridge('303a', '1001')?.ports[0] === '/dev/cu.usbmodem1301',
    `${bridge('303a', '1001')?.verdict}/${bridge('303a', '1001')?.evidence}`);
  check('L2 端到端：板载 CH34x 无串口 + 驱动未加载 → need-driver（这是本机真实缺口）',
    bridge('1a86', '7522')?.verdict === 'need-driver' && bridge('1a86', '7522')?.driverLoaded === false,
    `${bridge('1a86', '7522')?.verdict}/loaded=${bridge('1a86', '7522')?.driverLoaded}`);
  check('L2 端到端：toolchain 带上 pyserial 与解释器路径（换机器时能直接看出谁有 pyserial）',
    l2.toolchain.pyserial === true && l2.interpreter === '/opt/anaconda3/bin/python3');
  check('L2 端到端：5 个蓝牙口被明确排除并留证据（不是静默丢掉）',
    l2.notes.some((n) => n.includes('已排除 5 个非 USB 串口')));

  // ⑥ 拿不到 hwid 时才退回命名规则；能拿到就以 hwid 为准
  const namingExec = async (cmd) => {
    if (cmd.includes('SPUSBHostDataType')) return { stdout: JSON.stringify({ SPUSBDataType: [
      { _name: 'USB Serial', vendor_id: '0x1a86', product_id: '0x7522' },
      { _name: 'USB JTAG/serial debug unit', vendor_id: '0x303a', product_id: '0x1001' },
    ] }) };
    if (cmd.startsWith('ls /dev/cu')) return { stdout: '/dev/cu.wchusbserial110\n/dev/cu.usbmodem1101\n/dev/cu.QCYMeloBudsN70\n' };
    if (cmd.includes('serial.tools.list_ports')) return { stdout: 'INTERP=\n' };
    if (cmd.includes('kmutil showloaded')) return { stdout: NO_DRIVER_SENTINEL };
    return { stdout: '' };
  };
  const nr = await deviceProbeHandler({ exec: namingExec, platform: 'darwin' });
  const nb = (v, p) => nr.bridges.find((b) => b.vid === v && b.pid === p);
  check('L2：没有 pyserial 时退回命名规则，并明确标注证据等级（不是假装也是 hwid 判的）',
    nb('1a86', '7522')?.verdict === 'ready' && nb('1a86', '7522')?.evidence === 'naming'
    && nb('303a', '1001')?.ports[0] === '/dev/cu.usbmodem1101',
    `${nb('1a86', '7522')?.verdict}/${nb('1a86', '7522')?.evidence}`);
  check('L2：缺 pyserial 要给出可执行建议（装 pyserial 才能钉住 VID:PID）',
    nr.toolchain.pyserial === false && nr.notes.some((n) => n.includes('pyserial')));

  // 这里直接喂 records：只要列表里**还有**任何一条带 hwid 的口，命名兜底就必须关闭
  const authoritative = assessBridges({
    devices: parseUsbTree({ SPUSBDataType: [{ _name: 'USB Serial', vendor_id: '0x1a86', product_id: '0x7522' }] }),
    ports: [
      { port: '/dev/cu.usbmodem1301', real: true, vid: '303a', pid: '1001', serial: '', location: '', chip: 'esp32-native', driver: 'builtin' },
      { port: '/dev/cu.wchusbserial110', real: null, chip: 'ch34x', driver: 'wch-ch34x' },
    ],
    drivers: { ok: true, families: { 'wch-ch34x': false }, labels: { 'wch-ch34x': 'WCH CH34x' } },
  });
  check('L2：hwid 能查的时候它就是权威——不能靠命名把 need-driver 洗成 ready',
    authoritative.bridges[0].verdict === 'need-driver' && authoritative.bridges[0].ports.length === 0,
    `${authoritative.bridges[0].verdict}/${authoritative.bridges[0].evidence}`);

  // ⑦ 三档易混结论
  const dev7522 = parseUsbTree({ SPUSBDataType: [{ _name: 'USB Serial', vendor_id: '0x1a86', product_id: '0x7522' }] });
  const loadedNoPort = assessBridges({ devices: dev7522, ports: [], drivers: { ok: true, families: { 'wch-ch34x': true }, labels: {} } });
  check('L2：驱动在但没出串口 → driver-loaded-no-port，并明确「别装驱动」',
    loadedNoPort.bridges[0].verdict === 'driver-loaded-no-port'
    && loadedNoPort.notes.some((n) => n.includes('不是缺驱动')));
  const unknownDrv = assessBridges({ devices: dev7522, ports: [], drivers: null });
  check('L2：查不到驱动状态时不能给出「确认缺驱动」的硬结论',
    unknownDrv.bridges[0].verdict === 'need-driver' && unknownDrv.bridges[0].driverLoaded === null
    && unknownDrv.bridges[0].advice.includes('未查到'), unknownDrv.bridges[0].advice);
  const dfuDev = parseUsbTree({ SPUSBDataType: [{ _name: 'STM32 BOOTLOADER', vendor_id: '0x0483', product_id: '0xdf11' }] });
  const dfu = assessBridges({ devices: dfuDev, ports: [], drivers: { ok: true, families: {}, labels: {} } });
  check('L2：DFU 模式没有串口是正常的，不能判成缺驱动（最容易被误判的一类）',
    dfu.bridges[0].verdict === 'not-serial' && dfu.bridges[0].advice.includes('不要按「缺驱动」处理'),
    dfu.bridges[0].verdict);
  const unknownDev = parseUsbTree({ SPUSBDataType: [{ _name: 'Mystery', vendor_id: '0xffff', product_id: '0x0001' }] });
  const unk = assessBridges({ devices: unknownDev, ports: [], drivers: { ok: true, families: {}, labels: {} } });
  check('L2：板卡都没认出来时结论是 unknown，不是 need-driver（谈驱动是空话）',
    unk.bridges[0].verdict === 'unknown', unk.bridges[0].verdict);
  // 免驱设备没有串口 ⇒ 不是驱动问题（驱动在系统里，没得装也装不出），是设备当前没进 CDC 模式。
  // 这里刻意让 families.builtin = false（模拟 kmutil 里没看到 cdc，内置驱动按需附着）：
  // 「免驱」的定义就是「不存在『要装驱动』这条路」，所以结论不能被驱动表的有无左右。
  const nativeNoPort = assessBridges({
    devices: parseUsbTree({ SPUSBDataType: [{ _name: 'USB JTAG', vendor_id: '0x303a', product_id: '0x1001' }] }),
    ports: [], drivers: { ok: true, families: { builtin: false }, labels: {} },
  });
  check('L2：免驱设备没出串口 → driver-loaded-no-port（让用户去装驱动是错的建议）',
    nativeNoPort.bridges[0].verdict === 'driver-loaded-no-port'
    && nativeNoPort.bridges[0].advice.includes('CDC'), nativeNoPort.bridges[0].advice);
  // hwid 明确 n/a 的口背后没有 USB 设备，绝不能拿来凑数
  const fakePortOnly = assessBridges({
    devices: parseUsbTree({ SPUSBDataType: [{ _name: 'CP2102', vendor_id: '0x10c4', product_id: '0xea60' }] }),
    ports: [{ port: '/dev/cu.usbserial-1', real: false, chip: 'cp210x-or-ftdi', driver: 'vendor-vcp' }],
    drivers: { ok: true, families: { 'silabs-cp210x': false }, labels: {} },
  });
  check('L2：hwid=n/a 的口不参与任何匹配（否则蓝牙口会被当成板子）',
    fakePortOnly.bridges[0].verdict === 'need-driver' && fakePortOnly.bridges[0].ports.length === 0,
    fakePortOnly.bridges[0].verdict);

  // ⑧ 两块同型号板子：不能第一块吃掉所有口、把第二块判成缺驱动
  const twins = assessBridges({
    devices: parseUsbTree({ SPUSBDataType: [
      { _name: 'USB2.0-Serial', vendor_id: '0x1a86', product_id: '0x7523', serial_num: 'Not Provided' },
      { _name: 'USB2.0-Serial', vendor_id: '0x1a86', product_id: '0x7523', serial_num: 'Not Provided' },
    ] }),
    ports: [
      { port: '/dev/cu.wchusbserial110', real: true, vid: '1a86', pid: '7523', serial: '', location: '1-1', chip: 'ch340', driver: 'wch-ch34x' },
      { port: '/dev/cu.wchusbserial120', real: true, vid: '1a86', pid: '7523', serial: '', location: '1-2', chip: 'ch340', driver: 'wch-ch34x' },
    ],
    drivers: { ok: true, families: { 'wch-ch34x': true }, labels: {} },
  });
  check('L2：两块同型号板子各领一个口（第一块不吞全部，否则第二块假故障）',
    twins.bridges.every((b) => b.verdict === 'ready') && new Set(twins.bridges.flatMap((b) => b.ports)).size === 2,
    JSON.stringify(twins.bridges.map((b) => b.ports)));
  check('L2：VID:PID 相同且无序列号可区分时留痕（可能张冠李戴）',
    twins.notes.some((n) => n.includes('张冠李戴')), JSON.stringify(twins.notes));
}

// ── L3 协议识别 / 刷写通道决策（2026-10-31）：USB 枚举看不出桥芯片背后是什么 MCU ──
{
  const br = (o) => ({
    vid: o.vid, pid: o.pid, name: o.name || '', kind: o.kind, ports: o.ports || [],
    verdict: o.verdict || 'ready', driver: o.driver || 'builtin', advice: o.advice || '',
    evidence: '', driverLoaded: null,
  });
  const EXEC_ALL = { ok: true, have: Object.fromEntries(EXECUTOR_NAMES.map((n) => [n, true])) };

  // ① 结构门禁：新增通道时漏登记执行器 → 立刻红，而不是运行时「这个通道永远 installed=false」
  const channelExecutors = [...new Set(CHANNELS.flatMap((c) => c.executors))];
  check('L3 自检：EXECUTOR_NAMES 覆盖所有通道的 executors（漏登记即红）',
    channelExecutors.every((n) => EXECUTOR_NAMES.includes(n)),
    channelExecutors.filter((n) => !EXECUTOR_NAMES.includes(n)).join(',') || '全覆盖');
  check('L3 自检：探测命令里真的带上了全部执行器名（JS 名单与 shell 名单不漂移）',
    EXECUTOR_NAMES.every((n) => PROBES.darwin.executors.includes(n))
    && PROBES.darwin.executors.includes(EXECUTOR_PROBE_SENTINEL));
  check('L3 自检：未挂通道的执行器恰好是已知例外清单（新增探测名不挂通道 → 红）',
    EXECUTOR_NAMES.filter((n) => !channelExecutors.includes(n)).sort().join(',')
    === UNASSIGNED_EXECUTORS.slice().sort().join(','),
    EXECUTOR_NAMES.filter((n) => !channelExecutors.includes(n)).join(','));
  check('L3 自检：标记 implemented 的通道必须恰好是「代码里真有写入路径」的那几条', 
    // 2026-10-31：uf2-copy 由「未实现」更正为「已实现」——它是最容易被漏的一类，
    // 因为 UF2 不需要外部执行器，implemented=false 不会让任何命令失败，只会让
    // 探测对着插好的 Pico 说「本版本未接线」（说明与实际相反）。
    // 判据不变：多标一个 = 对用户承诺了没实现的烧写；少标一个 = 把已有能力说成没有。
    // 2026-10-31 再改：dfu-util 也进集合（deviceDfuTool 已落地 plan/flash）。这条断言的价值正在于
    // **逼人回来改它**——每加一条写入路径都必须回这里重新声明一次，并想清楚「真的能跑吗」。
    // 字符串按 CHANNELS 的表序，不按改动时间序（曾写成 uf2-copy,dfu-util 而红）。
    CHANNELS.filter((c) => c.implemented).map((c) => c.id).join(',') === 'esptool-serial,dfu-util,uf2-copy',
    CHANNELS.filter((c) => c.implemented).map((c) => c.id).join(','));

  // ② 执行器探测：三种「没有」必须分开
  const exOk = parseExecutors(`HAVE=esptool\nHAVE=adb\n${EXECUTOR_PROBE_SENTINEL}`);
  check('执行器探测：真机形状能认出装了的（esptool/adb），没装的为 false',
    exOk.ok === true && exOk.have.esptool === true && exOk.have.adb === true && exOk.have['dfu-util'] === false);
  check('执行器探测：没有哨兵 → ok=false（命令没跑完不能当「一个都没装」）',
    parseExecutors('HAVE=esptool').ok === false && parseExecutors('').ok === false);
  const injected = parseExecutors(`HAVE=constructor\nHAVE=__proto__\n${EXECUTOR_PROBE_SENTINEL}`);
  check('执行器探测：输出里的非白名单名字不会变成对象键（原型链注入）',
    !Object.prototype.hasOwnProperty.call(injected.have, 'constructor')
    && injected.have.constructor === Object && Object.keys(injected.have).length === EXECUTOR_NAMES.length);

  // ③ 通道判定：certain / probe-required / none 三档
  const espNative = resolveChannels({ bridges: [br({ vid: '303a', pid: '1001', kind: 'serial', ports: ['/dev/cu.usbmodem1301'] })], executors: EXEC_ALL });
  check('L3：Espressif 官方 VID ⇒ certain + 可直接跑（esptool 已实现且已安装）',
    espNative.targets[0].channel === 'esptool-serial' && espNative.targets[0].confidence === 'certain'
    && espNative.targets[0].runnable === true && espNative.primary.channel === 'esptool-serial',
    `${espNative.targets[0].confidence}/${espNative.targets[0].runnable}`);

  const bridgeChip = resolveChannels({ bridges: [br({ vid: '1a86', pid: '7523', kind: 'serial', ports: ['/dev/cu.wchusbserial110'] })], executors: EXEC_ALL });
  check('L3：桥芯片串口只能给「需握手确认」，并列出同口其它协议（STM32/AVR）',
    bridgeChip.targets[0].confidence === 'probe-required'
    && bridgeChip.targets[0].alternatives.map((a) => a.id).join(',') === 'stm32flash-serial,avrdude-serial',
    `${bridgeChip.targets[0].confidence}/${bridgeChip.targets[0].alternatives.length} 个备选`);
  check('L3：需握手的通道必须给出「先跑 chip_id」这个动作（否则用户会直接烧错协议）',
    bridgeChip.targets[0].todo.some((t) => t.includes('chip_id')));

  // ④ 非串口通道：implemented 决定 runnable（2026-10-31 起 dfu-util 也已接线 ⇒ 期望值随之翻）
  const dfu = resolveChannels({ bridges: [br({ vid: '0483', pid: 'df11', kind: 'dfu' })], executors: EXEC_ALL });
  // 这里刻意分开两个判据：targetReady（设备在位、不需要串口）与 runnable（本版本能不能真的执行）。
  // 合成一个布尔值就会让「L4 接好 dfu-util 后仍然不可执行」这种 bug 无从观察。
  check('L3：DFU 通道识别为 dfu-util 且 certain，设备在位且已接线 ⇒ 可执行',
    dfu.targets[0].channel === 'dfu-util' && dfu.targets[0].confidence === 'certain'
    && dfu.targets[0].needsPort === false && dfu.targets[0].targetReady === true
    && dfu.targets[0].implemented === true && dfu.targets[0].runnable === true,
    `${dfu.targets[0].channel}/ready=${dfu.targets[0].targetReady}/impl=${dfu.targets[0].implemented}/run=${dfu.targets[0].runnable}`);
  check('L3：非串口通道不该被「没有串口」判死（needsPort=false 时目标视为就绪）',
    dfu.targets[0].needsPort === false && dfu.targets[0].targetReady === true);
  // 夹具必须用**仍未接线**的通道（SWD）：这条断言原来拿 DFU 当「未实现」样本，
  // DFU 接线后它其实在验证一条已实现的通道——断言还在、语义已经跑了。
  const swd = resolveChannels({ bridges: [br({ vid: '0483', pid: '374b', kind: 'debug-probe' })], executors: EXEC_ALL });
  check('L3：未实现的通道要点明「只能给结论，不能执行」（不能只写 implemented=false 让人自己体会）',
    swd.targets[0].implemented === false && swd.notes.some((n) => n.includes('只能给出结论，不能执行')),
    JSON.stringify(swd.notes));
  const uf2 = resolveChannels({ bridges: [br({ vid: '2e8a', pid: '0003', kind: 'uf2' })], executors: EXEC_ALL });
  check('L3：UF2 不需要外部执行器（纯拷贝），installed 视为 true 而不是「缺工具」',
    uf2.targets[0].channel === 'uf2-copy' && uf2.targets[0].executor === null && uf2.targets[0].installed === true
    && uf2.targets[0].targetReady === true);
  // 2026-10-31 补：implemented 转正之后，UF2 目标必须真的报 runnable。
  // 只改标志不加这条，就等于「改了数据没验行为」——而 runnable 正是模型/面板据以
  // 判断「现在能不能动手」的那一位（executor 为 null、needsPort 为 false 两条特殊
  // 分支任一写错，runnable 都会是 false 而上面那条断言照样绿）。
  check('L3：UF2 目标在位时必须报 runnable（不需要执行器、不需要串口这两个特例都要走过）',
    uf2.targets[0].runnable === true, `${uf2.targets[0].runnable}`);
  const probeDev = resolveChannels({ bridges: [br({ vid: '0483', pid: '3748', kind: 'debug-probe' })], executors: EXEC_ALL });
  check('L3：调试探针走 SWD 兜底通道', probeDev.targets[0].channel === 'openocd-swd');

  // ⑤ 三种「不知道」必须分开
  check('L3：执行器未探测时 installed 是 null（未知），不是 false（没装）',
    resolveChannels({ bridges: [br({ vid: '303a', pid: '1001', kind: 'serial', ports: ['/dev/cu.usbmodem1'] })], executors: null })
      .targets[0].installed === null);
  check('L3：探测没跑完（ok=false）时同样只能给 null',
    resolveChannels({ bridges: [br({ vid: '303a', pid: '1001', kind: 'serial', ports: ['/dev/cu.usbmodem1'] })], executors: { ok: false, have: {} } })
      .targets[0].installed === null
    && resolveChannels({ bridges: [br({ vid: '303a', pid: '1001', kind: 'serial', ports: ['/dev/cu.usbmodem1'] })], executors: { ok: false, have: {} } })
      .notes.some((n) => n.includes('不能当成「没装」')));
  const noExe = resolveChannels({ bridges: [br({ vid: '303a', pid: '1001', kind: 'serial', ports: ['/dev/cu.usbmodem1'] })], executors: { ok: true, have: {} } });
  check('L3：执行器确实没装 → installed=false + 给出安装命令 + 不可执行',
    noExe.targets[0].installed === false && noExe.targets[0].runnable === false
    && noExe.targets[0].todo.some((t) => t.includes('pip install esptool')));

  // ⑥ 没有串口时不要硬给通道，把 L2 的结论带下去
  const noPort = resolveChannels({
    bridges: [br({ vid: '1a86', pid: '7522', kind: 'serial', ports: [], verdict: 'need-driver', advice: '需装驱动：WCH CH34x' })],
    executors: EXEC_ALL,
  });
  check('L3：串口不可用时不给通道，todo 直接抄 L2 的解决办法（不重复推理、不改写结论）',
    noPort.targets[0].channel === null && noPort.targets[0].runnable === false
    && noPort.targets[0].todo[0].includes('WCH CH34x') && noPort.primary === null,
    JSON.stringify(noPort.targets[0].todo));
  const withHub = resolveChannels({
    bridges: [
      br({ vid: '1a86', pid: '8091', kind: 'hub', verdict: 'ignored' }),
      br({ vid: '303a', pid: '1001', kind: 'serial', ports: ['/dev/cu.usbmodem1301'] }),
    ],
    executors: EXEC_ALL,
  });
  check('L3：集线器不产生通道目标（上游已判 ignored，下游不该再出现）',
    withHub.targets.length === 1 && withHub.targets[0].vid === '303a');

  // ⑦ primary 的选择：能跑的一定优先于「需握手」的，否则用户会被指向一块开不了的口
  const mixed = resolveChannels({
    bridges: [
      br({ vid: '1a86', pid: '7523', kind: 'serial', ports: ['/dev/cu.wchusbserial110'] }),
      br({ vid: '303a', pid: '1001', kind: 'serial', ports: ['/dev/cu.usbmodem1301'] }),
    ],
    executors: EXEC_ALL,
  });
  check('L3：两块都能跑时 primary 优先身份确定的（certain），而不是先枚举到的需握手设备',
    mixed.primary.vid === '303a' && mixed.primary.runnable === true, `${mixed.primary.vid}/${mixed.primary.runnable}`);

  // ⑧ 端到端：真机夹具走完整条链，primary 必须是可跑的那条
  const e2e = await deviceProbeHandler({ exec: hostExec, platform: 'darwin' });
  check('L3 端到端：真机设备树 → primary 是 esptool-serial 且可执行，端口就是那条真口',
    e2e.primaryChannel?.channel === 'esptool-serial' && e2e.primaryChannel?.runnable === true
    && e2e.primaryChannel?.ports[0] === '/dev/cu.usbmodem1301',
    `${e2e.primaryChannel?.channel}/${e2e.primaryChannel?.ports}`);
  check('L3 端到端：需装驱动的那块（CH34x 无口）不产生可执行通道',
    e2e.channels.find((t) => t.vid === '1a86' && t.pid === '7522')?.runnable === false);
}

// ── L4 UF2 写入通道（2026-10-31）：全程用内存文件系统，不碰任何真实磁盘/硬件 ──
// 这一层最容易出的事故不是刷坏，而是**拷错地方还看起来完成了**，所以断言集中在「怎么证明我真写对了」。
{
  /** 造一个合法 UF2 文件（结构完全按 spec：三个魔数 + 512 块 + 连续块号）。 */
  function makeUf2({ blocks = 2, payload = 256 } = {}) {
    const buf = Buffer.alloc(512 * blocks);
    for (let i = 0; i < blocks; i += 1) {
      const off = i * 512;
      buf.writeUInt32LE(0x0a324655, off);
      buf.writeUInt32LE(0x9e5d5157, off + 4);
      buf.writeUInt32LE(0, off + 8);
      buf.writeUInt32LE(0x10000000 + i * payload, off + 12);
      buf.writeUInt32LE(payload, off + 16);
      buf.writeUInt32LE(i, off + 20);
      buf.writeUInt32LE(blocks, off + 24);
      buf.writeUInt32LE(blocks * payload, off + 28);
      for (let k = 0; k < payload; k += 1) buf[off + 32 + k] = (i * 7 + k) & 0xff;
      buf.writeUInt32LE(0x0fe47c6b, off + 508);
    }
    return buf;
  }

  /**
   * 内存文件系统：只实现 handler 用到的 6 个方法。
   * 刻意不用真实临时目录——那样「卷消失」要真去卸载盘，测不了。
   */
  function makeFakeFs({ files = {}, dirs = {}, rebootOnCopy = false, freeBytes = null, corruptCopy = false } = {}) {
    const F = new Map(Object.entries(files));
    const D = new Map(Object.entries(dirs).map(([k, v]) => [k, new Set(v)]));
    const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
    return {
      statSync(p) {
        if (F.has(p)) return { isFile: () => true, isDirectory: () => false, size: F.get(p).length };
        if (D.has(p)) return { isFile: () => false, isDirectory: () => true };
        const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e;
      },
      readFileSync(p) {
        if (!F.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
        return F.get(p);
      },
      readdirSync(p) {
        if (!D.has(p)) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
        return [...D.get(p)];
      },
      existsSync: (p) => F.has(p) || D.has(p),
      copyFileSync(src, dst) {
        const buf = F.get(src);
        F.set(dst, corruptCopy ? buf.subarray(0, Math.floor(buf.length / 2)) : buf);
        D.get(parent(dst))?.add(dst.slice(dst.lastIndexOf('/') + 1));
        if (rebootOnCopy) { D.delete(parent(dst)); F.delete(dst); } // 模拟 bootloader 写完重启、卷卸载
      },
      statfsSync: () => ({ bavail: freeBytes === null ? 100000 : Math.floor(freeBytes / 512), bsize: 512 }),
    };
  }
  const VOL = '/Volumes/RPI-RP2';
  const baseDirs = { '/Volumes': ['RPI-RP2'], [VOL]: [UF2_VOLUME_MARKER] };
  const UFW = '/tmp/fw.uf2';
  const uf2Buf = makeUf2();
  const mkFs = (over = {}) => makeFakeFs({ files: { [UFW]: uf2Buf, ...(over.files || {}) }, dirs: { ...baseDirs, ...(over.dirs || {}) }, ...over });
  const fastClocks = () => { let t = 0; return { now: () => t, sleep: async () => { t += 500; } }; };

  // ① 结构校验：这是「把 .bin 改名成 .uf2」唯一能挡住的地方
  check('UF2：合法文件通过校验，块数与载荷都算对',
    parseUf2(makeUf2({ blocks: 3, payload: 200 })).ok === true
    && parseUf2(makeUf2({ blocks: 3, payload: 200 })).blocks === 3
    && parseUf2(makeUf2({ blocks: 3, payload: 200 })).payloadBytes === 600);
  check('UF2：长度不是 512 整数倍 → 拒绝（截断的文件 bootloader 会静默忽略）',
    parseUf2(Buffer.alloc(700)).ok === false && parseUf2(Buffer.alloc(700)).error.includes('512'));
  const renamedBin = Buffer.alloc(1024); renamedBin.fill(0xff);
  check('UF2：把 .bin 改名成 .uf2 会被魔数挡住，并提示改回 .bin',
    parseUf2(renamedBin).ok === false && parseUf2(renamedBin).error.includes('.bin'),
    parseUf2(renamedBin).error.slice(0, 40));
  const badOrder = makeUf2({ blocks: 2 }); badOrder.writeUInt32LE(5, 512 + 20);
  check('UF2：块号与位置不符 → 拒绝（块顺序被破坏，拼不回来）',
    parseUf2(badOrder).ok === false && parseUf2(badOrder).error.includes('blockNo'));
  const truncated = makeUf2({ blocks: 3 });
  check('UF2：声明块数多于实际块数 → 拒绝并点明「截断」',
    parseUf2(truncated.subarray(0, 1024)).ok === false
    && parseUf2(truncated.subarray(0, 1024)).error.includes('截断'), parseUf2(truncated.subarray(0, 1024)).error);
  check('UF2：空文件 / 空载荷都拒绝', parseUf2(Buffer.alloc(0)).ok === false);

  // ② 卷判定：靠盘上的 INFO_UF2.TXT，不靠卷名
  check('UF2 卷：盘根有 INFO_UF2.TXT 才算 bootloader 盘（卷名可以改，这个文件是 bootloader 自己写的）',
    isUf2Volume({ path: VOL, files: [UF2_VOLUME_MARKER] }) === true
    && isUf2Volume({ path: '/Volumes/RPI-RP2', files: ['README.TXT'] }) === false);
  check('UF2 卷：系统卷一律不算（把固件拷进启动盘是最坏的一种「拷错地方」）',
    isUf2Volume({ path: '/', files: [UF2_VOLUME_MARKER], isRoot: true }) === false);
  const picked = pickUf2Volume([{ path: VOL, files: [UF2_VOLUME_MARKER] }]);
  check('UF2 卷：唯一命中时直接选中', picked.ok === true && picked.volume === VOL);
  const twoVols = pickUf2Volume([{ path: '/Volumes/A', files: [UF2_VOLUME_MARKER] }, { path: '/Volumes/B', files: [UF2_VOLUME_MARKER] }]);
  check('UF2 卷：两个盘同时插着时**不猜**，要求显式指定',
    twoVols.ok === false && String(twoVols.error || '').includes('显式指定'), String(twoVols.error || '').slice(0, 40));
  check('UF2 卷：找不到时给出 BOOTSEL 操作指引（不是一个干巴巴的报错）',
    String(pickUf2Volume([{ path: '/Volumes/X', files: [] }]).error || '').includes('BOOTSEL'));

  // ③ 计划与摘要
  check('UF2 计划：把 .bin 送进 UF2 通道会被拒绝（反向格式闸，两个方向都要拦）',
    buildUf2Plan({ firmware: '/tmp/a.bin', volume: VOL, fileSize: 1024 }).ok === false);
  check('UF2 计划：缺目标卷直接拒绝（不自动挑，挑错就是把 A 的固件写进 B）',
    buildUf2Plan({ firmware: UFW, volume: '', fileSize: 1024 }).ok === false);
  const planOk = buildUf2Plan({ firmware: UFW, volume: VOL, fileSize: uf2Buf.length, parsed: parseUf2(uf2Buf) });
  check('UF2 计划：审批卡五要素齐全且标记为不可逆（reversible=false）',
    planOk.ok === true && planOk.card.reversible === false && planOk.card.level === 'never'
    && Boolean(planOk.card.target && planOk.card.impact && planOk.card.consequence && planOk.card.rollback));
  check('UF2 摘要：换目标卷 digest 必变（否则「看过 A 计划、写 B」能复用旧摘要）',
    uf2PlanDigest({ firmware: UFW, volume: VOL, fileSize: 1024 })
    !== uf2PlanDigest({ firmware: UFW, volume: '/Volumes/OTHER', fileSize: 1024 }));

  // ④ 执行器：注入内存 fs，把「写成功」的三条判据逐条压出来
  const c1 = fastClocks();
  const planRes = await uf2ChannelHandler({ action: 'plan', firmware: UFW }, { fsx: mkFs(), platform: 'darwin', ...c1 });
  check('UF2 执行：plan 自动找到唯一 bootloader 盘并返回 digest',
    planRes.ok === true && planRes.channel === 'uf2-copy' && planRes.volume === VOL && Boolean(planRes.plan_digest));

  const c2 = fastClocks();
  const flashOk = await uf2ChannelHandler(
    { action: 'flash', firmware: UFW, plan_digest: planRes.plan_digest },
    { fsx: mkFs({ rebootOnCopy: true }), platform: 'darwin', ...c2 },
  );
  check('UF2 执行：写入成功 + 落盘字节一致 + 卷消失（设备重启）三个条件同时满足才 ok',
    flashOk.ok === true && flashOk.rebooted === true && flashOk.sizeBytes === uf2Buf.length,
    `ok=${flashOk.ok} rebooted=${flashOk.rebooted} size=${flashOk.sizeBytes}`);

  const c3 = fastClocks();
  const noReboot = await uf2ChannelHandler(
    { action: 'flash', firmware: UFW, plan_digest: planRes.plan_digest },
    { fsx: mkFs({ rebootOnCopy: false }), platform: 'darwin', ...c3 },
  );
  check('UF2 执行：文件写了但设备没重启 → ok 但 rebooted=false 且明确告警（不能当成完全成功）',
    noReboot.ok === true && noReboot.rebooted === false
    && noReboot.warnings.some((w) => w.includes('没有重启')), JSON.stringify(noReboot.warnings));
  check('UF2 执行：落盘字节数不符 → 失败（盘满/被截断绝不能算成功）',
    String((await uf2ChannelHandler(
      { action: 'flash', firmware: UFW, plan_digest: planRes.plan_digest },
      { fsx: mkFs({ corruptCopy: true, rebootOnCopy: false }), platform: 'darwin', ...fastClocks() },
    )).error || '').includes('落盘字节数不符'));
  check('UF2 执行：缺 digest / digest 不符都拒绝（前者没给人看过，后者参数变过）',
    String((await uf2ChannelHandler({ action: 'flash', firmware: UFW }, { fsx: mkFs(), platform: 'darwin', ...fastClocks() })).error || '').includes('plan_digest')
    && String((await uf2ChannelHandler({ action: 'flash', firmware: UFW, plan_digest: 'deadbeef' }, { fsx: mkFs(), platform: 'darwin', ...fastClocks() })).error || '').includes('不匹配'));

  // ⑤ 注入面：目标卷必须在系统挂载根下，否则这就是一个任意文件拷贝原语
  check('UF2 安全：目标卷在 /Volumes 之外一律拒绝（否则模型可以传 volume=~/Desktop 覆盖任意文件）',
    isAllowedVolumePath('/tmp/evil', 'darwin') === false
    && isAllowedVolumePath('/Volumes', 'darwin') === false
    && isAllowedVolumePath('/Volumes/RPI-RP2', 'darwin') === true);
  check('UF2 安全：目标卷没有 INFO_UF2.TXT → 拒绝（防止拷进普通 U 盘/磁盘映像，那样什么也不会发生）',
    String((await uf2ChannelHandler(
      { action: 'plan', firmware: UFW, volume: '/Volumes/untitled' },
      { fsx: mkFs({ dirs: { '/Volumes': ['RPI-RP2', 'untitled'], '/Volumes/untitled': ['photo.jpg'] } }), platform: 'darwin', ...fastClocks() },
    )).error || '').includes(UF2_VOLUME_MARKER));

  // ⑥ 与 device_flash 的分流：靠文件格式决定通道，不靠调用方声明
  const deps = { exec: async () => ({ stdout: '' }), platform: 'darwin', run: async () => ({ code: 0 }) };
  const uf2Plan = await deviceFlashHandler({ action: 'plan', firmware: UFW, volume: VOL }, { ...deps, fsx: mkFs() });
  check('分流：action=plan + .uf2 → 自动走 UF2 通道（即使没给 port）',
    uf2Plan.ok === true && uf2Plan.channel === 'uf2-copy', `${uf2Plan.ok}/${uf2Plan.channel || uf2Plan.error}`);
  const uf2Verify = await deviceFlashHandler({ action: 'verify', firmware: UFW }, { ...deps, fsx: mkFs() });
  check('分流：.uf2 调 verify 明确拒绝（bootloader 盘只写不读），不是静默去跑 esptool',
    uf2Verify.ok === false && String(uf2Verify.error || '').includes('只写不读'));
  const hexPlan = await deviceFlashHandler({ action: 'plan', port: '/dev/cu.usbmodem1301', firmware: '/tmp/a.hex' }, {
    ...deps,
    stat: (p) => ({ isFile: () => true, size: 1024, ...(p.endsWith('.hex') ? {} : {}) }),
  });
  check('分流：.hex 被格式闸拦下并给出 objcopy 转换命令（文本格式不能当裸二进制写）',
    hexPlan.ok === false && /objcopy/.test(hexPlan.error), hexPlan.error?.slice(0, 60));
  const hexInner = inspectSegments([{ offset: '0x0', file: '/tmp/a.hex' }], { stat: () => ({ isFile: () => true, size: 1024 }) });
  check('格式闸（内层）：inspectSegments 自己也拦 .hex——外层早拒与内层闸必须都能独立生效',
    hexInner.ok === false && /objcopy/.test(hexInner.errors.join(' ')), hexInner.errors.join(' ').slice(0, 50));
  check('格式闸：.bin 放行、.uf2/.hex 硬拒、未知扩展名只告警（不能把合法用法拦死）',
    esptoolFormatCheck('/a/b.bin').ok === true
    && esptoolFormatCheck('/a/b.uf2').ok === false && esptoolFormatCheck('/a/b.hex').ok === false
    && esptoolFormatCheck('/a/noext').ok === true && Boolean(esptoolFormatCheck('/a/noext').warning));
  check('格式表：.img 归到磁盘通道而不是串口（整盘镜像写串口 flash 是另一类错）',
    resolveImageFormat('/a/card.img').channel === 'disk');
  // 审批卡只渲染 tool + target（不展参数）⇒ 会写到哪块盘**只能**出现在 target 里
  const approval = require('../main/approval.js');
  check('审批目标：UF2 动作的目标串是「卷 ← 文件」（没有串口，用户只能靠这个核对会写到哪块盘）',
    approval.approvalTarget('device_flash', { action: 'flash', firmware: '/tmp/a.uf2', volume: '/Volumes/RPI-RP2' })
      === '/Volumes/RPI-RP2 ← /tmp/a.uf2');
  check('审批目标：UF2 但没给卷时明说「自动找」，不能显示成空目标让人以为没有目标',
    approval.approvalTarget('device_flash', { action: 'flash', firmware: '/tmp/a.uf2' }).includes('自动找'));
  check('审批目标：.bin 仍走原来的「串口 ← 文件」（别为了 UF2 把串口分支改坏）',
    approval.approvalTarget('device_flash', { action: 'flash', port: '/dev/cu.a', firmware: '/tmp/f.bin' })
      === '/dev/cu.a ← /tmp/f.bin');
}

// ── L4b：chip_id 握手（2026-10-31）────────────────────────────────────────────
// 目标：把 probe-required 从「提示用户去命令行查」变成「工具自己问清」。
// 下面四段输出里，①③ 是**真机实测原文**（本机 ESP32-S3 / 不存在的口），②④ 是按 esptool
// 已知失败形态构造的——本机没有 STM32 板，造不出来就只能标注来源，不能假装实测过。
{
  const approval = require('../main/approval.js');
  const HS_OK = [
    'esptool v5.6.0',
    'Serial port /dev/cu.usbmodem1301:',
    'Connecting...',
    'Detecting chip type... ESP32-S3',
    'Connected to ESP32-S3 on /dev/cu.usbmodem1301:',
    'Chip type:          ESP32-S3 (QFN56) (revision v0.2)',
    'Features:           Wi-Fi, BT 5 (LE), Dual Core + LP Core, 240MHz, Embedded PSRAM 8MB (AP_3v3)',
    'Crystal frequency:  40MHz',
    'USB mode:           USB-Serial/JTAG',
    'MAC:                d0:cf:13:06:dc:74',
    'Uploading stub flasher...',
    'Running stub flasher...',
    'Stub flasher running.',
    'Flash Memory Information:',
    '=========================',
    'Manufacturer: 46',
    'Device: 4018',
    'Detected flash size: 16MB',
    'Flash type set in eFuse: quad (4 data lines)',
    'Hard resetting via RTS pin...',
  ].join('\n');

  // 真机实测（2026-10-31，/dev/cu.doesnotexist0）
  const HS_PORT = [
    'esptool v5.6.0',
    'Serial port /dev/cu.wchusbserial110:',
    '',
    'ERROR: A fatal error occurred: Could not open /dev/cu.wchusbserial110, the port is busy or doesn\'t exist.',
    '([Errno 2] could not open port /dev/cu.wchusbserial110: [Errno 2] No such file or directory)',
    '',
    'Hint: Check if the port is correct and ESP connected',
  ].join('\n');

  // 构造：ESP 板没有自动复位电路时 esptool 的报法（文档 §5.2 / esptool 源码 boot mode 判定）
  const HS_NOBOOT = 'A fatal error occurred: Failed to connect to ESP32-S3: Wrong boot mode detected (0x3)! '
    + 'The chip needs to be in download mode.';
  // 构造：完全没响应（非 ESP 或 ESP 停在 app 模式，两者输出同形 —— 这正是不能下结论的原因）
  const HS_NODATA = 'A fatal error occurred: Failed to connect to ESP32: No serial data received.';

  // ① 解析：成功形态
  const hsOk = parseHandshake(HS_OK);
  check('握手解析：真机输出 → 判定为 ESP，并取出芯片名 / chipKey / MAC / flash 容量',
    hsOk.verdict === HANDSHAKE_VERDICTS.esp && hsOk.esp === true
    && hsOk.chip === 'ESP32-S3 (QFN56)' && hsOk.chipKey === 'esp32s3'
    && hsOk.mac === 'd0:cf:13:06:dc:74' && hsOk.flashSizeBytes === 16 * 1024 ** 2,
    `${hsOk.chip}/${hsOk.chipKey}/${hsOk.mac}/${hsOk.flashSizeBytes}`);
  check('握手解析：`Detecting chip type...` 这一行单独也能定身份（Chip type 行格式变了不至于全丢）',
    parseHandshake(HS_OK.split('\n').filter((l) => !l.startsWith('Chip type:')).join('\n')).esp === true);

  // ② 解析：三种失败必须分开，且**都不能**给出「不是 ESP」这种结论
  const hsPort = parseHandshake(HS_PORT);
  check('握手解析：打不开串口 → port-error，且 esp=false（端口问题与芯片身份无关）',
    hsPort.verdict === HANDSHAKE_VERDICTS.port && hsPort.esp === false, hsPort.verdict);
  const hsBoot = parseHandshake(HS_NOBOOT);
  check('握手解析：Wrong boot mode → 仍判定为 ESP（esptool 认出了 boot mode 才这么报），identity 确定',
    hsBoot.verdict === HANDSHAKE_VERDICTS.needBoot && hsBoot.esp === true && hsBoot.chipKey === 'esp32s3', hsBoot.chip);
  const hsData = parseHandshake(HS_NODATA);
  check('握手解析：没响应 → no-response，**不能**判成「不是 ESP」（STM32 与没进下载模式的 ESP 输出同形）',
    hsData.verdict === HANDSHAKE_VERDICTS.noResponse && hsData.esp === false && hsData.chip === '');
  check('握手解析：动词顺序 —— 端口占用信息里也带 failed to connect，必须先判 port-error',
    parseHandshake(`Failed to connect: Could not open /dev/cu.x, the port is busy`).verdict === HANDSHAKE_VERDICTS.port);
  check('握手解析：空输出 → unknown（不是「没设备」也不是「没响应」，就是没结论）',
    parseHandshake('').verdict === HANDSHAKE_VERDICTS.unknown);

  // ③ chipKey 映射：键对不上会静默退回默认波特率，那正是「烧到一半」的来源
  check('chipKey：ESP32-D0WD-V3 命中 esp32，ESP32-S3 命中 esp32s3（最长前缀，短键不许抢）',
    chipKeyOf('ESP32-D0WD-V3') === 'esp32' && chipKeyOf('ESP32-S3') === 'esp32s3'
    && chipKeyOf('esp32c6') === 'esp32c6');
  check('chipKey：CHIP_ARGS 没登记的型号给空串（不猜一个近似的去用错波特率）',
    chipKeyOf('ESP8266EX') === '' && chipKeyOf('') === '');

  // ④ 执行器接线：注入 run，绝不真连板子
  const hsArgs = [];
  const hsRun = (text, code = 0) => async (argv) => { hsArgs.push(argv); return { code, stdout: text, stderr: '' }; };
  const hsDeps = (text, code = 0) => ({ exec: hostExec, platform: 'darwin', run: hsRun(text, code) });
  const P = '/dev/cu.usbmodem1301';

  const okRes = await deviceFlashHandler({ action: 'chip_id', port: P }, hsDeps(HS_OK));
  check('握手接线：成功时 ok=true、通道锁定 esptool-serial、chipKey 可直接喂给 plan',
    okRes.ok === true && okRes.channel === 'esptool-serial' && okRes.confidence === 'certain'
    && okRes.chipKey === 'esp32s3' && String(okRes.next).includes('action=plan'), `${okRes.ok}/${okRes.channel}`);
  check('握手接线：argv 用 `--chip auto`（由芯片自己报身份），不写死型号 —— 写死就只能得到「连不上」',
    hsArgs.length > 0 && hsArgs[0].includes('--chip') && hsArgs[0][hsArgs[0].indexOf('--chip') + 1] === 'auto',
    JSON.stringify(hsArgs[0] || []));
  check('握手接线：argv 里**不含任何写/读 flash 的子命令**（这一步只问身份，不碰 flash 内容）',
    !hsArgs.some((a) => a.some((x) => /write[-_]flash|read[-_]flash|erase[-_]flash/.test(String(x)))),
    JSON.stringify(hsArgs[0] || []));

  const bootRes = await deviceFlashHandler({ action: 'chip_id', port: P }, hsDeps(HS_NOBOOT, 2));
  check('握手接线：没进下载模式 → ok=false 但 confidence 仍是 certain（身份已确定，只是读不到容量）',
    bootRes.ok === false && bootRes.confidence === 'certain' && bootRes.channel === 'esptool-serial'
    && String(bootRes.error).includes('下载模式'), bootRes.error?.slice(0, 40));

  const portRes2 = await deviceFlashHandler({ action: 'chip_id', port: P }, hsDeps(HS_PORT, 2));
  check('握手接线：端口打不开 → 明说「与芯片身份无关」，不许让用户去换板子/重刷',
    portRes2.ok === false && String(portRes2.error).includes('这与芯片身份无关'));

  const dataRes = await deviceFlashHandler({ action: 'chip_id', port: P }, hsDeps(HS_NODATA, 2));
  check('握手接线：没响应 → 明说「不能据此判定它不是 ESP」，并指到同口的 stm32flash/avrdude',
    dataRes.ok === false && String(dataRes.error).includes('不能据此判定它不是 ESP')
    && String(dataRes.error).includes('stm32flash'), dataRes.error?.slice(0, 50));

  check('握手接线：缺 port 直接拒（不猜一个口去对话）',
    String((await deviceFlashHandler({ action: 'chip_id' }, hsDeps(HS_OK))).error || '').includes('缺少 port'));
  // 白名单：与 flash 共用同一道闸。蓝牙虚拟口在系统里真实存在，但绝不是板子。
  const btRes = await deviceFlashHandler({ action: 'chip_id', port: '/dev/cu.QCYMeloBudsN70' }, hsDeps(HS_OK));
  check('握手接线：非可刷机串口被同一道硬闸拦住（蓝牙耳机口不能被当成板子去对话）',
    btRes.ok === false && String(btRes.error).includes('探测') && String(btRes.error).includes('可刷'), btRes.error?.slice(0, 50));

  // ⑤ 审批：与 verify/backup 同档（都会把芯片复位进 bootloader，同形的事不能两套分级）
  check('审批：chip_id 与 verify/backup 同为 L1（碰硬件、要复位，不因「只读」降档）',
    approval.toolLevel('device_flash', { action: 'chip_id' }) === 'L1'
    && approval.toolLevel('device_flash', { action: 'verify' }) === 'L1'
    && approval.toolLevel('device_flash', { action: 'backup' }) === 'L1');
  check('审批目标：chip_id 的卡面是「探测 <口>」（不写这一支会渲染成「/dev/x ← 」这种空目标）',
    approval.approvalTarget('device_flash', { action: 'chip_id', port: '/dev/cu.x' }) === '探测 /dev/cu.x');

  // ⑥ 决策层的 todo 必须指向真实可调的动作，而不是让用户手敲命令
  const bridged = resolveChannels({
    bridges: [{
      verdict: 'ready', kind: 'serial', vid: '1a86', pid: '7523', name: 'CH340', ports: ['/dev/cu.wchusbserial110'],
    }],
    executors: { ok: true, have: { esptool: true } },
  });
  check('L3 → L4b 闭环：需握手时 todo 直接给出 `device_flash action=chip_id port=…`（含具体口）',
    bridged.primary.todo.some((t) => t.includes('action=chip_id') && t.includes('/dev/cu.wchusbserial110')),
    JSON.stringify(bridged.primary.todo));
}

// ── L5 验证反馈：抓串口启动输出（2026-10-31）──────────────────────────────────
// 目标：回答「烧完到底跑起来了没有」。verify 只证明字节写对，这一层才证明固件在跑。
// 下面的 BOOT_LOG 是**真机原文**（ESP32-S3 / /dev/cu.usbmodem1301，行尾是真实的 CRLF），
// download / 乱码两种形态本机造不出来（要按住 BOOT 或换 UART 桥口），标注为构造。
{
  const approval = require('../main/approval.js');
  const { parseCapture, expectTokens, analyzeLog, CAPTURE_SCRIPT, VERDICTS } = require('../main/deviceSerial.js');

  const BOOT_LOG = [
    'ESP-ROM:esp32s3-20210327',
    'Build:Mar 27 2021',
    'rst:0x15 (USB_UART_CHIP_RESET),boot:0xb (SPI_FAST_FLASH_BOOT)',
    'Saved PC:0x40381762',
    'SPIWP:0xee',
    'mode:DIO, clock div:1',
    'load:0x3fce2820,len:0x548',
    'load:0x403c8700,len:0xc3c',
    'load:0x403cb700,len:0x2d9c',
    'entry 0x403c8908',
    'I (35) octal_psram: vendor id    : 0x0d (AP)',
    'I (8180) Assets: The checksum calculation time is 94 ms',
    'I (8190) MODEL_LOADER: Successfully load srmodels',
  ].join('\r\n');
  // 真机首跑的实际开头：打开端口时驱动缓冲里还压着上一份固件的尾流，复位只是把新内容接在后面
  const STALE_PREFIX = 'I (5940) wifi:new:<1,1>, old:<1,0>, ap:<255,255>, sta:<1,1>, pro';
  const capOut = (text) => {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    return `MJCODE_CAP_BEGIN\n${b64}\nMJCODE_CAP_END ${Buffer.byteLength(text, 'utf8')}\n`;
  };
  // 最近一次 run 收到的 argv（用来钉「脚本是单个 argv 元素」这条注入面结论）
  let lastArgv = [];
  const logsDeps = (stdout) => ({
    exec: hostExec, platform: 'darwin',
    run: async (argv) => { lastArgv = argv; return { code: 0, stdout }; },
  });
  const P = '/dev/cu.usbmodem1301';

  // ① 启动判据：看的是启动链路证据，不是「有输出」
  const booted = analyzeLog({ buf: Buffer.from(BOOT_LOG), expect: [] });
  check('L5：真机启动日志 → verdict=booted，且 rom / entry / IDF 三类证据都识别到',
    booted.verdict === VERDICTS.booted && booted.signals.rom && booted.signals.entry && booted.signals.idfLog
    && booted.signals.download === false, JSON.stringify(booted.signals));
  check('L5：0 字节 → no-output（不是「启动成功」也不是「崩溃」，就是没说话）',
    analyzeLog({ buf: Buffer.alloc(0) }).verdict === VERDICTS.noOutput);
  check('L5：有输出但无启动证据 → unknown-output（不乱判成 booted）',
    analyzeLog({ buf: Buffer.from('hello from some other device\n') }).verdict === VERDICTS.unknown);
  // 下载模式下 ROM 横幅照样会打 ⇒ 必须先判 download，否则「没跑 app」被误报成「启动成功」
  const dl = analyzeLog({ buf: Buffer.from(`${BOOT_LOG}\r\nwaiting for download\r\n`) });
  check('L5：停在下载模式 → 优先判 download-mode（即使同时有 ROM 横幅，也不能算启动成功）',
    dl.verdict === VERDICTS.download && dl.signals.rom === true);

  // ② 复位前残留必须切掉：否则上一份固件的日志能冒充本次启动、把 expect 蒙混过去
  const withStale = analyzeLog({ buf: Buffer.from(`${STALE_PREFIX}${BOOT_LOG}`), expect: ['wifi:new', 'octal_psram'] });
  check('L5：复位前残留被排除在判据外（旧日志里的 wifi:new 不能命中本轮的 expect）',
    withStale.staleBytes > 0 && withStale.expect.missing.includes('wifi:new')
    && withStale.expect.matched.includes('octal_psram'), JSON.stringify(withStale.expect));
  check('L5：锚点必须优先取 ROM 横幅 —— 取「最后一个锚点」会把横幅自己切掉，rom 证据就没了',
    withStale.signals.rom === true);
  check('L5：没有横幅时用 rst:0x 兜底（ESP32 经典款只打 ets/ rst 行，没有 ESP-ROM）',
    analyzeLog({ buf: Buffer.from('ets Jun  8 2016 00:22:57\r\nrst:0x1 (POWERON_RESET)\r\nI (12) boot: ok\r\n') })
      .staleBytes === 0);

  // ③ expect 解析：上限不是洁癖 —— 塞进一大段文本会让「全部命中」永远为假，判据等于没有
  check('L5：expect 支持 | , 换行分隔、去重、去空白、去空项',
    JSON.stringify(expectTokens(' Ready | wifi ,  Ready \n\n boot ')) === JSON.stringify(['Ready', 'wifi', 'boot']));
  check('L5：expect 最多 8 条、每条截 80 字（超长输入不能让判据恒假）',
    expectTokens(Array.from({ length: 20 }, (_, i) => `t${i}`).join('|')).length === 8
    && expectTokens('x'.repeat(200)).every((t) => t.length <= 80));
  check('L5：expect 为空/缺省 → 空数组（不能变成「零个期望 = 全部通过」的假绿）',
    expectTokens('').length === 0 && expectTokens(undefined).length === 0);

  // ④ 抓取输出解析：长度自检挡住「base64 被截断但 Buffer.from 不报错」
  const parsed = parseCapture(capOut(BOOT_LOG));
  check('L5 解析：正常输出 → 字节数一致', parsed.ok === true && parsed.bytes === Buffer.byteLength(BOOT_LOG));
  const truncated = capOut(BOOT_LOG).replace(/MJCODE_CAP_END \d+/, 'MJCODE_CAP_END 999999');
  check('L5 解析：声明字节与实际不符 → 报「采集被截断」，不许当成 0 字节输出（那会变成「设备没说话」）',
    parseCapture(truncated).ok === false && String(parseCapture(truncated).error).includes('长度不符'));
  check('L5 解析：没有抓取标记（脚本半路死了）→ 明确报工具问题，不与「没输出」同形',
    String(parseCapture('Traceback: somehow died').error).includes('没有找到抓取标记'));
  check('L5 解析：缺 pyserial 与端口打不开是两条不同的路（前者装库，后者查占用）',
    String(parseCapture('MJCODE_CAP_NO_PYSERIAL').error).includes('pyserial')
    && parseCapture('MJCODE_CAP_OPEN_FAIL SerialException: busy').portError === true);

  // ⑤ 执行器接线（注入 run，绝不真开串口）
  const d1 = logsDeps(capOut(BOOT_LOG));
  const okRes = await deviceFlashHandler({ action: 'logs', port: P, expect: 'ESP-ROM|octal_psram' }, d1);
  check('L5 接线：抓到启动日志且 expect 全中 → ok=true，verdict/bytes 都有',
    okRes.ok === true && okRes.verdict === VERDICTS.booted && okRes.bytes === Buffer.byteLength(BOOT_LOG),
    `${okRes.ok}/${okRes.verdict}`);
  check('L5 接线：脚本作为**单个 argv 元素**传入（不经 shell ⇒ 脚本里的引号反引号都不是注入面）',
    Array.isArray(lastArgv) && lastArgv.includes(CAPTURE_SCRIPT) && !lastArgv.some((a) => /\s&&|\|;/.test(String(a))),
    JSON.stringify((lastArgv || []).slice(0, 2).map((x) => String(x).slice(0, 20))));
  check('L5 接线：argv 里带 port 与抓取时长，且用发现到的解释器（不是写死 python3）',
    lastArgv.includes(P) && lastArgv.includes('--secs') && lastArgv[0] === '/opt/anaconda3/bin/python3',
    lastArgv[0]);

  const noOut = await deviceFlashHandler({ action: 'logs', port: P }, logsDeps(capOut('')));
  check('L5 接线：零输出 → ok=false 且点明「没有启动证据」，不猜成「板子坏了」',
    noOut.ok === false && noOut.verdict === VERDICTS.noOutput && String(noOut.error).includes('没有启动证据'));
  const dlRes = await deviceFlashHandler({ action: 'logs', port: P }, logsDeps(capOut(`${BOOT_LOG}\r\nwaiting for download\r\n`)));
  check('L5 接线：下载模式单独给出可操作下一步（松按键/换复位方式），并说明内容对不对要用 verify 判',
    dlRes.ok === false && String(dlRes.error).includes('下载模式') && String(dlRes.error).includes('verify'));
  const missRes = await deviceFlashHandler({ action: 'logs', port: P, expect: 'ESP-ROM|不存在的串' }, logsDeps(capOut(BOOT_LOG)));
  check('L5 接线：启动成功但特征串缺失 → ok=false 且列出缺失项（「跑起来了但不是你要的固件」）',
    missRes.ok === false && missRes.expect.missing.length === 1
    && String(missRes.error).includes('不存在的串'));

  // 参数收敛：seconds 是模型可控输入，不夹会把一次调用挂成一小时
  const clamped = await deviceFlashHandler({ action: 'logs', port: P, seconds: 999, baud: 9999999 }, logsDeps(capOut(BOOT_LOG)));
  check('L5 接线：seconds/baud 越界被夹进区间（否则一次调用能挂掉整轮对话）',
    clamped.seconds === 30 && clamped.baud === 2000000, `${clamped.seconds}/${clamped.baud}`);
  const lowSec = await deviceFlashHandler({ action: 'logs', port: P, seconds: 1 }, logsDeps(capOut(BOOT_LOG)));
  check('L5 接线：seconds 下限 2（给 1 秒几乎必然抓不到启动）', lowSec.seconds === 2);

  check('L5 接线：缺 port / 非可刷机口都拒绝（不猜一个口去开串口）',
    String((await deviceFlashHandler({ action: 'logs' }, logsDeps(capOut(BOOT_LOG)))).error || '').includes('缺少 port')
    && String((await deviceFlashHandler({ action: 'logs', port: '/dev/cu.QCYMeloBudsN70' }, logsDeps(capOut(BOOT_LOG)))).error || '')
      .includes('可刷'));
  const noPy = await deviceFlashHandler({ action: 'logs', port: P }, {
    platform: 'darwin',
    exec: async (cmd) => (cmd.includes('serial.tools.list_ports') ? { stdout: 'INTERP=' } : hostExec(cmd)),
    run: async () => ({ code: 0, stdout: '' }),
  });
  check('L5 接线：找不到带 pyserial 的解释器 → 明说装什么，不是静默返回空日志',
    noPy.ok === false && String(noPy.error).includes('pyserial'));

  // ⑥ 审批与目标：与 chip_id / verify 同档（复位硬件），卡面必须说清对哪个口动手
  check('L5 审批：logs 与 chip_id / verify 同为 L1（都要独占串口并复位板子）',
    approval.toolLevel('device_flash', { action: 'logs' }) === 'L1'
    && approval.toolLevel('device_flash', { action: 'chip_id' }) === 'L1');
  check('L5 审批目标：卡面是「日志 <口>」', approval.approvalTarget('device_flash', { action: 'logs', port: '/dev/cu.x' }) === '日志 /dev/cu.x');
}

// ── L4c：DFU 通道（2026-10-31）────────────────────────────────────────────────
// 目标：把「STM32 能进 DFU 但本版本不会烧」变成「能烧，且错了会在写之前拒绝」。
// 下面两段 `-l` / `-D` 输出是 dfu-util 0.9–0.11 的**已知形状**（本机没有 STM32 板，
// 造不出来就只能标注来源，不能假装实测过——与 chip_id 那段同一纪律）。
{
  const approval = require('../main/approval.js');
  const LIST_OK = [
    'dfu-util 0.11',
    '',
    'Copyright 2005-2009 Weston Schmidt, Harald Welte and OpenMoko Inc.',
    'Please report bugs to http://sourceforge.net/p/dfu-util/tickets/',
    '',
    'Found DFU: [0483:df11] ver=2200, devnum=3, cfg=1, intf=0, path="20-1", alt=0, '
      + 'name="@Internal Flash  /0x08000000/064*0002Kg", serial="FFFFFFFEFFFF"',
    'Found DFU: [0483:df11] ver=2200, devnum=3, cfg=1, intf=0, path="20-1", alt=1, '
      + 'name="@Option Bytes  /0x1FFFF800/01*016 e", serial="FFFFFFFEFFFF"',
  ].join('\n');
  const FLASH_OK = [
    'dfu-util 0.11',
    'Opening DFU capable USB device...',
    'Device ID 0483:df11',
    'Claiming USB DFU Interface...',
    'Setting Alternate Interface #0 ...',
    'Determining device status...',
    'DFU state(2) = dfuIDLE, status(0) = No error condition is present',
    'DfuSe interface name: "Internal Flash  "',
    'Downloading element to address = 0x08000000, size = 8192',
    'Erase   [=========================] 100%         8192 bytes',
    'Download\t[=========================] 100%         8192 bytes',
    'Download done.',
    'File downloaded successfully',
    'Submitting leave request...',
    'Transitioning to dfuMANIFEST state',
  ].join('\n');

  // ① 解析：一块板子的多个 alt 必须归到同一个设备，而不是变成「两块板」
  const parsed = parseDfuList(LIST_OK);
  check('DFU 解析：同一块板的多个 alt 归到一个设备（按 vid:pid|serial|path 去重）',
    parsed.ok === true && parsed.targets.length === 1 && parsed.targets[0].alts.length === 2,
    `targets=${parsed.targets?.length} alts=${parsed.targets?.[0]?.alts?.length}`);
  check('DFU 解析：「没插设备」与「输出不可识别」必须分开（前者去查 BOOT0，后者去修工具）',
    parseDfuList('dfu-util: No DFU capable USB device available\n').note === 'no-device'
    && parseDfuList('Segmentation fault\n').ok === false
    && String(parseDfuList('Segmentation fault\n').error || '').includes('无法区分'));

  // ② 挑目标 / 挑 alt：两个致命错误都在这里拦
  const twoDev = parseDfuList(`${LIST_OK}\nFound DFU: [0483:df11] ver=2200, devnum=4, cfg=1, intf=0, `
    + 'path="20-2", alt=0, name="@Internal Flash  /0x08000000/064*0002Kg", serial="111111111111"');
  check('DFU 挑目标：两块板同时在线时拒绝，而不是「挑第一块」（烧错板子不可逆，且枚举顺序不稳定）',
    pickTarget(twoDev.targets).ok === false && String(pickTarget(twoDev.targets).error).includes('只接一块'));
  check('DFU 挑目标：一个都没有时指向「怎么让板子进 DFU」，不是空错误',
    String(pickTarget([]).error || '').includes('BOOT0'));
  const altPick = pickAlt(parsed.targets[0]);
  check('DFU 挑 alt：认 Internal Flash 而不是 alt=0 —— STM32 的 alt=1 常是 Option Bytes，写进去=锁板',
    altPick.ok === true && altPick.alt === 0 && /Internal Flash/.test(altPick.name), `alt=${altPick.alt}`);
  // 上面那条在本夹具里**分不出「认出」与「取第一个」**（真机上 Internal Flash 就是 alt=0，
  // 两者同解）。变异实测确认过这个空过：把 pickAlt 改成 `alts.slice(0,1)` 它照样绿。
  // 所以另加一条把顺序颠倒的夹具：主 flash 在 alt=1 时必须仍然选中它。
  const swapped = pickAlt({ alts: [{ alt: 0, name: '@Option Bytes  /0x1FFFF800' }, { alt: 1, name: '@Internal Flash  /0x08000000' }] });
  check('DFU 挑 alt：主 flash 不在 alt=0 时也必须认出它（否则「取第一个」能冒充「认出主 flash」）',
    swapped.ok === true && swapped.alt === 1, `alt=${swapped.alt}`);
  const ambig = pickAlt({ alts: [{ alt: 0, name: '@Flash' }, { alt: 1, name: '@Flash 2' }] });
  check('DFU 挑 alt：两个都像主 flash 时拒绝并列出候选（宁可停下也不猜）',
    ambig.ok === false && ambig.candidates.length === 2);
  // 反向：`@Internal Flash` + `@External Flash`（带外部 QSPI 的板子真有这对）必须能认出主 flash，
  // 不能因为"有两个 flash 字样的 alt"就拒绝——那是把合法板拦死。
  const extPair = pickAlt({ alts: [{ alt: 0, name: '@Internal Flash  /0x08000000' }, { alt: 1, name: '@External Flash  /0x90000000' }] });
  check('DFU 挑 alt：Internal / External 并存时选 Internal（主 flash 判据不能退化成「见到 flash 就拒绝」）',
    extPair.ok === true && extPair.alt === 0);
  const onlyOne = pickAlt({ alts: [{ alt: 0, name: '@DFU' }] });
  check('DFU 挑 alt：只有一个 alt 且名字不含 flash 时取它（没有歧义可犯，不能把这类板拦死）',
    onlyOne.ok === true && onlyOne.alt === 0);

  // ③ 地址：0x8000000 / 8000000 / 0x08000000 必须归一成同一个（卡面与 argv 要逐字一致）
  check('DFU 地址归一：0x08000000 / 0x8000000 / 8000000 是同一处，统一补满 8 位',
    normalizeAddr('0x08000000') === '0x08000000' && normalizeAddr('0x8000000') === '0x08000000'
    && normalizeAddr('8000000') === '0x08000000' && normalizeAddr('乱写') === '');

  // ④ 通道路由：.bin 两条通道都用，只能靠显式 channel；容器格式扩展名优先
  const R = (o) => resolveFlashRoute(o);
  check('DFU 路由：.bin 不传 channel 时仍走 esptool（新通道不得改变旧路径）',
    R({ fmt: resolveImageFormat('/a/fw.bin') }).channel === 'esptool-serial');
  check('DFU 路由：.bin + channel=dfu 走 DFU（STM32 的裸 bin 只能靠显式声明认出来）',
    R({ channel: 'dfu', fmt: resolveImageFormat('/a/fw.bin'), port: '/dev/cu.x' }).channel === 'dfu-util'
    && R({ channel: 'dfu', fmt: resolveImageFormat('/a/fw.bin'), port: '/dev/cu.x' }).warnings.length === 1);
  check('DFU 路由：.dfu 容器按扩展名自动走 DFU（即使调用方说 esptool）',
    R({ channel: 'esptool', fmt: resolveImageFormat('/a/fw.dfu') }).channel === 'dfu-util');
  check('DFU 路由：.uf2 + channel=esptool 仍走 UF2 并告警（容器字节写进 flash 不会报错，只会写坏）',
    R({ channel: 'esptool', fmt: resolveImageFormat('/a/fw.uf2') }).channel === 'uf2-copy'
    && R({ channel: 'esptool', fmt: resolveImageFormat('/a/fw.uf2') }).warnings.length === 1);
  check('DFU 路由：未知 channel 直接拒绝并列出可用值（拼错不能静默退回 esptool）',
    Boolean(R({ channel: 'dfuu', fmt: resolveImageFormat('/a/fw.bin') }).error));
  check('DFU 格式闸：.dfu 走 esptool 被拒（容器头部字节不是固件本体）',
    esptoolFormatCheck('/a/b.dfu').ok === false && /dfu-util/.test(esptoolFormatCheck('/a/b.dfu').error));

  // ⑤ 计划：地址必须显式给，扩展名必须是 DFU 接收的两种
  const T = parseDfuList(LIST_OK).targets[0];
  const planBase = { target: T, alt: 0, altName: '@Internal Flash', addr: '0x08000000', firmware: '/a/fw.bin', fileSize: 8192 };
  const built = buildDfuPlan(planBase);
  check('DFU 计划：argv 带 :leave（否则「成功」只代表字写进去了，设备还停在 bootloader）',
    built.ok === true && built.argv.join(' ').includes('-s 0x08000000:leave')
    && built.argv.join(' ').includes('-D /a/fw.bin'), built.argv?.join(' '));
  check('DFU 计划：没给地址就拒绝（猜一个=写到别的区域，设备不报错）',
    buildDfuPlan({ ...planBase, addr: '' }).ok === false
    && String(buildDfuPlan({ ...planBase, addr: '' }).error).includes('offset'));
  check('DFU 计划：.hex / .uf2 拒绝（DFU 只收裸 bin 与 .dfu 容器）',
    buildDfuPlan({ ...planBase, firmware: '/a/fw.hex' }).ok === false
    && buildDfuPlan({ ...planBase, firmware: '/a/fw.uf2' }).ok === false);
  check('DFU 计划：摘要把 target/alt/地址/文件都压进去——换任何一项摘要都必须变',
    dfuPlanDigest({ vid: '0483', pid: 'df11', alt: 0, addr: '0x08000000', firmware: '/a/fw.bin', fileSize: 8192 })
    === dfuPlanDigest({ vid: '0483', pid: 'df11', alt: 0, addr: '0x08000000', firmware: '/a/fw.bin', fileSize: 8192 })
    && dfuPlanDigest({ vid: '0483', pid: 'df11', alt: 1, addr: '0x08000000', firmware: '/a/fw.bin', fileSize: 8192 })
      !== built.digest
    && dfuPlanDigest({ vid: '0483', pid: 'df11', alt: 0, addr: '0x08001000', firmware: '/a/fw.bin', fileSize: 8192 })
      !== built.digest);
  check('DFU 计划：0x0 允许但必须告警（多数 STM32 主 flash 在 0x08000000）',
    buildDfuPlan({ ...planBase, addr: '0x0' }).warnings.some((w) => w.includes('0x08000000')));

  // ⑥ 执行器：注入假 run，不碰真实设备
  const statOk = () => ({ isFile: () => true, size: 8192 });
  const runs = (listOut, flashOut, code = 0) => async (argv) => (
    argv.includes('-l') ? { code: 0, stdout: listOut } : { code, stdout: flashOut }
  );
  const dfuDeps = { run: runs(LIST_OK, FLASH_OK), stat: statOk };
  const noTool = await dfuList({ run: async () => ({ code: 1, stdout: '', stderr: '', spawnError: 'ENOENT' }) });
  check('DFU 执行器：没装 dfu-util 时明说装什么（ENOENT 不能与「设备没插」同形）',
    noTool.ok === false && noTool.installed === false && String(noTool.error).includes('brew install dfu-util'));
  const p1 = await dfuChannelHandler({ action: 'plan', firmware: '/a/fw.bin', offset: '0x08000000' }, dfuDeps);
  check('DFU 执行器：plan 不执行写入（argv 只装配出来给人看），并带审批卡与摘要',
    p1.ok === true && p1.channel === 'dfu-util' && p1.argv[0] === 'dfu-util'
    && Boolean(p1.plan_digest) && Boolean(p1.card && p1.card.target && p1.card.consequence));
  const noDev = await dfuChannelHandler({ action: 'plan', firmware: '/a/fw.bin', offset: '0x08000000' },
    { run: runs('dfu-util: No DFU capable USB device available\n', ''), stat: statOk });
  check('DFU 执行器：没有设备时指向「先让板子进 DFU」，而不是把「没插」报成工具坏了',
    noDev.ok === false && String(noDev.error).includes('BOOT0'));
  const notWired = await dfuChannelHandler({ action: 'verify', firmware: '/a/fw.bin' }, dfuDeps);
  check('DFU 执行器：verify/backup 明说「未接线 + 为什么」（回读长度语义没在真机验过）',
    notWired.ok === false && String(notWired.error).includes('不支持 verify'));
  const noDigest = await dfuChannelHandler({ action: 'flash', firmware: '/a/fw.bin', offset: '0x08000000' }, dfuDeps);
  check('DFU 执行器：flash 缺 plan_digest 直接拒绝（不能跳档）',
    noDigest.ok === false && String(noDigest.error).includes('plan_digest'));
  const badDigest = await dfuChannelHandler(
    { action: 'flash', firmware: '/a/fw.bin', offset: '0x08000000', plan_digest: 'deadbeefdeadbeef' }, dfuDeps);
  check('DFU 执行器：plan_digest 不符时拒绝（确认后改过参数的第二次点击不会执行）',
    badDigest.ok === false && String(badDigest.error).includes('不匹配'));
  const movedAddr = await dfuChannelHandler(
    { action: 'flash', firmware: '/a/fw.bin', offset: '0x08001000', plan_digest: p1.plan_digest }, dfuDeps);
  check('DFU 执行器：换地址后旧摘要失效（否则「确认 0x08000000、实际写 0x08001000」能过关）',
    movedAddr.ok === false && String(movedAddr.error).includes('不匹配'));
  const idMismatch = await dfuChannelHandler(
    { action: 'plan', firmware: '/a/fw.bin', offset: '0x08000000', expect_vid_pid: '1a86:7523' }, dfuDeps);
  check('DFU 执行器：expect_vid_pid 与在位的 DFU 设备不符时拒绝',
    idMismatch.ok === false && String(idMismatch.error).includes('身份不符'));
  const f1 = await dfuChannelHandler(
    { action: 'flash', firmware: '/a/fw.bin', offset: '0x08000000', plan_digest: p1.plan_digest }, dfuDeps);
  check('DFU 执行器：写成功要同时看到 File downloaded successfully + leave 请求（不是「退出码 0」）',
    f1.ok === true && f1.verdict === 'ok' && f1.downloaded === true && f1.leftBootloader === true && f1.wroteBytes === 8192,
    `${f1.verdict}/${f1.wroteBytes}`);

  // ⑦ 结果判定：五种失败各有各的下一步
  const verdictOf = (out, code = 1) => parseDfuFlash(out, { exitCode: code }).verdict;
  check('DFU 判定：退出码 0 但没有任何成功证据 → 判 no-evidence（「看起来成功了」是最危险的一档）',
    verdictOf('dfu-util 0.11\nOpening DFU capable USB device...\n', 0) === DFU_FLASH_VERDICTS.noEvidence);
  check('DFU 判定：错误分类能分开「设备没了 / 地址越界 / 传输中断」',
    verdictOf('dfu-util: Cannot open DFU device 0483:df11\n') === DFU_FLASH_VERDICTS.device
    && verdictOf('dfu-util: Address 0x08000000 out of range\n') === DFU_FLASH_VERDICTS.addr
    && verdictOf('dfu-util: Error during download get_status\n') === DFU_FLASH_VERDICTS.transfer);
  check('DFU 判定：有成功行但退出码非零 → 仍判失败（两者矛盾时取更保守的那个）',
    verdictOf('Download done.\nFile downloaded successfully\n', 74) === DFU_FLASH_VERDICTS.error);
  const noLeave = await dfuChannelHandler(
    { action: 'flash', firmware: '/a/fw.bin', offset: '0x08000000', plan_digest: p1.plan_digest },
    { run: runs(LIST_OK, 'Download done.\nFile downloaded successfully\n'), stat: statOk });
  check('DFU 判定：写成功但设备没接受 leave → 报成功 + 告警（否则用户看到「烧成功但板子不动」）',
    noLeave.ok === true && noLeave.warnings.some((w) => w.includes('leave')));
  const dev = await dfuChannelHandler(
    { action: 'flash', firmware: '/a/fw.bin', offset: '0x08000000', plan_digest: p1.plan_digest },
    { run: runs(LIST_OK, 'dfu-util: Cannot open DFU device 0483:df11\n'), stat: statOk });
  check('DFU 判定：设备中途掉线时提示「重插后重走 plan，旧摘要作废」',
    dev.ok === false && String(dev.error).includes('作废'));

  // ⑧ 与 device_flash 的分流：模型只需传 channel，不用知道内部通道名
  const fdeps = {
    platform: 'darwin',
    exec: async () => ({ stdout: '' }),
    run: runs(LIST_OK, FLASH_OK),
    stat: statOk,
  };
  const dPlan = await deviceFlashHandler({ action: 'plan', firmware: '/a/fw.bin', channel: 'dfu', offset: '0x08000000' }, fdeps);
  check('DFU 分流：device_flash + channel=dfu + .bin → DFU 通道（不会被「没找到 esptool」挡住）',
    dPlan.ok === true && dPlan.channel === 'dfu-util', `${dPlan.ok}/${dPlan.channel || dPlan.error}`);
  const dFlash = await deviceFlashHandler({
    action: 'flash', firmware: '/a/fw.bin', channel: 'dfu', offset: '0x08000000', plan_digest: dPlan.plan_digest,
  }, fdeps);
  check('DFU 分流：flash 走同一条摘要（plan 拿到的 digest 在 flash 上成立，一次确认两处可用）',
    dFlash.ok === true && dFlash.verdict === 'ok', `${dFlash.ok}/${dFlash.error}`);
  const dDfuExt = await deviceFlashHandler({ action: 'plan', firmware: '/a/fw.dfu', offset: '0x08000000' },
    { ...fdeps, stat: () => ({ isFile: () => true, size: 16384 }) });
  check('DFU 分流：.dfu 不传 channel 也自动走 DFU（容器格式只有一条通道能收）',
    dDfuExt.ok === true && dDfuExt.channel === 'dfu-util');
  const dVerify = await deviceFlashHandler({ action: 'verify', firmware: '/a/fw.bin', channel: 'dfu' }, fdeps);
  check('DFU 分流：verify 走 DFU 时明说该通道只接 plan/flash，并指出改走 esptool',
    dVerify.ok === false && String(dVerify.error).includes('只接 plan / flash'), String(dVerify.error).slice(0, 40));
  // .uf2 + channel=dfu：扩展名必须赢（容器字节写进 flash 不会报错，只会把板子写坏）。
  // 夹具是一个结构合法的单块 UF2（三个魔数 + 块号 0/1），不是随便一段字节。
  const uf2Block = () => {
    const b = Buffer.alloc(512);
    b.writeUInt32LE(0x0a324655, 0); b.writeUInt32LE(0x9e5d5157, 4);
    b.writeUInt32LE(0, 8); b.writeUInt32LE(0x10000000, 12);
    b.writeUInt32LE(256, 16); b.writeUInt32LE(0, 20); b.writeUInt32LE(1, 24);
    b.writeUInt32LE(0x0fe47c6b, 508);
    return b;
  };
  const uf2Fs = {
    statSync: () => ({ isFile: () => true, size: 512 }),
    readFileSync: () => uf2Block(),
    readdirSync: (p) => (p === '/Volumes/RPI-RP2' ? ['INFO_UF2.TXT'] : []),
    existsSync: () => true,
    statfsSync: () => {
      throw new Error('statfs stub: 只用于让 freeBytes 走「未知」分支');
    },
  };
  const dUf2Wrong = await deviceFlashHandler(
    { action: 'plan', firmware: '/a/fw.uf2', channel: 'dfu', volume: '/Volumes/RPI-RP2' },
    { platform: 'darwin', exec: async () => ({ stdout: '' }), run: runs(LIST_OK, FLASH_OK), fsx: uf2Fs, now: () => 0, sleep: async () => {} },
  );
  check('DFU 分流：.uf2 传 channel=dfu 时仍走 UF2 且真的 plan 成功（扩展名优先，选错通道不该能写坏设备）',
    dUf2Wrong.ok === true && dUf2Wrong.channel === 'uf2-copy', `${dUf2Wrong.ok}/${dUf2Wrong.channel || dUf2Wrong.error}`);

  // ⑨ 审批：卡面只渲染 tool + target，DFU 没有串口/卷，只能在 target 里塞身份 + 地址
  check('DFU 审批目标：卡面是「vid:pid @地址 ← 文件」（否则用户看到的是「 ← fw.bin」，等于没有目标）',
    approval.approvalTarget('device_flash', {
      action: 'flash', firmware: '/a/fw.bin', channel: 'dfu', offset: '0x8000000', expect_vid_pid: '0483:df11',
    }) === '0483:df11 @0x08000000 ← /a/fw.bin');
  check('DFU 审批目标：.dfu 扩展名也能识别（不靠模型每次都记得传 channel）',
    approval.approvalTarget('device_flash', { action: 'flash', firmware: '/a/fw.dfu', offset: '0x08000000' })
      === 'DFU 设备 @0x08000000 ← /a/fw.dfu');
  check('DFU 审批：flash 是 L1（硬地板：任何档位都弹卡，不接受「始终允许」）',
    approval.toolLevel('device_flash', { action: 'flash', channel: 'dfu' }) === 'L1'
    && approval.isRememberable('device_flash') === false);

  // ⑩ implemented 翻转的**用户可见效果**：一块 DFU 板从「未接线」变成「能烧」
  const dfuBridge = { vid: '0483', pid: 'df11', name: 'STM32 系统 DFU 模式', kind: 'dfu', verdict: 'not-serial', ports: [] };
  const withTool = resolveChannels({ bridges: [dfuBridge], executors: parseExecutors(`HAVE=dfu-util\n${EXECUTOR_PROBE_SENTINEL}`) });
  const withoutTool = resolveChannels({ bridges: [dfuBridge], executors: parseExecutors(`HAVE=esptool\n${EXECUTOR_PROBE_SENTINEL}`) });
  check('DFU 能力：装了 dfu-util 时 DFU 设备 runnable=true（implemented 翻转的实际效果）',
    withTool.targets[0].channel === 'dfu-util' && withTool.targets[0].implemented === true
    && withTool.targets[0].runnable === true, JSON.stringify(withTool.targets[0]?.todo));
  check('DFU 能力：没装 dfu-util 时 runnable=false 并给出安装指引（能跑 ≠ 已接线，两个条件都要）',
    withoutTool.targets[0].runnable === false
    && withoutTool.targets[0].todo.some((t) => t.includes('brew install dfu-util')));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
