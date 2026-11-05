// Linux 沙箱（bubblewrap）argv 断言测试
//
// 背景：main/sandboxLinux.js（bwrap 参数拼装）此前**不被任何测试直接覆盖**——
//   · test/sandbox-crossplatform.test.js 只做零散字符串断言，且其「真机」小节在非 Linux 上
//     打印「本节未执行」，CI 又从不跑 Linux 真机 ⇒ 默认不跑；
//   · bwrap 参数写错（少了 --unshare-net / 少了 .git 只读 / 命令拼成 shell 字符串）
//     不会有任何机器发现。这是安全边界，必须由纯 argv 层断言钉住。
//
// 本套件两个层次，全部在 macOS 上可跑（不需要真 bwrap，也不需要 Linux）：
//   ① 纯函数层：buildBwrapArgv / buildBwrapExec 的 argv 形状（与平台无关）；
//   ② 接线层：把 process.platform 临时改成 'linux'、stub electron 与 child_process.spawn，
//      直接调 exec.js 的 toolShell，断言**真正传给 bwrap 的 argv**（含 .git 只读是否由
//      writeGuard.protectedPathsFor 自动接上），以及 bwrap 启动 ENOENT 时是否如实报「未隔离」。
//
// 命名约定：[现状] 标注的用例是「与最初预期不同、但当前实现如此」的行为——测试记录现实，
// 不改实现。若上游修正了该行为，这些用例会红，提示同步更新契约。
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const linux = require('../main/sandboxLinux');

const FAKE_BWRAP = '/usr/bin/bwrap';
const CWD = '/home/u/proj';
const GITP = path.join(CWD, '.git');

// ─────────────────────────────────────────────────────────────────────────────
// ① 纯函数层：bwrap argv 形状
// ─────────────────────────────────────────────────────────────────────────────
const ww = linux.buildBwrapExec('workspace-write', CWD, 'npm test', '/bin/sh', FAKE_BWRAP);
const wwArgv = ww.argv;

check('bwrap workspace-write 生成非空 argv', wwArgv.length > 0, `len=${wwArgv.length}`);
check('argv 是数组且每个元素都是字符串（不是拼接好的 shell 字符串）',
  Array.isArray(wwArgv) && wwArgv.every((a) => typeof a === 'string'),
  `typeof=${Array.isArray(wwArgv) ? 'array' : typeof wwArgv}`);
check('argv[0] 是 bwrap 二进制本身（交给 execFile/spawn 的 file 参数）', wwArgv[0] === FAKE_BWRAP, wwArgv[0]);

// 网络隔离
check('含 --unshare-net（网络命名空间隔离，出网被内核拒绝）', wwArgv.includes('--unshare-net'));
check('含 --unshare-all 与 --unshare-pid（连同 user/ipc/uts/cgroup 一并 unshare）',
  wwArgv.includes('--unshare-all') && wwArgv.includes('--unshare-pid'));

// 全盘只读
const roRootIdx = wwArgv.findIndex((a, i) => a === '--ro-bind' && wwArgv[i + 1] === '/' && wwArgv[i + 2] === '/');
check('含 --ro-bind / /（整盘只读绑定）', roRootIdx > 0, `idx=${roRootIdx}`);
check('/tmp 用独立 --tmpfs 而非宿主 bind（工具可写临时文件但不污染宿主 /tmp）',
  wwArgv.includes('--tmpfs') && wwArgv[wwArgv.indexOf('--tmpfs') + 1] === '/tmp');

// 项目目录可写
const bindIdx = wwArgv.indexOf('--bind');
check('cwd 以 --bind <cwd> <cwd> 绑定为可写区',
  bindIdx > -1 && wwArgv[bindIdx + 1] === CWD && wwArgv[bindIdx + 2] === CWD,
  `idx=${bindIdx}`);
check('全盘只读挂载在 cwd 可写 bind 之前（后挂载覆盖先挂载才能放开写）',
  roRootIdx > -1 && bindIdx > roRootIdx, `ro=${roRootIdx} bind=${bindIdx}`);
check('可写区只有项目目录一处（--bind 仅出现一次）',
  wwArgv.filter((a) => a === '--bind').length === 1);
check('工作区外的家目录以 --ro-bind 只读挂上（可读 ~/.gitconfig，不可写凭证）',
  !!process.env.HOME && !String(process.env.HOME).startsWith(CWD)
    ? wwArgv.some((a, i) => a === '--ro-bind' && wwArgv[i + 1] === process.env.HOME)
    : true);

// .git 保护（只读 carve-out）
const protArgv = linux.buildBwrapExec('workspace-write', CWD, 'npm test', '/bin/sh', FAKE_BWRAP, [GITP]).argv;
const pBind = protArgv.indexOf('--bind');
const pGit = protArgv.findIndex((a, i) => a === '--ro-bind' && protArgv[i + 1] === GITP && protArgv[i + 2] === GITP);
check('受保护路径 .git 以 --ro-bind 覆盖为只读', pGit > -1, `idx=${pGit}`);
check('.git 的 --ro-bind 在项目目录 --bind 之后（顺序错则保护失效）',
  pGit > pBind, `bind=${pBind} git=${pGit}`);
check('.git 保护不引入额外可写 bind（可写区仍只有 cwd）',
  protArgv.filter((a) => a === '--bind').length === 1);
check('[现状] .git 保护由调用方通过 protectedPaths 传入，本函数不自动推导',
  !wwArgv.includes(GITP),
  'exec.js 用 writeGuard.protectedPathsFor(cwd) 补齐，见 ② 接线层');

// read-only 与 workspace-write 的差异
const ro = linux.buildBwrapExec('read-only', CWD, 'ls -la', '/bin/sh', FAKE_BWRAP);
const roArgv = ro.argv;
check('read-only 档无任何 --bind（全盘只读，无可写区）', !roArgv.includes('--bind'));
check('read-only 档仍断网（--unshare-net）', roArgv.includes('--unshare-net'));
check('read-only 档仍全盘只读（--ro-bind / /）',
  roArgv.some((a, i) => a === '--ro-bind' && roArgv[i + 1] === '/' && roArgv[i + 2] === '/'));
// 只比较 '--' 之前的 bwrap 选项区（之后是被执行命令，两档命令本来就不同）
{
  const wwPre = wwArgv.slice(0, wwArgv.indexOf('--'));
  const roPre = roArgv.slice(0, roArgv.indexOf('--'));
  const ISOLATION = ['--unshare-all', '--unshare-net', '--unshare-pid', '--unshare-ipc',
    '--unshare-uts', '--unshare-cgroup', '--die-with-parent', '--new-session'];
  check('两档隔离强度一致，差异只在可写区（read-only 无 --bind）',
    ISOLATION.every((f) => wwPre.includes(f) && roPre.includes(f))
    && wwPre.includes('--bind') && !roPre.includes('--bind'),
    `ww=${wwPre.length} ro=${roPre.length}`);
}
check('read-only 档不因传入 protectedPaths 而新增 bind（无可写区可保护）',
  linux.buildBwrapExec('read-only', CWD, 'ls', '/bin/sh', FAKE_BWRAP, [GITP]).argv.filter((a) => a === '--bind').length === 0);

// 降级：argv 为空 + 可读 reason（调用方据此落到命令守卫 / fail-closed）
check('full-access 不生成 bwrap argv（显式 opt-in 不沙箱）',
  linux.buildBwrapExec('full-access', CWD, 'x', '/bin/sh', FAKE_BWRAP).argv.length === 0);
check('workspace-write 缺 cwd 时不生成 argv（否则唯一可写区消失，等于退化成全盘只读）',
  linux.buildBwrapExec('workspace-write', '', 'x', '/bin/sh', FAKE_BWRAP).argv.length === 0);

// bwrap 不存在：静态探测必须返回「不可用」，不能抛，也不能给出空壳 argv
{
  const realExists = fs.existsSync;
  const realPath = process.env.PATH;
  fs.existsSync = (p) => (/bwrap$/.test(String(p)) ? false : realExists(p));
  process.env.PATH = '';
  try {
    let threw = null;
    let built = null;
    try { built = linux.buildBwrapArgv('workspace-write', CWD, '/bin/sh', null); } catch (e) { threw = e; }
    check('bwrap 不存在时不抛异常', threw === null, threw ? String(threw.message) : 'ok');
    check('bwrap 不存在时返回空 argv（调用方必须落到兜底，不能假装已隔离）',
      built && built.argv.length === 0);
    check('bwrap 不存在时 reason 明确说明未安装',
      !!built && /未安装/.test(built.reason), built ? built.reason : '(null)');
    check('非 linux 平台 linuxSandboxAvailable() 恒 false（不误报可用）',
      process.platform !== 'linux' ? linux.linuxSandboxAvailable() === false : true,
      `platform=${process.platform}`);
  } finally {
    fs.existsSync = realExists;
    process.env.PATH = realPath;
  }
}

// 注入面：命令内容不得越过分隔符污染 bwrap 自身选项
{
  const evil = 'echo hi --bind / / --unshare-all; rm -rf / #';
  const inj = linux.buildBwrapExec('workspace-write', CWD, evil, '/bin/sh', FAKE_BWRAP);
  const sep = inj.argv.indexOf('--');
  check('命令整体是 -- 之后的单个 argv 元素（不按空格拆词、不做 shell 字符串拼接）',
    sep > -1 && inj.argv[sep + 1] === '/bin/sh' && inj.argv[sep + 2] === '-c'
    && inj.argv[sep + 3] === evil && inj.argv.length === sep + 4,
    `sep=${sep} tail=${JSON.stringify(inj.argv.slice(sep))}`);
  check('命令内的 --bind/--unshare-all 没有变成 bwrap 真实选项（分隔符前 --bind 仍只有 1 个）',
    inj.argv.slice(0, sep).filter((a) => a === '--bind').length === 1);
  check('argv 长度不随命令内容变化（拼接式实现会让长度/边界漂移）',
    inj.argv.length === wwArgv.length, `${inj.argv.length} vs ${wwArgv.length}`);
  check('[现状] 命令由 bwrap 内的 /bin/sh -c 解释（argv 数组只保护 bwrap 自身参数区）',
    inj.argv[sep + 1] === '/bin/sh' && inj.argv[sep + 2] === '-c',
    'exec.js 注释已声明：字符串命令走显式 ShellProfile，非 shell 拼接');
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 接线层：stub child_process.spawn，断言 exec.js 真正交给 bwrap 的 argv
// ─────────────────────────────────────────────────────────────────────────────
const realPlatform = process.platform;
const realExistsSync = fs.existsSync;
const realSpawn = require('child_process').spawn;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-linux-sandbox-'));
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-linux-repo-'));
fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });

let spawnCalls = [];
let spawnMode = 'ok';

// electron stub（exec.js / auditLog 顶层依赖）
const electronPath = require.resolve('electron');
const electronStub = new Module(electronPath, null);
electronStub.filename = electronPath;
electronStub.loaded = true;
electronStub.exports = {
  app: { getPath: () => userDataDir, on: () => {}, whenReady: () => Promise.resolve() },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {} },
};
require.cache[electronPath] = electronStub;

// child_process.spawn stub：记录 (file, args) 并模拟成功/ENOENT
// 必须在 require exec.js **之前**替换——exec.js / execFileDetached 都在加载时解构取值。
const cp = require('child_process');
cp.spawn = function fakeSpawn(file, args, opts) {
  spawnCalls.push({ file, args, opts });
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  // nextTick：确保 execFileDetached 已挂上 error/close/data 监听
  process.nextTick(() => {
    if (spawnMode === 'enoent') {
      const err = new Error(`spawn ${file} ENOENT`);
      err.code = 'ENOENT';
      child.emit('error', err);
      return;
    }
    child.stdout.emit('data', 'stub-out');
    child.emit('close', 0, null);
  });
  return child;
};

// 让 findBwrap() 在 darwin 上也能探到 bwrap（只伪造 bwrap 路径，其他 existsSync 原样）
fs.existsSync = (p) => (String(p) === FAKE_BWRAP ? true : realExistsSync(p));
// 2026-11-05（AC-1.5 连带）：exec.js 的 Linux 分支新增了 gate ——执行前先读
// `osSandboxUsable().use`，判「bwrap 装不出隔离命名空间」就**不 spawn**、落 fail-closed 兜底。
// 而本套件上面只伪造了 `fs.existsSync('/usr/bin/bwrap')`（让 findBwrap 找得到路径），
// 探测本身仍会用 spawnSync 真跑 `--version` → darwin 上没有真 bwrap → 判 bwrap-broken
// → gate 拦住 → 下面 10 条「接线层」断言全红。
//
// 这不是缺陷回归，是**测试装置的前提没跟上**：本套件测的是「argv 怎么接线」，它成立的前提
// 就是「这台机器上 bwrap 可用」。故显式把探测结论钉成 available（而不是放宽 gate —— 放宽
// gate 等于把刚修好的 P0 又放回去）。收尾处原样恢复，避免同进程后续读到这个假结论。
const realStatusCached = linux.linuxSandboxStatusCached;
linux.linuxSandboxStatusCached = () => ({
  available: true, reason: 'ok', detail: '接线层测试装置：前提固定为 bwrap 可用', hint: '',
});
// exec.js 的 Linux 分支以 process.platform 为门（可在测试进程内覆盖）
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, enumerable: true });

require('../main/audit/auditLog').initAudit({ getAuthToken: () => null, serverBase: () => 'http://localhost:0' });
const { toolShell, initToolExec } = require('../main/tools/exec');
initToolExec({
  requestApproval: async () => 'once',
  applyApprovalDecision: () => {},
  getAlwaysRules: () => [],
  conversationRules: [],
  getDefaultCwd: () => repoDir,
  registerChild: () => {},
});

const run = async () => {
  // 场景 1：workspace-write —— 真实交给 bwrap 的 argv
  spawnCalls = [];
  spawnMode = 'ok';
  const r1 = await toolShell({
    command: 'npm test', cwd: repoDir, sandboxPolicy: 'workspace-write', requireApproval: false,
  });
  const call1 = spawnCalls[0];
  check('toolShell 经 spawn(file, argsArray) 调用 bwrap（无 shell:true、无拼接字符串）',
    spawnCalls.length === 1 && call1.file === FAKE_BWRAP && Array.isArray(call1.args)
    && !call1.opts.shell,
    `calls=${spawnCalls.length} file=${call1?.file} argsType=${Array.isArray(call1?.args) ? 'array' : typeof call1?.args}`);
  const a1 = call1 ? call1.args : [];
  check('接线层：argv 含 --unshare-net（断网确实下达给 bwrap）', a1.includes('--unshare-net'));
  check('接线层：argv 含 --ro-bind / /（整盘只读确实下达给 bwrap）',
    a1.some((a, i) => a === '--ro-bind' && a1[i + 1] === '/' && a1[i + 2] === '/'));
  const c1Bind = a1.indexOf('--bind');
  check('接线层：cwd 以 --bind <cwd> <cwd> 放开写权限',
    c1Bind > -1 && a1[c1Bind + 1] === repoDir && a1[c1Bind + 2] === repoDir);
  const c1Git = a1.findIndex((a, i) => a === '--ro-bind' && a1[i + 1] === path.join(repoDir, '.git'));
  check('接线层：.git 由 writeGuard.protectedPathsFor 自动接上并 --ro-bind 为只读',
    c1Git > c1Bind && a1[c1Git + 2] === path.join(repoDir, '.git'),
    `bind=${c1Bind} git=${c1Git}`);
  check('接线层：命令原样作为 -- 之后 sh -c 的单个元素',
    a1[a1.length - 1] === 'npm test' && a1[a1.length - 2] === '-c' && a1[a1.length - 3] === '/bin/sh');
  check('成功路径如实标记 sandboxed=true、backend=bubblewrap',
    r1.sandboxed === true && r1.sandboxBackend === 'bubblewrap',
    `sandboxed=${r1.sandboxed} backend=${r1.sandboxBackend}`);
  check('成功路径透出 stdout', r1.stdout === 'stub-out', JSON.stringify(r1.stdout));

  // 场景 2：read-only —— 无可写 bind
  spawnCalls = [];
  const r2 = await toolShell({
    command: 'ls', cwd: repoDir, sandboxPolicy: 'read-only', requireApproval: false,
  });
  const a2 = spawnCalls[0] ? spawnCalls[0].args : [];
  check('接线层：read-only 档不给任何 --bind 可写区', a2.length > 0 && !a2.includes('--bind'));
  check('接线层：read-only 档仍断网', a2.includes('--unshare-net'));
  check('接线层：read-only 档同样标记 sandboxed=true（隔离真实生效才敢标）',
    r2.sandboxed === true, `sandboxed=${r2.sandboxed}`);

  // 场景 3：bwrap 启动即 ENOENT —— 不得抛未捕获异常，也不得谎称已隔离
  spawnCalls = [];
  spawnMode = 'enoent';
  let threw = null;
  let r3 = null;
  try {
    r3 = await toolShell({
      command: 'npm test', cwd: repoDir, sandboxPolicy: 'workspace-write', requireApproval: false,
    });
  } catch (e) { threw = e; }
  check('bwrap 启动 ENOENT 时 toolShell 不抛未捕获异常', threw === null, threw ? String(threw.message) : 'ok');
  check('bwrap 启动 ENOENT 时 sandboxed 如实为 false（不谎称已隔离）',
    r3 && r3.sandboxed === false, `sandboxed=${r3?.sandboxed}`);
  check('bwrap 启动 ENOENT 时 sandboxReason 说明启动失败原因',
    !!r3 && /bubblewrap 启动失败：ENOENT/.test(String(r3.sandboxReason)), r3?.sandboxReason);
  check('bwrap 启动 ENOENT 时不伪造成功退出码（不为 0）',
    r3 && r3.exitCode !== 0, `exitCode=${r3?.exitCode}`);

  // ── 收尾：恢复全局桩 ──
  cp.spawn = realSpawn;
  fs.existsSync = realExistsSync;
  linux.linuxSandboxStatusCached = realStatusCached;
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true, enumerable: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => {
  cp.spawn = realSpawn;
  fs.existsSync = realExistsSync;
  linux.linuxSandboxStatusCached = realStatusCached;
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true, enumerable: true });
  console.error('测试异常:', e);
  process.exit(1);
});
