// MCP 握手集成测试：stub electron → 加载真实 main.js → 驱动 mcp:connect / mcp:callTool / mcp:listServers / mcp:disconnect
const path = require('path');
const Module = require('module');

// ── electron stub（捕获 ipcMain.handle 注册的处理器）──
const handlers = new Map();
const noop = () => {};
// P0-2 新审批协议：捕获 tool:approval-response 全局监听器；
// FakeBrowserWindow.send 收到 tool:approval-request 后 5ms 回带 approvalId 的「允许一次」
let approvalResponseCb = null;
// P3-1：捕获主进程推给渲染层的事件（当前只有 mcp:progress 用它）
const sentEvents = [];
const ipcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  on: (channel, cb) => { if (channel === 'tool:approval-response') approvalResponseCb = cb; },
  once: noop,
};
function autoRespondApproval(channel, payload) {
  sentEvents.push({ channel, payload });
  if (channel === 'tool:approval-request' && approvalResponseCb) {
    setTimeout(() => approvalResponseCb({}, { approvalId: payload?.approvalId, decision: 'once' }), 5);
  }
}
class FakeBrowserWindow {
  constructor() {
    this.webContents = { setWindowOpenHandler: noop, openDevTools: noop, send: autoRespondApproval, on: noop };
  }
  loadURL() {} loadFile() {} on() {} once() {} show() {}
  isMinimized() { return false; } restore() {} focus() {}
  getBounds() { return { width: 1600, height: 1000 }; }
}
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: noop,
    requestSingleInstanceLock: () => true,
    getPath: () => '/tmp/mjcode-test',
    isPackaged: false,
    quit: noop,
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain,
  shell: { openExternal: noop },
};

// 注入 require 缓存，使 main.js 的 require('electron') 拿到 stub
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[electronPath] = stubModule;

// ── 加载被测主进程（会注册全部 IPC 处理器）──
require('../main/main.js');

// P3-1 反向门禁：进度桥不得制造「未捕获拒绝」。
// 真实事故：收尾写成 `.finally(bridge.done)` 时，一次**失败**的工具调用会多派生一个无人 await 的
// 拒绝；本套件单独跑是绿的，只有 `npm test` 注入 test/helpers/unhandled-preload.cjs 才判死整个套件。
// 所以在套件内自带一条等价判据：谁再把它写回 finally，这里就红（不依赖跑法的差异）。
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String((e && e.message) || e)));

const mockServer = path.join(__dirname, 'mock-mcp-server.js');

(async () => {
  // 1. 连接：三步握手（initialize → initialized → tools/list）
  const connect = handlers.get('mcp:connect');
  const r = await connect({}, { name: 'mock', command: process.execPath, args: [mockServer] });
  console.log('[1] connect:', JSON.stringify({ ok: r.ok, toolCount: r.toolCount }));
  if (!r.ok) { console.error('FAIL: 连接失败', r.error, r.stderr || ''); process.exit(1); }
  if (r.toolCount !== 2) { console.error(`FAIL: 工具数应为 2，实际 ${r.toolCount}`); process.exit(1); }
  if (!r.tools || r.tools[0].name !== 'echo') { console.error('FAIL: 工具内容不正确'); process.exit(1); }

  // 2. 重复连接应命中缓存
  const r2 = await connect({}, { name: 'mock', command: process.execPath, args: [mockServer] });
  if (!r2.cached || r2.toolCount !== 2) { console.error('FAIL: 缓存连接异常'); process.exit(1); }
  console.log('[2] 重复连接命中缓存:', r2.cached);

  // 3. 工具调用往返
  const callTool = handlers.get('mcp:callTool');
  const cr = await callTool({}, { server: 'mock', tool: 'echo', arguments: { text: 'hello-mcp' } });
  const text = cr?.content?.[0]?.text;
  console.log('[3] callTool echo:', text);
  if (text !== 'echo: hello-mcp') { console.error('FAIL: 工具调用结果不符'); process.exit(1); }
  const cr2 = await callTool({}, { server: 'mock', tool: 'add', arguments: { a: 2, b: 40 } });
  if (cr2?.content?.[0]?.text !== '42') { console.error('FAIL: add 调用不符'); process.exit(1); }
  console.log('[3] callTool add: 42');

  // 3b. P3-1 进度：经 IPC（有发起方窗口）调用 → 服务端按令牌回报 2 条进度 + 一条收尾
  // 为什么必须传 { sender }：进度事件只推回发起方窗口，不广播；这正是被测接线本身。
  const progressEvents = [];
  const sender = { send: (ch, d) => progressEvents.push({ ch, d }) };
  const pr = await callTool({ sender }, { server: 'mock', tool: 'add', arguments: { a: 20, b: 22 } });
  if (pr?.content?.[0]?.text !== '42') { console.error('FAIL: 带进度的调用结果不符'); process.exit(1); }
  const updates = progressEvents.filter((e) => e.ch === 'mcp:progress' && e.d?.phase === 'update');
  const ends = progressEvents.filter((e) => e.ch === 'mcp:progress' && e.d?.phase === 'end');
  if (updates.length !== 2) { console.error(`FAIL: 进度条数应为 2，实际 ${updates.length}（${JSON.stringify(progressEvents)}）`); process.exit(1); }
  if (updates[0].d.progress !== 1 || updates[1].d.progress !== 2 || updates[1].d.total !== 2) {
    console.error(`FAIL: 进度值不符 ${JSON.stringify(updates.map((u) => u.d))}`); process.exit(1);
  }
  if (updates[0].d.server !== 'mock' || updates[0].d.tool !== 'add') { console.error('FAIL: 进度事件缺 server/tool 归属'); process.exit(1); }
  if (ends.length !== 1) { console.error(`FAIL: 收尾事件应为 1 条，实际 ${ends.length}`); process.exit(1); }
  // 调用出口必须把登记摘掉：长跑进程里每调一次积一条，且旧回调会把后续进度送到已结束的调用上
  const mockSrv0 = require('../main/mcpClient.js').getMcpServer('mock');
  if (mockSrv0?.progressListeners && mockSrv0.progressListeners.size > 0) {
    console.error(`FAIL: 调用结束后仍残留 ${mockSrv0.progressListeners.size} 条进度登记（出口未摘除）`); process.exit(1);
  }
  console.log('[3b] P3-1 进度：2 条 update + 1 条 end 已推回发起方窗口');

  // 3c. P3-1 反向：**不发 progressToken** ⇒ 服务端一条进度都不发（规范的条件行为）
  // 用 lastProgress 作为可观测证据：它只在真的收到 notifications/progress 时才被写。
  const mcp = require('../main/mcpClient.js');
  const srv = mcp.getMcpServer('mock');
  if (!srv) { console.error('FAIL: 取不到 server 对象'); process.exit(1); }
  srv.lastProgress = null;
  const noTok = await mcp.mcpRpc(srv, 'tools/call', { name: 'add', arguments: { a: 1, b: 2 } });
  if (noTok?.content?.[0]?.text !== '3') { console.error('FAIL: 无令牌调用结果不符'); process.exit(1); }
  if (srv.lastProgress !== null) { console.error(`FAIL: 未发令牌却收到进度 ${JSON.stringify(srv.lastProgress)}`); process.exit(1); }
  console.log('[3c] P3-1 反向：不带 progressToken 时服务端不发进度（lastProgress 未被写）');

  // 3d. P3-1 路由 + 摘除：同一连接上按 token 精确投递，调用出口必须摘掉登记
  const got = [];
  const tok = 'test-token-1';
  mcp.registerProgress(srv, tok, (p) => got.push(p));
  const withTok = await mcp.mcpRpc(srv, 'tools/call', { name: 'add', arguments: { a: 3, b: 4 }, _meta: { progressToken: tok } });
  if (withTok?.content?.[0]?.text !== '7') { console.error('FAIL: 带令牌调用结果不符'); process.exit(1); }
  if (got.length !== 2) { console.error(`FAIL: 路由到回调的进度应为 2 条，实际 ${got.length}`); process.exit(1); }
  if (got[1].progress !== 2 || !srv.lastProgress || srv.lastProgress.token !== tok) { console.error('FAIL: 路由内容不符'); process.exit(1); }
  mcp.dropProgressListener(srv, tok);
  if (srv.progressListeners && srv.progressListeners.has(tok)) { console.error('FAIL: 登记未被摘除（长跑会积泄漏）'); process.exit(1); }
  // 摘除后同一 token 再来进度不应再触达旧回调
  const before = got.length;
  await mcp.mcpRpc(srv, 'tools/call', { name: 'add', arguments: { a: 5, b: 6 }, _meta: { progressToken: tok } });
  if (got.length !== before) { console.error('FAIL: 摘除后旧回调仍被调用'); process.exit(1); }
  console.log('[3d] P3-1 路由/摘除：按 token 精确投递，摘除后不再触达旧回调');

  // 4. 未连接服务调用应报错
  try {
    await callTool({}, { server: 'ghost', tool: 'x', arguments: {} });
    console.error('FAIL: 未连接服务应抛错'); process.exit(1);
  } catch (e) {
    console.log('[4] 未连接服务正确抛错:', e.message);
  }
  // 4b. 上一步是「一次失败的工具调用」——它必须只把拒绝交给调用方，不许在进程里多派生一条。
  // 等一轮宏任务，让漏网的派生拒绝有机会被 unhandledRejection 捕获。
  await new Promise((r) => setTimeout(r, 30));
  if (unhandled.length) {
    console.error(`FAIL: 失败的工具调用产生了 ${unhandled.length} 条未捕获拒绝：${unhandled.join(' | ')}`);
    process.exit(1);
  }
  console.log('[4b] 失败调用不产生未捕获拒绝（进度桥收尾无副作用）');

  // 5. listServers / disconnect
  const list = handlers.get('mcp:listServers');
  const servers = await list({});
  console.log('[5] listServers:', JSON.stringify(servers));
  if (servers.length !== 1 || servers[0].toolCount !== 2) { console.error('FAIL: 列表异常'); process.exit(1); }
  await handlers.get('mcp:disconnect')({}, { name: 'mock' });
  const after = await list({});
  if (after.length !== 0) { console.error('FAIL: 断开后仍残留'); process.exit(1); }
  console.log('[6] 断开后列表为空');

  console.log('PASS: MCP 三步握手 / 工具调用 / 缓存 / 错误路径 / 列表 / 断开 全部通过');
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
