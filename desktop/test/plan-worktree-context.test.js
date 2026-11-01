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
  // 上限值不再钉死字面量（对齐 WorkBuddy 的 50）：这里只守「有上限」，具体数值的一致性
  // 由下面「上限口径两侧一致」那条断言负责（main 与渲染层必须相等）
  assert.match(wt, /const DEFAULT_LIMIT = \d+/);
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

check('Worktree 用勾选框而不是开关（对齐 WorkBuddy 的 role=checkbox）', () => {
  const row = read('components/ComposerWorkspaceRow.tsx');
  // 语义差别是实的：勾选框 = 「本次任务带不带这个选项」，开关键 = 「长期偏好开不开」。
  // WB 的实现是 role="checkbox" + 方形勾选框，这里对齐它，原语收在 ui/Checkbox（不进裸 button 棘轮）。
  assert.match(row, /Checkbox/);
  assert.match(row, /label=\{t\('worktree\.enableHint'\)\}/, '勾选框的可访问名/提示必须是 enableHint（讲清「基线分支 + 不动主目录」）');
  assert.match(row, /onChange=\{\(next\) => onToggleWorktree\?\.\(next\)\}/);
  const checkbox = read('components/ui/Checkbox.tsx');
  assert.match(checkbox, /role="checkbox"/);
  assert.match(checkbox, /aria-checked=\{checked\}/);
  // 旧的 Switch 形态必须退场：两个都留就是两个入口对同一个状态。
  // 判 import 而不是判全文——注释里会提到「这里刻意不用 ui/Switch」
  assert.ok(!/from '\.\/ui\/Switch'/.test(row), '旧 Switch 形态仍在（import 未清）');
});

check('分支选择器：选分支 ≠ 切分支（三道通道 + 只写选中态）', () => {
  const projectSrc = fs.readFileSync(path.join(__dirname, '../main/ipc/project.js'), 'utf8');
  for (const ch of ['git:branches', 'git:refreshBranches', 'git:worktreeStatus', 'git:checkoutBranch']) {
    assert.ok(projectSrc.includes(`ipcMain.handle('${ch}'`), `缺少 IPC ${ch}`);
  }
  for (const m of ['listBranches', 'refreshBranches', 'worktreeStatus', 'checkoutBranch']) {
    assert.ok(preload.includes(`${m}: (payload) => ipcRenderer.invoke(`), `preload 未暴露 ${m}`);
  }
  const picker = read('components/GitBranchPicker.tsx');
  assert.match(picker, /window\.mjcode\?\.listBranches\?\.\(/);
  assert.match(picker, /window\.mjcode\?\.refreshBranches\?\.\(/);
  // 选择器里**不得**出现 checkout：切换是发送前确认卡的事（这是本轮最重要的语义）
  assert.ok(!picker.includes('checkoutBranch'), '选择器里出现了 checkoutBranch：选分支又变回「点了就切」');
  assert.match(picker, /onSelect\(/, '选中必须走 onSelect（只记基线）');
});

check('发送前才切分支：确认卡 + 脏三选一 + 只在没勾 Worktree 时动主目录', () => {
  // 三段必须同时在：① 读脏状态 ② 弹确认卡 ③ 勾了 Worktree 就跳过切换（副本从选中分支建）
  assert.match(runHook, /\.worktreeStatus\?\.\(/, '发送前必须读脏状态');
  assert.match(runHook, /askBranchSwitch\(/, '必须经确认卡，不能静默切换');
  assert.match(runHook, /if \(runMode === 'worktree'\) return true;/, '勾了 Worktree 不得再切主目录');
  assert.match(runHook, /dirtyPolicy: ans\.policy/, '三选一的结论必须真的传给主进程');
  assert.match(runHook, /GIT_IDENTITY_MISSING/, '身份缺失要给专门提示，不能并进「切换失败」');
  const dialog = read('components/BranchSwitchDialog.tsx');
  for (const k of ['worktree.branchSwitch.dirty.commit', 'worktree.branchSwitch.dirty.stash', 'worktree.branchSwitch.dirty.discard']) {
    assert.ok(dialog.includes(k), `确认卡缺少脏工作区处置项：${k}`);
  }
});

check('隔离工作区「发送时」创建且基线=选中分支（不是勾选时、也不是当前分支）', () => {
  // 勾选时建会用错基线（用户可以先勾再选分支），所以创建点必须在 doSend 内、executionRoot 之前
  const doSend = runHook.slice(runHook.indexOf('async function doSend'));
  const ensureAt = doSend.indexOf('ensureWorktree(effectiveProject');
  const rootAt = doSend.indexOf('const executionRoot =');
  assert.ok(ensureAt > 0, 'doSend 里没有创建副本的调用');
  assert.ok(rootAt > ensureAt, '副本必须在解析执行根之前建好（否则本轮会跑在项目目录）');
  assert.match(runHook, /base: baseBranchOf\(proj\)/, '创建副本必须带基线分支');
  assert.match(runHook, /selectedBranch \|\| currentBranch \|\| proj\?\.branch/, '基线取值顺序：选中 > 当前 > 项目探测');
  const projectSrc = fs.readFileSync(path.join(__dirname, '../main/ipc/project.js'), 'utf8');
  assert.match(projectSrc, /worktree\.createWorktree\(projectPath, taskTitle, base\)/, 'IPC 必须把 base 转交给 worktree 模块');
  const wt = fs.readFileSync(path.join(__dirname, '../main/worktree.js'), 'utf8');
  assert.match(wt, /async function createWorktree\(projectPath, taskTitle = 'task', baseBranch = ''\)/);
  assert.match(wt, /分支不存在：\$\{baseBranch\}/, '基线必须在白名单里（否则 commit-ish 也能当基线）');
});

check('副本创建失败回退为普通任务（不是把消息拦下来）', () => {
  const ensure = runHook.slice(runHook.indexOf('async function ensureWorktree'));
  assert.match(ensure, /setRunMode\('local'\)/, '失败必须落回 local（否则界面说隔离、实际跑在主目录）');
  assert.match(ensure, /worktree\.createFailedFallback/, '失败要有「已回退为普通任务」的说明（WB 同款）');
});

check('隔离模式下实际执行目录切到 worktree 副本', () => {
  assert.match(chat, /const cwd = \(runMode === 'worktree' && worktree\?\.path\)/);
  // F-005（2026-10-30）：签名补类型后，桥调用改走「整桥别名」形式（const mj = window.mjcode → mj?.createWorktree?.(...)），
  // 因为 test/bridge-parity.test.mjs 只认别名形式、看不穿函数包装。断言意图不变：**确实调用了 createWorktree 桥方法**
  // （`\.createWorktree` + 调用括号；别名指向真桥方法由 bridge-parity 保证）。
  assert.match(runHook, /\.createWorktree\??\.?\(/);
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

check('上限口径两侧一致：main 的 DEFAULT_LIMIT === 渲染层 WORKTREE_LIMIT，且 WARN < LIMIT', () => {
  // 主进程不能 import 渲染层 TS，所以这两个数字天然会漂。漂了的后果是「渲染层禁用发送，
  // 后端却还能建」或反过来——两边各自看起来都对，合起来是错的。
  const wt = fs.readFileSync(path.join(__dirname, '../main/worktree.js'), 'utf8');
  const constants = fs.readFileSync(path.join(SRC, 'constants/worktree.ts'), 'utf8');
  const mainLimit = Number((wt.match(/const DEFAULT_LIMIT = (\d+)/) || [])[1]);
  const uiLimit = Number((constants.match(/WORKTREE_LIMIT = (\d+)/) || [])[1]);
  const warnAt = Number((constants.match(/WORKTREE_WARN_AT = (\d+)/) || [])[1]);
  assert.ok(mainLimit > 0 && uiLimit > 0 && warnAt > 0, '有一个值没解析出来（改名了？）');
  assert.equal(mainLimit, uiLimit, `上限不一致：main=${mainLimit} / 渲染层=${uiLimit}`);
  assert.ok(warnAt < uiLimit, `警告阈值必须小于上限：warn=${warnAt} limit=${uiLimit}`);
  // 分支渲染上限沿用 WB 实测 80，选择器必须引用常量而不是自带一个字面量
  assert.match(read('components/GitBranchPicker.tsx'), /const RENDER_LIMIT = BRANCH_RENDER_LIMIT/);
});

check('达上限时的三个装置都在：提示 / 清理弹窗 / 发送禁用', () => {
  const chat = read('components/ChatArea.jsx');
  assert.match(chat, /countWorktrees\?\.\(/, '必须查副本数（否则上限判定没有数据源）');
  assert.match(chat, /WORKTREE_WARN_AT/, '缺警告阈值的使用点');
  assert.match(chat, /WORKTREE_LIMIT/, '缺上限的使用点');
  assert.match(chat, /<WorktreeCleanupDialog/, '清理弹窗未挂载');
  const preloadSrc = preload;
  assert.match(preloadSrc, /countWorktrees: \(payload\) => ipcRenderer\.invoke\('worktree:count'/, 'preload 未暴露 countWorktrees');
  assert.match(preloadSrc, /cleanupWorktrees: \(payload\) => ipcRenderer\.invoke\('worktree:cleanup'/, 'preload 未暴露 cleanupWorktrees');
  const dialog = read('components/WorktreeCleanupDialog.tsx');
  for (const k of ['worktree.cleanup.title', 'worktree.cleanup.description', 'worktree.cleanup.scopePrefix', 'worktree.cleanup.scopeSuffix']) {
    assert.ok(dialog.includes(k), `清理弹窗缺少文案 ${k}`);
  }
  assert.match(dialog, /CLEANUP_DAYS/, '天数档位必须来自 constants（7/15/30），不能就地写字面量');
  assert.match(read('components/Composer.tsx'), /worktreeBlocked/, '发送键必须受上限拦截');
  assert.match(runHook, /worktreeCount >= WORKTREE_LIMIT/, '发送流程里要再兜一层（键盘/队列旁路）');
});

check('副本分支：显示去前缀、复制完整名', () => {
  const bar = read('components/WorktreeBar.jsx');
  assert.match(bar, /displayBranchName/, '展示名必须去掉 mjcode/ 前缀（WB 的 getWorktreeBranchDisplayName 同义）');
  assert.match(bar, /clipboard\.writeText\(worktree\.branch\)/, '复制的必须是**完整**分支名（带前缀）');
  assert.match(bar, /worktree\.branchLabel\.copy/, '复制按钮要有可访问名');
});

check('非 Git 仓库：分支 chip 置灰并给「初始化 Git 仓库」提示（不弹空列表）', () => {
  const picker = read('components/GitBranchPicker.tsx');
  assert.match(picker, /disabled=\{locked \|\| !isRepo\}/);
  assert.match(picker, /worktree\.initGitHint/);
  // 挂载即探测：否则用户要先点开才知道「这里不是仓库」，chip 会先显示成可用
  assert.match(picker, /probedRef\.current === cwd/);
});

check('隔离态从 thread.cwd 派生（切会话不串台、重启不失忆）', () => {
  const chat = read('components/ChatArea.jsx');
  // 判据：消费方的依赖必须是会话，而不是项目——按项目派生正是「同项目两个会话共用一个副本」的根因
  const derive = chat.slice(chat.indexOf('隔离态从 thread.cwd'));
  assert.ok(derive.length > 0, '找不到派生段（被删了？）');
  // 依赖是「会话 id + 会话 cwd」这两个值（用局部常量是为了过 exhaustive-deps，语义不变）
  assert.match(derive, /const threadCwdForDerive = thread\?\.cwd \|\| '';/, '派生必须读 thread.cwd');
  assert.match(derive, /const threadIdForDerive = thread\?\.id;/, '派生必须读 thread.id');
  assert.match(derive, /\}, \[threadIdForDerive, threadCwdForDerive\]\)/, '派生依赖必须是会话维度的两个值');
  assert.ok(!/\}, \[project\?\.path\]\)/.test(derive.slice(0, 2000)), '派生不得只依赖项目路径');
  assert.match(derive, /window\.mjcode\?\.describeWorktree\?\.\(/, '必须问主进程「这是不是我方副本」');
  // 三种形态都要有明确落点：存在→恢复隔离；已被清理→回 local 并提示；普通目录→local
  assert.match(derive, /setRunMode\('worktree'\)/);
  assert.match(derive, /setCopyMissing\(threadCwd\)/, '副本已清理必须留下可见状态，不能静默降级');
  // 恢复横幅 + 一键指回项目目录
  assert.match(chat, /worktree\.copyMissing/, '缺「副本已被清理」的说明');
  assert.match(chat, /localSetThreadCwd\?\.\(/, '缺把执行根指回项目目录的通道');
  assert.match(chat, /worktree\.useProjectDir/, '缺一键恢复入口');
  assert.ok(preload.includes("localSetThreadCwd: (payload) => ipcRenderer.invoke('local:threads/set-cwd'"),
    'preload 未暴露 localSetThreadCwd');
  // 主进程侧：只接受真实存在的目录（写不存在 = 换个死指针）
  const store = fs.readFileSync(path.join(__dirname, '../main/store/localStore.js'), 'utf8');
  assert.match(store, /updateThreadCwd\(threadId, cwd\)/);
  assert.match(store, /fs\.existsSync\(next\)/, '必须校验目录存在');
});

check('清理联动：默认不归档会话，勾选后才归档且跳过当前会话', () => {
  const dialog = read('components/WorktreeCleanupDialog.tsx');
  // 默认 false 是产品决定（副本是缓存、对话是资产）：WB 默认删，本仓有意不同
  assert.match(dialog, /useState\(false\);/, '该开关必须默认关闭');
  assert.match(dialog, /deleteThreads/, '弹窗要能把这个选择传出去');
  const chat = read('components/ChatArea.jsx');
  const seg = chat.slice(chat.indexOf('async function cleanupWorktrees'));
  assert.ok(seg.length > 0, '找不到 cleanupWorktrees');
  assert.match(seg, /if \(deleteThreads\)/, '必须由开关控制，不能无条件归档');
  assert.match(seg, /String\(t\.id\) === String\(thread\?\.id\)\) continue/, '不得归档用户正在看的会话');
  assert.match(seg, /api\.deleteThread\(t\.id\)/, '归档要走既有语义（deleteThread = 归档，可恢复）');
  assert.match(seg, /onThreadsChanged\?\.\(\),?/, '归档后必须刷新侧栏');
});

check('本轮执行根写回会话：不写回就会被旧副本路径拽回去', () => {
  // 场景：用户在副本会话里取消勾选 → 本轮按主目录跑。若 thread.cwd 不跟着改，
  // 下次打开这个会话时「从 thread.cwd 派生」又会把它判成隔离态（说一套跑一套）。
  const seg = runHook.slice(runHook.indexOf('const executionRoot ='));
  assert.match(seg, /localSetThreadCwd\?\.\(/, '缺执行根写回');
  assert.match(seg, /threadId: thread\.id/, '写回要带会话 id');
  assert.match(seg, /!runWorktree\?\.path && worktree\?\.path/, '只在「此前在副本、本轮不在」时写，避免每轮无谓 IPC');
});

console.log(`\nPASS：${pass}/${total} 项通过`);