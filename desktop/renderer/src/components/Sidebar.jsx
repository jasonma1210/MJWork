import { useEffect, useState } from 'react';
import ThreadList from './ThreadList';
import { IconEdit, IconPlus, IconPuzzle, IconSettings, IconArchive, IconUsers } from './icons';
import { activeNavOf } from '../lib/navState';
import logo from '../assets/logo.png';
import { useI18n } from '../i18n';

// 左侧栏（2026-10-24 双入口重组）：一级导航从 4 项收敛为 2 项 ——「新建任务」+「助理」。
//
// 取舍说明（对应设计文档 §9 P0-2 与 D8「生态中心的层级 = 降级为弹层」）：
//   · 「定时任务」与「团队编制」不再是独立入口，它们是**助理工作台的子 Tab**
//     （Tab1 军团编制 / Tab3 定时任务）⇒ 侧栏删掉这两项；
//   · 「生态中心」按 D8 降级为弹层，但**必须仍然可达** ⇒ 放在底部次级区
//     （与「已归档」「设置」同列），弹层打开时它高亮（activeNav==='ecosystem'）。
//     为什么不放回一级区：用户只要 2 个一级入口（D8 的推荐结论）；
//     为什么不彻底删掉：生态中心是数字员工/技能/连接器的唯一浏览入口，
//     删掉就断了「招募数字员工 → 组成军团」这条主链路。
export default function Sidebar({
  threads, activeThread, onSelect, onNew, onDelete, onRenameThread, onAssignThread, onOpenArchive,
  onOpenAssistant, onOpenEcosystem, onOpenProjectPicker, onOpenSettings,
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
    // 兼容输入：旧调用方仍可能传这两个字段（它们现在是助理的子 Tab）
    showScheduled: !!view?.showScheduled,
    showTeams: !!view?.showTeams,
    hasActiveThread: !!activeThread,
  });
  // 版本号从主进程 app.getVersion() 动态获取（此前硬编码 v1.0.0，发版后永远显示旧版本）
  const [version, setVersion] = useState('');
  useEffect(() => {
    window.mjcode?.getAppVersion?.().then((v) => { if (v) setVersion(String(v)); }).catch(() => {});
  }, []);
  return (
    <aside className="w-[clamp(216px,20vw,260px)] flex flex-col bg-sidebar border-r border-border">
      {/* 品牌头：左栏开关与搜索已上移到统一顶栏（常驻全宽，收起了也还能点），
          此处只留品牌与版本。顶栏已为 macOS 交通灯预留内边距，本行不再需要空出一行。 */}
      <div className="shrink-0 px-4 pt-3 pb-2">
        {/* 品牌行：左 logo+名称，右版本号（右对齐）；下一行 slogan 单行显示 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <img src={logo} alt="MJ Code" className="w-6 h-6 rounded-lg shrink-0 object-cover" draggable={false} />
            <div className="font-semibold text-base leading-none">MJ Code</div>
          </div>
          {version && <div className="text-xs text-text2 shrink-0">{`v${version.replace(/-/g, ' ')}`}</div>}
        </div>
        <div className="text-xs text-text2 mt-1 truncate">{t('sidebar.tagline')}</div>
      </div>

      {/* 一级导航（对标 Codex 的 New chat）：两个入口 ——「新建任务」与「助理」。
          选中态由 activeNavOf 计算（互斥且穷尽）；此前只有 New chat 传 active，
          且判据是 !activeThread —— 在定时任务页里没有打开会话，于是该亮的不亮。 */}
      <div className="px-2 space-y-1">
        <NavItem icon={<IconEdit size={16} />} label={t('sidebar.newChat')} onClick={onNew} active={activeNav === 'new'} />
        <NavItem icon={<IconUsers size={16} />} label={t('sidebar.assistant')} onClick={onOpenAssistant} active={activeNav === 'assistant'} />
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
