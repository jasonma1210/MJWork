#!/usr/bin/env node
// S6 ①② 门禁本体（批次 3-2）：一份 AST 遍历同时判两件事，避免重复 parse。
//
// 背景（本轮实测过、反复踩过的两类假绿）：
//   ① 同步 helper + async 回调：`check(name, async () => …)` 的 helper 是同步函数 ⇒ `fn()` 返回 Promise，
//      断言失败退化成 unhandled rejection，而 `pass++` 已经发生 ⇒ 汇总撒谎 / 退出码可能仍为 0。
//      RB-2 已修 3 个套件（8 个调用点）；本判据防复发。
//   ② 裸 promise 表达式语句：`(async () => {…})();` 既不 await 也不 .catch ⇒ 失败无处可去。
//      它与 preload（运行时兜底）互补：preload 只在失败**真的发生**时抓住，本判据防它被写出来。
//
// ① 的判据（三条，任一即「async-capable」；只认 `/^check/i` 的 helper）：
//      a. 声明带 `async`
//      b. 函数体内含 `await`
//      c. 函数体把回调形参串进 `.then(...)` 链（`checkAsync` 那 9 个套件的形态）
//   ⇒ 违规 = (i) 非 async-capable 的 helper 收到 async 回调；(ii) async-capable helper 的调用点未 `await`。
//   为什么必须认 c：不认就把 9 个套件 41 个调用点全判红，只能加豁免表——那正是本轮在消灭的形态。
//   为什么必须限定 `/^check/i`：不限名字会误伤 `startServer(...)`/`baseDeps(...)` 这类「收 async 回调但不做断言计数」的工厂（实测 6 处假红）。
//
// ② 是 **ratchet**（不做硬红）：基线冻结在 test/fixtures/bare-promise-baseline.json，
//   新增即红、减少提示 `--write`。为什么不做硬红：开门当天有 48 处存量，硬红等于逼人造 48 条豁免。
//   分档（口径必须打出来，否则又会「三个数并存」）：
//     已兜住(.catch) / 仅 .then / 真裸 —— 且 `.then(onFulfilled, onRejected)` **双参形态算已处理**
//     （只找 `.catch` 会误伤，实测 `chrome-relay:61` 就是双参形态）。
//
// 用法：
//   node scripts/audit-check-await.cjs               # 检查（① 硬红；② ratchet）
//   node scripts/audit-check-await.cjs --write       # 现算并写入基线（清理存量后用它下调）
//   node scripts/audit-check-await.cjs --self-test   # 反向用例 + 正向样本（见下）
//   node scripts/audit-check-await.cjs --verbose     # 打印 ② 的逐条明细
//   未知参数 → exit 2（防「参数写错但 exit 0」的空过）
'use strict';

const fs = require('fs');
const path = require('path');
const espree = require('espree');

const DESKTOP = path.resolve(__dirname, '..');
const DEFAULT_TEST_DIR = path.join(DESKTOP, 'test');
const DEFAULT_BASELINE = path.join(DEFAULT_TEST_DIR, 'fixtures/bare-promise-baseline.json');
// 可被 --root / --baseline 覆盖：反向用例要在 os.tmpdir() 里跑，绝不能往仓库写临时文件
let TEST_DIR = DEFAULT_TEST_DIR;
let BASELINE_PATH = DEFAULT_BASELINE;
const HELPER_NAME_RE = /^check/i;
const TIERS = ['bareIife', 'thenOnly'];

const isFnNode = (n) => !!n && ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(n.type);

function walk(node, cb) {
  if (!node || typeof node.type !== 'string') return;
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((ch) => walk(ch, cb));
    else if (v && typeof v.type === 'string') walk(v, cb);
  }
}

const crypto = require('crypto');
/** 位置级指纹：语句内容（去空白/引号风格差异）哈希——比行号稳，比「只看计数」严格 */
function pointId(src, node) {
  const norm = src.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

function parse(src, isModule) {
  return espree.parse(src, { ecmaVersion: 'latest', sourceType: isModule ? 'module' : 'script', loc: true });
}

/**
 * 收集 `/^check/i` 的 helper，并判定其「异步能力」（三条任一）。
 * @returns {Map<string, {asyncCapable:boolean, why:string}>}
 */
function collectHelpers(ast, src) {
  const map = new Map();
  const consider = (name, fnNode) => {
    if (!HELPER_NAME_RE.test(name)) return;
    const body = fnNode.body;
    const bodyText = src.slice(body.start, body.end);
    const hasAwait = /\bawait\b/.test(bodyText);
    // c. 回调形参被串进 .then(...)：找 body 里 `.then(` 调用，其实参文本含形参名
    const paramNames = (fnNode.params || [])
      .map((p) => (p.type === 'Identifier' ? p.name : (p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : null)))
      .filter(Boolean);
    let thenChained = false;
    walk(body, (n) => {
      if (thenChained || n.type !== 'CallExpression') return;
      if (n.callee.type !== 'MemberExpression' || !n.callee.property || n.callee.property.name !== 'then') return;
      for (const a of n.arguments) {
        const argText = src.slice(a.start, a.end);
        if (paramNames.some((p) => new RegExp(`\\b${p}\\b`).test(argText))) { thenChained = true; return; }
      }
    });
    const kind = (fnNode.async === true || hasAwait) ? 'asyncKw' : (thenChained ? 'promiseRet' : 'sync');
    map.set(name, { asyncCapable: kind !== 'sync', why: kind, kind });
  };
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) consider(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFnNode(n.init)) consider(n.id.name, n.init);
  });
  return map;
}

/** `.then(f, r)` 双参 = 已处理（不要只认 .catch） */
function thenCallsIn(node, src) {
  const out = [];
  walk(node, (n) => {
    if (n.type !== 'CallExpression') return;
    if (n.callee.type !== 'MemberExpression' || !n.callee.property) return;
    if (n.callee.property.name !== 'then') return;
    out.push({ twoArg: n.arguments.length >= 2, text: src.slice(n.start, n.end) });
  });
  return out;
}

/**
 * 扫描一个文件：返回 ① 的违规与统计、② 的分档位置。
 */
function scanFile(src, filename) {
  const isModule = filename.endsWith('.mjs');
  const ast = parse(src, isModule);
  const helpers = collectHelpers(ast, src);

  const violations = [];
  const syncNotAwaited = [];
  let checkedCalls = 0;
  let asyncCapableCalls = 0;
  const callsByKind = { asyncKw: 0, promiseRet: 0 };

  walk(ast, (n) => {
    // ① (i)(ii)：只看名字命中 helper 的调用点
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && helpers.has(n.callee.name)) {
      checkedCalls += 1;
      const h = helpers.get(n.callee.name);
      const asyncArg = n.arguments.some((a) => isFnNode(a) && a.async === true);
      const awaited = false; // 由父节点判断，见下方第二个遍历
      void awaited;
      if (h.asyncCapable) asyncCapableCalls += 1;
      if (h.kind === 'asyncKw') callsByKind.asyncKw += 1;
      else if (h.kind === 'promiseRet') callsByKind.promiseRet += 1;
      if (!h.asyncCapable && asyncArg) {
        violations.push({ line: n.loc.start.line, kind: 'sync-helper-async-callback', helper: n.callee.name });
      }
    }
  });

  // ① (ii) 需要父节点信息：单独一轮，用「调用点是否被 await」判定
  const awaitedSet = new Set();
  (function markAwaited(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'AwaitExpression' && node.argument && node.argument.type === 'CallExpression'
      && node.argument.callee.type === 'Identifier' && helpers.has(node.argument.callee.name)) {
      awaitedSet.add(node.argument);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'parent') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((ch) => markAwaited(ch, node));
      else if (v && typeof v.type === 'string') markAwaited(v, node);
    }
  })(ast, null);

  walk(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || !helpers.has(n.callee.name)) return;
    const h = helpers.get(n.callee.name);
    if (h.asyncCapable && !awaitedSet.has(n)) {
      // 未 await 的 async-capable helper：只有「回调是 async」时失败才可能丢（helper 自身有 try/catch，不会外泄 reject）。
      // 同步回调的未 await 只影响 [PASS] 行与汇总的相对时序，记为 info 不判红（实测全仓 1 处：engine-process:36）。
      const asyncArg = n.arguments.some((a) => isFnNode(a) && a.async === true);
      if (asyncArg) violations.push({ line: n.loc.start.line, kind: 'async-helper-not-awaited', helper: n.callee.name });
      else syncNotAwaited.push({ line: n.loc.start.line, helper: n.callee.name });
    }
  });

  // ② 分档：只看 ExpressionStatement；判定「外层链」是否兜住
  //   ⚠ 不能扫整条语句文本：IIFE **体内**的 `.catch(` 与体外的兜底是两回事，
  //     用文本会把 `(async () => { await p.catch(f); })();` 误判成「已兜住」（实测差 6 处）。
  // 分档：bareIife（真裸）/ thenOnly（含 .then 但无兜底；**近似口径，未做链式判定**）
  const tiers = { bareIife: [], thenOnly: [] };
  const points = [];
  let caught = 0;
  const outerOf = (expr) => {
    // 返回 {kind:'catch'|'then2'|'then1'|'none'}，只看最外层调用链
    let cur = expr;
    let sawThen1 = false;
    while (cur && cur.type === 'CallExpression' && cur.callee.type === 'MemberExpression' && cur.callee.property) {
      const prop = cur.callee.property.name;
      if (prop === 'catch' || prop === 'finally') return { kind: 'catch' };
      if (prop === 'then') {
        if (cur.arguments.length >= 2) return { kind: 'catch' };
        sawThen1 = true;
      }
      cur = cur.callee.object;
    }
    return { kind: sawThen1 ? 'then1' : 'none' };
  };
  walk(ast, (n) => {
    if (n.type !== 'ExpressionStatement') return;
    const e = n.expression;
    if (!e || e.type !== 'CallExpression') return;
    const outer = outerOf(e);
    // 剥掉外层 .catch/.then 链，找最内层的调用；只有最内层是 `(async () => …)()` 才算 IIFE
    let base = e;
    while (base.type === 'CallExpression' && base.callee.type === 'MemberExpression' && base.callee.object) base = base.callee.object;
    const isIife = base.type === 'CallExpression' && isFnNode(base.callee) && base.callee.async === true;
    if (isIife) {
      if (outer.kind === 'catch') { caught += 1; return; }
      const tier = outer.kind === 'then1' ? 'thenOnly' : 'bareIife';
      tiers[tier].push(n.loc.start.line);
      points.push({ tier, id: pointId(src, n), line: n.loc.start.line, text: src.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 100) });
      return;
    }
    // 非 IIFE 的 `.then` 链**不进 ratchet**（主理人裁决）：
    //   · `waitP.then(fn)`（r0-trust-boundaries:36）里的 `ApprovalChannel.wait` 生命周期只有 resolve
    //     （`main/approvalChannel.js:66-80`：new Promise((resolve) => …)，超时也 resolve('deny')）⇒ 永不 reject，不构成缺陷；
    //   · 其余 `.then` 链要判「拒绝是否被下游 catch/双参 then 接住」必须做链式分析，
    //     本轮实测出现过 1 / 2 / 9 三个互不相同的数 ⇒ 无法给出可复现基线，故暂不立规则。
    // 残留风险（`.then` 回调里 check 抛错）由 preload 运行时兜住，归 ③ 覆盖。
  });

  return { violations, syncNotAwaited, checkedCalls, asyncCapableCalls, callsByKind, helpers, tiers, caught, points };
}

function scanRepo() {
  const files = fs.readdirSync(TEST_DIR).filter((f) => /\.test\.(js|mjs)$/.test(f)).sort();
  const perFile = {};
  const violations = [];
  const totals = { checkedCalls: 0, asyncCapableCalls: 0, bareIife: 0, thenOnly: 0, caught: 0, asyncKw: 0, promiseRet: 0 };
  const details = [];
  const parseFailed = [];
  const syncInfo = [];
  const points = [];

  for (const f of files) {
    const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    let r;
    try { r = scanFile(src, f); }
    catch (e) { parseFailed.push(`${f}: ${e.message}`); continue; }
    totals.checkedCalls += r.checkedCalls;
    totals.asyncCapableCalls += r.asyncCapableCalls;
    totals.caught += r.caught;
    totals.asyncKw += r.callsByKind.asyncKw;
    totals.promiseRet += r.callsByKind.promiseRet;
    const counts = { bareIife: r.tiers.bareIife.length, thenOnly: r.tiers.thenOnly.length };
    for (const t of TIERS) totals[t] += counts[t];
    if (counts.bareIife || counts.thenOnly) perFile[`test/${f}`] = counts;
    for (const t of TIERS) for (const line of r.tiers[t]) details.push(`[${t}] test/${f}:${line}`);
    for (const v of r.violations) violations.push(`test/${f}:${v.line}  [${v.kind}] ${v.helper}`);
    for (const x of (r.syncNotAwaited || [])) syncInfo.push({ helper: x.helper, line: `test/${f}:${x.line}` });
    for (const pt of (r.points || [])) points.push({ file: `test/${f}`, ...pt });
  }
  return { files, perFile, violations, totals, details, parseFailed, syncInfo, points };
}

function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); }
  catch { return null; }
}

function selfTest() {
  const cases = [
    {
      name: '有 await 的正常写法不红',
      src: 'async function check(n, fn){ await fn(); }\nconst main = async () => { await check("x", async () => {}) };\n',
      expectRule1: 0,
    },
    {
      name: 'checkAsync 形态（.then 串回调）不红',
      src: 'function checkAsync(n, fn){ return Promise.resolve().then(fn).then(() => {}).catch((e) => {}); }\nconst main = async () => { await checkAsync("x", async () => {}) };\n',
      expectRule1: 0,
    },
    {
      name: '同步 helper + async 回调必红',
      src: 'function check(n, fn){ try { fn(); } catch (e) {} }\ncheck("x", async () => {});\n',
      expectRule1: 1,
    },
    {
      name: 'async-capable helper 未 await 且回调是 async ⇒ 必红（失败会丢）',
      src: 'async function check(n, fn){ await fn(); }\ncheck("x", async () => {});\n',
      expectRule1: 1,
    },
    {
      name: 'async-capable helper 未 await 但回调同步 ⇒ 不红（记 info；全仓 1 处 engine-process:36）',
      src: 'async function check(n, fn){ await fn(); }\ncheck("x", () => {});\n',
      expectRule1: 0,
    },
    {
      name: '裸 async IIFE 计入 bareIife；带 .catch 不计',
      src: '(async () => { await x(); })();\n(async () => { await x(); })().catch((e) => {});\n',
      expectBare: 1,
      expectCaught: 0,
    },
    {
      name: '.then(f, r) 双参算已处理，不算裸（非 IIFE 形态）',
      src: 'p.then((v) => {}, (e) => {});\n',
      expectThenOnly: 0,
    },
    {
      name: 'IIFE + .then(onOk, onErr) 双参算已处理（chrome-relay:61 形态，防漏判致假红）',
      src: '(async () => { await x(); })().then((v) => {}, (e) => {});\n',
      expectBare: 0,
      expectThenOnly: 0,
    },
  ];
  let ok = true;
  for (const c of cases) {
    const r = scanFile(c.src, 'self.mjs');
    const r1 = r.violations.length;
    const bare = r.tiers.bareIife.length;
    const thenOnly = r.tiers.thenOnly.length;
    const pass = (c.expectRule1 === undefined || c.expectRule1 === r1)
      && (c.expectBare === undefined || c.expectBare === bare)
      && (c.expectThenOnly === undefined || c.expectThenOnly === thenOnly);
    if (!pass) ok = false;
    console.log(`${pass ? '✔' : '✘'} [self-test] ${c.name}  → ①违规=${r1} 裸IIFE=${bare} 仅then=${thenOnly}`);
  }
  console.log(ok ? '[self-test] PASS' : '[self-test] FAIL：判据退化');
  return ok ? 0 : 1;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { write: false, selfTest: false, verbose: false, root: null, baseline: null };
  const unknown = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--write') opts.write = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--root') { opts.root = args[++i]; }
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
    else if (a === '--baseline') { opts.baseline = args[++i]; }
    else if (a.startsWith('--baseline=')) opts.baseline = a.slice('--baseline='.length);
    else unknown.push(a);
  }
  return { opts, unknown };
}

function main(argv) {
  const { opts, unknown } = parseArgs(argv);
  if (unknown.length) {
    console.error(`未知参数：${unknown.join(' ')}\n用法：node scripts/audit-check-await.cjs [--write|--self-test|--verbose] [--root=<dir>] [--baseline=<path>]`);
    return 2;
  }
  // 反向用例必须能在 os.tmpdir() 里跑：--root / --baseline 覆盖扫描根与基线路径
  if (opts.root) {
    // --root 指向「含 test/ 的目录」或「test 目录本身」都可以（反向用例在 tmpdir 里两种都会用到）
    const r = path.resolve(opts.root);
    TEST_DIR = fs.existsSync(path.join(r, 'test')) ? path.join(r, 'test') : r;
  }
  if (opts.baseline) BASELINE_PATH = path.resolve(opts.baseline);
  if (opts.selfTest) return selfTest();
  if (!fs.existsSync(TEST_DIR)) {
    console.error(`扫描根不存在：${TEST_DIR}`);
    return 2;
  }

  const { files, perFile, violations, totals, details, parseFailed, syncInfo, points } = scanRepo();
  const totalBare = totals.bareIife + totals.thenOnly;

  // 两个子类必须分列：promise 返回型（checkAsync）是这条规则最初存在的理由，
  // 输出里看不出它被检了多少，下一轮又会有人问「那 15 处到底检没检」。
  console.log(`① helper 判据：${files.length} 个套件 · async-capable ${totals.asyncKw + totals.promiseRet} 处`
    + `（async 关键字型 ${totals.asyncKw} / promise 返回型 ${totals.promiseRet}）· 违规 ${violations.length}`);
  console.log('   口径：只认 /^check/i；async-capable = async 关键字 ∨ 体内 await ∨ 回调被串进 .then 链；'
    + '违规 = (i) 非 async-capable helper 收 async 回调 (ii) async-capable 调用点未 await 且回调为 async'
    + '（未 await 但回调同步仅记 ℹ 信息项）');
  const asyncIifeTotal = totals.bareIife + totals.thenOnly + totals.caught;
  console.log(`② async IIFE 语句总数 ${asyncIifeTotal} · 已兜住(.catch/.finally/双参.then/await) ${totals.caught}`
    + ` · 仅 .then ${totals.thenOnly}（近似口径，未做链式判定）· 真裸 ${totals.bareIife}`
    + ` ⇒ 需盯合计 ${totalBare}（ratchet，只许下降）· 非零文件 ${Object.keys(perFile).length}`);
  console.log('   口径：最内层调用是 `(async () => …)()` 且外层链既无 `.catch(`/`.finally(`/双参 `.then` ⇒ 计裸；'
    + '与 IIFE 体内的 .catch 无关（体内兜底不算外层兜底）');

  if (opts.verbose) details.forEach((d) => console.log(`   ${d}`));

  let bad = 0;
  // 防「扫描域为空导致恒绿」：一个 async-capable 都没扫到，说明判据没生效
  if (totals.asyncKw === 0 && totals.promiseRet === 0) {
    console.error('\n❌ 未扫到任何 async-capable helper 调用点（判据可能未生效，按红处理）');
    bad += 1;
  }
  if (parseFailed.length) {
    console.error(`\n❌ 解析失败 ${parseFailed.length} 个文件（判据未生效 = 红）：\n  ${parseFailed.join('\n  ')}`);
    bad += 1;
  }
  if (violations.length) {
    console.error(`\n❌ ① 违规 ${violations.length} 处：`);
    violations.forEach((v) => console.error(`  ${v}`));
    bad += 1;
  } else {
    console.log('   ✅ ① 无违规（async-capable helper 的 async 调用点都已 await；无同步 helper 收 async 回调）');
  }
  if (syncInfo.length) {
    console.log(`   ℹ ① 信息项：${syncInfo.length} 处「未 await 但回调同步」——不会丢失败，仅 [PASS] 与汇总的相对时序略有影响：`);
    syncInfo.forEach((x) => console.log(`     ${x.helper} @ ${x.line}`));
  }

  // ── ② 基线：位置级（id = 语句内容哈希），不是计数级 ──
  // 为什么必须位置级：计数级会被「同一文件删一处、加一处」抵消；位置级新增即红。
  // 为什么用内容哈希而不是行号：行号随任何编辑漂移，用行号会让每次改动都假红。
  // ratchet 四判（文字与实现一一对应，防再争）：
  //   1. 既有文件计数上升            ⇒ 红（位置级：新增位置即红，不止计数）
  //   2. 新文件且计数 > 0            ⇒ 红（新文件 0 处**不**红，否则每加一个套件都得 --write）
  //   3. 计数下降但基线未更新         ⇒ 提示 --write（不红）
  //   4. 文件消失（删除/改名）        ⇒ 提示 --write（不红，但必须打印，防改名绕过）
  const pointKey = (pt) => `${pt.file}#${pt.id}`;
  if (opts.write) {
    const snapshot = {
      version: 3,
      generatedAt: new Date().toISOString(),
      note: '② ratchet 基线（位置级）：key = 文件#语句内容哈希；新增即红，消失请重跑 --write',
      tiers: { bareIife: totals.bareIife, thenOnly: totals.thenOnly },
      files: perFile,
      points: Object.fromEntries(points.map((pt) => [pointKey(pt), { tier: pt.tier, line: pt.line, text: pt.text }])),
    };
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`\n✅ 已写入基线 ${path.relative(DESKTOP, BASELINE_PATH)}（${Object.keys(perFile).length} 个文件 / ${points.length} 个位置）`);
    return bad ? 1 : 0;
  }

  const base = loadBaseline();
  if (!base) {
    console.error(`\n❌ 基线文件缺失：${path.relative(DESKTOP, BASELINE_PATH)}（先跑 --write 生成）`);
    return 1;
  }
  const basePoints = base.points || {};
  const nowKeys = new Map(points.map((pt) => [pointKey(pt), pt]));
  const added = [...nowKeys.keys()].filter((k) => !(k in basePoints));
  const removed = Object.keys(basePoints).filter((k) => !nowKeys.has(k));

  if (added.length) {
    console.error(`\n❌ ② ratchet 违规：新增 ${added.length} 处裸 promise 语句（位置级判定，改掉或走评审后 --write）：`);
    added.forEach((k) => console.error(`  ${k}  ${nowKeys.get(k).text}`));
    bad += 1;
  }
  if (removed.length) {
    console.log(`\nℹ ② ${removed.length} 处消失（清理是好事）——请重跑 \`--write\` 更新基线（不判红）：`);
    removed.forEach((k) => console.log(`  ${k}`));
  }
  if (!added.length) {
    console.log(`   ✅ ② ratchet 通过（基线 ${Object.keys(basePoints).length} 个位置，现算 ${points.length}；`
      + `无新增${removed.length ? `，${removed.length} 处已清理待更新基线` : ''}）`);
  }
  if (base.version !== 3) {
    console.error(`\n❌ 基线 version=${base.version}，当前判据需要 version=3（tiers: bareIife/thenOnly）；请重跑 --write`);
    bad += 1;
  }
  return bad ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { scanFile, scanRepo };
