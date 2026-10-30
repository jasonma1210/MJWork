// P0-2：审批响应按 approvalId 分发（纯逻辑，可单测）
// 背景：原实现 ipcMain.once('tool:approval-response') 共享一条无 id 通道——
// 多个工具并发触发审批时，第一个到达的响应会被「任一个」等待中的 Promise 消费，
// 审批决策可能张冠李戴（把「允许」发给另一条更危险的命令）。CUA 仅为自身开了独立通道。
// 方案：requestApproval 生成唯一 approvalId，响应负载回带 id，按 id 精确分发；
//      未知 / 已超时的审批响应一律忽略（fail-closed，防串扰与重放）。

// V12：合法决策枚举——未知值 fail-closed 收敛为 deny
const { APPROVAL_WAIT_TIMEOUT_MS } = require('./tools/timeouts');
const VALID_DECISIONS = new Set(['once', 'conversation', 'always', 'deny']);
function normalizeDecision(decision) {
  return VALID_DECISIONS.has(decision) ? decision : 'deny';
}

// P1-4：用户理由归一化——trim、截断（工具结果与审计行都要落它，不能无限长）、
// 空串归一为 null（「无理由」与旧行为完全一致：决议值仍是纯决策字符串）。
function normalizeReason(reason) {
  if (reason == null) return null;
  const s = (typeof reason === 'string' ? reason : String(reason)).trim();
  if (!s) return null;
  return s.length > 500 ? `${s.slice(0, 499)}…` : s;
}

// P1-4：拒绝结果文案（单一事实来源，exec.js / main.js 各拒绝点共用）——
// 用户附了理由时拼进工具结果，模型下一轮就能看到「为什么被拒、该怎么做」；
// 无理由时保持旧串，行为与修复前逐字一致。
function denialText(reason) {
  return reason ? `用户拒绝执行。理由：${reason}` : '用户拒绝执行';
}

// P1-4：从审批等待结果上取回用户理由（无理由返回空串）。
// 用法（拒绝点）：
//   const approvalWait = deps.requestApproval(toolKey, args);
//   const decision = await approvalWait;
//   if (decision === 'deny') { const reason = approvalReasonOf(approvalWait); ... }
// 理由经 wait() 返回的 Promise 的只读 reason 属性暴露——决议值本身保持字符串，
// 全部既有调用点（decision === 'deny' 比较）零改动。
function approvalReasonOf(approvalWait) {
  const r = approvalWait && approvalWait.reason;
  return typeof r === 'string' ? r : '';
}

class ApprovalChannel {
  constructor({ timeoutMs = APPROVAL_WAIT_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // approvalId -> { resolve, timer }
    this.seq = 0;
  }

  // 生成唯一审批 id（时间无关，进程内单调递增即可）
  nextId() {
    this.seq += 1;
    return `ap-${Date.now().toString(36)}-${this.seq}`;
  }

  // 发起一次审批等待：返回 Promise<'once'|'conversation'|'always'|'deny'>，超时按 deny
  // onSettle(approvalId, reason)：本次审批**无论以何种方式结束**（用户决策 / 超时 /
  // 进程退出）都会回调一次。渲染层据此撤下卡片——
  // 事故背景：此前卡片一旦弹出就常驻，主进程侧 pending 超时消失后用户再点，
  // 主进程找不到该 id 只能记「收到无法匹配的审批响应，已忽略」，用户看到的是
  // 「点了没反应 / 命令继续执行」，实际是这次审批早已按 deny 收尾。
  // N5（2026-10-16）：可选 runId——审批挂到发起它的运行上，运行取消时统一撤下（cancelByRun）。
  // P1-4（2026-10-17）：返回的 Promise 附加只读 reason 属性——用户随决议提交的理由
  // （如「用 npm 别用 pnpm」）。settle 后立即可读；无理由 / 超时 / 取消时为 null。
  // 之所以挂在 Promise 上而不是改决议值形状：全部调用点都在比较 decision === 'deny'，
  // 改形状会炸掉约 15 处消费方（exec/main/mcp/plugins/chrome/browser/cua…）。
  wait(approvalId, onSettle, runId = null) {
    const reasonBox = { value: null };
    const promise = new Promise((resolve) => {
      let settled = false;
      const finish = (value, settleReason, userReason = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(approvalId);
        reasonBox.value = normalizeReason(userReason);
        resolve(value);
        try { onSettle?.(approvalId, settleReason, reasonBox.value); } catch { /* 回调失败不影响审批结果 */ }
      };
      const timer = setTimeout(() => finish('deny', 'timeout'), this.timeoutMs);
      // unref：测试/纯 Node 环境下不阻止进程退出
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(approvalId, { finish, timer, runId: runId || null });
    });
    Object.defineProperty(promise, 'reason', {
      get: () => reasonBox.value,
      enumerable: false,
      configurable: true,
    });
    return promise;
  }

  // 按 id 精确分发决策。返回是否成功分发（未知/已超时 id → false）
  // V12（2026-10-16）：决策枚举校验——只接受 once/conversation/always/deny，
  // 非法值（含被篡改的任意字符串/对象）一律按 deny 收尾，杜绝未知决策值沿审批链扩散。
  // P1-4（2026-10-17）：第三参 reason——用户可选提交的决策理由，随决议回传
  // （经 wait() 返回 Promise 的 reason 属性暴露给拒绝点）。
  dispatch(approvalId, decision, reason) {
    const entry = (approvalId != null) ? this.pending.get(approvalId) : null;
    if (!entry) return false;
    entry.finish(normalizeDecision(decision), 'decided', reason);
    return true;
  }

  // 旧渲染层兼容通道（deprecated）。
  // P2-3（2026-10-17）：原实现接受「无 id 的裸 decision」并在恰有一个挂起时猜测分发——
  // 这正是 P0-2 事故类缺陷（无标识响应可能落到错误的审批上；并发时拒绝猜测虽 fail-closed，
  // 但通道本身给了「不带 id 也能应答」的错觉）。现保留方法名以兼容既有调用方，
  // 但**强制要求 approvalId**：无 id 的响应一律拒绝 + console.warn 告警，
  // 行为与 dispatch(approvalId, decision) 完全一致。调用方应改用 dispatch。
  dispatchLegacy(approvalId, decision) {
    if (approvalId == null) {
      console.warn('[approval] dispatchLegacy 收到无标识（无 approvalId）的审批响应，已拒绝（P2-3：无 id 响应不得猜测分发，请改用 dispatch(approvalId, decision)）');
      return false;
    }
    return this.dispatch(approvalId, decision);
  }

  // 挂起数量（诊断/UI 展示用）
  get size() { return this.pending.size; }

  // 退出/重置：全部按 deny 收尾，清理定时器
  disposeAll() {
    for (const [, entry] of this.pending) {
      try { entry.finish('deny', 'disposed'); } catch { /* 已收尾的忽略 */ }
    }
    this.pending.clear();
  }

  // N5：运行取消时撤下该 run 的全部挂起审批（rootExecution 统一取消之「撤审批」）。
  // 全部按 deny 收尾（运行已不在，审批卡继续挂着只会让用户对着已终止的运行做决策）；
  // onSettle 回调照常触发，渲染层撤卡。返回撤下的数量。
  cancelByRun(runId) {
    if (!runId) return 0;
    let n = 0;
    for (const [, entry] of this.pending) {
      if (entry.runId !== runId) continue;
      try { entry.finish('deny', 'run-cancelled'); n += 1; } catch { /* 已收尾的忽略 */ }
    }
    return n;
  }
}

// ═══════════════════════════════════════════
// 差集 A：Diff 行内评论 → Agent 继续（协作回路，方案文档 §4.2 最高优先核心差集）
//
// 回路：用户在 diff 的 hunk 上留评论 → IPC diff:comment → 主进程按线程存储 →
//       包装成一条 user 消息回灌模型 → 渲染层经既有「发消息触发运行」通路触发下一轮。
// 与 P1-4（审批拒绝理由）共用同一套「用户反馈 → 结构化 → 回灌模型」的通道。
//
// 关键约束（方案文档 §4.2）：回灌消息必须带上「被评论的变更本身」（diffSnippet），
// 否则模型只看到评论、看不到自己做过什么，只会泛泛答复。
//
// 存储：优先复用 localStore 的线程数据结构——评论以 t.diffComments 数组挂在
// localStore 的 thread 对象上，随 local-data.json 持久化（不新建持久化系统）；
// 未注入 localStore（单测 / 降级）时退化为进程内 Map。
// ═══════════════════════════════════════════

const DIFF_COMMENT_LIMITS = { comment: 2000, snippet: 4000 };

// 行范围归一：{ start, end } 或 null（缺省/非法不阻断评论，只丢定位信息）
function normalizeLineRange(lineRange) {
  if (!lineRange || typeof lineRange !== 'object') return null;
  const start = Number(lineRange.start);
  const end = Number(lineRange.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 1 || end < start) return null;
  return { start, end };
}

// 入参归一：返回 null 表示载荷不合法（缺评论内容/线程/文件路径）
function normalizeDiffComment(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const comment = String(payload.comment ?? '').trim();
  if (!comment) return null;
  const threadId = payload.threadId;
  if (threadId == null || threadId === '') return null;
  const filePath = String(payload.filePath ?? '').trim();
  if (!filePath) return null;
  const hunkIndex = Number.isFinite(Number(payload.hunkIndex)) ? Number(payload.hunkIndex) : 0;
  return {
    id: `dc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    threadId: String(threadId),
    filePath,
    hunkIndex,
    lineRange: normalizeLineRange(payload.lineRange),
    comment: comment.slice(0, DIFF_COMMENT_LIMITS.comment),
    diffSnippet: String(payload.diffSnippet ?? '').slice(0, DIFF_COMMENT_LIMITS.snippet),
    createdAt: Date.now(),
  };
}

// 回灌消息构造（纯函数，单测覆盖）：评论 → { role:'user', content }。
// content 带上被评论的变更本身——模型必须同时看到「评论」与「自己做过什么」。
function buildDiffFeedbackMessage(comment) {
  const where = comment.lineRange
    ? `${comment.filePath}（第 ${comment.lineRange.start}-${comment.lineRange.end} 行）`
    : comment.filePath;
  const parts = [
    '[用户对以下变更的反馈]',
    `文件：${where}`,
    `用户评论：${comment.comment}`,
  ];
  const snippet = String(comment.diffSnippet || '').trim();
  if (snippet) {
    parts.push('', '被评论的变更（Agent 此前的改动）：', snippet);
  }
  parts.push('', '请据此修改，不要重复被拒绝的做法。');
  return { role: 'user', content: parts.join('\n') };
}

const diffCommentState = {
  getLocalStore: null,          // 由 initDiffCommentChannel 注入（main.js：getLocalStore: () => localStore）
  memory: new Map(),            // threadId -> comment[]（未注入 localStore 时的降级存储）
};

function initDiffCommentChannel({ getLocalStore } = {}) {
  diffCommentState.getLocalStore = typeof getLocalStore === 'function' ? getLocalStore : null;
}

// 存储一条评论：优先挂到 localStore 的线程对象（随 local-data.json 持久化）；
// 线程不在 localStore（服务端模式等）或访问失败时退化为进程内 Map，绝不丢评论。
function recordDiffComment(comment) {
  const store = diffCommentState.getLocalStore?.();
  if (store) {
    try {
      const t = (store.data?.threads || []).find((x) => String(x.id) === comment.threadId);
      if (t) {
        if (!Array.isArray(t.diffComments)) t.diffComments = [];
        t.diffComments.push(comment);
        const r = store.flush();
        if (!r?.ok) {
          console.warn('[diffComment] 评论写入 localStore 未落盘（内存已保留，下次 flush 重试）：', r?.error);
        }
        return { ok: true, comment };
      }
      console.warn(`[diffComment] 线程 ${comment.threadId} 不在 localStore，评论改存进程内`);
    } catch (e) {
      console.warn('[diffComment] localStore 访问失败，评论改存进程内:', e.message);
    }
  }
  const list = diffCommentState.memory.get(comment.threadId) || [];
  list.push(comment);
  diffCommentState.memory.set(comment.threadId, list);
  return { ok: true, comment };
}

// 按线程列出评论（localStore 优先，降级存储兜底）
function listDiffComments(threadId) {
  const key = String(threadId);
  const store = diffCommentState.getLocalStore?.();
  if (store) {
    try {
      const t = (store.data?.threads || []).find((x) => String(x.id) === key);
      if (t && Array.isArray(t.diffComments)) return [...t.diffComments];
    } catch (e) {
      console.warn('[diffComment] localStore 读取失败，回落进程内存储:', e.message);
    }
  }
  return [...(diffCommentState.memory.get(key) || [])];
}

// diff:comment IPC 处理器（具名导出供单测：normalize → store → 回灌消息全链路，
// 绕开 electron 依赖）。生产环境由下方 ipcMain.handle 注册调用。
async function handleDiffComment(payload) {
  const comment = normalizeDiffComment(payload);
  if (!comment) return { ok: false, error: '评论载荷不完整（需要 threadId / filePath / comment）' };
  const stored = recordDiffComment(comment);
  // 回灌消息由主进程构造并随响应返回——渲染层拿到的就是可直接入队的 user 消息，
  // 包装格式单一事实来源在此（含「被评论的变更」）。
  return { ok: true, comment: stored.comment, feedback: buildDiffFeedbackMessage(stored.comment) };
}

// diff:comment IPC 自注册。生产环境（Electron 主进程加载本模块时）ipcMain 可用；
// 单测 / 纯 Node 环境下 require('electron') 不暴露 ipcMain，跳过注册——
// 存储与消息构造逻辑经导出函数直接单测，不依赖 IPC 层。
let diffIpcMain = null;
try {
  const electron = require('electron');
  if (electron && electron.ipcMain && typeof electron.ipcMain.handle === 'function') {
    diffIpcMain = electron.ipcMain;
  }
} catch (e) {
  console.warn('[approvalChannel] electron 不可用，diff:comment IPC 未注册（单测环境可忽略）:', e.message);
}

if (diffIpcMain) {
  diffIpcMain.handle('diff:comment', (_, payload) => handleDiffComment(payload));
}

module.exports = {
  ApprovalChannel,
  // P1-4
  normalizeReason, denialText, approvalReasonOf,
  // 差集 A
  initDiffCommentChannel, normalizeDiffComment, normalizeLineRange,
  buildDiffFeedbackMessage, recordDiffComment, listDiffComments, handleDiffComment,
};
