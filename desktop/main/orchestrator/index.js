// P1-4：Orchestrator 最小版——用户目标 → LLM 拆解 → DAG 校验 → 持久化任务组
// 职责边界：只做「拆解与建组」；执行交给 WorkerPool；聚合交给 Aggregator。
// LLM 调用复用定时任务通道的非流式 chatOnce（凭证解析同源，无流式需求）。
const crypto = require('crypto');
// P1-4：同时引入规模常量，让拆解提示与 DAG 校验共用同一口径（消除「提示说2~6、校验允8」的漂移）
const { validateDag, topoLevels, MAX_TASKS, MIN_TASKS } = require('./dag');
const { toChatRequest } = require('../modelShape');
// 2026-10-21 团队调试日志：拆解是团队链路的第一现场（模型原始输出 / DAG 校验 / 批次计划）。
const teamDebug = require('../teamDebugLog');

const ORCHESTRATOR_SYSTEM = [
  '你是 MJ Coder 的任务编排器。把用户目标拆解为可独立执行的子任务 DAG，输出严格 JSON（不要输出任何其他文本）：',
  '{"tasks":[{"id":"t1","title":"简短标题","prompt":"给 Worker 的完整执行指令（含验收标准）","dependsOn":["前置任务id"],"critical":false,"maxRetry":1}]}',
  '规则：',
  // P1-4：规模约束与 dag.js 的 validateDag 保持严格一致（MAX_TASKS=8）。
  // 事故背景：此处原写「2~6 个」而 dag.js 允许至多 8 个，LLM 产出 7-8 个任务时
  // 会被提示与校验「双重口径」夹住——模型可能自我矛盾，或反复重试浪费轮次。
  // 现在两处同源引用 dag.js 的常量，从结构上消除不一致。
  `1. 任务数 ${MIN_TASKS}~${MAX_TASKS} 个；每个任务应可由一个独立 Agent 用工具（读文件/写文件/执行命令）完成；`,
  // 2026-10-21 真机事故：一个「每人报数 10 次」的简单目标被拆成 5 个任务（协议定义/QA/终检），
  // 单任务烧穿组预算、后 3 个任务被跳过，用户最终看到的答案是错的。规模必须随复杂度收敛。
  '2. 任务数由复杂度决定，且每个任务必须能在 8 轮工具调用内完成：简单查询/计数/单文件改动给 2~3 个任务；'
    + '任务明显超出该规模时（多文件编码、需要边写边验证），按阶段拆成串行子任务（如「核心实现 → 补边界与参数 → 运行验证」），'
    + '用 dependsOn 串联；禁止为「看起来完整」拆出协议定义、QA 复核、终检等仪式性步骤；',
  '3. 没有数据/产物依赖的任务必须写 dependsOn:[] 并放进同一批次并行执行——仅在真正需要前置任务产出时才声明依赖；禁止把可并行的任务串成链；',
  '4. critical:true 仅用于「失败后后续任务都无意义」的核心步骤（如初始化、编译基线），其余一律 false；',
  // 2026-10-21 用户实测：t1 只写一份规格却用了 7 轮 / 5.3 万 tokens。prompt 越长、验收要求越模糊，
  // Worker 越容易反复回读与自我校验。固定四段结构 + 明确产出上限，是把轮次压回来的最直接手段。
  '5. prompt 只写四段：目标（一句话）、要求（必要约束）、输出格式（文件路径 + 长度上限，如「docs/spec.md，不超过 30 行」）、验收标准（可执行的一条命令或一次检查）；'
    + '删除背景介绍、修饰语、重复描述；禁止在 prompt 内重复项目目录、预算、成员清单等组级公共上下文；',
  // 中间校验轮次是隐藏的 token 大头：逐个 ls / 反复回读文件，收益极低。
  '6. 禁止在 prompt 里要求「每写完一步就 ls 确认 / 回读全文」；验收只做最后一次性检查；',
  // 跨任务传递产物：全文塞进 prompt 会让下游任务每轮重发一份。
  '7. 跨任务产物用工作区文件路径传递（上游写入文件，下游 prompt 只写「读取 <路径>」），不得把上游全文抄进 prompt；',
  '8. 输出只能是 JSON，以 { 开头以 } 结尾。',
].join('\n');

const NO_TOOL_CAPABILITY_ERROR = '当前模型被标记为不支持 tool calling，任务编排/子代理依赖工具调用，无法执行；'
  + '请在设置页开启该模型的能力开关或换用支持工具的模型。';

// B1-B-02（F-003）：编排前的工具能力前置判定（fail-fast）。
// 为什么必须在**拆解之前**拦：编排器的产出是「让 Worker 去用工具干活」的 DAG，
// 模型不支持 tool calling 时整条链路注定跑空——拆解本身能成功（纯文本 JSON），
// 然后每个 Worker 在无工具状态下空转烧预算，用户最后看到一堆「已完成」的空壳任务。
// 与其他能力读取处同口径：只有**显式 boolean false** 才判为不支持，未声明一律视为支持
// （否则历史配置会集体失去编排能力，那是另一种越权收窄）。
function modelSupportsToolCall(m) {
  const cands = [
    m?.model?.caps?.supportsToolCall,
    m?.caps?.supportsToolCall,
    m?.model?.supportsToolCall,
    m?.supportsToolCall,
  ];
  for (const v of cands) if (typeof v === 'boolean') return v;
  return true;
}

let deps = null;

function initOrchestrator(d) {
  deps = d; // { loadAgentCore, store, chatOnce, resolveModel, emit, runGroup? }
}

// 组装拆解请求的用户消息：目标 + 项目目录 + 上下文块（修复提示 / 重规划上下文）
function buildUserMessage(goal, cwd, extra) {
  const lines = [`【用户目标】\n${goal}`, `【项目目录】\n${cwd || '（未指定）'}`];
  if (extra) lines.push(extra);
  return lines.join('\n\n');
}

async function askDag(userMessage) {
  const model = deps.resolveModel(); // 未选模型时抛出明确错误
  // 扁平形由共享转换产出：resolveModel 若改返回嵌套形，此处不再静默拿到 undefined
  const req = toChatRequest(model);
  const res = await deps.chatOnce({
    ...req,
    messages: [
      { role: 'system', content: ORCHESTRATOR_SYSTEM },
      { role: 'user', content: userMessage },
    ],
  });
  return { content: res?.content || '' };
}

/**
 * 归一化调用方给定的任务清单（对话型目标旁路）。
 * 只做形状收敛与去重：非法条目丢弃、id 冲突重编号、超过 MAX_TASKS 截断。
 * 不做业务判断——任务语义由调用方负责（团队派活方用确定性 builder 产出）。
 */
function normalizePresetTasks(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const out = [];
  const seen = new Set();
  for (const item of list.slice(0, MAX_TASKS)) {
    if (!item || typeof item !== 'object') continue;
    const prompt = String(item.prompt == null ? '' : item.prompt).trim();
    if (!prompt) continue;
    let id = String(item.id == null ? '' : item.id).trim() || `t${out.length + 1}`;
    if (seen.has(id)) id = `t${out.length + 1}`;
    seen.add(id);
    out.push({
      id,
      title: String(item.title || `子任务 ${out.length + 1}`),
      prompt,
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
      critical: item.critical === true,
      maxRetry: Number.isFinite(Number(item.maxRetry)) ? Number(item.maxRetry) : 1,
    });
  }
  return out;
}

// 拆解并建组。返回 { ok, groupId?, tasks?, levels?, waves?, error? }
// opts：{ auto, replanDepth, replanOf, repairHint, contextBlock, approvalMode, sandboxPolicy, threadId, planWaves, presetTasks }
//   · repairHint：上一次输出非法 JSON 时回喂的错误（自动修复重试路径）
//   · contextBlock：重规划时注入的「上次执行情况」（已完成结论 / 失败原因）
//   · approvalMode/sandboxPolicy：V04 宿主治理快照（建组时刻的父上下文），随组持久化
//   · threadId：R6 组绑定会话——创建组的会话 id，随组持久化（渲染层据此归属显示）
//   · planWaves（M5 / T5-12）：批次计划钩子 `({ tasks }) => { waves }`，由团队派活方注入。
//     编排器**不认识「团队」概念**（零侵入约束）：它只负责把自己的拆解结果交给回调，
//     把回调产出的 waves 原样落进 dag_json。普通编排（autoOrchestrate 等）不传，行为完全不变。
//   · presetTasks（2026-10-21 对话型目标旁路）：调用方已经确定任务清单时（如团队「报数」），
//     跳过 LLM 拆解与工具能力门，直接按给定任务建组——「把简单目标做成一个程序」的根因
//     不在提示词，而在模型拆解这一步本身，必须由确定性输入绕开。
async function planGoal({ goal, cwd, projectPath, auto, replanDepth, replanOf, repairHint, contextBlock, approvalMode, sandboxPolicy, threadId, planWaves, presetTasks } = {}) {
  const g = String(goal || '').trim();
  if (!g) return { ok: false, error: '目标为空' };
  if (!deps) return { ok: false, error: 'Orchestrator 未初始化' };
  const preset = normalizePresetTasks(presetTasks);
  if (Array.isArray(presetTasks) && presetTasks.length && !preset.length) {
    return { ok: false, error: '预设任务清单为空或缺少 prompt' };
  }
  // B1-B-02（F-003）：能力门在**建组之前**（比拆解更早）：拆解成功但 Worker 无工具，
  // 用户会拿到一组注定空转的任务，比直接报错更糟（错误被伪装成进度）。
  // resolveModel 未配置时自己会抛明确错误，这里只判能力位，不改变它的报错语义。
  // 预设任务旁路不需要工具（对话型目标），跳过能力门——否则「不支持 tool calling」的
  // 模型连一句报数都发不出去，属于把门装错了地方。
  if (!preset.length) {
    try {
      if (!modelSupportsToolCall(deps.resolveModel())) {
        return { ok: false, error: NO_TOOL_CAPABILITY_ERROR, code: 'NO_TOOL_CAPABILITY' };
      }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  let dagTasks = preset;
  if (!dagTasks.length) {
    const extra = repairHint
      ? `【修复要求】上一次输出未通过校验，原因：${repairHint}\n请重新输出严格 JSON，以 { 开头以 } 结束。`
      : contextBlock || '';

    let content = '';
    try {
      ({ content } = await askDag(buildUserMessage(g, cwd, extra)));
    } catch (err) {
      teamDebug.log('orchestrator', 'dag_call_failed', { goal: g, error: err });
      return { ok: false, error: String(err?.message || err) };
    }
    // 模型原始输出是「拆解为什么不对」的唯一证据，完整落 verbose 日志（模块内统一截断 8KB）。
    teamDebug.log('orchestrator', 'dag_raw', { goal: g, length: content.length, content }, { level: 'verbose' });

    const dag = validateDag(content);
    if (!dag.ok) {
      teamDebug.log('orchestrator', 'dag_invalid', { goal: g, error: dag.error, raw: content.slice(0, 2000) });
      return { ok: false, error: dag.error, raw: content.slice(0, 2000) };
    }
    dagTasks = dag.tasks;
  } else {
    teamDebug.log('orchestrator', 'dag_preset', { goal: g, tasks: preset.length });
  }

  const levels = topoLevels(dagTasks);
  // M5 / T5-12：批次计划（可选钩子）。失败/未注入一律降级为「无分批」——
  // 分批是调度优化，计划不出来也必须能按既有 DAG 跑完（fail-open）。
  let waves = null;
  let waveAssignments = null;
  // M5 / T5-9（§9.1）：run 级编制快照。派活钩子可顺带回传本次参与成员的名册快照，
  // 随 dag_json 一次性落库——运行期只读快照，团队配置变更只影响下一个 run。
  let rosterSnapshot = null;
  // 第八轮 B-02 / D-809：不透明运行元数据（同 roster 的透传模式，编排器不解释其内容）
  let runMetaSnapshot = null;
  if (typeof planWaves === 'function') {
    try {
      const plan = planWaves({ tasks: dagTasks, levels });
      if (plan && Array.isArray(plan.waves) && plan.waves.length) {
        waves = plan.waves;
        waveAssignments = plan.assignments || null;
      }
      if (plan && Array.isArray(plan.roster)) rosterSnapshot = plan.roster;
      // 第八轮 B-02 / D-809：不透明运行元数据原样透传进 dag_json（语义由调用方定义）。
      // 编排器**仍然不认识「团队」或「预算」概念**（零侵入约束不破）：它只负责把回调给的
      // 对象存下来，谁读谁解释。目前唯一消费者是 workerPool 的组级预算闸（main/groupBudget.js）。
      if (plan && plan.runMeta && typeof plan.runMeta === 'object') runMetaSnapshot = plan.runMeta;
    } catch (e) {
      console.warn('[orchestrator] 批次计划生成失败（按无分批调度）:', e?.message || e);
    }
  }
  const groupId = `tg-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const dagToStore = { levels, waves, assignments: waveAssignments };
  // 只在钩子确实给了快照时写入：普通编排组的 dag 形状保持原样（不为空字段造语义）。
  if (rosterSnapshot) dagToStore.roster = rosterSnapshot;
  // 同上：只在钩子确实给了元数据时写入，普通编排组的 dag 形状保持原样。
  if (runMetaSnapshot) dagToStore.runMeta = runMetaSnapshot;
  deps.store.createGroup({
    groupId, goal: g, cwd, projectPath, dag: dagToStore, tasks: dagTasks,
    auto, replanDepth, replanOf, approvalMode, sandboxPolicy, threadId,
  });
  teamDebug.log('orchestrator', 'group_created', {
    groupId,
    goal: g,
    cwd,
    projectPath,
    auto: !!auto,
    replanOf: replanOf || null,
    threadId: threadId || null,
    // team=true 表示这是团队派活（planWaves 钩子在场）；普通编排组为 false
    team: typeof planWaves === 'function',
    tasks: dagTasks.map((t) => ({
      id: t.id, title: t.title, dependsOn: t.dependsOn || [], critical: !!t.critical,
      prompt: t.prompt,
    })),
    levels,
    waves: Array.isArray(waves) ? waves : null,
    assignments: waveAssignments || null,
    roster: Array.isArray(rosterSnapshot)
      ? rosterSnapshot.map((m) => ({ id: m.id, name: m.name, roleKind: m.roleKind, enabled: m.enabled }))
      : null,
    runMeta: runMetaSnapshot || null,
    approvalMode: approvalMode || null,
    sandboxPolicy: sandboxPolicy || null,
  });
  deps.emit?.({ type: 'group_created', groupId, goal: g, tasks: dagTasks, levels, replanOf: replanOf || null });
  return { ok: true, groupId, tasks: dagTasks, levels, waves, waveAssignments };
}

// ── 自动编排（WorkBuddy 式主理人模式）──
// 一键流：目标 → 自动拆解（JSON 校验失败自动回喂修复，最多重试 1 次）→ 自动执行。
// threadId：R6 组绑定会话——透传给建组（对话内编排时为发起会话；IPC 路径由调用方传入）。
async function autoOrchestrate({ goal, cwd, projectPath, threadId } = {}) {
  if (!deps?.runGroup) return { ok: false, error: '自动编排依赖未就绪' };
  const first = await planGoal({ goal, cwd, projectPath, auto: true, replanDepth: 0, threadId });
  // 拆解输出非法 → 带原始错误自动修复重试一次。
  // 用两个不可变结果而不是 `let r` 反复赋值：避免「await 后按旧值回写 r」的竞态形态。
  const r = (!first.ok && first.raw)
    ? await planGoal({ goal, cwd, projectPath, auto: true, replanDepth: 0, repairHint: first.error, threadId })
    : first;
  if (!r.ok) return r;
  deps.emit?.({ type: 'auto_run', groupId: r.groupId, tasks: r.tasks.length });
  deps.runGroup(r.groupId).catch((e) => deps.emit?.({ type: 'group_update', groupId: r.groupId, status: 'failed', error: e.message }));
  return r;
}

// 重规划上下文：把上次执行结果（已完成结论摘要 / 失败原因 / 跳过）压缩为 LLM 可用的块
function buildReplanContext(srcGroup) {
  const done = (srcGroup.tasks || []).filter((t) => t.status === 'done')
    .map((t) => `- 已完成「${t.title}」：${String(t.result?.summary || '').slice(0, 200)}`);
  const failed = (srcGroup.tasks || []).filter((t) => t.status === 'failed')
    .map((t) => `- 失败「${t.title}」：${String(t.error || '原因未知').slice(0, 200)}`);
  const skipped = (srcGroup.tasks || []).filter((t) => t.status === 'skipped')
    .map((t) => `- 跳过「${t.title}」`);
  return [
    '【上次自动编排执行情况（重新拆解时的依据）】',
    '已完成任务的结论可直接作为输入引用，不要安排重复执行；',
    '失败任务需调整拆解方式或拆出更小的步骤以绕过失败原因：',
    ...done, ...failed, ...skipped,
    `【失败总结】${String(srcGroup.error || '关键任务失败').slice(0, 200)}`,
  ].join('\n');
}

// 自动重规划：auto 组终态失败/暂停 → 以失败上下文重新拆解为新组并续跑。
// 防失控：每条 replan 链最多自动重规划 1 次（depth≥1 不再重规划，交人工处置）。
const replanning = new Set(); // 并发去重（同一组只触发一次）

async function maybeAutoReplan(groupId) {
  if (!deps?.runGroup) return null;
  const src = deps.store.getGroup(groupId);
  if (!src || !src.auto || (src.replan_depth || 0) >= 1) return null;
  if (src.status !== 'failed' && src.status !== 'paused') return null;
  if (replanning.has(groupId)) return null;
  replanning.add(groupId);

  try {
    const r = await planGoal({
      goal: src.goal, cwd: src.cwd, projectPath: src.project_path,
      auto: true, replanDepth: (src.replan_depth || 0) + 1, replanOf: groupId,
      contextBlock: buildReplanContext(src),
      // V04：重规划组继承源组的治理快照（权限单调不增——只允许沿用，不允许借重规划放宽）
      approvalMode: src.approval_mode || undefined,
      sandboxPolicy: src.sandbox_policy || undefined,
      // R6：重规划组继承源组会话绑定（归属跟随原会话）
      threadId: src.thread_id || undefined,
    });
    if (!r.ok) {
      deps.emit?.({ type: 'replan_failed', groupId, error: r.error });
      console.error(`[orchestrator] 组 ${groupId} 自动重规划失败:`, r.error);
      return null;
    }
    console.log(`[orchestrator] 组 ${groupId} 失败，已自动重规划为新组 ${r.groupId}（${r.tasks.length} 个子任务）`);
    deps.runGroup(r.groupId).catch((e) => console.error(`[orchestrator] 重规划组 ${r.groupId} 启动失败:`, e.message));
    return r;
  } catch (e) {
    console.error('[orchestrator] 自动重规划异常:', e.message);
    return null;
  } finally {
    replanning.delete(groupId);
  }
}

// 事件入口：main 层把任务事件同步喂给编排器（触发自动重规划）
function onTaskEvent(evt) {
  if (!evt) return;
  if (evt.type === 'group_finalized' && (evt.status === 'failed' || evt.status === 'paused')) {
    maybeAutoReplan(evt.groupId);
  } else if (evt.type === 'group_update' && evt.status === 'paused') {
    maybeAutoReplan(evt.groupId);
  }
}

module.exports = {
  initOrchestrator, planGoal, autoOrchestrate, maybeAutoReplan, onTaskEvent, buildReplanContext, ORCHESTRATOR_SYSTEM,
  // B1-B-02：能力前置判定与其错误文案对外导出（测试直接断言 fail-fast 语义）
  modelSupportsToolCall, NO_TOOL_CAPABILITY_ERROR,
};
