// 版本更新区块（原「账户与更新」页随登录系统移除后，迁入通用页保留更新能力入口）：
// 手动检查 + 状态订阅 + P1-N 手动下载兜底链接（由主进程 build.publish 推导）
// P0-3：available 态补「下载更新」按钮（此前全仓无 downloadUpdate 调用，用户看到新版本
// 也无从更新，只剩 Releases 链接）；下载中经 updater:status 'downloading' 显示进度，
// 'downloaded' 态渲染「重启安装」。手动下载链接保留为自动链路失败时的回滚手段。
import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import Button from './ui/Button';

interface UpdaterEvent {
  status: string;
  version?: string;
  percent?: number;
  message?: string;
  downloadUrl?: string;
}

// 与 SettingsModal 内部 Section 同款卡片容器（该组件为文件私有，此处独立复刻避免循环依赖）
const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mb-8">
    <h2 className="text-base font-semibold mb-3">{title}</h2>
    <div className="bg-surface border border-border rounded-2xl px-5">{children}</div>
  </div>
);

export default function UpdateSection() {
  const { t } = useI18n();
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState('');
  const [updaterState, setUpdaterState] = useState(''); // 原始状态机值（驱动「重启安装」按钮显隐）
  // 下载完成是终态。组件重挂载会清空 useState，主进程持有的唯一真源会在 skipped 响应时
  // 重推 downloaded；这个 ref 负责本次挂载内挡住迟到的 available/downloading 事件。
  const downloadedRef = useRef(false);

  useEffect(() => {
    if (!window.mjcode?.onUpdaterStatus) return;
    const off = window.mjcode.onUpdaterStatus((d: UpdaterEvent) => {
      // 终态保护：忽略 downloaded 之后迟到的 available / downloading / checking / error。
      // 否则下载完成后一次 checkForUpdates 发来的 update-available 会把状态打回 available，
      // 「下载更新」按钮重新露出 ⇒ 100% 之后又开始第二轮下载。
      if (downloadedRef.current && d.status !== 'downloaded') return;
      if (d.status === 'downloaded') downloadedRef.current = true;
      const map: Record<string, string> = {
        checking: t('settings.updaterChecking'),
        available: t('settings.updaterAvailable', { version: d.version || '' }),
        'up-to-date': t('settings.updaterUpToDate'),
        downloading: t('settings.updaterDownloading', { percent: d.percent || 0 }),
        downloaded: t('settings.updaterDownloaded'),
        error: t('settings.updaterError', { message: d.message || t('runtime.unknownError') }),
      };
      setUpdaterState(d.status);
      setUpdateStatus(map[d.status] || d.status);
      setUpdateError('');
      // P1-N：error/available 态携带手动下载链接（自动更新链路失败时的降级出口）
      setUpdateDownloadUrl((d.status === 'error' || d.status === 'available') ? (d.downloadUrl || '') : '');
    });
    return () => { if (typeof off === 'function') off(); };
  }, [t]);

  async function check() {
    if (!downloadedRef.current) setUpdateStatus(t('settings.updaterCheckingNow'));
    setUpdateError('');
    try {
      const r = (await window.mjcode?.checkUpdates?.()) as
        { ok?: boolean; skipped?: boolean; state?: string; error?: string; downloadUrl?: string } | undefined;
      if (r && !r.ok) {
        setUpdateError(r.error || t('settings.checkFailedLabel'));
        setUpdateDownloadUrl(r.downloadUrl || ''); // P1-N：手动检查失败同样给降级链接
      } else if (r?.skipped && r.state === 'downloaded') {
        downloadedRef.current = true;
        setUpdaterState('downloaded');
        setUpdateStatus(t('settings.updaterDownloaded'));
      }
    } catch (err) {
      setUpdateError((err as Error).message);
    }
  }

  // P0-3：available 态触发下载（updater:download → autoUpdater.downloadUpdate()）。
  // 未打包/初始化失败时主进程返回 { ok:false, error }，这里如实展示，不假装在下载。
  // 点击后立刻乐观置为 downloading：download-progress 是异步事件，等它到达才禁用按钮
  // 会留下一个可连点的窗口；主进程另有幂等状态机作唯一真源，此处只负责把 UI 收紧。
  async function download() {
    if (downloadedRef.current) return;
    setUpdateError('');
    setUpdaterState('downloading');
    setUpdateStatus(t('settings.updaterDownloading', { percent: 0 }));
    try {
      const r = (await window.mjcode?.downloadUpdate?.()) as
        { ok?: boolean; skipped?: boolean; state?: string; error?: string; downloadUrl?: string } | undefined;
      if (r && !r.ok) {
        setUpdaterState('error');
        setUpdateError(t('settings.updaterDownloadFailed', { message: r.error || t('runtime.unknownError') }));
        setUpdateDownloadUrl(r.downloadUrl || '');
      } else if (r?.state === 'downloaded') {
        downloadedRef.current = true;
        setUpdaterState('downloaded');
        setUpdateStatus(t('settings.updaterDownloaded'));
      }
    } catch (err) {
      setUpdaterState('error');
      setUpdateError((err as Error).message);
    }
  }

  async function install() {
    try { await window.mjcode?.installUpdate?.(); } catch (err) { setUpdateError((err as Error).message); }
  }

  return (
    <Section title={t('settings.updateTitle')}>
      <div className="py-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{t('settings.updateCheckTitle')}</div>
          <div className="text-xs text-text2 mt-1">{t('settings.updateNote')}</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={check} className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-hover">{t('settings.checkUpdate')}</button>
          {/* P0-3：available 态「下载更新」——downloading 中禁用防重复触发（进度经状态文案展示） */}
          {(updaterState === 'available' || updaterState === 'downloading') && (
            <Button variant="primary" size="sm" onClick={download} disabled={updaterState === 'downloading'}>{t('settings.updaterDownloadBtn')}</Button>
          )}
          {updaterState === 'downloaded' && (
            <Button variant="primary" size="sm" onClick={install}>{t('settings.restartInstall')}</Button>
          )}
        </div>
      </div>
      {(updateStatus || updateError) && (
        <div className="pb-3 text-xs text-text2">
          {updateError || updateStatus}
          {/* P1-N：手动下载兜底——available 态显式提供、失败态降级，用户可自行前往 Releases 页下载 */}
          {updateDownloadUrl && (
            <a href={updateDownloadUrl} target="_blank" rel="noreferrer"
              className="ml-2 text-accent underline" title={updateDownloadUrl}>
              {t('settings.manualDownload')}
            </a>
          )}
        </div>
      )}
    </Section>
  );
}
