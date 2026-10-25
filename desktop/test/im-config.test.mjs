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

console.log(`\nim-config: ${pass}/${pass + fail} 通过`);
try { fs.unlinkSync(tmp); } catch { /* 清理临时文件 */ }
process.exit(fail === 0 ? 0 : 1);
