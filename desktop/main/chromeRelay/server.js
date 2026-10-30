// T4-2：Chrome 接管中继服务（主进程侧）——本地 WebSocket 服务，对接 Chrome 扩展。
// 设计（fail-closed 是本任务验收核心）：
//   · 只监听 127.0.0.1：接管面不暴露到局域网；
//   · 连接生命周期：connection → hello(nonce) → identify(回显 nonce) → 审批卡 → active/denied；
//     未批准的连接发来的任何 callRes 一律忽略，审批拒绝或超时立即断开；
//   · 授权只对当次连接有效：每次新连接都重新弹卡（「首次连接逐次授权」），
//     决策不沉淀「始终允许」——接管用户的登录态浏览器不能靠一条永久规则放行；
//   · 同一时刻只保留一个 active 连接：新连接批准后顶替旧连接（扩展重连场景），旧连接被断开；
//   · call 超时/连接断开 → 该 call 立即失败（chromeNotConnected），绝不静默挂起。
// 依赖注入 initChromeRelay({ requestApproval, port })：审批走 main.js 审批中心（120s 超时按拒绝）。
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { DEFAULT_RELAY_PORT, CALL_TIMEOUT_MS } = require('./protocol');

let deps = null;
let wss = null;
let activeConn = null; // { sock, info, since }
let listenError = null; // 启动失败原因（status 透出，供设置页/诊断）
let listenPort = 0;
let listeningNow = false; // ws 8.x 无公开 .server 属性，监听状态由本模块自行跟踪
const pendingCalls = new Map(); // callId -> {resolve, reject, timer, sock}
let callSeq = 0;

function initChromeRelay(d = {}) {
  deps = { port: DEFAULT_RELAY_PORT, ...d };
}

function isListening() {
  return listeningNow;
}

// 启动监听（幂等）。端口占用等错误不抛出——记录 listenError 并降级（Chrome 接管不可用，其余功能不受影响）
function start() {
  if (wss) return Promise.resolve(listenPort);
  // port=0 表示「系统分配空闲端口」（测试用）：必须用显式数值判定，
  // 不能用 `Number(port) || DEFAULT`——0 会被 || 吞掉回退默认端口。
  const raw = deps && deps.port;
  const port = Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : DEFAULT_RELAY_PORT;
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 32 * 1024 * 1024 });
    wss = server;
    server.on('listening', () => {
      listenPort = server.address().port;
      listenError = null;
      listeningNow = true;
      console.log(`[chromeRelay] Chrome 接管中继已监听 ws://127.0.0.1:${listenPort}`);
      resolve(listenPort);
    });
    server.on('error', (err) => {
      listenError = err.message;
      listeningNow = false;
      console.warn('[chromeRelay] 中继启动失败（Chrome 接管暂不可用）:', err.message);
      resolve(0); // 不抛出：启动失败是降级，不是崩溃
    });
    server.on('connection', onConnection);
  });
}

function closeConn(sock, code, reason) {
  try { sock.close(code, reason); } catch { /* 已断开 */ }
}

// 断开连接时的统一收尾：清挂起 call、撤 active 标记。
// 置 __state='closed'：审批挂起期间客户端断开的竞态下，审批回执后的守卫据此拒绝激活僵尸连接
function teardown(sock) {
  sock.__state = 'closed';
  for (const [id, p] of pendingCalls) {
    if (p.sock === sock) {
      clearTimeout(p.timer);
      pendingCalls.delete(id);
      p.reject(Object.assign(new Error('Chrome 连接已断开'), { chromeNotConnected: true }));
    }
  }
  if (activeConn && activeConn.sock === sock) activeConn = null;
}

async function onConnection(sock) {
  sock.__state = 'pending'; // pending -> active | denied
  sock.isAlive = true;
  sock.on('pong', () => { sock.isAlive = true; });
  const nonce = crypto.randomBytes(16).toString('hex');
  try { sock.send(JSON.stringify({ t: 'hello', nonce })); } catch {
    // C-001：socket 已关闭（扩展侧断线重连的常态竞态）。握手消息无从下发，
    // 也没有后续可补救的动作 —— 这不是降级，是「连接在握手前就没了」。
    return;
  }

  sock.on('message', async (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); } catch {
      // C-001：不是静默 —— 下面立刻以 4002/bad-json 关闭连接，调用方拿到明确失败码
      return closeConn(sock, 4002, 'bad-json');
    }
    if (!msg || typeof msg !== 'object') return;

    if (sock.__state === 'pending') {
      if (msg.t !== 'identify') return; // 未批准前只接受 identify（其余消息 fail-closed 忽略）
      // nonce 必须回显 hello 的质询：证明消息来自本连接的 hello 之后，防抢跑/重放
      if (!msg.nonce || msg.nonce !== nonce) return closeConn(sock, 4003, 'bad-nonce');
      sock.__state = 'approving';
      const info = {
        extension: String(msg.extension || '').slice(0, 80),
        version: String(msg.version || '').slice(0, 20),
        userAgent: String(msg.userAgent || '').slice(0, 200),
      };
      let decision = 'deny';
      try {
        decision = await deps.requestApproval('chrome_connect', info);
      } catch {
        // C-001：审批通道异常按拒绝（fail-closed）——「拒绝」本身就是安全结果，不是被吞掉的失败
        decision = 'deny';
      }
      if (sock.__state !== 'approving') return; // 审批期间已断开/被顶替
      if (decision === 'deny') {
        sock.__state = 'denied';
        return closeConn(sock, 4004, 'denied');
      }
      // 批准：顶替旧 active（扩展重连后新连接接管）
      if (activeConn) closeConn(activeConn.sock, 4005, 'replaced');
      sock.__state = 'active';
      activeConn = { sock, info, since: Date.now() };
      console.log('[chromeRelay] Chrome 接管已授权:', info.userAgent.slice(0, 60));
      return;
    }
    // active 连接：只消费 callRes（协议上扩展不主动发其他消息）
    if (msg.t === 'callRes') {
      const p = pendingCalls.get(msg.callId);
      if (!p || p.sock !== sock) return;
      pendingCalls.delete(msg.callId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(String(msg.error || '扩展调用失败')), { chromeCallError: true }));
    }
  });

  sock.on('close', () => teardown(sock));
  sock.on('error', () => teardown(sock));
}

// 执行一次扩展侧调用（chromeTools 唯一入口）
function call(method, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
  if (!activeConn || activeConn.sock.__state !== 'active') {
    return Promise.reject(Object.assign(
      new Error('Chrome 未连接：请确认已在 Chrome 加载 MJ Code 接管扩展并批准连接审批卡'),
      { chromeNotConnected: true },
    ));
  }
  const sock = activeConn.sock;
  const callId = `c${++callSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      // 超时=扩展侧失控：断开连接强制重新授权（fail-closed，不信任卡死的接管面）
      closeConn(sock, 4006, 'call-timeout');
      reject(Object.assign(new Error(`Chrome 调用超时：${method}（连接已重置，需重新授权）`), { chromeNotConnected: true }));
    }, timeoutMs);
    pendingCalls.set(callId, { resolve, reject, timer, sock });
    try { sock.send(JSON.stringify({ t: 'call', callId, method, args })); }
    catch (err) {
      clearTimeout(timer);
      pendingCalls.delete(callId);
      reject(Object.assign(new Error(`Chrome 发送失败：${err.message}`), { chromeNotConnected: true }));
    }
  });
}

// 连接状态（chrome_status 工具与设置页用）：只读，不触发任何页面操作
function status() {
  return {
    listening: isListening(),
    port: listenPort,
    error: listenError,
    connected: !!activeConn,
    since: activeConn ? activeConn.since : null,
    browser: activeConn ? activeConn.info.userAgent : null,
  };
}

function close() {
  for (const [, p] of pendingCalls) { clearTimeout(p.timer); p.reject(Object.assign(new Error('中继已关闭'), { chromeNotConnected: true })); }
  pendingCalls.clear();
  if (activeConn) { closeConn(activeConn.sock, 4000, 'shutdown'); activeConn = null; }
  if (wss) { try { wss.close(); } catch { /* 已关闭 */ } wss = null; }
  listeningNow = false;
  listenPort = 0;
}

module.exports = { initChromeRelay, start, call, status, close, isListening };
