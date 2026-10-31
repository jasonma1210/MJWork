// M7（2026-10-30，设计文档 §6.4）：设置 → 通用 → 运行报告。
//
// 为什么要有这块界面：报告落在 userData/reports/ 里，没有入口等于没做——用户想知道
// 「刚才那次为什么被砍」「这周有多少次没跑完」只能去翻文件系统。
//
// 语义边界（避免这块面板说谎）：
//   · 只读最近 N 次的**摘要**，不搬整份报告进渲染层（正文与明细留给诊断包）；
//   · 验收列在 total=0 时显示「—」而不是 0/0（没判过 ≠ 一条没做到，同 M5 的口径）；
//   · 读不到报告与「没跑过任务」是两件事，前者显式报错，不显示空列表。
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../i18n';
import Button from './ui/Button';
import { Section } from './settings/shared';

interface RunReportRow {
  runId: string;
  endedAt: number;
  durationMs: number;
  model: string;
  stopReason: string;
  interrupted: boolean;
  checkpointSaved: boolean;
  acTotal: number;
  acSatisfied: number;
  rounds: number;
  toolCalls: number;
  tokens: number;
}

const REPORT_LIMIT = 5;

const fmtDur = (ms: number) => {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
};

export default function RunReportsSection() {
  const { t } = useI18n();
  const [rows, setRows] = useState<RunReportRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [exportPath, setExportPath] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const fn = window.mjcode?.diagReports;
      if (!fn) { setState('error'); return; }
      const reply = (await fn(REPORT_LIMIT)) as { ok?: boolean; reports?: RunReportRow[] } | undefined;
      if (reply?.ok) { setRows(Array.isArray(reply.reports) ? reply.reports : []); setState('ready'); }
      else setState('error');
    } catch {
      // C-001：这里把「IPC 抛错」与「读不到」压成同一个 error 态——两者对用户是同一句话
      //（「现在看不了」），不会让人误以为「没跑过任务」；不重抛是因为这是展示型面板，
      // 抛上去只会让整个设置页白屏。
      setState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 停止原因文案：静态键一一对应（不用 t(`prefix.${x}`) 这类动态拼接——
  // 拼错不会报错，只会把原始 key 直接显示给用户）。
  const stopText = (r: string): string => {
    if (r === 'context') return t('message.stopReasonContext');
    if (r === 'total-cap') return t('message.stopReasonTotalCap');
    if (r === 'wallclock') return t('message.stopReasonWallclock');
    if (r === 'rounds') return t('message.stopReasonRounds');
    if (r === 'repeat') return t('message.stopReasonRepeat');
    return t('settings.runReportInterrupted');
  };

  const onExport = async () => {
    setExportPath('');
    try {
      const reply = (await window.mjcode?.diagExport?.()) as { ok?: boolean; file?: string } | undefined;
      setExportPath(reply?.ok && reply.file ? reply.file : t('settings.runReportExportFailed'));
    } catch {
      // C-001：导出失败只影响这一个按钮的提示（下一行会显示失败文案），
      // 不影响面板其余信息；不重抛是展示型面板的既定纪律。
      setExportPath(t('settings.runReportExportFailed'));
    }
  };

  return (
    <Section title={t('settings.runReports')}>
      <div className="py-4 space-y-3">
        <p className="text-xs text-text2">{t('settings.runReportsDesc')}</p>
        {state === 'loading' && <p className="text-xs text-text2">{t('settings.runReportsLoading')}</p>}
        {state === 'error' && <p className="text-xs text-warn">{t('settings.runReportsError')}</p>}
        {state === 'ready' && rows.length === 0 && (
          <p className="text-xs text-text2">{t('settings.runReportsEmpty')}</p>
        )}
        {state === 'ready' && rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.runId} className="text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-text2">
                  {r.endedAt ? new Date(r.endedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
                </span>
                <span>{r.interrupted ? stopText(r.stopReason) : t('settings.runReportDone')}</span>
                <span className="text-text2">
                  {t('settings.runReportRounds', { n: r.rounds, m: r.toolCalls })}
                </span>
                {/* total=0 ⇒ 没有验收基线/未判定，显示「—」而不是 0/0（同 M5 口径） */}
                <span className="text-text2">
                  {r.acTotal > 0 ? t('settings.runReportAc', { done: r.acSatisfied, total: r.acTotal }) : t('settings.runReportAcNone')}
                </span>
                <span className="text-text2">{fmtDur(r.durationMs)}</span>
                <span className="text-text2">{t('settings.runReportTokens', { n: r.tokens.toLocaleString() })}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="accent-ghost" size="xs" onClick={() => { void load(); }}>{t('settings.runReportsRefresh')}</Button>
          <Button variant="accent-ghost" size="xs" onClick={() => { void onExport(); }}>{t('settings.runReportsExport')}</Button>
        </div>
        {exportPath && <p className="text-xs text-text2 break-all">{exportPath}</p>}
      </div>
    </Section>
  );
}
