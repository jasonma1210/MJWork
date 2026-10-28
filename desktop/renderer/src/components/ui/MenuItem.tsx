// UI 原语：弹出菜单行（左对齐，P1-9 体系补缺）
//
// 为什么是独立原语而不是 ui/Button 变体：
//   Button 基础类含 justify-center + px-*，菜单行需要 w-full text-left + 悬停底色，
//   外层 className 无法可靠覆盖（同名工具类由样式表顺序决胜，见 Button.tsx 文件头）；
//   而手写裸 <button> 会被 rawButtonScan 计入棘轮基线（164 只降不升）。
//   门禁排除 components/ui/ —— 菜单行收进原语，消费方（DeskIntake 弹出面板等）零裸按钮。
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { IconCheck } from '../icons';

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 行首图标（可选；统一 text-text2，选中态随行变色） */
  icon?: ReactNode;
  /** 选中态：文字转主色 + 行尾 ✓ */
  selected?: boolean;
  children?: ReactNode;
}

export default function MenuItem({ icon, selected = false, className = '', onClick, children, ...rest }: MenuItemProps) {
  // onClick 必须显式落 attribute（不藏进 ...rest）：「无装饰性死按钮」断言静态扫描 open tag，
  // spread 里的 onClick 对它不可见 —— ui/Button 同款写法。
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-hover',
        selected ? 'text-accent' : 'text-text',
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {icon ? <span className="inline-flex shrink-0 text-text2">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <IconCheck size={12} className="shrink-0" /> : null}
    </button>
  );
}
