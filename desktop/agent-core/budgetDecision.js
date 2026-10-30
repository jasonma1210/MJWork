// 上下文 / token 预算的闸门判定（纯函数 + 它自己的阈值常量）。
//
// 为什么单独成文件（2026-10-30）：`agent-core/index.js` 已到 code 行 2967 的棘轮基线
// （`test/max-lines.test.js` 的 BASELINE_800，只减不增）。本轮要把「预算窗口耗尽 → 续期」
// 这个真实行为变更写进去，只能把成块的判据连同阈值一起搬出来，而不是给自己开基线。
// 搬出的是**判据**（纯函数，无副作用、不依赖运行态），留在 index.js 的是**执行动作**
// （压缩 / 换窗口 / 挂起都要改运行态，属于主循环的职责）。这条边界也让本文件可以被单测直调。
//
// 与 index.js 的关系：index.js 从这里 import 并原样 re-export，外部
// `import { budgetDecision } from '../agent-core/index.js'` 的既有调用方（含测试）零改动。

// 预判式触发比例（复盘文档 P1-2 采纳）：上下文达模型窗口 70% 即压缩。
// 2026-10-17 语义修正：这个比例**只作用于上下文体积**，不再作用于「累计花费」——
// 拿花费判「上下文过长」会导致小上下文被强制压缩（详见下方 budgetDecision 注释）。
export const TOKEN_COMPACTION_TRIGGER = 0.7;

// 预算压力下「值不值得压」的下限：上下文至少占窗口 35% 才压——
// 压缩省下的是「每轮重发量」，27k 的上下文压成摘要会把模型还需要的内容抹掉。
export const TOKEN_COMPACT_MIN_RATIO = 0.35;

// 单任务**总** token 硬上限（真实 usage 累计口径）——防失控的最后一道线。
// 存在的理由：预算窗口耗尽不再挂起（改为续期，见 budgetDecision 的 'renew'），
// 于是必须另有一道不可越过的总量线，否则一个跑飞的任务能烧掉整月额度。
// 20M ≈ 1M 窗口模型连跑 20 个满窗口，正常任务碰不到；真撞上说明任务本身该拆。
export const TASK_TOTAL_TOKEN_CAP = 20_000_000;

// 上下文窗口兜底单点（P0-1⑤）。
//
// 为什么是 4096 而不是 128000：
//   · Ollama 的上下文窗口**不是固定值**——`OLLAMA_CONTEXT_LENGTH` 代码默认 0 = 未指定，
//     运行时按显存自适应 4k/32k/256k（一手：ollama/envconfig/config.go）。禁止在此写死任何档位；
//     真实值必须由宿主探测后经 model.model.context_window 下发。
//   · 两侧错配的代价极不对称：**高估 = 击穿**（prompt 超窗 → provider 400，且压缩阈值永不触发，
//     上下文一路涨到服务端拒绝）；**低估 = 浪费**（早压掉细节，可恢复）。
//     因此「宿主没下发」时只能取最小安全档 4096，绝不能取 128000。
export const DEFAULT_CONTEXT_WINDOW_FALLBACK = 4096;

// 闸门判定（纯函数，单测直调）。
//
// 2026-10-17 事故与修正：用户跑「取 10 条最新新闻」，5 轮累计 143k（每轮重发 ~27k 上下文），
// 旧逻辑拿累计花费判「上下文过长」，把 27k 上下文 force 压成 376 tokens 摘要 → 新闻原文被抹掉
// → 模型只能重搜 → 再撞闸再压，表现为「后台一直在压缩、还没有任何输出」。
//
// 修正原则（不删救援机制，只改判据）：
//   · 上下文真的接近窗口上限 → 压缩（这是压缩唯一能解决的问题）；
//   · 预算压力 + 上下文够大（≥ 窗口 35%，压缩确实能省下可观重发成本）→ 压缩；
//   · 预算压力 + 上下文很小 → **只开新预算窗口、不压缩**（小上下文压缩纯亏）；
//   · 救援用尽 + 预算窗口耗尽 → **续期**（'renew'），不是停任务；
//   · 救援用尽 + 窗口用尽 + 上下文压不动 → 挂起（'suspend-context'，断点续跑）；
//   · 累计消耗撞到 TASK_TOTAL_TOKEN_CAP → 挂起（'suspend-tokens'，真终点）。
//
// 2026-10-30 关键语义变更：'suspend-tokens' 原本代表「窗口级预算耗尽」，用户必须手发
// 「继续」才能接着跑。实测长途任务（审查/批量重构）必然多次撞窗口级预算，因为每轮都要
// 重发上下文——把它当任务终点等于把任务废在半路。现在窗口级预算只是**成本节流阀**：
// 耗尽就 'renew' 续期，任务终点只留给总上限。
export function budgetDecision({
  // ⚠️ 窗口校准**只能在这里的上游做一次**（runAgent 已用 effectiveWindowOf 反推并按 4× 封顶）。
  // 本函数内绝不能再对 ctxWindow 二次反推：已抬高的窗口配同一个 lastPromptTokens 会再算一遍，
  // 4× 封顶被绕过（实测 declared=32768/seen=200000 → 上游 131072 → 这里 285715 ≈ 8.7×），
  // 压力闸从此永久失敏，最终以 400 硬失败代替挂起。
  // lastPromptTokens 仍接收但**不参与判定**，仅为兼容既有调用方与测试签名。
  ctxEst = 0, ctxWindow = DEFAULT_CONTEXT_WINDOW_FALLBACK, lastPromptTokens = null,
  spent = 0, budget = 0, rescues = 0, rescueMax = 3, totalSpent = 0, totalCap = 0,
} = {}) {
  void lastPromptTokens; // 见上：保留参数只为签名兼容，禁止用于二次反推
  const win = ctxWindow;
  const ctxHot = win > 0 && ctxEst > win * TOKEN_COMPACTION_TRIGGER;
  if (ctxHot) return rescues < rescueMax ? 'compact' : 'suspend-context';
  if (budget > 0 && spent > budget * TOKEN_COMPACTION_TRIGGER) {
    if (rescues >= rescueMax) {
      if (spent <= budget) return 'ok';
      // 窗口级预算耗尽：只有撞到总上限才真停，否则续期。
      return totalCap > 0 && totalSpent >= totalCap ? 'suspend-tokens' : 'renew';
    }
    // 上下文够大才值得压缩（压缩省下的是「每轮重发量」）
    return ctxEst >= win * TOKEN_COMPACT_MIN_RATIO ? 'compact' : 'new-window';
  }
  return 'ok';
}
