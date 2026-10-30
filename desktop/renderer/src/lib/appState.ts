import { tGlobal } from '../i18n';
import { applyAccent } from './color';

/**
 * App 层用到的纯工具：默认项目对象、localStorage JSON 读取、主题落地。
 * 从 App.jsx 抽出（God File 800 行门禁），行为不变：
 * · 语言文案不冻结 —— getDefaultProject 是工厂函数，调用时才求值。
 * · 缺 key / 坏 JSON 一律回落 fallback，并留一条可查的 warn。
 */
export function getDefaultProject() {
  return { id: 'default', name: tGlobal('app.defaultProject'), path: '' };
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return (JSON.parse(raw) as T) ?? fallback;
  } catch (e) {
    console.warn('[app] failed to parse local data:', key);
    return fallback;
  }
}

/**
 * 主题落地：写 data-theme / data-platform、应用自定义强调色、记住选择。
 * 平台标记用于顶栏按 macOS 交通灯计算留白（--titlebar-inset）。
 */
export function applyThemeToDocument(theme: string): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  root.setAttribute('data-platform', isMac ? 'darwin' : 'other');
  // 强调色必须成对写入 hex + rgb（见 lib/color.ts），否则 /opacity 类会失效
  let accent: string | null = null;
  try {
    accent = localStorage.getItem('mj_accent');
  } catch (e) {
    // 读不到 ⇒ 自定义强调色回落到默认值（用户会以为「我的配色丢了」）；只在本函数调用时发生，不刷屏
    console.warn('[appState] read accent color failed, falling back to default:', e);
    accent = null;
  }
  applyAccent(accent);
  try {
    localStorage.setItem('mj_theme', theme);
  } catch {
    /* 隐私模式等写不进去：不影响本次渲染 */
  }
}

// ── 上次使用的模型（2026-10-18）──
// 问题：`selectedModel` 每次启动都是 null，于是回落到「第一个供应商的第一个模型」——
// 用户昨天整晚用的是某个模型，今天打开就变回默认，定时任务也跟着换模型跑。
// 这里把「最后一次真正用过的模型」记在本地，启动时按 id 复原（按 id 而不是按引用：
// 供应商列表可能在两次启动之间被改名/重排）。
const SELECTED_MODEL_KEY = 'mj_selected_model';

type AnyProvider = { id?: string; isGlobal?: boolean; base_url?: string; models?: Array<Record<string, unknown>> };

export function rememberModel(sel: { provider?: { id?: string }; model?: { model_id?: string } } | null): void {
  try {
    const providerId = sel?.provider?.id;
    const modelId = sel?.model?.model_id;
    if (!providerId || !modelId) return;
    localStorage.setItem(SELECTED_MODEL_KEY, JSON.stringify({ providerId, modelId }));
  } catch {
    /* 隐私模式等写不进去：不影响本次使用 */
  }
}

/** 启动时挑初始模型：优先上次用过的（且仍存在），否则退回第一个可用的 */
export function pickInitialModel(providers: AnyProvider[] | null | undefined): { provider: AnyProvider; model: Record<string, unknown> } | null {
  const list = Array.isArray(providers) ? providers : [];
  const saved = loadJSON<{ providerId?: string; modelId?: string } | null>(SELECTED_MODEL_KEY, null);
  if (saved?.providerId && saved?.modelId) {
    const p = list.find((x) => x?.id === saved.providerId);
    const m = (p?.models || []).find((x) => (x?.model_id || (x as { modelId?: string })?.modelId) === saved.modelId);
    if (p && m) return { provider: p, model: m };
  }
  const first = list.find((x) => Array.isArray(x?.models) && x.models.length > 0);
  return first ? { provider: first, model: first.models![0] } : null;
}

/**
 * FIX-P07：把首启向导里选定的模型（`{ providerId, modelId }`）解析成 `selectedModel` 形状。
 *
 * 为什么需要它：`selectedModel` 在 App 挂载时就由 pickInitialModel 定了默认值，
 * 向导里的选择若不回灌，用户「点了某个模型」只是界面高亮 —— 又一处装饰性交互。
 * 解析不到（provider 已被删除 / id 不匹配）返回 null，调用方保持原选择，绝不构造半截模型。
 */
export function pickOnboardingModel(
  providers: AnyProvider[] | null | undefined,
  picked: { providerId?: string; modelId?: string } | null | undefined,
): { provider: AnyProvider; model: Record<string, unknown> } | null {
  if (!picked || !picked.providerId || !picked.modelId) return null;
  const p = (Array.isArray(providers) ? providers : []).find((x) => x?.id === picked.providerId);
  // models 必须是数组：本机库 / models.json 双来源，坏形状（字符串、null）不能让首启流程崩
  const models = Array.isArray(p?.models) ? p!.models! : [];
  const m = models.find((x) => (x?.model_id || (x as { modelId?: string })?.modelId) === picked.modelId);
  return p && m ? { provider: p, model: m } : null;
}
