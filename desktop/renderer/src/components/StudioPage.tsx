// 工作室（Studio）——原型 studio.js 的一级页面化
//
// 装配而非重写：三个 Tab 全部复用既有组件，本文件只负责 Tab 条与分派。
//   space     → TeamSpace（项目空间，既有弹层内容，此处升级为 Tab 常驻）
//   artifacts → ArtifactPanel（工件；其内部已用 TeamBoardBody 渲染待办看板，
//               见 ArtifactPanel.tsx:323 —— 故原型第四 Tab「看板」不单列，避免空壳）
//
// 为什么不做「编制」Tab：TeamsPage 按 2026-10-24 决策归在助理页（见 lib/studioTabs.ts
// 文件头），同时挂两处会形成双入口，属 IA 决策变更，需先改门禁语义。
//
// Tab 条复用 ui/TabBar 原语（role=tablist/tab + 方向键 + aria-selected 收敛在那一处），
// 本文件不含裸 <button>（ui-conventions 棘轮要求）。
import { useState } from 'react';
import TabBar from './ui/TabBar';
import TeamSpace from './TeamSpace';
import ArtifactPanel from './ArtifactPanel';
import { STUDIO_TABS, DEFAULT_STUDIO_TAB, type StudioTab } from '../lib/studioTabs';
import { useI18n } from '../i18n';

export interface StudioPageProps {
  /** 受控 Tab（可选）：不传则由本组件自管，避免 App.jsx 再背一份视图状态（800 行门禁） */
  tab?: StudioTab;
  onTab?: (t: StudioTab) => void;
  threadId?: string | null;
  onOpenFile?: (p: string) => void;
  /** 工件面板的「自动打开最新工件」回调（透传，不在此处发明语义） */
  onAutoOpen?: () => void;
}

export default function StudioPage({ tab, onTab, threadId = null, onOpenFile, onAutoOpen }: StudioPageProps) {
  const { t } = useI18n();
  const [inner, setInner] = useState<StudioTab>(DEFAULT_STUDIO_TAB);
  const active = tab ?? inner;
  const go = (id: StudioTab) => { if (onTab) onTab(id); else setInner(id); };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabBar
        tabs={STUDIO_TABS.map((x) => ({ id: x.id, label: t(x.labelKey) }))}
        active={active}
        onChange={(id) => go(id as StudioTab)}
        ariaLabel={t('studio.title')}
        className="flex gap-1 border-b border-border px-2"
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {active === 'space' ? (
          <TeamSpace spaceId="default" />
        ) : (
          <ArtifactPanel threadId={threadId} onOpenFile={onOpenFile} onAutoOpen={onAutoOpen} />
        )}
      </div>
    </div>
  );
}
