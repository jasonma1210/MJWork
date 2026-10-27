// 派活面板（2026-10-27，替代原「发布任务」）
//
// ── 为什么合并（用户原话：「我本该用来发布任务的『发布任务』进入后，发布任务没有任何和助手
//    有关的事情，而助手目录和 AI 建团又各自为战，都有发布」）──
// 原来「派活」这个动作被拆成三条互不相认的路径：目录（派给单个助手，强制开新会话）、
// 发布任务（派给军团或"自动"，挂当前会话）、AI 建团（只写编制，不发任务）。主体被拆在三个
// Tab 里，落点规则还互相冲突。本面板把「谁来干 × 什么时候跑 × 干什么」收成**一个提交出口**，
// 三个 Tab 降级为资源面（目录挑人 / 建团造编制），挑完回填到这里。
//
// ── 三条不能妥协的口径 ──
// ① **不新增第四条派活实现**：三种主体各自复用既有通道
//    （助手 → recruit-expert / enable-expert；团队 → teams:dispatch；系统 → 判定器 onAutoRun）。
// ② **落点统一**：一律落当前会话，没有会话才新建（由调用方保证，见 App 的 recruit 分支）。
//    这里不自行决定开不开新会话 —— 两个地方各决定一次就是上一版的病根。
// ③ **不支持的能力显式禁用，不假装支持**：定时通道（无人值守）没有确认点，也无法携带
//    助手的 rolePreset，故「定时 + 指定助手」直接禁用并说明原因，而不是静默降级成"团队/系统"。
import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from './ui/Button';
import InlineAlert from './InlineAlert';
import { IconBot, IconUsers, IconZap, IconPlus } from './icons';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { REPEATS, planSummary, type RepeatId, type ValidType } from '../lib/schedulePresets';
import type { Employee } from './AssistantDirectory';

/** 执行主体三态：指定助手 / 指定团队 / 交给系统判定 */
type Subject = 'assistant' | 'team' | 'system';
type Kind = 'now' | 'scheduled';

interface TeamSummary { id: string; name: string; leadMissing?: boolean; archivedAt?: string | null }
interface RunTask { taskId: string; title: string; status: string }
interface RunCard {
  runId: string; kind: string; teamName: string; status: string; goal: string;
  createdAt: number; waves: number; tasks: RunTask[];
}

/** 运行状态 → i18n key（未知状态原样显示，不猜） */
const STATUS_KEY: Record<string, string> = {
  running: 'assistant.dispatch.statusRunning',
  done: 'assistant.dispatch.statusDone',
  failed: 'assistant.dispatch.statusFailed',
  queued: 'assistant.dispatch.statusQueued',
  ready: 'assistant.dispatch.statusReady',
};

export interface AssistantDispatchProps {
  threadId?: string | null;
  projectPath?: string;
  /** 主体=系统：目标交回主链路，由判定器按任务结构决定是否升级为团队 */
  onAutoRun: (goal: string) => void;
  /** 主体=团队：确定性派活（复用 teams:dispatch） */
  onDispatchTeam?: (p: { teamId: string; goal: string }) => Promise<{ ok?: boolean; tasks?: number; error?: string; code?: string } | undefined>;
  /** 主体=助手：复用 recruit-expert 链路（落当前会话，见 App） */
  onDispatchAssistant?: (p: { employee: Employee; goal: string }) => void;
  /** 从目录/建团回填的预选主体 */
  initialSubject?: Subject;
  initialEmployeeId?: string;
  initialTeamId?: string;
  /** 主体列表为空时的引导出口（跳目录 / 跳建团），不做空下拉 */
  onNeedAssistant?: () => void;
  onNeedTeam?: () => void;
}

export default function AssistantDispatch({
  threadId, projectPath, onAutoRun, onDispatchTeam, onDispatchAssistant,
  initialSubject = 'assistant', initialEmployeeId = '', initialTeamId = '',
  onNeedAssistant, onNeedTeam,
}: AssistantDispatchProps) {
  const { t } = useI18n();
  const [subject, setSubject] = useState<Subject>(initialSubject);
  const [employeeId, setEmployeeId] = useState(initialEmployeeId);
  const [teamId, setTeamId] = useState(initialTeamId);
  const [goal, setGoal] = useState('');
  const [kind, setKind] = useState<Kind>('now');
  const [repeat, setRepeat] = useState<RepeatId>('daily');
  const [time, setTime] = useState('09:00');
  const [validType, setValidType] = useState<ValidType>('forever');
  const [validUntil, setValidUntil] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [runs, setRuns] = useState<RunCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const plan = planSummary(repeat, time, '', validType, validUntil, t);

  // 预选回填：从目录/建团切过来时，主体与对象都要跟过去（否则"点了『以此派活』却没选中人"）
  useEffect(() => { if (initialEmployeeId) { setEmployeeId(initialEmployeeId); setSubject('assistant'); } }, [initialEmployeeId]);
  useEffect(() => { if (initialTeamId) { setTeamId(initialTeamId); setSubject('team'); } }, [initialTeamId]);
  useEffect(() => { if (initialSubject) setSubject(initialSubject); }, [initialSubject]);

  const loadRuns = useCallback(async () => {
    if (!threadId) { setRuns([]); return; }
    try {
      const r = (await window.mjcode?.teamsListThreadRuns?.({ threadId })) as { runs?: RunCard[] } | undefined;
      setRuns(Array.isArray(r?.runs) ? r!.runs.slice(0, 8) : []);
    } catch {
      // 看板取不到就空着：它不是主路径，不该把发起任务这件事挡住
      setRuns([]);
    }
  }, [threadId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = (await window.mjcode?.ecosystemEmployees?.({})) as { ok?: boolean; employees?: Employee[] } | undefined;
        if (alive && r?.ok !== false) setEmployees(Array.isArray(r?.employees) ? r!.employees : []);
      } catch { /* 目录取不到：团队/系统两条主体仍可用 */ }
      try {
        const r = (await window.mjcode?.teamsList?.({})) as { ok?: boolean; teams?: TeamSummary[] } | undefined;
        if (alive) setTeams((r?.teams || []).filter((x) => !x.archivedAt));
      } catch { /* 同上 */ }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === employeeId) || null,
    [employees, employeeId],
  );
  const assistantBlockedBySchedule = subject === 'assistant' && kind === 'scheduled';
  const canSubmit = !!goal.trim() && !busy
    && !assistantBlockedBySchedule
    && !(subject === 'assistant' && !selectedEmployee)
    && !(subject === 'team' && !teamId);

  async function createScheduled(g: string) {
    if (!plan.ok) { setErr(plan.text); return; }
    const name = (g.split('\n')[0] || '').trim().slice(0, 40) || t('assistant.dispatch.defaultName');
    const r = (await api.createScheduledTask({
      name, prompt: g, schedule: plan.cron, enabled: true,
      valid_until: validType === 'until' && validUntil ? validUntil : null,
      // 无人值守默认不外发、不产生不可逆动作（被拦的进「待确认动作清单」）
      external_policy: 'block', expects_file: true, trigger_type: 'cron',
      // 只有显式选了团队才落库；不选 = 匿名编排。**不做自动判定**：
      // 无人值守通道没有确认点，静默升级等于偷偷花用户的钱。
      team_id: subject === 'team' && teamId ? String(teamId) : null,
      model: null,
    })) as { ok?: boolean; error?: string } | undefined;
    if (r && r.ok === false) throw new Error(r.error || '');
    setNotice(t('assistant.dispatch.scheduledCreated', { plan: plan.text }));
    setGoal('');
  }

  /** 派给助手前先确认运行条件：目录页的 runtime 判定不在这里重算，但提交时必须以真结果为准 */
  async function dispatchAssistant(g: string) {
    const emp = selectedEmployee;
    if (!emp) { setErr(t('assistant.dispatch.needAssistant')); return; }
    const rt = (await window.mjcode?.ecosystemEmployeeRuntime?.({ id: emp.id })) as
      { ok?: boolean; rolePreset?: unknown; error?: string } | undefined;
    if (!rt?.ok || !rt.rolePreset) {
      setErr(t('assistant.dispatch.assistantUnavailable', { name: emp.title_cn || emp.name || emp.id }));
      return;
    }
    onDispatchAssistant?.({ employee: emp, goal: g });
    setNotice(t('assistant.dispatch.assistantDispatched', { name: emp.title_cn || emp.name || emp.id }));
    setGoal('');
  }

  async function dispatchTeam(g: string) {
    if (!threadId) { setErr(t('assistant.dispatch.needThread')); return; }
    const r = await onDispatchTeam?.({ teamId, goal: g });
    if (r && r.ok === false) {
      setErr(t('assistant.dispatch.dispatchFailed', { msg: r.error || r.code || '' }));
      return;
    }
    setNotice(t('assistant.dispatch.dispatched', { n: Number(r?.tasks) || 0 }));
    setGoal('');
    await loadRuns();
  }

  async function submit() {
    const g = String(goal || '').trim();
    if (!g) { setErr(t('assistant.dispatch.needGoal')); return; }
    if (assistantBlockedBySchedule) { setErr(t('assistant.dispatch.scheduledNoAssistant')); return; }
    setBusy(true); setErr(''); setNotice('');
    try {
      if (kind === 'scheduled') { await createScheduled(g); return; }
      if (subject === 'assistant') { await dispatchAssistant(g); return; }
      if (subject === 'team') { await dispatchTeam(g); return; }
      onAutoRun(g);
      setNotice(t('assistant.dispatch.autoRunNotice'));
      setGoal('');
    } catch (e) {
      setErr(kind === 'scheduled'
        ? t('assistant.dispatch.scheduledFailed', { msg: String((e as Error)?.message || e) })
        : t('assistant.dispatch.dispatchFailed', { msg: String((e as Error)?.message || e) }));
    } finally {
      setBusy(false);
    }
  }

  const SUBJECTS: Array<{ id: Subject; labelKey: string; Icon: typeof IconBot }> = [
    { id: 'assistant', labelKey: 'assistant.dispatch.subjectAssistant', Icon: IconBot },
    { id: 'team', labelKey: 'assistant.dispatch.subjectTeam', Icon: IconUsers },
    { id: 'system', labelKey: 'assistant.dispatch.subjectSystem', Icon: IconZap },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-5 space-y-4">
      <header className="space-y-1">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <IconZap size={15} /> {t('assistant.dispatch.title')}
        </h2>
        <p className="text-caption text-text2 leading-relaxed">{t('assistant.dispatch.subtitle')}</p>
      </header>

      {/* ① 执行主体：三态显式选择。默认「助手」——进来第一眼就该看到"派给谁" */}
      <section className="rounded-xl border border-border bg-surface p-3 space-y-2">
        <div className="text-caption text-text2">{t('assistant.dispatch.subjectLabel')}</div>
        <div className="flex flex-wrap gap-2">
          {SUBJECTS.map(({ id, labelKey, Icon }) => (
            <Button
              key={id}
              size="sm"
              variant={subject === id ? 'accent-ghost' : 'ghost'}
              className={subject === id ? '!bg-accent-bg' : undefined}
              onClick={() => { setSubject(id); setErr(''); }}
              aria-pressed={subject === id}
            >
              <Icon size={13} /> {t(labelKey)}
            </Button>
          ))}
        </div>

        {subject === 'assistant' && (
          employees.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-caption text-text2">
              <span>{t('assistant.dispatch.noAssistants')}</span>
              {onNeedAssistant && <Button size="xs" variant="ghost" onClick={onNeedAssistant}>{t('assistant.dispatch.goDirectory')}</Button>}
            </div>
          ) : (
            <select
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
              value={employeeId}
              onChange={(e) => { setEmployeeId(e.target.value); setErr(''); }}
              aria-label={t('assistant.dispatch.subjectAssistant')}
            >
              <option value="">{t('assistant.dispatch.assistantPlaceholder')}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title_cn || e.name || e.id}{e.category ? ` · ${e.category}` : ''}
                </option>
              ))}
            </select>
          )
        )}

        {subject === 'team' && (
          teams.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-caption text-text2">
              <span>{t('assistant.dispatch.noTeams')}</span>
              {onNeedTeam && <Button size="xs" variant="ghost" onClick={onNeedTeam}>{t('assistant.dispatch.goAiTeam')}</Button>}
            </div>
          ) : (
            <select
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
              value={teamId}
              onChange={(e) => { setTeamId(e.target.value); setErr(''); }}
              aria-label={t('assistant.dispatch.subjectTeam')}
            >
              <option value="">{t('assistant.dispatch.teamPlaceholder')}</option>
              {teams.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}{x.leadMissing ? t('assistant.dispatch.leadMissingSuffix') : ''}
                </option>
              ))}
            </select>
          )
        )}

        {subject === 'system' && (
          <p className="text-caption leading-relaxed text-text2">{t('assistant.dispatch.systemHint')}</p>
        )}
      </section>

      {/* ② 目标 */}
      <label className="block">
        <div className="text-caption text-text2 mb-1">{t('assistant.dispatch.goalLabel')}</div>
        <textarea
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent resize-y"
          rows={4}
          placeholder={t('assistant.dispatch.goalPlaceholder')}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>

      {/* ③ 运行方式：立即 / 定时。定时只在团队或系统主体下可用（见文件头第③条） */}
      <section className="space-y-2">
        <div className="text-caption text-text2">{t('assistant.dispatch.kindLabel')}</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={kind === 'now' ? 'accent-ghost' : 'ghost'} className={kind === 'now' ? '!bg-accent-bg' : undefined} onClick={() => setKind('now')} aria-pressed={kind === 'now'}>
            {t('assistant.dispatch.kindNow')}
          </Button>
          <Button size="sm" variant={kind === 'scheduled' ? 'accent-ghost' : 'ghost'} className={kind === 'scheduled' ? '!bg-accent-bg' : undefined} onClick={() => setKind('scheduled')} aria-pressed={kind === 'scheduled'}>
            {t('assistant.dispatch.kindScheduled')}
          </Button>
        </div>
        {assistantBlockedBySchedule && (
          <p className="rounded-lg border border-warn/40 bg-warn-bg px-3 py-2 text-caption leading-relaxed text-warn">
            {t('assistant.dispatch.scheduledNoAssistant')}
          </p>
        )}
      </section>

      {kind === 'scheduled' && !assistantBlockedBySchedule && (
        <section className="space-y-2 rounded-xl border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t('assistant.dispatch.repeatLabel')}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as RepeatId)}
            >
              {REPEATS.filter((r) => r.id !== 'custom').map((r) => (
                // 复用定时任务页的同一份文案（不复制一套「每天/工作日/每周」，避免两处漂移）
                  <option key={r.id} value={r.id}>{t(r.labelKey)}</option>
              ))}
            </select>
            <input
              type="time"
              aria-label={t('assistant.dispatch.timeLabel')}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
            <select
              aria-label={t('assistant.dispatch.validLabel')}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm"
              value={validType}
              onChange={(e) => setValidType(e.target.value as ValidType)}
            >
              <option value="forever">{t('assistant.dispatch.validForever')}</option>
              <option value="until">{t('assistant.dispatch.validUntil')}</option>
            </select>
            {validType === 'until' && (
              <input
                type="date"
                aria-label={t('assistant.dispatch.validUntilDate')}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-sm"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            )}
          </div>
          <p className="text-caption text-text2">{plan.text}</p>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="primary" loading={busy} disabled={!canSubmit} onClick={submit}>
          {kind === 'scheduled' ? t('assistant.dispatch.confirmScheduled') : t('assistant.dispatch.confirmNow')}
        </Button>
        <span className="text-caption text-text2">
          {!goal.trim()
            ? t('assistant.dispatch.needGoal')
            : kind === 'scheduled'
            ? t('assistant.dispatch.hintScheduled')
            : subject === 'assistant'
              ? (selectedEmployee ? t('assistant.dispatch.hintAssistant') : t('assistant.dispatch.hintPickAssistant'))
              : subject === 'team' ? t('assistant.dispatch.hintTeam') : t('assistant.dispatch.hintSystem')}
        </span>
      </div>

      {err && <InlineAlert type="error" onDismiss={() => setErr('')}>{err}</InlineAlert>}
      {notice && <div className="text-caption text-text2">{notice}</div>}

      {/* ④ 看板：本会话已发起的编排与进度（只读投影，不新增状态机） */}
      <section className="rounded-xl border border-border bg-surface p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-text">{t('assistant.dispatch.boardTitle')}</div>
          <Button size="xs" variant="ghost" onClick={loadRuns}>{t('assistant.dispatch.boardRefresh')}</Button>
        </div>
        {!threadId ? (
          <p className="text-caption text-text2">{t('assistant.dispatch.boardNoThread')}</p>
        ) : runs.length === 0 ? (
          <p className="text-caption text-text2">{t('assistant.dispatch.boardEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => {
              const statusKey = STATUS_KEY[r.status];
              return (
                <li key={r.runId} className="rounded-lg border border-border px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-text">{r.goal || t('assistant.dispatch.boardUntitled')}</span>
                    <span className="shrink-0 text-caption text-text2">
                      {statusKey ? t(statusKey) : r.status}
                    </span>
                  </div>
                  <div className="mt-1 text-caption text-text2">
                    {t('assistant.dispatch.boardTaskCount', { n: r.tasks?.length || 0 })}
                    {' · '}{t('assistant.dispatch.boardWaves', { n: r.waves || 0 })}
                    {' · '}{r.teamName || t('assistant.dispatch.boardNoTeam')}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
