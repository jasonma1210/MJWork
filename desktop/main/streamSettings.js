'use strict';
// T6（2026-10-17）：三层流式超时的用户设置项（设置页可改，落本机偏好）。
//
// 为什么要有设置项：不同供应商的正常单轮时长差一个数量级——
//   推理模型（mimo）思考 3 分钟很常见，而某些端点 30s 就出结果。
//   写死一个数字必然有一边被误杀，所以把"多久算卡死"交给用户。
//
// 优先级：用户设置 > 环境变量 > 内置默认（三者都能救急，但用户设置最直观）。
//
// 2026-11-03：默认档按端点分两组 —— 云端（90s/300s/15min）与本机推理端点（300s/600s/30min）。
// 依据见 main/streamGuard.js 的 LOCAL_DEFAULTS 注释（ollama 29GB 模型 prefill 数万 token 是分钟级，
// 90s 首字节必然误杀）。**用户显式设置永远优先**：这里只影响「没设过」的那一档。
//   - 用户设置：localStore.preferences['stream_timeouts']（设置页写入并同步）
//   - 环境变量：MJ_STREAM_FIRST_BYTE_MS / MJ_STREAM_IDLE_MS / MJ_STREAM_TOTAL_MS
//   - 默认：streamGuard.DEFAULTS（90s / 300s / 900s）
//
// 校验纪律（两条，缺一不可）：
//   1) 越界**收敛**而不是丢弃：用户填 5 秒显然是想"更快失败"，但 5 秒会把正常请求也杀光，
//      所以收到下限并在 UI 上回显生效值——比静默忽略更诚实。
//   2) 非法值（NaN / 负数 / 字符串 / null）回落下一优先级，绝不把 0 当成"禁用"：
//      UI 里没有禁用语义，0 只可能是手滑。
const {
  DEFAULTS, LOCAL_DEFAULTS, resolveDefaults: resolveEnvOrDefaults, isLocalEndpoint,
} = require('./streamGuard');

// 区间刻意留宽：下限只挡住"手滑成 1 秒"，上限挡住"填 24 小时把连接占死"
const BOUNDS = {
  firstByteMs: { min: 10000, max: 600000 },   // 10s ~ 10min
  idleMs: { min: 30000, max: 1800000 },       // 30s ~ 30min
  totalMs: { min: 60000, max: 7200000 },      // 1min ~ 2h
};
const KEYS = ['firstByteMs', 'idleMs', 'totalMs'];

let getLocalStore = () => null;

function initStreamSettings(deps = {}) {
  // 只存 getter：localStore 在 whenReady 之后才有值
  getLocalStore = typeof deps.getLocalStore === 'function' ? deps.getLocalStore : () => null;
}

function readPersisted() {
  try {
    const v = getLocalStore()?.getPreference?.('stream_timeouts');
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    // 读设置失败不能反过来把超时改短：回落环境变量/默认
    console.warn('[streamSettings] 读取流式超时设置失败，回落默认:', e.message);
    return {};
  }
}

/** 单值校验：非法返回 null（由调用方回落），合法则收敛到区间内 */
function clampMs(key, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const b = BOUNDS[key];
  if (!b) return null;
  return Math.min(b.max, Math.max(b.min, Math.round(n)));
}

/**
 * 当前生效的三层超时（所有请求路径都读这里，改设置立即生效，无需重启）。
 * @param {{ baseUrl?: string, local?: boolean }} [opts]
 *   baseUrl 指向本机（localhost/127.0.0.1）时默认档换成 LOCAL_DEFAULTS；显式 local 优先。
 */
function getStreamTimeouts(opts = {}) {
  const local = typeof opts.local === 'boolean' ? opts.local : isLocalEndpoint(opts.baseUrl);
  const fallback = resolveEnvOrDefaults(process.env, { local });
  const saved = readPersisted();
  const out = {};
  for (const k of KEYS) {
    const clamped = clampMs(k, saved[k]);
    out[k] = clamped != null ? clamped : fallback[k];
  }
  return out;
}

/** 设置页用：生效值 + 来源 + 可调区间 + 默认值（前端不再硬编码任何数字） */
function getStreamSettingsView() {
  const envOrDefaults = resolveEnvOrDefaults();
  const saved = readPersisted();
  const effective = getStreamTimeouts();
  const source = {};
  for (const k of KEYS) {
    if (clampMs(k, saved[k]) != null) source[k] = 'user';
    else if (envOrDefaults[k] !== DEFAULTS[k]) source[k] = 'env';
    else source[k] = 'default';
  }
  // localDefaults 一并给出：设置页需要能说清「用本机模型时默认是多久」，
  // 否则用户看到 90s 会以为本地模型也会 90s 就断（实际走 300s 档）。
  return { effective, source, bounds: BOUNDS, defaults: { ...DEFAULTS }, localDefaults: { ...LOCAL_DEFAULTS } };
}

module.exports = {
  initStreamSettings,
  getStreamTimeouts,
  getStreamSettingsView,
  clampMs,
  BOUNDS,
  KEYS,
};
