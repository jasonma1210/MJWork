// 强调色运行时落盘（TH5 + 2026-10-17 视觉修复 + 2026-11-04 家族派生）
//
// 背景：主题色由 CSS 变量承载，其中每个颜色有 **两份** 表示：
//   `--theme-accent`     hex，给 CSS / SVG / getComputedStyle 用；
//   `--theme-accent-rgb` "r g b"，给 Tailwind 的 `bg-accent/10` 这类透明度类用。
// 用户自定义强调色只写 hex 的话，所有 `/opacity` 类会重新失效（Tailwind v3
// 无法对 var() 应用 alpha），表现为描边/淡底突然变白或消失。
// 因此强调色的读写在渲染层只允许走本模块，禁止各处自行 setProperty。
//
// ── 2026-11-04 修复（v3 视觉改版同步）：单色覆盖 ⇒ 整套家族派生 ──
//   改前只写 `--theme-accent` / `--sem-accent` 两个 token。后果是「选紫色」之后：
//     文字与描边变紫，**实心主按钮还是主题的玉色**、选中行底色还是玉色淡调、
//     accent-soft（图标/次要强调）也还是玉色 —— 四件东西同屏四色，用户会以为功能坏了。
//   现在以用户选的 hex 为种子派生整族：
//     accent / accent-solid = 种子；accent-soft = 提亮 22%；select-fg = soft；
//     select-bg / accent-bg = 同色淡底；on-accent 按**对比度择优**（不是按亮度阈值猜）。
//   为什么 on-accent 要「择优」而不是「亮度 > 0.5 就给黑字」：
//     阈值法在中间调上会挑错 —— #43BFA2 亮度 0.41，阈值法给白字（实算仅 2.28:1），
//     择优法给近黑字（实算 8.19:1）。逐项算 WCAG 相对亮度再比两个对比度，结果恒定可验。

/** 一份颜色变量的键分组：hex 与 rgb 三元组必须成对写，缺一即透明度类失效 */
const KEYS = {
  hex: ['--theme-accent', '--sem-accent'],
  rgb: ['--theme-accent-rgb', '--sem-accent-rgb'],
  solidHex: ['--theme-accent-solid'],
  solidRgb: ['--theme-accent-solid-rgb'],
  softHex: ['--theme-accent-soft'],
  softRgb: ['--theme-accent-soft-rgb'],
  onAccentHex: ['--theme-on-accent'],
  onAccentRgb: ['--theme-on-accent-rgb'],
  selectFgHex: ['--theme-select-fg'],
  selectFgRgb: ['--theme-select-fg-rgb'],
  // 直接承载 rgba(...) 串的 token（消费方只用整值，不做透明度修饰）
  raw: ['--sem-accent-bg', '--theme-select-bg'],
} as const;

const ALL_KEYS: string[] = Object.values(KEYS).flat();

/** 亮实心底上的字（近黑，不用纯黑：纯黑压在彩色底上会显脏） */
const ON_ACCENT_DARK: Rgb = { r: 0x10, g: 0x13, b: 0x14 };
/** 暗实心底上的字（近白，不用纯白：大面积纯白在深色块上会「发光」） */
const ON_ACCENT_LIGHT: Rgb = { r: 0xFA, g: 0xFA, b: 0xFA };

export interface Rgb { r: number; g: number; b: number }

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** `#rgb` / `#rrggbb` → 通道对象；非法输入返回 null */
export function parseHex(hex: string): Rgb | null {
  const raw = String(hex || '').trim().replace(/^#/, '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** 通道对象 → `"r g b"`（Tailwind 三元组形态） */
export function toTriplet(c: Rgb): string {
  return `${clamp(c.r)} ${clamp(c.g)} ${clamp(c.b)}`;
}

/** 通道对象 → `#rrggbb` */
export function toHex(c: Rgb): string {
  const h = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** `#rgb` / `#rrggbb` → `"r g b"`；非法输入返回 null（调用方按「不覆盖」处理） */
export function hexToRgbTriplet(hex: string): string | null {
  const c = parseHex(hex);
  return c ? toTriplet(c) : null;
}

/** 线性插值：t=0 取 a，t=1 取 b（越界钳制，非数字按 0 处理） */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

/** WCAG 相对亮度（sRGB → 线性 → 加权） */
export function relativeLuminance(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 对比度（1~21） */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = la >= lb ? la : lb;
  const lo = la >= lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

/** 实心底上的字色：在近黑/近白之间择优，保证任何种子色都拿到更高的那一个对比度 */
export function pickOnAccent(solid: Rgb): Rgb {
  const withDark = contrastRatio(solid, ON_ACCENT_DARK);
  const withLight = contrastRatio(solid, ON_ACCENT_LIGHT);
  return withDark >= withLight ? ON_ACCENT_DARK : ON_ACCENT_LIGHT;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
/** 实心底上文字的对比度下限（WCAG AA 正文 4.5:1；按钮文案 13px 属正文级） */
const MIN_ON_SOLID = 4.5;

/**
 * 求出「可读的实心底 + 它的字色」。
 *
 * 为什么需要这一步（2026-11-04 实测）：中间调种子上**两种字色都够不到 4.5:1** ——
 * #8B5CF6 配近白字 4.06:1、配近黑字 4.41:1，两边都不合格。只换字色解决不了，
 * 必须让实心底本身让一步。做法：
 *   · 种子已经达标 → 原样使用（用户选什么就是什么，零偏离）；
 *   · 不达标 → **先只尝试加深**（饱和中间调在设计惯例里配白字；加深保住色相，
 *     提亮则会把颜色洗淡），逐档 2% 找到第一个达标点就停，偏离最小；
 *   · 加深 60% 仍不达标（极亮种子，如荧光黄）→ 改试提亮，配近黑字。
 * 无论走哪条分支，返回的字色都由 contrastRatio 实数决定，不靠亮度阈值猜。
 */
export function readableSolid(seed: Rgb): { solid: Rgb; onAccent: Rgb } {
  const onSeed = pickOnAccent(seed);
  if (contrastRatio(seed, onSeed) >= MIN_ON_SOLID) return { solid: seed, onAccent: onSeed };
  for (let t = 0.02; t <= 0.6 + 1e-9; t += 0.02) {
    const darker = mixRgb(seed, BLACK, t);
    if (contrastRatio(darker, ON_ACCENT_LIGHT) >= MIN_ON_SOLID) return { solid: darker, onAccent: ON_ACCENT_LIGHT };
  }
  for (let t = 0.02; t <= 0.6 + 1e-9; t += 0.02) {
    const lighter = mixRgb(seed, WHITE, t);
    if (contrastRatio(lighter, ON_ACCENT_DARK) >= MIN_ON_SOLID) return { solid: lighter, onAccent: ON_ACCENT_DARK };
  }
  // 走到这里说明种子既极亮又极不饱和（理论上不可达）：保底给近白字，绝不返回无字色的实心底
  return { solid: seed, onAccent: ON_ACCENT_LIGHT };
}

/**
 * 由单个种子色派生全套强调色变量（纯函数，便于单测）。
 * 返回「变量名 → 值」，调用方只负责写进 element.style。
 * 非法种子返回 null —— 宁可整族不落地，也不留半套变量（半套正是本文件要消灭的病）。
 */
export function deriveAccentVars(hex: string, opts: { lightTheme?: boolean } = {}): Record<string, string> | null {
  const seed = parseHex(hex);
  if (!seed) return null;
  const soft = mixRgb(seed, WHITE, 0.22);
  // 实心底可能为该色自身的可读性微调（见 readableSolid）；文字/描边仍用种子原色，
  // 这样「用户选的色」在描边、图标、列表中保持忠实，只有承载白字的实心块让一步。
  const { solid, onAccent } = readableSolid(seed);
  // 淡底透明度：浅色主题上同样 alpha 读起来更重，故分档（与 theme.css 各主题同口径）
  const tint = opts.lightTheme ? 0.11 : 0.15;
  const rgba = (a: number) => `rgba(${clamp(seed.r)}, ${clamp(seed.g)}, ${clamp(seed.b)}, ${a})`;
  return {
    '--theme-accent': toHex(seed),
    '--theme-accent-rgb': toTriplet(seed),
    '--sem-accent': toHex(seed),
    '--sem-accent-rgb': toTriplet(seed),
    '--theme-accent-solid': toHex(solid),
    '--theme-accent-solid-rgb': toTriplet(solid),
    '--theme-accent-soft': toHex(soft),
    '--theme-accent-soft-rgb': toTriplet(soft),
    '--theme-on-accent': toHex(onAccent),
    '--theme-on-accent-rgb': toTriplet(onAccent),
    '--theme-select-fg': toHex(soft),
    '--theme-select-fg-rgb': toTriplet(soft),
    '--sem-accent-bg': rgba(tint),
    '--theme-select-bg': rgba(tint),
  };
}

/**
 * 应用自定义强调色；传 null / 空串表示回落到主题自带强调色（把整族键全部移除，
 * 让 theme.css 的值重新生效 —— 只移除自己写过的那部分等于把两套色混在一起）。
 */
export function applyAccent(color: string | null | undefined, root: HTMLElement = document.documentElement): void {
  const hex = String(color || '').trim();
  if (!hex) {
    for (const k of ALL_KEYS) root.style.removeProperty(k);
    return;
  }
  const lightTheme = root.getAttribute('data-theme') === 'light';
  const vars = deriveAccentVars(hex, { lightTheme });
  if (!vars) return; // 非法色值不落地，避免出现半套变量
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}
