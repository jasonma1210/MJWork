// 三层记忆 M0 回归门禁（2026-10-20）：作用域（scope）维度 + 写入分流 + 分层召回 + 新 API。
// 锁定内容：
//   ① scope/conversation_id 列惰性补齐幂等；存量行回落 project；
//   ② resolveScope 单一事实来源：四来源默认档 / global 仅 user_input / external 强制会话层；
//   ③ remember 去重键随作用域分化；project 层解绑会话；
//   ④ recall 分层模式：每层配额（session2/project3/global2）+ 无会话不注入会话层 + 跨层去重；
//   ⑤ recallForPrompt 预算装配 + 可信度过滤；
//   ⑥ updateMemory / importItems / resetScope / promoteScope。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const { openDbAsync } = require(path.resolve(import.meta.dirname, '../main/db/index.js'));
const {
  MemoryManager, resolveScope, SCOPES, LAYER_QUOTA,
} = require(path.resolve(import.meta.dirname, '../main/memory/index.js'));

let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

(async () => {
  // ── 1. resolveScope：写入分流唯一事实来源 ──
  assert.strictEqual(resolveScope({ source: 'user_input' }), 'project');
  assert.strictEqual(resolveScope({ source: 'model_conclusion' }), 'session');
  assert.strictEqual(resolveScope({ source: 'compressor' }), 'project');
  assert.strictEqual(resolveScope({ source: 'external_content' }), 'session');
  assert.strictEqual(resolveScope({ source: '' }), 'session', '缺省来源=model_conclusion→session');
  assert.strictEqual(resolveScope({ source: 'legacy-import' }), 'project');
  // global 仅 user_input 可写（自动沉淀不得进跨项目层）
  assert.strictEqual(resolveScope({ source: 'model_conclusion', requestedScope: 'global' }), 'project');
  assert.strictEqual(resolveScope({ source: 'compressor', requestedScope: 'global' }), 'project');
  assert.strictEqual(resolveScope({ source: 'user_input', requestedScope: 'global' }), 'global');
  // external_content 强制收敛会话层（哪怕显式请求 project/global）
  assert.strictEqual(resolveScope({ source: 'external_content', requestedScope: 'project' }), 'session');
  assert.strictEqual(resolveScope({ source: 'external_content', requestedScope: 'global' }), 'session');
  // 合法 requestedScope 生效；非法回落来源默认档
  assert.strictEqual(resolveScope({ source: 'user_input', requestedScope: 'session' }), 'session');
  assert.strictEqual(resolveScope({ source: 'user_input', requestedScope: 'bogus' }), 'project');
  ok('resolveScope：来源默认档 + global 限 user_input + external 强制会话层');

  // ── 2. 迁移：列幂等补齐 + 存量行回落 project ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mem-scope-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const mem = new MemoryManager({ db });
  const cols = new Set(db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
  assert.ok(cols.has('scope') && cols.has('conversation_id'), 'scope / conversation_id 列已补齐');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_scope'").get(), 'scope 索引已建');
  const now = Date.now();
  db.prepare(`INSERT INTO memories (id, space_id, domain, tier, content, importance, entity_tags,
    is_valid, compressed, re_hit_count, usage_count, created_at, updated_at)
    VALUES ('pre-1','/pre','session',1,'存量行',0.5,'[]',1,0,0,0,?,?)`).run(now, now);
  assert.strictEqual(db.prepare("SELECT scope FROM memories WHERE id='pre-1'").get().scope, 'project', '存量行默认 project');
  const mem2 = new MemoryManager({ db }); // 二次构造：幂等（列已存在不再 ALTER，不报错）
  assert.ok(mem2, '二次构造幂等');
  ok('迁移：scope/conversation_id 幂等补齐 + 存量行回落 project');

  // ── 3. remember：四来源分流 + 硬约束端到端 ──
  const s1 = mem.remember({ spaceId: '/s', domain: 'global_knowledge', content: '用户偏好用 pnpm', source: 'user_input' });
  assert.strictEqual(s1.scope, 'project', 'user_input → project');
  const s2 = mem.remember({ spaceId: '/s', domain: 'session', content: '本轮改了 A 文件', source: 'model_conclusion', conversationId: 'conv-1' });
  assert.strictEqual(s2.scope, 'session', 'model_conclusion → session');
  assert.strictEqual(s2.conversationId, 'conv-1', 'session 绑定 conversationId');
  const s3 = mem.remember({ spaceId: '/s', domain: 'reflection', content: '压缩摘要沉淀', source: 'compressor' });
  assert.strictEqual(s3.scope, 'project', 'compressor → project');
  assert.strictEqual(s3.conversationId, null, 'project 层解绑会话');
  const s4 = mem.remember({ spaceId: '/s', domain: 'global_knowledge', content: '外部网页片段', source: 'external_content', scope: 'global' });
  assert.strictEqual(s4.scope, 'session', 'external_content 请求 global 仍被强制会话层');
  const s5 = mem.remember({ spaceId: '/s', domain: 'global_knowledge', content: '模型想进全局', source: 'model_conclusion', scope: 'global' });
  assert.strictEqual(s5.scope, 'project', 'model_conclusion 请求 global 被降级 project');
  const s6 = mem.remember({ spaceId: '/s', domain: 'global_knowledge', content: '用户确认的全局资产', source: 'user_input', scope: 'global' });
  assert.strictEqual(s6.scope, 'global', 'user_input 请求 global 生效');
  ok('remember：四来源默认档 + global 硬约束 + external 禁 L3');

  // ── 4. 分层召回：会话绑定过滤 ──
  const qNoConv = mem.recall({ spaceId: '/s', scopes: [...SCOPES] });
  assert.ok(!qNoConv.some((m) => m.scope === 'session'), '无 conversationId 时不注入会话层');
  const qConv = mem.recall({ spaceId: '/s', scopes: [...SCOPES], conversationId: 'conv-1' });
  assert.ok(qConv.some((m) => m.scope === 'session' && m.content.includes('A 文件')), '有 conversationId 时返回本会话工作记忆');
  ok('分层召回：无会话不注入会话层 / 有会话命中');

  // ── 5. 分层配额严格封顶（空间 /quota）──
  for (let i = 0; i < 5; i += 1) mem.remember({ spaceId: '/quota', domain: 'session', content: `会话工作项 ${i}`, source: 'model_conclusion', conversationId: 'qc' });
  for (let i = 0; i < 5; i += 1) mem.remember({ spaceId: '/quota', domain: 'global_knowledge', content: `项目知识项 ${i}`, source: 'user_input' });
  for (let i = 0; i < 5; i += 1) mem.remember({ spaceId: '/quota', domain: 'global_knowledge', content: `全局资产项 ${i}`, source: 'user_input', scope: 'global' });
  const rq = mem.recall({ spaceId: '/quota', scopes: [...SCOPES], conversationId: 'qc' });
  assert.strictEqual(rq.filter((m) => m.scope === 'session').length, LAYER_QUOTA.session, `会话层配额=${LAYER_QUOTA.session}`);
  assert.strictEqual(rq.filter((m) => m.scope === 'project').length, LAYER_QUOTA.project, `项目层配额=${LAYER_QUOTA.project}`);
  assert.strictEqual(rq.filter((m) => m.scope === 'global').length, LAYER_QUOTA.global, `全局层配额=${LAYER_QUOTA.global}`);
  assert.strictEqual(rq.length, LAYER_QUOTA.session + LAYER_QUOTA.project + LAYER_QUOTA.global, '分层召回总数=配额和');
  ok('分层配额：session2 / project3 / global2 严格封顶');

  // ── 6. 跨层去重：同 content_hash 取更高层 ──
  mem.remember({ spaceId: '/dedup2', domain: 'session', content: '跨层共享内容X', source: 'model_conclusion', conversationId: 'dc' });
  mem.remember({ spaceId: '/dedup2', domain: 'global_knowledge', content: '跨层共享内容X', source: 'user_input' }); // → project 层
  const rd = mem.recall({ spaceId: '/dedup2', scopes: [...SCOPES], conversationId: 'dc' });
  const dupx = rd.filter((m) => m.content.includes('跨层共享内容X'));
  assert.strictEqual(dupx.length, 1, '跨层同内容去重为 1 条');
  assert.strictEqual(dupx[0].scope, 'session', '跨层去重取更高层（session 优先）');
  ok('跨层去重：同内容保留更高层（session > project > global）');

  // ── 7. global 层跨项目可见 ──
  // 用带匹配 query 的专用全局行做稳定断言（global 层配额仅 2 条且按 updated_at 取最新窗口，
  // 依赖早先写入的行会被后续行挤出；query 命中使 relevance=1 → 分数最高，稳定入选）。
  mem.remember({ spaceId: '/gprojA', domain: 'global_knowledge', content: '全局跨项目资产Q', source: 'user_input', scope: 'global' });
  const gAcross = mem.recall({ spaceId: '/projB', query: '全局跨项目资产Q', scopes: ['global'] });
  assert.ok(gAcross.some((m) => m.content.includes('全局跨项目资产Q')), 'global 层跨项目可召回');
  assert.ok(gAcross.every((m) => m.scope === 'global'), '仅返回 global 层条目');
  ok('global 层：跨项目可见');

  // ── 8. recallForPrompt：预算装配 + 可信度过滤 ──
  const longRow = 'A'.repeat(60);
  for (let i = 0; i < 6; i += 1) mem.remember({ spaceId: '/prompt', domain: 'global_knowledge', content: `${longRow}${i}`, source: 'user_input' });
  mem.remember({ spaceId: '/prompt', domain: 'session', content: '外部污染片段', source: 'external_content', conversationId: 'pc' });
  const promptTxt = mem.recallForPrompt({ projectPath: '/prompt', conversationId: 'pc', query: '', budgetChars: 130 });
  assert.strictEqual(typeof promptTxt, 'string', 'recallForPrompt 返回文本');
  assert.ok(promptTxt.length <= 130, `预算装配不超预算（${promptTxt.length} <= 130）`);
  assert.ok(promptTxt.startsWith('- '), '条目以「- 」前缀装配');
  assert.ok(!promptTxt.includes('外部污染片段'), '无 query：低可信（external_content）不进注入文本');
  const promptTxt2 = mem.recallForPrompt({ projectPath: '/prompt', conversationId: 'pc', query: '外部污染', budgetChars: 4000 });
  assert.ok(promptTxt2.includes('外部污染片段'), 'query 显式命中：低可信按低权重返回');
  ok('recallForPrompt：预算装配 + 可信度过滤（命中才带低可信）');

  // ── 9. promoteScope：仅向上晋升 + 解绑会话 ──
  const ps1 = mem.remember({ spaceId: '/ps', domain: 'session', content: '待晋升的会话记忆', source: 'model_conclusion', conversationId: 'mc' });
  const up = mem.promoteScope(ps1.id, 'project');
  assert.strictEqual(up.scope, 'project', 'session → project 晋升');
  assert.strictEqual(up.conversationId, null, '晋升离开会话层即解绑 conversationId');
  const same = mem.promoteScope(ps1.id, 'project');
  assert.strictEqual(same.scope, 'project', '同级请求保持不变');
  const dn = mem.promoteScope(ps1.id, 'session');
  assert.ok(dn && dn.scope === 'project', '降级请求被拒绝（保持 project）');
  assert.strictEqual(mem.promoteScope(ps1.id, 'bogus'), null, '非法目标返回 null');
  ok('promoteScope：仅向上晋升 / 同级保持 / 降级与非法目标拒绝');

  // ── 10. resetScope：会话层按 conversationId 精确删除 ──
  mem.remember({ spaceId: '/rs', domain: 'session', content: '待删会话项 1', source: 'model_conclusion', conversationId: 'rc' });
  mem.remember({ spaceId: '/rs', domain: 'session', content: '待删会话项 2', source: 'model_conclusion', conversationId: 'rc' });
  mem.remember({ spaceId: '/rs', domain: 'session', content: '他会话保留项', source: 'model_conclusion', conversationId: 'other' });
  const removed = mem.resetScope({ scope: 'session', conversationId: 'rc' });
  assert.strictEqual(removed, 2, '会话层按 conversationId 删除 2 条');
  const leftOther = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE space_id='/rs'").get().n;
  assert.strictEqual(leftOther, 1, '他会话条目保留');
  ok('resetScope：会话层按 conversationId 精确删除');

  // ── 11. updateMemory：改内容重算 hash + 更新元数据 ──
  const um = mem.remember({ spaceId: '/um', domain: 'session', content: '原始内容甲', source: 'model_conclusion', conversationId: 'uc' });
  const hashBefore = um.contentHash;
  const um2 = mem.updateMemory(um.id, { content: '更新内容乙', importance: 0.95 });
  assert.strictEqual(um2.content, '更新内容乙', '内容已更新');
  assert.notStrictEqual(um2.contentHash, hashBefore, '改内容同步重算 content_hash');
  assert.ok(Math.abs(um2.importance - 0.95) < 1e-6, 'importance 已更新');
  assert.strictEqual(mem.updateMemory('no-such-id', { content: 'x' }), null, '不存在返回 null');
  ok('updateMemory：改内容重算 hash / 元数据更新 / 缺 id 返回 null');

  // ── 12. importItems：显式 scope 批量导入 + 幂等 ──
  const imp1 = mem.importItems([
    { projectPath: '/imp', content: '导入甲' },
    { projectPath: '/imp', content: '导入乙' },
  ], { scope: 'project' });
  assert.strictEqual(imp1, 2, '首次导入 2 条');
  assert.strictEqual(mem.importItems([
    { projectPath: '/imp', content: '导入甲' },
    { projectPath: '/imp', content: '导入丙' },
  ], { scope: 'project' }), 2, '重复导入只刷新/新增（幂等，返回写入成功数）');
  const impN = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE space_id='/imp'").get().n;
  assert.strictEqual(impN, 3, '幂等：同内容不重复插（甲/乙/丙 共 3 条）');
  const impScope = db.prepare("SELECT scope FROM memories WHERE space_id='/imp' AND content='导入甲'").get().scope;
  assert.strictEqual(impScope, 'project', 'importItems 默认导入项目层');
  ok('importItems：显式 scope + 按条目幂等');

  // ── 13. resetScope：global 层清空（显式管理操作）──
  const gRemoved = mem.resetScope({ scope: 'global' });
  assert.ok(gRemoved >= 1, `清空 global 层（${gRemoved} 条）`);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='global'").get().n, 0, 'global 层已清空');
  ok('resetScope：global 层清空');

  console.log(`\n三层记忆 M0：${n} 项全部通过`);
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => { console.error(e); process.exit(1); });
