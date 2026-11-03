/**
 * 点「停止」时要停掉的东西，不止是当前 run。
 *
 * 2026-10-18 真机问题：编排组（orchestrate_task 派出的子 Agent）还在跑，但父 run 早已收尾
 * （`runRegistry` 里 `inFlight=false`、`abortRef` 被置 null），此时 `stop()` 会走进
 * 「既没有 controller 可 abort、也没有 ref 可 abort」的空分支 —— 点了等于没点，且没有任何提示。
 * 子 Agent 仍在后台烧 token，用户唯一的感受就是「停止按钮坏了」。
 *
 * 所以停止语义补成两件事：
 *   ① 中止当前 run（调用方负责，见 useAgentRun.stop）；
 *   ② 取消该会话下所有未结束的编排组（本模块）。
 *
 * 为什么要按 thread 过滤：编排组由 `orchestrate_task` 建组时绑定发起会话（R6），
 * 别的会话的后台组不该被这次点击误杀 —— 那正是「切页回来会话被关掉」的老毛病。
 */

import { runRegistry } from './runRegistry';

type AnyGroup = { group_id?: string; groupId?: string; status?: string; thread_id?: string | number | null };

const ACTIVE = new Set(['running', 'queued', 'pending', 'planning']);

function groupIdOf(g: AnyGroup): string {
  return String(g?.group_id || g?.groupId || '');
}

/** 从 tasks:list 的各种返回形状里取出组数组（历史上有数组 / { groups } 两种） */
function groupsOf(res: unknown): AnyGroup[] {
  if (Array.isArray(res)) return res as AnyGroup[];
  const r = res as { groups?: AnyGroup[]; items?: AnyGroup[] } | null;
  if (Array.isArray(r?.groups)) return r.groups!;
  if (Array.isArray(r?.items)) return r.items!;
  return [];
}

/**
 * 取消某会话下仍在跑的编排组。返回被取消的组数。
 * threadId 为 null 时不取消任何组（宁可少停，也不误杀其他会话的后台任务）。
 */
export async function abortGroupsForThread(threadId: string | number | null): Promise<number> {
  const api = (globalThis as { window?: { mjcode?: Record<string, unknown> } }).window?.mjcode;
  const list = api?.tasksList as ((opts?: unknown) => Promise<unknown>) | undefined;
  const abort = api?.tasksAbortGroup as ((groupId: string) => Promise<unknown>) | undefined;
  if (!list || !abort || threadId == null) return 0;
  let groups: AnyGroup[] = [];
  try {
    groups = groupsOf(await list({ includeDone: false }));
  } catch (e) {
    console.warn('[stop] list task groups failed (current run abort is unaffected):', e);
    return 0;
  }
  const mine = groups.filter((g) => {
    const gid = groupIdOf(g);
    if (!gid || !ACTIVE.has(String(g.status || ''))) return false;
    const gt = g.thread_id;
    if (gt === null || gt === undefined || gt === '') return false; // 无归属的组不冒认
    return String(gt) === String(threadId);
  });
  let n = 0;
  for (const g of mine) {
    try {
      await abort(groupIdOf(g));
      n += 1;
    } catch (e) {
      console.warn('[stop] abort task group failed:', groupIdOf(g), e);
    }
  }
  if (n > 0) console.warn(`[stop] aborted ${n} task group(s) for thread=${threadId}`);
  return n;
}

type Bridge = {
  agentAbort?: (runId: string) => Promise<unknown>;
};

/**
 * 停止某会话名下的全部运行（删除会话时调用）。
 *
 * 2026-11-03（用户反馈 3「会话被删掉，任务还在偷偷执行」）：
 * 删除只归档了 threads 表，主进程的 run 仍按自己的节奏调模型、改文件。
 * 渲染层这一侧必须同时做两件事，缺一都会留下「看不见的烧钱进程」：
 *   ① 本实例持有的 run —— 前台会话直接 abort controller（走既有的中止收尾，
 *      loading 归零、线程状态回 idle）；后台会话**只**通知主进程按 runId 中止
 *      （动它的 controller 会让本视图的 loading/流式文本被别人的收尾覆盖）；
 *   ② 该会话的编排组（子 Agent）—— 与「点停止」同一套语义，见上方模块头注。
 *
 * 主进程侧还有一道兜底（local:threads/delete → abortRunsForThread）：
 * 渲染层挂掉、或删除发生在别的窗口时，也不会剩下孤儿 run。
 *
 * @param foreground 该会话是否是「当前正在查看」的那一个
 * @returns 被中止的本窗口运行数（0 不代表没在工作：可能只在主进程侧，已由兜底处理）
 */
export function stopThreadRuns(threadId: string | number | null, foreground = false): number {
  if (threadId == null || threadId === '') return 0;
  const tid = String(threadId);
  const rs = runRegistry.get(tid);
  let n = 0;
  if (rs?.inFlight) {
    if (foreground && rs.controller) rs.controller.abort();
    else {
      const api = (globalThis as { window?: { mjcode?: Bridge } }).window?.mjcode;
      // 后台会话：只让主进程停，本地快照留给它自己的收尾路径清理
      Promise.resolve(api?.agentAbort?.(rs.runId)).catch((e: unknown) => {
        console.warn('[stop] agentAbort failed (main-side abort in thread delete still applies):', e);
      });
    }
    n += 1;
  }
  void abortGroupsForThread(tid);
  return n;
}
