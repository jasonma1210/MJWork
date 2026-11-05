// ST1 第一阶段：把 `userData/local-data.json` 的影子副本写进 SQLite。
//
// 迁移走 ADR 定的五阶段：**shadow write → 双读对照 → cut-over**，JSON 全程保留为回滚快照。
// 本模块只负责前两阶段的机械动作：
//   · mirrorSnapshot —— 把内存态镜像进 SQLite（写路径，JSON 仍是唯一事实源）
//   · readSnapshot   —— 把 SQLite 读回成与 LocalStore.data 同形状，供对照
//   · diffSnapshots  —— 两侧逐字段比对，相等返回 null
//
// ── 三条实现取舍，都写清理由 ────────────────────────────────────────────────
// ① messages 用「id 集合增量」，其余集合全量 reconcile。
//    实测基线（2026-11-05，真实库 43 线程 / 1873 消息 / 3.5MB）：一次全量 reconcile 10~18ms，
//    而现有 JSON 落盘本身已要 ~14ms（stringify 5ms + 写盘 9ms）；每条消息都重写一次
//    等于把 flush 成本翻倍，而 flush 就在流式消息热路径上（150ms 合并窗口）。
//    消息可以只数 id 是因为它们**按 id 不可变**：addMessage 分配新 id（seq 单调递增），
//    replaceMessages（/compact）也是 `nextId()` 重新分配、旧 id 整批消失——
//    不存在「同一 id 内容被改写」的路径（已核 localStore.js:437-497）。
//    线程/凭证/项目/偏好数量级 10^1~10^2，全量重写比求差更简单、更不容易错。
// ② 用 `INSERT OR REPLACE` 而不是 `ON CONFLICT ... DO UPDATE`。
//    UPSERT 语法要 SQLite ≥3.24；本库有 sql.js（WASM）兜底路径，不给自己加一门版本门槛。
//    本表集**没有外键**（见 v19 迁移注释），REPLACE 的「先删后插」副作用在这里无害。
// ③ 比较前要做规范化，否则一批字段会「看着不同、其实相同」：
//    undefined 与 SQLite NULL 都是「没有值」；`archived` 在 JSON 侧缺失=未归档，
//    在 SQLite 侧是 0，必须都收敛成布尔再比（见 canonEntity 的 BOOLEAN_FIELDS）。
const COLLECTIONS = {
  threads: {
    key: 'id',
    fields: ['id', 'title', 'cwd', 'projectPath', 'providerId', 'providerName', 'modelName',
      'status', 'archived', 'parentThreadId', 'forkFromMessageId', 'createdAt', 'updatedAt'],
  },
  messages: {
    key: 'id',
    fields: ['id', 'threadId', 'role', 'content', 'toolCalls', 'toolCallId',
      'tokensInput', 'tokensOutput', 'modelName', 'createdAt'],
  },
  providers: {
    key: 'id',
    fields: ['id', 'name', 'base_url', 'keyEncrypted', 'modelId', 'source', 'fileKey', 'models', 'createdAt'],
  },
  projects: { key: 'path', fields: ['path', 'name', 'createdAt', 'lastOpenedAt'] },
};

// 该字段在两侧的「缺省」必须语义等价，故统一成布尔再比。
const BOOLEAN_FIELDS = { threads: ['archived'] };

// 值的规范化序列化：对象键排序，保证「同样内容不同键序」不被判成差异。
function canonValue(v) {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonValue).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonValue(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(v));
}

function canonEntity(entity, spec, collectionName) {
  const out = {};
  const boolFields = BOOLEAN_FIELDS[collectionName] || [];
  for (const f of spec.fields) {
    out[f] = boolFields.includes(f) ? (entity[f] ? '1' : '0') : canonValue(entity[f]);
  }
  return out;
}

function asArray(v) { return Array.isArray(v) ? v : []; }
function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
const orNull = (v) => (v === undefined ? null : v);

/**
 * 把 LocalStore 的内存态镜像进 SQLite：单事务，任一语句失败整批回滚。
 * 不吞异常——调用方（LocalStore.flush）负责 fail-open 与留痕。
 */
function mirrorSnapshot(db, data) {
  const started = Date.now();
  const src = data || {};
  const threads = asArray(src.threads);
  const messages = asArray(src.messages);
  const providers = asArray(src.providers);
  const projects = asArray(src.projects);
  const preferences = asObject(src.preferences);
  const stats = {
    threads: 0, messagesInserted: 0, messagesDeleted: 0,
    providers: 0, projects: 0, preferences: 0, ms: 0,
  };

  // transaction(fn) 返回包装函数（better-sqlite3 风格），**必须调用它**才执行。
  const run = db.transaction(() => {
    const upThread = db.prepare(`INSERT OR REPLACE INTO threads
      (id, title, cwd, project_path, provider_id, provider_name, model_name, status,
       archived, parent_thread_id, fork_from_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const seenThreads = new Set();
    for (const t of threads) {
      seenThreads.add(t.id);
      upThread.run(t.id, t.title ?? '', t.cwd ?? '', t.projectPath ?? '', orNull(t.providerId),
        t.providerName ?? '', t.modelName ?? '', t.status ?? 'idle', t.archived ? 1 : 0,
        orNull(t.parentThreadId), orNull(t.forkFromMessageId), t.createdAt ?? 0, t.updatedAt ?? 0);
      stats.threads++;
    }
    const delThread = db.prepare('DELETE FROM threads WHERE id = ?');
    for (const row of db.prepare('SELECT id FROM threads').all()) {
      if (!seenThreads.has(row.id)) delThread.run(row.id);
    }

    // messages：只补新增、只删消失（见文件头取舍①）
    const existing = new Set(db.prepare('SELECT id FROM messages').all().map((r) => r.id));
    const insMsg = db.prepare(`INSERT OR REPLACE INTO messages
      (id, thread_id, role, content, tool_calls, tool_call_id, tokens_input, tokens_output, model_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const current = new Set();
    for (const m of messages) {
      current.add(m.id);
      if (existing.has(m.id)) continue;
      const tc = m.toolCalls === undefined || m.toolCalls === null ? null : JSON.stringify(m.toolCalls);
      insMsg.run(m.id, m.threadId, m.role ?? '', m.content ?? '', tc, orNull(m.toolCallId),
        m.tokensInput ?? 0, m.tokensOutput ?? 0, m.modelName ?? '', m.createdAt ?? 0);
      stats.messagesInserted++;
    }
    const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of existing) {
      if (!current.has(id)) { delMsg.run(id); stats.messagesDeleted++; }
    }

    const upProv = db.prepare(`INSERT OR REPLACE INTO providers
      (id, name, base_url, key_encrypted, model_id, source, file_key, models_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const seenProv = new Set();
    for (const p of providers) {
      seenProv.add(p.id);
      upProv.run(p.id, p.name ?? '', p.base_url ?? '', orNull(p.keyEncrypted), orNull(p.modelId),
        orNull(p.source), orNull(p.fileKey), JSON.stringify(asArray(p.models)), p.createdAt ?? 0);
      stats.providers++;
    }
    const delProv = db.prepare('DELETE FROM providers WHERE id = ?');
    for (const row of db.prepare('SELECT id FROM providers').all()) {
      if (!seenProv.has(row.id)) delProv.run(row.id);
    }

    const upProject = db.prepare(`INSERT OR REPLACE INTO projects
      (path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?)`);
    const seenProjects = new Set();
    for (const p of projects) {
      seenProjects.add(p.path);
      upProject.run(p.path, p.name ?? '', p.createdAt ?? 0, orNull(p.lastOpenedAt));
      stats.projects++;
    }
    const delProject = db.prepare('DELETE FROM projects WHERE path = ?');
    for (const row of db.prepare('SELECT path FROM projects').all()) {
      if (!seenProjects.has(row.path)) delProject.run(row.path);
    }

    const upPref = db.prepare('INSERT OR REPLACE INTO preferences (key, value_json) VALUES (?, ?)');
    const seenPrefs = new Set();
    for (const [k, v] of Object.entries(preferences)) {
      seenPrefs.add(k);
      const json = v === undefined ? null : JSON.stringify(v);
      upPref.run(k, json === undefined ? null : json);
      stats.preferences++;
    }
    const delPref = db.prepare('DELETE FROM preferences WHERE key = ?');
    for (const row of db.prepare('SELECT key FROM preferences').all()) {
      if (!seenPrefs.has(row.key)) delPref.run(row.key);
    }
  });

  run();
  stats.ms = Date.now() - started;
  return { ok: true, ...stats };
}

/**
 * 把 SQLite 里的影子副本读回成与 LocalStore.data 同形状（用于双读对照与诊断）。
 * `preferences` 只返回表里有的键——缺键在对照时按「两侧都没有」处理。
 */
function readSnapshot(db) {
  const threads = db.prepare(`SELECT id, title, cwd, project_path, provider_id, provider_name,
      model_name, status, archived, parent_thread_id, fork_from_message_id, created_at, updated_at
    FROM threads ORDER BY id`).all().map((r) => ({
    id: r.id, title: r.title, cwd: r.cwd, projectPath: r.project_path,
    providerId: r.provider_id, providerName: r.provider_name, modelName: r.model_name,
    status: r.status, archived: !!r.archived,
    parentThreadId: r.parent_thread_id, forkFromMessageId: r.fork_from_message_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));

  const messages = db.prepare(`SELECT id, thread_id, role, content, tool_calls, tool_call_id,
      tokens_input, tokens_output, model_name, created_at
    FROM messages ORDER BY id`).all().map((r) => ({
    id: r.id, threadId: r.thread_id, role: r.role, content: r.content,
    toolCalls: r.tool_calls === null ? null : JSON.parse(r.tool_calls),
    toolCallId: r.tool_call_id, tokensInput: r.tokens_input, tokensOutput: r.tokens_output,
    modelName: r.model_name, createdAt: r.created_at,
  }));

  const providers = db.prepare(`SELECT id, name, base_url, key_encrypted, model_id, source,
      file_key, models_json, created_at FROM providers ORDER BY id`).all().map((r) => ({
    id: r.id, name: r.name, base_url: r.base_url, keyEncrypted: r.key_encrypted,
    modelId: r.model_id, source: r.source, fileKey: r.file_key,
    models: JSON.parse(r.models_json || '[]'), createdAt: r.created_at,
  }));

  const projects = db.prepare('SELECT path, name, created_at, last_opened_at FROM projects ORDER BY path')
    .all().map((r) => ({ path: r.path, name: r.name, createdAt: r.created_at, lastOpenedAt: r.last_opened_at }));

  const preferences = {};
  for (const r of db.prepare('SELECT key, value_json FROM preferences ORDER BY key').all()) {
    preferences[r.key] = r.value_json === null ? null : JSON.parse(r.value_json);
  }

  return { threads, messages, providers, projects, preferences };
}

/**
 * 双侧逐字段对照。相等返回 null；有差异返回 { ok:false, problems:[...] }。
 * 每个 collection 的 problems 只带前 5 条样本 + 总数——差异上千条时刷屏没有意义，
 * 但**总数必须报**，否则「只看到 5 条」会让人以为只错了 5 条。
 */
function diffSnapshots(expected, actual) {
  const problems = [];
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    const expList = asArray(expected && expected[name]);
    const actList = asArray(actual && actual[name]);
    const expMap = new Map(expList.map((e) => [String(e[spec.key]), e]));
    const actMap = new Map(actList.map((e) => [String(e[spec.key]), e]));
    const missing = [];
    const extra = [];
    const changed = [];
    for (const [k, e] of expMap) {
      const a = actMap.get(k);
      if (!a) { missing.push(k); continue; }
      const ce = canonEntity(e, spec, name);
      const ca = canonEntity(a, spec, name);
      for (const f of spec.fields) {
        if (ce[f] !== ca[f]) changed.push(`${k}.${f}: 期望 ${ce[f]} / 实得 ${ca[f]}`);
      }
    }
    for (const k of actMap.keys()) if (!expMap.has(k)) extra.push(k);
    if (missing.length || extra.length || changed.length) {
      problems.push({
        collection: name,
        missingCount: missing.length, missing: missing.slice(0, 5),
        extraCount: extra.length, extra: extra.slice(0, 5),
        changedCount: changed.length, changed: changed.slice(0, 5),
      });
    }
  }

  const expPref = asObject(expected && expected.preferences);
  const actPref = asObject(actual && actual.preferences);
  const prefKeys = new Set([...Object.keys(expPref), ...Object.keys(actPref)]);
  const prefChanged = [];
  for (const k of prefKeys) {
    const a = canonValue(expPref[k]);
    const b = canonValue(actPref[k]);
    if (a !== b) prefChanged.push(`${k}: 期望 ${a} / 实得 ${b}`);
  }
  if (prefChanged.length) {
    problems.push({ collection: 'preferences', changedCount: prefChanged.length, changed: prefChanged.slice(0, 5) });
  }

  return problems.length ? { ok: false, problems } : null;
}

module.exports = { mirrorSnapshot, readSnapshot, diffSnapshots, COLLECTIONS, canonValue };
