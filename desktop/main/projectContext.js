// DS Bots / T6-11（§6.4 / §10.1）：项目上下文装配
//
// 为什么需要它：跨天迭代与冷启动时，若把历史消息全量重放，上下文会被聊天记录挤爆；
// 设计稿要求**只加载四项**——固定目标 objective + 上次迭代摘要 summary + 未完成待办 todo
// + 工件索引 index。工件正文永远不进装配（只能用工具按需读），这是 §10.1 的硬规则。
//
// 本模块只做「读 + 截断 + 拼装」：
//   · 读：project_spaces.objective / project_runs.summary_json / task_groups.tasks / artifact_index；
//   · 截断：预算写死在本文件（单一事实来源），保证「裁掉目标」这类事故不会发生；
//   · 拼装：四项各成一个段落，空项不占位。
// 失败一律 fail-open（返回空串），装配失败不能拖垮任务执行。
//
// 摘要落库（§10.2）：引擎压缩只发 memory_saved 事件，宿主负责把摘要写进
// project_runs.summary_json —— 这里提供唯一的写入函数，与读取端同源。

const OBJECTIVE_MAX_CHARS = 800;
const SUMMARY_MAX_CHARS = 1500;
const TODO_MAX_ITEMS = 40;
const TODO_ITEM_MAX_CHARS = 120;
// 工件索引预算写作 ≤ 1.2k tokens；按中文「1 字≈1 token」保守折算成 1200 字符。
const INDEX_MAX_CHARS = 1200;

const TERMINAL = new Set(['done', 'failed', 'skipped']);

function clip(text, max) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 读最近一次 run 的摘要（summary_json 结构见 §5.2；空对象视为没有摘要）。 */
function readLatestSummary(db, projectId) {
  if (!db || !projectId) return null;
  try {
    const rows = db.prepare(`SELECT summary_json FROM project_runs
      WHERE project_id = ? ORDER BY COALESCE(summary_at, updated_at) DESC, created_at DESC LIMIT 5`).all(projectId);
    for (const r of rows) {
      let parsed = null;
      try { parsed = JSON.parse(r.summary_json || '{}'); } catch { /* C-001：单条摘要坏了只跳过这一条（continue），不毁掉整块上下文 */ parsed = null; }
      if (!parsed || typeof parsed !== 'object') continue;
      const value = parsed.last_summary || parsed.summary || '';
      const done = Array.isArray(parsed.done) ? parsed.done : [];
      const todo = Array.isArray(parsed.todo) ? parsed.todo : [];
      const disputes = Array.isArray(parsed.disputes) ? parsed.disputes : [];
      if (String(value).trim() || done.length || todo.length || disputes.length) {
        return { lastSummary: String(value || ''), done, todo, disputes, version: parsed.version || '' };
      }
    }
  } catch { /* 表缺失/驱动异常：当作没有摘要 */ }
  return null;
}

/** 把 summary_json 渲染成紧凑文本（四个子项各一行前缀，避免模型把这些当新指令）。 */
function summaryText(summary) {
  if (!summary) return '';
  const lines = [];
  if (summary.lastSummary) lines.push(clip(summary.lastSummary, SUMMARY_MAX_CHARS));
  if (summary.done.length) lines.push(`已完成：${summary.done.map((x) => clip(x, 80)).join('；')}`);
  if (summary.todo.length) lines.push(`计划待办：${summary.todo.map((x) => clip(x, 80)).join('；')}`);
  if (summary.disputes.length) lines.push(`未决争议：${summary.disputes.map((x) => clip(x, 80)).join('；')}`);
  return clip(lines.join('\n'), SUMMARY_MAX_CHARS);
}

/** 未终态任务 → 待办清单（≤40 条、每条 ≤120 字符）。 */
function todoText(tasks, currentTaskId = '') {
  const pending = (tasks || [])
    .filter((t) => t && t.taskId !== currentTaskId && !TERMINAL.has(String(t.status || '')))
    .slice(0, TODO_MAX_ITEMS)
    .map((t) => `- [${t.status || 'pending'}] ${clip(t.title || t.taskId, TODO_ITEM_MAX_CHARS)}`);
  return pending.join('\n');
}

/** 工件索引 → 章节树 + 各章节字数 + 最近变更（不含正文）。 */
function indexText(index) {
  if (!index || !Array.isArray(index.outline)) return '';
  const head = `工件：${clip(index.title, 40)}（${index.currentVersion || 'V0.0'}）`;
  const sections = index.outline
    .map((s) => `- ${s.key}｜${clip(s.title, 40)}｜${s.version}｜${s.chars} 字`)
    .join('\n');
  const recent = (index.recentChanges || []).slice(0, 5)
    .map((r) => `- ${r.version} ${clip(r.sectionKey, 40)}${r.changeSummary ? `：${clip(r.changeSummary, 80)}` : ''}`)
    .join('\n');
  return clip([head, sections, recent ? `最近变更：\n${recent}` : ''].filter(Boolean).join('\n'), INDEX_MAX_CHARS);
}

/** 四项 → 一段可注入的文本；四项全空时返回空串（普通对话零侵入）。 */
function buildProjectContextBlock({ objective, summary, todo, index } = {}) {
  const blocks = [];
  const obj = clip(objective, OBJECTIVE_MAX_CHARS);
  if (obj) blocks.push(`【项目固定目标与约束】（每次迭代必读，不得偏离）\n${obj}`);
  const sum = summaryText(summary);
  if (sum) blocks.push(`【上次迭代摘要】（跨天续跑依据；原始消息不重放）\n${sum}`);
  if (todo) blocks.push(`【待办】（未终态任务，按此继续推进）\n${todo}`);
  const idx = indexText(index);
  if (idx) blocks.push(`【工件索引】（只有索引，不含正文；读取内容请调用 artifact_get_section）\n${idx}`);
  return blocks.join('\n\n');
}

/**
 * 采集并装配（宿主入口）：项目按 threadId 反查，全部读取都 fail-open。
 * 无项目绑定（普通编排组/普通对话）时返回空串 —— 零回归。
 */
function collectProjectContext({ project, db, artifactStore, group, currentTaskId = '' } = {}) {
  if (!project) return '';
  try {
    let index = null;
    const artifactId = project.artifactId || '';
    if (artifactStore && artifactId) {
      try { index = artifactStore.getIndex({ artifactId, recentLimit: 5 }); } catch { /* C-001：产物索引取不到 ⇒ 本轮上下文不含产物清单（每轮都会调，不逐次告警） */ index = null; }
    }
    const summary = readLatestSummary(db, project.projectId);
    return buildProjectContextBlock({
      objective: project.objective,
      summary,
      todo: todoText((group && group.tasks) || [], currentTaskId),
      index,
    });
  } catch (e) {
    console.warn('[project-context] 装配失败（fail-open）:', e && e.message);
    return '';
  }
}

/**
 * 摘要落库（§10.2）：run 行不存在则插入，存在则覆盖 summary_json / summary_at。
 * run_id 复用 task_groups.group_id（团队 run）或主对话 runId。
 */
function saveRunSummary(db, { runId, projectId, threadId = null, summary } = {}) {
  const text = String(summary || '').trim();
  if (!db || !runId || !projectId || !text) return false;
  try {
    const now = Date.now();
    const payload = JSON.stringify({ last_summary: text, version: '' });
    db.prepare(`INSERT INTO project_runs (run_id, project_id, thread_id, quota_state, summary_json, summary_at, created_at, updated_at)
      VALUES (?, ?, ?, 'ok', ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET summary_json = excluded.summary_json,
        summary_at = excluded.summary_at, updated_at = excluded.updated_at`).run(
      runId, projectId, threadId, payload, now, now, now,
    );
    return true;
  } catch (e) {
    console.warn('[project-context] 摘要落库失败（不阻塞）:', e && e.message);
    return false;
  }
}

module.exports = {
  OBJECTIVE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  TODO_MAX_ITEMS,
  TODO_ITEM_MAX_CHARS,
  INDEX_MAX_CHARS,
  readLatestSummary,
  summaryText,
  todoText,
  indexText,
  buildProjectContextBlock,
  collectProjectContext,
  saveRunSummary,
};
