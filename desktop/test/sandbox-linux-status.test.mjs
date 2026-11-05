// Linux sandbox 可用性**三态诊断**门禁（D-09-A / B2-B-14）
//
// 被治理的问题：改造前 linuxSandboxAvailable() 只返回 true/false，于是
//   「这台机器不是 Linux」「Linux 但 bwrap 没装」「bwrap 装了但建不出隔离命名空间」
// 三种**完全不同**的情况对用户呈现为同一句失败。用户无法判断该装包、该改内核参数，
// 还是根本不该在这台机器找 bubblewrap —— 这是「有信号无信息」的假诊断。
//
// 本套件钉住四件事：
//   ① 返回结构字段齐全（available / reason / detail / hint），reason 落在四值枚举内；
//   ② available ⟺ reason === 'ok'（**双向**：不允许「可用但 reason 不是 ok」，也不允许反之）；
//   ③ 每个 reason 都映射到**非空且非敷衍**的 hint（必须含可执行命令/具体动作）；
//   ④ 本机（darwin）真实调用 → reason === 'not-linux' 且 available === false。
//
// 另有一条**语义门禁**（B3-#11 修正）：linuxSandboxAvailable() 不再返回「平台 + 二进制
// 存在」的静态口径，而是返回 **TTL 缓存后的真探测** 结论——因为旧口径是 fail-open：
// bwrap 装了但建不出隔离命名空间时仍报 available:true，调用方据此关掉命令级兜底，
// 隔离实际为零。探测开销用「启动探一次 + 60s TTL 缓存」摊掉，热路径（sandbox.js
// detectBackend ← osSandboxUsable ← 每次 exec）依旧零子进程。
//
// 全部用例在 macOS 上可跑：platform / findBwrap / bwrap 二进制 / TTL 均可注入，
// 不依赖本机是否装了 bwrap，也不需要 Linux。末尾另有一节把 process.platform 伪装成
// linux，走**零注入**的真实入口（linuxSandboxAvailable / detectBackend / osSandboxUsable）
// 做端到端证据。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const linux = require('../main/sandboxLinux');
const sandbox = require('../main/sandbox');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const REASONS = linux.SANDBOX_STATUS_REASONS;
check('导出 SANDBOX_STATUS_REASONS 且为四值互斥枚举',
  Array.isArray(REASONS) && REASONS.length === 4
  && ['not-linux', 'bwrap-missing', 'bwrap-broken', 'ok'].every((r) => REASONS.includes(r)),
  JSON.stringify(REASONS));
check('导出 linuxSandboxStatus 函数', typeof linux.linuxSandboxStatus === 'function');

// ── 造可注入的假 bwrap 二进制（用于在 darwin 上真实驱动 broken/ok 两条分支）──
// 脚本行为由 FAKE_MODE 决定：
//   'always-ok'   → --version 与隔离探测都成功（→ ok）
//   'version-ok'  → --version 成功，隔离探测失败（→ bwrap-broken，这是最容易漏判的一种）
//   'version-bad' → --version 就失败（→ bwrap-broken）
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-bwrap-probe-'));
const FAKE_SCRIPTS = {
  'always-ok': [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "bubblewrap 0.8.0"; exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
  ],
  'version-ok': [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "bubblewrap 0.8.0"; exit 0 ;;',
    '  *) echo "bwrap: Creating new namespace failed: Operation not permitted" >&2; exit 1 ;;',
    'esac',
  ],
  'version-bad': [
    '#!/bin/sh',
    'echo "bwrap: error while loading shared libraries: libcap.so.2" >&2',
    'exit 127',
  ],
};
const FAKE = {};
for (const [mode, lines] of Object.entries(FAKE_SCRIPTS)) {
  const p = path.join(TMPDIR, `bwrap-${mode}`);
  fs.writeFileSync(p, `${lines.join('\n')}\n`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  FAKE[mode] = p;
}

// ── 带调用日志的假 bwrap（用于**数真实 spawn 次数**，证明 TTL 缓存真的生效）──
// 「缓存生效」不能用「调用看起来很快」来证明，必须数子进程：每次 spawn 追加一行参数，
// 行数即探测次数（一轮完整探测 = --version + --unshare-all 两次 spawn）。
const PROBE_LOG = path.join(TMPDIR, 'probe.log');
function makeLoggingBwrap(name, isolationOk) {
  const p = path.join(TMPDIR, `bwrap-log-${name}`);
  const lines = [
    '#!/bin/sh',
    `echo "$1" >> "${PROBE_LOG}"`,
    'case "$1" in',
    '  --version) echo "bubblewrap 0.8.0"; exit 0 ;;',
    isolationOk
      ? '  *) exit 0 ;;'
      : '  *) echo "bwrap: Creating new namespace failed: Operation not permitted" >&2; exit 1 ;;',
    'esac',
  ];
  fs.writeFileSync(p, `${lines.join('\n')}\n`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}
const LOG_BWRAP_OK = makeLoggingBwrap('ok', true);
const LOG_BWRAP_BROKEN = makeLoggingBwrap('broken', false);
function spawnCount() {
  try {
    return fs.readFileSync(PROBE_LOG, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0; // 日志还没生成 = 0 次 spawn
  }
}
function resetProbeLog() { try { fs.rmSync(PROBE_LOG, { force: true }); } catch { /* 首次就没有日志 */ } }
function clearBwrapEnv() { delete process.env.MJCODE_BWRAP_BIN; delete process.env.MJCODE_SANDBOX_PROBE_TTL_MS; }

// ── 无副作用守卫（B3-#11-B 定稿）─────────────────────────────────────────────
// sandbox.js / sandboxLinux.js 被 exec 路径普遍引入（main.js → tools/exec → sandbox，另加大量
// 测试进程），**模块加载期必须零探测**：import 一个纯判定模块不得产生 spawn 副作用。
// 这条以前只是「设计意图」，现在钉成断言——两个模块已在上方 require 完毕，此刻 spawn 必须是 0。
check('无副作用：require sandbox.js + sandboxLinux.js 之后 bwrap spawn 计数 = 0（模块加载期零探测）',
  spawnCount() === 0, `spawn=${spawnCount()}`);

const STATUS_KEYS = ['available', 'reason', 'detail', 'hint'];
function wellFormed(s, label) {
  const missing = STATUS_KEYS.filter((k) => !(k in (s || {})));
  check(`${label}：四个字段齐全（available/reason/detail/hint）`, missing.length === 0,
    missing.length ? `缺：${missing.join(', ')}` : `reason=${s.reason}`);
  check(`${label}：available 是布尔`, typeof s.available === 'boolean', String(s.available));
  check(`${label}：reason 在四值枚举内`, REASONS.includes(s.reason), String(s.reason));
  check(`${label}：available ⟺ reason === 'ok'（双向）`,
    s.available === (s.reason === 'ok'), `available=${s.available} reason=${s.reason}`);
  check(`${label}：detail 为非空说明文字`, typeof s.detail === 'string' && s.detail.trim().length >= 10,
    `${String(s.detail).length} 字符`);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// ① not-linux：平台注入为 darwin / win32
// ─────────────────────────────────────────────────────────────────────────────
for (const plat of ['darwin', 'win32', 'freebsd']) {
  const s = wellFormed(linux.linuxSandboxStatus({ platform: plat }), `not-linux(${plat})`);
  check(`not-linux(${plat})：reason === 'not-linux' 且 available === false`,
    s.reason === 'not-linux' && s.available === false, `实际 ${s.reason}/${s.available}`);
  check(`not-linux(${plat})：hint 提到不该装 bwrap（避免误导用户去 apt install）`,
    /不用装|无需|不该/.test(s.hint), s.hint.slice(0, 60));
}

// ─────────────────────────────────────────────────────────────────────────────
// ② bwrap-missing：平台是 linux 但找不到二进制
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = wellFormed(linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => null }), 'bwrap-missing');
  check("bwrap-missing：reason === 'bwrap-missing' 且 available === false",
    s.reason === 'bwrap-missing' && s.available === false, `实际 ${s.reason}/${s.available}`);
  // hint 必须**可执行**：给出真实包管理命令，而不是「请安装 bubblewrap」这种废话
  check('bwrap-missing：hint 含可直接复制的包管理命令（apt/dnf/pacman/apk 至少各一）',
    /apt install bubblewrap/.test(s.hint) && /dnf install bubblewrap/.test(s.hint)
    && /pacman -S bubblewrap/.test(s.hint) && /apk add bubblewrap/.test(s.hint),
    s.hint.slice(0, 80));
  check('bwrap-missing：detail 说明已确认平台为 linux（区分于 not-linux）',
    /linux/i.test(s.detail), s.detail.slice(0, 60));
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ bwrap-broken：二进制可执行，但建不出隔离命名空间
//    —— 这是本次改造的核心：--version 成功 ≠ 可用
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['version-ok'] }),
    'bwrap-broken(version 成功但隔离失败)',
  );
  check("bwrap-broken：--version 成功但隔离探测失败 ⇒ reason === 'bwrap-broken'",
    s.reason === 'bwrap-broken' && s.available === false, `实际 ${s.reason}/${s.available}`);
  check('bwrap-broken：detail 带上 bwrap 版本号（证明 --version 确实跑通了，不是 finding 失败）',
    /0\.8\.0/.test(s.detail), s.detail.slice(0, 100));
  check('bwrap-broken：detail 带上真实 stderr（Operation not permitted），可用于定位',
    /Operation not permitted/i.test(s.detail), s.detail.slice(0, 140));
  // hint 必须直指内核/容器配置，而不是让用户「重新安装」（重装解决不了 userns 被禁）
  check('bwrap-broken：hint 给出内核/AppArmor/容器三层排查命令',
    /unprivileged_userns_clone/.test(s.hint) && /apparmor_restrict_unprivileged_userns/.test(s.hint)
    && /seccomp=unconfined/.test(s.hint),
    s.hint.slice(0, 100));
  check('bwrap-broken：hint 说明降级后隔离强度下降（不谎称仍等价隔离）',
    /隔离强度.*下降|命令级拦截/.test(s.hint), s.hint.slice(-80));
}
{
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['version-bad'] }),
    'bwrap-broken(--version 就失败)',
  );
  check("bwrap-broken：--version 失败也归为 'bwrap-broken'（二进制在、不可用，不是 missing）",
    s.reason === 'bwrap-broken' && s.available === false, `实际 ${s.reason}/${s.available}`);
  check('bwrap-broken(--version 失败)：detail 带上真实 stderr',
    /libcap\.so/.test(s.detail), s.detail.slice(0, 100));
}
{
  // 二进制路径存在但根本不可执行 → 必须判失败，不能因为「路径存在」就报可用
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => path.join(TMPDIR, 'no-such-bwrap') }),
    'bwrap-broken(路径不存在)',
  );
  check("bwrap-broken：注入一个不存在的 bwrap 路径 ⇒ 不可用（ENOENT 归类为 broken）",
    s.available === false && s.reason === 'bwrap-broken', `实际 ${s.reason}/${s.available}`);
}
{
  // 超时必须判失败（防卡死的 bwrap 把同步调用方拖死，同时不误报可用）
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['always-ok'], timeoutMs: 1 }),
    '超时容忍',
  );
  check('超时注入（timeoutMs=1）下返回结构仍完整且不为 undefined',
    typeof s.available === 'boolean' && REASONS.includes(s.reason), `reason=${s.reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ ok：两项探测都通过
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['always-ok'] }),
    'ok',
  );
  check("ok：两项探测都通过 ⇒ reason === 'ok' 且 available === true",
    s.reason === 'ok' && s.available === true, `实际 ${s.reason}/${s.available}`);
  check('ok：detail 带上版本号与通过的探测命令（可复核）',
    /0\.8\.0/.test(s.detail) && /--unshare-all/.test(s.detail), s.detail.slice(0, 100));
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 静态口径（probe:false）：不跑子进程，只判平台 + 二进制存在
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => '/usr/bin/bwrap', probe: false });
  check('probe:false：只判平台 + 二进制存在，不跑 --version（缺文件也不报 broken）',
    s.available === true && s.reason === 'ok', `实际 ${s.reason}/${s.available}`);
  check('probe:false：detail 明确标注是静态判定（不谎称已验证隔离）',
    /静态/.test(s.detail), s.detail.slice(0, 80));
  const miss = linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => null, probe: false });
  check('probe:false：二进制缺失时仍是 bwrap-missing', miss.reason === 'bwrap-missing' && !miss.available,
    `实际 ${miss.reason}/${miss.available}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ B3-#11：fail-closed 语义 + TTL 缓存
//   旧口径 `linuxSandboxAvailable() === (platform==="linux" && !!findBwrap())` 已移除：
//   它把「装了 bwrap」当作「bwrap 可用」，这正是 fail-open 的测试固化。
// ─────────────────────────────────────────────────────────────────────────────
{
  // ── 6.1 核心证据：bwrap 装了但坏了 ⇒ 必须判不可用（改前此处为 true）──
  process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_BROKEN;
  delete process.env.MJCODE_SANDBOX_PROBE_TTL_MS;
  linux.resetLinuxSandboxStatusCache();
  resetProbeLog();
  const broken = linux.linuxSandboxStatusCached({ platform: 'linux' });
  check('fail-closed：--version 成功但隔离失败 ⇒ linuxSandboxStatusCached 判 bwrap-broken',
    broken.reason === 'bwrap-broken' && broken.available === false,
    `reason=${broken.reason} available=${broken.available}`);
  const brokenDirect = linux.linuxSandboxStatus({ platform: 'linux' });
  check('fail-closed：无缓存入口 linuxSandboxStatus() 结论一致（同一判定，非缓存特例）',
    brokenDirect.reason === 'bwrap-broken' && brokenDirect.available === false,
    `reason=${brokenDirect.reason}`);
  const oldStaticAvail = linux.linuxSandboxStatus({ platform: 'linux', probe: false }).available;
  check('fail-closed：同一二进制下旧静态口径仍为 true —— 即改前 linuxSandboxAvailable() 的返回值，'
    + '它就是被治理的 fail-open（装了≠可用）',
    oldStaticAvail === true, `旧口径=${oldStaticAvail} 真探测=${broken.available}`);

  // ── 6.2 反面：正常 bwrap 不得被误判为不可用 ──
  process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_OK;
  linux.resetLinuxSandboxStatusCache();
  const good = linux.linuxSandboxStatusCached({ platform: 'linux' });
  check('不误判：两关都过的 bwrap ⇒ reason === ok 且 available === true',
    good.reason === 'ok' && good.available === true, `reason=${good.reason} available=${good.available}`);

  // ── 6.3 缓存生效：TTL 内连续调用只探测 1 轮（1 轮 = 2 次 spawn）──
  linux.resetLinuxSandboxStatusCache();
  resetProbeLog();
  const ttlCalls = [];
  for (let i = 0; i < 10; i++) ttlCalls.push(linux.linuxSandboxStatusCached({ platform: 'linux' }).available);
  const spawnsAfter10 = spawnCount();
  check('缓存生效：TTL(60s) 内 10 次调用只产生 1 轮探测 = 2 次 bwrap spawn（否则每次 exec 都要额外 fork+exec）',
    spawnsAfter10 === 2, `spawn 次数=${spawnsAfter10}（期望 2）`);
  check('缓存命中时每次返回同一结论（10 次全 true，没有中途翻脸）',
    ttlCalls.every((v) => v === true), JSON.stringify(ttlCalls));
  check('缓存命中不改变结论来源：available ⟺ reason === ok',
    linux.linuxSandboxStatusCached({ platform: 'linux' }).reason === 'ok');

  // ── 6.4 TTL=0（测试用）：每次调用都真探测 ──
  process.env.MJCODE_SANDBOX_PROBE_TTL_MS = '0';
  linux.resetLinuxSandboxStatusCache();
  resetProbeLog();
  for (let i = 0; i < 3; i++) linux.linuxSandboxStatusCached({ platform: 'linux' });
  const spawnsTtl0 = spawnCount();
  check('TTL=0 ⇒ 每次调用都重探：3 次调用 = 6 次 spawn（MJCODE_SANDBOX_PROBE_TTL_MS 覆盖生效）',
    spawnsTtl0 === 6, `spawn 次数=${spawnsTtl0}（期望 6）`);

  // ── 6.5 TTL 过期后重探 ──
  // TTL 取 200ms（不是更小）：单次 spawn 在慢机上也可能几毫秒，「TTL 内命中」必须留足
  // 余量，否则会变成时序 flaky 而不是在验证缓存逻辑。
  process.env.MJCODE_SANDBOX_PROBE_TTL_MS = '200';
  linux.resetLinuxSandboxStatusCache();
  resetProbeLog();
  linux.linuxSandboxStatusCached({ platform: 'linux' });
  const spawnsFirst = spawnCount();
  linux.linuxSandboxStatusCached({ platform: 'linux' });
  const spawnsHit = spawnCount();
  await new Promise((r) => { setTimeout(r, 260); }); // 越过 200ms TTL
  linux.linuxSandboxStatusCached({ platform: 'linux' });
  const spawnsExpired = spawnCount();
  check('TTL 内第 2 次调用命中缓存（spawn 数不增）', spawnsHit === spawnsFirst,
    `第1次后=${spawnsFirst} 第2次后=${spawnsHit}`);
  check('TTL 过期后自动重探（spawn 数 +2，不会永远用旧结论）', spawnsExpired === spawnsHit + 2,
    `过期前=${spawnsHit} 过期后=${spawnsExpired}`);

  // ── 6.6 缓存键跟随二进制路径：换 bwrap 后不得复用另一路径的旧结论 ──
  delete process.env.MJCODE_SANDBOX_PROBE_TTL_MS; // 恢复 60s TTL
  process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_OK;
  linux.resetLinuxSandboxStatusCache();
  linux.linuxSandboxStatusCached({ platform: 'linux' }); // 先缓存 ok
  process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_BROKEN;      // TTL 内换成一个坏 bwrap
  const swapped = linux.linuxSandboxStatusCached({ platform: 'linux' });
  check('TTL 内更换 bwrap 路径 ⇒ 缓存不串味（ok 不会粘到坏二进制上）',
    swapped.reason === 'bwrap-broken' && swapped.available === false,
    `reason=${swapped.reason}`);

  // ── 6.7 预热：warmLinuxSandboxStatus() 强制重探并写缓存 ──
  process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_OK;
  linux.resetLinuxSandboxStatusCache();
  resetProbeLog();
  const warmed = linux.warmLinuxSandboxStatus({ platform: 'linux' });
  const spawnsWarm = spawnCount();
  check('预热：warmLinuxSandboxStatus() 立即真探测（返回值即探测结论）',
    warmed.reason === 'ok' && warmed.available === true, `reason=${warmed.reason}`);
  linux.linuxSandboxStatusCached({ platform: 'linux' });
  check('预热后热路径零子进程（warm 之后调用 spawn 数不再增长）', spawnCount() === spawnsWarm,
    `warm 后=${spawnsWarm} 再调后=${spawnCount()}`);
  linux.warmLinuxSandboxStatus({ platform: 'linux' });
  check('预热可重复调用（force 语义：显式预热/重新检测总是重探）', spawnCount() === spawnsWarm + 2,
    `两次 warm 后=${spawnCount()}`);

  // ── 6.8 静态口径不污染真探测缓存、也不起子进程 ──
  linux.resetLinuxSandboxStatusCache();
  resetProbeLog();
  const staticOnly = linux.linuxSandboxStatusCached({ platform: 'linux', probe: false });
  check('linuxSandboxStatusCached({probe:false}) 走静态口径但不 spawn',
    staticOnly.available === true && spawnCount() === 0, `available=${staticOnly.available} spawn=${spawnCount()}`);
  const stillCached = linux.linuxSandboxStatusCached({ platform: 'linux' });
  check('静态口径不写缓存：随后真探测仍是真探测结论（不被静态 ok 冒充）',
    stillCached.reason === 'ok' && spawnCount() === 2, `spawn=${spawnCount()}`);

  // ── 6.9 契约：返回严格布尔，非 linux 平台恒 false（不误报可用）──
  check('linuxSandboxAvailable() 返回严格布尔（不是对象/undefined）',
    typeof linux.linuxSandboxAvailable() === 'boolean', typeof linux.linuxSandboxAvailable());
  check('linuxSandboxAvailable() 与 linuxSandboxStatusCached().available 同源不漂移',
    linux.linuxSandboxAvailable() === linux.linuxSandboxStatusCached().available);

  // 收尾：清环境与缓存，避免影响后续小节
  clearBwrapEnv();
  linux.resetLinuxSandboxStatusCache();
  resetProbeLog();
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 本机真实调用（不带任何注入）——验收要求：darwin 上必须 not-linux
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = wellFormed(linux.linuxSandboxStatus(), '本机真实调用');
  console.log(`\n本机实际探测结果：reason=${s.reason} available=${s.available}`);
  console.log(`  detail: ${s.detail}`);
  console.log(`  hint  : ${s.hint}\n`);
  if (process.platform !== 'linux') {
    check(`本机（${process.platform}）真实调用：reason === 'not-linux' 且 available === false`,
      s.reason === 'not-linux' && s.available === false, `实际 ${s.reason}/${s.available}`);
  } else {
    check('本机（linux）真实调用：reason 落在枚举内且 available ⟺ ok',
      REASONS.includes(s.reason) && s.available === (s.reason === 'ok'), `实际 ${s.reason}/${s.available}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 自检：四值枚举每一个都真的可达（防「某分支写了但永远走不到」= 假分支）
// ─────────────────────────────────────────────────────────────────────────────
{
  const reached = new Set([
    linux.linuxSandboxStatus({ platform: 'darwin' }).reason,
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => null }).reason,
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['version-ok'] }).reason,
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['always-ok'] }).reason,
  ]);
  check('自检：四个 reason 分支全部可达（否则某分支＝死代码，诊断仍有盲区）',
    REASONS.every((r) => reached.has(r)), `到达=${[...reached].join(',')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑨ 端到端：把 process.platform 伪装成 linux，走**零注入**的真实入口
//   （linuxSandboxAvailable / detectBackend / osSandboxUsable / warmSandboxProbe
//    —— 前三个正是 exec 热路径上的调用链）
//   ⑥ 用 opts.platform 验证判定逻辑本身；本节验证「生产入口真的会读到该判定」，
//   否则可能出现在「注入时正确、真实入口仍走旧口径」的假修复。
// ─────────────────────────────────────────────────────────────────────────────
{
  const realPlatform = process.platform;
  const spoof = (v) => Object.defineProperty(process, 'platform',
    { value: v, configurable: true, enumerable: true, writable: false });
  try {
    // ── 9.1 坏 bwrap（--version 成功 / 隔离失败）：四个入口必须一致判不可用 ──
    spoof('linux');
    process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_BROKEN;
    delete process.env.MJCODE_SANDBOX_PROBE_TTL_MS;
    linux.resetLinuxSandboxStatusCache();
    check('端到端(linux)：坏 bwrap ⇒ linuxSandboxAvailable() === false（**改前此处为 true**）',
      linux.linuxSandboxAvailable() === false, `实际=${linux.linuxSandboxAvailable()}`);
    const e2eStatus = linux.linuxSandboxStatus();
    check('端到端(linux)：linuxSandboxStatus() 给出 bwrap-broken + 可行动 hint',
      e2eStatus.reason === 'bwrap-broken' && /unprivileged_userns_clone/.test(e2eStatus.hint),
      `reason=${e2eStatus.reason}`);
    const bBroken = sandbox.detectBackend();
    check('端到端(linux)：detectBackend() 不再谎报 bubblewrap（backend=none 且 reason 指明隔离失败）',
      bBroken.backend === 'none' && bBroken.reason.includes('bwrap-broken'), `backend=${bBroken.backend}`);
    const uBroken = sandbox.osSandboxUsable('workspace-write', '/home/u/proj');
    check('端到端(linux)：osSandboxUsable() 判 use=false（否则 exec 会以为有 OS 隔离而关掉命令守卫）',
      uBroken.use === false, `use=${uBroken.use} reason=${uBroken.reason}`);

    // ── 9.2 正常 bwrap：不得被误判 ──
    process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_OK;
    linux.resetLinuxSandboxStatusCache();
    check('端到端(linux)：正常 bwrap ⇒ linuxSandboxAvailable() === true',
      linux.linuxSandboxAvailable() === true);
    const bOk = sandbox.detectBackend();
    check('端到端(linux)：detectBackend() 报 bubblewrap', bOk.backend === 'bubblewrap', `backend=${bOk.backend}`);
    const uOk = sandbox.osSandboxUsable('workspace-write', '/home/u/proj');
    check('端到端(linux)：osSandboxUsable() 判 use=true 且 backend=bubblewrap',
      uOk.use === true && uOk.backend === 'bubblewrap', JSON.stringify(uOk));
    const warmed = sandbox.warmSandboxProbe();
    check('端到端(linux)：导出 warmSandboxProbe() 可显式预热并返回探测结论',
      warmed.reason === 'ok' && warmed.available === true, `reason=${warmed.reason}`);

    // ── 9.3 契约不变：osSandboxUsable 的返回结构一个字段都没变 ──
    check('osSandboxUsable 可用时结构为 {use, backend}（无新增字段）',
      JSON.stringify(Object.keys(uOk).sort()) === JSON.stringify(['backend', 'use']),
      JSON.stringify(Object.keys(uOk)));
    check('osSandboxUsable 不可用时结构为 {use, reason}（无新增字段）',
      JSON.stringify(Object.keys(uBroken).sort()) === JSON.stringify(['reason', 'use']),
      JSON.stringify(Object.keys(uBroken)));
    check('detectBackend 结构为 {backend, reason}（无新增字段）',
      JSON.stringify(Object.keys(bOk).sort()) === JSON.stringify(['backend', 'reason']),
      JSON.stringify(Object.keys(bOk)));
  } finally {
    spoof(realPlatform);
    clearBwrapEnv();
    linux.resetLinuxSandboxStatusCache();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑩ 守卫与探测同源（B3-#11-A）：命令守卫不能再拿「装了吗」当「能用吗」
//   被治理的第二处 fail-open：`defaultOsSandboxAvailable()` 曾用 `!!findBwrap()`，
//   坏 bwrap 时本层谎报「有沙箱」→ 30 条黑名单被跳过；而 detectBackend 已如实报 none
//   → 真沙箱也没有 ⇒ **两层同时失效**。必须给出正/反两个样本：加严不能把主路径改坏。
// ─────────────────────────────────────────────────────────────────────────────
{
  process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_BROKEN;   // 反样本：装了但建不出命名空间
  delete process.env.MJCODE_SANDBOX_PROBE_TTL_MS;
  linux.resetLinuxSandboxStatusCache();
  const negBlocked = sandbox.checkCommandGuard('read-only', 'rm -rf /', 'linux'); // backendAvail 省略 → 走推断
  check('守卫同源(反样本)：坏 bwrap ⇒ checkCommandGuard 仍拦 rm -rf /（改前此处 blocked=false，是第二处 fail-open）',
    negBlocked.blocked === true, `blocked=${negBlocked.blocked}`);
  const negSudo = sandbox.checkCommandGuard('read-only', 'sudo rm -rf /', 'linux');
  check('守卫同源(反样本)：sudo rm -rf / 同样被拦，reason 仍含「无 OS 级沙箱」语义',
    negSudo.blocked === true && negSudo.reason.includes('无 OS 级沙箱'), negSudo.reason.slice(0, 60));

  process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_OK;       // 正样本：真能隔离
  linux.resetLinuxSandboxStatusCache();
  const posBlocked = sandbox.checkCommandGuard('read-only', 'rm -rf /', 'linux');
  check('守卫同源(正样本)：好 bwrap ⇒ 黑名单让位（有真 OS 隔离时不再双重拦截，既有设计不被改坏）',
    posBlocked.blocked === false, `blocked=${posBlocked.blocked}`);
  check('守卫同源(正样本)：workspace-write 下项目内 rm -rf ./build 仍放行',
    sandbox.checkCommandGuard('workspace-write', 'rm -rf ./build', 'linux').blocked === false);

  process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_BROKEN;
  linux.resetLinuxSandboxStatusCache();
  const fa = sandbox.checkCommandGuard('full-access', 'rm -rf /', 'linux');
  check('守卫同源：full-access 仍最先返回 unblocked（opt-in 不受新闸影响）',
    fa.blocked === false && fa.reason === '', JSON.stringify(fa));

  check('守卫签名/契约不变：显式传 backendAvail=true ⇒ 放行（旧调用方行为完全不变）',
    sandbox.checkCommandGuard('read-only', 'rm -rf /', 'linux', true, true).blocked === false);
  check('守卫签名/契约不变：显式传 backendAvail=false ⇒ 拦截（旧调用方行为完全不变）',
    sandbox.checkCommandGuard('read-only', 'rm -rf /', 'linux', true, false).blocked === true);

  clearBwrapEnv();
  linux.resetLinuxSandboxStatusCache();
  resetProbeLog();
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑪ 无加载期副作用 + 预热是**显式 opt-in**（B3-#11-B 定稿）
//   曾试过在 sandbox.js 模块作用域用 setImmediate 自调度一次预热，已否掉：
//   sandbox.js 被 exec 路径普遍引入（main.js → tools/exec → sandbox，另加大量测试进程），
//   「import 一个纯判定模块」不应产生 spawn 副作用；且预热只是把同一段同步探测挪个位置，
//   延迟并不消失（稳态成本已由 TTL 缓存解决）。
//   这里用子进程把 process.platform 伪装成 linux，验证三件事：
//     ① 只 require（不调用任何函数）→ spawn = 0（无加载期自调度）
//     ② require + 显式 warmSandboxProbe() → spawn = 2（导出可用，非死代码）
//     ③ 非 Linux 上显式 warm → spawn = 0（not-linux 在起子进程前就返回）
// ─────────────────────────────────────────────────────────────────────────────
{
  const MAIN = path.resolve(import.meta.dirname, '..', 'main', 'sandbox.js');
  const PROBE_LINES = `(() => { try { return fs.readFileSync(${JSON.stringify(PROBE_LOG)}, 'utf8')`
    + '.split(\'\\n\').filter(Boolean).length; } catch { return 0; } })()';
  // callWarm=true 时在 require 之后显式调用一次导出（模拟宿主主动预热）
  const child = (spoofLinux, callWarm) => {
    const code = `${spoofLinux ? "Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });" : ''}
const fs = require('fs');
const sb = require(${JSON.stringify(MAIN)});
${callWarm ? 'sb.warmSandboxProbe();' : ''}
setImmediate(() => { process.stdout.write(String(${PROBE_LINES})); });`;
    return require('node:child_process').execFileSync(process.execPath, ['-e', code], {
      env: { ...process.env, MJCODE_BWRAP_BIN: LOG_BWRAP_OK, MJCODE_SANDBOX_PROBE_TTL_MS: '60000' },
      encoding: 'utf8',
      timeout: 20000,
    }).trim();
  };

  resetProbeLog();
  const requireOnly = child(true, false);
  check('无加载期副作用：仅 require sandbox.js（linux）→ spawn = 0（import 纯判定模块不得产生子进程）',
    requireOnly === '0', `spawn=${requireOnly}`);

  resetProbeLog();
  const warmExplicit = child(true, true);
  check('预热是显式 opt-in：require + warmSandboxProbe() → 探测 1 轮 = 2 次 spawn（导出可用，非死代码）',
    warmExplicit === '2', `spawn=${warmExplicit}（期望 2）`);

  if (process.platform !== 'linux') {
    resetProbeLog();
    const nonLinux = child(false, true); // 不伪装：真实非 Linux 平台，显式调 warm
    check('非 Linux 零成本：显式 warm 也在 not-linux 判定处即返回，spawn=0',
      nonLinux === '0', `spawn=${nonLinux}`);
  }
  resetProbeLog();
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑫ exec 执行分支的 Linux gate（2026-11-05，AC-1.5）
//
// 被治理的 P0（已端到端复现，不是理论风险）：`tools/exec.js` 的 Linux 分支原只判
// `built.argv.length` 就 spawn bwrap，**从不读 `osSandboxUsable().use`**。于是
//   · 诊断已判 `bwrap-broken`（建不出命名空间），命令仍被包一层 bwrap 执行；
//   · 结果还回 `sandboxed: true` —— **谎报已隔离**；
//   · 同时 `sandbox.js` 见「有 OS 沙箱」就让位 30 条黑名单 ⇒ **隔离与黑名单两层同时失效**。
// macOS（seatbeltUsable）与 Windows（windowsSandboxReady）本来都有 gate，唯独 Linux 缺。
//
// 断言策略（为什么这么写）：
//   ① **数 bwrap spawn 次数**，不只读返回字段——字段可以被赋值骗过，子进程不会。
//      gate 生效时探测之后 bwrap spawn 必须为 **0**（一次都不该启动）。
//   ② 返回形态必须是既有 fail-closed 契约 `blocked:true / errorCode:'sandbox-unavailable'`，
//      **不是**新造一套拒绝逻辑（`execFallback.js:62-81` 本来就是这个语义）。
//   ③ 带**正样本**：好 bwrap ⇒ 必须仍走沙箱分支（spawn > 0），证明加严没把主路径改坏。
//   ④ 变异可验证：删掉 `linuxOs.use` 条件 ⇒ `sandboxed` 变回 true、spawn > 0，本条必红。
// ─────────────────────────────────────────────────────────────────────────────
{
  const EXEC_MAIN = path.resolve(import.meta.dirname, '..', 'main', 'tools', 'exec.js');
  // exec.js 顶层 require('electron')（ipcMain/shell/app），非 Electron 宿主必须打桩
  const { installElectronStub } = await import('./helpers/electronStub.mjs');
  installElectronStub({
    ipcMain: { handle: () => {}, on: () => {} },
    shell: { showItemInFolder: () => {}, openPath: async () => '', openExternal: async () => {} },
    app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test', isPackaged: false },
  });
  const exec = require(EXEC_MAIN);
  check('⑫ exec.js 可在非 Electron 宿主加载（否则本节的 gate 断言无从谈起）',
    typeof exec.toolShell === 'function' && typeof exec.initToolExec === 'function');

  let approvalAsks = 0;
  exec.initToolExec({
    // 兜底路径会请求一次 unconfined_exec（L1）；这里答 deny ⇒ 应得 blocked
    requestApproval: async () => { approvalAsks++; return 'deny'; },
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    registerChild: () => {},
  });

  const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ac15-gate-'));
  const realPlatform = process.platform;
  const spoof = (v) => Object.defineProperty(process, 'platform',
    { value: v, configurable: true, enumerable: true, writable: false });
  try {
    spoof('linux');

    // ── 反样本：坏 bwrap（--version 成功、隔离失败）⇒ 必须 gate 住，一次都不 spawn ──
    process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_BROKEN;
    delete process.env.MJCODE_SANDBOX_PROBE_TTL_MS;
    linux.resetLinuxSandboxStatusCache();
    const usable = sandbox.osSandboxUsable('workspace-write', WORKDIR); // 先让探测跑完并缓存
    check('⑫ 前置：坏 bwrap 下 osSandboxUsable().use === false（诊断层已如实判定）',
      usable.use === false, JSON.stringify(usable).slice(0, 80));
    resetProbeLog();
    approvalAsks = 0;
    const bad = await exec.toolShell({ command: 'echo ac15-probe', cwd: WORKDIR, requireApproval: false });
    const badSpawns = spawnCount();               // 探测已缓存 ⇒ 这里的 spawn 只可能来自执行分支
    check('⑫ gate 生效：坏 bwrap 下 bwrap 子进程 spawn = 0（绝不启动已知建不出隔离的 bwrap）',
      badSpawns === 0, `spawn=${badSpawns}`);
    check('⑫ 不谎报：sandboxed 必须为 false（改前此处回 true，是最危险的那种假绿）',
      bad.sandboxed === false, `sandboxed=${bad.sandboxed}`);
    check("⑫ 形态沿用既有 fail-closed 契约：blocked:true + errorCode:'sandbox-unavailable'",
      bad.blocked === true && bad.errorCode === 'sandbox-unavailable',
      `blocked=${bad.blocked} errorCode=${bad.errorCode}`);
    check('⑫ 调用方未被挂死（Promise 正常结算，exitCode 为 -1 而非 undefined）',
      bad.exitCode === -1, `exitCode=${bad.exitCode}`);
    check('⑫ 兜底确实走了 L1 单次审批这一关（说明不是硬编码拒绝，而是既有逃生口）',
      approvalAsks === 1, `approvalAsks=${approvalAsks}`);

    // ── 正样本：好 bwrap ⇒ 必须仍走沙箱分支（加严不能把主路径改坏）──
    process.env.MJCODE_BWRAP_BIN = LOG_BWRAP_OK;
    linux.resetLinuxSandboxStatusCache();
    const usableOk = sandbox.osSandboxUsable('workspace-write', WORKDIR);
    check('⑫ 正样本前置：好 bwrap ⇒ osSandboxUsable().use === true',
      usableOk.use === true, JSON.stringify(usableOk).slice(0, 80));
    resetProbeLog();
    const good = await exec.toolShell({ command: 'echo ac15-probe', cwd: WORKDIR, requireApproval: false });
    const goodSpawns = spawnCount();
    check('⑫ 正样本：好 bwrap ⇒ 确实启动了 bwrap（spawn > 0），gate 没把沙箱路径整个关死',
      goodSpawns > 0, `spawn=${goodSpawns}`);
    check('⑫ 正样本：走了沙箱分支后 sandboxed === true（此时是真隔离，不是谎报）',
      good.sandboxed === true, `sandboxed=${good.sandboxed}`);
  } finally {
    spoof(realPlatform);
    try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
    clearBwrapEnv();
    linux.resetLinuxSandboxStatusCache();
    resetProbeLog();
  }
}

// ── 平台诚实性声明（D-09-B 风险表第一条）──────────────────────────────────────
// 本套件在非 Linux 上的所有 Linux 断言都由「注入 platform / 伪装 process.platform + 假 bwrap」
// 驱动：验证的是**判定逻辑**（包括 fail-closed 语义），**不等于** bwrap 真机隔离能力已验证。
// 必须在非 Linux 上显式记账为「未执行」，否则 macOS 上的全绿会造成虚假信心。
// run-all.mjs 以 /⚠.*(跳过|未执行)/ 识别此类声明并单列在「未执行/跳过」清单里。
if (process.platform !== 'linux') {
  console.log(`⚠ Linux 真机隔离能力未执行（本机=${process.platform}）：本套件仅验证 fail-closed 判定逻辑，`
    + 'bwrap 真实命名空间隔离需在 Linux 真机 / CI ubuntu runner 上跑');
}

// 清理临时假 bwrap
try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\nsandbox-linux-status: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
