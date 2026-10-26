// DS Bots / T6-2：项目空间 IPC 域（projects:*）——create / list / get / updateStatus。
//
// 边界（设计稿 §3 L5 / §4.1）：
//   · 本域只管「项目身份」，不建配额桶（T6-3）、不建工件（T6-5）——初始化编排在 T6-9 的链路里，
//     避免同一件事在两处各写一套默认值；
//   · thread 唯一约束由库兜底，Store 把异常翻译成 code=THREAD_TAKEN，本层只透传不重复判断；
//   · 所有写通道先过 payloadGuard，防止 `[object Object]` 这类值直接落库。
const { app, ipcMain } = require('electron');
const guard = require('./payloadGuard');
const workspace = require('../workspace');
const { ProjectError, PROJECT_CATEGORIES, PROJECT_STATUSES } = require('../projectStore');
const { initProjectSpace, TEAM_TEMPLATES } = require('../projectSpaceInit');

let deps = null;

function fail(err) {
  const code = err instanceof ProjectError ? err.code : (err && err.code) || null;
  // T6-9：初始化链路的校验错误带 field，渲染层据此把红字定位到具体输入框
  return { ok: false, error: (err && err.message) || '项目操作失败', code, field: (err && err.field) || null };
}

function initProjectsIpc(injected) {
  deps = injected || {};
  registerHandlers();
}

function registerHandlers() {
  ipcMain.handle('projects:create', async (_, payload = {}) => {
    const store = deps.getProjectStore?.();
    if (!store) return { ok: false, error: '项目子系统不可用（初始化失败）', code: 'UNAVAILABLE' };
    try {
      guard.assertStrings(payload, {
        name: 200,
        objective: { max: 4000 },
        category: { max: 32, optional: true, allowEmpty: true },
        cwd: { max: 2048, optional: true, allowEmpty: true },
        threadId: { max: 128, optional: true, allowEmpty: true },
        teamId: { max: 128, optional: true, allowEmpty: true },
      });
      if (payload.category && !PROJECT_CATEGORIES.includes(payload.category)) {
        return { ok: false, error: '项目类型非法', code: 'INVALID_CATEGORY' };
      }
      const project = store.createProject({
        name: payload.name,
        objective: payload.objective,
        category: payload.category || 'custom',
        cwd: payload.cwd || '',
        threadId: payload.threadId || '',
        teamId: payload.teamId || '',
      });
      deps.audit?.('project_create', project.projectId, `name=${project.name}`);
      return { ok: true, project };
    } catch (err) {
      return fail(err);
    }
  });

  // DS Bots / T6-9：完整初始化（§11.3 七步 + 失败补偿）。
  // 与 projects:create 的区别：create 只写项目身份（低层原语）；createSpace 是用户点「创建项目」
  // 的完整链路，会一并建工件 / 配额桶 / 会话 / 团队并写首条系统消息。
  ipcMain.handle('projects:createSpace', async (_, payload = {}) => {
    const projectStore = deps.getProjectStore?.();
    const artifactStore = deps.getArtifactStore?.();
    const quotaLedger = deps.getQuotaLedger?.();
    const teamStore = deps.getTeamStore?.();
    const localStore = deps.getLocalStore?.();
    if (!projectStore || !artifactStore || !quotaLedger || !teamStore || !localStore) {
      return { ok: false, error: '项目空间子系统不可用（初始化失败）', code: 'UNAVAILABLE' };
    }
    try {
      // 只校验「形状与硬上限」，业务边界（长度/区间/枚举）由 projectSpaceInit.normalizeSpec 单点判定，
      // 避免两层各写一套阈值导致口径漂移。
      guard.assertStrings(payload, {
        name: 40,
        category: 32,
        objective: { max: 2000 },
        cwd: { max: 2048, optional: true, allowEmpty: true },
        teamMode: { max: 16, optional: true, allowEmpty: true },
        teamTemplate: { max: 32, optional: true, allowEmpty: true },
        teamId: { max: 128, optional: true, allowEmpty: true },
        quotaTier: { max: 16, optional: true, allowEmpty: true },
        artifactKind: { max: 16, optional: true, allowEmpty: true },
        snapshotPolicy: { max: 16, optional: true, allowEmpty: true },
      });
      // §11.1「留空 = 自建目录」：此前留空会把 cwd 落成 ''，项目空间挂不上任何工作目录，
      // 团队派活只能退回团队旧目录或干脆无工作区（真机上表现为「跑完了但什么都不产出」）。
      // 这里在初始化前先把目录建出来再传下去，建不出来就明确失败，不静默落空 cwd。
      let spec = payload;
      if (!String(payload.cwd || '').trim()) {
        const dir = await workspace.createProject({
          docsDir: app.getPath('documents'), homeDir: app.getPath('home'),
        });
        spec = { ...payload, cwd: dir.path };
      }
      const result = initProjectSpace(spec, { projectStore, artifactStore, quotaLedger, teamStore, localStore });
      deps.audit?.('project_create', result.project.projectId, `name=${result.project.name}`);
      return { ok: true, ...result };
    } catch (err) {
      return fail(err);
    }
  });

  // DS Bots / T6-9：模板角色投影（只读）。
  // 为什么走 IPC 而不是在渲染层再写一份：模板角色由 projectSpaceInit 单点定义，
  // 渲染层另存一份必然与「实际创建的编制」漂移（用户看到的角色 ≠ 落库的角色）。
  // 只下发 name / roleKind，**不下发 systemPrompt**——人格提示词属主进程数据，没必要进渲染层。
  ipcMain.handle('projects:roleTemplates', async () => {
    const templates = {};
    for (const [key, tpl] of Object.entries(TEAM_TEMPLATES)) {
      templates[key] = {
        name: tpl.name,
        roles: (tpl.roles || []).map((r) => ({ name: r.name, roleKind: r.roleKind })),
      };
    }
    return { ok: true, templates };
  });

  ipcMain.handle('projects:list', async (_, payload = {}) => {
    const store = deps.getProjectStore?.();
    if (!store) return { ok: false, error: '项目子系统不可用（初始化失败）', code: 'UNAVAILABLE', projects: [] };
    try {
      const status = payload.status ? String(payload.status) : '';
      if (status && !PROJECT_STATUSES.includes(status)) {
        return { ok: false, error: '项目状态非法', code: 'INVALID_STATUS', projects: [] };
      }
      return { ok: true, projects: store.listProjects({ status, limit: payload.limit }) };
    } catch (err) {
      return { ...fail(err), projects: [] };
    }
  });

  ipcMain.handle('projects:get', async (_, payload = {}) => {
    const store = deps.getProjectStore?.();
    if (!store) return { ok: false, error: '项目子系统不可用（初始化失败）', code: 'UNAVAILABLE' };
    try {
      // 二选一定位：projectId 直取；threadId 反查（跨天回到同一会话时的唯一入口）
      const byId = String(payload.projectId || '').trim();
      const byThread = String(payload.threadId || '').trim();
      if (!byId && !byThread) return { ok: false, error: '缺少 projectId 或 threadId', code: 'NOT_FOUND' };
      const project = byId ? store.getProject(byId) : store.getProjectByThread(byThread);
      if (!project) return { ok: false, error: '项目不存在', code: 'NOT_FOUND' };
      return { ok: true, project };
    } catch (err) {
      return fail(err);
    }
  });

  // DS Bots / T6-10：配额水位只读快照（运行卡徽标 / 侧面板）。
  // 判定口径仍只在 quotaLedger.state 一处（§3 I1），本通道只做「会话 → 项目」定位与投影，
  // 不重复计算 available/util，也不改任何状态。
  ipcMain.handle('projects:quota', async (_, payload = {}) => {
    const store = deps.getProjectStore?.();
    const ledger = deps.getQuotaLedger?.();
    if (!store || !ledger) return { ok: false, error: '项目子系统不可用（初始化失败）', code: 'UNAVAILABLE', quota: null };
    try {
      const byId = String(payload.projectId || '').trim();
      const byThread = String(payload.threadId || '').trim();
      if (!byId && !byThread) return { ok: false, error: '缺少 projectId 或 threadId', code: 'NOT_FOUND', quota: null };
      const project = byId ? store.getProject(byId) : store.getProjectByThread(byThread);
      // 未绑定项目的普通会话是常态，不是错误：quota=null 让徽标自己消失。
      if (!project) return { ok: true, quota: null };
      const st = ledger.state(project.projectId);
      const b = st.bucket;
      return {
        ok: true,
        quota: {
          state: st.state,
          used: st.used,
          available: st.available,
          util: st.util,
          totalLimit: b ? b.totalLimit : 0,
          windowSeconds: b ? b.windowSeconds : 0,
          resumeMinTokens: b ? b.resumeMinTokens : 0,
          tier: b ? b.tier : 'standard',
        },
      };
    } catch (err) {
      return { ...fail(err), quota: null };
    }
  });

  // 账本（2026-10-27）：窗口内**按成员聚合**的真实 token 消耗，供「用量账本」页渲染。
  // 与 projects:quota 同源（同一 QuotaLedger、同一 projectId 口径），只读取 quota_consumptions，
  // 不改任何状态；无记录时返回空数组，前端据此整块卸载（不画空表、不编造数字）。
  // ⚠ 口径纪律：这是 **token 消耗**，不是金额。全仓无价格/汇率数据，本通道**不折算**成钱。
  ipcMain.handle('projects:quotaLedger', async (_, payload = {}) => {
    const store = deps.getProjectStore?.();
    const ledger = deps.getQuotaLedger?.();
    if (!store || !ledger) return { ok: false, error: '项目子系统不可用（初始化失败）', code: 'UNAVAILABLE', rows: [] };
    try {
      const byId = String(payload.projectId || '').trim();
      const byThread = String(payload.threadId || '').trim();
      if (!byId && !byThread) return { ok: false, error: '缺少 projectId 或 threadId', code: 'NOT_FOUND', rows: [] };
      const project = byId ? store.getProject(byId) : store.getProjectByThread(byThread);
      // 未绑定项目的普通会话是常态，不是错误：rows=[] 让账本自己消失。
      if (!project) return { ok: true, rows: [] };
      const windowMs = Number(payload.windowMs) > 0 ? Number(payload.windowMs) : undefined;
      const rows = ledger.ledgerByMember(project.projectId, windowMs);
      return { ok: true, rows };
    } catch (err) {
      return { ...fail(err), rows: [] };
    }
  });

  ipcMain.handle('projects:updateStatus', async (_, payload = {}) => {
    const store = deps.getProjectStore?.();
    if (!store) return { ok: false, error: '项目子系统不可用（初始化失败）', code: 'UNAVAILABLE' };
    try {
      guard.assertStrings(payload, { projectId: 128, status: 32 });
      const project = store.updateProjectStatus(payload.projectId, payload.status);
      deps.audit?.('project_status', project.projectId, `status=${project.status}`);
      return { ok: true, project };
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { initProjectsIpc };
