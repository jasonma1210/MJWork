// 工具长输出落盘目录的宿主侧管理（第八轮 B-13，2026-10-21）
//
// ── 为什么需要主进程这一层 ───────────────────────────────────────────────────
//   引擎（agent-core）把超长工具输出折叠成「头 + 尾 + 原文落盘路径」，原文路径随后交给
//   模型用 read_file 按需取回。这个机制**成立的前提**是「路径在会话生命周期内一直可读」。
//   改前目录固定为 `${TMPDIR}/mjcode-tool-outputs`，两个后果：
//     ① 系统会清理 `$TMPDIR`（macOS 周期性清理、重启即空）⇒ 会话中途路径变 ENOENT，
//        模型拿到一句「完整原文已落盘」却读不到，且无从判断是「本来没有」还是「已经没了」；
//     ② 长会话反复落盘、从不删除 ⇒ 反向的磁盘泄漏。
//
//   `main/bigPayload.js` 早已用「userData 下自建目录 + 启动清残留 + 终态释放」解决了同族问题，
//   本模块沿用同一套纪律，只是保留策略按「会话可回溯」放宽（工具输出比大消息句柄有用，
//   用户可能几小时后回来问「刚才那个测试输出里第 300 行是什么」）。
//
// ── 保留策略（为什么要 TTL 而不是「run 结束即删」）───────────────────────────
//   · run 结束即删会让「跑完立刻追问细节」也读不到，收益（省几百 KB）远小于代价；
//   · 无限保留会让目录随使用时长单调增长，且没有上限可断言；
//   · 折中：**按文件 mtime 保留 24 小时**（可用 `MJCODE_TOOL_OUTPUT_TTL_H` 覆盖），
//     启动扫一次 + 每 30 分钟扫一次。于是「同一天内的会话一定可回溯」是硬保证，
//     「很久以前」的输出按时间自然回收——两个方向都有确定判据，也都能被测。
//
// ── 目录注入方式 ────────────────────────────────────────────────────────────
//   `initToolOutputs` 把目录写进 `process.env.MJCODE_TOOL_OUTPUT_DIR`。引擎读这个环境变量，
//   而引擎的**子进程**天然继承父进程环境 ⇒ in-process 与子进程两条路径同值，
//   不必在 engineParams 里新增参数（多一个参数就多一处可能失配的序列化接缝）。
'use strict';

const fs = require('fs');
const path = require('path');

/** 引擎读取落盘目录的环境变量名（与 agent-core 的 TOOL_OUTPUT_DIR_ENV 必须一致）。 */
const DIR_ENV = 'MJCODE_TOOL_OUTPUT_DIR';
/** 默认保留时长：24 小时（覆盖「同一天内回来追问」这一真实场景）。 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 清扫周期：30 分钟（比保留期小两个数量级，保证过期文件不会长期滞留）。 */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

let dir = null;
let sweepTimer = null;

/** 保留时长：环境变量按「小时」覆盖，非法值一律回落默认（配置写错不能让清理停摆）。 */
function ttlMs(env = process.env) {
  const h = Number(env.MJCODE_TOOL_OUTPUT_TTL_H);
  if (!Number.isFinite(h) || h <= 0) return DEFAULT_TTL_MS;
  // 上限 30 天：再长就没有「自动回收」的意义了，不如显式关掉清理
  return Math.min(h, 720) * 60 * 60 * 1000;
}

/**
 * 初始化：确定目录、注入环境变量、启动清扫。
 * @param {{dataDir?: string, now?: () => number, env?: Record<string,string>}} [opts]
 * @returns {{dir: string, removed: number}}
 */
function initToolOutputs({ dataDir, now = Date.now, env = process.env } = {}) {
  if (!dataDir) throw new Error('initToolOutputs 需要 dataDir（app.getPath("userData")）');
  dir = path.join(dataDir, 'tool-outputs');
  fs.mkdirSync(dir, { recursive: true });
  // 注入给引擎（in-process 与子进程同值，见文件头）
  env[DIR_ENV] = dir;
  const removed = prune({ now, env });
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      try { prune({ env }); } catch (e) { console.warn('[toolOutputs] 过期清理失败:', e?.message || e); }
    }, SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();
  }
  return { dir, removed };
}

/**
 * 清理过期文件（按 mtime）。返回删除条数。
 *
 * 只删本模块目录下的普通文件：目录不存在/不可读一律返回 0、不抛错——
 * 这是**维护性**动作，绝不能因为它失败把启动或运行拖垮。
 * 但「返回 0」不等于「值得静默」：清理长期失败 ⇒ 目录只增不减（磁盘/配额慢性耗尽）。
 * 故目录读不到时 warn 留痕（清扫 30 分钟一轮，长期失败最多 48 行/天，不会刷屏；单文件级失败仍静默跳过）。
 */
function prune({ now = Date.now, env = process.env } = {}) {
  if (!dir) return 0;
  const cutoff = now() - ttlMs(env);
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { console.warn('[toolOutputs] 过期清理读不到目录，本轮跳过（积压不会自愈）：', dir, e?.message || e); return 0; }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs > cutoff) continue;
      fs.rmSync(full, { force: true });
      removed += 1;
    } catch { /* 单个文件读不到/已被清理：跳过，不影响其它文件 */ }
  }
  if (removed) console.warn(`[toolOutputs] 已清理 ${removed} 个过期工具输出（保留期 ${Math.round(ttlMs(env) / 3600000)}h）`);
  return removed;
}

/**
 * 某会话/任务的作用域目录名（引擎只把 scope 拼进文件名，此函数供排查与测试对齐用）。
 * @param {string} scope
 */
function filePrefixOf(scope) {
  return String(scope == null ? '' : scope).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 64) || 'default';
}

/** 当前落盘目录（未初始化返回 null——调用方据此判断「本轮没有启用持久落盘」）。 */
function currentDir() { return dir; }

/** 仅供测试：停掉清扫定时器，避免进程被未清理的 timer 拖住。 */
function _shutdown() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }

module.exports = {
  initToolOutputs, prune, currentDir, filePrefixOf, ttlMs,
  DIR_ENV, DEFAULT_TTL_MS, SWEEP_INTERVAL_MS,
  _shutdown,
};
