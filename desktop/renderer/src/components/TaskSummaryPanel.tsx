import { useCallback, useEffect, useRef, useState } from 'react';
import SubtaskTree, { type SubagentEvent } from './tools/SubtaskTree';
import PanelEmpty from './PanelEmpty';
import IconButton from './ui/IconButton';
import { IconAlert, IconBot, IconCheck, IconChevronDown, IconChevronRight, IconDot, IconList, IconSpinner, IconUsers } from './icons';
import { useI18n } from '../i18n';
import { listTodoGroups, subscribeTodoGroups, type TodoGroupRecord, type TodoGroupState } from '../lib/todoGroups';
// 运行注册表（threadId → 运行快照）：判断「此刻这个会话是否真的在跑」的唯一事实源。
import { runRegistry } from '../lib/runRegistry';

// 任务摘要面板（对标 Codex 右栏「任务摘要」）：把「这一轮任务都干了什么」收成一屏。
//
// 三部分数据源，都是既有权威通道或会话级视图数据，不新造主进程状态：
//   1. 任务组（todos）—— 2026-11-03 新增：`todo_write` 的清单在引擎里只是运行期内存，
//      历史会话根本没有落库，所以由对话内的 TodoPanel 每收到一次 todos 事件就写一条
//      会话级快照（lib/todoGroups，localStorage），这里按 updatedAt **逆序**展示；
//   2. 编排组快照 —— 主进程 tasks:list（含 thread_id / cwd 归属），事件 tasks:event 增量刷新；
//   3. 子代理 DAG —— ChatArea 上抛的 subagent 事件流（DAG 可视化由 SubtaskTree 负责）。
//
// 为什么不做成弹层：编排是长任务的常态，用户需要「边看对话边看进度」，
// 弹层会遮住正文且关掉即丢上下文（与右栏其他面板同理）。

const REFRESH_DEBOUNCE_MS = 400;

interface TaskSummaryPanelProps {
  threadId?: string | null;
  cwd?: string;
  events?: SubagentEvent[];
}

interface TaskGroupRow {
  group_id: string;
  goal?: string;
  status?: string;
  error?: string;
  thread_id?: string | null;
  cwd?: string;
  // R-15/X-3：军团归属（渲染层渲染徽标用；主进程 teamsListThreadRuns 投影，run_id = group_id）
  teamName?: string;
}

interface TasksListResult {
  ok?: boolean;
  groups?: TaskGroupRow[];
}

const KNOWN_STATUS = ['ready', 'running', 'paused', 'failed', 'done', 'cancelled'] as const;

function groupStatusKey(status?: string): string {
  return status && (KNOWN_STATUS as readonly string[]).includes(status)
    ? `agentDock.groupStatus${status[0].toUpperCase()}${status.slice(1)}`
    : '';
}

function statusTone(status?: string): string {
  if (status === 'failed') return 'text-danger';
  if (status === 'paused') return 'text-warn';
  if (status === 'running') return 'text-accent';
  return 'text-text2';
}

/** todos 任务组的四档状态 → i18n key（未知原样返回，不猜） */
const TODO_STATE_KEY: Record<TodoGroupState, string> = {
  done: 'rightPane.todoGroupDone',
  running: 'rightPane.todoGroupRunning',
  partial: 'rightPane.todoGroupPartial',
  error: 'rightPane.todoGroupError',
};

function todoStateTone(state: TodoGroupState): string {
  if (state === 'done') return 'text-success';
  if (state === 'error') return 'text-danger';
  if (state === 'running') return 'text-accent';
  return 'text-warn';
}

function clockOf(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    // 时间只是辅助信息：格式化失败不该让整块面板渲染不出来
    return '';
  }
}

/** 单条任务（组内）：完成项浅灰 + 斜体 + 贯穿删除线，与对话内的任务清单同一套语义 */
function TodoRow({ content, status, live }: { content: string; status: string; live: boolean }) {
  const done = status === 'completed';
  // live = 这一组此刻**真的在跑**。in_progress 只是引擎留下的最后状态，运行结束后不会回写，
  // 所以不能只按 status 转圈（用户实测：已强制停止，右侧仍有一排转圈）。
  const spinning = live && status === 'in_progress';
  const tone = status === 'error' ? 'text-danger' : spinning ? 'text-accent' : 'text-text2';
  return (
    <li className={`flex items-start gap-2 text-xs ${done ? 'text-text2 italic line-through opacity-80' : 'text-text'}`}>
      <span className={`shrink-0 mt-1 ${tone}`} aria-hidden="true">
        {spinning
          ? <IconSpinner size={11} className="animate-spin" />
          : done
            ? <IconCheck size={11} />
            : status === 'error'
              ? <IconAlert size={11} />
              : <IconDot size={9} />}
      </span>
      <span className="min-w-0 break-words">{content}</span>
    </li>
  );
}

/** 一个任务组卡片：组头（状态 / 进度 / 摘录 / 时间 / 折叠）+ 组内清单 */
function TodoGroupCard({ group, index, open, onToggle, runLive }: {
  group: TodoGroupRecord;
  index: number;
  open: boolean;
  onToggle: () => void;
  /** 本会话当前是否有在跑的 run（false ⇒ 残留的 running 快照按「未完成」展示，不转圈） */
  runLive: boolean;
}) {
  const { t } = useI18n();
  const summary = group.todos[0]?.content || group.runId;
  // 组状态是快照，可能停留在 running（进程被杀 / 没来得及补收尾快照）；
  // 真正的「还在跑」只有本会话的 runRegistry 知道，两者都为真才转圈。
  const live = group.state === 'running' && runLive;
  return (
    <div className="rounded-lg border border-border bg-bg">
      <div className="flex items-center gap-2 px-2 py-2">
        <span className={`text-caption shrink-0 ${todoStateTone(live ? 'running' : group.state === 'running' ? 'partial' : group.state)}`}>
          {live && <IconSpinner size={10} className="inline-block mr-1 animate-spin" />}
          {t(TODO_STATE_KEY[live ? 'running' : group.state === 'running' ? 'partial' : group.state] || 'rightPane.todoGroupPartial')}
        </span>
        <span className="text-caption text-text2 tabular-nums shrink-0">{group.doneCount}/{group.total}</span>
        {/* 组标题取首项摘录：用户认「这是哪一批活」靠的是内容，而不是 runId */}
        <span className="text-xs truncate flex-1" title={summary}>
          <span className="text-text2 tabular-nums mr-1">#{index + 1}</span>
          {summary}
        </span>
        {group.updatedAt > 0 && <span className="text-caption text-text2 shrink-0">{clockOf(group.updatedAt)}</span>}
        <IconButton
          label={open ? t('rightPane.todoGroupCollapse') : t('rightPane.todoGroupExpand')}
          ariaExpanded={open}
          onClick={onToggle}
        >
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </IconButton>
      </div>
      {open && (
        <ul className="px-2 pb-2 pt-1 space-y-1 list-none">
          {group.todos.map((item, i) => (
            <TodoRow key={`${item.status}-${i}-${item.content.slice(0, 10)}`} content={item.content} status={item.status} live={live} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function TaskSummaryPanel({ threadId = null, cwd = '', events = [] }: TaskSummaryPanelProps) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<TaskGroupRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  // 任务组（todos）：listTodoGroups 已经按 updatedAt 逆序（最新在上）
  const [todoGroups, setTodoGroups] = useState<TodoGroupRecord[]>([]);
  // 组折叠：只记用户显式操作过的；缺省时「最新一组展开、其余折叠」（列表再长也先看到当前那组）
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  // 本会话此刻是否真有 run 在跑。任务组里的 running 只是**快照**：进程被杀、停止时来不及补写，
  // 它都会永远停在 running（用户实测：已强制停止，右侧仍在转圈）。这里以注册表为准。
  const [runLive, setRunLive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    const mj = window.mjcode;
    if (!mj?.tasksList) { setLoaded(true); return; }
    try {
      const r = await mj.tasksList({ limit: 30 }) as TasksListResult | undefined;
      const list = Array.isArray(r?.groups) ? r.groups : [];
      // 归属过滤：有 thread_id 的按会话匹配；历史组（无 thread_id）按 cwd 匹配
      const mine = list.filter((g) => (g.thread_id
        ? String(g.thread_id) === String(threadId ?? '')
        : String(g.cwd || '') === String(cwd || '')));
      // R-15/X-3：军团 run 徽标——teamsListThreadRuns 是既有桥面（run_id = group_id 是
      // 「run 属于哪个团队」的唯一事实来源），一次调用拿到本会话全部军团 run 的归属，
      // 不新造 IPC 通道。查询失败按「无徽标」降级，绝不影响任务组主列表。
      // ⚠ 2026-10-28：无会话时**不得发请求**——此前传 `threadId: ''`，主进程按载荷非法拒绝
      // （"threadId 不能为空"），本面板常驻在会话区 ⇒ 每次刷新/任务事件都往调试日志打一条
      // team-debug 失败记录（用户实测的噪声来源）。空 threadId 的语义是「没有会话」，
      // 不是「查一个空会话」：跳过即可，徽标本来也无从归属。
      let teamByRun: Record<string, string> = {};
      if (threadId) {
        try {
          const tr = await mj.teamsListThreadRuns?.({ threadId }) as { runs?: Array<{ runId?: string; teamId?: string; teamName?: string }> } | undefined;
          for (const run of tr?.runs || []) {
            const rid = String(run?.runId || '');
            if (rid && run?.teamId) teamByRun[rid] = String(run.teamName || run.teamId);
          }
        } catch { /* 团队归属查询失败：本面板降级为不显示军团徽标 */ }
      }
      setGroups(mine.map((g) => {
        const team = teamByRun[String(g.group_id)];
        return team ? { ...g, teamName: team } : g;
      }));
    } catch (err) {
      console.warn('[taskSummary] load groups failed:', err);
    } finally {
      setLoaded(true);
    }
  }, [threadId, cwd]);

  useEffect(() => { refresh(); }, [refresh]);

  // 任务组订阅：会话切换即重读；同窗口内 TodoPanel 写入后立即刷新（不必等事件/轮询）
  useEffect(() => {
    const tid = String(threadId || '');
    setOpenMap({});
    setTodoGroups(listTodoGroups(tid));
    const off = subscribeTodoGroups((changed, next) => {
      if (changed === tid) setTodoGroups(next);
    });
    return off;
  }, [threadId]);

  // running 快照的活性判定：会话切换、任务组写入、编排组刷新时各重算一次。
  // 不订阅 runRegistry 是刻意的——它每秒可能被流式事件改多次，重渲染代价远大于收益；
  // 而「run 结束」必然伴随一次任务组收尾写入（TodoPanel 补快照）或 tasks:event 刷新，足够触发。
  useEffect(() => {
    const rs = threadId ? runRegistry.get(String(threadId)) : null;
    setRunLive(rs?.inFlight === true);
  }, [threadId, todoGroups, groups]);

  // 任务事件增量刷新（合并 400ms，避免高频 task_activity 打爆 IPC）
  useEffect(() => {
    const mj = window.mjcode;
    if (!mj?.onTasksEvent) return undefined;
    const off = mj.onTasksEvent(() => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { refresh(); }, REFRESH_DEBOUNCE_MS);
    }) as (() => void) | undefined;
    return () => { clearTimeout(timerRef.current); off?.(); };
  }, [refresh]);

  const hasEvents = Array.isArray(events) && events.length > 0;
  const totalGroups = todoGroups.length + groups.length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 面板头（shrink-0，与右栏其他面板头对齐 G-1；此前该头随内容滚走） */}
      <div className="px-2 h-9 border-b border-border flex items-center gap-2 shrink-0">
        <IconBot size={12} className="text-text2 shrink-0" />
        <span className="text-xs text-text2">{t('rightPane.taskGroups')}</span>
        {totalGroups > 0 && <span className="text-xs text-text2 tabular-nums">{totalGroups}</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* ── 1. 任务组（todos 快照，逆序，可折叠）── */}
        {todoGroups.length > 0 && (
          <div className="space-y-1 p-2">
            {todoGroups.map((g, i) => (
              <TodoGroupCard
                key={g.runId}
                group={g}
                index={i}
                open={openMap[g.runId] ?? i === 0}
                runLive={runLive}
                onToggle={() => setOpenMap((prev) => ({ ...prev, [g.runId]: !(prev[g.runId] ?? i === 0) }))}
              />
            ))}
          </div>
        )}

        {/* ── 2. 编排组（主进程 tasks:list；没有就不占位）── */}
        {groups.length > 0 && (
          <div className="space-y-1 p-2">
            {groups.map((g) => (
              <div key={g.group_id} className="rounded-lg border border-border bg-bg px-2 py-2">
                <div className="flex items-center gap-2">
                  <span className={`text-caption shrink-0 ${statusTone(g.status)}`}>
                    {groupStatusKey(g.status) ? t(groupStatusKey(g.status)) : g.status}
                  </span>
                  {/* R-15/X-3：军团 run 徽标——同一个任务组列表里，军团派活与自动编排
                      从此可区分（数据来自主进程团队归属投影，不新增判断逻辑） */}
                  {g.teamName && (
                    <span
                      className="text-caption shrink-0 px-2 py-1 rounded bg-accent-bg text-accent flex items-center gap-1"
                      title={t('rightPane.teamRunBadgeTip', { team: g.teamName })}
                    >
                      <IconUsers size={10} />
                      {t('rightPane.teamRunBadge')}
                    </span>
                  )}
                  <span className="text-xs truncate flex-1" title={g.goal || g.group_id}>{g.goal || g.group_id}</span>
                </div>
                {g.error && <div className="text-caption text-warn break-all mt-1">{g.error}</div>}
              </div>
            ))}
          </div>
        )}

        {/* ── 3. 两者都空 ⇒ 空态（不再只喊「暂无任务组」——告诉用户它靠什么填充）── */}
        {totalGroups === 0 && (
          <div className="px-2 py-2">
            {loaded
              ? <PanelEmpty icon={IconList} title={t('rightPane.noTaskGroup')} hint={t('rightPane.noTodoGroupHint')} />
              : <div className="text-xs text-text2">{t('rightPane.loading')}</div>}
          </div>
        )}

        {/* ── 4. 子代理 DAG / 单代理卡片 ──
            没有事件就整块不渲染：此前它与「暂无任务组」各占一个空态，两段空文案堆在一起
            （用户 2026-11-03 截图里那一屏全是"暂无…"），信息量为零还占满面板。 */}
        <div className="min-h-0">
          {hasEvents && <SubtaskTree events={events} />}
        </div>
      </div>
    </div>
  );
}
