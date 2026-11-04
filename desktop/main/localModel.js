'use strict';
// 本机模型（Ollama 等回环推理端点）的「就绪治理」：预热 / 常驻 / 探测 / 降级。
//
// ── 这条缺陷链是怎么把用户卡死的（2026-11-04 复核）──
//   model=flint（29GB，num_ctx=262144，localhost:11434 = Ollama），冷启动时：
//   ① 请求打到 Ollama，Ollama 先去磁盘加载 29GB 权重，期间**一个字节都不回**；
//   ② streamGuard 的首字节守卫（本机档 300s，见 streamGuard.LOCAL_DEFAULTS）到点 abort；
//   ③ agent-core 的 chatWithRetry 把这条错误判成「超时」可重试 → 再等一轮，共 3 次；
//   ④ 用户等十几分钟，最后只拿到一个「无法访问 / 超时」。
//   每一步单独看都合理，串起来就是「不停重试然后失败」。所以必须四件事一起做：
//
//   1) keep_alive:-1 —— 推理完成后不让模型被驱逐。Ollama 默认 5 分钟不用就卸载，
//      于是「每次提问都像第一次」。逐请求下发比设 OLLAMA_KEEP_ALIVE 更好：不用重启服务。
//   2) 启动预热（pre-warm）—— 开机就把**上次用过的**本机模型加载进显存并钉住，
//      把冷启动挪到「用户还在看欢迎页」的时候。上次用过谁只记在本模块自己的状态文件里，
//      不引入任何跨模块配置依赖。
//   3) 就绪探测（backend-aware readiness）—— 发请求前先问 /api/ps「这个模型在不在显存里」。
//      不在就先加载并回报进度。「连上就发」是本类故障的根因：TCP 连得上 ≠ 模型可用。
//   4) 优雅降级 —— 失败时给「模型正在加载中（已等待 X 秒，预计还需约 Y 秒）」，
//      而不是把 Connection refused / Timeout 原样甩给用户。
//
// ── 分层超时（用户口径；环境变量可覆盖，全部有上下限钳制）──
//   健康检查 /api/ps     3–5s    本地进程，答不上来就是真挂了
//   轻量查询 /api/tags   5–10s   列模型，可能触发目录扫描
//   首次推理（冷启动）   60–120s 29GB 权重从磁盘加载的时间尺度
//   后续推理（已常驻）   30–60s  预热过还这么久没首字节 = 真挂起
//
// 注意：本模块**不改** streamGuard.LOCAL_DEFAULTS。那是「兜底」而不是「预期」——
// 下调会重新引入 2026-11-03 已修好的问题（本地 prefill 比云端慢一个数量级，见该文件头）。
// 本模块的做法相反：确认模型已常驻后，把这次请求的首字节预算**收紧**到「已常驻档」，
// 于是「挂起」能被更早发现，而「冷启动」由预热带走，两边都不吃亏。
//
// 设计约束：纯逻辑（readinessOf / estimateLoadMs / matchesModel / tierMs）不碰网络不碰 fs，
// 便于单测与变异；一切 I/O 走可注入的 fetchImpl / 状态文件，测试零真实端口。

const path = require('node:path');
const fs = require('node:fs');
const { isLocalEndpoint } = require('./streamGuard');

// ── 分层超时 ────────────────────────────────────────────────────────────
// 区间上下限的意义：环境变量是给人用的旋钮，写错一个 0 或 999999 不该让应用看起来像卡死。
const TIERS = {
  healthMs: 4000,       // /api/ps：3–5s
  listMs: 8000,         // /api/tags：5–10s
  firstInferMs: 120000, // 冷启动加载预算：60–120s
  inferMs: 60000,       // 已常驻后的首字节预期：30–60s
};
const TIER_BOUNDS = {
  healthMs: { min: 1000, max: 15000, env: 'MJ_LOCAL_HEALTH_MS' },
  listMs: { min: 2000, max: 30000, env: 'MJ_LOCAL_LIST_MS' },
  firstInferMs: { min: 30000, max: 300000, env: 'MJ_LOCAL_FIRST_INFER_MS' },
  inferMs: { min: 15000, max: 180000, env: 'MJ_LOCAL_INFER_MS' },
};

// 仅测试注入（见 __test__configure）。生产路径恒为 null。
let tierOverride = null;

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** 生效的档位值（env 覆盖 > 默认；越界钳制而不是丢弃，免得一个笔误变成"没设置"） */
function tierMs(env = process.env) {
  // 测试注入：真实档位最小 30s，套件跑不动；只允许 __test__configure 设，生产路径永不进入
  if (tierOverride) return { ...TIERS, ...tierOverride };
  const out = {};
  for (const [k, b] of Object.entries(TIER_BOUNDS)) {
    const raw = env?.[b.env];
    const n = raw === undefined || raw === null || raw === '' ? TIERS[k] : Number(raw);
    out[k] = clamp(Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : TIERS[k], b.min, b.max);
  }
  return out;
}

// ── 端点识别 ────────────────────────────────────────────────────────────
// 「本机」判定复用 streamGuard.isLocalEndpoint（单一事实来源）。这里只多做一件事：
// 把 OpenAI 兼容的 base_url（.../v1）还原成 Ollama 原生 API 的根（不带 /v1）。
function ollamaRoot(baseUrl) {
  if (!isLocalEndpoint(baseUrl)) return '';
  try {
    const u = new URL(String(baseUrl));
    return u.origin;
  } catch {
    // isLocalEndpoint 只在 URL 解析成功时返回 true，理论不可达；保守返回空=按远端处理
    return '';
  }
}

// Ollama 默认端口 11434 是极强信号；非默认端口需要探测确认为 Ollama 才敢下发 keep_alive。
// 为什么要这么谨慎：keep_alive 是 Ollama 专有字段，虽然 OpenAI 兼容层普遍忽略未知字段，
// 但「严格服务端因多余字段 400」在本项目已有先例（reasoning_effort 就因此改为空值不发）。
const OLLAMA_DEFAULT_PORT = '11434';
const probedOllama = new Set(); // origin → true（探测确认为 Ollama）

function isOllamaLike(baseUrl) {
  const root = ollamaRoot(baseUrl);
  if (!root) return false;
  try {
    if (new URL(root).port === OLLAMA_DEFAULT_PORT) return true;
  } catch (e) {
    // ollamaRoot 已解析成功过，这里理论不可达；真失败就按非 Ollama 处理（不下发 keep_alive），
    // 但必须留痕：否则「本机模型老是 5 分钟被驱逐」会被查成实现 bug 而不是环境异常。
    console.warn('[localModel] 端点端口解析失败，按非 Ollama 处理:', e?.message || e);
    return false;
  }
  return probedOllama.has(root);
}

const KEEP_ALIVE_FOREVER = -1;

/**
 * 本次 chat 请求要附加的字段体。非本机 / 非 Ollama 一律返回空对象（远端请求逐字节不变）。
 * @returns {{keep_alive?: number}}
 */
function chatHints(baseUrl) {
  return isOllamaLike(baseUrl) ? { keep_alive: KEEP_ALIVE_FOREVER } : {};
}

// ── 纯逻辑：模型名匹配 / 就绪判定 / 加载时长估计 ─────────────────────────
// Ollama 的 /api/tags 与 /api/ps 里名字带 `:latest` 后缀，而用户配置里可能写 `flint`。
// 只做字面相等会让「明明装了却说没装」——这类误判比不判更糟（它会把用户引去 ollama pull）。
function normalizeModelName(s) {
  return String(s || '').trim().replace(/:latest$/i, '');
}

function matchesModel(candidate, wanted) {
  const a = normalizeModelName(candidate);
  const b = normalizeModelName(wanted);
  if (!a || !b) return false;
  return a === b;
}

/**
 * 就绪判定（纯函数）。输入是两个探测结果 + 目标模型名，输出**可判读的状态**。
 * @param {{tagsOk:boolean, tags:any, psOk:boolean, ps:any, model:string}} input
 * @returns {{state:'missing'|'cold'|'ready', modelName:string, sizeBytes:number,
 *            installedNames:string[], residentNames:string[], residentKnown:boolean}}
 */
function readinessOf(input = {}) {
  const { tagsOk, tags, psOk, ps, model } = input;
  const installed = tagsOk && Array.isArray(tags?.models) ? tags.models : [];
  const installedNames = installed
    .map((m) => String(m?.name || m?.model || ''))
    .filter(Boolean);
  const residentNames = psOk && Array.isArray(ps?.models)
    ? ps.models.map((m) => String(m?.name || m?.model || '')).filter(Boolean)
    : [];
  const hit = installed.find((m) => matchesModel(String(m?.name || m?.model || ''), model));
  if (!hit) {
    return {
      state: 'missing', modelName: '', sizeBytes: 0,
      installedNames, residentNames, residentKnown: psOk === true,
    };
  }
  const sizeBytes = Number(hit.size) || 0;
  const resident = residentNames.some((n) => matchesModel(n, model));
  return {
    state: resident ? 'ready' : 'cold',
    modelName: String(hit?.name || hit?.model || ''),
    sizeBytes,
    installedNames,
    residentNames,
    // /api/ps 不可用（老版本 Ollama 或非 Ollama 后端）时 residentKnown=false：
    // 上层据此**不要**声称「不在显存里」，只说「未确认」。
    residentKnown: psOk === true,
  };
}

// 加载耗时的粗略模型：≈500MB/s（NVMe 顺序读 + 页表/显存映射的保守值）。
// 只用于「预计还需约 N 秒」这种提示语，不参与任何闸门判定 —— 估错的代价是提示不精确，
// 不是误杀请求，所以宁可用一个能自洽的粗值，也不要为此去实测基准。
const LOAD_BYTES_PER_MS = 5e5;
const LOAD_EST_FLOOR_MS = 8000;
const LOAD_EST_CEIL_MS = 240000;
const REMAIN_MIN_MS = 5000;

function estimateLoadMs(sizeBytes, elapsedMs = 0) {
  const size = Number(sizeBytes) || 0;
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  // 尺寸未知（非 Ollama 后端、老版本 tags 无 size）：给一个中位估计，不假装精确
  const estTotal = size > 0
    ? clamp(Math.round(size / LOAD_BYTES_PER_MS), LOAD_EST_FLOOR_MS, LOAD_EST_CEIL_MS)
    : 60000;
  return { estTotalMs: estTotal, estRemainMs: Math.max(REMAIN_MIN_MS, estTotal - elapsed) };
}

// ── 错误：带 code 的可读错误 ─────────────────────────────────────────────
// code 的用途不是给人看，是给 agent-core 的 isRetryableChatError 判「该不该重试」。
// 靠 message 里的关键词去猜（现有做法）在本轮就是缺陷本身：一条「已等待 300 秒」的文案
// 会被 /timeout|超时/ 命中而重试三遍。所以这里显式带 code，让判定与文案解耦。
function localError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function secs(ms) {
  return Math.max(1, Math.round(Number(ms || 0) / 1000));
}

function backendDownMessage(root, cause) {
  const detail = String(cause || '').trim() || '连接被拒绝';
  return `本机模型服务（${root}）连不上：${detail}。`
    + '请确认它已启动（Ollama：终端执行 ollama serve），或打开「设置 → 模型」把服务地址改成实际端口。'
    + '本次请求未发出，不需要重试模型本身。';
}

function modelMissingMessage(model, installedNames) {
  const list = installedNames.length
    ? `当前已安装：${installedNames.slice(0, 8).join('、')}${installedNames.length > 8 ? ' 等' : ''}。`
    : '当前没有已安装的模型。';
  return `本机模型服务连上了，但没有名为「${model}」的模型。${list}`
    + `可执行 ollama pull ${model} 下载，或在「设置 → 模型」里改成上面已有的名字。`;
}

function modelLoadingMessage(model, waitedMs, estRemainMs) {
  return `模型「${model}」正在加载中（已等待 ${secs(waitedMs)} 秒，预计还需约 ${secs(estRemainMs)} 秒）。`
    + '加载在后台继续，稍后点「重试本轮」即可，不会从零重来。';
}

// ── 状态文件：上次用过的本机模型 + 常驻缓存 ──────────────────────────────
// 只存两个非敏感事实，不含任何 Key：{ lastUsed:{baseUrl,model,at}, resident:{'root|model': ts} }
// 常驻缓存有效期。**必须短于 Ollama 的默认卸载窗口（5 分钟）**：
// 缓存比物理事实活得久，就会出现「我们说它还在，其实早被卸载了」——于是跳过了预热、
// 直接打到冷模型上，用户又回到等 300s 的老路。宁可多探一次 /api/ps（本机进程，毫秒级）。
const RESIDENT_TTL_MS = 4 * 60 * 1000;
let stateFile = '';
let state = { lastUsed: null, resident: {} };
let stateLoaded = false;
let stateInitTried = false;

function defaultDataDir() {
  try {
    // 延迟取：本模块在 main.js 顶层就被 require，那时 app 还没 ready；
    // 用 getPath 包一层，配置缺失也只是「不落盘」，不影响功能。
    return require('electron').app.getPath('userData');
  } catch (e) {
    // 拿不到 userData（脚本/单测直接 require、或 app 未 ready）：退化成不落盘。
    // 必须留痕——否则「启动预热一直不生效」会被误判成实现坏了。
    console.warn('[localModel] 取不到 userData 目录，本机模型状态将不持久化:', e?.message || e);
    return '';
  }
}

// 状态文件路径**延迟解析**：本模块在 main.js 顶层就被 require，那时 app 还没 ready，
// 不能取 userData。这里在第一次真正读写时再解析，于是 main.js 不需要任何 init 调用。
function ensureStateFile() {
  if (stateFile || stateInitTried) return;
  stateInitTried = true;
  const dir = defaultDataDir();
  if (dir) stateFile = path.join(dir, 'local-model.json');
}

function loadState() {
  if (stateLoaded) return state;
  ensureStateFile();
  stateLoaded = true;
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const j = JSON.parse(raw);
    state = {
      lastUsed: j && typeof j.lastUsed === 'object' ? j.lastUsed : null,
      resident: j && typeof j.resident === 'object' && j.resident ? j.resident : {},
    };
  } catch {
    // 首次运行 / 文件损坏：从空状态开始。这里不是错误路径，不写日志污染启动输出。
    state = { lastUsed: null, resident: {} };
  }
  return state;
}

function saveState() {
  ensureStateFile();
  if (!stateFile) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
  } catch (e) {
    // 状态文件只是加速层：写不进去等于下次多探一次 /api/ps，绝不影响请求
    console.warn('[localModel] 状态文件写入失败（下次将重新探测，不影响对话）:', e?.message || e);
  }
}

function residentKey(root, model) {
  return `${root}|${normalizeModelName(model)}`;
}

function isResidentFresh(root, model, now = Date.now()) {
  loadState();
  const ts = Number(state.resident[residentKey(root, model)]) || 0;
  return ts > 0 && now - ts < RESIDENT_TTL_MS;
}

/** 模型刚刚成功作答 ⇒ 它必然在显存里。把这次事实记下来，后续 5 分钟免探测。 */
function markResident(baseUrl, model) {
  const root = ollamaRoot(baseUrl);
  if (!root || !model) return;
  loadState();
  const k = residentKey(root, model);
  const now = Date.now();
  const prev = Number(state.resident[k]) || 0;
  const sameLast = !!state.lastUsed
    && state.lastUsed.baseUrl === String(baseUrl) && state.lastUsed.model === String(model);
  state.resident[k] = now;
  // 顺手清过期项：否则这份文件会随时间无限长（每换一个模型名 +host 长一条）
  for (const [key, ts] of Object.entries(state.resident)) {
    if (!(Number(ts) > 0) || now - Number(ts) > RESIDENT_TTL_MS * 4) delete state.resident[key];
  }
  state.lastUsed = { baseUrl: String(baseUrl), model: String(model), at: now };
  // 一次 Agent 运行会连续成功十几次 chat，逐次同步写盘毫无收益（内容完全一样）：
  // 记录没变且 1 分钟内写过就跳过，只在「换了模型」时才落盘。
  if (!sameLast || now - prev > 60000) saveState();
}

function forgetResident(baseUrl, model) {
  const root = ollamaRoot(baseUrl);
  if (!root) return;
  loadState();
  delete state.resident[residentKey(root, model)];
  saveState();
}

// 连接层失败的特征（与 degrade.js 的 NETWORK_CODES 同族；这里不复用那个模块，
// 是因为它带「三连击熔断」的语义，而这里只要一个纯粹的分类判断）
const LINK_FAILURE_RE = /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network|超时|timeout/i;

/**
 * 一次 chat 失败后的维护：本机端点若在**连接层**失败（Ollama 被重启 / 被杀 / 端口换了），
 * 立刻作废「常驻」缓存。否则接下来 5 分钟内 ensureReady 会一直命中 cached ready，
 * 用户拿到的永远是那条原始报错，永远等不到「服务没起，执行 ollama serve」的友好提示——
 * 缓存把降级路径挡在门外的缺陷，比没有缓存更难查。
 */
function noteChatFailure(baseUrl, model, err) {
  const root = ollamaRoot(baseUrl);
  if (!root || !model) return;
  if (!LINK_FAILURE_RE.test(String(err?.message || err || ''))) return;
  forgetResident(baseUrl, model);
}

// ── I/O：带超时的 JSON 探测 ─────────────────────────────────────────────
let fetchImpl = (...args) => fetch(...args);

/**
 * 探测一个 JSON 端点。**三类失败必须分开**，否则上层会得出错误结论：
 *   · network=true  ——连接层失败（服务没起 / 端口错）→ 可以说「连不上」
 *   · status        ——HTTP 错误（404 表示「没这个接口」而不是「服务挂了」）
 *   · badJson=true  ——返回非 JSON（可能是别的后端）
 */
async function probeJson(url, { timeoutMs, signal, method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  // 「自己的计时器到点」必须与「连接层失败」分开记账：前者是**慢**，后者是**连不上**。
  // 混为一谈的后果不是文案难看，而是归因错误 —— 实测本套件第一版把 120s 加载超时
  // 报成了「服务没启动，请执行 ollama serve」，用户会去重启一个跑得好好的服务。
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(500, Number(timeoutMs) || TIERS.healthMs));
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res || typeof res.ok !== 'boolean') return { ok: false, network: true, error: '返回体异常' };
    if (!res.ok) return { ok: false, status: res.status };
    try {
      return { ok: true, status: res.status, json: await res.json() };
    } catch {
      return { ok: false, status: res.status, badJson: true };
    }
  } catch (e) {
    return {
      ok: false,
      network: true,
      timedOut,
      aborted: signal?.aborted === true,
      error: String(e?.cause?.code || e?.code || e?.message || e),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onOuterAbort);
  }
}

// ── 预热 / 就绪确认 ─────────────────────────────────────────────────────
// 正在进行的预热：同一个 (root|model) 并发只加载一次。预热是**重活**（读几十 GB），
// 一次 Agent 运行会连发十几次 chat，若每次都触发加载，Ollama 侧会互相踩。
const inflight = new Map();

// 在途探测/预热的「外部中止」钩子：停止按钮必须能打断这几分钟的等待，
// 否则用户点了停止还要干等两分钟（比原来的问题更让人恼火）。
const aborters = new Set();

function emitPhase(onPhase, payload) {
  if (typeof onPhase !== 'function') return;
  try { onPhase(payload); } catch { /* 进度回调异常绝不影响就绪流程 */ }
}

/**
 * 预热：把模型加载进显存并钉住（keep_alive:-1）。
 * 用 /api/generate + 空 prompt —— 这是 Ollama 官方推荐的「只加载不推理」姿势，
 * 请求在模型就绪后立刻返回，不会真的生成 token。
 * @returns {Promise<{ok:boolean, state:'ready'|'timeout'|'failed'|'unsupported', waitedMs:number}>}
 */
async function prewarm({ baseUrl, model, signal, onPhase, sizeBytes = 0 } = {}) {
  const root = ollamaRoot(baseUrl);
  const tiers = tierMs();
  if (!root || !model) return { ok: false, state: 'unsupported', waitedMs: 0 };
  // 只对**确认为 Ollama** 的端点发 /api/generate：非 11434 端口上可能是 LM Studio / llama.cpp /
  // 自建网关，给它们发 Ollama 私有接口是在别人的日志里制造 404 噪音。
  // ensureReady 走这条路时已把端点登记进 probedOllama（tags 探到了），所以这里不会误伤。
  if (!isOllamaLike(baseUrl)) return { ok: false, state: 'unsupported', waitedMs: 0 };
  const key = residentKey(root, model);
  if (inflight.has(key)) return inflight.get(key);

  // 自己的中止通道 + 调用方通道合并：abortAll()（停止按钮）与运行级 signal 都能打断
  const own = new AbortController();
  const stopOwn = () => own.abort();
  aborters.add(stopOwn);
  const merged = signal ? AbortSignal.any([own.signal, signal]) : own.signal;

  const job = (async () => {
    const startedAt = Date.now();
    let lastEmit = 0;
    const tick = setInterval(() => {
      const waited = Date.now() - startedAt;
      // 每 4s 报一次，避免把「预计还需」刷成噪音
      if (waited - lastEmit < 4000) return;
      lastEmit = waited;
      emitPhase(onPhase, {
        phase: 'loading', model, origin: root,
        waitedMs: waited, estRemainMs: estimateLoadMs(sizeBytes, waited).estRemainMs,
      });
    }, 1000);
    if (typeof tick.unref === 'function') tick.unref();
    emitPhase(onPhase, {
      phase: 'loading', model, origin: root, waitedMs: 0,
      estRemainMs: estimateLoadMs(sizeBytes, 0).estRemainMs,
    });
    try {
      const r = await probeJson(`${root}/api/generate`, {
        method: 'POST',
        timeoutMs: tiers.firstInferMs,
        signal: merged,
        body: { model, prompt: '', stream: false, keep_alive: KEEP_ALIVE_FOREVER },
      });
      const waitedMs = Date.now() - startedAt;
      if (r.ok) {
        probedOllama.add(root);
        markResident(baseUrl, model);
        emitPhase(onPhase, { phase: 'ready', model, origin: root, waitedMs, estRemainMs: 0 });
        return { ok: true, state: 'ready', waitedMs, sizeBytes };
      }
      if (r.status === 404) return { ok: false, state: 'unsupported', waitedMs, sizeBytes };
      // 超预算 ≠ 连不上：这是「还在读权重」，归 timeout，由上层翻译成「预计还需 N 秒」
      if (r.timedOut) return { ok: false, state: 'timeout', waitedMs, sizeBytes };
      if (r.network) return { ok: false, state: 'failed', waitedMs, sizeBytes, network: true, error: r.error, aborted: r.aborted };
      return { ok: false, state: 'failed', waitedMs, sizeBytes, status: r.status };
    } finally {
      clearInterval(tick);
      aborters.delete(stopOwn);
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/**
 * 发请求前的就绪确认（backend-aware readiness）。
 * 非本机端点：**同步直返**（`{state:'remote'}`），远端链路零行为变化、零额外延迟。
 * 本机端点：/api/tags（装没装）→ /api/ps（在不在显存）→ 不在就预热。
 * @returns {Promise<{state:string, waitedMs?:number, sizeBytes?:number}>}
 * @throws Error 带 code：LOCAL_BACKEND_DOWN / LOCAL_MODEL_MISSING / LOCAL_MODEL_LOADING
 */
async function ensureReady({ baseUrl, model, signal, onPhase } = {}) {
  const root = ollamaRoot(baseUrl);
  if (!root) return { state: 'remote' };
  const tiers = tierMs();
  if (!model) return { state: 'unknown' };
  if (isResidentFresh(root, model)) return { state: 'ready', cached: true };

  const own = new AbortController();
  const stopOwn = () => own.abort();
  aborters.add(stopOwn);
  const merged = signal ? AbortSignal.any([own.signal, signal]) : own.signal;
  const stopped = () => merged.aborted;
  const aborted = () => localError('ABORTED', '已中止本次请求');
  try {
    const tags = await probeJson(`${root}/api/tags`, { timeoutMs: tiers.listMs, signal: merged });
    if (!tags.ok) {
      if (stopped()) throw aborted();
      if (tags.network) {
        throw localError('LOCAL_BACKEND_DOWN', backendDownMessage(root, tags.error), { origin: root });
      }
      // 有 HTTP 响应但没有 /api/tags（404）= 这个端口上跑的不是 Ollama。
      // 此时**绝不能**说「服务连不上」——那会把「我用的 LM Studio」误导成「Ollama 没启动」。
      return { state: 'unknown', status: tags.status };
    }
    probedOllama.add(root);

    const ps = await probeJson(`${root}/api/ps`, { timeoutMs: tiers.healthMs, signal: merged });
    const ready = readinessOf({ tagsOk: true, tags: tags.json, psOk: ps.ok, ps: ps.json, model });

    if (ready.state === 'missing') {
      throw localError(
        'LOCAL_MODEL_MISSING',
        modelMissingMessage(model, ready.installedNames),
        { installedNames: ready.installedNames, model },
      );
    }
    if (ready.state === 'ready') {
      markResident(baseUrl, model);
      return { state: 'ready', sizeBytes: ready.sizeBytes };
    }
    // 'cold' 但这个后端没有 /api/ps（或这次探测失败）⇒ 我们并**没有**验证过它在不在显存里。
    // 此时去预热是拿猜测当事实：可能白读几十 GB，也可能把一个正常请求拖慢。
    // 因此按「未确认」放行，交给 chat 自身的首字节兜底（此时 firstByteBudget 不会收紧）。
    if (!ready.residentKnown) return { state: 'unknown', sizeBytes: ready.sizeBytes };

    // state === 'cold'：装好了但不在显存里 —— 这就是「一直重试然后无法访问」的现场。
    const warmed = await prewarm({ baseUrl, model, signal: merged, onPhase, sizeBytes: ready.sizeBytes });
    if (warmed.ok) return { state: 'ready', sizeBytes: ready.sizeBytes, waitedMs: warmed.waitedMs };
    if (stopped() || warmed.aborted) throw aborted();
    if (warmed.state === 'unsupported') return { state: 'unknown' };
    if (warmed.state === 'failed' && warmed.network) {
      throw localError('LOCAL_BACKEND_DOWN', backendDownMessage(root, warmed.error), { origin: root });
    }
    // 超预算（默认 120s）仍未加载完：不谎称「模型出错」，如实说「还在加载、大概还要多久」。
    // 这个 code 在 agent-core 侧被显式判为不可重试 —— 重试只会把同一段等待重放三遍。
    const est = estimateLoadMs(ready.sizeBytes, warmed.waitedMs);
    throw localError(
      'LOCAL_MODEL_LOADING',
      modelLoadingMessage(model, warmed.waitedMs, est.estRemainMs),
      { model, waitedMs: warmed.waitedMs, estRemainMs: est.estRemainMs, sizeBytes: ready.sizeBytes },
    );
  } finally {
    aborters.delete(stopOwn);
  }
}

/**
 * 启动预热：加载「上次用过的」本机模型。
 * 为什么是「上次用过的」而不是「配置里的第一个」：配置里可能有 5 个模型，
 * 全预热带 5×29GB 显存直接爆；而用户下次要用的极可能就是上次那个。
 * 首次运行没有记录 → 什么都不做（第一次对话由 ensureReady 顺带预热并记下来）。
 * @returns {Promise<{ok:boolean, reason?:string, model?:string}>}
 */
async function prewarmLastUsed({ onPhase } = {}) {
  loadState();
  const last = state.lastUsed;
  if (!last || !last.baseUrl || !last.model) return { ok: false, reason: 'no-history' };
  const root = ollamaRoot(last.baseUrl);
  if (!root) return { ok: false, reason: 'not-local' };
  if (isResidentFresh(root, last.model)) return { ok: true, reason: 'already-resident', model: last.model };
  try {
    const warmed = await prewarm({ baseUrl: last.baseUrl, model: last.model, onPhase });
    return { ok: !!warmed.ok, reason: warmed.state, model: last.model };
  } catch (e) {
    // 启动预热是**尽力而为**：失败只记日志，绝不阻断或拖慢启动
    console.warn('[localModel] 启动预热失败（不影响使用，首次对话会再试）:', e?.message || e);
    return { ok: false, reason: 'error', model: last.model };
  }
}

/** 中止全部在途就绪探测/预热（「停止」按钮必须能打断这几分钟的等待） */
function abortAll() {
  for (const fn of aborters) {
    try { fn(); } catch { /* 单个中止失败不影响其它 */ }
  }
  aborters.clear();
}

// 收紧上限：≈6k token 量级。用字符数而不是 token 数，是因为这里拿不到分词器，
// 而「量级判断」不需要精确值 —— 4 万字符以下的 prefill 在本机模型上是秒级。
// 声明放在使用它的函数**之前**：本项目吃过「常量在下方声明、上方函数直接引用」的 TDZ 亏。
const WARM_TIGHTEN_MAX_CHARS = 24000;

/** 估算本次 prompt 的字符体量（超上限即早退，不为超长对话白算） */
function promptChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) if (typeof part?.text === 'string') n += part.text.length;
    }
    if (n > WARM_TIGHTEN_MAX_CHARS) return n;
  }
  return n;
}

/**
 * 本次请求的首字节预算。
 * 已确认常驻（预热过 / 上一条回复刚成功）⇒ 收紧到「已常驻档」：常驻模型这么久没首字节
 * 就是真挂起，没必要陪它耗 300s。未确认时保持调用方给的兜底值不动。
 *
 * **但收紧有个前提：prompt 不大。** 2026-11-03 的实测证据（trace `run-mw0avr8b-1i5hpv`）：
 * model=flint、prompt ≈ 7.7 万 token，round 1 在 90014ms 被首字节守卫杀掉且 prompt_tokens=0 ——
 * 那不是挂起，是**本机 prefill 的物理时间**（比云端排队差一个数量级）。
 * 模型常驻只消除了「加载权重」的时间，prefill 仍随 prompt 线性增长。若对长 prompt 也收紧到 60s，
 * 就是把已修好的缺陷原样引回来（用户表现为「一开始打字就失败」）。
 * 所以这里按 prompt 体量分档：短 prompt 收紧，长 prompt 一律不下调。
 * @param {number} fallbackMs streamGuard 给出的档位值
 * @param {string} baseUrl 端点
 * @param {string} model 模型名
 * @param {Array} [messages] 本次要发的消息（用于估算 prefill 体量）
 */
function firstByteBudget(fallbackMs, baseUrl, model, messages) {
  const root = ollamaRoot(baseUrl);
  if (!root || !model) return fallbackMs;
  if (!isResidentFresh(root, model)) return fallbackMs;
  if (promptChars(messages) > WARM_TIGHTEN_MAX_CHARS) return fallbackMs;
  const warm = tierMs().inferMs;
  return Math.min(Number(fallbackMs) || warm, warm);
}

// ── 测试注入 ────────────────────────────────────────────────────────────
// 只给测试用：替换 fetch、状态文件路径、清空常驻缓存与在途表。
function __test__configure({ fetchMock, dir, tiers } = {}) {
  if (fetchMock) fetchImpl = fetchMock;
  tierOverride = tiers || null;
  if (dir !== undefined) {
    state = { lastUsed: null, resident: {} };
    stateLoaded = false;
    stateFile = dir ? path.join(dir, 'local-model.json') : '';
    // 清掉上一轮留下的状态文件：否则 stateLoaded=false 会让 loadState() 把上个用例的
    // 常驻记录读回来，用例之间互相污染（实测：三个用例因此假绿/假红）。
    if (stateFile) { try { fs.unlinkSync(stateFile); } catch { /* 本来就不存在 */ } }
    // 显式给了 dir 就锁定，别再被延迟解析覆盖（dir='' = 测试要求不落盘）
    stateInitTried = true;
  }
  probedOllama.clear();
  inflight.clear();
  aborters.clear();
}

function initLocalModel({ dataDir } = {}) {
  const dir = dataDir || defaultDataDir();
  stateFile = dir ? path.join(dir, 'local-model.json') : '';
  stateLoaded = false;
  stateInitTried = true;
}

module.exports = {
  // 配置
  initLocalModel, tierMs, TIERS, TIER_BOUNDS, KEEP_ALIVE_FOREVER,
  // 端点 / 请求体
  ollamaRoot, isOllamaLike, chatHints,
  // 纯逻辑
  normalizeModelName, matchesModel, readinessOf, estimateLoadMs,
  // 文案
  backendDownMessage, modelMissingMessage, modelLoadingMessage,
  // 流程
  ensureReady, prewarm, prewarmLastUsed, abortAll, firstByteBudget,
  // 状态
  markResident, forgetResident, noteChatFailure, isResidentFresh, RESIDENT_TTL_MS,
  __test__configure,
};
