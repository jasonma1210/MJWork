// P3-1/P3-2/P3-3：ResourceQuotaCenter——唯一可信资源快照 + 槽位预占 + 预算隔离 + 节流状态机
// 指标按 Backend 类型多态（计划 1.4-#3 裁定）：
//   Cloud（现状主力）：并发请求数 / provider + 前台预占槽位 + 错误连击熔断
//   Local（P3-4）：预留探测位（detectOllama），槽位语义=推理并发
// 前台/后台隔离（P3-2）：
//   fg = 用户会话 / Worker 子任务 / 定时任务（用户可感知的一切）
//   bg = 记忆压缩等后台作业；bg 可用槽位 = limit - fgReserve（前台永远保留 fgReserve 个槽位）
// 节流状态机（P3-3）：
//   idle     fg 在飞 0 个               → bg 正常
//   busy     fg 在飞 > 0                → bg 最多同时 1 个（让路）
//   overload 连续错误 ≥ 阈值 → 熔断 5 分钟 → bg 全停，fg 照常（用户自己会看到错误）
// 可观测（P3-5）：snapshot() 供渲染层轮询；'change' 事件供后续事件驱动升级。
const { EventEmitter } = require('events');

const OVERLOAD_THRESHOLD = 5;      // 连续错误次数 → 熔断
const OVERLOAD_COOLDOWN_MS = 5 * 60 * 1000;

// P0-1⑤: Ollama 上下文窗口探测常量
// H-1：官方 `OLLAMA_CONTEXT_LENGTH` 代码默认 0=未指定，运行时按显存自适应 4k/32k/256k
// → 任何写死的窗口值都是错的，唯一可信来源是 /api/show 里模型自身的 num_ctx（运行时实际值）。
const OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_PROBE_TIMEOUT_MS = 1500;   // 探测只做尽力而为：超时短，失败静默降级，绝不拖慢启动
const OLLAMA_NUM_CTX_FALLBACK = 4096;   // 探测失败取值 = 官方最小档（宁低不高）
const OLLAMA_PROBE_MAX_MODELS = 12;     // 单次最多探测的模型数（模型库很大时也不拖时间）

// `parameters` 是 Ollama 的换行分隔文本（如 "num_ctx\t32768"），取 num_ctx 行
function parseNumCtx(parameters) {
  if (typeof parameters !== 'string' || !parameters) return 0;
  const m = parameters.match(/^[ \t]*num_ctx[ \t]+(\d+)[ \t]*$/m);
  return m ? Number(m[1]) : 0;
}

// `model_info` 的上下文长度键是**架构键**（llama.context_length / qwen2.context_length），
// 不是 general.*（general.architecture 只给架构名）。H-1 明确点出这个坑。
function parseContextLength(modelInfo) {
  if (!modelInfo || typeof modelInfo !== 'object') return 0;
  const arch = typeof modelInfo['general.architecture'] === 'string' ? modelInfo['general.architecture'] : '';
  if (arch) {
    const v = Number(modelInfo[`${arch}.context_length`]);
    if (v > 0) return v;
  }
  for (const [k, v] of Object.entries(modelInfo)) {
    if (/\.context_length$/.test(k) && Number(v) > 0) return Number(v);
  }
  return 0;
}

class ResourceQuotaCenter extends EventEmitter {
  constructor({ providerLimit = 8, fgReserve = 2 } = {}) {
    super();
    this.providerLimit = Math.max(1, Number(providerLimit) || 8);
    this.fgReserve = Math.max(0, Number(fgReserve) || 2);
    this.providers = new Map(); // providerId → { inFlightFg, inFlightBg, errStreak, openUntil }
    this.localBackend = null;   // P3-4：{ ollama: bool, models: n, checkedAt }
  }

  _provider(id) {
    const key = String(id || 'default');
    if (!this.providers.has(key)) {
      this.providers.set(key, { inFlightFg: 0, inFlightBg: 0, errStreak: 0, openUntil: 0 });
    }
    return this.providers.get(key);
  }

  // ── 槽位获取（P3-2 槽位预占）──
  // 返回 { release() }；等待超时仍拿不到 → 抛错（调用方决定降级；fg 超时罕见=真过载）
  async acquire(kind, providerId, { timeoutMs = 30000 } = {}) {
    const p = this._provider(providerId);
    const isFg = kind !== 'bg';
    const start = Date.now();
    // 等待循环：前台优先——bg 不仅要看总量，还要给 fg 留 fgReserve 个空位
    for (;;) {
      const total = p.inFlightFg + p.inFlightBg;
      const breakerOpen = p.openUntil > Date.now();
      if (isFg) {
        // P0-1：前台**不受**熔断门禁约束 —— 熔断只降级可牺牲的后台流量。
        // 此前 fg 分支被包在 !breakerOpen 内：provider 连续 5 次错误后，用户主会话 /
        // 手动派活 / 定时任务全部在 5 分钟里干等 30s 再抛「资源槽位等待超时…熔断中」，
        // 用户感知是「应用整体卡死」。而本文件头规格写的是「bg 全停，fg 照常（用户自己会看到错误）」。
        if (total < this.providerLimit) { p.inFlightFg += 1; break; }
      } else if (!breakerOpen) {
        const bgCeiling = this.providerLimit - this.fgReserve; // 预算隔离：bg 不吃预留槽
        const bgRunning = p.inFlightBg;
        const busy = p.inFlightFg > 0;
        const bgCap = busy ? Math.min(1, bgCeiling) : bgCeiling; // busy 态 bg 让路（P3-3）
        if (bgRunning < bgCap) { p.inFlightBg += 1; break; }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`资源槽位等待超时（${kind}/${providerId}，limit=${this.providerLimit}${breakerOpen ? '，熔断中' : ''}）`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    this.emit('change', this.snapshot());
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (isFg) p.inFlightFg = Math.max(0, p.inFlightFg - 1);
        else p.inFlightBg = Math.max(0, p.inFlightBg - 1);
        this.emit('change', this.snapshot());
      },
    };
  }

  // ── 错误连击熔断（P3-3 overload）──
  reportError(providerId) {
    const p = this._provider(providerId);
    p.errStreak += 1;
    if (p.errStreak >= OVERLOAD_THRESHOLD && p.openUntil <= Date.now()) {
      p.openUntil = Date.now() + OVERLOAD_COOLDOWN_MS;
      this.emit('overload', { providerId, cooldownMs: OVERLOAD_COOLDOWN_MS });
    }
    this.emit('change', this.snapshot());
  }

  reportSuccess(providerId) {
    const p = this._provider(providerId);
    p.errStreak = 0;
    p.openUntil = 0;
  }

  // bg 任务是否放行（MemoryBgScheduler 每次领取前询问）
  bgAllowed() {
    for (const p of this.providers.values()) {
      if (p.openUntil > Date.now()) return false; // 任一 provider 熔断中 → bg 全停
    }
    return true;
  }

  throttleState() {
    let busy = false;
    let overloaded = false;
    for (const p of this.providers.values()) {
      if (p.inFlightFg > 0) busy = true;
      if (p.openUntil > Date.now()) overloaded = true;
    }
    return overloaded ? 'overloaded' : busy ? 'busy' : 'idle';
  }

  // ── 统一快照（P3-1/P3-5：渲染层唯一可信资源视图）──
  snapshot() {
    const providers = {};
    for (const [id, p] of this.providers) {
      providers[id] = {
        fg: p.inFlightFg, bg: p.inFlightBg, limit: this.providerLimit,
        errStreak: p.errStreak, breakerOpen: p.openUntil > Date.now(),
      };
    }
    return {
      providers,
      throttle: this.throttleState(),
      localBackend: this.localBackend,
      ts: Date.now(),
    };
  }

  // ── P3-4：本地后端探测（Ollama）——探测结果进快照；接入方式=自定义 provider（baseUrl http://localhost:11434/v1）──
  // P0-1⑤: 同时探测每个模型的真实上下文窗口（num_ctx 优先 / model_info.<arch>.context_length 次之）。
  // 全部失败静默降级为 4096（fallback-4k），不影响 ollama 可用性判断。
  async probeOllamaWindows(names) {
    const targets = (names || []).slice(0, OLLAMA_PROBE_MAX_MODELS);
    const probeOne = async (name) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), OLLAMA_PROBE_TIMEOUT_MS);
      try {
        let res = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
          signal: ctrl.signal,
        });
        // 老版本 Ollama 只接受 GET /api/show?name=…（POST 回 404/405）
        if (!res.ok && (res.status === 404 || res.status === 405)) {
          res = await fetch(`${OLLAMA_BASE_URL}/api/show?name=${encodeURIComponent(name)}`, { signal: ctrl.signal });
        }
        if (!res.ok) return { name, numCtx: OLLAMA_NUM_CTX_FALLBACK, contextLength: 0, source: 'fallback-4k' };
        const j = await res.json().catch(() => ({}));
        const numCtx = parseNumCtx(j?.parameters);
        const contextLength = parseContextLength(j?.model_info);
        if (numCtx > 0) return { name, numCtx, contextLength, source: 'api-show' };
        // num_ctx 未显式设置时，模型上限（contextLength）不是运行时生效值 → 仍按最小档保守处理，
        // 但把上限一并发出去，便于 UI 提示「可校正到 N」（P1-12 的一键校正入口）
        return { name, numCtx: OLLAMA_NUM_CTX_FALLBACK, contextLength, source: 'fallback-4k' };
      } catch { /* C-001：探测单个模型窗口失败 ⇒ 按最小档保守处理；返回体的 source='fallback-4k' 就是给 UI 的形态 */
        return { name, numCtx: OLLAMA_NUM_CTX_FALLBACK, contextLength: 0, source: 'fallback-4k' };
      } finally {
        clearTimeout(timer);
      }
    };
    // 并行探测：总耗时被单次超时界定（≤1.5s），不会随模型数线性增长
    return Promise.all(targets.map(probeOne));
  }

  async detectLocalBackend() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const names = (j.models || []).map((m) => String(m?.name || m?.model || '')).filter(Boolean);
        const modelWindows = await this.probeOllamaWindows(names);
        // 字段说明：models 保持「数量」语义（AgentDock.jsx:484 直接当计数渲染，改数组会显示 [object Object]）；
        // 窗口明细放 modelWindows，逐项 { name, numCtx, contextLength, source }。
        this.localBackend = { ollama: true, models: names.length, modelWindows, checkedAt: Date.now() };
      } else { this.localBackend = { ollama: false, models: 0, modelWindows: [], checkedAt: Date.now() }; }
    } catch (e) { /* C-001：整体探测失败 ≠ 没装 Ollama；这里却会对外断言 ollama:false，UI 会显示「未检测到本机模型」 */
      console.warn('[quota] 本机模型探测失败，本次按「未检测到」上报（不代表真的没装）:', e?.message || e);
      this.localBackend = { ollama: false, models: 0, modelWindows: [], checkedAt: Date.now() };
    }
    this.emit('change', this.snapshot());
    return this.localBackend;
  }
}

module.exports = { ResourceQuotaCenter, OVERLOAD_THRESHOLD, OVERLOAD_COOLDOWN_MS };
