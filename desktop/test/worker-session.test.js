// M5 / T5-11：成员持久会话与对话绑定（设计稿 v1.5 §13.1 C1 / §13.2 四级 key / §13.3）
//
// 覆盖五件事（都是「不读源码就会静默错」的接线点）：
//   ① 会话键位：军团组 = `agent:{memberId}`（不是一次性的 task:...）；非军团组回落
//      `agent:anon:{groupId}:{taskId}` 隔离命名空间；
//   ② 确定性指派：团队名册 + task.seq 取模 ⇒ 同一组成员任务分到不同成员，且**落库**
//      owner_member_id（T5-5 私有记忆归属与 buildTaskPrompt 私有召回都读它）；
//   ③ 断点恢复：运行前读 `agent:{memberId}` 并注入 runOpts.resumeContext（该成员首轮为空）；
//   ④ 普通完成路径落断点：done 后写回该成员键，元数据含 threadId / runId / ownerMemberId
//      （四级 key 链在 worker 侧可反查）；
//   ⑤ 非军团组不写断点（anon 键是一次性隔离语义，写进去只会挤占 50 条 LRU）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const { initWorkerPool, runGroup } = require('../main/workerPool');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSettled(store, groupId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const g = store.getGroup(groupId);
    if (['done', 'failed', 'paused', 'cancelled'].includes(g.status)) return g;
    await sleep(25);
  }
  return store.getGroup(groupId);
}

// 假断点存储（键 → 断点对象）：断言键位与元数据，不碰真实 userData
function makeCheckpointStore(seed = {}) {
  const map = { ...seed };
  const saved = [];
  return {
    map,
    saved,
    getCheckpoint: (k) => map[k] || null,
    saveCheckpoint: (k, d) => { map[k] = { ...d, savedAt: Date.now() }; saved.push({ key: k, data: d }); return true; },
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-ws-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);

  // ── B-19：指派算法单一入口（计划优先，计划缺失才回 seq 取模）──
  {
    const ws = require('../main/workerSession');
    const roster0 = [{ id: 'm1' }, { id: 'm2' }];
    const plannedGroup = { dag: { assignments: { n1: 'm2' } } };
    check('B-19 有计划时按计划指派',
      ws.resolveOwnerMember(plannedGroup, { taskId: 'n1', seq: 1 }, roster0, null) === 'm2');
    check('B-19 运行期计划（preferredOwnerOf）优先于 dag 计划',
      ws.resolveOwnerMember(plannedGroup, { taskId: 'n1', seq: 1 }, roster0, 'm1') === 'm1');
    check('B-19 计划缺失时回落 seq 取模（确定性）',
      ws.resolveOwnerMember({ dag: {} }, { taskId: 'x', seq: 1 }, roster0, null) === 'm2'
      && ws.resolveOwnerMember({ dag: {} }, { taskId: 'x', seq: 1 }, roster0, null) === 'm2');
    check('B-19 无可用名册返回 null（不发明成员）',
      ws.resolveOwnerMember({ dag: {} }, { taskId: 'x', seq: 1 }, [], null) === null);
    // D4-01 回归：撤员后 dag.assignments 仍留着旧 id，不得把任务回派给已撤员成员（不在可用名册）
    check('D4-01 撤员成员（不在可用名册）不被回派，回落到名册内 seq 取模',
      ws.resolveOwnerMember({ dag: { assignments: { n9: 'mbr-retired' } } }, { taskId: 'n9', seq: 1 }, roster0, null) === 'm2');
    check('D4-01 planned 指向已撤员成员时同样不被采信（回落地名册）',
      ws.resolveOwnerMember({ dag: {} }, { taskId: 'n9', seq: 1 }, roster0, 'mbr-retired') === 'm2');
  }

  // ── P1（2026-10-21）：等待即打轻量断点（释放槽位后仍能接续）──
  {
    const ws = require('../main/workerSession');
    const cp = makeCheckpointStore();
    const ms = ws.createMemberSession({ getCheckpoint: cp.getCheckpoint, saveCheckpoint: cp.saveCheckpoint });
    const ok = ms.saveWaiting('agent:m9', { group_id: 'g9', thread_id: 'c9', cwd: '/x' },
      { taskId: 'a', title: '等待任务', ownerMemberId: 'm9' },
      { waitingOn: ['b'], waitDeadlineAt: 123 }, { summary: '已完成一半' });
    const saved = cp.map['agent:m9'];
    check('P1：等待断点写入 kind / waitingOn / 阶段结论',
      ok && saved.kind === 'member-wait' && saved.waitingOn.includes('b') && saved.waitDeadlineAt === 123
        && saved.summary.includes('已完成一半') && saved.summary.includes('等待：b'),
      JSON.stringify(saved).slice(0, 120));
    check('P1：非成员任务不写等待断点',
      ms.saveWaiting('agent:anon:g:a', { group_id: 'g' }, { taskId: 'a' }, {}, null) === false);
    check('P1：唤醒时 resumeContext 可读到等待断点',
      ms.read('agent:m9').includes('因等待依赖而暂停'));
  }

  // ── 场景 1/2/3/4：军团组（有成员名册 + 有断点）──
  const roster = [{ id: 'm1', name: '架构师' }, { id: 'm2', name: '测试员' }];
  const cps = makeCheckpointStore({
    'agent:m1': { summary: '成员工作记录：上次已完成「接口设计」，产出 /src/api.md' },
  });
  const runs = [];
  const hookCtx = [];
  initWorkerPool({
    loadAgentCore: async () => ({
      runAgent: async (opts) => {
        runs.push({ conversationId: opts.conversationId, resumeContext: opts.resumeContext, prompt: String(opts.messages[0].content) });
        return '已完成本子任务';
      },
    }),
    createToolHandlers: () => ({}),
    toolHooks: { wrap: (handlers, ctx) => { hookCtx.push(ctx); return handlers; } },
    store,
    maxConcurrent: 2,
    emit: () => {},
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
    // 团队名册按 run 反查（生产走 teamStore.findTeamByRun，见 main.js 注入）
    resolveTeamRoster: (g) => (g.group_id === 's1' ? roster : null),
    getCheckpoint: cps.getCheckpoint,
    saveCheckpoint: cps.saveCheckpoint,
  });
  store.createGroup({
    groupId: 's1', goal: '军团会话验证', cwd: '', dag: null, threadId: 'conv-1', tasks: [
      { id: 't1', title: '接口设计', prompt: 'x', dependsOn: [] },
      { id: 't2', title: '补测试', prompt: 'x', dependsOn: [] },
    ],
  });
  await runGroup('s1');
  const g1 = await waitSettled(store, 's1');

  check('军团组任务全部完成', g1.status === 'done' && g1.tasks.every((t) => t.status === 'done'), g1.status);

  // ② 确定性指派：seq 0 → roster[0]，seq 1 → roster[1]
  const t1 = g1.tasks.find((t) => t.taskId === 't1');
  const t2 = g1.tasks.find((t) => t.taskId === 't2');
  check('认领者按名册 + seq 取模确定性指派且落库', t1.ownerMemberId === 'm1' && t2.ownerMemberId === 'm2',
    `${t1.ownerMemberId}/${t2.ownerMemberId}`);

  // ① 会话键位 = agent:{memberId}（三处消费者共用同一键：引擎 / 工具 hooks / V 层）
  const convIds = runs.map((r) => r.conversationId).sort();
  check('引擎 conversationId = agent:{memberId}（非一次性 task: 键）',
    convIds.length === 2 && convIds[0] === 'agent:m1' && convIds[1] === 'agent:m2', convIds.join(','));
  check('工具 hooks 上下文与引擎同键（审批「本对话同类」按成员记忆）',
    hookCtx.length === 2 && hookCtx.every((c) => c.conversationId.startsWith('agent:')));

  // ③ 断点恢复只注入有断点的成员；首轮成员为空串（引擎自然忽略）
  const r1 = runs.find((r) => r.conversationId === 'agent:m1');
  const r2 = runs.find((r) => r.conversationId === 'agent:m2');
  check('成员断点被读入 resumeContext（跨 run 复用）',
    !!r1 && r1.resumeContext.includes('上次已完成「接口设计」'));
  check('无断点成员的首轮 resumeContext 为空（不伪造恢复段）', !!r2 && r2.resumeContext === '');

  // ④ 普通完成路径落断点（此前 Worker 通道从不碰断点 ⇒ 成员永远「记不住」）
  const savedM1 = cps.saved.find((s) => s.key === 'agent:m1');
  check('done 后写回成员断点键 agent:m1', !!savedM1);
  check('断点元数据含四级 key（threadId / runId / taskId / ownerMemberId）',
    !!savedM1 && savedM1.data.threadId === 'conv-1' && savedM1.data.runId === 's1'
      && savedM1.data.taskId === 't1' && savedM1.data.ownerMemberId === 'm1',
    JSON.stringify(savedM1?.data || {}).slice(0, 120));
  check('断点摘要以「成员工作记录」形态衔接引擎固定恢复文案',
    !!savedM1 && savedM1.data.kind === 'member-task' && savedM1.data.summary.startsWith('成员工作记录：')
      && savedM1.data.summary.includes('已完成本子任务'),
    String(savedM1?.data?.summary || '').slice(0, 80));

  // ── 场景 5：非军团组（无名册）→ anon 隔离键，且不写断点 ──
  const runs2 = [];
  const cps2 = makeCheckpointStore();
  initWorkerPool({
    loadAgentCore: async () => ({
      runAgent: async (opts) => { runs2.push(opts.conversationId); return '普通编排完成'; },
    }),
    createToolHandlers: () => ({}),
    store,
    maxConcurrent: 1,
    emit: () => {},
    resolveModel: () => ({ providerId: 1, isGlobal: false, baseUrl: '', model: 'test-model' }),
    buildTaskPrompt: (g, t) => t.title,
    resolveTeamRoster: () => null,
    getCheckpoint: cps2.getCheckpoint,
    saveCheckpoint: cps2.saveCheckpoint,
  });
  store.createGroup({
    groupId: 's2', goal: '普通编排组', cwd: '', dag: null, threadId: 'conv-2', tasks: [
      { id: 'n1', title: '普通任务', prompt: 'x', dependsOn: [] },
    ],
  });
  await runGroup('s2');
  const g2 = await waitSettled(store, 's2');
  check('无名册组回落 agent:anon:{groupId}:{taskId} 隔离键',
    g2.status === 'done' && runs2[0] === 'agent:anon:s2:n1', String(runs2[0] || ''));
  check('无名册组不写断点（避免挤占 50 条 LRU）', cps2.saved.length === 0, `saved=${cps2.saved.length}`);
  check('无名册组任务 ownerMemberId 为空（不伪造成员归属）',
    !g2.tasks[0].ownerMemberId, String(g2.tasks[0].ownerMemberId));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
