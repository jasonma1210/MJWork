// ═══════════════════════════════════════════════════════════════
// T3-2：轻量 i18n 基础设施（零新依赖，React context 热切换免重启）
//
// 范围（产品计划已确认）：仅 zh-CN（默认）与 en-US 两个语言包，不做其他 locale。
// 语言包按模块拆分文件：locales/<locale>/<module>.json —— 模块名即 key 的第一段
// （如 locales/zh-CN/composer.json 里的 send → t('composer.send')）。
// 拆分理由：多文件并行抽取时各自只写自己的模块 JSON，零合并冲突；
// vite import.meta.glob eager 全量收集，新增模块文件无需改本代码。
//
// 缺失策略：en-US 缺 key → 回落 zh-CN → 仍缺 → 返回 key 本身并 console.warn
// （可见可查，不静默显示空白）。
// 插值：文案里 {name} 占位，t('x.y', { name: 'v' }) 替换。
// ═══════════════════════════════════════════════════════════════
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export type Locale = 'zh-CN' | 'en-US';
export const LOCALES: Locale[] = ['zh-CN', 'en-US'];
export const DEFAULT_LOCALE: Locale = 'zh-CN';
const STORAGE_KEY = 'mj.locale';

type Dict = Record<string, unknown>;

// 模块名 -> 扁平字典（JSON 顶层对象）。glob 路径 ./locales/zh-CN/foo.json → 模块 foo
// 非 vite 宿主（纯 Node 冒烟测试经 esbuild transform）没有 import.meta.glob：
// 改从 globalThis.__MJ_I18N_PACKS__ 读注入（测试在 load 组件前设置）。
// 必须走 global 而非模块级注入函数：esbuild bundle:true 下每个 entry 各带一份
// i18n 实例，模块单例不共享，只有全局对象能让所有实例读到同一语言包。
// glob 模式必须是静态字面量（vite 编译期解析），故两 locale 各写一次。
type InjectedPacks = Partial<Record<Locale, Record<string, Dict>>>;
declare global {
  // eslint-disable-next-line no-var
  var __MJ_I18N_PACKS__: InjectedPacks | undefined;
  // 纯 JS 模块（被 Node 测试静态导入、无法 import 本 .ts）的运行时翻译通道：
  // 本模块加载时置位；未置位（纯 Node 测试宿主）时消费方回落返回 key 本身
  // eslint-disable-next-line no-var
  var __MJ_T__: ((key: string, params?: Record<string, string | number>) => string) | undefined;
}

// 宿主判定绝不能用 `typeof import.meta.glob === 'function'` 之类的运行时检查：
// Vite 只把 glob **调用点**在编译期替换成模块表，typeof 表达式会原样留在产物里，
// 而浏览器运行时 import.meta.glob 根本不存在（恒 undefined）——真实应用会误走
// 空包分支，全界面显示原始 key（2026-10-15 真机回归事故根因，构建产物可证）。
// 正确姿势：直接调用 + try/catch。Vite 宿主：调用点已被替换为对象字面量，恒成功；
// 非 Vite 宿主（esbuild/Node 冒烟测试）：调用保留原样，运行时抛 TypeError，兜底空表。
// 刻意不记日志：Node/esbuild 宿主（全部门禁套件）**每次都会**走到这里，日志只会淹没测试输出；
// 而真实 Vite 宿主下调用点已被编译期替换，正常情况下永不抛。若真抛了，症状是「全界面显示原始 key」，
// 那是肉眼立刻可见的形态（2026-10-15 事故即此），不需要靠日志发现。
function safeGlob(fn: () => Record<string, { default: Dict }>): Record<string, { default: Dict }> {
  try { return fn(); } catch { /* 见上：非 Vite 宿主的正常路径，空表=调用方回落到 key 原文 */ return {}; }
}

const zhModules = safeGlob(() => import.meta.glob<{ default: Dict }>('./locales/zh-CN/*.json', { eager: true }));
const enModules = safeGlob(() => import.meta.glob<{ default: Dict }>('./locales/en-US/*.json', { eager: true }));

function collect(globbed: Record<string, { default: Dict }>): Dict {
  const out: Dict = {};
  for (const [p, mod] of Object.entries(globbed)) {
    const m = p.match(/locales\/[\w-]+\/(.+)\.json$/);
    if (!m) continue;
    out[m[1]] = mod.default;
  }
  return out;
}

// 非 vite 宿主（glob 兜底为空表）：从注入的全局包读（{module: dict} 形状，与 collect 输出一致）
const injected = (loc: Locale): Dict => (globalThis.__MJ_I18N_PACKS__?.[loc] || {}) as Dict;

// 以「glob 是否拿到模块」判定宿主，而非运行时探测 import.meta.glob（见上方事故注释）
const buildPack = (globbed: Record<string, { default: Dict }>, loc: Locale): Dict =>
  Object.keys(globbed).length > 0 ? collect(globbed) : injected(loc);

const PACKS: Record<Locale, Dict> = {
  'zh-CN': buildPack(zhModules, 'zh-CN'),
  'en-US': buildPack(enModules, 'en-US'),
};

// 按点路径取嵌套值；非字符串叶子视为缺失
function lookup(pack: Dict, key: string): string | null {
  const parts = key.split('.');
  let cur: unknown = pack;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Dict)[p];
  }
  return typeof cur === 'string' ? cur : null;
}

// 占位符插值。语料的主流写法是单花括号 `{name}`，本函数**同时容忍双花括号 `{{name}}`**。
// 为什么要容忍（2026-10-18 实测缺陷）：只认单花括号时，文案写成 `{{tool}}` 不会被替换，
// 而是命中内层 `{tool}` → 渲染成 `{shell}`——用户看到的是「多了一层花括号」，
// 既不是兜底原文也不是插值结果，静态扫描与缺 key 告警都发现不了（这条路径一路绿）。
// 两种写法都吃，是让「作者手滑」不再变成「UI 上多一层括号」的唯一低成本办法。
function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (whole, dbl, sgl) => {
    const name = dbl ?? sgl;
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole;
  });
}

// 命令式场景（toast/工具函数等非 React 上下文）用 tGlobal：
// LanguageProvider 挂载与切换时同步 activeLocale，保证与组件内 useI18n 一致。
let activeLocale: Locale = readStoredLocale();
export function tGlobal(key: string, params?: Record<string, string | number>): string {
  return translate(activeLocale, key, params);
}
// 向无法静态 import 本模块的纯 JS 消费方（lib/api.js、lib/agent.js——被 Node 测试直接加载）
// 暴露运行时翻译通道
globalThis.__MJ_T__ = tGlobal;

// 纯查找（供测试与组件外场景）：locale 缺失回落 zh-CN，再缺返回 key
export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const hit = lookup(PACKS[locale], key) ?? lookup(PACKS['zh-CN'], key);
  if (hit === null) {
    console.warn(`[i18n] missing key: ${key} (locale=${locale})`);
    return key;
  }
  return interpolate(hit, params);
}

export function readStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'zh-CN' || v === 'en-US') return v;
  } catch { /* 非浏览器宿主（测试）：用默认 */ }
  return DEFAULT_LOCALE;
}

interface I18nCtxValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nCtx = createContext<I18nCtxValue | null>(null);

// 语言切换即 setState 重渲染全树（免重启验收项）；持久化 localStorage 供下次启动恢复
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);
  const setLocale = useCallback((l: Locale) => {
    if (!LOCALES.includes(l)) return;
    activeLocale = l; // 同步命令式通道（tGlobal）
    setLocaleState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* 隐私模式等：内存态仍生效 */ }
    try { document.documentElement.lang = l; } catch { /* 非浏览器宿主 */ }
  }, []);
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return React.createElement(I18nCtx.Provider, { value }, children);
}

export function useI18n(): I18nCtxValue {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error('useI18n must be used inside LanguageProvider');
  return ctx;
}
