// 第八轮：探活撤员的**端到端**验证（第八轮 §8.7 #2，此前只有单模块覆盖）
//
// 为什么单模块测不够（角度 B 的原话）：多智能体是在**接缝**处失败的。撤员这条链有五个接缝：
//   探活采样（三通道）→ 判停滞（连续 miss + 真实静默窗口）→ 挑受害者 + 选备用 → 记重派意图
//   → **在 run 收尾的安全窗口消费意图**（回 queued / 改派 / 级联唤醒 / 推进调度）
// 任一接缝顺序错或字段错，界面上都看不出异常：任务就那么一直「运行中」，直到墙钟超时。
//
// 时序控制：`createWaveEngine` 支持注入 `now` 与 `autoTimer:false`，测试手动 `probeOnce()` 推进。
// 不这么做就只能真等 `WAVE_PROBE_IDLE_MS=120000`（2 分钟）× 3 拍——既慢又不稳，
// 而且真实定时器 unref 后还可能因进程退出而不触发，测试会「静默半途而废」。
//
// 本套件锁六件事：
//   ① 真机事故修复点：8s 首字节等待（< 静默窗口）**不得**被判停滞；
//   ② 连续 3 拍无变化且静默超窗 ⇒ 撤员：abort 在役 run、发 stall 事件、并发降档一次；
//   ③ 备用成员挑选同类型且排除已撤员；无归属时不误判；
//   ④ 重派意图只能在收尾窗口被**消费一次**（takeStall 幂等），消费后回 queued 并改派；
//   ⑤ 单任务最多撤 1 次（MAX_REASSIGN_PER_TASK）、并发每组只降一次；detach 还原并发；
//   ⑥ 顺序保证：workerPool 里 `consumeStall` 必须早于失败分支（源码索引比较，不是靠注释）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { createWaveEngine } = require(path.join(ROOT, 'main/waveEngine.js'));
const teamWaves = require(path.join(ROOT, 'main/teamWaves.js'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── 夹具 ──
const GID = 'g1';
function makeWorld(extraHost = {}) {
  const world = {
    t: 0,
    arbs: [],           // aborts 记录
    events: [],
    scheduled: 0,
    woken: [],
    reassigned: [],
    failedTasks: [],
    memberStates: [],   // D4-03：成员状态回写记录（{id, s}）
    maxConc: 4,
    concHistory: [],
    tasks: {
      t1: { taskId: 't1', groupId: GID, status: 'running', ownerMemberId: 'm-slow', title: '任务一' },
      t2: { taskId: 't2', groupId: GID, status: 'running', ownerMemberId: 'm-two', title: '任务二' },
    },
    roster: [
      { id: 'm-slow', name: '慢成员', roleKind: 'member', template_ref: 'dev-a', toolNames: [] },
      { id: 'm-two', name: '成员二', roleKind: 'member', template_ref: 'dev-b', toolNames: [] },
      { id: 'm-backup', name: '备用', roleKind: 'member', template_ref: 'dev-a', toolNames: [] },
    ],
    msgSeq: 0,
  };
  const store = {
    listTasks: () => Object.values(world.tasks),
    getTask: (_gid, id) => world.tasks[id] || null,
    getGroup: () => ({ group_id: GID, dag: { assignments: { t1: 'm-slow', t2: 'm-two' } } }),
    reassignTask: (gid, taskId, memberId, meta) => { world.reassigned.push({ gid, taskId, memberId, meta }); },
    setTaskStatus: (gid, taskId, status, meta) => { world.failedTasks.push({ taskId, status, meta }); },
    settleWaitingTasks: () => ['t9'],
  };
  world.engine = createWaveEngine({
    getDeps: () => ({
      store,
      getTeamMessageSeq: () => world.msgSeq,
      resolveTeamRoster: () => world.roster,
      // D4-03：成员状态回写通道（生产由 workerPool deps.setMemberState 提供，fail-open）
      setMemberState: (id, s) => world.memberStates.push({ id, s }),
    }),
    activeRuns: new Map([
      [`${GID}/t1`, { name: 'worker-1', controller: { abort: (r) => world.arbs.push({ taskId: 't1', reason: r }) }, iso: null }],
      [`${GID}/t2`, { name: 'worker-2', controller: { abort: (r) => world.arbs.push({ taskId: 't2', reason: r }) }, iso: null }],
    ]),
    emit: (e) => world.events.push(e),
    schedule: () => { world.scheduled += 1; },
    broadcastWoken: (gid, ids) => world.woken.push({ gid, ids }),
    discardIso: async () => {},
    getMaxConcurrent: () => world.maxConc,
    setMaxConcurrent: (n) => { world.maxConc = n; world.concHistory.push(n); },
    now: () => world.t,
    autoTimer: false, // 手动 probeOnce 推进
    ...extraHost,
  });
  world.attach = () => world.engine.attach(GID, [{ index: 0, taskIds: ['t1', 't2'] }]);
  return world;
}

// ── ① 静默窗口内的「无事件」不是停滞（真机事故：8s 首字节被判死）──
{
  const w = makeWorld();
  w.attach();
  w.engine.countTrace({ type: 'task_activity', groupId: GID, taskId: 't1', kind: 'tool' });
  w.t = 8000; // 模型首字节 8s：三通道都没变化，但仍在推理
  const stalled1 = w.engine.probeOnce();
  check('① 静默 8s（< 120s 窗口）不算停滞', stalled1.length === 0 && w.arbs.length === 0,
    `stalled=${JSON.stringify(stalled1)}`);
  // 即使连续多拍，只要还在窗口内就不判
  w.t = 60000;
  w.engine.probeOnce();
  w.engine.probeOnce();
  check('① 连续多拍但仍在静默窗口内 ⇒ 仍不撤员', w.arbs.length === 0, `arbs=${w.arbs.length}`);
}

// ── ② 连续 3 拍无变化 + 静默超窗 ⇒ 撤员（abort / 事件 / 降档一次）──
{
  const w = makeWorld();
  w.attach();
  w.engine.countTrace({ type: 'task_activity', groupId: GID, taskId: 't1', kind: 'tool' });
  w.t = teamWaves.WAVE_PROBE_IDLE_MS + 1000; // 越过静默窗口
  // 探活判据是「**连续** maxMisses 拍签名不变」：第一拍只建立基线（last=null → misses 0），
  // 之后每拍才累加。所以「判停滞」需要 1 拍基线 + 3 拍无变化，共 4 拍。
  // 这不是实现缺陷而是判据语义（first-sample 不能算 miss，否则单个空窗就误杀）。
  const rBase = w.engine.probeOnce();
  check('② 第一拍只建立基线（misses=0，不撤员）', rBase.length === 0 && w.arbs.length === 0);
  const r1 = w.engine.probeOnce();
  const r2 = w.engine.probeOnce();
  check('② 第 2、3 拍只累计 miss，不撤员', r1.length === 0 && r2.length === 0 && w.arbs.length === 0,
    `misses 累计中，arbs=${w.arbs.length}`);
  const r3 = w.engine.probeOnce();
  check('② 第 3 拍判停滞并撤员', r3.length === 1 && r3[0] === GID, JSON.stringify(r3));
  check('② 在役 run 被 abort（reason 写明探活判定）',
    w.arbs.length === 1 && /探活/.test(String(w.arbs[0].reason?.message)), `arbs=${w.arbs.length}`);
  const stallEvt = w.events.find((e) => e.kind === 'stall');
  check('② 发出 stall 事件（带成员名与 textKey，供 UI 显示）',
    !!stallEvt && stallEvt.textKey === 'runtime.workerStalled' && stallEvt.taskId === 't1',
    stallEvt ? JSON.stringify({ t: stallEvt.taskId, k: stallEvt.kind }) : '无事件');
  check('② 并发降档一次（4 → 2）', w.concHistory.length === 1 && w.concHistory[0] === 2,
    `history=${JSON.stringify(w.concHistory)}`);

  // ── ③ 备用成员：同类型且排除已撤员 ──
  // **必须用独立世界**：`takeStall` 是破坏性消费（取走即删），在下面 ④ 要用同一个意图时
  // 先取一次会让 consumeStall 拿到 null —— 第一版就是这么把自己坑了（④ 全红）。
  {
    const w2 = makeWorld();
    w2.attach();
    w2.t = teamWaves.WAVE_PROBE_IDLE_MS + 1000;
    for (let i = 0; i < 4; i++) w2.engine.probeOnce();
    const stall = w2.engine.takeStall(GID, `${GID}/t1`);
    check('③ 重派意图指向**同类型备用成员**（dev-a → m-backup）',
      stall && stall.memberId === 'm-backup' && stall.sameMember === false,
      stall ? JSON.stringify(stall) : '无意图');
    check('③ 已撤员成员被排除在可指派名册外',
      w2.engine.eligibleRoster(GID, w2.roster).every((m) => m.id !== 'm-slow'));
    check('③ preferredOwnerOf：指派给已撤员成员的任务返回 null（不得派回同一人）',
      w2.engine.preferredOwnerOf({ group_id: GID, dag: { assignments: { t1: 'm-slow' } } }, { taskId: 't1' }) === null);
  }

  // ── ④ 消费意图（唯一安全窗口）：回 queued + 改派 + 级联唤醒 + 推进调度 ──
  const consumed = await w.engine.consumeStall(
    { group_id: GID }, w.tasks.t1, `${GID}/t1`, { iso: null, workerName: 'worker-1' },
  );
  check('④ consumeStall 返回 true（调用方据此直接 return，不再走失败分支）', consumed === true);
  check('④ 任务回到 queued 并改派给备用成员',
    w.reassigned.length === 1 && w.reassigned[0].memberId === 'm-backup'
    && w.reassigned[0].taskId === 't1', JSON.stringify(w.reassigned.map((r) => `${r.taskId}→${r.memberId}`)));
  check('④ 发出 task_update(queued)（UI 不会停在「运行中」）',
    w.events.some((e) => e.type === 'task_update' && e.status === 'queued' && e.taskId === 't1'));
  check('④ 发出 reassign 活动事件（文案键区分「改派」与「同人重跑」）',
    w.events.some((e) => e.kind === 'reassign' && e.textKey === 'runtime.workerReassigned'));
  check('④ 级联唤醒等它的任务（settleWaitingTasks 结果被广播）',
    w.woken.length === 1 && w.woken[0].ids.includes('t9'), JSON.stringify(w.woken));
  check('④ 撤员后推进调度（schedule 被调用）', w.scheduled >= 1, `schedule=${w.scheduled}`);
  check('④ 意图只能消费一次（第二次为空，防重复重派）',
    w.engine.takeStall(GID, `${GID}/t1`) === null);
  // D4-03：撤员使被撤成员永久停在 busy —— 因为 consumeStall 返回 true 后 workerPool 会**直接 return**，
  // 那句「终态→idle」的回写根本不会执行。名册里留僵尸成员，后续派活还会再选中它。
  check('④ D4-03 撤员后原成员被显式置 offline（终态→idle 回写在此分支不执行）',
    w.memberStates.some((m) => m.id === 'm-slow' && m.s === 'offline'),
    JSON.stringify(w.memberStates));
  check('④ D4-03 不越权改备用成员状态（新 owner 由任务开始时统一置 busy）',
    w.memberStates.every((m) => m.id !== 'm-backup'), JSON.stringify(w.memberStates));
}

// ── ⑤ 防雪崩：单任务最多撤 1 次、并发每组只降一次、detach 还原 ──
{
  const w = makeWorld();
  w.attach();
  w.t = teamWaves.WAVE_PROBE_IDLE_MS + 1000;
  // 每个「判停滞周期」= 1 拍基线 + 3 拍无变化；撤员后 probe.reset()，下一轮重新建基线。
  const round = () => { for (let i = 0; i < 4; i++) w.engine.probeOnce(); };
  round(); // 撤 t1
  round(); // 撤 t2（t1 已撤过 1 次，跳过它）
  check('⑤ 两个任务各被撤一次（第二拍挑到 t2）',
    w.arbs.length === 2 && w.arbs[1].taskId === 't2', JSON.stringify(w.arbs.map((a) => a.taskId)));
  check('⑤ 并发只降一次（4 → 2，不是连续减半到 1）',
    w.concHistory.length === 1 && w.maxConc === 2, `history=${JSON.stringify(w.concHistory)}`);
  round(); round();
  check('⑤ 两任务都撤过 ⇒ 再静默也不再撤（交给墙钟超时兜底，不误判失败）',
    w.arbs.length === 2 && w.failedTasks.length === 0,
    `arbs=${w.arbs.length} failed=${w.failedTasks.length}`);
  w.engine.detach(GID);
  check('⑤ detach 还原并发基线（4），不永久拖慢其它 run', w.maxConc === 4, String(w.maxConc));
}

// ── ⑥ 顺序保证：consumeStall 必须早于失败分支（源码索引比较）──
{
  const src = fs.readFileSync(path.join(ROOT, 'main/workerPool.js'), 'utf8');
  // 只在 runWorkerTask 的**函数体**内比较：全文第一个 `abortReason` 出现在别处（函数签名/早期注释），
  // 用全文 indexOf 比较会得到无意义的结论（第一版就是这么错的）。
  const fnStart = src.indexOf('async function runWorkerTask');
  const fnEnd = src.indexOf('\n}\n', fnStart);
  const body = fnStart > 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : '';
  const iStall = body.indexOf('waveEngine?.consumeStall(');
  const iAbort = body.indexOf('} else if (abortReason != null) {');
  check('⑥ 能定位 runWorkerTask 函数体', body.length > 1000, `len=${body.length}`);
  check('⑥ workerPool 在函数体内调用了 consumeStall', iStall > 0, `idx=${iStall}`);
  check('⑥ consumeStall 早于 abortReason 失败分支——否则撤员会被当成超时失败落库',
    iStall > 0 && iAbort > 0 && iStall < iAbort, `stall=${iStall} abort=${iAbort}`);
  check('⑥ waveEngine 暴露 probeOnce（时序注入的配套出口）',
    typeof createWaveEngine({
      getDeps: () => ({}), activeRuns: new Map(), emit() {}, schedule() {},
      getMaxConcurrent: () => 1, setMaxConcurrent() {}, autoTimer: false,
    }).probeOnce === 'function');
}

void assert;

// ── ⑦ B-15：组级降档回调存在时，不动全局并发 ──
{
  const lowered = [];
  const restored = [];
  const world = makeWorld({
    lowerGroupConcurrency: (gid) => { lowered.push(gid); return 2; },
    restoreGroupConcurrency: (gid) => { restored.push(gid); },
  });
  world.attach();
  world.engine.countTrace({ type: 'task_activity', groupId: GID, taskId: 't1', kind: 'tool' });
  world.t = teamWaves.WAVE_PROBE_IDLE_MS + 1000;
  for (let i = 0; i < 4; i++) world.engine.probeOnce();
  check('⑦ B-15 撤员只降本组并发档（回调收到 groupId）',
    lowered.length === 1 && lowered[0] === GID, JSON.stringify(lowered));
  check('⑦ B-15 不再修改全局并发档',
    world.concHistory.length === 0 && world.maxConc === 4,
    `history=${JSON.stringify(world.concHistory)} max=${world.maxConc}`);
  world.engine.detach(GID);
  check('⑦ B-15 组收尾还原本组并发档',
    restored.length === 1 && restored[0] === GID, JSON.stringify(restored));
  check('⑦ B-15 还原不触碰全局并发档', world.concHistory.length === 0 && world.maxConc === 4);
}

console.log(`\nteam-stall-e2e: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
