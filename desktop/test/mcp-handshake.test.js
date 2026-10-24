// MCP 握手集成测试：stub electron → 加载真实 main.js → 驱动 mcp:connect / mcp:callTool / mcp:listServers / mcp:disconnect
const path = require('path');
const Module = require('module');

// ── electron stub（捕获 ipcMain.handle 注册的处理器）──
const handlers = new Map();
const noop = () => {};
// P0-2 新审批协议：捕获 tool:approval-response 全局监听器；
// FakeBrowserWindow.send 收到 tool:approval-request 后 5ms 回带 approvalId 的「允许一次」
let approvalResponseCb = null;
const ipcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  on: (channel, cb) => { if (channel === 'tool:approval-response') approvalResponseCb = cb; },
  once: noop,
};
function autoRespondApproval(channel, payload) {
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

  // 4. 未连接服务调用应报错
  try {
    await callTool({}, { server: 'ghost', tool: 'x', arguments: {} });
    console.error('FAIL: 未连接服务应抛错'); process.exit(1);
  } catch (e) {
    console.log('[4] 未连接服务正确抛错:', e.message);
  }

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
