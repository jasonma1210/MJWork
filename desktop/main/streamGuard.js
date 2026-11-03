'use strict';
// 流式守卫：首字节 / 空闲 / 单轮总时长 三层计时（2026-10-17 T1）
//
// 为什么不能只有「一把总时长尺」：
//   推理模型（mimo / DeepSeek-R 系）先输出 reasoning_content，正文姗姗来迟；
//   有些 OpenAI 兼容端点连 keep-alive 注释都不发。用总时长判断「卡死」，
//   会在模型**正常思考**时把人杀掉（线上表现：打字打到一半整轮作废）。
//   正确语义是「多久没有动静」：只要还有数据在动就一直等，真正没动静才断。
//
// 三层各司其职：
//   1) firstByte：连接已建立但一个字节都没回（排队 / 网关缓冲 / 上游挂起）——
//      这一层能给出比「无响应」更准确的归因。
//   2) idle：已经在流，但连续 N 毫秒没有任何数据（含 reasoning、tool_calls 分片、SSE 注释行）。
//   3) total：无限流兜底，防止「一直在动但永远不结束」把窗口占死。
//
// 设计约束：
//   - 纯计时器，零 electron / 零网络依赖，便于单测（test/stream-guard.test.mjs）。
//   - 任一层传 <=0 视为禁用该层（测试与特殊供应商可用）。
//   - onFire 只触发一次；触发后守卫自动停止，调用方负责 abort 真正的连接。
//   - 空闲检测**不能**靠调用方在读循环里「有数据就重置」——真挂起时循环停在
//     await，永远走不到重置那一步。这里用独立 tick 比对 lastActivityAt。

const DEFAULTS = {
  firstByteMs: 90000,   // 90s：够覆盖排队 + 冷启动 prefill
  idleMs: 300000,       // 5min：对齐 Claude Code（CLAUDE_STREAM_IDLE_TIMEOUT_MS）与 Codex（stream_idle_timeout_ms）
  totalMs: 900000,      // 15min：只做无限流兜底，正常永远碰不到
};

// 本机推理端点（ollama 等）的独立档位。
//
// 为什么必须分开（2026-11-03 实证，trace `run-mw0avr8b-1i5hpv`）：
//   model=flint（`localhost:11434` = Ollama，29GB 本地模型），prompt ≈ 7.7 万 token，
//   round 1 在 **90014ms** 被首字节守卫杀掉，`prompt_tokens=0` —— 模型连 prefill 都没跑完。
//   用户看到的是「（本次请求失败，未产生回复）」，而他自己的诊断是「超过 ollama 输出限制」。
//   实测 `GET /api/show` 该模型 `num_ctx=262144`：既不是输出限制，也不是窗口不足，
//   就是**本地 prefill 的时间尺度**与云端（排队 1~30s）差一个数量级。
//
// 三档取值依据：
//   · firstByte 300s：29GB / 25 万上下文模型在 48GB 机器上 prefill 数万 token，分钟级是常态；
//   · idle 600s：流式出字期间若 10 分钟没有任何字节，才真的是挂死；
//   · total 30min：本地 offload 到 CPU 时整轮可能接近半小时，超过就属于病态。
// 用户显式设置仍然优先（streamSettings）：这里是**默认档**，不是上限。
const LOCAL_DEFAULTS = {
  firstByteMs: 300000,
  idleMs: 600000,
  totalMs: 1800000,
};

// 回环地址才算「本机端点」。局域网/内网服务器（10.x / 192.168.x）不算：
// 它们通常是一台独立机器，prefill 行为更接近云端，误判成 300s 会让真正的挂死晚 3 分钟才被看见。
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/i;

/**
 * 是否本机推理端点（决定用哪一档默认超时）。
 * 解析失败/空值一律按「非本地」处理 —— 宁可少给 3 分钟，也不要把云端请求挂到 5 分钟。
 */
function isLocalEndpoint(baseUrl) {
  try {
    return LOCAL_HOST_RE.test(new URL(String(baseUrl || '')).hostname);
  } catch {
    // 非法/相对 URL：无法判定，按云端档处理（保守）
    return false;
  }
}

const TICK_MS = 5000;

// P2-2b：首字节延迟目标（只做**告警阈值**，绝不参与任何闸门判定）。
// 把可观测指标做成闸门会引入新的误杀——推理模型首字节本来就慢（见文件头 2026-10-17 的踩坑记录）。
// 3s 是交互式 AI 产品的常见 SLO 基线。
const TTFB_TARGET_MS = 3000;
// 本机模型的首字节目标：29GB 级模型冷启动 + prefill 十几秒是正常的，用 3s 去衡量只会每轮刷一条
// 「超过目标」的噪音日志（用户实测正是这样误判成"对接不上大模型"）。
const TTFB_TARGET_LOCAL_MS = 15000;

/** 该端点的首字节告警目标（只影响日志，不影响任何闸门） */
function ttfbTargetFor(baseUrl) {
  return isLocalEndpoint(baseUrl) ? TTFB_TARGET_LOCAL_MS : TTFB_TARGET_MS;
}

const ENV_KEYS = {
  firstByteMs: 'MJ_STREAM_FIRST_BYTE_MS',
  idleMs: 'MJ_STREAM_IDLE_MS',
  totalMs: 'MJ_STREAM_TOTAL_MS',
};

function readEnvMs(env, key, fallback) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 环境变量覆盖（不引入 UI 设置项前的临时旋钮；<=0 或非法值回落默认）
// local=true 时基准换成 LOCAL_DEFAULTS（本机推理端点），环境变量仍然可以覆盖。
function resolveDefaults(env = process.env, { local = false } = {}) {
  const base = local ? LOCAL_DEFAULTS : DEFAULTS;
  return {
    firstByteMs: readEnvMs(env, ENV_KEYS.firstByteMs, base.firstByteMs),
    idleMs: readEnvMs(env, ENV_KEYS.idleMs, base.idleMs),
    totalMs: readEnvMs(env, ENV_KEYS.totalMs, base.totalMs),
  };
}

/**
 * @param {object} opts
 * @param {number} [opts.firstByteMs] 首字节上限，<=0 禁用
 * @param {number} [opts.idleMs] 空闲上限，<=0 禁用
 * @param {number} [opts.totalMs] 总时长上限，<=0 禁用
 * @param {number} [opts.tickMs] 检查间隔（测试注入小值）
 * @param {(reason:'first-byte'|'idle'|'total', info:object)=>void} [opts.onFire]
 */
function createStreamGuard(opts = {}) {
  const cfg = { ...resolveDefaults(), ...opts };
  const tickMs = Math.max(5, Number(cfg.tickMs) || TICK_MS);
  const now = typeof cfg.now === 'function' ? cfg.now : Date.now;

  const state = {
    started: false,
    stopped: false,
    firedReason: null,
    startedAt: 0,
    firstByteAt: 0,
    lastActivityAt: 0,
  };

  let firstByteTimer = null;
  let tickTimer = null;

  const fire = (reason, info) => {
    if (state.firedReason || state.stopped) return; // 只触发一次
    state.firedReason = reason;
    stop();
    try { cfg.onFire?.(reason, info); } catch { /* 回调异常绝不影响计时器清理 */ }
  };

  const stop = () => {
    state.stopped = true;
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  };

  const startTick = () => {
    if (tickTimer || state.stopped) return;
    tickTimer = setInterval(() => {
      if (state.stopped) return;
      const t = now();
      // 总时长优先判：它比空闲更"硬"，同一时刻命中时给出更明确的归因
      if (cfg.totalMs > 0 && t - state.startedAt > cfg.totalMs) {
        fire('total', { elapsedMs: t - state.startedAt, totalMs: cfg.totalMs });
        return;
      }
      if (cfg.idleMs > 0 && t - state.lastActivityAt > cfg.idleMs) {
        fire('idle', { idleMs: t - state.lastActivityAt, limitMs: cfg.idleMs });
      }
    }, tickMs);
    if (typeof tickTimer.unref === 'function') tickTimer.unref(); // 不阻止进程退出
  };

  return {
    /** 发起请求前调用：开始首字节计时 */
    start() {
      if (state.started) return this;
      state.started = true;
      state.stopped = false;
      state.startedAt = now();
      state.lastActivityAt = state.startedAt;
      if (cfg.firstByteMs > 0) {
        firstByteTimer = setTimeout(() => {
          fire('first-byte', { waitedMs: now() - state.startedAt, limitMs: cfg.firstByteMs });
        }, cfg.firstByteMs);
        if (typeof firstByteTimer.unref === 'function') firstByteTimer.unref();
      }
      startTick();
      return this;
    },

    /** 收到响应头（fetch resolve）：首字节达成，转入空闲计时 */
    firstByte() {
      if (state.stopped) return this;
      state.firstByteAt = now();
      state.lastActivityAt = state.firstByteAt;
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      return this;
    },

    /**
     * 收到任何数据（正文 delta / reasoning_content / tool_calls 分片 / SSE 注释行）：
     * 重置空闲计时。若还没标记 firstByte，这里顺手补上（防御：某些实现拿不到 headers 时机）。
     */
    touch() {
      if (state.stopped) return this;
      state.lastActivityAt = now();
      if (!state.firstByteAt) this.firstByte();
      return this;
    },

    stop,

    /** 已触发的原因；null 表示未触发。调用方在 catch 里据此产出准确文案 */
    reason: () => state.firedReason,
    /**
     * P2-2b：首字节耗时（start → firstByte 的毫秒差）。
     * 未 start、或首字节尚未达成时返回 null——宿主附加字段缺失必须可容忍。
     */
    ttfbMs() {
      if (!state.started || !state.firstByteAt) return null;
      return state.firstByteAt - state.startedAt;
    },
    stats: () => ({ ...state }),
    config: () => ({ firstByteMs: cfg.firstByteMs, idleMs: cfg.idleMs, totalMs: cfg.totalMs, tickMs }),
  };
}

/**
 * P2-2b：首字节超目标时告警（只告警、不阻断）。
 * 与「超时判死」严格分离：这里绝不 abort 连接，否则会把「推理模型想得久」误杀成失败。
 * @param {number|null} ttfbMs
 * @param {string} [label] 通道标识（如 'scheduled'），便于日志定位
 * @param {number} [targetMs] 告警目标（本机端点用 ttfbTargetFor(baseUrl)，缺省 3s）
 */
function reportSlowTtfb(ttfbMs, label = '', targetMs = TTFB_TARGET_MS) {
  if (ttfbMs === null || ttfbMs === undefined) return;
  const target = Number(targetMs) > 0 ? Number(targetMs) : TTFB_TARGET_MS;
  if (ttfbMs <= target) return;
  console.warn(`[ttfb] 首字节 ${Math.round(ttfbMs)}ms 超过目标 ${target}ms${label ? `（通道：${label}）` : ''}——仅告警，不参与任何闸门判定`);
}

// 超时错误文案：三种原因各说人话，别把「模型在想」说成「无响应」
function streamTimeoutMessage(reason, cfg = {}) {
  const sec = (ms) => `${Math.round(Number(ms || 0) / 1000)}s`;
  if (reason === 'first-byte') {
    return `连接已建立，但 ${sec(cfg.firstByteMs)} 内没有收到任何数据（供应商可能在上游排队，或网关在缓冲完整响应）。已中断本次请求，可稍后重试。`;
  }
  if (reason === 'idle') {
    return `模型输出中断：已连续 ${sec(cfg.idleMs)} 没有收到任何数据（生成阶段挂起/连接半开）。已中断本次请求；可发送「继续」从断点续跑。`;
  }
  if (reason === 'total') {
    return `本轮模型调用超过 ${sec(cfg.totalMs)} 总上限，已中断（防止无限流占住会话）。若这是正常的长任务，请把 MJ_STREAM_TOTAL_MS 调大。`;
  }
  return '';
}

module.exports = {
  createStreamGuard, streamTimeoutMessage, resolveDefaults, reportSlowTtfb,
  DEFAULTS, LOCAL_DEFAULTS, ENV_KEYS, TTFB_TARGET_MS, TTFB_TARGET_LOCAL_MS,
  isLocalEndpoint, ttfbTargetFor,
};
