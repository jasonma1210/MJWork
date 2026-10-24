// 判定点事件的「事件 → 视图模型」映射（纯函数，无 React / 无 DOM 依赖）
//
// 为什么单独成模块：`entry:route` / `entry:confirm` 的载荷是主进程产出的，
// 渲染层需要先把它归一成「要不要打扰用户 + 打扰成什么形态」。这段归一逻辑
// 是本设计最核心的 UX 判据（§7.3 确认点三档 + 纪律②不重复追问），必须能被
// Node 侧门禁**直接行为断言**——塞进组件就只能靠源码正则，那是假闸。
//
// 契约来源（只读核对，已与源码逐字段对齐）：
//   main/entryRuntime.js  buildRouteEvent() / buildConfirmEvent()
//   main/entryRouter.js   decideConfirmPoint() / buildConfirmPoint()
//
// ⚠ 两条必须体现的纪律：
//   ① 提示**只走 UI**：本模块不产生任何消息对象（不进消息流、不写会话历史）；
//   ② 确认卡里的子任务必须是**已拆好**的：`subtasksReady !== true` 时一律不许「可确认」。

export type EntryRouteClass =
  | 'simple_chat' | 'multi_step_single' | 'parallel_team' | 'manual_team' | 'scheduled';

export type EntryTier = 'C0' | 'C1' | 'C2' | 'none';

export interface EntrySignals {
  parallelizable?: boolean;
  sequential?: boolean;
  toolKinds?: number;
  needsCentralizedVerify?: boolean;
  estimatedSize?: number;
}

export interface EntryCost {
  teamSize?: number;
  tokenMultiple?: number;
  estimatedWallClockMs?: number;
}

export interface EntryNoticeRaw {
  type?: string;
  route?: string;
  reason?: string;
  teamSize?: number;
  tokenMultiple?: number;
}

export interface EntryRouteEvent {
  type?: string;
  conversationId?: string | null;
  route?: string;
  decidedByRule?: boolean;
  source?: string;
  confidence?: number;
  reason?: string;
  reasonSource?: string;
  tier?: string;
  ask?: boolean;
  blocked?: boolean;
  signals?: EntrySignals | null;
  notice?: EntryNoticeRaw | null;
  cost?: EntryCost | null;
  team?: { id?: string; name?: string | null } | null;
  ts?: number;
}

export interface EntrySubtask {
  id?: string;
  title?: string;
  dependsOn?: string[];
}

export interface EntryConfirmCard {
  title?: string;
  reason?: string;
  reasonSource?: string;
  subtasks?: EntrySubtask[];
  subtasksReady?: boolean;
  subtaskError?: string | null;
  signals?: EntrySignals | null;
  conservative?: boolean;
  conservativeHint?: string;
  cost?: EntryCost | null;
  actions?: string[];
  guide?: { action?: string; label?: string } | null;
  guideAction?: string;
}

export interface EntryConfirmEvent {
  type?: string;
  conversationId?: string | null;
  goal?: string;
  route?: string;
  card?: EntryConfirmCard | null;
  ts?: number;
}

/** 顶部提示条（升级 / 降级 / 引导）——null = 不打扰用户 */
export interface EntryNoticeView {
  kind: 'upgrade' | 'downgrade' | 'guide';
  route: string;
  reason: string;
  reasonSource: string;
  teamSize: number;
  tokenMultiple: number;
  /** C2 引导的动作（'open_assistant_team' | 'open_assistant_scheduled'） */
  guideAction: string;
}

/** 确认卡视图（只承载**已拆好**的子任务） */
export interface EntryConfirmView {
  kind: 'confirm';
  conversationId: string | null;
  goal: string;
  route: string;
  title: string;
  reason: string;
  reasonSource: string;
  subtasks: EntrySubtask[];
  /** false ⇒ 子任务没拆好，UI 必须禁用「按这个执行」并显示 subtaskError */
  ready: boolean;
  subtaskError: string;
  signals: EntrySignals;
  conservative: boolean;
  conservativeHint: string;
  teamSize: number;
  tokenMultiple: number;
  wallClockMs: number;
}

/** C2 引导（只给跳转，不执行） */
export interface EntryGuideView {
  kind: 'guide';
  action: string;
  label: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 该事件是否属于**当前会话**。
 * 规则：无归属（conversationId 为空）⇒ 视为本窗口事件；有归属但当前没会话 ⇒ 不展示
 * （否则用户在 A 会话看到的提示可能来自 B 会话的运行，属于跨会话串台）。
 */
export function isForThread(evt: { conversationId?: string | null } | null | undefined, threadId: string | null | undefined): boolean {
  const cid = evt && evt.conversationId;
  if (cid == null || cid === '') return true;
  if (threadId == null || threadId === '') return false;
  return String(cid) === String(threadId);
}

/** 墙钟毫秒 → 分钟（向上取整，最小 1 分钟；未知/0 返回 0 表示「不展示」） */
export function wallClockMinutes(ms: unknown): number {
  const n = num(ms);
  if (n <= 0) return 0;
  return Math.max(1, Math.round(n / 60000));
}

/**
 * `entry:route` → 顶部提示条。
 *
 * 刻意**返回 null 的情况**：`type==='route_verdict'` 且无 notice —— 那是「本轮就是普通对话」，
 * 每次发送都弹一条「本轮按单 Agent 执行」会把界面变成噪音（§7.3：simple_chat/multi_step_single
 * 不问、也不提示）。C1 的告知由确认卡承担，同样不需要提示条。
 */
export function noticeOf(evt: EntryRouteEvent | null | undefined): EntryNoticeView | null {
  if (!evt) return null;
  const type = String(evt.type || '');
  const notice = evt.notice || null;
  const cost = evt.cost || null;
  const route = String(evt.route || '');
  const base = {
    route,
    reason: String(evt.reason || notice?.reason || ''),
    reasonSource: String(evt.reasonSource || ''),
    teamSize: num(cost?.teamSize ?? notice?.teamSize),
    tokenMultiple: num(cost?.tokenMultiple ?? notice?.tokenMultiple),
    guideAction: '',
  };
  if (type === 'guide' || evt.tier === 'C2') {
    // route 事件本身不带跳转动作（只有确认事件里的 card.guide 带），
    // 故按路由类别**确定性**推导：scheduled ⇒ 定时任务视图，其余 ⇒ 军团视图。
    return { ...base, kind: 'guide', guideAction: route === 'scheduled' ? 'open_assistant_scheduled' : 'open_assistant_team' };
  }
  if (type === 'upgrade' || notice?.type === 'upgrade') return { ...base, kind: 'upgrade' };
  // 降级 = 单 Agent 执行：人数/倍数**恒为 1**。刻意不取 cost —— cost 描述的是
  // 「如果升级成团队要多少」，降级后它已不适用（用它会把「单 Agent」显示成 3 人 3 倍）。
  if (type === 'downgrade' || notice?.type === 'downgrade') {
    return { ...base, kind: 'downgrade', teamSize: 1, tokenMultiple: 1 };
  }
  return null;
}

/**
 * `entry:confirm` → 确认卡 / 引导。返回 null 表示**不渲染**。
 *
 * 判据（与主进程 `buildConfirmEvent` 的形状对齐，不猜）：
 *   · 有 `card.guide` ⇒ C2 引导（只给跳转，不给「按这个执行」）；
 *   · 有 `subtasksReady` 这个键 ⇒ 真确认卡（C1 由 buildConfirmPoint 显式赋值 true/false）；
 *   · 其余 ⇒ 不是给用户确认的东西，忽略（防「确认 A 执行 B」）。
 */
export function confirmOf(evt: EntryConfirmEvent | null | undefined): EntryConfirmView | EntryGuideView | null {
  if (!evt) return null;
  const card = evt.card || null;
  if (!card) return null;
  if (card.guide) {
    return {
      kind: 'guide',
      action: String(card.guide.action || card.guideAction || ''),
      label: String(card.guide.label || ''),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(card, 'subtasksReady')) return null;
  const cost = card.cost || null;
  const signals = card.signals || {};
  return {
    kind: 'confirm',
    conversationId: evt.conversationId == null ? null : String(evt.conversationId),
    goal: String(evt.goal || ''),
    route: String(evt.route || ''),
    title: String(card.title || ''),
    reason: String(card.reason || ''),
    reasonSource: String(card.reasonSource || ''),
    subtasks: Array.isArray(card.subtasks) ? card.subtasks : [],
    ready: card.subtasksReady === true,
    subtaskError: String(card.subtaskError || ''),
    signals,
    conservative: card.conservative === true,
    conservativeHint: String(card.conservativeHint || ''),
    teamSize: num(cost?.teamSize),
    tokenMultiple: num(cost?.tokenMultiple),
    wallClockMs: num(cost?.estimatedWallClockMs),
  };
}

/** `entryChoice` 的载荷（主进程 entry:choice 的入参形状） */
export function choicePayload(
  view: { conversationId?: string | null; goal?: string } | null,
  choice: 'confirm' | 'single',
): { conversationId: string | null; goal: string; choice: 'confirm' | 'single' } {
  return {
    conversationId: view && view.conversationId != null ? String(view.conversationId) : null,
    goal: String((view && view.goal) || ''),
    choice,
  };
}

/** 子任务依赖的可读文案（无依赖返回空串，由 UI 决定要不要显示「无依赖」） */
export function dependsLabel(dependsOn: unknown): string {
  return Array.isArray(dependsOn) ? dependsOn.map(String).filter(Boolean).join(', ') : '';
}

// ── 确认卡的「按这个执行」→ teams:dispatch 载荷 ────────────────────────────────
//
// 为什么这段也要做纯函数：它是「用户确认的清单 == 实际执行的清单」这条纪律的唯一落点
// （设计文档 §7.3 纪律①）。判定「能不能派、派什么」必须可被门禁行为断言，
// 不能埋在组件的点击回调里。

export type DispatchRefusalReason =
  | 'not-ready'      // 子任务没拆好 / 清单为空
  | 'no-roster'      // 没有候选编制（军团）
  | 'roster-temp'    // 临时组队：不落 teams 表，没有 teamId，无法派活
  | 'no-team-id'     // 编制异常（kind=team 却没有 id）
  | 'no-thread'      // 没有会话可挂
  | 'no-goal';       // 目标为空（主进程会直接拒）

export interface PresetTask {
  id: string;
  title: string;
  /** ⚠ 主进程 normalizePresetTasks 要求 title 与 prompt 同时存在 */
  prompt: string;
  dependsOn: string[];
}

export interface TeamDispatchPayload {
  teamId: string;
  goal: string;
  threadId: string;
  presetTasks: PresetTask[];
  projectPath?: string;
}

export type DispatchPlanResult =
  | { ok: true; payload: TeamDispatchPayload }
  | { ok: false; reason: DispatchRefusalReason };

/** 候选编制的最小形状（与 lib/candidateRoster 的 CandidateRoster 兼容，避免循环依赖） */
export interface RosterLike {
  kind?: 'team' | 'temp';
  teamId?: string | null;
  name?: string;
}

/**
 * 组装 `teams:dispatch` 载荷；返回 discriminated union，让 UI 能对每种拒绝给出**不同**的解释文案
 * （「没有编制」和「临时编制不可派活」是两件事，不能合并成一句「无法执行」）。
 *
 * ✅ prompt 契约（2026-10-24 已由主进程侧补齐）：`buildConfirmPoint` 下发的 subtasks **已带 `prompt`**
 *   （`main/entryRouter.js`），因此这里优先用主进程给的真实子任务指令，老事件缺 `prompt` 时才回落 title。
 *   为什么必须这样：`normalizePresetTasks` 与 `planGoal` 都要求每条任务同时有 title 与 prompt，
 *   缺 prompt 会被整条过滤 ⇒ planGoal 返回「预设任务清单为空或缺少 prompt」⇒ 用户点了却没反应。
 *   回落 title 只是兼容，不要在渲染层「推导」出别的语义。
 */
export function dispatchPlanOf(args: {
  card: EntryConfirmView | null | undefined;
  roster: RosterLike | null | undefined;
  threadId?: string | null;
  projectPath?: string | null;
}): DispatchPlanResult {
  const card = args.card;
  if (!card || card.ready !== true) return { ok: false, reason: 'not-ready' };
  const roster = args.roster;
  if (!roster) return { ok: false, reason: 'no-roster' };
  if (roster.kind === 'temp') return { ok: false, reason: 'roster-temp' };
  const teamId = roster.teamId == null ? '' : String(roster.teamId);
  if (!teamId) return { ok: false, reason: 'no-team-id' };
  const threadId = args.threadId == null ? '' : String(args.threadId);
  if (!threadId) return { ok: false, reason: 'no-thread' };
  const goal = String(card.goal || '').trim();
  if (!goal) return { ok: false, reason: 'no-goal' };

  const presetTasks: PresetTask[] = (card.subtasks || [])
    .map((s, i) => {
      const title = String(s.title || '').trim();
      const id = String(s.id || '').trim() || `t${i + 1}`;
      // prompt 优先用主进程下发的真实子任务指令（卡上清单就是执行清单）；
      // 老事件没有 prompt 时回落标题——只作兼容，不要在这里「推导」出别的语义。
      const prompt = String((s as { prompt?: string }).prompt || '').trim() || title;
      return { id, title, prompt, dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [] };
    })
    .filter((s) => s.title.length > 0);
  if (!presetTasks.length) return { ok: false, reason: 'not-ready' };

  const payload: TeamDispatchPayload = { teamId, goal, threadId, presetTasks };
  const pp = args.projectPath == null ? '' : String(args.projectPath);
  if (pp) payload.projectPath = pp;
  return { ok: true, payload };
}

/** 拒绝原因 → i18n key（集中一处，避免 UI 里散落字符串开关） */
export const DISPATCH_REFUSAL_KEYS: Record<DispatchRefusalReason, string> = {
  'not-ready': 'entry.confirmNotReady',
  'no-roster': 'entry.confirmNeedsRoster',
  'roster-temp': 'entry.confirmTempBlocked',
  'no-team-id': 'entry.confirmNeedsRoster',
  'no-thread': 'entry.confirmNoThread',
  'no-goal': 'entry.confirmNoGoal',
};
