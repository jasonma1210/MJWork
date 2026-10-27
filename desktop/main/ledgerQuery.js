// Token 用量账本的查询内核（2026-10-27，设计文档 §7.3）
//
// 只依赖 `db`（better-sqlite3 / sql.js 兼容 API 面），不碰 Electron、不碰 IPC，
// 便于门禁测试直接喂一个内存库跑真实 SQL。
//
// ── 三条不能妥协的口径 ──
// ① **asOf 是单调 consumption id 的高水位，不是 created_at 上限**。
//    为什么：created_at 允许补记历史（quotaLedger._insert 的 `at` 参数），
//    若用时间当水位，查询后补写的一条「更早时间但更大 id」的记录会**混进后续分页**，
//    导致同一批筛选在翻页过程中变大 —— 明细/汇总/CSV 对账就再也一致不了。
// ② **keyset 分页的末位键必须含 id**。只用 created_at 分页时，同一毫秒的多条记录
//    会被重复或漏掉（文档 §7.3 明令禁止）。排序固定 (created_at, id) 倒序。
// ③ **汇总与明细共用同一个规范化查询构造器与同一个 asOf**。分别构造就会出现
//    「明细合计 ≠ 汇总」—— 那条差异正是本模块存在的理由。
//
// 全部 SQL 参数化；排序字段、维度、来源枚举一律白名单，绝不拼接渲染层传入的字符串。
'use strict';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const FIELD_SEMANTICS_VERSION = '2026-10-27.1';

// 可做筛选维度的列（白名单）。member_id 故意**不在**默认开放维度里：
// 它的真实语义（AI 成员 vs 真人）尚未证实（见 M0 核验报告 §1.4），
// 在 capabilities 里标为 verified=false，UI 不拿它当筛选项。
const FILTER_DIMS = ['projectId', 'taskId', 'runId', 'source'];
const COLUMN_OF = {
  projectId: 'project_id',
  taskId: 'task_id',
  runId: 'run_id',
  source: 'source',
  memberId: 'member_id',
};

const SORT_WHITELIST = new Set(['created_at', 'id', 'tokens']);
const SOURCE_ENUM = new Set(['round', 'settle']);

function safeInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function clampLimit(v) {
  const n = safeInt(v, DEFAULT_LIMIT);
  if (n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}
function normStr(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

/**
 * 规范化过滤器：把渲染层传入的任意形状收敛成一个**稳定、可哈希**的对象。
 * 同义但不同写法（多余空格、字符串数字、乱序键）必须收敛为同一个 filtersHash，
 * 否则用户「改了个筛选又改回来」会被判成不同查询、丢掉 asOf 快照。
 */
function normalizeFilters(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const from = safeInt(raw.from, 0);
  const to = safeInt(raw.to, 0);
  const nf = {
    // 时间闭开区间 [from, to)，与 UI「今天/近 7 天」的直觉一致
    from: from > 0 ? from : null,
    to: to > 0 ? to : null,
    projectId: normStr(raw.projectId),
    taskId: normStr(raw.taskId),
    runId: normStr(raw.runId),
    source: SOURCE_ENUM.has(String(raw.source || '')) ? String(raw.source) : null,
  };
  if (nf.from != null && nf.to != null && nf.from >= nf.to) {
    // 非法区间不静默变成「全量」—— 那会让「筛了个空区间」显示成全部数据
    throw new Error('INVALID_RANGE');
  }
  return nf;
}

/** 稳定哈希：只用于「筛选是否变了」的判等，不承担安全职责 */
function filtersHash(nf) {
  return JSON.stringify([
    nf.from, nf.to, nf.projectId, nf.taskId, nf.runId, nf.source,
  ]);
}

/** 构造参数化 WHERE（不含 asOf/cursor，那两样由调用方叠加） */
function buildWhere(nf) {
  const clauses = [];
  const params = [];
  if (nf.from != null) { clauses.push('created_at >= ?'); params.push(nf.from); }
  if (nf.to != null) { clauses.push('created_at < ?'); params.push(nf.to); }
  for (const dim of FILTER_DIMS) {
    const v = nf[dim];
    if (v) { clauses.push(`${COLUMN_OF[dim]} = ?`); params.push(v); }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function rowToItem(r) {
  return {
    id: safeInt(r.id),
    projectId: r.project_id == null ? null : r.project_id,
    runId: r.run_id == null ? null : r.run_id,
    taskId: r.task_id == null ? null : r.task_id,
    // M0 §1.4：语义未证实 ⇒ 原样透出，由 UI 按中性文案展示，不改名
    memberId: r.member_id == null ? null : r.member_id,
    tokens: safeInt(r.tokens),
    source: r.source == null ? null : r.source,
    createdAt: safeInt(r.created_at),
  };
}

/** 当前 asOf：库内最大 consumption id（单调高水位） */
function currentAsOf(db) {
  const row = db.prepare('SELECT MAX(id) AS m FROM quota_consumptions').get();
  return safeInt(row && row.m, 0);
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function decodeCursor(s) {
  try {
    const o = JSON.parse(Buffer.from(String(s || ''), 'base64url').toString('utf8'));
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch {
    return null; // 坏游标按「无效」处理，不静默退化成首页（那样会重复/遗漏）
  }
}

/**
 * 首页查询：固化 asOf 并返回不透明 cursor。
 * 后续页必须同时满足 cursor.filtersHash 与 `id <= asOf`。
 */
function queryPage(db, { filters, limit, sort = 'created_at', dimensions = [] } = {}) {
  const nf = normalizeFilters(filters);
  const hash = filtersHash(nf);
  const size = clampLimit(limit);
  const sortCol = SORT_WHITELIST.has(String(sort)) ? String(sort) : 'created_at';
  const asOf = currentAsOf(db);

  const w = buildWhere(nf);
  // 高水位：只在本快照内读（补记的历史记录有更大 id ⇒ 不会混进来）
  const whereSql = w.sql ? `${w.sql} AND id <= ?` : 'WHERE id <= ?';
  const baseParams = [...w.params, asOf];

  const items = db.prepare(
    `SELECT * FROM quota_consumptions ${whereSql}
     ORDER BY ${sortCol} DESC, id DESC LIMIT ?`,
  ).all(...baseParams, size).map(rowToItem);

  const summary = summarize(db, nf, asOf, dimensions);
  const last = items.length ? items[items.length - 1] : null;
  // 游标必须自带规范化筛选：后续页不允许靠「再传一次 filters」决定条件，
  // 否则同一 asOf 可以被偷换成另一套筛选（文档 §7.3：不能用同 asOf 偷换筛选）。
  const nextCursor = last
    ? encodeCursor({ h: hash, a: asOf, f: nf, c: last.createdAt, i: last.id })
    : null;

  return {
    items,
    summary,
    nextCursor,
    normalizedFilters: nf,
    asOf,
    fieldAvailability: fieldAvailability(db, nf, asOf),
  };
}

/** 后续页：必须传 cursor；若调用方额外传了 filters，则必须与游标内筛选一致 */
function queryNextPage(db, { cursor, filters, limit, sort = 'created_at' } = {}) {
  const c = decodeCursor(cursor);
  if (!c) throw new Error('INVALID_CURSOR');
  const size = clampLimit(limit);
  const sortCol = SORT_WHITELIST.has(String(sort)) ? String(sort) : 'created_at';
  const asOf = safeInt(c.a, 0);
  if (asOf <= 0) throw new Error('INVALID_CURSOR');

  // 游标携带的筛选是**权威**：渲染层不能靠再传一次 filters 偷换筛选条件
  const nf = c.f || null;
  if (!nf) throw new Error('INVALID_CURSOR');
  if (filters != null && filtersHash(normalizeFilters(filters)) !== c.h) {
    throw new Error('CURSOR_FILTERS_MISMATCH');
  }
  const w = buildWhere(nf);
  const clauses = [];
  const params = [...w.params];
  if (w.sql) clauses.push(w.sql.replace(/^WHERE\s+/, ''));
  clauses.push('id <= ?'); params.push(asOf);
  // keyset：严格小于上一页末位键（(created_at,id) 全序，同毫秒不重不漏）
  clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
  params.push(safeInt(c.c, 0), safeInt(c.c, 0), safeInt(c.i, 0));

  const items = db.prepare(
    `SELECT * FROM quota_consumptions WHERE ${clauses.join(' AND ')}
     ORDER BY ${sortCol} DESC, id DESC LIMIT ?`,
  ).all(...params, size).map(rowToItem);

  const last = items.length ? items[items.length - 1] : null;
  const nextCursor = last ? encodeCursor({ ...c, c: last.createdAt, i: last.id }) : null;
  return { items, nextCursor, asOf, normalizedFilters: nf };
}

/** 汇总：与明细**同一个** nf + asOf ⇒ 合计必然等于翻完所有页的明细之和 */
function summarize(db, nf, asOf, dimensions = []) {
  const w = buildWhere(nf);
  const whereSql = w.sql ? `${w.sql} AND id <= ?` : 'WHERE id <= ?';
  const params = [...w.params, asOf];
  const agg = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(tokens),0) AS tokens
     FROM quota_consumptions ${whereSql}`,
  ).get(...params);
  const out = {
    count: safeInt(agg && agg.n, 0),
    tokens: safeInt(agg && agg.tokens, 0),
    byDimension: {},
  };
  for (const dim of dimensions) {
    // 'day' 是派生维度（按本地日切分），不对应单列 —— 单独处理，
    // 但仍走**同一个** whereSql 与 asOf ⇒ 趋势合计必然等于明细合计。
    if (dim === 'day') {
      const rows = db.prepare(
        `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS k,
                COUNT(*) AS n, COALESCE(SUM(tokens),0) AS tokens
         FROM quota_consumptions ${whereSql}
         GROUP BY k ORDER BY k ASC LIMIT 400`,
      ).all(...params);
      out.byDimension.day = rows.map((r) => ({
        key: r.k, count: safeInt(r.n, 0), tokens: safeInt(r.tokens, 0),
      }));
      continue;
    }
    const col = COLUMN_OF[dim];
    if (!col) continue;
    const rows = db.prepare(
      `SELECT ${col} AS k, COUNT(*) AS n, COALESCE(SUM(tokens),0) AS tokens
       FROM quota_consumptions ${whereSql}
       GROUP BY ${col} ORDER BY tokens DESC LIMIT 50`,
    ).all(...params);
    out.byDimension[dim] = rows.map((r) => ({
      // 未记录的维度值一律显示 null，UI 转成「未记录」；不回填 'default'
      key: r.k == null ? null : r.k,
      count: safeInt(r.n, 0),
      tokens: safeInt(r.tokens, 0),
    }));
  }
  return out;
}

/** 字段可用性：没有真实数据的维度 UI 就不该出现（文档 §7.2） */
function fieldAvailability(db, nf, asOf) {
  const w = buildWhere(nf);
  const whereSql = w.sql ? `${w.sql} AND id <= ?` : 'WHERE id <= ?';
  const params = [...w.params, asOf];
  const row = db.prepare(
    `SELECT COUNT(*) AS n,
            COUNT(run_id) AS run_id,
            COUNT(task_id) AS task_id,
            COUNT(member_id) AS member_id,
            COUNT(source) AS source
     FROM quota_consumptions ${whereSql}`,
  ).get(...params);
  const n = safeInt(row && row.n, 0);
  const has = (k) => n > 0 && safeInt(row[k], 0) > 0;
  return {
    taskId: has('task_id'),
    runId: has('run_id'),
    source: has('source'),
    // M0 §1.4：member_id 语义未证实 ⇒ 永远标 verified=false，UI 不作为筛选项
    memberId: { present: has('member_id'), verified: false },
    semanticsVersion: FIELD_SEMANTICS_VERSION,
  };
}

function capabilities() {
  return {
    filterDimensions: FILTER_DIMS.slice(),
    summaryDimensions: [...FILTER_DIMS, 'day'],
    sortFields: [...SORT_WHITELIST],
    maxPageSize: MAX_LIMIT,
    defaultPageSize: DEFAULT_LIMIT,
    exportable: true,
    editable: false,           // append-only：本里程碑不提供编辑/删除
    hasPricing: false,         // 无价格事实 ⇒ 禁止出现金额
    fieldSemanticsVersion: FIELD_SEMANTICS_VERSION,
  };
}

module.exports = {
  queryPage, queryNextPage, summarize, normalizeFilters, filtersHash,
  currentAsOf, encodeCursor, decodeCursor, capabilities, rowToItem,
  DEFAULT_LIMIT, MAX_LIMIT, FIELD_SEMANTICS_VERSION,
};
