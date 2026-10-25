// P0-5 回归门禁：直连 IPC 的治理参数强制覆写（desktop/main/tools/execGovernance.js）
//
// 为什么必须有这个测试：execGovernance 是「渲染层被注入脚本 / 有缺陷的调用方」绕过审批与沙箱的
// 唯一堵口——它把 requireApproval 恒置 true、把 sandboxPolicy 钳到安全档。此处一旦被改松，
// 表现是「一切正常、没有任何报错」，只有安全边界悄悄消失。源码形态断言 + 行为断言双层拦住。
//
// 历史背景：2026-10-17 审查发现该模块**零测试覆盖**——此前一条「full-access 应直跑」的期望
// 因与本治理策略冲突而失败，处理方式是把断言删掉换绿灯，安全边界随之失去守护。本文件补上。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const { ipcGovernance } = await import(
  'file://' + path.join(ROOT, 'main', 'tools', 'execGovernance.js')
);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

// A10 守卫辅助：去除 JS 行/块注释（保留 `://` 不被误删），仅保留「生效」源码。
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── ① 行为：sandboxPolicy 只能收紧，不能被载荷放宽 ──
check('full-access 被钳制为 workspace-write（不做隔离的档位不得经直连 IPC 进入）', () => {
  assert.equal(ipcGovernance({ sandboxPolicy: 'full-access', cwd: '/tmp/proj' }).sandboxPolicy, 'workspace-write');
});
check('read-only 保持 read-only（只收紧不放宽）', () => {
  assert.equal(ipcGovernance({ sandboxPolicy: 'read-only' }).sandboxPolicy, 'read-only');
});
check('workspace-write 原样保留', () => {
  assert.equal(ipcGovernance({ sandboxPolicy: 'workspace-write' }).sandboxPolicy, 'workspace-write');
});
check('未知 / 缺失 / 非字符串档位一律回落 workspace-write（有 cwd）', () => {
  for (const v of [undefined, null, '', 'FULL-ACCESS', 'full_access', 123, {}]) {
    assert.equal(ipcGovernance({ sandboxPolicy: v, cwd: '/tmp/proj' }).sandboxPolicy, 'workspace-write', `值 ${String(v)} 未被钳制`);
  }
});
check('无 cwd 时回落 read-only（无项目目录不得可写，2026-10-21）', () => {
  for (const v of [undefined, null, 'full-access', 'bogus']) {
    assert.equal(ipcGovernance({ sandboxPolicy: v }).sandboxPolicy, 'read-only', `值 ${String(v)} 未回落只读`);
  }
});

// ── ② 行为：requireApproval 恒 true（显式 false 同样不可信）──
check('requireApproval 恒为 true（显式 false 被覆写）', () => {
  assert.equal(ipcGovernance({ requireApproval: false }).requireApproval, true);
  assert.equal(ipcGovernance({ requireApproval: true }).requireApproval, true);
  assert.equal(ipcGovernance({}).requireApproval, true);
});

// ── ③ 行为：只改治理字段，业务字段一律原样透传 ──
check('业务字段原样透传（command/argv/cwd/patch 不被改写）', () => {
  const payload = {
    command: 'npm test', argv: ['git', 'status'], cwd: '/tmp/proj',
    patch: '--- a\n+++ b\n', conversationId: 'c1', extra: { deep: 1 },
  };
  const out = ipcGovernance(payload);
  for (const k of Object.keys(payload)) {
    assert.deepEqual(out[k], payload[k], `字段 ${k} 被改写`);
  }
});
check('纯函数：不修改入参（避免调用方复用同一对象时被静默提权）', () => {
  const payload = { sandboxPolicy: 'full-access', requireApproval: false };
  ipcGovernance(payload);
  assert.equal(payload.sandboxPolicy, 'full-access');
  assert.equal(payload.requireApproval, false);
});

// ── ④ 接线：写类/执行类 IPC 必须套治理，读类不得误套 ──
const execSrc = fs.readFileSync(path.join(ROOT, 'main', 'tools', 'exec.js'), 'utf8');

// 写类 + 执行类：这些 handler 会改文件/跑命令，必须经 ipcGovernance
const MUST_GOVERN = ['shell', 'gitCommit', 'gitAdd'];
// 写文件三件套经 runWriteTool 循环注册（tool:${toolName}），单独校验循环那一行
check('写类/执行类 IPC 全部套了 ipcGovernance', () => {
  for (const name of MUST_GOVERN) {
    const re = new RegExp(`ipcMain\\.handle\\('tool:${name}'[\\s\\S]{0,160}ipcGovernance\\(`);
    assert.match(execSrc, re, `tool:${name} 未套 ipcGovernance（直连可绕过审批/沙箱）`);
  }
  assert.match(execSrc, /ipcMain\.handle\(`tool:\$\{toolName\}`,[\s\S]{0,120}ipcGovernance\(/,
    '写文件三件套（writeFile/editFile/applyPatch）未套 ipcGovernance');
});

// 读类：不产生副作用，若被套上治理会导致「读文件也要审批卡」，属回归
const MUST_NOT_GOVERN = ['readFile', 'listDir', 'grep', 'glob', 'gitStatus', 'gitDiff', 'gitLog', 'gitBranch'];
check('读类 IPC 未被误套治理（读文件不该弹审批卡）', () => {
  for (const name of MUST_NOT_GOVERN) {
    const re = new RegExp(`ipcMain\\.handle\\('tool:${name}'[^\\n]*`);
    const line = execSrc.match(re)?.[0] || '';
    assert.ok(line, `tool:${name} 的 handler 不存在（是否被误删？）`);
    assert.doesNotMatch(line, /ipcGovernance\(/, `tool:${name} 是只读操作，不该套治理`);
  }
});

// 会话链路对照：模型路径靠引擎侧剥离治理字段 + 宿主绑定覆盖，与本模块是两条独立防线。
// 此处只断言「剥离清单仍包含治理字段」——两侧同时失效才是漏洞，单侧改动不该静默通过。
check('引擎侧 GOVERUNANCE_FIELDS 仍覆盖 cwd/sandboxPolicy/approvalMode（与直连钳制互不替代）', () => {
  const core = fs.readFileSync(path.join(ROOT, 'agent-core', 'index.js'), 'utf8');
  const m = core.match(/const GOVERNANCE_FIELDS = \[([^\]]+)\]/);
  assert.ok(m, '未找到 GOVERNANCE_FIELDS 定义（结构变化请同步本测试）');
  for (const field of ['cwd', 'approvalMode', 'sandboxPolicy', 'conversationId', 'requireApproval', 'signal']) {
    assert.ok(m[1].includes(`'${field}'`), `GOVERNANCE_FIELDS 缺少 ${field}（模型可自行指定该治理字段）`);
  }
});

// ── ⑤ 已知缺口（记录，不当作已修）──
// tool:gitApplyHunk / tool:gitCheckout / tool:gitRestoreStaged 目前**既无 ipcGovernance 也无审批卡**。
// 它们是 Diff 面板的用户主动动作（拒绝改动 / 应用单块），套审批会二次打扰用户，因此本轮只登记：
// 断言它们仍存在且仍是「直接执行」，避免有人以为它们已被治理。
check('已知缺口登记：hunk 三通道按设计不弹卡（只写索引、可 git 恢复），但必须留痕', () => {
  // 2026-10-17 方案 A′：gitCheckout / gitRestoreStaged 已接 L3 审批（见 ⑥），移出缺口清单；
  // 只剩三个「只写索引 / 反向写单块」的通道按设计不弹卡——它们由审计留痕兜底。
  const hunkSrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'gitHunks.js'), 'utf8');
  const allSrc = `${execSrc}\n${hunkSrc}`;
  for (const name of ['gitApplyHunk', 'gitApplyHunkCached', 'gitApplyHunkUnstage']) {
    const re = new RegExp(`ipcMain\\.handle\\('tool:${name}'[\\s\\S]{0,320}`);
    const block = allSrc.match(re)?.[0] || '';
    assert.ok(block, `tool:${name} 不存在（是否已重构？请同步本测试）`);
    assert.doesNotMatch(block, /requestApproval|awaitApproval/,
      `tool:${name} 已接审批——若属有意变更，请把本条从「不弹卡」列表移出并更新说明`);
    assert.match(block, /auditHunk\(/, `tool:${name} 既无审批也无审计（静默改索引，事后无法归因）`);
  }
});

// ── ⑥ 破坏性 git 操作（丢弃工作区改动）必须过审批 ──
// 2026-10-17（方案 A′）：gitCheckout / gitRestoreStaged 判 L3——任何档位都弹卡，
// 但「本对话同类」规则可豁免（用户点过一次「本会话允许」后不再打扰）。
// 判 L2 是错的：auto-safe 会静默放行，等于「自动安全」模式默认丢弃未提交改动。
{
  const require = createRequire(import.meta.url);
  const approval = require(path.join(ROOT, 'main', 'approval.js'));

  check('丢弃改动判 L3 / 取消暂存判 L2（按「是否销毁内容」分级）', () => {
    // L3：内容是**真的没了**，任何档位都弹卡（含 auto-safe）
    const discard = approval.needsApproval({ tool: 'git_checkout', args: { files: 'a.js' }, approvalMode: 'auto-safe' });
    assert.equal(discard.need, true, 'git_checkout 在 auto-safe 下被自动放行（会静默丢弃工作区改动）');
    assert.equal(discard.level, 'L3');
    // L2：内容仍在工作区，只是索引回退，属可逆操作；auto-safe 放行符合「文件写类自动放行」语义
    const unstage = approval.needsApproval({ tool: 'git_restore_staged', args: { files: 'a.js' }, approvalMode: 'on-request' });
    assert.equal(unstage.need, true, 'git_restore_staged 在 on-request 下未弹卡');
    assert.equal(unstage.level, 'L2');
    const unstageSafe = approval.needsApproval({ tool: 'git_restore_staged', args: { files: 'a.js' }, approvalMode: 'auto-safe' });
    assert.equal(unstageSafe.need, false, '取消暂存是纯可逆操作，auto-safe 不应弹卡');
  });

  check('「本会话允许」可豁免，且只对同一会话生效', () => {
    const tool = 'git_checkout';
    const rule = { tool, pattern: 'a.js', conversationId: 't1' };
    const same = approval.needsApproval({
      tool, args: { files: 'a.js' }, approvalMode: 'on-request', conversationId: 't1', conversationRules: [rule],
    });
    assert.equal(same.need, false, '本会话同类规则未生效（用户会每次点击都被弹卡）');
    assert.equal(same.matched, 'conversation');
    const other = approval.needsApproval({
      tool, args: { files: 'a.js' }, approvalMode: 'on-request', conversationId: 't2', conversationRules: [rule],
    });
    assert.equal(other.need, true, '规则泄漏到了其他会话');
  });

  check('审批卡文案写明「不可撤销」（否则用户会当普通暂存点掉）', () => {
    const s = approval.approvalSummary('git_checkout', { files: 'src/a.js' });
    assert.equal(s.level, 'L3');
    assert.match(s.title, /丢弃/, `标题未说明动作：${s.title}`);
    assert.match(s.detail, /无法撤销/, '详情未警示不可撤销');
    assert.match(s.detail, /src\/a\.js/, '详情未列出受影响文件');
    const u = approval.approvalSummary('git_restore_staged', { files: 'src/a.js' });
    assert.match(u.detail, /工作区改动保留/, '取消暂存未说明工作区改动保留');
  });

  check('规则粒度按文件列表（不对整个工具一次放行）', () => {
    assert.equal(approval.approvalTarget('git_checkout', { files: 'a.js b.js' }), 'a.js b.js');
  });

  check('无审批通道时 fail-closed（问不到人就不放行）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'gitHunks.js'), 'utf8');
    const guard = src.slice(src.indexOf('async function guardDestructive'));
    const body = guard.slice(0, guard.indexOf('\n}'));
    assert.match(body, /typeof deps\?\.requestApproval !== 'function'/, '缺少审批通道可用性检查');
    assert.match(body, /fail-closed 拒绝/, '缺少 fail-closed 审计留痕');
    const checkIdx = body.indexOf("typeof deps?.requestApproval !== 'function'");
    const callIdx = body.indexOf('deps.requestApproval(');
    assert.ok(checkIdx > 0 && callIdx > checkIdx, '先调审批后判通道（deps 为空时会 TypeError）');
  });

  // ── A10 守卫：guardDestructive 的 fail-closed 审批通道检查必须作为「去注释生效代码」存在 ──
  // 旧检查只在函数体文本内比对 token 存在+顺序，对「fail-closed 检查被注释/失效但仍残留在文本」
  // 的回归是盲的（假绿）。这里剥离注释后断言该检查真正作为生效代码存在、且仍在调用 requestApproval 之前。
  check('A10 守卫：guardDestructive 去注释函数体仍有 fail-closed 审批通道检查、且位于调用之前', () => {
    const gsrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'gitHunks.js'), 'utf8');
    const g = gsrc.slice(gsrc.indexOf('async function guardDestructive'));
    const b = g.slice(0, g.indexOf('\n}'));
    const bActive = stripJsComments(b);
    const cIdx = bActive.indexOf("typeof deps?.requestApproval !== 'function'");
    const callIdx = bActive.indexOf('deps.requestApproval(');
    assert.ok(cIdx > 0, '去注释函数体内未找到 fail-closed 审批通道检查（已被注释或移除）');
    assert.ok(callIdx > cIdx, 'fail-closed 检查必须在 deps.requestApproval( 调用之前');
  });

  check('放弃文件走单条命令 + 单次审批（避免一次点击两张卡）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'gitHunks.js'), 'utf8');
    const at = src.indexOf("tool:gitDiscardFiles'");
    assert.ok(at > 0, '未找到 gitDiscardFiles（放弃应一条命令同时回退索引与工作区）');
    const rest = src.slice(at);
    const nextAt = rest.indexOf('ipcMain.handle', 10);
    const block = nextAt > 0 ? rest.slice(0, nextAt) : rest;
    assert.match(block, /guardDestructive\(deps, 'git_checkout'/, '放弃未复用 checkout 的审批闸');
    assert.match(block, /'--staged', '--worktree'/, '放弃未同时回退索引与工作区（分两步 = 两张审批卡）');
    // 面板侧：放弃只调一次 gitDiscardFiles，不再「先 unstage 再 checkout」
    const panel = fs.readFileSync(path.join(ROOT, 'renderer/src/components/DiffReviewPanel.jsx'), 'utf8');
    assert.doesNotMatch(panel, /gitCheckout\(/, '面板仍直接调 gitCheckout（应统一走 gitDiscardFiles）');
    const rejectFn = panel.slice(panel.indexOf('async function reject(file)'), panel.indexOf('function offerUndo'));
    assert.equal((rejectFn.match(/gitDiscardFiles\(/g) || []).length, 1, '单文件放弃应只调用一次 gitDiscardFiles');
    assert.doesNotMatch(rejectFn, /gitRestoreStaged\(/, '单文件放弃不该再单独取消暂存');
  });

  check('放弃前必问（快照成功也问），确认文案告知可撤销', () => {
    const panel = fs.readFileSync(path.join(ROOT, 'renderer/src/components/DiffReviewPanel.jsx'), 'utf8');
    const rejectFn = panel.slice(panel.indexOf('async function reject(file)'), panel.indexOf('function offerUndo'));
    assert.doesNotMatch(rejectFn, /if \(!snapshotId\)/, '确认被快照结果条件跳过（快照成功时就不再问了）');
    assert.match(rejectFn, /const ok = await confirm\(/, '单文件放弃缺少人工确认');
    assert.match(rejectFn, /diff\.undoAvailable/, '确认文案未告知「已备份、可撤销」');
    const rejectAllFn = panel.slice(panel.indexOf('async function rejectAll'), panel.indexOf('async function openPr'));
    assert.match(rejectAllFn, /await countConfirm\(/, '批量放弃缺少数量确认');
    assert.match(rejectAllFn, /diff\.undoAvailable/, '批量确认文案未告知可撤销');
    // 文案 key 双份存在
    for (const loc of ['zh-CN', 'en-US']) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, `renderer/src/i18n/locales/${loc}/diff.json`), 'utf8'));
      assert.ok(dict.undoAvailable, `${loc}/diff.json 缺少 undoAvailable`);
    }
  });

  check('两个破坏性 handler 走 guardDestructive（审批在前、执行在后）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'gitHunks.js'), 'utf8');
    for (const [name, key] of [['gitCheckout', 'git_checkout'], ['gitRestoreStaged', 'git_restore_staged']]) {
      const at = src.indexOf(`tool:${name}'`);
      assert.ok(at > 0, `未找到 tool:${name} handler`);
      // 取到下一个 handler 之前（块尾不是规则的 });，用边界切片更稳）
      const rest = src.slice(at);
      const nextAt = rest.indexOf('ipcMain.handle', 10);
      const block = nextAt > 0 ? rest.slice(0, nextAt) : rest;
      assert.match(block, new RegExp(`guardDestructive\\(deps, '${key}'`), `${name} 未过审批闸`);
      const guardIdx = block.indexOf('guardDestructive');
      const runIdx = block.indexOf('runGit(');
      assert.ok(guardIdx > 0 && runIdx > guardIdx, `${name} 先执行后审批（顺序反了）`);
      assert.match(block, /if \(!g\.ok\) return/, `${name} 未处理拒绝结果`);
    }
  });

  check('exec.js 不再持有破坏性 handler（已迁到 gitHunks.js）', () => {
    assert.doesNotMatch(execSrc, /ipcMain\.handle\('tool:gitCheckout'/, 'exec.js 仍注册 gitCheckout（会与 gitHunks 重复注册）');
    assert.match(execSrc, /registerDestructiveGitIpc\(ipcMain, deps, runGit\)/, 'exec.js 未注册破坏性 git IPC');
  });

  check('hunk 三通道不弹卡但留痕', () => {
    const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'gitHunks.js'), 'utf8');
    assert.match(src, /auditHunk\('git_apply_hunk'/, '拒绝未写审计');
    assert.match(src, /auditHunk\('git_apply_hunk_cached'/, '接受未写审计');
    assert.match(src, /auditHunk\('git_apply_hunk_unstage'/, '取消暂存未写审计');
    assert.doesNotMatch(src, /tool:gitApplyHunk(Cached|Unstage)?'[\s\S]{0,300}?requestApproval/,
      'hunk 通道不应弹审批卡（只写索引、可 git 恢复）');
  });
}

console.log(`\nexec-governance: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
