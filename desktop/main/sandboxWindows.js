// Windows OS 级沙箱后端
//
// 设计依据（2026-10 对齐 OpenAI Codex 的 Windows 方案）：
//   Codex 于 2026-05-13 公开的 Windows 沙箱设计**明确否决了三条路**：
//     · AppContainer —— 为「预先知道需要什么能力」的应用设计，而 Agent 要驱动
//       shell/git/python/包管理器，形态正好相反；
//     · Windows Sandbox —— 一次性虚拟机，Codex 必须操作用户真实 checkout，
//       且 Windows Home SKU 不提供；
//     · MIC 完整性降级 —— 把工作区标为低完整性会让它成为「低完整性进程普遍可写」
//       的宿主信任洼地，反而削弱宿主安全模型。
//   其最终方案是多个原语的**组合**：
//     受限令牌（write-restricted token）+ 合成 SID + 定向 ACL
//     + 两个专用本地用户（CodexSandboxOffline / CodexSandboxOnline）
//     + 防火墙规则 + 独立的 command-runner 二进制。
//   新版还支持 Microsoft Execution Containers（MXC），旧版 elevated/unelevated 为回退。
//
//   Node/Electron 落地的现实约束（本文件如实处理）：
//     · `CreateRestrictedToken` 是 Win32 API，无 native addon 时不可调用
//       （本项目刻意不引入 native 模块——better-sqlite3 的原生编译已在 CI 造成麻烦）；
//     · 创建本地用户、改 ACL、加防火墙规则**都需要管理员权限**。
//   因此本实现对应 Codex 的 **elevated 档**：一次性管理员设置 + 运行时以专用
//   低权用户身份启动命令。未完成设置时返回 { use: false }，由 sandbox.js 落到
//   跨平台命令守卫（30 条危险模式硬拦截）——即「设置前有基线防护，设置后有 OS 级隔离」。
//
//   P1-4 接线（2026-10-18）：此前本后端「代码在、但无入口」——README 自述
//   「OS-level isolation is not yet wired」。本轮补齐三件事：
//     ① setup entry point：applyWindowsSandboxSetup（提权执行一次性管理员设置）+ teardown；
//     ② read-only vs workspace-write 分档：buildWindowsExec 明确 tier（read-only 不授予
//        工作区写权限；workspace-write 需 cwd 且须先经 applyWorkspaceAcl 授权）；
//     ③ .git / .mjcode carve-out：applyWorkspaceAcl 对受保护路径追加 icacls /deny 写权限。
//   仍需用户执行一次管理员设置（UAC）后隔离才真正生效——设置未完成即落到命令守卫兜底。
//
//   已知局限（与 Codex 公开承认的相同）：
//     无法阻止对「Everyone SID 已有写权限」目录的写入（如 world-writable 文件夹）。
//     缓解：workspace-write 档只把项目目录设为可写，其余一律只读。
//     另：无法在本开发环境（macOS）实测真机提权/ACL 行为，故相关分支都以「可注入 runFn +
//     纯函数构造命令」的方式实现，把可验证的部分（命令构造/脚本渲染/分档）写成可单测。
//
// 安全纪律：
//   · 专用用户密码随机生成，经 Electron safeStorage（Windows 上即 DPAPI）加密后
//     存本机，不落明文、不进 git、不进日志；
//   · 设置过程生成的命令全部先由 windowsSandboxPlan() 产出供审计，再渲染成脚本提权执行；
//   · 任何一步失败即整体回滚（删除已创建的用户与防火墙规则），绝不伪造成功。
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX_USER_OFFLINE = 'MJCodeSandboxOffline';
const SANDBOX_USER_ONLINE = 'MJCodeSandboxOnline';
const FIREWALL_RULE_PREFIX = 'MJCodeSandbox';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 20000, ...opts }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// ── 状态探测 ──
// 专用用户是否存在（net user 返回 0 即存在）
async function windowsSandboxUserExists(user) {
  const r = await run('net', ['user', user]);
  return r.ok;
}

/**
 * 当前 Windows 沙箱是否已就绪。
 * 就绪条件：Offline 专用用户存在（Online 用户为可选增强，缺失不阻断）。
 */
async function windowsSandboxReady() {
  if (process.platform !== 'win32') return { ready: false, reason: '非 Windows 平台' };
  const offline = await windowsSandboxUserExists(SANDBOX_USER_OFFLINE);
  if (!offline) {
    return { ready: false, reason: `专用用户 ${SANDBOX_USER_OFFLINE} 不存在，需先执行一次性管理员设置` };
  }
  return { ready: true, reason: '' };
}

/**
 * 探测当前进程是否以管理员（提升）身份运行：`net session` 成功即视为已提权。
 * 诚实说明：`net session` 也可能因 Server 服务未运行而在低权下失败——两种情形都返回
 * elevated:false，由调用方在真正执行提权操作时以实际退出码为准，绝不据此伪造能力。
 * @param {{runFn?: Function, platform?: string}} [opts] 便于单测注入
 */
async function windowsIsElevated(opts = {}) {
  const { runFn = run, platform = process.platform } = opts;
  if (platform !== 'win32') return { elevated: false, reason: '非 Windows 平台' };
  const r = await runFn('net', ['session']);
  return { elevated: r.ok, reason: r.ok ? '' : 'net session 失败：当前进程可能未以管理员身份运行（或 Server 服务未启动）' };
}

// ── 设置计划（可审计）──
// 不直接执行，先产出命令清单供用户/审计查看；执行由调用方在管理员授权下进行。
/**
 * 生成一次性管理员设置要执行的命令清单。
 * @returns {{steps: Array<{id:string, cmd:string, args:string[], note:string}>, rollback: string[]}}
 */
function windowsSandboxPlan() {
  return {
    steps: [
      {
        id: 'create-offline-user',
        cmd: 'net',
        args: ['user', SANDBOX_USER_OFFLINE, '<RANDOM_PASSWORD>', '/add', '/passwordchg:no', '/passwordreq:yes', '/active:yes'],
        note: '创建离线专用用户（禁止出网）。密码由程序随机生成并 DPAPI 加密保存，不以明文出现在任何命令或日志中',
      },
      {
        id: 'create-online-user',
        cmd: 'net',
        args: ['user', SANDBOX_USER_ONLINE, '<RANDOM_PASSWORD>', '/add', '/passwordchg:no', '/passwordreq:yes', '/active:yes'],
        note: '创建在线专用用户（可选增强，用于允许出网的场景）',
      },
      {
        id: 'deny-interactive-logon',
        cmd: 'net',
        args: ['localgroup', 'Users', SANDBOX_USER_OFFLINE, '/delete'],
        note: '专用用户不加入 Users 组，避免交互式登录宿主桌面',
      },
      {
        id: 'block-outbound-firewall',
        cmd: 'netsh',
        args: ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE_PREFIX}_BlockOutbound`,
          `dir=out`, `action=block`, `user=${SANDBOX_USER_OFFLINE}`, 'enable=yes'],
        note: '防火墙阻断离线用户的全部出网（OS 级断网，对应 Linux 的 --unshare-net）',
      },
    ],
    rollback: [
      `netsh advfirewall firewall delete rule name=${FIREWALL_RULE_PREFIX}_BlockOutbound`,
      `net user ${SANDBOX_USER_OFFLINE} /delete`,
      `net user ${SANDBOX_USER_ONLINE} /delete`,
    ],
  };
}

// ── 工作区 ACL（workspace-write 档，含 .git/.mjcode 只读 carve-out）──
//
// 语义与 macOS/Linux 一致：项目目录整体可写，但其中的 .git / .mjcode 必须保持只读。
// Windows 的显式（explicit）ACE 优先于继承（inherited）ACE——在父目录授予 M 之后，
// 再对受保护路径显式 /deny W，即可压住从父目录继承来的写权限（与 Seatbelt 的
// 「后匹配规则优先」、bwrap 的「后挂载覆盖先挂载」等价）。
// 动机见 writeGuard.js：项目目录整体可写会把 .git 变可写，改写 .git/hooks/pre-commit 后
// 用户下次手动 git commit 会执行注入代码——沙箱约束不了用户之后的手动命令。

/** 受保护路径的 deny ACE：目录用 (OI)(CI)W 传导给子项，文件用裸 W。 */
function writeDenyAce(p, user) {
  let isDir = true;
  try { isDir = fs.statSync(p).isDirectory(); } catch { /* 探测不到按目录处理 ⇒ 用 (OI)(CI)W（更宽的 deny，方向偏安全），.git/.mjcode 常态也是目录 */ isDir = true; }
  return isDir ? `${user}:(OI)(CI)W` : `${user}:W`;
}

/**
 * 纯函数：构造工作区 ACL 命令序列（供单测断言与执行两用）。
 * 顺序即执行顺序：先移除继承 → 授予专用用户 M（可写）→ 逐个 carve-out deny W → 保留 SYSTEM 读取。
 * @returns {{ok:boolean, error?:string, target?:string, user?:string,
 *           commands?: Array<{id:string, cmd:string, args:string[], carveout?:string}>}}
 */
function buildWorkspaceAclCommands(cwd, user = SANDBOX_USER_OFFLINE, protectedPaths = []) {
  const target = String(cwd || '');
  if (!target) return { ok: false, error: 'workspace-write 需要项目目录' };
  const commands = [
    // 先移除继承（否则父目录的可写 ACL 会渗透进来），再显式授予
    { id: 'remove-inheritance', cmd: 'icacls', args: [target, '/inheritance:r'] },
    { id: 'grant-workspace-write', cmd: 'icacls', args: [target, '/grant', `${user}:(OI)(CI)M`] },
  ];
  for (const p of protectedPaths || []) {
    const sp = String(p || '').trim();
    if (!sp) continue;
    commands.push({ id: 'deny-carveout', cmd: 'icacls', args: [sp, '/deny', writeDenyAce(sp, user)], carveout: sp });
  }
  // 保留所有者与 SYSTEM 的读取，避免用户自己/系统服务反而进不去
  commands.push({ id: 'grant-system-read', cmd: 'icacls', args: [target, '/grant', 'SYSTEM:(OI)(CI)RX'] });
  return { ok: true, target, user, commands };
}

/**
 * 执行工作区 ACL 授权（workspace-write 档）。
 * 只动项目目录，不动系统目录——避免 MIC 方案那种「把工作区变成宿主信任洼地」的问题。
 * carve-out 失败按 fail-closed 处理：.git / .mjcode 可写正是要防的逃逸面，故整体判失败，
 * 由调用方（exec.js）落到命令守卫兜底。
 * @param {string} cwd
 * @param {string} user
 * @param {string[]} protectedPaths 受保护路径（来源 writeGuard.protectedPathsFor）
 * @param {{runFn?: Function, platform?: string}} [opts] 便于单测注入 runFn / platform
 */
async function applyWorkspaceAcl(cwd, user = SANDBOX_USER_OFFLINE, protectedPaths = [], opts = {}) {
  const { runFn = run, platform = process.platform } = opts;
  if (platform !== 'win32') return { ok: false, error: '非 Windows 平台' };
  const built = buildWorkspaceAclCommands(cwd, user, protectedPaths);
  if (!built.ok) return built;
  const carveouts = [];
  for (const c of built.commands) {
    const r = await runFn(c.cmd, c.args);
    if (c.carveout) {
      const detail = r.ok ? '' : String(r.stderr || r.stdout || '');
      carveouts.push({ path: c.carveout, ok: r.ok, error: detail });
      if (!r.ok) return { ok: false, error: `carve-out 失败（${c.carveout}）：${detail}`, target: built.target, user, carveouts };
      continue;
    }
    if (!r.ok) return { ok: false, error: `ACL 步骤 ${c.id} 失败：${String(r.stderr || r.stdout || '')}`, target: built.target, user };
  }
  return { ok: true, target: built.target, user, carveouts };
}

// ── 运行时启动参数 ──
/**
 * 构建以专用用户身份执行的启动参数（三档语义，P1-4）。
 *
 *   · full-access     —— 不沙箱（argv 为空，由调用方直跑）；
 *   · read-only       —— 以受限专用用户执行，**不授予工作区写权限**（无需 cwd）；
 *   · workspace-write —— 需要 cwd，且调用方须先经 applyWorkspaceAcl 授权工作区（含 carve-out）。
 *
 * 走 schtasks 而非 runas：runas 需要交互式输密码，无法在 Agent 无人值守流程中使用；
 * schtasks 可携带已保存的凭据，且能以指定用户身份派生进程。
 *
 * @param {string} policy   read-only | workspace-write | full-access
 * @param {string} cwd      项目目录
 * @param {string} command  要执行的命令
 * @param {string} user     专用用户
 * @returns {{argv: string[], backend: string, tier: string, reason: string, user?: string,
 *            taskName?: string, requiresWorkspaceAcl?: boolean}}
 */
function buildWindowsExec(policy, cwd, command, user = SANDBOX_USER_OFFLINE) {
  const tier = policy === 'full-access' ? 'full-access' : policy === 'read-only' ? 'read-only' : 'workspace-write';
  const base = { backend: 'windows-restricted-user', tier };
  if (tier === 'full-access') return { ...base, argv: [], reason: 'full-access 不沙箱' };
  if (tier === 'workspace-write' && !cwd) return { ...base, argv: [], reason: 'workspace-write 需要项目目录' };
  const taskName = `${FIREWALL_RULE_PREFIX}_Run_${process.pid}_${Date.now()}`;
  // schtasks /create /tn <name> /tr "<cmd>" /sc once /st 00:00 /ru <user> /rl limited /f
  // 然后 /run 触发，/delete 清理。无人值守场景下的标准做法。
  const argv = [
    'schtasks',
    '/Create', '/TN', taskName,
    '/TR', String(command || ''),
    '/SC', 'ONCE', '/ST', '00:00',
    '/RU', user,
    '/RL', 'LIMITED',
    '/F',
  ];
  return { argv, backend: 'windows-restricted-user', tier, reason: '', user, taskName, requiresWorkspaceAcl: tier === 'workspace-write' };
}

/**
 * 便捷：以专用用户身份执行（创建任务→运行→等待结束→删除任务）。
 *
 * P0 修复（2026-10-16）——原实现有三处导致「Agent 被系统性欺骗」：
 *   ① /Run 是**异步**的，返回时任务通常还在跑；原代码立即 /Delete，
 *      存在把正在运行的任务删掉的竞态。现改为轮询任务状态直到不再 Running 再清理。
 *   ② 原实现把 `schtasks` **自己的 stdout** 当作被沙箱命令的输出返回。
 *      schtasks 只回报「任务已触发」，不含被执行命令的任何输出。
 *   ③ 原实现不返回 exitCode，调用方（exec.js）遂硬编码 exitCode:0
 *      ⇒ 三者叠加的结果是：Agent 以为所有命令都成功，且看不到任何输出。
 *
 * 现改为**如实上报「结果不可知」**，绝不伪造成功。真正的输出捕获需要在 /TR 载荷里
 * 做重定向并回读，而受限用户对临时目录的 ACL 需 Windows 真机验证——在该验证完成前，
 * 宁可让调用方知道"不知道"，也不让它误以为成功。
 *
 * @param {string} policy  运行时档位（read-only / workspace-write），决定 tier 元信息
 * @returns {{ok: boolean, taskFinished?: boolean, stdout: string, stderr: string,
 *            exitCode: null|number, resultUnknown?: boolean, reason?: string,
 *            schtasksStdout?: string, schtasksStderr?: string}}
 */
async function execAsSandboxUser(command, cwd, user = SANDBOX_USER_OFFLINE, policy = 'workspace-write') {
  if (process.platform !== 'win32') return { ok: false, error: '非 Windows 平台' };
  const built = buildWindowsExec(policy, cwd, command, user);
  if (!built.argv.length) return { ok: false, error: built.reason };
  const create = await run(built.argv[0], built.argv.slice(1));
  if (!create.ok) return { ok: false, error: `创建计划任务失败：${create.stderr || create.stdout}` };

  const runRes = await run('schtasks', ['/Run', '/TN', built.taskName]);

  // 等任务真正结束再删：/Run 返回 ≠ 命令已执行完
  let finished = false;
  for (let i = 0; i < 80; i++) {
    const q = await run('schtasks', ['/Query', '/TN', built.taskName, '/FO', 'CSV']);
    if (!/\bRunning\b/i.test(q.stdout || '')) { finished = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }

  await run('schtasks', ['/Delete', '/TN', built.taskName, '/F']);

  return {
    ok: runRes.ok && finished,
    taskFinished: finished,
    schtasksStdout: runRes.stdout,
    schtasksStderr: runRes.stderr,
    stdout: '',
    stderr: '',
    exitCode: null,
    resultUnknown: true,
    reason: 'Windows 受限用户执行：schtasks 无法回传被沙箱命令的 stdout/exitCode',
  };
}

// ── 一次性管理员设置：密码 / 提权 / 脚本渲染 / 执行 / 卸载（P1-4）──
//
// 安全纪律：
//   · 密码只经 PowerShell 单引号字面量注入（字符集已剔除引号与 shell 元字符），
//     经 Electron safeStorage（Windows 上即 DPAPI）加密后存本机，绝不落明文、不进日志；
//   · 设置的命令清单全部先由 windowsSandboxPlan() 产出（供 UI 审计），渲染成脚本再提权执行；
//   · 任一步非零退出即回滚（删除已建用户与防火墙规则）并退出非零，绝不假装成功。

// 密码字符集：只含对 PowerShell 单引号串与 `net user` 都安全的字符——
// 剔除 ' " ` $ % ! ^ & | < > ( ) ; , \ / 与空白，避免破坏命令解析或引入注入面。
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.@#+=~';

/**
 * 生成沙箱专用用户的随机密码（纯函数，crypto 随机，默认 32 字符）。
 * 采用拒绝采样消除取模偏差；返回值绝不可写入日志或以明文命令形式落盘。
 */
function generateSandboxPassword(length = 32) {
  const n = Math.max(16, Number(length) || 32);
  const out = [];
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b >= 256 - (256 % PASSWORD_ALPHABET.length)) continue; // 拒绝采样：丢弃会造成偏差的尾部字节
      out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]);
      if (out.length >= n) break;
    }
  }
  return out.join('');
}

// PowerShell 单引号字面量：仅需把 ' 翻倍转义。
function psLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
// 可执行名：仅当形如安全标识符时裸写，否则加引号（避免拼接面）。
function psExecutable(cmd) {
  const c = String(cmd || '');
  return /^[A-Za-z0-9_.-]+$/.test(c) ? c : psLiteral(c);
}
// 单步命令 → PowerShell 调用串（密码占位符替换为真实值，全部经单引号字面量包裹）。
function renderStepInvocation(step, password) {
  const args = (step.args || []).map((a) => {
    const s = String(a);
    return psLiteral(s === '<RANDOM_PASSWORD>' ? password : s);
  });
  return `& ${psExecutable(step.cmd)}${args.length ? ` ${args.join(' ')}` : ''}`;
}

/**
 * 纯函数：把设置计划渲染成一段 PowerShell 脚本（含「失败即回滚」逻辑）。
 * 任一步骤以非零退出即进入失败分支：执行 plan.rollback 的全部命令后以非零码退出；
 * 全部成功则以 0 退出。密码以单引号字面量注入，绝不落日志。
 * @param {{steps: Array<{id:string,cmd:string,args:string[],note:string}>, rollback: string[]}} plan
 * @param {string} password
 * @returns {string}
 */
function renderSandboxSetupScript(plan, password) {
  const steps = (plan && plan.steps) || [];
  const rollback = (plan && plan.rollback) || [];
  const lines = [];
  lines.push('# === MJCode Windows OS-level sandbox: one-time administrator setup ===');
  lines.push('# Generated from windowsSandboxPlan(); the password literal is injected at runtime and never logged.');
  lines.push('# Any non-zero step triggers a full rollback of plan.rollback commands, then exits non-zero.');
  lines.push("$ErrorActionPreference = 'Continue'");
  lines.push('$mjcodeFailed = $null');
  lines.push('$mjcodeRollback = @(');
  rollback.forEach((c) => lines.push(`  ${psLiteral(c)},`));
  lines.push(')');
  lines.push('function Invoke-MjcodeRollback {');
  lines.push('  foreach ($mjcodeCmd in $mjcodeRollback) { try { Invoke-Expression $mjcodeCmd } catch { Write-Warning $_ } }');
  lines.push('}');
  lines.push('try {');
  for (const s of steps) {
    lines.push(`  # [${s.id}] ${String((s && s.note) || '').replace(/\r?\n/g, ' ')}`);
    lines.push(`  ${renderStepInvocation(s, password)}`);
    lines.push(`  if ($LASTEXITCODE -ne 0) { throw "step ${s.id} failed (exit $LASTEXITCODE)" }`);
  }
  lines.push('} catch {');
  lines.push('  $mjcodeFailed = $_');
  lines.push('}');
  lines.push('if ($null -ne $mjcodeFailed) {');
  lines.push('  Write-Error "MJCode sandbox setup failed, rolling back: $mjcodeFailed"');
  lines.push('  Invoke-MjcodeRollback');
  lines.push('  exit 1');
  lines.push('}');
  lines.push('exit 0');
  return lines.join('\n');
}

/**
 * 执行一次性管理员设置（**提权**）。
 *
 * 流程：平台守卫 → 生成随机密码 → 从 windowsSandboxPlan() 渲染脚本 → 写临时 .ps1 →
 *      以 `Start-Process -Verb RunAs -Wait -PassThru` 提权执行（UAC 弹窗）→ 删除临时脚本 →
 *      seal(password) 后写 storageDir/windows-sandbox.json → 复检 windowsSandboxReady()。
 *
 * 任一步失败**如实返回错误**，绝不伪造成功；未提供 seal（无 DPAPI）时在**执行前**即失败，
 * 避免创建出密码无法安全保存的专用用户。
 *
 * @param {{runFn?: Function, seal?: (plain:string)=>Buffer|string, storageDir?: string,
 *          platform?: string, readyFn?: Function, tmpDir?: string, now?: ()=>string}} [opts]
 */
async function applyWindowsSandboxSetup(opts = {}) {
  const {
    runFn = run, seal, storageDir, platform = process.platform,
    readyFn = windowsSandboxReady, tmpDir = os.tmpdir(), now = () => new Date().toISOString(),
  } = opts;
  if (platform !== 'win32') {
    return { ok: false, error: 'not-supported', reason: `Windows OS 级沙箱仅在 Windows 上可用（当前平台：${platform}）` };
  }
  if (typeof seal !== 'function') {
    return { ok: false, error: 'no-seal', reason: '安全存储（safeStorage / DPAPI）不可用，拒绝以明文保存沙箱凭据' };
  }
  if (!storageDir) return { ok: false, error: 'no-storage', reason: '缺少应用数据目录，无法保存沙箱凭据' };

  const password = generateSandboxPassword(32);
  const script = renderSandboxSetupScript(windowsSandboxPlan(), password);
  const scriptPath = path.join(tmpDir, `mjcode-sandbox-setup-${crypto.randomBytes(8).toString('hex')}.ps1`);
  try {
    fs.writeFileSync(scriptPath, script, { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, error: 'script-write-failed', reason: `写入设置脚本失败：${e?.message || e}` };
  }

  // 提权执行：外层 powershell 用 Start-Process -Verb RunAs 触发 UAC，-Wait 等内层脚本跑完，
  // 再把内层退出码原样透出（用户取消 UAC 时 Start-Process 抛错 → 非零退出，如实上报）。
  const innerArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath].map(psLiteral).join(', ');
  const command = `$ErrorActionPreference='Stop'; try { $p = Start-Process -FilePath ${psLiteral('powershell')} -Verb RunAs -Wait -PassThru -ArgumentList @(${innerArgs}); exit $p.ExitCode } catch { Write-Error $_; exit 1 }`;
  let runResult;
  try {
    runResult = await runFn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeout: 300000 });
  } catch (e) {
    runResult = { ok: false, code: 1, stdout: '', stderr: String(e?.message || e) };
  } finally {
    // 临时脚本含明文密码，无论成败都必须删除。
    try { fs.rmSync(scriptPath, { force: true }); } catch { /* 尽力而为 */ }
  }
  if (!runResult || !runResult.ok) {
    return {
      ok: false, error: 'elevated-failed',
      reason: '管理员设置未完成（可能是用户取消了 UAC，或某一步失败并已回滚）',
      exitCode: runResult ? runResult.code : null,
      stderr: String((runResult && (runResult.stderr || runResult.stdout)) || '').slice(0, 2000),
    };
  }

  // 加密保存密码（DPAPI）。加密失败同样如实上报，且不落明文。
  let storedPath = '';
  try {
    const sealed = seal(password);
    const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(String(sealed), 'utf8');
    storedPath = path.join(storageDir, 'windows-sandbox.json');
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(storedPath, JSON.stringify({
      version: 1,
      users: [SANDBOX_USER_OFFLINE, SANDBOX_USER_ONLINE],
      passwordEnc: buf.toString('base64'),
      createdAt: now(),
      note: 'DPAPI(safeStorage) 加密；仅供主进程解密使用，请勿提交或外传',
    }, null, 2), { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, error: 'seal-failed', reason: `保存加密凭据失败：${e?.message || e}` };
  }

  const ready = await readyFn();
  return {
    ok: !!ready?.ready,
    ready: !!ready?.ready,
    readyReason: ready?.reason || '',
    storedPath,
    passwordSaved: true,
    platform,
    error: ready?.ready ? '' : 'not-ready',
    reason: ready?.ready ? '' : `设置已执行，但就绪复检未通过：${ready?.reason || '未知原因'}`,
  };
}

/**
 * 卸载 Windows OS 级隔离：执行 plan.rollback（删除防火墙规则 + 两个专用用户），
 * 并删除已存的加密凭据文件。逐条如实回报结果，不伪造成功。
 * @param {{runFn?: Function, storageDir?: string, platform?: string}} [opts]
 */
async function windowsSandboxTeardown(opts = {}) {
  const { runFn = run, storageDir, platform = process.platform } = opts;
  if (platform !== 'win32') {
    return { ok: false, error: 'not-supported', reason: `Windows OS 级沙箱仅在 Windows 上可用（当前平台：${platform}）` };
  }
  const results = [];
  let ok = true;
  for (const line of windowsSandboxPlan().rollback) {
    const [cmd, ...args] = String(line).trim().split(/\s+/);
    const r = await runFn(cmd, args);
    results.push({ id: cmd, args, ok: r.ok, error: r.ok ? '' : String(r.stderr || r.stdout || '') });
    if (!r.ok) ok = false;
  }
  let removedStorage = false;
  if (storageDir) {
    try {
      const p = path.join(storageDir, 'windows-sandbox.json');
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removedStorage = true; }
    } catch { /* 尽力而为 */ }
  }
  return { ok, results, removedStorage, platform };
}

module.exports = {
  SANDBOX_USER_OFFLINE,
  SANDBOX_USER_ONLINE,
  FIREWALL_RULE_PREFIX,
  windowsSandboxUserExists,
  windowsSandboxReady,
  windowsIsElevated,
  windowsSandboxPlan,
  writeDenyAce,
  buildWorkspaceAclCommands,
  applyWorkspaceAcl,
  buildWindowsExec,
  execAsSandboxUser,
  generateSandboxPassword,
  renderSandboxSetupScript,
  applyWindowsSandboxSetup,
  windowsSandboxTeardown,
};
