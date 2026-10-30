// P0-3：写路径白名单守卫（纯函数，可单测）
// 背景：写工具（write_file / edit_file / apply_patch）此前接受任意绝对路径，
// 而 auto-safe 档位对 L2 自动放行（approval.js:57）——LLM 可静默写用户主目录下任意文件。
// 规则（fail-closed）：写目标必须位于允许根目录集合内：
//   { 当前项目 cwd, 应用数据目录 userData, 系统临时目录 }
// 白名单外的写入不接受任何审批规则豁免，也不受 auto-safe 自动放行，必须显式审批。

const path = require('path');
const os = require('os');
const fs = require('fs');

// 解析到「真实路径」：自身不存在时向上找最近的已存在祖先，再把剩余段拼回。
// 为什么需要向上走：写工具的目标常是**尚不存在的新文件**（write_file 创建文件），
// 直接 realpath 会 ENOENT——不能因「目标不存在」就判越界，那会挡死所有新建文件；
// 而「解析失败却放行」正是软链穿越的利用面，故向上解析到真实存在点再拼回剩余段。
// 软链场景验证：/proj/link → /etc 时，realpath('/proj/link/passwd') 虽失败，
// 但向上命中 /proj/link 解析为 /etc，拼回得 /etc/passwd → 与 root 比较即判越界。
function realPathOf(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (; ;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* 不存在，继续向上 */ }
    const parent = path.dirname(cur);
    if (parent === cur) return null; // 到达文件系统根仍不存在（极端情况）
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

// 目录包含判定：target 在 root 内（含 root 本身），不受符号链接外的 ../ 逃逸影响
// P2-6 修复（2026-10-17）：追加 realpath 校验防软链穿越——原实现只用 path.resolve
// 做字符串包含判定，而 resolve 不解析符号链接：root 内的 symlink 指向 root 外时
// （/proj/link → /etc），「/proj/link/passwd」会被判为在界内，写操作经软链落到
// 白名单之外。判定分两步：① resolve 快速路径（纯字符串，先挡掉显式越界）；
// ② realpath 精确判定（双方都解析到最终真实路径后再做包含比较）。
// realpath 彻底失败（连文件系统根都不可解析）按 fail-closed：视为不在界内。
function isWithinRoot(target, root) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return false;
  const realRoot = realPathOf(root);
  const realTarget = realPathOf(target);
  if (realRoot === null || realTarget === null) return false; // fail-closed：解析失败按不在界内
  const realRel = path.relative(realRoot, realTarget);
  return realRel === '' || (!realRel.startsWith('..') && !path.isAbsolute(realRel));
}

// 允许写根目录集合：项目目录 + 应用数据目录 + 系统临时目录。
// macOS 的 os.tmpdir() 返回 /var/folders/...（不覆盖 /tmp 符号链接路径），
// 因此非 Windows 平台额外把 /tmp 纳入白名单——临时目录下的合法工作不应反复触发审批。
function allowedWriteRoots({ cwd, userDataDir, tmpDir } = {}) {
  const roots = [];
  if (cwd) roots.push(path.resolve(cwd));
  if (userDataDir) roots.push(path.resolve(userDataDir));
  roots.push(path.resolve(tmpDir || os.tmpdir()));
  if (process.platform !== 'win32') roots.push('/tmp');
  return roots;
}

// 返回第一个越界目标（绝对路径）；全部在界内返回 null。
// 相对路径按 base（通常为项目 cwd）解析。
function firstOutsideTarget(targets, roots, base) {
  for (const t of targets || []) {
    const raw = String(t || '').trim();
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base || process.cwd(), raw);
    if (!roots.some((r) => isWithinRoot(abs, r))) return abs;
  }
  return null;
}

// unified diff 目标提取：+++ / --- 行（apply_patch 用 -p1 剥离一层前缀，这里同样剥离 a/ b/）
function patchTargets(patch) {
  const out = [];
  for (const line of String(patch || '').split('\n')) {
    const m = line.match(/^(?:\+\+\+|---)\s+(\S+)/);
    if (!m || m[1] === '/dev/null') continue;
    // 剥离 git diff 惯例前缀 a/ b/（与 patch -p1 语义一致）
    out.push(m[1].replace(/^[ab]\//, ''));
  }
  return out;
}

// ── 可写区内的只读 carve-out（对齐 Codex 当前 Linux 沙箱的做法）──
//
// 背景：workspace-write 档把整个项目目录设为可写，但其中有几处**不应**可写：
//   · `.git` —— 改写 `.git/hooks/pre-commit` 后，用户下次手动 `git commit` 就会执行被注入的代码。
//     这是从「沙箱内」逃到「沙箱外」的既成路径，且不依赖任何漏洞：沙箱只约束 Agent 当前进程，
//     约束不了用户之后自己敲的命令。Codex 在可写根内把 `.git`（含解析出的 gitdir）重新挂为只读，
//     本项目对齐该做法。
//   · 应用自身配置目录（项目内如存在）—— 改写它等于让 Agent 调自己的治理参数。
//
// 注意：只保护精确的 `.git` 路径及其**目录内容**；`.gitignore` / `.gitmodules` 等
// 「以 .git 开头的普通文件」不在保护范围内（用 isWithinRoot 做路径包含判定，天然区分二者）。
const PROTECTED_SUBPATH_NAMES = ['.git', '.mjcode'];

/**
 * 列出该项目下**实际存在**的受保护路径（绝对路径）。
 *
 * 两个必须处理的真实形态：
 *   ① 普通仓库：`.git` 是目录 → 保护该目录；
 *   ② worktree / submodule：`.git` 是**文件**，内容形如 `gitdir: /abs/path/.git/worktrees/x`
 *      → 真正的 gitdir 在别处（甚至可能在项目目录之外），必须一并保护，否则只是把绕过点换了位置。
 *
 * @param {string} cwd 项目目录
 * @param {{existsSync?: Function, readFileSync?: Function}} [io] 便于单测注入
 * @returns {string[]} 受保护绝对路径（含 gitdir 目标）
 */
function protectedPathsFor(cwd, { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  const out = [];
  if (!cwd) return out;
  const base = path.resolve(cwd);
  for (const name of PROTECTED_SUBPATH_NAMES) {
    const p = path.join(base, name);
    let exists = false;
    // 为什么要留痕：这里抛错 ⇒ exists=false ⇒ 该保护项被跳过 ⇒ `.git` 变成可写，
    // 即「沙箱 carve-out 静默失效」（可被改 hooks 实现持久化）。**不改成 fail-closed** 是因为
    // 下游 Seatbelt/bwrap/Windows ACL 三个后端都按「真实存在的路径」建规则，塞进不存在的路径会
    // 直接让沙箱构建失败、把「保护清单少一项」升级成「整个工具不可用」；existsSync 本身对
    // 任何 IO 错误都返回 false，只有参数非法（如路径含 NUL）才抛——概率极低但必须可观测。
    try { exists = !!existsSync(p); } catch (e) { console.warn('[writeGuard] 保护项存在性探测失败，该项本次不纳入只读 carve-out：', p, e?.message || e); exists = false; }
    if (!exists) continue;
    out.push(p);
    // 形态 ②：`.git` 是文件（读目录会抛 EISDIR，正好把两种形态区分开）
    try {
      const m = String(readFileSync(p, 'utf8')).match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitDir = path.resolve(base, m[1].trim());
        if (!out.includes(gitDir)) out.push(gitDir);
      }
    } catch { /* 目录形态或不可读：不影响其余保护项 */ }
  }
  return out;
}

/**
 * 返回第一个落在受保护区内的写目标（绝对路径）；全部安全则返回 null。
 * 相对路径按 base（通常为项目 cwd）解析。
 */
function firstProtectedTarget(targets, protectedPaths, base) {
  if (!Array.isArray(protectedPaths) || protectedPaths.length === 0) return null;
  for (const t of targets || []) {
    const raw = String(t || '').trim();
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base || process.cwd(), raw);
    if (protectedPaths.some((p) => isWithinRoot(abs, p))) return abs;
  }
  return null;
}

/**
 * 期 3：文件能力降级——治理偏好 fsMode === 'read-only' 时拒绝一切写操作。
 * **单一事实来源**：exec.js 的写工具闸口（write_file/edit_file/apply_patch）与
 * nativeTools.toolSqlite 的写路径共用本判定，避免「一处以为只读、另一处照写」的错位。
 * @param {{fsMode?: string}} governance 治理配置（readGovernance 的正常化输出）
 * @returns {boolean}
 */
function isReadonlyFs(governance) {
  return !!governance && governance.fsMode === 'read-only';
}

module.exports = {
  isWithinRoot,
  allowedWriteRoots,
  firstOutsideTarget,
  patchTargets,
  PROTECTED_SUBPATH_NAMES,
  protectedPathsFor,
  firstProtectedTarget,
  isReadonlyFs,
};
