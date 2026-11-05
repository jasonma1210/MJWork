// sql.js（WASM 降级驱动）适配层测试：验证 better-sqlite3 兼容 API 面 + 持久化往返
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openSqliteJsDb, PERSIST_DEBOUNCE_MS } = require('../main/db/sqljsDb');
const { MIGRATIONS } = require('../main/db');
const { TaskStore } = require('../main/taskStore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-sqljs-'));
const file = path.join(tmp, 't.db');

let n = 0;
function ok(name) { n += 1; console.log(`  ✓ ${name}`); }

(async () => {
  // 1. 建库 + 迁移链
  const db = await openSqliteJsDb(file);
  db.pragma('user_version = 0');
  const v0 = db.pragma('user_version', { simple: true });
  assert.strictEqual(v0, 0, 'PRAGMA user_version 读回');
  ok('PRAGMA 读/写');

  db.pragma('journal_mode = WAL');  // 内存库上无害降级，不应抛错
  db.pragma('foreign_keys = ON');
  ok('无害 PRAGMA 降级');

  for (const m of MIGRATIONS) {
    const tx = db.transaction(() => { m.up(db); db.pragma(`user_version = ${m.version}`); });
    tx();
  }
  const v1 = db.pragma('user_version', { simple: true });
  assert.strictEqual(v1, MIGRATIONS.length, '迁移版本号（跟随迁移链最新版）');
  ok('迁移事务 + user_version 持久化语义');

  // 2. prepare.run/get/all
  db.prepare('INSERT INTO task_groups (group_id, goal, cwd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('g1', '目标A', '/tmp/x', 'ready', 1, 1);
  const g = db.prepare('SELECT * FROM task_groups WHERE group_id = ?').get('g1');
  assert.strictEqual(g.goal, '目标A');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM task_groups').get().n, 1);
  assert.strictEqual(db.prepare('SELECT * FROM task_groups WHERE group_id = ?').get('nope'), undefined);
  ok('prepare run/get/all（含未命中 → undefined）');

  // undefined 参数归一为 null（可空列 worker_id）
  db.prepare('INSERT INTO sub_tasks (task_id, group_id, seq, title, prompt, depends_on, worker_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('t1', 'g1', 0, '任务1', '做事情', '[]', undefined, 'pending');
  const t = db.prepare('SELECT worker_id FROM sub_tasks WHERE task_id = ?').get('t1');
  assert.strictEqual(t.worker_id, null);
  ok('undefined 参数 → null 归一');

  // 3. 事务回滚语义
  const boom = db.transaction(() => {
    db.prepare('INSERT INTO task_groups (group_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('g-bad', 'x', 'ready', 1, 1);
    throw new Error('rollback-me');
  });
  assert.throws(boom, /rollback-me/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM task_groups WHERE group_id = ?').get('g-bad').n, 0);
  ok('事务异常 → ROLLBACK');

  // 4. TaskStore 状态机跑在 sql.js 上
  const store = new TaskStore(db);
  const created = store.createGroup({
    groupId: 'grp', goal: '做一件事', cwd: '/tmp',
    dag: { tasks: [
      { id: 'a', title: 'A', prompt: 'pa', dependsOn: [], critical: true, maxRetry: 1, timeoutMs: 1000 },
      { id: 'b', title: 'B', prompt: 'pb', dependsOn: ['a'], critical: false, maxRetry: 0, timeoutMs: 1000 },
    ] },
    tasks: [
      { id: 'a', title: 'A', prompt: 'pa', dependsOn: [], critical: true, maxRetry: 1, timeoutMs: 1000 },
      { id: 'b', title: 'B', prompt: 'pb', dependsOn: ['a'], critical: false, maxRetry: 0, timeoutMs: 1000 },
    ],
  });
  assert.strictEqual(created.tasks.length, 2);
  store.enqueueReady('grp');
  const claimed = store.claimNext('grp', 'w1');
  assert.strictEqual(claimed.taskId, 'a');
  store.setTaskStatus('grp', 'a', 'done', { result: { summary: 'A 完成' } });
  store.enqueueReady('grp');
  const claimedB = store.claimNext('grp', 'w2');
  assert.strictEqual(claimedB.taskId, 'b');
  const { retried } = store.handleFailure('grp', 'b', '超时');
  assert.strictEqual(retried, false, 'maxRetry=0 不重试');
  assert.strictEqual(store.getTask('grp', 'b').status, 'failed');
  assert.strictEqual(store.groupHasBlockingFailure('grp'), false, 'b 非关键');
  ok('TaskStore 状态机（claim/依赖解锁/失败处置）');

  // 5. 持久化往返：flush → 重新载入 → 状态完整
  db.flush();
  const db2 = await openSqliteJsDb(file);
  assert.strictEqual(db2.pragma('user_version', { simple: true }), MIGRATIONS.length, '迁移版本持久化');
  const store2 = new TaskStore(db2);
  const g2 = store2.getGroup('grp');
  assert.strictEqual(g2.goal, '做一件事');
  assert.strictEqual(g2.tasks.find((x) => x.taskId === 'a').status, 'done');
  assert.deepStrictEqual(g2.tasks.find((x) => x.taskId === 'a').result, { summary: 'A 完成' });
  assert.strictEqual(g2.tasks.find((x) => x.taskId === 'b').status, 'failed');
  ok('flush 落盘 → 重开库状态完整（断点续跑前提）');

  // 6. 崩溃恢复（V14）：running → failed + needsReview（不盲目重放；failed 任务先手动回队再模拟领取后崩溃）
  store2.setTaskStatus('grp', 'b', 'queued');
  store2.claimNext('grp', 'w3');
  assert.strictEqual(store2.getTask('grp', 'b').status, 'running');
  const rec = store2.recoverInterrupted();
  assert.strictEqual(rec.recoveredTasks.length, 1);
  const recTask = store2.getTask('grp', 'b');
  assert.strictEqual(recTask.status, 'failed');
  assert.strictEqual(recTask.result.needsReview, true);
  db2.close();
  ok('recoverInterrupted 崩溃恢复（V14 不重放，needsReview）');

  // 7. 防抖窗口内 exit 兜底 flush（新库，写完立刻 close 而不手动 flush）
  const file3 = path.join(tmp, 't3.db');
  const db3 = await openSqliteJsDb(file3);
  db3.exec('CREATE TABLE x(v)');
  db3.prepare('INSERT INTO x VALUES (?)').run('hi');
  db3.close(); // close 内部 flush
  const raw = fs.readFileSync(file3);
  assert.ok(raw.length > 0, '落盘文件非空');
  ok('close 自动 flush');

  // ═══ ST2（2026-11-05）：双驱动 parity ═══
  // 换驱动的风险不是「打不开」，而是**语义悄悄变了**：布尔绑定、undefined、事务回滚、
  // 行对象原型、changes 计数。同一组操作分别跑两个驱动，断言结果一致；
  // 真正的差异不假装一致，而是显式断言（见第 ⑨ 条）。
  const { openNodeSqliteDb } = require('../main/db/nodeSqliteDb');

  async function battery(label, openFn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mj-parity-${label}-`));
    const f = path.join(dir, 'p.db');
    const db = await openFn(f);
    try {
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, s TEXT, n INTEGER, b INTEGER)');
      // ① run 的 changes
      const r1 = db.prepare('INSERT INTO t (s, n, b) VALUES (?, ?, ?)').run('a', 1, true);
      assert.strictEqual(r1.changes, 1, `${label}: run 返回 changes=1`);
      // ② undefined → null（node:sqlite 拒绝 undefined，sql.js 兼容层同样转 null）
      db.prepare('INSERT INTO t (s, n, b) VALUES (?, ?, ?)').run(undefined, 2, false);
      const rows = db.prepare('SELECT s, n, b FROM t ORDER BY id').all();
      assert.strictEqual(rows.length, 2, `${label}: 两条写入`);
      assert.strictEqual(rows[1].s, null, `${label}: undefined → null`);
      // ③ 布尔归一 0/1（node:sqlite 拒绝布尔、sql.js 接受 —— 不归一则生产炸而单测全绿）
      assert.strictEqual(rows[0].b, 1, `${label}: true → 1`);
      assert.strictEqual(rows[1].b, 0, `${label}: false → 0`);
      // ④ 行对象必须是普通对象：null 原型会让 deepStrictEqual 失败、直接 hasOwnProperty 抛错
      assert.strictEqual(Object.getPrototypeOf(rows[0]), Object.prototype, `${label}: 行对象为普通对象`);
      assert.deepStrictEqual({ ...rows[0] }, { s: 'a', n: 1, b: 1 }, `${label}: deepStrictEqual 可用`);
      // ⑤ 事务异常回滚
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO t (s, n, b) VALUES (?, ?, ?)').run('rollback-me', 9, 0);
        throw new Error('boom');
      });
      assert.throws(() => tx(), /boom/, `${label}: 事务内异常须抛出`);
      assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM t').get().c, 2, `${label}: 回滚后仍为 2 行`);
      // ⑥ PRAGMA user_version 往返
      db.pragma('user_version = 7');
      assert.strictEqual(db.pragma('user_version', { simple: true }), 7, `${label}: user_version 往返`);
      // ⑦ UPDATE changes 计数
      const upd = db.prepare('UPDATE t SET n = ? WHERE n >= ?').run(5, 1);
      assert.strictEqual(upd.changes, 2, `${label}: UPDATE changes 计数`);
    } finally {
      try { db.close(); } catch { /* 幂等 */ }
    }
    // ⑧ 跨驱动读回：干净关闭后，**另一个驱动**必须能读到全部数据。
    //    这是「万一降级回 sql.js 也不丢已提交」的真实要求。
    //    ⚠ 曾经写成「关闭后不得残留 -wal」——实测那是**假绿**：SQLite 自己在 close 时就会
    //    checkpoint 并删除 -wal，把 nodeSqliteDb 里显式的 wal_checkpoint 整行删掉，该断言照样通过。
    //    故改为验真实可观测项（另一驱动能否读到），显式 checkpoint 只作 multi-connection 时的防御性保证。
    const crossDb = label === 'sqljs' ? await openNodeSqliteDb(f) : await openSqliteJsDb(f);
    assert.strictEqual(crossDb.prepare('SELECT COUNT(*) c FROM t').get().c, 2,
      `${label}: 另一驱动可读到 2 行（跨驱动降级不丢已提交数据）`);
    crossDb.close();
    // ⑨ 同驱动重开读回（两驱动都必须持久化）
    const db2 = await openFn(f);
    assert.strictEqual(db2.prepare('SELECT COUNT(*) c FROM t').get().c, 2, `${label}: 重开读回 2 行`);
    db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await battery('sqljs', openSqliteJsDb);
  ok('parity：sql.js 通过 9 项语义断言');

  let hasNodeSqlite = true;
  try { require('node:sqlite'); } catch { hasNodeSqlite = false; }
  if (hasNodeSqlite) {
    await battery('nodesqlite', openNodeSqliteDb);
    ok('parity：node:sqlite 通过同一组 9 项语义断言（换驱动语义不变）');

    // ⑩ 已知差异（显式断言，不假装一致）：sql.js 的 transaction 用裸 BEGIN，
    //    嵌套会抛「cannot start a transaction within a transaction」；
    //    node:sqlite 走 SAVEPOINT 支持嵌套 —— 这是 node 驱动**修掉**的缺陷，不该回退。
    const ndir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-parity-nest-'));
    const nd = await openNodeSqliteDb(path.join(ndir, 'n.db'));
    nd.exec('CREATE TABLE n(v INTEGER)');
    const outer = nd.transaction(() => {
      nd.prepare('INSERT INTO n VALUES (?)').run(1);
      nd.transaction(() => { nd.prepare('INSERT INTO n VALUES (?)').run(2); })();
    });
    outer();
    assert.strictEqual(nd.prepare('SELECT COUNT(*) c FROM n').get().c, 2, '嵌套事务应写入 2 行');
    nd.close();
    fs.rmSync(ndir, { recursive: true, force: true });
    ok('node:sqlite 事务可嵌套（SAVEPOINT）——sql.js 裸 BEGIN 不支持');
  } else {
    console.warn('  ⚠ 当前运行时无 node:sqlite，parity 仅覆盖 sql.js（这一段不算已验证）');
  }

  db.close();
  console.log(`\nsqljsDb 适配层：${n} 项全部通过`);
})().catch((e) => { console.error(e); process.exit(1); });
