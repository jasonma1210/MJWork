import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// 通用右键菜单（对标 WorkBuddy 侧栏项目菜单：打开文件夹 / 在编辑器中打开 / 重命名 / 从列表中移除）
//
// 定位：以鼠标点为锚点渲染，渲染后按实际尺寸做一次视口回收（flip + clamp），
// 避免贴右/贴底边缘时菜单被裁掉——纯 CSS 做不到「先测量再定位」，必须量一次。
const MENU_MIN_W = 176;

/**
 * 菜单项契约（F-005：此前 `items = []` 被 TS 推成 never[]，导致所有调用方传数组都报 TS2322）。
 * @typedef {object} MenuItem
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [title]
 * @property {any} [icon] 线性图标组件（接收 size）
 * @property {() => void} [onClick]
 * @property {boolean} [separator] 为真时渲染分隔线，其余字段忽略
 * @property {boolean} [danger]
 * @property {boolean} [disabled]
 */

/**
 * @param {{ open?: boolean, x?: number, y?: number, items?: MenuItem[], onClose?: () => void }} props
 */
export default function ContextMenu({ open, x = 0, y = 0, items = [], onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });

  // 打开时先按鼠标点落位，再按实际尺寸回收进视口
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth || MENU_MIN_W;
    const h = el.offsetHeight || 0;
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - w - pad);
    const maxTop = Math.max(pad, window.innerHeight - h - pad);
    setPos({ left: Math.min(Math.max(pad, x), maxLeft), top: Math.min(Math.max(pad, y), maxTop), ready: true });
  }, [open, x, y, items.length]);

  // 关闭：Esc / 点击别处 / 滚动 / 窗口尺寸变化
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } };
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose?.(); };
    const onScroll = () => onClose?.();
    window.addEventListener('keydown', onKey);
    // capture：侧栏容器自己会 stopPropagation 的处理不影响这里
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('blur', onScroll);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('blur', onScroll);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      className="fixed z-menu min-w-[176px] py-1 bg-raise border border-border rounded-xl shadow-[var(--shadow-menu)]"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.separator) return <div key={`sep-${i}`} className="my-1 border-t border-border" />;
        const Icon = it.icon;
        return (
          <button
            key={it.id || it.label}
            role="menuitem"
            disabled={it.disabled}
            onClick={(e) => { e.stopPropagation(); onClose?.(); it.onClick?.(); }}
            title={it.title || undefined}
            className={`w-full flex items-center gap-3 px-3 py-2 text-xs text-left disabled:opacity-40 disabled:cursor-not-allowed ${
              it.danger ? 'text-danger hover:bg-danger-bg' : 'text-text hover:bg-hover'
            }`}
          >
            {Icon && <span className="shrink-0 flex items-center">{<Icon size={14} />}</span>}
            <span className="truncate">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
