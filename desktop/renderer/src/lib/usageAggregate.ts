// 工作台用量聚合（2026-10-27）
//
// 为什么单独抽成纯函数模块：
//   ① 工作台要回答的是「我用了多少 token、用在哪、哪个任务最贵」——全是**聚合**，
//      聚合口径写错（比如把 user 消息也当一次请求、把 token 算两遍）界面上看不出来，
//      只会给出一个"看起来合理"的错数字。抽成纯函数才能被门禁直接喂数据验算。
//   ② 原实现把这些算法散在 api.js 里（`messages.reduce(...)` 三处），既没法测，
//      也顺带留下了一句"模型分布/活跃趋势需要服务端数据，本地不计算"的假说明——
//      而消息里本来就带 `modelName` 与 `createdAt`，本地完全可以算。
//
// 三条口径（与账本一致，别在下游再改）：
//   ① **一次请求 = 一条带 usage 的消息**（input+output > 0）。user 消息不计请求数。
//   ② **总量 = 输入 + 输出**，不做任何单价折算（全仓无价格数据）。
//   ③ 时间分桶一律按**本地日**切，7 天窗口「含今天」共 7 桶并补零，缺的天不消失。

export interface UsageMessage {
  role?: string;
  tokensInput?: number;
  tokensOutput?: number;
  modelName?: string;
  createdAt?: number;
  threadId?: string;
}

export interface UsageThread {
  id?: string;
  title?: string;
  modelName?: string;
  updatedAt?: number;
}

export interface Totals {
  input: number;
  output: number;
  total: number;
  requests: number;
  todayTotal: number;
  last7Total: number;
}

export interface ModelRow {
  model: string;
  input: number;
  output: number;
  total: number;
  requests: number;
  share: number;
}

export interface DayRow {
  key: string;
  label: string;
  total: number;
  requests: number;
}

export interface ThreadRow {
  threadId: string;
  title: string;
  model: string;
  total: number;
  requests: number;
  lastAt: number;
}

export const UNMODELED = '__unknown__';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/** 本地日零点（用于「今天/近 7 天」与按日分桶，与账本的 date(...,'localtime') 同口径） */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 聚合消息用量。`now` 必须显式传入（不要用 Date.now() 兜底），否则「今天」在测试里不可控。
 */
export function aggregateMessages(
  messages: UsageMessage[] = [],
  threads: UsageThread[] = [],
  now: number = Date.now(),
  topThreads = 8,
): { totals: Totals; byModel: ModelRow[]; byDay: DayRow[]; byThread: ThreadRow[] } {
  const titleOf = new Map<string, UsageThread>();
  for (const t of threads) if (t && t.id) titleOf.set(String(t.id), t);

  // 2026-10-28：会话级「解析模型」——补全两处历史缺陷：
  //   ① 旧版本只给最终总结写 modelName，中间轮（占带 token 消息绝大多数）modelName 为空 ⇒
  //      模型消耗全被归到「未记录」（用户实测：明明用 deepseek，模型列却显示未记录）。
  //   ② 派单新建的会话 thread.modelName 常为空，但该会话消息里确实有模型名。
  // 解析优先级：thread.modelName → 该会话消息里按 token 最多的模型 → ''（真空才回落未记录）。
  const threadMsgModel = new Map<string, Map<string, number>>();
  for (const m of messages) {
    const tid = m?.threadId ? String(m.threadId) : '';
    const mn = String(m?.modelName || '').trim();
    if (!tid || !mn) continue;
    const s = num(m?.tokensInput) + num(m?.tokensOutput);
    if (s <= 0) continue;
    const bag = threadMsgModel.get(tid) || new Map<string, number>();
    bag.set(mn, (bag.get(mn) || 0) + s);
    threadMsgModel.set(tid, bag);
  }
  const resolvedModelOf = new Map<string, string>();
  for (const [tid, bag] of threadMsgModel) {
    let best = '';
    let bestN = -1;
    for (const [mn, n] of bag) { if (n > bestN) { best = mn; bestN = n; } }
    if (best) resolvedModelOf.set(tid, best);
  }
  // 会话的「对外可见模型」：**消息解析结果优先**，thread.modelName 只作真空兜底。
  // 顺序为什么反过来了（2026-10-29）：thread.modelName 只在建会话时写一次、全程没有更新入口
  // （全仓无 updateThread），用户中途换模型后它就是一个**过期快照**；而这一行的 token 数是
  // 消息算出来的，模型列却报旧模型 —— 同一行自相矛盾。消息里的 modelName 才是每次请求的真值。
  const threadModel = (tid: string): string =>
    resolvedModelOf.get(tid) || String(titleOf.get(tid)?.modelName || '').trim();

  const todayStart = startOfLocalDay(now);
  const windowStart = todayStart - 6 * 86400000; // 含今天，共 7 天

  let input = 0;
  let output = 0;
  let requests = 0;
  let todayTotal = 0;
  let last7Total = 0;

  const modelAgg = new Map<string, { input: number; output: number; total: number; requests: number }>();
  const dayAgg = new Map<string, { total: number; requests: number }>();
  const threadAgg = new Map<string, { total: number; requests: number; lastAt: number }>();

  for (const m of messages) {
    const ti = num(m?.tokensInput);
    const to = num(m?.tokensOutput);
    const sum = ti + to;
    // ① 只把带 usage 的消息当一次请求；没有任何 token 的记录不参与任何口径
    if (sum <= 0) continue;
    const at = num(m?.createdAt) || 0;

    input += ti;
    output += to;
    requests += 1;
    if (at >= todayStart) todayTotal += sum;
    if (at >= windowStart) last7Total += sum;

    const tid = m?.threadId ? String(m.threadId) : '';
    // 缺 modelName 的历史消息归到所属会话的解析模型（而不是一律塞进「未记录」）
    const model = String(m?.modelName || '').trim() || (tid ? resolvedModelOf.get(tid) || '' : '') || UNMODELED;
    const ma = modelAgg.get(model) || { input: 0, output: 0, total: 0, requests: 0 };
    ma.input += ti; ma.output += to; ma.total += sum; ma.requests += 1;
    modelAgg.set(model, ma);

    if (at > 0) {
      const k = dayKey(at);
      const da = dayAgg.get(k) || { total: 0, requests: 0 };
      da.total += sum; da.requests += 1;
      dayAgg.set(k, da);
    }

    if (tid) {
      const ta = threadAgg.get(tid) || { total: 0, requests: 0, lastAt: 0 };
      ta.total += sum; ta.requests += 1;
      if (at > ta.lastAt) ta.lastAt = at;
      threadAgg.set(tid, ta);
    }
  }

  const total = input + output;

  const byModel: ModelRow[] = [...modelAgg.entries()]
    .map(([model, v]) => ({ model, ...v, share: total > 0 ? v.total / total : 0 }))
    .sort((a, b) => b.total - a.total);

  // 7 桶补零：横轴不随数据多少伸缩（原实现忽长忽短的根因）
  const byDay: DayRow[] = [];
  for (let i = 0; i < 7; i += 1) {
    const ts = windowStart + i * 86400000;
    const k = dayKey(ts);
    const hit = dayAgg.get(k);
    byDay.push({
      key: k,
      label: k.slice(5),
      total: hit ? hit.total : 0,
      requests: hit ? hit.requests : 0,
    });
  }

  const byThread: ThreadRow[] = [...threadAgg.entries()]
    .map(([threadId, v]) => {
      const meta = titleOf.get(threadId);
      return {
        threadId,
        title: String(meta?.title || '').trim() || threadId,
        // 会话表「模型」列：thread.modelName 常为空（派单新建会话未写），回落到会话消息里的解析模型
        model: threadModel(threadId),
        total: v.total,
        requests: v.requests,
        lastAt: v.lastAt,
      };
    })
    // 排序口径（2026-10-28 用户口径）：会话消耗按**执行顺序（最近活跃在前）**，不按消耗额。
    // 用户回看时先找「我刚才那个会话」，按额度排会把它压到中间（实测缺陷：当前会话排在第 6 位）。
    // lastAt = 该会话带 usage 消息的最大 createdAt；同刻按额度兜底（稳定），无时间戳（0）自然沉底。
    .sort((a, b) => b.lastAt - a.lastAt || b.total - a.total)
    .slice(0, Math.max(1, topThreads));

  return { totals: { input, output, total, requests, todayTotal, last7Total }, byModel, byDay, byThread };
}

export interface TaskGroupRow {
  groupId?: string;
  goal?: string;
  status?: string;
  totalTasks?: number;
  doneTasks?: number;
  failedTasks?: number;
  updatedAt?: number;
  createdAt?: number;
}

export interface TaskUsageRow {
  groupId: string;
  goal: string;
  status: string;
  done: number;
  total: number;
  failed: number;
  tokens: number;
  rounds: number;
  lastAt: number;
  /** false = 该任务没有任何配额流水（界面显示「未记录」，不能显示 0） */
  hasTokens: boolean;
}

/**
 * 任务级消耗：把「组 → 子任务 id 集合」与「taskId → tokens/rounds」对齐。
 * `taskTotals` 来自账本 `summaryDimensions:['taskId']` 的汇总（同一 asOf 快照）。
 * 关联不到的组保留在列表里但 hasTokens=false —— 缺数据要显形，不能拿 0 冒充。
 */
export function mergeTaskUsage(
  groups: TaskGroupRow[] = [],
  taskTotals: Map<string, { tokens: number; count: number }> = new Map(),
  groupTaskIds: Map<string, string[]> = new Map(),
  limit = 10,
): TaskUsageRow[] {
  const rows: TaskUsageRow[] = [];
  for (const g of groups) {
    const groupId = String(g?.groupId || '');
    if (!groupId) continue;
    const ids = groupTaskIds.get(groupId) || [];
    let tokens = 0;
    let rounds = 0;
    for (const id of ids) {
      const hit = taskTotals.get(id);
      if (hit) { tokens += hit.tokens; rounds += hit.count; }
    }
    rows.push({
      groupId,
      goal: String(g?.goal || '').trim() || groupId,
      status: String(g?.status || ''),
      done: num(g?.doneTasks),
      total: num(g?.totalTasks),
      failed: num(g?.failedTasks),
      tokens,
      rounds,
      lastAt: num(g?.updatedAt) || num(g?.createdAt),
      hasTokens: tokens > 0,
    });
  }
  // 有消耗的排前面，其余按更新时间兜底 —— 用户要「主要任务」，不是「全部任务」
  rows.sort((a, b) => (b.hasTokens ? b.tokens : -1) - (a.hasTokens ? a.tokens : -1) || b.lastAt - a.lastAt);
  return rows.slice(0, Math.max(1, limit));
}

/** 大数字缩写：≥1e6 → 1.2M，≥1e3 → 3.4K（与账本/对话内用量同一口径） */
export function fmtTokens(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
