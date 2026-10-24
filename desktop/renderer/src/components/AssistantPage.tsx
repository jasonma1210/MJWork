// 助理工作台（设计文档 §7.7 信息架构图 / §9 P0-4）
//
// 一级导航重组后的第二个入口「助理」：它把原先散在侧栏的「团队编制」与「定时任务」
// 收进同一个工作台，并新增「AI 建团」与「复杂问题」两条重编排路径。
//
// 四个子 Tab（清单见 lib/assistantTabs.ts，此处只渲染）：
//   Tab1 军团编制 —— 原样搬入 TeamsPage（不改其业务逻辑）
//   Tab2 AI 建团   —— AiTeamBuilder（草案卡片逐条采纳/编辑/否决）
//   Tab3 定时任务 —— 原样搬入 ScheduledTasks
//   Tab4 复杂问题 —— 显式选「按团队执行」的发起入口
//
// 按 tab **挂载**（不是同时挂载）：三个视图各自持有自己的滚动位置与表单状态，
// 同时挂载会让三份列表同时发请求、也把三个页面的状态混在一个 DOM 里。
import { useEffect, useState } from 'react';
import TeamsPage from './TeamsPage';
import ScheduledTasks from './ScheduledTasks';
import AiTeamBuilder from './AiTeamBuilder';
import InlineAlert from './InlineAlert';
import Button from './ui/Button';
import TabBar from './ui/TabBar';
import { IconBot, IconClock, IconUsers, IconZap } from './icons';
import { useI18n } from '../i18n';
import { ASSISTANT_TABS, type AssistantTab } from '../lib/assistantTabs';

const TAB_ICON: Record<AssistantTab, typeof IconUsers> = {
  teams: IconUsers,
  aiTeam: IconBot,
  scheduled: IconClock,
  complex: IconZap,
};

interface TeamSummary {
  id: string;
  name: string;
  description?: string;
  leadMissing?: boolean;
  archivedAt?: string | null;
}

export default function AssistantPage({
  tab, onTab, threadId, projectPath,
}: {
  tab: AssistantTab;
  onTab: (t: AssistantTab) => void;
  /** 当前会话 id（Tab4 派活挂到该会话；无会话时提示先建会话） */
  threadId?: string | null;
  /** 当前项目目录（派活的工作目录） */
  projectPath?: string;
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
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'teams' && <TeamsPage />}
        {tab === 'aiTeam' && <AiTeamBuilder />}
        {tab === 'scheduled' && <ScheduledTasks />}
        {tab === 'complex' && <ComplexTaskLauncher threadId={threadId} projectPath={projectPath} />}
      </div>
    </div>
  );
}

// Tab4「复杂问题」：用户显式选「按团队执行」的发起入口。
//
// 定位（设计文档 §7.1）：「新建任务」里的复杂问题由**模型自动判定**后升级；
// 这里反之——**用户自己决定**用哪支团队跑，适合无人值守前的人工编排与复跑。
// 派活走既有 `teams:dispatch`（调用形态不变），结果落到当前会话。
function ComplexTaskLauncher({ threadId, projectPath }: { threadId?: string | null; projectPath?: string }) {
  const { t } = useI18n();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [teamId, setTeamId] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = (await window.mjcode?.teamsList?.({})) as { ok?: boolean; teams?: TeamSummary[] } | undefined;
        if (alive) setTeams((r?.teams || []).filter((x) => !x.archivedAt));
      } catch { /* 列表取不到：展示空态，不阻塞 */ }
    })();
    return () => { alive = false; };
  }, []);

  async function dispatch() {
    const g = String(goal || '').trim();
    if (!teamId) { setErr(t('assistant.complex.needTeam')); return; }
    if (!g) { setErr(t('assistant.complex.needGoal')); return; }
    if (!threadId) { setErr(t('assistant.complex.needThread')); return; }
    setBusy(true); setErr(''); setNotice('');
    try {
      const r = (await window.mjcode?.teamsDispatch?.({
        teamId, goal: g, threadId, projectPath: projectPath || '',
      })) as { ok?: boolean; tasks?: number; code?: string; error?: string } | undefined;
      if (r?.ok) setNotice(t('assistant.complex.dispatched', { n: r.tasks || 0 }));
      else setErr(t('assistant.complex.dispatchFailed', { msg: r?.error || r?.code || '' }));
    } catch (e) {
      setErr(t('assistant.complex.dispatchFailed', { msg: String((e as Error)?.message || e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-5 space-y-3">
      <header className="space-y-1">
        <h2 className="text-sm font-medium flex items-center gap-2"><IconZap size={15} /> {t('assistant.complex.title')}</h2>
        <p className="text-caption text-text2 leading-relaxed">{t('assistant.complex.subtitle')}</p>
      </header>
      <div className="space-y-2">
        <label className="block">
          <div className="text-caption text-text2 mb-1">{t('assistant.complex.teamLabel')}</div>
          <select
            className="bg-raise border border-border rounded-lg px-2 py-2 text-sm w-full max-w-sm"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          >
            <option value="">{t('assistant.complex.teamPlaceholder')}</option>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}{x.leadMissing ? t('assistant.complex.leadMissingSuffix') : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-caption text-text2 mb-1">{t('assistant.complex.goalLabel')}</div>
          <textarea
            className="w-full bg-raise border border-border rounded-xl px-3 py-2 text-sm outline-none focus:border-accent"
            rows={4}
            placeholder={t('assistant.complex.goalPlaceholder')}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <Button variant="primary" size="sm" loading={busy} onClick={dispatch}>
          <IconZap size={13} /> {t('assistant.complex.run')}
        </Button>
      </div>
      {err && <InlineAlert type="error" onDismiss={() => setErr('')}>{err}</InlineAlert>}
      {notice && <InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert>}
    </div>
  );
}
