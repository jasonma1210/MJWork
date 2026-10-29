// 模型级配置（思考强度 / 上下文窗口），localStorage 持久化，按 provider+model 定位
// 结构：{ [modelKey]: { reasoning_effort: ''|'low'|'medium'|'high', context_window: 0|number } }
// '' / 0 表示跟随服务端默认（不下发参数）

import { tGlobal } from '../i18n';
import { resolveWindow, DEFAULT_CONTEXT_WINDOW } from './modelWindows';

const STORE_KEY = 'mj_model_configs';
// P1-11：任务-模型分档（可选 + 回落主模型）。三键固定，勿扩展（与 agent-core 契约同源）
const OVERRIDES_KEY = 'mj_model_overrides';
export const OVERRIDE_SLOTS = ['compact', 'decompose', 'worker'];

// i18n：顶层常量会冻结翻译求值（切语言不更新），改为渲染期函数经 tGlobal 解析
export function getReasoningOptions() {
  return [
    { value: '', label: tGlobal('models.reasoningDefault') },
    { value: 'low', label: tGlobal('models.reasoningLow') },
    { value: 'medium', label: tGlobal('models.reasoningMedium') },
    { value: 'high', label: tGlobal('models.reasoningHigh') },
  ];
}

export function getContextOptions() {
  return [
    { value: 0, label: tGlobal('models.ctxDefault') },
    { value: 32768, label: '32K' },
    { value: 65536, label: '64K' },
    { value: 131072, label: '128K' },
    { value: 262144, label: '256K' },
    // 512K：长上下文模型（128K 换 512K 的中间档）此前缺失，用户只能选 1M 或被迫低估
    { value: 524288, label: '512K' },
    { value: 1048576, label: '1M' },
  ];
}

export function modelKeyOf(provider, model) {
  const p = provider ? `${provider.isGlobal ? 'g' : provider.source || 'u'}:${provider.id}` : 'none';
  const m = model ? (model.model_id || model.id) : 'none';
  return `${p}/${m}`;
}

function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch (e) {
    console.warn('[modelConfig] parse failed, falling back to empty config');
    return {};
  }
}

export function getModelConfig(key) {
  if (!key) return null;
  return loadAll()[key] || null;
}

export function setModelConfig(key, patch) {
  if (!key) return;
  const all = loadAll();
  all[key] = { ...(all[key] || {}), ...patch };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn('[modelConfig] persist failed:', e);
  }
}

// P0-1④: 上下文窗口三级取值 —— 用户手选 > 映射表(provider×modelId) > 默认档 32768
// 返回三态对象 { window, confirmed, source }：source = 'user' | 'table' | 'default' | 'ollama-probe'
// probedNumCtx：主进程 GET /api/show 探测到的 Ollama num_ctx（本机实际生效值，唯一可信来源）；
// 传 0/不传时 Ollama 一律按官方最小档 4096 且 confirmed:false（H-1：宁可早压也不击穿）。
export function resolveContextWindow(provider, model, probedNumCtx = 0) {
  const cfg = getModelConfig(modelKeyOf(provider, model));
  const picked = Number(cfg?.context_window) > 0 ? Number(cfg.context_window) : 0;
  if (picked > 0) return { window: picked, confirmed: true, source: 'user' };
  const resolved = resolveWindow({
    providerId: provider?.id,
    baseUrl: provider?.base_url || provider?.baseUrl || '',
    modelId: model?.model_id || model?.id || model?.modelId || '',
    probedNumCtx,
  });
  return {
    window: Number(resolved?.window) > 0 ? Number(resolved.window) : DEFAULT_CONTEXT_WINDOW,
    confirmed: !!resolved?.confirmed,
    source: resolved?.source || 'default',
  };
}

// 兼容旧签名：**必须继续返回 number**（ChatArea.jsx:90 的 `|| 128000` 对对象恒真，
// 改成对象会静默把用量圆环算错 —— P1-12 风险①）。需要 confirmed 的调用方用 resolveContextWindow()。
export function effectiveContextWindow(provider, model) {
  return resolveContextWindow(provider, model).window;
}

// P0-1① / P0-4（2026-10-22）：把 selectedModel 补成「运行用模型」——注入 context_window
// 与 reasoning_effort。**send 与 /compact 必须共用这一份口径**：
// 此前压缩直接拿 selectedModel（不含 context_window），引擎回落 4096 ⇒ 长会话被激进裁剪
// 后整个覆盖数据库（事故见 lib/compactSession 注释）。窗口口径只留这一处。
export function buildRunModel(selectedModel) {
  const mc = getModelConfig(modelKeyOf(selectedModel?.provider, selectedModel?.model));
  return {
    ...selectedModel,
    model: {
      ...(selectedModel?.model || {}),
      context_window: effectiveContextWindow(selectedModel?.provider, selectedModel?.model),
      ...(mc?.reasoning_effort ? { reasoning_effort: mc.reasoning_effort } : {}),
    },
  };
}

// P1-12: 窗口数值格式化（32K / 200K / 1M），与 getContextOptions() 的 label 风格一致
export function fmtK(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '0';
  if (v >= 1000000) {
    const m = v / 1000000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (v % 1000 === 0) return `${v / 1000}K`;
  if (v % 1024 === 0) return `${v / 1024}K`;
  return `${Math.round(v / 1000)}K`;
}

// ── P1-11：任务-模型分档（数据层，无 UI）──
// 契约（Wave 0 冻结）：{ compact?, decompose?, worker? }，每项 ModelRef =
// { providerId, isGlobal, baseUrl, model }（扁平形，主进程/引擎统一 toAgentModel 转换）。
// 纪律：只做「存在则透传、不存在则不传」——任何缺字段/非法项一律静默丢弃并回落主模型，
// 绝不让分档配置错误拖垮压缩（压缩是恢复路径）。
function toModelRef(v) {
  if (!v || typeof v !== 'object') return null;
  const modelId = String(v.model || v.model_id || v.modelId || '').trim();
  if (!modelId) return null;
  return {
    providerId: v.providerId ?? v.provider_id ?? '',
    isGlobal: !!v.isGlobal,
    baseUrl: String(v.baseUrl || v.base_url || ''),
    model: modelId,
    ...(v.reasoning_effort || v.reasoningEffort ? { reasoningEffort: v.reasoning_effort || v.reasoningEffort } : {}),
  };
}

export function getModelOverrides() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(OVERRIDES_KEY)) || {};
  } catch {
    console.warn('[modelConfig] modelOverrides parse failed, falling back to main model');
    return null;
  }
  const out = {};
  for (const slot of OVERRIDE_SLOTS) {
    const ref = toModelRef(raw?.[slot]);
    if (ref) out[slot] = ref;
  }
  // 全空 = 不配分档：返回 null（调用方据此**不传** modelOverrides 字段，零破坏）
  return Object.keys(out).length ? out : null;
}

export function setModelOverrides(next) {
  try {
    const clean = {};
    for (const slot of OVERRIDE_SLOTS) {
      const ref = toModelRef(next?.[slot]);
      if (ref) clean[slot] = ref;
    }
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(clean));
  } catch (e) {
    console.warn('[modelConfig] modelOverrides persist failed:', e);
  }
}
