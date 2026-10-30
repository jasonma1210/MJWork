/**
 * 模型与会话（thread）绑定（2026-10-18）
 *
 * 需求：会话 A 选 DeepSeek、会话 B 选别的，切回 A 仍是 DeepSeek；关掉应用再打开还是它。
 *
 * 为什么不是全局单键：`mj_selected_model`（appState.ts）记的是「最后一次用过的模型」，
 * 只够回答「新会话该用哪个」，回答不了「这个会话原来用哪个」。两者职责不同，都要保留：
 *   · mj_selected_model   → 新会话的默认值
 *   · mj_thread_models    → 每个会话自己的模型
 *
 * 为什么存 localStorage 而不是 thread 字段：模型是**渲染层偏好**，不是会话内容。
 * 存到主进程的 threads 里要改 schema + 三条 IPC，换设备/多端又会把「我这台机器有哪个
 * 供应商」带过去（供应商列表是本机的，model 引用跨设备无意义）。threadId 做键足够。
 *
 * 失效处理：thread 被删、供应商被删、模型被下线，都要能安静地回落到「当前会话模型」，
 * 绝不能让一条坏记录把界面卡在「没有模型」。
 */

const THREAD_MODELS_KEY = 'mj_thread_models';
const MAX_ENTRIES = 500; // 只防极端膨胀；正常用户远达不到

export type ModelRef = { providerId?: string | number; modelId?: string };

type AnyProvider = {
  id?: string | number;
  isGlobal?: boolean;
  base_url?: string;
  models?: Array<Record<string, unknown>>;
};

// 读失败只告警一次：readAll 会在每次切会话/取模型时调用，坏数据会按次刷屏。
let readAllWarned = false;
function readAll(): Record<string, ModelRef> {
  try {
    const raw = localStorage.getItem(THREAD_MODELS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, ModelRef>;
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    // 返回 {} 的语义是「没有任何会话绑定模型」⇒ 用户之前设过的会话模型全部静默丢失并回落默认
    if (!readAllWarned) { readAllWarned = true; console.warn('[threadModels] read per-thread model bindings failed, falling back to defaults:', e); }
    return {};
  }
}

function writeAll(map: Record<string, ModelRef>): void {
  try {
    localStorage.setItem(THREAD_MODELS_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式 / 配额满：绑定失效不影响本次使用 */
  }
}

const sameId = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');

/** 读某个会话绑定的模型引用；没有或结构坏了都返回 null */
export function readThreadModel(threadId: string | null | undefined): ModelRef | null {
  if (!threadId) return null;
  const ref = readAll()[String(threadId)];
  if (!ref || !ref.providerId || !ref.modelId) return null;
  return { providerId: ref.providerId, modelId: ref.modelId };
}

/** 把某个会话绑定到指定模型（只存 id 快照，不存整个对象：供应商可能被改名/重排） */
export function writeThreadModel(threadId: string | null | undefined, sel: {
  provider?: { id?: string | number }; model?: { model_id?: string; modelId?: string };
} | null): void {
  if (!threadId) return;
  const providerId = sel?.provider?.id;
  const modelId = sel?.model?.model_id || sel?.model?.modelId;
  if (providerId === undefined || providerId === null || !modelId) return;
  const map = readAll();
  map[String(threadId)] = { providerId, modelId: String(modelId) };
  // 超上限时丢最早的键（对象键序即插入序），避免无限增长
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
  }
  writeAll(map);
}

export function forgetThreadModel(threadId: string | null | undefined): void {
  if (!threadId) return;
  const map = readAll();
  if (!(String(threadId) in map)) return;
  delete map[String(threadId)];
  writeAll(map);
}

/** 当前选中的模型是否「够格」写成某个会话的绑定（缺 provider.id 或 model_id 就不写） */
export function isBindable(sel: {
  provider?: { id?: string | number }; model?: { model_id?: string; modelId?: string };
} | null | undefined): boolean {
  if (!sel?.provider) return false;
  const pid = sel.provider.id;
  return (typeof pid === 'number' || (typeof pid === 'string' && pid !== ''))
    && !!(sel.model?.model_id || sel.model?.modelId);
}

/**
 * 切到某个会话时该做什么（纯决策，无副作用，便于单测）。
 *
 *   · 没有会话           → none
 *   · 该会话没有记录      → seed：把当前模型写给它（新会话延续「上次用的」）
 *   · 有记录且能解析      → restore：恢复该会话的模型
 *   · 有记录但解析不到    → pending：供应商列表可能还没加载完，等它到了再试一次
 *
 * 之所以把决策单独抽出来：hook 里那段 if/else 是「切会话换模型」的唯一分水岭，
 * 一旦写错，表现是「切了会话模型没变」或「把别的会话的模型冲掉」——两者都很难从
 * 界面上看出来，只能在这里钉住。
 */
export type SwitchPlan =
  | { type: 'none' }
  | { type: 'seed' }
  | { type: 'restore' }
  | { type: 'pending' };

export function planThreadSwitch({
  threadId,
  saved,
  resolved,
  current,
}: {
  threadId: string | null | undefined;
  saved: ModelRef | null;
  /** 传入 resolveModel 的结果：非 null 表示记录能对到真实 provider/model */
  resolved: unknown;
  /** 当前选中的模型（用于 seed 判断） */
  current: unknown;
}): SwitchPlan {
  if (!threadId) return { type: 'none' };
  if (!saved) return isBindable(current as Parameters<typeof isBindable>[0]) ? { type: 'seed' } : { type: 'none' };
  return resolved ? { type: 'restore' } : { type: 'pending' };
}

/**
 * 把 {providerId, modelId} 解析回真实的 provider/model 对象。
 * 供应商/模型可能在两次启动之间被删除或改名 → 解析不到就返回 null（调用方回落到当前模型）。
 * providerId 一律按字符串比较：本机 provider 是自增数字，全局是 's…' 串，两种都合法。
 */
export function resolveModel(
  providers: AnyProvider[] | null | undefined,
  ref: ModelRef | null | undefined,
): { provider: AnyProvider; model: Record<string, unknown> } | null {
  if (!ref?.providerId || !ref?.modelId) return null;
  const list = Array.isArray(providers) ? providers : [];
  const p = list.find((x) => sameId(x?.id, ref.providerId));
  if (!p) return null;
  const models = Array.isArray(p.models) ? p.models : [];
  const m = models.find((x) => sameId(x?.model_id ?? (x as { modelId?: string })?.modelId, ref.modelId));
  return m ? { provider: p, model: m } : null;
}
