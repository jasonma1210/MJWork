// 模拟 MCP Server：严格按协议响应 initialize / notifications/initialized / tools/list / tools/call
process.stdin.setEncoding('utf8');
let buf = '';

process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.method === 'initialize') {
      respond(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-mcp', version: '1.0' } });
    } else if (msg.method === 'notifications/initialized') {
      // 通知无需响应
    } else if (msg.method === 'tools/list') {
      respond(msg.id, {
        tools: [
          { name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
        ],
      });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params || {};
      // P3-1：进度上报是按规范的**条件行为**——只有请求带了 _meta.progressToken，服务端才发
      // notifications/progress（客户端没给令牌 = 它不打算处理进度，发了也没人去处）。
      // 夹具严格照此实现，这样"没收到进度"才能作为"客户端没发令牌"的可观测证据。
      const token = msg.params && msg.params._meta ? msg.params._meta.progressToken : undefined;
      if (name === 'add' && token) {
        notifyProgress(token, 1, 2);
        // 让第二条进度与响应之间有可观测的时间差，防止测试把两者挤在同一 tick 里
        setTimeout(() => {
          notifyProgress(token, 2, 2);
          respond(msg.id, { content: [{ type: 'text', text: String(args.a + args.b) }] });
        }, 5);
      } else if (name === 'echo') respond(msg.id, { content: [{ type: 'text', text: `echo: ${args.text}` }] });
      else if (name === 'add') respond(msg.id, { content: [{ type: 'text', text: String(args.a + args.b) }] });
      else respond(msg.id, null, { code: -32601, message: 'unknown tool' });
    }
  }
});

function respond(id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result, error }) + '\n');
}

/** P3-1：进度通知（无 id = notification，客户端不回执） */
function notifyProgress(progressToken, progress, total) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken, progress, total, message: `step ${progress}/${total}` },
  }) + '\n');
}
