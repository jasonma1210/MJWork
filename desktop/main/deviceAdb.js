// L2b：Android 用户态设备识别（2026-10-31）。纯逻辑，不执行任何命令。
//
// 为什么需要这一层：`device_probe` 报的 `bridges[].verdict = not-serial` 对「DFU 板 / UF2 盘 /
// 调试探针」是对的，但对一台插在电脑上的手机**是误导** —— 手机在用户态（已开 USB 调试）时本来
// 就没有串口，用户看到 not-serial 会以为「这块板不支持烧写」，而真相是「它现在不在烧写模式」。
// 下一步完全不同：前者是换通道，后者是**把手机重启进 bootloader**。
//
// 判据全部来自本机实测（adb 37.0.0 / platform-tools 37.0.0，2026-10-31），不凭印象：
//   · 无设备时 `adb devices -l` 的 stdout 是 `b'List of devices attached\n\n'`、stderr 空、**exit 0**。
//     也就是说「有输出」不等于「有设备」——表头恒在，按 `trim() !== ''` 判会永远认为插了设备。
//     这与 fastboot 的坑正好相反（fastboot 无设备时 stdout 完全为空），别把两套判据混用。
//   · 无设备时 `adb shell getprop x` 立即返回（实测 0.01s）且 stderr 为
//     `adb: no devices/emulators found`、exit 1 —— 不像 fastboot 会无限等 `< waiting for any device >`。
//     所以这里不需要给 getprop 挂短超时兜「卡死」，只需处理「报错」。
//   · 设备行形如 `c35e1792  device usb:3-1 product:OPD2409 model:OPD2409 device:OPD2409 transport_id:1`。
//
// 纪律：
//   · **不替用户重启**：`adb reboot bootloader` 会改变设备状态、且这一步在用户不知情时执行等于
//     把手机踢出用户态。本模块只产出「下一步该做什么」的说明，绝不产出要执行的命令。
//   · 序列号来自设备、不是来自模型：它会被拼进 argv，但仍要过 `isSafeSerial` 白名单 ——
//     一台恶意 USB 设备可以自报任意序列号（`x; rm -rf ~`），而这是唯一一处「外部字符串流向我方
//     命令」的路径。

/**
 * ADB 设备状态 → 结论。`canFlash` 一律 false：**没有任何 ADB 状态能直接刷写**
 * （sideload 也不行——本项目未接线 adb sideload，且它同样是「先要进 recovery」）。
 * `mode` 三档用来把「没插设备」「插了但不能用」「插了且能用下一步」分开，
 * 压在同一个 false 上的话用户只能靠猜。
 */
const ADB_STATES = {
  device: {
    mode: 'ready',
    label: 'Android 用户态（USB 调试已授权）',
    next: '要烧写须让**用户自己**把手机重启到 bootloader（长按电源+音量，或用户手动执行 adb reboot bootloader），'
      + '本工具不会替你执行：重启会改变设备状态，属于用户该决定的动作。进 bootloader 后再用 device_flash channel=fastboot。',
  },
  unauthorized: {
    mode: 'blocked',
    label: '未授权（手机上看不到「允许 USB 调试」的授权弹窗或还没点允许）',
    next: '在手机屏幕上点「允许」并勾选「始终允许」。这不是线或驱动问题，换线没有用；'
      + '若弹窗一直不出现，先关掉再打开「USB 调试」，或撤销 USB 调试授权后重插。',
  },
  offline: {
    mode: 'blocked',
    label: '设备离线（adb 看得见但连不上）',
    next: '先 `adb kill-server` 再重插；仍 offline 通常是上一次连接残留或手机端调试服务被系统杀掉（部分厂商系统会主动杀）。',
  },
  recovery: {
    mode: 'blocked',
    label: 'recovery 模式',
    next: 'recovery 里没有 fastboot 也没有普通 shell 权限；要刷分区请重启到 bootloader，'
      + '要刷 OTA 包（.zip）才会用到 recovery 的 sideload（本版本未接线）。',
  },
  sideload: {
    mode: 'blocked',
    label: 'recovery sideload 模式',
    next: '本版本未接线 adb sideload：此模式下工具链无法推进，请在 recovery 界面里手动选择安装。',
  },
  bootloader: {
    mode: 'ready',
    label: 'fastboot 模式（bootloader）',
    next: '已在烧写模式：用 device_flash channel=fastboot + partition 指定目标分区。',
  },
  host: {
    mode: 'blocked',
    label: '非设备条目（adb 的 host 特性）',
    next: '这条不是真设备，忽略。',
  },
  unknown: {
    mode: 'blocked',
    label: '未识别的 adb 状态',
    next: '状态字符串不在已知表内（adb 版本差异）：不要据此判断能不能刷，先按「不是烧写模式」处理。',
  },
};

const ADB_DEVICES_HEADER = 'List of devices attached';

/**
 * 序列号白名单。真实序列号是 `c35e1792` / `emulator-5554` / `192.168.1.5:5555` 这类形状；
 * 白名单而非黑名单，因为这里防的是「外部字符串流进我方命令」，黑名单永远漏。
 */
function isSafeSerial(serial) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(String(serial || ''));
}

/** 一行 `serial state [k:v ...]` → 记录；不成形返回 null。 */
function parseAdbDeviceLine(line) {
  const t = String(line || '').trim();
  if (!t || t === ADB_DEVICES_HEADER) return null;
  const parts = t.split(/\s+/);
  if (parts.length < 2) return null;
  const [serial, rawState, ...rest] = parts;
  const state = String(rawState || '').toLowerCase();
  const props = {};
  for (const p of rest) {
    const i = p.indexOf(':');
    if (i > 0) props[p.slice(0, i)] = p.slice(i + 1);
  }
  const st = ADB_STATES[state] || ADB_STATES.unknown;
  return { serial, state, props, mode: st.mode };
}

/**
 * 解析 `adb devices -l` 输出。
 *
 * **只认表头之后的行**：`adb` 的表头 `List of devices attached` 恒在，而它之前的行可能是
 * 守护进程自述（`* daemon started successfully *`）或版本不匹配告警
 * （`adb server version (41) doesn't match this client (40); killing...`）。按「每行两列就
 * 当设备」解析，这些文案会被读成一台叫 `adb`、状态叫 `server` 的假设备 —— 而且它会一路传到
 * 「发给哪台设备」的决策里。
 *
 * `sawHeader` 单独返回：没有表头说明这条命令**不是 adb 的正常输出**（没装 / 版本不对 / 输出被截），
 * 与「adb 正常、只是没插设备」是两件事。压成一个「devices 为空」会让用户去检查 USB 线。
 */
function parseAdbDevices(stdout) {
  const lines = String(stdout || '').split('\n').map((s) => s.replace(/\r$/, '').trim());
  const at = lines.findIndex((l) => l === ADB_DEVICES_HEADER);
  if (at < 0) return { sawHeader: false, devices: [], empty: true };
  const devices = [];
  for (const l of lines.slice(at + 1)) {
    const d = parseAdbDeviceLine(l);
    if (d) devices.push(d);
  }
  return { sawHeader: true, devices, empty: devices.length === 0 };
}

/**
 * 挑目标设备。多台一律拒绝（`adb` 自己也会报 `more than one device`，但让它报错等于把
 * 「该选哪台」交给用户去猜；这里把在线清单列出来）。
 */
function pickAdbDevice(devices, wantedSerial) {
  const list = Array.isArray(devices) ? devices : [];
  const want = String(wantedSerial || '').trim();
  if (want) {
    const hit = list.find((d) => d.serial === want);
    if (!hit) {
      return {
        ok: false,
        error: `没有序列号为 ${want} 的设备（当前：${list.map((d) => `${d.serial}(${d.state})`).join(' / ') || '一台都没有'}）`,
      };
    }
    return { ok: true, device: hit };
  }
  if (!list.length) return { ok: false, reason: 'no-device' };
  // 只有一台 device 状态可自动选中；多台让用户指定
  const usable = list.filter((d) => d.state === 'device');
  if (usable.length === 1) return { ok: true, device: usable[0] };
  if (usable.length > 1) {
    return {
      ok: false,
      reason: 'multiple',
      error: `同时有 ${usable.length} 台设备在线（${usable.map((d) => d.serial).join(' / ')}）：请指定序列号，避免读到别的机器`,
    };
  }
  return {
    ok: false,
    reason: 'not-usable',
    device: list[0],
    error: `唯一在线的设备处于 ${list[0].state}：${ADB_STATES[list[0].state]?.label || list[0].state}`,
  };
}

/** `getprop` 输出 → 属性表。形如 `[ro.product.model]: [OPD2409]`；Android 的 shell 输出带 `\r`。 */
function parseGetprop(text) {
  const props = {};
  for (const raw of String(text || '').split('\n')) {
    // 只用 trim，不再单独 `replace(/\r$/, '')`：`trim` 本身就吃掉 `\r`，两条并存的结果是
    // 任意一条失效都不影响行为 —— 变异验证时它俩互相兜底，等于两条都没被真正测到。
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line);
    if (m) props[m[1]] = m[2];
  }
  return props;
}

/**
 * 属性表 → 人话摘要。
 * 只取「选固件/判断能不能刷」真正用得到的字段：型号（决定固件对不对）、系统版本（决定分区布局）、
 * ABI（决定镜像架构）、A/B 槽（决定要不要带 _a/_b）。其余属性几千条，全塞进来只会淹没有用信息。
 */
function summarizeAndroid(props = {}) {
  const g = (k) => String(props[k] || '').trim();
  const slot = g('ro.boot.slot_suffix') || (g('ro.build.ab_update') === 'true' ? '(A/B，当前槽未读到)' : '');
  return {
    manufacturer: g('ro.product.manufacturer'),
    brand: g('ro.product.brand'),
    model: g('ro.product.model'),
    codename: g('ro.product.device'),
    androidVersion: g('ro.build.version.release'),
    sdk: g('ro.build.version.sdk'),
    abi: g('ro.product.cpu.abi'),
    buildId: g('ro.build.id'),
    slot: slot || '',
    secure: g('ro.secure') === '1',
    // 判据缺席时留空字符串而不是 false：读不到 ≠ 不是 A/B。这条区分在本项目其它层已反复踩过。
    abUpdate: g('ro.build.ab_update') === '' ? null : g('ro.build.ab_update') === 'true',
  };
}

/** 一句话结论（供 notes 用）：把「是什么设备」与「下一步」合并，避免用户只看型号就去刷。 */
function describeAndroid({ device, summary } = {}) {
  const st = ADB_STATES[String(device?.state || '').toLowerCase()] || ADB_STATES.unknown;
  const s = summary || {};
  const id = [s.manufacturer, s.model].filter(Boolean).join(' ') || '(型号未读到)';
  const sys = [s.androidVersion && `Android ${s.androidVersion}`, s.abi, s.slot && `槽 ${s.slot}`].filter(Boolean).join(' / ');
  return {
    label: st.label,
    mode: st.mode,
    canFlash: false,
    next: st.next,
    text: `检测到 Android 设备 ${device?.serial || ''}（${id}${sys ? `，${sys}` : ''}）：${st.label}。${st.next}`,
  };
}

module.exports = {
  ADB_STATES, ADB_DEVICES_HEADER,
  isSafeSerial, parseAdbDeviceLine, parseAdbDevices, pickAdbDevice,
  parseGetprop, summarizeAndroid, describeAndroid,
};
