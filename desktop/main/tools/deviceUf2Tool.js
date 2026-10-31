// UF2 写入通道的执行器（L4，2026-10-31）：找盘 → 校验 → 拷 → 等设备重启。
//
// 判据全部在 deviceUf2.js（纯函数），这里只负责「跟真实文件系统打交道」，并且把
// 「写成功」定义成三件事同时成立：
//   ① 源文件通过 UF2 结构校验（否则 bootloader 会静默忽略非法块，用户以为刷完了）；
//   ② 目标卷确实是 UF2 bootloader 盘（有 INFO_UF2.TXT），且落在系统挂载根下；
//   ③ 落盘字节数 == 源文件字节数，且设备随后**卸载了该卷**（它自己宣布写完了）。
// 少任何一条就只是「拷了个文件」。
//
// 为什么不允许 `/Volumes` 以外的路径：一旦放开，这个 handler 就变成一个任意文件拷贝原语
// （模型可传 volume=/Users/xxx 然后覆盖任意文件）。它不是「顺便支持一下」，是必须堵死的注入面。

const fsn = require('fs');
const path = require('path');
const {
  parseUf2, isUf2Volume, pickUf2Volume, buildUf2Plan, uf2PlanDigest, UF2_VOLUME_MARKER,
} = require('../deviceUf2');

// 允许的目标卷根：只认系统挂载目录。win32 没接线（盘符枚举未真机验证，不写没验过的命令）。
const VOLUME_ROOTS = { darwin: ['/Volumes'], linux: ['/media', '/run/media'] };

const REBOOT_TIMEOUT_MS = 30000;
const REBOOT_POLL_MS = 300;

/** 目标卷路径是否落在允许的挂载根下（且不是根本身）。 */
function isAllowedVolumePath(volume, platform) {
  const roots = VOLUME_ROOTS[platform] || [];
  const p = path.resolve(String(volume || ''));
  return roots.some((r) => p !== r && p.startsWith(`${r}${path.sep}`));
}

/**
 * 枚举当前挂载点并读出卷根文件清单。
 * 读失败的卷不丢弃而是标 `unreadable`：被静默跳过的卷会让「没找到 UF2 盘」变成假结论。
 */
function readVolumes({ fsx = fsn, platform = process.platform } = {}) {
  const roots = VOLUME_ROOTS[platform] || [];
  const out = [];
  for (const root of roots) {
    let names = [];
    try {
      names = fsx.readdirSync(root);
    } catch {
      // 根目录不存在（Linux 只有 /media 没有 /run/media 是常态）不算错误：跳过这个根，
      // 后面还有别的根要试。这里不记日志是刻意的——记了会让每次探测都刷一条无害告警。
      continue;
    }
    for (const name of names) {
      const p = path.join(root, name);
      try {
        const st = fsx.statSync(p);
        if (!st.isDirectory()) continue;
        out.push({ path: p, files: fsx.readdirSync(p), isRoot: false });
      } catch (e) {
        out.push({ path: p, files: [], isRoot: false, unreadable: String(e?.message || e).slice(0, 80) });
      }
    }
  }
  return out;
}

/** 轮询等设备卸载该卷（= bootloader 写完并重启）。返回 waitedMs 便于报告实际耗时。 */
async function waitVolumeGone(volume, { fsx = fsn, sleep, now, timeoutMs = REBOOT_TIMEOUT_MS, intervalMs = REBOOT_POLL_MS } = {}) {
  const t0 = now();
  for (;;) {
    if (!fsx.existsSync(volume)) return { gone: true, waitedMs: now() - t0 };
    if (now() - t0 >= timeoutMs) return { gone: false, waitedMs: now() - t0 };
    await sleep(intervalMs);
  }
}

/** 剩余空间（字节）。取不到返回 null —— 不能返回 0，0 会被当成「没空间」把合法写入拦掉。 */
function freeBytes(volume, { fsx = fsn } = {}) {
  try {
    if (typeof fsx.statfsSync !== 'function') return null;
    const s = fsx.statfsSync(volume);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    // 取不到就返回 null（未知），**不是 0**：0 会被当成「没有空间」把合法写入拦掉。
    return null;
  }
}

/**
 * 执行 UF2 通道的 plan / flash。
 * @param {object} args  { action: 'plan'|'flash', firmware, volume?, plan_digest? }
 * @param {object} deps  注入 fsx / sleep / now / platform，便于单测（不碰真实磁盘）
 */
async function uf2ChannelHandler(args = {}, deps = {}) {
  const fsx = deps.fsx || fsn;
  const platform = deps.platform || process.platform;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const action = String(args.action || 'plan');
  const firmware = String(args.firmware || '').trim();
  const wanted = String(args.volume || '').trim();

  // ① 源文件
  let st;
  try {
    st = fsx.statSync(firmware);
  } catch (e) {
    return { ok: false, channel: 'uf2-copy', action, error: `固件不可读：${firmware}（${String(e?.message || e).slice(0, 80)}）` };
  }
  if (!st.isFile()) return { ok: false, channel: 'uf2-copy', action, error: `不是文件：${firmware}` };
  if (!st.size) return { ok: false, channel: 'uf2-copy', action, error: `文件是空的（0 字节）：${firmware}` };

  // ② UF2 结构校验（读全文；UF2 通常几百 KB，可以整读）
  let parsed;
  try {
    parsed = parseUf2(fsx.readFileSync(firmware));
  } catch (e) {
    return { ok: false, channel: 'uf2-copy', action, error: `读取固件失败：${String(e?.message || e).slice(0, 80)}` };
  }
  if (!parsed.ok) return { ok: false, channel: 'uf2-copy', action, error: `UF2 校验未通过：${parsed.error}` };

  // ③ 目标卷
  let volume = wanted;
  if (volume) {
    if (!isAllowedVolumePath(volume, platform)) {
      const roots = (VOLUME_ROOTS[platform] || []).join(' / ') || '（本平台未接线）';
      return {
        ok: false, channel: 'uf2-copy', action,
        error: `目标卷必须在系统挂载目录下（${roots}）：拒绝写入 ${volume}。`
          + 'UF2 通道只写 bootloader 盘，不是通用文件拷贝。',
      };
    }
    let files = [];
    try {
      files = fsx.readdirSync(volume);
    } catch (e) {
      return { ok: false, channel: 'uf2-copy', action, error: `目标卷不可读：${volume}（${String(e?.message || e).slice(0, 80)}）` };
    }
    if (!isUf2Volume({ path: volume, files })) {
      return {
        ok: false, channel: 'uf2-copy', action,
        error: `目标卷不是 UF2 bootloader 盘：${volume} 根目录没有 ${UF2_VOLUME_MARKER}。`
          + '（这条判据是为了防止把固件拷进普通 U 盘或磁盘映像——那样什么也不会发生，却看起来完成了）',
      };
    }
  } else {
    const picked = pickUf2Volume(readVolumes({ fsx, platform }));
    if (!picked.ok) return { ok: false, channel: 'uf2-copy', action, error: picked.error, candidates: picked.candidates };
    volume = picked.volume;
  }

  // ④ 空间检查：只告警不阻断（statfs 在 APFS 上给的是估算值，不足以作为拒绝依据）
  const free = freeBytes(volume, { fsx });
  const warnings = [];
  if (free !== null && free < st.size) {
    warnings.push(`目标卷剩余空间可能不足（剩余 ${(free / 1024).toFixed(0)}KB < 需要 ${(st.size / 1024).toFixed(0)}KB）：写入可能失败`);
  }

  if (action === 'plan') {
    const built = buildUf2Plan({ firmware, volume, fileSize: st.size, parsed });
    if (!built.ok) return { ok: false, channel: 'uf2-copy', action, error: built.error, warnings };
    return {
      ok: true, channel: 'uf2-copy', action,
      volume, firmware, sizeBytes: st.size,
      blocks: parsed.blocks, payloadBytes: parsed.payloadBytes,
      plan_digest: built.digest, card: built.card,
      warnings: [...warnings, ...built.warnings], next: built.next,
    };
  }

  // ⑤ 执行：摘要一致性（防「看过 A 计划、实际写 B」）
  const digest = String(args.plan_digest || '').trim();
  if (!digest) return { ok: false, channel: 'uf2-copy', action, error: '缺少 plan_digest：先 action=plan 让人看过审批卡再执行', warnings };
  const expect = uf2PlanDigest({ firmware, volume, fileSize: st.size });
  if (digest !== expect) {
    return {
      ok: false, channel: 'uf2-copy', action,
      error: `plan_digest 不匹配（当前参数算出 ${expect}）：目标或文件在确认后变过，请重新 plan 并让人再看一眼`,
      warnings,
    };
  }

  const dest = path.join(volume, path.basename(firmware));
  try {
    fsx.copyFileSync(firmware, dest);
  } catch (e) {
    return { ok: false, channel: 'uf2-copy', action, error: `写入失败：${String(e?.message || e).slice(0, 120)}（目标 ${dest}）`, warnings };
  }
  // ⑥ 落盘自证。这里有个真实时序：UF2 bootloader 收完最后一块就立刻重启并卸载卷，
  //    所以「拷完立刻 stat 不到目标文件」是**正常现象**，不是失败。判据要按「卷还在不在」分叉：
  //      卷已消失 → 设备已经开始重启 = 写入成功（此时读不到文件是应该的）；
  //      卷还在但文件没了 → 才是异常（被别的东西删了 / 写入被拒）。
  let wrote = 0;
  if (fsx.existsSync(dest)) {
    try {
      wrote = Number(fsx.statSync(dest).size) || 0;
    } catch (e) {
      return { ok: false, channel: 'uf2-copy', action, error: `写入后读不到目标文件：${dest}（${String(e?.message || e).slice(0, 80)}）`, warnings };
    }
    if (wrote !== st.size) {
      return {
        ok: false, channel: 'uf2-copy', action,
        error: `落盘字节数不符：期望 ${st.size}，实际 ${wrote}（目标盘可能已满或被中断）`,
        warnings,
      };
    }
  } else if (fsx.existsSync(volume)) {
    return {
      ok: false, channel: 'uf2-copy', action,
      error: `写入后目标文件消失，但卷仍在（${volume}）：写入被拒绝或被其它进程删除，请重试`,
      warnings,
    };
  } else {
    // 卷已卸载：设备重启中，文件随之消失。这是 UF2 成功的正常时序。
    wrote = st.size;
    warnings.push('目标卷在拷贝完成后已卸载（设备重启中）：这是 UF2 的正常完成时序');
  }

  // ⑦ 等设备重启（卷消失）。这是「写成功」的唯一外部信号，不能跳过也不能当成失败。
  const wait = await waitVolumeGone(volume, { fsx, sleep, now });
  if (!wait.gone) {
    warnings.push(`文件已写入（${wrote} 字节），但设备在 ${(REBOOT_TIMEOUT_MS / 1000).toFixed(0)}s 内没有重启：`
      + '可能写入未生效、或这块 bootloader 需要手动复位。请拔插/复位后确认固件是否运行。');
  }
  return {
    ok: true, channel: 'uf2-copy', action,
    volume, firmware, dest, sizeBytes: wrote,
    blocks: parsed.blocks, payloadBytes: parsed.payloadBytes,
    rebooted: wait.gone, waitedMs: wait.waitedMs,
    warnings,
  };
}

module.exports = {
  uf2ChannelHandler, readVolumes, waitVolumeGone, freeBytes, isAllowedVolumePath,
  VOLUME_ROOTS, REBOOT_TIMEOUT_MS,
};
