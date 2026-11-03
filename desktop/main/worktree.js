// Git Worktree 隔离工作区（对标 Codex 的 Worktree 模式）
// 目的：让 Agent 在独立副本上改代码，主项目目录不受影响，天然支持并行多任务
// 约束：路径全部以仓库根为基准解析；创建失败不残留；上限保护避免磁盘失控
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// 上限口径对齐 WorkBuddy（uU=50）；与 renderer/src/constants/worktree.ts 的 WORKTREE_LIMIT
// 必须相等，由 test/worktree-limit.test.mjs 读两边源码比对（主进程不能 import TS）
const DEFAULT_LIMIT = 50;
const BRANCH_PREFIX = 'mjcode/';
// 打包版 GUI 进程继承的 PATH 极简（/usr/bin:/bin:/usr/sbin:/sbin）。
// 与 main/tools/exec.js 同一口径注入完整 PATH：否则 Homebrew 装的 git（/opt/homebrew/bin）
// 在打包版里 ENOENT ⇒ 所有 worktree 能力静默不可用（开发版因继承终端 PATH 复现不了）。
const { shellEnv } = require('./tools/shellEnv');

function git(cwd, args, timeout = 20000, input = null) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: shellEnv() }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? error.message : null,
      });
    });
    // stdin 支持（P1 并行隔离：git apply - 从标准输入读补丁）
    if (input != null && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/** worktree 存放目录：用户级固定位置，避免污染项目目录 */
function worktreeRoot() {
  return path.join(os.homedir(), '.mjcode', 'worktrees');
}

async function isGitRepo(cwd) {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.stdout.trim() : null;
}

async function currentBranch(cwd) {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

/**
 * HEAD 的符号引用名（`main` / `master` …），不依赖「有没有提交」。
 *
 * 为什么不能只靠 currentBranch：**空仓库（git init 后还没有首个提交）**时
 * `git rev-parse --abbrev-ref HEAD` 直接 fatal（ambiguous argument 'HEAD'），
 * 于是「刚初始化好的仓库」会被读成「没有当前分支」，界面又回到「选不到分支」。
 * 本地 git 2.55 实测：`symbolic-ref --short HEAD` 在空仓库返回 `master`/`main`，可用。
 */
async function headSymbolicName(cwd) {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

/** 空仓库：HEAD 指向一个还不存在的分支（有 symbolic-ref，但 refs/heads 里没有任何 ref） */
async function isUnbornHead(cwd) {
  const sym = await headSymbolicName(cwd);
  if (!sym) return false; // detached 或不是仓库 —— 那不是一个「待提交」的空仓库
  const refs = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return refs.ok && refs.stdout.trim() === '';
}

/** 首个提交的说明：出现在用户仓库的 git log 里，用英文（与仓库日志纪律一致） */
const INIT_COMMIT_MESSAGE = 'chore: initialize repository';

/**
 * 初始化 Git 仓库（新建项目自动执行 / 用户在分支面板里显式点击）。
 *
 * 为什么需要它（2026-11-03 用户反馈 5「初始化 git 失败，卡死在选择分支上」）：
 * 本产品在 `~/Documents/.MJCoder` 下建的项目目录**只有 mkdir，没有 git init**，
 * 于是输入框的分支选择器永远拿不到分支，Worktree 也不可用 —— 而用户不知道要自己去终端补一步。
 *
 * 三条边界（都会踩到用户数据，缺一条就会出事故）：
 *   ① **不替用户暂存**：目录里已有 `git add` 过的内容时，`commit --allow-empty` 会把暂存区
 *      一起提交（"空提交"并不空）。所以先查 `diff --cached`，非空就只 return，不动。
 *   ② **身份缺失不算失败**：没有 user.name/email 时 commit 会失败，但仓库已经 init 好了；
 *      这里回报 `identityMissing` 让界面给出「去配身份」的指引，而不是整条动作失败。
 *   ③ **幂等**：已经是仓库（且已有提交）时什么都不做，只回报当前分支。
 *
 * @returns {{created:boolean, branch:string, committed:boolean, identityMissing:boolean,
 *            stagedPending:boolean, unborn:boolean}}
 */
async function initRepo(cwd, { initialCommit = true } = {}) {
  if (!cwd) throw new Error('缺少目录');
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  let created = false;
  if (!(inside.ok && inside.stdout.trim() === 'true')) {
    const r = await git(cwd, ['init'], 30000);
    if (!r.ok) throw new Error(`git init 失败：${(r.stderr || r.error || '').trim()}`);
    created = true;
    // 统一主分支名为 main：老版本 git 默认 master，而新仓库还没有提交，
    // 改 symbolic-ref 不会动任何已有引用（有提交的仓库不会走到这里）。
    const sym = await headSymbolicName(cwd);
    if (sym === 'master') await git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }

  let unborn = await isUnbornHead(cwd);
  let committed = false;
  let identityMissing = false;
  let stagedPending = false;

  if (initialCommit && unborn) {
    // 边界①：暂存区非空 ⇒ 不提交（否则等于替用户把内容提交了）
    const staged = await git(cwd, ['diff', '--cached', '--name-only']);
    stagedPending = staged.ok && staged.stdout.trim() !== '';
    if (!stagedPending) {
      const ident = await git(cwd, ['var', 'GIT_AUTHOR_IDENT']);
      if (!ident.ok) {
        // 边界②：身份缺失是**可预期状态**，不是异常 —— 仓库已建好，只是还没有分支
        identityMissing = true;
      } else {
        const c = await git(cwd, ['commit', '--allow-empty', '-m', INIT_COMMIT_MESSAGE], 30000);
        committed = c.ok;
        if (!c.ok) console.warn('[worktree] 首个空提交失败（仓库已初始化）：', (c.stderr || '').trim());
      }
    }
    unborn = await isUnbornHead(cwd);
  }

  const branch = (await currentBranch(cwd)) || (await headSymbolicName(cwd));
  return { created, branch, committed, identityMissing, stagedPending, unborn };
}

/** 列出已有 worktree（mainPath 对应主检出目录） */
async function listWorktrees(cwd, mainPath) {
  const r = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  return r.stdout.split(/\n(?=worktree )/).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const p = (lines.find((l) => l.startsWith('worktree ')) || '').slice('worktree '.length).trim();
    const br = (lines.find((l) => l.startsWith('branch ')) || '').slice('branch '.length).trim().replace('refs/heads/', '');
    return { path: p, branch: br, isMain: mainPath ? path.resolve(p) === path.resolve(mainPath) : false };
  });
}

/**
 * 创建隔离工作区
 * @param {string} projectPath 项目目录（须为 Git 仓库）
 * @param {string} taskTitle   任务标题，用于分支与目录命名
 * @param {string} [baseBranch] 以哪个分支为基线（缺省 = 主检出目录当前分支）
 *
 * baseBranch 为什么必须走白名单：它会被拼进 `worktree add -b <新分支> <目录> <基线>`，
 * 而基线位置接受任意 commit-ish（`--detach` 之类也能塞进来改语义）。用户能从选择器里点到的
 * 只可能是真实本地分支，故以 listBranches 的结果为准——传不存在的名字直接拒，不回落当前分支
 * （静默回落 = 用户以为基于 A 分支，实际基于 B，隔离副本从第一行代码起就是错的）。
 */
async function createWorktree(projectPath, taskTitle = 'task', baseBranch = '') {
  if (!projectPath) throw new Error('未选择项目');
  if (!(await isGitRepo(projectPath))) throw new Error('当前项目不是 Git 仓库，无法使用隔离工作区');

  const root = await repoRoot(projectPath);
  if (!root) throw new Error('无法定位 Git 仓库根目录');

  const existing = await listWorktrees(root, root);
  if (existing.filter((w) => !w.isMain).length >= DEFAULT_LIMIT) {
    throw new Error(`隔离工作区已达上限（${DEFAULT_LIMIT} 个），请先清理旧工作区`);
  }

  let base = (await currentBranch(root)) || 'HEAD';
  if (baseBranch) {
    // 白名单同时接受本地与远程全名（`origin/feat/x`）：worktree 的 base 位置接受任意
    // commit-ish，不拦就等于「说好基于某分支、实际基于一个游离提交」
    const { local, remote } = await listBranches(root);
    const knownBase = local.some((b) => b.name === baseBranch) || remote.some((b) => b.name === baseBranch);
    if (!knownBase) throw new Error(`分支不存在：${baseBranch}`);
    base = baseBranch;
  }

  const slug = String(taskTitle).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 32) || 'task';
  const stamp = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString(36).slice(-4)}`;
  const branch = `${BRANCH_PREFIX}${slug}-${stamp}`;
  const dir = path.join(worktreeRoot(), `${slug}-${stamp}`);

  await fsp.mkdir(worktreeRoot(), { recursive: true });
  const r = await git(root, ['worktree', 'add', '-b', branch, dir, base], 60000);
  if (!r.ok) throw new Error(`创建隔离工作区失败：${r.stderr.trim() || r.error}`);
  return { path: dir, branch, repoRoot: root, base };
}

/**
 * 工作区脏状态（分支切换确认卡的判据）
 *
 * 口径对齐 WorkBuddy 的 getWorktreeStatus：`status --porcelain --untracked-files=all`。
 * `--untracked-files=all` 不能省：默认的 normal 会把整个未跟踪**目录**折叠成一条 `?? dir/`，
 * 于是「新目录里有 3 个文件」和「空目录」在计数上没有区别，而这两者对「丢弃」的风险完全不同。
 */
async function worktreeStatus(cwd) {
  const r = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (!r.ok) return { isRepo: false, hasUncommittedChanges: false, changedFiles: 0, untrackedFiles: 0 };
  const lines = r.stdout.split('\n').filter((l) => l.trim());
  return {
    isRepo: true,
    hasUncommittedChanges: lines.length > 0,
    changedFiles: lines.length,
    untrackedFiles: lines.filter((l) => l.startsWith('?? ')).length,
  };
}

/**
 * 列出分支：本地 + 远程（分支选择器的数据面）
 *
 * 为什么不让渲染层解析 `git branch -a` 的文本：那是**给人看的**输出，前缀标记（`*`）、
 * 颜色、分页（core.pager）都会随环境变；取结构化 refname 才是稳定契约。
 * current 单独给字段而不是靠「列表里哪个带星号」——detached HEAD 时列表里根本没有当前项，
 * 用星号判断会把「游离头指针」误报成「没进仓库」。
 *
 * 远程分支单列一组（对齐 WorkBuddy 的 localBranches / remoteBranches 分组）：
 * 两者在「选中之后发生什么」上完全不同——本地分支是切过去，远程分支要**新建本地跟踪分支**。
 * 混在一个列表里，用户点中 `origin/main` 时无法预期自己的 HEAD 会变成什么。
 * 远程符号引用 `origin/HEAD` 过滤掉：它不是一个可以 checkout 的分支。
 */
async function listBranches(cwd) {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (!r.ok) return { isRepo: false, current: '', detached: false, local: [], remote: [] };
  const cur = await currentBranch(cwd);
  // currentBranch 在游离头指针时返回字面量 'HEAD'（git 的口径），此处翻译成「无当前分支」
  const detached = cur === 'HEAD';
  const current = detached ? '' : cur;
  const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  // 空仓库（已 git init、还没有任何提交）：refs/heads 为空但 HEAD 有符号引用。
  // 这一档必须与「没有分支」分开报，否则界面只能显示「未找到分支」——
  // 用户会以为自己初始化失败（真实原因是没有首个提交）。
  const unborn = names.length === 0 && (await isUnbornHead(cwd));
  // 当前分支置顶，其余保持 git 的字母序：用户最常点的就是「我当前在哪」
  names.sort((a, b) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)));
  const rr = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  const remote = (rr.ok ? rr.stdout.split('\n') : [])
    .map((s) => s.trim())
    .filter((n) => n && !n.endsWith('/HEAD'))
    .sort((a, b) => a.localeCompare(b));
  return {
    isRepo: true,
    current,
    detached,
    // 空仓库时 current 一定是空串（rev-parse 在无提交时不可用），分支名在 headSymbolicName 里
    unborn,
    unbornBranch: unborn ? await headSymbolicName(cwd) : '',
    local: names.map((n) => ({ name: n, current: n === current })),
    remote: remote.map((n) => ({ name: n, short: stripRemotePrefix(n) })),
  };
}

/** `origin/feat/x` → `feat/x`（本地跟踪分支名）；与 WorkBuddy 的 stripRemotePrefix 同义 */
function stripRemotePrefix(name) {
  const i = String(name).indexOf('/');
  return i >= 0 ? String(name).slice(i + 1) : String(name);
}

async function hasLocalBranch(cwd, name) {
  const r = await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
  return r.ok;
}

/** 提交身份缺失（对齐 WorkBuddy 的 GIT_IDENTITY_MISSING）：渲染层据此给「先配 user.name/email」的提示 */
const GIT_IDENTITY_MISSING = 'GIT_IDENTITY_MISSING';

function gitIdentityError(detail) {
  const err = new Error(`未配置 Git 提交身份：${detail}`);
  err.code = GIT_IDENTITY_MISSING;
  return err;
}

/**
 * 脏工作区在切换前的处置（对齐 WorkBuddy handleDirtyBeforeCheckout）
 *   abort   → 不处理，交由调用方返回 blockedByDirty（**不是**静默继续）
 *   commit  → `git var GIT_AUTHOR_IDENT` 先验证身份（缺身份时 commit 会在半途失败并留下
 *             已 add 的暂存区——那是「处置动作本身把工作区弄乱了」），再 add -A + commit
 *   stash   → `stash push -u`（含未跟踪文件；不含就等于把用户的草稿留在切换后的分支上）
 *   discard → reset --hard + clean -fd（不可撤销，UI 侧必须红字说明）
 */
async function handleDirtyBeforeCheckout(cwd, policy, fromBranch, toBranch) {
  if (policy === 'abort') return false;
  if (policy === 'commit') {
    const ident = await git(cwd, ['var', 'GIT_AUTHOR_IDENT']);
    if (!ident.ok) throw gitIdentityError((ident.stderr || '').trim() || 'git var GIT_AUTHOR_IDENT failed');
    const add = await git(cwd, ['add', '-A'], 60000);
    if (!add.ok) throw new Error(`暂存失败：${(add.stderr || '').trim()}`);
    const msg = `[Checkout-checkpoint] from ${fromBranch || 'HEAD'} to ${toBranch} (${new Date().toISOString().slice(11, 19)})`;
    const commit = await git(cwd, ['commit', '-m', msg], 60000);
    if (!commit.ok) throw new Error(`提交失败：${(commit.stderr || '').trim()}`);
    return true;
  }
  if (policy === 'stash') {
    const r = await git(cwd, ['stash', 'push', '-u', '-m', '[Checkout-autostash] before branch switch'], 60000);
    if (!r.ok) throw new Error(`暂存失败：${(r.stderr || '').trim()}`);
    return true;
  }
  // 其余（含非法值）一律按 discard 处理会把「拼错策略」变成删数据 ⇒ 显式只认 discard
  if (policy !== 'discard') throw new Error(`未知的脏工作区处置方式：${policy}`);
  const reset = await git(cwd, ['reset', '--hard', 'HEAD'], 60000);
  if (!reset.ok) throw new Error(`丢弃失败：${(reset.stderr || '').trim()}`);
  const clean = await git(cwd, ['clean', '-fd'], 60000);
  if (!clean.ok) throw new Error(`清理未跟踪文件失败：${(clean.stderr || '').trim()}`);
  return true;
}

/**
 * 切换主检出目录的分支（对齐 WorkBuddy 的 checkoutBranch）
 *
 * @param {string} branch 目标分支，可以是本地名，也可以是 `origin/xxx` 这种远程全名
 * @param {'abort'|'commit'|'stash'|'discard'} dirtyPolicy 脏工作区的处置方式
 * @returns {{switched:boolean,currentBranch:string,blockedByDirty?:boolean}}
 *
 * 三条边界（缺一条就可能改到用户的未提交文件）：
 *   ① **白名单来自 git 自己**：目标必须在 listBranches 的结果里，拒绝「拼出来」的名字。
 *      这既挡了注入形态（`--orphan`、`-f` 这类以 `-` 开头的伪分支），也不用自维护正则；
 *   ② 脏工作区不静默：policy=abort 时返回 blockedByDirty，由 UI 说「请先处理」；
 *   ③ 远程分支不直接 checkout：`git checkout origin/x` 会进游离头指针，必须建本地跟踪分支。
 */
async function checkoutBranch(cwd, branch, dirtyPolicy = 'abort') {
  const { isRepo, local, remote, current } = await listBranches(cwd);
  if (!isRepo) throw new Error('当前目录不是 Git 仓库，无法切换分支');
  const isLocalName = local.some((b) => b.name === branch);
  const isRemoteName = !isLocalName && remote.some((b) => b.name === branch);
  if (!isLocalName && !isRemoteName) throw new Error(`分支不存在：${branch}`);
  // 只有**远程全名**才去前缀：本地分支本身可能就叫 `feat/x`，无脑 slice('/') 会算成 `x`，
  // 于是「切到 feat/x」被误判成「已经在 x 上了」直接跳过（实测：checkpoint 消息里目标变成 pick）
  const target = isRemoteName ? stripRemotePrefix(branch) : branch;
  if (current && current === target) return { switched: false, currentBranch: current };

  const st = await worktreeStatus(cwd);
  if (st.hasUncommittedChanges) {
    const handled = await handleDirtyBeforeCheckout(cwd, dirtyPolicy, current, target);
    if (!handled) return { switched: false, currentBranch: current, blockedByDirty: true };
  }

  // 远程分支：本地已有同名分支就切，没有就 -b 出来并跟踪（否则 HEAD 会游离）
  if (isRemoteName) {
    const hasShort = await hasLocalBranch(cwd, target);
    const r = hasShort
      ? await git(cwd, ['checkout', target], 60000)
      : await git(cwd, ['checkout', '-b', target, '--track', branch], 60000);
    if (!r.ok) throw new Error(`切换分支失败：${(r.stderr || r.error || '').trim()}`);
    return { switched: true, currentBranch: await currentBranch(cwd) };
  }

  const r = await git(cwd, ['checkout', branch], 60000);
  if (!r.ok) throw new Error(`切换分支失败：${(r.stderr || r.error || '').trim()}`);
  return { switched: true, currentBranch: await currentBranch(cwd) };
}

/**
 * 拉取更新（分支选择器底部的「拉取更新」）
 *
 * 只 `fetch --prune`，**不 merge**（对齐 WorkBuddy 的 fetchBranches = fetchRemotes + 重列）。
 * 早先这里是 fetch + merge --ff-only：那会在用户点「拉取更新」时悄悄改工作区文件，
 * 而用户在这个界面上的意图只是「让我看到远端有哪些新分支」。合并是另一件事，
 * 该由用户在会话里显式要求（`git pull` 由 Agent 走审批通道执行）。
 */
async function refreshBranches(cwd) {
  const remotes = await git(cwd, ['remote']);
  if (!remotes.ok) throw new Error(`无法读取远端配置：${(remotes.stderr || remotes.error || '').trim()}`);
  // 纯本地仓库：没有可拉的东西，但仍要返回分支列表（刷新是「重读列表」的通用入口）
  if (!remotes.stdout.trim()) return { ...(await listBranches(cwd)), fetched: false, noRemote: true };
  const f = await git(cwd, ['fetch', '--prune'], 120000);
  if (!f.ok) throw new Error(`拉取远端失败：${(f.stderr || f.error || '').trim()}`);
  return { ...(await listBranches(cwd)), fetched: true };
}

/** 当前仓库的副本数量（不含主检出）——上限判据在渲染层：>=25 提示、>=50 拦截 */
async function countWorktrees(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return 0;
  const list = await listWorktrees(root, root);
  return list.filter((w) => !w.isMain).length;
}

/**
 * 按「闲置天数」清理副本（对齐 WorkBuddy 的 cleanupWorktrees）
 *
 * 三条判据逐条核对，缺一条就会删掉用户还没收口的东西：
 *   ① 目录 mtime 早于截止时间才算「闲置」（mtime 是副本最后一次被写的时间）；
 *   ② 工作区脏的一律跳过（未提交改动只能由用户自己在收口条上决定合并/提升/丢弃）；
 *   ③ 分支只删**自己的任务分支前缀**（mjcode/），别人的分支名撞上也不动。
 * 返回分项计数而不是一个数字：`skippedDirtyCount` 要能回答「为什么清了 3 个还剩 10 个」。
 */
async function cleanupWorktrees(cwd, { olderThanDays = 15 } = {}) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('无法定位 Git 仓库根目录');
  const cutoff = Date.now() - olderThanDays * 86400000;
  const out = {
    cleanedCount: 0, cleanedWorktreePaths: [], skippedDirtyCount: 0, skippedRecentCount: 0, failedCount: 0,
  };
  const list = await listWorktrees(root, root);
  for (const w of list.filter((x) => !x.isMain)) {
    try {
      const st = await fsp.stat(w.path).catch(() => null);
      if (!st) { out.failedCount += 1; continue; }
      if (st.mtimeMs > cutoff) { out.skippedRecentCount += 1; continue; }
      const dirty = await worktreeStatus(w.path);
      if (dirty.hasUncommittedChanges) { out.skippedDirtyCount += 1; continue; }
      await removeWorktree(w.path, false); // 不带 --force：脏的已在上一步跳过
      if (w.branch && w.branch.startsWith(BRANCH_PREFIX)) {
        await git(root, ['branch', '-D', w.branch], 30000);
      }
      out.cleanedCount += 1;
      out.cleanedWorktreePaths.push(w.path);
    } catch (e) {
      out.failedCount += 1;
      console.warn('[worktree] cleanup failed:', w.path, e && e.message);
    }
  }
  return out;
}

/**
 * 描述一个路径是不是「我方的隔离副本」（会话恢复与失效判定的数据面）
 *
 * 为什么要按**路径前缀**判而不是 `git worktree list`：会话里存的 cwd 可能已经被清理，
 * 那时没有任何 git 仓库可查（`git -C <不存在的目录>` 直接失败），于是「这是被清理的副本」
 * 与「这是别处的普通目录」在错误信息上长得一模一样。前缀判据不依赖目标是否存在。
 * 存在时再补 branch：界面要显示「这个会话在哪个副本分支上」，且不许猜。
 */
async function describeWorktree(targetPath) {
  const root = worktreeRoot();
  const target = path.resolve(String(targetPath || ''));
  const managed = target.startsWith(root + path.sep);
  if (!managed) return { managed: false, exists: false, branch: '', repoRoot: '' };
  const st = await fsp.stat(target).catch(() => null);
  if (!st || !st.isDirectory()) return { managed: true, exists: false, branch: '', repoRoot: '' };
  const branch = await currentBranch(target);
  // 主检出目录：`git worktree list` 的第一个条目（在副本里 rev-parse --show-toplevel 只会得到它自己）
  const list = await listWorktrees(target);
  return {
    managed: true,
    exists: true,
    branch: branch === 'HEAD' ? '' : branch,
    repoRoot: list[0]?.path || '',
  };
}

/** 收口方式一：把工作区转为正式分支（保留改动，用户自行 push / PR） */
async function promoteToBranch(worktreePath) {
  const r = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) throw new Error('无法读取工作区分支');
  const branch = r.stdout.trim();
  const renamed = `${branch.replace('mjcode/', 'mj/')}`;
  const rr = await git(worktreePath, ['branch', '-m', renamed]);
  if (!rr.ok) throw new Error(`重命名分支失败：${rr.stderr.trim()}`);
  return { branch: renamed };
}

/** 收口方式二：把工作区改动同步回主检出目录 */
async function syncToLocal(worktreePath) {
  // 注意：在 worktree 内执行 `rev-parse --show-toplevel` 得到的是 worktree 自身，
  // 真正的主检出目录必须从 `git worktree list` 取（第一个条目恒为主工作树）
  const list = await listWorktrees(worktreePath);
  const root = list[0]?.path;
  if (!root) throw new Error('无法定位主检出目录');
  const branch = (await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const target = `mjcode/sync-${Date.now().toString(36)}`;

  // 主目录当前分支不干净时直接拒绝，避免覆盖用户未提交的改动
  const status = await git(root, ['status', '--porcelain']);
  if (status.stdout.trim()) throw new Error('主检出目录存在未提交改动，无法自动同步，请先处理');

  await git(root, ['fetch', worktreePath, branch], 60000);
  const r = await git(root, ['branch', target, 'FETCH_HEAD']);
  if (!r.ok) throw new Error(`创建同步分支失败：${r.stderr.trim()}`);
  return { branch: target, repoRoot: root };
}

/** 清理隔离工作区 */
async function removeWorktree(worktreePath, force = true) {
  const root = await repoRoot(worktreePath);
  if (!root) throw new Error('无法定位 Git 仓库根目录');
  const r = await git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], 60000);
  if (!r.ok) throw new Error(`移除隔离工作区失败：${r.stderr.trim() || r.error}`);
  return { ok: true };
}

module.exports = {
  DEFAULT_LIMIT,
  BRANCH_PREFIX,
  worktreeRoot,
  git,
  isGitRepo,
  repoRoot,
  currentBranch,
  // 2026-11-03：初始化仓库（新建项目自动执行 / 分支面板一键初始化）
  isUnbornHead,
  initRepo,
  listWorktrees,
  countWorktrees,
  cleanupWorktrees,
  describeWorktree,
  worktreeStatus,
  listBranches,
  checkoutBranch,
  refreshBranches,
  GIT_IDENTITY_MISSING,
  createWorktree,
  promoteToBranch,
  syncToLocal,
  removeWorktree,
};