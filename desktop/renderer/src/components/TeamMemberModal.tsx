//
// 军团「加成员」弹窗（2026-10-20 需求③，从 TeamsPage.tsx 抽出以守住单文件行数阈值）。
//
// 两种模式同一弹窗：
//   · recruit：从生态中心招募数字员工（可搜索；右上角「新建员工」复用生态中心员工表单）；
//   · custom ：自定义描述 → AI 生成角色草稿 → 人审能力摘要后落库。
//
// 关键形态（需求③）：
//   · 招募/加入成功后**不关窗**，成员以标签形式就地累积展示，用户可一直添加；
//   · 标签区头像配色：统筹 = 红（danger）、其余成员 = 绿（success）；
//   · 「设为统筹」全局唯一（主进程 setLead 保证），故标签上只给非统筹成员该入口；
//   · 成员上限（MAX_MEMBERS_PER_TEAM）由主进程经 teams:get 下发 maxMembers，渲染层只做展示与预检，
//     不存第二份判据（避免「界面写 20、后端拒在 8」的两份实现漂移）。
//   · 「新建员工」保存成功后自动刷新招募列表并**自动加入本团队**（新员工自动成为标签）。
//
// 本模块同时导出 `Field` / `initial` 两个小组件与工具函数：建队表单（必填标记）与团队卡片
// （成员头像首字）与本弹窗共用同一形态——集中在一处避免三份实现各写一遍。
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import InlineAlert from './InlineAlert';
import Modal from './ui/Modal';
import Button from './ui/Button';
import EmployeeFormModal from './EmployeeFormModal';

export type TFunc = (key: string, params?: Record<string, string | number>) => string;

interface TeamMember {
  id: string;
  name: string;
  roleKind: string;
  enabled?: boolean;
}
interface Team {
  id: string;
  members?: TeamMember[];
}
interface Employee {
  id: string;
  name?: string;
  title_cn?: string;
  category?: string;
}
interface MemberDraft {
  name?: string;
  systemPrompt?: string;
  toolNames?: string[];
  allowMcp?: boolean;
  model?: string;
  approvalMode?: string;
  sandboxPolicy?: string;
  skillNames?: string[];
  capabilities?: Record<string, boolean>;
}

// 审批档 / 沙箱档 → i18n key（顶层常量只存 key，渲染时经 t() 求值，切语言即时生效）
const APPROVAL_LABEL: Record<string, string> = {
  'on-request': 'teams.approvalOnRequest',
  'auto-safe': 'teams.approvalAutoSafe',
  always: 'teams.approvalAlways',
  trusted: 'teams.approvalTrusted',
};
const SANDBOX_LABEL: Record<string, string> = {
  'read-only': 'teams.sandboxReadOnly',
  'workspace-write': 'teams.sandboxWorkspaceWrite',
  'full-access': 'teams.sandboxFullAccess',
};

// 能力摘要布尔位 → i18n key（顺序即展示顺序）
const CAP_KEYS: Array<[string, string]> = [
  ['read', 'teams.capRead'],
  ['write', 'teams.capWrite'],
  ['execute', 'teams.capExecute'],
  ['search', 'teams.capSearch'],
  ['web', 'teams.capWeb'],
  ['browser', 'teams.capBrowser'],
];

// 成员头像位：编制里的 avatar 多为空，用名称首字兜底（无图片请求、无 emoji）
export function initial(name?: string): string {
  return String(name || '?').trim().slice(0, 1).toUpperCase();
}

// 表单字段外壳：label + 可选 hint + 控件
// required（2026-10-20 需求①）：在标签后渲染必填星号，让「为什么点创建没反应」在点击前就可读；
// 校验失败的具体原因仍由弹窗内联 InlineAlert 给出（此处只做静态标记，不承担校验逻辑）。
export function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <div className="text-caption text-text2 mb-1">
        {label}
        {required && <span className="text-danger ml-1">*</span>}
      </div>
      {children}
      {hint && <div className="text-caption text-text2 mt-1">{hint}</div>}
    </label>
  );
}

export default function MemberModal(props: {
  teamId: string; mode: 'recruit' | 'custom'; t: TFunc;
  onClose: () => void; onChanged: () => void | Promise<void>;
}) {
  const { teamId, mode, t, onClose, onChanged } = props;
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [empLoading, setEmpLoading] = useState(mode === 'recruit');
  const [keyword, setKeyword] = useState('');
  const [busy, setBusy] = useState('');
  // 弹窗内联错误：招募/自定义失败若只写页面级 error 会被 Modal 遮住（与需求①同一根因）
  const [err, setErr] = useState('');
  // 当前编制（标签区数据源）+ 成员上限（主进程下发，不在渲染层硬编码）
  const [roster, setRoster] = useState<TeamMember[]>([]);
  const [maxMembers, setMaxMembers] = useState(0);
  // 自定义流程：描述 → 草稿（null=未生成）
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<MemberDraft | null>(null);
  // 2026-10-20 需求①：「新建员工」弹窗（复用生态中心员工表单，保存后回填招募列表）
  const [employeeFormOpen, setEmployeeFormOpen] = useState(false);

  // 编制刷新：teams:get 是编制读取的唯一入口（含 leadMissing / maxMembers）
  const loadRoster = useCallback(async () => {
    try {
      const r = (await window.mjcode?.teamsGet(teamId)) as
        { ok?: boolean; team?: Team; maxMembers?: number } | undefined;
      if (r?.ok) {
        setRoster(((r.team?.members) || []).filter((m) => m.enabled !== false));
        if (r.maxMembers) setMaxMembers(r.maxMembers);
      }
    } catch { /* 编制取不到：标签区留空，不阻塞招募 */ }
  }, [teamId]);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  // 员工列表加载抽成回调：初次进入 + 新建员工成功后都要刷新（否则刚建的员工不在招募列表里）
  const loadEmployees = useCallback(async () => {
    try {
      const r = (await window.mjcode?.ecosystemEmployees?.({})) as { ok?: boolean; employees?: Employee[] } | undefined;
      setEmployees(r?.ok ? (r.employees || []) : []);
    } catch { /* 列表取不到：展示空态，不阻塞 */ }
    finally { setEmpLoading(false); }
  }, []);

  useEffect(() => {
    if (mode !== 'recruit') return;
    loadEmployees();
  }, [mode, loadEmployees]);

  const full = maxMembers > 0 && roster.length >= maxMembers;

  // 招募：成功后只刷新编制与列表，**不关窗**（需求③：让用户一直添加）
  async function recruit(employeeId: string) {
    if (full) { setErr(t('teams.membersFull', { n: maxMembers })); return; }
    setBusy(employeeId);
    setErr('');
    try {
      const r = (await window.mjcode?.teamsRecruit({ teamId, employeeId })) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) { await loadRoster(); await onChanged(); }
      else setErr(t('teams.recruitFailed', { msg: r?.error || '' }));
    } catch (e) {
      setErr(t('teams.recruitFailed', { msg: (e as Error).message }));
    } finally {
      setBusy('');
    }
  }

  // 设为统筹：全局唯一由主进程保证（setLead 内部把原统筹降回普通成员）
  async function makeLead(memberId: string) {
    setBusy(`lead:${memberId}`);
    setErr('');
    try {
      const r = (await window.mjcode?.teamsSetLead(teamId, memberId)) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) { await loadRoster(); await onChanged(); }
      else setErr(t('teams.setLeadFailed', { msg: r?.error || '' }));
    } catch (e) {
      setErr(t('teams.setLeadFailed', { msg: (e as Error).message }));
    } finally {
      setBusy('');
    }
  }

  async function makeDraft() {
    if (!description.trim()) { setErr(t('teams.customDescRequired')); return; }
    const api = window.mjcode;
    if (!api?.teamsDraftMember) { setErr(t('teams.draftFailed', { msg: '' })); return; }
    setBusy('draft');
    setErr('');
    try {
      const r = (await api.teamsDraftMember({ description })) as { ok?: boolean; draft?: MemberDraft; error?: string } | undefined;
      if (r?.ok && r.draft) setDraft(r.draft);
      else setErr(t('teams.draftFailed', { msg: r?.error || '' }));
    } catch (e) {
      setErr(t('teams.draftFailed', { msg: (e as Error).message }));
    } finally {
      setBusy('');
    }
  }

  // 确认加入（自定义）：落库后同样不关窗——清空草稿与描述，便于继续添加
  async function confirmAdd() {
    const api = window.mjcode;
    if (!api?.teamsAddCustomMember || !draft) return;
    if (full) { setErr(t('teams.membersFull', { n: maxMembers })); return; }
    setBusy('add');
    setErr('');
    try {
      const r = (await api.teamsAddCustomMember({
        teamId,
        name: draft.name,
        systemPrompt: draft.systemPrompt,
        toolNames: draft.toolNames,
        allowMcp: draft.allowMcp,
        model: draft.model,
        approvalMode: draft.approvalMode,
        sandboxPolicy: draft.sandboxPolicy,
        skillNames: draft.skillNames,
      })) as { ok?: boolean; error?: string } | undefined;
      if (r?.ok) {
        setDraft(null);
        setDescription('');
        await loadRoster();
        await onChanged();
      } else setErr(t('teams.addFailed', { msg: r?.error || '' }));
    } catch (e) {
      setErr(t('teams.addFailed', { msg: (e as Error).message }));
    } finally {
      setBusy('');
    }
  }

  const filtered = employees.filter((e) => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return true;
    return String(`${e.title_cn || e.name || ''} ${e.category || ''}`).toLowerCase().includes(kw);
  });

  const title = mode === 'recruit' ? t('teams.recruitTitle') : t('teams.customTitle');
  // 招募模式标题右侧放「新建员工」（2026-10-20 需求①）：点开即可用模型自动创建或手动新建，
  // 保存后自动刷新列表并**自动加入本团队**（需求③：新建的员工自动显示为标签）。
  const titleNode = mode === 'recruit' ? (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate">{title}</span>
      <Button variant="secondary" size="xs" disabled={full} onClick={() => setEmployeeFormOpen(true)}>
        {t('teams.newEmployee')}
      </Button>
    </div>
  ) : null;

  // 成员标签区（需求③）：统筹红、成员绿；统筹全局唯一，故非统筹成员各自带「设为统筹」入口
  const rosterArea = (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-caption text-text2 flex-1">{t('teams.rosterTitle')}</span>
        <span className="text-caption text-text2 shrink-0">
          {maxMembers > 0
            ? t('teams.rosterCount', { n: roster.length, max: maxMembers })
            : t('teams.memberCount', { n: roster.length })}
        </span>
      </div>
      {roster.length === 0
        ? <div className="text-xs text-text2 py-1">{t('teams.rosterEmpty')}</div>
        : (
          <div className="flex flex-wrap gap-2">
            {roster.map((m) => {
              const isLead = m.roleKind === 'lead';
              return (
                <span key={m.id}
                  className="inline-flex items-center gap-2 pl-1 pr-2 py-1 rounded-full border border-border bg-surface">
                  <span className={`w-5 h-5 shrink-0 rounded-full text-caption flex items-center justify-center ${
                    isLead ? 'bg-danger-bg text-danger' : 'bg-success-bg text-success'}`}>
                    {initial(m.name)}
                  </span>
                  <span className="text-xs truncate max-w-[8rem]" title={m.name}>{m.name}</span>
                  {isLead
                    ? <span className="text-caption text-danger shrink-0">{t('teams.leadTag')}</span>
                    : (
                      <Button variant="ghost" size="xs" loading={busy === `lead:${m.id}`} onClick={() => makeLead(m.id)}>
                        {t('teams.setLead')}
                      </Button>
                    )}
                </span>
              );
            })}
          </div>
        )}
      {full && <div className="text-caption text-warn mt-1">{t('teams.rosterFull', { n: maxMembers })}</div>}
    </div>
  );

  const footer = mode === 'recruit'
    ? <Button variant="secondary" size="md" onClick={onClose}>{t('teams.done')}</Button>
    : (
      <>
        <Button variant="secondary" size="md" onClick={onClose}>{t('teams.done')}</Button>
        {draft
          ? <Button size="md" loading={busy === 'add'} onClick={confirmAdd}>{t('teams.confirmAdd')}</Button>
          : <Button size="md" loading={busy === 'draft'} onClick={makeDraft}>{t('teams.draftBtn')}</Button>}
      </>
    );

  return (
    <Modal open onClose={onClose} title={title} titleNode={titleNode} size="md" footer={footer}>
      <div className="space-y-1">
        {err && <InlineAlert type="error" onDismiss={() => setErr('')}>{err}</InlineAlert>}
        {rosterArea}
      </div>

      {mode === 'recruit' && (
        <div>
          <div className="text-caption text-text2 mb-2">{t('teams.recruitHint')}</div>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('teams.searchEmployeePlaceholder')}
            className="w-full h-8 px-3 mb-2 rounded-lg bg-input text-sm"
          />
          {empLoading && <div className="text-xs text-text2 py-3">{t('teams.recruiting')}</div>}
          {!empLoading && filtered.length === 0 && <div className="text-xs text-text2 py-3">{t('teams.noEmployee')}</div>}
          {!empLoading && filtered.map((e) => {
            // P1-12（2026-10-26）：招募列表区分已在编制成员，避免重复点才报红「招募失败」让用户误判功能坏了
            const inRoster = roster.some((m) => m.id === e.id);
            return (
            <div key={e.id} className="flex items-center justify-between gap-3 border-t border-border py-2">
              <div className="min-w-0">
                <div className="text-sm truncate">{e.title_cn || e.name}</div>
                <div className="text-caption text-text2 truncate">{e.category || ''}</div>
              </div>
              <Button size="xs" loading={busy === e.id} disabled={full || inRoster} onClick={() => recruit(e.id)}>{inRoster ? t('teams.inRoster') : t('teams.recruit')}</Button>
            </div>
            );
          })}
        </div>
      )}

      {mode === 'custom' && (
        <div className="space-y-3">
          <Field label={t('teams.customDescLabel')}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('teams.customDescPlaceholder')}
              rows={3}
              maxLength={2000}
              className="w-full px-3 py-2 rounded-lg bg-input text-sm resize-none"
            />
          </Field>
          <div className="text-caption text-text2">{t('teams.draftHint')}</div>

          {draft && (
            <div className="border border-border rounded-xl p-3 space-y-2">
              <Field label={t('teams.nameFieldLabel')}>
                <input
                  value={draft.name || ''}
                  onChange={(e) => setDraft((d) => ({ ...(d || {}), name: e.target.value }))}
                  maxLength={40}
                  className="w-full h-8 px-3 rounded-lg bg-input text-sm"
                />
              </Field>

              <div>
                <div className="text-caption text-text2 mb-1">{t('teams.capabilities')}</div>
                <div className="flex flex-wrap gap-1">
                  {CAP_KEYS.filter(([k]) => draft.capabilities && draft.capabilities[k]).map(([k, key]) => (
                    <span key={k} className="text-caption px-2 py-1 rounded bg-input text-text2">{t(key)}</span>
                  ))}
                </div>
              </div>

              <div className="text-caption text-text2">
                {t('teams.sandboxLabel')}: {t(SANDBOX_LABEL[draft.sandboxPolicy || ''] || SANDBOX_LABEL['workspace-write'])}
                {'  ·  '}
                {t('teams.approvalLabel')}: {t(APPROVAL_LABEL[draft.approvalMode || ''] || APPROVAL_LABEL['on-request'])}
              </div>

              <Field label={t('teams.systemPromptLabel')}>
                <div className="text-xs text-text2 whitespace-pre-wrap break-words max-h-40 overflow-y-auto bg-input rounded-lg p-2">
                  {draft.systemPrompt || ''}
                </div>
              </Field>
            </div>
          )}
        </div>
      )}

      {/* 新建员工（2026-10-20 需求①）：复用生态中心员工表单——内含「AI 自动创建」面板；
          保存成功后刷新招募列表并自动加入本团队（需求③），用户无需离开本弹窗 */}
      {employeeFormOpen && (
        <EmployeeFormModal
          open
          onClose={() => setEmployeeFormOpen(false)}
          onSaved={async (payload) => {
            await loadEmployees();
            if (payload?.created && payload.id) await recruit(payload.id);
          }}
        />
      )}
    </Modal>
  );
}
