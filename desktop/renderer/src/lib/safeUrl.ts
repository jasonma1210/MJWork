/**
 * markdown 链接协议白名单（单一事实来源）。
 *
 * 背景（2026-10-30 全量核查 S-005）：react-markdown v9 的默认 `urlTransform` 会剥离
 * `javascript:` / `data:`，但那是**上游默认值**——升大版本、换渲染器、或哪天有人显式写
 * `urlTransform={(u) => u}` 都会悄悄失去这层保护。而 MessageStream 的 `a` 兜底分支历史
 * 上曾把 href 原样输出成 `<a href>`，一旦上游默认值没了就是个现成的 XSS sink。
 *
 * 判据写在本仓：**有 scheme 的只放行 http(s) / mailto**；**没有 scheme 的**
 * （相对路径 `a/b.md`、`./x`、`../x`、页内锚点 `#a`、查询 `?q`、协议相对 `//host/p`）
 * 原样放行，交由组件层决定怎么打开（站内文件 / 系统浏览器）。
 *
 * 比对前先剔除控制字符与反斜杠：`java\nscript:`、`JavaScript\tscript:`、`java\script:`
 * 这类变体在浏览器里仍可能被解析成脚本协议，直接按字面判 scheme 会漏。
 */

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const ALLOWED_SCHEMES = /^(?:https?|mailto)$/i;

/** 协议白名单：不允许的返回空串（react-markdown 会因此渲染成纯文本，不产出可达链接）。 */
export function safeUrlTransform(url?: string | null): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  // 控制字符（含 \n \t）与反斜杠先剔除再判 scheme，避免 `java\nscript:` 这类绕过
  const probe = raw.replace(/[\u0000-\u001f\u007f\\]/g, '');
  const m = SCHEME_RE.exec(probe);
  if (!m) return raw;
  return ALLOWED_SCHEMES.test(m[1]) ? raw : '';
}

/** 该 href 是否走「系统浏览器」：http(s)/mailto，以及协议相对的 `//host`（补成 https）。 */
export function toExternalHref(href?: string | null): string {
  const h = String(href ?? '').trim();
  if (!h) return '';
  if (h.startsWith('//')) return `https:${h}`;
  return /^(?:https?:|mailto:)/i.test(h) ? h : '';
}
