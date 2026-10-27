// 工作台用量取数（2026-10-27）
//
// 为什么抽成 hook：
//   · 工作台要的四个数（总量 / 模型 / 每日 / 任务·会话）来自**四个不同通道**，
//     且每一个都可能缺（旧构建、权限、通道未挂）。把编排写在组件里会立刻超过
//     max-lines 软档，也会让"哪一步失败被吞掉"变得不可见。
//   · 取数纪律（沿用 LedgerPage 的做法）：**失败必须显形**。
//     总量这类主指标取不到 ⇒ status='error'（界面给重试），
//     任务/账本这类附加维度取不到 ⇒ 该区块整块卸载 + 记 warn，绝不填 0 冒充。
//
// 数据源全部是**已有通道**（不新增 IPC、不动契约）：
//   会话与消息 ← local:threads/list、local:messages/list（每条消息带 modelName / tokens / createdAt）
//   任务清单   ← tasks:list + tasks:get（子任务 id 用于和账本 taskId 对齐）
//   任务消耗   ← ledger:query 的 summaryDimensions:['taskId']（与账本页同一 asOf 口径）
//   项目水位   ← projects:quota（仍由 UsageCard 自己取，不在这里合并）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  aggregateMessages, mergeTaskUsage,
  type DayRow, type ModelRow, type ThreadRow, type Totals, type TaskUsageRow,
  type UsageMessage, type UsageThread, type TaskGroupRow,
} from '../../lib/usageAggregate';

type Bridge = Record<string, ((arg?: unknown) => Promise<unknown>) | undefined>;

interface RawThread { id?: string; title?: string; modelName?: string; updatedAt?: number }
interface RawMessage {
  threadId?: string; role?: string; modelName?: string;
  tokensInput?: number; tokensOutput?: number; createdAt?: number;
}
interface RawGroup { groupId?: string; goal?: string; status?: string; totalTasks?: number; doneTasks?: number; failedTasks?: number; updatedAt?: number; createdAt?: number }
interface RawSubTask { taskId?: string }
interface LedgerSummary {
  ok?: boolean;
  summary?: { byDimension?: Record<string, Array<{ key?: string | null; tokens?: number; count?: number }>> };
}

export interface DeskUsage {
  status: 'loading' | 'ready' | 'error';
  error: string;
  totals: Totals;
  byModel: ModelRow[];
  byDay: DayRow[];
  byThread: ThreadRow[];
  tasks: TaskUsageRow[];
  /** 任务维度的附加说明：'no-tasks' 无任务组 / 'no-ledger' 有任务但无配额流水 / '' 正常 */
  taskHint: 'no-tasks' | 'no-ledger' | '';
  /** true = 会话数超过单次扫描上限，总量只覆盖最近 maxThreads 个会话（界面必须说明） */
  truncated: boolean;
  reload: () => void;
}

const EMPTY_TOTALS: Totals = { input: 0, output: 0, total: 0, requests: 0, todayTotal: 0, last7Total: 0 };

function bridge(): Bridge {
  return (window.mjcode || {}) as unknown as Bridge;
}

export function useDeskUsage(maxThreads = 200, taskLimit = 8): DeskUsage {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [threads, setThreads] = useState<RawThread[]>([]);
  const [messages, setMessages] = useState<RawMessage[]>([]);
  const [groups, setGroups] = useState<RawGroup[]>([]);
  const [groupTaskIds, setGroupTaskIds] = useState<Map<string, string[]>>(new Map());
  const [taskTotals, setTaskTotals] = useState<Map<string, { tokens: number; count: number }>>(new Map());
  const [ledgerSeen, setLedgerSeen] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [tick, setTick] = useState(0);
  const reqId = useRef(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const id = ++reqId.current;
    const mj = bridge();
    if (!mj.localThreads || !mj.localMessages) {
      setStatus('error');
      setError('NO_BRIDGE');
      return undefined;
    }
    setStatus('loading');

    (async () => {
      // ① 会话 + 全部消息：这是「我用了多少 token」的唯一全量真实来源。
      // **归档会话也要算**：用户问的是「我用掉多少」，归档只是从侧栏收起来，
      // 不是把这段消耗作废。listThreads() 默认排除 archived，故显式再取一次并合并去重。
      const rawThreads = (await mj.localThreads!()) as RawThread[] | undefined;
      const rawArchived = mj.localArchivedThreads
        ? (await mj.localArchivedThreads()) as RawThread[] | undefined
        : undefined;
      const seen = new Set<string>();
      const list = [...(Array.isArray(rawThreads) ? rawThreads : []), ...(Array.isArray(rawArchived) ? rawArchived : [])]
        .filter((t) => {
          const id = String(t?.id || '');
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      const pages = await Promise.all(list.slice(0, maxThreads).map(async (t) => {
        const tid = String(t?.id || '');
        if (!tid) return [] as RawMessage[];
        const msgs = (await mj.localMessages!({ threadId: tid })) as RawMessage[] | undefined;
        return (Array.isArray(msgs) ? msgs : []).map((m) => ({ ...m, threadId: m?.threadId || tid }));
      }));
      if (id !== reqId.current) return;
      setThreads(list);
      setMessages(pages.flat());
      // 截断必须显形：宁可告诉用户"只统计了最近 N 个会话"，也不能给一个看起来完整的错数字
      setTruncated(list.length > maxThreads);
      setStatus('ready');
      setError('');

      // ② 任务清单（组 + 子任务 id）。失败不推翻整页：任务区块自行卸载。
      try {
        const r = (await mj.tasksList?.({ limit: taskLimit })) as { ok?: boolean; groups?: RawGroup[] } | undefined;
        const gs = Array.isArray(r?.groups) ? r!.groups! : [];
        if (id !== reqId.current) return;
        setGroups(gs);
        const idMap = new Map<string, string[]>();
        await Promise.all(gs.map(async (g) => {
          const gid = String(g?.groupId || '');
          if (!gid || !mj.tasksGet) return;
          const got = (await mj.tasksGet(gid)) as { ok?: boolean; group?: { tasks?: RawSubTask[] } } | undefined;
          const ids = (got?.group?.tasks || []).map((x) => String(x?.taskId || '')).filter(Boolean);
          if (ids.length) idMap.set(gid, ids);
        }));
        if (id !== reqId.current) return;
        setGroupTaskIds(idMap);
      } catch (e) {
        console.warn('[desk] tasks list failed (task section will unmount):', (e as Error)?.message || e);
        if (id === reqId.current) { setGroups([]); setGroupTaskIds(new Map()); }
      }

      // ③ 任务级消耗：账本 summaryDimensions:['taskId']（与账本页同一 asOf 口径）
      try {
        const r = (await mj.ledgerQuery?.({
          filters: { from: null, to: null }, limit: 1, summaryDimensions: ['taskId'],
        })) as LedgerSummary | undefined;
        if (id !== reqId.current) return;
        if (r?.ok) {
          const rows = r.summary?.byDimension?.taskId || [];
          const m = new Map<string, { tokens: number; count: number }>();
          for (const row of rows) {
            const k = row?.key == null ? '' : String(row.key);
            if (!k) continue;
            m.set(k, { tokens: Number(row.tokens) || 0, count: Number(row.count) || 0 });
          }
          setTaskTotals(m);
          setLedgerSeen(m.size > 0);
        }
      } catch (e) {
        console.warn('[desk] ledger:query failed (task usage will show as not-recorded):', (e as Error)?.message || e);
        if (id === reqId.current) { setTaskTotals(new Map()); setLedgerSeen(false); }
      }
    })().catch((e) => {
      if (id !== reqId.current) return;
      console.warn('[desk] usage load failed:', (e as Error)?.message || e);
      setStatus('error');
      setError(String((e as Error)?.message || e));
    });

    return () => { /* reqId 递增即作废旧请求（见各步骤的 id 校验） */ };
  }, [tick, maxThreads, taskLimit]);

  const agg = useMemo(
    () => aggregateMessages(messages as UsageMessage[], threads as UsageThread[], Date.now(), 8),
    [messages, threads],
  );
  const tasks = useMemo(
    () => mergeTaskUsage(groups as TaskGroupRow[], taskTotals, groupTaskIds, taskLimit),
    [groups, taskTotals, groupTaskIds, taskLimit],
  );
  const taskHint: DeskUsage['taskHint'] = tasks.length === 0
    ? 'no-tasks'
    : (ledgerSeen ? '' : 'no-ledger');

  return {
    status,
    error,
    totals: agg.totals || EMPTY_TOTALS,
    byModel: agg.byModel,
    byDay: agg.byDay,
    byThread: agg.byThread,
    tasks,
    taskHint,
    truncated,
    reload,
  };
}
