// T1-4 子任务树/DAG 可视化测试（SubtaskTree.tsx）
// 覆盖：空态 / 编排组分层（依赖即波次）/ 事件合并（spawn→progress→done 幂等推进）
//      失败原因恒显 / tokens 角标 / 单代理事件归并（progress/done 归最近开启卡）
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

// ── 浏览器 API 桩（与 message-meta 一致）──
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
define('navigator', { userAgent: 'node', platform: 'darwin' });

const { createRequire: makeRequire } = await import('node:module');
const rendererRequire = makeRequire(path.join(DESKTOP, 'renderer/package.json'));
// T3-2：语言包经 globalThis 注入 + wrapper entry 把 SubtaskTree 与 LanguageProvider
// 编进同一 bundle（组件用 useI18n，缺 Provider 抛；esbuild bundle 下 i18n 实例只此一份）
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
// 旧写法先 writeFileSync 到 renderer/src/__subtask_probe.jsx，再在 buildSync 之后 unlinkSync：
// buildSync 一旦抛错（比如 SubtaskTree 不再默认导出），unlink 永不执行，
// 探针就永久留在源码树里（S10 变异实验实测残留 1 次）。
// stdin 下 resolveDir 仍是 SRC，'./i18n'、'./components/tools/SubtaskTree.tsx'
// 这类相对 import 照常解析；sourcefile 只是报错信息里的文件名，不写盘。
const PROBE_FILE = '__subtask_probe.jsx';
const result = esbuild.buildSync({
  bundle: true,
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"production"' },
  format: 'cjs', platform: 'browser', jsx: 'automatic',
  loader: { '.jsx': 'jsx', '.tsx': 'tsx', '.js': 'jsx', '.mjs': 'jsx', '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
  write: false, logLevel: 'silent',
  stdin: {
    contents: [
      "import { LanguageProvider } from './i18n';",
      "import Tree from './components/tools/SubtaskTree.tsx';",
      'export default function Root(props) { return <LanguageProvider><Tree {...props} /></LanguageProvider>; }',
    ].join('\n'),
    resolveDir: SRC, sourcefile: PROBE_FILE, loader: 'jsx',
  },
});
const moduleObj = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('require', 'module', 'exports', '__filename', '__dirname', result.outputFiles[0].text)(
  rendererRequire, moduleObj, moduleObj.exports,
  path.join(SRC, PROBE_FILE), SRC,
);
const SubtaskTree = moduleObj.exports.default;
const React = rendererRequire('react');
const { renderToStaticMarkup } = rendererRequire('react-dom/server');
const htmlOf = (events) => renderToStaticMarkup(React.createElement(SubtaskTree, { events }));

const spawnEvt = (taskId, title, dependsOn = []) => ({
  tool: 'orchestrate_task', groupId: 'g1', taskId, title, dependsOn, phase: 'spawn',
});

check('空态：无事件时给出空态文案', () => {
  const html = htmlOf([]);
  assert.ok(html.includes('暂无子任务'), `缺空态文案：${html.slice(0, 200)}`);
});

check('编排组：节点/标题/完成计数渲染', () => {
  const html = htmlOf([
    spawnEvt('t1', '检索入口'),
    spawnEvt('t2', '汇总报告', ['t1']),
    { tool: 'orchestrate_task', groupId: 'g1', taskId: 't1', phase: 'done', tokens: 3200, summary: '找到三处入口' },
  ]);
  assert.ok(html.includes('检索入口') && html.includes('汇总报告'), '缺节点标题');
  assert.ok(html.includes('1/2 完成'), `缺完成计数：${html.slice(0, 400)}`);
  assert.ok(html.includes('3.2k tk'), '缺 tokens 角标');
  assert.ok(html.includes('依赖：') && html.includes('t1'), '缺依赖徽标');
});

check('编排组：done 结论默认不展开（点击才可见），失败原因恒显', () => {
  const html = htmlOf([
    spawnEvt('t1', '任务A'),
    { tool: 'orchestrate_task', groupId: 'g1', taskId: 't1', phase: 'done', tokens: 10, summary: '机密结论文本' },
    spawnEvt('t2', '任务B', ['t1']),
    { tool: 'orchestrate_task', groupId: 'g1', taskId: 't2', phase: 'failed', error: '模型超时' },
  ]);
  assert.ok(!html.includes('机密结论文本'), '结论不应默认展开');
  assert.ok(html.includes('模型超时'), '失败原因应恒显');
  assert.ok(html.includes('1 失败'), '缺失败计数');
});

check('事件合并：progress 与 done 只保留最新状态与 tokens', () => {
  const html = htmlOf([
    spawnEvt('t1', '任务A'),
    { tool: 'orchestrate_task', groupId: 'g1', taskId: 't1', phase: 'progress', tokens: 100 },
    { tool: 'orchestrate_task', groupId: 'g1', taskId: 't1', phase: 'done', tokens: 2400, summary: '完成' },
  ]);
  // done 的 tokens 覆盖 progress 的（后到为准），且节点不重复
  assert.ok(html.includes('2.4k tk'), '终态 tokens 应覆盖中间值');
  assert.ok(!html.includes('0.1k tk'), '中间 tokens 不应残留');
  assert.ok(html.includes('1/1 完成'), '节点应只算一次');
});

check('单代理：spawn→done 归并同一张卡，不产生重复节点', () => {
  const html = htmlOf([
    { tool: 'spawn_subagent', phase: 'spawn', objective: '调研仓库结构', taskType: 'explore' },
    { tool: 'spawn_subagent', phase: 'progress', tokens: 500 },
    { tool: 'spawn_subagent', phase: 'done', tokens: 1800, summary: '入口在 src/', ms: 4200 },
  ]);
  assert.ok((html.match(/调研仓库结构/g) || []).length === 1, '单代理卡应只出现一次');
  assert.ok(html.includes('1.8k tk'), '终态 tokens 应展示');
  assert.ok(html.includes('单代理 · explore'), '缺 taskType 标识');
  assert.ok(!html.includes('入口在 src/'), '结论默认不展开');
});

check('DAG 分层：被依赖节点排在依赖方之前（t2 依赖 t1 时 t1 先渲染）', () => {
  const html = htmlOf([
    spawnEvt('t2', '下游任务', ['t1']),
    spawnEvt('t1', '上游任务'),
  ]);
  assert.ok(html.indexOf('上游任务') < html.indexOf('下游任务'), '分层应上游在前');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
process.exit(pass === total ? 0 : 1);
