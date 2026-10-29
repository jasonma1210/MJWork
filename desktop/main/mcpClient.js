// MCP 客户端（2026-10-15 从 main.js 抽出 + 多传输）
//
// 此前只有 stdio 一种传输，且实现内联在 main.js（God Object 清单项）。
// 本模块把传输抽象出来：
//   stdio —— 子进程 + 按行 JSON-RPC（原实现，行为不变）
//   http  —— MCP Streamable HTTP（spec 2025-03-26）：POST JSON-RPC，响应可为
//            application/json（单响应）或 text/event-stream（SSE，含响应与后续通知）；
//            initialize 时捕获 Mcp-Session-Id，后续请求回带。
//
// 安全说明（与 webTools 的 SSRF 防护刻意不同）：
//   MCP 服务地址来自**用户显式配置**（设置页/连接器目录），不是模型可控参数——
//   且本地 localhost 恰是自托管 MCP 最常见的形态，因此 http 传输**不套用**
//   webTools 的私网拦截；模型只能调用「已连接服务」的已注册工具（callMcpTool 按
//   server/tool 名分发），无法引导客户端连到任意 URL。
//
// 生命周期与原实现一致：initialize → notifications/initialized → tools/list 三步分离，
// 各自超时；握手完成后的进程退出/SSE 断开才算「运行期崩溃」并回报上层。

// P1-8：协议版本/客户端能力的单一事实来源（mcpAuth.js 的 401 探测也引用同一份）
// D-804：双栈后新增 NEXT_PROTOCOL_VERSION / clientCapabilitiesFor（能力声明按版本分叉）
const {
  PROTOCOL_VERSION, MIN_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS,
  NEXT_PROTOCOL_VERSION, clientCapabilitiesFor,
  CLIENT_CAPABILITIES, CLIENT_INFO, isSupportedProtocolVersion,
} = require('./mcpProtocol');
const { answerServerRequest } = require('./mcpServerRequests'); // P2-4：已声明能力的请求应答（ping/roots/completion）
const { createStdioTransport } = require('./mcpStdioTransport'); // 2026-10-18：stdio 传输 + stderr 分级降噪
// 2026-10-20：Streamable HTTP / 旧版 SSE / consumeSse 抽到独立模块（800 行软档，见该文件头注释）。
// 这里引入后仍原样再导出（module.exports 里保留），调用方与既有测试无需改动。
const { createHttpTransport, consumeSse, createSseTransport } = require('./mcpHttpTransport');

const servers = new Map(); // name -> server 实例（跨传输统一注册表）

const DEFAULT_TIMEOUT_MS = 30000;
// P1-8：tools/list 分页上限——服务端若返回恒真的 nextCursor（实现 bug），无上限会死循环
const MAX_TOOL_PAGES = 20;// H-4：工具名规范为 1–128 字符、仅 [A-Za-z0-9_.-]（SHOULD）。越界名字一律清洗后暴露给模型，
// 真实名字保留在 server.toolNameMap 里供 tools/call 还原。
const TOOL_NAME_MAX = 128;
const TOOL_NAME_BAD_CHARS = /[^A-Za-z0-9_.-]/g;
// P2-5：缓存命中但**握手仍在途**时，最多等这么久让在途连接完成（略大于 initialize 超时）。
// 不能直接返回 toolCount:0 —— 调用方会把它当成「已连接但没有工具」。
const HANDSHAKE_WAIT_MS = DEFAULT_TIMEOUT_MS + 5000;

// ── JSON-RPC 请求（跨传输通用）──
function mcpRpc(server, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = server.nextId++;
    const timer = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`MCP ${method} 超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    server.pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || 'MCP 返回错误'));
      else resolve(msg.result);
    });
    // 传输层负责真实投递；投递失败要同时清理 pending，否则调用方要等满超时
    let payload;
    try {
      payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    } catch (e) {
      clearTimeout(timer);
      server.pending.delete(id);
      reject(new Error(`MCP 请求序列化失败：${e.message}`));
      return;
    }
    Promise.resolve()
      .then(() => server.transport.send(payload, id))
      .catch((e) => {
        clearTimeout(timer);
        server.pending.delete(id);
        const err = new Error(`MCP 请求发送失败：${e.message}`);
        // T7：needsAuth 标记必须穿过重包装，否则上层无法区分「要授权」与「网络故障」
        if (e.mcpAuthRequired) err.mcpAuthRequired = true;
        // H-4：会话失效标记同理——丢了它就无法触发「重新 initialize 后重试一次」
        if (e.mcpSessionExpired) err.mcpSessionExpired = true;
        reject(err);
      });
  });
}

// 分发收到的 JSON-RPC 消息：响应按 id 唤醒等待者；通知/请求（服务端主动）走 onNotify 钩子
function dispatchMessage(server, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id !== undefined && server.pending.has(msg.id)) {
    const cb = server.pending.get(msg.id);
    server.pending.delete(msg.id);
    cb(msg);
    return;
  }
  if (typeof server.onNotify === 'function') {
    try { server.onNotify(msg); } catch (e) { console.warn('[MCP] 通知处理异常（不影响主流程）:', e?.message || e); }
  }
}

// ── P1-8：工具名清洗 / 映射（H-4：1–128 字符、仅 [A-Za-z0-9_.-]）──
//
// 为什么必须有这一层：工具名直接被拼进 `mcp__<server>__<tool>` 交给模型，
// 而模型厂商对 function.name 的字符集要求比 MCP 规范更严（部分供应商直接 400）。
// 清洗必须**可逆**：调用时用真实名字发给服务端，否则服务端收到的是被替换过的名字 → unknown tool。
function sanitizeToolName(name) {
  const cleaned = String(name || '').trim().replace(TOOL_NAME_BAD_CHARS, '_').slice(0, TOOL_NAME_MAX);
  return cleaned || 'tool';
}

// 登记工具：返回暴露给模型的列表，并把 exposedName → originalName 存进映射表
function registerTools(server, rawTools) {
  const map = new Map();
  const used = new Set();
  const tools = [];
  for (const t of rawTools || []) {
    if (!t || typeof t !== 'object') continue;
    const original = String(t.name || '');
    if (!original) continue;
    let exposed = sanitizeToolName(original);
    if (used.has(exposed)) {
      // 清洗后重名（如 `a b` 与 `a/b` 都变 `a_b`）：加序号区分，避免模型调用时歧义
      let i = 2;
      while (used.has(`${exposed}_${i}`)) i += 1;
      exposed = `${exposed}_${i}`.slice(0, TOOL_NAME_MAX);
    }
    used.add(exposed);
    map.set(exposed, original);
    tools.push(exposed === original ? t : { ...t, name: exposed, originalName: original });
  }
  server.tools = tools;
  server.toolNameMap = map;
  return tools;
}

/** 暴露名 → 服务端真实工具名（未登记时按原名透传，兼容测试/裸调用） */
function resolveToolName(server, name) {
  const map = server && server.toolNameMap;
  if (map && map.has(name)) return map.get(name);
  return name;
}

// ── 2026-10-18 MCP 日志降噪：notifications/message 的 level 分流 ──
// MCP logging 规范级别集合；默认放行「warning 及以上」，丢弃 debug/info/notice。
// 缺省 level 按规范视为 info（即默认丢弃）；MJCODE_MCP_VERBOSE=1 时放开全量（与 stderr 同一开关）。
const MCP_LOG_KEPT = new Set(['warning', 'warn', 'error', 'critical', 'alert', 'emergency']);
function shouldForwardLogLevel(level) {
  if (process.env.MJCODE_MCP_VERBOSE) return true;
  return MCP_LOG_KEPT.has(String(level || 'info').toLowerCase());
}

// ── P1-8④：服务端主动消息处理；P2-4 已声明能力的请求应答在 mcpServerRequests.js（门禁断言一致性）
function handleServerMessage(server, msg, { onLog } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  // 迟到的响应（请求已超时、pending 已清理）：静默忽略，不刷日志
  if (msg.id !== undefined && !msg.method) return;
  // 服务端 → 客户端的**请求**：已实现能力的正常应答；未实现的必须立刻回 -32601（静默 = 服务端挂死）。
  if (msg.id !== undefined && msg.method) {
    if (answerServerRequest(server, msg, log)) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `客户端未实现 ${msg.method}（未声明该能力）` } });
    Promise.resolve(server.transport.send(payload, msg.id)).catch(() => { /* 回执失败不影响主流程 */ });
    log(`服务端请求 ${msg.method} 未实现，已回 -32601`);
    return;
  }
  const method = String(msg.method || '');
  if (method === 'notifications/tools/list_changed') {
    // 工具集变更（服务端热更新）：重拉并换装，模型下一轮就能看到新工具
    server.toolsChangedAt = Date.now();
    refreshTools(server)
      .then((tools) => console.log(`[MCP ${server.name}] 工具列表已变更，重新拉取 ${tools.length} 个工具`))
      .catch((e) => console.warn(`[MCP ${server.name}] 工具列表刷新失败:`, e.message));
    return;
  }
  if (method === 'notifications/message') {
    // 2026-10-18 降噪：服务端常把 info/debug 级日志**经 MCP 协议**发来
    // （desktop-commander 的 12 行启动日志即此路径），与 stderr 是两条独立通道——
    // 只过滤 stderr 挡不住它。按 MCP logging 的 level 字段分流：
    // 默认只透传 warn/error 家族，info/debug 丢弃；MJCODE_MCP_VERBOSE=1 放开全量。
    const p = msg.params || {};
    const data = typeof p.data === 'string' ? p.data : JSON.stringify(p.data);
    if (shouldForwardLogLevel(p.level)) log(`[${p.level || 'info'}] ${data}`);
    return;
  }
  if (method === 'notifications/progress') {
    // P3-1（2026-10-29）：按 progressToken 路由到本次调用登记的监听器。
    // 此前这里是「只记 lastProgress、不路由」——但更根本的问题在**发送端**：MCP 规范里
    // 客户端必须在 `tools/call` 的 `params._meta.progressToken` 带一个令牌，服务端才会用
    // 同一 token 回报进度。从不发令牌 ⇒ 服务端一条 progress 都不会发 ⇒ 本分支是**死代码**。
    // 现在 token 由 ipc/mcp.js 的 callMcpTool 生成并登记（见 registerProgress），两条边才接上。
    const p = msg.params || {};
    const entry = { token: p.progressToken, progress: p.progress, total: p.total, message: p.message, ts: Date.now() };
    // 只记录最近一条（诊断用）+ 立刻转发给本次调用的监听器；未登记的 token 只留痕不报错
    //（可能来自别的窗口/已结束的调用，按「无处可送」处理，不当成异常）。
    server.lastProgress = entry;
    const listener = server.progressListeners instanceof Map
      ? server.progressListeners.get(String(p.progressToken == null ? '' : p.progressToken))
      : null;
    if (typeof listener === 'function') {
      try { listener(entry); } catch (e) { log(`进度监听器抛错（不影响调用）：${e && e.message}`); }
    }
    return;
  }
  log(`未处理的服务端消息：${method || '(无 method)'}`);
}

// ── P1-8：握手 / 工具列表（initialize → notifications/initialized → tools/list 分页）──

// ── D-804 S2/S3（2026-10-21）：无状态栈探测 ──────────────────────────────────
// 做什么：向 http 传输先发一次 `server/discover`（2026-07-28 用以取代 initialize 的方法），
//   成功即采用无状态语义（不发 initialize、不带 session id、能力声明走新版分叉）。
// 为什么用 server/discover 做判别器：它在**老服务端必然失败**（方法不存在 / 400），
//   因此「成功=新服务端、失败=老服务端」是可靠二分；反过来先发 initialize 到新服务端同样必失败，
//   但会把「服务端已升级」误判成「连不上」，且无法区分「服务端坏了」与「我们落后」。
// 失败必须复位：`setStateless(false)` 同时清掉协议版本头与 session id，
//   否则随后的握手会带着无状态版本号发 initialize（严格服务端直接 400）。
// 只对 http 传输生效：stdio 没有会话概念，「无状态」在那里没有可观测差异。
async function tryStatelessDiscovery(server) {
  const t = server && server.transport;
  if (!t || t.kind !== 'http' || typeof t.setStateless !== 'function') return false;
  t.setStateless(true, NEXT_PROTOCOL_VERSION);
  try {
    const res = await mcpRpc(server, 'server/discover', {
      clientInfo: CLIENT_INFO,
      // S4：按版本分叉的能力声明（无状态栈不声明 roots / logging —— 二者已在新版弃用）
      capabilities: clientCapabilitiesFor(NEXT_PROTOCOL_VERSION),
    });
    const peer = res && typeof res.protocolVersion === 'string' ? res.protocolVersion : NEXT_PROTOCOL_VERSION;
    if (!isSupportedProtocolVersion(peer) || peer !== NEXT_PROTOCOL_VERSION) {
      // 服务端声称了一个我们没实现的无状态版本 → 不硬撑（与「回不支持的版本即 disconnect」同纪律）
      t.setStateless(false);
      if (server.log) server.log(`[MCP ${server.name}] server/discover 回了未实现的版本 ${peer}，回落到握手栈`);
      return false;
    }
    // 一次性写入（不用逐个 `server.x =`）：逐个赋值会各触发一次 require-atomic-updates
    // （await 之后按旧状态赋值），把「本批新增 lint 警告」推高，而 lint 警告是只减不增的棘轮。
    Object.assign(server, {
      stateless: true,
      protocolVersion: peer,
      proposedProtocolVersion: NEXT_PROTOCOL_VERSION,
      capabilities: (res && res.capabilities) || {},
      serverInfo: (res && res.serverInfo) || null,
      legacy: false,
    });
    if (server.log) server.log(`[MCP ${server.name}] 采用无状态栈（${peer}）`);
    return true;
  } catch (e) {
    // 老服务端走到这里：复位后由调用方走握手栈。**不打 error 级日志** —— 这是预期路径。
    t.setStateless(false);
    if (server.log) server.log(`[MCP ${server.name}] 无状态栈不可用（${String(e && e.message || e).slice(0, 120)}），改用握手栈`);
    return false;
  }
}

async function notifyInitialized(server) {
  // 2026-10-17：streamableHttp 与 stdio 一样，initialize 之后必须发 initialized 通知。
  // 此前只对 stdio 发：宽容的服务端（24haowan）不校验，严格的服务端会拒绝后续 tools/list。
  try {
    await server.transport.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  } catch (e) {
    console.warn('[MCP] initialized 通知发送失败（不影响主流程）:', e.message);
  }
}

/**
 * 握手并**采纳服务端返回值**（P1-8②③）。
 * 返回值里带 protocolVersion / capabilities / serverInfo —— 原实现直接丢弃，
 * 导致 server.capabilities 恒为发出值、上层无法得知服务端到底支持什么。
 * @param {object} server
 * @param {string} [version] 本次提议的协议版本（降级重试时传 MIN_PROTOCOL_VERSION）
 */
async function performHandshake(server, version = PROTOCOL_VERSION) {
  // 提议版本如实记录（降级后记 MIN，而不是永远记 2025-11-25）
  server.proposedProtocolVersion = version;
  const initRes = await mcpRpc(server, 'initialize', {
    protocolVersion: version,
    capabilities: { ...CLIENT_CAPABILITIES },
    clientInfo: { ...CLIENT_INFO },
  });
  const peerVersion = initRes && typeof initRes.protocolVersion === 'string' ? initRes.protocolVersion : '';
  if (peerVersion && !isSupportedProtocolVersion(peerVersion)) {
    // H-4：服务端回不支持的版本 → disconnect（不自行降级重试），由 connectMcpServer 的 catch 收尾
    const err = new Error(
      `MCP 协议版本不受支持：服务端返回 ${peerVersion}，本客户端支持 ${SUPPORTED_PROTOCOL_VERSIONS.join(' / ')}。`
      + '按 MCP 规范已断开该连接，请升级该 MCP 服务或其网关。',
    );
    err.mcpVersionUnsupported = true;
    throw err;
  }
  // 落状态时以**服务端实际返回值**为准：peerVersion 为空（服务端未声明版本）时保持空，
  // 不拿我们自己提议的版本冒充协商结果（提议值单独记在 proposedProtocolVersion）。
  // 一次性写入（同 tryStatelessDiscovery 的做法）：逐条 `server.x =` 都发生在 await 之后，
  // 会各触发一次 require-atomic-updates，而 lint 警告是只减不增的棘轮。
  const handshakeState = {
    protocolVersion: peerVersion,
    capabilities: (initRes && initRes.capabilities) || {},
    serverInfo: (initRes && initRes.serverInfo) || {},
  };
  if (initRes && typeof initRes.instructions === 'string') handshakeState.instructions = initRes.instructions;
  Object.assign(server, handshakeState);
  // 第七轮 F-006 / B1-B-04：把**协商结果**交给传输层，供后续所有 POST 带 MCP-Protocol-Version。
  // 放在版本校验之后、notifications/initialized 之前：initialized 与 tools/list 都必须带这个头。
  // 只对实现了该方法的传输生效（stdio / 旧 SSE 传输没有这个方法，协议里也不要求）。
  if (server.transport && typeof server.transport.setProtocolVersion === 'function') {
    server.transport.setProtocolVersion(peerVersion);
  }
  // 2026-10-18 ⑥降噪：服务端采纳的版本与本端提议不同，**且仍在支持集内**——这不是错误，
  // 是 MCP 规范的正常协商结果（如 git-mcp 回 2025-03-26）。此前用 console.warn 每次都刷一行，
  // 把启动日志里的真实告警淹没；降为 info 级并合并为「协商结论」一句话。
  // 注意：真正不可接受的版本（不在 SUPPORTED_PROTOCOL_VERSIONS）已在上面 throw 断开，不走这里。
  if (peerVersion && peerVersion !== version) {
    console.log(`[MCP ${server.name}] 协议已协商：服务端 ${peerVersion} / 本端提议 ${version}（均受支持，采纳服务端值）`);
  }
  await notifyInitialized(server);
  return initRes;
}

/**
 * 判断错误是否是「服务端直接拒绝握手」的版本兼容性问题（区别于「回了个不支持的版本号」）。
 * 只有前者允许用 MIN_PROTOCOL_VERSION 重试一次；后者一律按 H-4 disconnect。
 */
function isProtocolVersionRejection(err) {
  if (!err) return false;
  if (err.mcpVersionUnsupported) return false; // 协商失败（已回版本号）→ 不重试
  if (err.mcpAuthRequired || err.mcpSessionExpired) return false;
  const m = String(err.message || '');
  const mentionsVersion = /protocolversion|protocol\s*version|protocol|version/i.test(m);
  const mentionsReject = /unsupported|not\s*support|invalid|unknown|mismatch|reject|unrecogni[sz]ed/i.test(m);
  return mentionsVersion && mentionsReject;
}

/**
 * 握手 + **最多一次**的 legacy 降级（team-lead 2026-10-17 裁决，修正 H-4 的绝对化表述）。
 * 触发条件三条全满足：① initialize 自身抛错（不是「回了不支持的版本号」）；
 * ② 错误文本能匹配 protocol/version + unsupported 语义；③ 本次连接尚未重试过。
 * 降级后必须留痕（server.legacy + console.warn），不静默、不无限次。
 */
async function negotiateHandshake(server) {
  try {
    return await performHandshake(server, PROTOCOL_VERSION);
  } catch (err) {
    if (server.legacyRetried || !isProtocolVersionRejection(err)) throw err;
    server.legacyRetried = true;
    console.warn(
      `[MCP ${server.name}] initialize 被拒（${String(err.message || '').slice(0, 120)}）；`
      + `按兼容性降级用 ${MIN_PROTOCOL_VERSION} 重试一次（不是静默降级，将留痕）`,
    );
    const res = await performHandshake(server, MIN_PROTOCOL_VERSION);
    Object.assign(server, { legacy: true });
    console.warn(`[MCP ${server.name}] 该服务已降级为 ${MIN_PROTOCOL_VERSION} legacy 模式（协商结果：${server.protocolVersion || '服务端未声明'}）`);
    return res;
  }
}

// tools/list 翻页到底（H-4：nextCursor 必须翻，上限 MAX_TOOL_PAGES 防服务端死循环）
async function fetchAllTools(server) {
  const all = [];
  let cursor = '';
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const res = await mcpRpcWithSessionRetry(server, 'tools/list', cursor ? { cursor } : {});
    if (Array.isArray(res && res.tools)) all.push(...res.tools);
    cursor = (res && res.nextCursor) || '';
    if (!cursor) return all;
  }
  console.warn(`[MCP ${server.name}] tools/list 分页达到上限 ${MAX_TOOL_PAGES} 页，已停止翻页（可能有工具未加载）`);
  return all;
}

/** 重拉工具列表并换装（连接期与 notifications/tools/list_changed 共用） */
async function refreshTools(server) {
  return registerTools(server, await fetchAllTools(server));
}

/**
 * 会话恢复互斥（P2-5）：并发请求同时收到 404 时，只让**一个**真正重建会话。
 *
 * 不互斥的后果：N 个并发请求各自 resetSession + initialize → N 次握手，http 传输的
 * `sessionId` 被后完成者覆盖（`mcpClient.js` 的 createHttpTransport 里 sessionId 是闭包变量），
 * 先完成的那次握手可能已被服务端作废 → 再次 404；而重试预算只有一次，于是这些请求全失败。
 *
 * 失败语义：在途者负责把错误抛给**它自己的**调用方；其余等待者吞掉错误后各自重试，
 * 重试若再失败会抛出原始错误（不会静默成功）。
 */
async function recoverSession(server, version, { handshake = performHandshake } = {}) {
  if (server._sessionRecovery) {
    try { await server._sessionRecovery; } catch { /* 由在途者向其调用方抛出 */ }
    return;
  }
  const recovery = (async () => {
    if (server.transport && typeof server.transport.resetSession === 'function') server.transport.resetSession();
    await handshake(server, version);
  })();
  server._sessionRecovery = recovery;
  try {
    await recovery;
  } finally {
    // 说明：只有「发起者」会走到这里（并发调用方在上面的 if 分支就 return 了），
    // 因此不存在多个 finally 竞争置 null 的情形；eslint 只看到 await 之后的属性赋值。
    // eslint-disable-next-line require-atomic-updates
    server._sessionRecovery = null;
  }
}

/**
 * 带会话恢复的 RPC（H-4：HTTP 传输收到 404 MUST 重新 initialize（不带 session id））。
 * 仅对「传输层明确报告会话失效」的错误重试一次，其余错误原样抛出。
 */
async function mcpRpcWithSessionRetry(server, method, params, timeoutMs) {
  try {
    return await mcpRpc(server, method, params, timeoutMs);
  } catch (err) {
    if (!err || !err.mcpSessionExpired || method === 'initialize') throw err;
    console.warn(`[MCP ${server.name}] 会话已失效（HTTP 404），按规范重新握手后重试 ${method}`);
    // 重新握手沿用上次协商用的提议版本（若已降级为 legacy，不要又提回 2025-11-25）
    await recoverSession(server, server.proposedProtocolVersion || PROTOCOL_VERSION);
    return mcpRpc(server, method, params, timeoutMs);
  }
}

// ── stdio 传输（2026-10-18 抽到 mcpStdioTransport.js，含 stderr 分级降噪）──
// createStdioTransport 由下方 require 引入并在 connectMcpServer 中经 dispatch=dispatchMessage 装配

// ── HTTP 传输族（2026-10-20 抽到 mcpHttpTransport.js）──
// Streamable HTTP / 旧版 SSE / consumeSse 三者内聚且与握手语义无关，整块搬出以避免
// 撞破 max-lines 的 800 行软档（该清单只减不增，禁止新增条目）。
// 注入 dispatch=dispatchMessage 与 timeoutMs=DEFAULT_TIMEOUT_MS：既保证消息仍回本文件的
// dispatchMessage，也保证超时口径只在本文件定义一处（不产生循环 require）。

// 按身份摘除的纯核：只在「registry 里这个名字仍指向同一个 server」时才删；抽成 registry 入参以便纯 Node 单测。
function detachFrom(registry, name, server) {
  if (registry.get(name) !== server) return false;
  registry.delete(name);
  return true;
}

// 回调侧摘注册表**必须按身份判断**：同名重连后新条目已注册，而旧 stdio 子进程的 'close'/'error'
// 回调只认 name，无条件 delete 会把新连接一起摘掉（表现为「刚显示已连接就掉线、工具全失效」）。
function detachServer(name, server) {
  return detachFrom(servers, name, server);
}

// 丢弃缓存条目：**先关传输再摘除**（只 delete 不 close → 子进程成孤儿，且它稍后退出会触发上面那条）。
function retireCached(name, cached) {
  try {
    if (cached && cached.transport && typeof cached.transport.close === 'function') cached.transport.close();
  } catch (e) {
    console.warn(`[MCP ${name}] 关闭旧传输失败（继续重建）：${e.message}`);
  }
  detachServer(name, cached);
}

// ── 服务名「编码后全名」长度闸（B3 #12：从 IPC 入口下移到连接收口点）──
// 本函数是**所有**连接路径的唯一收口（手动连接 / mcp:reconnect / 启动重连 / 崩溃自动重连 /
// 生态安装都经它建传输）。闸此前只在 ipc/mcp.js 的 mcp:connect 入口 → 存量已落盘的超长中文
// 服务名仍能经 reconnect 连上，而它每个工具名都超供应商 function.name 上限——表现成「连上了却
// 调不动」。阈值与判定只存在于 shared/mcpNameCodec.mjs 一处；本文件只负责接到收口点上。
let _nameCodecMod = null;
function loadNameCodec() {
  if (!_nameCodecMod) _nameCodecMod = import('../shared/mcpNameCodec.mjs');
  return _nameCodecMod;
}

/** 通过 → null；超限/不可用 → 沿用本函数既有的失败形状 `{ok:false,error}`（不另立错误形态）。 */
async function checkServerNameBudget(name) {
  let codec;
  try {
    codec = await loadNameCodec();
  } catch (e) {
    // 编解码器加载失败 → fail-closed（否则闸静默消失，退回到「连上了却调不动」）
    return { ok: false, error: `服务名长度校验失败：${e && e.message ? e.message : String(e)}` };
  }
  const probe = codec.buildToolName(name, 'probe');
  if (codec.isEncodedNameSafe(probe)) return null;
  return {
    ok: false,
    error: `编码后全名超限，请缩短服务名：「${name}」拼成工具名后为 ${probe.length} 字符，`
      + `超过 ${codec.MAX_ENCODED_FULL_NAME_CHARS} 字符上限`
      + '（非 ASCII 字符按 UTF-8 逐字节编码，中文 1 字约 9 字符；该服务即使连上，'
      + '其工具也会被模型供应商按函数名超长拒绝）。请改用更短的服务名，或改用字母/数字/连字符命名',
  };
}

// ── 连接（IPC 处理器与启动重连共用）── transport: 'stdio'（默认，command/args/env）| 'http' | 'sse'
async function connectMcpServer({
  name, transport = 'stdio', command, args = [], env = {}, url, headers = {},
  auth, onStatus, onLog,
}) {
  if (!name || typeof name !== 'string') return { ok: false, error: 'name 必填' };
  // B3 #12：闸在任何副作用之前（不建 transport、不 spawn、不写会话/缓存/配置）。
  const budgetErr = await checkServerNameBudget(name);
  if (budgetErr) return budgetErr;
  if (servers.has(name)) {
    const cached = servers.get(name);
    // 缓存命中前校验底层是否还活着（stdio 子进程可能已崩；http 恒活但会话可能失效）
    const alive = cached.transport && cached.transport.alive();
    if (alive && cached.handshakeDone === false && cached.ready) {
      // P2-5：握手在途时不能直接返回 toolCount:0（调用方会当成「已连接但无工具」）；等它就绪，超时则丢弃旧条目重建。
      let ready = false;
      try {
        ready = (await Promise.race([
          cached.ready,
          new Promise((r) => setTimeout(() => r(false), HANDSHAKE_WAIT_MS)),
        ])) === true;
      } catch { ready = false; }
      if (ready && cached.transport && cached.transport.alive()) {
        return { ok: true, server: name, toolCount: cached.tools.length, tools: cached.tools, cached: true };
      }
      console.warn(`[MCP ${name}] 缓存命中但握手未完成或期间断开，转为重新连接`);
      retireCached(name, cached);
    } else if (alive) {
      return { ok: true, server: name, toolCount: cached.tools.length, tools: cached.tools, cached: true };
    } else {
      console.warn(`[MCP ${name}] 缓存命中但底层已断开，转为重新连接`);
      retireCached(name, cached);
    }
  }

  let transportObj;
  try {
    // dispatch / timeoutMs 由本文件注入（见 mcpHttpTransport.js 头注释的「依赖注入」段）：
    //   · dispatchMessage —— 收到的 JSON-RPC 仍回本文件的分发器（按 id 唤醒 pending）；
    //   · DEFAULT_TIMEOUT_MS —— 超时口径只在本文件定义一处，不制造第二个 30000。
    transportObj = transport === 'http'
      ? createHttpTransport({
        name, url, headers, onLog, auth, dispatch: dispatchMessage, timeoutMs: DEFAULT_TIMEOUT_MS,
      })
      : transport === 'sse'
        ? createSseTransport({
          name, url, headers, onLog, auth, dispatch: dispatchMessage, timeoutMs: DEFAULT_TIMEOUT_MS,
        })
        : createStdioTransport({ command, args, env, onLog, dispatch: dispatchMessage });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const server = {
    name,
    // 2026-10-18：保留 stdio 启动参数——roots/list 据此回答「该服务被授权的目录」（见 mcpServerRequests.js）
    command: transportObj.kind === 'stdio' ? command : undefined,
    args: transportObj.kind === 'stdio' ? args : undefined,
    kind: transportObj.kind,
    transport: transportObj,
    pending: new Map(),
    nextId: 1,
    tools: [],
    // P1-8：清洗名 → 真实工具名（H-4 要求客户端有映射层）；未清洗时为空 Map
    toolNameMap: new Map(),
    stderrTail: '',
    handshakeDone: false,
    // P2-5：就绪信号（connectMcpServer 内新建）。缓存命中时若握手仍在途，等它完成再返回，
    // 否则会把 `toolCount: 0` 当成「连上了但没有工具」返回给调用方。
    ready: null,
    // P1-8②③：握手协商结果（由 performHandshake 写入，上层可查询）
    // protocolVersion 只放**服务端实际返回值**；我们提议的值单独存，避免把提议当协商结果。
    protocolVersion: '',
    proposedProtocolVersion: '',
    // legacy：服务端拒绝 2025-11-25 后已降级为 MIN_PROTOCOL_VERSION（仅一次，留痕可查）
    legacy: false,
    legacyRetried: false,
    capabilities: {},
    serverInfo: {},
    toolsChangedAt: 0,
    lastProgress: null,
    // P1-8④：此前恒 null → dispatchMessage 的通知分支永不进入（服务端通知全被丢弃）
    onNotify: (msg) => handleServerMessage(server, msg, { onLog }),
  };
  transportObj.serverRef = server; // 传输层回环到分发器
  // SSE 需要主动建流（GET），且必须在 serverRef 就绪之后——否则 endpoint/消息事件到达时无处分发
  transportObj.ensureStarted?.();
  // 握手阶段进程就没了（命令不存在 / 坏 shebang / 立刻崩）→ 立刻结算挂起的 RPC。
  // 不这么做的后果（2026-10-17 实测）：spawn ENOENT 明明几百毫秒就发生，但 initialize 要
  // 干等满 30s 超时，最后返回「MCP initialize 超时（30s）」——错误信息把「进程根本起不来」
  // 误报成「服务不响应」，用户按超时去排查网络/服务端，方向全错。
  const failHandshake = (message) => {
    if (server.handshakeDone) return;
    for (const [id, cb] of [...server.pending]) {
      server.pending.delete(id);
      try { cb({ error: { message } }); } catch (e) { console.warn('[MCP] 挂起请求结算回调异常:', e?.message || e); }
    }
  };
  // stderr 尾巴由**传输层**写入（transport.stderrTail），server.stderrTail 从来没人写：
  // 此前读它恒为空 ⇒「握手阶段退出」与「启动失败」的真实原因被吞掉（只剩 code=1）。
  const stderrTailOf = () => String((transportObj && transportObj.stderrTail) || server.stderrTail || '');
  if (transportObj.kind === 'stdio') {
    transportObj.child.on('close', (code) => {
      const current = detachServer(name, server); // 只在本条仍是当前注册时摘除（被新连接取代时不动新条目）
      const wasConnected = server.handshakeDone === true;
      console.log(`[MCP ${name}] 进程退出 code=${code}${wasConnected ? '（运行期崩溃，工具已失效）' : '（握手阶段退出）'}`);
      if (wasConnected) {
        if (server.disconnecting) return; // 主动断开：不上报 crashed
        if (!current) return; // 已被新连接取代：旧进程退出不是故障，不能把新连接状态覆盖成 crashed
        if (onStatus) onStatus(name, 'crashed', code);
      } else {
        const tail = stderrTailOf().trim().slice(0, 300);
        failHandshake(`MCP 服务进程在握手阶段退出（code=${code}）${tail ? `：${tail}` : ''}`);
      }
    });
    transportObj.child.on('error', (err) => {
      const current = detachServer(name, server);
      console.error(`[MCP ${name}] 启动失败:`, err.message);
      if (server.handshakeDone === true) {
        if (server.disconnecting) return; // 主动断开：不上报 crashed
        if (!current) return; // 同上：不覆盖新连接状态
        if (onStatus) onStatus(name, 'crashed', null);
      } else {
        // spawn ENOENT 就是这条路径：命令/解释器不存在
        failHandshake(`MCP 服务启动失败：${err.message}`);
      }
    });
  }
  // P2-5：就绪信号必须在 set 之前建好——缓存分支可能在握手完成前就命中这个条目
  let markServerReady;
  server.ready = new Promise((resolve) => { markServerReady = resolve; });
  servers.set(name, server);

  try {
    // D-804 S3（2026-10-21）：双栈协商的落点——**先试无状态栈，失败再握手**。
    // 两条栈的产物一致（server.protocolVersion / capabilities / tools），故下游 refreshTools、
    // 工具登记、会话恢复都不需要分叉；差异只在传输层（是否有 session id）与能力声明（S4）。
    const usedStateless = await tryStatelessDiscovery(server);
    if (!usedStateless) await negotiateHandshake(server); // 1. initialize（被拒时最多一次 legacy 降级）
    await refreshTools(server);
    Object.assign(server, { handshakeDone: true });
    markServerReady(true);
    return {
      ok: true, server: name, kind: server.kind, toolCount: server.tools.length, tools: server.tools,
      protocolVersion: server.protocolVersion, proposedProtocolVersion: server.proposedProtocolVersion,
      stateless: !!server.stateless,
      legacy: server.legacy, serverInfo: server.serverInfo, capabilities: server.capabilities,
    };
  } catch (err) {
    // H-4：版本不受支持 → 这里就是规范要求的 disconnect（关传输 + 摘注册表）
    markServerReady(false);
    transportObj.close();
    servers.delete(name);
    return {
      ok: false, error: err.message, needsAuth: err.mcpAuthRequired === true,
      unsupportedVersion: err.mcpVersionUnsupported === true, legacy: !!server.legacy,
      stderr: stderrTailOf(),
    };
  }
}

function getMcpServer(name) { return servers.get(name) || null; }
function listMcpServers() { return [...servers.keys()]; }

function disconnectMcpServer(name) {
  const s = servers.get(name);
  if (s) {
    // 主动断开不是崩溃：打标记后让 close 回调不再上报 crashed，
    // 否则「用户点了断开」会在渲染层显示成红色故障（P0-5④ 的状态消费会把两者混为一谈）。
    s.disconnecting = true;
    s.transport.close();
    servers.delete(name);
  }
}

// 应用退出：终止全部 stdio 子进程（SIGTERM → 1s 后 SIGKILL），防孤儿进程占端口
function killAllMcpServers() {
  let killed = 0;
  for (const [, s] of servers) {
    const t = s?.transport;
    if (!t || t.kind !== 'stdio' || !t.child) continue;
    try {
      const child = t.child;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      // 应用退出不是崩溃：避免退出瞬间给渲染层刷一批「服务已崩溃」的红色状态
      s.disconnecting = true;
      child.kill('SIGTERM');
      killed += 1;
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch { /* 已退出 */ }
      }, 1000).unref();
    } catch (e) {
      console.warn(`[MCP ${s.name}] 退出清理失败:`, e.message);
    }
  }
  if (killed > 0) console.log(`[MCP] 退出清理：已终止 ${killed} 个 MCP 子进程`);
  return killed;
}

// ── P3-1：请求级进度登记（token ↔ 回调）────────────────────────────────────
// 为什么需要这一层：MCP 的进度是**按 token 多路复用**的——同一条连接上可能同时跑着多个
// tools/call，服务端的 notifications/progress 只带 progressToken，不带「属于哪次调用」。
// 因此客户端必须自己记 token → 回调；不记就只能「留一条 lastProgress」，等于拿到数据没法
// 送给正确的人（这也是此前该项被列为遗留的实际原因）。
// 存放位置放在 `server` 上（而不是模块级全局 Map）：断连时 server 对象整体被丢弃，
// 登记表随之回收——不会出现「服务断了，token 还挂在全局表里」的泄漏。
function registerProgress(server, token, fn) {
  if (!server || token == null || token === '' || typeof fn !== 'function') return false;
  if (!(server.progressListeners instanceof Map)) server.progressListeners = new Map();
  server.progressListeners.set(String(token), fn);
  return true;
}

function dropProgressListener(server, token) {
  if (!server || token == null || token === '') return;
  if (server.progressListeners instanceof Map) server.progressListeners.delete(String(token));
}

module.exports = {
  mcpRpc, mcpRpcWithSessionRetry, dispatchMessage, handleServerMessage,
  shouldForwardLogLevel,
  createStdioTransport, createHttpTransport, consumeSse,
  connectMcpServer, checkServerNameBudget, getMcpServer, listMcpServers, disconnectMcpServer, killAllMcpServers,
  refreshTools, sanitizeToolName, resolveToolName, recoverSession,
  // P3-1：请求级进度（token 登记 / 摘除）。放在这里而不是 ipc/mcp.js，是因为
  // 「哪些 token 归哪个 server」是协议层事实，调用方只该关心「登记一个回调」。
  registerProgress, dropProgressListener,
  // 纯核 + 缓存丢弃：可在纯 Node 下观测「按身份摘除」「先关传输再摘除」两条语义，
  // 无需起真实子进程（起进程验证会 flake，见 MAX_LINES 与并发纪律）
  detachFrom, detachServer, retireCached,
  PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_TIMEOUT_MS,
};
