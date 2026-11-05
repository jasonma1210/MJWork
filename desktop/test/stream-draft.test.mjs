// V8（2026-11-05）：流式草稿落库——「当时已经输出内容了，强制断开后却全丢了」的回归套件。
//
// 这组断言刻意都落在**磁盘/重开**这一侧，而不是「内存里记了些什么」：
//   事故的判据本来就是「重开后还在不在」，只在内存里断言等于把缺陷换个地方藏起来。
//   所以每条主断言都在构造**第二个 LocalStore**（以 SQLite 为读源）之后才做。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalStore } = require('../main/store/localStore.js');
const liveDb = require('../main/db/liveDb.js');
const { openDbAsync } = require('../main/db/index.js');
const { readSnapshot } = require('../main/store/localMirror.js');
const streamDraft = require('../main/store/streamDraft.js');

// 节流放到 0：测试要逐次落盘才好断言，生产默认 800ms 由 streamDraft.DEFAULTS 守着
process.env.MJ_STREAM_DRAFT_MS = '0';

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${name}`); } else {
    fail++; console.error(`[FAIL] ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}
const msgOf = (store, tid, role = 'assistant') => store.listMessages(tid).filter((m) => m.role === role);

// 假的流式实现：形状与 main.js 的 chatStreamOnce 一致（第 2 个位置参数就是 sender）
function fakeChat(deltas) {
  return async (payload, sender, signal, tag) => {
    for (const d of deltas) {
      sender.send('model:delta', { tag, text: d });
      sender.send('model:reasoning', { tag, text: '思考' });
    }
    return { content: deltas.join('') };
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-draft-'));
let db = null;
try {
  liveDb._reset();
  const seed = new LocalStore(dir);
  const thread = seed.createThread({ title: '草稿会话', cwd: '/tmp/draft' });
  seed.flushSync();
  db = await openDbAsync(path.join(dir, 'dbdata'), { driver: 'node-sqlite' });
  liveDb._reset();
  liveDb.publish(db);
  const store = new LocalStore(dir);
  const runId = 'run-draft-1';
  const ctx = (over = {}) => ({
    chatStreamOnce: fakeChat(['第一段', '第二段']),
    sender: { send() {} },
    signal: null,
    runId,
    conversationId: thread.id,
    model: { model: { model_id: 'deepseek-chat' } },
    getStore: () => store,
    ...over,
  });

  // ① quiet 小调用（AC 提取 / Judge / 路由分类）绝不落草稿：它的输出不属于对话正文
  streamDraft._reset();
  let quietTag = null;
  await streamDraft.routeChat({ quiet: true }, ctx({
    chatStreamOnce: async (p, s, sig, tag) => { quietTag = tag; return {}; },
  }));
  check('V8：quiet 小调用不建草稿（不会把 JSON/摘要串进对话）',
    streamDraft._drafts.size === 0 && msgOf(store, thread.id).length === 0,
    `drafts=${streamDraft._drafts.size} msgs=${msgOf(store, thread.id).length}`);
  // 行为断言（不是读源码）：quiet 换 tag 这件事必须真的发生在调用点上，
  // 只断「模块里有那行代码」会被「函数写好了但没人调」骗过去。
  check('V8：quiet 调用确实换成 `${runId}-quiet` 这个渲染层不认的 tag', quietTag === `${runId}-quiet`, String(quietTag));

  // ② 正文增量经 sender 外壳落成草稿行（此时还没有任何 adopt）
  streamDraft._reset();
  await streamDraft.routeChat({}, ctx());
  const draftMsgs = msgOf(store, thread.id);
  check('V8：流式正文边生成边落库（草稿行内容 = 已输出的全部正文）',
    draftMsgs.length === 1 && draftMsgs[0].content === '第一段第二段',
    JSON.stringify(draftMsgs.map((m) => m.content)));

  // ③ 主判据：强杀后重开（新 store 以 SQLite 为读源）仍然看得到已输出内容
  liveDb._reset();
  db.close();
  db = await openDbAsync(path.join(dir, 'dbdata'), { driver: 'node-sqlite' });
  liveDb.publish(db);
  const reopened = new LocalStore(dir);
  const afterKill = msgOf(reopened, thread.id);
  check('V8：强杀后重开仍能看到已输出的正文（这才是「不丢」的判据）',
    reopened.sourceOfTruth === 'sqlite' && afterKill.length === 1 && afterKill[0].content === '第一段第二段',
    `source=${reopened.sourceOfTruth} msgs=${JSON.stringify(afterKill.map((m) => m.content))}`);
  liveDb._reset();
  db.close();
  db = await openDbAsync(path.join(dir, 'dbdata'), { driver: 'node-sqlite' });
  liveDb._reset();
  liveDb.publish(db);
  const store2 = new LocalStore(dir);

  // ④ 中间轮 adopt：就地转正（补上 tool_calls），不新增第二条
  streamDraft._reset();
  const ctx2 = (over = {}) => ({ ...ctx({ getStore: () => store2 }), ...over });
  await streamDraft.routeChat({}, ctx2({ chatStreamOnce: fakeChat(['我要读文件']) }));
  const beforeAdopt = msgOf(store2, thread.id).length;
  // ⚠ 下面几处一律用 `|| {}` 兜住 null：转正失败时若直接读 `.id`，整个套件会被 TypeError 打断，
  // 后面的断言全不跑，汇总行还会打印「PASS：N/N」——崩溃把「没有结论」伪装成「结论正常」。
  const adopted = streamDraft.adopt(runId, thread.id, {
    role: 'assistant', content: '我要读文件', toolCalls: [{ id: 'c1', function: { name: 'read_file' } }],
    tokensInput: 11, tokensOutput: 7, modelName: 'deepseek-chat',
  }, store2) || {};
  const adoptedMsg = msgOf(store2, thread.id).find((m) => adopted.id != null && m.id === adopted.id);
  check('V8：中间轮 adopt 就地转正——消息条数不变，tool_calls / 用量 / 模型名都补上',
    adopted.ok === true && msgOf(store2, thread.id).length === beforeAdopt
    && !!adoptedMsg && Array.isArray(adoptedMsg.toolCalls) && adoptedMsg.toolCalls[0].id === 'c1'
    && adoptedMsg.tokensInput === 11 && adoptedMsg.modelName === 'deepseek-chat',
    `count=${msgOf(store2, thread.id).length} msg=${JSON.stringify(adoptedMsg && { tc: adoptedMsg.toolCalls, ti: adoptedMsg.tokensInput })}`);

  // ⑤ 收尾轮：权威内容与流式拼出来的不一样（V 层会改写/加注），必须以权威为准
  streamDraft._reset();
  await streamDraft.routeChat({}, ctx2({ chatStreamOnce: fakeChat(['原始结论']) }));
  const finalAdopted = streamDraft.adopt(runId, thread.id, {
    role: 'assistant', content: '原始结论（已由校验层加注：未验证）', modelName: 'deepseek-chat',
  }, store2) || {};
  const finalMsg = msgOf(store2, thread.id).find((m) => finalAdopted.id != null && m.id === finalAdopted.id);
  check('V8：收尾轮 adopt 以权威内容覆盖草稿（验证层改写不会被流式原文顶掉）',
    finalAdopted.ok === true && finalMsg.content === '原始结论（已由校验层加注：未验证）',
    finalMsg && finalMsg.content);

  // ⑥ 两轮就是两条消息：草稿机制不能把多轮挤进同一行
  liveDb._reset();
  db.close();
  db = await openDbAsync(path.join(dir, 'dbdata'), { driver: 'node-sqlite' });
  liveDb.publish(db);
  const reopened2 = new LocalStore(dir);
  check('V8：多轮各自成行（草稿复用不会把两轮并成一条）',
    msgOf(reopened2, thread.id).length === 3,
    `msgs=${msgOf(reopened2, thread.id).length}`);
  liveDb._reset();
  db.close();
  db = await openDbAsync(path.join(dir, 'dbdata'), { driver: 'node-sqlite' });
  liveDb._reset();
  liveDb.publish(db);
  const store3 = new LocalStore(dir);

  // ⑦ 纯工具轮（没吐过正文）→ adopt 返回 null，让调用方走常规新增（否则这一轮的消息会丢）
  streamDraft._reset();
  await streamDraft.routeChat({}, { ...ctx(), runId: 'run-quiet-text', getStore: () => store3, conversationId: thread.id, chatStreamOnce: async (p, s, sig, tag) => { s.send('model:delta', { tag, text: '' }); return {}; } });
  const noTextAdopt = streamDraft.adopt('run-quiet-text', thread.id, { role: 'assistant', content: '纯工具轮' }, store3);
  check('V8：本轮没有正文时 adopt 交出控制权（返回 null，由调用方新增）',
    noTextAdopt === null, String(noTextAdopt));

  // ⑧ 节流：间隔未到时只在内存里增长，不落盘
  process.env.MJ_STREAM_DRAFT_MS = '60000';
  streamDraft._reset();
  const before = msgOf(store3, thread.id).length;
  await streamDraft.routeChat({}, { ...ctx(), runId: 'run-throttle', getStore: () => store3, chatStreamOnce: fakeChat(['甲', '乙', '丙']) });
  const throttled = msgOf(store3, thread.id).length;
  check('V8：节流生效——首帧建行，后续增量在间隔内只留在内存',
    throttled === before + 1 && msgOf(store3, thread.id).slice(-1)[0].content === '甲',
    `msgs=${throttled} last=${(msgOf(store3, thread.id).slice(-1)[0] || {}).content}`);
  process.env.MJ_STREAM_DRAFT_MS = '0';
  streamDraft.adopt('run-throttle', thread.id, { role: 'assistant', content: '甲乙丙' }, store3);

  // ⑨ 草稿行被替换（/compact 用摘要历史整体替换，旧 id 整批消失）后不能继续往不存在的行写。
  // 走 replaceMessages 而不是直接改 data.messages：后者会绕过会话索引，测到的是我自己的 hack。
  streamDraft._reset();
  await streamDraft.routeChat({}, { ...ctx(), runId: 'run-gone', getStore: () => store3, chatStreamOnce: fakeChat(['会被替换掉']) });
  const goneId = msgOf(store3, thread.id).slice(-1)[0].id;
  store3.replaceMessages(thread.id, [{ role: 'user', content: '压缩后的摘要' }]);
  streamDraft.record('run-gone', '再写一句'); // 更新失败 → 摘掉引用（本次不建行）
  streamDraft.record('run-gone', '再写一句'); // 下一次刷盘重建一行
  const rebuiltMsgs = msgOf(store3, thread.id);
  const rebuiltLast = rebuiltMsgs.slice(-1)[0] || {};
  check('V8：草稿行被替换后重建，不再往不存在的行写（不静默成功）',
    rebuiltMsgs.every((m) => m.id !== goneId)
    && String(rebuiltLast.content || '').includes('再写一句') && String(rebuiltLast.content || '').includes('会被替换掉'),
    `last=${rebuiltLast.content}`);
  streamDraft.adopt('run-gone', thread.id, { role: 'assistant', content: '重建后的正文' }, store3);

  // ⑩ 库未就绪（启动早期）不得抛错：草稿是尽力而为，不能让它影响本轮运行
  streamDraft._reset();
  let threw = null;
  try {
    await streamDraft.routeChat({}, { ...ctx(), runId: 'run-nostore', getStore: () => null, chatStreamOnce: fakeChat(['无库']) });
    streamDraft.adopt('run-nostore', thread.id, { role: 'assistant', content: '无库' }, store3);
  } catch (e) { threw = e; }
  check('V8：库未就绪 / 无 store 时不抛错（草稿失败不得影响运行）', threw === null, threw && threw.message);

  // ⑪ 未知 tag 一律不管：渲染层不认识的标签（子代理 / 旁路通道）不该进对话正文
  streamDraft._reset();
  const beforeUnknown = store3.listMessages(thread.id).length;
  streamDraft.record('some-other-tag', '不该落库');
  check('V8：未登记的 tag 不落库（旁路通道不污染对话）',
    streamDraft._drafts.size === 0 && store3.listMessages(thread.id).length === beforeUnknown);

  // ⑫ 外壳只拦 model:delta，其余事件原样透传（reasoning 也必须到渲染层）
  streamDraft._reset();
  const seen = [];
  await streamDraft.routeChat({}, {
    ...ctx(), runId: 'run-tap', getStore: () => store3,
    sender: { send: (ch, p) => seen.push(`${ch}:${p && p.text}`) },
  });
  check('V8：sender 外壳只旁路记录 model:delta，其余通道照常透传',
    seen.filter((s) => s.startsWith('model:reasoning')).length === 2
    && seen.filter((s) => s.startsWith('model:delta')).length === 2,
    seen.join('|'));
  streamDraft.adopt('run-tap', thread.id, { role: 'assistant', content: '第一段第二段' }, store3);

  // ⑬ 非 assistant 消息不参与转正（tool 结果必须独立成行，不能覆盖草稿）
  streamDraft._reset();
  await streamDraft.routeChat({}, { ...ctx(), runId: 'run-tool', getStore: () => store3, chatStreamOnce: fakeChat(['先说话']) });
  const toolAdopt = streamDraft.adopt('run-tool', thread.id, { role: 'tool', content: '工具结果', toolCallId: 'c9' }, store3);
  check('V8：tool 消息不转正草稿（工具结果必须独立成行）', toolAdopt === null, String(toolAdopt));

  // ⑭ 草稿刷盘**只能写库**，不能连带重写 3.5MB 的 JSON 回滚快照。
  //    这条是 GUI 验证里抓出来的：`flushSync()` 默认 `hot=false`，流式期间每 800ms 一次全量
  //    快照（实测 local-data.json 的 mtime 每轮都在变）——等于把 ST1「JSON 退出写热路径」的
  //    收口原地还回去。断言落在「SQLite 有正文、JSON 快照里没有」这一对事实上：
  //    只要有人把 `flushSync({ hot: true })` 改回 `flushSync()`，JSON 立刻会被重写，本条变红。
  streamDraft._reset();
  const jsonFile = store3.file;
  const jsonBefore = fs.existsSync(jsonFile) ? fs.readFileSync(jsonFile, 'utf8') : '';
  const atBefore = store3._lastJsonAt;
  await streamDraft.routeChat({}, { ...ctx(), runId: 'run-hot', getStore: () => store3, chatStreamOnce: fakeChat(['热路径甲', '热路径乙']) });
  const jsonAfter = fs.existsSync(jsonFile) ? fs.readFileSync(jsonFile, 'utf8') : '';
  const inDb = JSON.stringify(readSnapshot(db) || {}).includes('热路径甲');
  check('V8：草稿刷盘不重写 JSON 快照（正文进 SQLite，回滚快照不动）',
    inDb && !/热路径甲/.test(jsonBefore) && !/热路径甲/.test(jsonAfter)
    && store3._lastJsonAt === atBefore,
    `inDb=${inDb} jsonBefore=${/热路径甲/.test(jsonBefore)} jsonAfter=${/热路径甲/.test(jsonAfter)} lastJsonAt ${atBefore}->${store3._lastJsonAt}`);
  streamDraft.adopt('run-hot', thread.id, { role: 'assistant', content: '热路径甲热路径乙' }, store3);

  fs.rmSync(dir, { recursive: true, force: true });
} catch (e) {
  console.error('[FAIL] 套件异常：', e && e.stack ? e.stack : e);
  process.exitCode = 1;
} finally {
  try { liveDb._reset(); } catch (e) { console.warn('[stream-draft] liveDb 复位失败:', e.message); }
  try { if (db) db.close(); } catch (e) { console.warn('[stream-draft] 关闭测试库失败:', e.message); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn('[stream-draft] 清理临时目录失败:', e.message); }
}
// 汇总行必须把 exitCode 也算进去：套件中途抛错时 fail 计数是 0，
// 只按 fail 判会打印「PASS：3/3」——那句话会让人以为门禁绿了。
console.log(`\n${fail === 0 && !process.exitCode ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
