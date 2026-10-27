// 本地知识库 IPC（设计文档 §8 / §8.7）
//
// 域边界：查询口径全在 ../knowledgeBaseQuery；本模块只管通道、文件对话框、审计。
// 安全约束（§8.7）：
//   · 渲染进程**不传入文件路径**——目标路径由主进程系统对话框给出（不可传任意目录批量读取）；
//   · 渲染进程不直接开库、不接任意 SQL；
//   · 删除只清索引/授权/原文件副本，**绝不删除用户原始文件**；审计只记条数与结果。
'use strict';

const path = require('path');
const { ipcMain, dialog, app } = require('electron');
const kb = require('../knowledgeBaseQuery');

let deps = null;
/** 进行中的导入任务（jobId → {canceled}）。只在本进程内有效：导入本来就是「当前窗口这次操作」。 */
const jobs = new Map();
function getDb() {
  return deps?.getDb?.() || null;
}
/**
 * 特性开关（§17.2）：知识能力默认关闭，直到运行期注入与性能验收都过了再改默认值。
 *
 * 判定放在**每个通道入口**而不是「注册时跳过注册」：
 *   · 不注册 ⇒ 渲染层拿到的是 `No handler registered`，与「通道名写错/版本不匹配」同形，
 *     排查时无法区分「功能被关」和「接线断了」；
 *   · 显式返回 `FEATURE_DISABLED` ⇒ 界面能给出确定的原因，日志也能对上。
 * 只读的 `knowledge:capabilities` 例外：它必须始终可答，否则界面无法知道「是被关了」还是「坏了」。
 */
function enabled() {
  const f = deps?.getFlags ? deps.getFlags() : null;
  return !!(f && f.knowledge);
}
function disabled() {
  return { ok: false, code: 'FEATURE_DISABLED', error: '知识库能力未启用（MJCODE_FEATURES={"knowledge":true} 可开启）' };
}
function storageDir() {
  return path.join(app.getPath('userData'), 'kb-storage');
}
function actorOf() {
  // 首里程碑：本地单 owner。多角色/凭据批次在 M4 LAN 引入 actorAuthzEpoch 递增。
  return deps?.getActor?.() || 'owner';
}

function register() {
  ipcMain.handle('knowledge:capabilities', async () => ({
    ok: true,
    // enabled 必须始终可答：界面据此区分「功能被关」与「子系统坏了」。
    // 关着时仍然返回 supportedExtensions 等静态能力描述（离线可算，不读库）。
    capabilities: { ...kb.capabilities(), enabled: enabled() },
  }));

  // 导入（§8.4）：多选逐项导入 + 阶段进度 + 可取消。
  // 进度经 `knowledge:import-progress` 推给发起方窗口（每阶段一次，不刷屏）；
  // 取消只撤「本次未提交的资产」，不动用户原文件，也不回滚别条目的成功结果。
  ipcMain.handle('knowledge:import', async (event, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE', error: '知识库子系统不可用' };
    const projectId = payload.projectId || null;
    const workspaceId = payload.workspaceId || '';
    const caps = kb.capabilities();
    const res = await dialog.showOpenDialog({
      title: '导入知识文档',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文档', extensions: caps.supportedExtensions.map((e) => e.replace(/^\./, '')) }],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) return { ok: false, code: 'CANCELED' };

    const jobId = `kbi_${Date.now().toString(36)}`;
    const job = { canceled: false };
    jobs.set(jobId, job);
    const send = (msg) => {
      try { event?.sender?.send?.('knowledge:import-progress', { jobId, ...msg }); } catch { /* 窗口已关：不影响导入 */ }
    };
    const results = [];
    try {
      for (const filePath of res.filePaths) {
        if (job.canceled) { results.push({ file: path.basename(filePath), ok: false, code: 'CANCELED' }); continue; }
        send({ file: path.basename(filePath), stage: 'parsing' });
        // 多文件故意串行：并发会同时压 sql.js 事务，反而更慢，也难以逐项取消
        const r = await kb.importDocument({
          db, storageDir: storageDir(), workspaceId, projectId, filePath, actorId: actorOf(),
          onStage: (stage) => send({ file: path.basename(filePath), stage }),
          shouldCancel: () => job.canceled,
        });
        if (r.ok) deps?.audit?.('knowledge:import', { sourceId: r.sourceId, projectId, chunks: r.chunks });
        results.push({ file: path.basename(filePath), ...r });
      }
    } finally {
      jobs.delete(jobId);
    }
    const okCount = results.filter((r) => r.ok).length;
    return {
      ok: okCount > 0,
      jobId,
      // 一个失败不吞掉其他成功项：逐项结果原样带回，由界面逐行显示
      results,
      imported: okCount,
      failed: results.length - okCount,
    };
  });

  ipcMain.handle('knowledge:cancel-import', async (_e, payload = {}) => {
    const job = jobs.get(payload.jobId);
    if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };
    job.canceled = true;
    return { ok: true };
  });

  ipcMain.handle('knowledge:list', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    return kb.listSources({
      db, scope: payload.scope || 'project', projectId: payload.projectId || null,
      status: payload.status || 'ready', limit: payload.limit || 50, offset: payload.offset || 0,
    });
  });

  ipcMain.handle('knowledge:search', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    return kb.search({
      db, projectId: payload.projectId || null, actorId: actorOf(),
      query: payload.query || '', limit: payload.limit || 20, scope: payload.scope || 'project',
    });
  });

  ipcMain.handle('knowledge:authorize', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    if (!payload.sourceId || !payload.projectId) return { ok: false, code: 'INVALID_ARGS' };
    const r = kb.authorize({ db, sourceId: payload.sourceId, projectId: payload.projectId, actorId: actorOf() });
    if (r.ok) deps?.audit?.('knowledge:authorize', { sourceId: payload.sourceId, projectId: payload.projectId });
    return r;
  });

  ipcMain.handle('knowledge:deauthorize', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    if (!payload.sourceId || !payload.projectId) return { ok: false, code: 'INVALID_ARGS' };
    const r = kb.deauthorize({ db, sourceId: payload.sourceId, projectId: payload.projectId });
    if (r.ok) deps?.audit?.('knowledge:deauthorize', { sourceId: payload.sourceId, projectId: payload.projectId });
    return r;
  });

  ipcMain.handle('knowledge:delete', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    if (!payload.sourceId) return { ok: false, code: 'INVALID_ARGS' };
    const r = kb.deleteSource({ db, sourceId: payload.sourceId });
    if (r.ok && r.deleted) deps?.audit?.('knowledge:delete', { sourceId: payload.sourceId });
    return r;
  });

  ipcMain.handle('knowledge:preview-context', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    return kb.buildContextPlan({
      db, projectId: payload.projectId, actorId: actorOf(),
      sourceIds: payload.sourceIds || [], chunkIds: payload.chunkIds || [],
      query: payload.query || null, exclusions: payload.exclusions || [], budgetTokens: payload.budgetTokens || 4000,
    });
  });

  ipcMain.handle('knowledge:validate-context', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    return kb.validateContextPlanForRun({
      db, planId: payload.planId, planHash: payload.planHash, actorId: actorOf(),
    });
  });

  // 「查看引用」：按 planId 回读快照里的引用清单（不依赖运行是否还在）。
  // 有意不暴露「注入正文」：正文只应进入模型上下文，渲染层要正文请走搜索结果（带转义）。
  ipcMain.handle('knowledge:plan-citations', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    if (!payload.planId) return { ok: false, code: 'INVALID_ARGS' };
    return kb.listPlanCitations({ db, planId: String(payload.planId) });
  });

  // 快照清理：只删「又老又没被任何运行引用过」的快照（§8.4 的配套保留策略）
  ipcMain.handle('knowledge:prune-plans', async (_e, payload = {}) => {
    if (!enabled()) return disabled();
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    const days = Number(payload.olderThanDays);
    const r = kb.pruneContextPlans({
      db, olderThanMs: Number.isFinite(days) && days > 0 ? days * 24 * 3600 * 1000 : undefined,
    });
    if (r.ok && r.deleted) deps?.audit?.('knowledge:prune-plans', { deleted: r.deleted });
    return r;
  });
}

function initKnowledgeIpc(d) {
  deps = d;
  register();
}

module.exports = { initKnowledgeIpc };
