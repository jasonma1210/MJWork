// P0-2 / P0-3 回归门禁：中止语义与挂起事件在渲染层的接线。
//
// 事故形状（2026-10-22 审查）：
//   P0-2  点「停止」时 lib/agent.js 立刻 `onDone('', null, true)`（不带第 4 参 meta），
//         finalizeRun 因 meta 缺 mainPersisted 判定「非主进程模式」→ 落库一条「（已停止）」；
//         与此同时主进程引擎收到 abort 仍照常收尾，把**真实**总结落库并 emit done
//         ⇒ 同一轮两条 assistant，其中一条是假的；用户再发一句时两条都进上下文。
//   P0-3  `suspended` 事件在渲染层**没有任何消费分支**（被 default 丢弃）；
//         墙钟超限更因契约枚举缺 'wallclock' 被 safeAgentEventEnvelope 降级成 error，
//         渲染层收到 error 直接 reject 整轮 ⇒ 超过默认 30 分钟的任务必崩。
//
// 本门禁守四件事：
//   A. 中止**不再伪造** onDone（消息只由主进程这个唯一写者落库）
//   B. 中止仍然立刻通知 UI 收敛（真机体验：点停止必须有反应，不能退）
//   C. 中止后主进程的真实 done 仍能被接收（此前被 settled 幂等丢弃）
//   D. suspended 四类 kind（含 wallclock）都被消费，且不被当成错误
import { runAgent } from '../renderer/src/lib/agent.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── 渲染层宿主打桩（与 preload 暴露的形状一致）──
const listeners = new Set();
const abortedRuns = [];
let seq = 0;
globalThis.window = {
  mjcode: {
    agentRun: async (payload) => ({ ok: true, runId: payload?.runId }),
    agentAbort: (runId) => { abortedRuns.push(runId); },
    // preload 用 ipcRenderer.on + removeListener ⇒ 天然支持多订阅，这里同构
    onAgentEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  },
};
function emit(evt) { for (const l of [...listeners]) l(evt); }
const nextRunId = () => `r-p02-${++seq}`;
const suspended = (kind) => ({
  saved: true, kind, summary: 's', roundsUsed: 3, rescues: 1, windowSpent: 9, budget: 10,
});

(async () => {
  // ── A/B/C：中止语义 ──
  {
    const runId = nextRunId();
    const ctrl = new AbortController();
    const seen = { done: [], aborted: 0, suspended: null };
    const p = runAgent({
      runId,
      messages: [{ role: 'user', content: '长任务' }],
      signal: ctrl.signal,
      onAborted: () => { seen.aborted += 1; },
      onSuspended: (d) => { seen.suspended = d; },
      onDone: (...args) => { seen.done.push(args); },
    });
    await tick();
    ctrl.abort();
    await tick();
    check('P0-2 中止不伪造 onDone（消息只由主进程唯一落库）', seen.done.length === 0, `done=${seen.done.length}`);
    check('P0-2 中止立刻通知 UI 收敛（onAborted 恰好一次）', seen.aborted === 1, `aborted=${seen.aborted}`);
    check('P0-2 中止请求已下发主进程', abortedRuns.includes(runId));

    // 主进程照常收尾：真实 done 必须被接收（此前 settled 会把它幂等丢弃）
    emit({ runId, type: 'done', data: { finalText: '真实总结', usage: { prompt_tokens: 7, completion_tokens: 3 }, aborted: true, mainPersisted: true, persistState: 'durable' } });
    await tick();
    check('P0-2 中止后仍接收主进程真实 done（不再被幂等丢弃）',
      seen.done.length === 1 && seen.done[0][0] === '真实总结', `done=${seen.done.length}`);
    check('P0-2 done 带 mainPersisted ⇒ 渲染层不重复落库',
      seen.done[0]?.[3]?.mainPersisted === true && seen.done[0]?.[2] === true);
    const settled = await p;
    check('P0-2 主 Promise 以真实文本 resolve', settled === '真实总结', `got=${JSON.stringify(settled)}`);
  }

  // ── D：suspended 四类 kind 全部被消费，且不进 error 路径 ──
  for (const kind of ['tokens', 'rounds', 'timeout', 'wallclock']) {
    const runId = nextRunId();
    const seen = { done: [], suspended: null, errors: 0 };
    const p = runAgent({
      runId,
      messages: [{ role: 'user', content: 'x' }],
      onSuspended: (d) => { seen.suspended = d; },
      onDone: (...args) => { seen.done.push(args); },
    });
    // 立刻挂 catch：若该 kind 不在契约枚举内，emit 时会被降级成 error 同步 reject 本 run，
    // 未挂 catch 会变成 unhandled rejection 直接杀进程（结果仍是失败，但看不到是哪条断言）。
    p.catch(() => {});
    await tick();
    emit({ runId, type: 'suspended', data: suspended(kind) });
    await tick();
    check(`P0-3 suspended(${kind}) 被消费且 kind 原样到达`,
      seen.suspended?.kind === kind, `got=${seen.suspended?.kind}`);
    // 挂起是正常状态：不能因此产生一条 error 收尾
    check(`P0-3 suspended(${kind}) 不进入 error 路径`, seen.done.length === 0, `done=${seen.done.length}`);
    emit({ runId, type: 'done', data: { finalText: '断点已保存', usage: null, aborted: false, mainPersisted: true } });
    await tick();
    // 若该 kind 不在契约枚举内，上面那条 emit 会被降级成 error → 本 run reject。
    // 这里接住它，让「断言变红」而不是「测试崩溃」（崩溃也能判失败，但诊断信息差）。
    try { await p; } catch { /* 契约降级路径：断言已于上方给出结论 */ }
  }

  // ── D2：非法 kind 仍被拒（加 wallclock 不得放开枚举）──
  {
    const runId = nextRunId();
    const seen = { suspended: 0, done: [] };
    runAgent({
      runId,
      messages: [{ role: 'user', content: 'x' }],
      onSuspended: () => { seen.suspended += 1; },
      onDone: (...args) => { seen.done.push(args); },
    }).catch(() => {});
    await tick();
    // 非法载荷会被降级成 error 事件 → reject 本 run（既有 fail-closed 行为，不得被本次改动放宽）
    emit({ runId, type: 'suspended', data: suspended('weird') });
    await tick();
    check('P0-3 非法 kind 仍被契约拒绝（枚举只加 wallclock）', seen.suspended === 0, `suspended=${seen.suspended}`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
