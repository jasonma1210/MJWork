// 三层记忆 M4 回归门禁（2026-10-20）：补齐设计文档 L1958 的两项承诺。
// 锁定内容：
//   ① 半衰期按 scope 差异化（scorer.HALF_LIFE_DAYS_BY_SCOPE：session 7 / team 30（M5/T5-5 与项目同档）/
//      project 30 / global 90），domain 表作兼容回落；scoreMemory / decayJob 均按「scope 优先，缺失回落 domain」取值；
//   ② L3 全局层独立容量硬闸 MAX_GLOBAL_MEMORIES=300（跨空间按 scope 计数）；
//      空间闸 / 全局层闸共用 _enforceCap 统一淘汰口径（单一事实来源）；
//      写入记住（remember）与晋升（promoteScope → global）两条入口都受该闸约束。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const { openDbAsync } = require(path.resolve(import.meta.dirname, '../main/db/index.js'));
const {
  MemoryManager, MAX_MEMORIES_PER_SPACE, MAX_GLOBAL_MEMORIES,
} = require(path.resolve(import.meta.dirname, '../main/memory/index.js'));
const scorer = require(path.resolve(import.meta.dirname, '../main/memory/scorer.js'));

const SRC_INDEX = fs.readFileSync(path.resolve(import.meta.dirname, '../main/memory/index.js'), 'utf8');
const SRC_SCORER = fs.readFileSync(path.resolve(import.meta.dirname, '../main/memory/scorer.js'), 'utf8');

let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

(async () => {
  // ── 1. 半衰期常量与查表（scope 优先，domain 回落）──
  assert.deepStrictEqual(scorer.HALF_LIFE_DAYS_BY_SCOPE, { session: 7, team: 30, project: 30, global: 90 }, 'scope 半衰期表：7 / 30(team) / 30 / 90');
  assert.strictEqual(scorer.halfLifeDaysFor('session'), 7, 'scope=session → 7 天');
  assert.strictEqual(scorer.halfLifeDaysFor('team'), 30, 'scope=team → 30 天（M5/T5-5：与项目同档）');
  assert.strictEqual(scorer.halfLifeDaysFor('project'), 30, 'scope=project → 30 天');
  assert.strictEqual(scorer.halfLifeDaysFor('global'), 90, 'scope=global → 90 天（最持久）');
  assert.strictEqual(scorer.halfLifeDaysFor('global_knowledge'), 30, 'domain 兼容回落：global_knowledge → 30 天');
  assert.strictEqual(scorer.halfLifeDaysFor('entity'), 30, 'domain 兼容回落：entity → 30 天');
  assert.strictEqual(scorer.halfLifeDaysFor('no-such-key'), 14, '未知键回落 14 天');
  assert.strictEqual(scorer.halfLifeDaysFor(undefined), 14, '缺键回落 14 天（旧调用兼容）');
  const ts = Date.now() - 14 * 86400000;
  const rS = scorer.recencyScore(ts, Date.now(), 'session');
  const rP = scorer.recencyScore(ts, Date.now(), 'project');
  const rG = scorer.recencyScore(ts, Date.now(), 'global');
  assert.ok(rS < rP && rP < rG, '同一时间点 recency 分随层级单调递增（session < project < global）');
  ok('半衰期：scope 表（7/30/90）+ domain 兼容回落 + recency 单调');

  // ── 2. scoreMemory：scope 优先于 domain ──
  const base = { updated_at: Date.now() - 14 * 86400000, importance: 0.5, usage_count: 0, tier: 1, is_valid: 1, content: 'x' };
  const fSess = scorer.scoreMemory({ ...base, scope: 'session', domain: 'global_knowledge' }, {}).factors.recency;
  const fProj = scorer.scoreMemory({ ...base, scope: 'project', domain: 'session' }, {}).factors.recency;
  const fGlob = scorer.scoreMemory({ ...base, scope: 'global', domain: 'session' }, {}).factors.recency;
  assert.ok(fSess < fProj && fProj < fGlob, 'scoreMemory：同 domain 下 scope 决定衰减速率（scope 优先）');
  const fLegacy = scorer.scoreMemory({ ...base, domain: 'global_knowledge' }, {}).factors.recency;
  assert.ok(Math.abs(fLegacy - 0.5 ** (14 / 30)) < 1e-9, '无 scope 的旧对象按 domain 取值（兼容）');
  ok('scoreMemory：scope 优先，无 scope 回落 domain');

  // ── 3. 静态接线：三处取值/双闸共用 ──
  assert.ok(/memory\.scope \|\| memory\.domain/.test(SRC_SCORER), 'scoreMemory 按 scope 优先取值');
  assert.ok(/halfLifeDaysFor\(r\.scope \|\| r\.domain\)/.test(SRC_INDEX), 'decayJob 按 scope 优先取值');
  assert.ok(/SELECT id, scope, domain, importance, updated_at FROM memories/.test(SRC_INDEX), 'decayJob 查询已带上 scope 列');
  assert.strictEqual((SRC_INDEX.match(/this\._enforceCap\(\{/g) || []).length, 2, '空间闸 / 全局层闸共用 _enforceCap（无第二套淘汰实现）');
  assert.ok(/if \(sc === 'global'\) this\._enforceGlobalCap\(\)/.test(SRC_INDEX), 'remember 写入 L3 时触发全局闸');
  assert.ok(/if \(targetScope === 'global'\) this\._enforceGlobalCap\(\)/.test(SRC_INDEX), 'promoteScope 晋升 L3 时触发全局闸');
  ok('静态接线：scope 取值统一 + 双闸共用 _enforceCap + 两条 L3 入口均受闸');

  // ── 4. 全局层容量硬闸：跨空间按 scope 计数 + 最旧 LRU 硬淘汰 ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mem-m4-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const mem = new MemoryManager({ db });
  assert.strictEqual(MAX_GLOBAL_MEMORIES, 300, 'L3 全局闸常量 300');
  assert.strictEqual(MAX_MEMORIES_PER_SPACE, 500, '空间闸常量 500（未被改动）');
  // 直接用 SQL 播种 305 条 global 行（跨 3 个不同 space，验证闸按 scope 计数而非按空间），updated_at 单调递增
  const ins = db.prepare(`INSERT INTO memories (id, space_id, scope, conversation_id, domain, tier, content, summary,
    importance, entity_tags, expire_at, is_valid, compressed, re_hit_count, usage_count, source, created_at, updated_at, content_hash)
    VALUES (?, ?, 'global', NULL, 'private', 1, ?, NULL, 0.5, '[]', NULL, 1, 0, 0, 0, 'user_input', ?, ?, ?)`);
  const old = Date.now() - 100 * 86400000;
  for (let i = 0; i < 305; i += 1) {
    ins.run(`seed-${i}`, `/gspace-${i % 3}`, `L3 淘汰 ${i}`, old, old + i, `hash-${i}`);
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='global'").get().n, 305, '播种 305 条 L3');
  // 触发闸门（一次 L3 写入即触发）
  const trig = mem.remember({ spaceId: '/gspace-0', domain: 'private', content: '触发全局闸', source: 'user_input', scope: 'global' });
  assert.strictEqual(trig.scope, 'global', '写入 L3 生效');
  const gN = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='global'").get().n;
  assert.strictEqual(gN, 300, `L3 闸合拢（305 + 1 → 硬淘汰至 300，实际 ${gN}）`);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='global' AND is_valid=0").get().n, 0,
    '硬闸为物理删除（不含仅置失效的残留行）');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id='seed-0'").get().n, 0, '最旧（seed-0）被淘汰');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id='seed-5'").get().n, 0, '最旧 6 条被淘汰（seed-5）');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id='seed-6'").get().n, 1, '次旧（seed-6）保留');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id='seed-304'").get().n, 1, '最新种子保留');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content='触发全局闸'").get().n, 1, '触发写入本身保留');
  const bySpace = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='global' GROUP BY space_id").all();
  assert.strictEqual(bySpace.reduce((a, r) => a + r.n, 0), 300, '闸按 scope 计数（跨空间统一治理，非按空间分裂）');
  assert.ok(bySpace.length >= 3, '淘汰后仍横跨 3 个空间（印证闸不按空间分别计数）');
  ok('L3 全局闸：跨空间按 scope 计数 + 最旧 LRU 物理淘汰 + 硬闸合拢');

  // ── 5. 晋升进入 L3 同样受闸（晋升不是绕过容量闸的口子）──
  const cand = mem.remember({ spaceId: '/gpromo', domain: 'private', content: '拟晋升到全局的资产', source: 'user_input' });
  assert.strictEqual(cand.scope, 'project', '候选先落 L2');
  const promoted = mem.promoteScope(cand.id, 'global');
  assert.strictEqual(promoted.scope, 'global', 'promoteScope 晋升 L3 生效');
  const gN2 = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='global'").get().n;
  assert.strictEqual(gN2, 300, `晋升后仍受闸（保持 300，实际 ${gN2}）`);
  assert.ok(mem.get(cand.id), '晋升条目为最新 → 未被淘汰');
  ok('晋升入口：L2→L3 同样受全局闸约束');

  // ── 6. decayJob：L3 衰减慢于 L2（端到端）──
  const l3 = mem.remember({ spaceId: '/dtest', domain: 'private', content: 'L3 衰减样本', importance: 0.5, source: 'user_input', scope: 'global' });
  const l2 = mem.remember({ spaceId: '/dtest', domain: 'private', content: 'L2 衰减样本', importance: 0.5, source: 'user_input' });
  assert.strictEqual(l2.scope, 'project', '对照样本落 L2');
  const past = Date.now() - 14 * 86400000;
  db.prepare('UPDATE memories SET updated_at = ? WHERE id IN (?, ?)').run(past, l3.id, l2.id);
  mem.decayJob({});
  const dL3 = mem.get(l3.id).importance;
  const dL2 = mem.get(l2.id).importance;
  assert.ok(Math.abs(dL2 - 0.5 ** (14 / 30) * 0.5) < 1e-6, `L2 样本 30 天半衰期衰减（实际 ${dL2}）`);
  assert.ok(Math.abs(dL3 - 0.5 ** (14 / 90) * 0.5) < 1e-6, `L3 样本 90 天半衰期衰减（实际 ${dL3}）`);
  assert.ok(dL3 > dL2, 'decayJob：L3 衰减慢于 L2（半衰期按 scope 差异化生效）');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='global'").get().n <= 300, 'L3 写入衰减样本后闸仍合拢');
  ok('decayJob：L3/L2 差异化衰减（90 / 30 天）端到端');

  console.log(`\n三层记忆 M4 强化门禁：${n} 组全部通过`);
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => { console.error(e); process.exit(1); });
