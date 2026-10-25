// 统一顶栏的动作组（自 App.jsx 的 <header> 内部原样搬出：纯物理移动，零行为变更）
//
// 为什么搬：App.jsx 实测 800 行整，而 max-lines 门禁判据是 **> 800** 且它**不在**
// BASELINE_800 豁免清单里 ⇒ 余量为 0，净 +1 行即红；后续挂工作台页必须有净减。
// 搬迁纪律：5 个按钮 className 一字未改、onClick 语义未改、DOM 顺序未改 —— 变的
// 只有宿主文件，故 ui-conventions 的 rawButton 计数（252）保持不变。
// <header> 开闭标签与它的 className 刻意留在 App.jsx（本组件只渲染其子节点）：
// thread-composer.test.js:100 取到该块后立即 .test(headerBlock[0])，块消失是
// TypeError（直接崩，不是断言失败）；而 pl-[var(--titlebar-inset)] 是预留 macOS
// 交通灯位（darwin 80px / 其余 12px），顶栏常驻全宽、不随左右栏开合移动。
import { IconChart, IconPalette, IconPanelRight, IconSearch, IconSidebar } from './icons';
import { useI18n } from '../i18n';

export interface TopBarActionsProps {
  onToggleSidebar: () => void;   // 左栏开关（⌘B 同落点）
  onOpenSearch: () => void;      // ⌘K 命令面板；⌘P 在右栏非文件面板时也落这里
  paneOpen: boolean;             // 右栏当前开合：开关常驻，用高亮区分而非消失
  onTogglePane: () => void;      // ⌘⌥B；调用方已用 activeThreadRef 守作用域
  hasActiveThread: boolean;      // 无活动会话时禁用（右栏是任务作用域，跨会话会泄漏）
  onCycleTheme: () => void;      // 在 THEMES 里循环；全部主题在 设置 → 外观
  themeLabel: string;            // 当前主题显示名（i18n 由调用方解析后传入）
  localMode: boolean;            // 是否展示「本机模式」标记
  showDashboard: boolean;        // 「用量」页是否在当前视图（决定按钮选中态）
  onOpenDashboard: () => void;   // 互斥视图：调用方先 resetView 再落该视图
}

export default function TopBarActions({
  onToggleSidebar, onOpenSearch, paneOpen, onTogglePane, hasActiveThread,
  onCycleTheme, themeLabel, localMode, showDashboard, onOpenDashboard,
}: TopBarActionsProps) {
  const { t } = useI18n();
  return (
    <>
      <button
        onClick={onToggleSidebar}
        className="text-text2 hover:text-text p-1 rounded-lg"
        title={t('app.toggleSidebarTitle')}
        aria-label={t('app.toggleSidebar')}
      >
        <IconSidebar size={16} />
      </button>
      <button
        onClick={onOpenSearch}
        className="text-text2 hover:text-text p-1 rounded-lg"
        title={t('app.searchTitle')}
        aria-label={t('app.search')}
      >
        <IconSearch size={16} />
      </button>
      <div className="ml-auto flex items-center gap-2">
        {/* 右栏开关常驻（与左栏开关对称）：开/关都在，状态用高亮区分 */}
        <button
          onClick={onTogglePane}
          disabled={!hasActiveThread}
          className={`p-1 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${paneOpen ? 'text-text' : 'text-text2 hover:text-text'}`}
          title={hasActiveThread ? t('app.togglePaneTitle') : t('app.paneDisabledHint')}
          aria-label={t('app.togglePane')}
        >
          <IconPanelRight size={16} />
        </button>
        <button onClick={onCycleTheme}
          className="text-text2 hover:text-text px-2 py-1 rounded-lg" title={t('app.themeTitle', { name: themeLabel })} aria-label={t('app.switchTheme')}>
          <IconPalette size={15} />
        </button>
        {localMode && (
          <span className="text-caption px-2 py-1 rounded-lg bg-warn-bg text-warn" title={t('app.offlineTitle')}>
            {t('app.offlineMode')}
          </span>
        )}
        <button onClick={onOpenDashboard}
          className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 ${showDashboard ? 'bg-accent-solid text-on-accent' : 'text-text2 hover:text-text'}`}>
          <IconChart size={14} /> {t('app.data')}
        </button>
      </div>
    </>
  );
}
