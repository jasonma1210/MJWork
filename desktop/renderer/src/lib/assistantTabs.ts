// 助理工作台的子 Tab 定义（纯数据，无 React / 无 DOM 依赖）
//
// 为什么要独立文件：Tab 清单同时被三个地方消费——
//   ① AssistantPage.tsx（渲染 Tab 条）；② App.jsx（视图状态里的 assistantTab 初值与
//   合法性校验）；③ 门禁 nav-state-dual-entry.test.mjs（断言 Tab 集合不被悄悄改窄）。
//   放在组件文件里会让另外两处反向 import 组件（React 依赖 ⇒ Node 侧测试加载不了），
//   放这里则三处共用同一份清单（单一事实来源）。
//
// Tab 语义（2026-10-24 二次调整：定时任务回到一级入口，见下）：
//   publish  —— **发布任务（默认）**：唯一发起面。一句话 + 选军团（不选=自动构建）
//               + 类型（复杂任务 / 定时任务）；复杂任务下方有看板，定时任务就地展开
//               重复/有效期/时间并给执行计划预览
//   aiTeam   —— AI 建团（草案卡片逐条采纳/编辑/否决）
//   （原 teams 军团编制已于 2026-10-27 迁入工作室 Studio，见下方第四版说明）
//
// 为什么删掉 scheduled / complex 两个 Tab：
//   · scheduled —— 用户明确要求「一级菜单下面还是要有定时任务」⇒ 它升回**一级入口**，
//     不再藏在助理里（一个能力不该同时有两个并列入口，否则「在哪管理」会有两个答案）；
//   · complex   —— 它就是「发布任务」的类型之一（复杂任务），独立成 Tab 会与 publish
//     抢同一个职责，且用户在两个地方都能派活时，「默认走哪条」变得不可解释。
export type AssistantTab = 'publish' | 'aiTeam';

export interface AssistantTabDef {
  id: AssistantTab;
  /** i18n key（渲染期经 t() 求值，切语言即时生效；顶层常量不持有求值结果） */
  labelKey: string;
}

// 2026-10-27 第四版：**军团编制迁出助理、归入工作室**。
//   一个能力不该有两个并列入口（否则「在哪管理编制」有两个答案）——工作室已收编编制
//   （见 lib/studioTabs.ts）后，助理页必须把它摘掉，否则就是双入口。
export const ASSISTANT_TABS: readonly AssistantTabDef[] = [
  { id: 'publish', labelKey: 'assistant.tabPublish' },
  { id: 'aiTeam', labelKey: 'assistant.tabAiTeam' },
];

/** 助理页的默认 Tab（进入助理先落在「发布任务」——用户诉求：助理里的发布任务只有一个界面） */
export const DEFAULT_ASSISTANT_TAB: AssistantTab = 'publish';

/** Tab id 合法性判定（外部输入不可信时用，避免把非法 id 塞进视图状态） */
export function isAssistantTab(v: unknown): v is AssistantTab {
  return ASSISTANT_TABS.some((x) => x.id === v);
}
