// P0-5（2026-10-22）：审批归属解析——runId → 发起它的会话。
//
// 为什么单独一个文件：main.js 的 code 行数顶在 eslint max-lines 的 1500 硬档上
// （门禁口径只减不增），新增逻辑必须落在独立模块里，否则一改就红。
//
// 事故背景：审批载荷此前只有 tool/cwd。本产品支持「切走后台继续跑」，
// 于是后台会话弹出的审批卡与当前会话长得一模一样——用户可能顺手批掉另一个任务的命令，
// 而渲染层还把 awaiting_approval 写到当前正在看的会话上（亮错徽标，真正在等的会话不亮）。
//
// 取不到归属（无人值守 Worker / 定时任务 / 测试注入）时返回空对象：载荷不带这两个键，
// 渲染层按「无归属」处理（不写任何会话状态），老 UI 行为不变。
function createApprovalOriginResolver({ getAgentRunner, getLocalStore }) {
  return function resolveApprovalOrigin(runId) {
    if (!runId) return {};
    try {
      const threadId = getAgentRunner()?.getConversationIdFor?.(runId);
      if (!threadId) return {};
      let title = '';
      try {
        const list = getLocalStore()?.listThreads?.() || [];
        title = list.find((x) => String(x.id) === String(threadId))?.title || '';
      } catch { /* 标题只用于展示，取不到不影响归属 */ }
      return { threadId: String(threadId), ...(title ? { threadTitle: String(title).slice(0, 60) } : {}) };
    } catch (e) {
      console.warn('[approval] 审批归属解析失败（按无归属处理）:', e?.message || e);
      return {};
    }
  };
}

module.exports = { createApprovalOriginResolver };
