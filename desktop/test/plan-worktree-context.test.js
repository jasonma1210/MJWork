// 批次 D 回归门禁：Plan 模式 / Worktree / 上下文治理 / Diff 三级还原
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../renderer/src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

// ── T3-2 i18n 适配 helper ──
// 组件源码里的中文 UI 文案已抽取到 zh-CN 语言包，断言改为两段式：
// ① 文案值存在于 zh-CN/<mod>.json（递归深搜）；② 组件源码引用了对应 key（t / tGlobal）
const ZH_DIR = path.join(SRC, 'i18n', 'locales', 'zh-CN');
function zhKeys(mod, substr) {
  const j = JSON.parse(fs.readFileSync(path.join(ZH_DIR, mod + '.json'), 'utf8'));
  const hits = [];
  (function walk(o, prefix) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') { if (v.includes(substr)) hits.push(prefix + k); }
      else if (v && typeof v === 'object') walk(v, prefix + k + '.');
    }
  })(j, '');
  return hits;
}
function refsKey(src, mod, keys) {
  return keys.some((k) => new RegExp(`t(Global)?\\(['"\`]${mod}\\.${k.replace(/\./g, '\\.')}['"\`]`).test(src));
}
function assertI18nCopy(src, mod, substr, msg) {
  const keys = zhKeys(mod, substr);
  assert.ok(keys.length > 0, `${msg}（zh-CN/${mod}.json 中找不到文案「${substr}」）`);
  assert.ok(refsKey(src, mod, keys), `${msg}（组件未引用「${substr}」对应 key：${keys.join(', ')}）`);
}
const chat = read('components/ChatArea.jsx');
// T2-2：运行流程（沙箱策略/worktree 创建/压缩/agentFilesOf）已拆出 hooks/useAgentRun.ts
const runHook = read('hooks/useAgentRun.ts');
const core = fs.readFileSync(path.join(__dirname, '../agent-core/index.js'), 'utf8');
const diffPanel = read('components/DiffReviewPanel.jsx');
const mainSrc = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

/** 从 startIdx 处的开括号起，返回配对闭括号的下标（跳过字符串/模板串/注释里的括号）。 */
function matchBracket(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === quote) break; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ── D1 Plan 模式 ──
// V02（2026-10-16）：plan 过滤从 5 写工具黑名单升级为只读白名单（shell/code_exec/MCP/
// browser/chrome/orchestrate 全部纳入），白名单名单与运行时守卫见 r1-plan-allowlist.test.mjs 的
// 行为断言；本断言随契约更新为白名单符号。
check('Plan 模式在引擎层只保留只读白名单', () => {
  assert.match(core, /PLAN_MODE_ALLOWED/);
  for (const t of ['write_file', 'edit_file', 'apply_patch', 'git_commit', 'git_add', 'shell', 'code_exec', 'install_plugin', 'orchestrate_task']) {
    assert.ok(!new RegExp(`PLAN_MODE_ALLOWED[\\s\\S]{0,1200}'${t}'`).test(core.slice(core.indexOf('PLAN_MODE_ALLOWED'))), `效果类工具 ${t} 不得进入白名单`);
  }
  for (const t of ['read_file', 'grep', 'git_status', 'todo_write', 'spawn_subagent']) {
    assert.ok(core.includes(`'${t}'`), `只读工具 ${t} 应在白名单中`);
  }
  assert.match(core, /allTools = allTools\.filter\(\(t\) => PLAN_MODE_ALLOWED/);
});

check('Plan 模式附加系统提示约束', () => {
  assert.match(core, /规划模式/);
  assert.match(core, /等待用户确认/);
});

check('runAgent 接受 planMode 参数', () => {
  assert.match(core, /planMode = false/);
});

check('ChatArea 规划模式/未选项目强制沙箱只读（双保险 + fail-safe）', () => {
  assert.match(runHook, /planMode \|\| noProject \? 'read-only'/); // P0-B：planMode 或无项目均强制只读
  assert.match(runHook, /const noProject = /);
  assert.match(chat, /规划模式/);
  assert.match(chat, /enablePlanMode/);
});

// ── D2 Worktree ──
check('worktree 模块存在且 IPC 已注册', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../main/worktree.js')));
  // T2-1：worktree IPC 已拆出 main/ipc/project.js，断言随实现走
  const projectSrc = fs.readFileSync(path.join(__dirname, '../main/ipc/project.js'), 'utf8');
  for (const ch of ['worktree:create', 'worktree:list', 'worktree:promote', 'worktree:sync', 'worktree:remove']) {
    assert.ok(projectSrc.includes(`ipcMain.handle('${ch}'`), `缺少 IPC ${ch}`);
    assert.ok(preload.includes(ch.split(':')[1].replace(/^/, (m) => m)) || preload.includes(ch), `preload 未暴露 ${ch}`);
  }
});

check('worktree 存放于用户级目录且有上限保护', () => {
  const wt = fs.readFileSync(path.join(__dirname, '../main/worktree.js'), 'utf8');
  assert.match(wt, /\.mjcode', 'worktrees'/);
  assert.match(wt, /DEFAULT_LIMIT = 8/);
  assert.match(wt, /无法使用隔离工作区/, '非 Git 仓库需给出中文提示');
});

// A10（窗口外扩守卫）：syncToLocal 抽取窗口是 [函数名, 文件尾)，断言只查尾部 token 出现，
// 项被挪到函数外/尾部注释就静默绿。这里把窗口锁成 syncToLocal 自己的函数体（括号配对），
// 断言 listWorktrees(worktreePath) 与「未提交改动」兜底真在函数体内。
check('syncToLocal 窗口锁在其函数体内（listWorktrees 调用 + 未提交改动 兜底不得被挪到函数外/尾部）', () => {
  const wt = fs.readFileSync(path.join(__dirname, '../main/worktree.js'), 'utf8');
  const fnStart = wt.indexOf('async function syncToLocal');
  assert.ok(fnStart > 0, 'worktree.js 找不到 async function syncToLocal');
  const openBrace = wt.indexOf('{', fnStart);
  const close = matchBracket(wt, openBrace);
  assert.ok(close > openBrace, 'syncToLocal 函数体括号未配对（窗口吃到文件尾了？）');
  const body = wt.slice(openBrace, close + 1);
  assert.ok(/listWorktrees\(worktreePath\)/.test(body), 'syncToLocal 函数体内缺少 listWorktrees(worktreePath)（可能被挪到函数外/尾部）');
  assert.ok(/未提交改动/.test(body), 'syncToLocal 函数体内缺少「未提交改动」兜底（可能被挪到函数外/尾部）');
});

check('syncToLocal 不在 worktree 内解析主检出目录', () => {
  const wt = fs.readFileSync(path.join(__dirname, '../main/worktree.js'), 'utf8');
  const fn = wt.slice(wt.indexOf('async function syncToLocal'));
  assert.match(fn, /listWorktrees\(worktreePath\)/, '必须从 worktree list 取主检出目录');
  assert.match(fn, /未提交改动/, '主目录脏时必须 fail-closed');
});

check('Composer 提供本地/隔离工作区切换', () => {
  const cc = read('components/ComposerControls.jsx');
  // T3-2 i18n：顶层常量 MODE_OPTIONS 会冻结求值结果，改为渲染期调用的 getModeOptions()
  assert.match(cc, /getModeOptions/);
  assert.match(cc, /value: 'worktree'/);
  assert.match(cc, /onModeChange/);
});

check('隔离模式下实际执行目录切到 worktree 副本', () => {
  assert.match(chat, /const cwd = \(runMode === 'worktree' && worktree\?\.path\)/);
  assert.match(runHook, /window\.mjcode\.createWorktree/);
});

// ── D3 上下文治理 ──
check('上下文用量圆环组件存在', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/ContextRing.jsx')));
  const ring = read('components/ContextRing.jsx');
  assert.match(ring, /上下文用量/);
  assert.match(ring, /AUTO_COMPACT_RATIO/);
});

check('token 估算与压缩函数已从引擎导出', () => {
  assert.match(core, /export function estimateTokens/);
  assert.match(core, /export function estimateMessagesTokens/);
  assert.match(core, /export async function compactHistory/);
});

check('/compact 已接到实际压缩', () => {
  assert.match(runHook, /async function compactContext/);
  // 2026-10-22（P0-4）：实现搬到 lib/compactSession，且**必须**用运行用模型（含 context_window）
  // ——此前传 selectedModel 会让引擎回落 4096 窗口，把长会话裁到 15% 再覆盖数据库。
  assert.match(runHook, /await compactSession\(\{/, 'hook 必须真的调用压缩实现（搬走不等于断开）');
  const compactLib = read('lib/compactSession.ts');
  assert.match(compactLib, /compactHistory\(convo, runModel, chat, \{ force: true \}\)/,
    '压缩必须传 runModel（含窗口）且强制生效');
  assert.match(compactLib, /const runModel = buildRunModel\(model\)/, '窗口口径统一走 buildRunModel');
});

// ── D4 Diff 三级还原 ──
check('Diff 解析已按 hunk 拆分', () => {
  assert.match(diffPanel, /hunks/);
  assert.match(diffPanel, /line\.startsWith\('@@'\)/);
  assert.match(diffPanel, /function hunkPatch/);
});

check('hunk 级还原走 git apply --reverse', () => {
  // 2026-10-17：hunk 级 IPC 已从 exec.js 拆到 main/ipc/gitHunks.js（exec.js 顶到 800 行门禁），
  // 断言随实现走——守护目标不变：拒绝必须走 `--reverse`，接受必须走 `--cached`。
  const hunkSrc = fs.readFileSync(path.join(__dirname, '../main/ipc/gitHunks.js'), 'utf8');
  assert.match(hunkSrc, /ipcMain\.handle\('tool:gitApplyHunk'/);
  assert.match(hunkSrc, /gitApplyStdin\(\['--reverse'/);
  assert.match(hunkSrc, /gitApplyStdin\(\['--cached'/);
  assert.match(preload, /gitApplyHunk/);
  assert.match(preload, /gitApplyHunkCached/);
  // T3-2 i18n：「还原此块」按钮文案已抽取到 zh-CN/diff.json（revertHunk），改为两段式验证
  assertI18nCopy(diffPanel, 'diff', '还原此块', 'Diff 面板缺少 hunk 级还原按钮文案');
  assert.match(diffPanel, /rejectHunk/);
  assert.match(diffPanel, /acceptHunk/, 'Diff 面板缺少 hunk 级接受实现');
});

check('上一轮筛选只看 Agent 改动的文件', () => {
  assert.match(diffPanel, /agentFiles = \[\]/);
  assert.match(diffPanel, /lastTurnOnly/);
  assert.match(diffPanel, /上一轮/);
  assert.match(runHook, /agentFilesOf/);
  assert.match(chat, /onAgentFilesChange/);
});

console.log(`\nPASS：${pass}/${total} 项通过`);