// 停止按钮「点了没反应」的修复门禁（2026-10-18）
//
// 真机现象：编排组在跑，点 Composer 的停止按钮完全没动静，子 Agent 继续烧 token。
// 根因有两层，本文件各守一条：
//   ① 父 run 已收尾时（inFlight=false、abortRef=null），旧 stop() 走进空分支 ——
//      既没有 controller 可 abort、也没有 ref 可 abort，等于空操作且无任何提示；
//   ② UI 复位被放在 finalizeRun 的 await 之后，落库慢一拍，用户就盯着「运行中」不动。
//
// 这里测的是①：点停止要连带取消该会话下仍在跑的编排组（别的会话的组不能误杀）。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '..', 'renderer')] }));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');

/**
 * 从 `{` 起配对到它自己的 `}`（跳过字符串/模板串/注释里的括号）。
 * 与 onboarding-model-apply 的 matchBrace 同口径。
 * 定义在模块顶层而非下面的 async IIFE 体内：位置级 ratchet 以「语句归一化文本」为指纹，
 * 塞进 IIFE 体内会让那条 IIFE 语句文本整条变样，被判成「新增 1 处裸 promise」。
 */
function matchBrace(src, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) break; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const built = esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'renderer', 'src', 'lib', 'stopThreadWork.ts')],
  bundle: true, format: 'cjs', platform: 'node', write: false,
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require);
const { abortGroupsForThread } = mod.exports;

// ── 假桥：记录被取消的组 ──
function mockBridge(groups, opts = {}) {
  const aborted = [];
  globalThis.window = {
    mjcode: {
      tasksList: async () => {
        if (opts.listThrows) throw new Error('boom');
        return opts.wrapInGroups ? { groups } : groups;
      },
      tasksAbortGroup: async (id) => {
        if (opts.abortThrows) throw new Error('abort boom');
        aborted.push(id);
        return { ok: true };
      },
    },
  };
  return aborted;
}

const G = (id, status, thread) => ({ group_id: id, status, thread_id: thread });

(async () => {
  let aborted;
  const run = async (name, fn) => {
    total++;
    try { await fn(); console.log(`[PASS] ${name}`); pass++; }
    catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
  };

  await run('取消本会话的活跃组（running / queued / pending）', async () => {
    aborted = mockBridge([
      G('g-run', 'running', 't1'),
      G('g-queued', 'queued', 't1'),
      G('g-pending', 'pending', 't1'),
    ]);
    const n = await abortGroupsForThread('t1');
    assert.equal(n, 3);
    assert.deepEqual(aborted.sort(), ['g-pending', 'g-queued', 'g-run']);
  });

  await run('不碰别的会话的组（避免「切页回来会话被关掉」的老毛病）', async () => {
    aborted = mockBridge([G('g-mine', 'running', 't1'), G('g-other', 'running', 't2')]);
    await abortGroupsForThread('t1');
    assert.deepEqual(aborted, ['g-mine']);
  });

  await run('已完成/失败/取消的组不重复取消', async () => {
    aborted = mockBridge([
      G('g-done', 'done', 't1'), G('g-failed', 'failed', 't1'), G('g-cancelled', 'cancelled', 't1'),
      G('g-live', 'running', 't1'),
    ]);
    const n = await abortGroupsForThread('t1');
    assert.equal(n, 1);
    assert.deepEqual(aborted, ['g-live']);
  });

  await run('threadId 为 null 时一个都不碰（无归属时宁可少停，不误杀）', async () => {
    aborted = mockBridge([G('g-live', 'running', 't1')]);
    const n = await abortGroupsForThread(null);
    assert.equal(n, 0);
    assert.deepEqual(aborted, []);
  });

  await run('没有 thread_id 的组不冒认（不能被当成当前会话的）', async () => {
    aborted = mockBridge([{ group_id: 'g-null', status: 'running' }, G('g-mine', 'running', 't1')]);
    await abortGroupsForThread('t1');
    assert.deepEqual(aborted, ['g-mine']);
  });

  await run('tasks:list 抛错时安静返回 0（不能因为查不到组让停止本身失败）', async () => {
    aborted = mockBridge([], { listThrows: true });
    const n = await abortGroupsForThread('t1');
    assert.equal(n, 0);
  });

  await run('单个组取消失败不影响其他组', async () => {
    aborted = mockBridge([G('g-a', 'running', 't1'), G('g-b', 'running', 't1')], { abortThrows: false });
    // 让第一个失败：包一层
    const orig = globalThis.window.mjcode.tasksAbortGroup;
    let first = true;
    globalThis.window.mjcode.tasksAbortGroup = async (id) => {
      if (first) { first = false; throw new Error('one failed'); }
      return orig(id);
    };
    const n = await abortGroupsForThread('t1');
    assert.equal(n, 1, '失败一个应继续取消另一个');
    assert.deepEqual(aborted, ['g-b']);
  });

  await run('兼容 { groups } 返回形状', async () => {
    aborted = mockBridge([G('g-live', 'running', 't1')], { wrapInGroups: true });
    const n = await abortGroupsForThread('t1');
    assert.equal(n, 1);
  });

  // ── 源码形态：stop() 不能再有「静默空操作」 ──
  const hook = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'hooks', 'useAgentRun.ts'), 'utf8');

  check('stop() 注册表键统一 String()（写入侧就是 String(thread.id)）', () => {
    assert.match(hook, /runRegistry\.get\(String\(tid\)\)/);
  });

  check('stop() 无条件兜底：父 run 不在时按 runId 直接中止，并取消编排组', () => {
    const start = hook.indexOf('function stop()');
    assert.ok(start > 0, '找不到 function stop()（函数名/形态变了就要同步本抽取器）');
    const open = hook.indexOf('{', start);
    assert.ok(open > start, 'function stop() 后面没有函数体');
    const end = matchBrace(hook, open);
    assert.ok(end > open, `stop() 函数体括号未配对（起点 ${open}）`);
    // 窗口必须严格等于 stop() 自己的函数体。早先用「下一个注释标记」当终点：
    // 一旦 stop() 被掏成空壳、真逻辑改名下移，窗口会溢出到后面那个函数的函数体，
    // 三个断言照样全过 —— 产品真坏了测试却全绿（S10 T14 实测假绿）。故改括号配对。
    const body = hook.slice(start, end + 1);
    // 三个分支（有 controller / 有 abortRef / 两者都没有）都必须取消编排组。
    // 只断言「出现过一次」是不够的 —— 前两个分支天然会带一次，漏掉兜底分支也能过（变异验证踩过）。
    const calls = (body.match(/abortGroupsForThread\(tid\)/g) || []).length;
    assert.ok(calls >= 3, `stop() 的三个分支都应取消编排组，实际只有 ${calls} 处`);
    assert.match(body, /activeRunIdRef\.current/);
    assert.match(body, /agentAbort\?\.\(rid\)/);
  });

  check('UI 复位在 finalizeRun 的同步段（不能排在落库 await 之后）', () => {
    // 同步复位块必须出现在「落库去重」注释之前
    const resetIdx = hook.indexOf('abortRef.current = null;\n        setStreamingText');
    const persistIdx = hook.indexOf('落库去重 + 收尾加固');
    assert.ok(resetIdx > 0, '找不到同步复位块');
    assert.ok(persistIdx > 0, '找不到落库段标记');
    assert.ok(resetIdx < persistIdx, '同步复位必须在落库之前（否则落库慢一拍，界面就一直显示运行中）');
  });

  console.log(`\nstop-thread-work: ${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
})();
