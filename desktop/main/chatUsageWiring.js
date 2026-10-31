// 对话运行的用量账本接线（2026-10-28 从 main.js 抽出）
//
// 为什么单独一个文件：main.js 的 code 行数（eslint skipBlankLines+skipComments 口径）
// 恰好压在 1500 的硬档上（test/max-lines.test.js 第 3 条断言会红），任何新增都必须外置。
//
// 两个依赖都通过 getter 延迟求值（而不是直接传对象）：quotaLedger / projectStore 是
// main.js 里的模块级 let，initAgentRunner 装配时可能尚未初始化，闭包取值才能与装配顺序解耦。
//
// 口径（改动前必读）：
//  · source 固定 'chat'、task_id 为 NULL —— quotaLedger 的 usedInWindow / memberUsed 都按
//    source 过滤，所以这里入账**不会**吃掉团队派单的额度，只服务于「用量流水」展示。
//  · 取消的运行也要入账：引擎无论成功还是中断都会带累计 usage 调 onDone，用户实测反馈
//    「我取消了，但用量没出来」，因此不做 aborted 过滤。
//  · **（2026-10-31 修正）不再要求 projectId 非空**：无归属的对话由 chatUsageLedger 传
//    哨兵 UNBOUND_PROJECT_ID 下来。此前的 `if (!projectId) return 0` 是「账本一片空白」的
//    另一半原因——两层各自都判一次「没有项目就不记」，任一层保留都足以把账记没。
//  · 异常一律吞掉只打 warn：这段跑在收尾链路里，抛错会让 done 事件发不出去、客户端卡 loading。
function makeChatUsageDeps(getQuotaLedger, getProjectStore) {
  return {
    recordUsage: ({ projectId, runId, tokens, modelName } = {}) => {
      try {
        const ledger = getQuotaLedger();
        if (!ledger || !(tokens > 0)) return 0;
        // projectId 由上层保证已归一（要么真项目，要么哨兵）。仍显式判空：空归属写进去
        // 会被 quotaLedger._insert 静默拒绝（return 0），那样失败就是无声的。
        if (!projectId) return 0;
        // modelName 必须透传：此前这里只解构三个字段，账本行的 model 恒为空 ⇒
        // 「哪个模型烧掉多少」在流水页永远显示「未记录」（只能靠扫消息表反推）。
        return ledger.recordChat({ projectId, runId, memberId: null, tokens, model: String(modelName || '').trim() });
      } catch (e) {
        console.warn('[usage] 写入用量账本失败（不影响运行）:', e?.message || e);
        return 0;
      }
    },
    resolveProjectOfConversation: (threadId, projectPath) => {
      const store = getProjectStore();
      return store ? store.resolveProjectId(threadId, projectPath) : null;
    },
  };
}

module.exports = { makeChatUsageDeps };
