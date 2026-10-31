#!/usr/bin/env node
// M3（2026-10-30）：验收标准（AC）提取器回归。
//
// 背景：长任务里「什么算完成」只存在于用户那句目标里，随着对话变长被稀释；
// 而「做完了没有」又只能由执行者自己说。AC 要在任务**开始前**把这条基线抽出来固化，
// 供 Judge（M4）对照判定、供断点跨「继续」复用。
//
// 本套件守五件事（每条都配了「改坏即红」的判据）：
//   A. 解析容错——模型输出形态不可控，坏 JSON 绝不能让任务发不出去；
//   B. 宁缺不造——抽不出任何一条就是 null，不给下游一个空的假基线；
//   C. 独立且不阻塞——提取是一次独立调用，失败/超时一律降级为「无 AC」；
//   D. 复用优先——外部给了 AC 就**不再提取**（每续一段换一套标准 = 没有标准）；
//   E. 独立 Judge（M4）——输入隔离（拿不到思考过程）、缺失项触发反思回溯、异常 fail-open。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJudge, buildJudgePrompt, buildReflection, runJudges, JUDGE_EVERY_DEFAULT, MAX_REFLECTIONS } from '../agent-core/judge.js';
import { parseAcceptance, hasAcceptance, buildAcceptancePrompt, resolveAcceptance, AC_MAX_ITEMS, AC_MAX_ITEM_CHARS } from '../agent-core/acceptance.js';
import { runAgent } from '../agent-core/index.js';
import { pathsIn, buildCheckPlan, checkAgainstLedger } from '../agent-core/hardCheck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const straight = (p) => p; // 直通的 withTimeout（本套件不测超时那条路径）
const mains_count = (calls) => calls.filter((p) => !/你是(完成度|正确性)审查者/.test(String(p?.messages?.[0]?.content || '')) && !/验收标准提取器/.test(String(p?.messages?.[0]?.content || ''))).length;

// ── A. 解析容错：五种真实形态 ──
check('① 合法 JSON（裸对象）', JSON.stringify(parseAcceptance('{"must":["补安装步骤"],"must_not":["不要改 API"]}'))
  === JSON.stringify({ must: ['补安装步骤'], must_not: ['不要改 API'] }));
check('② markdown 围栏 + 前后废话（模型最常见的形态）',
  JSON.stringify(parseAcceptance('好的，结果如下：\n```json\n{"must":["跑通测试"],"must_not":[]}\n```\n希望有用'))
    === JSON.stringify({ must: ['跑通测试'], must_not: [] }));
check('③ 缺 must_not 字段 → 补空数组（不是 undefined，下游不必到处判空）',
  JSON.stringify(parseAcceptance('{"must":["补安装步骤"]}')) === JSON.stringify({ must: ['补安装步骤'], must_not: [] }));
check('④ 非法 JSON → null（不抛，调用方按「无 AC」继续）', parseAcceptance('这不是 JSON') === null);
check('⑤ 空字符串 / null / undefined → null', parseAcceptance('') === null && parseAcceptance(null) === null && parseAcceptance(undefined) === null);
// ── B. 宁缺不造 ──
check('⑥ 两个数组都空 → null（空基线会让 Judge 误判「全部满足」）', parseAcceptance('{"must":[],"must_not":[]}') === null);
check('⑦ 非字符串条目被丢弃（模型偶尔给 {"must":[{"a":1}]}）',
  JSON.stringify(parseAcceptance('{"must":["ok",123,null,{"a":1}]}')) === JSON.stringify({ must: ['ok'], must_not: [] }));
check('⑧ 超长条目截断到上限（不把一段长文当一条标准塞进 prompt）',
  parseAcceptance(`{"must":["${'x'.repeat(500)}"]}`).must[0].length === AC_MAX_ITEM_CHARS);
check('⑨ 超条数截断到上限（先截长度再截条数）',
  parseAcceptance(`{"must":[${Array.from({ length: 20 }, (_, i) => `"第${i}条"`).join(',')}]}`).must.length === AC_MAX_ITEMS);
check('⑩ 直接传对象也能归一（断点读回的是对象，不是字符串）',
  JSON.stringify(parseAcceptance({ must: ['补安装步骤'], must_not: [] })) === JSON.stringify({ must: ['补安装步骤'], must_not: [] }));
check('hasAcceptance：空/无 → false，有条目 → true',
  hasAcceptance(null) === false && hasAcceptance({ must: [] }) === false && hasAcceptance({ must: ['a'] }) === true);
check('提示词要求「只输出 JSON」且不带上文（提取器独立于执行 Agent）',
  /只输出一个 JSON 对象/.test(buildAcceptancePrompt('x')) && !/对话历史/.test(buildAcceptancePrompt('x')));

// ── C. 独立且不阻塞 ──
{
  let calls = 0;
  const r = await resolveAcceptance({
    enabled: true, chatFn: async () => { calls += 1; return { content: '```json\n{"must":["跑通测试"]}\n```', usage: { prompt_tokens: 40, completion_tokens: 20 } }; },
    model: { provider: { id: 1 }, model: { model_id: 'm' } }, goal: '把测试跑通', withTimeout: straight,
  });
  check('⑪ 提取成功：source=extracted 且用量如实回传（AC 也是本次 run 花的钱）',
    r.source === 'extracted' && r.ac.must[0] === '跑通测试' && r.usage.prompt_tokens === 40 && calls === 1,
    JSON.stringify(r));
}
{
  const r = await resolveAcceptance({
    enabled: true, chatFn: async () => ({ content: '抱歉，我无法完成' }),
    model: { provider: { id: 1 }, model: { model_id: 'm' } }, goal: '把测试跑通', withTimeout: straight,
  });
  check('⑫ 坏输出 → ac=null 且不抛（提取失败绝不能让任务发不出去）',
    r.ac === null && r.source === 'none', JSON.stringify(r));
}
{
  const r = await resolveAcceptance({
    enabled: true, chatFn: async () => { throw new Error('通道炸了'); },
    model: { provider: { id: 1 }, model: { model_id: 'm' } }, goal: '把测试跑通', withTimeout: straight,
  });
  check('⑬ 通道抛错 → ac=null 且不抛（fail-open，与「坏 JSON」同纪律）',
    r.ac === null && r.source === 'none', JSON.stringify(r));
}
{
  let calls = 0;
  const r = await resolveAcceptance({
    enabled: true, chatFn: async () => { calls += 1; return { content: '{}' }; },
    model: { provider: { id: 1 }, model: { model_id: 'm' } }, goal: '   ', withTimeout: straight,
  });
  check('⑭ 空目标不发起调用（闲聊不该为「验收标准」付一次模型钱）', r.ac === null && calls === 0);
}
// ── D. 复用优先 ──
{
  let calls = 0;
  const r = await resolveAcceptance({
    enabled: true, criteria: { must: ['沿用旧标准'] }, chatFn: async () => { calls += 1; return { content: '{}' }; },
    model: { provider: { id: 1 }, model: { model_id: 'm' } }, goal: '继续', withTimeout: straight,
  });
  check('⑮ 外部给了 AC → source=checkpoint 且**不再提取**（沿用同一条基线）',
    r.source === 'checkpoint' && r.ac.must[0] === '沿用旧标准' && calls === 0, JSON.stringify(r));
}
{
  const r = await resolveAcceptance({ enabled: false, chatFn: async () => ({ content: '{}' }), model: { provider: { id: 1 }, model: { model_id: 'm' } }, goal: 'x', withTimeout: straight });
  check('⑯ 未开启 → 不提取（默认关：既有调用方的轮次/用量断言按无额外调用写死）', r.ac === null && r.source === 'none');
}

// ── E. 引擎接线：独立前置调用 / 不阻塞 / 断点携带 ──
const AC_REPLY = '```json\n{"must":["在 README 补充安装步骤","跑通 npm test"],"must_not":["不要改动公开 API"]}\n```';
const model = { provider: { id: 1, isGlobal: false, base_url: 'https://api.deepseek.com/v1' }, model: { id: 1, model_id: 'deepseek-chat', context_window: 128000 } };

/** 造一次 run；probe=true 时首条是 AC 探针（按提示词识别，不消耗主脚本） */
async function runOnce({ acceptance = true, criteria = null, acReply = AC_REPLY, acJudge = null, script = [], totalTokenCap = 0, tokenBudget = 0, runWallClockMs = 0 } = {}) {
  const calls = [];
  const traces = [];
  const budgets = [];
  let suspended = null;
  let doneText = '';
  let i = 0;
  await runAgent({
    messages: [{ role: 'user', content: '给项目补安装说明并跑通测试' }],
    model, cwd: '/tmp/project', maxRounds: 6, tokenBudget, totalTokenCap, runWallClockMs,
    acceptance, acceptanceCriteria: criteria,
    toolHandlers: {
      chat: async (p) => {
        calls.push(p);
        const isProbe = /验收标准提取器/.test(String(p?.messages?.[0]?.content || ''));
        if (isProbe) return { content: acReply, usage: { prompt_tokens: 40, completion_tokens: 20 } };
        if (acJudge && isJudgeProbe(p)) return { content: acJudge, usage: { prompt_tokens: 30, completion_tokens: 10 } };
        const next = script[i] || script[script.length - 1] || { content: '做完了', usage: { prompt_tokens: 10, completion_tokens: 5 } };
        i += 1;
        return next;
      },
      gitStatus: async () => ({ stdout: ' M a.js' }),
    },
    onMessage: () => {},
    onTrace: (e) => traces.push(e),
    onBudget: (b) => budgets.push(b),
    onSuspend: (info) => { suspended = { ...info }; return true; },
    onDone: (t) => { doneText = t; },
  });
  return { calls, traces, budgets, suspended, doneText };
}

{
  const { calls, traces } = await runOnce({ acceptance: true });
  const probes = calls.filter((p) => /验收标准提取器/.test(String(p?.messages?.[0]?.content || '')));
  check('⑰ 开启后确有且仅有 1 次独立 AC 调用，且排在**首轮之前**',
    probes.length === 1 && calls[0] === probes[0], `probes=${probes.length}`);
  check('⑱ AC 调用不带工具定义（提取器只该看到目标，不带执行侧上下文）',
    !probes[0].tools && !probes[0].tool_choice, Object.keys(probes[0] || {}).join(','));
  const evt = traces.find((e) => e.type === 'acceptance');
  check('⑲ trace 留痕（source=extracted + 条数；正文不进诊断包）',
    evt?.source === 'extracted' && evt?.must === 2 && evt?.must_not === 1, JSON.stringify(evt));
}
{
  const { calls, traces } = await runOnce({ acceptance: true, criteria: { must: ['沿用旧标准'] } });
  const probes = calls.filter((p) => /验收标准提取器/.test(String(p?.messages?.[0]?.content || '')));
  check('⑳ 传了 acceptanceCriteria → 不再提取（「继续」沿用同一条标准）',
    probes.length === 0, `probes=${probes.length}`);
  check('㉑ 复用时 trace 标 source=checkpoint（事后可区分「这次是新抽的还是沿用的」）',
    traces.find((e) => e.type === 'acceptance')?.source === 'checkpoint');
}
{
  // 提取器返回一坨废话：任务必须照常跑完，不能因为 AC 失败就发不出消息
  const { doneText, traces } = await runOnce({ acceptance: true, acReply: '抱歉我做不到' });
  check('㉒ AC 提取失败仍照常产出结论（不阻塞主流程）',
    String(doneText).length > 0 && !/抱歉我做不到/.test(String(doneText)), String(doneText).slice(0, 40));
  check('㉓ 失败也留痕（source=none，而非「没有这条事件」——后者与「忘了接线」无法区分）',
    traces.find((e) => e.type === 'acceptance')?.source === 'none');
}
{
  // 断点必须带上 AC，否则「继续」就没有可复用的基线
  const script = Array.from({ length: 20 }, () => ({
    content: '干活', tool_calls: [{ id: `c${Math.random().toString(36).slice(2)}`, function: { name: 'git_status', arguments: '{}' } }],
    usage: { prompt_tokens: 60, completion_tokens: 10 },
  }));
  // tokenBudget 必须 >0：轮次熔断（rounds）**不存断点**，只有预算/墙钟/上下文/超时才存
  //（这正是 M2 把「未完」拆成 suspended / incomplete 两态的原因）。
  // 2026-10-31：总上限已改为「先段交接、3 段后才停」，靠 total-cap 挂起的夹具不再稳定；
  // 改用墙钟闸（1ms，续期 2 次后必挂），它同样会经 suspendInfo 落断点，断点载荷的一致性不受影响。
  // tokenBudget 取小值（每轮 70 tokens 必然越过 70%），确保预算分支每轮都进入；
  // 这样段交接 3 次后再撞总上限才会稳定挂起。
  const { suspended } = await runOnce({ acceptance: true, script, tokenBudget: 10, totalTokenCap: 200 });
  check('㉔ 断点载荷带 AC（跨「继续」复用的唯一载体）',
    !!suspended && Array.isArray(suspended.acceptance?.must) && suspended.acceptance.must.length === 2,
    JSON.stringify(suspended?.acceptance || null));
}
{
  // 带外调用不得串流（M6 修正）：AC 探针必须带 quiet，否则宿主会用本 run 的 stream tag
  // 把这段 JSON 推给渲染层 —— 用户会在任务中途看到一段生 JSON，以为模型答歪了。
  const { calls } = await runOnce({ acceptance: true });
  const probe = calls.find((p) => /验收标准提取器/.test(String(p?.messages?.[0]?.content || '')));
  check('㉔-1 AC 探针带 quiet（输出不得串进对话窗口）', probe?.quiet === true, JSON.stringify(probe?.quiet));
}
{
  // 宿主这一跳曾经真实缺失（2026-10-30 发现）：渲染层一直下发 acceptance:true，
  // 但 agentRunner 的 engineParams 白名单没登记它 ⇒ 引擎恒用默认 false ⇒ M3/M4/M5 在
  // 真机上全是死的，而单测直调 runAgent 全绿。「白名单漏登记 = 真机全废」是本文件
  // 上游 P1-6 注释里写过一次的老病，故用一条独立断言钉住宿主侧转发。
  const runner = fs.readFileSync(path.join(HERE, '..', 'main', 'agentRunner.js'), 'utf8');
  check('㉔-2 宿主把 acceptance / acceptanceCriteria 转发进引擎（漏登记则真机全废）',
    /acceptance: !!payload\.acceptance,/.test(runner) && /acceptanceCriteria: payload\.acceptanceCriteria \|\| null,/.test(runner));
}

// ── F. 独立 Judge（M4）：输入隔离 / 回溯 / fail-open ──
const isJudgeProbe = (p) => /你是(完成度|正确性)审查者/.test(String(p?.messages?.[0]?.content || ''));

check('㉕ 完成度 Judge 解析：围栏 + 缺失项',
  JSON.stringify(parseJudge('```json\n{"complete":false,"missing_items":["补安装步骤"]}\n```'))
    === JSON.stringify({ complete: false, missing_items: ['补安装步骤'], has_error: false, error_detail: '' }));
check('㉖ 坏 JSON → null（未判定，不是「已完成」）', parseJudge('我不确定') === null);
check('㉗ 输入隔离：即便误传 reasoning，也不会进 Judge 的输入（独立性是本机制的立足点）',
  !/绝密思考/.test(buildJudgePrompt({ goal: 'g', acceptance: { must: ['a'] }, ledger: [], output: 'o', reasoning: '绝密思考' })));
check('㉘ 输入含「目标 / 验收标准 / 已执行动作 / 当前产出」四段事实（没有第四者）',
  /【原始目标】/.test(buildJudgePrompt({ goal: 'g' })) && /【验收标准】/.test(buildJudgePrompt({ goal: 'g' }))
  && /【已执行的工具动作/.test(buildJudgePrompt({ goal: 'g' })) && /【当前产出】/.test(buildJudgePrompt({ goal: 'g' })));
check('㉙ 反思指令带上缺失项原文，并要求「不要宣称已完成」',
  /补安装步骤/.test(buildReflection(['补安装步骤'])) && /不要宣称已完成/.test(buildReflection(['补安装步骤'])));
check('㉚ 空缺失项 → 空指令（不注入一条没有内容的「系统提示」）', buildReflection([]) === '');
{
  const r = await runJudges({
    chatFn: async () => ({ content: '{"complete":false,"missing_items":["跑通测试"]}', usage: { prompt_tokens: 30, completion_tokens: 10 } }),
    model: { provider: { id: 1 }, model: { model_id: 'm' } }, withTimeout: straight, kinds: ['completion'],
  });
  check('㉛ 判出未完成 → missing_items 与用量都回传（judged=true）',
    r.judged === true && r.complete === false && r.missing_items[0] === '跑通测试' && r.tokens === 40 && r.calls === 1, JSON.stringify(r));
}
{
  const r = await runJudges({
    chatFn: async () => ({ content: '这不是 JSON' }),
    model: { provider: { id: 1 }, model: { model_id: 'm' } }, withTimeout: straight, kinds: ['completion'],
  });
  check('㉜ 坏输出 → judged=false（fail-open：坏输出不得被当成「已判定为完成」）',
    r.judged === false && r.complete === false && r.calls === 1, JSON.stringify(r));
}
{
  const r = await runJudges({
    chatFn: async () => { throw new Error('炸了'); },
    model: { provider: { id: 1 }, model: { model_id: 'm' } }, withTimeout: straight, kinds: ['completion'],
  });
  check('㉝ 通道抛错 → 不抛且 judged=false（Judge 无权叫停任务）', r.judged === false && r.complete === false);
}
// ── 引擎接线 ──
{
  const { calls, doneText } = await runOnce({
    acceptance: true, script: [{ content: '做完了', usage: { prompt_tokens: 10, completion_tokens: 5 } }],
    acJudge: '{"complete":false,"missing_items":["补安装步骤"]}',
  });
  const probes = calls.filter(isJudgeProbe);
  const mains = calls.filter((p) => !isJudgeProbe(p) && !/验收标准提取器/.test(String(p?.messages?.[0]?.content || '')));
  check('㉞ 判出缺失 → 反思回溯：多跑一轮（主循环轮数 = MAX_REFLECTIONS + 1）',
    mains.length === MAX_REFLECTIONS + 1, `mains=${mains.length}`);
  check('㉟ 回溯额度用尽后如实收尾：产出里写明「哪些验收项尚未确认完成」',
    /尚未确认完成/.test(doneText) && /补安装步骤/.test(doneText), String(doneText).slice(-80));
  check('㊱ Judge 调用次数有界（每轮收尾 2 次：完成度 + 正确性）',
    probes.length === (MAX_REFLECTIONS + 1) * 2, `probes=${probes.length}`);
}
{
  const { calls } = await runOnce({ acceptance: false, script: [{ content: '做完了' }] });
  check('㊲ 无 AC 时不发起 Judge（没有验收基线就无从判定，跑了只是白花钱）',
    calls.filter(isJudgeProbe).length === 0);
}
{
  // 周期性判定：跑满 JUDGE_EVERY_DEFAULT 的整数倍轮时，中途就该判一次（不等到收尾）
  const script = Array.from({ length: 5 }, () => ({
    content: '干活', tool_calls: [{ id: `c${Math.random().toString(36).slice(2)}`, function: { name: 'git_status', arguments: '{}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })).concat([{ content: '做完了', usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
  const { calls, traces, budgets } = await runOnce({ acceptance: true, script, acJudge: '{"complete":true,"missing_items":[]}' });
  const probes = calls.filter(isJudgeProbe);
  const firstProbeAt = calls.indexOf(probes[0]);
  const lastMainAt = calls.map((p, i) => (isJudgeProbe(p) ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
  check('㊳ 周期性判定在**收尾之前**就发生过（不是只在最后判一次）',
    probes.length > 0 && firstProbeAt < lastMainAt, `firstProbe=${firstProbeAt} lastMain=${lastMainAt}`);
  const rounds = traces.filter((e) => e.type === 'judge').length ? (mains_count(calls)) : 0;
  check('㊴ Judge 调用次数 ≤ ceil(轮数/N) + 2（有硬顶，不会随轮数无限增长）',
    probes.length <= Math.ceil(rounds / JUDGE_EVERY_DEFAULT) + 2, `probes=${probes.length} rounds=${rounds}`);
  const last = budgets[budgets.length - 1];
  check('㊵ Judge 用量独立记账（终态快照带 judgeTokens/judgeCalls，不与主循环混账）',
    Number(last?.judgeTokens) > 0 && Number(last?.judgeCalls) === probes.length,
    `judgeTokens=${last?.judgeTokens} judgeCalls=${last?.judgeCalls} probes=${probes.length}`);
}

// ── G. AC 满足率（M5）：只认 Judge 真判过的数 ──
{
  const { budgets } = await runOnce({
    acceptance: true, script: [{ content: '做完了', usage: { prompt_tokens: 10, completion_tokens: 5 } }],
    acJudge: '{"complete":false,"missing_items":["跑通 npm test"]}', totalTokenCap: 2000000,
  });
  const last = budgets[budgets.length - 1];
  // AC 共 3 条（must 2 + must_not 1），判缺 1 条 ⇒ 2/3
  check('㊶ AC 满足率 = 总数 − 缺失项（未完成的要如实扣掉）',
    last?.acTotal === 3 && last?.acSatisfied === 2, `acTotal=${last?.acTotal} acSatisfied=${last?.acSatisfied}`);
  // 2026-10-31：光有 2/3 说不清「差哪一条」。缺项数与有无事实性错误必须各自成为终态字段，
  // 否则 UI 只能说「2/3」，用户仍然不知道要不要再来一轮。
  check('㊶-1 终态带「缺几项」（judgeMissing）与「有无事实性错误」（judgeError）',
    last?.judgeMissing === 1 && last?.judgeError === false,
    `judgeMissing=${last?.judgeMissing} judgeError=${last?.judgeError}`);
  check('㊶-2 终态带额度余量（totalCap 来自入参，totalSpent 与 usage 同源）',
    Number(last?.totalCap) === 2000000 && Number(last?.totalSpent) > 0,
    `totalCap=${last?.totalCap} totalSpent=${last?.totalSpent}`);
}
{
  // Judge 判定失败（坏输出）时不得给出「3/3」——那等于替模型背书
  const { budgets } = await runOnce({
    acceptance: true, script: [{ content: '做完了', usage: { prompt_tokens: 10, completion_tokens: 5 } }],
    acJudge: '这不是 JSON',
  });
  const last = budgets[budgets.length - 1];
  check('㊷ 判定失败时 acTotal=0（UI 侧据此不渲染进度，不显示 0/0 也不显示满分）',
    last?.acTotal === 0 && last?.acSatisfied === 0, `acTotal=${last?.acTotal} acSatisfied=${last?.acSatisfied}`);
  check('㊷-1 判定失败时也不得谎报缺失项（judgeMissing 保持 0，不是「都缺」）',
    last?.judgeMissing === 0, `judgeMissing=${last?.judgeMissing}`);
}
{
  const { budgets } = await runOnce({ acceptance: false, script: [{ content: '做完了' }] });
  check('㊸ 无 AC 时不报满足率（没有基线就没有进度可言）', budgets[budgets.length - 1]?.acTotal === 0);
}

// ── H. 硬校验（2026-10-31）：用工具台账做确定性核对，**Judge 不能翻案** ──
// 设计文档 §5.3/§5.5：代码硬校验比 LLM Judge 更可靠。这里只做可机器判定的两类，
// 语义类仍交 Judge——宁可漏，不可误报（误报=对着已完成的活说「你没做」）。
{
  check('硬校验：从 AC 文本认路径（带目录/白名单扩展名），版本号不当文件',
    JSON.stringify(pathsIn('在 README.md 补充安装步骤，并更新 src/lib/a.ts'))
      === JSON.stringify(['README.md', 'src/lib/a.ts'])
    && pathsIn('升级到 v1.0.0 版本').length === 0);
  const plan = buildCheckPlan({ must: ['输出报告 report.md'], must_not: ['不要改 config/app.json'] });
  check('硬校验：must → required，must_not → forbidden',
    JSON.stringify(plan) === JSON.stringify({ required: ['report.md'], forbidden: ['config/app.json'] }), JSON.stringify(plan));
  const miss = checkAgainstLedger({ plan, ledger: [{ name: 'read_file', args: { path: 'report.md' } }] });
  check('硬校验：只有读没有写 ⇒ 判「未满足」（读不算产出，forbidden 未触碰故只报 1 条）',
    miss.failed.length === 1 && miss.checked === 2, JSON.stringify(miss.failed));
  const pass = checkAgainstLedger({ plan, ledger: [{ name: 'write_file', args: { path: 'report.md' } }] });
  check('硬校验：写了 required 且没碰 forbidden ⇒ 不报（避免误伤）',
    pass.failed.length === 0, JSON.stringify(pass.failed));
  const viol = checkAgainstLedger({ plan, ledger: [{ name: 'edit_file', args: { path: 'config/app.json' } }, { name: 'write_file', args: { path: 'report.md' } }] });
  check('硬校验：改了 must_not 点名的文件 ⇒ 报「违反」',
    viol.failed.length === 1 && viol.failed[0].includes('不要改'), JSON.stringify(viol.failed));
  check('硬校验：AC 里没有可判定的路径 ⇒ checked=0（全部交 Judge，不硬凑）',
    checkAgainstLedger({ plan: buildCheckPlan({ must: ['代码要清晰'], must_not: [] }), ledger: [] }).checked === 0);
}
{
  // 端到端：Judge 说「全满足」，但台账里没有对 AC 点名文件的写入 ⇒ 必须仍然报缺
  const { budgets, traces } = await runOnce({
    acceptance: true,
    acReply: '{"must":["产出 report.md"],"must_not":[]}',
    acJudge: '{"complete":true,"missing_items":[]}',
    script: [{ content: '做完了', usage: { prompt_tokens: 10, completion_tokens: 5 } }],
  });
  const last = budgets[budgets.length - 1];
  check('硬校验优先：Judge 判满足也翻不了台账事实（仍报 1 项未满足）',
    last?.acTotal === 1 && last?.acSatisfied === 0 && last?.judgeMissing === 1,
    `acTotal=${last?.acTotal} acSatisfied=${last?.acSatisfied} judgeMissing=${last?.judgeMissing}`);
}
{
  // 判定失败（坏输出）≠ 没有缺口：硬证据必须仍然显示，否则 acTotal=0 会让 UI 整块不渲染，
  // 用户看到的就只是「已完成」——那正是硬校验要防的那种假象。
  const { budgets } = await runOnce({
    acceptance: true,
    acReply: '{"must":["产出 report.md"],"must_not":[]}',
    acJudge: '这不是 JSON',
    script: [{ content: '做完了', usage: { prompt_tokens: 10, completion_tokens: 5 } }],
  });
  const last = budgets[budgets.length - 1];
  check('硬校验优先：Judge 判定失败时，硬证据仍要显示（acTotal=硬失败数，不是 0）',
    last?.acTotal === 1 && last?.acSatisfied === 0 && last?.judgeMissing === 1,
    `acTotal=${last?.acTotal} acSatisfied=${last?.acSatisfied} judgeMissing=${last?.judgeMissing}`);
}

// ── I. 「卡住」观测（2026-10-31，设计文档 §6.1(2)）──
// 连续两次判定的缺失项**完全相同** ⇒ 反思没让模型补齐，属于「卡住」而非「还需努力」。
// 当前只留痕（trace），不改判定、不强行停止——先让它可被看见，再谈处置（与「成功型空转只警示」同纪律）。
{
  const { traces } = await runOnce({
    acceptance: true,
    acReply: '{"must":["跑通 npm test"],"must_not":[]}',
    acJudge: '{"complete":false,"missing_items":["跑通 npm test"]}',
    script: Array.from({ length: 6 }, (_, i) => ({
      content: `第 ${i + 1} 步`,
      tool_calls: [{ id: `k${i}`, type: 'function', function: { name: 'git_status', arguments: '{}' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    })),
  });
  // 周期性判定（每 4 轮）与收尾前判定返回同一缺失项 ⇒ 至少一次 judge_stuck 留痕
  check('卡住观测：连续两次相同缺失项会在 trace 里留 judge_stuck（可复盘，不改判定）',
    traces.some((e) => e.type === 'judge_stuck' && e.n === 1),
    traces.filter((e) => e.type === 'judge_stuck').length + ' 条');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
