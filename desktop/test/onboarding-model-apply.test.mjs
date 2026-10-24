// FIX-P07 的另一半：向导选定的模型必须真的成为首聊的当前模型（RB-1 / D2）
//
// 背景：首启向导「配置模型」步现在能选本机已配置的模型（covered by
// test/onboarding-local-models.test.mjs）。但「选完有没有生效」是另一条链：
//   Onboarding.finish() → onFinish(chosen, { model: {providerId, modelId} })
//     → App.jsx 的 onFinish 里 `if (extras?.model) setSelectedModel(pickOnboardingModel(...) || selectedModel)`
//     → 首聊用这个模型。
// 这条链此前零自动化覆盖：App.jsx 不进任何测试、pickOnboardingModel 全仓无引用。
// 于是「删掉那行回写」不会让任何门禁变红——正是「界面高亮但没生效」的复发口子。
//
// 本套件两层：
//   ① pickOnboardingModel 纯函数行为（6 类边界）；
//   ② App.jsx 回写接线的**真实表达式**求值：从源码里抽出那一条 if 语句，注入假依赖执行，
//      断言「解析得到 ⇒ 调用 setSelectedModel」「解析不到 ⇒ 不调用（保持原选择）」。
//      —— 只写正则会在「其实没调用」时假绿；求值会在删掉调用时直接红（已实测变异）。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer/src');
// appState.ts 是 TS：用渲染层自带的 esbuild 打成 CJS 再加载（与 thread-models.test.js 同法）
const rendererRequire = createRequire(path.join(DESKTOP, 'renderer/package.json'));
const esbuild = rendererRequire('esbuild');

let pass = 0, total = 0;
// 必须支持 async 用例：同步 check 会把 async fn 的 reject 漏成 unhandled rejection
// （实测：断言在 PASS 打印之后才抛出、进程崩但汇总已显示「10/10 通过」——假绿）。
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const built = esbuild.buildSync({
  entryPoints: [path.join(SRC, 'lib/appState.ts')],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ts': 'ts', '.tsx': 'tsx', '.js': 'jsx', '.css': 'empty', '.json': 'json' },
});
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('require', 'module', 'exports', built.outputFiles[0].text)(rendererRequire, mod, mod.exports);
const { pickOnboardingModel } = mod.exports;

const PROVIDERS = [
  { id: 'p1', name: 'LocalDeepSeek', base_url: 'https://api.deepseek.com/v1', models: [{ model_id: 'deepseek-chat' }, { model_id: 'deepseek-reasoner' }] },
  { id: 'p2', name: 'LocalQwen', base_url: 'https://dashscope.aliyuncs.com/v1', models: [{ model_id: 'qwen-max' }] },
];

// ── ① 纯函数行为 ────────────────────────────────────────────────────────
await check('① 本地模式有 userProviders：命中 provider/model，返回 selectedModel 形状（同一对象引用）', () => {
  const r = pickOnboardingModel(PROVIDERS, { providerId: 'p1', modelId: 'deepseek-reasoner' });
  assert.ok(r, '应解析成功');
  assert.equal(r.provider.id, 'p1');
  assert.equal(r.model.model_id, 'deepseek-reasoner');
  // 必须是列表里的**同一引用**，不是重新构造的副本：下游按引用比较/记忆，
  // 复制一份会让「选中态」与列表里的那一项脱钩（记忆键、rememberModel 都对不上）。
  assert.equal(r.provider, PROVIDERS[0], 'provider 应是列表里的同一对象引用');
  assert.equal(r.model, PROVIDERS[0].models[1], 'model 应是列表里的同一对象引用');
});

await check('① 无 provider（null / 空数组 / undefined）：返回 null，不构造半截模型', () => {
  for (const p of [null, undefined, []]) {
    assert.equal(pickOnboardingModel(p, { providerId: 'p1', modelId: 'deepseek-chat' }), null, `providers=${JSON.stringify(p)}`);
  }
});

await check('① 模型列表为空 / 字段缺失：返回 null', () => {
  const cases = [
    [{ id: 'p1', models: [] }],
    [{ id: 'p1' }],
    [{ id: 'p1', models: null }],
    [{ id: 'p1', models: 'not-an-array' }],
  ];
  for (const providers of cases) {
    assert.equal(pickOnboardingModel(providers, { providerId: 'p1', modelId: 'x' }), null, JSON.stringify(providers));
  }
});

await check('① 选中值不在列表内：返回 null（调用方保持原选择，不静默切到别的模型）', () => {
  assert.equal(pickOnboardingModel(PROVIDERS, { providerId: 'p1', modelId: 'no-such-model' }), null, '模型不存在');
  assert.equal(pickOnboardingModel(PROVIDERS, { providerId: 'no-such-provider', modelId: 'qwen-max' }), null, 'provider 不存在');
  // 关键反向：不得「跨 provider 捞一个同名/第一个模型」——那会把用户选的模型换成别人的
  assert.equal(pickOnboardingModel(PROVIDERS, { providerId: 'p2', modelId: 'deepseek-chat' }), null, '不得跨 provider 命中');
});

await check('① 多 provider：按 id 命中，与列表顺序无关（顺序颠倒结果一致）', () => {
  const a = pickOnboardingModel(PROVIDERS, { providerId: 'p2', modelId: 'qwen-max' });
  const b = pickOnboardingModel([...PROVIDERS].reverse(), { providerId: 'p2', modelId: 'qwen-max' });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(a.provider.id, 'p2');
  assert.equal(a.model.model_id, 'qwen-max');
});

await check('① 空字符串 / 缺字段的选择：返回 null（不把 "" 当成有效 id）', () => {
  const cases = [
    { providerId: '', modelId: 'deepseek-chat' },
    { providerId: 'p1', modelId: '' },
    { providerId: 'p1' },
    { modelId: 'deepseek-chat' },
    null,
    undefined,
  ];
  for (const picked of cases) {
    assert.equal(pickOnboardingModel(PROVIDERS, picked), null, JSON.stringify(picked));
  }
});

// ── ② Onboarding.finish() 的出口：extras.model 必须带出选中值 ────────────
// 为什么抽源码求值而不是只读源码：finish() 里有一串副作用（技能物化 / 连接器启用态 / 专家模板），
// 真正要钉的是「它最后交给 onFinish 的 extras 里 model 是什么」。求值能验到值，正则只能验到字面。
const ONB_SRC = fs.readFileSync(path.join(SRC, 'components/Onboarding.jsx'), 'utf8');

function matchBrace(src, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) break; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 抽出 Onboarding 组件里的 `async function finish()` 源码。抽不到即红（=调用被删/改形）。 */
function extractFinishSource() {
  const at = ONB_SRC.indexOf('async function finish(');
  assert.ok(at > 0, 'Onboarding.jsx 里找不到 async function finish()（结构变了就要同步本抽取器）');
  const open = ONB_SRC.indexOf('{', at);
  const end = matchBrace(ONB_SRC, open);
  assert.ok(end > open, 'finish() 函数体括号未配对');
  // ── 窗口边界的形态不变量：必须由两条**互相独立**的路径算出来并一致（与 stop-thread-work 同款）──
  // A = 括号配对（跳字符串/模板串/注释）；B = 缩进层级（不跳任何东西，只看行首）。
  // A 一旦漏跳字符串或注释 ⇒ 深度溢出 ⇒ 配对点滑到后面某个 `}` ⇒ 窗口**外扩**吞掉后面的函数体。
  // 这时下面两条内容断言（src 含 onFinish?. / model:）照样全中，
  // 而求值能不能炸取决于外扩片段凑巧语法合不合法 —— OVR-2 实测过：外扩后 `new Function`
  // 抛 SyntaxError 才让它红了。**那是被求值崩溃拦住的（第 2 类），不是被断言拦住的**，
  // 换个代码布局让外扩片段语法仍合法，它就全绿。故必须补这条形态不变量。
  const lineStart = ONB_SRC.lastIndexOf('\n', at) + 1;
  const indent = ONB_SRC.slice(lineStart, at); // `async function finish(` 所在行的缩进
  const closeAt = ONB_SRC.indexOf(`\n${indent}}`, at);
  assert.ok(closeAt > at, `找不到缩进层 ${JSON.stringify(indent)} 的闭合花括号（finish() 的缩进层级变了？）`);
  const endByIndent = closeAt + 1 + indent.length;
  assert.equal(end, endByIndent,
    `finish() 抽取窗口的两条路径不一致：括号配对算到 ${end}，缩进层级算到 ${endByIndent}`
    + `（多半是配对漏跳了字符串/注释导致窗口外扩，抽到的已经不是 finish() 自己的函数体）`);
  const src = ONB_SRC.slice(at, end + 1);
  assert.ok(src.includes('onFinish?.'), `finish() 里没有 onFinish 调用：${src.slice(0, 120)}`);
  assert.ok(src.includes('model:'), `finish() 的 extras 里没有 model（向导选定的模型不会回写）：${src.slice(0, 200)}`);
  return src;
}

/** 在 Node 里执行 finish()：注入它引用的全部绑定，收 onFinish 的实参。 */
async function runFinish(overrides = {}) {
  const deps = {
    finishing: false,
    setFinishing: () => {},
    pickedSkills: [],
    pickedConnectors: [],
    connectors: [],
    employees: [],
    pickedEmployee: null,
    chosen: '首任务',
    onFinish: () => {},
    selectedLocal: null,
    loadEnabledFromLocal: () => ({}),
    setConnectorEnabledLocal: (s) => s,
    saveEnabledToLocal: () => {},
    ...overrides,
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `return (${extractFinishSource()});`)(...names.map((n) => deps[n]));
  await fn();
  return deps;
}

await check('② Onboarding.finish()：选中本机模型 ⇒ onFinish 的 extras.model = {providerId, modelId}', async () => {
  const calls = [];
  await runFinish({
    onFinish: (prompt, extras) => calls.push({ prompt, extras }),
    selectedLocal: { providerId: 'p1', modelId: 'deepseek-reasoner' },
  });
  assert.equal(calls.length, 1, `onFinish 应被调用 1 次，实际 ${calls.length}`);
  assert.deepEqual(calls[0].extras.model, { providerId: 'p1', modelId: 'deepseek-reasoner' },
    `extras.model 不对：${JSON.stringify(calls[0].extras.model)}`);
  assert.equal(calls[0].prompt, '首任务', 'chosen 应原样带给 App');
});

await check('② Onboarding.finish()：未选本机模型（跳过）⇒ extras.model = null（不回写半截值）', async () => {
  const calls = [];
  await runFinish({ onFinish: (prompt, extras) => calls.push({ prompt, extras }), selectedLocal: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].extras.model, null, `未选模型时不应带半截 model：${JSON.stringify(calls[0].extras.model)}`);
});

// ── ③ App.jsx 回写接线（执行真实表达式，不是正则匹配）────────────────────
const APP_SRC = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');

/** 从 App.jsx 抽出「向导选定模型 → setSelectedModel」那段语句。抽不到就红（=调用被删）。 */
function extractApplyStatement() {
  const lines = APP_SRC.split('\n');
  const hit = lines.findIndex((l) => l.includes('pickOnboardingModel(') && l.includes('setSelectedModel('));
  assert.ok(hit >= 0, 'App.jsx 里找不到 `setSelectedModel(pickOnboardingModel(...))` —— 向导选定的模型不会成为首聊模型');
  // 去掉行尾注释后应当是一段以 `;` 结尾的完整语句（允许同一行写两条语句）
  const code = lines[hit].replace(/\s*\/\/.*$/, '').trim();
  assert.ok(code.endsWith(';'), `抽到的行不是完整语句：${code}`);
  assert.ok(/pickOnboardingModel\(userProviders,\s*extras\?\.model\)/.test(code.replace(/\s+/g, ' ')),
    `向导模型的取值来源变了（应仍是 extras?.model 经 pickOnboardingModel 解析）：${code}`);
  return code;
}

/** 执行抽到的语句：注入 extras / userProviders / selectedModel / setSelectedModel / pickOnboardingModel。 */
function runApplyStatement({ extras, userProviders, selectedModel = { provider: { id: 'cur' }, model: { model_id: 'current' } } }) {
  const stmt = extractApplyStatement();
  const calls = [];
  // eslint-disable-next-line no-new-func
  new Function('extras', 'userProviders', 'selectedModel', 'setSelectedModel', 'pickOnboardingModel', stmt)(
    extras, userProviders, selectedModel, (v) => calls.push(v), pickOnboardingModel);
  return calls;
}

await check('③ 接线：extras.model 有效 ⇒ 真的调用 setSelectedModel（新模型生效）', () => {
  const calls = runApplyStatement({ extras: { model: { providerId: 'p1', modelId: 'deepseek-chat' } }, userProviders: PROVIDERS });
  assert.equal(calls.length, 1, `setSelectedModel 应被调用 1 次，实际 ${calls.length}`);
  assert.equal(calls[0].provider.id, 'p1');
  assert.equal(calls[0].model.model_id, 'deepseek-chat');
});

await check('③ 接线：解析不到 ⇒ 不调用 setSelectedModel（保持原选择，不切到 null）', () => {
  const bad = [
    { extras: {}, userProviders: PROVIDERS },                                                    // 未选模型
    { extras: { model: null }, userProviders: PROVIDERS },                                       // 显式 null
    { extras: { model: { providerId: 'ghost', modelId: 'x' } }, userProviders: PROVIDERS },       // provider 不存在
    { extras: { model: { providerId: 'p1', modelId: 'ghost' } }, userProviders: PROVIDERS },      // 模型不存在
    { extras: { model: { providerId: 'p1', modelId: 'deepseek-chat' } }, userProviders: [] },     // 本机无 provider
  ];
  for (const args of bad) {
    const calls = runApplyStatement(args);
    assert.equal(calls.length, 0, `不应调用 setSelectedModel：${JSON.stringify(args.extras)}`);
  }
});

console.log(`\n${pass}/${total} 通过`);
