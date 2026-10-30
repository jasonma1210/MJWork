// S-005 门禁：markdown 链接协议白名单（renderer/src/lib/safeUrl.ts）
//
// 为什么要测：这一层的价值全在「上游（react-markdown）默认 urlTransform 失效时仍能拦住」，
// 而 renderer 是 TS/TSX、本仓测试是裸 node —— 所以这里用 typescript 的 transpileModule
// 把**真实实现**转成 CJS 后加载，测的是同一份代码，不是抄一份 JS 镜像（两份实现必然漂移）。
//
// 反向验证：把 safeUrl.ts 里 ALLOWED_SCHEMES 改成 /^.*$/（等于全放行），本文件必须红。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
// 注释里的 `<a href={href}>` 不会被渲染，但会污染文本断言（我们自己的说明文案就成了假红源）——
// 复用 ui-conventions 那套 blankComments，保持「注释不算代码」的单一口径。
const { blankComments } = require(path.join(ROOT, 'scripts', 'lib', 'rawButtonScan.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const LIB = path.join(ROOT, 'renderer', 'src', 'lib', 'safeUrl.ts');

/** 用仓库自带的 typescript 把 .ts 转 CJS 后在同进程求值，返回其导出面 */
function loadTsModule(file) {
  const ts = require(path.join(ROOT, 'renderer', 'node_modules', 'typescript'));
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: path.basename(file),
  }).outputText;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', js)(mod.exports, require, mod);
  return mod.exports;
}

const lib = loadTsModule(LIB);
const { safeUrlTransform, toExternalHref } = lib;

check('加载到真实实现（safeUrl.ts 转 CJS 后导出两个函数）',
  typeof safeUrlTransform === 'function' && typeof toExternalHref === 'function',
  `exports=${Object.keys(lib).join(',')}`);

// ── 必须拦下：脚本协议与各类绕过变体 ──
const BLOCKED = [
  ['javascript:', 'javascript:alert(1)'],
  ['大小写混写', 'JaVaScRiPt:alert(1)'],
  ['前导空白', '   javascript:alert(1)'],
  ['内嵌换行（\n 被浏览器忽略）', 'java\nscript:alert(1)'],
  ['内嵌制表符', 'java\tscript:alert(1)'],
  ['反斜杠变体', 'java\\script:alert(1)'],
  ['data: 文档', 'data:text/html,<script>alert(1)</script>'],
  ['vbscript:', 'vbscript:msgbox(1)'],
  ['file: 本地文件', 'file:///etc/passwd'],
  ['空串', ''],
  ['纯空白', '   '],
];
for (const [label, url] of BLOCKED) {
  check(`拦截 ${label}`, safeUrlTransform(url) === '', `输入=${JSON.stringify(url)}`);
}

// ── 必须放行（放行口径 = 原样返回，不改写用户/模型的链接）──
const ALLOWED = [
  ['https 外链', 'https://example.com/a?b=1#c'],
  ['http 外链', 'http://localhost:3000/x'],
  ['mailto', 'mailto:a@b.com'],
  ['页内锚点', '#section-2'],
  ['站内相对路径', 'src/main/approval.js'],
  ['点斜杠相对路径', './docs/a.md'],
  ['上级相对路径', '../x/y.md'],
  ['查询串', '?q=1'],
  ['协议相对（组件层补 https 后交系统浏览器）', '//example.com/p'],
];
for (const [label, url] of ALLOWED) {
  check(`放行 ${label}`, safeUrlTransform(url) === url, `返回=${JSON.stringify(safeUrlTransform(url))}`);
}

// ── toExternalHref：组件层据此决定「走系统浏览器还是纯文本」──
check('toExternalHref：协议相对补成 https',
  toExternalHref('//evil.example/x') === 'https://evil.example/x');
check('toExternalHref：http(s)/mailto 原样',
  toExternalHref('https://a.com') === 'https://a.com' && toExternalHref('mailto:a@b.com') === 'mailto:a@b.com');
check('toExternalHref：锚点/相对路径/脚本协议都不外开',
  ['#a', 'src/a.js', 'javascript:alert(1)', 'data:text/html,x', ''].every((u) => toExternalHref(u) === ''));

// ── 接线点位数：每个 <ReactMarkdown 都必须带 urlTransform，少一处就是一个漏筛的渲染面 ──
// 用「计数相等」而不是「文本里出现过」——后者只能证明改过一处，管道漏接照样绿。
const WIRED = [
  ['components/MessageStream.tsx', 3],
  ['components/ReasoningPanel.tsx', 1],
  ['components/FilePreview.jsx', 1],
];
for (const [rel, want] of WIRED) {
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'renderer', 'src', rel), 'utf8'));
  const mdCount = (src.match(/<ReactMarkdown\b/g) || []).length;
  const utCount = (src.match(/urlTransform=\{safeUrlTransform\}/g) || []).length;
  const imported = /import\s*\{[^}]*safeUrlTransform[^}]*\}\s*from\s*'[^']*lib\/safeUrl'/m.test(src);
  check(`${rel}：${mdCount} 个 markdown 渲染面全部接上协议白名单`,
    mdCount === want && utCount === want && imported,
    `md=${mdCount} urlTransform=${utCount} import=${imported}（期望 ${want}/${want}/true）`);
}

// ── 清单完备性：全仓每个含 <ReactMarkdown 的源文件都必须在 WIRED 里登记 ──
// 光有「登记项都对」不够——把渲染面抽到新文件后，只要忘了登记清单，上面那个循环会全绿。
// 这里反向扫一遍：现算的文件集必须与清单文件集**全等**（多、少都红）。
{
  const SRC = path.join(ROOT, 'renderer', 'src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.(tsx|jsx)$/.test(d.name) ? [p] : [];
  });
  const actual = walk(SRC)
    .filter((f) => (blankComments(fs.readFileSync(f, 'utf8')).match(/<ReactMarkdown\b/g) || []).length > 0)
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .sort();
  const declared = WIRED.map(([rel]) => rel).sort();
  const missing = actual.filter((f) => !declared.includes(f));
  const stale = declared.filter((f) => !actual.includes(f));
  check('清单完备：含 <ReactMarkdown 的源文件与 WIRED 全等（抽新文件必须登记）',
    missing.length === 0 && stale.length === 0,
    `未登记=[${missing.join(',')}] 已失效=[${stale.join(',')}]`);
}

// ── MessageStream 兜底分支不得再产出「原样 href」的可达 <a>（S-005 的原始 sink）──
{
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'components', 'MessageStream.tsx'), 'utf8'));
  const raw = src.match(/<a\s+href=\{href\}[^>]*>/g) || [];
  check('MessageStream：无「原样 href」的兜底 <a>（未知协议降级为纯文本）', raw.length === 0,
    raw.length ? `残留：${raw.join(' | ')}` : '已全部改为 span/系统浏览器两条出口');
  check('MessageStream：外链锚点统一 rel="noreferrer"',
    (src.match(/rel="noreferrer"/g) || []).length >= 2, `${(src.match(/rel="noreferrer"/g) || []).length} 处`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
