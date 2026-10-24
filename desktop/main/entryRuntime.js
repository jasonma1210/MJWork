// 判定点的**宿主接线**（设计文档 §14 P1-4）——把 entryRouter 的纯判定接到真实运行链路上。
//
// 职责边界：
//   · entryRouter.js 是**纯逻辑**（可单测、无 electron 依赖）；本模块是它的宿主外壳，
//     负责「取目标 → 调判定 → 产出 UI 事件 → 记住用户答复」。
//   · **绝不建组**：判定结果只做「提示 + 预拆子任务 + 预置编制的可见化」，
//     建组仍只有既有两条路径（orchestrate_task 模型自决 / teams:dispatch 用户派活）。
//   · **不阻塞主链路**：判定异步进行（fire-and-forget），失败/超时一律回落普通对话，
//     用户不感知到系统故障（追问用户等于把系统故障转嫁给用户）。
//
// ⚠️ UI 提示一律走 UI 事件，**不进 system 段**：system 段是前缀稳定区，
//    加内容会让每轮重写前缀（prompt cache 命中率掉到 0）。
'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const router = require('./entryRouter');

// 事件名（渲染层联调契约的唯一定义处）：
//   entry:route   —— 路由判定结果 + 升级/降级提示 + 成本倍数
//   entry:confirm —— C1 确认卡（含**已拆好**的子任务清单）
const ROUTE_EVENT = 'entry:route';
const CONFIRM_EVENT = 'entry:confirm';

let deps = { chatOnce: null, resolveModel: null };

/** 取本轮目标文本：最后一条 user 消息（判定器的输入只有「用户这轮要干什么」）。 */
function goalOf(payload) {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user') return String(m.content || '').trim();
  }
  return '';
}

/** 广播到所有窗口（与 teams:event 同款：窗口可能已销毁，逐个 try）。 */
function broadcast(channel, payload) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch { /* 窗口已销毁：提示发不出去不影响执行 */ }
}

/** 判定结果 → 路由事件载荷（渲染层按这个形状渲染提示条）。 */
function buildRouteEvent(verdict, confirm, extra = {}) {
  const signals = verdict.signals || {};
  return {
    type: confirm.tier === 'C2' ? 'guide' : (confirm.notice ? confirm.notice.type : 'route_verdict'),
    conversationId: extra.conversationId || null,
    route: verdict.route,
    decidedByRule: verdict.decidedByRule === true,
    source: verdict.source,
    confidence: Number(verdict.confidence) || 0,
    reason: verdict.reason || '',
    tier: confirm.tier,
    ask: confirm.ask === true,
    blocked: confirm.blocked === true,
    reasonSource: confirm.reasonSource || '',
    signals: {
      parallelizable: signals.parallelizable === true,
      sequential: signals.sequential === true,
      toolKinds: Number(signals.toolKinds) || 0,
      needsCentralizedVerify: signals.needsCentralizedVerify === true,
      estimatedSize: Number(signals.estimatedSize) || 1,
    },
    notice: confirm.notice || null,
    cost: confirm.card ? {
      teamSize: confirm.card.teamSize,
      tokenMultiple: confirm.card.tokenMultiple,
      estimatedWallClockMs: confirm.card.estimatedWallClockMs,
    } : null,
    team: extra.team || null,
    ts: Date.now(),
  };
}

/** C1 确认卡 → 确认事件载荷（子任务必须是**已拆好**的清单）。 */
function buildConfirmEvent(verdict, confirm, extra = {}) {
  if (!confirm.card) return null;
  return {
    type: 'confirm_card',
    conversationId: extra.conversationId || null,
    goal: extra.goal || '',
    route: verdict.route,
    card: {
      title: confirm.card.title,
      reason: confirm.card.reason,
      reasonSource: confirm.card.reasonSource,
      subtasks: confirm.card.subtasks || [],
      subtasksReady: confirm.card.subtasksReady === true,
      subtaskError: confirm.card.subtaskError || null,
      signals: confirm.card.signals || null,
      conservative: confirm.card.conservative === true,
      conservativeHint: confirm.card.conservativeHint || '',
      cost: {
        teamSize: confirm.card.teamSize,
        tokenMultiple: confirm.card.tokenMultiple,
        estimatedWallClockMs: confirm.card.estimatedWallClockMs,
      },
      actions: confirm.card.actions || ['confirm', 'single', 'detail'],
    },
    ts: Date.now(),
  };
}

/**
 * 判定并广播（**不抛异常、不阻塞**）。
 * @param {object} args { payload, conversationId }
 * @returns {Promise<object|null>} 判定结果（供调用方排障）
 */
async function judgeEntry(args = {}) {
  const payload = args.payload || {};
  const conversationId = args.conversationId || payload.conversationId || null;
  const goal = goalOf(payload);
  if (!goal) return null;
  try {
    // 用户已答复过本目标 ⇒ 本轮不升级、不重复追问（纪律②）
    if (router.hasAnswered(conversationId, goal)) {
      broadcast(ROUTE_EVENT, {
        type: 'downgrade', conversationId, route: 'simple_chat', decidedByRule: true,
        source: 'user', confidence: 0, reason: '你已选择按单 Agent 执行，本轮不再询问。',
        tier: 'C0', ask: false, blocked: false, reasonSource: 'user-choice',
        signals: { parallelizable: false, sequential: false, toolKinds: 0, needsCentralizedVerify: false, estimatedSize: 1 },
        notice: { type: 'downgrade', route: 'simple_chat', teamSize: 1, tokenMultiple: 1 },
        cost: null, team: null, ts: Date.now(),
      });
      return null;
    }
    const verdict = await router.judgeRoute({
      goal,
      userPickedTeam: !!(payload.teamId || payload.candidateTeamId),
      teamId: payload.teamId || payload.candidateTeamId || null,
      chatOnly: payload.chatOnly === true,
      unattended: false,
    }, {
      chatOnce: deps.chatOnce,
      resolveModel: deps.resolveModel,
      policy: deps.policy,
    });
    const confirm = await router.buildConfirmPoint(verdict, {
      userPickedTeam: !!(payload.teamId || payload.candidateTeamId),
      autoUpgrade: payload.autoUpgrade === true,
      goal,
    }, {
      chatOnce: deps.chatOnce,
      resolveModel: deps.resolveModel,
      policy: deps.policy,
    });
    const extra = {
      conversationId,
      goal,
      team: payload.teamId ? { id: payload.teamId, name: payload.teamName || null } : null,
    };
    broadcast(ROUTE_EVENT, buildRouteEvent(verdict, confirm, extra));
    const cardEvent = buildConfirmEvent(verdict, confirm, extra);
    if (cardEvent) broadcast(CONFIRM_EVENT, cardEvent);
    return { verdict, confirm };
  } catch (e) {
    // fail-open：判定出问题不该让用户的消息发不出去，也不该把系统故障摆到界面上
    console.warn('[entryRuntime] 判定失败（已回落普通对话）:', e && e.message);
    return null;
  }
}

/** 惰性注册 IPC（只注册一次；不单独占宿主的一行装配代码）。 */
let ipcReady = false;
function ensureIpc() {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle('entry:choice', async (_, payload = {}) => {
    // 用户对确认卡的答复：'single' = 改成单 Agent（本轮不升级）；'confirm' = 按团队执行
    const ok = router.noteUserChoice(payload.conversationId, payload.goal, payload.choice);
    return { ok: ok !== false };
  });
  ipcMain.handle('entry:policy', async () => ({ ok: true, policy: router.loadPolicy() }));
}

/**
 * `agent:run` 的**单行接线**：判定（fire-and-forget，绝不阻塞主链路）+ 启动本次运行。
 * 为什么合成一个函数：main.js 已顶 1500 行 code 硬档，接线必须只占一行。
 *
 * @param {object} payload agent:run 载荷
 * @param {object} sender Electron sender
 * @param {object} d { chatOnce, resolveModel, policy }
 * @param {Function} start 启动函数（main.js 传 agentRunner.startAgentRunWhenReady）
 */
function judgeAndStart(payload, sender, d = {}, start) {
  deps = { ...deps, ...d };
  try { ensureIpc(); } catch { /* 重复注册不阻断运行 */ }
  judgeEntry({ payload, conversationId: payload && payload.conversationId }).catch(() => {});
  return start(payload, sender);
}

module.exports = {
  judgeEntry, judgeAndStart, goalOf, buildRouteEvent, buildConfirmEvent,
  ROUTE_EVENT, CONFIRM_EVENT,
};
