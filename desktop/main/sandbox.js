// macOS Seatbelt 沙箱：profile 生成（纯函数，可单测）+ 可用性探测 + 跨平台兜底守卫
//
// 2026-10 对齐 OpenAI Codex 的 macOS 方案后的两处加固：
//   ① read-only 档不再依赖 `(allow file-read*)` 的宽放语义，而是显式补一份
//      「macOS 平台策略」——放行 shell/git/node 等工具运行时必需的framework 与
//      系统配置路径，而不是宽放整个 /System。Codex 的做法同样如此
//      （"appends a curated macOS platform policy instead of broadly allowing /System"）。
//      宽放 /System 会让恶意命令读到本不该读的系统内部状态，收紧后仍需保证工具链可用。
//   ② 支持 denial 日志（等价于 Codex 的 --log-denials）：profile 末尾追加
//      `(deny file-write* (with no-log))` 的反向声明，使被拒操作可在系统日志追溯，
//      便于用户排查「为什么某命令在沙箱里失败」。
const fs = require('fs');
const os = require('os');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// macOS 平台策略：工具链运行时必需的只读路径（收紧 /System 后的补偿）
// 只放行「执行与配置读取」所需，不放行 /System 全树。
// 注：曾尝试追加 `(deny file-write* (with no-log))` 以实现等价 Codex --log-denials 的
// 被拒审计，但该修饰符的合法性无法在本开发环境验证（此环境 sandbox-exec 被外层沙箱
// 拦截，三种 profile 变体均无法实际 apply）。不能把未验证的语法上线，故移除该特性；
// 需要时可另行验证后再加回。
const MACOS_PLATFORM_POLICY = [
  '(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share"))',
  '(allow file-read* (subpath "/private/etc") (subpath "/etc"))',
  '(allow file-read* (literal "/usr/bin/env") (literal "/bin/sh") (literal "/bin/zsh"))',
  '(allow file-read* (subpath "/Library/Apple") (subpath "/Library/Preferences"))',
  '(allow mach-lookup (global-name "com.apple.system.logger"))',
  '(allow sysctl-read)',
  '(allow process-exec (subpath "/usr/bin") (subpath "/bin") (subpath "/usr/sbin") (subpath "/sbin"))',
  '(allow process-fork)',
];

// P0-S1：跨平台兜底守卫的危险命令规则改为与审批层**同源**（来自 dangerousPatterns.js）。
// 事故背景：此前这里是 12 条、approval.js 是 10 条，两份手抄副本各自漂移，
// 导致「审批层比沙箱层宽松」——两层守卫同时被绕过。现在两层共用同一份规则集，
// 从结构上杜绝再次漂移（新增危险模式只需改dangerousPatterns.js 一处）。
const { DANGEROUS_PATTERNS } = require('./dangerousPatterns');
// 保留旧名导出，避免外部引用断裂（测试与main.js 均按此名引用）
const FALLBACK_DANGEROUS = DANGEROUS_PATTERNS;

// 三平台全量接通 OS 级沙箱后（2026-10），兜底守卫的判定必须按「当前平台真正的后端」
// 走，而不是写死 darwin：
//   · darwin  → sandbox-exec 是否存在
//   · linux   → bwrap **真正可用**（B3-#11-A：走 TTL 缓存后的真探测，不再是「装了吗」）
//   · win32   → 就绪态是异步的（net user 查询），同步无法判定 → 保守按不可用，守卫生效
// 这样做的原因：OS 级沙箱已把破坏面限制在项目目录内，此时再叠黑名单会误伤
// 「rm -rf ./build」这类项目内合理命令；反过来，没有 OS 沙箱时必须靠黑名单兜底。
// 第 5 参 backendAvail 允许调用方传入**已确认**的可用性（如 Windows 异步探测结果），
// 传入时不再走推断。
//
// Linux 分支历史口径是 `!!findBwrap()`（只看二进制存在）。那是**第二处 fail-open**，
// 而且与 detectBackend 的修正方向相反，会形成更糟的组合：
//   本层（沿用旧口径）以为「有沙箱」→ 跳过 30 条黑名单；同时 detectBackend（已修正）
//   如实报 none → 真沙箱也没有 ⇒ **两层同时失效**，破坏面比不修还大。
// 现改为读同一个缓存真探测（linuxSandboxStatusCached），双层判定同源：
//   available=true ⇒ 命名空间隔离能建起来，黑名单让位是安全的；
//   available=false ⇒ OS 级隔离不存在，黑名单必须兜住。
// 开销：TTL 内 = 一次字符串比较 + Date.now()；冷缓存那一次由**本次调用自身**承担
// （同步探测一次，之后按 TTL 摊销）。刻意不做模块加载期预热，理由见文件末尾。
// { platform } 必须**显式传**：否则这里（可能被注入 platform 的调用方/测试）会拿到
// process.platform 口径的缓存键，度量对象就错配了——注意 detectBackend() 调同一函数
// 是**不带** platform 的（它取 process.platform，正确），两处看着不一致但都对；
// 为了「两处写法统一」把这个参数删掉，缓存键会退化成 not-linux:darwin，结果测试绿、真机错。
function defaultOsSandboxAvailable(platform, execExists) {
  // P0-2：darwin 也要与执行判定同源。此前只看 `sandbox-exec` 二进制是否存在，
  // 于是「probe 已判定不可用（嵌套沙箱 / profile 被系统拒绝）」时守卫仍认为有沙箱 ⇒ 跳过黑名单，
  // 与 detectBackend / describeCapability 的判断相反。有探测结果时一律以它为准；
  // 尚未探测时退回「二进制存在」的保守推断（不在这里做同步 spawn，理由见文件末尾不做预热的注释）。
  // 注：execFallback 这条真实调用链本身已显式传 backendAvail=false，不受本分支影响 —— 本次修的是
  // 「将来有人用默认参数调用」以及 probe 与 execExists 结论打架的窗口。
  if (platform === 'darwin') return seatbeltProbe ? seatbeltProbe.ok === true : !!execExists;
  if (platform === 'linux') return !!linuxBackend.linuxSandboxStatusCached({ platform }).available;
  return false;
}

// 拦截文案里的平台专属修复提示：用户被拦时最需要的是「下一步怎么做」
const OS_SANDBOX_HINT = {
  linux: '（安装 bubblewrap 后自动获得同级 OS 级隔离：apt install bubblewrap / dnf install bubblewrap）',
  win32: '（完成一次性管理员设置后自动获得同级 OS 级隔离，见 README「安全模型与沙箱能力分档」）',
};

// 返回 { blocked: boolean, reason: string }
function checkCommandGuard(policy, command, platform = process.platform, execExists = true, backendAvail) {
  if (!policy || policy === 'full-access') return { blocked: false, reason: '' }; // 显式 full-access 是 opt-in，不拦
  const osSandbox = backendAvail === undefined
    ? defaultOsSandboxAvailable(platform, execExists)
    : !!backendAvail;
  if (osSandbox) return { blocked: false, reason: '' }; // 有 OS 级沙箱，无需名单兜底
  const cmd = String(command || '');
  const hit = FALLBACK_DANGEROUS.find((p) => p.test(cmd));
  if (hit) {
    const hint = OS_SANDBOX_HINT[platform] || '';
    return { blocked: true, reason: `当前系统无 OS 级沙箱${hint}，已按安全策略拦截危险命令：${cmd.slice(0, 120)}` };
  }
  return { blocked: false, reason: '' };
}

// 依据沙箱策略与项目目录生成 Seatbelt profile
// read-only: 只读 + 禁网；workspace-write: 项目目录与临时目录可写 + 禁网；full-access: 不沙箱
// 真机复盘（打包版）：zsh 等标准 shell 大量使用 `>/dev/null` 重定向（如 `cmd 2>/dev/null`），
// profile 未放行 /dev/null 写入 → 「operation not permitted: /dev/null」，模型被迫换写法浪费轮次。
// /dev/null 是字面黑洞设备，放行写入无任何数据外泄风险，两个档位统一 allow。
function buildSeatbeltProfile(policy, cwd, protectedPaths = []) {
  const tmpPaths = ['/private/tmp', '/private/var/tmp', '/tmp'];
  const tmpRules = tmpPaths.map((p) => `(subpath "${p}")`).join(' ');
  const tail = [
    // /dev/null 是字面黑洞设备，放行写入无任何数据外泄风险，两个档位统一 allow。
    // 注意顺序：Seatbelt 后匹配规则优先生效，故 /dev/null 的 allow 必须跟在 deny 之后。
    '(allow file-write* (literal "/dev/null"))',
    '(deny network*)',
  ];
  if (policy === 'read-only') {
    return [
      '(version 1)',
      '(deny default)',
      // 收紧：不再宽放 file-read* 全树，改用平台策略显式放行工具链所需路径
      ...MACOS_PLATFORM_POLICY,
      // 项目目录与家目录仍可读（读代码是 read-only 档的核心用途）
      cwd ? `(allow file-read* (subpath "${String(cwd).replace(/"/g, '\\"')}"))` : '',
      '(allow file-read* (subpath "/Users") (subpath "/private/var/folders"))',
      // 显式 deny file-write*：deny default 已隐含拒绝，此处显式声明是防御性冗余，
      // 也让「只读档」的意图在 profile 里自解释（测试亦断言该行存在）
      '(deny file-write*)',
      ...tail,
    ].filter(Boolean).join('\n');
  }
  const safeCwd = String(cwd || '').replace(/"/g, '\\"');
  const writeRule = safeCwd
    ? `(allow file-write* (subpath "${safeCwd}") ${tmpRules})`
    : `(allow file-write* ${tmpRules})`;
  // 可写区内的只读 carve-out（对齐 Codex 的 .git / 自身配置目录保护）：
  // Seatbelt 后匹配规则优先生效，故对本行之后的路径追加 deny 即可压住上面的 file-write* allow。
  // 动机同 Linux 侧：项目目录整体可写会把 `.git` 变得可写，而改写 .git/hooks/pre-commit
  // 会让用户下次手动 git commit 执行注入代码——沙箱约束不了用户之后的手动命令。
  const protectedDeny = protectedPaths.length
    ? `(deny file-write* ${protectedPaths
      .map((p) => `(subpath "${String(p).replace(/"/g, '\\"')}")`)
      .join(' ')})`
    : '';
  return [
    '(version 1)',
    '(deny default)',
    // workspace-write 档保留宽放 file-read*：Agent 需要读全盘才能定位依赖与配置，
    // 收紧读取面会直接破坏可用性（Codex 在该档同样读全盘、只限写）。
    ...MACOS_PLATFORM_POLICY,
    writeRule,
    protectedDeny,
    ...tail,
  ].filter(Boolean).join('\n');
}

// ── 2026-10-21 macOS 27 兼容：写限制档（deny-list）──
// 事故：macOS 27 上 `(deny default)` 的 allowlist profile 会让任何子进程**启动即 SIGABRT**
// （实测 `/usr/bin/sandbox-exec -f profile /bin/echo` 退出码 134，连 echo 都跑不了）；
// 而 `(allow default)` + 定向 deny 的 profile 正常。根因是系统收紧了 deny-default 下的
// exec/read 通道，allowlist 不再可维护。
//
// 兼容档语义（与 workspace-write 的「读全盘、只限写」一致）：
//   · allow default（读/执行不限制）；
//   · deny network*；
//   · deny file-write*（全盘禁写），再 allow 工作区 + 临时目录 + /dev/null；
//   · protectedPaths（.git / .mjcode 等）在 allow 之后 deny，保持只读 carve-out。
// 这是「可用性优先」的降级档：仍拦网络与工作区外写入，但不阻止执行任意程序。
function buildSeatbeltProfileDenyList(policy, cwd, protectedPaths = []) {
  const safeCwd = String(cwd || '').replace(/"/g, '\\"');
  const tmpRules = ['/private/tmp', '/private/var/tmp', '/tmp'].map((p) => `(subpath "${p}")`).join(' ');
  const writeAllow = policy === 'read-only'
    ? '(literal "/dev/null")'
    : `${safeCwd ? `(subpath "${safeCwd}") ` : ''}${tmpRules} (literal "/dev/null")`;
  const protectedDeny = protectedPaths.length
    ? `(deny file-write* ${protectedPaths.map((p) => `(subpath "${String(p).replace(/"/g, '\\"')}")`).join(' ')})`
    : '';
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* ${writeAllow})`,
    protectedDeny,
  ].filter(Boolean).join('\n');
}

/** 按探测结果选择 profile：allowlist 不通时自动用 deny-list（exec.js 统一走这里）。 */
function buildSeatbeltProfileAuto(policy, cwd, protectedPaths = []) {
  return seatbeltProbe && seatbeltProbe.mode === 'denylist'
    ? buildSeatbeltProfileDenyList(policy, cwd, protectedPaths)
    : buildSeatbeltProfile(policy, cwd, protectedPaths);
}

// 沙箱可用性：仅 darwin 且 sandbox-exec 存在
function sandboxAvailable() {
  if (process.platform !== 'darwin') return false;
  try {
    return fs.existsSync(SANDBOX_EXEC);
  } catch (e) {
    return false;
  }
}

// N3（2026-10-16）：Seatbelt **真实可用性**探测——「sandbox-exec 存在」≠「能 apply」。
// 真因取证（本机二分复现）：在自身已处于 OS 沙箱内的进程（如被其他 Agent 平台沙箱包住的
// 开发/审查环境）中，任何嵌套 sandbox_apply 都报 `sandbox_apply: Operation not permitted`
//（macOS 不允许嵌套沙箱）；而「无实际限制」的 profile 会被短路成功，造成看似可用的假象。
// 探测用一个带真实 deny 的最小 profile：成功 = 真实可用；Operation not permitted = 嵌套沙箱环境
//（诚实上报，让调用方走 V03 的统一兜底而非运行时报晦涩错误）。
let seatbeltProbe = null; // 进程级缓存：能力不随运行变化
function resetSeatbeltProbe() { seatbeltProbe = null; }
async function seatbeltUsable() {
  if (seatbeltProbe) return seatbeltProbe;
  if (process.platform !== 'darwin') {
    seatbeltProbe = { ok: false, reason: '非 darwin 平台' };
    return seatbeltProbe;
  }
  if (!sandboxAvailable()) {
    seatbeltProbe = { ok: false, reason: 'sandbox-exec 不存在' };
    return seatbeltProbe;
  }
  const tryProfile = (profile) => new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(SANDBOX_EXEC, ['-p', profile, '/bin/echo', 'mjcode-probe'],
      { timeout: 8000 }, (err) => (err ? reject(err) : resolve()));
  });
  const probeCwd = os.tmpdir();
  let result;
  try {
    await tryProfile(buildSeatbeltProfile('workspace-write', probeCwd, []));
    result = { ok: true, mode: 'allowlist', reason: '' };
  } catch {
    // 2026-10-21 macOS 27：deny-default 的 allowlist 会让子进程启动即 SIGABRT（exit 134），
    // 但 allow-default + 定向 deny 的写限制档仍可用 → 自动降级，仍保留「禁网 + 工作区外禁写」。
    try {
      await tryProfile(buildSeatbeltProfileDenyList('workspace-write', probeCwd, []));
      result = {
        ok: true,
        mode: 'denylist',
        reason: 'allowlist profile 在本机不可用（macOS 27 收紧 deny-default），已切换为写限制档（禁网 + 工作区外禁写）',
      };
      console.warn(`[sandbox] ${result.reason}`);
    } catch (e2) {
      const msg = String(e2?.message || e2);
      result = /Operation not permitted/i.test(msg)
        ? { ok: false, mode: null, reason: '当前进程自身已处于 OS 沙箱内（macOS 不允许嵌套沙箱）：Seatbelt 隔离无法生效，MJCode 不应在其他 Agent 平台的沙箱环境中运行' }
        : { ok: false, mode: null, reason: `sandbox-exec 探测失败：${msg.slice(0, 160)}` };
      console.warn(`[sandbox] Seatbelt 探测失败（allowlist + denylist 均不可用）：${result.reason}`);
    }
  }
  seatbeltProbe = result;
  return seatbeltProbe;
}

// 决策：本次 shell 是否应包沙箱
function shouldSandbox(policy, cwd) {
  if (!policy || policy === 'full-access') return { use: false, reason: 'full-access' };
  if (!sandboxAvailable()) return { use: false, reason: 'sandbox-exec 不可用' };
  if (policy === 'workspace-write' && !cwd) return { use: false, reason: 'workspace-write 需要项目目录' };
  return { use: true };
}

// ── 三平台 OS 级沙箱统一分发（2026-10 新增）────────────────────────────
// 目标：macOS / Linux / Windows 都有 OS 级隔离，不再只有 macOS 有。
// 方案对齐 OpenAI Codex（见各后端文件顶部注释）：
//   macOS   → Seatbelt（sandbox-exec + 生成 profile）
//   Linux   → bubblewrap（ro-bind + unshare-all + seccomp）
//   Windows → 受限专用用户 + ACL + 防火墙（opt-in 管理员设置；Codex 明确否决 AppContainer）
//
// 统一契约：detectBackend() 返回当前可用的后端标识；
//           buildExec() 返回 { use, argv, reason, backend }，use=false 时由调用方
//           落到 checkCommandGuard 的命令级兜底。
const linuxBackend = require('./sandboxLinux');
const windowsBackend = require('./sandboxWindows');

/**
 * 探测当前平台可用的 OS 级沙箱后端。
 *
 * B3-#11（fail-open 收口）：Linux 分支改读 linuxSandboxStatusCached()——真探测结论 + TTL 缓存，
 * **不在本函数内直接起子进程探测**。缓存未命中时那次探测由 cached 内部 spawnSync 同步完成
 * （每次 exec 最多一次，TTL 内后续调用零子进程）；因此这里的返回语义从
 * 「bwrap 装了吗」纠正为「bwrap 真能隔离吗」，与执行路径同源。
 * 注意：本函数自己不探测也不预热——冷缓存时那次探测由 linuxSandboxStatusCached 内部
 * spawnSync 同步完成。刻意不做模块加载期自预热（理由见文件末尾 warmSandboxProbe 说明）。
 * @returns {{backend: 'seatbelt'|'bubblewrap'|'windows-restricted-user'|'none', reason: string}}
 */
function detectBackend() {
  if (process.platform === 'darwin') {
    return sandboxAvailable()
      ? { backend: 'seatbelt', reason: '' }
      : { backend: 'none', reason: 'sandbox-exec 不可用' };
  }
  if (process.platform === 'linux') {
    const st = linuxBackend.linuxSandboxStatusCached();
    if (st.available) return { backend: 'bubblewrap', reason: '' };
    // 区分「没装」与「装了但用不了」：前者该装包，后者该改内核/容器配置。
    // 用 detail（已含失败原因与真实 stderr）而非整段 hint——reason 会被写进日志/UI 提示，
    // 必须是能一行读完的定性信息，完整排查步骤由 linuxSandboxStatus().hint 承载。
    return {
      backend: 'none',
      reason:
        st.reason === 'bwrap-missing'
          ? 'bwrap 未安装（Ubuntu/Debian: apt install bubblewrap）'
          : `bwrap 已安装但无法建立隔离命名空间（${st.reason}）：${String(st.detail || '').slice(0, 200)}`,
    };
  }
  if (process.platform === 'win32') {
    // Windows 后端需一次性管理员设置；此处只做静态提示，运行时由 windowsSandboxReady() 异步确认
    return { backend: 'windows-restricted-user', reason: '需先执行一次性管理员设置（windowsSandboxPlan）' };
  }
  return { backend: 'none', reason: `未支持的平台：${process.platform}` };
}

/**
 * 显式预热沙箱探测缓存（宿主启动时调一次），把首次 exec 的探测开销提前。
 * 非 Linux 平台零成本（not-linux 判定不起子进程）。
 * @returns {{available: boolean, reason: string, detail: string, hint: string}}
 */
function warmSandboxProbe() {
  return linuxBackend.warmLinuxSandboxStatus();
}

/**
 * 统一的「本次是否可 OS 级沙箱」判定（同步部分；Windows 的就绪态需异步另行确认）。
 */
function osSandboxUsable(policy, cwd) {
  if (!policy || policy === 'full-access') return { use: false, reason: 'full-access' };
  const b = detectBackend();
  if (b.backend === 'none') return { use: false, reason: b.reason };
  if (policy === 'workspace-write' && !cwd) return { use: false, reason: 'workspace-write 需要项目目录' };
  return { use: true, backend: b.backend };
}

// N3 四合一（方案 §8.2 能力矩阵）：结构化能力描述——后端标识 / 真实可用性 / 原因 / 嵌套沙箱标记。
// 消费方：诊断页、UI 水位显示、运行时 gate（不再各自拼接碎片信息）。
async function describeCapability() {
  const b = detectBackend();
  if (b.backend === 'seatbelt') {
    const belt = await seatbeltUsable();
    return {
      backend: 'seatbelt',
      available: belt.ok,
      mode: belt.mode || null,
      reason: belt.reason,
      nestedSandbox: /嵌套沙箱/.test(belt.reason),
    };
  }
  return { backend: b.backend, available: b.backend !== 'none', reason: b.reason, nestedSandbox: false };
}

// ── 关于 warmSandboxProbe()：刻意**不做**模块加载期自预热（B3-#11-B 定稿）────────────
// 曾试过在模块作用域用 setImmediate 自调度一次预热，被否掉了，理由记在这里防止回潮：
//   ① 本模块被 exec 路径普遍引入（main.js → tools/exec → sandbox，另加大量测试进程），
//      在模块作用域注册自调度等于让「import 一个纯判定模块」产生 spawn 副作用；
//      依赖方不该为引入一个纯函数库付出子进程代价。「模块加载期零探测」是 #11 的硬要求。
//   ② 收益不成立：预热只是把首次探测从「第一次工具执行」挪到「启动后下一个 tick」，
//      两者都是同步 spawnSync，延迟并没有消失；TTL 缓存已经保证稳态成本为零。
//   ③ 再叠一个「关掉预热」的开关，会让测试多一扇门，容易出现「某套件设了、行为与生产不一致」。
// 因此：warmSandboxProbe() 只作为**可选**导出（宿主想提前探测可显式调一次），
// 生产零调用方不算死代码——本项目同类先例是 resetSeatbeltProbe（导出给宿主/测试用）。

module.exports = {
  buildSeatbeltProfile, buildSeatbeltProfileDenyList, buildSeatbeltProfileAuto, sandboxAvailable, shouldSandbox, checkCommandGuard,
  FALLBACK_DANGEROUS, SANDBOX_EXEC,
  // 三平台分发（新增）
  detectBackend, osSandboxUsable,
  // B3-#11：宿主**可选**调用；不调用时首次 detectBackend()/checkCommandGuard() 承担一次
  // 探测（已 TTL 缓存）。刻意不做模块加载期自预热，见上方说明。
  warmSandboxProbe,
  // N3：Seatbelt 真实可用性探测（嵌套沙箱环境诚实上报）
  seatbeltUsable, resetSeatbeltProbe, describeCapability,
  linuxBackend, windowsBackend,
};
