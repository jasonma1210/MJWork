// 双入口路由判定器（设计文档 §7.3 / §8.1）——L0 规则层 + L1 模型层 + 确认点三档。
//
// 职责边界（为什么单独成模块、为什么不塞进 agent-core）：
//   · 判定点位置在 main 进程、agent:run 之前（§7.3）：renderer 判定不可测/不可审计，
//     agent-core 内判定会与「模型自决」两个决策源互相污染（模型可能绕过或重复触发）。
//   · 本模块**只决定「要不要问」与「问什么」**，不代替用户按下执行，也不建组。
//     建组仍只有既有两条路径：orchestrate_task（模型自决）/ teams:dispatch（用户派活）。
//
// 三条纪律（必须体现在代码里，不是写在注释里就算数）：
//   ① 确认卡里的子任务必须是**已拆好的**：拆 ≠ 建组，故此处只做「纯拆解」（不落库、不建组）。
//   ② 用户点「改成单 Agent」⇒ 本轮不升级且**不重复追问**（同一会话同一目标只问一次）。
//   ③ 无人值守通道没有确认点 ⇒ 定时任务必须预先声明 team_id 与预算，
//      **不得无人值守时静默升级**（否则等于偷偷花用户 N 倍 token）。
//
// 判据是**任务结构**不是长度/难度（arXiv:2512.08296：可分解 +80.8% / 顺序规划 -70.0%）。
// 所有阈值与模式串都在 entryPolicy.json 里，本文件不写死任何内容关键词。
'use strict';

const fs = require('fs');
const path = require('path');

const POLICY_FILE = path.join(__dirname, 'entryPolicy.json');

// 路由类别（离散，不用难度分——对标 n4n triage 经验 + OpenAI「A Practical Guide to Building Agents」：
// 离散类可直接映射到执行路径、可回归评测；打分（1-10）难评估且模型会「对冲」）。
const ROUTE_CLASSES = ['simple_chat', 'multi_step_single', 'parallel_team', 'manual_team', 'scheduled'];

// 配置读取失败时的最小可用策略：宁可退回「什么都不自动做」，也不要因为配置读不到就
// 放开自动升级（配置缺失时的默认方向必须是保守的）。
const FALLBACK_AUTO_DAG = {
  enabled: false,
  ruleOnly: true,
  rule: {
    toolKindThreshold: 16,
    parallelizablePatterns: [],
    sequentialPatterns: [],
    centralizedVerifyPatterns: [],
    scheduledPatterns: [],
    manualTeamPatterns: [],
    toolKindPatterns: [],
  },
  modelLayer: {
    routeClasses: ROUTE_CLASSES.slice(),
    maxInTokens: 1500,
    maxOutTokens: 200,
    timeoutMs: 15000,
    temperature: 0,
    minConfidence: 0.6,
    failOpenTo: 'simple_chat',
  },
  maxTeamSize: 5,
  costNotice: true,
  showUpgradeNotice: true,
  autoUpgrade: false,
};

let _policyCache = null;

/** 读 entryPolicy.json（带缓存）。读失败 ⇒ 退回保守的最小策略并大声告警。 */
function loadPolicy(override) {
  if (override && typeof override === 'object') return override;
  if (_policyCache) return _policyCache;
  try {
    _policyCache = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
  } catch (e) {
    console.error('[entryRouter] 策略配置读取失败，自动升级已关闭（保守回落）:', e.message);
    _policyCache = { new: { autoDag: FALLBACK_AUTO_DAG, confirm: {} } };
  }
  return _policyCache;
}

/**
 * 取 autoDag 段。调用方可能给整份配置，也可能直接给 autoDag 段（设计文档 §8.1 的 deps.policy 口径）。
 */
function autoDagPolicy(policy) {
  const p = loadPolicy(policy);
  if (!p || typeof p !== 'object') return FALLBACK_AUTO_DAG;
  if (p.new && p.new.autoDag) return p.new.autoDag;
  if (p.rule || p.modelLayer || p.maxTeamSize) return p;
  return FALLBACK_AUTO_DAG;
}

/** 取 confirm 段（三档确认点的阈值）。缺失时用设计文档 §7.3 的默认值。 */
function confirmPolicy(policy) {
  const p = loadPolicy(policy);
  const c = (p && p.new && p.new.confirm) || (p && p.confirm) || {};
  return {
    c0MinConfidence: num(c.c0MinConfidence, 0.75),
    c1MinConfidence: num(c.c1MinConfidence, 0.5),
    toolKindsC0Max: num(c.toolKindsC0Max, 8),
    toolKindsC1Max: num(c.toolKindsC1Max, 16),
    teamSizeC0Max: num(c.teamSizeC0Max, 3),
    teamSizeC1Max: num(c.teamSizeC1Max, 5),
    autoUpgradeEnabled: c.autoUpgradeEnabled === true,
    preSplitBeforeConfirm: c.preSplitBeforeConfirm !== false,
    maxPreSplitTasks: num(c.maxPreSplitTasks, 8),
    tokenMultiplePerMember: num(c.tokenMultiplePerMember, 1),
    wallClockPerMemberMs: num(c.wallClockPerMemberMs, 60000),
  };
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function str(v) { return String(v == null ? '' : v); }

// ── 启发式模式编译（一次性编译 + 缓存；配置改动不热更，改配置后需重启进程）──
const _reCache = new Map();
function compilePatterns(list) {
  const key = JSON.stringify(list || []);
  if (_reCache.has(key)) return _reCache.get(key);
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    try { out.push(new RegExp(str(p), 'i')); }
    catch { /* 非法模式跳过：配置写错不该让整个判定器挂掉 */ }
  }
  _reCache.set(key, out);
  return out;
}

function countMatches(text, patterns) {
  const res = compilePatterns(patterns);
  const hits = [];
  for (const re of res) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/**
 * 工具种类估算：统计目标里出现了多少种**互不相同的工具能力**。
 * 口径说明：社区阈值 ~16 指的是「这次任务会用到多少种工具」，一段话能覆盖的种类越多，
 * 说明任务面越宽；工具密度高时多 agent 的开销更大（每个 agent 都要吃一遍工具表）。
 * 种类定义在 entryPolicy.json 的 rule.toolKindPatterns 里，代码不内置任何内容关键词。
 */
function toolKindsOf(text, toolKindPatterns) {
  const kinds = [];
  const matched = [];
  for (const entry of Array.isArray(toolKindPatterns) ? toolKindPatterns : []) {
    const kind = str(entry && entry.kind);
    if (!kind) continue;
    const hits = countMatches(text, entry.patterns || []);
    if (hits.length) { kinds.push(kind); matched.push({ kind, hit: hits[0] }); }
  }
  return { count: kinds.length, kinds, matched };
}

/**
 * 预计团队规模：枚举项数量优先（用户自己列了 1/2/3 就是 3 份工作），
 * 否则用并行信号命中数 +1 兜底。规模只影响确认档与成本提示，不决定是否升级。
 */
function estimatedTeamSize(text, parallelHits) {
  const enumHits = text.match(/(?:^|[\s，,、;；])(\d{1,2})[.、）)]/g) || [];
  const circled = text.match(/[①②③④⑤⑥⑦⑧⑨]/g) || [];
  const cn = text.match(/第[一二三四五六七八九]个/g) || [];
  const n = enumHits.length + circled.length + cn.length;
  if (n > 0) return n;
  return Math.max(1, parallelHits.length);
}

/**
 * L0 规则层判定（纯函数、零成本、可单测）。
 * 判据是**任务结构**：可并行性 / 顺序依赖 / 工具种类数 / 需中心化验证。
 * ⚠️ 「可并行 / 顺序依赖」必须用启发式（模式串来自配置），**不得交给模型判断**——
 *    模型层（L1）是「规则层不确定时」的兜底，不是第一判据。
 *
 * @param {string} goal 用户本轮输入（原始文本）
 * @param {{userPickedTeam?:boolean, chatOnly?:boolean}} [opts]
 * @returns {{verdict:string, reason:string, signals:object, confidence:number}}
 */
function ruleRoute(goal, opts = {}) {
  const text = str(goal);
  const autoDag = autoDagPolicy(opts.policy);
  const rule = autoDag.rule || {};
  const maxTeamSize = num(autoDag.maxTeamSize, 5);

  const parallelHits = countMatches(text, rule.parallelizablePatterns);
  const sequentialHits = countMatches(text, rule.sequentialPatterns);
  const verifyHits = countMatches(text, rule.centralizedVerifyPatterns);
  const scheduledHits = countMatches(text, rule.scheduledPatterns);
  const manualHits = countMatches(text, rule.manualTeamPatterns);
  const tk = toolKindsOf(text, rule.toolKindPatterns);
  const toolKinds = tk.count;
  const estimatedSize = Math.min(maxTeamSize, Math.max(1, estimatedTeamSize(text, parallelHits)));

  const signals = {
    parallelizable: parallelHits.length > 0,
    parallelHits: parallelHits.slice(0, 5),
    sequential: sequentialHits.length > 0,
    sequentialHits: sequentialHits.slice(0, 5),
    needsCentralizedVerify: verifyHits.length > 0,
    toolKinds,
    toolKindList: tk.kinds.slice(0, 20),
    estimatedSize,
    scheduledHint: scheduledHits.length > 0,
    manualTeamHint: manualHits.length > 0,
  };

  const done = (verdict, reason, confidence) => ({
    verdict, reason, signals, confidence, decidedByRule: true,
  });

  // ① 上游已判对话型目标 ⇒ 直接单 Agent（既有 isChatOnlyGoal 的口径，不在此重复实现）
  if (opts.chatOnly === true) {
    return done('simple_chat', '这一轮是对话型目标，不需要拆分并行。', 0.9);
  }
  // ② 用户已显式选编制 ⇒ 意图已表达，不判定、不追问（Codex「只在用户明确要求时才派生」）
  if (opts.userPickedTeam === true) {
    return done('parallel_team', '你已明确选定编制，按团队执行。', 1);
  }
  // ③ 定时特征 ⇒ 该走定时任务而不是这一轮就跑（§7.3 C2：引导而非确认）
  if (scheduledHits.length > 0) {
    return done('scheduled', `目标含定时特征（${scheduledHits[0]}），更适合做成定时任务。`, 0.7);
  }
  // ④ 显式要求组队但需人选 ⇒ 人工编排更合适（不自动建组）
  if (manualHits.length > 0) {
    return done('manual_team', `目标提到要人工组队（${manualHits[0]}），成员构成需要你来定。`, 0.7);
  }
  // ⑤ 强顺序依赖 ⇒ **禁止**升级（顺序规划型任务上多 agent 退化约 70%）
  if (sequentialHits.length > 0) {
    return done('multi_step_single',
      `目标含顺序依赖（${sequentialHits[0]}），后续步骤要用前面的结果，单 Agent 分步更稳。`, 0.7);
  }
  // ⑥ 工具种类过多 ⇒ 降级单 Agent（工具密度高时多 agent 开销更大）
  if (toolKinds >= num(rule.toolKindThreshold, 16)) {
    return done('multi_step_single',
      `目标涉及 ${toolKinds} 类工具，工具面太宽，多 Agent 拆分的开销大于收益。`, 0.7);
  }
  // ⑦ 可并行信号命中 ⇒ 允许升级为团队
  if (parallelHits.length > 0) {
    // 高置信 = 可并行 + 无顺序依赖 + 工具种类少 + 规模小（§7.3 C0 条件）
    const high = toolKinds < num(confirmPolicy(opts.policy).toolKindsC0Max, 8)
      && estimatedSize <= num(confirmPolicy(opts.policy).teamSizeC0Max, 3);
    return done('parallel_team',
      `目标里各部分互不依赖（${parallelHits[0]}），可以并行执行。`, high ? 0.85 : 0.6);
  }
  // ⑧ 只提到汇总/交叉核对但没说可并行 ⇒ 单 Agent 分步即可
  if (verifyHits.length > 0) {
    return done('multi_step_single',
      `目标需要汇总核对（${verifyHits[0]}），但没说各部分可并行，单 Agent 分步更合适。`, 0.6);
  }
  // ⑨ 规则层不确定 ⇒ 交给 L1 模型层（离散类别）
  return done('unknown', '规则层判不准，需要模型层给一个路由类别。', 0);
}

// ── L1 模型层 ────────────────────────────────────────────────────────────────

// L1 的输出协议：严格 JSON、**离散路由类别**、带一句人话理由与置信度。
const ROUTE_SYSTEM_PROMPT = [
  '你是 MJCode 的任务路由分类器。把用户目标分到一个**离散的执行路径**类别，输出严格 JSON（不要输出任何其他文本）：',
  '{"route":"simple_chat|multi_step_single|parallel_team|manual_team|scheduled","reason":"一句人话理由","confidence":0.0}',
  '类别含义：',
  'simple_chat = 单 Agent 对话即可；multi_step_single = 单 Agent 分步（要拆但不需要并行）；',
  'parallel_team = 可真正并行分解（各子任务互不改变对方依赖的状态），适合多 Agent；',
  'manual_team = 适合组队但成员构成需要人来定；scheduled = 应做成定时任务。',
  '判据只看**任务结构**：子任务是否可并行、是否强顺序依赖、工具种类多不多、是否需要汇总交叉核对。',
  '**不要输出难度分数，不要对冲**；判不准就选 simple_chat。',
].join('\n');

/** 取模型输出里的第一段 JSON（容忍 ```json 围栏与前后杂讯）。 */
function extractJson(content) {
  let s = str(content).trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/** 超时包装：判定**不得阻塞**主链路，超时即按失败处理。 */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`判定超时（${ms}ms）`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 路由判定（§7.3 / §8.1）。异步：规则层命中即返回；规则层不确定才 await 模型层。
 *
 * @param {object} input
 * @param {string} input.goal 用户本轮输入（原始文本）
 * @param {boolean} [input.userPickedTeam] 用户显式选了编制/军团 ⇒ 直接 parallel_team
 * @param {string|null} [input.teamId] 选中的编制 id
 * @param {boolean} [input.chatOnly] 上游已判定为对话型目标 ⇒ 直接 simple_chat
 * @param {boolean} [input.unattended] 无人值守通道（定时）⇒ 不得静默升级
 * @param {Function} [deps.chatOnce] 一次非流式模型调用（缺省 ⇒ 只走规则层）
 * @param {Function} [deps.resolveModel] 解析执行模型（L1 调用需要）
 * @param {object} [deps.policy] entryPolicy.json（整份或 new.autoDag 段）
 * @returns {Promise<RouteVerdict>}
 */
async function judgeRoute(input = {}, deps = {}) {
  const goal = str(input.goal);
  const autoDag = autoDagPolicy(deps.policy);
  const ml = autoDag.modelLayer || {};
  const rule = ruleRoute(goal, {
    userPickedTeam: input.userPickedTeam === true,
    chatOnly: input.chatOnly === true,
    policy: deps.policy,
  });

  const fallback = (reason) => ({
    route: 'simple_chat', decidedByRule: false, reason, confidence: 0,
    source: 'fallback', signals: rule.signals,
  });

  // 规则层已能判定 ⇒ **绝不调模型**（省成本，也避免把简单问句送进模型）。
  if (rule.verdict !== 'unknown') {
    return {
      route: rule.verdict, decidedByRule: true, reason: rule.reason,
      confidence: rule.confidence, source: 'rule', signals: rule.signals,
    };
  }

  // 判定器整体关闭 ⇒ 不做任何自动判断（用户可关）。
  if (autoDag.enabled === false) {
    return {
      route: 'simple_chat', decidedByRule: false,
      reason: '自动编排判定已关闭，按单 Agent 对话执行。', confidence: 0,
      source: 'policy', signals: rule.signals,
    };
  }
  // ruleOnly / 无模型通道 ⇒ 不升级。
  if (autoDag.ruleOnly === true || typeof deps.chatOnce !== 'function') {
    return {
      route: 'simple_chat', decidedByRule: false,
      reason: '规则层判不准且未启用模型层，按单 Agent 对话执行。', confidence: 0,
      source: 'rule', signals: rule.signals,
    };
  }

  // ── L1：一次短调用，输出离散路由类别 ──
  try {
    const model = typeof deps.resolveModel === 'function' ? deps.resolveModel() : null;
    const { toChatRequest } = require('./modelShape');
    const req = model ? toChatRequest(model) : {};
    const res = await withTimeout(deps.chatOnce({
      ...req,
      messages: [
        { role: 'system', content: ROUTE_SYSTEM_PROMPT },
        { role: 'user', content: `【用户目标】\n${goal}` },
      ],
    }), num(ml.timeoutMs, 15000));

    const raw = extractJson(res && res.content);
    const allowed = Array.isArray(ml.routeClasses) && ml.routeClasses.length
      ? ml.routeClasses : ROUTE_CLASSES;
    if (!raw || typeof raw !== 'object' || !allowed.includes(raw.route)) {
      return fallback('模型层没给出合法路由类别，已降级为单 Agent 对话。');
    }
    const confidence = Math.min(1, Math.max(0, Number(raw.confidence) || 0));
    if (confidence < num(ml.minConfidence, 0.6)) {
      // 置信度不足按 ambiguous 处理：保守方向 = 不启 DAG
      return fallback(`模型层置信度不足（${confidence.toFixed(2)} < ${num(ml.minConfidence, 0.6)}），已降级为单 Agent 对话。`);
    }
    return {
      route: raw.route, decidedByRule: false,
      reason: str(raw.reason) || '模型层判定为该路由类别。',
      confidence, source: 'model', signals: rule.signals,
    };
  } catch (e) {
    // 失败/超时/输出非法 ⇒ 降级 simple_chat（不启 DAG）。这是有意的保守方向：
    // 多 agent 的失败模式（整组失败、无部分交付）比漏启更伤。
    return fallback(`模型层判定失败（${str(e && e.message || e).slice(0, 120)}），已降级为单 Agent 对话。`);
  }
}

// ── 确认点三档（C0 / C1 / C2）────────────────────────────────────────────────

/**
 * 判定确认档（§7.3）。**纯函数**：不调模型、不建组、可单测。
 *
 * @param {object} verdict judgeRoute 的返回值
 * @param {object} [ctx]
 * @param {boolean} [ctx.userPickedTeam] 用户已显式选编制
 * @param {boolean} [ctx.unattended] 无人值守通道（定时任务）
 * @param {string|null} [ctx.scheduledTeamId] 定时任务预先声明的军团
 * @param {boolean} [ctx.autoUpgrade] 用户开了「自动升级（不再询问）」
 * @param {object} [ctx.policy] entryPolicy.json
 * @returns {{tier:string, ask:boolean, blocked:boolean, reason:string, reasonSource:string, card:object|null, notice:object|null}}
 */
function decideConfirmPoint(verdict, ctx = {}) {
  const c = confirmPolicy(ctx.policy);
  const route = str(verdict && verdict.route) || 'simple_chat';
  const signals = (verdict && verdict.signals) || {};
  const confidence = Number(verdict && verdict.confidence) || 0;
  const teamSize = Math.max(1, Math.min(c.teamSizeC1Max, Number(signals.estimatedSize) || 1));
  const toolKinds = Number(signals.toolKinds) || 0;

  const cardSkeleton = {
    title: `建议用 ${teamSize} 人团队执行此任务`,
    teamSize,
    tokenMultiple: teamSize * c.tokenMultiplePerMember,
    estimatedWallClockMs: teamSize * c.wallClockPerMemberMs,
    cost: {
      teamSize,
      tokenMultiple: teamSize * c.tokenMultiplePerMember,
      estimatedWallClockMs: teamSize * c.wallClockPerMemberMs,
    },
    actions: ['confirm', 'single', 'detail'],
  };

  // 纪律③：无人值守通道**没有确认点**，且不得静默升级。
  if (ctx.unattended === true) {
    if (route === 'parallel_team' && !ctx.scheduledTeamId) {
      return {
        tier: 'none', ask: false, blocked: true,
        reason: '无人值守通道不得静默升级为团队执行：定时任务必须预先声明 team_id 与预算。',
        reasonSource: 'unattended-guard', card: null, notice: null,
      };
    }
    return {
      tier: 'none', ask: false, blocked: false,
      reason: '无人值守通道没有确认点，按任务预先声明的编制执行。',
      reasonSource: 'unattended', card: null, notice: null,
    };
  }

  // C2：不是「要不要用团队」，而是「这条该走别的路」⇒ 引导而非确认。
  if (route === 'manual_team' || route === 'scheduled') {
    const guide = route === 'manual_team'
      ? { action: 'open_assistant_team', label: '去助理页组建团队' }
      : { action: 'open_assistant_scheduled', label: '创建定时任务' };
    return {
      tier: 'C2', ask: false, blocked: true,
      reason: route === 'manual_team'
        ? '这条适合组队执行，但成员构成需要你来定——请去助理页组建团队。'
        : '这条更适合做成定时任务——请到助理页的定时任务视图创建。',
      reasonSource: 'route-class', card: { ...cardSkeleton, guide, guideAction: guide.action },
      notice: null,
    };
  }

  // 单 Agent 路径：本来就没有确认点（multi_step_single 走既有的拆分卡片，那本身就是确认点）。
  if (route === 'simple_chat' || route === 'multi_step_single') {
    const downgraded = signals.sequential === true || toolKinds >= c.toolKindsC1Max;
    return {
      tier: 'C0', ask: false, blocked: false,
      reason: str(verdict && verdict.reason) || '按单 Agent 执行。',
      reasonSource: 'single-agent',
      card: null,
      notice: downgraded ? {
        type: 'downgrade', route,
        reason: str(verdict && verdict.reason) || '',
        teamSize: 1, tokenMultiple: 1,
      } : null,
    };
  }

  // ── parallel_team：C0 / C1 ──
  const highConfidence = confidence >= c.c0MinConfidence
    && toolKinds <= c.toolKindsC0Max
    && teamSize <= c.teamSizeC0Max
    && signals.sequential !== true;
  const autoUpgradeOn = ctx.autoUpgrade === true || c.autoUpgradeEnabled === true;

  if (ctx.userPickedTeam === true) {
    return {
      tier: 'C0', ask: false, blocked: false,
      reason: '你已明确选定编制，直接按团队执行（不再追问）。',
      reasonSource: 'user-picked', card: null,
      notice: { type: 'upgrade', route, teamSize, tokenMultiple: teamSize * c.tokenMultiplePerMember },
    };
  }
  if (highConfidence && autoUpgradeOn) {
    return {
      tier: 'C0', ask: false, blocked: false,
      reason: '已开启「自动升级」且规则层判断置信度高，直接按团队执行。',
      reasonSource: 'auto-upgrade', card: null,
      notice: { type: 'upgrade', route, teamSize, tokenMultiple: teamSize * c.tokenMultiplePerMember },
    };
  }
  if (highConfidence) {
    return {
      tier: 'C0', ask: false, blocked: false,
      reason: str(verdict && verdict.reason) || '规则层判断置信度高，直接按团队执行。',
      reasonSource: 'rule-high-confidence', card: null,
      notice: { type: 'upgrade', route, teamSize, tokenMultiple: teamSize * c.tokenMultiplePerMember },
    };
  }

  // C1（默认档）：先出卡，不建组。
  const conservative = toolKinds >= c.toolKindsC1Max;
  return {
    tier: 'C1', ask: true, blocked: false,
    reason: str(verdict && verdict.reason) || '这项任务可以拆成互不依赖的几块并行做。',
    reasonSource: 'medium-confidence',
    card: {
      ...cardSkeleton,
      reason: str(verdict && verdict.reason) || '',
      reasonSource: 'medium-confidence',
      // 判据来源要能被用户看懂（§7.3 确认卡信息规格第②条）
      signals: {
        parallelizable: signals.parallelizable === true,
        sequential: signals.sequential === true,
        toolKinds,
        needsCentralizedVerify: signals.needsCentralizedVerify === true,
      },
      conservative,
      conservativeHint: conservative
        ? '工具种类偏多，建议「单 Agent」或只读子代理。'
        : '',
      subtasks: [],
    },
    notice: null,
  };
}

// ── 纪律②：用户点「改成单 Agent」后不再追问 ────────────────────────────────
// 同一会话内对同一目标只问一次：记住「已拒绝升级」的目标指纹。
const _answered = new Map(); // sessionKey → Set(goal 指纹)

function goalFingerprint(goal) {
  return str(goal).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * 记录用户对确认卡的答复。
 * @param {string} sessionKey 会话标识
 * @param {string} goal 本轮目标文本
 * @param {'single'|'confirm'} choice 'single' = 改成单 Agent（本轮不升级）；'confirm' = 按团队执行
 * @returns {boolean} 是否记录成功
 */
function noteUserChoice(sessionKey, goal, choice) {
  if (!sessionKey || (choice !== 'single' && choice !== 'confirm')) return false;
  const k = str(sessionKey);
  if (!_answered.has(k)) _answered.set(k, new Set());
  _answered.get(k).add(goalFingerprint(goal));
  return true;
}

/** 本轮目标是否已被用户答复（是 ⇒ 不再追问、不再升级）。 */
function hasAnswered(sessionKey, goal) {
  if (!sessionKey) return false;
  const set = _answered.get(str(sessionKey));
  return !!(set && set.has(goalFingerprint(goal)));
}

/** 「已答复」的语义别名（只关心「拒绝升级」时也用它）。 */
function hasDeclinedTeam(sessionKey, goal) {
  return hasAnswered(sessionKey, goal);
}


// ── 纪律①：纯拆解（拆 ≠ 建组）────────────────────────────────────────────────

/**
 * 只拆不建：拿到子任务清单，**不建组、不执行**（确认卡里必须是已拆好的清单，
 * 否则用户确认 A、执行 B）。复用编排器的拆解提示词与 DAG 校验（单一事实来源），
 * 但**不调用 planGoal**——planGoal 会落库建组，那正是本设计禁止的。
 *
 * @returns {Promise<{ok:boolean, tasks?:Array, error?:string}>}
 */
async function decomposeOnly(goal, deps = {}) {
  if (typeof deps.chatOnce !== 'function') return { ok: false, error: '拆解通道未就绪' };
  try {
    const { ORCHESTRATOR_SYSTEM } = require('./orchestrator');
    const { validateDag } = require('./orchestrator/dag');
    const { toChatRequest } = require('./modelShape');
    const model = typeof deps.resolveModel === 'function' ? deps.resolveModel() : null;
    const res = await withTimeout(deps.chatOnce({
      ...(model ? toChatRequest(model) : {}),
      messages: [
        { role: 'system', content: ORCHESTRATOR_SYSTEM },
        { role: 'user', content: `【用户目标】\n${str(goal)}` },
      ],
    }), num((autoDagPolicy(deps.policy).modelLayer || {}).timeoutMs, 15000));
    const dag = validateDag(res && res.content);
    if (!dag.ok) return { ok: false, error: dag.error };
    const max = num(confirmPolicy(deps.policy).maxPreSplitTasks, 8);
    return { ok: true, tasks: dag.tasks.slice(0, max) };
  } catch (e) {
    return { ok: false, error: str(e && e.message || e) };
  }
}

/**
 * 组装确认卡（C1）。子任务清单在出卡前拆好（纪律①）。
 * @returns {Promise<{tier:string, ask:boolean, card:object|null, ...}>}
 */
async function buildConfirmPoint(verdict, ctx = {}, deps = {}) {
  const point = decideConfirmPoint(verdict, ctx);
  if (point.tier !== 'C1' || !point.card) return point;
  if (confirmPolicy(ctx.policy).preSplitBeforeConfirm === false) return point;
  const split = await decomposeOnly(ctx.goal, deps);
  const card = { ...point.card };
  if (split.ok) {
    // prompt 必须一并下发：确认卡「按这个执行」会把这份清单当作 presetTasks 原样回传，
    // 而编排器要求每条任务有 prompt（缺失会被判为「预设任务清单为空或缺少 prompt」⇒ 整次派活失败）。
    // 只带 id/title/dependsOn 的话，卡能显示、点了却派不出去——「看着能点、点了没用」。
    card.subtasks = split.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      prompt: str(t.prompt || t.title),
      dependsOn: t.dependsOn || [],
    }));
    card.subtasksReady = true;
  } else {
    // 拆不出来 ⇒ 明说「子任务未就绪」，不假装拆好了（否则用户确认 A、执行 B）。
    card.subtasks = [];
    card.subtasksReady = false;
    card.subtaskError = str(split.error).slice(0, 200);
  }
  return { ...point, card };
}

module.exports = {
  ROUTE_CLASSES,
  loadPolicy,
  autoDagPolicy,
  confirmPolicy,
  ruleRoute,
  judgeRoute,
  decideConfirmPoint,
  buildConfirmPoint,
  decomposeOnly,
  noteUserChoice,
  hasAnswered,
  hasDeclinedTeam,
  goalFingerprint,
  extractJson,
};
