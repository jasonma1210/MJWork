//
// 页面职责（只做「编制」，不做派活——派活属 T5-4 的对话 `+` 军团栏位）：
//   · 团队卡片列表（军团全局可见；不再按项目过滤、不再提供归档入口）
//   · 新建团队（必填 name + description；projectPath 为可选的「工作目录」下拉）
//   · 两个等效的成员入口（D3：同一张编制表）：生态中心「招募」/ 自定义描述
//   · 自定义创建走「AI 生成角色草稿 → 展示能力摘要 → 人审后落库」（草稿不落库，见 ipc/teams.js）
//   · 招募弹窗内实时显示成员标签（2026-10-20 需求③）：招募后不关窗、可连续添加，上限由主进程下发
//   · 多成员后显示温和「缺统筹」标签（不弹窗、不阻塞；强校验留到首次派活）
//   · 指定统筹负责人（全局唯一）
//
// 数据通道：main/ipc/teams.js 的 teams:* 桥（preload 已注册）。桥签名是「位置参数」风格
// （teamsGet(teamId) / teamsSetLead(teamId, memberId) 等），与 lib/ipc.js 的单载荷 call()
// 契约不同，故此处直连 window.mjcode.teams*（与 ScheduledTasks 直连 scheduled* 同例）。
import { useCallback, useEffect, useRef, useState } from 'react';
import InlineAlert from './InlineAlert';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { confirm } from './feedback';
import { useI18n } from '../i18n';
// T5-6：消息展示口径与对话内团队事件流共用（单一事实来源，见 shared/teamLabels.mjs）
import { kindKey, messageText } from '../../../shared/teamLabels.mjs';
// T5-7：成员模型绑定选择器与选项推导（独立文件，见其头部注释的「只认 id」纪律）
import MemberModelSelect, { toModelOptions, type ModelOption, type ProviderLike } from './MemberModelSelect';
// 2026-10-20 需求③：招募/自定义「加成员」弹窗已外迁为独立文件（守住单文件行数阈值）；
// 同时复用其导出的 Field（建队表单必填标记）与 initial（成员头像首字）——同形态只此一份实现。
import MemberModal, { Field, initial } from './TeamMemberModal';
// 2026-10-21 团队调试日志：把「任务无人认领 / 看板完成但无产出」的全链路事实导出给开发者
import TeamDebugPanel from './TeamDebugPanel';

type TFunc = (key: string, params?: Record<string, string | number>) => string;

interface TeamMember {
  id: string;
  name: string;
  roleKind: string;
  source: string;
  toolNames?: string[];
  // 在册标记（软删为 false）：编制展示与招募上限只统计在册成员
  enabled?: boolean;
  // T5-7：per-agent 模型绑定——`model` 是落库的**引用串**，渲染层不解析其格式；
  // `modelRef`/`modelLabel` 由主进程解析后下发，渲染层只做回显与选择（格式只有一份实现）。
  model?: string | null;
  modelRef?: { providerId: string; modelId: string } | null;
  modelLabel?: string | null;
}
interface Team {
  id: string;
  name: string;
  description: string;
  projectPath: string;
  archivedAt?: string | null;
  leadMissing?: boolean;
  memberCount?: number;
  members?: TeamMember[];
  // 2026-10-21：团队级预算（派活缺省来源）。max_tokens 是软上限，用户可在团队卡片里调整。
  budget?: { max_tokens?: number; max_rounds?: number; max_wall_ms?: number } | null;
}
interface CreateForm { name: string; description: string; projectPath: string; }
interface MemberModalState { teamId: string; teamName: string; mode: 'recruit' | 'custom'; }

// ── T5-7：成员模型绑定的选择项 ──
// 渲染层只认 {providerId, modelId} 这对 id（与主进程 modelShape 的引用串格式解耦：
// 界面永不自己拼 `providerId::modelId`，否则格式就有第二份实现，漂移时表现为静默不生效）。
// 定义与选择器本体在 MemberModelSelect.tsx（独立文件，避免本页突破 800 行 God File 黄线）。

// T5-2 消息总线：一条总线消息（只传摘要 + 引用，体积超限时后端回落 refs-only，summary 被截断）
interface TeamMessage {
  id: string;
  teamId: string;
  runId?: string;
  seq: number;
  fromMemberId?: string | null;
  toMemberId?: string | null;
  kind: string;
  summary: string;
  refs?: string[];
  payload?: { sys?: string; name?: string } | null;
  createdAt?: number;
}
interface TeamsEventData { type?: string; message?: TeamMessage; }

// 消息种类 / 系统留痕的展示口径（KIND_LABEL / SYS_LABEL / kindKey / messageText）
// 已收敛到 shared/teamLabels.mjs：团队详情页与对话内团队事件流共用一份，
// 避免新增一种系统留痕时只改一处、另一处显示裸 key。

// 审批档 / 沙箱档 / 能力摘要位 → i18n key 的映射，与「成员头像首字」一并外迁至 TeamMemberModal.tsx
//（加成员弹窗的草稿摘要才需要它们；本页只保留消息总线相关的展示口径）。

// ── 军团全局可见（2026-10-20 用户反馈修正）──
// 原 D1「团队按项目归属、切项目各看各的」已被推翻：军团是跨项目复用的编制，
// 本页不再接收 project prop、不再按 project_path 过滤，也不再给新建表单预填归属项目
//（那是用户看到的「默认直接给我绑定了一个」）。team.projectPath 降级为可选的「工作目录」。
export default function TeamsPage() {
  const { t } = useI18n();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  // 新建弹窗的**就地**错误（2026-10-20 需求①）：此前校验失败只写页面级 error，
  // 而 Modal 盖在页面上，用户点「创建」看不到任何反馈——表现为「点了没反应」。
  const [createErr, setCreateErr] = useState('');
  // 工作目录候选（2026-10-20 需求②）：本机打开过的项目，listProjects 已按 lastOpenedAt 倒序
  //（= 使用频率从高到低）；已删除的项目被物理移除，不会出现在候选里，无需额外过滤。
  const [projects, setProjects] = useState<Array<{ path: string; name: string }>>([]);
  // 弹窗：null=关；{name,description,projectPath}=新建；{teamId,mode:'recruit'|'custom'}=加成员
  const [createForm, setCreateForm] = useState<CreateForm | null>(null);
  const [memberModal, setMemberModal] = useState<MemberModalState | null>(null);
  // T5-2：总线时间轴（按团队聚合，按 seq 升序）+ 展开状态
  const [timeline, setTimeline] = useState<Record<string, TeamMessage[]>>({});
  const [msgOpen, setMsgOpen] = useState<Record<string, boolean>>({});
  // T5-7：成员模型绑定选择项（本机供应商）。取不到时只显示「默认模型」，不阻塞其余编制操作
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  // 2026-10-21：团队调试日志面板开关（排查用，默认关闭，不影响正常编制操作）
  const [debugOpen, setDebugOpen] = useState(false);
  // 团队预算编辑（2026-10-21 用户裁决：默认 256k 且用户可自己调）
  const [budgetTeam, setBudgetTeam] = useState<{ id: string; name: string; tokens: string; rounds: string } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = (await window.mjcode?.localProviders?.()) as ProviderLike[] | undefined;
        if (alive) setModelOptions(toModelOptions(list));
      } catch { /* 供应商列表不可用：选择器仅存「默认模型」一项 */ }
    })();
    return () => { alive = false; };
  }, []);

  // 工作目录候选（2026-10-20 需求②）：本机项目列表——顺序即主进程的 lastOpenedAt 倒序，
  // 渲染层不再排序（排序是 listProjects 的单一事实来源，另排一份会导致口径漂移）。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = (await window.mjcode?.localProjects?.()) as Array<{ path?: string; name?: string }> | undefined;
        if (!alive || !Array.isArray(list)) return;
        setProjects(list.filter((p) => p?.path).map((p) => ({ path: String(p.path), name: String(p.name || p.path) })));
      } catch { /* 项目列表不可用：下拉仅保留「留空＝全局团队」一项，不阻塞建队 */ }
    })();
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    const api = window.mjcode;
    if (!api?.teamsList) { setError(t('teams.loadFailed')); setLoading(false); return; }
    setLoading(true);
    try {
      // 军团全局可见：不再传 projectPath；归档入口已移除（2026-10-20 需求④），故不传 includeArchived
      const r = (await api.teamsList({})) as
        { ok?: boolean; teams?: Team[]; error?: string } | undefined;
      if (r?.ok) setTeams(r.teams || []);
      else setError(r?.error || t('teams.loadFailed'));
    } catch (err) {
      setError((err as Error).message || t('teams.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  // 2026-10-28（用户裁决「默认模型取消，默认就是模型列表第一个」）：
  // 给所有未绑定模型的在册成员**自动绑定模型列表第一项**。为什么做迁移而不是只改回显：
  // MemberModelSelect 若显示第一项而成员实际没绑定，运行期仍跑会话默认模型 ——
  // 正是该组件头注释警惕的「界面显示已绑定、实际跑默认模型」静默错位；显示即事实。
  // ref 防重入（bind→load→effect 再跑时 targets 已空，天然收敛）；失败不阻塞页面。
  const modelMigrating = useRef(false);
  useEffect(() => {
    if (modelMigrating.current || !modelOptions.length || !teams.length) return;
    const first = modelOptions[0];
    const targets: Array<{ teamId: string; memberId: string }> = [];
    for (const team of teams) {
      for (const m of (team.members || [])) {
        if (m.enabled === false) continue;
        if (!m.modelRef && !m.model) targets.push({ teamId: team.id, memberId: m.id });
      }
    }
    if (!targets.length) return;
    modelMigrating.current = true;
    (async () => {
      try {
        for (const x of targets) {
          await window.mjcode?.teamsUpdateMember(x.teamId, x.memberId, {
            model: { providerId: first.providerId, modelId: first.modelId },
          });
        }
      } catch { /* 迁移失败不阻塞编制操作：成员回落会话默认模型，选择器可手改 */ }
      finally {
        modelMigrating.current = false;
        await load();
      }
    })();
  }, [teams, modelOptions, load]);

  // 幂等追加：按 id 去重（历史与事件可能重叠），按 seq 升序（团队内单调 = 顺序单一事实来源）
  const addMessage = useCallback((msg: TeamMessage) => {
    if (!msg || !msg.teamId || !msg.id) return;
    setTimeline((prev) => {
      const list = prev[msg.teamId] || [];
      if (list.some((m) => m.id === msg.id)) return prev;
      return { ...prev, [msg.teamId]: [...list, msg].sort((a, b) => a.seq - b.seq) };
    });
  }, []);

  // 事件契约订阅：消息落库后主进程广播 teams:event，这里实时追加（无需轮询）
  useEffect(() => {
    const mj = window.mjcode;
    if (!mj?.onTeamsEvent) return undefined;
    const off = mj.onTeamsEvent((data: unknown) => {
      const d = data as TeamsEventData;
      if (d?.type === 'team_message' && d.message) addMessage(d.message);
    }) as (() => void) | undefined;
    return () => off?.();
  }, [addMessage]);

  // 展开时首次拉历史（之后靠事件增量）；合并时仍按 id 去重防重复
  async function toggleMessages(teamId: string) {
    const open = !msgOpen[teamId];
    setMsgOpen((prev) => ({ ...prev, [teamId]: open }));
    if (!open || timeline[teamId]) return;
    try {
      const r = (await window.mjcode?.teamsListMessages({ teamId })) as
        { ok?: boolean; messages?: TeamMessage[] } | undefined;
      if (!r?.ok) return;
      setTimeline((prev) => {
        const merged = [...(prev[teamId] || []), ...(r.messages || [])];
        const seen = new Set<string>();
        const dedup = merged.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
        return { ...prev, [teamId]: dedup.sort((a, b) => a.seq - b.seq) };
      });
    } catch { /* 历史读取失败：保留空态，不阻塞页面 */ }
  }

  // ── 新建团队 ──
  // 2026-10-20 需求①：校验失败必须**在弹窗内**给出具体是哪个字段没填（此前只有页面级 error，
  // 被 Modal 遮住 → 用户以为按钮失效）。
  async function submitCreate() {
    const api = window.mjcode;
    const f = createForm || { name: '', description: '', projectPath: '' };
    if (!String(f.name || '').trim()) { setCreateErr(t('teams.nameRequired')); return; }
    if (!String(f.description || '').trim()) { setCreateErr(t('teams.descRequired')); return; }
    setBusy('create');
    setCreateErr('');
    try {
      const r = (await api?.teamsCreate({ name: f.name, description: f.description, projectPath: f.projectPath })) as
        { ok?: boolean; error?: string } | undefined;
      if (r?.ok) { setCreateForm(null); await load(); }
      else setCreateErr(t('teams.createFailed', { msg: r?.error || '' }));
    } catch (err) {
      setCreateErr(t('teams.createFailed', { msg: (err as Error).message }));
    } finally {
      setBusy('');
    }
  }

  // ── 团队预算（2026-10-21）：默认 256k tokens；max_tokens 为软上限，越界继续执行只告警 ──
  async function saveBudget() {
    if (!budgetTeam) return;
    const tokens = Number(budgetTeam.tokens);
    const rounds = Number(budgetTeam.rounds);
    if (!Number.isFinite(tokens) || tokens < 1000 || tokens > 2000000) { setError(t('teams.budgetInvalid')); return; }
    setBusy('budget');
    setError('');
    try {
      const patch = { budget: { max_tokens: Math.round(tokens), ...(Number.isFinite(rounds) && rounds > 0 ? { max_rounds: Math.round(rounds) } : {}) } };
      const r = (await window.mjcode?.teamsUpdate(budgetTeam.id, patch)) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) { setBudgetTeam(null); setNotice(t('teams.budgetSaved')); await load(); }
      else setError(t('teams.budgetSaveFailed', { msg: r?.error || '' }));
    } catch (err) {
      setError(t('teams.budgetSaveFailed', { msg: (err as Error).message }));
    } finally {
      setBusy('');
    }
  }

  // ── 指定统筹（单一判据落在主进程：lead_member_id；全局唯一，不能多人）──
  async function makeLead(teamId: string, memberId: string) {
    setBusy(`lead:${memberId}`);
    setError('');
    try {
      const r = (await window.mjcode?.teamsSetLead(teamId, memberId)) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) { setNotice(t('teams.leadSetNotice')); await load(); }
      else setError(t('teams.setLeadFailed', { msg: r?.error || '' }));
    } catch (err) {
      setError(t('teams.setLeadFailed', { msg: (err as Error).message }));
    } finally {
      setBusy('');
    }
  }

  // ── T5-7：成员模型绑定（null = 解绑，回落会话默认模型）──
  async function bindMemberModel(teamId: string, memberId: string, model: { providerId: string; modelId: string } | null) {
    setBusy(`model:${memberId}`);
    setError('');
    try {
      const r = (await window.mjcode?.teamsUpdateMember(teamId, memberId, { model })) as
        { ok?: boolean; error?: string } | undefined;
      if (r?.ok) await load();
      else setError(t('teams.modelBindFailed', { msg: r?.error || '' }));
    } catch (err) {
      setError(t('teams.modelBindFailed', { msg: (err as Error).message }));
    } finally {
      setBusy('');
    }
  }

  // ── 移出成员（软删：下架，可再启用）──
  async function removeMember(teamId: string, member: TeamMember) {
    const ok = await confirm({
      title: t('teams.removeMemberTitle'),
      message: t('teams.removeMemberMessage', { name: member.name }),
      danger: true,
      confirmLabel: t('teams.removeMember'),
    });
    if (!ok) return;
    setBusy(`remove:${member.id}`);
    setError('');
    try {
      const r = (await window.mjcode?.teamsRemoveMember(teamId, member.id)) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) await load();
      else setError(t('teams.removeFailed', { msg: r?.error || '' }));
    } catch (err) {
      setError(t('teams.removeFailed', { msg: (err as Error).message }));
    } finally {
      setBusy('');
    }
  }

  // ── T5-11：重置成员会话（§13.3「对话即容器，成员会话是隔离工作台」）──
  // 主进程一处完成「清 `agent:{memberId}` 断点 + 该成员私有记忆降权」；
  // 渲染层只负责二次确认（不可撤销的语义重置，必须显式确认）与结果提示。
  async function resetMemberSession(teamId: string, member: TeamMember) {
    const ok = await confirm({
      title: t('teams.resetSessionTitle'),
      message: t('teams.resetSessionMessage', { name: member.name }),
      confirmLabel: t('teams.resetSession'),
    });
    if (!ok) return;
    setBusy(`reset:${member.id}`);
    setError('');
    try {
      const r = (await window.mjcode?.teamsResetMemberSession?.(teamId, member.id)) as
        { ok?: boolean; error?: string; demoted?: number } | undefined;
      if (r?.ok) setNotice(t('teams.resetSessionNotice', { name: member.name }));
      else setError(t('teams.resetSessionFailed', { msg: r?.error || '' }));
    } catch (err) {
      setError(t('teams.resetSessionFailed', { msg: (err as Error).message }));
    } finally {
      setBusy('');
    }
  }

  const totalMembers = teams.reduce((n, x) => n + (x.memberCount || 0), 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 固定头部（shrink-0）：列表再长也不压缩头部 */}
      <div className="shrink-0 px-6 pt-6 pb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">{t('teams.title')}</h2>
          <p className="text-text2 text-xs mt-1">{t('teams.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* 调试日志（2026-10-21）：团队链路排查入口，导出 JSONL 事实流交给开发者 */}
          <Button variant="secondary" size="sm" onClick={() => setDebugOpen(true)}>
            {t('teams.debugButton')}
          </Button>
          <Button size="sm" onClick={() => { setCreateErr(''); setCreateForm({ name: '', description: '', projectPath: '' }); }}>
            {t('teams.newTeam')}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        {error && <div className="mb-3"><InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert></div>}
        {notice && <div className="mb-3"><InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert></div>}

        {loading && <div className="text-xs text-text2 py-8 text-center">{t('teams.loading')}</div>}

        {!loading && teams.length === 0 && (
          <div className="text-xs text-text2 py-10 text-center">{t('teams.empty')}</div>
        )}

        {!loading && teams.map((team) => (
          <TeamCard
            key={team.id}
            team={team}
            busy={busy}
            t={t}
            messages={timeline[team.id] || []}
            msgOpen={!!msgOpen[team.id]}
            onToggleMessages={() => toggleMessages(team.id)}
            onRecruit={() => { setError(''); setMemberModal({ teamId: team.id, teamName: team.name, mode: 'recruit' }); }}
            onCustom={() => { setError(''); setMemberModal({ teamId: team.id, teamName: team.name, mode: 'custom' }); }}
            onSetLead={(memberId: string) => makeLead(team.id, memberId)}
            onEditBudget={() => setBudgetTeam({
              id: team.id,
              name: team.name,
              tokens: String(team.budget?.max_tokens || 256000),
              rounds: team.budget?.max_rounds ? String(team.budget.max_rounds) : '',
            })}
            onRemove={(member: TeamMember) => removeMember(team.id, member)}
            onResetSession={(member: TeamMember) => resetMemberSession(team.id, member)}
            modelOptions={modelOptions}
            onBindModel={(member: TeamMember, model: { providerId: string; modelId: string } | null) =>
              bindMemberModel(team.id, member.id, model)}
          />
        ))}

        {!loading && teams.length > 0 && (
          <div className="text-caption text-text2 mt-2">{t('teams.memberCount', { n: totalMembers })}</div>
        )}
      </div>

      {createForm && (
        <Modal
          open
          onClose={() => { setCreateErr(''); setCreateForm(null); }}
          title={t('teams.formTitle')}
          size="md"
          footer={(
            <>
              <Button variant="secondary" size="md" onClick={() => { setCreateErr(''); setCreateForm(null); }}>{t('teams.cancel')}</Button>
              <Button size="md" loading={busy === 'create'} onClick={submitCreate}>{t('teams.create')}</Button>
            </>
          )}
        >
          <div className="space-y-3">
            {/* 弹窗内联错误（2026-10-20 需求①）：校验失败就地可见，不再「点了没反应」 */}
            {createErr && (
              <InlineAlert type="error" onDismiss={() => setCreateErr('')}>{createErr}</InlineAlert>
            )}
            <Field label={t('teams.nameLabel')} required>
              <input
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => (f ? { ...f, name: e.target.value } : f))}
                placeholder={t('teams.namePlaceholder')}
                maxLength={60}
                className="w-full h-8 px-3 rounded-lg bg-input text-sm"
              />
            </Field>
            <Field label={t('teams.descLabel')} required>
              <textarea
                value={createForm.description}
                onChange={(e) => setCreateForm((f) => (f ? { ...f, description: e.target.value } : f))}
                placeholder={t('teams.descPlaceholder')}
                rows={3}
                maxLength={500}
                className="w-full px-3 py-2 rounded-lg bg-input text-sm resize-none"
              />
            </Field>
            {/* 工作目录（2026-10-20 需求②）：可选——留空即全局团队；候选取本机已打开过的项目，
                按使用频率（lastOpenedAt 倒序）排列，已删除的项目不在候选内 */}
            <Field label={t('teams.projectLabel')} hint={t('teams.projectHint')}>
              <select
                value={createForm.projectPath}
                onChange={(e) => setCreateForm((f) => (f ? { ...f, projectPath: e.target.value } : f))}
                className="w-full h-8 px-3 rounded-lg bg-input text-sm"
              >
                <option value="">{t('teams.projectGlobalOption')}</option>
                {projects.map((p) => (
                  <option key={p.path} value={p.path}>{p.name}</option>
                ))}
              </select>
            </Field>
          </div>
        </Modal>
      )}

      {budgetTeam && (
        <Modal
          open
          onClose={() => setBudgetTeam(null)}
          title={t('teams.budgetTitle', { name: budgetTeam.name })}
          size="md"
          footer={(
            <>
              <Button variant="secondary" size="md" onClick={() => setBudgetTeam(null)}>{t('teams.cancel')}</Button>
              <Button size="md" loading={busy === 'budget'} onClick={saveBudget}>{t('teams.budgetSave')}</Button>
            </>
          )}
        >
          <div className="space-y-3">
            {error && <InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert>}
            <Field label={t('teams.budgetTokensLabel')} hint={t('teams.budgetTokensHint')} required>
              <input
                type="number"
                min={1000}
                max={2000000}
                step={1000}
                value={budgetTeam.tokens}
                onChange={(e) => setBudgetTeam((b) => (b ? { ...b, tokens: e.target.value } : b))}
                className="w-full h-8 px-3 rounded-lg bg-input text-sm"
              />
            </Field>
            <Field label={t('teams.budgetRoundsLabel')} hint={t('teams.budgetRoundsHint')}>
              <input
                type="number"
                min={1}
                max={50}
                value={budgetTeam.rounds}
                onChange={(e) => setBudgetTeam((b) => (b ? { ...b, rounds: e.target.value } : b))}
                placeholder="8"
                className="w-full h-8 px-3 rounded-lg bg-input text-sm"
              />
            </Field>
          </div>
        </Modal>
      )}

      {memberModal && (
        <MemberModal
          teamId={memberModal.teamId}
          mode={memberModal.mode}
          t={t}
          onClose={() => setMemberModal(null)}
          onChanged={async () => { await load(); }}
        />
      )}

      {/* 调试日志面板（2026-10-21）：独立弹窗，不参与编制流程的渲染与状态 */}
      <TeamDebugPanel open={debugOpen} onClose={() => setDebugOpen(false)} />
    </div>
  );
}

// ── 团队卡片（含成员编制）──
function TeamCard(props: {
  team: Team; busy: string; t: TFunc;
  messages: TeamMessage[]; msgOpen: boolean; onToggleMessages: () => void;
  onRecruit: () => void; onCustom: () => void;
  onSetLead: (memberId: string) => void; onRemove: (member: TeamMember) => void;
  onEditBudget: () => void;
  onResetSession: (member: TeamMember) => void;
  modelOptions: ModelOption[];
  onBindModel: (member: TeamMember, model: { providerId: string; modelId: string } | null) => void;
}) {
  const { team, busy, t, messages, msgOpen, onToggleMessages, onRecruit, onCustom, onSetLead, onRemove,
    onResetSession, modelOptions, onBindModel, onEditBudget } = props;
  return (
    <div className="bg-surface border border-border rounded-xl p-4 mb-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-medium truncate">{team.name}</div>
            {team.leadMissing && (
              <span title={t('teams.leadMissingHint')}
                className="shrink-0 text-caption px-2 rounded bg-warn-bg text-warn">
                {t('teams.leadMissing')}
              </span>
            )}
          </div>
          <div className="text-xs text-text2 mt-1 truncate">{team.description}</div>
          {/* 军团全局可见：projectPath 是可选的「工作目录」，为空时只显示成员数
              （此前无条件渲染 `${team.projectPath} · ...` 会出现「 · 3」这样以分隔符开头的残缺行） */}
          <div className="text-caption text-text2 mt-1 truncate">
            {team.projectPath ? `${team.projectPath} · ` : ''}
            {t('teams.memberCount', { n: team.memberCount || 0 })}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="ghost" size="xs" onClick={onEditBudget}>{t('teams.budgetButton')}</Button>
          <Button variant="secondary" size="xs" onClick={onRecruit}>{t('teams.recruit')}</Button>
          <Button variant="secondary" size="xs" onClick={onCustom}>{t('teams.customCreate')}</Button>
        </div>
      </div>

      <div className="mt-3">
        <div className="text-caption text-text2 mb-1">{t('teams.membersTitle')}</div>
        {(team.members || []).length === 0 && <div className="text-xs text-text2 py-2">{t('teams.noMembers')}</div>}
        {(team.members || []).map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 border-t border-border py-2">
            <div className="flex items-center gap-2 min-w-0">
              {/* 头像配色（2026-10-20 需求③）：统筹 = 红，其余成员 = 绿（同一套语义色 token，非裸色） */}
              <span className={`w-6 h-6 shrink-0 rounded-full text-xs flex items-center justify-center ${
                m.roleKind === 'lead' ? 'bg-danger-bg text-danger' : 'bg-success-bg text-success'
              }`}>
                {initial(m.name)}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm truncate">{m.name}</span>
                  {m.roleKind === 'lead' && (
                    <span className="shrink-0 text-caption px-2 rounded bg-select-bg text-select-fg">{t('teams.leadTag')}</span>
                  )}
                  <span className="shrink-0 text-caption text-text2">
                    {m.source === 'template' ? t('teams.sourceTemplate') : t('teams.sourceCustom')}
                  </span>
                  {/* P0-2：成员实时状态（空闲/忙碌/等待中/离线），由引擎 FSM 经 setMemberState 写入，UI 仅展示 */}
                  <span className="shrink-0 text-caption px-2 rounded bg-border/40 text-text2">
                    {t(`teams.state${m.state ? m.state.charAt(0).toUpperCase() + m.state.slice(1) : 'Idle'}`)}
                  </span>
                </div>
                <div className="text-caption text-text2 truncate">
                  {t('teams.toolsLabel', { tools: (m.toolNames || []).join(' · ') || '—' })}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* T5-7：成员模型绑定（空选项 = 用会话默认模型） */}
              <MemberModelSelect
                member={m}
                options={modelOptions}
                t={t}
                busy={busy === `model:${m.id}`}
                onChange={(model) => onBindModel(m, model)}
              />
              {m.roleKind !== 'lead' && (
                <Button variant="ghost" size="xs" loading={busy === `lead:${m.id}`} title={t('teams.setLeadTip')} onClick={() => onSetLead(m.id)}>
                  {t('teams.setLead')}
                </Button>
              )}
              {/* T5-11：重置该成员工作台（清断点 + 私有记忆降权）；二次确认在页面层 */}
              <Button variant="ghost" size="xs" loading={busy === `reset:${m.id}`} onClick={() => onResetSession(m)}>
                {t('teams.resetSession')}
              </Button>
              <Button variant="danger-ghost" size="xs" loading={busy === `remove:${m.id}`} onClick={() => onRemove(m)}>
                {t('teams.removeMember')}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* T5-2 消息总线时间轴（默认收起，展开后按 seq 升序展示） */}
      <div className="mt-3 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption text-text2">
            {t('teams.messagesTitle')}{messages.length > 0 ? ` · ${messages.length}` : ''}
          </span>
          <Button variant="ghost" size="xs" onClick={onToggleMessages}>
            {msgOpen ? t('teams.hideMessages') : t('teams.showMessages')}
          </Button>
        </div>
        {msgOpen && messages.length === 0 && (
          <div className="text-xs text-text2 py-2">{t('teams.messagesEmpty')}</div>
        )}
        {msgOpen && messages.map((m) => (
          <div key={m.id} className="flex items-start gap-2 border-t border-border py-2">
            <span className="shrink-0 text-caption px-2 rounded bg-input text-text2">{t(kindKey(m.kind))}</span>
            <span className="text-xs text-text2 break-words min-w-0">{messageText(t, m)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
