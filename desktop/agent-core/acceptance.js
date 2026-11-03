// 验收标准（Acceptance Criteria，下称 AC）提取——纯函数模块，零模型依赖、零运行态。
//
// 为什么要有它（设计文档 §5.1）：
//   长任务里「什么算完成」只存在于用户那句目标里，随着对话变长被稀释；
//   而「做完了没有」又只能由执行者自己说（自欺的温床）。AC 把这条基线在**任务开始前**
//   抽出来、固化成一份不随对话漂移的清单，供 Judge（M4）对照判定、供断点跨「继续」复用。
//
// 三条纪律：
//   ① 提取器**独立**于执行 Agent：用一次独立的小调用，输入只有用户目标，不进会话历史；
//   ② 失败一律不阻塞：坏 JSON / 超时 / 通道异常 → null（「没有 AC」也是合法状态，
//      绝不能因为提取失败就让任务发不出去——那是把可用性问题升级成故障）；
//   ③ 宁缺不造：抽不出任何一条就返回 null（空基线会让 Judge 误判「全部满足」）。
//
// 为什么从 `agent-core/index.js` 外置：行数棘轮只减不增，且这部分是纯文本处理，
// 与运行态无关——外置后可被单测直调（不必构造一次完整 run）。

export const AC_MAX_ITEMS = 8;
export const AC_MAX_ITEM_CHARS = 160;
// 目标文本上限：AC 只需要「用户要什么」，不需要整段历史。截断也保护提取调用的成本。
const AC_GOAL_CHARS = 2000;

/**
 * AC 提取的提示词。刻意要求**只输出 JSON**：
 * 提取调用没有后续轮次来纠正格式，任何解释性文字都会让解析落空。
 *
 * @param {string} goal 用户目标（取首条用户消息的纯文本）
 */
export function buildAcceptancePrompt(goal = '') {
  return `你是验收标准提取器，只输出一个 JSON 对象，不要任何解释、不要 markdown 代码围栏。

从下面的用户目标中抽取「怎样才算完成」，格式：
{"must":["必须达成的可验证结果"],"must_not":["明确禁止的行为或结果"]}

规则：
- must 每条写成**可判定的事实**（动宾短语，例如「在 README 中补充安装步骤」），不要写过程描述；
- must 最多 ${AC_MAX_ITEMS} 条、每条不超过 60 字；must_not 没有就给空数组；
- 只依据目标本身，不要臆测额外需求；
- 抽不出任何一条时输出 {"must":[],"must_not":[]}，不要编造。

用户目标：
${String(goal || '（未提供）').slice(0, AC_GOAL_CHARS)}`;
}

/**
 * 把「模型返回 / 断点里读回 / 调用方直接传入」的任意形态归一成 AC 对象。
 *
 * @param {unknown} raw 字符串（可能带 ```json 围栏、前后废话）或对象
 * @returns {{must: string[], must_not: string[]} | null} 归一结果；无有效条目返回 null
 */
export function parseAcceptance(raw) {
  let obj = raw;
  if (typeof obj === 'string') obj = extractJsonObject(obj);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const must = normalizeItems(obj.must);
  const mustNot = normalizeItems(obj.must_not);
  // 宁缺不造：一条都没有 ⇒ 视同「没提取到」，不给下游一个空的假基线。
  if (!must.length && !mustNot.length) return null;
  return { must, must_not: mustNot };
}

/** AC 是否有效（供调用方做「有没有基线可判」的判定，避免各处重复写 `.must?.length`） */
export function hasAcceptance(ac) {
  return !!ac && (Array.isArray(ac.must) || Array.isArray(ac.must_not))
    && ((ac.must || []).length > 0 || (ac.must_not || []).length > 0);
}

/** 台账/日志用的一行摘要（只给条数，不泄内容——trace 与 toast 都只需要规模） */
export function describeAcceptance(ac) {
  if (!hasAcceptance(ac)) return 'none';
  return `must=${(ac.must || []).length} must_not=${(ac.must_not || []).length}`;
}

// 本机推理端点（ollama 等）上 AC 提取的**快速失败**上限。
//
// 2026-11-03 实证（trace run-mw0avr8b-1i5hpv）：model=flint（localhost:11434，29GB），
// AC 提取吃满 20001ms 后超时失败，随后主 run 第一轮又在 90014ms 被首字节守卫杀掉。
// 也就是说：本地模型上这 20 秒是**必然浪费**——AC 只是可选的验收基线（没有它任务照跑），
// 却排在主任务之前白等一轮。这里给本地端点 8s：够快模型出结果，慢模型尽快放弃。
const LOCAL_AC_TIMEOUT_MS = 8000;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/i;

/** 该 base_url 是否本机推理端点（判定失败按云端处理，保守） */
function isLocalBaseUrl(baseUrl) {
  try {
    return LOCAL_HOST_RE.test(new URL(String(baseUrl || '')).hostname);
  } catch {
    // 空/非法 URL：无法判定 ⇒ 非本地（云端 20s 档）
    return false;
  }
}

/**
 * 决定本轮 run 的 AC：「外部给定」优先，其次「本次提取」，都没有就是「无」。
 *
 * 依赖全部由调用方注入（chatFn / model / withTimeout / timeoutMs），本模块零运行态、零副作用；
 * 唯一例外是失败时的 console.warn —— 静默失败会让「为什么没有 AC」无从排查。
 *
 * @returns {{ac: {must:string[],must_not:string[]}|null, source: 'checkpoint'|'extracted'|'none', usage: object|null}}
 */
export async function resolveAcceptance({
  enabled = false, criteria = null, chatFn, model, goal = '', withTimeout, timeoutMs = 20000,
} = {}) {
  const given = parseAcceptance(criteria);
  if (hasAcceptance(given)) return { ac: given, source: 'checkpoint', usage: null };
  if (!enabled || typeof chatFn !== 'function' || !model?.provider || !model?.model) {
    return { ac: null, source: 'none', usage: null };
  }
  const text = String(goal || '').trim();
  if (!text) return { ac: null, source: 'none', usage: null };
  // 本机端点用更短的超时（理由见文件头的 LOCAL_AC_TIMEOUT_MS）
  const effTimeout = isLocalBaseUrl(model.provider.base_url)
    ? Math.min(Number(timeoutMs) || LOCAL_AC_TIMEOUT_MS, LOCAL_AC_TIMEOUT_MS)
    : timeoutMs;
  try {
    // 与「上下文压缩救援」同构：独立 messages、不带工具、带看门狗超时。
    // 失败一律 null——AC 提取失败绝不能让任务发不出去。
    const r = await withTimeout(chatFn({
      providerId: model.provider.id,
      isGlobal: !!model.provider.isGlobal,
      baseUrl: model.provider.base_url,
      messages: [{ role: 'user', content: buildAcceptancePrompt(text) }],
      model: model.model.model_id,
      reasoningEffort: model.model.reasoning_effort || '',
      // quiet：这次调用是引擎内部的旁路判定，输出**不是给用户看的正文**。
      // 宿主据此换一个渲染层不认识的 stream tag —— 否则这段 JSON 会经 model:delta
      // 串进对话窗口（用户会在任务中途看到一段生 JSON，还以为模型答歪了）。
      quiet: true,
    }), effTimeout, '验收标准提取');
    const ac = parseAcceptance(r?.content);
    // 用量照实回给调用方累加：提取也是这次 run 花的钱，不记账等于成本失真。
    return { ac, source: hasAcceptance(ac) ? 'extracted' : 'none', usage: r?.usage || null };
  } catch (e) {
    console.warn('[agent] AC 提取失败（不阻塞任务）:', e?.message || String(e));
    return { ac: null, source: 'none', usage: null };
  }
}

// 从一段可能夹带废话的文本里取出**第一个完整的 JSON 对象**。
// 为什么不能只 `JSON.parse(text.trim())`：模型常见「好的，这是结果：\n```json\n{...}\n```」，
// 还有把 JSON 写在解释之后的。取首 `{` 到**最后一个** `}` 再解析，能覆盖绝大多数形态；
// 解析失败返回 null 交给调用方（绝不抛）。
function extractJsonObject(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    // 论证（C-001）：返回 null 与「文本里根本没有 JSON 对象」同形，但**不会让上层得出错误结论**——
    // 调用方只区分「有没有 AC」，两种情况都走「无 AC」这条已设计好的降级路径（不阻塞、不谎报）。
    // 不在这里打日志：模型输出不是合法 JSON 是常态而非异常，逐次 warn 会把真异常淹掉；
    // 需要排查时看 `resolveAcceptance` 返回的 source='none' 与 trace 里的 acceptance 事件。
    return null;
  }
}

// 条目归一：丢弃非字符串 → 去空白 → 丢空 → 截断长度 → 截断条数。
// 顺序有意义：先截断长度再截断条数，否则「8 条超长条目」会先被砍到 8 条再各自超长。
function normalizeItems(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim().slice(0, AC_MAX_ITEM_CHARS))
    .filter((x) => x.length > 0)
    .slice(0, AC_MAX_ITEMS);
}
