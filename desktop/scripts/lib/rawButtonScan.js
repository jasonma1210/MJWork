// 裸 `<button>` 计数的**单一事实来源**（2026-10-27）
//
// 为什么必须共用：这条口径此前有两份实现 ——
//   · test/ui-conventions.test.js 用它守棘轮（rawButton 基线）
//   · scripts/gen-legacy-ledger.mjs 用它生成存量台账
// 两份实现一旦漂移，`legacy-ledger` 的「台账总数 === 门禁基线」就会先天不一致，
// 而两边都是「可信的门禁」，人只能靠猜判断信哪个。更糟的是豁免规则只在其中一份里，
// 于是同一份代码在两处得到 251 与 256 两个「都对」的答案。
//
// 豁免口径（只豁免「无法用 ui/Button 三档零差异表达」的形态）：
//   ① 纯文字链接式按钮：className 无任何 bg-*/border*/rounded —— 换成 Button 会凭空多出
//      内边距、圆角与边框，把行内文字链变成按钮块；
//   ② 正方形图标按钮：同时含等值 h-N 与 w-N —— Button 的 px-* 会把宽度撑开，图标失真。
//
// ⚠ 反例留档：曾试过「rounded-lg/rounded-xl 视为指标不匹配而豁免」，实测把计数从 256 砍到 61
// （rounded-lg 是本仓库最常见控件圆角），等于把门禁本体豁免掉。该类只能人工判定，不机械放行。
//
// ⚠ 静态性要求：`className={cond ? 'a' : 'b'}`、`className={styles.item}`、含 `${}` 的模板串
// 一律**不豁免**（形态无法静态证明）。此前漏了这条，`3x className={item}` 被当成文字链放行。
'use strict';

/** 把注释替换为空格（保留换行，行号不变）：注释里的 <button> 不可能被渲染 */
function blankComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

/**
 * 取 `<button ...` 起始片段里的静态 className 字面量。
 * @returns {string|null} null = 不可静态判定（变量/三元/函数调用/含插值的模板串）
 */
function buttonClassName(head) {
  const m = head.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{(['"])([^'"]*)\3\})/);
  if (!m) return null;
  if (m[2] !== undefined && m[2].includes('${')) return null; // 模板插值：形态随运行时变化
  return m[1] ?? m[2] ?? m[4];
}

/** 该 open tag 是否属于可豁免形态 */
function isExemptButton(head) {
  const cls = buttonClassName(head);
  if (cls === null) return false;
  if (cls.trim() === '') return false; // 空 className 无形态证据，不算豁免
  const hasBg = /\bbg-[a-z]/.test(cls);
  const hasBorder = /\bborder(?:-[a-z])?\b/.test(cls);
  const hasRounded = /\brounded(?:-[a-z]+)?\b/.test(cls);
  if (!hasBg && !hasBorder && !hasRounded) return true; // ① 文字链
  const h = cls.match(/\bh-(\d+)\b/);
  const w = cls.match(/\bw-(\d+)\b/);
  return !!(h && w && h[1] === w[1]); // ② 正方形图标按钮
}

/**
 * 统计一段已屏蔽注释的源码里「应计入棘轮」的裸 <button>。
 * @returns {{ count: number, exempt: number, lines: number[] }} lines 为计入项的起始行号
 */
function countButtons(code) {
  const lines = [];
  let exempt = 0;
  let pos = code.indexOf('<button');
  while (pos !== -1) {
    // 取 open tag 头：先中和箭头函数里的 '>'，避免把 onClick={() => ...} 误判为标签结束
    const seg = code.slice(pos, pos + 600).replace(/=>/g, '==');
    const closeIdx = seg.indexOf('>');
    const head = closeIdx === -1 ? seg : seg.slice(0, closeIdx);
    if (isExemptButton(head)) exempt += 1;
    else lines.push(code.slice(0, pos).split('\n').length);
    pos = code.indexOf('<button', pos + 1);
  }
  return { count: lines.length, exempt, lines };
}

module.exports = { blankComments, buttonClassName, isExemptButton, countButtons };
