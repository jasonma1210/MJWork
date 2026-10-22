// P0-4（2026-10-22）：会话上下文压缩的唯一实现（含压缩前的撤销带）。
//
// 独立成模块的两个原因：
//  ① `useAgentRun` 贴在 800 行 God File 软档上（门禁只减不增），而压缩本身是纯数据操作，
//     只有「替换可见消息」这一步属于视图层；
//  ② 这段逻辑此前踩过真实事故：拿 `selectedModel` 直接压缩（它不含 context_window）
//     ⇒ 引擎回落 4096 窗口 ⇒ 超过约 3.3k token 的会话全被判激进档、只留 15% 尾部，
//     随后 replaceMessages **整体覆盖数据库**（不可逆）。独立后它可以被单测直接驱动
//     （见 test/compact-safety.test.mjs 的行为段）。
//
// 三条纪律：
//  1. 窗口必须用「运行时那份」model —— context_window 由 effectiveContextWindow 现算注入；
//  2. 运行中禁止压缩 —— replaceMessages 按 threadId 全删再插，会与主进程正在追加的消息互相覆盖；
//  3. 压缩前留撤销带（localStorage），落库成功后给「撤销」出口。这是本产品唯一不可逆的数据动作。
import { compactHistory } from '../../../agent-core/index.js';
import { buildRunModel } from './modelConfig';

const UNDO_PREFIX = 'mj_compact_undo_';
/** 撤销带只留最近 400 条：它是安全网，不是第二份全量存储 */
const UNDO_MAX_MESSAGES = 400;

export interface CompactSessionDeps {
  /** 当前可见消息（会话历史） */
  messages: Array<{ role: string; content: unknown }>;
  /** 当前选中模型（selectedModel：**不含** context_window，那要现算） */
  model: any;
  /** 本轮是否正在运行——运行中不得压缩 */
  loading: boolean;
  threadId?: number | string | null;
  chat: (payload: any) => Promise<any>;
  replaceMessages?: (threadId: any, list: any[]) => Promise<any>;
  setMessages: (list: any[]) => void;
  setWindowStart: (n: number) => void;
  toast: (opts: any) => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

/**
 * 压缩当前会话并落库。返回值无意义（成功/失败都通过 toast 反馈），
 * 异常已在内部收敛——调用方只需负责 compacting 状态。
 */
export async function compactSession(d: CompactSessionDeps): Promise<void> {
  const { messages, model, loading, threadId, chat, replaceMessages, setMessages, setWindowStart, toast, t } = d;
  if (!model || !Array.isArray(messages) || messages.length === 0) return;
  if (loading) {
    // 运行中压缩 = 两处同时写同一个会话（replaceMessages 全删再插 vs 主进程追加中间消息）
    toast({ message: t('runtime.compactBusy') });
    return;
  }
  const convo = messages.map((m) => ({ role: m.role, content: m.content || '' }));
  // ① 窗口现算注入（与 send 共用 buildRunModel）：不这么做引擎拿到 undefined
  //    → DEFAULT_CONTEXT_WINDOW_FALLBACK（4096）→ 长会话被激进裁剪后覆盖数据库
  const runModel = buildRunModel(model);
  let compacted: any[];
  try {
    // force：用户主动点「压缩」就该压。不带 force 时引擎只在体积超过窗口 70% 才动手，
    // 窗口修对后大部分会话都不到闸门 ⇒ 点了没反应（此前的静默 return）。
    // 无收益场景仍由引擎内部「不足两轮 / 无可裁内容」两道闸兜住，不会白付摘要调用。
    compacted = await compactHistory(convo, runModel, chat, { force: true });
  } catch (err: any) {
    console.warn('[chat] context compaction failed:', err);
    toast({ message: t('runtime.compactFailed', { error: err?.message || t('runtime.unknownError') }) });
    return;
  }
  if (!Array.isArray(compacted) || compacted.length >= convo.length) return;

  // ③ 撤销带：压缩前的原始历史（落库成功后用户可一键恢复）
  const undoKey = `${UNDO_PREFIX}${threadId ?? 'local'}`;
  let hasUndo = false;
  try {
    localStorage.setItem(undoKey, JSON.stringify(convo.slice(-UNDO_MAX_MESSAGES)));
    hasUndo = true;
  } catch (e: any) {
    console.warn('[chat] compaction undo snapshot failed:', e?.message);
  }
  setMessages(compacted);
  setWindowStart(0);

  const undo = async () => {
    try {
      const raw = localStorage.getItem(undoKey);
      if (!raw) return;
      const prev = JSON.parse(raw);
      if (!Array.isArray(prev) || prev.length === 0) return;
      setMessages(prev);
      setWindowStart(0);
      if (threadId && replaceMessages) await replaceMessages(threadId, prev);
      localStorage.removeItem(undoKey);
      toast({ message: t('runtime.compactUndone') });
    } catch (err: any) {
      console.warn('[chat] compaction undo failed:', err?.message);
      toast({ message: t('runtime.compactUndoFailed', { error: String(err?.message || err) }) });
    }
  };
  const offerUndo = () => toast({
    message: t('runtime.compactSaved'),
    ...(hasUndo ? { actionLabel: t('app.undo'), onAction: undo } : {}),
  });

  if (!threadId) { offerUndo(); return; }
  if (!replaceMessages) { offerUndo(); return; }
  try {
    const r = await replaceMessages(threadId, compacted);
    if (r?.ok) offerUndo();
    else if (r?.error) toast({ message: t('runtime.compactNotPersisted', { error: r.error }) });
  } catch (err: any) {
    // 在线模式等无替换通道：仅当前窗口生效（静默降级，不打断压缩流程）
    console.warn('[chat] compaction persist unavailable (current window only):', err?.message);
  }
}
