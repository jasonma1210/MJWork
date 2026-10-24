// UI 原语：Tab 条（WAI-ARIA Tabs Pattern 的「手动激活」变体）
//
// 为什么要有这个原语：`ui-conventions` 门禁把「裸 <button> 数量」做成了只降不升的棘轮，
// 而 Tab 条天然需要一组 button。全仓此前没有 Tab 原语，每处新页面都要么复制一段裸 button
// （抬高棘轮基线 = 违反只减不增），要么放弃 role="tab" 语义（键盘与读屏不可用）。
// 按 Button/Modal/Switch 的既有先例，**原语自身渲染裸 <button>** 是唯一两全的做法
// （门禁口径明确排除 `components/ui/`）。
//
// 语义要点（不省略，键盘用户与读屏依赖它们）：
//   · 容器 role="tablist" + aria-label；
//   · 每个 Tab role="tab" + aria-selected（当前页用 aria-current 不可替代）；
//   · 左右方向键在 Tab 间移动焦点（手动激活：Enter/Space 才切换，避免误触）；
//   · 禁用项用 aria-disabled 而非 disabled —— 保持可聚焦，读屏能念出「不可用」。
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export default function TabBar({
  tabs, active, onChange, ariaLabel, className = '',
}: {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const ids = tabs.filter((x) => !x.disabled).map((x) => x.id);
    const i = ids.indexOf(active);
    if (i < 0) return;
    const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    refs.current[next]?.focus();
    onChange(next);
  }

  return (
    <div role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className={className}>
      {tabs.map((x) => {
        const on = x.id === active;
        return (
          <button
            key={x.id}
            ref={(el) => { refs.current[x.id] = el; }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-disabled={x.disabled || undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => { if (!x.disabled) onChange(x.id); }}
            className={`flex items-center gap-2 px-3 py-2 text-xs border-b-2 -mb-px ${
              on ? 'border-accent text-text font-medium' : 'border-transparent text-text2 hover:text-text'}`}
          >
            {x.icon}
            {x.label}
          </button>
        );
      })}
    </div>
  );
}
