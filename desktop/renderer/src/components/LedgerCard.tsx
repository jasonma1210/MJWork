// 用量账本卡 —— 窗口内**按成员聚合**的真实 token 消耗
//
// 数据源：主进程 projects:quotaLedger → QuotaLedger.ledgerByMember（读 quota_consumptions，
// 每条 recordRound/settle 都落一行）。**只读**，不改任何配额状态。
//
// ⚠ 口径纪律（别把它叫成「账单」）：
//   这是 **token 消耗**，不是金额。全仓没有任何价格 / 汇率 / 订阅数据，
//   故本卡**不折算**成 ¥ —— 那样做等于编造数字。要做真正的账单，必须先有真实定价源。
//
// 空态纪律：无活动会话 / 通道缺失 / 取数失败 / 返回 0 行 ⇒ **整卡卸载**，
// 不留空表、不显示「暂无数据」占位（与 DeskPage 各卡同一口径）。
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

interface LedgerRow {
  memberId?: string;
  tokens?: number;
  rounds?: number;
}

/** token 数字格式化：≥1e6 → M，≥1e3 → K（与 Dashboard 同口径） */
function fmt(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

export default function LedgerCard({ threadId }: { threadId?: string | null }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);

  useEffect(() => {
    if (!threadId) { setRows([]); return undefined; }
    const mj = window.mjcode as unknown as {
      projectsQuotaLedger?: (o: unknown) => Promise<{ ok?: boolean; rows?: LedgerRow[] } | undefined>;
    } | undefined;
    if (!mj?.projectsQuotaLedger) { setRows([]); return undefined; }
    let cancelled = false;
    mj.projectsQuotaLedger({ threadId })
      .then((r) => { if (!cancelled) setRows(Array.isArray(r?.rows) ? r.rows : []); })
      .catch((err) => {
        console.warn('[ledger] projects:quotaLedger failed:', err);
        if (!cancelled) setRows([]);
      });
    return () => { cancelled = true; };
  }, [threadId]);

  if (!rows || rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + (Number(r.tokens) || 0), 0);

  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-label={t('dashboard.ledgerTitle')}>
      <h3 className="text-sm font-medium mb-3">{t('dashboard.ledgerTitle')}</h3>
      <ul className="space-y-2">
        {rows.map((r) => {
          const tokens = Number(r.tokens) || 0;
          const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
          return (
            <li key={r.memberId || 'unassigned'} className="text-xs">
              <div className="flex items-center justify-between gap-2 text-text2">
                <span className="truncate">{r.memberId || t('dashboard.ledgerUnassigned')}</span>
                <span className="shrink-0">{fmt(tokens)} · {pct}%</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-hover">
                <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-caption leading-relaxed text-text2">{t('dashboard.ledgerNote')}</p>
    </section>
  );
}
