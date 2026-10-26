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
// 为什么此刻只有两个 Tab（编制不在这里）：
//   团队编制（TeamsPage）按 2026-10-24 的既定决策归在**助理**页（navState.ts:14-19 有完整
//   变更史，且 nav-state-dual-entry 套件的 B1/B5/B6 显式守护）。把它同时挂进工作室会造成
//   「一个能力两个并列入口」——正是该套件要防的事。编制是否迁入工作室属 **IA 决策变更**，
//   需先改那三处门禁语义再动，不在本批静默执行。
export type StudioTab = 'space' | 'artifacts';

export interface StudioTabDef {
  id: StudioTab;
  /** i18n key（渲染期经 t() 求值，切语言即时生效；顶层常量不持有求值结果） */
  labelKey: string;
}

export const STUDIO_TABS: readonly StudioTabDef[] = [
  { id: 'space', labelKey: 'studio.tabSpace' },
  { id: 'artifacts', labelKey: 'studio.tabArtifacts' },
];

/** 工作室默认 Tab：落在「项目空间」 */
export const DEFAULT_STUDIO_TAB: StudioTab = 'space';

/** Tab id 合法性判定（外部输入不可信时用，避免把非法 id 塞进视图状态） */
export function isStudioTab(v: unknown): v is StudioTab {
  return STUDIO_TABS.some((x) => x.id === v);
}
