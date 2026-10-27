// 待用「知识快照」的会话侧暂存（M3 任务侧接线，2026-10-27）
//
// 为什么是模块级 store 而不是 props 一路透传：
//   选择器在 Composer，载荷在 useAgentRun 组装，二者之间隔着 ChatArea；而 App.jsx 已贴
//   800 行软档（不能加行）、ChatArea 743、useAgentRun 799（加两行就红）。
//   同仓已有先例：`lib/runRegistry.ts`、`lib/appState.ts` 都是模块级单例。
//
// 语义边界（刻意做窄）：
//   · 只存「下一次发送要用的快照」，不存正文、不存授权判断——那些只在主进程；
//   · 快照失效（授权变更/文档版本变化）由主进程在启动前判，失败即拒跑并给出原因，
//     本模块不尝试在渲染层判断是否仍然有效（渲染层无权判定）。
//   · 与军团派活条同构：切换会话后仍保留（「这一发发给谁 / 带哪些知识」属于当前输入框的意图）。
export interface PendingKnowledgePlan {
  planId: string;
  planHash: string;
  projectId: string | null;
  /** 快照里将被注入的片段数（来自主进程 buildContextPlan，不在渲染层重算） */
  chunkCount: number;
  /** 用户选中的文档 id，仅用于回显「N 篇」 */
  sourceIds: string[];
  createdAt: number;
}

let pending: PendingKnowledgePlan | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch { /* 订阅方异常不影响其它订阅方 */ }
  }
}

export function getPendingKnowledgePlan(): PendingKnowledgePlan | null {
  return pending;
}

export function setPendingKnowledgePlan(next: PendingKnowledgePlan | null): void {
  pending = next;
  notify();
}

export function subscribeKnowledgePlan(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 供 `useAgentRun` 一处展开使用：有快照时给出 `{ knowledgePlan: { planId, planHash } }`，
 * 否则给空对象。**只传 id + hash**：正文由主进程按快照重验后自己取，
 * 渲染层不持有、也不上传文档正文。
 */
export function pendingKnowledgePlanPayload(): Record<string, unknown> {
  if (!pending) return {};
  return { knowledgePlan: { planId: pending.planId, planHash: pending.planHash } };
}
