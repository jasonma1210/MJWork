#!/usr/bin/env node
// 双入口路由判定门禁（设计文档 §7.3 / §8.1 / §14 P1-8）
//
// 断言范式纪律（来自变异验证的实测结论）：
//   本套件**全部是行为断言**——直接 import 被测模块、喂输入、看输出，
//   不断言源码形态、不只比清单。源码正则门禁是「假闸」的典型形态
//   （把判据挪进注释后仍全绿），本套件不采用那种写法。
//
// 覆盖四条纪律：
//   ① L0 规则层命中即返回 ⇒ **绝不调模型**（用计数假 chatOnce 断言调用次数为 0）；
//   ② L1 失败/超时/输出非法 ⇒ 降级 simple_chat（不启 DAG）；
//   ③ 确认点三档 C0 / C1 / C2 的判定条件；
//   ④ 用户点「改成单 Agent」⇒ 本轮不升级且不重复追问。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(import.meta.dirname, '..');
const router = require(path.join(ROOT, 'main/entryRouter.js'));

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// 假模型通道：记录调用次数，返回指定内容（用于断言「规则层命中时模型没被调用」）
function fakeChat(content, { throwError = false } = {}) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    if (throwError) throw new Error('模型通道炸了');
    return { content };
  };
  fn.calls = calls;
  return fn;
}

const PARALLEL_GOAL = '帮我查一下 A 文档和 B 文档，两者互不依赖';
const SEQUENTIAL_GOAL = '先做完第一步，然后再做第二步';
const DENSE_GOAL = '读文件、列目录、搜索内容、查找文件、写文件、改代码、执行命令、提交代码、'
  + '联网搜索、抓取网页、浏览器操作、生成 ppt、执行脚本、发请求、查数据库、工件、技能、任务清单';

await (async () => {
  // ── 一、L0 规则层：每条规则都要有「命中」与「不命中」两侧的断言 ──

  await check('规则层：可并行信号命中 ⇒ parallel_team', () => {
    const v = router.ruleRoute(PARALLEL_GOAL, {});
    assert.equal(v.verdict, 'parallel_team');
    assert.equal(v.signals.parallelizable, true);
    assert.equal(v.signals.sequential, false);
    assert.ok(v.reason && v.reason.length > 0, '必须给出人话理由');
  });

  await check('规则层：顺序依赖命中 ⇒ 禁止升级（multi_step_single）', () => {
    const v = router.ruleRoute(SEQUENTIAL_GOAL, {});
    assert.equal(v.verdict, 'multi_step_single');
    assert.equal(v.signals.sequential, true);
    assert.notEqual(v.verdict, 'parallel_team');
  });

  await check('规则层：顺序依赖优先于可并行信号（两者同现时仍不升级）', () => {
    const v = router.ruleRoute('这部分互不依赖，先做第一步然后再做第二步', {});
    assert.equal(v.signals.sequential, true);
    assert.notEqual(v.verdict, 'parallel_team');
  });

  await check('规则层：工具种类数 ≥ 阈值 ⇒ 降级单 Agent', () => {
    const v = router.ruleRoute(DENSE_GOAL, {});
    assert.ok(v.signals.toolKinds >= 16, `工具种类数应 ≥16，实际 ${v.signals.toolKinds}`);
    assert.equal(v.verdict, 'multi_step_single');
  });

  await check('规则层：定时特征 ⇒ scheduled', () => {
    const v = router.ruleRoute('每天早上帮我汇总昨天的数据', {});
    assert.equal(v.verdict, 'scheduled');
    assert.equal(v.signals.scheduledHint, true);
  });

  await check('规则层：显式要人工组队 ⇒ manual_team', () => {
    const v = router.ruleRoute('帮我组建一个团队来做这件事', {});
    assert.equal(v.verdict, 'manual_team');
  });

  await check('规则层：无线索 ⇒ unknown（交给模型层）', () => {
    const v = router.ruleRoute('嗯', {});
    assert.equal(v.verdict, 'unknown');
    assert.equal(v.confidence, 0);
  });

  await check('规则层：chatOnly ⇒ simple_chat（不启 DAG）', () => {
    const v = router.ruleRoute(PARALLEL_GOAL, { chatOnly: true });
    assert.equal(v.verdict, 'simple_chat');
  });

  await check('规则层：userPickedTeam ⇒ parallel_team（用户已表达意图，不再判定）', () => {
    const v = router.ruleRoute(SEQUENTIAL_GOAL, { userPickedTeam: true });
    assert.equal(v.verdict, 'parallel_team');
  });

  // ── 二、judgeRoute：L0 命中时**绝不调模型** ──

  await check('judgeRoute：规则层已能判定 ⇒ 模型层调用次数为 0', async () => {
    const chat = fakeChat(JSON.stringify({ route: 'parallel_team', reason: 'x', confidence: 1 }));
    const v = await router.judgeRoute({ goal: PARALLEL_GOAL }, { chatOnce: chat });
    assert.equal(chat.calls.length, 0, `规则层命中却调了模型 ${chat.calls.length} 次`);
    assert.equal(v.route, 'parallel_team');
    assert.equal(v.decidedByRule, true);
    assert.equal(v.source, 'rule');
  });

  await check('judgeRoute：规则层不确定 ⇒ 走模型层，输出离散类别', async () => {
    const chat = fakeChat(JSON.stringify({ route: 'parallel_team', reason: '各部分互不依赖', confidence: 0.9 }));
    const v = await router.judgeRoute({ goal: '嗯' }, { chatOnce: chat });
    assert.equal(chat.calls.length, 1);
    assert.equal(v.route, 'parallel_team');
    assert.equal(v.decidedByRule, false);
    assert.equal(v.source, 'model');
    assert.equal(v.confidence, 0.9);
  });

  // ── 三、L1 失败/非法 ⇒ 降级 simple_chat（保守方向：不启 DAG）──

  await check('judgeRoute：模型层抛异常 ⇒ 降级 simple_chat（source=fallback）', async () => {
    const chat = fakeChat('', { throwError: true });
    const v = await router.judgeRoute({ goal: '嗯' }, { chatOnce: chat });
    assert.equal(v.route, 'simple_chat');
    assert.equal(v.source, 'fallback');
    assert.notEqual(v.route, 'parallel_team');
  });

  await check('judgeRoute：模型层返回非法 JSON ⇒ 降级 simple_chat', async () => {
    const chat = fakeChat('这不是 JSON');
    const v = await router.judgeRoute({ goal: '嗯' }, { chatOnce: chat });
    assert.equal(v.route, 'simple_chat');
    assert.equal(v.source, 'fallback');
  });

  await check('judgeRoute：模型层给出未知类别 ⇒ 降级 simple_chat', async () => {
    const chat = fakeChat(JSON.stringify({ route: 'parallel_teammm', reason: 'x', confidence: 0.99 }));
    const v = await router.judgeRoute({ goal: '嗯' }, { chatOnce: chat });
    assert.equal(v.route, 'simple_chat');
    assert.equal(v.source, 'fallback');
  });

  await check('judgeRoute：模型层置信度不足 ⇒ 按 ambiguous 降级 simple_chat', async () => {
    const chat = fakeChat(JSON.stringify({ route: 'parallel_team', reason: 'x', confidence: 0.2 }));
    const v = await router.judgeRoute({ goal: '嗯' }, { chatOnce: chat });
    assert.equal(v.route, 'simple_chat');
    assert.equal(v.source, 'fallback');
  });

  await check('judgeRoute：没有模型通道 ⇒ 只走规则层，不升级', async () => {
    const v = await router.judgeRoute({ goal: '嗯' }, {});
    assert.equal(v.route, 'simple_chat');
    assert.equal(v.source, 'rule');
  });

  // ── 四、确认点三档（C0 / C1 / C2）──

  await check('确认点 C0：用户已显式选编制 ⇒ 不问', () => {
    const v = { route: 'parallel_team', confidence: 0.9, signals: { estimatedSize: 3, toolKinds: 2 } };
    const c = router.decideConfirmPoint(v, { userPickedTeam: true });
    assert.equal(c.tier, 'C0');
    assert.equal(c.ask, false);
  });

  await check('确认点 C0：规则层高置信（可并行 + 工具少 + 规模小）⇒ 不问', () => {
    const v = { route: 'parallel_team', confidence: 0.85, signals: { estimatedSize: 2, toolKinds: 1 } };
    const c = router.decideConfirmPoint(v, {});
    assert.equal(c.tier, 'C0');
    assert.equal(c.ask, false);
    assert.equal(c.notice && c.notice.type, 'upgrade');
  });

  await check('确认点 C1：parallel_team + 中置信 ⇒ 先出卡不建组', () => {
    const v = { route: 'parallel_team', confidence: 0.6, signals: { estimatedSize: 4, toolKinds: 10 } };
    const c = router.decideConfirmPoint(v, {});
    assert.equal(c.tier, 'C1');
    assert.equal(c.ask, true);
    assert.equal(c.blocked, false);
    assert.ok(c.card, 'C1 必须带确认卡');
    assert.ok(Array.isArray(c.card.subtasks), '确认卡必须带子任务清单字段');
    assert.ok(c.card.cost && c.card.cost.tokenMultiple >= 1, '确认卡必须带代价（token 倍数）');
    assert.ok(c.card.actions.includes('confirm') && c.card.actions.includes('single'));
  });

  await check('确认点 C1：工具种类 ≥ 16 ⇒ 卡片给「建议单 Agent」的保守提示', () => {
    const v = { route: 'parallel_team', confidence: 0.6, signals: { estimatedSize: 2, toolKinds: 18 } };
    const c = router.decideConfirmPoint(v, {});
    assert.equal(c.tier, 'C1');
    assert.equal(c.card.conservative, true);
    assert.ok(c.card.conservativeHint.length > 0);
  });

  await check('确认点 C2：manual_team ⇒ 阻断 + 引导（不执行）', () => {
    const v = { route: 'manual_team', confidence: 0.9, signals: {} };
    const c = router.decideConfirmPoint(v, {});
    assert.equal(c.tier, 'C2');
    assert.equal(c.blocked, true);
    assert.equal(c.ask, false);
    assert.ok(c.card && c.card.guideAction, 'C2 必须给出跳转引导');
  });

  await check('确认点 C2：scheduled ⇒ 阻断 + 引导（不自动创建定时任务）', () => {
    const v = { route: 'scheduled', confidence: 0.9, signals: {} };
    const c = router.decideConfirmPoint(v, {});
    assert.equal(c.tier, 'C2');
    assert.equal(c.blocked, true);
  });

  await check('确认点：simple_chat / multi_step_single ⇒ 不问（C0）', () => {
    for (const route of ['simple_chat', 'multi_step_single']) {
      const c = router.decideConfirmPoint({ route, confidence: 0.9, signals: {} }, {});
      assert.equal(c.tier, 'C0');
      assert.equal(c.ask, false);
    }
  });

  // ── 五、无人值守纪律：不得静默升级 ──

  await check('无人值守 + parallel_team 且未预先声明 team_id ⇒ 阻断（不得静默升级）', () => {
    const v = { route: 'parallel_team', confidence: 0.9, signals: { estimatedSize: 3, toolKinds: 1 } };
    const c = router.decideConfirmPoint(v, { unattended: true });
    assert.equal(c.blocked, true);
    assert.equal(c.ask, false);
    assert.ok(c.reason.includes('team_id'), '阻断理由必须点明「须预先声明 team_id 与预算」');
  });

  await check('无人值守 + 已声明 team_id ⇒ 没有确认点，按声明执行', () => {
    const v = { route: 'parallel_team', confidence: 0.9, signals: { estimatedSize: 3, toolKinds: 1 } };
    const c = router.decideConfirmPoint(v, { unattended: true, scheduledTeamId: 'team-1' });
    assert.equal(c.tier, 'none');
    assert.equal(c.blocked, false);
    assert.equal(c.ask, false);
  });

  // ── 六、纪律②：用户点「改成单 Agent」⇒ 本轮不升级且不重复追问 ──

  await check('纪律②：记录「改成单 Agent」后，同会话同目标不再被追问', () => {
    const key = 'session-A';
    const goal = '帮我并行地做三件事';
    assert.equal(router.hasAnswered(key, goal), false);
    assert.equal(router.noteUserChoice(key, goal, 'single'), true);
    assert.equal(router.hasAnswered(key, goal), true);
    // 别的目标不受影响
    assert.equal(router.hasAnswered(key, '另一个目标'), false);
    // 别的会话不受影响
    assert.equal(router.hasAnswered('session-B', goal), false);
  });

  await check('纪律②：非法 choice 不被记录', () => {
    assert.equal(router.noteUserChoice('session-C', 'g', 'maybe'), false);
    assert.equal(router.hasAnswered('session-C', 'g'), false);
  });

  // ── 七、策略配置（阈值与开关全在 entryPolicy.json，代码不写死）──

  await check('策略配置：默认阈值与设计文档 §10 一致', () => {
    const p = router.loadPolicy();
    assert.equal(p.new.autoDag.rule.toolKindThreshold, 16);
    assert.equal(p.new.autoDag.maxTeamSize, 5);
    assert.equal(p.new.autoDag.modelLayer.failOpenTo, 'simple_chat');
    assert.equal(p.new.confirm.c0MinConfidence, 0.75);
    assert.equal(p.new.confirm.toolKindsC0Max, 8);
    assert.equal(p.assistant.aiTeamDraft.defaultSize, 3);
    assert.equal(p.assistant.aiTeamDraft.maxSize, 8);
  });

  await check('策略配置：团队规模上限 5 与 DAG 任务数上限 8 不是一回事', () => {
    const p = router.loadPolicy();
    const dag = require(path.join(ROOT, 'main/orchestrator/dag.js'));
    assert.equal(p.new.autoDag.maxTeamSize, 5);
    assert.equal(dag.MAX_TASKS, 8);
  });

  // ── 八、纯拆解（纪律①：拆 ≠ 建组）──

  await check('纯拆解：拿到已校验的子任务清单，不建组', async () => {
    const chat = fakeChat(JSON.stringify({
      tasks: [
        { id: 't1', title: '梳理调用链', prompt: '读代码并输出调用链', dependsOn: [] },
        { id: 't2', title: '核对越权风险', prompt: '逐个接口核对并输出清单', dependsOn: ['t1'] },
      ],
    }));
    const r = await router.decomposeOnly('梳理鉴权调用链并核对越权风险', { chatOnce: chat });
    assert.equal(r.ok, true);
    assert.equal(r.tasks.length, 2);
    assert.equal(r.tasks[1].dependsOn[0], 't1');
    assert.ok(r.tasks[0].prompt.length > 0, '子任务必须带 prompt（否则确认卡给的是空计划）');
  });

  await check('纯拆解：模型输出非法 ⇒ 明确失败（不假装拆好了）', async () => {
    const chat = fakeChat('这不是 JSON');
    const r = await router.decomposeOnly('x', { chatOnce: chat });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  await check('确认卡：出卡前完成预拆（子任务清单已就绪）', async () => {
    const chat = fakeChat(JSON.stringify({
      tasks: [
        { id: 't1', title: 'A', prompt: '做 A', dependsOn: [] },
        { id: 't2', title: 'B', prompt: '做 B', dependsOn: [] },
      ],
    }));
    const v = { route: 'parallel_team', confidence: 0.6, signals: { estimatedSize: 2, toolKinds: 1 } };
    const c = await router.buildConfirmPoint(v, { goal: '并行做 A 和 B' }, { chatOnce: chat });
    assert.equal(c.tier, 'C1');
    assert.equal(c.card.subtasksReady, true);
    assert.equal(c.card.subtasks.length, 2);
  });

  // 确认卡 → 派活的**关键契约**：卡上每个子任务必须带 prompt。
  // 少了它，渲染层回传的清单会被 normalizePresetTasks 全部过滤 ⇒ 派活返回
  // 「预设任务清单为空或缺少 prompt」⇒ 用户点了「按这个执行」什么都不发生（看着能点、点了没用）。
  // 这条是独立验证查出的盲区：原来只有「清单非空」的断言，改坏 prompt 无门禁保护。
  await check('确认卡：每个子任务都带 prompt（否则回传后会被归一过滤，派活必然失败）', async () => {
    const chat = fakeChat(JSON.stringify({
      tasks: [
        { id: 't1', title: 'A', prompt: '做 A', dependsOn: [] },
        { id: 't2', title: 'B', prompt: '做 B', dependsOn: ['t1'] },
      ],
    }));
    const v = { route: 'parallel_team', confidence: 0.6, signals: { estimatedSize: 2, toolKinds: 1 } };
    const c = await router.buildConfirmPoint(v, { goal: '并行做 A 和 B' }, { chatOnce: chat });
    const subs = c.card.subtasks || [];
    assert.ok(subs.length > 0, '子任务清单为空');
    for (const s of subs) {
      assert.equal(typeof s.prompt, 'string', `子任务 ${s.id} 缺 prompt`);
      assert.ok(s.prompt.trim().length > 0, `子任务 ${s.id} 的 prompt 为空`);
    }
    // 端到端一致性：卡上清单喂给派活层的归一函数后必须**一条不少**地保留下来
    const { normalizePresetTasks } = await import('../main/teamDispatchPlan.js').then((m) => m.default || m);
    const dispatched = normalizePresetTasks(subs.map((s) => ({ id: s.id, title: s.title, prompt: s.prompt, dependsOn: s.dependsOn })));
    assert.ok(dispatched && dispatched.length === subs.length,
      `卡上 ${subs.length} 条，归一到派活后只剩 ${dispatched ? dispatched.length : 0} 条`);
  });

  console.log(`\nentry-router: ${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
})();
