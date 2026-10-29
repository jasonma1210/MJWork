// 工作台用量聚合门禁（2026-10-27）
//
// 为什么这条要进门禁：工作台给出的数字是**用户唯一能看到的用量真相**，
// 而聚合口径错（把 user 消息也算一次请求 / 7 天窗口少一天 / 无数据当成 0）
// 在界面上完全看不出来 —— 只会给出一个"看着合理"的错数字。
// 本套件把「一次请求」「7 桶补零」「未记录 ≠ 0」三条口径钉死。
import assert from 'node:assert';
import {
  aggregateMessages, mergeTaskUsage, fmtTokens, startOfLocalDay, UNMODELED,
} from '../renderer/src/lib/usageAggregate.ts';

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.log(`❌ ${name}\n   ${e.message}`); }
};

// 固定「现在」= 本地时间 2026-10-27 15:00，避免测试随真实时间漂移
const NOW = new Date(2026, 9, 27, 15, 0, 0, 0).getTime();
const DAY = 86400000;
const at = (dayOffset, hour = 12) => new Date(2026, 9, 27 + dayOffset, hour, 0, 0, 0).getTime();

const messages = [
  // user 消息：没有 usage，不计请求、不计 token
  { role: 'user', content: 'hi', threadId: 't1', createdAt: at(0, 9), tokensInput: 0, tokensOutput: 0 },
  { role: 'assistant', threadId: 't1', modelName: 'mimo-v2.6-flash', tokensInput: 1000, tokensOutput: 500, createdAt: at(0, 10) },
  { role: 'assistant', threadId: 't1', modelName: 'mimo-v2.6-flash', tokensInput: 300, tokensOutput: 200, createdAt: at(-1) },
  { role: 'assistant', threadId: 't2', modelName: 'deepseek-v4-flash', tokensInput: 4000, tokensOutput: 1000, createdAt: at(-3) },
  // 老于 7 天：只进累计，不进 last7 / 7 桶
  { role: 'assistant', threadId: 't2', modelName: 'deepseek-v4-flash', tokensInput: 9000, tokensOutput: 1000, createdAt: at(-30) },
  // 没记模型的：归到 UNMODELED，不丢
  { role: 'assistant', threadId: 't3', tokensInput: 100, tokensOutput: 0, createdAt: at(-2) },
];

const threads = [
  { id: 't1', title: '知识库导入排查', modelName: 'mimo-v2.6-flash' },
  { id: 't2', title: '打包体积治理', modelName: 'deepseek-v4-flash' },
  { id: 't3', title: '', modelName: '' },
];

const r = aggregateMessages(messages, threads, NOW, 2);

check('① 只把带 usage 的消息算成一次请求（user 消息不计）', () => {
  assert.equal(r.totals.requests, 5, `requests=${r.totals.requests}`);
  assert.equal(r.totals.input, 1000 + 300 + 4000 + 9000 + 100);
  assert.equal(r.totals.output, 500 + 200 + 1000 + 1000 + 0);
  assert.equal(r.totals.total, r.totals.input + r.totals.output);
});

check('② 今天/近 7 天按本地日切，且与累计互不混淆', () => {
  // 今天：1000+500 = 1500
  assert.equal(r.totals.todayTotal, 1500, `today=${r.totals.todayTotal}`);
  // 近 7 天 = 1500 + 500 + 5000 + 100 = 7100（排除 -30 天那条 10000）
  assert.equal(r.totals.last7Total, 7100, `last7=${r.totals.last7Total}`);
  assert.ok(r.totals.last7Total < r.totals.total, '近 7 天必须小于累计（存在更早的数据）');
});

check('③ 7 天窗口恒为 7 桶并补零（横轴不随数据伸缩）', () => {
  assert.equal(r.byDay.length, 7);
  assert.deepEqual(r.byDay.map((d) => d.label), ['10-21', '10-22', '10-23', '10-24', '10-25', '10-26', '10-27']);
  const zero = r.byDay.filter((d) => d.total === 0).map((d) => d.label);
  assert.deepEqual(zero, ['10-21', '10-22', '10-23'], `应补零的天：${zero.join(',')}`);
  assert.equal(r.byDay[6].total, 1500, '今天那桶');
  assert.equal(r.byDay.reduce((s, d) => s + d.total, 0), r.totals.last7Total, '7 桶合计必须等于近 7 天');
});

check('④ 模型分布：未知模型单列不丢，占比合计为 1', () => {
  const models = r.byModel.map((m) => m.model);
  assert.deepEqual(models, ['deepseek-v4-flash', 'mimo-v2.6-flash', UNMODELED], `实际顺序 ${models}`);
  const sumShare = r.byModel.reduce((s, m) => s + m.share, 0);
  assert.ok(Math.abs(sumShare - 1) < 1e-9, `占比合计 ${sumShare}`);
  const ds = r.byModel.find((m) => m.model === 'deepseek-v4-flash');
  assert.equal(ds.total, 5000 + 10000);
  assert.equal(ds.requests, 2);
});

// ⑤ 的排序口径（2026-10-28 改）：会话消耗是「正在发生什么」的视图，
// 正在执行的会话必须留在最上面。旧口径按 token 降序，会把刷了 15000 token 的
// 老会话顶到第一位，把正在跑的会话压到后面 —— 用户实测反馈「按执行顺序应该在最前面」。
// 因此主序 = 最近执行时间(lastAt)降序，token 只作同时刻的 tie-break。
check('⑤ 会话消耗按最近执行降序（token 仅作 tie-break）且受 topN 限制，标题缺失时回落 threadId', () => {
  // topN 截断发生在排序之后：t2 是 token 大户但最后执行最早（-3 天），被截掉是对的
  assert.equal(r.byThread.length, 2, 'topN=2 却返回了 ' + r.byThread.length);
  const full = aggregateMessages(messages, threads, NOW, 9).byThread;
  // 全序断言：不能只断言首元素（只断言 [0] 时，「中间顺序错」查不出来）
  assert.deepEqual(full.map((x) => x.threadId), ['t1', 't3', 't2'],
    `实际顺序 ${full.map((x) => x.threadId).join(',')}`);
  // 机制断言而非结果断言：逐对校验 lastAt 单调不增，序列整体被倒过来也能红
  for (let i = 1; i < full.length; i += 1) {
    assert.ok(full[i - 1].lastAt >= full[i].lastAt,
      `lastAt 未按降序排列：${full[i - 1].lastAt} < ${full[i].lastAt}`);
  }
  assert.ok(full[0].title, '标题不能为空');
  assert.equal(full.find((x) => x.threadId === 't3').title, 't3', '无标题会话应回落 threadId 而不是空串');
});

check('⑤b 同一执行时刻才用 token 降序 tie-break', () => {
  const same = at(0, 11);
  const tieMsgs = [
    { role: 'assistant', threadId: 'a', tokensInput: 10, tokensOutput: 0, createdAt: same },
    { role: 'assistant', threadId: 'b', tokensInput: 900, tokensOutput: 0, createdAt: same },
  ];
  const tie = aggregateMessages(tieMsgs, [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], NOW, 9);
  assert.deepEqual(tie.byThread.map((x) => x.threadId), ['b', 'a'],
    'lastAt 相同时应由 token 大的排前（否则 tie-break 形同不存在）');
});

check('⑤c 会话模型列以消息真值为准（thread.modelName 过期不覆盖）', () => {
  // 事故形态：建会话时写一次 thread.modelName，之后全仓没有更新入口（无 updateThread），
  // 用户中途换模型 → 这一行的 token 是新模型烧的，模型列却报旧模型，同一行自相矛盾。
  const stale = aggregateMessages(
    [{ role: 'assistant', threadId: 'x', modelName: 'flint', tokensInput: 50, tokensOutput: 0, createdAt: at(0) }],
    [{ id: 'x', title: 'X', modelName: 'deepseek-v4-flash' }],
    NOW, 9,
  ).byThread[0];
  assert.equal(stale.model, 'flint', `过期 thread.modelName 覆盖了消息真值：${stale.model}`);
  // 反向对照：消息全无模型名时才允许用 thread.modelName 兜底（否则新口径会把旧数据抹成空）
  const fallback = aggregateMessages(
    [{ role: 'assistant', threadId: 'y', tokensInput: 50, tokensOutput: 0, createdAt: at(0) }],
    [{ id: 'y', title: 'Y', modelName: 'mimo-v2.6-flash' }],
    NOW, 9,
  ).byThread[0];
  assert.equal(fallback.model, 'mimo-v2.6-flash', `真空兜底失效：${fallback.model}`);
});

check('⑥ 空输入不炸、不编数字', () => {
  const empty = aggregateMessages([], [], NOW);
  assert.deepEqual(empty.totals, { input: 0, output: 0, total: 0, requests: 0, todayTotal: 0, last7Total: 0 });
  assert.deepEqual(empty.byModel, []);
  assert.equal(empty.byThread.length, 0);
  assert.equal(empty.byDay.length, 7, '没数据也要 7 个空桶');
});

check('⑦ 任务消耗：无配额流水必须是「未记录」而不是 0', () => {
  const groups = [
    { groupId: 'g1', goal: '重构导入链路', status: 'done', totalTasks: 3, doneTasks: 3, failedTasks: 0, updatedAt: at(0) },
    { groupId: 'g2', goal: '补测试', status: 'running', totalTasks: 2, doneTasks: 1, failedTasks: 0, updatedAt: at(-1) },
  ];
  const totals = new Map([['task-a', { tokens: 1200, count: 3 }]]);
  const ids = new Map([['g1', ['task-a']], ['g2', ['task-b']]]); // task-b 没有流水
  const rows = mergeTaskUsage(groups, totals, ids, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].groupId, 'g1', '有消耗的必须排前面');
  assert.equal(rows[0].tokens, 1200);
  assert.equal(rows[0].hasTokens, true);
  const g2 = rows.find((x) => x.groupId === 'g2');
  assert.equal(g2.tokens, 0);
  assert.equal(g2.hasTokens, false, '没有流水却 hasTokens=true —— 界面会把「未记录」显示成 0');
  assert.equal(g2.done, 1);
  assert.equal(g2.total, 2);
});

check('⑧ 数字缩写与本地日零点口径', () => {
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1500), '1.5K');
  assert.equal(fmtTokens(2_400_000), '2.4M');
  const t = new Date(2026, 9, 27, 23, 59, 59).getTime();
  const s = startOfLocalDay(t);
  assert.equal(new Date(s).getDate(), 27);
  assert.equal(new Date(s).getHours(), 0);
  assert.equal(t - s < DAY, true, '日窗口必须小于一天');
});

console.log(`\ndashboard-usage: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
