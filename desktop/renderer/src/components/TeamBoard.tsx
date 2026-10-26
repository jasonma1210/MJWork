// M5 / T5-8：团队看板（对话内协同卡的「看板」入口）。
//
// 为什么需要它：对话内卡片默认折叠，只能看到「x/y 已完成」，任务为什么还没开始
//（在等谁、依赖谁）、成员此刻在做什么都不可见 → 用户反馈「完全是黑盒」。
// 这里把 run 的只读投影按状态摊成五列（待开始 / 执行中 / 等待中 / 已完成 / 失败），
// 每张卡显示认领人、依赖指向、产出摘要与错误——数据完全来自 `teams:listThreadRuns`
// 的既有投影（shared/teamStream.mjs），不新增第二套查询，也不暴露 prompt。
//
// 刷新完全交给父组件：TeamRunStream 已订阅 teams/tasks 事件并按 500ms 防抖重拉，
// 父层 card 对象变化时本组件随 props 重渲染，因此这里不再自建轮询。
import { useMemo, useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { toast } from './feedback';
import { useI18n } from '../i18n';
import { IconChevronDown, IconFile } from './icons';
import { TASK_STATUS_KEY, taskEventText, timeLabel, isPathLike, formatTokens } from '../../../shared/teamTrace.mjs';

// 任务处理轨迹（与对话内协同卡同一份投影口径）
export interface TeamBoardEvent {
  id: number;
  type: string;
  payload: {
    kind?: string;
    textKey?: string;
    textParams?: Record<string, unknown> | null;
    text?: string;
    status?: string;
    error?: string;
  } | null;
  createdAt: number;
}

export interface TeamBoardTask {
  taskId: string;
  title: string;
  status: string;
  ownerMemberId: string | null;
  ownerName: string;
  resultSummary: string;
  error: string;
  artifacts?: string[];
  events?: TeamBoardEvent[];
  dependsOn?: string[];
  critical?: boolean;
  waitingOn?: string[];
  // 预算可视化：该任务已结算消耗（运行中为 0）
  tokensUsed?: number;
}

// 组预算视图（与对话卡同源，见 shared/teamStream.mjs budgetInfoOf）
export interface TeamBoardBudget {
  maxTokens: number;
  maxRounds: number;
  maxWallMs: number;
  usedTokens: number;
  remainingTokens: number;
  percent: number;
}

export interface TeamBoardMember {
  id: string;
  name: string;
  roleKind: 'lead' | 'member';
}

export interface TeamBoardCard {
  runId: string;
  // 中断入口需要 teamId（主进程 teamInterrupt 以团队归属做权限矩阵与留痕）；
  // 普通编排组为空串，看板不显示中断按钮（走 AgentDock 的强制关闭）。
  teamId?: string;
  teamName: string;
  goal: string;
  status: string;
  progress: { total?: number } & Record<string, number>;
  // 无预算的组为 null，看板不画预算区
  budget?: TeamBoardBudget | null;
  tasks: TeamBoardTask[];
  members?: TeamBoardMember[];
}

// 列顺序 = 任务生命周期顺序；failed 列合并 skipped（两者都是「没产出」的终态）
// T6-4（§5.1）：quota_suspend 独立成列（不并入「待开始」）——它需要用户注意（追加额度或取消），
// 混进待开始会让「为什么不动了」变成黑盒。
const COLUMNS = ['pending', 'running', 'waiting', 'quota_suspend', 'done', 'failed'] as const;
type ColumnKey = typeof COLUMNS[number];

const COLUMN_STATUS: Record<ColumnKey, string[]> = {
  pending: ['pending', 'queued'],
  running: ['running'],
  waiting: ['waiting'],
  quota_suspend: ['quota_suspend'],
  done: ['done'],
  failed: ['failed', 'skipped'],
};

const COLUMN_LABEL: Record<ColumnKey, string> = {
  pending: 'teams.boardPending',
  running: 'teams.boardRunning',
  waiting: 'teams.boardWaiting',
  quota_suspend: 'teams.boardQuotaSuspend',
  done: 'teams.boardDone',
  failed: 'teams.boardFailed',
};

const COLUMN_TONE: Record<ColumnKey, string> = {
  pending: 'text-text2',
  running: 'text-accent',
  waiting: 'text-warn',
  quota_suspend: 'text-warn',
  done: 'text-success',
  failed: 'text-danger',
};

/**
 * 看板主体（无弹层）：T6-10 的工件侧面板「待办」与弹层看板共用同一份渲染，
 * 避免面板另写一套列/轨迹/中断逻辑，导致两处状态口径漂移。
 */
export function TeamBoardBody({ card, onOpenFile }: {
  card: TeamBoardCard;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of card.tasks || []) map.set(task.taskId, task.title || task.taskId);
    return map;
  }, [card]);

  const leadIds = useMemo(
    () => new Set((card.members || []).filter((m) => m.roleKind === 'lead').map((m) => m.id)),
    [card],
  );

  const columns = useMemo(() => {
    const map = new Map<ColumnKey, TeamBoardTask[]>(COLUMNS.map((key) => [key, []]));
    for (const task of card.tasks || []) {
      const key = COLUMNS.find((c) => COLUMN_STATUS[c].includes(task.status)) || 'pending';
      map.get(key)?.push(task);
    }
    return map;
  }, [card]);

  const p = card.progress || {};
  const nameOf = (ids?: string[]) => (ids || []).map((id) => titleById.get(id) || id).join(', ');

  return (
    <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs text-text2 break-words">
              <span className="text-text">{card.teamName}</span>
              {card.goal ? ` · ${card.goal}` : ''}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text2">
              <span>{t('teams.boardTotal', { n: p.total || 0 })}</span>
              <span className="text-success">{t('teams.boardDone')} {p.done || 0}</span>
              <span className="text-accent">{t('teams.boardRunning')} {p.running || 0}</span>
              <span className="text-warn">{t('teams.boardWaiting')} {p.waiting || 0}</span>
              <span className="text-warn">{t('teams.boardQuotaSuspend')} {p.quota_suspend || 0}</span>
              <span className="text-danger">{t('teams.boardFailed')} {p.failed || 0}</span>
            </div>
          </div>

          {/* 预算可视化（2026-10-21）：用量 = 已结算任务 + 主进程内存账本取大者，
              阈值与对话卡一致（70% 黄 / 90% 红），改阈值两处必须同步。 */}
          {card.budget && card.budget.maxTokens > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-caption text-text2">
                <span>{t('teams.budgetLabel')}</span>
                <span className="tabular-nums">
                  {t('teams.budgetUsed', {
                    used: formatTokens(card.budget.usedTokens),
                    max: formatTokens(card.budget.maxTokens),
                    pct: card.budget.percent,
                  })}
                  {' · '}
                  {t('teams.budgetRemaining', { remaining: formatTokens(card.budget.remainingTokens) })}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-border overflow-hidden">
                <div
                  className={`h-full ${card.budget.percent >= 90 ? 'bg-danger'
                    : card.budget.percent >= 70 ? 'bg-warn' : 'bg-accent'}`}
                  style={{ width: `${card.budget.percent}%` }}
                />
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <div className="grid grid-cols-6 gap-2 min-w-[1080px]">
              {COLUMNS.map((key) => {
                const items = columns.get(key) || [];
                return (
                  <section key={key} className="rounded-lg border border-border bg-bg/60 flex flex-col">
                    <header className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0">
                      <span className={`text-caption ${COLUMN_TONE[key]}`}>{t(COLUMN_LABEL[key])}</span>
                      <span className="text-caption text-text2">{items.length}</span>
                    </header>
                    <div className="p-2 space-y-2 min-h-[120px]">
                      {items.length === 0 && (
                        <div className="text-caption text-text2">{t('teams.boardNoTasks')}</div>
                      )}
                      {items.map((task) => (
                        <TaskCard
                          key={task.taskId}
                          task={task}
                          runId={card.runId}
                          teamId={card.teamId || ''}
                          lead={!!task.ownerMemberId && leadIds.has(task.ownerMemberId)}
                          dependsText={nameOf(task.dependsOn)}
                          waitingText={nameOf(task.waitingOn)}
                          onOpenFile={onOpenFile}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </div>
  );
}

/** 弹层形态（对话内协同卡的「看板」入口）：主体复用 TeamBoardBody。 */
export default function TeamBoard({ card, onClose, onOpenFile }: {
  card: TeamBoardCard | null;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      open={!!card}
      onClose={onClose}
      title={t('teams.boardTitle')}
      size="settings"
      className="max-w-6xl"
    >
      {card && <TeamBoardBody card={card} onOpenFile={onOpenFile} />}
    </Modal>
  );
}

// 任务终态：与 taskStore 的 TERMINAL_TASK_STATUSES 同口径（终态不可再中断）
const TERMINAL_STATUSES = ['done', 'failed', 'skipped'];

function TaskCard({ task, runId, teamId, lead, dependsText, waitingText, onOpenFile }: {
  task: TeamBoardTask;
  runId: string;
  teamId: string;
  lead: boolean;
  dependsText: string;
  waitingText: string;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  // 展开查看处理轨迹 / 完整产出 / 产物：看板此前只有三行摘要，排查时同样看不到过程。
  const [open, setOpen] = useState(false);
  // M5 / T5-10：中断入口采用两步确认（中断 → 确认中断/取消）。为什么不是弹窗：
  // 看板本身已是弹层，再叠一层确认会遮挡任务上下文；行内二段式既明确又可撤销。
  // 只在团队 run 的非终态任务上出现：普通编排组没有团队归属（teamId 空），走 AgentDock 强制关闭。
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const canInterrupt = !!teamId && !TERMINAL_STATUSES.includes(task.status);
  const events = task.events || [];
  const artifacts = task.artifacts || [];
  const statusKey = TASK_STATUS_KEY[task.status];

  const doInterrupt = async () => {
    if (!teamId) return;
    setBusy(true);
    try {
      // 权限矩阵 / 执行处置 / 留痕全在 main/teamInterrupt.js：渲染层只传定位参数，
      // 失败必须提示（code 由主进程返回），不得静默——否则用户以为点了没反应。
      const r = (await window.mjcode?.teamsInterrupt?.({
        teamId, runId, taskId: task.taskId,
      })) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) {
        toast({ message: t('teams.boardInterruptDone') });
        setConfirming(false);
      } else {
        toast({ message: t('teams.boardInterruptFailed', { msg: r?.error || '' }) });
      }
    } catch (e) {
      toast({ message: t('teams.boardInterruptFailed', { msg: (e as Error)?.message || '' }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-lg border border-border bg-bg">
      <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="px-2 py-2 space-y-1 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <div className="flex items-start gap-1 text-xs break-words">
            {task.critical && <span className="text-warn shrink-0">*</span>}
            <span className="flex-1 min-w-0">{task.title || task.taskId}</span>
            <IconChevronDown
              size={11}
              className={`shrink-0 text-text2 transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </div>
          <div className="flex items-center gap-1 text-caption text-text2">
            <span className="truncate">{task.ownerName || t('teams.streamUnclaimed')}</span>
            {lead && <span className="shrink-0 text-danger">{t('teams.boardLead')}</span>}
            {(task.tokensUsed || 0) > 0 && (
              <span className="ml-auto shrink-0 tabular-nums">
                {t('teams.taskTokens', { n: formatTokens(task.tokensUsed || 0) })}
              </span>
            )}
            <span className={`shrink-0 ${(task.tokensUsed || 0) > 0 ? '' : 'ml-auto'}`}>
              {statusKey ? t(statusKey) : task.status}
            </span>
          </div>
          {dependsText && (
            <div className="text-caption text-text2 break-words">{t('teams.boardDeps')} · {dependsText}</div>
          )}
          {waitingText && (
            <div className="text-caption text-warn break-words">{t('teams.boardWaitingOn')} · {waitingText}</div>
          )}
          {task.resultSummary && (
            <div className="text-caption text-text2 break-words line-clamp-3">
              {t('teams.boardResult')} · {task.resultSummary}
            </div>
          )}
          {task.error && (
            <div className="text-caption text-warn break-all">{t('teams.boardError')} · {task.error}</div>
          )}
        </summary>

        <div className="px-2 pb-2 space-y-2 border-t border-border pt-1">
          <div>
            <div className="text-caption text-text2 mb-1">{t('teams.streamTaskTrace')}</div>
            {events.length === 0 && <div className="text-caption text-text2">{t('teams.streamNoTrace')}</div>}
            <ol className="space-y-1">
              {events.map((evt) => (
                <li key={evt.id} className="flex items-start gap-2 text-caption">
                  <span className="text-text2 shrink-0 tabular-nums">{timeLabel(evt.createdAt)}</span>
                  <span className="flex-1 min-w-0 break-words">{taskEventText(t, evt)}</span>
                </li>
              ))}
            </ol>
          </div>
          {task.resultSummary && (
            <div>
              <div className="text-caption text-text2 mb-1">{t('teams.streamTaskResult')}</div>
              <div className="text-caption whitespace-pre-wrap break-words">{task.resultSummary}</div>
            </div>
          )}
          {artifacts.length > 0 && (
            <div>
              <div className="text-caption text-text2 mb-1">{t('teams.streamTaskArtifacts')}</div>
              <div className="space-y-1">
                {artifacts.map((p) => (onOpenFile && isPathLike(p) ? (
                  // !justify-start：同 TeamRunStream —— 不加 ! 会被 Button 基础类的
                  // justify-center 吃掉，导致图标与路径居中。
                  <Button
                    key={p}
                    variant="ghost"
                    size="xs"
                    className="max-w-full !justify-start px-1"
                    title={p}
                    onClick={() => onOpenFile(p)}
                  >
                    <IconFile size={11} className="shrink-0" />
                    <span className="truncate text-accent underline">{p}</span>
                  </Button>
                ) : (
                  <div key={p} className="text-caption text-text2 break-all">{p}</div>
                )))}
              </div>
            </div>
          )}
          {canInterrupt && (
            <div className="flex flex-wrap items-center gap-1">
              {confirming ? (
                <>
                  <Button variant="danger-ghost" size="xs" disabled={busy} onClick={doInterrupt}>
                    {t('teams.boardInterruptConfirm')}
                  </Button>
                  <Button variant="ghost" size="xs" disabled={busy} onClick={() => setConfirming(false)}>
                    {t('teams.boardInterruptCancel')}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="xs" onClick={() => setConfirming(true)}>
                  {t('teams.boardInterrupt')}
                </Button>
              )}
            </div>
          )}
        </div>
      </details>
    </article>
  );
}
