// 本地数据 IPC 的 id 形态回归（2026-10-17 真机事故）
//
// 事故形态（用户实测）：对话里所有消息都落不了库，报
//   Error invoking remote method 'local:messages/add':
//   PayloadError: 载荷非法：threadId 必须是字符串（收到 number）
// 整个 run 因此中止。
//
// 根因：`localStore.nextId()` 返回的是**数字**（`this.data.seq++`），`addMessage` 内部也是
// `Number(threadId)`；也就是说 store 的契约本来就是「数字或纯数字字符串」。
// 但边界层把这批 id 交给了 `assertTokens`（token 语义 = 必须是字符串），于是**每一次**
// 消息写入都被自己拦下。会话改名/删除/归档同理。
//
// 这里直接调真实 handler（stub electron + 假 store），传**数字** id，守住这条路径。
import { createRequire } from 'node:module';
import path from 'node:path';
import { installElectronStub } from './helpers/electronStub.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const handlers = new Map();

// stub electron：只提供 ipcMain.handle（键由 require.resolve 现算，见 helpers/electronStub.mjs）
installElectronStub({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, app: { getPath: () => '/tmp' } });

const { initLocalDataIpc } = require(path.join(ROOT, 'main/ipc/localData.js'));

// 假 store：记录调用、模拟 nextId 的数字 id 语义
const calls = [];
const store = {
  addMessage: (p) => { calls.push(['addMessage', p]); return { id: 99, threadId: Number(p.threadId), role: p.role, content: p.content }; },
  listMessages: (tid) => { calls.push(['listMessages', tid]); return []; },
  replaceMessages: (tid, msgs) => { calls.push(['replaceMessages', tid, msgs]); return { ok: true }; },
  setThreadStatus: (id, st) => { calls.push(['setThreadStatus', id, st]); return { ok: true }; },
  renameThread: (id, t) => { calls.push(['renameThread', id, t]); return { ok: true }; },
  deleteThread: (id) => { calls.push(['deleteThread', id]); return { ok: true }; },
  archiveThread: (id) => { calls.push(['archiveThread', id]); return { ok: true }; },
  restoreThread: (id) => { calls.push(['restoreThread', id]); return { ok: true }; },
  purgeThread: (id) => { calls.push(['purgeThread', id]); return { ok: true }; },
  setThreadProject: (id, p) => { calls.push(['setThreadProject', id, p]); return { ok: true }; },
  updateThreadCwd: (id, cwd) => { calls.push(['updateThreadCwd', id, cwd]); return { ok: true }; },
  getPreference: () => undefined,
  setPreference: () => ({ ok: true }),
};

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.error(`[FAIL] ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假'); };

// 2026-11-03（用户反馈 3）：删除会话必须先停掉该会话名下的在跑任务。
// 这里注入一个记录型实现，让「先停后删」的顺序本身可被断言（顺序错了就等于没停）。
initLocalDataIpc({
  getLocalStore: () => store, getCredentialCrypto: () => null, localVault: new Map(),
  getMemoryManager: () => null, getMemoryScheduler: () => null, serverBase: () => '', MJ: {},
  abortRunsForThread: (tid) => { calls.push(['abortRunsForThread', tid]); return 1; },
});

const call = (ch, payload) => {
  const fn = handlers.get(ch);
  if (!fn) throw new Error(`通道未注册：${ch}`);
  return fn({}, payload);
};
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ── 用户实际踩的那条 ──
await check('local:messages/add 接受数字 threadId（nextId 就是数字）', async () => {
  const r = await call('local:messages/add', { threadId: 7, role: 'user', content: 'hi' });
  ok(r && r.threadId === 7, `返回值不对：${JSON.stringify(r)}`);
});

await check('local:messages/add 也接受纯数字字符串（兼容渲染层传 string 的路径）', async () => {
  const r = await call('local:messages/add', { threadId: '7', role: 'assistant', content: 'ok' });
  ok(r && r.threadId === 7, `返回值不对：${JSON.stringify(r)}`);
});

await check('local:messages/add 拒绝对象型 threadId（防 [object Object] 落库）', async () => {
  const e = await rejects(call('local:messages/add', { threadId: { a: 1 }, role: 'user', content: 'x' }));
  ok(e && /threadId/.test(e.message), '应当拒绝并点名字段');
});

await check('local:messages/add 拒绝空串 threadId（Number("") 是 0，会被当成 id 0）', async () => {
  const e = await rejects(call('local:messages/add', { threadId: '', role: 'user', content: 'x' }));
  ok(e && /threadId/.test(e.message), '空串必须被拒');
});

await check('role 仍是闭集（放宽 id 不等于放宽角色）', async () => {
  const e = await rejects(call('local:messages/add', { threadId: 7, role: 'root', content: 'x' }));
  ok(e && /role/.test(e.message), '非法 role 应被拒');
});

// ── 同批改动的其余 id 通道 ──
await check('local:threads/set-status 接受数字 id', async () => {
  await call('local:threads/set-status', { id: 7, status: 'running' });
  ok(calls.some((c) => c[0] === 'setThreadStatus' && c[1] === 7), '未落到 store');
});

await check('local:threads/rename 接受数字 threadId', async () => {
  await call('local:threads/rename', { threadId: 7, title: '新名字' });
  ok(calls.some((c) => c[0] === 'renameThread' && c[1] === 7), '未落到 store');
});

await check('local:threads/delete 接受数字 threadId', async () => {
  await call('local:threads/delete', { threadId: 8 });
  ok(calls.some((c) => c[0] === 'archiveThread' && c[1] === 8), '未落到 store');
});

// ── 删除即停止（2026-11-03，用户反馈 3）──
await check('local:threads/delete 先中止该会话的在跑任务，再归档（顺序错了等于没停）', async () => {
  calls.length = 0;
  const r = await call('local:threads/delete', { threadId: 8 });
  const abortAt = calls.findIndex((c) => c[0] === 'abortRunsForThread' && c[1] === 8);
  const archAt = calls.findIndex((c) => c[0] === 'archiveThread' && c[1] === 8);
  ok(abortAt >= 0, '未调用 abortRunsForThread（删掉后任务还会继续跑）');
  ok(archAt >= 0, '未归档会话');
  ok(abortAt < archAt, `顺序错误：abort@${abortAt} 必须在 archive@${archAt} 之前`);
  ok(r && r.abortedRuns === 1, `返回值未回报中止数：${JSON.stringify(r)}`);
  ok(r && r.ok === true, '删除结果被中止逻辑吃掉（ok 字段丢失）');
});

await check('local:threads/delete 在中止实现缺失时仍能删除（降级不阻断用户意图）', async () => {
  // 真正的缺失场景：重新装配 deps（同名通道会被 Map 覆盖，不影响后续用例），不带 abortRunsForThread。
  // 「停不下来」不该把用户点删除的意图一起废掉，但必须回报 0 —— 不是假装停过了。
  initLocalDataIpc({
    getLocalStore: () => store, getCredentialCrypto: () => null, localVault: new Map(),
    getMemoryManager: () => null, getMemoryScheduler: () => null, serverBase: () => '', MJ: {},
  });
  calls.length = 0;
  const r = await call('local:threads/delete', { threadId: 8 });
  ok(r && r.ok === true, '中止实现缺失时删除失败（应当降级放行）');
  ok(r.abortedRuns === 0, `中止实现缺失时应回报 0，实际 ${r.abortedRuns}`);
  ok(calls.some((c) => c[0] === 'archiveThread' && c[1] === 8), '未归档会话');
});

await check('local:threads/restore 与 purge 接受数字 threadId', async () => {
  await call('local:threads/restore', { threadId: 9 });
  await call('local:threads/purge', { threadId: 10 });
  ok(calls.some((c) => c[0] === 'restoreThread' && c[1] === 9), 'restore 未落 store');
  ok(calls.some((c) => c[0] === 'purgeThread' && c[1] === 10), 'purge 未落 store');
});

await check('local:messages/list 接受数字 threadId', async () => {
  const r = await call('local:messages/list', { threadId: 7 });
  ok(Array.isArray(r), '应返回数组');
});

await check('local:messages/replace 接受数字 threadId', async () => {
  await call('local:messages/replace', { threadId: 7, messages: [] });
  ok(calls.some((c) => c[0] === 'replaceMessages'), '未落到 store');
});

// 2026-11-01：副本被清理后把会话执行根指回项目目录（新增通道，同样要接受数字 threadId）
await check('local:threads/set-cwd 接受数字 threadId 并落 store', async () => {
  const r = await call('local:threads/set-cwd', { threadId: 11, cwd: '/tmp/proj' });
  ok(r && r.ok, '应返回 ok');
  ok(calls.some((c) => c[0] === 'updateThreadCwd' && c[1] === 11 && c[2] === '/tmp/proj'), '未落到 store');
});

await check('local:threads/set-cwd 拒绝空 cwd（写空等于把指针清掉）', async () => {
  const e = await rejects(call('local:threads/set-cwd', { threadId: 11, cwd: '' }));
  ok(!!e, '空 cwd 必须被边界拦下');
});

console.log(`\n结果：${pass}/${total} 通过`);
