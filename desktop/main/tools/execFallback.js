'use strict';
// 非沙箱兜底执行路径（P1-2 前置抽离，从 tools/exec.js 原样搬移，行为不变）
//
// 抽出理由：exec.js 位于 795/800 raw 行门禁，任何新逻辑都必须先腾出空间
//（P1-2 要把 shell 默认超时从 60s 改成 SHELL_DEFAULT_TIMEOUT_MS(480s)）。
// 抽出的这一段是 toolShell 里**唯一自洽的完整分支**（策略闸 → 命令守卫 → 直跑），
// 与 sandbox 后端完全解耦，因此可无风险移出；三平台沙箱分支仍留在 exec.js。
//
// 语义（原样保留，勿改）：
//   受限策略（read-only/workspace-write）下 OS 沙箱不可满足 = 能力不可用，默认**阻断**，
//   不再「黑名单守卫后裸跑」——黑名单是提示分类器，不是安全边界。
//   两条显式逃生口（均不记为「已隔离」）：
//     1) 环境变量 MJCODE_ALLOW_UNCONFINED_FALLBACK=1：开发态显式豁免（仍过黑名单守卫）；
//     2) 当场弹一次 unconfined_exec 审批（L1）：用户显式批准本次非沙箱执行，不沉淀任何规则。
const sandbox = require('../sandbox');
const { audit } = require('../audit/auditLog');
const { approvalReasonOf } = require('../approvalChannel');
const shellProfile = require('../cmd/shellProfile');
const { shellEnv } = require('./shellEnv');
const { execFileDetached } = require('./execFileDetached');
const { shellErrorNote } = require('./execCwd');

// 与 exec.js 的 awaitApproval 等价（审批结果 + 拒绝理由的取回口径一致）
async function awaitApproval(requestApproval, tool, args) {
  const waitP = requestApproval(tool, args);
  return { decision: await waitP, reason: approvalReasonOf(waitP) };
}

// C5：上一条逃生口写的是「开发态」豁免，实现却无条件接受——打包版里一个环境变量即可关掉沙箱闸，
// 让「沙箱不可用」退化成静默裸跑（本函数上方语义第 1 条明确要求默认阻断）。故仅在未打包时接受；
// 打包版仍保留第 2 条逃生口（单次 unconfined_exec 审批），不会把人堵死。取不到 electron 视为未打包。
function isPackaged() {
  // 取不到 electron 判为「未打包」⇒ 放行那个「开发态」环境变量逃生口（C5 收紧过的那条）。
  // 主进程里 electron 恒可用，故正常路径不会走到；一旦走到就是「打包版被当成开发态」的方向，
  // 必须留痕——它会让 LLM 有机会用环境变量关掉沙箱闸。
  try { return require('electron').app?.isPackaged === true; } catch (e) { console.warn('[execFallback] 无法判定是否打包，按未打包处理（开发态逃生口可能生效）：', e?.message || e); return false; }
}

/**
 * 统一的非沙箱执行落点。
 * @param {object} ctx
 * @param {(result:object)=>void} ctx.resolve 外层 Promise 的结算函数
 * @param {object} ctx.deps 工具层依赖（requestApproval / registerChild）
 * @param {string} ctx.policy 生效沙箱策略
 * @param {string} ctx.command 展示用命令（审计/审批文案）
 * @param {string[]|null} ctx.argvList argv 形态（非 null 时完全绕开 shell）
 * @param {string} ctx.cwd 执行目录
 * @param {object} ctx.cwdMeta 附加在结果上的 cwd 元信息
 * @param {number} ctx.timeout 实现侧超时（P1-2：由 timeouts.js 提供权威值）
 * @param {string} ctx.fallbackReason 为何没能 OS 级沙箱（自解释文案）
 * @param {boolean} ctx.neededApproval 本次是否经过审批（审计档位）
 * @param {string} ctx.ruleMatched 命中的审批规则（审计留痕）
 */
async function runUnconfinedShell({
  resolve, deps, policy, command, argvList, cwd, cwdMeta, timeout, fallbackReason, neededApproval, ruleMatched,
}) {
  if (policy !== 'full-access') {
    const envRequested = process.env.MJCODE_ALLOW_UNCONFINED_FALLBACK === '1';
    const envFallback = envRequested && !isPackaged();
    // 打包版忽略该变量时不静默：留一行 console（审计走下面的审批/阻断分支，不会漏记）
    if (envRequested && !envFallback) console.warn('[sandbox] 打包版忽略 MJCODE_ALLOW_UNCONFINED_FALLBACK（该豁免仅限开发态）');
    if (!envFallback) {
      if (!deps || typeof deps.requestApproval !== 'function') {
        audit('shell', command, `沙箱不可用且无审批通道，fail-closed 阻断（${fallbackReason}）`, 'blocked');
        resolve({
          stdout: '', stderr: `受限沙箱不可用（${fallbackReason}），且本次调用无审批通道，已按 fail-closed 阻断执行。`,
          exitCode: -1, error: 'sandbox-unavailable-blocked', errorCode: 'sandbox-unavailable',
          blocked: true, sandboxed: false, sandbox: { policy, sandboxed: false, reason: fallbackReason }, ...cwdMeta,
        });
        return;
      }
      const { decision, reason } = await awaitApproval(deps.requestApproval, 'unconfined_exec', { command });
      if (decision !== 'once') {
        audit('shell', command, `非沙箱执行未获显式批准（decision=${decision}${reason ? `，理由：${reason}` : ''}）`, 'blocked');
        resolve({
          stdout: '', stderr: `受限沙箱不可用（${fallbackReason}），非沙箱执行未获显式批准，已阻断。${reason ? `理由：${reason}` : ''}`,
          exitCode: -1, error: 'sandbox-unavailable-blocked', errorCode: 'sandbox-unavailable',
          blocked: true, sandboxed: false, sandbox: { policy, sandboxed: false, reason: fallbackReason }, ...cwdMeta,
        });
        return;
      }
      console.warn(`[sandbox] 用户显式批准单次非沙箱执行（${fallbackReason}）policy=${policy}`);
    } else {
      // P1-5：环境变量豁免同留审计痕——「谁在何时豁免了沙箱」必须可复盘，不能只进 console
      audit('shell', command, `unconfined-env 豁免（MJCODE_ALLOW_UNCONFINED_FALLBACK=1，${fallbackReason}）`, 'auto');
      console.warn(`[sandbox] MJCODE_ALLOW_UNCONFINED_FALLBACK=1：显式豁免单次审批，非沙箱执行（${fallbackReason}）policy=${policy}`);
    }
    // 黑名单守卫保留为纵深防御（非安全边界）：即使走到非沙箱执行，命中危险模式的命令仍然拒绝
    // 已确认走到这里 = 本次没有 OS 级沙箱兜底，显式传 backendAvail=false，避免再走平台推断
    const guard = sandbox.checkCommandGuard(policy, command, process.platform, false, false);
    if (guard.blocked) {
      audit('shell', command, guard.reason, 'blocked');
      resolve({ stdout: '', stderr: guard.reason, exitCode: -1, error: guard.reason, errorCode: 'command-guard-blocked', blocked: true, sandbox: { policy, sandboxed: false, reason: 'no-os-sandbox' }, ...cwdMeta });
      return;
    }
    console.warn(`[sandbox] 非沙箱执行（${fallbackReason}）policy=${policy}`);
  }
  // N2：argv 优先——execFile 直接执行，无 shell 面；字符串命令走显式 ShellProfile（非交互 /bin/sh -c）
  const finishShell = (error, stdout, stderr) => {
    const result = {
      stdout: (stdout || '').slice(0, 50000), stderr: (stderr || '').slice(0, 10000),
      exitCode: typeof error?.code === 'number' ? error.code : (error ? -1 : 0),
      // N2：真实进程终态——signal/killed 透出，不折叠成裸 -1；P0-6：非沙箱兜底如实标记未隔离+原因
      signal: error?.signal || null, killed: !!error?.killed,
      sandboxed: false, sandboxBackend: 'none', sandboxReason: fallbackReason,
      error: shellErrorNote(error),
      ...cwdMeta,
    };
    audit('shell', command, `cwd=${cwd} exitCode=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ''} rule=${ruleMatched}`, neededApproval ? 'approved' : 'auto');
    resolve(result);
  };
  if (argvList) {
    const child = execFileDetached(argvList[0], argvList.slice(1), { cwd, timeout, maxBuffer: 5 * 1024 * 1024, env: shellEnv() }, finishShell);
    deps.registerChild(child);
  } else {
    const sp = shellProfile.resolveShellProfile();
    if (!sp.ok) {
      audit('shell', command, `shell 不可用：${sp.reason}`, 'blocked');
      resolve({ stdout: '', stderr: `shell 不可用：${sp.reason}`, exitCode: -1, error: 'shell-unavailable', errorCode: 'shell-unavailable', blocked: true, ...cwdMeta });
      return;
    }
    const child = execFileDetached(sp.exe, [...sp.args, command], { cwd, timeout, maxBuffer: 5 * 1024 * 1024, env: shellEnv() }, finishShell);
    deps.registerChild(child);
  }
}

module.exports = { runUnconfinedShell };
