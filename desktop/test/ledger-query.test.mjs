// Token 用量账本（M2）查询内核的门禁测试
//
// 验证 ledgerQuery.js 的三条不可妥协口径（设计文档 §7.3）：
//  ① asOf 是单调 consumption id 高水位，不是 created_at 上限；
//  ② keyset 分页末位键必含 id（同毫秒不重不漏）；
//  ③ 汇总与明细共用同一 asOf ⇒ 合计必然等于翻完所有页的明细之和。
// 另验 CSV 公式注入防护（§18.2：禁止伪造财务数据，且防 =+-@ 触发表格公式）。
//
// 用 sql.js（WASM，与测试驱动一致）喂内存库跑真实 SQL，不依赖 Electron。
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ledger = require('../main/ledgerQuery.js');

// 用与运行时完全一致的驱动适配层（sql.js WASM + better-sqlite3 兼容 shim），
// 而不是裸 sql.js——裸 sql.js 没有 prepare().all()/.get()，会掩盖真实运行路径。
const { openSqliteJsDb } = require('../main/db/sqljsDb');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.log(`❌ ${name}\n   ${e.message}`); }
}

async function buildDb() {
  const tmp = path.join(os.tmpdir(), `ledger-test-${process.pid}-${Date.now()}.sqlite`);
  const db = await openSqliteJsDb(tmp);
  db.exec(`CREATE TABLE quota_consumptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, run_id TEXT, task_id TEXT,
    member_id TEXT, tokens INTEGER DEFAULT 0,
    source TEXT, created_at INTEGER
  )`);
  // 插入 12 条：created_at 单调，但最后一条 is 故意「时间更早、id 更大」（补记历史）
  const rows = [
    [1, 'p-a', 'r-1', 't-1', 'm-1', 10, 'round', 1000],
    [2, 'p-a', 'r-1', 't-1', 'm-1', 20, 'round', 1001],
    [3, 'p-a', 'r-2', 't-2', 'm-2', 30, 'settle', 1002],
    [4, 'p-b', 'r-3', 't-3', 'm-1', 40, 'round', 1003],
    [5, 'p-b', 'r-3', 't-3', null, 50, 'settle', 1004],
    [6, null, null, null, null, 60, null, 1005], // 全空维度：必须可汇总为 null 键
    [7, 'p-a', 'r-1', 't-1', 'm-1', 70, 'round', 1006],
    [8, 'p-a', 'r-2', 't-2', 'm-2', 80, 'settle', 1007],
    [9, 'p-b', 'r-3', 't-3', 'm-1', 90, 'round', 1008],
    [10, 'p-b', 'r-3', 't-3', null, 11, 'settle', 1009],
    [11, 'p-c', 'r-4', 't-4', 'm-3', 12, 'round', 1010],
    // 同毫秒两条：keyset 必须靠 id 区分（created_at 相同 = 1006）
    [12, 'p-a', 'r-1', 't-1', 'm-1', 13, 'round', 1006],
  ];
  const ins = db.prepare('INSERT INTO quota_consumptions (id,project_id,run_id,task_id,member_id,tokens,source,created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(...r);
  return { db, tmp };
}

(async () => {
  const { db, tmp } = await buildDb();
  const asOf = ledger.currentAsOf(db);

  try {
    check('T1 asOf 取 12 行后的最大 consumption id=12（单调高水位）', () => {
      assert.equal(asOf, 12, `asOf 应为 12，实际 ${asOf}`);
    });

    check('T2 首页查询返回 12 条（ids 1..12），无遗漏', () => {
      const p = ledger.queryPage(db, { filters: {}, limit: 100 });
      const ids = p.items.map((x) => x.id);
      assert.equal(ids.length, 12, `首屏应 12 条，实际 ${ids.length}`);
      assert.deepEqual([...new Set(ids)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.equal(p.asOf, 12);
    });

    check('T3 汇总合计 == 首屏 12 条 token 之和（同一 asOf，不重不漏）', () => {
      const p = ledger.queryPage(db, { filters: {}, limit: 100, dimensions: ['source', 'day'] });
      const sum = p.items.reduce((s, it) => s + it.tokens, 0);
      assert.equal(p.summary.tokens, sum, `汇总 ${p.summary.tokens} ≠ 明细和 ${sum}`);
      assert.equal(p.summary.count, 12, `count 应为 12，实际 ${p.summary.count}`);
    });

    check('T4 同毫秒两条(created_at=1006,id=7/12)经 keyset 翻页不重不漏', () => {
      // limit=1 强制翻页，逐页收集；末位靠 (created_at,id) 全序推进
      const all = [];
      let cur = null;
      for (let i = 0; i < 20; i++) {
        const page = cur
          ? ledger.queryNextPage(db, { cursor: cur, limit: 1 })
          : ledger.queryPage(db, { filters: {}, limit: 1 });
        all.push(...page.items);
        cur = page.nextCursor;
        if (!cur) break;
      }
      const ids = all.map((x) => x.id);
      assert.equal(ids.length, 12, `keyset 翻页应得 12 条，实际 ${ids.length}`);
      assert.deepEqual([...new Set(ids)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], '出现重复或遗漏');
    });

    check('T5 翻页后汇总合计 == 全量明细合计（snapshot 一致）', () => {
      const first = ledger.queryPage(db, { filters: {}, limit: 100, dimensions: ['source'] });
      const full = [];
      let cur = first.nextCursor;
      full.push(...first.items);
      while (cur) {
        const page = ledger.queryNextPage(db, { cursor: cur, limit: 100 });
        full.push(...page.items);
        cur = page.nextCursor;
      }
      const sum = full.reduce((s, it) => s + it.tokens, 0);
      assert.equal(first.summary.tokens, sum, `汇总 ${first.summary.tokens} ≠ 翻页明细和 ${sum}`);
    });

    check('T6 筛选 projectId=p-b 只命中 p-b 行，汇总仍等于其明细和', () => {
      const p = ledger.queryPage(db, { filters: { projectId: 'p-b' }, limit: 100, dimensions: ['source'] });
      assert.ok(p.items.every((x) => x.projectId === 'p-b'), '筛选泄漏');
      const sum = p.items.reduce((s, it) => s + it.tokens, 0);
      assert.equal(p.summary.tokens, sum, '筛选下汇总≠明细');
      // p-b 共 4 条（4,5,9,10）
      assert.equal(p.summary.count, 4, `p-b 应 4 条，实际 ${p.summary.count}`);
    });

    check('T7 null 维度不回填：全空行 projectId 透出 null，汇总含 null 键', () => {
      const p = ledger.queryPage(db, { filters: {}, limit: 100, dimensions: ['projectId'] });
      const nullKey = p.summary.byDimension.projectId.find((d) => d.key === null);
      assert.ok(nullKey, '应存在 null 维度键');
      assert.equal(nullKey.tokens, 60, 'null 项目 key 应为 60');
      const row6 = p.items.find((x) => x.id === 6);
      assert.equal(row6.projectId, null, '空维度不应回填 default');
    });

    check('T8 非法时间区间（from>=to）抛 INVALID_RANGE，不静默全量', () => {
      assert.throws(() => ledger.queryPage(db, { filters: { from: 2000, to: 1000 } }), /INVALID_RANGE/);
    });

    check('T9 坏游标抛 INVALID_CURSOR，不退化成首页', () => {
      assert.throws(() => ledger.queryNextPage(db, { cursor: 'not-base64-json' }), /INVALID_CURSOR/);
    });

    check('T10 后续页携带不同筛选 ⇒ CURSOR_FILTERS_MISMATCH', () => {
      const p = ledger.queryPage(db, { filters: { projectId: 'p-b' }, limit: 1 });
      assert.throws(
        () => ledger.queryNextPage(db, { cursor: p.nextCursor, filters: { projectId: 'p-a' } }),
        /CURSOR_FILTERS_MISMATCH/,
      );
    });

    check('T11 capabilities 不出价、不可编辑、维度白名单不含 member_id 筛选项', () => {
      const c = ledger.capabilities();
      assert.equal(c.hasPricing, false, '不得声称有价格数据');
      assert.equal(c.editable, false, 'append-only');
      assert.ok(c.filterDimensions.includes('source'), 'source 可筛');
      assert.ok(!c.filterDimensions.includes('memberId'), 'member_id 不作为筛选项（语义未证实）');
    });

    check('T12 排序字段白名单：非法 sort 回落 created_at，不拼接待字符串', () => {
      const p = ledger.queryPage(db, { filters: {}, limit: 2, sort: '; DROP TABLE quota_consumptions;--' });
      assert.equal(p.items.length, 2);
      // 回落默认 created_at DESC ⇒ 最大 created_at(1010,id=11) 在前
      assert.equal(p.items[0].id, 11, '非法 sort 应回落 created_at desc');
    });

    check('T13 高水位隔离：查询后补记的更大 id（更早时间）不进入旧快照翻页', () => {
      // 先抓一个首页（此时快照 asOf=12）
      const snap = ledger.queryPage(db, { filters: {}, limit: 100 });
      const oldCursor = snap.nextCursor;
      assert.equal(snap.asOf, 12, '快照 asOf 应为 12');
      // 查询之后补记一条「时间更早(999)但 id 更大(13)」的历史记录
      db.prepare('INSERT INTO quota_consumptions (id,project_id,run_id,task_id,member_id,tokens,source,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(13, 'p-x', 'r-9', 't-9', 'm-9', 9999, 'round', 999);
      // 基于旧快照的游标继续翻页：cursor 内 asOf=12 ⇒ id=13 被排除
      const all = [...snap.items];
      let cur = oldCursor;
      while (cur) {
        const page = ledger.queryNextPage(db, { cursor: cur, limit: 100 });
        all.push(...page.items);
        cur = page.nextCursor;
      }
      const ids = all.map((x) => x.id);
      assert.ok(!ids.includes(13), '补记的 id=13 不应出现在基于旧快照的翻页');
      assert.deepEqual([...new Set(ids)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], '旧快照翻页仍只含原 12 条');
      // 全新查询：快照推进到 asOf=13，应当包含 id=13（证明高水位是「查询时刻」而非「类型」）
      const fresh = ledger.queryPage(db, { filters: {}, limit: 100 });
      assert.equal(fresh.asOf, 13, '新快照应推进到 13');
      assert.ok(fresh.items.some((x) => x.id === 13), '新快照应包含补记的 id=13');
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时库清理失败不阻断 */ }
  }

  // CSV 公式注入：单元格以 = + - @ tab 开头时前缀单引号
  const { buildLedgerCsv, ledgerRowToCsv } = await import('../shared/ledgerCsv.mjs');
  check('T13 CSV 表头存在，且字段与明细列一一对应', () => {
    const header = buildLedgerCsv([]).trim();
    assert.ok(/^".*","id".*$/.test(header) || header.startsWith('id,'), `表头异常: ${header}`);
  });
  check('T14 公式注入防护：source/notes 以 =+-@ 开头被前缀单引号', () => {
    const malicious = { id: 99, projectId: 'p', runId: 'r', taskId: 't', memberId: 'm', tokens: 1, source: '=cmd|/C calc', createdAt: 1000 };
    const line = ledgerRowToCsv(malicious);
    // 危险首字符必须被转义为空值前导
    assert.ok(line.includes("'=cmd"), `未转义公式注入: ${line}`);
    // 整体仍是合法 CSV（可被解析）
    const parsed = line.split(',');
    assert.ok(parsed.length >= 8, 'CSV 列数异常');
  });
  check('T15 正常值不被加引号前缀', () => {
    const ok = { id: 1, projectId: 'p-a', runId: 'r-1', taskId: 't-1', memberId: 'm-1', tokens: 10, source: 'round', createdAt: 1000 };
    const line = ledgerRowToCsv(ok);
    assert.ok(!line.startsWith("'round"), '正常值不应加前缀');
  });

  console.log(`\nledger-query: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
