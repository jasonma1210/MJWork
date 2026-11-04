// UI 原语：会话级「技能 / 连接器」标签 + 可展开明细弹层。
//
// 用户需求（2026-11-04）：标签本体点击展开 / 再次点击收起对应清单；
// 弹层内可逐项删除（删一个或多个）；标签最右侧的 × 一次性清空本会话。
//
// 放在 components/ui/ 的两个硬约束：
//   · rawButtonScan 排除本目录 ⇒ 组件内的 <button> 不计入棘轮（明细行按钮每次都会加，
//     否则会顶高 ui-conventions 的 151 基线）；
//   · 本项目要求渲染层新文件必须是 .ts/.tsx（test/no-new-jsx.test.js 守）。
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconChevronDown, IconX } from '../icons';

export interface ExtrasChipItem {
  id: string;
  label: string;
}

export interface ExtrasChipProps {
  /** 行首图标（技能=闪电，连接器=插头） */
  icon: ReactNode;
  /** 触发器上的文字（已翻译，如「1 技能」） */
  label: string;
  /** 弹层标题（已翻译） */
  panelTitle: string;
  items: ExtrasChipItem[];
  /** 明细行删除按钮的无障碍名（已翻译） */
  removeItemLabel: string;
  /** 最外层 × 的无障碍名（已翻译，语义=清空本会话） */
  clearAllLabel: string;
  /** 空态文案（已翻译） */
  emptyLabel: string;
  onRemoveItem: (id: string) => void;
  onClearAll: () => void;
}

export default function ExtrasChip({
  icon, label, panelTitle, items, removeItemLabel, clearAllLabel, emptyLabel,
  onRemoveItem, onClearAll,
}: ExtrasChipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部 / Esc 关闭：非模态 popover，捕获阶段监听，避免与 Composer 的 Esc 处理冲突。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      <span className="text-xs px-2 py-1 rounded bg-accent-bg text-accent flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="inline-flex items-center gap-1 hover:opacity-80"
        >
          <span className="inline-flex shrink-0">{icon}</span>
          <span className="tabular-nums">{label}</span>
          <IconChevronDown size={10} className="shrink-0 opacity-60" />
        </button>
        <button type="button" onClick={onClearAll} aria-label={clearAllLabel} className="hover:opacity-70">
          <IconX size={10} />
        </button>
      </span>

      {open && (
        <div
          role="dialog"
          aria-label={panelTitle}
          className="absolute left-0 bottom-full mb-2 w-64 bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] z-palette overflow-hidden"
        >
          <div className="px-3 py-2 text-xs font-medium text-text2 border-b border-border truncate">
            {panelTitle}
          </div>
          {items.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text2">{emptyLabel}</div>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1">
              {items.map((it) => (
                <li key={it.id} className="flex items-center gap-2 px-3 py-1 hover:bg-hover">
                  <span className="min-w-0 flex-1 truncate text-xs text-text" title={it.label}>{it.label}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveItem(it.id)}
                    aria-label={removeItemLabel}
                    className="shrink-0 hover:opacity-70"
                  >
                    <IconX size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
