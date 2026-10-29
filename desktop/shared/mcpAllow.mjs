// 成员级 MCP 工具粒度（P1-4，2026-10-29）—— 引擎侧唯一的一份匹配实现
//
// ── 缺陷（改前）──
//   成员的 MCP 权限只有一个布尔 `allowMcp`：true = 该成员拿到**所有**已连接服务的**所有**工具
//   （含写文件 / 删目录这类 destructive 工具），false = 一个都拿不到。中间没有任何挡位——
//   想让「只读分析员」用 filesystem 读文件、但不碰 write/delete，只能二选一：全放开或全禁掉。
//   权限粒度比「角色」粗一档，等于把「最小权限」降级成「要么全权要么无权限」。
//
// ── 修法：服务器级 + 工具级两档白名单 ──
//   `mcpAllow` 是字符串数组，条目两种写法：
//     · 服务器名（`filesystem`）                → 该服务器下的**全部**工具
//     · 完整工具名（`mcp__filesystem__read_file`）→ 仅这一个工具
//   判定语义：**非 MCP 工具一律保留**（本模块只收窄 MCP 面，不碰内置工具），
//   MCP 工具按上述两类条目匹配，匹配不上即移除。
//
// ── 为什么服务器名条目要「反解后比较」而不是拼前缀 ──
//   `mcp__<片段>__<工具名>` 的服务名片段是**编码过**的：含 `__` / 空格 / 非 ASCII 的服务名
//   会被转成 `%XX`（见 shared/mcpNameCodec.mjs 文件头）。于是
//   `name.startsWith('mcp__' + server + '__')` 对这类服务名**永远匹配不上**——用户填了
//   `my__svc`、库里实际存的是 `mcp__my%5F%5Fsvc__x`，表现成「白名单明明填对了却一个工具都没有」
//   的静默失效，且错误信息与「名字里有下划线」毫无线索关联。故这里一律走 decodeToolName
//   反解出真实服务名再比。
//
// ── fail-closed 边界（两条，都与「别把漏判当放行」有关）──
//   ① `mcpAllow` 为空数组 ⇒ `narrowToolsByMcpAllow` **原样返回**，即「不抑制既有语义」：
//      allowMcp / toolNames 该放多少还放多少。收窄动作必须由调用方显式判空后触发，
//      不能靠这里「空数组顺手清空一切」——那会把存量成员的 MCP 全废掉。
//   ② `mcpAllowMatches` 对空列表返回 **false**（「没有条目可匹配」= 不匹配）。万一某个调用点
//      漏了判空，后果是「全部 MCP 工具被移除」（fail-closed），而不是「全部放行」（fail-open）。
//      方向搞反的权限缺陷比功能缺陷严重得多，这里宁可失效也不可越权。
//
// ── 零依赖 ──
//   只 import ./mcpNameCodec.mjs（同为 ESM、零 Node 内建依赖），故引擎侧（agent-core，ESM）
//   与未来的渲染层配置界面可以共用同一份实现，不存在「两份前缀判断各写一遍」的漂移风险。
import { decodeToolName } from './mcpNameCodec.mjs';

/** 单条目字符上限（与 team_members 其它名字列同量级；完整工具名预算 128 见 mcpNameCodec）。 */
export const MCP_ALLOW_MAX_CHARS = 128;
/** 条目数上限：够写「几十个服务 + 个别工具例外」，又不至于让白名单本身成为一次注入面。 */
export const MCP_ALLOW_MAX_ENTRIES = 64;

const MCP_PREFIX = 'mcp__';

/**
 * 形状清洗：去空、限长、去重、限条数。**不做语义判定**（服务器是否存在、工具是否拼对，
 * 由运行时匹配那一侧决定并告警——存进来时服务可能还没连上）。
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeMcpAllow(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || s.length > MCP_ALLOW_MAX_CHARS) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MCP_ALLOW_MAX_ENTRIES) break;
  }
  return out;
}

/**
 * 某个完整工具名是否被白名单放行。
 * @param {string} fullName 完整工具名（`mcp__<编码服务名>__<工具名>`）
 * @param {string[]} allowList 白名单条目
 * @returns {boolean} 非 MCP 名 / 空列表 / 无条目匹配 ⇒ false
 */
export function mcpAllowMatches(fullName, allowList) {
  const name = fullName == null ? '' : String(fullName);
  if (!name.startsWith(MCP_PREFIX)) return false;
  const entries = Array.isArray(allowList) ? allowList : [];
  if (!entries.length) return false; // fail-closed 边界②
  const parsed = decodeToolName(name);
  for (const raw of entries) {
    const e = raw == null ? '' : String(raw).trim();
    if (!e) continue;
    if (e === name) return true; // 工具级：完整拼名逐字节相等（编码名同样可行）
    if (parsed && e === parsed.server) return true; // 服务器级：解码后比较，避开编码名
  }
  return false;
}

/**
 * 按白名单收窄工具表：只过滤 MCP 工具，内置工具（及其它非 `mcp__` 工具）原样保留。
 * 白名单为空时**原样返回同一个数组引用**（不制造无意义的副本，也保证「未配置 = 零行为变化」）。
 *
 * @param {Array<{function?:{name?:string}}>} tools
 * @param {string[]} allowList
 * @returns {Array<{function?:{name?:string}}>}
 */
export function narrowToolsByMcpAllow(tools, allowList) {
  const list = Array.isArray(tools) ? tools : [];
  const entries = normalizeMcpAllow(allowList);
  if (!entries.length) return list;
  return list.filter((t) => {
    const n = t && t.function ? t.function.name : null;
    if (n == null || !String(n).startsWith(MCP_PREFIX)) return true; // 非 MCP 工具不受本机制影响
    return mcpAllowMatches(String(n), entries);
  });
}
