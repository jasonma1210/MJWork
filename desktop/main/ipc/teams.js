// M5 / T5-1 + T5-2：MJ 军团团队层 IPC 域（teams:*）——团队编制读写 + 消息总线 + 事件契约。
//
// 设计依据：
//   · v1.1 §5 表 1/表 2、§6 F1 组建流程（T5-1 编制）：
//     - 两入口同一张表（D3）：`teams:recruit`（生态中心招募，source='template'）
//       与 `teams:addCustomMember`（自定义描述，source='custom'）都落 team_members；
//     - AI 生成角色草稿（`teams:draftMember`）**不落库**——先出「能力摘要」给人审，
//       用户确认后再走 addCustomMember 落库（因为它携带工具权限，§6 调整点②）；
//     - 所有枚举归一在 teamStore.normalizeMemberInput 单点完成，本模块不重复判断。
//   · v1.1 §5 表 3、§2 G4、T5-2 验收（消息总线）：
//     - `teams:listMessages` 是渲染层读时间轴的唯一入口（按 seq 升序 = 顺序单一事实源）；
//     - 落库后经 `teams:event` 广播（事件契约），渲染层据此实时追加，无需轮询；
//     - 体积闸在 teamStore.appendMessage（单一落点），本模块只负责落审计 + 广播；
//     - **不提供「自由发言」写通道**：G1 规定发言只能由看板事件/主管指定触发，
//       故总线写入一律由主进程内部产生（生命周期系统广播 + 后续 T5-3/T5-4 的派活链路）。
//
// 依赖注入（与 ipc/tasks.js 同款 initXxx(deps)）：{ getTeamStore, getTaskStore, audit, chatOnce, resolveModel, emitTeamsEvent, getProviders, orchestrator, workerPool, clearCheckpoint, getMemoryManager }
//   · clearCheckpoint/getMemoryManager（T5-11）：重置成员会话用——清 `agent:{memberId}` 断点 +
//     该成员私有记忆降权；两者皆为既有单例的 getter/薄包装，不新起存储通道。
//   · getTeamStore：主进程 whenReady 后初始化（与 taskStore 同事务底座）；
//   · chatOnce/resolveModel：AI 草稿复用编排/定时任务同源的模型通道，不新起调用路径；
//   · emitTeamsEvent：把消息落库事件广播到所有窗口（主进程 main.js 提供，同 emitTaskEvent）；
//   · getProviders（T5-7）：本机供应商列表（localStore.listProviders），成员模型绑定的展示标签在此解析；
//   · orchestrator/workerPool（T5-4）：派活链路复用既有编排器（planGoal 拆解建组）与 Worker 池（runGroup 执行），
//     不新起第二条编排实现——「主管拆解(复用 planGoal)」是设计稿 §6 F2 的明确要求。
const { ipcMain } = require('electron');
const guard = require('./payloadGuard');
// 预算可视化：实时用量账本（内存态，仅当次进程有效）。历史 run 缺此账本时投影层自动
// 回落「已结算任务用量」，因此这里不做持久化、也不制造第二事实源。
const groupBudget = require('../groupBudget');
// 2026-10-21 团队调试日志：团队操作全链路的可导出事实流（详见 main/teamDebugLog.js 头部注释）。
const teamDebug = require('../teamDebugLog');
const { resolveEmployeeById } = require('./ecosystem');
const { buildEmployeeRuntimePreset, ROLE_TOOL_ALIASES } = require('../ecosystem');
const { normalizeMemberInput, normalizeBudget, SYSTEM_RUN_ID, dispatchGate, MAX_MEMBERS_PER_TEAM } = require('../teamStore');
// M5 / T5-12：批次编排（§13.4）——闸门取值仍取 teamWaves 这一份；计划装配本身
// 已抽到 main/teamDispatchPlan.js（第八轮 B-05/B-08），运行期由 workerPool 消费 dag_json.waves。
const { MAX_ACTIVE_MEMBERS, MAX_PER_TYPE_IN_RUN } = require('../teamWaves');
const { buildDispatchPlan, isChatOnlyGoal, resolveDispatchPresetTasks } = require('../teamDispatchPlan');
const { toChatRequest, resolveModelRef, decodeModelRef } = require('../modelShape');
// M5 / T5-6：会话团队事件流的纯装配内核（与渲染层投影共用同一份 shared 模块）。
//
// 为什么必须**动态 import** 而不是 `require('../../shared/teamStream.mjs')`：
//   shared/ 下是 ESM，主进程是 CJS。`require(esm)` 只在 Node ≥22.12 稳定，而 Electron 33
//   内嵌 Node 20.18 —— 直接 require 会在真机启动时抛 ERR_REQUIRE_ESM，把整个 teams:* IPC 域打挂
//  （静态检查与 Node 本地跑测试都发现不了，因为本机 Node 版本更高）。
//   与 mcpToolCache.js 加载 shared/contextBudget.mjs 采用同一约定：懒加载 + 成功即缓存。
let _teamStreamMod = null;
function loadTeamStream() {
  if (!_teamStreamMod) {
    _teamStreamMod = import('../../shared/teamStream.mjs').catch((e) => {
      _teamStreamMod = null; // 失败不缓存，下次再试
      throw e;
    });
  }
  return _teamStreamMod;
}

let deps = null;

// ── T5-4：派活失败的结构化错误码（单一事实来源）──
// code 供渲染层做分支（如 LEAD_MISSING 弹「一键创建统筹负责人」），文案只作兜底展示。
const DISPATCH_ERRORS = {
  TEAM_NOT_FOUND: '团队不存在',
  TEAM_ARCHIVED: '团队已归档，不能派活',
  LEAD_MISSING: '缺少编排/统筹负责人，需要帮你创建吗？',
  MISSING_GOAL: '本次任务目标必填',
  // 2026-10-20 需求⑤：派活面板简化为「选团队 + 直接发消息」后，协作模式与预算上限
  // 改为缺省回落（见 handler 内注释），这两条错误码不再由派活路径返回；
  // 保留在错误码表内是为既有单测（team-lead-dispatch）与其它调用方的兼容契约。
  MISSING_MODE: '协作模式必填（lead / select）',
  MISSING_BUDGET: '预算上限必填',
  PLAN_FAILED: '主管拆解失败',
  UNAVAILABLE: '团队子系统或编排通道不可用（初始化失败）',
};

// ── M5 / T5-6：对话内团队事件流的读取边界 ──
// 一个会话最多回看 50 次派活、800 条总线消息：足够覆盖真实使用，又不让一次 IPC 把长会话拖慢。
// 超出部分不报错（按最新优先截断），卡片仍可展开看到最近轨迹。
const THREAD_RUN_LIMIT = 50;
const THREAD_MESSAGE_LIMIT = 800;

// ── AI 角色草稿提示（失败时用户仍可手填，不阻塞）──
const DRAFT_SYSTEM = [
  '你是 MJ Coder 军团（多 Agent 团队）的角色设计师。根据用户对一名 AI 队友的一句话描述，'
    + '产出这名成员的运行配置，输出严格 JSON（不要输出任何其他文本）：',
  '{"name":"成员名（≤20字）","systemPrompt":"角色系统提示：身份、职责边界、工作方式、交付物要求",'
    + '"tools":["read","write","edit","bash","grep","glob","web","browser"],'
    + '"approvalPolicy":"on-request","sandboxPolicy":"workspace-write","skillNames":[]}',
  '规则：',
  '1. tools 只能选：read(读文件) / write(写文件) / edit(改文件) / bash(执行命令) / grep(搜索内容) / '
    + 'glob(搜索文件) / web(联网检索) / browser(浏览器只读)——按角色最小化授予，不要全选；',
  '2. approvalPolicy 取 on-request / auto-safe / always / trusted（越大越宽松），默认 on-request；'
    + 'sandboxPolicy 取 read-only / workspace-write / full-access，默认 workspace-write；',
  '3. systemPrompt 必须自包含：写清角色身份、职责与产出要求；禁止引用本次对话；',
  '4. 输出只能是 JSON，以 { 开头以 } 结尾。',
].join('\n');

// ── AI 数字员工草稿提示（2026-10-20 需求①：数字员工列表右上角「新建员工」→ 模型自动创建）──
// 与 DRAFT_SYSTEM（军团成员草稿）的区别：这里的产物要**落盘成生态中心的数字员工资产**
// （employees/<id>.json），因此多一个 ASCII id（它同时是文件名，必须是 slug）。
// 中文名称 slug 化会得到空串 → 必须让模型自己给一个语义化的 ASCII id，否则用户会卡在
// 「名字填了中文、id 却是空的」这一步（手动模式的既有行为，AI 模式不该复现该断点）。
const EMPLOYEE_DRAFT_SYSTEM = [
  '你是 MJ Coder 生态中心的数字员工设计师。根据用户对一名数字员工的一句话描述，'
    + '产出该员工的资产配置，输出严格 JSON（不要输出任何其他文本）：',
  '{"id":"ascii-slug（如 finance-analyst，仅小写字母/数字/连字符）",'
    + '"name":"中文展示名（≤20字）","system_prompt":"角色系统提示：身份、职责边界、工作方式、交付物要求",'
    + '"tools":["read","write","edit","bash","grep","glob","web","browser"]}',
  '规则：',
  '1. tools 只能选：read(读文件) / write(写文件) / edit(改文件) / bash(执行命令) / grep(搜索内容) / '
    + 'glob(搜索文件) / web(联网检索) / browser(浏览器只读)——按角色最小化授予，不要全选；',
  '2. system_prompt 必须自包含：写清角色身份、职责与产出要求；禁止引用本次对话；',
  '3. id 必须是 ASCII slug（仅 [a-z0-9-]、以字母数字开头），name 用中文；',
  '4. 输出只能是 JSON，以 { 开头以 } 结尾。',
].join('\n');

/** 从模型输出里取第一段 JSON（容忍 ```json 围栏与前后杂讯） */
function extractJson(content) {
  let s = String(content || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/** 能力摘要（给人审看的「能做什么」）：返回布尔位，文案由渲染层 i18n 承担。
 *  2026-10-24 抽出到 main/teamCapabilities.js（本文件顶 800 行软档，该口径被三处消费）。 */
const { capabilitiesOf } = require('../teamCapabilities');

function audit(action, target, detail) {
  try { deps?.audit?.(action, target, detail); } catch { /* 审计失败不阻断主流程 */ }
}

// ── T5-7：成员模型绑定的**展示**装配（主进程解析，渲染层不实现引用串格式）──
//
// 为什么在主进程做：引用串的解码与「供应商/模型还在不在」都依赖本机供应商列表，
// 若渲染层自己拼 `providerId::modelId`，格式就有了第二份实现——一旦与 main/modelShape.js
// 漂移，表现是「界面显示已绑定、实际却跑默认模型」这种静默错误。
// 输出三个字段供渲染层直接用：modelRef（选择器回显用的 {providerId, modelId}）、
// modelLabel（`供应商名 · 模型名`，解析不到为 null——此时渲染层提示「绑定已失效」）。
function labelOfModelRef(ref) {
  const providers = (typeof deps.getProviders === 'function' ? deps.getProviders() : []) || [];
  const resolved = resolveModelRef(ref, providers);
  if (!resolved) return null;
  const p = providers.find((x) => String(x && x.id != null ? x.id : '') === resolved.providerId);
  const models = Array.isArray(p?.models) ? p.models : [];
  const m = models.find((x) => String(x && (x.modelId != null ? x.modelId : x.model_id) || '') === resolved.model);
  const modelName = String(m?.displayName || resolved.model);
  return p?.name ? `${p.name} · ${modelName}` : modelName;
}

function decorateMember(m) {
  if (!m) return m;
  const ref = decodeModelRef(m.model);
  return { ...m, modelRef: ref || null, modelLabel: ref ? labelOfModelRef(m.model) : null };
}

function decorateTeam(team) {
  if (!team) return team;
  return Array.isArray(team.members) ? { ...team, members: team.members.map(decorateMember) } : team;
}

// ── 消息总线（T5-2）──

function emitTeamsEvent(evt) {
  try { deps?.emitTeamsEvent?.(evt); } catch { /* 广播失败不影响落库结果 */ }
}

/**
 * 写入一条总线消息 → 落库（G4 体积闸在 teamStore 内部）→ 超限时落审计 → 广播到渲染层。
 * 返回 { message, gated, reason }（teamStore 不可用时返回 null，调用方不因此中断主流程）。
 *
 * 与 postMessage 的分工：本函数保留 gated/reason（T5-8 的 team_send_message 必须如实告诉模型
 * 「payload 已被丢弃、summary 已截断」）；postMessage 是只要消息体的旧入口（生命周期广播用）。
 */
function postTeamMessage(input) {
  const store = deps.getTeamStore();
  if (!store) return null;
  const r = store.appendMessage(input);
  if (r.gated) audit('team_message_gate', input.teamId, r.reason);
  emitTeamsEvent({ type: 'team_message', message: r.message });
  return r;
}

function postMessage(input) {
  return postTeamMessage(input)?.message || null;
}

/**
 * 团队生命周期系统广播（编制变更留痕）。
 * summary 是**面向模型的中性文本**（不随界面语言变化），界面文案由 payload.sys 交渲染层 i18n 渲染——
 * 避免中文串在英文界面直接渲染（与「零裸中文」门禁同纪律）。
 */
function broadcastSystem(teamId, sys, name) {
  const tag = name ? `${sys}: ${name}` : sys;
  return postMessage({
    teamId,
    runId: SYSTEM_RUN_ID,
    kind: 'system',
    summary: tag,
    payload: name ? { sys, name } : { sys },
    refs: [],
  });
}

/**
 * T5-4：装配注入主管（编排器）的团队上下文块（§6 F2 派活链路）。
 * **零侵入**：经 orchestrator.planGoal 的 contextBlock 通道注入——编排器本身无需认识「团队」概念，
 * 因此不需要为「团队」改造 orchestrator（也就不会影响既有的单体编排链路）。
 *
 * 只注入 F2 的「派活三件」+ 编制清单（名称/工具/职责摘要），**不注入成员完整提示词**——
 * 编制快照与运行期编制变更是 T5-9 的职责，此处提前内联会造成「快照语义有两处实现」。
 */
function buildTeamContext(team, { mode, budget, memberIds } = {}) {
  const all = Array.isArray(team?.members) ? team.members : [];
  const picked = Array.isArray(memberIds) && memberIds.length
    ? all.filter((m) => memberIds.includes(m.id))
    : all;
  const lines = [
    '【军团团队上下文】',
    `团队：${team.name}（${team.description}）`,
    `协作模式：${mode === 'select' ? 'select（成员按能力认领）' : 'lead（主管统一拆解派发）'}`,
  ];
  if (budget) {
    lines.push(`预算上限：max_rounds=${budget.max_rounds}、max_tokens=${budget.max_tokens}、max_wall_ms=${budget.max_wall_ms}`);
  }
  lines.push(`参与本次派活的成员（${picked.length} 名，含统筹负责人）：`);
  for (const m of picked) {
    const isLead = m.id === team.leadMemberId;
    const tools = (Array.isArray(m.toolNames) ? m.toolNames : []).join('/') || '无';
    const role = String(m.systemPrompt || '').replace(/\s+/g, ' ').slice(0, 60);
    lines.push(`- ${m.name}${isLead ? '（统筹）' : ''}｜工具：${tools}${role ? `｜职责：${role}` : ''}`);
  }
  lines.push('拆解要求：优先把每个子任务分配给能力最匹配的成员；跨成员的数据依赖必须显式写 dependsOn，'
    + '禁止把可并行的任务串成链。');
  // 2026-10-21 用户实测：t1 只写规格用了 7 轮 / 5.3 万 tokens。公共上下文（目录/预算/成员）
  // 已在本块给出，子任务 prompt 再抄一遍会让每个 Worker 每轮重发同一段文字。
  lines.push('公共上下文（项目目录、预算、成员清单）已在本块给出：子任务 prompt 不得重复这些内容，'
    + '只写本任务的目标、要求、输出格式与验收标准；跨任务产物用工作区文件路径传递（上游写文件，下游只写「读取 <路径>」）。');
  // 2026-10-21 真机反馈：团队 4 人却只启动了 2 个（DAG 只拆了 2 个任务）。
  // 多人协作语义（每人/全员/轮流/各自）必须让每名成员都有独立产出，不能只拆 1~2 个任务让其余闲置。
  if (picked.length > 1) {
    lines.push(`成员参与要求：本团队有 ${picked.length} 名成员；若目标包含「每人 / 全员 / 轮流 / 各自 / 逐个」`
      + `等多人协作语义，任务数不得少于 ${picked.length} 个，且每个任务都应在标题或 prompt 中写明由哪名成员负责；`
      + '禁止只拆 1~2 个任务让其余成员闲置。');
  }
  return lines.join('\n');
}

// M5 / T5-9：run 级编制快照（纯函数，2026-10-21 抽至 main/teamRoster.js 为 B-02 腾行数）；
// 本文件继续 re-export，既有引用方零改动。
const { snapshotRoster } = require('../teamRoster');
// B-06：控制面（重置成员会话 / 中断）已抽至独立模块
const { registerTeamControl } = require('./teamControl');
// AI 建团草案（一次 N 个成员）的实现体：外置以守住 800 行软档
const teamsDraft = require('./teamsDraft');
// 2026-10-21 团队调试日志：IPC 统一埋点已抽到 ../teamIpcTrace（本文件守住 800 行软档）
const { installTeamsIpcTracing } = require('../teamIpcTrace');

function register() {
  const restore = installTeamsIpcTracing(ipcMain);
  try {
    registerHandlers();
  } finally {
    restore();
  }
}

function registerHandlers() {
  ipcMain.handle('teams:list', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）', teams: [] };
    try {
      // 军团全局可见：不再按 project_path 过滤（2026-10-20 用户反馈修正），
      // 任意项目/会话的渲染层都拿到同一份列表。
      const teams = store.listTeams({
        includeArchived: payload.includeArchived === true,
      // T5-7：成员模型绑定在主进程解析成展示标签（渲染层不实现引用串格式）
      }).map(decorateTeam);
      // maxMembers 随列表下发（2026-10-20 需求③）：成员上限是 teamStore 的单一事实来源，
      // 渲染层不自行硬编码，避免「界面写 20、后端拒在 8」的两份实现漂移。
      return { ok: true, teams, maxMembers: MAX_MEMBERS_PER_TEAM };
    } catch (err) {
      return { ok: false, error: err.message, teams: [] };
    }
  });

  ipcMain.handle('teams:get', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      const team = decorateTeam(store.getTeam(guard.assertStrings(payload, { teamId: 128 }).teamId));
      return { ok: true, team, maxMembers: MAX_MEMBERS_PER_TEAM };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('teams:create', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      // projectPath 可选：军团不强制绑定项目（2026-10-20 用户反馈修正）；空串/未传 = 全局团队
      guard.assertStrings(payload, {
        name: 60, description: 500, projectPath: { max: 1024, optional: true, allowEmpty: true },
      });
      const team = store.createTeam(payload);
      audit('team_create', team.id, `name=${team.name}`);
      broadcastSystem(team.id, 'teamCreated', team.name);
      return { ok: true, team };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('teams:update', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      const { teamId, patch } = payload;
      guard.assertStrings(payload, { teamId: 128 });
      const team = store.updateTeam(teamId, patch || {});
      audit('team_update', teamId, `fields=${Object.keys(patch || {}).join(',')}`);
      return { ok: true, team };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('teams:archive', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      guard.assertStrings(payload, { teamId: 128 });
      const team = store.setTeamArchived(payload.teamId, payload.archived !== false);
      audit('team_archive', payload.teamId, `archived=${payload.archived !== false}`);
      if (payload.archived !== false) broadcastSystem(payload.teamId, 'teamArchived', team.name);
      return { ok: true, team };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── 招募（source='template'）：按员工 id 取模板 → 组装 rolePreset → 落 team_members ──
  ipcMain.handle('teams:recruit', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      guard.assertStrings(payload, { teamId: 128, employeeId: 128 });
      const emp = resolveEmployeeById(payload.employeeId);
      if (!emp) return { ok: false, error: `数字员工不存在：${payload.employeeId}` };
      // 组装与 ecosystem:employeeRuntime 完全同源（同一函数），不另写一套映射
      const preset = buildEmployeeRuntimePreset(emp);
      const member = store.addMember(payload.teamId, {
        name: payload.name || emp.title_cn || emp.name,
        avatar: payload.avatar || null,
        roleKind: payload.roleKind || 'member',
        source: 'template',
        templateRef: emp.id,
        systemPrompt: preset.systemPrompt,
        toolNames: preset.toolNames,
        allowMcp: preset.allowMcp,
        // T5-7：模型绑定优先用招募时显式指定（payload.model），否则继承员工模板声明的 model
        //（模板声明若在此被丢弃，就会出现「会话里按模板模型跑、团队里却跑默认模型」的不一致）；
        // 两者皆空 → null（= 用会话默认模型）。canonical 化在 teamStore 单点完成，此处只传递。
        model: payload.model || preset.model || null,
        approvalMode: preset.approvalMode,
        sandboxPolicy: preset.sandboxPolicy,
        skillNames: preset.skillNames,
      });
      audit('team_recruit', member.id, `employee=${emp.id} team=${payload.teamId}`);
      broadcastSystem(payload.teamId, 'memberAdded', member.name);
      return { ok: true, member: decorateMember(member), capabilities: capabilitiesOf(member.toolNames) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── 自定义成员：AI 生成草稿（不落库，供人审）→ addCustomMember 落库 ──
  ipcMain.handle('teams:draftMember', async (_, payload = {}) => {
    if (!deps.chatOnce || !deps.resolveModel) return { ok: false, error: 'AI 草稿通道未就绪' };
    try {
      guard.assertStrings(payload, { description: 2000 });
      const model = deps.resolveModel(); // 未选模型时抛出明确错误
      const res = await deps.chatOnce({
        ...toChatRequest(model),
        messages: [
          { role: 'system', content: DRAFT_SYSTEM },
          { role: 'user', content: `【成员描述】\n${payload.description}` },
        ],
      });
      const raw = extractJson(res?.content || '');
      if (!raw || typeof raw !== 'object') {
        return { ok: false, error: '角色草稿解析失败，请重试或手动填写' };
      }
      // 归一化走 teamStore 单点（枚举 fail-closed），不信任模型输出
      const draft = normalizeMemberInput({ ...raw, source: 'custom' });
      if (!draft.name) draft.name = String(payload.description || '').slice(0, 20) || '新成员';
      return { ok: true, draft: { ...draft, capabilities: capabilitiesOf(draft.toolNames) } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── AI 建团草案：处理器与注册都在 ./teamsDraft.js（本文件贴 800 行软档）──
  teamsDraft.register(ipcMain, deps);
  // ── 数字员工草稿（2026-10-20 需求①）：AI 自动创建生态中心数字员工，**只出草稿不落盘** ──
  // 落盘仍走既有 `ecosystem:employeeCreate`（写通道单一事实来源，rbac/校验/原子写全在那边）——
  // 本处理器只做「描述 → 结构化草稿」，返回给渲染层表单预填，人审后由其保存。
  // 返回 id（ASCII slug）：它是 employees/<id>.json 的文件名，中文名 slug 化会是空串，
  // 由模型给出语义化 id 比让用户手填更可靠（表单仍会二次校验 ID_PATTERN，非法可改）。
  ipcMain.handle('teams:draftEmployee', async (_, payload = {}) => {
    if (!deps.chatOnce || !deps.resolveModel) return { ok: false, error: 'AI 草稿通道未就绪' };
    try {
      guard.assertStrings(payload, { description: 2000 });
      const model = deps.resolveModel(); // 未选模型时抛出明确错误
      const res = await deps.chatOnce({
        ...toChatRequest(model),
        messages: [
          { role: 'system', content: EMPLOYEE_DRAFT_SYSTEM },
          { role: 'user', content: `【员工描述】\n${payload.description}` },
        ],
      });
      const raw = extractJson(res?.content || '');
      if (!raw || typeof raw !== 'object') {
        return { ok: false, error: '员工草稿解析失败，请重试或手动填写' };
      }
      // tools 只保留 ROLE_TOOL_ALIASES 的键（未知别名丢弃，与 ecosystem 写通道同白名单，
      // 避免模型编造出生态中心不认识的别名导致「保存时被拒」）
      const known = Object.keys(ROLE_TOOL_ALIASES || {});
      const tools = Array.isArray(raw.tools)
        ? [...new Set(raw.tools.map((x) => String(x || '').trim()).filter((x) => known.includes(x)))]
        : [];
      const fallbackName = String(payload.description || '').trim().slice(0, 20) || '新员工';
      const name = String(raw.name || '').trim().slice(0, 40) || fallbackName;
      const id = String(raw.id || '').trim().toLowerCase().slice(0, 48);
      const systemPrompt = String(raw.systemPrompt || raw.system_prompt || '').slice(0, 12000);
      return { ok: true, draft: { id, name, system_prompt: systemPrompt, tools } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('teams:addCustomMember', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      guard.assertStrings(payload, { teamId: 128 });
      const member = store.addMember(payload.teamId, { ...payload, source: 'custom' });
      audit('team_add_member', member.id, `source=custom team=${payload.teamId}`);
      broadcastSystem(payload.teamId, 'memberAdded', member.name);
      return { ok: true, member: decorateMember(member), capabilities: capabilitiesOf(member.toolNames) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('teams:updateMember', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      guard.assertStrings(payload, { teamId: 128, memberId: 128 });
      const member = store.updateMember(payload.teamId, payload.memberId, payload.patch || {});
      audit('team_update_member', member.id, `fields=${Object.keys(payload.patch || {}).join(',')}`);
      return { ok: true, member: decorateMember(member), capabilities: capabilitiesOf(member.toolNames) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('teams:setMemberEnabled', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      guard.assertStrings(payload, { teamId: 128, memberId: 128 });
      const member = store.setMemberEnabled(payload.teamId, payload.memberId, payload.enabled !== false);
      audit('team_set_member_enabled', payload.memberId, `enabled=${payload.enabled !== false}`);
      return { ok: true, member: decorateMember(member) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('teams:removeMember', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      guard.assertStrings(payload, { teamId: 128, memberId: 128 });
      const member = store.removeMember(payload.teamId, payload.memberId);
      audit('team_remove_member', payload.memberId, `team=${payload.teamId}`);
      return { ok: true, member };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('teams:setLead', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）' };
    try {
      guard.assertStrings(payload, { teamId: 128, memberId: 128 });
      const team = store.setLead(payload.teamId, payload.memberId);
      audit('team_set_lead', payload.memberId, `team=${payload.teamId}`);
      broadcastSystem(payload.teamId, 'leadSet', store.getMember(payload.teamId, payload.memberId)?.name || '');
      return { ok: true, team };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── T5-4：一键创建统筹负责人（§6 F1）──
  // 只在缺统筹时可用（createLead 内部拒绝已有 Lead 的团队）。预填统筹默认提示词模板，落库后广播系统留痕。
  ipcMain.handle('teams:createLead', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: DISPATCH_ERRORS.UNAVAILABLE };
    try {
      guard.assertStrings(payload, { teamId: 128 });
      const member = store.createLead(payload.teamId, { name: payload.name, model: payload.model });
      audit('team_create_lead', member.id, `team=${payload.teamId}`);
      broadcastSystem(payload.teamId, 'leadCreated', member.name);
      return { ok: true, member: decorateMember(member), team: decorateTeam(store.getTeam(payload.teamId)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── T5-4：派活（§6 F2）──
  // 流程：强校验（dispatchGate，唯一判据）→ 缺省回落协作模式/预算（需求⑤简化派活）→ 落库为团队默认
  //   → 装配团队上下文 → 主管拆解（复用 orchestrator.planGoal，零侵入）
  //   → 派活消息入总线（run_id=groupId 是「团队↔run」关联的唯一事实来源）
  //   → 后台执行（workerPool.runGroup，不 await，与 autoOrchestrate 同型）。
  // 返回 code 供渲染层分支（LEAD_MISSING ⇒ 提示先补齐统筹负责人）。
  ipcMain.handle('teams:dispatch', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, code: 'UNAVAILABLE', error: DISPATCH_ERRORS.UNAVAILABLE };
    if (!deps.orchestrator || !deps.workerPool) {
      return { ok: false, code: 'UNAVAILABLE', error: DISPATCH_ERRORS.UNAVAILABLE };
    }
    try {
      guard.assertStrings(payload, {
        teamId: 128, projectPath: { max: 1024, optional: true, allowEmpty: true },
      });
      const goal = String(payload.goal == null ? '' : payload.goal).trim();
      if (!goal) return { ok: false, code: 'MISSING_GOAL', error: DISPATCH_ERRORS.MISSING_GOAL };

      const team = store.getTeam(payload.teamId);
      const gate = dispatchGate(team);
      if (!gate.ok) {
        return { ok: false, code: gate.code, error: DISPATCH_ERRORS[gate.code] || '派活校验未通过' };
      }

      // 2026-10-20 需求⑤（简化派活）：对话内「选团队 → 直接发消息」不再弹表单，
      // 故「协作模式 / 预算上限」改为缺省回落——模式取团队默认（缺省 lead），
      // 预算取「团队默认预算 → G2 默认值」。显式传入且合法时仍以传入值为准（IPC 契约对其它调用方保持兼容）。
      const mode = (payload.mode === 'lead' || payload.mode === 'select')
        ? payload.mode
        : (team.defaultMode === 'select' ? 'select' : 'lead');
      const budgetGiven = payload.budget && typeof payload.budget === 'object'
        && Object.keys(payload.budget).length > 0;
      const budget = normalizeBudget(budgetGiven ? payload.budget : (team.budget || {}));

      // 参与成员子集（软约束）：只保留团队在册成员 id；空/未传 ⇒ 全队（含 Lead）。
      // P0-2（2026-10-29）：排除处于 offline 的成员（其会话已被重置/私有记忆已降权，不宜再派活）。
      // 若过滤后为空（全员离线），由 planWaves 兜底（与「名册为空」极端情况同口径）。
      const memberIds = Array.isArray(payload.memberIds) && payload.memberIds.length
        ? (team.members || []).filter((m) => payload.memberIds.includes(m.id) && m.state !== 'offline').map((m) => m.id)
        : (team.members || []).filter((m) => m.state !== 'offline').map((m) => m.id);

      // 派活三件中的「协作模式 / 预算上限」落库为团队默认值：既是本次的显式取值，
      // 也作为下次派活表单的预填底座（团队卡片同样可编辑这两项，语义一致）。
      store.updateTeam(payload.teamId, { defaultMode: mode, budget });

      const contextBlock = buildTeamContext(team, {
        mode, budget, memberIds,
      });
      // 工作目录：优先本次派活会话的项目路径（用户刚建的项目空间就落在这里），
      // 没有再回落团队自带 project_path（全局团队不携带 project_path）；
      // 两者皆空时编排器按「未指定」处理。T6-13 真机反馈：此前团队路径优先，
      // 建完项目仍跑到团队旧目录，产物看起来「没生成」。
      const projectPath = String(payload.projectPath || team.projectPath || '');
      // M5 / T5-12（§13.4）：批次计划。参与名册 = 本次被选中的成员（受人数闸/类型闸约束），
      // 由 planWaves 决定「先起哪一小批」并把任务指派给成员；计划随 dag_json 落库，运行期读取。
      // 名册为空的极端情况（理论上 dispatchGate 已拦）由 planWaves 自己兜底，不影响拆解。
      // 第八轮 B-05 / B-08：装配逻辑搬到 main/teamDispatchPlan.js —— 那里同时修掉
      // 「类型闸 deferred 被运行期绕过」（快照收窄到参与成员）与「select 模式没有运行期分支」
      // （不预置指派表 ⇒ 走被动认领）。本文件只负责把结果交给编排器并留下可观测记录。
      const roster = (team.members || []).filter((m) => memberIds.includes(m.id));
      // 2026-10-21 对话型目标旁路：如「每人报数」——不调模型拆解、不产出文件，
      // 直接按名册每人一个「只输出一行」的任务（此前会被拆成「实现命令行报数程序」）。
      const chatOnly = isChatOnlyGoal(goal);
      // 预设清单的唯一决策点（纯函数，可单测）：对话型 > 确认卡回传（归一后）> null 回落 LLM 拆解。
      const presetTasks = resolveDispatchPresetTasks({ chatOnly, roster, incoming: payload.presetTasks });
      // 调试日志：派活入口的完整输入（谁派的、选了多少人、什么模式/预算）。
      teamDebug.log('dispatch', 'start', {
        teamId: payload.teamId,
        teamName: team.name,
        threadId: payload.threadId || null,
        goal,
        mode,
        budget,
        projectPath,
        leadMemberId: team.leadMemberId || null,
        memberIds,
        roster: roster.map((m) => ({ id: m.id, name: m.name, roleKind: m.roleKind, enabled: m.enabled })),
      });
      let dispatchPlan = null;
      const planOpts = {
        goal,
        cwd: projectPath,
        projectPath,
        contextBlock,
        threadId: payload.threadId,
        // 预设任务清单（对话型 或 确认卡回传）由宿主确定，编排器跳过 LLM 拆解。
        // 只走归一后的 presetTasks 这一条路：早期另有一条「原样透传 payload.presetTasks」的分支，
        // 会绕过归一（超长/坏依赖/非法 id 全部进编排器）并把它顶掉——已删，不要加回来。
        ...(presetTasks ? { presetTasks } : {}),
        // T5-9：批次计划与**编制快照**同批产出；快照随 dag_json 落库，运行期不再读实时名册。
        planWaves: ({ tasks }) => {
          dispatchPlan = buildDispatchPlan({ tasks, roster, budget, mode, chatOnly });
          // 调试日志：批次 / 指派 / 被闸门挡下的成员与原因（「为什么某人没被派活」的第一现场）。
          teamDebug.log('dispatch', 'plan', {
            tasks: tasks.map((t) => ({ id: t.id, title: t.title, dependsOn: t.dependsOn || [] })),
            waves: dispatchPlan.waves,
            assignments: dispatchPlan.assignments,
            activeMemberIds: dispatchPlan.activeMemberIds,
            deferredMembers: dispatchPlan.deferredMembers,
            rosterSnapshot: Array.isArray(dispatchPlan.roster)
              ? dispatchPlan.roster.map((m) => ({ id: m.id, name: m.name, roleKind: m.roleKind, enabled: m.enabled }))
              : null,
          });
          return dispatchPlan;
        },
      };
      const first = await deps.orchestrator.planGoal(planOpts);
      let r = first;
      // 拆解输出未过校验（r.raw 存在）→ 带错误原因自动修复重试一次，与 autoOrchestrate 同口径：
      // 一次非法 DAG 不该让整次派活直接失败（真机：依赖数上限误杀合法计划 → 一个任务都没派）。
      if (!first.ok && first.raw && !presetTasks) {
        teamDebug.log('dispatch', 'plan_retry', { goal, error: first.error });
        const repaired = await deps.orchestrator.planGoal({ ...planOpts, repairHint: first.error });
        r = repaired;
      }
      if (!r.ok) {
        teamDebug.log('dispatch', 'plan_failed', { goal, error: r.error, code: r.code || null });
        return { ok: false, code: 'PLAN_FAILED', error: `${DISPATCH_ERRORS.PLAN_FAILED}：${r.error}` };
      }

      // 派活消息入总线：run_id = groupId，这是「run 属于哪个团队」的唯一事实来源（不新增 group 列）。
      // G1：发言只由看板事件/主管指定触发——派活是「主管发起」，故用 kind='assign'。
      postMessage({
        teamId: payload.teamId,
        runId: r.groupId,
        kind: 'assign',
        fromMemberId: team.leadMemberId,
        toMemberId: null,
        summary: goal,
        refs: [],
        payload: {
          mode,
          budget,
          memberIds,
          // M5 / T5-12：批次计划摘要（渲染层/审计可读「这次分了几批、每批几个任务」）
          waves: Array.isArray(r.waves)
            ? r.waves.map((w) => ({ index: w.index, tasks: w.taskIds.length }))
            : null,
          caps: { maxActive: MAX_ACTIVE_MEMBERS, maxPerType: MAX_PER_TYPE_IN_RUN },
          // 第八轮 B-05：类型闸/人数闸挡下的成员与原因。此前 this 信息产出即丢弃，
          // 用户永远看不到「20 人里只派了 10 人、其中 3 人同类型超限」——可观测性空洞。
          active: dispatchPlan ? dispatchPlan.activeMemberIds.length : null,
          deferred: dispatchPlan ? dispatchPlan.deferredMembers : null,
        },
      });
      audit('team_dispatch', payload.teamId, `run=${r.groupId} mode=${mode} tasks=${r.tasks.length}`
        + `${Array.isArray(r.waves) ? ` waves=${r.waves.length}` : ''}`
        + `${dispatchPlan?.deferredMembers?.length ? ` deferred=${dispatchPlan.deferredMembers.length}` : ''}`);
      emitTeamsEvent({
        type: 'team_dispatch', teamId: payload.teamId, runId: r.groupId, goal, tasks: r.tasks.length,
        waves: Array.isArray(r.waves) ? r.waves.length : 0,
        mode,
        active: dispatchPlan ? dispatchPlan.activeMemberIds.length : 0,
        deferred: dispatchPlan ? dispatchPlan.deferredMembers : [],
      });
      // 后台执行（不 await）：调用方立即拿回派活结果，执行进度经既有 tasks:event 流到 AgentDock。
      teamDebug.log('dispatch', 'run_group_start', {
        teamId: payload.teamId,
        runId: r.groupId,
        tasks: Array.isArray(r.tasks) ? r.tasks.map((t) => ({ id: t.id, title: t.title })) : null,
        waves: Array.isArray(r.waves) ? r.waves : null,
      });
      Promise.resolve(deps.workerPool.runGroup(r.groupId)).catch((e) => {
        teamDebug.log('dispatch', 'run_group_failed', { runId: r.groupId, error: e });
        emitTeamsEvent({
          type: 'team_dispatch_failed', teamId: payload.teamId, runId: r.groupId, error: String(e?.message || e),
        });
      });
      return { ok: true, groupId: r.groupId, tasks: r.tasks.length };
    } catch (err) {
      teamDebug.log('dispatch', 'error', { error: err, payload });
      return { ok: false, code: 'DISPATCH_FAILED', error: err.message };
    }
  });

  // ── M5 / T5-6：对话内团队协同事件流（§13.5）──
  //
  // 只读入口：渲染层给 threadId，主进程把「本会话派过的 run」连同总线消息、看板任务与
  // 活动轨迹一起返回，由渲染层投影成对话内卡片（默认折叠、可展开轨迹）。
  //
  // 关联三条事实源，各司其职（不新增列、不建第二套存储）：
  //   ① `task_groups.thread_id`  → 哪些 run 属于这个会话（T5-11 已贯穿）；
  //   ② `team_messages.run_id`   → 该 run 属于哪个团队 + 协同轨迹（派活/系统留痕）；
  //   ③ `sub_tasks.owner_member_id` → 谁接的手、干到哪一步、结论摘要（看板是权威事实）。
  //   ④ `task_events(group_id)`  → 每个任务的处理轨迹（工具调用/撤员/改派/等待，2026-10-21 新增）。
  //
  // 统一显示（2026-10-21 用户口径）：普通编排组与军团派活组共用同一张对话卡——
  // 有团队消息的标 kind='team'，其余标 kind='orchestration'（渲染层显示「项目编排」）。
  ipcMain.handle('teams:listThreadRuns', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    const taskStore = deps.getTaskStore?.();
    if (!store || !taskStore) return { ok: false, error: DISPATCH_ERRORS.UNAVAILABLE, runs: [] };
    try {
      // threadId 在本机是自增**数字** id（渲染层 thread.id 为 number），旧 assertStrings 只收字符串，
      // 会把合法主路径整个拦住（"threadId 必须是字符串（收到 number）"——与 2026-10-18 providerId
      // 同型事故：校验加严却没带正样本）。改用 assertIdLike：接受有限数字或非空字符串，
      // 缺省视为未提供；字符串形态仍在下方面向长度上限（128）兜底。
      guard.assertIdLike(payload, ['threadId']);
      const threadId = String(payload.threadId == null ? '' : payload.threadId).trim();
      if (!threadId) return { ok: true, runs: [] };
      if (threadId.length > 128) return { ok: true, runs: [] };
      const groups = taskStore.listGroupsByThread(threadId, { limit: THREAD_RUN_LIMIT });
      if (!groups.length) return { ok: true, runs: [] };

      const groupById = new Map(groups.map((g) => [g.group_id, g]));
      const messages = store.listMessagesByRuns(groups.map((g) => g.group_id), { limit: THREAD_MESSAGE_LIMIT });
      // 活动轨迹：按组批量取（每组最近 N 条）。store 未实现时按空数组降级（老库/假 store 单测）。
      const events = [];
      if (typeof taskStore.listEventsByGroup === 'function') {
        for (const g of groups) {
          try { events.push(...(taskStore.listEventsByGroup(g.group_id, { limit: 200 }) || [])); }
          catch { /* 单组轨迹读取失败不影响卡片主体 */ }
        }
      }
      // 装配是纯函数（shared/teamStream.mjs）：普通编排组与团队 run 统一投影、按团队取成员、
      // 按建组时间倒序。主进程只负责查库，UI 口径不在这里二次发明。
      const { assembleThreadRuns } = await loadTeamStream();
      const runs = assembleThreadRuns({
        groups,
        messages,
        events,
        getGroup: (runId) => (groupById.has(runId) ? taskStore.getGroup(runId) : null),
        getTeam: (teamId) => store.getTeam(teamId),
        // 在途用量的唯一来源是 groupBudget 的内存账本；未 begun（历史 run）返回 null，
        // 投影层自动回落任务已结算用量，不会出现 NaN / 假 0。
        getBudgetLive: (runId) => groupBudget.snapshotOf(runId),
      });
      return { ok: true, runs };
    } catch (err) {
      return { ok: false, error: err.message, runs: [] };
    }
  });

  // ── 消息总线读取（T5-2）：渲染时间轴 / 增量拉取。写入无 IPC 通道（G1：发言只能被看板事件或主管触发）──
  ipcMain.handle('teams:listMessages', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: '团队子系统不可用（初始化失败）', messages: [] };
    try {
      guard.assertStrings(payload, { teamId: 128 });
      const messages = store.listMessages({
        teamId: payload.teamId,
        runId: payload.runId,
        afterSeq: payload.afterSeq,
        limit: payload.limit,
      });
      return { ok: true, messages };
    } catch (err) {
      return { ok: false, error: err.message, messages: [] };
    }
  });

  // ── B-06：控制面 handler（重置成员会话 / 运行中断）已抽至 ./teamControl.js ──
  // 抽取原因与现实收益：两块控制面动作只由用户界面触发、权限全部委托既有模块，
  // 与「编制 / 消息」读写是不同职责；抽走后本文件回落到 800 行软档以下。
  registerTeamControl({ ipcMain, deps, guard, audit, broadcastSystem, DISPATCH_ERRORS });
}

function initTeamsIpc(d) {
  deps = d;
  register();
}

// deps: { getTeamStore, getTaskStore, audit, chatOnce, resolveModel, emitTeamsEvent, getProviders, orchestrator, workerPool, clearCheckpoint, getMemoryManager }
module.exports = {
  initTeamsIpc, DRAFT_SYSTEM, EMPLOYEE_DRAFT_SYSTEM, extractJson, capabilitiesOf,
  // T5-4：派活链路的两处纯函数导出（便于单测直接断言上下文装配与错误码，不必起 IPC）
  buildTeamContext, DISPATCH_ERRORS,
  // T5-8：模型侧协同工具复用同一写入通道（保留 gated/reason；模块内 deps 在 initTeamsIpc 后生效）
  postTeamMessage,
  // T5-9：编制快照（run 级不可变名册）的纯装配函数——单测直接断言字段收敛，不必起 IPC
  snapshotRoster,
};
