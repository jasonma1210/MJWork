import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconAlert, IconX } from './icons';
import { useI18n, tGlobal } from '../i18n';
import Modal from './ui/Modal';
import Button from './ui/Button';

// ── 命令式确认框 + Toast（A2 统一规格）──
// 用法（无需在各组件挂 state/JSX）：
//   import { confirm, toast } from './feedback';
//   if (await confirm({ title, message, danger: true })) { ... }
//   toast({ message: '已删除', actionLabel: '撤销', onAction });
// <FeedbackHost /> 在 App 根部挂载一次。

let confirmListener = null;
let toastListener = null;
let confirmSeq = 0;

export function confirm(opts = {}) {
  if (!confirmListener) {
    console.warn('[feedback] FeedbackHost not mounted; confirm resolved as cancel');
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    confirmListener({ id: ++confirmSeq, ...opts, resolve });
  });
}

// countConfirm：高危批量操作需输入数量确认（如「全部放弃」N 个文件）
export function countConfirm(opts = {}) {
  return confirm({ ...opts, count: opts.count ?? 0 });
}

// actionLabel/onAction 给默认值 = undefined 语义：二者本就可选（消费端 `t.actionLabel &&` 判空），
// 显式默认值同时让 TS 推导出的参数类型把这两项标为可选，供新 .ts 调用方直接 toast({ message })。
export function toast({ message, actionLabel = null, onAction = null, duration = 5000 }) {
  if (!toastListener) {
    console.warn('[feedback] FeedbackHost not mounted; toast dropped:', message);
    return;
  }
  toastListener({ id: ++confirmSeq, message, actionLabel, onAction, duration });
}

// 单条 Toast：挂载后 200ms 淡入 + 轻微下滑（浅→深），用 transition 而非 keyframe，无需改全局 CSS。
function ToastCard({ t, tr, onDismiss }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] px-4 py-2 text-xs transition-all duration-200 ${show ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'}`}
    >
      <span className="text-text">{t.message}</span>
      {t.actionLabel && (
        <button
          onClick={() => { t.onAction?.(); onDismiss(t.id); }}
          className="text-accent font-medium hover:opacity-80 shrink-0"
        >
          {t.actionLabel}
        </button>
      )}
      <button onClick={() => onDismiss(t.id)} className="text-text2 hover:text-text shrink-0" aria-label={tr('feedback.closeToast')}>
        <IconX size={12} />
      </button>
    </div>
  );
}

export default function FeedbackHost() {
  // 本文件 toast 回调参数名为 t（提示项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [dialog, setDialog] = useState(null);   // { title, message, danger, count, resolve }
  const [countInput, setCountInput] = useState('');
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    confirmListener = (req) => {
      setCountInput('');
      setDialog(req);
    };
    toastListener = (t) => {
      setToasts((prev) => [t, ...prev].slice(0, 4)); // 顶部堆叠：新条在最上，最多 4 条
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, t.duration || 5000);
    };
    return () => { confirmListener = null; toastListener = null; };
  }, []);

  // P2-7（第二轮审查）：消费主进程的「执行后告知」通知。
  // 事件走既有 `tasks:event` 广播（approvalSettings 把 emitTaskEvent 注入成 sink），不新开通道。
  // 为什么挂在这里：本项目所有提示的出口都在本文件（confirm / toast），崩溃提示也在此；
  // 另起一套会出现两种提示样式，用户还要记两处。
  // 只订阅一次：文案在事件到达时才解析，语言切换后新通知用新语言（已在屏上的 toast 保持原样）。
  // ⚠️ 这里必须用 tGlobal，**不能用渲染期的 tr**（2026-10-18 实测缺陷）：
  // 本 effect 的依赖是 []，闭包捕获的是**首帧**的 tr；而 useI18n 的 t 在切语言时会换实体，
  // 于是「切语言后新通知用新语言」这句承诺实际上从未成立 —— 订阅永远说旧语言。
  // tGlobal 每次调用读 activeLocale，正是为这种非 React 回调场景准备的通道。
  useEffect(() => {
    const mj = typeof window !== 'undefined' ? window.mjcode : undefined;
    if (typeof mj?.onTasksEvent !== 'function') return undefined;
    let off;
    try {
      off = mj.onTasksEvent((evt) => {
        if (!evt || evt.type !== 'approval_notice') return;
        const result = evt.ok ? tGlobal('settings.approvalNoticeOk') : tGlobal('settings.approvalNoticeFail');
        const base = Number.isFinite(evt.ms)
          ? tGlobal('settings.approvalNoticeExecuted', { tool: evt.tool, level: evt.level || '-', result, ms: evt.ms })
          : tGlobal('settings.approvalNoticeExecutedNoMs', { tool: evt.tool, level: evt.level || '-', result });
        // 不可补偿必须明说 —— 这条通知的全部价值就在这里（不是「顺手告诉你一声」）
        const message = evt.reversible === false && evt.reversibleNote
          ? `${base} | ${tGlobal('settings.approvalNoticeIrreversible', { note: evt.reversibleNote })}`
          : base;
        toast({ message, duration: evt.reversible === false ? 8000 : 5000 });
      });
    } catch (e) {
      console.warn('[feedback] approval_notice subscribe failed:', e);
    }
    return () => { try { off?.(); } catch { /* 卸载失败无副作用 */ } };
    // 依赖保持 []：文案走 tGlobal（不捕获渲染期 tr），订阅本身不需要随语言重建
  }, []);

  // C2（2026-10-17）：领取「上次渲染进程崩溃」的通知（主进程取完即清）。
  // 放在提示系统里而不是 App：崩溃提示本质就是一条 toast，职责更贴；
  // 且 App.jsx 已贴到 800 行门禁，不宜再塞逻辑。
  // 必须排在上面的 effect 之后——它负责把 toastListener 挂上。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const notices = await window.mjcode?.getCrashNotice?.();
        if (cancelled || !Array.isArray(notices) || notices.length === 0) return;
        const isLoop = notices.some((n) => n && n.kind === 'loop');
        toast({
          message: isLoop ? tr('app.crashLoop', { n: notices.length }) : tr('app.crashRecovered'),
          duration: 8000,
        });
      } catch { /* 崩溃提示失败绝不影响启动 */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function finish(ok) {
    if (!dialog) return;
    dialog.resolve(ok);
    setDialog(null);
  }

  // 焦点接管 / Esc / 焦点归还 全部交给 ui/Modal（见下方 JSX）：
  //   · 打开时 Modal 把焦点移进面板——countConfirm 自带 autoFocus 的输入框会被尊重，不被抢走；
  //   · Esc 由 Modal 的键盘处理器经 onClose 触发 finish(false)，即「取消」（危险操作默认安全侧）；
  //   · 关闭时 Modal 把焦点归还给打开它的元素。
  // 这里因此不再自持 dialogPanelRef / window keydown 监听（原 P3-F3 的重复实现已移除，行为不回退）。

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // portal 目标：对话列顶部锚点。无 DOM（SSR/冒烟测试）时回退为原地渲染，避免
  // createPortal 拿到非 DOM 元素抛「Target container is not a DOM element」。
  const toastRoot = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('mj-toast-root')
    : null;
  // createPortal 必须拿到真实 DOM 节点（nodeType===1）；测试桩返回普通对象会抛
  // 「Target container is not a DOM element」，故校验后回退为原地渲染。
  const canPortal = !!toastRoot && toastRoot.nodeType === 1;
  const toastBody = (
    <div className="flex flex-col gap-2 items-center pointer-events-none">
      {toasts.map((t) => (
        <ToastCard key={t.id} t={t} tr={tr} onDismiss={dismissToast} />
      ))}
    </div>
  );

  return (
    <>
      {dialog && (
        /* 外壳交给 ui/Modal（role=alertdialog + aria-modal + 焦点陷阱 + Esc + 关闭归还焦点）；
           frameless 表示「只换外壳」——面板的宽高/底色/圆角/阴影仍是下面这层自带，视觉零改动。
           遮罩类名沿用原字符串（z-palette），保持与审批层/toast 的层叠关系不变。 */
        <Modal
          open
          onClose={() => finish(false)}
          frameless
          role="alertdialog"
          ariaLabel={dialog.title || tr('feedback.confirmFallback')}
          overlayClassName="fixed inset-0 z-palette flex items-center justify-center bg-overlay"
        >
          <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-2xl bg-raise border border-border shadow-[var(--shadow-modal)] p-5 focus:outline-none">
            <div className="flex items-start gap-3">
              {dialog.danger && (
                <span className="text-danger shrink-0 mt-1"><IconAlert size={18} /></span>
              )}
              <div className="flex-1">
                <div className="text-sm font-semibold">{dialog.title || tr('feedback.confirmFallback')}</div>
                <div className="text-xs text-text2 mt-2 leading-relaxed whitespace-pre-line">{dialog.message}</div>
                {dialog.count != null && (
                  <div className="mt-3">
                    <input
                      autoFocus
                      value={countInput}
                      onChange={(e) => setCountInput(e.target.value.replace(/\D/g, ''))}
                      placeholder={tr('feedback.countConfirmPlaceholder', { count: dialog.count })}
                      className="w-40 bg-bg border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent"
                      onKeyDown={(e) => { if (e.key === 'Enter' && Number(countInput) === dialog.count) finish(true); }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              {/* G7：确认框动作按钮收敛为 ui/Button 原语（取消=secondary，确认=primary/danger）。
                  同一行两枚按钮成组转换，避免只换一半造成行内高度/内距不一致。 */}
              <Button variant="secondary" size="md" onClick={() => finish(false)}>{tr('feedback.cancel')}</Button>
              <Button
                variant={dialog.danger ? 'danger' : 'primary'}
                size="md"
                onClick={() => finish(true)}
                disabled={dialog.count != null && Number(countInput) !== dialog.count}
              >
                {/* danger 只表达**视觉强度**（红色 + 警告图标），不表达「删除」语义。
                    此前默认文案是「确认删除」，于是「允许对外动作」这类确认框也写着"确认删除"
                    （用户实测截图）。现在默认用中性「确认」，动作语义必须由调用方给 confirmLabel。 */}
                {dialog.confirmLabel || tr('feedback.confirm')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {/* Toast 顶部居中：portal 到对话列锚点 #mj-toast-root；无 DOM 锚点时原地渲染 */}
      {canPortal ? createPortal(toastBody, toastRoot) : toastBody}
    </>
  );
}
