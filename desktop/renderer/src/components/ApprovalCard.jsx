import { useCallback, useRef, useState, useEffect } from 'react';
import { useI18n } from '../i18n'; // T3-2：i18n
import { IconFile, IconPlug, IconTerminal } from './icons';
import Button from './ui/Button';

// 顶层常量只存标题 key（求值推迟到渲染时经 t()，切换语言即时更新）
const LEVEL_META = {
  L1: { titleKey: 'approval.dangerTitle', Icon: IconTerminal, color: 'text-danger' },
  L2: { titleKey: 'approval.fileWriteTitle', Icon: IconFile, color: 'text-warn' },
  L3: { titleKey: 'approval.mcpTitle', Icon: IconPlug, color: 'text-info' },
};

// 审批卡片（对标 Codex）：不再全屏遮罩，改为右下角非模态悬浮
// 关键差异 —— 审批时对话流仍然可见可滚动，用户能对照上下文再决定，而不是被强制切走
// A7：主行动改「允许一次」（accent 实心），「始终允许」降为边框按钮置末位（视觉语义不再倒置）
// B16：键盘 1=拒绝 2=允许一次 3=本对话 4=始终允许
// P1-D：审批挂起/决策上报 onPendingChange（App 据此置线程状态 awaiting_approval/running）；
//       监听 mjcode:focus-approval（侧栏「N 待审批」徽标点击）→ 展开并高亮闪现
// P1-4：可选决策理由——「附加理由」默认收起（经验：必填会让用户放弃填写，反而阻塞
//       高频审批）。理由随决议回传主进程：拒绝时拼进工具结果（模型看到「为什么被拒、
//       该怎么做」，不再用等价命令无信息量重试）与审计行（用户事后可复盘）。
//
// 2026-10-15 修复：待审批改为 **FIFO 队列**。
// 事故背景：原实现只有一个 pending 槽位。自动 DAG 下多个 Worker 并发申请审批时，
// 新请求直接覆盖旧的——被覆盖的那条在界面上再也点不到，只能等主进程 120s 超时按
// 拒绝收尾；用户看到的现象是「卡片弹了但命令继续执行，点了又没反应」。
// 现在每条审批都进队，逐条作答，并显示「第 i/N 条」让用户知道后面还有几条。
export default function ApprovalCard({ onPendingChange }) {
  const { t } = useI18n();
  const [queue, setQueue] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [flash, setFlash] = useState(false);
  // P1-4：可选决策理由草稿（默认收起，见文件头注释）。
  // 草稿经 ref 读取：避免 resolve 因 reasonText 变化新建引用，键盘监听随每次输入卸载重挂
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonText, setReasonText] = useState('');
  const reasonTextRef = useRef('');
  reasonTextRef.current = reasonText;
  // 回调走 ref：避免父组件每次渲染传入新函数导致审批监听重复订阅
  const pendingCbRef = useRef(onPendingChange);
  pendingCbRef.current = onPendingChange;

  // 当前展示的永远是队首（FIFO），保证先申请的先被回答
  const pending = queue[0] || null;
  // 不可「记住」的审批（unconfined_exec / scheduled_create）：主进程不会把
  // conversation/always 落成规则，UI 就不能给出这两个按钮——否则用户点了「本会话允许」
  // 却发现下次还问，等于产品撒谎。默认 true（老请求不带该字段时按可记忆处理）。
  const rememberable = pending?.rememberable !== false;

  useEffect(() => {
    if (!window.mjcode?.onApprovalRequest) return undefined;
    const off = window.mjcode.onApprovalRequest((req) => {
      if (!req?.approvalId) return; // 无 id 的请求无法回传决策，丢弃（主进程按 id 分发）
      setQueue((q) => (q.some((r) => r.approvalId === req.approvalId) ? q : [...q, req]));
      setCollapsed(false);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 审批结束回执：已决策 / 超时 / 窗口销毁 —— 撤下对应卡片。
  // 没有它，超时后的卡片会一直挂着，用户点击时主进程已无该 pending，
  // 只能记「收到无法匹配的审批响应，已忽略」。
  useEffect(() => {
    if (!window.mjcode?.onApprovalEnd) return undefined;
    const off = window.mjcode.onApprovalEnd(({ approvalId } = {}) => {
      if (!approvalId) return;
      setQueue((q) => q.filter((r) => r.approvalId !== approvalId));
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 队首审批的归属会话（P0-5）——先提成标量再进依赖数组：
  // 直接在 deps 里写 `queue[0]?.threadId` 会触发 exhaustive-deps 的「复杂表达式」告警。
  const headThreadId = queue[0]?.threadId || null;
  // 队列空/非空变化时上报（App 据此置线程状态）
  // P0-5（2026-10-22）：同时上报**队首审批的归属会话**。App 此前一律写 activeThread，
  // 于是后台会话的审批会点亮你正在看的那个会话的徽标，真正在等的会话反而不亮。
  useEffect(() => {
    pendingCbRef.current?.(queue.length > 0, headThreadId);
  }, [queue.length, headThreadId]);

  // P1-D：侧栏徽标点击直达——展开卡片并短暂高亮（不切换视图，保持当前上下文可见）
  useEffect(() => {
    const onFocus = () => {
      setCollapsed(false);
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
    };
    window.addEventListener('mjcode:focus-approval', onFocus);
    return () => window.removeEventListener('mjcode:focus-approval', onFocus);
  }, []);

  // P1-4：队列推进（切换到下一条审批）时清空理由草稿——
  // 不清的话上一条的理由会误带到下一条完全无关的审批上
  useEffect(() => {
    setReasonText('');
    setReasonOpen(false);
  }, [pending?.approvalId]);

  // P1-6：resolve 包 useCallback。它原先是无记忆的普通函数，每次渲染新建引用；
  // 一旦被 useEffect 列入依赖（键盘处理器需要它），就会让监听每轮渲染卸载重挂。
  // 依赖只有 pending（理由草稿走 ref，其余是稳定 setter 与 ref），与键盘 effect 的触发条件一致。
  const resolve = useCallback((decision) => {
    if (!pending?.approvalId) return;
    // P1-4：有理由时随决议回传（主进程拼进拒绝结果与审计）；无理由时负载与旧版一致
    // P0-2：决策负载必须回带 approvalId——主进程按 id 精确分发，
    // 并发审批时决策才能落到正确的请求上（否则把「允许」发给另一条命令）
    const reason = reasonTextRef.current.trim();
    window.mjcode.resolveApproval(reason
      ? { approvalId: pending.approvalId, decision, reason }
      : { approvalId: pending.approvalId, decision });
    // 乐观出队：主进程的 tool:approval-end 回执到达时会再过滤一次，幂等
    setQueue((q) => q.filter((r) => r.approvalId !== pending.approvalId));
  }, [pending]);

  // 键盘 1-4 快捷决策（仅审批卡非折叠时生效）
  useEffect(() => {
    if (!pending || collapsed) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 输入焦点守卫：用户正在输入框打字（内容里出现数字 1-4 很常见）时
      // 不得触发审批决策，否则一句「方案 1 不错」就会误拒/误批
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing) return;
      // rememberable=false（unconfined_exec / scheduled_create）：3/4 对它们无效，不绑快捷键
      const map = rememberable
        ? { 1: 'deny', 2: 'once', 3: 'conversation', 4: 'always' }
        : { 1: 'deny', 2: 'once' };
      if (map[e.key]) {
        e.preventDefault();
        resolve(map[e.key]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // P1-6：resolve 必须列入依赖。此前遗漏 → 父组件传入新的 resolve（如审批卡因
    // 新一轮审批重建）时，键盘处理器仍闭包着旧的 resolve，用户按 Enter/Esc 的决策
    // 会送到已失效的 Promise 上，表现为「按了键但审批毫无反应」。
    // rememberable 同样要列：它决定 3/4 键是否绑定（不可记忆的工具不许用快捷键批量放行）。
  }, [pending, collapsed, resolve, rememberable]);

  if (!pending) return null;
  const meta = LEVEL_META[pending.level] || LEVEL_META.L2;
  const total = queue.length;

  return (
    <div className={`fixed bottom-14 right-4 w-[460px] max-w-[calc(100vw-2rem)] z-approval transition-shadow${flash ? ' ring-2 ring-accent rounded-2xl' : ''}`}>
      <div className="bg-surface border border-warn rounded-2xl shadow-[var(--shadow-pop)] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <span className={meta.color}><meta.Icon size={15} /></span>
          <span className="text-sm font-medium">{t(meta.titleKey)}</span>
          <span className="text-text2 text-xs font-mono truncate">{pending.tool}</span>
          {total > 1 && (
            <span className="text-text2 text-xs shrink-0">{t('approval.queuePosition', { total })}</span>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="ml-auto text-text2 hover:text-text text-xs"
          >
            {collapsed ? t('approval.expand') : t('approval.collapse')}
          </button>
        </div>

        {!collapsed && (
          <>
            {/* P0-5：来源会话。多会话并行（本产品支持切走后台继续跑）时，
                「这条审批是谁在等」与「命令作用在哪个目录」一样关键——
                此前卡片只有工具名 + cwd，后台会话的审批与当前会话长得完全一样。 */}
            {(pending.threadTitle || pending.threadId) && (
              <div className="flex items-center gap-2 px-4 pt-3 text-xs text-text2">
                <span className="shrink-0">{t('approval.fromThread')}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  className="truncate max-w-[260px] underline-offset-2 hover:underline"
                  title={pending.threadTitle || pending.threadId}
                  onClick={() => {
                    if (!pending.threadId) return;
                    // 走既有 CustomEvent 解耦：审批卡不需要知道 App 的会话切换实现
                    window.dispatchEvent(new CustomEvent('mjcode:focus-thread', { detail: { threadId: pending.threadId } }));
                  }}
                >
                  {pending.threadTitle || pending.threadId}
                </Button>
              </div>
            )}
            {/* V21：显示审批请求来源的工作根（多会话/隔离工作区并发时，
                用户需要知道命令将作用在哪个目录）。主进程摘要未携带时不显示，不硬造。 */}
            {(pending.cwd || pending.workingRoot) && (
              <div className="flex items-center gap-2 px-4 pt-3 text-xs text-text2">
                <span className="shrink-0">{t('approval.workingRoot')}</span>
                <span className="font-mono truncate" title={pending.cwd || pending.workingRoot}>
                  {pending.cwd || pending.workingRoot}
                </span>
              </div>
            )}
            <pre className="mx-4 my-3 rounded-lg border border-border bg-bg px-3 py-3 text-code font-mono overflow-x-auto max-h-40 whitespace-pre-wrap text-text2">
              {pending.detail || t('approval.noDetail')}
            </pre>
            {/* P1-4：可选理由输入——默认收起，点「附加理由」展开。
                拒绝时填一句（如「用 npm 别用 pnpm」），Agent 下一轮就能看到并调整做法。 */}
            {reasonOpen && (
              <div className="px-4 pb-2">
                <textarea
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  placeholder={t('approval.reasonPlaceholder')}
                  rows={2}
                  className="w-full px-2 py-2 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent resize-none"
                />
              </div>
            )}
            <div className="flex flex-wrap gap-2 px-4 pb-4">
              {/* G7：审批动作按钮行整体收敛为 ui/Button 原语（本行成组转换、统一 md 档，
                  保证行内高度/内距一致）。附加理由=ghost（保留 hover 描边反馈）；其余=secondary；
                  主行动「允许一次」=primary（A7：accent 实心、置首位）。 */}
              <Button variant="ghost" size="md" className="hover:border-border" onClick={() => setReasonOpen((v) => !v)}>
                {reasonOpen ? t('approval.collapse') : t('approval.attachReason')}
              </Button>
              <Button variant="primary" size="md" onClick={() => resolve('once')}>{t('approval.allowOnce')}</Button>
              {rememberable && (
                <Button variant="secondary" size="md" onClick={() => resolve('conversation')}>{t('approval.allowConversation')}</Button>
              )}
              <Button variant="danger-ghost" size="md" onClick={() => resolve('deny')}>{t('approval.deny')}</Button>
              {rememberable && (
                <Button variant="secondary" size="md" onClick={() => resolve('always')}>{t('approval.allowAlways')}</Button>
              )}
              <span className="text-caption text-text2 self-center ml-auto" title={t('approval.hotkeyTitle')}>{t('approval.hotkeyHint')}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
