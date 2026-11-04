// 三平台 OS 级沙箱测试：Linux bubblewrap / Windows 受限用户 / macOS Seatbelt 分发 + 降级
//
// 覆盖目标（对应 2026-10 三平台隔离改造）：
//   1. detectBackend / osSandboxUsable 的平台分发与降级文案
//   2. Linux bwrap argv 的正确性：全盘只读、断网、项目目录唯一可写、家目录只读
//   3. Windows 受限用户 argv 的正确性 + 计划任务生命周期 + 局限已如实记录
//   4. 命令守卫在「有 OS 沙箱」时不再双重拦截（否则会误伤项目内合理命令）
//   5. 关键命令注入路径：cwd/command 不得越过 '--' 污染 bwrap 自身参数
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('../main/sandbox');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const linux = sandbox.linuxBackend;
const windows = sandbox.windowsBackend;

// bwrap 路径注入：本机是 macOS，没有真实 bwrap，不注入则 argv 永远为空、逻辑无法验证
const FAKE_BWRAP = '/usr/bin/bwrap';
const CWD = '/home/u/proj';

// ── 1. 后端分发 ──
const backend = sandbox.detectBackend();
const VALID_BACKENDS = ['seatbelt', 'bubblewrap', 'windows-restricted-user', 'none'];
check('detectBackend 返回合法后端标识', VALID_BACKENDS.includes(backend.backend), backend.backend);
check('detectBackend 在本机返回 seatbelt（darwin 且 sandbox-exec 存在）',
  process.platform === 'darwin' && fs.existsSync(sandbox.SANDBOX_EXEC)
    ? backend.backend === 'seatbelt'
    : true, `实际=${backend.backend}`);
check('full-access 一律不走 OS 沙箱', sandbox.osSandboxUsable('full-access', CWD).use === false);
check('workspace-write 无项目目录时拒绝（三平台一致）', sandbox.osSandboxUsable('workspace-write', '').use === false);
check('workspace-write 有项目目录时的决策与 detectBackend 一致',
  sandbox.osSandboxUsable('workspace-write', CWD).use === (backend.backend !== 'none'));

// ── 2. Linux bubblewrap ──
check('Linux 候选路径含标准安装位', Array.isArray(linux.BWRAP_CANDIDATES) && linux.BWRAP_CANDIDATES.includes('/usr/bin/bwrap'));
// B3-#11（fail-open 收口）：此处原断言是
//   linuxSandboxAvailable() === (platform === 'linux' && !!findBwrap())
// 它把「装了 bwrap」等同于「可用」——**这正是 fail-open 的测试固化**：bwrap 装了但建不出
// 隔离命名空间（内核禁 userns / AppArmor 拦截 / 容器未放开）时，等式两边同为 true，
// 断言照样 PASS，而沙箱实际没生效。
// 现改为与真探测同源：available ⟺ reason === 'ok'（Linux 上由 TTL 缓存的隔离探测定性）。
check('非 linux 平台上 linuxSandboxAvailable 恒 false（不误报可用）',
  process.platform !== 'linux'
    ? linux.linuxSandboxAvailable() === false
      && linux.linuxSandboxStatusCached().reason === 'not-linux'
    : linux.linuxSandboxAvailable() === (linux.linuxSandboxStatusCached().reason === 'ok'),
  `platform=${process.platform} available=${linux.linuxSandboxAvailable()}`
    + ` reason=${linux.linuxSandboxStatusCached().reason}`);
check('linuxSandboxAvailable 与缓存后的真探测同源（不再用 !!findBwrap() 静态口径）',
  linux.linuxSandboxAvailable() === linux.linuxSandboxStatusCached().available,
  `available=${linux.linuxSandboxAvailable()} cached=${linux.linuxSandboxStatusCached().available}`);

// workspace-write：项目目录唯一可写
const ww = linux.buildBwrapExec('workspace-write', CWD, 'npm test', '/bin/sh', FAKE_BWRAP);
const wwArgv = ww.argv;
check('bwrap workspace-write 生成非空 argv', wwArgv.length > 0);
check('bwrap 首个元素是 bwrap 自身', wwArgv[0] === FAKE_BWRAP);
check('全盘只读挂载在最前', wwArgv[1] === '--ro-bind' && wwArgv[2] === '/' && wwArgv[3] === '/');
check('unshare-all 生效（含 net/pid/ipc/uts/cgroup）',
  wwArgv.includes('--unshare-all') && wwArgv.includes('--unshare-net') && wwArgv.includes('--unshare-pid'));
// P0 修复（2026-10-16）：原断言是 `wwArgv.includes('--seccomp')`——
// 只证明「参数里出现了这个字符串」，不证明沙箱真的过滤了系统调用。
// 而该参数此前是错的（fd 9 根本不存在，bwrap 启动即失败），字符串断言照样 PASS。
// 现改为断言「命名空间隔离确实在」+「不存在未打通的 fd 传递参数」。
check('bwrap 启用命名空间隔离（--unshare-all）', wwArgv.includes('--unshare-all'));
check('bwrap 断网（--unshare-net 由 --unshare-all 覆盖，显式声明不重复）', wwArgv.includes('--unshare-net'));
check('bwrap 未使用未打通的 seccomp fd 传递（fd 9 不存在，bwrap 会启动失败）',
  wwArgv.indexOf('--seccomp') === -1);
check('--die-with-parent 防止子进程逃逸为孤儿', wwArgv.includes('--die-with-parent'));
check('--new-session 脱离终端信号组', wwArgv.includes('--new-session'));
check('/tmp 独立 tmpfs（工具要临时文件但不污染宿主）', wwArgv.includes('--tmpfs') && wwArgv.includes('/tmp'));
const cwdIdx = wwArgv.indexOf('--bind');
check('项目目录被 bind 为可写区', cwdIdx > -1 && wwArgv[cwdIdx + 1] === CWD && wwArgv[cwdIdx + 2] === CWD);
check('可写区只有一个（项目目录）', wwArgv.filter((a) => a === '--bind').length === 1);
check('工作区外的家目录只挂只读（防凭证被改）', wwArgv.includes('--ro-bind'));
const sepIdx = wwArgv.indexOf('--');
check('存在参数分隔符 --', sepIdx > -1);
check('命令被放在 -- 之后的 sh -c', wwArgv[sepIdx + 1] === '/bin/sh' && wwArgv[sepIdx + 2] === '-c' && wwArgv[sepIdx + 3] === 'npm test');
check('命令是 argv 最后一个元素', wwArgv[wwArgv.length - 1] === 'npm test');

// read-only：无可写区
const ro = linux.buildBwrapExec('read-only', CWD, 'ls -la', '/bin/sh', FAKE_BWRAP);
check('bwrap read-only 无任何 bind 可写区', !ro.argv.includes('--bind'));
check('bwrap read-only 仍断网', ro.argv.includes('--unshare-net'));
check('bwrap read-only 仍全盘只读', ro.argv.includes('--ro-bind'));

// ── 2b. 可写区内的只读 carve-out（对齐 Codex 沙箱架构）──
// 项目目录整体可写会把 `.git` 变可写；改写 .git/hooks/pre-commit 后用户下次手动 commit
// 即执行注入代码。因此受保护路径必须在 `--bind` **之后**再 `--ro-bind` 一次（后挂载覆盖先挂载）。
const GITP = path.join(CWD, '.git');
const protArgv = linux.buildBwrapExec('workspace-write', CWD, 'npm test', '/bin/sh', FAKE_BWRAP, [GITP]).argv;
{
  const bindIdx = protArgv.indexOf('--bind');
  const protIdx = protArgv.indexOf(GITP);
  check('bwrap: 受保护路径以 --ro-bind 覆盖在项目目录 --bind 之后',
    protIdx > bindIdx && protArgv[protIdx - 1] === '--ro-bind' && protArgv[protIdx + 1] === GITP,
    `bind@${bindIdx} prot@${protIdx}`);
  check('bwrap: 保护项不引入额外可写 bind（可写区仍只有项目目录）',
    protArgv.filter((a) => a === '--bind').length === 1);
  check('bwrap: 未传保护项时不产生额外挂载（向后兼容）',
    !wwArgv.slice(0, wwArgv.indexOf('--')).includes(GITP));
  check('bwrap: read-only 档不因保护项新增 bind（无可写区可保护）',
    linux.buildBwrapExec('read-only', CWD, 'ls', '/bin/sh', FAKE_BWRAP, [GITP]).argv.filter((a) => a === '--bind').length === 0);
}

// 降级与安全边界
check('bwrap 未安装时不生成 argv（落到命令守卫）',
  linux.buildBwrapExec('workspace-write', CWD, 'x', '/bin/sh', '').argv.length === 0
  || linux.findBwrap() !== null, '注入空路径时 findBwrap 兜底，见下一条');
check('full-access 不生成 bwrap argv', linux.buildBwrapExec('full-access', CWD, 'x', '/bin/sh', FAKE_BWRAP).argv.length === 0);
check('workspace-write 缺项目目录时不生成 argv（否则等于全盘只读失效）',
  linux.buildBwrapExec('workspace-write', '', 'x', '/bin/sh', FAKE_BWRAP).argv.length === 0);

// 注入防护：命令里塞 '--' 或 '--bind' 不得越过分隔符影响 bwrap 自身参数。
// 依据：命令被整体放进 sh -c 的单个 argv 元素，`--` 之后的部分由 shell 解释，
// bwrap 在解析到第一个 `--` 时已停止读取自己的选项，故注入内容恒处
// wwArgv.indexOf('--') 之后。这里用源码级断言把这个不变式钉住。
const inject = linux.buildBwrapExec('workspace-write', CWD, 'echo hi --bind / / --unshare-all', '/bin/sh', FAKE_BWRAP);
const injSep = inject.argv.indexOf('--');
check('命令内的 --bind 不会变成 bwrap 真实选项',
  inject.argv.slice(0, injSep).filter((a) => a === '--bind').length === 1,
  '分隔符前仍只有项目目录那一个 bind');
check('命令内容完整保留在分隔符之后',
  inject.argv[injSep + 3] === 'echo hi --bind / / --unshare-all');

// ── 3. Windows 受限用户 ──
check('Windows 专用用户命名带产品前缀（避免与其他软件冲突）',
  windows.SANDBOX_USER_OFFLINE.startsWith('MJCode') && windows.SANDBOX_USER_ONLINE.startsWith('MJCode'));
check('离线/在线是两个不同账号（隔离出网能力，对应 Codex 双用户设计）',
  windows.SANDBOX_USER_OFFLINE !== windows.SANDBOX_USER_ONLINE);

const plan = windows.windowsSandboxPlan();
check('设置计划产物可审计（steps 含 id/cmd/args/note）',
  Array.isArray(plan.steps) && plan.steps.every((s) => s.id && s.cmd && Array.isArray(s.args) && s.note));
check('计划含创建离线专用用户步骤', plan.steps.some((s) => s.id === 'create-offline-user'));
// 2026-11-04：原断言只认 `advfirewall` 字面量。但 netsh advfirewall **不支持 user=**
// （按用户过滤出网不是 netsh 的能力），该写法会让这一步非零退出触发整体回滚，
// Windows 一次性设置永远失败。现改用 PowerShell New-NetFirewallRule -LocalUser <SDDL>。
// 断言随契约更新为校验「确实按离线用户 SID 阻断出站」，而非某个命令名——
// 删步骤 / 改回 netsh user= / 把 Block 改成 Allow / 去掉 -LocalUser / 换用户名，都必须红。
check('计划含防火墙阻断出网步骤（对应 bwrap 的 --unshare-net）', (() => {
  const s = plan.steps.find((x) => x.id === 'block-outbound-firewall');
  if (!s) return false;
  const cmdline = [s.cmd, ...s.args].join(' ');
  return s.cmd === 'powershell'
    && /New-NetFirewallRule/.test(cmdline)
    && /-LocalUser/.test(cmdline)
    && /-Direction\s+Outbound/.test(cmdline)
    && /-Action\s+Block/.test(cmdline)
    && cmdline.includes(windows.SANDBOX_USER_OFFLINE)
    && !/\buser=/.test(cmdline); // netsh 无效的 user= 参数不得回归
})());
check('计划含回滚命令（任一步失败可撤销）', Array.isArray(plan.rollback) && plan.rollback.length >= 2);
check('用户创建参数禁改密码且必须有效（防空口令账号长期驻留）',
  plan.steps.find((s) => s.id === 'create-offline-user').args.includes('/passwordchg:no')
  && plan.steps.find((s) => s.id === 'create-offline-user').args.includes('/passwordreq:yes'));
check('密码以占位符下发，真实值由 DPAPI 加密（命令行不得出现明文）',
  JSON.stringify(plan.steps).includes('<RANDOM_PASSWORD>'));
check('未采用 AppContainer / MIC（源码已记录 Codex 的否决理由）',
  !fs.readFileSync(path.join(__dirname, '..', 'main', 'sandboxWindows.js'), 'utf8')
    .split('\n').slice(0, 40).some((l) => /'\s*\/appcontainer|integrity/i.test(l))
  && /否决/.test(fs.readFileSync(path.join(__dirname, '..', 'main', 'sandboxWindows.js'), 'utf8')));

const win = windows.buildWindowsExec('workspace-write', 'C:\\proj', 'npm test');
check('Windows 生成非空 argv', win.argv.length > 0);
check('走 schtasks 而非 runas（runas 需交互式输密码，无人值守不可用）', win.argv[0] === 'schtasks');
check('以专用受限用户身份运行', win.argv.includes(windows.SANDBOX_USER_OFFLINE));
check('令牌级别为 LIMITED（对应 Codex 的 restricted token）', win.argv.includes('LIMITED'));
check('计划任务名唯一（pid+时间戳，避免并发冲突）', typeof win.taskName === 'string' && win.taskName.length > 0);
check('full-access 不走 Windows 沙箱', windows.buildWindowsExec('full-access', 'C:\\proj', 'x').argv.length === 0);
check('workspace-write 缺项目目录时拒绝', windows.buildWindowsExec('workspace-write', '', 'x').argv.length === 0);
check('Windows 已知局限已如实文档化（Everyone SID world-writable 无法阻止）',
  /Everyone SID/.test(fs.readFileSync(path.join(__dirname, '..', 'main', 'sandboxWindows.js'), 'utf8')));

// 计划任务名不得重复：否则两次并发命令会互相覆盖（后者把前者的任务体改掉）。
// 忙等到跨毫秒，确保 Date.now() 必然不同，从而真正验证唯一性而非恒真断言。
const sameMsTag = Date.now();
while (Date.now() === sameMsTag) { /* 等待毫秒进位 */ }
const win2 = windows.buildWindowsExec('workspace-write', 'C:\\proj', 'npm test');
check('两次构造的计划任务名不重复（并发不互相覆盖）', win.taskName !== win2.taskName,
  `${win.taskName} vs ${win2.taskName}`);
check('计划任务名含进程 pid（跨进程也不冲突）', win.taskName.includes(String(process.pid)));
check('计划任务名格式固定为 <前缀>_Run_<pid>_<ts>（便于运维批量清理残留）',
  /^MJCodeSandbox_Run_\d+_\d+$/.test(win.taskName), win.taskName);

// ── 4. 命令守卫：有 OS 沙箱时不得双重拦截 ──
// 这是三平台改造引入的行为变化：Linux 装了 bwrap 后，OS 沙箱已把破坏面限制在
// 项目目录内，此时黑名单必须让位，否则 `rm -rf ./build` 这类合理命令会被误拒。
check('显式声明 OS 沙箱可用时，项目内的 rm -rf 不再被拦',
  sandbox.checkCommandGuard('workspace-write', 'rm -rf ./build', 'linux', false, true).blocked === false);
check('OS 沙箱不可用时，同样的命令仍被硬拦',
  sandbox.checkCommandGuard('workspace-write', 'rm -rf ./build', 'linux', false, false).blocked === true);
check('守卫 reason 保留「无 OS 级沙箱」语义（既有契约不破坏）',
  sandbox.checkCommandGuard('read-only', 'git push origin main', 'linux', false, false).reason.includes('无 OS 级沙箱'));
check('Linux 拦截文案给出可行动的安装提示',
  sandbox.checkCommandGuard('read-only', 'sudo rm -rf /', 'linux', false, false).reason.includes('bubblewrap'));
check('Windows 拦截文案给出可行动的设置提示',
  sandbox.checkCommandGuard('read-only', 'rm -rf /', 'win32', false, false).reason.includes('一次性管理员设置'));
check('Windows 就绪后（backendAvail=true）不再叠黑名单',
  sandbox.checkCommandGuard('workspace-write', 'rm -rf ./build', 'win32', false, true).blocked === false);
check('full-access 始终直穿',
  sandbox.checkCommandGuard('full-access', 'rm -rf /', 'linux', false, false).blocked === false);

// ── 5. macOS Seatbelt 未被三平台改造破坏（回归护栏）──
const roProfile = sandbox.buildSeatbeltProfile('read-only', '/tmp/p');
check('read-only profile 仍显式 deny file-write*', roProfile.includes('(deny file-write*)'));
check('read-only profile 不再宽放 /System 全树', !roProfile.includes('(allow file-read*)'));
check('read-only profile 用 curated 平台策略补偿工具链读取',
  roProfile.includes('(subpath "/System/Library")') && roProfile.includes('(allow process-fork)'));
check('profile 仍禁网', roProfile.includes('(deny network*)'));
check('workspace-write profile 仍限写项目目录',
  sandbox.buildSeatbeltProfile('workspace-write', CWD).includes(`(subpath "${CWD}")`));

// 可写区内的只读 carve-out（macOS 侧，与 Linux 同一动机）：Seatbelt 后匹配规则优先，
// 故对受保护路径追加 deny file-write* 即可压住前面的 allow。
{
  const prof = sandbox.buildSeatbeltProfile('workspace-write', CWD, [GITP]);
  check('Seatbelt: 对受保护路径追加 deny file-write*',
    new RegExp(`\\(deny file-write\\* \\(subpath "${GITP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\)`).test(prof));
  check('Seatbelt: deny 出现在 allow file-write* 之后（后匹配优先，保护才生效）',
    prof.indexOf('(allow file-write*') < prof.lastIndexOf('(deny file-write*'));
  check('Seatbelt: 未传保护项时不产生多余 deny（向后兼容）',
    !sandbox.buildSeatbeltProfile('workspace-write', CWD).includes(`${CWD}/.git`));
}

// ── 6. 真机（Linux）：bwrap 实际存在于环境时做一次写入边界验证 ──
if (process.platform === 'linux' && linux.findBwrap()) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-bwrap-'));
  try {
    const built = linux.buildBwrapExec('workspace-write', repo, 'echo ok > inside.txt', '/bin/sh');
    require('child_process').execFileSync(built.argv[0], built.argv.slice(1), { cwd: repo, timeout: 15000 });
    check('bwrap 内项目目录写入成功', fs.existsSync(path.join(repo, 'inside.txt')));
    // 项目目录外写入：`--tmpfs /tmp` 让沙箱内的 /tmp 是**私有 tmpfs**，
    // 因此「沙箱内写 /tmp 成功」是设计内行为（工具需要临时文件），真正要断言的是
    // **写入不落到宿主 /tmp**（宿主侧不存在该文件）。
    // 2026-10-21（L-1 收口）：原断言「命令必须非零退出」是错的——它把 tmpfs 隔离误判为拒绝，
    // 在装了 bubblewrap 的 CI 上必然变红（此前长期跳过，所以一直没暴露）。
    try {
      const b2 = linux.buildBwrapExec('workspace-write', repo, 'echo x > /tmp/mjcode-bwrap-escape', '/bin/sh');
      require('child_process').execFileSync(b2.argv[0], b2.argv.slice(1), { cwd: repo, timeout: 15000 });
    } catch (e) { /* 命令在沙箱内失败也可接受：同样说明未落到宿主 */ }
    check('bwrap 内项目目录外写入不落到宿主（/tmp 为沙箱私有 tmpfs）',
      !fs.existsSync('/tmp/mjcode-bwrap-escape'));
    if (fs.existsSync('/tmp/mjcode-bwrap-escape')) fs.rmSync('/tmp/mjcode-bwrap-escape');
  } catch (err) {
    // P0 修复（2026-10-16）：此前此处是宽泛 catch，把「bwrap 真的失败」与「环境没有 bwrap」
    // 混为一谈，打印「环境限制」后让整套件仍报 PASS —— 这正是 Linux 沙箱缺陷长期隐身的元凶。
    // 现只有「二进制不存在」才允许跳过；其余任何失败一律计入失败，不再被吞掉。
    const msg = String((err && err.message) || err);
    if (err && err.code === 'ENOENT') {
      console.log(`⚠ bwrap 真机探测跳过（二进制不可用，非缺陷）: ${msg}`);
    } else {
      fail++;
      console.error(`✗ bwrap 真机探测失败（不再按环境问题跳过）: ${msg}`);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
} else {
  console.log(`⚠ 本节未执行（非 Linux 或 bwrap 未安装，本机=${process.platform}）——`
    + '本套件的 PASS 不代表 Linux 沙箱已验证，Linux 真机验证需在 CI 的 ubuntu runner 上跑');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
