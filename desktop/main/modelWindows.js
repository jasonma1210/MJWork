// P0-1②: provider × modelId → 上下文窗口「事实表」（**零依赖纯函数模块**）
//
// 为什么必须单独成文件、且**禁止 require 任何模块**：
//   agent-core 是 headless 引擎（可被渲染层 Vite 与 server 子进程双宿主加载），引擎内的窗口兜底
//   常量将来要引用本表；一旦本文件 require 了 Electron 主进程模块，引擎的「零依赖」纪律就破了
//   （既有论证见 agent-core/index.js 关于「不 require 主进程模块」的注释）。
//   本文件只允许：常量 + 纯函数。渲染层另有一份同表 TS 版（renderer/src/lib/modelWindows.ts），
//   由 test/model-windows-parity.test.mjs 深度比对防漂移。
//
// 事实依据（H-1 / 施工单 P0-1）：
//   · 默认值必须**下调**并分两档：表外未知模型 32768；Ollama 探测失败取官方最小档 4096。
//     「两侧错配代价不对称」——低估只早压（浪费），高估则压缩永不触发（直接击穿上下文）。
//   · Ollama **禁止**在表里写死任何窗口值：官方 `OLLAMA_CONTEXT_LENGTH` 代码默认 0=未指定，
//     运行时按显存自适应 4k/32k/256k；唯一可信来源是 `GET /api/show` 的 num_ctx（见 resourceQuotaCenter）。
//   · 必须按 (providerKind, modelId) 二元组查表：Anthropic 直连 / Bedrock / Vertex 对同一个
//     `claude-sonnet` 解析出不同上下文，只按模型别名查必然错配。

const DEFAULT_CONTEXT_WINDOW = 32768;
const OLLAMA_UNKNOWN_NUM_CTX = 4096;

// 键格式强制 "<providerKind>:<modelId>"（modelId 归一化为小写、去 models/ 前缀与 '/vendor/' 段）
//
// ⚠️ 下面两处**有意偏离**施工单 P0-1 的示例值，已由主理人裁决批准（2026-10-18），别再"按施工单改回去"：
//   1) anthropic-api 的 claude-* 取 200000，不是施工单写的 1000000：
//      1M 需要 `anthropic-beta: context-1m-*` 请求头，本项目**不下发**该 header；写 1M = 高估
//      ⇒ 压缩永不触发 ⇒ 直接击穿上下文。按 H-1 的代价不对称（低估只早压浪费 token、高估击穿），取 200K。
//   2) openai:gpt-4.1* 取 1047576，不是施工单写的 128000：官方真实值优先于施工单的近似值，
//      否则 1M 模型会被按 128K 提前压缩 8 倍。
const MODEL_WINDOWS = {
  'openai:gpt-4o': 128000,
  'openai:gpt-4o-mini': 128000,
  'openai:gpt-4.1': 1047576,
  'openai:gpt-4.1-mini': 1047576,
  'openai:gpt-4.1-nano': 1047576,
  'openai:gpt-5': 400000,
  'openai:gpt-5-mini': 400000,
  'openai:o3': 200000,
  'openai:o4-mini': 200000,
  'openai:gpt-4-turbo': 128000,
  // 2026-10-22：MiMo V2.6 Flash 官方 1M（用户提供的官方口径）。
  // 刻意**不加** `mimo-*` 族规则：族规则会把未见过的小窗口版本一起高估，
  // 而 H-1 的代价不对称要求「宁可低估早压，不可高估击穿」。
  'mimo:mimo-v2.6-flash': 1048576,
  'deepseek:deepseek-chat': 131072,
  'deepseek:deepseek-reasoner': 131072,
  'qwen:qwen3-8b': 131072,
  'qwen:qwen3-14b': 131072,
  'qwen:qwen3-32b': 131072,
  'gemini:gemini-2.5-pro': 1048576,
  'gemini:gemini-2.5-flash': 1048576,
};

// 模型族兜底（同 provider 下同族模型窗口一致时用；避免为每个版本号逐条登记）
// ⚠️ anthropic-api 取 200000 而非施工单的 1000000 的理由，见上方 MODEL_WINDOWS 前的两条偏离说明。
const MODEL_FAMILIES = [
  { kind: 'anthropic-api', prefixes: ['claude-'], window: 200000 },
  { kind: 'bedrock', prefixes: ['claude-', 'anthropic.claude'], window: 200000 },
  { kind: 'deepseek', prefixes: ['deepseek-'], window: 131072 },
  { kind: 'qwen', prefixes: ['qwen3-'], window: 131072 },
  { kind: 'gemini', prefixes: ['gemini-'], window: 1048576 },
];

const PROVIDER_KINDS = ['openai', 'deepseek', 'anthropic-api', 'bedrock', 'qwen', 'gemini', 'mimo', 'ollama'];

// providerId → kind 的别名（服务端 provider 的 id 可能是厂商名而不是数字）
const KIND_ALIASES = {
  openai: 'openai', 'azure-openai': 'openai', azure: 'openai',
  deepseek: 'deepseek',
  anthropic: 'anthropic-api', 'anthropic-api': 'anthropic-api',
  bedrock: 'bedrock', aws: 'bedrock',
  qwen: 'qwen', dashscope: 'qwen', aliyun: 'qwen',
  gemini: 'gemini', google: 'gemini',
  mimo: 'mimo', xiaomi: 'mimo',
  ollama: 'ollama',
};

// baseUrl 主机特征 → providerKind（确定性字符串匹配，非语义判断）
// 顺序有意义：Ollama 优先（本机端口最独特），openai 放最后（避免吞掉 azure/代理域名）
const HOST_RULES = [
  { kind: 'ollama', tokens: ['11434', 'ollama'] },
  { kind: 'anthropic-api', tokens: ['api.anthropic.com'] },
  { kind: 'bedrock', tokens: ['bedrock'] },
  { kind: 'deepseek', tokens: ['deepseek.com'] },
  { kind: 'qwen', tokens: ['dashscope.aliyuncs.com', 'api.qwen.com'] },
  { kind: 'gemini', tokens: ['generativelanguage.googleapis.com'] },
  // 2026-10-22：小米 MiMo（api.xiaomimimo.com）。未登记时 kind=unknown ⇒ 永远走默认档 32768，
  // 1M 窗口的模型会被当 32K 用（工具表误裁、每轮压缩）。
  { kind: 'mimo', tokens: ['xiaomimimo.com'] },
  { kind: 'openai', tokens: ['api.openai.com', 'openai.azure.com'] },
];

function hostOf(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    // 非法 URL（缺协议 / 只有主机名）：退化为手工提取，仍是纯字符串运算
    const m = raw.replace(/^[a-z]+:\/\//i, '').match(/^([^/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
}

// providerId + baseUrl → providerKind（未知返回 'unknown'，此时一律走默认档且 confirmed:false）
function providerKindOf({ providerId, baseUrl } = {}) {
  const host = hostOf(baseUrl);
  if (host) {
    for (const rule of HOST_RULES) {
      if (rule.tokens.some((tk) => host.includes(tk))) return rule.kind;
    }
  }
  const pid = String(providerId == null ? '' : providerId).trim().toLowerCase();
  if (pid && KIND_ALIASES[pid]) return KIND_ALIASES[pid];
  return 'unknown';
}

// 模型 id 归一化：小写、去 models/ 前缀、取最后一段路径、去聚合网关的 ":free"/":nitro" 标记
function normalizeModelId(modelId) {
  let id = String(modelId == null ? '' : modelId).trim().toLowerCase();
  if (!id) return '';
  id = id.replace(/^models\//, '');
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  const colon = id.indexOf(':');
  if (colon > 0) id = id.slice(0, colon);
  return id;
}

/**
 * 解析上下文窗口。四态返回，供 UI（P1-12）区分「精确命中 / 同族推断 / 按默认估算」。
 * @param {object} opts
 * @param {string|number} [opts.providerId]  provider id（数字或厂商名）
 * @param {string} [opts.baseUrl]            provider base_url（主机特征优先用于判定 kind）
 * @param {string} [opts.modelId]            模型 id
 * @param {number} [opts.probedNumCtx]       Ollama 探测到的 num_ctx（唯一可信来源）
 * @returns {{window: number, confirmed: boolean, source: 'table'|'family'|'default'|'ollama-probe'}}
 */
function resolveWindow({ providerId, baseUrl, modelId, probedNumCtx } = {}) {
  const kind = providerKindOf({ providerId, baseUrl });
  const id = normalizeModelId(modelId);

  // Ollama：表内禁止写死（H-1）。只有探测值可信；探测缺失时取官方最小档 4096 并标未确认。
  if (kind === 'ollama') {
    const probed = Number(probedNumCtx) > 0 ? Math.floor(Number(probedNumCtx)) : 0;
    if (probed > 0) return { window: probed, confirmed: true, source: 'ollama-probe' };
    return { window: OLLAMA_UNKNOWN_NUM_CTX, confirmed: false, source: 'default' };
  }

  const exact = id ? MODEL_WINDOWS[kind + ':' + id] : 0;
  if (exact > 0) return { window: exact, confirmed: true, source: 'table' };

  if (id) {
    for (const fam of MODEL_FAMILIES) {
      if (fam.kind !== kind) continue;
      if (fam.prefixes.some((p) => id.startsWith(p))) {
        // 「同族」不等于「已确认」：前缀匹配会把**没见过的版本号**一起吞进来。
        // 实证（2026-10-18，主理人自建供应商）：`deepseek-v4-flash` / `deepseek-v4-pro` 命中
        // deepseek 族规则被标成 131072 且 confirmed:true，而实际窗口 ≥512k——UI 于是理直气壮地
        // 显示「128k」，并据此劝退本该跑得动的长任务。族规则只是**推断**，必须标 family + 未确认，
        // 由 UI 显示成估算值（带 ~）并引导用户去声明真实窗口。
        return { window: fam.window, confirmed: false, source: 'family' };
      }
    }
  }
  return { window: DEFAULT_CONTEXT_WINDOW, confirmed: false, source: 'default' };
}

module.exports = {
  MODEL_WINDOWS,
  MODEL_FAMILIES,
  PROVIDER_KINDS,
  DEFAULT_CONTEXT_WINDOW,
  OLLAMA_UNKNOWN_NUM_CTX,
  providerKindOf,
  normalizeModelId,
  resolveWindow,
};
