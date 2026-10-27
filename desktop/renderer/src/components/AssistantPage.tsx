// 助手工作台（设计文档 §4.1 / §5）
//
// 2026-10-27 收敛：助理的主任务 = **选助手与派活**（§0.2 决策 2）。三个子 Tab：
//   Tab1 助手目录（默认）—— AssistantDirectory：真实数字员工目录 → 详情 → 派单
//   Tab2 发布任务 —— PublishTaskPage：唯一发起面（复杂任务 / 定时任务二选一）
//   Tab3 AI 建团 —— AiTeamBuilder（草案卡片逐条采纳/编辑/否决）
//
// 定时任务已升回**一级入口**（用户要求），不再作为本页 Tab；
// 军团编制已迁入**工作室**（2026-10-27），本页只保留目录/派单/建团。
//
// 按 tab **挂载**（不是同时挂载）：三个视图各自持有自己的滚动位置与表单状态，
// 同时挂载会让三份列表同时发请求、也把三个页面的状态混在一个 DOM 里。
import { useEffect, useState } from 'react';
import AiTeamBuilder from './AiTeamBuilder';
import AssistantDirectory, { type Employee } from './AssistantDirectory';
import PublishTaskPage from './PublishTaskPage';
import InlineAlert from './InlineAlert';
import Button from './ui/Button';
import TabBar from './ui/TabBar';
import { IconBot, IconUsers, IconZap, IconList } from './icons';
import { useI18n } from '../i18n';
import { ASSISTANT_TABS, type AssistantTab } from '../lib/assistantTabs';

// 目录用「清单」图标：它是浏览/发现面，与「发布任务」（闪电=发起）语义不同
const TAB_ICON: Record<AssistantTab, typeof IconUsers> = {
  directory: IconList,
  publish: IconZap,
  aiTeam: IconBot,
};

interface TeamSummary {
  id: string;
  name: string;
  description?: string;
  leadMissing?: boolean;
  archivedAt?: string | null;
}

export default function AssistantPage({
  tab, onTab, threadId, projectPath, onAutoRun, onDispatchEmployee,
}: {
  tab: AssistantTab;
  onTab: (t: AssistantTab) => void;
  /** 当前会话 id（发布任务派活挂到该会话；无会话时提示先建会话） */
  threadId?: string | null;
  /** 当前项目目录（派活的工作目录） */
  projectPath?: string;
  /** 不选军团时的「自动构建」出口：把目标交回主链路，由判定器决定是否升级为团队 */
  onAutoRun: (goal: string) => void;
  /**
   * 助手目录的派单出口：把（助手 + 主进程返回的角色预设 + 目标）交回既有 recruit-expert 链路。
   * 不在这里另写一条执行实现 —— 与生态中心「用此角色开会话」同源（§5.5）。
   */
  onDispatchEmployee?: (payload: { employee: Employee; runtime: unknown; goal: string }) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Tab 条：走 ui/TabBar 原语（role=tablist/tab + 方向键 + aria-selected 都收敛在那一处，
          避免每个新页面复制一段裸 <button> 抬高 ui-conventions 棘轮） */}
      <TabBar
        ariaLabel={t('assistant.title')}
        active={tab}
        onChange={(id) => onTab(id as AssistantTab)}
        className="flex items-center gap-1 px-4 pt-3 border-b border-border shrink-0"
        tabs={ASSISTANT_TABS.map((x) => {
          const Icon = TAB_ICON[x.id];
          return { id: x.id, label: t(x.labelKey), icon: <Icon size={13} /> };
        })}
      />
      {/* 只挂载活动 Tab（§4.4）：三个视图各自持有滚动位置与表单状态 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'directory' && <AssistantDirectory onDispatch={onDispatchEmployee} />}
        {tab === 'publish' && (
          <PublishTaskPage threadId={threadId} projectPath={projectPath} onAutoRun={onAutoRun} />
        )}
        {/* 军团编制已于 2026-10-27 迁入工作室（Studio），此处不再挂 TeamsPage —— 避免双入口 */}
        {tab === 'aiTeam' && <AiTeamBuilder />}
      </div>
    </div>
  );
}
