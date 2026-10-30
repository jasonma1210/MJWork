// X23 回归门禁：preload 桥面与渲染层调用面的静态双向校验。
//
// 背景：`window.mjcode` 的类型是 `Record<string, (...args) => unknown>`，方法名拼错
// （`localThread` vs `localThreads`）能通过 tsc，运行时被 lib/ipc.js 降级成
// capabilityUnavailable —— 代码缺陷与「平台不支持」在运行时长得一模一样。
//
// 完整修法是给桥面生成精确 TS 接口，但前置条件是清掉渲染层的 @ts-nocheck 文件
// （2026-10-30 F-005 已从 6 个清到 1 个：只剩 hooks/useAgentRun.ts），属独立工作。
// 在那之前，用**静态比对**兜住最致命的一类：
// 渲染层调用了 preload 没暴露的方法（拼错 / 漏暴露 → 功能静默不可用）。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRELOAD = path.join(DESKTOP, 'main/preload.js');
const SRC = path.join(DESKTOP, 'renderer/src');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 1) 从 preload 源码提取暴露的方法名（exposeInMainWorld 对象字面量的顶层键）──
const preloadSrc = fs.readFileSync(PRELOAD, 'utf8');
const bridgeNames = new Set();
{
  const start = preloadSrc.indexOf("exposeInMainWorld('mjcode'");
  if (start < 0) throw new Error('preload 中找不到 exposeInMainWorld(\'mjcode\')');
  for (const line of preloadSrc.slice(start).split('\n')) {
    const m = line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*:/);
    if (m) bridgeNames.add(m[1]);
    if (/^\}\);/.test(line)) break;
  }
}

// ── 2) 扫描渲染层对 window.mjcode 的调用 ──
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}
// 注释里会出现 `window.mjcode.marketXxx` 这类占位写法（lib/market.js:1），必须剥掉再扫，
// 否则门禁会被文档字符串误伤。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

const used = new Map(); // method -> [文件:行]
// 别名盲区修复（第二轮审查）：渲染层核心链路用的是「整桥别名」，而不是字面量 `mjcode.xxx`——
//   lib/agent.js:53   const mj = globalThis.window?.mjcode;  → mj.agentRun / mj.onAgentEvent
//   TerminalPanel     const mj = window.mjcode;             → mj.shell
//   TodoPanel         const api = window.mjcode;            → api.onAgentEvent
// 只扫 `mjcode.xxx` 会把它们算进「死方法」，于是「渲染层用了但桥没暴露」这一支被静默漏掉，
// 而那恰好是最核心的链路。别名按**文件内**生效：同名变量在别的文件里可能是别的对象。
// 末尾 lookahead 是关键：`= window.mjcode?.getPathForFile?.(f)` 是**调用结果**而不是整桥别名，
// 若放过会把它赋给的变量（如 p）也当成别名，于是 `p.split('/')` 被误报成「调用了未暴露的 split」。
//
// 2026-10-27 补一处盲区：TS 文件里合法写法 `const mj = window.mjcode as unknown as {...} | undefined;`
// 因为 `mjcode` 后面跟的是 ` as ...` 而不是 `;`/`)`，旧 lookahead 不认，于是 LedgerCard.tsx 里
// 真实调用的 `mj.projectsQuotaLedger(...)` 被算成「死方法」，台账被迫收一条其实在用的桥
// （false dead —— 比漏报更隐蔽：它会让台账永远无法收敛到真实）。故 lookahead 额外接受 `as` 断言。
const ALIAS_SRC = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:globalThis\.)?(?:window\??\.)?mjcode\b(?=\s*[;,)\]}\n]|\s*(?:\|\||\?\?)|\s+as\s)/g;
let aliasFiles = 0;
for (const file of walk(SRC)) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const aliases = new Set(['mjcode']);
  for (const m of src.matchAll(ALIAS_SRC)) aliases.add(m[1]);
  if (aliases.size > 1) aliasFiles += 1;
  src.split('\n').forEach((line, i) => {
    for (const alias of aliases) {
      // alias.xxx(  /  alias?.xxx?.(  /  alias['xxx'](
      const re = new RegExp(`\\b${alias}\\??\\.([A-Za-z_$][\\w$]*)|\\b${alias}\\??\\[['"]([A-Za-z_$][\\w$]*)['"]\\]`, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        const name = m[1] || m[2];
        if (!name) continue;
        if (!used.has(name)) used.set(name, []);
        used.get(name).push(`${path.relative(SRC, file)}:${i + 1}`);
      }
    }
  });
}

check('preload 桥面非空（提取逻辑没跑偏）', () => {
  if (bridgeNames.size < 50) throw new Error(`只提取到 ${bridgeNames.size} 个方法，提取规则可能已失效`);
});

check('别名扫描确实生效（否则核心链路会退化成「死方法」）', () => {
  // 自检：至少 2 个文件用整桥别名（lib/agent.js 的 mj、TerminalPanel 的 mj 等）。
  // 若别名正则失效，这里会先红——避免「扫描退化成只认 mjcode.」后仍然全绿。
  if (aliasFiles < 2) throw new Error(`只发现 ${aliasFiles} 个文件使用整桥别名，别名扫描可能已失效`);
});

check('渲染层调用的每个桥方法都真实存在于 preload', () => {
  const missing = [...used.entries()].filter(([name]) => !bridgeNames.has(name));
  if (missing.length) {
    const detail = missing.map(([n, where]) => `${n}（${where[0]}）`).join('; ');
    throw new Error(`调用了未暴露的方法：${detail}`);
  }
});

// ── C-05 收口（2026-10-21）：死方法从「比例阈值」改为**显式台账** ──
// 旧判据只看占比 ≤40%：新增 5 个死方法不会变红（只要总量够大），于是「往 bridge 上堆没人用的方法」
// 只能靠人肉发现。现在两个方向都锁：
//   ① 桥面里的死方法必须全部在台账中（新增死方法 = 红）；
//   ② 台账里的条目必须**仍然是死的**（被启用后必须删台账项 = 红，防止台账腐烂成免责清单）。
const LEDGER_PATH = path.join(DESKTOP, 'test/bridge-dead-allowlist.json');
const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
const ledgerDead = new Set(Array.isArray(ledger.dead) ? ledger.dead : []);

check('C-05 桥面死方法台账存在且已复核（reviewedAt）', () => {
  if (!ledger.reviewedAt || !/^\d{4}-\d{2}-\d{2}$/.test(ledger.reviewedAt)) {
    throw new Error('台账缺少 reviewedAt（YYYY-MM-DD）');
  }
});

check('C-05 桥面里的死方法全部已登记（新增死方法必须显式决策）', () => {
  const dead = [...bridgeNames].filter((n) => !used.has(n));
  const unledgered = dead.filter((n) => !ledgerDead.has(n));
  if (unledgered.length) {
    throw new Error(`未登记的死方法：${unledgered.join(', ')}（请删除该桥方法，或在 bridge-dead-allowlist.json 中登记）`);
  }
});

check('C-05 台账不得腐烂（登记项必须仍然未被引用）', () => {
  const revived = [...ledgerDead].filter((n) => used.has(n));
  if (revived.length) {
    throw new Error(`台账里的方法已被渲染层启用，请从台账删除：${revived.join(', ')}`);
  }
});

check('C-05 台账条目必须真实存在于 preload（防拼写错误）', () => {
  const ghost = [...ledgerDead].filter((n) => !bridgeNames.has(n));
  if (ghost.length) throw new Error(`台账里有 preload 不存在的方法：${ghost.join(', ')}`);
});

console.log(`\nbridge-parity: ${pass}/${total} 通过（桥面 ${bridgeNames.size} 个方法，渲染层引用 ${used.size} 个）`);
process.exit(pass === total ? 0 : 1);
