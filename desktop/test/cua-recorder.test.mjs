// T4-6 门禁：操作录制与回放（main/cuaRecorder.js）
// 覆盖：录制结构校验（fail-closed/路径穿越拒绝）/ 节点三级匹配 / 存储往返（真实 tmp 目录）/
//      截图落盘与级联清理 / ReplayLoop 行为（正常回放、敏感逐次确认、deny 即停、
//      节点缺失中止、always 每步确认）/ main.js·preload·渲染层接线静态断言。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const R = require(path.join(DESKTOP, 'main', 'cuaRecorder.js'));

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.stack || e.message}`); process.exitCode = 1; }
}

// ── 合法录制样本 ──
const mkStep = (i, over = {}) => ({
  index: i,
  action: { action: 'click', ...(over.action || {}) },
  node: { role: 'button', name: '登录', value: '', path: [0, i - 1], ...(over.node || {}) },
  ts: Date.now(),
  ...(over.screenshotFile !== undefined ? { screenshotFile: over.screenshotFile } : {}),
});
const mkRec = (over = {}) => ({
  version: 1, id: 'rec-test-001', name: '测试录制', objective: '点登录', appName: 'Safari',
  createdAt: Date.now(), steps: [mkStep(1), mkStep(2)], ...over,
});

// ── 1. validateRecording：合法通过 + 各类非法 fail-closed ──
await check('validateRecording 合法结构通过', () => {
  assert.equal(R.validateRecording(mkRec()).ok, true);
});
await check('validateRecording 拒绝：版本/id 非法/路径穿越/空步骤/序号断链/非法动作/缺文本/缺节点', () => {
  assert.equal(R.validateRecording(mkRec({ version: 2 })).ok, false);
  assert.equal(R.validateRecording(mkRec({ id: '../evil' })).ok, false);
  assert.equal(R.validateRecording(mkRec({ id: 'a/b' })).ok, false);
  assert.equal(R.validateRecording(mkRec({ steps: [] })).ok, false);
  assert.equal(R.validateRecording(mkRec({ steps: [mkStep(1), mkStep(3)] })).ok, false);
  assert.equal(R.validateRecording(mkRec({ steps: [mkStep(1, { action: { action: 'done' } })] })).ok, false);
  assert.equal(R.validateRecording(mkRec({ steps: [mkStep(1, { action: { action: 'type' } })] })).ok, false);
  assert.equal(R.validateRecording(mkRec({ steps: [mkStep(1, { action: { action: 'key' } })] })).ok, false);
  assert.equal(R.validateRecording(mkRec({ steps: [mkStep(1, { node: { role: '' } })] })).ok, false);
  assert.equal(R.validateRecording(null).ok, false);
});

// ── 2. sanitizeStep：从 loop 'step' 事件投影最小回放面 ──
await check('sanitizeStep 丢弃 ref/depth、保留动作与节点特征', () => {
  const evt = {
    type: 'step', step: 3,
    action: { action: 'type', ref: 7, text: 'hello', bogus: 1 },
    node: { ref: 7, depth: 2, role: 'textfield', name: '用户名', value: '', path: [0, 1], position: { x: 10, y: 20 }, size: { x: 80, y: 20 } },
    result: { ok: true },
  };
  const s = R.sanitizeStep(evt, 1);
  assert.equal(s.index, 1);
  assert.deepEqual(s.action, { action: 'type', text: 'hello' });
  assert.equal(s.node.role, 'textfield');
  assert.equal(s.node.name, '用户名');
  assert.equal(s.node.ref, undefined);
  assert.equal(s.node.depth, undefined);
  assert.deepEqual(s.node.position, { x: 10, y: 20 });
});

// ── 3. matchRecordedNode：role+name → path → 位置就近 → null ──
await check('matchRecordedNode 三级匹配与失配返回 null', () => {
  const live = [
    { ref: 1, role: 'button', name: '取消', path: [0, 0], position: { x: 500, y: 300 } },
    { ref: 2, role: 'button', name: '登录', path: [0, 1], position: { x: 100, y: 200 } },
    { ref: 3, role: 'textfield', name: '', path: [0, 2], position: { x: 60, y: 40 } },
  ];
  // 1) name 精确
  assert.equal(R.matchRecordedNode(live, { role: 'button', name: '登录', path: [9, 9] }).ref, 2);
  // 2) name 失配 → path 精确
  assert.equal(R.matchRecordedNode(live, { role: 'button', name: '旧名字', path: [0, 0] }).ref, 1);
  // 3) path 也失配 → 同 role 位置就近（≤40px）
  assert.equal(R.matchRecordedNode(live, { role: 'textfield', name: '', path: [7, 7], position: { x: 70, y: 50 } }).ref, 3);
  // 4) 全失配 → null（fail-closed 前提）
  assert.equal(R.matchRecordedNode(live, { role: 'button', name: '不存在', path: [8, 8], position: { x: 9000, y: 9000 } }), null);
  assert.equal(R.matchRecordedNode(live, null), null);
});

// ── 4. 存储往返：真实 tmp 目录 ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-rec-test-'));
const deps = { dir: tmpDir };
await check('save/load/list/delete 往返 + 损坏条目列表静默跳过', () => {
  const rec = mkRec();
  assert.equal(R.saveRecording(rec, deps).ok, true);
  const loaded = R.loadRecording(rec.id, deps);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recording.steps.length, 2);
  const list = R.listRecordings(deps);
  assert.equal(list.length, 1);
  assert.equal(list[0].stepCount, 2);
  // 人为写坏一条 → 列表跳过、load 报错（fail-closed）
  fs.writeFileSync(path.join(tmpDir, 'rec-bad-002.json'), '{ "version": 99 }');
  assert.equal(R.listRecordings(deps).length, 1);
  assert.equal(R.loadRecording('rec-bad-002', deps).ok, false);
  assert.equal(R.deleteRecording(rec.id, deps).ok, true);
  assert.equal(R.loadRecording(rec.id, deps).ok, false);
  assert.equal(R.deleteRecording('../escape', deps).ok, false); // 非法 id 拒绝
});

// ── 5. 截图落盘 + 半成品级联清理 ──
await check('writeScreenshot 落盘 PNG；deleteRecording 级联清截图（含无 JSON 的半成品）', () => {
  const id = 'rec-shot-003';
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae42608d', 'hex');
  const file = R.writeScreenshot(id, 1, `data:image/png;base64,${png.toString('base64')}`, deps);
  assert.equal(file, `${id}-step1.png`);
  assert.ok(fs.existsSync(path.join(tmpDir, file)));
  assert.throws(() => R.writeScreenshot(id, 2, 'data:image/jpeg;base64,xx', deps), /PNG/);
  assert.equal(R.deleteRecording(id, deps).ok, true);
  assert.ok(!fs.existsSync(path.join(tmpDir, file)), '级联清理应删除截图');
});

// ── 6. ReplayLoop 行为 ──
const axNode = (ref, name) => ({ ref, role: 'button', name, value: '', path: [0, ref] });
function mkLoop({ steps, live, decision = 'once', approvalMode = 'on-request' }) {
  const events = [];
  const performed = [];
  const audited = [];
  const approvals = [];
  const loop = new R.ReplayLoop({
    recording: mkRec({ steps }),
    approvalMode,
    toolHandlers: {
      collectAx: async () => ({ interactive: live }),
      perform: async (action, node) => { performed.push({ action, node }); return { ok: true }; },
    },
    approval: {
      requestApproval: async (summary) => { approvals.push(summary); return decision; },
      audit: (step, text, result) => audited.push({ step, text, result }),
    },
    onEvent: (e) => events.push(e),
  });
  return { loop, events, performed, audited, approvals };
}
await check('ReplayLoop 正常回放：全部步骤执行且不调模型（无 chat handler 也不报错）', async () => {
  const g = mkLoop({
    steps: [mkStep(1), mkStep(2)],
    live: [axNode(1, '登录'), axNode(2, '登录')],
  });
  const res = await g.loop.run();
  assert.equal(res.completed, true);
  assert.equal(g.performed.length, 2);
  assert.equal(g.events.at(-1).type, 'done');
  assert.equal(g.approvals.length, 0); // 非敏感 + on-request：不弹窗
});
await check('ReplayLoop 敏感步骤逐次确认：确认后继续，deny 立即停止并审计 denied', async () => {
  const steps = [mkStep(1), mkStep(2, { node: { name: '删除' } }), mkStep(3)];
  const live = [axNode(1, '登录'), axNode(1, '删除'), axNode(1, '登录')];
  const ok = mkLoop({ steps, live, decision: 'once' });
  const r1 = await ok.loop.run();
  assert.equal(r1.completed, true);
  assert.equal(ok.approvals.length, 1); // 仅敏感步骤弹一次
  assert.equal(ok.events.filter((e) => e.type === 'confirm').length, 1);

  const no = mkLoop({ steps, live, decision: 'deny' });
  const r2 = await no.loop.run();
  assert.equal(r2.completed, false);
  assert.equal(r2.denied, true);
  assert.equal(no.performed.length, 1); // 敏感步骤未执行
  assert.deepEqual(no.audited.at(-1), { step: 2, text: no.audited.at(-1).text, result: 'denied' });
});
await check('ReplayLoop always 模式：每步都弹确认', async () => {
  const g = mkLoop({ steps: [mkStep(1), mkStep(2)], live: [axNode(1, '登录'), axNode(1, '登录')], approvalMode: 'always' });
  const res = await g.loop.run();
  assert.equal(res.completed, true);
  assert.equal(g.approvals.length, 2);
});
await check('ReplayLoop 节点缺失 fail-closed：step-missing 中止，不执行任何后续动作', async () => {
  const g = mkLoop({ steps: [mkStep(1)], live: [axNode(1, '完全不同的按钮')] });
  const res = await g.loop.run();
  assert.equal(res.completed, false);
  assert.equal(res.missingAt, 1);
  assert.equal(g.performed.length, 0);
  const err = g.events.find((e) => e.type === 'error');
  assert.equal(err.code, 'step-missing');
});
await check('ReplayLoop 构造即校验：非法录制直接抛错（fail-closed）', () => {
  assert.throws(() => new R.ReplayLoop({ recording: mkRec({ version: 2 }) }), /非法/);
});

// ── 7. 接线静态断言（main.js / preload.js / 渲染层 / i18n）──
const mainSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'preload.js'), 'utf8');
await check('main.js 接线：record 参数 + 回放/列表/删除 IPC + 互斥守卫', () => {
  assert.match(mainSrc, /require\('\.\/cuaRecorder'\)/);
  assert.match(mainSrc, /cua:run[\s\S]*?record = false, recordingName = ''/);
  assert.match(mainSrc, /ipcMain\.handle\('cua:replay'/);
  assert.match(mainSrc, /ipcMain\.handle\('cua:recordings:list'/);
  assert.match(mainSrc, /ipcMain\.handle\('cua:recordings:delete'/);
  assert.match(mainSrc, /activeCuaLoop \|\| activeReplayLoop/);
  assert.match(mainSrc, /userData'\), 'recordings'\)/); // 录制数据仅存本机 userData
  assert.match(mainSrc, /cua\.captureScreen\(\)/); // 每步截图
});
await check('preload 暴露 cuaReplay/cuaRecordingsList/cuaRecordingsDelete', () => {
  assert.match(preloadSrc, /cuaReplay: \(payload\) => ipcRenderer\.invoke\('cua:replay', payload\)/);
  assert.match(preloadSrc, /cuaRecordingsList: \(\) => ipcRenderer\.invoke\('cua:recordings:list'\)/);
  assert.match(preloadSrc, /cuaRecordingsDelete: \(payload\) => ipcRenderer\.invoke\('cua:recordings:delete', payload\)/);
});
await check('渲染层接线：面板嵌入 SettingsModal + i18n 双语键齐全', () => {
  const settings = fs.readFileSync(path.join(DESKTOP, 'renderer', 'src', 'components', 'SettingsModal.jsx'), 'utf8');
  assert.match(settings, /import RecordReplayPanel from '\.\/RecordReplayPanel'/);
  assert.match(settings, /<RecordReplayPanel granted=/);
  const zh = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer', 'src', 'i18n', 'locales', 'zh-CN', 'settings.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer', 'src', 'i18n', 'locales', 'en-US', 'settings.json'), 'utf8'));
  const panel = fs.readFileSync(path.join(DESKTOP, 'renderer', 'src', 'components', 'RecordReplayPanel.tsx'), 'utf8');
  const keys = [...new Set([...panel.matchAll(/t\('settings\.([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 25, `面板 i18n 键过少：${keys.length}`);
  for (const k of keys) {
    assert.ok(k in zh, `zh-CN 缺少键 settings.${k}`);
    assert.ok(k in en, `en-US 缺少键 settings.${k}`);
  }
});

console.log(`\ncua-recorder: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
