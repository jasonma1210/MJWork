// DS Bots / T6-12 端到端演练（设计稿 §15 验收）：配额打满 → 暂停 → 老化 → 续跑。
//
// 用「自定义小额度 + 可注入时钟」把 3M/6h 的整轮寿命压缩到毫秒级，但**判定链路一字不改**：
//   initProjectSpace → 工件按版本推进 → 配额记录 → quotaGate 暂停（不判 failed）
//   → 滑窗老化（消耗不删，只按时间过滤）→ tickAll 小批量恢复 → 续写工件 → 上下文装配。
// 三条验收口径逐条落成断言：
//   ① 文档版本连续：V0.01 → V0.02 →（暂停期不写）→ V0.03，版本号不跳号、历史可回放；
//   ② 任务不丢：暂停只改状态，任务数 / id / 标题 / 重试次数全部不变；
//   ③ 无需重述需求：续跑装配里能读到固定目标 + 上次摘要 + 待办 + 工件索引（正文永不进装配）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { ProjectStore } = require('../main/projectStore');
const { ArtifactStore } = require('../main/artifactStore');
const { QuotaLedger } = require('../main/quotaLedger');
const { TeamStore } = require('../main/teamStore');
const { LocalStore } = require('../main/store/localStore');
const { TaskStore } = require('../main/taskStore');
const { initProjectSpace } = require('../main/projectSpaceInit');
const { createQuotaGate, RESUME_BATCH } = require('../main/quotaGate');
const projectContext = require('../main/projectContext');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const OBJECTIVE = '围绕企业级增长方案推进：锁定拉新、留存、转化三段目标，输出可直接评审的工件。';
// 正文哨兵：装配层若把正文带进来，这条标记就会出现在上下文里（体积预算被击穿的直接证据）
const BODY_MARK = '【正文哨兵-绝不应进入上下文装配】';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-project-e2e-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const projectStore = new ProjectStore(db);
  const artifactStore = new ArtifactStore(db);
  const quotaLedger = new QuotaLedger(db);
  const teamStore = new TeamStore(db);
  const localStore = new LocalStore(dir);
  const taskStore = new TaskStore(db);

  // 可注入时钟：整轮寿命压缩到 60s 窗口，但 quotaLedger / quotaGate 的判定代码原样执行
  const T0 = Date.now();
  let nowRef = T0;
  const clock = () => nowRef;

  // ── 1) 初始化项目空间（自定义 200k / 60s，恢复下限仍为默认 100k）──
  const space = initProjectSpace({
    name: '增长方案 E2E', category: 'prd', objective: OBJECTIVE,
    quotaTier: 'custom', totalLimit: 200000, windowSeconds: 60,
  }, { projectStore, artifactStore, quotaLedger, teamStore, localStore });
  const project = space.project;
  const artifactId = space.artifact.artifactId;
  const threadId = String(space.thread.id);

  check('初始化：项目/工件/配额/会话/团队七步齐全',
    !!project.projectId && !!artifactId && !!space.bucket && !!threadId && !!space.team);
  check('初始化：配额桶按自定义档落库', space.bucket.totalLimit === 200000 && space.bucket.windowSeconds === 60);

  // ── 2) 工件按版本推进（暂停前两版）──
  const p1 = artifactStore.patchSection({
    artifactId, sectionKey: 's1', baseVersion: space.artifact.currentVersion,
    content: `背景与目标：${BODY_MARK}`, changeSummary: '初稿',
  });
  const p2 = artifactStore.patchSection({
    artifactId, sectionKey: 's2', baseVersion: p1.version,
    content: `用户与场景：${BODY_MARK}`, changeSummary: '补充场景',
  });
  check('暂停前版本连续 V0.01 → V0.02', p1.version === 'V0.01' && p2.version === 'V0.02');

  // ── 3) 组内三个任务入队；一个已在途（running），两个排队 ──
  taskStore.createGroup({
    groupId: 'g-e2e', goal: OBJECTIVE, cwd: '', threadId,
    tasks: [
      { id: 'e1', title: '锁定目标', prompt: '整理目标与约束' },
      { id: 'e2', title: '拆解需求', prompt: '拆成可验收条目' },
      { id: 'e3', title: '输出结论', prompt: '汇总评审结论' },
    ],
  });
  taskStore.enqueueReady('g-e2e');
  taskStore.claimNext('g-e2e', 'w-e2e'); // e1 → running（在途，暂停时不动手）
  const beforeTasks = taskStore.getGroup('g-e2e').tasks.map((t) => ({ id: t.taskId, title: t.title }));

  let resumedKicks = 0;
  const gate = createQuotaGate({
    ledger: quotaLedger,
    store: taskStore,
    db,
    projectOfThread: (tid) => projectStore.getProjectByThread(tid),
    emit: () => {},
    now: clock,
    onResumed: () => { resumedKicks += 1; },
  });

  // ── 4) 3M/6h 打满的等价场景：窗口内已消耗 190k，剩余 10k < 恢复下限 ──
  quotaLedger.recordRound({ projectId: project.projectId, runId: 'g-e2e', taskId: 'e1', tokens: 190000, at: T0 });
  check('配额判定为不可派发（avail < resumeMinTokens）',
    quotaLedger.beforeDispatch(project.projectId, nowRef).reason === 'quota');

  // 开跑前预留：在途任务转 quota_suspend（I3：暂停不是失败）
  const run = gate.beginRun(taskStore.getGroup('g-e2e'), taskStore.getTask('g-e2e', 'e1'));
  check('开跑前闸拦截：返回 ok=false / reason=quota', !!run && run.ok === false && run.reason === 'quota');
  check('在途任务转 quota_suspend（未判 failed）', taskStore.getTask('g-e2e', 'e1').status === 'quota_suspend');

  // 泵前置闸：排队任务一并暂停；running 不再有
  check('泵前置闸拦截整组', gate.blocked(taskStore.getGroup('g-e2e')) === true);
  let paused = taskStore.getGroup('g-e2e');
  check('组内任务全部 quota_suspend（无一条 failed）',
    paused.tasks.length === 3 && paused.tasks.every((t) => t.status === 'quota_suspend'));
  check('暂停不消耗重试次数',
    db.prepare('SELECT SUM(retry_count) AS s FROM sub_tasks WHERE group_id = ?').get('g-e2e').s === 0);
  check('run 配额态已落 project_runs.quota_state=suspended',
    db.prepare('SELECT quota_state FROM project_runs WHERE run_id = ?').get('g-e2e').quota_state === 'suspended');

  // 暂停期：落一条跨天迭代摘要（T6-11 的宿主写入点）
  projectContext.saveRunSummary(db, {
    runId: 'g-e2e', projectId: project.projectId, threadId,
    summary: '已完成目标锁定与需求拆解口径；结论待配额恢复后补齐。',
  });

  // ── 5) 任务不丢（暂停只改状态）──
  check('任务数与 id/标题完全不变',
    paused.tasks.map((t) => `${t.taskId}:${t.title}`).join('|')
      === beforeTasks.map((t) => `${t.id}:${t.title}`).join('|'));

  // ── 6) 滑窗老化 → 小批量恢复 → 自动续跑 ──
  nowRef = T0 + 61 * 1000; // 越过 60s 滑窗
  check('老化是查询口径：窗口内消耗归零', quotaLedger.usedInWindow(project.projectId, nowRef) === 0);
  const consumedRows = db.prepare('SELECT COUNT(*) AS n FROM quota_consumptions WHERE project_id = ?')
    .get(project.projectId).n;
  check('老化不删流水（审计事实保留）', consumedRows === 1);
  taskStore.setGroupStatus('g-e2e', 'running');
  const tick = gate.tickAll();
  check(`小批量恢复上限 ${RESUME_BATCH}（本轮放行 2 个）`, tick.resumed === 2, `resumed=${tick.resumed}`);
  check('恢复后仍有 1 个保持暂停（迟滞 + 批量，不瞬间全放）',
    taskStore.getGroup('g-e2e').tasks.filter((t) => t.status === 'quota_suspend').length === 1);
  check('恢复后回踢调度一次（自动续跑）', resumedKicks === 1);
  const tick2 = gate.tickAll();
  check('下一次 tick 放行剩余任务', tick2.resumed === 1);
  check('全组回到 queued', taskStore.getGroup('g-e2e').tasks.every((t) => t.status === 'queued'));
  check('恢复后项目配额态回写 ok',
    db.prepare('SELECT quota_state FROM project_runs WHERE run_id = ?').get('g-e2e').quota_state === 'ok');

  // ── 7) 续跑继续写工件：版本必须连续 ──
  const p3 = artifactStore.patchSection({
    artifactId, sectionKey: 's3', baseVersion: p2.version,
    content: `功能需求：${BODY_MARK}`, changeSummary: '续跑补齐',
  });
  const vers = artifactStore.listVersions({ artifactId });
  check('续跑后版本连续 V0.01 → V0.02 → V0.03（不跳号）',
    vers.versions.map((v) => v.version).join(',') === 'V0.03,V0.02,V0.01');
  check('版本号与写入返回值一致', p3.version === 'V0.03' && vers.currentVersion === 'V0.03');
  check('各版本聚合章节键正确',
    vers.versions.find((v) => v.version === 'V0.02').sectionKeys.join(',') === 's2'
      && vers.versions.find((v) => v.version === 'V0.03').sectionKeys.join(',') === 's3');

  // ── 8) 跨天续跑装配：只喂四项，且正文永不进上下文 ──
  const block = projectContext.collectProjectContext({
    project: projectStore.getProject(project.projectId),
    db, artifactStore, group: taskStore.getGroup('g-e2e'), currentTaskId: 'e2',
  });
  check('装配含固定目标', block.includes('【项目固定目标与约束】') && block.includes('企业级增长方案'));
  check('装配含上次迭代摘要（跨天依据）', block.includes('【上次迭代摘要】') && block.includes('结论待配额恢复后补齐'));
  check('装配含待办（当前任务与终态已排除）', block.includes('【待办】') && block.includes('输出结论')
    && !block.includes('拆解需求'));
  check('装配含工件索引与最新版本', block.includes('【工件索引】') && block.includes('V0.03'));
  check('装配不含工件正文（体积预算守卫生效）', !block.includes(BODY_MARK));
  check('无需重述需求：目标与摘要同时在场即为续跑依据', block.includes('企业级增长方案') && block.includes('上次迭代摘要'));

  // ── 9) 全程任务不丢（终检）──
  const finalTasks = taskStore.getGroup('g-e2e').tasks;
  check('终检：三个任务全在，且无一 failed',
    finalTasks.length === 3 && finalTasks.every((t) => t.status !== 'failed'));

  console.log(`\nproject-e2e: ${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
  try { db.close?.(); } catch { /* sql.js 关闭幂等 */ }
})();
