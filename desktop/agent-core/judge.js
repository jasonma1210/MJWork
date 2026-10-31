// 独立 Judge（完成度 / 正确性）——零依赖、零运行态，chat 由调用方注入。
//
// 为什么必须有它（设计文档 §5.2 / §5.4）：
//   「做完了没有」不能由执行者自己说了算——它看得到自己想做什么，于是容易把意图当成结果。
//   Judge 只拿到**事实**（原始目标 + 验收标准 + 工具台账 + 当前产出），
//   刻意拿不到思考过程（reasoning）：拿到就会被引擎的自我叙述带偏，独立性就没了。
//
// 三条纪律：
//   ① 输入隔离：本模块不接收、不转发 reasoning；台账只取末尾若干条（控制成本与噪声）；
//   ② 失败 fail-open：Judge 出错 / 返回坏 JSON 一律按「未判定」处理，**绝不阻塞任务**
//      （判定的价值在于纠偏，不是在于有权叫停）；
//   ③ 只报事实不改写：Judge 输出「缺哪几条」，由调用方决定是回溯续跑还是如实告知用户。
//
// 为什么从 `agent-core/index.js` 外置：行数棘轮只减不增；且判定逻辑必须能被单测直调，
// 否则「Judge 到底看到了什么」只能靠猜。

// 每隔多少轮做一次完成度判定（0 = 不判）。默认只在**有 AC** 时才判。
// 反思额度用尽后仍允许的「最后补齐」轮数（2026-10-31）：真机反馈「Judge 判 2 项未确认、
// 反思 2 次用完就收尾」，而那时代码只跑了 13/120 轮、额度过 3%——不是没力气，是被自己的反思额度停了。
// 所以反思用尽后仍给 N 次带缺失项的续跑机会；仍受轮次/token 双闸约束，不是永动机。
export const FINAL_PUSH_MAX = 2;

export const JUDGE_EVERY_DEFAULT = 4;
// 反思回溯的次数上限：Judge 说「还差」就再跑一轮，但必须有硬顶——
// 否则一个恒判「未完成」的 Judge 会把任务变成永动机（这正是要防的失控形态）。
export const MAX_REFLECTIONS = 2;
// Judge 调用的看门狗：与 AC 提取同理，它挡在轮次之间，卡住就是「卡住」。
export const JUDGE_TIMEOUT_MS = 30000;
// 台账取末尾多少条喂给 Judge（够判断「做了什么」，又不会把上下文塞满）
const LEDGER_TAIL = 12;
const OUTPUT_CHARS = 3000;

/** 完成度 Judge 的提示词：对照 AC 逐条判定，只输出 JSON。 */
export function buildJudgePrompt({ goal = '', acceptance = null, ledger = [], output = '', kind = 'completion' } = {}) {
  const acLines = [
    ...((acceptance?.must || []).map((s) => `- [必须] ${s}`)),
    ...((acceptance?.must_not || []).map((s) => `- [禁止] ${s}`)),
  ].join('\n');
  const ledgerLines = (Array.isArray(ledger) ? ledger : []).slice(-LEDGER_TAIL)
    .map((e) => {
      const name = String(e?.name || '?');
      const detail = String(e?.command || (Array.isArray(e?.paths) ? e.paths.slice(0, 3).join(', ') : '') || '').slice(0, 120);
      return `- ${name}${detail ? `：${detail}` : ''}${e?.ok === false ? '（失败）' : ''}`;
    }).join('\n');
  const facts = `【原始目标】\n${String(goal || '（未提供）').slice(0, 1000)}\n\n`
    + `【验收标准】\n${acLines || '（未提供）'}\n\n`
    + `【已执行的工具动作（最近 ${LEDGER_TAIL} 条）】\n${ledgerLines || '（无）'}\n\n`
    + `【当前产出】\n${String(output || '（尚无产出）').slice(0, OUTPUT_CHARS)}`;
  if (kind === 'correctness') {
    return `你是正确性审查者，只依据下面给出的事实判断产出是否有错，不要臆测未提供的内容。\n\n${facts}\n\n`
      + '只输出一个 JSON 对象，不要解释、不要 markdown 围栏：\n'
      + '{"has_error":true或false,"error_detail":"一句话说明错在哪；无错给空串"}';
  }
  return `你是完成度审查者，只依据下面给出的事实逐条对照验收标准，不要臆测未提供的内容。\n\n${facts}\n\n`
    + '只输出一个 JSON 对象，不要解释、不要 markdown 围栏：\n'
    + '{"complete":true或false,"missing_items":["还没做到的验收项，最多 8 条，每条 30 字以内"]}\n'
    + '注意：只有**事实能证明**已达成才算达成；产出里自称完成不算证据。';
}

/**
 * 解析 Judge 输出。坏 JSON / 废话 → null（调用方按「未判定」处理，不阻塞）。
 * @returns {{complete: boolean, missing_items: string[], has_error: boolean, error_detail: string}|null}
 */
export function parseJudge(raw) {
  let obj = raw;
  if (typeof obj === 'string') {
    const s = String(obj || '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch {
      // 论证（C-001）：返回 null 与「没有判定」同形，但不会让上层得出错误结论——
      // 调用方只区分「有没有缺失项」，两者都走「不回溯、照常收尾」这条已设计的路径。
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const missing = (Array.isArray(obj.missing_items) ? obj.missing_items : [])
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim().slice(0, 120))
    .filter((x) => x.length > 0)
    .slice(0, 8);
  return {
    complete: obj.complete === true,
    missing_items: missing,
    has_error: obj.has_error === true,
    error_detail: typeof obj.error_detail === 'string' ? obj.error_detail.slice(0, 300) : '',
  };
}

/**
 * 把 Judge 判出的缺失项写成**给执行 Agent 的反思指令**（旁路注入，不进会话历史）。
 * 为什么不直接把 Judge 的 JSON 塞进上下文：模型会把「审查意见」当成对话内容继续接话，
 * 而这里需要的是一条明确的可执行纠偏指令。
 */
export function buildReflection(missing = []) {
  const items = (Array.isArray(missing) ? missing : []).slice(0, 8);
  if (!items.length) return '';
  return '系统提示：独立审查（不看你自己的思考过程，只看已执行的事实）判定任务尚未完成，'
    + `还差以下几项：\n${items.map((s) => `- ${s}`).join('\n')}\n`
    + '请针对这几项继续执行，不要重复已完成的步骤；确实无法完成的，在最终总结里如实说明原因，'
    + '不要宣称已完成。';
}

/**
 * 跑一次或多次 Judge（kinds: ['completion'] / ['correctness']，或两者）。
 * 依赖全部注入；任何一次失败都 fail-open（不抛、不影响其它 kind）。
 *
 * @returns {{complete: boolean, missing_items: string[], has_error: boolean, error_detail: string,
 *            tokens: number, calls: number, judged: boolean}}
 */
export async function runJudges({
  chatFn, model, withTimeout, timeoutMs = JUDGE_TIMEOUT_MS,
  goal = '', acceptance = null, ledger = [], output = '', kinds = ['completion'],
} = {}) {
  const out = {
    complete: false, missing_items: [], has_error: false, error_detail: '',
    tokens: 0, calls: 0, judged: false,
  };
  if (typeof chatFn !== 'function' || !model?.provider || !model?.model) return out;
  // 2026-10-31：并行跑多个 kind。此前串行 ⇒ 收尾前「完成度 + 正确性」两次调用最坏沉默 60s
  //（各 30s 看门狗），用户体感就是「模型写完了但界面卡住」。并行后最坏 30s，成本不变。
  // 折叠仍按 kinds 原序进行，所以 missing_items 顺序、complete 合取语义与串行完全一致。
  const list = Array.isArray(kinds) ? kinds : [];
  const parts = await Promise.all(list.map(async (kind) => {
    try {
      const r = await withTimeout(chatFn({
        providerId: model.provider.id,
        isGlobal: !!model.provider.isGlobal,
        baseUrl: model.provider.base_url,
        messages: [{ role: 'user', content: buildJudgePrompt({ goal, acceptance, ledger, output, kind }) }],
        model: model.model.model_id,
        reasoningEffort: model.model.reasoning_effort || '',
        // quiet：审查结论是引擎的内部判定，不进对话正文（同 acceptance.js 的理由：
        // 不换 tag 就会被 model:delta 一路推到渲染层，用户看到一段生 JSON）。
        quiet: true,
      }), timeoutMs, '独立审查');
      return { kind, ok: true, v: parseJudge(r?.content), tokens: (Number(r?.usage?.prompt_tokens) || 0) + (Number(r?.usage?.completion_tokens) || 0) };
    } catch (e) {
      console.warn('[agent] 独立审查调用失败（不阻塞任务）:', e?.message || String(e));
      return { kind, ok: false, v: null, tokens: 0 };
    }
  }));
  for (const p of parts) {
    if (!p.ok) continue; // 调用失败：既不计费也不算判定（与串行逐个 catch 同语义）
    out.calls += 1;
    out.tokens += p.tokens;
    const v = p.v;
    if (!v) continue; // 坏输出 = 未判定（fail-open），不把它当成「已完成」
    out.judged = true;
    if (p.kind === 'correctness') {
      out.has_error = out.has_error || v.has_error;
      if (v.error_detail) out.error_detail = out.error_detail ? `${out.error_detail}；${v.error_detail}` : v.error_detail;
    } else {
      // 多个 kind 时「完成」取合取：任一处判未完成就是未完成（不给自己开后门）。
      out.complete = out.complete || v.complete;
      for (const it of v.missing_items) if (!out.missing_items.includes(it)) out.missing_items.push(it);
    }
  }
  return out;
}
