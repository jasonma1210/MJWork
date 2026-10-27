// 导航路由的**单一事实来源**（设计文档 §4.3「用单一页面状态替代布尔值叠加」）
//
// 为什么要有这个文件：此前 App.jsx 用 6 个独立布尔值（showDesk / showStudio /
// showAssistant / showScheduled / showDashboard / showEcosystem）拼出当前页面。
// 布尔叠加有两个致命性质：
//   ① **非法组合可表示**：{showDesk:true, showStudio:true} 是合法 JS 值，但没有任何产品
//      含义 —— 只能靠「优先级函数」在渲染期挑一个，等于把不一致推迟到显示层兜；
//   ② **新增入口要改 N 处**：加一个 ledger 要同时改 6 个 setState、resetView、
//      侧栏 view 字面量、顶栏 view 字面量、ChatArea 隐藏条件 —— 漏一处就是「点了没亮」。
//
// 本模块把状态收敛为 **一个 `page` 字段 + 一个 `overlay` 字段**：
//   · page     —— 同一时刻只有一个主页面，非法组合**不可表示**（类型层就排除了）；
//   · overlay  —— 生态中心/设置是盖在页面**之上**的层，与主页面正交，故单独成字段；
//   · assistantTab / studioTab —— 只在对应 page 下有效（类型上不强制，由 reducer 保证归位）。
//
// 迁移期：App.jsx 的旧布尔消费者（Sidebar / TopBarTitle）不改签名，由
// `routeToLegacyView()` 适配。适配器是**过渡**，不是真源 —— 新代码一律读 route。
//
// 本项目不引入路由框架（设计文档 §4.3 明确「不要求为该设计引入新框架」），
// 故这里是一个纯 reducer + 纯适配器，可被 Node 侧门禁测试直接 import。
import {
  ASSISTANT_TABS, DEFAULT_ASSISTANT_TAB, isAssistantTab, type AssistantTab,
} from './assistantTabs.ts';
import { DEFAULT_STUDIO_TAB, isStudioTab, type StudioTab } from './studioTabs.ts';

/** 一级主页面。`thread` = 对话/运行（不点亮任何一级入口，属设计：§4.3 的 dashboard/thread） */
export type NavPage =
  | 'new' | 'desk' | 'assistant' | 'studio' | 'scheduled' | 'ledger' | 'dashboard' | 'thread';

/** 覆盖层：与主页面正交，关闭后回到原页面（§4.4） */
export type NavOverlay = 'none' | 'ecosystem' | 'settings';

export interface NavRoute {
  page: NavPage;
  assistantTab: AssistantTab;
  studioTab: StudioTab;
  /** 需要项目上下文时显式存在；不使用 projectPath 充当身份（§4.2.1） */
  projectId?: string | null;
  /** 仅对话/运行上下文使用 */
  threadId?: string | null;
  overlay: NavOverlay;
  /** 设置分区、生态详情等。⚠ 按 §4.3：**不得保存邀请 secret** */
  overlayPayload?: Record<string, unknown> | null;
}

export const NAV_PAGES: readonly NavPage[] = [
  'new', 'desk', 'assistant', 'studio', 'scheduled', 'ledger', 'dashboard', 'thread',
];

/** 会点亮一级导航的页面（`dashboard`/`thread` 不点亮，与 activeNavOf 返回 '' 同义） */
export const HIGHLIGHTABLE_PAGES: readonly NavPage[] = [
  'new', 'desk', 'assistant', 'studio', 'scheduled', 'ledger',
];

export const INITIAL_ROUTE: NavRoute = {
  page: 'new',
  assistantTab: DEFAULT_ASSISTANT_TAB,
  studioTab: DEFAULT_STUDIO_TAB,
  projectId: null,
  threadId: null,
  overlay: 'none',
  overlayPayload: null,
};

export function isNavPage(v: unknown): v is NavPage {
  return NAV_PAGES.some((p) => p === v);
}

export type NavAction =
  | { type: 'page'; page: NavPage; tab?: AssistantTab | StudioTab }
  | { type: 'assistantTab'; tab: AssistantTab }
  | { type: 'studioTab'; tab: StudioTab }
  | { type: 'overlay'; overlay: NavOverlay; payload?: Record<string, unknown> | null }
  | { type: 'closeOverlay' }
  | { type: 'projectId'; projectId: string | null }
  | { type: 'threadId'; threadId: string | null }
  | { type: 'reset' };

/**
 * 路由 reducer。**不变式**（每条都被 test/nav-route-single-page.test.mjs 守护）：
 *   1. 切主页面 ⇒ 清空 overlay 之外的**所有**子态归属（不会带着上一个页面的 tab 串台）；
 *   2. 开 overlay ⇒ 底层的 page 一律保留（§4.4「打开生态或设置保留底层页面」）；
 *   3. 关 overlay ⇒ page 不变（回到原页面），不重置 tab；
 *   4. reset ⇒ 回到 INITIAL_ROUTE（不保留 overlay —— 覆盖层不参与「重新开始」）。
 */
export function navReducer(state: NavRoute, action: NavAction): NavRoute {
  switch (action.type) {
    case 'page': {
      if (!isNavPage(action.page)) return state; // 外部输入不可信：非法 page 直接忽略
      if (action.page === state.page && action.tab === undefined) return state;
      const next: NavRoute = { ...state, page: action.page, overlay: 'none', overlayPayload: null };
      const tab = action.tab;
      // tab 只在对应 page 下有意义：切页面时若显式给了 tab 就用，否则**重置为默认**，
      // 避免「从助理的 aiTeam 切到工作室，工作室 tab 还停在别处」这类串台。
      if (action.page === 'assistant') {
        next.assistantTab = isAssistantTab(tab) ? tab : DEFAULT_ASSISTANT_TAB;
      } else if (action.page === 'studio') {
        next.studioTab = isStudioTab(tab) ? tab : DEFAULT_STUDIO_TAB;
      }
      return next;
    }
    case 'assistantTab': {
      if (!isAssistantTab(action.tab)) return state;
      if (state.page !== 'assistant') return { ...state, page: 'assistant', assistantTab: action.tab };
      return { ...state, assistantTab: action.tab };
    }
    case 'studioTab': {
      if (!isStudioTab(action.tab)) return state;
      if (state.page !== 'studio') return { ...state, page: 'studio', studioTab: action.tab };
      return { ...state, studioTab: action.tab };
    }
    case 'overlay':
      return { ...state, overlay: action.overlay, overlayPayload: action.payload ?? null };
    case 'closeOverlay':
      return { ...state, overlay: 'none', overlayPayload: null };
    case 'projectId':
      return { ...state, projectId: action.projectId };
    case 'threadId':
      return { ...state, threadId: action.threadId };
    case 'reset':
      return INITIAL_ROUTE;
    default:
      return state;
  }
}

/** 当前是否处在「无主页面」的对话态（用于 ChatArea 的 hidden 判定） */
export function isThreadRoute(route: NavRoute): boolean {
  return route.page === 'thread' || route.page === 'new';
}

/**
 * 迁移期适配器：把 route 投影成旧布尔 view，供 Sidebar / TopBarTitle 消费。
 *
 * ⚠ 这是**过渡层**。它的存在只为了不动旧组件签名；任何新代码应直接读 route。
 * `showTeams` 恒为 false：编制已迁 Studio，它只是历史兼容输入（见 lib/navState.ts）。
 */
export function routeToLegacyView(route: NavRoute, hasActiveThread = false): Record<string, unknown> {
  return {
    showAssistant: route.page === 'assistant',
    assistantTab: route.assistantTab,
    showScheduled: route.page === 'scheduled',
    showDashboard: route.page === 'dashboard',
    showEcosystem: route.overlay === 'ecosystem',
    showDesk: route.page === 'desk',
    showStudio: route.page === 'studio',
    showLedger: route.page === 'ledger',
    showTeams: false,
    hasActiveThread: !!hasActiveThread,
  };
}

/** 反向适配器：旧布尔 view → route（仅用于历史入口/深链的兼容解析） */
export function legacyViewToRoute(view: Record<string, unknown> = {}): NavRoute {
  const page: NavPage = view.showDesk ? 'desk'
    : view.showStudio ? 'studio'
      : view.showLedger ? 'ledger'
        : view.showScheduled ? 'scheduled'
          : view.showAssistant || view.showTeams ? 'assistant'
            : view.showDashboard ? 'dashboard'
              : view.hasActiveThread ? 'thread'
                : 'new';
  return {
    ...INITIAL_ROUTE,
    page,
    assistantTab: isAssistantTab(view.assistantTab) ? view.assistantTab : DEFAULT_ASSISTANT_TAB,
    overlay: view.showEcosystem ? 'ecosystem' : 'none',
  };
}

/** 助理 Tab 集合（转发自 assistantTabs，供门禁一次性断言两处 Tab 不再漂移） */
export { ASSISTANT_TABS };
