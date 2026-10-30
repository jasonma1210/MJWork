// 团队调试日志面板（2026-10-21）
//
// 背景：团队派活的问题（任务无人认领 / 看板显示完成但没有产出 / 成员空转）都发生在
// 「点一下 → IPC → 拆解 → 批次计划 → 认领 → 引擎运行 → 终态落库」这条长链上，
// 用户界面只看到一张结果卡。本面板让用户复现一次操作后一键导出全链路 JSONL 日志。
//
// 职责边界（与主进程 ipc/teamDebug.js 一一对应）：
//   · 只读状态（是否记录 / 详细模式 / 文件路径 / 大小 / 内存条数）；
//   · 开关记录与详细模式（用户可随时关闭，避免长期占盘）；
//   · 展示最近 N 条（tail，与落盘同一份条目）；
//   · 导出 zip（主进程落 diagnostics/ 并自动打开所在目录）与直接打开日志目录。
// 日志文件本体始终留在主进程，渲染层不持有文件句柄，也不做二次加工。
import { useCallback, useEffect, useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import InlineAlert from './InlineAlert';
import { useI18n } from '../i18n';

interface DebugStatus {
  ok?: boolean;
  enabled?: boolean;
  verbose?: boolean;
  dir?: string;
  file?: string;
  bytes?: number;
  entries?: number;
  meta?: Record<string, unknown>;
}

interface DebugEntry {
  ts?: number;
  iso?: string;
  seq?: number;
  scope?: string;
  event?: string;
  level?: string;
  data?: unknown;
}

interface TailResult { ok?: boolean; entries?: DebugEntry[]; status?: DebugStatus; }

const TAIL_LIMIT = 120;

function fmtBytes(n: number | undefined): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(e: DebugEntry): string {
  if (e?.ts) {
    const d = new Date(e.ts);
    const p = (x: number) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }
  return '';
}

function brief(data: unknown): string {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return String(s ?? '').slice(0, 600);
  } catch { /* 循环引用等无法序列化：占位符本身就是给人看的结论（面板里能区分「没数据」与「无法展示」） */ return '[unserializable]'; }
}

export default function TeamDebugPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DebugStatus>({});
  const [entries, setEntries] = useState<DebugEntry[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  // 统一的读取通道：状态与 tail 一次取回（主进程同一份内存环，不做两次查询）
  const refresh = useCallback(async () => {
    try {
      const r = (await window.mjcode?.teamsDebugTail?.(TAIL_LIMIT)) as TailResult | undefined;
      if (!r) { setError(t('teams.debugBridgeMissing')); return; }
      setStatus(r.status || {});
      setEntries(Array.isArray(r.entries) ? r.entries : []);
    } catch (e) {
      setError(t('teams.debugLoadFailed', { msg: (e as Error).message }));
    }
  }, [t]);

  // 打开时立即拉一次；面板开着时每 3s 自刷新（用户可能正同时在对话里跑团队任务）
  useEffect(() => {
    if (!open) return undefined;
    setError('');
    setNotice('');
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  async function patch(p: { enabled?: boolean; verbose?: boolean }) {
    setBusy('toggle');
    try {
      const r = (await window.mjcode?.teamsDebugSet?.(p)) as DebugStatus | undefined;
      if (r) setStatus(r);
      await refresh();
    } catch (e) {
      setError(t('teams.debugToggleFailed', { msg: (e as Error).message }));
    } finally {
      setBusy('');
    }
  }

  async function exportLogs() {
    setBusy('export');
    setError('');
    try {
      const r = (await window.mjcode?.teamsDebugExport?.()) as { ok?: boolean; path?: string; error?: string } | undefined;
      if (r?.ok) setNotice(t('teams.debugExportOk', { path: r.path || '' }));
      else setError(t('teams.debugExportFailed', { msg: r?.error || '' }));
    } catch (e) {
      setError(t('teams.debugExportFailed', { msg: (e as Error).message }));
    } finally {
      setBusy('');
    }
  }

  async function openDir() {
    try {
      const r = (await window.mjcode?.teamsDebugOpenDir?.()) as { ok?: boolean; error?: string } | undefined;
      if (!r?.ok) setError(t('teams.debugOpenDirFailed', { msg: r?.error || '' }));
    } catch (e) {
      setError(t('teams.debugOpenDirFailed', { msg: (e as Error).message }));
    }
  }

  async function copyPath() {
    const p = status.file || status.dir || '';
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
      setNotice(t('teams.debugCopied'));
    } catch {
      setError(t('teams.debugCopyFailed'));
    }
  }

  const recording = !!status.enabled;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('teams.debugTitle')}
      size="lg"
      footer={(
        <>
          <Button variant="secondary" size="md" onClick={openDir}>{t('teams.debugOpenDir')}</Button>
          <Button size="md" loading={busy === 'export'} onClick={exportLogs}>{t('teams.debugExport')}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        <p className="text-xs text-text2 leading-relaxed">{t('teams.debugDesc')}</p>

        {error && <InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert>}
        {notice && <InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert>}

        {/* 开关区：记录中 / 已停止 + 详细模式 */}
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium">
                {recording ? t('teams.debugEnabled') : t('teams.debugDisabled')}
              </div>
              <div className="text-[11px] text-text2 mt-1">
                {t('teams.debugEntries', { n: status.entries || 0 })}
              </div>
            </div>
            <Button
              variant={recording ? 'secondary' : 'primary'}
              size="sm"
              loading={busy === 'toggle'}
              onClick={() => patch({ enabled: !recording })}
            >
              {recording ? t('teams.debugToggleOff') : t('teams.debugToggleOn')}
            </Button>
          </div>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!status.verbose}
              disabled={!recording}
              onChange={(e) => patch({ verbose: e.target.checked })}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="text-xs">{t('teams.debugVerbose')}</span>
              <span className="block text-[11px] text-text2 leading-relaxed mt-1">{t('teams.debugVerboseHint')}</span>
            </span>
          </label>
        </div>

        {/* 落点信息：文件路径 + 大小 + 复制 */}
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">{t('teams.debugFile')}</span>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[11px] text-text2">{fmtBytes(status.bytes)}</span>
              <Button variant="ghost" size="xs" onClick={copyPath}>{t('teams.debugCopyPath')}</Button>
            </div>
          </div>
          <div className="text-[11px] text-text2 break-all font-mono">{status.file || '—'}</div>
        </div>

        {/* 最近日志 */}
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="px-3 py-2 flex items-center justify-between border-b border-border">
            <span className="text-xs font-medium">{t('teams.debugTailTitle', { n: entries.length })}</span>
            <Button variant="ghost" size="xs" onClick={refresh}>{t('teams.debugRefresh')}</Button>
          </div>
          <div className="max-h-64 overflow-y-auto px-3 py-2 space-y-1 font-mono">
            {entries.length === 0 && (
              <div className="text-[11px] text-text2 py-4 text-center font-sans">{t('teams.debugTailEmpty')}</div>
            )}
            {entries.map((e) => (
              <div key={`${e.seq}-${e.ts}`} className="text-[11px] leading-snug">
                <span className="text-text2">{fmtTime(e)}</span>
                {' '}
                <span className={e.level === 'verbose' ? 'text-text2' : 'text-text'}>
                  {e.scope}/{e.event}
                </span>
                <span className="text-text2"> {brief(e.data)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
