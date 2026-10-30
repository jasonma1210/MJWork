// 运行结束提示音（2026-10-30）：一轮运行真正收尾时按结果播一个短音效。
//
// 三态与素材的对应（素材由用户提供，语义按文件名对齐）：
//   · success.mp3 → 正常结束（含「分步任务本步完成」这类成功收尾）
//   · stop.mp3    → 异常结束（引擎/网络/工具链报错，即 runSummary.status === 'error'）
//   · pause.mp3   → 用户手动停止（status === 'aborted'）
//
// 为什么单独立模块（与 lib/outputDisplay.ts 同一理由）：设置项若只在设置页存个值、
// 没有任何代码读它，就是「假开关」。读取方只有 useAgentRun 的收尾路径，集中在此便于替换素材。
//
// 资源用**静态 import**：
//   · 曾试过 `new URL('../assets/sounds/x.mp3', import.meta.url)`（保留给 Node 测试宿主的那套写法），
//     实测 Vite 并不会重写它（产物里原样留下字面量路径，运行期相对 bundle 目录解析 = 404 静默失败）。
//     静态 import 由 Vite 直接产出带 hash 的资源并给出正确 URL，行为可验证（构建后 assets/*.mp3 存在）。
//   · 代价：把 TSX 编成 CJS 再真渲染的那几个测试 harness（render-smoke / message-meta /
//     onboarding-local-models）必须在其 esbuild loader 表里加 `'.mp3': 'dataurl'`，否则报
//     "No loader is configured for .mp3"。这是显式依赖，比「运行期静默 404」划算。
import successSrc from '../assets/sounds/success.mp3';
import errorSrc from '../assets/sounds/stop.mp3';
import stoppedSrc from '../assets/sounds/pause.mp3';
export type RunSoundKind = 'success' | 'error' | 'stopped';

const KEY = 'mj_run_sound_enabled';

const SOURCES: Record<RunSoundKind, string> = {
  success: successSrc,
  error: errorSrc,
  stopped: stoppedSrc,
};

/** 默认开启：需求是「每次回复完成都要有提示音」，默认关闭等于没做；关掉走设置页。 */
export function isRunSoundEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== '0'; } catch (e) {
    // 无 localStorage 的宿主（纯 Node 测试）：按默认开启返回，不因读取失败改变行为
    console.warn('[runSound] failed to read enabled flag:', e);
    return true;
  }
}

export function setRunSoundEnabled(on: boolean): boolean {
  try { localStorage.setItem(KEY, on ? '1' : '0'); return true; } catch (e) {
    console.warn('[runSound] failed to save enabled flag:', e);
    return false;
  }
}

// 每个音效只建一个 Audio 实例并复用：重复 new Audio 会在快速连发时叠加播放，
// 复用 + 播放前把 currentTime 归零，保证「一次收尾一个音」。
const cache: Partial<Record<RunSoundKind, HTMLAudioElement>> = {};

function audioFor(kind: RunSoundKind): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null; // Node 测试宿主
  if (!cache[kind]) {
    const el = new Audio(SOURCES[kind]);
    el.preload = 'auto';
    el.volume = 0.55; // 默认 1.0 对短提示音偏吵，压到一半略低
    cache[kind] = el;
  }
  return cache[kind] as HTMLAudioElement;
}

/** 播放一次收尾音效。任何失败都只告警——提示音是锦上添花，绝不能让收尾流程抛错。 */
export function playRunSound(kind: RunSoundKind): void {
  if (!isRunSoundEnabled()) return;
  try {
    const el = audioFor(kind);
    if (!el) return;
    el.currentTime = 0;
    const p = el.play();
    // 浏览器/Electron 的自动播放策略可能拒绝（无用户手势），Promise 拒绝必须就地消费，
    // 否则会变成 unhandled rejection 淹没真正的错误。
    if (p && typeof p.catch === 'function') {
      p.catch((e: unknown) => console.warn('[runSound] play rejected:', (e as Error)?.message || e));
    }
  } catch (e) {
    console.warn('[runSound] play failed:', e);
  }
}

/** 试听（设置页切到「开启」时给一次即时反馈，否则用户不知道开了有没有用）。 */
export function previewRunSound(): void {
  playRunSound('success');
}
