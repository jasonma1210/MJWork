// P0-A：Web 检索与抓取工具（主进程实现）
//
// 为什么放在独立模块而不是 main.js：
//   main.js 已有 2600+ 行，本次审查已把它列为 God Object（架构债 P3）。
//   Web 工具涉及网络、超时、HTML 解析、私网地址防护等独立关注点，独立成文件便于单测。
//
// 安全设计（与项目既有安全基线一致）：
//   · SSRF 防护：拒绝 localhost / 127.x / 私有网段 / 169.254（云元数据）等内网地址，
//     防止模型被诱导访问本机服务或云凭证端点；
//   · 仅允许 http/https，禁file:// / gopher: 等；
//   · 超时强制：不做无限等待，避免单轮卡死拖垮整个 Agent 回合；
//   · 响应体积上限：防止把几百 MB 内容一次性灌进上下文；
//   · HTML → 纯文本：剥离 script/style/注释，避免把页面脚本内容当正文喂给模型
//     （同时天然过滤了大部分脚本注入载体）。
const https = require('https');
const http = require('http');
const { URL } = require('url');
// P1-2：超时数字的单一事实来源（此前此文件写 15000，与引擎看门狗的 60000 相差 4 倍）
const { WEB_FETCH_IMPL_TIMEOUT_MS } = require('./tools/timeouts');

// P1-2：web_fetch 实现侧 15s → 30s（DNS+TLS+首字节+2MB 正文的 P99；与引擎 60s 保持 2 倍关系）
const DEFAULT_TIMEOUT_MS = WEB_FETCH_IMPL_TIMEOUT_MS;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB 上限
const DEFAULT_TEXT_LIMIT = 15000;

// ── SSRF 防护 ──
// 第八轮 D-802（2026-10-21）：判定实现抽至 main/ssrfGuard.js 并重写。
// 原实现用字符串前缀匹配，而 WHATWG URL 对 IPv6 返回**带方括号**的 hostname
// （`[::1]` / `[fd00::1]` / `[fe80::1]` / `[::ffff:7f00:1]`），
// 导致 `h === '::1'` 与 `^f[cd]` / `fe80` 永不命中 —— **整个 IPv6 地址族没有防护**。
// 本文件继续 re-export，既有消费方（nativeTools 的 http_request、测试）零改动。
const { isPrivateHost, guardedLookup } = require('./ssrfGuard');

// ── 带超时与体积上限的 fetch ──
// 2026-10-15 泛化出 httpRequest（支持 POST / 自定义头 / JSON body）：
// 搜索类 API（Tavily/Exa 走 POST+Bearer，Brave 走自定义头）需要它；
// SSRF 防护必须保持**单一实现**——所有出网都经过这里的协议/私网检查，不允许旁路。
function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES, hop = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) {
      reject(new Error(`URL 格式非法：${urlStr}`));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`仅支持 http/https 协议，收到：${parsed.protocol}`));
      return;
    }
    if (isPrivateHost(parsed.hostname)) {
      reject(new Error(`出于安全考虑禁止访问内网/本机地址：${parsed.hostname}`));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(String(body), 'utf8');
    const req = client.request(
      parsed.toString(),
      {
        method,
        timeout: timeoutMs,
        // 第八轮 D-802 阶段②：resolve-then-validate —— 判**即将被连接的地址**，
        // 堵住「字面量过检、解析结果变内网」的 DNS rebinding 缝隙（详见 ssrfGuard.guardedLookup）。
        lookup: guardedLookup,
        headers: {
          'User-Agent': 'MJCode-Agent/1.0 (+https://github.com/jasonma1210/MJCoder)',
          Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        // 跟随一次重定向（重定向后仍需复检 SSRF，否则可借302 跳内网）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, parsed).toString();
          if (hop >= 5) { reject(new Error('HTTP 重定向次数超过上限（5）')); return; }
          httpRequest(next, { method, headers, body, timeoutMs, maxBytes, hop: hop + 1 }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}${res.statusMessage ? ` ${res.statusMessage}` : ''}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Error(`响应体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB），已中止`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: String(res.headers['content-type'] || ''),
          finalUrl: parsed.toString(),
        }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`));
    });
    req.on('error', (e) => reject(new Error(`网络请求失败：${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// 兼容旧名：web_fetch 等仍是 GET 语义
function httpGet(urlStr, opts = {}) {
  return httpRequest(urlStr, opts);
}

// ── HTML → 纯文本 ──
function htmlToText(html) {
  return String(html || '')
    // 先整块移除不可读/危险内容（顺序重要：注释里的 script 不能复活）
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    // 结构标签转换为换行，保留段落可读性
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    // 剩余标签直接去掉
    .replace(/<[^>]+>/g, ' ')
    // 还原实体
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 工具实现 ──

/**
 * web_search：联网搜索。
 * 2026-10-15 配置工程收口：接入 webSearchProviders.js——
 *   · 内置 8 家提供方（Tavily / DuckDuckGo / SearXNG / Brave / Exa / Bing / Google CSE / 百度），
 *     在 设置 → 网络配置 中按需启用（可全开做 failover，也可只开一家）；
 *   · DuckDuckGo 无需 Key，开箱可用——解决「工具已建但默认不可用」的落差；
 *   · 多家按序尝试，第一个成功者生效；全部失败回报逐家明细；
 *   · 未启用任何一家时明确告知（不伪造检索结果——Agent 最不可接受的失败模式）。
 */
async function webSearch({ query, max_results: maxResults } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'search_query_missing: 必须提供 query 关键词' };
  const limit = Math.max(1, Math.min(Number(maxResults) || 5, 10));
  const { searchWithProviders, loadSearchConfig } = require('./webSearchProviders');
  const config = loadSearchConfig(localStoreRef, credentialCryptoRef);
  return searchWithProviders(config, { query: q, limit });
}

// 配置来源注入：main.js 在 localStore 初始化后调用（避免 webTools 反向依赖 main）
let localStoreRef = null;
let credentialCryptoRef = null;
function setLocalStore(ls, cc = null) {
  localStoreRef = ls || null;
  if (cc !== null) credentialCryptoRef = cc || null;
}

/**
 * web_fetch：抓取网页并转纯文本。
 */
async function webFetch({ url, offset, limit } = {}) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, error: 'fetch_url_missing: 必须提供 url' };
  const start = Math.max(0, Number(offset) || 0);
  const maxChars = Math.max(200, Math.min(Number(limit) || DEFAULT_TEXT_LIMIT, 60000));

  try {
    const res = await httpGet(u);
    const isJson = /application\/json/i.test(res.contentType);
    const text = isJson ? res.body : htmlToText(res.body);
    const slice = text.slice(start, start + maxChars);
    const truncated = start + maxChars < text.length;
    return {
      ok: true,
      url: res.finalUrl,
      contentType: res.contentType,
      totalChars: text.length,
      offset: start,
      truncated,
      content: slice || (text.length === 0 ? '（页面内容为空，或为纯前端渲染的页面——此类页面需改用搜索或直接看官方文档源码）' : slice),
      ...(truncated ? { hint: `内容较长已截断，可传 offset=${start + maxChars} 继续读取后续部分` } : {}),
    };
  } catch (e) {
    return { ok: false, error: 'fetch_failed', url: u, message: String(e?.message || e) };
  }
}

module.exports = { webSearch, webFetch, htmlToText, isPrivateHost, httpGet, httpRequest, setLocalStore };
