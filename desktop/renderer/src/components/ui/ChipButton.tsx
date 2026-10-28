// UI 原语：工具条芯片触发器（图标 + 当前值 + 下拉箭头）
//
// 逐字对齐 ComposerControls 的 CHIP 设计语言（h-7 / rounded-lg / 透明底 + 描边 / 悬停现底色），
// 收进 components/ui/ 使 rawButtonScan 不计数（门禁排除 ui/）——消费方（接单台等）用芯片
// 触发自定义弹出面板时不再手写裸 <button>。风险警示态（never / 完全访问）参数化为 warn，
// 不靠 className 覆盖（border-border 与 border-warn 同权重拼接靠样式表顺序决胜，不可靠）。
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { IconChevronDown } from '../icons';

export interface ChipButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 行首图标（可选） */
  icon?: ReactNode;
  /** 风险警示态：warn 边框 + warn 底色 + warn 文字（与默认 border-border 互斥拼接） */
  warn?: boolean;
  /** 当前值（触发器上显示的文字，超长截断） */
  children?: ReactNode;
}

export default function ChipButton({ icon, warn = false, className = '', onClick, children, ...rest }: ChipButtonProps) {
  // onClick 必须显式落 attribute（不藏进 ...rest）：「无装饰性死按钮」断言静态扫描 open tag，
  // spread 里的 onClick 对它不可见 —— ui/Button 同款写法。
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="listbox"
      className={[
        'h-7 inline-flex items-center gap-2 rounded-lg border px-2 text-xs bg-transparent',
        'hover:bg-hover cursor-pointer transition-colors max-w-[220px]',
        warn ? 'border-warn bg-warn-bg text-warn' : 'border-border text-text',
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {icon ? <span className="inline-flex shrink-0">{icon}</span> : null}
      <span className="min-w-0 truncate">{children}</span>
      <IconChevronDown size={10} className="shrink-0 opacity-60" />
    </button>
  );
}
