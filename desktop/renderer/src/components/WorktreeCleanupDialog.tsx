// 副本数量达上限时的清理弹窗（对齐 WorkBuddy 的 WorktreeCleanupDialog）
//
// WB 的实现（解包实测）：宽 480 的 confirm 弹窗、danger 确定键、正文
// 「当前已达到 {count} 个任务工作区（Worktree）上限，无法继续在新任务使用 Worktree。请选择清理范围。」
// 下面一行是 `清理超过 [7|15|30] 天前的任务工作区分支和文件`，默认选 **15**。
//
// 为什么清理范围要给三档而不是「全清」：副本里可能还有用户没合并的改动，唯一安全的判据是
// 「多久没动过」。7 天太激进（周末回来就没了）、30 天太保守（清不出空间），15 是 WB 的默认值。
// 真正兜底的不是天数，而是后端的两条硬规则：脏副本一律跳过、只删 mjcode/ 前缀的任务分支。
import { useEffect, useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import { useI18n } from '../i18n';
import { CLEANUP_DAYS, CLEANUP_DAYS_DEFAULT, WORKTREE_LIMIT } from '../constants/worktree';

export interface CleanupResult {
  cleanedCount: number;
  skippedDirtyCount: number;
  skippedRecentCount: number;
  failedCount: number;
}

export interface WorktreeCleanupDialogProps {
  open: boolean;
  /** 当前副本数（正文里要说出「已达 N 个」） */
  count: number;
  onClose: () => void;
  /** 执行清理；返回分项结果用于回显（不返回就只关窗） */
  onConfirm: (opts: { olderThanDays: number; deleteThreads: boolean }) => Promise<CleanupResult | null | void>;
}

export default function WorktreeCleanupDialog({ open, count, onClose, onConfirm }: WorktreeCleanupDialogProps) {
  const { t } = useI18n();
  const [days, setDays] = useState<number>(CLEANUP_DAYS_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);
  // 默认**不**删会话：副本是缓存，对话历史是资产，两件事不能默认绑在一起（WB 默认删，本仓有意不同）
  const [deleteThreads, setDeleteThreads] = useState(false);

  // 每次打开回到默认档 + 清掉上一次的结果：留着上一轮结果会让人以为「这次已经清过了」
  useEffect(() => {
    if (open) { setDays(CLEANUP_DAYS_DEFAULT); setResult(null); setDeleteThreads(false); }
  }, [open]);

  async function confirm() {
    setBusy(true);
    try {
      const r = await onConfirm({ olderThanDays: days, deleteThreads });
      setResult(r || null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      closeOnOverlay={!busy}
      closeOnEsc={!busy}
      title={t('worktree.cleanup.title')}
      size="md"
      footer={(
        <>
          <Button variant="secondary" size="md" onClick={onClose} disabled={busy}>
            {t('worktree.cleanup.cancel')}
          </Button>
          <Button variant="danger" size="md" onClick={() => void confirm()} loading={busy}>
            {t('worktree.cleanup.confirm')}
          </Button>
        </>
      )}
    >
      <p className="text-xs text-text2 leading-relaxed">
        {t('worktree.cleanup.description', { count: Math.max(count, WORKTREE_LIMIT) })}
      </p>
      <div className="mt-3 flex items-center gap-2 text-xs text-text2">
        <span className="shrink-0">{t('worktree.cleanup.scopePrefix')}</span>
        <div role="radiogroup" aria-label={t('worktree.cleanup.scopeAria')} className="flex items-center gap-1">
          {CLEANUP_DAYS.map((d) => (
            <Button
              key={d}
              size="xs"
              role="radio"
              aria-checked={days === d}
              // 选中用实心档（primary）而不是「描边 + 浅底」：accent-ghost 自带 bg-transparent，
              // 再叠 bg-accent-bg 会变成两个同权重类靠样式表顺序决胜（本仓踩过的坑，见 Button.tsx 头注释）
              variant={days === d ? 'primary' : 'secondary'}
              onClick={() => setDays(d)}
            >
              {d}
            </Button>
          ))}
        </div>
        <span className="shrink-0">{t('worktree.cleanup.scopeSuffix')}</span>
      </div>
      <div className="mt-3">
        <Checkbox
          checked={deleteThreads}
          onChange={setDeleteThreads}
          label={t('worktree.cleanup.deleteThreads')}
          title={t('worktree.cleanup.deleteThreadsHint')}
        >
          {t('worktree.cleanup.deleteThreads')}
        </Checkbox>
        <p className="mt-1 text-caption text-text2">{t('worktree.cleanup.deleteThreadsHint')}</p>
      </div>
      {result && (
        <p className="mt-3 text-caption text-text2">
          {t('worktree.cleanup.done', {
            cleaned: result.cleanedCount,
            dirty: result.skippedDirtyCount,
            recent: result.skippedRecentCount,
          })}
        </p>
      )}
    </Modal>
  );
}
