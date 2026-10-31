// Wave A7: SIGKILL durability regression. Exercises data already acknowledged as durable,
// then proves recovery from a killed writer without relying on process exit hooks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-crash-durability-'));
let pass = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    console.error(`[FAIL] ${name} — ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

function launchAndKill(label, script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], {
      cwd: DESKTOP,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeout = setTimeout(() => {
      if (!killed) {
        child.kill('SIGKILL');
        reject(new Error(`${label}: 子进程未就绪，超时。stdout=${stdout} stderr=${stderr}`));
      }
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!killed && stdout.includes('DURABLE_READY')) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (!killed) {
        reject(new Error(`${label}: 子进程提前退出 code=${code} signal=${signal}; stdout=${stdout}; stderr=${stderr}`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function assertKilled(result, label) {
  assert.equal(result.signal, 'SIGKILL', `${label} 必须由 SIGKILL 终止（code=${result.code}）`);
}

try {
  // 1. localStore 的 synchronous durable write：创建线程返回后立刻杀死进程。
  const localDir = path.join(tmp, 'local-store');
  const localChild = await launchAndKill('localStore', `
    const { LocalStore } = require('./main/store/localStore');
    const store = new LocalStore(process.argv[1]);
    store.createThread({ title: 'kill-9-durable-thread', cwd: '/tmp/crash-test' });
    console.log('DURABLE_READY');
    setInterval(() => {}, 1000);
  `, [localDir]);
  check('localStore child really received SIGKILL', () => assertKilled(localChild, 'localStore'));
  const { LocalStore } = require('../main/store/localStore');
  const localRecovered = new LocalStore(localDir);
  check('SIGKILL 后 localStore 已确认写入的数据可恢复', () => {
    assert.ok(localRecovered.data.threads.some((thread) => thread.title === 'kill-9-durable-thread'));
  });

  // 2. IntentLog T0 appendNow returns only after write+fsync; kill before normal exit hooks.
  const logFile = path.join(tmp, 'intent', 'ops.jsonl');
  const intentChild = await launchAndKill('intentLog', `
    const { IntentLog } = require('./main/data/intentLog');
    const log = new IntentLog(process.argv[1]);
    const opened = log.open();
    if (!opened.ok) throw new Error(opened.error);
    log.appendNow({ type: 'test', payload: { marker: 'kill-9-t0-record' } });
    console.log('DURABLE_READY');
    setInterval(() => {}, 1000);
  `, [logFile]);
  check('IntentLog child really received SIGKILL', () => assertKilled(intentChild, 'IntentLog'));
  const { IntentLog } = require('../main/data/intentLog');
  const recoveredLog = new IntentLog(logFile);
  assert.equal(recoveredLog.open().ok, true);
  const replayed = [];
  const replayResult = recoveredLog.replay((record) => replayed.push(record));
  check('SIGKILL 后 T0 IntentLog 记录重放成功', () => {
    assert.equal(replayResult.applied, 1);
    assert.equal(replayed[0]?.payload?.marker, 'kill-9-t0-record');
  });

  // 3. Simulate the exact crash tail: valid fsynced line followed by an incomplete JSON fragment.
  fs.appendFileSync(logFile, '{"seq":999,"type":"partial-tail');
  const recoveredTailLog = new IntentLog(logFile);
  const openedTail = recoveredTailLog.open();
  check('重启时截断 IntentLog 末尾半行且保留之前的完整记录', () => {
    assert.equal(openedTail.ok, true);
    assert.ok(fs.readFileSync(logFile, 'utf8').endsWith('\n'));
    const again = [];
    const r = recoveredTailLog.replay((record) => again.push(record));
    assert.equal(r.applied, 1);
    assert.equal(again[0]?.payload?.marker, 'kill-9-t0-record');
  });
  const next = recoveredTailLog.appendNow({ type: 'test', payload: { marker: 'after-tail-recovery' } });
  const finalLog = new IntentLog(logFile);
  finalLog.open();
  const finalRecords = [];
  finalLog.replay((record) => finalRecords.push(record));
  check('半行截断后继续追加仍保持 seq 单调且无粘连损坏', () => {
    assert.equal(next.seq, 2);
    assert.deepEqual(finalRecords.map((record) => record.seq), [1, 2]);
    assert.deepEqual(finalRecords.map((record) => record.payload.marker), ['kill-9-t0-record', 'after-tail-recovery']);
  });
  finalLog.close();
  recoveredTailLog.close();

  // 4. sql.js snapshot: flush acknowledged state, kill the writer, then reopen the DB.
  const dbDir = path.join(tmp, 'sqljs');
  const dbFile = path.join(dbDir, 'crash-test.db');
  const dbChild = await launchAndKill('sql.js', `
    (async () => {
      const { openSqliteJsDb } = require('./main/db/sqljsDb');
      const db = await openSqliteJsDb(process.argv[1]);
      db.exec('CREATE TABLE crash_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare('INSERT INTO crash_probe (id, value) VALUES (?, ?)').run('probe-1', 'kill-9-sqljs');
      db.flush();
      console.log('DURABLE_READY');
      setInterval(() => {}, 1000);
    })().catch((err) => { console.error(err); process.exit(2); });
  `, [dbFile]);
  check('sql.js child really received SIGKILL', () => assertKilled(dbChild, 'sql.js'));
  const { openSqliteJsDb } = require('../main/db/sqljsDb');
  const dbRecovered = await openSqliteJsDb(dbFile);
  const row = dbRecovered.prepare('SELECT value FROM crash_probe WHERE id = ?').get('probe-1');
  check('SIGKILL 后已 flush 的 sql.js 数据库可重开读取', () => assert.equal(row?.value, 'kill-9-sqljs'));
  dbRecovered.close();

  console.log(`\ncrash durability: ${pass}/8 checks passed`);
  if (pass !== 8) process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
