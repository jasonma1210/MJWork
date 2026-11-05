// 数据访问层：服务端 API 与本地存储（离线模式）双轨路由
// 服务端地址优先级：localStorage mj_api_base（历史覆盖）→ 主进程偏好 server.apiBase（设置-通用）
// → env MJ_SERVER_API（主进程侧）→ 默认本机 3001
let API = (typeof localStorage !== 'undefined' && localStorage.getItem('mj_api_base'))
  || 'http://localhost:3001/api';

export function getApiBase() { return API; }
export function setApiBase(b) {
  const v = String(b || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(v) || v === API) return;
  API = v;
  try { localStorage.setItem('mj_api_base', API); } catch { /* 隐私模式等场景尽力而为 */ }
}

// 启动同步：主进程偏好是打包版唯一可用的服务端地址入口（env 经 Finder 启动不可达）
if (typeof window !== 'undefined' && window.mjcode?.serverBase) {
  window.mjcode.serverBase().then((r) => { if (r?.base) setApiBase(r.base); }).catch(() => {});
}

let localMode = false;
export function setLocalMode(v) { localMode = !!v; }
export function isLocalMode() { return localMode; }

function getToken() {
  return localStorage.getItem('mj_token');
}

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      ...options.headers,
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('mj_token');
    window.dispatchEvent(new Event('auth-changed'));
    throw new Error('Unauthorized');
  }
  return res.json();
}

// ── 离线模式本地路由 ──
async function localThreads(projectPath) {
  return window.mjcode.localThreads(projectPath ? { projectPath } : {});
}

async function localCreateThread(data) {
  return window.mjcode.localCreateThread({
    title: data.title, cwd: data.cwd, projectPath: data.project_path || data.cwd || '',
    providerId: data.provider_id, providerName: data.provider_name, modelName: data.model_name,
  });
}

async function localMessages(id) {
  return window.mjcode.localMessages({ threadId: id });
}

// P1-6：会话分支——以 fromMessageId 为分支点复制出一支新会话（仅本地模式）
async function localForkThread(id, fromMessageId) {
  return window.mjcode.localForkThread({ threadId: id, fromMessageId });
}

async function localSendMessage(id, data) {
  return window.mjcode.localAddMessage({
    threadId: id,
    role: data.role, content: data.content,
    toolCalls: data.tool_calls || null, toolCallId: data.tool_call_id || null,
    tokensInput: data.tokens_input || 0, tokensOutput: data.tokens_output || 0,
    modelName: data.model_name,
  });
}

async function localProviders() {
  const list = await window.mjcode.localProviders();
  // 与服务端结构对齐：models 由多模型数组派生；对未迁移的旧结构（仅 modelId）做容错回落
  return list.map((p) => ({
    ...p,
    // source: 'file' = ~/.mjcode/models.json 同步（UI 只读展示）；其余为本机手工添加
    source: p.source || 'local',
    // P0-3③：caps（supportsReasoning / supportedEfforts）必须原样透传到渲染层，
    // 否则 ModelSelector 的能力门控拿不到数据 → 门控永不触发（数据缺就是缺，不补默认值）
    models: (p.models || (p.modelId ? [{ modelId: p.modelId, displayName: p.modelId }] : []))
      .map((m) => ({
        id: m.modelId,
        model_id: m.modelId,
        display_name: m.displayName || m.modelId,
        ...(m.caps && typeof m.caps === 'object' ? { caps: m.caps } : {}),
      })),
  }));
}

// 服务端私有 provider：id 加 s 前缀做命名空间隔离，避免与本机 provider id 冲突
function markServerProviders(list) {
  return (list || []).map((p) => ({ ...p, id: `s${p.id}`, source: 'server' }));
}

// i18n：本文件被纯 Node 测试静态导入，不能 import i18n/index.ts（TS+React）；
// 经 globalThis.__MJ_T__ 运行时通道取翻译（i18n 模块加载时置位；未置位回落返回 key）
const t = (key, params) => (typeof globalThis.__MJ_T__ === 'function' ? globalThis.__MJ_T__(key, params) : key);

// 底层错误可读化：UI 禁止直接暴露 Failed to fetch 一类原始英文错误
export function humanizeError(err) {
  const raw = String((err && err.message) || err || t('runtime.unknownError'));
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(raw)) {
    return t('runtime.localServiceDown');
  }
  if (raw === 'Unauthorized') return t('runtime.authFailed');
  // A3（2026-10-16）：沙箱/隔离类失败不得只把底层原文甩给用户——补「安全下一步」指引。
  // 关键约束：指引里**不出现**「改用 full-access」这类建议（那会关闭全部隔离）。
  // 匹配串只保留 ASCII 标识（主进程发出的 errorCode / 后端名），裸中文会被 i18n 门禁拒绝。
  if (/sandbox-unavailable|command-guard-blocked|operation not permitted|bubblewrap|sandboxed/i.test(raw)) {
    return `${raw}\n\n${t('runtime.sandboxNextStepGeneric')}`;
  }
  return raw;
}

export const api = {
  // Threads（projectPath 用于「项目 → 任务」二级筛选）
  threads: (projectPath) => (localMode
    ? localThreads(projectPath)
    : request(projectPath ? `/threads?project=${encodeURIComponent(projectPath)}` : '/threads')),
  createThread: (data) => (localMode ? localCreateThread(data) : request('/threads', { method: 'POST', body: JSON.stringify(data) })),
  setThreadStatus: (id, status) => (localMode
    ? window.mjcode.localSetThreadStatus({ id, status })
    : request(`/threads/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })),
  messages: (id) => (localMode ? localMessages(id) : request(`/threads/${id}/messages`)),
  // R3-1：正文检索（本地能力）。服务端无对应路由，返回空结果而不是抛错——
  // 「搜不到」与「搜失败」在 UI 上必须能区分，故这里不 reject。
  searchMessages: (payload) => (localMode && window.mjcode?.localSearchMessages
    ? window.mjcode.localSearchMessages(payload)
    : Promise.resolve({ query: '', hits: [], total: 0, truncated: false, unavailable: true })),
  // R3-2：导出会话为 Markdown（本地能力；路径由系统保存对话框给出）
  exportThread: (id) => (localMode && window.mjcode?.localExportThread
    ? window.mjcode.localExportThread({ threadId: id })
    : Promise.resolve({ ok: false, code: 'UNAVAILABLE', error: t('runtime.exportNeedsLocal') })),
  // ST4-④：数据库维护（本地能力，服务端无对应路由）。缺桥方法时返回结构化 UNAVAILABLE
  // 而不是抛错——界面要能显示「此版本不支持」，不能白屏（与 searchMessages 同口径）。
  dbBackupCreate: () => (window.mjcode?.dbBackupCreate
    ? window.mjcode.dbBackupCreate()
    : Promise.resolve({ ok: false, code: 'UNAVAILABLE', error: t('runtime.dbMaintUnavailable') })),
  dbBackupExport: () => (window.mjcode?.dbBackupExport
    ? window.mjcode.dbBackupExport()
    : Promise.resolve({ ok: false, code: 'UNAVAILABLE', error: t('runtime.dbMaintUnavailable') })),
  dbImportPick: () => (window.mjcode?.dbImportPick
    ? window.mjcode.dbImportPick()
    : Promise.resolve({ ok: false, code: 'UNAVAILABLE', error: t('runtime.dbMaintUnavailable') })),
  dbImportCommit: (payload) => (window.mjcode?.dbImportCommit
    ? window.mjcode.dbImportCommit(payload)
    : Promise.resolve({ ok: false, code: 'UNAVAILABLE', error: t('runtime.dbMaintUnavailable') })),
  // P1-6：会话分支（仅本地模式；服务端无对应路由）——从某条历史消息处开一支新会话
  forkThread: (id, fromMessageId) => {
    if (!localMode) return Promise.reject(new Error(t('runtime.forkOnlineUnsupported')));
    return localForkThread(id, fromMessageId);
  },
  sendMessage: (id, data) => (localMode ? localSendMessage(id, data) : request(`/threads/${id}/messages`, { method: 'POST', body: JSON.stringify(data) })),
  // /compact 落库：压缩摘要整体替换消息历史（仅本地模式；服务端无替换路由）
  replaceMessages: (id, messages) => {
    if (!localMode) return Promise.reject(new Error(t('runtime.compactOnlineUnsupported')));
    return window.mjcode.localReplaceMessages({ threadId: id, messages });
  },
  deleteThread: (id) => (localMode ? window.mjcode.localDeleteThread({ threadId: id }) : request(`/threads/${id}`, { method: 'DELETE' })),
  // A1：会话重命名（本地 + 服务端双轨）
  renameThread: (id, title) => (localMode
    ? window.mjcode.localRenameThread({ threadId: id, title })
    : request(`/threads/${id}/title`, { method: 'PUT', body: JSON.stringify({ title }) })),
  // A3：归档管理（本地能力；服务端删除同为归档语义，恢复走本地通道）
  archivedThreads: () => (localMode
    ? window.mjcode.localArchivedThreads()
    : Promise.reject(new Error(t('runtime.archiveNeedsLocal')))),
  restoreThread: (id) => window.mjcode.localRestoreThread({ threadId: id }),
  purgeThread: (id) => window.mjcode.localPurgeThread({ threadId: id }),
  // B1：会话归组到项目（本地通道）
  setThreadProject: (id, projectPath) => window.mjcode.localSetThreadProject({ threadId: id, projectPath }),

  // Providers（私有凭证一律落本机数据库：localStore + safeStorage 加密，密钥不出本机）
  // 在线模式额外追加服务端私有 provider（id 带 s 前缀）；服务端不可达时静默降级为纯本机列表
  providers: async () => {
    const local = await localProviders();
    if (localMode) return local;
    try {
      return [...local, ...markServerProviders(await request('/providers'))];
    } catch (err) {
      console.warn('[api] server model list unreachable, falling back to local list:', err.message);
      return local;
    }
  },
  addProvider: (data) => window.mjcode.localAddProvider({
    name: data.name, base_url: data.base_url, api_key: data.api_key, model_id: data.model_id || '',
  }),
  addModel: (pid, data) => (String(pid).startsWith('s')
    ? request(`/providers/${String(pid).slice(1)}/models`, { method: 'POST', body: JSON.stringify(data) })
    : window.mjcode.localSetProviderModel({ id: pid, model_id: data.model_id })),
  // 多模型：本机 provider 模型条目增删（服务端无删除路由，仅本机支持）
  addProviderModel: (pid, data) => (String(pid).startsWith('s')
    ? request(`/providers/${String(pid).slice(1)}/models`, { method: 'POST', body: JSON.stringify(data) })
    : window.mjcode.localAddProviderModel({ id: pid, model_id: data.model_id, display_name: data.display_name, caps: data.caps })),
  removeProviderModel: (pid, modelId) => (String(pid).startsWith('s')
    ? Promise.reject(new Error(t('runtime.serverModelDeleteUnsupported')))
    : window.mjcode.localRemoveProviderModel({ id: pid, model_id: modelId })),
  deleteProvider: (id) => (String(id).startsWith('s')
    ? request(`/providers/${String(id).slice(1)}`, { method: 'DELETE' })
    : window.mjcode.localDeleteProvider({ id })),
  // B2：供应商编辑（仅本机 provider；服务端 provider 名称/地址由服务端管理）
  updateProvider: (id, data) => (String(id).startsWith('s')
    ? Promise.reject(new Error(t('runtime.serverModelEditUnsupported')))
    : window.mjcode.localUpdateProvider({ id, name: data.name, base_url: data.base_url, api_key: data.api_key })),
  // B2：测试连接（本机 provider 由主进程内存解析 Key）
  testConnection: (id, baseUrl) => window.mjcode.testConnection({ id, base_url: baseUrl }),
  // 自定义模型配置文件（~/.mjcode/models.json）：状态查询（含 mtime 热同步）与打开/初始化
  modelsFileStatus: () => window.mjcode.localModelsFileStatus(),
  modelsFileOpen: () => window.mjcode.localModelsFileOpen(),
  // file 来源 provider 的写回：删除/添加模型会修改配置文件（再由 mtime 热同步回流列表）
  removeFileProviderModel: (fileKey, modelId) => window.mjcode.localModelsFileRemoveModel({ fileKey, modelId }),
  removeFileProvider: (fileKey) => window.mjcode.localModelsFileRemoveProvider({ fileKey }),
  addFileProviderModel: (fileKey, data) => window.mjcode.localModelsFileAddModel({ fileKey, model_id: data.model_id, display_name: data.display_name, caps: data.caps }),
  // N1：模型能力位写回（图像理解 / 工具调用 / 推理强度）。file 来源写 models.json，本机来源写本地库。
  updateFileModelCaps: (fileKey, modelId, caps) => window.mjcode.localModelsFileUpdateModelCaps({ fileKey, modelId, caps }),
  updateProviderModelCaps: (pid, modelId, caps) => window.mjcode.localUpdateProviderModelCaps({ id: pid, model_id: modelId, caps }),

  // Server-side global providers（离线不可用）。
  // 离线模式必须静默跳过——否则启动即打 3001 被 CSP connect-src 拦截，产生无意义控制台报错
  // （2026-10-15 真机噪声）；在线模式仍照常拉取，失败静默回空数组不阻断界面（与 providers() 同款降级）。
  globalProviders: async () => {
    if (localMode) return [];
    try {
      const res = await fetch(`${API}/global/providers`);
      return await res.json();
    } catch (err) {
      console.warn('[api] global providers unreachable:', err.message);
      return [];
    }
  },

  // Scheduled tasks：桌面端本地调度器优先（离线可用，主进程 20s 轮询 cron 到点执行）；
  // 无本地通道（旧构建/浏览器调试）时回落服务端 /scheduled-tasks
  scheduledTasks: async () => {
    if (window.mjcode?.scheduledList) return (await window.mjcode.scheduledList()).tasks;
    return request('/scheduled-tasks');
  },
  // 带存储状态的列表：recoverable 非空 = 主存储被写空但备份里还有任务（需要用户点头才恢复）
  scheduledStore: async () => {
    if (window.mjcode?.scheduledList) return window.mjcode.scheduledList();
    return { tasks: await request('/scheduled-tasks'), runs: [], recoverable: null };
  },
  restoreScheduledBackup: () => (window.mjcode?.scheduledRestoreBackup
    ? window.mjcode.scheduledRestoreBackup()
    : Promise.resolve({ ok: false, error: 'unsupported' })),
  createScheduledTask: (data) => (window.mjcode?.scheduledSave
    ? window.mjcode.scheduledSave({ enabled: true, ...data })
    : request('/scheduled-tasks', { method: 'POST', body: JSON.stringify(data) })),
  updateScheduledTask: (id, data) => (window.mjcode?.scheduledSave
    ? window.mjcode.scheduledSave({ id, ...data })
    : request(`/scheduled-tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) })),
  deleteScheduledTask: (id) => (window.mjcode?.scheduledDelete
    ? window.mjcode.scheduledDelete({ id })
    : request(`/scheduled-tasks/${id}`, { method: 'DELETE' })),
  runScheduledTask: (id) => (window.mjcode?.scheduledRun
    ? window.mjcode.scheduledRun({ id })
    : request(`/scheduled-tasks/${id}/run`, { method: 'POST' })),
  scheduledTaskRuns: async (id) => {
    if (window.mjcode?.scheduledRuns) return (await window.mjcode.scheduledRuns({ id })).runs;
    return request(`/scheduled-tasks/${id}/runs`);
  },

  // Dashboard（离线降级：返回本地统计）
  dashboard: async () => {
    if (!localMode) return request('/dashboard');
    // R2-6（2026-11-03）：优先走主进程聚合（一次遍历、一次 IPC）。
    // 旧写法是「逐会话 await localMessages 再本地累加」——线程数 N 就是 N 次 IPC，
    // 且每次在旧实现里还要全库 filter+sort，构成 N×M 的双重放大。
    if (window.mjcode?.localStatsSummary) {
      const raw = await window.mjcode.localStatsSummary();
      const s = raw || {};
      return {
        data_scope: 'local',
        threads: Number(s.threads) || 0,
        messages: Number(s.messages) || 0,
        tokens_input: Number(s.tokensInput) || 0,
        tokens_output: Number(s.tokensOutput) || 0,
        model_distribution: [],
        recent_activity: [],
        weekly_threads: [],
      };
    }
    // 桥缺失（旧构建 / 浏览器调试）时的回落：保持可用，但会在线程多时明显变慢
    const threads = await window.mjcode.localThreads();
    let messages = [];
    for (const t of threads) messages = messages.concat(await window.mjcode.localMessages({ threadId: t.id }));
    return {
      // B3（2026-10-16）：标明数据口径为「本地统计」——前端据此解释为何部分图表无数据，
      // 避免用户把「本地不计算该维度」误读为「没有任何活动」。
      data_scope: 'local',
      threads: threads.length,
      messages: messages.length,
      tokens_input: messages.reduce((s, m) => s + (m.tokensInput || 0), 0),
      tokens_output: messages.reduce((s, m) => s + (m.tokensOutput || 0), 0),
      model_distribution: [],
      recent_activity: [],
      weekly_threads: [],
    };
  },

  // P1-4：Windows OS 级沙箱接线（命令清单审计 / 一次性管理员设置 / 卸载）。
  // 非 Windows 平台由主进程返回 not-supported；此处只在桥面缺失（旧构建/浏览器调试）时诚实降级。
  sandboxWindowsPlan: () => (window.mjcode?.sandboxWindowsPlan
    ? window.mjcode.sandboxWindowsPlan()
    : Promise.resolve({ ok: false, supported: false, error: 'no-bridge' })),
  sandboxWindowsSetup: () => (window.mjcode?.sandboxWindowsSetup
    ? window.mjcode.sandboxWindowsSetup({})
    : Promise.resolve({ ok: false, error: 'no-bridge' })),
  sandboxWindowsTeardown: () => (window.mjcode?.sandboxWindowsTeardown
    ? window.mjcode.sandboxWindowsTeardown({})
    : Promise.resolve({ ok: false, error: 'no-bridge' })),
};
