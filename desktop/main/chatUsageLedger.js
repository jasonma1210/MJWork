// 单人对话的用量账本回填（2026-10-28 从 agentRunner.finishRun 抽出）
//
// 背景：工作台「用量流水」读的是 quota_consumptions 台账，而这条台账此前只由配额闸门
// （quotaGate，团队派单经 workerPool → core.runAgent）写入，普通单人对账完全没有落账记录，
// 于是用户跑完一轮对话在流水页什么也看不到。
//
// 三条口径（改动前请先读）：
//  1. source 固定 'chat'、task_id 为 NULL —— quotaLedger 的 usedInWindow / memberUsed /
//     ledgerByMember 都显式排除 source='chat'，所以入账**不会**吃掉团队派单的额度。
//  2. 取消的运行也要入账：引擎无论成功还是中断都会带着累计 usage 调 onDone，
//     用户明确反馈「我取消了，但用量没出来」，所以不做 aborted 过滤。
//  3. **（2026-10-31 修正）反查不到项目也要入账**，记到 UNBOUND_PROJECT_ID 哨兵下。
//     此前的口径是「拿不到项目就跳过」，理由是「没有归属的消耗进不了任何项目视图」。
//     真机实测证明这条理由不成立：普通对话本来就不属于任何项目空间，于是它把**绝大多数**
//     真实消耗都丢掉了（本机 9 天 36 个会话，chat 记录 0 条），而首页那页叫「用量流水」——
//     用户看到的是「我明明一直在用，账本里什么都没有」。忽略一次消耗比挂错一个项目更糟：
//     前者是账本说谎，后者只是分类不精确（且哨兵在项目维度上可见、可筛）。
//
// 失败一律吞掉只打 warn：收尾链路里抛错会让 done 事件发不出去，客户端卡在 loading。
const { UNBOUND_PROJECT_ID } = require('./quotaLedger');

function recordChatUsage(deps, ctx) {
  try {
    if (typeof deps?.recordUsage !== 'function' || !ctx?.usage) return;
    // 两种形状都要吃：onDone 给的是 API 原生 usage（snake_case），agentRunner.lastBudgetState
    // 是 onBudget 快照（camelCase promptTokens/completionTokens）。失败分支只有后者——只认
    // snake_case 会让「超时/报错的运行」一条账都不入，用户看到的仍是「取消有量、失败无量」。
    const tokens = (ctx.usage.prompt_tokens ?? ctx.usage.promptTokens ?? 0)
      + (ctx.usage.completion_tokens ?? ctx.usage.completionTokens ?? 0);
    if (!(tokens > 0)) return;
    const resolved = typeof deps.resolveProjectOfConversation === 'function'
      ? deps.resolveProjectOfConversation(ctx.conversationId, ctx.projectPath)
      : null;
    deps.recordUsage({
      projectId: resolved || UNBOUND_PROJECT_ID, runId: ctx.runId, tokens, modelName: ctx.modelId || '',
    });
  } catch (e) {
    console.warn('[agentRun] 用量账本回填失败（不阻断收尾）:', e?.message || e);
  }
}

module.exports = { recordChatUsage };
