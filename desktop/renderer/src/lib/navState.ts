// 侧栏一级导航的选中态判定（纯函数，无 DOM/无 React 依赖）
//
// 背景（2026-10-18 用户实测）：「我选中的左侧菜单，虽然跳转的页面是对的，但是左侧的菜单
// 没有被选中」。真因两条，缺一都会复现：
//   ① 判据不互斥也不穷尽：此前只有「新建会话」传了 active，且写成 `!activeThread`。
//      定时任务页没有打开会话 → 该亮不亮；反之一旦有会话又可能两个一起亮。
//   ② 选中样式是 `bg-hover`，与 hover 同色 → 即使 active 传对了，视觉上仍等于没选中。
// 本函数只解决 ①；②由 Sidebar 的 NavItem 用 select-bg/select-fg 专用令牌解决。
//
// ── 一级导航的两次调整（务必连起来读，否则会误判「为什么又加回来」）──
// 2026-10-24 第一次（设计文档 §7.7 / §9 P0-1）：4 项（新建会话 / 定时任务 / 生态中心 /
//   团队编制）收敛为 2 项（新建任务 / 助理），定时任务与团队编制降为助理的子 Tab。
// 2026-10-24 第二次（用户实测反馈）：「一级菜单下面还是要有定时任务」。
//   ⇒ **定时任务升回一级入口**（它是「什么时候跑」这一维度的唯一管理面，藏在助理的子 Tab 里
//   会让用户找不到），团队编制仍留在助理（它是助理的编制管理，不是并列的运行维度）。
//   最终：新建任务 / 助理 / 定时任务 三项一级入口 + 生态中心（底部，弹层）。
//
// ⚠ 兼容口径：`'teams'` 仍保留在 NavKey 联合类型里（旧代码按字面量比较仍能编译），
//   但 `activeNavOf` **不返回**它——团队编制是助理的子态，统一收敛到 `'assistant'`。
//
// 2026-10-25 第三次调整：新增一级入口「工作台」（desk，MJ Nexus 的开工前一屏）。
//   它与「新建任务」不同：desk 是主动点开的一屏概览，不是「什么都没选」的兜底态，
//   故必须由独立的 showDesk 标志驱动，且**优先级最高**（它在场时其它入口一律不亮，
//   否则会出现「停在 desk 却亮着助理」这类自相矛盾的选中态）。
export type NavKey = 'new' | 'desk' | 'studio' | 'assistant' | 'scheduled' | 'ecosystem' | '' | 'teams';

/** 助理工作台的子 Tab（见 lib/assistantTabs.ts；此处只做类型引用，避免循环依赖） */
export type NavAssistantTab = 'publish' | 'teams' | 'aiTeam';

export interface NavViewState {
  /** 助理工作台是否在前台（一级入口「助理」） */
  showAssistant: boolean;
  /** 助理工作台当前子 Tab（可选；不影响一级选中态，仅供展示层回显） */
  assistantTab?: NavAssistantTab;
  /**
   * 定时任务页是否在前台 —— **一级入口**（2026-10-24 第二次调整后恢复）。
   * 与 showAssistant 互斥由调用方的 resetView 保证；万一同时为 true，
   * 本函数让 `scheduled` 优先（更具体的那个应当点亮）。
   */
  showScheduled?: boolean;
  /** 工作台是否在前台 */
  showDashboard: boolean;
  /** 生态中心（弹层）是否打开 */
  showEcosystem: boolean;
  /**
   * 工作台「接单台」（desk）是否在前台 —— 一级入口，优先级最高。
   * 与 showDashboard 不是同一件事：dashboard 是「用量统计」，desk 是「开工前一屏」。
   */
  showDesk?: boolean;
  /**
   * 工作室是否在前台 —— 一级入口（2026-10-26 新增，对齐原型 studio.js）。
   * 与 showDesk 不同：desk 是「开工前一屏」概览，studio 是「项目空间 + 工件」的常驻管理面。
   */
  showStudio?: boolean;
  /**
   * MJ 军团（团队编制页）是否在前台 —— **兼容输入**：
   * 它是助理 Tab，不再是独立入口，故仍返回 'assistant'。
   */
  showTeams?: boolean;
  /** 是否选中了某个会话 */
  hasActiveThread: boolean;
}

export function activeNavOf(view: NavViewState): NavKey {
  // 接单台（desk）优先级最高：它是用户主动点开的一屏，在场时其它入口一律不亮。
  if (view.showDesk) return 'desk';
  // 工作室是一级入口（2026-10-26）：优先级仅次于接单台，保证「点了工作室就一定点亮它」。
  if (view.showStudio) return 'studio';
  // 定时任务是一级入口：排在最前，保证「点了定时任务就一定点亮它」。
  if (view.showScheduled) return 'scheduled';
  // 助理及其兼容子态（团队编制）统一收敛为一个一级入口。
  if (view.showAssistant || view.showTeams) return 'assistant';
  // 生态中心是**覆盖在当前页之上的弹层**：打开它时底层仍是助理页，
  // 但用户关注点已切到生态中心，故让它优先于 assistant 以下的判定（与调整前一致）。
  if (view.showEcosystem) return 'ecosystem';
  if (view.showDashboard || view.hasActiveThread) return '';
  return 'new';
}
