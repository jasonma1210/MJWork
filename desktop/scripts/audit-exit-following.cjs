#!/usr/bin/env node
// 回归判据：`process.exit()` 之后**不得还有会被执行的代码**——口径按**祖先链**，不是「同块内」。
//
// 为什么需要这条（2026-10-24，批次 3 / S6-③）：
//   `test/helpers/unhandled-preload.cjs` 为了抓住「被 process.exit(0) 丢掉的在途 unhandled rejection」，
//   会对「以 0 退出」的调用**延迟一个宏任务**再真正退出；非 0 退出保持同步。
//   延迟的代价是：`exit(0)` 之后同层/外层后续语句会**多执行一次**。
//   ⇒ 这条判据把「延迟是否等价变换」变成可机器检查的不变量：
//     凡是「实参可能为 0」且「exit 之后还有会被执行的代码」的位置，都必须显式登记（附理由）。
//
// 口径说明（两种都试过，差 36 处，别混用）：
//   · 「同一语句块内后面还有语句」= 1 处（漏掉 `if` 内的 exit、`if` 之后还有代码这种）
//   · 「祖先链上任一祖先在其语句数组中不是最后一项」= 37 处 → 本脚本采用（保守、不漏）
//   再按实参分类：字面非 0（`exit(1)`）在条件式延迟下**同步执行、零额外代码**，只有「可能为 0」的才需审。
//
// 为什么用 AST 而不是正则（本轮教训，同类错误犯了四次）：
//   正则会把注释里的 `process.exit(0)`、`-e 'process.exit(7)'` 字符串参数、
//   IIFE 尾巴重复计入（文本口径估出 111 处，AST 精确 37 处）。这类判据必须走 AST。
//
// 用法：
//   node scripts/audit-exit-following.cjs             # 扫描 test/*.test.*（0 通过 / 1 有未登记的「可能为 0 + 后续代码」）
//   node scripts/audit-exit-following.cjs --verbose   # 打印 37 处全量清单
//   node scripts/audit-exit-following.cjs --self-test # 反向用例：合成违规必须红、合成合法必须绿
//   未知参数 → exit 2（防「参数写错但 exit 0」的空过）
'use strict';

const fs = require('fs');
const path = require('path');
const espree = require('espree');

const DESKTOP = path.resolve(__dirname, '..');
const TEST_DIR = path.join(DESKTOP, 'test');

// 语句数组：只有这些容器里的「非末项」才意味着「之后还有会被执行的代码」
const STMT_ARRAY_KEYS = new Set(['body', 'consequent']);

// 已审清单：所有「实参可能为 0 且 exit 之后还有代码」的位置，必须在这里逐条登记理由。
// 判据要求：延迟退出后多执行的那一轮必须**不改变任何可观察结论**。
const AUDITED = [
  {
    file: 'plugin-bypass-hardening.test.js',
    line: 20,
    reason: 'report() 回调内 exit(f === 0 ? 0 : 1)，其后只有 "}" 与该回调的 `})();` 收尾；回调只被调用一次，多执行的一轮是空转',
  },
  {
    file: 'sandbox-linux.test.mjs',
    line: 290,
    reason: 'run() 异步函数末尾 exit(fail === 0 ? 0 : 1)，其后是 "};" 与 `run().catch(…)`；run() 只被调用一次，不会重跑',
  },
];

const isProcessExitCall = (n) => n.type === 'CallExpression'
  && n.callee.type === 'MemberExpression'
  && n.callee.object.type === 'Identifier' && n.callee.object.name === 'process'
  && ((n.callee.property.type === 'Identifier' && n.callee.property.name === 'exit')
    || (n.callee.property.type === 'Literal' && n.callee.property.value === 'exit'));

/**
 * 调用形态分类（三方一度报出 265 / 267 / 275 三个数，差异全在这些形态上——同一份报表里
 * 三个数并存等于没有数，所以这里把维度显式打出来，任何总数都能按形态复算）：
 *   form：plain（`process.exit(...)`）/ computed（`process['exit'](...)`）
 *   optional：是否使用了可选链（`process?.exit(...)` 或 `process.exit?.(...)`）
 *   args：has（有实参）/ omitted（省略实参，默认 0）
 *   site：statement（独立语句 ExpressionStatement）/ arrow-body（`() => process.exit(...)` 这类简洁函数体）
 *         / other（其他表达式位置，如 return 参数、三目分支）
 */
function callShape(n, parents) {
  const form = n.callee.property.type === 'Literal' ? 'computed' : 'plain';
  const optional = n.optional === true || n.callee.optional === true;
  const args = n.arguments.length === 0 ? 'omitted' : 'has';
  let site = 'other';
  const holder = parents.get(n);
  if (holder) {
    if (holder.parent.type === 'ExpressionStatement') site = 'statement';
    else if (holder.parent.type === 'ArrowFunctionExpression' && holder.key === 'body') site = 'arrow-body';
  }
  return { form, optional, args, site };
}

/** 实参是否「可能是 0」：字面 0 / 省略实参 / 任何非字面表达式的都算「可能为 0」（保守）。 */
function exitArgKind(n) {
  const a = n.arguments[0];
  if (!a) return { mayBeZero: true, text: '(无实参，默认 0)' };
  const isNumLit = a.type === 'Literal' && typeof a.value === 'number';
  if (isNumLit) return { mayBeZero: a.value === 0, text: String(a.value) };
  return { mayBeZero: true, text: '<表达式>' };
}

function indexParents(ast) {
  const map = new Map();
  (function walk(node) {
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'parent') continue;
      const v = node[key];
      if (Array.isArray(v)) {
        v.forEach((ch, i) => {
          if (ch && typeof ch.type === 'string') { map.set(ch, { parent: node, key, index: i, arr: v }); walk(ch); }
        });
      } else if (v && typeof v.type === 'string') {
        map.set(v, { parent: node, key, index: -1, arr: null });
        walk(v);
      }
    }
  })(ast);
  return map;
}

/**
 * 扫描一段源码，返回每个 process.exit 的判定。
 * @param {string} src
 * @param {string} filename 用于决定 sourceType（.mjs → module）
 */
function scanSource(src, filename = '<inline>.mjs') {
  const ast = espree.parse(src, {
    ecmaVersion: 'latest',
    sourceType: filename.endsWith('.mjs') ? 'module' : 'script',
    loc: true,
  });
  const parents = indexParents(ast);
  const out = [];
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (isProcessExitCall(node)) {
      // 祖先链：任一祖先在语句数组里且不是最后一项 ⇒ 之后还有会被执行的代码
      let codeAfter = null;
      let cur = node;
      while (parents.has(cur)) {
        const { parent, key, index, arr } = parents.get(cur);
        if (STMT_ARRAY_KEYS.has(key) && arr && index >= 0 && index < arr.length - 1) {
          codeAfter = { parentType: parent.type, nextType: arr[index + 1].type };
          break;
        }
        cur = parent;
      }
      out.push({
        line: node.loc.start.line,
        arg: exitArgKind(node),
        codeAfter,
        shape: callShape(node, parents),
      });
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'parent') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((ch) => walk(ch));
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
  return out;
}

function scanRepo() {
  const files = fs.readdirSync(TEST_DIR).filter((f) => /\.test\.(js|mjs)$/.test(f)).sort();
  const rows = [];
  const parseFailed = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    let hits;
    try { hits = scanSource(src, f); }
    catch (e) { parseFailed.push(`${f}: ${e.message}`); continue; }
    for (const h of hits) rows.push({ file: f, ...h });
  }
  return { files: files.length, rows, parseFailed };
}

const auditedKey = (file, line) => `${file}:${line}`;
const AUDITED_KEYS = new Set(AUDITED.map((a) => auditedKey(a.file, a.line)));

function main(argv) {
  const args = argv.slice(2);
  const known = new Set(['--verbose', '--self-test']);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length) {
    console.error(`未知参数：${unknown.join(' ')}\n用法：node scripts/audit-exit-following.cjs [--verbose|--self-test]`);
    return 2;
  }

  if (args.includes('--self-test')) {
    // 反向用例 1：`exit(0)` 之后还有副作用语句 ⇒ 必须判为「需审」
    const bad = 'function f(){ process.exit(0); fs.writeSync(1, "x"); }\n';
    // 反向用例 2：`exit(1)`（字面非 0）之后有语句 ⇒ 条件式延迟下同步退出、零额外执行 ⇒ 不需审
    const nonzero = 'function f(){ process.exit(1); cleanup(); }\n';
    // 反向用例 3：`exit(0)` 在 if 里、if 之后还有代码 ⇒ 祖先链口径必须抓到（同块口径会漏）
    const ancestor = 'function f(){ if (bad) { process.exit(0); } report(); }\n';
    // 反向用例 4：`exit(1); return;` ⇒ 合法，不需审
    const ok = 'function f(){ if (x) { process.exit(1); return; } done(); }\n';

    const needAudit = (src) => scanSource(src, 'self.mjs').filter((r) => r.codeAfter && r.arg.mayBeZero).length;
    const r1 = needAudit(bad), r2 = needAudit(nonzero), r3 = needAudit(ancestor), r4 = needAudit(ok);
    const pass = r1 === 1 && r2 === 0 && r3 === 1 && r4 === 0;
    console.log(`[self-test] exit(0) 后有副作用 → 需审 ${r1}（期望 1）`);
    console.log(`[self-test] exit(1) 后有语句 → 需审 ${r2}（期望 0，字面非 0 保持同步）`);
    console.log(`[self-test] if 内 exit(0)、if 后有代码（祖先链） → 需审 ${r3}（期望 1）`);
    console.log(`[self-test] exit(1); return; → 需审 ${r4}（期望 0）`);
    console.log(pass ? '[self-test] PASS：判据非恒真、不漏祖先链、不误伤字面非 0' : '[self-test] FAIL：判据退化');
    return pass ? 0 : 1;
  }

  const { files, rows, parseFailed } = scanRepo();
  const withAfter = rows.filter((r) => r.codeAfter);
  const mayZero = withAfter.filter((r) => r.arg.mayBeZero);
  const alwaysNonZero = withAfter.filter((r) => !r.arg.mayBeZero);
  const unaudited = mayZero.filter((r) => !AUDITED_KEYS.has(auditedKey(r.file, r.line)));
  const staleAudited = AUDITED.filter((a) => !rows.some((r) => r.file === a.file && r.line === a.line));

  console.log(`扫描 ${files} 个套件 · process.exit 调用 ${rows.length} 处 · 之后仍有代码 ${withAfter.length} 处`
    + `（其中字面非 0 ${alwaysNonZero.length} 处：条件式延迟下同步执行、零额外代码）`);

  // 分形态明细：总数必须能按形态复算，避免「265 / 267 / 275 三个数并存」
  const tally = (key, val) => rows.filter((r) => r.shape[key] === val).length;
  console.log(`  按调用形态：plain(\.exit) ${tally('form', 'plain')} · computed(['exit']) ${tally('form', 'computed')}`
    + ` · 可选链 ${rows.filter((r) => r.shape.optional).length} · 省略实参 ${tally('args', 'omitted')}`
    + `  ⇒ 合计 ${rows.length}`);
  console.log(`  按语句位置：statement ${tally('site', 'statement')} · arrow-body ${tally('site', 'arrow-body')}`
    + ` · other ${tally('site', 'other')}  ⇒ 合计 ${rows.length}`
    + `（「只计 ExpressionStatement」口径 = statement，可与外部报数对齐）`);
  console.log(`「可能为 0 且之后有代码」${mayZero.length} 处，其中已登记 ${mayZero.length - unaudited.length} 处`);

  if (args.includes('--verbose')) {
    for (const r of withAfter) {
      console.log(`  ${r.file}:${r.line}  exit(${r.arg.text})  mayBeZero=${r.arg.mayBeZero}  后续首句类型=${r.codeAfter.nextType}`);
    }
  }
  if (parseFailed.length) {
    console.error(`\n解析失败 ${parseFailed.length} 个文件（判据未生效 = 红）：\n  ${parseFailed.join('\n  ')}`);
  }
  if (staleAudited.length) {
    console.error(`\n❌ 已审清单有 ${staleAudited.length} 条过期（对应位置已不存在，请删除，避免清单越攒越长）：`);
    for (const a of staleAudited) console.error(`  ${a.file}:${a.line}`);
  }
  if (unaudited.length) {
    console.error(`\n❌ ${unaudited.length} 处「可能以 0 退出且之后还有代码」未登记：延迟退出会让它们多执行一轮，请逐个确认等价后登记：`);
    for (const r of unaudited) console.error(`  ${r.file}:${r.line}  exit(${r.arg.text})  后续首句=${r.codeAfter.nextType}`);
  }
  if (!unaudited.length && !staleAudited.length && !parseFailed.length) {
    console.log('✅ 通过：所有「可能以 0 退出且之后还有代码」的位置都已审登记；其余调用之后无代码（或字面非 0，保持同步）');
  }
  return (unaudited.length || staleAudited.length || parseFailed.length) ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { scanSource };
