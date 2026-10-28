// R0 信任阻断波行为验收（对应《完整产品与源码整改方案 v2》2026-10-16）：
//   V12 审批枚举归一化——未知档位/沙箱策略收敛默认值，非法决策按 deny
//   V03 unconfined_exec 审批面——L1 恒逐次，规则不可豁免
//   V08 corrupt-blocked——损坏无备份阻断写入、损坏原件保留、持久 ACK 真实化
//   V06 隔离失败保留产物——merge 冲突时 worktree/补丁不销毁，成功才清理
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ═══════════ V12：审批枚举归一化 ═══════════
{
  const { stricterApproval, stricterSandbox, normalizeApprovalMode, normalizeSandboxPolicy } = require('../main/approvalPolicy');
  check('V12: 非法审批档归一为默认 on-request', normalizeApprovalMode('INVALID') === 'on-request');
  check('V12: 非法沙箱策略归一为默认 workspace-write', normalizeSandboxPolicy('INVALID') === 'workspace-write');
  check('V12: stricterApproval 不再透传非法值（INVALID→默认 on-request，且严于 auto-safe）', stricterApproval('INVALID', 'auto-safe') === 'on-request');
  check('V12: stricterSandbox 不再透传非法值', stricterSandbox('INVALID', 'read-only') === 'read-only');
  check('V12: 角色只能收紧（user=auto-safe, role=always → always）', stricterApproval('auto-safe', 'always') === 'always');
  check('V12: 角色不能放宽（user=always, role=never → always）', stricterApproval('always', 'never') === 'always');
  check('V12: 沙箱收紧（user=workspace-write, role=read-only → read-only）', stricterSandbox('workspace-write', 'read-only') === 'read-only');
  check('V12: 沙箱不放宽（user=read-only, role=full-access → read-only）', stricterSandbox('read-only', 'full-access') === 'read-only');
  check('V12: 合法值原样通过（never / full-access）', normalizeApprovalMode('never') === 'never' && normalizeSandboxPolicy('full-access') === 'full-access');

  const { ApprovalChannel } = require('../main/approvalChannel');
  const ch = new ApprovalChannel({ timeoutMs: 50 });
  const id = ch.nextId();
  const waitP = ch.wait(id);
  ch.dispatch(id, 'HACKED');
  waitP.then((d) => {
    check('V12: 非法决策值按 deny 收尾（fail-closed）', d === 'deny');
    runUnconfinedTests();
  });
} 

// ═══════════ V03：unconfined_exec 审批面 ═══════════
function runUnconfinedTests() {
  const approval = require('../main/approval');
  check('V03: unconfined_exec 判级 L1', approval.toolLevel('unconfined_exec', { command: 'ls' }) === 'L1');
  // V12 真值表校准（2026-10-28 修订，P0-6）：原语义「never = 对一切工具不询问」被推翻。
  // 事故形态：never 档下 rm -rf / curl|sh / git push --force 零确认直接执行，而 Worker 路径因
  // 强制 stricterApproval(…, 'auto-safe') 反而会问 —— 交互路径比无人值守更松，与设计意图相反。
  // 现语义：**L1 是硬地板**，任何档位都询问（与 unconfined_exec / computer_use 的「任何档位都弹卡」同纪律）；
  // L2 及以下仍按档位放行。注意 unconfined_exec 的实际审批由 exec 层直调 requestApproval，
  // 本条只是真值表断言 —— 它的运行时行为不因此改变。
  check('V03/V12: never 档对 L1 仍询问（硬地板，2026-10-28 修订）', approval.needsApproval({ tool: 'unconfined_exec', args: { command: 'ls' }, approvalMode: 'never', alwaysRules: [], conversationRules: [] }).need === true);
  // 配套反向守护：修 L1 不能把 never 档变成全档拦截 —— L2 文件写必须仍放行
  check('V03/V12: never 档对 L2 仍不询问（档位语义未被过度收紧）', approval.needsApproval({ tool: 'write_file', args: { path: 'a.txt' }, approvalMode: 'never', alwaysRules: [], conversationRules: [] }).need === false);
  check('V03/V12: always 档 L1 必询问', approval.needsApproval({ tool: 'unconfined_exec', args: { command: 'ls' }, approvalMode: 'always', alwaysRules: [], conversationRules: [] }).need === true);
  check('V03/V12: L1 危险命令不受 always 规则豁免', approval.needsApproval({ tool: 'shell', args: { command: 'rm -rf /' }, approvalMode: 'auto-safe', alwaysRules: [{ tool: 'shell', pattern: 'rm -rf /' }], conversationRules: [] }).need === true);
  const summary = approval.approvalSummary('unconfined_exec', { command: 'rm -rf /tmp/x' });
  check('V03: 审批卡摘要含命令且标注非沙箱', summary.level === 'L1' && String(summary.detail).includes('rm -rf /tmp/x'));
  runLocalStoreTests();
}

// ═══════════ V08：corrupt-blocked + 持久 ACK ═══════════
function runLocalStoreTests() {
  const { LocalStore } = require('../main/localStore');

  // 场景 A：损坏且无备份 → corrupt-blocked
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-r0-corrupt-'));
  fs.writeFileSync(path.join(dirA, 'local-data.json'), '{this is not json');
  const storeA = new LocalStore(dirA);
  check('V08: 损坏且无备份进入 corrupt-blocked', storeA.corruptBlocked === true);
  let threw = false;
  try { storeA.createThread({ title: 'x' }); } catch (e) { threw = String(e.message).includes('corrupt-blocked'); }
  check('V08: blocked 态下 createThread 拒绝写入（fail-closed）', threw);
  threw = false;
  try { storeA.addMessage({ threadId: 1, role: 'user', content: 'x' }); } catch { threw = true; }
  check('V08: blocked 态下 addMessage 拒绝写入', threw);
  const flushRes = storeA.flush();
  check('V08: blocked 态下 flush 拒绝写盘', flushRes.ok === false && String(flushRes.error).includes('corrupt-blocked'));
  const corruptCopies = fs.readdirSync(dirA).filter((f) => f.startsWith('local-data.corrupt-'));
  check('V08: 损坏原件已保留副本', corruptCopies.length === 1);
  check('V08: 原损坏文件未被覆盖', fs.readFileSync(path.join(dirA, 'local-data.json'), 'utf8') === '{this is not json');

  // 场景 B：持久 ACK 真实化——磁盘不可写时 flushSync 如实报失败，恢复后可重试成功
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-r0-ack-'));
  const storeB = new LocalStore(dirB);
  const threadB = storeB.createThread({ title: 't1' }); // 目录可写时先建线程（同步 flush 成功）
  fs.chmodSync(dirB, 0o555); // 目录只读 → writeFileDurable 必然失败
  storeB.addMessage({ threadId: threadB.id, role: 'user', content: 'x' }); // 内存接受（scheduleFlush 标脏）
  const badRes = storeB.flushSync();
  check('V08: 写盘失败时 flushSync 返回 {ok:false}（不假成功）', badRes && badRes.ok === false);
  check('V08: 写盘失败后脏状态保留（等待重试）', storeB._dirty === true);
  fs.chmodSync(dirB, 0o755); // 恢复可写 → 脏数据仍在，可重试成功
  const retryRes = storeB.flushSync();
  check('V08: 磁盘恢复后 flushSync 重试成功（脏状态保留）', retryRes && retryRes.ok === true);
  const storeB2 = new LocalStore(dirB);
  check('V08: 重试成功后数据 durable 可恢复', storeB2.listThreads().length === 1 && storeB2.listMessages(threadB.id).length === 1);
  runIsolationTests();
}

// ═══════════ V06：隔离失败保留产物 ═══════════
function runIsolationTests() {
  const workerIsolation = require('../main/workerIsolation');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-r0-iso-'));
  const mainRepo = path.join(base, 'main');
  const wtPath = path.join(base, 'wt-a');
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  fs.mkdirSync(mainRepo);
  git(['init', '-b', 'main'], mainRepo);
  git(['config', 'user.email', 't@t'], mainRepo);
  git(['config', 'user.name', 't'], mainRepo);
  fs.writeFileSync(path.join(mainRepo, 'a.txt'), 'base\n');
  git(['add', '-A'], mainRepo);
  git(['commit', '-m', 'init'], mainRepo);
  git(['worktree', 'add', wtPath, '-b', 'test-branch'], mainRepo);

  // worktree 内新增文件（模拟 Worker 改动）
  fs.writeFileSync(path.join(wtPath, 'b.txt'), 'worker change\n');

  // 主目录制造冲突：同名文件不同内容 → apply --check 失败
  fs.writeFileSync(path.join(mainRepo, 'b.txt'), 'conflicting content\n');

  const iso = { worktreePath: wtPath, branch: 'test-branch', repoRoot: mainRepo };
  let patchFile = null;
  workerIsolation.mergeBackIsolated({ cwd: mainRepo, iso }).then(async (res) => {
    check('V06: 合并冲突时 mergeBack 返回 ok:false', res.ok === false);
    check('V06: 冲突补丁已落盘', !!res.patchFile && fs.existsSync(res.patchFile));
    patchFile = res.patchFile;
    check('V06: 冲突时 worktree 未被清理（改动可取回）', fs.existsSync(wtPath));
    check('V06: 冲突时任务改动仍在 worktree 内', fs.existsSync(path.join(wtPath, 'b.txt')));

    // 排除冲突后重试 → 成功路径应 applied 且清理 worktree
    fs.rmSync(path.join(mainRepo, 'b.txt'));
    const res2 = await workerIsolation.mergeBackIsolated({ cwd: mainRepo, iso });
    check('V06: 排除冲突后合并成功（applied）', res2.ok === true && res2.applied === true);
    check('V06: 成功落地后 worktree 已清理', !fs.existsSync(wtPath));
    check('V06: 成功落地后产物在主目录', fs.readFileSync(path.join(mainRepo, 'b.txt'), 'utf8') === 'worker change\n');

    // archiveIsolated：无改动 → 清理；有改动 → 保留 + 补丁
    const wtPath2 = path.join(base, 'wt-b');
    git(['worktree', 'add', wtPath2, '-b', 'test-branch-2'], mainRepo);
    const emptyArc = await workerIsolation.archiveIsolated({ iso: { worktreePath: wtPath2, branch: 'test-branch-2', repoRoot: mainRepo } });
    check('V06: archiveIsolated 无改动时清理副本', emptyArc.empty === true && !fs.existsSync(wtPath2));
    const wtPath3 = path.join(base, 'wt-c');
    git(['worktree', 'add', wtPath3, '-b', 'test-branch-3'], mainRepo);
    fs.writeFileSync(path.join(wtPath3, 'c.txt'), 'partial work\n');
    const keptArc = await workerIsolation.archiveIsolated({ iso: { worktreePath: wtPath3, branch: 'test-branch-3', repoRoot: mainRepo } });
    check('V06: archiveIsolated 有改动时保留 worktree', keptArc.empty === false && fs.existsSync(wtPath3));
    check('V06: archiveIsolated 有改动时生成补丁', !!keptArc.patchFile && fs.existsSync(keptArc.patchFile));
    await workerIsolation.discardIsolated({ iso: { worktreePath: wtPath3, branch: 'test-branch-3', repoRoot: mainRepo } });
    check('V06: discardIsolated 仍可显式清理', !fs.existsSync(wtPath3));

    // 清理测试残留（补丁文件在用户 ~/.mjcode/worktree-conflicts）
    try {
      for (const f of [patchFile, keptArc.patchFile].filter(Boolean)) fs.rmSync(f, { force: true });
    } catch { /* 清理尽力而为 */ }

    console.log(`\n──── R0 行为验收汇总：通过 ${pass} · 失败 ${fail} ────`);
    process.exit(fail === 0 ? 0 : 1);
  }).catch((e) => {
    console.error('❌ 隔离测试异常:', e.message);
    process.exit(1);
  });
}

// 链式入口：V12 决策校验（Promise）→ V03 审批面 → V08 持久化 → V06 隔离（含收尾退出）
