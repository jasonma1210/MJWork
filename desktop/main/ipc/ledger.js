// Token 用量账本 IPC（2026-10-27，设计文档 §7）
//
// 域边界：`main/ledgerQuery.js` 只管查询口径，`main/ipc/ledger.js` 只管通道与副作用
// （保存对话框、落盘、审计）。分开的原因：查询口径必须能被纯 SQL 测试直接验，
// 而对话框/落盘属于 Electron 副作用，混在一起就只能起真机才能测。
//
// 安全约束（§7.3 / §7.4）：
//   · 渲染进程**不传入文件路径**——目标路径一律由主进程的系统保存对话框给出；
//   · 渲染进程不直接打开数据库，也不接受任意 SQL；
//   · 导出写审计，但**不记录**筛选内容与流水正文（只记条数与时间范围）。
'use strict';

const fs = require('fs');
const { ipcMain, dialog } = require('electron');
const ledgerQuery = require('../ledgerQuery');

let deps = null;

function getDb() {
  // 账本与配额共用同一个 SQLite 连接（单一事实源），由宿主注入
  return deps?.getDb?.() || null;
}

/** 导出写盘：抽成函数是为了让测试不经过对话框也能验「真的写对了文件内容」 */
async function writeLedgerCsv(db, filters, filePath) {
  const { buildLedgerCsv, ledgerRowToCsv } = await import('../../shared/ledgerCsv.mjs');
  const nf = ledgerQuery.normalizeFilters(filters);
  const CHUNK = 500;
  const parts = [buildLedgerCsv([])]; // 表头（空数组 ⇒ 只出表头）
  let cursor = null;
  let written = 0;
  // 分批游标推进：一次 SELECT * 会把十万行全装进内存（§14.3 性能预算）。
  // 且全程沿用**同一个 asOf**（首页固化），故导出不会混入查询后补记的记录。
  for (;;) {
    const page = cursor
      ? ledgerQuery.queryNextPage(db, { cursor, limit: CHUNK })
      : ledgerQuery.queryPage(db, { filters: nf, limit: CHUNK });
    for (const it of page.items) parts.push(`${ledgerRowToCsv(it)}\n`);
    written += page.items.length;
    cursor = page.nextCursor;
    if (!cursor || page.items.length === 0) break;
  }
  fs.writeFileSync(filePath, parts.join(''), 'utf8');
  return { filePath, rows: written, asOf: ledgerQuery.currentAsOf(db) };
}

function register() {
  ipcMain.handle('ledger:capabilities', async () => ({ ok: true, capabilities: ledgerQuery.capabilities() }));

  ipcMain.handle('ledger:query', async (_, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE', error: '账本子系统不可用（初始化失败）' };
    try {
      const cursor = payload.cursor ? String(payload.cursor) : null;
      const res = cursor
        ? ledgerQuery.queryNextPage(db, {
          cursor, limit: payload.limit, sort: payload.sort, filters: payload.filters,
        })
        : ledgerQuery.queryPage(db, {
          filters: payload.filters, limit: payload.limit,
          sort: payload.sort, dimensions: payload.summaryDimensions,
        });
      if (cursor) {
        // 后续页不需要重发 capabilities/summary/fieldAvailability
        // —— 前端沿用首页的，避免翻页时维度选择器被重置
        return { ok: true, ...res, summary: null, fieldAvailability: null };
      }
      return { ok: true, ...res };
    } catch (err) {
      const code = String(err?.message || '');
      return {
        ok: false,
        code: ['INVALID_RANGE', 'INVALID_CURSOR', 'CURSOR_FILTERS_MISMATCH'].includes(code) ? code : 'QUERY_FAILED',
        error: code === 'INVALID_RANGE' ? '时间范围无效'
          : code === 'INVALID_CURSOR' ? '分页游标无效，请重新查询'
            : code === 'CURSOR_FILTERS_MISMATCH' ? '筛选已变化，不能继续翻页' : '账本查询失败',
      };
    }
  });

  ipcMain.handle('ledger:export', async (_, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE', error: '账本子系统不可用（初始化失败）' };
    try {
      // 路径**只能**来自系统保存对话框：渲染层传来的路径一律忽略（§7.3）
      const win = deps?.getWindow?.() || null;
      const picked = await dialog.showSaveDialog(win, {
        title: '导出 Token 用量流水',
        defaultPath: 'token-usage.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (picked.canceled || !picked.filePath) {
        return { ok: false, code: 'EXPORT_CANCELLED', error: '已取消导出' };
      }
      const res = await writeLedgerCsv(db, payload.filters, picked.filePath);
      // 审计只记「导出了多少条、什么时间范围」，不记筛选内容与正文（§7.4）
      deps?.audit?.('ledger_export', 'ledger', `rows=${res.rows} asOf=${res.asOf}`);
      return { ok: true, filePath: res.filePath, rows: res.rows };
    } catch (err) {
      return { ok: false, code: 'EXPORT_FAILED', error: String(err?.message || '导出失败') };
    }
  });
}

function initLedgerIpc(d) {
  deps = d;
  register();
}

// deps: { getDb, audit, getWindow }
module.exports = { initLedgerIpc, writeLedgerCsv };
