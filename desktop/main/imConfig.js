// IM 平台对接配置（钉钉 / 飞书 / 企微）：用户在设置页自填各平台「自建应用 / 机器人」凭证，
// 安全存本机 ~/.mjcode/im.json（MJCODE_IM_FILE 可覆盖，便于单测）。
//
// 安全口径（对齐 modelsFile.js）：
//   · 密钥字段经注入的 credentialCrypto（safeStorage 双轨）加密，文件里只存 'enc:'+密文；
//   · 写回原子 + 0600；审计只记操作与平台，绝不记密钥明文；
//   · 渲染层只拿脱敏配置（密钥回 { set }，绝不回明文/密文）。
//
// 范围（2026-10-25，用户明确「不直接实现完整功能」，选定「配对码/链接脚手架」）：
//   本文件负责 配置 CRUD + 校验 + 配对码/深链生成 + 状态。
//   TODO(后续)：完整 OAuth 授权回调（mjcode://im-pair scheme 已预留）、code→token 交换、
//               各平台消息收发——均不在这轮，需另立轮次并按各平台官方文档实现。
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

// 解密取某平台全字段（供后续 OAuth/消息收发；本版配对码生成不涉敏，导出供测试与后续用）。
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

// 配对码/深链脚手架：生成一次性 code + mjcode:// 深链，10 分钟有效。
// 完整 OAuth 回调绑定为后续（诚实：脚手架期 paired 恒 false，不伪造「已连接」）。
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
      paired: false, // 完整 OAuth 绑定为后续；脚手架期恒 false
      pairingActive: !!(p && p.expiresAt > now),
      updatedAt: entry && entry.updatedAt ? entry.updatedAt : null,
    };
  });
}

module.exports = {
  IM_PLATFORMS, PLATFORM_IDS, IM_FILE_ENV, PAIRING_TTL_MS,
  imFilePath, readRaw, writeRaw,
  getConfig, saveConfig, deleteConfig, decryptFields, validate,
  createPairing, status,
};
