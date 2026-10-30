// P1-4 Orchestrator 纯逻辑层：DAG 解析 / 校验 / 并行分层（wait_all 语义，可单测）
// 输入：LLM 产出的任务拆解 JSON；输出：校验后的规范 DAG + 并行批次。
// 设计约束（计划文档 P1-2/P1-4）：
//   · 子任务元数据契约：taskId/title/prompt/dependsOn/critical/maxRetry/timeoutMs
//   · 并行分组 = 拓扑分层，层间 wait_all（wait_any 延后）
//   · 关键任务失败暂停组重新规划；非关键失败降级（critical 默认 false，LLM 显式标注才升级）

const MAX_TASKS = 8;
const MIN_TASKS = 2;
// 不再设人工 fan-in 上限（原 MAX_DEPS=4，2026-10-21 移除）：
// 「汇总任务依赖前面全部章节」是合法且常见的 DAG，旧上限会把整份拆解直接判失败
// （真机：t6 依赖 5 个章节任务 → 「任务 t6 依赖数超过 4」→ PLAN_FAILED，一个任务都没派）。
// fan-in 的自然上界由 MAX_TASKS 给出（≤7），再把 4 当契约只会误杀合法计划；
// 真正需要守的只有：依赖存在性、自依赖、环。

// P3 收口：单任务墙钟与组等待的数值必须在同一处（此前分居本文件与 invoke.js，互不知情）
const {
  ORCHESTRATE_TASK_MIN_MS, ORCHESTRATE_TASK_DEFAULT_MS, ORCHESTRATE_TASK_MAX_MS,
} = require('../tools/timeouts');
const logger = require('../logger');

function slugId(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

// 校验并规范化 LLM 的 DAG JSON。返回 { ok, tasks?, error? }
// tasks: [{ id, title, prompt, dependsOn: [], critical, maxRetry, timeoutMs }]
function validateDag(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    // 容忍 LLM 输出裹在 ```json 围栏或前后杂文本中：提取首个 {...} 块
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fence ? fence[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    try { obj = JSON.parse(candidate); } catch (e) { logger.warn('[dag] DAG JSON 解析失败：', e.message); return { ok: false, error: `DAG JSON 解析失败：${e.message}` }; }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.tasks)) {
    return { ok: false, error: 'DAG 结构无效：缺少 tasks 数组' };
  }
  const list = obj.tasks;
  if (list.length < MIN_TASKS || list.length > MAX_TASKS) {
    return { ok: false, error: `任务数必须在 ${MIN_TASKS}~${MAX_TASKS} 之间（当前 ${list.length}）` };
  }
  const seen = new Set();
  const tasks = [];
  for (const t of list) {
    const id = slugId(t.id);
    const title = String(t.title || '').trim();
    const prompt = String(t.prompt || '').trim();
    if (!id || !title || !prompt) return { ok: false, error: `任务字段缺失（id/title/prompt 均必填）：${JSON.stringify(t).slice(0, 120)}` };
    if (seen.has(id)) return { ok: false, error: `任务 id 重复：${id}` };
    seen.add(id);
    if (prompt.length > 8000) return { ok: false, error: `任务 ${id} 的 prompt 超长（>8000 字符）` };
    tasks.push({
      id,
      title: title.slice(0, 100),
      prompt,
      dependsOn: Array.isArray(t.dependsOn) ? [...new Set(t.dependsOn.map(slugId).filter(Boolean))] : [],
      critical: t.critical === true,
      maxRetry: Math.min(Math.max(Number(t.maxRetry) || 0, 0), 3),
      timeoutMs: Math.min(
        Math.max(Number(t.timeoutMs) || ORCHESTRATE_TASK_DEFAULT_MS, ORCHESTRATE_TASK_MIN_MS),
        ORCHESTRATE_TASK_MAX_MS,
      ),
    });
  }
  // 依赖引用存在性 + 自依赖（fan-in 不设上限：合法 DAG 允许汇总任务依赖全部前置）
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) return { ok: false, error: `任务 ${t.id} 依赖自身` };
      if (!seen.has(d)) return { ok: false, error: `任务 ${t.id} 依赖了不存在的任务：${d}` };
    }
  }
  // 环检测（Kahn）：迭代后仍有入度>0 的节点 → 存在环
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  const outEdges = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of t.dependsOn) { indeg.set(t.id, indeg.get(t.id) + 1); outEdges.get(d).push(t.id); }
  let queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  let visited = 0;
  while (queue.length) {
    const next = [];
    for (const id of queue) {
      visited += 1;
      for (const nxt of outEdges.get(id)) {
        indeg.set(nxt, indeg.get(nxt) - 1);
        if (indeg.get(nxt) === 0) next.push(nxt);
      }
    }
    queue = next;
  }
  if (visited !== tasks.length) {
    const cyclic = tasks.filter((t) => indeg.get(t.id) > 0).map((t) => t.id).join(', ');
    return { ok: false, error: `DAG 存在循环依赖：${cyclic}` };
  }
  return { ok: true, tasks };
}

// 拓扑分层：每层内部可并行（wait_all），层间串行。入参必须是已通过 validateDag 的 tasks。
function topoLevels(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const levelOf = new Map();
  const memo = (id) => {
    if (levelOf.has(id)) return levelOf.get(id);
    const t = byId.get(id);
    // 已由环检测保证无环；防御性：访问中标记避免意外深递归
    levelOf.set(id, 0);
    const lv = t.dependsOn.length === 0 ? 0 : Math.max(...t.dependsOn.map((d) => memo(d) + 1));
    levelOf.set(id, lv);
    return lv;
  };
  for (const t of tasks) memo(t.id);
  const levels = [];
  for (const t of tasks) {
    const lv = levelOf.get(t.id);
    (levels[lv] = levels[lv] || []).push(t.id);
  }
  return levels.map((l) => l.sort());
}

module.exports = { validateDag, topoLevels, MAX_TASKS, MIN_TASKS };
