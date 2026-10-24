// 派活计划装配：批次计划 + 编制快照 + 协作模式（第八轮 B-05 / B-08，2026-10-21）
//
// 为什么要有这一层：`ipc/teams.js` 已贴着 800 行软档，而本轮两处修正都落在
// 「planWaves 回调产出什么」这一处。按项目纪律「先拆再合入、白名单只减不增」，
// 把「产出计划」这件事从 IPC 文件里整块搬出来，顺手把两个语义缺陷修掉。
//
// ── B-05：类型闸的 deferred 在运行期被绕过 ────────────────────────────────────
//   缺陷有两层，第二层才是真问题：
//     ① `deferredMembers` / `activeMemberIds` 由 `teamWaves.planWaves` 产出后**被丢弃**
//        （orchestrator 只取 waves/assignments/roster）——「20 人里只有 10 人参与、
//        其中 3 人被类型闸挡下」这件事用户永远看不到；
//     ② 更实质：快照用的是**全量 roster**，而运行期回落指派
//        `pickOwnerMember(eligibleRoster(...))` 也从全量名册取模——
//        于是被类型闸挡下的人照样会被派活，`MAX_PER_TYPE_IN_RUN` 只影响分批、不影响认领。
//   修法：① 快照只装「本次真正参与的人」（`activeMemberIds` 子集），让运行期的一切认领
//   都落在这个子集里；② 把 deferred 名单与原因随 `runMeta.dispatch` 落库并回传派活消息，
//   让「谁没被派上、为什么」有账可查。
//
//   一个必须保留的例外：**统筹（roleKind==='lead'）恒留在册**。
//   理由不是特权，而是三处硬依赖都要求它在快照里——`teamInterrupt` 的审计名解析
//   （`targetName` 查不到就退化成裸 id）、`checkInterruptPermit` 的 lead 主体判定
//   （`actorRoleKind` 取自快照），以及 `memberSession` 的 lead 会话键。
//   统筹被类型闸挡下时把它踢出快照，会让「can't interrupt / 审计丢名字」这两个后果
//   同时出现，而它实际上仍在跑（lead 也执行任务）。
//
// ── B-08：协作模式没有运行期分支 ─────────────────────────────────────────────
//   `TEAM_MODES = ['lead','select']` 此前**只影响提示词里的一句话**，两种模式在代码里
//   走的完全是同一条路。UI 把「协作模式」做成用户可选项，等于让用户以为能改行为。
//   修法（成本最低且能让名字名实相符）：`select` 模式**不产出预置指派表**——
//   `dag.assignments` 为空 ⇒ `waveEngine.preferredOwnerOf` 返回 null ⇒
//   `workerPool` 走 `pickOwnerMember` 按能力被动认领。`lead` 模式保持原有的
//   「主管预置指派」（批内轮转，把任务落到具体人头上）。
//   两条分支都是确定性的：模式再也不是一句提示词，而是「有没有指派表」这个可断言的事实。
//
// 纯函数、不碰数据库、不调模型：输入由派活层给，输出原样交给编排器落 dag_json。

'use strict';

const { planWaves, MAX_ACTIVE_MEMBERS } = require('./teamWaves');
const { snapshotRoster } = require('./teamRoster');

/** 协作模式（与 teamStore.TEAM_MODES 同值；此处只做「是否预置指派」的判据）。 */
const SELECT_MODE = 'select';

// ── 对话型目标（2026-10-21 用户实测）──────────────────────────────────────────
// 现象：用户只想让团队「报数」（软件工程师：1，团子：2 …），编排器却把目标理解成
// 「实现命令行报数程序」，Worker 于是 read_file / list_dir / write_file / shell 全套跑一遍，
// 单任务烧 2 分钟 + 数万 tokens，还被探活撤员改派给下一个人重写同一个文件。
// 根因不在提示词措辞，而在链路：LLM 拆解天然会「把目标做成一个产物」。
// 因此对这类目标必须走**确定性旁路**：不调模型拆解、不产出文件、每人一句话。
//
// 判据是窄规则词典（零延迟、可解释、不出网）：只认明确的「对话型」语义，
// 不把普通编程目标（含「每人负责一个模块」）误判进来。
const CHAT_ONLY_RULES = [
  /报数/,
  /轮流(说|讲|发言|回答|报|介绍)/,
  /(每人|各位|大家|全员|逐个|依次)(各)?(说|讲|回答|报|介绍)(一)?句/,
  /一人一句/,
];
// 反向判据：目标里明确要「写程序 / 做文件 / 开发应用」时不走对话旁路——
// 否则「实现一个报数程序」也会被误判成「每人说一句」，把真正的编码任务做丢了。
const CHAT_ONLY_DENY = /程序|脚本|代码|实现|开发|命令行|文件|项目|应用/;

/** 目标是否为「只要每人说一句话」的对话型目标。 */
function isChatOnlyGoal(goal) {
  const g = String(goal == null ? '' : goal).trim();
  if (!g) return false;
  if (CHAT_ONLY_DENY.test(g)) return false;
  return CHAT_ONLY_RULES.some((re) => re.test(g));
}

/**
 * 为对话型目标生成确定性任务：参与名册里每人一个任务，按名册序编号。
 * 任务 prompt 明确禁止工具/文件/命令，只要一行输出——不交给模型自由发挥。
 *
 * @param {{roster?:Array<object>, goal?:string}} input
 * @returns {Array<object>} 可直接交给 orchestrator 的 presetTasks
 */
function buildChatTasks({ roster } = {}) {
  const list = (Array.isArray(roster) ? roster : []).filter((m) => m && m.id);
  return list.map((m, i) => {
    const name = String(m.name || m.id);
    return {
      id: `t${i + 1}`,
      title: `${name}：${i + 1}`,
      // 只保留四段结构中的「目标 + 输出格式」，并显式禁工具：这是与「写程序」划清界限的关键一句。
      prompt: `不要调用任何工具，不要读写文件，不要执行命令；直接输出一行文本：${name}：${i + 1}`,
      dependsOn: [],
      critical: false,
      maxRetry: 1,
    };
  });
}

// ── 确认卡预拆任务的入口归一（双入口 P0/P1 接线，2026-10-24）───────────────
//
// 为什么需要这一层：`entryRouter` 的 C1 确认卡承诺「卡上的子任务清单就是实际执行的清单」
// （设计纪律①：否则用户确认 A、执行 B）。渲染层点「按这个执行」时把卡上清单原样回传，
// 由 `teams:dispatch` 当作 presetTasks 直接落库——绕开 LLM 二次拆解，两者才一致。
//
// 但这意味着**渲染层的内容会变成模型提示词**，所以必须在这里归一而不是信任入参：
//   · 数量上限 8（与 orchestrator 的 DAG 上限同口径）——一次 IPC 不能塞进任意多任务；
//   · title/prompt 长度封顶——超长正文会撑爆 Worker 上下文；
//   · dependsOn 只保留「本批真实存在的 id」且剔除自环——否则编排器会判环失败、
//     整组派不出去（真机踩过：一个坏依赖让所有任务都没派）。
// 非法项**丢弃而非整批失败**：确认卡是用户已经看过的清单，个别条目坏掉不该让派活整体失败；
// 若一条都不合法则返回 null，回落 LLM 拆解（宁可用新拆解，也不执行空计划）。

const PRESET_TASK_MAX = 8;
const PRESET_TITLE_MAX = 200;
const PRESET_PROMPT_MAX = 4000;

/**
 * 归一「确认卡回传的预拆任务」。纯函数、不抛异常。
 * @param {unknown} input
 * @returns {Array<object>|null} 合法则返回可交给 orchestrator 的 tasks；否则 null
 */
function normalizePresetTasks(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const head = input.slice(0, PRESET_TASK_MAX);
  const kept = [];
  for (let i = 0; i < head.length; i++) {
    const raw = head[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const title = String(raw.title == null ? '' : raw.title).trim().slice(0, PRESET_TITLE_MAX);
    const prompt = String(raw.prompt == null ? '' : raw.prompt).trim().slice(0, PRESET_PROMPT_MAX);
    if (!title || !prompt) continue;
    const id = String(raw.id == null ? '' : raw.id).trim().slice(0, 64) || `t${i + 1}`;
    kept.push({ id, title, prompt, dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn : [] });
  }
  if (!kept.length) return null;
  // id 去重（后者让位）：重复 id 会让 depends_on 指向二义节点
  const seen = new Set();
  const tasks = [];
  for (const t of kept) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    tasks.push(t);
  }
  if (!tasks.length) return null;
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    // 只留本批存在的依赖、去掉自环；顺序保持不变（编排器按拓扑分层）
    dependsOn: [...new Set(t.dependsOn.map(String).filter((d) => ids.has(d) && d !== t.id))],
    critical: false,
    maxRetry: 1,
  }));
}

/**
 * 解析「本次派活用哪份任务清单」——派活层唯一的决策点（可单测，不依赖 IPC）。
 *
 * 优先级：对话型目标（确定性清单）> 确认卡回传（归一后）> null（回落 LLM 拆解）。
 * 为什么要有这一层：早期 `ipc/teams.js` 里同时存在「归一后的 presetTasks」与「原样透传
 * payload.presetTasks」两条路，后者会把前者顶掉⇒归一形同虚设。把决策收成一个纯函数后，
 * 「绕过归一」这种退化只能通过改这个函数发生，行为断言能直接抓住。
 *
 * @param {{chatOnly?:boolean, roster?:Array<object>, incoming?:unknown}} input
 * @returns {Array<object>|null}
 */
function resolveDispatchPresetTasks({ chatOnly = false, roster = [], incoming = null } = {}) {
  if (chatOnly) return buildChatTasks({ roster });
  return normalizePresetTasks(incoming);
}

/**
 * 从全量名册里挑出「本次真正参与」的成员（B-05）。
 *
 * @param {Array<object>} roster 本次被选中的成员（含统筹）
 * @param {Array<string>} activeMemberIds `planWaves` 给出的参与名单
 * @returns {Array<object>} 收窄后的名册
 */
function pickParticipatingRoster(roster, activeMemberIds) {
  const list = (Array.isArray(roster) ? roster : []).filter((m) => m && m.id);
  const active = new Set((Array.isArray(activeMemberIds) ? activeMemberIds : []).map(String));
  if (!active.size) return list; // 计划没给出参与名单（空任务等）→ 保持原样，不做无依据的裁剪
  const kept = list.filter((m) => active.has(String(m.id)) || m.roleKind === 'lead');
  // 兜底：若收窄后为空（理论上不可能：名册非空时 active 至少 1 人），保留全量。
  // 宁可多派一个人，也不要让一次派活因为「裁剪逻辑自己出错」变成空跑。
  return kept.length ? kept : list;
}

/**
 * 装配一次派活的运行期计划（B-05 / B-08 的单一落点）。
 *
 * @param {{
 *   tasks: Array<object>,
 *   roster: Array<object>,
 *   budget?: object|null,
 *   mode?: string,
 * }} input
 * @returns {object} 供 `orchestrator.planGoal` 的 planWaves 钩子原样返回
 */
function buildDispatchPlan({ tasks, roster, budget = null, mode = 'lead', chatOnly = false } = {}) {
  // 对话型目标：类型闸（默认同类型最多 2 人）是为了限制重任务的并发，对「每人说一句话」
  // 没有意义——若沿用默认值，4 名同类成员只会有 2 人参与报数。这里只保留人数上限。
  const plan = planWaves({
    tasks,
    members: roster,
    ...(chatOnly ? { maxPerType: MAX_ACTIVE_MEMBERS } : {}),
  });
  const activeMemberIds = Array.isArray(plan.activeMemberIds) ? plan.activeMemberIds : [];
  const deferredMembers = Array.isArray(plan.deferredMembers) ? plan.deferredMembers : [];
  // B-08：select ⇒ 不预置指派（成员按能力被动认领）；lead ⇒ 保留批内轮转指派。
  // 对话型目标恒用预置指派：任务标题/输出文本是按名册序写的「某人：序号」，
  // 必须落到同名成员头上，不能被被动认领打乱。
  const assignments = (mode === SELECT_MODE && !chatOnly) ? {} : (plan.assignments || {});
  return {
    ...plan,
    assignments,
    // B-05 ①：快照只装参与成员（统筹例外恒留），运行期只读快照 ⇒ 类型闸真正生效。
    roster: snapshotRoster(pickParticipatingRoster(roster, activeMemberIds)),
    // B-05 ②：预算维持既有 `runMeta.budget` 位置不变（groupBudget 是既有消费者）；
    // `dispatch` 是本轮新增的可观测子块，读不到就是「没有计划」，不影响预算闸。
    // `chatOnly`：Worker 读取后切换为「只说话、不干活」的系统提示词并收紧轮次。
    runMeta: {
      budget,
      chatOnly,
      dispatch: {
        mode,
        activeMemberIds,
        deferredMembers,
        caps: plan.caps || null,
      },
    },
  };
}

module.exports = {
  buildDispatchPlan,
  pickParticipatingRoster,
  isChatOnlyGoal,
  buildChatTasks,
  normalizePresetTasks,
  resolveDispatchPresetTasks,
  SELECT_MODE,
};
