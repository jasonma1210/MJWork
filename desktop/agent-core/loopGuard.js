// 空转（循环）检测的计分核 —— 零依赖纯逻辑，2026-10-31 从 agent-core/index.js 外置。
//
// 为什么外置：引擎主文件撞了 code 行数棘轮（只减不增），而这次要给「墙钟/轮次到点自动
// 续期」腾出额度；把这套「连续失败计分」整段搬出来既腾了行数，也让它能被单测直接钉住
// （此前只能通过 runAgent 间接覆盖）。
//
// 判定口径（与搬迁前逐字节一致，行为零变化）：
//   ① 同一「工具名 + 参数」签名连续失败 ≥ REPEAT_FAIL_STOP(4) → 停（signature）
//   ② 同一工具连续失败（不看参数）≥ TOOL_FAIL_STOP(6) → 停（tool）
//      —— 补的是「换参数重试同一工具」这类签名熔断永远看不见的空转（t2 事故 20 轮 / 257k tokens）
//   ③ 同签名连续失败 ≥ REPEAT_FAIL_WARN(2) → 只旁路警示，不熔断
// 任一成功即把对应计数清零：正常「试错—纠正」不该被累积成空转。
//
// 依赖注入而非 import：signatureOf / isFailure 仍由引擎提供（它们定义在 index.js 且被导出）。
// 这样本文件保持零依赖，不会与引擎形成循环 import。

export const REPEAT_FAIL_WARN = 2;
export const REPEAT_FAIL_STOP = 4;
export const TOOL_FAIL_STOP = 6;

/**
 * 记一次工具结果，返回处置建议。
 * @param {object} p
 * @param {string} p.name 工具名
 * @param {object} p.args 入参（用于算签名）
 * @param {*} p.result 工具结果
 * @param {Map<string, number>} p.failStreak 签名 → 连续失败次数
 * @param {Map<string, number>} p.toolFailStreak 工具名 → 连续失败次数
 * @param {(name: string, args: object) => string} p.signatureOf
 * @param {(r: *) => boolean} p.isFailure
 * @returns {{verdict: 'ok'|'warn'|'stop', mode?: 'signature'|'tool', count?: number, tool?: string, notice?: string}}
 */
export const SUCCESS_REPEAT_WARN = 4;
// 保留常量名（仅用于文案/统计口径），不再作为熔断阈值

export function noteToolOutcome({ name, args, result, failStreak, toolFailStreak, successStreak, recentSigs, signatureOf, isFailure } = {}) {
  const sig = signatureOf(name, args);
  if (!isFailure(result)) {
    failStreak.delete(sig);
    toolFailStreak.delete(name);
    // ── 成功型空转（2026-10-31）：失败计分看不见「动作成功但毫无进展」——
    //    反复读同一文件、反复 grep 同一关键词都属于这一类，它们不报错，只是一直烧额度。
    //    两个判据：① 同一签名**连续**成功 N 次；② 最近 4 步呈 A→B→A→B 交替。
    //    任一命中先警示（旁路注入），到 STOP 才熔断——避免把「读→改→再读确认」误判成空转
    //    （那种序列签名不同，①② 都不会命中）。
    const n = (successStreak.get(sig) || 0) + 1;
    successStreak.set(sig, n);
    if (Array.isArray(recentSigs)) { recentSigs.push(sig); if (recentSigs.length > 4) recentSigs.shift(); }
    const alternating = Array.isArray(recentSigs) && recentSigs.length === 4
      && recentSigs[0] === recentSigs[2] && recentSigs[1] === recentSigs[3] && recentSigs[0] !== recentSigs[1];
    // 只警示、**不熔断**（2026-10-31 实测结论）：成功型空转的证据强度远低于失败型——
    // 「同一命令成功 6 次」在正常批处理/轮询里很常见，熔断会误杀真任务（多个既有套件当场红）。
    // 失败型有客观信号（报错），成功型只是「可能没进展」，所以只提醒模型，不替它停。
    // 警示**每签名只报一次**（2026-10-31）：否则连续 10 次相同动作会注入 10 条提醒，
    // 每次都挤占当轮 system 尾部、把 renewNotice 冲掉真正的反思指令。
    if (alternating || n === SUCCESS_REPEAT_WARN) {
      return {
        verdict: 'warn', tool: name, count: n,
        notice: `系统提示：你正在重复同一动作（\`${name}\` 连续 ${n} 次相同参数，或出现 A→B→A→B 交替），但都没有产生新信息。`
          + '请先说明这一步要拿到什么结论；若已拿到，直接进入下一步或输出最终总结，不要再重复。',
      };
    }
    return { verdict: 'ok' };
  }
  const n = (failStreak.get(sig) || 0) + 1;
  failStreak.set(sig, n);
  const m = (toolFailStreak.get(name) || 0) + 1;
  toolFailStreak.set(name, m);
  if (n >= REPEAT_FAIL_STOP) return { verdict: 'stop', mode: 'signature', count: n, tool: name };
  if (m >= TOOL_FAIL_STOP) return { verdict: 'stop', mode: 'tool', count: m, tool: name };
  if (n >= REPEAT_FAIL_WARN) {
    // 旁路注入（写 renewNotice 而非 convo）：不污染会话历史，用户重进线程看不到这条系统话
    return {
      verdict: 'warn', tool: name, count: n,
      notice: `系统提示：工具 ${name} 用完全相同的参数已连续失败 ${n} 次。`
        + '禁止再用同样的参数重试。请先换方式确认真实状态（例如用 read_file 读取文件当前内容），'
        + '或改用别的工具达成同一目标；如果该目标其实已经达成，直接输出最终总结结束任务。',
    };
  }
  return { verdict: 'ok' };
}
