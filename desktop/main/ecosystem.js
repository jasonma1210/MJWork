// 生态资产目录加载器（M7）：把 50 数字员工 / 100 MCP 连接器 / 100 Skill 接入产品
// 纯数据层：读取 ecosystem/*.json 并做归一化与关联，不依赖 electron，便于单测
//
// T4-3 角色模板机制（数字员工 → Agent 运行时的接线，单一事实来源在此）：
//   角色模板 = 系统提示 + 工具子集 + 审批档（+ 沙箱策略）
//   - 系统提示：员工 system_prompt，经 IPC ecosystem:employeeRuntime 组装进 rolePreset，
//     引擎把它拼在 BASE_PROMPT 之后（叠加身份，不替换工具约定）；
//   - 工具子集：员工 tools 抽象名（read/write/edit/bash/grep/glob/web/browser）由
//     本文件 buildEmployeeRuntimePreset 的 ROLE_TOOL_ALIASES 映射为引擎具体工具名，未知名丢弃；
//     引擎按 toolNames 对 BASE_TOOLS 取交集，交集为空回落全量；
//   - 审批档/沙箱：ROLE_APPROVAL_MAP 归一到引擎枚举后，由 main/agentRunner.js 与
//     用户设置取「更严格者」——角色只能收紧权限，绝不能放宽（fail-closed）。
//   产品入口：生态中心员工卡片「用此角色开会话」→ sessionExtras.expert.runtime
//   → useAgentRun 每轮携带 rolePreset → agent:run。
const fs = require('fs');
const path = require('path');
// T5-7：角色预设的模型绑定引用串编解码（单一事实来源 = main/modelShape.js）
const { canonicalizeModelRef } = require('./modelShape');

// 产品审批矩阵实际支持的模式（与 main/approval.js 对齐）；非法值一律降级为最保守的 on-request
const VALID_APPROVAL = ['on-request', 'auto-safe', 'always', 'safe-auto', 'trusted'];
// 沙箱策略（与 main/sandbox.js 对齐）
const VALID_SANDBOX = ['read-only', 'workspace-write', 'full-access'];
// 模型档位
const VALID_TIER = ['fast', 'standard', 'reasoning'];

function normalizeApproval(v) {
  return VALID_APPROVAL.includes(v) ? v : 'on-request';
}
function normalizeSandbox(v) {
  return VALID_SANDBOX.includes(v) ? v : 'workspace-write';
}
function normalizeTier(v) {
  return VALID_TIER.includes(v) ? v : 'standard';
}

// ── 数字员工（Digital Employees）──
function loadDigitalEmployees(ecosystemDir) {
  const file = path.join(ecosystemDir, 'digital-employees.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.employees || data.items || []);
    return list.map((e) => ({
      ...e,
      id: e.id || slug(e.name || e.title_cn || ''),
      // 归一化：非法策略值降级为最保守默认（fail-closed），避免生态数据绕过审批矩阵
      approval_policy: normalizeApproval(e.approval_policy),
      sandbox_policy: normalizeSandbox(e.sandbox_policy),
      default_model_tier: normalizeTier(e.default_model_tier),
      industry: Array.isArray(e.industry) ? e.industry : [e.industry || '通用'],
      tools: Array.isArray(e.tools) ? e.tools : [],
      core_skills: Array.isArray(e.core_skills) ? e.core_skills : [],
      starter_skills: Array.isArray(e.starter_skills) ? e.starter_skills : [],
    }));
  } catch (err) {
    console.error('[ecosystem] 数字员工加载失败:', err.message);
    return [];
  }
}

// ── MCP 连接器 ──
//
// 两个来源，合并加载（2026-10-17）：
//   · mcp-connectors.json           精选目录（≤90 条，有「防膨胀」门禁，中文描述/分类精修）
//   · mcp-connectors-workbuddy.json 从本机 WorkBuddy 连接器目录导入（id 前缀 wb-，可随时用
//                                   scripts/import-workbuddy-connectors.mjs 重建）
// 去重规则：**精选优先**。按安装地址（remote url / 包名）判断同一服务，其次按 name。
// 为什么分文件而不是全塞进主目录：主目录有「条目数 ≤ 90」的收敛不变式（connector-catalog 守护），
// 那是防止目录再次膨胀成「一堆点不动的条目」的设计，不该为了导入而破坏。
function readConnectorFile(file, source) {
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.connectors || data.items || []);
    return Array.isArray(list) ? list.map((c) => ({ ...c, source })) : [];
  } catch (err) {
    console.error(`[ecosystem] MCP 连接器加载失败（${path.basename(file)}）:`, err.message);
    return [];
  }
}

function loadMcpConnectors(ecosystemDir) {
  const merged = [
    ...readConnectorFile(path.join(ecosystemDir, 'mcp-connectors.json'), 'curated'),
    ...readConnectorFile(path.join(ecosystemDir, 'mcp-connectors-workbuddy.json'), 'workbuddy'),
  ];
  const seenUrl = new Set();
  const seenName = new Set();
  const out = [];
  for (const c of merged) {
    const url = c?.install?.url ? String(c.install.url).replace(/\/+$/, '').toLowerCase() : '';
    const nm = String(c.name || '').toLowerCase();
    if (url && seenUrl.has(url)) continue;
    if (!url && nm && seenName.has(nm)) continue;
    if (url) seenUrl.add(url);
    if (nm) seenName.add(nm);
    out.push({
      ...c,
      id: c.id || slug(c.name || ''),
      official: !!c.official,
      // 权限归一化：只保留白名单级别，缺失默认 filesystem(workspace) 的最小集由安装器处理
      permissions: (Array.isArray(c.permissions) ? c.permissions : []).filter(
        (p) => p && ['filesystem', 'network', 'shell'].includes(p.level)
      ),
      env_vars: Array.isArray(c.env_vars) ? c.env_vars : [],
      capabilities: Array.isArray(c.capabilities) ? c.capabilities : [],
      maturity: c.maturity || 'community',
    });
  }
  return out;
}

// ── Skill 索引（落盘的 SKILL.md 由 skills.js 负责加载；这里读 JSON 元数据做产品内展示/关联）──
function loadSkillCatalog(ecosystemDir) {
  const file = path.join(ecosystemDir, 'skills.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.skills || data.items || []);
    return list.map((s) => ({
      id: s.id || slug(s.name || ''),
      name: s.name,
      display_name: s.display_name || s.name,
      category: s.category || '通用',
      tags: Array.isArray(s.tags) ? s.tags : [],
      description: s.description || '',
      tools_required: Array.isArray(s.tools_required) ? s.tools_required : [],
      permissions: Array.isArray(s.permissions) ? s.permissions : [],
      approval_policy: normalizeApproval(s.approval_policy),
    }));
  } catch (err) {
    console.error('[ecosystem] Skill 目录加载失败:', err.message);
    return [];
  }
}

// ── T4-3：角色模板运行时预设（纯函数：抽象工具名→具体工具名映射的单一事实来源）──
// 生态数据里的 tools 是抽象名，这里映射为引擎注册的具体工具名；未知抽象名直接丢弃
//（角色只裁剪工具、绝不发明工具，fail-closed）。browser 只映射只读三件套——
// click/fill/select 有真实页面副作用，角色模板不默认授予。
const ROLE_TOOL_ALIASES = {
  read: ['read_file', 'list_dir'],
  write: ['write_file'],
  edit: ['edit_file'],
  bash: ['shell'],
  grep: ['grep'],
  glob: ['glob'],
  web: ['web_search', 'web_fetch'],
  browser: ['browser_navigate', 'browser_screenshot', 'browser_extract'],
};
// 生态审批策略 → 引擎四档枚举（main/approval.js）；trusted=完全信任→never（不弹卡）
const ROLE_APPROVAL_MAP = {
  'on-request': 'on-request',
  'auto-safe': 'auto-safe',
  'safe-auto': 'auto-safe',
  always: 'always',
  trusted: 'never',
};

// 由归一化后的员工对象组装 rolePreset（进 agent:run 载荷；审批/沙箱的最终钳制在 agentRunner）
// skillNames：员工 core_skills + starter_skills 合并透传——agentRunner 按名从 ~/.mjcode/skills 读 SKILL.md
// 内容注入引擎（技能内容的安全处置在引擎侧统一走不可信内容管道，此处只传名不传内容）
function buildEmployeeRuntimePreset(emp) {
  const toolNames = [...new Set((emp.tools || []).flatMap((t) => ROLE_TOOL_ALIASES[t] || []))];
  return {
    systemPrompt: String(emp.system_prompt || ''),
    toolNames,
    // T5-7：per-agent 模型绑定——来源对象若带模型引用（`providerId::modelId`）就透传，
    // 未声明/非法一律 null（agentRunner 见 null/解析不出即用默认模型，绝不因此让整轮失败）。
    // canonical 化只有 modelShape.canonicalizeModelRef 一个判据，此处不重复解释格式。
    model: canonicalizeModelRef(emp.model),
    // B1-B-02（F-019）：allowMcp 的缺省值在引擎侧已翻转为**最小权限**（只有显式 true 才保留
    // 全部 mcpTools，缺省/false 一律让 MCP 也走角色白名单）。这是刻意的方向修正，但若不同批
    // 处理存量角色，已发布的 51 个数字员工会「突然失去全部 MCP 工具」——行为变弱且无预告。
    // 因此接缝放在这里：**引擎侧收紧 + 角色构造层显式放开**。存量角色继续拥有 MCP；
    // 而任何不经本函数构造的角色 preset（外部导入 / 新模板忘了写）默认拿到最小权限。
    // 写法用 `!== false` 而不是写死 true：已核查 ecosystem/digital-employees.json 的 51 条
    // 目前**没有任何一条显式声明 allowMcp**（顶层键里根本没有这个字段），所以两种写法在今天
    // 行为完全一致；但写死 true 会把未来员工包显式声明的 `allowMcp: false` 反向覆盖掉——
    // 那正是本条要消灭的「配置被静默放宽」，因此保留显式 false 的否决权。
    allowMcp: emp.allowMcp !== false,
    approvalMode: ROLE_APPROVAL_MAP[emp.approval_policy] || 'on-request',
    sandboxPolicy: emp.sandbox_policy || 'workspace-write',
    // P1-2（2026-10-29）：core_skills（常驻技能）此前只展示不进 skillNames ⇒ 运行时不加载（死字段）。
    // 现与 starter_skills 合并去重后交 agentRunner 按名装载。
    skillNames: [...new Set([...(emp.core_skills || []), ...(emp.starter_skills || [])].map((s) => (s == null ? '' : String(s))).filter(Boolean))],
  };
}

// slug 规范化（kebab-case）
function slug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// 汇总目录
function loadEcosystem(ecosystemDir) {
  const employees = loadDigitalEmployees(ecosystemDir);
  const connectors = loadMcpConnectors(ecosystemDir);
  const skills = loadSkillCatalog(ecosystemDir);
  return {
    employees,
    connectors,
    skills,
    stats: {
      employees: employees.length,
      connectors: connectors.length,
      skills: skills.length,
      employeeCategories: [...new Set(employees.map((e) => e.category).filter(Boolean))],
      connectorCategories: [...new Set(connectors.map((c) => c.category).filter(Boolean))],
      skillCategories: [...new Set(skills.map((s) => s.category).filter(Boolean))],
    },
  };
}

// 按职业大类分组数字员工
function groupEmployeesByCategory(employees) {
  const out = {};
  for (const e of employees) {
    const k = e.category || '通用';
    (out[k] = out[k] || []).push(e);
  }
  return out;
}

// 按分类分组 MCP 连接器
function groupConnectorsByCategory(connectors) {
  const out = {};
  for (const c of connectors) {
    const k = c.category || '其他';
    (out[k] = out[k] || []).push(c);
  }
  return out;
}

module.exports = {
  loadEcosystem,
  loadDigitalEmployees,
  loadMcpConnectors,
  loadSkillCatalog,
  groupEmployeesByCategory,
  groupConnectorsByCategory,
  buildEmployeeRuntimePreset,
  ROLE_TOOL_ALIASES,
  ROLE_APPROVAL_MAP,
  slug,
};