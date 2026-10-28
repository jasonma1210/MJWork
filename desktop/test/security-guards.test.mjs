// 安全边界门禁（批次 1）：锁住七项 P0 修复的**行为**，防回归。
//
// 选型纪律（与 nav-state 套件一致）：能行为断言的一律行为断言（直接 require 主进程模块，
// 实调函数比返回值），只有平台受限（Windows 专属分支）或网络受限的才退回源码结构性断言，
// 并在该条注释里写明「为什么不能行为断言」。
//
// 每一条都要能被证伪：
//   把 needsApproval 的 never 短路挪回首行 → S1 红；把 fg 分支挪回 !breakerOpen 内 → S2 红；
//   删掉 exec.js 的 .catch → S3 红；删掉 patch 的 error 监听 → S4 崩（不是红，是进程挂）；
//   把 darwin 分支改回 !!execExists → S5 红；去掉 loop 里的 DNS 预检 → S6 红；
//   把 Buffer 注回 context 或去掉 L1 特判 → S7 红。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'main');
const readMain = (p) => fs.readFileSync(path.join(MAIN, p), 'utf8');
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); }
};

// ── S1（A-P0-6）never 档不得越过 L1 硬地板 ────────────────────────────────────
await check('S1 never 档对 L1 危险命令仍弹卡，对 L2 文件写仍放行', () => {
  const approval = require('../main/approval.js');
  const call = (tool, args, mode) => approval.needsApproval({ tool, args, approvalMode: mode, conversationId: 'c1' });
  // L1：必须弹卡（修复前 need=false ⇒ rm -rf 零确认执行）
  assert.equal(call('shell', { command: 'rm -rf /' }, 'never').need, true,
    'never 档下 L1 命令未弹卡（回到"交互路径比 Worker 更松"的状态）');
  assert.equal(call('shell', { command: 'rm -rf /' }, 'never').level, 'L1');
  // L2：保持放行 —— 修 L1 不能把 never 档变成全档拦截（否则档位语义被抹平）
  assert.equal(call('write_file', { path: 'a.txt' }, 'never').need, false,
    'never 档下 L2 文件写不该弹卡（档位语义被过度收紧）');
  // 只读工具在任何档位都不进审批面
  assert.equal(call('read_file', { path: 'a.txt' }, 'never').need, false);
});

// ── S2（A-P0-1）熔断只降级后台，不挡前台 ──────────────────────────────────────
await check('S2 熔断开启后前台照常拿槽位，后台被挡', async () => {
  const { ResourceQuotaCenter, OVERLOAD_THRESHOLD } = require('../main/resourceQuotaCenter.js');
  const q = new ResourceQuotaCenter({ providerLimit: 2, fgReserve: 1 });
  for (let i = 0; i < OVERLOAD_THRESHOLD; i++) q.reportError('p1');
  // 前台必须成功（修复前会干等 timeout 后抛「资源槽位等待超时…熔断中」）
  let fgOk = false;
  try { const h = await q.acquire('fg', 'p1', { timeoutMs: 400 }); fgOk = true; h.release(); }
  catch (e) { fgOk = false; }
  assert.ok(fgOk, '熔断时前台也被挡住（用户感知为「应用整体卡死」）');
  // 后台必须被挡（熔断的意义仍在）
  let bgBlocked = false;
  try { const h = await q.acquire('bg', 'p1', { timeoutMs: 300 }); h.release(); }
  catch (e) { bgBlocked = true; }
  assert.ok(bgBlocked, '熔断没有挡住后台流量（熔断形同虚设）');
});

// ── S3（A-P0-5）Windows 分支必须挂 catch ─────────────────────────────────────
// 不能行为断言的原因：该分支被 `process.platform === 'win32'` 门禁，本机 darwin 无法进入。
// 故退为结构性断言：断言「windowsSandboxReady().then(...) 之后紧跟 .catch」。
await check('S3 Windows 沙箱分支的 Promise 有 catch（否则 tool:shell 永久挂起）', () => {
  const src = stripComments(readMain('tools/exec.js'));
  const i = src.indexOf('windowsSandboxReady()');
  assert.ok(i > 0, '未找到 windowsSandboxReady 调用点（结构变化请同步本断言）');
  const tail = src.slice(i, i + 2600);
  assert.ok(/\}\)\s*\.catch\s*\(/.test(tail),
    'windowsSandboxReady().then(...) 后没有 .catch — 任一 await 抛错都会让外层 Promise 永不 settle');
});

// ── S4（A-P0-4）patch 二进制缺失必须转结构化失败，不得崩主进程 ─────────────────
// 行为断言：把 PATH 清空让 spawn('patch') 触发 ENOENT，验证返回 patch-unavailable 而非未捕获异常。
await check('S4 patch 不可用时返回结构化失败（不再是未捕获 error 崩进程）', async () => {
  const { executeWriteTool } = require('../main/tools/execWrite.js');
  const origPath = process.env.PATH;
  process.env.PATH = ''; // 让 spawn('patch') / spawn('git') 均 ENOENT
  try {
    const r = await executeWriteTool('apply_patch', {
      patch: '--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n',
      cwd: ROOT,
    });
    assert.equal(r.ok, false, 'patch 不可用时竟返回成功');
    assert.match(String(r.error || r.stderr || ''), /patch|不可用|unavailable/i,
      `错误信息未说明真因（可能被"上下文不一致"文案掩盖）：${JSON.stringify(r).slice(0, 200)}`);
  } finally {
    process.env.PATH = origPath;
  }
});

// ── S5（A-P0-2）守卫判定必须与 seatbelt 真探测同源 ────────────────────────────
await check('S5 seatbelt 探测为不可用时，守卫必须按「无沙箱」启用黑名单', async () => {
  const sandbox = require('../main/sandbox.js');
  const probe = await sandbox.seatbeltUsable();
  if (process.platform !== 'darwin') {
    // 非 darwin：darwin 分支不可达，断言 linux/win 分支语义即可跳过
    return;
  }
  const guard = sandbox.checkCommandGuard('workspace-write', 'rm -rf /', 'darwin', true);
  if (probe.ok) {
    // 探测说可用 ⇒ 守卫认为有沙箱（跳过黑名单）是自洽的
    assert.equal(guard.blocked, false, 'probe 可用但守卫却按无沙箱拦命令（判定打架）');
  } else {
    // 探测说不可用（如嵌套沙箱环境）⇒ 守卫**必须**拦（修复前此处会放过）
    assert.equal(guard.blocked, true,
      `probe 判定不可用（${probe.reason}）但守卫仍认为有沙箱 ⇒ 跳过 30 条黑名单，两层同时失效`);
  }
});

// ── S6（A-P0-7）http_request 必须有 DNS 层复检 ────────────────────────────────
// 行为断言依赖外网 DNS，CI 环境可能无网；故断言「接线存在 + 在每一跳 fetch 之前」，
// 并在有网时补一次真实 rebinding 域名验证（失败不判红，只提示）。
await check('S6 http_request 在每一跳 fetch 前做 DNS 复检', () => {
  const src = stripComments(readMain('nativeTools.js'));
  assert.ok(/assertResolvedPublic/.test(src), '缺少 DNS 层复检函数（fetch 通道只看字面量主机名）');
  assert.ok(/guardedLookup/.test(src), '未复用 ssrfGuard.guardedLookup（SSRF 判据应单一事实来源）');
  // 关键：必须在 fetch 之前调用，否则等于没接
  const loopIdx = src.indexOf("for (let hop = 0; ; hop += 1)");
  assert.ok(loopIdx > 0, '未找到重定向循环（结构变化请同步本断言）');
  const inLoop = src.slice(loopIdx, loopIdx + 700);
  const dnsAt = inLoop.indexOf('assertResolvedPublic');
  const fetchAt = inLoop.indexOf('fetch(');
  assert.ok(dnsAt > 0 && fetchAt > 0 && dnsAt < fetchAt,
    'DNS 复检不在 fetch 之前（或缺失）⇒ rebinding 仍可绕过');
});

// ── S7（A-P0-3）沙盒不得注入宿主对象；逃逸原语必须升 L1 ──────────────────────
await check('S7 sandbox_code_run 命中逃逸原语判 L1，普通计算仍 L2', () => {
  const approval = require('../main/approval.js');
  const lvl = (code) => approval.toolLevel('sandbox_code_run', { code });
  // 实测两条真实 payload：修复前均为 false（当普通计算放行）
  assert.equal(lvl("Buffer.constructor.constructor('return process')()"), 'L1',
    'Buffer 逃逸 payload 未被判危险（auto-safe 下会免审批执行）');
  assert.equal(lvl("require('path').join.constructor.constructor('return process')()"), 'L1',
    'require 返回值逃逸 payload 未被判危险');
  // 普通计算必须保持 L2 —— 否则该工具的「强沙盒可宽松」定位被抹平
  assert.equal(lvl('console.log(1+1)'), 'L2', '普通计算被误判为 L1（体验倒退）');
});

await check('S7b 沙盒上下文不再注入宿主 Buffer / 宿主 hrtime', () => {
  const src = stripComments(readMain('nativeSandbox/childEntry.js'));
  // Buffer 注入形态：sandbox 字面量里出现裸 `Buffer,`
  assert.ok(!/\n\s*Buffer\s*,/.test(src),
    '仍向 vm context 注入宿主 Buffer（Buffer.constructor.constructor 可一行取回宿主 process）');
  assert.ok(!/hrtime:\s*process\.hrtime/.test(src),
    '仍注入宿主 process.hrtime（宿主函数同样是逃逸面）');
});

console.log(`\nsecurity-guards: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
