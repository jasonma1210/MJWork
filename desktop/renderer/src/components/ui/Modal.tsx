// UI 原语：模态对话框（P1-9）
//
// 背景：改造前全仓 `role="dialog"` / `aria-modal` **零命中**——9 处模态（设置、生态中心、
// 市场、归档、命令面板、项目选择、连接器配置、自定义连接器、全局确认框）都只是一个
// `fixed inset-0` 的 div：没有对话框语义、没有焦点陷阱、Esc 不关、关闭后焦点丢到 <body>。
// 键盘用户 Tab 十几下才穿得过去，屏幕阅读器也不会念「对话框」。
//
// 本组件按 W3C WAI-ARIA Authoring Practices 的 Dialog (Modal) Pattern 实现：
//   role="dialog" + aria-modal="true" + aria-labelledby（标题 id）
//   + 打开时把焦点移进面板（第一个可聚焦元素，没有则面板自身 tabIndex=-1）
//   + Tab / Shift+Tab 在面板内成环（keydown，捕获阶段）
//   + focusin 兜底：焦点被鼠标/脚本挪出面板时拉回来
//   + Esc 关闭、遮罩点击关闭（可关）+ 关闭时 previousActive.focus() 归还焦点
//   + aria-live="polite" 通知区（异步结果朗读，不改可见布局）
//
// 两个安全阀（焦点陷阱写错会锁死键盘，必须留逃生口）：
//   ① Esc 恒可关（除非调用方显式 closeOnEsc={false}，目前无人使用）；
//   ② 焦点环退化为「没有可聚焦元素 → 聚焦面板本身」，永不留空白焦点。
// 嵌套场景（数字员工表单叠在生态中心之上）：用模块级栈保证**只有最上层**处理 Esc 与
// focusin 兜底，否则外层会把内层的焦点抢回去。
import {
  useEffect, useId, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import { IconX } from '../icons';
import { useI18n } from '../../i18n';

/** 四档宽度（设置页 settings 档刻意保留旧外壳的两个 className，见下） */
export const MODAL_SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  settings: 'max-w-4xl',
} as const;
export type ModalSize = keyof typeof MODAL_SIZES;

// 遮罩/面板类名。settings 档沿用设置页浮窗的原字符串——
// `test/settings-coverage.test.js` 对「设置页必须是居中浮窗而非满窗」有源码字符串断言，
// 后续把 SettingsModal 外壳换成 <Modal size="settings"> 时这两个类名原样存在，断言无需改测试。
const OVERLAY_CLASS = 'fixed inset-0 z-settings flex items-center justify-center bg-overlay';
const PANEL_CLASS = 'w-full rounded-2xl shadow-[var(--shadow-modal)] bg-bg border border-border flex flex-col max-h-[85vh] overflow-hidden';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    // 只留真正可交互的：隐藏/零面积元素（折叠区、display:none 的子面板）不进焦点环
    .filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
}

// 打开中的模态栈：只有栈顶处理 Esc 与 focusin 兜底（嵌套时外层不得抢焦点）
const MODAL_STACK: string[] = [];
const isTopOfStack = (id: string) => MODAL_STACK[MODAL_STACK.length - 1] === id;

/**
 * 焦点是否落在「别人的对话框」里（命令式 confirm / toast 确认层、其它未走本组件的模态）。
 *
 * 为什么必须判：`feedback.jsx` 的 confirm 是**命令式全局弹窗**，它不注册到本组件的栈，
 * 但它自带 `aria-modal="true"`。若本组件不看这一点，会在 confirm 打开时把焦点抢回自己的
 * 面板 —— 用户按 Tab 找不到 confirm 的按钮，按 Esc 还会把底下的设置页一起关掉。
 * 判据用 `closest('[aria-modal="true"],[role="dialog"]')`：焦点元素自底向上能找到
 * 另一个对话框祖先，就说明当前是别人在接管键盘。
 */
function foreignDialogOwnsFocus(root: HTMLElement | null): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || !root) return false;
  if (root.contains(active)) return false;
  try {
    return !!active.closest('[aria-modal="true"],[role="dialog"]');
  } catch { /* 选择器不会变（字面量），这里只兜「元素不在文档树/已卸载」：此时判定为「无人抢占键盘」= 退回本面板自理，与改动前行为一致 */ return false; }
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 对话框可访问名称（同时渲染为可见标题；`titleNode` 可覆盖渲染内容） */
  title?: string;
  titleNode?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  /** 点遮罩关闭（默认开）。表单类弹窗可关掉，避免误触丢失输入 */
  closeOnOverlay?: boolean;
  /** Esc 关闭（默认开）。焦点陷阱的逃生阀，非必要不要关 */
  closeOnEsc?: boolean;
  /** aria-live 通知区内容（保存结果之类的异步播报） */
  liveMessage?: string;
  /** 右上关闭按钮的可访问名称（缺省走 i18n 通用「关闭」） */
  closeLabel?: string;
  /**
   * 无面板 chrome 模式：只提供「遮罩 + 对话框语义 + 焦点陷阱」，底色/边框/圆角/阴影/尺寸
   * 全由 children 自带。用于**只换外壳**地改造存量模态（内容与视觉零改动）。
   */
  frameless?: boolean;
  /** 遮罩层类名覆盖（默认 = 本文件的 OVERLAY_CLASS） */
  overlayClassName?: string;
  /** 无标题时给对话框一个可访问名称（有 `title`/`titleNode` 时优先 aria-labelledby） */
  ariaLabel?: string;
  /**
   * 面板 role（默认 'dialog'）。命令式确认框需要 'alertdialog' 语义时显式传入；
   * 两种取值都带 aria-modal="true"，故 foreignDialogOwnsFocus() 的 `closest` 判据不受影响。
   */
  role?: 'dialog' | 'alertdialog';
  className?: string;
  style?: CSSProperties;
}

export default function Modal({
  open,
  onClose,
  title,
  titleNode,
  children,
  footer,
  size = 'md',
  closeOnOverlay = true,
  closeOnEsc = true,
  liveMessage = '',
  closeLabel,
  frameless = false,
  overlayClassName,
  ariaLabel,
  role = 'dialog',
  className = '',
  style,
}: ModalProps) {
  const { t } = useI18n();
  const reactId = useId();
  const modalId = `modal-${reactId}`;
  const titleId = `${modalId}-title`;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  // onClose 放 ref：避免调用方每次渲染传新函数导致 effect 反复重装（焦点会被反复重置）
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // closeOnEsc 同理必须放 ref、**不能进 deps**（2026-10-18 实测缺陷）：
  // 调用方常在「内层弹层打开时」把 closeOnEsc 从 true 改成 false（self-Esc 子对话框模式）。
  // 一旦它进 deps，effect 就会在弹窗**开着的时候**重装：cleanup 先弹出 stack、把焦点还给
  // 打开它的按钮（焦点飞出面板），再 push 回栈尾 —— 于是父弹窗跑到栈顶，
  // 压在它上面的子对话框的 isTopOfStack() 全变 false，Esc/Tab 失效。
  const closeOnEscRef = useRef(closeOnEsc);
  closeOnEscRef.current = closeOnEsc;
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    setMounted(true);
    previousActiveRef.current = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    MODAL_STACK.push(modalId);

    const panel = panelRef.current;
    // 开箱焦点：优先尊重子元素已抢到的焦点，其次 [data-autofocus]，再次第一个可聚焦元素，
    // 最后聚焦面板自身（tabIndex=-1），保证焦点一定落在对话框内。
    // 为什么要先判「已在面板内」（2026-10-18 实测缺陷）：React 的 autoFocus 在 commit 阶段
    // 就已执行，而本 effect 在其后运行 —— 无条件 focus() 会把子元素刚抢到的焦点**抢走**，
    // 落到右上关闭按钮上。所以「子元素声明了 autoFocus」只能靠**已落位**来识别，
    // 不能靠选择器：React 不写 autofocus 属性，`querySelector('[autofocus]')` 恒不命中
    //（原实现依赖它，等于恒失效，注释里的承诺从未生效）。
    const activeInPanel = (() => {
      const a = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
      return !!(panel && a && a !== document.body && panel.contains(a));
    })();
    if (!activeInPanel) {
      const preferred = panel?.querySelector<HTMLElement>('[data-autofocus],[autofocus]');
      const first = preferred || focusableIn(panel)[0];
      (first || panel)?.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopOfStack(modalId)) return;
      // 别人的对话框（命令式 confirm 等）正在接管键盘时，Esc/Tab 一律让路
      if (foreignDialogOwnsFocus(panelRef.current)) return;
      if (e.key === 'Escape' && closeOnEscRef.current) {
        // 先拦下再关：避免同一次 Esc 又被宿主（面板/浮层）的全局监听吃掉
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusableIn(panelRef.current);
      const root = panelRef.current;
      if (!root) return;
      if (list.length === 0) {
        // 没有任何可聚焦元素：把焦点钉在面板上，Tab 不再跳出去
        e.preventDefault();
        root.focus();
        return;
      }
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && root.contains(active);
      if (e.shiftKey && (active === firstEl || !inside)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !inside)) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    // 兜底：脚本/鼠标把焦点挪出面板时拉回来（否则 Tab 环被绕过就锁不住了）
    const onFocusIn = (e: FocusEvent) => {
      if (!isTopOfStack(modalId)) return;
      const root = panelRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      if (target && root.contains(target)) return;
      // 焦点跑到了别的对话框（confirm/嵌套弹层）里 → 不夺回，否则它的按钮点不动
      if (target && (target as HTMLElement).closest?.('[aria-modal="true"],[role="dialog"]')) return;
      const first = focusableIn(root)[0];
      (first || root)?.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      const i = MODAL_STACK.lastIndexOf(modalId);
      if (i >= 0) MODAL_STACK.splice(i, 1);
      // 焦点归还：回到打开它的那个按钮，键盘用户不会掉回 <body>
      const prev = previousActiveRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
    };
    // deps 里**不要**放 closeOnEsc：见上方 closeOnEscRef 的说明（进 deps 会让弹窗开着时重装 effect）
  }, [open, modalId]);

  if (!open) return null;

  // frameless：面板退化为「透明居中层」，chrome 全在 children 里（存量模态只换外壳用）。
  // 刻意**不加 w-full**：这层若撑满整宽，遮罩两侧就落在面板内，点侧边不再关闭弹窗
  //（原实现是「点遮罩关闭」）。让它 hug 内容，遮罩点击判据 `target === currentTarget` 才成立。
  const panelClass = frameless
    ? `flex items-center justify-center ${className}`.trim()
    : `${PANEL_CLASS} ${MODAL_SIZES[size]} ${className}`.trim();

  return (
    <div
      className={overlayClassName || OVERLAY_CLASS}
      // 遮罩点击关闭：只认「按在遮罩本身」的点击，面板内冒泡上来的不算
      onMouseDown={(e) => { if (closeOnOverlay && e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={title || titleNode ? titleId : undefined}
        aria-label={!title && !titleNode && ariaLabel ? ariaLabel : undefined}
        tabIndex={-1}
        className={panelClass}
        style={style}
      >
        {(title || titleNode) && (
          <div className="shrink-0 px-5 py-4 border-b border-border flex items-start gap-3">
            <div id={titleId} className="text-sm font-semibold flex-1 min-w-0">
              {titleNode || title}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel || t('settings.closeDialog')}
              className="shrink-0 text-text2 hover:text-text"
            >
              <IconX size={14} />
            </button>
          </div>
        )}
        {frameless ? children : (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        )}
        {footer && <div className="shrink-0 px-5 py-3 border-t border-border flex items-center justify-end gap-2">{footer}</div>}
        {/* 异步结果播报区：读屏能听到，视觉上不占位（mounted 用于避免首帧空播报） */}
        <div aria-live="polite" className="sr-only">{mounted ? liveMessage : ''}</div>
      </div>
    </div>
  );
}
