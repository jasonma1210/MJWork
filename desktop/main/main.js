const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const { writeFileDurable } = require('./data/durableWrite');
const { AsyncLocalStorage } = require('async_hooks');
// X14：写通道载荷边界校验（形状与上限，不判业务语义）——只在 main.js 直连的写通道上用
const guard = require('./ipc/payloadGuard');

// ── D2（2026-10-16）：任务写通道（tasks:*）载荷契约 ──
// 契约本身仍是 shared-ipc/taskPayloads.mjs（zod，动态 import + ready 门）；X14 批次把 tasks:*
// 的 IPC 注册整体搬到 main/ipc/tasks.js（拆分理由是模块边界，不是行数告急——见第 1133 行附近
// 对 max-lines 口径的说明：该门禁按去空行注释的 code 行数算，raw 与它差约 400 行），
// 校验入口 validateTaskPayload 随之搬走，此处不再保留副本。

let mainWindow;

// ── N5 rootExecution 统一取消的运行上下文（2026-10-16）──
// runScope：agentRunner 的工具 handler 全部在 { runId } 上下文内执行——
//   requestApproval 据此把挂起审批挂到 runId（运行取消 → cancelApprovalsForRun 统一撤下）；
//   exec.js 据此把 shell 子进程注册到 runId（运行取消 → killChildrenForRun 终止子进程）。
const runScope = new AsyncLocalStorage();
// P0-1：运行级子进程注册表（单一事实来源，main/childRegistry.js）——
// initToolExec（工具层）与 initAgentRunner（编排/子代理）共用，取消运行时整组杀灭
const childRegistry = require('./childRegistry').createChildRegistry();

// ═══════════════════════════════════════════
//  MODEL SECRETS（仅主进程持有，严禁流向渲染层）
// ═══════════════════════════════════════════
// 服务端地址三级解析：设置页偏好（server.apiBase）→ env MJ_SERVER_API → 默认本机 3001。
// 打包版从 Finder 启动拿不到 shell env，此前写死 localhost:3001 → server（Spring Boot）没跑时
// 服务端数据（共享模型/登录/审计）全离线且无法配置远程地址；现可在设置-通用里改。
const MJ_SERVER_DEFAULT = 'http://localhost:3001/api';
function serverBase() {
  const pref = localStore?.getPreference?.('server.apiBase');
  return String(pref || process.env.MJ_SERVER_API || MJ_SERVER_DEFAULT).replace(/\/+$/, '');
}
const secrets = new Map(); // `${isGlobal ? 'g' : 'u'}:${id}` -> { api_key, base_url }
let secretsInFlight = null; // 凭证拉取进行中的 promise（去重用）
const activeChats = new Set(); // 进行中的 chat AbortController

// ── 审批中心（分级确认 + 规则记忆）──
const approval = require('./approval');
// P0-A：Web 检索/抓取工具（含 SSRF 防护、HTML 转文本、超时与体积上限）
const webTools = require('./webTools');
// 本地定时任务调度器（Bug2：到点自动执行提示词，离线可用）
const scheduler = require('./scheduler');
const APPROVAL_RULES_FILE = () => path.join(app.getPath('userData'), 'approval-rules.json');
let alwaysRules = [];        // 「始终允许」：持久化
const conversationRules = []; // 「本对话同类」：进程内存

try {
  alwaysRules = JSON.parse(fs.readFileSync(APPROVAL_RULES_FILE(), 'utf8'));
  if (!Array.isArray(alwaysRules)) alwaysRules = [];
} catch (e) {
  alwaysRules = []; // 首次启动
}

function saveAlwaysRules() {
  try {
    // P0-持久化（2026-10-16）：原为裸 writeFileSync（无 tmp+rename、无 fsync）。
    // 审批规则写坏的后果是「用户设过的白名单消失」⇒ 同样的操作开始反复弹审批，
    // 或更糟：曾拒绝过的模式不再被拒绝。改走 writeFileDurable。
    const res = writeFileDurable(APPROVAL_RULES_FILE(), JSON.stringify(alwaysRules, null, 2));
    if (!res.ok) console.warn('[approval] 规则持久化失败:', res.error);
  } catch (e) {
    console.warn('[approval] 规则持久化异常:', e.message);
  }
}

// 向渲染层发起审批，返回 'once' | 'conversation' | 'always' | 'deny'
// P0-2：审批响应按 approvalId 精确分发。原实现 ipcMain.once 共享一条无 id 通道，
// 多工具并发审批时第一个响应会被任一等待者消费，决策可能张冠李戴（把「允许」发给更危险的命令）。
// P1-4：approvalReasonOf/denialText——拒绝理由取回与文案（单一事实来源在 approvalChannel.js）
// 差集 A：initDiffCommentChannel——diff 行内评论存储（挂 localStore 线程）
const { ApprovalChannel, approvalReasonOf, denialText, initDiffCommentChannel } = require('./approvalChannel');
const approvalChannel = new ApprovalChannel({ timeoutMs: 120000 });
// 模型形状转换（扁平形 ⇄ 嵌套形）：全项目唯一事实来源，见 modelShape.js 顶部事故背景
const { toAgentModel, toChatRequest, resolveModelRef } = require('./modelShape');

// 审批结束广播：让渲染层撤下对应卡片。
// 没有这条通道时，主进程侧 pending 一旦因超时消失，UI 卡片却仍挂着——用户事后点击
// 会命中「无法匹配的审批响应」。并发（自动 DAG 多 Worker 同时申请）下尤其明显。
function broadcastApprovalEnd(approvalId, reason) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tool:approval-end', { approvalId, reason });
    }
  } catch { /* 窗口已销毁时无需广播 */ }
}

// P0-5（2026-10-22）：审批归属解析——runId → 发起它的会话（实现见 approvalOrigin.js）。
// 用 getter 延迟求值：agentRunner / localStore 都在本文件下方才就绪，而审批随时可能发生。
const resolveApprovalOrigin = require('./approvalOrigin').createApprovalOriginResolver({
  getAgentRunner: () => agentRunner,
  getLocalStore: () => localStore,
});

function requestApproval(tool, args) {
  const summary = approval.approvalSummary(tool, args);
  const approvalId = approvalChannel.nextId();
  // N5：审批挂到发起它的运行（AsyncLocalStorage 上下文由 agentRunner 的 handler 包装注入），
  // 运行取消时 cancelApprovalsForRun 统一撤下（rootExecution 统一取消之「撤审批」）。
  const waitP = approvalChannel.wait(approvalId, broadcastApprovalEnd, runScope.getStore()?.runId || null);
  // P0-5：无可用窗口（启动早期 / 窗口已销毁）无法征求用户 → fail-closed 按 deny 收尾，
  // 不再对 mainWindow.webContents 裸解引用（IPC rejection 会把工具循环打进不可诊断态）
  const win = mainWindow && (typeof mainWindow.isDestroyed !== 'function' || !mainWindow.isDestroyed()) ? mainWindow : null;
  if (!win) {
    console.warn(`[approval] 无可用窗口，审批按 deny 收尾（tool=${tool}）`);
    approvalChannel.dispatch(approvalId, 'deny');
    return waitP;
  }
  // V21：审批卡需显示请求来源的工作根——cwd 随摘要下发（无 cwd 时不带该字段）
  // P0-5：同时带上发起会话的归属（threadId/threadTitle），供审批卡标注「来自哪个会话」，
  // 并让渲染层把 awaiting_approval 写到**那个**会话而不是当前正在看的会话。
  win.webContents.send('tool:approval-request', {
    approvalId, tool, rememberable: approval.isRememberable(tool),
    ...(args?.cwd ? { cwd: args.cwd } : {}), ...summary,
    ...resolveApprovalOrigin(runScope.getStore()?.runId || null),
  });
  return waitP;
}

// 全局唯一监听器：按 approvalId 分发（替代原先每次请求注册一次的 ipcMain.once）
ipcMain.on('tool:approval-response', (_, payload) => {
  const hasId = payload && typeof payload === 'object';
  const approvalId = hasId ? payload.approvalId : null;
  const decision = hasId ? payload.decision : payload;
  // P1-4：用户可选的决策理由随决议回传（无理由时行为不变）
  const reason = hasId ? payload.reason : undefined;
  const dispatched = approvalId != null
    ? approvalChannel.dispatch(approvalId, decision, reason)
    : approvalChannel.dispatchLegacy(approvalId, decision); // P2-3：无 id 响应一律拒绝并告警
  if (!dispatched) console.warn('[approval] 收到无法匹配的审批响应，已忽略（防串扰）');
});

function applyApprovalDecision(decision, tool, args, conversationId) {
  if (decision === 'conversation') {
    conversationRules.push({ tool, pattern: approval.approvalTarget(tool, args), conversationId });
  } else if (decision === 'always') {
    alwaysRules.push({ tool, pattern: approval.approvalTarget(tool, args), scope: 'always', createdAt: Date.now() });
    saveAlwaysRules();
  }
}

// A7：「始终允许」规则必须可见可撤销 —— 列表 + 删除 IPC
ipcMain.handle('approval:listRules', async () => ({
  ok: true,
  rules: alwaysRules.map((r, index) => ({
    id: index,
    tool: r.tool,
    pattern: r.pattern,
    level: approval.toolLevel(r.tool, r.tool === 'shell' ? { command: r.pattern } : { path: r.pattern }) || 'L2',
    createdAt: r.createdAt || null,
  })),
}));
ipcMain.handle('approval:deleteRule', async (_, { id }) => {
  if (typeof id !== 'number' || !alwaysRules[id]) return { ok: false, error: '规则不存在' };
  alwaysRules.splice(id, 1);
  saveAlwaysRules();
  return { ok: true };
});

// ── 审计日志（工具执行脱敏上报服务端）──
let authToken = '';

// T2-1：沙箱（Seatbelt/bwrap/Windows）与写路径白名单守卫现由 main/tools/exec.js 直接使用，
// main.js 不再持有引用（审批中心与 IPC 接线仍在本文件）。

// ── 桌面端功能开关（战略收敛：默认冻结协同/云端/小程序，聚焦桌面端单点）──
const { loadFeatureFlags } = require('./featureFlags');
const featureFlags = loadFeatureFlags(process.env);
// T2-1：SKILL.md 兼容层与 IDE 跳转 IPC 已随生态域拆出 main/ipc/ecosystem.js
// T2-1：本地项目工作区/worktree IPC 已拆出 main/ipc/project.js
// 统一降级日志原语（区分「服务端不可达」与真错误）
const degrade = require('./degrade');

// ── 本地优先数据层（离线模式）──
const { LocalStore } = require('./localStore');
// P1-1：无人值守路径的审批/沙箱档来源（用户设置），与交互 run 的 payload 档严格分开
const approvalSettings = require('./approvalSettings');
const { CredentialCrypto } = require('./credentialCrypto');
// 自定义模型配置文件（对标 WorkBuddy models.json）：~/.mjcode/models.json → providers 同步
const modelsFile = require('./modelsFile');
let localStore = null;   // whenReady 后初始化
let credentialCrypto = null; // 凭证加密双轨：safeStorage 首选，不可用降级文件密钥 AES-GCM（打包版真机事故）
const localVault = new Map(); // 本地 provider id -> { api_key, base_url }（解密后的内存态）

// 统一凭证解析（本地优先）：全局共享 g: → 本机保险库 → 服务端私有 u:
// 渲染层对服务端 provider 的 id 加 s 前缀做命名空间隔离，避免与本机 id 冲突；此处剥离后命中 u: 轨道
function resolveSecret(providerId, isGlobal = false) {
  if (isGlobal) return secrets.get(`g:${providerId}`);
  const local = localVault.get(Number(providerId));
  if (local) return local;
  return secrets.get(`u:${String(providerId ?? '').replace(/^s/, '')}`);
}

function initLocalStore() {
  try {
    localStore = new LocalStore(app.getPath('userData'));
    // 凭证加密双轨（credentialCrypto.js）：safeStorage 不可用（打包版 macOS 27 真机复现）
    // 时降级文件密钥 AES-256-GCM——凭证仍可保存，保护级别显式降级并留痕
    credentialCrypto = new CredentialCrypto(app.getPath('userData'), safeStorage);
    // web_search 配置读取/写入同样通过 credentialCrypto 加密，P0-20 不得留明文旁路。
    webTools.setLocalStore(localStore, credentialCrypto);
    if (credentialCrypto.scheme === 'file-key') {
      console.warn('[local] safeStorage 不可用，凭证改用本地文件密钥加密（userData/credential.key，0600）');
    }
    for (const p of localStore.data.providers) {
      try {
        const key = credentialCrypto.decrypt(p.keyEncrypted);
        localVault.set(p.id, { api_key: key, base_url: p.base_url });
      } catch (e) {
        console.warn('[local] 凭证解密失败:', p.id, e.message);
      }
    }
    // 配置文件来源的模型（~/.mjcode/models.json）：Key 不走 keyEncrypted 解密回填，
    // 由 sync 直接注入 vault（文件是事实来源，见 syncModelsFile）
    for (const p of localStore.data.providers) {
      if (p.source === 'file') localVault.delete(p.id); // 先清，随后 sync 重注（文件可能已删条目）
    }
    migrateLocalModelsToFile(); // 旧 UI 模型 → 配置文件（仅文件缺失/仍是模板时触发，见下）
    syncModelsFile({ reason: 'startup' });
    console.log(`[local] 本地数据层就绪：${localStore.listThreads().length} 线程 / ${localStore.listProviders().length} 私有服务（加密轨：${credentialCrypto.scheme}）`);
  } catch (err) {
    console.error('[local] 初始化失败:', err);
  }
}

// T2-1：本地数据域已拆出 main/ipc/localData.js（只搬移不改行为）——
// models.json 同步/写回 + 会话·消息·provider·项目·偏好·记忆 IPC。
// localStore/credentialCrypto/memory* 在 whenReady 后才存在，经 getter 注入；localVault 为共享 Map 引用。
const localDataIpc = require('./ipc/localData');
localDataIpc.initLocalDataIpc({
  getLocalStore: () => localStore,
  getCredentialCrypto: () => credentialCrypto,
  localVault,
  serverBase,
  MJ_SERVER_DEFAULT,
  getMemoryManager: () => memoryManager,
  getMemoryScheduler: () => memoryScheduler,
  // M3：记忆文件双通道（打开项目时同步 .mjcode/ 记忆文件）
  getMemoryFileSync: () => memoryFileSync,
});
const { syncModelsFile, maybeSyncModelsFile, migrateLocalModelsToFile } = localDataIpc;

// 差集 A：diff 行内评论存储——评论挂到 localStore 的线程对象（t.diffComments）随
// local-data.json 持久化；localStore 未就绪时 getter 返回 null，内部退化为进程内 Map。
initDiffCommentChannel({ getLocalStore: () => localStore });
// P0-8c：开机自启 IPC（实现抽到 main/autoLaunch.js——系统能力与调度器解耦，与行数无关；
// 理由与 autoLaunch.js 文件头保持一致，别再写成「逼近 max-lines 门禁」）
require('./autoLaunch').initAutoLaunchIpc({ getStore: () => localStore });


// ═══════════════════════════════════════════
//  P3-1/P3-5：ResourceQuotaCenter——全局唯一资源额度中心（槽位预占 + 前后台隔离 + 熔断节流）
//  fg = 用户会话 / Worker / 编排 / 定时任务（一切用户可感知请求）；bg = 记忆后台作业。
//  接入点：chatStreamOnce（流式）/ scheduledAgentChat（非流式，Worker 与编排同源）统一占用 fg 槽位，
//  MemoryBgScheduler 经 bgGate 让路。快照经 quota:snapshot 供渲染层（AgentDock 资源行）轮询。
// ═══════════════════════════════════════════
const { ResourceQuotaCenter } = require('./resourceQuotaCenter');
const quota = new ResourceQuotaCenter({ providerLimit: 8, fgReserve: 2 });
ipcMain.handle('quota:snapshot', () => quota.snapshot());
// Phase 3-1：Agent 任务断点持久化（预算熔断 = 暂停；「继续」时渲染层取回断点摘要注入）
const checkpointStore = require('./checkpointStore');
checkpointStore.initCheckpointStore(app.getPath('userData'));
// T0-5：本地结构化运行 trace（userData/traces/<runId>.jsonl，不上报；供排障与诊断包）
const runTrace = require('./runTrace');
runTrace.initRunTrace(app.getPath('userData'));
// P2-8 / V-L1：V 层判定落盘目录（userData/eval/verdicts-YYYYMMDD.jsonl，仅元数据，不上报）
require('./verifyRun').initVerifyRun(app.getPath('userData'));
// 定时通道的 V 层装配（L1 全量 + L3 风险门/抽样 + 无人值守 fail-closed）
const { createScheduledVerify, createScheduledL3Target } = require('./scheduledVerify');
// 对外动作闸门（产物形态即校验）：默认拦截提交/推送/MCP/破坏性 shell，转成「待确认动作清单」
const { createScheduledGuard } = require('./scheduledGuard');
// 待确认动作的重放执行器（清单的一键执行）
const { createScheduledReplay } = require('./scheduledReplay');
// 事件触发入口（本地回环 HTTP，默认不监听）
const { createScheduledEventServer } = require('./scheduledEventServer');
// L3 评审目标工厂：延迟到调用时解析（配置可变，且启动早期 model 尚未就绪）
const scheduledL3Target = createScheduledL3Target({
  resolveModel: () => scheduler.getModel(),
  getModelOverrides: () => localStore?.getPreference('model_overrides') || {},
  chatOnce: (p, m) => scheduledChatOnce(p, m),
});

// P1-5：用户自定义生命周期 hooks（preToolUse / postToolUse）——配置落 userData/hooks.json。
// 三条运行通道（交互会话 / Worker / 定时任务）共用同一个 runner：用户写一次规则，全域一致生效。
const { createToolHookRunner } = require('./toolHooks');
const toolHooks = createToolHookRunner({ filePath: path.join(app.getPath('userData'), 'hooks.json') });

// T2-5：本地崩溃/异常聚合（结构化 JSONL + trace 尾部 + 渲染层错误转发 + 原生崩溃 dump）。
// 全部落本机不上传；agentRunner 在本文件后段声明，经 getter 延迟读取（异常发生才调用）。
const { initDiagnostics, reportError, startCrashReporter } = require('./diagnostics');
initDiagnostics({ app, getActiveRunIds: () => agentRunner.getActiveRunIds(), readTraceEvents: (rid) => runTrace.readTraceEvents(rid) });
startCrashReporter(app);
// T2-6：诊断包一键导出（设置页触发；审计/崩溃/trace/日志/脱敏配置打 zip，凭证一律剔除）
const { registerDiagExportIpc } = require('./diagExport');
registerDiagExportIpc();
// T3-1：大消息 IPC 可靠传输——超限工具结果落临时文件+句柄分页（agentRunner 发送前卸载）；
// 大文件预览改 mjpreview:// 流式协议（scheme 特权注册必须早于 app ready）
const bigPayload = require('./bigPayload');
// 第八轮 B-13：工具长输出落盘目录（userData/tool-outputs + TTL 清扫）
const toolOutputs = require('./toolOutputs');
// T1（2026-10-17）：流式三层守卫（首字节 / 空闲 / 单轮总时长）。
// 替代原来的 AbortSignal.timeout(125000)——那是「总时长」语义，会把推理模型
// （mimo 等思考阶段长时间无正文）误判成「无响应」并整轮杀掉。
const { createStreamGuard, streamTimeoutMessage, reportSlowTtfb } = require('./streamGuard');
// T6：三层超时可在设置页调整（用户设置 > 环境变量 > 默认），每次请求现读，改完立即生效
const streamSettings = require('./streamSettings');
const resolveStreamTimeouts = () => streamSettings.getStreamTimeouts();
// T6：注入 localStore getter（此时 localStore 变量已声明，whenReady 后才赋值）
streamSettings.initStreamSettings({ getLocalStore: () => localStore });
const { createScheduledChannels } = require('./scheduledChannels');
bigPayload.initBigPayload({ dataDir: app.getPath('userData') });
bigPayload.registerBigPayloadIpc(ipcMain);
// 第八轮 B-13：工具长输出的落盘目录（会话级、可回收）。
// 必须早于任何 runAgent 初始化：引擎读 `MJCODE_TOOL_OUTPUT_DIR` 决定落盘位置，
// 而子进程继承父进程环境变量——在这里设一次，in-process 与子进程两条路径同值。
try {
  toolOutputs.initToolOutputs({ dataDir: app.getPath('userData') });
} catch (e) {
  // 目录不可用不得阻断启动：引擎会回落到系统临时目录（旧行为），只是「会话内可失效」的风险回来。
  console.warn('[toolOutputs] 初始化失败（工具长输出回落系统临时目录）:', e?.message || e);
}
const previewScheme = require('./previewScheme');
previewScheme.registerPreviewSchemePrivileges();
ipcMain.handle('checkpoint:get', (_, threadKey) => checkpointStore.getCheckpoint(threadKey));
ipcMain.handle('checkpoint:clear', (_, threadKey) => {
  // X14：threadKey 直接当断点存储的键（对象/数组会变成 "[object Object]" 这类键，
  // 清掉的不是用户以为的那个会话）；可缺省（清全部调用方不传），故 optional + 长度上限
  try {
    guard.assertStrings({ threadKey }, { threadKey: { max: 256, optional: true, allowEmpty: true } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: checkpointStore.clearCheckpoint(threadKey) };
});
// Phase 3-4：token 仪表盘数据源（最近一次运行的逐轮用量快照）
ipcMain.handle('agent:token/state', () => agentRunner.getTokenState());
// P3-4：本地后端探测（Ollama）——启动时一次 + 每 5 分钟复探；结果进快照供渲染层展示
quota.detectLocalBackend().catch(() => {});
setInterval(() => { quota.detectLocalBackend().catch(() => {}); }, 5 * 60 * 1000).unref?.();


// T2-1：审计域已拆出 main/audit/auditLog.js（只搬移不改行为）。
// 33 处调用点仍以同名 audit() 使用；authToken 归属本文件（model:getSecrets 成功后赋值），
// 经 getter 注入供审计读取；serverBase 同源。
const { initAudit, audit } = require('./audit/auditLog');
initAudit({ getAuthToken: () => authToken, serverBase });

// T2-1：生态与杂项 IPC 域已拆出 main/ipc/ecosystem.js（只搬移不改行为）——
// flags/协同/skillCompat/IDE/ecosystem/websearch。audit 与 SKILLS_DIR 经注入保持同源。
const { initEcosystemIpc } = require('./ipc/ecosystem');
initEcosystemIpc({ getLocalStore: () => localStore, getCredentialCrypto: () => credentialCrypto, featureFlags, audit, getSkillsDir: () => SKILLS_DIR() });

ipcMain.handle('model:getSecrets', async (_, { token }) => {
  if (!token) return { ok: false, error: 'NO_TOKEN' };
  // in-flight 去重：并发窗口内复用同一请求，避免重复触发服务端探测
  if (secretsInFlight) return secretsInFlight;
  secretsInFlight = (async () => {
    const headers = { Authorization: `Bearer ${token}` };
    let count = 0;
    try {
      const [userRes, globalRes] = await Promise.all([
        fetch(`${serverBase()}/providers/secrets`, { headers, signal: AbortSignal.timeout(5000) }),
        fetch(`${serverBase()}/global/providers/secrets`, { headers, signal: AbortSignal.timeout(5000) }),
      ]);
      if (userRes.ok) {
        for (const p of await userRes.json()) {
          secrets.set(`u:${p.id}`, { api_key: p.api_key, base_url: p.base_url });
          count++;
        }
      } else {
        console.error(`[secrets] 私有凭证拉取失败：HTTP ${userRes.status}`);
      }
      if (globalRes.ok) {
        for (const p of await globalRes.json()) {
          secrets.set(`g:${p.id}`, { api_key: p.api_key, base_url: p.base_url });
          count++;
        }
      } else {
        console.error(`[secrets] 全局凭证拉取失败：HTTP ${globalRes.status}`);
      }
      // 仅在拉取成功后开门：失败不应让 audit 全量穿透
      authToken = token;
      degrade.markHealthy('secrets');
      return { ok: true, count };
    } catch (err) {
      degrade.report('secrets', err);
      return { ok: false, error: err.message };
    } finally {
      secretsInFlight = null;
    }
  })();
  return secretsInFlight;
});

// T2-1：窗口生命周期域已拆出 main/lifecycle/window.js（只搬移不改行为）——
// 窗口状态持久化 / 主窗口创建 / 打包版 console tee。mainWindow 归属本文件，经 getter/setter 注入。
const windowLifecycle = require('./lifecycle/window');
// C2：进程级崩溃守卫（render-process-gone / child-process-gone / unresponsive）
const { createCrashGuard } = require('./lifecycle/crashGuard');
windowLifecycle.init({ getMainWindow: () => mainWindow, setMainWindow: (w) => { mainWindow = w; } });
const { createWindow, setupFileLogging } = windowLifecycle;

// C2（2026-10-17）：进程级崩溃的可观测性 + 自愈。
// 此前全仓没有 render-process-gone / child-process-gone / unresponsive 监听：
// JS 层异常有 window.onerror → diag:report 兜底，但渲染进程**整体崩掉**（OOM / GPU / 被杀）
// 时渲染层自己报不了，主进程也没人听，现场只剩「白屏 + 无证据」。
// 自动 reload 依赖 local-data.json 里的会话数据，重载不丢历史。
const crashGuard = createCrashGuard({
  reportError,
  getMainWindow: () => mainWindow,
});
crashGuard.attach(app);
// 渲染层启动时领取「上次崩过」的通知（取完即清）：App 首帧就会问，必须早注册
ipcMain.handle('app:crash-notice', () => crashGuard.takeNotices());
// T6：设置页读取三层超时（生效值 / 来源 / 可调区间 / 默认值）。
// 写入复用既有 local:prefs/set（key = stream_timeouts），主进程每次请求现读，改完立即生效。
ipcMain.handle('app:stream-timeouts', () => streamSettings.getStreamSettingsView());

// 单实例锁：第二个实例启动时聚焦已有窗口
// ⚠️ hasMainLock 是**退出落盘的总开关**（2026-10-18 数据丢失事故修复）：
// 抢锁失败的进程从未执行 whenReady，内存里的 localStore/taskStore/scheduler store 全是
// 「未加载」的空态。此时任何退出落盘都会把用户数据覆盖成空库。
// 事故链：第二实例启动 → 抢锁失败 → app.quit() → 顶层注册的 will-quit 照样执行 →
// scheduler.persist() 用 { tasks: [], runs: [] } 覆盖 scheduled-tasks.json
// → 下次启动读到的是**合法 JSON 空库**，连「损坏」告警都不会有 → 用户看到定时任务全部消失。
// 故：抢锁失败者不参与任何退出落盘（will-quit 首行直接 return）。
const hasMainLock = app.requestSingleInstanceLock();
if (!hasMainLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    setupFileLogging();
    // 2026-10-18 ⑦：启动横幅——给启动日志一个**时间戳 + 版本锚点**。
    // 此前整段启动日志无时间戳、无版本行，用户上报日志时无法对齐到具体构建与时刻。
    // app.getVersion 在部分测试宿主的 mock app 上不存在 → 防御式取值，缺失降级为 unknown。
    const appVer = typeof app.getVersion === 'function' ? app.getVersion() : 'unknown';
    console.log(`[startup] ${new Date().toISOString()} MJCode v${appVer} · electron ${process.versions.electron} · node ${process.versions.node} · ${process.platform}-${process.arch}`);
    createWindow();
    crashGuard.attachWindow(mainWindow); // C2：unresponsive / responsive 只存在于 BrowserWindow
    previewScheme.initPreviewScheme(); // T3-1：流式预览协议处理器（必须 ready 后注册）
    // P1-N：更新检查延迟 10s 自动触发（initUpdater 仍保留供手动检查即时初始化）
    updater.scheduleAutoUpdateCheck();
    initLocalStore();
    initTaskOrchestration(); // P1：任务编排子系统（SQLite 队列 + Worker 池 + 断点恢复）
    reconnectMcpServers(); // 启动自动重连已持久化的 MCP 服务
    // 定时任务：IPC + 调度循环
    // P0-D：执行通道升级为 Agent（工具循环+审批+沙箱）；chatOnce 保留为无 Agent 通道时的回落
    scheduler.registerIpc();
    scheduler.startScheduler({
      chatOnce: scheduledChatOnce,
      runAgentTask: runScheduledAgentTask,
      // 清单的一键执行（幂等 + 重放前重新校验）
      replayAction: replayScheduledAction,
      notify: (payload) => {
        for (const w of BrowserWindow.getAllWindows()) {
          try { w.webContents.send('scheduled:changed', payload); } catch { /* 窗口已销毁 */ }
        }
      },
    });
    // 事件入口（默认不监听；MJ_SCHEDULED_EVENT_PORT 显式开启，仅绑 127.0.0.1 + token）
    createScheduledEventServer({ ingest: (p) => scheduler.ingestEvent(p) }).start();
  });

// T2-5：崩溃/异常聚合收口升级（原 M3-5 crash.log 纯文本 → 结构化 JSONL）：
// 主进程未捕获异常统一进 main/diagnostics.js——userData/diagnostics/crash-YYYYMMDD.jsonl，
// 每条含 ts/kind/stack + 活跃 runId + 该 run 的 trace 尾部（T0-5），只落本机不上传。
process.on('uncaughtException', (err) => {
  reportError('uncaughtException', err);
});

// P0-C 修复：补unhandledRejection 兜底。
// 事故背景：此前只挂了 uncaughtException，而 Promise 拒绝**不会**触发它——
// Node/Electron 默认在unhandledRejection 后终止进程。于是任何一处漏接的
// `.catch()`（典型是异步 IIFE、定时器回调、事件监听里的 async 函数）都会让
// 整个桌面应用直接退出，用户正在跑的全部 Agent 任务与对话一起丢失，且无任何提示。
// Node 15+ 可用 process.on('unhandledRejection') 覆盖该行为。
process.on('unhandledRejection', (reason) => {
  reportError('unhandledRejection', reason);
  console.error('[main]未捕获的 Promise 拒绝（已兜底，未退出进程）:', String(reason?.message || reason || ''));
});
}

// ── 自动更新（electron-updater，仅打包态生效；延迟 require 避免非 electron 环境崩溃）──
// T2-1：自动更新域已拆出 main/updater/index.js（只搬移不改行为）。
// IPC 注册与状态推送目标（主窗口）经 getMainWindow getter 注入；延迟检查由 whenReady 接线。
const updater = require('./updater');
updater.init({ getMainWindow: () => mainWindow });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// P0-1：退出前强制落盘合并窗口内未写盘的内存变更（消息/状态）
// P1-1：同时清理 MCP 子进程，避免孤儿进程占用端口导致下次启动握手失败
app.on('will-quit', () => {
  // 抢锁失败的实例只负责退出，绝不碰磁盘（详见 hasMainLock 处的注释）
  if (!hasMainLock) return;
  try { localStore?.flushSync(); } catch (e) { console.warn('[local] 退出刷盘失败:', e.message); }
  try { taskStore?.db?.flush?.(); } catch (e) { console.warn('[tasks] 退出刷盘失败:', e.message); }
  try { scheduler?.persist?.(); } catch (e) { console.warn('[scheduled] 退出刷盘失败:', e.message); }
  try {
    const flushResults = require('./data/intentLogRegistry').flushAllIntentLogs();
    if (flushResults.some((result) => !result.ok || !result.durable)) {
      console.error('[intentLog] 退出前仍有意图日志未确认 durable:', JSON.stringify(flushResults));
    }
  } catch (e) { console.warn('[intentLog] 退出刷盘失败:', e.message); }
  try { memoryScheduler?.stop(); } catch { /* 调度器已停 */ }
  // M3：退出兜底——把防抖队列里挂起的记忆文件导出立即落盘（避免最近变更丢失）
  try { memoryFileSync?.flushAll(); } catch (e) { console.warn('[memoryFile] 退出刷盘失败:', e.message); }
  try { approvalChannel.disposeAll(); } catch (e) { console.warn('[approval] 退出清理异常:', e.message); }
  try { cuaApprovalChannel.disposeAll(); } catch (e) { console.warn('[cuaApproval] 退出清理异常:', e.message); }
  try { killAllMcpServers(); } catch (e) { console.warn('[MCP] 退出清理异常:', e.message); }
  // T4-1：退出前杀掉全部浏览器子进程（Playwright 驱动+浏览器不留孤儿）
  try { require('./browserTools').disposeAll(); } catch (e) { console.warn('[browser] 退出清理异常:', e.message); }
  // T4-2：关闭 Chrome 接管中继（断开扩展连接，端口不残留）
  try { require('./chromeRelay/server').close(); } catch (e) { console.warn('[chromeRelay] 退出清理异常:', e.message); }
  // 期 3：关闭原生工具持有的 SQLite 连接（flush 落盘）
  try { nativeTools.disposeNativeTools(); } catch (e) { console.warn('[nativeTools] 退出清理异常:', e.message); }
  // G-doc：销毁残留的 PDF 隐藏渲染窗口（避免退出时残留无主窗口）
  try { docTools.disposeDocTools(); } catch (e) { console.warn('[docTools] 退出清理异常:', e.message); }
});
// SIGTERM/SIGINT/SIGHUP 优雅退出：pkill/终端关闭/Ctrl+C 也会走 will-quit 落盘（事故教训：强杀导致任务静默中断且丢状态）
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    try { console.log(`[main] 收到 ${sig}，优雅退出（落盘后关闭）`); } catch { /* 日志尽力而为 */ }
    try { app.quit(); } catch { process.exit(0); }
    setTimeout(() => process.exit(0), 2000).unref(); // 兜底：2s 内必须退出
  });
}
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ═══════════════════════════════════════════
//  AGENT TOOL EXECUTION LAYER
// ═══════════════════════════════════════════
// T2-1：工具执行层已拆出 main/tools/exec.js（只搬移不改行为）——
// shell/读写/预览/list_dir·grep·glob/git 全部工具实现与 IPC 注册。
// 审批中心（requestApproval/applyApprovalDecision/alwaysRules/conversationRules）归属本文件，经注入同源。
const toolExec = require('./tools/exec');
toolExec.initToolExec({
  // 无人值守审批终结器：定时/Worker 通道需要的审批**立即 deny**，不等 approvalChannel 的 120s 超时（交互式原样透传）
  requestApproval: require('./scheduledGuard').unattendedApproval(requestApproval), applyApprovalDecision, getAlwaysRules: () => alwaysRules, conversationRules,
  // N2 cwd 信任契约：漏传 cwd 的工具调用落到「最近打开的项目目录」（无项目则 HOME），
  // 绝不回主进程 cwd（打包版=应用安装目录，既无意义又危险）；结果以 cwdFallback 标记、审计留痕。
  getDefaultCwd: () => {
    try {
      const projects = localStore?.listProjects?.() || [];
      const recent = projects.find((p) => p.path && fs.existsSync(p.path));
      return recent?.path || app.getPath('home');
    } catch { return app.getPath('home'); }
  },
  // P0-1：shell/seatbelt/bwrap/git 子进程注册到 runId（缺失即抛错由 exec.js 保证接线存在）
  registerChild: (child) => childRegistry.register(runScope.getStore()?.runId, child),
  // 期 3：能力降级开关——写工具（write_file/edit_file/apply_patch）受治理「文件能力」档约束
  // （read-only 档下 fail-closed 拒绝一切写入，与 nativeTools.sqlite 写路径同一开关口径）。
  // 懒取（仅运行时调用，故可引用下方才 require 的 mcpIpc）。
  getGovernance: () => mcpIpc.getGovernance(),
});
const { toolShell, toolReadFile, runWriteTool, toolListDir, toolGrep, toolGlob, toolGitStatus, toolGitDiff, toolGitLog, toolGitBranch, toolGitCommit, toolGitAdd, shellEnv, runGit } = toolExec;

// T4-1：Browser Use——Playwright 下沉独立子进程（T3-6 驻留模式），主进程只做编排/审批/审计。
// 六工具（navigate/click/fill/select/screenshot/extract）经 browserTools 挂进会话 toolHandlers；
// click/fill/select 恒逐次审批，navigate/screenshot/extract 走 L3 可规则豁免。
const browserTools = require('./browserTools');
browserTools.initBrowserTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  userDataDir: app.getPath('userData'),
});

// T4-2：Chrome 接管——本地 WebSocket 中继 + 扩展（CDP）操作用户真实浏览器。
// 中继只监听 127.0.0.1；每次连接逐次弹审批卡（fail-closed：拒绝/超时即断开，授权不沉淀）。
// 端口占用等启动失败仅降级（chrome_* 工具报未连接），不影响主程序。
const chromeRelay = require('./chromeRelay/server');
chromeRelay.initChromeRelay({
  requestApproval,
  port: Number(process.env.MJ_CHROME_RELAY_PORT) || undefined,
});
chromeRelay.start();
const chromeTools = require('./chromeTools');
chromeTools.initChromeTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  userDataDir: app.getPath('userData'),
  relay: chromeRelay,
});

// T4-7：Code Mode——JavaScript 代码执行下沉独立子进程（持久 vm 上下文 = cell 状态载体）。
// 每对话一个代码进程（30 分钟闲置回收）；子进程死亡即状态丢失、不透明重启（见 codeProcess/host.js）。
// 普通代码 L3 可规则豁免；危险代码（child_process/rm -rf）由 approval 判 L1 恒逐次确认。
const codeTools = require('./codeTools');
codeTools.initCodeTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  userDataDir: app.getPath('userData'),
});

// 期 3：原生内置工具层（clipboard / notify / http_request / sqlite / sandbox_code_run）——
// 本地系统能力一律原生实现，不经 MCP 连接器；代码执行走独立子进程沙盒，禁止复用宿主进程。
// 能力降级开关（文件只读/读写、沙盒网络开闭）经 getGovernance 注入（与期 2 治理偏好同源）。
const nativeTools = require('./nativeTools');
nativeTools.initNativeTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  getGovernance: () => mcpIpc.getGovernance(),
  userDataDir: app.getPath('userData'),
});

// G-doc：文档生成原生工具层（doc_create / xlsx_create / pptx_create / pdf_generate）——
// Word/Excel/PPT 用纯 JS 库本地生成，PDF 用应用自带 Chromium 排版；离线可用、输入即产出。
// 与 nativeTools 同范式：审批闸复用 approval.js 单一事实来源，写路径策略复用 writeGuard.js。
const docTools = require('./docTools');
docTools.initDocTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  getGovernance: () => mcpIpc.getGovernance(),
  userDataDir: app.getPath('userData'),
});

// G-latex：LaTeX 编译原生工具层（latex_compile，含 probeOnly 工具链体检）——
// 探测本机 tectonic / TeX Live（latexmk/xelatex/pdflatex/lualatex）并选合适引擎编译 .tex → PDF；
// 离线可用、结构化报错。审批闸复用 tools/artifactWriteGate.js 单一事实来源（与 docTools 同源）。
const latexTools = require('./latexTools');
latexTools.initLatexTools({
  requestApproval, applyApprovalDecision,
  getAlwaysRules: () => alwaysRules, conversationRules,
  getGovernance: () => mcpIpc.getGovernance(),
  userDataDir: app.getPath('userData'),
});


// T2-1：技能与插件市场域已拆出 main/ipc/plugins.js（只搬移不改行为）——
// SKILL.md 技能体系 / 插件市场（git 安装+权限双闸+签名 fail-closed）/ 网络插件发现与对话内安装。
// connectMcpServer 归属 MCP 域，经 getter 注入；SKILLS_DIR 导出供生态域接线复用。
const pluginsIpc = require('./ipc/plugins');
pluginsIpc.initPluginsIpc({ requestApproval, applyApprovalDecision, getAlwaysRules: () => alwaysRules, conversationRules, audit, getConnectMcpServer: () => connectMcpServer });
const { SKILLS_DIR, searchPluginsTool, installNetworkPlugin } = pluginsIpc;

// T2-1：项目与工作区域已拆出 main/ipc/project.js（只搬移不改行为）——
// 对话框 / 本地工作区 / 项目探测 / worktree / 磁盘快照 / 粘贴文件落盘。
const { initProjectIpc } = require('./ipc/project');
initProjectIpc({ getMainWindow: () => mainWindow, runGit });

// ── MCP 客户端（多传输：stdio + Streamable HTTP）──
// T2-1：MCP 与杂项 IPC 域已拆出 main/ipc/mcp.js（只搬移不改行为）——
// MCP 配置持久化/连接/状态 + 沙箱状态查询 + GitHub 闭环 IPC + 语音转写。
// emitTaskEvent 归属任务编排域（本文件，函数声明提升可用），经注入转发 MCP 状态事件。
const mcpIpc = require('./ipc/mcp');
// 期 2：注入 getLocalStore——治理偏好（档位/文件能力/沙盒网络）存在 localStore 偏好中，
// localStore 在 whenReady 后才非 null，故传闭包 getter（与其它偏好注入同源）。
mcpIpc.initMcpIpc({ requestApproval, applyApprovalDecision, getAlwaysRules: () => alwaysRules, conversationRules, audit, emitTaskEvent, getCredentialCrypto: () => credentialCrypto, toolHooks, getLocalStore: () => localStore });
const { connectMcpServer, callMcpTool, killAllMcpServers, reconnectMcpServers, mcpServers } = mcpIpc;
// GitHub PR 审查闭环工具仍在本文件组装（gh CLI 封装见 main/github.js）
const github = require('./github');

// P1-4：Windows OS 级沙箱的接线入口（命令清单 / 一次性管理员设置 / 卸载）。
// 非 Windows 平台返回 not-supported，绝不伪造可用性（详见 main/ipc/sandbox.js 头注释）。
const { initSandboxIpc } = require('./ipc/sandbox');
initSandboxIpc();


// ═══════════════════════════════════════════
//  MODEL PROXY (streaming, main-process direct)
//  P0-4：抽为可复用函数——model:chat IPC 与主进程 Agent 运行器（agentRunner）共用。
//  externalSignal：外部中止信号（交互式运行的 AbortController）；信号中止时级联中止在途 fetch。
//  streamTag：运行标识（runId）。带标签时 delta/reasoning 事件发 {tag,text} 对象，
//  渲染层据此把流式输出归到正确的会话（多会话并行/后台运行不串显）；无标签保持旧纯文本协议。
// ═══════════════════════════════════════════
async function chatStreamOnce({ providerId, isGlobal = false, baseUrl, messages, model, tools, reasoningEffort }, sender, externalSignal, streamTag) {
  const secret = resolveSecret(providerId, isGlobal);
  if (!secret || !secret.api_key) {
    throw new Error('KEY_MISSING: 模型凭证未加载，请在本机模型设置中重新填写 API Key');
  }
  const root = (baseUrl || secret.base_url || '').replace(/\/+$/, '');
  if (!root) throw new Error('BASE_URL_MISSING: 模型服务地址为空');
  // P3-2：fg 槽位预占（超时抛错=真过载，调用方按普通失败处理；AbortError 不计错误连击）
  const slot = await quota.acquire('fg', providerId || 'default');
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools) body.tools = tools;
  // 思考强度：仅在用户显式选择时下发（OpenAI 兼容 reasoning_effort；空值不发送，避免严格服务端 400）
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  let fullContent = '';
  let usage = null;
  const controller = new AbortController();
  activeChats.add(controller);
  // 级联中止：外部信号（一次 Agent 运行的 controller.signal）→ 本次 chat。
  // 注意必须保存 handler 引用并在 finally 里摘除：一次运行会连续发起十几次 chat，
  // 每次都往同一个 externalSignal 上挂一个 abort 监听。{ once: true } 只在**触发时**
  // 才自动摘除，运行不中止就永远留着 → 11 次后触发 MaxListenersExceededWarning，
  // 且每个闭包都持有本次请求的 controller/缓冲区，长任务下是实打实的内存泄漏。
  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  // T1：三层流式守卫（首字节 90s / 空闲 300s / 单轮总时长 15min）。
  // 语义是「多久没有动静」而不是「总共花了多久」——只要还有数据在动就一直等，
  // 真正的挂起才断。直连路径（无 externalSignal，用户手动对话）不设总时长上限：
  // 那边可能本来就是正当的长回答，硬切会把文章砍半。
  const streamTimeouts = resolveStreamTimeouts();
  const streamGuard = createStreamGuard({
    firstByteMs: streamTimeouts.firstByteMs,
    idleMs: streamTimeouts.idleMs,
    totalMs: externalSignal ? streamTimeouts.totalMs : 0,
    onFire: () => controller.abort(),
  });
  streamGuard.start();
  try {
    const res = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret.api_key}` },
      body: JSON.stringify(body),
      // 超时必须「真中断」（上层 withTimeout 只放弃等待，连接挂着则 finally 的 slot.release 不执行 → fg 槽位泄漏）。
      // 超时判定已交给 streamGuard（空闲语义），这里只负责把 abort 级联到 fetch。
      signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
    });
    streamGuard.firstByte(); // 收到响应头：首字节达成，转入空闲计时

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${res.status}: ${err.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let toolCalls = [];
    let finishReason = null; // Bug：finish_reason=length 截断时 agent 引擎据此续跑

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 任何字节到达都算「有动静」：正文 delta、reasoning_content、tool_calls 分片，
      // 以及供应商的 SSE 注释心跳行（`: keep-alive`）——全部在这一层计入。
      // 逐个字段判断容易漏（漏掉 reasoning 就会在 mimo 思考阶段被误判成挂起）。
      streamGuard.touch();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
          // 推理模型（mimo / DeepSeek-R 系）思考阶段输出 reasoning_content，
          // 此前被丢弃 → 思考全程只有「思考中...」，用户误以为 API 很慢
          if (delta?.reasoning_content) {
            sender.send('model:reasoning', streamTag ? { tag: streamTag, text: delta.reasoning_content } : delta.reasoning_content);
          }
          if (delta?.content) {
            fullContent += delta.content;
            sender.send('model:delta', streamTag ? { tag: streamTag, text: delta.content } : delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index || 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: '' } };
              if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
          if (json.usage) usage = json.usage;
        } catch (e) {
          console.warn('[model] SSE 分片解析失败:', e.message);
        }
      }
    }
    quota.reportSuccess(providerId || 'default');
    return { content: fullContent, tool_calls: toolCalls.filter(Boolean), usage, finish_reason: finishReason };
  } catch (err) {
    // 守卫触发的中断先判：必须给出「首字节没来 / 连续没动静 / 超过总上限」的可读原因，
    // 而不是一个裸 AbortError（用户会误以为是模型回答出错）。
    const fired = streamGuard.reason();
    if (fired) {
      quota.reportError(providerId || 'default');
      throw new Error(streamTimeoutMessage(fired, streamGuard.config()));
    }
    // 只有「用户主动中止」才算 aborted；守卫触发的中断走上面的错误路径
    if (err.name === 'AbortError' && externalSignal?.aborted) {
      return { aborted: true, content: fullContent, usage };
    }
    quota.reportError(providerId || 'default');
    throw err;
  } finally {
    // P2-2：主对话通道的 TTFB 告警接线——此前只有 scheduled 通道接了 reportSlowTtfb，
    // 用户手动对话（最高频路径）测到了首字节却不告警，SLO 只覆盖了次要通道。
    // 放 finally：成功/失败路径都报（未达成首字节时 ttfbMs() 为 null，reportSlowTtfb 自然跳过）。
    reportSlowTtfb(streamGuard.ttfbMs(), 'chat');
    streamGuard.stop();
    if (onExternalAbort && externalSignal?.removeEventListener) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
    activeChats.delete(controller);
    slot.release();
  }
}

// 直连聊天通道：透传 payload.streamTag 作为第 4 个位置参数（chatStreamOnce 的 streamTag），
// 带标签时 delta/reasoning 事件发 {tag,text}，渲染层据此把流式输出归到正确的会话；
// 不带标签（主会话/压缩历史等旧调用方）维持原纯文本协议，行为不变。
ipcMain.handle('model:chat', (event, payload) => chatStreamOnce(payload || {}, event.sender, undefined, payload?.streamTag));

// 中止全部进行中的 chat（停止生成）
// P0-4：同时中止主进程 Agent 运行器中挂起的交互式运行（run controller 级联中止在途 fetch）
ipcMain.handle('model:abort', async () => {
  const n = activeChats.size;
  for (const c of activeChats) c.abort();
  activeChats.clear();
  const abortedRuns = agentRunner.abortAllRuns();
  return { ok: true, aborted: n, abortedRuns };
});

// 定时任务 / 子代理的非流式通道已抽到 main/scheduledChannels.js（2026-10-17）：
// main.js 顶到 1500 行硬门禁，且它们与主交互链路（chatStreamOnce）是并列关系。
// 非流式没有 idle 可言，那边只启用「首字节 + 单轮总时长」两层。
const { scheduledChatOnce, scheduledAgentChat } = createScheduledChannels({ resolveSecret, quota });


// ═══════════════════════════════════════════
//  P0-D：定时任务 Agent 执行通道
//  此前执行通道为单轮纯文本对话（无工具），「每天跑测试并汇总」只能输出文本不能执行；
//  现复用 agent-core 引擎（工具循环 + 审批分级 + 沙箱 + 轮次预算 + 上下文压缩），
//  与前端会话共用同一套主进程工具实现（toolShell/runWriteTool/... 提取后双通道复用）。
// ═══════════════════════════════════════════
// ESM 边界：agent-core/package.json 声明 "type": "module"，其 index.js 是 ES Module，
// 而主进程是 CommonJS（desktop/package.json 无 type 字段）。此处若用 require() 会在
// **模块加载期**抛 ERR_REQUIRE_ESM —— 不是任务失败，而是整个主进程启动即崩：
// require 之后的所有 IPC 注册与窗口创建都不会执行，表现为「app 起来了但一片空白」。
// 改为惰性动态 import 并缓存 promise：只在真的要跑定时任务时才加载，
// 加载失败可被 runScheduledAgentTask 捕获成「任务失败」，降级为单轮文本而非进程崩溃。
let agentCorePromise = null;
async function loadAgentCore() {
  if (!agentCorePromise) {
    agentCorePromise = import('../agent-core/index.js').catch((err) => {
      agentCorePromise = null; // 清空以便下一次重试，否则一次失败永久失败
      throw new Error(`Agent 引擎加载失败（动态 import）：${err?.message || err}`);
    });
  }
  return agentCorePromise;
}


// ── GitHub PR 审查闭环工具（gh CLI）──
// 读操作（list/view/diff）直连；写操作（review/comment）对外可见 → L3 审批（见 approval.js TOOL_LEVEL）
// cwd 解析：PR 工具必须拿到项目目录 gh 才能定位仓库——优先模型显式传的 args.cwd
// （agent-core 的 CWD_TOOLS 会注入项目 cwd），缺失时回退主进程 CWD 并在结果中提示。
function prCwdOf(args = {}) {
  const c = String(args.cwd || '').trim();
  if (c) return c;
  return process.cwd();
}
function prReadTool(run) {
  return (args = {}) => run({ cwd: prCwdOf(args), ...args });
}
function prWriteTool(toolKey, run) {
  return async (args = {}) => {
    const { approvalMode = 'on-request', conversationId } = args;
    const verdict = approval.needsApproval({ tool: toolKey, args, approvalMode, conversationId, alwaysRules, conversationRules });
    if (verdict.need) {
      const approvalWait = requestApproval(toolKey, args);
      const decision = await approvalWait;
      if (decision === 'deny') {
        // P1-4：拒绝理由回传——拼进工具结果（模型可见）与审计行（用户可复盘）
        const reason = approvalReasonOf(approvalWait);
        audit(toolKey, `PR #${args.number || '?'}`, reason ? `用户拒绝。理由：${reason}` : '用户拒绝', 'denied');
        return { ok: false, error: denialText(reason), denied: true };
      }
      applyApprovalDecision(decision, toolKey, args, conversationId);
    }
    const r = await run({ cwd: prCwdOf(args), ...args });
    audit(toolKey, `PR #${args.number || '?'} ${args.event || 'comment'}`, r.ok ? 'ok' : `error: ${r.error}`, verdict.need ? 'approved' : 'auto');
    return r.ok ? r : { ...r, ...(String(args.cwd || '') ? {} : { hint: '未提供 cwd，已按主进程工作目录执行；若找不到仓库请先在项目内运行' }) };
  };
}
const prTools = {
  prList: prReadTool((a) => github.prList(a)),
  prView: prReadTool((a) => github.prView(a)),
  prDiff: prReadTool((a) => github.prDiff(a)),
  prReview: prWriteTool('pr_review', (a) => github.prReview(a)),
  prComment: prWriteTool('pr_comment', (a) => github.prComment(a)),
};

// 定时任务专用 toolHandlers：与渲染层会话同源（复用主进程工具实现）
// 定时任务 / Worker 共用的工具集：清单已在 main/scheduledTools.js（按能力边界拆，与行数无关）
const { scheduledToolHandlers: buildScheduledToolHandlers, scheduledCreate: scheduledCreateTool } = require('./scheduledTools');
// M5 / T5-8：军团协同工具（成员任务专用）+ 消息总线写入通道。
// 提前 require（而非在 initTeamsIpc 处）是为了让下方 Worker 工具工厂的闭包在模块解析阶段就有绑定；
// ipc/teams 模块本身的 deps 在 initTeamsIpc 之后才生效，此处只取函数引用，不触发任何 IO。
const { createTeamToolHandlers } = require('./teamTools');
// DS Bots / T6-6：工件协同工具（模型侧四原语）——交互式与成员任务两条通道共用同一工厂，
// 项目身份一律由宿主经会话绑定反查后注入（模型参数不可伪造）。
const { createArtifactToolHandlers } = require('./artifactTools');
const { initTeamsIpc, postTeamMessage } = require('./ipc/teams');
// DS Bots / T6-2：项目空间 IPC 域（projects:create/list/get/updateStatus）
const { initProjectsIpc } = require('./ipc/projects');
// 2026-10-27：只读域 IPC 注册聚合（artifacts / studio / ledger，均只吃 getter、不持有存储）。
// 集中到 main/ipc/registerDomains.js，避免 main.js 贴着 1500 行硬档继续膨胀。
const { registerDomainIpc } = require('./ipc/registerDomains');
// 2026-10-21 团队调试日志：初始化与 IPC 域（teams:debug*）。
const teamDebug = require('./teamDebugLog');
const { initTeamDebugIpc } = require('./ipc/teamDebug');
// M5 / T5-10：中断权限矩阵与留痕（§9.2）——策略/执行/审计收敛在单一入口，
// 与 ipc/teams 的 teams:interrupt 通过 deps.interruptTask 接线（本模块只取函数引用，不触发 IO）。
const teamInterrupt = require('./teamInterrupt');
const scheduledToolHandlers = () => buildScheduledToolHandlers({
  scheduledAgentChat, webTools,
  toolShell, toolReadFile, runWriteTool, toolListDir, toolGrep, toolGlob,
  toolGitStatus, toolGitDiff, toolGitLog, toolGitBranch, toolGitCommit, toolGitAdd,
  callMcpTool, prTools,
});
// 待确认动作的一键执行：拿**未包装**的原始工具表（用户点「执行」= 这次批准）
const replayScheduledAction = createScheduledReplay({ getHandlers: scheduledToolHandlers });

// DS Bots / T6-6：宿主侧工件上下文解析（**唯一入口**）——threadId → project_spaces → artifactId。
// 模型不可自行指定项目：这里解析出的 projectId 同时下发给引擎（决定是否通告工具）与工具处理器
// （做一致性校验），两处同源，杜绝「引擎通告了、handler 却读别的项目」的错位。
// 未绑定项目/未建工件 ⇒ 返回 null（引擎不暴露 artifact 工具，handler 也不会被调到）。
function resolveArtifactContext(threadId) {
  try {
    if (!projectStore) return null;
    const p = projectStore.getProjectByThread(String(threadId || '').trim());
    if (!p || !p.projectId) return null;
    return {
      projectId: p.projectId,
      ...(p.artifactId ? { artifactId: p.artifactId } : {}),
      ...(p.teamId ? { teamId: p.teamId } : {}),
    };
  } catch (e) {
    console.warn('[artifact] 工件上下文解析失败（本次不暴露工件工具）:', e.message);
    return null;
  }
}

// P0-4：主进程 Agent 运行器——交互式会话工具循环迁移至主进程。
// 渲染层只负责发起（agent:run）、订阅事件（agent:event）、中止（agent:abort）；
// 循环本体与全部工具副作用都在主进程，刷新/关闭窗口不再杀死进行中任务。
const agentRunner = require('./agentRunner'), entryRuntime = require('./entryRuntime'), scheduledTeam = require('./scheduledTeam');
// T3-7：引擎子进程驻留——runAgent 迁入独立 utilityProcess 子进程（每 run 一个，用后即杀），
// 工具实现/审批/凭证/流式推送全部留在主进程，由子进程经 RPC 回调（依赖方向反转）。
// 崩溃半径从「整个应用」收缩到「单个任务」；utilityProcess 不可用（单测 stub 环境）时
// isAvailable()=false，agentRunner 自动回退主进程 in-process 路径（生产降级链）。
const engineHost = require('./engineProcess/host');
engineHost.initEngineHost({});
const { waitGroupSettled, humanizeGroupResult, diffGroupEvents } = require('./orchestrator/invoke');

// orchestrate_task 工具实现：对话内自动多 Agent 编排（模型自主决策触发）。
// 同步等待整组收尾，返回人话聚合结果；用户「停止」时立即返回未完成说明。
// 注意：仅在主会话 handlers 注入——Worker 内不可再编排（防递归失控）。
// T1-3：emitSubagent 注入——把编排组内每个子任务的状态流转 diff 上报为 subagent 事件
//（spawn/progress/done/failed + tokens + 结论摘要），供渲染层子任务树可视化。
async function toolOrchestrateTask(args, { signal, emitSubagent, conversationId, projectPath } = {}) {
  const goal = String(args?.goal || '').trim();
  if (!goal) return { ok: false, error: 'goal 不能为空' };
  if (!taskStore) return { ok: false, error: dbStatus.toolFailure() };
  // B1-B-02（F-003）：工具能力门（fail-fast）——与 orchestrator/index.js 的 planGoal 同语义。
  // 为什么 handler 入口还要再拦一次：planGoal 那道门要等 autoOrchestrate 才会走到，而本
  // handler 之前还有审批快照/建组等副作用；更关键的是「组建好了、Worker 全空转」会让用户
  // 看到一组漂亮的任务卡片却一个产物都没有——错误被伪装成进度，比直接失败更难排查。
  // 判定口径与引擎一致：只有显式 boolean false 才算不支持（缺省视为支持，零破坏）。
  if (!orchestrator.modelSupportsToolCall(scheduler.getModel())) {
    return { ok: false, code: 'NO_TOOL_CAPABILITY', error: orchestrator.NO_TOOL_CAPABILITY_ERROR };
  }
  const cwd = String(args?.cwd || '');
  // P0 治理修复（2026-10-16）：原实现 `workerPool.setMaxConcurrent(args.max_agents)`
  // 存在三个问题：
  //   ① 治理方向反了——这是**模型**经工具调用在改并发上限，模型可自行调大（1→8）；
  //   ② 改的是模块级全局变量 ⇒ 污染同进程内所有其他会话与组；
  //   ③ 不写回偏好 ⇒ 重启即丢，行为不可预测。
  // 现移除该副作用：并发宽度应由用户设置（tasks:config，唯一会持久化的入口）决定，
  // 模型侧的动态宽度由 Wave D 的决策器按「复杂度 × 模型能力 × 预算」计算后下发。
  // 在决策器落地前，max_agents 仅作提示性信息被忽略并记录——不让模型越权。
  const requestedAgents = Number(args?.max_agents);
  if (Number.isFinite(requestedAgents) && requestedAgents >= 1) {
    console.warn(`[orchestrate] 忽略模型请求的 max_agents=${requestedAgents}`
      + `（并发上限由用户设置决定，不接受模型侧改写；动态宽度待决策器落地）`);
  }
  // R6：对话内编排的组绑定发起会话（threadId=conversationId，渲染层按会话归属显示）
  // P1-1：组快照必须记「发起本次编排的 run 的档」。此前取全局「最后一次 run」的档——
  // 会话级档可不同（thread.approval_mode 覆盖），会记成别的会话的档。run 已结束则回落用户设置。
  const orchestratorRunId = runScope.getStore()?.runId || null;
  const orchestratorApproval = agentRunner.getApprovalModeFor(orchestratorRunId)
    || approvalSettings.getUserApprovalMode();
  // R2：组持久化 projectPath（记忆归档的空间键）——未提供时回落 cwd（非 worktree/无项目场景）
  const plan = await orchestrator.autoOrchestrate({ goal, cwd, threadId: conversationId || null, projectPath: projectPath || cwd || null, ...hostPolicySnapshot(cwd, orchestratorApproval) });
  if (!plan.ok) return { ok: false, error: `编排启动失败：${plan.error}` };
  // T1-3：spawn 上报（编排落地即逐任务发出，先于任何轮询）
  const reportSubagent = (evt) => {
    try { emitSubagent?.({ tool: 'orchestrate_task', groupId: plan.groupId, ...evt }); }
    catch (e) { console.warn('[orchestrate] 子任务事件上报失败:', e.message); }
  };
  for (const t of plan.tasks || []) {
    // T1-4：spawn 事件透出 DAG 依赖边，渲染层子任务树据此建图（无需二次查询编排器）
    reportSubagent({ phase: 'spawn', taskId: t.id, title: t.title, dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [] });
  }
  // T1-3：轮询 diff——每次快照与上次比较，状态变化即上报（映射逻辑在 diffGroupEvents，可单测）
  const seen = new Map(); // taskId -> { status, retryCount }
  const waited = await waitGroupSettled(taskStore, plan.groupId, {
    signal,
    onPoll: (g) => {
      for (const evt of diffGroupEvents(seen, g)) reportSubagent(evt);
    },
  });
  if (waited.aborted) {
    // 用户已停止：整组强停（在役中止 + 排队置 skipped + 组 cancelled）。只 abort 在役任务时组仍是 running，pump() 会继续派发队列 → 用户点了停止仍在烧 token
    workerPool.abortGroup(plan.groupId);
    return { ok: false, aborted: true, groupId: plan.groupId,
      error: `用户已停止：编排组 ${plan.groupId} 的在役 Agent 已中止（已完成的部分结果已保留）` };
  }
  if (waited.timedOut || waited.missing) {
    // P0-4：超时/状态异常与用户停止同语义——必须整组强停，否则 pump() 继续派发队列，后台继续烧 token
    const killed = workerPool.abortGroup(plan.groupId);
    return { ok: false, groupId: plan.groupId, timedOut: !!waited.timedOut, abortedTasks: killed,
      error: `编排组 ${plan.groupId} 等待超时/状态异常，已中止在役任务（已完成部分保留），可稍后在对话中查询进度` };
  }
  return { ok: true, groupId: plan.groupId, taskCount: plan.tasks.length, summary: humanizeGroupResult(waited.group) };
}

// P1-1：把 localStore getter 注入进去（localStore 在 whenReady 后才非 null，故传闭包）
// P2-7：执行后告知的出口必须在此接（emit 是 main.js 作用域函数；挂 ipc/mcp.js 会被本行后续调用清成 null）
approvalSettings.initApprovalSettings({ getLocalStore: () => localStore, emit: emitTaskEvent });

// ⚠ 必须在这里 require：下面 initAgentRunner 的实参里立刻**展开**了 makeChatUsageDeps()，
// 而 quotaLedger / projectStore 的 require 在本文件更靠后（1286+），放在那里会撞 TDZ。
const { makeChatUsageDeps } = require('./chatUsageWiring');

agentRunner.initAgentRunner({
  loadAgentCore,
  // T3-7：引擎子进程宿主（isAvailable 时 runAgent 走独立进程，否则回退 loadAgentCore in-process）
  engineHost,
  // T4-3 技能接线：数字员工 starter_skills 按名装载本地 SKILL.md 内容（~/.mjcode/skills）
  loadSkillContents: (names) => require('./skills').loadSkillContents(pluginsIpc.SKILLS_DIR(), names),
  // N5 rootExecution 统一取消：runScope（handler 包装用）/ 撤审批 / 终止子进程 / 子进程注册
  runScope,
  cancelApprovalsForRun: (runId) => approvalChannel.cancelByRun(runId),
  // P0-1：registerChild/killChildrenForRun 收敛到 childRegistry（与 initToolExec 同源）
  registerChild: (child) => childRegistry.register(runScope.getStore()?.runId, child),
  killChildrenForRun: (runId) => childRegistry.kill(runId),
  // 2026-10-15：会话消息持久化通道（agentRunner 收归主进程落库用）——
  // conversationId 即 threadKey（thread.id），camelCase 形状与 localStore.addMessage 对齐
  persistMessage: ({ conversationId, message }) => {
    if (!localStore) throw new Error('本地数据层未初始化');
    return localStore.addMessage({ threadId: conversationId, ...message });
  },
  // P0-1（2026-10-22）：运行历史的唯一读取口——agentRunner 用它从会话库装配 messages，
  // 取代渲染层内存快照（后者只含用户消息与最终总结，中间工具往返不在其中 ⇒ 刷新前后两种行为）。
  listMessages: (conversationId) => (localStore ? localStore.listMessages(conversationId) : []),
  // 2026-10-28：对话用量的账本接线（recordUsage / resolveProjectOfConversation）
  // 口径与异常处理见 main/chatUsageWiring.js；getter 延迟求值，与初始化顺序无关
  ...makeChatUsageDeps(() => quotaLedger, () => projectStore),
  // V08：持久 ACK——最终总结落库后强制刷盘，只有 durable 成功才允许 mainPersisted:true
  flushPersistence: () => {
    if (!localStore) return { ok: false, error: '本地数据层未初始化' };
    return localStore.flushSync();
  },
  // P0-1/P0-2（记忆写入闭环）：Agent 运行收尾 / 压缩摘要的自动归档通道。
  // 引擎本身不碰存储，归档统一经 MemoryManager 唯一写入入口（去重/容量闸/可信度分级都在那里）。
  // 读取时取模块级 memoryManager（initDb 内赋值）——闭包在调用时求值，装配顺序无关。
  rememberMemory: (args) => {
    try {
      return memoryManager ? memoryManager.remember(args) : null;
    } catch (e) {
      console.warn('[memory] 自动归档失败（丢弃该条）:', e.message);
      return null;
    }
  },
  // P1-1：主对话通道的 L3 独立评审目标工厂（与定时通道同源：紧凑档优先、回落主模型）。
  // 工厂在 run 启动时才解析——配置随时可变，且启动早期模型尚未就绪。
  l3Target: scheduledL3Target,
  // P1-5：用户自定义生命周期 hooks——交互会话的工具调用同样过 preToolUse/postToolUse
  toolHooks,
  // T5-7：per-agent 模型绑定——成员绑定的引用串（`providerId::modelId`）解析为本机模型对象。
  // 供应商列表是本机数据（localStore），在被调用时才求值：绑定失效（供应商/模型已删）返回 null，
  // agentRunner 据此安静回落会话默认模型，不因绑定失效失败整轮。
  resolveModelRef: (ref) => resolveModelRef(ref, localStore ? localStore.listProviders() : []),
  // v1（2026-10-19）：意图驱动的 MCP 动态加载依赖——离线意图判定后按需连接用户**已保存**的连接器
  // 并取其工具定义（原生优先由 agentRunner 侧的 intentMcpPrewarm 纯函数决定）。
  // 三者都取自 mcp ipc 域：凭证/落盘全程留在主进程，agentRunner 只做纯编排与工具定义合并。
  mcpDynamic: {
    reconnectSaved: (name) => mcpIpc.reconnectSaved(name, { reason: 'intent-prewarm' }),
    loadConfig: () => mcpIpc.loadMcpConfig(),
    getManifest: (name) => {
      const m = mcpIpc.getToolCache().getManifest(name);
      return m && Array.isArray(m.tools) ? m : null;
    },
  },
  // 每次运行独立工具处理器：chat 用流式实现（externalSignal=运行 controller，级联中止在途 fetch），
  // 其余工具与定时任务通道同源（toolShell/runWriteTool/toolGrep/... 主进程实现直调）
  // V01：createToolHandlers 接收本 run 的宿主治理值（agentRunner 已按角色钳制），
  // 工具处理器内一律使用宿主值，不读模型参数里的治理字段。
  createToolHandlers: ({ sender, signal, runId, emitSubagent, approvalMode: runApprovalMode, conversationId, model, projectPath }) => ({
    ...scheduledToolHandlers(),
    // runId 作为 streamTag：Agent 运行的流式输出带标签，渲染层按活跃会话过滤（切会话/后台运行不串显）
    chat: (chatPayload) => chatStreamOnce(chatPayload, sender, signal, runId),
    orchestrateTask: (args) => toolOrchestrateTask(args, { signal, emitSubagent, conversationId: conversationId || '', projectPath: projectPath || '' }),
    // 对话内网络插件搜索/安装（LobeChat 式）：搜索只读；安装恒走 L3 审批卡
    searchPlugins: (args) => searchPluginsTool(args),
    installPlugin: (args) => installNetworkPlugin(args, {
      // V01/V04：审批档由宿主绑定（run 的有效档），模型传参里的 approvalMode 不可信
      approvalMode: runApprovalMode || 'on-request',
      conversationId: args.conversationId || '',
    }),
    // P0-A：Web 检索/抓取。内网地址已由 webTools 自行拦截（SSRF 防护）。
    // todoWrite 由 agent-core 内置处理（纯状态，不出网、不触盘），故不在此注册。
    webSearch: (args) => webTools.webSearch(args),
    webFetch: (args) => webTools.webFetch(args),
    // 2026-10-17：模型侧创建定时任务（此前零入口，用户只能手动去界面建）。恒走 L3 审批，
    // 且审批只对本次有效（不落规则库）——见 main/scheduledTools.js 的说明。
    scheduledCreate: (args) => scheduledCreateTool(args, {
      approvalMode: runApprovalMode || 'on-request',
      conversationId: conversationId || '',
      requestApproval,
      createTask: scheduler.createTask,
      cronValid: scheduler.cronValid,
    }),
    // GitHub PR 审查闭环（读直连；review/comment 走 L3 审批）
    prList: prTools.prList,
    prView: prTools.prView,
    prDiff: prTools.prDiff,
    prReview: prTools.prReview,
    prComment: prTools.prComment,
    // T4-1：Browser Use 六工具（子进程执行 + L3 审批；仅主会话注入——
    // Worker/定时任务无审批通道语义，浏览器操作必须有人在场确认）
    browserNavigate: browserTools.toolBrowserNavigate,
    browserClick: browserTools.toolBrowserClick,
    browserFill: browserTools.toolBrowserFill,
    browserSelect: browserTools.toolBrowserSelect,
    browserScreenshot: browserTools.toolBrowserScreenshot,
    browserExtract: browserTools.toolBrowserExtract,
    // T4-2：Chrome 接管七工具（经中继转发扩展；仅主会话注入——与 browser_* 同纪律，
    // Worker/定时任务无审批通道语义，不允许触碰用户真实浏览器）
    chromeStatus: chromeTools.toolChromeStatus,
    chromeTabs: chromeTools.toolChromeTabs,
    chromeNavigate: chromeTools.toolChromeNavigate,
    chromeClick: chromeTools.toolChromeClick,
    chromeFill: chromeTools.toolChromeFill,
    chromeScreenshot: chromeTools.toolChromeScreenshot,
    chromeExtract: chromeTools.toolChromeExtract,
    // T4-7：Code Mode（子进程持久会话 + L3/L1 审批；仅主会话注入——
    // Worker/定时任务无审批通道语义，不允许执行任意代码）
    codeExec: codeTools.toolCodeExec,
    // 期 3：原生内置工具（clipboard/notify/http_request/sqlite/sandbox_code_run）。
    // 同样仅主会话注入——Worker/定时任务没有审批通道语义，不允许触碰剪贴板/发请求/写库/跑代码。
    clipboard: nativeTools.toolClipboard,
    notify: nativeTools.toolNotify,
    httpRequest: nativeTools.toolHttpRequest,
    sqlite: nativeTools.toolSqlite,
    sandboxCodeRun: nativeTools.toolSandboxCodeRun,
    // G-doc：文档生成四工具（本地离线生成 docx/xlsx/pptx/pdf）。同样仅主会话注入——
    // Worker/定时任务没有审批通道语义，写文件必须有人在场确认。
    docCreate: docTools.toolDocCreate,
    xlsxCreate: docTools.toolXlsxCreate,
    pptxCreate: docTools.toolPptxCreate,
    pdfGenerate: docTools.toolPdfGenerate,
    // G-latex：LaTeX 编译（写 PDF 弹审批；probeOnly 体检模式不写文件故不进审批面）。
    // 同样仅主会话注入——Worker/定时任务没有审批通道语义，编译产物落盘必须有人在场确认。
    latexCompile: latexTools.toolLatexCompile,
    // G-CUA：模型侧桌面自动化（computer_use）——把既有 CUA 循环接到模型工具面。
    // 仅主会话注入（Worker/定时任务无审批通道语义，且模型必须在场确认）；引擎仅当
    // 用户开启「界面自动化」且为 macOS 时才把该工具放进 tools 数组，此处是执行侧接线。
    computerUse: (args) => toolComputerUse(args, {
      model, signal, runId,
      approvalMode: runApprovalMode || 'on-request',
      conversationId: conversationId || '',
    }),
    // DS Bots / T6-6：工件协同四工具。项目身份按本 run 的会话绑定反查（resolveArtifactContext
    // 是唯一入口）；未绑定项目时引擎不通告 schema，handler 也不会被调到。
    // 交互式会话没有团队总线，postMessage 传 null（不写 artifact_ref）。
    ...createArtifactToolHandlers({
      artifactContext: resolveArtifactContext(conversationId),
      getArtifactStore: () => artifactStore,
      approvalDeps: {
        requestApproval, applyApprovalDecision, getAlwaysRules: () => alwaysRules, conversationRules,
        // V01：审批档/对话 id 由宿主绑定（本 run 的钳制后档位），模型参数不可信
        approvalMode: runApprovalMode || 'on-request', conversationId: conversationId || '',
      },
    }),
  }),
});
// DS Bots / T6-6：进引擎前注入工件上下文（引擎据此通告 artifact_* schema；handler 侧用同一
// resolveArtifactContext 再做一致性校验）。解析失败不阻塞运行，只是本轮没有工件能力。
// 双入口判定点装配（P1-4）：判定结果只做提示与预拆，**绝不建组**，也**不阻塞主链路**。
ipcMain.handle('agent:run', (event, rawPayload) => {
  const payload = { ...(rawPayload || {}) };
  if (payload.artifactContext === undefined) {
    const ctx = resolveArtifactContext(payload.conversationId);
    if (ctx) payload.artifactContext = ctx;
  }
  return entryRuntime.judgeAndStart(payload, event.sender, { chatOnce: scheduledAgentChat, resolveModel: () => scheduler.getModel() }, (p, s) => agentRunner.startAgentRunWhenReady(p, s));
});
ipcMain.handle('agent:abort', (_, { runId } = {}) => ({ ok: agentRunner.abortRun(runId) }));

// 定时任务 Agent 入口：scheduler.runTask 到点调用
// 审批策略 auto-safe：L2 写操作自动放行（本地审计已留痕），L1 危险命令/L3 MCP 仍弹审批卡
// （2 分钟无响应按拒绝，与交互式一致）；沙箱：有 cwd → workspace-write（只约束 shell 子进程），无 → read-only。writeFile 走 Node fs、不经沙箱，能否落盘看 main/writeGuard.js 的白名单（只放行 cwd/userData/tmp）
async function runScheduledAgentTask({ prompt, model: schedModel, signal, taskId = '', taskName = '', runId = '', externalPolicy = 'block', teamId = null, threadId = null }) {
  if (!schedModel || !schedModel.model) {
    throw new Error('未配置执行模型：请在任意会话中选择模型（定时任务复用会话模型与凭证）');
  }
  // 扁平形 → 嵌套形：改用共享转换（此前是此处手抄，Worker 路径漏抄导致崩溃）
  const runModel = toAgentModel(schedModel);
  const rc = require('./scheduledOutput').scheduledRunContext({ app, taskName, contextCwd: schedModel.cwd }); // 产出目录 + 追加提示（cwd 一律用产出目录，会话 cwd 仅作可读参考）
  // P1-6：军团绑定 / 会话绑定的**全部装配**都在 scheduledTeam.prepareScheduledRun 里（军团 fail-closed
  // 解析 + 会话历史 + 记忆 + 军团工具 + 派活分支 + 产出回写）；放这里是为了守住 main.js 的 1500 行 code 硬档。
  const schedCtx = scheduledTeam.prepareScheduledRun({ prompt, teamId, threadId, taskId, taskName, outputDir: rc.dir, signal, getTeamStore: () => teamStore, localStore, memoryManager, orchestrator, workerPool, taskStore, waitGroupSettled, humanizeGroupResult, createTeamToolHandlers, postTeamMessage });
  // V 层：L1 对账全量跑（零成本）+ L3 按风险门/抽样触发，且**无人值守 fail-closed**
  //（判不出来就不许宣告成功）。策略与成本口径见 main/scheduledVerify.js 的注释。
  const sv = createScheduledVerify({ taskId, cwd: rc.dir, ...scheduledL3Target() });
  // 对外动作闸门：默认拦（无人值守没有人能批准），任务显式 allow 才放行
  const sguard = createScheduledGuard({ enabled: externalPolicy !== 'allow', runId, cwd: rc.dir });
  let toolCount = 0;
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  const agentCore = await loadAgentCore();
  const finalText = await agentCore.runAgent({
    // P1-6：messages + memories 由 scheduledTeam 装配（会话历史 + 军团说明 + 带 teamId 的记忆召回）
    ...schedCtx.runParams,
    model: runModel,
    cwd: rc.dir,
    signal,
    // P0-8c/P1-1：审批档与用户设置对齐——原为硬编码 'auto-safe'，用户选「全部询问」时被静默
    // 忽略（产品对用户设置撒谎）。与 workerPool.js:206 同源：取「用户当前档（或调用方显式传入）
    // 与 auto-safe 地板」中更严者。2026-10-17（P1-1）：用户档来源改为 approvalSettings.getUserApprovalMode()
    // （读持久化设置，而不是「最后一次交互 run 的档」）；stricterApproval 仍由 approvalPolicy.js 提供。
    approvalMode: agentRunner.stricterApproval(schedModel.approvalMode || approvalSettings.getUserApprovalMode(), 'auto-safe'),
    // D-13：cwd→沙箱档走 approvalPolicy 的单点（档名唯一出处是 shared/rolePolicyData.json），别在此手抄档名
    sandboxPolicy: sandboxTierForCwd(rc.dir),
    conversationId: 'scheduled',
    maxRounds: 40, // 100 篇 ≈ 10 批 ×(抓取+落盘) ≈ 20 轮，原 20 轮零余量；40 轮留重试余量（按「100 篇」量级定的默认值，非永久最优）
    // P0-8c：无人值守成本闸仍保留（有界防失控，不是放开）：按每轮 ~15k prompt 估算，200k 约 13 轮就见底 → 提到 400k（交互通道 trace 里是 600k，定时取 400k 属保守）
    tokenBudget: 400000,
    chatRetryBaseMs: 2000, // 无人值守：退避基数放宽，弱网下更耐心
    // 无人值守：收尾文案不能对用户说「发送继续」（没有人能发），改为给出可操作的下一步
    unattended: true,
    // 追加在 BASE_PROMPT 之后（不替换）：BASE_PROMPT 承载「可用工具/默认目录/路径怎么给」，替换掉它模型就不知道自己能写文件、该写哪
    appendSystemPrompt: rc.appendPrompt,
    // P1-11（2026-10-22）：定时任务也吃项目规范。此前只有渲染层读 AGENTS.md，
    // 无人值守通道的 Agent 完全不守项目约定（同一项目两种行为）。内联 require 以守 main.js 硬档。
    agentsMd: require('./agentsMd').readAgentsMd(rc.dir),
    // 编排工具补齐：定时通道原先没有 orchestrate_task（对话有），这就是"同一句话对话能 4 Agent 并行、定时只能串行"的差别；cwd 强制产出目录，子 Agent 写入才落在用户找得到的地方。
    toolHandlers: toolHooks.wrap(sguard.wrap({
      // FIX-P04：团队协同工具必须作为**入参**交给工厂（它据此展开成 teamListMembers 等 5 个键）。
      // 此前写成映射里的一级键 `{ teamTools: ... }`——那只是个没人认识的键，
      // team_* 一个都不存在，模型即便知道也调不到。传 null 时工厂整体不展开（非团队任务零影响）。
      ...scheduledToolHandlers({ unattended: true, contextCwd: schedModel.cwd, teamTools: schedCtx.teamTools }),
      // D-805（2026-10-21）：**定时任务这条道同样要接取消信号**。此前只 spread 了基础表，
      // 表里的 `chat: scheduledAgentChat` 是裸的单参版本 ⇒ 用户停掉定时任务时，在途模型请求
      // 要等内部守卫到点才停。这里与 Worker 工厂同款覆盖一次。
      chat: (payload) => scheduledAgentChat(payload, { signal }),
      // P1-6：绑定了军团时，末个 spread 把派活通道覆盖成**团队语义**（roster 快照 / defaultMode / budget）
      orchestrateTask: (a) => toolOrchestrateTask({ ...a, cwd: rc.dir }, { signal, conversationId: `scheduled:${taskId}`, projectPath: rc.dir }), ...(schedCtx.teamHandler ? { orchestrateTask: schedCtx.teamHandler } : {}),
    }), { cwd: rc.dir, conversationId: `scheduled:${taskId}` }),
    // V 层旁路：台账（父 run 才有）+ 最近一次测试输出（J3 输入）
    // trace 落盘用 runId（不是 taskId）：否则同一任务的多次运行互相覆盖，事后无法还原这一次发生了什么
    onTrace: (evt) => { sv.onTrace(evt); require('./runTrace').appendTraceEvent(runId, evt); },
    onToolCall: (tc) => { toolCount += 1; sv.onToolCall(tc); },
    onDone: (_text, usage) => { if (usage) totalUsage = usage; },
  });
  // 收尾判定：产物照常返回；writes 是 V 层确定性对账的「成功写入次数」，调度器据此判「零写入不成功」
  const vres = await sv.finish(finalText || ''); schedCtx.onFinished(finalText || ''); // P1-6：绑定了 thread_id 时把产出回写原会话（Codex Thread automation 形态）
  return {
    output: finalText || '', toolCalls: toolCount, usage: totalUsage, writes: vres.writes, shellWrites: vres.shellWrites, workDir: rc.dir,
    verify: vres.verify, delivery: vres.delivery, pendingActions: sguard.take(),
  };
}

// ═══════════════════════════════════════════
//  P1：任务编排子系统（Orchestrator + WorkerPool + 持久化队列 + Aggregator）
//  目标 → LLM 拆解 DAG → 并行分层执行（wait_all）→ 聚合收尾；SQLite 断点续跑。
//  与定时任务通道同源：loadAgentCore / scheduledAgentChat / scheduledToolHandlers 复用。
// ═══════════════════════════════════════════
const { openDbAsync } = require('./db');
const dbStatus = require('./dbStatus');
const { TaskStore } = require('./taskStore');
// M5 / T5-1：MJ 军团团队层——团队编制（与任务编排共用同一 SQLite 底座）
const { TeamStore } = require('./teamStore');
// DS Bots / T6-2：项目空间仓储（项目身份唯一事实来源，与团队/任务同库）
const { ProjectStore } = require('./projectStore');
// DS Bots / T6-3：项目级滑动配额账本（唯一配额判定入口）
const { QuotaLedger } = require('./quotaLedger');
// DS Bots / T6-7：配额闸调度侧接线（泵前置闸 / 开跑预留 / 60s 恢复轮询）
const { createQuotaGate } = require('./quotaGate');
// DS Bots / T6-8：单 Bot 熔断（10 分钟窗口聚合 + half-open，只锁单一成员）
const { createMemberBreaker } = require('./memberBreaker');
// DS Bots / T6-11：项目上下文装配（objective + summary + todo + index，正文不进装配）
const projectContext = require('./projectContext');
// DS Bots / T6-5：工件版本库（长文档唯一事实来源，正文永不进消息链）
const { ArtifactStore } = require('./artifactStore');
const { MemoryManager } = require('./memory');
// D-806 / B-12：团队记忆沉淀闸（默认开的独立开关，与 memory.autoCapture 解耦）
const { teamCaptureEnabled } = require('./teamMemoryGate');
const { MemoryBgScheduler } = require('./memory/bgScheduler');
// 三层记忆 M3：记忆文件双通道（SQLite 唯一事实来源，文件为导出视图）
const { MemoryFileSync } = require('./memory/memoryFile');
const workerPool = require('./workerPool');
const orchestrator = require('./orchestrator');

let taskStore = null;
let teamStore = null; // M5 / T5-1：军团编制（teams / team_members）
let projectStore = null; // DS Bots / T6-2：项目空间（project_spaces）
let quotaLedger = null; // DS Bots / T6-3：项目配额账本（quota_buckets / quota_consumptions）
let quotaGate = null; // DS Bots / T6-7：配额闸（workerPool 泵 / 开跑预留 / 恢复轮询共用同一实例）
let quotaTickTimer = null; // DS Bots / T6-7：60s 老化恢复轮询（单实例，重复初始化不叠加）
let artifactStore = null; // DS Bots / T6-5：工件版本库（project_artifacts / artifact_sections / *_versions）
let taskDb = null;
let memoryManager = null;   // P2-1：记忆唯一写入入口（SQLite，五域四层）
let memoryScheduler = null; // P2-5：记忆后台任务调度器
let memoryFileSync = null;  // M3：记忆文件双通道（导出视图 + 外部变更导入）
// X4：库状态交由 main/dbStatus.js 持有（失败原因 → 状态条 + 工具错误）
dbStatus.register(ipcMain, () => !!taskStore);

// V04：编排建组的「宿主治理快照」（审批档取用户当前设置、沙箱按 cwd 有无推导、不接受模型参数）
// 单一事实来源在 main/approvalPolicy.js（纯函数，零依赖）——模型侧 orchestrate_task 工具与
// tasks:* IPC（main/ipc/tasks.js）各自 import，避免两份实现漂移。
const { hostPolicySnapshot, sandboxTierForCwd } = require('./approvalPolicy');

function emitTaskEvent(evt) {
  // M5 / T5-6（2026-10-21）：活动轨迹持久化——先落库再广播（顺序无关，但落库失败不阻断 UI）。
  // 只收两类：task_activity（工具/撤员/改派/等待等过程）与带任务 id 的 task_update（状态推进）。
  // 字段白名单裁剪：工具参数在 workerPool 已截断 80 字符；错误详情截断 300 字符，
  // 避免把大段模型输出写进轨迹表（轨迹表只用于「看得见在做什么」，不是正文存储）。
  try {
    if (taskStore && evt && evt.groupId) {
      if (evt.type === 'task_activity') {
        taskStore.appendEvent({
          groupId: evt.groupId,
          taskId: evt.taskId || null,
          type: 'activity',
          payload: {
            kind: evt.kind || '', textKey: evt.textKey || '', textParams: evt.textParams || null,
            text: String(evt.text || '').slice(0, 300), name: evt.name || '',
          },
        });
      } else if (evt.type === 'task_update' && evt.taskId) {
        taskStore.appendEvent({
          groupId: evt.groupId,
          taskId: evt.taskId,
          type: 'status',
          payload: {
            status: evt.status || '', title: evt.title || '', name: evt.name || '',
            error: evt.error ? String(evt.error).slice(0, 300) : '',
          },
        });
      }
    }
  } catch (e) {
    // 轨迹是辅助观测：写失败只记日志，绝不影响任务执行与 UI 广播
    console.warn('[tasks] 活动轨迹落库失败:', e?.message || e);
  }
  // 事件桥接：编排器监听组终态/暂停事件，驱动 auto 组自动重规划
  try { orchestrator.onTaskEvent(evt); } catch (e) { console.error('[orchestrator] 事件处理异常:', e.message); }
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('tasks:event', evt); } catch { /* 窗口已销毁 */ }
  }
}

// M5 / T5-2：军团消息总线事件桥（与 emitTaskEvent 同款）——消息落库后广播给所有窗口，
// 渲染层据此实时追加时间轴。事件是「落库后」的通知，不是写通道：seq/落库在主进程内完成。
function emitTeamsEvent(evt) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('teams:event', evt); } catch { /* 窗口已销毁 */ }
  }
}

// 任务执行模型：与定时任务同源（跟随用户当前选择；未选择时给出可行动错误）
function resolveTaskModel() {
  const m = scheduler.getModel();
  if (!m || !m.model) {
    throw new Error('未配置执行模型：请在任意会话中选择模型（任务编排复用会话模型与凭证）');
  }
  // P0-3①：思考强度必须随模型下发（定时任务/编排此前恒发默认档）
  // B1-B-02（F-003）：能力位同理——这里若把 caps 摘掉，编排/定时链路的工具能力门就永远
  // 读到缺省 true（引擎按「未声明=支持」处理），开关在这两条链上再次变成装饰品。
  // 只在来源声明过时才带（scheduled:setModel 原样存载荷，本函数只搬不造）。
  return {
    providerId: m.providerId, isGlobal: !!m.isGlobal, baseUrl: m.baseUrl || '', model: m.model,
    reasoningEffort: m.reasoningEffort || m.reasoning_effort || '',
    ...(m.caps && typeof m.caps === 'object' ? { caps: m.caps } : {}),
  };
}

function initTaskOrchestration() {
  // 异步初始化：驱动选择可能包含子进程金丝雀探测（最长 ~10s），不阻断启动
  openDbAsync(app.getPath('userData'), { isPackaged: app.isPackaged })
    .then((db) => { if (setupTaskOrchestration(db) === true) dbStatus.markReady(); })
    .catch((err) => {
      // 初始化失败不阻断启动，但必须让用户看得见（X4）
      console.error('[tasks] 初始化失败（任务编排不可用）:', err.message);
      taskStore = null;
      dbStatus.markUnavailable(err && err.message);
    });
}

function setupTaskOrchestration(db) {
  try {
    taskDb = db;
    taskStore = new TaskStore(db);
    // M5 / T5-1：军团编制与任务编排同库同事务底座（切项目各看各的，按 project_path 过滤）
    teamStore = new TeamStore(db);
    // DS Bots / T6-2：项目空间与任务编排同库——项目是 thread/团队/工件的稳定锚点
    projectStore = new ProjectStore(db);
    // DS Bots / T6-5：工件版本库同库——不依赖 projectStore（只校验 project_spaces 存在性），
    // 故初始化顺序与 T6-9 的「项目→工件→配额桶」编排无关（那只是业务顺序，不是装配顺序）。
    artifactStore = new ArtifactStore(db);
    // DS Bots / T6-7：配额账本 + 闸。组↔项目只按 thread_id 反查（project_spaces 单一事实源）；
    // 无项目组一律 fail-open，普通编排组的调度行为与 T6-7 之前完全一致。
    quotaLedger = new QuotaLedger(db);
    // T6-8：熔断器只读账本的内存/DB 聚合，不新增持久表——重启后按窗口自然重算。
    const breaker = createMemberBreaker({ ledger: quotaLedger });
    quotaGate = createQuotaGate({
      ledger: quotaLedger,
      store: taskStore,
      db,
      projectOfThread: (threadId) => projectStore?.getProjectByThread(threadId) || null,
      emit: emitTaskEvent,
      onResumed: () => workerPool.schedule(),
      breaker,
    });

    // P2：记忆体系初始化（与任务编排共用 SQLite 底座）
    // M3：文件双通道先于 manager 装配——sync 以 lazy getter 反向引用 manager（循环依赖），
    //     manager 构造时再把 onChange 回指 sync，形成「写路径 → 防抖落盘」单向流。
    memoryFileSync = new MemoryFileSync({
      getManager: () => memoryManager,
      getTeamSharing: () => localStore?.getPreference('memory.teamSharing') === true,
    });
    memoryManager = new MemoryManager({ db, onChange: (e) => memoryFileSync?.onChange(e) });
    // 旧 JSON 记忆一次性导入（幂等：localStore 清空后不再重复；按标记只导一次）
    try {
      if (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source = 'legacy-import'").get().n === 0) {
        const legacy = localStore?.data?.memories || [];
        const n = memoryManager.importLegacy(legacy);
        if (n > 0) console.log(`[memory] 旧记忆导入完成：${n} 条`);
      }
    } catch (e) { console.warn('[memory] 旧记忆导入跳过:', e.message); }
    memoryScheduler = new MemoryBgScheduler({
      db,
      memory: memoryManager,
      chatOnce: scheduledAgentChat,
      resolveModel: resolveTaskModel,
      bgGate: () => quota.bgAllowed(), // P3-3：前台过载/熔断时后台作业全部让路
      acquireSlot: (kind, providerId) => quota.acquire(kind, providerId), // P3-3：后台压缩走 bg 槽位（不吃前台预留）
      getDailyQuota: () => Number(localStore?.getPreference('memory.bgDailyQuota')) || null, // P3-3：每日报费上限可配置
      emit: emitTaskEvent,
    });
    memoryScheduler.start({ intervalMs: 60 * 1000 });

    workerPool.initWorkerPool({
      loadAgentCore,
      store: taskStore,
      // DS Bots / T6-7：项目配额闸（泵前置拦截 + 开跑预留 + 结算释放；无项目组为 no-op）
      quotaGate,
      maxConcurrent: Number(localStore?.getPreference('tasks.max_concurrent')) || 4,
      // 2026-10-16：子任务继承用户当前审批档（此前硬编码 auto-safe，用户设 always 时被静默忽略）
      getApprovalMode: () => approvalSettings.getUserApprovalMode(),
      // P1-11c：Worker 分档模型。渲染层设置页写入 → localSetPreference 同步到 preferences。
      // 主进程读不到 localStorage，没有这行注入时 workerPool 的 `deps.getModelOverrides`
      // 恒为 undefined → 分档永远回落主模型（此前正是这个状态）。
      getModelOverrides: () => localStore?.getPreference('model_overrides') || null,
      emit: emitTaskEvent,
      resolveModel: resolveTaskModel,
      // 第八轮 B-01 / D-808：军团成员的 per-bot 配置需要这两个依赖才能落地 ——
      // resolveModelRef 解析成员绑定的模型引用串，loadSkillContents 按名装载成员技能。
      // 此前 Worker 池**完全没有注入**这两个依赖，是「配了却不执行」的直接成因之一。
      // 两者与主会话通道（agentRunner deps）同源实现，不新起第二套。
      resolveModelRef: (ref) => resolveModelRef(ref, localStore ? localStore.listProviders() : []),
      loadSkillContents: (names) => require('./skills').loadSkillContents(pluginsIpc.SKILLS_DIR(), names),
      // P1-2：Worker 通道的 L3 独立评审目标工厂（与定时/主对话同源）。
      l3Target: scheduledL3Target,
      // P1-5：Worker 的工具调用同样过用户 hooks（无人值守不代表可以绕过用户设的校验规则）
      toolHooks,
      // M5 / T5-11：成员会话（设计稿 v1.5 §13.1 C1 / §13.2 四级 key）——
      // 会话 id 由 workerPool 按「认领成员」定，而「谁是成员」需要团队名册：
      // run_id = groupId 是「团队↔run」的唯一事实来源（findTeamByRun），故名册在此按 run 反查。
      // 未派活给团队的普通编排组返回 null ⇒ worker 退化为 `agent:anon:{groupId}:{taskId}` 隔离键。
      // M5 / T5-9（§9.1）：**run 级快照优先**。派活时快照已随 dag_json 落库，运行期只读快照：
      // 团队中途改配置/加人/删人都不影响本次 run，保证「同一次运行可复现、可审计」。
      // 仅在快照缺失（旧数据 / 非派活组）时回落实时名册。
      resolveTeamRoster: (group) => {
        try {
          const snapshot = group?.dag?.roster;
          if (Array.isArray(snapshot) && snapshot.length) return snapshot;
          const team = teamStore?.findTeamByRun?.(group?.group_id);
          return team && Array.isArray(team.members) ? team.members : null;
        } catch (e) { console.warn('[worker] 名册反查失败（按无成员身份运行）:', e.message); return null; }
      },
      // M5 / T5-12：批次探活的第二通道——团队消息序号（§13.4 三通道判据之一）。
      // 只取 O(1) 的 MAX(seq)：探活每 5 秒对每个在跑团队组各拍一次，读全表会把探活本身变成负载。
      getTeamMessageSeq: (runId) => {
        try { return Number(teamStore?.latestSeqForRun?.(runId)) || 0; } catch { return 0; }
      },
      // M5 / T5-8：成员任务的协同上下文（团队 + 本 run + 本任务 + 认领成员）。
      // 三处判据缺一不可，任一不成立就返回 null（模型看不到 team_* 工具）：
      //   · 该 run 必须归属某个团队（findTeamByRun，唯一事实来源）；
      //   · 团队未归档（归档 = 只读，不再接受协同）；
      //   · 任务已有认领成员，且该成员在**本次 run 快照**内（T5-9：成员中途被下架，
      //     正在跑的 run 仍以快照身份继续协作，直到本 run 收尾；无快照时才查实时名册）。
      resolveTeamContext: (group, task) => {
        try {
          const team = teamStore?.findTeamByRun?.(group?.group_id);
          if (!team || team.archivedAt) return null;
          const memberId = task?.ownerMemberId || '';
          if (!memberId) return null;
          const snapshot = group?.dag?.roster;
          const roster = Array.isArray(snapshot) && snapshot.length ? snapshot : team.members;
          if (!Array.isArray(roster) || !roster.some((m) => m.id === memberId)) return null;
          return { teamId: team.id, runId: group.group_id, taskId: task.taskId, memberId };
        } catch (e) {
          console.warn('[worker] 团队上下文反查失败（本次不暴露协同工具）:', e.message);
          return null;
        }
      },
      // T6-6：成员任务同样注入工件四工具——项目上下文按组的 thread_id 反查（项目空间单一事实源），
      // 并叠加团队上下文（teamId/runId/memberId）用于作者留痕与 artifact_ref 总线广播。
      createToolHandlers: ({ signal, cwd, teamContext, threadId }) => {
        const artifactCtx = resolveArtifactContext(threadId);
        if (artifactCtx && teamContext) {
          Object.assign(artifactCtx, {
            teamId: teamContext.teamId, runId: teamContext.runId, memberId: teamContext.memberId,
          });
        }
        return {
          ...scheduledToolHandlers({
            unattended: true, contextCwd: cwd, // Worker 也无人值守：审批立即 deny；git/读类需要项目 cwd
            // M5 / T5-8：协同四工具只在成员任务注入。四表写入/看板/等待全部复用既有单例：
            // 总线走 postTeamMessage（G4 体积闸 + 审计 + 广播），看板走 taskStore，
            // 等待走 workerPool.waitTask（唯一入口，登记后由池中止本 run 释放槽位）。
            teamTools: teamContext ? createTeamToolHandlers({
              teamContext,
              getTeamStore: () => teamStore,
              getTaskStore: () => taskStore,
              postMessage: postTeamMessage,
              waitTask: workerPool.waitTask,
            }) : null,
          }),
          // Worker 的 chat 走非流式直连（无 UI 消费流式 token）。
          // D-805（2026-10-21）：**必须把池的取消信号透传下去**——此前写成 scheduledAgentChat(payload)，
          // 注释却写「运行中止由池的 controller 级联」，实际只级联到工具层、没级联到模型请求，
          // 于是点「停止」后在途模型调用要等内部守卫到点（最长 15min）才停。
          chat: (payload) => scheduledAgentChat(payload, { signal }),
          // P0-A：Worker 同样需要 Web 能力（子任务常需查文档/查报错）
          webSearch: (args) => webTools.webSearch(args),
          webFetch: (args) => webTools.webFetch(args),
          // T6-6：工件工具。无人值守通道没有审批 UI ⇒ 档位取 auto-safe（L2 写入自动放行，
          // 与 Worker 既有的文件写入语义一致），若仍被判定需要人工确认则直接 deny（fail-closed）。
          ...createArtifactToolHandlers({
            artifactContext: artifactCtx,
            getArtifactStore: () => artifactStore,
            postMessage: postTeamMessage,
            approvalDeps: {
              approvalMode: 'auto-safe',
              conversationId: teamContext?.memberId ? `agent:${teamContext.memberId}` : '',
              requestApproval: () => Promise.resolve('deny'),
            },
          }),
        };
      },
      // P0-2c：转异步——记忆块经 shared/untrustedContent 结构性隔离后再注入
      // （Worker prompt 是模型上下文的一部分，历史沉淀可能已被污染，与 agent-core 注入口同处置）
      buildTaskPrompt: async (group, task) => {
        // 注入总体目标 + 已完成前置任务的结论摘要（跨 Worker 数据传递的唯一通道）
        const gNow = taskStore.getGroup(group.group_id);
        const doneSiblings = (gNow?.tasks || [])
          .filter((t) => t.status === 'done' && t.taskId !== task.taskId)
          .map((t) => `- ${t.title}：${String(t.result?.summary || '').slice(0, 300)}`);
        // P2-6：分层召回——按「目标+任务标题」查询该空间相关记忆，Top-3 注入
        // R2：空间键统一为 project_path（与 agentRunner 归档同键），历史组无该列时回落 cwd。
        const recallSpace = group.project_path || group.cwd;
        let memoryBlock = '';
        try {
          const blocks = [];
          if (memoryManager && recallSpace) {
            // D-806 / B-11（2026-10-21）：**必须传 scopes 才走分层召回**。
            // 此前只传 spaceId + query，recall() 判定「没有 scopes」→ 走单空间全量旧路径：
            // 没有每层配额、没有跨层同内容去重，session/project/global 混在一起按 tier+时间取 Top-3，
            // 于是「刚说过的工作现场」可能被更久但 tier 更高的项目条目挤掉。
            // 分层口径与主对话（ipc/localData 的 manage 面）同源：session 2 / project 3 / global 2。
            // session 层只在有会话归属时才收——Worker 的会话归属 = 建组时写入的 thread_id
            // （T5-11 已把 threadId 贯穿到建组，`task_groups.thread_id` 是唯一判据）。
            // team 层**不在此列**：它在下面有专用块（独立 label 与 untrusted 包装），并进来会出双份。
            const groupThreadId = group.thread_id || null;
            const scopes = groupThreadId
              ? ['session', 'project', 'global']
              : ['project', 'global'];
            const hits = memoryManager.recallContents({
              spaceId: recallSpace, query: `${group.goal} ${task.title}`, topK: 3,
              domains: ['global_knowledge', 'entity', 'reflection'],
              scopes, conversationId: groupThreadId,
            });
            if (hits.length) {
              const { wrapUntrusted } = await import('../shared/untrustedContent.mjs');
              const raw = hits.map((m) => `- ${m.content.slice(0, 200)}`).join('\n');
              blocks.push(wrapUntrusted(raw, { source: 'memory', label: '相关记忆（历史沉淀，供参考）' }).text);
            }
          }
          // M5 / T5-5：团队层召回——可见范围 = 团队共享 ∪ 自身私有（agentId = 认领成员）。
          // 归属经 teamStore.findTeamByRun 反查（run_id = groupId 是团队↔run 唯一事实来源）；
          // 已归档团队的记忆不参与召回（归档团队的结论只读）。
          const team = teamStore?.findTeamByRun?.(group.group_id);
          if (memoryManager && team && !team.archivedAt) {
            const teamHits = memoryManager.recallTeamMemories({
              teamId: team.id, agentId: task.ownerMemberId || null,
              spaceId: recallSpace, query: `${group.goal} ${task.title}`, topK: 3,
            });
            if (teamHits.length) {
              const { wrapUntrusted } = await import('../shared/untrustedContent.mjs');
              const raw = teamHits.map((m) => `- ${String(m.summary || m.content || '').slice(0, 200)}`).join('\n');
              blocks.push(wrapUntrusted(raw, { source: 'memory', label: '团队记忆（本团队共识与产物索引）' }).text);
            }
          }
          memoryBlock = blocks.join('\n\n');
        } catch (e) { console.warn('[worker] 记忆召回/隔离失败，本任务不带记忆块:', e.message); }
        // DS Bots / T6-11（§6.4 / §10.1）：项目会话只装配四项——固定目标 + 上次摘要 +
        // 未完成待办 + 工件索引；工件正文不进装配（只能用工具按需读）。无项目绑定的普通组返回空串。
        let projectBlock = '';
        try {
          const project = group.thread_id && projectStore?.getProjectByThread
            ? projectStore.getProjectByThread(group.thread_id) : null;
          if (project) {
            projectBlock = projectContext.collectProjectContext({
              project, db: projectStore.db || null, artifactStore, group: gNow,
              currentTaskId: task.taskId,
            });
          }
        } catch (e) { console.warn('[worker] 项目上下文装配失败（fail-open）:', e.message); }
        return [
          `【总体目标】\n${group.goal}`,
          projectBlock,
          doneSiblings.length ? `【已完成前置任务的结论摘要】\n${doneSiblings.join('\n')}` : '',
          memoryBlock,
          `【你的子任务】${task.title}\n${task.prompt}\n\n只完成该子任务，产出可执行的结论；工作目录即项目目录。`,
        ].filter(Boolean).join('\n\n');
      },
      // DS Bots / T6-11（§10.2）：Worker 压缩摘要落 project_runs.summary_json（run_id=group_id），
      // 供下一次装配直接读取；无项目绑定 / 表不可用一律静默跳过。
      saveProjectSummary: (group, summary) => {
        try {
          const project = group && group.thread_id && projectStore?.getProjectByThread
            ? projectStore.getProjectByThread(group.thread_id) : null;
          if (!project) return;
          projectContext.saveRunSummary(projectStore.db || null, {
            runId: group.group_id, projectId: project.projectId, threadId: group.thread_id, summary,
          });
        } catch (e) { console.warn('[worker] 摘要落库异常（不阻塞）:', e.message); }
      },
      // M5 / T5-5：子任务成功结论 → 团队记忆沉淀（宿主侧收口，worker 只透传事实）。
      //   三道闸：① **团队记忆专属开关 `memory.teamAutoCapture`（D-806 / B-12，2026-10-21 解耦）**；
      //   ② 团队归档不写（归档团队记忆只读不参与召回）；
      //   ③ 归属键由 findTeamByRun 反查——认领成员存在则写成员私有，否则写团队共享。
      //   只收成功结论（worker 侧仅对 status=done 调用）；fail-open，绝不阻塞任务收尾。
      //
      //   为什么从 `memory.autoCapture` 解耦出去（原实现与主对话沉淀共用一把闸）：
      //   那把闸默认关，而「团队记忆」是军团的关键卖点之一——默认配置下整条链空转，
      //   等于功能不存在（B-12 的原话是「默认关闭 = 该能力默认不生效」）。
      //   解耦后默认**开**，风险由四处约束兜住：团队内可见（跨团队严格隔离）、
      //   `MAX_TEAM_MEMORIES=200` 硬上限、`source=model_conclusion`（trust 0.6，排位靠后）、
      //   归档团队只读。担心无人值守内容污染的用户可在设置页单独关闭它，而不必连坐全局沉淀。
      rememberTeamMemory: ({ runId, ownerMemberId, title, text, cwd } = {}) => {
        try {
          if (!memoryManager) return;
          // 只有显式 false 才关；未设置 = 默认开（与全局 autoCapture 彻底解耦，互不影响）
          // 判据抽在 main/teamMemoryGate.js（纯函数，可行为测试）
          if (!teamCaptureEnabled((k) => localStore?.getPreference(k))) return;
          const content = String(text || '').trim();
          if (!content) return;
          const team = teamStore?.findTeamByRun?.(runId);
          if (!team || team.archivedAt) return;
          memoryManager.remember({
            spaceId: cwd || team.projectPath || 'default',
            domain: 'global_knowledge',
            scope: 'team',
            teamId: team.id,
            agentId: ownerMemberId || null, // 空 = 团队共享；非空 = 该成员私有
            content: `【团队任务结论】${title ? `${title}：` : ''}${content}`.slice(0, 4000),
            importance: 0.6,
            entityTags: ['team_task_conclusion'],
            source: 'model_conclusion',
          });
        } catch (e) { console.warn('[team-memory] 子任务结论沉淀失败（不阻塞）:', e.message); }
      },
    });

    // DS Bots / T6-7（§6.3）：后台每 60s 做一次滑动老化判定——额度回到下限且利用率低于迟滞水位，
    // 就小批量把 quota_suspend 任务放回 queued 并踢一脚调度（断点续跑，无需用户重述需求）。
    // 单实例：重复初始化（热重启）不叠加定时器；unref 保证定时器不阻止进程退出。
    if (!quotaTickTimer && typeof setInterval === 'function') {
      quotaTickTimer = setInterval(() => {
        try { quotaGate?.tickAll(); } catch (e) { console.warn('[quota] 恢复轮询异常:', e.message); }
      }, 60 * 1000);
      if (typeof quotaTickTimer.unref === 'function') quotaTickTimer.unref();
    }

    orchestrator.initOrchestrator({
      loadAgentCore,
      store: taskStore,
      chatOnce: scheduledAgentChat,
      resolveModel: resolveTaskModel,
      emit: emitTaskEvent,
      runGroup: (gid) => workerPool.runGroup(gid),
    });

    // 崩溃恢复（V14，2026-10-16）：中断的 running 任务 → failed + needsReview（不自动重放——
    // 已执行的副作用无法确认，重放 = 同一操作执行两次且用户不知情）；运行中的组 → paused，
    // 等待用户人工核对后手动续跑。渲染层经 task_update 事件刷新。
    const rec = taskStore.recoverInterrupted();
    if (rec.recoveredTasks.length > 0 || rec.pausedGroups.length > 0) {
      console.log(`[tasks] 崩溃恢复：${rec.recoveredTasks.length} 个中断任务待人工审查，${rec.pausedGroups.length} 个组已暂停（不自动重放副作用）`);
      // N5 副作用账本：各组 uncertain 清单随日志与事件透出（人工核对的输入）
      for (const gid of rec.pausedGroups) {
        const uncertain = taskStore.listUncertainEffects(gid);
        if (uncertain.length > 0) console.log(`[tasks] 组 ${gid} 副作用待核对：${uncertain.join(', ')}`);
      }
      for (const t of rec.recoveredTasks) {
        emitTaskEvent({ type: 'task_update', groupId: t.groupId, taskId: t.taskId, status: 'failed', needsReview: true, error: '应用重启导致执行中断' });
      }
    }
    console.log('[tasks] 任务编排子系统就绪（SQLite 持久化队列 + Worker 池）');
    return true;
  } catch (err) {
    console.error('[tasks] 初始化失败（任务编排不可用）:', err.message);
    taskStore = null;
    dbStatus.markUnavailable(err && err.message);
    return false;
  }
}

// ── 任务编排 IPC（X14：整体搬出 main/ipc/tasks.js）──
// 拆分理由：tasks 域有独立边界（11 条通道 + 载荷契约入口），且本批要在其中加校验。
// **不要**把这理解成「本文件快撞 1500 行门禁了」——`max-lines` 的 max 是**去掉空行与注释**
// 之后的 code 行数（eslint.config.mjs 里 skipBlankLines/skipComments 都为 true）：
// 拆前 raw 1496 但 eslint 实计只有 1093，离 1500 还有 407 行余量。`wc -l` 与这个门禁
// 不是同一把尺子，两者差 400 行上下（2026-10-17 实测）。
// 行为不变；tasks:autoRun / tasks:plan 在模块内加了载荷边界校验，tasks:execute 复用
// taskGroupRefSchema（与 tasks:cancel 同构）。编排状态与初始化仍在本文件，经 getter 注入。
const { initTasksIpc } = require('./ipc/tasks');
initTasksIpc({
  getTaskStore: () => taskStore,
  getLocalStore: () => localStore,
  // V04 治理快照的审批档来源：与模型侧 orchestrate_task 同源（都是用户当前设置）
  getApprovalMode: () => approvalSettings.getUserApprovalMode(),
  emitTaskEvent,
  orchestrator,
  workerPool,
});

// M5 / T5-1：MJ 军团团队层 IPC 域（teams:*）——团队编制读写 + AI 角色草稿。
// chatOnce/resolveModel 与编排/定时任务同源：AI 草稿走既有模型通道，不新起调用路径。
// 模块引用已在上方（T5-8 工具工厂需要 postTeamMessage）；此处只做依赖注入。
// 2026-10-21 团队调试日志：团队链路的日志目录与运行时元信息在此注入（whenReady 后 getPath 才可靠）。
// 默认开启记录 + 详细模式；用户可在团队页随时关闭，导出走 teams:debugExport。
teamDebug.initTeamDebugLog({
  dir: path.join(app.getPath('userData'), 'logs'),
  meta: {
    // app.getVersion 在部分测试宿主 / 旧版 mock 上不存在 → 防御式取值（与启动横幅同口径），
    // 否则顶层直接调用会让整个 main.js 在 require 阶段抛错（真机则表现为启动即崩）。
    version: typeof app.getVersion === 'function' ? app.getVersion() : 'unknown',
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
  },
});
initTeamDebugIpc();
// DS Bots / T6-2：项目空间 IPC——getter 注入与 getTeamStore 同款，装配顺序无关
initProjectsIpc({
  getProjectStore: () => projectStore,
  // T6-9：初始化链路需要协作的四个子系统，同样用 getter 注入避免装配顺序耦合；
  // localStore 在 whenReady 后赋值，调用发生在渲染层点击时，无需等待。
  getArtifactStore: () => artifactStore,
  getQuotaLedger: () => quotaLedger,
  getTeamStore: () => teamStore,
  getLocalStore: () => localStore,
  audit,
});
// DS Bots / T6-10：只读域装配。**必须传 getter**：本函数在顶层执行，此刻存储全为 null（等 setupTaskOrchestration
// 异步跑完才赋值），传裸变量会把 null 快照进被调方闭包 ⇒ 账本恒 UNAVAILABLE、工件/Studio/知识库同样拿不到数据。
registerDomainIpc({ getArtifactStore: () => artifactStore, getProjectStore: () => projectStore, getTeamStore: () => teamStore, getTaskStore: () => taskStore, getTaskDb: () => taskDb, audit, getMainWindow: () => mainWindow, getFlags: () => featureFlags });
initTeamsIpc({
  getTeamStore: () => teamStore,
  // M5 / T5-6：对话内团队事件流按 thread_id 反查 run（task_groups 是「run 属于哪个会话」的
  // 唯一事实源）；用 getter 注入与 getTeamStore 同款，避免装配顺序耦合。
  getTaskStore: () => taskStore,
  audit,
  chatOnce: scheduledAgentChat,
  resolveModel: resolveTaskModel,
  // T5-2：消息总线事件出口（落库后广播，渲染层时间轴实时追加）
  emitTeamsEvent,
  // T5-7：成员模型绑定的展示标签在本机解析（渲染层不实现引用串格式，避免格式漂移）
  getProviders: () => (localStore ? localStore.listProviders() : []),
  // T5-4：派活链路复用既有编排器（planGoal 拆解建组）与 Worker 池（runGroup 执行），
  // 两模块在 setupTaskOrchestration 已初始化且与 tasks:* 同源——不新起第二条编排实现。
  orchestrator,
  workerPool,
  // M5 / T5-11：成员会话重置（teams:resetMemberSession）——「重置」= 清该成员断点 +
  // 其私有记忆降权，两件事都复用既有单例，不新起存储：
  //   · clearCheckpoint 走 checkpointStore（与 checkpoint:clear 同一事实来源）；
  //   · getMemoryManager 必须传 getter 而非实例——本行执行时 memoryManager 尚未赋值
  //     （它在上面的 initDb 回调里创建），闭包在 handler 调用时才求值，与 999 行 remember
  //     注入同款，装配顺序无关。
  clearCheckpoint: (key) => checkpointStore.clearCheckpoint(key),
  getMemoryManager: () => memoryManager,
  // M5 / T5-10：中断入口（teams:interrupt）。用户主体经此进入统一矩阵；
  // 策略/执行/留痕全在 teamInterrupt 内，IPC 层不复制任何权限判断。
  // 第八轮 B-07：不再硬编码 'user' —— 交 `resolveActor` 解析（未声明/非法回落 user，fail-closed），
  // 否则 lead/member 两条分支与理由/逐次确认两处判据在生产永远走不到（治理承诺变死代码）。
  interruptTask: (p) => teamInterrupt.interruptTask({ ...p, ...teamInterrupt.resolveActor(p) }),
});

// M5 / T5-10：中断模块依赖注入（必须在 initTeamsIpc 之后——postTeamMessage 的 deps 即由
// 上一步注入；提前调用会让中断留痕读到空 deps，表现为「任务停了但没有系统消息」）。
teamInterrupt.initTeamInterrupt({
  getTeamStore: () => teamStore,
  getTaskStore: () => taskStore,
  workerPool,
  emit: emitTaskEvent,
  postMessage: postTeamMessage,
});

// ═══════════════════════════════════════════
//  COMPUTER USE (M4-C)：macOS AX 结构化界面自动化
//  事件契约与实现细节见 computerUse.js 头部注释
// ═══════════════════════════════════════════
const cua = require('./computerUse');
// T3-6：高风险原生执行下沉独立子进程——osascript 键鼠执行/AX 采集不再跑在主进程里，
// 崩溃或挂起只影响单步：宿主透明重启重试，超限抛能力降级错误经 cua:event 提示（主会话不崩）。
// utilityProcess 不可用（单测 stub 环境）时 isAvailable()=false，回退主进程直调（T3-7 同纪律）。
const cuaProcess = require('./cuaProcess/host');
cuaProcess.initCuaProcess({});
// T4-6：操作录制与回放——LLM 跑通的任务录成确定性 AX 脚本，回放不调模型
const cuaRecorder = require('./cuaRecorder');
const cuaRecordingsDir = () => path.join(app.getPath('userData'), 'recordings');
let activeCuaLoop = null; // 当前进行中的 CUA 循环（供 cua:stop 中断）
let activeReplayLoop = null; // 当前进行中的回放循环（与录制互斥，共用 stop）

// CUA 逐次确认弹窗：独立通道，避免与并行工具审批（tool:approval-response）互相串扰
// 决策不进入 applyApprovalDecision 规则库 —— 敏感动作必须逐次确认，不可会话/永久放行
//
// P0 修复（2026-10-16）：原实现是 `ipcMain.once('cua:approval-response')`——
// 即 main.js:54 注释所述 P0-2 缺陷在 CUA 通道的重演（tool: 通道早已用
// ApprovalChannel 按 approvalId 精确分发修掉，此处漏改）。后果：
//   ① 每次请求都注册一个新的一次性监听器，并发两个 CUA 确认时，
//      先到的响应被「先注册的那个」消费 ⇒ 决策张冠李戴。CUA 要求逐次确认，
//      张冠李戴的后果比工具审批更严重（把「允许」发给另一条敏感动作）；
//   ② 超时分支只 resolve 不摘监听器 ⇒ 监听器残留，可能吃掉后续无关响应。
// 现与 tool: 通道同款：生成 approvalId → 按 id 精确分发；无 id 的旧响应走
// dispatchLegacy（仅在恰有一个挂起时按唯一挂起处理，多于一个则拒绝猜测、按超时 deny）。
const cuaApprovalChannel = new ApprovalChannel({ timeoutMs: 120000 });
ipcMain.on('cua:approval-response', (_, payload) => {
  const hasId = payload && typeof payload === 'object' && payload.approvalId;
  const dispatched = hasId
    ? cuaApprovalChannel.dispatch(payload.approvalId, payload.decision, payload.reason)
    : cuaApprovalChannel.dispatchLegacy(null, payload && payload.decision !== undefined ? payload.decision : payload); // P2-3：无 id 一律拒绝并告警
  if (!dispatched) {
    console.warn('[cua] 收到无法匹配的审批响应，已忽略（fail-closed，按 deny 收尾）');
  }
});

function requestCuaApproval(summary) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve('deny');
  const approvalId = cuaApprovalChannel.nextId();
  // 无论以何种方式收尾（含超时）都通知渲染层撤下卡片——否则卡片常驻，
  // 用户再点时主进程已无挂起项，表现为「点了没反应」
  const settled = cuaApprovalChannel.wait(approvalId, () => {
    try { mainWindow?.webContents?.send('cua:approval-settled', { approvalId }); }
    catch { /* 窗口已销毁 */ }
  });
  mainWindow.webContents.send('cua:approval-request', { ...summary, approvalId });
  return settled;
}

// CUA 循环用非流式 chat（复用 model:chat 同款凭证解析结果）
async function cuaChat(root, apiKey, model, messages) {
  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

// ═══════════════════════════════════════════
//  G-CUA：模型可调用的 computer_use 工具
//  把既有的 CUA 循环接到「模型的工具调用面」上——此前 CUA 只能由设置页的录制/回放面板触发，
//  模型（Agent 对话）无法直接调用（差距审查：有实现、有设置页入口，缺模型可调用入口）。
//
//  与 cua:run 的三点关键差异：
//   ① 本函数是**阻塞式**的（await loop.run() 后把结果回填给模型），不是 fire-and-forget；
//   ② 顶层授权 + 逐次动作确认都走**标准审批中心**（tool:approval-request → 全局 ApprovalCard），
//      因为模型发起的调用发生在对话里，用户在对话界面必须能看到卡片；
//      cua:approval-request 的 UI 只在设置页录制面板里，对话中不可见 → 走自有通道会「卡死无卡」；
//   ③ 门控：仅 macOS + 用户已在设置中开启「界面自动化」时，引擎才会把该工具放进 tools 数组
//      （见 agent-core 的 computerUseEnabled + V02 白名单守卫）；此处再做平台/权限/凭证兜底。
async function toolComputerUse(args = {}, ctx = {}) {
  const objective = String(args.objective || '').trim();
  const appName = String(args.app_name || args.appName || '').trim();
  if (!objective || !appName) return { ok: false, error: 'objective 与 app_name 必填' };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  // 同一时刻只允许一个 CUA 循环（与 cua:run / cua:replay 共用同一把锁）——模型与设置页不并发操作桌面
  if (activeCuaLoop || activeReplayLoop) return { ok: false, error: '已有进行中的界面自动化任务，请先停止' };
  // 顶层授权：L1 逐次确认（任何审批档都弹卡），决策不落规则库（NON_REMEMBERABLE）。
  // 由本 handler 自行把关——引擎的 APPROVAL_TOOLS 仅注入治理字段，不代为弹卡。
  // fail-closed：仅 'once'（允许一次）放行；'deny'/超时/其他一律视为拒绝。
  const topDecision = await requestApproval('computer_use', {
    objective,
    app_name: appName,
    max_steps: args.max_steps,
    allowed_apps: args.allowed_apps,
  });
  if (topDecision !== 'once') return { ok: false, error: '用户未批准界面自动化调用（已按 fail-closed 拒绝）' };
  // 原生执行会话（每 run 一个子进程，惰性 spawn，finally dispose）——与 cua:run 同纪律
  const cuaSession = cuaProcess.isAvailable() ? cuaProcess.createSession() : null;
  const cuaExec = (name, ...a) => (cuaSession ? cuaSession.call(name, ...a) : cua[name](...a));
  const dispose = () => { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } };
  if (!(await cuaExec('isAccessibilityGranted'))) {
    dispose();
    return { ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' };
  }
  // 凭证解析：与 model:chat 同款（本地优先）。ctx.model 为引擎侧嵌套形（provider/model 分离）
  const m = ctx.model || {};
  const providerId = m.provider?.id;
  const isGlobal = !!m.provider?.isGlobal;
  const modelId = m.model?.model_id || m.model || '';
  const secret = resolveSecret(providerId, isGlobal);
  if (!secret || !secret.api_key) { dispose(); return { ok: false, error: 'KEY_MISSING: 模型凭证未加载，请在本机模型设置中重新填写 API Key' }; }
  const root = (m.provider?.base_url || secret.base_url || '').replace(/\/+$/, '');
  if (!root) { dispose(); return { ok: false, error: 'BASE_URL_MISSING: 模型服务地址为空' }; }
  if (!modelId) { dispose(); return { ok: false, error: 'MODEL_MISSING: 当前会话未指定模型' }; }

  const maxSteps = Math.min(15, Math.max(1, Number(args.max_steps) || 15));
  const allowedApps = Array.isArray(args.allowed_apps) && args.allowed_apps.length
    ? args.allowed_apps.map((x) => String(x))
    : [appName];
  const loop = new cua.ComputerUseLoop({
    objective,
    appName,
    maxSteps,
    model: modelId,
    // 审批档入参钳制：取「本 run 档 与 用户设置档」中更严者（与本项目 no-unattended-weaker 纪律一致）
    approvalMode: agentRunner.stricterApproval(ctx.approvalMode || 'on-request', approvalSettings.getUserApprovalMode()),
    allowedApps,
    toolHandlers: {
      // chat 留主进程（凭证不出界）；原生执行面全部经子进程会话（T3-6）
      chat: (messages) => cuaChat(root, secret.api_key, modelId, messages),
      collectAx: (name) => cuaExec('collectAxTree', name || appName),
      perform: (action, node) => cuaExec('performAction', action, node, { appName: appName || node?.name || '' }),
      isLocked: () => cuaExec('isScreenLocked'),
      captureScreen: () => cuaExec('captureScreen'), // M6 视觉兜底（AX 覆盖不足时）
    },
    approval: {
      // 逐次动作确认 → **标准审批中心**（tool:approval-request → 全局 ApprovalCard 在对话中可见）。
      // 决策不调 applyApprovalDecision ⇒ 敏感动作逐次确认、不落「始终允许」规则（与设计一致）。
      requestApproval: (summary, action, node) => requestApproval('cua_action', {
        action: action?.action || '',
        text: action?.text,
        key: action?.key,
        label: action?.label,
        target: node?.name || node?.value || action?.target || '',
      }),
      // 全部动作脱敏审计上报（审批结果随行）
      audit: (step, actionText, result) => audit('cua', appName, `step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    hud: cua.createHudWindow(BrowserWindow),
    onEvent: (evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cua:event', evt);
    },
  });
  activeCuaLoop = loop;
  // 运行中止（用户点停止/切会话）→ 立即中断循环（与 cua:run 的 cua:stop 同源）
  if (ctx.signal) ctx.signal.addEventListener('abort', () => loop.stop(), { once: true });

  let res;
  try {
    res = await loop.run();
  } catch (err) {
    return { ok: false, error: `界面自动化执行失败：${err.message}${err.cuaDegraded ? '（能力降级）' : ''}` };
  } finally {
    activeCuaLoop = null;
    cua.destroyHud();
    dispose();
  }
  if (res && res.completed) {
    return { ok: true, completed: true, steps: res.step, summary: `界面自动化已完成目标「${objective}」（应用：${appName}，共 ${res.step} 步）` };
  }
  if (res && res.maxStepsReached) {
    return { ok: false, completed: false, maxStepsReached: true, error: `已达最大步数上限（${res.step} 步），目标未确认完成` };
  }
  return { ok: false, stopped: true, error: '界面自动化任务被用户停止/拒绝，未完成' };
}

ipcMain.handle('cua:status', async () => {
  // 能力矩阵：截图/屏幕尺寸已跨平台（win32 PowerShell / linux scrot 链），
  // AX 树与键鼠执行仍 macOS 独有。UI 据此只隐藏不可用的部分，不再笼统报「仅 macOS」。
  const support = cua.cuaSupport();
  if (!support.automation) {
    return {
      available: false,
      granted: false,
      ...support,
      message: support.message,
    };
  }
  const granted = await cua.isAccessibilityGranted();
  return {
    available: true,
    granted,
    ...support,
    message: granted
      ? ''
      : '未授予辅助功能权限：请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用后重试',
  };
});

// 授权引导（2026-10-19）：按操作系统分派「去哪里授权 / 为什么当前不可用」。
// 只有 macOS 存在真正的系统授权项（辅助功能 Accessibility），用官方深链直达该面板；
// Windows 的键鼠执行需等 UIA 实现、Linux 依赖截图工具链，均无系统授权项 → 返回结构化 code，
// 由渲染层按平台展示分步指引（i18n 文案留在渲染层，IPC 只回结构化结果，不传文案载荷）。
// 深链协议不走 shell:openExternal（exec.js 只放行 http/https），此处用主进程 shell 直连。
const CUA_MAC_ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
ipcMain.handle('cua:permission-help', async (_, payload = {}) => {
  const platform = process.platform;
  if (platform !== 'darwin') {
    return {
      ok: true,
      platform,
      code: platform === 'win32' ? 'win_uia_pending' : 'linux_deps',
      canOpen: false,
      opened: false,
    };
  }
  if (payload?.open !== true) {
    return { ok: true, platform, code: 'mac_accessibility', canOpen: true, opened: false };
  }
  try {
    // 固定常量深链，不接受渲染层传入地址（防协议注入）
    await shell.openExternal(CUA_MAC_ACCESSIBILITY_URL);
    return { ok: true, platform, code: 'mac_accessibility', canOpen: true, opened: true };
  } catch (e) {
    return { ok: false, platform, code: 'mac_accessibility', canOpen: true, opened: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('cua:run', async (_, { objective, appName, approvalMode = 'on-request', conversationId, model, providerId, isGlobal = false, baseUrl, allowedApps, maxSteps, record = false, recordingName = '' }) => {
  if (activeCuaLoop || activeReplayLoop) return { ok: false, error: '已有进行中的界面自动化任务，请先停止' };
  if (!objective || !appName) return { ok: false, error: 'objective 与 appName 必填' };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  // X14：objective/appName 会进模型上下文并被审计落盘，allowedApps 是执行白名单——
  // 形状与长度先在边界守住（非字符串 allowedApps 会让 ComputerUseLoop 以为带了白名单）。
  // 注意 providerId 不在此列：本机 provider 是数字 id、服务端是 's...' 前缀串，两种形态都合法。
  try {
    guard.assertStrings({ objective, appName, model, baseUrl, conversationId, recordingName }, {
      objective: 20000,
      appName: 200,
      model: { max: 200, optional: true, allowEmpty: true },
      baseUrl: { max: 2000, optional: true, allowEmpty: true },
      conversationId: { max: 200, optional: true, allowEmpty: true },
      recordingName: { max: 200, optional: true, allowEmpty: true },
    });
    if (allowedApps !== undefined) guard.assertArray({ allowedApps }, 'allowedApps', { max: 50 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // T3-6：原生执行会话（每 run 一个子进程，惰性 spawn，finally dispose）
  const cuaSession = cuaProcess.isAvailable() ? cuaProcess.createSession() : null;
  const cuaExec = (name, ...args) => (cuaSession ? cuaSession.call(name, ...args) : cua[name](...args));
  const bail = async (result) => { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } return result; };
  if (!(await cuaExec('isAccessibilityGranted'))) {
    return bail({ ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' });
  }
  // 凭证解析：与 model:chat 同款（本地优先）
  const secret = resolveSecret(providerId, isGlobal);
  if (!secret || !secret.api_key) return bail({ ok: false, error: 'KEY_MISSING: 模型凭证未加载，请在本机模型设置中重新填写 API Key' });
  const root = (baseUrl || secret.base_url || '').replace(/\/+$/, '');
  if (!root) return bail({ ok: false, error: 'BASE_URL_MISSING: 模型服务地址为空' });

  const send = (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cua:event', evt);
  };
  // T4-6 录制模式：累积实际执行成功的 AX 步骤（每步截图），run 完成后整体落盘；
  // 视觉兜底步骤（node=null）不可确定性回放，不入录制。
  const rec = record ? {
    id: cuaRecorder.newRecordingId(),
    name: String(recordingName || objective).slice(0, 80),
    steps: [],
  } : null;
  let recChain = Promise.resolve(); // 截图串行链：保证步骤序号与落盘顺序一致
  let recCounter = 0; // 步骤序号独立计数（截图异步，不能依赖 steps.length——链未 flush 时会重复）
  const onEvent = (evt) => {
    if (rec && evt.type === 'step' && evt.mode !== 'vision' && evt.node && evt.result?.ok) {
      const index = ++recCounter;
      const step = cuaRecorder.sanitizeStep(evt, index);
      recChain = recChain.then(async () => {
        try {
          const shot = await cua.captureScreen();
          if (shot && shot.dataUrl) {
            step.screenshotFile = cuaRecorder.writeScreenshot(rec.id, index, shot.dataUrl, { dir: cuaRecordingsDir() });
          }
        } catch (e) { console.warn('[cua] 录制截图失败（不影响步骤）:', e.message); }
        rec.steps.push(step);
      });
    }
    send(evt);
  };
  const hud = cua.createHudWindow(BrowserWindow);
  const loop = new cua.ComputerUseLoop({
    objective,
    appName,
    maxSteps,
    model,
    // P1-2：审批档入参钳制——取「调用方传入 与 用户当前档」中更严者（地板语义），
    // 渲染层被注入脚本传弱档（never）不再生效；敏感动作逐次确认不受档位影响（设计不变）
    approvalMode: agentRunner.stricterApproval(approvalMode || 'on-request', approvalSettings.getUserApprovalMode()),
    allowedApps: allowedApps || [appName],
    toolHandlers: {
      // chat 留主进程（凭证不出界）；原生执行面全部经子进程会话（T3-6）
      chat: (messages) => cuaChat(root, secret.api_key, model, messages),
      collectAx: (name) => cuaExec('collectAxTree', name || appName),
      perform: (action, node) => cuaExec('performAction', action, node, { appName: appName || node?.name || '' }),
      isLocked: () => cuaExec('isScreenLocked'),
    },
    approval: {
      requestApproval: (summary) => requestCuaApproval(summary),
      // 全部动作脱敏审计上报（审批结果随行）
      audit: (step, actionText, result) => audit('cua', appName, `step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    hud,
    onEvent,
  });
  activeCuaLoop = loop;
  loop.run()
    // T4-6：任务成功完成且有已执行步骤 → 录制落盘；中途失败/停止 → 清理半成品截图不留脏数据
    .then(async (res) => {
      if (!rec) return;
      await recChain;
      if (res && res.completed && rec.steps.length) {
        const saved = cuaRecorder.saveRecording(
          { version: 1, id: rec.id, name: rec.name, objective, appName, createdAt: Date.now(), steps: rec.steps },
          { dir: cuaRecordingsDir() },
        );
        if (saved.ok) send({ type: 'recorded', recordingId: rec.id, stepCount: rec.steps.length });
        else send({ type: 'error', message: saved.error });
      } else if (rec.steps.length) {
        cuaRecorder.deleteRecording(rec.id, { dir: cuaRecordingsDir() });
      }
    })
    // cuaDegraded：子进程重启超限——消息本身即能力降级提示（degraded 标记供渲染层区分展示）
    .catch((err) => send({ type: 'error', message: err.message, degraded: !!err.cuaDegraded }))
    .finally(() => {
      activeCuaLoop = null;
      cua.destroyHud();
      try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); }
    });
  return { ok: true };
});

ipcMain.handle('cua:stop', async () => {
  if (activeReplayLoop) { activeReplayLoop.stop(); return { ok: true }; }
  if (!activeCuaLoop) return { ok: false, error: '没有进行中的界面自动化任务' };
  activeCuaLoop.stop();
  // P1-24：停止运行时统一撤下挂起的 CUA 确认卡（按 deny 收尾）——
  // 此前卡残留：循环已死、卡还在，用户点「允许」打到已无消费者的通道上
  try { cuaApprovalChannel.disposeAll(); } catch (e) { console.warn('[cua] 撤卡失败:', e.message); }
  return { ok: true };
});

// T4-6：确定性回放——不调模型，按录制步骤逐一「定位节点→（敏感则逐次确认）→执行」；
// 节点定位失败 fail-closed 中止；审批/审计与录制路径共用同一套通道（requestCuaApproval/audit）
ipcMain.handle('cua:replay', async (_, { recordingId, approvalMode = 'on-request' } = {}) => {
  if (activeCuaLoop || activeReplayLoop) return { ok: false, error: '已有进行中的界面自动化任务，请先停止' };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  // X14：recordingId 会拼成录制文件路径（cuaRecorder 内部另有净化），边界先守类型与长度
  try {
    guard.assertStrings({ recordingId }, { recordingId: { max: 200, optional: true, allowEmpty: true } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const loaded = cuaRecorder.loadRecording(String(recordingId || ''), { dir: cuaRecordingsDir() });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const recording = loaded.recording;
  const cuaSession = cuaProcess.isAvailable() ? cuaProcess.createSession() : null;
  const cuaExec = (name, ...args) => (cuaSession ? cuaSession.call(name, ...args) : cua[name](...args));
  const bail = (result) => { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } return result; };
  if (!(await cuaExec('isAccessibilityGranted'))) {
    return bail({ ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' });
  }
  const send = (evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cua:event', { mode: 'replay', ...evt });
  };
  const loop = new cuaRecorder.ReplayLoop({
    recording,
    // P1-2：同 cua:run——审批档入参钳制（更严者生效）
    approvalMode: agentRunner.stricterApproval(approvalMode || 'on-request', approvalSettings.getUserApprovalMode()),
    toolHandlers: {
      collectAx: (name) => cuaExec('collectAxTree', name || recording.appName),
      perform: (action, node) => cuaExec('performAction', action, node, { appName: recording.appName || node?.name || '' }),
    },
    approval: {
      requestApproval: (summary) => requestCuaApproval(summary),
      audit: (step, actionText, result) => audit('cua', recording.appName, `replay step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    onEvent: send,
  });
  activeReplayLoop = loop; // eslint-disable-line require-atomic-updates -- 互斥守卫已在 await 前检查，单窗口串行赋值安全
  loop.run()
    .catch((err) => send({ type: 'error', message: err.message, degraded: !!err.cuaDegraded }))
    .finally(() => {
      activeReplayLoop = null;
      try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); }
    });
  return { ok: true };
});

// 录制列表/删除（数据仅存本机 userData/recordings/，不上传）
ipcMain.handle('cua:recordings:list', async () => ({
  ok: true,
  recordings: cuaRecorder.listRecordings({ dir: cuaRecordingsDir() }),
}));
ipcMain.handle('cua:recordings:delete', async (_, { recordingId } = {}) => {
  // X14：删除录制会真的 unlink 用户文件，recordingId 走文件路径拼接——先守形状与长度
  try {
    guard.assertStrings({ recordingId }, { recordingId: { max: 200, optional: true, allowEmpty: true } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const r = cuaRecorder.deleteRecording(String(recordingId || ''), { dir: cuaRecordingsDir() });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
});
// ═══════════════════════════════════════════
//  END COMPUTER USE (M4-C)
// ═══════════════════════════════════════════
