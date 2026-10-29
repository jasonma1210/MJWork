// M5 / T5-1：MJ 军团团队层——团队编制持久化（设计稿 v1.1 §5 表 1 / 表 2）
//
// 职责边界（为什么单独一个 Store，而不是塞进 taskStore）：
//   · taskStore 管「一次派活的执行队列」（group/subtask 状态机），生命周期短、run 内闭环；
//   · TeamStore 管「团队编制」（谁能干、什么权限、谁是统筹），生命周期长、跨 run 复用；
//   两者是不同生命周期的实体，混在一个类里会让状态机互相污染（编制定义被 run 状态牵连）。
//
// 单一事实来源（本文件的几处「唯一判据」，别处不得重复判断）：
//   · 缺统筹 = `teams.lead_member_id IS NULL`；对外只经 leadMissing() 暴露，禁止在 IPC/UI 里另写判断；
//   · 枚举值域 fail-closed：非法值一律回落到最保守默认，绝不透传未知值（角色/权限只能收紧）；
//   · 抽象工具名 → 引擎具体工具名映射复用 ecosystem.ROLE_TOOL_ALIASES（T4-3 的同一份字典），
//     不在此另维护第二份别名表；未知抽象名直接丢弃（角色只裁剪工具，绝不发明工具）。
//
// T5-1 只落 teams / team_members 两表；team_messages / team_turns 属 T5-2，
// 看板任务扩展列属 T5-3，编制快照属 T5-9（届时给 group 加 JSON 列即可，无返工）。
const crypto = require('crypto');
const { ROLE_TOOL_ALIASES, ROLE_APPROVAL_MAP } = require('./ecosystem');
// T5-7：成员模型绑定引用串的编解码（单一事实来源 = main/modelShape.js）
const { canonicalizeModelRef } = require('./modelShape');

// ── 枚举值域（fail-closed 归一的唯一定义处）──
const TEAM_MODES = ['lead', 'select'];
const ROLE_KINDS = ['lead', 'member'];
const MEMBER_SOURCES = ['template', 'custom'];
const MEMBER_STATES = ['idle', 'busy', 'waiting', 'offline'];
// 沙箱三档与 main/ecosystem.js 的 VALID_SANDBOX / main/sandbox.js 同值
const SANDBOX_POLICIES = ['read-only', 'workspace-write', 'full-access'];
// 审批四档由 ecosystem.ROLE_APPROVAL_MAP 的值集合派生（同源派生，避免第二份表漂移）
const APPROVAL_MODES = [...new Set(Object.values(ROLE_APPROVAL_MAP))];

// ── 字段边界（防一次脚本把编制刷爆；数值对齐既有实现，不放大攻击面）──
const TEAM_NAME_MAX = 60;
const TEAM_DESC_MAX = 500;
const MEMBER_NAME_MAX = 40;
// 与 main/ipc/ecosystem.js 的 SYSTEM_PROMPT_MAX / agent-core 对 system_prompt 的 slice 同值
const SYSTEM_PROMPT_MAX = 12000;
// 成员上限（2026-10-20 需求③）：按用户要求放宽到 20——编制是「可招募名录」，
// 允许多备选；每次派活仍由调度按 worker 并发上限排队执行，编制规模不改变并发事实。
const MAX_MEMBERS_PER_TEAM = 20;

// ── 消息总线边界（T5-2，§5 表 3 / G4 上下文隔离）──
// kind 值域与设计稿逐字一致；fail-closed：未知 kind 回落 'system'（最保守，不发明新类型）
const MESSAGE_KINDS = ['assign', 'handoff', 'question', 'report', 'artifact_ref', 'system'];
// 摘要硬上限（字符）：面向模型的部分不能无限膨胀——这是 G4 的第一道闸
const MESSAGE_SUMMARY_MAX = 600;
// summary + payload 合计体积上限（UTF-8 字节）：第二道闸，超限 ⇒ 拒绝原始体积、回落 refs-only
const MESSAGE_TOTAL_MAX = 4000;
// 单条消息引用条目上限 / 单条引用长度上限（refs 只传「引用」不传内容）
const MESSAGE_REFS_MAX = 20;
const MESSAGE_REF_MAX = 512;
// B-14 收口（2026-10-21）：团队消息的**容量闸 + 保留期**。
// 此前只有单条 4000B 体积闸，全库无 DELETE / 清理任务 ⇒ 长会话下 team_messages 无界增长。
//   · 每个团队保留最近 1000 条（看板/轨迹只回看最近 50 次派活、800 条消息，1000 足够覆盖）；
//   · 超过 30 天的消息在每次追加时顺带清理（无需独立定时器，写入即维护）。
// 注意：seq 单调性不受影响（删旧不删新；MAX(seq) 仍只增）。
const TEAM_MESSAGES_MAX_PER_TEAM = 1000;
const TEAM_MESSAGES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 无 run 归属的旁路广播（团队生命周期系统消息）用空串 run_id；派活消息一律带真实 run_id
const SYSTEM_RUN_ID = '';

// ── T5-4：统筹负责人（Lead）默认模板（§6 F1「一键创建 Lead 预填统筹角色的默认提示词模板」）──
// 为什么把模板放在 Store 层而不是 IPC 层：createLead 是本模块的写入口，模板是「该成员长什么样」的
// 一部分；若放在 IPC 层，则「通过 IPC 创建」与「直接调用 store 创建」两条路径的 Lead 会不一致
//（典型漂移：测试里 store.createLead 产出的 Lead 没有提示词，功能形同虚设）。
const LEAD_DEFAULT_NAME = '统筹负责人';
// 统筹的职责是「拆解 / 指派 / 汇总」，不替成员干具体子任务，故默认只授予读类工具 + 汇总写盘能力。
// 抽象名走 mapToolAliases（复用 T4-3 的 ROLE_TOOL_ALIASES 单一字典）映射为引擎具体工具名。
const LEAD_DEFAULT_TOOLS = ['read', 'grep', 'glob', 'write'];
const LEAD_SYSTEM_PROMPT = [
  '你是 MJ Coder 军团的统筹负责人（Lead）。在一次团队任务中，你负责：把用户目标拆解为可独立执行的'
    + '子任务、按成员能力指派、协调跨成员依赖，并在收尾时汇总各成员的产出与结论。',
  '职责边界：',
  '1. 只做拆解、指派与汇总，不替成员完成具体子任务；',
  '2. 指派时按成员的工具权限与角色描述选择最匹配者，不要让成员干超出其授权范围的事；',
  '3. 需要跨成员等待时，显式声明任务间的依赖关系，避免并行等待造成的死锁；',
  '4. 汇总时只引用各成员的结论与产物路径，不重复执行已完成的子任务。',
].join('\n');

function byteLen(s) {
  return s == null ? 0 : Buffer.byteLength(String(s), 'utf8');
}

// ── 预算默认值（G2 双终止条件的团队级缺省；派活时 T5-4 传入的 run 级预算可覆盖）──
// 团队级 budget_json 本身可空（F2 的「预算上限」是派活时必填项，团队级只是默认值底座）。
const BUDGET_DEFAULTS = { max_rounds: 8, max_tokens: 256000, max_wall_ms: 30 * 60 * 1000 };
const BUDGET_LIMITS = {
  max_rounds: [1, 50],
  max_tokens: [1000, 2000000],
  max_wall_ms: [1000, 24 * 60 * 60 * 1000],
};

// 引擎具体工具名集合（ROLE_TOOL_ALIASES 的值域）——用于「已是具体名也保留」的反向识别
const CONCRETE_TOOL_NAMES = new Set(Object.values(ROLE_TOOL_ALIASES).flat());

function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function clampInt(v, [min, max], fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function trimStr(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

/**
 * 预算归一（G2 载体）：三键都是正整数并在硬区间内，越界夹紧；非法/缺失回落默认值。
 * 传 null/undefined 表示「未设置团队级预算」→ 返回 null（不发明默认，交由派活层必填校验）。
 */
function normalizeBudget(input) {
  if (input == null || typeof input !== 'object') return null;
  const out = {};
  for (const key of Object.keys(BUDGET_DEFAULTS)) {
    out[key] = clampInt(input[key], BUDGET_LIMITS[key], BUDGET_DEFAULTS[key]);
  }
  return out;
}

/**
 * 抽象工具名 → 引擎具体工具名（复用 T4-3 的 ROLE_TOOL_ALIASES 单一字典）。
 * fail-closed：未知抽象名丢弃；已是具体工具名的条目原样保留（AI 草稿可能直接给具体名）。
 * 去重后返回。
 */
function mapToolAliases(names) {
  const list = Array.isArray(names) ? names : [];
  const out = new Set();
  for (const n of list) {
    const key = String(n == null ? '' : n).trim();
    if (!key) continue;
    const mapped = ROLE_TOOL_ALIASES[key];
    if (mapped) { for (const t of mapped) out.add(t); continue; }
    if (CONCRETE_TOOL_NAMES.has(key)) out.add(key);
  }
  return [...out];
}

/** 缺统筹的**唯一判据**：lead_member_id IS NULL。别处不得重复判断。 */
function leadMissing(team) {
  if (!team) return true;
  return !team.leadMemberId;
}

/**
 * 派活前的强校验（**唯一判据处**，§11 T5-4 / §6 F1）。
 * 校验**只在派活时**触发——列表常驻提示会造成持续报错焦虑（§6 F1 调整点①）。
 * 返回 { ok, code }；code 供调用方（IPC / 渲染层）决定是否弹「一键创建统筹负责人」。
 */
function dispatchGate(team) {
  if (!team) return { ok: false, code: 'TEAM_NOT_FOUND' };
  if (team.archivedAt) return { ok: false, code: 'TEAM_ARCHIVED' };
  if (leadMissing(team)) return { ok: false, code: 'LEAD_MISSING' };
  return { ok: true, code: null };
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function assertId(raw, label) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error(`${label} 必填`);
  return s;
}

function rowToTeam(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    projectPath: r.project_path,
    leadMemberId: r.lead_member_id,
    defaultMode: r.default_mode,
    budget: safeParse(r.budget_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

function rowToMember(r) {
  return {
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    avatar: r.avatar,
    roleKind: r.role_kind,
    source: r.source,
    templateRef: r.template_ref,
    systemPrompt: r.system_prompt,
    toolNames: safeParse(r.tool_names_json) || [],
    allowMcp: !!r.allow_mcp,
    mcpAllow: safeParse(r.mcp_allow_json) || [],
    model: r.model,
    approvalMode: r.approval_mode,
    sandboxPolicy: r.sandbox_policy,
    skillNames: safeParse(r.skill_names_json) || [],
    state: r.state,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    removedAt: r.removed_at,
  };
}

function rowToMessage(r) {
  return {
    id: r.id,
    teamId: r.team_id,
    runId: r.run_id,
    seq: r.seq,
    fromMemberId: r.from_member_id,
    toMemberId: r.to_member_id,
    kind: r.kind,
    summary: r.summary,
    refs: safeParse(r.refs_json) || [],
    payload: safeParse(r.payload_json),
    createdAt: r.created_at,
  };
}

/**
 * 产物引用归一：只保留字符串条目、去空、限长限条数。
 * refs 的语义是「引用」而非内容——文件路径 / artifact id / 任务 id，绝不夹带上下文正文。
 */
function normalizeRefs(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s) continue;
    out.push(trimStr(s, MESSAGE_REF_MAX));
    if (out.length >= MESSAGE_REFS_MAX) break;
  }
  return out;
}

/**
 * 成员入参归一（fail-closed）。**唯一的成员字段清洗处**：
 * addMember 与 updateMember 都经此，保证两条路径的枚举语义永远一致。
 * patch 模式下仅覆盖显式给出的键（undefined 表示不改）。
 */
function normalizeMemberInput(input = {}, { patch = false } = {}) {
  const src = input || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
  const out = {};

  if (!patch || has('name')) {
    out.name = trimStr(src.name, MEMBER_NAME_MAX).trim();
  }
  if (!patch || has('avatar')) {
    out.avatar = src.avatar == null || src.avatar === '' ? null : trimStr(src.avatar, 512);
  }
  if (!patch || has('roleKind')) {
    out.roleKind = oneOf(src.roleKind, ROLE_KINDS, 'member');
  }
  if (!patch || has('source')) {
    out.source = oneOf(src.source, MEMBER_SOURCES, 'custom');
  }
  if (!patch || has('templateRef')) {
    out.templateRef = src.templateRef == null || src.templateRef === ''
      ? null : trimStr(src.templateRef, 128).trim();
  }
  if (!patch || has('systemPrompt')) {
    out.systemPrompt = trimStr(src.systemPrompt, SYSTEM_PROMPT_MAX);
  }
  if (!patch || has('toolNames') || has('tools')) {
    out.toolNames = mapToolAliases(has('toolNames') ? src.toolNames : src.tools);
  }
  if (!patch || has('allowMcp')) {
    // 最小权限语义：缺省 false（只有显式 true 才放开 MCP）
    out.allowMcp = src.allowMcp === true;
  }
  if (!patch || has('mcpAllow')) {
    // P1-4：MCP 服务器/工具白名单。此处只做**形状**清洗（去空/限长/去重/限条数）；
    // 语义匹配（服务名可能经 encodeServerSegment 编码）在 shared/mcpAllow.mjs 的
    // narrowToolsByMcpAllow 里做——存储层不复制一份前缀判断，避免两处口径漂移。
    out.mcpAllow = [...new Set((Array.isArray(src.mcpAllow) ? src.mcpAllow : [])
      .map((s) => trimStr(s, 128).trim()).filter(Boolean))].slice(0, 64);
  }
  if (!patch || has('model')) {
    // T5-7：成员模型绑定存 canonical 引用串（`providerId::modelId`）；解析不出的输入一律落 null
    //（= 用默认模型）。canonical 化只有 modelShape.canonicalizeModelRef 一个判据，此处不重复解释格式。
    out.model = canonicalizeModelRef(src.model);
  }
  if (!patch || has('approvalMode') || has('approvalPolicy')) {
    const v = has('approvalMode') ? src.approvalMode : src.approvalPolicy;
    out.approvalMode = ROLE_APPROVAL_MAP[v] || oneOf(v, APPROVAL_MODES, 'on-request');
  }
  if (!patch || has('sandboxPolicy')) {
    out.sandboxPolicy = oneOf(src.sandboxPolicy, SANDBOX_POLICIES, 'workspace-write');
  }
  if (!patch || has('skillNames')) {
    out.skillNames = (Array.isArray(src.skillNames) ? src.skillNames : [])
      .map((s) => trimStr(s, 128).trim()).filter(Boolean);
  }
  if (!patch || has('state')) {
    out.state = oneOf(src.state, MEMBER_STATES, 'idle');
  }
  return out;
}

class TeamStore {
  constructor(db) {
    this.db = db;
  }

  now() { return Date.now(); }

  // ── 团队 ──

  /**
   * 建团队：name + description 必填（description 是主管装配上下文的第一要素，§5 表 1）。
   * project_path **可选**（2026-10-20 用户反馈修正）：军团是跨项目复用的编制，不强制绑定项目；
   * 留空 = 全局团队（任意项目/会话都能在 `+` → 军团里看到并派活），非空时仅作派活默认工作目录。
   */
  createTeam({ name, description, projectPath, defaultMode, budget } = {}) {
    const nm = trimStr(name, TEAM_NAME_MAX).trim();
    if (!nm) throw new Error('团队名称必填');
    const desc = trimStr(description, TEAM_DESC_MAX).trim();
    if (!desc) throw new Error('团队目标/职责必填（一句话，作为统筹装配上下文）');
    const proj = trimStr(projectPath, 1024).trim(); // 允许空串 = 不绑定项目

    const id = newId('team');
    const now = this.now();
    this.db.prepare(`INSERT INTO teams
      (id, name, description, project_path, lead_member_id, default_mode, budget_json, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`)
      .run(id, nm, desc, proj,
        oneOf(defaultMode, TEAM_MODES, 'lead'),
        JSON.stringify(normalizeBudget(budget)), now, now);
    return this.getTeam(id);
  }

  getTeam(id) {
    const r = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(String(id));
    if (!r) return null;
    const team = rowToTeam(r);
    team.leadMissing = leadMissing(team);
    team.members = this.listMembers(r.id);
    return team;
  }

  /**
   * 列表：**全局可见**（2026-10-20 用户反馈修正，原 D1「按项目归属过滤」已废弃）——
   * 军团是跨项目复用的编制，不按 project_path 过滤，任意项目/会话看到的都是同一份列表；
   * 默认不含已归档团队，includeArchived=true 时含归档（供「取消归档」入口展示）。
   */
  listTeams({ includeArchived = false } = {}) {
    const where = [];
    const params = [];
    if (!includeArchived) where.push('archived_at IS NULL');
    const sql = `SELECT * FROM teams${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => {
      const team = rowToTeam(r);
      const members = this.listMembers(r.id);
      return {
        ...team,
        leadMissing: leadMissing(team),
        memberCount: members.length,
        members,
      };
    });
  }

  /** 更新团队：仅 name/description/defaultMode/budget 可改（lead 走 setLead，不在此） */
  updateTeam(id, patch = {}) {
    const team = this.getTeam(id);
    if (!team) throw new Error(`团队不存在：${id}`);
    const sets = [];
    const params = [];
    if (patch.name !== undefined) {
      const nm = trimStr(patch.name, TEAM_NAME_MAX).trim();
      if (!nm) throw new Error('团队名称必填');
      sets.push('name = ?'); params.push(nm);
    }
    if (patch.description !== undefined) {
      const desc = trimStr(patch.description, TEAM_DESC_MAX).trim();
      if (!desc) throw new Error('团队目标/职责必填');
      sets.push('description = ?'); params.push(desc);
    }
    if (patch.defaultMode !== undefined) {
      sets.push('default_mode = ?'); params.push(oneOf(patch.defaultMode, TEAM_MODES, 'lead'));
    }
    if (patch.budget !== undefined) {
      sets.push('budget_json = ?'); params.push(JSON.stringify(normalizeBudget(patch.budget)));
    }
    if (sets.length === 0) return team;
    sets.push('updated_at = ?'); params.push(this.now());
    params.push(String(id));
    this.db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getTeam(id);
  }

  /** 归档（不物理删，§5 表 1） */
  setTeamArchived(id, archived = true) {
    const exists = this.db.prepare('SELECT id FROM teams WHERE id = ?').get(String(id));
    if (!exists) throw new Error(`团队不存在：${id}`);
    this.db.prepare('UPDATE teams SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archived ? this.now() : null, this.now(), String(id));
    return this.getTeam(id);
  }

  /**
   * 物理删除团队（含成员与消息总线）——**仅用于项目初始化失败补偿**（T6-9）。
   * 团队一经正常创建即永久保留（无归档/无删除入口），故本方法不暴露给 IPC / 界面。
   * 删除顺序：先清引用方（messages / members），最后删 teams 行，避免留下一半编制。
   */
  deleteTeam(id) {
    const tid = String(id || '').trim();
    if (!tid) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM team_messages WHERE team_id = ?').run(tid);
      this.db.prepare('DELETE FROM team_members WHERE team_id = ?').run(tid);
      return this.db.prepare('DELETE FROM teams WHERE id = ?').run(tid).changes;
    });
    return !!tx();
  }

  // ── 成员（编制）──

  listMembers(teamId, { includeDisabled = false } = {}) {
    const sql = `SELECT * FROM team_members WHERE team_id = ?${includeDisabled ? '' : ' AND enabled = 1'} ORDER BY created_at ASC`;
    return this.db.prepare(sql).all(String(teamId)).map(rowToMember);
  }

  getMember(teamId, memberId) {
    const r = this.db.prepare('SELECT * FROM team_members WHERE team_id = ? AND id = ?').get(String(teamId), String(memberId));
    return r ? rowToMember(r) : null;
  }

  /**
   * 加成员（招募 template / 自定义 custom 走同一张表同一入口，D3）。
   * roleKind='lead' 时同步把 lead_member_id 指向它（保证「缺统筹」单一判据始终自洽）。
   */
  addMember(teamId, input = {}) {
    const team = this.getTeam(teamId);
    if (!team) throw new Error(`团队不存在：${teamId}`);
    if (team.archivedAt) throw new Error('团队已归档，不能再添加成员');

    const m = normalizeMemberInput(input);
    if (!m.name) throw new Error('成员名称必填');

    const enabled = this.db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND enabled = 1').get(String(teamId)).n;
    if (enabled >= MAX_MEMBERS_PER_TEAM) {
      throw new Error(`团队成员数已达上限 ${MAX_MEMBERS_PER_TEAM}`);
    }

    const id = newId('mbr');
    this.db.prepare(`INSERT INTO team_members
      (id, team_id, name, avatar, role_kind, source, template_ref, system_prompt, tool_names_json,
       allow_mcp, mcp_allow_json, model, approval_mode, sandbox_policy, skill_names_json, state, enabled, created_at, removed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`)
      .run(id, String(teamId), m.name, m.avatar, m.roleKind, m.source, m.templateRef, m.systemPrompt,
        JSON.stringify(m.toolNames), m.allowMcp ? 1 : 0, JSON.stringify(m.mcpAllow),
        m.model, m.approvalMode, m.sandboxPolicy,
        JSON.stringify(m.skillNames), m.state, this.now());

    if (m.roleKind === 'lead') this.setLead(teamId, id);
    else this.touchTeam(teamId);
    return this.getMember(teamId, id);
  }

  /** 改配置：与 addMember 共用 normalizeMemberInput，枚举语义永远一致 */
  updateMember(teamId, memberId, patch = {}) {
    const member = this.getMember(teamId, memberId);
    if (!member) throw new Error(`成员不存在：${teamId}/${memberId}`);
    const m = normalizeMemberInput(patch, { patch: true });
    const sets = [];
    const params = [];
    const col = {
      name: 'name', avatar: 'avatar', roleKind: 'role_kind', source: 'source', templateRef: 'template_ref',
      systemPrompt: 'system_prompt', toolNames: 'tool_names_json', allowMcp: 'allow_mcp', model: 'model',
      mcpAllow: 'mcp_allow_json',
      approvalMode: 'approval_mode', sandboxPolicy: 'sandbox_policy', skillNames: 'skill_names_json', state: 'state',
    };
    for (const [key, colName] of Object.entries(col)) {
      if (!(key in m)) continue;
      let v = m[key];
      if (key === 'toolNames' || key === 'skillNames' || key === 'mcpAllow') v = JSON.stringify(v);
      else if (key === 'allowMcp') v = v ? 1 : 0;
      sets.push(`${colName} = ?`); params.push(v);
    }
    if (sets.length === 0) return member;

    const tx = this.db.transaction(() => {
      params.push(String(memberId));
      this.db.prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      // roleKind 变更需与 lead_member_id 保持自洽（单一判据）
      if (m.roleKind === 'lead') {
        this._setLeadInternal(teamId, memberId);
      } else if (m.roleKind === 'member' && this.getTeam(teamId)?.leadMemberId === memberId) {
        // 2026-10-28：统筹被改任普通成员 ⇒ 自动移交（同下架，团队务必有负责人）
        this._transferLeadFrom(teamId, String(memberId));
      }
      this.touchTeam(teamId);
    });
    tx();
    return this.getMember(teamId, memberId);
  }

  /**
   * 上/下架（可插拔，不物理删）：下架 Lead 会**自动把统筹移交给其他在册成员**（2026-10-28，
   * 「团队务必有负责人」不变式）；仅当无其他在册成员时才清空 lead_member_id → 缺统筹。
   */
  setMemberEnabled(teamId, memberId, enabled) {
    const member = this.getMember(teamId, memberId);
    if (!member) throw new Error(`成员不存在：${teamId}/${memberId}`);
    const on = enabled !== false;
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE team_members SET enabled = ?, removed_at = ? WHERE id = ?')
        .run(on ? 1 : 0, on ? null : this.now(), String(memberId));
      if (!on && this.getTeam(teamId)?.leadMemberId === memberId) {
        // 2026-10-28：下架统筹 ⇒ 自动移交给其他在册成员（团队务必有负责人），不再清成缺统筹
        this._transferLeadFrom(teamId, String(memberId));
      }
      this.touchTeam(teamId);
    });
    tx();
    return this.getMember(teamId, memberId);
  }

  /**
   * 成员下架（T5-1 语义 = 软删：enabled=0 + removed_at）。
   * 物理删规则（仅从未参与过 run 的成员可物理删）由 T5-9 收紧，本阶段不做不可逆删除。
   */
  removeMember(teamId, memberId) {
    return this.setMemberEnabled(teamId, memberId, false);
  }

  /**
   * P0-2（2026-10-29）：驱动成员运行期状态机（idle/busy/waiting/offline）。
   * 此前 `team_members.state` 仅由 `updateMember` 经 API 手填，引擎从不写入、UI 亦不读取，形同死字段。
   * 现由 `workerPool.runWorkerTask`（任务开始/等待/完成）与 `teamControl.resetMemberSession`（重置→offline）
   * 调用本方法，使 FSM 真正流转。memberId 是 `team_members` 主键（newId('mbr')），按 id 直更，无需 teamId。
   * 非法值经 `oneOf` 回落 'idle'（fail-closed，不放大未知状态）。
   */
  setMemberState(memberId, state) {
    const normalized = oneOf(state, MEMBER_STATES, 'idle');
    this.db.prepare('UPDATE team_members SET state = ? WHERE id = ?').run(normalized, String(memberId));
    return normalized;
  }

  /** 指定统筹负责人：原 lead 降级为 member，lead_member_id 指向新 lead（单一判据落点） */
  setLead(teamId, memberId) {
    const tx = this.db.transaction(() => { this._setLeadInternal(teamId, memberId); this.touchTeam(teamId); });
    tx();
    return this.getTeam(teamId);
  }

  _setLeadInternal(teamId, memberId) {
    // 唯一的「成为统筹」写入口（setLead / updateMember / addMember / 自动移交都经此），故
    // 「已下架成员不能当统筹」钉在这里，不在四个调用点各抄一遍。2026-10-29 修：此前只有
    // setLead 判 enabled，updateMember 走本函数时绕过 → 已下架成员可变成 lead，lead_member_id
    // 指向它且 leadMissing=false（团队看似有负责人、实际没有，而 leadMissing 是「缺统筹」的唯一判据）。
    const m = this.getMember(teamId, memberId);
    if (!m || !m.enabled) throw new Error(m ? '不能指定已下架成员为统筹负责人' : `成员不存在：${teamId}/${memberId}`);
    const prev = this.getTeam(teamId)?.leadMemberId;
    if (prev && prev !== memberId) {
      this.db.prepare(`UPDATE team_members SET role_kind = 'member' WHERE id = ?`).run(String(prev));
    }
    this.db.prepare(`UPDATE team_members SET role_kind = 'lead' WHERE id = ?`).run(String(memberId));
    this.db.prepare('UPDATE teams SET lead_member_id = ?, updated_at = ? WHERE id = ?')
      .run(String(memberId), this.now(), String(teamId));
  }

  /**
   * 统筹自动移交（2026-10-28 用户裁决：「一般团队务必有个负责人一样的角色在」）：
   *   现任统筹被下架 / 改任普通成员时，**自动移交给第一个其他在册成员**（按入库序），
   *   而不是清成「缺统筹」破态；仅当没有其他在册成员时才清空 lead_member_id。
   *   换任语义本就支持直接换（setLead 原统筹自动降级），无需先「退出统筹」。
   * @returns {boolean} true = 已移交；false = 无其他在册成员（团队清空统筹）
   */
  _transferLeadFrom(teamId, fromMemberId) {
    const next = this.db.prepare(
      'SELECT id FROM team_members WHERE team_id = ? AND id != ? AND enabled = 1 ORDER BY created_at ASC, id ASC LIMIT 1',
    ).get(String(teamId), String(fromMemberId));
    if (next && next.id) {
      this._setLeadInternal(teamId, String(next.id));
      return true;
    }
    this.db.prepare('UPDATE teams SET lead_member_id = NULL, updated_at = ? WHERE id = ?')
      .run(this.now(), String(teamId));
    return false;
  }

  /**
   * T5-4：「一键创建统筹负责人」（§6 F1）——预填统筹角色的默认提示词模板，落一条 roleKind='lead' 的成员。
   * 复用 addMember 的同一条写路径（含成员上限校验、lead_member_id 自洽、normalizeMemberInput 单点归一），
   * 不另开第二条插入 SQL——否则枚举语义会与招募/自定义两条路径漂移。
   *
   * 语义边界：只在**缺统筹**时可用（「一键创建」= 补缺口）。已有 Lead 时再建会与之冲突，
   * 应走「设为统筹」（setLead）换人；故此处直接拒绝，保证「缺统筹」单一判据始终自洽。
   */
  createLead(teamId, { name, model } = {}) {
    const team = this.getTeam(teamId);
    if (!team) throw new Error(`团队不存在：${teamId}`);
    if (team.archivedAt) throw new Error('团队已归档，不能创建统筹负责人');
    if (!leadMissing(team)) throw new Error('团队已有统筹负责人（如需更换请使用「设为统筹」）');

    return this.addMember(teamId, {
      name: (name && String(name).trim()) || LEAD_DEFAULT_NAME,
      roleKind: 'lead',
      source: 'custom',
      templateRef: null,
      systemPrompt: LEAD_SYSTEM_PROMPT,
      toolNames: LEAD_DEFAULT_TOOLS,
      allowMcp: false,
      model: model || null,
      approvalMode: 'on-request',
      sandboxPolicy: 'workspace-write',
      skillNames: [],
    });
  }

  // ── 消息总线（T5-2，§5 表 3）──

  /**
   * 写入一条总线消息。**唯一的消息写入入口**（G4 写入闸也在此，别处不得另做体积判断）。
   *
   * 三条硬语义：
   *   ① run 隔离：run_id 为空串 = 无 run 归属的旁路广播，不进任何 run 的注入；
   *   ② seq 单调：团队内自增（跨 run 亦单调），渲染与注入顺序的单一事实源；
   *   ③ 只传摘要与引用：超限（summary > 硬上限 或 summary+payload > 体积上限）
   *      ⇒ **拒绝写入原始体积，回落 refs-only**（丢弃 payload、截断 summary），
   *      并通过返回值 gated/reason 让宿主落一条审计。
   *
   * @returns {{message: object, gated: boolean, reason: string|null}}
   */
  appendMessage(input = {}) {
    const teamId = String(input.teamId == null ? '' : input.teamId).trim();
    if (!teamId) throw new Error('消息 team_id 必填');
    if (!this.db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)) {
      throw new Error(`团队不存在：${teamId}`);
    }

    const runId = trimStr(input.runId == null ? '' : input.runId, 128).trim();
    const kind = oneOf(input.kind, MESSAGE_KINDS, 'system');
    const fromMemberId = input.fromMemberId == null || input.fromMemberId === ''
      ? null : trimStr(input.fromMemberId, 128).trim();
    const toMemberId = input.toMemberId == null || input.toMemberId === ''
      ? null : trimStr(input.toMemberId, 128).trim();
    const refs = normalizeRefs(input.refs);

    // G4 体积校验（在原始体积上判，再决定是否截断——顺序颠倒会把闸门做成摆设）
    const rawSummary = String(input.summary == null ? '' : input.summary);
    let payloadJson = null;
    if (input.payload != null) {
      try { payloadJson = JSON.stringify(input.payload); } catch { payloadJson = null; }
    }
    const summaryBytes = byteLen(rawSummary);
    const payloadBytes = byteLen(payloadJson);
    const gated = summaryBytes > MESSAGE_SUMMARY_MAX
      || summaryBytes + payloadBytes > MESSAGE_TOTAL_MAX;

    const summary = trimStr(rawSummary, MESSAGE_SUMMARY_MAX);
    if (gated) payloadJson = null; // 回落 refs-only：只留摘要（已截断）+ 引用
    const reason = gated
      ? `体积超限回落 refs-only：summary=${summaryBytes}B payload=${payloadBytes}B `
        + `（阈值 summary≤${MESSAGE_SUMMARY_MAX} 字符、合计≤${MESSAGE_TOTAL_MAX}B）`
      : null;

    const id = newId('msg');
    // 序号自增与插入同临界区：并发追加时不会出现两条消息拿到同一个 seq
    this.db.transaction(() => {
      const seq = Number(this.db.prepare('SELECT MAX(seq) AS n FROM team_messages WHERE team_id = ?')
        .get(teamId)?.n) || 0;
      this.db.prepare(`INSERT INTO team_messages
        (id, team_id, run_id, seq, from_member_id, to_member_id, kind, summary, refs_json, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, teamId, runId, seq + 1, fromMemberId, toMemberId, kind, summary,
          JSON.stringify(refs), payloadJson, this.now());
      // B-14：写入即维护——先按保留期清理过期消息，再按容量淘汰最旧（seq 升序）。
      this.db.prepare('DELETE FROM team_messages WHERE team_id = ? AND created_at < ?')
        .run(teamId, this.now() - TEAM_MESSAGES_TTL_MS);
      this.db.prepare(`DELETE FROM team_messages WHERE team_id = ? AND id NOT IN (
        SELECT id FROM team_messages WHERE team_id = ? ORDER BY seq DESC LIMIT ?
      )`).run(teamId, teamId, TEAM_MESSAGES_MAX_PER_TEAM);
    })();

    return { message: this.getMessage(id), gated, reason };
  }

  getMessage(id) {
    const r = this.db.prepare('SELECT * FROM team_messages WHERE id = ?').get(String(id));
    return r ? rowToMessage(r) : null;
  }

  /**
   * 消息查询：渲染时间轴与模型注入共用的读入口。
   * 默认按 seq 升序（顺序的单一事实源）；给定 runId 时按 run 过滤（run 隔离）；
   * afterSeq 用于增量拉取（只取比游标新的消息，避免重复渲染）。
   */
  listMessages({ teamId, runId, afterSeq, limit } = {}) {
    const t = String(teamId == null ? '' : teamId).trim();
    if (!t) throw new Error('消息 team_id 必填');
    const where = ['team_id = ?'];
    const params = [t];
    if (runId != null && runId !== '') { where.push('run_id = ?'); params.push(String(runId)); }
    if (Number.isFinite(Number(afterSeq))) { where.push('seq > ?'); params.push(Math.trunc(Number(afterSeq))); }
    params.push(clampInt(limit, [1, 2000], 200));
    return this.db.prepare(
      `SELECT * FROM team_messages WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
    ).all(...params).map(rowToMessage);
  }

  /**
   * M5 / T5-6：按 run 批量读消息（对话内团队事件流的唯一读入口）。
   *
   * 为什么需要「批量」而不是逐个 run 调 listMessages：
   *   一个会话可能派过多次活，逐个 run 查询是 N 次全表扫描 + N 次 IPC 往返；
   *   这里用一条 `run_id IN (...)` 拿回本会话的全部团队消息，渲染层再按 seq 投影分组。
   * runIds 为空返回空数组（fail-open：没有 run 就没有事件，不报错）。
   * limit 只限制返回总量，排序仍是 seq 升序（顺序的单一事实来源）。
   */
  listMessagesByRuns(runIds, { limit } = {}) {
    const ids = [...new Set((Array.isArray(runIds) ? runIds : [])
      .map((v) => String(v == null ? '' : v).trim())
      .filter(Boolean))].slice(0, 100);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM team_messages WHERE run_id IN (${placeholders}) ORDER BY seq ASC LIMIT ?`,
    ).all(...ids, clampInt(limit, [1, 2000], 800)).map(rowToMessage);
  }

  touchTeam(teamId) {
    this.db.prepare('UPDATE teams SET updated_at = ? WHERE id = ?').run(this.now(), String(teamId));
  }

  /**
   * M5 / T5-5：按 run 反查团队（团队 ↔ run 的唯一事实来源 = team_messages.run_id，dispatch 时
   * 以 run_id = groupId 落库）。运行期 Worker 只拿得到 groupId，需要据此找回团队归属（teamId /
   * 归档态 / 成员），才能把子任务结论正确写入「团队记忆」归属键。
   * 返回完整 team（含 members / archivedAt）；无对应团队返回 null。
   */
  findTeamByRun(runId) {
    const r = String(runId == null ? '' : runId).trim();
    if (!r) return null;
    const row = this.db.prepare('SELECT team_id FROM team_messages WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(r);
    if (!row) return null;
    return this.getTeam(row.team_id);
  }

  /**
   * M5 / T5-12：某 run 的最新消息序号（探活「三通道无变化」判据的第二通道）。
   * 探活需要「这一拍里团队总线有没有新消息」这一事实，而 listMessages 是分页读（拿最大值要全表扫）；
   * 这里给一条 O(1) 的聚合读，避免每 5 秒把整段 run 消息拉一遍。
   */
  latestSeqForRun(runId) {
    const r = String(runId == null ? '' : runId).trim();
    if (!r) return 0;
    const n = Number(this.db.prepare('SELECT MAX(seq) AS n FROM team_messages WHERE run_id = ?').get(r)?.n);
    return Number.isFinite(n) ? n : 0;
  }
}

module.exports = {
  TeamStore,
  TEAM_MODES,
  ROLE_KINDS,
  MEMBER_SOURCES,
  MEMBER_STATES,
  SANDBOX_POLICIES,
  APPROVAL_MODES,
  BUDGET_DEFAULTS,
  BUDGET_LIMITS,
  MAX_MEMBERS_PER_TEAM,
  TEAM_NAME_MAX,
  TEAM_DESC_MAX,
  MEMBER_NAME_MAX,
  SYSTEM_PROMPT_MAX,
  MESSAGE_KINDS,
  MESSAGE_SUMMARY_MAX,
  MESSAGE_TOTAL_MAX,
  MESSAGE_REFS_MAX,
  MESSAGE_REF_MAX,
  TEAM_MESSAGES_MAX_PER_TEAM,
  TEAM_MESSAGES_TTL_MS,
  SYSTEM_RUN_ID,
  LEAD_DEFAULT_NAME,
  LEAD_DEFAULT_TOOLS,
  LEAD_SYSTEM_PROMPT,
  mapToolAliases,
  normalizeBudget,
  normalizeMemberInput,
  normalizeRefs,
  leadMissing,
  dispatchGate,
};
