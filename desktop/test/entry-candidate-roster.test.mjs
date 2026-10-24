// 候选编制（candidate roster）与派活分流门禁（设计文档 §7.2 / §9 P0-6）
//
// 守护什么（这是本批**最核心的交互变更**，影响面按设计文档记为「大」）：
//   ① **编制是偏好，不是模式开关**：选中军团不得再「强制走派活、把普通对话挡掉」
//      —— 旧实现是 `sendOrDispatch` 里 `if (!activeTeam || opts) { send(...); return; }`，
//      即「选了军团就不能再普通问一句」，属于**入口分支在 gate 能力**（架构不变量禁止）。
//   ② **显式派活**仍是既有 `teams:dispatch` 的**同一调用形态**（不新增派活通道），
//      且用户提问必须**先落库再派活**（否则刷新后只剩卡片、没有提问）。
//   ③ 临时组队（一次性编制）**不落 teams 表**：只产出内存态 roster 快照。
//
// 断言范式纪律（设计文档 §9 P1-8）：**行为断言**——直接 import 纯函数/纯流程模块，
// 用注入的假端口记录调用序列与载荷，断言真实行为；**不以源码正则为主判据**。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); process.exitCode = 1; }
};

const roster = await import('../renderer/src/lib/candidateRoster.ts');
const { runTeamDispatch } = await import('../renderer/src/lib/teamDispatchFlow.ts');

// 假 t()：把 key + 参数原样串起来，便于断言「用的是哪个文案键」
const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

// 假端口工厂：记录每次调用的顺序与载荷（顺序断言是「先落库再派活」的唯一可靠判据）
function makePorts(overrides = {}) {
  const calls = [];
  const ports = {
    createProject: async (p) => { calls.push(['createProject', p]); return { ok: true, path: '/tmp/auto-task', name: 'auto-task' }; },
    createThread: async (p) => { calls.push(['createThread', p]); return { id: 'th-new' }; },
    sendMessage: async (id, m) => { calls.push(['sendMessage', { id, m }]); return { ok: true }; },
    dispatch: async (p) => { calls.push(['dispatch', p]); return { ok: true, tasks: 3, runId: 'run-1' }; },
    debugAppend: (e) => { calls.push(['debugAppend', e]); },
    ...overrides,
  };
  return { calls, ports };
}

const order = (calls) => calls.map((c) => c[0]);

// ── A. 候选编制数据模型（纯函数）──

await check('A1 rosterFromTeam：成员数按 enabled 过滤，来源标记为 team', () => {
  const r = roster.rosterFromTeam({
    id: 'team-1', name: '前端交付组', description: '交付前端',
    members: [{ id: 'm1', enabled: true }, { id: 'm2', enabled: false }, { id: 'm3' }],
    leadMissing: true,
    budget: { max_tokens: 256000, max_rounds: 8 },
  });
  assert.equal(r.kind, 'team');
  assert.equal(r.teamId, 'team-1');
  assert.equal(r.name, '前端交付组');
  assert.equal(r.memberCount, 2, '应当只数在册成员（enabled !== false）');
  assert.equal(r.leadMissing, true);
  assert.equal(r.budget.max_tokens, 256000);
});

await check('A2 rosterFromTeam：主进程下发的 memberCount 优先于本地计数（单一事实来源）', () => {
  const r = roster.rosterFromTeam({ id: 't', name: 'n', memberCount: 7, members: [{ id: 'm1' }] });
  assert.equal(r.memberCount, 7);
});

await check('A3 tempRosterFromEmployees：一次性编制不落 teams 表（teamId=null，来源=template）', () => {
  const r = roster.tempRosterFromEmployees([{ id: 'emp-1', title_cn: '研究员' }, { id: 'emp-2', name: 'writer' }]);
  assert.equal(r.kind, 'temp');
  assert.equal(r.teamId, null, '临时编制不得带 teamId（它就是「不落库」的判据）');
  assert.equal(r.memberCount, 2);
  assert.deepEqual(r.members.map((m) => m.id), ['emp-1', 'emp-2']);
  assert.ok(r.members.every((m) => m.source === 'template' && m.templateRef === m.id), '目录成员必须带 templateRef');
  assert.equal(r.members[0].name, '研究员');
});

await check('A4 setCandidateRoster / getCandidateRoster / subscribe：单一事实源可读可订阅可退订', () => {
  const seen = [];
  const off = roster.subscribeCandidateRoster((r) => seen.push(r));
  const team = roster.rosterFromTeam({ id: 'x', name: 'X', memberCount: 1 });
  roster.setCandidateRoster(team);
  assert.equal(roster.getCandidateRoster(), team);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], team);
  off();
  roster.setCandidateRoster(null);
  assert.equal(seen.length, 1, '退订后不应再收到通知');
  assert.equal(roster.getCandidateRoster(), null);
});

// ── B. 派活执行器（runTeamDispatch）：既有 teams:dispatch 调用形态不能破 ──

const BASE_INPUT = {
  teamId: 'team-1',
  goal: '补齐订单模块单测并输出覆盖率报告',
  threadId: 'th-1',
  cwd: '/proj',
  projectPath: '/proj',
  projectPicked: true,
  model: { provider: { id: 'p1', name: 'P' }, model: { id: 'm1', model_id: 'model-x' } },
  t,
};

await check('B1 既有会话：dispatch 载荷键集恰为 teamId/goal/threadId/projectPath（调用形态不变）', async () => {
  const { calls, ports } = makePorts();
  const out = await runTeamDispatch({ ...BASE_INPUT, ports });
  assert.deepEqual(out, { status: 'ok', tasks: 3 });
  const d = calls.find((c) => c[0] === 'dispatch');
  assert.ok(d, '未调用 dispatch');
  assert.deepEqual(Object.keys(d[1]).sort(), ['goal', 'projectPath', 'teamId', 'threadId'].sort(),
    `dispatch 载荷键集漂移（既有 teams:dispatch 契约被改）：${Object.keys(d[1]).join(',')}`);
  assert.equal(d[1].teamId, 'team-1');
  assert.equal(d[1].threadId, 'th-1');
  assert.equal(d[1].projectPath, '/proj');
});

await check('B2 顺序纪律：用户消息必须先落库，再派活（否则刷新后只剩卡片没有提问）', async () => {
  const { calls, ports } = makePorts();
  await runTeamDispatch({ ...BASE_INPUT, ports });
  const seq = order(calls);
  const iMsg = seq.indexOf('sendMessage');
  const iDispatch = seq.indexOf('dispatch');
  assert.ok(iMsg >= 0 && iDispatch >= 0, `缺少调用：${seq.join(' > ')}`);
  assert.ok(iMsg < iDispatch, `派活在落库之前：${seq.join(' > ')}`);
  const sent = calls[iMsg][1];
  assert.equal(sent.id, 'th-1', '用户消息落到了错误的会话');
  assert.equal(sent.m.role, 'user');
  assert.equal(sent.m.content, BASE_INPUT.goal);
});

await check('B3 既有会话：不新建会话，只就地补一条用户气泡', async () => {
  const { calls, ports } = makePorts();
  const bubbles = [];
  await runTeamDispatch({ ...BASE_INPUT, ports, hooks: { onExistingThreadUserMessage: (c) => bubbles.push(c) } });
  assert.ok(!order(calls).includes('createThread'), '既有会话不应再建会话');
  assert.deepEqual(bubbles, [BASE_INPUT.goal]);
});

await check('B4 新会话 + 未主动选目录：先自建时间戳目录，派活落到新目录（不落旧项目）', async () => {
  const { calls, ports } = makePorts();
  const autoProjects = [];
  const created = [];
  const out = await runTeamDispatch({
    ...BASE_INPUT, threadId: null, projectPicked: false, projectPath: '/stale-project',
    ports,
    hooks: { onAutoProject: (p) => autoProjects.push(p), onThreadCreated: (x) => created.push(x) },
  });
  assert.equal(out.status, 'ok');
  const seq = order(calls);
  assert.deepEqual(seq.slice(0, 3), ['createProject', 'createThread', 'sendMessage'], `前置顺序错：${seq.join(' > ')}`);
  assert.equal(autoProjects.length, 1);
  assert.equal(autoProjects[0].path, '/tmp/auto-task');
  assert.equal(created[0].id, 'th-new');
  const d = calls.find((c) => c[0] === 'dispatch')[1];
  assert.equal(d.projectPath, '/tmp/auto-task', '派活目录必须用新自建目录，不能回落旧项目');
  assert.equal(d.threadId, 'th-new');
});

await check('B5 建目录失败 ⇒ 阻断派活（不回落旧目录），返回 blocked 且 dispatch 从未被调用', async () => {
  const { calls, ports } = makePorts({ createProject: async () => ({ ok: false, error: 'disk full' }) });
  const out = await runTeamDispatch({ ...BASE_INPUT, threadId: null, projectPicked: false, ports });
  assert.equal(out.status, 'blocked');
  assert.match(out.error, /runtime\.taskDirCreateFailed/);
  assert.ok(!order(calls).includes('dispatch'), '建目录失败时仍然派活了（会写错工作区）');
});

await check('B6 建会话失败 ⇒ 阻断派活，返回 blocked 且 dispatch 从未被调用', async () => {
  const { calls, ports } = makePorts({ createThread: async () => { throw new Error('db locked'); } });
  const out = await runTeamDispatch({ ...BASE_INPUT, threadId: null, ports });
  assert.equal(out.status, 'blocked');
  assert.match(out.error, /runtime\.threadCreateFailed/);
  assert.ok(!order(calls).includes('dispatch'));
});

await check('B7 服务端 LEAD_MISSING ⇒ lead_missing（本地预检之外的权威判据）', async () => {
  const { ports } = makePorts({ dispatch: async () => ({ ok: false, code: 'LEAD_MISSING', error: '缺统筹' }) });
  const out = await runTeamDispatch({ ...BASE_INPUT, ports });
  assert.deepEqual(out, { status: 'lead_missing' });
});

await check('B8 服务端其它失败 ⇒ failed，error 用 teams.dispatchFailed 文案键', async () => {
  const { ports } = makePorts({ dispatch: async () => ({ ok: false, error: 'boom' }) });
  const out = await runTeamDispatch({ ...BASE_INPUT, ports });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /^teams\.dispatchFailed/);
  assert.match(out.error, /boom/);
});

await check('B9 抛异常不吞：返回 failed 且带可读 message（不静默 succeed）', async () => {
  const { ports } = makePorts({ dispatch: async () => { throw new Error('ipc broken'); } });
  const out = await runTeamDispatch({ ...BASE_INPUT, ports });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /ipc broken/);
});

await check('B10 调试事实流：click 与 result 两条都记录（排障时间线完整）', async () => {
  const { calls, ports } = makePorts();
  await runTeamDispatch({ ...BASE_INPUT, ports });
  const actions = calls.filter((c) => c[0] === 'debugAppend').map((c) => c[1].action);
  assert.deepEqual(actions, ['team_dispatch_click', 'team_dispatch_result']);
  const click = calls.find((c) => c[0] === 'debugAppend' && c[1].action === 'team_dispatch_click')[1];
  assert.equal(click.detail.teamId, 'team-1');
  assert.equal(click.detail.goalLength, BASE_INPUT.goal.length);
});

// ── C. 分流语义的连线检查（结构性事实，用源码形态；语义判据在 A/B）──

await check('C1 ChatArea.sendOrDispatch 不再「选中编制就 return」（普通对话必须仍可发起）', () => {
  const chat = read('components/ChatArea.jsx');
  const i = chat.indexOf('async function sendOrDispatch');
  assert.ok(i > 0, '找不到 sendOrDispatch');
  const seg = chat.slice(i, i + 900);
  assert.ok(!/if\s*\(\s*!activeTeam/.test(seg), '仍是「选中军团 ⇒ 强制派活」的旧判据');
  assert.ok(/send\(text, forcedThread, opts\)/.test(seg), 'sendOrDispatch 未回落普通 send');
  assert.ok(/setRecallQuery\(goal\)/.test(seg), 'sendOrDispatch 未把本轮 query 交给召回（T-09）');
  assert.ok(/setRecallTick/.test(seg), 'sendOrDispatch 未触发按轮次刷新召回（T-08）');
});

await check('C2 派活是显式动作：ChatArea 有独立的 dispatchToTeam，且只由编制面板的「立即派活」触发', () => {
  const chat = read('components/ChatArea.jsx');
  assert.ok(/async function dispatchToTeam\(team, goalText\)/.test(chat), '缺少显式派活入口 dispatchToTeam');
  const panel = read('components/TeamDispatchPanel.tsx');
  assert.match(panel, /onSelectTeam\?\.\(team, \{ dispatch: true, goal: g \}\)/, '面板的「立即派活」未以 dispatch:true 交出意图');
  assert.match(panel, /rosterDispatchNow/, '面板缺少「立即派活」按钮文案');
});

await check('C3 记忆召回两修接线：localListMemories 传 query，且依赖含轮次信号', () => {
  const chat = read('components/ChatArea.jsx');
  const i = chat.indexOf('localListMemories({');
  assert.ok(i > 0, '找不到召回调用');
  assert.ok(/query:\s*recallQuery/.test(chat.slice(i, i + 400)), 'localListMemories 未传 query（相关性因子 0.40 会被跳过）');
  assert.match(chat, /\}, \[project\?\.path, thread\?\.id, recallQuery, recallTick\]\)/, '召回 effect 依赖未纳入 query/轮次信号');
});

await check('C4 临时组队不落库：面板只产出内存 roster，不调用 teams:create / teams:recruit', () => {
  const panel = read('components/TeamDispatchPanel.tsx');
  const i = panel.indexOf('function applyTempRoster');
  assert.ok(i > 0, '找不到 applyTempRoster');
  const seg = panel.slice(i, i + 400);
  assert.ok(!/teamsCreate/.test(seg) && !/teamsRecruit/.test(seg), '临时组队不应写 teams 表');
  assert.ok(/tempRosterFromEmployees\(chosen\)/.test(seg), '临时组队未走一次性 roster 构造器');
});

console.log(`\nentry-candidate-roster: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
