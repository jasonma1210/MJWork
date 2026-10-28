// UI 原语：菜单项（2026-10-28）
//
// 为什么单独抽出来：`ui/Button` 的基础类含 `justify-center` + `whitespace-nowrap`，
// 而菜单项需要**整行左对齐**（w-full / justify-start）；本文件头注释已写明「外层 className
// 无法可靠覆盖基础类的同名工具类（取决于样式表顺序）」，所以不能靠传 className 硬掰。
// 另外裸 `<button>` 有门禁基线（ui-conventions：收敛到 ui 原语），每加一处弹层就要重复
// 手写一遍行样式，也不符合「一个形态一个出口」。
//
// 形态对齐 PlusMenu 的 MenuRow（同 icon 尺寸 / 同 padding / 同 hover），
// 但只覆盖**当前真有消费方**的最小集（icon + label + onClick）。PlusMenu 的 MenuRow 还带
// hasSub / badge / disabledReason 等，那些等 PlusMenu 迁移过来时再按需扩展，
// 不预先造一堆没有调用方的分支。
import type { ReactNode } from 'react';

export interface MenuItemProps {
  icon?: ReactNode;
  label: string;
  onClick?: () => void;
  /** 危险操作（红字），当前无消费方时不要传 */
  danger?: boolean;
}

export default function MenuItem({ icon, label, onClick, danger = false }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 h-9 text-left text-xs hover:bg-hover ${
        danger ? 'text-danger' : 'text-text'
      }`}
    >
      {icon ? <span className="text-text2 shrink-0 inline-flex">{icon}</span> : null}
      <span className="flex-1 min-w-0 truncate">{label}</span>
    </button>
  );
}
