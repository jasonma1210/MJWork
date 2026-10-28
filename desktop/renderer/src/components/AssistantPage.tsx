// 助手工作台（设计文档 §4.1 / §5；2026-10-27 第二次收敛）
//
// ── 这次为什么又改（用户实测）──
// 上一版把助理切成三个并列 Tab：目录（派给单个助手）/ 发布任务（派给军团或"自动"）/ AI 建团。
// 用户的原话是：「我本该用来发布任务的『发布任务』进入后，发布任务没有任何和助手有关的事情，
// 而助手目录和 AI 建团又各自为战，都有发布」。
// 病因是**按功能切 Tab**：主体（谁来干）被拆在三个 Tab 里，落点规则还互相冲突
// （目录派活强制开新会话、发布任务挂当前会话），于是"派活"这一个动作有了三种互不相认的形态。
//
// ── 现在 ──
//   Tab1 派活（dispatch，默认）—— AssistantDispatch：**唯一提交出口**。
//        主体三态（指定助手 / 指定团队 / 交给系统）× 运行方式（立即 / 定时）× 目标，外加本会话看板。
//   Tab2 助手目录（directory）—— 只浏览/发现。**没有提交按钮**，选中后「以此派活」把主体回填到 Tab1。
//   Tab3 AI 建团（aiTeam）—— 只产出编制。确认落库后「用这个团队派活」把团队回填到 Tab1。
//
// 三个 Tab 因此变成「一个动作 + 两个资源面」：派活只有一个出口，另外两个 Tab 只负责"挑什么来派"。
// 三条执行通道全部复用既有实现（recruit-expert / teams:dispatch / 判定器 onAutoRun），
// **没有第四条派活路径**；渲染层也不覆盖安全策略（助手的安全档由主进程取更严格者）。
//
// 按 tab **挂载**（不是同时挂载）：三个视图各自持有滚动位置与表单状态，
// 同时挂载会让三份列表同时发请求、也把三个页面的状态混在一个 DOM 里。
import { useState } from 'react';
import AiTeamBuilder from './AiTeamBuilder';
import AssistantDirectory, { type Employee } from './AssistantDirectory';
import AssistantDispatch from './AssistantDispatch';
import StudioBoard from './StudioBoard';
import TabBar from './ui/TabBar';
import { IconBot, IconChart, IconUsers, IconZap, IconList } from './icons';
import { useI18n } from '../i18n';
import { ASSISTANT_TABS, type AssistantTab } from '../lib/assistantTabs';

// 派活用「闪电」图标：它是发起面；目录用清单（浏览/发现）；看板用图表（跟进）
const TAB_ICON: Record<AssistantTab, typeof IconUsers> = {
  dispatch: IconZap,
  directory: IconList,
  aiTeam: IconBot,
  board: IconChart,
};

export interface DispatchTeamResult {
  ok?: boolean;
  tasks?: number;
  error?: string;
  code?: string;
}

export default function AssistantPage({
  tab, onTab, threadId, projectPath, onAutoRun, onDispatchEmployee, onDispatchTeam, onOpenFile,
}: {
  tab: AssistantTab;
  onTab: (t: AssistantTab) => void;
  /** 当前会话 id（派活落点；无会话时由调用方决定是否新建） */
  threadId?: string | null;
  /** 当前项目目录（派活的工作目录；看板 Tab 的数据范围键） */
  projectPath?: string;
  /** 主体=系统：目标交回主链路，由判定器决定是否升级为团队 */
  onAutoRun: (goal: string) => void;
  /** 主体=助手：复用 recruit-expert 链路（落当前会话，见 App 的 recruit 分支） */
  onDispatchEmployee?: (payload: { employee: Employee; goal: string }) => void;
  /** 主体=团队：确定性派活（复用 teams:dispatch） */
  onDispatchTeam?: (p: { teamId: string; goal: string }) => Promise<DispatchTeamResult | undefined>;
  /** 看板点开任务产物时回传 App 右栏预览（与工作室同源 openFileInPane） */
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  // 资源面 → 派活面的回填。只在页面内存里，不落盘：它描述的是"这一次派活选了谁"。
  const [pickedEmployeeId, setPickedEmployeeId] = useState('');
  const [pickedTeamId, setPickedTeamId] = useState('');

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
        {tab === 'dispatch' && (
          <AssistantDispatch
            threadId={threadId}
            projectPath={projectPath}
            onAutoRun={onAutoRun}
            onDispatchAssistant={onDispatchEmployee}
            onDispatchTeam={onDispatchTeam}
            initialEmployeeId={pickedEmployeeId}
            initialTeamId={pickedTeamId}
            onNeedAssistant={() => onTab('directory')}
            onNeedTeam={() => onTab('aiTeam')}
          />
        )}
        {tab === 'directory' && (
          <AssistantDirectory
            onPickForDispatch={(emp) => {
              setPickedEmployeeId(emp.id);
              onTab('dispatch');
            }}
          />
        )}
        {tab === 'aiTeam' && (
          <AiTeamBuilder
            onUseTeam={(teamId) => {
              setPickedTeamId(teamId);
              onTab('dispatch');
            }}
          />
        )}
        {/* 2026-10-28：项目任务看板自工作室迁入（StudioBoard 复用未改，projectPath 维度）。
            无项目时 StudioBoard 自带空态（门禁 C5 锁定），这里不重复造空态。 */}
        {tab === 'board' && <StudioBoard projectPath={projectPath || null} onOpenFile={onOpenFile} />}
      </div>
    </div>
  );
}
