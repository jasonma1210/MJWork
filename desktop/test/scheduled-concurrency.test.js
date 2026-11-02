// 定时任务全局并发闸（RQ-07 回归）：
// 同一分钟命中 N 个任务时，在途执行数必须 ≤ 上限，其余进入 FIFO 队列且**状态可见**（queue_state）。
//
// 为什么必须是行为断言：旧实现里 running 只是个 Set（按 taskId 去重），tick 对每个命中任务
// 直接 runTask——「并发上限」这件事在代码里根本不存在。只读源码或读日志无法证明它现在存在，
// 所以这里用真实的 tick + 可控挂起的 runAgentTask 把「在途 2 / 排队 2」量出来。
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-sched-conc-'));
const noop = () => {};
const electronStub = {
  app: { getPath: () => dir, isPackaged: false, on: noop, whenReady: () => Promise.resolve(), quit: noop },
  ipcMain: { handle: noop, on: noop, once: noop },
  shell: { openExternal: noop, openPath: noop },
  BrowserWindow: class { static getAllWindows() { return []; } },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const sched = require('../main/scheduler');

// 可控挂起的执行通道：每调用一次登记一个 resolver，测试用 releaseAll 逐个放行
const gates = [];
const runAgentTask = () => new Promise((resolve) => {
  gates.push(() => resolve({ output: 'done', toolCalls: 0, writes: 1, shellWrites: 0, verify: { stats: {} }, delivery: 'ok', workDir: dir }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  sched.startScheduler({ runAgentTask, notify: noop, maxConcurrentRuns: 2, taskTimeoutMs: 10000 });
  sched.setModel({ providerId: 'p1', model: 'test-model' });

  const tasks = [];
  for (let i = 0; i < 4; i += 1) {
    const r = sched.createTask({ name: `并发任务${i}`, prompt: '输出 ok', schedule: '* * * * *', enabled: true });
    if (!r.ok) throw new Error(`建任务失败：${r.error}`);
    tasks.push(r.task);
  }
  check('4 个任务均已建成', tasks.length === 4);

  sched.tick();                       // 同一分钟全部命中
  check('并发闸上限生效：在途 ≤ 2', sched.getQueueState().running === 2, JSON.stringify(sched.getQueueState()));
  check('其余进入队列（2 个）', sched.getQueueState().queued === 2, JSON.stringify(sched.getQueueState()));
  const queuedTasks = tasks.filter((t) => t.queue_state === 'queued');
  check('排队状态对 UI 可见（queue_state=queued）', queuedTasks.length === 2,
    `queued_at=${queuedTasks[0] && queuedTasks[0].queued_at ? '有' : '无'}`);

  // 放行一个：队列应自动补位（finally → drainQueue），在途仍为 2、排队降为 1
  gates.shift()();
  await sleep(30);
  check('放行一个后在途保持 2（队列自动补位）', sched.getQueueState().running === 2, JSON.stringify(sched.getQueueState()));
  check('排队数降为 1', sched.getQueueState().queued === 1, JSON.stringify(sched.getQueueState()));

  // 全部放行：最终 4 个都执行完，队列清空
  while (gates.length > 0) {
    gates.shift()();
    await sleep(20);
    if (sched.getQueueState().queued === 0 && sched.getQueueState().running === 0) break;
  }
  // 收尾：把残留的放行掉（补位时可能又新建了 gate）
  for (let i = 0; i < 6 && sched.getQueueState().running > 0; i += 1) {
    if (gates.length === 0) await sleep(20);
    while (gates.length > 0) { gates.shift()(); await sleep(20); }
  }
  const finalState = sched.getQueueState();
  check('全部执行完毕后队列清空、在途归零', finalState.queued === 0 && finalState.running === 0, JSON.stringify(finalState));
  check('排队标记已清除', tasks.every((t) => t.queue_state === undefined));

  sched.stopScheduler();
  Module._load = origLoad;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  // 用 exitCode 而不是 process.exit：本套件后面还有 catch 兜底语句，
  // 审计脚本 audit-exit-following 会把「可能以 0 退出且之后还有代码」判为风险（确有其理）。
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[FAIL] 套件异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
