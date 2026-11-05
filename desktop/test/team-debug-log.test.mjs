// 团队调试日志门禁（2026-10-21）
//
// 背景：用户报告「团队任务无人认领」，但界面只给一张结果卡；开发者拿不到中间态。
// 本套件守的是「日志通道本身可信」这件事：
//   · 默认开启 + 详细模式默认开启（用户要「全打出来」）；
//   · 落盘必须是可解析 JSONL，条目字段齐全；
//   · 用户会直接把日志发给别人 ⇒ 密钥必须脱敏、敏感键名必须剔除；
//   · 单条大字段必须截断，避免一次模型输出把文件撑爆；
//   · 导出 zip 必须真的包含日志文件与 meta.json。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const teamDebug = require(path.join(DESKTOP, 'main/teamDebugLog.js'));

let pass = 0, total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-teamdebug-'));
const logDir = path.join(tmp, 'logs');

function readTodayLines() {
  const names = fs.readdirSync(logDir).filter((n) => n.startsWith('team-debug-') && n.endsWith('.jsonl'));
  const out = [];
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(logDir, n), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

check('默认开启且详细模式开启（用户要「全打出来」）', () => {
  assert.equal(teamDebug.isEnabled(), true);
  assert.equal(teamDebug.isVerbose(), true);
});

teamDebug.initTeamDebugLog({ dir: logDir, meta: { version: 'test', platform: process.platform } });

check('初始化后日志目录存在且写入 debug_started', () => {
  assert.ok(fs.existsSync(logDir));
  const lines = readTodayLines();
  const started = lines.find((x) => x.scope === 'session' && x.event === 'debug_started');
  assert.ok(started, '缺少 debug_started 条目');
  assert.equal(started.data.meta.version, 'test');
});

check('基础日志落盘为可解析 JSONL，字段齐全', () => {
  const entry = teamDebug.log('worker', 'task_claim', { taskId: 't1', owner: 'm1' });
  assert.ok(entry && entry.seq > 0);
  const lines = readTodayLines();
  const hit = lines.find((x) => x.scope === 'worker' && x.event === 'task_claim' && x.data.taskId === 't1');
  assert.ok(hit, '未落盘或字段丢失');
  assert.equal(hit.level, 'basic');
  assert.equal(typeof hit.ts, 'number');
  assert.equal(typeof hit.iso, 'string');
  assert.equal(hit.data.owner, 'm1');
});

check('关闭详细模式后 verbose 条目被过滤，basic 仍写入', () => {
  teamDebug.setVerbose(false);
  const v = teamDebug.log('orchestrator', 'dag_raw', { content: 'RAW' }, { level: 'verbose' });
  assert.equal(v, null);
  const b = teamDebug.log('worker', 'task_settle', { status: 'done' });
  assert.ok(b);
  assert.equal(readTodayLines().some((x) => x.event === 'dag_raw'), false);
  teamDebug.setVerbose(true);
});

check('关闭记录后不写内存也不落盘', () => {
  teamDebug.setEnabled(false);
  const before = readTodayLines().length;
  assert.equal(teamDebug.log('worker', 'dispatch', { a: 1 }), null);
  assert.equal(readTodayLines().length, before);
  teamDebug.setEnabled(true);
});

check('密钥脱敏：sk- / Bearer / ghp_ / AKIA 与敏感键名', () => {
  teamDebug.log('ipc', 'secret_probe', {
    note: 'key=sk-abcdefghijklmnop1234 auth=Bearer abc.def.ghi repo=ghp_abcdefghijklmnopqrstuv aws=AKIAIOSFODNN7EXAMPLE',
    apiKey: 'plain-key-should-be-redacted',
    nested: { authorization: 'Bearer nested-token' },
  });
  const hit = readTodayLines().find((x) => x.event === 'secret_probe');
  assert.ok(hit);
  const text = JSON.stringify(hit);
  assert.equal(text.includes('sk-abcdefghijklmnop1234'), false);
  assert.equal(text.includes('Bearer abc.def.ghi'), false);
  assert.equal(text.includes('ghp_abcdefghijklmnopqrstuv'), false);
  assert.equal(text.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(text.includes('plain-key-should-be-redacted'), false);
  assert.equal(text.includes('nested-token'), false);
});

check('大字符串截断到 8000 字符，数组截断到 30 项', () => {
  const entry = teamDebug.log('worker', 'truncate_probe', {
    big: 'x'.repeat(20000),
    list: Array.from({ length: 50 }, (_, i) => i),
  });
  assert.equal(entry.data.big.length, 8000);
  assert.equal(entry.data.list.length, 31); // 30 项 + `[+20 more]` 标记
  assert.match(String(entry.data.list[30]), /\+20 more/);
});

check('tail 返回最近 N 条且不超过上限', () => {
  teamDebug._resetRing();
  for (let i = 0; i < 10; i += 1) teamDebug.log('worker', 'seq_probe', { i });
  const tail = teamDebug.tail(3);
  assert.equal(tail.length, 3);
  assert.equal(tail[2].data.i, 9);
  assert.equal(teamDebug.tail(99999).length, 10);
});

check('status 暴露开关、详细模式、目录与文件路径', () => {
  const st = teamDebug.status();
  assert.equal(st.ok, true);
  assert.equal(st.enabled, true);
  assert.equal(st.verbose, true);
  assert.equal(st.dir, logDir);
  assert.ok(st.file.startsWith(path.join(logDir, 'team-debug-')));
  assert.ok(st.bytes > 0);
  assert.ok(st.entries > 0);
});

check('导出 zip：包含日志文件与 meta.json，落 diagnostics 目录', () => {
  const r = teamDebug.exportBundle();
  assert.equal(r.ok, true, r.error);
  assert.ok(r.files >= 1);
  assert.ok(fs.existsSync(r.path));
  assert.equal(path.dirname(r.path), path.join(tmp, 'diagnostics'));
  const buf = fs.readFileSync(r.path);
  assert.equal(buf.subarray(0, 2).toString(), 'PK', '不是 zip 头');
  const asText = buf.toString('utf8');
  assert.ok(asText.includes('meta.json'), '缺少 meta.json');
  assert.ok(asText.includes('team-debug-'), '缺少日志文件条目');
});

check('appendFromRenderer 记录渲染层操作且 scope=renderer', () => {
  const entry = teamDebug.appendFromRenderer({ action: 'open_board', threadId: 'th-1', detail: { runId: 'r1' } });
  assert.ok(entry);
  assert.equal(entry.scope, 'renderer');
  assert.equal(entry.event, 'open_board');
  assert.equal(entry.data.threadId, 'th-1');
  assert.equal(teamDebug.appendFromRenderer({}), null, '空 action 必须拒绝');
});

// ST4-③ 实测复核发现的缺陷：`pruneOldFiles` 的过滤条件是 `endsWith('.jsonl')`，
// 而 20MB 轮转产物叫 `xxx.jsonl.1` —— 匹配不到，于是它永远不在被清理的集合里。
// 这里造 7 份按日文件 + 1 份**最老**的轮转产物：修好之后保留最近 7 个 ⇒ 被删的必须是那份 .1。
// （断言不能只看「删了 1 个」——那样即使删错对象也会过。）
check('轮转产物 .jsonl.1 也纳入「保留最近 7 个」', () => {
  const freshDir = path.join(tmp, 'rotate');
  fs.mkdirSync(freshDir, { recursive: true });
  const base = Date.now() - 30 * 86400000;
  for (let i = 0; i < 7; i += 1) {
    const f = path.join(freshDir, `team-debug-2020-01-0${i + 1}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    const t = new Date(base + (i + 1) * 1000);
    fs.utimesSync(f, t, t);
  }
  const rotated = path.join(freshDir, 'team-debug-2020-01-08.jsonl.1');
  fs.writeFileSync(rotated, '{}\n');
  fs.utimesSync(rotated, new Date(base), new Date(base)); // 比全部按日文件都老

  const modPath = path.join(DESKTOP, 'main/teamDebugLog.js');
  delete require.cache[require.resolve(modPath)];
  const fresh = require(modPath);
  fresh.initTeamDebugLog({ dir: freshDir, meta: { version: 'rotate' } });

  assert.equal(fs.existsSync(rotated), false, '轮转产物 .jsonl.1 必须一起参与保留数量裁剪');
  // 只统计「预置的 2020 系列」：initTeamDebugLog 紧接着会写出**今天**的日志文件，
  // 把它算进来会让「剩 7 个」的期望恒差 1（第一次写这条断言时就踩了）。
  const kept = fs.readdirSync(freshDir).filter((n) => /^team-debug-2020-.*\.jsonl$/.test(n)).sort();
  assert.deepEqual(kept, [
    'team-debug-2020-01-01.jsonl', 'team-debug-2020-01-02.jsonl', 'team-debug-2020-01-03.jsonl',
    'team-debug-2020-01-04.jsonl', 'team-debug-2020-01-05.jsonl', 'team-debug-2020-01-06.jsonl',
    'team-debug-2020-01-07.jsonl',
  ], `保留的必须是较新那批，实际：${kept.join(',')}`);
});

console.log(`\n${pass}/${total} 通过`);
fs.rmSync(tmp, { recursive: true, force: true });
