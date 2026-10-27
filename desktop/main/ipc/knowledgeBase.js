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
function getDb() {
  return deps?.getDb?.() || null;
}
function storageDir() {
  return path.join(app.getPath('userData'), 'kb-storage');
}
function actorOf() {
  // 首里程碑：本地单 owner。多角色/凭据批次在 M4 LAN 引入 actorAuthzEpoch 递增。
  return deps?.getActor?.() || 'owner';
}

function register() {
  ipcMain.handle('knowledge:capabilities', async () => ({ ok: true, capabilities: kb.capabilities() }));

  ipcMain.handle('knowledge:import', async (_e, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE', error: '知识库子系统不可用' };
    const projectId = payload.projectId || null;
    const workspaceId = payload.workspaceId || '';
    const caps = kb.capabilities();
    const res = await dialog.showOpenDialog({
      title: '导入知识文档',
      properties: ['openFile'],
      filters: [{ name: '文档', extensions: caps.supportedExtensions.map((e) => e.replace(/^\./, '')) }],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: false, code: 'CANCELED' };
    }
    const filePath = res.filePaths[0];
    const r = kb.importDocument({
      db, storageDir: storageDir(), workspaceId, projectId, filePath, actorId: actorOf(),
    });
    if (r.ok) deps?.audit?.('knowledge:import', { sourceId: r.sourceId, projectId, size: r.chunks });
    return r;
  });

  ipcMain.handle('knowledge:list', async (_e, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    return kb.listSources({
      db, scope: payload.scope || 'project', projectId: payload.projectId || null,
      status: payload.status || 'ready', limit: payload.limit || 50, offset: payload.offset || 0,
    });
  });

  ipcMain.handle('knowledge:search', async (_e, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    return kb.search({
      db, projectId: payload.projectId || null, actorId: actorOf(),
      query: payload.query || '', limit: payload.limit || 20, scope: payload.scope || 'project',
    });
  });

  ipcMain.handle('knowledge:authorize', async (_e, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    if (!payload.sourceId || !payload.projectId) return { ok: false, code: 'INVALID_ARGS' };
    const r = kb.authorize({ db, sourceId: payload.sourceId, projectId: payload.projectId, actorId: actorOf() });
    if (r.ok) deps?.audit?.('knowledge:authorize', { sourceId: payload.sourceId, projectId: payload.projectId });
    return r;
  });

  ipcMain.handle('knowledge:deauthorize', async (_e, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    if (!payload.sourceId || !payload.projectId) return { ok: false, code: 'INVALID_ARGS' };
    const r = kb.deauthorize({ db, sourceId: payload.sourceId, projectId: payload.projectId });
    if (r.ok) deps?.audit?.('knowledge:deauthorize', { sourceId: payload.sourceId, projectId: payload.projectId });
    return r;
  });

  ipcMain.handle('knowledge:delete', async (_e, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    if (!payload.sourceId) return { ok: false, code: 'INVALID_ARGS' };
    const r = kb.deleteSource({ db, sourceId: payload.sourceId });
    if (r.ok && r.deleted) deps?.audit?.('knowledge:delete', { sourceId: payload.sourceId });
    return r;
  });

  ipcMain.handle('knowledge:preview-context', async (_e, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    return kb.buildContextPlan({
      db, projectId: payload.projectId, actorId: actorOf(),
      sourceIds: payload.sourceIds || [], chunkIds: payload.chunkIds || [],
      query: payload.query || null, exclusions: payload.exclusions || [], budgetTokens: payload.budgetTokens || 4000,
    });
  });

  ipcMain.handle('knowledge:validate-context', async (_e, payload = {}) => {
    const db = getDb();
    if (!db) return { ok: false, code: 'UNAVAILABLE' };
    return kb.validateContextPlanForRun({
      db, planId: payload.planId, planHash: payload.planHash, actorId: actorOf(),
    });
  });
}

function initKnowledgeIpc(d) {
  deps = d;
  register();
}

module.exports = { initKnowledgeIpc };
