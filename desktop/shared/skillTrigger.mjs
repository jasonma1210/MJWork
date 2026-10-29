// P1-1（2026-10-29）：技能触发器——slash 命令解析 + 关键词自动匹配。
// 纯函数、零依赖，agent-core 与未来宿主共用；可单测（见 test/skill-disclosure.test.mjs）。
//
// 语义分工（与 summary 披露模式兼容，不破坏「正文按需加载」）：
//   · slash `/skill <name>`：用户显式点名 ⇒ 强制注入该技能正文（即使 summary 模式）。
//   · 关键词命中（消息里出现技能名）：只在清单行标注「建议优先加载」，正文仍按需——
//     避免任意提及技能名就全量注入正文、破坏 summary 的省 token 语义。

const SLASH_RE = /^\/(?:skill|skills)\s+([^\s/]+)\s*([\s\S]*)$/i;

// 解析 `/skill <name> [rest]`；未命中返回 null。rest = 去掉命令后的剩余文本。
export function parseSlashSkill(text) {
  const m = SLASH_RE.exec(String(text || '').trim());
  if (!m) return null;
  return { name: m[1].trim(), rest: (m[2] || '').trim() };
}

// 关键词自动匹配：返回 name 出现在 query 中的技能名（大小写不敏感，name 长度≥2，去重，上限 limit）。
// 只按「技能名」匹配（可解释、低误报）；不做 description 子串匹配以免空词误命中。
export function matchSkillsByQuery(query, skills, { limit = 5 } = {}) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const out = [];
  const seen = new Set();
  for (const s of skills || []) {
    const name = String(s?.name || '').trim();
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (q.includes(key)) {
      seen.add(key);
      out.push(name);
      if (out.length >= limit) break;
    }
  }
  return out;
}
