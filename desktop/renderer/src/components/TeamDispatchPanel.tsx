//
// 对话 `+` 菜单「军团」栏位 —— 候选编制（candidate roster）选择面板。
//
// 形态（2026-10-24 双入口重组 / 设计文档 §7.2、§9 P0-6）：
//   · 列出全部未归档团队（军团全局可见）；每行显示 名称 + 信息描述 + 成员数；
//   · 点选即把该团队设为**本次编制偏好**（回填到输入框上方的编制徽标）——
//     **不是**模式开关：普通对话照常可发起，只有判定器命中「需要编排」时该编制才被注入 roster；
//   · 每行另有「派活」按钮 = **显式**派活（用户主动要求现在就由这支团队执行），
//     走既有 `teams:dispatch`，调用形态不变；
//   · 面板底部提供「临时组队」：从数字员工目录里挑 2~3 个人组成一次性编制，
//     **不落 `teams` 表**（运行期由主进程按 dag.roster 快照机制消费）。
//
// 为什么去掉 本次任务目标/协作模式/预算上限/参与成员 四块表单：
//   这四项在派活时都有合理的缺省来源（目标=用户输入的那句话；模式=team.defaultMode；
//   预算=team.budget；成员=全队），暴露成必填表单只会把「说一句话就派活」变成「填四个表」。
//   缺省回落由主进程 teams:dispatch 承担（单一事实来源），渲染层不再各判一份。
//
// 纪律：
//   · 缺统筹：列表常驻只显示温和提示（leadMissing），不弹窗、不阻塞；真正的强校验在
//     发送派活时由 ChatArea / 主进程给出（服务端 code=LEAD_MISSING 是权威判据）。
//   · 文案一律走 i18n（零裸中文）；选中交互用 label + 单选控件，不新增裸 <button>。
import { useEffect, useState } from 'react';
import { IconUsers } from './icons';
import InlineAlert from './InlineAlert';
import Button from './ui/Button';
import { useI18n } from '../i18n';
import { getCandidateRoster, tempRosterFromEmployees, type CandidateRoster } from '../lib/candidateRoster';

interface Team {
  id: string;
  name: string;
  description?: string;
  archivedAt?: string | null;
  leadMissing?: boolean;
  memberCount?: number;
  members?: Array<{ id: string; enabled?: boolean }>;
}

interface Employee {
  id: string;
  name?: string;
  title_cn?: string;
  category?: string;
}

/**
 * 选中回调。opts 三态：
 *   · 不传 opts            → 设为本次编制偏好（普通对话仍可发起）
 *   · { dispatch, goal }   → 设为编制偏好并**立即派活**（显式动作）
 *   · { roster }           → 设为一次性编制（临时组队，不落 teams 表）
 */
export interface TeamPickOptions {
  dispatch?: boolean;
  goal?: string;
  roster?: CandidateRoster;
}

const TEMP_MAX = 3;

export default function TeamDispatchPanel({
  onClose, activeTeamId = null, onSelectTeam,
}: {
  onClose?: () => void;
  activeTeamId?: string | null;
  onSelectTeam?: (team: Team | null, opts?: TeamPickOptions) => void;
}) {
  const { t } = useI18n();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  // 当前编制（跨组件单一事实源：lib/candidateRoster）——高亮用；
  // activeTeamId 由 Composer 透传（null 时回落到这里，保证「当前编制」永远有回显）
  const currentId = activeTeamId || getCandidateRoster()?.teamId || null;
  // 显式派活用的目标（面板内填一次，所有行共用）
  const [goal, setGoal] = useState('');
  // 临时组队：从数字员工目录里挑人（一次性编制，不落 teams 表）
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [empLoading, setEmpLoading] = useState(false);
  const [empKeyword, setEmpKeyword] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  // 团队列表：只列未归档（归档团队派活必被服务端拒绝，不必让用户先看到再撞墙）
  useEffect(() => {
    let alive = true;
    (async () => {
      const api = window.mjcode;
      if (!api?.teamsList) { if (alive) { setLoading(false); setErr(t('teams.loadFailed')); } return; }
      try {
        const r = (await api.teamsList({})) as { ok?: boolean; teams?: Team[]; error?: string } | undefined;
        if (!alive) return;
        if (r?.ok) setTeams((r.teams || []).filter((x) => !x.archivedAt));
        else setErr(r?.error || t('teams.loadFailed'));
      } catch (e) {
        if (alive) setErr((e as Error).message || t('teams.loadFailed'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [t]);

  // 数字员工目录（临时组队的选人来源）——按需加载，不与团队列表抢跑
  const loadEmployees = async () => {
    setEmpLoading(true);
    try {
      const r = (await window.mjcode?.ecosystemEmployees?.({})) as { ok?: boolean; employees?: Employee[] } | undefined;
      setEmployees(r?.ok ? (r.employees || []) : []);
    } catch (e) {
      // 空数组的语义是「没有数字员工」，而这里是「没取到」——不记录会让目录故障表现成「生态中心是空的」
      console.error('[TeamDispatchPanel] loadEmployees failed:', e);
      setEmployees([]);
    }
    finally { setEmpLoading(false); }
  };

  // 选中团队：设为本次编制偏好（普通对话仍可发起）
  function pick(team: Team) {
    onSelectTeam?.(team);
    onClose?.();
  }

  // 显式派活：用户主动要求现在就由这支团队执行（调用形态不变，仍是 teams:dispatch）
  function dispatchNow(team: Team) {
    const g = String(goal || '').trim();
    if (!g) { setErr(t('teams.rosterGoalRequired')); return; }
    onSelectTeam?.(team, { dispatch: true, goal: g });
    onClose?.();
  }

  function togglePicked(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= TEMP_MAX) return prev;
      return [...prev, id];
    });
  }

  function applyTempRoster() {
    const chosen = employees.filter((e) => picked.includes(e.id));
    if (!chosen.length) { setErr(t('teams.rosterTempEmpty')); return; }
    onSelectTeam?.(null, { roster: tempRosterFromEmployees(chosen) });
    onClose?.();
  }

  const filteredEmployees = employees.filter((e) => {
    const kw = empKeyword.trim().toLowerCase();
    if (!kw) return true;
    return `${e.name || ''} ${e.title_cn || ''} ${e.category || ''}`.toLowerCase().includes(kw);
  });

  return (
    <div className="max-h-80 overflow-y-auto">
      <p className="text-text2 text-caption px-3 py-2 leading-relaxed">{t('teams.dispatchPickHint')}</p>
      {/* 显式派活的目标输入（派活是显式动作，目标必须由用户给出，不猜输入框里的半句话） */}
      <div className="px-3 pb-2">
        <input
          className="w-full bg-raise border border-border rounded-lg px-2 py-1 text-xs outline-none focus:border-accent"
          placeholder={t('teams.rosterGoalPlaceholder')}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </div>
      {loading && <p className="text-text2 text-xs px-3 py-3">{t('teams.loading')}</p>}
      {!loading && teams.length === 0 && (
        <p className="text-text2 text-xs px-3 py-4 leading-relaxed">{t('teams.dispatchNoTeams')}</p>
      )}
      {teams.map((x) => {
        const count = x.memberCount ?? (x.members || []).filter((m) => m.enabled !== false).length;
        return (
          <label key={x.id}
            className={`w-full flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-hover border-b border-border last:border-0 ${
              x.id === currentId ? 'bg-accent-bg' : ''}`}>
            <input type="radio" name="mjcode-team-pick" className="sr-only"
              checked={x.id === currentId} onChange={() => pick(x)} />
            <IconUsers size={14} className="text-text2 shrink-0 mt-1" />
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-xs truncate">{x.name}</span>
                {x.leadMissing && (
                  <span className="shrink-0 text-caption px-2 rounded bg-warn-bg text-warn">{t('teams.leadMissing')}</span>
                )}
              </span>
              <span className="block text-caption text-text2 truncate" title={x.description || ''}>
                {x.description || t('teams.noDescription')}
              </span>
              <span className="block text-caption text-text2 truncate">
                {t('teams.memberCount', { n: count })}
              </span>
            </span>
            <span className="shrink-0" onClick={(e) => e.preventDefault()}>
              <Button variant="accent-ghost" size="xs" onClick={() => dispatchNow(x)}>
                {t('teams.rosterDispatchNow')}
              </Button>
            </span>
          </label>
        );
      })}

      {/* 临时组队：一次性编制，不落 teams 表 */}
      <div className="border-t border-border px-3 py-2 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{t('teams.rosterTempTitle')}</span>
          <Button variant="ghost" size="xs" onClick={() => { if (!employees.length && !empLoading) loadEmployees(); }}>
            {empLoading ? t('teams.loading') : (employees.length ? t('teams.rosterTempRefresh') : t('teams.rosterTempPick'))}
          </Button>
        </div>
        <p className="text-caption text-text2 leading-relaxed">{t('teams.rosterTempHint')}</p>
        {employees.length > 0 && (
          <>
            <input
              className="w-full bg-raise border border-border rounded-lg px-2 py-1 text-xs outline-none focus:border-accent"
              placeholder={t('teams.rosterTempSearch')}
              value={empKeyword}
              onChange={(e) => setEmpKeyword(e.target.value)}
            />
            <div className="max-h-32 overflow-y-auto">
              {filteredEmployees.map((e) => (
                <label key={e.id} className="flex items-center gap-2 px-1 py-1 cursor-pointer hover:bg-hover">
                  <input type="checkbox" className="sr-only" checked={picked.includes(e.id)} onChange={() => togglePicked(e.id)} />
                  <span className={`text-xs truncate ${picked.includes(e.id) ? 'text-accent' : 'text-text2'}`}>
                    {e.title_cn || e.name || e.id}
                  </span>
                </label>
              ))}
              {filteredEmployees.length === 0 && (
                <p className="text-caption text-text2 px-1 py-1">{t('teams.rosterTempEmpty')}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="xs" onClick={applyTempRoster} disabled={!picked.length}>
                {t('teams.rosterTempApply', { n: picked.length })}
              </Button>
              <span className="text-caption text-text2">{t('teams.rosterTempMax', { n: TEMP_MAX })}</span>
            </div>
          </>
        )}
      </div>

      {err && <div className="px-3 py-2"><InlineAlert type="error" onDismiss={() => setErr('')}>{err}</InlineAlert></div>}
    </div>
  );
}
