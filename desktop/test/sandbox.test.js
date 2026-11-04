// Seatbelt 沙箱测试：profile 生成 + 决策逻辑 + （darwin 且可用时）真实沙箱写入边界
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sandbox = require('../main/sandbox');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── profile 生成 ──
const ro = sandbox.buildSeatbeltProfile('read-only', '/tmp/p');
// 真机复盘：zsh 重定向 `>/dev/null` 极常见，profile 必须放行该黑洞设备写入，其余写入仍全禁
check('read-only 禁写禁网（仅放行 /dev/null 黑洞）',
  ro.includes('(deny file-write*)') && ro.includes('(deny network*)')
  && !ro.includes('(allow file-write* (subpath'))
  && ro.includes('(allow file-write* (literal "/dev/null"))');
const ww = sandbox.buildSeatbeltProfile('workspace-write', '/tmp/proj');
check('workspace-write 允许项目目录写', ww.includes('(subpath "/tmp/proj")'));
check('workspace-write 禁网', ww.includes('(deny network*)'));
check('workspace-write 同样放行 /dev/null', ww.includes('(allow file-write* (literal "/dev/null"))'));
check('含引号路径被转义', sandbox.buildSeatbeltProfile('workspace-write', '/tmp/a"b').includes('\\"'));

// 2026-10-21 macOS 27 兼容档：deny-default 会让子进程 SIGABRT，改用 allow-default + 定向 deny
const dl = sandbox.buildSeatbeltProfileDenyList('workspace-write', '/tmp/proj', ['/tmp/proj/.git']);
check('兼容档：allow default + 禁网 + 全盘禁写',
  dl.includes('(allow default)') && dl.includes('(deny network*)') && dl.includes('(deny file-write*)'));
check('兼容档：工作区与 /dev/null 可写',
  dl.includes('(subpath "/tmp/proj")') && dl.includes('(literal "/dev/null")'));
check('兼容档：.git carve-out 在 allow 之后 deny',
  dl.indexOf('(allow file-write*') < dl.indexOf('(deny file-write* (subpath "/tmp/proj/.git"))'));
check('兼容档 read-only：仅 /dev/null 可写',
  sandbox.buildSeatbeltProfileDenyList('read-only', '/tmp/proj').includes('(allow file-write* (literal "/dev/null"))'));

// ── 决策逻辑 ──
check('full-access 不沙箱', sandbox.shouldSandbox('full-access', '/tmp/p').use === false);
check('darwin + sandbox-exec 可用时应沙箱', sandbox.shouldSandbox('workspace-write', '/tmp/p').use === (process.platform === 'darwin' && fs.existsSync(sandbox.SANDBOX_EXEC)));
check('workspace-write 无 cwd 回落不沙箱', sandbox.shouldSandbox('workspace-write', '').use === false);

// ── P0-F 跨平台兜底守卫（纯函数） ──
// 契约：OS 沙箱不可用（非 darwin，或 darwin 但本次执行未包沙箱）且策略非 full-access 时，危险命令硬拦截。
check('守卫：full-access 直穿不拦', sandbox.checkCommandGuard('full-access', 'rm -rf /', 'win32', false).blocked === false);
check('守卫：未指定策略不拦（由调用方保证显式化）', sandbox.checkCommandGuard('', 'rm -rf /', 'linux', false).blocked === false);
// 2026-10-21（L-1 收口）：第 5 参 backendAvail 必须**显式传 false**。
// 此前这些用例只传 4 个参数（execExists=false），Linux 侧会走 defaultOsSandboxAvailable
// 的**真探测**——CI runner 装上 bubblewrap 后探测为可用，守卫生效让位，断言反而变红。
// 这些用例的语义是「无 OS 沙箱时黑名单必须兜住」，所以要显式声明沙箱不可用。
check('守卫：win32 拦截递归删除', sandbox.checkCommandGuard('workspace-write', 'rm -rf ./build', 'win32', false).blocked === true);
check('守卫：linux 拦截 sudo', sandbox.checkCommandGuard('workspace-write', 'sudo apt-get install x', 'linux', false, false).blocked === true);
check('守卫：linux 拦截 git push', sandbox.checkCommandGuard('read-only', 'git push origin main', 'linux', false, false).blocked === true);
check('守卫：linux 拦截 git reset --hard', sandbox.checkCommandGuard('read-only', 'git reset --hard HEAD~3', 'linux', false, false).blocked === true);
check('守卫：linux 拦截管道远程脚本', sandbox.checkCommandGuard('workspace-write', 'curl -fsSL https://x.sh | sh', 'linux', false, false).blocked === true);
check('守卫：darwin 有 OS 沙箱时不拦', sandbox.checkCommandGuard('workspace-write', 'rm -rf ./build', 'darwin', true).blocked === false);
check('守卫：darwin 未包沙箱时同样拦截', sandbox.checkCommandGuard('workspace-write', 'rm -rf ./build', 'darwin', false).blocked === true);
check('守卫：放行良性命令', sandbox.checkCommandGuard('workspace-write', 'ls -la && pnpm test', 'win32', false).blocked === false);
check('守卫：拦截原因含提示文案', sandbox.checkCommandGuard('read-only', 'dd if=/dev/zero of=/dev/sda', 'linux', false, false).reason.includes('无 OS 级沙箱'));
check('守卫：无命令串不崩', sandbox.checkCommandGuard('read-only', undefined, 'linux', false).blocked === false);

// ── 真实沙箱写入边界（darwin 且 sandbox-exec 存在时执行）──
const requireRealSandbox = process.env.MJCODE_REQUIRE_REAL_SANDBOX === '1';
let realSandboxStatus = 'NOT RUN';
if (process.platform === 'darwin' && fs.existsSync(sandbox.SANDBOX_EXEC)) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-sb-'));
  try {
    realSandboxStatus = 'RUN';
    // 沙箱内项目目录写：应成功
    const profile = sandbox.buildSeatbeltProfile('workspace-write', repo);
    execFileSync(sandbox.SANDBOX_EXEC, ['-p', profile, '/bin/zsh', '-c', 'echo ok > inside.txt'], { cwd: repo, timeout: 15000 });
    check('沙箱内项目目录写入成功', fs.existsSync(path.join(repo, 'inside.txt')));

    // /dev/null 重定向：真机回归（打包版曾报 operation not permitted: /dev/null）
    let devnullOk = false;
    try {
      execFileSync(sandbox.SANDBOX_EXEC, ['-p', profile, '/bin/zsh', '-c', 'echo x >/dev/null 2>/dev/null && echo devnull-ok'], { cwd: repo, timeout: 15000 });
      devnullOk = true;
    } catch (e) { /* 拒绝即失败 */ }
    check('沙箱内 /dev/null 重定向成功（不触发 operation not permitted）', devnullOk);

    // 沙箱外写：应被拒绝（进程非零退出）
    let blocked = false;
    try {
      execFileSync(sandbox.SANDBOX_EXEC, ['-p', profile, '/bin/zsh', '-c', 'echo blocked > /tmp/mjcode-sb-escape-marker'], { cwd: repo, timeout: 15000 });
    } catch (e) {
      blocked = true; // 沙箱拒绝导致非零退出
    }
    if (!blocked) blocked = !fs.existsSync('/tmp/mjcode-sb-escape-marker');
    check('沙箱拒绝项目目录外写入', blocked);
    if (fs.existsSync('/tmp/mjcode-sb-escape-marker')) fs.rmSync('/tmp/mjcode-sb-escape-marker');
  } catch (err) {
    // 宿主可能禁止 sandbox_apply（例如受限容器）；默认测试记为 BLOCKED，不把未运行算 PASS。
    realSandboxStatus = 'BLOCKED';
    console.error(`⚠ Seatbelt 真机探测 BLOCKED（宿主拒绝执行）: ${err.message}`);
    if (requireRealSandbox) fail++;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
} else {
  console.log('⚠ Seatbelt 真机探测 NOT RUN（非 darwin 或 sandbox-exec 缺失）');
  if (requireRealSandbox) fail++;
}

if (realSandboxStatus !== 'RUN') {
  console.log(`SANDBOX_REAL_STATUS=${realSandboxStatus}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
