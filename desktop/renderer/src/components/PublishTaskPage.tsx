// 发布任务（2026-10-24）——助理工作台的**统一发起面**
//
// 用户诉求（原话）：「在助理里面的发布任务只有一个界面，统一输入文本内容后选中军团或者
// 不选择使用默认自动构建，以及下拉菜单选择复杂任务（默认）和定时任务，复杂任务直接点击
// 确认即可操作，有看板；定时任务弹出定时任务的相关操作输入内容」。
//
// 因此本组件是一个**单表单**，而不是四个并列页：
//   ① 一个文本框收目标；
//   ② 军团下拉：不选 = 交给系统自动构建（不落库建团，走判定器，见下）；
//   ③ 类型下拉：复杂任务（默认）/ 定时任务；
//   ④ 复杂任务 ⇒ 点确认即执行；下方**看板**展示本会话已发起的编排与进度；
//   ⑤ 定时任务 ⇒ 就地展开「重复 / 有效期 / 时间」三个控件 + 执行计划预览（含下次运行）。
//
// 关键设计取舍：
//   · **不选军团 ≠ 报错**：按用户要求是「使用默认自动构建」。实现上把目标交回主链路
//     （`onAutoRun`）——由判定器按任务结构决定是否升级为团队。这样不必为了「自动」而
//     静默往 teams 表里建一个用户没看过的军团（那是不可逆的写操作）。
//   · 选军团 ⇒ 走既有 `teams:dispatch`，确定性派活，与「军团」页的派活是**同一条通道**。
//   · 定时任务 ⇒ 走既有 `api.createScheduledTask`，cron 由 `lib/schedulePresets.ts` 算出
//     —— 与定时任务页共用同一份实现，避免「预览 09:00、实际 10:00」。
import { useCallback, useEffect, useState } from 'react';
import InlineAlert from './InlineAlert';
import Button from './ui/Button';
import { IconZap, IconClock } from './icons';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import {
  REPEATS, VALID_TYPES, planSummary, type RepeatId, type ValidType,
} from '../lib/schedulePresets';

interface TeamSummary {
  id: string;
  name: string;
  leadMissing?: boolean;
  archivedAt?: string | null;
}

interface RunTask {
  taskId: string;
  title: string;
  status: string;
}

interface RunCard {
  runId: string;
  kind: string;
  teamName: string;
  status: string;
  goal: string;
  createdAt: number;
  waves: number;
  tasks: RunTask[];
}

type TaskKind = 'complex' | 'scheduled';

/** 运行状态 → i18n key（未知状态原样显示，不猜） */
const STATUS_KEY: Record<string, string> = {
  running: 'assistant.publish.statusRunning',
  done: 'assistant.publish.statusDone',
  failed: 'assistant.publish.statusFailed',
  queued: 'assistant.publish.statusQueued',
  ready: 'assistant.publish.statusReady',
};

export default function PublishTaskPage({
  threadId, projectPath, onAutoRun,
}: {
  /** 当前会话 id（派活挂到该会话；定时任务不依赖它） */
  threadId?: string | null;
  /** 当前项目目录（派活的工作目录） */
  projectPath?: string;
  /** 不选军团时把目标交回主链路，由判定器自动决定（可能升级为团队） */
  onAutoRun: (goal: string) => void;
}) {
  const { t } = useI18n();
  const [goal, setGoal] = useState('');
  const [teamId, setTeamId] = useState('');
  const [kind, setKind] = useState<TaskKind>('complex');
  const [repeat, setRepeat] = useState<RepeatId>('daily');
  const [time, setTime] = useState('09:00');
  const [validType, setValidType] = useState<ValidType>('forever');
  const [validUntil, setValidUntil] = useState('');
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [runs, setRuns] = useState<RunCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const plan = planSummary(repeat, time, '', validType, validUntil, t);

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
        const r = (await window.mjcode?.teamsList?.({})) as { ok?: boolean; teams?: TeamSummary[] } | undefined;
        if (alive) setTeams((r?.teams || []).filter((x) => !x.archivedAt));
      } catch { /* 列表取不到：仍是「自动构建」这一条可用路径 */ }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  async function createScheduled(g: string) {
    if (!plan.ok) { setErr(plan.text); return; }
    // 任务名：取目标首行前 40 字（主进程 name 上限 60）；空则用占位名，不阻断
    const name = (g.split('\n')[0] || '').trim().slice(0, 40) || t('assistant.publish.defaultName');
    const r = (await api.createScheduledTask({
      name,
      prompt: g,
      schedule: plan.cron,
      enabled: true,
      valid_until: validType === 'until' && validUntil ? validUntil : null,
      // 无人值守默认不外发、不产生不可逆动作（被拦的进「待确认动作清单」）
      external_policy: 'block',
      expects_file: true,
      trigger_type: 'cron',
      // 用户显式选的军团才落库；不选 = null（匿名编排，与既有行为一致）。
      // **不做自动判定**：无人值守通道没有确认点，静默升级等于偷偷花用户的钱。
      team_id: teamId ? String(teamId) : null,
      model: null,
    })) as { ok?: boolean; error?: string } | undefined;
    if (r && r.ok === false) throw new Error(r.error || '');
    setNotice(t('assistant.publish.scheduledCreated', { plan: plan.text }));
    setGoal('');
  }

  async function dispatchComplex(g: string) {
    if (!teamId) {
      // 「默认自动构建」：交回主链路（判定器按结构判；需要组队时会出确认卡/自动建组），
      // 这里不替用户建团——建团是不可逆写操作，不该在一次点击里静默发生。
      onAutoRun(g);
      setNotice(t('assistant.publish.autoRunNotice'));
      setGoal('');
      return;
    }
    if (!threadId) { setErr(t('assistant.publish.needThread')); return; }
    const r = (await window.mjcode?.teamsDispatch?.({
      teamId, goal: g, threadId, projectPath: projectPath || '',
    })) as { ok?: boolean; tasks?: number; code?: string; error?: string } | undefined;
    if (r && r.ok === false) {
      setErr(t('assistant.publish.dispatchFailed', { msg: r.error || r.code || '' }));
      return;
    }
    setNotice(t('assistant.publish.dispatched', { n: Number(r?.tasks) || 0 }));
    setGoal('');
    await loadRuns();
  }

  async function submit() {
    const g = String(goal || '').trim();
    if (!g) { setErr(t('assistant.publish.needGoal')); return; }
    setBusy(true); setErr(''); setNotice('');
    try {
      if (kind === 'scheduled') await createScheduled(g);
      else await dispatchComplex(g);
    } catch (e) {
      setErr(kind === 'scheduled'
        ? t('assistant.publish.scheduledFailed', { msg: String((e as Error)?.message || e) })
        : t('assistant.publish.dispatchFailed', { msg: String((e as Error)?.message || e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-5 space-y-4">
      <header className="space-y-1">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <IconZap size={15} /> {t('assistant.publish.title')}
        </h2>
        <p className="text-caption text-text2 leading-relaxed">{t('assistant.publish.subtitle')}</p>
      </header>

      {/* ① 目标文本（唯一输入入口） */}
      <label className="block">
        <div className="text-caption text-text2 mb-1">{t('assistant.publish.goalLabel')}</div>
        <textarea
          className="w-full bg-raise border border-border rounded-xl px-3 py-2 text-sm outline-none focus:border-accent resize-y"
          rows={4}
          placeholder={t('assistant.publish.goalPlaceholder')}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>

      {/* ② 编制 + ③ 类型：一行两个下拉 */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <div className="text-caption text-text2 mb-1">{t('assistant.publish.teamLabel')}</div>
          <select
            className="bg-raise border border-border rounded-lg px-3 py-2 text-sm min-w-56"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          >
            <option value="">{t('assistant.publish.teamAuto')}</option>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}{x.leadMissing ? t('assistant.publish.leadMissingSuffix') : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-caption text-text2 mb-1">{t('assistant.publish.kindLabel')}</div>
          <select
            className="bg-raise border border-border rounded-lg px-3 py-2 text-sm min-w-40"
            value={kind}
            onChange={(e) => setKind(e.target.value === 'scheduled' ? 'scheduled' : 'complex')}
          >
            <option value="complex">{t('assistant.publish.kindComplex')}</option>
            <option value="scheduled">{t('assistant.publish.kindScheduled')}</option>
          </select>
        </label>
      </div>

      {/* ④ 定时参数（仅「定时任务」展开）：重复 / 有效期 / 时间 + 执行计划预览 */}
      {kind === 'scheduled' && (
        <section className="space-y-2 border border-border rounded-xl p-3 bg-raise">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t('assistant.publish.repeatLabel')}
              className="bg-sidebar border border-border rounded-lg px-3 py-2 text-sm"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as RepeatId)}
            >
              {REPEATS.filter((r) => r.id !== 'custom').map((r) => (
                <option key={r.id} value={r.id}>
                  {t('assistant.publish.repeatOption', { label: t(r.labelKey) })}
                </option>
              ))}
            </select>
            <select
              aria-label={t('assistant.publish.validLabel')}
              className="bg-sidebar border border-border rounded-lg px-3 py-2 text-sm"
              value={validType}
              onChange={(e) => setValidType(e.target.value === 'until' ? 'until' : 'forever')}
            >
              {VALID_TYPES.map((v) => (
                <option key={v.id} value={v.id}>
                  {t(v.labelKey)}
                </option>
              ))}
            </select>
            {validType === 'until' && (
              <input
                type="date"
                aria-label={t('assistant.publish.validUntilDate')}
                className="bg-sidebar border border-border rounded-lg px-3 py-2 text-sm"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            )}
            {/* lang 决定 Chromium 的 12/24 小时制（它跟**浏览器界面语言**走，不跟页面文案走）：
                不写时英文环境下会渲染成「09:00 AM」，与中文界面的「09:00」不一致。 */}
            <input
              type="time"
              lang="zh-CN"
              aria-label={t('assistant.publish.timeLabel')}
              className="bg-sidebar border border-border rounded-lg px-3 py-2 text-sm"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div className={`text-caption ${plan.ok ? 'text-text2' : 'text-danger'}`}>
            <IconClock size={12} className="inline mr-1 align-[-1px]" />
            {t('scheduled.scheduleLabel', { value: plan.text })}
          </div>
        </section>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" loading={busy} onClick={submit}>
          {kind === 'scheduled'
            ? <><IconClock size={13} /> {t('assistant.publish.confirmScheduled')}</>
            : <><IconZap size={13} /> {t('assistant.publish.confirmComplex')}</>}
        </Button>
        <span className="text-caption text-text2">
          {kind === 'scheduled'
            ? t('assistant.publish.hintScheduled')
            : (teamId ? t('assistant.publish.hintTeam') : t('assistant.publish.hintAuto'))}
        </span>
      </div>

      {err && <InlineAlert type="error" onDismiss={() => setErr('')}>{err}</InlineAlert>}
      {notice && <InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert>}

      {/* ⑤ 看板：本会话已发起的编排 / 团队任务与进度 */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-caption text-text2">{t('assistant.publish.boardTitle')}</h3>
          {/* 走 ui/Button 原语：裸 <button> 受 ui-conventions 棘轮约束（只减不增） */}
          <Button variant="ghost" size="xs" onClick={() => loadRuns()}>
            {t('assistant.publish.boardRefresh')}
          </Button>
        </div>
        {!threadId && <p className="text-caption text-text2">{t('assistant.publish.boardNoThread')}</p>}
        {threadId && runs.length === 0 && <p className="text-caption text-text2">{t('assistant.publish.boardEmpty')}</p>}
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.runId} className="border border-border rounded-xl px-3 py-2 bg-raise space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm truncate" title={r.goal}>{r.goal || t('assistant.publish.boardUntitled')}</span>
                <span className={`text-caption shrink-0 ${r.status === 'failed' ? 'text-danger' : 'text-text2'}`}>
                  {t(STATUS_KEY[r.status] || 'publish.statusUnknown', { status: r.status })}
                </span>
              </div>
              <div className="text-caption text-text2 flex flex-wrap items-center gap-2">
                {r.teamName && <span>{r.teamName}</span>}
                <span>{t('assistant.publish.boardTaskCount', { n: r.tasks.length })}</span>
                {r.waves > 1 && <span>{t('assistant.publish.boardWaves', { n: r.waves })}</span>}
                {r.createdAt > 0 && <span>{new Date(r.createdAt).toLocaleString()}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
