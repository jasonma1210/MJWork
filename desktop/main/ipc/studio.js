// Studio 域 IPC（2026-10-27）——项目看板与项目上下文读取。
//
// 为什么**另起模块**而不往 `ipc/teams.js` 里加：teams.js 已贴着 800 行软档
// （`test/max-lines.test.js` 的软档判据是 raw 行数），再往里塞一个 handler 就会顶破。
// 按本项目既有纪律（teamCapabilities.js / teamDispatchPlan.js 同款先例）：
// **行数告急时把实现与注册一起移出**，而不是在原地继续堆。
//
// 本域只做**只读**项目级查询，不新增写通道、不新增第二套存储：
//   · `studio:projectRuns` 复用 `shared/teamStream.mjs` 的 `assembleThreadRuns`
//     —— 与对话内团队卡**同一份投影**，不另造 UI 口径（设计文档 §2.4「不重复造状态机」）。
'use strict';

const { ipcMain } = require('electron');
const groupBudget = require('../groupBudget');

// 与 ipc/teams.js 同款：shared/ 是 ESM，主进程是 CJS，Electron 33 内嵌 Node 20.18
// 不支持稳定 `require(esm)` ⇒ 必须动态 import（静态 require 会在真机启动打挂整个域）。
let _teamStreamMod = null;
function loadTeamStream() {
  if (!_teamStreamMod) {
    _teamStreamMod = import('../../shared/teamStream.mjs').catch((e) => {
      _teamStreamMod = null; // 失败不缓存，下次再试
      throw e;
    });
  }
  return _teamStreamMod;
}

const PROJECT_RUN_LIMIT = 50;
const PROJECT_MESSAGE_LIMIT = 800;

let deps = null;

function register() {
  // ── 项目看板（Studio → board Tab 的唯一数据源）──
  //
  // 入参只收 `projectPath`：本库 `task_groups.project_path` 是建组时落的项目键，
  // 与 `teams:listThreadRuns` 走 `thread_id` 是**两条不同的归属维度**，不能互相替代——
  // 「这个 run 属于哪个会话」和「这个 run 属于哪个项目」是两个问题。
  //
  // 空 projectPath ⇒ 直接返回空数组（**不回落全局列表**）：设计文档 §6.3 明确禁止
  // 「无项目时静默读写 default」，宁可显示空态也不能把别的项目数据串进来。
  ipcMain.handle('studio:projectRuns', async (_, payload = {}) => {
    const store = deps?.getTeamStore?.();
    const taskStore = deps?.getTaskStore?.();
    if (!store || !taskStore) return { ok: false, error: '任务子系统不可用（初始化失败）', runs: [] };
    try {
      const projectPath = String(payload?.projectPath == null ? '' : payload.projectPath).trim();
      if (!projectPath) return { ok: true, runs: [], empty: 'no-project' };

      const groups = taskStore.listGroupsByProject(projectPath, { limit: PROJECT_RUN_LIMIT });
      if (!groups.length) return { ok: true, runs: [], empty: 'no-runs' };

      const groupById = new Map(groups.map((g) => [g.group_id, g]));
      const messages = store.listMessagesByRuns(groups.map((g) => g.group_id), { limit: PROJECT_MESSAGE_LIMIT });
      const events = [];
      if (typeof taskStore.listEventsByGroup === 'function') {
        for (const g of groups) {
          try { events.push(...(taskStore.listEventsByGroup(g.group_id, { limit: 200 }) || [])); }
          catch { /* 单组轨迹读取失败不影响卡片主体 */ }
        }
      }
      const { assembleThreadRuns } = await loadTeamStream();
      const runs = assembleThreadRuns({
        groups,
        messages,
        events,
        getGroup: (runId) => (groupById.has(runId) ? taskStore.getGroup(runId) : null),
        getTeam: (teamId) => store.getTeam(teamId),
        getBudgetLive: (runId) => groupBudget.snapshotOf(runId),
      });
      return { ok: true, runs, projectPath };
    } catch (err) {
      return { ok: false, error: err.message, runs: [] };
    }
  });
}

function initStudioIpc(d) {
  deps = d;
  register();
}

// deps: { getTeamStore, getTaskStore }
module.exports = { initStudioIpc };
