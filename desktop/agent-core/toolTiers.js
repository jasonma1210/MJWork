// P1-8 / 工具分层（2026-10-22）：三档工具面 + 窗口自适应裁剪 + 能力目录文本。
//
// 为什么需要分层：59 个工具的 schema 实测约 10,809 token（estimateTokens 口径），
// 这是**每一轮**都要重复付的固定成本。对大窗口是浪费，对小窗口是灾难——
// 本地 8K 模型的窗口装不下工具表，`DEFAULT_CONTEXT_WINDOW_FALLBACK = 4096` 更是直接爆。
//
// 三档的划分依据不是「原生 vs 外部」，而是「感知成本 vs 执行成本」：
//   core     常开。高频、没有替代品（模型会用 shell 硬凑）、或语义必需（todo 是给用户看的进度，
//            按需它就懒得申请）。约 15 个。
//   catalog  目录在场、schema 按需。低频但**成果导向**：模型不知道它的存在，任务就降级
//            （最典型：不知道有 pptx_create，就输出一段 Markdown 让用户自己复制）。
//            目录里只有一行「能力名 — 一句话」，正文由 activate_tools 加载。
//   ondemand 完全按需，目录里只出现在分组说明里。低频 + 有替代路径 + 误用代价高
//            （computer_use 会碰鼠标键盘、chrome_* 需要前置连接）。
//
// 兼容性纪律（重要）：**默认零行为变化**。只有 contextWindow 显式小于阈值时才裁剪；
// 未提供窗口、或窗口够大时，一律返回原集合。这样存量测试与用户习惯都不受影响。

/** 窗口低于该值时**无条件**收敛（任何工具表在这个窗口里都是负担） */
export const MIN_FULL_TOOL_WINDOW = 16000;

/**
 * 工具表占窗口的比例上限：超过就收敛。
 *
 * 为什么用「占比」而不是绝对窗口值（2026-10-22 真机纠正）：
 * 同一份 10.4k token 的工具表，对 32K 窗口是 32% 的固定开销（每轮三分之一上下文都是工具定义），
 * 对 1M 窗口只是 1%。用绝对阈值必然两头都不对——旧值 32000 与默认档 32768 只差 768，
 * 等于「默认档刚好躲过裁剪」，是巧合不是设计。
 */
export const TOOL_TABLE_SHARE_LIMIT = 0.2;

export const TIER_CORE = 'core';
export const TIER_CATALOG = 'catalog';
export const TIER_ONDEMAND = 'ondemand';

/** core：常开。新增工具默认**不进** core（进 core 需要理由：高频/无替代/语义必需） */
const CORE_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir', 'grep', 'glob',
  'shell',
  'git_status', 'git_diff', 'git_log', 'git_commit', 'git_add',
  'todo_write', 'spawn_subagent', 'load_skill',
];

/**
 * 能力分组：目录文本与 activate_tools 的直接数据源。
 * `tier` 只用于说明（catalog 组会写进目录，ondemand 组只在分组说明里出现）。
 */
export const CAPABILITY_GROUPS = [
  { key: 'doc', label: '文档生成', hint: '生成 .docx / .xlsx / .pptx / .pdf，或编译 LaTeX', tools: ['doc_create', 'xlsx_create', 'pptx_create', 'pdf_generate', 'latex_compile'] },
  { key: 'net', label: '联网检索', hint: '搜索、抓取网页、深度调研、发 HTTP 请求', tools: ['web_search', 'web_fetch', 'deep_research', 'http_request'] },
  { key: 'browser', label: '内置浏览器', hint: '打开网页、点击、填表、截图、抽取正文（应用自带，无需外部环境）', tools: ['browser_navigate', 'browser_click', 'browser_fill', 'browser_select', 'browser_screenshot', 'browser_extract'] },
  { key: 'chrome', label: '本地 Chrome', hint: '操作你自己的 Chrome（需先开启扩展并连接）', tools: ['chrome_status', 'chrome_tabs', 'chrome_navigate', 'chrome_click', 'chrome_fill', 'chrome_screenshot', 'chrome_extract'], tier: TIER_ONDEMAND },
  { key: 'exec', label: '代码执行', hint: '在隔离沙箱里运行代码片段', tools: ['code_exec', 'sandbox_code_run'] },
  { key: 'collab', label: '团队与编排', hint: '把任务派给数字员工、读写团队看板与成员消息', tools: ['orchestrate_task', 'team_list_members', 'team_send_message', 'team_board', 'team_read_messages', 'team_wait'], tier: TIER_ONDEMAND },
  { key: 'pr', label: '代码评审', hint: '拉取 PR、查看改动、写评审意见', tools: ['pr_list', 'pr_view', 'pr_diff', 'pr_review', 'pr_comment'] },
  { key: 'artifact', label: '项目工件', hint: '读写项目空间里的长文档工件（按章节分页）', tools: ['artifact_index', 'artifact_get_section', 'artifact_get_diff', 'artifact_patch_section'] },
  { key: 'system', label: '系统操作', hint: '剪贴板、桌面通知、本地 SQLite 查询', tools: ['clipboard', 'notify', 'sqlite', 'git_branch'], tier: TIER_ONDEMAND },
  { key: 'desktop', label: '桌面自动化', hint: '模拟鼠标键盘操作桌面应用（需用户在设置里主动开启）', tools: ['computer_use'], tier: TIER_ONDEMAND },
  { key: 'plugin', label: '插件市场', hint: '搜索并安装网络插件（安装需要审批）', tools: ['search_plugins', 'install_plugin'], tier: TIER_ONDEMAND },
  { key: 'schedule', label: '定时任务', hint: '创建定时执行的提示词任务', tools: ['scheduled_create'], tier: TIER_ONDEMAND },
];

const CORE = new Set(CORE_TOOLS);
const GROUP_BY_KEY = new Map(CAPABILITY_GROUPS.map((g) => [g.key, g]));
/** 工具名 → 所属 group key（同一个工具只应出现在一个组里；重复登记由测试拦截） */
const GROUP_OF_TOOL = new Map();
for (const g of CAPABILITY_GROUPS) for (const t of g.tools) GROUP_OF_TOOL.set(t, g.key);

/**
 * 档位判定。**未知名字一律视为 core**（不裁）——MCP 工具名是动态拼接的
 * （`mcp__server__tool`），裁错等于让用户刚连上的服务凭空消失。
 */
export function tierOf(name) {
  if (CORE.has(name)) return TIER_CORE;
  const group = GROUP_OF_TOOL.get(name);
  if (!group) return TIER_CORE; // 未知（含 MCP）保守保留
  const g = GROUP_BY_KEY.get(group);
  if (g?.tier === TIER_ONDEMAND) return TIER_ONDEMAND;
  return TIER_CATALOG;
}

/**
 * 按窗口选择本轮通告的工具面。
 * 判据两条，任一成立即收敛：① 窗口小于 MIN_FULL_TOOL_WINDOW；② 工具表占窗口比例超过
 * TOOL_TABLE_SHARE_LIMIT。窗口未知（<=0）时不裁——没有分母就没有占比。
 * @param {Array} allTools 候选工具（schema 数组）
 * @param {number} contextWindow 本轮有效窗口（<=0 或未提供 = 未知）
 * @param {object} [opts]
 * @param {boolean} [opts.forceCoreOnly] 强制只给 core（宿主显式要求时）
 * @param {(tools:Array)=>number} [opts.estimate] token 估算器（引擎注入 estimateTokens，
 *        避免本模块反向依赖 agent-core 造成循环 import）
 * @returns {{ tools: Array, trimmed: boolean, omitted: number, window: number, share: number }}
 */
export function selectToolsForWindow(allTools, contextWindow, opts = {}) {
  const list = Array.isArray(allTools) ? allTools : [];
  const win = Number(contextWindow) > 0 ? Number(contextWindow) : 0;
  const tableTokens = typeof opts.estimate === 'function'
    ? Number(opts.estimate(list)) || 0
    : 0; // 没有估算器时不臆造数字（此时只剩绝对窗口这一条判据）
  const share = win > 0 && tableTokens > 0 ? tableTokens / win : 0;
  const needTrim = opts.forceCoreOnly === true
    || (win > 0 && (win < MIN_FULL_TOOL_WINDOW || (share > 0 && share > TOOL_TABLE_SHARE_LIMIT)));
  if (!needTrim) return { tools: list, trimmed: false, omitted: 0, window: win, share };
  const tools = list.filter((t) => tierOf(t?.function?.name) === TIER_CORE);
  // 空集保护：若裁剪把所有工具都干掉了（判定异常），保留原集合而不是让模型无工具可用
  if (tools.length === 0) return { tools: list, trimmed: false, omitted: 0, window: win, share };
  return { tools, trimmed: true, omitted: list.length - tools.length, window: win, share };
}

/** 取某个分组的工具名（activate_tools 用） */
export function toolsOfGroups(keys) {
  const wanted = new Set((Array.isArray(keys) ? keys : []).map(String));
  const out = [];
  for (const g of CAPABILITY_GROUPS) {
    if (!wanted.has(g.key)) continue;
    out.push(...g.tools);
  }
  return out;
}

/** 分组说明（未知分组名时返回 null，供 activate_tools 报错用） */
export function groupInfo(key) {
  return GROUP_BY_KEY.get(String(key)) || null;
}

export function allGroupKeys() {
  return CAPABILITY_GROUPS.map((g) => g.key);
}

/**
 * 能力目录文本（注入 system prompt 的「感知层」）。
 * 只写能力名 + 一句话，不写任何参数——目录本身也是 token，控制在十余行内。
 * 默认**列出全部组**（含纯按需组）：用户和模型都需要知道「有这些能力」，否则
 * 「不知道有 pptx_create 就输出一段 Markdown」这类能力降级必然发生。
 * @param {object} [opts]
 * @param {boolean} [opts.includeOndemand=true] 是否列出纯按需组
 */
export function buildToolCatalogText(opts = {}) {
  const includeOndemand = opts.includeOndemand !== false;
  const lines = [];
  for (const g of CAPABILITY_GROUPS) {
    if (!includeOndemand && g.tier === TIER_ONDEMAND) continue;
    const suffix = g.tier === TIER_ONDEMAND ? '（部分能力有前置条件）' : '';
    lines.push(`- ${g.key} — ${g.label}：${g.hint}${suffix}`);
  }
  return lines.join('\n');
}
