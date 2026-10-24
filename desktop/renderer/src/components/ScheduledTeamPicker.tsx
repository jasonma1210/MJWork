// 定时任务的「用哪支军团跑」选择器（设计文档 §7.6 / §9 P1-6 的渲染层落点）
//
// 为什么单独成文件：`ScheduledTasks.jsx` 已 754 行、贴着 800 行黄线（`test/max-lines.test.js`
// 的 BASELINE_800 是「只减不增」清单），新增逻辑只能外置。
//
// 语义纪律（设计文档 §7.6 无人值守安全）：
//   · 定时任务**不得在无人值守时静默升级**为团队执行 ⇒ 团队化必须由用户在创建任务时
//     **预先声明** team_id；界面只做「声明」，不提供「自动决定用不用团队」的选项；
//   · 「界面能选、实际跑的还是匿名组」是设计文档点名的假闭环形态 ⇒ 本组件把
//     主进程「是否真的落库了 team_id」这件事**回显出来**（见 ScheduledTeamBadge），
//     而不是选了就假装生效。
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

interface TeamOption {
  id: string;
  name: string;
  archivedAt?: string | null;
}

// 团队清单的进程内缓存：选择器与卡片徽标共用一份，避免「卡片 N 条 = N 次列表请求」。
let cache: TeamOption[] | null = null;
let inflight: Promise<TeamOption[]> | null = null;

function loadTeams(): Promise<TeamOption[]> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = (await window.mjcode?.teamsList?.({})) as { ok?: boolean; teams?: TeamOption[] } | undefined;
      cache = (r?.teams || []).filter((x) => !x.archivedAt);
    } catch {
      cache = [];
    } finally {
      inflight = null;
    }
    return cache || [];
  })();
  return inflight;
}

function useTeams(): TeamOption[] {
  const [teams, setTeams] = useState<TeamOption[]>(cache || []);
  useEffect(() => {
    let alive = true;
    loadTeams().then((list) => { if (alive) setTeams(list); });
    return () => { alive = false; };
  }, []);
  return teams;
}

/** 表单里的军团选择器（空值 = 匿名编排，即既有行为，零变化） */
export function ScheduledTeamPicker({
  value, onChange,
}: {
  value: string;
  onChange: (teamId: string) => void;
}) {
  const { t } = useI18n();
  const teams = useTeams();
  return (
    <div className="mb-3">
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t('assistant.scheduled.teamLabel')}
        className="w-full h-10 bg-input border border-border rounded-xl px-3 text-sm mb-1 outline-none focus:border-accent"
      >
        <option value="">{t('assistant.scheduled.teamNone')}</option>
        {teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <p className="text-xs text-text2">{t('assistant.scheduled.teamHint')}</p>
    </div>
  );
}

/**
 * 卡片上的军团徽标：显示已落库的绑定。
 * ⚠ 只显示**任务里真实存在的 team_id** —— 不根据表单状态推断，
 * 这样「选了但主进程没接受」会表现为徽标不出现（可见的真相），而不是一段假的绑定文案。
 */
export function ScheduledTeamBadge({ teamId }: { teamId?: string | null }) {
  const { t } = useI18n();
  const teams = useTeams();
  const id = String(teamId || '').trim();
  if (!id) return null;
  const hit = teams.find((x) => x.id === id);
  return (
    <span className="text-caption px-2 rounded bg-raise text-text2 shrink-0" title={id}>
      {hit ? t('assistant.scheduled.badge', { name: hit.name }) : t('assistant.scheduled.badgeUnknown', { id })}
    </span>
  );
}

/** 测试/联调用：清缓存（Node 门禁不依赖它，但避免热更新后看到旧清单） */
export function resetTeamCache(): void {
  cache = null;
  inflight = null;
}
