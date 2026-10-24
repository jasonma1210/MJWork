// P2 记忆体系测试：scorer 六因子 / MemoryManager 五域四层 / 分层召回 / 压缩晋升衰减清理 / BgScheduler
// P0-2b/P0-2c/P1-16/P1-17/P3-3（2026-10-17 记忆回路修复）新增：
//   hash 去重 / 来源可信度分级与域降级 / 未知来源拒绝 / 召回信任过滤 /
//   分域半衰期 / promoteToLongTerm / recall 限量与 Top-K 钳制 / 单空间容量总闸 /
//   importLegacy 按条目幂等 / IPC 层双轨修复（未就绪进内存队列不落 JSON）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { MemoryManager } = require('../main/memory');
const { MemoryBgScheduler } = require('../main/memory/bgScheduler');
const scorer = require('../main/memory/scorer');

let n = 0;
function ok(name) { n += 1; console.log(`  ✓ ${name}`); }

(async () => {
  // ── 1. scorer 六因子 ──
  assert.ok(scorer.relevance('数据库迁移 schema', '项目的 schema 迁移与数据库升级流程') > 0.2, '词法相关性');
  assert.strictEqual(scorer.relevance('完全无关的话题xyz', '数据库迁移'), 0);
  const old = { is_valid: 1, importance: 0.8, usage_count: 0, tier: 1, updated_at: Date.now() - 28 * 24 * 3600 * 1000 };
  const fresh = { is_valid: 1, importance: 0.8, usage_count: 0, tier: 1, updated_at: Date.now() };
  assert.ok(scorer.recencyScore(old.updated_at) < 0.3 && scorer.recencyScore(fresh.updated_at) > 0.9, '半衰期 14 天衰减');
  assert.ok(scorer.scoreMemory(old).total < scorer.scoreMemory(fresh).total, '旧记忆总分更低');
  assert.strictEqual(scorer.scoreMemory({ ...fresh, is_valid: 0 }).total, 0, '失效硬闸归零');
  ok('scorer：相关性/衰减/失效闸');

  // ── 2. MemoryManager：五域写入 + 分层召回 ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mem-'));
  const mem = new MemoryManager({ db: await openDbAsync(dir, { driver: 'sqljs' }) });
  mem.remember({ spaceId: '/proj', domain: 'global_knowledge', content: '项目使用 pnpm monorepo，13 个包', importance: 0.9 });
  mem.remember({ spaceId: '/proj', domain: 'session', content: '今天修复了审批通道竞态 Bug', importance: 0.6 });
  mem.remember({ spaceId: '/other', domain: 'session', content: '别的项目的记忆不应该出现' });
  const hits = mem.recall({ spaceId: '/proj', query: 'monorepo 包结构', topK: 5 });
  assert.ok(hits.length >= 1 && hits[0].content.includes('pnpm monorepo'), '按查询相关性命中');
  assert.ok(!hits.some((h) => h.content.includes('别的项目')), '空间隔离（跨项目不可见）');
  assert.strictEqual(mem.get(hits[0].id).reHitCount, 1, '命中计数自增');
  const noQuery = mem.recallContents({ spaceId: '/proj', topK: 5 });
  assert.ok(noQuery.length === 2, '无查询退化为 importance×recency Top-K');
  ok('MemoryManager：五域写入/空间隔离/召回路由/命中计数');

  // ── 3. 压缩（Tier1→Tier2，stub LLM）──
  for (let i = 0; i < 5; i += 1) {
    mem.remember({ spaceId: '/proj', domain: 'session', content: `会话记录 ${i}：讨论了模块 ${i} 的实现方案`, importance: 0.5 });
  }
  let llmCalls = 0;
  const c = await mem.compress({
    spaceId: '/proj', domain: 'session', batchSize: 10,
    chatOnce: async () => { llmCalls += 1; return { content: '要点：本次会话讨论了模块 0-4 的实现方案并达成结论。' }; },
    model: { providerId: 1, isGlobal: true, baseUrl: '', model: 'm' },
  });
  assert.strictEqual(llmCalls, 1, '批量合并为 1 次 LLM 调用');
  assert.strictEqual(c.wrote, 1, '压缩产出 1 条 Tier2');
  assert.strictEqual(c.compressed, 6, `合并 6 条源 Tier1（1 旧 + 5 新）`);
  const t2 = mem.recall({ spaceId: '/proj', topK: 10 }).filter((m) => m.tier === 2);
  assert.ok(t2.length === 1 && t2[0].content.includes('模块 0-4'), 'Tier2 摘要在召回中');
  assert.ok(!mem.recall({ spaceId: '/proj', topK: 20 }).some((m) => m.compressed), '已压缩 Tier1 不再返回');
  ok('memoryCompressor：批量合并 → 1 次 LLM → Tier2 落库');

  // ── 4. 晋升：高频 Tier2 → Tier3 ──
  for (let i = 0; i < 3; i += 1) mem.recall({ spaceId: '/proj', query: '模块', topK: 1 });
  const promoted = mem.promoteByHits(3);
  assert.ok(promoted >= 1, `高频摘要晋升（${promoted} 条）`);
  assert.ok(mem.recall({ spaceId: '/proj', topK: 20 }).some((m) => m.tier === 3), 'Tier3 存在');
  ok('晋升：re_hit ≥3 的 Tier2 → Tier3 固化');

  // ── 5. 衰减 + 清理 ──
  mem.remember({ spaceId: '/proj', domain: 'session', content: '低价值临时记录', importance: 0.06 });
  mem.db.prepare('UPDATE memories SET updated_at = ? WHERE content = ?').run(Date.now() - 30 * 24 * 3600 * 1000, '低价值临时记录');
  const d = mem.decayJob({});
  assert.ok(d.invalidated >= 1, `低分失效（${d.invalidated} 条）`);
  mem.db.prepare('UPDATE memories SET updated_at = ? WHERE is_valid = 0').run(Date.now() - 10 * 24 * 3600 * 1000);
  const cl = mem.cleanupJob({});
  assert.ok(cl.purged >= 1, `失效过期清理（${cl.purged} 条）`);
  ok('衰减 + 清理（防膨胀）');

  // ── 6. BgScheduler：入队/执行/重试/卡死防线/恢复 ──
  const sched = new MemoryBgScheduler({ db: mem.db, memory: mem, emit: () => {} });
  sched.enqueue('decay', {}, { priority: 4 });
  sched.enqueue('cleanup', {}, { priority: 5 });
  const drained = await sched.drain(10);
  assert.ok(drained.length === 2 && drained.every((r) => r.result), '后台任务执行成功');
  // 失败重试：未知类型 → 回队 → attempts 累积 → 超限判死
  sched.enqueue('unknown-type', {}, { priority: 1 });
  await sched.runOne();
  const after1 = sched.listTasks({ limit: 5 }).find((t) => t.type === 'unknown-type');
  assert.strictEqual(after1.status, 'queued', '失败回队');
  let last = null;
  for (let i = 0; i < 5; i += 1) last = await sched.runOne();
  const dead = sched.listTasks({ limit: 10 }).find((t) => t.type === 'unknown-type');
  assert.strictEqual(dead.status, 'failed', '超过 3 次尝试判死（卡死防线）');
  // 重启恢复：queued 任务仍在表中（新实例可继续消费）
  sched.enqueue('cleanup', {}, { priority: 5 });
  const sched2 = new MemoryBgScheduler({ db: mem.db, memory: mem, emit: () => {} });
  const resumed = await sched2.drain(5);
  assert.ok(resumed.some((r) => r.task.type === 'cleanup'), '重启后 queued 任务被新调度器恢复续跑');
  // P0-19：purgeHistory 清理过期与超限的 done/failed 行，且不碰 queued/running
  for (let i = 0; i < 12; i += 1) {
    mem.db.prepare(`INSERT INTO memory_bg_tasks (id, type, payload, priority, status, attempts, created_at, updated_at)
      VALUES (?, 'decay', '{}', 4, 'done', 1, ?, ?)`).run(`old-done-${i}`, Date.now() - 10 * 86400000, Date.now() - 10 * 86400000);
  }
  for (let i = 0; i < 8; i += 1) {
    mem.db.prepare(`INSERT INTO memory_bg_tasks (id, type, payload, priority, status, attempts, created_at, updated_at)
      VALUES (?, 'decay', '{}', 4, 'done', 1, ?, ?)`).run(`recent-done-${i}`, Date.now(), Date.now() + i);
  }
  const keepTask = sched2.enqueue('promote', {}, { priority: 3 });
  const pr = sched2.purgeHistory({ retentionMs: 7 * 86400000, maxRows: 5 });
  assert.strictEqual(pr.expired, 12, '超过 7 天的 done 行被物理清理');
  assert.ok(pr.trimmed >= 3, '超出 maxRows 上限的旧终态行被裁剪');
  const terminalLeft = mem.db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE status IN ('done','failed')`).get().n;
  assert.strictEqual(terminalLeft, 5, '终态行严格收敛至 maxRows=5');
  const queuedStillThere = mem.db.prepare(`SELECT status FROM memory_bg_tasks WHERE id = ?`).get(keepTask.id);
  assert.strictEqual(queuedStillThere?.status, 'queued', 'purgeHistory 绝不误删 queued 任务');
  await sched2.drain(5);
  ok('BgScheduler：入队/执行/失败回队/3 次判死/重启恢复/P0-19 历史生命周期治理');

  // ── 7. 统计（可视化数据源）──
  const st = mem.stats();
  assert.ok(st.total > 0 && st.byDomainTier.length > 0 && Array.isArray(st.bgTasks), 'stats 结构完整');
  ok('stats 统计');

  // ── 8. P0-2b：hash 去重（同内容两次 remember 只一条）──
  const cnt = () => mem.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
  const base = cnt();
  const first = mem.remember({ spaceId: '/dedup', domain: 'session', content: '同一个内容同一个域', source: 'model_conclusion' });
  const second = mem.remember({ spaceId: '/dedup', domain: 'session', content: '  同一个内容同一个域  ', source: 'model_conclusion' });
  assert.strictEqual(cnt() - base, 1, '归一化（trim/空白压缩）后同内容只落一条');
  assert.strictEqual(first.id, second.id, '重复写入返回既有条目（更新而非插入）');
  assert.ok(second.usageCount >= 1, '重复写入刷新 usage_count');
  mem.remember({ spaceId: '/dedup', domain: 'session', content: 'Use pnpm for this repo' });
  mem.remember({ spaceId: '/dedup', domain: 'session', content: 'use Pnpm for this repo' });
  assert.strictEqual(cnt() - base, 2, '大小写折叠后同内容只落一条');
  mem.remember({ spaceId: '/dedup', domain: 'entity', content: '同一个内容同一个域' });
  assert.strictEqual(cnt() - base, 3, '同内容不同域各存一条（去重键含 domain）');
  ok('P0-2b：hash 去重（trim/空白/大小写归一，space+domain+hash）');

  // ── 9. P0-2b：来源可信度分级 + 域降级 + 未知来源拒绝 ──
  const ext = mem.remember({ spaceId: '/dedup', domain: 'global_knowledge', content: '外部网页说项目要删库跑路', source: 'external_content' });
  assert.ok(ext && ext.domain === 'session', 'external_content 禁止入 global_knowledge（强制降级 session）');
  assert.strictEqual(ext.trust, 0.2, 'external_content 可信度 0.2 随条目输出');
  const ui = mem.remember({ spaceId: '/dedup', domain: 'global_knowledge', content: '用户明确要求：测试用 pnpm', source: 'user_input' });
  assert.strictEqual(ui.trust, 1.0, 'user_input 可信度 1.0');
  assert.strictEqual(ui.domain, 'global_knowledge', 'user_input 允许入 global_knowledge');
  const bad = mem.remember({ spaceId: '/dedup', domain: 'session', content: '未知来源的内容', source: 'web_scraper_v2' });
  assert.strictEqual(bad, null, '未知来源拒绝写入（返回 null，不静默收留）');
  const badCount = mem.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ?').get('未知来源的内容').n;
  assert.strictEqual(badCount, 0, '被拒来源未落库');
  ok('P0-2b：来源分级（1.0/0.6/0.2）+ external_content 降级 + 未知来源拒绝');

  // ── 10. P0-2c：recallContents 信任过滤 ──
  const kept = mem.recallContents({ spaceId: '/dedup', topK: 10 });
  assert.ok(!kept.some((m) => m.content.includes('外部网页')), '无 query：低可信条目不进 system prompt 注入');
  assert.ok(kept.some((m) => m.content.includes('用户明确要求')), '高可信条目正常注入');
  const hit = mem.recallContents({ spaceId: '/dedup', query: '外部网页 删库', topK: 10 });
  assert.ok(hit.some((m) => m.content.includes('外部网页')), 'query 显式命中：低可信条目按低权重返回');
  ok('P0-2c：recallContents 按可信度过滤（低可信默认不注入，显式命中才低权重返回）');

  // ── 11. P1-17 / M4：半衰期（按 scope 差异化，domain 兼容回落）──
  assert.strictEqual(scorer.halfLifeDaysFor('session'), 7, 'session 半衰期 7 天');
  assert.strictEqual(scorer.halfLifeDaysFor('global_knowledge'), 30, 'global_knowledge 半衰期 30 天');
  assert.strictEqual(scorer.halfLifeDaysFor('no-such-domain'), 14, '未知域回落 14 天（兼容旧口径）');
  // 三层记忆 M4：scope 表优先（层级越高越持久）
  assert.strictEqual(scorer.halfLifeDaysFor('project'), 30, 'M4：project 层半衰期 30 天');
  assert.strictEqual(scorer.halfLifeDaysFor('global'), 90, 'M4：global 层半衰期 90 天（最持久）');
  const halfTs = Date.now() - 14 * 24 * 3600 * 1000;
  assert.ok(scorer.recencyScore(halfTs, Date.now(), 'session') < scorer.recencyScore(halfTs, Date.now(), 'global'),
    '同一时间点：session 层半衰期短 → recency 分更低');
  mem.remember({ spaceId: '/half', domain: 'session', content: '半衰期测试 session', importance: 0.5 });
  mem.db.prepare('UPDATE memories SET updated_at = ? WHERE content = ?').run(Date.now() - 14 * 86400000, '半衰期测试 session');
  // 项目层：user_input 来源 → scope=project（30 天）
  mem.remember({ spaceId: '/half', domain: 'global_knowledge', content: '半衰期测试 global', importance: 0.5, source: 'user_input' });
  mem.db.prepare('UPDATE memories SET updated_at = ? WHERE content = ?').run(Date.now() - 14 * 86400000, '半衰期测试 global');
  // 三层记忆 M4：全局层（scope=global，90 天）——同 14 天衰减最慢
  mem.remember({ spaceId: '/half', domain: 'private', content: '半衰期测试 L3', importance: 0.5, source: 'user_input', scope: 'global' });
  mem.db.prepare('UPDATE memories SET updated_at = ? WHERE content = ?').run(Date.now() - 14 * 86400000, '半衰期测试 L3');
  mem.decayJob({});
  const afterS = mem.db.prepare('SELECT importance FROM memories WHERE content = ?').get('半衰期测试 session');
  const afterG = mem.db.prepare('SELECT importance FROM memories WHERE content = ?').get('半衰期测试 global');
  const afterL3 = mem.db.prepare('SELECT importance FROM memories WHERE content = ?').get('半衰期测试 L3');
  assert.ok(Math.abs(afterS.importance - 0.125) < 0.01, `session 14 天衰减到 0.125（实际 ${afterS.importance}）`);
  assert.ok(Math.abs(afterG.importance - 0.5 * Math.pow(0.5, 14 / 30)) < 0.01, `project 层 30 天半衰期衰减更慢（实际 ${afterG.importance}）`);
  assert.ok(Math.abs(afterL3.importance - 0.5 * Math.pow(0.5, 14 / 90)) < 0.01, `M4：global 层 90 天半衰期衰减最慢（实际 ${afterL3.importance}）`);
  assert.ok(afterS.importance < afterG.importance && afterG.importance < afterL3.importance, 'M4：三层衰减速率单调（session > project > global）');
  ok('P1-17 / M4：半衰期按 scope 差异化（session 7 / project 30 / global 90，domain 回落）');

  // ── 12. P1-17：promoteToLongTerm（人工确认长期留存）+ invalidate ──
  const keep = mem.remember({ spaceId: '/half', domain: 'global_knowledge', content: '需要长期保留的知识', source: 'user_input' });
  const promotedKeep = mem.promoteToLongTerm(keep.id);
  assert.ok(promotedKeep && promotedKeep.tier === 3, 'promoteToLongTerm 晋升 Tier3');
  mem.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(Date.now() - 60 * 86400000, keep.id);
  mem.decayJob({});
  assert.strictEqual(mem.get(keep.id).tier, 3, 'Tier3 晋升后不被衰减（长期留存）');
  const deadItem = mem.remember({ spaceId: '/half', domain: 'session', content: '即将失效' });
  mem.invalidate(deadItem.id, '测试作废');
  assert.strictEqual(mem.get(deadItem.id).isValid, false, 'invalidate 置 is_valid=0');
  assert.strictEqual(mem.promoteToLongTerm(deadItem.id), null, '已失效条目不予晋升');
  ok('P1-17：promoteToLongTerm / invalidate');

  // ── 13. P3-3：recall 限量载入 + Top-K 钳制 ──
  for (let i = 0; i < 60; i += 1) mem.remember({ spaceId: '/cap', domain: 'session', content: `批量记忆 ${i}`, importance: 0.5 });
  const clamped = mem.recall({ spaceId: '/cap', topK: 1000 });
  assert.strictEqual(clamped.length, 50, 'Top-K 钳制在硬上限 50');
  const scoped = mem.recall({ spaceId: '/cap', topK: 5, scanLimit: 3 });
  assert.strictEqual(scoped.length, 3, 'scanLimit 限量载入生效（不打全量）');
  ok('P3-3：recall 限量载入 + Top-K 钳制');

  // ── 14. P3-3：单空间容量总闸（写入侧硬上限，session 域优先淘汰，知识域受保护）──
  for (let i = 0; i < 505; i += 1) {
    mem.remember({ spaceId: '/overflow', domain: i % 10 === 0 ? 'global_knowledge' : 'session', content: `容量测试 ${i}`, importance: 0.5 });
  }
  const overflowN = mem.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE space_id = ?').get('/overflow').n;
  assert.ok(overflowN <= 500, `容量总闸生效（${overflowN} <= 500）`);
  const gkLeft = mem.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE space_id = ? AND domain = 'global_knowledge'`).get('/overflow').n;
  assert.strictEqual(gkLeft, 51, 'global_knowledge 受保护不淘汰');
  ok('P3-3：单空间容量总闸（500 条硬上限，知识域受保护）');

  // ── 15. P1-16：importLegacy 按条目幂等 ──
  assert.strictEqual(mem.importLegacy([
    { projectPath: '/legacy', content: '旧记忆甲' },
    { projectPath: '/legacy', content: '旧记忆乙' },
  ]), 2);
  const n1 = mem.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE space_id = ?').get('/legacy').n;
  mem.importLegacy([
    { projectPath: '/legacy', content: '旧记忆甲' },
    { projectPath: '/legacy', content: '旧记忆乙' },
    { projectPath: '/legacy', content: '旧记忆丙' },
  ]);
  const n2 = mem.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE space_id = ?').get('/legacy').n;
  assert.strictEqual(n2, n1 + 1, '重复导入只补新增条目（按条目幂等，不重复插）');
  ok('P1-16：importLegacy 按条目幂等');

  // ── 16. P1-16：双轨修复（IPC 层）——Manager 未就绪时进内存队列，绝不落 JSON ──
  const Module = require('module');
  const electronPath = require.resolve('electron');
  const ipcHandlers = {};
  const electronStub = { ipcMain: { handle: (name, fn) => { ipcHandlers[name] = fn; } }, shell: {} };
  const stubModule = new Module(electronPath, null);
  stubModule.filename = electronPath;
  stubModule.loaded = true;
  stubModule.exports = electronStub;
  require.cache[electronPath] = stubModule;
  const localData = require('../main/ipc/localData');
  const holder = { memoryManager: null };
  localData.initLocalDataIpc({
    getLocalStore: () => null,
    getCredentialCrypto: () => null,
    localVault: new Map(),
    serverBase: () => '',
    MJ_SERVER_DEFAULT: '',
    getMemoryManager: () => holder.memoryManager,
    getMemoryScheduler: () => null,
  });
  const r1 = await ipcHandlers['local:memories/add'](null, { projectPath: '/q', content: '未就绪时的记忆', source: 'model_conclusion' });
  assert.ok(r1 && r1.queued === true, 'Manager 未就绪：写入进内存队列（不落 JSON）');
  const r2 = await ipcHandlers['local:memories/list'](null, { projectPath: '/q' });
  assert.deepStrictEqual(r2, [], 'Manager 未就绪：列表返回空（JSON 降级分支已删除）');
  holder.memoryManager = mem;
  const r3 = await ipcHandlers['local:memories/add'](null, { projectPath: '/q', content: '就绪后的记忆', source: 'model_conclusion' });
  assert.ok(r3 && r3.id, 'Manager 就绪：直接写入 SQLite');
  const qItems = mem.db.prepare('SELECT * FROM memories WHERE space_id = ?').all('/q');
  assert.strictEqual(qItems.length, 2, '就绪后积压队列被补写（排队条目不丢）');
  assert.ok(qItems.some((x) => x.content === '未就绪时的记忆'), '积压条目内容完整补写');
  const r4 = await ipcHandlers['local:memories/add'](null, { projectPath: '/q', content: '坏来源', source: 'mystery' });
  assert.ok(r4 && r4.ok === false, 'IPC 层未知来源被拒绝并返回错误');
  const listR = await ipcHandlers['memory:list'](null, { projectPath: '/q', limit: 10 });
  assert.ok(listR.ok && Array.isArray(listR.items) && listR.items.length === 2, 'memory:list 返回项目维度列表');
  assert.ok(typeof listR.items[0].trust === 'number', '列表条目带可信度字段');
  const invR = await ipcHandlers['memory:invalidate'](null, { id: listR.items[0].id });
  assert.ok(invR.ok && invR.item.isValid === false, 'memory:invalidate 单条作废');
  const prR = await ipcHandlers['memory:promote'](null, { id: listR.items[1].id });
  assert.ok(prR.ok && prR.item.tier === 3, 'memory:promote 晋升长期留存');
  ok('P1-16：双轨修复（内存队列 + 就绪补写）与记忆管理 IPC');

  console.log(`\nP2 记忆体系：${n} 项全部通过`);
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => { console.error(e); process.exit(1); });
