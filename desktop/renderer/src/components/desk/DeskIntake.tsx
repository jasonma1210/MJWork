// 工作台 · 接单输入区（目标文案 + 模型 + 档位只读回显 + 派单）
//
// 形态对齐原型 desk 的 `.card.intake`：**一个输入框 + 一行工具条**。
// 场景预设卡**不在这一屏**——原型没有，且四张卡会把下面六个状态板块推出首屏；
// 它们已移到「新建会话」（components/desk/ScenarioCards.tsx）。
//
// 职责边界（刻意收窄）：只做「收集目标文案 / 选模型 / 回显当前档位」，
// **不写入任何配置**。档位的事实来源是设置页，这里只逐个回显、点击跳过去改 ——
// 让 desk 也能改，等于制造第二条事实来源（两处都能改、又都不是唯一真相，用户会先怀疑数据坏了）。
//
// 工具条里**只放真有落点的控件**：
//   · 模型   → 原型同款原生 <select>，值来自 App 的 allProviders，选了就生效（下一次对话就用它）
//   · 档位   → 只读回显 + 跳设置
//   · ↵ 仍真绑定 Enter（IME-safe，见 onKeyDown）
//   · + 加号 → 2026-10-28 第二版：**直接复用主输入框的 PlusMenu 组件**，不再自建精简菜单。
//     第一版我判断「员工/技能/连接器都要求已有会话，接单时没有 ⇒ 会变死控件」，这个判断偏保守：
//     派单本身就是「即将创建会话」，选员工/技能/连接器都是有效的**派单前意图**。
//     落点机制（不新开第二套 extras）：
//       PlusMenu 选中的 extras 存在本组件 state，派单时随 onDispatch 传出；App 建线程后写
//       `mj_extras_<threadId>` 存档 —— ChatArea 切到该线程时按同一条 localStorage 通道恢复，
//       与「会话内用 + 菜单选员工」完全等价。
//     三处确实无落点，改为点击即提示（不留静默按钮）：
//       语音输入（麦克风由会话侧 voice 句柄驱动）、工作模式（runMode 是 ChatArea 内部 state，
//       不持久化，无法带到新线程）。
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import PlusMenu from '../PlusMenu';
import { toast } from '../feedback';
import { IconPlus } from '../icons';
import { useI18n } from '../../i18n';

/** 派单时携带的会话内扩展（与 PlusMenu 的 extras 同形；App 建线程后写入 mj_extras_<id>） */
export interface DeskExtras {
  expert?: unknown;
  skillIds?: string[];
  mcpServers?: string[];
}

/** 档位回显的一行（label / value 都已由调用方解析成显示文案） */
export interface DeskPolicyEcho {
  label: string;
  value: string;
}

/** 模型下拉的一项（由 App 从 allProviders 摊平后传入） */
export interface DeskModelOption {
  id: string;
  label: string;
}

export interface DeskIntakeProps {
  /** 当前档位的只读回显（事实来源是 App 的 approvalSettings 状态） */
  policies?: readonly DeskPolicyEcho[];
  /** 点击档位：到设置页修改（desk 自身不提供编辑能力） */
  onPolicyClick?: () => void;
  /** 派单：目标 + 会话内扩展（App 建线程后写入 mj_extras_<id>，ChatArea 切换时恢复） */
  onDispatch?: (goal: string, extras: DeskExtras) => void;
  /** 当前项目路径：仅用于 PlusMenu 判断「从会话中引用 / 工作模式」等项是否可用 */
  projectPath?: string;
  /** 可选模型列表；为空则不渲染选择器（不显示一个空下拉） */
  models?: readonly DeskModelOption[];
  /** 当前模型 key */
  currentModel?: string;
  /** 切换模型 */
  onPickModel?: (id: string) => void;
}

export default function DeskIntake({
  policies = [], onPolicyClick, onDispatch, models = [], currentModel, onPickModel, projectPath,
}: DeskIntakeProps) {
  const { t } = useI18n();
  const [goal, setGoal] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  // 派单前选中的会话内扩展（数字员工 / 技能 / 连接器）—— 与 PlusMenu 的 extras 同形，
  // 派单时随目标一起交给 App，由 App 写入新线程的 extras 存档（详见文件头落点说明）。
  const [extras, setExtras] = useState<DeskExtras>({});
  const trimmed = goal.trim();
  const dispatch = () => { if (trimmed) onDispatch?.(trimmed, extras); };

  // 点外部关闭 / Esc 由 PlusMenu 自己处理（组件内 rootRef + document 监听），此处不重复实现。

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
  // 这也是原型那个 ⌘↵ 提示的正确落地方式 —— 提示存在的前提是它**真的能用**。
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    e.preventDefault();
    dispatch();
  };

  return (
    <section className="shrink-0 rounded-xl border border-border bg-surface p-4" aria-label={t('desk.intake.label')}>
      <label htmlFor="desk-intake-goal" className="block text-caption text-text2 mb-1">
        {t('desk.intake.label')}
      </label>
      <textarea
        id="desk-intake-goal"
        rows={3}
        className="block w-full min-h-[66px] resize-y border-0 bg-transparent text-sm leading-relaxed text-text outline-none placeholder:text-text2"
        placeholder={t('desk.intake.placeholder')}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {policies.map((p) => (
          <Button key={p.label} variant="secondary" size="xs" title={t('desk.intake.policyHint')} onClick={() => onPolicyClick?.()}>
            {p.label} · {p.value}
          </Button>
        ))}

        {models.length > 0 ? (
          <label className="inline-flex items-center gap-1 text-caption text-text2">
            <span className="shrink-0">{t('desk.intake.model')}</span>
            {/* 原生 select 而非 ModelSelector：原型 desk 用的就是 <select>，
                而 ModelSelector 是带思考档位能力门控的 500 行组件，这里只需「选一个模型」。 */}
            <select
              value={currentModel || ''}
              onChange={(e) => onPickModel?.(e.target.value)}
              className="h-6 max-w-[220px] rounded border border-border bg-transparent px-1 text-caption text-text outline-none"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
        ) : null}

        {/* 加号：**复用主输入框的 PlusMenu**（不再自建菜单）—— 菜单项、分组、子面板、
            搜索框全部与会话内一致，避免两套菜单各自漂移。
            容器的 relative 决定弹层定位：PlusMenu 用 `absolute left-0 bottom-full`，
            因此它会从整条工具条的左边缘向上弹出（与主输入框的观感一致）。 */}
        <div className="relative ml-auto shrink-0">
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
              open={plusOpen}
              onClose={() => setPlusOpen(false)}
              onPickFiles={addFiles}
              hasProject={!!projectPath}
              // runMode / onSelectTeam 在 PlusMenu 里无默认值：显式传 undefined 表示「本场景没有」。
              // 模式面板由下方 onModeChange 给提示，团队面板显示无可用团队（不静默、不假装可用）。
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
    </section>
  );
}
