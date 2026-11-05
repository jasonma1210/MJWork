// T2-1：本地数据域 IPC（自主进程 main.js 原样搬移，行为不变）
// 覆盖：models.json 同步（mtime 驱动）/ UI 对 file 来源 provider 的写回 /
//       会话·消息·provider·项目·偏好·记忆的本地 IPC（localStore 薄封装）。
//
// 依赖注入（沿用 initXxx(deps) 模式）：
//   initLocalDataIpc({ getLocalStore, getCredentialCrypto, localVault, serverBase,
//                      MJ_SERVER_DEFAULT, getMemoryManager, getMemoryScheduler, getMemoryFileSync })
//   - localVault 为共享 Map 引用（provider id → 解密内存态），resolveSecret 在 main.js 读取；
//   - localStore/credentialCrypto 在 whenReady 后才初始化，故用 getter。
const { ipcMain, shell, dialog, BrowserWindow } = require('electron');
const fsp = require('fs/promises');
const path = require('path');
const modelsFile = require('../modelsFile');
// MD2（2026-11-05）：credentialUsable 是三处发消息入口与测试连接共用的唯一凭证判据。
// 测试连接必须与实跑同源，否则又回到「测试绿、发消息红」那条老路（AC-2.8）。
const localModel = require('../localModel');
const guard = require('./payloadGuard');
// 三层记忆 M3：作用域常量（分层召回的唯一事实来源，避免宿主重写层级清单）
const { SCOPES } = require('../memory');
// N9：治理命中率观测只读出口（进程内单例，无需注入）
const { governanceStats } = require('../governanceStats');
// 彻底删除的级联清理需要这两个单例（断点在 main.js 启动时已完成 initCheckpointStore，
// worktree 根只用来判断「执行根是否落在隔离副本里」）。
const checkpointStore = require('../store/checkpointStore');
const { worktreeRoot } = require('../worktree');
// 导出留痕：与 ledger:export 同口径（只记「导出了哪个会话、多少条」，不记正文）
const { audit } = require('../audit/auditLog');

let deps = null;

/**
 * 停止某会话名下所有在跑运行（删会话的前置动作）。
 *
 * 为什么不在这里直接 require(agentRunner)：本文件是纯 IPC 层，宿主（main.js）才是运行时的
 * 装配者；注入缺失时降级为 0 —— 「停不下来」不该阻断删除（用户点删除的意图明确），
 * 但必须留痕，否则「为什么删了还在跑」查不到。
 */
function stopThreadRuns(threadId) {
  try {
    return deps && typeof deps.abortRunsForThread === 'function' ? deps.abortRunsForThread(threadId) : 0;
  } catch (e) {
    console.warn('[localData] 会话删除：中止在跑任务失败（删除继续）:', e.message);
    return 0;
  }
}

/**
 * 彻底删除会话的跨库级联（RQ-02）。
 *
 * 为什么不能只删 localStore：会话本体（threads/messages）在 JSON 里，但它派生出的
 * 任务组在 SQLite、断点在另一个 JSON。只删本体留下的是「点开即 404」的幽灵任务组、
 * 永不淘汰的断点条目，以及磁盘上无人认领的隔离副本。
 *
 * 边界（三条都不能省）：
 *   · running 的任务组 fail-closed 不删——删了账目就悬空，用户失去取消入口；单独计数回报。
 *   · 隔离副本只**报告**不删——目录里可能有未提交的改动，丢弃必须由用户确认。
 *   · 每一步的失败都写进返回结构（带形态字段），不压成统一的 false。
 *
 * @param {number|string} threadId 会话 id
 * @param {string} cwd 该会话删除前的执行根
 * @returns {{taskGroups:number, taskGroupsKept:number, checkpoints:number, orphanWorktreeCwd:string,
 *            taskGroupsError?:string, checkpointsError?:string}}
 */
function purgeThreadDerivatives(threadId, cwd) {
  const out = { taskGroups: 0, taskGroupsKept: 0, checkpoints: 0, orphanWorktreeCwd: '' };
  const taskStore = deps.getTaskStore ? deps.getTaskStore() : null;
  if (taskStore) {
    try {
      for (const g of taskStore.listGroupsByThread(threadId, { limit: 200 })) {
        const r = taskStore.deleteGroup(g.group_id);
        if (r && r.ok) out.taskGroups += 1; else out.taskGroupsKept += 1;
      }
    } catch (e) {
      out.taskGroupsError = e.message;
      console.warn('[localData] 会话删除：任务组级联失败（其余清理继续）:', e.message);
    }
  }
  try {
    if (checkpointStore.clearCheckpoint(String(threadId))) out.checkpoints = 1;
  } catch (e) {
    out.checkpointsError = e.message;
    console.warn('[localData] 会话删除：断点清理失败（其余清理继续）:', e.message);
  }
  const root = worktreeRoot();
  if (cwd && root && path.resolve(cwd).startsWith(path.resolve(root) + path.sep)) out.orphanWorktreeCwd = cwd;
  return out;
}

let modelsFileMtime = 0;
let modelsFileLastStatus = { path: modelsFile.modelsFilePath(), exists: false, synced: 0, removed: 0, errors: [] };

// N1：能力位白名单收敛——只接受三个布尔开关，杜绝把任意结构写进 models.json / 本地库。
function pickCaps(c) {
  const o = c && typeof c === 'object' ? c : {};
  const out = {};
  if (typeof o.supportsImages === 'boolean') out.supportsImages = o.supportsImages;
  if (typeof o.supportsReasoning === 'boolean') out.supportsReasoning = o.supportsReasoning;
  if (typeof o.supportsToolCall === 'boolean') out.supportsToolCall = o.supportsToolCall;
  return out;
}

// ── 自定义模型配置文件（~/.mjcode/models.json）同步 ──
// 时机：启动一次 + providers/list 与 status 查询时按 mtime 变化热同步（保存文件即生效，无需重启）。
// 失败/文件不存在只告警不影响启动；解析错误收集后在设置页展示，绝不静默吞。
function syncModelsFile({ reason = 'manual' } = {}) {
  const localStore = deps.getLocalStore();
  const credentialCrypto = deps.getCredentialCrypto();
  const filePath = modelsFile.modelsFilePath();
  const exists = require('fs').existsSync(filePath);
  try {
    if (!exists) {
      modelsFileLastStatus = { path: filePath, exists: false, synced: 0, removed: 0, errors: [] };
      return modelsFileLastStatus;
    }
    modelsFileMtime = require('fs').statSync(filePath).mtimeMs;
    const raw = modelsFile.readModelsFile(filePath);
    const r = modelsFile.syncFileModels({ store: localStore, encrypt: (k) => credentialCrypto.encrypt(k), vault: deps.localVault, raw, filePath });
    modelsFileLastStatus = { path: filePath, exists: true, synced: r.synced, removed: r.removed.length, errors: r.errors };
    if (r.synced || r.removed.length) {
      console.log(`[modelsFile] 同步完成（${reason}）：导入 ${r.synced} 个模型 / 移除 ${r.removed.length} 个 provider${r.errors.length ? `，${r.errors.length} 条解析告警` : ''}`);
    }
    if (r.errors.length) console.warn('[modelsFile] 配置告警:', r.errors.map((e) => e.error).join('；'));
  } catch (e) {
    console.error('[modelsFile] 同步失败:', e.message);
    modelsFileLastStatus = { path: filePath, exists, synced: 0, removed: 0, errors: [{ error: `同步失败：${e.message}` }] };
  }
  return modelsFileLastStatus;
}

// mtime 未变则跳过（cheap：一次 statSync），变了才重新解析对账
function maybeSyncModelsFile() {
  try {
    const filePath = modelsFile.modelsFilePath();
    if (!require('fs').existsSync(filePath)) return modelsFileLastStatus;
    const mtime = require('fs').statSync(filePath).mtimeMs;
    if (mtime !== modelsFileMtime) return syncModelsFile({ reason: 'file-changed' });
  } catch { /* stat 失败按未变化处理 */ }
  return modelsFileLastStatus;
}

// ── 迁移：把 UI 手工配置的模型写入配置文件（用户要求：旧模型统一由 models.json 承载）──
// 触发条件（防覆盖用户手写内容）：文件不存在，或内容仍是初始模板，或文件解析不出任何 provider。
// 迁移后删除已被文件承载的 UI provider（同 url+Key 的模型已并入文件组，避免双份显示）。
function migrateLocalModelsToFile() {
  const localStore = deps.getLocalStore();
  const credentialCrypto = deps.getCredentialCrypto();
  try {
    const filePath = modelsFile.modelsFilePath();
    const raw = modelsFile.readModelsFile(filePath);
    const parsed = raw ? modelsFile.parseModelsFile(raw) : { providers: [] };
    // 模板/占位判定：文件缺失、解析不出 provider，或全部条目都是 example.com 占位
    // （同时兼容 v1 扁平模板与 v2 分组模板——两者文本不同，不能按文本比对）
    const isPlaceholder = parsed.providers.length > 0
      && parsed.providers.every((g) => g.base_url.startsWith('https://api.example.com'));
    const uiProviders = localStore.data.providers.filter((p) => p.source !== 'file');
    const shouldMigrate = (raw == null || parsed.providers.length === 0 || isPlaceholder) && uiProviders.length > 0;
    if (!shouldMigrate) return;

    const { raw: nextRaw, migrated } = modelsFile.migrateLocalProviders({
      raw: isPlaceholder ? '[]' : (raw || ''), // 占位内容直接丢弃，避免示例模型混入真实列表
      providers: uiProviders,
      decrypt: (enc) => credentialCrypto.decrypt(enc),
    });
    modelsFile.writeModelsFile(nextRaw, filePath);
    let removed = 0;
    for (const m of migrated) {
      try {
        localStore.deleteProvider(m.id);
        deps.localVault.delete(Number(m.id));
        removed += 1;
      } catch { /* 已不存在则忽略 */ }
    }
    console.log(`[modelsFile] 迁移完成：${migrated.length} 个本机模型服务已写入 ${filePath}（其中 ${migrated.filter((x) => x.matched).length} 个并入已有组），UI 侧移除 ${removed} 个（改由文件承载）`);
  } catch (e) {
    console.error('[modelsFile] 迁移失败（不影响启动，可稍后在设置页重试）:', e.message);
  }
}

// ── UI 对 file 来源 provider 的写回（删除/添加模型 → 修改 models.json → 热同步）──
function rewriteModelsFileRaw(nextRaw, { reason }) {
  modelsFile.writeModelsFile(nextRaw);
  modelsFileMtime = require('fs').statSync(modelsFile.modelsFilePath()).mtimeMs; // 写回后手动对齐，防 mtime 双触发
  return syncModelsFile({ reason });
}

function register() {
  ipcMain.handle('local:models-file/remove-model', async (_, { fileKey, modelId } = {}) => {
    try {
      // X14：fileKey/modelId 用来在 models.json 里定位条目并整个文件重写——非字符串会写成
      // "[object Object]" 且匹配不到任何条目，用户看到的是「删了但没删掉」
      guard.assertStrings({ fileKey, modelId }, { fileKey: 200, modelId: 300 });
      const raw = modelsFile.readModelsFile();
      const r = modelsFile.removeModelFromRaw(raw, fileKey, modelId);
      if (!r.ok) return r;
      return { ok: true, ...rewriteModelsFileRaw(r.raw, { reason: 'remove-model' }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('local:models-file/remove-provider', async (_, { fileKey } = {}) => {
    try {
      // X14：同 remove-model——fileKey 决定整组服务是否被从 models.json 抹掉
      guard.assertStrings({ fileKey }, { fileKey: 200 });
      const raw = modelsFile.readModelsFile();
      const r = modelsFile.removeProviderFromRaw(raw, fileKey);
      if (!r.ok) return r;
      return { ok: true, ...rewriteModelsFileRaw(r.raw, { reason: 'remove-provider' }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('local:models-file/add-model', async (_, { fileKey, model_id, display_name, caps } = {}) => {
    try {
      // X14：新增模型条目直接写盘；model_id 必填非空（空 id 会生成一条无法调用的模型），
      // display_name 允许缺省或留空（addModelToRaw 内回落成 model_id）
      guard.assertStrings({ fileKey, model_id, display_name }, {
        fileKey: 200, model_id: 300, display_name: { max: 200, optional: true, allowEmpty: true },
      });
      const raw = modelsFile.readModelsFile();
      const r = modelsFile.addModelToRaw(raw, fileKey, model_id, display_name, { caps: pickCaps(caps) });
      if (!r.ok) return r;
      return { ok: true, ...rewriteModelsFileRaw(r.raw, { reason: 'add-model' }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // N1：写回单个模型的能力位（图像理解 / 工具调用 / 推理强度）——UI 三枚开关的落点
  ipcMain.handle('local:models-file/update-model-caps', async (_, { fileKey, modelId, caps } = {}) => {
    try {
      guard.assertStrings({ fileKey, modelId }, { fileKey: 200, modelId: 300 });
      const raw = modelsFile.readModelsFile();
      const r = modelsFile.setModelCapsInRaw(raw, fileKey, modelId, pickCaps(caps));
      if (!r.ok) return r;
      return { ok: true, ...rewriteModelsFileRaw(r.raw, { reason: 'update-model-caps' }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('local:models-file/status', async () => (deps.getLocalStore() ? maybeSyncModelsFile() : modelsFileLastStatus));
  ipcMain.handle('local:models-file/open', async () => {
    try {
      const r = modelsFile.ensureModelsFile();
      const err = await shell.openPath(r.path);
      return { ok: !err, created: r.created, error: err || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('server:health', async () => {
    try {
      const r = await fetch(`${deps.serverBase()}/health`, { signal: AbortSignal.timeout(3000) });
      return { online: r.ok };
    } catch (e) {
      // C-001：探测**失败**与「服务确实不可用」在这里压成了同一个 online:false，
      // 界面据此显示离线。端口配错 / 超时 / 被沙箱拦全长得一样，不记原因等于把「配错了」当「没启动」。
      console.warn('[localData] server health probe failed:', deps.serverBase(), e?.message || e);
      return { online: false };
    }
  });

  ipcMain.handle('local:threads/list', async (_, { projectPath } = {}) => (deps.getLocalStore() ? deps.getLocalStore().listThreads(projectPath) : []));
  ipcMain.handle('local:threads/create', async (_, payload) => {
    // X14：会话标题/目录都可缺省（新建即空会话），但类型与长度必须守住——
    // 路径允许空格，故用 assertStrings 而非 assertTokens
    guard.assertStrings(payload || {}, {
      title: { max: 200, optional: true, allowEmpty: true },
      cwd: { max: 1024, optional: true, allowEmpty: true },
      projectPath: { max: 1024, optional: true, allowEmpty: true },
      providerName: { max: 200, optional: true, allowEmpty: true },
      modelName: { max: 200, optional: true, allowEmpty: true },
    });
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().createThread(payload || {});
  });
  ipcMain.handle('local:threads/set-status', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertEnum(payload, 'status', ['running', 'idle', 'done', 'awaiting_approval']);
    const { id, status } = payload;
    if (!deps.getLocalStore()) return null;
    return deps.getLocalStore().setThreadStatus(id, status);
  });
  ipcMain.handle('local:messages/add', async (_, payload) => {
    // X14：消息是用户数据的核心，role 是闭集、content 允许为空（纯工具调用轮）
    guard.assertIds(payload || {}, ['threadId']);
    guard.assertEnum(payload || {}, 'role', ['user', 'assistant', 'system', 'tool']);
    guard.assertStrings(payload || {}, { content: { max: 2 * 1024 * 1024, optional: true, allowEmpty: true } });
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().addMessage(payload || {});
  });
  // R2-1：分页读。显式给 limit 才返回信封 {messages,hasMore,total}；不给则保持历史返回（数组）——
  // 跨层契约一变就必须两侧同时改，这里用「显式 opt-in」把风险锁在一个参数上。
  ipcMain.handle('local:messages/list', async (_, payload = {}) => {
    const store = deps.getLocalStore();
    if (!store) return [];
    const { threadId, limit, beforeId } = payload || {};
    guard.assertIds(payload, ['threadId']);
    if (limit === undefined) return store.listMessages(threadId);
    return store.listMessagesPage(threadId, { limit, beforeId });
  });
  // R2-6：首页聚合（一次遍历出全部数字）。替代渲染层「逐会话取消息再本地累加」的 N+1 调用。
  ipcMain.handle('local:stats/summary', async () => {
    const store = deps.getLocalStore();
    if (!store) return { threads: 0, archivedThreads: 0, messages: 0, tokensInput: 0, tokensOutput: 0, generatedAt: Date.now() };
    return store.statsSummary();
  });
  // R3-1（2026-11-03）：正文检索。空查询返回空结果而不是全量——「点开面板即全表返回」
  // 既浪费也会让用户以为搜到了东西。query 长度上限 200：再长的输入不是检索，是粘贴。
  ipcMain.handle('local:messages/search', async (_, payload = {}) => {
    const empty = { query: '', hits: [], total: 0, truncated: false };
    const store = deps.getLocalStore();
    if (!store) return empty;
    guard.assertStrings(payload || {}, { query: { max: 200, optional: true, allowEmpty: true } });
    const q = String(payload?.query || '');
    if (!q.trim()) return empty;
    return store.searchMessages(q, { limit: payload?.limit, threadId: payload?.threadId ?? null });
  });
  // R3-2（2026-11-03）：导出会话为 Markdown。路径**只能**来自系统保存对话框
  // （与 ledger:export 同一纪律：渲染层传来的路径一律忽略，否则等于开放任意路径写入）。
  ipcMain.handle('local:threads/export', async (_, payload = {}) => {
    guard.assertIds(payload, ['threadId']);
    const store = deps.getLocalStore();
    if (!store) return { ok: false, code: 'UNAVAILABLE', error: '本地数据层未初始化' };
    const doc = store.exportThreadMarkdown(payload.threadId);
    if (!doc.ok) return { ...doc, code: 'NOT_FOUND' };
    let picked;
    try {
      const win = BrowserWindow.getFocusedWindow() || null;
      const opts = {
        title: '导出会话为 Markdown',
        defaultPath: doc.filename,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      };
      picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    } catch (e) {
      return { ok: false, code: 'DIALOG_FAILED', error: String(e?.message || '无法打开保存对话框') };
    }
    if (!picked || picked.canceled || !picked.filePath) return { ok: false, code: 'EXPORT_CANCELLED', error: '已取消导出' };
    try {
      await fsp.writeFile(picked.filePath, doc.content, 'utf8');
    } catch (e) {
      return { ok: false, code: 'WRITE_FAILED', error: String(e?.message || '写入失败') };
    }
    try {
      audit('thread_export', String(payload.threadId), `file=${picked.filePath}`, 'recorded');
    } catch { /* 审计失败不影响导出结果：文件已经写成，这里是补充留痕 */ }
    return { ok: true, filePath: picked.filePath, bytes: Buffer.byteLength(doc.content, 'utf8') };
  });
  // /compact 落库：压缩摘要历史整体替换（P2-6 收口）
  ipcMain.handle('local:messages/replace', async (_, payload) => {
    // /compact 会整体替换历史：threadId 必填，messages 必须是数组且有条数上限
    guard.assertIds(payload || {}, ['threadId']);
    guard.assertArray(payload || {}, 'messages', { max: 5000 });
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().replaceMessages(payload?.threadId, payload?.messages || []);
  });
  ipcMain.handle('local:threads/delete', async (_, payload) => {
    guard.assertIds(payload, ['threadId']);
    // 2026-11-03（用户反馈 3）：删除会话 = **立即停止**该会话名下所有在跑任务。
    // 顺序必须是「先停再删」：反过来的话，主进程收尾会把最后一条消息写进一个已归档会话，
    // 用户在归档里又能看到它继续产出内容 —— 也就是「删了还在偷偷执行」。
    const abortedRuns = stopThreadRuns(payload.threadId);
    const r = deps.getLocalStore() ? deps.getLocalStore().archiveThread(payload.threadId) : { ok: false };
    return r && typeof r === 'object' ? { ...r, abortedRuns } : r;
  });
  // A1：会话重命名
  ipcMain.handle('local:threads/rename', async (_, payload) => {
    guard.assertIds(payload, ['threadId']);
    guard.assertStrings(payload, { title: 200 });
    const { threadId, title } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().renameThread(threadId, title) : { ok: false };
  });
  // 隔离副本被清理后，把会话的执行根指回项目目录（只接受真实存在的目录）
  ipcMain.handle('local:threads/set-cwd', async (_, payload) => {
    guard.assertIds(payload, ['threadId']);
    guard.assertStrings(payload, { cwd: 1024 });
    const { threadId, cwd } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().updateThreadCwd(threadId, cwd) : { ok: false };
  });
  // A3：归档可见 —— 恢复 / 彻底删除 / 列表
  ipcMain.handle('local:threads/archived', async () => deps.getLocalStore() ? deps.getLocalStore().listArchivedThreads() : []);
  ipcMain.handle('local:threads/restore', async (_, payload) => {
    guard.assertIds(payload, ['threadId']);
    return deps.getLocalStore() ? deps.getLocalStore().restoreThread(payload.threadId) : { ok: false };
  });
  ipcMain.handle('local:threads/purge', async (_, payload) => {
    guard.assertIds(payload, ['threadId']);
    const localStore = deps.getLocalStore();
    if (!localStore) return { ok: false };
    // 三层记忆 M2（决策 3）：彻底删除会话前先做 salvage 沉淀——
    // 有价值的 L1 会话记忆（命中≥3 或 tier≥3）晋升为项目级跨会话留存，其余 L1 随会话物理删除。
    // 语义边界：purge=不可恢复删除（值得沉淀）；archive（local:threads/delete）可恢复，不在此处理。
    // fail-open：salvage 失败绝不阻断会话删除（记忆维护不应挡用户操作）。
    let salvage = null;
    const memoryManager = deps.getMemoryManager();
    if (memoryManager) {
      try {
        salvage = memoryManager.salvageConversation({ conversationId: payload.threadId });
      } catch (e) {
        console.warn('[memory] 会话删除 salvage 失败（fail-open，不阻断删除）:', e.message);
      }
    }
    const res = localStore.purgeThread(payload.threadId);
    // 本体没删成就不要再删派生数据：先保住「可重试」的语义，避免出现
    // 「任务组没了、会话还在」这种半删状态（那比不删更难修）。
    if (!res || !res.ok) return res;
    const cascade = purgeThreadDerivatives(payload.threadId, res.cwd);
    return { ...res, cascade, ...(salvage ? { salvage } : {}) };
  });
  // B1：孤儿会话归组
  ipcMain.handle('local:threads/set-project', async (_, payload) => {
    guard.assertIds(payload, ['threadId']);
    guard.assertStrings(payload, { projectPath: { max: 1024, optional: true, allowEmpty: true } });
    const { threadId, projectPath } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().setThreadProject(threadId, projectPath) : { ok: false };
  });
  // P1-6：会话分支——以 fromMessageId 为分支点，复制出独立新会话（含该消息及之前全部历史）
  ipcMain.handle('local:threads/fork', async (_, payload) => {
    guard.assertIds(payload || {}, ['threadId', 'fromMessageId']);
    if (!deps.getLocalStore()) return { ok: false, error: '本地数据层未初始化' };
    return deps.getLocalStore().forkThread(payload.threadId, { fromMessageId: payload.fromMessageId });
  });

  ipcMain.handle('local:providers/list', async () => {
    if (!deps.getLocalStore()) return [];
    maybeSyncModelsFile(); // 文件保存即生效（mtime 变化才真正重解析）
    return deps.getLocalStore().listProviders();
  });
  ipcMain.handle('local:providers/add', async (_, payload) => {
    // X14：写凭证的通道必须先在边界校验形状（历史上 `{}` 也能写出一条空 provider）
    guard.assertStrings(payload, {
      name: 120, base_url: 2000, api_key: { max: 4000, allowEmpty: true }, model_id: { max: 200, allowEmpty: true },
    });
    const { name, base_url, api_key, model_id } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    if (!deps.getCredentialCrypto()) throw new Error('本地数据层未初始化');
    const keyEncrypted = deps.getCredentialCrypto().encrypt(String(api_key || ''));
    const p = deps.getLocalStore().addProvider({ name, base_url, keyEncrypted, modelId: model_id });
    deps.localVault.set(p.id, { api_key: String(api_key || ''), base_url });
    return p;
  });
  ipcMain.handle('local:providers/set-model', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, { model_id: 200 });
    const { id, model_id } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().setProviderModel(id, model_id);
  });
  // 多模型：本机 provider 模型条目可增可删（修复「单模型不可删、UI 假装无限添加」）
  ipcMain.handle('local:providers/add-model', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, { model_id: 200, display_name: { max: 200, optional: true } });
    const { id, model_id, display_name, caps } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    // N1：未显式传能力位时按预置能力目录从模型 ID 推断（与 file 来源 addModelToRaw 同源）
    const picked = pickCaps(caps);
    const finalCaps = Object.keys(picked).length ? picked : modelsFile.suggestCaps(model_id);
    return deps.getLocalStore().addProviderModel(id, { model_id, display_name, caps: finalCaps });
  });
  // N1：本机（UI 手工添加）provider 的能力位写回
  ipcMain.handle('local:providers/update-model-caps', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, { model_id: 300 });
    const { id, model_id, caps } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().updateProviderModelCaps(id, model_id, pickCaps(caps));
  });
  ipcMain.handle('local:providers/remove-model', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, { model_id: 200 });
    const { id, model_id } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    return deps.getLocalStore().removeProviderModel(id, model_id);
  });
  ipcMain.handle('local:providers/delete', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    const { id } = payload;
    if (deps.getLocalStore()) deps.getLocalStore().deleteProvider(id);
    deps.localVault.delete(Number(id));
    return { ok: true };
  });
  // B2：供应商编辑（name/base_url/换 Key；Key 走凭证加密双轨落库）
  ipcMain.handle('local:providers/update', async (_, payload) => {
    guard.assertIds(payload, ['id']);
    guard.assertStrings(payload, {
      name: { max: 120, optional: true }, base_url: { max: 2000, optional: true }, api_key: { max: 4000, optional: true, allowEmpty: true },
    });
    const { id, name, base_url, api_key } = payload;
    if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
    if (!deps.getCredentialCrypto()) throw new Error('本地数据层未初始化');
    let keyEncrypted;
    if (api_key) {
      keyEncrypted = deps.getCredentialCrypto().encrypt(String(api_key));
      const cur = deps.localVault.get(Number(id)) || {};
      deps.localVault.set(Number(id), { ...cur, api_key: String(api_key), base_url: base_url || cur.base_url });
    } else if (base_url && deps.localVault.get(Number(id))) {
      deps.localVault.get(Number(id)).base_url = base_url;
    }
    return deps.getLocalStore().updateProvider(id, { name, base_url, keyEncrypted });
  });
  // B2：测试连接（对 base_url 的 /models 发起探测，返回延迟；Key 仅在主进程内存解析）
  ipcMain.handle('model:testConnection', async (_, { id, base_url } = {}) => {
    // X14：base_url 会被拼成 `${url}/models` 直接发请求——非字符串会拼出 "[object Object]/models"，
    // 用户看到的是一个莫名其妙的网络错误；id 允许缺省（只测地址、不测 Key 的场景）
    try {
      guard.assertStrings({ base_url }, { base_url: { max: 2000, optional: true, allowEmpty: true } });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const vault = deps.localVault.get(Number(id));
    const url = (base_url || vault?.base_url || '').replace(/\/+$/, '');
    if (!url) return { ok: false, error: '缺少接口地址' };
    // ── 2026-11-05（AC-2.8 修假绿 + MD2 去假 Key）────────────────────────────────
    // 原先只有在有 Key 时才发 `Authorization`，没 Key 就**裸调** `${url}/models`。
    // 而 /models 端点普遍不校验凭证（Ollama 更是完全不校验）⇒ 探测返回 `ok:true`，
    // 用户以为配好了；一发送消息立刻 `KEY_MISSING`。这就是「测试连接绿、发消息红」的假绿：
    // 用户会反复怀疑网络与接口地址，因为唯一被指出的「重新填写 API Key」在本机根本没 Key 可填。
    //
    // 现在两侧用**同一个判据** `localModel.credentialUsable`（三处发消息入口也已切到它）：
    //   · 有 Key            ⇒ 照常探测（远端/本机都放行）；
    //   · 无 Key + 本机回环 ⇒ 放行（MD2：这才是「离线级」的默认形态），探测不带 Authorization；
    //   · 无 Key + 远端     ⇒ `KEY_MISSING`，且**不发任何网络请求**（不靠端点是否放行碰运气）。
    // 判据同源是关键：只要两边共用它，就不可能再出现「一边绿一边红」。
    //
    // `id` 缺省时保留旧语义（只测地址连通性、不判 Key），这是调试用途，不属于假绿。
    const hasProvider = Number.isFinite(Number(id));
    if (hasProvider && !localModel.credentialUsable(vault, url)) {
      return {
        ok: false, errorCode: 'KEY_MISSING', keyRequired: true,
        error: 'KEY_MISSING: 未配置 API Key，发送消息时会被同样拒绝（测试连接与实跑同一判据）。'
          + '本机 127.0.0.1 / localhost 端点无需 Key。',
      };
    }
    // Key 含非 ASCII（典型：模板占位「sk-请替换成你的Key」未替换）时 fetch 头部会抛
    // ByteString 错误（真机复现），提前拦截给出可行动提示，而不是让用户看到天书报错
    if (vault?.api_key && /[^\x20-\x7E]/.test(vault.api_key)) {
      return { ok: false, error: 'API Key 含非 ASCII 字符（可能仍是模板占位符），请先替换为真实 Key' };
    }
    const started = Date.now();
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (vault?.api_key) headers['Authorization'] = `Bearer ${vault.api_key}`;
      const r = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - started;
      if (!r.ok) return { ok: false, latencyMs, error: `HTTP ${r.status}` };
      return { ok: true, latencyMs };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
  });

  // B1：项目一等实体（本机持久化）
  ipcMain.handle('local:projects/list', async () => deps.getLocalStore() ? deps.getLocalStore().listProjects() : []);
  ipcMain.handle('local:projects/add', async (_, payload) => {
    guard.assertStrings(payload, { path: 1024, name: { max: 200, optional: true, allowEmpty: true } });
    const { path, name } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().addProject({ path, name }) : null;
  });
  ipcMain.handle('local:projects/remove', async (_, payload) => {
    guard.assertStrings(payload, { path: 1024 });
    return deps.getLocalStore() ? deps.getLocalStore().removeProject(payload.path) : { ok: false };
  });
  ipcMain.handle('local:projects/rename', async (_, payload) => {
    guard.assertStrings(payload, { path: 1024, name: 200 });
    const { path, name } = payload;
    return deps.getLocalStore() ? deps.getLocalStore().renameProject(path, name) : { ok: false };
  });

  ipcMain.handle('local:preferences/get', async (_, { key }) => deps.getLocalStore() ? deps.getLocalStore().getPreference(key) : undefined);
  ipcMain.handle('local:preferences/set', async (_, { key, value } = {}) => {
    // X14：key 是偏好表的键（决定写哪一行），非字符串会落成 "[object Object]" 键——数据还在，
    // 但读端永远读不回来；value 的形状由各偏好项自己约定，边界不校验
    try {
      guard.assertStrings({ key }, { key: 200 });
      // D4：value 的**形状**仍不校验（各偏好项自行约定），但必须限长——本通道渲染层可直调，
      // 而 setPreference 每次都会把整份 preferences JSON 重写落盘：一个超大值会让此后每次 flush 都变慢。
      // 现存偏好都是设置/会话类小对象，256KB 已远超实际需要；超限**拒绝**而不是静默截断（截断会写坏形状）。
      const size = JSON.stringify(value ?? null).length;
      if (size > 256 * 1024) return { ok: false, error: `偏好值过大（${size} 字节，上限 262144）` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return deps.getLocalStore() ? deps.getLocalStore().setPreference(key, value) : { ok: false };
  });

  // 服务端地址读写（设置-通用）：写偏好（三级解析之首）；读返回当前生效地址与来源
  ipcMain.handle('local:server/base', async (_, { base } = {}) => {
    if (base != null) {
      const v = String(base).trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(v)) throw new Error('服务端地址需以 http:// 或 https:// 开头');
      if (!deps.getLocalStore()) throw new Error('本地数据层未初始化');
      deps.getLocalStore().setPreference('server.apiBase', v);
    }
    return {
      base: deps.serverBase(),
      default: deps.MJ_SERVER_DEFAULT,
      source: deps.getLocalStore()?.getPreference?.('server.apiBase') ? 'preference' : (process.env.MJ_SERVER_API ? 'env' : 'default'),
    };
  });

  // P1-16：MemoryManager 未就绪时的写入内存队列——就绪后（下一次记忆 IPC 调用）flush。
  // 绝不落 localStore JSON：那正是「双轨分裂」的根——JSON 轨永不迁移、永不可读，
  // 用户以为存了记忆，实际上召回与 UI 都只读 SQLite 轨。
  // 队列只在进程存活期有效：未就绪即退出 = 从未真正开始使用记忆，无实际损失。
  let memoryWriteQueue = [];
  function flushMemoryQueue() {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager || memoryWriteQueue.length === 0) return 0;
    const pending = memoryWriteQueue;
    memoryWriteQueue = [];
    let n = 0;
    for (const item of pending) {
      try {
        if (memoryManager.remember(item)) n += 1;
      } catch (e) {
        // 单条失败即丢弃（不重试爆栈）：该条已被调用方视为「已受理」
        console.warn('[memory] 队列补写失败（丢弃该条）:', e.message);
      }
    }
    if (n > 0) console.log(`[memory] 就绪后补写队列：${n} 条`);
    if (memoryWriteQueue.length === 0) stopMemoryFlushProbe();
    return n;
  }

  // T-06：flush 触发点过窄的补强。
  // 缺陷形态：flush 只在 local:memories/add 与 local:memories/list 里被调用 ⇒
  //   「子系统未就绪时写入一条记忆、此后不再有任何记忆类 IPC」时该条**永远不落库**，
  //   进程退出即丢（启动早期 DB 初始化慢于首次渲染时真实存在这个窗口）。
  // 修法：本模块自带就绪探测定时器——队列非空期间定期检查 MemoryManager 是否就绪，
  //   一旦就绪立即补写。放在这里而不是 main.js，是为了让「谁负责落库」与
  //   「谁创建队列」同属一个模块（就绪判定与补写逻辑不再跨文件漂移）。
  const MEMORY_FLUSH_PROBE_MS = 1000;
  let memoryFlushProbe = null;
  function stopMemoryFlushProbe() {
    if (!memoryFlushProbe) return;
    clearInterval(memoryFlushProbe);
    memoryFlushProbe = null;
  }
  function startMemoryFlushProbe() {
    if (memoryFlushProbe) return;
    memoryFlushProbe = setInterval(() => {
      if (memoryWriteQueue.length === 0) { stopMemoryFlushProbe(); return; }
      flushMemoryQueue();
    }, MEMORY_FLUSH_PROBE_MS);
    // 不因探针吊住进程退出（应用退出时未落库队列随进程消失，与既有语义一致）
    if (memoryFlushProbe.unref) memoryFlushProbe.unref();
  }

  // 三层记忆 M1：domain 白名单（与 memory/index.js 的 remember 校验同源，宿主侧先归一化，
  // 非法值回落 global_knowledge 以保持既有 /mem 语义不变）。
  const MEMORY_DOMAINS = ['private', 'session', 'global_knowledge', 'entity', 'reflection'];
  ipcMain.handle('local:memories/add', async (_, { projectPath, content, source = 'model_conclusion', domain = 'global_knowledge', scope, conversationId } = {}) => {
    // P0-2b/P1-16：写入收口 MemoryManager（SQLite）+ 显式来源（未知来源被 remember 拒绝）
    // X14：content 进 SQLite 且会被召回进模型上下文，projectPath 是记忆空间分区键——
    // 形状与长度在边界守（source 的白名单仍由 remember 判，属业务语义）
    try {
      guard.assertStrings({ projectPath, content, source }, {
        projectPath: { max: 1024, optional: true, allowEmpty: true },
        content: 50000,
        source: { max: 100, optional: true },
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // 三层记忆 M1：domain/scope 由调用方显式指定（/mem 作用域分流）。
    // domain 非法回落 global_knowledge；scope 合法性交由 remember 的 resolveScope 统一判定
    // （单一事实来源，宿主不重复实现作用域约束）。
    const dom = MEMORY_DOMAINS.includes(domain) ? domain : 'global_knowledge';
    // 三层记忆 M3（R1 修复，2026-10-20）：会话层记忆必须绑定 conversationId——
    // 此前 autoCapture 通道未传该键，source=model_conclusion → resolveScope 回落 session，
    // 但 conversation_id=NULL ⇒ 会话层召回/清扫（均按 conv 过滤）永远命中不到，成为孤儿行。
    // 非会话层由 remember 内部按 scope 自动解绑，故此处无条件透传即可。
    const conv = conversationId ? String(conversationId) : null;
    const memoryManager = deps.getMemoryManager();
    if (memoryManager) {
      flushMemoryQueue(); // 就绪后补写积压（P1-16）
      const m = memoryManager.remember({ spaceId: projectPath, domain: dom, scope, content, source, conversationId: conv });
      return m ? { id: m.id, content: m.content } : { ok: false, error: '写入被拒绝：内容为空或来源不在白名单' };
    }
    memoryWriteQueue.push({ spaceId: projectPath || 'default', domain: dom, scope, content, source, conversationId: conv });
    // T-06：队列非空即启动就绪探针——不依赖「用户再点一次记忆」才落库
    startMemoryFlushProbe();
    return { queued: true };
  });
  ipcMain.handle('local:memories/list', async (_, { projectPath, limit, query, conversationId } = {}) => {
    // P2-6：分层召回路由（importance×recency×相关性 Top-K）+ P0-2c 域/可信度过滤
    // 三层记忆 M3：分层模式——会话层（按 conversationId 绑定）+ 项目层 + 全局层（跨项目），
    // 输出携带 scope；渲染层据此加层级前缀（`[个人]/[项目]/[本次会话]`）后注入 system prompt。
    // T-09：query 是相关性因子（权重 0.40）的唯一输入——缺省即空串（跳过相关性因子，
    //   退化为 importance×recency），与既有行为完全一致；渲染层是否传由渲染侧决定，
    //   主侧只保证「能收、能原样透传」。
    // T-01：limit 现在是**真正生效**的召回条数上限（分层路径此前完全丢弃 topK）。
    //   最小值保底 1：limit 传 0/负数/非数字时不得把主对话召回打成空。
    const topK = Math.max(1, Number(limit) || 7);
    const memoryManager = deps.getMemoryManager();
    if (memoryManager) {
      flushMemoryQueue();
      return memoryManager.recallContents({
        spaceId: projectPath, query, topK,
        scopes: [...SCOPES], conversationId: conversationId || null,
      });
    }
    // P1-16：未就绪返回空——不再回落 localStore JSON 轨
    return [];
  });
  // 三层记忆 M3：记忆文件双通道同步（打开项目时「导入外部变更 → 落盘当前视图」）
  ipcMain.handle('local:memories/syncFile', async (_, { projectPath } = {}) => {
    try {
      guard.assertStrings({ projectPath }, { projectPath: { max: 1024, optional: true, allowEmpty: true } });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const sync = deps.getMemoryFileSync?.();
    if (!sync || !deps.getMemoryManager()) return { ok: false, error: '记忆子系统未就绪' };
    try {
      return { ok: true, ...sync.syncProject(projectPath) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // P2-8 数据源：记忆统计与后台任务列表（可视化 UI 后续接入）
  // T-06：统计是「记忆子系统已就绪」的天然观测点——在此顺带补写积压队列，
  //   并把「未落库条数」一并回传：静默丢失窗口从此可被程序化观测，而不是只能靠猜。
  //   （另一条触发路径是 startMemoryFlushProbe 的就绪探测，不依赖任何 IPC 被调用。）
  ipcMain.handle('memory:stats', async () => {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, pending: memoryWriteQueue.length };
    flushMemoryQueue();
    return { ok: true, stats: memoryManager.stats(), pending: memoryWriteQueue.length };
  });
  // N9：治理开关命中率只读出口（hook / 意图预热 / 技能按需加载）——纯内存计数，重启清零。
  // 让「开关到底有没有生效」可被程序化读取，而不是只躺在 console 日志里无人消费。
  ipcMain.handle('governance:stats', async () => ({ ok: true, stats: governanceStats.snapshot() }));
  ipcMain.handle('memory:bgTasks', async (_, opts) => (deps.getMemoryScheduler() ? { ok: true, tasks: deps.getMemoryScheduler().listTasks(opts) } : { ok: false }));
  // P0-2c/P1-17：记忆管理 IPC（设置页「记忆与后台作业」分区消费）——
  // invalidate 早已在 memory/index.js 实现但无 IPC 出口；promote 对应「人工确认长期留存」。
  ipcMain.handle('memory:list', async (_, { projectPath, limit = 50, offset = 0, scope = null, teamId = null, agentId = null } = {}) => {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    // M5 / T5-5：scope/teamId/agentId 为可选过滤（记忆面板按层筛选与团队视图取数）；
    // 缺省保持原「按 space_id 全量」旧行为。
    return { ok: true, items: memoryManager.list({ spaceId: projectPath, limit, offset, scope, teamId, agentId }) };
  });
  ipcMain.handle('memory:invalidate', async (_, { id, reason } = {}) => {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    const m = memoryManager.invalidate(id, reason || '用户在设置页手动作废');
    return m ? { ok: true, item: m } : { ok: false, error: '记忆不存在' };
  });
  ipcMain.handle('memory:promote', async (_, { id } = {}) => {
    // IPC 边界守卫（第二轮审查：这是 168 条 handler 中少数完全没有校验的写通道之一，
    // 且不在 ipc-write-guard 的清单里 → 改坏也没有门禁看守）
    guard.assertStrings({ id }, { id: 200 });
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    const m = memoryManager.promoteToLongTerm(id);
    return m ? { ok: true, item: m } : { ok: false, error: '记忆不存在或已失效' };
  });
  // 三层记忆 M3：作用域清空（设置页「记忆」分区高级管理）——
  //   project —— 清空当前项目空间的项目级记忆；global —— 清空全部跨项目全局记忆（spaceId 不传）。
  ipcMain.handle('memory:resetScope', async (_, { scope, projectPath, teamId } = {}) => {
    guard.assertEnum({ scope }, 'scope', ['session', 'team', 'project', 'global']);
    // M5 / T5-5：team 层必须携带 teamId（无归属键清空会退化为「按 space 删全部」，语义错误）
    if (scope === 'team') {
      try {
        guard.assertStrings({ teamId }, { teamId: 200 });
      } catch {
        return { ok: false, error: '缺少团队标识（teamId）' };
      }
    }
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    const removed = memoryManager.resetScope({
      scope,
      spaceId: (scope === 'global' || scope === 'team') ? null : (projectPath || null),
      teamId: scope === 'team' ? String(teamId) : null,
    });
    return { ok: true, removed };
  });
  // M5 / T5-5（U5 提名制）：团队记忆「待晋升候选」——**只读**，写入永远由用户在 UI 一键确认。
  //   团队知识留在宿主：团队名/统筹名/归档态由 teamStore 现算注入，MemoryManager 不认识军团实体。
  ipcMain.handle('memory:teamPromotionCandidates', async (_, { limit = 100, minHits } = {}) => {
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    const ts = deps.getTeamStore?.();
    const excludeTeamIds = [];
    const excludeNames = [];
    if (ts) {
      for (const t of ts.listTeams({ includeArchived: true }) || []) {
        // ① 已归档团队的记忆不参与跨团队复用
        if (t.archivedAt) { excludeTeamIds.push(t.id); continue; }
        // ② 含团队专有名（团队名 / 统筹名）的条目直接不进候选（防跨团队污染）
        if (t.name) excludeNames.push(t.name);
        if (t.leadMemberId) {
          const lead = ts.getMember(t.id, t.leadMemberId);
          if (lead?.name) excludeNames.push(lead.name);
        }
      }
    }
    return { ok: true, items: memoryManager.listTeamPromotionCandidates({ minHits, excludeNames, excludeTeamIds, limit }) };
  });
  // M5 / T5-5：一键确认晋升（团队记忆 → 项目级）——用户显式操作，走唯一向上晋升路径。
  ipcMain.handle('memory:confirmTeamPromotion', async (_, { id } = {}) => {
    guard.assertStrings({ id }, { id: 200 });
    const memoryManager = deps.getMemoryManager();
    if (!memoryManager) return { ok: false, error: '记忆子系统未就绪' };
    const m = memoryManager.promoteTeamMemoryToProject(id);
    return m ? { ok: true, item: m } : { ok: false, error: '记忆不存在、已失效或非团队层' };
  });

  // ST4-④（2026-11-05）：数据库备份 / 导入的用户侧入口。
  // 挂在这里而不是 main.js：后者 code 行数已钉死（max-lines 棘轮，加一行即红）；
  // 且备份/导入与「会话导出」同属本地数据域，通道前缀 db: 由子模块自己声明。
  require('./dbMaintenance').initDbMaintenanceIpc();
}

function initLocalDataIpc(d) {
  deps = d;
  register();
}

module.exports = {
  initLocalDataIpc,
  syncModelsFile,
  maybeSyncModelsFile,
  migrateLocalModelsToFile,
  getModelsFileLastStatus: () => modelsFileLastStatus,
};
