// T2-2：运行注册表（自主进程 ChatArea.jsx 原样搬移，行为不变）——
// 运行保活的事实源：threadId → 运行状态快照（runRegistry）与 runId → 快照（runIndex）双索引。
// 多会话并行/后台运行时，流式增量与事件按标签（runId/threadId）归档，切回会话时据此恢复可见 UI。
//
// F-005（2026-10-30）：摘除文件级类型检查豁免并补类型。
// （刻意不写那个豁免指令的字面量：全仓 grep 统计「还剩几个文件豁免」时会被注释命中，导致永远归不了零。）
// 快照里的形状由 useAgentRun 就地增删（它当时还带文件级豁免），所以这里只对**本模块自己的语义**
// 负责：键名、必填性、可空性写实；形状未收敛的负载（toolCalls / finalMsg / runSummary / files）
// 标 unknown，逼消费方显式断言，而不是用一个 any 把问题静态化。

/** 收尾摘要（RunFooter 固定收尾条的数据源）。
 *  必填字段 = 三处构造点（成功 / 用户中止 / 异常）**都写**的那些——声明成可选会逼消费方
 *  到处写 `|| 0` 兜底，把契约模糊化成运行时猜测。
 *  contextTokens 只有成功分支有（引擎真实「上一轮 prompt 体积」），故可选且允许 null（≠0）。 */
export interface RunSummary {
  status: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  endedAt: number;
  contextTokens?: number | null;
}

/** 一次运行的可见状态快照。切回会话时据此重建 UI。 */
export interface RunState {
  /** 运行开始时间（epoch ms，0 = 尚未开始） */
  startedAt: number;
  /** 结束时间（epoch ms，0 = 尚未结束） */
  settledAt: number;
  /** 本轮产出文件（write_file / edit_file / apply_patch 的目标），切回时渲染成卡片 */
  files: unknown[];
  /** 结束摘要（status/durationMs/tokens/... 由 useAgentRun 装配） */
  runSummary: RunSummary | null;
  runId: string;
  threadId: string;
  /** 中止句柄；未启动或已收尾时为 null */
  controller: AbortController | null;
  /** 是否仍在跑 */
  inFlight: boolean;
  /** 是否已收尾 */
  done: boolean;
  /** 流式正文增量 */
  streaming: string;
  /** 流式思考增量 */
  reasoning: string;
  /** 已发生的工具调用轨迹 */
  toolCalls: unknown[];
  /** 完成后的最终消息 */
  finalMsg: unknown;
  /** applied=false 表示完成消息还没进过可见消息列表（切回时补挂） */
  applied: boolean;
  /** 本轮开始前的工作区基线 SHA（P1「撤回本轮」用；空串 = 当时工作区干净） */
  baselineSha: string;
  /** 引擎主动挂起时的原始信息（token 触顶/轮次上限/超时/墙钟），由 lib/runLifecycle 就地写入 */
  suspended?: unknown;
}

export const runRegistry = new Map<string, RunState>();
export const runIndex = new Map<string, RunState>();

export function makeRunState(runId: string, threadId: string): RunState {
  const rs: RunState = {
    runId, threadId, controller: null,
    inFlight: false, done: false, settledAt: 0,
    streaming: '', reasoning: '', toolCalls: [],
    finalMsg: null, applied: true,
    runSummary: null, startedAt: 0,
    files: [], baselineSha: '',
  };
  runRegistry.set(threadId, rs);
  runIndex.set(runId, rs);
  return rs;
}
