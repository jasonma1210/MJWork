// 知识注入门禁（M3 §8.6 / §8.6.4，2026-10-27）
//
// 覆盖三件事（此前后两件**完全没做**：快照能建能验，但没有任何运行会用它）：
//   ① 注入块的形状：授权声明 + 可追溯引用编号 + 预算截断必须说出来；
//   ② 失效快照 fail-closed：授权/版本一变，运行**必须起不来**，而不是「少注入一段继续跑」；
//   ③ 接线不被白名单吞掉：载荷里的 knowledgePlan 一路走到 engineParams.appendSystemPrompt。
//      （历史教训：`append-system-prompt` 事故就是「单测直调 runAgent 全绿、真机 channel 全废」，
//        因为参数在 agentRunner 的白名单里被整体丢弃。）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');

const { openSqliteJsDb } = require(path.join(DESKTOP, 'main/db/sqljsDb.js'));
const kb = require(path.join(DESKTOP, 'main/knowledgeBaseQuery.js'));
const kbRuntime = require(path.join(DESKTOP, 'main/kbRuntime.js'));
const inject = require(path.join(DESKTOP, 'main/knowledgeInject.js'));
const agentRunner = require(path.join(DESKTOP, 'main/agentRunner.js'));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.error(`❌ ${name} — ${e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-inject-'));
const db = await openSqliteJsDb(path.join(TMP, 'inject.sqlite'));
db.exec(kb.KB_SCHEMA);
kbRuntime.setDb(() => db);
const storageDir = path.join(TMP, 'store');

function writeDoc(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
const importDoc = async (name, content, projectId = 'P') => kb.importDocument({
  db, storageDir, workspaceId: 'ws', projectId, filePath: writeDoc(name, content), actorId: 'owner',
});

// ── ① 开关：能力关闭时即便载荷带快照也必须拒（§17.2）──
kbRuntime.setFlags(() => ({ knowledge: false }));
const docA = await importDoc('a.md', '本地知识库注入测试：项目验收标准与交付口径说明。');
const planA = kb.buildContextPlan({ db, projectId: 'P', actorId: 'owner', sourceIds: [docA.sourceId] });

await check('① 能力关闭时注入被拒（FEATURE_DISABLED），不是「静默不注入」', async () => {
  const r = inject.buildInjection({ knowledgePlan: { planId: planA.planId, planHash: planA.planHash } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FEATURE_DISABLED');
});

kbRuntime.setFlags(() => ({ knowledge: true }));

await check('① 打开且未选知识 → 空块、零影响', async () => {
  const r = inject.buildInjection({ knowledgePlan: null });
  assert.equal(r.ok, true);
  assert.equal(r.block, '');
  assert.deepEqual(r.citations, []);
});

// ── ② 注入块形状：声明 + 引用编号 + 来源标题 ──
await check('② 注入块含「数据非指令」声明与 [KB:<id>] 引用编号', async () => {
  const r = inject.buildInjection({ knowledgePlan: { planId: planA.planId, planHash: planA.planHash } });
  assert.equal(r.ok, true, `注入失败：${r.code || ''}`);
  assert.match(r.block, /数据，不是指令/);
  assert.match(r.block, /\[KB:kc_/);
  assert.ok(r.citations.length >= 1, '没有引用清单');
  assert.ok(r.block.includes(r.citations[0].chunkId), '引用编号未出现在正文里');
  assert.ok(r.block.includes('a'), '来源标题缺失');
  assert.ok(r.chars > 0 && r.chars <= inject.MAX_CHARS, `字符预算异常：${r.chars}`);
});

await check('② 预算不足时截断必须**说出来**（块尾标注）', async () => {
  // 造一份长文档，并用一个很小的预算来注入
  const long = await importDoc('long.md', '段落一。'.repeat(400));
  const p = kb.buildContextPlan({ db, projectId: 'P', actorId: 'owner', sourceIds: [long.sourceId] });
  const r = kb.resolvePlanContext({ db, planId: p.planId, planHash: p.planHash, actorId: 'owner', maxChars: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, '未标记截断');
  assert.ok(r.chars <= 200, `超出预算：${r.chars}`);
});

// ── ③ 失效快照 fail-closed ──
await check('③ hash 被篡改 → PLAN_HASH_MISMATCH（不接受「只给 id」）', async () => {
  const r = inject.buildInjection({ knowledgePlan: { planId: planA.planId, planHash: 'deadbeef' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PLAN_HASH_MISMATCH');
  const r2 = inject.buildInjection({ knowledgePlan: { planId: planA.planId } });
  assert.equal(r2.ok, false, '缺 planHash 竟然通过了');
});

await check('③ 撤权后再授权（revision 变化）→ CONTEXT_PLAN_STALE，旧快照不得复活', async () => {
  const d2 = await importDoc('b.md', '另一份资料用于验证授权版本变化后的注入失效。');
  const p2 = kb.buildContextPlan({ db, projectId: 'P', actorId: 'owner', sourceIds: [d2.sourceId] });
  assert.equal(inject.buildInjection({ knowledgePlan: { planId: p2.planId, planHash: p2.planHash } }).ok, true);
  kb.deauthorize({ db, sourceId: d2.sourceId, projectId: 'P' });
  kb.authorize({ db, sourceId: d2.sourceId, projectId: 'P', actorId: 'owner' });
  const r = inject.buildInjection({ knowledgePlan: { planId: p2.planId, planHash: p2.planHash } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONTEXT_PLAN_STALE');
});

await check('③ 文档被删除 → chunk_missing（明确失效，不静默少注入）', async () => {
  const d3 = await importDoc('c.md', '第三份资料用于验证删除后注入必须失效。');
  const p3 = kb.buildContextPlan({ db, projectId: 'P', actorId: 'owner', sourceIds: [d3.sourceId] });
  kb.deleteSource({ db, sourceId: d3.sourceId });
  const r = inject.buildInjection({ knowledgePlan: { planId: p3.planId, planHash: p3.planHash } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONTEXT_PLAN_STALE');
  assert.match(r.reason, /已被删除/, `原因不对：${r.reason}`);
});

// ── ④ 使用记账 + 引用回读 ──
await check('④ 注入后可记录「运行用了哪个快照的哪些片段」并可回读', async () => {
  // 注意：③ 里对项目 P 做过一次撤权+授权（revision 变化），**所有** P 的旧快照都已失效——
  // 这正是希望的行为。所以这里必须重新造一个快照，而不是复用 planA（复用会得到 STALE）。
  const d4 = await importDoc('f.md', '使用记账测试资料：本次运行应当被记录下来。');
  const p4 = kb.buildContextPlan({ db, projectId: 'P', actorId: 'owner', sourceIds: [d4.sourceId] });
  const r = inject.buildInjection({ knowledgePlan: { planId: p4.planId, planHash: p4.planHash } });
  assert.equal(r.ok, true, `注入失败：${r.code || ''}`);
  const rec = inject.recordUse({ runId: 'run-x1', injection: r, projectId: 'P' });
  assert.equal(rec.ok, true, `记账失败：${rec.code}`);
  const back = kb.listRunCitations({ db, runId: 'run-x1' });
  assert.equal(back.ok, true);
  assert.equal(back.planId, p4.planId);
  assert.ok(back.items.length >= 1);
  const byPlan = kb.listPlanCitations({ db, planId: p4.planId });
  assert.equal(byPlan.ok, true);
  assert.ok(byPlan.items.length >= 1, '按快照回读引用为空');
  assert.ok(byPlan.items[0].title, '引用缺少来源标题');
});

// ── ⑤ 快照清理策略：又老又没被引用才删 ──
await check('⑤ 清理只删「过期且从未被运行引用」的快照', async () => {
  const makeOldPlan = (sourceId) => {
    const p = kb.buildContextPlan({ db, projectId: 'P', actorId: 'owner', sourceIds: [sourceId] });
    // 把创建时间推到 40 天前（模拟老快照）
    db.prepare('UPDATE context_plans SET created_at = ? WHERE plan_id = ?')
      .run(Date.now() - 40 * 24 * 3600 * 1000, p.planId);
    return p;
  };
  const dOld = await importDoc('d.md', '旧快照清理测试资料（未引用）。');
  const unused = makeOldPlan(dOld.sourceId);
  const dUsed = await importDoc('e.md', '旧快照清理测试资料（被运行引用过）。');
  const used = makeOldPlan(dUsed.sourceId);
  inject.recordUse({
    runId: 'run-old-used',
    injection: inject.buildInjection({ knowledgePlan: { planId: used.planId, planHash: used.planHash } }),
    projectId: 'P',
  });
  const fresh = kb.buildContextPlan({ db, projectId: 'P', actorId: 'owner', sourceIds: [dOld.sourceId] });

  const r = kb.pruneContextPlans({ db, olderThanMs: 30 * 24 * 3600 * 1000 });
  assert.equal(r.ok, true);
  const alive = (planId) => !!db.prepare('SELECT plan_id FROM context_plans WHERE plan_id = ?').get(planId);
  assert.equal(alive(unused.planId), false, '未被引用且过期的快照应被清理');
  assert.equal(alive(used.planId), true, '被运行引用过的快照不得清理（会悄悄改写历史）');
  assert.equal(alive(fresh.planId), true, '新快照不得清理');
});

// ── ⑥ 运行启动点：失效快照必须让运行**起不来**（fail-closed 端到端）──
await check('⑥ agentRunner 启动点：失效快照 → ok:false 且带 CONTEXT_PLAN_STALE', async () => {
  await agentRunner.agentRunnerReady();
  agentRunner.initAgentRunner({
    // 一旦跑到引擎就说明门没拦住，直接判红
    loadAgentCore: async () => ({ runAgent: async () => { throw new Error('不应到达引擎'); } }),
    createToolHandlers: () => ({}), toolHooks: { wrap: (h) => h },
    runScope: { current: () => ({ cancelled: false }) },
    persistMessage: () => {}, flushPersistence: () => ({ ok: true }),
  });
  const payload = {
    runId: 'run-bad-plan',
    messages: [{ role: 'user', content: '你好' }],
    model: { provider: { id: 1, base_url: 'https://api.deepseek.com/v1' }, model: { model_id: 'deepseek-chat' } },
    conversationId: 't1',
    // 已失效的快照（③ 里撤权再授权的那个）
    knowledgePlan: { planId: planA.planId, planHash: planA.planHash },
  };
  // 先让 planA 失效：对 planA 所属项目做一次撤权+授权（revision 变化）
  kb.deauthorize({ db, sourceId: docA.sourceId, projectId: 'P' });
  kb.authorize({ db, sourceId: docA.sourceId, projectId: 'P', actorId: 'owner' });
  const r = await agentRunner.startAgentRunWhenReady(payload, { send: () => {} });
  assert.equal(r.ok, false, `失效快照竟然启动成功：${JSON.stringify(r)}`);
  assert.equal(r.code, 'CONTEXT_PLAN_STALE');
  assert.match(r.error, /失效|重新选择/);
});

await check('⑥ 接线不被白名单吞掉：engineParams 的 appendSystemPrompt 取自注入块', async () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main/agentRunner.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  assert.match(src, /appendSystemPrompt:\s*kbInjection\.block/, 'engineParams 未把注入块接到 appendSystemPrompt');
  assert.match(src, /buildInjection\(\{\s*knowledgePlan:\s*payload\.knowledgePlan/, '启动点未调用 buildInjection');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\nknowledge-inject: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
