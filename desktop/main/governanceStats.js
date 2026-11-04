// ═══════════════════════════════════════════════════════════════
// N9：治理开关的进程内观测计数（hook / 意图预热 / 技能按需加载）—— CJS，纯内存
// ═══════════════════════════════════════════════════════════════
// 缺口（第六轮审查 §3 N9）：三个「治理开关」只有零散 console.log，没有任何可读取的
// 命中率落点 ⇒ 无法回答「开关是否真的在生效」，与 N2 同属「无可观测 = 无门禁」。
//
// 定位与边界（务必守住的取舍）：
//   · 内存计数器，**不落盘**——它是观测面（observability），不是事实源（truth source）。
//     事实源是 hooks.json / 已开启的 MCP 连接器 / skills 目录本身；
//     把命中率落盘反而会衍生第二事实源与写放大，且这些计数天然可丢（丢一条只是少一次观测）。
//   · 计数单调递增，进程重启清零——语义就是「本次运行期内命中多少」。
//   · 消费方（缺一不可，否则计数只是又一堆无人读的日志）：
//       ① `governance:stats` IPC —— 程序化读取（设置页 / 调试脚本 / 未来 UI）；
//       ② diagExport 诊断包 `governance/stats.json` —— 用户自愿提交的现场证据，
//          让「治理开关真机上到底有没有生效」可被复盘。
//
// 形状（bucket → key → count，键用 `阶段.动作` 便于直读）：
//   hooks          pre.runs / pre.denied / pre.unavailable / post.runs / post.unavailable
//   intentPrewarm  runs（有意图）/ noIntent / nativeCovered / targets / connected / toolsAdded / misses
//   skills         requested / loaded / missed
//   mcpSession     excluded（本会话移出的连接器被剔除的工具定义数）

'use strict';

function createGovernanceStats() {
  const buckets = new Map(); // bucket → Map<key, number>

  /** 累加一个计数。bucket/key 缺省安全（空 key 直接忽略，避免污染快照）。 */
  function incr(bucket, key, n = 1) {
    const b = String(bucket || 'default');
    const k = String(key || '');
    if (!k) return;
    let m = buckets.get(b);
    if (!m) { m = new Map(); buckets.set(b, m); }
    const d = Number.isFinite(n) ? n : 1;
    m.set(k, (m.get(k) || 0) + d);
  }

  /** 快照当前全部计数（深拷贝，调用方改不动内部态）。 */
  function snapshot() {
    const out = {};
    for (const [b, m] of buckets) out[b] = Object.fromEntries(m);
    return out;
  }

  function reset() { buckets.clear(); }

  return { incr, snapshot, reset };
}

// 进程内单例：主进程各模块共享同一计数器（toolHooks / agentRunner / skills）。
const governanceStats = createGovernanceStats();

module.exports = { createGovernanceStats, governanceStats };
