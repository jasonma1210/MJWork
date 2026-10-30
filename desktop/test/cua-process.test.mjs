// T3-6 门禁：Computer Use 原生执行子进程化（main/cuaProcess/）——真实 fork 子进程跑 RPC 协议。
// 覆盖：完整 call 往返（真实 osascript 探针）/ 未知通道业务错误不触发重启 /
//      子进程退出后下次调用自动重建（崩溃重启策略）/ 启动即死→透明重试超限→cuaDegraded /
//      永不 ready→ready 超时→降级 / main.js 接线静态断言。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHILD_ENTRY = path.join(DESKTOP, 'main', 'cuaProcess', 'childEntry.js');
const NO_READY = path.join(DESKTOP, 'test', 'fixtures', 'cua-no-ready.js');
const host = require(path.join(DESKTOP, 'main', 'cuaProcess', 'host.js'));
const { CUA_CHANNELS } = require(path.join(DESKTOP, 'main', 'cuaProcess', 'registry.js'));

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.stack || e.message}`); process.exitCode = 1; }
}

const spawnFork = () => fork(CHILD_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

// ── 0. 纯 Node 宿主（无 utilityProcess）不可用 → main.js 回退直调（降级链前提）──
await check('纯 Node 宿主下 isAvailable()=false（降级链前提）', () => {
  assert.equal(host.isAvailable(), false);
});

// ── 1. 完整 call 往返：真实 osascript 权限探针（结果 true/false 依授权状态，类型必须布尔）──
host.initCuaProcess({ spawnChild: spawnFork });
await check('call 往返：isAccessibilityGranted 经子进程返回布尔', async () => {
  const s = host.createSession();
  const r = await s.call('isAccessibilityGranted');
  assert.equal(typeof r, 'boolean');
  assert.equal(s.isLive(), true);
  s.dispose();
  assert.equal(s.isLive(), false);
});

// ── 2. 未知通道：业务错误原样上抛，不触发重启（子进程仍存活）──
await check('未知通道：cuaCallError 不触发重启', async () => {
  const s = host.createSession();
  const err = await s.call('noSuchChannel').then(() => null, (e) => e);
  assert.ok(err && err.cuaChildDead !== true, '业务错误不应带 cuaChildDead');
  assert.match(err.message, /未知通道/);
  assert.equal(s.isLive(), true, '业务错误后子进程应保持');
  s.dispose();
});

// ── 3. 崩溃重启：外部杀进程后下一次调用自动重建（验收①的编程等价面）──
await check('子进程被杀后下次调用透明重建并成功', async () => {
  let childRef = null;
  host.initCuaProcess({ spawnChild: () => { childRef = spawnFork(); return childRef; } });
  const s = host.createSession();
  await s.call('isAccessibilityGranted');
  const pid1 = childRef.pid;
  childRef.kill('SIGKILL'); // 模拟引擎侧崩溃
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.isLive(), false, 'exit 后应标记为非活跃');
  const r2 = await s.call('isAccessibilityGranted'); // 透明重建
  assert.equal(typeof r2, 'boolean');
  assert.notEqual(childRef.pid, pid1, '应已重建新进程');
  s.dispose();
  host.initCuaProcess({ spawnChild: spawnFork });
});

// ── 4. 启动即死：透明重试超限 → cuaDegraded（能力降级提示路径）──
await check('子进程启动即死：重试超限抛 cuaDegraded', async () => {
  host.initCuaProcess({
    spawnChild: () => { const c = spawnFork(); c.kill('SIGKILL'); return c; },
    callTimeoutMs: 3000,
  });
  const s = host.createSession();
  const err = await s.call('isAccessibilityGranted').then(() => null, (e) => e);
  assert.ok(err && err.cuaDegraded === true, `应带 cuaDegraded，实际：${err && err.message}`);
  s.dispose();
  host.initCuaProcess({ spawnChild: spawnFork });
});

// ── 5. ready 超时：子进程挂死在初始化 → 超时杀进程重建 → 超限降级 ──
await check('永不 ready 的子进程：ready 超时触发降级', async () => {
  host.initCuaProcess({
    spawnChild: () => fork(NO_READY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }),
    callTimeoutMs: 300,
  });
  const s = host.createSession();
  const err = await s.call('isAccessibilityGranted').then(() => null, (e) => e);
  assert.ok(err && err.cuaDegraded === true, `应带 cuaDegraded，实际：${err && err.message}`);
  s.dispose();
  host.initCuaProcess({ spawnChild: spawnFork });
});

// ── 6. registry 完整 + 主进程接线静态断言 ──
// 2026-10-30：CUA 实现从 main.js 整段抽到 main/cuaHandlers.js，本组断言改读新模块。
await check('通道登记表与主进程接线完整', () => {
  assert.deepEqual(CUA_CHANNELS, ['isAccessibilityGranted', 'collectAxTree', 'performAction', 'isScreenLocked']);
  const cuaSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'cuaHandlers.js'), 'utf8');
  assert.match(cuaSrc, /require\('\.\/cuaProcess\/host'\)/);
  assert.match(cuaSrc, /cuaProcess\.isAvailable\(\) \? cuaProcess\.createSession\(\)/);
  assert.match(cuaSrc, /cuaExec\('collectAxTree'/);
  assert.match(cuaSrc, /cuaExec\('performAction'/);
  assert.match(cuaSrc, /err\.cuaDegraded/);
  assert.match(cuaSrc, /cuaSession\?\.dispose\(\)/);
});

console.log(`\ncua-process: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
