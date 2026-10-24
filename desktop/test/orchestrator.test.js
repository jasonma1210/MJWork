// 自动编排（WorkBuddy 式主理人模式）测试：stub LLM 驱动 orchestrator 全链路
// 覆盖：planGoal auto 元数据 / autoOrchestrate 拆解失败自动修复重试 / 失败自动重规划（含防失控上限）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');
const orchestrator = require('../main/orchestrator');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-orch-'));
// sql.js 驱动（零原生模块）：makeDeps 闭包经模块级 store 引用，IIFE 内 await 后赋值
let store;

const GOOD_DAG = JSON.stringify({
  tasks: [
    { id: 'a', title: '准备', prompt: 'p-a', dependsOn: [], critical: true, maxRetry: 1 },
    { id: 'b', title: '执行', prompt: 'p-b', dependsOn: ['a'] },
  ],
});

let n = 0;
function ok(name) { n += 1; console.log(`  ✓ ${name}`); }

function makeDeps({ chatOnce, events = [], runGroup }) {
  return {
    store,
    chatOnce,
    resolveModel: () => ({ providerId: 'p', isGlobal: true, baseUrl: '', model: 'm' }),
    emit: (e) => events.push(e),
    runGroup: runGroup || (async (gid) => ({ group_id: gid })),
  };
}

(async () => {
  store = new TaskStore(await openDbAsync(dir, { driver: 'sqljs' }));

  // 1. planGoal auto 元数据透传
  orchestrator.initOrchestrator(makeDeps({ chatOnce: async () => ({ content: GOOD_DAG }) }));
  const r1 = await orchestrator.planGoal({ goal: '目标一', cwd: '/tmp', auto: true, replanDepth: 0 });
  assert.ok(r1.ok);
  assert.strictEqual(store.getGroup(r1.groupId).auto, 1);
  ok('planGoal auto 元数据落库');

  // 2. autoOrchestrate：首次输出非法 JSON → 回喂错误自动修复重试 → 成功后自动 runGroup
  const runCalls = [];
  const events = [];
  let chatCount = 0;
  orchestrator.initOrchestrator(makeDeps({
    chatOnce: async (payload) => {
      chatCount += 1;
      if (chatCount === 1) return { content: '抱歉，我无法输出 JSON' };
      // 第二次：修复要求应已注入用户消息
      assert.ok(payload.messages[1].content.includes('修复要求'), '修复要求注入');
      return { content: GOOD_DAG };
    },
    events,
    runGroup: async (gid) => { runCalls.push(gid); },
  }));
  const r2 = await orchestrator.autoOrchestrate({ goal: '目标二', cwd: '/tmp' });
  assert.ok(r2.ok, `autoOrchestrate 应成功（${r2.error}）`);
  assert.strictEqual(chatCount, 2, '拆解失败后自动修复重试一次');
  assert.deepStrictEqual(runCalls, [r2.groupId], '建组后立即自动执行');
  assert.ok(events.some((e) => e.type === 'auto_run' && e.groupId === r2.groupId));
  ok('autoOrchestrate：坏输出自动修复重试 → 自动执行');

  // 3. 失败自动重规划：auto 组 failed → 上下文注入 → 新组 depth+1 并续跑
  const runCalls2 = [];
  const chatMsgs = [];
  orchestrator.initOrchestrator(makeDeps({
    chatOnce: async (payload) => { chatMsgs.push(payload.messages[1].content); return { content: GOOD_DAG }; },
    runGroup: async (gid) => { runCalls2.push(gid); },
  }));
  // 构造失败的 auto 组：准备任务失败 + 组 paused
  const src = store.createGroup({
    groupId: 'src-auto', goal: '会失败的目标', cwd: '/tmp', auto: true, replanDepth: 0,
    tasks: [
      { id: 'a', title: '关键准备', prompt: 'p-a', dependsOn: [], critical: true, maxRetry: 0 },
      { id: 'b', title: '执行', prompt: 'p-b', dependsOn: ['a'] },
    ],
  });
  store.setTaskStatus('src-auto', 'a', 'queued');
  store.setTaskStatus('src-auto', 'a', 'running');
  store.setTaskStatus('src-auto', 'a', 'failed', { error: '编译基线建立失败：缺 g++' });
  store.setGroupStatus('src-auto', 'running');
  store.setGroupStatus('src-auto', 'paused', { error: '关键任务「关键准备」失败' });

  const replan = await orchestrator.maybeAutoReplan('src-auto');
  assert.ok(replan && replan.ok, '失败 auto 组触发重规划');
  const newGroup = store.getGroup(replan.groupId);
  assert.strictEqual(newGroup.replan_depth, 1, '新组 depth+1');
  assert.strictEqual(newGroup.replan_of, 'src-auto', '新组指向源组');
  assert.deepStrictEqual(runCalls2, [replan.groupId], '重规划组自动续跑');
  assert.ok(chatMsgs[0].includes('关键准备'), '失败任务标题注入上下文');
  assert.ok(chatMsgs[0].includes('编译基线建立失败'), '失败原因注入上下文');
  ok('失败自动重规划：上下文注入 → 新组续跑');

  // 4. 防失控：depth≥1 的重规划组不再自动重规划（任务走合法状态机路径到 failed）
  store.setTaskStatus(replan.groupId, 'a', 'queued');
  store.setTaskStatus(replan.groupId, 'a', 'running');
  store.setTaskStatus(replan.groupId, 'a', 'failed', { error: '再次失败' });
  store.setGroupStatus(replan.groupId, 'running');
  store.setGroupStatus(replan.groupId, 'failed', { error: '再次失败' });
  const again = await orchestrator.maybeAutoReplan(replan.groupId);
  assert.strictEqual(again, null, 'depth≥1 不再自动重规划');
  ok('防失控：每条链最多自动重规划 1 次');

  // 5. 非 auto 组不触发重规划
  const manual = store.createGroup({
    groupId: 'src-manual', goal: '手动目标', cwd: '/tmp',
    tasks: [{ id: 'a', title: 'A', prompt: 'p', dependsOn: [], critical: true, maxRetry: 0 }],
  });
  store.setTaskStatus('src-manual', 'a', 'queued');
  store.setTaskStatus('src-manual', 'a', 'running');
  store.setTaskStatus('src-manual', 'a', 'failed', { error: 'x' });
  store.setGroupStatus('src-manual', 'running');
  store.setGroupStatus('src-manual', 'failed', { error: 'x' });
  assert.strictEqual(await orchestrator.maybeAutoReplan('src-manual'), null);
  ok('手动组不触发自动重规划');

  // 6. onTaskEvent 桥接：group_finalized failed → 触发重规划
  const events3 = [];
  orchestrator.initOrchestrator(makeDeps({
    chatOnce: async () => ({ content: GOOD_DAG }),
    events: events3,
    runGroup: async () => {},
  }));
  const src3 = store.createGroup({
    groupId: 'src3', goal: '桥接目标', cwd: '/tmp', auto: true,
    tasks: [{ id: 'a', title: 'A', prompt: 'p', dependsOn: [], critical: true, maxRetry: 0 }],
  });
  store.setTaskStatus('src3', 'a', 'queued');
  store.setTaskStatus('src3', 'a', 'running');
  store.setTaskStatus('src3', 'a', 'failed', { error: 'x' });
  store.setGroupStatus('src3', 'running');
  store.setGroupStatus('src3', 'failed', { error: 'x' });
  orchestrator.onTaskEvent({ type: 'group_finalized', groupId: 'src3', status: 'failed' });
  await new Promise((r) => setTimeout(r, 20)); // maybeAutoReplan 异步落组
  assert.ok(events3.some((e) => e.type === 'group_created' && e.replanOf === 'src3'), '终态事件自动触发重规划');
  ok('onTaskEvent 桥接：group_finalized → 自动重规划');

  // 7. orchestrate_task 支撑：waitGroupSettled + humanizeGroupResult
  const { waitGroupSettled, humanizeGroupResult } = require('../main/orchestrator/invoke');
  const src4 = store.createGroup({
    groupId: 'src4', goal: '等待目标', cwd: '/tmp',
    tasks: [
      { id: 'a', title: '成功任务', prompt: 'p', dependsOn: [] },
      { id: 'b', title: '失败任务', prompt: 'p', dependsOn: [], critical: true },
    ],
  });
  store.setTaskStatus('src4', 'a', 'queued');
  store.setTaskStatus('src4', 'a', 'running');
  store.setTaskStatus('src4', 'a', 'done', { result: { summary: '已产出结论' } });
  store.setTaskStatus('src4', 'b', 'queued');
  store.setTaskStatus('src4', 'b', 'running');
  store.setTaskStatus('src4', 'b', 'failed', { error: '编译失败' });
  store.setGroupStatus('src4', 'running');
  store.setGroupStatus('src4', 'paused', { error: '关键任务失败' });
  const waited = await waitGroupSettled(store, 'src4');
  assert.ok(waited.group && waited.group.status === 'paused', '等待收尾返回终态组');
  const abortController = new AbortController();
  abortController.abort();
  const aborted = await waitGroupSettled(store, 'src4', { signal: abortController.signal });
  assert.ok(aborted.aborted === true, 'signal 中止立即返回');
  const text = humanizeGroupResult(waited.group);
  assert.ok(text.includes('编排暂停'), `人话含状态：${text.slice(0, 60)}`);
  assert.ok(text.includes('失败任务'), '人话含失败明细');
  assert.ok(text.includes('max_agents 调小'), '人话含减少 Agent 建议');
  ok('waitGroupSettled + humanizeGroupResult（终态等待/中止/人话降级建议）');

  // 8. T5-9（§9.1）：派活钩子回传的编制快照随 dag_json 一次性落库；未回传不凭空造字段
  orchestrator.initOrchestrator(makeDeps({ chatOnce: async () => ({ content: GOOD_DAG }) }));
  const roster = [
    { id: 'm1', name: '统筹', roleKind: 'lead', systemPrompt: '负责分派', toolNames: ['read_file'], model: 'p::m' },
    { id: 'm2', name: '工程师', roleKind: 'member', systemPrompt: '负责实现', toolNames: ['write_file'], model: null },
  ];
  const r8 = await orchestrator.planGoal({
    goal: '快照组',
    cwd: '/tmp',
    planWaves: ({ tasks }) => ({
      waves: [{ index: 1, taskIds: tasks.map((t) => t.id) }],
      assignments: {},
      roster,
    }),
  });
  assert.ok(r8.ok);
  const g8 = store.getGroup(r8.groupId);
  assert.ok(Array.isArray(g8.dag?.roster) && g8.dag.roster.length === 2, 'dag.roster 快照落库');
  assert.strictEqual(g8.dag.roster[0].id, 'm1');
  assert.strictEqual(g8.dag.roster[1].toolNames[0], 'write_file', '快照保留工具授权');
  assert.strictEqual(g8.dag.waves.length, 1, '批次计划与快照同批落库');
  ok('T5-9：编制快照随 dag_json 落库（运行期只读快照）');

  // 钩子只给 waves 不给 roster：dag 不出现 roster 键（普通/旧派活形状保持不变）
  const r9 = await orchestrator.planGoal({
    goal: '无常快照组', cwd: '/tmp', planWaves: () => ({ waves: [{ index: 1, taskIds: ['a', 'b'] }] }),
  });
  assert.ok(r9.ok);
  assert.strictEqual(store.getGroup(r9.groupId).dag.roster, undefined, '未回传快照不造空字段');
  ok('T5-9：未回传快照时不写入 roster 键（形状零漂移）');

  // 钩子抛错：批次与快照一起降级，建组仍成功（fail-open，不阻断派活）
  const r10 = await orchestrator.planGoal({
    goal: '钩子异常组', cwd: '/tmp', planWaves: () => { throw new Error('计划崩溃'); },
  });
  assert.ok(r10.ok, '钩子异常不阻断建组');
  assert.strictEqual(store.getGroup(r10.groupId).dag.waves, null);
  ok('T5-9：批次/快照钩子异常 fail-open（按无分批调度）');

  console.log(`\norchestrator 自动编排：${n} 项全部通过`);
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => { console.error(e); process.exit(1); });
