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

// 2026-11-05（AC-2.8 + MD2）：model:testConnection 需要一个可查的凭证表，覆盖三种形态。
// 1 = 本机空 Key（MD2 后**免 Key 放行**：这是「离线级」的默认形态）
// 2 = 有 Key 的远端端点
// 3 = **远端 + 空 Key**（必须仍 KEY_MISSING；没有这一条，上面的放行就变成了「谁都不用 Key」）
//
// **必须抽成常量共用**：本套件为了模拟「中止实现缺失」会**再装配一次 deps**（见下方 delete 用例），
// 那次也会传 localVault —— 若各写一个 new Map()，第二次装配会把表换回空的，
// 于是 testConnection 拿不到任何 provider，断言会在「有 Key」正样本上莫名其妙地红。
// （我第一次就是这么写的：`vaultSize=0` 打了两行才定位到。）
const LOCAL_VAULT = new Map([
  [1, { api_key: '', base_url: 'http://127.0.0.1:11434' }],
  [2, { api_key: 'sk-real-key', base_url: 'https://api.example.com' }],
  [3, { api_key: '', base_url: 'https://api.example.com' }],
]);

// 2026-11-03（用户反馈 3）：删除会话必须先停掉该会话名下的在跑任务。
// 这里注入一个记录型实现，让「先停后删」的顺序本身可被断言（顺序错了就等于没停）。
initLocalDataIpc({
  getLocalStore: () => store, getCredentialCrypto: () => null,
  localVault: LOCAL_VAULT,
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
    getLocalStore: () => store, getCredentialCrypto: () => null, localVault: LOCAL_VAULT,
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

// ── 2026-11-05（AC-2.8）：model:testConnection 不得假绿 ────────────────────────
//
// 缺陷形态：handler 只在**有 Key** 时才发 `Authorization`，没 Key 就裸调 `${url}/models`。
// 而 /models 普遍不校验凭证（Ollama 完全不校验）⇒ 探测 `ok:true`；但用户一发消息就
// `KEY_MISSING`，因为三个发消息入口全部无条件校验
// （`main.js:660-662` / `scheduledChannels.js:46-48` / `:86-88`，主对话 + 定时 + Worker）。
//
// 这是最伤人的一种假绿：用户被告知「重新填写 API Key」，而纯本机 Ollama 根本没有 Key 可填，
// 于是他会反复怀疑网络、代理、接口地址——所有方向都错。
//
// 断言要点：
//   ① 反样本必须**真的模拟出「/models 放行」**（fetch 返回 200），否则「假绿存在」只是口说；
//   ② 修后必须 ok:false + errorCode:'KEY_MISSING'，且**不得发出任何网络请求**（不上床碰运气）；
//   ③ 正样本：有 Key ⇒ 仍正常探测（证明不是把测试连接整个关死）；
//   ④ 契约：id 缺省时保留「只测地址」语义（调试用途，不是假绿）。
{
  const realFetch = globalThis.fetch;
  let fetchCalls = [];
  const stubFetch = (status) => async (u, opt) => {
    fetchCalls.push({ url: String(u), auth: (opt && opt.headers && opt.headers.Authorization) || null });
    return { ok: status >= 200 && status < 300, status };
  };
  // 每个用例独立复位 fetch：避免上一例的 stub 泄漏到下一例（否则「没发请求」这类断言会被污染）
  const reset = (status) => { globalThis.fetch = stubFetch(status); fetchCalls = []; };

  try {
    // ── ① MD2：本机回环端点空 Key **必须放行**，且不伪造 Authorization ──
    await check('model:testConnection 本机回环端点空 Key 放行（MD2：离线级默认形态）', async () => {
      reset(200);
      const r = await call('model:testConnection', { id: 1, base_url: 'http://127.0.0.1:11434' });
      ok(r && r.ok === true, `本机端点空 Key 应放行（实际 ${JSON.stringify(r)}）`);
      ok(!('keyRequired' in r), '放行时不应出现缺凭证标记');
      ok(fetchCalls.length === 1, `应真的探测一次 /models（实际 ${fetchCalls.length} 次）`);
      ok(fetchCalls[0].auth === null, '空 Key 时不得发 Authorization（本机 Ollama 收到 Bearer 反而可能拒）');
    });

    // ── ② 反样本：远端 + 空 Key 仍必须 KEY_MISSING（放行不能变成"谁都不用 Key"）──
    await check('model:testConnection 远端端点空 Key 仍报 KEY_MISSING（放行边界只在回环地址）', async () => {
      reset(200);
      const r = await call('model:testConnection', { id: 3, base_url: 'https://api.example.com' });
      ok(r && r.ok === false, `远端空 Key 不得报绿（实际 ok=${r && r.ok}）`);
      ok(r.errorCode === 'KEY_MISSING', `错误码须与发消息一致（实际 ${r.errorCode}）`);
      ok(/KEY_MISSING/.test(String(r.error)) && /无需 Key/.test(String(r.error)),
        '错误文案须说明「本机端点无需 Key」，否则用户不知道还能怎么配');
      ok(fetchCalls.length === 0, `远端空 Key 时不得发请求（实际 ${fetchCalls.length} 次）`);
      ok(r.keyRequired === true, '缺凭证须显式标记');
    });

    // ── ③ 局域网/内网**不算**本机（放宽只在回环地址，不是"内网就免 Key"）──
    await check('model:testConnection 内网地址空 Key 不放行（192.168.x 不是回环）', async () => {
      reset(200);
      const r = await call('model:testConnection', { id: 3, base_url: 'http://192.168.1.50:11434' });
      ok(r && r.ok === false && r.errorCode === 'KEY_MISSING',
        `内网地址无 Key 应拒绝（实际 ${JSON.stringify(r)}）；否则等于把无认证端点当可信来源`);
      ok(fetchCalls.length === 0, '内网空 Key 时不得发请求');
    });

    // ── ④ 正样本：有 Key ⇒ 仍真探测（加严不能把测试连接整个关死）──
    await check('model:testConnection 有 Key 时仍真探测 /models 并带 Authorization', async () => {
      reset(200);
      const r = await call('model:testConnection', { id: 2, base_url: 'https://api.example.com' });
      ok(r && r.ok === true, `有 Key + 端点通应 ok:true（实际 ${JSON.stringify(r)}）`);
      ok(fetchCalls.length === 1 && /\/models$/.test(fetchCalls[0].url), '应探测 /models');
      ok(fetchCalls[0].auth === 'Bearer sk-real-key', '有 Key 时必须带 Authorization（否则远端 401）');
      ok(!('keyRequired' in r), '有 Key 时不应出现缺凭证标记');
    });

    // ── ⑤ 有 Key 但端点不通 ⇒ 如实报（失败不能被新判据吞掉）──
    await check('model:testConnection 有 Key 但 HTTP 500 时如实报错', async () => {
      reset(500);
      const r = await call('model:testConnection', { id: 2, base_url: 'https://api.example.com' });
      ok(r && r.ok === false && /HTTP 500/.test(String(r.error)), `HTTP 500 应如实报（实际 ${r && r.error}）`);
    });

    // ── ⑥ id 缺省：保留「只测地址连通性」的调试语义 ──
    await check('model:testConnection id 缺省时只测地址，不判 Key（调试用途，不声称能发消息）', async () => {
      reset(200);
      const r = await call('model:testConnection', { base_url: 'http://127.0.0.1:11434' });
      ok(r && r.ok === true, 'id 缺省时只测地址，应仍可通');
      ok(!('keyRequired' in r), '只测地址不应声称 Key 相关结论');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n结果：${pass}/${total} 通过`);
