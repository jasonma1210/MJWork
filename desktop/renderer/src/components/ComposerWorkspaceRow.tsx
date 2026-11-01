// 输入框行的「工作区」两件套：分支选择器 + Worktree 勾选框
//
// 形态对齐 WorkBuddy：分支 chip 与 `☐ Worktree` 勾选框**同一行**、紧邻（见其
// WorktreeBranchTrigger：chip 按钮 + role="checkbox" 的勾选框 + 共用一个浮层）。
// 这里刻意不用 ui/Switch：WB 用的是勾选框语义——「本次任务带不带这个选项」，
// 而不是「长期偏好开不开」。两者并存：设置页的偏好仍是 Switch。
//
// 门控不在本组件：新建任务页不得把「上次打开的项目」当已选事实展示，那条判据由
// Composer 的 workspaceBound 门控统一把住（见 test/settings-coverage.test.js）。
import Checkbox from './ui/Checkbox';
import GitBranchPicker from './GitBranchPicker';
import { useI18n } from '../i18n';

export interface ComposerWorkspaceRowProps {
  projectPath?: string;
  /** 工作目录实际所在分支（事实） */
  currentBranch?: string;
  /** 本次任务选中的基线分支（空 = 跟随当前） */
  selectedBranch?: string;
  onSelectBranch?: (b: string) => void;
  /** 勾选态 = runMode === 'worktree' */
  worktree: boolean;
  /** 副本已存在：此时改分支不影响任何东西（副本基线在建的那一刻就钉死了），置灰并说明 */
  locked?: boolean;
  onToggleWorktree?: (next: boolean) => void;
  /** 分支/拉取的结果反馈（与 worktree 的 modeMsg 同一条出口） */
  onMsg?: (msg: string) => void;
}

export default function ComposerWorkspaceRow({
  projectPath = '', currentBranch = '', selectedBranch = '', onSelectBranch,
  worktree, locked = false, onToggleWorktree, onMsg,
}: ComposerWorkspaceRowProps) {
  const { t } = useI18n();
  // 没有工作区就没有「基线分支」可谈：勾选框置灰（WB 同款：无分支可依时 disabled）
  const canToggle = !!projectPath;
  return (
    <>
      {projectPath && (
        <GitBranchPicker
          cwd={projectPath}
          locked={locked}
          lockedHint={t('worktree.branchLocked')}
          currentBranch={currentBranch}
          selectedBranch={selectedBranch}
          onSelect={(b) => onSelectBranch?.(b)}
          onMsg={onMsg}
        />
      )}
      <Checkbox
        checked={worktree}
        onChange={(next) => onToggleWorktree?.(next)}
        label={t('worktree.enableHint')}
        title={canToggle ? t('worktree.enableHint') : t('worktree.initGitHint')}
        disabled={!canToggle}
      >
        Worktree
      </Checkbox>
    </>
  );
}
