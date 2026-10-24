// Git Worktree 隔离工作区（对标 Codex 的 Worktree 模式）
// 目的：让 Agent 在独立副本上改代码，主项目目录不受影响，天然支持并行多任务
// 约束：路径全部以仓库根为基准解析；创建失败不残留；上限保护避免磁盘失控
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_LIMIT = 8;
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
 */
async function createWorktree(projectPath, taskTitle = 'task') {
  if (!projectPath) throw new Error('未选择项目');
  if (!(await isGitRepo(projectPath))) throw new Error('当前项目不是 Git 仓库，无法使用隔离工作区');

  const root = await repoRoot(projectPath);
  if (!root) throw new Error('无法定位 Git 仓库根目录');

  const existing = await listWorktrees(root, root);
  if (existing.filter((w) => !w.isMain).length >= DEFAULT_LIMIT) {
    throw new Error(`隔离工作区已达上限（${DEFAULT_LIMIT} 个），请先清理旧工作区`);
  }

  const slug = String(taskTitle).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 32) || 'task';
  const stamp = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString(36).slice(-4)}`;
  const branch = `${BRANCH_PREFIX}${slug}-${stamp}`;
  const dir = path.join(worktreeRoot(), `${slug}-${stamp}`);

  await fsp.mkdir(worktreeRoot(), { recursive: true });
  const base = (await currentBranch(root)) || 'HEAD';
  const r = await git(root, ['worktree', 'add', '-b', branch, dir, base], 60000);
  if (!r.ok) throw new Error(`创建隔离工作区失败：${r.stderr.trim() || r.error}`);
  return { path: dir, branch, repoRoot: root, base };
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
  listWorktrees,
  createWorktree,
  promoteToBranch,
  syncToLocal,
  removeWorktree,
};