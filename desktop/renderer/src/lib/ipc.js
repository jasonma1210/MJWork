// IPC 统一出口（S1 收口）：组件层不再裸调 window.mjcode
// 约定：
//   1) preload / main 零改动，仅在其上做包装；
//   2) 统一返回 { ok, data, error }，调用方不再记忆 4 种返回值契约；
//   3) 统一超时与错误归一（离线/冻结态下表现一致，消灭静默失败）；
//   4) 能力矩阵集中声明（消费 app:flags），冻结功能不再散落可选链判断。
import { tGlobal } from '../i18n';

const DEFAULT_TIMEOUT = 30000;

const mj = () => (typeof window !== 'undefined' ? window.mjcode : null);

// 能力矩阵：默认 fail-closed（未探测到时按不可用处理）
let caps = { collab: false, cloud: false, miniprogram: false, cua: true, ecosystem: true, probed: false };

export function getCaps() {
  return { ...caps };
}

export async function loadCaps() {
  const api = mj();
  if (!api || typeof api.getFlags !== 'function') return caps;
  try {
    const r = await api.getFlags();
    if (r && r.ok && r.flags) caps = { ...caps, ...r.flags, probed: true };
  } catch (e) {
    console.warn('[ipc] failed to load feature flags:', e.message);
  }
  return caps;
}

export function hasCap(name) {
  return caps[name] === true;
}

// 超时包装：到点返回结构化错误，不抛异常
// C-004：与其它模块同名但**语义不同**（返回/抛错形态不一样），别为「看起来重复」而合并。
function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, data: null, error: tGlobal('runtime.requestTimeout'), timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(timer); resolve(normalize(v)); })
      .catch((e) => { clearTimeout(timer); resolve({ ok: false, data: null, error: e && e.message ? e.message : tGlobal('runtime.callFailed') }); });
  });
}

// 归一：{ok,...} / 数组 / {error} / 裸值 → {ok,data,error}
function normalize(v) {
  if (v && typeof v === 'object') {
    if (typeof v.ok === 'boolean') return { ok: v.ok, data: v, error: v.ok ? null : (v.error || tGlobal('runtime.callFailed')) };
    if (v.error) return { ok: false, data: v, error: v.error };
    return { ok: true, data: v, error: null };
  }
  if (Array.isArray(v)) return { ok: true, data: v, error: null };
  return { ok: true, data: v, error: null };
}

// 调用主进程能力：call('readFile', { path })
export async function call(method, payload, { timeout = DEFAULT_TIMEOUT } = {}) {
  const api = mj();
  if (!api || typeof api[method] !== 'function') {
    // X23：方法名拼错与「平台不支持」在运行时长得一样。开发期把拼写嫌疑显式打出来，
    // 生产环境保持静默降级（不惊动用户）。桥面清单以 main/preload.js 为准。
    if (import.meta?.env?.DEV) {
      console.warn(`[ipc] bridge method not found: ${method} — check main/preload.js (typo guard: test/bridge-parity.test.mjs runs in CI)`);
    }
    return { ok: false, data: null, error: tGlobal('runtime.capabilityUnavailable', { method }) };
  }
  try {
    return await withTimeout(api[method](payload), timeout);
  } catch (e) {
    return { ok: false, data: null, error: e && e.message ? e.message : tGlobal('runtime.callFailed') };
  }
}

// 事件订阅：统一返回取消函数，避免 StrictMode 下重复注册
export function on(eventMethod, cb) {
  const api = mj();
  if (!api || typeof api[eventMethod] !== 'function') return () => {};
  try {
    const off = api[eventMethod](cb);
    return typeof off === 'function' ? off : () => {};
  } catch (e) {
    console.warn('[ipc] event subscribe failed:', eventMethod, e.message);
    return () => {};
  }
}

export default { call, on, loadCaps, getCaps, hasCap };
