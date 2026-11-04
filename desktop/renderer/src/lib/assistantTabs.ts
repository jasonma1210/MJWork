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
//   board     —— **项目任务看板**（2026-10-28 自工作室迁入，用户裁决）：派完活在哪跟进，
//                看板就跟人走到哪。StudioBoard 复用未改（projectPath 维度，无项目时空态）。
//   roster    —— **AI 数字员工编制**（2026-11-03 自工作室迁入，用户裁决「工作室没必要」）：
//                编制本质是「谁能接活」，与派活同处一页才不会出现「在哪管理编制」两个答案。
//   space     —— **已下线**（2026-11-04 用户裁决）：原「项目空间」Tab（TeamSpace）依赖的
//                collab / knowledge 能力默认关闭，Y.Doc 只在内存（刷新即丢），看板与 board
//                两套互不相通，审批也不 gate 真实工具执行 ⇒ 入口是「有实现、无闭环」的假承诺。
//                组件与后端代码保留为冻结资产，待协同能力真正启用时再接回；此处**不列入**
//                Tab 清单，且 nav-state-dual-entry C1 会反向钉住「不得悄悄挂回」。
//   （原 publish 发布任务已于 2026-10-27 删除：它只能选团队或交给系统，从头到尾没有
//    助手主体 —— 名字承诺「发起一切任务」，能力只覆盖三分之一，留着就是第四条派活路径。）
//
// 为什么 artifacts（工件）**不**迁入：会话右栏（App artifactPanel）挂的就是同一个
// ArtifactPanel（threadId 维度，含生成后自动展开）——再加一个助理 Tab 是第三个重复入口，
// 违反 D-03「消除重复而非造空壳」。工作室侧的工件 Tab 同日下线（纯重复，无信息损失）。
//
// 2026-11-03（用户反馈 2）：**撤销「工作室」一级入口**。它的两个 Tab（编制 / 空间）曾全部
// 并入本清单；2026-11-04 用户裁决「空间存在意义不大」⇒ 空间 Tab 下线，编制保留在本清单。
// 再留一个只装重复内容的一级按钮，等于让「编制在哪」重新变成两个答案。
export type AssistantTab = 'directory' | 'dispatch' | 'aiTeam' | 'roster' | 'board';

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
  // 编制紧跟「AI 建团」：建团产出编制，编制是它的落地与维护面，两者相邻才连贯。
  { id: 'roster', labelKey: 'assistant.tabRoster' },
  { id: 'board', labelKey: 'assistant.tabBoard' },
];

/** 助理页的默认 Tab：**派活面板**（唯一发起面；资源面选完会回填到这里） */
export const DEFAULT_ASSISTANT_TAB: AssistantTab = 'dispatch';

/** Tab id 合法性判定（外部输入不可信时用，避免把非法 id 塞进视图状态） */
export function isAssistantTab(v: unknown): v is AssistantTab {
  return ASSISTANT_TABS.some((x) => x.id === v);
}
