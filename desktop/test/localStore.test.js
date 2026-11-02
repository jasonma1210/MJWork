// 本地数据层测试：线程/消息 CRUD / 原子持久化 / 凭证隔离 / 记忆上限
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LocalStore } = require('../main/store/localStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-'));
const store = new LocalStore(dir);

// ── 线程与消息 ──
const t = store.createThread({ title: '新对话', cwd: '/tmp/p', providerName: 'DS', modelName: 'deepseek-chat' });
check('创建线程', !!t.id && t.cwd === '/tmp/p');
const m1 = store.addMessage({ threadId: t.id, role: 'user', content: '帮我看看仓库', tokensInput: 10, tokensOutput: 0 });
check('用户消息入库并自动设标题', store.listThreads()[0].title.startsWith('帮我看看仓库'));
store.addMessage({ threadId: t.id, role: 'assistant', content: '这是一个 git 仓库', tokensOutput: 8 });
const msgs = store.listMessages(t.id);
check('消息按序返回', msgs.length === 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant');

// ── 原子持久化：新实例从磁盘恢复 ──
store.flushSync(); // P0-1：消息走合并刷盘，读盘断言前强制落盘
const store2 = new LocalStore(dir);
check('磁盘恢复：线程与消息完整', store2.listThreads().length === 1 && store2.listMessages(t.id).length === 2);

// ── 凭证隔离 ──
store.addProvider({ name: 'DS', base_url: 'https://api.deepseek.com/v1', keyEncrypted: 'ENC(base64)', modelId: 'deepseek-chat' });
const plist = store.listProviders();
check('listProviders 不泄露 keyEncrypted', !JSON.stringify(plist).includes('ENC(base64)'));
check('getProviderKey 仅供调用方解密', store.getProviderKey(plist[0].id) === 'ENC(base64)');
store.setProviderModel(plist[0].id, 'deepseek-reasoner');
check('setProviderModel 更新模型', store.listProviders()[0].modelId === 'deepseek-reasoner');

// ── 归档 ──
store.archiveThread(t.id);
check('归档后列表不可见', store.listThreads().length === 0);

// ── RQ-03（2026-11-03）：归档不得「假成功」──
// 旧实现既不看 corrupt-blocked、也不看 flush 返回值，恒返回 ok:true：用户看到「已删除」，
// 重启后会话又回来了。三条断言分别钉住「不存在的会话」「幂等」「阻断态」。
check('归档不存在的会话返回 ok:false', store.archiveThread(999999).ok === false);
const tArch = store.createThread({ title: '归档幂等', cwd: '/tmp/q' });
check('首次归档成功', store.archiveThread(tArch.id).ok === true);
check('重复归档幂等（unchanged=true）', (() => { const r = store.archiveThread(tArch.id); return r.ok === true && r.unchanged === true; })());
const dirCorruptA = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-cur-'));
fs.writeFileSync(path.join(dirCorruptA, 'local-data.json'), '{broken archive');
const sCorruptA = new LocalStore(dirCorruptA);
check('损坏且无备份 → 进入阻断态', sCorruptA.corruptBlocked === true);
let archiveThrew = false;
try { sCorruptA.archiveThread(1); } catch { archiveThrew = true; }
check('阻断态归档必须抛错（fail-closed，不得返回 ok:true）', archiveThrew === true);

// ── RQ-02（2026-11-03）：彻底删除返回可核对的计数 ──
const tPurge = store.createThread({ title: '待彻底删除', cwd: '/tmp/purge' });
store.addMessage({ threadId: tPurge.id, role: 'user', content: 'a' });
store.addMessage({ threadId: tPurge.id, role: 'assistant', content: 'b' });
const purgeRes = store.purgeThread(tPurge.id);
check('彻底删除返回删除计数', purgeRes.ok === true && purgeRes.deleted.threads === 1 && purgeRes.deleted.messages === 2,
  JSON.stringify(purgeRes.deleted));
check('彻底删除后消息不复存在', store.listMessages(tPurge.id).length === 0);
check('彻底删除回报原执行根（供调用方判断是否留下隔离副本）', purgeRes.cwd === '/tmp/purge');

// ── P0-2a：记忆自动沉淀设置语义（缺省 false = 默认关闭）──
// 旧 JSON 记忆 API（addMemory/listMemories/touchMemories）已随 P3-4/P1-16 删除——
// 记忆唯一事实来源是 SQLite（MemoryManager，行为测试见 test/memory.test.js）；
// 历史文件中的 memories 字段仅保留供主进程一次性导入，导入后即清空。
check('memory.autoCapture 缺省未设置（默认关闭，渲染层按 falsy 处理）',
  store.getPreference('memory.autoCapture') === undefined);
store.setPreference('memory.autoCapture', true);
check('memory.autoCapture 可显式开启且同步落盘',
  store.getPreference('memory.autoCapture') === true
  && new LocalStore(dir).getPreference('memory.autoCapture') === true);
store.setPreference('memory.autoCapture', false);
check('memory.autoCapture 可显式关闭', store.getPreference('memory.autoCapture') === false);

// ── P1-M：损坏韧性——先 .bak 恢复，无 .bak 才重置（此前一损坏就静默空库）──
// 此时共享 dir 的 .bak 已由历次 flush 生成（含 provider）
fs.writeFileSync(path.join(dir, 'local-data.json'), '{broken json');
const store3 = new LocalStore(dir);
check('损坏文件从 .bak 恢复（不静默重置）', store3.recoveredFromBackup === true && Array.isArray(store3.listThreads()));
check('恢复后凭证未丢', store3.listProviders().length === 1);

// 无 .bak 的损坏文件 → 重置空库且不崩溃
const dirNoBak = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-nobak-'));
fs.writeFileSync(path.join(dirNoBak, 'local-data.json'), '{also broken');
const storeNoBak = new LocalStore(dirNoBak);
check('无 .bak 的损坏文件回落空库不崩溃', storeNoBak.listThreads().length === 0 && storeNoBak.recoveredFromBackup === false);

// flush 留 .bak（上一完好版本）+ 按日副本
const dirBak = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-bak-'));
const s5 = new LocalStore(dirBak);
s5.createThread({ title: 'a', cwd: '/tmp/x' });
const fileAfterFirst = fs.readFileSync(path.join(dirBak, 'local-data.json'), 'utf8');
s5.createThread({ title: 'b', cwd: '/tmp/x' });
check('flush 前留 .bak（上一完好版本）',
  fs.existsSync(path.join(dirBak, 'local-data.json.bak'))
  && fs.readFileSync(path.join(dirBak, 'local-data.json.bak'), 'utf8') === fileAfterFirst);
check('按日副本已生成', fs.existsSync(path.join(dirBak, `local-data.${new Date().toISOString().slice(0, 10)}.json`)));

// 恢复后的首次 flush 不得用好 .bak 去覆盖……方向反了：不得让坏主文件污染好 .bak
fs.writeFileSync(path.join(dirBak, 'local-data.json'), '{broken');
const s6 = new LocalStore(dirBak);
s6.createThread({ title: 'c', cwd: '/tmp/x' });
check('恢复后 flush 不被坏文件污染 .bak',
  JSON.parse(fs.readFileSync(path.join(dirBak, 'local-data.json.bak'), 'utf8')).threads.length === 1);

// schemaVersion 与旧版迁移
check('schemaVersion 已写入', s6.data.schemaVersion === 1);
const dirMig = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-mig-'));
fs.writeFileSync(path.join(dirMig, 'local-data.json'), JSON.stringify({ threads: [], providers: [{ id: 9, name: 'old', modelId: 'm1' }], seq: 10 }));
const s7 = new LocalStore(dirMig);
check('旧版无版本文件迁移出 models 并 Stamp 版本',
  Array.isArray(s7.listProviders()[0].models) && s7.listProviders()[0].models[0].modelId === 'm1' && s7.data.schemaVersion === 1);

// 超过 7 天的按日副本被清理
fs.writeFileSync(path.join(dirMig, 'local-data.2020-01-01.json'), '{}');
s7.createThread({ title: 'trigger', cwd: '/tmp/x' });
check('超过 7 天的按日副本被清理', !fs.existsSync(path.join(dirMig, 'local-data.2020-01-01.json')));

// ── /compact 落库：replaceMessages 整体替换（P2-6 收口）──
const tc = store.createThread({ title: '压缩测试', cwd: '/tmp/c' });
store.addMessage({ threadId: tc.id, role: 'user', content: '第一个问题' });
store.addMessage({ threadId: tc.id, role: 'assistant', content: '第一个回答' });
store.addMessage({ threadId: tc.id, role: 'user', content: '第二个问题' });
store.addMessage({ threadId: tc.id, role: 'assistant', content: '第二个回答' });
store.flushSync(); // P0-1：合并窗口内的消息落盘后再做后续读盘断言
const rRepl = store.replaceMessages(tc.id, [
  { role: 'assistant', content: '【摘要】此前讨论了两个问题与结论。' },
  { role: 'user', content: '继续第三个问题' },
]);
const afterRepl = store.listMessages(tc.id);
check('replaceMessages 替换成功', rRepl.ok === true);
check('替换后消息数与内容正确',
  afterRepl.length === 2 && afterRepl[0].content.includes('摘要') && afterRepl[1].role === 'user');
const storeR = new LocalStore(dir);
check('替换结果落盘（重进会话不回退）', storeR.listMessages(tc.id).length === 2);
check('拒绝空列表（不得清空历史）', store.replaceMessages(tc.id, []).ok === false && store.listMessages(tc.id).length === 2);
check('线程不存在时报错', store.replaceMessages(999999, [{ role: 'user', content: 'x' }]).ok === false);
// 其余会话消息不受影响（t.id 有 2 条早期消息）
check('replaceMessages 不误伤其它会话', store.listMessages(t.id).length === 2);

// 2026-10-29：压缩是「换一种表示」，不是「重写历史」。以下三类字段此前被硬置空/改写，
// 直接导致工作台三张表当天全空（两次 /compact 抹掉 11,878,938 tokens），必须锁住。
const tc2 = store.createThread({ title: '记账保留', cwd: '/tmp/c2' });
store.replaceMessages(tc2.id, [
  // 第一条用蛇形入参：渲染层流式新建的消息就是这个形状，只认驼峰会静默读 0
  { role: 'assistant', content: '摘要', tokens_input: 900, tokens_output: 90, model_name: 'flint', created_at: 1700000000000 },
  { role: 'assistant', content: '尾部', toolCalls: [{ id: 'c1' }], tokensInput: 100, tokensOutput: 10, modelName: 'flint', createdAt: 1700000001000 },
]);
const k1 = store.listMessages(tc2.id);
check('replaceMessages 保留记账字段（蛇形入参也认）',
  k1[0].tokensInput === 900 && k1[0].tokensOutput === 90 && k1[0].modelName === 'flint',
  `got ${k1[0].tokensInput}/${k1[0].tokensOutput}/${JSON.stringify(k1[0].modelName)}`);
check('replaceMessages 保留驼峰记账字段',
  k1[1].tokensInput === 100 && k1[1].tokensOutput === 10 && k1[1].modelName === 'flint');
check('replaceMessages 保留原始 createdAt（不改写成压缩时刻）',
  k1[0].createdAt === 1700000000000 && k1[1].createdAt === 1700000001000,
  `got ${k1[0].createdAt}/${k1[1].createdAt}`);
check('replaceMessages 保留 toolCalls（重进会话仍可重放工具链）',
  Array.isArray(k1[1].toolCalls) && k1[1].toolCalls[0].id === 'c1');

// ── P1-6：会话分支（fork）——从某条历史消息点复制出独立新会话 ──
const dirFork = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-fork-'));
const sF = new LocalStore(dirFork);
const src = sF.createThread({ title: '源会话', cwd: '/tmp/f', projectPath: '/tmp/f', providerName: 'DS', modelName: 'deepseek-chat' });
const f1 = sF.addMessage({ threadId: src.id, role: 'user', content: '一' });
const f2 = sF.addMessage({ threadId: src.id, role: 'assistant', content: '二' });
sF.addMessage({ threadId: src.id, role: 'user', content: '三' });
sF.addMessage({ threadId: src.id, role: 'assistant', content: '四' });
sF.flushSync();
const rf = sF.forkThread(src.id, { fromMessageId: f2.id });
check('fork 成功', rf.ok === true && rf.copied === 2);
const forked = rf.thread;
check('fork 继承元数据（cwd/项目/模型）',
  forked.cwd === '/tmp/f' && forked.projectPath === '/tmp/f'
  && forked.providerName === 'DS' && forked.modelName === 'deepseek-chat' && forked.status === 'idle');
check('fork 记录来源（parentThreadId / forkFromMessageId）',
  forked.parentThreadId === src.id && forked.forkFromMessageId === f2.id);
const fm = sF.listMessages(forked.id);
check('fork 复制截至分支点的历史（含该条）',
  fm.length === 2 && fm[0].content === '一' && fm[1].content === '二' && fm[0].threadId === forked.id);
check('fork 消息 id 独立（不与源会话共享）', fm.every((m) => m.id !== f1.id && m.id !== f2.id));
// 独立性：往分支里追加不影响源会话
sF.addMessage({ threadId: forked.id, role: 'user', content: '分支新增' });
check('分支与源会话互不污染',
  sF.listMessages(src.id).length === 4 && sF.listMessages(forked.id).length === 3);
// 落在首条消息上也能分支
const rf1 = sF.forkThread(src.id, { fromMessageId: f1.id });
check('分支点为首条消息时复制 1 条', rf1.ok === true && rf1.copied === 1 && sF.listMessages(rf1.thread.id)[0].content === '一');
// 持久化：重开实例可见分支会话与历史
sF.flushSync();
const sF2 = new LocalStore(dirFork);
check('分支会话落盘可恢复',
  sF2.listThreads().some((x) => x.id === forked.id) && sF2.listMessages(forked.id).length === 3);
// 边界：非法/缺失分支点一律拒绝
check('源会话不存在时拒绝', sF.forkThread(999999, { fromMessageId: f1.id }).ok === false);
check('分支点缺失时拒绝', sF.forkThread(src.id, {}).ok === false);
check('分支点为非数字时拒绝', sF.forkThread(src.id, { fromMessageId: 'abc' }).ok === false);

// ── P0-1：消息热路径合并刷盘（主进程不再被每条消息一次的整库同步写阻塞）──
const dirHot = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-hot-'));
const sHot = new LocalStore(dirHot);
const tHot = sHot.createThread({ title: '热路径', cwd: '/tmp/hot' }); // 同步 flush
let diskWrites = 0;
const origWriteFile = fs.writeFileSync;
fs.writeFileSync = function (...args) {
  if (String(args[0]).includes('local-data')) diskWrites++;
  return origWriteFile.apply(fs, args);
};
for (let i = 0; i < 20; i++) {
  sHot.addMessage({ threadId: tHot.id, role: 'user', content: `消息 ${i}` }); // 合并窗口内不落盘
}
const writesBeforeFlush = diskWrites;
sHot.flushSync();
fs.writeFileSync = origWriteFile;
check('20 条消息合并为少量写盘（≤2 次磁盘写）', writesBeforeFlush <= 2,
  `合并窗口内写盘 ${writesBeforeFlush} 次`);
check('合并刷盘后 20 条消息完整落盘', new LocalStore(dirHot).listMessages(tHot.id).length === 20);
check('flushSync 幂等（无脏数据不再写盘）', (() => { const r = sHot.flushSync(); return r && r.ok === true && r.nothingPending === true; })()); // V08：返回值从布尔升级为 {ok,nothingPending}

// ── R2-1（2026-11-03）：按会话索引 / 分页 / 全库统计 ──
const dirIdx = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-idx-'));
const sIdx = new LocalStore(dirIdx);
const tA = sIdx.createThread({ title: 'A', cwd: '/tmp/a' });
const tB = sIdx.createThread({ title: 'B', cwd: '/tmp/b' });
for (let i = 0; i < 30; i += 1) sIdx.addMessage({ threadId: i % 2 ? tA.id : tB.id, role: 'user', content: `m${i}` });
check('索引：两会话各自独立取回（不串线程）',
  sIdx.listMessages(tA.id).length === 15 && sIdx.listMessages(tB.id).length === 15);
check('索引：读路径复用同一 Map（不每次重建）', (() => {
  sIdx.listMessages(tA.id);
  const m1 = sIdx._byThread;
  sIdx.listMessages(tB.id);
  return m1 instanceof Map && sIdx._byThread === m1;
})());
sIdx.addMessage({ threadId: tA.id, role: 'assistant', content: 'new' });
check('索引：新增消息立即可读（增量维护）', sIdx.listMessages(tA.id).slice(-1)[0].content === 'new');
const page1 = sIdx.listMessagesPage(tA.id, { limit: 5 });
check('分页：取最近 5 条且 hasMore=true',
  page1.messages.length === 5 && page1.messages.slice(-1)[0].content === 'new' && page1.hasMore === true, `total=${page1.total}`);
const cursor = page1.messages[0].id;
const page2 = sIdx.listMessagesPage(tA.id, { limit: 5, beforeId: cursor });
check('分页：beforeId 游标不重复也不跳条', page2.messages.length === 5 && page2.messages.every((m) => m.id < cursor));
check('分页：limit 有上限保护', sIdx.listMessagesPage(tA.id, { limit: 999999 }).messages.length <= 2000);
const stIdx = sIdx.statsSummary();
check('统计：线程/消息数一致', stIdx.threads === 2 && stIdx.messages === 31, JSON.stringify(stIdx));
sIdx.archiveThread(tB.id);
check('统计：归档会话不计入 threads', sIdx.statsSummary().threads === 1 && sIdx.statsSummary().archivedThreads === 1);

// ── R2-2（2026-11-03）：.bak 轮转 + 主文件缺失时的恢复（崩溃窗口）──
const dirRot = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-rot-'));
const sRot = new LocalStore(dirRot);
const tRot = sRot.createThread({ title: 'rot', cwd: '/tmp/r' });
sRot.flushSync();                       // 第一次：只有主文件，无 .bak
sRot.addMessage({ threadId: tRot.id, role: 'user', content: 'after-rotation' });
sRot.flushSync();                       // 第二次：轮转出 .bak（内容 = 上一版）
const bakPath = path.join(dirRot, 'local-data.json.bak');
check('.bak 轮转产出上一版快照', fs.existsSync(bakPath) && !fs.readFileSync(bakPath, 'utf8').includes('after-rotation'));
check('轮转后主文件是最新版', fs.readFileSync(path.join(dirRot, 'local-data.json'), 'utf8').includes('after-rotation'));
fs.unlinkSync(path.join(dirRot, 'local-data.json'));   // 模拟「轮转完成、新文件未落盘」时崩溃
const sRecovered = new LocalStore(dirRot);
check('主文件缺失时从 .bak 恢复（不静默重置为空库）',
  sRecovered.recoveredFromBackup === true && sRecovered.listThreads().length === 1);
check('恢复成功时不得进入 corrupt-blocked', sRecovered.corruptBlocked === false);

// ── R3-1 / R3-2（2026-11-03）：正文检索 与 会话导出 ──
const dirR3 = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-r3-'));
const sR3 = new LocalStore(dirR3);
const t1 = sR3.createThread({ title: '检索A', cwd: '/tmp/a' });
const t2 = sR3.createThread({ title: '检索B', cwd: '/tmp/b' });
sR3.addMessage({ threadId: t1.id, role: 'user', content: '请把 Timeout 改成 30000 毫秒' });
sR3.addMessage({ threadId: t2.id, role: 'assistant', content: 'timeout 已调整为 30000' });
sR3.addMessage({ threadId: t2.id, role: 'assistant', content: '无关内容', toolCalls: [{ id: 'c1', name: 'shell', args: { command: 'ls' } }] });

const r1 = sR3.searchMessages('timeout');
check('检索：大小写不敏感且跨会话', r1.total === 2 && r1.hits.length === 2, `total=${r1.total}`);
check('检索：摘要里确实含关键词原文', r1.hits.every((h) => /timeout/i.test(h.snippet)));
check('检索：空查询返回空结果（绝不等于全量）',
  sR3.searchMessages('   ').total === 0 && sR3.searchMessages('   ').hits.length === 0);
const r2 = sR3.searchMessages('timeout', { limit: 1 });
check('检索：limit 只截断返回体，total 仍是真实命中数', r2.hits.length === 1 && r2.total === 2 && r2.truncated === true);
const r3 = sR3.searchMessages('timeout', { threadId: t1.id });
check('检索：可按单个会话限定', r3.total === 1 && r3.hits[0].threadId === t1.id);
check('检索：工具调用参数不参与匹配（凭证/大段内容不进结果）', sR3.searchMessages('command').total === 0);

const ex = sR3.exportThreadMarkdown(t2.id);
check('导出：文件名安全化且是 .md', ex.ok && !/[\\/]/.test(ex.filename) && ex.filename.endsWith('.md'), ex.filename);
check('导出：含会话标题与消息正文', ex.content.includes('# 检索B') && ex.content.includes('timeout 已调整为 30000'));
check('导出：工具调用只写名字、不写参数', ex.content.includes('shell') && !ex.content.includes('command'));
check('导出：不存在的会话返回 ok:false', sR3.exportThreadMarkdown(999999).ok === false);

// scheduleFlush 定时器到期自动落盘（异步段收尾，统一在此清理与退出）
(async () => {
  const dirTimer = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-timer-'));
  const sT = new LocalStore(dirTimer);
  const tT = sT.createThread({ title: '定时器', cwd: '/tmp/t' });
  sT.addMessage({ threadId: tT.id, role: 'user', content: '异步合并消息' });
  await new Promise((r) => setTimeout(r, 400)); // 默认合并窗口 150ms，400ms 后应已自动落盘
  check('scheduleFlush 到期自动落盘（无需 flushSync）', new LocalStore(dirTimer).listMessages(tT.id).length === 1);
  sT.flushSync();

  fs.rmSync(dirNoBak, { recursive: true, force: true });
  fs.rmSync(dirBak, { recursive: true, force: true });
  fs.rmSync(dirMig, { recursive: true, force: true });
  fs.rmSync(dirHot, { recursive: true, force: true });
  fs.rmSync(dirFork, { recursive: true, force: true });
  fs.rmSync(dirTimer, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dirIdx, { recursive: true, force: true });
  fs.rmSync(dirRot, { recursive: true, force: true });
  fs.rmSync(dirR3, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  // 裸 async IIFE 的失败会变成 unhandled rejection：退出码仍可能是 0，表现是「静默通过」。
  // 显式兜住并置非零退出码（audit-check-await 的 ratchet 也会因此只降不升）。
  console.error('[FAIL] 套件异常：', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
