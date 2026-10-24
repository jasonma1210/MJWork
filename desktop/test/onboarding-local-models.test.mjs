// 首启向导「配置模型」步：本地模式必须能直接选本机已配置的模型（FIX-P07）
//
// 缺陷形态：本地模式下 api.globalProviders() 恒返回 []（renderer/src/lib/api.js:203），
// 而向导模型步**只**从 globalProviders 派生可选项（Onboarding.jsx），userProviders
// 虽由 App 传入却从未被消费 ⇒ 新用户/老用户首聊都只剩 Name/BaseURL/Key/ModelID
// 四个手填字段，本机已配好的 provider+model 完全不可选。
//
// 本套件用真实 SSR 渲染（no jsdom）：esbuild 打 bundle + react-dom/server 出静态 HTML，
// 再数「可点选的模型条目」。渲染时把 Onboarding 的 step 初始值种到 1（配置模型步），
// 其余 hooks 初值不动 —— 只改变「看哪一步」，不改被测逻辑。
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

// ── 浏览器 API 桩（组件模块顶层求值所需）──
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

// i18n 语言包经 globalThis 注入（esbuild bundle 下 i18n 实例只此一份）
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

const rendererRequire = createRequire(path.join(DESKTOP, 'renderer/package.json'));
// S11：探针走 esbuild stdin 内存编译（与 render-smoke 的 compileInline 同口径），磁盘零落盘。
// 旧写法先 writeFileSync 到 renderer/src/__onboarding_probe.jsx、buildSync 之后再 unlinkSync
// （此处原本有 try/finally，所以崩溃不残留，但正常路径仍往源码目录写盘；另两个套件没有
// finally，实测各残留 1 次）。stdin 下 resolveDir 仍是 SRC，'./i18n'、
// './components/Onboarding.jsx' 这类相对 import 照常解析；sourcefile 只作报错文件名。
const PROBE_FILE = '__onboarding_probe.jsx';
const bundle = esbuild.buildSync({
  bundle: true,
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"production"' },
  format: 'cjs', platform: 'browser', jsx: 'automatic',
  loader: { '.jsx': 'jsx', '.tsx': 'tsx', '.js': 'jsx', '.mjs': 'jsx', '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
  write: false, logLevel: 'silent',
  stdin: {
    contents: [
      "import { LanguageProvider } from './i18n';",
      "import Onboarding from './components/Onboarding.jsx';",
      'export function render(props) { return <LanguageProvider><Onboarding {...props} /></LanguageProvider>; }',
    ].join('\n'),
    resolveDir: SRC, sourcefile: PROBE_FILE, loader: 'jsx',
  },
});
const moduleObj = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('require', 'module', 'exports', '__filename', '__dirname', bundle.outputFiles[0].text)(
  rendererRequire, moduleObj, moduleObj.exports, path.join(SRC, PROBE_FILE), SRC,
);
const { render } = moduleObj.exports;
const React = rendererRequire('react');
const { renderToStaticMarkup } = rendererRequire('react-dom/server');

// step 是 Onboarding 里唯一一个 `useState(0)`（初值 0 = 欢迎步）。只种它的初值到目标步，
// 其余 hooks 原样 —— 换取「模型步」的真实渲染产物。
// 不能用「第一个 useState」定位：外层的 LanguageProvider 先渲染，它的 locale 是函数初值。
function htmlOf(props, step = 1) {
  const realUseState = React.useState;
  let seeded = false;
  React.useState = function seedStep(init) {
    if (!seeded && typeof init === 'number' && init === 0) { seeded = true; return realUseState(step); }
    return realUseState(init);
  };
  try {
    const html = renderToStaticMarkup(React.createElement('div', null, render(props)));
    assert.ok(seeded, '未命中 step 初值：向导结构变了，需更新本测试的种子定位方式');
    return html;
  } finally {
    React.useState = realUseState;
  }
}

const LOCAL_PROVIDERS = [
  {
    id: 'p1', name: 'LocalDeepSeek', base_url: 'https://api.deepseek.com/v1',
    models: [{ model_id: 'deepseek-chat' }, { model_id: 'deepseek-reasoner' }],
  },
];
const baseProps = {
  globalProviders: [], userProviders: [],
  onFinish: noop, onProviderAdded: noop, onProjectSelected: noop,
  approvalSettings: {}, onApprovalSettingsChange: noop,
};
// 可点选选项的计数口径：数**原生单选控件**（RB-1 / S1）。
// 不数本轮自己加的 data-* 属性——那是自指判据：组件把属性删了测试会变绿，而界面其实没得选。
// 单选控件的个数 == 「用户能选的模型个数」，与实现细节无关。
const countOptions = (html) => (html.match(/<input[^>]+type="radio"/g) || []).length;

check('本地模式：本机已配置的 2 个模型可直接点选（不再只有 4 个手填字段）', () => {
  const html = htmlOf({ ...baseProps, userProviders: LOCAL_PROVIDERS });
  const n = countOptions(html);
  assert.equal(n, 2, `可点选模型条目应为 2，实际 ${n}`);
  assert.ok(html.includes('LocalDeepSeek'), '选项应带 provider 名');
  assert.ok(html.includes('deepseek-chat'), '选项应带 model_id');
});

check('本机无 provider 时：手填表单仍在（全新安装不被卡死）', () => {
  const html = htmlOf(baseProps);
  assert.equal(countOptions(html), 0, '无本机模型时不应出现手填之外的选项');
  assert.ok(html.includes('api.deepseek.com'), '手填接口地址占位仍在');
  assert.ok(html.includes('deepseek-chat'), '手填模型 ID 占位仍在');
});

check('有共享模型时：共享模型入口仍渲染（不回归在线态）', () => {
  const html = htmlOf({
    ...baseProps,
    globalProviders: [{ id: 's1', name: 'CloudGW', base_url: 'https://gw.example/v1', models: [{ model_id: 'gw-large' }] }],
  });
  // 共享模型需先点「服务器共享模型」卡片才展开列表（既有交互，未改动）
  assert.ok(html.includes('服务器共享模型'), '共享模型入口卡片应仍渲染');
});

check('共享模型与本机模型并存时：本机 2 条可选，共享入口仍在', () => {
  const html = htmlOf({
    ...baseProps,
    userProviders: LOCAL_PROVIDERS,
    globalProviders: [{ id: 's1', name: 'CloudGW', base_url: 'https://gw.example/v1', models: [{ model_id: 'gw-large' }] }],
  });
  assert.equal(countOptions(html), 2, `本机可点选模型应为 2，实际 ${countOptions(html)}`);
  assert.ok(html.includes('服务器共享模型'), '共享模型入口不应因新增本机列表而消失');
});

console.log(`\n${pass}/${total} 通过`);
