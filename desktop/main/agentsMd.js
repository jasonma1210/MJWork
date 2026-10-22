// P1-11（2026-10-22）：主进程侧的 AGENTS.md 读取——让无人值守通道也守项目规范。
//
// 事故形状：项目规范此前**只有渲染层**读（renderer/src/lib/agentsMd.ts），随 payload 传给
// 交互式 run。而 Worker（Agent 军团成员）与定时任务走的是主进程自己的 runAgent 调用，
// payload 里没有 agentsMd ⇒ 同一个项目里，主会话的 Agent 守规矩、团队成员的 Agent 不守。
// 这不是"少一个功能"，是**同一份规范在两条通道上两种行为**（与本项目在 rolePreset 上
// 踩过的坑同型）。
//
// 口径与渲染层保持一致（否则两边注入的内容不同，等于又分叉一次）：
//   · 从 cwd 向上最多 5 级找 AGENTS.md；
//   · 多个命中按「越靠近 cwd 越优先」拼接，总长截断 8000 字符；
//   · 读不到 / 权限不足 / 非文件 ⇒ 返回空串（fail-open：没有规范不等于不能干活）。
const fs = require('node:fs');
const path = require('node:path');

const MAX_CHARS = 8000;
const MAX_DEPTH = 5;

/**
 * 读取 cwd 及其祖先目录下的 AGENTS.md。
 * @param {string} cwd 工作目录（Worker 的 worktree 或项目根）
 * @returns {string} 拼接后的规范正文（空串 = 没有规范）
 */
function readAgentsMd(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  const found = [];
  let dir;
  try { dir = path.resolve(cwd); } catch { return ''; }
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    const p = path.join(dir, 'AGENTS.md');
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) found.push(p);
    } catch { /* 该层没有就继续往上 */ }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到根了
    dir = parent;
  }
  if (found.length === 0) return '';
  // found 是「近 → 远」，反转成「远 → 近」拼接，让最贴近当前目录的规范排在最后（模型更重视末尾）
  const parts = [];
  for (const p of found.reverse()) {
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) parts.push(`# ${path.relative(cwd, p) || 'AGENTS.md'}\n${text}`);
    } catch { /* 单文件读失败不影响其他层 */ }
  }
  if (parts.length === 0) return '';
  return parts.join('\n\n---\n\n').slice(0, MAX_CHARS);
}

module.exports = { readAgentsMd, MAX_CHARS, MAX_DEPTH };
