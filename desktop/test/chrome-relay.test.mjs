// T4-2 门禁：Chrome 接管（main/chromeRelay/ + main/chromeTools.js + chrome-extension/）。
// 用真实 WebSocket 服务 + 假扩展客户端跑全协议，覆盖验收「未授权连接被 fail-closed 拒绝」：
//   拒绝/审批异常 → 连接关闭且不可调用 / 批准后 call 往返 / nonce 校验 /
//   未批准前不激活 / 断开与超时 → chromeNotConnected / 新连接顶替旧连接 /
//   chromeTools 审批闸（click 恒逐次、navigate 规则豁免、截图落盘）/ 审批文案 / 接线静态断言。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const relay = require(path.join(DESKTOP, 'main', 'chromeRelay', 'server.js'));
const { RELAY_METHODS } = require(path.join(DESKTOP, 'main', 'chromeRelay', 'protocol.js'));
const approval = require(path.join(DESKTOP, 'main', 'approval.js'));

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.stack || e.message}`); process.exitCode = 1; }
}

// 可控审批 mock：每次弹卡记录 tool+args，决策由 deferred 外部给定
function makeApproval() {
  const calls = [];
  let next = () => Promise.resolve('once');
  return {
    calls,
    setDecision(fn) { next = fn; },
    requestApproval(tool, args) {
      const p = next(tool, args, calls.length);
      calls.push({ tool, args, promise: p });
      return p;
    },
  };
}

// 假扩展：hello→identify（回显 nonce）；call→按 handler 脚本回执
function connectFakeExtension(port, { handler, skipIdentify = false, badNonce = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const ext = { ws, calls: [] };
    ws.on('open', () => { if (skipIdentify) resolve(ext); });
    ws.on('message', (buf) => {
      const m = JSON.parse(String(buf));
      if (m.t === 'hello') {
        if (skipIdentify) { resolve(ext); return; }
        ws.send(JSON.stringify({
          t: 'identify', extension: 'fake-ext', version: '0.0.1',
          userAgent: 'FakeChrome/1.0', nonce: badNonce ? 'WRONG' : m.nonce,
        }));
        resolve(ext);
      } else if (m.t === 'call') {
        ext.calls.push(m);
        const fn = handler || (() => ({ ok: true }));
        // 异步语义：handler 返回永不 resolve 的 Promise = 扩展「挂死不回执」（超时路径用）
        Promise.resolve().then(() => fn(m)).then((result) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'callRes', callId: m.callId, ok: true, result }));
        }, (e) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'callRes', callId: m.callId, ok: false, error: String(e && e.message || e) }));
        });
      }
    });
    ws.on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitClosed(ws, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (ws.readyState === WebSocket.CLOSED) return;
    await wait(20);
  }
  throw new Error(`连接未在 ${timeoutMs}ms 内关闭`);
}
async function waitConnected(expect = true, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (relay.status().connected === expect) return;
    await wait(20);
  }
  throw new Error(`连接状态未在 ${timeoutMs}ms 内变为 ${expect}`);
}

// ── 1. 中继启动（port=0 由系统分配，测试不占固定端口）──
let ap = makeApproval();
relay.initChromeRelay({ requestApproval: ap.requestApproval, port: 0 });
const port = await relay.start();
await check('中继启动：监听 127.0.0.1 且 status 反映 listening', () => {
  assert.ok(port > 0, `应分配到端口，实际 ${port}`);
  const s = relay.status();
  assert.equal(s.listening, true);
  assert.equal(s.connected, false);
});

// ── 2. fail-closed：审批拒绝 → 连接关闭，call 不可用 ──
ap.setDecision(() => Promise.resolve('deny'));
await check('审批拒绝：连接被断开（4004），call 报 chromeNotConnected', async () => {
  const ext = await connectFakeExtension(port);
  await waitClosed(ext.ws);
  assert.equal(relay.status().connected, false);
  const err = await relay.call('listTabs').then(() => null, (e) => e);
  assert.ok(err && err.chromeNotConnected === true);
});

// ── 3. fail-closed：审批通道异常（reject）按拒绝处理 ──
ap.setDecision(() => Promise.reject(new Error('审批通道故障')));
await check('审批异常：按拒绝处理（fail-closed）', async () => {
  const ext = await connectFakeExtension(port);
  await waitClosed(ext.ws);
  assert.equal(relay.status().connected, false);
});

// ── 4. 未批准前不激活：审批挂起时 call 拒绝 ──
let releaseApproval = null;
ap.setDecision(() => new Promise((r) => { releaseApproval = r; }));
await check('审批挂起期间连接不激活：call 报未连接', async () => {
  const ext = await connectFakeExtension(port);
  await wait(80);
  assert.equal(relay.status().connected, false, '审批未回执前不得 active');
  const err = await relay.call('listTabs').then(() => null, (e) => e);
  assert.ok(err && err.chromeNotConnected === true);
  releaseApproval('once');
  await waitConnected(true);
  assert.equal(relay.status().connected, true, '批准后应转为 active');
  ext.ws.close();
  await waitConnected(false);
});

// ── 5. nonce 校验：错误质询应答直接断连 ──
ap.setDecision(() => Promise.resolve('once'));
await check('identify 回显错误 nonce：连接被关闭（防抢跑/重放）', async () => {
  const ext = await connectFakeExtension(port, { badNonce: true });
  await waitClosed(ext.ws);
  assert.equal(relay.status().connected, false);
});

// ── 6. 批准后 call 往返（真实 WS 全协议）──
await check('批准后 call 往返：listTabs 经假扩展回传结果', async () => {
  const ext = await connectFakeExtension(port, {
    handler: (m) => m.method === 'listTabs' ? { tabs: [{ id: 1, title: 'T', url: 'https://a.com', active: true }] } : { ok: true },
  });
  await waitConnected(true);
  const r = await relay.call('listTabs');
  assert.equal(r.tabs.length, 1);
  assert.equal(r.tabs[0].url, 'https://a.com');
  ext.ws.close();
  await waitConnected(false);
});

// ── 7. 连接断开：挂起 call 立即失败 ──
await check('挂起 call 期间扩展断开：chromeNotConnected 快速失败', async () => {
  const ext = await connectFakeExtension(port, { handler: () => new Promise(() => {}) });
  await waitConnected(true);
  const p = relay.call('extract', {}, 5000);
  await wait(50);
  ext.ws.terminate(); // 模拟扩展进程被杀
  const err = await p.then(() => null, (e) => e);
  assert.ok(err && err.chromeNotConnected === true, `应带 chromeNotConnected，实际 ${err && err.message}`);
});

// ── 8. call 超时：断开连接强制重新授权（不信任失控接管面）──
await check('call 超时：拒绝并重置连接（需重新授权）', async () => {
  const ext = await connectFakeExtension(port, { handler: () => { throw new Error('不应同步返回'); } });
  // 上一个 handler 抛错路径先验证：业务错误原样上抛
  await waitConnected(true);
  const err = await relay.call('listTabs').then(() => null, (e) => e);
  assert.ok(err && err.chromeCallError === true, '扩展业务错误应带 chromeCallError');
  assert.equal(relay.status().connected, true, '业务错误不断连');
  ext.ws.close();
  await waitConnected(false);

  ap.setDecision(() => Promise.resolve('once'));
  const silent = await connectFakeExtension(port, { handler: () => new Promise(() => {}) });
  await waitConnected(true);
  const err2 = await relay.call('screenshot', {}, 150).then(() => null, (e) => e);
  assert.ok(err2 && err2.chromeNotConnected === true, '超时应带 chromeNotConnected');
  await waitConnected(false);
});

// ── 9. 新连接顶替旧连接（扩展重连场景）──
await check('新连接批准后顶替旧 active', async () => {
  ap.setDecision(() => Promise.resolve('once'));
  const a = await connectFakeExtension(port, { handler: () => ({}) });
  await waitConnected(true);
  const b = await connectFakeExtension(port, { handler: () => ({}) });
  await waitConnected(true);
  await wait(50);
  assert.equal(a.ws.readyState, WebSocket.CLOSED, '旧连接应被顶替断开');
  assert.equal(relay.status().connected, true);
  b.ws.close();
  await waitConnected(false);
});

relay.close();

// ── 10-14. chromeTools 审批闸（假中继注入，不依赖真实连接）──
const chromeTools = require(path.join(DESKTOP, 'main', 'chromeTools.js'));
const { initAudit } = require(path.join(DESKTOP, 'main', 'audit', 'auditLog.js'));
initAudit({ getAuthToken: () => '', serverBase: () => 'http://127.0.0.1:0' }); // 无令牌=本地落盘模式

function makeFakeRelay(responses = {}) {
  const calls = [];
  return {
    calls,
    status: () => ({ listening: true, port: 1, connected: true, since: 1, browser: 'FakeChrome' }),
    call(method, args) {
      calls.push({ method, args });
      const r = responses[method];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? { ok: true });
    },
  };
}

function initTools(fakeRelay, decide) {
  const asked = [];
  const alwaysRules = [];
  const conversationRules = [];
  chromeTools.initChromeTools({
    requestApproval: async (tool, args) => { asked.push({ tool, args }); return decide(tool, args); },
    applyApprovalDecision: (d, tool, args, cid) => {
      if (d === 'always') alwaysRules.push({ tool, pattern: approval.approvalTarget(tool, args), scope: 'always' });
    },
    getAlwaysRules: () => alwaysRules,
    conversationRules,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mj-chrome-')),
    relay: fakeRelay,
  });
  return { asked, alwaysRules };
}

await check('chrome_click 恒逐次确认：never 档也弹卡，deny 不触页', async () => {
  const relayFake = makeFakeRelay();
  const { asked } = initTools(relayFake, () => 'deny');
  const r = await chromeTools.toolChromeClick({ selector: '#pay', approvalMode: 'never', conversationId: 'c1' });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.equal(asked.length, 1);
  assert.equal(relayFake.calls.length, 0, '被拒不得触达扩展');
});

await check('chrome_fill 批准后经中继执行；决策不沉淀规则', async () => {
  const relayFake = makeFakeRelay({ fill: { ok: true, selector: '#q', length: 3 } });
  initTools(relayFake, () => 'always'); // 即便用户点「始终允许」也不得沉淀
  const r = await chromeTools.toolChromeFill({ selector: '#q', value: 'abc', approvalMode: 'on-request', conversationId: 'c2' });
  assert.equal(r.ok, true);
  assert.equal(relayFake.calls[0].method, 'fill');
  // 第二次调用仍必须弹卡（规则不生效）
  const asked2 = [];
  chromeTools.initChromeTools({
    requestApproval: async (tool, args) => { asked2.push(tool); return 'once'; },
    applyApprovalDecision: () => {}, getAlwaysRules: () => [], conversationRules: [],
    userDataDir: os.tmpdir(), relay: relayFake,
  });
  await chromeTools.toolChromeFill({ selector: '#q', value: 'x', approvalMode: 'on-request', conversationId: 'c2' });
  assert.equal(asked2.length, 1, 'fill 第二次仍应弹卡');
});

await check('chrome_navigate 走 L3 可规则豁免：同 URL 始终允许后不再弹卡', async () => {
  const relayFake = makeFakeRelay({ navigate: { url: 'https://example.com', title: 'Example' } });
  const st = initTools(relayFake, () => 'always');
  const r = await chromeTools.toolChromeNavigate({ url: 'https://example.com', approvalMode: 'on-request', conversationId: 'c3' });
  assert.equal(r.ok, true);
  assert.equal(st.asked.length, 1, '首次 navigate 应弹卡');
  // 第二次同 URL：命中 always 规则，不弹卡
  const before = st.asked.length;
  await chromeTools.toolChromeNavigate({ url: 'https://example.com', approvalMode: 'on-request', conversationId: 'c3' });
  assert.equal(st.asked.length, before, '规则命中不得再弹卡');
});

await check('chrome_screenshot 落盘+预览句柄字段（审批通过后才触页）', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG 头（内容无关，验证落盘链路）
  const relayFake = makeFakeRelay({ screenshot: { dataBase64: png.toString('base64'), url: 'https://a.com', title: 'A' } });
  const st = initTools(relayFake, () => 'once');
  const r = await chromeTools.toolChromeScreenshot({ approvalMode: 'on-request', conversationId: 'c4' });
  assert.equal(r.ok, true);
  assert.equal(st.asked.length, 1, '截图先弹卡');
  assert.match(r.path, /chrome-shots[\\/]chrome-shot-\d+/);
  assert.ok(fs.existsSync(r.path), '截图文件应落盘');
  assert.equal(typeof r.previewUrl, 'string', 'previewUrl 字段必须存在');
  assert.equal(r.bytes, png.length);
});

await check('未连接错误转结构化失败（notConnected 标记，会话不崩）', async () => {
  const relayFake = makeFakeRelay({ extract: Object.assign(new Error('Chrome 未连接'), { chromeNotConnected: true }) });
  initTools(relayFake, () => 'once');
  const r = await chromeTools.toolChromeExtract({ approvalMode: 'on-request', conversationId: 'c5' });
  assert.equal(r.ok, false);
  assert.equal(r.notConnected, true);
});

await check('chrome_status 只读：不弹卡直接回连接状态', async () => {
  const relayFake = makeFakeRelay();
  const st = initTools(relayFake, () => 'once');
  const r = await chromeTools.toolChromeStatus();
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.equal(st.asked.length, 0, '状态查询不得弹审批卡');
});

// D-14（2026-10-20 产品裁决）：handler 层零弹卡**不等于**退出了审批面——上面那条断言只证明
// 本 handler 自己不 requestApproval，而审批判定发生在更上游的 toolLevel/needsApproval。
// 故此处补审批层断言：特判早返回 null（退出审批面），且豁免连最严档 always 都不动。
await check('审批层：chrome_status 退出审批面（toolLevel → null，always 档也不询问）', () => {
  assert.equal(approval.toolLevel('chrome_status'), null, 'toolLevel 应早返回 null');
  assert.equal(
    approval.needsApproval({ tool: 'chrome_status', args: {}, approvalMode: 'always', alwaysRules: [], conversationRules: [] }).need,
    false, '工具级豁免是绝对的：always 档也不得询问',
  );
});
await check('审批层：chrome_tabs 仍是 L3（D-14 只豁免 chrome_status，未波及页面操作工具）', () => {
  assert.equal(approval.toolLevel('chrome_tabs'), 'L3');
  assert.equal(
    approval.needsApproval({ tool: 'chrome_tabs', args: {}, approvalMode: 'on-request', alwaysRules: [], conversationRules: [] }).need,
    true,
  );
});

// ── 15. 审批文案与分级 ──
await check('审批摘要：chrome_connect 说明接管面；click/fill L3；敏感 URL 警示', () => {
  const s = approval.approvalSummary('chrome_connect', { extension: 'fake', version: '1', userAgent: 'FakeChrome/1.0' });
  assert.equal(s.level, 'L3');
  assert.match(s.detail, /登录态/);
  assert.match(s.detail, /只对当前连接有效/);
  for (const t of ['chrome_tabs', 'chrome_navigate', 'chrome_click', 'chrome_fill', 'chrome_screenshot', 'chrome_extract', 'chrome_connect']) {
    assert.equal(approval.toolLevel(t, {}), 'L3', `${t} 应为 L3`);
  }
  const n = approval.approvalSummary('chrome_navigate', { url: 'https://bank.example/login' });
  assert.match(n.detail, /支付|登录/);
  assert.equal(approval.approvalTarget('chrome_navigate', { url: 'https://a.com/x' }), 'https://a.com/x');
});

// ── 16. 接线静态断言 ──
await check('协议/扩展/主进程/引擎接线完整', () => {
  assert.deepEqual(RELAY_METHODS, ['listTabs', 'navigate', 'click', 'fill', 'screenshot', 'extract']);
  const manifest = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'chrome-extension', 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('debugger') && manifest.permissions.includes('tabs'));
  assert.ok(!manifest.permissions.includes('nativeMessaging'), '不申请超出必要的宽权限');
  const bg = fs.readFileSync(path.join(DESKTOP, 'chrome-extension', 'background.js'), 'utf8');
  assert.match(bg, /chrome\.debugger\.attach/);
  assert.match(bg, /identify/);
  assert.match(bg, /仅允许接管 http\/https/);
  const mainSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'main.js'), 'utf8');
  assert.match(mainSrc, /require\('\.\/chromeRelay\/server'\)/);
  assert.match(mainSrc, /chromeRelay\.start\(\)/);
  assert.match(mainSrc, /chromeStatus: chromeTools\.toolChromeStatus/);
  assert.match(mainSrc, /chromeRelay\/server'\)\.close\(\)/);
  const core = fs.readFileSync(path.join(DESKTOP, 'agent-core', 'index.js'), 'utf8');
  for (const t of ['chrome_status', 'chrome_tabs', 'chrome_navigate', 'chrome_click', 'chrome_fill', 'chrome_screenshot', 'chrome_extract']) {
    assert.ok(core.includes(`name: '${t}'`), `BASE_TOOLS 缺 ${t}`);
  }
  assert.match(core, /chrome_status: 'chromeStatus'/);
  const pkg = fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8');
  assert.match(pkg, /"ws":/);
});

console.log(`\nchrome-relay: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
