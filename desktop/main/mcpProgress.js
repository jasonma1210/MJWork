// P3-1（2026-10-29）：MCP 请求级进度的「主进程 → 渲染层」桥。
//
// 为什么单独一个文件：`ipc/mcp.js` 已顶到 800 行软档（该档只减不增），而这段逻辑与 IPC
// 机制无关——它只做「把服务端进度转成发给某个窗口的事件」。外置后 mcp.js 只剩三行接线，
// 也让这段逻辑可以脱离 electron 单独被测试（见 test/mcp-handshake.test.js 的 [3b]）。
//
// 语义两条，容易写错的地方都在这里钉住：
//   ① 只推**发起方窗口**，不广播：进度是「这次调用」的副作用，别的窗口既没有对应的等待
//      卡片，也无权知道另一个会话在跑什么工具。
//   ② 发送一律吞异常：窗口中途关闭是最常见的情形，绝不能因此把一次工具调用变成失败
//      （工具结果的价值远高于一条进度条）。
//
// 为什么 phase 由本模块补齐而不是透传服务端的字段：服务端的 notifications/progress 只有
// progress/total/message，没有「开始/结束」概念——结束由客户端在调用收尾时判定，
// 故 end 的语义完全在客户端侧，不该假装是协议给的。

/**
 * 生成一次调用专用的 progressToken。
 * 为什么带时间戳前缀：服务端日志里同一个工具会连续出现多条进度，带时间的前缀能让
 * 「这次调用的进度」与「上一次」在排障时可直接区分（纯随机串做不到）。
 */
function newProgressToken(seed) {
  const base = Number.isFinite(seed) ? Number(seed) : Date.now();
  return `mj-${base.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object|null} sender 发起方 webContents（没有则整条桥降级为「不接进度」）
 * @param {string} server 服务名（事件里回传，供界面定位到具体行）
 * @param {string} tool 工具名
 * @returns {{ onProgress: ((p:object)=>void)|null, done: () => void }}
 */
function makeProgressBridge(sender, server, tool) {
  const canSend = !!(sender && typeof sender.send === 'function');
  const send = (payload) => {
    try { sender.send('mcp:progress', payload); } catch { /* 窗口已关：丢弃即可，不影响调用 */ }
  };
  return {
    // 无窗口 ⇒ onProgress 为 null ⇒ callMcpTool 不会发 progressToken ⇒ 服务端不会产生进度。
    // 这条链是「不发令牌就不发进度」的规范行为，也是「无人接收时不浪费服务端算力」的实现。
    onProgress: canSend ? (p) => send({ server, tool, phase: 'update', ...p }) : null,
    done: () => { if (canSend) send({ server, tool, phase: 'end' }); },
  };
}

/**
 * 在调用落定时补一条 end 事件，并把原 promise 原样返回给 IPC。
 *
 * 为什么不是 `.finally(bridge.done)`：finally **派生出的新 promise 会继承这次拒绝**，而它
 * 没有任何人 await ⇒ 每次失败的工具调用都会额外制造一个 unhandled rejection。实测代价是
 * 「未连接的服务」那条用例让 `test/helpers/unhandled-preload.cjs` 判死整个 mcp-handshake 套件
 * （而该套件单独跑是绿的——只有加了统一 preload 的 npm test 才看得见）。
 * 双回调写法里两支都只返回 undefined，派生 promise 恒 resolve；拒绝仍由原 p 传回调用方。
 */
function settleProgress(p, bridge) {
  Promise.resolve(p).then(bridge.done, bridge.done);
  return p;
}

module.exports = { newProgressToken, makeProgressBridge, settleProgress };
