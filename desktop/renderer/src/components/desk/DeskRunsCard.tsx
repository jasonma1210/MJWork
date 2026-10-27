// 工作台 · 运行卡（同一组件两种形态）
//
//   variant="running" —— 进行中：真数据来自主进程 tasks:list，只取 status === 'running'。
//     归属过滤与 TaskSummaryPanel 同口径：有 thread_id 的按会话匹配，历史组（无 thread_id）
//     按 cwd 匹配 —— 不筛归属会把别人的任务挂到这屏上。
//     进度条（R-16）：listGroups 已用关联子查询把每个组的 sub_tasks 真实计数（total/done/failed）
//     一并带出，故最新运行组可渲染「已完成 X/Y」真实进度条——不再是编数字（前提是该组确有子任务）。
//   variant="recent"  —— 最近运行：本机**没有跨会话运行记录的数据源**（runRegistry 是模块级
//     Map，刷新即空），故恒显示静态「尚未接线」，不调任何接口、不造任何假运行记录。
//
// 空态纪律：running 为空或取数失败 ⇒ **整卡卸载**，不留「0 个任务组」的空壳。
// 取数只在挂载时一次，不订阅 tasks:event —— desk 是「开工前的一屏」，不是监控面。
import { useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useI18n } from '../../i18n';

interface TaskGroupRow {
  group_id: string;
  goal?: string;
  status?: string;
  thread_id?: string | null;
  cwd?: string;
  // R-16（2026-10-26）：运行卡「任务进度」——来自 listGroups 的关联子查询（sub_tasks 真实计数），非编造。
  totalTasks?: number;
  doneTasks?: number;
  failedTasks?: number;
}

interface TasksListResult {
  ok?: boolean;
  groups?: TaskGroupRow[];
}

export interface DeskRunsCardProps {
  variant: 'running' | 'recent';
  /** 会话 id（可空：无会话时进行中整卡卸载） */
  threadId?: string | null;
  /** 当前项目目录（仅历史组的 cwd 归属兜底） */
  projectPath?: string;
  onOpenThread?: (threadId: string) => void;
}

/**
 * 进行中卡是否应该出现 —— 纯函数，导出以便直接验（不必跑 effect）。
 * 三个 Gates 缺一不可：
 *   · 无活动会话 ⇒ 不出现（「开工前一屏」的进行中只回答「我这个会话在跑什么」）；
 *   · 未取到（null）⇒ 不出现（不表态，避免先闪一帧"0 个任务组"）；
 *   · 取到但为 0 ⇒ 不出现。
 */
export function runningCardVisible(threadId: string | null | undefined, running: TaskGroupRow[] | null): boolean {
  return !!threadId && !!running && running.length > 0;
}

export default function DeskRunsCard({ variant, threadId = null, projectPath = '', onOpenThread }: DeskRunsCardProps) {
  const { t } = useI18n();
  const [running, setRunning] = useState<TaskGroupRow[] | null>(null);

  useEffect(() => {
    if (variant !== 'running') return undefined;
    // 无活动会话 ⇒ 不取数（整卡卸载的理由见下方 return null 处）
    if (!threadId) { setRunning([]); return undefined; }
    const mj = window.mjcode as unknown as { tasksList?: (o: unknown) => Promise<TasksListResult | undefined> } | undefined;
    if (!mj?.tasksList) { setRunning([]); return undefined; }
    let cancelled = false;
    mj.tasksList({ limit: 30 })
      .then((r) => {
        if (cancelled) return;
        const list = Array.isArray(r?.groups) ? r.groups : [];
        const mine = list.filter((g) => (g.thread_id
          ? String(g.thread_id) === String(threadId ?? '')
          : String(g.cwd || '') === String(projectPath || '')));
        setRunning(mine.filter((g) => g.status === 'running'));
      })
      .catch((err) => {
        console.warn('[desk] tasks:list failed:', err);
        if (!cancelled) setRunning([]);
      });
    return () => { cancelled = true; };
  }, [variant, threadId, projectPath]);

  if (variant === 'recent') {
    return (
      <section className="rounded-xl border border-border bg-surface p-4" aria-label={t('desk.runs.title')}>
        <h3 className="text-xs font-medium text-text">{t('desk.runs.title')}</h3>
        <p className="mt-2 text-caption leading-relaxed text-text2">{t('desk.runs.empty')}</p>
      </section>
    );
  }

  // 无会话 / 未取到 / 取到 0 ⇒ 整卡卸载（判据见 runningCardVisible 的注释）。
  // 历史组（无 thread_id、靠 cwd 匹配）确实能匹配上，但那是「运行记录」面的内容：
  // 塞进 desk 会让已结束的组混进「正在跑什么」，且此类组没有 thread_id ⇒ 卡上的
  // 「查看对话」不渲染，用户看到「进行中」却无处可去。宁可不表态，也不给半截信息。
  if (!runningCardVisible(threadId, running)) return null;
  // 谓词无法让 TS 收窄（跨函数），故这里显式兜底一次；`?? []` 同时说明「空数组不渲染行」
  const live = running ?? [];
  const latest = live[0];
  // R-16：最新运行组的子任务真实进度（done/total 来自 listGroups 计数），仅当该组确有子任务时才展示
  const latestTotal = Number(latest?.totalTasks) || 0;
  const latestDone = Number(latest?.doneTasks) || 0;
  const latestPct = latestTotal > 0 ? Math.round((latestDone / latestTotal) * 100) : 0;
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-label={t('desk.running.title')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption text-text2">{t('desk.running.title')}</p>
          <p className="mt-1 text-xs text-text">{t('desk.running.groups', { n: live.length })}</p>
        </div>
        <span className="inline-flex h-6 shrink-0 items-center gap-2 rounded-full border border-accent bg-accent-bg px-2 text-caption text-accent">
          <span className="h-1 w-1 rounded-full bg-accent animate-pulse" aria-hidden="true" />
          {t('desk.running.live')}
        </span>
      </div>
      {latestTotal > 0 ? (
        <div className="mt-3">
          <div className="flex items-center justify-between text-caption text-text2">
            <span>{t('desk.running.progress', { done: latestDone, total: latestTotal })}</span>
            <span>{latestPct}%</span>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-hover"
            role="img"
            aria-label={t('desk.running.progress', { done: latestDone, total: latestTotal })}
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${latestPct}%` }} />
          </div>
        </div>
      ) : null}
      {latest.goal ? (
        <div className="mt-3">
          <p className="text-caption text-text2">{t('desk.running.latest')}</p>
          <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-text">{latest.goal}</p>
        </div>
      ) : null}
      {latest.thread_id && onOpenThread ? (
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => onOpenThread(String(latest.thread_id))}>
          {t('desk.running.viewChat')}
        </Button>
      ) : null}
    </section>
  );
}
