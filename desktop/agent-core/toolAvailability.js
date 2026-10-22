// P1-8（2026-10-22）：工具可用性闸——「通告过的工具必须真的调得动」。
//
// 事故形状：引擎默认把 BASE_TOOLS 全量通告给模型，但宿主的 handler 表是按通道给子集的
// （交互式 / Worker / 定时 / 团队各不相同）。于是 Worker 通道会看到 28 个调不了的工具
// （browser_*/chrome_*/doc_*/code_exec/scheduled_create/orchestrate_task/…），模型兴冲冲
// 调一个、报「未知工具」、白烧几轮 quota，最后交半成品。而渲染层、主进程都装得很对，
// 门禁（tool-registration-matrix）只查「某个 handler 在源码里出现过」，查不出
// 「这个通道没有它」——所以绿灯亮着，缺陷还在。
//
// 本模块的职责单一：给定「本轮要通告的工具集」与「本通道的通道表」，剔除调不动的。
// 三条纪律：
//   ① 只减不增，绝不抛异常（与 schema 超限下架、原生优先下架同一纪律）；
//   ② 判定要考虑两条通道来源：toolHandlers（主进程/测试）与 window.mjcode（渲染层回退）；
//   ③ 裁完为空 ⇒ 判定本身可疑（多为 toolHandlers 未注入），回落原集合并大声告警——
//      「装配 bug」不该表现为「产品没有任何工具可用」。

/**
 * 引擎内部实现的工具：不经过宿主 handler，因此**不得**因 handler 缺失被裁掉。
 * 依据是 agent-core 工具循环里的 `case` 分支（todo_write / read_file / spawn_subagent /
 * load_skill / deep_research）。改动这张表必须同步 test/tool-availability.test.mjs——
 * 那里会从源码里现算 case 分支集合并与本表对账，漂移即红。
 */
export const ENGINE_INTERNAL_TOOL_NAMES = Object.freeze([
  'todo_write',   // 纯状态工具，不出网、不触盘
  'read_file',    // 引擎内置实现（含 run 内读取缓存与分段），不依赖宿主 readFile
  'spawn_subagent', // 递归调 runAgent 子循环
  'load_skill',   // 正文可来自 skills[].content，handler 只是可选加速
  'deep_research', // 内部自检 searchFn/writeFn，缺了会诚实降级而不是崩
  'activate_tools', // P1-8：按能力分组加载工具（只在工具面收敛时通告）
]);

const INTERNAL = new Set(ENGINE_INTERNAL_TOOL_NAMES);

/** 通道是否存在：宿主 handler 或渲染层回退桥，任一存在即可 */
function hasChannel(handlerName, { toolHandlers, mjcode }) {
  if (!handlerName) return false;
  if (toolHandlers && typeof toolHandlers[handlerName] === 'function') return true;
  return !!(mjcode && typeof mjcode[handlerName] === 'function');
}

/**
 * 剔除「通告了但调不动」的工具。
 * @param {Array} allTools 本轮候选工具（schema 数组）
 * @param {object} deps
 * @param {object|null} deps.toolHandlers 宿主工具表（camelCase 键）
 * @param {object} deps.toolHandlerNames 工具名 → 通道名映射（agent-core 的 TOOL_HANDLER_NAMES）
 * @param {(name:string)=>({server:string,tool:string}|null)} deps.decodeToolName MCP 工具名解析
 * @param {object} [deps.mjcode] 渲染层回退桥（主进程通道下为 undefined）
 * @param {(msg:string)=>void} [deps.warn] 告警出口（默认 console.warn）
 * @returns {{ kept: Array, removed: Array<{name:string, reason:string}> }}
 */
export function filterUnavailableTools(allTools, deps) {
  const list = Array.isArray(allTools) ? allTools : [];
  const warn = typeof deps?.warn === 'function' ? deps.warn : (m) => console.warn(m);
  const names = deps?.toolHandlerNames || {};
  const removed = [];
  const kept = [];
  for (const t of list) {
    const name = t?.function?.name;
    if (!name) { removed.push({ name: '(无名)', reason: 'schema 缺 name' }); continue; }
    if (INTERNAL.has(name)) { kept.push(t); continue; }
    // MCP 工具统一经 mcpCallTool 分发——没有该通道时它们同样调不动
    if (typeof deps?.decodeToolName === 'function' && deps.decodeToolName(name)) {
      if (hasChannel('mcpCallTool', deps)) { kept.push(t); continue; }
      removed.push({ name, reason: '缺少 mcpCallTool 通道' });
      continue;
    }
    const handlerName = names[name];
    if (!handlerName) { removed.push({ name, reason: '未登记工具→通道映射' }); continue; }
    if (hasChannel(handlerName, deps)) { kept.push(t); continue; }
    removed.push({ name, reason: `缺少通道 ${handlerName}` });
  }
  // ③ 空集保护：全裁光说明判定本身有问题（多为 toolHandlers 未注入），回落原集合并告警。
  //    这不是放宽权限——权限收窄另有 ①capability ②角色子集 ③planMode 三道闸，本闸只管「调不调得动」。
  if (list.length > 0 && kept.length === 0) {
    warn(`[agent] 工具可用性闸把所有 ${list.length} 个工具都判为不可用，判定可疑（疑似 toolHandlers 未注入），已回落原集合。请检查宿主装配`);
    return { kept: list.slice(), removed: [] };
  }
  if (removed.length) {
    const sample = removed.slice(0, 6).map((r) => `${r.name}(${r.reason})`).join(', ');
    warn(`[agent] 下架 ${removed.length} 个「通告了但调不动」的工具：${sample}${removed.length > 6 ? ' …' : ''}`);
  }
  return { kept, removed };
}
