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
  loader: { '.jsx': 'jsx', '.tsx': 'tsx', '.js': 'jsx', '.mjs': 'jsx', '.png': 'dataurl', '.mp3': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
  write: false, logLevel: 'silent',
  stdin: {
    contents: [
      "import { LanguageProvider } from './i18n';",
      "import Onboarding from './components/Onboarding.jsx';",
      // MD2：必填项判据一并从同一 bundle 导出——与组件走**同一份**模块实例，
      // 避免测试另起一条编译路径（那样测到的可能是磁盘上一份、运行时另一份）。
      "export { missingRequiredFields, REQUIRED_PROVIDER_FIELDS } from './lib/onboardingForm';",
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
const { render, missingRequiredFields, REQUIRED_PROVIDER_FIELDS } = moduleObj.exports;
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

// ═════════════════════════════════════════════════════════════════════════════
// MD2（2026-11-05）：去假 Key —— 首启闭环
// ═════════════════════════════════════════════════════════════════════════════
// 缺陷形态：`submitCustomProvider` 的必填判据是四联 `!form.name || !form.base_url
//   || !form.api_key || !form.model_id`。本机回环端点（Ollama / LM Studio / vLLM）
//   **没有 Key 可填** ⇒ 保存被永久挡住，唯一出路是「跳过，稍后配置」⇒ 向导走完却没有
//   一个能发消息的模型。主进程侧那套「本机免 Key」改造对新用户因此完全不可达。
// 修法：必填项收敛为存库三要素（name/base_url/model_id），Key 有无交主进程裁决
//   （localModel.credentialUsable 复用 streamGuard.isLocalEndpoint，单一事实来源）。
//   渲染层**不**复制端点正则 —— 复制出来就是第二个事实来源，漂移表现正是
//   「向导放行、一发消息被拒」这类最难排查的错位。
const FORM_TS = path.join(SRC, 'lib', 'onboardingForm.ts');
const ONBOARDING_JSX = path.join(SRC, 'components', 'Onboarding.jsx');

check('MD2：本机回环端点未填 Key 也能存（原先被 !form.api_key 挡死）', () => {
  const missing = missingRequiredFields({
    name: 'Ollama', base_url: 'http://127.0.0.1:11434/v1', api_key: '', model_id: 'qwen2.5:7b',
  });
  assert.deepEqual(missing, [], `本机无 Key 应可保存，实际缺失 ${JSON.stringify(missing)}`);
  assert.ok(!REQUIRED_PROVIDER_FIELDS.includes('api_key'),
    'api_key 不得出现在存库必填项里（要不要 Key 由主进程按端点判）');
});

check('MD2：远端未填 Key 同样不在表单层拦（裁决权在主进程，不在 UI）', () => {
  // 刻意断言「表单放行」：若这里改成渲染层自己判端点，就会与主进程判据漂移。
  // 真正的拒绝发生在 chatStreamOnce，文案已写明「本机端点无需 Key」。
  const missing = missingRequiredFields({
    name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model_id: 'deepseek-chat',
  });
  assert.deepEqual(missing, [], '表单层不应因缺 Key 拦下远端配置');
});

check('MD2：存库三要素仍逐个必填（放宽 Key 不等于放开校验）', () => {
  // 逐项缺一，精确断言「缺的是哪个」——只断 length>0 会把三项互相掩盖
  const full = { name: 'X', base_url: 'http://127.0.0.1:8080/v1', model_id: 'm' };
  for (const k of REQUIRED_PROVIDER_FIELDS) {
    const missing = missingRequiredFields({ ...full, [k]: '' });
    assert.deepEqual(missing, [k], `缺 ${k} 时应当且仅当报 ${k}，实际 ${JSON.stringify(missing)}`);
  }
  assert.equal(REQUIRED_PROVIDER_FIELDS.length, 3, '必填项应为三项（新增/删减须同步本断言与文档）');
});

check('MD2：纯空白等同未填（原判据 !form.x 会把 "   " 当已填）', () => {
  const missing = missingRequiredFields({
    name: '   ', base_url: '  http://127.0.0.1:8080/v1  ', model_id: '\t',
  });
  assert.deepEqual(missing, ['name', 'model_id'], `空白应判未填，实际 ${JSON.stringify(missing)}`);
  // 前后空白不该导致误判（地址两侧带空格是复制粘贴的常见形态）
  assert.deepEqual(missingRequiredFields({ name: ' n ', base_url: ' u ', model_id: ' m ' }), []);
});

check('MD2：接线——组件真的调用该判据，且不再自行拦 api_key', () => {
  // 纯函数有断言 ≠ 调用点被覆盖：必须同时确认组件那一层用的是它、且旧的错误条件已删。
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const code = blankComments(fs.readFileSync(ONBOARDING_JSX, 'utf8'));
  assert.ok(fs.existsSync(FORM_TS), 'onboardingForm.ts 必须存在（断言所测模块即上架模块）');
  assert.ok(/from\s+['"]\.\.\/lib\/onboardingForm['"]/.test(code),
    'Onboarding.jsx 必须从 ../lib/onboardingForm 引入（换成别处同名函数即为漂移）');
  assert.ok(/missingRequiredFields\s*\(/.test(code),
    'Onboarding.jsx 必须调用 missingRequiredFields（否则纯函数再对也不生效）');
  assert.ok(!/!\s*form\.api_key/.test(code),
    'Onboarding.jsx 不得再出现 !!form.api_key 判据（会把无 Key 的本机用户永久挡住）');
});

check('自检：上一条守卫不是恒真（样例含缺陷时必须命中，注释不得满足它）', () => {
  // 「验证器先被验证」：若正则写错/空白化失效，上一条会永久通过而无人在测。
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const SAMPLE_BAD = 'function f(form) {\n  if (!form.name || !form.api_key) { return; }\n}';
  assert.ok(/!\s*form\.api_key/.test(blankComments(SAMPLE_BAD)),
    '守卫自检失败：含缺陷的样例未被命中，说明正则或 blankComments 失效');
  const SAMPLE_COMMENT_ONLY = '// 旧写法是 !form.api_key\nfunction f(form) { return !!form.name; }';
  assert.ok(!/!\s*form\.api_key/.test(blankComments(SAMPLE_COMMENT_ONLY)),
    '注释里提到旧写法不得被判为缺陷（否则会逼人删掉解释性注释）');
});

console.log(`\n${pass}/${total} 通过`);
