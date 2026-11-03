/**
 * 任务组快照（右侧「任务摘要」的数据源）。
 *
 * 背景（2026-11-03 用户反馈）：对话里的「任务进度」只是**当前这一轮**的 todos，
 * 一轮结束就被下一轮覆盖；而右侧「任务摘要」只认 `tasks:list` 的编排组，
 * 于是普通任务（没用 orchestrate_task）在右侧永远是「暂无任务组」。
 * 用户要的是：本会话**所有**跑过的任务组，逆序、可展开、带状态。
 *
 * 为什么落在渲染层 localStorage 而不是主进程：
 *   · `todo_write` 的 todos 只存在于引擎运行期内存（agent-core 的 lastTodos），历史会话没有落库；
 *   · 这里存的是「会话级视图数据」，与会话扩展（`mj_extras_<id>`）同一性质：
 *     渲染层私域、可重建、不需要跨端同步，也不值得为它改主进程 schema；
 *   · 主进程侧已有权威数据（tasks:list 的编排组）仍走原通道，两者互不替代。
 *
 * 边界：
 *   · 每个会话最多保留 20 组（超出按 updatedAt 淘汰最旧）——避免长会话把 localStorage 撑爆；
 *   · 每组最多 20 项（与 agent-core 侧 todo_write 的上限一致，见 index.js `valid.slice(0, 20)`）；
 *   · 写入失败（配额/隐私模式）只告警：任务组看板是**附加视图**，不能反过来影响对话。
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'error';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** 任务组的展示状态：running=仍有未完成项且在跑；partial=跑完了但没做完；done=全部完成；error=有失败项 */
export type TodoGroupState = 'running' | 'done' | 'partial' | 'error';

export interface TodoGroupRecord {
  /** runId（同一 run 内多次 todo_write 会合并成一组） */
  runId: string;
  threadId: string;
  /** 首次出现时间（排序用 updatedAt，展示用 startedAt） */
  startedAt: number;
  updatedAt: number;
  todos: TodoItem[];
  doneCount: number;
  total: number;
  state: TodoGroupState;
}

const KEY_PREFIX = 'mj_todo_groups_';
const MAX_GROUPS = 20;
const MAX_ITEMS = 20;

const listeners = new Set<(threadId: string, groups: TodoGroupRecord[]) => void>();

const storage = (): Storage | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // 隐私模式 / 存储被禁：读不到就当作没有历史（不是错误）
    return null;
  }
};

/** 状态派生：error 优先（失败比"未完成"更需要被看见），其次全部完成，最后看是否还在跑 */
export function deriveGroupState(todos: TodoItem[], doneCount: number, total: number, running: boolean): TodoGroupState {
  if (todos.some((t) => t.status === 'error')) return 'error';
  if (total > 0 && doneCount >= total) return 'done';
  return running ? 'running' : 'partial';
}

/** 两组是否「同一批任务」：清单内容逐项相同（状态不参与 —— 内容才是身份） */
function sameTaskList(a: TodoItem[], b: TodoItem[]): boolean {
  if (!a.length || a.length !== b.length) return false;
  return a.every((x, i) => x.content === b[i].content);
}

function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const t of raw.slice(0, MAX_ITEMS)) {
    const content = String((t as { content?: unknown })?.content ?? '').trim();
    if (!content) continue; // 与引擎同口径：content 为空不算一项
    const s = String((t as { status?: unknown })?.status ?? 'pending');
    const status: TodoStatus = s === 'completed' || s === 'in_progress' || s === 'error' ? s : 'pending';
    out.push({ content, status });
  }
  return out;
}

function readAll(threadId: string): TodoGroupRecord[] {
  const store = storage();
  if (!store || !threadId) return [];
  try {
    const raw = store.getItem(KEY_PREFIX + threadId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 读回也要过一遍归一：手改/旧版本存档不能让面板崩掉（与 sessionExtras 同一条纪律）
    return parsed
      .filter((g) => g && typeof g === 'object' && g.runId)
      .map((g): TodoGroupRecord => {
        const todos = normalizeTodos((g as TodoGroupRecord).todos);
        const total = todos.length;
        const doneCount = todos.filter((t) => t.status === 'completed').length;
        return {
          runId: String((g as TodoGroupRecord).runId),
          threadId: String((g as TodoGroupRecord).threadId || threadId),
          startedAt: Number((g as TodoGroupRecord).startedAt) || 0,
          updatedAt: Number((g as TodoGroupRecord).updatedAt) || 0,
          todos, doneCount, total,
          state: (g as TodoGroupRecord).state || deriveGroupState(todos, doneCount, total, false),
        };
      })
      .slice(0, MAX_GROUPS);
  } catch (e) {
    console.warn('[todoGroups] read failed, treating as empty:', e instanceof Error ? e.message : e);
    return [];
  }
}

function writeAll(threadId: string, groups: TodoGroupRecord[]): void {
  const store = storage();
  if (!store || !threadId) return;
  try {
    store.setItem(KEY_PREFIX + threadId, JSON.stringify(groups.slice(0, MAX_GROUPS)));
  } catch (e) {
    // 配额超限：淘汰最旧的一半再试一次；仍失败则放弃本次写入（看板只是附加视图）
    try {
      store.setItem(KEY_PREFIX + threadId, JSON.stringify(groups.slice(0, Math.max(1, Math.floor(MAX_GROUPS / 2)))));
    } catch {
      console.warn('[todoGroups] write failed (quota/private mode), dashboard not updated:', e instanceof Error ? e.message : e);
    }
  }
}

function emit(threadId: string): void {
  const groups = listTodoGroups(threadId);
  for (const fn of listeners) {
    try {
      fn(threadId, groups);
    } catch (e) {
      console.warn('[todoGroups] subscriber threw:', e instanceof Error ? e.message : e);
    }
  }
}

/**
 * 记录一次 todos 快照（同一 runId 合并为同一组，覆盖为最新快照）。
 *
 * @param running 该 run 是否仍在跑：决定「还有 pending 项」算 running 还是 partial
 */
export function recordTodoGroup(
  threadId: string | null | undefined,
  runId: string | null | undefined,
  rawTodos: unknown,
  opts: { running?: boolean; at?: number } = {},
): void {
  const tid = String(threadId || '');
  const rid = String(runId || '');
  if (!tid || !rid) return;
  const todos = normalizeTodos(rawTodos);
  if (todos.length === 0) return; // 空清单不产生组（清空 todos 的场景不该留一个空卡片）
  const now = opts.at ?? Date.now();
  const doneCount = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const groups = readAll(tid);
  groups.sort((a, b) => b.updatedAt - a.updatedAt); // 保证 [0] 是最新一组（合并判定依赖它）
  const i = groups.findIndex((g) => g.runId === rid);
  const state = deriveGroupState(todos, doneCount, total, !!opts.running);
  if (i >= 0) {
    groups[i] = { ...groups[i], todos, doneCount, total, state, updatedAt: now };
  } else {
    // 同一任务被打断后继续，会拿到**新的 runId**：用户点「重试本轮」、超时后发「继续」、
    // 引擎从断点续跑，都会这样。内容一模一样却多出一张卡片，用户读到的就是「任务重复了」
    //（2026-11-03 实测截图：#1 与 #2 同为那 6 项、只差两分钟）。
    // 只在「最新一组尚未完成」时合并：已完成的组保留历史 —— 用户可能真的想再跑一遍同样的清单。
    const prev = groups[0];
    if (prev && prev.state !== 'done' && sameTaskList(prev.todos, todos)) {
      groups[0] = { ...prev, runId: rid, todos, doneCount, total, state, updatedAt: now };
    } else {
      groups.push({ runId: rid, threadId: tid, startedAt: now, updatedAt: now, todos, doneCount, total, state });
    }
  }
  groups.sort((a, b) => b.updatedAt - a.updatedAt);
  writeAll(tid, groups);
  emit(tid);
}

/**
 * 本会话的任务组，**按时间逆序**（最新在上）。
 *
 * 展示侧再去一次重（不只是写入侧）：存量数据里已经躺着「同一清单的未完成重复组」
 * （旧版本按 runId 建组的产物，用户实测 #1 / #2 同为那 6 项）。
 * 这里按「内容相同且两者都未完成」折叠成最新那一条 —— 不写回存储，
 * 所以不会动到已有数据；已经完成的历史组一律保留（那是真实的两次执行记录）。
 */
export function listTodoGroups(threadId: string | null | undefined): TodoGroupRecord[] {
  const tid = String(threadId || '');
  if (!tid) return [];
  const sorted = readAll(tid).sort((a, b) => b.updatedAt - a.updatedAt);
  const out: TodoGroupRecord[] = [];
  for (const g of sorted) {
    const dup = out.some((x) => x.state !== 'done' && g.state !== 'done' && sameTaskList(x.todos, g.todos));
    if (dup) continue;
    out.push(g);
  }
  return out;
}

/** 订阅任务组变化（同窗口内跨组件刷新；返回退订函数） */
export function subscribeTodoGroups(fn: (threadId: string, groups: TodoGroupRecord[]) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 清掉某会话的任务组（会话被删除时调用，避免 localStorage 留孤儿数据） */
export function clearTodoGroups(threadId: string | null | undefined): void {
  const tid = String(threadId || '');
  const store = storage();
  if (!store || !tid) return;
  try {
    store.removeItem(KEY_PREFIX + tid);
  } catch (e) {
    console.warn('[todoGroups] cleanup failed (thread already deleted; leftover is harmless):', e instanceof Error ? e.message : e);
  }
  emit(tid);
}
