// M5 / T5-5 团队记忆回归门禁（2026-10-20）：scope='team' 的归属、可见范围、容量闸、提名制晋升。
// 锁定内容：
//   ① resolveScope：team 必须携带归属键 teamId，否则回落来源默认档；external 硬约束压过 team；
//   ② 迁移 v11：team_id / agent_id 列 + idx_memories_team 索引幂等补齐；
//   ③ 可见范围：共享（agent_id IS NULL）∪ 自身私有；各成员私有互不可见；跨团队隔离；
//   ④ 去重键随归属分化：同内容「共享」与「某成员私有」各自独立并存；
//   ⑤ 团队层容量闸 MAX_TEAM_MEMORIES=200（超限硬淘汰最旧）；
//   ⑥ 提名制（U5）：阈值门槛 + 团队专有名反例保护 + 归档团队排除；
//   ⑦ promoteTeamMemoryToProject：scope→project、agent_id 清空、team_id 留痕；
//   ⑧ findTeamByRun：run_id（=groupId）→ 团队归属反查。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const { openDbAsync } = require(path.resolve(import.meta.dirname, '../main/db/index.js'));
const {
  MemoryManager, resolveScope, SCOPES, LAYER_QUOTA, PROMOTE_TEAM_MIN_HITS, MAX_TEAM_MEMORIES,
} = require(path.resolve(import.meta.dirname, '../main/memory/index.js'));
const { halfLifeDaysFor } = require(path.resolve(import.meta.dirname, '../main/memory/scorer.js'));
const { TeamStore } = require(path.resolve(import.meta.dirname, '../main/teamStore.js'));

let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

(async () => {
  // ── 1. resolveScope：团队归属唯一事实来源 ──
  assert.ok(SCOPES.includes('team'), 'team 已加入作用域集合');
  assert.strictEqual(LAYER_QUOTA.team, 3, '团队层召回配额 3');
  assert.strictEqual(resolveScope({ source: 'model_conclusion', requestedScope: 'team', teamId: 't1' }), 'team');
  assert.strictEqual(resolveScope({ source: 'model_conclusion', requestedScope: 'team' }), 'session',
    '无 teamId → 回落来源默认档（不造无归属的团队行）');
  // external_content 的硬约束优先级高于 team
  assert.strictEqual(resolveScope({ source: 'external_content', requestedScope: 'team', teamId: 't1' }), 'session');
  // 非团队层请求不受 teamId 影响
  assert.strictEqual(resolveScope({ source: 'user_input', requestedScope: 'project', teamId: 't1' }), 'project');
  ok('resolveScope：team 需归属键 + external 硬约束压过 team');

  // ── 2. 常量：半衰期 team=30（与项目同档）+ 容量闸/阈值 ──
  assert.strictEqual(halfLifeDaysFor('team'), 30, '团队层半衰期 30 天');
  assert.strictEqual(halfLifeDaysFor('project'), 30, '项目层半衰期 30 天（同档对照）');
  assert.strictEqual(MAX_TEAM_MEMORIES, 200);
  assert.strictEqual(PROMOTE_TEAM_MIN_HITS, 3);
  ok('scorer：团队层半衰期 30 天 + 容量闸/提名阈值常量');

  // ── 3. 迁移 v11：列与索引幂等补齐 ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mem-team-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const mem = new MemoryManager({ db });
  const cols = new Set(db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
  assert.ok(cols.has('team_id') && cols.has('agent_id'), 'team_id / agent_id 列已补齐');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_team'").get(),
    'idx_memories_team 索引已建');
  new MemoryManager({ db }); // 二次构造幂等
  ok('迁移：team_id / agent_id 列与索引幂等补齐');

  // ── 4. 共享 / 私有可见范围 ──
  const shared = mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', content: '团队共享结论 A', source: 'model_conclusion' });
  const privA = mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', agentId: 'm-a', content: '成员甲私有', source: 'model_conclusion' });
  mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', agentId: 'm-b', content: '成员乙私有', source: 'model_conclusion' });
  mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't2', content: '别的团队结论', source: 'model_conclusion' });
  assert.strictEqual(shared.scope, 'team');
  assert.strictEqual(shared.teamId, 't1');
  assert.strictEqual(shared.agentId, null, '未指定成员 = 团队共享');
  assert.strictEqual(privA.agentId, 'm-a', '指定成员 = 成员私有');

  const seenA = mem.recallTeamMemories({ teamId: 't1', agentId: 'm-a', spaceId: '/p', topK: 20 }).map((m) => m.content).sort();
  assert.deepStrictEqual(seenA, ['团队共享结论 A', '成员甲私有'].sort(),
    '成员甲可见 = 共享 ∪ 自身私有（不含乙私有、不含 t2）');
  const seenLead = mem.recallTeamMemories({ teamId: 't1', spaceId: '/p', topK: 20 }).map((m) => m.content);
  assert.deepStrictEqual(seenLead, ['团队共享结论 A'], '无成员上下文（如统筹）= 仅共享');
  assert.deepStrictEqual(mem.recallTeamMemories({}), [], '无 teamId 返回空（不注入无法归属的团队记忆）');
  ok('团队记忆：共享 / 成员私有可见范围正确（成员私有互不可见、跨团队隔离）');

  // ── 5. 去重键随归属分化 ──
  const dupShared = mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', content: '团队共享结论 A', source: 'model_conclusion' });
  const dupPriv = mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', agentId: 'm-a', content: '团队共享结论 A', source: 'model_conclusion' });
  assert.strictEqual(dupShared.id, shared.id, '同归属同内容 → 去重刷新（不重复插）');
  assert.notStrictEqual(dupPriv.id, shared.id, '私有与共享归属不同 → 去重键分化、各自独立并存');
  ok('去重键：team + agent 分化（共享与成员私有互不吞并）');

  // ── 6. 团队层容量闸 200 ──
  for (let i = 0; i < 210; i += 1) {
    mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 'big', content: `批量结论 ${i}`, source: 'model_conclusion' });
  }
  const bigCount = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='team' AND team_id='big'").get().n;
  assert.ok(bigCount <= MAX_TEAM_MEMORIES, `团队层容量闸生效（${bigCount} <= ${MAX_TEAM_MEMORIES}）`);
  assert.ok(bigCount >= MAX_TEAM_MEMORIES - 5, '容量闸硬淘汰至贴近上限（未误删过多）');
  ok('团队层容量闸：超 200 自动硬淘汰最旧');

  // ── 7. 提名候选：阈值门槛 + 团队专有名反例 + 归档团队排除 ──
  const candNormal = mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', content: '依赖注入的最佳实践结论', source: 'model_conclusion' });
  const candNamed = mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', content: '军团甲号 的约定：提交前先跑门禁', source: 'model_conclusion' });
  db.prepare('UPDATE memories SET re_hit_count = 5 WHERE id IN (?, ?)').run(candNormal.id, candNamed.id);
  const cands = mem.listTeamPromotionCandidates({ excludeNames: ['军团甲号'], excludeTeamIds: [] });
  const ids = cands.map((c) => c.id);
  assert.ok(ids.includes(candNormal.id), '命中达标的普通条目进入候选');
  assert.ok(!ids.includes(candNamed.id), '含团队专有名（团队名）的条目不进候选');
  const cands2 = mem.listTeamPromotionCandidates({ excludeTeamIds: ['t1'] });
  assert.ok(!cands2.some((c) => c.teamId === 't1'), '归档团队记忆被排除');
  // 低于阈值不进候选（构造一条命中不足的）
  const lowHit = mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', content: '一次性低命中结论', source: 'model_conclusion' });
  assert.ok(!mem.listTeamPromotionCandidates({}).map((c) => c.id).includes(lowHit.id), '命中不足阈值不进候选');
  ok('提名制：阈值门槛 + 团队专有名反例保护 + 归档团队排除');

  // ── 8. promoteTeamMemoryToProject 语义 ──
  const promoted = mem.promoteTeamMemoryToProject(candNormal.id);
  assert.strictEqual(promoted.scope, 'project', '晋升后 scope=project');
  assert.strictEqual(promoted.agentId, null, '晋升后解绑成员归属');
  assert.strictEqual(promoted.teamId, 't1', 'team_id 保留为来源留痕');
  assert.strictEqual(mem.promoteTeamMemoryToProject('no-such-id'), null, '不存在 → null');
  assert.strictEqual(mem.promoteTeamMemoryToProject(candNormal.id), null, '已非团队层 → null（幂等拒绝）');
  ok('promoteTeamMemoryToProject：唯一向上晋升 + 清 agent_id + team_id 留痕');

  // ── 9. listScope / resetScope 的 team 分支 ──
  const t2items = mem.listScope({ scope: 'team', teamId: 't2' });
  assert.ok(t2items.length >= 1 && t2items.every((m) => m.teamId === 't2'), 'listScope(team) 按归属键取数');
  assert.deepStrictEqual(mem.listScope({ scope: 'team' }), [], '无 teamId 取不到团队记忆（防取全表）');
  const removed = mem.resetScope({ scope: 'team', teamId: 't2' });
  assert.ok(removed >= 1, '清空 t2 团队记忆');
  assert.strictEqual(mem.resetScope({ scope: 'team' }), 0, '无归属键拒绝清空');
  assert.strictEqual(mem.listScope({ scope: 'team', teamId: 't2' }).length, 0, '清空后为空');
  ok('listScope / resetScope：team 层按归属键取数与清空（无键拒绝）');

  // ── 10. findTeamByRun：run_id → 团队归属反查 ──
  const ts = new TeamStore(db);
  const team = ts.createTeam({ name: '军团甲号', description: '测试用团队（run 反查归属）' });
  ts.appendMessage({ teamId: team.id, runId: 'g-run-1', kind: 'assign', summary: '派活' });
  const found = ts.findTeamByRun('g-run-1');
  assert.ok(found && found.id === team.id, 'findTeamByRun 反查到正确团队');
  assert.strictEqual(ts.findTeamByRun('no-such-run'), null, '未知 run → null');
  assert.strictEqual(ts.findTeamByRun(''), null, '空 run → null');
  ok('findTeamByRun：run_id（=groupId）→ 团队归属反查');

  // ── 9. B-16：成员私有记忆批量降权（单条 SQL、作用域精确、幂等）──
  {
    const other = mem.remember({ spaceId: '/p', domain: 'global_knowledge', scope: 'team', teamId: 't1', agentId: 'm-b', content: '另一成员的私有结论', source: 'model_conclusion' });
    const otherBefore = mem.list({ scope: 'team', teamId: 't1', agentId: 'm-b' }).find((m) => m.id === other.id)?.importance;
    const demoted = mem.demoteImportance({ scope: 'team', teamId: 't1', agentId: 'm-a', floor: 0.2, factor: 0.5 });
    const afterA = mem.list({ scope: 'team', teamId: 't1', agentId: 'm-a' });
    const otherAfter = mem.list({ scope: 'team', teamId: 't1', agentId: 'm-b' }).find((m) => m.id === other.id)?.importance;
    assert.ok(demoted >= 1, '降权命中该成员私有条目');
    assert.ok(afterA.every((m) => Number(m.importance) <= 0.2), '降权后 importance 不超过 floor');
    assert.strictEqual(otherAfter, otherBefore, '不触碰其它成员的私有记忆');
    const again = mem.demoteImportance({ scope: 'team', teamId: 't1', agentId: 'm-a', floor: 0.2, factor: 0.5 });
    assert.strictEqual(again, 0, '幂等：已在 floor 以下的条目不再计入');
    ok('B-16 demoteImportance：单条 SQL 批量降权 + 作用域精确 + 幂等');
  }

  console.log(`\nmemory-team: ${n}/${n} 通过`);
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => {
  console.error('\nmemory-team 失败:', e.message);
  process.exit(1);
});
