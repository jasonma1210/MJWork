// 工作台 · 用量总览（2026-10-27）
//
// 回答用户唯一关心的三件事：**一共用了多少、用在哪几个模型、最近 7 天怎么走的**。
// 口径全部来自 lib/usageAggregate（纯函数、有门禁），本文件只负责画。
//
// 空态纪律：没有任何带 usage 的消息 ⇒ 不画 0 值卡片，改画一条**说明性空态**
// （说清"为什么现在是空的、数据从哪来"），而不是让页面看起来像坏了。
import { fmtTokens, type DayRow, type ModelRow, type Totals, UNMODELED } from '../../lib/usageAggregate';
import { useI18n } from '../../i18n';

function Block({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-caption text-text2">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-xl font-semibold tabular-nums text-text">{value}</span>
        {unit ? <span className="text-caption text-text2">{unit}</span> : null}
      </div>
    </div>
  );
}

export default function DeskUsageBoard({ totals, byModel, byDay }: {
  totals: Totals;
  byModel: ModelRow[];
  byDay: DayRow[];
}) {
  const { t } = useI18n();

  if (totals.requests === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface p-5" aria-label={t('desk.stats.title')}>
        <h3 className="text-sm font-medium text-text">{t('desk.stats.title')}</h3>
        <p className="mt-2 text-sm text-text">{t('desk.stats.empty')}</p>
        <p className="mt-1 text-caption leading-relaxed text-text2">{t('desk.stats.emptyHint')}</p>
      </section>
    );
  }

  const maxDay = byDay.reduce((m, d) => Math.max(m, d.total), 0) || 1;
  const maxModel = byModel.reduce((m, x) => Math.max(m, x.total), 0) || 1;

  return (
    <div className="flex flex-col gap-4">
      {/* 总量：累计 / 今日 / 近 7 天 / 请求数 —— 全部真实聚合 */}
      <section className="rounded-xl border border-border bg-surface p-5" aria-label={t('desk.stats.title')}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium text-text">{t('desk.stats.title')}</h3>
          <p className="text-caption text-text2">
            {t('desk.stats.subtitle', { total: fmtTokens(totals.total), requests: totals.requests })}
          </p>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Block label={t('desk.stats.allTime')} value={fmtTokens(totals.total)} unit={t('desk.stats.unit')} />
          <Block label={t('desk.stats.today')} value={fmtTokens(totals.todayTotal)} unit={t('desk.stats.unit')} />
          <Block label={t('desk.stats.last7')} value={fmtTokens(totals.last7Total)} unit={t('desk.stats.unit')} />
          <Block label={t('desk.stats.input')} value={fmtTokens(totals.input)} unit={t('desk.stats.unit')} />
          <Block label={t('desk.stats.output')} value={fmtTokens(totals.output)} unit={t('desk.stats.unit')} />
        </div>
        <p className="mt-3 text-caption leading-relaxed text-text2">{t('desk.stats.note')}</p>
      </section>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        {/* 模型消耗 */}
        <section className="rounded-xl border border-border bg-surface p-5" aria-label={t('desk.stats.models')}>
          <h3 className="text-sm font-medium text-text">{t('desk.stats.models')}</h3>
          <ul className="mt-3 space-y-3">
            {byModel.map((m) => (
              <li key={m.model}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-text" title={m.model}>
                    {m.model === UNMODELED ? t('desk.stats.modelUnknown') : m.model}
                  </span>
                  <span className="shrink-0 tabular-nums text-text2">
                    {t('desk.stats.modelRow', {
                      tokens: fmtTokens(m.total),
                      requests: m.requests,
                      share: Math.round(m.share * 100),
                    })}
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-hover">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.round((m.total / maxModel) * 100))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* 近 7 天消耗（柱 + 可访问数据表） */}
        <section className="rounded-xl border border-border bg-surface p-5" aria-label={t('desk.stats.daily')}>
          <h3 className="text-sm font-medium text-text">{t('desk.stats.daily')}</h3>
          {/* 柱子高度用**像素**而不是百分比：此前的 `height:X%` 落在一个 auto 高度的列容器里，
              百分比高度按规范退化为 auto（无内容 ⇒ 0px），于是无论有多少数据柱子都不可见（用户实测：
              「近 7 天消耗」只有日期标签、没有柱）。改为按固定柱道高度 88px 折算像素，确定性可见。 */}
          <div className="mt-3 flex h-28 items-end gap-2" role="img" aria-label={t('desk.stats.daily')}>
            {byDay.map((d) => {
              const barPx = Math.max(2, Math.round((d.total / maxDay) * 88));
              return (
                <div key={d.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
                  <div
                    className="w-full rounded-t bg-accent/80"
                    style={{ height: `${barPx}px` }}
                    title={`${d.key} · ${d.total}`}
                  />
                  <span className="text-caption text-text2">{d.label}</span>
                </div>
              );
            })}
          </div>
          <table className="sr-only">
            <caption>{t('desk.stats.dailyCaption')}</caption>
            <tbody>
              {byDay.map((d) => (
                <tr key={d.key}><th scope="row">{d.key}</th><td>{d.total}</td><td>{d.requests}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
