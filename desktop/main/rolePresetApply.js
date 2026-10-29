// rolePreset 应用器 —— 主会话通道与 Worker 通道的**唯一**事实来源
//
// 背景（第八轮审查 B-01 / 决策 D-808）：
//   军团成员的运行期配置（model / toolNames / systemPrompt / approvalMode / sandboxPolicy /
//   skillNames）在 `snapshotRoster` 里存得完整，但只有**主会话通道**（agentRunner 的 rolePreset
//   分支）真正消费；Worker 通道（workerPool）从不读这些字段。结果是「声明了限制却不执行」：
//   给成员配 toolNames=['read','grep']，Worker 实际拿到 shell/write/git/MCP 全量工具。
//
//   比"没做"更糟的是**两条链路各写一套**：改一处忘另一处，就是下一次同族缺陷。
//   因此把宿主侧的应用逻辑收敛到本模块一份，两条通道都 require 它。
//
// 职责边界（重要，别把不该放的东西塞进来）：
//   · 本模块只做**宿主侧**的三件事：治理档取更严、per-agent 模型绑定、技能按名装载。
//   · **人格与工具子集不在此处落地**，而是把 rolePreset 原样交给引擎，由引擎统一处置：
//       - `rolePreset.systemPrompt` → 引擎 `sysSections.role`，走 guardUntrusted 注入检测
//         （员工包可分发/可改写，属第三方可控文本，绝不能裸拼接）；
//       - `rolePreset.toolNames`   → 引擎工具表交集裁剪，**空交集 fail-closed 收敛为空集**。
//     宿主侧再实现一遍等于制造第二份真相源，且会绕过注入检测。
//
// 与既有语义的兼容性：
//   · 治理档取更严是**单向**的（角色只能收紧）。无人值守通道的 auto-safe 地板、组快照的沙箱
//     策略都在调用前已设好，本模块只会让它们更严，不会放宽 —— 满足融入方案 §5.1 原则 4
//     「安全不降级」。
//   · 模型绑定解析失败**绝不失败整轮**，只 warn 后回落原模型：绑定失效是配置问题，不是运行错误。
//     （同理技能装载失败也只是"该成员本轮无技能"，不阻断任务。）

'use strict';

const { stricterApproval, stricterSandbox } = require('./approvalPolicy');
const { toAgentModel } = require('./modelShape');

/**
 * 把 rolePreset 应用到引擎参数对象上（就地修改并返回）。
 *
 * @param {object} engineParams  引擎参数（agentRunner 的 engineParams / workerPool 的 runOpts）
 * @param {object|null|undefined} rolePreset 成员/角色预设；假值即空操作（非军团路径零回归）
 * @param {object} deps          宿主依赖：{ resolveModelRef?, loadSkillContents? }
 * @param {string} [label]       日志定位串（runId / taskId），仅用于诊断
 * @returns {object} 同一个 engineParams（便于链式调用）
 */
function applyRolePreset(engineParams, rolePreset, deps = {}, label = '') {
  if (!rolePreset || typeof rolePreset !== 'object') return engineParams;
  const where = label ? ` ${label}` : '';

  // ① 治理档：角色只能收紧，永不放宽。
  //    stricterApproval / stricterSandbox 对非法值有归一处理（见 approvalPolicy 头注），
  //    因此这里可以放心把可能为 null 的成员配置直接传进去。
  engineParams.approvalMode = stricterApproval(engineParams.approvalMode, rolePreset.approvalMode);
  engineParams.sandboxPolicy = stricterSandbox(engineParams.sandboxPolicy, rolePreset.sandboxPolicy);

  // ② per-agent 模型绑定（T5-7）：成员绑定的模型优先于默认模型 —— 这正是「per-agent」的含义。
  //    fail-closed 且**绝不失败整轮**：引用串解析不出来（没绑 / 供应商或模型已被删除 / 记录坏）
  //    一律沿用原模型，只留一条 warn。
  if (rolePreset.model) {
    const resolved = typeof deps.resolveModelRef === 'function'
      ? deps.resolveModelRef(rolePreset.model)
      : null;
    if (resolved) {
      try {
        engineParams.model = toAgentModel(resolved);
      } catch (e) {
        console.warn(`[rolePreset] 成员模型绑定形状转换失败（回落默认模型）${where}:`, e.message);
      }
    } else {
      console.warn(`[rolePreset] 成员模型绑定解析失败（回落默认模型） ref=${rolePreset.model}${where}`);
    }
  }

  // ③ 技能按名装载（T4-3 技能接线 / DS Bot「可复用 skill」）。
  //    内容安全处置统一在引擎侧不可信内容管道（guardUntrusted），此处只按名装载。
  if (Array.isArray(rolePreset.skillNames)
      && rolePreset.skillNames.length
      && typeof deps.loadSkillContents === 'function') {
    try {
      const loaded = deps.loadSkillContents(rolePreset.skillNames) || [];
      engineParams.skills = [...(engineParams.skills || []), ...loaded];
      // 2026-10-21 真机事故修复：军团成员动辄挂载 10+ 个技能（实测某成员 12 个 SKILL.md
      // 合计约 127KB ≈ 数万 tokens）。full 模式会把全部正文拼进 system，每轮重发，
      // 于是一个「报数」级子任务在 2 轮内就烧到 69k tokens 并触发上下文收尾。
      // 统一改走引擎的「索引 + load_skill 按需加载」：system 只留 name/description，
      // 正文由引擎从本次已装载的 skills[].content 回退读取（宿主无需额外通道）。
      // 调用方显式指定 full 时尊重显式值，不在这里覆盖。
      if (!engineParams.skillDisclosure) engineParams.skillDisclosure = 'summary';
    } catch (e) {
      console.warn(`[rolePreset] 技能装载失败（该成员本轮无技能）${where}:`, e.message);
    }
  }

  // ④ 人格与工具子集交给引擎（见文件头「职责边界」）。
  engineParams.rolePreset = rolePreset;
  return engineParams;
}

/**
 * 从军团名册成员构造 rolePreset（字段口径必须与 `ipc/teams.js` 的 `snapshotRoster` 一致）。
 * 只做形状搬运，不做任何判定 —— 空值一律收敛为「不限制/不覆盖」，让 applyRolePreset 自然跳过。
 *
 * @param {object|null} member 名册成员（可能是 run 快照，也可能是实时名册）
 * @returns {object|null}
 */
function rolePresetFromMember(member) {
  if (!member || !member.id) return null;
  return {
    name: member.name || member.id,
    systemPrompt: member.systemPrompt || '',
    toolNames: Array.isArray(member.toolNames) ? member.toolNames : [],
    allowMcp: member.allowMcp === true,
    // P1-4：成员级 MCP 粒度（服务器名 / 完整工具名）。空数组 = 不抑制 allowMcp 语义。
    mcpAllow: Array.isArray(member.mcpAllow) ? member.mcpAllow : [],
    model: member.model || null,
    approvalMode: member.approvalMode || null,
    sandboxPolicy: member.sandboxPolicy || null,
    skillNames: Array.isArray(member.skillNames) ? member.skillNames : [],
  };
}

/** 按 ownerMemberId 从名册定位成员（名册为 run 级快照或实时名册，由调用方决定）。 */
function findRosterMember(roster, memberId) {
  if (!memberId || !Array.isArray(roster)) return null;
  return roster.find((m) => m && m.id === memberId) || null;
}

/**
 * Worker 通道用的一次性入口：按任务认领成员，把该成员的 per-bot 配置应用到引擎参数上。
 *
 * 设计要点：
 *   · **未认领 / 无名册 / 反查异常 → 空操作**。非军团路径必须与第八轮之前逐字节等价
 *     （这是「零回归」的判定标准，不是「大致一样」）。
 *   · 名册反查失败只 warn 并降级为「公共 Worker 身份」，绝不失败整个任务。
 *   · 治理档只会更严（applyRolePreset 内部保证），因此调用顺序可以安全地放在最后。
 *
 * @param {object} engineParams workerPool 的 runOpts
 * @param {{group?:object, task?:object, deps?:object}} ctx
 * @returns {object} 同一个 engineParams
 */
function applyMemberRuntimeConfig(engineParams, ctx = {}) {
  const { group, task, deps = {} } = ctx;
  const memberId = task?.ownerMemberId || '';
  if (!memberId) return engineParams;

  let roster = null;
  try {
    roster = typeof deps.resolveTeamRoster === 'function' ? deps.resolveTeamRoster(group) : null;
  } catch (e) {
    console.warn('[rolePreset] 成员配置反查失败（按公共 Worker 身份运行）:', e.message);
    return engineParams;
  }
  const member = findRosterMember(roster, memberId);
  if (!member) return engineParams;

  return applyRolePreset(engineParams, rolePresetFromMember(member), {
    resolveModelRef: deps.resolveModelRef,
    loadSkillContents: deps.loadSkillContents,
  }, `task=${task?.taskId || ''} member=${member.id}`);
}

module.exports = { applyRolePreset, applyMemberRuntimeConfig, rolePresetFromMember, findRosterMember };
