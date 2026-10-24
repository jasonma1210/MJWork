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
// S12：--write 是这道闸唯一的后门，位置级指纹的代价是「改裸 async IIFE 内部也会红」⇒ 合法轮换会
//   越来越频繁 ⇒ --write 会变成肌肉记忆 ⇒ 到那时一个**真实新增**的裸 promise 会被顺手吸收。
//   故 --write 加理由门禁：按**文件**判定（不能用总数），某文件净增即必须给人工理由，否则拒绝写入。
//
// 用法：
//   node scripts/audit-check-await.cjs               # 检查（① 硬红；② ratchet）
//   node scripts/audit-check-await.cjs --write [--reason="…"]   # 现算并写入基线（净增时理由必填）
//   node scripts/audit-check-await.cjs --self-test   # 反向用例 + 正向样本 + --write 门禁用例（见下）
//   node scripts/audit-check-await.cjs --verbose     # 打印 ② 的逐条明细
//   未知参数 → exit 2（防「参数写错但 exit 0」的空过）
//   --write 缺理由 → exit 3（基线保持原样，写一条 history 也不写）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const espree = require('espree');

const DESKTOP = path.resolve(__dirname, '..');
const DEFAULT_TEST_DIR = path.join(DESKTOP, 'test');
const DEFAULT_BASELINE = path.join(DEFAULT_TEST_DIR, 'fixtures/bare-promise-baseline.json');
// 可被 --root / --baseline 覆盖：反向用例要在 os.tmpdir() 里跑，绝不能往仓库写临时文件
let TEST_DIR = DEFAULT_TEST_DIR;
let BASELINE_PATH = DEFAULT_BASELINE;
const HELPER_NAME_RE = /^check/i;
const TIERS = ['bareIife', 'thenOnly'];
// S12：净变化 ≤ 0 的 --write 自动记这条理由。真新增时**不许**照抄它（防止把真新增伪装成清理）。
const CLEANUP_MARKER = '[auto] 净变化 ≤ 0（清理 / 键轮换），无需人工理由';
/** `文件#指纹` → 文件部分（指纹是 12 位 hex，文件名里不会出现 `#`） */
const fileOf = (key) => key.slice(0, key.lastIndexOf('#'));
const sha256Of = (data) => crypto.createHash('sha256').update(data).digest('hex');

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
  console.log('   —— S12：--write 理由门禁（os.tmpdir() 隔离，不碰真实基线）——');
  for (const c of selfTestWriteGate()) {
    if (!c.pass) ok = false;
    console.log(`${c.pass ? '✔' : '✘'} [self-test] ${c.name}  → ${c.detail}`);
  }
  console.log(ok ? '[self-test] PASS' : '[self-test] FAIL：判据退化');
  return ok ? 0 : 1;
}

/**
 * S12：--write 理由门禁的用例。全部在 os.tmpdir() 里跑（--root / --baseline 隔离开关），
 * 绝不碰真实基线。反向用例（S5）尤其重要：证明加了后门之后「正门」没有被顺手锁死。
 */
function selfTestWriteGate() {
  const results = [];
  const push = (name, pass, detail) => results.push({ name, pass, detail });

  // 夹具必须含一个 async-capable 的 check 调用点：否则「防空气化」守卫
  // （asyncKw + promiseRet === 0 ⇒ 红）会把 exit 顶成 1，掩盖本用例真正要验的东西。
  const FIXTURE = [
    'async function check(name, fn) { await fn(); }',
    "async function main() { await check('x', async () => {}); }",
    'main();',
    '(async () => { await Promise.resolve(1); })();',
    '',
  ].join('\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's12-write-gate-'));
  const fakePt = (file, id) => [`${file}#${id}`, { tier: 'bareIife', line: 1, text: '(async () => { … })();' }];

  const mk = (label, baseline) => {
    const dir = path.join(tmp, label);
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'a.test.mjs'), FIXTURE);
    const bp = path.join(dir, 'baseline.json');
    fs.writeFileSync(bp, `${JSON.stringify(baseline, null, 2)}\n`);
    return { dir, bp };
  };
  const run = (dir, bp, extra = [], script = __filename) => {
    // NODE_PATH + cwd 必须带上：变异体会被复制到 tmpdir，而 `require('espree')` 是按脚本所在目录
    // 解析的，不带这两项会 MODULE_NOT_FOUND 崩溃（exit 1）——那会让「对照实验」靠崩溃蒙混过关，
    // 而不是真的证明目标逻辑被禁用后用例失守（实测踩过，差点当成结论报上去）。
    const r = spawnSync(process.execPath, [script, '--root', dir, '--baseline', bp, ...extra], {
      encoding: 'utf8',
      cwd: DESKTOP,
      env: { ...process.env, NODE_PATH: path.join(DESKTOP, 'node_modules') },
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const readBase = (bp) => JSON.parse(fs.readFileSync(bp, 'utf8'));
  /** 变异体是否**真的跑起来了**（打印了常规横幅）——用来排除「靠崩溃蒙混过关」 */
  const ranOk = (x) => /① helper 判据：/.test(x.out);

  /** 跑一个场景。before/after 是基线文件的 sha256 —— 用来证明「到底写没写」。 */
  const scenario = (label, baseline, extra = [], script = __filename) => {
    const { dir, bp } = mk(label, baseline);
    const before = sha256Of(fs.readFileSync(bp));
    const r = run(dir, bp, extra, script);
    return { ...r, bp, before, after: sha256Of(fs.readFileSync(bp)) };
  };

  /**
   * 把本脚本复制到 tmpdir 并做**文本变异**，返回变异体路径。
   * 用途：对照实验（见 M1-M4）—— 把被测逻辑的实现路径整条失效，
   * 若对应的正向用例**仍然判通过**，说明它压根没打在这条路径上（被别的层兜住了），属漏判。
   * 锚点必须**唯一**，否则变异可能改到别处而得出假结论。
   */
  const mutateScript = (label, pairs) => {
    const whole = fs.readFileSync(__filename, 'utf8');
    // 变异范围 = 全文件**去掉本自测函数的函数体**：
    // 本函数的字面量里就含这些锚点，全文件替换会让唯一性检查误报 2 次（实测踩过），
    // 也会把自测代码一起改坏。注意实现代码在 main() 里，位于本函数**之后**，所以两端都要变异。
    // 用「前导换行 + 签名」定位：本函数自己的源码里也写着这两个签名字符串
    // （在字符串字面量里，前面是引号不是换行），不带换行会定位到本函数内部（实测踩过）。
    const cut = whole.indexOf('\nfunction selfTestWriteGate() {') + 1;
    const parseIdx = whole.indexOf('\nfunction parseArgs(argv) {') + 1;
    if (cut <= 0 || parseIdx <= cut) throw new Error('找不到自测函数区段，无法隔离变异范围');
    let head = whole.slice(0, cut);
    let tail = whole.slice(parseIdx); // main() 里的写分支/检查分支都在这段
    const mid = whole.slice(cut, parseIdx); // 自测函数本体：原样保留
    for (const [from, to] of pairs) {
      const n = (head.split(from).length - 1) + (tail.split(from).length - 1);
      if (n !== 1) throw new Error(`变异锚点在实现区段命中 ${n} 次（要求恰好 1 次）：${from}`);
      head = head.replace(from, to);
      tail = tail.replace(from, to);
    }
    const p = path.join(tmp, `mut-${label}.cjs`);
    fs.writeFileSync(p, head + mid + tail);
    return p;
  };

  const BASE_EMPTY = { version: 3, points: {} };
  const BASE_A2 = { version: 3, points: Object.fromEntries([fakePt('test/a.test.mjs', 'old000000001'), fakePt('test/a.test.mjs', 'old000000002')]) };
  const BASE_B2 = { version: 3, points: Object.fromEntries([fakePt('test/b.test.mjs', 'old000000001'), fakePt('test/b.test.mjs', 'old000000002')]) };
  const BASE_A1_NO_HISTORY = { points: Object.fromEntries([fakePt('test/a.test.mjs', 'old000000001')]) };

  // 判定函数：正向用例与「禁用实现后的对照实验」**共用同一条判定**，
  // 保证两边打的是同一条路径（否则对照实验证明的东西跟正向用例不是一回事）。
  const judgeRejected = (x) => x.status === 3 && x.before === x.after;
  const judgeS5 = (x) => x.status === 1 && /② ratchet 违规/.test(x.out) && x.before === x.after;
  const judgeS4 = (x) => {
    if (x.status !== 0) return false;
    const h = readBase(x.bp).history;
    return Array.isArray(h) && h.length === 1;
  };

  try {
    // S1：某文件净增、不带 --reason ⇒ exit=3，且基线字节未变（用 sha256 证明没被写坏）
    {
      const x = scenario('s1', BASE_EMPTY, ['--write']);
      push('S1 --write 净增无理由 ⇒ exit=3 且基线字节未变',
        judgeRejected(x),
        `status=${x.status}（期望 3）· sha256 前后${x.before === x.after ? '相等' : '不等（基线被写了！）'}`);
    }

    // S2：同上但带 --reason ⇒ exit=0，history 里出现理由**原文**（逐字比对）
    {
      const reason = 'S12-S2 理由原文：这处是新增 fixture 用的，不是产品回归';
      const x = scenario('s2', BASE_EMPTY, ['--write', `--reason=${reason}`]);
      const got = (readBase(x.bp).history || [])[0];
      push('S2 带 --reason ⇒ exit=0 且 history 存理由原文',
        x.status === 0 && got && got.reason === reason,
        `status=${x.status}（期望 0）· history[0].reason ${got && got.reason === reason ? '逐字一致' : `不符：${JSON.stringify(got && got.reason)}`}`);
    }

    // S3：净变化 ≤ 0（同文件 1 增 2 消）不带理由 ⇒ 放行，history 自动记清理标记
    {
      const x = scenario('s3', BASE_A2, ['--write']);
      const got = (readBase(x.bp).history || [])[0];
      push('S3 净变化 ≤ 0 无理由 ⇒ 放行，history 记清理标记',
        x.status === 0 && got && got.reason === CLEANUP_MARKER && got.net === -1,
        `status=${x.status}（期望 0）· net=${got && got.net}（期望 -1）· reason ${got && got.reason === CLEANUP_MARKER ? '= 清理标记' : `不符：${JSON.stringify(got && got.reason)}`}`);
    }

    // S4：老基线没有 history 字段 ⇒ 读成空数组，不崩
    {
      const x = scenario('s4', BASE_A1_NO_HISTORY, ['--write']);
      push('S4 老基线缺 history 字段 ⇒ 读成空数组不崩',
        judgeS4(x),
        `status=${x.status}（期望 0）· history ${judgeS4(x) ? '数组 len=1' : `异常：${JSON.stringify(readBase(x.bp).history)}`}`);
    }

    // S5（最关键，反向验证）：造一个新增裸 promise 的 fixture，**不带 --write** 跑纯检查 ⇒ 仍 exit=1。
    // 这条证明加的 --write 门禁没有削弱原判据 —— 后门加锁不能顺手把正门也锁死。
    // before/after 也纳入判定：确保它走的是**纯检查路径**，没有绕道触发写路径把基线改了。
    {
      const x = scenario('s5', BASE_EMPTY, []);
      push('S5 反向：新增裸 promise 不带 --write 纯检查 ⇒ 仍 exit=1（正门没被锁死，且未落笔）',
        judgeS5(x),
        `status=${x.status}（期望 1）· 输出含「② ratchet 违规」=${/② ratchet 违规/.test(x.out)} · 基线字节未变=${x.before === x.after}`);
    }

    // S6：总数净减但某文件净增（别处删 2 + 此处加 1）⇒ 仍要理由（总数口径会漏，按文件不会）
    {
      const x1 = scenario('s6a', BASE_B2, ['--write']);
      const x2 = scenario('s6b', BASE_B2, ['--write', '--reason=S12-S6 别处删了 2 处，此处是真实新增']);
      const b2 = readBase(x2.bp);
      const got = (b2.history || [])[0];
      push('S6 总数净减但某文件净增 ⇒ 仍要理由（按文件判定，不看总数）',
        judgeRejected(x1) && x2.status === 0 && got && got.net === -1 && got.files.some((f) => f.delta > 0),
        `无理由 status=${x1.status}（期望 3）· 基线未变=${x1.before === x1.after} · 有理由 status=${x2.status}（期望 0）`
        + ` · net=${got && got.net} · 存在净增文件=${!!(got && got.files.some((f) => f.delta > 0))}`);
    }

    // ── 以下 M1-M4 是**对照实验**（gate-s8a 的 N3 教训：冗余防御会让单点反向验证失真）──
    // 做法：把被测逻辑的实现路径整条失效，再看对应正向用例是否**失守**。
    // 失守 = 该用例确实打在这条路径上；仍然通过 = 它被别的层兜住了，是漏判，必须报红。

    // M1：把理由校验整条短路 ⇒ S1 必须失守（否则 S1 根本没验到理由校验）
    {
      const script = mutateScript('m1', [['if (!given || given === CLEANUP_MARKER) {', 'if (false) {']]);
      const x = scenario('m1', BASE_EMPTY, ['--write'], script);
      push('M1 对照：短路理由校验 ⇒ S1 必须失守（证明 S1 打在理由校验上）',
        ranOk(x) && x.status === 0 && x.before !== x.after,
        `变异体跑起来了=${ranOk(x)} · status=${x.status}（期望 0）· 基线被改动=${x.before !== x.after}（期望 true）`
        + ` ⇒ 失败形态=${x.status === 0 && x.before !== x.after ? '**静默放行**（正是这道闸要防的：无理由也照写）' : '非预期形态'}`
        + ` · S1 ${judgeRejected(x) ? '**仍判通过 = 漏判**' : '正确失守'}`);
    }

    // M2：把「按文件判定」换成「按总数判定」⇒ S6 必须失守。
    // S6 正是「总数净减但某文件净增」的形态，这条对照证明 S6 打在按文件逻辑上，不是碰巧红。
    {
      // 注意：不能变异成 `net > 0 ? …` —— net 在 grew 之后声明，会 TDZ 崩溃，
      // 那就变成「靠崩溃蒙混过关」而不是真的换成总数口径（实测踩过）。
      const script = mutateScript('m2', [['const grew = deltaByFile.filter((d) => d.delta > 0);',
        'const grew = addedKeys.length > removedKeys.length ? deltaByFile : [];']]);
      const x = scenario('m2', BASE_B2, ['--write'], script);
      push('M2 对照：按文件判定改成按总数 ⇒ S6 必须失守（证明 S6 打在按文件逻辑上）',
        ranOk(x) && x.status === 0 && x.before !== x.after,
        `变异体跑起来了=${ranOk(x)} · status=${x.status}（期望 0）· 基线被改动=${x.before !== x.after}（期望 true）`
        + ` ⇒ 失败形态=${x.status === 0 && x.before !== x.after ? '**静默放行**（总数净减 ⇒ 漏掉 a 文件净增）' : '非预期形态'}`
        + ` · S6 ${judgeRejected(x) ? '**仍判通过 = 漏判**' : '正确失守'}`);
    }

    // M3：把**检查路径**（写路径之外那条）的 added 整条置空 ⇒ S5 必须失守。
    // added/removed 在脚本里有两条实现路径（写基线时算一次、纯检查时算一次，见 541/609），
    // 只验一条就宣称「新增即红」成立是不行的 —— 这条证明检查路径那一条也被 S5 验到了。
    {
      const script = mutateScript('m3', [['const added = [...nowKeys.keys()].filter((k) => !(k in basePoints));', 'const added = [];']]);
      const x = scenario('m3', BASE_EMPTY, [], script);
      push('M3 对照：置空检查路径的 added ⇒ S5 必须失守（两条 added 路径都要验到）',
        ranOk(x) && x.status === 0 && !/② ratchet 违规/.test(x.out),
        `变异体跑起来了=${ranOk(x)} · status=${x.status}（期望 0）· 含「② ratchet 违规」=${/② ratchet 违规/.test(x.out)}（期望 false）`
        + ` ⇒ 失败形态=${x.status === 0 ? '**静默变绿**（正门被锁死，新增也不报）' : '非预期形态'}`
        + ` · S5 ${judgeS5(x) ? '**仍判通过 = 漏判**' : '正确失守'}`);
    }

    // M4：去掉「老基线缺 history」的容错 ⇒ S4 必须失守（崩掉），证明 S4 打在这条容错上
    {
      const script = mutateScript('m4', [['Array.isArray(prev && prev.history) ? prev.history.slice() : []', 'prev.history.slice()']]);
      const x = scenario('m4', BASE_A1_NO_HISTORY, ['--write'], script);
      push('M4 对照：去掉 history 缺失容错 ⇒ S4 必须失守（证明 S4 打在这条容错上）',
        ranOk(x) && x.status !== 0,
        `变异体跑起来了=${ranOk(x)}（横幅已打印 ⇒ 崩在容错那一步，不是加载失败）· status=${x.status}（期望非 0）`
        + ` ⇒ 失败形态=${x.status !== 0 ? '**明确崩溃**（老基线缺 history 就直接炸）' : '非预期形态'}`
        + ` · S4 ${judgeS4(x) ? '**仍判通过 = 漏判**' : '正确失守'}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { write: false, selfTest: false, verbose: false, root: null, baseline: null, reason: null };
  const unknown = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--write') opts.write = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--reason') { opts.reason = args[++i] ?? ''; }
    else if (a.startsWith('--reason=')) opts.reason = a.slice('--reason='.length);
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
    console.error(`未知参数：${unknown.join(' ')}\n用法：node scripts/audit-check-await.cjs [--write [--reason="…"]|--self-test|--verbose] [--root=<dir>] [--baseline=<path>]`);
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
    const prev = loadBaseline();
    const prevPoints = (prev && prev.points) || {};
    const nowKeyList = points.map(pointKey);
    const nowKeys = new Set(nowKeyList);
    const addedKeys = nowKeyList.filter((k) => !(k in prevPoints));
    const removedKeys = Object.keys(prevPoints).filter((k) => !nowKeys.has(k));

    // ── S12：是否「真新增」必须按**文件**判定，不能用总数 ──
    // 同文件 1 增 1 消 = 键轮换（内容改了，位置数没涨），是清理，不是新增；
    // 而「别处删 2 处 + 此处新加 1 处」总数净减、但该文件确实净增，用总数会漏掉。
    const addByFile = new Map();
    const remByFile = new Map();
    for (const k of addedKeys) addByFile.set(fileOf(k), (addByFile.get(fileOf(k)) || 0) + 1);
    for (const k of removedKeys) remByFile.set(fileOf(k), (remByFile.get(fileOf(k)) || 0) + 1);
    const deltaByFile = [...new Set([...addByFile.keys(), ...remByFile.keys()])].map((f) => {
      const a = addByFile.get(f) || 0;
      const r = remByFile.get(f) || 0;
      return { file: f, added: a, removed: r, delta: a - r };
    }).sort((x, y) => (y.delta - x.delta) || x.file.localeCompare(y.file));
    const grew = deltaByFile.filter((d) => d.delta > 0);
    const net = addedKeys.length - removedKeys.length;

    let reason = CLEANUP_MARKER;
    if (grew.length) {
      const given = String(opts.reason ?? '').trim();
      if (!given || given === CLEANUP_MARKER) {
        console.error(`\n❌ --write 被拒绝：以下文件的裸 promise 位置**净增**，必须给出人工理由：`
          + ` node scripts/audit-check-await.cjs --write --reason="为什么这里多了一处"`);
        grew.forEach((d) => console.error(`  ${d.file}  新增 ${d.added} 处 / 消失 ${d.removed} 处 ⇒ 净 +${d.delta}`));
        console.error('  理由不能为空，也不能照抄脚本的自动清理标记（那条只给「净变化 ≤ 0」用）。');
        console.error(`  基线未改动：${path.relative(DESKTOP, BASELINE_PATH)}`);
        return 3;
      }
      reason = given;
    }

    // history：老基线可能没有这个字段（读成空数组，不崩）
    const history = Array.isArray(prev && prev.history) ? prev.history.slice() : [];
    history.push({
      at: new Date().toISOString(),
      added: addedKeys.length,
      removed: removedKeys.length,
      net,
      files: deltaByFile.filter((d) => d.delta !== 0),
      reason,
    });

    const snapshot = {
      version: 3,
      generatedAt: new Date().toISOString(),
      note: '② ratchet 基线（位置级）：key = 文件#语句内容哈希；新增即红，消失请重跑 --write',
      tiers: { bareIife: totals.bareIife, thenOnly: totals.thenOnly },
      files: perFile,
      points: Object.fromEntries(points.map((pt) => [pointKey(pt), { tier: pt.tier, line: pt.line, text: pt.text }])),
      history,
    };
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`\n✅ 已写入基线 ${path.relative(DESKTOP, BASELINE_PATH)}（${Object.keys(perFile).length} 个文件 / ${points.length} 个位置）`);
    console.log(`   新增 ${addedKeys.length} / 消失 ${removedKeys.length} / 净 ${net >= 0 ? `+${net}` : net}`
      + `${grew.length ? ` · 净增文件 ${grew.length} 个（已要求理由）` : ' · 无文件净增（清理/轮换）'}`);
    console.log(`   理由：${reason}`);
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
