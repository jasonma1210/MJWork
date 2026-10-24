// 阻断 B1 / 缺陷 D1 回归门禁：同一张工具表被交互式与无人值守通道共用，参数必须由**显式入参**决定
//
// 事故（tester 对照实测，同 runAgent/同脚本，只换工具表）：
//   sudo 命令：交互式 3025ms 弹卡 → 改成无条件 unattended 标记后 **6ms** 被「无人值守…没有人在场」拒绝；
//   越界写：交互式 3016ms 弹卡 → **6ms** 硬拒 outsideWhitelist。
//   人就在屏幕前也无法批准 —— 这比原缺陷更严重（原缺陷是定时任务跑不出文件，这个是所有人不能用审批）。
// 根因：main.js 的交互式 createToolHandlers 直接 spread 了同一张表，而"无人值守"被写死在表里。
//
// 本文件用**行为断言**（不是只读源码）锁两件事：
//   ① 交互式表：shell 不带 unattended 标记、写工具不带 requireApproval:false（审批能力保留）；
//      无人值守表：两者相反。
//   ② 缺陷 D1：contextCwd 只兜底读类与 git 类；写工具与 shell 的入参里绝不出现它
//      （写必须落产出目录、shell 不能被 cd 到项目目录里写脏）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { scheduledToolHandlers } = require(path.join(ROOT, 'main', 'scheduledTools.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

// 记录每个工具收到的入参（实现用 spy 替换，只关心"宿主往实现里塞了什么"）
const seen = [];
const spy = (name) => (args) => { seen.push({ name, args }); return { ok: true }; };
function makeDeps() {
  seen.length = 0;
  return {
    scheduledAgentChat: spy('chat'),
    webTools: { webSearch: spy('webSearch'), webFetch: spy('webFetch') },
    toolShell: spy('shell'),
    toolReadFile: spy('readFile'),
    runWriteTool: (tool, args) => { seen.push({ name: tool, args }); return { ok: true }; },
    toolListDir: spy('listDir'), toolGrep: spy('grep'), toolGlob: spy('glob'),
    toolGitStatus: spy('gitStatus'), toolGitDiff: spy('gitDiff'), toolGitLog: spy('gitLog'),
    toolGitBranch: spy('gitBranch'), toolGitCommit: spy('gitCommit'), toolGitAdd: spy('gitAdd'),
    callMcpTool: spy('mcpCallTool'),
    prTools: { prList: spy('prList'), prView: spy('prView'), prDiff: spy('prDiff'), prReview: spy('prReview'), prComment: spy('prComment') },
  };
}
const last = () => seen[seen.length - 1];

// ── ① 无人值守必须是显式入参（B1）──
check('交互式表：shell 不带 unattended 标记（人就在屏幕前，必须还能弹卡）', () => {
  const h = scheduledToolHandlers(makeDeps());
  h.shell({ command: 'sudo ls', cwd: '/tmp' });
  assert.equal(last().name, 'shell');
  assert.equal('unattended' in last().args, false, `交互式 shell 被塞了 unattended：${JSON.stringify(last().args)}`);
});

check('无人值守表：shell 带 unattended 标记（审批终结器据此立即 deny）', () => {
  const h = scheduledToolHandlers({ ...makeDeps(), unattended: true });
  h.shell({ command: 'sudo ls', cwd: '/tmp' });
  assert.equal(last().args.unattended, true);
});

check('交互式表：三个写工具都不带 requireApproval:false（越界写仍能弹卡批准）', () => {
  const h = scheduledToolHandlers(makeDeps());
  for (const t of ['writeFile', 'editFile', 'applyPatch']) {
    h[t]({ path: '/tmp/a.md', content: 'x', cwd: '/tmp' });
    assert.equal('requireApproval' in last().args, false, `交互式 ${t} 被塞了 requireApproval：${JSON.stringify(last().args)}`);
  }
});

check('无人值守表：三个写工具强制 requireApproval:false（模型自传 true 也覆盖不掉）', () => {
  const h = scheduledToolHandlers({ ...makeDeps(), unattended: true });
  for (const t of ['writeFile', 'editFile', 'applyPatch']) {
    h[t]({ path: '/tmp/a.md', content: 'x', cwd: '/tmp', requireApproval: true });
    assert.equal(last().args.requireApproval, false, `${t} 未被强制 requireApproval:false`);
  }
});

// ── ② contextCwd 只给读类与 git 类（D1）──
const CTX = '/Users/x/proj';
const CTX_TOOLS = ['gitStatus', 'gitDiff', 'gitLog', 'gitBranch', 'gitCommit', 'gitAdd', 'readFile', 'listDir', 'grep', 'glob'];

check('读类与 git 类：模型没给 cwd 时兜底成 contextCwd（否则 git 会在产出目录里 fatal）', () => {
  const h = scheduledToolHandlers({ ...makeDeps(), unattended: true, contextCwd: CTX });
  for (const t of CTX_TOOLS) {
    h[t]({});
    assert.equal(last().args.cwd, CTX, `${t} 没拿到 contextCwd（收到 ${JSON.stringify(last().args)}）`);
  }
});

check('读类与 git 类：contextCwd 优先于入参 cwd（agent-core 会无条件注入宿主 cwd，反向就会让它变死代码）', () => {
  const h = scheduledToolHandlers({ ...makeDeps(), unattended: true, contextCwd: CTX });
  h.gitStatus({ cwd: '/tmp/host-cwd-injected-by-agent-core' });
  assert.equal(last().args.cwd, CTX, 'contextCwd 被入参 cwd 覆盖了（真实链路会让 git 跑在产出目录）');
});

check('contextCwd 为空时回落入参 cwd（任务没有项目上下文时行为不变）', () => {
  const h = scheduledToolHandlers({ ...makeDeps(), unattended: true });
  h.gitStatus({ cwd: '/tmp/whatever' });
  assert.equal(last().args.cwd, '/tmp/whatever');
});

check('写工具与 shell：入参里绝不出现 contextCwd（写必须落产出目录、shell 不能被 cd 到项目）', () => {
  const h = scheduledToolHandlers({ ...makeDeps(), unattended: true, contextCwd: CTX });
  for (const t of ['writeFile', 'editFile', 'applyPatch']) {
    h[t]({ path: '/tmp/a.md', content: 'x' });
    assert.equal('cwd' in last().args, false, `${t} 被注入了 cwd：${JSON.stringify(last().args)}`);
  }
  h.shell({ command: 'ls' });
  assert.equal('cwd' in last().args, false, `shell 被注入了 cwd：${JSON.stringify(last().args)}`);
});

check('交互式表不传 contextCwd → 读类/git 类入参保持原样（不凭空造 cwd）', () => {
  const h = scheduledToolHandlers(makeDeps());
  h.gitStatus({});
  assert.equal('cwd' in last().args, false);
});

// ── ③ 接线：三个调用点各自传什么 ──
check('main.js 接线：交互式不传、定时通道传 unattended+contextCwd、Worker 传 unattended+项目 cwd', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  assert.match(src, /\.\.\.scheduledToolHandlers\(\),\n/, '交互式 createToolHandlers 应调用 scheduledToolHandlers()（不传参数）');
  // FIX-P04（2026-10-24）：定时通道的实参多了 teamTools: schedCtx.teamTools（团队工具必须
  // 作为**入参**交给工厂才会展开成 team_* 键）。原断言把实参钉成「恰好两个键 + 立即闭括号」，
  // 属源码形状代理而非语义要求，故放宽括号位置；同时**收紧**一条：团队工具必须在这个调用里出现。
  // 没有把任何缺陷固化进预期——原先的写法（teamTools 当映射一级键）依然会判红（见
  // test/scheduled-team-tools.test.mjs 的专用断言）。
  assert.match(src, /scheduledToolHandlers\(\{\s*unattended: true, contextCwd: schedModel\.cwd[^}]*\}\)/, '定时通道未传 unattended/contextCwd');
  assert.match(src, /scheduledToolHandlers\(\{\s*unattended: true, contextCwd: schedModel\.cwd[^}]*teamTools: schedCtx\.teamTools[^}]*\}\)/, '定时通道未把团队工具交给工具表工厂（FIX-P04：否则模型看不到 team_*）');
  assert.match(src, /scheduledToolHandlers\(\{\s*unattended: true, contextCwd: cwd[\s\S]*?\}\)/, 'Worker 通道未传 unattended/contextCwd');
  const wp = fs.readFileSync(path.join(ROOT, 'main', 'workerPool.js'), 'utf8');
  assert.match(wp, /createToolHandlers\(\{\s*signal: controller\.signal, cwd: runCwd[\s\S]*?\}\)/, 'Worker 未把项目 cwd 传给工具表');
});

check('agent-core 工具 schema：scheduled_create 暴露 expects_file（模型才知道要判断语义）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agent-core', 'index.js'), 'utf8');
  assert.match(src, /expects_file: \{ type: 'boolean'/, 'schema 里没有 expects_file，模型无从传');
  assert.match(src, /这个任务是否需要产出文件/, 'schema 缺少「什么样的任务选 false」的说明');
});

console.log(`\nscheduled-tool-surfaces: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
