// main/db/backup.js
// ST4-①：在线一致备份。
//
// 为什么不直接 cp：
//   WAL 模式下，已提交事务可能还在 `-wal` 里没 checkpoint 进主文件。
//   只拷 `mjcode-tasks.db` 会得到一份**缺最近事务**的快照；把 `-wal`、`-shm`
//   一起拷又要求文件在拷贝期间完全静止（否则得到撕裂快照）。两种都不对。
//
// 正确做法是让 SQLite 自己产出一致性快照：
//   · node:sqlite / better-sqlite3 → `VACUUM INTO '<path>'`（在线、一致、自带整理）
//   · sql.js（内存库、无 WAL）     → `flush()` 已用 tmp+rename+fsync 全量导出，
//                                    主文件本身即一致快照，读出来再原子写一份即可
// 注意 `VACUUM INTO` 的目标文件必须不存在，故先写 `.tmp` 再 rename。

const fs = require('fs');
const path = require('path');
const { writeFileDurable, fsyncDir } = require('../data/durableWrite');

const DEFAULT_KEEP = 7;
const FILE_PREFIX = 'mjcode-tasks-';

function pad2(n) { return String(n).padStart(2, '0'); }

/** 备份文件名：mjcode-tasks-YYYYMMDD-HHMMSS.db（字典序 = 时间序，便于轮转） */
function backupFileName(at = new Date()) {
  return `${FILE_PREFIX}${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}`
    + `-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}.db`;
}

function fsyncFile(file) {
  let fd = null;
  try { fd = fs.openSync(file, 'r'); fs.fsyncSync(fd); return true; }
  catch (e) { console.warn('[db] 备份文件 fsync 失败，掉电保护降级：', e && e.message); return false; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关闭失败无副作用 */ } } }
}

/**
 * 校验备份「能当独立库打开」——备份的价值在于能恢复，不是文件存在。
 * 运行时没有 node:sqlite 时返回 verified:false 并如实标注（不谎报已校验）。
 */
function verifySqliteFile(file) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) {
    // 运行时没有 node:sqlite（旧 Electron）：无法校验，如实标注「未校验」而不是谎报通过
    console.warn('[db] 运行时无 node:sqlite，备份无法做完整性校验（标注为未校验）：', e && e.message);
    return { ok: true, verified: false };
  }
  let d = null;
  try {
    try { d = new DatabaseSync(file, { readOnly: true }); }
    catch (e) {
      // 该 Node 版本的 DatabaseSync 不接受 readOnly：退回读写打开，校验完立即关闭
      console.warn('[db] 备份校验无法只读打开，退回读写模式：', e && e.message);
      d = new DatabaseSync(file);
    }
    const row = d.prepare('PRAGMA integrity_check').get();
    const val = row ? Object.values(row)[0] : undefined;
    if (String(val).toLowerCase() !== 'ok') return { ok: false, error: `integrity_check=${val}` };
    const t = d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get();
    if (!t || Number(t.n) < 1) return { ok: false, error: '备份里没有任何表（空文件或截断）' };
    return { ok: true, verified: true };
  } catch (e) {
    return { ok: false, error: e && e.message };
  } finally {
    try { d?.close(); } catch { /* 已关闭 */ }
  }
}

/**
 * 在线备份。
 * @param {object} db   已打开的驱动句柄（openDb / openDbAsync 返回）
 * @param {string} filePath 源库文件路径
 * @param {string} destPath 目标备份路径
 * @returns {{ok:boolean, path?:string, bytes?:number, verified?:boolean, dirFsynced?:boolean, error?:string}}
 */
function backupDb(db, filePath, destPath) {
  const driver = db && db.__driver;
  const tmp = `${destPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    if (driver === 'sqljs') {
      db.flush(); // 主文件刷成最新一致性快照
      writeFileDurable(tmp, fs.readFileSync(filePath));
    } else {
      // SQLite 标识符/字符串转义：路径里的单引号写两遍
      db.exec(`VACUUM INTO '${String(tmp).replace(/'/g, "''")}'`);
    }

    const check = verifySqliteFile(tmp);
    if (!check.ok) throw new Error(`备份校验失败：${check.error}`);

    fs.renameSync(tmp, destPath);
    fsyncFile(destPath);
    const dirFsynced = fsyncDir(path.dirname(destPath));
    return {
      ok: true,
      path: destPath,
      bytes: fs.statSync(destPath).size,
      verified: !!check.verified,
      dirFsynced,
    };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清理尽力而为 */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 轮转：只保留最近 keep 份（文件名含时间戳，字典序即时间序）。返回被删除的路径。 */
function pruneBackups(dir, keep = DEFAULT_KEEP) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) {
    // 目录不存在是正常（首次运行/从未备份）；其他错误必须留痕——
    // 否则「读失败」会被上层当成「没有旧备份」，备份无限堆积而无人知道。
    if (e && e.code !== 'ENOENT') console.warn('[db] 读取备份目录失败（本轮轮转跳过）：', e && e.message);
    return [];
  }
  const ours = names
    .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith('.db'))
    .sort();
  const excess = ours.slice(0, Math.max(0, ours.length - keep));
  const removed = [];
  for (const n of excess) {
    const p = path.join(dir, n);
    try { fs.unlinkSync(p); removed.push(p); }
    catch (e) { console.warn(`[db] 清理旧备份失败（${n}）：`, e && e.message); }
  }
  return removed;
}

/**
 * 每天至多备份一次（启动时调用）。当天已有备份则跳过——
 * 避免每次重启都拷一份 40MB 级库文件。
 * @returns {{ok:boolean, skipped?:boolean, path?:string, removed?:string[], error?:string}}
 */
function maybeDailyBackup(db, filePath, backupDir, at = new Date()) {
  const stamp = `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}`;
  try {
    const existing = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((n) => n.startsWith(`${FILE_PREFIX}${stamp}-`))
      : [];
    if (existing.length > 0) return { ok: true, skipped: true };
  } catch (e) {
    console.warn('[db] 检查今日备份失败（继续尝试备份）：', e && e.message);
  }
  const res = backupDb(db, filePath, path.join(backupDir, backupFileName(at)));
  if (!res.ok) return res;
  return { ...res, removed: pruneBackups(backupDir) };
}

module.exports = {
  backupDb,
  pruneBackups,
  maybeDailyBackup,
  backupFileName,
  verifySqliteFile,
  DEFAULT_KEEP,
  FILE_PREFIX,
};
