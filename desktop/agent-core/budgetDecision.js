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
//   · 救援用尽 + 上下文仍超窗口 → **交回主循环**（'reclaim-context'）：先试硬截断，
//     再试「带台账换新窗口续跑」，两次都不行才挂起——本函数**不宣布结束**；
//   · 累计消耗撞到 TASK_TOTAL_TOKEN_CAP → 挂起（'suspend-tokens'，唯一真终点）。
//
// 2026-10-30 关键语义变更：'suspend-tokens' 原本代表「窗口级预算耗尽」，用户必须手发
// 「继续」才能接着跑。实测长途任务（审查/批量重构）必然多次撞窗口级预算，因为每轮都要
// 重发上下文——把它当任务终点等于把任务废在半路。现在窗口级预算只是**成本节流阀**：
// 耗尽就 'renew' 续期，任务终点只留给总上限。
//
// 2026-10-30 第二次修正（用户实测原文「累计 184145 tokens 已达防失控总上限」）：
//   旧返回值 'suspend-context' 让主循环直接 break，**跳过**了压缩/硬截断/换窗口三阶梯，
//   于是「本可自愈的上下文压力」被当成了任务终点，还被文案说成总上限。现改为
//   'reclaim-context'：判定层只表达「该升到哪一档救援」，停不停由主循环的阶梯决定。
export function budgetDecision({
  // ⚠️ 窗口校准**只能在这里的上游做一次**（runAgent 已用 effectiveWindowOf 反推并按 4× 封顶）。
  // 本函数内绝不能再对 ctxWindow 二次反推：已抬高的窗口配同一个 lastPromptTokens 会再算一遍，
  // 4× 封顶被绕过（实测 declared=32768/seen=200000 → 上游 131072 → 这里 285715 ≈ 8.7×），
  // 压力闸从此永久失敏，最终以 400 硬失败代替挂起。
  // lastPromptTokens 仍接收但**不参与判定**，仅为兼容既有调用方与测试签名。
  ctxEst = 0, ctxWindow = DEFAULT_CONTEXT_WINDOW_FALLBACK, lastPromptTokens = null,
  spent = 0, budget = 0, contextRescues = 0, rescueMax = 3, windowRenews = 0, totalSpent = 0, totalCap = 0,
  // 旧签名兼容：`rescues` 此前同时被「压缩救援」与「预算续期」消耗，是本文件 2026-10-30 修掉的
  // 记账缺陷（续期吃掉上下文额度 ⇒ 之后一轮上下文过 70% 立刻硬停）。新调用方请用 contextRescues。
  rescues,
} = {}) {
  void lastPromptTokens; // 见上：保留参数只为签名兼容，禁止用于二次反推
  void windowRenews;     // 只做成本记账：续期次数**不得**反过来限制上下文救援（反之亦然）
  const ctxUsed = (rescues === undefined || rescues === null)
    ? Number(contextRescues) || 0
    : Number(rescues) || 0;
  const win = ctxWindow;
  const ctxHot = win > 0 && ctxEst > win * TOKEN_COMPACTION_TRIGGER;
  // 上下文到窗口：救援额度还有就压缩；用尽则交回主循环走「硬截断 → 换新窗口」的阶梯，
  // **不再由本函数宣布结束**（'reclaim-context' = 便宜招用完了，请用贵的招）。
  if (ctxHot) return ctxUsed < rescueMax ? 'compact' : 'reclaim-context';
  if (budget > 0 && spent > budget * TOKEN_COMPACTION_TRIGGER) {
    // 真终点只有累计总上限：它优先于任何续期判断，避免被续期绕开。
    if (totalCap > 0 && totalSpent >= totalCap) return 'suspend-tokens';
    // 上下文救援额度已用尽：预算还没越线就不动它；越线则续期（成本节流，不是终点）。
    if (ctxUsed >= rescueMax) return spent <= budget ? 'ok' : 'renew';
    // 上下文够大才值得压缩（压缩省下的是「每轮重发量」）
    return ctxEst >= win * TOKEN_COMPACT_MIN_RATIO ? 'compact' : 'new-window';
  }
  return 'ok';
}

// ── 墙钟 / 轮次：到期自动续期，而不是停下来等用户「继续」（2026-10-31）──
//
// 为什么改（用户实测反馈）：任务跑到一半「突然停掉、说要手动继续」，最常见的原因不是
// 撞到 20M，而是**30 分钟墙钟**——它是按「总时长」计的，只要任务本来就要跑 40 分钟，
// 就必然被它砍断一次。而墙钟的本意只是「别无限跑下去」，不是「到点就交给用户」。
//
// 于是把两者都改成「到期 → 自动续期继续跑，超过续期次数才挂起」：
//   · 墙钟：每续一次把起点前移，任务总时长上限实际变成 (1+N) × runWallClockMs；
//   · 轮次：每续一次把 roundCap 抬高一个 cap，实际变成 (1+N) × roundCap。
// 这样「跑得久」不再需要人工介入，而「跑飞」仍有硬兜底（续期有上限）。
//
// 注意：这不是取消熔断。次数用尽后仍走原来的「暂停而非失败」路径（落断点 + 收尾引导继续）。
export const MAX_WALLCLOCK_RENEWS = 2;
export const MAX_ROUND_RENEWS = 2;

/**
 * 墙钟闸判定（纯函数，便于单测逐分支钉住）。
 * @param {object} p
 * @param {number} p.runWallClockMs 单段墙钟上限（0/负数 = 不设闸）
 * @param {number} p.elapsedMs 本段已用时长
 * @param {number} p.renews 已续期次数
 * @param {number} [p.maxRenews] 续期上限
 * @returns {'none'|'renew'|'suspend'}
 */
export function wallClockDecision({ runWallClockMs = 0, elapsedMs = 0, renews = 0, maxRenews = MAX_WALLCLOCK_RENEWS } = {}) {
  if (!(runWallClockMs > 0) || elapsedMs <= runWallClockMs) return 'none';
  return renews < maxRenews ? 'renew' : 'suspend';
}

/**
 * 轮次闸判定：到 cap 时先续（抬高 cap），续满才停。
 * @returns {{ action: 'none'|'renew'|'suspend', nextCap?: number }}
 */
export function roundCapDecision({ roundsUsed = 0, roundCap = 0, renews = 0, maxRenews = MAX_ROUND_RENEWS } = {}) {
  if (!(roundCap > 0) || roundsUsed < roundCap) return { action: 'none' };
  if (renews < maxRenews) return { action: 'renew', nextCap: roundCap + roundCap };
  return { action: 'suspend' };
}
