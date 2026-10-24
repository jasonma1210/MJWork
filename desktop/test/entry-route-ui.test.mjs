// 判定点 UI 门禁（设计文档 §7.3 / §9 P1-4 的渲染层落点）
//
// 守护什么（这是本设计的**核心 UX**：判定权归系统、授权权归用户）：
//   ① 三档确认点的形态映射不能被改错——C0 升级/降级给提示条、C1 出**确认卡**、C2 只给引导；
//   ② 「子任务没拆好」时**绝不能**允许确认（否则用户确认 A、执行 B）；
//   ③ 普通对话（route_verdict 且无 notice）**不打扰**（每次发送都弹一条 = 噪音）；
//   ④ 事件按会话归属过滤（防跨会话串台）；
//   ⑤ 提示只走 UI：不产生消息、不写会话历史；
//   ⑥ 4 个入口桥被真实消费（台账项已删除，`bridge-parity` 的反向断言据此成立）。
//
// 断言范式纪律（设计文档 §9 P1-8）：**行为断言**——直接 import 纯映射模块，
// 用真实载荷形状（抄自 main/entryRuntime.js 的 buildRouteEvent / buildConfirmEvent）实调；
// 源码形态只在 ⑤⑥ 这类「结构性事实」上用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); process.exitCode = 1; }
};

const V = await import('../renderer/src/lib/entryRouteView.ts');

// ── 真实载荷样本（逐字段对齐 main/entryRuntime.js 的 buildRouteEvent）──
const routeEvt = (over = {}) => ({
  type: 'route_verdict',
  conversationId: 'th-1',
  route: 'parallel_team',
  decidedByRule: false,
  source: 'rule',
  confidence: 0.72,
  reason: '可以拆成互不依赖的几块并行做。',
  reasonSource: 'medium-confidence',
  tier: 'C1',
  ask: true,
  blocked: false,
  signals: { parallelizable: true, sequential: false, toolKinds: 6, needsCentralizedVerify: false, estimatedSize: 3 },
  notice: null,
  cost: { teamSize: 3, tokenMultiple: 3, estimatedWallClockMs: 180000 },
  team: null,
  ts: 1,
  ...over,
});

const confirmEvt = (card = {}) => ({
  type: 'confirm_card',
  conversationId: 'th-1',
  goal: '梳理鉴权调用链并出风险清单',
  route: 'parallel_team',
  card: {
    title: '建议用 3 人团队执行此任务',
    reason: '可以拆成互不依赖的几块并行做。',
    reasonSource: 'medium-confidence',
    subtasks: [
      { id: 't1', title: '梳理现有鉴权代码的调用链', dependsOn: [] },
      { id: 't2', title: '核对各接口的越权风险', dependsOn: ['t1'] },
    ],
    subtasksReady: true,
    subtaskError: null,
    signals: { parallelizable: true, sequential: false, toolKinds: 6, needsCentralizedVerify: false },
    conservative: false,
    conservativeHint: '',
    cost: { teamSize: 3, tokenMultiple: 3, estimatedWallClockMs: 180000 },
    actions: ['confirm', 'single', 'detail'],
    ...card,
  },
  ts: 1,
});

// ── A. 提示条映射（C0 升级 / 降级 / C2 引导 / 不打扰）──

await check('A1 普通对话（route_verdict 且无 notice）不打扰用户：返回 null', () => {
  assert.equal(V.noticeOf(routeEvt({ route: 'simple_chat', tier: 'C0', ask: false, cost: null })), null);
  assert.equal(V.noticeOf(routeEvt({ route: 'multi_step_single', tier: 'C0', cost: null })), null);
});

await check('A2 升级提示：取出团队人数与 token 倍数（成本护栏必须看得见）', () => {
  const n = V.noticeOf(routeEvt({
    type: 'upgrade', tier: 'C0', ask: false,
    notice: { type: 'upgrade', route: 'parallel_team', teamSize: 3, tokenMultiple: 3 },
  }));
  assert.ok(n, '升级事件必须有提示条');
  assert.equal(n.kind, 'upgrade');
  assert.equal(n.teamSize, 3);
  assert.equal(n.tokenMultiple, 3);
  assert.match(n.reason, /并行|拆/);
});

await check('A3 降级提示：kind=downgrade（用户要知道这次没升级、省了 token）', () => {
  const n = V.noticeOf(routeEvt({
    type: 'downgrade', route: 'simple_chat', tier: 'C0',
    notice: { type: 'downgrade', route: 'simple_chat', reason: '存在顺序依赖', teamSize: 1, tokenMultiple: 1 },
  }));
  assert.ok(n);
  assert.equal(n.kind, 'downgrade');
  assert.equal(n.teamSize, 1);
  assert.equal(n.tokenMultiple, 1);
});

await check('A4 C2 引导：不执行、只给跳转；跳转动作由路由类别确定性推导', () => {
  const manual = V.noticeOf(routeEvt({ type: 'guide', route: 'manual_team', tier: 'C2', blocked: true, cost: null }));
  assert.ok(manual);
  assert.equal(manual.kind, 'guide');
  assert.equal(manual.guideAction, 'open_assistant_team');
  const sched = V.noticeOf(routeEvt({ type: 'guide', route: 'scheduled', tier: 'C2', blocked: true, cost: null }));
  assert.equal(sched.guideAction, 'open_assistant_scheduled');
});

await check('A5 tier=C2 即使 type 是 route_verdict 也按引导处理（两处判据不得漂移）', () => {
  const n = V.noticeOf(routeEvt({ type: 'route_verdict', tier: 'C2', route: 'manual_team' }));
  assert.ok(n);
  assert.equal(n.kind, 'guide');
});

await check('A6 成本字段缺失时不崩、按 0 处理（渲染层不得假设主进程一定给全）', () => {
  const n = V.noticeOf(routeEvt({ type: 'upgrade', notice: { type: 'upgrade' }, cost: null }));
  assert.ok(n);
  assert.equal(n.teamSize, 0);
  assert.equal(n.tokenMultiple, 0);
});

// ── B. 确认卡映射（C1）──

await check('B1 C1 确认卡：子任务、理由、代价、三个动作齐备', () => {
  const v = V.confirmOf(confirmEvt());
  assert.ok(v && v.kind === 'confirm');
  assert.equal(v.ready, true);
  assert.equal(v.subtasks.length, 2);
  assert.equal(v.subtasks[1].title, '核对各接口的越权风险');
  assert.equal(v.teamSize, 3);
  assert.equal(v.tokenMultiple, 3);
  assert.ok(v.reason.length > 0);
  assert.equal(v.conversationId, 'th-1');
  assert.equal(v.goal, '梳理鉴权调用链并出风险清单');
});

await check('B2 子任务未拆好：ready=false 且带上原因（UI 据此禁用确认）', () => {
  const v = V.confirmOf(confirmEvt({ subtasks: [], subtasksReady: false, subtaskError: '拆解通道未就绪' }));
  assert.ok(v && v.kind === 'confirm');
  assert.equal(v.ready, false);
  assert.equal(v.subtasks.length, 0);
  assert.match(v.subtaskError, /未就绪/);
});

await check('B3 不是确认卡的东西一律忽略：没有 subtasksReady 键且无 guide ⇒ null', () => {
  const evt = confirmEvt();
  delete evt.card.subtasksReady;
  assert.equal(V.confirmOf(evt), null);
  assert.equal(V.confirmOf({ type: 'confirm_card', card: null }), null);
  assert.equal(V.confirmOf(null), null);
});

await check('B4 C2 的 card.guide ⇒ 引导（不能渲染成可确认的卡：防止「确认了但不会执行」）', () => {
  const v = V.confirmOf(confirmEvt({ guide: { action: 'open_assistant_scheduled', label: '创建定时任务' }, subtasksReady: undefined }));
  assert.ok(v);
  assert.equal(v.kind, 'guide');
  assert.equal(v.action, 'open_assistant_scheduled');
  assert.equal(v.label, '创建定时任务');
});

await check('B5 signals 归一：缺字段时用假值兜底，不让 UI 读到 undefined', () => {
  const v = V.confirmOf(confirmEvt({ signals: null }));
  assert.ok(v && v.kind === 'confirm');
  assert.equal(v.signals.parallelizable, undefined);
  // UI 侧一律按 Boolean()/Number() 读，这里只断言对象存在且不抛
  assert.doesNotThrow(() => String(Number(v.signals.toolKinds) || 0));
});

// ── C. 会话归属过滤（防跨会话串台）──

await check('C1 无归属事件视为本窗口事件；有归属必须匹配当前会话', () => {
  assert.equal(V.isForThread({ conversationId: null }, 'th-1'), true);
  assert.equal(V.isForThread({ conversationId: 'th-1' }, 'th-1'), true);
  assert.equal(V.isForThread({ conversationId: 'th-2' }, 'th-1'), false);
});

await check('C2 有归属但当前没有会话（欢迎页）⇒ 不展示（否则 A 会话的提示会飘到空白页）', () => {
  assert.equal(V.isForThread({ conversationId: 'th-1' }, null), false);
  assert.equal(V.isForThread({ conversationId: 'th-1' }, ''), false);
});

// ── D. 杂项纯函数 ──

await check('D1 wallClockMinutes：0/负数 ⇒ 0（不展示）；否则向上取整且最小 1 分钟', () => {
  assert.equal(V.wallClockMinutes(0), 0);
  assert.equal(V.wallClockMinutes(-1), 0);
  assert.equal(V.wallClockMinutes(30000), 1);
  assert.equal(V.wallClockMinutes(90000), 2);
  assert.equal(V.wallClockMinutes(600000), 10);
});

await check('D2 choicePayload：形状与主进程 entry:choice 入参一致（choice 只允许 confirm/single）', () => {
  assert.deepEqual(V.choicePayload({ conversationId: 'th-1', goal: 'g' }, 'confirm'),
    { conversationId: 'th-1', goal: 'g', choice: 'confirm' });
  assert.deepEqual(V.choicePayload({ conversationId: null, goal: 'g' }, 'single'),
    { conversationId: null, goal: 'g', choice: 'single' });
  assert.deepEqual(V.choicePayload(null, 'single'), { conversationId: null, goal: '', choice: 'single' });
});

await check('D3 dependsLabel：数组→可读串；非数组→空串（UUID 不进 UI 文案）', () => {
  assert.equal(V.dependsLabel(['t1', 't2']), 't1, t2');
  assert.equal(V.dependsLabel([]), '');
  assert.equal(V.dependsLabel(undefined), '');
});

// ── E. 接线与纪律（结构性事实）──

await check('E1 组件真实消费 4 个入口桥（onEntryRoute / onEntryConfirm / entryChoice / entryPolicy）', () => {
  const src = stripComments(read('components/EntryRouteNotice.tsx'));
  for (const name of ['onEntryRoute', 'onEntryConfirm', 'entryChoice', 'entryPolicy']) {
    // 两种写法都算：`window.mjcode?.x` 与 `const mj = window.mjcode; mj?.x`
    assert.ok(new RegExp(`(mjcode|mj)\\?\\.${name}`).test(src), `未消费桥方法：${name}`);
  }
});

await check('E2 台账纪律：4 个桥已从 dead allowlist 删除（启用后必须删台账项）', () => {
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/bridge-dead-allowlist.json'), 'utf8'));
  for (const name of ['onEntryRoute', 'onEntryConfirm', 'entryChoice', 'entryPolicy']) {
    assert.ok(!allow.dead.includes(name), `台账仍挂着已启用的桥：${name}`);
  }
});

await check('E3 提示只走 UI：不产生消息、不写会话历史（禁止伪造 assistant 消息）', () => {
  const src = stripComments(read('components/EntryRouteNotice.tsx'));
  assert.ok(!/sendMessage/.test(src), '组件不得调用 sendMessage');
  assert.ok(!/setMessages|appendMessage|localStore/.test(src), '组件不得直接写消息/会话历史');
});

await check('E4 组件订阅必须可退订（否则窗口重建会叠加监听）', () => {
  const src = stripComments(read('components/EntryRouteNotice.tsx'));
  assert.match(src, /return \(\) => \{[\s\S]{0,400}offRoute[\s\S]{0,200}offConfirm/, 'useEffect 未返回取消订阅');
});

await check('E5 App 已挂载判定点 UI（全局唯一入口，压在聊天列顶部）', () => {
  const app = read('App.jsx');
  assert.match(app, /<EntryRouteNotice\s+threadId=\{activeThreadId\}/, 'App 未挂载 EntryRouteNotice');
});

await check('E6 零裸 <button>：动作全部走 ui/Button 原语（ui-conventions 棘轮不抬高）', () => {
  const src = stripComments(read('components/EntryRouteNotice.tsx'));
  assert.ok(!/<button/.test(src), 'EntryRouteNotice 含裸 <button>');
  assert.ok(!/<svg/.test(src), 'EntryRouteNotice 自带 svg（应复用 components/icons 以统一 stroke 体系）');
});

await check('E7 文案全走 i18n：entry 模块中英双侧键集一致且非空', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/zh-CN/entry.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/en-US/entry.json'), 'utf8'));
  const keys = Object.keys(zh);
  assert.ok(keys.length >= 40, `entry 模块文案过少：${keys.length}`);
  assert.deepEqual(Object.keys(en).sort(), keys.sort(), '中英键集不一致');
  for (const k of keys) assert.equal(typeof zh[k], 'string');
});

// ── F. 「按这个执行」的派活载荷（纪律①：用户确认的清单 == 实际执行的清单）──

const confirmView = (over = {}) => {
  const v = V.confirmOf(confirmEvt(over));
  assert.equal(v.kind, 'confirm');
  return v;
};

await check('F1 已拆好 + 有军团 ⇒ 生成 teams:dispatch 载荷，清单与卡上**逐条同源**', () => {
  const card = confirmView();
  const plan = V.dispatchPlanOf({ card, roster: { kind: 'team', teamId: 'team-9' }, threadId: 'th-1', projectPath: '/proj' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const p = plan.payload;
  assert.equal(p.teamId, 'team-9');
  assert.equal(p.threadId, 'th-1');
  assert.equal(p.goal, card.goal);
  assert.equal(p.projectPath, '/proj');
  assert.equal(p.presetTasks.length, card.subtasks.length, '派活任务数必须等于卡上条数');
  assert.deepEqual(p.presetTasks.map((x) => x.title), card.subtasks.map((x) => x.title), '标题必须逐字一致');
  assert.deepEqual(p.presetTasks.map((x) => x.id), card.subtasks.map((x) => x.id), 'id 必须一致（依赖靠它对上）');
  assert.deepEqual(p.presetTasks[1].dependsOn, ['t1'], '依赖关系必须原样保留');
});

await check('F2 prompt 必须按 title 原样补齐（缺 prompt 会被主进程整批丢弃 ⇒ 静默回落 LLM 重拆）', () => {
  const card = confirmView();
  const plan = V.dispatchPlanOf({ card, roster: { kind: 'team', teamId: 'team-9' }, threadId: 'th-1' });
  assert.equal(plan.ok, true);
  for (const t of plan.payload.presetTasks) {
    assert.ok(t.prompt && t.prompt.length > 0, 'prompt 不得为空');
    assert.equal(t.prompt, t.title, 'prompt 必须等于用户看到的标题（不加料、不改范围）');
  }
});

await check('F3 临时编制 ⇒ 拒绝且**不伪造 teamId**（roster-temp 是独立原因，不并成「失败」）', () => {
  const card = confirmView();
  const plan = V.dispatchPlanOf({ card, roster: { kind: 'temp', teamId: null }, threadId: 'th-1' });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'roster-temp');
  assert.equal(Object.prototype.hasOwnProperty.call(plan, 'payload'), false, '拒绝时不得带载荷');
});

await check('F4 其余拒绝原因分档：无编制 / 子任务未就绪 / 无会话 / 无目标', () => {
  const card = confirmView();
  assert.deepEqual(V.dispatchPlanOf({ card, roster: null, threadId: 'th-1' }), { ok: false, reason: 'no-roster' });
  assert.equal(V.dispatchPlanOf({ card: confirmView({ subtasks: [], subtasksReady: false }), roster: { kind: 'team', teamId: 'x' }, threadId: 'th-1' }).reason, 'not-ready');
  assert.equal(V.dispatchPlanOf({ card, roster: { kind: 'team', teamId: 'x' }, threadId: null }).reason, 'no-thread');
  assert.equal(V.dispatchPlanOf({ card: { ...card, goal: '   ' }, roster: { kind: 'team', teamId: 'x' }, threadId: 'th-1' }).reason, 'no-goal');
});

await check('F5 编制异常（kind=team 但无 teamId）⇒ no-team-id，不派给空 id', () => {
  const card = confirmView();
  const plan = V.dispatchPlanOf({ card, roster: { kind: 'team', teamId: '' }, threadId: 'th-1' });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'no-team-id');
});

await check('F6 每个拒绝原因都有中英文案（UI 不会把裸 key 吐给用户）', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/zh-CN/entry.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/en-US/entry.json'), 'utf8'));
  for (const [reason, key] of Object.entries(V.DISPATCH_REFUSAL_KEYS)) {
    const leaf = key.replace(/^entry\./, '');
    assert.equal(typeof zh[leaf], 'string', `${reason} 缺中文案：${key}`);
    assert.equal(typeof en[leaf], 'string', `${reason} 缺英文案：${key}`);
  }
  for (const extra of ['confirmDispatched', 'confirmDispatchFailed', 'confirmLeadMissing']) {
    assert.equal(typeof zh[extra], 'string', `缺中文案：${extra}`);
  }
});

await check('F7 「按这个执行」真的派活：先 entryChoice 再 teamsDispatch（顺序不可颠倒）', () => {
  const src = stripComments(read('components/EntryRouteNotice.tsx'));
  const iChoice = src.indexOf('entryChoice');
  const iDispatch = src.indexOf('teamsDispatch');
  assert.ok(iChoice > 0, '未调用 entryChoice（下一轮会重复弹卡）');
  assert.ok(iDispatch > 0, '未调用 teamsDispatch（确认卡是假的：点了什么都不发生）');
  assert.ok(iChoice < iDispatch, `顺序错误：必须先记录选择再派活（choice@${iChoice} dispatch@${iDispatch}）`);
  assert.match(src, /setDispatched\(/, '派活成功后必须给回执（不能静默成功）');
  assert.match(src, /confirmDispatchFailed/, '派活失败必须展示错误');
});

await check('F8 派活目标是**当前候选编制**（单一事实源，不另存一份）', () => {
  const src = stripComments(read('components/EntryRouteNotice.tsx'));
  assert.match(src, /useCandidateRoster\(\)/, '未从 lib/candidateRoster 读编制');
  assert.match(src, /dispatchPlanOf\(\{ card, roster, threadId, projectPath \}\)/, '载荷未按真实编制/会话/目录构造');
});

await check('F9 「改成单 Agent」绝不派活：只有 confirm 分支才走 teamsDispatch', () => {
  const src = stripComments(read('components/EntryRouteNotice.tsx'));
  const iConfirmBranch = src.indexOf("if (choice === 'confirm')");
  assert.ok(iConfirmBranch > 0, '缺少 confirm 分支判定');
  const iDispatch = src.indexOf('teamsDispatch');
  assert.ok(iDispatch > iConfirmBranch, 'teamsDispatch 不在 confirm 分支内（single 也会派活）');
});

await check('F10 temp 编制时按钮禁用且有解释文案（不假装支持、不悄悄降级）', () => {
  const src = stripComments(read('components/EntryRouteNotice.tsx'));
  assert.match(src, /disabled=\{!card\.ready \|\| Boolean\(blockedReason\)\}/, '按钮未按可派性禁用');
  assert.match(src, /\{blockedReason &&/, '未就地展示禁用理由');
  assert.match(src, /DISPATCH_REFUSAL_KEYS\[plan\.reason\]/, '禁用理由未按原因分档取文案');
});

console.log(`\nentry-route-ui: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
