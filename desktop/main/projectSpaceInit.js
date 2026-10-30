// DS Bots / T6-9：项目空间初始化链路（设计稿 §11.3）。
//
// 一次创建要跨**两种存储**落地七步：SQLite 的 project_spaces / project_artifacts /
// quota_buckets，与 localStore（local-data.json）里的 thread / message，外加团队编制。
// 两种存储无法用单库事务包住，所以这里用**补偿栈（LIFO undo）**保证「任一步失败 → 无脏数据」：
// 每完成一步就压入一条撤销函数，失败时逆序回放；撤销本身失败只记日志，不覆盖原始错误。
//
// 顺序与设计稿逐字一致：项目 → 工件 → 配额桶 → thread → 团队 → 首条系统消息 → 返回。
// 为什么不把「校验」散到 IPC：默认章节 / 配额档位 / 团队模板都是初始化语义，必须与创建动作
// 同源；放到 IPC 层会让「IPC 创建」与「直接调用 init」两条路径产出不同默认值。
const fs = require('fs');
const pathMod = require('path');
const { PROJECT_CATEGORIES } = require('./projectStore');
const { ARTIFACT_KINDS, SNAPSHOT_POLICIES, LIMITS } = require('./artifactStore');

// ── 默认章节（按分类；§11.1「按分类带默认值，可编辑」）──
// key 由 normalizeOutline 统一生成（s1…sn），title 是用户可见的章节名。
const SECTION_DEFAULTS = {
  prd: ['背景与目标', '用户与场景', '功能需求', '非功能需求', '验收标准'],
  tech: ['背景与约束', '方案架构', '接口与数据', '风险与取舍', '实施计划'],
  marketing: ['目标与受众', '核心策略', '渠道与投放', '执行节奏', '效果衡量'],
  custom: ['概述', '目标与内容', '结论'],
};

// ── 配额档位（§11.1：轻量 1M/2h、标准 3M/6h 默认、大型 10M/24h、自定义）──
const QUOTA_TIERS = {
  light: { totalLimit: 1_000_000, windowSeconds: 2 * 3600 },
  standard: { totalLimit: 3_000_000, windowSeconds: 6 * 3600 },
  large: { totalLimit: 10_000_000, windowSeconds: 24 * 3600 },
};

// 自定义配额的安全边界：与 quotaLedger 的软上限同量级，防止一次脚本把桶刷成天文数字
const CUSTOM_QUOTA_LIMITS = {
  totalLimit: [1_000, 50_000_000],
  windowSeconds: [60, 7 * 24 * 3600],
};

// ── 团队模板（§11.2；复用既有 rolePreset / 工具别名，不新建身份体系）──
// tools 用抽象别名（read/write/edit/bash/grep/glob），由 teamStore.mapToolAliases 映射为
// 引擎具体工具名——与生态中心数字员工完全同一份字典，避免第二份别名表。
const LEAD_TOOLS = ['read', 'grep', 'glob', 'write'];
const WORK_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob'];

const TEAM_TEMPLATES = {
  prd: {
    name: '产品 PRD 协作',
    description: '围绕 PRD 工件协作：产品定义、研发评估、设计交付',
    roles: [
      { name: '产品经理', roleKind: 'lead', tools: LEAD_TOOLS, systemPrompt: '你是产品负责人：锁定目标与范围，把需求拆成可验收的条目，协调研发与设计并汇总产出。' },
      { name: '后端工程师', roleKind: 'member', tools: WORK_TOOLS, systemPrompt: '你是后端工程师：负责接口、数据与实现约束，评估技术可行性并在工件中写清方案与风险。' },
      { name: '前端工程师', roleKind: 'member', tools: WORK_TOOLS, systemPrompt: '你是前端工程师：负责交互与页面实现，补齐状态、异常与验收细节。' },
      { name: 'UI 设计师', roleKind: 'member', tools: ['read', 'write', 'edit'], systemPrompt: '你是 UI 设计师：负责信息层级与视觉规范，输出可直接落地的界面说明。' },
    ],
  },
  tech: {
    name: '技术方案评审',
    description: '围绕技术方案工件协作：架构设计、实现评估、测试与运维约束',
    roles: [
      { name: '架构师', roleKind: 'lead', tools: LEAD_TOOLS, systemPrompt: '你是架构负责人：给出方案骨架与关键取舍，汇总各角色结论并锁定技术边界。' },
      { name: '后端工程师', roleKind: 'member', tools: WORK_TOOLS, systemPrompt: '你是后端工程师：负责接口、数据模型与实现细节，写清依赖与失败路径。' },
      { name: '测试工程师', roleKind: 'member', tools: ['read', 'write', 'edit', 'bash', 'grep', 'glob'], systemPrompt: '你是测试工程师：负责验收标准与风险用例，指出不可测试或边界不清的部分。' },
      { name: '运维工程师', roleKind: 'member', tools: WORK_TOOLS, systemPrompt: '你是运维工程师：负责部署、监控与回滚策略，评估运行期风险。' },
    ],
  },
  marketing: {
    name: '营销活动策划',
    description: '围绕策划案工件协作：策略、文案、投放与风控',
    roles: [
      { name: '策划负责人', roleKind: 'lead', tools: LEAD_TOOLS, systemPrompt: '你是策划负责人：锁定目标与受众，组织文案、投放与风控分工，汇总成完整策划案。' },
      { name: '文案', roleKind: 'member', tools: ['read', 'write', 'edit'], systemPrompt: '你是文案：负责核心信息与渠道话术，保证口径一致、可执行。' },
      { name: '投放', roleKind: 'member', tools: ['read', 'write', 'edit', 'web'], systemPrompt: '你是投放负责人：负责渠道选择、预算分配与效果衡量口径。' },
      { name: '风控', roleKind: 'member', tools: ['read', 'grep', 'glob'], systemPrompt: '你是风控：负责合规与风险清单，指出宣传、数据与投放中的红线。' },
    ],
  },
  custom: {
    name: '自定义项目团队',
    description: '按项目目标自定义角色与职责',
    roles: [
      { name: '统筹负责人', roleKind: 'lead', tools: LEAD_TOOLS, systemPrompt: '你是统筹负责人：拆解目标、分派任务并汇总产出。' },
      { name: '执行成员', roleKind: 'member', tools: WORK_TOOLS, systemPrompt: '你是执行成员：按分派完成具体子任务并汇报结论。' },
    ],
  },
};

// 分类缺省 → 工件类型（表单未选时仍能落一个合理默认）
const DEFAULT_ARTIFACT_KIND = { prd: 'document', tech: 'spec', marketing: 'plan', custom: 'document' };
// 分类缺省 → 团队模板（产品类默认 PRD 协作，其余按最接近的模板）
const DEFAULT_TEAM_TEMPLATE = { prd: 'prd', tech: 'tech', marketing: 'marketing', custom: 'custom' };

class InitError extends Error {
  constructor(code, message, field) {
    super(message || code);
    this.name = 'InitError';
    this.code = code;
    this.field = field || null;
  }
}

function invalid(field, message) {
  return new InitError('INVALID_INPUT', message, field);
}

function clampInt(v, [min, max], fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function requireText(raw, field, min, max) {
  const s = String(raw == null ? '' : raw).trim();
  if (s.length < min) throw invalid(field, `${field} 至少 ${min} 个字符`);
  if (s.length > max) throw invalid(field, `${field} 不能超过 ${max} 个字符`);
  return s;
}

// 数值区间校验（与 clampInt 的区别：越界要明确报错，而不是悄悄夹紧）
function requireIntInRange(raw, field, [min, max]) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw invalid(field, `${field} 必须是数字`);
  const i = Math.trunc(n);
  if (i < min || i > max) throw invalid(field, `${field} 需在 ${min}–${max} 之间`);
  return i;
}

function normalizeOutline(raw, category) {
  const list = Array.isArray(raw) ? raw : [];
  const titles = list
    .map((x) => String((x && typeof x === 'object' ? x.title : x) || '').trim())
    .filter(Boolean);
  const finalTitles = titles.length ? titles : SECTION_DEFAULTS[category].slice();
  if (finalTitles.length > LIMITS.outlineMax) {
    throw invalid('outline', `章节数不能超过 ${LIMITS.outlineMax}`);
  }
  return finalTitles.map((title, i) => ({ key: `s${i + 1}`, title, order: i, level: 1 }));
}

function normalizeCwd(raw) {
  const cwd = String(raw == null ? '' : raw).trim();
  if (!cwd) return '';
  const abs = pathMod.resolve(cwd);
  let ok = false;
  // 失败即抛错（fail-closed），但对外文案一律是「不存在或不是目录」——EACCES（有目录没权限）会被误读成
  // 「目录不见了」，用户会反复确认路径。故把 errno 留在日志里，界面不改。
  try { ok = fs.statSync(abs).isDirectory(); } catch (e) { console.warn('[projectSpaceInit] cwd 探测失败，按不可用拒绝：', abs, e?.code || '', e?.message || e); ok = false; }
  if (!ok) throw invalid('cwd', '工作目录不存在或不是目录');
  return abs;
}

function normalizeRoles(raw, templateKey) {
  // 模板角色只读：只有「自定义」模板允许用户改角色；其余模板一律用内置模板，
  // 避免用户在只读表里看到的角色与实际落库的不一致。
  if (templateKey !== 'custom') {
    return TEAM_TEMPLATES[templateKey].roles.map((r) => ({ ...r }));
  }
  const list = Array.isArray(raw) ? raw : [];
  const roles = list.length ? list : TEAM_TEMPLATES.custom.roles;
  if (roles.length > 20) throw invalid('roles', '角色数不能超过 20');
  const seen = new Set();
  return roles.map((r, i) => {
    const name = String((r && r.name) || '').trim();
    if (!name) throw invalid('roles', `第 ${i + 1} 个角色缺少名称`);
    if (name.length > 40) throw invalid('roles', `角色名称不能超过 40 字符：${name}`);
    if (seen.has(name)) throw invalid('roles', `角色名称重复：${name}`);
    seen.add(name);
    return {
      name,
      roleKind: i === 0 || (r && r.roleKind === 'lead') ? 'lead' : 'member',
      tools: Array.isArray(r && r.tools) ? r.tools.map(String) : (i === 0 ? LEAD_TOOLS : WORK_TOOLS),
      systemPrompt: String((r && r.systemPrompt) || '').slice(0, 12000),
    };
  });
}

/**
 * 载荷归一 + 校验（唯一入口）。返回落库所需的全部参数；任何非法输入都抛 InitError，
 * 并带 `field` 供渲染层定位到具体输入框（§11.1 的内联反馈要求）。
 */
function normalizeSpec(payload = {}, { teamStore } = {}) {
  const name = requireText(payload.name, 'name', 1, 40);
  const category = String(payload.category || '').trim();
  if (!PROJECT_CATEGORIES.includes(category)) throw invalid('category', '项目分类非法');
  const objective = requireText(payload.objective, 'objective', 20, 2000);
  const cwd = normalizeCwd(payload.cwd);

  // 团队：existing 直接绑已有团队（必须存在）；template 按模板创建
  const teamMode = String(payload.teamMode || 'template').trim() === 'existing' ? 'existing' : 'template';
  let teamId = String(payload.teamId || '').trim();
  let templateKey = String(payload.teamTemplate || '').trim();
  if (teamMode === 'existing') {
    if (!teamId) throw invalid('teamId', '请选择要绑定的现有团队');
    if (!teamStore) throw new InitError('UNAVAILABLE', '团队子系统不可用');
    if (!teamStore.getTeam(teamId)) throw invalid('teamId', '所选团队不存在');
    templateKey = '';
  } else {
    if (!templateKey) templateKey = DEFAULT_TEAM_TEMPLATE[category];
    if (!TEAM_TEMPLATES[templateKey]) throw invalid('teamTemplate', '团队模板非法');
  }
  const roles = teamMode === 'template' ? normalizeRoles(payload.roles, templateKey) : [];

  // 配额：档位缺省标准；自定义档必须给合法上限与窗口
  const quotaTier = String(payload.quotaTier || 'standard').trim();
  if (quotaTier !== 'custom' && !QUOTA_TIERS[quotaTier]) throw invalid('quotaTier', '配额档位非法');
  let totalLimit;
  let windowSeconds;
  if (quotaTier === 'custom') {
    totalLimit = requireIntInRange(payload.totalLimit, 'totalLimit', CUSTOM_QUOTA_LIMITS.totalLimit);
    windowSeconds = requireIntInRange(payload.windowSeconds, 'windowSeconds', CUSTOM_QUOTA_LIMITS.windowSeconds);
  } else {
    ({ totalLimit, windowSeconds } = QUOTA_TIERS[quotaTier]);
  }
  // 断点续跑关闭 = 把恢复下限抬到总额度之上，使 resumeDecision 恒不成立；
  // 不改 resume_* 之外的任何字段，保持「单一判定仍在 quotaLedger」。
  const resumeEnabled = payload.resumeEnabled !== false;
  const resumeMinTokens = resumeEnabled ? 100_000 : totalLimit + 1;

  const artifactKind = String(payload.artifactKind || DEFAULT_ARTIFACT_KIND[category]).trim();
  if (!ARTIFACT_KINDS.includes(artifactKind)) throw invalid('artifactKind', '工件类型非法');
  const snapshotPolicy = String(payload.snapshotPolicy || 'per_patch').trim();
  if (!SNAPSHOT_POLICIES.includes(snapshotPolicy)) throw invalid('snapshotPolicy', '快照规则非法');
  const retainVersions = requireIntInRange(payload.retainVersions == null ? 10 : payload.retainVersions, 'retainVersions', [1, 50]);
  const outline = normalizeOutline(payload.outline, category);

  // 摘要触发阈值：§11.1「夹 50–85%」——越界夹紧而不是拒绝（可编辑字段不该因一次输入丢失整份表单）
  const compactPolicy = clampInt(payload.compactPolicy, [50, 85], 70);

  return {
    name, category, objective, cwd,
    team: { mode: teamMode, teamId, templateKey, roles },
    quota: { tier: quotaTier, totalLimit, windowSeconds, resumeMinTokens },
    artifact: { kind: artifactKind, outline, snapshotPolicy, retainVersions },
    meta: { compactPolicy, resumeEnabled },
  };
}

function firstSystemMessage(spec) {
  return `项目已创建，目标已锁定。\n\n目标与约束：${spec.objective}`;
}

function runUndo(stack) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    try { stack[i](); } catch (e) {
      console.warn('[project-space] 初始化回滚失败（已继续回放）：', e && e.message);
    }
  }
}

/**
 * 初始化项目空间（§11.3 七步）。
 * @returns {{project, artifact, bucket, thread, team}}
 * @throws InitError | Store 原始错误（调用方统一转 { ok:false, code, field }）
 */
function initProjectSpace(payload, deps = {}) {
  const { projectStore, artifactStore, quotaLedger, teamStore, localStore } = deps;
  if (!projectStore || !artifactStore || !quotaLedger || !teamStore || !localStore) {
    throw new InitError('UNAVAILABLE', '项目空间子系统不可用（初始化失败）');
  }
  const spec = normalizeSpec(payload, { teamStore });
  const undo = [];

  try {
    // 1) 项目身份（thread_id 暂时为空，第 4 步创建会话后再绑定）
    const project = projectStore.createProject({
      name: spec.name,
      category: spec.category,
      objective: spec.objective,
      cwd: spec.cwd,
      meta: spec.meta,
    });
    undo.push(() => projectStore.deleteProject(project.projectId));

    // 2) 工件 V0.0 + 章节骨架
    const artifact = artifactStore.createArtifact({
      projectId: project.projectId,
      kind: spec.artifact.kind,
      title: spec.name,
      outline: spec.artifact.outline,
      snapshotPolicy: spec.artifact.snapshotPolicy,
      retainVersions: spec.artifact.retainVersions,
    });
    undo.push(() => artifactStore.deleteArtifact(artifact.artifactId));

    // 3) 配额桶
    quotaLedger.ensureBucket(project.projectId, {
      totalLimit: spec.quota.totalLimit,
      windowSeconds: spec.quota.windowSeconds,
      tier: spec.quota.tier,
      resumeMinTokens: spec.quota.resumeMinTokens,
    });
    undo.push(() => quotaLedger.deleteBucket(project.projectId));

    // 4) 会话（localStore 的 id 是数字；projectPath 留空=自建目录，不绑固定工作区）
    const thread = localStore.createThread({
      title: spec.name,
      cwd: spec.cwd,
      projectPath: spec.cwd,
      status: 'idle',
    });
    undo.push(() => localStore.purgeThread(thread.id));

    projectStore.attachAssets(project.projectId, {
      threadId: String(thread.id),
      artifactId: artifact.artifactId,
    });

    // 5) 团队：现有团队直接绑定；模板则建团队 + 逐角色招募（首个角色为统筹）
    let team;
    if (spec.team.mode === 'existing') {
      team = teamStore.getTeam(spec.team.teamId);
    } else {
      const tpl = TEAM_TEMPLATES[spec.team.templateKey];
      team = teamStore.createTeam({
        name: `${spec.name}（${tpl.name}）`.slice(0, 60),
        description: tpl.description,
        projectPath: spec.cwd,
      });
      undo.push(() => teamStore.deleteTeam(team.id));
      for (const role of spec.team.roles) {
        teamStore.addMember(team.id, {
          name: role.name,
          roleKind: role.roleKind,
          source: 'template',
          templateRef: spec.team.templateKey,
          systemPrompt: role.systemPrompt,
          toolNames: role.tools,
          allowMcp: false,
          approvalMode: 'on-request',
          sandboxPolicy: 'workspace-write',
          skillNames: [],
        });
      }
    }
    projectStore.attachAssets(project.projectId, { teamId: team.id });

    // 6) 首条系统消息（「项目已创建，目标已锁定」）
    localStore.addMessage({
      threadId: thread.id,
      role: 'system',
      content: firstSystemMessage(spec),
    });

    // 7) 返回完整快照（全部经 Store 重新读取，确保返回的就是落库后的真实形态）
    return {
      project: projectStore.getProject(project.projectId),
      artifact: artifactStore.getArtifact(artifact.artifactId),
      bucket: quotaLedger.getBucket(project.projectId),
      thread,
      team: teamStore.getTeam(team.id),
    };
  } catch (err) {
    runUndo(undo);
    throw err;
  }
}

module.exports = {
  initProjectSpace, normalizeSpec,
  InitError,
  SECTION_DEFAULTS, QUOTA_TIERS, TEAM_TEMPLATES,
  CUSTOM_QUOTA_LIMITS, DEFAULT_ARTIFACT_KIND, DEFAULT_TEAM_TEMPLATE,
};
