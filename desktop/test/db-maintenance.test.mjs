// 数据库维护 IPC 门禁（ST4-④，2026-11-05）
//
// 这批通道的失败形态是**不可逆的数据事故**，所以每条断言都盯「出事了会怎样」：
//   · 渲染层无法把任意路径塞进来（路径只来自系统对话框，导入第二步只认一次性令牌）；
//   · 体检不过就必须**一个令牌都不发**——否则后续 commit 就成了绕过体检的后门；
//   · 令牌错不能消费已选文件，令牌对也必须一次性；
//   · commit 成功只代表「已暂存」：**现库必须一个字节都没动**，真正换库发生在下次启动。
//
// 打桩口径同 localdata-id-guard / entry-ipc-eager：用 helpers/electronStub.mjs，
// 键由 require.resolve 现算（pnpm 的 node_modules 是符号链接，手拼键会让桩静默失效）。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { installElectronStub } from './helpers/electronStub.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const handlers = new Map();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-dbmaint-'));

// 可变的对话框结果：每个用例按需要改它，避免为每个用例重建模块
let saveResult = { canceled: true };
let openResult = { canceled: true, filePaths: [] };

installElectronStub({
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  app: { getPath: () => tmp },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showSaveDialog: async () => saveResult,
    showOpenDialog: async () => openResult,
  },
});

const liveDb = require(path.join(ROOT, 'main/db/liveDb.js'));
const { openNodeSqliteDb } = require(path.join(ROOT, 'main/db/nodeSqliteDb.js'));
const { initDbMaintenanceIpc, __resetPendingPickForTest } = require(path.join(ROOT, 'main/ipc/dbMaintenance.js'));

const DB = path.join(tmp, 'mjcode-tasks.db');
const TARGET_VERSION = 19;

/** 造一个「本应用的库」：必须有 task_groups 表（导入体检的 fail-closed 判据之一）。 */
function makeAppDb(file, { version = TARGET_VERSION, rows = 1, withTable = true } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(file);
  if (withTable) {
    d.exec('CREATE TABLE task_groups (id INTEGER PRIMARY KEY, title TEXT);');
    for (let i = 0; i < rows; i += 1) d.exec(`INSERT INTO task_groups (title) VALUES ('g${i}');`);
  } else {
    d.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY);');
  }
  d.exec(`PRAGMA user_version = ${version};`);
  d.close();
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function call(channel, payload) {
  const fn = handlers.get(channel);
  assert.ok(fn, `通道 ${channel} 未注册`);
  return fn({}, payload);
}

let pass = 0;
let total = 0;
async function check(name, fn) {
  total += 1;
  try { await fn(); console.log(`[PASS] ${name}`); pass += 1; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// 现库：真实打开一个 node:sqlite 连接并广播「库已就绪」，后续备份走的就是它
makeAppDb(DB, { rows: 3 });
const db = await openNodeSqliteDb(DB);
liveDb.publish(db);
initDbMaintenanceIpc();

await check('四个通道都注册上了（不是"写了没接线"）', () => {
  for (const ch of ['db:backup/create', 'db:backup/export', 'db:import/pick', 'db:import/commit']) {
    assert.ok(handlers.has(ch), `${ch} 未注册`);
  }
});

await check('立即备份：落 backups/、可独立打开、含现库数据', async () => {
  const r = await call('db:backup/create');
  assert.equal(r.ok, true, `备份失败：${r.error}`);
  const file = path.join(tmp, 'backups', r.name);
  assert.ok(fs.existsSync(file), `备份文件不存在：${file}`);
  assert.equal(r.verified, true, '运行时能校验却没校验（verified 不应为 false）');
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(file, { readOnly: true });
  const n = d.prepare('SELECT count(*) c FROM task_groups').get().c;
  d.close();
  assert.equal(Number(n), 3, `快照里的数据不对：${n}`);
});

await check('导出：取消对话框 ⇒ EXPORT_CANCELLED，且不产生文件', async () => {
  saveResult = { canceled: true };
  const r = await call('db:backup/export');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXPORT_CANCELLED');
  assert.equal(fs.existsSync(path.join(tmp, 'should-not-exist.db')), false);
});

await check('导出：写到用户选的位置，产物可打开', async () => {
  const out = path.join(tmp, 'export-ok.db');
  saveResult = { canceled: false, filePath: out };
  const r = await call('db:backup/export');
  assert.equal(r.ok, true, `导出失败：${r.error}`);
  assert.equal(r.path, out);
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(out, { readOnly: true });
  const n = d.prepare('SELECT count(*) c FROM task_groups').get().c;
  d.close();
  assert.equal(Number(n), 3, '导出产物数据不对');
});

await check('导入体检：非本库（缺 task_groups）被拒，且不发令牌', async () => {
  __resetPendingPickForTest();
  const bad = path.join(tmp, 'not-ours.db');
  makeAppDb(bad, { withTable: false });
  openResult = { canceled: false, filePaths: [bad] };
  const r = await call('db:import/pick');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INSPECT_REJECTED');
  assert.equal(r.token, undefined, '体检不过却发了令牌 ⇒ 等于开后门');
  // 没有令牌 ⇒ 后续 commit 必然是 NO_PICK（链路在第一步就断了）
  const c = await call('db:import/commit', { token: 'whatever' });
  assert.equal(c.code, 'NO_PICK');
});

await check('导入体检：高版本快照被拒（降级会丢字段）', async () => {
  __resetPendingPickForTest();
  const future = path.join(tmp, 'future.db');
  makeAppDb(future, { version: TARGET_VERSION + 5 });
  openResult = { canceled: false, filePaths: [future] };
  const r = await call('db:import/pick');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INSPECT_REJECTED');
  assert.ok(String(r.error).includes('高于'), `错误信息要指出方向，实际：${r.error}`);
});

await check('导入第二步：令牌不对 ⇒ BAD_TOKEN，且不动现库', async () => {
  __resetPendingPickForTest();
  const good = path.join(tmp, 'good.db');
  makeAppDb(good, { rows: 1 });
  openResult = { canceled: false, filePaths: [good] };
  const picked = await call('db:import/pick');
  assert.equal(picked.ok, true, `体检查不过：${picked.error}`);

  const before = sha(DB);
  const r = await call('db:import/commit', { token: 'deadbeef' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_TOKEN');
  assert.equal(sha(DB), before, '令牌不匹配却动了现库');
  assert.equal(fs.existsSync(path.join(tmp, 'import-pending.db')), false, '令牌不匹配却写了暂存');
});

await check('令牌过长 ⇒ BAD_PAYLOAD（形状在边界守，不进业务）', async () => {
  const r = await call('db:import/commit', { token: 'x'.repeat(200) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_PAYLOAD');
});

await check('导入第二步：令牌正确 ⇒ 暂存成功、需重启、现库一个字节没动', async () => {
  __resetPendingPickForTest();
  const good = path.join(tmp, 'good2.db');
  makeAppDb(good, { rows: 2 });
  openResult = { canceled: false, filePaths: [good] };
  const picked = await call('db:import/pick');
  assert.equal(picked.ok, true, `体检查不过：${picked.error}`);
  assert.equal(picked.userVersion, TARGET_VERSION);
  assert.equal(picked.needsUpgrade, false);

  const before = sha(DB);
  const r = await call('db:import/commit', { token: picked.token });
  assert.equal(r.ok, true, `暂存失败：${r.error}`);
  assert.equal(r.needsRestart, true, '必须如实告诉用户还要重启（换库发生在下次启动）');
  assert.equal(sha(DB), before, 'commit 阶段不得改动现库');
  assert.ok(fs.existsSync(path.join(tmp, 'import-pending.db')), '暂存快照缺失');
  assert.ok(fs.existsSync(path.join(tmp, 'import-pending.json')), '暂存标记缺失（没有它启动时不会换库）');
});

await check('令牌一次性：再提交一次 ⇒ NO_PICK', async () => {
  const r = await call('db:import/commit', { token: 'whatever' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_PICK');
});

await check('库未就绪 ⇒ UNAVAILABLE（而不是抛错或假装成功）', async () => {
  liveDb._reset();
  const b = await call('db:backup/create');
  assert.equal(b.ok, false);
  assert.equal(b.code, 'UNAVAILABLE');
  const e = await call('db:backup/export');
  assert.equal(e.code, 'UNAVAILABLE');
  liveDb.publish(db); // 复原，避免影响收尾
});

console.log(`\n${pass}/${total} 通过`);
