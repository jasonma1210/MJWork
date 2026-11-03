// 消息 meta 行与运行结束信息条渲染测试（真机复盘：结果出来了但「结束的信息」全缺）
// 覆盖：双轨字段（snake_case 在线 / camelCase 本地库）meta 渲染、
//       中间消息（有 token 无模型名）meta、空 meta 不渲染、RunFooter 四态。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer/src');
const esbuild = require(path.join(DESKTOP, 'renderer/node_modules/esbuild'));

let pass = 0, total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 浏览器 API 桩（与 render-smoke 一致，ChatArea 模块顶层求值所需）──
const noop = () => {};
const define = (key, value) => {
  try { Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); }
  catch { /* 不可覆盖则保持原值 */ }
};
const storage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop };
define('window', {
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  location: { href: 'http://localhost/' }, mjcode: undefined,
  localStorage: storage, sessionStorage: storage,
  getComputedStyle: () => ({}), matchMedia: () => ({ matches: false, addListener: noop, addEventListener: noop }),
  requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: noop,
  innerWidth: 1280, innerHeight: 800,
});
define('document', {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop }),
  addEventListener: noop, removeEventListener: noop,
  body: { appendChild: noop, removeChild: noop }, documentElement: { style: {} }, head: { appendChild: noop },
});
define('localStorage', storage);
define('sessionStorage', storage);
define('navigator', { userAgent: 'node', platform: 'darwin', clipboard: { writeText: async () => {} } });
define('CustomEvent', class { constructor(t, o) { this.type = t; Object.assign(this, o); } });
define('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { createRequire: makeRequire } = await import('node:module');
const rendererRequire = makeRequire(path.join(DESKTOP, 'renderer/package.json'));
// T3-2：i18n 语言包经 globalThis 注入（esbuild bundle 下 i18n 实例只此一份）；
// 渲染须包 LanguageProvider（组件用 useI18n）——用临时 wrapper entry 把
// ChatArea 具名导出与 Provider 编进同一 bundle，测试侧按原 API 调用。
{
  const packs = {};
  for (const loc of ['zh-CN', 'en-US']) {
    const dir = path.join(SRC, 'i18n', 'locales', loc);
    const d = {};
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) d[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    packs[loc] = d;
  }
  globalThis.__MJ_I18N_PACKS__ = packs;
}
// S11：探针走 esbuild stdin 内存编译（与 render-smoke 的 compileInline 同口径），磁盘零落盘。
// 旧写法先 writeFileSync 到 renderer/src/__meta_probe.jsx，再在 buildSync 之后 unlinkSync：
// buildSync 一旦抛错（比如 ChatArea 不再 re-export renderMessages），unlink 永不执行，
// 探针就永久留在源码树里（S10 变异实验实测残留 1 次）。
// stdin 下 resolveDir 仍是 SRC，'./i18n'、'./components/ChatArea.jsx' 这类相对 import
// 照常解析；sourcefile 只是报错信息里的文件名，不写盘。
const PROBE_FILE = '__meta_probe.jsx';
const result = esbuild.buildSync({
  bundle: true,
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"production"' },
  format: 'cjs', platform: 'browser', jsx: 'automatic',
  loader: { '.jsx': 'jsx', '.tsx': 'tsx', '.js': 'jsx', '.mjs': 'jsx', '.png': 'dataurl', '.mp3': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
  write: false, logLevel: 'silent',
  stdin: {
    contents: [
      "import { LanguageProvider } from './i18n';",
      "import { renderMessages as _rm, RunFooter as _rf } from './components/ChatArea.jsx';",
      'export function renderMessages(msgs) { return <LanguageProvider>{_rm(msgs)}</LanguageProvider>; }',
      'export function RunFooter(props) { return <LanguageProvider><_rf {...props} /></LanguageProvider>; }',
    ].join('\n'),
    resolveDir: SRC, sourcefile: PROBE_FILE, loader: 'jsx',
  },
});
const moduleObj = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('require', 'module', 'exports', '__filename', '__dirname', result.outputFiles[0].text)(
  rendererRequire, moduleObj, moduleObj.exports, path.join(SRC, PROBE_FILE), SRC,
);
const { renderMessages, RunFooter } = moduleObj.exports;
const React = rendererRequire('react');
const { renderToStaticMarkup } = rendererRequire('react-dom/server');
const htmlOf = (fn) => renderToStaticMarkup(React.createElement('div', null, typeof fn === 'function' ? fn() : fn));

const T = 1791966897626; // 2026-10-14 16:34 CST

check('meta：最终回复（snake_case，在线字段）渲染 共消耗/模型/时间', () => {
  const html = htmlOf(() => renderMessages([
    { role: 'assistant', content: '结论', model_name: 'mimo-v2.6-flash', tokens_input: 626627, tokens_output: 10946, created_at: T },
  ]));
  assert.ok(html.includes('共消耗 637,573 tokens'), `缺共消耗：${html.slice(0, 200)}`);
  assert.ok(html.includes('mimo-v2.6-flash'), '缺模型名');
  assert.ok(html.includes(':') && /\d{1,2}:\d{2}/.test(html), '缺时间');
});

check('meta：本地库回读（camelCase 字段）同样渲染', () => {
  const html = htmlOf(() => renderMessages([
    { role: 'assistant', content: '结论', modelName: 'mimo-v2.6-flash', tokensInput: 100, tokensOutput: 20, createdAt: T },
  ]));
  assert.ok(html.includes('共消耗 120 tokens'), '缺共消耗');
  assert.ok(html.includes('mimo-v2.6-flash'), '缺模型名');
});

check('meta：中间消息（有 token 无模型名）也展示消耗（条件放宽回归）', () => {
  const html = htmlOf(() => renderMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'shell', arguments: '{}' } }], tokens_input: 17546, tokens_output: 205, created_at: T },
  ]));
  assert.ok(html.includes('共消耗 17,751 tokens'), '中间消息消耗应可见');
});

check('meta：无任何元信息的消息不渲染空行', () => {
  const html = htmlOf(() => renderMessages([{ role: 'assistant', content: '裸消息' }]));
  assert.ok(!html.includes('共消耗'), '不应出现空 meta');
});

// ── Markdown 能力面（2026-11-03，用户反馈 6）──
// 用户要求「AI 回复务必遵循最新 md 规范：逻辑图、公式、表格都要真的渲染」。
// 这里断的是**渲染结果**（HTML 里有没有 KaTeX / <table>），不是源码里有没有 import ——
// 「装了插件但没接上」正是这类需求最常见的假完成。
check('markdown：公式渲染成 KaTeX（$E=mc^2$ 不得原样显示成美元符号）', () => {
  const html = htmlOf(() => renderMessages([
    { role: 'assistant', content: '行内 $E=mc^2$ 结束\n\n$$\n\\sum_{i=1}^{n} i\n$$' },
  ]));
  assert.ok(!html.includes('$E=mc^2$'), '行内公式仍原样显示（remark-math 未生效）');
  assert.ok(html.includes('katex'), '未产出 KaTeX 结构（MathSpan 未接管 language-math）');
  assert.ok(html.includes('md-math-block'), '块级公式未走独占一行的容器');
});

check('markdown：GFM 表格渲染成 <table> 并包在横向滚动容器里', () => {
  const html = htmlOf(() => renderMessages([
    { role: 'assistant', content: '| 项 | 值 |\n| --- | --- |\n| A | 1 |' },
  ]));
  assert.ok(html.includes('<table'), '表格未渲染');
  assert.ok(html.includes('md-table-wrap'), '表格缺横向滚动容器（宽表会撑破消息列）');
  assert.ok(html.includes('<th'), '表头未渲染（GFM 未生效）');
});

check('mermaid：渲染失败时必须放出源码（不能只显示一句「渲染失败」）', () => {
  const src = fs.readFileSync(path.join(SRC, 'components/MermaidDiagram.tsx'), 'utf8');
  const at = src.indexOf("if (error)");
  assert.ok(at > 0, '未找到渲染失败分支');
  const block = src.slice(at, at + 900);
  assert.ok(block.includes('message.diagramShowSource'), '失败分支缺「查看图表源码」入口');
  assert.ok(block.includes('{code}'), '失败分支未输出图表源码（内容被吞掉）');
});

check('RunFooter：正常结束态展示 状态/耗时/共消耗/模型/时间', () => {
  const html = htmlOf(React.createElement(RunFooter, {
    summary: { status: 'done', durationMs: 660000, tokensIn: 626627, tokensOut: 10946, model: 'mimo-v2.6-flash', endedAt: T },
  }));
  assert.ok(html.includes('运行结束'), '缺状态');
  assert.ok(html.includes('耗时 11m0s'), `缺耗时：${html.slice(0, 300)}`);
  assert.ok(html.includes('共消耗 637,573 tokens'), '缺共消耗');
  assert.ok(html.includes('mimo-v2.6-flash'), '缺模型');
});

check('RunFooter：预算暂停态提示断点可恢复', () => {
  const html = htmlOf(React.createElement(RunFooter, {
    summary: { status: 'suspended', durationMs: 65000, tokensIn: 1, tokensOut: 1, model: 'm', endedAt: T },
  }));
  assert.ok(html.includes('任务暂停') && html.includes('「继续」'), '缺暂停恢复提示');
});

check('RunFooter：summary 为空不渲染内容', () => {
  const html = htmlOf(React.createElement(RunFooter, { summary: null }));
  assert.ok(!html.includes('运行结束') && !html.includes('共消耗'), '空 summary 不应渲染任何内容');
});

check('RunFooter：live 运行中态展示 运行中/已耗时/本轮消耗/上下文（T1-5）', () => {
  const html = htmlOf(React.createElement(RunFooter, {
    summary: null,
    live: {
      startedAt: T - 66000,
      tokensIn: 100, tokensOut: 50,
      contextUsage: { used: 6400, total: 128000, ratio: 0.05 },
      model: 'mimo-v2.6-flash',
    },
  }));
  assert.ok(html.includes('运行中'), '缺运行中徽标');
  assert.ok(html.includes('已耗时'), '缺实时耗时');
  assert.ok(html.includes('本轮消耗 150 tokens'), `缺本轮消耗：${html.slice(0, 300)}`);
  assert.ok(html.includes('上下文 5%'), '缺上下文用量');
  assert.ok(html.includes('mimo-v2.6-flash'), '缺模型名');
});

check('RunFooter：live 模式优先于结束态（运行中不显示旧收尾条）', () => {
  const html = htmlOf(React.createElement(RunFooter, {
    summary: { status: 'done', durationMs: 1000, tokensIn: 1, tokensOut: 1, model: 'm', endedAt: T },
    live: { startedAt: T - 1000, tokensIn: 0, tokensOut: 0 },
  }));
  assert.ok(html.includes('运行中') && !html.includes('运行结束'), 'live 期间不应渲染结束态');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
process.exit(pass === total ? 0 : 1);
