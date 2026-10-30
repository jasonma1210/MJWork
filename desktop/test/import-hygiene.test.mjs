// C-007 门禁：未用导入 + 循环依赖（审计原话：「需 ts-prune/madge 才能精确判定，本次未做」）
//
// 为什么用 TypeScript 编译器 API 而不是正则：
//   2026-10-30 实测两种文本方案都错了，方向还相反——
//   ① 自写「注释剥离 + 数标识符」把 `...spread(x)` 里的 x 当成「属性访问」漏掉，
//      于是 createRunLifecycleCallbacks / pendingKnowledgePlanPayload 被误报未用（假红）；
//   ② 项目自带 scripts/lib/rawButtonScan.js 的 blankComments 面向「数 <button>」，
//      遇到正则字面量里含 `//` 的文件会把大段正文一起吞掉（gen-legacy-ledger.mjs 实测
//      正文 11953 → 8826 字符，createRequire 的调用点直接消失，又变成假红）。
//   ts.createSourceFile 给出真 AST：字符串里的同名词不算使用、属性名不算使用、
//   spread 里的标识符算使用——这三条恰好是文本方案错得最多的地方。
//
// 反向验证：随便在一个文件里加 `import { 不存在的东西 } from './x'`，本套件必须红；
// 或在两个文件间造成互相 require，`环` 段必须红。两段都带自测（见文件末尾）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
// 用仓库自带的 typescript（renderer 是 TS，本来就装了这一份），不新增依赖
const ts = require(path.join(DESKTOP, 'renderer', 'node_modules', 'typescript'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ROOTS = ['renderer/src', 'main', 'agent-core', 'chrome-extension', 'test', 'scripts'];
const EXTS = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.json'];
const SRC_RE = /\.(jsx?|tsx?|mjs|cjs)$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SRC_RE.test(e.name)) out.push(p);
  }
  return out;
}

const scriptKind = (f) => (/\.tsx$/.test(f) ? ts.ScriptKind.TSX
  : /\.ts$/.test(f) ? ts.ScriptKind.TS
  : /\.jsx$/.test(f) ? ts.ScriptKind.JSX
  : ts.ScriptKind.JS);

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(file));
}

// ── 第一部分：未用导入 ────────────────────────────────────────────────────────
// 判据：import 绑定名在文件里**没有**作为标识符被引用。
// 刻意排除的三类（都是「看起来没用到、其实不能删」）：
//   · import type / import { type X } —— 擦除后不存在，删了不影响运行时；
//   · 副作用导入 `import './x.css'` —— 没有绑定名；
//   · 命名空间导入必须整体出现（`ns.foo` 里 ns 是 Identifier，自然会被计到）。
function isBindingPosition(node, parent) {
  if (!parent) return false;
  if (ts.isImportSpecifier(parent) && parent.name === node) return true;
  if (ts.isImportClause(parent) && parent.name === node) return true;
  if (ts.isNamespaceImport(parent) && parent.name === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  // JSX 属性名（<div onClick={x}> 的 onClick）不是变量引用
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)
    || ts.isClassDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === node) return true;
  return false;
}

function unusedImports(file) {
  const sf = parse(file);
  const useCount = new Map();
  const visitUse = (node) => {
    if (ts.isIdentifier(node) && !isBindingPosition(node, node.parent)) {
      useCount.set(node.text, (useCount.get(node.text) || 0) + 1);
    }
    ts.forEachChild(node, visitUse);
  };
  visitUse(sf);

  const out = [];
  const visitImport = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const c = node.importClause;
      const names = [];
      if (c.name) names.push({ n: c.name.text, typeOnly: Boolean(c.isTypeOnly) });
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) {
          names.push({ n: c.namedBindings.name.text, typeOnly: Boolean(c.isTypeOnly) });
        } else {
          for (const s of c.namedBindings.elements) {
            names.push({ n: s.name.text, typeOnly: Boolean(c.isTypeOnly) || Boolean(s.isTypeOnly) });
          }
        }
      }
      for (const { n, typeOnly } of names) {
        if (typeOnly) continue;
        if (!useCount.get(n)) {
          out.push({ line, name: n, from: node.moduleSpecifier.text });
        }
      }
    }
    ts.forEachChild(node, visitImport);
  };
  visitImport(sf);
  return out;
}

// ── 第二部分：循环依赖 ────────────────────────────────────────────────────────
// 只跟**项目内相对路径**；裸模块（node:/react/…）不进图，否则 node_modules 里天然成环。
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  const cands = [abs,
    ...EXTS.map((e) => abs + e),
    ...EXTS.map((e) => path.join(abs, `index${e}`))];
  for (const c of cands) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function edgesOf(file) {
  const sf = parse(file);
  const out = [];
  const push = (spec) => { const r = resolveSpec(file, spec); if (r) out.push(r); };
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      push(n.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      // require('x') 与动态 import('x')
      const callee = n.expression;
      const isReq = callee && callee.text === 'require';
      const isDynImport = callee && callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isReq || isDynImport) push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function findCycles(files) {
  const graph = new Map(files.map((f) => [f, edgesOf(f)]));
  const state = new Map();
  const stack = [];
  const cycles = [];
  const dfs = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const m of graph.get(n) || []) {
      if (!graph.has(m)) continue; // 指向项目外（或非源码文件）不算
      const s = state.get(m) || 0;
      if (s === 1) {
        const i = stack.indexOf(m);
        cycles.push(stack.slice(i).concat(m).map((p) => path.relative(DESKTOP, p).split(path.sep).join('/')));
      } else if (s === 0) {
        dfs(m);
      }
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const f of files) if ((state.get(f) || 0) === 0) dfs(f);
  return { cycles, edgeCount: [...graph.values()].reduce((a, b) => a + b.length, 0) };
}

// ── 基线 ──────────────────────────────────────────────────────────────────────
// 未用导入：**0**。2026-10-30 已清掉全部 15 处（AST 判定，逐条人工核实）。
// 循环依赖：**1**，显式登记。它是「静态成环、运行时不成环」的良性形态，
//   webTools → webSearchProviders 是**函数体内惰性 require**（webTools.js 里 webSearch 第一行），
//   加载期不会互相等待；且 webSearchProviders 只借 httpRequest 一个函数。
//   清零需把 httpRequest 抽独立模块，但会打破 test/web-search-config.test.js 对
//   `webTools.httpRequest` 的打桩能力（该测试靠「require 时解构捕获」来 mock 全部搜索请求），
//   代价大于收益。**新增的环一律判红**，要豁免必须在此登记并写明为何良性。
const KNOWN_CYCLES = [
  ['main/webSearchProviders.js', 'main/webTools.js'],
];

// ── 执行 ──────────────────────────────────────────────────────────────────────
const files = ROOTS
  .map((r) => path.join(DESKTOP, r))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d));

// 守卫①：扫描规模。AST 加载失败或 walk 退化成空时，下面每条断言都会「因为没东西可查」而绿。
check(`扫描规模守卫：源文件数 ≥ 600（实际 ${files.length}）`, files.length >= 600);

const unused = files.flatMap((f) => unusedImports(f).map((h) => ({ file: path.relative(DESKTOP, f).split(path.sep).join('/'), ...h })));
check('未用导入为 0', unused.length === 0,
  unused.length ? `\n${unused.map((h) => `  ${h.file}:${h.line} 未用 ${h.name} (from ${h.from})`).join('\n')}` : '全部 import 绑定都被引用');

const { cycles, edgeCount } = findCycles(files);
// 守卫②：边数。图构造正则/API 失效时边会掉到 0，环检测就永远说「无环」。
check(`依赖图守卫：项目内相对边 ≥ 1000（实际 ${edgeCount}）`, edgeCount >= 1000);

const norm = (c) => [...c].sort().join('|');
const knownSet = new Set(KNOWN_CYCLES.map(norm));
const unexpected = cycles.filter((c) => !knownSet.has(norm(c.slice(0, -1))));
const staleKnown = KNOWN_CYCLES.filter((k) => !cycles.some((c) => norm(c.slice(0, -1)) === norm(k)));
check('无新增循环依赖', unexpected.length === 0,
  unexpected.length ? `\n${unexpected.map((c) => `  ${c.join(' -> ')}`).join('\n')}` : `已知良性环 ${KNOWN_CYCLES.length} 个，未新增`);
check('登记表无失效条目（环已消失就该从 KNOWN_CYCLES 删掉）', staleKnown.length === 0,
  staleKnown.length ? `已消失：${staleKnown.map((k) => k.join(' <-> ')).join('; ')}` : '登记项都还存在');

// ── 第三部分：重复实现（C-004）──────────────────────────────────────────────
// 只钉「本次真的收敛掉的那一类」，不追求禁止一切同名函数——各模块同名的 helper
// （check / usage / rowToXxx）是合理的，全面禁止只会造出大片白名单。
// safeParse 则不同：它曾被复制 5 份且**三族语义不一致**（空值→fallback / null / 裸抛），
// 于是同一字段在不同 store 里拿到 null 还是 {} 取决于当初谁抄的谁。
const JSON_SAFE = path.join(DESKTOP, 'main', 'jsonSafe.js');
const DUP_RE = /function\s+safeParse(?:Json)?\s*\(/;
const isMainSrc = (f) => f.startsWith(path.join(DESKTOP, 'main') + path.sep);

const dupDefs = files
  .filter((f) => isMainSrc(f) && path.basename(f) !== 'jsonSafe.js')
  .filter((f) => DUP_RE.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(DESKTOP, f).split(path.sep).join('/'));
check('主进程侧只剩一份 JSON 安全解析实现', dupDefs.length === 0,
  dupDefs.length ? `重复定义：${dupDefs.join(', ')}` : '统一在 main/jsonSafe.js');

const jsonSafeSrc = fs.existsSync(JSON_SAFE) ? fs.readFileSync(JSON_SAFE, 'utf8') : '';
check('main/jsonSafe.js 存在且导出 safeParseJson',
  /function\s+safeParseJson\s*\(/.test(jsonSafeSrc) && /module\.exports\s*=\s*\{[^}]*safeParseJson/.test(jsonSafeSrc));

const STORES = ['artifactStore.js', 'projectStore.js', 'knowledgeBaseQuery.js', 'teamStore.js', 'taskStore.js'];
const notWired = STORES.filter((n) => {
  const f = path.join(DESKTOP, 'main', n);
  return !/require\('\.\/jsonSafe'\)/.test(fs.readFileSync(f, 'utf8'));
});
check('5 个 store 都改从 ./jsonSafe 引入（不再各抄一份）', notWired.length === 0,
  notWired.length ? `未接线：${notWired.join(', ')}` : `已接线 ${STORES.length}/${STORES.length}`);

// withTimeout 是**同名不同义**（两处 resolve 信封、两处 reject），刻意保留 4 份。
// 这里只验「消歧标记还在」，防止后人看着重复就合并、把 resolve 语义悄悄改成 reject。
const WT_FILES = ['main/agentRunner.js', 'main/entryRouter.js', 'renderer/src/lib/ipc.js', 'agent-core/index.js'];
const wtUnmarked = WT_FILES.filter((rel) => {
  const src = fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
  const i = src.indexOf('function withTimeout(');
  if (i < 0) return true;
  // 标记必须在定义**之前**的 3 行内（不是文件里随便某处出现即可）
  const before = src.slice(Math.max(0, i - 400), i);
  return !before.includes('C-004：与其它模块同名但');
});
check('4 处 withTimeout 都带「同名不同义」标记（防被误合并）', wtUnmarked.length === 0,
  wtUnmarked.length ? `缺标记：${wtUnmarked.join(', ')}` : '4/4 已标记');

// ── 自测：证明上面的断言真的会红 ──────────────────────────────────────────────
// 造两个临时文件互相 require（环）+ 一个未用导入，跑**同一份**分析函数。
// 只断言函数返回值不够——所以这里直接断言「分析函数对已知坏样本给出非空结果」，
// 并且断言「对已知好样本给出空结果」，两边都验，避免函数退化成恒真/恒假。
const TMP = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mj-import-hygiene-'));
try {
  const a = path.join(TMP, 'a.js');
  const b = path.join(TMP, 'b.js');
  fs.writeFileSync(a, "const b = require('./b');\nmodule.exports = { a: 1 };\n");
  fs.writeFileSync(b, "const a = require('./a');\nmodule.exports = { b: 1 };\n");
  fs.writeFileSync(path.join(TMP, 'unused.js'), "import { nope } from './a';\nconsole.log(1);\n");
  fs.writeFileSync(path.join(TMP, 'clean.js'), "import { used } from './a';\nused();\n");

  const tmpFiles = [a, b, path.join(TMP, 'unused.js'), path.join(TMP, 'clean.js')];
  const tmpCycles = findCycles(tmpFiles).cycles;
  const tmpUnused = tmpFiles.flatMap((f) => unusedImports(f).map((h) => ({ f: path.basename(f), ...h })));

  check('自测：互相 require 的样本能被判出环', tmpCycles.length >= 1,
    tmpCycles.length ? tmpCycles[0].map((p) => path.basename(p)).join(' -> ') : '漏判');
  check('自测：未用导入的样本能被判出', tmpUnused.length === 1 && tmpUnused[0].name === 'nope',
    JSON.stringify(tmpUnused));
  check('自测：已用导入不被误报', !tmpUnused.some((h) => h.name === 'used'), 'used 出现在 clean.js 里被正确忽略');
  // C-004 段的自测：证明那条正则既认得出副本、也认得出「正主」
  // （正因为正主也命中，dupDefs 才必须显式排除 jsonSafe.js，否则它自己会把自己判成重复）
  check('自测：重复 safeParse 定义能被判出', DUP_RE.test('function safeParse(s) { return null; }'));
  check('自测：正主 safeParseJson 同样命中（故需排除清单）', DUP_RE.test('function safeParseJson(raw, fallback = null) { return fallback; }'));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nimport-hygiene: ${pass}/${pass + fail} 通过（未用导入 ${unused.length}，环 ${cycles.length}，边 ${edgeCount}）`);
process.exit(fail === 0 ? 0 : 1);
