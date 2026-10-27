// 工作室（Studio）——原型 studio.js 的一级页面化
//
// 装配而非重写：四个 Tab 全部复用既有组件，本文件只负责 Tab 条与分派。
//   space     → TeamSpace（项目空间）
//   roster    → TeamsPage（AI 数字员工编制；2026-10-27 从助理迁入，助理页已摘除）
//   board     → StudioBoard（当前项目任务看板，2026-10-27 新增，D-03）
//   artifacts → ArtifactPanel（工件）
//
// ── 项目上下文（IA-02，2026-10-27 修复）──
// 此前本文件写死 `spaceId="default"`：无论用户选了哪个项目，工作室读的都是同一个空间，
// 于是「切了项目但资产没变」「A 项目看到 B 项目的卡片」都会发生。设计文档 §6.3 明确禁止
// 「无项目时静默读写 default」。现在的规则：
//   · 有 projectPath ⇒ 四个 Tab 共用它作为空间键，且标题带上项目名称；
//   · 无 projectPath ⇒ 显示「尚未选择项目」空态，**不读也不写**任何空间（包括 default）。
//
// Tab 条复用 ui/TabBar 原语（role=tablist/tab + 方向键 + aria-selected 收敛在那一处），
// 本文件不含裸 <button>（ui-conventions 棘轮要求）。
import { useState } from 'react';
import TabBar from './ui/TabBar';
import Button from './ui/Button';
import TeamSpace from './TeamSpace';
import TeamsPage from './TeamsPage';
import StudioBoard from './StudioBoard';
import ArtifactPanel from './ArtifactPanel';
import { STUDIO_TABS, DEFAULT_STUDIO_TAB, type StudioTab } from '../lib/studioTabs';
import { useI18n } from '../i18n';

export interface StudioPageProps {
  /** 受控 Tab（可选）：不传则由本组件自管，避免 App.jsx 再背一份视图状态（800 行门禁） */
  tab?: StudioTab;
  onTab?: (t: StudioTab) => void;
  /**
   * 当前项目的 canonical 标识。按 §4.2.1 它与 projectPath 不是同义词；
   * 本组件拿它做**展示与判空**，执行目录仍由主进程按自己的键解析。
   */
  projectId?: string | null;
  /** 当前项目目录（Agent 工作目录 / 空间键）。为空 ⇒ 进入「尚未选择项目」空态。 */
  projectPath?: string | null;
  projectName?: string | null;
  threadId?: string | null;
  onOpenFile?: (p: string) => void;
  /** 「尚未选择项目」空态的出口（App 的项目选择器） */
  onPickProject?: () => void;
  /** 工件面板的「自动打开最新工件」回调（透传，不在此处发明语义） */
  onAutoOpen?: () => void;
}

export default function StudioPage({
  tab, onTab, projectId = null, projectPath = null, projectName = null,
  threadId = null, onOpenFile, onPickProject, onAutoOpen,
}: StudioPageProps) {
  const { t } = useI18n();
  const [inner, setInner] = useState<StudioTab>(DEFAULT_STUDIO_TAB);
  const active = tab ?? inner;
  const go = (id: StudioTab) => { if (onTab) onTab(id); else setInner(id); };

  // 无项目 ⇒ 四 Tab 一律不挂载真实数据面（含 default），否则就是串项目。
  // 这不是「加载失败」，是**前置条件缺失**，故空态自带出口而不是塞一个骨架屏。
  if (!projectPath) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="text-sm font-medium">{t('studio.noProjectTitle')}</div>
          <div className="max-w-md text-caption text-text2">{t('studio.noProjectDesc')}</div>
          {onPickProject && (
            <Button size="sm" variant="secondary" onClick={onPickProject}>
              {t('studio.noProjectAction')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1 shrink-0">
        <span className="text-caption text-text2 truncate" title={projectId || projectPath}>
          {projectName || projectPath}
        </span>
      </div>
      <TabBar
        tabs={STUDIO_TABS.map((x) => ({ id: x.id, label: t(x.labelKey) }))}
        active={active}
        onChange={(id) => go(id as StudioTab)}
        ariaLabel={t('studio.title')}
        className="flex gap-1 border-b border-border px-2"
      />
      {/* 只挂载活动 Tab（§4.4）：同时挂四个会让四份列表一起发请求 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {/* 空间 = 项目资产区：看板/审批（TeamSpace）+ 知识库（§8.2：知识库挂在这里，不另立一级入口）。
            projectId 与 spaceId 是两个键（§4.2.1）：spaceId 是空间键，projectId 是授权主体，
            知识库的授权/撤权只认后者，不能拿目录路径顶替。 */}
        {active === 'space' && <TeamSpace spaceId={projectPath} projectId={projectId} />}
        {active === 'roster' && <TeamsPage />}
        {active === 'board' && <StudioBoard projectPath={projectPath} onOpenFile={onOpenFile} />}
        {active === 'artifacts' && (
          <ArtifactPanel threadId={threadId} onOpenFile={onOpenFile} onAutoOpen={onAutoOpen} />
        )}
      </div>
    </div>
  );
}
