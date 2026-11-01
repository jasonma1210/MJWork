import { useState } from 'react';
import { IconCheck, IconCopy, IconGitBranch, IconX } from './icons';
import IconButton from './ui/IconButton';
import { confirm, toast } from './feedback';
import { useI18n } from '../i18n';

// 副本分支的展示名：去掉本仓的任务分支前缀（`mjcode/`），与 WorkBuddy 的
// getWorktreeBranchDisplayName 同义。**只影响显示**——复制出去的仍是完整分支名，
// 否则用户粘贴到终端里 checkout 的是一个不存在的分支。
const BRANCH_PREFIX = 'mjcode/';
function displayBranchName(branch, fallback) {
  if (!branch) return fallback || '';
  return branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : branch;
}

// P1-H：隔离工作区收口条——worktree 此前「只建不收」：IPC（promote/sync/remove）早已就绪
// 但渲染层零调用，改动永久滞留副本，用户只能手动敲 git 命令。
// 三个动作均带确认对话框（清理为危险确认），结果经 onMsg 反馈，promote/remove 后回调 onClosed。
export default function WorktreeBar({ worktree, onClosed, onMsg }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState('');
  if (!worktree?.path) return null;

  async function act(kind) {
    const cfg = {
      sync: {
        title: t('worktree.mergeBack'),
        message: t('worktree.mergeBackMsg'),
        confirmLabel: t('worktree.mergeBack'),
      },
      promote: {
        title: t('worktree.promote'),
        message: t('worktree.promoteMsg', { branch: worktree.branch || '' }),
        confirmLabel: t('worktree.promote'),
      },
      remove: {
        title: t('worktree.removeTitle'),
        message: t('worktree.removeMsg'),
        confirmLabel: t('worktree.removeConfirm'),
        danger: true,
      },
    }[kind];
    const ok = await confirm(cfg);
    if (!ok) return;
    setBusy(kind);
    try {
      const r = kind === 'sync'
        ? await window.mjcode.syncWorktree({ path: worktree.path })
        : kind === 'promote'
          ? await window.mjcode.promoteWorktree({ path: worktree.path })
          : await window.mjcode.removeWorktree({ path: worktree.path });
      if (r?.ok) {
        onMsg?.(kind === 'remove' ? t('worktree.cleanedMsg')
          : kind === 'promote' ? t('worktree.promotedMsg', { branch: r.branch || '' })
            : t('worktree.mergedBackMsg'));
        if (kind !== 'sync') onClosed?.(); // promote/remove 后工作区已不存在
      } else {
        onMsg?.(r?.error || t('worktree.opFailed'));
      }
    } catch (err) {
      onMsg?.(err.message || t('worktree.opFailed'));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="max-w-3xl w-full mx-auto mb-3 flex items-center gap-2 flex-wrap bg-accent-bg border border-accent/40 rounded-lg px-3 py-2">
      <IconGitBranch size={13} className="text-accent shrink-0" />
      <span className="text-xs text-text truncate" title={`${worktree.branch || ''} → ${worktree.path}`}>
        {t('worktree.label', { name: displayBranchName(worktree.branch, worktree.path) })}
      </span>
      {worktree.branch && (
        <IconButton
          label={t('worktree.branchLabel.copy')}
          className="h-6 w-6"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(worktree.branch);
              toast({ message: t('worktree.branchCopied') });
            } catch (err) {
              // 剪贴板被系统拒绝（无焦点/权限）时必须说失败，否则用户以为复制成功了
              console.warn('[worktree] copy branch failed:', err);
              onMsg?.(t('worktree.copyFailed'));
            }
          }}
        >
          <IconCopy size={11} />
        </IconButton>
      )}
      <span className="text-xs text-text2">{t('worktree.hint')}</span>
      <div className="flex items-center gap-2 ml-auto">
        <button onClick={() => act('sync')} disabled={busy}
          className="text-xs px-2 py-1 rounded-lg border border-border hover:bg-hover disabled:opacity-50 flex items-center gap-1"
          title={t('worktree.mergeBackHint')}>
          <IconCheck size={11} />{t('worktree.mergeBack')}
        </button>
        <button onClick={() => act('promote')} disabled={busy}
          className="text-xs px-2 py-1 rounded-lg border border-border hover:bg-hover disabled:opacity-50 flex items-center gap-1"
          title={t('worktree.promoteHint')}>
          <IconGitBranch size={11} />{t('worktree.promote')}
        </button>
        <button onClick={() => act('remove')} disabled={busy}
          className="text-xs px-2 py-1 rounded-lg border border-danger text-danger hover:bg-danger-bg disabled:opacity-50 flex items-center gap-1"
          title={t('worktree.removeHint')}>
          <IconX size={11} />{t('worktree.cleanupLabel')}
        </button>
      </div>
    </div>
  );
}
