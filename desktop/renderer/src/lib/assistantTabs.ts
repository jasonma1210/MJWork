// 助理工作台的子 Tab 定义（纯数据，无 React / 无 DOM 依赖）
//
// 为什么要独立文件：Tab 清单同时被三个地方消费——
//   ① AssistantPage.tsx（渲染 Tab 条）；② App.jsx（视图状态里的 assistantTab 初值与
//   合法性校验）；③ 门禁 nav-state-dual-entry.test.mjs（断言 Tab 集合不被悄悄改窄）。
//   放在组件文件里会让另外两处反向 import 组件（React 依赖 ⇒ Node 侧测试加载不了），
//   放这里则三处共用同一份清单（单一事实来源）。
//
// Tab 语义（2026-10-24 二次调整：定时任务回到一级入口，见下）：
//   directory —— **助手目录（默认，2026-10-27 新增）**：真实数字员工目录。先「选谁干」，
//                看清它能做什么、缺什么配置，再进入派单。默认页不是 publish 的原因：
//                目录是「发现」入口，一进来就是空白表单会让用户不知道有哪些助手可选
//                （设计文档 §5.2）。
//   publish   —— 发布任务：唯一发起面。一句话 + 选军团（不选=自动构建）
//   aiTeam    —— AI 建团（草案卡片逐条采纳/编辑/否决）
//   （原 teams 军团编制已于 2026-10-27 迁入工作室 Studio，见下方第四版说明）
//
// 为什么删掉 scheduled / complex 两个 Tab：
//   · scheduled —— 用户明确要求「一级菜单下面还是要有定时任务」⇒ 它升回**一级入口**，
//     不再藏在助理里（一个能力不该同时有两个并列入口，否则「在哪管理」会有两个答案）；
//   · complex   —— 它就是「发布任务」的类型之一（复杂任务），独立成 Tab 会与 publish
//     抢同一个职责，且用户在两个地方都能派活时，「默认走哪条」变得不可解释。
export type AssistantTab = 'directory' | 'dispatch' | 'aiTeam';

export interface AssistantTabDef {
  id: AssistantTab;
  /** i18n key（渲染期经 t() 求值，切语言即时生效；顶层常量不持有求值结果） */
  labelKey: string;
}

// 2026-10-27 第五版：**默认页改为助手目录**。
//   助理的主任务按设计文档 §0.2 收敛为「选助手与派活」——先有目录（发现），再有派单。
//   目录数据源是真实的 `ecosystem:employees`（51 条数字员工），不是插件市场复制品。
export const ASSISTANT_TABS: readonly AssistantTabDef[] = [
  { id: 'dispatch', labelKey: 'assistant.tabDispatch' },
  { id: 'directory', labelKey: 'assistant.tabDirectory' },
  { id: 'aiTeam', labelKey: 'assistant.tabAiTeam' },
];

/** 助理页的默认 Tab：**助手目录**（进入助理先看到有哪些助手可派，而不是空白表单） */
export const DEFAULT_ASSISTANT_TAB: AssistantTab = 'dispatch';

/** Tab id 合法性判定（外部输入不可信时用，避免把非法 id 塞进视图状态） */
export function isAssistantTab(v: unknown): v is AssistantTab {
  return ASSISTANT_TABS.some((x) => x.id === v);
}
