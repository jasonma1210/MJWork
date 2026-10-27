// T6-1 迁移 v14 测试：项目空间 / 工件库 / 滑动配额账本 7 张表 + 索引 + 幂等升级
// 走 sql.js（WASM，零原生模块），与 taskStore 测试同口径。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync, MIGRATIONS } = require('../main/db');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
}

function indexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-project-space-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });

  // ── 版本链与目标版本 ──
  // 判据不用字面量 14：迁移链每个里程碑都会往后长（v14 之后已有 v15 知识库），
  // 把「当刻的末版号」写成等值断言，等于让下一个人每加一条迁移就来手改常量，
  // 而真正的回归（最后一条迁移没登记 / 新库停在旧版本）反而没被告知。
  // 现在断言的是**两条不变量**：末版号必须等于登记表的最大版本且不低于 v14；
  // 新库 user_version 必须等于该末版号。
  const target = MIGRATIONS[MIGRATIONS.length - 1].version;
  const maxRegistered = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
  check('迁移链末版 = 登记表最大版本，且不低于 v14', target === maxRegistered && target >= 14, `实际 v${target}`);
  check('新库 user_version = 迁移链末版', db.pragma('user_version', { simple: true }) === target, `实际 ${db.pragma('user_version', { simple: true })}`);

  // ── 7 张表存在（设计稿 §4：project_spaces / project_artifacts / artifact_sections /
  //    artifact_section_versions / quota_buckets / quota_consumptions / project_runs）──
  const tables = tableNames(db);
  const expectedTables = [
    'project_spaces', 'project_artifacts', 'artifact_sections', 'artifact_section_versions',
    'quota_buckets', 'quota_consumptions', 'project_runs',
  ];
  for (const t of expectedTables) check(`表已创建：${t}`, tables.includes(t));

  // ── 索引存在（滑动窗口与成员聚合是高频查询，缺索引即全表扫）──
  const indexes = indexNames(db);
  for (const idx of [
    'idx_project_spaces_status', 'idx_project_artifacts_project', 'idx_artifact_versions_retention',
    'idx_quota_consumptions_window', 'idx_quota_consumptions_member', 'idx_project_runs_project',
  ]) {
    check(`索引已创建：${idx}`, indexes.includes(idx));
  }

  // ── 字段级契约：默认值必须能在「只传必要列」的插入下成立 ──
  db.prepare(`INSERT INTO project_spaces (project_id, name, created_at, updated_at)
              VALUES (?, ?, ?, ?)`).run('prj_1', '微信小程序商城 V1.0', 1, 1);
  const space = db.prepare('SELECT * FROM project_spaces WHERE project_id = ?').get('prj_1');
  check('project_spaces 默认 category=custom / status=active / meta_json={}',
    space.category === 'custom' && space.status === 'active' && space.meta_json === '{}');
  check('project_spaces objective 缺省为空串', space.objective === '');

  db.prepare(`INSERT INTO project_artifacts (id, project_id, created_at, updated_at)
              VALUES (?, ?, ?, ?)`).run('art_1', 'prj_1', 1, 1);
  const art = db.prepare('SELECT * FROM project_artifacts WHERE id = ?').get('art_1');
  check('project_artifacts 默认 V0.0 / per_patch / retain=10',
    art.current_version === 'V0.0' && art.snapshot_policy === 'per_patch' && art.retain_versions === 10);

  db.prepare(`INSERT INTO quota_buckets (project_id, created_at, updated_at) VALUES (?, ?, ?)`)
    .run('prj_1', 1, 1);
  const bucket = db.prepare('SELECT * FROM quota_buckets WHERE project_id = ?').get('prj_1');
  check('quota_buckets 默认 3M / 6h / 70% / 90% / 100k / 85%',
    bucket.total_limit === 3000000 && bucket.window_seconds === 21600
    && bucket.warn_ratio === 0.7 && bucket.throttle_ratio === 0.9
    && bucket.resume_min_tokens === 100000 && bucket.resume_hysteresis_ratio === 0.85);

  // ── 唯一约束：一个 thread 只能属于一个项目空间（验收清单第 1 条）──
  db.prepare(`INSERT INTO project_spaces (project_id, name, thread_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)`).run('prj_2', '另一个项目', 'thread-1', 1, 1);
  let dupRejected = false;
  try {
    db.prepare(`INSERT INTO project_spaces (project_id, name, thread_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)`).run('prj_3', '冲突项目', 'thread-1', 1, 1);
  } catch (e) {
    dupRejected = /UNIQUE/i.test(String(e.message));
  }
  check('thread_id 唯一约束拒绝重复绑定', dupRejected);

  // 章节版本联合唯一：同一章节同一版本只能有一行（重复 patch 靠它兜底）
  db.prepare(`INSERT INTO artifact_section_versions (artifact_id, section_key, version, created_at)
              VALUES (?, ?, ?, ?)`).run('art_1', 'outline', 'V0.1', 1);
  let verDup = false;
  try {
    db.prepare(`INSERT INTO artifact_section_versions (artifact_id, section_key, version, created_at)
                VALUES (?, ?, ?, ?)`).run('art_1', 'outline', 'V0.1', 2);
  } catch (e) {
    verDup = /UNIQUE/i.test(String(e.message));
  }
  check('章节版本 (artifact_id, section_key, version) 联合唯一', verDup);

  // ── 扣费流水聚合口径：只统计窗口内记录（滑动老化的数据前提）──
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO quota_consumptions
    (project_id, run_id, task_id, member_id, tokens, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ins.run('prj_1', 'run1', 't1', 'm1', 1000, 'round', now - 7 * 3600 * 1000); // 已老化
  ins.run('prj_1', 'run1', 't1', 'm1', 2000, 'round', now - 60 * 1000);        // 窗口内
  ins.run('prj_1', 'run1', 't2', 'm2', 500, 'settle', now - 30 * 1000);        // 窗口内
  const win = db.prepare(`SELECT SUM(tokens) AS s FROM quota_consumptions
    WHERE project_id = ? AND created_at > ?`).get('prj_1', now - 6 * 3600 * 1000);
  check('滑动窗口求和剔除 6h 外记录', win.s === 2500, `窗口内合计 ${win.s}`);

  // ── 幂等：把 user_version 拨回 v13（模拟「表/列已存在、版本号落后」的老库）──
  // 重开库后必须一路补到末版（现行 v15），且已有数据不被重复迁移破坏。
  db.pragma('user_version = 13');
  const rowCountBefore = db.prepare('SELECT COUNT(*) AS c FROM project_spaces').get().c;
  db.flush();
  db.close();

  const db2 = await openDbAsync(dir, { driver: 'sqljs' });
  check('旧版本号重开库自动升级到末版', db2.pragma('user_version', { simple: true }) === target, `实际 v${db2.pragma('user_version', { simple: true })}`);
  const rowCountAfter = db2.prepare('SELECT COUNT(*) AS c FROM project_spaces').get().c;
  check('重复迁移不丢数据（项目空间行数不变）', rowCountAfter === rowCountBefore,
    `${rowCountBefore} → ${rowCountAfter}`);
  const tablesAfter = tableNames(db2);
  check('重复迁移后表仍完整', expectedTables.every((t) => tablesAfter.includes(t)));

  // ── project_runs 契约：run_id 复用 task_groups.group_id，quota_state 默认 ok ──
  db2.prepare(`INSERT INTO project_runs (run_id, project_id, thread_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)`).run('g1', 'prj_1', 'thread-1', 1, 1);
  const run = db2.prepare('SELECT * FROM project_runs WHERE run_id = ?').get('g1');
  check('project_runs 默认 quota_state=ok / summary_json={}',
    run.quota_state === 'ok' && run.summary_json === '{}');

  db2.close();

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('T6-1 测试异常：', e);
  process.exit(1);
});
