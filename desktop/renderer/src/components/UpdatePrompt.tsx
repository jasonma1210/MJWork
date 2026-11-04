// 启动自动更新提示：常驻挂载在 App 根部，不随「设置」弹窗开合而卸载。
//
// 链路（2026-11-04 用户反馈「启动 app 后应自动扫描更新并弹窗」）：
//   main.js whenReady → updater.scheduleAutoUpdateCheck()（10s，autoDownload 恒 false）
//     → 'update-available' → 主进程 send('available', { version, releaseNotes, downloadUrl })
//     → 本组件订阅 updater:status，展示版本号 + ≤40 字更新说明 + 「取消 / 更新」
//     → 只有点「更新」才调 downloadUpdate；取消仅关弹窗，不写任何持久化标记，
//       因此下次进程启动会重新检查并再弹；本次会话内则由 dismissedRef 挡住重复打扰，
//       用户仍可到「设置 / 通用 / 版本更新」手动点「下载更新」。
//
// 为什么要 updater:lastAvailable 补拉：10s 自动检查可能早于窗口加载完成，
// 事件发出时渲染层还没有订阅者；主进程缓存 lastAvailable，挂载时主动补一次。
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import Modal from './ui/Modal';
import Button from './ui/Button';

/** 与 main/updater/index.js 的 RELEASE_NOTES_MAX_CHARS 对齐（两侧各自截断，互不信任）。 */
export const NOTES_LIMIT = 40;

/** 纯函数：弹窗侧兜底截断，任何来源的更新说明都不会超过 40 字。按码点切，避免代理对断裂。 */
export function clipNotes(text: unknown, limit = NOTES_LIMIT): string {
  const cap = Math.max(1, Math.trunc(Number(limit) || NOTES_LIMIT));
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= cap) return chars.join('');
  return `${chars.slice(0, cap - 1).join('')}…`;
}

export type UpdatePhase = 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateInfo {
  version?: string;
  releaseNotes?: string;
  downloadUrl?: string;
}

interface UpdaterEvent {
  status: string;
  version?: string;
  releaseNotes?: string;
  percent?: number;
  message?: string;
  downloadUrl?: string;
}

export interface UpdatePromptViewProps {
  open: boolean;
  version: string;
  notes: string;
  phase: UpdatePhase;
  percent: number;
  errorText: string;
  onCancel: () => void;
  onUpdate: () => void;
  onRestart: () => void;
}

/** 纯展示层：单独导出以便渲染冒烟直接给 props，覆盖到弹窗主体而不只是「未打开」的空态。 */
export function UpdatePromptView({
  open, version, notes, phase, percent, errorText, onCancel, onUpdate, onRestart,
}: UpdatePromptViewProps) {
  const { t } = useI18n();
  const footer = phase === 'available' ? (
    <>
      <Button variant="secondary" size="sm" onClick={onCancel}>{t('updatePrompt.cancel')}</Button>
      <Button variant="primary" size="sm" onClick={onUpdate}>{t('updatePrompt.update')}</Button>
    </>
  ) : phase === 'downloaded' ? (
    <>
      <Button variant="secondary" size="sm" onClick={onCancel}>{t('updatePrompt.later')}</Button>
      <Button variant="primary" size="sm" onClick={onRestart}>{t('updatePrompt.restart')}</Button>
    </>
  ) : phase === 'error' ? (
    <>
      <Button variant="secondary" size="sm" onClick={onCancel}>{t('updatePrompt.cancel')}</Button>
      <Button variant="primary" size="sm" onClick={onUpdate}>{t('updatePrompt.retry')}</Button>
    </>
  ) : null;

  return (
    <Modal open={open} onClose={onCancel} title={t('updatePrompt.title')} size="sm" footer={footer}>
      <div className="text-sm font-medium text-text">{t('updatePrompt.version', { version })}</div>
      <div className="mt-3 text-xs text-text2">{t('updatePrompt.notesLabel')}</div>
      <div className="mt-1 text-sm text-text break-words">{clipNotes(notes) || t('updatePrompt.defaultNotes')}</div>
      {phase === 'downloading' && (
        <div className="mt-3 text-xs text-text2">{t('updatePrompt.downloading', { percent })}</div>
      )}
      {phase === 'downloaded' && (
        <div className="mt-3 text-xs text-text2">{t('updatePrompt.downloaded')}</div>
      )}
      {phase === 'error' && (
        <div className="mt-3 text-xs text-text2">{t('updatePrompt.failed', { message: errorText })}</div>
      )}
      <div className="mt-4 text-xs text-text2">{t('updatePrompt.manualHint')}</div>
    </Modal>
  );
}

export default function UpdatePrompt() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>('available');
  const [percent, setPercent] = useState(0);
  const [errorText, setErrorText] = useState('');
  // 本次会话内「已取消」/「已点更新」标记。刻意不写 localStorage：
  // 用户要求取消后下次启动仍要提示，进程重启即自然复位。
  const dismissedRef = useRef(false);
  const acceptedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    const apply = (d: UpdaterEvent) => {
      if (!alive) return;
      if (d.status === 'available') {
        if (dismissedRef.current || acceptedRef.current) return;
        setInfo({ version: d.version || '', releaseNotes: d.releaseNotes || '', downloadUrl: d.downloadUrl || '' });
        setPhase('available');
        setErrorText('');
      } else if (d.status === 'downloading' && acceptedRef.current) {
        setPercent(Number(d.percent) || 0);
        setPhase('downloading');
      } else if (d.status === 'downloaded' && acceptedRef.current) {
        setPhase('downloaded');
      } else if (d.status === 'error' && acceptedRef.current) {
        setErrorText(d.message || '');
        setPhase('error');
      }
    };
    const mj = window.mjcode;
    const off = window.mjcode?.onUpdaterStatus?.((d: UpdaterEvent) => apply(d)) as (() => void) | undefined;
    // 补拉窗口加载完成之前已发现的新版本；非 idle 说明已进入下载/完成，不再展示「取消 / 更新」。
    Promise.resolve(mj?.getLastUpdate?.())
      .then((raw) => {
        const r = raw as { ok?: boolean; info?: UpdateInfo; state?: string } | undefined;
        if (alive && r?.ok && r.info && (r.state || 'idle') === 'idle') {
          apply({ status: 'available', ...r.info });
        }
      })
      .catch((err) => console.warn('[updatePrompt] lastAvailable probe failed:', err));
    return () => { alive = false; if (typeof off === 'function') off(); };
  }, []);

  function dismiss() {
    dismissedRef.current = true;
    setInfo(null);
  }

  async function startDownload() {
    acceptedRef.current = true;
    setPhase('downloading');
    setPercent(0);
    setErrorText('');
    const mj = window.mjcode;
    try {
      const r = (await mj?.downloadUpdate?.()) as
        { ok?: boolean; state?: string; error?: string } | undefined;
      if (r?.ok === false) {
        setErrorText(r.error || '');
        setPhase('error');
      } else if (r?.state === 'downloaded') {
        setPhase('downloaded');
      }
    } catch (err) {
      setErrorText(String((err as Error)?.message || err));
      setPhase('error');
    }
  }

  async function restart() {
    const mj = window.mjcode;
    try { await mj?.installUpdate?.(); }
    catch (err) { console.warn('[updatePrompt] installUpdate failed:', err); }
  }

  return (
    <UpdatePromptView
      open={!!info}
      version={info?.version || ''}
      notes={info?.releaseNotes || ''}
      phase={phase}
      percent={percent}
      errorText={errorText}
      onCancel={dismiss}
      onUpdate={startDownload}
      onRestart={restart}
    />
  );
}
