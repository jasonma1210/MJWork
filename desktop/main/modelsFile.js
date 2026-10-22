// 自定义模型配置文件（分组格式：providers[] 内嵌 models[]，对齐主流桌面 AI 工具的 models.json 约定）：
// ~/.mjcode/models.json → 解析校验 → 同步进 LocalStore providers（source:'file'）+ localVault。
// 路径跨 OS：os.homedir()（macOS /Users/x/.mjcode、Linux /home/x/.mjcode、Windows C:\Users\x\.mjcode）。
//
// 支持两种条目格式（2026-10-15 v2 起）：
//   A. 分组格式（推荐，与 App「一个 base_url + 一个 Key + 多 ModelId」的设计一致）：
//      { "name": "deepseek", "url": "https://api.deepseek.com", "apiKey": "sk-...",
//        "models": ["deepseek-flash", { "id": "m2", "name": "模型二" }] }
//      url 键名兼容 url / baseUrl / base_url；models 项可为字符串（=模型 id）或对象。
//   B. 扁平格式（WorkBuddy 原生，向后兼容）：每条一个模型
//      { "id": "m1", "name": "...", "vendor": "...", "url": "...", "apiKey": "..." }
//      同 url+Key 的扁平条目自动归并为一个 provider 多模型。
//
// 文件是一等事实来源：UI 对 file 来源 provider 的删除/添加会写回文件（见 removeModelFromRaw 等）；
// sync 按 fileKey（url+key 稳定哈希）对账——新增 upsert、消失即剪除，重复 sync 幂等。
// Key 安全：文件在本机（仓库外），写回时 best-effort chmod 0600；日志绝不打印 Key；
// 支持 apiKeyEnv 间接引用环境变量；Key 含非 ASCII（如占位中文）产生解析告警。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
// P1-14：原子写原语（tmp+fsync+rename）——全项目单一事实来源，与 localStore 同源
const { writeFileDurableWithMode } = require('./data/durableWrite');

const MODELS_FILE_ENV = 'MJCODE_MODELS_FILE';

// P2-17：凭证操作审计（credential_read / credential_write / credential_delete）。
// 纪律：详情**绝不包含 Key 明文**——只记来源（models.json）、服务名/模型名与操作结果；
// 审计依赖 electron（app.getPath），modelsFile 本身零依赖可单测，故惰性 require +
// 失败静默（审计不可用绝不阻塞凭证操作主流程，与 auditLog 自身纪律一致）。
function auditCredential(action, detail, result = 'recorded') {
  try {
    const { audit } = require('./audit/auditLog');
    audit(action, 'models.json', detail, result);
  } catch { /* 审计模块不可用（纯 Node 测试环境等）时静默跳过 */ }
}

// 从 raw 文本提取服务名清单（脱敏审计用；解析失败时退化为条数统计，不抛错）
function serviceNamesOf(raw) {
  try {
    const list = JSON.parse(String(raw || ''));
    if (!Array.isArray(list)) return [];
    return list.map((e) => String(e?.name || e?.vendor || e?.url || e?.base_url || '')).filter(Boolean).slice(0, 20);
  } catch { return []; }
}

function modelsFilePath() {
  if (process.env[MODELS_FILE_ENV]) return String(process.env[MODELS_FILE_ENV]);
  return path.join(os.homedir(), '.mjcode', 'models.json');
}

// 稳定标识：同一 url+Key 的条目集合在多次 sync 间保持同一 provider 身份
function fileKeyFor(baseUrl, keyRef) {
  const h = crypto.createHash('sha1').update(`${baseUrl}|${keyRef}`).digest('hex');
  return `f-${h.slice(0, 10)}`;
}

// url 兼容三种键名 + 剥完整端点（.../chat/completions）成 base_url
function entryBaseUrl(entry) {
  const raw = String(entry.url || entry.baseUrl || entry.base_url || '').trim();
  return raw.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
}

function defaultCaps(entry = {}) {
  return {
    supportsToolCall: entry.supportsToolCall !== false,
    supportsImages: entry.supportsImages === true,
    supportsReasoning: entry.supportsReasoning === true,
    ...(entry.reasoning?.supportedEfforts ? { supportedEfforts: entry.reasoning.supportedEfforts } : {}),
  };
}

// ── 预置主流模型能力目录（N1）──
// 目的：用户新增模型时只填 ID 也能拿到正确的能力位，避免「拖入截图却看不到图」。
// 口径：仅对**新增**模型按 ID 关键词给出建议（不覆盖文件里已显式声明的条目——文件是事实来源）。
// 匹配保守：命中即开（图像/推理），未命中保持默认（工具调用开、图像关、推理关）。
const IMAGE_HINTS = [
  'vl', 'vision', 'visual', 'omni', 'llava', 'pixtral', 'internvl', 'multimodal', '4o',
  'gemini', 'claude-3', 'claude-4', 'claude-sonnet', 'claude-opus', 'gpt-4.1', 'gpt-4-turbo',
  'glm-4v', 'glm-4.5v', 'kimi-vl', 'qwen-vl', 'qvq', 'gpt-4o',
];
const REASONING_HINTS = [
  'reasoner', 'reasoning', 'thinking', '-r1', 'r1-', 'qwq', 'glm-z1', 'magistral',
  // 2026-10-22：小米 MiMo 全系支持 thinking（默认关闭，用 reasoning_effort / thinking.type
  // 开启；官方明确「档位不细分，除 none 外均视为开启」）。名字不含 reasoner 之类的关键词，
  // 不加这条就永远推断成「不支持推理」，思考强度整组变灰。
  'mimo',
  'deepseek-reasoner', 'o1-', '-o1', 'o3-', '-o3', 'o4-', '-o4',
];

// 依模型 ID 关键词给出建议能力（纯函数，供新增模型时打底；未命中返回 defaultCaps）。
function suggestCaps(modelId) {
  const id = String(modelId || '').toLowerCase();
  const base = defaultCaps();
  return {
    ...base,
    supportsImages: base.supportsImages || IMAGE_HINTS.some((h) => id.includes(h)),
    supportsReasoning: base.supportsReasoning || REASONING_HINTS.some((h) => id.includes(h)),
  };
}

function keyRefOf(entry, apiKey) {
  if (entry.apiKeyEnv) return `env:${String(entry.apiKeyEnv).trim()}`;
  return apiKey ? 'key:set' : 'key:empty';
}

// 解析单个模型项：字符串（=id）或 { id, name, ...caps }
// 能力字段 = 条目级（capsSource）打底、模型级覆盖——扁平格式的 entry caps 不能丢
function parseModelItem(item, capsSource = {}) {
  const itemObj = item && typeof item === 'object' ? item : {};
  const itemId = typeof item === 'string'
    ? item.trim()
    : String(itemObj.id || itemObj.modelId || itemObj.model_id || '').trim();
  // 2026-10-22：文件里**没写**能力位时按模型 ID 给建议——与新增模型的路径（addModelToRaw）对齐。
  // 此前读取侧只走 defaultCaps ⇒ `mimo-v2.6-flash` 这类「支持思考但名字不含 reasoner」的模型
  // 被永久标成 supportsReasoning:false，模型选择器里思考强度整组变灰不可选。
  // 优先级：文件显式声明（provider 级 → 模型级）> ID 推断 > 默认。显式 false 不会被推断翻掉。
  const caps = defaultCaps({ ...suggestCaps(itemId), ...(capsSource || {}), ...itemObj });
  if (typeof item === 'string') {
    return itemId ? { modelId: itemId, displayName: itemId, caps } : null;
  }
  if (item && typeof item === 'object') {
    const id = String(item.id || item.modelId || item.model_id || '').trim();
    if (!id) return null;
    return {
      modelId: id,
      displayName: String(item.name || item.displayName || item.display_name || '').trim() || id,
      caps,
    };
  }
  return null;
}

// 解析 Key：apiKey 明文 / apiKeyEnv 环境变量间接引用（值不落文件）
function resolveApiKey(entry, env) {
  if (entry.apiKeyEnv) {
    const envName = String(entry.apiKeyEnv).trim();
    return { apiKey: String(env[envName] || ''), envName };
  }
  return { apiKey: entry.apiKey != null ? String(entry.apiKey) : '' };
}

// 纯函数：解析 + 校验 + 归并。raw 为 JSON 文本。返回 { providers, errors }
// provider: { fileKey, name, base_url, apiKey, models: [{ modelId, displayName, caps }] }
function parseModelsFile(raw, { env = process.env } = {}) {
  const errors = [];
  let list;
  try {
    list = JSON.parse(String(raw || ''));
  } catch (e) {
    return { providers: [], errors: [{ error: `JSON 解析失败：${e.message}` }] };
  }
  if (!Array.isArray(list)) return { providers: [], errors: [{ error: '配置文件必须是数组（形如 [{ name, url, apiKey, models: [...] }]）' }] };

  const groups = new Map(); // fileKey -> provider
  const ensureGroup = (fileKey, name, base, apiKey) => {
    if (!groups.has(fileKey)) {
      groups.set(fileKey, { fileKey, name, base_url: base, apiKey, models: [] });
    }
    return groups.get(fileKey);
  };

  list.forEach((entry, index) => {
    const at = `第 ${index + 1} 条`;
    if (!entry || typeof entry !== 'object') { errors.push({ index, error: `${at}：不是对象` }); return; }

    const base = entryBaseUrl(entry);
    if (!/^https?:\/\//i.test(base)) { errors.push({ index, error: `${at}：url/baseUrl 缺失或非 http(s) 地址` }); return; }

    const { apiKey, envName } = resolveApiKey(entry, env);
    if (entry.apiKeyEnv && !apiKey) {
      errors.push({ index, error: `${at}：环境变量 ${envName} 未设置（模型仍会导入，Key 为空）` });
    }
    if (apiKey && /[^\x20-\x7E]/.test(apiKey)) {
      errors.push({ index, error: `${at}：apiKey 含非 ASCII 字符（可能是占位符未替换），请求时会失败，请替换为真实 Key` });
    }

    const fileKey = fileKeyFor(base, `${keyRefOf(entry, apiKey)}|${apiKey}`);

    // 分组格式：顶层无 id、有 models 数组
    if (Array.isArray(entry.models)) {
      const name = String(entry.name || entry.vendor || '').trim();
      const group = ensureGroup(fileKey, name, base, apiKey);
      if (!group.name && name) group.name = name;
      let added = 0;
      for (const item of entry.models) {
        const m = parseModelItem(item, entry);
        if (!m) { errors.push({ index, error: `${at}：models 中存在无法解析的项（缺少 id）` }); continue; }
        if (!group.models.some((x) => x.modelId === m.modelId)) group.models.push(m);
        added += 1;
      }
      if (!group.name) group.name = group.models[0]?.displayName || base;
      if (added === 0 && entry.models.length > 0) { /* 逐项错误已记录 */ }
      return;
    }

    // 扁平格式（WorkBuddy 兼容）：顶层 id = 单模型
    const id = String(entry.id || '').trim();
    if (!id) { errors.push({ index, error: `${at}：缺少 id（扁平格式）或 models 数组（分组格式）` }); return; }
    const group = ensureGroup(fileKey, String(entry.vendor || '').trim() || String(entry.name || '').trim(), base, apiKey);
    if (!group.name) group.name = String(entry.name || '').trim() || id;
    const m = parseModelItem({ id, name: entry.name }, entry);
    if (m && !group.models.some((x) => x.modelId === m.modelId)) group.models.push(m);
  });

  return { providers: [...groups.values()], errors };
}

// 序列化（写回用）：统一产出分组格式；模型带非默认能力时保留能力字段
function serializeProviders(groups) {
  const arr = (groups || []).map((g) => {
    const models = (g.models || []).map((m) => {
      const caps = m.caps || {};
      const plain = { id: m.modelId };
      if (m.displayName && m.displayName !== m.modelId) plain.name = m.displayName;
      if (caps.supportsToolCall === false) plain.supportsToolCall = false;
      if (caps.supportsImages === true) plain.supportsImages = true;
      if (caps.supportsReasoning === true) plain.supportsReasoning = true;
      return plain;
    });
    const out = { name: g.name || '', url: g.base_url };
    if (g.apiKey) out.apiKey = g.apiKey;
    out.models = models;
    return out;
  });
  return `${JSON.stringify(arr, null, 2)}\n`;
}

// ── 迁移：把 UI 手工配置的 provider 写入配置文件（分组格式）──
// providers: store 中的 UI provider [{ id, name, base_url, keyEncrypted, models }]
// decrypt(keyEncrypted) -> 明文 Key。返回 { raw, migrated: [{ id, matched }] }
//   matched = 文件里已有同 url+Key 组（模型并入）；否则新增组。两条路都视为「已由文件承载」，
//   调用方（main）在写盘成功后删除这些 UI provider，避免同模型双份显示。
function migrateLocalProviders({ raw, providers, decrypt, env = process.env } = {}) {
  const { providers: fileGroups } = parseModelsFile(raw || '[]', { env });
  const groups = fileGroups.map((g) => ({ ...g, models: [...g.models] }));
  const migrated = [];

  for (const p of providers || []) {
    const key = String(decrypt ? decrypt(p.keyEncrypted) : p.keyEncrypted || '');
    const models = (p.models || []).map((m) => ({
      modelId: String(m.modelId || m.model_id || ''),
      displayName: String(m.displayName || m.display_name || m.modelId || m.model_id || ''),
      caps: defaultCaps(),
    })).filter((m) => m.modelId);
    if (!models.length) continue;

    let group = groups.find((g) => g.base_url === p.base_url && g.apiKey === key);
    const matched = !!group;
    if (!group) {
      group = { fileKey: fileKeyFor(p.base_url, `${key ? 'key:set' : 'key:empty'}|${key}`), name: p.name, base_url: p.base_url, apiKey: key, models: [] };
      groups.push(group);
    }
    for (const m of models) {
      if (!group.models.some((x) => x.modelId === m.modelId)) group.models.push(m);
    }
    migrated.push({ id: p.id, matched });
  }

  return { raw: serializeProviders(groups), migrated };
}

// ── 文件写回（UI 对 file 来源 provider 的增删）──
// 按 fileKey 定位组；组内最后一个模型被删除时整组移除（sync 随后剪除该 provider）。
function removeModelFromRaw(raw, fileKey, modelId, { env = process.env } = {}) {
  const { providers } = parseModelsFile(raw || '[]', { env });
  const group = providers.find((g) => g.fileKey === String(fileKey));
  if (!group) return { ok: false, error: '配置文件中找不到对应的模型服务（可能已被删除）' };
  const remaining = group.models.filter((m) => m.modelId !== String(modelId));
  if (remaining.length === group.models.length) return { ok: false, error: `该服务下不存在模型 ${modelId}` };
  const next = providers
    .map((g) => (g.fileKey === group.fileKey ? { ...group, models: remaining } : g))
    .filter((g) => g.models.length > 0);
  return { ok: true, raw: serializeProviders(next) };
}

function removeProviderFromRaw(raw, fileKey, { env = process.env } = {}) {
  const { providers } = parseModelsFile(raw || '[]', { env });
  const group = providers.find((g) => g.fileKey === String(fileKey));
  if (!group) return { ok: false, error: '配置文件中找不到对应的模型服务（可能已被删除）' };
  const next = providers.filter((g) => g.fileKey !== group.fileKey);
  return { ok: true, raw: serializeProviders(next) };
}

function addModelToRaw(raw, fileKey, modelId, displayName, { env = process.env, caps } = {}) {
  const { providers } = parseModelsFile(raw || '[]', { env });
  const group = providers.find((g) => g.fileKey === String(fileKey));
  if (!group) return { ok: false, error: '配置文件中找不到对应的模型服务（可能已被删除）' };
  const id = String(modelId || '').trim();
  if (!id) return { ok: false, error: '模型 ID 不能为空' };
  if (group.models.some((m) => m.modelId === id)) return { ok: false, error: '该模型已存在' };
  // N1：未显式传 caps 时按预置能力目录从 ID 推断（图像/推理），显式传入则以传入为准
  const finalCaps = defaultCaps({ ...suggestCaps(id), ...(caps && typeof caps === 'object' ? caps : {}) });
  const next = providers.map((g) => (g.fileKey === group.fileKey
    ? { ...group, models: [...group.models, { modelId: id, displayName: String(displayName || '').trim() || id, caps: finalCaps }] }
    : g));
  return { ok: true, raw: serializeProviders(next) };
}

// N1：写回单个模型的能力位（图像 / 工具调用 / 推理强度）。caps 只覆盖传入字段，其余保持不变。
// 序列化侧只在「非默认」时保留能力字段（图像/推理仅在 true 时写、工具调用仅在 false 时写），
// 故「关闭某能力」= 删除该字段，下次解析自然回到默认值，语义无歧义。
function setModelCapsInRaw(raw, fileKey, modelId, caps, { env = process.env } = {}) {
  const { providers } = parseModelsFile(raw || '[]', { env });
  const group = providers.find((g) => g.fileKey === String(fileKey));
  if (!group) return { ok: false, error: '配置文件中找不到对应的模型服务（可能已被删除）' };
  const target = group.models.find((m) => m.modelId === String(modelId));
  if (!target) return { ok: false, error: `该服务下不存在模型 ${modelId}` };
  const nextCaps = defaultCaps({ ...(target.caps || {}), ...(caps && typeof caps === 'object' ? caps : {}) });
  const next = providers.map((g) => (g.fileKey === group.fileKey
    ? { ...group, models: group.models.map((m) => (m.modelId === String(modelId) ? { ...m, caps: nextCaps } : m)) }
    : g));
  return { ok: true, raw: serializeProviders(next) };
}

// ── 模板与文件 IO ──
function templateContent() {
  return JSON.stringify([
    {
      name: '我的模型服务',
      url: 'https://api.example.com/v1',
      apiKey: 'sk-请替换成你的Key',
      models: ['model-id-1', 'model-id-2'],
    },
  ], null, 2) + '\n';
}

// 确保文件存在（不存在则写模板，目录 0700 / 文件 0600）；返回 { path, created }
// P1-14（2026-10-17）：模板写改走原子写原语（tmp+fsync+rename）——裸 writeFileSync
// 写一半崩溃即留下截断文件，下次 sync 解析失败会级联清空全部文件来源模型。
function ensureModelsFile(filePath = modelsFilePath()) {
  if (fs.existsSync(filePath)) return { path: filePath, created: false };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const res = writeFileDurableWithMode(filePath, templateContent(), 0o600);
  if (!res.ok) throw new Error(`模型配置文件初始化失败：${res.error}`);
  auditCredential('credential_write', '初始化 models.json（模板）', res.modeApplied ? 'recorded' : 'error');
  return { path: filePath, created: true };
}

// 读取文件原文（不存在返回 null）
// P2-17：凭证读审计（只记结果与条数，不记内容）
function readModelsFile(filePath = modelsFilePath()) {
  let raw = null;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    auditCredential('credential_read', '读取 models.json：不存在或不可读');
    return null;
  }
  auditCredential('credential_read', `读取 models.json：ok（${serviceNamesOf(raw).length} 个服务条目）`);
  return raw;
}

// P1-14 修复（2026-10-17）：明文 Key 文件写改原子写 + 写前备份。
// 背景：原 fs.writeFileSync 直接落目标文件——① 写一半崩溃/磁盘满留下截断 JSON；
// ② 下次 sync 解析失败 → keep=[] → pruneFileProviders([]) 把**全部**文件来源模型
// 清空（一次写坏 → 全部模型来源消失的级联，用户只能凭记忆重新配置）。
// 现：tmp+fsync+rename 原子写（durableWrite 单一事实来源）+ 旧内容先备份 .bak
// （只保留一代）；写失败如实抛错（调用方 IPC 层已 catch 回传），.bak 是恢复凭据。
function writeModelsFile(raw, filePath = modelsFilePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // 写前备份：旧内容留副本（覆盖上一代 .bak）——新内容写坏时用户有处可恢复
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch (e) {
    console.warn('[models] 旧配置备份失败（继续写入）:', e.message);
  }
  const res = writeFileDurableWithMode(filePath, raw, 0o600);
  if (!res.ok) {
    auditCredential('credential_write', `写回 models.json 失败：${res.error}`, 'error');
    throw new Error(`模型配置文件写入失败：${res.error}（旧内容已备份至 ${filePath}.bak）`);
  }
  if (!res.modeApplied) {
    // 0600 失效须显式留痕：文件内含明文 Key，权限失效 = 同机其他账户可读
    console.error(`[models] 模型配置文件权限收紧失败（0600 未生效）：${res.error || 'chmod 失败'}`);
    auditCredential('credential_write', '写回 models.json：ok 但 0600 权限未生效', 'error');
    return;
  }
  const names = serviceNamesOf(raw);
  auditCredential('credential_write', `写回 models.json：ok（${names.length} 个服务：${names.join(', ') || '无'}）`);
}

// 同步：parse → 对账进 store（addProvider/updateFileProvider）→ 剪除已从文件消失的条目 → vault 注入。
// 依赖注入：{ store: LocalStore, encrypt(plain)->cipher, vault: Map, env }
// 返回 { ok, synced, removed, errors, path }
function syncFileModels({ store, encrypt, vault, raw, filePath = modelsFilePath(), env = process.env } = {}) {
  const { providers, errors } = parseModelsFile(raw, { env });
  // P1-14 修复（2026-10-17）：解析失败（坏 JSON / 条目全非法）时**绝不剪除**。
  // 原实现此时 keep=[] → pruneFileProviders([]) 把全部文件来源模型清空——
  // 「一次写坏 → 清空全部模型来源」级联。现在保留 store 现状并如实报错，
  // 用户修复文件（或从 .bak 恢复）后下次同步自然恢复，中途不丢任何模型。
  if (providers.length === 0 && errors.length > 0) {
    console.error(`[models] 配置文件解析失败，保留现有模型来源不清空：${errors.map((e) => e.error).join('；')}`);
    return { ok: false, synced: 0, removed: [], errors, path: filePath, parseFailed: true };
  }
  const keep = [];
  for (const fp of providers) {
    if (!store.findProviderByFileKey(fp.fileKey)) {
      store.addProvider({
        name: fp.name, base_url: fp.base_url,
        keyEncrypted: encrypt(fp.apiKey || ''),
        modelId: fp.models[0]?.modelId || '',
        source: 'file', fileKey: fp.fileKey,
      });
    }
    // 统一走 updateFileProvider：首同步也落完整模型列表（addProvider 仅落首模型兼容字段）
    const p = store.updateFileProvider(store.findProviderByFileKey(fp.fileKey).id, {
      name: fp.name, base_url: fp.base_url,
      keyEncrypted: encrypt(fp.apiKey || ''),
      models: fp.models,
    });
    if (vault) vault.set(Number(p.id), { api_key: fp.apiKey || '', base_url: fp.base_url });
    keep.push(fp.fileKey);
    // P2-17：凭证写审计（服务名 + 模型数，绝不含 Key 明文）
    auditCredential('credential_write', `同步模型服务「${fp.name || fp.base_url}」（${fp.models.length} 个模型，来源 models.json）`);
  }
  // P2-17：剪除前记录将被删除的服务名（凭证删除审计，只记名不记 Key）
  const doomed = (store.listProviders?.() || [])
    .filter((x) => x.source === 'file' && x.fileKey && !keep.includes(x.fileKey))
    .map((x) => x.name || x.base_url);
  const removed = store.pruneFileProviders(keep);
  for (const name of doomed) {
    auditCredential('credential_delete', `模型服务「${name}」已从 models.json 消失，本地凭证随 provider 移除`);
  }
  return { ok: errors.length === 0, synced: providers.length, removed, errors, path: filePath };
}

module.exports = {
  MODELS_FILE_ENV, modelsFilePath, fileKeyFor, entryBaseUrl,
  parseModelsFile, serializeProviders, migrateLocalProviders,
  removeModelFromRaw, removeProviderFromRaw, addModelToRaw, setModelCapsInRaw, suggestCaps,
  templateContent, ensureModelsFile, readModelsFile, writeModelsFile, syncFileModels,
};
