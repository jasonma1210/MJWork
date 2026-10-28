// UI 原语：按钮（P1-9）
//
// 目标不是「做一个设计系统」（那是 P2-5 的事），而是给新增界面的实心主按钮/次按钮
// 一个统一出口，避免又一次把 `bg-accent-solid text-on-accent hover:brightness-110`
// 手写第七遍。只覆盖仓库里确实存在的五种形态，参数保持最小。
//
// 配色全部走 theme.css 的语义 token（accent-solid / on-accent / border / hover / danger-solid），
// 组件内零十六进制、零 Tailwind 调色板裸色。
//
// 尺寸三档（G7 (b)）：xs = 行内小按钮（h-6 / 圆角 rounded）、sm = 列表行内（h-7）、md = 表单主操作（h-8）。
// 为什么要第三档：仓库里真实存在一批 `px-2 py-1 rounded` 的小行内按钮（AgentDock 部署/移除、
// WorktreeBar、RecordReplayPanel 等），它们与 sm/md 的圆角与内边距都不同，无法零差异收敛。
// 同时把「圆角 + 间隙」从基础类下沉到尺寸档——Tailwind 同名工具类的冲突由**样式表顺序**决定，
// 消费方在外层 className 里写 `rounded`/`rounded-lg` 无法可靠覆盖基础类，只有分档才谈得上零差异。
// sm/md 的最终工具类集合与改造前**完全一致**（仅字符串顺序不同），故为零回归。
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'accent-ghost';
export type ButtonSize = 'xs' | 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-solid text-on-accent hover:brightness-110 border border-transparent',
  secondary: 'border border-border text-text2 hover:bg-hover hover:text-text bg-transparent',
  ghost: 'text-text2 hover:text-text bg-transparent border border-transparent',
  danger: 'bg-danger-solid text-on-accent hover:brightness-110 border border-transparent',
  // G7 (a)：描边危险色（可撤销的轻危险操作）——红边红字 + 危险底色 hover，覆盖仓库
  // 「破坏性描边按钮」这一现实形态（AgentDock / WorktreeBar / LocalMcpSection 等）。
  'danger-ghost': 'border border-danger text-danger hover:bg-danger-bg bg-transparent',
  // G7 (a-2)：描边主色（正向前进的轻操作）——主色边 + 主色字 + 主色浅底 hover，与 danger-ghost
  // 同形（对称取 accent token），覆盖「继续/运行分组」这类非实心的强调按钮。
  'accent-ghost': 'border border-accent text-accent hover:bg-accent-bg bg-transparent',
};

// xs = 行内小按钮（h-6 / px-2 / rounded-md / gap-1）；sm = 列表行内小按钮（h-7 / px-3 / rounded-md / gap-2）；
// md = 表单主操作（h-8 / px-4 / rounded-md / gap-2）。原型 r-1=8px 统一三档圆角（rounded-md → var(--radius-md)），
// 与卡片 rounded-xl(14px) 形成原型的两档半径；圆角与间隙按尺寸档区分，理由见文件头注释。
const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs rounded-md gap-1',
  sm: 'h-7 px-3 text-xs rounded-md gap-2',
  md: 'h-8 px-4 text-xs rounded-md gap-2',
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 进行中：禁用点击 + aria-busy，文案不变（避免按钮宽度跳动） */
  loading?: boolean;
  /** 胶囊形态（rounded-full）：案例快捷键等「自由行按钮」。在原语内替换圆角档 ——
   *  外层 className 覆盖 rounded-md 不可靠（同名工具类由样式表顺序决胜，见文件头），
   *  与 ChipButton（触发器）区分：胶囊无下拉箭头、纯动作。 */
  pill?: boolean;
  children?: ReactNode;
}

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  pill = false,
  className = '',
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const blocked = disabled || loading;
  // pill 在原语内换圆角档（rounded-md → rounded-full），不靠外层覆盖
  const sizeCls = pill ? SIZE_CLASS[size].replace('rounded-md', 'rounded-full') : SIZE_CLASS[size];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={blocked}
      aria-busy={loading || undefined}
      className={[
        'inline-flex items-center justify-center whitespace-nowrap',
        'transition-[color,transform] active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed',
        sizeCls,
        VARIANT_CLASS[variant],
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      )}
      {children}
    </button>
  );
}
