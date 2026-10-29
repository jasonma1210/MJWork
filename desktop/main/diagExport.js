// T2-6：诊断包一键导出（设置页 → 导出诊断包）
// 打包内容（全部本机文件，zip 落在 userData/diagnostics/，用户自愿提交给开发者）：
//   audit/       本地审计日志（audit-log.jsonl[.1]，已脱敏截断）
//   diagnostics/ 崩溃/异常聚合 JSONL（T2-5）
//   traces/      运行 trace（T0-5，逐轮引擎事件）
//   logs/        主进程 console tee（最近 3 个）
//   config/      脱敏配置：providers（白名单字段）、preferences、projects、
//                models.json（白名单字段）、mcp-servers.json（去 env 与 headers）
//   governance/  治理命中率快照（N9：hook / 意图预热 / 技能按需加载，纯计数）
//   meta.json    版本/平台/架构/导出时间（userData 路径以 HOME 相对表达，脱敏）
// 凭证纪律：**任何 API Key / 加密密文 / env 变量 / Authorization 头都不进包**。
// 测试 test/diag-export.test.mjs 用假密钥值 grep 全包，命中即红。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { writeZip } = require('./zipStore');
// N9：治理命中率会随诊断包一起导出（governance/stats.json），供开发者复盘「开关真机上有没有生效」。
const { governanceStats } = require('./governanceStats');

// 需要整体剔除的敏感字段名（大小写不敏感匹配）——用于 local-data / mcp-servers 等结构化配置
const SENSITIVE_KEYS = new Set(['api_key', 'apikey', 'keyencrypted', 'api_key_encrypted', 'token', 'password', 'secret', 'env', 'headers', 'authorization']);

// P0-7 修复（2026-10-17）：非结构化文本统一正则密钥扫描。
// 背景：诊断包此前的脱敏只作用于**结构化配置的字段名**（黑名单剔除），而 audit/traces/logs
// 里带的是命令原文与上游响应体（如 curl 请求的 Authorization 头后面直接跟着厂商 Key、
// 模型 401 响应体回显 Key）——字段名脱敏对这类内容完全无效，用户把包发给别人即泄漏。
// 该正则是兜住「内容里嵌密钥」的唯一切实手段，与白名单字段剔除形成双保险。
const SECRET_SCAN_RE = /(sk-[A-Za-z0-9]{16,}|Bearer\s+\S+|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/g;
const REDACTED = '***REDACTED***';

// 递归脱敏：剔除敏感字段（对象/数组通用）
function redact(node) {
  if (Array.isArray(node)) return node.map(redact);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return node;
}

// P0-7：文本密钥扫描（audit/logs/traces/diagnostics 统一走这里）
function redactSecrets(text) {
  return String(text ?? '').replace(SECRET_SCAN_RE, REDACTED);
}

// P0-7：models.json 白名单脱敏（原黑名单的漏洞：accessKeyId / secretKey / api_key_encrypted
// 等变体键名层出不穷，漏一个就是明文 Key 进包）。只放行非敏感字段，其余一律剔除。
const MODELS_JSON_WHITELIST = new Set([
  'name', 'url', 'baseurl', 'base_url', 'models', 'vendor', 'providers', 'channel',
  'id', 'modelid', 'model_id', 'displayname', 'display_name',
  'supportstoolcall', 'supportsimages', 'supportsreasoning', 'supportedefforts',
  'reasoning', 'caps',
]);
function redactModels(node) {
  if (Array.isArray(node)) return node.map(redactModels);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (!MODELS_JSON_WHITELIST.has(k.toLowerCase())) continue;
      out[k] = redactModels(v);
    }
    return out;
  }
  return node;
}

// P0-7：userData 路径脱敏——诊断包会被发给他人，绝对路径含系统用户名。
// 跨平台统一表达为相对 HOME 的形式（macOS: ~/Library/Application Support/...）。
function redactUserDataPath(userData) {
  const home = app.getPath('home');
  const raw = String(userData || '');
  if (home && raw.startsWith(home)) {
    const rel = raw.slice(home.length).replace(/^[/\\]+/, '');
    return rel ? `~${path.sep}${rel}` : '~';
  }
  return raw; // 不在 HOME 下时无权推断，原样保留（调用方已知自身路径）
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// 收集诊断条目（纯函数，userData 显式传入便于测试）
function collectEntries(userData) {
  const entries = [];
  const push = (name, data) => entries.push({ name, data });
  const pushText = (name, text) => push(name, redactSecrets(text));

  // meta.json：环境指纹（userData 路径脱敏为 HOME 相对表达）
  push('meta.json', JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron || 'n/a',
    node: process.versions.node,
    userData: redactUserDataPath(userData),
  }, null, 2));

  // 审计日志（本地优先留痕，T2-6 前已脱敏截断）——行内含命令原文，统一过密钥扫描
  for (const f of ['audit-log.jsonl', 'audit-log.jsonl.1']) {
    const p = path.join(userData, f);
    if (fs.existsSync(p)) pushText(`audit/${f}`, fs.readFileSync(p, 'utf8'));
  }

  // 崩溃/异常聚合（T2-5）——stack 可能带请求 URL/头，同样过密钥扫描
  const diagDir = path.join(userData, 'diagnostics');
  for (const f of listFiles(diagDir, (n) => n.startsWith('crash-') && n.endsWith('.jsonl'))) {
    pushText(`diagnostics/${f}`, fs.readFileSync(path.join(diagDir, f), 'utf8'));
  }

  // 运行 trace（T0-5）：最多最近 10 个文件，防包体膨胀
  const traceDir = path.join(userData, 'traces');
  const traceFiles = listFiles(traceDir, (n) => n.endsWith('.jsonl'))
    .map((f) => ({ f, m: fs.statSync(path.join(traceDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 10);
  for (const { f } of traceFiles) pushText(`traces/${f}`, fs.readFileSync(path.join(traceDir, f), 'utf8'));

  // 主进程 console 日志：最近 3 个（console tee 会原样记录模型响应体，必须扫描）
  const logsDir = path.join(userData, 'logs');
  const logFiles = listFiles(logsDir, (n) => n.startsWith('main-') && n.endsWith('.log'))
    .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 3);
  for (const { f } of logFiles) pushText(`logs/${f}`, fs.readFileSync(path.join(logsDir, f), 'utf8'));

  // 脱敏配置：local-data.json 只取配置三域（providers/preferences/projects），
  // 会话与消息正文**不进包**（诊断不需要，且是用户最大面积的数据）
  const localData = readJsonSafe(path.join(userData, 'local-data.json'));
  if (localData) {
    push('config/local-data.json', JSON.stringify({
      providers: redact(localData.providers || []),
      preferences: redact(localData.preferences || {}),
      projects: redact(localData.projects || []),
    }, null, 2));
  }

  // models.json（~/.mjcode/models.json）：含明文 Key——白名单字段脱敏（P0-7）
  const modelsPath = path.join(app.getPath('home'), '.mjcode', 'models.json');
  const modelsRaw = readJsonSafe(modelsPath);
  if (modelsRaw != null) push('config/models.json', JSON.stringify(redactModels(modelsRaw), null, 2));

  // mcp-servers.json：env 与 headers 整体剔除（可含密钥/Authorization）
  const mcpRaw = readJsonSafe(path.join(userData, 'mcp-servers.json'));
  if (mcpRaw != null) push('config/mcp-servers.json', JSON.stringify(redact(mcpRaw), null, 2));

  // N9：治理命中率快照（hook / 意图预热 / 技能按需加载）——纯数字计数，无凭证风险；
  // 它是「开关是否真在生效」唯一可随包复盘的现场证据（内存计数不作为事实源，仅观测）。
  push('governance/stats.json', JSON.stringify(governanceStats.snapshot(), null, 2));

  return entries;
}

function listFiles(dir, pred) {
  try { return fs.readdirSync(dir).filter(pred); } catch { return []; }
}

// P0-7：导出前内容清单——让用户/UI 在打包前就能看到「将包含什么」，
// 而不是打完 zip 才发现里面有机密内容。返回条目名 + 体积 + 总体积。
function previewDiagPackage(userData = app.getPath('userData')) {
  const entries = collectEntries(userData);
  const list = entries.map((e) => ({
    name: e.name,
    bytes: Buffer.isBuffer(e.data) ? e.data.length : Buffer.byteLength(String(e.data), 'utf8'),
  }));
  return {
    ok: true,
    entries: list,
    totalBytes: list.reduce((n, e) => n + e.bytes, 0),
    note: '诊断包仅含本机日志与脱敏配置；所有文本已做密钥扫描，凭证字段已剔除。',
  };
}

// 导出诊断包 zip，返回落盘路径
function exportDiagnosticsZip() {
  const userData = app.getPath('userData');
  const entries = collectEntries(userData);
  const outDir = path.join(userData, 'diagnostics');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `diagnostics-${Date.now()}.zip`);
  writeZip(entries, outPath);
  return outPath;
}

// IPC 接线（main.js 调用）
function registerDiagExportIpc() {
  const { ipcMain } = require('electron');
  // P0-7：导出前清单查询（UI 确认弹层的数据源——先看内容再决定是否导出）
  // E2（登记，不静默）：本通道**未在 preload 暴露**，渲染层当前无调用方 ⇒ 实际不可达；
  // 与之配套的 diagExport 桥本身也在 test/bridge-dead-allowlist.json 台账里（导出 UI 尚未建）。
  // 保留而非删除：清单查询是导出确认弹层的既定数据源，删了要连 handler 与 preload 一起重加。
  ipcMain.handle('diag:preview', async () => {
    try {
      return previewDiagPackage();
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
  ipcMain.handle('diag:export', async () => {
    try {
      const file = exportDiagnosticsZip();
      // 回带内容清单：调用方（UI）可向用户明示本次包内包含哪些条目
      const contents = previewDiagPackage().entries.map((e) => e.name);
      return { ok: true, file, contents };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}

module.exports = {
  exportDiagnosticsZip, registerDiagExportIpc, collectEntries, redact, SENSITIVE_KEYS,
  redactSecrets, redactModels, redactUserDataPath, previewDiagPackage, SECRET_SCAN_RE, REDACTED,
};
