// 桌面端功能开关（战略收敛：聚焦桌面端单点）
// 默认冻结协同 / 云端委派 / 小程序三条线（fail-closed），可用环境变量 MJCODE_FEATURES 显式恢复。
// 与服务端 config/features（MJ_CLOUD_ENABLED 等）独立：桌面端本地默认优先，服务端不可达时不影响冻结状态。
'use strict';

const DEFAULTS = Object.freeze({
  collab: false,      // 协同（Yjs 团队空间）
  cloud: false,       // 云端委派
  miniprogram: false, // 微信小程序控制面
  cua: true,          // Computer Use（桌面端能力，保留）
  ecosystem: true,    // 生态资产目录（数字员工/连接器/技能，桌面端能力，保留）
  // 2026-10-27（方法论文档 §17.2）：「新数据读取与知识能力使用独立 feature flag，
  // 默认关闭直至对应验收完成」。知识库 M3 目前**只完成到「快照可生成/可预览/可判失效」**，
  // 运行期注入与性能验收未过 → 按文档要求默认关闭，验收通过后再改默认值。
  // 打开方式：MJCODE_FEATURES='{"knowledge":true}'。
  knowledge: false,
});

// 从环境变量解析覆盖项：MJCODE_FEATURES='{"collab":true}'。
// 非法 JSON 或未知/非布尔键一律忽略（fail-closed），不抛错不阻断启动。
function loadFeatureFlags(env) {
  const flags = { ...DEFAULTS };
  const raw = String((env && env.MJCODE_FEATURES) || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of Object.keys(DEFAULTS)) {
          if (typeof parsed[key] === 'boolean') flags[key] = parsed[key];
        }
      } else {
        console.warn('[features] MJCODE_FEATURES 不是对象，已忽略并使用默认值');
      }
    } catch (e) {
      console.warn('[features] MJCODE_FEATURES 解析失败，已忽略:', e.message);
    }
  }
  return flags;
}

module.exports = { DEFAULTS, loadFeatureFlags };
