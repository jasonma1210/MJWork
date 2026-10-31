// DS Bots / T6-9 测试：项目空间初始化链路（设计稿 §11.3）。
// 覆盖：七步落库齐全、默认值（章节/工件类型/配额/快照/摘要阈值）、断点续跑关闭语义、
// 跨存储补偿回滚（任一步失败无脏数据）、入参校验边界、现有团队直接绑定。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { ProjectStore } = require('../main/projectStore');
const { ArtifactStore } = require('../main/artifactStore');
const { QuotaLedger } = require('../main/quotaLedger');
const { TeamStore } = require('../main/teamStore');
const { LocalStore } = require('../main/store/localStore');
const { initProjectSpace, normalizeSpec, InitError } = require('../main/projectSpaceInit');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const OBJECTIVE = '打造一个可复用的企业级增长方案，覆盖拉新、留存与转化三个环节。';

// 校验异常捕获：返回 { code, field } 便于断言
function catchInit(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-project-space-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const projectStore = new ProjectStore(db);
  const artifactStore = new ArtifactStore(db);
  const quotaLedger = new QuotaLedger(db);
  const teamStore = new TeamStore(db);
  const localStore = new LocalStore(dir);
  const deps = { projectStore, artifactStore, quotaLedger, teamStore, localStore };

  // ── 1) 七步落库齐全（标准档 + PRD 分类默认值）──
  const r1 = initProjectSpace({
    name: '2026 Q4 增长方案',
    category: 'prd',
    objective: OBJECTIVE,
  }, deps);

  check('返回七个实体（项目/工件/配额桶/会话/团队）',
    !!r1.project && !!r1.artifact && !!r1.bucket && !!r1.thread && !!r1.team);
  check('项目落库并可回查', projectStore.getProject(r1.project.projectId)?.name === '2026 Q4 增长方案');
  check('项目已绑定会话/工件/团队', r1.project.threadId === String(r1.thread.id)
    && r1.project.artifactId === r1.artifact.artifactId
    && r1.project.teamId === r1.team.id);
  check('工件为 V0.0 且章节已预建',
    r1.artifact.currentVersion === 'V0.0' && r1.artifact.outline.length === 5);
  check('PRD 默认章节顺序正确',
    r1.artifact.outline.map((s) => s.title).join('/') === '背景与目标/用户与场景/功能需求/非功能需求/验收标准');
  check('PRD 默认工件类型 document、快照 per_patch、保留 10 版',
    r1.artifact.kind === 'document' && r1.artifact.snapshotPolicy === 'per_patch' && r1.artifact.retainVersions === 10);
  check('默认配额档 standard（3M / 21600s）',
    r1.bucket.totalLimit === 3_000_000 && r1.bucket.windowSeconds === 21600 && r1.bucket.tier === 'standard');
  check('断点续跑默认开启（恢复下限 100k）', r1.bucket.resumeMinTokens === 100_000);
  check('首条系统消息已写入会话',
    localStore.listMessages(r1.thread.id).some((m) => m.role === 'system' && /项目已创建/.test(m.content)));
  const members = teamStore.listMembers(r1.team.id);
  check('PRD 模板招募 4 名成员且首名为统筹',
    members.length === 4 && members[0].roleKind === 'lead');
  check('团队名带项目名与模板名', /^2026 Q4 增长方案（产品 PRD 协作）$/.test(r1.team.name));

  // ── 2) 分类默认值：技术方案 → spec + tech 章节 + tech 模板 ──
  const r2 = initProjectSpace({
    name: '网关重构方案', category: 'tech', objective: OBJECTIVE,
  }, deps);
  check('技术分类默认工件 spec', r2.artifact.kind === 'spec');
  check('技术分类默认章节为方案骨架',
    r2.artifact.outline[1].title === '方案架构' && r2.artifact.outline.length === 5);
  check('技术分类默认模板含架构师统筹',
    r2.team.name.includes('技术方案评审') && teamStore.listMembers(r2.team.id)[0].name === '架构师');

  // ── 3) 配额档位与自定义 ──
  const light = initProjectSpace({
    name: '轻量项目', category: 'custom', objective: OBJECTIVE, quotaTier: 'light',
  }, deps);
  check('轻量档 1M / 7200s', light.bucket.totalLimit === 1_000_000 && light.bucket.windowSeconds === 7200);

  const large = initProjectSpace({
    name: '大型项目', category: 'custom', objective: OBJECTIVE, quotaTier: 'large',
  }, deps);
  check('大型档 10M / 86400s', large.bucket.totalLimit === 10_000_000 && large.bucket.windowSeconds === 86400);

  const custom = initProjectSpace({
    name: '自定义配额', category: 'custom', objective: OBJECTIVE,
    quotaTier: 'custom', totalLimit: 500000, windowSeconds: 3600,
  }, deps);
  check('自定义配额按入参落库并能记录 tier',
    custom.bucket.totalLimit === 500000 && custom.bucket.windowSeconds === 3600 && custom.bucket.tier === 'custom');

  // ── 4) 断点续跑关闭 = 恢复下限抬到总额度之上（quotaLedger 单一判定不变）──
  const off = initProjectSpace({
    name: '续跑关闭', category: 'custom', objective: OBJECTIVE, resumeEnabled: false,
  }, deps);
  check('关闭续跑后 resumeMinTokens = totalLimit + 1', off.bucket.resumeMinTokens === 3_000_001);

  // ── 5) 摘要阈值：越界夹紧（§11.1「夹 50–85%」）──
  const clampHigh = initProjectSpace({
    name: '阈值偏高', category: 'custom', objective: OBJECTIVE, compactPolicy: 95,
  }, deps);
  check('摘要阈值 95 夹紧为 85', clampHigh.project.meta.compactPolicy === 85);
  const clampLow = initProjectSpace({
    name: '阈值偏低', category: 'custom', objective: OBJECTIVE, compactPolicy: 10,
  }, deps);
  check('摘要阈值 10 夹紧为 50', clampLow.project.meta.compactPolicy === 50);

  // ── 6) 现有团队直接绑定（不新建团队）──
  const existing = teamStore.createTeam({ name: '既有团队', description: '跨项目复用', projectPath: '' });
  const teamCountBefore = teamStore.listTeams().length;
  const bound = initProjectSpace({
    name: '绑定现有团队', category: 'custom', objective: OBJECTIVE,
    teamMode: 'existing', teamId: existing.id,
  }, deps);
  check('现有团队被直接绑定', bound.project.teamId === existing.id && bound.team.id === existing.id);
  check('绑定现有团队不会新建团队', teamStore.listTeams().length === teamCountBefore);

  // ── 7) 入参校验边界（结构化 field 供表单定位）──
  const cases = [
    ['缺名称', { category: 'prd', objective: OBJECTIVE }, 'name'],
    ['名称超 40 字', { name: 'x'.repeat(41), category: 'prd', objective: OBJECTIVE }, 'name'],
    ['目标不足 20 字', { name: 'n', category: 'prd', objective: '太短' }, 'objective'],
    ['目标超 2000 字', { name: 'n', category: 'prd', objective: 'x'.repeat(2001) }, 'objective'],
    ['分类非法', { name: 'n', category: 'bad', objective: OBJECTIVE }, 'category'],
    ['模板非法', { name: 'n', category: 'custom', objective: OBJECTIVE, teamTemplate: 'nope' }, 'teamTemplate'],
    ['自定义配额越界', { name: 'n', category: 'custom', objective: OBJECTIVE, quotaTier: 'custom', totalLimit: 500, windowSeconds: 3600 }, 'totalLimit'],
    ['自定义窗口越界', { name: 'n', category: 'custom', objective: OBJECTIVE, quotaTier: 'custom', totalLimit: 100000, windowSeconds: 10 }, 'windowSeconds'],
    ['保留版本越界', { name: 'n', category: 'custom', objective: OBJECTIVE, retainVersions: 51 }, 'retainVersions'],
    ['章节超 50', { name: 'n', category: 'custom', objective: OBJECTIVE, outline: Array.from({ length: 51 }, (_, i) => `第${i}章`) }, 'outline'],
    ['工作目录不存在', { name: 'n', category: 'custom', objective: OBJECTIVE, cwd: path.join(dir, 'no-such-dir') }, 'cwd'],
  ];
  for (const [label, payload, field] of cases) {
    const err = catchInit(() => normalizeSpec(payload, { teamStore }));
    check(`校验：${label} → ${field}`, err instanceof InitError && err.code === 'INVALID_INPUT' && err.field === field,
      err ? `实际 ${err.code}/${err.field}` : '未抛错');
  }
  const missingTeam = catchInit(() => normalizeSpec({
    name: 'n', category: 'custom', objective: OBJECTIVE, teamMode: 'existing', teamId: 'team_nope',
  }, { teamStore }));
  check('校验：现有团队不存在 → teamId', missingTeam?.field === 'teamId');

  // ── 8) 补偿回滚：团队创建失败 → 前四步全部撤销，无脏数据 ──
  const countBefore = projectStore.listProjects().length;
  const threadsBefore = localStore.listThreads().length;
  const artifactsBefore = db.prepare('SELECT COUNT(*) AS n FROM project_artifacts').get().n;
  const sectionsBefore = db.prepare('SELECT COUNT(*) AS n FROM artifact_sections').get().n;
  const bucketsBefore = db.prepare('SELECT COUNT(*) AS n FROM quota_buckets').get().n;
  const brokenTeamStore = {
    getTeam: (id) => teamStore.getTeam(id),
    createTeam: () => { throw new Error('team-create-boom'); },
    addMember: () => { throw new Error('addMember should not run'); },
    deleteTeam: () => true,
  };
  const boom = catchInit(() => initProjectSpace({
    name: '回滚验证', category: 'custom', objective: OBJECTIVE,
  }, { ...deps, teamStore: brokenTeamStore }));
  check('原始错误被透出（不被回滚错误覆盖）', boom?.message === 'team-create-boom');
  check('回滚后无残留项目', projectStore.listProjects().length === countBefore);
  check('回滚后无残留会话', localStore.listThreads().length === threadsBefore);
  check('回滚后无残留工件',
    db.prepare('SELECT COUNT(*) AS n FROM project_artifacts').get().n === artifactsBefore);
  check('回滚后无残留配额桶',
    db.prepare('SELECT COUNT(*) AS n FROM quota_buckets').get().n === bucketsBefore);
  check('回滚后无残留章节行',
    db.prepare('SELECT COUNT(*) AS n FROM artifact_sections').get().n === sectionsBefore);

  // ── 9) 子系统缺依赖 → UNAVAILABLE（IPC 据此返回友好提示）──
  const unavailable = catchInit(() => initProjectSpace({ name: 'n', category: 'prd', objective: OBJECTIVE }, {}));
  check('缺依赖返回 UNAVAILABLE', unavailable?.code === 'UNAVAILABLE');

  console.log(`\nproject-space: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
