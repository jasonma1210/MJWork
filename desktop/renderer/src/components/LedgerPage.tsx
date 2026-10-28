// Token 用量账本（Ledger，2026-10-27 新增，设计文档 §7）
//
// 口径纪律（§7.1）：本页只回答「什么时候、哪个项目/任务/运行/来源、记录了多少 Token」。
// **不出现**成本、账单、金额、¥ / $ —— 全仓没有价格、费率、币种数据，
// 任何「Token × 假设单价」都是伪造财务数据（§18.2 已否决）。
//
// 一致性纪律（§7.3）：明细、汇总、趋势、CSV 全部来自**同一个 asOf 快照**。
// 翻页时沿用首页返回的 asOf 与不透明 cursor，前端不重新计算任何合计。
//
// 状态机（§4.5）：loading / ready / empty / refreshing / error。
//   · 后台刷新保留旧数据并标「正在更新」，不闪空；
//   · 查询失败保留旧数据，绝不把失败显示成 0（§7.5）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from './ui/Button';
import InlineAlert from './InlineAlert';
import { useI18n } from '../i18n';

interface LedgerItem {
  id: number;
  projectId: string | null;
  runId: string | null;
  taskId: string | null;
  memberId: string | null;
  tokens: number;
  source: string | null;
  createdAt: number;
}
interface Summary {
  count: number;
  tokens: number;
  byDimension?: Record<string, Array<{ key: string | null; count: number; tokens: number }>>;
}

const DAY_MS = 86400000;

/** 时间区间：闭开区间 [from, to)，与后端口径一致 */
function rangeToFilters(range: 'today' | '7d' | '30d' | 'all'): { from: number | null; to: number | null } {
  if (range === 'all') return { from: null, to: null };
  const now = Date.now();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const from = range === 'today' ? start.getTime() : start.getTime() - (range === '7d' ? 6 : 29) * DAY_MS;
  return { from, to: now + 1 };
}

export default function LedgerPage({ projectId }: { projectId?: string | null }) {
  const { t } = useI18n();
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'all'>('7d');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [items, setItems] = useState<LedgerItem[]>([]);
  const [summary, setSummary] = useState<Summary>({ count: 0, tokens: 0 });
  const [asOf, setAsOf] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [exporting, setExporting] = useState(false);
  const reqId = useRef(0);

  const filters = useMemo(() => {
    const r = rangeToFilters(range);
    return {
      ...r,
      projectId: projectId || null,
      source: source || null,
    };
  }, [range, projectId, source]);

  /** 首页查询（重置分页）。后续页走 loadMore，不重算 asOf。 */
  const loadFirst = useCallback((quiet = false) => {
    const id = ++reqId.current;
    if (quiet) setRefreshing(true); else setStatus('loading');
    Promise.resolve(window.mjcode?.ledgerQuery?.({
      filters, limit: 100, summaryDimensions: ['source', 'projectId', 'day'],
    }))
      .then((raw) => {
        if (id !== reqId.current) return;
        const res = raw as { ok?: boolean; items?: LedgerItem[]; summary?: Summary; asOf?: number; nextCursor?: string | null } | undefined;
        if (!res?.ok) { setStatus('error'); setError(String(res && 'error' in res ? (res as { error?: string }).error : 'UNKNOWN')); return; }
        setItems(res.items || []);
        setSummary(res.summary || { count: 0, tokens: 0 });
        setAsOf(Number(res.asOf) || 0);
        setCursor(res.nextCursor || null);
        setStatus((res.items || []).length ? 'ready' : 'empty');
      })
      .catch((e) => { if (id === reqId.current) { setStatus('error'); setError(String(e?.message || e)); } })
      .finally(() => setRefreshing(false));
  }, [filters]);

  useEffect(() => { loadFirst(); }, [loadFirst]);

  function loadMore() {
    if (!cursor) return;
    const id = reqId.current; // 翻页不推进 reqId：不打断首页快照
    Promise.resolve(window.mjcode?.ledgerQuery?.({ cursor, limit: 100 }))
      .then((raw) => {
        if (id !== reqId.current) return;
        const res = raw as { ok?: boolean; items?: LedgerItem[]; nextCursor?: string | null } | undefined;
        if (!res?.ok) { setError(String(res && 'error' in res ? (res as { error?: string }).error : 'UNKNOWN')); return; }
        // 追加，不替换 —— 翻页沿用首页 asOf，故两页之间不重不漏
        setItems((prev) => [...prev, ...(res.items || [])]);
        setCursor(res.nextCursor || null);
      })
      .catch((e) => setError(String(e?.message || e)));
  }

  function exportCsv() {
    setExporting(true); setExportMsg('');
    Promise.resolve(window.mjcode?.ledgerExport?.({ filters }))
      .then((raw) => {
        const res = raw as { ok?: boolean; filePath?: string; rows?: number; error?: string } | undefined;
        if (res?.ok) setExportMsg(t('ledger.exportDone', { n: res.rows || 0, path: res.filePath || '' }));
        else setExportMsg(t('ledger.exportFailed', { msg: res?.error || t('ledger.loadFailed') }));
      })
      .catch((e) => setExportMsg(t('ledger.exportFailed', { msg: String(e?.message || e) })))
      .finally(() => setExporting(false));
  }

  const trend = summary.byDimension?.day || [];
  const maxDay = trend.reduce((m, d) => Math.max(m, d.tokens), 0);

  if (status === 'loading') {
    return <div className="p-4 text-caption text-text2" role="status">{t('ledger.loading')}</div>;
  }
  if (status === 'error') {
    return (
      <div className="p-4 space-y-2">
        <InlineAlert type="error" onDismiss={() => loadFirst()}>{t('ledger.loadFailed')}</InlineAlert>
        <Button size="sm" variant="secondary" onClick={() => loadFirst()}>{t('ledger.retry')}</Button>
      </div>
    );
  }

  const isEmpty = status === 'empty';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 上下文条：时间范围 / 来源 / 刷新 / 导出 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        {(['today', '7d', '30d', 'all'] as const).map((r) => (
          <Button key={r} size="xs" variant={range === r ? 'accent-ghost' : 'ghost'} onClick={() => setRange(r)}>
            {t(`ledger.range${r === '7d' ? '7d' : r === '30d' ? '30d' : r === 'today' ? 'Today' : 'All'}`)}
          </Button>
        ))}
        <select
          value={source}
          onChange={(ev) => setSource(ev.target.value)}
          aria-label={t('ledger.filterSource')}
          className="rounded-lg border border-border bg-bg px-2 py-1 text-xs"
        >
          <option value="">{t('ledger.filterAllSources')}</option>
          <option value="round">round</option>
          <option value="settle">settle</option>
          {/* 2026-10-28：单人对话收尾也会入账（source='chat'），筛选器不给这一档就查不到它们 */}
          <option value="chat">chat</option>
        </select>
        {refreshing && <span className="text-caption text-text2">· {t('ledger.refresh')}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button size="xs" variant="secondary" onClick={() => loadFirst(true)}>{t('ledger.refresh')}</Button>
          <Button size="xs" variant="secondary" disabled={exporting} onClick={exportCsv}>
            {exporting ? t('ledger.exporting') : t('ledger.export')}
          </Button>
        </div>
      </div>

      {exportMsg && <div className="px-3 py-1 text-caption text-text2">{exportMsg}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
        {/* 摘要区 */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <span>{t('ledger.summaryCount')} <b className="tabular-nums">{summary.count}</b></span>
          <span>{t('ledger.summaryTokens')} <b className="tabular-nums">{summary.tokens}</b></span>
          <span className="text-text2">{t('ledger.asOfLabel')} {asOf}</span>
        </div>
        <div className="text-caption text-text2">{t('ledger.sourceNote')}</div>
        <div className="text-caption text-text2">{t('ledger.noPricingNote')}</div>

        {isEmpty ? (
          <div className="space-y-1 py-6 text-center">
            <div className="text-sm">{source || range !== 'all' ? t('ledger.noMatch') : t('ledger.noData')}</div>
            <div className="text-caption text-text2">{source || range !== 'all' ? t('ledger.noMatchHint') : t('ledger.noDataHint')}</div>
            {(source || range !== 'all') && (
              <Button size="xs" variant="ghost" onClick={() => { setSource(''); setRange('all'); }}>
                {t('ledger.clearFilter')}
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* 趋势：真实数据；无数据时**不画**示例折线 */}
            {trend.length > 0 && (
              <section className="space-y-1">
                <div className="text-xs font-medium">{t('ledger.trendTitle')}</div>
                <div className="flex h-24 items-end gap-1" role="img" aria-label={t('ledger.trendTitle')}>
                  {trend.map((d) => (
                    <div
                      key={d.key}
                      className="min-w-[6px] flex-1 rounded-t bg-accent"
                      style={{ height: `${maxDay ? Math.max(2, Math.round((d.tokens / maxDay) * 100)) : 2}%` }}
                      title={`${d.key} · ${d.tokens}`}
                    />
                  ))}
                </div>
                {/* 可访问替代：图表必须有等价数据表（§14.2） */}
                <table className="sr-only">
                  <caption>{t('ledger.trendTableCaption')}</caption>
                  <tbody>
                    {trend.map((d) => <tr key={d.key}><th scope="row">{d.key}</th><td>{d.tokens}</td></tr>)}
                  </tbody>
                </table>
              </section>
            )}

            {/* 明细表 */}
            <table className="w-full text-xs">
              <caption className="sr-only">{t('ledger.tableCaption')}</caption>
              <thead>
                <tr className="text-left text-text2">
                  <th scope="col" className="py-1">{t('ledger.colTime')}</th>
                  <th scope="col" className="py-1">{t('ledger.colProject')}</th>
                  <th scope="col" className="py-1">{t('ledger.colTask')}</th>
                  <th scope="col" className="py-1">{t('ledger.colRun')}</th>
                  <th scope="col" className="py-1">{t('ledger.colSource')}</th>
                  <th scope="col" className="py-1">{t('ledger.colMember')}</th>
                  <th scope="col" className="py-1 text-right">{t('ledger.colTokens')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-t border-border">
                    <td className="py-1 tabular-nums">{it.createdAt ? new Date(it.createdAt).toLocaleString() : t('ledger.notRecorded')}</td>
                    <td className="py-1 truncate">{it.projectId ?? t('ledger.notRecorded')}</td>
                    <td className="py-1 truncate">{it.taskId ?? t('ledger.notRecorded')}</td>
                    <td className="py-1 truncate">{it.runId ?? t('ledger.notRecorded')}</td>
                    <td className="py-1">{it.source ?? t('ledger.notRecorded')}</td>
                    {/* M0 §1.4：member_id 语义未证实 ⇒ 中性标签，不做筛选、不改名 */}
                    <td className="py-1 truncate">{it.memberId ?? t('ledger.notRecorded')}</td>
                    <td className="py-1 text-right tabular-nums">{it.tokens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-caption text-text2">{t('ledger.memberUnverifiedNote')}</div>

            <div className="flex items-center gap-2">
              {cursor
                ? <Button size="xs" variant="secondary" onClick={loadMore}>{t('ledger.loadMore')}</Button>
                : <span className="text-caption text-text2">{t('ledger.noMore')}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
