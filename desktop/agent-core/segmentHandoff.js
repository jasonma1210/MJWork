// 「撞顶前先交接」——把 token 总上限从**硬断点**改成**交接点**（2026-10-31）。
//
// 用户原话：「20M 必然撞，那在 20M 之前先完成部分任务后，输出具体的处理结果情况，以及剩余的
// 任务情况，再自动完成，让体验感更好，而不是直接强制断开。」
//
// 做法：
//   · 段内用到 `SEGMENT_HANDOFF_RATIO`（90%）→ 先把「已完成 / 待办 / 验收缺项」写成一条
//     阶段小结**落进会话**（用户随时能看到进展、也能在这一刻接管或叫停）；
//   · 然后清零本段计数、**自动进入下一段继续跑**——不需要用户打「继续」；
//   · 段数上限 `MAX_SEGMENTS`（3 段 ⇒ 任务级真实上限 = 3 × 20M）。用满才走原来的
//     「暂停而非失败」路径（落断点 + 收尾引导继续）。
//
// 为什么小结不调模型：这是「确定性事实的拼装」（台账 + 待办 + 验收缺项），一次 LLM 调用
// 换来的只是措辞——而它恰好发生在额度快用尽的时候，更不该再花一次。措辞固定、可预期，
// 也避免「总结本身把剩余额度吃掉」这种荒诞情形。

export const MAX_SEGMENTS = 3;
export const SEGMENT_HANDOFF_RATIO = 0.9;
// 小结里最多列多少条工具动作（再多用户也读不完，且要控制它进上下文后的体积）
const LEDGER_TAIL = 8;
const DIGEST_MAX_CHARS = 1600;

/**
 * 段判定（纯函数）。
 * @returns {'none'|'handoff'|'exhausted'} handoff=该交接了；exhausted=段数用满（交给上层真停）
 */
export function segmentDecision({
  totalCap = 0, segmentSpent = 0, segmentsUsed = 0,
  maxSegments = MAX_SEGMENTS, ratio = SEGMENT_HANDOFF_RATIO,
} = {}) {
  if (!(totalCap > 0) || !(ratio > 0) || ratio >= 1) return 'none';
  if (segmentSpent < totalCap * ratio) return 'none';
  return segmentsUsed < maxSegments ? 'handoff' : 'exhausted';
}

const n = (v) => Number(v) || 0;

/**
 * 拼一条阶段小结（纯函数，确定性文本）。
 * 事实来源全部是引擎已经持有的东西，不新增任何模型调用。
 */
export function buildSegmentDigest({
  segmentNo = 1, maxSegments = MAX_SEGMENTS, rounds = 0, toolCalls = 0,
  spent = 0, cap = 0, todos = [], acceptance = null, missing = 0, ledger = [],
} = {}) {
  const pct = cap > 0 ? Math.round((spent / cap) * 100) : 0;
  const lines = [
    `【阶段交接 ${segmentNo}/${maxSegments}】本段额度用到 ${pct}%（${n(spent).toLocaleString()} / ${n(cap).toLocaleString()} tokens），`
      + `已执行 ${n(rounds)} 轮、${n(toolCalls)} 个工具动作。`,
  ];

  // ① 本轮做了哪些动作（台账尾部，去重后按出现顺序）
  const seen = new Set();
  const acts = [];
  for (let i = ledger.length - 1; i >= 0 && acts.length < LEDGER_TAIL; i -= 1) {
    const e = ledger[i] || {};
    const name = String(e.name || e.tool || '').trim();
    if (!name) continue;
    const key = `${name}|${String(e.args?.path || e.args?.command || e.args?.pattern || '').slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = String(e.args?.path || e.args?.command || e.args?.pattern || '').slice(0, 80);
    acts.push(target ? `- ${name}：${target}` : `- ${name}`);
  }
  if (acts.length) lines.push(`最近动作（新→旧）：`, ...acts);

  // ② 待办清单（todo_write 的状态）
  const list = Array.isArray(todos) ? todos : [];
  if (list.length) {
    const doneCount = list.filter((t) => t?.status === 'completed').length;
    const pending = list.filter((t) => t?.status !== 'completed').slice(0, 8).map((t) => `- ${String(t?.content || '').slice(0, 80)}`);
    lines.push(`待办清单：${doneCount}/${list.length} 已完成`);
    if (pending.length) lines.push('未完成：', ...pending);
  }

  // ③ 验收缺口（AC 条数与缺失项数；没有基线就明说，不编）
  const must = Array.isArray(acceptance?.must) ? acceptance.must.length : 0;
  const mustNot = Array.isArray(acceptance?.must_not) ? acceptance.must_not.length : 0;
  const acTotal = must + mustNot;
  if (acTotal > 0) {
    lines.push(`验收标准：共 ${acTotal} 条，独立审查判定尚缺 ${n(missing)} 条。`);
  } else {
    lines.push('验收标准：本任务未建立验收基线（无 AC），阶段结论以上面的动作与待办为准。');
  }

  lines.push(`接下来：我会自动进入下一段继续完成剩余部分，不重复上面已完成的动作。`);
  const text = lines.join('\n');
  return text.length > DIGEST_MAX_CHARS ? `${text.slice(0, DIGEST_MAX_CHARS)}\n…（小结已截断）` : text;
}

/**
 * 执行一次段交接（有副作用：落库一条 assistant 消息 + 进上下文 + 写 trace）。
 * 依赖全部注入，本模块因此保持零依赖（可被单测直接驱动）。
 * @returns {{segmentNo:number, base:number, notice:string}}
 */
export async function segmentHandoffStep({
  segmentNo = 0, usageSpent = 0, baseSpent = 0, totalCap = 0, maxSegments = MAX_SEGMENTS,
  rounds = 0, toolCalls = 0, todos = [], ac = null, missing = 0, ledger = [],
  persistMessage, convo, trace,
} = {}) {
  const next = segmentNo + 1;
  // 段内用量 = 累计 − 本段起点。**基线必须回写累计值**：写段内值会让下一次交接提前触发
  //（2026-10-31 实测踩到：第 3 段只隔一轮就再次交接）。
  const spent = Math.max(0, Number(usageSpent) - Number(baseSpent));
  const digest = buildSegmentDigest({
    segmentNo: next, maxSegments, rounds, toolCalls, spent, cap: totalCap,
    todos, acceptance: ac, missing, ledger,
  });
  // 落库 + 推给 UI：这是给用户看的阶段性交付，不是内部旁路，所以**不进 quiet 通道**。
  await persistMessage?.({ role: 'assistant', content: digest });
  if (Array.isArray(convo)) convo.push({ role: 'assistant', content: digest });
  trace?.({ type: 'segment_handoff', n: next, spent: Number(spent) || 0, rounds, toolCalls });
  return {
    segmentNo: next,
    base: Number(usageSpent) || 0,
    notice: '（系统）上一段已自动交接：剩余事项见上一条【阶段交接】。请接着做没完成的部分，'
      + '不要重复已完成的工作；全部完成后输出最终总结。',
  };
}

/** 引擎里反复出现的「本次运行已用 token」口径（prompt + completion）。
 *  单独成函数只为消除重复表达式：口径一改，两处一起改。 */
export function spentOf(usage) {
  return (Number(usage?.prompt_tokens) || 0) + (Number(usage?.completion_tokens) || 0);
}
