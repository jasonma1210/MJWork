// 定时任务复用军团 + 绑定会话（设计文档 §7.6 / §14 P1-6）。
//
// 现状缺口（设计文档 §7.6 的现算表）：
//   · `scheduler.js` 全文件 grep team/teamId/roster **零命中** ⇒ 定时任务里的
//     `orchestrate_task` 建的是**匿名 Worker 组**（无 roster、无成员人格、无 team 记忆）；
//   · `runScheduledAgentTask` 的 runAgent 参数里**没有 memories** ⇒ 定时任务不继承四层记忆。
// ⇒ 「界面能选、实际跑的还是匿名组」= 假闭环。本模块把这两条补上。
//
// 为什么单独成模块：`scheduler.js` 已 787 行、`main.js` 2230 行（都在 800 行软档/只减不增清单里），
// 新逻辑必须外置；且「定时任务怎么用军团」是**独立职责**（组装执行上下文），
// 与「什么时候该跑」（调度语义）、「怎么写盘」（数据韧性）三者正交。
//
// 无人值守安全（纪律③）：定时任务**不得在无人值守时静默升级**为团队执行 ——
// 团队化必须由用户在创建任务时**预先声明** team_id（与预算），本模块只认已声明的 team_id。
'use strict';

const { snapshotRoster } = require('./teamRoster');
const { buildDispatchPlan } = require('./teamDispatchPlan');
const { normalizeBudget } = require('./teamStore');

// ── 军团解析（fail-closed）──

/**
 * 解析定时任务要用的军团。
 * ⚠️ 团队不存在 / 已归档 ⇒ 直接失败（fail-closed）：宁可任务失败，也不能悄悄跑成匿名组
 * （用户以为在用军团，实际跑的是另一套东西——这正是「假闭环」的形态）。
 *
 * @param {object} deps
 * @param {string} teamId 任务预先声明的军团 id
 * @param {Function} getTeamStore
 * @returns {{ok:boolean, team?:object, roster?:Array, mode?:string, budget?:object, memberIds?:string[], error?:string}}
 */
function resolveScheduledTeam({ teamId, getTeamStore } = {}) {
  const id = String(teamId || '').trim();
  if (!id) return { ok: false, error: '未声明军团 id' };
  let store = null;
  try { store = typeof getTeamStore === 'function' ? getTeamStore() : null; }
  catch (e) { return { ok: false, error: `团队子系统不可用：${e.message}` }; }
  if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
  let team = null;
  try { team = store.getTeam(id); }
  catch (e) { return { ok: false, error: `读取团队失败：${e.message}` }; }
  if (!team) return { ok: false, error: `团队不存在：${id}` };
  if (team.archivedAt) return { ok: false, error: '团队已归档，不能派活' };
  const members = Array.isArray(team.members) ? team.members : [];
  if (!members.length) return { ok: false, error: '团队没有成员，无法派活' };
  const mode = team.defaultMode === 'select' ? 'select' : 'lead';
  const budget = normalizeBudget(team.budget || {});
  return {
    ok: true,
    team,
    mode,
    budget,
    memberIds: members.map((m) => m.id),
    roster: snapshotRoster(members),
  };
}

/**
 * 给定时任务的执行提示词补一段「本次由哪支军团执行」的说明。
 * 放在**用户消息**里而不是 system 段：system 段是前缀稳定区，加内容会让每轮重写前缀。
 */
function buildTeamBrief(resolved) {
  if (!resolved || !resolved.ok) return '';
  const { team, mode, budget, roster } = resolved;
  const lines = [
    '【本次执行编制】',
    `团队：${team.name}（${team.description || ''}）`,
    `协作模式：${mode === 'select' ? 'select（成员按能力认领）' : 'lead（主管统一拆解派发）'}`,
    `成员 ${(roster || []).length} 名：${(roster || []).map((m) => `${m.name}${m.roleKind === 'lead' ? '（统筹）' : ''}`).join('、')}`,
    budget ? `预算上限：max_rounds=${budget.max_rounds}、max_tokens=${budget.max_tokens}` : '',
    '要求：调用 orchestrate_task 派活时按上述成员能力分工，跨成员的数据依赖必须显式写 dependsOn，禁止把可并行的任务串成链。',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 团队派活（定时通道用）：**带 roster 快照 + 团队协作模式 + 团队预算**的编排路径，
 * 而不是 `orchestrate_task` 的匿名路径。
 *
 * 与 ipc/teams.js 的 teams:dispatch 同型（复用 planGoal / buildDispatchPlan / snapshotRoster），
 * 但抽成独立函数以便定时通道复用；**不新建第二条编排实现**（同一套拆解器、同一套校验）。
 *
 * @returns {Promise<{ok:boolean, groupId?:string, taskCount?:number, summary?:string, error?:string}>}
 */
async function dispatchToTeam(deps = {}) {
  const {
    goal, resolved, cwd, projectPath, threadId,
    orchestrator, workerPool, taskStore, waitGroupSettled, humanizeGroupResult,
    signal, emitSubagent, contextBlock, hostPolicy = {},
  } = deps;
  if (!resolved || !resolved.ok) return { ok: false, error: (resolved && resolved.error) || '团队未就绪' };
  if (!orchestrator || !workerPool) return { ok: false, error: '编排通道不可用' };
  const goalText = String(goal || '').trim();
  if (!goalText) return { ok: false, error: '目标为空' };

  const roster = resolved.roster || [];
  const budget = resolved.budget || {};
  const mode = resolved.mode || 'lead';
  // 批次计划钩子：与 teams:dispatch 同款（buildDispatchPlan 决定「先起哪一小批」与指派）。
  const planWaves = ({ tasks }) => buildDispatchPlan({ tasks, roster, budget, mode, chatOnly: false });

  const plan = await orchestrator.planGoal({
    goal: goalText, cwd, projectPath, threadId: threadId || null,
    contextBlock: contextBlock || buildTeamBrief(resolved),
    planWaves,
    ...hostPolicy,
  });
  if (!plan.ok) return { ok: false, error: `主管拆解失败：${plan.error}` };

  const report = (evt) => {
    try { emitSubagent?.({ tool: 'orchestrate_task', groupId: plan.groupId, ...evt }); }
    catch (e) { console.warn('[scheduledTeam] 子任务事件上报失败:', e.message); }
  };
  for (const t of plan.tasks || []) {
    report({ phase: 'spawn', taskId: t.id, title: t.title, dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [] });
  }
  // 执行：与 teams:dispatch 同型（后台起组），随后等待整组收尾（定时任务必须有终态产出）。
  Promise.resolve(workerPool.runGroup(plan.groupId)).catch((e) => {
    console.warn('[scheduledTeam] 团队派活启动失败:', e.message);
  });
  if (typeof waitGroupSettled !== 'function' || !taskStore) {
    return { ok: true, groupId: plan.groupId, taskCount: (plan.tasks || []).length, summary: '' };
  }
  const waited = await waitGroupSettled(taskStore, plan.groupId, { signal });
  if (waited.aborted || waited.timedOut || waited.missing) {
    try { workerPool.abortGroup(plan.groupId); } catch { /* 整组可能已收尾 */ }
    return {
      ok: false, groupId: plan.groupId,
      error: waited.aborted ? '团队派活被中止' : `团队派活等待超时或状态异常（groupId=${plan.groupId}）`,
    };
  }
  const summary = typeof humanizeGroupResult === 'function' ? humanizeGroupResult(waited.group) : '';
  return { ok: true, groupId: plan.groupId, taskCount: (plan.tasks || []).length, summary };
}

/**
 * 会话上下文（Codex Thread automation 形态）：把原会话的历史与记忆装进来，
 * 让定时任务「接着上次聊」而不是从零开始。
 *
 * @param {object} deps { threadId, localStore, memoryManager, projectPath, query, topK, teamId }
 * @returns {{ok:boolean, messages:Array, memories:Array, error?:string}}
 */
function buildThreadContext(deps = {}) {
  const { threadId, localStore, memoryManager, projectPath, query, topK, teamId } = deps;
  const id = String(threadId || '').trim();
  if (!id) return { ok: false, messages: [], memories: [], error: '未声明会话 id' };
  const messages = [];
  try {
    if (localStore && typeof localStore.listMessages === 'function') {
      const list = localStore.listMessages(id) || [];
      for (const m of list) {
        const role = m && m.role === 'assistant' ? 'assistant' : 'user';
        const content = String((m && (m.content ?? m.text)) || '').trim();
        if (!content) continue;
        messages.push({ role, content: content.slice(0, 4000) });
      }
    }
  } catch (e) {
    return { ok: false, messages: [], memories: [], error: `读取会话历史失败：${e.message}` };
  }
  const memories = [];
  try {
    if (memoryManager && typeof memoryManager.recallContents === 'function') {
      const hits = memoryManager.recallContents({
        spaceId: projectPath || 'default',
        query: String(query || ''),
        topK: Number(topK) || 7,
        scopes: ['session', 'team', 'project', 'global'],
        conversationId: id,
        teamId: teamId || null,
      }) || [];
      for (const h of hits) {
        const text = String((h && h.content) || '').replace(/\s+/g, ' ').trim();
        if (text) memories.push(text.slice(0, 300));
      }
    }
  } catch { /* 记忆不可用不阻断任务（记忆是增益，不是必需） */ }
  return { ok: true, messages, memories };
}

/**
 * 装配定时任务的消息序列：原会话历史（可选）+ 本轮任务提示 + 军团说明（可选）。
 * 军团说明放在**用户消息**里而不是 system 段：system 段是前缀稳定区，加内容会让每轮重写前缀。
 *
 * @param {object} args { prompt, teamBrief, threadMessages }
 * @returns {Array<{role:string, content:string}>}
 */
function buildScheduledMessages({ prompt, teamBrief, threadMessages } = {}) {
  const msgs = [];
  for (const m of Array.isArray(threadMessages) ? threadMessages : []) {
    if (m && m.content) msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) });
  }
  let content = String(prompt || '');
  if (teamBrief) content = `${content}\n\n${teamBrief}`;
  msgs.push({ role: 'user', content });
  return msgs;
}

/**
 * 产出回写原会话（Codex Thread automation 形态）：定时任务的结论写回它绑定的那个会话。
 * @returns {{ok:boolean, error?:string}}
 */
function writeBackToThread({ threadId, localStore, text, role = 'assistant', name } = {}) {
  const id = String(threadId || '').trim();
  if (!id) return { ok: false, error: '未声明会话 id' };
  const content = String(text || '').trim();
  if (!content) return { ok: false, error: '无产出可回写' };
  try {
    if (!localStore || typeof localStore.addMessage !== 'function') {
      return { ok: false, error: '本地存储不可用' };
    }
    localStore.addMessage({ threadId: id, role, content, ...(name ? { name } : {}) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `回写会话失败：${e.message}` };
  }
}

/**
 * 定时任务执行上下文的**总装配入口**（P1-6）：军团解析 + 会话上下文 + 消息序列 + 记忆 +
 * 军团工具 + 派活分支 + 产出回写，全部在这里完成，`main.js` 只留一次调用。
 *
 * 为什么要把这些装配收进本模块：`main.js` 已在 800 行软档 + 1500 行 code 硬档边缘，
 * 而这段逻辑是「定时任务怎么用军团」的完整语义，与主进程其它职责无关。
 *
 * @returns {{error?:string, messages?:Array, memories?:Array, teamTools?:object|null, teamHandler?:Function|null, onFinished?:Function}}
 */
function prepareScheduledRun(deps = {}) {
  const {
    prompt, teamId, threadId, taskId, taskName, outputDir, signal,
    getTeamStore, localStore, memoryManager,
    orchestrator, workerPool, taskStore, waitGroupSettled, humanizeGroupResult,
    createTeamToolHandlers, postTeamMessage,
  } = deps;
  let resolved = null;
  if (teamId) {
    resolved = resolveScheduledTeam({ teamId, getTeamStore });
    // fail-closed：军团不可用就让任务失败（不悄悄跑成匿名组——那正是「界面能选、实际跑别的」的假闭环）
    if (!resolved.ok) throw new Error(`定时任务的军团不可用：${resolved.error}`);
  }
  const teamBrief = resolved ? buildTeamBrief(resolved) : '';
  const threadCtx = threadId
    ? buildThreadContext({
      threadId, localStore, memoryManager, projectPath: outputDir,
      query: String(prompt || ''), topK: 7, teamId: teamId || null,
    })
    : null;
  const messages = buildScheduledMessages({
    prompt, teamBrief, threadMessages: threadCtx ? threadCtx.messages : [],
  });
  const memories = (threadCtx && threadCtx.memories) || [];
  // FIX-P04：团队上下文是**引擎侧通告 team_* 的唯一开关**（agent-core/index.js 只在
  // runAgent({ teamContext }) 非空时追加 TEAM_TOOLS 与协同提示词段）。此前这里只把 context
  // 交给工具工厂、没回传给 runAgent ⇒ 即使 handler 齐备，模型也看不到这些 schema。
  // runId/taskId 沿用同一命名空间（scheduled:<taskId>），与消息总线的幂等键一致。
  const teamContext = resolved
    ? { teamId, runId: `scheduled:${taskId}`, taskId: `scheduled:${taskId}`, memberId: '' }
    : null;
  const teamTools = resolved && typeof createTeamToolHandlers === 'function'
    ? createTeamToolHandlers({
      teamContext,
      getTeamStore,
      getTaskStore: () => taskStore,
      postMessage: postTeamMessage,
      waitTask: workerPool.waitTask,
    })
    : null;
  const teamHandler = resolved
    ? (a) => dispatchToTeam({
      goal: a && a.goal, resolved, cwd: outputDir, projectPath: outputDir,
      threadId: threadId || null, orchestrator, workerPool, taskStore,
      waitGroupSettled, humanizeGroupResult, signal, contextBlock: teamBrief,
    })
    : null;
  const onFinished = (finalText) => {
    if (!threadId) return;
    const wb = writeBackToThread({ threadId, localStore, text: finalText || '', name: taskName });
    if (!wb.ok) console.warn('[scheduled] 产出回写会话失败:', wb.error);
  };
  return {
    // runAgent 的三个参数打包返回：宿主侧一行 `...schedCtx.runParams` 即可（main.js 已到 1500 行 code 硬档）
    // teamContext 非空 ⇒ 引擎追加 team_* 工具与协同提示词段；为空 ⇒ 工具面与字节完全不变（非团队任务零影响）
    runParams: { messages, memories, teamContext },
    teamTools, teamHandler, onFinished,
  };
}

module.exports = {
  resolveScheduledTeam, buildTeamBrief, dispatchToTeam, buildThreadContext,
  buildScheduledMessages, writeBackToThread, prepareScheduledRun,
};
