// M3 本地知识库：查询核 + 索引 + 授权 + contextPlan + 删除 的端到端验证（设计文档 §8）
// 直接驱动 main/knowledgeBaseQuery（与 ledger-query 测试同一底座：真实 sqljsDb 驱动）。
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

const kb = require('../main/knowledgeBaseQuery.js');
const { openSqliteJsDb } = require('../main/db/sqljsDb.js');

let passed = 0; let failed = 0; const fails = [];
function ok(cond, msg) { if (cond) { passed++; } else { failed++; fails.push(msg); console.log('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)})`); }
function truthy(v, msg) { ok(!!v, msg); }

async function main() {
  const dbPath = path.join(os.tmpdir(), `kb-test-${Date.now()}.sqlite`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = await openSqliteJsDb(dbPath);
  db.exec(kb.KB_SCHEMA);

  const storageDir = path.join(os.tmpdir(), `kb-store-${Date.now()}`);
  fs.mkdirSync(storageDir, { recursive: true });

  const writeTmp = (name, content) => {
    const p = path.join(os.tmpdir(), name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
  };

  // ── T1 导入 ──
  const f1 = writeTmp('kb-a.txt', '本地知识库中文检索测试：产品需求与技术方案。知识库用于检索业务资料。');
  const r1 = kb.importDocument({ db, storageDir, workspaceId: 'ws1', projectId: 'A', filePath: f1, actorId: 'owner' });
  ok(r1.ok && r1.status === 'ready' && r1.chunks > 0, 'T1 导入文本成功且产生分块');
  const srcA = r1.sourceId;

  // ── T2 同语言检索命中 ──
  const s2 = kb.search({ db, projectId: 'A', query: '知识库', limit: 10 });
  ok(s2.ok && s2.items.length > 0, 'T2 检索「知识库」有命中');

  // ── T3 中文 bigram 召回（非整串 LIKE） ──
  const s3 = kb.search({ db, projectId: 'A', query: '中文检索', limit: 10 });
  ok(s3.items.length > 0, 'T3 中文多字查询「中文检索」能召回（bigram 倒排，非整串 LIKE）');
  ok(s3.items[0].sourceId === srcA, 'T3 命中归属正确 source');
  // T3b（判据收紧，2026-10-27）：「中文检索」在原文里是**连续子串**，LIKE '%中文检索%' 同样会命中，
  // 故单靠 T3 无法证明「没退化成整串匹配」。这里用**词不连续**的查询：
  // 原文含「…中文检索测试…」与「…业务资料。」，两段之间隔着别的字，
  // bigram 会分别命中 中文 / 资料 两个词元而召回；整串 LIKE '%中文资料%' 必然 0 命中。
  const s3b = kb.search({ db, projectId: 'A', query: '中文资料', limit: 10 });
  ok(s3b.items.length > 0, 'T3b 词不连续查询「中文资料」仍能召回（LIKE 做不到，证明走了倒排）');
  ok(!/中文资料/.test('本地知识库中文检索测试：产品需求与技术方案。知识库用于检索业务资料。'),
    'T3b 自检：该查询在原文中确实不是连续子串（否则本用例退化为 T3）');

  // ── T4 英文词元 ──
  const f2 = writeTmp('kb-b.txt', 'The knowledge base indexes business documents for retrieval.');
  const r2 = kb.importDocument({ db, storageDir, projectId: 'A', filePath: f2, actorId: 'owner' });
  const s4 = kb.search({ db, projectId: 'A', query: 'knowledge', limit: 10 });
  ok(s4.items.length > 0, 'T4 英文词元 knowledge 命中');

  // ── T5 空查询 / 无命中 → 真实空态 ──
  const s5a = kb.search({ db, projectId: 'A', query: '', limit: 10 });
  eq(s5a.items.length, 0, 'T5a 空查询返回空数组（不生成引用）');
  const s5b = kb.search({ db, projectId: 'A', query: 'zzxnotexisttoken', limit: 10 });
  eq(s5b.items.length, 0, 'T5b 无命中返回空数组（真实空态）');

  // ── T6 片段 HTML 转义（防注入） ──
  const f3 = writeTmp('kb-c.txt', '正常内容 <script>alert(1)</script> 危险文本应被转义显示。');
  const r3 = kb.importDocument({ db, storageDir, projectId: 'A', filePath: f3, actorId: 'owner' });
  const s6 = kb.search({ db, projectId: 'A', query: '危险文本', limit: 10 });
  ok(s6.items.length > 0, 'T6 含 HTML 的文档可被检索');
  ok(!s6.items[0].snippet.includes('<script>'), 'T6 片段未原样输出 <script>（已转义）');
  ok(s6.items[0].snippet.includes('&lt;script&gt;'), 'T6 片段转义为 &lt;script&gt;');

  // ── T7 跨项目越权隔离（§8.8 / §635） ──
  const s7 = kb.search({ db, projectId: 'B', query: '知识库', limit: 10 });
  eq(s7.items.length, 0, 'T7 项目 B 不能检索项目 A 已授权文档（越权隔离）');
  const s7b = kb.search({ db, projectId: 'B', scope: 'workspace', query: '知识库', limit: 10 });
  ok(s7b.items.length > 0, 'T7b workspace 作用域可见（owner 全量）');

  // ── T8 撤权后立即不可注入 ──
  kb.deauthorize({ db, sourceId: srcA, projectId: 'A' });
  const s8 = kb.search({ db, projectId: 'A', query: '知识库', limit: 10 });
  eq(s8.items.length, 0, 'T8 撤权后项目 A 自身也搜不到（撤权即失效）');

  // ── T9 contextPlan 不可变 + 删除 chunk 后 STALE ──
  kb.authorize({ db, sourceId: srcA, projectId: 'A', actorId: 'owner' });
  const plan = kb.buildContextPlan({ db, projectId: 'A', actorId: 'owner', sourceIds: [srcA], budgetTokens: 2000 });
  ok(plan.ok && plan.planId && plan.planHash, 'T9a 生成不可变 contextPlan');
  const v9a = kb.validateContextPlanForRun({ db, planId: plan.planId, planHash: plan.planHash, actorId: 'owner' });
  ok(v9a.ok, 'T9b 创建 run 同事务重验通过（未篡改）');
  // 删除该 source 的 chunks → 旧 plan 应 STALE
  kb.deleteSource({ db, sourceId: srcA });
  const v9b = kb.validateContextPlanForRun({ db, planId: plan.planId, planHash: plan.planHash, actorId: 'owner' });
  eq(v9b.ok, false, 'T9c 删除 chunk 后旧 contextPlan 失效（CONTEXT_PLAN_STALE）');
  ok(v9b.code === 'CONTEXT_PLAN_STALE', 'T9d 失效原因为 CONTEXT_PLAN_STALE');

  // ── T10 撤权后再授权 → 旧 plan 因 revision 递增而 STALE ──
  const f4 = writeTmp('kb-d.txt', '另一份资料用于验证授权版本号递增。');
  const r4 = kb.importDocument({ db, storageDir, projectId: 'A', filePath: f4, actorId: 'owner' });
  const srcD = r4.sourceId;
  const plan2 = kb.buildContextPlan({ db, projectId: 'A', actorId: 'owner', sourceIds: [srcD], budgetTokens: 1000 });
  kb.deauthorize({ db, sourceId: srcD, projectId: 'A' });
  kb.authorize({ db, sourceId: srcD, projectId: 'A', actorId: 'owner' }); // 再授权：revision 再次 +1
  const v10 = kb.validateContextPlanForRun({ db, planId: plan2.planId, planHash: plan2.planHash, actorId: 'owner' });
  eq(v10.ok, false, 'T10 撤权后再授权使旧 plan 失效（revision 单调递增）');
  ok(v10.code === 'CONTEXT_PLAN_STALE', 'T10 失效原因为 CONTEXT_PLAN_STALE（revision 漂移）');

  // ── T11 删除幂等 + 不动用户原文件 ──
  const beforeDelete = fs.existsSync(f4);
  const d11 = kb.deleteSource({ db, sourceId: srcD });
  ok(d11.ok && d11.deleted === true, 'T11a 首次删除成功');
  const d11b = kb.deleteSource({ db, sourceId: srcD });
  ok(d11b.ok && d11b.deleted === false && d11b.reason === 'NOT_FOUND', 'T11b 二次删除幂等（NOT_FOUND）');
  ok(beforeDelete && fs.existsSync(f4), 'T11c 用户原始文件未被删除（仅清索引/副本）');

  // ── T12 重复文件 → 独立授权 ──
  const dup1 = writeTmp('kb-dup1.txt', '重复内容用于验证独立授权');
  const dup2 = writeTmp('kb-dup2.txt', '重复内容用于验证独立授权');
  const rd1 = kb.importDocument({ db, storageDir, projectId: 'A', filePath: dup1, actorId: 'owner' });
  const rd2 = kb.importDocument({ db, storageDir, filePath: dup2, actorId: 'owner' }); // 未授权（未传 projectId）
  ok(rd1.sourceId !== rd2.sourceId, 'T12a 同内容导入为两个独立 source');
  kb.authorize({ db, sourceId: rd1.sourceId, projectId: 'A', actorId: 'owner' });
  const s12 = kb.search({ db, projectId: 'A', query: '重复内容', limit: 10 });
  eq(s12.items.filter((i) => i.sourceId === rd2.sourceId).length, 0, 'T12b 另一份未授权不出现在项目 A 结果');

  // ── T13 capabilities 如实声明无 FTS5 ──
  const caps = kb.capabilities();
  eq(caps.hasFts5, false, 'T13 hasFts5=false（sql.js 1.15.1 未编译 FTS5）');
  eq(caps.indexKind, 'bigram-inverted', 'T13 索引类型为 bigram-inverted');

  db.exec('PRAGMA wal_checkpoint;');
  try { fs.unlinkSync(dbPath); } catch {}

  console.log(`\nknowledge-base: ${passed} 通过 / ${failed} 失败`);
  if (failed) { console.log('失败项:\n - ' + fails.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
