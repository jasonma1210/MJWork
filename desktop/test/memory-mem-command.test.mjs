// 三层记忆 M1 回归门禁（2026-10-20）：/mem 作用域分流 + IPC 层 domain/scope 透传与白名单。
// 锁定内容：
//   ① renderer /mem 分支的作用域→域映射为唯一事实来源：
//      无 -g → scope 'project' + domain 'global_knowledge'（零迁移，UI 文案显示为「项目知识」）；
//      有 -g → scope 'global' + domain 'private'（跨项目可见的用户显式资产）；
//   ② /mem 调用把 domain/scope 透传给 localAddMemory（不再硬编码单一域）；
//   ③ IPC local:memories/add 接收 domain（白名单校验，非法回落 global_knowledge）与 scope；
//   ④ 端到端：默认写项目级知识域；-g 写全局级私有域；未就绪队列同样保留 domain/scope。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const { openDbAsync } = require(path.resolve(import.meta.dirname, '../main/db/index.js'));
const { MemoryManager } = require(path.resolve(import.meta.dirname, '../main/memory/index.js'));

let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

(async () => {
  // ── 1. renderer /mem 分支映射（静态接线断言：映射即唯一事实来源）──
  const hookSrc = fs.readFileSync(
    path.join(DESKTOP, 'renderer', 'src', 'hooks', 'useAgentRun.ts'), 'utf8',
  );
  assert.match(hookSrc, /let scope = 'project';\s*let domain = 'global_knowledge';/,
    '/mem 默认档必须为 project + global_knowledge');
  assert.match(hookSrc, /scope = 'global';\s*domain = 'private';/,
    '/mem -g 档必须为 global + private');
  assert.match(hookSrc, /memText === '-g' \|\| memText\.startsWith\('-g '\) \|\| memText\.startsWith\('-g\\n'\)/,
    '/mem 必须识别 -g 标志（含行尾换行形态）');
  assert.match(hookSrc, /source: 'user_input',\s*domain,\s*scope/,
    '/mem 调用必须把 domain/scope 透传给 localAddMemory');
  ok('/mem 作用域分流：默认 project+global_knowledge / -g 为 global+private');

  // ── 2. IPC 层 harness（electron stub + localData 初始化）──
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mem-memcmd-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const mem = new MemoryManager({ db });
  const holder = { memoryManager: mem };
  localData.initLocalDataIpc({
    getLocalStore: () => null,
    getCredentialCrypto: () => null,
    localVault: new Map(),
    serverBase: () => '',
    MJ_SERVER_DEFAULT: '',
    getMemoryManager: () => holder.memoryManager,
    getMemoryScheduler: () => null,
  });

  const rowOf = (id) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  const add = (payload) => ipcHandlers['local:memories/add'](null, payload);

  // ── 3. 默认档：project + global_knowledge（/mem <内容>）──
  const rProject = await add({ projectPath: '/m1', content: '项目级知识偏好', source: 'user_input', domain: 'global_knowledge', scope: 'project' });
  const rowProject = rowOf(rProject.id);
  assert.strictEqual(rowProject.scope, 'project', '默认档落项目层');
  assert.strictEqual(rowProject.domain, 'global_knowledge', '默认档落知识域');
  ok('IPC 透传：默认档 project + global_knowledge 端到端生效');

  // ── 4. -g 档：global + private（/mem -g <内容>）──
  const rGlobal = await add({ projectPath: '/m1', content: '跨项目私有资产', source: 'user_input', domain: 'private', scope: 'global' });
  const rowGlobal = rowOf(rGlobal.id);
  assert.strictEqual(rowGlobal.scope, 'global', '-g 档落全局层');
  assert.strictEqual(rowGlobal.domain, 'private', '-g 档落私有域');
  assert.strictEqual(rowGlobal.conversation_id, null, '全局层解绑会话');
  ok('IPC 透传：-g 档 global + private 端到端生效');

  // ── 5. domain 白名单：非法值回落 global_knowledge ──
  const rBogus = await add({ projectPath: '/m1', content: '非法域写入', source: 'user_input', domain: 'bogus' });
  assert.strictEqual(rowOf(rBogus.id).domain, 'global_knowledge', '非法 domain 回落 global_knowledge');
  const rMiss = await add({ projectPath: '/m1', content: '缺省域写入', source: 'user_input' });
  assert.strictEqual(rowOf(rMiss.id).domain, 'global_knowledge', '缺省 domain 默认 global_knowledge');
  assert.strictEqual(rowOf(rMiss.id).scope, 'project', 'user_input 缺省 scope 经 resolveScope 落 project');
  ok('IPC：domain 白名单校验（非法/缺省均回落 global_knowledge）');

  // ── 6. 未就绪队列同样保留 domain/scope（flush 后不丢）──
  holder.memoryManager = null;
  const rQueued = await add({ projectPath: '/m1', content: '排队中的全局资产', source: 'user_input', domain: 'private', scope: 'global' });
  assert.ok(rQueued && rQueued.queued === true, '未就绪写入进内存队列');
  holder.memoryManager = mem;
  await add({ projectPath: '/m1', content: '触发队列补写', source: 'user_input' }); // 就绪后补写积压
  const queuedRow = db.prepare("SELECT * FROM memories WHERE space_id = '/m1' AND content = '排队中的全局资产'").get();
  assert.ok(queuedRow, '积压条目被补写');
  assert.strictEqual(queuedRow.scope, 'global', '队列补写保留 scope');
  assert.strictEqual(queuedRow.domain, 'private', '队列补写保留 domain');
  ok('IPC：未就绪队列保留 domain/scope（补写不丢作用域）');

  console.log(`\nM1 /mem 作用域分流门禁：${n} 项全部通过`);
  process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);
})().catch((e) => { console.error(e); process.exit(1); });
