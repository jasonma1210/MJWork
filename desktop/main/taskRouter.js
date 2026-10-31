// M6（2026-10-30）：双模式路由（设计文档 §2 / §2.5）。
//
// 为什么要它：MJCode 此前只有**手动**「规划模式」开关，复杂目标默认被压进单任务 ReAct——
// 一条主线一路跑到底。设计文档 §2 的判定不是「文字长短」，而是「这个目标适不适合切成
// 可独立验收、可单独重试、有依赖的子任务」。压错的代价是失控式的：拆不开的目标在
// 单轮里越跑越长，最后只能靠预算闸硬停（正是用户抱怨的「执行一半退出」）。
//
// 三态而不是两态（§2.5）：模型拿不准时输出 `unsure`，**默认走 plan**——
// 误判进单任务的代价（跑飞、烧穿额度）远高于误判进 plan 的代价（多一次确认）。
//
// 本模块只做判定，不改任何执行语义：调用方拿到 plan=true 后自己决定怎么用。
// 纪律：本模块的任何失败都不得阻塞任务（fail-open），且**不改动用户原本的预期**
//（详见 resolveRoute 里 error 分支的论证）。

// 8s：路由是启动前的阻塞调用，用户首字可见时间直接受它影响。
// 一个分类判定的输出只有 5 个字符，正常远小于 1s；给到 8s 只为容忍冷启动/网关抖动。
const ROUTE_TIMEOUT_MS = 8000;
// 目标文本截断：路由看的是「要交付什么」，不需要全文（超长粘贴的日志会把分类带偏）。
const GOAL_MAX_CHARS = 2000;
const ROUTE_MODES = ['single', 'plan', 'unsure'];
// 自动判 plan 之后，同一会话在这段时间内不再自动判 plan。
//
// 为什么需要它（2026-10-31 补）：plan 模式的产出是「计划」，用户必须再回一句才开始执行。
// 若下一句又被判成 plan，就会变成「连环要确认」——动作模式和用户最反感的「每次都要手动
// 继续」一样，只是理由不同。冷却期把最坏情况钉成「最多多确认一次」。
// 5 分钟：够用户读完计划再回一句，又不会把半小时后另一个复杂任务也拦掉。
const AUTO_PLAN_COOLDOWN_MS = 5 * 60 * 1000;

// 是否真的要去问模型分类。四条跳过原因各自独立可解释，且都不改变执行行为（统一按单任务跑）：
//   manual-plan 用户手动开了规划模式（尊重显式选择，不需要再判）
//   resume      断点续跑（方向已确认过，再判只会把续跑推回规划态）
//   off         宿主未开启自动路由
//   cooldown    上一轮刚自动判过 plan，避免连环确认
// 抽成纯函数的原因：这四条是「规则判定」，必须能被单测逐条钉住，而不是散在宿主里靠读代码。
function routeGate({
  autoRoute = false, planMode = false, resumeContext = '', lastAutoPlanAt = 0,
  now = Date.now(), cooldownMs = AUTO_PLAN_COOLDOWN_MS,
} = {}) {
  if (planMode) return { enabled: false, reason: 'manual-plan' };
  if (resumeContext) return { enabled: false, reason: 'resume' };
  if (!autoRoute) return { enabled: false, reason: 'off' };
  if (lastAutoPlanAt && now - lastAutoPlanAt < cooldownMs) return { enabled: false, reason: 'cooldown' };
  return { enabled: true, reason: '' };
}

// 分类器提示词：直接采用设计文档 §2.4 的模板（判据原文照搬，避免两处口径漂移）。
function buildRoutePrompt(goal = '') {
  return `你是 Agent 任务路由分类器，只输出 single / plan / unsure 三者之一，禁止额外解释。

判断规则：
plan（复杂目标）满足任意一条：
1. 任务可拆出多个有独立验收标准、独立产出的子任务，子任务间存在依赖/优先级；
2. 子任务可单独失败、单独重试、人工单独修改某一步；
3. 需要分阶段交付多个结果文件/模块。

single（单任务）必须全部符合：
1. 整体是一条连贯流程，内部多步工具调用高度耦合；
2. 中间动作没有独立交付价值，只关心最终一个结果；
3. 失败时通常整体重试，不需要单独调度其中某一步；
4. 不需要预先展示任务清单给用户确认。

unsure：上述两类都不完全符合，或信息不足以判断。

用户目标：${goal}
输出：`;
}

// 把模型输出归一成三态之一。
// 取**最先出现**的判定词：分类器被要求只输出一个词，先出现的那个就是结论；
// 后面即使还提到别的词，也是它在解释「为什么不选那个」，不应覆盖结论。
// 一个词都没有 ⇒ null（调用方按 unsure 处理，方向始终是「向 plan 靠」，不会反向放开）。
function parseRoute(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  let best = null;
  for (const mode of ROUTE_MODES) {
    const at = s.search(new RegExp(`\\b${mode}\\b`));
    if (at >= 0 && (best === null || at < best.at)) best = { mode, at };
  }
  return best ? best.mode : null;
}

// 从会话历史里取「本轮目标」：最后一条 user 消息的纯文本。
// content 可能是字符串，也可能是多段 part 数组（文本/图片/文件），只取 text 段——
// 把 base64 图片塞进分类提示词既贵又无意义。
function goalFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    const text = parts
      .map((p) => (typeof p === 'string' ? p : (p && p.type === 'text' ? p.text : '')))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text.slice(0, GOAL_MAX_CHARS);
  }
  return '';
}

// 看门狗超时：只放弃等待，底层连接由宿主自己收敛（与引擎侧 withTimeout 同语义）。
// Promise.race 会给两个分支都挂 handler，故被放弃的那一侧后续 reject 不会变成未捕获异常。
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

// 判定结果形状：{ mode, source, plan, tokens, error }
//   mode   single | plan | unsure | error（分类结果或失败态）
//   source 判定来源：disabled / explicit / router / unsure / no-goal / no-channel / error
//   plan   是否应切到「先出清单」模式 —— 调用方只看这一个布尔值
//   tokens 这次判定的用量（记账：路由也是这次运行花的钱）
async function resolveRoute({ enabled = false, chatFn, model, goal = '', timeoutMs = ROUTE_TIMEOUT_MS } = {}) {
  const out = (mode, source, plan, extra = {}) => ({ mode, source, plan: !!plan, tokens: 0, error: '', ...extra });
  if (!enabled) return out('single', 'disabled', false);
  const text = String(goal || '').trim();
  if (!text) return out('single', 'no-goal', false);
  if (typeof chatFn !== 'function' || !model?.provider || !model?.model) {
    return out('error', 'no-channel', false, { error: 'no-chat-channel' });
  }
  try {
    const r = await withTimeout(chatFn({
      providerId: model.provider.id,
      isGlobal: !!model.provider.isGlobal,
      baseUrl: model.provider.base_url,
      messages: [{ role: 'user', content: buildRoutePrompt(text) }],
      model: model.model.model_id,
      reasoningEffort: model.model.reasoning_effort || '',
      // quiet：分类输出只有 5 个字符，但它是内部判定，绝不能经 model:delta 串进对话窗口。
      quiet: true,
    }), timeoutMs, '任务路由分类');
    const mode = parseRoute(r?.content) || 'unsure';
    const tokens = (Number(r?.usage?.prompt_tokens) || 0) + (Number(r?.usage?.completion_tokens) || 0);
    return out(mode, mode === 'unsure' ? 'unsure' : 'router', mode !== 'single', { tokens });
  } catch (e) {
    // 论证（C-001）：这里的返回值会让上层得出「不切规划模式」的结论，但**不是把失败伪装成判定**——
    // source='error' 与 mode='error' 两个字段显式标记了「这次没判成」，调用方会把它写进 trace；
    // 之所以不按 §2.5 回落 plan：§2.5 说的是「模型看过目标后拿不准」（有信息），
    // 而调用失败是「没有任何判断」（无信息）。后者若一律切只读，一次网络抖动就会让所有任务
    // 变成「只给计划不动手」，那是拿一次瞬时故障换持续的体验故障。保持用户原本的预期更保守。
    console.warn('[taskRouter] 路由分类失败（不改行为，按直接执行）:', e?.message || String(e));
    return out('error', 'error', false, { error: String(e?.message || e || 'error') });
  }
}

module.exports = {
  ROUTE_TIMEOUT_MS, GOAL_MAX_CHARS, ROUTE_MODES, AUTO_PLAN_COOLDOWN_MS,
  buildRoutePrompt, parseRoute, goalFromMessages, resolveRoute, routeGate,
};
