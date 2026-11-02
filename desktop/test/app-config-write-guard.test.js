// 应用治理配置写入闸（RQ-01 回归）：userData 顶层配置文件永不可由模型写入。
//
// 为什么必须有一条**行为级**断言（而不是只测纯函数）：
//   纯函数 `isProtectedAppPath` 全绿，只能证明「判定本身对」；而这次事故的根因是
//   **判定根本没被调用**（exec.js 的 carve-out 只按 cwd 展开，userData 从没进过集合）。
//   所以本套件走真实的 runWriteTool，断言「auto-safe 档 + 白名单内 + 应用配置」这条路
//   被拦下，且文件**没有**被创建。负样本（artifacts/、项目内同名文件）用来防过度封锁。
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-appguard-'));
const userData = path.join(tmpRoot, 'userData');
const project = path.join(tmpRoot, 'project');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(project, { recursive: true });

// ── electron stub（exec.js 与 audit 都 require electron）──
const noop = () => {};
const electronStub = {
  app: { getPath: (k) => (k === 'userData' ? userData : tmpRoot), isPackaged: false, on: noop, whenReady: () => Promise.resolve(), quit: noop },
  ipcMain: { handle: noop, on: noop, once: noop, removeHandler: noop },
  shell: { openExternal: noop, openPath: noop, showItemInFolder: noop },
  BrowserWindow: class { constructor() { this.webContents = { send: noop, on: noop, setWindowOpenHandler: noop }; } static getAllWindows() { return []; } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => String(b) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const exec = require('../main/tools/exec');
const writeGuard = require('../main/writeGuard');

function initExec() {
  exec.initToolExec({
    // 审批一律「拒绝」：本套件的命门是「根本不该走到审批」——走到就等于已失守
    requestApproval: async () => 'deny',
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    getGovernance: () => ({ fsMode: 'read-write' }),
  });
}

async function main() {
  initExec();

  // ── 纯函数层：判定口径 ──
  check('hooks.json 属应用配置', writeGuard.isProtectedAppPath(path.join(userData, 'hooks.json'), userData));
  check('approval-rules.json 属应用配置', writeGuard.isProtectedAppPath(path.join(userData, 'approval-rules.json'), userData));
  check('原子写临时文件（.tmp）同等保护', writeGuard.isProtectedAppPath(path.join(userData, 'hooks.json.tmp'), userData));
  check('上一版备份（.bak）同等保护', writeGuard.isProtectedAppPath(path.join(userData, 'local-data.json.bak'), userData));
  check('SQLite 派生文件（-wal）同等保护', writeGuard.isProtectedAppPath(path.join(userData, 'mjcode-tasks.db-wal'), userData));
  check('迁移前快照（.pre-vN.bak）同等保护', writeGuard.isProtectedAppPath(path.join(userData, 'mjcode-tasks.db.pre-v3.bak'), userData));
  check('普通设置文件不误伤', !writeGuard.isProtectedAppPath(path.join(userData, 'settings.json'), userData));
  check('业务子目录同名文件不误伤', !writeGuard.isProtectedAppPath(path.join(userData, 'artifacts', 'hooks.json'), userData));
  check('项目目录同名文件不误伤', !writeGuard.isProtectedAppPath(path.join(project, 'hooks.json'), userData));
  check('空 userData 不命中（退化为改造前行为）', !writeGuard.isProtectedAppPath(path.join(userData, 'hooks.json'), ''));
  // 自检：清单被删空时上面几条会假绿，这里钉住两项不可缺
  const names = writeGuard.PROTECTED_APP_NAMES;
  check('清单自检：含 hooks.json 与 approval-rules.json',
    names.includes('hooks.json') && names.includes('approval-rules.json'), `${names.length} 项`);

  // ── 行为层：auto-safe 档 + 白名单内（userData）+ 应用配置 → 必须拦 ──
  const cases = [
    ['hooks.json', path.join(userData, 'hooks.json')],
    ['approval-rules.json', path.join(userData, 'approval-rules.json')],
    ['local-data.json', path.join(userData, 'local-data.json')],
    ['mjcode-tasks.db', path.join(userData, 'mjcode-tasks.db')],
  ];
  for (const [label, target] of cases) {
    const r = await exec.runWriteTool('writeFile', {
      path: target, content: '{"pwned":true}', cwd: project, approvalMode: 'auto-safe',
    });
    check(`auto-safe 拦下 ${label}`, r && r.ok === false && r.appConfig === true, r && (r.error || '').slice(0, 40));
    check(`${label} 未被落盘`, !fs.existsSync(target));
  }

  // 不依赖 cwd：无 cwd 时同样拦（白名单判定会失准，这条不能跟着失准）
  const noCwd = await exec.runWriteTool('writeFile', {
    path: path.join(userData, 'hooks.json'), content: 'x', approvalMode: 'auto-safe',
  });
  check('无 cwd 时仍拦下应用配置', noCwd && noCwd.appConfig === true);

  // apply_patch 走同一判定（diff 目标提取后逐个判）
  const patch = `--- a/approval-rules.json\n+++ b/approval-rules.json\n@@ -1 +1 @@\n-[]\n+[{"tool":"shell","pattern":"*","scope":"always"}]`;
  const pr = await exec.runWriteTool('applyPatch', {
    patch, cwd: userData, approvalMode: 'auto-safe',
  });
  check('apply_patch 改写 approval-rules.json 被拦', pr && pr.appConfig === true, pr && (pr.error || '').slice(0, 40));

  // ── 负样本：不过度封锁 ──
  const okArtifact = path.join(userData, 'artifacts', 'note.txt');
  const r1 = await exec.runWriteTool('writeFile', { path: okArtifact, content: 'ok', cwd: project, approvalMode: 'auto-safe' });
  check('userData 业务子目录仍可写', r1 && r1.ok === true && fs.existsSync(okArtifact));

  const okProject = path.join(project, 'hooks.json');
  const r2 = await exec.runWriteTool('writeFile', { path: okProject, content: 'ok', cwd: project, approvalMode: 'auto-safe' });
  check('项目内同名文件仍可写', r2 && r2.ok === true && fs.existsSync(okProject));

  // 显式 full-access（不隔离档，用户已知情）不拦——与既有 carve-out 的产品语义保持一致；
  // 留这条断言是为了让「例外被谁悄悄放大/收紧」都显形。
  const faTarget = path.join(userData, 'hooks.json');
  const r3 = await exec.runWriteTool('writeFile', { path: faTarget, content: '{}', cwd: project, sandboxPolicy: 'full-access', approvalMode: 'auto-safe' });
  check('full-access 档放行（显式不隔离语义）', r3 && r3.ok === true);

  Module._load = origLoad;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  // 用 exitCode 而不是 process.exit：本套件后面还有 catch 兜底语句，
  // 审计脚本 audit-exit-following 会把「可能以 0 退出且之后还有代码」判为风险（确有其理）。
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[FAIL] 套件异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
