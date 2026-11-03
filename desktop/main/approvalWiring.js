// 审批接线（2026-11-03 从 main.js 外置）：发起审批 / 接回决策 / 批量决议 三件事的唯一落点。
//
// 为什么外置：main.js 在 code 行天花板上（BASELINE_800 快照必须等于实测，只减不增），
// 而「批量审批」需要新增一条 IPC。按仓库既有纪律先拆再合入（同 cuaHandlers / approvalOrigin
// 的做法），不靠放宽棘轮腾位置。
//
// 依赖全部注入，模块本身不持有宿主状态：
//   · getMainWindow：窗口随时可能重建，必须现取；销毁后不得裸解引用（IPC rejection 会把
//     工具循环打进不可诊断态）。
//   · getRunId：AsyncLocalStorage 上下文由 agentRunner 的 handler 包装注入，运行取消时
//     按 runId 统一撤审批（cancelApprovalsForRun）。
//   · broadcastEnd：审批**无论以何种方式结束**（决策/超时/进程退出）都要通知渲染层撤卡，
//     否则卡片常驻、用户事后点击只能命中「无法匹配的审批响应」。
const { ipcMain } = require('electron');

/**
 * @param {object} deps
 * @param {object} deps.approval  main/approval.js（摘要 / 分级 / 可记忆判定）
 * @param {object} deps.approvalChannel main/approvalChannel.js 的实例
 * @param {() => any} deps.getMainWindow
 * @param {() => string|null} deps.getRunId 当前运行的 runId（无则 null）
 * @param {(runId: string|null) => object} deps.resolveOrigin 审批归属（会话 id / 标题）
 * @param {(approvalId: string, reason: string) => void} deps.broadcastEnd
 * @returns {{ requestApproval: (tool: string, args: object) => Promise<string> }}
 */
function initApprovalWiring({ approval, approvalChannel, getMainWindow, getRunId, resolveOrigin, broadcastEnd }) {
  // 向渲染层发起审批，返回 'once' | 'conversation' | 'always' | 'deny'
  // P0-2：审批响应按 approvalId 精确分发（并发时决策不能张冠李戴）。
  function requestApproval(tool, args) {
    const summary = approval.approvalSummary(tool, args);
    const approvalId = approvalChannel.nextId();
    // N5：审批挂到发起它的运行，运行取消时统一撤下。
    // P2（2026-11-03）：第 4 参 meta 只供**批量决议**判定用（工具 / 分级 / 可记忆）。
    // 分级由本进程现算（approval.toolLevel 是唯一判据），绝不让渲染层自己复制一份——
    // 一旦两处判据分叉，就会出现「UI 认为可批量、主进程认为 L1」的安全缺口。
    const waitP = approvalChannel.wait(approvalId, broadcastEnd, getRunId(), {
      tool,
      level: approval.toolLevel(tool, args),
      rememberable: approval.isRememberable(tool),
    });
    // P0-5：无可用窗口（启动早期 / 窗口已销毁）无法征求用户 → fail-closed 按 deny 收尾。
    const win = getMainWindow();
    const usable = win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) ? win : null;
    if (!usable) {
      console.warn(`[approval] 无可用窗口，审批按 deny 收尾（tool=${tool}）`);
      approvalChannel.dispatch(approvalId, 'deny');
      return waitP;
    }
    // V21：审批卡需显示请求来源的工作根——cwd 随摘要下发（无 cwd 时不带该字段）
    // P0-5：同时带上发起会话的归属（threadId/threadTitle），供审批卡标注「来自哪个会话」，
    // 并让渲染层把 awaiting_approval 写到**那个**会话而不是当前正在看的会话。
    usable.webContents.send('tool:approval-request', {
      approvalId, tool, rememberable: approval.isRememberable(tool),
      ...(args?.cwd ? { cwd: args.cwd } : {}), ...summary,
      ...resolveOrigin(getRunId()),
    });
    return waitP;
  }

  // 全局唯一监听器：按 approvalId 分发（替代原先每次请求注册一次的 ipcMain.once）
  ipcMain.on('tool:approval-response', (_, payload) => {
    const hasId = payload && typeof payload === 'object';
    const approvalId = hasId ? payload.approvalId : null;
    const decision = hasId ? payload.decision : payload;
    // P1-4：用户可选的决策理由随决议回传（无理由时行为不变）
    const reason = hasId ? payload.reason : undefined;
    const dispatched = approvalId != null
      ? approvalChannel.dispatch(approvalId, decision, reason)
      : approvalChannel.dispatchLegacy(approvalId, decision); // P2-3：无 id 响应一律拒绝并告警
    if (!dispatched) console.warn('[approval] 收到无法匹配的审批响应，已忽略（防串扰）');
  });

  // P2（2026-11-03）：批量决议。渲染层只传 id 列表与决策，**不做任何过滤**——
  // 「哪些能批量」的判据在 approvalChannel.resolveBatch 里（L1 恒逐条、跨工具不批、
  // 不可记忆工具不接受 conversation/always）。UI 侧只负责展示「同类 N 项」。
  // 返回结构带 applied / skipped：部分成功必须让 UI 说得清「批了几条、还剩几条要你看」。
  ipcMain.handle('tool:approval-batch', (_, payload = {}) => {
    const res = approvalChannel.resolveBatch({
      approvalIds: Array.isArray(payload?.approvalIds) ? payload.approvalIds : [],
      decision: payload?.decision,
      reason: payload?.reason,
    });
    if (!res.ok) {
      console.warn(`[approval] 批量决议未生效 code=${res.code || '-'} skipped=${JSON.stringify(res.skipped).slice(0, 300)}`);
    }
    return res;
  });

  return { requestApproval };
}

module.exports = { initApprovalWiring };
