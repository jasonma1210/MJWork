// 组级三键预算闸 —— G2 预算从「提示词文案」变成「运行期强制点」
//
// 背景（第八轮审查 B-02 / 决策 D-809）：
//   `BUDGET_DEFAULTS`（max_rounds / max_tokens / max_wall_ms）此前只出现在三个地方：
//   ① 拼进 `buildTeamContext` 的提示词文案；② 派活消息 `payload.budget`；③ 审计串。
//   运行期**零强制点** —— 实际只有 per-task `timeoutMs` 一闸，组级墙钟根本不存在。
//   后果是「有预算声明、没有预算执行」：模型被告知有上限，但没有任何代码在越界时叫停。
//
//   本模块是该策略的**唯一落点**。workerPool 只保留调用点（三行），不承载任何判定逻辑 ——
//   这不是为拆文件而拆文件：workerPool 已逼近 800 行软档，预算策略本属「组级调度策略」，
//   与「怎么跑一个任务」是两件不同的事。
//
// 三键的确定性语义（判据 6.3：触达时必须是**确定性终止**，不能交给模型判断）：
//   · max_wall_ms —— 组起跑即计时；每个在途任务的超时被**夹到剩余额度**，
//                    因此整组墙钟不会超过 max_wall_ms 加一次任务启动开销。
//   · max_tokens  —— 每任务结束后累加实际用量；越界只发一次告警并**继续执行**（软上限，用户裁决）。
//   · max_rounds  —— 直接作为每个任务引擎侧的 `maxRounds`（替换原先硬编码的 20）。
//
// 设计取舍（写清楚，避免被读成缺陷）：
//   · **组预算是成本信封，不是人均配额**（2026-10-21 真机第二次修正）。
//     上一版按「剩余额度 ÷ 未终态任务数」给每个在途任务切一份硬额度，并在宿主侧逐轮硬杀；
//     真机上 4 个成员的额度被切成 44k/26k/20k…，每个成员都在写完之前被自己的份额截停，
//     4 个任务全 failed（用户看到的正是「每个成员都超过了各自最大的 token 限额给停了」）。
//     主流 Agent（Codex / Claude Code / CrewAI）不按人头切预算：组预算是用户设定的成本上限，
//     单个成员可以动用「组剩余额度」，真正的硬闸是**轮次**与**墙钟**，成本超限只做告警。
//     因此现在：planForTask 不再产出人均 share，也不返回任何宿主侧硬中止阈值
//     （tokenLimit 字段已删除），引擎侧 tokenBudget 取组剩余额度（剩余为 0 时回落历史默认值，
//     保证后续成员仍能收尾）。
//   · **令牌账在任务结束后结算**，不与引擎内部逐轮统计对齐 —— 引擎侧的 `tokenBudget`
//     管的是单任务生成侧（含压缩救援），本模块管的是组级累计，两者口径不同、互不替代。
//   · **组状态不再用 done 掩盖未执行**：有任务被 skipped（依赖失败/取消等）时，
//     finalizeGroup 落 failed 并写可读原因，避免「看板全绿、结果错误」。
//   · 无预算的组（普通编排组 `dag.runMeta` 缺失）→ 全部判定为「不设限」，零回归。

'use strict';

const { normalizeBudget } = require('./teamStore');

// groupId → { startedAt, tokens }
//   · tokens = 已结算的实际用量（在途用量在任务结束时一次性入账）。
const state = new Map();
// 软上限告警只发一次（每组）：避免每拍调度都往时间线灌同一条消息。
const notified = new Set();

// 引擎侧单任务 token 预算的默认值（历史值）：组剩余额度为 0 时回落此值，
// 避免预算耗尽的组把后续任务的引擎预算压成 0（引擎侧 0 表示关闭闸门，行为反而不可预期）。
const DEFAULT_TASK_TOKEN_BUDGET = 200000;

/** 从组对象读出预算（唯一来源：`dag.runMeta.budget`，由派活层随 dag_json 落库）。 */
function readBudget(group) {
  const raw = group && group.dag && group.dag.runMeta && group.dag.runMeta.budget;
  return normalizeBudget(raw);
}

/** 组起跑登记（幂等：重复调用不重置计时，防止重入把墙钟清零）。 */
function begin(groupId) {
  if (!groupId) return null;
  if (!state.has(groupId)) state.set(groupId, { startedAt: Date.now(), tokens: 0 });
  return state.get(groupId);
}

/** 有预算才登记（workerPool 的 runGroup 调用点：一行）。 */
function beginIfBudgeted(group) {
  const budget = readBudget(group);
  if (budget) begin(group && group.group_id);
  return budget;
}

/** 结算一个任务的 token 用量（任务结束调用；非数字静默忽略，不污染账本）。 */
function addTokens(groupId, tokens) {
  const st = begin(groupId);
  if (!st) return 0;
  const n = Number(tokens);
  if (Number.isFinite(n) && n > 0) st.tokens += n;
  return st.tokens;
}

/** 当前账面（诊断/测试用）。未 begin 过的组返回 null，不侧漏造状态。 */
function snapshotOf(groupId) {
  const st = state.get(groupId);
  if (!st) return null;
  return { startedAt: st.startedAt, tokens: st.tokens, elapsedMs: Date.now() - st.startedAt };
}

/**
 * 判定该组是否已触达预算上限。
 *
 * @param {string} groupId
 * @param {object|null} budget `readBudget()` 的产物；null ⇒ 不设限
 * @returns {{exhausted:boolean, key:string|null, message:string, remainingMs:number}}
 */
function assess(groupId, budget) {
  if (!budget) return { exhausted: false, key: null, message: '', remainingMs: Infinity };
  const st = begin(groupId) || { startedAt: Date.now(), tokens: 0 };
  const elapsed = Date.now() - st.startedAt;
  const remainingMs = Math.max(0, budget.max_wall_ms - elapsed);

  if (elapsed >= budget.max_wall_ms) {
    return {
      exhausted: true,
      key: 'max_wall_ms',
      message: `组预算耗尽：墙钟已达上限 ${budget.max_wall_ms}ms（实际 ${elapsed}ms），不再派生新任务`,
      remainingMs: 0,
    };
  }
  if (st.tokens >= budget.max_tokens) {
    return {
      exhausted: true,
      key: 'max_tokens',
      message: `组预算耗尽：token 已用 ${st.tokens} ≥ 上限 ${budget.max_tokens}，继续执行剩余任务（软上限）`,
      remainingMs,
    };
  }
  return { exhausted: false, key: null, message: '', remainingMs };
}

/**
 * 单任务的预算计划（workerPool 在装配 runOpts 前调用一次，结果复用两处）。
 *
 * @param {object} group
 * @param {object} task
 * @param {object} [opts] `{ maxRoundsFallback }` 无预算时的回退轮次（历史值 20）
 * @returns {{hasBudget:boolean, maxRounds:number, timeoutMs:number, tokenBudget:number, settle:Function}}
 */
function planForTask(group, task, opts = {}) {
  const fallback = Number(opts.maxRoundsFallback) > 0 ? Number(opts.maxRoundsFallback) : 20;
  const budget = readBudget(group);
  const taskTimeout = Number(task && task.timeoutMs) || 0;
  if (!budget) {
    return {
      hasBudget: false,
      maxRounds: fallback,
      timeoutMs: taskTimeout,
      // 无预算组沿用历史单任务预算（引擎侧行为不变）。
      tokenBudget: DEFAULT_TASK_TOKEN_BUDGET,
      settle: () => {},
    };
  }
  const groupId = group && group.group_id;
  const st = begin(groupId) || { startedAt: Date.now(), tokens: 0 };
  const wallLeft = Math.max(0, budget.max_wall_ms - (Date.now() - st.startedAt));
  // 主流口径：组预算是「成本信封」，不按人头切份额。单任务拿**组剩余额度**，
  // 已用完则回落默认值——保证后来的任务仍能收尾，而不是拿 0 额度被立刻掐断。
  // 宿主侧不再做 token 硬中止（tokenLimit 已移除）：硬闸只有 max_rounds 与墙钟。
  const remaining = Math.max(0, budget.max_tokens - st.tokens);
  let settled = false;
  return {
    hasBudget: true,
    maxRounds: budget.max_rounds,
    // 夹到组剩余额度：单任务不可能拖着整组越过 max_wall_ms。下限 1s 防「0 超时」立刻自杀。
    timeoutMs: Math.max(1000, Math.min(taskTimeout || wallLeft, wallLeft)),
    tokenBudget: remaining > 0 ? remaining : DEFAULT_TASK_TOKEN_BUDGET,
    // 结算：累加实际用量（幂等，异常路径也必须在 finally 调一次）。
    settle: (tokens) => {
      if (settled) return st.tokens;
      settled = true;
      return addTokens(groupId, tokens);
    },
  };
}

/**
 * 预算越界处置（workerPool 的泵调用点：一行）。
 *
 * 2026-10-21 用户裁决：`max_tokens` 是**软上限** —— 越界后不跳过剩余任务，只发一次可读告警，
 * 让整组继续跑完（用户要的是结果，不是被预算截断的半成品）。硬闸只有 max_rounds 与墙钟：
 * 墙钟到点仍按原语义把**未开始**任务确定性置 skipped 并停派（`true`），否则泵会一直以
 * 1s 超时续派，把剩余任务全部拖成超时失败。
 *
 * @returns {boolean} true = 本组本轮已停派（调用方 continue）
 */
function tripIfExhausted(deps, group) {
  const budget = readBudget(group);
  if (!budget || !deps || !deps.store) return false;
  const groupId = group.group_id;
  const verdict = assess(groupId, budget);
  if (!verdict.exhausted) return false;
  if (verdict.key === 'max_wall_ms') {
    const full = deps.store.getGroup(groupId) || group;
    let skipped = 0;
    for (const t of (full.tasks || [])) {
      // D4-04：墙钟耗尽时，`quota_suspend`（配额暂停）也算「未开始」——否则 isGroupSettled 把它计为
      // 未收尾，组永不 finalize（界面一直转圈）。与 abortGroup 的处置集合对齐。
      if (t.status !== 'queued' && t.status !== 'pending' && t.status !== 'quota_suspend') continue;
      deps.store.setTaskStatus(groupId, t.taskId, 'skipped', { error: verdict.message, force: true });
      deps.emit?.({ type: 'task_update', groupId, taskId: t.taskId, status: 'skipped' });
      deps.emit?.({ type: 'board_task_settled', groupId, taskId: t.taskId, status: 'skipped' });
      skipped += 1;
    }
    console.warn(`[groupBudget] ${verdict.message}；已跳过 ${skipped} 个未开始任务`);
    deps.emit?.({ type: 'group_update', groupId, status: 'running', error: verdict.message });
    return true;
  }
  if (notified.has(groupId)) return false;
  notified.add(groupId);
  console.warn(`[groupBudget] ${verdict.message}（软上限：继续执行剩余任务）`);
  deps.emit?.({ type: 'group_update', groupId, status: 'running', error: verdict.message });
  return false;
}

/** 组收尾清理（防 Map 随长会话无限增长）。 */
function clear(groupId) {
  if (groupId) { state.delete(groupId); notified.delete(groupId); }
}

/** 测试用：清空全部账本。 */
function reset() {
  state.clear();
  notified.clear();
}

module.exports = {
  readBudget, begin, beginIfBudgeted, addTokens, assess, planForTask,
  tripIfExhausted, snapshotOf, clear, reset,
};
