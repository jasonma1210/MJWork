// 三层记忆 M2 回归门禁（2026-10-20）：晋升链——会话删除 salvage（决策 3）+ 后台跨层晋升。
// 锁定内容：
//   ① 晋升阈值常量导出（salvage / promote-scope 共用单一事实来源）；
//   ② salvageConversation 两段式：有价值的 L1（命中≥3 或 tier≥3）→ L2 沉淀并解绑会话，其余 L1 物理删除；
//      他会话 / 项目层条目不受影响；spaceId 可选收窄；
//   ③ 会话删除 IPC 钩子：local:threads/purge 先 salvage 再删会话；salvage 失败 fail-open 不阻断删除；
//   ④ 后台 promote-scope：L1 命中≥3→L2（解绑会话）、L2 命中≥5 且 user_input→L3、model_conclusion 高频不升 L3；
//      autoEnqueue 周期性入队 promote-scope；
//   ⑤ 静态接线：localData 引用 salvageConversation、bgScheduler 登记 promote-scope 处理器。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const { openDbAsync } = require(path.resolve(import.meta.dirname, '../main/db/index.js'));
const {
  MemoryManager, SALVAGE_MIN_HITS, SALVAGE_MIN_TIER, PROMOTE_L1_MIN_HITS, PROMOTE_L2_MIN_HITS,
} = require(path.resolve(import.meta.dirname, '../main/memory/index.js'));
const { MemoryBgScheduler, PROCESSORS } = require(path.resolve(import.meta.dirname, '../main/memory/bgScheduler.js'));

let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

(async () => {
  // ── 1. 阈值常量 + 静态接线 ──
  assert.strictEqual(SALVAGE_MIN_HITS, 3);
  assert.strictEqual(SALVAGE_MIN_TIER, 3);
  assert.strictEqual(PROMOTE_L1_MIN_HITS, 3);
  assert.strictEqual(PROMOTE_L2_MIN_HITS, 5);
  assert.strictEqual(typeof PROCESSORS['promote-scope'], 'function', 'bgScheduler 必须登记 promote-scope 处理器');
  const localDataSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'ipc', 'localData.js'), 'utf8');
  assert.match(localDataSrc, /salvageConversation/, 'local:threads/purge 必须接线 salvageConversation');
  const bgSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'memory', 'bgScheduler.js'), 'utf8');
  assert.match(bgSrc, /'promote-scope'/, 'bgScheduler 源码必须含 promote-scope');
  ok('阈值常量 + 静态接线（promote-scope 处理器 / purge salvage 钩子）');

  // ── 2. salvageConversation 两段式 ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mem-salvage-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const mem = new MemoryManager({ db });
  const setMeta = (id, patch) => db.prepare('UPDATE memories SET re_hit_count = ?, tier = ? WHERE id = ?')
    .run(patch.hits || 0, patch.tier || 1, id);
  const scopeOf = (id) => db.prepare('SELECT scope, conversation_id, space_id FROM memories WHERE id = ?').get(id);

  const low = mem.remember({ spaceId: '/m2', domain: 'session', content: '低价值工作记忆', source: 'model_conclusion', conversationId: 'c1' });
  const hit = mem.remember({ spaceId: '/m2', domain: 'session', content: '高频命中工作记忆', source: 'model_conclusion', conversationId: 'c1' });
  const tiered = mem.remember({ spaceId: '/m2', domain: 'session', content: '已固化的工作记忆', source: 'model_conclusion', conversationId: 'c1' });
  setMeta(hit.id, { hits: 3, tier: 1 });
  setMeta(tiered.id, { hits: 0, tier: 3 });
  // 他会话 + 项目层条目（不应受影响）
  const otherConv = mem.remember({ spaceId: '/m2', domain: 'session', content: '他会话工作记忆', source: 'model_conclusion', conversationId: 'c2' });
  const projRow = mem.remember({ spaceId: '/m2', domain: 'global_knowledge', content: '项目级知识', source: 'user_input' });

  const res = mem.salvageConversation({ conversationId: 'c1' });
  assert.strictEqual(res.promoted, 2, '命中≥3 与 tier≥3 各沉淀 1 条（共 2）');
  assert.strictEqual(res.removed, 1, '低价值 L1 随会话物理删除 1 条');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?").get(low.id).n, 0, '低价值 L1 已删除');
  assert.strictEqual(scopeOf(hit.id).scope, 'project', '命中≥3 → 沉淀为项目级');
  assert.strictEqual(scopeOf(hit.id).conversation_id, null, '沉淀后解绑 conversation_id');
  assert.strictEqual(scopeOf(hit.id).space_id, '/m2', '沉淀保持原项目空间');
  assert.strictEqual(scopeOf(tiered.id).scope, 'project', 'tier≥3 → 沉淀为项目级');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope='session' AND conversation_id IS 'c1'").get().n, 0, '会话层已清空');
  assert.strictEqual(scopeOf(otherConv.id).scope, 'session', '他会话条目不受影响');
  assert.strictEqual(scopeOf(projRow.id).scope, 'project', '项目层条目不受影响');
  // 空 conversationId 安全返回
  assert.deepStrictEqual(mem.salvageConversation({ conversationId: '' }), { promoted: 0, removed: 0 }, '空会话安全返回零');
  ok('salvageConversation：两段式沉淀（命中≥3 / tier≥3 升 L2，其余删；他会话与项目层不受影响）');

  // ── 3. spaceId 可选收窄 ──
  const inA = mem.remember({ spaceId: '/sa', domain: 'session', content: 'A 空间会话记忆', source: 'model_conclusion', conversationId: 'cx' });
  const inB = mem.remember({ spaceId: '/sb', domain: 'session', content: 'B 空间会话记忆', source: 'model_conclusion', conversationId: 'cx' });
  setMeta(inA.id, { hits: 5, tier: 1 });
  setMeta(inB.id, { hits: 5, tier: 1 });
  const resA = mem.salvageConversation({ conversationId: 'cx', spaceId: '/sa' });
  assert.strictEqual(resA.promoted, 1, 'spaceId 收窄：仅处理该空间 1 条');
  assert.strictEqual(scopeOf(inB.id).scope, 'session', '他空间同会话条目未被触及');
  ok('salvageConversation：spaceId 可选收窄范围');

  // ── 4. 后台 promote-scope：跨层晋升规则 ──
  const l1 = mem.remember({ spaceId: '/bg', domain: 'session', content: 'L1 高频工作记忆', source: 'model_conclusion', conversationId: 'bgc' });
  const l2user = mem.remember({ spaceId: '/bg', domain: 'global_knowledge', content: 'L2 高频用户知识', source: 'user_input' });
  const l2model = mem.remember({ spaceId: '/bg', domain: 'global_knowledge', content: 'L2 高频模型结论', source: 'model_conclusion', conversationId: 'bgc2' });
  setMeta(l1.id, { hits: 3, tier: 1 });
  setMeta(l2user.id, { hits: 5, tier: 1 });
  setMeta(l2model.id, { hits: 5, tier: 1 });
  const pRes = mem.promoteScopeByHits({});
  assert.ok(pRes.toProject >= 1, `L1 高频升 L2（${pRes.toProject} 条）`);
  assert.ok(pRes.toGlobal >= 1, `L2 高频 user_input 升 L3（${pRes.toGlobal} 条）`);
  assert.strictEqual(scopeOf(l1.id).scope, 'project', 'L1 命中≥3 → L2');
  assert.strictEqual(scopeOf(l1.id).conversation_id, null, 'L1→L2 解绑会话');
  assert.strictEqual(scopeOf(l2user.id).scope, 'global', 'L2 命中≥5 且 user_input → L3');
  assert.strictEqual(scopeOf(l2model.id).scope, 'project', 'model_conclusion 即使高频也不升 L3（防自动沉淀污染全局）');
  ok('promoteScopeByHits：L1→L2 / L2(user_input)→L3 / model 不升 L3');

  // ── 5. bgScheduler 端到端：enqueue + drain 执行 promote-scope ──
  const l1b = mem.remember({ spaceId: '/bg2', domain: 'session', content: '调度器 L1 高频', source: 'model_conclusion', conversationId: 'bg2c' });
  setMeta(l1b.id, { hits: 3, tier: 1 });
  const sched = new MemoryBgScheduler({ db: mem.db, memory: mem, emit: () => {} });
  sched.enqueue('promote-scope', {}, { priority: 3 });
  await sched.runOne();
  assert.strictEqual(scopeOf(l1b.id).scope, 'project', '调度器执行 promote-scope 后 L1 升 L2');
  const autoN = sched.autoEnqueue({});
  assert.ok(autoN >= 1, 'autoEnqueue 周期性入队维护任务');
  const queuedScope = db.prepare("SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE type = 'promote-scope'").get().n;
  assert.ok(queuedScope >= 1, 'autoEnqueue 含 promote-scope 任务');
  ok('bgScheduler：promote-scope 端到端执行 + autoEnqueue 入队');

  // ── 6. 会话删除 IPC 钩子：purge 先 salvage 再删会话 ──
  const ModuleC = require('module');
  const electronPath = require.resolve('electron');
  const ipcHandlers = {};
  const electronStub = { ipcMain: { handle: (name, fn) => { ipcHandlers[name] = fn; } }, shell: {} };
  const stubModule = new ModuleC(electronPath, null);
  stubModule.filename = electronPath;
  stubModule.loaded = true;
  stubModule.exports = electronStub;
  require.cache[electronPath] = stubModule;
  const localData = require('../main/ipc/localData');

  const purgeCalls = [];
  const fakeStore = { purgeThread: (id) => { purgeCalls.push(id); return { ok: true }; } };
  // 独立 db：线程 10 的会话记忆——1 条高频（应沉淀）+ 1 条低价值（应删）
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mem-salvage-ipc-'));
  const db2 = await openDbAsync(dir2, { driver: 'sqljs' });
  const mem2 = new MemoryManager({ db: db2 });
  const keep = mem2.remember({ spaceId: '/p10', domain: 'session', content: '线程10高频记忆', source: 'model_conclusion', conversationId: '10' });
  const drop = mem2.remember({ spaceId: '/p10', domain: 'session', content: '线程10低价值记忆', source: 'model_conclusion', conversationId: '10' });
  db2.prepare('UPDATE memories SET re_hit_count = 3 WHERE id = ?').run(keep.id);
  const holder = { mm: mem2 };
  localData.initLocalDataIpc({
    getLocalStore: () => fakeStore,
    getCredentialCrypto: () => null,
    localVault: new Map(),
    serverBase: () => '',
    MJ_SERVER_DEFAULT: '',
    getMemoryManager: () => holder.mm,
    getMemoryScheduler: () => null,
  });
  const purge = (payload) => ipcHandlers['local:threads/purge'](null, payload);
  const r = await purge({ threadId: 10 });
  assert.deepStrictEqual(purgeCalls, [10], 'purge 落到 store（数字 id）');
  assert.ok(r && r.salvage, 'purge 返回 salvage 统计');
  assert.strictEqual(r.salvage.promoted, 1, '高频 L1 沉淀 1 条');
  assert.strictEqual(r.salvage.removed, 1, '低价值 L1 删除 1 条');
  assert.strictEqual(db2.prepare('SELECT scope FROM memories WHERE id = ?').get(keep.id).scope, 'project', '会话删除后高频记忆沉淀为项目级');
  assert.strictEqual(db2.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(drop.id).n, 0, '低价值记忆随会话删除');
  ok('IPC：local:threads/purge 先 salvage 沉淀再删会话（返回 salvage 统计）');

  // ── 7. fail-open：salvage 抛错不阻断会话删除 ──
  const purgeCalls2 = [];
  const fakeStore2 = { purgeThread: (id) => { purgeCalls2.push(id); return { ok: true }; } };
  holder.mm = { salvageConversation: () => { throw new Error('boom'); } };
  localData.initLocalDataIpc({
    getLocalStore: () => fakeStore2,
    getCredentialCrypto: () => null,
    localVault: new Map(),
    serverBase: () => '',
    MJ_SERVER_DEFAULT: '',
    getMemoryManager: () => holder.mm,
    getMemoryScheduler: () => null,
  });
  const handler2 = ipcHandlers['local:threads/purge'];
  const r2 = await handler2(null, { threadId: 11 });
  assert.deepStrictEqual(purgeCalls2, [11], 'salvage 异常仍执行会话删除（fail-open）');
  assert.ok(!r2.salvage, 'salvage 失败时不返回统计（不阻断）');
  ok('IPC：salvage 失败 fail-open（不阻断会话删除）');

  // 显式关闭两个连接再退出：避免 process 'exit' 兜底 flush 在 Linux CI runner 上
  // 触发 180s 超时（同 team-store.test.js / taskStore.test.js 的处理纪律）。
  db.close();
  db2.close();

  console.log(`\n三层记忆 M2 晋升链门禁：${n} 组全部通过`);
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => { console.error(e); process.exit(1); });
