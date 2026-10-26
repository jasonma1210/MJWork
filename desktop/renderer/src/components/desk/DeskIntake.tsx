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
        {/* gap-3（12px）而非 gap-2（8px）：四列在 1070px 内容区下每卡仅约 250px，
            8px 间隙会让四张卡在视觉上黏成一片。断点保持 md 2 列 / xl 4 列不变——
            指令是「点了就填进输入框」的快捷项，不要求先读全，靠 truncate + title 兜底。 */}
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {DESK_SCENARIOS.map((s) => {
            const Icon = s.Icon;
            // hover 用 **fill-2**（7%）而不是 fill-1（4%）：三档 fill 的语义是
            // 「1 档静置底 / 2 档 hover / 3 档选中」。实测 fill-1 在 dark 下合成 #272727
            // 对 surface #1e1e1e 只有 1.116:1、light 下 1.083:1 —— 场景卡是这一屏的
            // 主要交互元素，1.08 的反馈基本看不见。
            return (
              // flex-col + grid stretch ⇒ 同排卡片等高，底部不再参差
              <article key={s.id} className="flex flex-col rounded-lg border border-border p-3 transition-colors hover:bg-fill-2">
                <div className="flex min-w-0 items-center gap-2 text-text">
                  <span className="shrink-0"><Icon size={14} /></span>
                  <b className="truncate text-xs font-semibold">{t(s.nameKey)}</b>
                </div>
                {/* desc 最多两行：四张卡描述长度不一，不限行会让下方的「套用模板」高度错位 */}
                <p className="mt-1 line-clamp-2 text-caption text-text2">{t(s.descKey)}</p>
                <Button variant="secondary" size="xs" className="mt-2 self-start" onClick={() => setGoal(t(s.goalKey))}>
                  {t('desk.intake.applyTemplate')}
                </Button>
                {/* 指令区：与「套用模板」用上边框分组，避免四个元素在同一团白里堆叠。
                    ⚠ 这里的 w-full / min-w-0 不是装饰：Button 基础类是 inline-flex + whitespace-nowrap，
                    没有 w-full 时宽度由文字撑开，truncate 的 span 就失去宽度约束 ⇒ 文字直接冲出卡片
                    （真机截图里串到相邻卡片的那个 bug）。title 给完整文案兜底。 */}
                <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                  {s.cmdKeys.map((k) => (
                    <li key={k} className="min-w-0">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="w-full min-w-0 text-left"
                        title={t(k)}
                        onClick={() => setGoal((v) => (v ? `${v}\n${t(k)}` : t(k)))}
                      >
                        {/* 左对齐必须落在 span 上，不能只靠 className 传 justify-start：
                            Button 基础类含 justify-center，同名工具类的胜负由**样式表顺序**决定，
                            消费方在外层覆盖不掉（真机渲染出来是居中的，与卡内其它左对齐内容割裂）。 */}
                        <span className="w-full truncate text-left">{t(k)}</span>
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
