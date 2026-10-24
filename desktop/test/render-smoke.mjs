// 渲染层「首帧渲染」冒烟：在 Node 里真正渲染一遍 <App />，让启动白屏在 CI 就炸出来
//
// 背景（连续两次真机启动白屏，都发生在组件函数体执行期间）：
//   ① App.jsx：useEffect 依赖数组引用后置声明的 activeProject → TDZ
//      「Cannot access 'activeProject' before initialization」
//   ② ChatArea.jsx：Composer 体内引用父组件局部变量 decomposing
//      →「decomposing is not defined」
// 两次的共同点：语法正确、模块能加载、tsc 不覆盖 .jsx —— smoke-load 只做
//「模块顶层求值」，从不执行组件函数体，所以两次都全绿放行。
//
// 做法：用 esbuild 把 JSX 编成 CJS（沿用 smoke-load 的加载器与浏览器 API 桩），
//   再用 react-dom/server 的 renderToStaticMarkup 真正渲染 App。
//   组件函数体一旦抛错（TDZ / 跨作用域引用 / props 未定义）这里立刻失败。
//   渲染期不跑 useEffect，因此副作用（fetch / ipc）不会干扰。
//
// 用法：node test/render-smoke.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer/src');
const esbuild = require(path.join(DESKTOP, 'renderer/node_modules/esbuild'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 浏览器 API 桩（与 smoke-load 保持一致）──
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
// 关键：mj_onboarded 必须给 '1'。App 在未 onboard 时会渲染首启向导而非主界面，
// 侧栏/对话区压根不渲染，白屏防线就形同虚设。（登录系统已移除，无 mj_token）
const storage = {
  getItem: (k) => (k === 'mj_onboarded' ? '1' : null),
  setItem: noop, removeItem: noop, clear: noop,
};
define('window', {
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  location: { href: 'http://localhost/' },
  mjcode: undefined, localStorage: storage, sessionStorage: storage,
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

// ── JSX → CJS 加载器 ──
const { createRequire: makeRequire } = await import('node:module');
const rendererRequire = makeRequire(path.join(DESKTOP, 'renderer/package.json'));

// S5（批次 3-3）：探针**一律不落盘**。
// 原实现把临时 entry 写进 `renderer/src/__i18n_probe_N.jsx` 再删；两个后果：
//   ① 并发跑两个 npm test 时会互删同名探针（固定名 `__tdz_probe.jsx`/`__scope_probe.jsx` 必撞），
//      表现为 ENOENT / legacy-ledger 现算失真；
//   ② 被 SIGKILL 或超时杀掉时 `finally` 不执行 ⇒ 探针永久留在源码树（.gitignore 只能防提交，防不住残留）。
// 改用 esbuild 的 stdin + resolveDir：源码字符串在内存里编译，模块解析仍以 SRC 为基准，
// 因此 `import './i18n'`、`./App.jsx` 这些相对解析照常工作，磁盘上不产生任何文件。
const ESBUILD_BASE = {
  bundle: true,
  // react / react-dom 保持外部：必须与测试里用的 React 是同一实例，
  // 否则 hooks dispatcher 不共享 → "Invalid hook call"
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"development"' }, // 保留 React 开发态告警
  format: 'cjs',
  // 关键：必须 browser 平台。node/neutral 平台 esbuild 会生成 __toESM(mod, 1)，
  // 其 node 模式语义强制把 default 指向整个模块对象（再跳过真实 default 的拷贝），
  // 于是 `import Sidebar from './Sidebar'` 拿到的是 namespace 对象而非组件函数，
  // 渲染时报「Element type is invalid ... got: object」——纯属加载器伪影。
  // browser 平台生成 __toESM(mod)，命中 __esModule 分支后正确拷贝真实 default。
  platform: 'browser',
  jsx: 'automatic',
  // 静态资源：logo.png 等以 dataurl 内联（组件里当 img src 用），
  // 样式文件以 empty 忽略（渲染冒烟不关心样式，只要 import 不炸）
  loader: { '.jsx': 'jsx', '.tsx': 'tsx', '.js': 'jsx', '.mjs': 'jsx', '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
  // themes.json 等走 esbuild 默认 json loader
  write: false,
  logLevel: 'silent',
};

function compile(rel) {
  const abs = path.join(SRC, rel);
  const result = esbuild.buildSync({
    ...ESBUILD_BASE,
    entryPoints: [abs],
  });
  return result.outputFiles[0].text;
}

/**
 * 内存版编译：源码字符串直接在内存里 bundle，磁盘零落盘（S5 的核心改动）。
 * `resolveDir` 决定相对 import 的解析基准——必须是 SRC，否则 `./i18n`、`./App.jsx` 解析不到。
 * `sourcefile` 只用于报错信息里的文件名（不写盘）。
 */
function compileInline(code, sourcefile) {
  const result = esbuild.buildSync({
    ...ESBUILD_BASE,
    stdin: { contents: code, resolveDir: SRC, sourcefile, loader: 'jsx' },
  });
  return result.outputFiles[0].text;
}

// 单个组件 ← bundle 成 CJS 后求值。
// 关键：必须 bundle:true。bundle:false 时 esbuild 对 "./ThreadList" 这类
// 无扩展名 specifier 生成 __toESM(mod, 1)（node 模式），其语义强制
// default = 整个模块对象并跳过真实 default 的拷贝 —— 结果 import 到的是
// namespace 对象而不是组件函数，渲染时报「Element type is invalid ... got: object」。
// 打包后 esbuild 明确知道依赖是 ESM，interop 才是正确的。
const loaded = new Map();

function evalBundle(bundleCode, rel) {
  const moduleObj = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', bundleCode);
  fn(rendererRequire, moduleObj, moduleObj.exports, path.join(SRC, rel), path.join(SRC, path.dirname(rel)));
  return moduleObj.exports;
}

function loadModule(rel) {
  if (loaded.has(rel)) return loaded.get(rel);
  const mod = evalBundle(compile(rel), rel);
  loaded.set(rel, mod);
  return mod;
}

/** 加载内存里编译的探针（S5）：磁盘零落盘，`rel` 仅作缓存键与报错文件名。 */
function loadInline(code, rel) {
  if (loaded.has(rel)) return loaded.get(rel);
  const mod = evalBundle(compileInline(code, rel), rel);
  loaded.set(rel, mod);
  return mod;
}

const React = rendererRequire('react');
const { renderToStaticMarkup } = rendererRequire('react-dom/server');

// ── T3-2 i18n 适配 ──
// esbuild bundle:true 下每个 entry 各带一份 i18n 实例（模块单例不共享），
// 语言包必须经 globalThis 注入让所有实例读到同一份；渲染统一包 LanguageProvider
// （组件用 useI18n，缺 Provider 会抛——真机 main.jsx 已挂，此处对齐）。
function loadPacksFromDisk() {
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
  return packs;
}
globalThis.__MJ_I18N_PACKS__ = loadPacksFromDisk();

// esbuild bundle:true 下 App 的 bundle 自带一份 i18n 实例（createContext 各自独立），
// 测试侧 loadModule 的 LanguageProvider 与组件内 useI18n 不是同一 Context——
// 必须用临时 wrapper entry 把 Provider 与目标组件编进同一个 bundle。
let probeSeq = 0;
function renderWithI18n(compRel, props) {
  const tmpRel = `__i18n_probe_${++probeSeq}.jsx`;
  const importPath = './' + compRel.replace(/\\/g, '/');
  const code = [
    "import { LanguageProvider } from './i18n';",
    `import Comp from '${importPath}';`,
    'export default function Root(props) {',
    '  return <LanguageProvider><Comp {...props} /></LanguageProvider>;',
    '}',
  ].join('\n');
  try {
    const mod = loadInline(code, tmpRel);
    assert.equal(typeof mod.default, 'function', `${compRel} 的 i18n wrapper 未导出默认组件`);
    return renderToStaticMarkup(React.createElement(mod.default, props));
  } finally {
    loaded.delete(tmpRel); // 只是清编译缓存，磁盘上从来没有这个文件
  }
}

check('渲染冒烟：App 首帧可渲染（启动白屏防线）', () => {
  let html = '';
  // 渲染期不执行 useEffect，因此 ipc / fetch 等副作用不会触发；
  // 组件函数体本身（含 hook 依赖数组求值）会完整跑一遍 —— 白屏事故正出在这里
  assert.doesNotThrow(() => { html = renderWithI18n('App.jsx', {}); },
    'App 首帧渲染抛错（真机即白屏）');
  assert.ok(html.length > 200, `渲染结果过短（${html.length} 字符），疑似未渲染出界面`);
  // 覆盖度自证：必须真的渲染到了 Composer（输入框）。
  // 否则 App 一旦退化成「探测中」占位页，这道门禁会静默失效 —— 两次白屏都出在深层组件。
  assert.ok(html.includes('输入你想做什么'), '首帧未渲染到 Composer 输入框，冒烟覆盖面不足');
  console.log(`       首帧 HTML ${html.length} 字符（含 Composer 输入框）`);
});

check('渲染冒烟：侧栏 / 工作区条 / 审批卡可独立渲染', () => {
  const targets = [
    ['components/Sidebar.jsx', { threads: [], projects: [], activeThread: null, activeProject: null, onSelect: noop }],
    ['components/WorktreeBar.jsx', { worktree: null, onClosed: noop, onMsg: noop }],
    ['components/ApprovalCard.jsx', { req: null, onDecision: noop }],
  ];
  const failures = [];
  for (const [rel, props] of targets) {
    try {
      renderWithI18n(rel, props);
    } catch (e) {
      failures.push(`${rel} → ${String(e.message).split('\n')[0]}`);
    }
  }
  assert.equal(failures.length, 0, `\n       ${failures.join('\n       ')}`);
});

check('渲染冒烟：脏 localStorage（enabledSkills 非数组）不得让首帧崩溃', () => {
  // 事故背景：设置页曾把 setEnabledSkills 当刷新回调无参调用，MarketModal 回传的
  // plugin 对象被直接存进 mj_enabled_skills 并持久化 → enabledSkills.filter 崩溃，
  // 且每次重启都崩（持久化脏数据）。守卫修复后，脏数据必须回落默认技能列表。
  const dirtyStorage = {
    getItem: (k) => {
      if (k === 'mj_onboarded') return '1';
      if (k === 'mj_enabled_skills') return '{"code_review":true}'; // 非数组脏数据
      return null;
    },
    setItem: noop, removeItem: noop, clear: noop,
  };
  define('localStorage', dirtyStorage);
  define('sessionStorage', dirtyStorage);
  try {
    let html = '';
    assert.doesNotThrow(() => { html = renderWithI18n('App.jsx', {}); },
      'enabledSkills 脏数据导致首帧崩溃');
    assert.ok(html.length > 200, `渲染结果过短（${html.length} 字符）`);
  } finally {
    define('localStorage', storage);
    define('sessionStorage', storage);
    loaded.delete('App.jsx'); // 下一个用例重新加载，用干净 storage
  }
});

// 门禁自检：故意写崩的组件必须被抓出来（否则这道门禁是摆设）
check('门禁自检：能复现 TDZ 白屏（依赖数组引用后置声明）', () => {
  const bad = `
    import { useState, useEffect } from 'react';
    export default function Bad() {
      const [a, setA] = useState(0);
      useEffect(() => { setA(1); }, [a, later]);
      const later = 1;
      return <div>{a}</div>;
    }
  `;
  const Bad = loadInline(bad, '__tdz_probe.jsx').default;
  try {
    assert.throws(() => renderToStaticMarkup(React.createElement(Bad)), /later/,
      'TDZ 事故未被渲染冒烟抓出');
  } finally { loaded.delete('__tdz_probe.jsx'); }
});

check('门禁自检：能复现跨作用域白屏（子组件引用父组件局部变量）', () => {
  const bad = `
    import { useState } from 'react';
    export default function Parent() {
      const [decomposing] = useState(false);
      return <Child />;
    }
    function Child() {
      return <div>{decomposing ? 'y' : 'n'}</div>;
    }
  `;
  const P = loadInline(bad, '__scope_probe.jsx').default;
  try {
    assert.throws(() => renderToStaticMarkup(React.createElement(P)), /decomposing/,
      '跨作用域事故未被渲染冒烟抓出');
  } finally { loaded.delete('__scope_probe.jsx'); }
});

// C1（2026-10-17）：MessageStream 的「输出文件卡片」必须能渲染。
// 事故形态：组件里用了 <IconFile>，但文件顶部 import 列表漏了它，
//   而该文件带 @ts-nocheck → tsc 不报「未定义标识符」→ 门禁全绿放行。
//   只有消息里出现产出文件时才走到那段 JSX，长任务收尾整页被 ErrorBoundary 接走 =
//   用户看到「app 崩了」。真实证据：diagnostics/crash-2026-10-17.jsonl 两条 rendererError。
// 这条用例是**唯一**能在 CI 期拦住同类漏 import 的防线：渲染期会真正执行组件函数体。
check('渲染冒烟：消息里的「输出文件卡片」可渲染（漏 import 会在此炸出）', () => {
  const props = {
    messages: [{ id: 'm1', role: 'assistant', content: '已完成修复，产出以下文件。' }],
    windowStart: 0,
    onLoadEarlier: noop,
    loading: false,
    toolCalls: [],
    reasoningText: '',
    streamingText: '',
    runSummary: '',
    runUsage: { tokensIn: 100, tokensOut: 50 },
    runStartedAt: Date.now() - 5000,
    contextUsage: null,
    model: 'probe-model',
    runFiles: ['/tmp/probe-output/report-fix.md'],
    onOpenFile: noop,
  };
  let html = '';
  assert.doesNotThrow(() => { html = renderWithI18n('components/MessageStream.tsx', props); },
    'MessageStream 渲染输出文件卡片抛错（真机表现：整页被 ErrorBoundary 换成崩溃页）');
  assert.ok(html.includes('report-fix.md'), '未渲染出产出文件名，说明 RunOutputFiles 分支没走到');
});

// T1（2026-10-17）：运行中必须能看到「已思考 Ns」，否则用户以为卡死会按 Esc 杀任务
check('渲染冒烟：运行中的思考态带计时（减少误以为卡死）', () => {
  const props = {
    messages: [],
    windowStart: 0,
    onLoadEarlier: noop,
    loading: true,
    toolCalls: [],
    reasoningText: '正在分析代码结构…',
    streamingText: '',
    runSummary: '',
    runUsage: null,
    runStartedAt: Date.now() - 12000,
    contextUsage: null,
    model: 'probe-model',
    runFiles: [],
    onOpenFile: noop,
  };
  const html = renderWithI18n('components/MessageStream.tsx', props);
  assert.ok(/已思考\s*1[0-9]s/.test(html), `未渲染出「已思考 Ns」计时：${html.slice(0, 200)}`);
  assert.ok(/已收\s*\d+\s*字/.test(html), '未渲染出「已收 N 字」');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
