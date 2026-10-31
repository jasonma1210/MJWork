// Android fastboot 通道的纯逻辑（2026-10-31）：解析 `devices -l` / `getvar`、校验分区、装配命令与摘要。
//
// 为什么单独成模块：fastboot 的失败方式与 DFU / esptool 完全不同，判据不能复用。
//
// ── 本机实测（fastboot 37.0.0-14910828，macOS，不接设备）──
//   $ fastboot devices -l     → stdout 空 / stderr 空 / exit **0**
//   $ fastboot getvar product → **无限等待**，stderr 只反复打 `< waiting for any device >`，直到被杀
//   $ fastboot -s NOSUCHSERIAL getvar product → 同样挂住，只改成 `< waiting for NOSUCHSERIAL >`
// 三条结论直接决定本模块的形状：
//   ① 「没有设备」只能靠 devices 的空输出判，**不能靠退出码**（空输出时退出码是 0）；
//   ② 除 devices 外的每个子命令都必须**带超时**并把超时单列一档 —— 它不是「写失败」，
//      典型含义是「设备不在 bootloader / 没点授权弹窗」，下一步是去看一眼手机；
//   ③ 带 `-s` 不能让 fastboot 少等，所以 flash 前必须先用 devices 确认 serial 在位。
//   反过来说：任何「只靠打桩验过」的 fastboot 实现都会以为「没设备时飞快返回」，
//   然后在真机上把每次工具调用挂成一分半钟。
//
// 安全边界（三条，都是硬拒）：
//   · 分区白名单：只允许可回滚的应用/系统分区；引导链与基带分区（bootloader / xbl / modem / persist
//     之类）写错就是硬砖，一律拒绝并说明原因，不做「你确定吗」的开关；
//   · 解锁状态：读到 `unlocked: no` 就拒绝（刷了也必然失败，且可能触发反回滚）；
//     读不到时**只告警不拦**——设备侧的锁才是权威，fastboot 会自己 FAILED；
//   · 设备必须唯一：多台同时在线拒绝（与 DFU 同款理由，枚举顺序不稳定）。
//
// 有意不做：解锁（`flashing unlock` / `oem unlock`）、`erase` / `format` / `flashall` / `-w`、
// 回读校验（`fastboot fetch` 非标准且多数设备不支持）。本模块只产出「flush 一个已解锁分区」这一种写操作。

const crypto = require('crypto');
const { approvalCard } = require('./deviceFlash');

// `channel` 的别名表。与 DFU_CHANNEL_ALIASES / ESPTOOL_CHANNEL_ALIASES 同形：
// 别名表跟着**通道**走（定义在通道自己的模块里）；resolveFlashRoute 与 approval.js 都从这里取，
// 避免「路由认 fastboot、审批卡不认」这类两侧漂移。
const FASTBOOT_CHANNEL_ALIASES = ['fastboot', 'adb-fastboot', 'android-fastboot'];

// 可安全刷写的分区（基础名，不含 _a/_b）。挑法：能通过 fastboot 重刷回来、且写坏不影响引导链。
const FB_ALLOWED = new Set([
  'boot', 'init_boot', 'vendor_boot', 'recovery', 'dtbo',
  'vbmeta', 'vbmeta_system', 'vbmeta_vendor',
  'system', 'system_ext', 'product', 'vendor', 'odm', 'super', 'logo',
]);
// 明确点名拒绝的分区：错误信息要能说清「为什么这个不行」，而不是一句「不在白名单」。
const FB_FORBIDDEN = new Set([
  'bootloader', 'aboot', 'sbl1', 'xbl', 'tz', 'hyp', 'rpm', 'pmic', 'devcfg', 'ddr',
  'keymaster', 'cmnlib', 'cmnlib64', 'mdtp', 'sec',
  'modem', 'modemst1', 'modemst2', 'fsg', 'radio', 'persist',
]);
// 在 A/B 设备上以 `_a` / `_b` 成对存在的分区（不含 slotted 的写进去会落到「不存在」而失败）
const FB_SLOTTED = new Set([
  'boot', 'init_boot', 'vendor_boot', 'recovery', 'dtbo',
  'vbmeta', 'vbmeta_system', 'vbmeta_vendor', 'system', 'system_ext', 'product', 'vendor', 'odm',
]);

const FB_MAX_BUFFER = 2 * 1024 * 1024;

/**
 * 解析 `fastboot devices [-l]`。
 * 真机形状（tab 分隔）：`3A21FDH2001234\tfastboot usb:338690048X`
 * 空输出 = 没有设备（实测 exit 0），**不是**「工具坏了」。
 */
function parseFastbootDevices(stdout) {
  const text = String(stdout ?? '');
  const devices = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const serial = parts[0];
    if (!serial) continue;
    const rest = parts.slice(1).join(' ');
    // 第一段必须是 serial，第二段可省略；`fastboot` 这个词可有可无（不同版本）
    devices.push({ serial, mode: /^fastboot\b/i.test(rest) ? 'fastboot' : (rest ? 'unknown' : 'fastboot'), attrs: rest });
  }
  if (!devices.length) return { ok: true, devices: [], note: 'no-device' };
  return { ok: true, devices };
}

/**
 * 解析 `fastboot getvar <name>` 的输出。
 * 真机形状（两种前缀都存在，取决于设备与 fastboot 版本）：
 *   `(bootloader) product: barbet`   或   `product: barbet`
 * 末尾固定有一行 `Finished. Total time: 0.002s`，必须丢掉。
 */
function parseGetvar(stdout) {
  const text = String(stdout ?? '');
  const vars = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || /^Finished\./i.test(t) || /^< waiting/i.test(t) || /^\.\.\./i.test(t)) continue;
    const m = /^(?:\(bootloader\)\s*)?([A-Za-z0-9_.:-]+)\s*:\s*(.*)$/.exec(t);
    if (m) vars[m[1].toLowerCase()] = m[2].trim();
  }
  if (!Object.keys(vars).length) {
    return {
      ok: false, vars,
      error: `fastboot getvar 输出不可识别：既没有 key: value 行也没有 Finished 行。原始输出：${text.slice(0, 200) || '（空）'}`,
    };
  }
  return { ok: true, vars };
}

/** 多台设备必须拒绝：烧错手机的代价不可逆，而枚举顺序随插拔顺序变。 */
function pickDevice(devices, wantedSerial = '') {
  const list = Array.isArray(devices) ? devices : [];
  const want = String(wantedSerial || '').trim();
  if (!list.length) {
    return {
      ok: false,
      error: '没有处于 fastboot 模式的设备。先把手机连上、`adb reboot bootloader`（或关机后按音量下+电源），'
        + '再重跑一次。注意：普通开机状态 / 只开了 USB 调试都不算 fastboot。',
    };
  }
  if (want) {
    const hit = list.find((d) => d.serial === want);
    if (!hit) {
      return {
        ok: false,
        error: `指定的序列号 ${want} 不在线。当前在线的：${list.map((d) => d.serial).join(' / ')}`,
      };
    }
    return { ok: true, device: hit };
  }
  if (list.length > 1) {
    return {
      ok: false,
      error: `同时发现 ${list.length} 台 fastboot 设备：请只连一台，或用 serial 指定（${list.map((d) => d.serial).join(' / ')}）。`
        + '刷错手机不可逆。',
    };
  }
  return { ok: true, device: list[0] };
}

/**
 * 解锁状态判定。
 * 三值：'yes'（已解锁）/ 'no'（已锁）/ 'unknown'（读不到）。
 * unknown **不拦**（设备侧的锁才是权威，fastboot 自己会 FAILED），但必须写进 warnings。
 */
function unlockState(vars = {}) {
  const v = String(vars.unlocked ?? '').trim().toLowerCase();
  if (v === 'yes' || v === 'true') return { state: 'yes' };
  if (v === 'no' || v === 'false') return { state: 'no' };
  // 老设备/老 fastboot 没有 unlocked，只有 secure
  const secure = String(vars.secure ?? '').trim().toLowerCase();
  if (secure === 'no' || secure === 'false') return { state: 'yes', via: 'secure' };
  if (secure === 'yes' || secure === 'true') return { state: 'no', via: 'secure' };
  return { state: 'unknown' };
}

/** 把 `boot` + currentSlot=b 归一成 `boot_b`；已带 `_a/_b` 的按显式处理。 */
function resolvePartition(name, { slot = '', currentSlot = '' } = {}) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return { ok: false, error: '缺少分区名（fastboot flash <分区> <文件>）' };
  const explicitSlot = /_(a|b)$/.exec(raw);
  const base = explicitSlot ? raw.slice(0, -2) : raw;
  if (FB_FORBIDDEN.has(base)) {
    return {
      ok: false,
      error: `拒绝写入分区 \`${base}\`：它属于引导链/基带/校准分区（bootloader、xbl、modem、persist 一类），`
        + '写错不是「刷坏了重刷」，而是设备可能再也进不了 fastboot / 基带校准永久丢失。'
        + '这类分区只应由厂商售后工具处理。',
    };
  }
  if (!FB_ALLOWED.has(base)) {
    return {
      ok: false,
      error: `分区 \`${base}\` 不在可刷白名单里（允许：${[...FB_ALLOWED].join(' / ')}）。`
        + '不放行未知分区是有意的：分区名写错一个字母就可能落到引导链或校准分区上，而 fastboot 不会拦你。',
    };
  }
  const want = String(slot || currentSlot || '').trim().toLowerCase();
  if (explicitSlot) {
    const warnings = [];
    if (currentSlot && explicitSlot[1] !== String(currentSlot).toLowerCase()) {
      warnings.push(`显式指定的槽位 ${explicitSlot[1]} 与设备当前槽位 ${currentSlot} 不同：`
        + '这次刷的是**非活动槽**，重启后跑的还是旧系统（这是 OTA 的正常做法，手工刷机时通常是写错了）');
    }
    return { ok: true, partition: raw, base, slot: explicitSlot[1], warnings };
  }
  if (FB_SLOTTED.has(base) && (want === 'a' || want === 'b')) {
    return {
      ok: true, partition: `${base}_${want}`, base, slot: want,
      warnings: [`设备是 A/B 双槽，当前槽位 ${want}：实际写入 \`${base}_${want}\``],
    };
  }
  return { ok: true, partition: base, base, slot: '', warnings: [] };
}

/** 计划摘要：把「人确认过的参数」压成短串（与 esptool / uf2 / dfu 各算各的）。 */
function fbPlanDigest({ serial = '', partition = '', firmware = '', fileSize = 0 } = {}) {
  const payload = JSON.stringify([
    'fastboot', String(serial), String(partition), String(firmware), Number(fileSize) || 0,
  ]);
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/**
 * 装配 argv。`-s` 放在子命令**之前**（这是 fastboot 的参数位置），且**必须有**：
 * 不带 -s 时如果有两台设备，fastboot 会自己挑一台 —— 那是不受控的目标选择。
 */
function buildFbArgv({ serial, partition, firmware }) {
  return ['fastboot', '-s', String(serial), 'flash', String(partition), String(firmware)];
}

/**
 * 写入结果判定。
 * 「成功」= 退出码 0 且出现 `Finished. Total time` 且**没有** FAILED/error —— 三条同时成立。
 * 单看退出码不够：fastboot 在部分失败路径（`Sending ... FAILED`）之后仍可能返回 0。
 */
const FB_VERDICTS = {
  ok: 'ok',
  waiting: 'waiting',
  locked: 'locked',
  partition: 'partition',
  remote: 'remote',
  transfer: 'transfer',
  error: 'error',
};

function parseFastbootFlash(stdout, stderr, { exitCode = 0, killed = false } = {}) {
  const out = `${stdout ?? ''}\n${stderr ?? ''}`;
  const finished = /Finished\.\s*Total time/i.test(out);
  const failed = /FAILED|fastboot:\s*error/i.test(out);
  const remoteM = /FAILED\s*\(remote:\s*['"]?([^'")]+)/i.exec(out);
  let verdict = FB_VERDICTS.ok;
  if (killed || /< waiting for/i.test(out)) {
    // 一直在等设备：不是「写失败」，而是根本没开始写。下一步完全不同（去看手机 / 重进 bootloader）。
    verdict = FB_VERDICTS.waiting;
  } else if (/Flashing is not allowed|device is locked|not allowed for critical/i.test(out)) {
    verdict = FB_VERDICTS.locked;
  } else if (/unknown partition|could not find partition|partition .* not found/i.test(out)) {
    verdict = FB_VERDICTS.partition;
  } else if (remoteM) {
    verdict = FB_VERDICTS.remote;
  } else if (/write to device failed|too many links|Sending .*FAILED|data too large/i.test(out)) {
    verdict = FB_VERDICTS.transfer;
  } else if (!finished || exitCode !== 0 || failed) {
    verdict = FB_VERDICTS.error;
  }
  return {
    ok: verdict === FB_VERDICTS.ok,
    verdict, finished, failed,
    remote: remoteM ? remoteM[1].trim() : '',
    exitCode, killed,
  };
}

/**
 * 装配刷写计划（不执行）。
 * @returns {{ok:boolean, error?:string, digest?:string, argv?:string[], card?:object, warnings:string[], next?:string}}
 */
function buildFbPlan({
  device, partitionInfo, firmware = '', fileSize = 0, vars = {}, card = null,
} = {}) {
  const warnings = [];
  if (!device || !device.serial) return { ok: false, error: '缺少 fastboot 设备序列号', warnings };
  if (!partitionInfo || !partitionInfo.ok) {
    return { ok: false, error: (partitionInfo && partitionInfo.error) || '分区未通过校验', warnings };
  }
  if (!firmware) return { ok: false, error: '缺少镜像文件路径', warnings };
  if (!(Number(fileSize) > 0)) return { ok: false, error: '镜像为空或大小未知：拒绝写入', warnings };
  // 只接受 .img：.zip 是 OTA 包（要走 recovery/sideload），.bin 交给 DFU/esptool 通道，
  // 把 zip 当镜像发过去会得到一句难懂的 FAILED，而设备可能已经动过一笔。
  if (!/\.img$/i.test(firmware)) {
    return {
      ok: false, warnings,
      error: `fastboot 通道只接受 .img（分区镜像）：${firmware} 不是。`
        + 'OTA 的 .zip 要走 recovery 的 adb sideload；DFU 用 .bin/.dfu；esptool 用 .bin',
    };
  }

  const unlock = unlockState(vars);
  if (unlock.state === 'no') {
    return {
      ok: false, warnings,
      error: '设备处于锁定状态（unlocked: no / secure: yes）：fastboot 会直接拒绝写入。'
        + '解锁要在手机上完成：设置 → 开发者选项 → 打开「OEM 解锁」，再执行 `fastboot flashing unlock`'
        + '（多数机型会清空数据）。本工具**不做**解锁，这一步必须由人决定。',
    };
  }
  if (unlock.state === 'unknown') {
    warnings.push('读不到解锁状态（getvar 没有 unlocked / secure 字段）：不拦，但设备若已锁会直接 FAILED');
  }
  warnings.push(...(partitionInfo.warnings || []));

  const product = String(vars.product || vars['ro.product.device'] || '').trim();
  const slot = String(vars['current-slot'] || '').trim();
  const serial = String(device.serial);
  const digest = fbPlanDigest({ serial, partition: partitionInfo.partition, firmware, fileSize });
  const argv = buildFbArgv({ serial, partition: partitionInfo.partition, firmware });
  const name = String(firmware).split(/[\\/]/).pop();
  return {
    ok: true,
    digest, argv, warnings,
    serial, product, slot, partition: partitionInfo.partition,
    card: card || approvalCard({
      action: 'fastboot 刷入分区',
      // 卡面只渲染 tool + target ⇒ 序列号与分区必须在这里（用户唯一能核对的「刷哪台、刷哪个分区」）
      target: `${serial}${product ? ` (${product})` : ''} flash ${partitionInfo.partition} ← ${name}`,
      impact: `覆盖 ${partitionInfo.partition} 分区（${(Number(fileSize) / 1024 / 1024).toFixed(2)}MB）`,
      consequence: '分区是整块覆盖，没有写前备份；写错分区（尤其引导链）可能导致无法开机。'
        + '解锁设备上一般可通过重进 fastboot 重刷恢复',
      rollback: `重新进 bootloader（音量下+电源）后，用同一份镜像再刷一次 ${partitionInfo.partition}`,
      reversible: false,
    }),
    next: `请把目标（${serial} → ${partitionInfo.partition}）与文件给人类确认；`
      + `确认后调用 action=flash 并回传 plan_digest="${digest}"。`,
  };
}

module.exports = {
  FB_ALLOWED, FB_FORBIDDEN, FB_SLOTTED, FB_VERDICTS, FB_MAX_BUFFER, FASTBOOT_CHANNEL_ALIASES,
  parseFastbootDevices, parseGetvar, pickDevice, unlockState, resolvePartition,
  fbPlanDigest, buildFbArgv, parseFastbootFlash, buildFbPlan,
};
