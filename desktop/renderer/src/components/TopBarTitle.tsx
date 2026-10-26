// 顶栏标题 + 面包屑（对齐 MJWork 原型 tb-left：衬线 h1 + 次级说明）
//
// 仅展示「当前视图名 + 当前项目」（均为真实数据，杜绝假数据）。日期不做——
// 原型是静态稿，做的时候必须 new Date() + i18n 日期格式，且不是用户痛点，故省略。
// 标题走 h1，自动继承 theme.css 的全局衬线规则（原型最强观感来源之一）。
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';

export interface TopBarTitleProps {
  /** 当前视图标志（与 Sidebar 同形）；决定标题文案 */
  view: {
    showDesk?: boolean;
    showDashboard?: boolean;
    showEcosystem?: boolean;
    showScheduled?: boolean;
    showAssistant?: boolean;
    /** 工作室（2026-10-26 新增一级入口） */
    showStudio?: boolean;
  };
  /** 面包屑：当前项目名（真实数据）；为空则不显示次级行 */
  projectName?: string;
  /** 纯对话态（无视图标志）时的标题：传入活动会话标题；缺省回落「对话」 */
  conversationTitle?: string;
}

export default function TopBarTitle({ view, projectName, conversationTitle }: TopBarTitleProps) {
  const { t } = useI18n();
  let title: string;
  if (view.showDesk) title = t('sidebar.desk');
  else if (view.showDashboard) title = t('app.data');
  else if (view.showEcosystem) title = t('sidebar.ecosystem');
  else if (view.showScheduled) title = t('sidebar.scheduled');
  else if (view.showAssistant) title = t('sidebar.assistant');
  else if (view.showStudio) title = t('sidebar.studio');
  else title = conversationTitle || t('app.conversation');

  return (
    <div className="flex flex-col justify-center min-w-0 mr-3">
      <h1 className="text-[15px] leading-tight font-semibold truncate">{title}</h1>
      {projectName && <p className="text-caption text-text2 truncate">{projectName}</p>}
    </div>
  );
}
