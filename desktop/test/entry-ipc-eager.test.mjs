// 入口判定 IPC 的注册时机门禁（2026-10-24 真机缺陷修复）
//
// 真机日志（用户机）：
//   Error occurred in handler for 'entry:policy': [Error: No handler registered for 'entry:policy']
//   （StrictMode 下报两次）
//
// 根因：`entry:policy` / `entry:choice` 的注册写在 `ensureIpc()` 里，而它**只**被
// `judgeAndStart()` 调用 —— 也就是「第一次 agent:run」才注册。但调用方是渲染层的
// `EntryRouteNotice`，它**一挂载**就查策略 ⇒ 启动瞬间必然无 handler。
// 这类缺陷的形态是「功能没坏，但每次启动刷两条 ERROR，且策略恒为未知」，
// 靠功能测试抓不到，只能靠「注册时机」这条断言。
//
// 本套件守的不变量：**require 主进程模块后，handler 就必须已经存在**，
// 不需要先跑一次 agent:run。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { installElectronStub } from './helpers/electronStub.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

// stub electron：只提供 ipcMain.handle，记录注册了哪些通道
// （缓存键由 require.resolve 现算，见 helpers/electronStub.mjs 里对 pnpm realpath 的说明）
const handlers = new Map();
installElectronStub({
  ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); } },
  app: { getPath: () => '/tmp' },
});

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); process.exitCode = 1; }
};

// ⚠ 只 require，**不调用任何运行入口**（不调 judgeAndStart）——这正是缺陷发生的时刻
const runtime = require(path.join(ROOT, 'main/entryRuntime.js'));

await check('A1 require 主进程模块后，entry:policy 已注册（不需先跑一次 agent:run）', () => {
  assert.ok(handlers.has('entry:policy'),
    'entry:policy 未在模块加载时注册 —— 渲染层一挂载就会拿到 No handler registered');
});

await check('A2 require 后 entry:choice 也已注册（确认卡的答复通道同样按「一渲染就可用」设计）', () => {
  assert.ok(handlers.has('entry:choice'), 'entry:choice 未在模块加载时注册');
});

await check('A3 entry:policy 的行为：返回 { ok:true, policy }，且 policy 是对象（不是 null/字符串）', async () => {
  const h = handlers.get('entry:policy');
  const r = await h({}, {});
  assert.equal(r.ok, true, `ok 不为 true：${JSON.stringify(r)}`);
  assert.equal(typeof r.policy, 'object');
  assert.ok(r.policy, 'policy 为空');
  // 策略文件存在且被解析（否则渲染层永远读不到开关）
  const p = path.join(ROOT, 'main/entryPolicy.json');
  assert.ok(fs.existsSync(p), 'main/entryPolicy.json 不存在');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(Object.keys(raw).length > 0, 'entryPolicy.json 是空对象');
});

await check('A4 entry:choice 的行为：记录用户答复并回 { ok }（非法 choice 不抛错）', async () => {
  const h = handlers.get('entry:choice');
  const good = await h({}, { conversationId: 'c1', goal: '并行做三件事', choice: 'single' });
  assert.equal(good.ok, true, `合法 choice 应返回 ok:true：${JSON.stringify(good)}`);
  const bad = await h({}, { conversationId: 'c1', goal: 'x', choice: 'whatever' });
  assert.equal(bad.ok, false, `非法 choice 应返回 ok:false（不抛错）：${JSON.stringify(bad)}`);
});

await check('A5 注册是幂等的：再走一次运行入口不会因重复注册抛错（Electron 重复 handle 会 throw）', () => {
  // judgeAndStart 内部仍会 ensureIpc()（保留为防御），必须靠 ipcReady 幂等
  assert.doesNotThrow(() => {
    runtime.judgeAndStart({ messages: [], conversationId: 'c1' }, {}, {}, () => ({ ok: true }));
  });
  assert.ok(handlers.has('entry:policy'), '幂等调用后 handler 不该消失');
});

await check('A6 反向守卫：不得把注册改回「只在 judgeAndStart 里惰性注册」的形态', () => {
  // 源码级判据（辅助）：确保模块顶层确实有一次无条件调用，而不是只出现在函数体内。
  // 判据要看「函数定义之外」是否出现 ensureIpc() —— 只判字符串存在会被函数体内那次骗过。
  const src = fs.readFileSync(path.join(ROOT, 'main/entryRuntime.js'), 'utf8');
  const fnStart = src.indexOf('function ensureIpc()');
  const fnEnd = src.indexOf('\n}', fnStart);
  const outside = src.slice(0, fnStart) + src.slice(fnEnd);
  assert.ok(/ensureIpc\(\)/.test(outside),
    'ensureIpc() 只出现在函数定义内部或 judgeAndStart 里 —— 惰性注册已回归，启动瞬间会 No handler');
});

console.log(`\nentry-ipc-eager: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
