// 工件 kind 词汇表一致性门禁（2026-10-24）
//
// 缺陷（审计 P0-2 调研期的副产物）：工件 `kind` 的词汇表在项目里有**三份无引用关系的
//   手抄副本**，彼此之间没有 require / import 关系，也没有任何测试保证它们相等：
//     · `main/artifactStore.js`              — 服务端入参校验（`INVALID_KIND` 的判据）
//     · `renderer/.../ProjectCreateModal.tsx` — 新建项目表单的 kind 下拉选择器
//     · `main/tools/artifactProduct.js`       — `KIND_PRODUCTS` 的**键集**（第四份等价清单）
//   今天三处恰好相等，所以本套件今天是绿的——它的价值不在「今天抓到 bug」，而在
//   **将来有人新增 kind 只改一处时自动报警**：漏改 artifactStore ⇒ 前端选得出、主进程
//   INVALID_KIND 拒收（或反之），这是一类「两端各对一半、拼起来不能用」的缺陷。
//
// 为什么是源码抽取而不是 require 比对：
//   · `artifactProduct.js` 的 `KIND_PRODUCTS` 键集、`projectSpaceInit.js` 的默认值、
//     tsx 里的选择器清单，运行时都拿不到完整可比对形态（tsx 不经成一等公民导出）。
//   · 但**纯文本抽取最大的风险是「锚点错位 / 抽到影子副本却依然有值」**，那正是本轮
//     要消灭的假绿（上一轮 message-meta 就出过「开窗溢出到下游代码，产品真坏了还全绿」）。
//   故两条对抗措施都必须有：
//     ① 抽取 fail-loud：锚点未命中 / 括号未闭合 / 抽到非字面量 ⇒ 立刻 fail 并打印锚点原文，
//        **不许用 `|| []`、`|| {}`、`|| ''` 兜底**——静默空过比红更难发现；
//     ② 运行时交叉验证：`artifactStore` / `artifactProduct` 这两个能被 require 的模块，
//        把运行时导出值与源码抽取值比对，证明「抽到的这份就是产品真用的那份」，
//        而不是某个同名影子变量或注释里的示例。
//
// 抽取方法：**括号配对**（不是「起点锚点 → 终点文本标记」的开窗方式；开窗会溢出到下游代码）。
//   刻意不引 espree / typescript 解析：二者都不在 desktop/package.json 的依赖里
//   （espree 只是 eslint 的传递依赖，靠 hoist 才可见），依赖它们的套件会在依赖树重排时
//   MODULE_NOT_FOUND 崩溃——那是环境脆弱性换来的「更优雅」，不划算。
//
// 断言清单：
//   A1 artifactStore.js 的 ARTIFACT_KINDS 抽得到且非空
//   A2 ProjectCreateModal.tsx 的 ARTIFACT_KINDS 抽得到且非空
//   A3 artifactProduct.js 的 KIND_PRODUCTS 键集抽得到且非空
//   A4 三者集合严格相等（报出差异项）
//   A5 DEFAULT_ARTIFACT_KIND 的每个值 ⊆ ARTIFACT_KINDS
//   A6 每个 kind 在 zh-CN 与 en-US 都有 `kind_<k>` 键（双向：locale 里不得有孤儿 kind_ 键）
//   A7 每个 kind 长度 ≤ `main/ipc/projects.js` 里读出来的 artifactKind.max（不硬编码 16）
//   A8 运行时导出值 == 源码抽取值（交叉验证，防影子副本）
//   A9 锚点唯一性（同一标识符在同一文件里不允许两处声明）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 括号配对扫描器 ────────────────────────────────────────────────────────
// 从 openIdx（必须是 `[` `{` `(` 之一）扫到与之配对的闭括号，返回其索引；未闭合返回 -1。
// 沿途跳过字符串（含转义）与注释，避免把注释里的括号算进来。
const CLOSE = { '[': ']', '{': '}', '(': ')' };

function skipString(src, i) {
  const q = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    i += 1;
  }
  return src.length; // 字符串未闭合：调用方会收到 -1 位置的配对失败
}

function matchBrace(src, openIdx) {
  const open = src[openIdx];
  const close = CLOSE[open];
  if (!close) throw new Error(`matchBrace: 起始字符不是开括号：${JSON.stringify(open)}`);
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === open) { depth += 1; i += 1; continue; }
    if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1; // 未闭合
}

// 按顶层逗号切分（嵌套括号 / 字符串 / 注释内的逗号不算）
function splitTopLevel(body) {
  const out = [];
  let cur = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i);
      i = nl < 0 ? body.length : nl;
      continue;
    }
    if (c === '/' && body[i + 1] === '*') {
      const e = body.indexOf('*/', i + 2);
      i = e < 0 ? body.length : e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const e = skipString(body, i);
      cur += body.slice(i, e);
      i = e;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') {
      const e = matchBrace(body, i);
      if (e < 0) throw new Error('splitTopLevel: 括号未闭合');
      cur += body.slice(i, e + 1);
      i = e + 1;
      continue;
    }
    if (c === ',') { out.push(cur); cur = ''; i += 1; continue; }
    cur += c;
    i += 1;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((s) => s.trim());
}

// 字符串字面量反转义。返回 null 表示「这不是一个本抽取器看得懂的纯字符串字面量」。
// 带反斜杠的一律 null：kind 名是标识符，出现转义说明抽取器已经看不懂了，
// 此时必须报警而不是照字面猜测（猜错 = 假绿，正是本套件的敌人）。
function unquote(s) {
  if (typeof s !== 'string' || s.length < 2) return null;
  const q = s[0];
  if (q !== "'" && q !== '"') return null;
  if (s[s.length - 1] !== q) return null;
  const inner = s.slice(1, -1);
  if (inner.includes('\\')) return null;
  return inner;
}

// ── fail-loud 抽取器 ──────────────────────────────────────────────────────
// 三个抽取器**都不做静默兜底**：任何一步拿不到真值，都把 error 写进结果对象，
// 由调用方转成一条 ❌ 断言（而不是偿 try 出一个空数组让下游断言比对 `[1] == []` 通过）。
function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// 定位唯一锚点：返回 { anchorIndex（开括号的位置）, anchorText, count }
function locateAnchor(src, anchorRe, label) {
  const hits = [...src.matchAll(anchorRe)];
  const count = hits.length;
  if (count === 0) return { ok: false, error: `锚点未命中：${anchorRe}（文件里搜不到该声明）`, count };
  const m = hits[0];
  const openIdx = m.index + m[0].length - 1;
  const line = src.slice(0, m.index).split('\n').length;
  return {
    ok: true,
    count,
    openIdx,
    anchorText: m[0].trim(),
    anchorLine: line,
    unique: count === 1,
    label,
  };
}

function sliceBody(src, anchorRe, label) {
  const a = locateAnchor(src, anchorRe, label);
  if (!a.ok) return { ...a, values: null };
  if (!a.unique) {
    return { ...a, ok: false, error: `锚点命中 ${a.count} 次（要求恰好 1 次）：出现第二个同名声明时，抽取无法判定哪份是真货`, values: null };
  }
  const end = matchBrace(src, a.openIdx);
  if (end < 0) {
    return { ...a, ok: false, error: `括号未闭合：自第 ${a.anchorLine} 行「${a.anchorText}」起扫到文件尾也没找到配对的闭括号`, values: null };
  }
  return { ...a, ok: true, end, body: src.slice(a.openIdx + 1, end) };
}

// 抽取字符串数组（元素必须全是纯字符串字面量）
function extractStringArray(relPath, anchorRe, label) {
  const src = readSource(relPath);
  const ctx = sliceBody(src, anchorRe, label);
  if (!ctx.ok) return ctx;
  let elems;
  try {
    elems = splitTopLevel(ctx.body);
  } catch (e) {
    return { ...ctx, ok: false, error: `切分失败（${e.message}）`, values: null };
  }
  const values = [];
  for (const raw of elems) {
    if (raw === '') {
      return { ...ctx, ok: false, error: '数组里出现空元素（连续逗号），抽取结果不可信', values: null };
    }
    const v = unquote(raw);
    if (v === null) {
      return { ...ctx, ok: false, error: `元素「${raw}」不是纯字符串字面量（含变量引用/模板/转义），抽取器无法静态判定其值，改为明确报错而不是猜测`, values: null };
    }
    values.push(v);
  }
  if (values.length === 0) {
    return { ...ctx, ok: false, error: `抽到空数组：第 ${ctx.anchorLine} 行「${ctx.anchorText}」内一个元素都没有`, values: null };
  }
  return { ...ctx, ok: true, values, file: relPath };
}

// 抽取对象字面量条目（键；保留原文以便调用方自行取字符串值）
function extractObjectEntries(relPath, anchorRe, label) {
  const src = readSource(relPath);
  const ctx = sliceBody(src, anchorRe, label);
  if (!ctx.ok) return ctx;
  let elems;
  try {
    elems = splitTopLevel(ctx.body);
  } catch (e) {
    return { ...ctx, ok: false, error: `切分失败（${e.message}）`, entries: null };
  }
  const entries = [];
  for (const raw of elems) {
    if (raw === '') return { ...ctx, ok: false, error: '对象里出现空条目（连续逗号）', entries: null };
    const colon = raw.indexOf(':');
    if (colon < 0) {
      return { ...ctx, ok: false, error: `条目「${raw}」不是 key: value 形式（可能是展开运算符 ...），抽取器无法静态判定，改为明确报错`, entries: null };
    }
    const keyRaw = raw.slice(0, colon).trim();
    const valueRaw = raw.slice(colon + 1).trim();
    const key = unquote(keyRaw) !== null ? unquote(keyRaw) : (/^[A-Za-z_$][\w$]*$/.test(keyRaw) ? keyRaw : null);
    if (key === null) {
      return { ...ctx, ok: false, error: `键「${keyRaw}」既不是标识符也不是字符串字面量，无法静态判定`, entries: null };
    }
    entries.push({ key, valueRaw });
  }
  if (entries.length === 0) {
    return { ...ctx, ok: false, error: `抽到空对象：第 ${ctx.anchorLine} 行「${ctx.anchorText}」内没有任何条目`, entries: null };
  }
  return { ...ctx, ok: true, entries, file: relPath };
}

// 抽出除字符串字面量以外的内容（用于检测注释残留）
function stripStrings(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); continue; }
    out += c;
    i += 1;
  }
  return out;
}

// 抽取对象里某个数字属性的值：`artifactKind: { max: 16, ... }` 的 16
function extractNumericProp(relPath, anchorRe, propName, label) {
  const ctx = extractObjectEntries(relPath, anchorRe, label);
  if (!ctx.ok) return { ...ctx, value: null };
  const hit = ctx.entries.find((e) => e.key === propName);
  if (!hit) {
    return { ...ctx, ok: false, error: `对象里找不到属性 ${propName}（现有键：${ctx.entries.map((e) => e.key).join(', ')}）`, value: null };
  }
  if (!/^\d+$/.test(hit.valueRaw)) {
    return { ...ctx, ok: false, error: `${propName} 的值「${hit.valueRaw}」不是整数字面量（可能是变量或表达式），无法静态判定`, value: null };
  }
  return { ...ctx, ok: true, value: Number(hit.valueRaw), raw: hit.valueRaw, file: relPath };
}

// 读 locale JSON（解析失败转成显式 error，不偿 try 出一个空对象冒充「无缺失」）
function readLocaleKeys(relPath, prefix) {
  let parsed;
  try {
    parsed = JSON.parse(readSource(relPath));
  } catch (e) {
    return { ok: false, error: `locale 解析失败：${e.message}`, keys: null, file: relPath };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'locale 顶层不是对象', keys: null, file: relPath };
  }
  const all = Object.keys(parsed);
  if (all.length === 0) return { ok: false, error: 'locale 顶层对象没有任何键', keys: null, file: relPath };
  const keys = all.filter((k) => k.startsWith(prefix));
  return { ok: true, keys, all, file: relPath };
}

// ── A1/A2/A3：三份副本 ────────────────────────────────────────────────────
const STORE = 'main/artifactStore.js';
const MODAL = 'renderer/src/components/ProjectCreateModal.tsx';
const PRODUCT = 'main/tools/artifactProduct.js';
const INIT = 'main/projectSpaceInit.js';
const IPC = 'main/ipc/projects.js';

const storeKinds = extractStringArray(STORE, /const\s+ARTIFACT_KINDS\s*=\s*\[/g, 'artifactStore.ARTIFACT_KINDS');
const modalKinds = extractStringArray(MODAL, /const\s+ARTIFACT_KINDS\s*=\s*\[/g, 'ProjectCreateModal.ARTIFACT_KINDS');
const productKinds = extractObjectEntries(PRODUCT, /const\s+KIND_PRODUCTS\s*=\s*\{/g, 'artifactProduct.KIND_PRODUCTS');
const initDefaults = extractObjectEntries(INIT, /const\s+DEFAULT_ARTIFACT_KIND\s*=\s*\{/g, 'projectSpaceInit.DEFAULT_ARTIFACT_KIND');
const ipcMax = extractNumericProp(IPC, /artifactKind\s*:\s*\{/g, 'max', 'projects.js payloadGuard.artifactKind');

check('A1 从 main/artifactStore.js 抽出 ARTIFACT_KINDS（数组非空）',
  storeKinds.ok === true,
  storeKinds.ok ? `[${storeKinds.values.join(', ')}]（第 ${storeKinds.anchorLine} 行）` : `❗${storeKinds.error}`);

check('A2 从 ProjectCreateModal.tsx 抽出 ARTIFACT_KINDS（数组非空）',
  modalKinds.ok === true,
  modalKinds.ok ? `[${modalKinds.values.join(', ')}]（第 ${modalKinds.anchorLine} 行）` : `❗${modalKinds.error}`);

check('A3 从 artifactProduct.js 抽出 KIND_PRODUCTS 的键集（非空）',
  productKinds.ok === true,
  productKinds.ok ? `{${productKinds.entries.map((e) => e.key).join(', ')}}（第 ${productKinds.anchorLine} 行）` : `❗${productKinds.error}`);

check('A9 三个副本的锚点各自唯一（文件内不存在同名第二个声明）',
  storeKinds.ok && modalKinds.ok && productKinds.ok && initDefaults.ok,
  `store=${storeKinds.count} modal=${modalKinds.count} kindProducts=${productKinds.count} defaults=${initDefaults.count}（均须为 1）`);

// ── A10：抽取窗口不得错位（中间结果不变量）────────────────────────────────
// 为什么必须有这一条（2026-10-24，与 agent-harness-coder 的对照结论）：
//   本抽取器有**两层**各自跳过注释——`matchBrace` 的配对层、`splitTopLevel` 的切元素层。
//   这两层互为冗余：只让配对层的注释处理失效时，切元素层会把提前闭合产生的脏片段
//   再清洗一遍，**最终断言照样全绿**。也就是说「最终结论正确」并不能证明「配对没错位」，
//   而错位意味着抽取窗口覆盖了本不该覆盖的范围——今天碰巧被下游洗干净，明天换个注释
//   位置就可能抽到相邻代码。
//   因此对**中间结果**直接下判：配对得到的原始片段里，字符串之外不得残留任何注释标记。
//   残留 = 窗口已经吃到注释里 = 立即红，不等下游掩盖。
//   这是「形态断言」：不看最终结论对不对，而是看到达结论的路径形状对不对。
for (const [label, ex] of [
  ['artifactStore.ARTIFACT_KINDS', storeKinds],
  ['ProjectCreateModal.ARTIFACT_KINDS', modalKinds],
  ['artifactProduct.KIND_PRODUCTS', productKinds],
  ['projectSpaceInit.DEFAULT_ARTIFACT_KIND', initDefaults],
]) {
  if (!ex.ok) {
    check(`A10 ${label} 的抽取窗口未错位（原始片段无注释残留）`, false, `❗上游抽取未命中：${ex.error}`);
    continue;
  }
  const residue = stripStrings(ex.body).match(/\/\/|\/\*/);
  check(`A10 ${label} 的抽取窗口未错位（原始片段无注释残留）`,
    residue === null,
    residue === null
      ? `片段 ${JSON.stringify(ex.body.slice(0, 60))}${ex.body.length > 60 ? '…' : ''} 内无注释标记`
      : `片段里残留「${residue[0]}」⇒ 配对窗口已错位吃到注释里：${JSON.stringify(ex.body.slice(0, 120))}`);
}

// ── A4：三集合严格相等 ────────────────────────────────────────────────────
function setDiff(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  return {
    onlyA: [...A].filter((x) => !B.has(x)).sort(),
    onlyB: [...B].filter((x) => !A.has(x)).sort(),
  };
}

if (!storeKinds.ok || !modalKinds.ok || !productKinds.ok) {
  check('A4 artifactStore / ProjectCreateModal / KIND_PRODUCTS 三者的 kind 集合严格相等',
    false, '❗上游抽取未命中，无法比对（不是相等，是没法判）');
} else {
  const prods = productKinds.entries.map((e) => e.key);
  const d1 = setDiff(storeKinds.values, modalKinds.values);
  const d2 = setDiff(storeKinds.values, prods);
  const d3 = setDiff(modalKinds.values, prods);
  const equal = d1.onlyA.length === 0 && d1.onlyB.length === 0
    && d2.onlyA.length === 0 && d2.onlyB.length === 0
    && d3.onlyA.length === 0 && d3.onlyB.length === 0;
  check('A4 artifactStore / ProjectCreateModal / KIND_PRODUCTS 三者的 kind 集合严格相等',
    equal,
    equal
      ? `${storeKinds.values.length} 个 kind 三处一致：[${[...storeKinds.values].sort().join(', ')}]`
      : [
        d1.onlyA.length || d1.onlyB.length ? `store(${storeKinds.file}) ↔ modal(${modalKinds.file})：仅 store 有 [${d1.onlyA}]、仅 modal 有 [${d1.onlyB}]` : '',
        d2.onlyA.length || d2.onlyB.length ? `store ↔ KIND_PRODUCTS(${productKinds.file})：仅 store 有 [${d2.onlyA}]、仅 KIND_PRODUCTS 有 [${d2.onlyB}]` : '',
        d3.onlyA.length || d3.onlyB.length ? `modal ↔ KIND_PRODUCTS：仅 modal 有 [${d3.onlyA}]、仅 KIND_PRODUCTS 有 [${d3.onlyB}]` : '',
      ].filter(Boolean).join('；'));
}

// ── A5：默认值的每个取值都必须在词汇表内 ──────────────────────────────────
if (!initDefaults.ok) {
  check('A5 DEFAULT_ARTIFACT_KIND 的每个取值 ⊆ ARTIFACT_KINDS', false, `❗${initDefaults.error}`);
} else if (!storeKinds.ok) {
  check('A5 DEFAULT_ARTIFACT_KIND 的每个取值 ⊆ ARTIFACT_KINDS', false, '❗artifactStore 侧未抽出词汇表，无法比对');
} else {
  const allowed = new Set(storeKinds.values);
  const bad = [];
  for (const e of initDefaults.entries) {
    const v = unquote(e.valueRaw);
    if (v === null) bad.push(`${e.key}=「${e.valueRaw}」（非纯字符串字面量，无法判定）`);
    else if (!allowed.has(v)) bad.push(`${e.key}=${v}`);
  }
  check('A5 DEFAULT_ARTIFACT_KIND 的每个取值 ⊆ ARTIFACT_KINDS',
    bad.length === 0,
    bad.length === 0
      ? `${initDefaults.entries.length} 项默认值全部合法（${initDefaults.entries.map((e) => e.key).join(', ')}）`
      : `${INIT} 第 ${initDefaults.anchorLine} 行有 ${bad.length} 项越界：${bad.join('、')}`);
}

// ── A6：i18n 双侧 coverage（正向必须都有；反向不许留孤儿 kind_ 键）───────────
// 选择器 ProjectCreateModal.tsx 用 `t(\`projectSpace.kind_${k}\`)` 取文案，k 来自该文件的
// ARTIFACT_KINDS ⇒ 词汇表里每个 kind 在两个 locale 都得有 `kind_<k>`，否则下拉框漏一项空白。
const ZH = 'renderer/src/i18n/locales/zh-CN/projectSpace.json';
const EN = 'renderer/src/i18n/locales/en-US/projectSpace.json';
const zh = readLocaleKeys(ZH, 'kind_');
const en = readLocaleKeys(EN, 'kind_');

// 中英键集的双向 100% 一致性由既有 i18n 门禁（test/i18n.test.mjs）覆盖；这里只做
// 「词汇表 ↔ locale」这一层，两者是不同的一致性关系，别混淆。
for (const [label, loc] of [['zh-CN', zh], ['en-US', en]]) {
  if (!loc.ok) {
    check(`A6 每个 kind 在 ${label} 的 projectSpace.json 里都有 kind_<k> 键`, false, `❗${loc.error}`);
  } else if (!storeKinds.ok) {
    check(`A6 每个 kind 在 ${label} 的 projectSpace.json 里都有 kind_<k> 键`, false, '❗词汇表未抽出，无法比对');
  } else {
    const missing = storeKinds.values.filter((k) => !loc.keys.includes(`kind_${k}`));
    check(`A6 每个 kind 在 ${label} 的 projectSpace.json 里都有 kind_<k> 键`,
      missing.length === 0,
      missing.length === 0
        ? `${storeKinds.values.length} 个 kind 全部命中（${storeKinds.values.map((k) => `kind_${k}`).join(', ')}）`
        : `缺 ${missing.length} 个键：${missing.map((k) => `kind_${k}`).join(', ')}`);
  }
}

{
  const basezh = zh.ok ? zh.keys.map((k) => k.slice('kind_'.length)).sort() : null;
  const baseen = en.ok ? en.keys.map((k) => k.slice('kind_'.length)).sort() : null;
  if (!zh.ok || !en.ok || !storeKinds.ok) {
    check('A6b 两个 locale 里的 kind_ 键没有孤儿（不指向任何已知 kind）', false, '❗上游抽取/locale 未命中，无法判定');
  } else {
    const allowed = new Set(storeKinds.values);
    const orphans = [...new Set([...basezh, ...baseen])].filter((k) => !allowed.has(k)).sort();
    check('A6b 两个 locale 里的 kind_ 键没有孤儿（不指向任何已知 kind）',
      orphans.length === 0,
      orphans.length === 0
        ? `locale 共 ${new Set(basezh).size} 个 kind_ 键，全部有对应词汇`
        : `孤儿键 ${orphans.map((k) => `kind_${k}`).join(', ')}（要么删文案，要么把该 kind 补进三份词汇表）`);
  }
}

// ── A7：长度不得超过 IPC 载荷闸的 max（该常量从源码读出，不硬编码 16）──────
if (!ipcMax.ok) {
  check('A7 每个 kind 的 length ≤ main/ipc/projects.js 里 artifactKind 的 max', false, `❗${ipcMax.error}`);
} else if (!storeKinds.ok || !modalKinds.ok) {
  check('A7 每个 kind 的 length ≤ main/ipc/projects.js 里 artifactKind 的 max', false, '❗词汇表未抽出，无法比对');
} else {
  const tooLong = [...new Set([...storeKinds.values, ...modalKinds.values])].filter((k) => k.length > ipcMax.value);
  check('A7 每个 kind 的 length ≤ main/ipc/projects.js 里 artifactKind 的 max',
    tooLong.length === 0,
    tooLong.length === 0
      ? `max=${ipcMax.value}（读自 ${IPC}:${ipcMax.anchorLine} \`${ipcMax.anchorText}\`），${new Set([...storeKinds.values, ...modalKinds.values]).size} 个 kind 全部合规`
      : `max=${ipcMax.value}，超长 ${tooLong.length} 个：${tooLong.map((k) => `${k}(${k.length})`).join(', ')}；依据 ${IPC}:${ipcMax.anchorLine} 的 payloadGuard 闸，超长 kind 会被 IPC 层拒收`);
}

// ── A8：运行时导出值 ↔ 源码抽取值 交叉验证 ─────────────────────────────────
// 防「锚点错位但依然抽到值」：能 require 的两个模块，把真跑起来拿到的值与文本抽取值比对。
// 二者不等 ⇒ 要么抽到了影子副本，要么导出的不是同一份常量，任何一种都必须红。
{
  const runtime = require(path.join(ROOT, STORE));
  const runtimeKinds = runtime.ARTIFACT_KINDS;
  const rtOnly = setDiff(runtimeKinds, storeKinds.ok ? storeKinds.values : []);
  check('A8a artifactStore 运行时导出的 ARTIFACT_KINDS == 源码抽取值（两侧一致才可信）',
    Array.isArray(runtimeKinds) && runtimeKinds.length > 0 && storeKinds.ok
      && rtOnly.onlyA.length === 0 && rtOnly.onlyB.length === 0,
    storeKinds.ok
      ? (Array.isArray(runtimeKinds)
        ? `runtime=[${runtimeKinds.join(', ')}] source=[${storeKinds.values.join(', ')}]`
        : `运行时导出不是数组（${typeof runtimeKinds}）`)
      : `❗源码侧未抽出：${storeKinds.error}`);
}

{
  const runtime = require(path.join(ROOT, PRODUCT));
  const runtimeKeys = Object.keys(runtime.KIND_PRODUCTS);
  const rtOnly = setDiff(runtimeKeys, productKinds.ok ? productKinds.entries.map((e) => e.key) : []);
  check('A8b artifactProduct 运行时导出的 KIND_PRODUCTS 键集 == 源码抽取值',
    runtimeKeys.length > 0 && productKinds.ok && rtOnly.onlyA.length === 0 && rtOnly.onlyB.length === 0,
    productKinds.ok
      ? `runtime={${runtimeKeys.join(', ')}} source={${productKinds.entries.map((e) => e.key).join(', ')}}`
      : `❗源码侧未抽出：${productKinds.error}`);
}

console.log(`\n总计 ${pass + fail} · 通过 ${pass} · 失败 ${fail} · 跳过 0`);
process.exit(fail === 0 ? 0 : 1);
