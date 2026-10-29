// T2-1：MCP 与杂项 IPC 域（自主进程 main.js 原样搬移，行为不变）
// 覆盖：MCP 配置持久化（userData/mcp-servers.json + env 白名单）/ 连接·断开·调用·重连 /
//       P0-F 沙箱状态查询 / P0-E GitHub 最小闭环（gh CLI 封装）IPC / 语音本地转写。
//
// 依赖注入：initMcpIpc({ requestApproval, applyApprovalDecision, getAlwaysRules,
//                        conversationRules, audit, emitTaskEvent, getCredentialCrypto })
//   - shellEnv 来自工具执行层（与 toolShell 同一 PATH 注入，MCP spawn 复用）；
//   - emitTaskEvent 归属任务编排域（main.js），MCP 状态事件经注入转发；
//   - getCredentialCrypto 供 T7 OAuth 引擎加密落盘令牌（whenReady 后才存在，故 getter）。
const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const approval = require('../approval');
// P2-7：用户偏好「执行后告知」（正交布尔，缺省关闭）
const approvalSettings = require('../approvalSettings');
const mcp = require('../mcpClient');
const { newProgressToken, makeProgressBridge, settleProgress } = require('../mcpProgress'); // P3-1：进度桥（令牌 + 事件整形 + 收尾，与 IPC 无关故外置）
// P1-3：MCP 崩溃后的自动重连调度（指数退避 + 上限 + 幂等）
const { createMcpAutoReconnect } = require('../mcpAutoReconnect');
// 2026-10-18：stdio 启动参数守卫（占位符未替换 / 空参数 → spawn 前 fail-closed）
const { checkStdioSpawn } = require('../mcpSpawnGuard');
const guard = require('./payloadGuard');
const sandbox = require('../sandbox');
const github = require('../github');
const voice = require('../voice');
const { McpAuthManager } = require('../mcpAuth');
// P0-5①：落盘必须显式设权限（对齐 mcpAuth.js:67 的正例）——配置文件含用户自配凭证
const { writeFileDurableWithMode } = require('../data/durableWrite');
const { shellEnv } = require('../tools/exec');
// 期 1（2026-10-18）：懒启动地基——预热白名单/灰度开关（mcpPrewarm）+ 工具清单缓存（mcpToolCache）
// 期 2（2026-10-18）：三层分级（auto-start/whitelist/manual）+ profile 分流 + 治理偏好读写
const { isLazyMode, autoStartConfigs, normalizeProfile, readGovernance, classifyTier, TIER, PROFILES } = require('../mcpPrewarm');
const { createMcpToolCache } = require('../mcpToolCache');

// 期 2：治理偏好存储在 localStore 的偏好键中（与其它用户偏好同源），默认值由 readGovernance 兜底。
const GOVERNANCE_PREF_KEY = 'mcp_governance';

const mcpServers = { get: (n) => mcp.getMcpServer(n), names: () => mcp.listMcpServers() };

// 第八轮 F-005 / B1-B-05：工具名编解码器（ESM，主进程经动态 import 加载，与
// intentMcpPrewarm.loadMcpToolDefs 同一写法：纯函数、零 electron 依赖，首调后缓存）。
// 用途：连接前先验证「本服务名产出的工具名能被唯一反解回该服务名」，
// 避免一个拼不出可逆名字的服务被写入配置、之后每一次工具调用都打到错的服务上。
let _mcpNameCodecMod = null;
function loadMcpNameCodec() {
  if (!_mcpNameCodecMod) _mcpNameCodecMod = import('../../shared/mcpNameCodec.mjs');
  return _mcpNameCodecMod;
}

// F-014 / A16c（结构化输出消费）：结果侧策略模块（ESM）的模块级缓存动态 import —— 与上面
// loadMcpNameCodec / intentMcpPrewarm.loadMcpToolDefs 同一写法：shared 是 ESM、本文件是 CJS，
// 纯函数零 electron 依赖，首调后缓存。刻意**不在文件顶层 await**：那会让整个 ipc/mcp 域
// （含全部 IPC 注册）的加载被一次动态 import 拖住。
let _structuredOutputMod = null;
function loadStructuredOutputPolicy() {
  if (!_structuredOutputMod) _structuredOutputMod = import('../../shared/mcpToolDefs.mjs');
  return _structuredOutputMod;
}

// 期 1：工具清单缓存（落 userData/mcp-tool-manifests.json，0600）。懒建——app 就绪后才可 getPath。
let toolCache = null;
function getToolCache() {
  if (toolCache) return toolCache;
  toolCache = createMcpToolCache({
    filePath: path.join(app.getPath('userData'), 'mcp-tool-manifests.json'),
    // B2-B-12 移交项：此前**没有**注入 audit —— mcpToolCache 早已支持可选 audit 依赖，
    // 但构造处没接线，于是「工具定义超限」只在内存里留一行 warn，落不到
    // userData/audit-log.jsonl。后果：缓存文件里只剩**截断后**的描述，事后追问
    // 「这个服务的描述原本有多大 / 是被我们压小的还是本来就小」时没有任何可查证据。
    //
    // 这里注入的是**适配器**而不是 deps.audit 本身，因为两者签名不同：
    //   · mcpToolCache 的契约是 audit(event, payloadObject)（见 mcpToolCache.js 头注释）；
    //   · auditLog 的契约是 audit(action, target, detail, approvalResult)（见 audit/auditLog.js）。
    // 适配后本地审计行形如：
    //   action=mcp:toolDefLimited  target=mcp:<server>
    //   detail="tool=<名> description=<原始>/<上限>chars stored=<落盘后>chars schema=... reason=..."
    //   approval_result=limited
    audit: (event, payload) => {
      try {
        // 契约外的未知事件不入审计：审计口径只认这一个事件名，避免将来 mcpToolCache
        // 新增事件时被这里无意识地塞进审计日志污染统计。
        if (event !== 'mcp_tool_def_limited') return;
        const p = payload && typeof payload === 'object' ? payload : {};
        const limits = p.limits && typeof p.limits === 'object' ? p.limits : {};
        deps.audit(
          'mcp:toolDefLimited',
          p.server ? `mcp:${p.server}` : '',
          `tool=${p.tool || ''}`
            + ` description=${p.descriptionChars || 0}/${limits.descriptionChars || 0}chars`
            + ` stored=${p.storedDescriptionChars || 0}chars`
            + ` schema=${p.schemaBytes || 0}/${limits.schemaBytes || 0}bytes`
            + ` depth=${p.schemaDepth || 0}/${limits.schemaDepth || 0}`
            + ` reason=${p.reason || ''}`,
          'limited',
        );
      } catch { /* 审计是可丢失遥测：写失败绝不影响缓存落盘（缓存是懒启动的前提） */ }
    },
  });
  return toolCache;
}

// 期 2：读当前治理配置（档位 profile / 文件能力 fsMode / 沙盒网络沙盒开关）。
// 存储在 localStore 偏好（whenReady 后就绪，故经 deps.getLocalStore getter 读取，缺省回最保守档）。
function getGovernance() {
  const store = deps && deps.getLocalStore ? deps.getLocalStore() : null;
  return readGovernance(store ? store.getPreference(GOVERNANCE_PREF_KEY) : null);
}

// MCP 配置持久化（userData/mcp-servers.json）+ 子进程 env 白名单
const MCP_CONFIG_FILE = () => path.join(app.getPath('userData'), 'mcp-servers.json');
const ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'TMPDIR', 'NODE_ENV'];
// P0-5①：仅本人可读写（POSIX）；Windows 上 chmod 语义受限，durableWrite 会如实上报 modeApplied=false
const MCP_CONFIG_MODE = 0o600;
// P0-5①：受保护 env 键——用户 env **只能补充**这些之外的键，不能覆盖它们。
// 为什么要拦：spawn({env}) 会**完全替换**父进程环境，PATH 被覆盖即等价于「子进程可劫持任意可执行文件」；
// HOME/SHELL/TMPDIR 被覆盖会把服务进程的读写重定向到用户指定位置（沙箱外副作用）。
const PROTECTED_ENV = new Set([...ENV_WHITELIST, 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']);

let deps = null;
// P1-3：自动重连调度器（initMcpIpc 内建；connectMcpServer 的 onStatus 会驱动它）
let autoReconnect = null;

// T7：OAuth 令牌管理器（懒建：凭证加密就绪才可用；令牌加密落 userData/mcp-oauth.json）。
// 授权窗口用独立 BrowserWindow（无 preload、沙箱化），loopback 收到回调即由引擎关窗。
let oauthManager = null;
function getOauthManager() {
  if (oauthManager) return oauthManager;
  const cc = deps && deps.getCredentialCrypto ? deps.getCredentialCrypto() : null;
  if (!cc) return null;
  oauthManager = new McpAuthManager({
    storeFile: path.join(app.getPath('userData'), 'mcp-oauth.json'),
    credentialCrypto: cc,
    openAuthWindow: (url) => {
      const win = new BrowserWindow({
        width: 900, height: 700,
        title: '服务授权',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.loadURL(url).catch(() => { /* 加载失败由回调超时如实透出 */ });
      return { close: () => { try { if (!win.isDestroyed()) win.close(); } catch { /* 已关闭 */ } } };
    },
    log: (line) => console.warn('[mcp-oauth]', line),
  });
  return oauthManager;
}

// P0-持久化（2026-10-16）修复两处：
//   ① saveMcpConfig 此前裸 writeFileSync（无 tmp+rename、无 fsync），崩溃写坏即全部配置消失；
//   ② loadMcpConfig 此前把「文件损坏」与「尚未配置」当同一回事，catch 里一律 return []
//      且不留下任何痕迹——用户配好的 MCP 服务无声消失，却不知道为什么。
function loadMcpConfig() {
  const file = MCP_CONFIG_FILE();
  if (!fs.existsSync(file)) return []; // 尚未配置过，正常
  // P0-5①：历史版本以 0644 落盘（实测 11 个服务的文件就是 0644）——读取时自愈收紧，
  // 只改权限、不动内容，避免升级后仍长期处于「同机其他用户可读凭证」的状态。
  try {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode !== MCP_CONFIG_MODE) {
        fs.chmodSync(file, MCP_CONFIG_MODE);
        console.warn(`[mcp] 已将 ${file} 权限从 ${mode.toString(8)} 收紧为 ${MCP_CONFIG_MODE.toString(8)}`);
      }
    }
  } catch (e) {
    console.warn('[mcp] 配置文件权限收紧失败:', e.message);
  }
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('结构非法：顶层不是数组');
    return list;
  } catch (e) {
    const kept = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, kept); } catch { /* 保留失败不阻断 */ }
    console.error(`[mcp] 配置文件损坏：${e.message}；已保留副本 ${kept}。请从副本恢复或重新配置 MCP 服务。`);
    return [];
  }
}

function saveMcpConfig(list) {
  try {
    const res = writeFileDurableWithMode(MCP_CONFIG_FILE(), JSON.stringify(list, null, 2), MCP_CONFIG_MODE);
    if (!res.ok) {
      // 落盘失败绝不静默：下次重启会「服务全红且配置消失」，用户无从归因
      console.warn('[mcp] 配置持久化失败:', res.error);
    } else if (!res.modeApplied) {
      console.warn(`[mcp] 权限未收紧（chmod ${MCP_CONFIG_MODE.toString(8)} 失败）：${res.error || '未知原因'}；该文件含凭证，请手动检查权限`);
    }
  } catch (e) {
    console.warn('[mcp] 配置持久化异常:', e.message);
  }
}

// P0-5③：用户 env 的「可落盘、可注入」部分——受保护键一律剔除（键名不能由用户决定系统行为）。
// 同一函数同时服务两个调用点：spawn 前注入（sanitizeEnv）与写入配置（connectMcpServer），
// 保证「运行时看到的」与「落盘的」是同一视角，不再出现两份漂移的白名单。
function userEnvOf(env) {
  const out = {};
  for (const [k, v] of Object.entries(env && typeof env === 'object' ? env : {})) {
    if (PROTECTED_ENV.has(k)) continue;
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

// env 白名单：仅透传系统基础变量 + 用户显式配置，杜绝 process.env 全量泄漏（P2-10）
// PATH 特殊处理：打包版 GUI 进程继承的 PATH 极简（/usr/bin:/bin:...），
// npx/uvx（homebrew）全找不到——真机复盘：MCP 服务全部 spawn ENOENT。
// 注入与 toolShell 子 shell 一致的完整 PATH（见 SHELL_PATH 定义）。
//
// P0-5③：展开顺序修正。旧实现 `{ ...out, PATH: shellEnv().PATH, ...(env || {}) }` 让用户 env **恒胜**，
// 可覆盖 PATH（子进程劫持任意可执行文件）与 HOME/SHELL/NODE_ENV 等受保护键。
// 现在：用户 env 先按 userEnvOf 过滤（只做增量），白名单与 PATH **最后**展开 → 受保护键恒为系统真实值。
function sanitizeEnv(env) {
  const out = userEnvOf(env);
  for (const k of ENV_WHITELIST) {
    if (process.env[k]) out[k] = process.env[k];
  }
  out.PATH = shellEnv().PATH;
  return out;
}

// 2026-10-18 并发安全：连接成功后的落盘是「读-改-写」，而启动重连已改为有界并发——
// 多个服务同时成功会出现后写覆盖先写，把先落盘的服务配置整个丢掉（配置数据丢失）。
// 用一条 promise 链把**写盘**串行化（连接仍并发，只有写盘排队）。
let configWriteChain = Promise.resolve();
function persistMcpServer(entry) {
  configWriteChain = configWriteChain.then(() => {
    const next = loadMcpConfig().filter((s) => s.name !== entry.name);
    next.push(entry);
    saveMcpConfig(next);
  }).catch((e) => { console.warn('[mcp] 配置落盘失败:', e.message); });
  return configWriteChain;
}

// MCP 连接核心逻辑（IPC 处理器与启动重连共用）：委托给 mcpClient（stdio/http 双传输）
async function connectMcpServer({ name, transport = 'stdio', command, args = [], env = {}, url, headers = {} } = {}) {
  // 2026-10-18：stdio 参数守卫。这里是**所有连接路径的唯一入口**（IPC 手动连接 / 启动重连 /
  // 崩溃自动重连 / 生态安装通道都经 main.js 注入的 connectMcpServer），故一处拦截即全覆盖：
  // 带未替换占位符或空参数的配置在 spawn 前就被拒，避免服务端「零配置启动但回报连接成功」的静默失败。
  if (transport !== 'http') {
    const v = checkStdioSpawn({ name, command, args, env });
    if (!v.ok) {
      console.warn(`[mcp] ${name || command}: ${v.error}`);
      return { ok: false, error: v.error };
    }
  }
  // T7：http 连接挂 OAuth 钩子——令牌全程主进程闭环，渲染层不经手
  const am = transport === 'http' && name ? getOauthManager() : null;
  const auth = am ? {
    getHeader: async () => { const t = await am.getAccessToken(name); return t ? `Bearer ${t}` : null; },
    refresh: async () => { const t = await am.refreshFor(name); return t ? `Bearer ${t}` : null; },
  } : undefined;
  const r = await mcp.connectMcpServer({
    name, transport, command, args, env: sanitizeEnv(env), url, headers, auth,
    // P1-3：崩溃上报同时驱动「渲染层状态」与「自动重连排程」。
    // 二者是并列的两条出口，互不回喂——emitMcpStatus 只发渲染层事件（不触发重连），
    // autoReconnect.onStatus 只排程重连（其自身回执走 emitStatus，见 initMcpIpc）。
    onStatus: (n, st, code) => {
      emitMcpStatus(n, st, code);
      if (autoReconnect) autoReconnect.onStatus(n, st, code);
    },
    onLog: (line) => console.log(`[MCP ${name}]`, line),
  });
  // 连接成功 → 持久化配置（重启后自动重连）。fail-closed：握手失败不写盘。
  if (r.ok && name) {
    // P0-5②：落盘内容过同一 sanitize 视角——受保护键不写进文件（重启时由 sanitizeEnv 重新注入系统值）。
    // 用户自配 env（含 API Key 等）**必须原样保留**：脱敏会让需要凭证的服务重启后全部连不上
    //（P0-5 取舍：本轮只做「明文 + 0600 权限保护」，加密迁移 safeStorage 列入遗留）。
    const savedEnv = userEnvOf(env);
    // 期 2：落盘时打上内在档位 tier（auto-start/whitelist/manual）——服务自身的风险属性，
    // 与登录/平台无关。重启分流（reconnectMcpServers）与 UI 徽章都据此判定，缺失时回落到 classifyTier。
    const tier = classifyTier({ name, command, args, url });
    await persistMcpServer(transport === 'http'
      ? { name, transport, url, headers, env: savedEnv, tier }
      : { name, transport: 'stdio', command, args, env: savedEnv, tier });
    // 期 1：落工具清单缓存——懒启动下未连接服务的工具由渲染层从缓存重建，
    // 保证「服务没起来」不等于「模型看不见它的能力」。所有连接路径（手动/启动/自动重连/
    // 生态安装）都经本函数，故此处一处即全覆盖。
    const tools = Array.isArray(r.tools) ? r.tools : (mcp.getMcpServer(name)?.tools || []);
    if (tools.length) getToolCache().saveManifest(name, tools);
  }
  return r;
}

// P1-1：MCP 服务状态变更 → 通知渲染层（AgentDock / 设置页据此标红断开的服务）
function emitMcpStatus(name, status, code) {
  try {
    deps.emitTaskEvent({ type: 'mcp_status', name, status, code, ts: Date.now() });
  } catch (e) { /* 事件发送失败不影响主流程 */ }
}

// P1-1：统一清理全部 MCP 子进程（应用退出时调用）→ 委托 mcpClient（stdio SIGTERM→SIGKILL）
// P1-3：同时取消全部在途自动重连链——退出/批量重配时不该再有定时器尝试拉起旧连接
function killAllMcpServers() {
  if (autoReconnect) autoReconnect.cancelAll();
  return mcp.killAllMcpServers();
}

// P0-D：提取为命名函数（IPC 与定时任务 Agent 通道共用）
async function callMcpTool({ server, tool, arguments: args, approvalMode = 'on-request', conversationId }, ctx = {}) {
  let s = mcpServers.get(server);
  if (!s) {
    // 期 1：按需连接兜底（connect-on-demand）——懒启动下未连接的服务在**首次调用**时补连，
    // 而不是直接抛「未连接」。这正是「工具对模型可见（缓存清单）→ 调用时自动拉起」闭环的后半段。
    // 仅当存在已保存配置时才尝试；补连失败仍如实回「未连接」，不掩盖故障。
    const rc = await reconnectSaved(server, { reason: 'connect-on-demand' });
    if (rc && rc.ok) s = mcpServers.get(server);
  }
  if (!s) throw new Error(`MCP 服务 ${server} 未连接`);
  const startedAt = Date.now(); // P2-7：执行后告知要报耗时
  // L3：MCP 工具调用审批（auto-safe 档仍询问）
  const verdict = approval.needsApproval({ tool: `mcp__${server}__${tool}`, args: args || {}, approvalMode, conversationId, alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules });
  if (verdict.need) {
    const decision = await deps.requestApproval(`mcp__${server}__${tool}`, args || {});
    if (decision === 'deny') {
      deps.audit(`mcp:${server}`, tool, '用户拒绝', 'denied');
      return { error: '用户拒绝执行', denied: true };
    }
    deps.applyApprovalDecision(decision, `mcp__${server}__${tool}`, args || {}, conversationId);
  }
  let noticeOk = false;
  let noticeError = '';
  // P3-1：只有「确实有人要收进度」时才发 progressToken——规范规定不发令牌服务端就不会发进度，
  // 无人接收还发等于让服务端白算并往本进程灌通知。令牌/桥的实现见 main/mcpProgress.js。
  const progressToken = typeof ctx.onProgress === 'function' ? newProgressToken(startedAt) : '';
  if (progressToken) mcp.registerProgress(s, progressToken, ctx.onProgress);
  try {
    // P1-8：模型侧拿到的是「清洗后的工具名」（H-4：1–128 字符、仅 [A-Za-z0-9_.-]），
    // 调用前必须还原成服务端真实名字——否则服务端收到的名字已被替换，只会回 unknown tool。
    const realTool = mcp.resolveToolName(s, tool);
    // P1-8：走带会话恢复的 RPC（HTTP 会话 404 → 重新 initialize 后重试一次，H-4 要求）
    // P3-1：_meta.progressToken 必须进 params（不是顶层）——服务端按该令牌回报进度；
    //   会话恢复重试沿用同一 token，故重试期间收到的进度同样能回到本次调用。
    const callParams = { name: realTool, arguments: args || {} };
    if (progressToken) callParams._meta = { progressToken };
    const result = await mcp.mcpRpcWithSessionRetry(s, 'tools/call', callParams);
    // F-014 / A16c（结构化输出消费，用户裁决第三条路「校验走结构化，展示走文本」）：
    //   结构化数据（structuredContent）此前会经 agent-core 的 truncateToolResult
    //   （agent-core/index.js:1977 直接 JSON.stringify）**原样进模型上下文**，却没有任何一方
    //   校验它是否符合服务端自己声明的 outputSchema。这里在结果出口统一过策略：
    //     · 校验不匹配 → content 最前插入提示，模型以文本内容为准；
    //     · 只要 content 有非空文本块就剥掉 structuredContent（同一数据看两遍是纯预算浪费，
    //       文本版是服务端按规范必须给的）。
    //   为什么接在**这里**：callMcpTool 是 tools/call 的唯一执行路径（IPC mcp:callTool 与
    //   后续任何调度通道都经它），一处接线即全覆盖。
    //   fail-open：取不到 outputSchema / 策略模块加载失败 / 策略内部出错，一律用原 result——
    //   辅助逻辑绝不允许把一次成功的工具调用变成失败。
    let finalResult = result;
    try {
      const toolDef = (Array.isArray(s.tools) ? s.tools : []).find((t) => t && t.name === realTool);
      const outputSchema = toolDef ? toolDef.outputSchema : undefined;
      if (outputSchema) {
        const policy = await loadStructuredOutputPolicy();
        finalResult = policy.applyStructuredOutputPolicy(result, outputSchema);
      }
    } catch (e) {
      console.warn('[mcp] 结构化输出策略跳过（不影响工具结果）:', e && e.message);
    }
    // H-4：结果必须二分——JSON-RPC `error`（协议错，走 catch）与 `result.isError:true`（工具**执行**失败）。
    // 后者是合法工具结果：原样回喂模型自纠（内容不动、不抛错、不改写成 error 字段——
    // 改写成 error 会被引擎的 isToolFailure 计入「重复失败熔断」，同参重试语义过重）。
    const toolErr = !!(finalResult && finalResult.isError === true);
    deps.audit(`mcp:${server}`, tool,
      `${toolErr ? 'isError: 工具执行失败' : (finalResult?.error ? `error: ${finalResult.error}` : 'ok')} rule=${verdict.matched || 'none'}`,
      verdict.need ? 'approved' : 'auto');
    noticeOk = !toolErr;
    return toolErr ? { ...finalResult, toolError: true } : finalResult;
  } catch (err) {
    noticeError = err && err.message ? err.message : String(err);
    deps.audit(`mcp:${server}`, tool, `error: ${err.message}`, 'error');
    return { error: err.message };
  } finally {
    // P3-1：登记必须在出口摘掉（成功/失败/超时都要）——否则长跑进程里每调一次就积一条，
    // 且同一 token 旧回调会把后续进度送到已经结束的调用上。
    if (progressToken) mcp.dropProgressListener(s, progressToken);
    // P2-7：执行后告知。MCP 写的是**外部系统**（通知里会标注不可补偿），这类最需要事后知情。
    // 放 finally：成功/失败都要告知；用 try 兜住——通知失败绝不能影响工具结果。
    try {
      approval.notifyExecuted({
        enabled: approvalSettings.getUserApprovalNotice(),
        tool: `mcp__${server}__${tool}`,
        args: args || {},
        approvalMode,
        conversationId,
        alwaysRules: deps.getAlwaysRules(),
        conversationRules: deps.conversationRules,
        ok: noticeOk,
        ms: Date.now() - startedAt,
        error: noticeError,
      });
    } catch (e) {
      console.warn('[approval] MCP 执行后告知发送失败（不影响结果）:', e.message);
    }
  }
}

// P1-3：按名重连「已保存但当前未连接」的服务——**IPC 手动重连与崩溃自动重连共用同一实现**，
// 保证两条路径的幂等/审计/落盘行为完全一致（否则自动重连可能悄悄绕过手动路径已有的纪律）。
// 为什么必须由主进程按名取配置、而不是渲染层把 payload 传进来：
// mcp-servers.json 里的 env 含 API Key，跨 IPC 出口一律剥离（见 mcp:getConfig），
// 渲染层拿不到 env 就拼不出完整 payload。此处从磁盘读整条（含 env），
// env 全程留在主进程内，符合既有「凭证不出主进程」纪律。
async function reconnectSaved(name, { reason = 'manual' } = {}) {
  // 幂等：已连接就直接回当前状态，避免重复 spawn 出第二个子进程
  const existing = mcp.getMcpServer(name);
  // v1（意图动态加载）：已连接时也回带 tools——agentRunner 的意图预热需要工具清单来构造
  // mcp__* function 定义；只回 toolCount 会让上位把「已连接」误判成「无工具可用」。
  if (existing) return { ok: true, toolCount: (existing.tools || []).length, tools: existing.tools || [], already: true };
  const saved = loadMcpConfig().find((s) => s && s.name === name);
  if (!saved) {
    // fail-closed：没有保存过的配置就如实报错，不要拿空 command 去 spawn
    return { ok: false, error: `未找到已保存的 MCP 配置：${name}（请先在生态中心保存该服务）` };
  }
  const r = await connectMcpServer(saved);
  try {
    deps.audit(`mcp:reconnect:${name}`, '',
      r && r.ok ? `tools=${r.toolCount || 0} reason=${reason}` : `error: ${(r && r.error) || 'unknown'}`,
      r && r.ok ? 'connected' : 'error');
  } catch { /* 审计失败不影响重连结果 */ }
  return r;
}

// 启动时自动重连已持久化的 MCP 服务
//
// 2026-10-18：由串行 await 改为**有界并发**。原因：11 个 npx 冷启动逐个 await，
// 总耗时 = 各服务冷启动耗时之和（用户实测启动后工具长时间不齐）；并发下按批推进。
// 并发上限保守取 4：MCP 服务冷启动要拉包/起进程，全并发会瞬时抢 CPU 与 npm 缓存锁。
// 落盘已由 persistMcpServer 串行化，故并发不会丢配置（见该函数注释）。
const RECONNECT_CONCURRENCY = 4;

async function reconnectMcpServers() {
  const all = loadMcpConfig();
  if (all.length === 0) return;
  // G2+N8（第六轮）：三层分级**默认生效**——启动只拉起 auto-start 档（developer 档另含 git 类），
  // whitelist/manual 档不再随启动 spawn，改由 callMcpTool 按需连接。
  // 应急开关：显式 MJCODE_MCP_LAZY=0/false/off 时回落到旧行为（全量重连），仅用于排障兼容。
  const lazy = isLazyMode();
  const profile = getGovernance().profile;
  const config = lazy ? autoStartConfigs(all, { profile }) : all;
  if (lazy) {
    console.log(`[mcp] tier 分级生效（默认，profile=${profile}）：自动拉起 ${config.length}/${all.length} 个服务（auto-start 档${profile === PROFILES.DEVELOPER ? ' + git 类' : ''}），其余按需拉起`);
  } else {
    console.log(`[mcp] 懒启动已显式关闭（MJCODE_MCP_LAZY=0）：全量重连 ${config.length} 个已保存服务（并发 ${RECONNECT_CONCURRENCY}）...`);
  }
  let okCount = 0;
  let failCount = 0;
  let toolTotal = 0;
  for (let i = 0; i < config.length; i += RECONNECT_CONCURRENCY) {
    const batch = config.slice(i, i + RECONNECT_CONCURRENCY);
    const results = await Promise.all(batch.map(async (s) => {
      try {
        const res = await connectMcpServer(s);
        console.log(`[mcp] 重连 ${s.name}: ${res.ok ? `${res.toolCount} 个工具` : res.error}`);
        return res;
      } catch (err) {
        console.warn(`[mcp] 重连 ${s.name} 失败:`, err.message);
        return { ok: false };
      }
    }));
    for (const res of results) {
      if (res && res.ok) { okCount += 1; toolTotal += res.toolCount || 0; } else { failCount += 1; }
    }
  }
  // 汇总一行：此前 11 条逐服务日志后没有任何收尾信息，读者无法判断是否全部完成、总共多少工具
  const lazyTail = lazy ? `；其余 ${all.length - config.length} 个服务按需拉起（调用时自动连接）` : '';
  console.log(`[mcp] 重连完成：${okCount} 成功 / ${failCount} 失败，共 ${toolTotal} 个工具${lazyTail}`);
}

function register() {
  ipcMain.handle('mcp:connect', async (_, payload) => {
    // X14：connect 会把 name/command/args/env 落到 mcp-servers.json（env 明文），
    // 形状必须先过关，避免把奇怪结构写进配置文件
    try {
      guard.assertStrings(payload, { name: 120, command: { max: 2000, optional: true }, url: { max: 2000, optional: true } });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // 第八轮 F-005 / B1-B-05：name 会成为工具名的一部分（`mcp__<name>__<tool>`），必须保证
    // 拼出来的名字能被 agent-core **唯一反解**回这个 name。改前只校验长度 ≤120：
    // name 含 `__` / 控制字符 / 非法 Unicode 时，拼名与反解不互逆 → 后续每次工具调用
    // 都会静默路由到另一个服务（或被编码成 U+FFFD 而不可逆）。这里 fail-closed：
    // 拒在连接前，而不是让一个「名字坏掉」的服务被写进 mcp-servers.json 后长期错路由。
    try {
      const codec = await loadMcpNameCodec();
      const back = codec.decodeToolName(codec.buildToolName(payload.name, 'probe'));
      if (!back || back.server !== payload.name || back.tool !== 'probe') {
        return {
          ok: false,
          error: `服务名不可用作工具名前缀：「${payload.name}」经编码后无法被唯一反解回原名`
            + '（可能含非法 Unicode 字符）；请改用字母/数字/连字符或中文等常规字符命名后重试',
        };
      }
    } catch (e) {
      return { ok: false, error: `服务名校验失败：${e && e.message ? e.message : String(e)}` };
    }
    // B2-B-13 / B3 #12：编码后**全名长度**预算。闸的**唯一实现**已下移到
    // mcpClient.connectMcpServer（连接唯一收口点），覆盖 mcp:reconnect / 启动重连 /
    // 崩溃自动重连 / 生态安装——此前只有本入口有闸，存量超长中文服务名仍能经 reconnect 连上。
    // 这里保留一次前置调用，只因它比连接路径更早、更贴近用户动作（在 sanitize/落盘/cancel 之前
    // 就失败）；判定与文案都取自 mcpClient，本文件不再持有第二份阈值（阈值只在 mcpNameCodec）。
    const budgetErr = await mcp.checkServerNameBudget(payload.name);
    if (budgetErr) return budgetErr;
    const r = await connectMcpServer(payload);
    // P1-3：用户手动连上了，撤掉该服务可能存在的自动重连在途链（人工优先，不再自动覆盖）
    if (r && r.ok && payload && payload.name && autoReconnect) autoReconnect.cancel(payload.name);
    return r;
  });

  // 2026-10-17（用户实测反馈「ima 配置完成后 + 菜单里仍然显示需手动配置」）：
  // 按名重连「已保存但当前未连接」的服务（实现见 reconnectSaved）。
  ipcMain.handle('mcp:reconnect', async (_, payload) => {
    try {
      // X14：name 是用户数据（来自目录/配置），先过边界校验
      guard.assertStrings(payload, { name: 120 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return reconnectSaved(String(payload.name), { reason: 'manual' });
  });

  // T7：浏览器授权（三级回落在引擎内完成；只回状态与级别，绝不回传令牌）
  ipcMain.handle('mcp:authorize', async (_, { name, url, preset } = {}) => {
    const am = getOauthManager();
    if (!am) return { ok: false, error: '凭证加密未就绪，无法安全保存 OAuth 令牌' };
    const r = await am.authorize(String(name || ''), {
      url: String(url || ''),
      preset: preset && typeof preset === 'object' ? preset : undefined,
    });
    deps.audit(`mcp:authorize:${name}`, '', r.ok ? `level=${r.level}` : `error: ${r.error}`, r.ok ? 'authorized' : 'error');
    return r;
  });

  // T7：授权状态查询（渲染层据此决定「浏览器授权」还是「测试连接」；不回传任何令牌材料）
  ipcMain.handle('mcp:authStatus', async (_, { name } = {}) => {
    const am = getOauthManager();
    return { ok: true, authorized: !!(am && name && am.hasStoredAuth(String(name))) };
  });

  ipcMain.handle('mcp:callTool', (event, payload) => {
    try {
      // 形状以 callMcpTool 的入参为准：{ server, tool, arguments }
      guard.assertStrings(payload, { server: 200, tool: 200 });
      if (payload.arguments !== undefined) guard.assertObject({ arguments: payload.arguments });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // P3-1：进度只推发起方窗口（不广播——那是「这次调用」的副作用，别的窗口无权知情）；
    // end 由这里发而不由 callMcpTool 发：后者还被定时/引擎通道复用，那种调用没有「发起方窗口」。
    const bridge = makeProgressBridge(event && event.sender, payload.server, payload.tool);
    // settleProgress 而非 `.finally(bridge.done)`：理由见 main/mcpProgress.js 的注释（finally 会漏一个未捕获拒绝）
    return settleProgress(callMcpTool(payload, { onProgress: bridge.onProgress }), bridge);
  });

  ipcMain.handle('mcp:disconnect', async (_, { name } = {}) => {
    // X14：name 同时用于断开子进程与重写 mcp-servers.json（filter 掉该条）——
    // 非字符串会让 filter 静默放行全部，用户以为断开了、重启后全部重连
    try {
      guard.assertStrings({ name }, { name: 200 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // 断开 + 同步移除持久化配置（http 传输无子进程，close 为空操作）
    mcp.disconnectMcpServer(name);
    // P1-3：用户主动断开即「人工否决」——撤掉在途自动重连链，否则断开后它会把服务再次拉起
    if (autoReconnect) autoReconnect.cancel(name);
    saveMcpConfig(loadMcpConfig().filter((s) => s.name !== name));
    // 期 1：同步清掉该服务的工具清单缓存，避免删除服务后其工具仍残留在缓存里
    getToolCache().removeManifest(name);
    return { ok: true };
  });

  // ═══ P0-F：沙箱状态查询（UI 明示隔离能力与兜底状态）═══
  // P0-6 修复（2026-10-17）：原实现用静态 detectBackend()（仅 fs.existsSync 判定
  // sandbox-exec 存在）上报可用性，而执行路径（exec.js）用的是真实探测 seatbeltUsable()
  // （实际 apply 一个带 deny network* 的 profile）。嵌套沙箱环境（本应用被其他 Agent
  // 平台的沙箱包住、或 CI 容器）下 sandbox-exec 存在但无法 apply → UI 显示「已隔离就绪」，
  // 实际执行时落 runFallback 以宿主权限直跑——用户基于错误的安全认知做出放行决策。
  // 现改用 describeCapability()：与执行路径同源的真实能力探测，nestedSandbox 一并下发，
  // UI 对「能力不可用」给出明确文案，不显示「已隔离」。
  ipcMain.handle('sandbox:status', async () => {
    const cap = await sandbox.describeCapability();
    let available = cap.available;
    let hint = cap.reason;
    // Windows 后端的就绪态是异步的（net user 查专用用户），describeCapability 只做静态探测，
    // 此处沿用异步确认（与 exec.js 的 windowsSandboxReady 同源，避免静态误报「已就绪」）
    if (cap.backend === 'windows-restricted-user') {
      const st = await sandbox.windowsBackend.windowsSandboxReady();
      available = st.ready;
      hint = st.reason;
    }
    return {
      ok: true,
      platform: process.platform,
      available,            // OS 级沙箱是否**真实**就绪（三平台：seatbelt / bubblewrap / windows-restricted-user）
      backend: cap.backend,
      hint,                 // 未就绪时的可行动提示（如「apt install bubblewrap」/ 嵌套沙箱说明）
      nestedSandbox: cap.nestedSandbox, // 嵌套沙箱环境：macOS 不允许嵌套 apply，隔离无法生效
      fallbackActive: !available, // 无 OS 级沙箱时启用命令级硬拦截兜底
    };
  });

  // ═══ P0-E：GitHub 最小闭环（gh CLI 封装）═══
  // diff 审查的「交付」出口：创建 PR。依赖本机 gh 登录态，不做云端 OAuth。
  ipcMain.handle('github:status', async () => {
    const available = await github.ghAvailable();
    if (!available) {
      return { ok: true, available: false, authed: false, hint: '未检测到 GitHub CLI（gh）。请先安装 https://cli.github.com 并执行 gh auth login' };
    }
    const auth = await github.ghAuthed();
    return { ok: true, available: true, authed: auth.ok, hint: auth.ok ? '' : 'gh 未登录，请先执行 gh auth login' };
  });

  ipcMain.handle('github:createPr', async (_, payload = {}) => {
    // X14：title/body/base 会作为 argv/--body 交给 gh（createPullRequest 内已做 String() 化），
    // 但长度失控会把整段内容塞进命令行；cwd 决定在哪个仓库开 PR，同样守一下形状
    try {
      guard.assertStrings(payload, {
        cwd: { max: 4096, optional: true, allowEmpty: true },
        title: { max: 300, optional: true, allowEmpty: true },
        body: { max: 60000, optional: true, allowEmpty: true },
        base: { max: 200, optional: true, allowEmpty: true },
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const available = await github.ghAvailable();
    if (!available) {
      return { ok: false, error: '未检测到 GitHub CLI（gh）。请先安装 https://cli.github.com 并执行 gh auth login' };
    }
    const r = await github.createPullRequest(payload);
    if (r.ok) {
      deps.audit('github:createPr', String(payload.cwd || ''), `title=${String(payload.title || '').slice(0, 80)} url=${r.url}`, 'recorded');
    } else {
      deps.audit('github:createPr', String(payload.cwd || ''), `error: ${r.error}`, 'error');
    }
    return r;
  });

  ipcMain.handle('mcp:listServers', async () => {
    return mcp.listMcpServers().map((name) => {
      const s = mcp.getMcpServer(name);
      // P1-8：握手协商结果随列表下发（服务端实际版本 / 能力 / 自述），供设置页与诊断查询。
      // protocolVersion 只放服务端返回值（未声明时为 null）；我们提议的版本单独给，不冒充协商结果。
      return {
        name, toolCount: s?.tools?.length || 0, kind: s?.kind || 'stdio',
        protocolVersion: s?.protocolVersion || null,
        proposedProtocolVersion: s?.proposedProtocolVersion || null,
        // P1-8：legacy=true 表示该服务拒绝过 2025-11-25、已降级为 2024-11-05（诊断/UI 可提示）
        legacy: !!s?.legacy,
        serverInfo: s?.serverInfo || null,
        capabilities: s?.capabilities || {},
      };
    });
  });

  // v1（2026-10-20，D1）：只回**已连接**服务的全量工具清单（含 inputSchema）。
  // 应用重启后主进程自动重连 auto-start 档服务，但渲染层 mcpTools 状态为空，
  // 渲染层启动时调此通道重建 agent 工具集，已连接服务（自启档 / 用户手动连接 / 意图预热）
  // 的 MCP 工具即全程可用。
  // 为什么不再用「已保存但未连接」服务的缓存清单兜底：那会让渲染层把**全部已保存** MCP 工具
  // 注入**每一条**对话，与「MCP 默认全关、仅用户自选或按文本意图判定后才加载」的架构约束冲突，
  // 也会让 intentPrewarm 的 `already` 过滤恒命中、意图动态加载沦为空操作。未连接服务的工具
  // 改由「意图预热」在命中意图时按需连接后再纳入本轮（见 agentRunner.intentPrewarmToolDefs）。
  ipcMain.handle('mcp:listTools', async () => {
    const connected = new Set(mcp.listMcpServers());
    return [...connected].map((name) => {
      const s = mcp.getMcpServer(name);
      return { server: name, tools: s?.tools || [], connected: true };
    });
  });

  // B3：已保存（持久化）的 MCP 配置列表 —— 前端据此渲染「已保存但未连接」状态
  // P1-M：env 可能含用户配置的 API Key 等敏感变量——跨 IPC 出口一律剥离，
  //  spawn 路径直接读磁盘配置（不经此通道），渲染层永远拿不到 env
  // 期 2：servers 的 tier 由 {env,...rest} 自然透出（落盘时已打），缺失时回落 classifyTier 补齐；
  //      同时下发 governance（profile / fsMode / sandboxNetwork）供设置页渲染档位选择器。
  ipcMain.handle('mcp:getConfig', async () => ({
    ok: true,
    // 2026-10-16：同时回传配置文件路径 —— 生态中心连接器弹窗据此提供「打开 JSON 直接改」入口。
    // 只回路径、不读内容：文件里的 env 含 API Key，跨 IPC 出口仍一律剥离（见上一条注释）。
    path: MCP_CONFIG_FILE(),
    servers: loadMcpConfig().map(({ env, ...rest }) => ({ ...rest, tier: rest.tier || classifyTier(rest) })),
    governance: getGovernance(),
  }));

  // T2：生态中心「本机服务」区 JSON 编辑入口（开发者通道）——
  //  接收完整数组（含 env），整体覆盖 mcp-servers.json 后重连。
  //  校验：数组元素必须含 name；stdio 必须有 command；http 必须有 url；
  //  非法条目静默丢弃（不阻断整批保存），返回 {ok, saved, dropped} 让 UI 明示。
  ipcMain.handle('mcp:setConfig', async (_, payload) => {
    // X14：servers 非数组时下面的 `: []` 分支会把整份 mcp-servers.json 覆盖成空数组
    //（用户视角：所有 MCP 配置无声消失）。显式传 [] 仍是合法的「清空」，但类型必须守。
    try {
      guard.assertArray(payload || {}, 'servers', { max: 200 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const list = Array.isArray(payload?.servers) ? payload.servers : [];
    const valid = [];
    let dropped = 0;
    for (const s of list) {
      if (!s || typeof s !== 'object' || !s.name) { dropped++; continue; }
      const t = String(s.transport || 'stdio');
      if (t === 'http' && !s.url) { dropped++; continue; }
      if (t !== 'http' && !s.command) { dropped++; continue; }
      valid.push({
        name: String(s.name),
        transport: t,
        command: s.command ? String(s.command) : undefined,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        url: s.url ? String(s.url) : undefined,
        env: userEnvOf(s.env), // P0-5②：手改 JSON 的通道同样只落用户增量 env（受保护键不进文件）
        headers: s.headers && typeof s.headers === 'object' ? s.headers : {},
        // 期 2：手改 JSON 时同样重算 tier（用户可能改了 command/name 改变了服务风险属性）
        tier: classifyTier({ name: String(s.name), command: s.command, args: s.args, url: s.url }),
      });
    }
    saveMcpConfig(valid);
    // 断开旧连接后按新配置重连（与 disconnect→save 链路一致）
    try { killAllMcpServers(); } catch { /* 无旧连接时忽略 */ }
    await reconnectMcpServers();
    return { ok: true, saved: valid.length, dropped };
  });

  // 期 2：治理偏好读取（档位 profile / 文件能力 fsMode / 沙盒网络开关）。
  // 与 mcp:getConfig 内联下发的 governance 同源——单独通道供设置页进入时直达读取。
  ipcMain.handle('mcp:governance/get', async () => ({ ok: true, governance: getGovernance() }));

  // 期 2：治理偏好写入。只接受已知字段，未提供字段保持原值（部分更新语义），
  // 归一化由 readGovernance 兜底（非法值回落最保守档），写后回传最新治理配置。
  ipcMain.handle('mcp:governance/set', async (_, payload = {}) => {
    const store = deps && deps.getLocalStore ? deps.getLocalStore() : null;
    if (!store) return { ok: false, error: '本地数据层未初始化' };
    try {
      const prev = store.getPreference(GOVERNANCE_PREF_KEY);
      const merged = readGovernance({
        ...(prev && typeof prev === 'object' ? prev : {}),
        ...(payload && typeof payload === 'object' ? {
          ...(payload.profile !== undefined ? { profile: payload.profile } : {}),
          ...(payload.fsMode !== undefined ? { fsMode: payload.fsMode } : {}),
          ...(payload.sandboxNetwork !== undefined ? { sandboxNetwork: payload.sandboxNetwork === true } : {}),
        } : {}),
      });
      store.setPreference(GOVERNANCE_PREF_KEY, merged);
      try { deps.audit('mcp:governance', '', `profile=${merged.profile} fsMode=${merged.fsMode} sandboxNetwork=${merged.sandboxNetwork}`, 'recorded'); } catch { /* 审计失败不影响写入 */ }
      return { ok: true, governance: merged };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // A5：语音本地转写（whisper.cpp；音频不出本机）
  ipcMain.handle('voice:transcribe', async (_, { wavBase64, language }) => voice.transcribeWav({ wavBase64, language }));

  // ═══ P1-5：用户自定义生命周期 hooks（preToolUse / postToolUse）═══
  // 设置页据此列出/编辑 hooks.json。命令文本与其它 MCP 配置同属「用户本机配置」，
  // 不含凭证，因此可以跨 IPC 回传（与 mcp:getConfig 剥离 env 的取舍不同，此处无敏感字段）。
  ipcMain.handle('hooks:getConfig', async () => ({
    ok: true,
    path: deps.toolHooks ? deps.toolHooks.filePath : '',
    hooks: deps.toolHooks ? deps.toolHooks.list() : [],
  }));

  ipcMain.handle('hooks:setConfig', async (_, payload) => {
    if (!deps.toolHooks) return { ok: false, error: 'hooks 能力未接线' };
    // X14：非数组会让归一化把整份配置判为无效（用户以为存了、实际清空）
    try {
      guard.assertArray(payload || {}, 'hooks', { max: 200 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const r = deps.toolHooks.save(Array.isArray(payload?.hooks) ? payload.hooks : []);
    if (r.ok) deps.audit('hooks:setConfig', deps.toolHooks.filePath, `count=${r.hooks.length}`, 'recorded');
    return r;
  });
}

function initMcpIpc(d) {
  deps = d;
  // P1-3：自动重连器在此建——reconnect 复用 reconnectSaved（与手动重连同源），
  // emitStatus 直连 emitMcpStatus（**不经 onStatus**，否则「失败→crashed→再排程」成死循环）。
  autoReconnect = createMcpAutoReconnect({
    reconnect: (name) => reconnectSaved(name, { reason: 'auto' }),
    emitStatus: (name, status, code) => emitMcpStatus(name, status, code),
  });
  register();
}

// v1（2026-10-19）：意图驱动的 MCP 动态加载需要三个只读/连接入口 ——
//   reconnectSaved：按名连接用户已保存的连接器（agentRunner 预热用，与手动/自动重连同源）；
//   loadMcpConfig：读已保存连接器清单（不含 env 的下发由 mcp:getConfig 负责，此处给主进程内部用）；
//   getToolCache.getManifest：读某连接器的缓存工具清单（用户自定义命名时按工具签名匹配的关键输入）。
module.exports = {
  initMcpIpc, connectMcpServer, callMcpTool, killAllMcpServers, reconnectMcpServers, getGovernance, mcpServers,
  reconnectSaved, loadMcpConfig, getToolCache,
};
