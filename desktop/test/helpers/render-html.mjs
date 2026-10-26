// 共用工具：在 Node 里把 renderer/src 下的组件**真渲染**成 HTML 字符串
//
// 为什么需要它：静态门禁只能证明「源码里有这一行」，而「一个页面里到底亮了几个入口」
// 这类断言只能在**渲染结果**上做。此前 `sidebar-nav-active` / `nav-state-dual-entry` 里
// 用的 `filter((k) => k === got).length <= 1` 是**恒真式**（纯函数返回单值，命中数恒 ≤ 1），
// 它证明不了「不会两个入口同时亮」——改成数渲染出来的 `aria-current="page"` 才成立。
//
// 加载方式与 test/render-smoke.mjs 同源（esbuild 编成 CJS + react-dom/server），
// 抽成共用 helper 是为了两处复用而不再各写一份、各自漂移。
// 刻意不做：不落盘、不起 jsdom、不跑 effect（渲染期副作用由调用方自己保证无害）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HELPER_DIR = import.meta.dirname;
const DESKTOP = path.resolve(HELPER_DIR, '..', '..');
const SRC = path.join(DESKTOP, 'renderer', 'src');
const rendererRequire = createRequire(path.join(DESKTOP, 'renderer', 'package.json'));

const noop = () => {};
const define = (key, value) => {
  try { Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); }
  catch { /* 不可覆盖则保持原值 */ }
};
const stubEl = () => ({
  appendChild: noop, removeChild: noop, setAttribute: noop, removeAttribute: noop,
  style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, removeEventListener: noop, focus: noop, blur: noop,
  children: [], childNodes: [], innerHTML: '', textContent: '', value: '',
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 }),
});

let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  const storage = { getItem: (k) => (k === 'mj_onboarded' ? '1' : null), setItem: noop, removeItem: noop, clear: noop };
  define('window', {
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
    location: { href: 'http://localhost/' }, mjcode: undefined, localStorage: storage, sessionStorage: storage,
    getComputedStyle: () => ({}), matchMedia: () => ({ matches: false, addListener: noop, addEventListener: noop }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: noop,
    open: noop, scrollTo: noop, innerWidth: 1280, innerHeight: 800,
  });
  define('document', {
    getElementById: () => stubEl(), querySelector: () => null, querySelectorAll: () => [],
    createElement: stubEl, createTextNode: () => ({}),
    addEventListener: noop, removeEventListener: noop,
    body: stubEl(), documentElement: stubEl(), head: stubEl(),
  });
  define('localStorage', storage);
  define('sessionStorage', storage);
  define('navigator', { userAgent: 'node', platform: 'darwin', mediaDevices: undefined, clipboard: { writeText: async () => {} } });
  define('CustomEvent', class CustomEvent { constructor(t, o) { this.type = t; Object.assign(this, o); } });
  define('matchMedia', () => ({ matches: false, addListener: noop, addEventListener: noop }));
  define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  define('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  define('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });

  // 语言包经 globalThis 注入：esbuild bundle 下每个 entry 各带一份 i18n 实例，模块单例不共享
  const packs = {};
  for (const loc of ['zh-CN', 'en-US']) {
    const dir = path.join(SRC, 'i18n', 'locales', loc);
    const d = {};
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) d[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
    }
    packs[loc] = d;
  }
  globalThis.__MJ_I18N_PACKS__ = packs;
}

/**
 * 渲染 `renderer/src/<rel>` 为静态 HTML。
 * 自动包一层 `LanguageProvider`（组件用 useI18n，缺 Provider 会抛）。
 */
export function renderHtml(rel, props = {}) {
  boot();
  const esbuild = rendererRequire('esbuild');
  const importPath = './' + rel.replace(/\\/g, '/');
  const code = [
    "import { LanguageProvider } from './i18n';",
    `import Comp from '${importPath}';`,
    'export default function Probe(p) { return <LanguageProvider><Comp {...p} /></LanguageProvider>; }',
  ].join('\n');
  const built = esbuild.buildSync({
    stdin: { contents: code, resolveDir: SRC, sourcefile: `__render_helper_${Date.now()}.jsx`, loader: 'jsx' },
    bundle: true,
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    define: { 'process.env.NODE_ENV': '"development"' },
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.jsx': 'jsx', '.tsx': 'tsx', '.js': 'jsx', '.mjs': 'jsx', '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
    write: false,
    logLevel: 'silent',
  });
  const moduleObj = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', built.outputFiles[0].text);
  fn(rendererRequire, moduleObj, moduleObj.exports, path.join(SRC, rel), path.join(SRC, path.dirname(rel)));
  const React = rendererRequire('react');
  const { renderToStaticMarkup } = rendererRequire('react-dom/server');
  return renderToStaticMarkup(React.createElement(moduleObj.exports.default, props));
}

/** 数一段 HTML 里被点亮的一级入口数（NavItem 的选中态锚点） */
export function countAriaCurrent(html) {
  return (html.match(/aria-current="page"/g) || []).length;
}
