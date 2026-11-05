// 数据库维护 IPC（ST4-④，2026-11-05）
//
// 为什么需要它：ST4-① 备份与 ST4-② 导入**后端早就写完了，但用户侧一个入口都没有**——
// `maybeDailyBackup` 只在启动时被动跑一次，`stageImport` 全仓只有测试调用。
// 「已落地」不等于「用户能用」，这正是本项目反复踩的那条「矩阵恒绿 ≠ 已接线」。
// 本模块只做三件事：把已有能力接到 IPC 上、把路径来源收归系统对话框、把「覆盖性操作」
// 做成用户看得懂的两次确认。
//
// 设计纪律（每条都对应一类真实事故）：
//   · **路径只能来自主进程的系统对话框**，渲染层传来的路径一律忽略（与 `local:threads/export`、
//     `ledger:export` 同一纪律）——否则等于开放「任意路径读写」原语，一个 XSS 就能改写整个库。
//   · 导入拆两段 + **一次性令牌**：`pick`（选文件 + 只读体检，结果留在主进程内存，返回随机令牌）
//     → `commit`（凭令牌执行暂存）。渲染层全程拿不到、也传不进任何路径。
//   · 导入是覆盖性操作 ⇒ **fail-closed**：体检不过直接拒（不是本库 / 版本高于当前应用 /
//     无法校验），不做「尽力而为」。
//   · 真正换入发生在**下次启动**（`openDbAsync` 打开库之前）——连接一旦建立就持有旧 inode 的 fd，
//     运行期 rename 换文件会被旧连接写覆盖。所以 commit 成功只代表「已暂存」，
//     必须如实告诉用户「还需重启」，不能假装已经生效。
//   · 任何失败都返回结构化 `code` + `error`，不压成布尔——「备份失败」和「没数据库」是
//     完全不同的下一步。
const { ipcMain, dialog, BrowserWindow, app } = require('electron');
const path = require('path');
const crypto = require('crypto');
const guard = require('./payloadGuard');
const liveDb = require('../db/liveDb');
const backup = require('../db/backup');
const snapshotImport = require('../db/snapshotImport');

// 选择结果的有效期：用户点完「选择快照」去泡了杯咖啡再回来点「确认导入」，仍应能用；
// 但留一个上限，避免一个陌生文件的令牌在进程里长久挂着。
const PICK_TTL_MS = 5 * 60 * 1000;

let pendingPick = null;

function userDataDir() { return app.getPath('userData'); }
function dbFilePath() { return path.join(userDataDir(), snapshotImport.DB_FILE); }

// 目标 schema 版本 = 迁移表长度（MIGRATIONS 的 version 就是 1..N，实测 len=19 ↔ 版本集合 1..19）。
// 读不到时返回 0：`inspectSnapshot` 会因此把任何非空版本判成「过高」而拒绝导入——
// 这是刻意的 fail-closed 方向（宁可导不进来，也不能把高版本库降级写坏）。
function targetVersion() {
  try {
    const { MIGRATIONS } = require('../db');
    return Array.isArray(MIGRATIONS) ? MIGRATIONS.length : 0;
  } catch (e) {
    console.warn('[dbMaint] 读取 MIGRATIONS 失败，目标版本按 0 处理（导入将被 fail-closed 拒绝）:', e && e.message);
    return 0;
  }
}

function focusedWindow() {
  try { return BrowserWindow.getFocusedWindow() || null; } catch (e) {
    // 取窗口只为让对话框居中挂在主窗口上；取不到就开无父窗口的对话框，不影响功能。
    console.warn('[dbMaint] 取当前窗口失败（改为无父窗口打开对话框）:', e && e.message);
    return null;
  }
}

async function showSave(opts) {
  const win = focusedWindow();
  return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts);
}

async function showOpen(opts) {
  const win = focusedWindow();
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
}

function initDbMaintenanceIpc() {
  // ── 立即生成一份在线一致快照（不等每日那一次） ──
  // 用户点了「备份」就该马上有一份，而不是「今天已经备份过了，明天再说」。
  ipcMain.handle('db:backup/create', async () => {
    const db = liveDb.currentDbOrNull();
    if (!db) return { ok: false, code: 'UNAVAILABLE', error: '数据库尚未就绪（请稍后重试）' };
    const destDir = path.join(userDataDir(), 'backups');
    const dest = path.join(destDir, backup.backupFileName());
    let r;
    try {
      r = backup.backupDb(db, dbFilePath(), dest);
    } catch (e) {
      console.warn('[dbMaint] 手动备份异常:', e && e.message);
      return { ok: false, code: 'BACKUP_FAILED', error: String((e && e.message) || e) };
    }
    if (!r.ok) return { ok: false, code: 'BACKUP_FAILED', error: r.error };
    const removed = backup.pruneBackups(destDir);
    return {
      ok: true,
      name: path.basename(r.path),
      bytes: r.bytes,
      // verified=false 表示运行时没有 node:sqlite、无法回读校验——**不是失败**，
      // 但界面要如实显示「未校验」，不能一律报成功。
      verified: r.verified !== false,
      dirFsynced: r.dirFsynced !== false,
      pruned: removed.length,
      dir: destDir,
    };
  });

  // ── 导出到你选的位置（路径只来自系统保存对话框） ──
  ipcMain.handle('db:backup/export', async () => {
    const db = liveDb.currentDbOrNull();
    if (!db) return { ok: false, code: 'UNAVAILABLE', error: '数据库尚未就绪（请稍后重试）' };
    let picked;
    try {
      picked = await showSave({
        title: '导出数据库快照',
        defaultPath: backup.backupFileName(),
        filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
      });
    } catch (e) {
      console.warn('[dbMaint] 导出对话框打开失败:', e && e.message);
      return { ok: false, code: 'DIALOG_FAILED', error: String((e && e.message) || '无法打开保存对话框') };
    }
    if (!picked || picked.canceled || !picked.filePath) {
      return { ok: false, code: 'EXPORT_CANCELLED', error: '已取消导出' };
    }
    let r;
    try {
      r = backup.backupDb(db, dbFilePath(), picked.filePath);
    } catch (e) {
      console.warn('[dbMaint] 导出异常:', e && e.message);
      return { ok: false, code: 'EXPORT_FAILED', error: String((e && e.message) || e) };
    }
    if (!r.ok) return { ok: false, code: 'EXPORT_FAILED', error: r.error };
    return { ok: true, path: picked.filePath, bytes: r.bytes, verified: r.verified !== false };
  });

  // ── 导入第一步：选文件 + 只读体检（不动任何东西） ──
  ipcMain.handle('db:import/pick', async () => {
    let picked;
    try {
      picked = await showOpen({
        title: '选择要导入的数据库快照',
        filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] }],
        properties: ['openFile'],
      });
    } catch (e) {
      console.warn('[dbMaint] 导入对话框打开失败:', e && e.message);
      return { ok: false, code: 'DIALOG_FAILED', error: String((e && e.message) || '无法打开文件对话框') };
    }
    const files = picked && !picked.canceled ? (picked.filePaths || []) : [];
    if (files.length === 0) return { ok: false, code: 'IMPORT_CANCELLED', error: '已取消选择' };
    const src = files[0];
    const tv = targetVersion();
    const info = snapshotImport.inspectSnapshot(src, tv);
    if (!info.ok) {
      // 体检不过就**不产生令牌**：没有令牌就不可能有后续 commit，链路在这里断掉。
      return { ok: false, code: 'INSPECT_REJECTED', error: info.error || '快照未通过体检' };
    }
    pendingPick = {
      token: crypto.randomBytes(16).toString('hex'),
      srcFile: src,
      name: path.basename(src),
      userVersion: info.userVersion,
      needsUpgrade: !!info.needsUpgrade,
      targetVersion: tv,
      at: Date.now(),
    };
    return {
      ok: true,
      token: pendingPick.token,
      name: pendingPick.name,
      userVersion: pendingPick.userVersion,
      needsUpgrade: pendingPick.needsUpgrade,
      targetVersion: tv,
    };
  });

  // ── 导入第二步：凭令牌暂存（真正生效在下次启动） ──
  ipcMain.handle('db:import/commit', async (_, payload = {}) => {
    try {
      guard.assertStrings(payload || {}, { token: { max: 64 } });
    } catch (e) {
      return { ok: false, code: 'BAD_PAYLOAD', error: String((e && e.message) || '令牌非法') };
    }
    const p = pendingPick;
    if (!p) return { ok: false, code: 'NO_PICK', error: '没有待确认的导入，请先选择快照文件' };
    if (Date.now() - p.at > PICK_TTL_MS) {
      pendingPick = null;
      return { ok: false, code: 'PICK_EXPIRED', error: '选择已超时，请重新选择快照文件' };
    }
    if (String(payload.token) !== p.token) {
      // 令牌不匹配时**不消费**已选文件：用户可能只是传错了，重新点一次确认即可（无需重选）。
      return { ok: false, code: 'BAD_TOKEN', error: '导入令牌不匹配，请重新选择快照文件' };
    }
    const r = snapshotImport.stageImport(p.srcFile, userDataDir(), p.targetVersion);
    // 令牌一次性：无论暂存成功与否都失效，避免重复提交同一份快照。
    pendingPick = null;
    if (!r.ok) return { ok: false, code: 'STAGE_FAILED', error: r.error };
    return {
      ok: true,
      needsRestart: true,
      name: p.name,
      userVersion: r.userVersion,
      needsUpgrade: !!r.needsUpgrade,
    };
  });
}

module.exports = { initDbMaintenanceIpc, PICK_TTL_MS, __resetPendingPickForTest: () => { pendingPick = null; } };
