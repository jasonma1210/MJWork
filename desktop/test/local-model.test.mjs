// 本机模型就绪治理门禁（main/localModel.js + agent-core 的重试判定）
//
// 事故形态（2026-11-04，用户实测 flint@Ollama 29GB）：
//   冷启动时 Ollama 要先把权重读进显存，期间一个字节都不回 → 首字节守卫到点 abort →
//   chatWithRetry 把这条错误判成「超时」→ 再等一轮，共 3 次 → 用户等十几分钟后只看到「无法访问」。
//
// 本套件守四件事，每一条都对应链上的一环，删掉任何一环该条就会红：
//   ① 远端链路零行为变化（chatHints 不给远端下发 keep_alive；ensureReady 对远端零 fetch）；
//   ② 本机端点「确认可用才发」而不是「连上就发」（tags → ps → 预热）；
//   ③ 失败文案是人话且可判读（不把 ECONNREFUSED / Timeout 原样甩给用户，也不把 404 说成服务挂了）；
//   ④ 重试判定按 error.code 而不是文案关键词（文案里出现「300 秒」不该触发三倍重试）。
//
// 反向用例设计（关键）：第 ④ 组的错误消息里**故意**塞进 "timeout" 与 "500"，
// 于是「只按 message 正则判」的实现必然红，只有真按 code 判才绿。这是本文件唯一的有效自检点。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const localModel = require(path.join(ROOT, 'main/localModel.js'));
const { isRetryableChatError } = require(path.join(ROOT, 'agent-core/index.js'));

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.error(`[FAIL] ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}

// ── 测试夹具：可编程的 fetch 桩 ─────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-local-model-'));
const FAST = { healthMs: 200, listMs: 200, firstInferMs: 300, inferMs: 150 };

/**
 * routes: { 'GET /api/tags': (req) => reply, ... }，reply 可以是
 *   {status, json} / 'network' / 'hang'（永不返回，直到被 abort）
 */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const key = `${method} ${new URL(url).pathname}`;
    calls.push({ key, url, body: opts.body ? JSON.parse(opts.body) : null });
    const route = routes[key];
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    const out = typeof route === 'function' ? route({ opts, body: opts.body ? JSON.parse(opts.body) : null }) : route;
    if (out === 'network') {
      const e = new Error('fetch failed');
      e.cause = { code: 'ECONNREFUSED' };
      throw e;
    }
    if (out === 'hang') {
      // 模拟「Ollama 正在读 29GB 权重，一个字节都不回」：只有 abort 能结束它
      return new Promise((_, reject) => {
        const onAbort = () => {
          const e = new Error('This operation was aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (opts.signal?.aborted) return onAbort();
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    return { ok: out.status ? out.status < 400 : true, status: out.status || 200, json: async () => out.json || {} };
  };
  localModel.__test__configure({ fetchMock: impl, dir: tmpDir, tiers: FAST });
  return calls;
}

const OLLAMA = 'http://localhost:11434/v1';
const TAGS_FLINT = { json: { models: [{ name: 'flint:latest', size: 29e9 }] } };

// ── ① 分层超时 ─────────────────────────────────────────────────────────
await check('tierMs：四档默认值符合「健康 3–5s / 列表 5–10s / 首推理 60–120s / 后续 30–60s」', () => {
  localModel.__test__configure({ dir: tmpDir });
  const t = localModel.tierMs({});
  assert(t.healthMs >= 3000 && t.healthMs <= 5000, `healthMs=${t.healthMs} 不在 3–5s`);
  assert(t.listMs >= 5000 && t.listMs <= 10000, `listMs=${t.listMs} 不在 5–10s`);
  assert(t.firstInferMs >= 60000 && t.firstInferMs <= 120000, `firstInferMs=${t.firstInferMs} 不在 60–120s`);
  assert(t.inferMs >= 30000 && t.inferMs <= 60000, `inferMs=${t.inferMs} 不在 30–60s`);
});

await check('tierMs：env 覆盖生效；0 视为未设置回落默认；越界正值被钳到区间', () => {
  localModel.__test__configure({ dir: tmpDir });
  // 与 streamGuard.readEnvMs 同口径：<=0 或非法 = "没设置"，回落默认档
  const zero = localModel.tierMs({ MJ_LOCAL_FIRST_INFER_MS: '0' });
  assert(zero.firstInferMs === 120000, `0 应视为未设置回落默认 120000，实际 ${zero.firstInferMs}`);
  // 小于下限的正值必须被抬到下限（否则一个笔误就变成"每次请求 1 秒超时"）
  const tooSmall = localModel.tierMs({ MJ_LOCAL_HEALTH_MS: '50' });
  assert(tooSmall.healthMs === localModel.TIER_BOUNDS.healthMs.min, `50 应被抬到 min，实际 ${tooSmall.healthMs}`);
  const tooBig = localModel.tierMs({ MJ_LOCAL_INFER_MS: '99999999' });
  assert(tooBig.inferMs === localModel.TIER_BOUNDS.inferMs.max, `巨大值应被钳到 max，实际 ${tooBig.inferMs}`);
  const ok = localModel.tierMs({ MJ_LOCAL_INFER_MS: '45000' });
  assert(ok.inferMs === 45000, `合法覆盖应原样生效，实际 ${ok.inferMs}`);
});

// ── ② 端点识别与请求体（远端零行为变化）───────────────────────────────
await check('ollamaRoot：回环端点还原成不带 /v1 的原生根；远端/内网一律返回空串', () => {
  localModel.__test__configure({ dir: tmpDir });
  assert(localModel.ollamaRoot('http://localhost:11434/v1') === 'http://localhost:11434', 'localhost:11434/v1 应还原为 origin');
  assert(localModel.ollamaRoot('http://127.0.0.1:11434') === 'http://127.0.0.1:11434', '无 /v1 的回环地址应原样');
  assert(localModel.ollamaRoot('https://api.deepseek.com/v1') === '', '公网端点必须返回空串');
  assert(localModel.ollamaRoot('http://192.168.1.9:11434/v1') === '', '内网服务器不算本机（prefill 行为接近云端）');
});

await check('chatHints：只有 Ollama 类回环端点才下发 keep_alive:-1，远端与未探明端口一律空对象', () => {
  localModel.__test__configure({ dir: tmpDir });
  const local = localModel.chatHints(OLLAMA);
  assert(local.keep_alive === -1, `本机 Ollama 应下发 keep_alive:-1，实际 ${JSON.stringify(local)}`);
  const remote = localModel.chatHints('https://api.deepseek.com/v1');
  assert(Object.keys(remote).length === 0, `远端不得附加任何字段（严格服务端会 400），实际 ${JSON.stringify(remote)}`);
  const unknownPort = localModel.chatHints('http://127.0.0.1:1234/v1');
  assert(Object.keys(unknownPort).length === 0, `非 11434 且未探明是 Ollama 的端口不得下发，实际 ${JSON.stringify(unknownPort)}`);
});

// ── ③ 纯逻辑：名字匹配 / 就绪判定 / 耗时估计 ───────────────────────────
await check('matchesModel：容忍 :latest 后缀，但 flint:7b 不等于 flint（否则会把别的模型当成本模型）', () => {
  localModel.__test__configure({ dir: tmpDir });
  assert(localModel.matchesModel('flint:latest', 'flint') === true, ':latest 应归一');
  assert(localModel.matchesModel('flint', 'flint:latest') === true, '反向也应归一');
  assert(localModel.matchesModel('flint:7b', 'flint') === false, '带参数量后缀的不同 tag 不得相等');
  assert(localModel.matchesModel('', 'flint') === false, '空名不得匹配');
});

await check('readinessOf：装没装 / 在不在显存 两问分开答，且 ps 缺失时标 residentKnown=false', () => {
  localModel.__test__configure({ dir: tmpDir });
  const cold = localModel.readinessOf({
    tagsOk: true, tags: { models: [{ name: 'flint:latest', size: 29e9 }] },
    psOk: true, ps: { models: [] }, model: 'flint',
  });
  assert(cold.state === 'cold', `装了但没常驻应为 cold，实际 ${cold.state}`);
  assert(cold.sizeBytes === 29e9, `应带出体积（用于估计加载时长），实际 ${cold.sizeBytes}`);
  const ready = localModel.readinessOf({
    tagsOk: true, tags: { models: [{ name: 'flint:latest', size: 29e9 }] },
    psOk: true, ps: { models: [{ name: 'flint:latest' }] }, model: 'flint',
  });
  assert(ready.state === 'ready', `在显存里应为 ready，实际 ${ready.state}`);
  const missing = localModel.readinessOf({
    tagsOk: true, tags: { models: [{ name: 'qwen3:8b' }] },
    psOk: true, ps: { models: [] }, model: 'flint',
  });
  assert(missing.state === 'missing', `没装应为 missing，实际 ${missing.state}`);
  assert(missing.installedNames.includes('qwen3:8b'), '缺失时应能列出已装模型（供文案给建议）');
  const noPs = localModel.readinessOf({
    tagsOk: true, tags: { models: [{ name: 'flint:latest', size: 29e9 }] },
    psOk: false, ps: null, model: 'flint',
  });
  assert(noPs.residentKnown === false, 'ps 探不到时必须标「未确认」，上层才不会拿猜测当事实去预热');
});

await check('estimateLoadMs：尺寸未知给中位值；已等超估计时仍报 ≥5s（不许说"还需 0 秒"）', () => {
  localModel.__test__configure({ dir: tmpDir });
  const unknown = localModel.estimateLoadMs(0, 0);
  assert(unknown.estRemainMs >= 5000, `尺寸未知也要给正数，实际 ${unknown.estRemainMs}`);
  const big = localModel.estimateLoadMs(29e9, 0);
  assert(big.estTotalMs >= 20000 && big.estTotalMs <= 120000, `29GB 的估计应落在 20–120s，实际 ${big.estTotalMs}`);
  const late = localModel.estimateLoadMs(29e9, 999999);
  assert(late.estRemainMs === 5000, `已远超估计时下限应是 5000，实际 ${late.estRemainMs}`);
});

// ── ④ ensureReady 四条分支（正面回归本轮缺陷）──────────────────────────
await check('ensureReady：远端端点直接返回 remote，且一次 fetch 都不发（远端零延迟、零行为变化）', async () => {
  const calls = mockFetch({});
  const r = await localModel.ensureReady({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
  assert(r.state === 'remote', `应为 remote，实际 ${r.state}`);
  assert(calls.length === 0, `远端不得产生任何探测请求，实际发了 ${calls.map((c) => c.key).join(',')}`);
});

await check('ensureReady：服务没起 → LOCAL_BACKEND_DOWN，文案给「怎么起服务」而不是把 Timeout 甩给用户', async () => {
  mockFetch({ 'GET /api/tags': 'network' });
  let err = null;
  try {
    await localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint' });
  } catch (e) { err = e; }
  assert(err, '服务连不上时必须抛错，不得静默放行');
  assert(err.code === 'LOCAL_BACKEND_DOWN', `code 应为 LOCAL_BACKEND_DOWN，实际 ${err.code}`);
  assert(/ollama serve/.test(err.message), `文案必须给出可执行的下一步，实际：${err.message}`);
  assert(/localhost:11434/.test(err.message), `文案必须指明是哪个地址连不上，实际：${err.message}`);
});

await check('ensureReady：端口上不是 Ollama（/api/tags 404）→ unknown 放行，绝不诬告「服务没启动」', async () => {
  mockFetch({ 'GET /api/tags': { status: 404, json: {} } });
  const r = await localModel.ensureReady({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen' });
  assert(r.state === 'unknown', `应为 unknown，实际 ${r.state}`);
});

await check('ensureReady：模型名不存在 → LOCAL_MODEL_MISSING，并列出已装模型（不让人去 pull 一个已存在的）', async () => {
  mockFetch({
    'GET /api/tags': { json: { models: [{ name: 'qwen3:8b', size: 5e9 }] } },
    'GET /api/ps': { json: { models: [] } },
  });
  let err = null;
  try {
    await localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint' });
  } catch (e) { err = e; }
  assert(err && err.code === 'LOCAL_MODEL_MISSING', `code 应为 LOCAL_MODEL_MISSING，实际 ${err && err.code}`);
  assert(/qwen3:8b/.test(err.message), `文案应列出已装模型，实际：${err.message}`);
  assert(/ollama pull flint/.test(err.message), `文案应给出下载命令，实际：${err.message}`);
});

await check('ensureReady：装了但没常驻 → 先预热（/api/generate 空 prompt + keep_alive:-1），成功后免探测', async () => {
  const calls = mockFetch({
    'GET /api/tags': TAGS_FLINT,
    'GET /api/ps': { json: { models: [] } },
    'POST /api/generate': { json: { done: true, done_reason: 'load' } },
  });
  const phases = [];
  const r = await localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint', onPhase: (p) => phases.push(p.phase) });
  assert(r.state === 'ready', `预热成功应返回 ready，实际 ${r.state}`);
  const gen = calls.find((c) => c.key === 'POST /api/generate');
  assert(gen, '冷启动必须先调 /api/generate 预热');
  assert(gen.body.keep_alive === -1, `预热请求必须带 keep_alive:-1（否则 5 分钟后又冷启动），实际 ${JSON.stringify(gen.body)}`);
  assert(gen.body.prompt === '', '预热必须用空 prompt（只加载不推理）');
  assert(phases.includes('loading') && phases.includes('ready'), `进度必须报 loading→ready，实际 ${phases.join(',')}`);
  // 免探测：第二次必须完全不发请求（否则每条 Agent 消息都要多两次往返）
  const before = calls.length;
  const again = await localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint' });
  assert(again.state === 'ready' && again.cached === true, `常驻缓存应生效，实际 ${JSON.stringify(again)}`);
  assert(calls.length === before, `缓存命中时不得再发探测请求，实际多发了 ${calls.length - before} 次`);
});

await check('ensureReady：加载超出预算 → LOCAL_MODEL_LOADING，文案带「已等待/预计还需」而不是裸 Timeout', async () => {
  mockFetch({
    'GET /api/tags': TAGS_FLINT,
    'GET /api/ps': { json: { models: [] } },
    'POST /api/generate': 'hang',
  });
  let err = null;
  try {
    // 预热预算 300ms（FAST），加载挂住 → 超时
    await localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint' });
  } catch (e) { err = e; }
  assert(err, '超预算必须抛错（不得谎称 ready）');
  assert(err.code === 'LOCAL_MODEL_LOADING', `code 应为 LOCAL_MODEL_LOADING，实际 ${err.code}`);
  assert(/正在加载中/.test(err.message), `文案应说明"正在加载"，实际：${err.message}`);
  assert(/预计还需约\s*\d+\s*秒/.test(err.message), `文案必须给出预计剩余时间，实际：${err.message}`);
  assert(/重试本轮/.test(err.message), `文案必须给出可执行的下一步，实际：${err.message}`);
  assert(err.estRemainMs >= 5000, `结构化字段应带 estRemainMs，实际 ${err.estRemainMs}`);
});

await check('prewarm：非 Ollama 端口（LM Studio / llama.cpp 等）不发 /api/generate —— 别在别人日志里制造 404', async () => {
  const calls = mockFetch({});
  const r = await localModel.prewarm({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen' });
  assert(r.state === 'unsupported', `应判 unsupported，实际 ${r.state}`);
  assert(calls.length === 0, `不得发出任何请求，实际 ${calls.map((c) => c.key).join(',')}`);
});

await check('ensureReady：并发两次只加载一次（一次 Agent 运行会连发十几次 chat，重复加载会互相踩）', async () => {
  let genCount = 0;
  mockFetch({
    'GET /api/tags': TAGS_FLINT,
    'GET /api/ps': { json: { models: [] } },
    'POST /api/generate': () => { genCount++; return { json: { done: true } }; },
  });
  await Promise.all([
    localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint' }),
    localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint' }),
  ]);
  assert(genCount === 1, `同一模型的并发预热应合并成一次，实际 ${genCount} 次`);
});

// ── ⑤ 首字节预算收紧（已常驻才收紧，未确认不动）────────────────────────
await check('firstByteBudget：已常驻+短 prompt 才收紧；未常驻 / 长 prompt / 远端 一律保持 300s 兜底', async () => {
  mockFetch({
    'GET /api/tags': TAGS_FLINT,
    'GET /api/ps': { json: { models: [] } },
    'POST /api/generate': { json: { done: true } },
  });
  const shortMsgs = [{ role: 'user', content: '你好' }];
  const cold = localModel.firstByteBudget(300000, OLLAMA, 'flint', shortMsgs);
  assert(cold === 300000, `未确认常驻时不得收紧（会误杀冷启动），实际 ${cold}`);
  await localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint' });
  const warm = localModel.firstByteBudget(300000, OLLAMA, 'flint', shortMsgs);
  assert(warm === FAST.inferMs, `已常驻 + 短 prompt 应收紧到 ${FAST.inferMs}，实际 ${warm}`);
  // 关键反例：7.7 万 token 级别的 prompt 在本机 prefill 就要分钟级（2026-11-03 实测 90014ms 还没首字节）。
  // 对这类请求收紧到 60s，等于把「打字前就失败」的缺陷重新引入 —— 必须保持 300s。
  const longMsgs = [{ role: 'user', content: 'x'.repeat(80000) }];
  const long = localModel.firstByteBudget(300000, OLLAMA, 'flint', longMsgs);
  assert(long === 300000, `长 prompt 的慢是 prefill 的物理时间，不得收紧，实际 ${long}`);
  const remote = localModel.firstByteBudget(300000, 'https://api.deepseek.com/v1', 'deepseek-chat', shortMsgs);
  assert(remote === 300000, `远端不得被本机档影响，实际 ${remote}`);
});

// ── ⑥ 重试判定：按 code，不按文案 ───────────────────────────────────────
await check('isRetryableChatError：LOCAL_MODEL_LOADING/MISSING 判不可重试——即使文案里带 timeout 和 500', () => {
  const loading = new Error('模型正在加载中（已等待 300 秒，预计还需约 500 秒）timeout');
  loading.code = 'LOCAL_MODEL_LOADING';
  assert(isRetryableChatError(loading) === false,
    '就绪类错误必须直接上抛：重试只会把同一段等待重放三遍（用户实测 = 十几分钟后仍然「无法访问」）');
  const missing = new Error('没有名为 flint 的模型');
  missing.code = 'LOCAL_MODEL_MISSING';
  assert(isRetryableChatError(missing) === false, '模型名写错，重试一万次还是错');
  const down = new Error('本机模型服务（http://localhost:11434）连不上');
  down.code = 'LOCAL_BACKEND_DOWN';
  assert(isRetryableChatError(down) === true, '服务没起时用户可能正在 ollama serve，重试是有意义的');
});

await check('noteChatFailure：连接层失败作废常驻缓存（否则 5 分钟内友好降级永远走不到）', async () => {
  mockFetch({
    'GET /api/tags': TAGS_FLINT,
    'GET /api/ps': { json: { models: [] } },
    'POST /api/generate': { json: { done: true } },
  });
  await localModel.ensureReady({ baseUrl: OLLAMA, model: 'flint' });
  assert(localModel.isResidentFresh('http://localhost:11434', 'flint') === true, '预热成功后应为常驻');
  // 业务错误（4xx / 模型输出异常）不该作废缓存：模型明明还在显存里
  localModel.noteChatFailure(OLLAMA, 'flint', new Error('API 400: bad request'));
  assert(localModel.isResidentFresh('http://localhost:11434', 'flint') === true, '非连接层错误不应作废常驻');
  // 连接层失败（Ollama 被重启/杀掉）必须作废，下一次才会重新探测并给出「服务没起」的提示
  localModel.noteChatFailure(OLLAMA, 'flint', new Error('fetch failed: ECONNREFUSED'));
  assert(localModel.isResidentFresh('http://localhost:11434', 'flint') === false, '连接层失败必须作废常驻');
});

await check('常驻缓存有效期必须短于 Ollama 默认卸载窗口（5 分钟）', () => {
  // 缓存比物理事实活得久 ⇒ 「我们说它还在，其实早被卸载」⇒ 跳过预热打到冷模型 ⇒ 又等 300s。
  // 这条断言把「5 分钟」这个外部事实钉成常量的上界，防止有人「顺手把 TTL 调大省点探测」。
  assert(localModel.RESIDENT_TTL_MS < 5 * 60 * 1000,
    `RESIDENT_TTL_MS=${localModel.RESIDENT_TTL_MS} 不得 ≥ Ollama 默认 keep_alive 5 分钟`);
  assert(localModel.RESIDENT_TTL_MS >= 60000, 'TTL 过短会让每次对话都多两次探测，得不偿失');
});

// ── ⑦ 源码级接线（改坏了这里就是"模块写完没接上"）──────────────────────
await check('main.js 接线：ensureReady 必须在 quota.acquire 之前（否则抛错时 fg 槽位泄漏）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  const ready = src.indexOf('localModel.ensureReady(');
  const acquire = src.indexOf("quota.acquire('fg'");
  assert(ready > 0, 'main.js 未调用 localModel.ensureReady —— 本机模型又回到「连上就发」');
  assert(acquire > 0, '未找到 quota.acquire 调用点（结构变化请同步本测试）');
  assert(ready < acquire, `ensureReady 必须在 acquire 之前，实际 ready@${ready} acquire@${acquire}`);
});

await check('main.js 接线：chat body 带 chatHints、成功回复 markResident、停止时 abortAll', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  assert(/const body = \{ model, messages[\s\S]{0,200}\.\.\.localModel\.chatHints\(root\)/.test(src),
    'chat body 未附加 localModel.chatHints —— keep_alive:-1 不会下发，模型 5 分钟就被驱逐');
  assert(/localModel\.markResident\(root, model\)/.test(src), '成功回复后未记常驻事实 —— 免探测与启动预热都会失效');
  assert(/localModel\.abortAll\(\)/.test(src), 'model:abort 未中止预热 —— 点「停止」还要干等模型读完 29GB');
  assert(/localModel\.prewarmLastUsed\(\)/.test(src), '启动处未预热 —— 冷启动又回到用户等的那几分钟');
});

await check('渲染层接线：本机模型加载进度有 toast 出口，且中英文案键齐备', () => {
  const fb = fs.readFileSync(path.join(ROOT, 'renderer/src/components/feedback.jsx'), 'utf8');
  assert(/local_model_notice/.test(fb), 'feedback 未消费 local_model_notice —— 进度报给用户就是空的');
  for (const loc of ['zh-CN', 'en-US']) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, `renderer/src/i18n/locales/${loc}/runtime.json`), 'utf8'));
    for (const k of ['localModelLoading', 'localModelReady']) {
      assert(typeof j[k] === 'string' && j[k].length > 0, `${loc} 缺 runtime.${k}`);
    }
  }
});

// ─── ⑤ MD2（2026-11-05）：凭证判据「本机回环端点免 Key」 ─────────────────────
// 缺陷形态：三处发消息入口 + 测试连接原先都无条件校验 `secret.api_key`，于是纯本机
// Ollama / llama.cpp 用户**必须填一个假 Key** 才能发出第一条消息，而假 Key 会被真的
// 拼成 `Authorization: Bearer sk-fake` 发出去。对「离线级 agent」这是开箱第一道拦路虎。
//
// 本组同时锁住**放宽的方向**与**不放宽的边界**：少了边界那几条，这个改动就等于
// 「谁都不用 Key」，那是把一个体验缺陷换成安全缺陷。
await check('credentialUsable：有 Key 时不论端点在哪都放行（远端/本机）', () => {
  assert(localModel.credentialUsable({ api_key: 'sk-x', base_url: 'https://api.example.com' }, '') === true,
    '有 Key + 远端应放行');
  assert(localModel.credentialUsable({ api_key: 'sk-x', base_url: 'http://127.0.0.1:11434' }, '') === true,
    '有 Key + 本机应放行');
});

await check('credentialUsable：无 Key + 回环地址放行（127.0.0.1 / localhost / ::1 / [::1] / 0.0.0.0）', () => {
  for (const url of ['http://127.0.0.1:11434', 'http://localhost:8080/v1', 'http://[::1]:11434', 'http://0.0.0.0:8000']) {
    assert(localModel.credentialUsable({ api_key: '', base_url: url }, url) === true, `${url} 应放行（MD2）`);
  }
});

await check('credentialUsable：无 Key + 远端拒绝（这就是原来的正确行为，不能被放宽掉）', () => {
  assert(localModel.credentialUsable({ api_key: '', base_url: 'https://api.deepseek.com' }, '') === false,
    '远端无 Key 必须拒绝');
});

await check('credentialUsable：内网段不算本机（10.x / 192.168.x 可能是别人的机器）', () => {
  for (const url of ['http://192.168.1.50:11434', 'http://10.0.0.7:8000', 'http://172.16.3.9:11434']) {
    assert(localModel.credentialUsable({ api_key: '', base_url: url }, url) === false,
      `${url} 是内网不是回环，无 Key 不得放行`);
  }
});

await check('credentialUsable：secret 缺失 / 地址为空 / 非法 URL 一律拒绝（fail-closed）', () => {
  assert(localModel.credentialUsable(null, 'http://127.0.0.1:11434') === false, 'secret=null 应拒绝');
  assert(localModel.credentialUsable(undefined, '') === false, 'secret=undefined 应拒绝');
  assert(localModel.credentialUsable({ api_key: '' }, '') === false, '空地址应拒绝（无可达端点）');
  assert(localModel.credentialUsable({ api_key: '' }, 'not-a-url') === false, '非法 URL 应拒绝');
  assert(localModel.credentialUsable({ api_key: '', base_url: 'llama.cpp' }, '') === false, '相对串应拒绝');
});

await check('credentialUsable：显式 baseUrl 优先于 secret.base_url（与 main.js root 同序）', () => {
  // 界面填了本机、库里还存着远端 —— 判据必须跟本次要用的那一个，否则会误拒/误放
  assert(localModel.credentialUsable({ api_key: '', base_url: 'https://api.example.com' }, 'http://127.0.0.1:11434') === true,
    '本次用本机地址 ⇒ 应放行（而不是看库里那个远端）');
  assert(localModel.credentialUsable({ api_key: '', base_url: 'http://127.0.0.1:11434' }, 'https://api.example.com') === false,
    '本次用远端地址 ⇒ 应拒绝（而不是看库里那个本机）');
});

await check('credentialUsable：接线——四处模型通路 + testConnection 都改用它（禁止各写一套）', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const mainSrc = read('main/main.js');
  const schedSrc = read('main/scheduledChannels.js');
  const ipcSrc = read('main/ipc/localData.js');
  const cuaSrc = read('main/cuaHandlers.js');
  // 正向：四处模型通路都必须接到同一个判据上。
  // 第四处（CUA）容易被漏——只改三处就会留下「本机模型能聊天、一用 CUA 就 KEY_MISSING」，
  // 那是同一类漂移换了个位置，比原来更难看（用户会以为 CUA 坏了而不是配置问题）。
  for (const [label, src] of [['main.js', mainSrc], ['scheduledChannels.js', schedSrc],
    ['localData.js（testConnection）', ipcSrc], ['cuaHandlers.js（CUA）', cuaSrc]]) {
    assert(/credentialUsable\(/.test(src), `${label} 未接入 credentialUsable`);
  }
  // 反向：裸判必须消失，否则就是「两套判据并存」，必然漂移成一边能发一边不能
  for (const [label, src] of [['main.js', mainSrc], ['scheduledChannels.js', schedSrc], ['cuaHandlers.js', cuaSrc]]) {
    assert(!/!\s*secret\s*\|\|\s*!\s*secret\.api_key/.test(src), `${label} 仍残留裸判 !secret || !secret.api_key`);
  }
  // 反向：**每一处模型 Key 的 Authorization 构造**都必须带三目保护。
  // 注意三点（都是写这个断言时踩到的）：
  //  ① 不能写成「全文不得出现 Authorization: `Bearer ${secret.api_key}`」——条件展开里本来就有
  //     这段字面量，那样断言无法区分「无条件发」与「条件发」，是个假断言（我第一版就写错了）；
  //  ② 不能拿 'Connection': 'close' 当锚点——cuaChat 的 headers 没有它（用 AbortSignal.timeout）；
  //  ③ 必须收窄到模型 Key：main.js:346 是**另一套鉴权**（`Bearer ${token}`，服务端 token），不归这里管。
  for (const [label, src] of [['main.js', mainSrc], ['scheduledChannels.js', schedSrc], ['cuaHandlers.js', cuaSrc]]) {
    const authz = src.split('\n')
      .filter((l) => l.includes('Authorization:') && /(secret\.api_key|apiKey\b)/.test(l));
    assert(authz.length > 0, `${label} 没找到模型 Key 的 Authorization 构造行——断言前提失效，别当成通过`);
    const bare = authz.filter((l) => !/\?/.test(l));
    assert(bare.length === 0,
      `${label} 有 ${bare.length} 处模型 Key Authorization 无条件发送（无 Key 时会发出空/假 Bearer）`);
  }
  // testConnection 走的是 headers['Authorization'] = 形式（不是对象字面量），单独锁它的保护条件
  assert(/if \(vault\?\.api_key\) headers\['Authorization'\]/.test(ipcSrc),
    'testConnection 的 Authorization 缺 if (vault?.api_key) 保护');
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log(`\n结果：${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;
