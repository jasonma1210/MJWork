import { useState, useEffect, useRef, useMemo } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// S-005：markdown 链接协议白名单（不依赖 react-markdown 的上游默认值，判据在本仓 lib/safeUrl.ts）
import { safeUrlTransform, toExternalHref } from '../lib/safeUrl';
import { MermaidDiagram } from './MermaidDiagram';
import { toast } from './feedback';
import { useI18n } from '../i18n';
// 2026-10-31：文件提及与操作菜单外置到 lib/fileMentions.ts（MessageStream 撞 800 code 行软档）
import { isFilePathLike, fileActionItems, openFileEverywhere } from '../lib/fileMentions'; // T3-2：i18n
import { IconChevronDown, IconChevronRight, IconCopy, IconCpu, IconFile, IconGitBranch, IconSpinner } from './icons';
import { ToolTraceGroup } from './tools/ToolTrace';
import Button from './ui/Button';
import Dot from './ui/Dot';
// 产出卡片/文件 chip 的右键操作菜单（通用组件，定位与关闭语义见 ContextMenu.jsx）
import ContextMenu from './ContextMenu';
// 产出文件的展示档位（设置页可切换：正文内联 / 右侧预览栏）
import { getOutputDisplay } from '../lib/outputDisplay';
// M5 / T5-6：对话内团队协同事件流（默认折叠卡片；不新增独立群聊页）
import TeamRunStream from './TeamRunStream';
// 用户需求 1：思考内容折叠行（默认只显示「正在思考中…」，点击展开）
import ReasoningPanel from './ReasoningPanel';

// T2-2：消息流域（自主进程 ChatArea.jsx 原样搬移，行为不变）——
// 窗口切片（C1）/ 智能滚底（C3）/ 轮次重放（T1-2）/ 本轮概览（T1-5）/ 运行态轨迹与思考流。
// 滚动跟随状态经 useMessageWindow 下沉；windowStart 归 ChatArea（切会话重置在其 effects 中）。

// F-005（2026-10-30）：摘除文件级类型检查豁免并补类型（渲染逻辑零改动）。
// 两条既有事实决定了下面的形状：
// ① 消息双轨字段（服务端 snake_case / 本机 localStore camelCase）必须都认，故字段全可选；
// ② env.d.ts 把 window.mjcode 声明为 `(...args: unknown[]) => unknown`，桥面返回值全是 unknown，
//    这里用一个 asBridgeResult 收口（精确桥面接口依赖本项 F-005 完成后才能做，见 bridge-parity 注释）。

/** 工具调用：主进程原样透传 function 形态，兼容已展开的 name/args */
export interface StreamToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  function?: { name?: string; arguments?: string };
  result?: unknown;
}

/** 一条消息（双轨字段兼容，见上方 ①） */
export interface StreamMessage {
  id?: string;
  role?: string;
  content?: string;
  tool_calls?: StreamToolCall[];
  toolCalls?: StreamToolCall[];
  tool_call_id?: string;
  toolCallId?: string;
  model_name?: string;
  modelName?: string;
  tokens_input?: number;
  tokensInput?: number;
  tokens_output?: number;
  tokensOutput?: number;
  created_at?: string;
  createdAt?: string;
}

/** 上下文用量（App 计算后传入） */
export interface ContextUsage {
  used: number;
  total: number;
  ratio: number;
}

/** 本轮概览：结束态（RunFooter 固定收尾条）。
 *  字段全部**必填**：三处构造点（useAgentRun 成功/异常分支、lib/runLifecycle）每次都写全，
 *  声明成可选会逼消费方到处写 `|| 0` 兜底（把契约模糊化成运行时猜测）。
 *  M2（2026-10-30）：stopReason / rounds / toolCalls / checkpointSaved 是引擎终态真值，
 *  异常收尾与历史重放拿不到（那两种形态下「为什么停」另有语义），故可选——
 *  声明成必填会把「没有真值」逼成「填 0 假装有」，正是本轮要消灭的谎报。 */
export interface RunSummary {
  status: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  endedAt: number;
  /** 引擎给的「为什么停」：空串/缺省 = 正常完成。取值见 agent-core/exhaustedNotice.js 的 STOP_REASONS。 */
  stopReason?: string;
  /** 本 run 实际执行的轮数（引擎终态真值） */
  rounds?: number;
  /** 本 run 的工具动作条数 */
  toolCalls?: number;
  /** 断点是否真落盘——决定给不给「结束本轮」 */
  checkpointSaved?: boolean;
  /** M4：独立 Judge 的账单 */
  judgeTokens?: number;
  judgeCalls?: number;
  /** M5：验收标准满足率。acTotal=0 ⇒ 不渲染（未判定不得显示成 0/0 或满分） */
  acTotal?: number;
  acSatisfied?: number;
  /** M6：路由判定结果。'plan' ⇒ 本轮是「自动判定为复杂目标 → 先出计划」，
   *  界面必须说明原因，否则用户只看到一份计划、以为模型不肯动手。 */
  routeMode?: string;
  /** 2026-10-31：Judge 结论（缺几项 / 有无事实性错误）——只有 acTotal>0 时才有意义 */
  judgeMissing?: number;
  judgeError?: boolean;
  /** 2026-10-31：额度余量（上限 / 已用 / 轮次上限） */
  totalCap?: number;
  totalSpent?: number;
  roundCap?: number;
}

/** 本轮概览：运行态（每秒刷新） */
export interface RunLive {
  startedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  contextUsage?: ContextUsage | null;
  model?: string;
}

/** 桥面返回值的窄化读取器。
 *  env.d.ts 把 window.mjcode 声明成 `(...args: unknown[]) => unknown`，直接 `r.ok` 在 TS 下是
 *  「Property 'ok' does not exist on type '{}'」（unknown 被真值判断窄化成 {}）。这里用一次断言
 *  把 unknown 收成结果形状，调用点保持 `r.ok === false` 的自然写法，不必每处散落 as。
 *  精确桥面接口（每个方法一个签名）是 F-005 之后的独立项，届时本函数可整体删除。 */

// C1：窗口切片步长（条）。ChatArea 首屏初始化与 MessageStream「加载更早」共用同一口径。
export const MSG_WINDOW = 50;

// C3：智能滚底 hook——仅当用户已在底部附近（<80px）才跟随；上翻历史时不再被强制拽回，
// 由悬浮的「回到底部」按钮接管（stickToBottomRef 在 onScroll 中维护）。
function useMessageWindow(
  { messages, streamingText, toolCallsCount }: { messages: StreamMessage[]; streamingText: string; toolCallsCount: number },
) {
  const scrollRef = useRef<HTMLDivElement>(null);
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
    // 取局部引用：原写法 `ref.current?.scrollTo(0, ref.current.scrollHeight)` 在 TS 下第二个
    // ref.current 不被上一行的 ?. 窄化（可能为 null）。语义不变——为空时同样整句跳过。
    const el = scrollRef.current;
    if (stickToBottomRef.current && el) el.scrollTo(0, el.scrollHeight);
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

export interface MessageStreamProps {
  messages: StreamMessage[];
  /** 窗口切片起点（ChatArea 持有，切会话时重置） */
  windowStart: number;
  onLoadEarlier: (from: number) => void;
  loading: boolean;
  toolCalls: StreamToolCall[];
  reasoningText: string;
  streamingText: string;
  runSummary: RunSummary | null;
  runUsage?: { tokensIn?: number; tokensOut?: number } | null;
  runStartedAt?: number;
  contextUsage?: ContextUsage | null;
  model?: string;
  runFiles?: Array<string | { path: string }>;
  onOpenFile?: (p: string) => void;
  /** 项目根目录：产出卡片右键动作把工具参数里的相对路径解析成绝对路径 */
  cwd?: string;
  /** 当前会话 id —— 团队事件流按 thread_id 归属过滤（不跨会话串卡） */
  threadId?: string | null;
}

export default function MessageStream({
  messages, windowStart, onLoadEarlier,
  loading, toolCalls, reasoningText, streamingText,
  runSummary, runUsage, runStartedAt, contextUsage, model,
  runFiles = [],
  onOpenFile,
  cwd = '',
  threadId = null,
}: MessageStreamProps) {
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
    () => renderMessages(visibleMessages, !!runSummary || !!loading, onOpenFile, toolCalls, !!loading, cwd),
    // visibleMessages 由 messages/effStart 派生，故直接以二者为依赖（避免数组身份每帧变化）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, effStart, runSummary, loading, onOpenFile, toolCalls, cwd],
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
          // 撤回逻辑在 ChatArea（它持有基线 SHA 与会话信息），这里只负责派发
          onRevertRun={runFiles.length > 0 ? () => window.dispatchEvent(new CustomEvent('mjcode:revert-run')) : undefined}
          // 2026-10-30 用户需求：运行结束后，思考内容收进收尾条的过程折叠区（默认收起）。
          // 只在「有思考内容且已结束」时传——运行中另有实时思考行（见下），避免两处同时出现。
          process={!loading && String(reasoningText || '').length > 0
            ? <ReasoningPanel text={reasoningText} loading={false} chars={receivedChars} />
            : null}
        />
        {/* 用户需求 2：整段回复的最末尾放「查看所有产物 (N)」，点开才是文件卡片——
            位置放在收尾条之后，即「一句话说完、数字看完、产物要看自己点」。 */}
        <RunOutputFiles files={runFiles} onOpenFile={onOpenFile} cwd={cwd} />
        {/* T1-1+T1-2：运行态工具轨迹已并入最后一轮块（答复正文之上），此处不再重复渲染 */}
        {/* 运行中：思考行留在正文上方（要能实时看见它在想）；结束后已收进上面的过程折叠区，
            不再额外渲染（否则「已完成」条下面会再冒出一行，位置与语义都错）。 */}
        {loading && <ReasoningPanel text={reasoningText} loading elapsedSec={elapsedSec} chars={receivedChars} />}
        {streamingText && (
          <div className="mb-4 max-w-3xl">
            <div className="text-xs text-text2 mb-1">MJ Nexus <span className="animate-pulse">▋</span></div>
            <div className="msg-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrlTransform}>{streamingText}</ReactMarkdown></div>
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
function CopyButton({ text }: { text?: string }) {
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
function ForkButton({ messageId }: { messageId?: string | number | null }) {
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
export interface RunFooterProps {
  summary: RunSummary | null;
  /** 运行态数据（null = 已结束，走 summary） */
  live?: RunLive | null;
  changedCount?: number;
  onOpenChanges?: () => void;
  onRevertRun?: () => void;
  /**
   * 收尾条的「过程折叠区」（2026-10-30 用户需求）：运行结束后，思考/工具轨迹这类过程性内容
   * 默认收进收尾条后面的一行「查看处理过程」，点开才铺开——用户先看结论，想复盘再展开。
   * 运行中不传（思考行留在正文上方实时可见）。
   */
  process?: ReactNode;
}

export function RunFooter({ summary, live, changedCount = 0, onOpenChanges, onRevertRun, process }: RunFooterProps) {
  // 组件内已有局部变量 t（定时器），i18n 译函数改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [, tick] = useState(0);
  // 过程折叠区的展开态：默认收起（用户先看结论），点击才铺开思考/轨迹
  const [procOpen, setProcOpen] = useState(false);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!summary && !live) return null;
  const fmtDur = (ms: number) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
  };
  const chip = 'inline-flex items-center gap-1 text-xs text-text2 bg-surface border border-border rounded-lg px-3 py-2 gap-x-3 gap-y-1 flex-wrap';
  // 运行中概览：实时数据流（startedAt/usage/contextUsage 由调用方每轮渲染传入最新值）
  if (live) {
    const total = (live.tokensIn || 0) + (live.tokensOut || 0);
    // 取局部变量而不是就地 `live.startedAt > 0 && ...live.startedAt`：
    // 后者在 TS 下 `> 0` 这一步就已经「可能为 undefined」，且比较式不会把属性窄化给后面的表达式。
    const startedAt = live.startedAt || 0;
    return (
      <div className="mb-4 max-w-3xl">
        <div className={chip}>
          <span className="inline-flex items-center gap-1 text-accent">
            <IconSpinner size={11} className="animate-spin" />
            {tr('message.running')}
          </span>
          {startedAt > 0 && <span>{tr('message.elapsed', { dur: fmtDur(Date.now() - startedAt) })}</span>}
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
  // 结束态：走到这里的必然有 summary（「无 summary 且无 live」已在上面返回，且 live 分支刚 return 掉），
  // 这条判断只为把类型收窄给 TS——它不做「summary 为空 ⇒ live 非空」的关联推理。
  if (!summary) return null;
  const STATUS: Record<string, { label: string; cls: string; dot: string }> = {
    done: { label: tr('message.statusDone'), cls: 'text-success', dot: 'bg-success' },
    aborted: { label: tr('message.statusAborted'), cls: 'text-warn', dot: 'bg-warn' },
    suspended: { label: tr('message.statusSuspended'), cls: 'text-warn', dot: 'bg-warn' },
    // M2：引擎停下了但**没有断点**（轮次上限 / 空转熔断 / 断点落盘失败）。
    // 与 suspended 分开说才诚实：前者「回复继续即可从断点续跑」，后者「没有断点，只是没跑完」。
    incomplete: { label: tr('message.statusIncomplete'), cls: 'text-warn', dot: 'bg-warn' },
    error: { label: tr('message.statusError'), cls: 'text-danger', dot: 'bg-danger' },
  };
  const st = (summary.status && STATUS[summary.status]) || STATUS.done;
  const total = (summary.tokensIn || 0) + (summary.tokensOut || 0);
  // M2：停止原因必须显式说出来——「为什么停」是长任务里用户唯一真正想知道的读数。
  // 只认引擎给的枚举，不认自由文本：未知值一律不渲染（宁缺也不能编）。
  const STOP_LABEL: Record<string, string> = {
    context: tr('message.stopReasonContext'),
    'total-cap': tr('message.stopReasonTotalCap'),
    wallclock: tr('message.stopReasonWallclock'),
    rounds: tr('message.stopReasonRounds'),
    repeat: tr('message.stopReasonRepeat'),
  };
  const stopLabel = summary.stopReason ? STOP_LABEL[summary.stopReason] : '';
  const rounds = summary.rounds || 0;
  const toolCalls = summary.toolCalls || 0;
  const acTotal = summary.acTotal || 0;
  const acSatisfied = summary.acSatisfied || 0;
  // M6：自动判定为「复杂目标」（plan / 拿不准按 plan 处理）时本轮只出计划。
  // 手动规划不在此列（那种情况 routeMode 是 'single'）——只解释**自动**那一次。
  const autoPlan = summary.routeMode === 'plan' || summary.routeMode === 'unsure';
  // 2026-10-31：Judge 结论与额度余量（都只在有值时才渲染，不拿 0 冒充「已判/没闸」）
  const judgeMissing = summary.judgeMissing || 0;
  const judgeError = summary.judgeError === true;
  const totalCap = summary.totalCap || 0;
  const totalSpent = summary.totalSpent || 0;
  const roundCap = summary.roundCap || 0;
  const quotaPct = totalCap > 0 ? (totalSpent / totalCap) * 100 : 0;
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
        {/* M2：进度读数「第 N 轮 · M 个动作」——长任务里「跑了多久/做到哪」是判断
            是否值得继续的唯一依据。两个数字都为 0（异常收尾拿不到真值）时整块不渲染。 */}
        {rounds > 0 && (
          <span>{roundCap > 0
            ? tr('message.roundsAndActionsCap', { n: rounds, cap: roundCap, m: toolCalls })
            : tr('message.roundsAndActions', { n: rounds, m: toolCalls })}</span>
        )}
        {/* M5：进度口径改成 AC 满足率（设计文档 §6.2）——「跑了几轮」不代表「做到了几成」。
            acTotal=0（无验收基线或 Judge 未判定）时整块不渲染：显示 0/0 是假装知道进度。 */}
        {acTotal > 0 && (
          <span>{tr('message.acProgress', { done: acSatisfied, total: acTotal })}</span>
        )}
        {/* 2026-10-31：光有「验收 2/4」说不清还差什么——缺项数要说出来；
            审查发现事实性出入时单独标红（那比缺项更严重，属于「说做了但没做」）。 */}
        {acTotal > 0 && judgeMissing > 0 && (
          <span className="text-warn">{tr('message.judgeMissing', { n: judgeMissing })}</span>
        )}
        {judgeError && <span className="text-danger">{tr('message.judgeError')}</span>}
        {/* 2026-10-31：额度余量常驻——此前用户只在撞闸那一刻才知道有闸。
            80% 起转 warn 色；totalCap=0（未启用总闸）时不渲染，不假装有闸。 */}
        {totalCap > 0 && (
          <span
            className={quotaPct >= 80 ? 'text-warn' : 'text-text2'}
            title={tr('message.quotaTitle', { used: totalSpent.toLocaleString(), cap: totalCap.toLocaleString() })}
          >
            {tr('message.quotaPct', { pct: quotaPct >= 1 ? String(Math.round(quotaPct)) : quotaPct.toFixed(1) })}
          </span>
        )}
        {/* M6（设计文档 §2/§2.5）：自动判定为复杂目标 ⇒ 本轮只出计划、不动手。
            必须把原因说出来：用户看到的是一份「没改任何东西」的答复，
            不解释就会被当成模型偷懒或工具坏了（同理见 M2 的停止原因）。 */}
        {autoPlan && <span>{tr('message.routeAutoPlan')}</span>}
        {/* M2：停止原因（引擎真值）。文案与收尾正文同源，用户不必去正文里找为什么停。 */}
        {stopLabel && <span className="text-warn">{stopLabel}</span>}
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
        {/* P1（2026-10-22）「撤回本轮」：信任的地基——用户敢让 Agent 一次改 8 个文件，
            前提是能一键退回。恢复源是本轮开始前的基线（不是 HEAD），所以不会连带丢掉
            用户在 run 之前自己的未提交改动。 */}
        {changedCount > 0 && typeof onRevertRun === 'function' && (
          <Button variant="danger-ghost" size="xs" onClick={onRevertRun}>
            {tr('message.revertRun')}
          </Button>
        )}
        {/* 暂停后的两个动作（设计文档 §6.1：halt 之后必须给「继续 / 终止」二选一）：
            · 继续 = 走唯一发送漏斗发一条「继续」，断点由既有链路自动消费（不需要用户手打）；
            · 结束本轮 = 显式丢弃断点。为什么必须有它：断点判定是「有断点就恢复」，
              若用户暂停后改了主意、直接问别的事，旧断点会被注入成上下文（污染下一轮）。
            两者都经 CustomEvent 交给 ChatArea——收尾条不需要知道会话与 IPC 细节。 */}
        {/* 「继续」对两种未完形态都成立（有断点走断点，没断点就是接着做）；
            「结束本轮」只给**真有断点**的那种——没有断点就没有可丢弃的东西，
            给了只会让 toast 说「已丢弃断点」（对不存在的东西撒谎）。 */}
        {(summary.status === 'suspended' || summary.status === 'incomplete') && (
          <Button variant="accent-ghost" size="xs"
            onClick={() => window.dispatchEvent(new CustomEvent('mjcode:continue-run'))}>
            {tr('message.resumeRun')}
          </Button>
        )}
        {summary.status === 'suspended' && (
          <Button variant="ghost" size="xs"
            onClick={() => window.dispatchEvent(new CustomEvent('mjcode:discard-checkpoint'))}>
            {tr('message.discardCheckpoint')}
          </Button>
        )}
        {/* 过程折叠开关：与「查看本轮改动」同为收尾条上的动作，位置固定在行尾。
            文案与箭头都随状态切换——用户不必猜这一下是展开还是收起。 */}
        {process && (
          <Button variant="accent-ghost" size="xs" onClick={() => setProcOpen((v) => !v)}
            title={procOpen ? tr('message.processCollapse') : tr('message.processExpand')}>
            {procOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
            {procOpen ? tr('message.processCollapse') : tr('message.processExpand')}
          </Button>
        )}
      </div>
      {/* 展开区：缩进与正文同左缘，视觉上「属于本轮」而不是另一段落 */}
      {process && procOpen && <div className="mt-2">{process}</div>}
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

/** 本轮产出文件：任务结束后列出本轮被写入/修改的文件（左键在右侧预览栏打开；右键出操作菜单）
 *  2026-10-30：默认收起成一行「查看所有产物 (N)」，点开才铺卡片；defaultOpen 供渲染冒烟直测展开分支。 */
export function RunOutputFiles({ files = [], onOpenFile, cwd, defaultOpen = false }: { files?: Array<string | { path: string }>; onOpenFile?: (p: string) => void; cwd?: string; defaultOpen?: boolean }) {
  const { t } = useI18n();
  const list = (files || []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean);
  const first = list[0];
  // 右键菜单锚点：三张卡片共用同一个 ContextMenu，只换锚点与目标路径
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // 展开态必须在所有 early-return 之前声明，否则违反 hooks 顺序（无产出时不渲染会让顺序漂移）
  const [open, setOpen] = useState(defaultOpen);
  // 展示档位在渲染时现读：设置页改完回到对话区即生效（无需重启）
  const display = getOutputDisplay();
  // panel 档：首个产出自动开在右侧预览栏。按路径判重，避免每次重渲染都把预览栏拽回去。
  const autoOpenedRef = useRef('');
  useEffect(() => {
    if (display !== 'panel' || !first) return;
    if (autoOpenedRef.current === first) return;
    autoOpenedRef.current = first;
    onOpenFile?.(first);
  }, [display, first, onOpenFile]);
  if (!list.length) return null;

  // 三个动作都只传「卡片路径 + 项目根」：相对路径的解析统一在主进程做（与工具层同一语义）
  const itemsFor = (target: string) => fileActionItems(target, cwd, t);

  // 右侧面板档：正文只留一个计数 chip（文件已在预览栏可见，不再重复铺一列卡片）
  if (display === 'panel') {
    return (
      <div className="mb-4 max-w-3xl">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-text2">
          <IconFile size={13} className="text-accent shrink-0" />
          <span>{t('message.outputFilesCompact', { n: list.length })}</span>
        </div>
      </div>
    );
  }

  // 用户需求 2（2026-10-30）：默认收起，正文末尾只留一行「查看所有产物 (N)」，
  // 点开才铺卡片——长任务动辄几十个文件，全铺出来会把答复正文挤到看不清。
  return (
    <div className="mb-4 max-w-3xl">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-text2 hover:text-text select-none"
        title={open ? t('message.hideArtifacts') : t('message.viewAllArtifacts', { n: list.length })}
      >
        {open ? <IconChevronDown size={12} className="shrink-0" /> : <IconChevronRight size={12} className="shrink-0" />}
        <span>{open ? t('message.hideArtifacts') : t('message.viewAllArtifacts', { n: list.length })}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-2 rounded-xl border border-border bg-surface p-3">
          {list.map((path) => {
            const name = path.split('/').pop() || path;
            const dir = path.length > name.length ? path.slice(0, path.length - name.length - 1) : '';
            return (
              <button
                key={path}
                type="button"
                onClick={() => openFileEverywhere(onOpenFile, path)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, path }); }}
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
      )}
      <ContextMenu
        open={!!menu}
        x={menu?.x || 0}
        y={menu?.y || 0}
        items={menu ? itemsFor(menu.path) : []}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

/** 正文内联代码 → 可点击的文件 chip：左键在右侧预览栏打开；右键 /「…」出同一套 5 项菜单。
 *  可点性只看路径形态、不再依赖「是否拿到回调」——此前 onOpenFile 缺失时 chip 退化成灰色不可点文本，
 *  用户点它当然「没有任何反应」；现在回调缺失由 openFileEverywhere 走事件总线兜底。 */
function FileRefChip({ text, onOpenFile, cwd }: { text: string; onOpenFile?: (p: string) => void; cwd?: string }) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const base = 'rounded px-2 py-1 text-xs border';
  if (!isFilePathLike(text)) {
    return (
      <code className={`${base} bg-hover border-border text-text2 font-mono`}>{text}</code>
    );
  }
  return (
    <span className="relative inline-flex items-center gap-1 align-baseline">
      <button
        type="button"
        onClick={() => openFileEverywhere(onOpenFile, text)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
        title={t('message.openFileHint')}
        className={`${base} bg-accent/10 border-accent/40 text-accent font-mono hover:bg-accent/20 cursor-pointer`}
      >
        {text}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
        title={t('message.fileActions')}
        aria-label={t('message.fileActions')}
        className="shrink-0 text-text2 hover:text-text rounded p-1 align-middle"
      >
        <IconChevronDown size={11} />
      </button>
      {menu && (
        <ContextMenu open x={menu.x} y={menu.y} items={fileActionItems(text, cwd, t)} onClose={() => setMenu(null)} />
      )}
    </span>
  );
}

/** markdown 渲染器的自定义节点：只改「行内代码」与「本地链接」，其余保持默认语义 */
function markdownComponents(onOpenFile?: (p: string) => void, cwd?: string) {
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
      return <FileRefChip text={raw} onOpenFile={onOpenFile} cwd={cwd} />;
    },
    // 本地相对链接（非 http/mailto/#）同样走文件打开
    a: ({ href, children, ...rest }: { href?: string; children?: ReactNode }) => {
      const h = String(href || '');
      if (h && !/^(https?:|mailto:|#|\/\/)/i.test(h) && isFilePathLike(h)) {
        return (
          <button type="button" onClick={() => openFileEverywhere(onOpenFile, h)} className="text-accent underline hover:opacity-80">
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
      // S-005：`//host/path` 协议相对链接也归到这一类（补成 https 后交给系统浏览器），
      // 不再原样输出 href——那既会在应用窗口内导航，也是 XSS 兜底口。
      const ext = toExternalHref(h);
      if (ext) {
        return (
          <a
            href={ext}
            {...rest}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              try { window.mjcode?.openExternal?.({ url: ext }); } catch { /* 桥不可用则退回浏览器默认行为 */ }
            }}
          >
            {children}
          </a>
        );
      }
      // 页内锚点：不离开当前页，保留可点击
      if (h.startsWith('#')) return <a href={h} {...rest} rel="noreferrer">{children}</a>;
      // S-005 兜底：空 href / 未知 scheme（javascript:、data:、vbscript: …）不再产出可达 <a>，
      // 一律降级为纯文本。此前这里是 `<a href={href}>`——上游 urlTransform 一旦放宽即成现成 sink。
      return <span>{children}</span>;
    },
  };
}

export interface RoundBlockProps {
  round: number;
  user?: StreamMessage | null;
  assistants: StreamMessage[];
  /** tool_call_id → tool 消息（内容索引） */
  toolResults: Map<string | undefined, StreamMessage>;
  isLast: boolean;
  running?: boolean;
  suppressMeta?: boolean;
  /** 运行态工具调用（主进程还没落库的那部分），接到消息自带 calls 之后去重合并 */
  extraCalls?: StreamToolCall[];
  onOpenFile?: (p: string) => void;
  cwd?: string;
}

// 轮次块：一轮的 user 气泡 + 工具轨迹组 + assistant 回复（含 meta）。折叠状态本组件持有。
function RoundBlock({ round, user, assistants, toolResults, isLast, running = false, suppressMeta = false, extraCalls = [], onOpenFile, cwd }: RoundBlockProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(isLast);
  const calls: StreamToolCall[] = [];
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
  const md = markdownComponents(onOpenFile, cwd);
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
            <div className="mb-4 flex justify-end group">
              <div className="msg-prose bg-surface rounded-2xl px-4 py-2 max-w-2xl">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={md} urlTransform={safeUrlTransform}>{user.content}</ReactMarkdown>
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
            // 时间戳取局部变量：`(a || b) && ... new Date(a || b)` 这种写法 TS 不会把括号里
            // 的判空结果传给后面的表达式，取值到变量后既收窄了类型，也少算一次。
            const createdAt = m.created_at || m.createdAt || '';
            return (
              <div key={m.id ?? `a-${k}`} className="mb-4 max-w-3xl group">
                <div className="text-xs text-text2 mb-1 flex items-center gap-2">
                  MJ Nexus
                  <CopyButton text={m.content} />
                  <ForkButton messageId={m.id} />
                </div>
                {/* 本轮执行体流程：紧贴「答复」上方（模型标签之下、正文之上），
                    先看「这一轮做了什么」再看结论。用 label 明示归属，避免用户找不到它在哪。 */}
                {k === answerIdx && calls.length > 0 && (
                  <ToolTraceGroup calls={calls} toolResults={toolResults} label={t('toolTrace.roundExecTrace')} defaultOpen={running && isLast} />
                )}
                {m.content && (
                  <div className="msg-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} components={md} urlTransform={safeUrlTransform}>{m.content}</ReactMarkdown></div>
                )}
                {/* 底部明细：模型 + token 消耗 + 时间。
                    条件放宽：任一信息存在即展示——此前 modelName 为空时整行隐藏，
                    中间消息（有 token 无模型名）与历史消息一律不可见，用户侧「结束信息全缺」。
                    suppressMeta：当轮已有底部 RunFooter（状态/耗时/共消耗/模型/时间）时隐藏本行，
                    避免同一组数字在页面上重复出现两次（用户实测反馈）。 */}
                {!suppressMeta && (modelName || tokensIn + tokensOut > 0 || createdAt) && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-text2" title={t('message.tokensTitle', { in: tokensIn.toLocaleString(), out: tokensOut.toLocaleString() })}>
                    <IconCpu size={11} className="shrink-0" />
                    {tokensIn + tokensOut > 0 && (
                      <span>{t('message.totalTokens', { n: (tokensIn + tokensOut).toLocaleString() })}</span>
                    )}
                    {modelName && <span className="truncate">· {modelName}</span>}
                    {createdAt && (
                      <span>· {new Date(createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
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
export function renderMessages(
  messages: StreamMessage[],
  suppressLastMeta = false,
  onOpenFile?: (p: string) => void,
  liveCalls: StreamToolCall[] = [],
  running = false,
  cwd = '',
) {
  // tool_call_id -> tool 消息内容 索引
  const toolResults = new Map<string | undefined, StreamMessage>();
  for (const m of messages) {
    if (m.role === 'tool') toolResults.set(m.tool_call_id || m.toolCallId, m);
  }
  // 切轮：user 消息开新一轮；tool 消息由所属 assistant 经 Map 配对渲染，不独立成轮。
  // system 消息（如项目创建时的「目标已锁定」）不是模型回复，单独渲染为居中提示：
  // 此前它被当成 assistant 落到「MJ Coder」气泡里，还带上「共消耗 0 tokens」，
  // 用户会误读成「运行了一次但什么都没有」（真机反馈）。
  type RoundItem = { kind: 'round'; no: number; user: StreamMessage | null; assistants: StreamMessage[] };
  const items: Array<RoundItem | { kind: 'notice'; m: StreamMessage }> = [];
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
      cwd={cwd}
    />
  )));
}
