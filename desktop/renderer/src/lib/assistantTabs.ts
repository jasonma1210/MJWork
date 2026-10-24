// 助理工作台的子 Tab 定义（纯数据，无 React / 无 DOM 依赖）
//
// 为什么要独立文件：Tab 清单同时被三个地方消费——
//   ① AssistantPage.tsx（渲染 Tab 条）；② App.jsx（视图状态里的 assistantTab 初值与
//   合法性校验）；③ 门禁 nav-state-dual-entry.test.mjs（断言 Tab 集合不被悄悄改窄）。
//   放在组件文件里会让另外两处反向 import 组件（React 依赖 ⇒ Node 侧测试加载不了），
//   放这里则三处共用同一份清单（单一事实来源）。
//
// Tab 语义（设计文档 §7.7 信息架构图）：
//   teams    —— Tab1 军团编制（原样搬入 TeamsPage，不改业务逻辑）
//   aiTeam   —— Tab2 AI 建团（草案卡片逐条采纳/编辑/否决）
//   scheduled—— Tab3 定时任务（原样搬入 ScheduledTasks）
//   complex  —— Tab4 复杂问题（显式选「按团队执行」的发起入口）

export type AssistantTab = 'teams' | 'aiTeam' | 'scheduled' | 'complex';

export interface AssistantTabDef {
  id: AssistantTab;
  /** i18n key（渲染期经 t() 求值，切语言即时生效；顶层常量不持有求值结果） */
  labelKey: string;
}

export const ASSISTANT_TABS: readonly AssistantTabDef[] = [
  { id: 'teams', labelKey: 'assistant.tabTeams' },
  { id: 'aiTeam', labelKey: 'assistant.tabAiTeam' },
  { id: 'scheduled', labelKey: 'assistant.tabScheduled' },
  { id: 'complex', labelKey: 'assistant.tabComplex' },
];

/** 助理页的默认 Tab（进入助理页先落在「军团编制」——设计文档 §7.4 路径①） */
export const DEFAULT_ASSISTANT_TAB: AssistantTab = 'teams';

/** Tab id 合法性判定（外部输入不可信时用，避免把非法 id 塞进视图状态） */
export function isAssistantTab(v: unknown): v is AssistantTab {
  return ASSISTANT_TABS.some((x) => x.id === v);
}
