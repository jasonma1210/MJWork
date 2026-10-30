// TSX/JSX 专项守卫（2026-10-30，审计 #16/#18 的产物）
//
// 为什么需要它（这是本次审计最实的一条发现）：
//   `eslint.config.mjs` 里渲染层那块规则的 `files` 是 `renderer/**/*.{js,jsx}`，
//   而本项目 122 个渲染层文件里绝大多数已经是 .tsx —— 实测
//   `npx eslint renderer/src/components/BrowserPanel.tsx` 的输出是
//   「File ignored because no matching configuration was supplied」，
//   即 **TS/TSX 完全不在 ESLint 覆盖内**：react-hooks/rules-of-hooks、react/jsx-key、
//   no-eval、no-empty、max-lines 这些规则对它们一律不生效（lint 绿 ≠ 没问题）。
//   仓库里也没有 typescript-eslint 依赖，短期无法靠换 parser 解决。
//
// 做法：用**渲染层已经装好的 typescript** 的编译器 API 做纯语法遍历（零新依赖、零类型检查），
// 只覆盖「改起来确定、误报可消除」的高危规则：
//   G1 rules-of-hooks：hook 调用出现在条件/循环/逻辑短路里，或在回调内联函数里（含 useMemo/useEffect 回调）
//   G2 jsx-key：`.map/.flatMap` 回调**直接返回 JSX** 却缺 key（返回对象/数组的不算——JSX 只是对象里的一个字段时
//      key 归真正渲染它的列表负责，机械报会全是假红）
//   G3 no-eval / new Function
//   G4 dangerouslySetInnerHTML：只允许在 ALLOW_HTML 里登记的站点（每处都要写在册理由）
//   G5 动态 i18n key：`t(`prefix.${x}`)` 的前缀必须在 zh-CN 语言包里至少命中 1 个键
//      （静态 key 由 i18n-modcheck 守；动态拼接的 key 它看不见，拼错就永远显示原始 key）
//
// 用法：node scripts/tsx-guard.mjs <文件或目录>...
// 退出码：0 无违规 / 1 有违规 / 2 用法错误（无参也必须判错——防「跑空了却算过」）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const requireTs = createRequire(path.join(ROOT, 'renderer', 'package.json'));
const ts = requireTs('typescript');

const HOOKS = new Set([
  'useState', 'useEffect', 'useMemo', 'useRef', 'useCallback', 'useContext', 'useReducer',
  'useLayoutEffect', 'useTransition', 'useDeferredValue', 'useId', 'useSyncExternalStore',
  'useImperativeHandle', 'useInsertionEffect', 'useOptimistic', 'useActionState',
]);

// 允许 dangerouslySetInnerHTML 的站点：每处必须写清「输入从哪来、在哪净化」。
// 新增条目要让审查者一眼能判断净化是否发生在本仓库里，而不是只看注释里的一句承诺。
const ALLOW_HTML = new Map([
  ['components/KnowledgePanel.tsx', '片段由主进程 knowledgeBaseQuery.makeSnippet 走 escapeHtml 后再下发'],
  ['components/MermaidDiagram.tsx', 'mermaid 固定 securityLevel:strict，产出已净化的 SVG'],
]);

function usage() {
  console.error('用法: node scripts/tsx-guard.mjs <文件或目录>...');
  process.exit(2);
}

function collect(targets) {
  const out = [];
  for (const t of targets) {
    const st = fs.statSync(t);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(t)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        out.push(...collect([path.join(t, name)]));
      }
    } else if (/\.(tsx|jsx)$/.test(t)) {
      out.push(t);
    }
  }
  return out;
}

/** zh-CN 语言包的全部键（扁平化：模块名.路径） */
function zhKeys() {
  const dir = path.join(ROOT, 'renderer', 'src', 'i18n', 'locales', 'zh-CN');
  const keys = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const mod = f.replace(/\.json$/, '');
    const walk = (o, prefix) => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string') keys.add(prefix + k);
        else if (v && typeof v === 'object') walk(v, `${prefix}${k}.`);
      }
    };
    walk(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), `${mod}.`);
  }
  return keys;
}

function kindOf(file) {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
}

const unwrap = (n) => {
  let x = n;
  while (x && (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x))) x = x.expression;
  return x;
};
const isJsx = (n) => !!n && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n));

/** 箭头/函数表达式**直接**把 JSX 作为返回值返回？（返回对象/数组里的 JSX 不算） */
function directJsxReturn(cb) {
  const body = unwrap(cb.body);
  if (!body) return null;
  if (isJsx(body)) return body;
  if (ts.isBlock(body)) {
    for (const st of body.statements) {
      if (ts.isReturnStatement(st) && st.expression) {
        const e = unwrap(st.expression);
        if (isJsx(e)) return e;
      }
    }
  }
  return null;
}

const hasKeyAttr = (jsxNode) => {
  const open = ts.isJsxElement(jsxNode) ? jsxNode.openingElement
    : ts.isJsxSelfClosingElement(jsxNode) ? jsxNode : null;
  if (!open) return false;
  return open.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'key');
};

function scanFile(file, rel, keys, hits) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const ancestors = [];

  (function visit(node) {
    ancestors.push(node);

    // G1 rules-of-hooks
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOKS.has(node.expression.text)) {
      const hook = node.expression.text;
      let fnIdx = -1;
      for (let i = ancestors.length - 1; i >= 0; i -= 1) {
        if (ts.isFunctionLike(ancestors[i])) { fnIdx = i; break; }
      }
      const inner = fnIdx === -1 ? ancestors : ancestors.slice(fnIdx + 1);
      const inBranch = inner.some((n) => ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n)
        || ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isConditionalExpression(n)
        || (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind)));
      // 回调内联函数（useMemo/useEffect/.map/setTimeout 的回调）里调用 hook 同样违规
      const fn = fnIdx === -1 ? null : ancestors[fnIdx];
      const inCallback = !!fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
        && !!fn.parent && ts.isCallExpression(fn.parent);
      if (inBranch) hits.push(`${rel}:${line(node)} G1 ${hook} 在条件/循环/短路分支内调用（hook 顺序会随分支变化）`);
      else if (inCallback) hits.push(`${rel}:${line(node)} G1 ${hook} 在回调内联函数内调用（hook 必须无条件写在组件/自定义 hook 顶层）`);
    }

    // G2 jsx-key
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['map', 'flatMap'].includes(node.expression.name.text) && node.arguments[0]) {
      const cb = node.arguments[0];
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
        const ret = directJsxReturn(cb);
        if (ret && !hasKeyAttr(ret)) {
          hits.push(`${rel}:${line(ret)} G2 map 返回的列表元素缺 key（React 会按索引复用，状态会串行）`);
        }
      }
    }

    // G3 no-eval
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
      hits.push(`${rel}:${line(node)} G3 eval()`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      hits.push(`${rel}:${line(node)} G3 new Function()`);
    }

    // G4 dangerouslySetInnerHTML 白名单
    if (ts.isJsxAttribute(node) && node.name.getText() === 'dangerouslySetInnerHTML' && !ALLOW_HTML.has(rel)) {
      hits.push(`${rel}:${line(node)} G4 dangerouslySetInnerHTML 未登记（新增站点必须在 ALLOW_HTML 写清净化路径）`);
    }

    // G5 动态 i18n key 前缀
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === 't' || node.expression.text === 'tGlobal')
      && node.arguments[0] && ts.isTemplateExpression(node.arguments[0])) {
      const head = node.arguments[0].head.text;
      if (head && !hasPrefix(keys, head)) {
        hits.push(`${rel}:${line(node)} G5 动态 key 前缀 "${head}" 在 zh-CN 语言包里一个键都没有（拼错就永远显示原始 key）`);
      }
    }

    ts.forEachChild(node, visit);
    ancestors.pop();
  })(sf);
}

let prefixCache = null;
function hasPrefix(keys, prefix) {
  if (!prefixCache) prefixCache = { keys, list: [...keys] };
  if (prefixCache.keys !== keys) prefixCache = { keys, list: [...keys] };
  return prefixCache.list.some((k) => k.startsWith(prefix));
}

const targets = process.argv.slice(2);
if (targets.length === 0) usage();

const files = collect(targets);
if (files.length === 0) {
  console.error('未找到 .tsx/.jsx 文件（目标目录为空也算失败：空跑不能算过）');
  process.exit(2);
}

const keys = zhKeys();
const hits = [];
for (const f of files) scanFile(f, path.relative(path.join(ROOT, 'renderer', 'src'), f), keys, hits);

if (hits.length) {
  for (const h of hits) console.log(h);
  console.error(`\ntsx-guard: ${hits.length} 处违规 / ${files.length} 个文件`);
  process.exit(1);
}
console.log(`tsx-guard: 0 违规 / ${files.length} 个文件`);
