// hunk 级接受（Per hunk stage）机制验证：对标 Codex app 的「Per hunk: stage/unstage/revert」。
//
// 为什么必须有：Diff 面板的「接受此块」只把**该块**写进索引（`git apply --cached`），
// 其余块必须仍在未暂存区。这条语义一旦错，用户点一下接受就会把整文件改动吞进暂存区
// （等价于整文件 `git add`），逐块审阅等于没有。
//
// 断言在真实临时 git 仓库里跑（不依赖 Electron），命令与 IPC 完全一致：
//   接受 = git apply --cached --unidiff-zero -
//   拒绝 = git apply --reverse --unidiff-zero -
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

// ── 临时仓库工具 ──
function git(cwd, args, input) {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8' });
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-hunk-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}
// 解析 unified diff（与 DiffReviewPanel.parseDiff 同口径：按文件分组 → 按 @@ 切 hunk）
function parseDiff(text) {
  const chunks = String(text).split(/^diff --git /m).filter(Boolean);
  return chunks.map((chunk) => {
    const lines = chunk.split('\n');
    const m = lines[0].match(/a\/.+ b\/(.+)$/);
    const filePath = m ? m[1] : lines[0].trim();
    const body = lines.slice(1);
    const hunks = [];
    let cur = null;
    for (const line of body) {
      if (line.startsWith('@@')) { cur = { lines: [line] }; hunks.push(cur); }
      else if (cur) cur.lines.push(line);
    }
    return { path: filePath, lines: body, hunks };
  });
}
// 与 DiffReviewPanel.hunkPatch 同构造：头信息取自文件级 --- /+++ 与 mode 行
function hunkPatch(file, hunk) {
  const head = Array.isArray(file?.lines) ? file.lines : [];
  const modeLines = head.filter((l) => /^(new file mode|deleted file mode|old mode|new mode) /.test(l));
  const from = head.find((l) => l.startsWith('--- ')) || `--- a/${file.path}`;
  const to = head.find((l) => l.startsWith('+++ ')) || `+++ b/${file.path}`;
  return [`diff --git a/${file.path} b/${file.path}`, ...modeLines, from, to, ...hunk.lines, ''].join('\n');
}
const acceptHunk = (dir, file, hunk) => git(dir, ['apply', '--cached', '--unidiff-zero', '-'], hunkPatch(file, hunk));
const rejectHunk = (dir, file, hunk) => git(dir, ['apply', '--reverse', '--unidiff-zero', '-'], hunkPatch(file, hunk));

// 三段改动之间必须间隔 ≥7 行（上下各 3 行上下文）才会被 git 切成 3 个独立 hunk；
// 间隔不足会被合并成一块，那样「逐块接受」的语义就无从验证。
const filler = (tag) => Array.from({ length: 8 }, (_, i) => `// ${tag} filler ${i}`);
const BASE = [
  '// 区块 A',
  'const a = 1;',
  ...filler('A'),
  '// 区块 B',
  'const b = 2;',
  ...filler('B'),
  '// 区块 C',
  'const c = 3;',
  ...filler('C'),
  '',
].join('\n');
const MODIFIED = BASE
  .replace('const a = 1;', 'const a = 10;') // hunk 1
  .replace('const b = 2;', 'const b = 20;') // hunk 2
  .replace('const c = 3;', 'const c = 30;'); // hunk 3

const dir = makeRepo();
fs.writeFileSync(path.join(dir, 'x.js'), BASE);
git(dir, ['add', '.']);
git(dir, ['commit', '-qm', 'base', '--no-verify']);
fs.writeFileSync(path.join(dir, 'x.js'), MODIFIED);

const files = parseDiff(git(dir, ['diff']));
const f = files[0];

check('三段改动被切成 3 个独立 hunk（前置条件）', () => {
  assert.equal(files.length, 1, `文件数 ${files.length}`);
  assert.equal(f.hunks.length, 3, `hunk 数 ${f.hunks.length}`);
});

// ① 核心语义：接受一块 ≠ 接受整文件
check('接受单块只进索引，其余块仍留在未暂存区', () => {
  acceptHunk(dir, f, f.hunks[1]);
  const staged = git(dir, ['diff', '--cached']).match(/^\+const/gm) || [];
  const unstaged = git(dir, ['diff']).match(/^\+const/gm) || [];
  assert.equal(staged.length, 1, `暂存区新增行数 ${staged.length}（应只有 1 块）`);
  assert.equal(unstaged.length, 2, `未暂存新增行数 ${unstaged.length}（应剩 2 块）`);
  const content = fs.readFileSync(path.join(dir, 'x.js'), 'utf8');
  assert.ok(content.includes('a = 10') && content.includes('b = 20') && content.includes('c = 30'),
    '工作区内容被改动——--cached 不应触碰工作区');
});

// ② 连续接受：剩余 hunk 的头是「索引相对」的，第二次接受仍要命中正确位置
check('连续接受第二块（索引相对行号不漂移）', () => {
  const rest = parseDiff(git(dir, ['diff']))[0];
  assert.equal(rest.hunks.length, 2, `剩余 hunk 数 ${rest.hunks.length}`);
  acceptHunk(dir, rest, rest.hunks[0]); // 现在最靠前的那块 = 原 hunk 1
  const staged = git(dir, ['diff', '--cached']).match(/^\+const/gm) || [];
  const unstaged = git(dir, ['diff']).match(/^\+const/gm) || [];
  assert.equal(staged.length, 2, `暂存区 ${staged.length}（应为 2）`);
  assert.equal(unstaged.length, 1, `未暂存 ${unstaged.length}（应为 1）`);
});

// ③ 拒绝与接受互不干扰：拒绝剩下的那块，已暂存的两块必须保留
check('拒绝剩余块不影响已暂存块', () => {
  const rest = parseDiff(git(dir, ['diff']))[0];
  rejectHunk(dir, rest, rest.hunks[0]);
  const staged = git(dir, ['diff', '--cached']).match(/^\+const/gm) || [];
  const unstaged = git(dir, ['diff']).match(/^\+const/gm) || [];
  const content = fs.readFileSync(path.join(dir, 'x.js'), 'utf8');
  assert.equal(staged.length, 2, `暂存区 ${staged.length}（应为 2，拒绝不该动索引）`);
  assert.equal(unstaged.length, 0, `未暂存 ${unstaged.length}（应为 0）`);
  assert.ok(!content.includes('c = 30'), '被拒绝的块的改动仍在工作区');
});

// ④ 新增文件：--- 是 /dev/null，硬编码 a/ b/ 会失败（hunkPatch 已改为取文件级头）
check('接受新增文件的块（patch 头为 /dev/null 时仍可 --cached）', () => {
  fs.writeFileSync(path.join(dir, 'created.js'), 'export const n = 1;\nexport const m = 2;\n');
  git(dir, ['add', '-N', 'created.js']); // 让未跟踪文件出现在 git diff 中
  const created = parseDiff(git(dir, ['diff', '--', 'created.js']))[0];
  assert.ok(created, '未解析到新增文件的 diff');
  assert.ok(created.lines.some((l) => l === '--- /dev/null'), '新增文件缺少 /dev/null 头');
  acceptHunk(dir, created, created.hunks[0]);
  const staged = git(dir, ['diff', '--cached', '--name-only']);
  assert.ok(staged.includes('created.js'), '新增文件未被暂存');
});

// ⑥ 取消暂存单块（已暂存视图）：反向作用于索引，工作区改动必须原样保留
{
  const d2 = makeRepo();
  fs.writeFileSync(path.join(d2, 'x.js'), BASE);
  git(d2, ['add', '.']);
  git(d2, ['commit', '-qm', 'base', '--no-verify']);
  fs.writeFileSync(path.join(d2, 'x.js'), MODIFIED);
  const g = parseDiff(git(d2, ['diff']))[0];
  acceptHunk(d2, g, g.hunks[1]);
  check('取消暂存单块：索引回空、工作区三段改动都在', () => {
    const stagedBefore = (git(d2, ['diff', '--cached']).match(/^\+const/gm) || []).length;
    assert.equal(stagedBefore, 1, `前置：暂存区应有 1 块，实际 ${stagedBefore}`);
    // 已暂存视图里取块（HEAD↔索引），反向作用于索引
    const stagedFile = parseDiff(git(d2, ['diff', '--cached']))[0];
    git(d2, ['apply', '--cached', '--reverse', '--unidiff-zero', '-'], hunkPatch(stagedFile, stagedFile.hunks[0]));
    const stagedAfter = (git(d2, ['diff', '--cached']).match(/^\+const/gm) || []).length;
    const unstagedAfter = (git(d2, ['diff']).match(/^\+const/gm) || []).length;
    const content = fs.readFileSync(path.join(d2, 'x.js'), 'utf8');
    assert.equal(stagedAfter, 0, `暂存区应回空，实际 ${stagedAfter}`);
    assert.equal(unstagedAfter, 3, `未暂存应回到 3 块，实际 ${unstagedAfter}`);
    assert.ok(content.includes('a = 10') && content.includes('b = 20') && content.includes('c = 30'),
      '工作区被改动——取消暂存不该碰工作区');
  });
  fs.rmSync(d2, { recursive: true, force: true });
}

// ⑦ 放弃文件（gitDiscardFiles 的单条命令）：MM（暂存+工作区双改）状态必须一条命令清干净，
// 且不牵连同仓库其它文件。这条替代了此前「先 restore --staged 再 checkout」两步——两步是两次 IPC，
// 也就是同一个动作要过两次审批卡。
{
  const d3 = makeRepo();
  fs.writeFileSync(path.join(d3, 'a.js'), 'line1\n');
  fs.writeFileSync(path.join(d3, 'b.js'), 'other\n');
  git(d3, ['add', '.']);
  git(d3, ['commit', '-qm', 'init', '--no-verify']);
  fs.writeFileSync(path.join(d3, 'a.js'), 'line1-modified\n');
  git(d3, ['add', 'a.js']);                       // 进索引
  fs.writeFileSync(path.join(d3, 'a.js'), 'line1-modified-again\n'); // 工作区再改
  fs.writeFileSync(path.join(d3, 'b.js'), 'b-modified\n');
  check('放弃单文件：一条 restore --source=HEAD --staged --worktree 清空索引与工作区', () => {
    const before = git(d3, ['status', '--short']).trim();
    assert.match(before, /^MM a\.js/m, `前置状态应为 MM，实际：${before}`);
    git(d3, ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'a.js']);
    const after = git(d3, ['status', '--short']).trim();
    assert.equal(fs.readFileSync(path.join(d3, 'a.js'), 'utf8'), 'line1\n', 'a.js 未回到 HEAD 内容');
    assert.ok(after.includes('b.js'), 'b.js 的改动被牵连（只应影响指定文件）');
    assert.ok(!after.includes('a.js'), `a.js 仍有残留状态：${after}`);
  });
  fs.rmSync(d3, { recursive: true, force: true });
}

// ⑤ 渲染层构造器与测试口径一致（防止有人把 hunkPatch 改回硬编码 a/ b/）
check('DiffReviewPanel.hunkPatch 从文件级行取 ---/+++ 与 mode 行', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/src/components/DiffReviewPanel.jsx'), 'utf8');
  const m = src.match(/function hunkPatch\(([\s\S]*?)\n\}/);
  assert.ok(m, '未找到 hunkPatch 定义');
  const body = m[1];
  assert.match(body, /startsWith\('--- '\)/, '未从文件行取 --- 头');
  assert.match(body, /new file mode/, '未保留 mode 行（新增/删除文件会失败）');
  assert.doesNotMatch(body, /`--- a\/\$\{filePath\}`/, '仍在硬编码 a/ 前缀');
});

check('IPC 与 preload 已接 gitApplyHunkCached（--cached，非 --reverse）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/ipc/gitHunks.js'), 'utf8');
  const block = src.match(/tool:gitApplyHunkCached'[\s\S]{0,300}?\}\);/);
  assert.ok(block, '未找到 gitApplyHunkCached handler');
  assert.match(block[0], /--cached/, 'handler 未使用 --cached');
  assert.doesNotMatch(block[0], /--reverse/, '接受路径不该用 --reverse');
  const pre = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');
  assert.match(pre, /gitApplyHunkCached: \(payload\) => ipcRenderer\.invoke\('tool:gitApplyHunkCached'/,
    'preload 未暴露 gitApplyHunkCached');
  // exec.js 必须把该模块注册进 IPC（拆文件后容易漏接）
  const exec = fs.readFileSync(path.join(ROOT, 'main/tools/exec.js'), 'utf8');
  assert.match(exec, /registerGitHunkIpc\(ipcMain, deps\)/, 'exec.js 未注册 hunk 级 IPC（需传 deps 以写审计）');
});

check('已暂存视图：IPC/preload/面板三处都有取消暂存通道', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/ipc/gitHunks.js'), 'utf8');
  const block = src.match(/tool:gitApplyHunkUnstage'[\s\S]{0,300}?\}\);/);
  assert.ok(block, '未找到 gitApplyHunkUnstage handler');
  assert.match(block[0], /--cached/, '取消暂存必须作用于索引');
  assert.match(block[0], /--reverse/, '取消暂存必须用 --reverse（正向会把块再加一遍）');
  const pre = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');
  assert.match(pre, /gitApplyHunkUnstage:/, 'preload 未暴露 gitApplyHunkUnstage');
  const panel = fs.readFileSync(path.join(ROOT, 'renderer/src/components/DiffReviewPanel.jsx'), 'utf8');
  assert.match(panel, /scope === 'staged'/, '面板缺少 staged 视图分支');
  // 2026-10-17：取消暂存会带 conversationId（供「本会话允许」规则绑定），断言随之放宽到参数顺序无关
  assert.match(panel, /gitRestoreStaged\(\{ cwd: projectPath, conversationId: threadId, files: file\.path \}\)/, '面板缺少整文件取消暂存');
});

// B4（2026-10-29）：拒绝方向（`git apply --reverse` 抹掉工作区这一块）必须给「撤销出口」。
// 设计裁决仍然是不弹审批卡（用户在面板上的主动动作，见 exec-governance 的「hunk 三通道按设计不弹卡」），
// 所以安全要求改成落在这里：先快照 → 二次确认 → 成功后提供撤销。三件事缺一即红——
// 只写 snapshot 不接 offerUndo 等于「备份了但没路口」，是最容易写漏的一半。
// 判据锚在 rejectHunk 函数块内（不跨函数匹配，避免被别的函数的 snapshot 蒙过）。
check('拒绝方向：rejectHunk 必须先快照 + 二次确认 + 提供撤销（不弹审批卡的安全兜底）', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'renderer/src/components/DiffReviewPanel.jsx'), 'utf8');
  const at = panel.indexOf('async function rejectHunk');
  assert.ok(at > 0, '未找到 rejectHunk 实现（是否已重构？请同步本测试）');
  const block = panel.slice(at, panel.indexOf('\n  }', at));
  assert.ok(block.length > 200, `rejectHunk 片段过短（${block.length} 字符），切片口径失效`);
  assert.match(block, /await snapshot\(/, 'rejectHunk 未在抹掉前落快照');
  assert.match(block, /await confirm\(/, 'rejectHunk 缺少二次确认');
  assert.match(block, /offerUndo\(/, 'rejectHunk 快照后未提供撤销入口');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nhunk-stage: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
