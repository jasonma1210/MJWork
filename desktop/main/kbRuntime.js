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
  } catch {
    return false;
  }
}

/** @returns {object|null} 未装配或取用异常时返回 null（调用方按「不可用」处理，不抛错） */
function getDb() {
  if (!getter) return null;
  try {
    return getter() || null;
  } catch {
    return null;
  }
}

module.exports = { setDb, getDb, setFlags, enabled };
