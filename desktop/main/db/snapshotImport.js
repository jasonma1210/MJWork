// main/db/snapshotImport.js
// ST4-②：版本化导入（快照恢复）。
//
// 为什么不「运行期直接换文件」：
//   SQLite 连接打开后持有文件描述符，指向的是**旧 inode**。把新文件 rename 到原路径后，
//   旧连接继续写入会把新库覆盖掉（写进已 unlink 的 inode），数据静默丢失。
//   所以拆成两段：
//     · stage（运行期）：只读校验 → 规范化成一个独立快照 → 落暂存 + 标记
//     · apply（启动期）：在 openDbAsync **打开库之前**原子替换（此时没有任何连接）
//   用户视角 = 「导入后重启一次生效」，比在线换库安全得多。
//
// 导入是覆盖性操作，故一律 **fail-closed**：
//   不是本应用的库 / 版本高于当前应用 / 运行时无法校验 —— 全部拒绝，不应用。

const fs = require('fs');
const path = require('path');
const { writeFileDurable, fsyncDir } = require('../data/durableWrite');
const { verifySqliteFile, fsyncFile } = require('./backup');

const DB_FILE = 'mjcode-tasks.db';
const PENDING_FILE = 'import-pending.db';
const MARKER_FILE = 'import-pending.json';
// 只要这张表在，就说明是本应用的库（v1 迁移即创建，任何版本的快照都有）
const REQUIRED_TABLE = 'task_groups';

function dbFile(dataDir) { return path.join(dataDir, DB_FILE); }

/**
 * 只读体检快照。不改动源文件、不碰生产库。
 * @param {string} file 候选快照
 * @param {number} targetVersion 当前应用支持的 schema 版本（MIGRATIONS 最新）
 * @returns {{ok:boolean, userVersion?:number, needsUpgrade?:boolean, error?:string}}
 */
function inspectSnapshot(file, targetVersion) {
  const base = verifySqliteFile(file);
  if (!base.ok) return { ok: false, error: `不是可用的 SQLite 快照：${base.error}` };

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) {
    // 体检依赖 PRAGMA 读版本；读不到版本就无法判断兼容性 ⇒ 拒绝，而不是"看起来没问题就导"
    return { ok: false, error: `运行时无 node:sqlite，无法判断快照兼容性：${e && e.message}` };
  }
  let d = null;
  try {
    try { d = new DatabaseSync(file, { readOnly: true }); }
    catch (e) {
      console.warn('[db] 快照体检无法只读打开，退回读写模式：', e && e.message);
      d = new DatabaseSync(file);
    }
    const has = d.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name=?").get(REQUIRED_TABLE);
    if (!has || Number(has.n) !== 1) {
      return { ok: false, error: `快照不是本应用的库（缺 ${REQUIRED_TABLE} 表）` };
    }
    const row = d.prepare('PRAGMA user_version').get();
    const userVersion = Number(row ? Object.values(row)[0] : 0) || 0;
    if (Number.isFinite(targetVersion) && userVersion > targetVersion) {
      return { ok: false, error: `快照 schema 版本 v${userVersion} 高于当前应用支持的 v${targetVersion}（降级会丢字段）` };
    }
    return { ok: true, userVersion, needsUpgrade: Number.isFinite(targetVersion) && userVersion < targetVersion };
  } catch (e) {
    return { ok: false, error: e && e.message };
  } finally {
    try { d?.close(); } catch { /* 已关闭 */ }
  }
}

/**
 * 运行期暂存：校验 → 规范化成独立快照（VACUUM INTO，顺带把 -wal 里的已提交内容并进来）
 * → 落暂存 + 标记。**不动生产库**，真正生效在下次启动。
 */
function stageImport(srcFile, dataDir, targetVersion) {
  const info = inspectSnapshot(srcFile, targetVersion);
  if (!info.ok) return info;
  const pending = path.join(dataDir, PENDING_FILE);
  const markerFile = path.join(dataDir, MARKER_FILE);
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) { return { ok: false, error: `运行时无 node:sqlite，无法规范化快照：${e && e.message}` }; }
  let d = null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
    // 用 VACUUM INTO 而不是 copyFileSync：源快照可能还带 -wal，
    // 只拷主文件会漏掉最近已提交事务；VACUUM INTO 读的是「源库的完整逻辑内容」。
    try { d = new DatabaseSync(srcFile, { readOnly: true }); }
    catch (e) {
      console.warn('[db] 暂存导入无法只读打开源快照，退回读写模式：', e && e.message);
      d = new DatabaseSync(srcFile);
    }
    d.exec(`VACUUM INTO '${String(pending).replace(/'/g, "''")}'`);
    d.close();
    d = null;

    const check = verifySqliteFile(pending);
    if (!check.ok || check.verified === false) {
      throw new Error(`暂存快照未通过校验：${check.error || '运行时无法校验'}`);
    }
    fsyncFile(pending);
    fsyncDir(dataDir);
    writeFileDurable(markerFile, JSON.stringify({
      stagedAt: Date.now(),
      source: path.basename(srcFile),
      userVersion: info.userVersion,
      targetVersion,
    }, null, 2));
    return { ok: true, pending, userVersion: info.userVersion, needsUpgrade: info.needsUpgrade };
  } catch (e) {
    try { d?.close(); } catch { /* 已关闭 */ }
    try { if (fs.existsSync(pending)) fs.unlinkSync(pending); } catch { /* 清理尽力而为 */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 启动期应用：在打开库之前调用。
 * 顺序：回滚点 → 旧库挪开 → 暂存换入 → 清旧 -wal/-shm → 删标记。
 */
function applyPendingImport(dataDir) {
  const markerFile = path.join(dataDir, MARKER_FILE);
  if (!fs.existsSync(markerFile)) return { ok: true, applied: false };
  const pending = path.join(dataDir, PENDING_FILE);
  if (!fs.existsSync(pending)) {
    try { fs.unlinkSync(markerFile); } catch { /* 尽力清理 */ }
    return { ok: false, error: '存在导入标记但暂存快照缺失（已清理标记，按现库继续）' };
  }
  const check = verifySqliteFile(pending);
  // 导入是覆盖性操作：校验不了就不导（verified:false = 运行时没能力校验）
  if (!check.ok || check.verified === false) {
    return { ok: false, error: `暂存快照未通过校验，拒绝应用：${check.error || '运行时无法校验'}` };
  }

  const target = dbFile(dataDir);
  const rollback = path.join(dataDir, `mjcode-tasks.pre-import-${Date.now()}.db`);
  try {
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, rollback);
      // WAL 下只拷主文件会丢最近事务，回滚点必须连 -wal/-shm 一起
      for (const sfx of ['-wal', '-shm']) {
        if (fs.existsSync(target + sfx)) fs.copyFileSync(target + sfx, rollback + sfx);
      }
      fsyncFile(rollback);
      fsyncDir(dataDir);
    }
  } catch (e) {
    return { ok: false, error: `导入前备份现库失败，放弃导入：${e && e.message}` };
  }

  const old = `${target}.replaced-${process.pid}`;
  try {
    if (fs.existsSync(old)) fs.unlinkSync(old);
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(pending, target);
    // 旧库的 -wal/-shm 必须清掉：它们属于旧 inode，留着会让新库读到不匹配的日志
    for (const sfx of ['-wal', '-shm']) {
      try { if (fs.existsSync(target + sfx)) fs.unlinkSync(target + sfx); } catch { /* 尽力清理 */ }
    }
    fsyncDir(dataDir);
    try { fs.unlinkSync(old); } catch { /* 旧库已在回滚点里，删不掉不影响 */ }
    try { fs.unlinkSync(markerFile); } catch { /* 尽力清理 */ }
    return { ok: true, applied: true, rollback };
  } catch (e) {
    // 失败要把旧库放回原位，否则下次启动会打开一个不存在的库
    try {
      if (!fs.existsSync(target) && fs.existsSync(old)) fs.renameSync(old, target);
    } catch (e2) {
      console.error('[db] 导入失败且旧库回位失败，需人工从回滚点恢复：', e2 && e2.message);
    }
    return { ok: false, error: String((e && e.message) || e), rollback };
  }
}

module.exports = {
  inspectSnapshot,
  stageImport,
  applyPendingImport,
  DB_FILE,
  PENDING_FILE,
  MARKER_FILE,
  REQUIRED_TABLE,
};
