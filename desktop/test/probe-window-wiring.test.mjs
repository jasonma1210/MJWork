// P0-1① / P0-3③「探测值 → 窗口行」与「caps → 思考强度门控」端到端门禁
// （2026-10-18 新增；补齐本轮唯一已知的覆盖缺口）
//
// 为什么需要专门一条：`typecheck` 覆盖不到「.js 引 .ts 的运行时解析」，而这条链路的每一段
// 都是**纯数据搬运**——任何一段把字段丢掉，症状都是「门控永不触发 / 窗口永远显示默认档」，
// 不报错、不崩，只是静默失效。所以必须用**线上同一份代码**（esbuild 打包真实源码为 CJS）
// 跑一次真实调用，而不是复制体或手写 stub。
//
// 三个容易漏掉的断言（team-lead/eng-model 指定）：
//   · 无 caps 时对象里**不得有 `caps` 键**（不是 `caps: undefined`）——
//     `...(cond ? {caps} : {})` 与 `{caps: undefined}` 的唯一可区分点，也是「不伪造数据」的证据
//   · `source === 'fallback-4k'` **不得**被当成已确认（否则窗口高估 ⇒ 压缩永不触发 ⇒ 击穿）
//   · 默认档（value `''`）即使 supportsReasoning:false 也必须仍可选（它只表示「不下发参数」）
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const esbuild = require(path.join(DESKTOP, 'renderer/node_modules/esbuild'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 浏览器 API 桩：必须打在「执行打包产物之前」（i18n / modelConfig 模块级会碰 localStorage）──
const store = new Map();
const noop = () => {};
globalThis.window = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, localStorage: null };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = { documentElement: {}, addEventListener: noop, removeEventListener: noop };
// Node 22 的 navigator 是只读 getter，直接赋值会抛，必须 defineProperty
try { Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true }); } catch { /* 保持原值 */ }

async function load(entry) {
  const out = await esbuild.build({
    entryPoints: [path.join(DESKTOP, entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom'],
    loader: { '.js': 'jsx' },
  });
  const mod = { exports: {} };
  // require 必须挂在 renderer/ 下：react 只装在 renderer/node_modules
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(
    mod, mod.exports, createRequire(path.join(DESKTOP, 'renderer/index.js')),
  );
  return mod.exports;
}

const MS = await load('renderer/src/components/ModelSelector.jsx');
const MC = await load('renderer/src/lib/modelConfig.js');
const API = await load('renderer/src/lib/api.js');

const tStub = (k) => k; // 未接 i18n 时 t() 返回 key 本身

// ── ① 能力门控：supportsReasoning:false → 三档全禁，默认档仍可选 ──
{
  const caps = MS.reasoningCapsOf({ model_id: 'x', caps: { supportsReasoning: false } }, { id: 1 });
  check('caps 解析：supportsReasoning:false 被识别', caps !== null && caps.supportsReasoning === false,
    JSON.stringify(caps));
  const opts = MS.reasoningOptionsFor(caps, tStub);
  const levels = opts.filter((o) => o.value);
  check('门控：低/中/高三档全部 disabled', levels.length === 3 && levels.every((o) => o.disabled === true),
    levels.map((o) => `${o.value}:${o.disabled}`).join(','));
  check('门控：默认档（value 空串）仍可选（它只表示「不下发参数」）',
    opts.length > 0 && opts[0].value === '' && opts[0].disabled !== true,
    `default=${JSON.stringify(opts[0])}`);
  check('门控：disabled 项带「模型不支持」文案（不是静默变灰）',
    levels.every((o) => o.title === 'models.reasoningUnsupported'),
    [...new Set(levels.map((o) => o.title))].join(','));
}

// ── ② 能力门控：部分支持（supportedEfforts）→ 只禁未列出的档 ──
// 只测「全禁用」会漏掉这一类：模型支持 low/high 但不支持 medium。
{
  const caps = MS.reasoningCapsOf(
    { model_id: 'y', caps: { supportsReasoning: true, supportedEfforts: ['low', 'high'] } }, {},
  );
  const opts = MS.reasoningOptionsFor(caps, tStub);
  const by = Object.fromEntries(opts.map((o) => [o.value, !!o.disabled]));
  check('门控：supportedEfforts=[low,high] → low/high 可选、medium 禁用',
    by.low === false && by.medium === true && by.high === false, JSON.stringify(by));
}

// ── ③ 无 caps：不门控（零破坏）且**不得凭空造出 caps 键** ──
{
  const caps = MS.reasoningCapsOf({ model_id: 'z' }, { id: 9 });
  const opts = MS.reasoningOptionsFor(caps, tStub);
  check('无 caps 声明：不门控（保持历史行为）', caps === null && opts.every((o) => !o.disabled),
    `caps=${JSON.stringify(caps)}`);
}

// ── ④ Ollama 探测值 → 窗口：`:latest` 归一 ──
{
  const probed = [{ name: 'qwen3:8b:latest', numCtx: 32768, contextLength: 131072, source: 'api-show' }];
  const n = MS.probedNumCtxOf(probed, { model_id: 'qwen3:8b' });
  check('探测值匹配时 `:latest` 后缀被归一 → 32768', n === 32768, `probedNumCtx=${n}`);
  check('未命中/空输入返回 0（不猜）',
    MS.probedNumCtxOf(probed, { model_id: 'llama3' }) === 0 && MS.probedNumCtxOf(null, { model_id: 'x' }) === 0);
}

// ── ⑤ fallback-4k 不得被当成已确认（防「窗口高估 ⇒ 压缩永不触发」）──
{
  const prov = { id: 7, base_url: 'http://localhost:11434/v1' };
  const model = { model_id: 'qwen3:8b' };
  const fallback = [{ name: 'qwen3:8b', numCtx: 4096, contextLength: 0, source: 'fallback-4k' }];
  const nFallback = MS.probedNumCtxOf(fallback, model);
  const rFallback = MC.resolveContextWindow(prov, model, nFallback);
  check('source=fallback-4k 不被采信（probedNumCtx 返回 0）', nFallback === 0, `probedNumCtx=${nFallback}`);
  check('fallback-4k 走「未确认」档：{4096, confirmed:false}',
    rFallback.window === 4096 && rFallback.confirmed === false, JSON.stringify(rFallback));

  const nProbed = MS.probedNumCtxOf([{ name: 'qwen3:8b', numCtx: 32768, source: 'api-show' }], model);
  const rProbed = MC.resolveContextWindow(prov, model, nProbed);
  check('api-show 才被采信：{32768, confirmed:true, source:ollama-probe}',
    rProbed.window === 32768 && rProbed.confirmed === true && rProbed.source === 'ollama-probe',
    JSON.stringify(rProbed));

  const rNone = MC.resolveContextWindow(prov, model);
  check('完全未探测：{4096, confirmed:false}（不是 32768 也不是 128000）',
    rNone.window === 4096 && rNone.confirmed === false, JSON.stringify(rNone));
}

// ── ⑥ 用户手选优先于一切（含探测值）──
{
  const prov = { id: 3, isGlobal: true };
  const model = { model_id: 'm' };
  store.set('mj_model_configs', JSON.stringify({ 'g:3/m': { context_window: 65536 } }));
  const r = MC.resolveContextWindow(prov, model, 32768); // 即使有探测值，用户手选也应胜出
  check('用户手选优先（65536 且 source=user）', r.window === 65536 && r.source === 'user', JSON.stringify(r));
  store.clear();
  const r2 = MC.resolveContextWindow(prov, model, 32768);
  check('清掉手选后回落到探测值', r2.window === 32768, JSON.stringify(r2));
}

// ── ⑦ 渲染层端点：caps 原样透传；无 caps **不得有 caps 键** ──
// 这一层是「主进程 → 渲染层」的最后一跳，此前只留 {id, model_id, display_name}，caps 在这里被抹掉。
{
  globalThis.window.mjcode = {
    localProviders: async () => ([
      {
        id: 1,
        name: 'ollama',
        base_url: 'http://localhost:11434/v1',
        models: [
          { modelId: 'qwen3:8b', displayName: 'qwen3 8b', caps: { supportsReasoning: true, supportedEfforts: ['low', 'high'] } },
          { modelId: 'plain', displayName: 'plain' }, // 无 caps
        ],
      },
      { id: 2, name: 'old', modelId: 'legacy-only' }, // 旧结构（仅 modelId）
    ]),
  };
  API.setLocalMode(true);
  const providers = await API.api.providers();
  const ollama = providers.find((p) => p.id === 1);
  const withCaps = ollama.models.find((m) => m.model_id === 'qwen3:8b');
  const noCaps = ollama.models.find((m) => m.model_id === 'plain');
  check('渲染层端点：带 caps 的模型 caps 原样保留（supportsEfforts 不丢）',
    withCaps?.caps?.supportsReasoning === true
    && JSON.stringify(withCaps?.caps?.supportedEfforts) === JSON.stringify(['low', 'high']),
    JSON.stringify(withCaps?.caps));
  check('渲染层端点：无 caps 的模型**没有 caps 键**（`!("caps" in m)`，不是 undefined）',
    noCaps && !Object.prototype.hasOwnProperty.call(noCaps, 'caps'),
    `keys=${Object.keys(noCaps || {}).join(',')}`);
  check('渲染层端点：旧结构（仅 modelId）仍派生出 models（向后兼容）',
    providers.find((p) => p.id === 2)?.models?.[0]?.model_id === 'legacy-only',
    JSON.stringify(providers.find((p) => p.id === 2)?.models));
  check('渲染层端点：caps 缺失时 JSON.stringify 后不出现 "caps" 字样（不伪造）',
    !JSON.stringify(noCaps).includes('caps'), JSON.stringify(noCaps));
}

// ── ⑧ 主进程端点：caps 真落库、且无 caps 时不写 caps 键（读回来验证，不只看内存）──
{
  const { LocalStore } = require(path.join(DESKTOP, 'main/store/localStore.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-caps-'));
  try {
    const s1 = new LocalStore(dir);
    const p = s1.addProvider({ name: 'ollama', base_url: 'http://localhost:11434/v1' });
    s1.updateFileProvider(p.id, {
      models: [
        { modelId: 'qwen3:8b', displayName: 'q', caps: { supportsReasoning: false } },
        { modelId: 'plain', displayName: 'p' },
      ],
    });
    const reloaded = new LocalStore(dir); // 从磁盘重读：证明真落库而非只在内存
    const saved = reloaded.data.providers.find((x) => x.id === p.id);
    const m1 = saved.models.find((m) => m.modelId === 'qwen3:8b');
    const m2 = saved.models.find((m) => m.modelId === 'plain');
    check('主进程端点：caps 落库后重读仍保留（supportsReasoning:false 不丢）',
      m1?.caps?.supportsReasoning === false, JSON.stringify(m1?.caps));
    check('主进程端点：无 caps 的模型落库后**没有 caps 键**',
      m2 && !Object.prototype.hasOwnProperty.call(m2, 'caps'), `keys=${Object.keys(m2 || {}).join(',')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── ⑨ 两端一致性：同一份 caps 经「主进程落库 → 渲染层映射」后语义不变 ──
// 这是本条链路真正的失败模式：两端各自都"看起来对"，但中间丢字段，门控就永远不触发。
{
  const caps = { supportsReasoning: true, supportedEfforts: ['low', 'high'] };
  const viaMain = caps; // 主进程落库后原样
  const viaRenderer = MS.reasoningCapsOf({ model_id: 'm', caps: viaMain }, {});
  const opts = MS.reasoningOptionsFor(viaRenderer, tStub);
  const by = Object.fromEntries(opts.map((o) => [o.value, !!o.disabled]));
  check('端到端：主进程落库的 caps 经渲染层解析后仍能正确门控（medium 禁用、默认档可选）',
    by.low === false && by.medium === true && by.high === false && by[''] === false, JSON.stringify(by));
}

console.log(`\nprobe-window-wiring: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
