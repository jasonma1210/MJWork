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
//   · ↵ 派单 → 真绑定 Enter（IME-safe），见 onKeyDown
// 原型还有「附件 / 怎么干这一单 / 预算 ¥」三个控件，**刻意不补**：
//   · 附件与运行模式的真身都在 ChatArea 内部 state（attachments / runMode），desk 拿不到，
//     复制一套会变成两处都能改、又都不生效 / 不唯一；
//   · 预算 ¥ 全仓无价格表，做了就是死控件（团队预算三元组在 teamStore，只在挂军团时才有意义）。
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import Button from '../ui/Button';
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
}

export default function DeskIntake({
  policies = [], onPolicyClick, onDispatch, models = [], currentModel, onPickModel,
}: DeskIntakeProps) {
  const { t } = useI18n();
  const [goal, setGoal] = useState('');
  const trimmed = goal.trim();
  const dispatch = () => { if (trimmed) onDispatch?.(trimmed); };

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

        <span className="text-caption text-text2" aria-hidden="true">{t('desk.intake.sendHint')}</span>

        <Button variant="primary" size="md" className="ml-auto" disabled={!trimmed} onClick={dispatch}>
          {t('desk.intake.dispatch')}
        </Button>
      </div>
    </section>
  );
}
