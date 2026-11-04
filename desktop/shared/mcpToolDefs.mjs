// MCP 工具定义 —— 跨宿主单一事实来源（第六轮 N5）
//
// 背景（第六轮审查 N5）：`toToolDefs` 曾在渲染层（renderer/src/lib/mcpTools.js）与主进程
//   （main/intentMcpPrewarm.js）各有一份「同形」实现，靠人工同步。一旦其中一处改了命名/描述
//   规范化策略，另一条路径就会**静默产出不同形状**的 MCP 工具定义（同一服务经两条路径不兼容）。
//   本文件把构造 / 排序 / 去重三项收敛到唯一实现：
//     · 渲染层（ESM）静态 `import { ... } from '.../shared/mcpToolDefs.mjs'`；
//     · 主进程（CJS）经 `import('../shared/mcpToolDefs.mjs')` 动态加载（见 intentMcpPrewarm.loadMcpToolDefs）。
//   与 shared/untrustedContent.mjs、shared/resumeIntent.mjs、shared/sandboxNotice.mjs 同构。
//
// 背景（第六轮 G9）：MCP 工具披露顺序此前 = 主进程返回顺序（`flatMap` 原序、无排序），
//   披露序列随连接顺序/配置顺序变化 → **前缀缓存不稳定**。这里提供 `sortServerEntries`，
//   按「服务名 → 工具名」稳定排序，保证相同配置下披露序列**字节稳定**。
//
// 背景（第七轮 F-007 / B1-B-06）：工具**定义**侧此前零守卫 —— 第三方 server 的 `description`
//   与 `inputSchema` **原样**进入 function schema 直达模型上下文（`mcpClient.js` 只清洗工具名，
//   `mcpToolCache.js` 原样缓存）。对照工具**结果**侧早就有 `detectPromptInjection` 级别的守卫，
//   定义侧却可以被一个失控/恶意 server 用来：
//     · 用 50 KB 描述挤占上下文（挤掉系统提示与真实工具）；
//     · 在描述里夹带「IGNORE ALL PREVIOUS INSTRUCTIONS」这类指令，直接影响工具选择与行为；
//     · 用爆炸式枚举 / 深 20 层嵌套 schema 拖垮序列化与模型理解。
//   本文件因此在构造点加三道闸（上限常量全部 import 自 shared/contextBudget.mjs，**不在这里
//   写第二份数字**）：
//     ① `description` 超 `MAX_TOOL_DESCRIPTION_CHARS` → 截断 + `TOOL_DESCRIPTION_TRUNCATION_SUFFIX`；
//     ② `inputSchema` 超字节/深度上限 → **不截断 schema**（截断会产出非法 schema，调用必失败），
//        改为把该工具标记为不可用（`__blocked__` + description 前缀），由调用方过滤；
//     ③ 所有 MCP 工具一律携带 `__untrusted__: true`（来源是第三方）。
//   铁律：**任何一个坏工具都不能拖垮整个 server** —— 三道闸只标记/截断，绝不抛异常中断连接。

import {
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_INPUT_SCHEMA_BYTES,
  MAX_INPUT_SCHEMA_DEPTH,
  TOOL_DESCRIPTION_TRUNCATION_SUFFIX,
  inspectToolDefinition,
  schemaByteSize,
  truncateDescription,
} from './contextBudget.mjs';
import { detectPromptInjection } from './untrustedContent.mjs';
// 第八轮 F-005 / B1-B-05：工具名**拼名**收敛到 codec（与 agent-core 的反解严格互逆）。
// 改前这里是内联 `` `mcp__${s}__${t.name}` ``，而 agent-core 反解时把名字按 `__` 切分取服务名 ——
// 二者不互逆，server 名含 `__` 时调用会静默打到另一个服务上。详见 shared/mcpNameCodec.mjs 文件头。
import { buildToolName, decodeToolName } from './mcpNameCodec.mjs';

export { MAX_TOOL_DESCRIPTION_CHARS, MAX_INPUT_SCHEMA_BYTES, MAX_INPUT_SCHEMA_DEPTH };

/**
 * 在工具定义上打**不可枚举**标记。
 *
 * 为什么不可枚举（关键设计决策，勿改）：
 *   `toToolDefs` 的产出经 `agent-core` 的 `allTools` 直接作为 `tools` 交给宿主
 *   （`agent-core/index.js:2714` → `main/scheduledChannels.js:82-83` 原样写入
 *   `body.tools` → 供应商 HTTP body）。若标记是可枚举属性，它会被序列化进每一次模型请求，
 *   等于给所有供应商的 tool schema 塞了规范外的字段——轻则被忽略，重则 400，
 *   而下游消费方（agent-core / scheduledChannels）本轮不在本任务可改范围内。
 *   改成不可枚举后：**线上报文与改动前逐字节一致**，而进程内的调用方
 *   （`isBlockedToolDef` / 审计 / 测试）仍可正常读到标记。
 */
function defineHidden(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return target;
}

/** 该工具定义是否被长度闸判为不可用（调用方据此过滤；返回原因字符串或空串）。 */
export function isBlockedToolDef(def) {
  return (def && typeof def === 'object' && def.__blocked__) || '';
}

/**
 * 服务端工具清单 → OpenAI function 定义（agent-core 消费格式）。
 *
 * 返回结构保持与改动前**完全同形**（`{type, function:{name, description, parameters}}`），
 * 长度闸产生的元信息一律以不可枚举属性挂在定义对象上：
 *   · `__untrusted__: true`  —— 所有 MCP 工具恒有（第三方来源）；
 *   · `__blocked__: '<原因>'` —— 仅 schema 超限的工具（调用方应过滤掉）；
 *   · `__injection__: [规则id]` —— 描述命中注入特征的规则清单（只留痕，不阻断：
 *     定义侧阻断会因误报把正常工具整块下架，处置权留给调用方/审计）；
 *   · `__outputSchema__: <schema>` —— 服务端在 `tools/list` 里声明的 outputSchema（F-014/A16c，
 *     仅当服务端提供时挂载）。同样不可枚举：它对模型不可见（线上报文不含它），唯一用途是
 *     `tools/call` 结果侧校验 `structuredContent` 是否符合服务端自己声明的 shape
 *     （见本文件末节 applyStructuredOutputPolicy）。
 *
 * 不抛异常：单个坏工具只影响它自己。
 */
export function toToolDefs(server, tools) {
  const s = String(server || '');
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && t.name)
    .map((t) => {
      const inspected = inspectToolDefinition(t);

      // ① description：保留原有的 `t.description || t.name` 回落语义，再做长度闸
      const rawDescription = t.description || t.name;
      const { text: truncatedText, truncated } = truncateDescription(rawDescription);
      let description = truncatedText;

      // ② inputSchema：只判不截断（schema 被截断 = 非法 schema = 调用必失败）
      let blocked = '';
      if (inspected.schemaTooLarge) {
        blocked = `[schema-too-large] ${inspected.reason}`;
        // 前缀让「即使调用方忘了过滤」时模型也能看出这个工具当前不可用
        description = `[schema-too-large] ${description}`;
      }

      const def = {
        type: 'function',
        function: {
          // F-005：唯一拼名入口（server 段编码后不含 `_`，反解无歧义）；不在此手写模板字符串
          name: buildToolName(s, t.name),
          description,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      };

      // ③ 不可信标记 + 闸门留痕（全部不可枚举，不进线上报文）
      defineHidden(def, '__untrusted__', true);
      if (truncated) defineHidden(def, '__descriptionTruncated__', true);
      if (blocked) defineHidden(def, '__blocked__', blocked);
      // 描述里的注入特征（与工具结果侧同一套规则表）：只记录，不阻断
      try {
        const hit = detectPromptInjection(String(rawDescription || ''));
        if (hit && hit.suspicious) {
          defineHidden(def, '__injection__', (hit.findings || []).map((f) => f.id));
        }
      } catch {
        // 扫描失败不影响工具可用性（守卫是增益，不是前置条件）
      }
      // ④ outputSchema（F-014 / A16c）：服务端声明的结构化输出 shape。不可枚举的理由与上面
      //    三个标记完全相同（可枚举会进每一次模型请求的 tool schema）；它的唯一消费者是
      //    tools/call 结果侧的 applyStructuredOutputPolicy（见本文件末节）。
      if (t.outputSchema) defineHidden(def, '__outputSchema__', t.outputSchema);
      return def;
    });
}

/**
 * 披露确定性排序：对 [{server, tools}] 条目先按服务名、再按工具名做稳定排序。
 * 返回值是**新对象/新数组**（不改动入参），供 flatMap(toToolDefs) 使用。
 * 排序键为纯字符串比较（不依赖 locale），跨平台/跨宿主结果一致。
 */
export function sortServerEntries(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && e.server)
    .map((e) => ({
      server: String(e.server),
      tools: (Array.isArray(e.tools) ? e.tools : []).filter((t) => t && t.name),
    }))
    .sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0))
    .map((e) => ({
      server: e.server,
      tools: [...e.tools].sort((x, y) => {
        const nx = String(x.name);
        const ny = String(y.name);
        return nx < ny ? -1 : nx > ny ? 1 : 0;
      }),
    }));
}

/** 按「服务名 → 工具名」稳定排序并直接产出 OpenAI function 定义（排序 + 构造一步到位）。 */
export function sortedToolDefs(list) {
  return sortServerEntries(list).flatMap(({ server, tools }) => toToolDefs(server, tools));
}

/** 合并工具定义：按 function.name 去重，base（本轮已有）优先，避免同一工具出现两份。 */
export function mergeToolDefs(base = [], additions = []) {
  const seen = new Set();
  const out = [];
  for (const t of [...(Array.isArray(base) ? base : []), ...(Array.isArray(additions) ? additions : [])]) {
    const n = t && t.function && t.function.name;
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
  }
  return out;
}

/** 后缀再导出：测试与调用方断言「截断后长度」时必须与实现同源，不得二次硬编码。 */
export { TOOL_DESCRIPTION_TRUNCATION_SUFFIX };

/**
 * 按服务名剔除工具定义（2026-11-04：会话级连接器排除）。
 *
 * 背景：连接器一旦连上就是**进程级全局**状态，「本会话不用某个连接器」无法用「断开」表达
 * （`mcp:disconnect` 会连 mcp-servers.json 里的持久化配置一起删，点一下就等于永久丢配置），
 * 只能表达为对工具表的**减项**。调用点必须在「意图预热合并之后」：预热按「本轮 mcpTools
 * 里没有谁」决定要连谁，先滤会让被排除的服务以「未连接」姿态被重新连上并注入，排除形同虚设。
 *
 * 服务名一律经 codec **反解**（不可按 `__` 裸切，理由见 shared/mcpNameCodec.mjs 文件头）。
 * 解不出服务名的定义**保留**：宁可多给一个工具，也不静默吞掉用户的连接器。
 *
 * @param {Array} defs  已合并的工具定义
 * @param {string[]} serverNames  要剔除的服务名（空/非法 ⇒ 原样返回）
 * @returns {Array} 新数组（不修改入参）
 */
export function excludeServerTools(defs, serverNames) {
  const list = Array.isArray(defs) ? defs : [];
  const blocked = new Set((Array.isArray(serverNames) ? serverNames : []).map((n) => String(n || '')).filter(Boolean));
  if (!blocked.size) return list;
  return list.filter((t) => {
    const name = t && t.function && t.function.name;
    const server = name ? decodeToolName(name) : null;
    const s = server && server.server;
    return !s || !blocked.has(s);
  });
}


// ════════════════════════════════════════════════════════════════════════════
// F-014 / A16c：结构化输出的**结果侧**策略（用户裁决第三条路：「校验走结构化，展示走文本」）
// ════════════════════════════════════════════════════════════════════════════
// 背景：MCP `tools/call` 的返回除 `content`（文本块数组，规范要求必须给）外，还可带
//   `structuredContent`（结构化数据，其 shape 由服务端在 `tools/list` 的 `outputSchema`
//   里声明）。此前 MJCode 把整个 result 交给 agent-core 的 truncateToolResult
//   （`agent-core/index.js:1977`，直接 JSON.stringify 进模型上下文）：结构化数据其实
//   **已经在进上下文**，却没有任何一方校验过它是否真的符合服务端自己声明的 shape。
//
// 裁决口径（第三条路，2026-10-20）：
//   · **校验走结构化**：服务端声明了 outputSchema 且返回了 structuredContent，就按 schema 校验；
//   · **展示走文本**：校验只用于给模型发提示；结构化数据本身**不进上下文** —— 同一个数据
//     模型让模型看两遍（文本版 + JSON 版）是纯预算浪费，而文本版是服务端按规范必须给的；
//   · 校验不匹配 → 在 `content` 最前面插入一条明确提示，让模型以文本内容为准。
//
// 铁律（与定义侧三道闸同构）：**策略是增益，不是前置条件**。校验/剥离任何一步出错
//   （含循环引用、超大输入）都不得把一次成功的工具调用变成失败 —— 一律 fail-open。

/** 校验遍历时 value 的深度硬顶（超过即跳过校验：病态深嵌套不是该判失败的对象）。 */
const MAX_STRUCTURED_VALUE_DEPTH = 32;
/**
 * value 深度**测量**的递归硬顶。必须显著大于 MAX_STRUCTURED_VALUE_DEPTH：测量函数若在
 * MAX 处就停住并返回 MAX，深度永远「不超过 MAX」，硬上限判定会静默失效（与
 * contextBudget.mjs 的 DEPTH_RECURSION_CAP 同一思路）。
 */
const STRUCTURED_DEPTH_RECURSION_CAP = 64;
/** 校验遍历的访问节点数硬顶（超过即跳过校验：防病态巨型值把校验本身变成 DoS）。 */
const MAX_STRUCTURED_VALIDATE_NODES = 20000;

/** 结构化数据失配提示的前缀（完整文案上限 STRUCTURED_NOTE_MAX_CHARS 字符）。 */
const STRUCTURED_NOTE_PREFIX = '[MJCode] 结构化输出未通过服务端声明的 outputSchema 校验';
/** 提示文案硬上限（超长 reason 截断，绝不无限长地占用上下文）。 */
const STRUCTURED_NOTE_MAX_CHARS = 300;

/** JSON 值的中文类型名（用于人话原因）。undefined/function 不可能来自 JSON，兜底为 unknown。 */
function jsonTypeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  return t === 'object' ? 'object' : t; // string / number / boolean
}

/**
 * 单类型匹配（JSON Schema 子集）。
 * 不认识的 `type` 取值一律返回 true（fail-open）——见 validateStructuredOutput 的 JSDoc。
 * `type` 为数组（联合类型，如 ['string','null']）时任一命中即过。
 */
function matchesJsonType(value, type) {
  if (Array.isArray(type)) return type.some((t) => matchesJsonType(value, t));
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

/** enum 成员的深比较（enum 可能含对象/数组成员，不能用 ===）。 */
function jsonEquals(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** value 的嵌套深度（循环引用就地停住，不抛；仅用于硬上限判定）。 */
function structuredValueDepth(value, _depth = 0, _seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return _depth;
  if (_seen.has(value)) return _depth;
  if (_depth >= STRUCTURED_DEPTH_RECURSION_CAP) return _depth;
  _seen.add(value);
  let deepest = _depth;
  const entries = Array.isArray(value) ? value.map((v) => [0, v]) : Object.entries(value);
  for (const [, v] of entries) {
    const d = structuredValueDepth(v, _depth + 1, _seen);
    if (d > deepest) deepest = d;
  }
  _seen.delete(value); // 同一子对象被多处引用不重复计入
  return deepest;
}

/**
 * 遍历校验的核心。返回 null = 通过；返回 { path, reason } = 第一个不匹配点；
 * 返回 { skipped: true } = 触到访问节点硬顶，调用方按「跳过校验」处理。
 */
function walkStructured(schema, value, path, ctx) {
  ctx.nodes += 1;
  if (ctx.nodes > MAX_STRUCTURED_VALIDATE_NODES) return { skipped: true };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null; // 非对象 schema：无约束可判

  // type（不认识的关键字取值不判失败，见函数头注释）
  if (schema.type !== undefined && !matchesJsonType(value, schema.type)) {
    const want = Array.isArray(schema.type) ? schema.type.join('|') : String(schema.type);
    return { path, reason: `期望 ${want}，实际 ${jsonTypeName(value)}` };
  }

  // enum
  if (Array.isArray(schema.enum)) {
    const hit = schema.enum.some((c) => jsonEquals(c, value));
    if (!hit) {
      const shown = schema.enum.map((c) => JSON.stringify(c)).join(' / ');
      return { path, reason: `取值 ${JSON.stringify(value)} 不在 enum 允许集合内（${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown}）` };
    }
  }

  // object：required + properties
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          return { path: `${path}.${key}`, reason: '缺少 required 属性' };
        }
      }
    }
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        // 缺属性交给 required 判（JSON Schema 语义：properties 不强制存在）
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const bad = walkStructured(sub, value[key], `${path}.${key}`, ctx);
        if (bad) return bad;
      }
    }
  }

  // array：items（对象形式校验所有元素；数组形式按位置做元组校验）
  if (Array.isArray(value) && schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      for (let i = 0; i < value.length && i < schema.items.length; i += 1) {
        const bad = walkStructured(schema.items[i], value[i], `${path}[${i}]`, ctx);
        if (bad) return bad;
      }
    } else {
      for (let i = 0; i < value.length; i += 1) {
        const bad = walkStructured(schema.items, value[i], `${path}[${i}]`, ctx);
        if (bad) return bad;
      }
    }
  }
  return null;
}

/**
 * 按服务端声明的 outputSchema 校验 structuredContent（**JSON Schema 子集**）。
 *
 * 支持关键字：`type`（string/number/integer/boolean/object/array/null，含联合类型数组）、
 * `required`、`properties`、`items`（对象或元组形式）、`enum`。
 *
 * **不支持的关键字一律忽略（fail-open）**，为什么这是刻意设计：第三方的 outputSchema 会
 * 大量用到我们不懂的关键字（`minLength` / `pattern` / `oneOf` / `$ref` / `format` …）。
 * 为不懂的部分判失败 = 误报泛滥 = 校验结论被整体无视，比不校验更坏。宁可放过，不可错杀。
 *
 * 硬上限（超过即**跳过校验**，不是判失败）：schema 字节数 > MAX_INPUT_SCHEMA_BYTES
 * （import 自 contextBudget.mjs，不在这里写第二个数字）、value 深度 > 32、访问节点 > 20000。
 *
 * **绝不抛异常**：内部错误（含循环引用的 schema/value）一律 try/catch 兜住。
 * 校验是增益，不是前置条件。
 *
 * @param {unknown} schema 服务端声明的 outputSchema
 * @param {unknown} value 工具返回的 structuredContent
 * @returns {{ ok: true, skipped?: 'limit'|'error' } | { ok: false, path: string, reason: string }}
 */
export function validateStructuredOutput(schema, value) {
  try {
    // 空 schema / 非对象 schema：没有任何可判的约束 → 通过
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { ok: true };
    // 硬上限一：schema 体积（与定义侧字节闸同一份常量）
    if (schemaByteSize(schema) > MAX_INPUT_SCHEMA_BYTES) return { ok: true, skipped: 'limit' };
    // 硬上限二：value 深度
    if (structuredValueDepth(value) > MAX_STRUCTURED_VALUE_DEPTH) return { ok: true, skipped: 'limit' };
    const bad = walkStructured(schema, value, '$', { nodes: 0 });
    if (bad && bad.skipped) return { ok: true, skipped: 'limit' }; // 硬上限三：访问节点
    if (bad) return { ok: false, path: bad.path, reason: bad.reason };
    return { ok: true };
  } catch {
    return { ok: true, skipped: 'error' };
  }
}

/** 构造失配提示（超长截断到 STRUCTURED_NOTE_MAX_CHARS）。 */
function buildStructuredNote(verdict) {
  const where = `${verdict && verdict.path ? verdict.path : '$'}: ${verdict && verdict.reason ? verdict.reason : '未知原因'}`;
  const note = `${STRUCTURED_NOTE_PREFIX}（${where}）。请以文本内容为准，不要依赖结构化字段。`;
  return note.length <= STRUCTURED_NOTE_MAX_CHARS ? note : `${note.slice(0, STRUCTURED_NOTE_MAX_CHARS - 1)}…`;
}

/** content 里是否存在至少一个**非空** text 块（服务端按规范必须给的文本版）。 */
function hasNonEmptyTextBlock(content) {
  return Array.isArray(content)
    && content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0);
}

/**
 * 结构化输出的结果侧策略（F-014 / A16c，裁决第三条路「校验走结构化，展示走文本」）。
 *
 * 行为（按优先级）：
 *   ① 无 outputSchema / 无 structuredContent → 原样返回（**不改入参**）；
 *   ② 有则按 outputSchema 校验；**不匹配** → 在 `content` 最前面插入一条 text 提示
 *      （`[MJCode] 结构化输出未通过服务端声明的 outputSchema 校验（<path>: <reason>）。
 *      请以文本内容为准，不要依赖结构化字段。`，≤300 字符）。content 非数组（不合规服务端）
 *      时先把**原文包装成 text 块**再插 note —— 绝不把原文静默丢弃；
 *   ③ **无论校验是否匹配**，只要 `content` 里存在至少一个非空 text 块，就从返回对象里
 *      **删掉 structuredContent** —— 同一个数据模型让模型看两遍（文本版 + JSON 版）是纯
 *      预算浪费，而文本版是服务端按规范必须给的。`content` 为空/没有 text 块时**保留**
 *      structuredContent（fail-open 朝向可用性：宁可给模型看数据，也不让它什么都没有）。
 *      **「有没有文本版」在插入 note 之前判定**：note 自身也是一个非空 text 块，若在插入
 *      后判定，「无文本版」的结果会被我们自己的提示伪装成「有文本版」，进而剥掉
 *      structuredContent —— 模型最终只剩一句「未通过校验」，眼前没有文本内容、也拿不到
 *      任何数据，与 fail-open 朝向可用性正好相反；
 *   ④ 保留 `isError` 等其余字段；返回浅拷贝。
 *
 * **绝不让策略把一次成功的工具调用变成失败**：任何一步出错 → 返回原 result。
 *
 * @param {object} result tools/call 的原始返回
 * @param {unknown} outputSchema 服务端为该工具声明的 outputSchema（没有就不传/传假值）
 * @returns {object} 新对象（或原引用；入参永不被修改）
 */
export function applyStructuredOutputPolicy(result, outputSchema) {
  try {
    if (!outputSchema || typeof outputSchema !== 'object') return result;
    if (!result || typeof result !== 'object') return result;
    if (result.structuredContent === undefined || result.structuredContent === null) return result;

    const verdict = validateStructuredOutput(outputSchema, result.structuredContent);
    // 「有没有文本版」必须在插 note **之前**判定：note 自己也是 text 块，若在插入后判定，
    // 「无文本版」的结果会被我们自己的提示伪装成「有文本版」，进而剥掉 structuredContent ——
    // 模型最终只剩一句「未通过校验」，眼前没有文本内容、也拿不到数据。这与 fail-open 朝向
    // 可用性（宁可给模型看数据，也不让它什么都没有）正好相反。
    const hasTextVersion = hasNonEmptyTextBlock(result.content);
    const out = { ...result };
    if (verdict.ok !== true) {
      // content 非数组（不合规服务端）时先包装成 text 块，绝不丢弃原文：把原文直接替换成
      // 「只有一条 note」会让模型连服务端给的文本都看不到。
      const content = Array.isArray(out.content)
        ? [...out.content]
        : (out.content === undefined || out.content === null ? [] : [{ type: 'text', text: String(out.content) }]);
      content.unshift({ type: 'text', text: buildStructuredNote(verdict) });
      out.content = content;
    }
    if (hasTextVersion) delete out.structuredContent;
    return out;
  } catch {
    return result; // 策略出错：原样返回，工具结果不受影响
  }
}
