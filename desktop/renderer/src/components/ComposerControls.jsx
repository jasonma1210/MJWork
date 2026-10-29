import ModelSelector from './ModelSelector';
import { IconAlert, IconBranch, IconFolder, IconShield } from './icons';
import { APPROVAL_MODES, SANDBOX_MODES, migrateApprovalMode, isRiskyApproval } from '../constants/approval';
import { useI18n, tGlobal } from '../i18n';

// Composer 任务控制台（对标 Codex 输入框周围区域）
// 模型 / 权限档位 / 运行模式三项常驻，其余能力在 D 批补齐
// A10：档位值域统一到 constants/approval.js（此前与设置页两处值域冲突，设置实际失效）
// i18n：顶层常量会冻结求值结果（切语言不更新），与 getModeOptions 同款改为渲染期函数
export function getPermissionOptions() {
  return APPROVAL_MODES.map((m) => ({ value: m.id, label: tGlobal(m.nameKey) }));
}

export function getSandboxOptions() {
  return SANDBOX_MODES.map((m) => ({ value: m.id, label: tGlobal(m.nameKey) }));
}

// i18n：顶层常量不能冻结求值结果，改为函数在渲染时调用，切换语言即时生效
export function getModeOptions() {
  return [
    { value: 'local', label: tGlobal('composer.mode.local'), hint: tGlobal('composer.mode.localHint') },
    { value: 'worktree', label: tGlobal('composer.mode.worktree'), hint: tGlobal('composer.mode.worktreeHint') },
  ];
}

// 统一 chip 设计语言：与输入框内所有下拉控件同高（h-7）、同圆角（rounded-lg）、
// 同字号（text-xs），透明底 + 描边，悬停才出现底色——一排控件视觉重量一致，
// 不再有的贴底有的浮高（真机反馈：原 py-1 + bg-surface 与卡片同色，控件高低参差）。
// 注意：CHIP 刻意不含边框色——状态色（accent/warn）与默认 border-border 同权重，
// 拼在一起靠样式表顺序决胜不可靠，故由使用处互斥拼接，任何时刻只出现一个边框色类。
// 2026-10-29：整行固定单行（flex-nowrap）——左右侧栏同时展开时输入框变窄，此前 flex-wrap
// 会把「本地模式 / 权限 / 沙箱 / 模型」拆成两三行叠起来（用户实测：工具行被压成一个方块）。
// 单行 + chip 不收缩 + 模型 chip 自行截断：宽度不足时只牺牲模型名长度，行结构不变。
const CHIP = 'h-7 shrink-0 inline-flex items-center gap-2 rounded-lg border px-2 text-xs text-text bg-transparent hover:bg-hover cursor-pointer transition-colors';
const CHIP_SELECT = 'bg-transparent outline-none cursor-pointer max-w-[140px] truncate';

export default function ComposerControls({ providers, selectedModel, onSelectModel, approval, onApprovalChange, project, mode, onModeChange, worktreeInfo }) {
  const { t } = useI18n();
  const modeOptions = getModeOptions();
  const permissionOptions = getPermissionOptions();
  const sandboxOptions = getSandboxOptions();
  // 遗留值迁移：旧 auto / always-ask 读取时映射到新档位
  const approvalMode = migrateApprovalMode(approval?.approval_mode);
  const risky = isRiskyApproval(approval);
  return (
    <div className="flex items-center gap-2 flex-nowrap min-w-0">
      {/* 运行模式：本地 / 隔离工作区（worktree 态转 accent 色，隔离执行必须可见） */}
      <label
        className={`${CHIP} ${mode === 'worktree' ? 'border-accent bg-accent-bg text-accent' : 'border-border'}`}
        title={modeOptions.find((o) => o.value === mode)?.hint}
      >
        <IconBranch size={12} className="shrink-0" />
        <select
          value={mode}
          onChange={(e) => onModeChange?.(e.target.value)}
          className={CHIP_SELECT}
        >
          {modeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {mode === 'worktree' && worktreeInfo?.branch && (
        <span className="text-xs text-text2 truncate max-w-[160px]" title={t('composer.isolatedBranch', { branch: worktreeInfo.branch })}>
          {worktreeInfo.branch}
        </span>
      )}

      {/* 权限档位（风险态强化：自动执行 / 完全访问时转警示色 —— 权限档位必须可见） */}
      <label className={`${CHIP} ${risky ? 'border-warn bg-warn-bg text-warn' : 'border-border'}`} title={risky ? t('composer.riskyApprovalTip') : t('composer.approvalTierTip')}>
        {risky ? <IconAlert size={12} className="shrink-0" /> : <IconShield size={12} className="shrink-0 text-text2" />}
        <select
          value={approvalMode}
          onChange={(e) => onApprovalChange?.({ approval_mode: e.target.value })}
          className={`${CHIP_SELECT} ${risky ? 'text-warn' : ''}`}
        >
          {permissionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>

      {/* 沙箱策略（图标改 IconFolder：原 IconBranch 与运行模式重复，语义错位） */}
      <label className={`${CHIP} border-border`} title={t('composer.sandboxPolicyTip')}>
        <IconFolder size={12} className="shrink-0 text-text2" />
        <select
          value={approval?.sandbox_policy || 'workspace-write'}
          onChange={(e) => onApprovalChange?.({ sandbox_policy: e.target.value })}
          className={CHIP_SELECT}
        >
          {sandboxOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>

      {/* 模型（触发器即 chip，IconCpu 已内联进 ModelSelector 按钮） */}
      <ModelSelector providers={providers} selected={selectedModel} onSelect={onSelectModel} />
    </div>
  );
}