// MCP **HTTP 传输族**（2026-10-20 从 mcpClient.js 抽出）
//
// 为什么抽出来（不是洁癖，是门禁）：
//   `desktop/test/max-lines.test.js` 的 800 行软档规定：source 目录内 >800 行的文件必须全部
//   在 `BASELINE_800` 里，而该清单**只减不增、禁止新增**（防「为绕 800 去改基线」重演）。
//   B1-B-04 给 Streamable HTTP 补 `MCP-Protocol-Version` 后 mcpClient.js 由 790 → 815 行，
//   撞破软档。正确的处置是把**内聚的一整块**搬出去，而不是加基线。
//
// 本文件 = 两种 HTTP 传输 + SSE 流解析，三者本来就互相依赖、且与「握手 / 工具登记 / 会话恢复」
//   这些 JSON-RPC 语义无关，抽在一起内聚性最好：
//     · createHttpTransport —— MCP Streamable HTTP（spec 2025-03-26 起）：POST JSON-RPC，
//        响应可为 application/json（单响应）或 text/event-stream（SSE，含响应与后续通知）；
//        initialize 时捕获 Mcp-Session-Id，后续请求回带；
//        B1-B-04：initialize 之后所有 POST 还带 `MCP-Protocol-Version`（协商值）。
//     · consumeSse —— SSE 流解析（三种行尾 / 多行 data / 命名事件）。
//     · createSseTransport —— 旧版 HTTP+SSE（MIN_PROTOCOL_VERSION 那一代）。
//
// 依赖注入（**不要**改成 require('./mcpClient')，那是循环依赖）：
//   · dispatch(serverRef, msg) —— 收到的 JSON-RPC 消息往哪儿投递。mcpClient 传的是
//     `dispatchMessage`；stdio 传输早就用同一手法（`dispatch: dispatchMessage`）。
//   · timeoutMs —— 单请求墙钟超时。由 mcpClient 注入 `DEFAULT_TIMEOUT_MS`，
//     保证「超时口径只在一处定义」，不在这里再写一个 30000。
//   · 传输对象上的 `serverRef` 仍由 connectMcpServer 回环赋值（SSE 必须等它就绪才能建流）。
//
// 安全说明（与 webTools 的 SSRF 防护刻意不同）：
//   MCP 服务地址来自**用户显式配置**（设置页/连接器目录），不是模型可控参数——
//   且本地 localhost 恰是自托管 MCP 最常见的形态，因此 http 传输**不套用**
//   webTools 的私网拦截；模型只能调用「已连接服务」的已注册工具（callMcpTool 按
//   server/tool 名分发），无法引导客户端连到任意 URL。

// 未注入 dispatch 时的兜底：响应无处投递（正常路径绝不会走到，mcpClient 一定注入）。
const NO_DISPATCH = () => {};

// ── Streamable HTTP 传输 ──
// auth（T7 OAuth 引擎注入，均可缺省）：
//   getHeader() -> 'Bearer xxx' | null  —— 每次发送前取有效令牌（静态 headers 已带 Authorization 时不覆盖）
//   refresh()   -> 'Bearer xxx' | null  —— 401 时强制续期，成功重试一次，仍 401 抛 mcpAuthRequired
function createHttpTransport({
  // name 为传输标识占位，当前工厂实现不读取；保留以匹配上层构造入参结构
  name: _name, url, headers = {}, onLog, auth, dispatch = NO_DISPATCH, timeoutMs = 30000,
}) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('HTTP 传输需要服务地址（url）');
  let sessionId = '';
  // 第七轮 F-006 / B1-B-04：MCP 2025-06-18 起，Streamable HTTP 的客户端 MUST 在
  // **initialize 之后的所有请求**上带 `MCP-Protocol-Version: <协商到的版本>`。
  // 不带的话，严格实现直接回 400 —— 而本仓 mcpProtocol.js 明确声称支持
  // 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 四代，
  // 「声明支持」与「传输按规范发头」不一致就是能力虚报。
  //
  // 取值只认**服务端在 initialize 结果里回的版本**（performHandshake 经 setProtocolVersion 写入），
  // 不拿我们自己提议的版本冒充：服务端没声明版本时保持空，也就不发这个头（兼容极老服务端）。
  //
  // 本处是「2026 双栈」的唯一改造点（D-01 退路）：将来若要做 2026-07-28（取消 initialize 握手）
  // 的并行双栈，也在这里按协商结果切换，不扩散到调用方。
  let protocolVersion = '';
  // ── D-804 S2（2026-10-21）：无状态栈开关 ──────────────────────────────────
  // 2026-07-28 取消 initialize 与 Mcp-Session-Id：每个请求自带版本与路由头，服务端不建会话。
  // 打开后：① 不发送也不接收 Mcp-Session-Id；② 每个 POST 带 `MCP-Protocol-Version`（从第一
  // 个请求就带，因为没有 initialize 可等）；③ 按新规范带 `Mcp-Method`（+ 有名字的方法带 `Mcp-Name`）。
  // 关掉必须把 protocolVersion 复位为空：否则回落握手栈时会把无状态版本当作「已协商版本」发出去。
  let stateless = false;
  const transport = {
    kind: 'http',
    // 由 performHandshake 在拿到服务端协议版本后调用；传空串表示「不发该头」。
    setProtocolVersion(v) { protocolVersion = typeof v === 'string' ? v : ''; },
    /** 切换无状态栈（D-804）。enabled=false 时同时清掉协议版本头，避免污染握手栈。 */
    setStateless(enabled, version = '') {
      stateless = !!enabled;
      protocolVersion = stateless ? String(version || '') : '';
      if (stateless) sessionId = '';
    },
    isStateless() { return stateless; },
    async send(payload, requestId) {
      // 新规范的路由头：从请求体里取 method（与 params.name），取不到就只带版本。
      // 解析失败不能阻断发送——头是路由器提示，不是鉴权凭据。
      let routeHeaders = {};
      if (stateless) {
        try {
          const j = JSON.parse(payload);
          if (j && typeof j.method === 'string') {
            routeHeaders = { 'Mcp-Method': j.method };
            const nm = j.params && (j.params.name || j.params.uri);
            if (typeof nm === 'string' && nm) routeHeaders['Mcp-Name'] = nm;
          }
        } catch { /* 非 JSON 载荷极少见；无头也能发 */ }
      }
      const call = (bearer) => fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          // 无状态栈按规范不建会话，也就不回带（见上方 setStateless 注释）
          ...(!stateless && sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          // initialize 本身不带（此时协商值还是空）；之后的每个 POST 都带。
          // 放在自定义 headers 之前：用户若显式配了同名 header，以用户的为准。
          ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
          ...routeHeaders,
          ...headers,
          ...(bearer ? { Authorization: bearer } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      let res = await call(auth && !headers.Authorization ? await auth.getHeader() : null);
      if (res.status === 401 && auth) {
        await res.text().catch(() => {});
        const fresh = await auth.refresh().catch(() => null);
        if (fresh) res = await call(fresh);
        if (res.status === 401) {
          await res.text().catch(() => {});
          const err = new Error('授权无效或已过期（HTTP 401），请在连接器面板重新授权该服务');
          err.mcpAuthRequired = true;
          throw err;
        }
      }
      // 会话建立：initialize 的响应头带 Mcp-Session-Id，后续请求必须回带
      // D-804：无状态栈下服务端**不该**给 session id；给了也不采用（采用就会退回有状态语义）
      const sid = res.headers.get('mcp-session-id');
      if (!stateless && sid) sessionId = sid;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // H-4：会话失效（服务端已丢弃 Mcp-Session-Id，常见于服务重启/会话超时）→ 404。
        // 规范要求：MUST 重新 initialize（不带 session id）后重试。这里只把「会话失效」标记出来，
        // 由 mcpClient 的 mcpRpcWithSessionRetry 统一重新握手，避免传输层自己发起握手造成递归。
        if (res.status === 404 && sessionId && requestId !== undefined) {
          const err = new Error(`MCP 会话已失效（HTTP 404${text ? `: ${text.slice(0, 120)}` : ''}），将重新握手`);
          err.mcpSessionExpired = true;
          throw err;
        }
        // 通知（无 id）没有响应：JSON-RPC 规范里它的失败不影响主流程。
        // 实测部分服务端对 notifications/initialized 直接回 404/405（只有真实请求才建会话），
        // 若按错误抛出会把「通知被拒」误报成「连接失败」。
        if (requestId === undefined) {
          if (onLog) onLog(`通知返回 HTTP ${res.status}（按规范忽略）`);
          return;
        }
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      const ctype = String(res.headers.get('content-type') || '');
      if (/text\/event-stream/i.test(ctype)) {
        // SSE：逐事件解析 data: 行，命中对应 id 即完成；流保持到服务端关闭
        await consumeSse(res, (msg) => dispatch(transport.serverRef, msg));
        return;
      }
      // 单 JSON 响应
      const text = await res.text();
      if (!text.trim()) return; // 通知（notifications/*）的 202 无 body：不是错误，别刷日志
      try { dispatch(transport.serverRef, JSON.parse(text)); }
      catch { if (onLog) onLog(`非 JSON 响应: ${text.slice(0, 120)}`); }
    },
    close() { /* HTTP 无子进程；会话随进程结束（DELETE 语义属服务端可选实现，不强制） */ },
    // H-4：重新 initialize 前必须清掉旧会话 id，否则新握手仍带着已失效的会话。
    // B1-B-04：协商版本必须一起清 —— 重握手的那条 initialize 请求按规范**不带**
    // MCP-Protocol-Version，新版本等本次 initialize 回来再由 setProtocolVersion 写入。
    resetSession() { sessionId = ''; protocolVersion = ''; },
    alive() { return true; },
    stderrTail: '',
  };
  return transport;
}

// 解析 SSE 流：事件 → JSON
//
// 2026-10-17 真机修复（远程 MCP 大面积连不上的根因）：
//   SSE 规范允许三种行尾（LF / CRLF / CR），实测 DeepWiki 用 **CRLF**——原实现只按 '\n\n' 切分，
//   CRLF 下事件分隔是 '\r\n\r\n'（序列为 \r \n \r \n，不含连续 '\n\n'），于是**永远切不开**：
//   initialize 的响应到了却没人解析 → 卡满 30s 报「MCP initialize 超时」。
//   而返回单 JSON 的服务端（24haowan）正常 ⇒ 现象恰好表现为「一部分能连、一部分连不上」。
// 同时按规范处理一个事件内多行 data（用 '\n' 拼接后再 parse）与注释/event/id/retry 行。
async function consumeSse(res, onData, onNamedEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handleEvent = (raw) => {
    let evtName = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) { evtName = line.slice(6).trim() || 'message'; continue; }
      if (!line.startsWith('data:')) continue; // id: / retry: / ':' 注释行一律跳过
      dataLines.push(line.slice(5).replace(/^ /, '')); // 规范：冒号后首个空格是分隔符
    }
    if (!dataLines.length) return;
    const data = dataLines.join('\n').trim();
    // 命名事件（SSE 传输的 `endpoint`）的 data 是路径而非 JSON-RPC，交给调用方
    if (evtName !== 'message' && typeof onNamedEvent === 'function') { onNamedEvent(evtName, data); return; }
    if (!data || data === '[DONE]') return;
    try { onData(JSON.parse(data)); } catch { /* 非 JSON 事件忽略 */ }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 行尾归一后再切事件。归一化是幂等的；跨 chunk 被截断的 '\r' 会在下一轮重新归一，
    // 最坏情况只是把一个事件提前切开一次，data 内容仍完整（已推演边界）。
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events = buf.split('\n\n');
    buf = events.pop();
    for (const evt of events) handleEvent(evt);
  }
  if (buf.trim()) handleEvent(buf); // 流结束时没有尾随空行
}

// ── SSE 传输（旧版 HTTP+SSE，即 MIN_PROTOCOL_VERSION 那一代的 http 形态）──
//
// 与 streamableHttp 的区别（为什么必须单独一个 transport）：
//   · streamableHttp：一个 POST 携带一条消息，响应在同一次 POST 里回来（JSON 或 SSE 流）；
//   · SSE：先 GET 建一条长连接，服务端用 `event: endpoint` 告知消息投递路径，
//     之后客户端 POST 到该路径，**响应从那条长连接回来**。
// 两者的 endpoint 发现与发送语义完全不同，共用一个 transport 会把两种情况都做错。
//
// 2026-10-17 新增：WorkBuddy 目录里有 11 条 `type: sse` 的服务，此前被直接跳过（导入时排除），
// 用户点不到。这里补上，按官方实现顺序：GET → 等 endpoint → POST。
function createSseTransport({
  // name 为传输标识占位，当前工厂实现不读取；保留以匹配上层构造入参结构
  name: _name, url, headers = {}, onLog, auth, dispatch = NO_DISPATCH, timeoutMs = 30000,
}) {
  const base = String(url || '').trim();
  if (!base) throw new Error('SSE 传输需要服务地址（url）');
  let endpoint = '';
  let closed = false;
  let started = false;
  let abortCtl = null;
  let readyResolve = null;
  let readyReject = null;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => { /* 未消费的 rejection 会刷 unhandledRejection 日志，这里兜住 */ });

  const withAuth = async (extra) => {
    const h = { ...extra, ...headers };
    if (auth && !headers.Authorization) {
      const bearer = await auth.getHeader().catch(() => null);
      if (bearer) h.Authorization = bearer;
    }
    return h;
  };

  const transport = {
    kind: 'sse',
    // 由 connectMcpServer 在 transportObj.serverRef 赋值后调用：
    // 必须等到 serverRef 就绪才能 dispatch（否则事件到达时找不到分发表）
    ensureStarted() {
      if (started) return;
      started = true;
      abortCtl = new AbortController();
      (async () => {
        const res = await fetch(base, { headers: await withAuth({ Accept: 'text/event-stream' }), signal: abortCtl.signal });
        if (res.status === 401) {
          const err = new Error('授权无效或已过期（HTTP 401），请在连接器面板重新授权该服务');
          err.mcpAuthRequired = true;
          throw err;
        }
        if (!res.ok) throw new Error(`SSE 建流失败：HTTP ${res.status}`);
        if (!res.body || typeof res.body.getReader !== 'function') throw new Error('SSE 建流失败：响应不是流');
        await consumeSse(
          res,
          (msg) => dispatch(transport.serverRef, msg),
          (evtName, data) => {
            if (evtName !== 'endpoint') return;
            // data 可能是相对路径（`/messages?sessionId=xxx`）——按建流地址解析成绝对 URL
            try { endpoint = new URL(data, base).toString(); } catch { endpoint = data; }
            if (onLog) onLog(`SSE endpoint: ${endpoint}`);
            readyResolve();
          },
        );
      })()
        .catch((e) => {
          closed = true;
          if (!endpoint) readyReject(e);
          else if (onLog) onLog(`SSE 流已断开：${e.message}`);
        })
        .finally(() => { closed = true; });
    },
    async send(payload, requestId) {
      await ready; // endpoint 未就绪时先等（initialize 也走这条路）
      if (closed) throw new Error('SSE 连接已断开，请重新连接该服务');
      const isNotification = requestId === undefined;
      const post = (h) => fetch(endpoint, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      let res = await post(await withAuth({}));
      if (res.status === 401 && auth) {
        await res.text().catch(() => {});
        const fresh = await auth.refresh().catch(() => null);
        if (fresh) res = await post({ ...headers, Authorization: fresh });
        if (res.status === 401) {
          await res.text().catch(() => {});
          const err = new Error('授权无效或已过期（HTTP 401），请在连接器面板重新授权该服务');
          err.mcpAuthRequired = true;
          throw err;
        }
      }
      // 规范：消息投递成功即 202；部分实现回 200/204，也算成功
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isNotification) { if (onLog) onLog(`通知返回 HTTP ${res.status}（按规范忽略）`); return; }
        throw new Error(`SSE 发送失败：HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      await res.text().catch(() => {});
    },
    close() {
      closed = true;
      try { abortCtl?.abort(); } catch { /* 已关闭 */ }
    },
    alive() { return started && !closed; },
    // 注意：stdio 传输的 stderr 尾巴写在 transport.stderrTail（mcpStdioTransport 里持续写入）。
    // 这里**不要**再加一个同名的 server.stderrTail 空字段——它从来没人写，
    // 后人读到会以为「拿到空串 = 服务端没输出」，把真实报错原因又吞回去。
  };
  return transport;
}

module.exports = { createHttpTransport, consumeSse, createSseTransport };
