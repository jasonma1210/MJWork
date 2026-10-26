// 工作台（desk）的工作场景预设（纯数据，无 React / 无 DOM 依赖）
//
// 为什么独立文件：场景清单同时被两处消费——① desk/DeskIntake.tsx 渲染卡片与「套用模板」，
// ② 后续按 id 引用做卡片编排。放组件里会让编排层反向 import 组件（带上 React 依赖）。
//
// 口径纪律两条：
//   · 只存 **i18n key**，不存求值结果 —— 顶层常量会把译文冻结在模块加载那一刻，
//     切语言后界面仍显示旧语言（T3-2 抽取时的既定纪律）。
//   · budget 是**建议值**而非当前生效配置（desk 不写任何配置，见 DeskPage 头注）：
//     不挂军团的 office 场景没有批次与并发，故不提供 budget —— 给了就是造假数据。
import { IconBranch, IconEdit, IconFile, IconSearch } from '../components/icons';

export type DeskScenarioId = 'office' | 'dev' | 'write' | 'research';

/** 场景建议预算（token 口径；取值落在 main/teamStore.js 的配额值域内） */
export interface DeskBudget {
  max_rounds: number;
  max_tokens: number;
  max_wall_ms: number;
}

export interface DeskScenarioDef {
  id: DeskScenarioId;
  nameKey: string;
  descKey: string;
  /** 「套用模板」把这条模板预填进输入框（不派单、不改运行态） */
  goalKey: string;
  /** 3 条常用指令；点击即填入输入框，不派单 */
  cmdKeys: readonly string[];
  Icon: typeof IconFile;
  /** 仅「挂军团」时展示 */
  budget?: DeskBudget;
}

export const DESK_SCENARIOS: readonly DeskScenarioDef[] = [
  { id: 'office', nameKey: 'desk.scenario.office.name', descKey: 'desk.scenario.office.desc', goalKey: 'desk.goal.office', cmdKeys: ['desk.cmd.office1', 'desk.cmd.office2', 'desk.cmd.office3'], Icon: IconFile },
  { id: 'dev', nameKey: 'desk.scenario.dev.name', descKey: 'desk.scenario.dev.desc', goalKey: 'desk.goal.dev', cmdKeys: ['desk.cmd.dev1', 'desk.cmd.dev2', 'desk.cmd.dev3'], Icon: IconBranch, budget: { max_rounds: 12, max_tokens: 512000, max_wall_ms: 45 * 60 * 1000 } },
  { id: 'write', nameKey: 'desk.scenario.write.name', descKey: 'desk.scenario.write.desc', goalKey: 'desk.goal.write', cmdKeys: ['desk.cmd.write1', 'desk.cmd.write2', 'desk.cmd.write3'], Icon: IconEdit, budget: { max_rounds: 6, max_tokens: 256000, max_wall_ms: 20 * 60 * 1000 } },
  { id: 'research', nameKey: 'desk.scenario.research.name', descKey: 'desk.scenario.research.desc', goalKey: 'desk.goal.research', cmdKeys: ['desk.cmd.research1', 'desk.cmd.research2', 'desk.cmd.research3'], Icon: IconSearch, budget: { max_rounds: 10, max_tokens: 512000, max_wall_ms: 30 * 60 * 1000 } },
];
