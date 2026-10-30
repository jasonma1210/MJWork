'use strict';
// P2-4：MCP 服务端 → 客户端**请求**应答（2026-10-18 从 mcpClient.js 抽出，控制其体量）
//
// 与 mcpProtocol.CLIENT_CAPABILITIES 一一对应——严守「声明 ⇔ 实现」纪律：
// 能力表声明了哪项，这张表就必须有对应应答，反之亦然。
// 门禁：test/mcp-server-requests.test.mjs 断言两侧一致。
//
// 独立成模块的原因：纯 JSON-RPC 应答语义，零传输/注册表依赖（server 只用 transport.send），
// 抽出后 mcpClient.js 可回到 800 行门禁内，也便于单测直测。

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// 该服务**被授权的目录** = 其自身启动参数里的绝对目录（真实存在且确实是目录的才作数）。
//
// 为什么只认启动参数：参数是用户配置连接器时显式给出的授权面（连接器目录里
// permissions.scope = user-allowed-directory 的同一语义）。不把项目根 / 用户主目录塞进来——
// 「为某个 MCP 服务开放哪些目录」是需要 UI 明示的产品决策，不在客户端里替用户扩大授权面。
// 2026-10-18 之前固定返回空清单：那对依赖 roots 的服务端等于「声明了能力却什么都不给」，
// 服务端只能以零目录启动（官方 filesystem 服务端会打印 No valid root directories provided by client）。
function allowedRoots(server) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(server && server.args) ? server.args : [])) {
    const s = String(raw || '').trim();
    if (!s || !path.isAbsolute(s) || seen.has(s)) continue;
    try {
      if (!fs.statSync(s).isDirectory()) continue;
    } catch { /* C-001：不存在 / 无权限就不作为根暴露——按「不暴露」处理是安全侧默认，不需要日志 */ continue; }
    seen.add(s);
    out.push({ uri: pathToFileURL(s).href, name: path.basename(s) || s });
  }
  return out;
}

const SERVER_REQUEST_HANDLERS = Object.freeze({
  // 规范要求：收到 ping 必须尽快回空结果——传输层把它当保活判据，不回会被服务端判死。
  ping: () => ({}),
  // roots：回该服务被授权的目录（见 allowedRoots）。拿不到授权目录时回空清单——
  // 空清单是规范允许的诚实应答，好过挂死或报错，但**服务端会因此以零目录启动**，
  // 所以连接器必须把目录参数填全（未填全的配置已在 spawn 前被 mcpSpawnGuard 拦下）。
  'roots/list': (_params, ctx) => ({ roots: allowedRoots(ctx && ctx.server) }),
  // completion：参数自动补全。空补全集是规范允许的最小合法应答；真实补全需要读取
  // 服务端 prompt/resource 元数据并做前缀匹配，当前无此需求面（模型侧自行生成参数）。
  'completion/complete': () => ({ completion: { values: [], total: 0, hasMore: false } }),
});

/**
 * 尝试应答一条服务端 → 客户端的 JSON-RPC 请求。
 * 已实现能力：回 result（处理器异常回 -32603，绝不让服务端等死）并返回 true；
 * 未实现：返回 false，由调用方按「未声明能力」回 -32601。
 * @param {object} server MCP 连接实例（用到 transport.send）
 * @param {{id: unknown, method: string, params?: object}} msg 服务端请求
 * @param {(...a: unknown[]) => void} [log] 日志通道
 * @returns {boolean} 是否已应答
 */
function answerServerRequest(server, msg, log = () => {}) {
  const method = String(msg.method);
  const handler = SERVER_REQUEST_HANDLERS[method];
  if (!handler) return false;
  let result;
  try {
    result = handler(msg.params || {}, { server });
  } catch (e) {
    // 处理器内部异常也要回执（不能让服务端等死）：按 JSON-RPC 内部错误回
    Promise.resolve(server.transport.send(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32603, message: `处理 ${method} 失败：${e.message}` },
    }), msg.id)).catch(() => { /* 回执失败不影响主流程 */ });
    log(`服务端请求 ${method} 处理失败，已回 -32603`);
    return true;
  }
  Promise.resolve(server.transport.send(JSON.stringify({
    jsonrpc: '2.0', id: msg.id, result: result || {},
  }), msg.id)).catch(() => { /* 回执失败不影响主流程 */ });
  return true;
}

module.exports = { SERVER_REQUEST_HANDLERS, answerServerRequest };
