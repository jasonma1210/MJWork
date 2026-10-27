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

// 2MB（文本类与 PDF/DOCX 同限）。**这不是拍脑袋的保守值，是性能验收量出来的**：
// sql.js 是内存库，倒排条数≈正文字符数（中文 bigram，每个字一条 posting）。本机实测
// （darwin / M4 Pro / node 22）：1MB 高熵中文 → 9.6 万 posting / 271MB RSS / 0.6s；
// 2MB → 19.2 万 / 390MB / 1.1s；**3MB 起进程被系统杀掉（exit 137）**，且此时
// 「索引预算」还没触发 —— 说明瓶颈在内存库本身，不在索引条数。
// 因此把文件上限压到实测可用的 2MB，并在超限时明确报 FILE_TOO_LARGE（提示拆分），
// 而不是让主进程 OOM（用户只会看到应用闪退、且不知道为什么）。
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// 索引预算（2026-10-27 性能验收的结论，不是拍脑袋）：
// sql.js 是**内存库**，倒排条数 ≈ 正文字符数（中文按 bigram，每个字产生 1 条 posting）。
// 实测（本机 darwin/M4，node 22）：1MB 高熵中文 → 9.6 万 posting / 271MB RSS / 0.6s；
// 2MB → 19.2 万 / 390MB / 1.2s；**5MB 直接被系统杀掉（exit 137）**。
// 所以「文件 5MB 上限」不能等同于「一定能索引」：给一条显式的倒排预算，
// 超限返回 INDEX_TOO_LARGE（附建议），而不是让主进程 OOM —— 后者用户只会看到应用闪退。
const MAX_INDEX_POSTINGS = 200000;
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.text']);
const SUPPORTED_EXT = new Set([...TEXT_EXT, '.pdf', '.docx']);
const SUPPORTED_MIME = new Set([
  'text/plain', 'text/markdown', 'application/json', 'text/csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const EXT_MIME = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * 按扩展名解析出可索引正文。
 * 失败一律返回**明确错误码**（ENCRYPTED / EMPTY_CONTENT / UNSUPPORTED_ENCODING / PARSE_FAILED），
 * 绝不返回「空字符串 + ok」——那会把「解析不了」伪装成「已索引但没内容」（§8.2 明令禁止）。
 */
function parseContent(ext, buf) {
  if (TEXT_EXT.has(ext)) {
    // 文本类：带 BOM 的按 UTF-8 去 BOM；不做智能编码猜测（猜错比报错更坏）
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, text };
  }
  if (ext === '.docx') return require('./kbDocx').parseDocx(buf);
  if (ext === '.pdf') return require('./kbPdf').parsePdf(buf);
  return { ok: false, code: 'UNSUPPORTED_TYPE', reason: `不支持的扩展名 ${ext}` };
}

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
// 2026-10-27（性能验收驱动）：改为**批处理**。此前每处理一个词元就发三条语句
// （保 term 行 / 写 posting / df+1），一份 500KB 高熵中文文档会产生 ~64 万条 posting ⇒
// 近 200 万次语句执行，实测 25.8s（5MB 直接不可用）。
// 现在每个分块只发 3 条语句（按 200 个词元一组）：INSERT OR IGNORE(多值) / INSERT posting(多值) /
// UPDATE df(IN 列表)。语义完全不变（df 仍按「出现该词的分块数」计），只是把往返次数从 O(词元) 降到 O(组)。
// 分组上限 200：三条语句的参数数分别为 200 / 600 / 200，都低于 SQLite 的 999 变量上限。
const INDEX_BATCH = 200;

function indexChunk(db, chunkId, text) {
  const counts = new Map();
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) || 0) + 1);
  const entries = [...counts.entries()];  for (let i = 0; i < entries.length; i += INDEX_BATCH) {
    const batch = entries.slice(i, i + INDEX_BATCH);
    const terms = batch.map((e) => e[0]);
    q(db).run(
      `INSERT OR IGNORE INTO knowledge_index_terms(term, df) VALUES ${batch.map(() => '(?, 0)').join(',')}`,
      terms,
    );
    const postingParams = [];
    for (const [term, tf] of batch) postingParams.push(term, chunkId, tf);
    q(db).run(
      `INSERT INTO knowledge_index_postings(term, chunk_id, tf) VALUES ${batch.map(() => '(?, ?, ?)').join(',')} `
      + 'ON CONFLICT(term, chunk_id) DO UPDATE SET tf = excluded.tf',
      postingParams,
    );
    q(db).run(
      `UPDATE knowledge_index_terms SET df = df + 1 WHERE term IN (${terms.map(() => '?').join(',')})`,
      terms,
    );
  }
  return entries.length;
}
function deindexChunk(db, chunkId) {
  const terms = q(db).all('SELECT term FROM knowledge_index_postings WHERE chunk_id = ?', [chunkId])
    .map((r) => r.term);
  for (let i = 0; i < terms.length; i += INDEX_BATCH) {
    const group = terms.slice(i, i + INDEX_BATCH);
    q(db).run(
      `UPDATE knowledge_index_terms SET df = MAX(0, df - 1) WHERE term IN (${group.map(() => '?').join(',')})`,
      group,
    );
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
// ── 导入（§8.4 流程：parsing → chunking → indexing → ready）──
// 为什么是 async：§8.4 要求「多文件逐项显示状态、可取消、UI 不假死」。
// 同步实现下 stage 回调只会在函数返回时一起到达（事件循环被占死），那等于**假进度**。
// 这里每处理 yieldEvery 个分块让出一次事件循环，取消检查也落在同样的粒度上。
const YIELD_EVERY = 50;
const tick = () => new Promise((r) => setImmediate(r));

async function importDocument({
  db, storageDir, workspaceId = '', projectId = null, filePath, actorId = 'owner',
  onStage = null, shouldCancel = null, yieldEvery = YIELD_EVERY,
}) {
  const stage = (name) => { try { if (onStage) onStage(name); } catch { /* 进度回调异常不得影响导入 */ } };
  const cancelled = () => { try { return !!(shouldCancel && shouldCancel()); } catch { return false; } };

  if (!filePath || typeof filePath !== 'string') return { ok: false, code: 'INVALID_PATH' };
  if (!fs.existsSync(filePath)) return { ok: false, code: 'FILE_NOT_FOUND' };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { ok: false, code: 'NOT_A_FILE' };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, code: 'FILE_TOO_LARGE', size: stat.size, max: MAX_FILE_BYTES };
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) return { ok: false, code: 'UNSUPPORTED_TYPE', ext };
  const mime = EXT_MIME[ext] || 'text/plain';

  stage('parsing');
  let parsed;
  try {
    parsed = parseContent(ext, fs.readFileSync(filePath));
  } catch (e) {
    return { ok: false, code: 'READ_FAILED', error: e.message };
  }
  if (!parsed.ok) return { ok: false, code: parsed.code || 'PARSE_FAILED', reason: parsed.reason };
  const content = String(parsed.text || '');
  if (!content.trim()) return { ok: false, code: 'EMPTY_CONTENT' };
  if (cancelled()) return { ok: false, code: 'CANCELED' };

  const hash = sha1(content);
  fs.mkdirSync(storageDir, { recursive: true });
  const storedPath = path.join(storageDir, `${hash}${ext}`);
  // 复制进应用托管存储；**绝不删除/改动用户原始文件**（§8.4：删除也只清索引，不动原文件）
  const copiedNow = !fs.existsSync(storedPath);
  if (copiedNow) fs.copyFileSync(filePath, storedPath);

  const now = Date.now();
  const sourceId = randomId('kb');
  const title = path.basename(filePath, ext);
  q(db).run(
    `INSERT INTO knowledge_sources(id, workspace_id, title, original_name, content_hash, current_source_version,
       mime_type, parser_version, status, error_code, size_bytes, stored_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'v1', 'indexing', NULL, ?, ?, ?, ?)`,
    [sourceId, workspaceId, title, path.basename(filePath), hash, mime, stat.size, storedPath, now, now],
  );
  if (projectId) {
    q(db).run(
      'INSERT OR IGNORE INTO knowledge_source_projects(source_id, project_id, authorized_by, created_at) VALUES (?, ?, ?, ?)',
      [sourceId, projectId, actorId, now],
    );
    bumpProjectRevision(db, projectId);
  }

  stage('chunking');
  const chunks = chunkText(content);
  stage('indexing');
  // 批量写入期间挂起落盘调度：sql.js 的 flush 会全量 export 内存库，
  // 导入几千个分块时反复全量拷贝会把内存打爆（实测 2MB 高熵文本 exit 137）。
  // 这里挂起、循环结束后恢复并落盘一次；非 sqljs 驱动没有该 API 时自然跳过。
  const pausePersist = typeof db.suspendPersist === 'function';
  if (pausePersist) db.suspendPersist();
  let postings = 0;
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i];
      const chunkId = randomId('kc');
      q(db).run(
        `INSERT INTO knowledge_chunks(id, source_id, source_version, ordinal, text, token_count, locator_json, content_hash)
         VALUES (?, ?, 1, ?, ?, ?, '{}', ?)`,
        [chunkId, sourceId, c.ordinal, c.text, c.text.length, hash],
      );
      postings += indexChunk(db, chunkId, c.text);
      if (postings > MAX_INDEX_POSTINGS) {
        // 先清理再报错：留下半份索引比没有更糟（检索命中一半，用户以为文件就是这样）
        deleteSource({ db, sourceId });
        if (copiedNow && !q(db).get('SELECT id FROM knowledge_sources WHERE stored_path = ?', [storedPath])) {
          try { fs.unlinkSync(storedPath); } catch { /* 副本删除失败不影响结果判定 */ }
        }
        return {
          ok: false, code: 'INDEX_TOO_LARGE', postings, max: MAX_INDEX_POSTINGS,
          reason: `文档索引规模超出上限（约 ${MAX_INDEX_POSTINGS} 条倒排），请拆分后再导入`,
        };
      }
      if (yieldEvery > 0 && (i + 1) % yieldEvery === 0) {
        await tick();
        if (cancelled()) {
          // 取消 = 撤掉本次未提交的资产（chunks/索引/授权/副本登记），**不动用户原文件**
          deleteSource({ db, sourceId });
          if (copiedNow && !q(db).get('SELECT id FROM knowledge_sources WHERE stored_path = ?', [storedPath])) {
            try { fs.unlinkSync(storedPath); } catch { /* 副本删除失败不影响取消语义 */ }
          }
          return { ok: false, code: 'CANCELED', chunksDone: i };
        }
      }
    }
  } finally {
    if (pausePersist) db.resumePersist();
  }
  q(db).run("UPDATE knowledge_sources SET status = 'ready', updated_at = ? WHERE id = ?", [Date.now(), sourceId]);
  stage('ready');
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

// ── 快照正文解析（§8.6：注入要的是「文本 + 可追溯引用」，不只是校验结论） ──
// 与 validateContextPlanForRun 的分工：那个只回答「还能不能用」，这个回答「用的话具体注入什么」。
// 顺序上**先重验再取正文**——绝不能先读正文再判失效（那等于失效快照也能被注入）。
const INJECT_MAX_CHARS = 6000; // 引擎侧 appendSystemPrompt 总上限 8000，留出通道自带追加的余量

function resolvePlanContext({ db, planId, planHash, actorId = 'owner', maxChars = INJECT_MAX_CHARS }) {
  const v = validateContextPlanForRun({ db, planId, planHash, actorId });
  if (!v.ok) return v; // CONTEXT_PLAN_STALE / FORBIDDEN / PLAN_NOT_FOUND / PLAN_HASH_MISMATCH 原样上抛
  const ids = Object.keys(v.snapshot || {});
  if (ids.length === 0) return { ok: true, chunks: [], citations: [], chars: 0, truncated: false };
  const rows = q(db).all(
    `SELECT c.id, c.source_id, c.ordinal, c.text, c.source_version, s.title, s.original_name
     FROM knowledge_chunks c LEFT JOIN knowledge_sources s ON s.id = c.source_id
     WHERE c.id IN (${ids.map(() => '?').join(',')})
     ORDER BY c.source_id, c.ordinal`,
    ids,
  );
  // 快照里登记过但库里已查不到的 chunk（并发删除）→ 视为失效，不静默少注入
  if (rows.length !== ids.length) {
    return { ok: false, code: 'CONTEXT_PLAN_STALE', reason: 'chunk_missing', expected: ids.length, actual: rows.length };
  }
  const chunks = [];
  const citations = [];
  let used = 0;
  let truncated = false;
  for (const r of rows) {
    const remain = maxChars - used;
    if (remain <= 0) { truncated = true; break; }
    const text = String(r.text || '');
    const slice = text.length > remain ? text.slice(0, remain) : text;
    if (slice.length < text.length) truncated = true;
    chunks.push({ chunkId: r.id, sourceId: r.source_id, text: slice, ordinal: r.ordinal });
    citations.push({
      chunkId: r.id, sourceId: r.source_id, sourceVersion: r.source_version,
      title: r.title || r.original_name || r.source_id, ordinal: r.ordinal,
    });
    used += slice.length;
  }
  return { ok: true, chunks, citations, chars: used, truncated };
}

/** 按 planId 读回快照的引用清单（「查看引用」用；不依赖运行是否还在） */
function listPlanCitations({ db, planId }) {
  const plan = q(db).get('SELECT chunk_map FROM context_plans WHERE plan_id = ?', [planId]);
  if (!plan) return { ok: false, code: 'PLAN_NOT_FOUND' };
  const map = safeParse(plan.chunk_map, {});
  const ids = Object.keys(map);
  if (ids.length === 0) return { ok: true, items: [] };
  const rows = q(db).all(
    `SELECT c.id, c.source_id, c.ordinal, c.source_version, s.title, s.original_name
     FROM knowledge_chunks c LEFT JOIN knowledge_sources s ON s.id = c.source_id
     WHERE c.id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  // 已删除的 chunk 不出现在清单里（但它仍占着快照 → 该快照会被判 STALE，不会假装还有效）
  const items = rows
    .map((r) => ({
      chunkId: r.id, sourceId: r.source_id, sourceVersion: r.source_version,
      title: r.title || r.original_name || r.source_id, ordinal: r.ordinal,
    }))
    .sort((a, b) => (a.sourceId === b.sourceId ? a.ordinal - b.ordinal : String(a.sourceId).localeCompare(String(b.sourceId))));
  return { ok: true, items, missing: ids.length - rows.length };
}

/**
 * 记录「某次运行真正注入了哪个快照的哪些片段」。
 * 为什么单独记表而不是只靠 context_plans：快照是「计划」，运行是「事实」——
 * 事后追「这轮答复依据了哪些片段」只能靠这张表；清理策略也据此避免删掉被引用过的快照。
 */
function recordPlanUse({ db, runId, planId, projectId = null, chunkIds = [] }) {
  if (!runId || !planId) return { ok: false, code: 'INVALID_ARGS' };
  const now = Date.now();
  q(db).run(
    `INSERT OR REPLACE INTO kb_plan_uses(run_id, plan_id, project_id, chunk_ids, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [runId, planId, projectId, JSON.stringify(chunkIds), now],
  );
  return { ok: true };
}

/** 某次运行的注入记录（渲染层「查看引用」也可走 planId 那条，这里保留给审计口径） */
function listRunCitations({ db, runId }) {
  const row = q(db).get('SELECT plan_id, chunk_ids, created_at FROM kb_plan_uses WHERE run_id = ?', [runId]);
  if (!row) return { ok: true, items: [], planId: null };
  return { ok: true, planId: row.plan_id, createdAt: row.created_at, items: safeParse(row.chunk_ids, []) };
}

/**
 * 快照清理（§8.4 的配套）：context_plans 只增不删，需要一条明确的保留策略。
 * 规则（两条同时满足才删）：
 *   · 早于 olderThanMs（默认 30 天）；
 *   · 没有被 kb_plan_uses 引用（引用过的快照承载「历史事实」，删掉等于悄悄改写历史）。
 * 注意与 deleteSource 的区别：删文档时快照**故意保留**（让旧快照被判 STALE）；
 * 这里删的是「又老又没用过」的快照，目的是不让表无限增长。
 */
function pruneContextPlans({ db, olderThanMs = 30 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const cutoff = now - olderThanMs;
  const rows = q(db).all(
    `SELECT plan_id FROM context_plans
     WHERE created_at < ?
       AND plan_id NOT IN (SELECT plan_id FROM kb_plan_uses)`,
    [cutoff],
  );
  for (const r of rows) q(db).run('DELETE FROM context_plans WHERE plan_id = ?', [r.plan_id]);
  return { ok: true, deleted: rows.length, cutoff };
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
    // 「文件多大」与「能不能索引」是两件事：sql.js 是内存库，倒排条数≈正文字符数，
    // 5MB 高熵中文会直接撑爆进程。超限返回 INDEX_TOO_LARGE，界面据此提示拆分。
    maxIndexPostings: MAX_INDEX_POSTINGS,
    hasFts5: false,
    indexKind: 'bigram-inverted',
    // 解析能力的诚实边界（§8.2「具体格式以主进程 capabilities 返回为准」）：
    // PDF 需要 ToUnicode 或纯 ASCII，扫描件/加密件/缺映射的会明确失败而不是产出乱码。
    parsers: {
      text: { ok: true },
      docx: { ok: true, note: 'word/document.xml 正文；不含页眉页脚/批注' },
      pdf: { ok: true, note: '需未加密且有文本层；复合字体需 ToUnicode' },
    },
    importStages: ['parsing', 'chunking', 'indexing', 'ready'],
    cancellable: true,
    version: 'v2',
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

  -- 2026-10-27（v16）：运行期注入事实表。context_plans 是「计划」，这张是「事实」。
  -- 用途：①「这一轮答复依据了哪些片段」可追溯；② 快照清理时保护被引用过的计划。
  CREATE TABLE IF NOT EXISTS kb_plan_uses (
    run_id     TEXT NOT NULL,
    plan_id    TEXT NOT NULL,
    project_id TEXT,
    chunk_ids  TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, plan_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kb_plan_uses_plan ON kb_plan_uses(plan_id);
  CREATE INDEX IF NOT EXISTS idx_kb_plan_uses_time ON kb_plan_uses(created_at);
`;

module.exports = {
  KB_SCHEMA,
  INJECT_MAX_CHARS,
  tokenize,
  importDocument,
  search,
  authorize,
  deauthorize,
  buildContextPlan,
  validateContextPlanForRun,
  // M3 注入（§8.6）：正文解析 / 引用回读 / 使用记录 / 快照清理
  resolvePlanContext,
  listPlanCitations,
  recordPlanUse,
  listRunCitations,
  pruneContextPlans,
  deleteSource,
  listSources,
  capabilities,
  // 暴露版本控制原语，便于 IPC / 测试直接驱动
  bumpProjectRevision,
  getProjectRevision,
  bumpActorEpoch,
  getActorEpoch,
};
