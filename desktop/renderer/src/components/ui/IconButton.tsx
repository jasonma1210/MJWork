// UI 原语：正方形图标按钮（2026-10-28）
//
// 为什么需要：`ui-conventions` 的裸 <button> 基线只豁免「静态 className 且 h-N 与 w-N 等值」的
// 正方形图标按钮 —— 而 `className={...}` 动态表达式按口径**一律不豁免**（形态无法静态证明）。
// 于是「点击展开时图标转 45°」这类必须带条件 className 的图标按钮，一写就撑破基线。
// 收进 ui/ 后统计口径天然排除本目录，条件样式也能正常表达，不必为了过门禁把交互做残。
//
// 为什么不用 ui/Button：它的基础类含 `justify-center` + `px-*`，会撑开固定宽高让图标失真
// （rawButtonScan 注释里写明这正是「正方形图标按钮」需要单独豁免的原因）。
import type { ReactNode } from 'react';

export interface IconButtonProps {
  /** 无障碍名：同时用于 aria-label 与 title（图标按钮没有可见文字，二者必须同源） */
  label: string;
  /** 展开/选中态：底色 + 前景色提升。需要旋转请由调用方在 className 里传 rotate-* */
  active?: boolean;
  /** 展开态语义（有弹层的按钮必须给，否则读屏不知道它控制什么） */
  ariaExpanded?: boolean;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}

export default function IconButton({
  label, active = false, ariaExpanded, onClick, className = '', children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-expanded={ariaExpanded}
      className={[
        'shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-lg',
        'transition-colors duration-150',
        active ? 'bg-hover text-text' : 'text-text2 hover:bg-hover hover:text-text',
        className,
      ].filter(Boolean).join(' ')}
    >
      {children}
    </button>
  );
}
