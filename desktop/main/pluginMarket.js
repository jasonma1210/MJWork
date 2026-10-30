// 插件市场核心模块（M6 / P1+P2）
// 三类插件包：mcp（MCP Server）/ skill（技能包）/ prompt（提示词模板包）
// 统一清单：mjcode-plugin.json（对齐 Codex plugin.json）
//
// 设计要点：
//   1) 纯函数优先：清单解析、权限判定、签名校验、提示注入检测均为无 IO 纯函数，便于单测；
//   2) fail-closed：未声明的权限级别、未通过签名校验的包、未过注入检测的技能/提示词包，一律拒绝安装；
//      仅本地开发可用环境变量 MJCODE_ALLOW_UNSIGNED_PLUGIN=1 显式放宽签名要求；
//   3) 权限双闸：安装授权是「预扣」（落盘为 granted 记录），运行时每次触发对应级别操作走「实扣」
//      （checkPermission），两道闸共用 PERMISSION_LEVELS 一套级别定义。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MANIFEST_FILE = 'mjcode-plugin.json';

// 权限级别枚举：与审批矩阵（approval.js 的 L1/L2/L3 语义对齐）共用一套定义
const PERMISSION_LEVELS = ['filesystem', 'network', 'shell'];

// 插件形态枚举
const PLUGIN_TYPES = ['mcp', 'skill', 'prompt'];

// 需要做提示注入检测的形态（纯文本注入 prompt，直接进入模型上下文）
const PROMPT_INJECTABLE_TYPES = ['skill', 'prompt'];

// ── 清单 ────────────────────────────────────────────────────────────

// 规范化插件名：小写、允许字母数字与 . _ -，禁止路径穿越
function normalizeName(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

// 插件名合法性（防目录穿越 / 非法字符）
function isValidName(name) {
  const n = normalizeName(name);
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(n) && !n.includes('..');
}

// 半角版本号：主.次.修订，可带预发布/构建后缀
function isValidVersion(v) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(v || '').trim());
}

// 解析清单（JSON 字符串或已解析对象）
function parseManifest(input) {
  let raw = input;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try {
      raw = JSON.parse(String(raw));
    } catch (e) {
      return { ok: false, errors: [`清单不是合法 JSON：${e.message}`] };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['清单必须是 JSON 对象'] };
  }
  return { ok: true, manifest: raw, errors: [] };
}

// 校验清单结构。返回 { ok, errors }，errors 为简体中文可展示文案
function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['清单必须是 JSON 对象'] };
  }

  // name
  const name = normalizeName(manifest.name);
  if (!name) errors.push('缺少必填字段 name');
  else if (!isValidName(name)) errors.push(`插件名非法：${manifest.name}（仅允许字母数字与 . _ -，且不得含路径穿越）`);

  // version
  if (!manifest.version) errors.push('缺少必填字段 version');
  else if (!isValidVersion(manifest.version)) errors.push(`版本号非法：${manifest.version}（应为 1.2.0 形式的语义化版本）`);

  // type
  if (!manifest.type) errors.push('缺少必填字段 type');
  else if (!PLUGIN_TYPES.includes(manifest.type)) {
    errors.push(`插件形态非法：${manifest.type}（仅允许 ${PLUGIN_TYPES.join(' / ')}）`);
  }

  // entry：mcp 形态必须有可执行入口；skill / prompt 允许省略
  if (manifest.entry != null) {
    if (typeof manifest.entry !== 'object' || Array.isArray(manifest.entry)) {
      errors.push('entry 必须是对象');
    } else if (manifest.type === 'mcp') {
      if (!manifest.entry.command || typeof manifest.entry.command !== 'string') {
        errors.push('mcp 形态必须声明 entry.command');
      }
      if (manifest.entry.args != null && !Array.isArray(manifest.entry.args)) {
        errors.push('entry.args 必须是字符串数组');
      }
    }
  } else if (manifest.type === 'mcp') {
    errors.push('mcp 形态必须声明 entry');
  }

  // permissions：交给权限解析器判定级别合法性
  const perms = parsePermissions(manifest.permissions);
  errors.push(...perms.errors);

  // 未知顶层字段不阻断，但签名与发布者需类型正确
  if (manifest.signature != null && typeof manifest.signature !== 'string') {
    errors.push('signature 必须是字符串');
  }
  if (manifest.publisher != null && typeof manifest.publisher !== 'string') {
    errors.push('publisher 必须是字符串');
  }

  return { ok: errors.length === 0, errors };
}

// 规范化后的清单视图（安装时落盘用）
function normalizeManifest(manifest) {
  const perms = parsePermissions(manifest.permissions);
  return {
    name: normalizeName(manifest.name),
    version: String(manifest.version).trim(),
    type: manifest.type,
    description: String(manifest.description || '').slice(0, 500),
    author: String(manifest.author || '').slice(0, 200),
    publisher: String(manifest.publisher || '').slice(0, 200),
    homepage: String(manifest.homepage || '').slice(0, 500),
    tags: Array.isArray(manifest.tags) ? manifest.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : [],
    entry: manifest.entry && typeof manifest.entry === 'object' ? manifest.entry : null,
    permissions: perms.list,
    signature: typeof manifest.signature === 'string' ? manifest.signature : '',
    installedAt: Date.now(),
  };
}

// ── 权限声明 ────────────────────────────────────────────────────────

// 解析 permissions 数组 → { levels: {level: [scope...]}, list, errors }
// 未声明的级别即「无权限」，运行时默认拒绝（fail-closed）
function parsePermissions(input) {
  const errors = [];
  const levels = { filesystem: [], network: [], shell: [] };
  const list = [];

  if (input == null) return { ok: true, levels, list, errors };
  if (!Array.isArray(input)) {
    return { ok: false, levels, list, errors: ['permissions 必须是数组'] };
  }

  input.forEach((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`permissions[${idx}] 必须是对象`);
      return;
    }
    const level = String(item.level || '').trim();
    if (!PERMISSION_LEVELS.includes(level)) {
      errors.push(`permissions[${idx}].level 非法：${item.level}（仅允许 ${PERMISSION_LEVELS.join(' / ')}）`);
      return;
    }
    // scope 缺省视为通配（该级别全量），显式声明时按字符串数组或单字符串处理
    let scopes;
    if (item.scope == null) scopes = ['*'];
    else if (Array.isArray(item.scope)) scopes = item.scope.map((s) => String(s).trim()).filter(Boolean);
    else if (typeof item.scope === 'string') scopes = item.scope.trim() ? [item.scope.trim()] : ['*'];
    else {
      errors.push(`permissions[${idx}].scope 必须是字符串或字符串数组`);
      return;
    }
    if (scopes.length === 0) scopes = ['*'];
    for (const s of scopes) levels[level].push(s);
    // list 中 scope 统一为数组，便于面板直接渲染
    list.push({ level, scope: scopes });
  });

  return { ok: errors.length === 0, levels, list, errors };
}

// scope 匹配：'*' 通配全量；'*.example.com' 匹配子域；否则精确匹配
function scopeMatches(pattern, scope) {
  const p = String(pattern || '').trim();
  const s = String(scope == null ? '*' : scope).trim() || '*';
  if (p === '*') return true;
  if (p === s) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // 保留前导点
    return s.endsWith(suffix) && s.length > suffix.length;
  }
  return false;
}

// 权限闸门（实扣）：插件是否被授予某级别某范围
// 返回 { allow, reason, level, scope } —— 未声明级别一律拒绝
function checkPermission(granted, level, scope = '*') {
  const lv = String(level || '').trim();
  if (!PERMISSION_LEVELS.includes(lv)) {
    return { allow: false, reason: `未知权限级别：${level}`, level: lv, scope };
  }
  const scopes = (granted && granted[lv]) || [];
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { allow: false, reason: `插件未声明 ${lv} 权限，默认拒绝`, level: lv, scope };
  }
  if (scopes.some((p) => scopeMatches(p, scope))) {
    return { allow: true, reason: `${lv} 权限已授予`, level: lv, scope };
  }
  return { allow: false, reason: `${lv} 权限范围不包含 ${scope}`, level: lv, scope };
}

// 运行时实扣：查已安装插件的预扣授权记录再判定
function authorizePluginAction(registry, pluginName, level, scope = '*') {
  const entry = registry && typeof registry.get === 'function' ? registry.get(pluginName) : null;
  if (!entry) return { allow: false, reason: `插件未安装：${pluginName}` };
  if (entry.enabled === false) return { allow: false, reason: `插件已停用：${entry.name}` };
  const perms = parsePermissions(entry.permissions).levels;
  return checkPermission(perms, level, scope);
}

// 安装面板用的人类可读权限清单
function summarizePermissions(permissions) {
  const LABEL = { filesystem: '访问文件系统', network: '访问网络', shell: '执行系统命令' };
  return parsePermissions(permissions).list.map((p) => ({
    level: p.level,
    label: LABEL[p.level] || p.level,
    scope: Array.isArray(p.scope) ? p.scope : [p.scope],
    text: Array.isArray(p.scope) && p.scope.length === 1 && p.scope[0] === '*'
      ? `${LABEL[p.level] || p.level}（全部）`
      : `${LABEL[p.level] || p.level}：${(Array.isArray(p.scope) ? p.scope : [p.scope]).join('、')}`,
  }));
}

// ── 签名校验（fail-closed）──────────────────────────────────────────

// 签名策略：默认只接受 sigstore（npm provenance）；本地开发可显式放宽
function resolveSignaturePolicy(env = process.env) {
  return {
    allowUnsigned: String(env.MJCODE_ALLOW_UNSIGNED_PLUGIN || '') === '1',
    requireSigstore: String(env.MJCODE_ALLOW_UNSIGNED_PLUGIN || '') !== '1',
  };
}

// 规范化摘要：字段名排序、剔除 signature 自身，用于 sha256 内容完整性校验
function canonicalPayload(manifest) {
  const clone = { ...manifest };
  delete clone.signature;
  const sortKeys = (obj) => {
    if (Array.isArray(obj)) return obj.map(sortKeys);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
      return out;
    }
    return obj;
  };
  return JSON.stringify(sortKeys(clone));
}

function computeDigest(manifest) {
  return crypto.createHash('sha256').update(canonicalPayload(manifest), 'utf8').digest('hex');
}

// 签名校验。
//   sigstore:<载荷> —— 发布者身份保证，需外部校验器（生产环境接 sigstore/cosign）
//   sha256:<摘要>   —— 内容完整性校验（防传输损坏），不构成发布者身份保证
// 返回 { ok, reason, method, publisher }。任何不确定情形一律 ok=false（fail-closed）
async function verifySignature(manifest, options = {}) {
  const policy = { ...resolveSignaturePolicy(), ...(options.policy || {}) };
  const verifier = options.verifier || null;
  const pinnedPublishers = Array.isArray(options.pinnedPublishers) ? options.pinnedPublishers : [];

  const raw = manifest && typeof manifest.signature === 'string' ? manifest.signature.trim() : '';

  // 未签名：仅本地开发环境变量显式放宽
  if (!raw) {
    if (policy.allowUnsigned) return { ok: true, reason: '本地开发模式已放宽签名要求', method: 'unsigned-dev', publisher: '' };
    return { ok: false, reason: '插件未签名，已拒绝安装（如需本地开发请设置 MJCODE_ALLOW_UNSIGNED_PLUGIN=1）', method: 'none', publisher: '' };
  }

  const idx = raw.indexOf(':');
  if (idx <= 0) {
    return { ok: false, reason: `签名格式非法：缺少方案前缀（期望 sigstore: 或 sha256:）`, method: 'invalid', publisher: '' };
  }
  const scheme = raw.slice(0, idx).toLowerCase();
  const payload = raw.slice(idx + 1).trim();
  if (!payload) return { ok: false, reason: '签名载荷为空', method: 'invalid', publisher: '' };

  // sha256：仅内容完整性
  if (scheme === 'sha256') {
    if (!/^[0-9a-f]{64}$/i.test(payload)) {
      return { ok: false, reason: 'sha256 签名载荷不是合法的 64 位十六进制摘要', method: 'sha256', publisher: '' };
    }
    if (policy.requireSigstore) {
      return {
        ok: false,
        reason: 'sha256 仅提供内容完整性，不构成发布者身份保证，已拒绝安装（请使用 npm provenance 的 sigstore 签名）',
        method: 'sha256', publisher: '',
      };
    }
    if (payload.toLowerCase() !== computeDigest(manifest)) {
      return { ok: false, reason: '内容摘要与签名不一致，插件可能已被篡改', method: 'sha256', publisher: '' };
    }
    return { ok: true, reason: '内容完整性校验通过', method: 'sha256', publisher: String(manifest.publisher || '') };
  }

  // sigstore：需外部校验器确认发布者身份
  if (scheme === 'sigstore') {
    if (typeof verifier !== 'function') {
      return { ok: false, reason: '缺少 sigstore 校验器，无法确认发布者身份，已拒绝安装', method: 'sigstore', publisher: '' };
    }
    let res;
    try {
      res = await verifier(payload, manifest);
    } catch (e) {
      return { ok: false, reason: `签名校验异常：${e.message}`, method: 'sigstore', publisher: '' };
    }
    if (!res) return { ok: false, reason: '签名校验未通过', method: 'sigstore', publisher: '' };
    const publisher = String((res && res.publisher) || manifest.publisher || '');
    if (pinnedPublishers.length > 0 && !pinnedPublishers.includes(publisher)) {
      return { ok: false, reason: `发布者不在信任名单：${publisher || '（未知）'}`, method: 'sigstore', publisher };
    }
    return { ok: true, reason: 'sigstore 签名校验通过', method: 'sigstore', publisher };
  }

  return { ok: false, reason: `不支持的签名方案：${scheme}`, method: scheme, publisher: '' };
}

// 为本地开发/自签包生成 sha256 摘要签名（不含发布者身份保证，仅内容完整性）
function signWithDigest(manifest) {
  return { ...manifest, signature: `sha256:${computeDigest(manifest)}` };
}

// ── 提示注入检测（技能包 / 提示词模板包）────────────────────────────
// A1（2026-10-16）：规则与检测函数统一收敛到 shared/untrustedContent.mjs（跨宿主唯一事实来源）——
// 主进程（安装闸门）、headless 引擎（AGENTS.md / 技能 / 记忆 / 工具结果四入口）共用同一份规则，
// 从结构上消灭「两份规则各自漂移 + 用源码字符串断言维系一致」的旧模式。
//
// 主进程是 CJS，而 Electron 33 捆绑的 Node 20 无法同步 require ESM，故沿用动态 import + ready 门
// （与 agentRunner 加载 shared-ipc/contract.mjs 同款）。未就绪即调用视为 **fail-closed 抛错**：
// 宁可拒绝安装，也绝不放行未扫描的内容。
let untrustedShared = null;
let untrustedLoadError = null;
const promptInjectionReady = import('../shared/untrustedContent.mjs')
  .then((m) => { untrustedShared = m; })
  .catch((e) => {
    untrustedLoadError = e;
    console.error('[pluginMarket] 注入规则模块加载失败（fail-closed，安装闸门将拒绝放行）:', e.message);
  });

function requireUntrusted() {
  if (untrustedShared) return untrustedShared;
  throw new Error(`注入规则模块不可用${untrustedLoadError ? `（${untrustedLoadError.message}）` : '（尚未加载完成，请先 await promptInjectionReady）'}`);
}

/** 同步检测入口（规则未就绪即抛错——fail-closed，绝不静默放行） */
function detectPromptInjection(content, options) {
  return requireUntrusted().detectPromptInjection(content, options);
}

// 扫描技能/提示词包：SKILL.md / PROMPTS.md / prompts/*.md
async function scanPromptPackage(pkgDir, options = {}) {
  await promptInjectionReady; // 安装闸门必须先等规则就绪（否则 requireUntrusted 会抛错）
  const targets = [];
  const push = (p) => { if (fs.existsSync(p)) targets.push(p); };
  push(path.join(pkgDir, 'SKILL.md'));
  push(path.join(pkgDir, 'PROMPTS.md'));
  push(path.join(pkgDir, 'README.md'));
  const promptsDir = path.join(pkgDir, 'prompts');
  if (fs.existsSync(promptsDir)) {
    for (const f of fs.readdirSync(promptsDir)) {
      if (/\.md$/i.test(f)) push(path.join(promptsDir, f));
    }
  }
  const files = [];
  for (const file of targets) {
    const res = detectPromptInjection(fs.readFileSync(file, 'utf8'), options);
    if (res.suspicious) files.push({ file: path.basename(file), findings: res.findings });
  }
  return { suspicious: files.length > 0, files };
}

// ── 安装源校验 ──────────────────────────────────────────────────────

// 允许的 git 来源：http/https/ssh/git/file 协议与本地绝对路径
const ALLOWED_GIT_PROTOCOLS = ['http:', 'https:', 'ssh:', 'git:', 'file:'];

// 校验 git 来源，阻断参数注入与 git ext 协议（--upload-pack 可直接执行命令）
function validateGitSource(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return { ok: false, reason: 'git 地址不能为空' };
  if (/[\r\n\0]/.test(raw)) return { ok: false, reason: 'git 地址含非法控制字符' };
  if (raw.startsWith('-')) return { ok: false, reason: 'git 地址不得以 - 开头（防参数注入）' };
  if (/^ext::/i.test(raw) || /--upload-pack/i.test(raw) || /--config/i.test(raw)) {
    return { ok: false, reason: 'git 地址包含被禁止的协议或参数（ext:: / --upload-pack / --config）' };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let proto;
    try {
      proto = new URL(raw).protocol;
    } catch {
      return { ok: false, reason: 'git 地址格式非法' };
    }
    if (!ALLOWED_GIT_PROTOCOLS.includes(proto)) {
      return { ok: false, reason: `不支持的 git 协议：${proto}（仅允许 ${ALLOWED_GIT_PROTOCOLS.join(' ')}）` };
    }
    return { ok: true, url: raw };
  }
  if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { ok: true, url: path.resolve(raw) }; // 本地路径（测试与本地开发）
  }
  // 形如 github.com/user/repo 的简写
  if (/^[\w.-]+\/[\w.-]+\/?[\w.-]*$/.test(raw)) return { ok: true, url: `https://${raw}.git` };
  return { ok: false, reason: 'git 地址格式非法' };
}

// git ref 合法性（防注入到 git 子命令参数）
function isValidRef(ref) {
  if (ref == null || ref === '') return true;
  const r = String(ref);
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(r) && !r.includes('..');
}

// ── 已安装插件注册表（JSON 原子持久化）─────────────────────────────

class PluginRegistry {
  constructor(pluginsRoot) {
    this.root = pluginsRoot;
    this.file = path.join(pluginsRoot, 'plugins.json');
    this.tmp = this.file + '.tmp';
    this.data = this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw.plugins) ? raw.plugins : []);
      return { plugins: list.map((p) => ({ ...p, name: normalizeName(p.name) })) };
    } catch (e) {
      // C-001：这里返回空表的后果比「列表空」严重得多——后续任意 flush() 会把空表原子写回
      // plugins.json，等于**用读失败的结果覆盖用户已装插件**。首次运行（ENOENT）是正常空态，
      // 其余（JSON 损坏 / 权限不足）必须出声，否则用户只看到「插件全没了」。
      // 未改的行为：仍不阻断启动（注册表坏了不该让人打不开应用），但把成因写进日志可回溯。
      if (e?.code !== 'ENOENT') console.warn('[pluginMarket] plugins.json 读取/解析失败，本次按空注册表进入（注意：之后任一次 flush 会覆盖该文件）：', this.file, e?.message || e);
      return { plugins: [] };
    }
  }

  // 原子写：临时文件 + rename，避免崩溃损坏
  flush() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.tmp, JSON.stringify({ plugins: this.data.plugins }, null, 2));
    fs.renameSync(this.tmp, this.file);
  }

  list() {
    return [...this.data.plugins].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  get(name) {
    const n = normalizeName(name);
    return this.data.plugins.find((p) => p.name === n) || null;
  }

  // 新增或覆盖安装记录
  add(entry) {
    const name = normalizeName(entry && entry.name);
    if (!name) throw new Error('插件记录缺少 name');
    const idx = this.data.plugins.findIndex((p) => p.name === name);
    const record = { ...entry, name };
    if (idx >= 0) this.data.plugins[idx] = { ...this.data.plugins[idx], ...record };
    else this.data.plugins.push(record);
    this.flush();
    return record;
  }

  remove(name) {
    const n = normalizeName(name);
    const before = this.data.plugins.length;
    this.data.plugins = this.data.plugins.filter((p) => p.name !== n);
    this.flush();
    return this.data.plugins.length !== before;
  }

  setEnabled(name, enabled) {
    const p = this.get(name);
    if (!p) return null;
    p.enabled = !!enabled;
    this.flush();
    return p;
  }

  // 某插件的落盘目录
  dirOf(name) {
    return path.join(this.root, normalizeName(name));
  }

  clear() {
    this.data.plugins = [];
    this.flush();
  }
}

// ── 安装流程 ────────────────────────────────────────────────────────

// 从插件源目录完成安装（清单 → 签名 → 注入检测 → 落盘 → 登记）
// 这是 git 安装与本地目录安装共用的核心，便于单测
async function installFromSourceDir(srcDir, options = {}) {
  const { pluginsRoot, manifestFile = MANIFEST_FILE, policy, verifier, allowUnsafeInjection = false } = options;
  const registry = options.registry || new PluginRegistry(pluginsRoot);

  const rawManifest = fs.readFileSync(path.join(srcDir, manifestFile), 'utf8');
  const parsed = parseManifest(rawManifest);
  if (!parsed.ok) return { ok: false, stage: 'manifest', errors: parsed.errors };
  const manifest = parsed.manifest;

  const valid = validateManifest(manifest);
  if (!valid.ok) return { ok: false, stage: 'manifest', errors: valid.errors };

  // 签名闸门（fail-closed）
  const sig = await verifySignature(manifest, { policy, verifier });
  if (!sig.ok) return { ok: false, stage: 'signature', errors: [sig.reason] };

  // 提示注入闸门（仅 skill / prompt）
  let injection = null;
  if (PROMPT_INJECTABLE_TYPES.includes(manifest.type) && !allowUnsafeInjection) {
    injection = await scanPromptPackage(srcDir);
    if (injection.suspicious) {
      const detail = injection.files
        .map((f) => `${f.file}（${f.findings.map((x) => x.id).join(',')}）`)
        .join('；');
      return { ok: false, stage: 'injection', errors: [`检测到提示注入特征，已拒绝安装：${detail}`] };
    }
  }

  // 落盘：复制到 userData 插件目录后登记
  const record = normalizeManifest(manifest);
  record.source = String(options.source || 'git');
  record.signatureMethod = sig.method;
  record.publisher = sig.publisher || record.publisher;
  record.dir = registry.dirOf(record.name);
  record.enabled = true;

  fs.mkdirSync(pluginsRoot, { recursive: true });
  copyDir(srcDir, registry.dirOf(record.name));

  // 技能包落盘到技能目录约定位置（~/.mjcode/skills/<name>），由调用方传入 skillsRoot
  if (options.skillsRoot && manifest.type === 'skill') {
    const dest = path.join(options.skillsRoot, record.name);
    fs.mkdirSync(options.skillsRoot, { recursive: true });
    copyDir(srcDir, dest);
    record.skillsDir = dest;
  }

  registry.add(record);
  return { ok: true, plugin: registry.get(record.name), signature: sig, injection };
}

// 从本地目录安装（免 git 依赖，便于测试与离线使用）
function installFromLocalDir(srcDir, options = {}) {
  return installFromSourceDir(srcDir, { ...options, source: options.source || 'local' });
}

// 从 git 仓库安装：clone 到临时目录 → 走统一安装核心 → 清理临时目录
async function installFromGit(url, options = {}) {
  const check = validateGitSource(url);
  if (!check.ok) return { ok: false, stage: 'source', errors: [check.reason] };
  if (!isValidRef(options.ref)) return { ok: false, stage: 'source', errors: ['ref 格式非法'] };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-plugin-'));
  try {
    const args = ['clone', '--depth', '1'];
    if (options.ref) args.push('--branch', String(options.ref));
    args.push(check.url, tmpDir);
    // execFile 传数组参数，不经 shell，避免命令注入
    const { error, stderr } = await new Promise((resolve) => {
      execFile('git', args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, _so, stderr) => {
        resolve({ error: error || null, stderr: String(stderr || '') });
      });
    });
    if (error) return { ok: false, stage: 'clone', errors: [`git clone 失败：${error.message}${stderr ? `（${stderr.slice(0, 300)}）` : ''}`] };

    // 单包仓库：清单可能在根目录或唯一的子目录
    let srcDir = tmpDir;
    if (!fs.existsSync(path.join(tmpDir, MANIFEST_FILE))) {
      const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== '.git')
        .filter((e) => fs.existsSync(path.join(tmpDir, e.name, MANIFEST_FILE)));
      if (sub.length === 1) srcDir = path.join(tmpDir, sub[0].name);
      else if (options.skillFallback && fs.existsSync(path.join(tmpDir, 'SKILL.md'))) {
        // 网络技能仓库回落：大量 GitHub 技能仓库没有 mjcode-plugin.json 清单，
        // 只有 SKILL.md。合成最小清单后走完整安装管道（提示注入检测照常，
        // 签名闸门由调用方按审批语义放宽——审批卡是用户的显式同意）。
        const name = normalizeName(options.fallbackName || path.basename(check.url.replace(/\.git$/, '')));
        if (!isValidName(name)) return { ok: false, stage: 'manifest', errors: [`无法从仓库推导合法技能名：${name}`] };
        const synth = {
          name,
          version: '0.1.0',
          type: 'skill',
          description: `网络安装技能（来源 ${check.url}）`,
          permissions: [{ level: 'filesystem', scope: '*' }],
        };
        fs.writeFileSync(path.join(tmpDir, MANIFEST_FILE), JSON.stringify(synth, null, 2));
        srcDir = tmpDir;
      } else return { ok: false, stage: 'manifest', errors: [`仓库内未找到 ${MANIFEST_FILE}`] };
    }

    const res = await installFromSourceDir(srcDir, { ...options, source: `git:${check.url}` });
    return res;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 递归复制目录（跳过 .git 与 node_modules）
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) continue; // 不跟随软链，防越界读取
    else fs.copyFileSync(s, d);
  }
}

// 卸载：删除插件目录并从注册表移除
// 目录删除做归属校验：必须等于注册表推导出的插件目录，或位于调用方登记的 skillsRoot 之下
function uninstall(registry, name, options = {}) {
  const entry = registry.get(name);
  if (!entry) return { ok: false, error: '插件未安装' };

  const allowed = [registry.dirOf(entry.name)];
  if (options.skillsRoot) allowed.push(path.join(options.skillsRoot, entry.name));

  registry.remove(entry.name);
  for (const dir of [entry.dir, entry.skillsDir].filter(Boolean)) {
    if (!allowed.includes(dir)) continue;
    if (path.basename(dir) !== entry.name) continue; // 双保险：目录名须等于插件名
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ok: true };
}

module.exports = {
  MANIFEST_FILE,
  PERMISSION_LEVELS,
  PLUGIN_TYPES,
  PROMPT_INJECTABLE_TYPES,
  // 规则表改为惰性取用共享模块（主进程不再存第二份副本）；未就绪访问即抛错（fail-closed）
  get INJECTION_RULES() { return requireUntrusted().INJECTION_RULES; },
  ALLOWED_GIT_PROTOCOLS,
  normalizeName,
  isValidName,
  isValidVersion,
  parseManifest,
  validateManifest,
  normalizeManifest,
  parsePermissions,
  scopeMatches,
  checkPermission,
  authorizePluginAction,
  summarizePermissions,
  resolveSignaturePolicy,
  canonicalPayload,
  computeDigest,
  verifySignature,
  signWithDigest,
  detectPromptInjection,
  promptInjectionReady,
  scanPromptPackage,
  validateGitSource,
  isValidRef,
  PluginRegistry,
  installFromSourceDir,
  installFromLocalDir,
  installFromGit,
  copyDir,
  uninstall,
};