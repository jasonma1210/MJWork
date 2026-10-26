// 工作场景预设卡（4 张）—— 供「新建会话」使用
//
// 为什么在这里而不在工作台：
//   工作台（desk）是「开工前一屏」的概览面。原型 desk 的接单区就是一个输入框 + 一行工具条，
//   不该被 4 张预设卡占掉一半高度、把六个状态板块全推到首屏之外。
//   而「新建会话」才是从零起步、最需要引导的地方 —— 那里原本是 4 张泛泛的快捷动作卡
//   （探索 / 构建 / 审查 / 修复），换成带目标模板与常用指令的场景卡，才真正对上「以工作为主」。
//
// 数据与文案复用 desk 模块（`lib/deskPresets.ts` + `i18n/locales/*/desk.json`），不另建一份：
//   同一份场景定义在两处渲染，若各存一套，改一处忘另一处就是「两个事实来源」。
//
// 点击语义（与 desk 一致）：套用模板 / 填入指令都只是**把文本交给调用方**，
// 由调用方决定填进输入框还是直接发送 —— 本组件不持有任何状态，也不派单。
import Button from '../ui/Button';
import { DESK_SCENARIOS } from '../../lib/deskPresets';
import { useI18n } from '../../i18n';

export interface ScenarioCardsProps {
  /** 套用模板 / 填入指令 —— 只把文本交出去 */
  onApply: (text: string) => void;
}

export default function ScenarioCards({ onApply }: ScenarioCardsProps) {
  const { t } = useI18n();
  return (
    <>
      {DESK_SCENARIOS.map((s) => {
        const Icon = s.Icon;
        return (
          // flex-col + grid stretch ⇒ 同排等高，底边对齐
          <article
            key={s.id}
            className="flex flex-col rounded-2xl border border-border p-4 transition-colors hover:border-accent"
          >
            <div className="flex min-w-0 items-center gap-2 text-accent">
              <span className="shrink-0"><Icon size={18} /></span>
              <b className="truncate text-sm font-semibold text-text">{t(s.nameKey)}</b>
            </div>
            {/* 描述限两行：四张卡描述长短不一，不限行会让下方按钮高度错位 */}
            <p className="mt-1 line-clamp-2 text-caption leading-snug text-text2">{t(s.descKey)}</p>
            <Button variant="secondary" size="xs" className="mt-3 self-start" onClick={() => onApply(t(s.goalKey))}>
              {t('desk.intake.applyTemplate')}
            </Button>
            {/* 指令区与「套用模板」用上边框分组。
                ⚠ w-full / min-w-0 与 text-left 必须落在 Button 及其 span 上：
                Button 基础类是 inline-flex + whitespace-nowrap + justify-center，
                外层传 justify-start 会被样式表顺序吃掉，span 不加 w-full 则 truncate 无宽度约束、
                文字直接冲出卡片（真机截图踩过）。 */}
            <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
              {s.cmdKeys.map((k) => (
                <li key={k} className="min-w-0">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-full min-w-0"
                    title={t(k)}
                    onClick={() => onApply(t(k))}
                  >
                    <span className="w-full truncate text-left">{t(k)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </>
  );
}
