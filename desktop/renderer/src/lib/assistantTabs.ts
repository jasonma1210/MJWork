// 助理工作台的子 Tab 定义（纯数据，无 React / 无 DOM 依赖）
//
// 为什么要独立文件：Tab 清单同时被三个地方消费——
//   ① AssistantPage.tsx（渲染 Tab 条）；② App.jsx（视图状态里的 assistantTab 初值与
//   合法性校验）；③ 门禁 nav-state-dual-entry.test.mjs（断言 Tab 集合不被悄悄改窄）。
//   放在组件文件里会让另外两处反向 import 组件（React 依赖 ⇒ Node 侧测试加载不了），
//   放这里则三处共用同一份清单（单一事实来源）。
//
// Tab 语义（2026-10-27 第六版：**派活面板 + 两个资源面**，见
// docs/MJ Nexus-助手界面派活收敛方案-2026-10-27.md）：
//   dispatch  —— **派活（默认）**：主体（助手/团队/系统）× 运行方式（立即/定时）× 目标 ×
//                本会话看板。唯一发起面，全文件只有一个 submit() 出口。
//   directory —— 助手目录：**资源面**，只负责「发现 + 选用」，选中后回填到 dispatch。
//   aiTeam    —— AI 建团：**资源面**，只产出编制，落库后回填团队到 dispatch。
//   （原 publish 发布任务已于 2026-10-27 删除：它只能选团队或交给系统，从头到尾没有
//    助手主体 —— 名字承诺「发起一切任务」，能力只覆盖三分之一，留着就是第四条派活路径。
//     原 teams 军团编制已于同日迁入工作室 Studio。）
//
// 为什么删掉 scheduled / complex 两个 Tab：
//   · scheduled —— 用户明确要求「一级菜单下面还是要有定时任务」⇒ 它升回**一级入口**，
//     不再藏在助理里（一个能力不该同时有两个并列入口，否则「在哪管理」会有两个答案）；
//   · complex   —— 它就是「派活」的一种目标描述，独立成 Tab 会与 dispatch 抢同一个职责。
export type AssistantTab = 'directory' | 'dispatch' | 'aiTeam';

export interface AssistantTabDef {
  id: AssistantTab;
  /** i18n key（渲染期经 t() 求值，切语言即时生效；顶层常量不持有求值结果） */
  labelKey: string;
}

// 2026-10-27 第六版：**默认页改为派活面板**（原第五版曾把默认页设成助手目录）。
//   改回派活的原因：用户是带着「我要让谁干什么」这一个意图进来的，一进来先看目录
//   等于强制多一次跳转；目录与建团降级为资源面，选完自动回填并切回派活。
export const ASSISTANT_TABS: readonly AssistantTabDef[] = [
  { id: 'dispatch', labelKey: 'assistant.tabDispatch' },
  { id: 'directory', labelKey: 'assistant.tabDirectory' },
  { id: 'aiTeam', labelKey: 'assistant.tabAiTeam' },
];

/** 助理页的默认 Tab：**派活面板**（唯一发起面；资源面选完会回填到这里） */
export const DEFAULT_ASSISTANT_TAB: AssistantTab = 'dispatch';

/** Tab id 合法性判定（外部输入不可信时用，避免把非法 id 塞进视图状态） */
export function isAssistantTab(v: unknown): v is AssistantTab {
  return ASSISTANT_TABS.some((x) => x.id === v);
}
