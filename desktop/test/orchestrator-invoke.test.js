// P0 修复回归：waitGroupSettled 的悬挂 / 泄漏 / uncaughtException 洪水（2026-10-16 独立 PR）
//
// 背景（三条叠加缺陷，修复前实测）：
//   `store.getGroup(groupId)` 原在 try 之外，抛错时 setInterval 每 2s 再抛一次：
//   ① 正常路径永不 resolve ⇒ toolOrchestrateTask 永久 await ⇒ 对话卡死；
//   ② clearInterval 永不执行 ⇒ interval 永久泄漏；
//   ③ 每 2s 一次 uncaughtException ⇒ diagnostics 写满 5MB 后真实崩溃被静默丢弃。
//   注：abort 与 30min 超时检查都在抛错点之上，故「停止」与「超时」能力修复前仍生效。
//
// 覆盖范围（不与 test/orchestrator.test.js 重复）：
//   orchestrator.test.js 已覆盖「终态等待 + 已中止 signal + humanizeGroupResult」；
//   本文件专测缺陷场景与修复后契约。
//
// 用真实 timer（pollIntervalMs 参数化，毫秒级），不引 fake-timer 依赖。
const assert = require('assert');
const { waitGroupSettled } = require('../main/orchestrator/invoke');

const POLL = 12; // 毫秒：足够快，又不至于把事件循环打满

let n = 0;
function ok(name) { n += 1; console.log(`  ✓ ${name}`); }

// 轮询若干 tick，用于验证「settle 之后 interval 确实停了」
const ticks = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── T26-1：getGroup 抛错必须 resolve，绝不悬挂 ──
  {
    const store = { getGroup() { throw new Error('sqljs handle gone'); } };
    const res = await waitGroupSettled(store, 'g1', { pollIntervalMs: POLL });
    assert.ok(res.missing === true, '抛错归类为 missing');
    assert.ok(String(res.error).includes('sqljs handle gone'), `error 透出原因：${res.error}`);
    assert.ok(res.group === undefined, '无 group 字段');
    ok('T26-1 getGroup 抛错 → resolve（不悬挂）');
  }

  // ── T26-2：settle 后 interval 停止（无残留泄漏）──
  //  无可直接数 Node 内部 timer 的公共 API，改为断言可观测后果：
  //  settle 之后再等若干个 tick，getGroup 调用数不再增长。
  {
    let calls = 0;
    const store = {
      getGroup() { calls += 1; if (calls >= 2) return { status: 'done', tasks: [] }; throw new Error('boom'); },
    };
    await waitGroupSettled(store, 'g2', { pollIntervalMs: POLL });
    const atSettle = calls;
    await ticks(POLL * 6);
    assert.strictEqual(calls, atSettle, `settle 后不应再轮询（settle 时 ${atSettle} 次，之后 ${calls} 次）`);
    ok('T26-2 settle 后 interval 停止（无泄漏）');
  }

  // ── T26-3：abort 后立即 resolve，不等下一个 tick ──
  //  修复前 abort 依赖 interval 顶部的检查，最坏要等一个 pollIntervalMs；
  //  改事件监听后应在 tick 之前就 resolve。用 300ms 轮询放大差异。
  {
    const slow = 300;
    const store = { getGroup() { return { status: 'running', tasks: [] }; } };
    const ac = new AbortController();
    const p = waitGroupSettled(store, 'g3', { signal: ac.signal, pollIntervalMs: slow });
    await ticks(slow / 3); // 起跑后再 abort（确保 interval 已建立）
    const t0 = Date.now();
    ac.abort();
    const res = await p;
    const latency = Date.now() - t0;
    assert.ok(res.aborted === true, 'abort 返回 aborted');
    assert.ok(latency < slow / 2, `abort 后应远快于一个轮询周期（latency=${latency}ms, poll=${slow}ms）`);
    ok(`T26-3 abort 事件监听即时解套（latency=${latency}ms << poll=${slow}ms）`);
  }

  // ── T26-4：双调 teardown 只 resolve 一次 ──
  //  abortHandler（once:true）与 interval 内的中止/超时检查可能各触发一次；
  //  resolve 与 clearInterval 幂等 ⇒ 结果安全，但契约上必须只 settle 一次。
  {
    const store = { getGroup() { return { status: 'running', tasks: [] }; } };
    const ac = new AbortController();
    let resolveCount = 0;
    const p = waitGroupSettled(store, 'g4', { signal: ac.signal, pollIntervalMs: POLL });
    // 包一层统计 resolve 次数（Promise 只能 settle 一次，故改为观测多次 abort 不抛错且结果稳定）
    ac.abort();
    ac.abort(); // 第二次 abort：once:true 已摘除监听，但 signal 仍处于 aborted
    ac.signal.dispatchEvent?.(new Event('abort')); // 手动再派发一次，模拟双触发
    const res = await p;
    assert.ok(res.aborted === true, '结果仍是 aborted');
    resolveCount += 1;
    // 组随后到达终态也不得二次 settle（Promise 语义保证，这里断言不抛错）
    ok('T26-4 双调 teardown 只 settle 一次且不抛错');
  }

  // ── T26-5：uncaughtException 零触发（直接防缺陷③）──
  {
    const hits = [];
    const onUncaught = (err) => { hits.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      const store = { getGroup() { throw new Error('flood'); } };
      await waitGroupSettled(store, 'g5', { pollIntervalMs: POLL });
      await ticks(POLL * 8); // 若 interval 未清，这里会持续抛
      assert.strictEqual(hits.length, 0, `不得有未捕获异常（实测 ${hits.length} 条）`);
      ok('T26-5 uncaughtException 零触发（无崩溃日志洪水）');
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  }

  // ── 回归：正常路径不被修复破坏 ──
  {
    // a) 终态等待
    let calls = 0;
    const store = { getGroup() { calls += 1; return calls >= 2 ? { status: 'done', tasks: [] } : { status: 'running', tasks: [] }; } };
    const res = await waitGroupSettled(store, 'r1', { pollIntervalMs: POLL });
    assert.ok(res.group && res.group.status === 'done', '终态等待返回 group');
    ok('回归：终态等待');

    // b) missing 组
    const res2 = await waitGroupSettled({ getGroup: () => null }, 'r2', { pollIntervalMs: POLL });
    assert.ok(res2.missing === true, 'missing 组');
    ok('回归：missing 组');

    // c) 超时
    const t0 = Date.now();
    const res3 = await waitGroupSettled({ getGroup: () => ({ status: 'running', tasks: [] }) }, 'r3', { timeoutMs: 40, pollIntervalMs: POLL });
    assert.ok(res3.timedOut === true, '超时返回 timedOut');
    assert.ok(Date.now() - t0 >= 40, '超时不早于 timeoutMs');
    ok('回归：墙钟超时');

    // d) onPoll 每 tick 回调，且 onPoll 自身抛错不打断轮询
    const polls = [];
    let calls2 = 0;
    const store4 = {
      getGroup() {
        calls2 += 1;
        return calls2 >= 3 ? { status: 'failed', tasks: [] } : { status: 'running', tasks: [] };
      },
    };
    const res4 = await waitGroupSettled(store4, 'r4', {
      pollIntervalMs: POLL,
      onPoll: (g) => { polls.push(g.status); if (polls.length === 1) throw new Error('onPoll boom'); },
    });
    assert.ok(res4.group && res4.group.status === 'failed', 'onPoll 抛错不影响终态判定');
    assert.ok(polls.length >= 3, `onPoll 每 tick 都回调（${polls.length} 次）`);
    ok('回归：onPoll 每 tick 回调且自身抛错不打断');

    // e) 已中止的 signal：直接返回、不起 interval
    let calls5 = 0;
    const ac5 = new AbortController();
    ac5.abort();
    const res5 = await waitGroupSettled({ getGroup: () => { calls5 += 1; return null; } }, 'r5', { signal: ac5.signal, pollIntervalMs: POLL });
    assert.ok(res5.aborted === true, '已中止 signal 返回 aborted');
    await ticks(POLL * 4);
    assert.strictEqual(calls5, 0, '已中止时根本不起 interval（getGroup 零调用）');
    ok('回归：已中止 signal 零 interval');
  }

  console.log(`\ninvoke waitGroupSettled P0 修复：${n} 项全部通过`);
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => { console.error(e); process.exit(1); });
