// 通用 OAuth 2.1 引擎（生态中心 T7：MCP 远程连接器浏览器授权闭环）
//
// 三级回落（与生态中心统一入口重构计划一致；永不臆造端点、永不捆绑厂商机密）：
//   ① 标准发现：未认证探测 MCP 端点 → 401 WWW-Authenticate resource_metadata
//      （缺省回落 /.well-known/oauth-protected-resource）→ authorization_servers →
//      AS 元数据（RFC 8414 oauth-authorization-server，openid-configuration 兜底）→ DCR 动态注册
//   ② 目录 oauth_preset：authorization_endpoint / token_endpoint / client_id（公共客户端 + PKCE S256）
//   ③ 两者皆不可用：如实返回中文错误（UI 引导按官方文档接入）
//
// 安全不变量：
//   - 令牌经 CredentialCrypto 加密落 userData/mcp-oauth.json（渲染层不经手令牌、IPC 永不回传令牌）
//   - loopback 回调（RFC 8252 §7.3：127.0.0.1 随机端口 /callback）、state 随机校验、120s 超时
//   - 公共客户端（token_endpoint_auth_method=none）；DCR 下发的 client_secret 仅加密存储，不作机密依赖
//
// 本模块刻意不 require('electron')：全部宿主能力（授权窗口、加密器、fetch）经构造注入，
// 测试用本地 http mock 即可端到端跑通发现链与授权流。
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { writeFileDurableWithMode } = require('./data/durableWrite');
// P1-8：协议版本单点化——此处原有一份硬编码的版本字面量副本（本文件 _discover 的 401 探测 initialize）。
// 现与 mcpClient 共用 mcpProtocol.js（零依赖，避免 mcpAuth ↔ mcpClient 循环 require）。
const { PROTOCOL_VERSION, CLIENT_CAPABILITIES, CLIENT_INFO } = require('./mcpProtocol');

const CALLBACK_TIMEOUT_MS = 120_000;
const HTTP_TIMEOUT_MS = 15_000;
const EXPIRY_MARGIN_MS = 60_000; // 到期前 1 分钟即视为过期，提前续期避免边界 401

const b64url = (buf) => Buffer.from(buf).toString('base64url');

class McpAuthManager {
  // { storeFile, credentialCrypto, openAuthWindow(url) -> {close()}, fetchImpl = fetch, log }
  constructor({ storeFile, credentialCrypto, openAuthWindow, fetchImpl = fetch, log = console.warn }) {
    if (!storeFile) throw new Error('McpAuthManager 需要 storeFile');
    if (!credentialCrypto) throw new Error('McpAuthManager 需要 credentialCrypto');
    if (typeof openAuthWindow !== 'function') throw new Error('McpAuthManager 需要 openAuthWindow');
    this.storeFile = storeFile;
    this.credentialCrypto = credentialCrypto;
    this.openAuthWindow = openAuthWindow;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  // ── 令牌存储（userData/mcp-oauth.json，密文字段全部经 credentialCrypto 加密）──
  // P0-持久化（2026-10-16）修复两处：
  //   ① _save 此前是裸 writeFileSync（无 tmp+rename、无 fsync）。崩溃时序不正会写坏
  //      令牌文件；而令牌是用户重新授权才能拿回来的东西，写坏的代价极高。
  //   ② _load 此前 catch 里一律 return {}，把「文件损坏」与「尚未授权」当同一件事，
  //      用户看到的是"所有服务都要重新授权"却不知道为什么。
  //      现区分 ENOENT（尚未授权，正常）与解析失败（损坏），损坏时保留副本 + 显著告警。
  _load() {
    if (!fs.existsSync(this.storeFile)) return {}; // 尚未授权过，正常
    // P3（第二轮审查）：读时权限自愈。写入路径已恒 0600，但**存量文件不会自己变**——
    // 历史上被裸 writeFileSync 写成 0644 的令牌文件，升级后会一直保持宽松权限。
    // 与 mcp-servers.json 的自愈（ipc/mcp.js）保持同一策略。
    try {
      const st = fs.statSync(this.storeFile);
      if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o600) {
        fs.chmodSync(this.storeFile, 0o600);
        console.warn(`[mcpAuth] OAuth 令牌文件权限为 ${(st.mode & 0o777).toString(8)}，已收紧为 600`);
      }
    } catch { /* 权限检查失败不阻断读取（读取本身仍可用） */ }
    try {
      const map = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      if (!map || typeof map !== 'object') throw new Error('结构非法');
      return map;
    } catch (e) {
      const kept = `${this.storeFile}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.storeFile, kept); } catch { /* 保留失败不阻断 */ }
      console.error(`[mcpAuth] OAuth 令牌文件损坏：${e.message}；已保留副本 ${kept}。受影响的服务需要重新授权一次。`);
      return {};
    }
  }

  _save(map) {
    // 用 writeFileDurableWithMode 而非 writeFileSync(..., {mode:0o600})：
    // Node 的 mode 参数只在文件【创建时】应用，对已存在文件无效——首写之后的每次
    // 保存权限都不会被设置，等于 0600 保护只生效一次。现改为 rename 后显式 chmod。
    const res = writeFileDurableWithMode(this.storeFile, JSON.stringify(map, null, 2), 0o600);
    if (!res.ok) {
      console.error('[mcpAuth] 令牌落盘失败:', res.error);
      return false;
    }
    if (!res.modeApplied) {
      // 令牌已写入但权限未收紧：必须让用户知道，不能静默
      console.error('[mcpAuth] 令牌文件权限未收紧（0600 未生效）:', res.error || '原因未知');
      return false;
    }
    return true;
  }

  // 解密返回明文记录；解密失败（钥匙串轨切换等）返回 null 并留痕
  _record(name) {
    const raw = this._load()[name];
    if (!raw) return null;
    try {
      return {
        ...raw,
        access: raw.access ? this.credentialCrypto.decrypt(raw.access) : '',
        refresh: raw.refresh ? this.credentialCrypto.decrypt(raw.refresh) : '',
        clientSecret: raw.clientSecret ? this.credentialCrypto.decrypt(raw.clientSecret) : '',
      };
    } catch (e) {
      this.log(`[mcp-oauth ${name}] 令牌解密失败（需重新授权）: ${e.message}`);
      return null;
    }
  }

  _store(name, tok, meta = {}) {
    const map = this._load();
    const prev = map[name] || {};
    map[name] = {
      access: this.credentialCrypto.encrypt(String(tok.access_token || '')),
      // 轮换语义：新令牌没带 refresh_token 时保留旧的
      refresh: tok.refresh_token ? this.credentialCrypto.encrypt(String(tok.refresh_token)) : (prev.refresh || ''),
      expiresAt: Date.now() + Math.max(0, Number(tok.expires_in) || 3600) * 1000 - EXPIRY_MARGIN_MS,
      scope: String(tok.scope || prev.scope || ''),
      clientId: String(meta.clientId || prev.clientId || ''),
      clientSecret: meta.clientSecret ? this.credentialCrypto.encrypt(String(meta.clientSecret)) : (prev.clientSecret || ''),
      tokenEndpoint: String(meta.tokenEndpoint || prev.tokenEndpoint || ''),
    };
    this._save(map);
  }

  hasStoredAuth(name) {
    const raw = this._load()[name];
    return !!(raw && raw.access);
  }

  // ── 取有效访问令牌：过期自动用 refresh_token 续期 ──
  async getAccessToken(name) {
    const rec = this._record(name);
    if (!rec || !rec.access) return null;
    if (Date.now() < rec.expiresAt) return rec.access;
    const fresh = await this.refreshFor(name);
    // 续期失败仍回原令牌：服务端可能仍接受；真 401 由传输层透出 needsAuth
    return fresh || rec.access;
  }

  async refreshFor(name) {
    const rec = this._record(name);
    if (!rec || !rec.refresh || !rec.tokenEndpoint) return null;
    try {
      const tok = await this._postForm(rec.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: rec.refresh,
        client_id: rec.clientId,
        ...(rec.clientSecret ? { client_secret: rec.clientSecret } : {}),
      });
      if (!tok || !tok.access_token) return null;
      this._store(name, tok, { tokenEndpoint: rec.tokenEndpoint, clientId: rec.clientId, clientSecret: rec.clientSecret || undefined });
      return tok.access_token;
    } catch (e) {
      this.log(`[mcp-oauth ${name}] 令牌续期失败: ${e.message}`);
      return null;
    }
  }

  // ── 浏览器授权（三级回落；成功即加密落盘，重启免授权）──
  async authorize(name, { url, preset, scope } = {}) {
    if (!name) return { ok: false, error: '授权需要服务名（name）' };
    const endpoint = String(url || '').trim();
    if (!endpoint) return { ok: false, error: '授权需要 MCP 服务地址（url）' };

    // PKCE 与 state 先于 loopback 生成；redirect_uri 需端口，故先监听再注册
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    let listener;
    try {
      listener = await this._startLoopback(state);
    } catch (e) {
      return { ok: false, error: `无法监听本地回调端口：${e.message}` };
    }
    const redirectUri = `http://127.0.0.1:${listener.port}/callback`;

    try {
      // ① 发现链 → ② 目录 preset → ③ 如实披露
      const discovered = await this._discover(endpoint);
      let flow = null;
      let level = '';
      if (discovered && discovered.registrationEndpoint) {
        const client = await this._registerClient(discovered, redirectUri);
        flow = { ...discovered, clientId: client.client_id, clientSecret: client.client_secret || '' };
        level = 'discovery';
      } else if (preset && preset.authorization_endpoint && preset.token_endpoint && preset.client_id) {
        flow = {
          authorizationEndpoint: String(preset.authorization_endpoint),
          tokenEndpoint: String(preset.token_endpoint),
          clientId: String(preset.client_id),
          clientSecret: '',
          scope: String(preset.scope || ''),
          resource: preset.resource ? String(preset.resource) : '',
        };
        level = 'preset';
      } else if (discovered) {
        return { ok: false, error: '授权服务器不支持动态客户端注册（DCR），目录也未提供客户端预设，请参照官方文档接入' };
      } else {
        return { ok: false, error: '该服务不支持标准 OAuth 发现，且目录未提供授权预设，请参照官方文档接入' };
      }

      const scopeStr = String(scope || flow.scope || '').trim();
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: flow.clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      });
      if (scopeStr) q.set('scope', scopeStr);
      if (flow.resource) q.set('resource', flow.resource); // RFC 8707：RS 要求的资源指示
      const authUrl = flow.authorizationEndpoint + (flow.authorizationEndpoint.includes('?') ? '&' : '?') + q.toString();

      // 先挂等待再开窗：假窗口同步 fetch 重定向时回调可能先到
      const codePromise = listener.waitForCode();
      const win = this.openAuthWindow(authUrl);
      let code;
      try {
        code = await codePromise;
      } finally {
        try { win && win.close && win.close(); } catch { /* 窗口可能已被用户关闭 */ }
      }

      const tok = await this._postForm(flow.tokenEndpoint, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: flow.clientId,
        code_verifier: verifier,
        ...(flow.clientSecret ? { client_secret: flow.clientSecret } : {}),
        ...(flow.resource ? { resource: flow.resource } : {}),
      });
      if (!tok || !tok.access_token) return { ok: false, error: '授权服务器未返回 access_token' };
      this._store(name, tok, { tokenEndpoint: flow.tokenEndpoint, clientId: flow.clientId, clientSecret: flow.clientSecret || undefined });
      return { ok: true, level };
    } catch (e) {
      return { ok: false, error: e.message || '授权失败' };
    } finally {
      listener.close();
    }
  }

  // ① 发现：探测端点取 resource_metadata（401 头优先）→ 受保护资源元数据 → AS 元数据
  async _discover(endpoint) {
    let origin;
    try { origin = new URL(endpoint).origin; } catch { return null; }
    let rmUrl = `${origin}/.well-known/oauth-protected-resource`;
    try {
      const probe = await this._fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 0, method: 'initialize',
          // P1-8：版本/能力/客户端信息全部取自 mcpProtocol.js（不再有第二份字面量副本）
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: { ...CLIENT_CAPABILITIES }, clientInfo: { ...CLIENT_INFO } },
        }),
      });
      if (probe.status === 401) {
        const m = String(probe.headers.get('www-authenticate') || '').match(/resource_metadata="([^"]+)"/i);
        if (m) rmUrl = m[1];
      }
      await probe.text().catch(() => {});
    } catch { /* 探测失败不阻断：回落 well-known 默认路径 */ }

    const pr = await this._getJson(rmUrl);
    const servers = pr && Array.isArray(pr.authorization_servers) ? pr.authorization_servers : [];
    for (const as of servers) {
      const meta = await this._asMetadata(String(as));
      if (meta && meta.authorization_endpoint && meta.token_endpoint) {
        return {
          authorizationEndpoint: meta.authorization_endpoint,
          tokenEndpoint: meta.token_endpoint,
          registrationEndpoint: meta.registration_endpoint || '',
          scope: (meta.scopes_supported || []).join(' '),
          // RFC 8707：resource 指示必须等于 RS 元数据声明的**规范标识**（可含路径，如
          // https://ardot.tencent.com/mcp）。此前用 origin（丢掉路径）——Ardot 实测：
          // authorize 放行但 token 交换恒 400 invalid_target（在 code 校验之前被拒），
          // 用户侧表现即「登录成功后授权失败 400」。
          resource: (pr && typeof pr.resource === 'string' && pr.resource) ? pr.resource : origin,
        };
      }
    }
    return null;
  }

  // RFC 8414：well-known 插在 host 与 path 之间；openid-configuration 兜底
  async _asMetadata(asUrl) {
    let u;
    try { u = new URL(asUrl); } catch { return null; }
    const p = u.pathname.replace(/\/+$/, '');
    const cands = [
      `${u.origin}/.well-known/oauth-authorization-server${p}`,
      `${u.origin}${p}/.well-known/openid-configuration`,
    ];
    for (const c of cands) {
      const meta = await this._getJson(c);
      if (meta && meta.authorization_endpoint) return meta;
    }
    return null;
  }

  // DCR（RFC 7591）：公共客户端注册，token_endpoint_auth_method 固定 none
  async _registerClient(flow, redirectUri) {
    const res = await this._fetch(flow.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'MJ Code',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 按失败处理 */ }
    if (!res.ok || !data || !data.client_id) throw new Error(`动态注册客户端失败（HTTP ${res.status}）`);
    return data;
  }

  // RFC 8252 loopback：127.0.0.1 随机端口收授权码，state 校验 + 120s 超时
  _startLoopback(expectedState) {
    return new Promise((resolve, reject) => {
      let settle = null;
      const server = http.createServer((req, res) => {
        let u;
        try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; }
        if (u.pathname !== '/callback') { res.writeHead(404).end('not found'); return; }
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        const bad = !!err || !code || state !== expectedState;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:system-ui;padding:2em"><h3>${bad ? '授权未完成' : '授权完成'}</h3><p>可以关闭此窗口返回应用。</p></body></html>`);
        if (settle) {
          settle(err ? { error: `授权被取消：${err}` }
            : bad ? { error: '回调校验失败（state 不匹配或缺少 code）' }
              : { code });
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        let timer = null;
        resolve({
          port,
          waitForCode: () => new Promise((res2, rej2) => {
            settle = (r) => {
              if (timer) clearTimeout(timer);
              r.error ? rej2(new Error(r.error)) : res2(r.code);
            };
            timer = setTimeout(() => {
              settle = null;
              rej2(new Error(`授权超时（${CALLBACK_TIMEOUT_MS / 1000}s），请重试`));
            }, CALLBACK_TIMEOUT_MS);
            if (timer.unref) timer.unref();
          }),
          close: () => { try { server.close(); } catch { /* 已关闭 */ } },
        });
      });
    });
  }

  // ── HTTP 小工具（统一超时；JSON/表单两种编码）──
  async _fetch(url, init = {}) {
    return this.fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  }

  async _getJson(url) {
    try {
      const res = await this._fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) { await res.text().catch(() => {}); return null; }
      return JSON.parse(await res.text());
    } catch { return null; }
  }

  async _postForm(url, form) {
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 错误体 */ }
    if (!res.ok) {
      // RFC 6749 错误码（data.error，如 invalid_target/invalid_grant）必须透出：
      // 此前只拼 error_description，很多 AS 的 400 只有 error 码——用户看到的是
      // 「令牌端点返回 400」，诊断信息全部丢失。正文截断兜底（非 JSON 错误体）。
      const detail = data?.error_description || data?.error
        || String(text || '').slice(0, 200) || '无响应体';
      throw new Error(`令牌端点返回 ${res.status}：${detail}`);
    }
    return data;
  }
}

module.exports = { McpAuthManager, CALLBACK_TIMEOUT_MS, EXPIRY_MARGIN_MS };
