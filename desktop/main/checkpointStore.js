// Agent 任务断点持久化（Phase 3-1：预算中断 = 暂停，不是失败）
// 背景：长任务 token 预算触顶熔断后，用户发「继续」只能靠重放全部历史消息恢复——
// 重进线程/重启应用后断点信息（做到哪一步、待办是什么）完全丢失。
// 设计：按会话 threadKey 保存最近一次熔断断点（结构化摘要 + 用量 + 元数据）到
// userData/agent-checkpoints.json；渲染层发「继续」时取回断点注入运行上下文，
// 成功启动即清除——断点是「一次性恢复垫脚石」，不累积。
// 容量：最多保留 50 个会话的断点（LRU 淘汰）。
//
// P1-15 修复（2026-10-17）两处：
//   ① 写改原子写（tmp+fsync+rename，复用 main/data/durableWrite.js 单一事实来源）——
//      原裸 writeFileSync 写一半崩溃即截断文件，下次启动全部断点读不出；
//   ② 损坏 fail-closed——原实现 catch 后一律「视为空」：断点全部静默消失，
//      且随后任何一次 save 都会把损坏文件覆盖成单条目，证据与数据双失。
//      现：损坏文件先留 .corrupt-<ts> 副本（可恢复），错误态经 getLoadError()
//      可查询（UI/诊断可见），控制台留可行动告警；之后的新保存才允许覆盖。
const fs = require('fs');
const path = require('path');
// P1-15：原子写原语（tmp+fsync+rename）——全项目单一事实来源
const { writeFileDurableWithMode } = require('./data/durableWrite');

const MAX_ENTRIES = 50;
// B-18 收口（2026-10-21）：成员会话断点（`agent:{memberId}`）需要**跨 run 稳定保留**，
// 但原先与普通会话断点共用同一个 50 条 LRU —— 活跃用户很容易把成员断点挤出去，
// 于是「跨 run 复用」只是概率性成立。现在带 `pinned` 标记的条目不参与普通淘汰；
// 全部条目都 pinned 的极端情况下才淘汰最旧的 pinned（仍然有界）。
const MAX_PINNED_ENTRIES = 200;

let file = null; // userData/agent-checkpoints.json
let loadError = null; // P1-15：最近一次加载损坏的错误态（null = 正常；UI/诊断可查询）

function initCheckpointStore(userDataPath) {
  file = userDataPath
    ? `${userDataPath}/agent-checkpoints.json`.replace(/\/+/g, '/')
    : null;
  loadError = null;
}

// P1-15：查询断点存储的加载错误态（损坏时非 null，含备份路径与原因）。
// 返回 { file, backup, reason, at }；未损坏返回 null。
function getLoadError() {
  return loadError;
}

function loadAll() {
  if (!file) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    loadError = null; // 加载成功即清除错误态（用户可能已从备份恢复）
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    // P0-8（2026-10-28）：ENOENT = 文件尚不存在（全新安装 / 首次保存），**不是损坏**。
    // 此前一律按损坏处理 ⇒ 新用户第一次存断点就会打 ERROR、getLoadError() 返回非 null，
    // 诊断页/UI 据此显示「断点存储损坏」—— 纯假告警，用户会以为数据出了问题。
    // 只有「文件存在但读不出 / JSON 解析失败」才是真损坏，才需要留副本 + 错误态。
    if (e && e.code === 'ENOENT') { loadError = null; return {}; }
    // P1-15：fail-closed——不静默丢弃。损坏文件留副本（可人工恢复），错误态可查询，
    // 控制台给可行动指引；返回空 map 让调用方不崩溃，但「丢失」这件事不再无声。
    let backup = null;
    try {
      backup = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, backup);
    } catch (e2) {
      backup = null;
      console.warn('[checkpoint] 损坏文件备份失败:', e2.message);
    }
    const reason = String(e?.message || e);
    loadError = { file, backup, reason, at: new Date().toISOString() };
    console.error(
      `[checkpoint] 断点存储损坏：${reason}。已保留副本 ${backup || '（备份失败）'}，`
      + `可手动恢复后重启；本次按无断点处理（不静默丢弃）。`,
    );
    return {};
  }
}

function saveAll(map) {
  if (!file) return false;
  // P1-15：原子写（tmp+fsync+rename + 0600）——断点含任务摘要，权限收紧不组/众可读
  const res = writeFileDurableWithMode(file, JSON.stringify(map, null, 2), 0o600);
  if (!res.ok) {
    console.warn('[checkpoint] 断点保存失败:', res.error);
    return false;
  }
  if (!res.modeApplied) {
    console.warn('[checkpoint] 断点文件权限收紧失败（0600 未生效）:', res.error || 'chmod 失败');
  }
  return true;
}

// 保存断点；返回是否成功。同 threadKey 重复熔断时覆盖（只留最近一次）。
// opts.pinned=true：成员会话断点，普通 LRU 淘汰会跳过它（B-18）。
function saveCheckpoint(threadKey, data, opts = {}) {
  const key = String(threadKey || 'local');
  const map = loadAll();
  const pinned = opts && opts.pinned === true;
  // LRU 淘汰：**非 pinned** 条目达到 50 条时淘汰最早的一条；pinned 条目单独受 MAX_PINNED_ENTRIES 约束。
  const keys = Object.keys(map);
  const unpinned = keys.filter((k) => !map[k] || map[k].pinned !== true);
  if (!map[key] && unpinned.length >= MAX_ENTRIES) {
    // P0-8 附带：按 savedAt 淘汰**真正的**「最久未更新」。此前直接取 unpinned[0]，那是
    // Object.keys 的**插入顺序**——长期活跃但创建得早的会话会先被淘汰，而刚建的一次性会话
    // 反而保留，与「LRU」的语义相反（本函数注释一直写着 LRU，实现却是 FIFO）。
    unpinned.sort((a, b) => Number(map[a]?.savedAt || 0) - Number(map[b]?.savedAt || 0));
    delete map[unpinned[0]];
  }
  map[key] = { ...data, ...(pinned ? { pinned: true } : {}), savedAt: Date.now() };
  // pinned 子集自身的上限（防止成员数量失控时文件无限膨胀）
  const pinnedKeys = Object.keys(map).filter((k) => map[k] && map[k].pinned === true);
  if (pinnedKeys.length > MAX_PINNED_ENTRIES) {
    pinnedKeys
      .sort((a, b) => Number(map[a].savedAt || 0) - Number(map[b].savedAt || 0))
      .slice(0, pinnedKeys.length - MAX_PINNED_ENTRIES)
      .forEach((k) => { delete map[k]; });
  }
  return saveAll(map);
}

function getCheckpoint(threadKey) {
  return loadAll()[String(threadKey || 'local')] || null;
}

function clearCheckpoint(threadKey) {
  const key = String(threadKey || 'local');
  const map = loadAll();
  if (!(key in map)) return false;
  delete map[key];
  saveAll(map);
  return true;
}

module.exports = {
  initCheckpointStore, saveCheckpoint, getCheckpoint, clearCheckpoint, getLoadError, MAX_ENTRIES,
};
