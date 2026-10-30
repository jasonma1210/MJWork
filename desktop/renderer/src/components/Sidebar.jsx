import ThreadList from './ThreadList';
import { IconPlus, IconPuzzle, IconSettings, IconArchive, IconUsers, IconClock, IconList, IconFolder } from './icons';
import { activeNavOf } from '../lib/navState';
import logo from '../assets/logo.png';
import { useI18n } from '../i18n';

// 左侧栏（2026-10-25 三次调整后）：一级导航 4 项 ——「工作台」+「新建任务」+「助理」+「定时任务」。
//
// 取舍说明（第一版把定时任务并进助理，用户实测后要求恢复，故本版加回）：
//   · 「工作台」（desk，2026-10-25 新增）是**开工前一屏**：今天要决定什么、正在跑什么、
//     最近交了什么、额度还剩多少。它与「新建任务」不是一回事 —— 后者是「什么都没选」的
//     兜底态，前者是用户主动点开的一屏概览，故用独立标志驱动、且优先级最高。
//   · 「定时任务」是**一级入口**：「什么时候跑」是与「做什么」并列的运行维度，
//     藏进助理子 Tab 后用户找不到（用户原话：「一级菜单下面还是要有定时任务」）；
//   · 「团队编制」仍是助理的子 Tab（它是编制管理，不是并列的运行维度）⇒ 侧栏不单列；
//   · 「生态中心」按 D8 降级为弹层，但**必须仍然可达** ⇒ 放在底部次级区
//     （与「已归档」「设置」同列），弹层打开时它高亮（activeNav==='ecosystem'）。
//     为什么不放回一级区：用户只要 2 个一级入口（D8 的推荐结论）；
//     为什么不彻底删掉：生态中心是数字员工/技能/连接器的唯一浏览入口，
//     删掉就断了「招募数字员工 → 组成军团」这条主链路。
export default function Sidebar({
  threads, activeThread, onSelect, onDelete, onRenameThread, onAssignThread, onOpenArchive,
  onOpenAssistant, onOpenScheduled, onOpenDesk, onOpenStudio, onOpenEcosystem, onOpenProjectPicker, onOpenSettings,
  projects, activeProject, onSelectProject, onRemoveProject, onRenameProject,
  onNewThread, filter, view,
}) {
  const { t } = useI18n();
  // 一级导航选中态：互斥且穷尽（判定逻辑与其背景见 lib/navState.ts）
  const activeNav = activeNavOf({
    showAssistant: !!view?.showAssistant,
    assistantTab: view?.assistantTab,
    showDashboard: !!view?.showDashboard,
    showEcosystem: !!view?.showEcosystem,
    // 接单台（desk）：一级入口，优先级最高（在场时其它入口一律不亮）
    showDesk: !!view?.showDesk,
    // 定时任务：一级入口（2026-10-24 第二次调整恢复）
    showScheduled: !!view?.showScheduled,
    // 工作室：一级入口（2026-10-26 新增，对齐原型 studio.js：项目空间 + 工件）
    showStudio: !!view?.showStudio,
    // 兼容输入：团队编制仍是助理的子 Tab
    showTeams: !!view?.showTeams,
    hasActiveThread: !!activeThread,
  });
  // 2026-10-28：品牌行右侧的版本号已移除（需求：「左侧顶部在搜索按钮的右侧的文字内容」去掉）。
  // 随之删掉 getAppVersion 的拉取 —— 它只服务于那一处显示，留着就是空转的 IPC 调用。
  // 版本号仍在「关于/设置」页可见，不影响用户查版本。
  return (
    <aside className="w-[clamp(216px,20vw,260px)] flex flex-col bg-sidebar border-r border-border">
      {/* 品牌头：左栏开关与搜索已上移到统一顶栏（常驻全宽，收起了也还能点），
          此处只留品牌。顶栏已为 macOS 交通灯预留内边距，本行不再需要空出一行。 */}
      <div className="shrink-0 px-4 pt-3 pb-2">
        {/* 品牌行：logo + 名称（右侧版本号已移除，见上方说明）；下一行 slogan 单行显示 */}
        <div className="flex items-center gap-2 min-w-0">
          <img src={logo} alt="" className="w-6 h-6 rounded-lg shrink-0 object-cover" draggable={false} />
          <div className="font-semibold text-base leading-none">MJ Nexus</div>
        </div>
        <div className="text-xs text-text2 mt-1 truncate">{t('sidebar.tagline')}</div>
      </div>

      {/* 一级导航：三个入口 ——「新建任务」「助理」「定时任务」。
          选中态由 activeNavOf 计算（互斥且穷尽）；此前只有 New chat 传 active，
          且判据是 !activeThread —— 在定时任务页里没有打开会话，于是该亮的不亮。 */}
      <div className="px-2 space-y-1">
        <div className="px-3 pb-1 text-caption text-text2">{t('sidebar.groupOperations')}</div>
        <NavItem icon={<IconList size={16} />} label={t('sidebar.desk')} onClick={onOpenDesk} active={activeNav === 'desk'} />
        <NavItem icon={<IconUsers size={16} />} label={t('sidebar.assistant')} onClick={onOpenAssistant} active={activeNav === 'assistant'} />
        <NavItem icon={<IconClock size={16} />} label={t('sidebar.scheduled')} onClick={onOpenScheduled} active={activeNav === 'scheduled'} />
        <NavItem icon={<IconFolder size={16} />} label={t('sidebar.studio')} onClick={onOpenStudio} active={activeNav === 'studio'} />
      </div>

      {/* 会话（项目 → 会话 二级结构） */}
      <div className="flex items-center justify-between mt-4 px-4 mb-1 text-caption text-text2">
        <span>{t('sidebar.threadsSection')}</span>
        <button onClick={onOpenProjectPicker} className="text-text2 hover:text-text" title={t('sidebar.addProject')} aria-label={t('sidebar.addProject')}>
          <IconPlus size={13} />
        </button>
      </div>
      <ThreadList
        projects={projects}
        activeProject={activeProject}
        activeThread={activeThread}
        threads={threads}
        filter={filter}
        onSelectThread={onSelect}
        onSelectProject={onSelectProject}
        onDeleteThread={onDelete}
        onRenameThread={onRenameThread}
        onAssignThread={onAssignThread}
        onNewThread={onNewThread}
        onDeleteProject={onRemoveProject}
        onRenameProject={onRenameProject}
        onOpenProjectPicker={onOpenProjectPicker}
      />

      {/* 底部次级区：生态中心（D8：降级为弹层，但保留可达入口）/ 归档 / 设置 */}
      <div className="border-t border-border px-2 py-2 shrink-0">
        <div className="px-3 pb-1 text-caption text-text2">{t('sidebar.groupResources')}</div>
        <NavItem icon={<IconPuzzle size={16} />} label={t('sidebar.ecosystem')} onClick={onOpenEcosystem} active={activeNav === 'ecosystem'} />
        {/* P1-E：归档管理仅本地模式可用（服务端归档 API 未实现）——在线模式隐藏入口，
            此前在线模式点击会直接弹「归档管理需离线模式或等待服务端支持」错误 */}
        {onOpenArchive && <NavItem icon={<IconArchive size={16} />} label={t('sidebar.archived')} onClick={onOpenArchive} />}
        <NavItem icon={<IconSettings size={16} />} label={t('sidebar.settings')} onClick={onOpenSettings} />
      </div>
    </aside>
  );
}

// 一级导航项。选中态用 select-bg / select-fg 这对**专用令牌**（theme.css 里本来就为
// 「列表当前选中项」准备了它们，此前零引用）：bg-hover 与 hover 同色，选中和划过长得一样，
// 等于"没选中"。aria-current="page" 同时给出语义与可测锚点。
function NavItem({ icon, label, onClick, active }) {
  return (
    <button onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm truncate ${active ? 'bg-select-bg text-select-fg font-medium' : 'hover:bg-hover text-text2'}`}>
      <span className="shrink-0">{icon}</span> {label}
    </button>
  );
}
