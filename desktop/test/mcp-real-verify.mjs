// MCP 真实可调用性验证（2026-10-16，用户诉求：核查 MCP 服务是否真实可以被调用）
// 覆盖三层，全部走主进程真实 mcpClient 链路（非 mock handler）：
//   1) 免授权 stdio：connectMcpServer 直连本地 mock-mcp-server（fixture）→
//      initialize/initialized/tools/list 真实往返 + tools/call 真实工具调用；
//   2) 免授权 stdio（真实 npm 包）：npx -y @modelcontextprotocol/server-everything
//      （需网络；失败如实记录，不算断言失败——沙箱网络受限时由真实环境复测）；
//   3) 授权类（remote + 401）：错误透传诚实（needsAuth/error 可读），不假成功。
import http from 'node:http';
import path from 'path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const mcp = await import(pathToFileURL(path.join(ROOT, 'main', 'mcpClient.js')).href);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 3) 授权类：本地 401 server（先起，供 remote 用）──
const authServer = http.createServer((req, res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized: missing or invalid API key' }));
});
await new Promise((r) => authServer.listen(0, '127.0.0.1', r));
const authUrl = `http://127.0.0.1:${authServer.address().port}/mcp`;

const results = {};

// 1) 免授权 stdio（fixture）
{
  const fixture = path.join(ROOT, 'test', 'mock-mcp-server.js');
  const r = await mcp.connectMcpServer({
    name: 'verify-fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: {},
  });
  check('免授权 stdio(fixture): 连接成功且发现 2 个工具', r.ok === true && r.toolCount === 2, `toolCount=${r.toolCount}`);
  if (r.ok) {
    const server = mcp.getMcpServer('verify-fixture');
    const call = await mcp.mcpRpc(server, 'tools/call', { name: 'add', arguments: { a: 19, b: 23 } });
    const text = call?.content?.[0]?.text;
    check('免授权 stdio(fixture): tools/call 真实往返（19+23=42）', text === '42', `text=${text}`);
  }
  mcp.disconnectMcpServer('verify-fixture');
}

// 2) 免授权 stdio（真实 npm 包；网络受限时如实记录 skip）
{
  const r = await mcp.connectMcpServer({
    name: 'verify-npm-real',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    env: {},
  });
  if (r.ok) {
    check('免授权 stdio(真实 npm 包): 连接成功并发现工具', r.toolCount > 0, `toolCount=${r.toolCount}`);
    mcp.disconnectMcpServer('verify-npm-real');
  } else {
    console.log(`⏭️  真实 npm 包连接未完成（网络/registry 受限，需真实环境复测）：${String(r.error).slice(0, 120)}`);
  }
}

// 3) 授权类：401 → 诚实错误透传
{
  const r = await mcp.connectMcpServer({
    name: 'verify-auth-401',
    transport: 'http',
    url: authUrl,
    headers: {},
  });
  check('授权类(remote 401): 不假成功，错误诚实透传', r.ok === false && /401|unauthorized/i.test(`${r.error} ${r.stderr || ''}`),
    `error=${String(r.error).slice(0, 80)}`);
  // 带 Authorization 头（假 key 仍 401——server 固定拒）→ 依然诚实失败
  const r2 = await mcp.connectMcpServer({
    name: 'verify-auth-401b',
    transport: 'http',
    url: authUrl,
    headers: { Authorization: 'Bearer fake-key' },
  });
  check('授权类(401+假 key): 同样诚实失败', r2.ok === false);
}

authServer.close();
mcp.killAllMcpServers();

console.log(`\n──── MCP 真实可调用性验证：通过 ${pass} · 失败 ${fail} ────`);
process.exit(fail === 0 ? 0 : 1);
