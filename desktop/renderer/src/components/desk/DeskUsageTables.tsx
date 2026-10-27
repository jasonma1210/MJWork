// 工作台 · 任务消耗 / 会话消耗（2026-10-27）
//
// 用户要的是「目前主要的那些任务，每个任务消耗的 token 量」。本机有两种任务粒度：
//   · 任务组（task_groups + sub_tasks）：团队/编排跑出来的任务，token 来自账本
//     `quota_consumptions.task_id`（只有真跑过团队运行时才有流水）。
//   · 会话（threads）：单人对话的实际归属单位，token 来自每条消息自带的 usage。
// 两者**都真实存在**，故分两张表展示，不强行合并成一张"看起来统一"的假表。
//
// 未记录 ≠ 0：任务没有账本流水时显示「未记录」而不是 0（mergeTaskUsage 的 hasTokens）。
import { fmtTokens, type TaskUsageRow, type ThreadRow } from '../../lib/usageAggregate';
import { useI18n } from '../../i18n';

function StatusChip({ status }: { status: string }) {
  if (!status) return null;
  return <span className="rounded-full bg-hover px-2 py-1 text-caption text-text2">{status}</span>;
}

export function DeskTaskTable({ rows, hint }: { rows: TaskUsageRow[]; hint: 'no-tasks' | 'no-ledger' | '' }) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5" aria-label={t('desk.stats.tasks')}>
        <h3 className="text-sm font-medium text-text">{t('desk.stats.tasks')}</h3>
        <p className="mt-2 text-caption leading-relaxed text-text2">{t('desk.stats.taskNoTasks')}</p>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-label={t('desk.stats.tasks')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-text">{t('desk.stats.tasks')}</h3>
        {hint === 'no-ledger'
          ? <p className="text-caption text-text2">{t('desk.stats.taskNoLedger')}</p>
          : null}
      </div>
      <table className="mt-3 w-full text-xs">
        <caption className="sr-only">{t('desk.stats.tasks')}</caption>
        <thead>
          <tr className="text-left text-text2">
            <th scope="col" className="py-1 font-normal">{t('desk.stats.colTask')}</th>
            <th scope="col" className="py-1 font-normal">{t('desk.stats.colStatus')}</th>
            <th scope="col" className="py-1 font-normal">{t('desk.stats.colProgress')}</th>
            <th scope="col" className="py-1 text-right font-normal">{t('desk.stats.colRounds')}</th>
            <th scope="col" className="py-1 text-right font-normal">{t('desk.stats.colTokens')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.groupId} className="border-t border-border">
              <td className="max-w-[280px] truncate py-1 text-text" title={r.goal}>{r.goal}</td>
              <td className="py-1"><StatusChip status={r.status} /></td>
              <td className="py-1 tabular-nums text-text2">
                {r.total > 0 ? `${r.done}/${r.total}` : t('desk.stats.notRecorded')}
                {r.failed > 0 ? <span className="ml-1 text-warn">· {r.failed}</span> : null}
              </td>
              <td className="py-1 text-right tabular-nums text-text2">{r.hasTokens ? r.rounds : t('desk.stats.notRecorded')}</td>
              <td className="py-1 text-right tabular-nums text-text">
                {r.hasTokens ? fmtTokens(r.tokens) : t('desk.stats.notRecorded')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function DeskThreadTable({ rows }: { rows: ThreadRow[] }) {
  const { t } = useI18n();
  if (rows.length === 0) return null; // 没有可统计会话 ⇒ 整卡卸载（不画空表）
  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-label={t('desk.stats.threads')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-text">{t('desk.stats.threads')}</h3>
        <p className="text-caption text-text2">{t('desk.stats.threadsHint')}</p>
      </div>
      <table className="mt-3 w-full text-xs">
        <caption className="sr-only">{t('desk.stats.threads')}</caption>
        <thead>
          <tr className="text-left text-text2">
            <th scope="col" className="py-1 font-normal">{t('desk.stats.colThread')}</th>
            <th scope="col" className="py-1 font-normal">{t('desk.stats.colModel')}</th>
            <th scope="col" className="py-1 text-right font-normal">{t('desk.stats.colRequests')}</th>
            <th scope="col" className="py-1 text-right font-normal">{t('desk.stats.colTokens')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.threadId} className="border-t border-border">
              <td className="max-w-[320px] truncate py-1 text-text" title={r.title}>{r.title}</td>
              <td className="max-w-[160px] truncate py-1 text-text2">{r.model || t('desk.stats.notRecorded')}</td>
              <td className="py-1 text-right tabular-nums text-text2">{r.requests}</td>
              <td className="py-1 text-right tabular-nums text-text">{fmtTokens(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
