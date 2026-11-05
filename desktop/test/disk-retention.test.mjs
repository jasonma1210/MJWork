// 磁盘保留策略门禁（ST4-③，2026-11-05）
//
// 这个模块**删文件**，删错了不可逆。所以每条规则都必须有正反两面样本：
//   · 该删的必须真的删（否则「磁盘只增不减」等于没做，是最常见的假绿）；
//   · 不该删的要**逐个别名验证仍在**——只断言「删掉了 N 个」的话，删错对象一样会过；
//   · 今天正在写的文件、最高版本的迁移回滚点：无条件保留（哪怕 keep 配成 0）；
//   · 符号链接 / 目录 / 名字里日期非法的文件：一律不碰。
//
// 另一个易漏点：`ok` 不能被「没东西可清」蒙混。扫描本身失败（目录读不了）必须是
// 明确的失败信号，而不是返回一个空清单让上层以为「很干净」。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { runRetention, summarize, fileDayTs } = require(path.join(DESKTOP, 'main/diskRetention.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total += 1;
  try { fn(); console.log(`[PASS] ${name}`); pass += 1; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const NOW = new Date('2026-11-05T12:00:00Z');
const dayKey = (d) => d.toISOString().slice(0, 10);

let seq = 0;
function newDir() {
  seq += 1;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `mjcode-retention-${seq}-`));
  fs.mkdirSync(path.join(d, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'diagnostics'), { recursive: true });
  return d;
}

function touch(file, bytes = 8) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(bytes));
}

// ── 1. 主进程日志按天过期 ──
check('main-*.log 超过保留天数才删，边界内保留', () => {
  const d = newDir();
  const old = path.join(d, 'logs', 'main-2026-10-01.log');
  const edgeOut = path.join(d, 'logs', 'main-2026-10-22.log'); // 14 天窗口外（cutoff=10-23）
  const edgeIn = path.join(d, 'logs', 'main-2026-10-24.log');
  const today = path.join(d, 'logs', 'main-2026-11-05.log');
  [old, edgeOut, edgeIn, today].forEach((f) => touch(f));

  const r = runRetention(d, { now: NOW, mainLogKeepDays: 14 });
  assert.equal(fs.existsSync(old), false, '35 天前的必须删');
  assert.equal(fs.existsSync(edgeOut), false, '窗口外 1 天（10-22）必须删');
  assert.equal(fs.existsSync(edgeIn), true, '窗口内（10-24）误删');
  assert.equal(fs.existsSync(today), true, '今天的日志误删');
  assert.equal(r.ok, true, `正常路径应 ok（errors=${JSON.stringify(r.errors)}）`);
  assert.equal(r.removed.length, 2, `只应删 2 份，实际 ${r.removed.length}`);
});

// ── 2. 崩溃日志同样按天过期（它此前完全没有过期机制，实测堆积 11 份）──
check('diagnostics/crash-*.jsonl 按天过期', () => {
  const d = newDir();
  const dead = path.join(d, 'diagnostics', 'crash-2026-10-20.jsonl');
  const alive = path.join(d, 'diagnostics', 'crash-2026-11-01.jsonl');
  touch(dead); touch(alive);
  runRetention(d, { now: NOW, crashLogKeepDays: 14 });
  assert.equal(fs.existsSync(dead), false, '19 天前的崩溃记录必须删');
  assert.equal(fs.existsSync(alive), true, '4 天前的崩溃记录误删');
});

// ── 3. 迁移快照按「版本号」保留，且三件套一起处理 ──
check('迁移快照保留最高 2 个版本，.bak/-wal/-shm 三件套同进同出', () => {
  const d = newDir();
  const files = [
    'mjcode-tasks.db.pre-v10.bak',
    'mjcode-tasks.db.pre-v11.bak',
    'mjcode-tasks.db.pre-v17.bak', 'mjcode-tasks.db.pre-v17.bak-wal', 'mjcode-tasks.db.pre-v17.bak-shm',
    'mjcode-tasks.db.pre-v18.bak', 'mjcode-tasks.db.pre-v18.bak-wal', 'mjcode-tasks.db.pre-v18.bak-shm',
  ];
  files.forEach((n) => touch(path.join(d, n), 32));

  runRetention(d, { now: NOW });

  for (const n of ['mjcode-tasks.db.pre-v10.bak', 'mjcode-tasks.db.pre-v11.bak']) {
    assert.equal(fs.existsSync(path.join(d, n)), false, `旧版本快照 ${n} 必须删`);
  }
  for (const suffix of ['bak', 'bak-wal', 'bak-shm']) {
    assert.equal(fs.existsSync(path.join(d, `mjcode-tasks.db.pre-v18.${suffix}`)), true, `最高版本 v18 的 ${suffix} 误删（这是 v18→v19 的回滚点）`);
    assert.equal(fs.existsSync(path.join(d, `mjcode-tasks.db.pre-v17.${suffix}`)), true, `次高版本 v17 的 ${suffix} 误删`);
  }
});

// ── 4. 最高版本无条件保留：即使把 keep 配成 0 ──
check('migrationSnapshotVersions=0 时仍保留最高版本（回滚点不可删空）', () => {
  const d = newDir();
  touch(path.join(d, 'mjcode-tasks.db.pre-v17.bak'));
  touch(path.join(d, 'mjcode-tasks.db.pre-v18.bak'), 4096);
  runRetention(d, { now: NOW, migrationSnapshotVersions: 0 });
  assert.equal(fs.existsSync(path.join(d, 'mjcode-tasks.db.pre-v18.bak')), true, '最高版本被删空 ⇒ 永久失去回滚能力');
  assert.equal(fs.existsSync(path.join(d, 'mjcode-tasks.db.pre-v17.bak')), false, 'keep 压到 1 时次高版本应被清掉');
});

// ── 5. 今天正在写的文件无条件保留 ──
check('keepDays=0 时今天的日志仍保留（正在写的文件不能删）', () => {
  const d = newDir();
  const today = path.join(d, 'logs', `main-${dayKey(NOW)}.log`);
  touch(today);
  runRetention(d, { now: NOW, mainLogKeepDays: 0 });
  assert.equal(fs.existsSync(today), true, '今天的日志被 keepDays=0 删掉了');
});

// ── 6. 白名单之外的文件一个都不许动 ──
check('规则外文件逐个保留（含 local-data 日期副本 / team-debug / 非本模块的 .bak）', () => {
  const d = newDir();
  const bystanders = [
    'logs/main-2020-01-01.log.bak',
    'logs/main-old.log',
    'logs/team-debug-2016-01-01.jsonl',
    'diagnostics/crash-old.jsonl',
    'mjcode-tasks.db.bak',
    'mjcode-tasks.db.pre-repair-2026-10-29.bak',
    'local-data.2016-01-01.json',
    'keep-me.txt',
  ];
  bystanders.forEach((n) => touch(path.join(d, n)));
  const r = runRetention(d, { now: NOW });
  for (const n of bystanders) {
    assert.equal(fs.existsSync(path.join(d, n)), true, `规则外文件 ${n} 被误删`);
  }
  assert.equal(r.removed.length, 0, `不该删任何文件，实际删了 ${r.removed.map((x) => x.name).join(',')}`);
});

// ── 7. 符号链接不碰（删链接会连带影响目标，删目标更是灾难）──
check('符号链接跳过：链接与目标都保留', () => {
  const d = newDir();
  // 目标放在 userData 根、且名字不受任何规则管辖——这样目标本身不会被删，
  // 「链接是否还在」才是一个干净的信号（否则目标被删后链接变断链，existsSync 会跟着假阴）。
  const target = path.join(d, 'keep-target.bin');
  touch(target);
  const link = path.join(d, 'logs', 'main-2026-01-02.log');
  fs.symlinkSync(target, link);

  const r = runRetention(d, { now: NOW });
  // 断链/软链都必须用 lstat 判存在：existsSync 会跟随链接。
  const linkStillThere = (() => { try { return fs.lstatSync(link).isSymbolicLink(); } catch { return false; } })();
  assert.equal(linkStillThere, true, '符号链接被删');
  assert.equal(fs.existsSync(target), true, '链接目标被删');
  assert.equal(r.removed.some((x) => x.name === 'main-2026-01-02.log'), false, '符号链接不得进入删除清单');
});

// ── 8. dryRun 只统计不删 ──
check('dryRun 返回清单但一个文件都不删', () => {
  const d = newDir();
  const old = path.join(d, 'logs', 'main-2026-01-01.log');
  touch(old);
  const r = runRetention(d, { now: NOW, dryRun: true });
  assert.equal(fs.existsSync(old), true, 'dryRun 竟然真删了');
  assert.equal(r.dryRun, true);
  assert.equal(r.removed.length, 1, 'dryRun 也要给出「本来会删什么」');
  assert.ok(summarize(r).includes('待清理'), `dryRun 摘要必须写「待清理」而不是「已清理」，实际：${summarize(r)}`);
});

// ── 9. 入参缺失不抛，且必须是失败形态 ──
check('userDataDir 为空 ⇒ ok:false 且不抛（不能伪装成"很干净"）', () => {
  const r = runRetention('', { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.removed.length, 0);
  assert.ok(r.errors.length >= 1, '必须留下失败原因');
});

// ── 10. 扫描失败不能伪装成「没东西可清」──
check('logs 是普通文件（ENOTDIR）⇒ 记入 errors 而非静默返回空清单', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-retention-enotdir-'));
  fs.writeFileSync(path.join(d, 'logs'), 'not a dir');
  const r = runRetention(d, { now: NOW });
  assert.equal(r.ok, false, '扫描失败必须是 ok:false');
  assert.ok(r.errors.length >= 1, '扫描异常必须被记下来');
  assert.ok(String(r.errors[0].error).length > 0, '错误项要带原因');
});

// ── 11. 名字里日期非法的文件不参与（Date.parse 会把 02-31 归一化成 03-03）──
check('非法日期文件名不参与清理', () => {
  assert.equal(fileDayTs('main-2026-02-31.log', /^main-(\d{4})-(\d{2})-(\d{2})\.log$/), null, '2026-02-31 不是合法日期');
  assert.equal(fileDayTs('main-2026-13-01.log', /^main-(\d{4})-(\d{2})-(\d{2})\.log$/), null, '13 月不是合法月份');
  const d = newDir();
  const bogus = path.join(d, 'logs', 'main-2026-02-31.log');
  touch(bogus);
  runRetention(d, { now: NOW });
  assert.equal(fs.existsSync(bogus), true, '非法日期的文件不该被当成过期文件');
});

// ── 12. 摘要只在真的有事发生时才非空（否则每次启动刷一行噪音）──
check('无清理时摘要为空串，有清理时含「已清理」与份数', () => {
  const clean = newDir();
  const r1 = runRetention(clean, { now: NOW });
  assert.equal(summarize(r1), '', '没东西可清时不该产出摘要');

  const dirty = newDir();
  touch(path.join(dirty, 'logs', 'main-2026-01-01.log'));
  const r2 = runRetention(dirty, { now: NOW });
  const s = summarize(r2);
  assert.ok(s.includes('已清理') && s.includes('1 份'), `摘要内容不对：${s}`);
});

console.log(`\n${pass}/${total} 通过`);
