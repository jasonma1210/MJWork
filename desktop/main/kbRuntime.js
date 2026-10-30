// 知识库运行期句柄（2026-10-27）
//
// 存在理由：知识注入发生在 `main/agentRunner.js` 的运行启动点，而数据库连接由 `main.js` 持有、
// 经 `main/ipc/registerDomains.js` 以「getter 注入」的方式交给各域。若为此在 main.js 的
// `initAgentRunner({...})` 里再加一个依赖键，会挤占它已经贴着 1500 行硬档的余量。
// 所以把「谁持有 db getter」收敛到这个小模块：装配处（registerDomains）写入一次，运行期只读。
//
// 约束：只读语义。持有的是 getter（而不是连接对象），这样 db 的创建/替换时机仍由 main.js 掌握，
// 本模块不会把某个旧连接钉死（历史事故：两条连接读到不同快照，账本明细与汇总立刻对不上）。
'use strict';

let getter = null;
let flagsGetter = null;
// C-001：getter 抛错是「装配坏了」而不是「功能没开」，但这两个函数每次知识注入/操作都会调，
// 逐次告警会刷屏。只告警一次并说明后果：整条知识库链路会静默按「不可用」走。
let degradedWarned = false;
function warnDegradedOnce(where, e) {
  if (degradedWarned) return;
  degradedWarned = true;
  console.warn(`[kbRuntime] ${where} 取用异常，知识库按「不可用」降级（本条只报一次）:`, e?.message || e);
}

/** @param {(() => object|null)|null} fn 返回 SQLite 连接的 getter */
function setDb(fn) {
  getter = typeof fn === 'function' ? fn : null;
}

/** @param {(() => object|null)|null} fn 返回特性开关对象的 getter（§17.2） */
function setFlags(fn) {
  flagsGetter = typeof fn === 'function' ? fn : null;
}

/** 知识能力是否开启（默认关闭；取不到开关时按关闭处理 = fail-closed） */
function enabled() {
  if (!flagsGetter) return false;
  try {
    const f = flagsGetter();
    return !!(f && f.knowledge);
  } catch (e) { /* C-001：fail-closed 是对的（默认关闭），但装配异常会让「用户明明开了却用不了」，需留痕 */
    warnDegradedOnce('特性开关', e);
    return false;
  }
}

/** @returns {object|null} 未装配或取用异常时返回 null（调用方按「不可用」处理，不抛错） */
function getDb() {
  if (!getter) return null;
  try {
    return getter() || null;
  } catch (e) { /* C-001：同上——返回 null 让调用方按「不可用」处理，但异常本身要留痕 */
    warnDegradedOnce('数据库句柄', e);
    return null;
  }
}

module.exports = { setDb, getDb, setFlags, enabled };
