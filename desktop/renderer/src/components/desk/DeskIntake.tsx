// 工作台 · 接单输入区（目标文案 + 工作场景预设 + 档位只读回显）
//
// 职责边界（刻意收窄）：只做「收集目标文案 / 套用模板 / 回显当前档位」，
// **不写入任何配置**。场景预设的团队、运行模式、沙箱、拆分粒度在原型里是配置项，
// 但在本仓它们的事实来源是 Composer 控制台与设置页 —— 让 desk 也能改，等于制造
// 第二条事实来源（两处都能改、又都不是唯一真相，用户会先怀疑数据坏了）。
// 故这里只把 App 传进来的 policies 逐个回显，点击跳设置页改。
//
// 「套用模板」与「填入指令」都**只预填输入框**，不派单、不改运行态：
// 占位符（{source} 等）刻意保留给用户自己替换 —— 模板的目标是省去「从空白开始」，
// 不是替用户猜参数。故 goal.* / cmd.* 一律**无参调用** t()，不传 params。
import { useState } from 'react';
import Button from '../ui/Button';
import { DESK_SCENARIOS } from '../../lib/deskPresets';
import { useI18n } from '../../i18n';

/** 档位回显的一行（label / value 都已由调用方解析成显示文案） */
export interface DeskPolicyEcho {
  label: string;
  value: string;
}

export interface DeskIntakeProps {
  /** 当前档位的只读回显（事实来源是 App 的 approvalSettings 状态） */
  policies?: readonly DeskPolicyEcho[];
  /** 点击档位：到设置页修改（desk 自身不提供编辑能力） */
  onPolicyClick?: () => void;
  /** 派单：把目标交回主链路，与 AssistantPage 的 onAutoRun 完全同构 */
  onDispatch?: (goal: string) => void;
}

export default function DeskIntake({ policies = [], onPolicyClick, onDispatch }: DeskIntakeProps) {
  const { t } = useI18n();
  const [goal, setGoal] = useState('');
  const trimmed = goal.trim();
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
      />

      <div className="mt-2 pt-3 border-t border-border">
        <p className="text-xs text-text">{t('desk.intake.presetsLabel')}</p>
        <p className="mt-1 text-caption text-text2">{t('desk.intake.presetsHint')}</p>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
          {DESK_SCENARIOS.map((s) => {
            const Icon = s.Icon;
            return (
              <article key={s.id} className="rounded-lg border border-border p-3 transition-colors hover:bg-fill-1">
                <div className="flex items-center gap-2 text-text">
                  <Icon size={14} />
                  <b className="text-xs font-semibold truncate">{t(s.nameKey)}</b>
                </div>
                <p className="mt-1 text-caption text-text2">{t(s.descKey)}</p>
                <Button variant="secondary" size="xs" className="mt-2" onClick={() => setGoal(t(s.goalKey))}>
                  {t('desk.intake.applyTemplate')}
                </Button>
                <ul className="mt-2 flex flex-col gap-1">
                  {s.cmdKeys.map((k) => (
                    <li key={k} className="min-w-0">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="justify-start text-left"
                        title={t('desk.intake.insertCommand')}
                        onClick={() => setGoal((v) => (v ? `${v}\n${t(k)}` : t(k)))}
                      >
                        <span className="truncate">{t(k)}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {policies.map((p) => (
          <Button key={p.label} variant="secondary" size="xs" title={t('desk.intake.policyHint')} onClick={() => onPolicyClick?.()}>
            {p.label} · {p.value}
          </Button>
        ))}
        <Button variant="primary" size="md" className="ml-auto" disabled={!trimmed} onClick={() => { if (trimmed) onDispatch?.(trimmed); }}>
          {t('desk.intake.dispatch')}
        </Button>
      </div>
    </section>
  );
}
