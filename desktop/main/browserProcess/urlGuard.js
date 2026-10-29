// T-02（P1-1c）：浏览器通道（browser_navigate）的 SSRF 单一判据。
//
// 缺陷形态（修复前）：browserProcess/childEntry.js 的 assertHttpUrl **只校验协议是
//   http/https**，不判私网 ⇒ 更弱的 web_fetch(L2，走 webTools.httpRequest 的
//   isPrivateHost + guardedLookup 双防护)有防护，更强的 browser_navigate(L3) 没有。
//   攻击面因此「越强越松」：127.0.0.1（含本应用自身监听端口）、169.254.169.254
//   （云实例元数据）、[::1]、10/172.16-31/192.168 私网段均可直达，
//   随后 browser_extract 能把正文读回模型。
//
// 为什么单独成文件（而非内嵌在 childEntry.js 里）：
//   childEntry.js 是**子进程入口脚本**——加载即 attachChildSide()，没有 IPC 通道时
//   直接抛错，单元测试根本无法 import 它。守卫若内嵌在入口里，就只能靠「真起一个
//   浏览器子进程」来验证：慢、不稳、还依赖本机装了 Chromium。
//   抽成无副作用的纯模块后：① 判据可被直接单测（含注入式假 DNS）；
//   ② 入口只负责接线，接线本身另有行为断言看守。
//
// 纪律：私网判定**只用** main/ssrfGuard.js 的 isPrivateHost（项目内唯一事实来源），
//   本文件不新建第二份「什么算内网」的规则 —— 历史上 webTools 与 ssrfGuard 各写一份
//   前缀匹配，正是 IPv6 全族失守的根因。
//
// 仍未覆盖（诚实标注，见报告「遗留」）：
//   Chromium 自动跟随 30x，跳转目标由浏览器内部解析与建连；本模块只能在**跳转落地后**
//   用 page.url() 复检（见 childEntry 的 assertLandedUrlPublic），无法拦在请求发出之前。
//   要彻底覆盖需改用 Playwright 的 context.route 逐请求拦截，超出本次修复范围。
const dns = require('dns');
const { isPrivateHost } = require('../ssrfGuard');

// 解析超时上限：超过即视为「无法判定」，交由浏览器按其自身错误语义处理
// （公网可达性的最终裁决权在浏览器，不该由我们的探针替它下结论）。
const DNS_RESOLVE_TIMEOUT_MS = 5000;

/**
 * 入口 URL 守卫：协议 + 字面量私网。
 * 字面量判据覆盖 IP 直写（127.0.0.1 / 169.254.169.254 / [::1] / 10.x …）与
 * 私网域名（localhost / *.localhost）—— 「最容易被利用」的一类目标全在此列。
 * @param {string} url
 * @returns {URL} 解析后的 URL（调用方用它取 hostname / 归一化后的地址）
 */
function assertHttpUrl(url) {
  const raw = String(url || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`URL 格式不正确：${raw}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`浏览器仅允许打开 http/https 页面（当前：${parsed.protocol}）`);
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`出于安全考虑禁止访问内网/本机地址：${parsed.hostname}`);
  }
  return parsed;
}

/**
 * 该 URL 是否指向内网/本机（字面量口径）。
 * 非 http/https（如 about:blank）一律判 false —— 它不是「网络目标」，
 * 也不该让空白页被误判成内网地址。
 * @param {string} url
 * @returns {boolean}
 */
function isPrivateUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isPrivateHost(parsed.hostname);
}

/**
 * resolve-then-validate：判**即将被连接的地址**，堵「字面量过检、解析结果变内网」
 * 这条 DNS rebinding 缝隙（与 webTools.httpRequest 的 guardedLookup 同口径）。
 *
 * 为什么不用 guardedLookup 直接复用：它把「DNS 解析失败」与「解析到私网」都表达成
 *   同一个 error 回调；浏览器通道需要区分二者 —— 解析失败应交还给浏览器报错，
 *   解析到私网必须拦。故此处自行编排解析流程，**判定仍只用 isPrivateHost 一个口径**。
 *
 * 语义（别改坏）：只有**全部**解析结果都放行才放行；任一命中内网即拒
 *   （部分放行等于把 rebinding 的机会留给自己）。
 *
 * @param {string} hostname
 * @param {object} [opts] lookup 可注入（单测用假解析器，不依赖真实 DNS）
 * @returns {Promise<void>} 放行则 resolve，命中私网则 reject
 */
function assertResolvedPublic(hostname, { lookup = dns.lookup, timeoutMs = DNS_RESOLVE_TIMEOUT_MS } = {}) {
  const host = String(hostname || '');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };
    timer = setTimeout(() => finish(resolve), Math.max(1, Number(timeoutMs) || DNS_RESOLVE_TIMEOUT_MS));
    if (timer.unref) timer.unref();
    try {
      lookup(host, { all: true }, (err, addresses) => {
        // 解析失败：不是「可判定为私网」，交还给浏览器按其自身错误语义处理
        // （否则一个临时 DNS 故障会被报成「内网地址」，把用户引向错误方向）
        if (err) { finish(resolve); return; }
        const list = Array.isArray(addresses) ? addresses : [];
        const priv = list.find((a) => isPrivateHost(String(a && a.address ? a.address : '')));
        if (priv) {
          finish(reject, new Error(`出于安全考虑禁止访问内网/本机地址：${host} 解析到 ${priv.address}`));
          return;
        }
        finish(resolve);
      });
    } catch {
      // lookup 实现本身抛错（注入的假解析器 / 平台差异）：按「无法判定」处理
      finish(resolve);
    }
  });
}

module.exports = { assertHttpUrl, isPrivateUrl, assertResolvedPublic, DNS_RESOLVE_TIMEOUT_MS };
