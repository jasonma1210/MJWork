// 知识库性能验收门禁（M3 出口条件「性能通过」，2026-10-27）
//
// 为什么要有这条：M3 出口写的是「本机 KB 全链路、**安全与性能**通过」，而我此前只交了功能与安全。
// 补测发现的不是「慢一点」而是**直接不可用**：
//   · 原实现每个词元发 3 条 SQL（保 term / 写 posting / df+1）⇒ 500KB 高熵中文要 25.8s；
//   · sql.js 落盘是「全量 export 内存库」，导入期间反复触发 ⇒ 2MB 就足以把进程打爆。
// 两个都改了（批量语句 + 导入期挂起落盘），并据此把文件上限从 5MB 压到实测可用的 2MB。
//
// 阈值取「实测值 × 数倍」而不是紧贴实测：CI 更慢、负载更高，贴着立阈值只会换来一堆与产品无关的红。
// 数字一律打印出来便于看趋势；这里的作用是**守住数量级**，不是做基准测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const kb = require(path.join(DESKTOP, 'main/knowledgeBaseQuery.js'));
const { openSqliteJsDb } = require(path.join(DESKTOP, 'main/db/sqljsDb.js'));

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.error(`❌ ${name} — ${e.message}`); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-perf-'));
const db = await openSqliteJsDb(path.join(TMP, 'perf.sqlite'));
db.exec(kb.KB_SCHEMA);
const storageDir = path.join(TMP, 'store');

/**
 * 高熵中文语料（最坏情况：词项几乎不重复）。
 * ⚠ 生成方式必须「先算字符数再一次性填充」：初版写成 `while (Buffer.byteLength(s) < n) s += ch`，
 * 每次循环都对整串重算字节长度再拼串，是 O(n²) —— 生成 2MB 语料本身就把测试进程拖死，
 * 于是「性能门禁」测到的其实是自己的生成器。
 */
function entropyText(bytes) {
  const chars = Math.max(1, Math.floor((bytes - 64) / 3)); // UTF-8 中文 3 字节/字
  const out = new Array(chars);
  let seed = 9;
  for (let i = 0; i < chars; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = String.fromCharCode(0x4e00 + (seed % 3000));
  }
  return out.join('');
}

/** 真实形态语料（中英混排、高度重复，接近手册/合同这类文档） */
function proseText(bytes) {
  const unit = '本地知识库检索测试段落，包含项目验收标准与交付口径说明。The quick brown fox jumps over the lazy dog. ';
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function write(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const caps = kb.capabilities();
const MAX_FILE_BYTES = caps.maxFileBytes;

await check('① 256KB 真实形态文档：导入 < 8s，检索 < 500ms 且有命中', async () => {
  const f = write('prose256.txt', proseText(256 * 1024));
  const t0 = Date.now();
  const r = await kb.importDocument({ db, storageDir, projectId: 'P', filePath: f, actorId: 'owner' });
  const importMs = Date.now() - t0;
  assert.equal(r.ok, true, r.code || r.reason);
  const t1 = Date.now();
  const s = kb.search({ db, projectId: 'P', query: '验收标准' });
  const searchMs = Date.now() - t1;
  console.log(`   [perf] 256KB 真实形态：导入 ${importMs}ms（${r.chunks} 分块），检索 ${searchMs}ms，命中 ${s.items.length}`);
  assert.ok(importMs < 8000, `导入过慢：${importMs}ms`);
  assert.ok(searchMs < 500, `检索过慢：${searchMs}ms`);
  assert.ok(s.items.length > 0, '检索无命中（性能数字无意义）');
});

await check('① 512KB 高熵中文（最坏情况）：导入 < 20s，检索 < 800ms', async () => {
  const f = write('entropy512.txt', entropyText(512 * 1024));
  const t0 = Date.now();
  const r = await kb.importDocument({ db, storageDir, projectId: 'P', filePath: f, actorId: 'owner' });
  const importMs = Date.now() - t0;
  const postings = db.prepare('SELECT COUNT(*) AS n FROM knowledge_index_postings').get().n;
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  console.log(`   [perf] 512KB 高熵：导入 ${importMs}ms，倒排累计 ${postings} 条，RSS ${rss}MB`);
  assert.equal(r.ok, true, r.code || r.reason);
  assert.ok(importMs < 20000, `导入过慢：${importMs}ms`);
  const t1 = Date.now();
  kb.search({ db, projectId: 'P', query: '中文' });
  const searchMs = Date.now() - t1;
  assert.ok(searchMs < 800, `检索过慢：${searchMs}ms`);
});

await check('② 超出文件上限：立即拒绝（FILE_TOO_LARGE），不解析、不落库', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM knowledge_sources').get().n;
  // 用 ASCII 填充：这里要测的是「超限判定」，不该让语料生成成为瓶颈
  const big = write('too-big.txt', 'x'.repeat(MAX_FILE_BYTES + 1024));
  const t0 = Date.now();
  const r = await kb.importDocument({ db, storageDir, projectId: 'P', filePath: big, actorId: 'owner' });
  const ms = Date.now() - t0;
  console.log(`   [perf] 超限拒绝耗时 ${ms}ms（上限 ${Math.round(MAX_FILE_BYTES / 1024)}KB）`);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FILE_TOO_LARGE');
  assert.ok(ms < 2000, `超限判定过慢：${ms}ms（应先看 size 再解析）`);
  const after = db.prepare('SELECT COUNT(*) AS n FROM knowledge_sources').get().n;
  assert.equal(after, before, '超限文件不应产生 source 行');
});

await check('② 上限是「实测可用值」，且同时声明了索引规模上限', () => {
  // 防「嫌 2MB 太小又调回 5MB」：5MB 在本机实测会把进程打爆（exit 137）。
  // 真要调大，必须先有新的实测证据（换驱动/换存储），而不是改个数字。
  assert.ok(MAX_FILE_BYTES <= 2 * 1024 * 1024, `上限被调大到 ${MAX_FILE_BYTES}，需先补 5MB 级别的实测证据`);
  assert.ok(caps.maxIndexPostings > 0, '缺少索引规模上限声明（内存库必须有第二道闸）');
});

await check('③ 重复导入同内容：耗时同量级（无 O(n²) 退化）', async () => {
  const f = write('dup.txt', proseText(128 * 1024));
  const t0 = Date.now();
  await kb.importDocument({ db, storageDir, projectId: 'P', filePath: f, actorId: 'owner' });
  const first = Date.now() - t0;
  const t1 = Date.now();
  await kb.importDocument({ db, storageDir, projectId: 'P', filePath: f, actorId: 'owner' });
  const second = Date.now() - t1;
  console.log(`   [perf] 128KB 首次 ${first}ms，第二次 ${second}ms`);
  assert.ok(second < Math.max(first * 5, 5000), `第二次导入异常变慢：${first}ms → ${second}ms`);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\nknowledge-perf: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
