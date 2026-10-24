// M5 / T5-6：对话内团队协同事件流的门禁（§13.5）。
//
// 三层覆盖，缺一层就会漏掉一类真问题：
//   ① 纯投影层（shared/teamStream.mjs）：排序 / 去重 / 未知 kind 回落 / 成员名解析 / 进度统计。
//      这些是「界面显示对不对」的唯一判据，必须在 Node 里直接断言，不经过 React。
//   ② 真实 IPC handler（ipc/teams.js 的 teams:listThreadRuns）：用假 deps 真调一次，
//      验证「普通编排组不进团队卡」「孤儿组跳过」「返回倒序」，以及 deps 缺失时 fail-closed。
//   ③ 接线静态断言：preload 桥、main.js 注入、MessageStream/ChatArea 传参、展开策略、
//      双语 i18n key 齐全、**主进程禁止 require ESM**（Electron 33 = Node 20.18，会 ERR_REQUIRE_ESM）。
//
// 为什么单独盯 ③ 的最后一条：
//   本机 Node 26 下 `require('*.mjs')` 能跑，单测全绿；真机 Electron 却会在启动时把整个
//   teams:* 域打挂。这类「测试宿主与生产宿主行为分叉」的问题只能靠源码反模式断言兜底。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(DESKTOP);

const { projectTeamRuns, taskProgress, memberLabel, normalizeTeamMessage, assembleThreadRuns, budgetInfoOf } =
  await import(path.join(DESKTOP, 'shared/teamStream.mjs'));
const { formatTokens } = await import(path.join(DESKTOP, 'shared/teamTrace.mjs'));
const { kindKey, messageText } = await import(path.join(DESKTOP, 'shared/teamLabels.mjs'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① 纯投影层 ──
const rawRuns = [
  {
    runId: 'run-late', teamId: 'team-1', teamName: '前端组', status: 'running',
    goal: '补齐测试', waves: 2, createdAt: 2000, updatedAt: 5000,
    members: [
      { id: 'm-lead', name: '统筹A', roleKind: 'lead' },
      { id: 'm-dev', name: '开发B', roleKind: 'member', enabled: false },
    ],
    tasks: [
      { taskId: 't1', title: '写单测', status: 'done', ownerMemberId: 'm-dev', resultSummary: '8 个用例' },
      { taskId: 't2', title: '补文档', status: 'running', ownerMemberId: 'm-ghost' },
      { taskId: 't3', title: '清理', status: 'skipped' },
      { taskId: 't4', title: '异常态', status: 'weird' },
    ],
    messages: [
      { id: 'msg-2', seq: 2, kind: 'report', summary: '第二条', fromMemberId: 'm-dev', createdAt: 4000 },
      { id: 'msg-1', seq: 1, kind: 'assign', summary: '第一条', toMemberId: 'm-dev', createdAt: 3000 },
      { id: 'msg-2', seq: 2, kind: 'report', summary: '重复条目', createdAt: 4000 },
      { id: 'msg-3', seq: 3, kind: 'bogus-kind', summary: '未知种类', createdAt: 4500 },
    ],
  },
  {
    runId: 'run-early', teamId: 'team-2', teamName: '', status: '', goal: '', createdAt: 1000,
    members: [], tasks: [], messages: [{ id: 'msg-a', seq: 1, kind: 'system', summary: 'x', createdAt: 1500 }],
  },
  { runId: '', teamId: 'x' },
  null,
];
const cards = projectTeamRuns(rawRuns);

check('投影：无效 run（无 runId / null）被丢弃', cards.length === 2, `cards=${cards.length}`);
check('投影：卡片按建组时间升序（对话从旧到新）',
  cards[0].runId === 'run-early' && cards[1].runId === 'run-late');
check('投影：同毫秒用 runId 兜底排序（确定性）',
  projectTeamRuns([
    { runId: 'b', createdAt: 7 }, { runId: 'a', createdAt: 7 },
  ]).map((c) => c.runId).join(',') === 'a,b');
check('投影：团队名缺失回落 teamId', cards[0].teamName === 'team-2');
check('投影：状态缺失回落 ready', cards[0].status === 'ready');
check('投影：消息按 seq 升序', cards[1].messages.map((m) => m.seq).join(',') === '1,2,3');
check('投影：消息按 id 去重（保留首条）',
  cards[1].messages.length === 3 && cards[1].messages[1].summary === '第二条');
check('投影：未知 kind 回落 system', cards[1].messages[2].kind === 'system');
check('投影：按种类计数', cards[1].counts.byKind.assign === 1
  && cards[1].counts.byKind.report === 1 && cards[1].counts.byKind.system === 1);
check('投影：成员名解析到 ownerName', cards[1].tasks[0].ownerName === '开发B');
check('投影：未知负责人不编造名字（留空 → 界面显示「未认领」）', cards[1].tasks[1].ownerName === '');
check('投影：成员软删保留在快照里（历史可追溯）',
  cards[1].members.find((m) => m.id === 'm-dev').enabled === false);
check('投影：进度 total 含 skipped', cards[1].progress.total === 4);
check('投影：进度分状态统计', cards[1].progress.done === 1 && cards[1].progress.running === 1
  && cards[1].progress.skipped === 1);
check('投影：未知任务状态不污染已知计数',
  cards[1].progress.pending === 0 && cards[1].progress.failed === 0);
check('投影：lastActivityAt 取组更新时间与末条消息的较大值',
  cards[1].lastActivityAt === 5000);
check('投影：waves 透传', cards[1].waves === 2);

check('taskProgress：空/非法输入返回零值', taskProgress(null).total === 0 && taskProgress(undefined).done === 0);
check('memberLabel：找不到回落 id，空 id 返回空串',
  memberLabel(cards[1], 'm-ghost') === 'm-ghost' && memberLabel(cards[1], '') === '');
check('normalizeTeamMessage：seq 非数字归零、refs 丢空值并统一为字符串',
  normalizeTeamMessage({ seq: 'x', refs: ['a', '', null, 3, 'b'] }).seq === 0
  && normalizeTeamMessage({ refs: ['a', '', null, 3, 'b'] }).refs.join(',') === 'a,3,b');

// 共享展示口径（两个消费者共用，防「详情页中文、对话卡裸 key」）
check('kindKey：已知种类映射到 i18n key', kindKey('assign') === 'teams.msgKindAssign');
check('kindKey：未知种类回落 system', kindKey('nope') === 'teams.msgKindSystem');
check('messageText：系统留痕走 payload.sys 翻译并附对象名',
  messageText((k) => `T:${k}`, { payload: { sys: 'teamCreated', name: '前端组' } })
  === 'T:teams.msgSysTeamCreated · 前端组');
check('messageText：非系统消息直接展示 summary',
  messageText((k) => `T:${k}`, { summary: '普通正文' }) === '普通正文');

// ── ② assembleThreadRuns（主进程装配内核，注入假查询即可覆盖分支）──
const groups = [
  { group_id: 'run-a', status: 'done', goal: '目标A', created_at: 100, updated_at: 900,
    result: { summary: '聚合结论A' }, dag: { waves: [{ taskIds: ['t1'] }] } },
  { group_id: 'run-b', status: 'running', goal: '目标B', created_at: 300, updated_at: 400 },
  { group_id: 'plain-group', status: 'done', goal: '普通编排', created_at: 50, updated_at: 60 },
];
const messages = [
  { id: 'm1', runId: 'run-a', teamId: 'team-1', seq: 1, kind: 'assign', summary: '派活A', refs: ['f:1'] },
  { id: 'm2', runId: 'run-b', teamId: 'team-2', seq: 1, kind: 'handoff', summary: '派活B', refs: [] },
  { id: 'm3', runId: 'run-deleted', teamId: 'team-1', seq: 1, kind: 'system', summary: '孤儿', refs: [] },
];
const fakeGroup = (id) => (id === 'run-a'
  ? { ...groups[0], tasks: [{ taskId: 't1', title: '任务1', status: 'done', ownerMemberId: 'm1', result: { summary: '干完了' } }] }
  : id === 'run-b' ? { ...groups[1], tasks: [] }
  : id === 'plain-group' ? {
    ...groups[2],
    tasks: [{ taskId: 'p1', title: '编排任务', status: 'done', result: { summary: '编排完成', artifacts: ['/tmp/a.md'] } }],
  }
  : null);
const fakeTeam = (id) => (id === 'team-2'
  ? { id: 'team-2', name: '后端组', members: [{ id: 'm9', name: '后端A', roleKind: 'member' }] }
  : id === 'team-1' ? { id: 'team-1', name: '前端组', members: [] } : null);

// 活动轨迹（T5-6，2026-10-21）：任务级事件进 task.events，组级事件进 run.events。
const traceEvents = [
  { id: 1, groupId: 'run-a', taskId: 't1', type: 'activity', payload: { kind: 'tool', textKey: 'runtime.workerStart' }, createdAt: 500 },
  { id: 2, groupId: 'run-a', taskId: null, type: 'activity', payload: { kind: 'wave' }, createdAt: 510 },
];

const assembled = assembleThreadRuns({
  groups, messages, events: traceEvents, getGroup: fakeGroup, getTeam: fakeTeam,
});
check('装配：统一显示——普通编排组生成 kind=orchestration 卡',
  assembled.find((r) => r.runId === 'plain-group')?.kind === 'orchestration');
check('装配：普通编排组不编造团队名（渲染层按 i18n 显示「任务编排」）',
  assembled.find((r) => r.runId === 'plain-group')?.teamName === '');
check('装配：团队派活组标记 kind=team',
  assembled.find((r) => r.runId === 'run-a')?.kind === 'team');
check('装配：组已删除的孤儿消息被跳过',
  assembled.every((r) => r.runId !== 'run-deleted'));
check('装配：输出按建组时间倒序（最新在前）',
  assembled.map((r) => r.runId).join(',') === 'run-b,run-a,plain-group');
check('装配：聚合摘要取自 group.result.summary', assembled[1].summary === '聚合结论A');
check('装配：waves 数取自 dag.waves', assembled[1].waves === 1);
check('装配：任务结果摘要映射 result.summary', assembled[1].tasks[0].resultSummary === '干完了');
// 2026-10-22 真机回归：aggregator 产出的结构化摘要数组曾被 String() 成 `[object Object]`。
const structuredSummary = assembleThreadRuns({
  groups: [{ ...groups[0], result: { summary: [{ taskId: 't1', title: '任务1', text: '结论甲' }] } }],
  messages: [],
  getGroup: () => ({
    ...groups[0],
    result: { summary: [{ taskId: 't1', title: '任务1', text: '结论甲' }] },
    tasks: [{
      taskId: 't1', title: '任务1', status: 'done', result: { summary: [{ title: '子项', text: '结论乙' }] },
    }],
  }),
  getTeam: () => null,
});
check('装配：结构化组摘要归一为可读文本（不出现 [object Object]）',
  structuredSummary[0].summary === '任务1：结论甲' && !structuredSummary[0].summary.includes('[object Object]'));
check('装配：任务结构化摘要同样归一',
  structuredSummary[0].tasks[0].resultSummary === '子项：结论乙');
check('装配：任务产物路径从 result.artifacts 透传',
  assembled[2].tasks[0].artifacts.join(',') === '/tmp/a.md');
check('装配：任务级轨迹进 task.events（按 taskId 过滤）',
  assembled[1].tasks[0].events.length === 1 && assembled[1].tasks[0].events[0].id === 1);
check('装配：组级轨迹（无 taskId）进 run.events', assembled[1].events.length === 1
  && assembled[1].events[0].id === 2);
check('装配：团队成员快照随卡下发', assembled[0].members[0].name === '后端A');
// 统一显示后：团队被删的历史 run 仍保留为 orchestration（可追溯、不出现点开即空的孤儿卡）
check('装配：团队已删除 → 保留为 orchestration',
  (() => {
    const r = assembleThreadRuns({
      groups: [groups[1]], messages: [messages[1]],
      getGroup: () => ({ ...groups[1], tasks: [] }), getTeam: () => null,
    });
    return r.length === 1 && r[0].kind === 'orchestration';
  })());
check('装配：空输入安全返回空数组',
  assembleThreadRuns({ groups: [], messages: [], getGroup: () => null, getTeam: () => null }).length === 0);

// ── ②b 预算可视化（2026-10-21 用户需求）──
// 上限来自 dag.runMeta.budget（计划快照），用量来自任务结果 + 主进程内存账本（取大者）。
check('预算：无 runMeta.budget 返回 null（普通编排组不画假预算条）',
  budgetInfoOf({ dag: {} }, null) === null && budgetInfoOf(null, { tokens: 1 }) === null);
const budgetFull = {
  dag: { runMeta: { budget: { max_tokens: 100000, max_rounds: 8, max_wall_ms: 1000 } } },
  tasks: [
    { taskId: 'b1', status: 'done', result: { tokensUsed: 30000 } },
    { taskId: 'b2', status: 'running', result: null },
    { taskId: 'b3', status: 'done', result: { tokensUsed: 20000 } },
  ],
};
const bv = budgetInfoOf(budgetFull, null);
check('预算：用量按任务已结算汇总（运行中任务不贡献）', bv.usedTokens === 50000 && bv.byTask.b1 === 30000);
check('预算：剩余量 / 百分比 / 上限透传',
  bv.remainingTokens === 50000 && bv.percent === 50 && bv.maxRounds === 8 && bv.maxWallMs === 1000);
check('预算：内存账本更大时以账本为准（含在途结算）',
  budgetInfoOf(budgetFull, { tokens: 90000 }).usedTokens === 90000);
check('预算：用量超出上限时百分比夹到 100（软上限不画超 100%）',
  budgetInfoOf(budgetFull, { tokens: 150000 }).percent === 100
  && budgetInfoOf(budgetFull, { tokens: 150000 }).remainingTokens === 0);
check('预算：非法上限归零且不产生 NaN', (() => {
  const r = budgetInfoOf({ dag: { runMeta: { budget: { max_tokens: 'x' } } }, tasks: [] }, null);
  return r.maxTokens === 0 && r.percent === 0 && Number.isFinite(r.usedTokens) && Number.isFinite(r.percent);
})());

const budgetRun = assembleThreadRuns({
  groups: [{ group_id: 'run-budget', status: 'running', created_at: 1 }],
  messages: [],
  getGroup: () => budgetFull,
  getTeam: () => null,
  getBudgetLive: () => ({ tokens: 60000, elapsedMs: 1234 }),
});
check('装配：预算随 run 下发（实时账本优先于已结算）',
  budgetRun[0].budget.usedTokens === 60000 && budgetRun[0].budget.elapsedMs === 1234);
check('装配：任务级 tokensUsed 透传（看板按任务显示消耗）',
  budgetRun[0].tasks[0].tokensUsed === 30000 && budgetRun[0].tasks[1].tokensUsed === 0);
check('装配：无预算组 budget 为 null', (() => {
  const r = assembleThreadRuns({
    groups: [{ group_id: 'run-nobudget', status: 'done', created_at: 1 }],
    messages: [], getGroup: () => ({ dag: {}, tasks: [] }), getTeam: () => null,
  });
  return r[0].budget === null;
})());

const projectedBudget = projectTeamRuns([{
  runId: 'r-budget', createdAt: 1,
  budget: { maxTokens: 100000, usedTokens: 50000, remainingTokens: 50000, percent: 50 },
  tasks: [{ taskId: 't1', status: 'done', tokensUsed: 12345 }],
}, { runId: 'r-none', createdAt: 2 }]);
check('投影：预算透传并归一为数字',
  projectedBudget[0].budget.maxTokens === 100000 && projectedBudget[0].budget.percent === 50);
check('投影：任务 tokensUsed 归一', projectedBudget[0].tasks[0].tokensUsed === 12345);
check('投影：无预算 → null（界面不渲染预算条）', projectedBudget[1].budget === null);
check('格式化：token 紧凑显示用 k/M（语言无关）',
  formatTokens(999) === '999' && formatTokens(8655) === '8.7k' && formatTokens(1500000) === '1.5M');

// ── ③ 真实 IPC handler（假 deps 真调一次，漏注入即 TypeError）──
// electron stub：只捕获 ipcMain.handle 注册的处理器（与 tasks-ipc-wiring 同款）
const handlers = new Map();
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
require.cache[electronPath] = stubModule;

const teamsIpc = require(path.join(DESKTOP, 'main/ipc/teams.js'));
const calls = { groupsByThread: [], messagesByRuns: [] };
const fakeTeamStore = {
  listMessagesByRuns: (ids, opts) => {
    calls.messagesByRuns.push({ ids, opts });
    return messages.filter((m) => ids.includes(m.runId));
  },
  getTeam: fakeTeam,
};
const fakeTaskStore = {
  listGroupsByThread: (threadId, opts) => {
    calls.groupsByThread.push({ threadId, opts });
    return groups;
  },
  getGroup: fakeGroup,
  listEventsByGroup: (groupId, opts) => traceEvents.filter((e) => e.groupId === groupId
    && (!opts?.limit || opts.limit > 0)),
};
teamsIpc.initTeamsIpc({ getTeamStore: () => fakeTeamStore, getTaskStore: () => fakeTaskStore });
const handler = handlers.get('teams:listThreadRuns');

check('IPC：teams:listThreadRuns 已注册', typeof handler === 'function');

const emptyPayloadR = await handler({}, {});
check('IPC：无 threadId 直接返回空（不查库）',
  emptyPayloadR.ok === true && emptyPayloadR.runs.length === 0 && calls.groupsByThread.length === 0);

const okR = await handler({}, { threadId: 'thread-1' });
check('IPC：按 threadId 反查任务组', calls.groupsByThread[0]?.threadId === 'thread-1');
check('IPC：只取本会话的任务组 id 批量读消息',
  calls.messagesByRuns[0]?.ids.join(',') === 'run-a,run-b,plain-group');
check('IPC：返回投影后的统一 run（团队 + 普通编排，孤儿仍过滤）',
  okR.ok === true && okR.runs.map((r) => r.runId).join(',') === 'run-b,run-a,plain-group');
check('IPC：run 携带成员与任务（渲染层无需二次查询）',
  okR.runs[1].tasks[0].taskId === 't1' && okR.runs[0].members[0].id === 'm9');
check('IPC：run 携带活动轨迹（task_events 批量读取）',
  okR.runs[1].tasks[0].events.length === 1 && okR.runs[1].events.length === 1);

teamsIpc.initTeamsIpc({ getTeamStore: () => fakeTeamStore });
const unavailableR = await handlers.get('teams:listThreadRuns')({}, { threadId: 't' });
check('IPC：缺 getTaskStore 时 fail-closed（ok=false，不抛）',
  unavailableR.ok === false && unavailableR.runs.length === 0);

// ── ④ 接线静态断言 ──
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
const preloadSrc = read('main/preload.js');
const mainSrc = read('main/main.js');
const ipcTeamsSrc = read('main/ipc/teams.js');
const messageStreamSrc = read('renderer/src/components/MessageStream.tsx');
const chatAreaSrc = read('renderer/src/components/ChatArea.jsx');
const teamRunStreamSrc = read('renderer/src/components/TeamRunStream.tsx');

check('接线：preload 暴露 teamsListThreadRuns 桥',
  /teamsListThreadRuns:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\('teams:listThreadRuns'/.test(preloadSrc));
check('接线：main.js 给 initTeamsIpc 注入 getTaskStore',
  /initTeamsIpc\(\{[\s\S]*?getTaskStore:\s*\(\)\s*=>\s*taskStore/.test(mainSrc));
check('接线：MessageStream 渲染 TeamRunStream 并传 threadId',
  /import TeamRunStream from '\.\/TeamRunStream'/.test(messageStreamSrc)
  && /<TeamRunStream threadId=\{threadId\}/.test(messageStreamSrc));
check('接线：ChatArea 向 MessageStream 传会话 id',
  /<MessageStream[\s\S]*?threadId=\{thread\?\.id/.test(chatAreaSrc));
// 展开策略（2026-10-22 真机反馈修订）：终态卡片一律折叠会让用户看到「5/5 已完成」却看不到结果。
// 现行口径 = 最新一次 run 始终默认展开（含 done/failed），历史卡片折叠。
check('UI：最新一次 run 始终默认展开（含终态），历史折叠',
  /<details[\s\S]{0,200}open=\{open\}/.test(teamRunStreamSrc)
  && /useState\(defaultOpen\)/.test(teamRunStreamSrc)
  && /defaultOpen=\{card\.runId === latestId\}/.test(teamRunStreamSrc));
check('UI：终态 run 展示「最终交付」摘要区（不藏在任务行里）',
  /streamFinalResult[\s\S]{0,200}card\.summary/.test(teamRunStreamSrc));
check('UI：展开态才渲染任务轨迹与协同消息',
  /<\/summary>[\s\S]*streamTasks[\s\S]*streamMessages/.test(teamRunStreamSrc));
// 2026-10-21 真机反馈：任务只显示「执行中」，看不到成员到底做了什么；
// 且引用/产物只是纯文本，无法点开。现在任务行本身可展开（TaskRow），轨迹与产物可点击。
check('UI：任务行可展开查看处理轨迹（TaskRow + task_events 渲染）',
  /function TaskRow\(/.test(teamRunStreamSrc)
  && /streamTaskTrace/.test(teamRunStreamSrc)
  && /events\.map\(/.test(teamRunStreamSrc)
  && /taskEventText\(/.test(teamRunStreamSrc));
check('UI：引用/产物可点击打开（onOpenFile 透传到 TeamRunStream）',
  /<TeamRunStream threadId=\{threadId\} onOpenFile=\{onOpenFile\}/.test(messageStreamSrc)
  && /function PathChip\(/.test(teamRunStreamSrc)
  && /onClick=\{\(\) => onOpenFile\(path\)\}/.test(teamRunStreamSrc));
check('UI：普通编排卡显示「任务编排」而非团队名',
  /teams\.streamKindOrchestration/.test(teamRunStreamSrc));

// 2026-10-20 真机事故回归：Composer 的发送按钮是 onSend() 无参调用，sendOrDispatch 若只读 text
// 会在选了军团后 goal='' 静默 return；且新会话 thread 为 null 时建组 thread_id 为空，
// 团队卡按会话反查永远查不到 → 用户看到「点了没反应 / 只有一句已派活」。
// 2026-10-24 双入口重组（设计文档 §9 P0-6）：派活执行体从 ChatArea 抽到 lib/teamDispatchFlow.ts
// （ChatArea 触 800 行黄线）。断言锚点随实现迁移，强度不降——并且新增「落库必须先于派活」的
// 顺序断言（原先只查存在性，顺序被调换也发现不了）。
const dispatchFlowSrc = read('renderer/src/lib/teamDispatchFlow.ts');
check('派活：无参发送回落输入框，且派活前先落库会话与目标消息',
  /const goal = String\(text \|\| input \|\| ''\)\.trim\(\)/.test(chatAreaSrc)
  && /let runThreadId = input\.threadId/.test(dispatchFlowSrc)
  && /ports\.createThread\(\{/.test(dispatchFlowSrc)
  && /ports\.sendMessage\(runThreadId/.test(dispatchFlowSrc)
  && dispatchFlowSrc.indexOf('ports.sendMessage(runThreadId') < dispatchFlowSrc.indexOf('ports.dispatch({'));
check('派活：传给主进程的 threadId 必须是落库后的 runThreadId',
  /threadId: runThreadId/.test(dispatchFlowSrc)
  && !/threadId: input\.threadId/.test(dispatchFlowSrc));

// 主进程禁止 require ESM（真机 Electron 33 / Node 20.18 会 ERR_REQUIRE_ESM）
// 断言前先剥掉注释：本文件的说明注释里会引用这个反模式写法，扫原文会误判。
const ipcTeamsCode = ipcTeamsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('安全：ipc/teams.js 不得 require shared/*.mjs（改用动态 import）',
  !/require\(['"][^'"]*shared\/[^'"]*\.mjs['"]\)/.test(ipcTeamsCode)
  && /import\(['"][^'"]*shared\/teamStream\.mjs['"]\)/.test(ipcTeamsCode));

// 双语 i18n key 齐全：组件里出现的每个 teams.stream* / agentDock.groupStatus* 都必须在两个语言包中存在
const zh = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer/src/i18n/locales/zh-CN/teams.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer/src/i18n/locales/en-US/teams.json'), 'utf8'));
const agentDockZh = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer/src/i18n/locales/zh-CN/agentDock.json'), 'utf8'));
const agentDockEn = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer/src/i18n/locales/en-US/agentDock.json'), 'utf8'));
const usedKeys = [...new Set([...teamRunStreamSrc.matchAll(/'(teams\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]))];
const missingZh = usedKeys.filter((k) => !(k.split('.')[1] in zh));
const missingEn = usedKeys.filter((k) => !(k.split('.')[1] in en));
check('i18n：TeamRunStream 引用的 teams.* key 在中文包齐全',
  missingZh.length === 0, missingZh.join(','));
check('i18n：TeamRunStream 引用的 teams.* key 在英文包齐全',
  missingEn.length === 0, missingEn.join(','));
const groupStatusKeys = [...new Set([...teamRunStreamSrc.matchAll(/'(agentDock\.groupStatus[A-Za-z]+)'/g)].map((m) => m[1]))];
check('i18n：复用的 agentDock.groupStatus* 双语齐全',
  groupStatusKeys.length > 0
  && groupStatusKeys.every((k) => k.split('.')[1] in agentDockZh && k.split('.')[1] in agentDockEn));

// 预算可视化（2026-10-21）：两处界面共用同一组 key，漏一个语言包就会出现裸 key。
const teamBoardSrc = read('renderer/src/components/TeamBoard.tsx');
const boardKeys = [...new Set([...teamBoardSrc.matchAll(/'(teams\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]))];
check('i18n：TeamBoard 引用的 teams.* key 双语齐全',
  boardKeys.length > 0 && boardKeys.every((k) => k.split('.')[1] in zh && k.split('.')[1] in en),
  boardKeys.filter((k) => !(k.split('.')[1] in zh) || !(k.split('.')[1] in en)).join(','));
check('UI：预算条同时出现在对话卡与看板（折叠态也给已用/上限）',
  /budgetLabel/.test(teamRunStreamSrc) && /budgetLabel/.test(teamBoardSrc)
  && /budgetUsed/.test(teamBoardSrc) && /formatTokens/.test(teamBoardSrc)
  && /formatTokens/.test(teamRunStreamSrc));

// ── ⑤ 存储层读入口（sql.js，真库）──
const os = await import('node:os');
const { openDbAsync } = require(path.join(DESKTOP, 'main/db'));
const { TeamStore } = require(path.join(DESKTOP, 'main/teamStore.js'));
const { TaskStore } = require(path.join(DESKTOP, 'main/taskStore.js'));

const dir = fs.mkdtempSync(path.join(os.default.tmpdir(), 'mjcode-t6-'));
const db = await openDbAsync(dir, { driver: 'sqljs' });
const teamStore = new TeamStore(db);
const taskStore = new TaskStore(db);

const team = teamStore.createTeam({ name: '流测试组', description: 'd' });
teamStore.appendMessage({ teamId: team.id, runId: 'r1', kind: 'assign', summary: 'a1' });
teamStore.appendMessage({ teamId: team.id, runId: 'r2', kind: 'report', summary: 'b1' });
teamStore.appendMessage({ teamId: team.id, runId: 'r1', kind: 'handoff', summary: 'a2' });

const batch = teamStore.listMessagesByRuns(['r1', 'r2', 'r1'], { limit: 100 });
check('存储：listMessagesByRuns 批量取回两个 run 的消息', batch.length === 3);
check('存储：批量读取仍按 seq 升序', batch.map((m) => m.seq).join(',') === '1,2,3');
check('存储：runIds 去重且空输入返回空', teamStore.listMessagesByRuns([]).length === 0
  && teamStore.listMessagesByRuns(['  ', null]).length === 0);
check('存储：limit 生效（上限仍按 seq 升序取前 N 条）',
  teamStore.listMessagesByRuns(['r1', 'r2'], { limit: 1 }).length === 1);

taskStore.createGroup({ groupId: 'g1', goal: '本会话', cwd: '/tmp', threadId: 'th-1', tasks: [{ id: 't1', title: 'x', prompt: 'p' }] });
taskStore.createGroup({ groupId: 'g2', goal: '另一个会话', cwd: '/tmp', threadId: 'th-2', tasks: [] });
taskStore.createGroup({ groupId: 'g3', goal: '无会话', cwd: '/tmp', tasks: [] });
const byThread = taskStore.listGroupsByThread('th-1');
check('存储：listGroupsByThread 只返回本会话的组',
  byThread.length === 1 && byThread[0].group_id === 'g1');
check('存储：空 threadId 返回空（不返回全局组）',
  taskStore.listGroupsByThread('').length === 0 && taskStore.listGroupsByThread(null).length === 0);
check('存储：返回结构含 dag/result 解析（tasks 由 getGroup 按需补，避免 N+1）',
  'dag' in byThread[0] && 'result' in byThread[0] && !Array.isArray(byThread[0].tasks));

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} team-stream：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
