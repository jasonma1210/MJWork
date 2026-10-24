// DS Bots / T6-10：工件只读 IPC 域（artifacts:*）。
//
// 边界（设计稿 §12.1 / §14）：
//   · 本域**只读**：创建走 projects:createSpace 的初始化链路（T6-9），写入只允许模型经
//     `artifact_patch_section` 原生工具（T6-6 的审批/审计/体积闸），渲染层没有写通道；
//   · 越权读取（§14）：传了 projectId 就必须与工件归属一致，禁止拿任意 artifactId 读他人项目；
//   · 正文只按「单章节 + 分页」下发（getSection 已有 8000 字符硬上限），
//     面板不做全文拉取——否则 2MB 工件会一次性穿过 IPC，把主进程和渲染层一起拖慢。
const { ipcMain } = require('electron');
const guard = require('./payloadGuard');
// P0-2：把工件库解析器发布给「工件 → 产物桥」（main/tools/artifactProduct.js）。
// 为什么在这里发布：main.js 是本轮冻结文件（max-lines 余量为 0），而本域已由 main.js 注入
// getArtifactStore —— 复用同一个 getter，不新建存储实例、不引入第二条装配路径。
const artifactProduct = require('../tools/artifactProduct');

let deps = null;

function initArtifactsIpc(injected) {
  deps = injected || {};
  artifactProduct.setArtifactStoreProvider(() => deps.getArtifactStore?.());
  registerHandlers();
}

function fail(err) {
  return { ok: false, error: (err && err.message) || '工件读取失败', code: (err && err.code) || null };
}

/** 由 projectId / threadId 二选一定位项目（与 projects:get 同口径）。 */
function resolveProject(payload = {}) {
  const store = deps.getProjectStore?.();
  if (!store) return null;
  const byId = String(payload.projectId || '').trim();
  const byThread = String(payload.threadId || '').trim();
  if (byId) return store.getProject(byId);
  if (byThread) return store.getProjectByThread(byThread);
  return null;
}

function registerHandlers() {
  // 会话 → 项目 → 工件清单。面板首屏只调这一条，避免「先 projects:get 再 artifacts:list」的两次往返。
  ipcMain.handle('artifacts:forProject', async (_, payload = {}) => {
    const artifactStore = deps.getArtifactStore?.();
    if (!artifactStore) return { ok: false, error: '工件子系统不可用（初始化失败）', code: 'UNAVAILABLE', artifacts: [] };
    try {
      const project = resolveProject(payload);
      if (!project) {
        // 区分两种「拿不到项目」，因为处置完全不同（真机反馈：未绑定项目的会话里
        // 面板/工具只看到「项目不存在」，用户以为是数据坏了、去查库）：
        //   · 没传/没绑定  ⇒ 配置缺失，可引导（先在左侧选择或创建项目）
        //   · 传了 id 却查不到 ⇒ 数据不一致，需要排查（项目被删/库回滚）
        // 两者用不同 code，调用方与日志能分开统计。
        const byId = String(payload.projectId || '').trim();
        const byThread = String(payload.threadId || '').trim();
        if (!byId && !byThread) {
          return { ok: false, error: '当前会话未绑定项目（先在左侧选择或创建一个项目）', code: 'NO_PROJECT', artifacts: [] };
        }
        return {
          ok: false,
          error: byId ? '项目不存在（该 id 在项目库里查不到）' : '该会话尚未绑定项目',
          code: 'NOT_FOUND',
          artifacts: [],
        };
      }
      const artifacts = artifactStore.listArtifacts(project.projectId).map((a) => ({
        artifactId: a.artifactId,
        projectId: a.projectId,
        kind: a.kind,
        title: a.title,
        currentVersion: a.currentVersion,
        snapshotPolicy: a.snapshotPolicy,
        sizeBytes: a.sizeBytes,
        updatedAt: a.updatedAt,
      }));
      return { ok: true, project: { projectId: project.projectId, name: project.name, objective: project.objective, status: project.status }, artifacts };
    } catch (err) {
      return { ...fail(err), artifacts: [] };
    }
  });

  ipcMain.handle('artifacts:index', async (_, payload = {}) => {
    const artifactStore = deps.getArtifactStore?.();
    if (!artifactStore) return { ok: false, error: '工件子系统不可用（初始化失败）', code: 'UNAVAILABLE' };
    try {
      guard.assertStrings(payload, { artifactId: 128, projectId: { max: 128, optional: true, allowEmpty: true } });
      const art = artifactStore.getArtifact(payload.artifactId);
      if (!art) return { ok: false, error: '工件不存在', code: 'NOT_FOUND' };
      if (payload.projectId && String(payload.projectId).trim() !== art.projectId) {
        return { ok: false, error: '工件不属于该项目', code: 'FORBIDDEN' };
      }
      return { ok: true, index: artifactStore.getIndex({ artifactId: art.artifactId, recentLimit: 5 }) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('artifacts:section', async (_, payload = {}) => {
    const artifactStore = deps.getArtifactStore?.();
    if (!artifactStore) return { ok: false, error: '工件子系统不可用（初始化失败）', code: 'UNAVAILABLE' };
    try {
      guard.assertStrings(payload, {
        artifactId: 128,
        sectionKey: 200,
        // version 缺省 = 当前版本；给值即按「version ≤ Vn 的最新历史行」只读回放
        version: { max: 16, optional: true, allowEmpty: true },
        projectId: { max: 128, optional: true, allowEmpty: true },
      });
      const art = artifactStore.getArtifact(payload.artifactId);
      if (!art) return { ok: false, error: '工件不存在', code: 'NOT_FOUND' };
      if (payload.projectId && String(payload.projectId).trim() !== art.projectId) {
        return { ok: false, error: '工件不属于该项目', code: 'FORBIDDEN' };
      }
      return {
        ok: true,
        section: artifactStore.getSection({
          artifactId: art.artifactId,
          sectionKey: payload.sectionKey,
          version: payload.version || undefined,
          offset: payload.offset,
          maxChars: payload.maxChars,
        }),
      };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('artifacts:versions', async (_, payload = {}) => {
    const artifactStore = deps.getArtifactStore?.();
    if (!artifactStore) return { ok: false, error: '工件子系统不可用（初始化失败）', code: 'UNAVAILABLE', versions: [] };
    try {
      guard.assertStrings(payload, { artifactId: 128, projectId: { max: 128, optional: true, allowEmpty: true } });
      return { ok: true, ...artifactStore.listVersions({ artifactId: payload.artifactId, limit: payload.limit }) };
    } catch (err) {
      return { ...fail(err), versions: [] };
    }
  });
}

module.exports = { initArtifactsIpc };
