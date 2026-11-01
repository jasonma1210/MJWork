// UI 原语：复选框（对标 WorkBuddy 输入框下方的「Worktree」勾选框）
//
// 为什么不直接用 ui/Switch：那是「开关」，语义是「持续生效的状态」；这里要表达的是
// 「这一次任务带不带这个选项」——WB 的实现就是 `role="checkbox"` + 方形勾选框，
// 用户对「勾选」与「开关」的预期不同（勾选更像一次性选项）。两者并存不冲突：
// Switch 继续服务设置页的长期偏好，Checkbox 服务这种「本次带不带」。
//
// 视觉不变量（对照 WB：16px 方框 + 3px 圆角 + 勾在内）：
//   方框 w-4 h-4（16px）/ rounded-[4px] / 未选 border-border / 选中 bg-accent + border-accent
//   勾用线性 SVG（stroke=currentColor），颜色取 on-accent —— 与仓库「零装饰性字形」口径一致
//   勾不出现时也要占位：否则选中瞬间文字左移 1px，整行在切换时抖动
//
// 放在 components/ui/ 下还有一个硬原因：rawButtonScan 排除 ui/，手写裸 <button> 会顶高
// 「裸 button 只降不升」的棘轮基线（151）。
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { IconCheck } from '../icons';

export interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onChange'> {
  checked: boolean;
  /** 切换回调：收到的是「目标态」，调用方不必自己取反 */
  onChange: (next: boolean) => void;
  /** 可访问名称（必填：勾选框旁的文字不一定是它的 label） */
  label: string;
  /** 可见文字（勾选框右侧），缺省只渲染方框 */
  children?: ReactNode;
}

export default function Checkbox({
  checked, onChange, label, children, className = '', disabled = false, onClick, ...rest
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      // onClick 显式落 attribute（不藏进 ...rest）：无装饰性死按钮的断言静态扫描 open tag
      onClick={(e) => { onClick?.(e); if (!disabled) onChange(!checked); }}
      className={[
        'inline-flex items-center gap-2 rounded-lg border px-2 h-7 text-xs transition-colors',
        checked ? 'border-accent bg-accent-bg text-accent' : 'border-border text-text2 hover:bg-hover',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={[
          'w-4 h-4 shrink-0 rounded-[4px] border inline-flex items-center justify-center transition-colors',
          checked ? 'bg-accent-solid border-accent-solid text-on-accent' : 'border-border text-transparent',
        ].join(' ')}
      >
        <IconCheck size={11} />
      </span>
      {children ? <span className="shrink-0">{children}</span> : null}
    </button>
  );
}
