// 工作台 · 运行卡（同一组件两种形态）
//
//   variant="running" —— 进行中：真数据来自主进程 tasks:list，只取 status === 'running'。
//     归属过滤与 TaskSummaryPanel 同口径：有 thread_id 的按会话匹配，历史组（无 thread_id）
//     按 cwd 匹配 —— 不筛归属会把别人的任务挂到这屏上。
//     **不做进度条**：任务组只有 group 级状态，子任务级不可数，画一个百分比就是编数字。
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

export default function DeskRunsCard({ variant, threadId = null, projectPath = '', onOpenThread }: DeskRunsCardProps) {
  const { t } = useI18n();
  const [running, setRunning] = useState<TaskGroupRow[] | null>(null);

  useEffect(() => {
    if (variant !== 'running') return undefined;
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

  if (!running || running.length === 0) return null;
  const latest = running[0];
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-label={t('desk.running.title')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption text-text2">{t('desk.running.title')}</p>
          <p className="mt-1 text-xs text-text">{t('desk.running.groups', { n: running.length })}</p>
        </div>
        <span className="inline-flex h-6 shrink-0 items-center gap-2 rounded-full border border-accent bg-accent-bg px-2 text-caption text-accent">
          <span className="h-1 w-1 rounded-full bg-accent animate-pulse" aria-hidden="true" />
          {t('desk.running.live')}
        </span>
      </div>
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
