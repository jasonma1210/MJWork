// IM 平台对接配置（钉钉 / 飞书 / 企微）：用户在设置页自填凭证，主进程负责 OAuth 与消息发送。
// 安全存本机 ~/.mjcode/im.json（MJCODE_IM_FILE 可覆盖，便于单测）。
//
// 安全口径（对齐 modelsFile.js）：
//   · 密钥字段经注入的 credentialCrypto（safeStorage 双轨）加密，文件里只存 'enc:'+密文；
//   · 写回原子 + 0600；审计只记操作与平台，绝不记密钥明文；
//   · 渲染层只拿脱敏配置（密钥回 { set }，绝不回明文/密文）。
//
//   本文件负责 配置 CRUD + 校验 + OAuth 启动/回调 + 消息发送 + 状态。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeFileDurableWithMode } = require('./data/durableWrite');

const IM_FILE_ENV = 'MJCODE_IM_FILE';

// 每平台字段表——对齐各平台官方「自建应用 / 机器人」对接文档要求填的凭证：
//   secret:true → 密钥（加密存储、脱敏回显）；required → 保存时必填（已存的密钥可留空表示不改）。
const IM_PLATFORMS = {
  dingtalk: { // 钉钉 · 企业内部应用机器人
    fields: [
      { key: 'appKey', required: true },
      { key: 'appSecret', secret: true, required: true },
      { key: 'agentId', required: true },
      { key: 'robotCode', required: false },
    ],
  },
  feishu: { // 飞书 · 企业自建应用（机器人 + 事件订阅）
    fields: [
      { key: 'appId', required: true },
      { key: 'appSecret', secret: true, required: true },
      { key: 'verificationToken', secret: true, required: true },
      { key: 'encryptKey', secret: true, required: false },
    ],
  },
  wecom: { // 企业微信 · 自建应用（接收消息回调）
    fields: [
      { key: 'corpId', required: true },
      { key: 'agentId', required: true },
      { key: 'secret', secret: true, required: true },
      { key: 'token', secret: true, required: true },
      { key: 'encodingAESKey', secret: true, required: false },
    ],
  },
};

const PLATFORM_IDS = Object.keys(IM_PLATFORMS);
const PAIRING_TTL_MS = 10 * 60 * 1000; // 配对码 10 分钟有效
const OAUTH_TTL_MS = 10 * 60 * 1000;
const OAUTH = {
  dingtalk: { authorize: 'https://login.dingtalk.com/oauth2/auth', token: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken', hosts: ['login.dingtalk.com', 'api.dingtalk.com'] },
  feishu: { authorize: 'https://open.feishu.cn/open-apis/authen/v1/authorize', token: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token', hosts: ['open.feishu.cn'] },
  wecom: { authorize: 'https://login.work.weixin.qq.com/wwlogin/sso/login', token: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken', hosts: ['login.work.weixin.qq.com', 'open.work.weixin.qq.com', 'qyapi.weixin.qq.com'] },
};
const oauthPending = new Map();
const fetchImpl = (opts) => (opts && opts.fetch) || globalThis.fetch;
// 端点白名单（SSRF 护栏）：只允许 https + 已登记主机。返回 false 的语义是「不放行」而不是
// 「算不出来」——解析失败的输入按不放行处理，调用方会以 endpoint-not-allowed 报给用户。
function safeEndpoint(url, hosts) {
  try { const u = new URL(url); return u.protocol === 'https:' && hosts.includes(u.hostname); } catch { return false; /* 非绝对 URL：fail-closed */ }
}

function imFilePath() {
  if (process.env[IM_FILE_ENV]) return String(process.env[IM_FILE_ENV]);
  return path.join(os.homedir(), '.mjcode', 'im.json');
}

function auditIm(action, detail, result = 'recorded') {
  try {
    const { audit } = require('./audit/auditLog');
    audit(action, 'im.json', detail, result);
  } catch { /* 审计不可用（纯 Node 测试环境等）不阻塞主流程 */ }
}

function readRaw() {
  try {
    const obj = JSON.parse(fs.readFileSync(imFilePath(), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[im] im.json 解析失败，按空处理:', e.message);
    return {};
  }
}

function writeRaw(obj) {
  writeFileDurableWithMode(imFilePath(), JSON.stringify(obj, null, 2), 0o600);
}

// 脱敏：密钥字段回 { set }（是否已存），明文字段回原值；绝不回密钥明文/密文。
function maskConfig(platform, entry) {
  const schema = IM_PLATFORMS[platform];
  if (!schema || !entry || typeof entry !== 'object') return null;
  const fields = {};
  for (const f of schema.fields) {
    const v = entry.fields ? entry.fields[f.key] : undefined;
    if (f.secret) fields[f.key] = { set: typeof v === 'string' && v.length > 0 };
    else fields[f.key] = typeof v === 'string' ? v : '';
  }
  return { platform, fields, updatedAt: entry.updatedAt || null };
}

function schemaHasRequired(platform, fields) {
  const schema = IM_PLATFORMS[platform];
  return schema.fields
    .filter((f) => f.required)
    .every((f) => typeof fields[f.key] === 'string' && fields[f.key].length > 0);
}

// 校验：required 非空；已存的密钥字段允许本次留空（表示不改）。
function validate(platform, input) {
  const schema = IM_PLATFORMS[platform];
  if (!schema) return { ok: false, errors: { _: 'unknown-platform' } };
  const existing = (readRaw()[platform] && readRaw()[platform].fields) || {};
  const errors = {};
  for (const f of schema.fields) {
    const v = input ? input[f.key] : undefined;
    const hasVal = typeof v === 'string' && v.trim().length > 0;
    if (f.required && !hasVal) {
      const existingSet = f.secret && typeof existing[f.key] === 'string' && existing[f.key].length > 0;
      if (!existingSet) errors[f.key] = 'required';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// 保存：密钥加密（enc: 前缀），明文字段直存；本次留空的密钥保留原密文（增量更新）。
function saveConfig(platform, input, cryptoAdapter) {
  const schema = IM_PLATFORMS[platform];
  if (!schema) return { ok: false, error: 'unknown-platform' };
  const v = validate(platform, input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const needsSecret = schema.fields.some((f) => f.secret
    && typeof input?.[f.key] === 'string' && input[f.key].trim().length > 0);
  if (needsSecret && !(cryptoAdapter && typeof cryptoAdapter.encrypt === 'function')) {
    return { ok: false, error: 'crypto-unavailable' }; // fail-closed：无加密轨不落密钥明文
  }
  const raw = readRaw();
  const prev = (raw[platform] && raw[platform].fields) || {};
  const fields = {};
  for (const f of schema.fields) {
    const val = input ? input[f.key] : undefined;
    const hasVal = typeof val === 'string' && val.trim().length > 0;
    if (f.secret) {
      fields[f.key] = hasVal
        ? 'enc:' + cryptoAdapter.encrypt(String(val).trim())
        : (typeof prev[f.key] === 'string' ? prev[f.key] : '');
    } else {
      fields[f.key] = hasVal ? String(val).trim() : '';
    }
  }
  raw[platform] = { fields, updatedAt: new Date().toISOString() };
  writeRaw(raw);
  auditIm('credential_write', `保存 ${platform} 对接配置`, 'recorded');
  return { ok: true, config: maskConfig(platform, raw[platform]) };
}

function getConfig(platform) {
  return maskConfig(platform, readRaw()[platform]);
}

function deleteConfig(platform) {
  const raw = readRaw();
  if (raw[platform]) {
    delete raw[platform];
    if (raw.__pairings) delete raw.__pairings[platform];
    writeRaw(raw);
    auditIm('credential_delete', `删除 ${platform} 对接配置`, 'recorded');
  }
  return { ok: true };
}

// 解密取某平台全字段（OAuth 换 token、消息发送时读 appKey/agentId 等）。
// 只允许在主进程调用：返回值含密钥明文，绝不跨 IPC 回渲染层。
function decryptFields(platform, cryptoAdapter) {
  const entry = readRaw()[platform];
  if (!entry) return null;
  const schema = IM_PLATFORMS[platform];
  const out = {};
  for (const f of schema.fields) {
    const v = entry.fields ? entry.fields[f.key] : undefined;
    if (f.secret && typeof v === 'string' && v.startsWith('enc:')) {
      out[f.key] = cryptoAdapter && typeof cryptoAdapter.decrypt === 'function'
        ? cryptoAdapter.decrypt(v.slice(4)) : '';
    } else {
      out[f.key] = typeof v === 'string' ? v : '';
    }
  }
  return out;
}

// 配对码 / 深链：生成一次性 code + mjcode:// 深链，10 分钟有效。
// 与 OAuth（oauthStart/oauthCallback）是两条独立通道：配对码给「手机端 IM 主动对接」用，
// OAuth 给「桌面端从平台侧拿 token」用；paired 只认 OAuth 令牌，未授权时不伪造「已连接」。
function createPairing(platform) {
  if (!IM_PLATFORMS[platform]) return { ok: false, error: 'unknown-platform' };
  const raw = readRaw();
  if (!raw[platform]) return { ok: false, error: 'not-configured' };
  const code = crypto.randomBytes(8).toString('hex');
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  raw.__pairings = raw.__pairings || {};
  raw.__pairings[platform] = { code, expiresAt };
  writeRaw(raw);
  const url = `mjcode://im-pair?platform=${encodeURIComponent(platform)}&code=${code}`;
  auditIm('credential_read', `生成 ${platform} 配对码`, 'recorded');
  return { ok: true, platform, code, url, expiresAt };
}

function oauthStart(platform, options = {}) {
  const cfg = OAUTH[platform];
  if (!cfg || !IM_PLATFORMS[platform]) return { ok: false, error: 'unknown-platform' };
  const fields = decryptFields(platform, options.cryptoAdapter);
  if (!fields) return { ok: false, error: 'not-configured' };
  const state = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + OAUTH_TTL_MS;
  oauthPending.set(state, { platform, nonce, expiresAt });
  const endpoint = options.authorizeUrl || cfg.authorize;
  if (!safeEndpoint(endpoint, cfg.hosts)) return { ok: false, error: 'endpoint-not-allowed' };
  const u = new URL(endpoint);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  if (platform === 'dingtalk') { u.searchParams.set('client_id', fields.appKey); u.searchParams.set('redirect_uri', options.redirectUri || 'mjcode://im-oauth'); u.searchParams.set('scope', 'openid'); }
  if (platform === 'feishu') { u.searchParams.set('app_id', fields.appId); u.searchParams.set('redirect_uri', options.redirectUri || 'mjcode://im-oauth'); }
  if (platform === 'wecom') { u.searchParams.set('login_type', 'CorpApp'); u.searchParams.set('appid', fields.corpId); u.searchParams.set('agentid', fields.agentId); u.searchParams.set('redirect_uri', options.redirectUri || 'mjcode://im-oauth'); }
  return { ok: true, platform, state, nonce, expiresAt, authorizeUrl: u.toString() };
}

// 换 token：state 一次性（取走即删）+ 10 分钟 TTL，token 只落 enc: 密文。
// 三平台的换法不同（实测口径，勿按「统一 OAuth2」想当然）：
//   · 钉钉 v1.0 userAccessToken：body 必须带 grantType=authorization_code，缺了直接 400；
//   · 飞书：v1 authen/v1/access_token 需要先取 app_access_token 并在 Authorization 头里带，
//     两步容易错；v2 authen/v2/oauth/token 用 client_id/client_secret 一步换完，故用 v2；
//   · 企微：没有「用 code 换 token」接口——access_token 由 corpid+corpsecret 换取（与 code 无关），
//     code 只用于 auth/getuserinfo 换 UserId。故企微是两步，缺任一步都拿不到可用结果。
async function oauthCallback(platform, params = {}, options = {}) {
  const state = String(params.state || '');
  const pending = oauthPending.get(state);
  if (!pending || pending.platform !== platform || pending.expiresAt <= Date.now()) return { ok: false, error: 'invalid-state' };
  oauthPending.delete(state);
  const code = String(params.code || '');
  if (!code) return { ok: false, error: 'missing-code' };
  const cfg = OAUTH[platform];
  if (!cfg) return { ok: false, error: 'unknown-platform' };
  const adapter = options.cryptoAdapter;
  if (!adapter || typeof adapter.encrypt !== 'function') return { ok: false, error: 'crypto-unavailable' };
  const fetcher = fetchImpl(options);
  if (typeof fetcher !== 'function') return { ok: false, error: 'fetch-unavailable' };
  const endpoint = options.tokenUrl || cfg.token;
  if (!safeEndpoint(endpoint, cfg.hosts)) return { ok: false, error: 'endpoint-not-allowed' };
  const fields = decryptFields(platform, adapter);
  if (!fields) return { ok: false, error: 'not-configured' };
  const redirectUri = options.redirectUri || 'mjcode://im-oauth';
  const post = async (url, body, headers) => {
    const res = await fetcher(url, { method: 'POST', headers: headers || { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res || !res.ok) return { ok: false };
    try { return { ok: true, data: (await res.json()) || {} }; } catch { return { ok: false, data: {} }; /* 非 JSON 响应按失败处理 */ }
  };
  let token = '';
  let userId = '';
  if (platform === 'wecom') {
    const q = new URLSearchParams({ corpid: fields.corpId, corpsecret: fields.secret });
    const tok = await post(`${endpoint}?${q.toString()}`, {});
    if (!tok.ok || !tok.data.access_token) return { ok: false, error: 'token-exchange-failed' };
    token = String(tok.data.access_token);
    // 同一 origin 上换成 UserId（origin 仍过白名单，防 endpoint 被外部注入）
    const infoUrl = `${new URL(endpoint).origin}/cgi-bin/auth/getuserinfo?${new URLSearchParams({ access_token: token, code })}`;
    if (!safeEndpoint(infoUrl, cfg.hosts)) return { ok: false, error: 'endpoint-not-allowed' };
    const info = await post(infoUrl, {});
    if (!info.ok) return { ok: false, error: 'user-info-failed' };
    userId = String(info.data.UserId || info.data.userid || '');
  } else {
    const body = platform === 'dingtalk'
      ? { clientId: fields.appKey, clientSecret: fields.appSecret, code, grantType: 'authorization_code' }
      : { grant_type: 'authorization_code', client_id: fields.appId, client_secret: fields.appSecret, code, redirect_uri: redirectUri };
    const r = await post(endpoint, body);
    if (!r.ok) return { ok: false, error: 'token-exchange-failed' };
    // 钉钉 v1.0 返回 camelCase（accessToken），飞书返回 snake_case（tenant_access_token）——
    // 只认一种会把另一家判成 token-invalid，故四个键都试。
    token = String(r.data.accessToken || r.data.access_token || r.data.tenant_access_token || r.data.user_access_token || '');
  }
  if (!token) return { ok: false, error: 'token-invalid' };
  const raw = readRaw();
  if (!raw[platform]) return { ok: false, error: 'not-configured' };
  raw[platform].oauth = { accessToken: 'enc:' + adapter.encrypt(token), userId: userId || null, updatedAt: new Date().toISOString() };
  writeRaw(raw);
  auditIm('oauth_token_write', `保存 ${platform} OAuth 令牌`, 'recorded');
  return { ok: true, platform, userId: userId || null };
}

async function sendMessage(platform, message, options = {}) {
  const cfg = OAUTH[platform]; if (!cfg) return { ok: false, error: 'unknown-platform' };
  const raw = readRaw()[platform]; const enc = raw && raw.oauth && raw.oauth.accessToken; const token = enc && options.cryptoAdapter?.decrypt ? options.cryptoAdapter.decrypt(enc.slice(4)) : '';
  if (!token) return { ok: false, error: 'not-authorized' };
  const input = message && typeof message === 'object' ? message : { content: String(message || '') };
  const recipient = String(input.recipient || '').trim();
  const content = String(input.content || '').trim();
  if (!recipient || !content) return { ok: false, error: 'message-required' };
  let endpoint = options.endpoint;
  let body;
  // 发送时也能读到非密钥字段（appKey/agentId 本就明文），据此补默认值：
  // 钉钉机器人 robotCode 默认= appKey，企微 agentid 默认= 配置里的 agentId——
  // 否则这两家会因缺参数直接报错，用户看到的是「发送失败」而非「配置没填全」。
  const fields = (raw && raw.fields) ? (decryptFields(platform, options.cryptoAdapter) || {}) : {};
  if (platform === 'dingtalk') {
    endpoint ||= 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
    body = { robotCode: String(input.robotCode || fields.appKey || ''), openConversationId: recipient, msgKey: 'sampleText', msgParam: JSON.stringify({ content }) };
  } else if (platform === 'feishu') {
    endpoint ||= 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
    body = { receive_id: recipient, msg_type: 'text', content: JSON.stringify({ text: content }) };
  } else {
    endpoint ||= 'https://qyapi.weixin.qq.com/cgi-bin/message/send';
    body = { touser: recipient, msgtype: 'text', agentid: Number(input.agentId || fields.agentId || 0), text: { content } };
  }
  if (!safeEndpoint(endpoint, cfg.hosts)) return { ok: false, error: 'endpoint-not-allowed' };
  const fetcher = fetchImpl(options); if (typeof fetcher !== 'function') return { ok: false, error: 'fetch-unavailable' };
  const headers = { 'content-type': 'application/json' };
  if (platform === 'wecom') endpoint += `${endpoint.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  else headers.authorization = `Bearer ${token}`;
  const res = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  return { ok: !!res?.ok, status: res?.status, error: res?.ok ? undefined : 'send-failed' };
}
function status() {
  const raw = readRaw();
  const pairings = raw.__pairings || {};
  const now = Date.now();
  return PLATFORM_IDS.map((id) => {
    const entry = raw[id];
    const p = pairings[id];
    return {
      platform: id,
      configured: !!(entry && entry.fields && schemaHasRequired(id, entry.fields)),
      paired: !!(entry && entry.oauth && entry.oauth.accessToken),
      pairingActive: !!(p && p.expiresAt > now),
      updatedAt: entry && entry.updatedAt ? entry.updatedAt : null,
    };
  });
}

module.exports = {
  IM_PLATFORMS, PLATFORM_IDS, IM_FILE_ENV, PAIRING_TTL_MS,
  imFilePath, readRaw, writeRaw,
  getConfig, saveConfig, deleteConfig, decryptFields, validate,
  createPairing, status, oauthStart, oauthCallback, sendMessage, OAUTH,
};
