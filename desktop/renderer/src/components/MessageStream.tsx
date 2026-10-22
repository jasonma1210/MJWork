// @ts-nocheck -- T2-2 存量代码原样搬移（零行为变更）；渐进 TS 路线下补全类型属后续任务（T0-3 门禁只约束新文件扩展名）
import { useState, useEffect, useRef, useMemo } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from './MermaidDiagram';
import { toast } from './feedback';
import { useI18n } from '../i18n'; // T3-2：i18n
import { IconChevronDown, IconCopy, IconCpu, IconExternalLink, IconFile, IconGitBranch, IconPlus, IconSpinner } from './icons';
import { ToolTraceGroup } from './tools/ToolTrace';
import Button from './ui/Button';
import Dot from './ui/Dot';
// M5 / T5-6：对话内团队协同事件流（默认折叠卡片；不新增独立群聊页）
import TeamRunStream from './TeamRunStream';

// T2-2：消息流域（自主进程 ChatArea.jsx 原样搬移，行为不变）——
// 窗口切片（C1）/ 智能滚底（C3）/ 轮次重放（T1-2）/ 本轮概览（T1-5）/ 运行态轨迹与思考流。
// 滚动跟随状态经 useMessageWindow 下沉；windowStart 归 ChatArea（切会话重置在其 effects 中）。

// C1：窗口切片步长（条）。ChatArea 首屏初始化与 MessageStream「加载更早」共用同一口径。
export const MSG_WINDOW = 50;

// C3：智能滚底 hook——仅当用户已在底部附近（<80px）才跟随；上翻历史时不再被强制拽回，
// 由悬浮的「回到底部」按钮接管（stickToBottomRef 在 onScroll 中维护）。
function useMessageWindow({ messages, streamingText, toolCallsCount }) {
  const scrollRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setShowJumpBottom(!nearBottom);
  }
  function jumpToBottom() {
    stickToBottomRef.current = true;
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowJumpBottom(false);
  }
  useEffect(() => {
    if (stickToBottomRef.current) scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, streamingText, toolCallsCount]);
  return { scrollRef, handleScroll, showJumpBottom, jumpToBottom };
}

// T1（2026-10-17）：运行计时——每秒重渲染一次，只在运行时跑。
// 目的：长思考期间界面不能只有一行静止的「思考中…」，否则用户会以为卡死并按下 Esc，
// 把本来正常跑着的任务杀掉（这是线上真实发生过的连锁）。
function useElapsedSeconds(startedAt?: number, active?: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

export default function MessageStream({
  messages, windowStart, onLoadEarlier,
  loading, toolCalls, reasoningText, streamingText,
  runSummary, runUsage, runStartedAt, contextUsage, model,
  runFiles = [],
  onOpenFile,
  // M5 / T5-6：当前会话 id —— 团队事件流按 thread_id 归属过滤（不跨会话串卡）
  threadId = null,
}) {
  const { t } = useI18n();
  // T1：让用户"看见它在动"——秒数与字数都从流式内容长度直接算，不额外走 IPC
  const elapsedSec = useElapsedSeconds(runStartedAt, loading);
  const receivedChars = (reasoningText ? reasoningText.length : 0) + (streamingText ? streamingText.length : 0);
  const { scrollRef, handleScroll, showJumpBottom, jumpToBottom } = useMessageWindow({ messages, streamingText, toolCallsCount: toolCalls.length });
  // 布局要点：消息区必须 min-h-0。
  // flex 子项默认 min-height:auto，内容多高容器就被撑多高，overflow-y-auto 失效，
  // 表现为「聊得越多，输入框被顶得越往下直到看不见」。
  // C1：窗口切片渲染；起点落在 tool 消息上时向前回退，避免切断 assistant(tool_calls) 与结果的配对
  let effStart = windowStart;
  while (effStart > 0 && effStart < messages.length && messages[effStart].role === 'tool') effStart -= 1;
  const visibleMessages = messages.slice(effStart);
  // X11：把历史轮次整棵 element 树 memo 住。流式期间 messages/effStart 都不变，
  // React 复用同一批 element 就会跳过这些子树的 re-render 与 markdown 重新解析——
  // 每帧只重绘「正在增长的那一段」。
  const rounds = useMemo(
    () => renderMessages(visibleMessages, !!runSummary || !!loading, onOpenFile, toolCalls, !!loading),
    // visibleMessages 由 messages/effStart 派生，故直接以二者为依赖（避免数组身份每帧变化）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, effStart, runSummary, loading, onOpenFile, toolCalls],
  );
  return (
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-4" onScroll={handleScroll}>
        {/* 正文列与输入框同宽同左缘（Composer 为 max-w-3xl mx-auto）：此前消息贴左、
            输入框居中，1440 宽下两者错开约 130px，视觉上像是两套栅格 */}
        <div className="mx-auto w-full max-w-3xl">
        {effStart > 0 && (
          <div className="flex justify-center mb-3">
            <Button variant="secondary" size="sm" onClick={() => onLoadEarlier(effStart)}>
              {t('message.loadEarlier', { n: effStart })}
            </Button>
          </div>
        )}
        {/* 最后一轮的逐条消息 meta 仅在「底部收尾条不会渲染」时展示（有收尾条即由其统一承载，
            避免同一组数字重复出现两次）；历史轮始终保留 meta，避免历史消息丢失模型/耗时信息。 */}
        {/* 本轮工具轨迹并入「最后一轮」块内、答复正文之上（见 RoundBlock 的 extraCalls）。
            此前它单独排在消息流最底部，用户要往下翻才看得到「这一轮做了什么」，与正文割裂。 */}
        {rounds}
        {/* M5 / T5-6：团队协同事件流——按 thread_id 投影为折叠卡片（派活/接手/汇报轨迹），
            排在正文之后、本轮收尾卡之前：它是「这一轮协同」的补充事实，不打断对话正文。 */}
        <TeamRunStream threadId={threadId} onOpenFile={onOpenFile} />
        {/* 本轮产出文件：运行结束后列出本轮被写入/修改的文件（点击在右侧预览栏打开） */}
        <RunOutputFiles files={runFiles} onOpenFile={onOpenFile} />
        {/* T1-5：本轮概览卡——运行中实时（耗时/消耗/上下文/模型），结束态转固定收尾条 */}
        <RunFooter
          summary={runSummary}
          live={loading ? {
            startedAt: runStartedAt,
            tokensIn: runUsage ? runUsage.tokensIn : 0,
            tokensOut: runUsage ? runUsage.tokensOut : 0,
            contextUsage,
            model,
          } : null}
          changedCount={runFiles.length}
          // 走 CustomEvent：收尾条不需要知道右侧面板的编排实现（App 里有唯一入口）
          onOpenChanges={() => window.dispatchEvent(new CustomEvent('mjcode:open-diff'))}
        />
        {/* T1-1+T1-2：运行态工具轨迹已并入最后一轮块（答复正文之上），此处不再重复渲染 */}
        {/* T1-5：推理模型思考流——Markdown 渐进渲染（与正文一致的排版），默认展开可折叠 */}
        {loading && reasoningText && (
          <details className="mb-3 max-w-3xl" open>
            <summary className="text-xs text-text2 cursor-pointer select-none">
              {t('message.thinking')}
              {elapsedSec > 0 && <span className="ml-2 text-text2/70">{t('message.thinkingElapsed', { s: elapsedSec })}</span>}
              {receivedChars > 0 && <span className="ml-2 text-text2/70">{t('message.receivedChars', { n: receivedChars })}</span>}
            </summary>
            <div className="mt-1 text-xs text-text2 max-h-40 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoningText}</ReactMarkdown>
            </div>
          </details>
        )}
        {streamingText && (
          <div className="mb-4 max-w-3xl">
            <div className="text-xs text-text2 mb-1">MJ Coder <span className="animate-pulse">▋</span></div>
            <div className="msg-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown></div>
          </div>
        )}
        {/* T1-5：统一加载态——spinner + 文案，与工具卡/概览卡的运行中徽标同一视觉语言 */}
        {loading && !streamingText && !reasoningText && toolCalls.length === 0 && (
          <div className="flex items-center gap-2 text-text2 text-sm">
            <IconSpinner size={14} className="animate-spin" />
            {t('message.thinking')}
            {elapsedSec > 0 && <span className="text-text2/70">{t('message.thinkingElapsed', { s: elapsedSec })}</span>}
          </div>
        )}
        </div>
      </div>
      {/* C3：用户上翻历史时出现，点击回底并恢复跟随 */}
      {showJumpBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 text-xs px-3 py-2 rounded-full bg-raise border border-border shadow-[var(--shadow-pop)] text-text2 hover:text-text"
        >
          {t('message.jumpBottom')}
        </button>
      )}
      </div>
  );
}

// C7：消息复制（hover 显示操作条，user/assistant 均支持；无状态组件，用 toast 反馈）
function CopyButton({ text }) {
  const { t } = useI18n();
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(text || ''));
          toast({ message: t('message.copied') });
        } catch (err) {
          console.warn('[chat] copy failed:', err);
          toast({ message: t('message.copyFailed') });
        }
      }}
      className="opacity-0 group-hover:opacity-100 text-text2 hover:text-text shrink-0 p-1"
      title={t('message.copyTitle')} aria-label={t('message.copyAria')}
    >
      <IconCopy size={13} />
    </button>
  );
}

// P1-6：会话分支——从该条消息处 fork 出一支新会话（复制截至该消息的历史）。
// 无状态组件：经 CustomEvent 交给 App 处理（同 mjcode:open-settings 模式，避免层层传 prop）。
function ForkButton({ messageId }) {
  const { t } = useI18n();
  if (messageId == null) return null;
  return (
    <button
      onClick={() => window.dispatchEvent(new CustomEvent('mjcode:fork-thread', { detail: { messageId } }))}
      className="opacity-0 group-hover:opacity-100 text-text2 hover:text-text shrink-0 p-1"
      title={t('message.forkTitle')} aria-label={t('message.forkAria')}
    >
      <IconGitBranch size={13} />
    </button>
  );
}

// 本轮概览卡（T1-5：RunFooter 与 Token 仪表盘整合，WorkBuddy 式固定收尾）：
// · live 模式（运行中）：运行中徽标 + 实时耗时 + 本轮已消耗 + 上下文用量 + 模型，每秒刷新；
// · 结束态：状态（正常结束/任务暂停/已停止/失败）+ 耗时 + 共消耗 + 模型 + 结束时间。
// 与单条消息的 meta 小字互补：meta 随消息滚动，此卡永远挂在最后一屏可见。
export function RunFooter({ summary, live, changedCount = 0, onOpenChanges }) {
  // 组件内已有局部变量 t（定时器），i18n 译函数改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!summary && !live) return null;
  const fmtDur = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
  };
  const chip = 'inline-flex items-center gap-1 text-xs text-text2 bg-surface border border-border rounded-lg px-3 py-2 gap-x-3 gap-y-1 flex-wrap';
  // 运行中概览：实时数据流（startedAt/usage/contextUsage 由调用方每轮渲染传入最新值）
  if (live) {
    const total = (live.tokensIn || 0) + (live.tokensOut || 0);
    return (
      <div className="mb-4 max-w-3xl">
        <div className={chip}>
          <span className="inline-flex items-center gap-1 text-accent">
            <IconSpinner size={11} className="animate-spin" />
            {tr('message.running')}
          </span>
          {live.startedAt > 0 && <span>{tr('message.elapsed', { dur: fmtDur(Date.now() - live.startedAt) })}</span>}
          {total > 0 && <span title={tr('message.tokensTitle', { in: (live.tokensIn || 0).toLocaleString(), out: (live.tokensOut || 0).toLocaleString() })}>{tr('message.roundTokens', { n: total.toLocaleString() })}</span>}
          {live.contextUsage && (
            <span title={tr('message.contextTitle', { used: live.contextUsage.used, total: live.contextUsage.total })}>
              {tr('message.contextPercent', { pct: Math.round(live.contextUsage.ratio * 100) })}
            </span>
          )}
          {live.model && <span className="truncate">· {live.model}</span>}
        </div>
      </div>
    );
  }
  const STATUS = {
    done: { label: tr('message.statusDone'), cls: 'text-success', dot: 'bg-success' },
    aborted: { label: tr('message.statusAborted'), cls: 'text-warn', dot: 'bg-warn' },
    suspended: { label: tr('message.statusSuspended'), cls: 'text-warn', dot: 'bg-warn' },
    error: { label: tr('message.statusError'), cls: 'text-danger', dot: 'bg-danger' },
  };
  const st = STATUS[summary.status] || STATUS.done;
  const total = (summary.tokensIn || 0) + (summary.tokensOut || 0);
  return (
    <div className="mb-4 max-w-3xl">
      <div className={chip}>
        <span className={`inline-flex items-center gap-1 ${st.cls}`}>
          <Dot size="sm" className={`inline-block ${st.dot}`} />
          {st.label}
        </span>
        {summary.durationMs > 0 && <span>{tr('message.duration', { dur: fmtDur(summary.durationMs) })}</span>}
        {total > 0 && (
          <span title={tr('message.tokensTitle', { in: (summary.tokensIn || 0).toLocaleString(), out: (summary.tokensOut || 0).toLocaleString() })}>
            {tr('message.totalTokens', { n: total.toLocaleString() })}
          </span>
        )}
        {summary.model && <span className="truncate">· {summary.model}</span>}
        {summary.endedAt && <span>· {new Date(summary.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
        {/* P0-7（2026-10-22）：收尾条此前只有「状态/耗时/token/模型」四个读数，
            没有任何动作——用户看完不知道下一步该干什么，改动藏在右侧一个没有角标的图标里。
            这里给出唯一明确的落点：查看本轮改动。 */}
        {changedCount > 0 && typeof onOpenChanges === 'function' && (
          <Button variant="accent-ghost" size="xs" onClick={onOpenChanges}>
            <IconFile size={11} />
            {tr('message.viewChanges', { n: changedCount })}
          </Button>
        )}
      </div>
    </div>
  );
}

// 历史消息重放：user 气泡 / assistant markdown / assistant+tool_calls 配对渲染工具轨迹
// 兼容双轨字段：服务端 snake_case（tool_calls/model_name/tokens_input），
// 本机 localStore camelCase（toolCalls/modelName/tokensInput）
// T1-2：轨迹按轮次分组——user 消息开启一轮，同轮多次工具调用聚合并列、可折叠；
// 当前轮（最后一轮）默认展开，历史轮折叠为一行摘要。effStart 回退已保证切片
// 不会切断 assistant(tool_calls) 与 tool 结果的配对，分组天然成立。

// 助手正文里的「文件提及」→ 可点击打开（右侧预览栏）。
// 判定规则（纯字符串，不探磁盘）：含路径分隔符，或扩展名在已知代码/文档白名单内。
// 之所以要白名单而不能只看「有点号」：`v1.0.0`、`3.14` 这类版本号/数字会被误判成文件。
const CODE_EXT = new Set([
  'md', 'markdown', 'mdx', 'txt', 'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'env', 'conf',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql',
  'csv', 'tsv', 'log', 'lock', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'xlsx', 'pptx',
]);

function isFilePathLike(text: string): boolean {
  const s = String(text || '').trim();
  if (!s || s.length > 200 || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  const m = s.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!m) return false;
  const ext = m[1].toLowerCase();
  if (CODE_EXT.has(ext)) return true;
  // 带目录的路径即使扩展名不在白名单也当作文件（如 docs/build.out）
  return /[\\/]/.test(s);
}

/** 文件 chip 的「…」菜单（对标 WorkBuddy）：添加到对话框 / 复制路径 / 在默认应用打开。
 *  「添加到对话框」走 mjcode:add-attachment 事件总线（useAgentRun 监听），与右栏预览同款。 */
function FileRefMenu({ text, onClose }: { text: string; onClose: () => void }) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(text);
      toast({ message: t('message.pathCopied') });
    } catch (err) {
      console.warn('[message] copy path failed:', err);
      toast({ message: t('message.copyFailed') });
    }
    onClose();
  }
  async function openDefault() {
    try {
      const r = await window.mjcode?.openPath?.({ path: text });
      if (r && r.ok === false) toast({ message: String(r.error || t('filePreview.openFailed')) });
    } catch (err) {
      console.warn('[message] open with default app failed:', err);
    }
    onClose();
  }
  const item = 'w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-text hover:bg-hover';
  return (
    <div ref={menuRef} role="menu" className="absolute left-0 top-full mt-1 z-menu w-[168px] py-1 bg-raise border border-border rounded-xl shadow-[var(--shadow-menu)]">
      <button type="button" role="menuitem" className={item}
        onClick={() => { window.dispatchEvent(new CustomEvent('mjcode:add-attachment', { detail: { path: text } })); onClose(); }}>
        <IconPlus size={13} className="text-text2 shrink-0" />
        <span className="truncate">{t('message.addToChat')}</span>
      </button>
      <button type="button" role="menuitem" className={item} onClick={copyPath}>
        <IconCopy size={13} className="text-text2 shrink-0" />
        <span className="truncate">{t('message.copyPath')}</span>
      </button>
      <button type="button" role="menuitem" className={item} onClick={openDefault}>
        <IconExternalLink size={13} className="text-text2 shrink-0" />
        <span className="truncate">{t('filePreview.openWithSystem')}</span>
      </button>
    </div>
  );
}

/** 本轮产出文件：任务结束后列出本轮被写入/修改的文件（点击在右侧预览栏打开） */
function RunOutputFiles({ files = [], onOpenFile }: { files?: Array<string | { path: string }>; onOpenFile?: (p: string) => void }) {
  const { t } = useI18n();
  const list = (files || []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean);
  if (!list.length) return null;
  return (
    <div className="mb-4 max-w-3xl">
      <div className="text-xs text-text2 mb-2">{t('message.outputFiles', { n: list.length })}</div>
      <div className="flex flex-wrap gap-2">
        {list.map((path) => {
          const name = path.split('/').pop() || path;
          const dir = path.length > name.length ? path.slice(0, path.length - name.length - 1) : '';
          return (
            <button
              key={path}
              type="button"
              onClick={() => onOpenFile?.(path)}
              title={path}
              className="group flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-left hover:bg-hover hover:border-accent/40 transition-colors min-w-[190px] max-w-[280px]"
            >
              <span className="shrink-0 text-accent"><IconFile size={18} /></span>
              <span className="min-w-0">
                <span className="block text-xs text-text truncate">{name}</span>
                <span className="block text-caption text-text2 truncate" dir="rtl">{dir || name}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 正文内联代码 / 本地链接 → 可点击的文件 chip：点击在右侧预览栏打开；「…」弹出操作菜单 */
function FileRefChip({ text, onOpenFile }: { text: string; onOpenFile?: (p: string) => void }) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const clickable = !!onOpenFile && isFilePathLike(text);
  const base = 'rounded px-2 py-1 text-xs border';
  if (!clickable) {
    return (
      <code className={`${base} bg-hover border-border text-text2 font-mono`}>{text}</code>
    );
  }
  return (
    <span className="relative inline-flex items-center gap-1 align-baseline">
      <button
        type="button"
        onClick={() => onOpenFile?.(text)}
        title={t('message.openFileHint')}
        className={`${base} bg-accent/10 border-accent/40 text-accent font-mono hover:bg-accent/20 cursor-pointer`}
      >
        {text}
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        title={t('message.fileActions')}
        aria-label={t('message.fileActions')}
        className="shrink-0 text-text2 hover:text-text rounded p-1 align-middle"
      >
        <IconChevronDown size={11} />
      </button>
      {menuOpen && <FileRefMenu text={text} onClose={() => setMenuOpen(false)} />}
    </span>
  );
}

/** markdown 渲染器的自定义节点：只改「行内代码」与「本地链接」，其余保持默认语义 */
function markdownComponents(onOpenFile?: (p: string) => void) {
  return {
    // G-visualize：```mermaid 围栏块由 code 渲染器出图，外层 <pre> 必须一并旁路，
    // 否则图表会被套进等宽预格式块（背景、滚动、等宽字体都不对）
    pre: ({ children, ...rest }: { children?: ReactNode }) => {
      const first: any = Array.isArray(children) ? children[0] : children;
      if (/language-mermaid/i.test(String(first?.props?.className || ''))) return <>{children}</>;
      return <pre {...rest}>{children}</pre>;
    },
    // 代码块（带 language-* className）与多行代码不处理，仅处理行内代码
    code: ({ className, children, ...rest }: { className?: string; children?: ReactNode }) => {
      const cls = String(className || '');
      // G-visualize：```mermaid → 渲染成图（其余 language-* 代码块保持原样）
      if (/language-mermaid/i.test(cls)) return <MermaidDiagram code={String(children ?? '')} />;
      const raw = String(children ?? '').replace(/\n$/, '');
      if (className || raw.includes('\n')) {
        return (
          <code className={`${className || ''} font-mono`} {...rest}>{children}</code>
        );
      }
      return <FileRefChip text={raw} onOpenFile={onOpenFile} />;
    },
    // 本地相对链接（非 http/mailto/#）同样走文件打开
    a: ({ href, children, ...rest }: { href?: string; children?: ReactNode }) => {
      const h = String(href || '');
      if (onOpenFile && h && !/^(https?:|mailto:|#|\/\/)/i.test(h) && isFilePathLike(h)) {
        return (
          <button type="button" onClick={() => onOpenFile(h)} className="text-accent underline hover:opacity-80">
            {children}
          </button>
        );
      }
      // 外部链接一律交给系统浏览器。
      // 2026-10-17 真机修复（用户实测：「点 MCP 里需要跳转的条目，回来变成新建会话界面」）：
      // 此前这里原样输出 <a href>，而 Electron 窗口没有任何 will-navigate 拦截——
      // 点击会在**应用窗口内整页导航**，SPA 被卸载；返回/后退时重新加载，
      // activeThread 回到初始 null，用户看到的就是"新建会话"。
      // MCP 工具返回的内容里常带授权/文档链接（鉴权类尤其），所以这个坑在 MCP 场景下高频触发。
      if (/^(https?:|mailto:)/i.test(h)) {
        return (
          <a
            href={h}
            {...rest}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              try { window.mjcode?.openExternal?.({ url: h }); } catch { /* 桥不可用则退回浏览器默认行为 */ }
            }}
          >
            {children}
          </a>
        );
      }
      return <a href={href} {...rest}>{children}</a>;
    },
  };
}

// 轮次块：一轮的 user 气泡 + 工具轨迹组 + assistant 回复（含 meta）。折叠状态本组件持有。
function RoundBlock({ round, user, assistants, toolResults, isLast, running = false, suppressMeta = false, extraCalls = [], onOpenFile }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(isLast);
  const calls = [];
  for (const m of assistants) {
    const cs = Array.isArray(m.tool_calls) ? m.tool_calls : Array.isArray(m.toolCalls) ? m.toolCalls : [];
    for (const tc of cs) calls.push(tc);
  }
  // 运行中/刚结束的这一轮：中间轮消息尚未回到渲染层（主进程落库、渲染层只拿到最终 assistant），
  // 所以本轮的工具调用由 MessageStream 以 liveCalls 传入，接到本条消息自带 calls 之后，去重后合并。
  if (isLast && extraCalls.length) {
    const seen = new Set(calls.map((c) => c?.id).filter(Boolean));
    for (const tc of extraCalls) {
      if (tc?.id && seen.has(tc.id)) continue;
      calls.push(tc);
    }
  }
  const firstReply = assistants.find((m) => m.content);
  // 本轮「答复」所在的消息下标：末条有正文的 assistant（工具调用轮里正文只出现在最后一条）。
  // 执行体流程要贴在它上方 —— 贴到首条 assistant 会跑到本轮最顶端、与答复脱节（用户实测反馈）。
  let answerIdx = -1;
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    if (String(assistants[i]?.content || '').trim()) { answerIdx = i; break; }
  }
  if (answerIdx === -1 && assistants.length) answerIdx = assistants.length - 1;
  const md = markdownComponents(onOpenFile);
  const userPreview = String(user?.content || '').replace(/\s+/g, ' ').slice(0, 60);
  const replyPreview = String(firstReply?.content || '').replace(/\s+/g, ' ').slice(0, 60);
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-2 select-none">
        <span className="text-caption text-text2 shrink-0">{t('message.round', { n: round })}</span>
        {calls.length > 0 && (
          <span className="text-caption text-text2 bg-hover rounded px-2 py-1 shrink-0">{t('message.callCount', { n: calls.length })}</span>
        )}
        <button onClick={() => setOpen((v) => !v)} className="text-xs text-text2 hover:text-text shrink-0"
          title={open ? t('message.collapseRound') : t('message.expandRound')}>
          {open ? t('message.collapse') : t('message.expand')}
        </button>
        <div className="flex-1 border-t border-border" />
      </div>
      {!open ? (
        <button onClick={() => setOpen(true)}
          className="w-full text-left text-xs text-text2 hover:text-text truncate" title={userPreview}>
          {userPreview || replyPreview || t('message.round', { n: round })}
          {calls.length > 0 && <span className="text-text2">{t('message.withToolCalls', { n: calls.length })}</span>}
        </button>
      ) : (
        <>
          {user && (
            <div className="mb-4 flex justify-end">
              <div className="msg-prose bg-surface rounded-2xl px-4 py-2 max-w-2xl">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{user.content}</ReactMarkdown>
              </div>
              <div className="self-center ml-2 flex"><CopyButton text={user.content} /><ForkButton messageId={user.id} /></div>
            </div>
          )}
          {/* 本轮的执行体流程（工具轨迹组）改为渲染在「MJ Coder」标签下方、正文之前
              （见下方 map 内 k === 0 分支）——此前排在整轮消息之上，与回复正文分离，
              用户需要上下对照才能确认「这一轮到底做了什么」。 */}
          {assistants.map((m, k) => {
            // 底部 token 明细（参考 WorkBuddy：模型名 + 消耗量）；本地历史字段为 camelCase
            const modelName = m.model_name || m.modelName || '';
            const tokensIn = m.tokens_input ?? m.tokensInput ?? 0;
            const tokensOut = m.tokens_output ?? m.tokensOutput ?? 0;
            return (
              <div key={m.id ?? `a-${k}`} className="mb-4 max-w-3xl">
                <div className="text-xs text-text2 mb-1 flex items-center gap-2">
                  MJ Coder
                  <CopyButton text={m.content} />
                  <ForkButton messageId={m.id} />
                </div>
                {/* 本轮执行体流程：紧贴「答复」上方（模型标签之下、正文之上），
                    先看「这一轮做了什么」再看结论。用 label 明示归属，避免用户找不到它在哪。 */}
                {k === answerIdx && calls.length > 0 && (
                  <ToolTraceGroup calls={calls} toolResults={toolResults} label={t('toolTrace.roundExecTrace')} defaultOpen={running && isLast} />
                )}
                {m.content && (
                  <div className="msg-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{m.content}</ReactMarkdown></div>
                )}
                {/* 底部明细：模型 + token 消耗 + 时间。
                    条件放宽：任一信息存在即展示——此前 modelName 为空时整行隐藏，
                    中间消息（有 token 无模型名）与历史消息一律不可见，用户侧「结束信息全缺」。
                    suppressMeta：当轮已有底部 RunFooter（状态/耗时/共消耗/模型/时间）时隐藏本行，
                    避免同一组数字在页面上重复出现两次（用户实测反馈）。 */}
                {!suppressMeta && (modelName || tokensIn + tokensOut > 0 || m.created_at || m.createdAt) && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-text2" title={t('message.tokensTitle', { in: tokensIn.toLocaleString(), out: tokensOut.toLocaleString() })}>
                    <IconCpu size={11} className="shrink-0" />
                    <span>{t('message.totalTokens', { n: (tokensIn + tokensOut).toLocaleString() })}</span>
                    {modelName && <span className="truncate">· {modelName}</span>}
                    {(m.created_at || m.createdAt) && (
                      <span>· {new Date(m.created_at || m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {/* 兜底：本轮只有工具调用、没有任何 assistant 消息时，轨迹组仍需可见 */}
          {answerIdx === -1 && calls.length > 0 && (
            <ToolTraceGroup calls={calls} toolResults={toolResults} label={t('toolTrace.roundExecTrace')} defaultOpen={running && isLast} />
          )}
        </>
      )}
    </div>
  );
}

// running（P0-7）：本轮是否正在跑。运行中强制展开工具组——
// 此前 ToolTraceGroup 的 defaultOpen 恒为 false（注释写着「运行态本轮传 true」但两处调用都没传），
// 用户发起任务后只看到一行「3 次调用 · 点击展开」，完全看不出它正在跑 shell 还是正在改文件。
export function renderMessages(messages, suppressLastMeta = false, onOpenFile, liveCalls = [], running = false) {
  // tool_call_id -> tool 消息内容 索引
  const toolResults = new Map();
  for (const m of messages) {
    if (m.role === 'tool') toolResults.set(m.tool_call_id || m.toolCallId, m);
  }
  // 切轮：user 消息开新一轮；tool 消息由所属 assistant 经 Map 配对渲染，不独立成轮。
  // system 消息（如项目创建时的「目标已锁定」）不是模型回复，单独渲染为居中提示：
  // 此前它被当成 assistant 落到「MJ Coder」气泡里，还带上「共消耗 0 tokens」，
  // 用户会误读成「运行了一次但什么都没有」（真机反馈）。
  type RoundItem = { kind: 'round'; no: number; user: any; assistants: any[] };
  const items: Array<RoundItem | { kind: 'notice'; m: any }> = [];
  let cur: RoundItem | null = null;
  let roundNo = 0;
  for (const m of messages) {
    if (m.role === 'tool') continue;
    if (m.role === 'system') { items.push({ kind: 'notice', m }); continue; }
    if (m.role === 'user') {
      roundNo += 1;
      cur = { kind: 'round', no: roundNo, user: m, assistants: [] };
      items.push(cur);
      continue;
    }
    if (!cur) {
      roundNo += 1;
      cur = { kind: 'round', no: roundNo, user: null, assistants: [] };
      items.push(cur);
    }
    cur.assistants.push(m);
  }
  const lastRoundNo = roundNo;
  return items.map((it, i) => (it.kind === 'notice' ? (
    <div key={it.m.id ?? `sys-${i}`} className="mb-4 flex justify-center">
      <div className="max-w-2xl whitespace-pre-wrap break-words rounded-lg border border-border bg-hover px-3 py-2 text-caption text-text2">
        {String(it.m.content || '')}
      </div>
    </div>
  ) : (
    <RoundBlock
      key={it.user?.id ?? `r-${i}`}
      round={it.no}
      user={it.user}
      assistants={it.assistants}
      toolResults={toolResults}
      isLast={it.no === lastRoundNo}
      running={running}
      suppressMeta={suppressLastMeta && it.no === lastRoundNo}
      extraCalls={it.no === lastRoundNo ? liveCalls : []}
      onOpenFile={onOpenFile}
    />
  )));
}
