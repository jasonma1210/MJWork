// DS Bots / T6-9：新建项目空间表单（设计稿 §11.1）。
//
// 为什么单独一个弹窗而不是塞进现有 ProjectPicker：ProjectPicker 选的是「工作目录项目」
// （thread.projectPath），本表单创建的是 DS Bots 项目空间（project_spaces + 工件 + 配额桶 +
// 团队 + 会话的七步初始化）。两者是不同实体，混在一个入口会让「项目」一词指代两种东西。
//
// 校验纪律（§11.1 明文要求，也是团队创建表单的历史事故教训）：
//   · 每个必填字段**字段级红字**（Input/TextArea 的 error 走 aria-describedby）；
//   · 校验不通过时提交按钮直接禁用，不依赖「点了没反应」的静默失败；
//   · 服务端返回的 field 错误按字段回填，页面级红字只兜底未知错误。
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Switch from './ui/Switch';
import { Input, TextArea } from './ui/Input';
import { useI18n } from '../i18n';

const CATEGORIES = ['prd', 'tech', 'marketing', 'custom'] as const;
const TEMPLATES = ['prd', 'tech', 'marketing', 'custom', 'existing'] as const;
const QUOTA_TIERS = ['light', 'standard', 'large', 'custom'] as const;
const ARTIFACT_KINDS = ['document', 'spec', 'plan', 'custom'] as const;
const SNAPSHOT_POLICIES = ['per_patch', 'per_stage', 'manual'] as const;

type Category = typeof CATEGORIES[number];
type Template = typeof TEMPLATES[number];
type QuotaTier = typeof QUOTA_TIERS[number];
type ArtifactKind = typeof ARTIFACT_KINDS[number];
type SnapshotPolicy = typeof SNAPSHOT_POLICIES[number];

// 与 main/projectSpaceInit.js 的 SECTION_DEFAULTS 同结构（顺序一致），但文案走 i18n：
// 表单打开时用户要看得到「默认章节」，且切换英文后不能出现中文残留。
const OUTLINE_KEYS: Record<Category, string[]> = {
  prd: ['projectSpace.secBgGoal', 'projectSpace.secUsers', 'projectSpace.secFunc', 'projectSpace.secNonFunc', 'projectSpace.secAccept'],
  tech: ['projectSpace.secConstraint', 'projectSpace.secArch', 'projectSpace.secApiData', 'projectSpace.secRisk', 'projectSpace.secPlan'],
  marketing: ['projectSpace.secAudience', 'projectSpace.secStrategy', 'projectSpace.secChannel', 'projectSpace.secPace', 'projectSpace.secMeasure'],
  custom: ['projectSpace.secOverview', 'projectSpace.secContent', 'projectSpace.secConclusion'],
};

const ARTIFACT_DEFAULTS: Record<Category, ArtifactKind> = {
  prd: 'document', tech: 'spec', marketing: 'plan', custom: 'document',
};
const TEMPLATE_DEFAULTS: Record<Category, Template> = {
  prd: 'prd', tech: 'tech', marketing: 'marketing', custom: 'custom',
};

interface TeamOption { id: string; name?: string }
interface ProjectOption { path: string; name?: string }
/** 模板角色只读投影（主进程 projectSpaceInit.TEAM_TEMPLATES 下发，不含 systemPrompt） */
interface RoleProjection { name: string; roleKind: string }
interface RoleTemplate { name: string; roles: RoleProjection[] }

interface Props {
  open: boolean;
  onClose: () => void;
  /** 已打开过的工作目录项目（下拉候选；留空 = 自建目录） */
  projects?: ProjectOption[];
  /**
   * 创建成功：宿主负责切换会话、刷新列表并开跑。
   * 必须带上 team 与 project——只给 thread 的话，宿主无法替用户把已锁定的目标派给团队，
   * 用户就会停在「项目已创建」上，误以为运行结束了。
   */
  onCreated?: (result: { thread?: unknown; team?: { id?: string }; project?: { objective?: string; cwd?: string } }) => void;
}

interface FormState {
  name: string;
  category: Category;
  objective: string;
  cwd: string;
  teamTemplate: Template;
  teamId: string;
  quotaTier: QuotaTier;
  totalLimit: string;
  windowSeconds: string;
  artifactKind: ArtifactKind;
  outline: string;
  snapshotPolicy: SnapshotPolicy;
  retainVersions: string;
  compactPolicy: string;
  resumeEnabled: boolean;
}

type TFn = (key: string) => string;

function outlineOf(category: Category, t: TFn): string {
  return OUTLINE_KEYS[category].map((k) => t(k)).join('\n');
}

function initialState(t: TFn): FormState {
  return {
    name: '',
    category: 'prd',
    objective: '',
    cwd: '',
    teamTemplate: 'prd',
    teamId: '',
    quotaTier: 'standard',
    totalLimit: '3000000',
    windowSeconds: '21600',
    artifactKind: 'document',
    outline: outlineOf('prd', t),
    snapshotPolicy: 'per_patch',
    retainVersions: '10',
    compactPolicy: '70',
    resumeEnabled: true,
  };
}

function outlineLines(raw: string): string[] {
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

// 字段容器：label + 控件 + 红字（与 Input/TextArea 的排版一致；下拉框没有统一原语）
// P2-10（2026-10-26）：label 由 string 放宽为 ReactNode，以支持必填星标（红 *）等内联标记。
function Field({ label, error, hint, children }: {
  label: ReactNode; error?: string; hint?: string; children: ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-text2 mb-1">{label}</label>
      {children}
      {error ? <p className="text-caption text-danger mt-1">{error}</p>
        : hint ? <p className="text-caption text-text2 mt-1">{hint}</p> : null}
    </div>
  );
}

const SELECT_CLASS = 'w-full h-8 px-3 rounded-lg border bg-input text-xs text-text outline-none focus:border-accent';

export default function ProjectCreateModal({ open, onClose, projects = [], onCreated }: Props) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(() => initialState(t));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [roleTemplates, setRoleTemplates] = useState<Record<string, RoleTemplate>>({});
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState('');
  const [serverField, setServerField] = useState<string>('');
  // 「默认章节/类型」是否被用户改过：改过就不再随分类切换覆盖（避免手写内容被静默丢弃）
  const [outlineTouched, setOutlineTouched] = useState(false);
  const [kindTouched, setKindTouched] = useState(false);
  // §16 风险对策「高级项折叠」：默认收起，只有需要微调阈值/续跑的人才会展开
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(initialState(t));
    setTouched({});
    setTeams([]);
    setRoleTemplates({});
    setSaving(false);
    setPageError('');
    setServerField('');
    setOutlineTouched(false);
    setKindTouched(false);
    setAdvancedOpen(false);
    // 现有团队候选：只在切到「现有团队」时用到，打开即拉一次（失败静默，表单会提示必选）
    (async () => {
      try {
        type TeamsFn = (p: Record<string, unknown>) => Promise<{ ok?: boolean; teams?: TeamOption[] }>;
        const fn = window.mjcode?.teamsList as TeamsFn | undefined;
        const r = await fn?.({});
        if (r?.ok && Array.isArray(r.teams)) {
          setTeams(r.teams.map((x) => ({ id: String(x.id || ''), name: x.name })));
        }
      } catch { /* 候选拉取失败不阻塞表单：用户仍可用模板创建 */ }
    })();
    // 模板角色只读投影（§11.1「角色清单｜模板时只读」）。拉取失败时整块不展示，
    // 不阻塞创建——角色以主进程模板为准，界面只是预览。
    (async () => {
      try {
        type RolesFn = () => Promise<{ ok?: boolean; templates?: Record<string, RoleTemplate> }>;
        const fn = window.mjcode?.projectsRoleTemplates as RolesFn | undefined;
        const r = await fn?.();
        if (r?.ok && r.templates) setRoleTemplates(r.templates);
      } catch { /* 预览失败静默 */ }
    })();
  }, [open]);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // 分类切换：未改过默认章节/工件类型时同步跟随（§11.1「按分类带默认值」）
  function changeCategory(next: Category) {
    setForm((f) => ({
      ...f,
      category: next,
      outline: outlineTouched ? f.outline : outlineOf(next, t),
      artifactKind: kindTouched ? f.artifactKind : ARTIFACT_DEFAULTS[next],
      teamTemplate: f.teamTemplate === 'existing' ? f.teamTemplate : TEMPLATE_DEFAULTS[next],
    }));
  }

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    const name = form.name.trim();
    if (!name) e.name = t('projectSpace.errNameRequired');
    else if (name.length > 40) e.name = t('projectSpace.errNameTooLong', { max: 40 });
    const obj = form.objective.trim();
    if (obj.length < 20) e.objective = t('projectSpace.errObjectiveShort', { min: 20 });
    else if (obj.length > 2000) e.objective = t('projectSpace.errObjectiveLong', { max: 2000 });
    if (form.teamTemplate === 'existing' && !form.teamId) e.teamId = t('projectSpace.errTeamRequired');
    if (form.quotaTier === 'custom') {
      const limit = Number(form.totalLimit);
      if (!Number.isFinite(limit) || limit < 1000 || limit > 50000000) {
        e.totalLimit = t('projectSpace.errTotalLimit', { min: 1000, max: 50000000 });
      }
      const win = Number(form.windowSeconds);
      if (!Number.isFinite(win) || win < 60 || win > 604800) {
        e.windowSeconds = t('projectSpace.errWindow', { min: 60, max: 604800 });
      }
    }
    const retain = Number(form.retainVersions);
    if (!Number.isFinite(retain) || retain < 1 || retain > 50) {
      e.retainVersions = t('projectSpace.errRetain', { min: 1, max: 50 });
    }
    const compact = Number(form.compactPolicy);
    if (!Number.isFinite(compact) || compact < 50 || compact > 85) {
      e.compactPolicy = t('projectSpace.errCompact', { min: 50, max: 85 });
    }
    if (outlineLines(form.outline).length > 50) {
      e.outline = t('projectSpace.errOutline', { max: 50 });
    }
    return e;
  }, [form, t]);

  // 红字显示时机：失焦过（touched）或已有内容（用户正在输入）——
  // 打开即满屏红字会让表单看起来像「全都错了」，反而不易读。
  function errorFor(key: keyof FormState): string {
    if (!errors[key]) return '';
    if (serverField === key) return errors[key];
    const raw = String(form[key] ?? '');
    return touched[key] || raw.length > 0 ? errors[key] : '';
  }
  function blur(key: keyof FormState) {
    setTouched((m) => ({ ...m, [key]: true }));
  }

  const invalid = Object.keys(errors).length > 0;

  async function submit() {
    setPageError('');
    setServerField('');
    if (invalid || saving) return;
    type CreateFn = (p: Record<string, unknown>) => Promise<{
      ok?: boolean; error?: string; field?: string;
      thread?: unknown; team?: { id?: string }; project?: { objective?: string; cwd?: string };
    }>;
    const fn = window.mjcode?.projectsCreateSpace as CreateFn | undefined;
    if (typeof fn !== 'function') {
      setPageError(t('projectSpace.bridgeMissing'));
      return;
    }
    setSaving(true);
    try {
      const r = await fn({
        name: form.name.trim(),
        category: form.category,
        objective: form.objective.trim(),
        cwd: form.cwd,
        teamMode: form.teamTemplate === 'existing' ? 'existing' : 'template',
        teamTemplate: form.teamTemplate === 'existing' ? '' : form.teamTemplate,
        teamId: form.teamTemplate === 'existing' ? form.teamId : '',
        quotaTier: form.quotaTier,
        totalLimit: form.quotaTier === 'custom' ? Number(form.totalLimit) : undefined,
        windowSeconds: form.quotaTier === 'custom' ? Number(form.windowSeconds) : undefined,
        artifactKind: form.artifactKind,
        outline: outlineLines(form.outline),
        snapshotPolicy: form.snapshotPolicy,
        retainVersions: Number(form.retainVersions),
        compactPolicy: Number(form.compactPolicy),
        resumeEnabled: form.resumeEnabled,
      });
      if (r?.ok) {
        onCreated?.({ thread: r.thread, team: r.team, project: r.project });
        onClose();
      } else {
        if (r?.field) setServerField(String(r.field));
        setPageError(r?.error || t('projectSpace.createFailed'));
      }
    } catch (e) {
      setPageError(t('projectSpace.createFailedWith', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      {/* P2-10（2026-10-26）：打开即 invalid（按钮禁用），但未 touched 字段不显红字，
          原 footer 只一句「请先补全必填项」，用户看不到哪几处卡住。此处改为动态数量提示，
          配合必填星标，使灰色按钮的原因可被定位（不触发满屏红字，尊重原「打开即全红不易读」的设计）。 */}
      <span className="text-caption text-text2 mr-auto">
        {invalid ? t('projectSpace.requiredHintCount', { count: Object.keys(errors).length }) : ''}
      </span>
      <Button variant="secondary" onClick={onClose} disabled={saving}>{t('projectSpace.cancel')}</Button>
      <Button onClick={submit} loading={saving} disabled={invalid}>{t('projectSpace.create')}</Button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('projectSpace.title')}
      footer={footer}
      liveMessage={saving ? t('projectSpace.creating') : ''}
      // 表单类弹窗不吃遮罩点击：误触关掉会丢掉已写好的目标与章节
      closeOnOverlay={false}
    >
      <div className="px-5 py-4 space-y-4 overflow-y-auto">
        {pageError && (
          <p className="text-xs text-danger bg-danger-bg rounded-lg px-3 py-2" role="alert">{pageError}</p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Input
            label={<span>{t('projectSpace.name')}<span className="text-danger ml-1">*</span></span>}
            value={form.name}
            maxLength={40}
            placeholder={t('projectSpace.namePh')}
            error={errorFor('name')}
            onChange={(e) => patch('name', e.target.value)}
            onBlur={() => blur('name')}
          />
          <Field label={t('projectSpace.category')}>
            <select
              value={form.category}
              onChange={(e) => changeCategory(e.target.value as Category)}
              className={SELECT_CLASS}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`projectSpace.cat_${c}`)}</option>
              ))}
            </select>
          </Field>
        </div>

        <TextArea
          label={<span>{t('projectSpace.objective')}<span className="text-danger ml-1">*</span></span>}
          value={form.objective}
          maxLength={2000}
          rows={4}
          showCount
          placeholder={t('projectSpace.objectivePh')}
          hint={t('projectSpace.objectiveHint')}
          error={errorFor('objective')}
          onChange={(e) => patch('objective', e.target.value)}
          onBlur={() => blur('objective')}
        />

        <Field label={t('projectSpace.cwd')} hint={t('projectSpace.cwdHint')}>
          <select value={form.cwd} onChange={(e) => patch('cwd', e.target.value)} className={SELECT_CLASS}>
            <option value="">{t('projectSpace.cwdNone')}</option>
            {projects.filter((p) => p.path).map((p) => (
              <option key={p.path} value={p.path}>{p.name || p.path}</option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('projectSpace.teamTemplate')} hint={t('projectSpace.teamSourceHint')}>
            <select
              value={form.teamTemplate}
              onChange={(e) => patch('teamTemplate', e.target.value as Template)}
              className={SELECT_CLASS}
            >
              {TEMPLATES.map((k) => (
                <option key={k} value={k}>{t(`projectSpace.tpl_${k}`)}</option>
              ))}
            </select>
          </Field>
          {form.teamTemplate === 'existing' && (
            <Field label={<span>{t('projectSpace.existingTeam')}<span className="text-danger ml-1">*</span></span>} error={errorFor('teamId')}>
              <select
                value={form.teamId}
                onChange={(e) => patch('teamId', e.target.value)}
                onBlur={() => blur('teamId')}
                className={`${SELECT_CLASS} ${errors.teamId ? 'border-danger' : 'border-border'}`}
              >
                <option value="">{t('projectSpace.existingTeamPh')}</option>
                {teams.map((x) => <option key={x.id} value={x.id}>{x.name || x.id}</option>)}
              </select>
            </Field>
          )}
        </div>

        {/* §11.1「角色清单｜模板时只读」：预览的是主进程真实模板编制，界面不可编辑。
            现有团队模式没有模板角色，整块不展示。 */}
        {(() => {
          const tpl = form.teamTemplate === 'existing' ? null : roleTemplates[form.teamTemplate];
          if (!tpl || !tpl.roles?.length) return null;
          return (
            <Field label={t('projectSpace.teamRoles')} hint={t('projectSpace.teamRolesHint')}>
              <ul className="rounded-lg border border-border divide-y divide-border">
                {tpl.roles.map((r) => (
                  <li key={r.name} className="flex items-center justify-between px-3 py-2 text-xs">
                    <span className="text-text">{r.name}</span>
                    {r.roleKind === 'lead' && (
                      <span className="text-caption text-text2">{t('projectSpace.roleLead')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Field>
          );
        })()}

        <Field label={t('projectSpace.quotaTier')}>
          <select
            value={form.quotaTier}
            onChange={(e) => patch('quotaTier', e.target.value as QuotaTier)}
            className={SELECT_CLASS}
          >
            {QUOTA_TIERS.map((k) => (
              <option key={k} value={k}>{t(`projectSpace.tier_${k}`)}</option>
            ))}
          </select>
        </Field>

        {form.quotaTier === 'custom' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('projectSpace.totalLimit')}
              value={form.totalLimit}
              inputMode="numeric"
              error={errorFor('totalLimit')}
              onChange={(e) => patch('totalLimit', e.target.value)}
              onBlur={() => blur('totalLimit')}
            />
            <Input
              label={t('projectSpace.windowSeconds')}
              value={form.windowSeconds}
              inputMode="numeric"
              error={errorFor('windowSeconds')}
              onChange={(e) => patch('windowSeconds', e.target.value)}
              onBlur={() => blur('windowSeconds')}
            />
          </div>
        )}

        <div className="border-t border-border pt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('projectSpace.artifactKind')}>
              <select
                value={form.artifactKind}
                onChange={(e) => { setKindTouched(true); patch('artifactKind', e.target.value as ArtifactKind); }}
                className={SELECT_CLASS}
              >
                {ARTIFACT_KINDS.map((k) => (
                  <option key={k} value={k}>{t(`projectSpace.kind_${k}`)}</option>
                ))}
              </select>
            </Field>
            <Field label={t('projectSpace.snapshotPolicy')}>
              <select
                value={form.snapshotPolicy}
                onChange={(e) => patch('snapshotPolicy', e.target.value as SnapshotPolicy)}
                className={SELECT_CLASS}
              >
                {SNAPSHOT_POLICIES.map((k) => (
                  <option key={k} value={k}>{t(`projectSpace.snap_${k}`)}</option>
                ))}
              </select>
            </Field>
          </div>

          <TextArea
            label={t('projectSpace.outline')}
            value={form.outline}
            rows={5}
            hint={t('projectSpace.outlineHint')}
            error={errorFor('outline')}
            onChange={(e) => { setOutlineTouched(true); patch('outline', e.target.value); }}
            onBlur={() => blur('outline')}
          />

          <Input
            label={t('projectSpace.retainVersions')}
            value={form.retainVersions}
            inputMode="numeric"
            error={errorFor('retainVersions')}
            onChange={(e) => patch('retainVersions', e.target.value)}
            onBlur={() => blur('retainVersions')}
          />

          {/* §16 风险对策：高级项默认折叠，避免首屏字段过多劝退用户。
              折叠态下摘要行直接暴露错误文案，防止「提交被禁用但看不到原因」。 */}
          <details
            className="rounded-lg border border-border px-3 py-2"
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-xs text-text2">{t('projectSpace.advanced')}</span>
              {!advancedOpen && errors.compactPolicy && (
                <span className="text-caption text-danger">{errors.compactPolicy}</span>
              )}
            </summary>
            <div className="pt-3 space-y-3">
              <Input
                label={t('projectSpace.compactPolicy')}
                value={form.compactPolicy}
                inputMode="numeric"
                hint={t('projectSpace.compactPolicyHint')}
                error={errorFor('compactPolicy')}
                onChange={(e) => patch('compactPolicy', e.target.value)}
                onBlur={() => blur('compactPolicy')}
              />

              <div className="flex items-center justify-between">
                <span className="text-xs text-text2">{t('projectSpace.resume')}</span>
                <Switch
                  checked={form.resumeEnabled}
                  onChange={(v) => patch('resumeEnabled', v)}
                  label={t('projectSpace.resume')}
                />
              </div>
            </div>
          </details>
        </div>
      </div>
    </Modal>
  );
}
