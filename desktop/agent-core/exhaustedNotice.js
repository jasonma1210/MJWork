// 熔断/预算耗尽的收尾文案（纯函数，单测直调）。
//
// 为什么从 `agent-core/index.js` 搬出来（2026-10-30 第二次修）：
//   ① 行数棘轮：`index.js` 已到 `test/max-lines.test.js` 的 BASELINE_800 软档，
//      本轮要往里加「停止原因」真值传递，只能把整块文案外置，不能给自己开基线；
//   ② 职责本来就该分开：这里只决定「用哪句话把停下来的原因说清楚」，
//      不碰运行态、不碰计数器（与 `budgetDecision.js` 同一条边界）。
//
// 2026-10-30 事故（用户实测原文）：
//   「单任务累计消耗已达防失控总上限（累计 184145 tokens，期间已自动续期 3 次…）」
//   真实原因是**上下文到了模型窗口且压缩救援用尽**（gate 返回 'suspend-context'），
//   不是累计撞 20M。根因是收尾文案只靠一个 `contextStuck` 布尔分流，而那条挂起路径
//   从未设置它 ⇒ 一律落到「总上限」分支 ⇒ 文案把用户引向「调大预算」这个错误方向。
//
// 修法：改由**显式 `stopReason`** 决定分支，布尔只作兼容别名（旧调用方不炸）。
//   'context'    上下文到窗口（压缩/截断/换窗口都不够）
//   'total-cap'  真撞单任务累计总上限（唯一允许说「防失控总上限」的分支）
//   'wallclock'  整任务墙钟
//   'rounds'     轮次预算
//   'repeat'     同参数/同工具连续失败（空转熔断，文案在 index.js 侧生成）

// 停止原因枚举：新增原因必须落在这里，避免文案分支靠猜。
export const STOP_REASONS = Object.freeze(['context', 'total-cap', 'wallclock', 'rounds', 'repeat']);

/**
 * 把「为什么停」写成用户能自证的一句话。
 *
 * @param {object} p
 * @param {string} p.finalText     已有的部分产出（必须保留，不能覆盖模型写的正文）
 * @param {string} [p.stopReason]  显式停止原因（见 STOP_REASONS）——文案分支的唯一真值
 * @param {string} [p.budgetKind]  旧口径（'rounds' | 'tokens' | 'repeat'），仅在没有 stopReason 时兜底
 * @param {boolean} [p.contextStuck] 旧口径布尔，等价于 stopReason==='context'
 * @param {number} [p.tokenRescues] 已执行的**上下文**压缩救援次数
 * @param {number} [p.windowRenews] 预算窗口续期次数（与上下文救援分开记账，不互相抵扣）
 * @param {number} [p.totalCap]     单任务累计总上限（>0 才展示，便于用户核对）
 * @param {number} [p.totalSpent]   本次 run 累计消耗（优先于 usage 求和）
 */
export function buildExhaustedNotice({
  finalText = '', budgetKind = 'rounds', stopReason = '', wallClockHit = false, runWallClockMs = 0,
  tokenRescues = 0, windowRenews = 0, usage = {}, contextStuck = false, unattended = false, autoRestarts = 0,
  totalCap = 0, totalSpent = 0,
} = {}) {
  const sum = Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0);
  const total = Number(totalSpent) > 0 ? Number(totalSpent) : sum;
  const head = finalText || '任务尚未完成。';
  // 兼容派生：旧调用方（含既有单测）只传 budgetKind/contextStuck，也要落到正确分支。
  const reason = STOP_REASONS.includes(stopReason)
    ? stopReason
    : (wallClockHit ? 'wallclock' : (budgetKind === 'tokens' ? (contextStuck ? 'context' : 'total-cap') : 'rounds'));

  if (reason === 'wallclock') {
    return `${head}\n\n（整任务已运行超过 ${Math.round(runWallClockMs / 60000)} 分钟，触发总时长预算上限而停止；`
      + '这是防失控上限，需要更长可调大任务时长预算。）'.trim();
  }
  if (reason === 'context') {
    const why = autoRestarts > 0
      ? `已自动换新窗口续跑 ${autoRestarts} 次仍不够`
      : '压缩与硬截断都无处下手——历史里没有可裁的早期内容';
    // 「任务未完全完成」是宿主（workerPool）判定未完成收尾的唯一文本标记，三种分支都必须带。
    const tail = unattended
      ? `（上下文已到模型窗口（累计 ${total} tokens），${why}，任务未完全完成。继续跑只会空转。`
        + '请把任务拆小：分批抓取（例如每批 10 条、抓完立刻写进文件），或给这个任务换一个窗口更大的模型。）'
      : `（上下文已到模型窗口（累计 ${total} tokens），${why}，任务未完全完成。`
        + '建议拆分任务，或换一个窗口更大的模型；也可以回复「继续」让我基于现状收尾。）';
    return `${head}\n\n${tail}`.trim();
  }
  if (reason === 'total-cap') {
    // 只有这一支允许说「防失控总上限」，且必须把「已用多少 / 上限多少」两个数字都摆出来——
    // 此前只打累计值，用户无法自证是不是真的撞了上限（184145 那次就是被这句话骗的）。
    const cap = Number(totalCap) > 0 ? ` / 上限 ${Number(totalCap)}` : '';
    const renews = Number(windowRenews) > 0 ? Number(windowRenews) : Number(tokenRescues);
    const tail = unattended
      ? '下次运行请缩小任务范围，或把这个任务拆成几个小任务。'
      : '回复「继续」我会带着已有成果接着做。';
    return `${head}\n\n（单任务累计消耗已达防失控总上限（累计 ${total} tokens${cap}，期间已自动续期 ${renews} 次；`
      + `这是防止跑飞任务烧穿额度的最后一道线，不是上下文放不下），任务未完全完成。${tail}）`.trim();
  }
  return `${head}\n\n（单任务执行轮次预算已用尽，任务未完全完成。`
    + `${unattended ? '下次运行请缩小任务范围或调高轮次上限。' : '回复「继续」让我接着执行。'}）`.trim();
}

// 自动续跑的交接文本（纯函数）。上下文已经压满，**不能再调模型来写摘要**——
// 所以交接内容只能来自台账（工具名 + 命令/路径）与轮数，零模型调用。
export function buildHandoff({ ledger = [], roundsUsed = 0, restartNo = 1, maxRestarts = 2 } = {}) {
  const lines = (Array.isArray(ledger) ? ledger : []).slice(-20).map((e) => {
    const name = String(e?.name || '?');
    const raw = String(e?.command || (Array.isArray(e?.paths) ? e.paths.slice(0, 3).join(', ') : '') || '');
    const detail = raw.slice(0, 120);
    return `- ${name}${detail ? `：${detail}` : ''}${e?.ok === false ? '（失败）' : ''}`;
  });
  return `【续跑交接】上一段因上下文达到模型窗口而中断（第 ${restartNo}/${maxRestarts} 次自动换新窗口）。\n`
    + `已执行 ${roundsUsed} 轮，最近的工具动作为：\n${lines.join('\n') || '- （无）'}\n\n`
    + '请从断点继续，**不要重做已完成的步骤**。若剩余工作量大，请自动分批处理：'
    + '每批不超过 10 条，每批结果立即写入文件，写完不要再引用该批原文。';
}

// 断点保存钩子（2026-10-30 从 `agent-core/index.js` 外置，只为守住行数棘轮；行为不变）。
//
// A-05：onSuspend 的执行**可能异步**（子进程路径要经 RPC 回执才拿得到主进程落盘结果）。
// 此前四处调用写成 `!!onSuspend?.(...)`：Promise 恒为真值 ⇒ 断点写失败也会说「已保存」。
// 统一改为 await 真实返回值；in-process 路径 await 一个布尔值没有副作用。
// 失败一律按 false 收尾（fail-closed：不说「已保存」，也不让 await 永久挂起）。
export function makeSuspendNotifier(onSuspend) {
  return async function noticeSuspend(info) {
    try {
      return !!(await onSuspend?.(info));
    } catch (e) {
      console.warn('[agent] 断点保存钩子异常:', e.message);
      return false;
    }
  };
}

/** 子代理提前停止时给父代的可行动提示（纯函数，2026-10-30 从 index.js 外置：守行数棘轮）。 */
export function buildStoppedEarlyHint(budgetKind, tokenExhausted, objective) {
  const target = String(objective || '').slice(0, 80);
  if (tokenExhausted || budgetKind === 'tokens') {
    return `子代理因 token 预算耗尽而停止（目标：${target}）。不要用同一目标重试：`
      + '请把目标拆成更小、更具体的一步（例如只查某个文件/某个符号），或改由你自己直接用只读工具完成。';
  }
  if (budgetKind === 'rounds') {
    return `子代理因执行轮次用尽而停止（目标：${target}）。通常是目标太大或工具反复失败：`
      + '请缩小目标范围（指明具体文件/目录），或先自己 read_file 确认路径再派发。';
  }
  if (budgetKind === 'repeat') {
    return `子代理因工具连续失败而停止（目标：${target}）。请先自己验证相关路径/命令是否可用，再决定是否重新派发。`;
  }
  if (budgetKind === 'aborted') {
    return `子代理被中止（目标：${target}）。请检查是否因上层停止信号所致，再决定是否重新派发。`;
  }
  return `子代理提前停止（目标：${target}）。请先自行验证目标是否可达，再决定下一步。`;
}
