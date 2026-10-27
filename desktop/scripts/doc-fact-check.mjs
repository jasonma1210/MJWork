// 文档事实核验（doc-fact-check）
//
// 背景（2026-10-17，技术设计文档 v1.2 核验）：该文档连续三轮「修完又冒一批」，
// 根因不是笔误，而是四类「不会自愈」的缺陷生成器：
//   G1 手写数字快照，无单一事实源  → 同一指标在文档里并存 2–5 个值
//   G2 修复只改第 9 章 X 表，不回填章级 R → X 说"已修"、R 说"未修"，两处都像真的
//   G3 否定式断言（"全仓无 X"）无复验 → 空输出被读成"零使用"（第 10 章 J1 事故）
//   G4 章内编号跨章漂移 → 「第 11 章 R1」而全文只有 10 章
//
// 本脚本把 G1 / G2 / G4 与「引用位置」变成机器校验。**已接入 npm test**（2026-10-20 起，作为
// `test/run-all.mjs` 的前置门禁之一）——此前注释写「按需运行、不接入」，结果文档数字漂移
// **红了一整轮没人发现**（没有任何自动触发方）。仍可单独跑：
//   node scripts/doc-fact-check.mjs            # 默认校验技术设计文档
//   node scripts/doc-fact-check.mjs --doc ../docs/xxx.md
//   node scripts/doc-fact-check.mjs --quiet     # 只输出问题
//
// 设计取舍：
//   · 数字用「从源码现算 → 与文档里写的那一个值比对」，不是与常量比对。
//     源码变了而文档没改 ⇒ 红；文档同步改了 ⇒ 绿。这样脚本不会成为"改代码就要改门禁"的负担。
//   · 行号指到空行 / 纯闭合符号只作**警告**（warn），不判红：那类引用有时是「函数末尾」的合法锚点。
//   · G3（否定式断言）无法自动判真伪，本脚本只做**清单式提醒**：列出文档里所有「唯一/零/全仓无」，
//     要求人工各附一条可复跑命令。退出码不受其影响。
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_DOC = path.join(REPO, 'docs/MJCode-技术设计文档-2026-10-17.md');

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
// 相对路径按**当前工作目录**解析（与命令行直觉一致：cd desktop && node scripts/... --doc ../docs/x.md）
const DOC = path.resolve(process.cwd(), getArg('--doc', DEFAULT_DOC));
const QUIET = argv.includes('--quiet');

const errors = [];
const warns = [];
const notes = [];

if (!fs.existsSync(DOC)) {
  console.error(`文档不存在：${DOC}`);
  process.exit(2);
}
const text = fs.readFileSync(DOC, 'utf8');
const lines = text.split('\n');
const say = (...a) => { if (!QUIET) console.log(...a); };

// ── 引用解析：路径多基址回退 ──
// 文档里的路径有四种基准：仓库根、desktop/、desktop/main/、renderer/src/。
const BASES = [
  '', 'desktop', 'desktop/main', 'desktop/main/tools', 'desktop/main/ipc',
  'desktop/main/orchestrator', 'desktop/main/db', 'desktop/main/memory',
  'desktop/main/audit', 'desktop/main/lifecycle', 'desktop/main/data',
  'desktop/main/engineProcess', 'desktop/renderer', 'desktop/renderer/src',
  'desktop/renderer/src/components', 'desktop/renderer/src/components/tools',
  'desktop/renderer/src/hooks', 'desktop/renderer/src/lib',
  'desktop/renderer/src/styles', 'desktop/renderer/src/i18n',
  'desktop/renderer/src/constants', 'desktop/agent-core', 'desktop/shared-ipc',
  'desktop/test', 'desktop/eval', 'desktop/scripts', 'desktop/build',
  'server/src', 'server/src/db', 'server/src/routes', 'server/src/lib',
  'server/src/middleware', 'miniprogram', 'ecosystem', '.github/workflows',
];

function resolveFile(p) {
  // 无扩展名的短写（`agent-core:1063`）按 index.js 兜底
  const cands = path.extname(p) ? [p] : [`${p}/index.js`, p];
  for (const b of BASES) {
    for (const c of cands) {
      const q = path.join(REPO, b, c);
      if (fs.existsSync(q) && fs.statSync(q).isFile()) return q;
    }
  }
  return null;
}

// ── 1) 引用：文件可解析 + 行号不越界（G4 的位置面）──
const CITE = /`([A-Za-z0-9_./\-[\]]+\.(?:js|jsx|ts|tsx|mjs|json|sql|css|html|md|yml|yaml|plist)):(\d+(?:[-,]\d+)*)`/g;
const fileCache = new Map();
let citeCount = 0;
const weak = [];

for (const m of text.matchAll(CITE)) {
  citeCount++;
  const [, p, spec] = m;
  const fp = resolveFile(p);
  if (!fp) { errors.push(`引用文件不存在：${p}`); continue; }
  if (!fileCache.has(fp)) fileCache.set(fp, fs.readFileSync(fp, 'utf8').split('\n'));
  const body = fileCache.get(fp);
  // 只有**单点**引用才判「弱证据」：范围引用（a-b / a,b）的末行落在 `}` 上是正常的块结尾，
  // 把它算作弱证据会产生大量噪音（首版 331 条里九成是这种），噪音会淹没真问题。
  const single = !/[-–,]/.test(spec);
  for (const n of spec.split(/[-,]/).map(Number)) {
    if (n < 1 || n > body.length) {
      errors.push(`行号越界：${p}:${n}（文件仅 ${body.length} 行）`);
      continue;
    }
    if (!single) continue;
    const s = body[n - 1].trim();
    if (!s) weak.push(`${p}:${n} 指向空行`);
    else if (/^[})\];,]+$/.test(s)) weak.push(`${p}:${n} 指向纯闭合符号「${s}」`);
  }
}
if (weak.length) warns.push(...weak.map((w) => `弱证据：${w}`));

// ── 2) 章号与编号引用必须存在（G4）──
const chapters = new Set([...text.matchAll(/^## 第 (\d+) 章/gm)].map((m) => +m[1]));
// 适用范围：本脚本为章节体技术文档设计。对无章节体的文档（如核验报告）只做
// 「引用可解析」与「表格齐整」两类通用检查，跳过章号/编号/状态/数字四类，
// 否则会把正常文档判成一片红——误报比漏报更容易让人放弃工具。
const CHAPTER_STYLE = chapters.size > 0;
if (!CHAPTER_STYLE) warns.push('跳过章节相关检查：该文档没有「## 第 N 章」结构');
// 剥离引号内容与 blockquote 元信息：修订记录里会**引用**旧错误（如「第 11 章」）作对照，
// 那是被讨论的对象而非引用本身，不能判红。
const textForRefs = lines
  .filter((l) => !l.trim().startsWith('>'))
  .join('\n')
  .replace(/「[^」]*」/g, '')
  .replace(/“[^”]*”/g, '');
if (CHAPTER_STYLE) {
  for (const m of textForRefs.matchAll(/第 (\d+) 章/g)) {
    if (!chapters.has(+m[1])) errors.push(`悬空章号：第 ${m[1]} 章（实有 ${[...chapters].join('/')}）`);
  }
}
// 只查本仓库自定义的编号体系；P95/E2E/V8 这类同形 token 不在其中。
for (const tag of (CHAPTER_STYLE ? ['X', 'R', 'D', 'Q', 'J', 'A'] : [])) {
  // 定义形态：粗体 `**R7**`，或表格首列 `| R7 |`（修订记录用这种）
  const defined = new Set([
    ...[...text.matchAll(new RegExp(`\\*\\*${tag}(\\d+)\\*\\*`, 'g'))].map((m) => +m[1]),
    ...[...text.matchAll(new RegExp(`^\\| ${tag}(\\d+) \\|`, 'gm'))].map((m) => +m[1]),
  ]);
  if (!defined.size) continue;
  for (const m of textForRefs.matchAll(new RegExp(`(?:第 \\d+ 章[^|]{0,12}|；|、|和|与|见|参见 |\\s)${tag}(\\d+)\\b`, 'g'))) {
    const n = +m[1];
    if (!defined.has(n)) errors.push(`悬空编号：${tag}${n}`);
  }
}

// ── 3) 表格列数一致 ──
let blocks = 0;
{
  let cur = [];
  const flush = () => {
    if (cur.length > 2) {
      blocks++;
      const widths = cur.map(([, l]) => l.trim().replace(/^>/, '').trim().replace(/^\|/, '').replace(/\|$/, '')
        .split(/(?<!\\)\|/).length);
      const want = widths[0];
      widths.forEach((w, i) => {
        if (w !== want) errors.push(`表格列数不一致：第 ${cur[i][0]} 行有 ${w} 列，表头 ${want} 列`);
      });
    }
    cur = [];
  };
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('|')) cur.push([i + 1, l]);
    else flush();
  });
  flush();
}

// ── 4) 数字同步：源码现算 ↔ 文档写的那个值（G1）──
const facts = {};
facts.suites = fs.readdirSync(path.join(REPO, 'desktop/test'))
  .filter((f) => /\.test\.(js|mjs)$/.test(f)).length + 2; // + smoke-load / render-smoke
facts.mainJsModules = (function walk(d, n = 0) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) n = walk(path.join(d, e.name), n);
    else if (e.name.endsWith('.js')) n++;
  }
  return n;
})(path.join(REPO, 'desktop/main'));
// 口径 = `wc -l`：文件末尾换行不算额外一行（否则与文档差 1，属度量对象错配）
facts.mainJsRawLines = (function wcLines(p) {
  const parts = fs.readFileSync(p, 'utf8').split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
})(path.join(REPO, 'desktop/main/main.js'));

// IPC 通道：字面量 + WRITE_TOOLS 模板展开 + diff:comment 条件自注册（与文档 §2.2 同口径）
{
  const chans = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/ipcMain\.(?:handle|on)\(\s*(['"])([^'"]+)\1/g)) chans.add(m[2]);
      if (/diffIpcMain\.handle\(\s*'diff:comment'/.test(src)) chans.add('diff:comment');
    }
  };
  walk(path.join(REPO, 'desktop/main'));
  const execSrc = fs.readFileSync(path.join(REPO, 'desktop/main/tools/exec.js'), 'utf8');
  const wt = execSrc.match(/const WRITE_TOOLS = \[([^\]]+)\]/);
  if (wt) for (const m of wt[1].matchAll(/'([^']+)'/g)) chans.add(`tool:${m[1]}`);
  facts.ipcChannels = chans.size;
}
// preload 顶层桥方法：exposeInMainWorld('mjcode', { … }) 体内二级缩进的键
{
  const src = fs.readFileSync(path.join(REPO, 'desktop/main/preload.js'), 'utf8');
  const body = src.match(/exposeInMainWorld\('mjcode',\s*\{([\s\S]*)\}\);/);
  facts.preloadBridges = body
    ? [...body[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].length
    : NaN;
}

// 从文档里抓「作者声称的值」，与其比对（不写死常量）
const CLAIMS = [
  // 注意：文档里这些数字普遍被 `**` 包裹，正则必须容忍粗体标记
  // 2026-10-27：套件判据由「N 套件全绿」改为「N 套件」。
  // 理由：本脚本能**现算**的只有套件数，「是否全绿」它算不出来 —— 那件事由 `npm test`
  // 的 exit code 负责。把不可验证的词塞进被校验的断言里，只会让文档在门禁红着的时候
  // 继续声称「全绿」（实测：11 项存量门禁红着，该行已连续多轮写「297 套件全绿」）。
  // 计数仍严校验（差 1 就红）；「是否全绿」回到真正能判定的那一层去守。
  ['suites', /\*{0,2}(\d+)\*{0,2}\s*套件/, '「N 套件」'],
  ['ipcChannels', /\*{0,2}(\d+)\*{0,2}\s*条主进程通道/, '「N 条主进程通道」'],
  ['preloadBridges', /\*{0,2}(\d+)\*{0,2}\s*个 preload 桥方法/, '「N 个 preload 桥方法」'],
  ['mainJsModules', /\*{0,2}(\d+)\*{0,2}\s*个 JS 模块/, '「N 个 JS 模块」'],
  ['mainJsRawLines', /raw \*{0,2}(\d+)\*{0,2}\s*行/, '「raw N 行」'],
];
for (const [key, re, label] of (CHAPTER_STYLE ? CLAIMS : [])) {
  if (!label) continue; // 兜底项不单独校验
  const m = text.match(re);
  if (!m) { errors.push(`文档缺少${label}的表述，无法校验 ${key}`); continue; }
  const claimed = +m[1];
  if (claimed !== facts[key]) {
    errors.push(`数字漂移：${key} 文档写 ${claimed}，源码现算 ${facts[key]}`);
  }
}

// ── 5) 状态一致性：X 标「已修」，对应章级 R 必须也已回填（G2）──
const xRows = lines
  .map((l, i) => ({ line: i + 1, text: l }))
  .filter((r) => /^\| \*\*X\d+\*\*/.test(r.text));
for (const row of (CHAPTER_STYLE ? xRows : [])) {
  if (!/✅ 已修/.test(row.text)) continue;
  const id = row.text.match(/\*\*(X\d+)\*\*/)[1];
  // 出处形如「第 7 章 R2」「第 4 章 R1 + 第 7 章 R7」
  for (const m of row.text.matchAll(/第 (\d+) 章[^\w|]{0,6}(?:§11\s*)?R(\d+)/g)) {
    const [, ch, rn] = m;
    const hit = lines.filter((l) => new RegExp(`^\\| \\*{0,2}R${rn}\\*{0,2} \\|`).test(l)
      || new RegExp(`^#### R${rn}\\b`).test(l));
    if (!hit.length) { warns.push(`${id} 引「第 ${ch} 章 R${rn}」但在文档中找不到该行`); continue; }
    // 只在该 R 行属于对应章时判定（按章号定位区间，避免同名 R 串味）
    const start = lines.findIndex((l) => l.startsWith(`## 第 ${ch} 章`));
    if (start < 0) continue;
    const end = lines.findIndex((l, i) => i > start && /^## 第 \d+ 章/.test(l));
    const inCh = hit.filter((h) => {
      const li = lines.indexOf(h);
      return li > start && (end < 0 || li < end);
    });
    if (!inCh.length) continue;
    // 只认 ✅ / 已修。**不能把 `~~` 删除线当已修标记**：反向验证时发现，
    // 一条 R 若只保留删除线而漏掉 ✅，会被误判为「已回填」——那就是哑校验点。
    const ok = inCh.some((l) => /✅|已修/.test(l));
    if (!ok) errors.push(`状态不一致：${id} 标注已修，但第 ${ch} 章 R${rn} 仍写作未修（第 ${lines.indexOf(inCh[0]) + 1} 行）`);
  }
}

// ── 6) 否定式断言清单（G3 只能人工复核，这里只列出来）──
const negations = [];
lines.forEach((l, i) => {
  if (/(唯一|全仓无|全仓 0|0 处|零命中|无任何|从未|不存在)/.test(l) && !/^\s*>/.test(l) && !/^\| R\d+/.test(l)) {
    negations.push(`第 ${i + 1} 行：${l.trim().slice(0, 60)}…`);
  }
});

// ── 汇总 ──
say(`文档：${path.relative(REPO, DOC)}`);
say(`规模：${lines.length} 行 / ${blocks} 个表格块 / ${citeCount} 条 文件:行 引用`);
say(`现算：套件 ${facts.suites} · 通道 ${facts.ipcChannels} · 桥方法 ${facts.preloadBridges} · 主进程 JS ${facts.mainJsModules} · main.js raw ${facts.mainJsRawLines}`);
if (!QUIET) {
  notes.push(`否定式断言 ${negations.length} 条（G3，需人工各附一条可复跑命令证明检索有效）`);
  say(`警告 ${warns.length} 条：`);
  warns.forEach((w) => say(`  ⚠ ${w}`));
  say(`提示：${notes.join('；')}`);
}
if (errors.length) {
  console.error(`\n✗ 发现 ${errors.length} 个问题：`);
  errors.forEach((e) => console.error(`  ✗ ${e}`));
  process.exitCode = 1;
} else {
  say(CHAPTER_STYLE
    ? '\n✓ 文档与源码一致（引用可解析、章号与编号无悬空、表格齐整、关键数字同步、X/R 状态一致）'
    : '\n✓ 通过通用检查（引用可解析、表格齐整）；章节相关检查已按适用范围跳过');
}
