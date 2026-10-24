// 候选编制（candidate roster）—— 数据模型 + 进程内单一事实源
//
// 语义（设计文档 §7.2「新建任务里的军团选择器」/ §9 P0-6）：
//   选中的军团从「模式开关」改成「**编制偏好**」——
//     · 徽标表示「本次任务**可被该编制承接**」，普通对话照常可发起；
//     · 仅当判定器命中「需要编排」时，该编制才被注入为 roster（注入点在主进程，
//       见 §9 P1-4 entryRouter；本模块只负责把编制状态以**可被消费**的形态暴露出去）；
//     · 「暂不派活 / 取消编制」是编制偏好的中间态（清空即可，普通对话不受影响）。
//
// 为什么单独一个模块（而不是塞进 ChatArea）：
//   ① 编制状态被两个组件消费——对话区（ChatArea：状态条 + 显式派活）与
//      「+ 菜单 → 军团」面板（TeamDispatchPanel：高亮当前编制）。塞进组件里就得
//      用 props 一路透传，且两处各存一份 → 违反「单一事实来源」；
//   ② 它是纯数据 + 纯函数（无 React），Node 侧门禁可以直接 import 做行为断言。
//
// 一次性编制（临时组队）：kind='temp'，成员来自数字员工目录，**不落 teams 表**——
// 运行期由主进程按 dag.roster 快照机制消费（§7.7 资产共享模型）。

import { useSyncExternalStore } from 'react';

export type RosterKind = 'team' | 'temp';

export interface CandidateRosterMember {
  id: string;
  name: string;
  roleKind?: string;
  source?: string;
  templateRef?: string | null;
}

export interface CandidateRoster {
  kind: RosterKind;
  /** 已建军团的 id（kind='team' 时有值；kind='temp' 为 null） */
  teamId: string | null;
  name: string;
  description?: string;
  /** 参与成员数（team 取列表快照；temp 取选中项数） */
  memberCount: number;
  /** 缺统筹（仅 kind='team' 有意义：主进程 LEAD_MISSING 闸的本地预检） */
  leadMissing?: boolean;
  /** 团队预算摘要（徽标回显用；派活的预算缺省仍由主进程从 team.budget 取） */
  budget?: { max_tokens?: number; max_rounds?: number; max_wall_ms?: number } | null;
  /** 成员清单（kind='temp' 必填；kind='team' 为空——团队成员由主进程名册提供） */
  members: CandidateRosterMember[];
}

type Listener = (roster: CandidateRoster | null) => void;

let current: CandidateRoster | null = null;
const listeners = new Set<Listener>();

export function getCandidateRoster(): CandidateRoster | null {
  return current;
}

export function setCandidateRoster(next: CandidateRoster | null): void {
  current = next;
  for (const fn of listeners) {
    try { fn(next); } catch { /* 单个订阅者出错不影响其它订阅者 */ }
  }
}

export function subscribeCandidateRoster(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React 订阅钩子（单一事实源的读侧；写侧一律走 setCandidateRoster） */
export function useCandidateRoster(): CandidateRoster | null {
  return useSyncExternalStore(subscribeCandidateRoster, getCandidateRoster, getCandidateRoster);
}

/** 军团列表项 → 候选编制（列表项来自 teams:list 的快照，字段名以主进程为准） */
export function rosterFromTeam(team: {
  id: string;
  name?: string;
  description?: string;
  memberCount?: number;
  members?: Array<{ id: string; enabled?: boolean }>;
  leadMissing?: boolean;
  budget?: { max_tokens?: number; max_rounds?: number; max_wall_ms?: number } | null;
}): CandidateRoster {
  const members = Array.isArray(team.members) ? team.members : [];
  const count = typeof team.memberCount === 'number'
    ? team.memberCount
    : members.filter((m) => m.enabled !== false).length;
  return {
    kind: 'team',
    teamId: String(team.id),
    name: String(team.name || team.id),
    description: team.description || '',
    memberCount: count,
    leadMissing: !!team.leadMissing,
    budget: team.budget || null,
    members: [],
  };
}

/** 数字员工目录项 → 临时编制成员（目录优先：source='template' + templateRef 指回目录 id） */
export function tempMemberFromEmployee(emp: { id: string; name?: string; title_cn?: string }): CandidateRosterMember {
  return {
    id: String(emp.id),
    name: String(emp.name || emp.title_cn || emp.id),
    roleKind: 'member',
    source: 'template',
    templateRef: String(emp.id),
  };
}

/** 选中的一组数字员工 → 临时编制（一次性 roster，不落 teams 表） */
export function tempRosterFromEmployees(emps: Array<{ id: string; name?: string; title_cn?: string }>): CandidateRoster {
  const members = emps.map(tempMemberFromEmployee);
  return {
    kind: 'temp',
    teamId: null,
    // 分隔符与语言无关（lib 层不引 i18n；这是回显用的编制名，不是 UI 文案模板）
    name: members.map((m) => m.name).join(' / '),
    description: '',
    memberCount: members.length,
    members,
  };
}

