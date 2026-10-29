// 对话用量账本回填门禁（2026-10-28）
//
// 为什么这条要进门禁：用户跑完一轮对话、甚至中途取消，工作台「用量流水」一条都看不到。
// 根因是普通单人对账**从不写** quota_consumptions —— 那本台账此前只由配额闸门（团队派单
// 经 workerPool）写入。补上回填后，这条链路的失效形态极其安静：
//   · 反查不到 projectId → 静默 return（没有任何报错）
//   · usage 为空/为 0 → 静默 return
//   · 异常被 try/catch 吞掉 → 只有一行 warn
// 三种都表现为「界面上用量一直是 0，测试全绿」。所以这里把每个分支的结果钉成断言，
// 而不是只测「happy path 能写进去」。
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordChatUsage } = require('../main/chatUsageLedger');
const { makeChatUsageDeps } = require('../main/chatUsageWiring');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.log(`❌ ${name}\n   ${e.message}`); }
}

// 记录器：把「到底写没写、写了什么」变成可断言的事实
function spyRecorder() {
  const calls = [];
  return { calls, recordUsage: (u) => { calls.push(u); return u.tokens; } };
}
const resolverOf = (projectId) => ({ resolveProjectOfConversation: () => projectId });

check('① 有 usage + 能反查到项目 → 写入 source 侧最小字段（projectId/runId/tokens/modelName）', () => {
  const spy = spyRecorder();
  recordChatUsage({ recordUsage: spy.recordUsage, resolveProjectOfConversation: () => 'proj-1' },
    { runId: 'run-9', usage: { prompt_tokens: 100, completion_tokens: 23 }, conversationId: 1741,
      projectPath: '/tmp/x', modelId: 'deepseek-flash' });
  assert.equal(spy.calls.length, 1, `应写 1 条，实际 ${spy.calls.length}`);
  assert.deepEqual(spy.calls[0], { projectId: 'proj-1', runId: 'run-9', tokens: 123, modelName: 'deepseek-flash' });
});

check('② 取消的运行（aborted）同样入账 —— 不做 aborted 过滤', () => {
  // 用户实测缺陷原话：「我取消了，但用量没出来」。引擎取消时也带累计 usage 调 onDone，
  // 所以这里显式传 aborted:true，断言仍然写入（函数若将来加了 aborted 过滤，这条会红）。
  const spy = spyRecorder();
  recordChatUsage({ recordUsage: spy.recordUsage, resolveProjectOfConversation: () => 'proj-1' },
    { runId: 'run-10', usage: { prompt_tokens: 40, completion_tokens: 2 }, aborted: true, modelId: '' });
  assert.equal(spy.calls.length, 1, '取消的运行没有入账 → 工作台取消后仍然看不到用量');
  assert.equal(spy.calls[0].tokens, 42);
});

check('③ tokens 合计为 0 / usage 缺失 → 不写（避免台账里出现 0 token 记录）', () => {
  const spy = spyRecorder();
  const deps = { recordUsage: spy.recordUsage, resolveProjectOfConversation: () => 'proj-1' };
  recordChatUsage(deps, { runId: 'r', usage: { prompt_tokens: 0, completion_tokens: 0 } });
  recordChatUsage(deps, { runId: 'r' });
  recordChatUsage(deps, { runId: 'r', usage: null });
  assert.equal(spy.calls.length, 0, `0 token / 无 usage 不应写台账，实际写了 ${spy.calls.length} 条`);
});

check('④ 反查不到项目 → 不写，且不抛', () => {
  const spy = spyRecorder();
  recordChatUsage({ recordUsage: spy.recordUsage, resolveProjectOfConversation: () => null },
    { runId: 'r', usage: { prompt_tokens: 5, completion_tokens: 5 } });
  assert.equal(spy.calls.length, 0, '没有项目归属时不应写台账（否则会挂到错误的项目视图）');
});

check('⑤ recordUsage 抛错 → 被吞掉，不中断收尾链路（否则 done 事件发不出去）', () => {
  const boom = { recordUsage: () => { throw new Error('SQLITE_BUSY'); }, resolveProjectOfConversation: () => 'p' };
  assert.doesNotThrow(
    () => recordChatUsage(boom, { runId: 'r', usage: { prompt_tokens: 5, completion_tokens: 5 } }),
    '回填失败把异常抛出了收尾链路',
  );
});

check('⑥ deps 缺 recordUsage（未经 init 装配）→ 安静跳过，不抛', () => {
  assert.doesNotThrow(() => recordChatUsage({}, { runId: 'r', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  assert.doesNotThrow(() => recordChatUsage(null, { runId: 'r', usage: { prompt_tokens: 1 } }));
});

check('⑦ makeChatUsageDeps：getter 延迟求值 —— 装配时为 null、调用时已就绪仍能写', () => {
  let ledger = null;
  const calls = [];
  const deps = makeChatUsageDeps(() => ledger, () => null);
  assert.equal(deps.recordUsage({ projectId: 'p', runId: 'r', tokens: 7 }), 0, 'ledger 未就绪时应返回 0 而不是抛');
  ledger = { recordChat: (u) => { calls.push(u); return u.tokens; } };
  assert.equal(deps.recordUsage({ projectId: 'p', runId: 'r', tokens: 7 }), 7,
    'ledger 就绪后应真正写入（证明 getter 是延迟求值，不是装配时抓快照）');
  assert.deepEqual(calls, [{ projectId: 'p', runId: 'r', memberId: null, tokens: 7, model: '' }]);
});

check('⑧ makeChatUsageDeps：memberId 恒为 null（单人对话不属于任何成员，否则会挤占成员额度）', () => {
  const calls = [];
  const deps = makeChatUsageDeps(() => ({ recordChat: (u) => { calls.push(u); return u.tokens; } }), () => null);
  deps.recordUsage({ projectId: 'p', runId: 'r', tokens: 3, memberId: 'm-1' });
  assert.equal(calls[0].memberId, null, 'chat 记账不能挂成员，否则 memberUsed 窗口会被单人闲聊占掉');
});

check('⑧b makeChatUsageDeps：modelName 必须透传到记账行（否则流水页模型维度永远「未记录」）', () => {
  // 事故形态（2026-10-29）：chatUsageLedger 一直在传 modelName，而这一层只解构 projectId/runId/tokens，
  // 字段在中间被吃掉——台账 model 列恒空，用户问「flint 烧了多少」在流水页查不到任何记录。
  const calls = [];
  const deps = makeChatUsageDeps(() => ({ recordChat: (u) => { calls.push(u); return u.tokens; } }), () => null);
  deps.recordUsage({ projectId: 'p', runId: 'r', tokens: 5, modelName: '  flint  ' });
  assert.equal(calls[0].model, 'flint', `model 未透传或未 trim：${JSON.stringify(calls[0].model)}`);
  deps.recordUsage({ projectId: 'p', runId: 'r', tokens: 5 });
  assert.equal(calls[1].model, '', '缺 modelName 时应为空串（落库转 NULL），不能编一个模型名');
});

check('⑨ makeChatUsageDeps：projectId 为空 / tokens 非正 → 不写', () => {  const calls = [];
  const deps = makeChatUsageDeps(() => ({ recordChat: (u) => { calls.push(u); return u.tokens; } }), () => null);
  deps.recordUsage({ projectId: '', runId: 'r', tokens: 9 });
  deps.recordUsage({ projectId: 'p', runId: 'r', tokens: 0 });
  deps.recordUsage({});
  deps.recordUsage();
  assert.equal(calls.length, 0, `非法入参不应写台账，实际写了 ${calls.length} 条`);
});

check('⑩ makeChatUsageDeps：项目反查委托 projectStore.resolveProjectId（无 store 时返回 null）', () => {
  const deps = makeChatUsageDeps(() => null, () => null);
  assert.equal(deps.resolveProjectOfConversation(1741, '/tmp/x'), null);
  const seen = [];
  const store = { resolveProjectId: (t, c) => { seen.push([t, c]); return 'proj-42'; } };
  const deps2 = makeChatUsageDeps(() => null, () => store);
  assert.equal(deps2.resolveProjectOfConversation(1741, '/tmp/x'), 'proj-42');
  assert.deepEqual(seen, [[1741, '/tmp/x']], '应把 threadId 与 cwd 原样透传（数字 id 不能先被 String 掉）');
});

check('⑪ makeChatUsageDeps.recordUsage：recordChat 抛错 → 返回 0 且不抛', () => {
  const deps = makeChatUsageDeps(() => ({ recordChat: () => { throw new Error('DB locked'); } }), () => null);
  let out;
  assert.doesNotThrow(() => { out = deps.recordUsage({ projectId: 'p', runId: 'r', tokens: 5 }); });
  assert.equal(out, 0);
});

console.log(`\nchat-usage-ledger: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
