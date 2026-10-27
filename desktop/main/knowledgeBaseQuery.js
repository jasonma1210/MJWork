// 本地知识库查询核（设计文档 §8：M3 本地知识库）
//
// 域边界（与 ledger 一致）：本文件只管数据口径与索引算法，不碰 Electron 副作用
// （文件对话框、落盘、审计在 main/ipc/knowledgeBase.js）。这样查询口径能被纯 SQL 测试直接验。
//
// 检索技术选型（§8.5 实施前验证结论）：
//   · 当前 sql.js 1.15.1 **未编译 FTS5**（`no such module: fts5`），重编 WASM 不可行；
//   · 改用「bigram 倒排索引」（普通 SQLite 表），中文按字符 bigram、英文按词元，
//     满足 §8.8「中文不是只能整串 LIKE 命中」与「等效分词方案」要求，且无需 FTS5。
//   · BM25 风格 tf·idf 排序；分数只用于相关性排序，绝不显示成「可信度百分比」。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB（首里程碑文本类）
const SUPPORTED_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.text']);
const SUPPORTED_MIME = new Set(['text/plain', 'text/markdown', 'application/json', 'text/csv']);

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}
function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// 驱动适配层：sqljsDb 暴露的是 prepare().run/get/all，没有顶层 run/get/all。
// 这里包一层，让查询核用统一语法调用（与 ledgerQuery 同一底座）。
// 注意：shim 的 prepare().run(...params) 期望「逐参」传入，故此处把第二参（参数数组）展开，
// 不能把整个数组当一个参数塞进去（否则 sql.js 只绑第一个 ?）。
function q(db) {
  const bind = (params) => (Array.isArray(params) ? params : (params === undefined ? [] : [params]));
  return {
    run: (sql, params) => db.prepare(sql).run(...bind(params)),
    get: (sql, params) => db.prepare(sql).get(...bind(params)),
    all: (sql, params) => db.prepare(sql).all(...bind(params)),
    exec: (sql) => db.exec(sql),
  };
}

// ── 分词：中文 bigram + 英文/数字 词元（小写） ──
function isCjk(ch) {
  return /[㐀-鿿豈-﫿぀-ヿ가-힯]/.test(ch);
}
function tokenize(text) {
  const tokens = [];
  if (!text) return tokens;
  const lower = String(text).toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) || [];
  for (const w of latin) tokens.push(w);
  const cjk = [];
  for (const ch of lower) if (isCjk(ch)) cjk.push(ch);
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk[i] + cjk[i + 1]);
  return tokens;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function makeSnippet(text, terms, radius = 80) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) pos = 0;
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius * 2);
  let snip = text.slice(start, end);
  if (start > 0) snip = '…' + snip;
  if (end < text.length) snip = snip + '…';
  return escapeHtml(snip);
}
function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── 分块 ──
function chunkText(text, maxChars = 1000, overlap = 200) {
  const chunks = [];
  let i = 0;
  let ordinal = 0;
  const len = text.length;
  while (i < len) {
    const slice = text.slice(i, i + maxChars);
    chunks.push({ ordinal: ordinal++, text: slice });
    if (i + maxChars >= len) break;
    i += (maxChars - overlap);
  }
  return chunks;
}

// ── 索引（倒排） ──
function indexChunk(db, chunkId, text) {
  const counts = new Map();
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) || 0) + 1);
  for (const [term, tf] of counts) {
    q(db).run('INSERT OR IGNORE INTO knowledge_index_terms(term, df) VALUES (?, 0)', [term]);
    q(db).run(
      'INSERT INTO knowledge_index_postings(term, chunk_id, tf) VALUES (?, ?, ?) '
      + 'ON CONFLICT(term, chunk_id) DO UPDATE SET tf = excluded.tf',
      [term, chunkId, tf],
    );
    q(db).run('UPDATE knowledge_index_terms SET df = df + 1 WHERE term = ?', [term]);
  }
}
function deindexChunk(db, chunkId) {
  const toks = q(db).all('SELECT term FROM knowledge_index_postings WHERE chunk_id = ?', [chunkId]);
  for (const t of toks) {
    q(db).run('UPDATE knowledge_index_terms SET df = MAX(0, df - 1) WHERE term = ?', [t.term]);
  }
  q(db).run('DELETE FROM knowledge_index_postings WHERE chunk_id = ?', [chunkId]);
}

// ── 授权版本（§8.3：单调 revision / epoch） ──
function bumpProjectRevision(db, projectId) {
  q(db).run('INSERT OR IGNORE INTO kb_project_authz(project_id, revision) VALUES (?, 0)', [projectId]);
  q(db).run('UPDATE kb_project_authz SET revision = revision + 1 WHERE project_id = ?', [projectId]);
}
function getProjectRevision(db, projectId) {
  return (q(db).get('SELECT revision FROM kb_project_authz WHERE project_id = ?', [projectId]) || {}).revision || 0;
}
function bumpActorEpoch(db, actorId) {
  q(db).run('INSERT OR IGNORE INTO kb_actor_authz(actor_id, epoch) VALUES (?, 0)', [actorId]);
  q(db).run('UPDATE kb_actor_authz SET epoch = epoch + 1 WHERE actor_id = ?', [actorId]);
}
function getActorEpoch(db, actorId) {
  return (q(db).get('SELECT epoch FROM kb_actor_authz WHERE actor_id = ?', [actorId]) || {}).epoch || 0;
}

// ── 导入（§8.4 流程） ──
function importDocument({ db, storageDir, workspaceId = '', projectId = null, filePath, actorId = 'owner' }) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, code: 'INVALID_PATH' };
  if (!fs.existsSync(filePath)) return { ok: false, code: 'FILE_NOT_FOUND' };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { ok: false, code: 'NOT_A_FILE' };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, code: 'FILE_TOO_LARGE', size: stat.size, max: MAX_FILE_BYTES };
  const ext = path.extname(filePath).toLowerCase();
  const mime = SUPPORTED_EXT.has(ext) ? (SUPPORTED_MIME.has('text/markdown') && /md|markdown/.test(ext) ? 'text/markdown' : 'text/plain') : 'text/plain';
  if (!SUPPORTED_EXT.has(ext)) return { ok: false, code: 'UNSUPPORTED_TYPE', ext, mime };
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, code: 'READ_FAILED', error: e.message };
  }
  if (!content.trim()) return { ok: false, code: 'EMPTY_CONTENT' };

  const hash = sha1(content);
  fs.mkdirSync(storageDir, { recursive: true });
  const storedName = `${hash}${ext}`;
  const storedPath = path.join(storageDir, storedName);
  // 复制进应用托管存储；**绝不删除/改动用户原始文件**（§8.4：删除也只清索引，不动原文件）
  if (!fs.existsSync(storedPath)) fs.copyFileSync(filePath, storedPath);

  const now = Date.now();
  const sourceId = randomId('kb');
  const title = path.basename(filePath, ext);
  q(db).run(
    `INSERT INTO knowledge_sources(id, workspace_id, title, original_name, content_hash, current_source_version,
       mime_type, parser_version, status, error_code, size_bytes, stored_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'v1', 'ready', NULL, ?, ?, ?, ?)`,
    [sourceId, workspaceId, title, path.basename(filePath), hash, mime, stat.size, storedPath, now, now],
  );
  if (projectId) {
    q(db).run(
      'INSERT OR IGNORE INTO knowledge_source_projects(source_id, project_id, authorized_by, created_at) VALUES (?, ?, ?, ?)',
      [sourceId, projectId, actorId, now],
    );
    bumpProjectRevision(db, projectId);
  }

  const chunks = chunkText(content);
  for (const c of chunks) {
    const chunkId = randomId('kc');
    q(db).run(
      `INSERT INTO knowledge_chunks(id, source_id, source_version, ordinal, text, token_count, locator_json, content_hash)
       VALUES (?, ?, 1, ?, ?, ?, '{}', ?)`,
      [chunkId, sourceId, c.ordinal, c.text, c.text.length, hash],
    );
    indexChunk(db, chunkId, c.text);
  }
  return { ok: true, sourceId, title, chunks: chunks.length, contentHash: hash, status: 'ready' };
}

// ── 搜索（§8.5/§8.8） ──
// `actorId` 目前不参与过滤：首里程碑是本地单 owner，权限粒度只到项目。
// 保留在签名里并显式标注，是因为 M4 LAN 的角色/成员状态要按 actor 收窄可见范围，
// 那时必须复用这条查询而不是另写一条（另写一条必然两套排序口径）。
function search({ db, projectId, query, limit = 20, scope = 'project', actorId: _actorId = 'owner' }) {
  const terms = tokenize(query);
  if (terms.length === 0) return { ok: true, items: [], reason: 'EMPTY_QUERY' };
  const N = (q(db).get('SELECT COUNT(*) AS n FROM knowledge_chunks') || { n: 0 }).n || 1;

  let authSql; let authParams;
  if (scope === 'project' && projectId) {
    authSql = `SELECT ks.id FROM knowledge_sources ks
               JOIN knowledge_source_projects sp ON sp.source_id = ks.id
               WHERE sp.project_id = ? AND ks.status = 'ready'`;
    authParams = [projectId];
  } else if (scope === 'unassigned') {
    authSql = `SELECT ks.id FROM knowledge_sources ks
               WHERE ks.status = 'ready'
                 AND NOT EXISTS (SELECT 1 FROM knowledge_source_projects sp WHERE sp.source_id = ks.id)`;
    authParams = [];
  } else {
    authSql = `SELECT ks.id FROM knowledge_sources ks WHERE ks.status = 'ready'`;
    authParams = [];
  }
  const authSources = (q(db).all(authSql, authParams) || []).map((r) => r.id);
  if (authSources.length === 0) return { ok: true, items: [], reason: 'NO_AUTHORIZED_SOURCES' };
  const ph = authSources.map(() => '?').join(',');

  const scores = new Map(); // chunkId -> {score, sourceId}
  for (const term of terms) {
    const df = (q(db).get('SELECT df FROM knowledge_index_terms WHERE term = ?', [term]) || {}).df || 1;
    const idf = Math.log((N + 1) / (df + 1)) + 1;
    const post = q(db).all(
      `SELECT p.chunk_id AS chunk_id, p.tf AS tf, c.source_id AS source_id
       FROM knowledge_index_postings p JOIN knowledge_chunks c ON c.id = p.chunk_id
       WHERE p.term = ? AND c.source_id IN (${ph})`,
      [term, ...authSources],
    );
    for (const p of post) {
      const cur = scores.get(p.chunk_id) || { score: 0, sourceId: p.source_id };
      cur.score += p.tf * idf;
      cur.sourceId = p.source_id;
      scores.set(p.chunk_id, cur);
    }
  }
  if (scores.size === 0) return { ok: true, items: [], reason: 'NO_HIT' }; // 真实空态，不生成引用

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  const items = ranked.map(([chunkId, info]) => {
    const chunk = q(db).get('SELECT text, source_id, source_version FROM knowledge_chunks WHERE id = ?', [chunkId]);
    const src = q(db).get('SELECT title, original_name FROM knowledge_sources WHERE id = ?', [chunk.source_id]);
    return {
      chunkId,
      sourceId: chunk.source_id,
      sourceTitle: src ? (src.title || src.original_name) : '',
      sourceVersion: chunk.source_version,
      snippet: makeSnippet(chunk.text, terms),
      score: Number(info.score.toFixed(4)),
    };
  });
  return { ok: true, items };
}

// ── 授权 / 撤权（§8.3：授权即 bump revision） ──
function authorize({ db, sourceId, projectId, actorId = 'owner' }) {
  const now = Date.now();
  q(db).run(
    'INSERT OR IGNORE INTO knowledge_source_projects(source_id, project_id, authorized_by, created_at) VALUES (?, ?, ?, ?)',
    [sourceId, projectId, actorId, now],
  );
  bumpProjectRevision(db, projectId);
  return { ok: true };
}
function deauthorize({ db, sourceId, projectId }) {
  q(db).run('DELETE FROM knowledge_source_projects WHERE source_id = ? AND project_id = ?', [sourceId, projectId]);
  bumpProjectRevision(db, projectId);
  return { ok: true };
}

// ── contextPlan（§8.6：不可变快照） ──
function buildContextPlan({ db, projectId, actorId = 'owner', sourceIds = [], chunkIds = [], query = null, exclusions = [], budgetTokens = 4000 }) {
  let chunks = [];
  if (chunkIds.length) {
    chunks = q(db).all(
      `SELECT id, source_id, source_version, content_hash FROM knowledge_chunks WHERE id IN (${chunkIds.map(() => '?').join(',')})`,
      chunkIds,
    );
  } else if (sourceIds.length) {
    chunks = q(db).all(
      `SELECT id, source_id, source_version, content_hash FROM knowledge_chunks
       WHERE source_id IN (${sourceIds.map(() => '?').join(',')})
         AND source_version = (SELECT current_source_version FROM knowledge_sources WHERE id = knowledge_chunks.source_id)`,
      sourceIds,
    );
  } else if (query) {
    const s = search({ db, projectId, actorId, query, limit: 50 });
    chunks = s.items.map((it) => ({
      id: it.chunkId, source_id: it.sourceId, source_version: it.sourceVersion,
    }));
  }
  chunks = chunks.filter((c) => !exclusions.includes(c.id));

  // 越权防护：只允许注入「当前项目已授权」的 source 的 chunk
  const authSet = new Set(
    (q(db).all('SELECT source_id FROM knowledge_source_projects WHERE project_id = ?', [projectId]) || []).map((r) => r.source_id),
  );
  const rejected = chunks.filter((c) => !authSet.has(c.source_id)).map((c) => c.id);
  if (rejected.length) return { ok: false, code: 'FORBIDDEN', rejectedChunkIds: rejected };

  const rev = getProjectRevision(db, projectId);
  const epoch = getActorEpoch(db, actorId);
  const chunkMap = {};
  const srcVerMap = {};
  for (const c of chunks) {
    chunkMap[c.id] = { sourceId: c.source_id, sourceVersion: c.source_version, hash: c.content_hash };
    srcVerMap[c.source_id] = c.source_version;
  }
  const plan = {
    projectId, actorId, projectAuthzRevision: rev, actorAuthzEpoch: epoch,
    sourceVersionMap: srcVerMap, chunkMap, exclusions, budgetTokens,
  };
  const planHash = sha1(JSON.stringify(plan));
  const planId = `cp_${planHash.slice(0, 16)}`;
  const now = Date.now();
  q(db).run(
    `INSERT OR REPLACE INTO context_plans(plan_id, plan_hash, project_id, actor_id,
       project_authz_revision, actor_authz_epoch, source_version_map, chunk_map, exclusions, budget_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      planId, planHash, projectId, actorId, rev, epoch,
      JSON.stringify(srcVerMap), JSON.stringify(chunkMap), JSON.stringify(exclusions), budgetTokens, now,
    ],
  );
  return {
    ok: true, planId, planHash, projectAuthzRevision: rev, actorAuthzEpoch: epoch, chunkCount: chunks.length,
  };
}

// agent:run 同一事务内重验（§8.6.4）：任一项变化 → CONTEXT_PLAN_STALE / FORBIDDEN
function validateContextPlanForRun({ db, planId, planHash, actorId }) {
  const plan = q(db).get('SELECT * FROM context_plans WHERE plan_id = ?', [planId]);
  if (!plan) return { ok: false, code: 'PLAN_NOT_FOUND' };
  if (plan.plan_hash !== planHash) return { ok: false, code: 'PLAN_HASH_MISMATCH' };
  if (plan.actor_id !== actorId) return { ok: false, code: 'FORBIDDEN', reason: 'actor_mismatch' };

  const curRev = getProjectRevision(db, plan.project_id);
  if (curRev !== plan.project_authz_revision) {
    return { ok: false, code: 'CONTEXT_PLAN_STALE', reason: 'project_authz_revision', expected: plan.project_authz_revision, actual: curRev };
  }
  const curEpoch = getActorEpoch(db, plan.actor_id);
  if (curEpoch !== plan.actor_authz_epoch) {
    return { ok: false, code: 'CONTEXT_PLAN_STALE', reason: 'actor_authz_epoch', expected: plan.actor_authz_epoch, actual: curEpoch };
  }
  const chunkMap = safeParse(plan.chunk_map, {});
  for (const [chunkId, info] of Object.entries(chunkMap)) {
    const c = q(db).get('SELECT source_version, content_hash FROM knowledge_chunks WHERE id = ?', [chunkId]);
    if (!c) return { ok: false, code: 'CONTEXT_PLAN_STALE', reason: 'chunk_missing', chunkId };
    if (c.source_version !== info.sourceVersion || c.content_hash !== info.hash) {
      return { ok: false, code: 'CONTEXT_PLAN_STALE', reason: 'chunk_changed', chunkId };
    }
  }
  return { ok: true, planId, projectId: plan.project_id, snapshot: chunkMap };
}

// ── 删除（§8.4：幂等；移除索引/chunks/授权；不动用户原文件） ──
function deleteSource({ db, sourceId }) {
  const src = q(db).get('SELECT id FROM knowledge_sources WHERE id = ?', [sourceId]);
  if (!src) return { ok: true, deleted: false, reason: 'NOT_FOUND' };
  const chunks = q(db).all('SELECT id FROM knowledge_chunks WHERE source_id = ?', [sourceId]);
  for (const c of chunks) deindexChunk(db, c.id);
  q(db).run('DELETE FROM knowledge_chunks WHERE source_id = ?', [sourceId]);
  q(db).run('DELETE FROM knowledge_source_projects WHERE source_id = ?', [sourceId]);
  q(db).run('DELETE FROM knowledge_sources WHERE id = ?', [sourceId]);
  // 注意：保留引用该 source 的 context_plans 行（不暗中改写历史）。旧 plan 在
  // validateContextPlanForRun 时会被判定为 CONTEXT_PLAN_STALE（chunk 已缺失），
  // 符合 §8.4「删除不暗中改写历史」与 §8.6.4「被删除片段不会在执行时复活」。
  return { ok: true, deleted: true };
}

function listSources({ db, scope = 'project', projectId = null, status = 'ready', limit = 50, offset = 0 }) {
  let where = 'status = ?';
  let params = [status];
  if (scope === 'project' && projectId) {
    where = 'status = ? AND id IN (SELECT source_id FROM knowledge_source_projects WHERE project_id = ?)';
    params = [status, projectId];
  } else if (scope === 'unassigned') {
    where = 'status = ? AND id NOT IN (SELECT source_id FROM knowledge_source_projects)';
    params = [status];
  }
  const rows = q(db).all(
    `SELECT id, title, original_name, content_hash, current_source_version, mime_type, size_bytes, created_at
     FROM knowledge_sources WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { ok: true, items: rows };
}

function capabilities() {
  return {
    supportedExtensions: [...SUPPORTED_EXT],
    supportedMimeTypes: [...SUPPORTED_MIME],
    maxFileBytes: MAX_FILE_BYTES,
    hasFts5: false,
    indexKind: 'bigram-inverted',
    version: 'v1',
  };
}

const KB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS knowledge_sources (
    id                    TEXT PRIMARY KEY,
    workspace_id          TEXT NOT NULL DEFAULT '',
    title                 TEXT NOT NULL DEFAULT '',
    original_name         TEXT NOT NULL DEFAULT '',
    content_hash          TEXT NOT NULL,
    current_source_version INTEGER NOT NULL DEFAULT 0,
    mime_type             TEXT NOT NULL DEFAULT 'text/plain',
    parser_version        TEXT NOT NULL DEFAULT 'v1',
    status                TEXT NOT NULL DEFAULT 'ready',
    error_code            TEXT,
    size_bytes            INTEGER NOT NULL DEFAULT 0,
    stored_path           TEXT NOT NULL DEFAULT '',
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kb_sources_ws ON knowledge_sources(workspace_id, status);

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id            TEXT PRIMARY KEY,
    source_id     TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    ordinal       INTEGER NOT NULL DEFAULT 0,
    text          TEXT NOT NULL,
    token_count   INTEGER NOT NULL DEFAULT 0,
    locator_json  TEXT NOT NULL DEFAULT '{}',
    content_hash  TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON knowledge_chunks(source_id, source_version);

  CREATE TABLE IF NOT EXISTS knowledge_source_projects (
    source_id    TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    authorized_by TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (source_id, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kb_sp_project ON knowledge_source_projects(project_id);

  CREATE TABLE IF NOT EXISTS knowledge_index_terms (
    term TEXT PRIMARY KEY,
    df   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS knowledge_index_postings (
    term     TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    tf       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (term, chunk_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kb_postings_chunk ON knowledge_index_postings(chunk_id);

  CREATE TABLE IF NOT EXISTS kb_project_authz (
    project_id TEXT PRIMARY KEY,
    revision   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS kb_actor_authz (
    actor_id TEXT PRIMARY KEY,
    epoch    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS context_plans (
    plan_id                TEXT PRIMARY KEY,
    plan_hash              TEXT NOT NULL,
    project_id            TEXT NOT NULL,
    actor_id              TEXT NOT NULL,
    project_authz_revision INTEGER NOT NULL DEFAULT 0,
    actor_authz_epoch      INTEGER NOT NULL DEFAULT 0,
    source_version_map     TEXT NOT NULL DEFAULT '{}',
    chunk_map              TEXT NOT NULL DEFAULT '{}',
    exclusions             TEXT NOT NULL DEFAULT '[]',
    budget_tokens          INTEGER NOT NULL DEFAULT 0,
    created_at             INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_plans_project ON context_plans(project_id);
`;

module.exports = {
  KB_SCHEMA,
  tokenize,
  importDocument,
  search,
  authorize,
  deauthorize,
  buildContextPlan,
  validateContextPlanForRun,
  deleteSource,
  listSources,
  capabilities,
  // 暴露版本控制原语，便于 IPC / 测试直接驱动
  bumpProjectRevision,
  getProjectRevision,
  bumpActorEpoch,
  getActorEpoch,
};
