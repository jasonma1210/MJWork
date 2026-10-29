// P2-1/P2-2/P2-6：MemoryManager——记忆唯一写入入口（写锁串行）+ 五域 + 四层 Tier + 分层召回
// 域（domain）：private / session / global_knowledge / entity / reflection
// 层（tier）  ：1 原文 / 2 压缩摘要 / 3 长期固化（Tier0 瞬时只在内存，不入库）
// 写入路径收口：渲染层/Worker 不再直写，全部经本模块（主进程单线程 + promise 链串行化）
//
// P0-2b（2026-10-17 记忆回路修复）：
//   · 写入前置校验：内容归一化（trim/连续空白压缩/大小写折叠）后取 sha1 前 16 位 hash，
//     同 space+domain+hash 已存在则刷新元数据（updated_at/usage_count/source）而非重复 INSERT；
//   · 来源可信度分级（随 source 列持久化，读取时确定性推导，无需新列）：
//       user_input 1.0 > model_conclusion 0.6 > external_content 0.2；
//   · external_content 禁止入 global_knowledge（强制降级 session 域）；未知来源拒绝写入；
//   · content_hash 列由本模块惰性补齐（PRAGMA table_info 探测 + ALTER，幂等）——
//     db/index.js 的迁移链不归本模块维护，故列补齐放在离使用方最近处。
// P0-2c：recallContents 按域 + 可信度过滤——低可信（external_content）条目默认不进
//   system prompt 注入，仅当 query 显式命中（词法相关性 > 0）时按低权重返回
//   （权重 = trust 乘子，体现在 recall 打分）。
// P1-17：分域半衰期（scorer.halfLifeDaysFor）+ 物理删除宽限 7 天 + promoteToLongTerm
//   （global_knowledge 等需人工确认才长期留存：晋升 Tier3 后永不被衰减/清理）。
// P3-3：容量总闸——recall 限量载入 + Top-K 钳制（打分成本由 O(总量) 降为 O(scanLimit)）；
//   单空间写入上限 MAX_MEMORIES_PER_SPACE（先清过期失效行，再按域优先级失效最旧 session 行）。
// 三层记忆 M0（2026-10-20）：新增作用域（scope）维度——session / project / global。
//   · scope/conversation_id 列由本模块惰性补齐（与 content_hash 同风格，幂等）；存量行回落 project；
//   · 写入分流经 resolveScope（唯一事实来源）+ 去重键随作用域分化（session 含会话、global 忽略空间）；
//   · recall 增分层模式（每层配额 + 跨层去重）+ recallForPrompt（预算内注入文本块）；
//   · 新增 updateMemory / importItems / resetScope / promoteScope。
// 三层记忆 M2（2026-10-20）：晋升链落地——会话删除 salvage（决策 3）+ 后台批量跨层晋升。
//   · salvageConversation：purge 会话前两段式（有价值的 L1 → L2 沉淀，其余 L1 物理删除）；
//   · promoteScopeByHits：L1 命中≥3→L2、L2 命中≥5 且 user_input→L3（bgScheduler promote-scope 处理器）。
// 三层记忆 M3（2026-10-20）：管理 UI + 文件双通道 + 分层召回注入。
//   · recallContents 增分层模式（scopes/conversationId）且输出 scope——渲染层据此加层级前缀注入；
//   · stats 增按作用域计数、新增 listScope/projectSpaces（管理 UI 仪表盘 + 文件导出取数）；
//   · importItems 增 onlyNew（文件导入幂等跳过已存在内容，避免覆盖来源/语义域）；
//   · onChange 变更通知：写路径变更经此驱动文件双通道导出视图（memoryFile.js 防抖落盘）。
// 三层记忆 M4（2026-10-20）：补齐设计文档 L1958 的两项承诺——① 半衰期按 scope 差异化
//   （scorer.HALF_LIFE_DAYS_BY_SCOPE，session 7 / project 30 / global 90，domain 表作兼容回落）；
//   ② L3 全局层独立容量闸 MAX_GLOBAL_MEMORIES=300（跨空间按 scope 计数 + LRU 硬淘汰）。
//   容量闸抽象为 _enforceCap 统一实现（空间闸 / 全局层闸共用淘汰口径）。
// M5 / T5-5（2026-10-20）：团队记忆（scope='team'）——扩展本模块的作用域维度，不新建存储。
//   · 归属两列 team_id / agent_id（迁移 v11）与「共享=agent_id IS NULL、私有=agent_id=成员 id」的判定；
//   · 团队∧项目同档半衰期（scorer 登记）+ 团队容量闸 MAX_TEAM_MEMORIES（纳入 _enforceCap）；
//   · 晋升 U5 定案为**提名制**：团队→项目默认不自动写入，只产出「待晋升候选」由用户一键确认，
//     且内容含团队专有名（团队名 / Lead 名）的条目直接不进候选（由宿主注入反例清单，见
//     listTeamPromotionCandidates 的 excludeNames —— 本模块不认识军团实体，团队知识留在宿主）。
const crypto = require('crypto');
// M5 / T5-5 拆分后：scoreMemory / relevance 已随召回族迁出，本文件只保留仍在本类使用的 halfLifeDaysFor
//（decayJob 的 scope 优先取半衰期）；打分器由 recall.js / team.js 自行 require('./scorer')。
const { halfLifeDaysFor } = require('./scorer');
// M5 / T5-5 拆分（2026-10-20）：召回族与团队记忆族抽为独立子模块（护 800 行软档门禁），
// 依赖由本文件在装配时注入（避免 index → 子模块 → index 的循环依赖，见各子模块头注释）。
const { createRecallMethods } = require('./recall');
const { createTeamMethods } = require('./team');

// ── P0-2b：来源可信度白名单（唯一事实来源）──
// 说明：trust 不单独建列——source 列本就持久化，trust 是 source 的确定性函数，
// 读取时经 trustOf() 推导，避免双列不一致（最小可靠实现）。
const SOURCE_TRUST = {
  user_input: 1.0,        // 用户显式输入/指令（如 /mem）
  model_conclusion: 0.6,  // 模型结论（默认来源；历史无 source 的条目也按此档）
  external_content: 0.2,  // 外部内容（网页/文件/MCP 输出等不可信来源）
  compressor: 0.6,        // 内部压缩产物（LLM 摘要，按模型结论档）
  'legacy-import': 0.6,   // 旧 JSON 记忆导入（源自历史自动写入的模型结论）
};
// 低于该可信度的来源默认不进 system prompt 注入（P0-2c）
const TRUST_THRESHOLD = 0.6;

// ── 三层记忆（M0，2026-10-20）：作用域（scope）与写入分流 ──
// scope 与 domain 正交：domain 是语义分类（会话/知识/反思…），scope 是记忆层级（可见范围与生存周期）。
//   session —— 本轮会话工作记忆：绑定 conversation_id，仅同会话可见（最强时效、最快衰减）
//   team    —— 团队记忆：绑定 team_id，仅同团队可见；agent_id 为空 = 团队共享（决议/约定/产物索引），
//              非空 = 该成员的私有长期记忆（可见范围 = 团队共享 ∪ 自身私有，见 _layerRows）
//   project —— 项目记忆：按 space_id 分区，项目内跨会话可见
//   global  —— 全局记忆：跨项目可见，仅「用户显式确认」的可信资产允许写入
// 顺序即层级优先级（晋升只允许自左向右）：跨层去重取更高优先级者。
// M5 / T5-5：新增 team —— 位置在 project **之下**（团队编制活在项目内，其结论的晋升方向是
//   team → project → global，与「只允许向上晋升」的 promoteScope 判据一致）。
const SCOPES = ['session', 'team', 'project', 'global'];
// 来源 → 默认作用域（写入分流的唯一事实来源，配合下方两条硬约束生效）
const SOURCE_DEFAULT_SCOPE = {
  user_input: 'project',       // 用户显式输入/指令：项目级资产
  model_conclusion: 'session', // 模型自动结论：本轮会话工作记忆（跨会话经压缩/晋升沉淀到项目级）
  compressor: 'project',       // 内部压缩摘要：跨会话的反思沉淀，直接进项目级
  external_content: 'session', // 外部内容：不可信，强制收敛到会话层
  'legacy-import': 'project',  // 旧记忆导入：历史沉淀按项目级（保持既有可召回语义）
};
// 分层召回配额（受控注入预算：会话 2 / 团队 3 / 项目 3 / 全局 2，合计 10 条上限）
const LAYER_QUOTA = { session: 2, team: 3, project: 3, global: 2 };

// ── 三层记忆 M2：晋升阈值（会话删除 salvage 与后台 promote-scope 共用，单一事实来源）──
//   salvageConversation：L1 命中≥3 或已长期固化（tier≥3）→ 沉淀为 L2（project）
//   后台 promote-scope：L1 命中≥3 → L2；L2 命中≥5 且来源 user_input → L3（global）
const SALVAGE_MIN_HITS = 3;
const SALVAGE_MIN_TIER = 3;
const PROMOTE_L1_MIN_HITS = 3;
const PROMOTE_L2_MIN_HITS = 5;
// ── M5 / T5-5：团队记忆阈值（提名制，单一事实来源）──
//   PROMOTE_TEAM_MIN_HITS：团队记忆进入「待晋升候选」的命中门槛（复用 L1→L2 的 3 次口径，
//     避免同一系统里并存两个「算不算高频」的判据）。
//   注意：门槛只决定「是否被提名」，是否真写入项目层永远由用户确认（U5 定案）。
const PROMOTE_TEAM_MIN_HITS = 3;

// ── P3-3：容量总闸常量 ──
const RECALL_SCAN_LIMIT = 200;        // recall 单次最多扫描打分的行数（按 updated_at 取最新窗口）
const RECALL_TOP_K_MAX = 50;          // Top-K 硬上限
const MAX_MEMORIES_PER_SPACE = 500;   // 单空间（项目）记忆总量上限（有效 + 失效）
// 三层记忆 M4：L3 全局层独立容量闸（设计文档 L1958 承诺）——全局资产跨项目唯一，按 scope 计数
const MAX_GLOBAL_MEMORIES = 300;
// M5 / T5-5：团队层独立容量闸（设计稿 §5「新增 MAX_TEAM_MEMORIES，建议 200」）——
//   按 team_id 计数：一个团队的共享 + 全部成员私有一并受此闸约束（团队是临时编制，
//   不留无限增长的工作痕迹）；超限先清失效行，再按 updated_at 最旧硬淘汰。
const MAX_TEAM_MEMORIES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_GRACE_MS = 7 * DAY_MS;  // 失效行物理删除宽限（P1-17：半衰期 + 7 天）

function trustOf(memory) {
  const s = String(memory?.source || '').trim();
  if (Object.prototype.hasOwnProperty.call(SOURCE_TRUST, s)) return SOURCE_TRUST[s];
  return SOURCE_TRUST.model_conclusion; // 未知来源（含历史 'ipc' 等）按模型结论档：不放大、不误杀
}

// 三层记忆 M0：作用域分流（唯一事实来源）——既遵循来源默认档，又施加两条硬约束：
//   ① external_content 不可信 → 强制收敛到会话层（禁止跨会话/跨项目传播不可信内容）；
//   ② 全局层是「用户显式确认的跨项目资产」→ 非 user_input 一律降级项目层（防自动沉淀污染全局）。
// 调用方传入非法 requestedScope（不在 SCOPES 内）时回落来源默认档，绝不写入未知作用域。
// M5 / T5-5：团队层多一条前置约束——必须携带归属键 teamId（无归属的团队记忆永不召回、
//   永不晋升，是纯孤儿行），缺失时回落来源默认档，而不是造一个无团队的 scope='team'。
function resolveScope({ source = '', requestedScope, teamId = null } = {}) {
  const src = String(source || '').trim() || 'model_conclusion';
  const fallback = SOURCE_DEFAULT_SCOPE[src] || 'project';
  const want = SCOPES.includes(requestedScope) ? requestedScope : fallback;
  const scope = (want === 'team' && !teamId) ? fallback : want;
  if (src === 'external_content') return 'session';
  if (scope === 'global' && src !== 'user_input') return 'project';
  return scope;
}

// P0-2b：内容归一化——trim + 连续空白压缩为单空格 + 大小写折叠（去重键的计算基础）
function normalizeContent(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// P0-2b：归一化内容的 sha1 十六进制前 16 位
function contentHashOf(normalized) {
  return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

class MemoryManager {
  // deps: { db, onChange? }（better-sqlite3 或 sql.js 适配层）
  // 三层记忆 M3：onChange({ scope, spaceId }) 为变更通知钩子——缺省空实现，不影响既有调用方；
  // 宿主据此驱动文件双通道导出视图（SQLite 仍是唯一事实来源）。
  constructor({ db, onChange = null }) {
    this.db = db;
    this.onChange = onChange;
    this.writeChain = Promise.resolve(); // 写锁：异步操作（如压缩的 LLM 调用）串行排队
    this._ensureHashColumn();
    this._ensureScopeColumns();
  }

  // 三层记忆 M3：变更通知（文件导出视图触发源）。异常不影响写入（fail-open）。
  _notify(scope, spaceId = null) {
    try { this.onChange?.({ scope, spaceId: spaceId || null }); } catch { /* 通知失败不影响写入 */ }
  }

  _id() { return `mem-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; }
  _now() { return Date.now(); }

  // P0-2b：content_hash 列惰性补齐（幂等）。
  // 为什么不进 db/index.js 迁移链：该文件的迁移由任务编排底座统一维护，本模块只做
  // 「使用前确保列存在」的自包含补齐；两个驱动（better-sqlite3 / sql.js 适配层）
  // 均支持 PRAGMA table_info 与 ALTER TABLE。
  _ensureHashColumn() {
    try {
      const cols = this.db.prepare('PRAGMA table_info(memories)').all();
      if (!cols.some((c) => c.name === 'content_hash')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN content_hash TEXT');
        console.log('[memory] 已补齐 memories.content_hash 列（P0-2b 去重键）');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(space_id, domain, content_hash)');
    } catch (e) {
      // 补齐失败不阻断启动：去重退化为「同内容可重复插入」，召回过滤等其余能力不受影响
      console.warn('[memory] content_hash 列补齐失败（去重降级）：', e.message);
    }
  }

  // 三层记忆 M0：scope / conversation_id 列惰性补齐（幂等，与 _ensureHashColumn 同风格自包含）。
  // 为什么同样放本模块：db/index.js 的迁移链由任务编排底座统一维护，本模块只做「使用前确保列存在」。
  // 存量行 scope 缺省回落 'project'——历史记忆此前全部按项目空间归档，语义等价，无需数据回填。
  _ensureScopeColumns() {
    try {
      const names = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
      if (!names.has('scope')) {
        this.db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
        console.log('[memory] 已补齐 memories.scope 列（三层记忆作用域）');
      }
      if (!names.has('conversation_id')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN conversation_id TEXT');
        console.log('[memory] 已补齐 memories.conversation_id 列（L1 会话作用域绑定）');
      }
      // M5 / T5-5：团队层归属两列惰性补齐（与迁移 v11 同语义，幂等双保险）——
      // 迁移链归 db/index.js 维护，本模块只做「使用前确保列存在」，故两处并存不冲突。
      if (!names.has('team_id')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN team_id TEXT');
        console.log('[memory] 已补齐 memories.team_id 列（团队记忆归属）');
      }
      if (!names.has('agent_id')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN agent_id TEXT');
        console.log('[memory] 已补齐 memories.agent_id 列（团队记忆成员归属：NULL = 团队共享）');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(space_id, scope, conversation_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_team ON memories(team_id, agent_id)');
    } catch (e) {
      // 补齐失败不阻断启动：分层召回退化为单层（旧行为），其余能力不受影响
      console.warn('[memory] scope 列补齐失败（三层作用域降级为单层）：', e.message);
    }
  }

  // 串行化入口：所有「可能涉及 LLM 调用」的写操作排进写链，避免并发写脏数据
  _serialized(fn) {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => {}); // 链不因单次失败断裂
    return run;
  }

  // ── 写入（Tier1）──
  // 三层记忆 M0：新增 scope（作用域，缺省按来源默认档）+ conversationId（L1 会话层绑定）。
  // 作用域分流全部经 resolveScope（唯一事实来源），调用方无需自行判断约束。
  // M5 / T5-5：新增 teamId / agentId（团队层归属）——只有 scope 落定为 'team' 时才保留：
  //   agentId 为空 = 团队共享；非空 = 该成员私有。非团队层一律清空两列，避免「项目记忆挂团队键」
  //   这种既召回不到、又会让容量闸与晋升判据读错归属的脏数据。
  remember({ spaceId, domain = 'session', scope, conversationId = null, teamId = null, agentId = null, content, importance = 0.5, entityTags = [], source = '', summary = null }) {
    // P0-2b：来源白名单校验——未知来源拒绝写入并返回 null（调用方据此报错），
    // 不静默按模型结论档收留（那会让不可控来源混入长期记忆）
    const src = String(source || '').trim() || 'model_conclusion';
    if (!Object.prototype.hasOwnProperty.call(SOURCE_TRUST, src)) {
      console.warn(`[memory] 拒绝写入：未知来源「${src}」（白名单：${Object.keys(SOURCE_TRUST).join(' / ')}）`);
      return null;
    }
    const text = String(content || '').trim();
    if (!text) return null;
    let dom = ['private', 'session', 'global_knowledge', 'entity', 'reflection'].includes(domain) ? domain : 'session';
    // P0-2b：external_content 禁止入 global_knowledge——强制降级 session 域
    // （不可信内容不配进「长期知识域」，从入口切断污染正反馈）
    if (src === 'external_content' && dom === 'global_knowledge') {
      console.warn('[memory] external_content 来源禁止入 global_knowledge，已降级为 session 域');
      dom = 'session';
    }
    // 三层记忆 M0：作用域分流（约束在 resolveScope 内统一处理）
    const sc = resolveScope({ source: src, requestedScope: scope, teamId });
    // 只有会话层绑定 conversation_id；其余层一律解绑（跨会话可见，不受单会话生命周期影响）
    const conv = sc === 'session' && conversationId ? String(conversationId) : null;
    // M5 / T5-5：团队层归属两列（非团队层清空，见方法头注释）
    const team = sc === 'team' && teamId ? String(teamId) : null;
    const agent = team && agentId ? String(agentId) : null;
    const now = this._now();
    const space = spaceId || 'default';
    const hash = contentHashOf(normalizeContent(text));
    // 去重（去重键随作用域分化）：命中则刷新元数据，不重复 INSERT。
    // re_hit_count 不在此刷新：它只由召回命中驱动（recall），重复写入刷高会误触发
    // promoteByHits 的「高频晋升」，把一次性重复当成多次使用。
    const dup = this._findDup({ space, scope: sc, dom, hash, conversationId: conv, teamId: team, agentId: agent });
    if (dup) {
      this.db.prepare('UPDATE memories SET updated_at = ?, usage_count = usage_count + 1, source = ?, importance = MAX(importance, ?) WHERE id = ?')
        .run(now, src, Math.max(0, Math.min(1, Number(importance) || 0.5)), dup.id);
      this._notify(sc, space); // 三层记忆 M3：变更通知（文件导出视图）
      return this.get(dup.id);
    }
    const mem = {
      id: this._id(),
      space_id: space,
      scope: sc,
      conversation_id: conv,
      team_id: team,
      agent_id: agent,
      domain: dom,
      tier: 1,
      content: text.slice(0, 8000),
      summary: summary ? String(summary).slice(0, 2000) : null,
      importance: Math.max(0, Math.min(1, Number(importance) || 0.5)),
      entity_tags: JSON.stringify(Array.isArray(entityTags) ? entityTags.slice(0, 20) : []),
      expire_at: null,
      is_valid: 1,
      compressed: 0,
      re_hit_count: 0,
      usage_count: 0,
      source: src,
      created_at: now,
      updated_at: now,
      trust: trustOf({ source: src }), // 返回值与 _rowToMemory 输出同构（含可信度）
    };
    this.db.prepare(`INSERT INTO memories (id, space_id, scope, conversation_id, team_id, agent_id, domain, tier, content, summary, importance, entity_tags,
      expire_at, is_valid, compressed, re_hit_count, usage_count, source, created_at, updated_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mem.id, mem.space_id, mem.scope, mem.conversation_id, mem.team_id, mem.agent_id, mem.domain, mem.tier, mem.content, mem.summary, mem.importance,
        mem.entity_tags, mem.expire_at, mem.is_valid, mem.compressed, mem.re_hit_count, mem.usage_count,
        mem.source, mem.created_at, mem.updated_at, hash);
    this._enforceSpaceCap(space); // P3-3：容量总闸（写入侧）
    if (sc === 'global') this._enforceGlobalCap(); // 三层记忆 M4：L3 全局层独立容量闸
    if (sc === 'team' && team) this._enforceTeamCap(team); // M5 / T5-5：团队层独立容量闸
    this._notify(sc, space); // 三层记忆 M3：变更通知（文件导出视图）
    // 与去重命中路径返回同构（统一经 _rowToMemory：camelCase + 含 scope/conversationId/trust），
    // 避免「新插入返 snake_case、重复写入返 camelCase」的双形态给调用方造成字段歧义。
    return this.get(mem.id);
  }

  // 三层记忆 M0：去重键随作用域分化——
  //   session —— 含 conversation_id（不同会话的同内容各自独立，避免跨会话互相覆盖归属）；
  //   team    —— team_id + agent_id（共享与各成员私有互不覆盖：同内容在共享与成员私有各存一份）；
  //   global  —— 忽略 space_id（全局资产跨项目唯一，避免同内容在多个项目各存一份）；
  //   project —— space_id + scope + domain + content_hash。
  _findDup({ space, scope, dom, hash, conversationId, teamId, agentId }) {
    if (scope === 'session') {
      return this.db.prepare('SELECT * FROM memories WHERE space_id = ? AND scope = ? AND domain = ? AND content_hash = ? AND conversation_id IS ? LIMIT 1')
        .get(space, scope, dom, hash, conversationId);
    }
    if (scope === 'global') {
      return this.db.prepare('SELECT * FROM memories WHERE scope = ? AND domain = ? AND content_hash = ? LIMIT 1')
        .get(scope, dom, hash);
    }
    // M5 / T5-5：团队层去重键含归属两列——共享（agent_id IS NULL）与成员私有互不吞并，
    // 同一结论「团队共享 + 某成员私有」可各自独立存在（私有是成员的个体上下文，不该被共享覆盖）。
    if (scope === 'team') {
      return this.db.prepare('SELECT * FROM memories WHERE scope = ? AND team_id = ? AND agent_id IS ? AND domain = ? AND content_hash = ? LIMIT 1')
        .get(scope, teamId || null, agentId || null, dom, hash);
    }
    return this.db.prepare('SELECT * FROM memories WHERE space_id = ? AND scope = ? AND domain = ? AND content_hash = ? LIMIT 1')
      .get(space, scope, dom, hash);
  }

  // P3-3 / M4：容量硬闸通用实现（空间闸与全局层闸共用淘汰口径，单一事实来源）——
  //   ① 先物理删已失效且过宽限期的行（与 cleanupJob 同口径）；② 仍超限则按 victimDomain
  //   淘汰最旧行（null = 淘汰最旧任意行）。硬闸必须硬删——只置 is_valid=0 不缩表，闸门合不拢。
  //   where/args 为计数与淘汰共用的范围条件（空间闸：space_id=?；全局层闸：scope='global'）。
  _enforceCap({ label, limit, where, args, victimDomain = null }) {
    const count = () => this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(...args).n;
    if (count() <= limit) return 0;
    let removed = 0;
    const stale = this.db.prepare(`DELETE FROM memories WHERE ${where} AND is_valid = 0 AND updated_at < ?`)
      .run(...args, this._now() - INVALID_GRACE_MS);
    removed += stale.changes || 0;
    const still = count() - limit;
    if (still > 0) {
      const dom = victimDomain ? ` AND domain = '${victimDomain}'` : '';
      const victims = this.db.prepare(`SELECT id FROM memories WHERE ${where}${dom} ORDER BY updated_at ASC LIMIT ?`)
        .all(...args, still);
      for (const v of victims) { this.db.prepare('DELETE FROM memories WHERE id = ?').run(v.id); removed += 1; }
      if (victims.length) console.warn(`[memory] ${label}超容量硬闸（${limit} 条），物理淘汰最旧记忆 ${victims.length} 条`);
    }
    return removed;
  }

  // P3-3：单空间容量总闸——超限淘汰最旧 session 域行（瞬时域优先）；global_knowledge /
  //   entity / reflection 为受保护知识资产，宁可超限也不自动删（交用户在 UI 处理）。
  _enforceSpaceCap(spaceId) {
    return this._enforceCap({
      label: `空间 ${spaceId}`, limit: MAX_MEMORIES_PER_SPACE,
      where: 'space_id = ?', args: [spaceId], victimDomain: 'session',
    });
  }

  // M4：L3 全局层独立容量闸——按 scope 计数（忽略 space_id，全局资产跨项目唯一）。
  //   L3 无「瞬时域」可优先淘汰，故按 updated_at 最旧硬淘汰（确定性 LRU）；晋升进入 L3 同样受此闸约束；
  //   Tier3 固化条目不例外（物理上限 ≠ 时间衰减豁免）。
  _enforceGlobalCap() {
    return this._enforceCap({
      label: '全局层（scope=global）', limit: MAX_GLOBAL_MEMORIES,
      where: "scope = 'global'", args: [], victimDomain: null,
    });
  }

  // M5 / T5-5：团队层独立容量闸 _enforceTeamCap 与团队记忆召回/晋升族已抽至 ./team.js
  //（2026-10-20 拆分护 800 行门禁），本处仅保留装配注记——实现见 createTeamMethods 注入。

  _rowToMemory(r) {
    return r ? {
      id: r.id, spaceId: r.space_id, domain: r.domain, tier: r.tier,
      // 三层记忆 M0：作用域/会话绑定/内容去重键随条目输出（缺失列时回落：scope=project、其余 null）
      scope: r.scope || 'project', conversationId: r.conversation_id || null, contentHash: r.content_hash || null,
      // M5 / T5-5：团队归属两列（非团队层为 null）——渲染层/宿主据此区分「团队共享 vs 成员私有」
      teamId: r.team_id || null, agentId: r.agent_id || null,
      content: r.content, summary: r.summary, importance: r.importance,
      entityTags: (() => { try { return JSON.parse(r.entity_tags || '[]'); } catch { return []; } })(),
      expireAt: r.expire_at, isValid: !!r.is_valid, compressed: !!r.compressed,
      reHitCount: r.re_hit_count, usageCount: r.usage_count, source: r.source,
      trust: trustOf(r), // P0-2b：可信度随条目输出（由 source 推导）
      createdAt: r.created_at, updatedAt: r.updated_at,
    } : null;
  }

  get(id) {
    return this._rowToMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
  }

  // 三层记忆 M0：局部更新（不可变字段保持不动：id / tier / 命中计数 / 创建时间 / 作用域）。
  // 改 content 时同步重算 content_hash，保证去重键与内容一致；无有效补丁时原样返回。
  updateMemory(id, patch = {}) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row) return null;
    const sets = [];
    const vals = [];
    if (typeof patch.content === 'string' && patch.content.trim()) {
      const text = patch.content.trim().slice(0, 8000);
      sets.push('content = ?', 'content_hash = ?');
      vals.push(text, contentHashOf(normalizeContent(text)));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'summary')) {
      sets.push('summary = ?');
      vals.push(patch.summary ? String(patch.summary).slice(0, 2000) : null);
    }
    if (patch.importance != null) {
      sets.push('importance = ?');
      vals.push(Math.max(0, Math.min(1, Number(patch.importance) || 0)));
    }
    if (Array.isArray(patch.entityTags)) {
      sets.push('entity_tags = ?');
      vals.push(JSON.stringify(patch.entityTags.slice(0, 20)));
    }
    if (patch.domain && ['private', 'session', 'global_knowledge', 'entity', 'reflection'].includes(patch.domain)) {
      sets.push('domain = ?');
      vals.push(patch.domain);
    }
    if (!sets.length) return this.get(id);
    sets.push('updated_at = ?');
    vals.push(this._now());
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    this._notify(row.scope || 'project', row.space_id); // 三层记忆 M3：变更通知
    return this.get(id);
  }

  // ── B-16 收口（2026-10-21）：按作用域批量降权（单条 SQL，不再 N 次 UPDATE）──
  // 重置成员会话时，旧实现先 list(200) 再逐条 updateMemory ⇒ 最多 200 次同步写。
  // 现在一条 UPDATE 完成同样的语义（importance = MIN(floor, importance * factor)），
  // 且只命中 importance > floor 的条目（幂等：重复重置不会继续往下压）。
  // 返回受影响行数（用于审计文案）。
  demoteImportance({ scope, spaceId, teamId, agentId, floor = 0.2, factor = 0.5 } = {}) {
    const s = String(scope || 'team');
    if (!['session', 'team', 'project', 'global'].includes(s)) return 0;
    const where = ['scope = ?', 'importance > ?'];
    const params = [s, floor];
    if (s === 'team') {
      if (!teamId) return 0;
      where.push('team_id = ?');
      params.push(String(teamId));
      if (agentId) { where.push('agent_id = ?'); params.push(String(agentId)); }
    } else if (spaceId) {
      where.push('space_id = ?');
      params.push(String(spaceId));
    } else {
      return 0;
    }
    const r = this.db.prepare(
      `UPDATE memories SET importance = MIN(?, importance * ?), updated_at = ?
       WHERE ${where.join(' AND ')}`,
    ).run(floor, factor, this._now(), ...params);
    const changed = r.changes || 0;
    if (changed > 0) this._notify(s, s === 'global' ? null : (spaceId || null));
    return changed;
  }
  // ── 召回族（P2-6 / 三层记忆 M0 / M5-T5-5）已抽至 ./recall.js（2026-10-20 拆分护 800 行门禁）──
  // 本处仅保留装配注记：recall / _recallLayered / _layerRows / recallForPrompt / recallContents /
  // relevanceFor 的实现见 createRecallMethods 注入（依赖 SCOPES / LAYER_QUOTA / RECALL_* / trustOf）。

  // ── 压缩（P2-4）：同空间同域的未压缩 Tier1 批量合并为 1 条 Tier2 摘要 ──
  // chatOnce 由调用方注入（主进程非流式通道）；返回 { wrote, skipped } 供后台任务记账
  async compress({ spaceId, domain = 'session', batchSize = 10, chatOnce, model }) {
    return this._serialized(async () => {
      const rows = this.db.prepare(`SELECT * FROM memories
        WHERE space_id = ? AND domain = ? AND tier = 1 AND compressed = 0 AND is_valid = 1 AND (scope IS NULL OR scope != 'team')
        ORDER BY updated_at ASC LIMIT ?`).all(spaceId || 'default', domain, batchSize);
      if (rows.length < 3) return { wrote: 0, skipped: rows.length, reason: '不足一批（<3 条）' };

      let summaryText = '';
      if (chatOnce && model) {
        try {
          const res = await chatOnce({
            ...model,
            messages: [
              { role: 'system', content: '你是记忆压缩器。把多条记忆合并为一条第三人称的结构化摘要（要点式，保留具体路径/命令/结论），不超过 500 字，不要评论。' },
              { role: 'user', content: rows.map((r, i) => `${i + 1}. ${r.content.slice(0, 500)}`).join('\n') },
            ],
          });
          summaryText = String(res?.content || '').trim();
        } catch (e) {
          return { wrote: 0, skipped: rows.length, reason: `压缩调用失败：${e.message}` };
        }
      }
      if (!summaryText) summaryText = rows.map((r) => r.content.slice(0, 120)).join('；').slice(0, 800);

      const now = this._now();
      const maxImportance = Math.max(...rows.map((r) => r.importance || 0));
      const mem = this.remember({
        spaceId, domain,
        content: summaryText,
        summary: summaryText.slice(0, 400),
        importance: Math.min(1, maxImportance + 0.1), // 摘要继承最高重要性并小幅提升
        entityTags: [],
        source: 'compressor',
      });
      // Tier2 落库后：源 Tier1 标记 compressed（保留原文供审计，但召回不再返回）
      this.db.prepare(`UPDATE memories SET tier = 2, compressed = 0, updated_at = ? WHERE id = ?`).run(now, mem.id);
      this.db.prepare(`UPDATE memories SET compressed = 1, updated_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`)
        .run(now, ...rows.map((r) => r.id));
      return { wrote: 1, compressed: rows.length, skipped: 0 };
    });
  }

  // ── 晋升（P3 前置简化版）：高频命中的 Tier2 → Tier3 固化 ──
  promoteByHits(minHits = 3) {
    const rows = this.db.prepare(`SELECT id FROM memories WHERE tier = 2 AND re_hit_count >= ? AND is_valid = 1`).all(minHits);
    for (const r of rows) {
      this.db.prepare('UPDATE memories SET tier = 3, importance = MIN(1, importance + 0.2), updated_at = ? WHERE id = ?')
        .run(this._now(), r.id);
    }
    return rows.length;
  }

  // 三层记忆 M2：按命中次数批量跨层晋升（后台维护任务 promote-scope 的处理器）。
  //   L1(session) 命中≥PROMOTE_L1_MIN_HITS → L2(project) 且解绑 conversation_id（跨会话可见）；
  //   L2(project) 命中≥PROMOTE_L2_MIN_HITS 且来源 user_input → L3(global)。
  // 全局层只收「用户显式输入」的高频资产：与 resolveScope 的全局硬约束同源——
  // 模型自动结论即使高频也只停在项目层，避免自动沉淀污染跨项目全局。
  // 单条晋升复用 promoteScope（唯一事实来源：仅向上、解绑会话、忽略失效条目）。
  promoteScopeByHits({ l1MinHits = PROMOTE_L1_MIN_HITS, l2MinHits = PROMOTE_L2_MIN_HITS } = {}) {
    let toProject = 0;
    let toGlobal = 0;
    const l1 = this.db.prepare("SELECT id FROM memories WHERE scope = 'session' AND is_valid = 1 AND re_hit_count >= ?").all(l1MinHits);
    for (const r of l1) if (this.promoteScope(r.id, 'project')) toProject += 1;
    const l2 = this.db.prepare("SELECT id FROM memories WHERE scope = 'project' AND is_valid = 1 AND re_hit_count >= ? AND source = 'user_input'").all(l2MinHits);
    for (const r of l2) if (this.promoteScope(r.id, 'global')) toGlobal += 1;
    return { toProject, toGlobal };
  }

  // ── P1-17：人工确认长期留存（confirm/promote）──
  // 语义：global_knowledge 等域的半衰期衰减只作用于 tier < 3（见 decayJob）；用户显式
  // 晋升 Tier3 后，该条不再被时间衰减失效，也不再被容量总闸优先淘汰——
  // 「需人工确认才长期留存」的落地口。失效条目不予晋升（先作废再确认没有意义）。
  promoteToLongTerm(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row || !row.is_valid) return null;
    this.db.prepare('UPDATE memories SET tier = 3, importance = MIN(1, importance + 0.2), expire_at = NULL, updated_at = ? WHERE id = ?')
      .run(this._now(), id);
    return this.get(id);
  }

  // 三层记忆 M0：作用域晋升（session → project → global），用于会话删除时的 salvage 沉淀。
  // 仅允许向上晋升（SCOPES 层级自左向右）；离开会话层即解绑 conversation_id（跨会话可见）；
  // 已失效条目不晋升（先作废再确认/晋升没有意义）。非法目标返回 null；同级/降级保持不变（返回原条目）。
  promoteScope(id, targetScope) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row || !row.is_valid) return null;
    if (!SCOPES.includes(targetScope)) return null;
    const from = row.scope || 'project';
    if (SCOPES.indexOf(targetScope) <= SCOPES.indexOf(from)) return this.get(id);
    this.db.prepare('UPDATE memories SET scope = ?, conversation_id = NULL, updated_at = ? WHERE id = ?')
      .run(targetScope, this._now(), id);
    // 三层记忆 M4：晋升进入 L3 时同样受全局层容量闸约束（晋升不是绕过容量闸的口子）
    if (targetScope === 'global') this._enforceGlobalCap();
    // 三层记忆 M3：变更通知——来源层（失去该条目）与目标层（获得该条目）的文件视图都要刷新
    this._notify(from, row.space_id);
    this._notify(targetScope, row.space_id);
    return this.get(id);
  }

  // M5 / T5-5（U5）：团队记忆「待晋升候选」读取（listTeamPromotionCandidates）与
  // 团队→项目显式晋升（promoteTeamMemoryToProject）已抽至 ./team.js（2026-10-20 拆分护 800 行门禁）。
  // 本处仅保留装配注记：实现见 createTeamMethods 注入（依赖 PROMOTE_TEAM_MIN_HITS / MAX_TEAM_MEMORIES）。

  // 三层记忆 M2（决策 3）：会话删除时的 salvage 沉淀（两段式）。
  //   ① 先把该会话「有价值的」L1 晋升为项目级（跨会话留存）：命中≥SALVAGE_MIN_HITS 或已长期固化（tier≥SALVAGE_MIN_TIER）；
  //   ② 再物理删除该会话剩余的 L1（未被沉淀的瞬时工作记忆随会话一并清除）。
  // 为什么挂 purge 而非 archive：archive 可恢复（restoreThread），删早了会丢；purge 不可恢复，是最合适的沉淀点。
  // spaceId 可选：仅当调用方已知项目路径时用于收窄范围（会话行本就同 space，缺省按 conversationId 全量处理）。
  // 返回 { promoted, removed }：promoted=沉淀为项目级条数，removed=随会话物理删除条数。
  salvageConversation({ conversationId, spaceId = null } = {}) {
    const conv = conversationId == null || conversationId === '' ? null : String(conversationId);
    if (!conv) return { promoted: 0, removed: 0 };
    const filter = ["scope = 'session'", 'conversation_id IS ?'];
    const args = [conv];
    if (spaceId) { filter.push('space_id = ?'); args.push(spaceId); }
    const where = filter.join(' AND ');
    const rows = this.db.prepare(`SELECT id, tier, re_hit_count FROM memories WHERE ${where}`).all(...args);
    let promoted = 0;
    for (const r of rows) {
      if ((r.tier || 1) >= SALVAGE_MIN_TIER || (r.re_hit_count || 0) >= SALVAGE_MIN_HITS) {
        // 晋升后 scope='project' 且 conversation_id=NULL → 不再被下方 DELETE 命中
        if (this.promoteScope(r.id, 'project')) promoted += 1;
      }
    }
    const del = this.db.prepare(`DELETE FROM memories WHERE ${where}`).run(...args);
    // 三层记忆 M3：变更通知——会话层无文件视图，沉淀结果落在项目层（spaceId 收窄时按该空间刷新）
    this._notify('project', spaceId || null);
    return { promoted, removed: del.changes || 0 };
  }

  // 三层记忆 M0：作用域重置（清空某层）——
  //   session —— 按 conversation_id 精确删除该会话的工作记忆；
  //   project —— 按 space_id 删除该项目的项目级记忆；
  //   global  —— spaceId 缺省时清全部全局记忆（跨项目资产，属显式管理操作）。
  // M5 / T5-5：新增 team —— 必须携带 teamId（否则拒绝，避免「无归属键清空全表」的静默误删）。
  resetScope({ scope, spaceId = null, conversationId = null, teamId = null } = {}) {
    if (!SCOPES.includes(scope)) return 0;
    let r;
    if (scope === 'session') {
      r = this.db.prepare('DELETE FROM memories WHERE scope = ? AND conversation_id IS ?').run(scope, conversationId || null);
    } else if (scope === 'global' && !spaceId) {
      r = this.db.prepare("DELETE FROM memories WHERE scope = 'global'").run();
    } else if (scope === 'team') {
      if (!teamId) return 0;
      r = this.db.prepare("DELETE FROM memories WHERE scope = 'team' AND team_id = ?").run(String(teamId));
    } else {
      r = this.db.prepare('DELETE FROM memories WHERE scope = ? AND space_id = ?').run(scope, spaceId || 'default');
    }
    if ((r.changes || 0) > 0) this._notify(scope, scope === 'global' ? null : (spaceId || null)); // 三层记忆 M3：变更通知
    return r.changes || 0;
  }

  // ── 衰减（P2-3 时间维度的批量执行）：importance 按分域/分层半衰期衰减，低分失效 ──
  // P1-17：分域半衰期（session 7 天 / entity 30 天 / global_knowledge 30 天），
  // 三层记忆 M4：改为按 scope 取半衰期（session 7 / project 30 / global 90），domain 作兼容回落，
  // 把「一条污染记忆约 54 天才物理删除」提速到「半衰期 + 7 天宽限」。
  decayJob({ minImportance = 0.05 } = {}) {
    const rows = this.db.prepare('SELECT id, scope, domain, importance, updated_at FROM memories WHERE is_valid = 1 AND tier < 3').all();
    const now = this._now();
    const DAY = DAY_MS;
    let decayed = 0;
    let invalidated = 0;
    for (const r of rows) {
      const days = Math.max(0, (now - r.updated_at) / DAY);
      if (days < 1) continue; // 1 天内不打折
      const halfLife = halfLifeDaysFor(r.scope || r.domain); // 三层记忆 M4：scope 优先（域回落）
      const next = (r.importance || 0) * Math.pow(0.5, days / halfLife);
      if (next < minImportance) {
        this.db.prepare('UPDATE memories SET is_valid = 0, updated_at = ? WHERE id = ?').run(now, r.id);
        invalidated += 1;
      } else if (Math.abs(next - r.importance) > 0.01) {
        this.db.prepare('UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?').run(next, now, r.id);
        decayed += 1;
      }
    }
    // 三层记忆 M3：失效跨空间/跨层发生，通知按层泛化（spaceId 缺省 = 刷新该层全部空间的文件视图）
    if (invalidated > 0) { this._notify('project'); this._notify('global'); }
    return { decayed, invalidated };
  }

  // ── 清理：失效且过宽限期的记忆物理删除（防膨胀）──
  // P1-17：宽限 7 天 = 半衰期衰减到失效后仍留 7 天可人工回看；expire_at 到期的直接删。
  cleanupJob({ graceDays = 7 } = {}) {
    const cutoff = this._now() - graceDays * DAY_MS;
    const r1 = this.db.prepare('DELETE FROM memories WHERE is_valid = 0 AND updated_at < ?').run(cutoff);
    const r2 = this.db.prepare('DELETE FROM memories WHERE expire_at IS NOT NULL AND expire_at < ?').run(this._now());
    if ((r1.changes + r2.changes) > 0) { this._notify('project'); this._notify('global'); } // 三层记忆 M3：变更通知
    return { purged: r1.changes + r2.changes };
  }

  // ── 失效（显式：被新事实推翻时；设置页单条作废也走这里）──
  invalidate(id, reason = '') {
    const row = this.db.prepare('SELECT scope, space_id FROM memories WHERE id = ?').get(id);
    this.db.prepare('UPDATE memories SET is_valid = 0, source = COALESCE(source, \'\') || ?, updated_at = ? WHERE id = ?')
      .run(reason ? `（失效原因：${String(reason).slice(0, 100)}）` : '', this._now(), id);
    if (row) this._notify(row.scope || 'project', row.space_id); // 三层记忆 M3：变更通知（失效条目从导出视图移除）
    return this.get(id);
  }

  // ── 列表（P0-2c 记忆管理 UI 数据源）：项目维度分页，含可信度/域/层级/有效期 ──
  // M5 / T5-5：新增可选 scope/teamId/agentId 过滤——记忆面板按层筛选与团队视图取数用；
  //   缺省保持原「按 space_id 全量」旧行为（向后兼容既有调用方）。
  list({ spaceId, limit = 50, offset = 0, includeInvalid = false, scope = null, teamId = null, agentId = null } = {}) {
    const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
    const off = Math.max(0, Number(offset) || 0);
    const conds = [];
    const args = [];
    if (scope === 'global') {
      conds.push("scope = 'global'"); // 全局层忽略空间（跨项目资产）
    } else {
      conds.push('space_id = ?');
      args.push(spaceId || 'default');
      if (SCOPES.includes(scope)) { conds.push('scope = ?'); args.push(scope); }
    }
    if (teamId) { conds.push('team_id = ?'); args.push(String(teamId)); }
    if (agentId) { conds.push('agent_id = ?'); args.push(String(agentId)); }
    if (!includeInvalid) conds.push('is_valid = 1');
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...args, lim, off);
    return rows.map((r) => this._rowToMemory(r));
  }

  // 三层记忆 M3：按作用域取数（管理 UI 分层计数 + 文件导出视图取数）。
  //   global —— 忽略空间（跨项目资产）；session/project —— 限定空间（container 的会话/项目层）。
  // M5 / T5-5：team —— 按 team_id 取（共享 + 全部成员私有；团队视图不混入空间维度）。
  listScope({ scope, spaceId = null, teamId = null, limit = 500 } = {}) {
    if (!SCOPES.includes(scope)) return [];
    const lim = Math.min(Math.max(1, Number(limit) || 500), 500);
    if (scope === 'global') {
      return this.db.prepare(`SELECT * FROM memories WHERE scope = 'global' AND is_valid = 1
        ORDER BY updated_at DESC LIMIT ?`).all(lim).map((r) => this._rowToMemory(r));
    }
    if (scope === 'team') {
      if (!teamId) return []; // 无归属键取不到任何团队记忆（防「取全表」的静默错误）
      return this.db.prepare(`SELECT * FROM memories WHERE scope = 'team' AND team_id = ? AND is_valid = 1
        ORDER BY updated_at DESC LIMIT ?`).all(String(teamId), lim).map((r) => this._rowToMemory(r));
    }
    return this.db.prepare(`SELECT * FROM memories WHERE scope = ? AND space_id = ? AND is_valid = 1
      ORDER BY updated_at DESC LIMIT ?`).all(scope, spaceId || 'default', lim).map((r) => this._rowToMemory(r));
  }

  // 三层记忆 M3：存在项目级记忆的空间集合（文件双通道导出视图遍历用）。
  projectSpaces() {
    return this.db.prepare("SELECT DISTINCT space_id FROM memories WHERE scope = 'project' AND is_valid = 1")
      .all().map((r) => r.space_id).filter((s) => s && s !== 'default');
  }

  // ── 统计（可视化 UI 数据源）──
  stats() {
    const rows = this.db.prepare(`SELECT domain, tier, COUNT(*) AS n FROM memories WHERE is_valid = 1
      GROUP BY domain, tier`).all();
    // 三层记忆 M3：按作用域计数（管理 UI 分层仪表盘）
    const scopeRows = this.db.prepare('SELECT scope, COUNT(*) AS n FROM memories WHERE is_valid = 1 GROUP BY scope').all();
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE is_valid = 1').get().n;
    const bg = this.db.prepare(`SELECT status, COUNT(*) AS n FROM memory_bg_tasks GROUP BY status`).all();
    return { total, byDomainTier: rows, byScope: scopeRows, bgTasks: bg };
  }

  // ── 旧 JSON 记忆一次性导入（localStore POC → SQLite）──
  // P1-16：按条目幂等——remember 的 hash 去重保证重复导入只刷新元数据不重复插，
  // 主进程因此可在导入后安全清空 localStore 的 JSON 轨（见 main.js 迁移点）。
  importLegacy(items) {
    let n = 0;
    for (const it of items || []) {
      if (!it?.content) continue;
      this.remember({
        spaceId: it.projectPath || 'default',
        domain: 'global_knowledge',
        content: it.content,
        importance: 0.5,
        source: 'legacy-import',
      });
      n += 1;
    }
    return n;
  }

  // 三层记忆 M0：批量导入（可显式指定 scope，供团队共享项目记忆 / 记忆文件导入用）。
  // 与 importLegacy 的差别：这里逐条接受 scope/domain/source 覆盖，且默认走项目级（团队共享语义）；
  // 幂等仍由 remember 的去重键保证（重复导入只刷新元数据，不重复插）。
  importItems(items, { scope = 'project', onlyNew = false, source = 'legacy-import' } = {}) {
    let n = 0;
    for (const it of items || []) {
      if (!it?.content) continue;
      const space = it.projectPath || it.spaceId || 'default';
      const sc = it.scope || scope;
      // 三层记忆 M3：onlyNew —— 文件导入时跳过「内容已存在」条目（含失效行），
      // 避免重复写入经去重路径刷新来源/语义域（防「自写自读」污染），也防已删除条目的复活。
      if (onlyNew && this._hashExists({ space, scope: sc, hash: contentHashOf(normalizeContent(it.content)) })) continue;
      const m = this.remember({
        spaceId: space,
        domain: it.domain || 'global_knowledge',
        scope: sc,
        conversationId: it.conversationId || null,
        content: it.content,
        summary: it.summary || null,
        importance: it.importance == null ? 0.5 : it.importance,
        entityTags: it.entityTags || [],
        source: it.source || source,
      });
      if (m) n += 1;
    }
    return n;
  }

  // 三层记忆 M3：内容哈希存在性判断（不筛 is_valid——失效条目视为已存在，不因导入而复活）
  _hashExists({ space, scope, hash }) {
    if (scope === 'global') {
      return !!this.db.prepare('SELECT 1 AS x FROM memories WHERE scope = ? AND content_hash = ? LIMIT 1').get(scope, hash);
    }
    return !!this.db.prepare('SELECT 1 AS x FROM memories WHERE space_id = ? AND scope = ? AND content_hash = ? LIMIT 1')
      .get(space || 'default', scope, hash);
  }

  // 词法相关性（relevanceFor）随召回族一并抽至 ./recall.js（见 createRecallMethods 注入）。
}

// M5 / T5-5 拆分装配（2026-10-20）：把抽取的召回族与团队记忆族方法装回 MemoryManager.prototype。
// 依赖注入：常量与 trustOf 来自本文件的单一事实来源；子模块直接 require('./scorer') 取打分器（无环）。
Object.assign(
  MemoryManager.prototype,
  createRecallMethods({ SCOPES, LAYER_QUOTA, RECALL_SCAN_LIMIT, RECALL_TOP_K_MAX, TRUST_THRESHOLD, trustOf }),
  createTeamMethods({ PROMOTE_TEAM_MIN_HITS, MAX_TEAM_MEMORIES, RECALL_SCAN_LIMIT, RECALL_TOP_K_MAX, trustOf }),
);

module.exports = {
  MemoryManager, SOURCE_TRUST, TRUST_THRESHOLD, normalizeContent, contentHashOf, trustOf,
  // 三层记忆 M0：作用域分流与常量（供宿主/测试统一引用，避免各处重写规则）
  resolveScope, SCOPES, SOURCE_DEFAULT_SCOPE, LAYER_QUOTA,
  // 三层记忆 M2：晋升阈值（salvage / promote-scope 共用同一事实来源）
  SALVAGE_MIN_HITS, SALVAGE_MIN_TIER, PROMOTE_L1_MIN_HITS, PROMOTE_L2_MIN_HITS,
  // 三层记忆 M4：容量闸常量（空间闸 500 / L3 全局层闸 300）
  MAX_MEMORIES_PER_SPACE, MAX_GLOBAL_MEMORIES,
  // M5 / T5-5：团队层常量（提名制阈值 + 团队层容量闸；供宿主/i18n/测试统一引用）
  PROMOTE_TEAM_MIN_HITS, MAX_TEAM_MEMORIES,
};
