import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { confirm, toast } from './feedback';
import InlineAlert from './InlineAlert';
import Modal from './ui/Modal';
import { IconX } from './icons';
import { useI18n } from '../i18n';

// A3：已归档会话管理 —— 本地「删除」的真实语义是归档，必须提供恢复/彻底删除出口
// （对标 Codex Settings → Archived Threads）
export default function ArchiveModal({ onClose, onChanged, onSelect }) {
  const { t } = useI18n();
  const [list, setList] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setList(await api.archivedThreads());
    } catch (err) {
      setError(err.message || t('archive.loadFailed'));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function restore(thread) {
    const r = await api.restoreThread(thread.id);
    if (r?.ok) {
      toast({ message: t('archive.restoredToast', { title: thread.title || t('archive.newSession') }) });
      onChanged?.();
      onSelect?.(thread);
      load();
    } else {
      setError(r?.error || t('archive.restoreFailed'));
    }
  }

  async function purge(thread) {
    const ok = await confirm({
      title: t('archive.purgeTitle'),
      message: t('archive.purgeMessage', { title: thread.title || t('archive.newSession') }),
      danger: true,
      confirmLabel: t('archive.purgeConfirm'),
    });
    if (!ok) return;
    const r = await api.purgeThread(thread.id);
    if (r?.ok) {
      onChanged?.();
      load();
    } else {
      setError(r?.error || t('archive.deleteFailed'));
    }
  }

  // P1-9⑤：外壳交给 ui/Modal（role=dialog + aria-modal + 焦点陷阱 + Esc + 关闭归还焦点）；
  // frameless 表示「只换外壳」——面板的宽高/底色/圆角/阴影仍是下面这一层自带，视觉零改动。
  return (
    <Modal open onClose={onClose} frameless ariaLabel={t('archive.title')}>
      <div
        className="w-[560px] max-w-[calc(100vw-2rem)] max-h-[70vh] flex flex-col rounded-2xl bg-raise border border-border shadow-[var(--shadow-modal)]"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">{t('archive.title')}</h2>
            <p className="text-xs text-text2 mt-1">{t('archive.subtitle')}</p>
          </div>
          <button onClick={onClose} className="text-text2 hover:text-text" aria-label={t('archive.close')}><IconX size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {error && <div className="mb-3"><InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert></div>}
          {loading ? (
            <p className="text-text2 text-sm text-center py-8">{t('archive.loading')}</p>
          ) : list.length === 0 ? (
            <p className="text-text2 text-sm text-center py-8">{t('archive.empty')}</p>
          ) : (
            list.map((thread) => (
              <div key={thread.id} className="flex items-center gap-3 py-3 border-b border-border last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{thread.title || t('archive.newSession')}</div>
                  <div className="text-xs text-text2 mt-1">
                    {new Date(thread.updatedAt || thread.createdAt || Date.now()).toLocaleString('zh-CN')}
                  </div>
                </div>
                <button onClick={() => restore(thread)} className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-hover shrink-0">
                  {t('archive.restore')}
                </button>
                <button onClick={() => purge(thread)} className="text-xs px-3 py-2 rounded-lg border border-border text-danger hover:bg-hover shrink-0">
                  {t('archive.purge')}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
