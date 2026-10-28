'use strict';
// v1（2026-10-19）：意图驱动的 MCP 动态加载（原生优先）
//
// 背景与目标：
//   用户诉求「按对话意图动态拉起对应的 MCP 连接器」——但项目已有大量**原生内置工具**覆盖了
//   文档生成（doc_create/xlsx_create/pptx_create/pdf_generate）、联网（webSearch/webFetch）、
//   浏览器（browser_*/chrome_*）、代码执行（sandboxCodeRun）等能力。
//   因此本机制的三条硬规则：
//     ① **原生优先**：若本次意图命中的能力本地原生工具已覆盖 → 不拉任何 MCP，
//        同一次 run 内「原生实现」与「MCP 实现」**永不同框**，从根上避免两套实现的冲突。
//     ② **MCP 默认全关、按需拉起**：仅当意图命中**未原生覆盖**的能力，才按名连接用户已保存的
//        对应连接器（连接器由用户自己经界面「+」添加，本模块**不**创建任何 MCP 服务）。
//     ③ **离线规则词典判定**：不调用模型，纯本地关键词/格式匹配，零网络、零额外成本、可单测。
//
// 为什么预连接是「用户已授意」而非越过架构红线：
//   架构红线禁止的是「**应用启动即自动拉起**高危/第三方服务」；本模块只在**对话意图**下连接
//   用户**自己已保存**的连接器，且连接的正是用户在按钮/界面里显式添加过的服务——与
//   callMcpTool 的 connect-on-demand 语义一致，只是把「调用时补连」提前到「本轮工具通告前补连」，
//   让模型在本轮一开始就能看见这些工具，而不是「看得见调用时才连上」。
//
// 本模块为**纯函数**（不依赖 electron / 不落盘 / 不发网络），便于单测与在 agentRunner 内组装。

// ── 能力词典：用户诉求关键词 → 能力键 ──
//   native: true  → 本地原生工具已覆盖（nativeTools 记录覆盖它的原生工具，仅作说明/门禁用）；
//   services      → 该能力对应的已保存连接器**服务名别名**（策展，命中精确）；
//   keywords      → 更宽的匹配词，同时用于「服务名」与「工具清单（名/描述）」的兜底匹配，
//                   以覆盖用户把连接器重命名成自定义名字的场景。
const CAPABILITY_RULES = [
  // ── 原生已覆盖（命中即跳过 MCP 动态加载）──
  // 文档四件套：由 G-doc 原生工具离线生成，绝不因「要出 docx/pptx/pdf」而去拉 mcp-docx/mcp-pptx/html-pdf。
  { key: 'docx', native: true, nativeTools: ['doc_create'], keywords: ['word', 'docx', '.doc', '说明书', '合同', '简历', '方案书'] },
  { key: 'xlsx', native: true, nativeTools: ['xlsx_create'], keywords: ['excel', 'xlsx', '.xls', '电子表格', '台账'] },
  { key: 'pptx', native: true, nativeTools: ['pptx_create'], keywords: ['ppt', 'pptx', 'powerpoint', '幻灯片', '演示文稿', '汇报材料'] },
  { key: 'pdf', native: true, nativeTools: ['pdf_generate'], keywords: ['pdf', '导出pdf', '打印成'] },
  { key: 'web', native: true, nativeTools: ['webSearch', 'webFetch'], keywords: ['联网', '上网查', '搜索一下', '抓取网页'] },
  { key: 'browser', native: true, nativeTools: ['browserNavigate', 'chromeNavigate'], keywords: ['浏览器', '打开网页', '网页自动化'] },
  { key: 'code', native: true, nativeTools: ['sandboxCodeRun', 'codeExec'], keywords: ['运行代码', '执行代码', '跑个脚本', '沙盒执行'] },

  // ── 未原生覆盖：命中后按需拉起匹配的已保存 MCP 连接器 ──
  { key: 'imagegen', keywords: ['生成图片', '画一张', '画图', '插画', '配图', '生图', '绘图'], services: ['replicate', 'cloudinary', 'huggingface'] },
  { key: 'tts', keywords: ['配音', '语音合成', '朗读', '转语音', 'tts'], services: ['elevenlabs'] },
  { key: 'notion', keywords: ['notion', '知识库', '笔记库'], services: ['notion', 'notion-local'] },
  { key: 'github', keywords: ['github', 'pull request', '代码托管', 'issue 跟踪'], services: ['github', 'gitlab'] },
  { key: 'database', keywords: ['postgres', 'postgresql', 'mysql', 'mongodb', 'redis', '数据仓库'], services: ['supabase', 'mongodb', 'redis', 'neon', 'clickhouse', 'elastic'] },
  { key: 'cloud', keywords: ['aws', 's3', 'kubernetes', 'k8s', '云资源', '部署到云'], services: ['aws', 'kubernetes', 'cloudflare', 'vercel', 'terraform'] },
  { key: 'im', keywords: ['slack', '飞书', '钉钉', 'teams', '发消息到群'], services: ['slack', 'slack-local', 'lark-mcp', 'dingtalk-mcp', 'discord', 'telegram'] },
  { key: 'design', keywords: ['figma', '设计稿', '原型图'], services: ['figma', 'figma-devmode'] },
  { key: 'memory', keywords: ['长期记忆', '记忆库', 'mem0'], services: ['mem0', 'qdrant', 'pinecone', 'graphiti'] },
  { key: 'payment', keywords: ['stripe', '收款', '支付集成', 'paypal'], services: ['stripe', 'paypal', 'square'] },
  { key: 'crm', keywords: ['crm', '客户关系', '工单', '客服系统'], services: ['hubspot', 'intercom', 'zendesk'] },

  // v1 扩展（2026-10-28）：CodeGraph 代码图谱——只读代码理解能力，命中即按需拉起用户已保存的
  // codegraph 连接器（经 mcp:connect 保存，意图预热按 services 别名匹配）。与 'code'（sandboxCodeRun/
  // codeExec：运行/执行代码）职责互补、不重叠：本条目指「读懂现有代码库」，'code' 指「跑新代码」。
  { key: 'code-graph', keywords: ['这段代码', '怎么实现的', '调用链', '谁依赖', '源码', '函数定义', '依赖关系', 'blast radius', '代码理解', '在哪里定义'], services: ['codegraph'] },
];

/** 归一化：小写、压缩空白（匹配用）。 */
function normalizeText(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 离线规则词典意图判定：从文本命中的能力规则（含 native 与 services）。
 * 不调模型、不出网，纯字符串匹配。
 * @param {string} text
 * @returns {Array<object>} 命中的能力规则对象数组（按词典顺序，已去重）
 */
function detectCapabilities(text) {
  const t = normalizeText(text);
  if (!t) return [];
  const out = [];
  for (const rule of CAPABILITY_RULES) {
    if (rule.keywords.some((k) => t.includes(String(k).toLowerCase()))) out.push(rule);
  }
  return out;
}

/**
 * 原生优先：从命中能力中筛出「本地原生工具未覆盖」的，只有这些才允许去拉 MCP。
 * @param {Array<object>} capabilities detectCapabilities 的返回
 * @returns {Array<object>}
 */
function nonNativeCapabilities(capabilities) {
  return (Array.isArray(capabilities) ? capabilities : []).filter((c) => c && !c.native);
}

/** 单个能力是否命中某已保存连接器（服务名别名精确命中，或关键词命中服务名/工具清单）。 */
function matchesCapability(cap, nameLower, tools) {
  if (!cap) return false;
  if (Array.isArray(cap.services)) {
    for (const alias of cap.services) {
      const a = String(alias).toLowerCase();
      if (!a) continue;
      if (nameLower === a || nameLower.includes(a)) return true;
    }
  }
  for (const kw of (cap.keywords || [])) {
    const k = String(kw).toLowerCase();
    if (k.length < 2) continue;
    if (nameLower.includes(k)) return true;
    for (const t of (tools || [])) {
      const sig = `${(t && t.name) || ''} ${(t && t.description) || ''}`.toLowerCase();
      if (sig.includes(k)) return true;
    }
  }
  return false;
}

/**
 * 从「用户已保存的 MCP 连接器」中，为待加载能力选出候选服务名。
 * 只读用户自己保存的配置 + 工具清单缓存（不新建服务）；命中即返回，失败与否则交给调用方 fail-open。
 * @param {{capabilities?: Array<object>, savedConfigs?: Array<object>, manifests?: Record<string, Array<object>>}} opts
 * @returns {string[]} 候选服务名（去重，保持 savedConfigs 顺序）
 */
function selectServersToPrewarm({ capabilities = [], savedConfigs = [], manifests = {} } = {}) {
  const caps = nonNativeCapabilities(capabilities);
  if (!caps.length) return [];
  const out = [];
  const seen = new Set();
  for (const cfg of (Array.isArray(savedConfigs) ? savedConfigs : [])) {
    const name = String((cfg && cfg.name) || '').trim();
    if (!name || seen.has(name)) continue;
    const nameLower = name.toLowerCase();
    const tools = Array.isArray(manifests[name]) ? manifests[name] : [];
    if (caps.some((cap) => matchesCapability(cap, nameLower, tools))) {
      out.push(name);
      seen.add(name);
    }
  }
  return out;
}

/**
 * 组合入口：文本 → 候选服务名（原生优先过滤已内置）。
 * @returns {{capabilities: string[], servers: string[]}}
 */
function planPrewarm(text, savedConfigs, manifests) {
  const caps = detectCapabilities(text);
  return {
    capabilities: caps.map((c) => c.key),
    servers: selectServersToPrewarm({ capabilities: caps, savedConfigs, manifests }),
  };
}

// ── 单一事实来源：MCP 工具定义的构造 / 排序 / 去重（第六轮 N5）──
// 此前本文件自带一份 `toToolDefs`/`mergeToolDefs`（注释自承「与渲染层 mcpTools.js 同形」），
// 与渲染层实现靠人工同步，存在「一侧改了规范化策略、另一侧静默产出不同形状」的隐患。
// 现统一收敛到 shared/mcpToolDefs.mjs：主进程（CJS）经动态 import 异步加载（本模块为纯函数、
// 无 electron 依赖，宿主无关），渲染层（ESM）静态引用同一文件。
// 返回 Promise<模块命名空间>；promise 首次调用后缓存，重复调用零成本。
let _mcpToolDefsMod = null;
function loadMcpToolDefs() {
  if (!_mcpToolDefsMod) _mcpToolDefsMod = import('../shared/mcpToolDefs.mjs');
  return _mcpToolDefsMod;
}

module.exports = {
  CAPABILITY_RULES,
  normalizeText,
  detectCapabilities,
  nonNativeCapabilities,
  matchesCapability,
  selectServersToPrewarm,
  planPrewarm,
  loadMcpToolDefs,
};
