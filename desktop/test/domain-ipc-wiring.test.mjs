// 只读域 IPC 装配门禁（2026-10-27）
//
// ── 为什么要有这一套 ──
// 真机现象：「账本」页打开就报加载失败；工件/Studio 面板恒空；知识库拿不到库。
// 根因是一处**按值捕获**：`main.js` 在**顶层**调 `registerDomainIpc({ taskDb, taskStore, ... })`，
// 而这些变量要等 `setupTaskOrchestration()` 异步跑完才有值 —— 那一瞬间它们全是 null。
// 被调方再把参数写成 `getDb: () => taskDb`，闭包锁的是**参数**（null 快照），
// 于是 `getDb()` 永远返回 null，四个只读域整体退化成 UNAVAILABLE。
//
// 「本地开发看着正常、打包后空白」这类事故的共同点：**没有任何断言读者问过
// 『依赖是什么时候被解析的』**。所以本套件守的不是某个返回值，而是装配时序本身：
//   ① 注册阶段一个依赖都不许解析（解析了就说明它拿到了当时的快照）；
//   ② 注册之后再注入，调用时必须读到**最新值**；
//   ③ 按值传（等价于传 null）必须能被区分出来 —— 证明 ①② 不是空过；
//   ④ main.js 调用点的源码形态：每个依赖都必须写成 `() => 变量`。
//
// 用统一的 electron 打桩（pnpm 下 `require.resolve('electron')` 才是 Node 真正会用的键）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installElectronStub } from './helpers/electronStub.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

// ── electron 桩：把 ipcMain.handle 收进 Map，其余最小面 ──
const handlers = new Map();
installElectronStub({
  ipcMain: {
    handle: (channel, fn) => { handlers.set(channel, fn); return undefined; },
    on: () => undefined,
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false },
  shell: { openPath: async () => '' },
  BrowserWindow: class {},
});

const { registerDomainIpc } = require('../main/ipc/registerDomains.js');
const { openSqliteJsDb } = require('../main/db/sqljsDb.js');
const ledgerQuery = require('../main/ledgerQuery.js');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.log(`❌ ${name}\n   ${e.message}`); }
};

/** 造一个只含账本所需表的内存库，并插一行真实消耗记录 */
async function buildDb(tokens) {
  const tmp = path.join(os.tmpdir(), `domain-wiring-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = await openSqliteJsDb(tmp);
  db.exec(`CREATE TABLE IF NOT EXISTS quota_consumptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT, run_id TEXT, task_id TEXT, member_id TEXT,
    tokens INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'round', created_at INTEGER NOT NULL
  )`);
  db.prepare('INSERT INTO quota_consumptions (project_id, run_id, task_id, member_id, tokens, source, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('prj-wire', 'run-wire', 'task-wire', null, tokens, 'round', Date.now());
  return db;
}

// ── 与 main.js 同构：变量先声明为 null，注册发生在赋值之前 ──
let artifactStore = null;
let projectStore = null;
let teamStore = null;
let taskStore = null;
let taskDb = null;
let mainWindow = null;
let featureFlags = null;

const touched = { artifact: 0, project: 0, team: 0, task: 0, db: 0, win: 0 };
const getters = {
  getArtifactStore: () => { touched.artifact += 1; return artifactStore; },
  getProjectStore: () => { touched.project += 1; return projectStore; },
  getTeamStore: () => { touched.team += 1; return teamStore; },
  getTaskStore: () => { touched.task += 1; return taskStore; },
  getTaskDb: () => { touched.db += 1; return taskDb; },
  getMainWindow: () => { touched.win += 1; return mainWindow; },
  getFlags: () => featureFlags,
};

// 顶层注册 —— 此刻所有存储都还是 null，与 main.js 的真实时序一致
registerDomainIpc({ ...getters, audit: () => {}, });

await check('① 注册阶段不解析任何依赖（解析了就说明拿到了 null 快照）', () => {
  const leaked = Object.entries(touched).filter(([, n]) => n > 0).map(([k]) => k);
  assert.deepEqual(leaked, [], `注册期就解析了：${leaked.join(', ')}`);
  // 通道确实注册上了（防止「什么都没注册」也算通过）
  for (const ch of ['ledger:query', 'ledger:export', 'artifacts:forProject', 'studio:projectRuns']) {
    assert.ok(handlers.has(ch), `通道未注册：${ch}`);
  }
});

await check('② 注册之后才注入依赖，调用时必须读到最新值（这是账本可用的唯一前提）', async () => {
  taskDb = await buildDb(4321); // 注册**之后**才赋值，模拟 setupTaskOrchestration 跑完
  const invoke = handlers.get('ledger:query');
  const res = await invoke({}, { filters: { from: null, to: null }, limit: 10, summaryDimensions: ['source'] });
  assert.equal(res?.ok, true, `ledger:query 没成功：${JSON.stringify(res)}`);
  assert.equal(res.summary.tokens, 4321, `汇总 token 不等于库内值：${res.summary?.tokens}`);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].taskId, 'task-wire');
  assert.ok(res.asOf > 0, 'asOf 应是单调 id 高水位');
});

await check('③ 反向样本：按值传（等价于传 null）必须表现为 UNAVAILABLE —— 证明 ② 不是空过', async () => {
  // 再注册一次，这次把 db getter 换成一个「锁死 null」的闭包，正是事故形态
  const frozen = null;
  registerDomainIpc({
    ...getters,
    getTaskDb: () => frozen,
    audit: () => {},
  });
  const invoke = handlers.get('ledger:query');
  const res = await invoke({}, { filters: {} });
  assert.equal(res?.ok, false, '锁死 null 时竟然成功了，说明 ② 的判据无效');
  assert.equal(res.code, 'UNAVAILABLE');
});

await check('④ 非 getter 实参必须大声报错，而不是静默变成「域不可用」', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    registerDomainIpc({ ...getters, getTaskDb: taskDb, audit: () => {} }); // 裸变量（真实 db，但形态错）
  } finally {
    console.error = orig;
  }
  assert.ok(
    errs.some((s) => s.includes('getTaskDb') && s.includes('不是 getter')),
    `未对按值传参报警：${JSON.stringify(errs)}`,
  );
  // 报警后仍要能起得来（顶层抛错 = 白屏），故恢复正确装配供后续断言
  registerDomainIpc({ ...getters, audit: () => {} });
  const res = await handlers.get('ledger:query')({}, { filters: {} });
  assert.equal(res.ok, true, '报警降级后重新装配应恢复可用');
});

await check('⑤ main.js 调用点：每个依赖都必须写成 `() => 变量`（静态形态守）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  const start = src.indexOf('registerDomainIpc({');
  assert.ok(start >= 0, 'main.js 里找不到 registerDomainIpc 调用');
  // 截到匹配的右括号（本调用没有嵌套对象字面量，按第一个 `}` 即可，但要自检长度）
  const seg = src.slice(start, start + 800);
  const end = seg.indexOf('});');
  assert.ok(end > 0, '没能界定 registerDomainIpc 调用范围');
  const call = seg.slice(0, end);
  assert.ok(call.length > 120, `截取到的调用片段过短（${call.length}），断言会空过`);

  for (const key of ['getArtifactStore', 'getProjectStore', 'getTeamStore', 'getTaskStore', 'getTaskDb']) {
    const m = call.match(new RegExp(`${key}\\s*:\\s*([^,}]+)`));
    assert.ok(m, `调用点缺少 ${key}`);
    assert.match(
      m[1].trim(), /^\(\s*\)\s*=>/,
      `${key} 必须写成 getter 箭头函数，实际是「${m[1].trim()}」—— 裸变量会把 null 快照进被调方闭包`,
    );
  }
  // 裸变量形态的直接证据（事故原文）：先把 `=> xxx` 的闭包体剔掉，再看有没有残留裸变量。
  // 不剔就会把 `getTaskDb: () => taskDb` 里的 taskDb 误判成裸变量（第一版就这么假红）。
  const stripped = call.replace(/=>\s*[A-Za-z_$][\w$]*/g, '=>');
  for (const bad of ['taskDb', 'taskStore', 'artifactStore', 'teamStore', 'projectStore']) {
    assert.ok(
      !new RegExp(`\\b${bad}\\b`).test(stripped),
      `调用点出现裸变量「${bad}」（剔除箭头函数体后仍存在）`,
    );
  }
});

await check('⑥ 账本查询内核与 IPC 口径一致（asOf 快照 + 汇总=明细合计）', async () => {
  const db = await buildDb(1000);
  db.prepare('INSERT INTO quota_consumptions (project_id, run_id, task_id, member_id, tokens, source, created_at) VALUES (?,?,?,?,?,?,?)')
    .run('prj-wire', 'run-2', 'task-2', null, 250, 'settle', Date.now());
  const page = ledgerQuery.queryPage(db, { filters: {}, limit: 100, dimensions: ['source'] });
  assert.equal(page.summary.tokens, page.items.reduce((s, i) => s + i.tokens, 0));
  assert.equal(page.asOf, ledgerQuery.currentAsOf(db));
});

// ── 设备域（2026-10-31）：两条只读通道的装配与降级 ──
// 这一域和上面的账本域不同：它不持存储、不需要 getter，数据全部来自现场枚举。
// 但它有两个**只靠读代码看不出来**的失败形态，必须断言：
//   ① 「挂上了」与「挂在哪里」是两件事 —— 通道必须在 registerDomainIpc 的装配链上注册，
//      否则 main.js 里没有任何人再调 initDeviceIpc，面板永远拿到空；
//   ② 探测抛错必须变成 `{ ok:false, error }`，不能让 IPC 抛 —— 渲染层 catch 到的只是
//      Electron 包装后的字符串，而面板会停在「加载中」或直接白屏。
// 断言只用注入的假实现，**不真跑** system_profiler / diskutil（机器相关且慢，
// 断言只能退化成「形状像不像」，那种断言对上面两种失败形态一条都抓不住）。
await check('⑦ 设备域通道已在 registerDomainIpc 装配链上注册（不是只在 main.js 里另开一处）', () => {
  for (const ch of ['device:probe', 'device:targets']) {
    assert.ok(handlers.has(ch), `通道未注册：${ch}`);
  }
});

await check('⑧ 探测与目标枚举都透传给注入的实现，且失败降级为 { ok:false } 而不是抛', async () => {
  const { initDeviceIpc } = require('../main/ipc/device.js');
  let probeCalls = 0;
  let targetCalls = 0;
  // 假实现刻意返回「形状与真实一致」的最小对象：断言读的是透传关系，不是造出来的数据
  initDeviceIpc({
    probe: async () => { probeCalls += 1; return { ok: true, platform: 'test', devices: [], channels: [], notes: ['fake'] }; },
    listTargets: async () => { targetCalls += 1; return { ok: true, ports: [], uf2Volumes: ['/Volumes/FAKE'], notes: [] }; },
  });
  const p = await handlers.get('device:probe')({});
  const t = await handlers.get('device:targets')({});
  assert.equal(probeCalls, 1, 'device:probe 没有调用注入的探测实现（通道被旁路）');
  assert.equal(targetCalls, 1, 'device:targets 没有调用注入的枚举实现');
  assert.equal(p.ok, true);
  assert.deepEqual(p.notes, ['fake']);
  assert.deepEqual(t.uf2Volumes, ['/Volumes/FAKE']);

  // 反向样本：实现抛错时必须是「解决为 ok:false」，而不是让 invoke 拒绝。
  // 若这里改成 rejects，面板侧的 try/catch 会走 catch 分支，错误信息只剩 Electron 包装串。
  initDeviceIpc({ probe: async () => { throw new Error('boom-probe'); } });
  const failed = await handlers.get('device:probe')({});
  assert.equal(failed.ok, false, '抛错后未降级为 ok:false');
  assert.match(String(failed.error), /boom-probe/, '降级结果没带出原始原因（事后无法定位）');

  // 反向样本：返回非对象（null / 字符串）也算失败 —— 渲染层拿到裸值会在解构时崩
  initDeviceIpc({ probe: async () => null });
  const bad = await handlers.get('device:probe')({});
  assert.equal(bad.ok, false, '非对象返回值未按失败处理');

  // 恢复默认实现，避免测试尾巴把「默认实现」这件事留成假象
  initDeviceIpc();
});

console.log(`\ndomain-ipc-wiring: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
