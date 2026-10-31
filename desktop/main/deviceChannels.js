// L3 协议识别 / 刷写通道决策（2026-10-31，参考 hardware_flash_workflow.md §2.3 / §3）
//
// L2 回答「这条口背后有没有真设备」，L3 回答「这个通道该用哪把钥匙」。
//
// 这一层最重要的诚实话：**USB 枚举看不出桥芯片后面接的是什么 MCU**。
// 一块 CH340（1a86:7523）后面可能是 ESP32、STM32、Arduino AVR，也可能只是台串口打印机。
// 所以结论按 confidence 三档输出，且「猜」不属于任何一档：
//   · certain        身份来自芯片厂商自己的 VID（如 303a = Espressif）⇒ 通道确定；
//   · probe-required 桥芯片 + 串口 ⇒ 只能给候选，必须先握手（esptool chip_id）确认芯片身份；
//   · none           身份未知 ⇒ 不给通道，只给「先查什么」。
// 把 probe-required 压成 certain 的后果很具体：对着一块 STM32 跑 esptool 会得到一串超时，
// 用户会以为板子坏了，然后去重刷、换线、装驱动——每一步都在错误的假设上。
//
// 另一个必须报的字段是 implemented：机器上装了 dfu-util **不等于**本项目支持 DFU 烧写。
// 本版本只有 esptool 串口通道接了执行器（device_flash），其余通道只是「判定出来了」，
// 执行器要等 L4。不区分这两件事，模型就会对用户说「可以烧了」。
//
// 文档 §3 的关键原则（本文件按此排序）：
//   ① 优先用官方 ROM bootloader（出厂固化，最不容易变砖）——所以 esptool/DFU/UF2 排在调试器前；
//   ② 调试器（SWD/JTAG）是兜底通道；
//   ③ 陌生板子先 read_flash 备份再动手（这条已在 device_flash 的 backup 档落地）。

// 通道表。executor 是本项目要调的命令名，implemented 表示「本项目已接线执行器」。
const CHANNELS = [
  {
    id: 'esptool-serial',
    label: 'ESP 串口 ROM bootloader（esptool）',
    protocol: 'esptool',
    executors: ['esptool', 'esptool.py'],
    install: 'pip install esptool（v5 起命令名是 esptool，旧版才是 esptool.py，两者都会自动识别）',
    actions: ['chip_id', 'read_flash', 'write_flash', 'verify_flash', 'erase_flash'],
    needsPort: true,
    implemented: true,
    doc: '§3「ESP8266/ESP32 全家桶 → UART ROM bootloader」',
    note: '原生 USB（303a）与桥串口（CH340/CP210x/FTDI）都是同一条协议，区别只在物理链路',
  },
  {
    id: 'stm32flash-serial',
    label: 'STM32 USART bootloader（stm32flash）',
    protocol: 'stm32flash',
    executors: ['stm32flash'],
    install: 'brew install stm32flash',
    actions: ['read', 'write', 'erase'],
    needsPort: true,
    implemented: false,
    doc: '§3「STM32 → 只有串口 → USART bootloader」/ §5.3',
    note: '与 esptool 抢同一个串口：必须先排除 ESP，才轮得到它',
  },
  {
    id: 'avrdude-serial',
    label: 'Arduino AVR bootloader（avrdude）',
    protocol: 'stk500',
    executors: ['avrdude'],
    install: 'brew install avrdude',
    actions: ['read', 'write', 'erase'],
    needsPort: true,
    implemented: false,
    doc: '§3「Arduino AVR → avrdude -c arduino」',
    note: '同上：桥串口上的第三号可能身份',
  },
  {
    id: 'dfu-util',
    label: 'USB DFU（dfu-util）',
    protocol: 'dfu',
    executors: ['dfu-util'],
    install: 'brew install dfu-util',
    actions: ['list', 'upload', 'download'],
    needsPort: false,
    implemented: false,
    doc: '§3「STM32 → 能进 DFU（BOOT0+RST）→ USB DFU」/ §2.3',
    note: '设备已经枚举成 0483:df11 就说明在 ROM 下载模式，无需再握手',
  },
  {
    id: 'uf2-copy',
    label: 'UF2 拖拽（拷贝 .uf2 到 U 盘）',
    protocol: 'uf2',
    executors: [], // 纯文件拷贝，不需要外部命令
    install: '',
    actions: ['copy'],
    needsPort: false,
    implemented: false,
    doc: '§3「RP2040/RP2350 → BOOTSEL 按住 → UF2 拖拽」/ §6',
    note: '最不容易变砖：bootloader 在 ROM 里，设备自己完成写入',
  },
  {
    id: 'openocd-swd',
    label: 'SWD/JTAG（OpenOCD，ST-LINK/J-Link/DAPLink）',
    protocol: 'swd',
    executors: ['openocd', 'probe-rs'],
    install: 'brew install openocd（或 probe-rs、ST 官方 STM32_Programmer_CLI）',
    actions: ['probe', 'program', 'erase'],
    needsPort: false,
    implemented: false,
    doc: '§3「调试器是兜底通道」/ §5.1',
    note: 'bootloader 被玩坏时的最后手段；需要目标芯片配置，不能仅凭 VID 直接烧',
  },
  {
    id: 'fastboot',
    label: 'Android fastboot',
    protocol: 'fastboot',
    executors: ['fastboot'],
    install: 'brew install --cask android-platform-tools',
    actions: ['devices', 'flash', 'reboot'],
    needsPort: false,
    implemented: false,
    doc: '§3「Android → 可进 bootloader → fastboot（OEM 解锁为前提）」/ §7',
    note: '以 OEM 解锁为前提；本工具不做解锁',
  },
];

const CHANNEL_BY_ID = new Map(CHANNELS.map((c) => [c.id, c]));

// 执行器探测名单：必须覆盖所有通道的 executors（有断言守着，漏一个就红）。
// 顺序即探测顺序，不影响结果。
const EXECUTOR_NAMES = [
  'esptool', 'esptool.py', 'dfu-util', 'openocd', 'probe-rs', 'picotool', 'stm32flash', 'avrdude', 'adb', 'fastboot',
];

// 「探测了但还没挂到任何通道」的执行器——已知例外，显式列出。
//   adb     → recovery 的 `adb sideload`（文档 §3 Android 分支），与 fastboot 不可互换，需独立通道；
//   picotool→ 把 .bin 转成 .uf2（§6），是 uf2-copy 的可选增强，不是必需依赖。
// 有断言钉住「差集必须等于这份清单」：新增探测名却不挂通道 → 红；把 adb 挂进 fastboot 通道 → 也红
//（两者不可互换，混进同一通道会让 pickExecutor 在只装了 adb 时误报 fastboot 可用）。
const UNASSIGNED_EXECUTORS = ['adb', 'picotool'];

// 「探测跑完了」的哨兵：没有它时，空输出既可能是「一个都没装」也可能是「命令没执行成功」，
// 而这两者的下一步完全不同（前者去装，后者去修探测）。
const EXECUTOR_PROBE_SENTINEL = 'EXECUTOR_PROBE_DONE';

/**
 * 解析执行器探测结果。
 * 只认白名单里的名字（`HAVE=` 后面跟什么不进对象键，避免 `HAVE=constructor` 这类脏数据进原型链）。
 */
function parseExecutors(stdout) {
  const lines = String(stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const ok = lines.includes(EXECUTOR_PROBE_SENTINEL);
  const have = {};
  for (const n of EXECUTOR_NAMES) have[n] = lines.includes(`HAVE=${n}`);
  return { ok, have };
}

/** 选执行器：同一通道有多个候选命令时，用实际装上的那个（esptool 优先于 esptool.py）。 */
function pickExecutor(channel, executors) {
  if (!channel.executors.length) return { name: null, installed: true }; // uf2 无需外部命令
  if (!executors || !executors.ok) return { name: channel.executors[0], installed: null }; // 未探测 ⇒ 未知，不是「没装」
  const hit = channel.executors.find((n) => executors.have[n]);
  return { name: hit || channel.executors[0], installed: Boolean(hit) };
}

/**
 * 单个 L2 bridge → 通道结论。
 * 判据只用「可核实的身份」：kind（L2 判定）+ VID（厂商归属）+ 端口（L2 已确认背后有设备）。
 */
function resolveOne(bridge, executors) {
  const base = {
    vid: bridge.vid, pid: bridge.pid, name: bridge.name || '', ports: bridge.ports || [],
    channel: null, label: '', protocol: '',
    confidence: 'none', executor: null, installed: null, implemented: false,
    runnable: false, reason: '', todo: [], alternatives: [],
  };
  const byKind = (id, reason) => {
    const ch = CHANNEL_BY_ID.get(id);
    const ex = pickExecutor(ch, executors);
    return {
      ...base, channel: ch.id, label: ch.label, protocol: ch.protocol,
      confidence: 'certain', executor: ex.name, installed: ex.installed,
      implemented: ch.implemented, reason, doc: ch.doc,
    };
  };

  // ① 非串口通道：设备已经自报模式，无需握手（文档 §2.3：枚举成什么就是什么）
  if (bridge.kind === 'dfu') return byKind('dfu-util', '设备已枚举为 DFU（ROM 下载模式）');
  if (bridge.kind === 'uf2') return byKind('uf2-copy', '设备已枚举成 U 盘（BOOTSEL/UF2 模式）');
  if (bridge.kind === 'debug-probe') return byKind('openocd-swd', '调试探针在位（SWD/JTAG 兜底通道）');

  // ② 串口通道
  if (bridge.kind !== 'serial' && bridge.kind !== 'unknown') return base;
  if (!base.ports.length) {
    // L2 已经给了 verdict，这里只解释「为什么暂时没有通道可给」
    return { ...base, reason: `没有可用串口（L2 结论：${bridge.verdict}）`, todo: [bridge.advice || '先解决串口不可用的问题'] };
  }

  const espressif = bridge.vid === '303a';
  const ch = CHANNEL_BY_ID.get('esptool-serial');
  const ex = pickExecutor(ch, executors);
  const probeRequired = !espressif;

  const t = {
    ...base, channel: ch.id, label: ch.label, protocol: ch.protocol,
    // VID 303a 是 Espressif 自己的厂商号 ⇒ 芯片身份确定；
    // 桥芯片的 VID 属于桥（WCH/Silabs/FTDI），后面接什么完全未知 ⇒ 必须握手。
    confidence: probeRequired ? 'probe-required' : 'certain',
    executor: ex.name, installed: ex.installed, implemented: ch.implemented,
    doc: ch.doc,
    reason: espressif
      ? 'Espressif 官方 VID（303a）：芯片身份确定，可直接走 esptool'
      : `桥芯片 ${bridge.vid}:${bridge.pid} 后面可能是任意 MCU：需先 chip_id 握手确认`,
    todo: probeRequired
      // 不写「你自己去跑 chip_id」：L4b 之后工具能自己问（device_flash action=chip_id），
      // 让用户去敲命令行等于把可自动完成的一步推给人，而且他抄回来的结论还不一定对得上口。
      ? [`调 device_flash action=chip_id port=${base.ports[0]} 让工具自己问芯片身份`
        + '（桥芯片背后可能是 STM32/AVR/其它，光看 VID 判不出来）']
      : [],
  };
  if (probeRequired) {
    // 同一个物理串口上的其它可能身份（文档 §3 的三个分支）——不是并行方案，是「握手失败后再试」的次序
    t.alternatives = ['stm32flash-serial', 'avrdude-serial'].map((id) => {
      const a = CHANNEL_BY_ID.get(id);
      const ax = pickExecutor(a, executors);
      return { id: a.id, label: a.label, protocol: a.protocol, installed: ax.installed, implemented: a.implemented, doc: a.doc };
    });
  }
  return t;
}

/**
 * 汇总所有 L2 bridge 的通道结论。
 * @param {object} p
 * @param {Array} p.bridges    assessBridges 的 bridges
 * @param {object|null} p.executors parseExecutors 的结果；null = 未探测
 * @returns {{targets: Array, primary: object|null, notes: string[]}}
 */
function resolveChannels({ bridges = [], executors = null } = {}) {
  const targets = [];
  for (const b of bridges) {
    if (b.verdict === 'ignored') continue; // 集线器不是目标
    const t = resolveOne(b, executors);
    // 「现在就能跑」= 通道有实现 && 执行器在 && 目标就绪。
    // 目标就绪不能一律要求「有串口」：DFU/UF2/SWD 根本不出现在串口列表里，
    // 用 ports.length 当通用判据会让 L4 接好 dfu-util 之后仍然永远 runnable=false。
    // 所以由通道自己声明 needsPort（数据在 CHANNELS 表里，不在这里 if 分支）。
    const ch = t.channel ? CHANNEL_BY_ID.get(t.channel) : null;
    const needsPort = ch ? ch.needsPort !== false : true;
    const targetReady = needsPort ? t.ports.length > 0 : true;
    t.needsPort = needsPort;
    t.targetReady = Boolean(t.channel) && targetReady;
    t.runnable = Boolean(t.channel && t.implemented && t.installed !== false && targetReady);
    if (t.channel && needsPort && !t.ports.length) t.todo.push('通道已就绪但没有目标串口');
    if (t.channel && !t.implemented) t.todo.push('本版本未接线该通道的执行器（L4）');
    if (t.channel && t.installed === false) {
      t.todo.push(`执行器未安装：${ch.install}`);
    }
    targets.push(t);
  }

  // 首选目标排序：能跑 > 身份确定 > 需探针 > 无结论。
  // 「能跑」内部还要再分一层：两块设备都能跑时优先身份**确定**的那块——
  // 对一块已知是 ESP 的板子动手，比对着桥芯片猜要安全；猜错就是烧错协议。
  const rank = (t) => {
    if (t.runnable) return t.confidence === 'certain' ? 0 : 1;
    if (t.confidence === 'certain') return 2;
    if (t.confidence === 'probe-required') return 3;
    return 4;
  };
  const order = targets.slice().sort((a, b) => rank(a) - rank(b) || a.ports.length - b.ports.length);
  const primary = order.find((t) => t.channel && t.runnable) || order.find((t) => t.channel) || null;

  const notes = [];
  const probe = targets.filter((t) => t.confidence === 'probe-required');
  if (probe.length) {
    notes.push(`${probe.length} 个设备需先握手确认芯片身份：桥芯片（CH34x/CP210x/FTDI）背后可能是任意 MCU，`
      + '直接按 ESP 烧会把超时误当成「板子坏了」。用 device_flash action=chip_id 让工具自己问，别让用户去命令行手敲');
  }
  const noImpl = targets.filter((t) => t.channel && !t.implemented);
  if (noImpl.length) {
    notes.push(`${noImpl.length} 个设备已识别出通道但本版本未接线执行器（${[...new Set(noImpl.map((t) => t.channel))].join(', ')}）：只能给出结论，不能执行`);
  }
  const missEx = targets.filter((t) => t.channel && t.installed === false);
  if (missEx.length) {
    notes.push(`${missEx.length} 个通道缺执行器：${[...new Set(missEx.map((t) => t.channel))].join(', ')}（安装指引见 target.todo）`);
  }
  if (executors && !executors.ok) notes.push('执行器探测未完成：installed 一律为 null（未知），不能当成「没装」');
  if (!executors) notes.push('本平台未接线执行器探测：installed 为 null，仅给出通道判定');
  return { targets, primary, notes };
}

module.exports = {
  CHANNELS, CHANNEL_BY_ID, EXECUTOR_NAMES, UNASSIGNED_EXECUTORS, EXECUTOR_PROBE_SENTINEL,
  parseExecutors, resolveChannels,
};
