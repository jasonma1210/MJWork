'use strict';
// C-004：JSON 安全解析的单一实现（主进程侧）
//
// 背景（审计实测）：同一段 6 行逻辑在 main/ 下被复制了 5 份，且**三族语义并不一致**：
//   · artifactStore.js / projectStore.js：`raw ? JSON.parse(raw) : fallback`  —— 空值 → fallback
//   · knowledgeBaseQuery.js：            `JSON.parse(s)` 裸调                —— null 直接返回 null
//   · teamStore.js / taskStore.js：       `s == null ? null : parse`          —— 空值 → null
// 三族对「列值为 NULL」的处理不同，于是「同一个字段在不同 store 里拿到 null 还是 {}」
// 取决于当初谁抄的谁。统一后一律「空值/空串 → fallback」，调用方拿到的是该字段的
// 类型空值（[]、{}），而不是 null —— 这比原来更安全（原实现里 `Object.keys(null)` 会崩）。
//
// 为什么放在 main/ 根而不是 main/tools/：
//   它不是工具实现，是通用 util；与同样「小而横切」的 ssrfGuard.js 平级。
// 为什么 renderer 不共用：渲染进程不能 require 主进程模块（Electron 的进程隔离），
//   agent-core 是独立 ESM 包（引擎不得 require 宿主目录），各自保留一份是有意的。

/**
 * 解析 JSON 字符串；空值 / 空串 / 解析失败一律返回 fallback。
 *
 * C-001 说明（为什么这里刻意不记日志）：本函数是全仓 27 处调用的**通用原语**，
 * 它不知道调用方眼中的「合法空值」是什么（SQLite TEXT 列里 '' 与 'null' 都常态存在），
 * 也不知道 fallback 是 [] 还是业务默认值。在这里打一条日志，等于把「某列坏了」这件事
 * 播成 27 处无从归因的噪音；真正需要区分「没设置」和「存坏了」的调用点（如 teamStore 的
 * payload、kb 的 payload）都在各自位置单独判并已留痕。
 * 若新增调用方需要这个区分，请在**调用点**用 JSON.parse + 自己的 catch，别指望本函数的返回值。
 *
 * @param {string|null|undefined} raw 原始文本（通常是 SQLite 的 TEXT 列）
 * @param {*} [fallback=null] 解析失败时的回落值；需要数组/对象就用 [] / {}
 * @returns {*} 解析结果或 fallback
 */
function safeParseJson(raw, fallback = null) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch { /* 见函数注释：通用原语不掌握语义，回落在调用方判定 */ return fallback; }
}

module.exports = { safeParseJson };
