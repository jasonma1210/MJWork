// 工作台 · 接单输入区（案例 + 目标文案 + 工作空间/档位/模型弹出菜单 + 派单）
//
// 形态对齐原型 desk 的 `.card.intake`：**一个输入框 + 一行工具条**。
//
// 工具条（2026-10-28 第三版，用户裁决三连）：
//   ① 原生 <select> 的系统灰下拉与前端设计不符（真机截图：灰底、无圆角阴影、无悬停态）
//      ⇒ 全部改为 **ChipButton 触发器 + portal 弹出面板**（ui/MenuItem 行 + ✓ 选中态 +
//      分隔线），面板样式与会话内 PlusMenu 同源（bg-raise / rounded-xl / shadow-pop / z-palette）。
//   ② 工作空间面板**顶部固定「新建项目」**（选本地目录/新建目录，复用 App 既有的
//      ProjectPicker 弹窗），与下方项目列表用分隔线隔开。
//   ③ 项目列表**按使用顺序排**（updatedAt 倒序；listProjects 本身已 ORDER BY updated_at DESC，
//      客户端再兜底排一次，缺字段的条目保持原相对顺序）。
//   芯片触发器（ChipButton）与菜单行（MenuItem）都收在 components/ui/ —— 门禁排除 ui/，
//   本文件零裸 <button>；芯片设计语言逐字对齐会话内 ComposerControls（h-7/rounded-lg/透明底）。
//
// 案例胶囊行（2026-10-28 二版，用户裁决「太丑」）：**卡片外、接一单上方**（此前挤在输入框
//   标签与占位文案之间，又占位又难看）。形态对齐主流产品快捷键参考：ui/Button 新增 pill
//   胶囊档（rounded-full）+ 行首图标 + md 尺寸舒适留白，无「案例：」前缀标签。
//   点击套用模板语义不变：空输入直接填，已有内容换行追加（不清空用户已打的字）。
//
// 工作空间选择语义：选中只存本组件 state（**不**顺手切全局工作区，浏览选项零副作用），
//   派单时把选中的 project 对象随 onDispatch 交给 App —— newThreadInProject(p) 内部会
//   selectProject(p)，派完即落在目标工作区。
//
// 档位（审批/沙箱/粒度）就地可选：onChange 直调 App 的 setApprovalSettings ——
//   与设置页、会话内 Composer 是**同一事实来源、同一写回通道**（mj_approval_settings），
//   不是第二真源，只是第三个入口；审批档 never/完全访问时芯片转警示色（isRiskyApproval）。
//
// ↵ 仍真绑定 Enter（IME-safe，见 onKeyDown）；+ 加号复用主输入框的 PlusMenu（extras
//   派单时随目标传出，App 建线程后写 mj_extras_<threadId>，ChatArea 切换时恢复）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import MenuItem from '../ui/MenuItem';
import ChipButton from '../ui/ChipButton';
import PlusMenu from '../PlusMenu';
import { toast } from '../feedback';
import {
  IconAlert, IconChart, IconCpu, IconFile, IconFolder, IconFolderOpen, IconFolderPlus, IconList, IconPlus, IconShield, IconTerminal,
} from '../icons';
import { useI18n } from '../../i18n';
import { APPROVAL_MODES, SANDBOX_MODES, RESPONSE_STYLES, migrateApprovalMode, isRiskyApproval } from '../../constants/approval';

/** 派单时携带的会话内扩展（与 PlusMenu 的 extras 同形；App 建线程后写入 mj_extras_<id>） */
export interface DeskExtras {
  expert?: unknown;
  skillIds?: string[];
  mcpServers?: string[];
}

/** 工作空间项（由 App 从 projects 传入；updatedAt 供「按使用顺序」排序兜底） */
export interface DeskProjectOption {
  id: string;
  name: string;
  path?: string;
  updatedAt?: number | string;
}

/** 模型下拉的一项（由 App 从 allProviders 摊平后传入） */
export interface DeskModelOption {
  id: string;
  label: string;
}

/** 档位变更补丁（键名与 mj_approval_settings 的持久化形状一致） */
export interface DeskPolicyPatch {
  approval_mode?: string;
  sandbox_policy?: string;
  response_style?: string;
}

/** 弹出面板的菜单键（同一时刻至多开一个） */
type MenuKey = 'workspace' | 'approval' | 'sandbox' | 'style' | 'model';

export interface DeskIntakeProps {
  /** 当前档位（App 的 approvalSettings 活值） */
  approvalMode?: string;
  sandboxPolicy?: string;
  responseStyle?: string;
  /** 档位变更：直写 App 的 setApprovalSettings（与设置页/Composer 同一通道） */
  onPolicyChange?: (patch: DeskPolicyPatch) => void;
  /** 派单：目标 + 会话内扩展 + 派单前选定的工作空间（null = 跟随当前工作区） */
  onDispatch?: (goal: string, extras: DeskExtras, project: DeskProjectOption | null) => void;
  /** 新建项目：打开 App 既有的 ProjectPicker（选本地目录/新建目录），由 App 决定落点 */
  onNewProject?: () => void;
  /** 当前项目路径：仅用于 PlusMenu 判断「从会话中引用 / 工作模式」等项是否可用 */
  projectPath?: string;
  /** 工作空间列表；为空则不渲染选择器（不显示一个空芯片） */
  projects?: readonly DeskProjectOption[];
  /** 当前工作区 id（作为选择器初值；外部切换会同步进来） */
  activeProjectId?: string | null;
  /** 可选模型列表；为空则不渲染选择器 */
  models?: readonly DeskModelOption[];
  /** 当前模型 key */
  currentModel?: string;
  /** 切换模型 */
  onPickModel?: (id: string) => void;
}

export default function DeskIntake({
  approvalMode, sandboxPolicy, responseStyle, onPolicyChange, onDispatch, onNewProject, models = [],
  currentModel, onPickModel, projectPath, projects = [], activeProjectId,
}: DeskIntakeProps) {
  const { t } = useI18n();
  const [goal, setGoal] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  // 派单前选中的会话内扩展与工作空间 —— 派单时随目标一起交给 App（详见文件头落点说明）。
  const [extras, setExtras] = useState<DeskExtras>({});
  const [workspaceId, setWorkspaceId] = useState<string>(activeProjectId || '');
  // 外部工作区切换（侧栏/命令面板）同步进选择器：接单台不成为第二份项目状态。
  useEffect(() => { setWorkspaceId(activeProjectId || ''); }, [activeProjectId]);
  // 弹出面板：同一时刻至多开一个；anchor 是触发器元素（fixed 定位按它算坐标）。
  const [menu, setMenu] = useState<{ key: MenuKey; anchor: HTMLElement } | null>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 加号按钮的锚点：PlusMenu 用它算 portal 的 fixed 位置（接单台在 overflow-y-auto 容器里，
  // 绝对定位向上展开会被祖先裁掉，见 PlusMenu 里 anchorEl 的说明）。
  const plusAnchorRef = useRef<HTMLDivElement | null>(null);
  const trimmed = goal.trim();

  // 项目按使用顺序排（updatedAt 倒序；listProjects 已 ORDER BY updated_at DESC，此处兜底，
  // 缺 updatedAt 的条目两两比较得 NaN ⇒ V8 稳定排序下保持原有相对顺序，不会乱序）。
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)),
    [projects],
  );

  // 弹出面板开合：点外部 / Esc / 滚动即关。fixed 定位面板不随滚动重算坐标，滚动关掉
  // 比跟随重排便宜且不会出现「面板飘在错误的芯片旁」。
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || menu.anchor.contains(target)) return;
      setMenu(null);
    };
    const onKey = (e: Event) => { if ((e as globalThis.KeyboardEvent).key === 'Escape') setMenu(null); };
    const onScroll = (e: Event) => {
      // ⚠ capture 监听 window scroll 会连**面板自身**的滚动一起收到 —— 不排除的话
      // 「滚轮一动菜单就关」，用户实测「点开后失去焦点、无法滚动」（2026-10-28）。
      // 面板内部滚动放行；只有祖先容器的滚动（fixed 定位会飘）才关闭。
      const t = e.target;
      if (t instanceof Node && panelRef.current?.contains(t)) return;
      setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menu]);

  // 面板坐标：触发器 Rect → 优先向下展开（top），下方空间不足时向上（bottom 锚定，面板长也贴着芯片）。
  useLayoutEffect(() => {
    if (!menu) { setPos(null); return; }
    const r = menu.anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 240));
    const openUp = r.bottom + 264 > window.innerHeight;
    setPos(openUp ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
  }, [menu]);

  const toggle = (key: MenuKey) => (e: ReactMouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    setMenu((m) => (m?.key === key ? null : { key, anchor: el }));
  };

  const closeMenu = () => setMenu(null);

  const dispatch = () => {
    if (!trimmed) return;
    const hit = sortedProjects.find((p) => p.id === workspaceId) || null;
    onDispatch?.(trimmed, extras, hit);
  };

  // 案例套用：空输入直接填；已有内容换行追加（不清空用户已打的字），并聚焦输入框接着改占位符。
  const applyCase = (tpl: string) => {
    setGoal((prev) => (prev.trim() ? `${prev}\n\n${tpl}` : tpl));
    textareaRef.current?.focus();
  };

  // 添加文件：与主输入框同一 IPC 通道，选完以 `@路径` 追加到目标文案。
  // 桥缺失或用户取消都属预期路径（不报错）；写失败只记日志，不打断填写。
  const addFiles = async () => {
    setPlusOpen(false);
    try {
      const pick = window.mjcode?.pickFiles;
      if (typeof pick !== 'function') return;
      const r = (await pick()) as { ok?: boolean; paths?: string[] } | undefined;
      if (r?.ok && Array.isArray(r.paths) && r.paths.length) {
        const refs = r.paths.map((p) => `@${p}`).join('\n');
        setGoal((prev) => `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${refs}`);
      }
    } catch (e) {
      console.warn('[desk] pick files failed:', e);
    }
  };

  // Enter 派单 / Shift+Enter 换行。
  // isComposing 判断不可省：中文输入法下回车是「上屏候选词」，此时派单会把半截拼音当成目标发出去。
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    e.preventDefault();
    dispatch();
  };

  // ── 触发器上的当前值（芯片即触发器，值文案在面板里也可复用） ──
  const approvalId = migrateApprovalMode(approvalMode);
  const risky = isRiskyApproval({ approval_mode: approvalId, sandbox_policy: sandboxPolicy });
  const approvalLabel = t(APPROVAL_MODES.find((m) => m.id === approvalId)?.nameKey || 'approval.onRequest');
  const sandboxId = sandboxPolicy || 'workspace-write';
  const sandboxLabel = t(SANDBOX_MODES.find((m) => m.id === sandboxId)?.nameKey || 'approval.workspaceWrite');
  const styleId = responseStyle || 'default';
  const styleLabel = t(RESPONSE_STYLES.find((s) => s.id === styleId)?.nameKey || 'settings.responseStyleDefault');
  const wsLabel = sortedProjects.find((p) => p.id === workspaceId)?.name || t('desk.intake.workspaceNone');
  const modelLabel = models.find((m) => m.id === currentModel)?.label || currentModel || t('desk.intake.model');
  const policyHint = t('desk.intake.policyHint');

  // 案例胶囊行在**卡片外、接一单上方**（2026-10-28 用户裁决：挤在输入框标签下又丑又占位；
  // 参考对齐主流产品的圆角胶囊快捷键：rounded-full + 图标 + 舒适留白，无「案例：」前缀标签）。
  // 点击套用模板语义不变：空输入直接填，已有内容换行追加（不清空用户已打的字）。
  const caseChips = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="md" pill onClick={() => applyCase(t('desk.goal.office'))}>
        <IconFile size={13} className="text-text2" />
        {t('desk.intake.caseDoc')}
      </Button>
      <Button variant="secondary" size="md" pill onClick={() => applyCase(t('desk.goal.ppt'))}>
        <IconChart size={13} className="text-text2" />
        {t('desk.intake.casePpt')}
      </Button>
      <Button variant="secondary" size="md" pill onClick={() => applyCase(t('desk.goal.dev'))}>
        <IconTerminal size={13} className="text-text2" />
        {t('desk.intake.caseCode')}
      </Button>
    </div>
  );

  return (
    <>
      {caseChips}
      <section className="shrink-0 rounded-xl border border-border bg-surface p-4" aria-label={t('desk.intake.label')}>
        <label htmlFor="desk-intake-goal" className="block text-caption text-text2 mb-1">
          {t('desk.intake.label')}
        </label>

      <textarea
        id="desk-intake-goal"
        ref={textareaRef}
        rows={3}
        className="block w-full min-h-[66px] resize-y border-0 bg-transparent text-sm leading-relaxed text-text outline-none placeholder:text-text2"
        placeholder={t('desk.intake.placeholder')}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {projects.length > 0 ? (
          <ChipButton
            icon={<IconFolderOpen size={12} className="text-text2" />}
            onClick={toggle('workspace')}
            aria-expanded={menu?.key === 'workspace'}
            aria-label={t('desk.intake.workspace')}
          >
            {wsLabel}
          </ChipButton>
        ) : null}

        <ChipButton
          icon={risky ? <IconAlert size={12} /> : <IconShield size={12} className="text-text2" />}
          warn={risky}
          onClick={toggle('approval')}
          aria-expanded={menu?.key === 'approval'}
          aria-label={t('desk.intake.policyApproval')}
          title={policyHint}
        >
          {approvalLabel}
        </ChipButton>

        <ChipButton
          icon={<IconFolder size={12} className="text-text2" />}
          onClick={toggle('sandbox')}
          aria-expanded={menu?.key === 'sandbox'}
          aria-label={t('desk.intake.policySandbox')}
          title={policyHint}
        >
          {sandboxLabel}
        </ChipButton>

        <ChipButton
          icon={<IconList size={12} className="text-text2" />}
          onClick={toggle('style')}
          aria-expanded={menu?.key === 'style'}
          aria-label={t('desk.intake.policyStyle')}
          title={policyHint}
        >
          {styleLabel}
        </ChipButton>

        {models.length > 0 ? (
          <ChipButton
            icon={<IconCpu size={12} className="text-text2" />}
            onClick={toggle('model')}
            aria-expanded={menu?.key === 'model'}
            aria-label={t('desk.intake.model')}
          >
            {modelLabel}
          </ChipButton>
        ) : null}

        {/* 加号：**复用主输入框的 PlusMenu**（不再自建菜单）—— 菜单项、分组、子面板、
            搜索框全部与会话内一致，避免两套菜单各自漂移。
            传 anchorEl ⇒ PlusMenu 走 portal + fixed 定位：本卡片所在的 DeskPage 有
            overflow-y-auto 滚动容器，absolute + bottom-full 向上展开会被祖先裁掉。 */}
        <div className="ml-auto shrink-0" ref={plusAnchorRef}>
          <IconButton
            label={t('desk.intake.addTip')}
            active={plusOpen}
            ariaExpanded={plusOpen}
            onClick={() => setPlusOpen((v) => !v)}
            className={plusOpen ? 'rotate-45' : ''}
          >
            <IconPlus size={16} />
          </IconButton>
          {plusOpen && (
            <PlusMenu
              anchorEl={plusAnchorRef.current}
              open={plusOpen}
              onClose={() => setPlusOpen(false)}
              onPickFiles={addFiles}
              hasProject={!!projectPath}
              // runMode / onSelectTeam 在 PlusMenu 里无默认值：显式传 undefined 表示「本场景没有」。
              runMode={undefined}
              onSelectTeam={undefined}
              extras={extras}
              onExtrasChange={setExtras}
              // 语音：麦克风由会话侧的 voice 句柄驱动，接单台拿不到 —— 点击给明确提示而不是静默。
              onVoiceStart={() => {
                setPlusOpen(false);
                toast({ message: t('desk.intake.voiceInSession') });
              }}
              // 工作模式：runMode 是 ChatArea 内部 state 且不持久化，带不到新线程 —— 同样给提示。
              onModeChange={() => {
                setPlusOpen(false);
                toast({ message: t('desk.intake.modeInSession') });
              }}
            />
          )}
        </div>

        <Button variant="primary" size="md" disabled={!trimmed} onClick={dispatch}>
          {t('desk.intake.dispatch')}
        </Button>
      </div>

      {/* 弹出面板：portal 到 body（接单台在滚动容器内，absolute 会被祖先 overflow 裁掉）。
          样式与会话内 PlusMenu 面板同源：bg-raise / rounded-xl / shadow-pop / z-palette。 */}
      {menu && pos && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          className="fixed z-palette min-w-[220px] max-h-[320px] overflow-y-auto rounded-xl border border-border bg-raise py-1 shadow-[var(--shadow-pop)]"
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}
        >
          {menu.key === 'workspace' ? (
            <>
              {/* 顶部固定动作：新建项目（选本地目录/新建目录），与项目列表用分隔线隔开 */}
              <MenuItem
                icon={<IconFolderPlus size={12} />}
                onClick={() => { closeMenu(); onNewProject?.(); }}
              >
                {t('desk.intake.newProject')}
              </MenuItem>
              <div className="my-1 border-t border-border" role="separator" />
              {sortedProjects.map((p) => (
                <MenuItem
                  key={p.id}
                  selected={p.id === workspaceId}
                  onClick={() => { setWorkspaceId(p.id); closeMenu(); }}
                >
                  {p.name}
                </MenuItem>
              ))}
            </>
          ) : null}
          {menu.key === 'approval' ? APPROVAL_MODES.map((m) => (
            <MenuItem
              key={m.id}
              selected={m.id === approvalId}
              onClick={() => { onPolicyChange?.({ approval_mode: m.id }); closeMenu(); }}
            >
              {t(m.nameKey)}
            </MenuItem>
          )) : null}
          {menu.key === 'sandbox' ? SANDBOX_MODES.map((m) => (
            <MenuItem
              key={m.id}
              selected={m.id === sandboxId}
              onClick={() => { onPolicyChange?.({ sandbox_policy: m.id }); closeMenu(); }}
            >
              {t(m.nameKey)}
            </MenuItem>
          )) : null}
          {menu.key === 'style' ? RESPONSE_STYLES.map((s) => (
            <MenuItem
              key={s.id}
              selected={s.id === styleId}
              onClick={() => { onPolicyChange?.({ response_style: s.id }); closeMenu(); }}
            >
              {t(s.nameKey)}
            </MenuItem>
          )) : null}
          {menu.key === 'model' ? models.map((m) => (
            <MenuItem
              key={m.id}
              selected={m.id === currentModel}
              onClick={() => { onPickModel?.(m.id); closeMenu(); }}
            >
              {m.label}
            </MenuItem>
          )) : null}
        </div>,
        document.body,
      )}
      </section>
    </>
  );
}
