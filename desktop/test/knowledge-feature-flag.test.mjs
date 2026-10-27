// 知识库特性开关门禁（方法论文档 §17.2）
//
// §17.2 原文：「新数据读取与知识能力使用独立 feature flag，默认关闭直至对应验收完成」。
// 这条要求在 M3 落地时**没做**，本次补上。它的价值不只是「合规」：
// 知识库是唯一能读本地文档正文的能力，默认开启等于把一个未完成验收的读数据面直接交给用户。
//
// 本套件守四件事：
//   ① 默认关闭（常量级，防有人手滑改默认值）；
//   ② 关闭时每个业务通道都显式返回 FEATURE_DISABLED（不是「没注册」——那与通道名写错同形）；
//   ③ 关闭时**不产生副作用**：导入不得弹文件对话框、不得读盘；
//   ④ capabilities 始终可答，且 enabled 如实反映开关（界面据此区分「被关」与「坏了」）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installElectronStub } from './helpers/electronStub.mjs';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');

// ── electron 桩：记录每次 handle 注册，以及导入对话框是否被调用 ──
const handlers = new Map();
let dialogCalls = 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-flag-'));
const sampleFile = path.join(TMP, 'flag-sample.md');
fs.writeFileSync(sampleFile, '# 标题\n\n这是用于特性开关测试的正文内容，含足够字符以便分块。\n', 'utf8');

installElectronStub({
  ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); } },
  dialog: {
    showOpenDialog: async () => {
      dialogCalls += 1;
      return { canceled: false, filePaths: [sampleFile] };
    },
  },
  app: { getPath: () => TMP },
});

const { openSqliteJsDb } = require(path.join(DESKTOP, 'main/db/sqljsDb.js'));
const kb = require(path.join(DESKTOP, 'main/knowledgeBaseQuery.js'));
const { initKnowledgeIpc } = require(path.join(DESKTOP, 'main/ipc/knowledgeBase.js'));
const { DEFAULTS } = require(path.join(DESKTOP, 'main/featureFlags.js'));

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.error(`❌ ${name} — ${e.message}`); }
};

const db = await openSqliteJsDb(path.join(TMP, 'flag.sqlite'));
db.exec(kb.KB_SCHEMA);

// 先按「关闭」装配（deps.getFlags 返回 knowledge:false）
let flags = { knowledge: false };
initKnowledgeIpc({
  getDb: () => db, audit: () => {}, getWindow: () => null, getActor: () => 'owner',
  getFlags: () => flags,
});

const call = (ch, payload) => {
  const fn = handlers.get(ch);
  if (!fn) throw new Error(`通道未注册：${ch}`);
  return fn({}, payload);
};

await check('① 默认关闭：featureFlags.DEFAULTS.knowledge === false（§17.2）', () => {
  assert.equal(DEFAULTS.knowledge, false);
});

await check('① 关闭时 8 条业务通道全部返回 FEATURE_DISABLED（不是「未注册」）', async () => {
  const cases = [
    ['knowledge:import', {}], ['knowledge:list', {}], ['knowledge:search', { query: '标题' }],
    ['knowledge:authorize', { sourceId: 'x', projectId: 'p' }],
    ['knowledge:deauthorize', { sourceId: 'x', projectId: 'p' }],
    ['knowledge:delete', { sourceId: 'x' }],
    ['knowledge:preview-context', { projectId: 'p' }],
    ['knowledge:validate-context', { planId: 'x', planHash: 'y' }],
  ];
  const wrong = [];
  for (const [ch, payload] of cases) {
    const r = await call(ch, payload);
    if (!(r && r.ok === false && r.code === 'FEATURE_DISABLED')) wrong.push(`${ch} → ${JSON.stringify(r)}`);
  }
  assert.deepEqual(wrong, [], `以下通道未按关闭态拒绝：\n${wrong.join('\n')}`);
});

await check('③ 关闭时导入**不弹对话框、不读盘**（关闭态零副作用）', async () => {
  const before = dialogCalls;
  const r = await call('knowledge:import', { projectId: 'p' });
  assert.equal(r.code, 'FEATURE_DISABLED');
  assert.equal(dialogCalls, before, `关闭态仍弹出了文件对话框（${dialogCalls - before} 次）`);
});

await check('④ capabilities 始终可答，且 enabled=false 如实反映关闭态', async () => {
  const r = await call('knowledge:capabilities');
  assert.equal(r.ok, true);
  assert.equal(r.capabilities.enabled, false);
  // 关闭态仍应给出静态能力描述（离线可算，不读库）——界面要用它显示「支持哪些格式」
  assert.ok(Array.isArray(r.capabilities.supportedExtensions) && r.capabilities.supportedExtensions.length > 0);
});

// ── 打开开关：同一批通道必须真的工作 ──
flags = { knowledge: true };

await check('⑤ 打开后 capabilities.enabled=true', async () => {
  const r = await call('knowledge:capabilities');
  assert.equal(r.capabilities.enabled, true);
});

await check('⑤ 打开后导入真的执行（弹一次对话框 + 返回逐项结果）', async () => {
  const before = dialogCalls;
  const r = await call('knowledge:import', { projectId: 'p' });
  assert.equal(dialogCalls, before + 1, '打开态未调用文件对话框');
  assert.equal(r.ok, true, `导入失败：${JSON.stringify(r)}`);
  // §8.4：多选导入返回逐项结果（一个失败不吞掉其他成功项），不再是单个 sourceId
  assert.ok(Array.isArray(r.results) && r.results.length === 1, '返回形状不是逐项结果');
  assert.ok(String(r.results[0].sourceId).startsWith('kb_'), '未返回 sourceId');
  assert.equal(r.imported, 1);
});

await check('⑤ 打开后 list / search 正常工作（不是只会返回 FEATURE_DISABLED）', async () => {
  const list = await call('knowledge:list', { scope: 'project', projectId: 'p' });
  assert.equal(list.ok, true);
  assert.ok(list.items.length >= 1, '导入后列表为空');
  const s = await call('knowledge:search', { projectId: 'p', query: '特性开关' });
  assert.equal(s.ok, true);
  assert.ok(s.items.length >= 1, '打开态检索无命中（说明守卫把正常路径也拦了）');
});

// ── 结构自检：守卫必须覆盖业务通道，两个例外各有理由 ──
await check('⑤ 结构：12 条通道 / 10 条守卫（capabilities 与 cancel-import 是仅有的两个例外）', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main/ipc/knowledgeBase.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  const channels = (src.match(/ipcMain\.handle\('knowledge:/g) || []).length;
  const guards = (src.match(/if \(!enabled\(\)\) return disabled\(\);/g) || []).length;
  assert.equal(channels, 12, `通道数变了（${channels}）——新增通道必须同步决定是否受开关约束`);
  // 两个例外：① capabilities 必须始终可答（区分「被关」与「坏了」）；
  //          ② cancel-import 必须能在关停瞬间仍然可用，否则用户会卡在一个永远取消不掉的导入上。
  assert.equal(guards, channels - 2, `守卫数 ${guards} 与通道数 ${channels} 不匹配（例外只允许 2 条）`);
  assert.ok(/knowledge:cancel-import'[\s\S]{0,200}JOB_NOT_FOUND/.test(src), 'cancel-import 的实现形态变了，需重审例外');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\nknowledge-feature-flag: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
