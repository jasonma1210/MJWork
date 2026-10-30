// AI 建团草案（设计文档 §7.4 路径② / §8.2）——一次产出 N 个成员草案。
//
// 三个真实缺口（设计文档 §7.4 G1/G2/G3）在这里收口：
//   G1 一次只生成一个成员 ⇒ 这里一次生成 N 个（含统筹）；
//   G2 草案来源单一（永远 custom）⇒ 这里**目录优先**：先从数字员工目录里挑，挑不到才自由生成；
//   G3 没有覆盖度校验 ⇒ 这里附**确定性覆盖度报告**（需求要的能力有没有人扛）。
//
// 三条纪律：
//   · **只出草稿不落库**（沿用 teams:draftMember 的既有语义）：本模块**不碰任何 store**，
//     落库仍走既有 teams:addCustomMember / teams:recruit（执行前确认的门因此天然存在）。
//   · **归一化走既有 normalizeMemberInput**（fail-closed 枚举校验），不在此另写一份。
//   · **含义匹配交给模型**（目录里挑谁、需求要什么能力），**确定性校验留给代码**
//     （枚举、覆盖度、工具白名单）——分工同设计文档 §13 第 7 条。
'use strict';

const { normalizeMemberInput } = require('../teamStore');
const { ROLE_TOOL_ALIASES, buildEmployeeRuntimePreset } = require('../ecosystem');
const { capabilitiesOf, CAPABILITY_KEYS } = require('../teamCapabilities');
const guard = require('./payloadGuard');
const catalog = require('../employeeCatalog');
// 策略配置的**唯一**读取入口在 main/entryRouter.js（带缓存与读失败时的保守回落），
// 这里不另写一份 loader——两处各读一次 JSON，早晚会出现「阈值不一致」。
const { loadPolicy } = require('../entryRouter');

const ALIAS_KEYS = Object.keys(ROLE_TOOL_ALIASES || {});

// ── 组团提示词 ────────────────────────────────────────────────────────────────
// 为什么把目录摆给模型而不是用关键词打分去匹配：成员「适不适合」是语义问题，
// 关键词表会把「数据分析师」和「数据工程师」混为一谈。模型负责挑，代码负责验。
const DRAFT_TEAM_SYSTEM = [
  '你是 MJ Coder 军团的组建设计师。根据用户的一句组建需求，产出**一支团队**的草案，输出严格 JSON（不要输出任何其他文本）：',
  '{"name":"团队名（≤20字）","description":"团队职责一句话（≤60字）",',
  '"requiredCapabilities":["read","write","execute","search","web","browser","plan"],',
  '"members":[{"roleKind":"lead|member","role":"这个成员负责什么（一句话）",',
  '"source":"employee|custom","templateRef":"<source=employee 时必填：数字员工 id>",',
  '"name":"<source=custom 时必填：成员名 ≤20字>","systemPrompt":"<source=custom 时必填：自包含角色提示>",',
  '"tools":["read","write","edit","bash","grep","glob","web","browser"],',
  '"approvalPolicy":"on-request","sandboxPolicy":"workspace-write","skillNames":[],"fit":0.0}]}',
  '规则：',
  '1. **目录优先**：先从下方数字员工目录里挑合适的成员（source="employee"，templateRef 必须是目录里的 id，',
  '   并在 fit 里给 0~1 的匹配度）；目录确实覆盖不了的岗位才用 source="custom" 自由生成。',
  '2. source="employee" 的成员：只给 templateRef / role / fit，**不要改写目录里该员工的工具与提示词**（模板是只读的）；',
  '   source="custom" 的成员：必须给全 name / systemPrompt / tools / approvalPolicy / sandboxPolicy。',
  '3. **必须指定一名统筹**：把负责拆解与汇总的那名成员标成 roleKind="lead"（其余为 member）。',
  '4. requiredCapabilities 只填这份需求**真的需要**的能力键（从枚举里选，不要凑满）；',
  '   「plan」表示这份需求需要有人负责拆解与跟踪（由统筹覆盖）。',
  '5. tools 只能取这些抽象别名：read/write/edit/bash/grep/glob/web/browser——按角色最小化授予。',
  '6. systemPrompt 必须自包含（写清身份、职责、产出要求），禁止引用本次对话。',
  '7. 输出只能是 JSON，以 { 开头以 } 结尾。',
].join('\n');

/** 从模型输出里取第一段 JSON（容忍 ```json 围栏与前后杂讯）。 */
function extractJson(content) {
  let s = String(content || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  // 解析失败留痕：调用方只报「草案解析失败」，真因（围栏没闭合/输出截断/模型说人话）只有这里看得到；截 160 字防爆量
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { console.warn('[teamsDraft] extractJson parse failed:', e.message, 'len=', s.length, 'head=', s.slice(0, 160)); return null; }
}

/** 只保留白名单里的抽象工具别名（未知别名丢弃，与 ecosystem 写通道同纪律）。 */
function sanitizeAliases(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map((x) => String(x || '').trim())
    .filter((x) => ALIAS_KEYS.includes(x)))];
}

/** 草案段配置（阈值与开关全在 entryPolicy.json，代码不写死）。 */
function draftPolicy() {
  const p = loadPolicy();
  const c = (p && p.assistant && p.assistant.aiTeamDraft) || {};
  return {
    enabled: c.enabled !== false,
    defaultSize: Number(c.defaultSize) || 3,
    maxSize: Number(c.maxSize) || 8,
    preferCatalog: c.preferCatalog !== false,
    requireConfirm: c.requireConfirm !== false,
    catalogMatchMinScore: Number(c.catalogMatchMinScore) || 0,
    minScoreForCatalogPick: Number(c.minScoreForCatalogPick) || 0,
    coverageCheck: c.coverageCheck !== false,
    capabilityToolAliases: c.capabilityToolAliases || {},
    capabilityLabels: c.capabilityLabels || {},
    planCoveredByLead: c.planCoveredByLead !== false,
  };
}

/**
 * 覆盖度报告（设计文档 §8.2）：**确定性**判定「这套成员能不能干这个活」。
 * @param {string[]} required 需求需要的能力键
 * @param {Array<{tools:string[], roleKind:string}>} members 草案成员（抽象工具别名）
 * @returns {{covered:string[], missing:string[], warnings:string[], sufficient:boolean}}
 */
function buildCoverage(required, members) {
  const cfg = draftPolicy();
  const req = (Array.isArray(required) ? required : []).map(String).filter(Boolean);
  const all = members.flatMap((m) => (Array.isArray(m.tools) ? m.tools : []));
  const covered = [];
  const missing = [];
  const warnings = [];
  for (const key of CAPABILITY_KEYS) {
    if (!req.includes(key)) continue;
    let ok = false;
    if (key === 'plan' && cfg.planCoveredByLead) {
      ok = members.some((m) => m.roleKind === 'lead');
    } else {
      const aliases = cfg.capabilityToolAliases[key] || [];
      ok = aliases.some((a) => all.includes(a));
    }
    if (ok) { covered.push(key); continue; }
    missing.push(key);
    const label = cfg.capabilityLabels[key] || key;
    const alias = (cfg.capabilityToolAliases[key] || []).join('/');
    warnings.push(alias
      ? `需求提到「${label}」，但草案里没有成员被授予 ${alias} 工具。`
      : `需求提到「${label}」，但草案里没有成员承担这一块。`);
  }
  return { covered, missing, warnings, sufficient: missing.length === 0 };
}

/**
 * 目录成员的匹配分（0~1）：主体是**确定性**的能力覆盖率，辅以模型自报的 fit。
 * 为什么不用关键词打分：成员与需求是否匹配是语义问题，关键词表会误判
 * （「数据分析师」与「数据工程师」在关键词上无法区分）。模型负责挑，代码负责算「扛不扛得住活」。
 */
function matchScoreOf(member, required, cfg) {
  const aliases = new Set(member.tools || []);
  const req = (Array.isArray(required) ? required : []).map(String);
  if (!req.length) {
    const fit = Number.isFinite(Number(member.fit)) ? Math.max(0, Math.min(1, Number(member.fit))) : null;
    return fit == null ? 0 : Math.round(fit * 1000) / 1000;
  }
  let covered = 0;
  for (const key of req) {
    if (key === 'plan' && cfg.planCoveredByLead) { if (member.roleKind === 'lead') covered++; continue; }
    const al = cfg.capabilityToolAliases[key] || [];
    if (al.some((a) => aliases.has(a))) covered++;
  }
  const coverage = covered / req.length;
  const fit = Number.isFinite(Number(member.fit)) ? Math.max(0, Math.min(1, Number(member.fit))) : null;
  const score = fit == null ? coverage : 0.7 * coverage + 0.3 * fit;
  return Math.round(score * 1000) / 1000;
}

/**
 * 生成一支团队的草案。
 *
 * @param {object} payload
 * @param {string} payload.requirement 用户的组建需求（一段自然语言）
 * @param {number} [payload.size=3] 期望成员数（1~maxSize）
 * @param {boolean} [payload.preferCatalog=true] 是否优先从数字员工目录匹配
 * @param {string} [payload.teamId] 已有团队 id（省略 = 新团草案）
 * @param {object} deps { chatOnce, resolveModel }
 * @returns {Promise<{ok:boolean, draft?:object, error?:string}>}
 */
async function draftTeam(payload = {}, deps = {}) {
  const cfg = draftPolicy();
  if (cfg.enabled === false) return { ok: false, error: 'AI 建团草案功能已关闭' };
  if (!deps.chatOnce || !deps.resolveModel) return { ok: false, error: 'AI 草稿通道未就绪' };
  try {
    guard.assertStrings(payload, {
      requirement: 2000,
      teamId: { max: 128, optional: true },
    });
    const requirement = String(payload.requirement || '').trim();
    if (!requirement) return { ok: false, error: '组建需求必填' };
    const size = Math.max(1, Math.min(cfg.maxSize,
      Math.trunc(Number(payload.size) || cfg.defaultSize) || cfg.defaultSize));
    const preferCatalog = payload.preferCatalog === undefined
      ? cfg.preferCatalog : payload.preferCatalog !== false;

    // 目录清单：摆给模型看（只给判断依据，不给完整提示词，否则上下文会被吃光）
    let brief = [];
    if (preferCatalog) {
      try { brief = catalog.catalogBrief(80); } catch (e) { console.warn('[teamsDraft] 目录读取失败：', e.message); }
    }
    const catalogText = brief.length
      ? brief.map((e) => `- ${e.id} | ${e.title} | ${e.category} | 工具:${(e.tools || []).join('/')} | ${e.mission}`).join('\n')
      : '（目录暂不可用，请全部用 source="custom" 生成）';

    const model = deps.resolveModel();
    const { toChatRequest } = require('../modelShape');
    const res = await deps.chatOnce({
      ...toChatRequest(model),
      messages: [
        { role: 'system', content: DRAFT_TEAM_SYSTEM },
        { role: 'user', content: `【数字员工目录】\n${catalogText}\n\n【组建需求】\n${requirement}` },
      ],
    });
    const raw = extractJson(res && res.content);
    if (!raw || typeof raw !== 'object') return { ok: false, error: '团队草案解析失败，请重试或手动组建' };

    const required = Array.isArray(raw.requiredCapabilities)
      ? raw.requiredCapabilities.map(String).filter((k) => CAPABILITY_KEYS.includes(k))
      : [];
    const rawMembers = Array.isArray(raw.members) ? raw.members : [];

    const members = [];
    const warnings = [];
    for (const rm of rawMembers.slice(0, size)) {
      if (!rm || typeof rm !== 'object') continue;
      const roleKind = rm.roleKind === 'lead' ? 'lead' : 'member';
      const wantsCatalog = String(rm.source || '') === 'employee' || !!rm.templateRef;
      if (wantsCatalog) {
        const emp = catalog.resolveEmployee(String(rm.templateRef || '').trim());
        if (!emp) {
          // fail-closed：目录里没有这个 id ⇒ 不凭空造一个成员（否则用户会拿到一个不存在的「模板成员」）
          warnings.push(`目录里没有 id 为 ${String(rm.templateRef || '')} 的数字员工，该成员已从草案中移除。`);
          continue;
        }
        const preset = buildEmployeeRuntimePreset(emp);
        const aliases = sanitizeAliases(emp.tools);
        const draft = normalizeMemberInput({
          name: emp.title_cn || emp.name,
          roleKind,
          source: 'template',
          templateRef: emp.id,
          systemPrompt: preset.systemPrompt,
          toolNames: preset.toolNames,
          allowMcp: preset.allowMcp,
          model: preset.model,
          approvalPolicy: preset.approvalMode,
          sandboxPolicy: preset.sandboxPolicy,
          skillNames: preset.skillNames,
        });
        if (!draft.name) continue;
        const scored = { ...draft, tools: aliases, role: String(rm.role || '').slice(0, 200) };
        scored.matchScore = matchScoreOf({ ...scored, fit: rm.fit }, required, cfg);
        scored.employeeMatched = true;
        scored.capabilities = capabilitiesOf(draft.toolNames);
        members.push(scored);
        continue;
      }
      // 自由生成：工具先过白名单，再交给 normalizeMemberInput 做枚举归一（fail-closed）
      const aliases = sanitizeAliases(rm.tools);
      const draft = normalizeMemberInput({
        name: rm.name,
        roleKind,
        source: 'custom',
        templateRef: rm.templateRef || null,
        systemPrompt: rm.systemPrompt,
        tools: aliases,
        approvalPolicy: rm.approvalPolicy,
        sandboxPolicy: rm.sandboxPolicy,
        skillNames: rm.skillNames,
      });
      if (!draft.name) continue;
      const scored = { ...draft, tools: aliases, role: String(rm.role || '').slice(0, 200) };
      scored.matchScore = null;
      scored.employeeMatched = false;
      scored.capabilities = capabilitiesOf(draft.toolNames);
      members.push(scored);
    }

    if (!members.length) return { ok: false, error: '草案里没有可用成员，请重试或手动组建' };

    const coverage = cfg.coverageCheck
      ? buildCoverage(required, members)
      : { covered: [], missing: [], warnings: [], sufficient: true };
    if (warnings.length) coverage.warnings = [...coverage.warnings, ...warnings];

    return {
      ok: true,
      draft: {
        name: String(raw.name || '').trim().slice(0, 40) || '新团队',
        description: String(raw.description || requirement).trim().slice(0, 200),
        requiredCapabilities: required,
        members,
        coverage,
        requireConfirm: cfg.requireConfirm,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 注册本模块负责的通道（`ipc/teams.js` 已顶 800 行软档，注册与实现一起放这里）。
 * 语义与 `teams:draftMember` 一致：**只出草稿不落库**，落库仍走既有
 * `teams:addCustomMember` / `teams:recruit`（写通道单一事实来源）。
 *
 * @param {object} ipcMain Electron ipcMain
 * @param {object} deps { chatOnce, resolveModel }
 */
function register(ipcMain, deps = {}) {
  ipcMain.handle('teams:draftTeam', async (_, payload = {}) => (
    draftTeam(payload, { chatOnce: deps.chatOnce, resolveModel: deps.resolveModel })
  ));
}

module.exports = {
  register,
  draftTeam, buildCoverage, sanitizeAliases, matchScoreOf,
  DRAFT_TEAM_SYSTEM, extractJson, draftPolicy,
};
