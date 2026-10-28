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
//   · ↵ 仍真绑定 Enter（IME-safe，见 onKeyDown）；冗余的「↵ 派单」视觉提示文本已移除（与派单按钮文案重复）
//   · + 加号菜单 → 2026-10-28 改为弹出菜单（此前是「直接跳新建会话」，与主输入框的 + 行为不一致：
//     那边的 + 是弹菜单，不会把用户从当前页面带走）。菜单只保留两项**真有落点**的：
//       ① 添加文件…：走与主输入框同一 IPC（pickFiles），选完以 `@路径` 拼进目标文案 ——
//          与 useAgentRun 的附件注入同一约定（模型经 read_file 能读到），不需要新的 attahcments 通道；
//       ② 新建会话：原 + 的功能保留在这里，不至于"改了一致性却丢了能力"。
//     刻意**不接完整 PlusMenu**：它的其余项（从会话中引用 / 运行模式 / 数字员工 / 技能 /
//     连接器 / 团队编制）语义都要求「已有一个会话」，而接单时**还没有会话**。PlusMenu 对缺失
//     回调一律用 `?.()` 静默吞掉 —— 接进来会变成一排"点了没反应"的死控件，比不一致更糟。
// 原型还有「怎么干这一单 / 预算 ¥」两个控件**仍刻意不补**：前者无对应 state；
// 后者全仓无价格表，做了就是死控件（团队预算三元组在 teamStore，只在挂军团时才有意义）。
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import MenuItem from '../ui/MenuItem';
import { IconFilePlus, IconPlus } from '../icons';
import { useI18n } from '../../i18n';

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
  /** 派单：把目标交回主链路，与 AssistantPage 的 onAutoRun 完全同构 */
  onDispatch?: (goal: string) => void;
  /** 可选模型列表；为空则不渲染选择器（不显示一个空下拉） */
  models?: readonly DeskModelOption[];
  /** 当前模型 key */
  currentModel?: string;
  /** 切换模型 */
  onPickModel?: (id: string) => void;
  /** 新建会话：同侧栏「新建任务」，退出 desk 回到新会话（与新建会话 + 同功能） */
  onNewThread?: () => void;
}

export default function DeskIntake({
  policies = [], onPolicyClick, onDispatch, models = [], currentModel, onPickModel, onNewThread,
}: DeskIntakeProps) {
  const { t } = useI18n();
  const [goal, setGoal] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement | null>(null);
  const trimmed = goal.trim();
  const dispatch = () => { if (trimmed) onDispatch?.(trimmed); };

  // 加号菜单：点外部 / Esc 关闭（与 PlusMenu 同一交互预期，避免菜单"点不掉"）
  useEffect(() => {
    if (!plusOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (!plusRef.current?.contains(e.target as Node)) setPlusOpen(false);
    };
    const onEsc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setPlusOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [plusOpen]);

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

        {/* 加号：与主输入框（Composer）同一套交互 —— 点击弹菜单、展开时图标转 45°、带 aria-expanded。
            此前这里是「点击直接新建会话」，属于同一个图标两种行为，用户预期落空。 */}
        <div className="relative ml-auto shrink-0" ref={plusRef}>
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
            <div
              role="menu"
              className="absolute right-0 bottom-full mb-2 w-[200px] bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] overflow-hidden z-palette"
            >
              <MenuItem icon={<IconFilePlus size={15} />} label={t('plusMenu.addFiles')} onClick={addFiles} />
              <MenuItem
                icon={<IconPlus size={15} />}
                label={t('desk.intake.newThread')}
                onClick={() => { setPlusOpen(false); onNewThread?.(); }}
              />
            </div>
          )}
        </div>

        <Button variant="primary" size="md" disabled={!trimmed} onClick={dispatch}>
          {t('desk.intake.dispatch')}
        </Button>
      </div>
    </section>
  );
}
