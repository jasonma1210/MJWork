import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { IconDownload, IconMail, IconMessage, IconUpload } from './icons';
import LedgerCard from './LedgerCard';
import { useI18n } from '../i18n';

// 注意：本文件是 .jsx（非 .tsx），**不可写 TS 类型注解** —— 类型标注只放在 .tsx（如 LedgerCard.tsx）。
export default function Dashboard({ threadId }) {
  const { t } = useI18n();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.dashboard()
      .then(setStats)
      .catch((err) => {
        console.warn('[dashboard] load failed:', err);
        setError(t('dashboard.loadFailed'));
      });
  }, [t]);

  if (error) {
    return (
      <div className="p-6">
        <h2 className="text-xl font-semibold mb-4">{t('dashboard.title')}</h2>
        <p className="text-text2 text-sm">{error}</p>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="p-6">
        <h2 className="text-xl font-semibold mb-4">{t('dashboard.title')}</h2>
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-surface rounded-xl border border-border p-4 animate-pulse">
              <div className="h-8 bg-hover rounded mb-2" />
              <div className="h-3 bg-hover rounded w-2/3" />
            </div>
          ))}
        </div>
        <p className="text-text2 text-sm">{t('dashboard.loading')}</p>
      </div>
    );
  }

  const totalTokens = (stats.tokens_input || 0) + (stats.tokens_output || 0);
  const dist = stats.model_distribution || [];
  const maxTokens = Math.max(...dist.map(d => d.tokens || 0), 1);
  const activity = stats.recent_activity || [];
  const weekly = stats.weekly_threads || [];

  // D3：最近 7 天固定补零（按 MM-DD 对齐，缺的天数填 0，横轴不再忽长忽短）
  const activityByDay = new Map(activity.map((x) => [String(x.day || '').slice(5), x.count || 0]));
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86400000);
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { day: key, count: activityByDay.get(key) || 0 };
  });
  const activityMax = Math.max(...last7Days.map((x) => x.count), 1);

  return (
    <div className="p-6 overflow-y-auto">
      <h2 className="text-xl font-semibold mb-1">{t('dashboard.title')}</h2>
      <p className="text-text2 text-xs mb-4">{t('dashboard.totalTokens', { n: fmt(totalTokens) })}</p>

      {/* 统计卡片 */}
      <div className="grid gap-4 mb-6 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
        <StatCard label={t('dashboard.chats')} value={fmt(stats.threads || 0)} icon={<IconMessage size={20} />} />
        <StatCard label={t('dashboard.messages')} value={fmt(stats.messages || 0)} icon={<IconMail size={20} />} />
        <StatCard label={t('dashboard.inputTokens')} value={fmt(stats.tokens_input || 0)} icon={<IconDownload size={20} />} />
        <StatCard label={t('dashboard.outputTokens')} value={fmt(stats.tokens_output || 0)} icon={<IconUpload size={20} />} />
      </div>

      {/* B3：本地口径说明——模型分布/活跃趋势需服务端数据，本地模式不计算，
          必须显式说明，避免用户把「本地未计算」误读为「没有任何活动」。 */}
      {stats.data_scope === 'local' && (
        <p className="text-text2 text-xs mb-4">{t('dashboard.localScopeNote')}</p>
      )}

      {/* 模型使用分布 */}
      <div className="bg-surface rounded-xl border border-border p-4 mb-4">
        <h3 className="text-sm font-medium mb-3">{t('dashboard.modelDistribution')}</h3>
        {dist.length === 0 ? (
          <p className="text-text2 text-sm">{t('dashboard.noData')}</p>
        ) : (
          dist.map((d, i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between text-xs mb-1">
                <span>{d.model}</span>
                <span className="text-text2">{t('dashboard.modelRow', { n: d.messages, tokens: fmt(d.tokens) })}</span>
              </div>
              <div className="h-2 bg-hover rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full" style={{ width: `${((d.tokens || 0) / maxTokens) * 100}%` }} />
              </div>
            </div>
          ))
        )}
      </div>

      {/* 最近 7 天活跃 */}
      <div className="bg-surface rounded-xl border border-border p-4 mb-4">
        <h3 className="text-sm font-medium mb-3">{t('dashboard.recentActivity')}</h3>
        {activity.length === 0 ? (
          <p className="text-text2 text-sm">{t('dashboard.noRecentMessages')}</p>
        ) : (
          <div className="flex items-end gap-2 h-24">
            {last7Days.map((d) => (
              <div key={d.day} className="flex-1 flex flex-col items-center">
                <div className="w-full bg-accent rounded-t" style={{ height: `${(d.count / activityMax) * 80}px` }} />
                <span className="text-xs text-text2 mt-1">{d.day}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 近 8 周对话趋势 —— D1：数据源为空时整卡隐藏（本地模式此前永远「暂无数据」，属假功能） */}
      {weekly.length > 0 && (
        <div className="bg-surface rounded-xl border border-border p-4">
          <h3 className="text-sm font-medium mb-3">{t('dashboard.weeklyThreads')}</h3>
          <div className="flex items-end gap-2 h-20">
            {weekly.slice().reverse().map((w, i) => {
              const max = Math.max(...weekly.map(x => x.count || 0), 1);
              return (
                <div key={i} className="flex-1 flex flex-col items-center" title={t('dashboard.weeklyTitle', { week: w.week, count: w.count })}>
                  <div className="w-full bg-accent/70 rounded-t" style={{ height: `${((w.count || 0) / max) * 64}px` }} />
                  <span className="text-xs text-text2 mt-1">{w.week.slice(5)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* 用量账本：真实 token 消耗（按成员），无数据则整卡自卸（见 LedgerCard 文件头） */}
      <LedgerCard threadId={threadId} />
    </div>
  );
}

function StatCard({ label, value, icon }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="text-accent mb-1">{icon}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-text2">{label}</div>
    </div>
  );
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
