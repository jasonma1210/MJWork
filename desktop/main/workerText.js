// Worker 活动流文本工具（2026-10-20：从 main/workerPool.js 抽出，使 workerPool 回到 800 行软档内）
//
// 为什么单独成模块：这两个函数是**纯文本处理**，与池的调度状态机无关，
// 放在 workerPool 里只会让那个 God File 继续膨胀（max-lines 门禁要求「先拆再合入」）。
// 单一事实来源保持不变：参数摘要口径与产物路径粗提取规则只在本文件维护。

// 工具参数摘要（活动流展示用）：截断长 JSON，仅保留关键信息。
// 80 字符上限与 main/db/index.js 写入侧注释的口径一致，避免两处截断长度漂移。
const ARGS_SUMMARY_MAX = 80;

function summarizeArgs(args) {
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args || {});
    return s.length > ARGS_SUMMARY_MAX ? `${s.slice(0, ARGS_SUMMARY_MAX)}…` : s;
  } catch { /* 循环引用参数（如挂了 AbortSignal/句柄）序列化不了：这里只产出活动流展示串，空串=不展示参数，不影响工具执行本身 */ return ''; }
}

// 从 Worker 结论文本提取产物文件路径（粗提取：反引号内以 / 或 ./ 开头的路径）。
// 单条 200 字符上限 + 最多 20 条，防止把大段文本当路径回传。
function extractPaths(text) {
  const out = [];
  const re = /`([^`\n]*\/[^`\n]+)`/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const p = m[1];
    if (p.length < 200 && !out.includes(p)) out.push(p);
    if (out.length >= 20) break;
  }
  return out;
}

module.exports = { summarizeArgs, extractPaths, ARGS_SUMMARY_MAX };
