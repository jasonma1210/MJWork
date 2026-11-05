#!/usr/bin/env node
// M6（2026-10-30）：双模式路由回归（设计文档 §2 / §2.3 / §2.5）。
//
// 背景：MJCode 此前只有手动「规划模式」。复杂目标被压进单任务 ReAct，一条主线跑到底，
// 越跑越长，最后只能靠预算闸硬停——这正是「执行一半强制退出」的上游成因之一。
//
// 本套件守五件事：
//   A. 判定词解析——模型输出形态不可控（大小写/夹解释/垃圾），解析绝不能抛；
//   B. 目标抽取——只取最后一条 user 的文本段（不把 base64 图片塞进分类提示词）；
//   C. 三态与回退——unsure / 解析不出 ⇒ plan（§2.5）；**调用失败 ⇒ 不改行为**（见论证）；
//   D. 不改执行语义——plan 只是「先出清单」，且失败绝不阻塞任务；
//   E. 接线闭合——主进程真的调用、真的落 trace、真的把判定下发到界面（跨层读到解析后的值）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildRoutePrompt, parseRoute, goalFromMessages, resolveRoute, routeGate, GOAL_MAX_CHARS, AUTO_PLAN_COOLDOWN_MS } from '../main/taskRouter.js';

const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const runnerSrc = read('main', 'agentRunner.js');
const routerSrc = read('main', 'taskRouter.js');
const mainSrc = read('main', 'main.js');
const bridgeSrc = read('renderer', 'src', 'lib', 'agent.js');
const runHookSrc = read('renderer', 'src', 'hooks', 'useAgentRun.ts');
const streamSrc = read('renderer', 'src', 'components', 'MessageStream.tsx');
const contractSrc = read('shared-ipc', 'contract.mjs');
const zhMessage = JSON.parse(read('renderer', 'src', 'i18n', 'locales', 'zh-CN', 'message.json'));
const enMessage = JSON.parse(read('renderer', 'src', 'i18n', 'locales', 'en-US', 'message.json'));

// ── A. 判定词解析 ──
check('① 裸判定词三态各通', parseRoute('single') === 'single' && parseRoute('plan') === 'plan' && parseRoute('unsure') === 'unsure');
check('② 大小写 / 空白 / 围栏都吃掉',
  parseRoute('  PLAN\n') === 'plan' && parseRoute('```\nsingle\n```') === 'single');
check('③ 夹解释时取**最先出现**的判定词（先出现的才是结论）',
  parseRoute('single：整体一条流程，不需要 plan 子任务') === 'single'
  && parseRoute('plan：可拆成多个子任务，不是 single') === 'plan');
check('④ 垃圾/空输出 → null（调用方按 unsure 处理，方向只会向 plan 靠）',
  parseRoute('') === null && parseRoute(null) === null && parseRoute('我觉得这个任务还行') === null);
// 防「子串误命中」：planning / single-handedly 这类词不该被当成判定结论
check('⑤ 词边界：不做子串匹配（planning ≠ plan）', parseRoute('planning ahead') === null);

// ── B. 目标抽取 ──
check('⑥ 取最后一条 user（历史里的旧目标不参与本轮判定）',
  goalFromMessages([{ role: 'user', content: '旧目标' }, { role: 'assistant', content: '好的' }, { role: 'user', content: '新目标' }]) === '新目标');
check('⑦ 多段 content 只取 text 段（base64 图片不进分类提示词）',
  goalFromMessages([{ role: 'user', content: [{ type: 'image', image: 'BASE64' }, { type: 'text', text: '看图说话' }] }]) === '看图说话');
check('⑧ 空历史 / 非数组 → 空串（不抛）', goalFromMessages([]) === '' && goalFromMessages(null) === '' && goalFromMessages(undefined) === '');
check('⑨ 超长目标截断到 GOAL_MAX_CHARS', goalFromMessages([{ role: 'user', content: 'x'.repeat(GOAL_MAX_CHARS + 500) }]).length === GOAL_MAX_CHARS);
check('⑩ 提示词含设计文档 §2.4 的判据原文（口径不漂移）',
  buildRoutePrompt('测试目标').includes('只输出 single / plan / unsure') && buildRoutePrompt('测试目标').includes('用户目标：测试目标'));

// ── C. 三态与回退（§2.5：拿不准默认 plan；失败不改行为）──
const model = { provider: { id: 'p', isGlobal: false, base_url: 'http://x' }, model: { model_id: 'm', reasoning_effort: '' } };
const chatOf = (text, usage = null) => async () => ({ content: text, usage });
const run = (opts) => resolveRoute({ chatFn: chatOf('single'), model, goal: '做一个任务', ...opts });

const disabled = await resolveRoute({ enabled: false, chatFn: chatOf('plan'), model, goal: 'x' });
check('⑪ 未开启 ⇒ 不判定、不改行为（source=disabled / plan=false）', disabled.plan === false && disabled.source === 'disabled' && disabled.mode === 'single');
const noGoal = await run({ enabled: true, goal: '' });
check('⑫ 无目标 ⇒ 不判定（不拿空串去问模型）', noGoal.plan === false && noGoal.source === 'no-goal');
const noChannel = await resolveRoute({ enabled: true, chatFn: null, model, goal: 'x' });
check('⑬ 无模型通道 ⇒ error 但不抛、不改行为', noChannel.plan === false && noChannel.source === 'no-channel');
const toPlan = await run({ enabled: true, chatFn: chatOf('plan') });
check('⑭ 判为 plan ⇒ plan=true（本轮改走「先出清单」）', toPlan.plan === true && toPlan.mode === 'plan' && toPlan.source === 'router');
const toSingle = await run({ enabled: true, chatFn: chatOf('single') });
check('⑮ 判为 single ⇒ plan=false（原样单任务，零行为变化）', toSingle.plan === false && toSingle.mode === 'single');
const unsure = await run({ enabled: true, chatFn: chatOf('unsure') });
check('⑯ 拿不准（unsure）⇒ 默认 plan（§2.5：误判进单任务的代价更高）', unsure.plan === true && unsure.source === 'unsure');
const garbage = await run({ enabled: true, chatFn: chatOf('我猜这个也许大概') });
check('⑰ 解析不出判定词 ⇒ 按 unsure 处理 ⇒ plan', garbage.plan === true && garbage.mode === 'unsure');
const boom = await run({ enabled: true, chatFn: async () => { throw new Error('ECONNRESET'); } });
check('⑱ 调用抛错 ⇒ 不改行为（一次抖动不该把全部任务变成只给计划）',
  boom.plan === false && boom.source === 'error' && /ECONNRESET/.test(boom.error));
const slow = await run({ enabled: true, timeoutMs: 5, chatFn: () => new Promise((r) => setTimeout(() => r({ content: 'plan' }), 60)) });
check('⑲ 看门狗超时 ⇒ 不改行为且不悬挂', slow.plan === false && slow.source === 'error' && /超时/.test(slow.error));
const billed = await run({ enabled: true, chatFn: chatOf('plan', { prompt_tokens: 120, completion_tokens: 3 }) });
check('⑳ 用量如实回传（路由也是这次运行花的钱）', billed.tokens === 123);
let seenPayload = null;
await run({ enabled: true, chatFn: async (p) => { seenPayload = p; return { content: 'single' }; } });
// 为什么这条重要：带外调用若不带 quiet，宿主就会用本 run 的 tag 把这段输出推给渲染层，
// 用户会在任务中途看到「single」这种生词条（详见 main.js 的 chat handler）。
check('㉑ 分类调用带 quiet（输出不得串进对话窗口）', seenPayload?.quiet === true);
check('㉒ 分类调用不带工具、单轮（成本可控）', Array.isArray(seenPayload?.messages) && seenPayload.messages.length === 1 && seenPayload.tools === undefined);

// ── D. 三个固定样例（设计文档 §2.3）：判定 → 执行模式 ──
// 这里用「按判据写的假分类器」驱动整条链路，验的是**管线行为**（判定 → plan 布尔 → 走不走规划），
// 不是模型本身的判断力（那个只能在真机上抽样看，不进单测）。
// 假分类器必须只看**目标段**：整段提示词里本来就写着 single/plan/unsure 的判据原文，
// 拿整段去匹配等于让判据自己命中自己（典型的「判据污染自身输入」）。
const goalIn = (prompt) => (/用户目标：([\s\S]*?)\n输出：/.exec(String(prompt)) || [, ''])[1];
const fakeClassify = (goal) => {
  if (/输出 JSON|统计|过滤/.test(goal) && !/文档|报告发我|图表/.test(goal)) return 'single';
  if (/交付|导出.*清洗|复盘文档|四件套/.test(goal)) return 'plan';
  return 'unsure';
};
const sample = async (goal) => resolveRoute({ enabled: true, model, goal, chatFn: async (p) => ({ content: fakeClassify(goalIn(p.messages[0].content)) }) });
const s1 = await sample('读取日志、过滤报错、统计、输出 JSON');
check('㉓ 样例一「读日志统计」⇒ 单任务（中间数据无独立交付价值）', s1.mode === 'single' && s1.plan === false);
const s2 = await sample('导出日志、清洗日志、做统计图表、写故障复盘文档发我');
check('㉔ 样例二「四件套交付」⇒ plan（四个独立产出，可单独验收/重跑）', s2.mode === 'plan' && s2.plan === true);
const s3 = await sample('帮我看看这个项目');
check('㉕ 样例三「模糊目标」⇒ 拿不准走 plan（先出清单，别猜）', s3.mode === 'unsure' && s3.plan === true);

// ── D2. 路由闸门（routeGate）：四条跳过原因必须各自可解释（2026-10-31 补）──
// 事故形状：plan 模式的产出是「计划」，用户要再回一句才执行。若下一句又被判 plan，
// 就变成「连环要确认」——动作模式和「每次都要手动继续」一样，只是理由不同。
{
  const now = 1_000_000;
  const g = (o) => routeGate({ now, ...o });
  check('㉖-a 未开启自动路由 ⇒ 不判（off）', g({ autoRoute: false }).reason === 'off');
  check('㉖-b 手动规划模式优先于自动路由（manual-plan，不重复判）',
    g({ autoRoute: true, planMode: true }).reason === 'manual-plan' && g({ autoRoute: true, planMode: true }).enabled === false);
  check('㉖-c 断点续跑不判（resume：方向已确认过）',
    g({ autoRoute: true, resumeContext: '断点摘要' }).reason === 'resume');
  check('㉖-d 冷却期内不判（cooldown：防连环要确认）',
    g({ autoRoute: true, lastAutoPlanAt: now - 1000 }).reason === 'cooldown');
  check('㉖-e 冷却期外恢复正常判定（不会永久失效）',
    g({ autoRoute: true, lastAutoPlanAt: now - AUTO_PLAN_COOLDOWN_MS - 1 }).enabled === true);
  check('㉖-f 首次运行（无时间戳）照常判定', g({ autoRoute: true, lastAutoPlanAt: 0 }).enabled === true);
  check('㉖-g 冷却只在**自动**判 plan 后写入，手动规划不节流',
    /if \(gate\.enabled\) \{ if \(autoPlanAt\.size > 200\) autoPlanAt\.clear\(\); autoPlanAt\.set\(convKey, Date\.now\(\)\); \}/.test(runnerSrc));
  check('㉖-h 跳过原因进 trace（事后能分辨「为什么这次没判」）', /skip: gate\.reason/.test(runnerSrc));
}

// ── E. 接线闭合（source-level；每条都对应一次「删掉即红」）──
check('㉖ 主进程在启动前调用路由，并把它接到真实 chat 通道',
  /const route = await taskRouter\.resolveRoute\(\{/.test(runnerSrc) && /chatFn: handlers\.chat,/.test(runnerSrc));
check('㉗ 判定 plan ⇒ 本轮按规划模式跑（先出清单，不动手）',
  /if \(route\.plan\) \{\s*\n\s*engineParams\.planMode = true;/.test(runnerSrc));
check('㉘ 三个跳过条件收在 routeGate 纯函数里，宿主不再自己拼条件',
  /const gate = taskRouter\.routeGate\(\{/.test(runnerSrc) && /enabled: gate\.enabled,/.test(runnerSrc));
check('㉙ 判定结果落 trace（事后能复盘「为什么这次只给了计划」）',
  /type: 'route'/.test(runnerSrc) && /runTrace\.appendTraceEvent\(runId, \{ type: 'route'/.test(runnerSrc));
check('㉚ 判定结果随 done 事件下发', /routeMode,/.test(runnerSrc) && /routeMode: z\.string\(\)\.optional\(\)/.test(contractSrc));
check('㉛ 契约登记入参 autoRoute（漏登记会被 zod strip ⇒ 路由永不生效）', /autoRoute: z\.boolean\(\)\.optional\(\)\.catch\(false\)/.test(contractSrc));
check('㉜ 渲染层显式开启自动路由', /autoRoute: true,/.test(runHookSrc));
check('㉝ 桥接层透传 routeMode', /routeMode: String\(evt\.data\.routeMode \|\| ''\)/.test(bridgeSrc));
check('㉞ runSummary 携带 routeMode（UI 不自己猜）', /routeMode: String\(meta\?\.routeMode \|\| ''\)/.test(runHookSrc));
check('㉟ 收尾条解释「为什么这次是计划」（自动 plan / unsure 两种都算）',
  /const autoPlan = summary\.routeMode === 'plan' \|\| summary\.routeMode === 'unsure';/.test(streamSrc)
  && /\{autoPlan && <span>\{tr\('message\.routeAutoPlan'\)\}<\/span>\}/.test(streamSrc));
check('㊱ message.routeAutoPlan 双语齐备', !!zhMessage.routeAutoPlan && !!enMessage.routeAutoPlan,
  `zh=${zhMessage.routeAutoPlan || '-'} / en=${enMessage.routeAutoPlan || '-'}`);
// 带外调用不得串流：**所有**引擎内部旁路调用（AC 提取 / Judge / 路由 / 上下文压缩 / 深研两处）
// 都必须带 quiet，宿主（main.js）必须真的按 quiet 换 tag —— 缺一半等于没做。
// 压缩与深研是本轮补的：它们此前一直在往对话窗口里推「摘要正文 / 子问题 JSON」，
// 属于既存缺陷（不是本轮引入），修法同样零新增行（属性内联在既有行上）。
check('㊲ 五处带外调用都带 quiet（AC / Judge / 路由 / 压缩 / 深研）',
  /quiet: true,/.test(read('agent-core', 'acceptance.js'))
  && /quiet: true,/.test(read('agent-core', 'judge.js'))
  && /quiet: true,/.test(routerSrc)
  && /withTimeout\(chatFn\(\{ quiet: true,/.test(read('agent-core', 'index.js'))
  && /reasoningEffort: ref\.model\.reasoning_effort \|\| '', quiet: true,/.test(read('agent-core', 'index.js')));
// V8（2026-11-05）：quiet 换 tag 的逻辑随「流式草稿落库」一起移进了 main/store/streamDraft.js
//（routeChat 现在是 chat 通道唯一的派发点：它要按 quiet 决定落不落草稿、并给 sender 套外壳）。
// 断言随之拆成两半，缺任一半都等于没接线：① main.js 真的经 routeChat 派发；② 该模块确实把 quiet
// 换成了 `${runId}-quiet`。只断一处会让「模块写好了但 main.js 没接」或「接了但 quiet 分支被删」蒙混过去。
check('㊳ 宿主按 quiet 换掉 stream tag（否则照旧串进对话窗口）',
  /routeChat\(chatPayload,/.test(mainSrc)
  && /chatPayload\.quiet\)[\s\S]{0,240}?\$\{runId\}-quiet/.test(read('main', 'store', 'streamDraft.js')));

// ── F. 跨层：字段过 IPC 后仍在（zod 闭合对象默认 strip，必须读解析后的 data）──
const { validateAgentRunPayload, validateAgentEvent } = await import('../shared-ipc/contract.mjs');
// 注：agent:run 载荷是 passthrough（允许新增可选字段），所以「删掉登记」不会让它红——
// 真正守住「登记了没有」的是上面的 ㉛。这条守的是另一件事：这一跳不会被拒收/改名。
const payloadOk = validateAgentRunPayload({ runId: 'r1', model, messages: [{ role: 'user', content: 'x' }], autoRoute: true });
check('㊴ autoRoute 能原样到达主进程（未被拒收；登记由 ㉛ 单独守）',
  payloadOk.ok && payloadOk.data?.autoRoute === true, JSON.stringify(payloadOk.ok ? payloadOk.data?.autoRoute : payloadOk.error));
const evtOk = validateAgentEvent({ runId: 'r1', type: 'done', data: { finalText: '完成', aborted: false, routeMode: 'plan' } });
check('㊵ routeMode 通过 IPC 后仍在（漏登记则 UI 永远看不到「自动判定」）',
  evtOk.ok && evtOk.data?.data?.routeMode === 'plan', JSON.stringify(evtOk.ok ? evtOk.data?.data : evtOk.error));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
