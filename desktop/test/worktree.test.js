// Worktree 隔离工作区：真仓库上的端到端验证（创建 → 改文件 → 收口 → 清理）
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktree = require('../main/worktree');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// 走 PATH 解析的 `git`（与 main/worktree.js 一致），不要写死 /usr/bin/git：
// CI runner 上该绝对路径不可直接 spawn（ENOENT），会连锁弄坏临时仓库状态。
const gitBin = 'git';
function sh(cwd, args) {
  const { execFileSync } = require('child_process');
  return execFileSync(gitBin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-wt-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  sh(repo, ['init', '-q']);
  // 把初始分支命名为 main：兼容所有 git 版本，不依赖运行机的 init.defaultBranch
  // （默认可能是 master，会让全套「预期 main」断言级联失败）
  sh(repo, ['checkout', '-q', '-b', 'main']);
  sh(repo, ['config', 'user.email', 't@t.io']);
  sh(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '-qm', 'init']);

  let wt = null;

  await check('识别 Git 仓库', async () => {
    assert.equal(await worktree.isGitRepo(repo), true);
  });

  await check('非 Git 目录判定为 false', async () => {
    assert.equal(await worktree.isGitRepo(tmp), false);
  });

  await check('worktree 存放于用户级固定目录（不污染项目）', () => {
    assert.equal(worktree.worktreeRoot(), path.join(os.homedir(), '.mjcode', 'worktrees'));
  });

  await check('创建隔离工作区成功，主目录不受影响', async () => {
    wt = await worktree.createWorktree(repo, '修复登录跳转');
    assert.ok(fs.existsSync(wt.path));
    assert.ok(wt.branch.startsWith('mjcode/'));
    assert.ok(wt.branch.includes('修复登录跳转') || wt.branch.includes('mjcode/'));
    // 主检出目录不应出现新文件
    assert.equal(fs.existsSync(path.join(repo, 'NEW.md')), false);
  });

  await check('工作区内改动与主目录物理隔离', async () => {
    fs.writeFileSync(path.join(wt.path, 'NEW.md'), 'only in worktree\n');
    assert.equal(fs.existsSync(path.join(wt.path, 'NEW.md')), true);
    assert.equal(fs.existsSync(path.join(repo, 'NEW.md')), false);
  });

  await check('列出 worktree 并正确标记主检出目录', async () => {
    // 注意：在 worktree 内执行 rev-parse --show-toplevel 返回的是 worktree 自身，
    // 主检出目录必须从原始项目目录解析（这是本模块最容易踩的坑）
    const root = await worktree.repoRoot(repo);
    const list = await worktree.listWorktrees(root, root);
    assert.ok(list.length >= 2, `预期至少 2 个，实际 ${list.length}`);
    assert.equal(list.filter((w) => w.isMain).length, 1);
    // macOS 下 git 输出 realpath（/private/var/...），需归一化后比较
    const norm = (p) => fs.realpathSync(p);
    assert.ok(list.some((w) => norm(w.path) === norm(wt.path) && !w.isMain),
      `未在列表中找到工作区：${list.map((w) => w.path).join(', ')}`);
  });

  await check('收口方式一：转为正式分支（改名为 mj/ 前缀）', async () => {
    const r = await worktree.promoteToBranch(wt.path);
    assert.ok(r.branch.startsWith('mj/'), r.branch);
    assert.ok(!r.branch.startsWith('mjcode/'));
  });

  await check('收口方式二：主目录干净时可同步回本地', async () => {
    const r = await worktree.syncToLocal(wt.path);
    assert.ok(r.branch.startsWith('mjcode/sync-'));
  });

  await check('主目录存在未提交改动时同步被拒绝（fail-closed）', async () => {
    fs.writeFileSync(path.join(repo, 'DIRTY.md'), 'x');
    await assert.rejects(() => worktree.syncToLocal(wt.path), /未提交改动/);
    fs.unlinkSync(path.join(repo, 'DIRTY.md'));
  });

  await check('清理隔离工作区', async () => {
    await worktree.removeWorktree(wt.path);
    assert.equal(fs.existsSync(wt.path), false);
  });

  await check('清理不存在的路径时报中文错误', async () => {
    await assert.rejects(() => worktree.removeWorktree(path.join(tmp, 'nope')), /无法定位|移除失败/);
  });

  await check('非 Git 项目创建工作区被拒绝', async () => {
    await assert.rejects(() => worktree.createWorktree(tmp, 'x'), /不是 Git 仓库/);
  });

  await check('未选项目时报中文错误', async () => {
    await assert.rejects(() => worktree.createWorktree('', 'x'), /未选择项目/);
  });

  // ── 分支选择器（输入框下方 Git 按钮的数据面）──
  // 判据是「点下去之后仓库真的变了 / 真的没变」，不是「源码里有这个字符串」。
  const head = (cwd) => sh(cwd, ['rev-parse', 'HEAD']).trim();
  const statusOf = (cwd) => sh(cwd, ['status', '--porcelain']).trim();

  await check('脏状态：干净时为 false，有未跟踪文件时为 true 且单独计数', async () => {
    const clean = await worktree.worktreeStatus(repo);
    assert.equal(clean.isRepo, true);
    assert.equal(clean.hasUncommittedChanges, false);
    fs.mkdirSync(path.join(repo, 'newdir'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'newdir/a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'newdir/b.txt'), 'b\n');
    const dirty = await worktree.worktreeStatus(repo);
    assert.equal(dirty.hasUncommittedChanges, true);
    // --untracked-files=all：否则整个 newdir 会被折叠成一条 `?? newdir/`，计数失真
    assert.equal(dirty.untrackedFiles, 2, `未跟踪文件数应为 2，实际 ${dirty.untrackedFiles}`);
    fs.rmSync(path.join(repo, 'newdir'), { recursive: true, force: true });
  });

  await check('列出分支：本地按当前优先排序，远程单列一组', async () => {
    sh(repo, ['branch', 'aaa-earlier']);
    const r = await worktree.listBranches(repo);
    assert.equal(r.isRepo, true);
    assert.equal(r.current, 'main');
    assert.ok(r.local.length >= 2, `至少两个本地分支才谈得上排序，实际 ${r.local.length}`);
    assert.equal(r.local[0].name, 'main', `当前分支应置顶，实际首位 ${r.local[0].name}`);
    assert.equal(r.local.filter((b) => b.current).length, 1, '当前分支必须唯一');
    const rest = r.local.slice(1).map((b) => b.name);
    assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)), '非当前分支应保持字母序');
    assert.deepEqual(r.remote, [], '没有远端时远程组必须为空（不是缺字段）');
  });

  await check('非 Git 目录：isRepo=false（不是空列表冒充成功）', async () => {
    const r = await worktree.listBranches(tmp);
    assert.equal(r.isRepo, false);
    assert.deepEqual(r.local, []);
    assert.deepEqual(r.remote, []);
  });

  await check('切换分支：同分支零动作，换分支真换 HEAD', async () => {
    const same = await worktree.checkoutBranch(repo, 'main');
    assert.equal(same.switched, false, '同分支不该产生 checkout');
    sh(repo, ['branch', 'feature/pick']);
    const before = head(repo);
    const r = await worktree.checkoutBranch(repo, 'feature/pick');
    assert.equal(r.switched, true);
    assert.equal(r.currentBranch, 'feature/pick');
    assert.equal(head(repo), before, '同一提交上的分支切换不该改变 HEAD 提交');
    await worktree.checkoutBranch(repo, 'main');
  });

  await check('切到不存在的分支被拒绝（白名单来自 git 本身）', async () => {
    await assert.rejects(() => worktree.checkoutBranch(repo, '--orphan'), /分支不存在/);
    await assert.rejects(() => worktree.checkoutBranch(repo, 'no-such-branch'), /分支不存在/);
    assert.equal(await worktree.currentBranch(repo), 'main', '被拒绝后不得发生任何切换');
  });

  // ── 脏工作区三选一（对齐 WorkBuddy handleDirtyBeforeCheckout）──
  let dirtySeq = 0;
  const makeDirty = () => {
    // 内容必须每次不同：commit 档真的会把文件提交进历史，下次再写同样内容 git 视为无改动
    // （实测踩过：后续用例的「脏」变成「干净」，三选一根本没被触发）
    fs.writeFileSync(path.join(repo, 'DIRTY.md'), `dirty ${++dirtySeq}\n`);
    fs.mkdirSync(path.join(repo, 'untracked'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'untracked/u.md'), 'u\n');
  };
  const cleanRepo = () => {
    sh(repo, ['reset', '-q', '--hard', 'HEAD']);
    sh(repo, ['clean', '-qfd']);
  };
  // 每个用例都从「main + 干净」出发：check() 吞掉异常后状态会漂，靠前一个用例收尾太脆
  // （实测：前一条失败后，后面的「未知策略」用例因为工作区已干净而变成「没抛错」）
  const toMain = () => { sh(repo, ['checkout', '-q', 'main']); cleanRepo(); };

  await check('脏工作区 + abort：返回 blockedByDirty，且分支/文件原样不动', async () => {
    toMain();
    makeDirty();
    const r = await worktree.checkoutBranch(repo, 'feature/pick', 'abort');
    assert.equal(r.blockedByDirty, true);
    assert.equal(r.switched, false);
    assert.equal(await worktree.currentBranch(repo), 'main');
    assert.equal(fs.existsSync(path.join(repo, 'DIRTY.md')), true, '拒绝时不得动用户文件');
    cleanRepo();
  });

  await check('脏工作区 + stash：改动进 stash（含未跟踪），分支切换成功', async () => {
    toMain();
    makeDirty();
    const r = await worktree.checkoutBranch(repo, 'feature/pick', 'stash');
    assert.equal(r.switched, true);
    assert.equal(await worktree.currentBranch(repo), 'feature/pick');
    assert.equal(fs.existsSync(path.join(repo, 'DIRTY.md')), false, '改动应已被 stash 收起');
    const list = sh(repo, ['stash', 'list']);
    assert.ok(list.includes('Checkout-autostash'), `stash 里应有本次的收纳记录：${list}`);
    sh(repo, ['stash', 'pop', '-q']);
    sh(repo, ['checkout', '-q', 'main']);
    cleanRepo();
  });

  await check('脏工作区 + commit：先落一个 checkpoint 提交（推荐档）', async () => {
    toMain();
    makeDirty();
    const before = head(repo);
    const r = await worktree.checkoutBranch(repo, 'feature/pick', 'commit');
    assert.equal(r.switched, true);
    const msg = sh(repo, ['log', '-1', '--pretty=%s', 'main']).trim();
    assert.match(msg, /^\[Checkout-checkpoint\] from main to feature\/pick/);
    assert.notEqual(sh(repo, ['rev-parse', 'main']).trim(), before, 'commit 档必须产生新提交');
    sh(repo, ['checkout', '-q', 'main']);
    // 撤掉 checkpoint 提交：它只是本用例的验证痕迹，留着会让后面的用例看到「已提交的同名文件」
    sh(repo, ['reset', '-q', '--hard', 'HEAD~1']);
    cleanRepo();
  });

  await check('脏工作区 + commit 但没配身份：抛 GIT_IDENTITY_MISSING（不是含糊的失败）', async () => {
    toMain();
    makeDirty();
    sh(repo, ['config', 'user.email', '']);
    sh(repo, ['config', 'user.name', '']);
    try {
      await assert.rejects(
        () => worktree.checkoutBranch(repo, 'feature/pick', 'commit'),
        (e) => e.code === 'GIT_IDENTITY_MISSING',
      );
      // 身份校验必须在 add 之前：失败时不能让暂存区被改了一半（那是「处置动作自己弄脏工作区」）
      const staged = sh(repo, ['diff', '--cached', '--name-only']).trim();
      assert.equal(staged.includes('DIRTY.md'), false, '身份校验必须先于 git add（否则失败时暂存区已被改一半）');
    } finally {
      sh(repo, ['config', 'user.email', 't@t.io']);
      sh(repo, ['config', 'user.name', 't']);
      assert.equal(await worktree.currentBranch(repo), 'main', '失败后不得切走');
      cleanRepo();
    }
  });

  await check('脏工作区 + discard：改动被抹掉且不可恢复', async () => {
    toMain();
    makeDirty();
    const r = await worktree.checkoutBranch(repo, 'feature/pick', 'discard');
    assert.equal(r.switched, true);
    sh(repo, ['checkout', '-q', 'main']);
    assert.equal(fs.existsSync(path.join(repo, 'DIRTY.md')), false, 'discard 后文件应消失');
    assert.equal(fs.existsSync(path.join(repo, 'untracked/u.md')), false, '未跟踪目录也应被清理');
    cleanRepo();
  });

  await check('未知 dirtyPolicy 必须报错，不得按 discard 处理（拼错=删数据）', async () => {
    toMain();
    makeDirty();
    await assert.rejects(() => worktree.checkoutBranch(repo, 'feature/pick', 'discardd'), /未知的脏工作区处置方式/);
    assert.equal(fs.existsSync(path.join(repo, 'DIRTY.md')), true, '拼错策略时文件必须还在');
    cleanRepo();
  });

  // ── 远程分支与拉取更新 ──
  const bare = path.join(tmp, 'origin.git');
  const peer = path.join(tmp, 'peer');
  await check('远程分支：分组列出，符号引用 origin/HEAD 不算分支', async () => {
    sh(tmp, ['init', '--bare', '-q', 'origin.git']);
    sh(repo, ['remote', 'add', 'origin', bare]);
    sh(repo, ['push', '-q', '-u', 'origin', 'main']);
    // 让裸仓库默认分支指向 main：否则克隆会落到未出生的 master，
    // 后续 `git checkout -q main` 直接 pathspec 失败并级联
    sh(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    sh(tmp, ['clone', '-q', bare, peer]);
    // 兜底：显式建出本地 main（跟随 origin/main），不依赖克隆时的默认分支解析
    sh(peer, ['checkout', '-q', '-B', 'main', 'origin/main']);
    sh(peer, ['config', 'user.email', 'p@p.io']);
    sh(peer, ['config', 'user.name', 'p']);
    sh(peer, ['checkout', '-q', '-b', 'feat/remote-only']);
    fs.writeFileSync(path.join(peer, 'R.md'), 'r\n');
    sh(peer, ['add', '.']);
    sh(peer, ['commit', '-qm', 'remote commit']);
    sh(peer, ['push', '-q', 'origin', 'feat/remote-only']);
    sh(repo, ['fetch', '-q', 'origin']);

    const r = await worktree.listBranches(repo);
    const names = r.remote.map((b) => b.name);
    assert.ok(names.includes('origin/feat/remote-only'), `远程组应含 origin/feat/remote-only：${names.join(',')}`);
    assert.equal(names.some((n) => n.endsWith('/HEAD')), false, 'origin/HEAD 不是可切换分支，必须过滤');
    const row = r.remote.find((b) => b.name === 'origin/feat/remote-only');
    assert.equal(row.short, 'feat/remote-only', '远程项要带去掉前缀的短名（用于建本地跟踪分支）');
  });

  await check('选远程分支：自动建本地跟踪分支（不是游离头指针）', async () => {
    toMain();
    const r = await worktree.checkoutBranch(repo, 'origin/feat/remote-only');
    assert.equal(r.switched, true);
    assert.equal(r.currentBranch, 'feat/remote-only');
    const up = sh(repo, ['rev-parse', '--abbrev-ref', 'feat/remote-only@{u}']).trim();
    assert.equal(up, 'origin/feat/remote-only', '本地分支必须跟踪来源远程分支');
    sh(repo, ['checkout', '-q', 'main']);
  });

  await check('拉取更新只 fetch：远端新提交出现在列表里，但工作区文件不变', async () => {
    sh(peer, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(peer, 'REMOTE.md'), 'from peer\n');
    sh(peer, ['add', '.']);
    sh(peer, ['commit', '-qm', 'peer commit']);
    sh(peer, ['push', '-q', 'origin', 'main']);

    const localBefore = head(repo);
    const r = await worktree.refreshBranches(repo);
    assert.equal(r.fetched, true);
    assert.equal(head(repo), localBefore, '拉取更新不得移动本地 HEAD');
    assert.equal(fs.existsSync(path.join(repo, 'REMOTE.md')), false,
      '拉取更新不得把远端文件拉进工作区（合并是另一件事）');
    const behind = Number(sh(repo, ['rev-list', '--count', 'HEAD..origin/main']).trim());
    assert.ok(behind >= 1, '列表数据应让用户看出落后了几个提交');
  });

  await check('纯本地仓库：拉取更新不报错，只说没有远端', async () => {
    const solo = path.join(tmp, 'solo');
    fs.mkdirSync(solo);
    sh(solo, ['init', '-q']);
    sh(solo, ['config', 'user.email', 's@s.io']);
    sh(solo, ['config', 'user.name', 's']);
    fs.writeFileSync(path.join(solo, 'a.md'), 'a\n');
    sh(solo, ['add', '.']);
    sh(solo, ['commit', '-qm', 'solo']);
    const r = await worktree.refreshBranches(solo);
    assert.equal(r.noRemote, true);
    assert.equal(r.fetched, false);
    assert.ok(r.local.some((b) => b.name === 'main' || b.name === 'master'), '仍要返回本地分支列表');
  });

  await check('隔离工作区按指定基线分支创建（不是当前分支）', async () => {
    sh(repo, ['checkout', '-q', '-b', 'release/1.0']);
    fs.writeFileSync(path.join(repo, 'RELEASE.md'), 'v1\n');
    sh(repo, ['add', '.']);
    sh(repo, ['commit', '-qm', 'release base']);
    const baseSha = head(repo);
    sh(repo, ['checkout', '-q', 'main']);

    const wtBase = await worktree.createWorktree(repo, '基于发布分支', 'release/1.0');
    assert.equal(wtBase.base, 'release/1.0');
    assert.equal(head(wtBase.path), baseSha, '副本 HEAD 必须落在基线分支的提交上');
    assert.ok(wtBase.branch.startsWith('mjcode/'), '副本自己的分支仍在 mjcode/ 命名空间');
    assert.notEqual(wtBase.branch, 'release/1.0');
    await worktree.removeWorktree(wtBase.path);
  });

  await check('基线只认分支名：不存在 / SHA / HEAD~1 一律拒（不静默回落当前分支）', async () => {
    await assert.rejects(() => worktree.createWorktree(repo, 'x', 'no-such-base'), /分支不存在/);
    await assert.rejects(() => worktree.createWorktree(repo, 'x', head(repo)), /分支不存在/);
    await assert.rejects(() => worktree.createWorktree(repo, 'x', 'HEAD~1'), /分支不存在/);
  });

  // ── 副本数量与按天清理（对齐 WorkBuddy 的 countWorktrees / cleanupWorktrees）──
  await check('计数与清理：只清「够旧 + 干净」的副本，脏的与新的都跳过', async () => {
    const daysAgo = (days) => new Date(Date.now() - days * 86400000);
    const wtA = await worktree.createWorktree(repo, 'clean-old', 'main');
    const wtB = await worktree.createWorktree(repo, 'dirty-old', 'main');
    const wtC = await worktree.createWorktree(repo, 'clean-new', 'main');
    // A：干净 + 30 天没动；B：脏 + 30 天没动；C：干净但刚建（mtime=现在）
    fs.writeFileSync(path.join(wtB.path, 'WIP.md'), 'wip\n');
    fs.utimesSync(wtA.path, daysAgo(30), daysAgo(30));
    fs.utimesSync(wtB.path, daysAgo(30), daysAgo(30));

    assert.equal(await worktree.countWorktrees(repo), 3, '三个副本都要被数到');

    const r = await worktree.cleanupWorktrees(repo, { olderThanDays: 15 });
    assert.equal(r.cleanedCount, 1, `只该清掉 A，实际清了 ${r.cleanedCount}`);
    assert.equal(r.skippedDirtyCount, 1, 'B 有未提交改动，必须跳过');
    assert.equal(r.skippedRecentCount, 1, 'C 不够旧，必须跳过');
    assert.equal(r.failedCount, 0, `不应有失败：${r.failedCount}`);
    assert.deepEqual(r.cleanedWorktreePaths, [wtA.path]);

    assert.equal(fs.existsSync(wtA.path), false, 'A 的目录应被删除');
    assert.equal(fs.existsSync(wtB.path), true, 'B 的目录必须还在（脏副本不能清）');
    assert.equal(fs.existsSync(wtC.path), true, 'C 的目录必须还在（未满天数）');
    // 分支只删自己前缀的任务分支：A 的 mjcode/xxx 应已删除，B 的仍在（副本还在用）
    // 注意：`git branch` 会用 `*` 标当前分支、用 `+` 标「已被某个 worktree 检出」的分支——
    // 只 replace('*') 会把 `+ mjcode/xxx` 留成带号的名字，导致「分支还在」被误判成不在
    const branches = sh(repo, ['branch', '--list', 'mjcode/*']).trim().split('\n')
      .map((x) => x.replace(/^[*+]\s*/, '').trim()).filter(Boolean);
    assert.equal(branches.includes(wtA.branch), false, `A 的分支应被删除：${branches.join(',')}`);
    assert.equal(branches.includes(wtB.branch), true, 'B 的分支还要留着（副本仍在）');

    assert.equal(await worktree.countWorktrees(repo), 2, '清掉一个后计数应减一');
    await worktree.removeWorktree(wtB.path);
    await worktree.removeWorktree(wtC.path);
  });

  await check('上限：超过 DEFAULT_LIMIT 时拒绝建副本（错误文案要能看出上限是多少）', async () => {
    // 上限口径：从源码读，别在测试里抄一个 50（抄了就跟实现解耦，改上限时这条不会红）
    const src = fs.readFileSync(path.join(__dirname, '../main/worktree.js'), 'utf8');
    const limit = Number((src.match(/const DEFAULT_LIMIT = (\d+)/) || [])[1]);
    assert.ok(limit > 0, '没解析出 DEFAULT_LIMIT');
    const made = [];
    for (let i = 0; i < limit; i += 1) made.push(await worktree.createWorktree(repo, `fill-${i}`, 'main'));
    try {
      await assert.rejects(() => worktree.createWorktree(repo, 'over', 'main'), new RegExp(`上限（${limit} 个）`));
    } finally {
      for (const w of made) await worktree.removeWorktree(w.path);
    }
    assert.equal(await worktree.countWorktrees(repo), 0, '收尾后不该留副本');
  });

  // ── 副本被清理后的恢复：会话执行根指回项目目录（LocalStore 真实行为）──
  await check('会话执行根只能改成真实存在的目录（死指针不能换成另一个死指针）', async () => {
    const { LocalStore } = require('../main/store/localStore');
    const dataDir = path.join(tmp, 'ls');
    fs.mkdirSync(dataDir, { recursive: true });
    const store = new LocalStore(dataDir);
    const t = store.createThread({ title: '会话', cwd: repo, projectPath: repo });

    const bad = store.updateThreadCwd(t.id, path.join(tmp, 'missing-dir'));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /目录不存在/);
    assert.equal(store.updateThreadCwd(t.id, '').ok, false, '空路径必须拒绝（等于清掉指针）');
    assert.equal(store.listThreads(repo)[0].cwd, repo, '失败的写入不得改动原值');

    const okRes = store.updateThreadCwd(t.id, dataDir);
    assert.equal(okRes.ok, true);
    assert.equal(store.listThreads(repo)[0].cwd, dataDir, '成功写入要能读回');
    assert.equal(store.updateThreadCwd(999, dataDir).ok, false, '不存在的会话要拒绝');
  });

  await check('describeWorktree：可判「我方副本 / 已清理的副本 / 普通目录」三种形态', async () => {
    const wt = await worktree.createWorktree(repo, 'describe-me', 'main');
    try {
      const live = await worktree.describeWorktree(wt.path);
      assert.equal(live.managed, true);
      assert.equal(live.exists, true);
      assert.equal(live.branch, wt.branch, '存在时必须读出真实分支，不能猜');
      assert.ok(live.repoRoot.length > 0, '要能回指主检出目录');

      const outside = await worktree.describeWorktree(repo);
      assert.equal(outside.managed, false, '项目目录不是我方副本');
    } finally {
      await worktree.removeWorktree(wt.path);
    }
    // 目录被删掉后仍要能判「这是我方副本，只是不在了」——靠路径前缀，不依赖 git
    const gone = await worktree.describeWorktree(wt.path);
    assert.equal(gone.managed, true);
    assert.equal(gone.exists, false);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  // 清掉本轮创建的 worktree 残留
  try {
    const root = await worktree.repoRoot(repo);
    if (root) {
      const list = await worktree.listWorktrees(root, root);
      for (const w of list.filter((x) => !x.isMain)) await worktree.removeWorktree(w.path);
    }
  } catch { /* 清理失败不影响断言结论 */ }
  console.log(`\nPASS：${pass}/${total} 项通过`);
})();