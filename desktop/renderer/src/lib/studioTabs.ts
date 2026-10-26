// 工作室（Studio）的子 Tab 定义（纯数据，无 React / 无 DOM 依赖）
//
// 与 lib/assistantTabs.ts 同款「单一事实来源」：Tab 清单同时被组件渲染、App 视图状态、
// 门禁测试消费，放这里避免反向 import 组件（React 依赖 ⇒ Node 侧测试加载不了）。
//
// Tab 语义（对齐原型 deliverables/mjwork-one-person-company/js/views/studio.js）：
//   space     —— 项目空间（TeamSpace，原型 tabIndex.space）
//   artifacts —— 工件（ArtifactPanel，原型 tabIndex.artifacts；其内部已复用 TeamBoardBody
//                渲染待办看板，见 ArtifactPanel.tsx:323，故**不单列看板 Tab**）
//
// 编制的归属变更（2026-10-27，用户确认后执行）：
//   此前团队编制（TeamsPage）按 2026-10-24 的既定决策归在**助理**页。但它与工作室的
//   「编制」是同一件事，两处并列会让「在哪管理编制」有两个答案。现已**迁入工作室**，
//   并**同步从助理页摘除**（见 lib/assistantTabs.ts 第四版说明）——先改门禁判据再动代码，
//   不静默执行：nav-state-dual-entry 的 B1/B6 已按新语义改写。
export type StudioTab = 'space' | 'roster' | 'artifacts';

export interface StudioTabDef {
  id: StudioTab;
  /** i18n key（渲染期经 t() 求值，切语言即时生效；顶层常量不持有求值结果） */
  labelKey: string;
}

export const STUDIO_TABS: readonly StudioTabDef[] = [
  { id: 'space', labelKey: 'studio.tabSpace' },
  { id: 'roster', labelKey: 'studio.tabRoster' },
  { id: 'artifacts', labelKey: 'studio.tabArtifacts' },
];

/** 工作室默认 Tab：落在「项目空间」 */
export const DEFAULT_STUDIO_TAB: StudioTab = 'space';

/** Tab id 合法性判定（外部输入不可信时用，避免把非法 id 塞进视图状态） */
export function isStudioTab(v: unknown): v is StudioTab {
  return STUDIO_TABS.some((x) => x.id === v);
}
