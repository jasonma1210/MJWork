// hunk 级 git 应用：接受（只写索引）/ 拒绝（反向写工作区）。
//
// 为什么独立成模块：exec.js 已顶到 800 行门禁（God File 苗头），而这块逻辑与
// shell / 读写工具无耦合，只依赖 spawn + 传入的 patch 文本，抽出来边界更清楚。
//
// 语义对照 Codex app 的「Per hunk: stage / unstage / revert」：
//   · 接受 = `git apply --cached`：**只在索引里**写这一块，工作区不动，其余块仍属未暂存；
//   · 拒绝 = `git apply --reverse`：把这一块从工作区反向抹掉，索引不受影响。
// 两个方向都必须带 `--unidiff-zero`：面板解析出的 hunk 是原样块，不保证带零上下文标记。
const { spawn } = require('child_process');
const { shellEnv } = require('../tools/shellEnv');
const { needsApproval, approvalTarget } = require('../approval');
const { denialText, approvalReasonOf } = require('../approvalChannel');
const { audit } = require('../audit/auditLog');
const { payloadShapeError } = require('./toolPayload');

// X14：hunk 三通道（{cwd, patch}）与破坏性通道（{cwd, files, conversationId}）的边界校验。
// 失败按工具结果形状返回而不是抛（渲染层/Diff 面板一律按 { stdout, stderr, error } 消费）；
// 共享出口见 main/ipc/toolPayload.js。

// hunk 三通道的载荷形状：patch 从 stdin 送进 `git apply`，cwd 是它的执行目录
const HUNK_INPUT_SPEC = { cwd: { max: 4096, optional: true }, patch: { max: 4 * 1024 * 1024 } };
function hunkInputError(cwd, patch) {
  return payloadShapeError({ cwd, patch }, HUNK_INPUT_SPEC);
}

// 从 patch 头里取受影响文件与 hunk 数（审计与审批摘要共用；取不到就给占位，不抛）
function patchMeta(patch) {
  const m = String(patch || '').match(/^diff --git a\/(.+?) b\//m);
  const hunks = (String(patch || '').match(/^@@/gm) || []).length;
  return { path: m ? m[1] : '(unknown)', hunks };
}

// 当前审批档：优先用注入的 getter（便于单测），否则惰性取运行器里的用户设置。
// 惰性 require 是为了避免 main → agentRunner → … → gitHunks 的加载环。
function currentApprovalMode(fallbackGetter) {
  if (typeof fallbackGetter === 'function') {
    try { return fallbackGetter() || 'on-request'; } catch { /* 落到下一档 */ }
  }
  // 2026-10-17（P1-1）：逐 hunk 暂存的档位判断属「无人值守纪律」一侧，读用户设置；
  // 原先读 agentRunner 的「最后一次 run」档，会话级覆盖时会拿到别的会话的档。
  // 落到 'on-request' 是**更保守**的方向（设置读坏了就多问一句，不会静默放行），但仍是降级：
  // 用户若配过 never（全自动），表现为「忽然什么都弹窗」，得能从日志看出是设置读不出来而非他改错了。
  try { return require('../approvalSettings').getUserApprovalMode() || 'on-request'; } catch (e) { console.warn('[gitHunks] 读取用户审批档失败，本次按 on-request 处理（更保守）：', e?.message || e); return 'on-request'; }
}

// 破坏性 git 操作（丢弃工作区改动 / 回退索引）的审批闸。
// 分级 L3：任何档位都弹卡，但「本对话同类」规则可豁免——用户点过一次「本会话允许」后不再打扰。
// 为什么必须弹：这是唯一能**静默销毁用户未提交工作**的通道，且直连 IPC 可被注入脚本触发。
async function guardDestructive(deps, toolKey, args, conversationId) {
  const verdict = needsApproval({
    tool: toolKey,
    args,
    approvalMode: currentApprovalMode(deps?.getApprovalMode),
    conversationId,
    alwaysRules: deps?.getAlwaysRules?.() || [],
    conversationRules: deps?.conversationRules || [],
  });
  const target = approvalTarget(toolKey, args);
  if (!verdict.need) {
    audit(toolKey, target, `规则豁免（${verdict.matched}，actor=diff-panel）`, 'auto');
    return { ok: true, matched: verdict.matched };
  }
  // fail-closed：没有审批通道（启动早期/deps 未注入）时拒绝，绝不放行——宁可点不动，
  // 也不能因为「问不到人」就把未提交改动静默丢掉。
  if (typeof deps?.requestApproval !== 'function') {
    audit(toolKey, target, '审批通道不可用，fail-closed 拒绝', 'blocked');
    return { ok: false, error: '审批通道不可用，已阻止该操作', denied: true };
  }
  const waitP = deps.requestApproval(toolKey, args);
  const decision = await waitP;
  if (decision === 'deny') {
    const reason = approvalReasonOf(decision);
    audit(toolKey, target, reason ? `用户拒绝。理由：${reason}` : '用户拒绝（actor=diff-panel）', 'denied');
    return { ok: false, error: denialText(reason), denied: true };
  }
  // once / conversation / always 三种放行都交给审批中心落规则（conversation 需要 conversationId）
  deps.applyApprovalDecision?.(decision, toolKey, args, conversationId);
  audit(toolKey, target, `已批准（decision=${decision}，actor=diff-panel）`, 'recorded');
  return { ok: true, decision };
}

// git apply 从 stdin 读 patch；统一 15s 看门狗与错误形状（{stdout,stderr,exitCode,error}）。
function gitApplyStdin(flags, cwd, patch) {
  return new Promise((resolve) => {
    // env: 打包版 PATH 极简 ⇒ Homebrew git 找不到（同 exec.js 的口径）
    const child = spawn('git', ['apply', ...flags, '-'], { cwd, env: shellEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr: 'git apply 超时', error: 'timeout' });
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0, error: code ? `git apply 失败（退出码 ${code}）` : null });
    });
    child.stdin.write(patch);
    child.stdin.end();
  });
}

// 保留 _deps 形参以匹配统一注册签名；hunk 通道按设计不弹审批卡，不消费依赖
function registerGitHunkIpc(ipcMain, _deps) {
  // 三个 hunk 通道：接受/取消暂存只写索引，拒绝则反向写工作区。都按设计不弹审批卡（用户在 Diff
  // 面板上的主动动作，再套审批＝同一动作两次打扰），但**必须留痕**——「静默改索引/抹工作区」事后
  // 若无记录，出问题无法归因。注意「git 可恢复」只对索引方向成立：拒绝方向会抹掉未暂存块的原文，
  // 撤销出口由面板的 snapshot + offerUndo 提供（判据见 test/hunk-stage.test.mjs）。
  const auditHunk = (action, patch, extra) => {
    const { path: file, hunks } = patchMeta(patch);
    audit(action, file, `hunk ${hunks} 个${extra ? `；${extra}` : ''}；actor=diff-panel`, 'auto');
  };
  // 拒绝单个代码块（对标 Codex 三级还原中的最小粒度）
  ipcMain.handle('tool:gitApplyHunk', async (_, { cwd, patch } = {}) => {
    const bad = hunkInputError(cwd, patch); if (bad) return bad;
    auditHunk('git_apply_hunk', patch, '拒绝');
    return gitApplyStdin(['--reverse', '--unidiff-zero'], cwd, patch);
  });
  // 接受单个代码块（对标 Codex 的 Per hunk stage）：只进索引，工作区不动
  ipcMain.handle('tool:gitApplyHunkCached', async (_, { cwd, patch } = {}) => {
    const bad = hunkInputError(cwd, patch); if (bad) return bad;
    auditHunk('git_apply_hunk_cached', patch, '接受');
    return gitApplyStdin(['--cached', '--unidiff-zero'], cwd, patch);
  });
  // 取消暂存单个代码块（对标 Codex 的 Per hunk unstage）：反向作用于索引，工作区改动保留。
  // 「已暂存」视图里唯一有意义的块级动作——接受错了要能一块一块退回来，而不是整文件重来。
  ipcMain.handle('tool:gitApplyHunkUnstage', async (_, { cwd, patch } = {}) => {
    const bad = hunkInputError(cwd, patch); if (bad) return bad;
    auditHunk('git_apply_hunk_unstage', patch, '取消暂存');
    return gitApplyStdin(['--cached', '--reverse', '--unidiff-zero'], cwd, patch);
  });
}

// 破坏性 git 操作：审批在前，执行在后。
// runGit 由 exec.js 注入（单一 git 执行入口，避免两处实现漂移）。
function registerDestructiveGitIpc(ipcMain, deps, runGit) {
  const toList = (files) => (Array.isArray(files)
    ? files.map(String)
    : String(files || '').split(/\s+/).filter(Boolean));
  // X14：三条破坏性通道同形（{cwd, files, conversationId}）——files 允许字符串（单文件）
  // 或数组（批量放弃），数组才限条数；conversationId 会进审批规则库，故同样限长。
  const DESTRUCTIVE_INPUT_SPEC = {
    cwd: { max: 4096, optional: true, allowEmpty: true },
    conversationId: { max: 200, optional: true, allowEmpty: true },
    // P1：「撤回本轮」的基线 SHA（run:createBaseline 产出）。只放行十六进制，见通道内注释。
    source: { max: 64, optional: true, allowEmpty: true },
  };

  ipcMain.handle('tool:gitCheckout', async (_, { cwd, files, conversationId } = {}) => {
    const bad = payloadShapeError({ cwd, files, conversationId }, DESTRUCTIVE_INPUT_SPEC, { arrayKey: 'files' });
    if (bad) return bad;
    const list = toList(files);
    if (list.length === 0) return { stdout: '', stderr: 'files required', error: 'files required' };
    const g = await guardDestructive(deps, 'git_checkout', { cwd, files: list.join(' ') }, conversationId);
    if (!g.ok) return { stdout: '', stderr: g.error, error: g.error, denied: true };
    return runGit(['checkout', '--', ...list], cwd);
  });

  ipcMain.handle('tool:gitRestoreStaged', async (_, { cwd, files, conversationId } = {}) => {
    const bad = payloadShapeError({ cwd, files, conversationId }, DESTRUCTIVE_INPUT_SPEC, { arrayKey: 'files' });
    if (bad) return bad;
    const list = toList(files);
    if (list.length === 0) return { stdout: '', stderr: 'files required', error: 'files required' };
    const g = await guardDestructive(deps, 'git_restore_staged', { cwd, files: list.join(' ') }, conversationId);
    if (!g.ok) return { stdout: '', stderr: g.error, error: g.error, denied: true };
    return runGit(['restore', '--staged', ...list], cwd);
  });

  // 放弃文件改动：一条命令同时回退索引与工作区（git ≥2.23 的 restore --source=HEAD）。
  // 为什么不用「先 restore --staged 再 checkout」两步：那是两次 IPC，也就是**两张审批卡**，
  // 用户点一次「放弃修改」要连点两次确认。合成一条命令 = 一次审批、一次执行、原子性更好。
  // 批量放弃也走这条通道，避免「逐个文件 checkout」把审批卡刷成 N 张。
  //
  // P1（2026-10-22）「撤回本轮」：source 允许指定 run 开始时的基线 SHA（由 run:createBaseline 取得）。
  // 不指定时仍是 HEAD（原有语义）。**只接受十六进制 SHA**——这是防注入的关键：
  // 该值会拼进 git 参数，若允许任意字符串，`--source=--force` 这类就能改语义。
  ipcMain.handle('tool:gitDiscardFiles', async (_, { cwd, files, conversationId, source } = {}) => {
    const bad = payloadShapeError({ cwd, files, conversationId, source }, DESTRUCTIVE_INPUT_SPEC, { arrayKey: 'files' });
    if (bad) return bad;
    const list = toList(files);
    if (list.length === 0) return { stdout: '', stderr: 'files required', error: 'files required' };
    const src = typeof source === 'string' && /^[0-9a-f]{7,40}$/i.test(source) ? source : 'HEAD';
    const g = await guardDestructive(deps, 'git_checkout', { cwd, files: list.join(' ') }, conversationId);
    if (!g.ok) return { stdout: '', stderr: g.error, error: g.error, denied: true };
    return runGit(['restore', `--source=${src}`, '--staged', '--worktree', '--', ...list], cwd);
  });

  // P1（2026-10-22）：记录 run 开始前的工作区状态，供「撤回本轮」用。
  // `git stash create` 只生成一个 commit 对象并返回 SHA——**不改工作区、不写 stash 列表**，
  // 因此是纯读操作，不需要审批。工作区干净时它返回空，此时撤回等价于回到 HEAD。
  ipcMain.handle('run:createBaseline', async (_, { cwd } = {}) => {
    const bad = payloadShapeError({ cwd }, DESTRUCTIVE_INPUT_SPEC);
    if (bad) return bad;
    if (!cwd) return { ok: false, reason: 'cwd 缺失，无法建立基线' };
    try {
      const r = await runGit(['stash', 'create'], cwd);
      const raw = String(r?.stdout || '').trim();
      const sha = /^[0-9a-f]{7,40}$/i.test(raw) ? raw : '';
      // sha 为空有两种正常情况：工作区干净（撤回=回到 HEAD）、非 git 目录（撤回会失败并如实报错）
      return { ok: true, sha, clean: !sha };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e).slice(0, 200) };
    }
  });
}

module.exports = { registerGitHunkIpc, registerDestructiveGitIpc, gitApplyStdin };
