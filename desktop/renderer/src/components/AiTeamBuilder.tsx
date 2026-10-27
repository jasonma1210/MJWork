// AI 建团（设计文档 §7.4 路径② / §9 P0-5）
//
// 交互形态（对标修正后的结论）：**不是一张大表单**，而是「一句话输入 + 草案卡片逐条采纳/编辑/否决」。
//   ① 用户输入需求（自然语言，一句话即可）；
//   ② 调 `teams:draftTeam`（**只出草稿不落库**；契约见设计文档 §8.2）——
//      草案含 N 个成员 + 覆盖度报告（CoverageReport）；
//   ③ 每张成员卡片显示「来源（目录匹配 / 模型生成）」「匹配度」「为何选它」，逐条操作；
//   ④ 确认后**复用既有** `teams:recruit` / `teams:addCustomMember` 落库（不新增落库通道）。
//
// 三个必须守住的纪律：
//   · 草案阶段**不落库**：成员只到主进程返回为止，用户否决的一律不写；
//   · 覆盖度缺口必须**看得见**（需求提到联网查证、草案里没人有 web 工具 ⇒ 必须提示，
//     否则「AI 组了一支能干活的车队」就退化成「AI 写了几段角色设定」）；
//   · 编辑单个成员**下钻复用既有** `TeamMemberModal.tsx`（不重写成员表单）。
//
// ⚠ `teams:draftTeam` 的主进程实现由另一条工作流落地（设计文档 §9 P1-5/P1-7）。
//   本组件**不造假实现**：桥未就绪时给出可读的错误提示，而不是回退到假数据。
import { useCallback, useEffect, useMemo, useState } from 'react';
import InlineAlert from './InlineAlert';
import Button from './ui/Button';
import MemberModal from './TeamMemberModal';
import { IconBot, IconCheck, IconPlus, IconUsers, IconX } from './icons';
import { useI18n } from '../i18n';

// ── 主进程契约（`main/ipc/teamsDraft.js` 实际返回结构；设计文档 §8.2 同源）──
// 注意：成员对象是 `normalizeMemberInput` 归一后的形态 ⇒ 审批档字段名是 `approvalMode`
// （不是 §8.2 草案里的 `approvalPolicy`），工具是 `toolNames` + 抽象别名 `tools` 两份。
interface MemberDraft {
  name?: string;
  roleKind?: 'lead' | 'member';
  systemPrompt?: string;
  /** 抽象工具别名（read/write/edit/bash/grep/glob/web/browser）——主进程下发的展示用清单 */
  tools?: string[];
  /** 归一后的真实工具名（落库走这个字段） */
  toolNames?: string[];
  allowMcp?: boolean;
  model?: string | null;
  approvalMode?: string;
  sandboxPolicy?: string;
  skillNames?: string[];
  source?: 'template' | 'custom';
  templateRef?: string | null;
  /** 目录匹配分 0~1；自由生成的成员为 null */
  matchScore?: number | null;
  /**
   * 「为何选它」：主进程下发的是 `role`（模型给的一句话职责），
   * 不是独立理由字段——设计文档 §8.2 的 MemberDraft 未定义理由字段，
   * 这里按 `role` 渲染，并保留 `reason` 作前向兼容。
   */
  role?: string;
  reason?: string;
  employeeMatched?: boolean;
  capabilities?: Record<string, boolean>;
}

interface CoverageReport {
  covered?: string[];
  missing?: string[];
  warnings?: string[];
  sufficient?: boolean;
}

interface TeamDraft {
  name?: string;
  description?: string;
  members?: MemberDraft[];
  coverage?: CoverageReport;
}

interface TeamSummary {
  id: string;
  name: string;
  description?: string;
  archivedAt?: string | null;
}

type CardStatus = 'pending' | 'accepted' | 'rejected' | 'edited';

interface DraftCard {
  key: string;
  draft: MemberDraft;
  status: CardStatus;
  /** 已落库的成员 id（status='edited' 时有值：编辑走既有成员表单，当场落库） */
  memberId?: string | null;
}

const SIZE_MIN = 1;
const SIZE_MAX = 8;

export default function AiTeamBuilder({ onUseTeam }: {
  /**
   * 「用这个团队派活」出口（2026-10-27）。
   * 建团页只产出**编制**，不派活 —— 派活统一由派活面板发出（用户反馈：三个 Tab
   * 各自都有"发布"，不知道哪个才算真正发出去）。
   */
  onUseTeam?: (teamId: string) => void;
} = {}) {
  const { t } = useI18n();
  const [requirement, setRequirement] = useState('');
  const [size, setSize] = useState(3);
  /** 目标军团：'' = 本次新建（确认/编辑时创建）；否则 = 已有军团 id */
  const [target, setTarget] = useState('');
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [draft, setDraft] = useState<TeamDraft | null>(null);
  const [cards, setCards] = useState<DraftCard[]>([]);
  const [savedTeamId, setSavedTeamId] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  /** 成员表单下钻（复用既有 TeamMemberModal）：{ cardKey, teamId, before } */
  const [editing, setEditing] = useState<{ cardKey: string; teamId: string; before: string[] } | null>(null);

  const loadTeams = useCallback(async () => {
    try {
      const r = (await window.mjcode?.teamsList?.({})) as { ok?: boolean; teams?: TeamSummary[] } | undefined;
      setTeams((r?.teams || []).filter((x) => !x.archivedAt));
    } catch { /* 列表取不到：目标选择器留空，不阻塞草案生成 */ }
  }, []);

  useEffect(() => { loadTeams(); }, [loadTeams]);

  const bridgeReady = typeof window.mjcode?.teamsDraftTeam === 'function';

  async function generate() {
    const req = String(requirement || '').trim();
    if (!req) { setErr(t('assistant.aiTeam.requirementRequired')); return; }
    if (!bridgeReady) { setErr(t('assistant.aiTeam.draftUnavailable')); return; }
    setBusy('draft'); setErr(''); setNotice('');
    try {
      const r = (await window.mjcode?.teamsDraftTeam?.({
        requirement: req,
        size: Math.min(SIZE_MAX, Math.max(SIZE_MIN, Number(size) || 3)),
        preferCatalog: true,
        teamId: target || undefined,
      })) as { ok?: boolean; draft?: TeamDraft; error?: string } | undefined;
      if (!r?.ok || !r.draft) {
        setErr(t('assistant.aiTeam.draftFailed', { msg: r?.error || '' }));
        return;
      }
      setDraft(r.draft);
      setCards((r.draft.members || []).map((m, i) => ({ key: `m${i}`, draft: m, status: 'pending' })));
      setNotice(t('assistant.aiTeam.draftReady', { n: (r.draft.members || []).length }));
    } catch (e) {
      setErr(t('assistant.aiTeam.draftFailed', { msg: String((e as Error)?.message || e) }));
    } finally {
      setBusy('');
    }
  }

  function setCardStatus(key: string, status: CardStatus) {
    setCards((prev) => prev.map((c) => (c.key === key ? { ...c, status } : c)));
  }

  /** 目标军团 id：已有目标直接用；本次新建则先建团（成员落库通道以 teamId 为准） */
  async function ensureTeam(): Promise<string | null> {
    if (target) return target;
    const api = window.mjcode;
    if (!api?.teamsCreate) { setErr(t('assistant.aiTeam.teamCreateFailed', { msg: '' })); return null; }
    const name = String(draft?.name || requirement || '').trim().slice(0, 60);
    const description = String(draft?.description || requirement || '').trim().slice(0, 500);
    if (!name || !description) { setErr(t('assistant.aiTeam.teamFieldsRequired')); return null; }
    try {
      const r = (await api.teamsCreate({ name, description })) as { ok?: boolean; team?: { id?: string }; error?: string } | undefined;
      if (!r?.ok || !r.team?.id) {
        setErr(t('assistant.aiTeam.teamCreateFailed', { msg: r?.error || '' }));
        return null;
      }
      setTarget(r.team.id);
      await loadTeams();
      return r.team.id;
    } catch (e) {
      setErr(t('assistant.aiTeam.teamCreateFailed', { msg: String((e as Error)?.message || e) }));
      return null;
    }
  }

  /** 下钻编辑：复用既有成员表单（TeamMemberModal 的 custom 模式），不重写成员表单 */
  async function openEditor(card: DraftCard) {
    setErr('');
    const teamId = await ensureTeam();
    if (!teamId) return;
    let before: string[] = [];
    try {
      const g = (await window.mjcode?.teamsGet?.(teamId)) as { ok?: boolean; team?: { members?: Array<{ id: string }> } } | undefined;
      before = (g?.team?.members || []).map((m) => String(m.id));
    } catch { /* 名册取不到：编辑后按「新增成员」判定即可 */ }
    setEditing({ cardKey: card.key, teamId, before });
  }

  /** 成员表单关闭后：比对名册差集，把新增成员标记为「已编辑并落库」 */
  async function onEditorChanged() {
    const ctx = editing;
    if (!ctx) return;
    try {
      const g = (await window.mjcode?.teamsGet?.(ctx.teamId)) as { ok?: boolean; team?: { members?: Array<{ id: string; name?: string }> } } | undefined;
      const members = g?.team?.members || [];
      const added = members.filter((m) => !ctx.before.includes(String(m.id)));
      const first = added[0];
      setCards((prev) => prev.map((c) => (
        c.key === ctx.cardKey && first
          ? { ...c, status: 'edited', memberId: String(first.id), draft: { ...c.draft, name: first.name || c.draft.name } }
          : c
      )));
      if (added.length) setNotice(t('assistant.aiTeam.memberEdited', { n: added.length }));
    } catch { /* 名册比对失败：卡片保持原状态，用户仍可确认落库 */ }
  }

  async function confirmDraft() {
    const pending = cards.filter((c) => c.status === 'accepted');
    if (!pending.length) { setErr(t('assistant.aiTeam.nothingAccepted')); return; }
    setBusy('save'); setErr(''); setNotice('');
    const teamId = await ensureTeam();
    if (!teamId) { setBusy(''); return; }
    let saved = 0;
    const failed: string[] = [];
    for (const c of pending) {
      const d = c.draft;
      try {
        const r = ((d.source === 'template' && d.templateRef)
          ? await window.mjcode?.teamsRecruit?.({ teamId, employeeId: d.templateRef })
          : await window.mjcode?.teamsAddCustomMember?.({
            teamId,
            name: d.name || '',
            roleKind: d.roleKind === 'lead' ? 'lead' : 'member',
            systemPrompt: d.systemPrompt || '',
            toolNames: d.toolNames || d.tools || [],
            allowMcp: d.allowMcp === true,
            model: d.model || null,
            approvalMode: d.approvalMode,
            sandboxPolicy: d.sandboxPolicy,
            skillNames: d.skillNames || [],
          })) as { ok?: boolean; error?: string } | undefined;
        if (r?.ok) saved += 1;
        else failed.push(String(r?.error || ''));
      } catch (e) {
        failed.push(String((e as Error)?.message || e));
      }
    }
    setBusy('');
    if (failed.length) {
      setErr(t('assistant.aiTeam.savePartial', { ok: saved, bad: failed.length }));
      setNotice(failed.filter(Boolean).join(' / '));
    } else {
      setNotice(t('assistant.aiTeam.saved', { n: saved }));
      setSavedTeamId(teamId);
      setCards((prev) => prev.map((c) => (c.status === 'accepted' ? { ...c, status: 'edited' } : c)));
    }
  }

  const coverage = draft?.coverage;
  const acceptedCount = useMemo(() => cards.filter((c) => c.status === 'accepted' || c.status === 'edited').length, [cards]);

  return (
    <div className="max-w-3xl mx-auto px-6 py-5 space-y-4">
      <header className="space-y-1">
        <h2 className="text-sm font-medium flex items-center gap-2"><IconBot size={15} /> {t('assistant.aiTeam.title')}</h2>
        <p className="text-caption text-text2 leading-relaxed">{t('assistant.aiTeam.subtitle')}</p>
      </header>

      {/* ① 一句话输入 */}
      <div className="space-y-2">
        <textarea
          className="w-full bg-raise border border-border rounded-xl px-3 py-2 text-sm outline-none focus:border-accent"
          rows={3}
          placeholder={t('assistant.aiTeam.requirementPlaceholder')}
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
        />
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-caption text-text2">
            {t('assistant.aiTeam.sizeLabel')}
            <input
              type="number"
              min={SIZE_MIN}
              max={SIZE_MAX}
              className="w-16 bg-raise border border-border rounded px-2 py-1 text-xs"
              value={size}
              onChange={(e) => setSize(Number(e.target.value) || SIZE_MIN)}
            />
          </label>
          <label className="flex items-center gap-2 text-caption text-text2">
            {t('assistant.aiTeam.targetLabel')}
            <select
              className="bg-raise border border-border rounded px-2 py-1 text-xs max-w-[240px]"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">{t('assistant.aiTeam.targetNew')}</option>
              {teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <Button variant="primary" size="sm" loading={busy === 'draft'} onClick={generate}>
            <IconBot size={13} /> {t('assistant.aiTeam.generate')}
          </Button>
        </div>
        {!bridgeReady && (
          <div className="border border-warn rounded-lg px-3 py-2 text-xs text-warn bg-warn-bg leading-relaxed" role="alert">
            {t('assistant.aiTeam.draftUnavailable')}
          </div>
        )}
      </div>

      {err && <InlineAlert type="error" onDismiss={() => setErr('')}>{err}</InlineAlert>}
      {notice && <InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert>}

      {/* ② 覆盖度报告（缺口必须看得见） */}
      {coverage && (
        <section className="border border-border rounded-xl px-3 py-2 space-y-1">
          <div className="text-caption font-medium">{t('assistant.aiTeam.coverageTitle')}</div>
          <div className="text-caption text-text2">
            {t('assistant.aiTeam.coverageCovered', { list: (coverage.covered || []).join(t('assistant.listSep')) || '—' })}
          </div>
          {(coverage.missing || []).length > 0 && (
            <div className="text-caption text-warn">
              {t('assistant.aiTeam.coverageMissing', { list: (coverage.missing || []).join(t('assistant.listSep')) })}
            </div>
          )}
          {(coverage.warnings || []).map((w, i) => (
            <div key={i} className="text-caption text-warn leading-relaxed">{w}</div>
          ))}
          {coverage.sufficient === false && (
            <div className="border border-warn rounded-lg px-3 py-2 text-xs text-warn bg-warn-bg leading-relaxed" role="alert">
              {t('assistant.aiTeam.coverageInsufficient')}
            </div>
          )}
        </section>
      )}

      {/* ③ 草案卡片 */}
      {cards.length > 0 && (
        <section className="space-y-2">
          <div className="text-caption text-text2">
            {t('assistant.aiTeam.cardsTitle', { n: cards.length, ok: acceptedCount })}
          </div>
          {cards.map((c) => (
            <article key={c.key} className={`border rounded-xl px-3 py-2 space-y-1 ${c.status === 'rejected' ? 'border-border opacity-60' : 'border-border'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <IconUsers size={13} className="text-text2 shrink-0" />
                <span className="text-sm font-medium truncate">{c.draft.name || t('assistant.aiTeam.unnamedMember')}</span>
                <span className="text-caption px-2 rounded bg-raise text-text2">
                  {c.draft.source === 'template' ? t('assistant.aiTeam.sourceTemplate') : t('assistant.aiTeam.sourceCustom')}
                </span>
                {typeof c.draft.matchScore === 'number' && (
                  <span className="text-caption text-text2 tabular-nums">
                    {t('assistant.aiTeam.matchScore', { n: Math.round(c.draft.matchScore * 100) })}
                  </span>
                )}
                <span className="ml-auto" />
                {c.status === 'pending' && (
                  <>
                    <Button variant="accent-ghost" size="xs" onClick={() => setCardStatus(c.key, 'accepted')}>
                      <IconCheck size={11} /> {t('assistant.aiTeam.accept')}
                    </Button>
                    <Button variant="secondary" size="xs" onClick={() => openEditor(c)}>
                      {t('assistant.aiTeam.edit')}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => setCardStatus(c.key, 'rejected')}>
                      <IconX size={11} /> {t('assistant.aiTeam.reject')}
                    </Button>
                  </>
                )}
                {c.status === 'accepted' && (
                  <Button variant="ghost" size="xs" onClick={() => setCardStatus(c.key, 'pending')}>
                    {t('assistant.aiTeam.undoAccept')}
                  </Button>
                )}
                {c.status === 'rejected' && (
                  <Button variant="ghost" size="xs" onClick={() => setCardStatus(c.key, 'pending')}>
                    {t('assistant.aiTeam.undoReject')}
                  </Button>
                )}
                {c.status === 'edited' && (
                  <span className="text-caption text-success">{t('assistant.aiTeam.alreadySaved')}</span>
                )}
              </div>
              <div className="text-caption text-text2 leading-relaxed">
                {c.draft.role || c.draft.reason || t('assistant.aiTeam.noReason')}
              </div>
              {(c.draft.toolNames || c.draft.tools || []).length > 0 && (
                <div className="text-caption text-text2">
                  {t('assistant.aiTeam.toolsLabel', { list: (c.draft.toolNames || c.draft.tools || []).join(t('assistant.listSep')) })}
                </div>
              )}
            </article>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" loading={busy === 'save'} onClick={confirmDraft}>
              <IconPlus size={13} /> {t('assistant.aiTeam.confirm')}
            </Button>
            {/* 落库之后才有下一步：把用户送到派活面板并预选这个团队。
                建团页本身不发任务 —— 否则页面上又会出现第二个"发布"。 */}
            {savedTeamId && onUseTeam && (
              <Button variant="secondary" size="sm" onClick={() => onUseTeam(savedTeamId)}>
                {t('assistant.aiTeam.useTeam')}
              </Button>
            )}
            <span className="text-caption text-text2">{t('assistant.aiTeam.confirmHint')}</span>
          </div>
        </section>
      )}

      {/* ④ 成员表单下钻（复用既有 TeamMemberModal，不重写成员表单） */}
      {editing && (
        <MemberModal
          teamId={editing.teamId}
          mode="custom"
          t={t}
          onClose={() => setEditing(null)}
          onChanged={onEditorChanged}
        />
      )}
    </div>
  );
}
