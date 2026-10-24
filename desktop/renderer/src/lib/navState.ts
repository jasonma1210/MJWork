// 侧栏一级导航的选中态判定（纯函数，无 DOM/无 React 依赖）
//
// 背景（2026-10-18 用户实测）：「我选中的左侧菜单，虽然跳转的页面是对的，但是左侧的菜单
// 没有被选中」。真因两条，缺一都会复现：
//   ① 判据不互斥也不穷尽：此前只有「新建会话」传了 active，且写成 `!activeThread`。
//      定时任务页没有打开会话 → 该亮不亮；反之一旦有会话又可能两个一起亮。
//   ② 选中样式是 `bg-hover`，与 hover 同色 → 即使 active 传对了，视觉上仍等于没选中。
// 本函数只解决 ①；②由 Sidebar 的 NavItem 用 select-bg/select-fg 专用令牌解决。
//
// 2026-10-24 双入口重组（设计文档 §7.7 / §9 P0-1）：一级导航从 4 项
// （新建会话 / 定时任务 / 生态中心 / 团队编制）收敛为 2 项（新建任务 / 助理），
// 生态中心按 D8 降级为弹层（不再是一级入口，但仍保留可达入口与选中态）。
// 「定时任务」与「团队编制」不再是独立入口，而是「助理」工作台内的子 Tab
// （Tab1 军团编制 / Tab3 定时任务）。
//
// ⚠ 破坏性变更的兼容口径（必须同时满足这三条，否则旧调用方会突然全失效）：
//   ① NavKey 的联合类型里**保留** 'scheduled' | 'teams' ⇒ 旧代码按字面量比较
//      （`k === 'scheduled'`）仍能编译、仍能跑；
//   ② activeNavOf **不再返回**这两个值 ⇒ 旧代码若按返回值分支会落到「都不匹配」的分支，
//      这正是「定时任务/军团编制不再是独立入口」的真实语义；
//   ③ NavViewState 同时保留 showScheduled / showTeams 作为**兼容输入**（可选字段）：
//      它们为 true 时 activeNavOf 仍返回 'assistant' —— 于是只改了视图状态、
//      没改判定的旧调用方拿到的仍是「某个一级入口被选中」，而不是静默返回 ''。
export type NavKey = 'new' | 'assistant' | 'ecosystem' | '' | 'scheduled' | 'teams';

/** 助理工作台的子 Tab（见 lib/assistantTabs.ts；此处只做类型引用，避免循环依赖） */
export type NavAssistantTab = 'teams' | 'aiTeam' | 'scheduled' | 'complex';

export interface NavViewState {
  /** 助理工作台是否在前台（一级入口「助理」） */
  showAssistant: boolean;
  /** 助理工作台当前子 Tab（可选；不影响一级选中态，仅供展示层回显） */
  assistantTab?: NavAssistantTab;
  /**
   * 定时任务页是否在前台 —— **兼容输入**。
   * 重组后它是「助理」的子 Tab（不再是独立入口），但旧调用方仍可能传这个字段，
   * 此时 activeNavOf 仍返回 'assistant'（助理子态统一收敛到同一个入口）。
   */
  showScheduled?: boolean;
  /** 工作台是否在前台 */
  showDashboard: boolean;
  /** 生态中心（弹层）是否打开 */
  showEcosystem: boolean;
  /**
   * MJ 军团（团队编制页）是否在前台 —— **兼容输入**，语义同 showScheduled
   * （它是助理 Tab1，不再是独立入口）。
   */
  showTeams?: boolean;
  /** 是否选中了某个会话 */
  hasActiveThread: boolean;
}

export function activeNavOf(view: NavViewState): NavKey {
  // 助理及其兼容子态（定时任务 / 军团编制）统一收敛为一个一级入口。
  // 顺序说明：助理排在生态中心之前——生态中心是**覆盖在当前页之上的弹层**，
  // 打开它时底层仍是助理页，一级导航应当继续点亮「助理」。
  if (view.showAssistant || view.showScheduled || view.showTeams) return 'assistant';
  if (view.showEcosystem) return 'ecosystem';
  if (view.showDashboard || view.hasActiveThread) return '';
  return 'new';
}
