// 磁盘保留策略（ST4-③，2026-11-05）
//
// 为什么需要它：userData 下有几类「按日 / 按版本」文件从来没有过期机制，实测堆积为
//   · logs/main-YYYY-MM-DD.log        10 份（10-14 起，只增不减）
//   · diagnostics/crash-YYYY-MM-DD.jsonl  11 份（10-15 起）
//   · mjcode-tasks.db.pre-vN.bak 三件套   10 份（10-20 起，每份都是整库副本）
// 单看都不大（合计 ~1.3MB + 若干 MB），但它们是**只增不减**的：用得越久磁盘越脏，
// 而这台机器的 userData 已经有 1.6G（其中 1.2G 是 Chromium 自有 Cache，会自愈，不归本模块管）。
//
// 刻意不做的三件事（避免「为治理而制造新问题」）：
//   · 不碰 Chromium 自有缓存（Cache / Code Cache / GPUCache）——Electron 自己管，插手只会互相踩；
//   · 不碰 local-data.<日期>.json——localStore.dailyBackup() 已有 7 天 TTL，再实现一套就是两处打架；
//   · 不碰 diagnostics/*.zip——用户主动点「导出诊断」的产物，属于用户财产，不是缓存。
//   同理 team-debug-*.jsonl 由 teamDebugLog.pruneOldFiles() 按「保留最近 7 个文件」管，
//   本模块不重复处理（只在那边补上被漏掉的 `.jsonl.1` 轮转文件）。
//
// 安全红线（删文件不可逆，以下是硬约束，不是「尽量」）：
//   · 白名单正则一律 `^...$` **全锚定**，绝不出现前缀拼接 / 通配；
//   · 只 unlink **普通文件**（lstat 判 isFile）——符号链接、目录、设备文件一律跳过；
//   · 不递归（本模块不实现任何目录遍历下钻）；
//   · 迁移快照按**版本号**排序而非 mtime：pre-vN.bak 是 vN→vN+1 的回滚点，
//     保留版本号最高的 MIGRATION_SNAPSHOT_VERSIONS 个，且**最高版本无条件保留**；
//   · 「今天」的文件无条件保留（哪怕 keepDays 被配置成 0）；
//   · 单文件失败不影响其它文件；整体失败不抛（保留策略绝不能阻断启动），但必须留痕（C-001）。
const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;

// 全锚定：任何一个字符不匹配就不动它。
const MAIN_LOG_RE = /^main-(\d{4})-(\d{2})-(\d{2})\.log$/;
const CRASH_LOG_RE = /^crash-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const MIGRATION_BAK_RE = /^mjcode-tasks\.db\.pre-v(\d+)\.bak(?:-(?:wal|shm))?$/;

const DEFAULTS = {
  mainLogKeepDays: 14,
  crashLogKeepDays: 14,
  migrationSnapshotVersions: 2,
};

function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * 从文件名取「日」时间戳（UTC 零点）。
 * @returns {number|null} 不匹配或非法日期（如 2026-13-45）返回 null —— 非法名一律不参与清理。
 */
function fileDayTs(name, re) {
  const m = String(name).match(re);
  if (!m) return null;
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (!Number.isFinite(ts)) return null;
  // Date.parse 会把 2026-02-31 归一化成 3-03，回头比对字符串确保「名字本身是合法日期」
  if (dayKey(new Date(ts)) !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  return ts;
}

function readdirSafe(dir, errors) {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    // ENOENT = 这个功能从没用过，属正常；其它错误必须留痕，否则「清理没生效」会被当成「没东西可清」。
    if (e && e.code !== 'ENOENT') errors.push({ dir, error: String(e.message || e) });
    return [];
  }
}

function statFileOnly(file, errors) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null; // 符号链接 / 目录 / FIFO 一律跳过
    return st;
  } catch (e) {
    errors.push({ file, error: String((e && e.message) || e) });
    return null;
  }
}

/** 按「日」判定过期（保留最近 keepDays 天，今天无条件保留）。 */
function collectDayExpired(dir, re, keepDays, now, errors) {
  const out = [];
  const today = dayKey(now);
  const cutoff = Date.parse(`${today}T00:00:00Z`) - (keepDays - 1) * DAY_MS;
  for (const name of readdirSafe(dir, errors)) {
    const ts = fileDayTs(name, re);
    if (ts == null) continue;
    if (dayKey(new Date(ts)) === today) continue; // 今天正在写的，无条件保留
    if (ts >= cutoff) continue;
    const full = path.join(dir, name);
    const st = statFileOnly(full, errors);
    if (!st) continue;
    out.push({ path: full, name, bytes: st.size, reason: `超过 ${keepDays} 天` });
  }
  return out;
}

/** 按「迁移版本号」判定过期：保留最高 N 个版本，最高版本无条件保留。 */
function collectMigrationExpired(dir, keepVersions, errors) {
  const byVersion = new Map();
  for (const name of readdirSafe(dir, errors)) {
    const m = name.match(MIGRATION_BAK_RE);
    if (!m) continue;
    const v = Number(m[1]);
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(name);
  }
  const versions = [...byVersion.keys()].sort((a, b) => b - a);
  const keep = Math.max(1, keepVersions);
  const kept = new Set(versions.slice(0, keep));
  const out = [];
  for (const v of versions) {
    if (kept.has(v)) continue;
    for (const name of byVersion.get(v)) {
      const full = path.join(dir, name);
      const st = statFileOnly(full, errors);
      if (!st) continue;
      out.push({ path: full, name, bytes: st.size, reason: `迁移快照 v${v}（只保留最近 ${keep} 个版本）` });
    }
  }
  return out;
}

/**
 * 执行一次保留策略。
 *
 * @param {string} userDataDir  Electron userData 目录（本地数据根）
 * @param {object} [opts]
 * @param {Date}   [opts.now]          注入「现在」，便于单测构造过期场景（不打桩 Date）
 * @param {boolean}[opts.dryRun]       true 只统计不删除
 * @param {number} [opts.mainLogKeepDays]
 * @param {number} [opts.crashLogKeepDays]
 * @param {number} [opts.migrationSnapshotVersions]
 * @returns {{ok:boolean, dryRun:boolean, removed:Array, failed:Array, errors:Array, freed:number, scanned:number}}
 */
function runRetention(userDataDir, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dryRun = opts.dryRun === true;
  const cfg = {
    mainLogKeepDays: Number.isFinite(opts.mainLogKeepDays) ? opts.mainLogKeepDays : DEFAULTS.mainLogKeepDays,
    crashLogKeepDays: Number.isFinite(opts.crashLogKeepDays) ? opts.crashLogKeepDays : DEFAULTS.crashLogKeepDays,
    migrationSnapshotVersions: Number.isFinite(opts.migrationSnapshotVersions)
      ? opts.migrationSnapshotVersions
      : DEFAULTS.migrationSnapshotVersions,
  };

  const errors = [];
  const candidates = [];
  if (!userDataDir) {
    return { ok: false, dryRun, removed: [], failed: [], errors: [{ error: 'userDataDir 为空' }], freed: 0, scanned: 0 };
  }

  candidates.push(...collectDayExpired(path.join(userDataDir, 'logs'), MAIN_LOG_RE, cfg.mainLogKeepDays, now, errors));
  candidates.push(...collectDayExpired(path.join(userDataDir, 'diagnostics'), CRASH_LOG_RE, cfg.crashLogKeepDays, now, errors));
  candidates.push(...collectMigrationExpired(userDataDir, cfg.migrationSnapshotVersions, errors));

  const removed = [];
  const failed = [];
  for (const c of candidates) {
    if (dryRun) { removed.push({ ...c, dryRun: true }); continue; }
    try {
      fs.unlinkSync(c.path);
      removed.push(c);
    } catch (e) {
      // 删不掉（占用 / 权限）不算致命：下次启动再试，但必须留痕，否则「策略生效了」是假的。
      failed.push({ name: c.name, error: String((e && e.message) || e) });
    }
  }

  const freed = removed.reduce((n, x) => n + (x.bytes || 0), 0);
  return {
    ok: failed.length === 0 && errors.length === 0,
    dryRun,
    removed,
    failed,
    errors,
    freed,
    scanned: candidates.length,
  };
}

/** 给上层拼一行日志用的摘要；没有可清理的东西时返回空串（不刷屏）。 */
function summarize(r) {
  if (!r || (!r.removed.length && !r.failed.length && !r.errors.length)) return '';
  const kb = (n) => `${Math.round((n || 0) / 1024)}KB`;
  const parts = [];
  if (r.removed.length) parts.push(`${r.dryRun ? '待清理' : '已清理'} ${r.removed.length} 份 / ${kb(r.freed)}`);
  if (r.failed.length) parts.push(`失败 ${r.failed.length} 份`);
  if (r.errors.length) parts.push(`扫描异常 ${r.errors.length} 处`);
  return parts.join('，');
}

module.exports = {
  runRetention,
  summarize,
  // 单测直接探针：规则是纯函数，能单独验「哪些该删」而不必真的落盘
  collectDayExpired,
  collectMigrationExpired,
  fileDayTs,
  MAIN_LOG_RE,
  CRASH_LOG_RE,
  MIGRATION_BAK_RE,
  DEFAULTS,
};
