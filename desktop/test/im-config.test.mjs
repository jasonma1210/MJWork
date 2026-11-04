// IM 对接配置（main/imConfig.js）单测：脱敏 / 加密落盘 / fail-closed / 配对码 / 状态诚实。
// 纯 Node：MJCODE_IM_FILE 指向临时文件，注入可逆假加密轨（无 safeStorage 依赖）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = path.join(os.tmpdir(), `mjcode-im-test-${process.pid}-${Date.now()}.json`);
process.env.MJCODE_IM_FILE = tmp; // imFilePath() 每次调用读该 env，故运行前设定即可隔离
try { fs.unlinkSync(tmp); } catch { /* 首次无文件 */ }

const im = await import('../main/imConfig.js');

// 假加密轨：base64（不透明、可逆），用来验证「密钥以 enc: 落盘、getConfig 脱敏、decryptFields 往返」
const fakeCrypto = { encrypt: (s) => Buffer.from(String(s), 'utf8').toString('base64'), decrypt: (s) => Buffer.from(String(s), 'base64').toString('utf8') };

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

check('schema：三平台 + 钉钉必填三项（appKey/appSecret/agentId）', () => {
  assert.deepEqual([...im.PLATFORM_IDS].sort(), ['dingtalk', 'feishu', 'wecom']);
  const req = im.IM_PLATFORMS.dingtalk.fields.filter((f) => f.required).map((f) => f.key).sort();
  assert.deepEqual(req, ['agentId', 'appKey', 'appSecret']);
});

check('save 后 getConfig 脱敏（密钥回 {set}、不回明文）；落盘为 enc: 且无明文密钥', () => {
  const r = im.saveConfig('dingtalk', { appKey: 'ak123', appSecret: 'sk-SECRET', agentId: '999' }, fakeCrypto);
  assert.equal(r.ok, true);
  const masked = im.getConfig('dingtalk');
  assert.equal(masked.fields.appKey, 'ak123');            // 非密钥明文可回显
  assert.deepEqual(masked.fields.appSecret, { set: true }); // 密钥只回 set
  const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.ok(String(raw.dingtalk.fields.appSecret).startsWith('enc:'), '密钥须以 enc: 落盘');
  assert.ok(!JSON.stringify(raw).includes('sk-SECRET'), '明文密钥不得落盘');
});

check('缺必填 → errors；已存密钥本次留空 → 通过（增量更新保留原密文）', () => {
  const bad = im.saveConfig('wecom', { corpId: 'c' }, fakeCrypto); // wecom 尚未配置：缺 agentId/secret/token
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.agentId && bad.errors.secret && bad.errors.token, '缺 agentId/secret/token 应报 required');
  const inc = im.saveConfig('dingtalk', { appKey: 'ak123', agentId: '999' }, fakeCrypto); // dingtalk 已存 appSecret，本次留空应通过
  assert.equal(inc.ok, true, '已存密钥留空应通过');
});

check('fail-closed：无加密轨时拒绝落密钥明文', () => {
  const r = im.saveConfig('feishu', { appId: 'cli_x', appSecret: 'sec', verificationToken: 'vt' }, null);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'crypto-unavailable');
});

check('decryptFields 往返（取回明文供后续用）', () => {
  const f = im.decryptFields('dingtalk', fakeCrypto);
  assert.equal(f.appSecret, 'sk-SECRET');
  assert.equal(f.appKey, 'ak123');
});

check('createPairing：未配置拒；配置后出 code/url/expiry，status.pairingActive=true、paired 恒 false', () => {
  assert.equal(im.createPairing('wecom').error, 'not-configured');
  im.saveConfig('feishu', { appId: 'cli_x', appSecret: 'sec', verificationToken: 'vt' }, fakeCrypto);
  const p = im.createPairing('feishu');
  assert.equal(p.ok, true);
  assert.match(p.code, /^[0-9a-f]{16}$/);
  assert.ok(p.url.includes('platform=feishu') && p.url.includes(`code=${p.code}`), '深链须含 platform+code');
  assert.ok(p.expiresAt > Date.now(), 'expiresAt 应在未来');
  const st = im.status().find((s) => s.platform === 'feishu');
  assert.equal(st.configured, true);
  assert.equal(st.pairingActive, true);
  assert.equal(st.paired, false, '脚手架期 paired 恒 false（不伪造「已连接」）');
});

check('status：未配置平台 configured=false', () => {
  assert.equal(im.status().find((s) => s.platform === 'wecom').configured, false);
});

check('deleteConfig 清空 + 状态回落', () => {
  assert.equal(im.deleteConfig('dingtalk').ok, true);
  assert.equal(im.getConfig('dingtalk'), null);
  assert.equal(im.status().find((s) => s.platform === 'dingtalk').configured, false);
});

// ── OAuth 换 token / 消息发送：本轮新增逻辑的正式断言 ──────────────────────────
// 为什么必须在这里断：`im-protocol.test.mjs` 只覆盖深链解析，「换 token 的 body 对不对、
// 把 token 加密落了没有、发送时收件人与鉴权头对不对」全靠下面这些——否则四类真实失败
// （平台 400 参数错、令牌明文落盘、发错人、被劫持 endpoint 送 token）都没有门禁。
const acheck = async (name, fn) => {
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
};
// 假 fetch：记录每次调用，便于断言 URL / 头 / body，而不是只断最终返回值
function recFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const body = reply(String(url), init || {}, calls.length);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
}

await acheck('oauthStart：未配置拒；配置后出 state/nonce 与带 redirect_uri 的授权地址', async () => {
  assert.equal(im.oauthStart('dingtalk', { cryptoAdapter: fakeCrypto }).error, 'not-configured');
  im.saveConfig('dingtalk', { appKey: 'ak-oauth', appSecret: 'sec-oauth', agentId: '42' }, fakeCrypto);
  const s = im.oauthStart('dingtalk', { cryptoAdapter: fakeCrypto });
  assert.equal(s.ok, true);
  assert.match(s.state, /^[0-9a-f]{48}$/, 'state 须 24 字节随机（48 hex）');
  assert.match(s.nonce, /^[0-9a-f]{48}$/);
  const u = new URL(s.authorizeUrl);
  assert.equal(u.hostname, 'login.dingtalk.com', '授权地址须落在白名单主机');
  assert.equal(u.searchParams.get('client_id'), 'ak-oauth');
  assert.equal(u.searchParams.get('redirect_uri'), 'mjcode://im-oauth', '默认回跳须是深链');
  assert.equal(u.searchParams.get('state'), s.state, '授权地址里的 state 必须与下发值一致');
  assert.ok(s.expiresAt > Date.now(), 'expiresAt 应在未来');
});

await acheck('oauthStart：endpoint 被换成非白名单主机 → endpoint-not-allowed（SSRF 护栏）', () => {
  const r = im.oauthStart('dingtalk', { cryptoAdapter: fakeCrypto, authorizeUrl: 'https://evil.example.com/auth' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'endpoint-not-allowed');
});

await acheck('oauthCallback：未知 state → invalid-state；缺 code → missing-code', async () => {
  const bad = await im.oauthCallback('dingtalk', { state: 'deadbeef', code: 'c' }, { cryptoAdapter: fakeCrypto });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid-state');
  const s = im.oauthStart('dingtalk', { cryptoAdapter: fakeCrypto });
  const noCode = await im.oauthCallback('dingtalk', { state: s.state }, { cryptoAdapter: fakeCrypto });
  assert.equal(noCode.error, 'missing-code');
});

await acheck('oauthCallback：换 token 的 body 口径正确（钉钉须带 grantType），令牌以 enc: 落盘且 status.paired=true', async () => {
  const s = im.oauthStart('dingtalk', { cryptoAdapter: fakeCrypto });
  const { fetch, calls } = recFetch(() => ({ accessToken: 'tok-live-1' }));
  const r = await im.oauthCallback('dingtalk', { state: s.state, code: 'code-1' }, { cryptoAdapter: fakeCrypto, fetch });
  assert.equal(r.ok, true, `换 token 应成功，实得 ${JSON.stringify(r)}`);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'api.dingtalk.com');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.clientId, 'ak-oauth');
  assert.equal(body.code, 'code-1');
  assert.equal(body.grantType, 'authorization_code', '钉钉缺 grantType 会 400');
  const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.ok(String(raw.dingtalk.oauth.accessToken).startsWith('enc:'), '令牌须以 enc: 落盘');
  assert.ok(!JSON.stringify(raw).includes('tok-live-1'), '令牌明文不得落盘');
  assert.equal(im.status().find((x) => x.platform === 'dingtalk').paired, true, '换到令牌后 paired 才为 true');
  // state 一次性：同一 state 再用一次必须被拒（防重放）
  const replay = await im.oauthCallback('dingtalk', { state: s.state, code: 'code-1' }, { cryptoAdapter: fakeCrypto, fetch: recFetch(() => ({ accessToken: 'x' })).fetch });
  assert.equal(replay.error, 'invalid-state', 'state 必须一次性（重放要被拒）');
});

await acheck('sendMessage：未授权先拒；缺收件人/内容拒；成功时鉴权头与收件人正确（robotCode 默认= appKey）', async () => {
  im.deleteConfig('dingtalk');
  const notAuth = await im.sendMessage('dingtalk', { recipient: 'u1', content: 'hi' }, { cryptoAdapter: fakeCrypto });
  assert.equal(notAuth.error, 'not-authorized');
  im.saveConfig('dingtalk', { appKey: 'ak-oauth', appSecret: 'sec-oauth', agentId: '42' }, fakeCrypto);
  const s = im.oauthStart('dingtalk', { cryptoAdapter: fakeCrypto });
  await im.oauthCallback('dingtalk', { state: s.state, code: 'c' }, { cryptoAdapter: fakeCrypto, fetch: recFetch(() => ({ accessToken: 'tok-live-2' })).fetch });
  const missing = await im.sendMessage('dingtalk', { recipient: '', content: 'hi' }, { cryptoAdapter: fakeCrypto });
  assert.equal(missing.error, 'message-required');
  const { fetch, calls } = recFetch(() => ({ errcode: 0 }));
  const ok = await im.sendMessage('dingtalk', { recipient: 'cid-1', content: 'hello' }, { cryptoAdapter: fakeCrypto, fetch });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-live-2', '鉴权头须带解出的令牌');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.openConversationId, 'cid-1');
  assert.equal(body.robotCode, 'ak-oauth', 'robotCode 未填时应回落到 appKey');
  assert.equal(JSON.parse(body.msgParam).content, 'hello');
});

await acheck('sendMessage：endpoint 指向非白名单主机 → endpoint-not-allowed（令牌不出白名单）', async () => {
  const r = await im.sendMessage('dingtalk', { recipient: 'u', content: 'x' }, { cryptoAdapter: fakeCrypto, endpoint: 'https://evil.example.com/send', fetch: recFetch(() => ({})).fetch });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'endpoint-not-allowed');
});

await acheck('企微两步授权：gettoken 换 access_token → getuserinfo 换 UserId；发送时令牌走 query 参数', async () => {
  im.saveConfig('wecom', { corpId: 'corp-1', agentId: '1001', secret: 'sec-w', token: 'tk', encodingAESKey: '' }, fakeCrypto);
  const s = im.oauthStart('wecom', { cryptoAdapter: fakeCrypto });
  assert.equal(s.ok, true, `企微应能发起授权，实得 ${JSON.stringify(s)}`);
  assert.equal(new URL(s.authorizeUrl).searchParams.get('login_type'), 'CorpApp');
  const { fetch, calls } = recFetch((url) => (url.includes('/cgi-bin/gettoken') ? { access_token: 'wtok-1', errcode: 0 } : { UserId: 'zhangsan', errcode: 0 }));
  const r = await im.oauthCallback('wecom', { state: s.state, code: 'wcode' }, { cryptoAdapter: fakeCrypto, fetch });
  assert.equal(r.ok, true, `两步换 token 应成功，实得 ${JSON.stringify(r)}`);
  assert.equal(r.userId, 'zhangsan');
  assert.equal(calls.length, 2, '企微必须两步：gettoken + getuserinfo');
  assert.ok(calls[0].url.includes('corpsecret=sec-w'), '第一步须带 corpsecret');
  assert.ok(calls[1].url.includes('access_token=wtok-1') && calls[1].url.includes('code=wcode'));
  assert.equal(im.status().find((x) => x.platform === 'wecom').paired, true);
  const sent = recFetch(() => ({ errcode: 0 }));
  const ok = await im.sendMessage('wecom', { recipient: '@all', content: 'hi' }, { cryptoAdapter: fakeCrypto, fetch: sent.fetch });
  assert.equal(ok.ok, true);
  assert.ok(sent.calls[0].url.includes('access_token=wtok-1'), '企微令牌走 query 而非 Authorization 头');
  assert.equal(JSON.parse(sent.calls[0].init.body).agentid, 1001, 'agentid 未填时应回落到配置值');
});

console.log(`\nim-config: ${pass}/${pass + fail} 通过`);
try { fs.unlinkSync(tmp); } catch { /* 清理临时文件 */ }
process.exit(fail === 0 ? 0 : 1);
