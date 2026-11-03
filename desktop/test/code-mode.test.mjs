// T4-7 门禁：Code Mode（main/codeProcess/ + main/codeTools.js）——真实 fork 子进程跑 RPC 协议。
// 覆盖：exec 往返 / cell 语义（跨 call 状态保持——验收核心）/ console 捕获 / saveImage 落盘 /
//      代码错误回传部分 stdout / vm 超时不杀进程（状态仍在）/ reset 清状态 /
//      子进程被杀→codeDegraded 且不透明重启（状态丢失必须如实透出）/
//      codeTools 审批编排（fake 会话）/ approval L1/L3 双档 / 接线静态断言。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fork } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHILD_ENTRY = path.join(DESKTOP, 'main', 'codeProcess', 'childEntry.js');
const host = require(path.join(DESKTOP, 'main', 'codeProcess', 'host.js'));
const { CODE_CHANNELS } = require(path.join(DESKTOP, 'main', 'codeProcess', 'registry.js'));
const approval = require(path.join(DESKTOP, 'main', 'approval.js'));
const codeTools = require(path.join(DESKTOP, 'main', 'codeTools.js'));
// 审计在测试环境走「无令牌=本地落盘」模式（同 browser-process/chrome-relay 先例；
// 纯 Node 下 electron app 不可用，auditLocal 落盘失败仅 console.warn，不阻塞断言）
require(path.join(DESKTOP, 'main', 'audit', 'auditLog.js')).initAudit({ getAuthToken: () => '', serverBase: () => 'http://127.0.0.1:0' });

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.stack || e.message}`); process.exitCode = 1; }
}

const spawnFork = () => fork(CHILD_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-test-'));
// 1x1 透明 PNG（saveImage 落盘断言用）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── 0. 纯 Node 宿主（无 utilityProcess）不可用（降级链前提）──
await check('纯 Node 宿主下 isAvailable()=false', () => {
  assert.equal(host.isAvailable(), false);
});

// ── 1. exec 往返：表达式返回值序列化 ──
host.initCodeProcess({ spawnChild: spawnFork });
await check('exec 往返：1+1 返回 "2"', async () => {
  const s = host.createSession();
  const r = await s.call('exec', { code: '1+1', outDir });
  assert.equal(r.ok, true);
  assert.equal(r.result, '2');
  assert.equal(s.isLive(), true);
  s.dispose();
  assert.equal(s.isLive(), false);
});

// ── 2. cell 语义（验收核心）：跨 call 状态保持 ──
await check('cell 语义：上一调用的变量下一调用可用', async () => {
  const s = host.createSession();
  const r1 = await s.call('exec', { code: 'var data = [3, 1, 2]; data.sort();', outDir });
  assert.equal(r1.ok, true);
  const r2 = await s.call('exec', { code: 'JSON.stringify(data)', outDir });
  assert.equal(r2.ok, true);
  assert.equal(r2.result, '[1,2,3]');
  // let/const 顶层声明同样跨调用保留（vm global 词法环境）
  await s.call('exec', { code: 'const K = 42;', outDir });
  const r3 = await s.call('exec', { code: 'K', outDir });
  assert.equal(r3.result, '42');
  s.dispose();
});

// ── 3. console 捕获 + display 辅助 ──
await check('console.log/display 输出进 stdout', async () => {
  const s = host.createSession();
  const r = await s.call('exec', { code: 'console.log("hi", {a:1}); display({b:2}); 7', outDir });
  assert.equal(r.result, '7');
  assert.match(r.stdout, /hi \{"a":1\}/);
  assert.match(r.stdout, /"b": 2/);
  // stdout 每次 exec 重置（cell 输出语义：只见本次）
  const r2 = await s.call('exec', { code: '1', outDir });
  assert.equal(r2.stdout, '');
  s.dispose();
});

// ── 4. saveImage 落盘（图片字节不过 IPC）──
await check('saveImage：PNG 落盘 outDir 并回文件条目', async () => {
  const s = host.createSession();
  const r = await s.call('exec', { code: `saveImage('chart', '${PNG_B64}')`, outDir });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.images.length, 1);
  const im = r.images[0];
  assert.equal(im.name, 'chart.png'); // 无扩展名自动补 .png
  assert.ok(fs.existsSync(im.file));
  assert.equal(im.bytes, Buffer.from(PNG_B64, 'base64').length);
  assert.match(im.file, /^\/.*code-mode-test|mjcode-test/, '必须落在 outDir');
  s.dispose();
});

// ── 5. 代码错误：ok=false 但部分 stdout 仍回传（调试信息对模型有用）──
await check('代码抛错：ok=false + error + 已产生的 stdout', async () => {
  const s = host.createSession();
  const r = await s.call('exec', { code: 'console.log("before"); throw new Error("boom")', outDir });
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
  assert.match(r.stdout, /before/);
  s.dispose();
});

// ── 6. vm 超时：同步死循环被 vm 掐停，进程不死、状态仍在（区别于宿主超时）──
await check('vm 超时：掐停死循环但会话存活', async () => {
  const s = host.createSession();
  await s.call('exec', { code: 'var alive = 1;', outDir });
  const r = await s.call('exec', { code: 'while(true){}', timeoutMs: 300, outDir });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout|timed out/i);
  assert.equal(s.isLive(), true, 'vm 超时不应杀子进程');
  const r2 = await s.call('exec', { code: 'alive', outDir });
  assert.equal(r2.result, '1', '超时后状态应仍在');
  s.dispose();
});

// ── 7. reset：显式清状态 ──
await check('reset 后旧变量不可见', async () => {
  const s = host.createSession();
  await s.call('exec', { code: 'var gone = 1;', outDir });
  await s.call('reset');
  const r = await s.call('exec', { code: 'gone', outDir });
  assert.equal(r.ok, false);
  assert.match(r.error, /gone is not defined/);
  s.dispose();
});

// ── 8. 降级链（验收关键）：子进程被杀 → codeDegraded，绝不透明重建 ──
await check('子进程被杀：codeDegraded 且后续调用持续拒绝（状态丢失如实透出）', async () => {
  let childRef = null;
  host.initCodeProcess({ spawnChild: () => { childRef = spawnFork(); return childRef; } });
  const s = host.createSession();
  await s.call('exec', { code: 'var x = 1;', outDir });
  childRef.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.isLive(), false);
  assert.equal(s.isDead(), true);
  const err = await s.call('exec', { code: '2', outDir }).then(() => null, (e) => e);
  assert.ok(err && err.codeDegraded === true, `应带 codeDegraded，实际：${err && err.message}`);
  // 降级后不得悄悄 spawn 新会话冒充旧状态
  const err2 = await s.call('exec', { code: '3', outDir }).then(() => null, (e) => e);
  assert.ok(err2 && err2.codeDegraded === true);
  s.dispose();
  host.initCodeProcess({ spawnChild: spawnFork });
});

// ── 9. registry 通道完整 ──
await check('registry 通道表', () => {
  assert.deepEqual(CODE_CHANNELS, ['exec', 'reset', 'probe']);
});

// ── 10. codeTools 编排（fake 会话脱离真实子进程）──
function fakeSession(result) {
  const calls = [];
  return {
    calls,
    call: async (name, args) => { calls.push({ name, args }); return result; },
    dispose() {}, isLive: () => true, isDead: () => false,
  };
}
const baseDeps = (over = {}) => ({
  requestApproval: async () => 'once',
  applyApprovalDecision() {},
  getAlwaysRules: () => [],
  conversationRules: [],
  userDataDir: outDir,
  ...over,
});

await check('codeTools：审批拒绝 → denied 且不调用会话', async () => {
  codeTools.initCodeTools(baseDeps({
    createSession: () => fakeSession({ ok: true, stdout: '', result: '', images: [], elapsedMs: 1 }),
    requestApproval: async () => 'deny',
  }));
  const r = await codeTools.toolCodeExec({ code: '1+1', approvalMode: 'on-request', conversationId: 't-deny' });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.equal(codeTools._sessions().get('fake:t-deny'), undefined, '未建会话');
});

await check('codeTools：L3 规则豁免（始终允许）→ 不弹卡直接执行', async () => {
  let asked = 0;
  const sess = fakeSession({ ok: true, stdout: 'out', result: '42', images: [{ name: 'a.png', file: path.join(outDir, 'a.png'), bytes: 3 }], elapsedMs: 2 });
  codeTools.initCodeTools(baseDeps({
    createSession: () => sess,
    requestApproval: async () => { asked++; return 'once'; },
    getAlwaysRules: () => [{ tool: 'code_exec', pattern: '6*7', scope: 'always' }],
  }));
  const r = await codeTools.toolCodeExec({ code: '6*7', approvalMode: 'on-request', conversationId: 't-rule' });
  assert.equal(r.ok, true);
  assert.equal(r.result, '42');
  assert.equal(asked, 0, '规则豁免不应弹卡');
  assert.equal(r.images.length, 1);
  assert.match(r.images[0].previewUrl, /^mjpreview:\/\/p\//, '预览句柄走 mjpreview://（T3-1 协议）');
  assert.equal(sess.calls[0].name, 'exec');
  assert.equal(sess.calls[0].args.outDir, path.join(outDir, 'code-mode'));
});

await check('codeTools：危险代码即使有「始终允许」规则仍恒弹卡（L1 不可豁免）', async () => {
  let asked = 0;
  codeTools.initCodeTools(baseDeps({
    createSession: () => fakeSession({ ok: true, stdout: '', result: '', images: [], elapsedMs: 1 }),
    requestApproval: async () => { asked++; return 'deny'; },
    getAlwaysRules: () => [{ tool: 'code_exec', pattern: "require('child_process').execSync('ls')", scope: 'always' }],
  }));
  const r = await codeTools.toolCodeExec({ code: "require('child_process').execSync('ls')", approvalMode: 'on-request', conversationId: 't-danger' });
  assert.equal(asked, 1, '危险代码必须逐次弹卡');
  assert.equal(r.denied, true);
});

await check('codeTools：会话降级 → degraded 标记 + 死会话摘除', async () => {
  const dead = { call: async () => { throw Object.assign(new Error('gone'), { codeDegraded: true }); }, dispose() {}, isLive: () => false, isDead: () => true };
  codeTools.initCodeTools(baseDeps({ createSession: () => dead }));
  const r = await codeTools.toolCodeExec({ code: '1', approvalMode: 'never', conversationId: 't-dead' });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(codeTools._sessions().has('fake:t-dead'), false, '死会话应被摘除');
});

await check('codeTools：restart 参数 → 丢弃旧会话再执行', async () => {
  let created = 0;
  const mk = () => { created++; return fakeSession({ ok: true, stdout: '', result: String(created), images: [], elapsedMs: 1 }); };
  codeTools.initCodeTools(baseDeps({ createSession: mk }));
  await codeTools.toolCodeExec({ code: '1', approvalMode: 'never', conversationId: 't-restart' });
  assert.equal(created, 1);
  const r = await codeTools.toolCodeExec({ code: '2', restart: true, approvalMode: 'never', conversationId: 't-restart' });
  assert.equal(created, 2, 'restart 应新建会话');
  assert.equal(r.result, '2');
});

await check('codeTools：code 为空直接拒绝（不出审批）', async () => {
  codeTools.initCodeTools(baseDeps({ createSession: () => fakeSession({ ok: true, stdout: '', result: '', images: [], elapsedMs: 1 }) }));
  const r = await codeTools.toolCodeExec({ code: '   ', approvalMode: 'never', conversationId: 't-empty' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不能为空/);
});

// ── 11. approval 双档判定 ──
await check('approval：普通代码 L3 可豁免 / 危险代码 L1 不可豁免', () => {
  assert.equal(approval.toolLevel('code_exec', { code: '1+1' }), 'L3');
  assert.equal(approval.toolLevel('code_exec', { code: "require('child_process')" }), 'L1');
  assert.equal(approval.toolLevel('code_exec', { code: 'execSync("ls")' }), 'L1');
  assert.equal(approval.toolLevel('code_exec', { code: 'rm -rf / 字样' }), 'L1');
  const rules = [{ tool: 'code_exec', pattern: '1+1', scope: 'always' }];
  const safe = approval.needsApproval({ tool: 'code_exec', args: { code: '1+1' }, approvalMode: 'on-request', alwaysRules: rules });
  assert.equal(safe.need, false, 'L3 普通代码应被规则豁免');
  const danger = approval.needsApproval({ tool: 'code_exec', args: { code: 'execSync("x")' }, approvalMode: 'on-request', alwaysRules: rules });
  assert.equal(danger.need, true, 'L1 危险代码不可豁免');
  const summary = approval.approvalSummary('code_exec', { code: '1+1' });
  assert.match(summary.title, /Code Mode/);
  assert.match(summary.detail, /1\+1/, '代码文本必须进审批卡摘要');
});

// ── 12. 接线静态断言（agent-core 三表 / main.js / ToolTrace / i18n）──
await check('agent-core：BASE_TOOLS schema + 映射表 + 审批透传', () => {
  const src = [fs.readFileSync(path.join(DESKTOP, 'agent-core', 'index.js'), 'utf8'), fs.readFileSync(path.join(DESKTOP, 'agent-core', 'index.js').replace('index.js', 'toolNames.js'), 'utf8')].join('\n'); // 2026-11-03：TOOL_HANDLER_NAMES 已外置到 toolNames.js，两条路径一起读
  assert.match(src, /name: 'code_exec'/);
  assert.match(src, /code_exec: 'codeExec'/);
  // 期 3：APPROVAL_TOOLS 末尾追加了 5 个原生工具，'code_exec' 后不再是数组收尾
  assert.match(src, /'code_exec',/);
});

await check('main.js：initCodeTools 接线 + createToolHandlers 注入', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main', 'main.js'), 'utf8');
  assert.match(src, /require\('\.\/codeTools'\)/);
  assert.match(src, /codeTools\.initCodeTools\(\{/);
  assert.match(src, /codeExec: codeTools\.toolCodeExec,/);
});

await check('ToolTrace：卡片渲染四扩展点 + i18n 双语键', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'renderer', 'src', 'components', 'tools', 'ToolTrace.tsx'), 'utf8');
  assert.match(src, /code_exec: 'toolTrace\.codeExec'/);
  assert.match(src, /case 'code_exec'/);
  assert.match(src, /'code_exec',\s*'deep_research'\]\.includes\(name\)/);
  for (const loc of ['zh-CN', 'en-US']) {
    const dict = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer', 'src', 'i18n', 'locales', loc, 'toolTrace.json'), 'utf8'));
    assert.ok(dict.codeExec && dict.codeEmpty && dict.codeImage, `${loc} 缺 code* 键`);
  }
});

// 清理临时目录（尽力而为）
try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 留给系统回收 */ }

console.log(`\ncode-mode: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
