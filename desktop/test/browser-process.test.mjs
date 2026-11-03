// T4-1 门禁：Browser Use 子进程化（main/browserProcess/）+ 工具审批层（main/browserTools.js）。
// 覆盖：真实 fork 子进程跑 RPC 协议（probe 通道不启动浏览器，轻量往返）/
//      未知通道业务错误不触发重启 / 幂等通道崩溃后透明重建 /
//      有副作用通道（click）崩溃后绝不自动重试（防重复提交）/
//      启动即死→透明重试超限→browserDegraded / 永不 ready→超时降级 /
//      browserTools 审批闸（click 恒逐次、navigate 规则豁免、deny 不落执行）/
//      审批卡敏感警示 / main.js 与 agent-core 接线静态断言。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHILD_ENTRY = path.join(DESKTOP, 'main', 'browserProcess', 'childEntry.js');
const NO_READY = path.join(DESKTOP, 'test', 'fixtures', 'browser-no-ready.js');
const host = require(path.join(DESKTOP, 'main', 'browserProcess', 'host.js'));
const { BROWSER_CHANNELS, RETRYABLE_CHANNELS } = require(path.join(DESKTOP, 'main', 'browserProcess', 'registry.js'));
const approval = require(path.join(DESKTOP, 'main', 'approval.js'));

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.stack || e.message}`); process.exitCode = 1; }
}

const spawnFork = () => fork(CHILD_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const spawnDieAtOnce = () => { const c = spawnFork(); c.kill('SIGKILL'); return c; };

// ── 0. 纯 Node 宿主（无 utilityProcess）不可用 → browserTools 报能力不可用（降级链前提）──
await check('纯 Node 宿主下 isAvailable()=false（降级链前提）', () => {
  assert.equal(host.isAvailable(), false);
});

// ── 1. probe 往返：真实 fork 子进程加载 playwright-core 并解析浏览器（不启动浏览器）──
host.initBrowserProcess({ spawnChild: spawnFork });
await check('probe 往返：playwright-core 可加载且浏览器解析有结果', async () => {
  const s = host.createSession();
  const r = await s.call('probe', {});
  assert.equal(r.playwright, true, `playwright-core 应可加载：${JSON.stringify(r)}`);
  assert.ok(r.browser || r.error, 'probe 必须回传浏览器解析结果或可行动错误');
  assert.equal(s.isLive(), true);
  s.dispose();
  assert.equal(s.isLive(), false);
});

// ── 2. 未知通道：业务错误原样上抛，不触发重启（子进程仍存活）──
await check('未知通道：browserCallError 不触发重启', async () => {
  const s = host.createSession();
  const err = await s.call('noSuchChannel', {}).then(() => null, (e) => e);
  assert.ok(err && err.browserChildDead !== true, '业务错误不应带 browserChildDead');
  assert.match(err.message, /未知通道/);
  assert.equal(s.isLive(), true, '业务错误后子进程应保持');
  s.dispose();
});

// ── 3. 幂等通道崩溃重启：外部杀进程后下一次调用自动重建（验收「子进程崩溃不影响主会话」）──
await check('子进程被杀后幂等通道（probe）透明重建并成功', async () => {
  let childRef = null;
  host.initBrowserProcess({ spawnChild: () => { childRef = spawnFork(); return childRef; } });
  const s = host.createSession();
  await s.call('probe', {});
  const pid1 = childRef.pid;
  childRef.kill('SIGKILL'); // 模拟浏览器子进程崩溃
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.isLive(), false, 'exit 后应标记为非活跃');
  const r2 = await s.call('probe', {}); // 透明重建
  assert.equal(r2.playwright, true);
  assert.notEqual(childRef.pid, pid1, '应已重建新进程');
  s.dispose();
});

// ── 4. 有副作用通道（click）崩溃后绝不自动重试：报错文案含「切勿盲目重试」防重复提交 ──
await check('click 崩溃路径不透明重试：抛会话中断错误（防重复提交）', async () => {
  host.initBrowserProcess({ spawnChild: spawnDieAtOnce, callTimeoutMs: 2000 });
  const s = host.createSession();
  const err = await s.call('click', { selector: '#submit' }).then(() => null, (e) => e);
  assert.ok(err && err.browserChildDead === true, `应带 browserChildDead，实际：${err && err.message}`);
  assert.ok(!err.browserDegraded, '单次失败不应直接标降级（下次调用可重建）');
  assert.match(err.message, /切勿盲目重试/);
  s.dispose();
});

// ── 5. 幂等通道启动即死：透明重试超限 → browserDegraded（能力降级提示路径）──
await check('子进程启动即死：幂等通道重试超限抛 browserDegraded', async () => {
  host.initBrowserProcess({ spawnChild: spawnDieAtOnce, callTimeoutMs: 2000 });
  const s = host.createSession();
  const err = await s.call('probe', {}).then(() => null, (e) => e);
  assert.ok(err && err.browserDegraded === true, `应带 browserDegraded，实际：${err && err.message}`);
  s.dispose();
});

// ── 6. ready 超时：子进程挂死在初始化 → 超时杀进程重建 → 超限降级 ──
await check('永不 ready 的子进程：ready 超时触发降级', async () => {
  host.initBrowserProcess({
    spawnChild: () => fork(NO_READY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }),
    callTimeoutMs: 300,
  });
  const s = host.createSession();
  const err = await s.call('probe', {}).then(() => null, (e) => e);
  assert.ok(err && err.browserDegraded === true, `应带 browserDegraded，实际：${err && err.message}`);
  s.dispose();
  host.initBrowserProcess({ spawnChild: spawnFork });
});

// ── 7. browserTools 审批闸（假会话注入，脱离真实子进程）──
// 审计模块依赖 main.js 启动接线；测试环境以「无令牌本地模式」初始化（落盘失败仅告警不阻塞）
require(path.join(DESKTOP, 'main', 'audit', 'auditLog.js')).initAudit({ getAuthToken: () => '', serverBase: () => 'http://127.0.0.1:0' });

function makeFakeSession(calls, failWith) {
  return {
    call: async (name, args) => {
      if (failWith) throw failWith;
      calls.push({ name, args });
      if (name === 'probe') return { playwright: true, browser: 'fake' };
      if (name === 'navigate') return { url: args.url, title: 'fake 页面' };
      if (name === 'screenshot') return { path: args.outPath, bytes: 1234 };
      return { ok: true, url: 'https://fake.test/', title: 't' };
    },
    dispose() {}, isLive: () => true,
  };
}

function initTools({ approvals, decision = 'approve', alwaysRules = [], calls = [], failWith } = {}) {
  const browserTools = require(path.join(DESKTOP, 'main', 'browserTools.js'));
  browserTools.disposeAll();
  browserTools.initBrowserTools({
    requestApproval: async (tool, args) => { approvals.push({ tool, args }); return decision; },
    applyApprovalDecision: () => {},
    getAlwaysRules: () => alwaysRules,
    conversationRules: [],
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mj-browser-test-')),
    createSession: () => makeFakeSession(calls, failWith),
  });
  return browserTools;
}

await check('click 恒逐次确认：never 档也弹卡，deny 不落执行', async () => {
  const approvals = []; const calls = [];
  const bt = initTools({ approvals, decision: 'deny', calls });
  const r = await bt.toolBrowserClick({ selector: '#pay', approvalMode: 'never', conversationId: 'c1' });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.equal(approvals.length, 1, 'click 必须弹审批（approvalMode=never 也不可静默放行）');
  assert.equal(approvals[0].tool, 'browser_click');
  assert.equal(calls.length, 0, '拒绝后不得触页执行');
});

await check('click 批准后经子进程会话执行', async () => {
  const approvals = []; const calls = [];
  const bt = initTools({ approvals, decision: 'approve', calls });
  const r = await bt.toolBrowserClick({ selector: '#ok', approvalMode: 'never', conversationId: 'c2' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'click');
});

await check('navigate 走 L3 可规则豁免：同 URL 始终允许后不再弹卡', async () => {
  const approvals = []; const calls = [];
  const url = 'https://example.com/form';
  const bt = initTools({
    approvals, calls,
    alwaysRules: [{ tool: 'browser_navigate', pattern: url, scope: 'always' }],
  });
  const r = await bt.toolBrowserNavigate({ url, approvalMode: 'on-request', conversationId: 'c3' });
  assert.equal(r.ok, true);
  assert.equal(approvals.length, 0, '规则命中的 navigate 不应弹卡');
  assert.equal(calls[0].args.waitUntil, undefined);
});

await check('navigate 未命中规则时弹 L3 审批', async () => {
  const approvals = []; const calls = [];
  const bt = initTools({ approvals, calls, decision: 'approve' });
  const r = await bt.toolBrowserNavigate({ url: 'https://other.test/', wait_until: 'networkidle', approvalMode: 'on-request', conversationId: 'c4' });
  assert.equal(r.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(calls[0].args.waitUntil, 'networkidle', 'snake_case 参数应映射为子进程 camelCase');
});

await check('screenshot 落盘路径+预览句柄回传（审批通过后才触页）', async () => {
  const approvals = []; const calls = [];
  const bt = initTools({ approvals, calls, decision: 'approve' });
  const r = await bt.toolBrowserScreenshot({ full_page: true, approvalMode: 'on-request', conversationId: 'c5' });
  assert.equal(r.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(calls[0].name, 'screenshot');
  assert.equal(calls[0].args.fullPage, true);
  assert.match(calls[0].args.outPath, /browser-shots[\\/]shot-\d+/, '截图应落 userData/browser-shots');
  assert.ok('previewUrl' in r, '回传形状必须含 previewUrl 字段（渲染层轨迹卡消费）');
});

await check('子进程降级错误转结构化失败（degraded 标记，主会话不崩）', async () => {
  const approvals = [];
  const bt = initTools({ approvals, calls: [], failWith: Object.assign(new Error('降级'), { browserDegraded: true }) });
  const r = await bt.toolBrowserExtract({ approvalMode: 'never', conversationId: 'c6' });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
});

// ── 8. 审批卡文案：敏感词警示 + 六通道 L3 ──
await check('审批摘要：click 命中支付/登录类词加警示行，六通道均 L3', () => {
  const s1 = approval.approvalSummary('browser_click', { selector: '#pay-btn' });
  assert.equal(s1.level, 'L3');
  assert.match(s1.detail, /支付\/登录\/发送类真实副作用/);
  const s2 = approval.approvalSummary('browser_navigate', { url: 'https://example.com/cart' });
  assert.match(s2.detail, /将要访问/);
  assert.ok(!/真实副作用/.test(s2.detail), '普通 URL 不应误加警示');
  for (const tool of ['browser_navigate', 'browser_click', 'browser_fill', 'browser_select', 'browser_screenshot', 'browser_extract']) {
    assert.equal(approval.toolLevel(tool, {}), 'L3', `${tool} 应为 L3`);
  }
});

// ── 9. registry 完整 + 接线静态断言 ──
await check('通道登记表与主进程/引擎接线完整', () => {
  assert.deepEqual(BROWSER_CHANNELS, ['probe', 'navigate', 'click', 'fill', 'select', 'screenshot', 'extract']);
  assert.deepEqual([...RETRYABLE_CHANNELS].sort(), ['extract', 'navigate', 'probe', 'screenshot']);
  const mainSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'main.js'), 'utf8');
  assert.match(mainSrc, /require\('\.\/browserTools'\)/);
  assert.match(mainSrc, /browserTools\.initBrowserTools\(\{/);
  assert.match(mainSrc, /browserNavigate: browserTools\.toolBrowserNavigate/);
  assert.match(mainSrc, /browserExtract: browserTools\.toolBrowserExtract/);
  assert.match(mainSrc, /browserTools'\)\.disposeAll\(\)/);
  const coreSrc = [fs.readFileSync(path.join(DESKTOP, 'agent-core', 'index.js'), 'utf8'), fs.readFileSync(path.join(DESKTOP, 'agent-core', 'index.js').replace('index.js', 'toolNames.js'), 'utf8')].join('\n'); // 2026-11-03：TOOL_HANDLER_NAMES 已外置到 toolNames.js，两条路径一起读
  for (const n of ['browser_navigate', 'browser_click', 'browser_fill', 'browser_select', 'browser_screenshot', 'browser_extract']) {
    assert.ok(coreSrc.includes(`name: '${n}'`), `agent-core 缺工具定义 ${n}`);
  }
  assert.match(coreSrc, /browser_navigate: 'browserNavigate'/);
  assert.match(coreSrc, /browser_extract: 'browserExtract'/);
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  // 测试基线纳入断言（2026-10-15 起为发现式 runner）：test 脚本指向 run-all.mjs，
  // 由它自动发现 test/*.test.{js,mjs}（本套件无需字面注册），故改断言「被发现」而非「被点名」。
  assert.ok(/run-all\.mjs/.test(pkg.scripts.test), `test 脚本应指向发现式 runner，实际 ${pkg.scripts.test}`);
  assert.ok(fs.existsSync(path.join(DESKTOP, 'test', 'browser-process.test.mjs')), '本套件须位于 test/ 以被 run-all 自动发现');
  assert.ok(pkg.dependencies['playwright-core'], 'playwright-core 必须入依赖');
});

console.log(`\nbrowser-process: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
