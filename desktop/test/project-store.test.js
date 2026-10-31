// DS Bots / T6-2 测试：项目空间仓储 + projects:* IPC
// 覆盖：必填/枚举校验、thread 唯一约束（事务回滚）、按会话反查、状态更新、IPC 信封。
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const { openDbAsync } = require('../main/db');
const { ProjectStore, PROJECT_ERRORS } = require('../main/projectStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-project-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new ProjectStore(db);

  // ── 创建与默认值 ──
  const p1 = store.createProject({ name: '微信小程序商城 V1.0', objective: '做小程序商城', category: 'prd', threadId: 'thread-1' });
  check('创建项目成功', p1 && p1.name === '微信小程序商城 V1.0' && p1.category === 'prd');
  check('默认状态 active 且 meta 为对象', p1.status === 'active' && typeof p1.meta === 'object');
  check('projectId 前缀 prj_', /^prj_/.test(p1.projectId));

  // ── 必填与枚举校验（错误码可分支）──
  let code = '';
  try { store.createProject({ objective: 'x' }); } catch (e) { code = e.code; }
  check('缺名称返回 NAME_REQUIRED', code === 'NAME_REQUIRED');
  code = '';
  try { store.createProject({ name: 'x', objective: '   ' }); } catch (e) { code = e.code; }
  check('空目标返回 OBJECTIVE_REQUIRED', code === 'OBJECTIVE_REQUIRED');
  code = '';
  try { store.createProject({ name: 'x', objective: 'y', category: 'unknown' }); } catch (e) { code = e.code; }
  check('非法类型返回 INVALID_CATEGORY', code === 'INVALID_CATEGORY');

  // ── thread 唯一约束：重复绑定被拒，且不产生半成品行（事务回滚）──
  const before = store.listProjects().length;
  code = '';
  try { store.createProject({ name: '另一个项目', objective: 'y', threadId: 'thread-1' }); } catch (e) { code = e.code; }
  check('重复 thread 返回 THREAD_TAKEN', code === 'THREAD_TAKEN');
  check('冲突后项目总数不变（无脏数据）', store.listProjects().length === before);
  check('THREAD_TAKEN 有中文文案', typeof PROJECT_ERRORS.THREAD_TAKEN === 'string' && PROJECT_ERRORS.THREAD_TAKEN.length > 0);

  // ── 查询 ──
  check('按 id 查询命中', store.getProject(p1.projectId)?.projectId === p1.projectId);
  check('按会话反查命中（跨天迭代入口）', store.getProjectByThread('thread-1')?.projectId === p1.projectId);
  check('空参数不查库直接返回 null', store.getProject('') === null && store.getProjectByThread('') === null);
  check('未知 id 返回 null', store.getProject('prj_nope') === null);

  // 无会话项目：threadId 为空串，不占用 unique 约束（NULL 语义）
  const p2 = store.createProject({ name: '独立项目', objective: 'z' });
  const p3 = store.createProject({ name: '独立项目 2', objective: 'z' });
  check('无会话的多个项目可共存', !!p2 && !!p3 && store.listProjects().length === before + 2);

  // ── 状态更新 ──
  const doneP = store.updateProjectStatus(p1.projectId, 'completed');
  check('状态可置 completed', doneP.status === 'completed');
  code = '';
  try { store.updateProjectStatus(p1.projectId, 'archived'); } catch (e) { code = e.code; }
  check('非法状态返回 INVALID_STATUS', code === 'INVALID_STATUS');
  code = '';
  try { store.updateProjectStatus('prj_nope', 'active'); } catch (e) { code = e.code; }
  check('未知项目更新返回 NOT_FOUND', code === 'NOT_FOUND');
  check('completed 非终态：可回 active 继续迭代',
    store.updateProjectStatus(p1.projectId, 'active').status === 'active');

  // ── 列表：状态过滤与上限 ──
  check('状态过滤只返回匹配项', store.listProjects({ status: 'active' }).every((p) => p.status === 'active'));
  check('limit 生效', store.listProjects({ limit: 2 }).length === 2);
  check('非法状态过滤抛错', (() => {
    try { store.listProjects({ status: 'bad' }); return false; } catch (e) { return e.code === 'INVALID_STATUS'; }
  })());

  // ── IPC：假 electron stub 真调一次（漏注入即 TypeError）──
  const handlers = new Map();
  // T6-13：createSpace 在 cwd 留空时要经 app.getPath 取文档目录自建工作区
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-docs-'));
  const electronPath = require.resolve('electron');
  const stubModule = new Module(electronPath, null);
  stubModule.filename = electronPath;
  stubModule.loaded = true;
  stubModule.exports = {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    app: { getPath: (k) => (k === 'documents' ? docsDir : os.tmpdir()) },
  };
  require.cache[electronPath] = stubModule;

  const { initProjectsIpc } = require('../main/ipc/projects');
  const audited = [];
  initProjectsIpc({ getProjectStore: () => store, audit: (kind, id, detail) => audited.push(kind) });

  for (const ch of ['projects:create', 'projects:list', 'projects:get', 'projects:updateStatus']) {
    check(`IPC 已注册：${ch}`, typeof handlers.get(ch) === 'function');
  }

  const created = await handlers.get('projects:create')({}, {
    name: 'IPC 项目', objective: '目标', category: 'tech', threadId: 'thread-ipc',
  });
  check('IPC create 返回信封与项目', created.ok === true && created.project.name === 'IPC 项目');
  check('IPC create 写审计', audited.includes('project_create'));

  const dup = await handlers.get('projects:create')({}, { name: '重复', objective: 'y', threadId: 'thread-ipc' });
  check('IPC create 重复 thread 返回结构化错误码', dup.ok === false && dup.code === 'THREAD_TAKEN');

  const emptyName = await handlers.get('projects:create')({}, { name: '', objective: 'y' });
  check('IPC create 空名称被 payloadGuard 拦下', emptyName.ok === false && /name/.test(emptyName.error));

  const got = await handlers.get('projects:get')({}, { threadId: 'thread-ipc' });
  check('IPC get 按会话反查', got.ok === true && got.project.projectId === created.project.projectId);
  const miss = await handlers.get('projects:get')({}, {});
  check('IPC get 缺参数返回 NOT_FOUND', miss.ok === false && miss.code === 'NOT_FOUND');

  const listed = await handlers.get('projects:list')({}, { status: 'active' });
  check('IPC list 返回项目数组', listed.ok === true && Array.isArray(listed.projects));

  const st = await handlers.get('projects:updateStatus')({}, { projectId: created.project.projectId, status: 'paused' });
  check('IPC updateStatus 生效', st.ok === true && st.project.status === 'paused');

  // T6-13 回归（真机反馈「建完项目 0 token 就结束」的落点问题）：
  // createSpace 在 cwd 留空时必须自建工作目录——此前落成 ''，团队派活没有落点。
  const { ArtifactStore } = require('../main/artifactStore');
  const { QuotaLedger } = require('../main/quotaLedger');
  const { TeamStore } = require('../main/teamStore');
  const { LocalStore } = require('../main/store/localStore');
  initProjectsIpc({
    getProjectStore: () => store,
    getArtifactStore: () => new ArtifactStore(db),
    getQuotaLedger: () => new QuotaLedger(db),
    getTeamStore: () => new TeamStore(db),
    getLocalStore: () => new LocalStore(dir),
  });
  const space = await handlers.get('projects:createSpace')({}, {
    name: '小程序商城',
    category: 'prd',
    objective: '基于 Java 21 与 Spring Boot 4 的微信小程序电商平台产品与技术文档',
  });
  check('createSpace 成功并返回会话/团队', space.ok === true && !!space.thread && !!space.team);
  const spaceCwd = String(space.project?.cwd || '');
  check('留空 cwd 时自建工作目录（路径非空且真实存在）',
    !!spaceCwd && fs.statSync(spaceCwd).isDirectory());
  check('自建目录落在 .MJCoder 工作区根下',
    spaceCwd.includes(`${path.sep}.MJCoder${path.sep}`));

  // 子系统未初始化：返回 UNAVAILABLE 而非崩溃
  initProjectsIpc({ getProjectStore: () => null });
  const down = await handlers.get('projects:list')({}, {});
  check('子系统不可用返回 UNAVAILABLE', down.ok === false && down.code === 'UNAVAILABLE');

  db.close();
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('T6-2 测试异常：', e);
  process.exit(1);
});
