// 设备面板「Android」段的视图判定（2026-10-31）。**纯函数，无 React、无 IO。**
//
// 为什么单独抽出来而不是内联在 DevicePanel.tsx 里：这一小段的核心是**四态**判定，而它恰好
// 是最容易在重构中被压平的一处 —— `undefined`（字段缺失）、`null`（后端明确说查不到）、
// `{devices: []}`（查了、确实没有）、有设备，四者对应的界面动作完全不同。
// 内联在 .tsx 里的分支没有任何测试能覆盖到（本项目渲染层只有源码静态扫描，没有渲染测试），
// 抽到 lib/ 下就能用真输入断言 —— 静态字符串扫描只能证明「代码里写着这个分支」，
// 证明不了「这个分支在什么输入下会走」。

export interface AndroidSummary {
  manufacturer?: string;
  brand?: string;
  model?: string;
  codename?: string;
  androidVersion?: string;
  sdk?: string;
  abi?: string;
  buildId?: string;
  slot?: string;
  secure?: boolean;
  abUpdate?: boolean | null;
}

export interface AndroidDevice {
  serial?: string;
  state?: string;
  mode?: string;
  label?: string;
}

/** 主进程 `device_probe` 返回的 android 段（三态：null / 空 devices / 有设备）。 */
export interface AndroidInfo {
  devices?: AndroidDevice[];
  picked?: string;
  canFlash?: boolean;
  state?: string;
  label?: string;
  next?: string;
  advice?: string;
  summary?: AndroidSummary | null;
  error?: string;
}

/**
 * `hidden`      字段缺失 → 什么都不渲染（旧后端 / probe 整体失败时已有失败卡，别再叠一条）
 * `unavailable` 后端明确说查不到（adb 未装 / 平台未接线）→ **必须说出来**，否则用户会以为没插手机
 * `none`        查了、确实没有 Android 设备 → 不渲染（每个非安卓用户都看到一行「没有设备」是噪音）
 * `device`      有设备 → 卡片
 */
export type AndroidKind = 'hidden' | 'unavailable' | 'none' | 'device';

export interface AndroidView {
  kind: AndroidKind;
  /** 主标题：厂商 + 型号，没有型号时退回状态标签 / 序列号 */
  name: string;
  /** 副标题：Android 版本 / ABI / A/B 槽位，用于判断该选哪份固件 */
  meta: string;
  /** 状态说明（主进程给的中文术语，如「Android 用户态（USB 调试已授权）」） */
  stateLabel: string;
  /** 下一步该做什么（主进程文案，含「须用户自己重启进 bootloader」这类关键动作） */
  hint: string;
  /** 读取失败原因（多台在线 / 未授权 / 序列号非法 / getprop 失败） */
  error: string;
  /** 语气色：warn=要人先处理，success=已在烧写模式，text2=纯说明 */
  tone: string;
  /** 除第一台外还有几台未展示（多台时后端会给 error，这里只补计数） */
  more: number;
}

const EMPTY: AndroidView = {
  kind: 'hidden', name: '', meta: '', stateLabel: '', hint: '', error: '', tone: 'text-text2', more: 0,
};

const withKind = (kind: AndroidKind): AndroidView => ({ ...EMPTY, kind });

/**
 * 剥掉 markdown 强调标记。
 *
 * 主进程那套文案的**第一读者是模型**（工具返回进上下文），所以里面写了「**用户自己**」这类
 * 强调和反引号包裹的命令来突出重点。面板是纯文本渲染，不解析 markdown —— 不剥的话用户会看到
 * 字面的星号和反引号。两个读者两种语法，转换放在视图层做，后端文案保持对模型有效的形态。
 *
 * 反引号用 `\u0060` 转义而不是直接写字符：`scripts/i18n-scan.mjs` 的注释剥离是状态机，
 * 它**不认识正则字面量**，看到裸反引号会当成模板串开始 —— 于是本文件剩下的注释全不被剥离，
 * 中文注释被误报成「裸中文残留」（本行注释用词已避开该字符，同理）。
 */
const plain = (s: string): string => String(s || '').replace(/\*\*/g, '').replace(/\u0060/g, '');

/**
 * 主入口。入参声明成 `unknown` 是刻意的：它来自 IPC，跨进程边界的内容不可信，
 * 类型断言在这里比「假设后端一定守约」安全。
 */
export function androidView(android?: unknown): AndroidView {
  if (android === undefined) return withKind('hidden');
  // null 与 undefined **不能合并**：null 是后端查过了、答「查不到」；undefined 是根本没这个字段。
  if (android === null) return withKind('unavailable');
  if (typeof android !== 'object' || Array.isArray(android)) return withKind('hidden');

  const a = android as AndroidInfo;
  const list = Array.isArray(a.devices) ? a.devices.filter((d) => d && typeof d === 'object') : [];
  if (!list.length) return withKind('none');

  const first = list[0];
  const s: AndroidSummary = a.summary && typeof a.summary === 'object' ? a.summary : {};
  const named = [s.manufacturer, s.model].filter(Boolean).join(' ').trim();
  const meta = [
    s.androidVersion ? `Android ${s.androidVersion}` : '',
    s.abi || '',
    s.slot ? `slot ${s.slot}` : '',
  ].filter(Boolean).join(' / ');

  return {
    kind: 'device',
    name: plain(named || first.label || first.serial || ''),
    meta,
    stateLabel: plain(a.label || first.label || first.state || ''),
    hint: plain(a.next || ''),
    error: plain(a.error || ''),
    // 已在 bootloader 才是「能推进」；有错误信息一律 warn；其余只是说明。
    // 注意**不看 canFlash**：它在后端恒为 false（没有任何 ADB 状态能直接刷），
    // 拿它配色只会让所有卡片永远是警告色，反而丢掉「已在烧写模式」这条真信息。
    tone: a.error ? 'text-warn' : (first.state === 'bootloader' ? 'text-success' : 'text-text2'),
    more: Math.max(0, list.length - 1),
  };
}
