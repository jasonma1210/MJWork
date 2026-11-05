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

    // ⑪ 持久化契约必须被钉住，不能靠默认值。
    //    `journal_mode=WAL` 是显式设置的；`synchronous` 此前**完全依赖 SQLite 默认（FULL）**，
    //    而默认值不是契约：WAL 下把 synchronous 调成 NORMAL 是常见吞吐优化，改完
    //    「已提交」就不再等于「掉电后还在」，且**所有测试照样绿**（丢数据发生在进程外）。
    //    这两条断言的作用是：将来谁动了它，测试立刻红，而不是等用户掉电才发现。
    const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-durability-'));
    const pd = await openNodeSqliteDb(path.join(pdir, 'd.db'));
    assert.strictEqual(String(pd.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal',
      'journal_mode 必须是 wal（拿不到 WAL 就等于没换驱动）');
    assert.strictEqual(pd.pragma('synchronous', { simple: true }), 2,
      'synchronous 必须是 FULL(2)：已提交 = 掉电后仍在');
    pd.close();
    fs.rmSync(pdir, { recursive: true, force: true });
    ok('node:sqlite 持久化契约：journal_mode=wal + synchronous=FULL(2) 被显式钉住');

    // ⑫ ST3：迁移前快照必须「真能回滚」。copyFileSync 只进 page cache，掉电时备份可能根本不存在；
    //    这里验三件事：快照生成 / 可作为独立库打开（不是截断文件）/ 版本停在迁移前。
    const { openDbAsync, __applyOneMigration, __addColumnForTest } = require('../main/db');
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-snapshot-'));
    const sfile = path.join(sdir, 'mjcode-tasks.db');
    {
      const d = await openNodeSqliteDb(sfile);
      for (const m of MIGRATIONS.filter((x) => x.version <= 18)) {
        d.transaction(() => { m.up(d); d.pragma(`user_version = ${m.version}`); })();
      }
      d.close();
    }
    // fsync 是副作用，默认测不到 —— 用 fd→路径映射精确断言「快照副本自身被 fsync 过」。
    // 只数目录 fsync 不够：那样删掉 fsyncFile 仍会绿（fsyncDir 同走 fs.fsyncSync）。
    const realOpen = fs.openSync, realFsync = fs.fsyncSync, realClose = fs.closeSync;
    const pathByFd = new Map();
    let bakFsynced = false;
    fs.openSync = function patchedOpen(p, ...a) { const fd = realOpen.call(fs, p, ...a); pathByFd.set(fd, String(p)); return fd; };
    fs.fsyncSync = function patchedFsync(fd) {
      const p = pathByFd.get(fd) || '';
      if (p.endsWith('.pre-v18.bak')) bakFsynced = true;
      return realFsync.call(fs, fd);
    };
    fs.closeSync = function patchedClose(fd) { pathByFd.delete(fd); return realClose.call(fs, fd); };
    let migrated;
    try {
      migrated = await openDbAsync(sdir, { driver: 'node-sqlite' });
    } finally {
      fs.openSync = realOpen; fs.fsyncSync = realFsync; fs.closeSync = realClose;
    }
    assert.ok(bakFsynced, '迁移前快照副本必须 fsync（掉电后回滚点才真实存在）');
    const bak = `${sfile}.pre-v18.bak`;
    assert.ok(fs.existsSync(bak), '迁移前快照文件已生成');
    const bakDb = await openNodeSqliteDb(bak);
    assert.strictEqual(bakDb.pragma('user_version', { simple: true }), 18, '快照版本停在迁移前 v18');
    assert.ok(bakDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_groups'").get(),
      '快照可作为独立库打开且含任务表（fsync 后回滚点真实可用）');
    bakDb.close();
    assert.strictEqual(migrated.pragma('user_version', { simple: true }), 19, '迁移后版本推进到 v19');
    migrated.close();
    fs.rmSync(sdir, { recursive: true, force: true });
    ok('ST3 迁移前快照：生成 + 可独立打开 + 版本停在迁移前');

    // ⑬ ST3：duplicate column 不再「只推进版本号」。两条独立断言：
    //    ① 首次抛 duplicate、重放成功 ⇒ 重放真的执行（计数=2）且版本号落到目标；
    //    ② 非 duplicate 错误必须原样抛出（把「真故障」吞掉比崩溃更危险）。
    const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-retry-'));
    const rd = await openNodeSqliteDb(path.join(rdir, 'r.db'));
    let retryCalls = 0;
    const fake = { version: 900, name: 'fake-duplicate', up: () => { retryCalls += 1; if (retryCalls === 1) throw new Error('duplicate column name: x'); } };
    __applyOneMigration(rd, fake);
    assert.strictEqual(retryCalls, 2, '撞 duplicate column 后必须重放一次（不是直接推进版本号）');
    assert.strictEqual(rd.pragma('user_version', { simple: true }), 900, '重放成功后版本号才推进');
    const bad = { version: 901, name: 'fake-real-error', up: () => { throw new Error('no such table: nope'); } };
    assert.throws(() => __applyOneMigration(rd, bad), /no such table/, '非 duplicate 错误必须抛出，不被吞');
    assert.strictEqual(rd.pragma('user_version', { simple: true }), 900, '失败后版本号不得前进');
    rd.close();
    fs.rmSync(rdir, { recursive: true, force: true });
    ok('ST3 duplicate-column 真校验：重放一次 + 非该错误必须抛');

    // ⑮ ST3：迁移的「列已就位」真校验必须真的拦人，且**回滚版本号**。
    //    造一条「记录了加列、但列最终不存在」的迁移（加完列就把表删掉）：
    //    旧实现只推进 user_version 会静默通过；真校验必须抛错且版本号不得前进。
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-verify-'));
    const vd = await openNodeSqliteDb(path.join(vdir, 'v.db'));
    const sneaky = {
      version: 902,
      name: 'sneaky-missing-column',
      up: (db2) => {
        db2.exec('CREATE TABLE IF NOT EXISTS s(v TEXT)');
        __addColumnForTest(db2, 's', 'w', 'TEXT');
        db2.exec('DROP TABLE s');
      },
    };
    assert.throws(() => __applyOneMigration(vd, sneaky), /校验失败/, '版本号推进了但列不存在必须抛错');
    assert.strictEqual(vd.pragma('user_version', { simple: true }), 0, '校验失败必须整体回滚，版本号不得前进');
    vd.close();
    fs.rmSync(vdir, { recursive: true, force: true });
    ok('ST3 迁移真校验：版本号推进但列未就位必须拦截且回滚');

    // ⑯ ST4：在线备份必须「能当独立库打开」，且不冻结源库（不是停写快照）。
    const { backupDb, pruneBackups, maybeDailyBackup } = require('../main/db/backup');
    const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-bak-'));
    const bfile = path.join(bdir, 'src.db');
    const bdb = await openNodeSqliteDb(bfile);
    bdb.exec('CREATE TABLE IF NOT EXISTS k(v TEXT)');
    bdb.prepare('INSERT INTO k VALUES (?)').run('在线备份');
    const dest = path.join(bdir, 'out.bak');
    const bres = backupDb(bdb, bfile, dest);
    assert.strictEqual(bres.ok, true, `备份应成功：${bres.error}`);
    assert.strictEqual(bres.verified, true, '备份必须通过 integrity_check 且含表');
    bdb.prepare('INSERT INTO k VALUES (?)').run('备份后新写'); // 源库仍可写
    assert.strictEqual(bdb.prepare('SELECT COUNT(*) c FROM k').get().c, 2, '源库备份后仍可写');
    const bakOpen = await openNodeSqliteDb(dest);
    assert.strictEqual(bakOpen.prepare('SELECT COUNT(*) c FROM k').get().c, 1, '备份只含备份时刻的 1 行');
    bakOpen.close();
    bdb.close();
    ok('ST4 在线备份：可独立打开 + 校验通过 + 不冻结源库');

    // ⑰ 轮转：只留最近 N 份，且不误删非备份文件
    const prDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-prune-'));
    for (const n of ['mjcode-tasks-20260101-000000.db', 'mjcode-tasks-20260102-000000.db',
      'mjcode-tasks-20260103-000000.db', 'keep-me.txt']) {
      fs.writeFileSync(path.join(prDir, n), 'x');
    }
    const removedBak = pruneBackups(prDir, 2);
    assert.strictEqual(removedBak.length, 1, '3 份只留 2 份 ⇒ 删 1 份');
    assert.ok(removedBak[0].endsWith('20260101-000000.db'), '删的是最旧那份');
    assert.ok(fs.existsSync(path.join(prDir, 'keep-me.txt')), '不得误删非备份文件');
    fs.rmSync(prDir, { recursive: true, force: true });
    ok('ST4 备份轮转：只留最近 N 份且不误删');

    // ⑱ 每天至多一次：同日第二次必须跳过（否则每次重启都拷一份 40MB 级库）
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-daily-'));
    const mfile = path.join(mdir, 'src.db');
    const mdb = await openNodeSqliteDb(mfile);
    mdb.exec('CREATE TABLE IF NOT EXISTS k(v TEXT)');
    const first = maybeDailyBackup(mdb, mfile, path.join(mdir, 'backups'), new Date('2026-11-05T09:00:00'));
    const second = maybeDailyBackup(mdb, mfile, path.join(mdir, 'backups'), new Date('2026-11-05T18:00:00'));
    assert.strictEqual(first.ok && !first.skipped, true, '当天首次应执行备份');
    assert.strictEqual(second.ok && second.skipped, true, '同一天第二次必须跳过');
    mdb.close();
    fs.rmSync(mdir, { recursive: true, force: true });
    ok('ST4 每日一次：同一天第二次跳过');

    // ⑲ 备份校验必须真的能拒坏文件——逐字节拷贝出「文件存在但不可恢复」的假备份，
    //    校验若恒返回 ok，恢复时才会发现备份没用（那时已经太晚）。
    const { verifySqliteFile } = require('../main/db/backup');
    const garbled = path.join(os.tmpdir(), `mj-garbled-${process.pid}.db`);
    fs.writeFileSync(garbled, Buffer.from('这不是 SQLite 文件'.repeat(10)));
    const badCheck = verifySqliteFile(garbled);
    assert.strictEqual(badCheck.ok, false, '截断/非 SQLite 文件必须被校验拒绝');
    fs.unlinkSync(garbled);
    ok('ST4 备份校验：坏文件必须被拒绝');

    // ⑭ ST3 退出兜底：exit 钩子只装一次（不随开库次数泄漏），且能真正关掉所有未关闭的库。
    const edir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-exit-'));
    const n0 = process.listenerCount('exit');
    const eds = [];
    for (let i = 0; i < 3; i += 1) {
      eds.push(await openNodeSqliteDb(path.join(edir, `e${i}.db`)));
    }
    assert.strictEqual(process.listenerCount('exit'), n0, 'exit 监听器不得随开库次数累积');
    const closed = require('../main/db/nodeSqliteDb').__runExitCloseForTest();
    assert.strictEqual(closed, 3, '退出钩子应关闭全部 3 个未关闭的库');
    assert.throws(() => eds[0].prepare('SELECT 1').get(), /./, '关闭后的库句柄不可再用');
    fs.rmSync(edir, { recursive: true, force: true });
    ok('ST3 退出兜底：exit 钩子单次安装（无泄漏）+ 退出时关闭全部未关闭库');
  } else {
    console.warn('  ⚠ 当前运行时无 node:sqlite，parity 仅覆盖 sql.js（这一段不算已验证）');
  }

  db.close();
  console.log(`\nsqljsDb 适配层：${n} 项全部通过`);
})().catch((e) => { console.error(e); process.exit(1); });
