// apply_patch 加固测试（2026-10-15，三类真实失败模式实测复现后修复）
//
//   ① 重复应用：此前 "Reversed (or previously applied) patch detected! Assume -R? [n]"
//      会等 stdin 回答（stdin 是补丁本身，写完即 end）→ 挂死；现在 --batch --forward 幂等跳过
//   ② 失败残留：此前失败会在用户项目里落 app.js.rej + .orig/.ouD0ErF 备份；
//      现在 -r /dev/null + --no-backup-if-mismatch，工作区零污染
//   ③ 失败不可行动：此前只回 "patch exit 1"，模型只能原样重试同一补丁直到轮次耗尽；
//      现在回传 target/hint/currentContent/nearest，并先做一次宽松空白重试
const path = require('path');
const fs = require('fs');
const Module = require('module');

// ── electron stub（与 tools-cwd.test.js 同源；FakeBrowserWindow 自动应答审批 'once'）──
const handlers = new Map();
const noop = () => {};
let approvalResponseCb = null;
const ipcMain = {
  handle: (ch, fn) => handlers.set(ch, fn),
  on: (channel, cb) => { if (channel === 'tool:approval-response') approvalResponseCb = cb; },
  once: noop,
};
function autoRespondApproval(channel, payload) {
  if (channel === 'tool:approval-request' && approvalResponseCb) {
    setTimeout(() => approvalResponseCb({}, { approvalId: payload?.approvalId, decision: 'once' }), 5);
  }
}
class FakeBrowserWindow {
  constructor() { this.webContents = { setWindowOpenHandler: noop, openDevTools: noop, send: autoRespondApproval, on: noop }; }
  loadURL() {} loadFile() {} on() {} once() {} show() {}
  isMinimized() { return false; } restore() {} focus() {}
  getBounds() { return { width: 1600, height: 1000 }; }
}
const electronStub = {
  app: { whenReady: () => Promise.resolve(), on: noop, requestSingleInstanceLock: () => true, getPath: () => '/tmp/mjcode-test', isPackaged: false, quit: noop },
  BrowserWindow: FakeBrowserWindow,
  ipcMain,
  shell: { openExternal: noop },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
};
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[electronPath] = stubModule;

require('../main/main.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

  const REPO = '/tmp/mjcoder-patch-hardening';
  const h = (ch) => handlers.get(ch);
  // approvalMode:'never'：apply_patch 是 L2，目标都在项目内本就不需要审批；
  // 显式关闭可消除对 mainWindow 异步创建的时序依赖（否则 require 后立即调用会拿不到 webContents）
  const applyPatch = (args) => h('tool:applyPatch')({}, { approvalMode: 'never', ...args });

(async () => {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });

  // ── ① 正常路径：一次成功 ──
  fs.writeFileSync(path.join(REPO, 'a.js'), 'const a = 1;\nconst b = 2;\nconsole.log(a);\n');
  const okPatch = '--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n console.log(a);\n';
  const r1 = await applyPatch({ patch: okPatch, cwd: REPO });
  check('正常补丁应用成功（exit 0）', r1.exitCode === 0 && !r1.error, JSON.stringify(r1).slice(0, 120));
  check('文件内容确实被修改', fs.readFileSync(path.join(REPO, 'a.js'), 'utf8').includes('const b = 3'));

  // ── ② 幂等：已应用过的「修改型」补丁（-/+ 各一行）→ 重复应用跳过而非挂死/报错 ──
  // 注：纯加法补丁重复应用时上下文自然失配，属真实失败（另有反例断言）
  fs.writeFileSync(path.join(REPO, 'e.js'), 'const a = 1;\nconsole.log(a);\n');
  const idemPatch = '--- a/e.js\n+++ b/e.js\n@@ -1,2 +1,2 @@\n const a = 1;\n-console.log(a);\n+console.log(a, b);\n';
  const r2a = await applyPatch({ patch: idemPatch, cwd: REPO });
  check('首次应用成功', r2a.exitCode === 0, JSON.stringify({ code: r2a.exitCode, err: r2a.error }));
  const r2 = await applyPatch({ patch: idemPatch, cwd: REPO });
  check('重复应用幂等跳过（exit 0 + alreadyApplied）',
    r2.exitCode === 0 && r2.alreadyApplied === true, JSON.stringify({ code: r2.exitCode, aa: r2.alreadyApplied }));
  check('幂等跳过不重复改写内容',
    fs.readFileSync(path.join(REPO, 'e.js'), 'utf8').includes('console.log(a, b);')
    && !fs.readFileSync(path.join(REPO, 'e.js'), 'utf8').includes('console.log(a);\nconsole.log'));
  // 注：对「已打过此补丁」的文件重放，GNU patch 判定为 previously applied → 幂等跳过（上面已验）。
  // 「被删行从未存在」的真实失败由下方 ③ 覆盖，两者语义不同。

  // ── ③ 失败残留：不再落 .rej / .orig / 编号备份 ──
  fs.writeFileSync(path.join(REPO, 'c.js'), 'const a = 1;\nconsole.log(a);\n');
  const badPatch = '--- a/c.js\n+++ b/c.js\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n console.log(a, b);\n';
  const r3 = await applyPatch({ patch: badPatch, cwd: REPO });
  check('真失败返回非零退出码', r3.exitCode !== 0 && !!r3.error);
  const after = fs.readdirSync(REPO).filter((f) => /\.rej$|\.orig$|\.js\.[A-Za-z0-9]{6}$/.test(f));
  check('失败后工作区零残留（无 .rej/.orig/编号备份）', after.length === 0, JSON.stringify(after));
  check('失败未改动文件内容', !fs.readFileSync(path.join(REPO, 'c.js'), 'utf8').includes('const b = 3'));

  // ── ④ 失败可行动：回传 target / hint / currentContent / nearest ──
  check('失败回传目标绝对路径', r3.target === path.join(REPO, 'c.js'), String(r3.target));
  check('失败回传当前文件内容（模型据此重新对齐）',
    typeof r3.currentContent === 'string' && r3.currentContent.includes('const a = 1;'));
  check('失败回传 hint 且明确「不要原样重试」', typeof r3.hint === 'string' && r3.hint.includes('不要原样重试'));
  check('失败回传最近锚点（nearest）', r3.nearest === undefined || (r3.nearest && typeof r3.nearest.snippet === 'string'));

  // ── ⑤ 宽松空白重试：仅空白差异时自动二次成功 ──
  fs.writeFileSync(path.join(REPO, 'd.js'), 'const a = 1;\nconst b   =   2;\nconsole.log(a);\n');
  const wsPatch = '--- a/d.js\n+++ b/d.js\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n console.log(a);\n';
  const r5 = await applyPatch({ patch: wsPatch, cwd: REPO });
  check('仅空白差异时宽松重试成功（lenientWhitespace）',
    r5.lenientWhitespace === true && r5.exitCode === 0, JSON.stringify({ code: r5.exitCode, lw: r5.lenientWhitespace }));
  check('宽松重试确实改了文件', fs.readFileSync(path.join(REPO, 'd.js'), 'utf8').includes('const b = 3'));

  // ── ⑥ 空补丁防御：runWriteTool 统一把实现抛错兜成结构化失败（不静默成功）──
  const r6 = await applyPatch({ patch: '', cwd: REPO });
  check('空补丁返回结构化失败（不静默成功）', r6 && r6.ok === false && !!r6.error,
    JSON.stringify(r6).slice(0, 120));

  fs.rmSync(REPO, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
