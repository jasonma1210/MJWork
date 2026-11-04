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
  /** fork 复制的消息带原文，用于识别「同一段消耗的冗余副本」（见 dedupeForkCopies） */
  content?: string;
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
  /** 该行所属会话的代表 id；合并分支后多行会共享它，不能单独当 React key */
  threadId: string;
  /** 稳定唯一行键（会话分组 + 模型），合并/拆行后都不重复 */
  key: string;
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

// 会话分支后缀：main/store/localStore.js 的 forkThread 给新会话加「 · 分支」，
// 历史上在分支上再分会反复叠加成「· 分支· 分支· 分支· 分支」。表里只认会话本身，
// 不认分支，故循环剥到干净（对历史脏数据同样有效）。
// Unicode 转义而非字面量：i18n-scan 把正则里的中文当「裸中文」，
// ui-conventions 把「•」当装饰性字形，两者都要求 renderer/src 源码零此类字面量。
// \u00b7=· \u2022=• \u5206\u652f=分支
const FORK_SUFFIX_RE = /\s*[\u00b7\u2022]\s*\u5206\u652f\s*$/u;

/** 返回不含分支后缀的会话名；空串表示「本来就没有标题」。 */
export function normalizeThreadTitle(title: unknown): string {
  let s = String(title ?? '').trim();
  for (let i = 0; i < 16; i += 1) {
    const next = s.replace(FORK_SUFFIX_RE, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * fork 会把源会话的历史消息（连 tokensInput/tokensOutput 一起）整份复制到新会话。
 * 那是同一段消耗的存储副本，不是新增消耗：若按会话合并时直接累加，一次分叉就把
 * 这段历史算第二遍，分四次就变五倍。全局消息先按指纹去重一次，
 * 使 totals / byModel / byDay / byThread 四个口径共用同一份真实消耗。
 * 指纹含 createdAt、模型、双向 token、role 与正文前缀，真实不同消息撞车的概率极低；
 * 而复制消息这几项逐个相同，必然被识别为副本。
 */
function usageFingerprint(m: UsageMessage): string {
  return [
    num(m?.createdAt), String(m?.modelName || '').trim(),
    num(m?.tokensInput), num(m?.tokensOutput), String(m?.role || ''),
    String(m?.content || '').slice(0, 120),
  ].join('\u0000');
}

export function dedupeForkCopies(messages: UsageMessage[] = []): UsageMessage[] {
  const seen = new Set<string>();
  const out: UsageMessage[] = [];
  for (const m of messages) {
    if (!m) continue;
    // 不带 usage 的消息不参与任何口径，原样保留即可（去重只针对带消耗的副本）
    if (num(m?.tokensInput) + num(m?.tokensOutput) <= 0) { out.push(m); continue; }
    const fp = usageFingerprint(m);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(m);
  }
  return out;
}

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
  // 所有口径共用同一份「真实消耗」：先剔掉 fork 复制出来的冗余副本
  const msgs = dedupeForkCopies(messages);
  const titleOf = new Map<string, UsageThread>();
  for (const t of threads) if (t && t.id) titleOf.set(String(t.id), t);

  // 2026-10-28：会话级「解析模型」——补全两处历史缺陷：
  //   ① 旧版本只给最终总结写 modelName，中间轮（占带 token 消息绝大多数）modelName 为空 ⇒
  //      模型消耗全被归到「未记录」（用户实测：明明用 deepseek，模型列却显示未记录）。
  //   ② 派单新建的会话 thread.modelName 常为空，但该会话消息里确实有模型名。
  // 解析优先级：thread.modelName → 该会话消息里按 token 最多的模型 → ''（真空才回落未记录）。
  const threadMsgModel = new Map<string, Map<string, number>>();
  for (const m of msgs) {
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
  const visibleModelOf = (m: UsageMessage, tid: string): string =>
    String(m?.modelName || '').trim()
    || resolvedModelOf.get(tid)
    || String(titleOf.get(tid)?.modelName || '').trim();

  // 会话分组键：去掉「· 分支」后缀后的会话名。分支是同一段对话的不同走向，
  // 在「会话消耗」里只认会话本身；无标题会话仍回落 threadId（既有口径，门禁 ⑤ 钉住）。
  const groupKeyOf = (tid: string): { key: string; title: string } => {
    const normalized = normalizeThreadTitle(titleOf.get(tid)?.title);
    return normalized
      ? { key: `t:${normalized}`, title: normalized }
      : { key: `id:${tid}`, title: tid };
  };

  type ModelBucket = { total: number; requests: number };
  type ThreadGroup = {
    key: string; threadId: string; title: string;
    total: number; requests: number; lastAt: number;
    models: Map<string, ModelBucket>;
  };

  const todayStart = startOfLocalDay(now);
  const windowStart = todayStart - 6 * 86400000; // 含今天，共 7 天

  let input = 0;
  let output = 0;
  let requests = 0;
  let todayTotal = 0;
  let last7Total = 0;

  const modelAgg = new Map<string, { input: number; output: number; total: number; requests: number }>();
  const dayAgg = new Map<string, { total: number; requests: number }>();
  const groupAgg = new Map<string, ThreadGroup>();

  for (const m of msgs) {
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
      const { key: gkey, title } = groupKeyOf(tid);
      const g = groupAgg.get(gkey) || {
        key: gkey, threadId: tid, title,
        total: 0, requests: 0, lastAt: 0, models: new Map<string, ModelBucket>(),
      };
      g.total += sum;
      g.requests += 1;
      if (at > g.lastAt) g.lastAt = at;
      const vm = visibleModelOf(m, tid);
      const mb = g.models.get(vm) || { total: 0, requests: 0 };
      mb.total += sum;
      mb.requests += 1;
      g.models.set(vm, mb);
      groupAgg.set(gkey, g);
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

  // 一个会话默认一行；只有确实换过模型才按模型拆成多行（用户 2026-11-04 口径：
  // 「同一个会话就显示一个，除非该会话使用了多个不同的模型才分开显示」）。
  // 拆行时每行只统计该模型的消耗，不重复计入整组总量。
  const threadRows: ThreadRow[] = [];
  for (const g of groupAgg.values()) {
    const entries = [...g.models.entries()];
    const split = entries.length > 1;
    for (const [model, mb] of entries) {
      threadRows.push({
        threadId: g.threadId,
        key: `${g.key}|${model}`,
        title: g.title,
        model,
        total: split ? mb.total : g.total,
        requests: split ? mb.requests : g.requests,
        // 组内共享组活跃时间：拆出来的几行属于同一个会话，排序时必须相邻
        lastAt: g.lastAt,
      });
    }
  }
  // 排序口径（2026-10-28 用户口径）：会话消耗按**执行顺序（最近活跃在前）**，不按消耗额。
  // 同刻按额度兜底；组内多模型行按额度降序并因 lastAt 相同而保持相邻。
  const byThread: ThreadRow[] = threadRows
    .sort((a, b) => b.lastAt - a.lastAt || b.total - a.total || a.key.localeCompare(b.key))
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
