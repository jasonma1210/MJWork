// 本地优先数据层：JSON 原子持久化（零原生依赖；规模增长后可平滑升级 better-sqlite3）
// 离线模式下线程/消息/私有凭证/偏好/记忆全部本地可用，仅模型调用需要网络
const fs = require('fs');
const path = require('path');
const { writeFileDurable } = require('./data/durableWrite');

// P1-M：本地数据韧性——此前 local-data.json 一损坏就静默重置为空库，
// 用户的全部线程/消息/凭证无声消失（且无任何提示）。三级防线：
//   1) flush 前留 .bak（上一完好版本，第一恢复源）
//   2) 按日副本保留 7 天（防 .bak 被连锁污染/误删）
//   3) load 损坏先 .bak 恢复，失败才重置并 console.error 明示
const SCHEMA_VERSION = 1;
const DAILY_BACKUP_KEEP_DAYS = 7;

const EMPTY = {
  threads: [],      // { id, title, cwd, providerId, providerName, modelName, createdAt, updatedAt }
  messages: [],     // { id, threadId, role, content, toolCalls, toolCallId, tokensInput, tokensOutput, modelName, createdAt }
  providers: [],    // { id, name, base_url, keyEncrypted, createdAt } —— safeStorage 加密
  projects: [],     // { path, name, createdAt, lastOpenedAt }（B1：项目一等实体落本机）
  preferences: {},  // { key: value }
  // P3-4/P1-16：旧 JSON 记忆轨（memories 字段 + addMemory/listMemories/touchMemories）已删除——
  // 记忆唯一事实来源是 SQLite（MemoryManager）。历史文件里的 memories 字段经 migrate 的
  // {...EMPTY, ...rawObj} 原样保留，供主进程一次性导入（main.js importLegacy），
  // 导入成功后即被清空，不再有新写入。
  seq: 1,
  schemaVersion: SCHEMA_VERSION,
};

class LocalStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'local-data.json');
    this.tmp = this.file + '.tmp';
    this.bak = this.file + '.bak';
    this.dataDir = dataDir;
    this.recoveredFromBackup = false; // 诊断：本次加载是否走了 .bak 恢复
    this.pendingBakRepair = false;     // 主文件已知损坏：下次 flush 跳过 .bak 覆盖（防好备份被坏文件污染）
    this.corruptBlocked = false;       // V08：损坏且无备份 → 写入阻断态（load() 置位）
    // P0-1：消息热路径合并刷盘状态。此前每条消息 addMessage 都触发整库 writeFileSync，
    // Agent 工具循环高峰每秒多条消息，同步写会卡死主进程事件循环（连带冻结 IPC 流式转发与审批响应）。
    this._flushTimer = null; // 挂起的合并刷盘定时器
    this._dirty = false;     // 有未落盘的内存变更
    this.data = this.load();
  }

  // P0-1：合并刷盘——延迟 delay 毫秒合并窗口内的多次变更为一次落盘。
  // 仅用于高频低危路径（消息追加 / 线程状态）；关键数据（凭证/供应商/偏好）仍走同步 flush()。
  // 崩溃丢失窗口 = 合并窗口（默认 150ms），换回主进程不再被消息热路径阻塞，代价可接受。
  scheduleFlush(delay = 150) {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this._dirty) {
        this._dirty = false;
        // V08：flush 失败必须恢复脏标记——此前清 dirty 后失败仅记日志，
        // 数据停留在内存且不再有重试机会，用户却可能已看到「已保存」。
        const res = this.flush();
        if (!res || !res.ok) this._dirty = true; // 保留脏状态，下次 scheduleFlush/flushSync 重试
      }
    }, delay);
    // unref：不阻止进程退出（退出路径由 flushSync 兜底）
    if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  // P0-1：强制落盘挂起的合并变更（退出前 / 测试断言前调用）
  // V08：返回真实持久化结果（{ok,error}），调用方据此决定是否宣称「已保存」
  flushSync() {
    if (!this._dirty && !this._flushTimer) return { ok: true, nothingPending: true };
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._dirty = false;
    const res = this.flush();
    if (!res || !res.ok) this._dirty = true;
    return res;
  }

  load() {
    let raw = null;
    let readFailed = false;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      readFailed = true;
      if (e.code === 'ENOENT') return structuredClone(EMPTY); // 首次运行：无文件不是损坏，静默空库
      console.error(`[localStore] local-data.json 读取失败（${e.message}），尝试 .bak 恢复`);
    }
    if (!readFailed) {
      try {
        return this.migrate(JSON.parse(raw));
      } catch (e) {
        console.error(`[localStore] local-data.json 损坏（${e.message}），尝试 .bak 恢复`);
      }
    }
    // 损坏或读取异常：先尝试 .bak 恢复（不静默重置）
    const recovered = this.loadFromBackup();
    if (recovered) {
      this.recoveredFromBackup = true;
      this.pendingBakRepair = true;
      console.error('[localStore] 已从 .bak 恢复本地数据');
      return recovered;
    }
    // V08 corrupt-blocked：损坏且无可用备份 = 该域不可信。保留损坏原件（证据/人工恢复源），
    // 进入阻断态：内存用空库撑起 UI，但**一切写入被拒绝**——
    // 此前「重置空库继续写」，用户在新空状态上的所有输入会在下次 flush 时覆盖损坏原件，
    // 原数据彻底不可恢复，且用户毫无感知。fail-closed：先让用户确认/取回，再谈继续使用。
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(this.file, path.join(this.dataDir, `local-data.corrupt-${stamp}.json`));
      console.error(`[localStore] 损坏原件已保留：local-data.corrupt-${stamp}.json`);
    } catch (e) {
      console.error('[localStore] 损坏原件保留失败（原件未动）:', e.message);
    }
    this.corruptBlocked = true;
    console.error('[localStore] local-data.json 损坏且无可用备份：进入 corrupt-blocked（写入已阻断，等待用户恢复或确认重置）');
    return structuredClone(EMPTY);
  }

  loadFromBackup() {
    try {
      return this.migrate(JSON.parse(fs.readFileSync(this.bak, 'utf8')));
    } catch {
      return null;
    }
  }

  // schemaVersion 迁移链：按版本号依次迁移，避免「无版本旧文件反复重放迁移」
  migrate(raw) {
    const rawObj = raw && typeof raw === 'object' ? raw : {};
    const data = { ...structuredClone(EMPTY), ...rawObj };
    let version = Number(rawObj.schemaVersion) || 0;
    if (version < 1) {
      // v1：旧版 provider 只有 modelId 单字段 → 补生成 models 数组（多模型真值源）
      for (const p of data.providers || []) {
        if (!Array.isArray(p.models)) {
          p.models = p.modelId ? [{ modelId: String(p.modelId), displayName: String(p.modelId) }] : [];
        }
      }
      version = 1;
    }
    data.schemaVersion = version;
    return data;
  }

  // 原子写：写临时文件后 rename，避免崩溃损坏
  // P1-M：rename 前留 .bak（上一完好版本）；主文件已知损坏时跳过本次 .bak 覆盖
  // P0-持久化（2026-10-16）：原实现 writeFileSync(tmp)+renameSync 无 fsync，
  //   数据可能停留在 page cache，连正常退出都不抗掉电。改走 writeFileDurable
  //   （fsync 文件 + fsync 目录）。tmp 由原语自行管理，本文件不再手工拼 tmp 路径。
  // V08：返回 {ok,error} 真实结果；corrupt-blocked 态拒绝写盘（不覆盖损坏原件）。
  flush() {
    if (this.corruptBlocked) {
      return { ok: false, error: 'corrupt-blocked：本地数据文件损坏且无可用备份，写入已阻断（原件已保留，等待恢复或确认重置）' };
    }
    try {
      if (fs.existsSync(this.file) && !this.pendingBakRepair) {
        try { fs.copyFileSync(this.file, this.bak); } catch (e) { console.warn('[localStore] .bak 备份失败:', e.message); }
      }
      const res = writeFileDurable(this.file, JSON.stringify(this.data));
      if (!res.ok) {
        // 失败必须让调用方知道：凭证/消息写不进去若被静默，用户下次重启才发现
        console.error('[localStore] 持久化失败:', res.error);
        return { ok: false, error: res.error };
      }
      this.pendingBakRepair = false;
      this.dailyBackup();
      return { ok: true };
    } catch (e) {
      console.error('[localStore] 持久化异常:', e.message);
      return { ok: false, error: e.message };
    }
  }

  // V08：写入阻断守卫——corrupt-blocked 态下所有变更方法先行拒绝（fail-closed），
  // 严禁「内存接受 + 逻辑成功」假象：调用方必须拿到失败并把 UI 呈现为未保存。
  requireWritable() {
    if (this.corruptBlocked) {
      throw new Error('本地数据层处于 corrupt-blocked 状态（数据文件损坏且无可用备份），已拒绝写入。请从备份恢复或确认重置后再使用。');
    }
  }

  // 按日副本：每天首次 flush 留档；超过 7 天的清理（.bak 被连锁污染时的第二恢复源）
  dailyBackup() {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const daily = path.join(this.dataDir, `local-data.${day}.json`);
      if (!fs.existsSync(daily)) fs.copyFileSync(this.file, daily);
      const cutoff = Date.now() - DAILY_BACKUP_KEEP_DAYS * 86400000;
      for (const name of fs.readdirSync(this.dataDir)) {
        const m = name.match(/^local-data\.(\d{4}-\d{2}-\d{2})\.json$/);
        if (!m) continue;
        const ts = new Date(`${m[1]}T00:00:00Z`).getTime();
        if (ts < cutoff) fs.rmSync(path.join(this.dataDir, name), { force: true });
      }
    } catch (e) {
      console.warn('[localStore] 按日副本失败:', e.message);
    }
  }

  nextId() { return this.data.seq++; }

  // ── 线程 ──
  listThreads(projectPath) {
    return [...this.data.threads]
      .filter((t) => !t.archived)
      .filter((t) => (projectPath ? t.projectPath === projectPath : true))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // projectPath：线程归属的项目目录，构成「项目 → 任务」二级结构（对标 Codex）
  createThread({ title, cwd, projectPath, providerId, providerName, modelName, status }) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const now = Date.now();
    const t = {
      id: this.nextId(), title: title || '新会话', cwd: cwd || '',
      projectPath: projectPath || cwd || '',
      providerId: providerId || null, providerName: providerName || '', modelName: modelName || '',
      status: status || 'idle', // idle | running | awaiting_approval | done
      createdAt: now, updatedAt: now,
    };
    this.data.threads.push(t);
    this.flush();
    return t;
  }

  // P1-6：会话分支（fork）——从某条历史消息点复制出一支新会话，用于「从历史点开分支重跑」。
  // 语义：新会话包含源会话中 id ≤ fromMessageId 的全部消息（含该条，按插入序重编 id）；
  // 会话元数据（cwd/项目/模型）原样继承，parentThreadId/forkFromMessageId 记录来源以便追溯。
  // 为什么复制而非共享消息：会话是可独立编辑/续跑的历史，共享一份消息会让两支互相污染。
  forkThread(threadId, { fromMessageId } = {}) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const src = this.data.threads.find((x) => x.id === Number(threadId));
    if (!src) return { ok: false, error: '源会话不存在' };
    const pivot = Number(fromMessageId);
    if (fromMessageId === undefined || fromMessageId === null || !Number.isFinite(pivot)) {
      return { ok: false, error: '分支点消息 id 非法' };
    }
    const copied = this.data.messages
      .filter((m) => m.threadId === Number(threadId) && m.id <= pivot)
      .sort((a, b) => a.id - b.id);
    if (copied.length === 0) return { ok: false, error: '分支点之前没有可复制的内容' };
    const now = Date.now();
    const t = {
      id: this.nextId(), title: `${src.title || '会话'} · 分支`,
      cwd: src.cwd || '', projectPath: src.projectPath || '',
      providerId: src.providerId ?? null, providerName: src.providerName || '', modelName: src.modelName || '',
      status: 'idle', parentThreadId: src.id, forkFromMessageId: pivot,
      createdAt: now, updatedAt: now,
    };
    this.data.threads.push(t);
    for (const m of copied) {
      this.data.messages.push({
        id: this.nextId(), threadId: t.id, role: m.role, content: m.content || '',
        toolCalls: m.toolCalls || null, toolCallId: m.toolCallId || null,
        tokensInput: m.tokensInput || 0, tokensOutput: m.tokensOutput || 0,
        modelName: m.modelName || '', createdAt: m.createdAt || now,
      });
    }
    t.updatedAt = Date.now();
    this.flush();
    return { ok: true, thread: t, copied: copied.length };
  }

  // 线程状态：运行中 / 待审批 / 已完成（侧栏三色指示的数据来源）
  // P0-1：状态切换与消息同属高频路径，走合并刷盘
  setThreadStatus(threadId, status) {
    const t = this.data.threads.find((x) => x.id === Number(threadId));
    if (!t) return null;
    t.status = status;
    t.updatedAt = Date.now();
    this.scheduleFlush();
    return t;
  }

  addMessage({ threadId, role, content, toolCalls, toolCallId, tokensInput, tokensOutput, modelName }) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const t = this.data.threads.find((x) => x.id === Number(threadId));
    if (!t) throw new Error('线程不存在');
    const m = {
      id: this.nextId(), threadId: Number(threadId), role, content: content || '',
      toolCalls: toolCalls || null, toolCallId: toolCallId || null,
      tokensInput: tokensInput || 0, tokensOutput: tokensOutput || 0,
      modelName: modelName || '', createdAt: Date.now(),
    };
    this.data.messages.push(m);
    t.updatedAt = Date.now();
    if (role === 'user' && (t.title === '新对话' || t.title === '新会话' || !t.title)) {
      t.title = String(content || '').slice(0, 50) || t.title;
    }
    // P0-1：消息追加是最高频写路径，改为合并刷盘（内存态即时可见，磁盘延迟 ≤150ms）
    this.scheduleFlush();
    return m;
  }

  listMessages(threadId) {
    return this.data.messages
      .filter((m) => m.threadId === Number(threadId))
      // 按 id 升序（插入序）。此前写成 `a.createdAt - a.createdAt === 0 ? 0 : a.id - b.id`——
      // 自身相减恒为 0，恒走 0 分支，排序退化为「保持数组顺序」，仅因 push 有序才碰巧正确
      .sort((a, b) => a.id - b.id);
  }

  // /compact 落库（P2-6 收口）：压缩后用摘要历史整体替换该会话消息。
  // 此前压缩只改渲染层 state，重进会话即失效，上下文环重新变满。
  replaceMessages(threadId, list) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const t = this.data.threads.find((x) => x.id === Number(threadId));
    if (!t) return { ok: false, error: '线程不存在' };
    const arr = Array.isArray(list) ? list : [];
    if (arr.length === 0) return { ok: false, error: '压缩结果为空，拒绝清空历史' };
    const now = Date.now();
    const next = arr.map((m, i) => ({
      id: this.nextId(), threadId: Number(threadId),
      role: m.role || 'assistant', content: m.content || '',
      // 压缩是「换一种表示」，不是「重写历史」。以下三项此前被硬置空/改写，各自造成过真实失真：
      //   · toolCalls/toolCallId 置 null ⇒ 重进会话工具链全丢，模型看不到自己刚才做了什么；
      //   · createdAt 改成 now+i ⇒ 全部历史消息的时间戳变成「压缩那一刻」，
      //     工作台「按日消耗」把几年历史一次性算到压缩当天（今天实测：两个会话的账全落到压缩时点）；
      //   · 记账字段只认驼峰 ⇒ 渲染层传来的蛇形（tokens_input/model_name）被静默读成 0，
      //     压缩一次 = 该会话用量清零（工作台模型/会话两表全空的直接原因）。
      toolCalls: m.toolCalls || m.tool_calls || null,
      toolCallId: m.toolCallId || m.tool_call_id || null,
      tokensInput: Number(m.tokensInput ?? m.tokens_input) || 0,
      tokensOutput: Number(m.tokensOutput ?? m.tokens_output) || 0,
      modelName: String(m.modelName ?? m.model_name ?? '').trim(),
      createdAt: Number(m.createdAt ?? m.created_at) || (now + i),
    }));
    this.data.messages = this.data.messages.filter((m) => m.threadId !== Number(threadId)).concat(next);
    t.updatedAt = now;
    this.flush();
    return { ok: true, replaced: next.length, removed: arr.length >= 0 ? undefined : undefined };
  }

  archiveThread(threadId) {
    const t = this.data.threads.find((x) => x.id === Number(threadId));
    if (t) { t.archived = true; this.flush(); }
    return { ok: true };
  }

  // A1：会话重命名（前后端此前均缺；空标题拒绝）
  renameThread(threadId, title) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const t = this.data.threads.find((x) => x.id === Number(threadId));
    const clean = String(title || '').trim();
    if (!t || !clean) return { ok: false, error: '标题不能为空' };
    t.title = clean.slice(0, 100);
    t.updatedAt = Date.now();
    this.flush();
    return { ok: true, thread: t };
  }

  // A3：归档可见 —— 「删除」的本地语义是归档，必须提供恢复/彻底删除出口
  listArchivedThreads() {
    return this.data.threads
      .filter((t) => t.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  restoreThread(threadId) {
    const t = this.data.threads.find((x) => x.id === Number(threadId));
    if (!t) return { ok: false, error: '会话不存在' };
    t.archived = false;
    t.updatedAt = Date.now();
    this.flush();
    return { ok: true };
  }

  purgeThread(threadId) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const id = Number(threadId);
    this.data.threads = this.data.threads.filter((x) => x.id !== id);
    this.data.messages = this.data.messages.filter((m) => m.threadId !== id);
    this.flush();
    return { ok: true };
  }

  // B1：孤儿会话归组到项目
  setThreadProject(threadId, projectPath) {
    const t = this.data.threads.find((x) => x.id === Number(threadId));
    if (!t) return { ok: false, error: '会话不存在' };
    t.projectPath = projectPath || '';
    t.updatedAt = Date.now();
    this.flush();
    return { ok: true };
  }

  // ── 私有凭证（safeStorage 加密在调用方完成）──
  listProviders() {
    // 剥离 keyEncrypted：加密凭证不随列表返回渲染层
    return this.data.providers.map(({ keyEncrypted: _keyEncrypted, ...rest }) => rest);
  }

  addProvider({ name, base_url, keyEncrypted, modelId, source, fileKey }) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const p = {
      id: this.nextId(), name, base_url, keyEncrypted,
      // 多模型真值源（B 方案升级）；modelId 保留为「首模型」兼容字段（老代码/测试契约依赖）
      models: modelId ? [{ modelId: String(modelId), displayName: String(modelId) }] : [],
      modelId: modelId ? String(modelId) : '',
      // 来源标记：'file' = ~/.mjcode/models.json 同步（UI 只读，文件为事实来源）；undefined = UI 手工添加
      ...(source ? { source } : {}),
      ...(fileKey ? { fileKey } : {}),
      createdAt: Date.now(),
    };
    this.data.providers.push(p);
    this.flush();
    return { id: p.id, name: p.name, base_url: p.base_url, modelId: p.modelId, models: p.models };
  }

  // ── 配置文件来源 provider（modelsFile.js 对账专用）──
  findProviderByFileKey(fileKey) {
    return this.data.providers.find((x) => x.fileKey === fileKey) || null;
  }

  // 文件同步：整体覆盖名称/地址/Key/模型列表（文件是事实来源）；modelId 兼容字段随首模型
  updateFileProvider(providerId, { name, base_url, keyEncrypted, models } = {}) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const p = this.data.providers.find((x) => x.id === Number(providerId));
    if (!p) throw new Error('本地模型服务不存在');
    if (typeof name === 'string' && name.trim()) p.name = name.trim();
    if (typeof base_url === 'string' && base_url.trim()) p.base_url = base_url.trim();
    if (typeof keyEncrypted === 'string') p.keyEncrypted = keyEncrypted;
    if (Array.isArray(models)) {
      // P0-3③：caps 必须原样落库——此前只留 {modelId, displayName}，能力声明在同步这一层被抹掉，
      // 渲染层的「思考强度能力门控」就永远拿不到数据（缺就是缺，不补默认值）。
      p.models = models.map((m) => ({
        modelId: String(m.modelId),
        displayName: String(m.displayName || m.modelId),
        ...(m.caps && typeof m.caps === 'object' ? { caps: m.caps } : {}),
      }));
      if (!p.models.some((m) => m.modelId === p.modelId)) p.modelId = p.models[0]?.modelId || '';
    }
    this.flush();
    return p;
  }

  // 文件同步对账：删除 source==='file' 且 fileKey 不在 keep 列表内的 provider（返回被删 id）
  pruneFileProviders(keepFileKeys) {
    const keep = new Set(keepFileKeys || []);
    const removed = this.data.providers
      .filter((x) => x.source === 'file' && x.fileKey && !keep.has(x.fileKey))
      .map((x) => x.id);
    if (removed.length) {
      this.data.providers = this.data.providers.filter((x) => !removed.includes(x.id));
      this.flush();
    }
    return removed;
  }

  setProviderModel(providerId, modelId) {
    const p = this.data.providers.find((x) => x.id === Number(providerId));
    if (!p) throw new Error('本地模型服务不存在');
    const mid = String(modelId || '');
    p.modelId = mid;
    // 同步 models 数组：存在则更新首项，否则置为首项
    if (mid) {
      if (p.models?.length > 0) p.models[0] = { modelId: mid, displayName: mid };
      else p.models = [{ modelId: mid, displayName: mid }];
    } else {
      p.models = [];
    }
    this.flush();
    return { id: p.id, modelId: p.modelId, models: p.models };
  }

  // 多模型：添加条目（首个同步为兼容字段 modelId）
  addProviderModel(providerId, { model_id, display_name, caps } = {}) {
    const p = this.data.providers.find((x) => x.id === Number(providerId));
    const mid = String(model_id || '').trim();
    if (!p) throw new Error('本地模型服务不存在');
    if (!mid) throw new Error('模型 ID 不能为空');
    if (!Array.isArray(p.models)) p.models = [];
    if (p.models.some((m) => m.modelId === mid)) throw new Error('该模型已存在');
    // N1：能力位随条目落库（缺失时不写字段，解析侧按默认值处理）
    const entry = { modelId: mid, displayName: String(display_name || '').trim() || mid };
    if (caps && typeof caps === 'object') entry.caps = { ...caps };
    p.models.push(entry);
    if (!p.modelId) p.modelId = mid; // 首模型兼容字段
    this.flush();
    return { id: p.id, modelId: p.modelId, models: p.models };
  }

  // N1：写回某个模型条目的能力位（图像 / 工具调用 / 推理强度）。caps 只覆盖传入字段。
  updateProviderModelCaps(providerId, modelId, caps = {}) {
    const p = this.data.providers.find((x) => x.id === Number(providerId));
    const mid = String(modelId || '').trim();
    if (!p) throw new Error('本地模型服务不存在');
    if (!Array.isArray(p.models)) p.models = [];
    const m = p.models.find((x) => x.modelId === mid);
    if (!m) throw new Error('模型条目不存在');
    m.caps = { ...(m.caps || {}), ...(caps && typeof caps === 'object' ? caps : {}) };
    this.flush();
    return { id: p.id, modelId: p.modelId, models: p.models };
  }

  // 多模型：删除条目（若删除的是兼容字段所指首模型，顺移到下一个）
  removeProviderModel(providerId, modelId) {
    const p = this.data.providers.find((x) => x.id === Number(providerId));
    const mid = String(modelId || '').trim();
    if (!p) throw new Error('本地模型服务不存在');
    if (!Array.isArray(p.models)) p.models = [];
    const before = p.models.length;
    p.models = p.models.filter((m) => m.modelId !== mid);
    if (p.models.length === before) throw new Error('模型条目不存在');
    if (p.modelId === mid) p.modelId = p.models[0]?.modelId || '';
    this.flush();
    return { id: p.id, modelId: p.modelId, models: p.models };
  }

  getProviderKey(providerId) {
    const p = this.data.providers.find((x) => x.id === Number(providerId));
    return p ? p.keyEncrypted : null; // 调用方负责 safeStorage 解密
  }

  deleteProvider(providerId) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    this.data.providers = this.data.providers.filter((x) => x.id !== Number(providerId));
    this.flush();
    return { ok: true };
  }

  // B2：供应商可编辑（name / base_url / 可选换 Key）——此前 base_url 与 Key 不可更新
  updateProvider(providerId, { name, base_url, keyEncrypted } = {}) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    const p = this.data.providers.find((x) => x.id === Number(providerId));
    if (!p) throw new Error('本地模型服务不存在');
    if (typeof name === 'string' && name.trim()) p.name = name.trim();
    if (typeof base_url === 'string' && base_url.trim()) p.base_url = base_url.trim();
    if (typeof keyEncrypted === 'string' && keyEncrypted) p.keyEncrypted = keyEncrypted;
    this.flush();
    return { id: p.id, name: p.name, base_url: p.base_url, modelId: p.modelId };
  }

  // ── 项目（B1：项目一等实体，落本机持久化）──
  listProjects() {
    return [...this.data.projects].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
  }

  addProject({ path, name }) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    if (!path) return null;
    const now = Date.now();
    let p = this.data.projects.find((x) => x.path === path);
    if (p) {
      p.lastOpenedAt = now;
      if (name) p.name = name;
    } else {
      p = { path, name: name || path, createdAt: now, lastOpenedAt: now };
      this.data.projects.push(p);
    }
    this.flush();
    return p;
  }

  removeProject(projectPath) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    this.data.projects = this.data.projects.filter((x) => x.path !== projectPath);
    this.flush();
    return { ok: true };
  }

  // 重命名 = 只改「显示名」，不动磁盘目录名。
  // 目录名是路径标识（会话按 projectPath 归属、沙箱按目录授权），改名会让历史会话失联；
  // 而用户看到的 `20261013-1271` 这类机器名又完全不可读，所以两者必须解耦。
  renameProject(projectPath, name) {
    const clean = String(name || '').trim().slice(0, 48);
    if (!clean) return { ok: false, error: '名称不能为空' };
    const p = this.data.projects.find((x) => x.path === projectPath);
    if (!p) return { ok: false, error: '项目不存在' };
    p.name = clean;
    this.flush();
    return { ok: true, project: p };
  }

  // ── 偏好 ──
  getPreference(key) { return this.data.preferences[key]; }

  setPreference(key, value) {
    this.requireWritable(); // V08：corrupt-blocked 态拒绝写入（fail-closed）
    this.data.preferences[key] = value;
    this.flush();
    return { ok: true };
  }
}

module.exports = { LocalStore };
