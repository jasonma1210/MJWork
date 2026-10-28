// T2-1：Agent 工具执行层（自主进程 main.js 原样搬移，行为不变）
// 覆盖：shell（三平台 OS 沙箱 + 审批 + 命令守卫）/ 写工具编排（白名单判定 + 审批 + 审计；,//       写实现本体在 ./execWrite.js）/ 读与列举 / 文件预览与系统打开 / list_dir·grep·glob / Git 工具（argv 化）。
// IPC 注册在本模块内完成（与 main.js 顶层注册等价，注册顺序无行为差异）。
//
// 依赖注入：initToolExec({ requestApproval, applyApprovalDecision, getAlwaysRules, conversationRules })
//   - 审批中心（requestApproval/applyApprovalDecision/alwaysRules/conversationRules）归属 main.js；
//   - audit/sandbox/writeGuard/approval 为独立模块，直接 require 同源单例。
// 导出供 main.js 复用：scheduledToolHandlers / createToolHandlers / 项目探测 runGit / MCP shellEnv。
const { ipcMain, shell } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const approval = require('../approval');
const sandbox = require('../sandbox');
const writeGuard = require('../writeGuard');
const { audit } = require('../audit/auditLog');
// P1-4：审批拒绝理由的取回与文案（单一事实来源在 main/approvalChannel.js）
const { approvalReasonOf, denialText } = require('../approvalChannel');
const { ipcGovernance } = require('./execGovernance'); // P0-5：直连 IPC 治理参数强制覆写
const { registerGitHunkIpc, registerDestructiveGitIpc } = require('../ipc/gitHunks'); // hunk 级接受/拒绝 + 破坏性 git 操作（带审批）
// X14：直连写通道的载荷边界（两种返回约定见 main/ipc/toolPayload.js 顶部）
const { payloadShapeError } = require('../ipc/toolPayload');

let deps = null;
// P1-4：审批等待统一入口——返回 { decision, reason }，拒绝点把理由拼进工具结果与审计行
async function awaitApproval(requestApproval, tool, args) {
  const waitP = requestApproval(tool, args);
  return { decision: await waitP, reason: approvalReasonOf(waitP) };
}
function initToolExec(d) {
  deps = d; // { requestApproval, applyApprovalDecision, getAlwaysRules, conversationRules, registerChild }
  registerIpc();
}

// ── P2-7：「执行后告知」的调用点封装（正交布尔偏好，缺省关闭 → 零破坏）──
//
// 三件事必须一起成立才有意义：
//   · 审计已在各分支无条件留痕（本函数不发 audit，也绝不用通知替代审计）；
//   · 只在「没弹卡就执行了」的动作上发（弹过卡的用户刚点过确认，再发是打扰）——
//     该判定在 approval.notifyExecuted 内部（它会重算 needsApproval，语义单点是它）；
//   · L1 高危不发（通知不能替代阻断），approval.notifyExecuted 内部会拒并留日志。
function notifyExecutedIfEnabled(tool, args, startedAt, result) {
  try {
    approval.notifyExecuted({
      enabled: approvalSettings.getUserApprovalNotice(),
      tool,
      args,
      approvalMode: (args && args.approvalMode) || 'on-request',
      conversationId: args && args.conversationId,
      alwaysRules: deps && typeof deps.getAlwaysRules === 'function' ? deps.getAlwaysRules() : [],
      conversationRules: (deps && deps.conversationRules) || [],
      ok: !(result && (result.error || result.blocked || result.ok === false)),
      ms: Date.now() - startedAt,
      error: (result && result.error) || '',
    });
  } catch (e) {
    // 通知是「补充信息」：它失败绝不能污染已经发生的执行结果
    console.warn('[approval] 执行后告知发送失败（不影响执行结果）:', e.message);
  }
}

// 打包版 GUI 进程（Finder/Dock 启动）继承的 PATH 极简（/usr/bin:/bin:/usr/sbin:/sbin），
// homebrew（node/npm/git 等用户工具）全部找不到——真机复盘：模型被迫每轮先
// `export PATH=...` 自救，白烧轮次。统一为子 shell 注入完整 PATH，沙箱内外一致。
//
// 2026-10-16：PATH 逻辑抽到 ./shellEnv.js。原内联实现用 POSIX 常量 + ':' 拼接，
// 在 Windows 上会把整串当单个非法目录条目 ⇒ node/npm/git/python 全部 ENOENT；
// 且取 HOME 在 Windows 上取不到（应取 USERPROFILE）。抽模块同时避免本文件
// 触及 800 行 max-lines 上限（该门禁正是为防上帝文件而设）。
const { shellEnv, SHELL_PATH } = require('./shellEnv');
// P2-7：用户偏好「执行后告知」（正交布尔，缺省关闭）+ 审批中心的通知出口
const approvalSettings = require('../approvalSettings');
// N2 执行契约（cwd 信任 + 真实进程终态描述 + 工具路径解析）抽到 ./execCwd.js
const { shellErrorNote, resolveToolCwd, defaultToolCwd, resolveToolPath } = require('./execCwd');
// P0-1：detached 子进程执行器（execFile 的 detached 选项被 Node 静默丢弃，见该模块注释）
const { execFileDetached } = require('./execFileDetached');
// N2 ShellProfile + argv 优先（字符串命令显式 shell 契约；argv 数组完全绕开 shell）
const shellProfile = require('../cmd/shellProfile');
// 文件预览单元（file:preview，2026-10-16 拆出）
const preview = require('./previewTool');
// P1-2：超时数字单一事实来源（与 webTools.js / 引擎看门狗对账；见 tools/timeouts.js 的不变式说明）
// 注意：PATCH_IMPL_TIMEOUT_MS 随写实现本体迁至 ./execWrite.js，门禁断言已同步下移
// （test/timeouts-contract.test.mjs 同时读两个文件）。
const {
  SHELL_DEFAULT_TIMEOUT_MS,
  GREP_IMPL_TIMEOUT_MS, FIND_IMPL_TIMEOUT_MS,
  GIT_IMPL_TIMEOUT_MS, GIT_QUICK_TIMEOUT_MS,
} = require('./timeouts');
// 非沙箱兜底执行路径（P1-2 前置抽离：本文件 800 行门禁，改默认超时前必须先抽）
const { runUnconfinedShell } = require('./execFallback');
const { outsideWriteTarget, targetMissing, executeWriteTool } = require('./execWrite'); // 2026-10-20 抽出（D-13-b）：写实现本体，见该文件头

// 命令失败审查修复（真机复盘 2026-10-14）：
// 1）execFile 的 err.message 是 "Command failed: <file> <args 全文>"——沙箱路径下 args 含整个
//    Seatbelt profile（数千字符），每次非零退出都把 profile 全文灌进模型上下文，
//    并让「Command failed」成为模型看到的主信号（stdout 里明明已有答案）。
// 2）链式命令（a; b; c）退出码只取最后一段：探测类命令（ls 不存在的目录、env|grep 无命中）
//    非零退出是正常控制流，不是失败。
// 统一收敛为简洁的退出码说明；stdout/stderr 原样返回（答案在输出里，不靠 error 字段）。
// 仅真正的 spawn 异常（ENOENT 等，code 非数字且非 killed）保留原始 message。
// （shellErrorNote 已抽至 ./execCwd.js，2026-10-16）

// P0-D：工具实现提取为命名函数——IPC 处理器与定时任务 Agent 执行通道共用同一实现
async function runShellTool(args) {
  // P1-2：默认 60s → SHELL_DEFAULT_TIMEOUT_MS(480s)。三层超时不变式「实现侧 < 看门狗」此前是反的：
  // 引擎看门狗给 shell 600s，实现侧 60s 就自己断了 ⇒ 引擎的超时表永远轮不到报错（空转）。
  // 引擎显式下发的 args.timeout 依旧优先（上层可为单次调用收紧）。
  const { timeout = SHELL_DEFAULT_TIMEOUT_MS, approvalMode = 'on-request', conversationId, requireApproval = true, sandboxPolicy } = args;
  // N2 argv 优先（方案 §8.1）：模型可传 argv 数组（executable + args）——
  // 直接 execFile，完全不经过 shell（无拼接/展开/注入面），空格与 $ 等字面量按原样传递。
  // 给 argv 时忽略字符串 command；审批/守卫/审计用 argv 的空格连接形态展示。
  let argvList = null;
  let command = args.command;
  if (Array.isArray(args.argv)) {
    argvList = args.argv.map((v) => String(v)).filter((s) => s.length > 0);
    if (argvList.length === 0) {
      audit('shell', '(argv)', 'argv 为空数组', 'blocked');
      return { stdout: '', stderr: 'argv 为空：请提供非空的 [executable, ...args] 数组，或改用 command 字符串。', exitCode: -1, error: 'argv-empty', blocked: true };
    }
    command = argvList.join(' ');
  } else if (typeof command !== 'string' || !command.trim()) {
    return { stdout: '', stderr: 'command 为空：请提供要执行的命令字符串，或改用 argv 数组。', exitCode: -1, error: 'command-empty', blocked: true };
  }
  // N2：cwd 契约先行——执行位置不可信时拒绝执行（fail-closed）
  const cwdInfo = await resolveToolCwd(deps, args.cwd);
  if (!cwdInfo.ok) {
    audit('shell', command, `cwd 不可信：${cwdInfo.resolved}`, 'blocked');
    return { stdout: '', stderr: cwdInfo.error, exitCode: -1, error: 'cwd-not-found', blocked: true, cwd: cwdInfo.resolved };
  }
  const cwd = cwdInfo.resolved;
  const cwdMeta = { cwd, ...(cwdInfo.cwdFallback ? { cwdFallback: true } : {}) };
  let neededApproval = false;
  let ruleMatched = 'none'; // 审批规则命中情况（always/conversation/none），随审计留痕
  if (requireApproval) {
    const verdict = approval.needsApproval({ tool: 'shell', args: { command }, approvalMode, conversationId, alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules });
    if (verdict.matched) ruleMatched = verdict.matched;
    if (verdict.need) {
      neededApproval = true;
      // unattended 由宿主通道注入（定时任务/Worker）：审批终结器据此**立即 deny**，
      // 而不是在无人值守下等满 approvalChannel 的 120s 超时（模型重试几次就吃光 10 分钟墙钟，
      // 死因还会被写成「执行超时」，掩盖真正原因）。模型自己传的同名参数已在 agent-core 剥离。
      const { decision, reason } = await awaitApproval(deps.requestApproval, 'shell', { command, unattended: args.unattended === true });
      if (decision === 'deny') {
        audit('shell', command, reason ? `用户拒绝（理由：${reason}，cwd=${cwd}）` : `用户拒绝（cwd=${cwd}）`, 'denied');
        return { stdout: '', stderr: denialText(reason), exitCode: -1, error: 'Approval denied', ...cwdMeta };
      }
      deps.applyApprovalDecision(decision, 'shell', { command }, conversationId);
    }
  }
  // 三平台 OS 级沙箱（2026-10）：macOS Seatbelt / Linux bubblewrap / Windows 受限用户。
  // 方案对齐 OpenAI Codex（各后端实现见 main/sandbox*.js 顶部注释）。
  // P0-B fail-safe：调用方未显式指定策略时，有项目目录至少 workspace-write，无目录则 read-only。
  // 此前默认 full-access——任何漏传 sandboxPolicy 的新调用链（定时任务/CUA/skill 自造工具）都会无隔离直跑。
  // N2：cwd 判定用**原始入参**（cwd 现在恒有值=宿主默认根，不代表用户选定了项目）。
  const policy = sandboxPolicy || (args.cwd ? 'workspace-write' : 'read-only');
  // sb 仍是 macOS Seatbelt 的专用判定（shouldSandbox 历史上只管 darwin，保留语义不扩散）
  const sb = sandbox.shouldSandbox(policy, cwd);
  // 三平台各自的「为何没能 OS 级沙箱」原因，用于日志自解释。
  // Linux 走统一分发读取 bwrap 真实原因；Windows 的就绪态是异步的，此处只能给静态提示。
  // N3：macOS 的 Seatbelt 探测失败时会被下面的分支改写为可行动的真实原因。
  let fallbackReason = process.platform === 'linux'
    ? (sandbox.osSandboxUsable(policy, cwd).reason || 'bubblewrap 不可用')
    : (sb.reason || (process.platform === 'win32' ? 'Windows 受限用户沙箱未就绪' : 'seatbelt 不可用'));

  // 非沙箱兜底（策略闸 → 命令守卫 → 直跑）已抽到 ./execFallback.js（P1-2 前置腾行，行为不变）
  const runFallback = (resolve) => runUnconfinedShell({
    resolve, deps, policy, command, argvList, cwd, cwdMeta, timeout, fallbackReason, neededApproval, ruleMatched,
  });

  // ── macOS：Seatbelt ──
  // N3：先做真实可用性探测（sandbox-exec 存在 ≠ 能 apply；嵌套沙箱环境一律 Operation not permitted）。
  // 探测失败 → 落到统一兜底（V03：blocked / 单次 unconfined 审批），错误信息可行动。
  if (sb.use) {
    const belt = await sandbox.seatbeltUsable();
    if (!belt.ok) {
      fallbackReason = belt.reason;
      console.warn(`[sandbox] Seatbelt 不可真实应用（${belt.reason}），落到统一兜底`);
    } else {
      const profile = sandbox.buildSeatbeltProfileAuto(policy, cwd, writeGuard.protectedPathsFor(cwd));
      // N2：argv 优先——sandbox-exec 支持直接传程序 argv（不经过 /bin/zsh -c，无 shell 面）
      const sbArgv = argvList
        ? ['-p', profile, ...argvList]
        : ['-p', profile, '/bin/zsh', '-c', command];
      return new Promise((resolve) => {
        const seatbeltChild = execFileDetached(sandbox.SANDBOX_EXEC, sbArgv,
          { cwd, timeout, maxBuffer: 5 * 1024 * 1024, env: shellEnv() }, (error, stdout, stderr) => {
            const result = { stdout: (stdout || '').slice(0, 50000), stderr: (stderr || '').slice(0, 10000), exitCode: typeof error?.code === 'number' ? error.code : (error ? -1 : 0), signal: error?.signal || null, killed: !!error?.killed, error: shellErrorNote(error),
              sandboxed: !(error && (error.code === 'ENOENT' || error.code === 'EACCES')), sandboxBackend: 'seatbelt', ...(error && (error.code === 'ENOENT' || error.code === 'EACCES') ? { sandboxReason: `sandbox-exec 启动失败：${error.code}` } : {}), ...cwdMeta };
            audit('shell', command, `cwd=${cwd} sandbox=${policy} exitCode=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ''} rule=${ruleMatched}`, neededApproval ? 'approved' : 'auto');
            resolve(result);
          });
        // P0-1：沙箱路径同样接线（原来整个分支未注册，取消时 seatbelt 子进程存活）
        deps.registerChild(seatbeltChild);
      });
    }
  }

  // ── Linux：bubblewrap（ro-bind 全盘 + unshare-all 断网 + seccomp + 项目目录唯一可写）──
  if (process.platform === 'linux' && policy !== 'full-access') {
    // N2：bwrap 后端接收字符串命令；argv 用 POSIX 单引号转义降级（文档已注明，非精确等价）
    const shellCommand = argvList ? shellProfile.argvToShellCommand(argvList) : command;
    const built = sandbox.linuxBackend.buildBwrapExec(policy, cwd, shellCommand, '/bin/sh', null, writeGuard.protectedPathsFor(cwd));
    if (built.argv.length) {
      return new Promise((resolve) => {
        // P0-1：bwrap 分支原来完全未注册子进程（取消时 bubblewrap 包裹的进程全部存活）
        const bwrapChild = execFileDetached(built.argv[0], built.argv.slice(1),
          { cwd, timeout, maxBuffer: 5 * 1024 * 1024, env: shellEnv() }, (error, stdout, stderr) => {
            const result = { stdout: (stdout || '').slice(0, 50000), stderr: (stderr || '').slice(0, 10000), exitCode: typeof error?.code === 'number' ? error.code : (error ? -1 : 0), signal: error?.signal || null, killed: !!error?.killed, error: shellErrorNote(error),
              sandboxed: !(error && (error.code === 'ENOENT' || error.code === 'EACCES')), sandboxBackend: 'bubblewrap', ...(error && (error.code === 'ENOENT' || error.code === 'EACCES') ? { sandboxReason: `bubblewrap 启动失败：${error.code}` } : {}), ...cwdMeta };
            audit('shell', command, `cwd=${cwd} sandbox=bubblewrap/${policy} exitCode=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ''} rule=${ruleMatched}`, neededApproval ? 'approved' : 'auto');
            resolve(result);
          });
        deps.registerChild(bwrapChild);
      });
    }
    console.warn(`[sandbox] Linux 未走 bubblewrap（${built.reason}），落到命令守卫`);
  }

  // ── Windows：受限专用用户（需一次性管理员设置；未就绪/失败则落到命令守卫）──
  if (process.platform === 'win32' && policy !== 'full-access') {
    return new Promise((resolve) => {
      sandbox.windowsBackend.windowsSandboxReady().then(async (st) => {
        // P1-4：按策略分档——workspace-write 执行前先做工作区 ACL（含 .git/.mjcode carve-out），
        // read-only 不授予工作区写权限；ACL 失败视为未就绪 → 命令守卫兜底（fail-closed）。
        if (st.ready) {
          const acl = policy === 'workspace-write' ? await sandbox.windowsBackend.applyWorkspaceAcl(cwd, undefined, writeGuard.protectedPathsFor(cwd)) : { ok: true };
          if (acl.ok) {
            const r = await sandbox.windowsBackend.execAsSandboxUser(command, cwd, undefined, policy);
            if (r.ok) {
              audit('shell', command, `sandbox=windows-restricted-user/${policy} resultUnknown=true`, neededApproval ? 'approved' : 'auto');
              // P0 修复（2026-10-16）：原实现硬编码 exitCode:0 且 stdout 取 schtasks 自己的输出，
              // 两者叠加 ⇒ Agent 以为所有命令都成功、却看不到任何输出。这是系统性欺骗，
              // 且比"功能缺失"更危险——Agent 会基于假的成功继续下一步。
              // 现如实上报「结果不可知」+ 可行动提示，绝不伪造成功。
              resolve({
                stdout: '',
                stderr: '',
                exitCode: null,
                errorCode: 'result-unknown',
                resultUnknown: true,
                sandboxed: true,
                sandboxBackend: 'windows-restricted-user',
                sandbox: { policy, tier: policy, sandboxed: true, backend: 'windows-restricted-user' },
                error: r.reason || '',
                ...cwdMeta,
                hint: 'Windows 沙箱执行：命令的真实退出码与输出暂不可见（schtasks 无法回传）。'
                    + '请勿据此判断命令成功——若必须看到真实结果，可临时改用非沙箱模式（full-access）或在终端执行。',
              });
              return;
            }
            console.warn(`[sandbox] Windows 受限用户执行失败（${r.error}），落到命令守卫`);
          } else console.warn(`[sandbox] Windows 工作区 ACL 设置失败（${acl.error}），落到命令守卫`);
        } else {
          console.warn(`[sandbox] Windows 沙箱未就绪（${st.reason}），落到命令守卫`);
        }
        runFallback(resolve).catch((e) => resolve({ stdout: '', stderr: `命令执行异常：${e?.message || e}`, exitCode: -1, error: String(e?.message || e), errorCode: 'exec-failed' }));
      }).catch((e) => {
        // P0-5：windowsSandboxReady() reject、applyWorkspaceAcl 抛、execAsSandboxUser 抛
        // 三条路径此前都让外层 Promise 永不 settle ⇒ IPC tool:shell 永久挂起，
        // 模型侧只能等引擎 600s 看门狗，且报的是「执行超时」，真正原因被完全掩盖。
        // 与上面的 runFallback 分支同构：沙箱通道异常 → 落命令守卫（仍过危险命令黑名单），不静默、不伪造成功。
        console.warn('[sandbox] Windows 沙箱通道异常，落到命令守卫:', e?.message || e);
        runFallback(resolve).catch((e2) => resolve({ stdout: '', stderr: `命令执行异常：${e2?.message || e2}`, exitCode: -1, error: String(e2?.message || e2), errorCode: 'exec-failed' }));
      });
    });
  }

  return new Promise((resolve) => runFallback(resolve).catch((e) => resolve({ stdout: '', stderr: `命令执行异常：${e?.message || e}`, exitCode: -1, error: String(e?.message || e), errorCode: 'exec-failed' })));
}

// P2-7：shell 的执行有四个返回点（seatbelt / bwrap / windows / 兜底），
// 逐个插通知会漏，所以用外壳统一包一层：先把真实实现跑完，再按需发「执行后告知」。
// 注意 approvalMode/审批目标要与内层一致：内层用 `command`（argv 形态时是 argv 的连接串），
// 这里必须复算同样的值，否则 needsApproval 重算结果可能不同（漏发或多发）。
async function toolShell(args = {}) {
  const startedAt = Date.now();
  const result = await runShellTool(args);
  const command = Array.isArray(args.argv) && args.argv.length > 0
    ? args.argv.map((v) => String(v)).filter((s) => s.length > 0).join(' ')
    : args.command;
  notifyExecutedIfEnabled('shell', { ...args, command }, startedAt, result);
  return result;
}

async function toolReadFile({ path: p, cwd, offset, limit }) {
  // cwd 贯通：相对路径以项目目录为基准解析（此前按主进程 CWD 解析必然失败）
  const target = resolveToolPath(p, cwd);
  try {
    const content = await fsp.readFile(target, 'utf8');
    const lines = content.split('\n');
    const body = (offset !== undefined && limit !== undefined)
      ? lines.slice(offset, offset + limit).join('\n')
      : content;
    return { ok: true, path: target, content: body, totalLines: lines.length };
  } catch (err) {
    // 文件不存在是设计内的正常控制流（如 AGENTS.md 逐级向上探测），绝不 reject
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      // 错误信息必须包含「解析后的绝对路径」与「当前项目目录」：
      // 否则模型只知道「文件不存在」，无法判断是自己路径写错、
      // 还是该文件属于项目外的其他工程（如应用自身源码），只会反复重试同样的错路径。
      const base = cwd || process.cwd();
      const where = path.isAbsolute(p)
        ? `绝对路径不存在：${target}`
        : `相对路径已按当前项目目录解析：${target}（项目目录：${base}）。`
          + `若目标不在当前项目内，请改用绝对路径，或先用 list_dir 确认项目结构。`;
      const error = err.code === 'EISDIR'
        ? `${target} 是目录，不是文件。请改用 list_dir 浏览其内容。`
        : where;
      return { ok: false, notFound: true, path: target, cwd: base, error };
    }
    if (err.code === 'EACCES') return { ok: false, error: '没有读取权限' };
    return { ok: false, error: err.message };
  }
}

// 写操作统一走审批中心（L2）
const WRITE_TOOLS = ['writeFile', 'editFile', 'applyPatch'];
// P0-D：写工具编排保留在本文件（白名单外判定 → 审批 → 审计 → 通知）；写实现本体,// （executeWriteTool / outsideWriteTarget / patch 解析）2026-10-20 抽至 ./execWrite.js——,// exec.js 800 软档只剩 0 行余量，先拆再改（台账 D-13-b，见 role-clamp-parity 门禁注释）。

async function runWriteTool(toolName, args) {
  const writeStartedAt = Date.now(); // P2-7：执行后告知要报耗时
  const { approvalMode = 'on-request', conversationId, requireApproval = true, sandboxPolicy, ...rest } = args;
  const toolKey = { writeFile: 'write_file', editFile: 'edit_file', applyPatch: 'apply_patch' }[toolName];
  let ruleMatched = 'none'; // P1-C：审批规则命中情况随审计留痕

  // 期 3：只读文件能力档拒绝一切写工具（fsMode 判定单一事实来源在 writeGuard.isReadonlyFs；
  // fail-closed：不受审批档/「始终允许」规则影响，不提供单次放行口）。
  if (writeGuard.isReadonlyFs(deps.getGovernance && deps.getGovernance())) {
    audit(toolKey, rest.path || '(patch)', '只读文件能力档拒绝写入', 'blocked');
    return { ok: false, blocked: true, readOnly: true, error: '当前为「只读文件能力」档，已拒绝文件写入（可在「本机服务 → 能力降级」切换为读写）。' };
  }

  // ── 可写区内的只读 carve-out（对齐 Codex 当前沙箱架构）──
  // `.git`（含 worktree/submodule 的 gitdir）与应用自身配置目录：即使在项目目录内也**禁止写入**。
  // 与「白名单外写入」的关键区别：白名单外可由用户**单次批准**放行；此处不提供审批放行——
  // 它的用途是切断「Agent 改写 .git/hooks/pre-commit → 用户下次手动 git commit 触发注入代码」
  // 这条提权链，若可被一次批准打开，保护就等于默认不存在。
  // 唯一例外：显式选择 full-access 档（产品语义即「不隔离」，用户已知情）时不走本闸。
  const effectivePolicy = sandboxPolicy || (rest.cwd ? 'workspace-write' : 'read-only');
  if (effectivePolicy !== 'full-access' && rest.cwd) {
    const protectedPaths = writeGuard.protectedPathsFor(rest.cwd);
    const targets = toolName === 'applyPatch'
      ? writeGuard.patchTargets(rest.patch)
      : (rest.path ? [rest.path] : []);
    const hit = writeGuard.firstProtectedTarget(targets, protectedPaths, rest.cwd);
    if (hit) {
      audit(toolKey, rest.path || '(patch)', `受保护路径写入被拦截：${hit}`, 'blocked');
      return {
        ok: false, blocked: true, protectedPath: true, path: hit,
        error: `写入目标位于受保护路径内：${hit}。该路径受保护是为了防止篡改 git hooks / 应用配置导致的提权，`
          + '不接受审批放行。如确需修改，请由你本人手动操作；或显式切换到 full-access 档（该档不做隔离）。',
      };
    }
  }

  const outside = outsideWriteTarget(toolName, rest);
  if (outside) {
    if (!requireApproval || approvalMode === 'never') {
      audit(toolKey, rest.path || '(patch)', `白名单外写入被拦截：${outside}`, 'blocked');
      return { ok: false, blocked: true, outsideWhitelist: true, path: outside, error: `写入目标超出允许范围（仅限项目目录 / 应用数据 / 系统临时目录）：${outside}` };
    }
    const { decision, reason } = await awaitApproval(deps.requestApproval, toolKey, rest);
    if (decision === 'deny') {
      audit(toolKey, rest.path || '(patch)', reason ? `白名单外写入被拒绝：${outside}。理由：${reason}` : `白名单外写入被拒绝：${outside}`, 'denied');
      return { ok: false, error: denialText(reason), denied: true };
    }
    // 决策仅本次有效（once），不调用 applyApprovalDecision——白名单外路径不允许沉淀「始终允许」
  } else if (requireApproval) {
    const verdict = approval.needsApproval({ tool: toolKey, args: rest, approvalMode, conversationId, alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules });
    if (verdict.matched) ruleMatched = verdict.matched;
    if (verdict.need) {
      const { decision, reason } = await awaitApproval(deps.requestApproval, toolKey, rest);
      if (decision === 'deny') {
        audit(toolKey, rest.path || 'patch', reason ? `用户拒绝。理由：${reason}` : '用户拒绝', 'denied');
        return { ok: false, error: denialText(reason), denied: true };
      }
      deps.applyApprovalDecision(decision, toolKey, rest, conversationId);
    }
  }
  // 工具实现抛错绝不能冒泡成 IPC rejection：渲染层只能拿到一句 message，
  // 模型无从判断是路径错、文件被改过还是权限问题，只会用同样的参数再试一次
  // → 表现就是「明明改完了却一直循环不结束」。统一转成结构化失败，带上可行动上下文。
  let result;
  try {
    result = await executeWriteTool(toolName, rest);
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) };
    if (targetMissing(err)) {
      result.notFound = true;
      result.error = `${result.error}（目标：${rest.path || '(空)'}；项目目录：${rest.cwd || process.cwd()}）`;
    }
  }
  audit(toolKey, rest.path || '(patch)', `${result.error ? `error: ${result.error}` : 'ok'} rule=${ruleMatched}`, 'recorded');
  // P2-7：写类工具是「执行后告知」最常见的对象（一次静默覆盖就是一次不可见的数据变更）
  notifyExecutedIfEnabled(toolKey, { ...rest, approvalMode, conversationId }, writeStartedAt, result);
  return result;
}
// P0-D：提取为命名函数（IPC 与定时任务 Agent 通道共用）
async function toolListDir({ path: p, cwd } = {}) {
  const target = resolveToolPath(p, cwd);
  try {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory(), type: e.isDirectory() ? 'dir' : 'file' }));
  } catch (err) {
    // 返回空列表而非 reject：渲染层按数组消费，rejection 会在主进程刷 Electron 错误栈
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR' && err.code !== 'EACCES') {
      console.error(`[listDir] 读取目录失败：${target} — ${err.message}`);
    }
    return [];
  }
}

// grep：execFile argv 化，杜绝 LLM 可控参数注入 shell
async function toolGrep({ pattern, path: p, glob: include, cwd } = {}) {
  if (!pattern) return { matches: '' };
  const base = cwd || defaultToolCwd(deps); // N2：漏传不回主进程 cwd
  const args = ['-rn'];
  if (include) args.push('--include', String(include));
  args.push(String(pattern), p || '.');
  return new Promise((resolve) => {
    execFile('grep', args, { cwd: base, timeout: GREP_IMPL_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      resolve({ matches: (stdout || '').slice(0, 20000), cwd: base });
    });
  });
}

// glob：execFile argv 化
async function toolGlob({ pattern, path: p, cwd } = {}) {
  if (!pattern) return { files: [] };
  const base = cwd || defaultToolCwd(deps); // N2：漏传不回主进程 cwd
  const args = [p || '.', '-name', String(pattern), '-type', 'f', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'];
  return new Promise((resolve) => {
    execFile('find', args, { cwd: base, timeout: FIND_IMPL_TIMEOUT_MS }, (error, stdout) => {
      resolve({ files: (stdout || '').trim().split('\n').filter(Boolean).slice(0, 100), cwd: base });
    });
  });
}

// N2：无 cwd 时的统一默认执行根由 ./execCwd.js 提供（宿主注入：最近项目目录或 HOME）
// ── Git 工具（execFile argv 化 + cwd 贯通）──
// git 提交/暂存属于 L2 写操作，走审批中心
async function gitWithApproval(toolKey, args, gitArgs) {
  const gitStartedAt = Date.now(); // P2-7：执行后告知要报耗时
  const { approvalMode = 'on-request', conversationId, cwd, requireApproval = true } = args;
  let neededApproval = false;
  let ruleMatched = 'none'; // P1-C：审批规则命中情况随审计留痕
  if (requireApproval) {
    const verdict = approval.needsApproval({ tool: toolKey, args, approvalMode, conversationId, alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules });
    if (verdict.matched) ruleMatched = verdict.matched;
    if (verdict.need) {
      neededApproval = true;
      const { decision, reason } = await awaitApproval(deps.requestApproval, toolKey, args);
      if (decision === 'deny') {
        audit(toolKey, args.message || args.files || '', reason ? `用户拒绝。理由：${reason}` : '用户拒绝', 'denied');
        return { stdout: '', stderr: denialText(reason), error: 'Approval denied', denied: true };
      }
      deps.applyApprovalDecision(decision, toolKey, args, conversationId);
    }
  }
  const result = await runGit(gitArgs, cwd);
  audit(toolKey, args.message || args.files || '', `${result.error ? `error: ${result.error}` : 'ok'} rule=${ruleMatched}`, neededApproval ? 'approved' : 'auto');
  notifyExecutedIfEnabled(toolKey, args, gitStartedAt, result);
  return result;
}

// P0-D：提取为命名函数（IPC 与定时任务 Agent 通道共用）
const toolGitStatus = ({ cwd } = {}) => runGit(['status', '--short'], cwd);
const toolGitDiff = ({ cwd, staged } = {}) => runGit(['diff', ...(staged ? ['--staged'] : [])], cwd);
const toolGitLog = ({ cwd, count = 10 } = {}) => runGit(['log', '--oneline', `-${Math.min(Math.max(Number(count) || 10, 1), 100)}`], cwd);
const toolGitBranch = ({ cwd } = {}) => runGit(['branch', '-a'], cwd);
const toolGitCommit = (args = {}) => gitWithApproval('git_commit', args, ['commit', '-m', String(args.message || '')]);
const toolGitAdd = (args = {}) => {
  const list = Array.isArray(args.files) ? args.files.map(String) : String(args.files || '.').split(/\s+/).filter(Boolean);
  return gitWithApproval('git_add', args, ['add', ...list]);
};

function runGit(args, cwd) {
  const target = cwd || defaultToolCwd(deps); // N2：漏传不回主进程 cwd
  return new Promise((resolve) => {
    // P0-1：git 子进程同样注册 + detached（随运行取消终止）；无 run 上下文的直连 IPC 自动跳过
    const child = execFileDetached('git', args, { cwd: target, timeout: GIT_IMPL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: (stdout || '').slice(0, 30000), stderr: (stderr || '').slice(0, 5000), error: error?.message || null, cwd: target });
    });
    deps.registerChild(child);
  });
}

// ── IPC 注册（与 main.js 原注册一一对应，只搬移不改行为）──
function registerIpc() {
  ipcMain.handle('tool:shell', (_, payload) => toolShell(ipcGovernance(payload)));
  ipcMain.handle('tool:readFile', (_, payload) => toolReadFile(payload));
  for (const toolName of WRITE_TOOLS) {
    ipcMain.handle(`tool:${toolName}`, (_, args) => runWriteTool(toolName, ipcGovernance(args)));
  }

  // 预览元信息 + 二进制内容（文本类只回元信息，正文由 tool:readFile 分页取）——实现见 ./previewTool.js
  ipcMain.handle('file:preview', (_, payload) => preview.handleFilePreview(payload));

  // 用系统默认应用打开文件或目录（目录 → Finder / 资源管理器）
  ipcMain.handle('shell:openPath', async (_, { path: p, cwd } = {}) => {
    // X14：p 会交给 shell.openPath（系统级打开）——路径允许空格，但类型与长度必须守
    const bad = payloadShapeError({ path: p, cwd }, {
      path: 4096, cwd: { max: 4096, optional: true, allowEmpty: true },
    }, { kind: 'envelope' });
    if (bad) return bad;
    const target = resolveToolPath(p, cwd);
    try {
      if (!fs.existsSync(target)) return { ok: false, error: `路径不存在：${target}` };
      const err = await shell.openPath(target);
      if (err) return { ok: false, error: err };
      audit('open_path', target, '在系统中打开');
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 打开外链：只允许 http/https（shell.openExternal 能拉起任意协议处理器，
  // 传入 file:// 或自定义 scheme 等于把「打开任意本地程序」的能力暴露给渲染层）
  ipcMain.handle('shell:openExternal', async (_, { url } = {}) => {
    // X14：url 会交给 shell.openExternal（能拉起任意协议处理器）——协议白名单在下面，
    // 此处先守「必须是字符串且不超长」，避免超长串进 URL 解析器
    const bad = payloadShapeError({ url }, { url: { max: 4000, optional: true, allowEmpty: true } }, { kind: 'envelope' });
    if (bad) return bad;
    const raw = String(url || '').trim();
    let parsed;
    try { parsed = new URL(raw); } catch (e) { return { ok: false, error: '链接格式不正确' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `出于安全考虑，只允许打开 http/https 链接（当前：${parsed.protocol}）` };
    }
    try {
      await shell.openExternal(raw);
      return { ok: true, url: raw };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Git 环境信息（设置页 Git 面板：署名与可用性探测，只读）
  ipcMain.handle('tool:gitConfig', async (_, { cwd } = {}) => {
    const run = (args) => new Promise((resolve) => {
      execFile('git', args, { cwd: cwd || process.cwd(), timeout: GIT_QUICK_TIMEOUT_MS }, (err, stdout) => {
        resolve(err ? '' : String(stdout).trim());
      });
    });
    try {
      const [version, name, email, globalName, globalEmail] = await Promise.all([
        run(['--version']),
        run(['config', '--get', 'user.name']),
        run(['config', '--get', 'user.email']),
        run(['config', '--global', '--get', 'user.name']),
        run(['config', '--global', '--get', 'user.email']),
      ]);
      return {
        ok: true,
        available: !!version,
        version,
        // 仓库级署名优先展示（未配置时回落全局），空字符串表示未配置
        repoName: name, repoEmail: email,
        globalName, globalEmail,
        cwd: cwd || process.cwd(),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 在文件管理器中定位（高亮选中该条目而非打开）
  ipcMain.handle('shell:reveal', async (_, { path: p, cwd } = {}) => {
    const target = resolveToolPath(p, cwd);
    try {
      if (!fs.existsSync(target)) return { ok: false, error: `路径不存在：${target}` };
      shell.showItemInFolder(target);
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('tool:listDir', (_, payload) => toolListDir(payload));
  ipcMain.handle('tool:grep', (_, payload) => toolGrep(payload));
  ipcMain.handle('tool:glob', (_, payload) => toolGlob(payload));

  ipcMain.handle('tool:gitStatus', (_, p) => toolGitStatus(p));
  ipcMain.handle('tool:gitDiff', (_, p) => toolGitDiff(p));
  // hunk 级接受/拒绝（Per hunk stage / revert）——抽到 main/ipc/gitHunks.js，
  // 本文件已顶到 800 行门禁，且这块逻辑与 shell/读写工具无耦合。
  registerGitHunkIpc(ipcMain, deps);
  // 破坏性 git 操作（丢弃工作区改动 / 回退索引）：L3 审批 + 审计，见 main/ipc/gitHunks.js
  registerDestructiveGitIpc(ipcMain, deps, runGit);
  ipcMain.handle('tool:gitLog', (_, p) => toolGitLog(p));
  ipcMain.handle('tool:gitBranch', (_, p) => toolGitBranch(p));
  // X14：gitCommit / gitAdd —— 治理参数先覆写，再校验工具真正会看到的载荷
  ipcMain.handle('tool:gitCommit', (_, p) => {
    const payload = ipcGovernance(p);
    const bad = payloadShapeError(payload, { message: 20000, cwd: { max: 4096, optional: true, allowEmpty: true } });
    return bad || toolGitCommit(payload);
  });
  ipcMain.handle('tool:gitAdd', (_, p) => {
    const payload = ipcGovernance(p);
    // files：字符串（空格分隔）或数组两种形态，别的一律拒绝（'[object Object]' 会被当成路径）
    const bad = payloadShapeError(payload, { cwd: { max: 4096, optional: true, allowEmpty: true } }, { arrayKey: 'files' });
    return bad || toolGitAdd(payload);
  });
  // DiffReviewPanel：接受（add）/ 拒绝（checkout -- / restore --staged）
}

module.exports = {
  initToolExec,
  toolShell,
  toolReadFile,
  runWriteTool,
  toolListDir,
  toolGrep,
  toolGlob,
  toolGitStatus,
  toolGitDiff,
  toolGitLog,
  toolGitBranch,
  toolGitCommit,
  toolGitAdd,
  resolveToolPath,
  previewKindOfMime: preview.previewKindOfMime,
  handleFilePreview: preview.handleFilePreview,
  shellEnv,
  SHELL_PATH,
  runGit,
};
