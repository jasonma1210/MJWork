// 召回族（P2-6 / 三层记忆 M0 / M5-T5-5）：从 memory/index.js 抽出（2026-10-20）——
// 触发原因：记忆模块新增团队记忆（T5-5）后越过 800 行软档门禁（God File 苗头），按项目纪律
// 「先拆再合入」抽出本模块；语义与实现**原样迁移**，不在拆分中夹带任何行为变更。
//
// 依赖注入（为何用工厂而非直接 require index.js）：
//   · 本模块要用到 index.js 持有的单一事实来源常量（SCOPES / LAYER_QUOTA / RECALL_* / TRUST_THRESHOLD）
//     与可信度函数 trustOf；若直接 require('./index.js') 会形成 index → recall → index 的循环依赖，
//     故改由 index.js 在装配时把这些依赖**注入**进来（createRecallMethods(deps)）。
//   · 打分器（scoreMemory / relevance）是无副作用的独立子模块，直接 require('./scorer') 无环。
const { scoreMemory, relevance } = require('./scorer');

// T-07：注入总长预算（字符）——主对话与 Worker 的记忆注入共用这一上界。
//   此前主对话路径（recallContents → 渲染层前缀 → system prompt）**没有任何长度预算**，
//   而记忆条目正文最长可达 5 万字符（IPC 边界上限），一次召回就能把上下文撑爆。
//   预算语义落在 recallContents（生产路径）上，recallForPrompt 与它共用同一份装配实现。
const RECALL_CONTENT_BUDGET_CHARS = 4000;

/**
 * 构造召回族方法集合，供 index.js 装配到 MemoryManager.prototype。
 * @param {object} deps index.js 的单一事实来源常量与可信度函数
 * @returns {object} 方法集合（recall / _recallLayered / _layerRows / recallForPrompt /
 *   recallContents / relevanceFor）——全部依赖 this（实例）与闭包内的 deps。
 */
function createRecallMethods({
  SCOPES, LAYER_QUOTA, RECALL_SCAN_LIMIT, RECALL_TOP_K_MAX, TRUST_THRESHOLD, trustOf,
}) {
  return {
    // ── 分层召回路由（P2-6）──
    // 路由顺序：先 Tier3/Tier2（摘要层，性价比高）→ Tier1（原文）；按六因子 Top-K 重排。
    // query 为空（如启动注入）→ 跳过相关性因子，退化为 importance×recency 排序。
    // P3-3：限量载入 + Top-K 钳制——只扫描最近 scanLimit 条进入打分（复杂度 O(scanLimit)，
    // 与记忆总量解耦）；topK 超硬上限时按上限截断。
    // 三层记忆 M0：新增 scopes（作用域数组）+ conversationId。传入 scopes 即走分层模式
    // （每层按 LAYER_QUOTA 配额、跨层同 content_hash 去重）；缺省保持单空间旧行为（向后兼容）。
    recall({ spaceId, query = '', topK = null, scopes = null, conversationId = null, teamId = null, agentId = null, domains = null, minScore = 0, scanLimit = RECALL_SCAN_LIMIT }) {
      const space = spaceId || 'default';
      const scan = Math.min(Math.max(1, Number(scanLimit) || RECALL_SCAN_LIMIT), RECALL_SCAN_LIMIT);
      if (Array.isArray(scopes) && scopes.length) {
        // T-01：topK 必须透进分层分支——此前分层路径完全不看 topK，
        // 「Top-3 注入」实为最多 Σ层配额 条（7 条），limit 语义失真。
        return this._recallLayered({ space, query, topK, scopes, conversationId, teamId, agentId, domains, minScore, scan });
      }
      const k = Math.min(Math.max(1, Number(topK) || 5), RECALL_TOP_K_MAX);
      const rows = this.db.prepare(
        'SELECT * FROM memories WHERE space_id = ? AND is_valid = 1 AND compressed = 0 ORDER BY tier DESC, updated_at DESC LIMIT ?'
      ).all(space, scan);
      const memories = rows.map((r) => this._rowToMemory(r))
        .filter((m) => !domains || domains.includes(m.domain));
      const scored = memories
        // P0-2c：可信度乘子——external_content 0.2 / model_conclusion 0.6 / user_input 1.0，
        // 低可信条目即使被返回也排在低权重位置
        .map((m) => ({ memory: m, score: scoreMemory(m, { query }), trust: trustOf(m) }))
        .map((x) => ({ memory: x.memory, score: { ...x.score, total: x.score.total * x.trust } }))
        .filter((x) => x.score.total > minScore)
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, k);
      // 命中反馈：re_hit_count / usage_count 自增（防抖合并刷盘由 SQLite 同步写承担，量级极小）
      for (const { memory } of scored) {
        this.db.prepare('UPDATE memories SET re_hit_count = re_hit_count + 1, usage_count = usage_count + 1, updated_at = ? WHERE id = ?')
          .run(this._now(), memory.id);
      }
      return scored.map(({ memory, score }) => ({ ...memory, score: Number(score.total.toFixed(4)) }));
    },

    // 三层记忆 M0：分层召回（session 配额 2 / project 3 / global 2）。
    //   ① 每层独立扫描打分，各取本层配额（受 RECALL_TOP_K_MAX 硬上限约束）；
    //   ② 按层优先级（session > project > global）合并，跨层同 content_hash 去重（先入者即高层，胜出）；
    //   ③ 结果按总分重排，命中反馈与单层路径同口径。
    // T-01：全局 topK 与每层配额**取更严格者**——每层取 min(层配额, topK)，
    //   合并后再按全局 topK 截断。两者同时生效才不会让「Top-3」变成「Top-7」。
    // topK 缺省（null）= **不额外截断**，只受每层配额约束——这是分层路径的既有契约
    //   （「分层配额严格封顶」门禁断言总数 = 配额和）；显式给出 topK 时才额外收紧。
    //   单空间旧路径不受影响：那里的缺省仍是 5 条。
    // 无会话上下文（conversationId 缺省）时跳过会话层——不注入无法归属的会话工作记忆。
    _recallLayered({ space, query, topK = null, scopes, conversationId, teamId, agentId, domains, minScore, scan }) {
      const k = topK == null
        ? RECALL_TOP_K_MAX
        : Math.min(Math.max(1, Number(topK) || 5), RECALL_TOP_K_MAX);
      const collected = [];
      const seen = new Set();
      for (const sc of SCOPES) {
        if (!scopes.includes(sc)) continue;
        if (sc === 'session' && !conversationId) continue;
        // M5 / T5-5：团队层无 teamId 时跳过——不注入无法归属的团队记忆（与 session 同口径）
        if (sc === 'team' && !teamId) continue;
        const rows = this._layerRows({ space, scope: sc, conversationId, teamId, agentId, scan });
        const quota = Math.max(1, Math.min(LAYER_QUOTA[sc], RECALL_TOP_K_MAX, k));
        const scored = rows.map((r) => this._rowToMemory(r))
          .filter((m) => !domains || domains.includes(m.domain))
          .map((m) => ({ memory: m, score: scoreMemory(m, { query }), trust: trustOf(m) }))
          .map((x) => ({ memory: x.memory, score: { ...x.score, total: x.score.total * x.trust } }))
          .filter((x) => x.score.total > minScore)
          .sort((a, b) => b.score.total - a.score.total)
          .slice(0, quota);
        for (const x of scored) {
          const key = x.memory.contentHash || `id:${x.memory.id}`; // 跨层去重键：内容 hash（缺列回落 id）
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push(x);
        }
      }
      collected.sort((a, b) => b.score.total - a.score.total);
      const out = collected.slice(0, k);
      for (const { memory } of out) {
        this.db.prepare('UPDATE memories SET re_hit_count = re_hit_count + 1, usage_count = usage_count + 1, updated_at = ? WHERE id = ?')
          .run(this._now(), memory.id);
      }
      return out.map(({ memory, score }) => ({ ...memory, score: Number(score.total.toFixed(4)) }));
    },

    // 三层记忆 M0：单层取行（限量载入，scan 上限与旧路径同口径）。
    //   session —— 同空间 + 会话绑定；project —— 同空间；global —— 忽略空间（跨项目）。
    // M5 / T5-5：team 层——同 team_id，可见范围 = 团队共享（agent_id IS NULL）∪ 自身私有（agent_id = agentId）。
    //   无 teamId 时返回空（调用方 _recallLayered 已先行跳过，这里再兜一层保证单层调用安全）。
    _layerRows({ space, scope, conversationId, teamId, agentId, scan }) {
      if (scope === 'session') {
        return this.db.prepare(`SELECT * FROM memories WHERE space_id = ? AND scope = 'session' AND conversation_id IS ?
          AND is_valid = 1 AND compressed = 0 ORDER BY tier DESC, updated_at DESC LIMIT ?`).all(space, conversationId, scan);
      }
      if (scope === 'global') {
        return this.db.prepare(`SELECT * FROM memories WHERE scope = 'global'
          AND is_valid = 1 AND compressed = 0 ORDER BY tier DESC, updated_at DESC LIMIT ?`).all(scan);
      }
      if (scope === 'team') {
        if (!teamId) return [];
        return this.db.prepare(`SELECT * FROM memories WHERE scope = 'team' AND team_id = ? AND (agent_id IS NULL OR agent_id = ?)
          AND is_valid = 1 AND compressed = 0 ORDER BY tier DESC, updated_at DESC LIMIT ?`).all(teamId, agentId || null, scan);
      }
      return this.db.prepare(`SELECT * FROM memories WHERE space_id = ? AND scope = 'project'
        AND is_valid = 1 AND compressed = 0 ORDER BY tier DESC, updated_at DESC LIMIT ?`).all(space, scan);
    },

    // 三层记忆 M0：给主对话 / Worker 注入用的「预算内记忆文本块」。
    // 分层召回（session 2 / project 3 / global 2）→ 可信度过滤（低可信默认不进，query 显式命中才带）
    // → 按 budgetChars 逐条累积装配（超预算即停止）。返回可直接拼进 system prompt 的文本；
    // 无命中返回空串（调用方据此不注入「相关记忆」段）。
    // T-07：本函数过去**生产零调用**（只有测试调），而真正进 system prompt 的 recallContents
    //   路径没有任何长度上界——「有测试就以为有功能」。现在两者共用 _assembleWithinBudget
    //   这一份预算装配，预算语义落在生产路径上，本函数收敛为同一实现的文本出口。
    recallForPrompt({ projectPath, conversationId = null, teamId = null, agentId = null, query = '', budgetChars = RECALL_CONTENT_BUDGET_CHARS } = {}) {
      const q = String(query || '').trim();
      const hits = this.recall({
        spaceId: projectPath, query, scopes: [...SCOPES], conversationId, teamId, agentId,
        // 收敛口径是**预算**而非 topK——topK 给到硬上限，避免「先被 topK 悄悄截断再谈预算」
        topK: RECALL_TOP_K_MAX,
      });
      const picked = this._assembleWithinBudget(hits, {
        q, budgetChars, includeLowTrust: false,
        format: (m) => {
          const text = String(m.summary || m.content || '').replace(/\s+/g, ' ').trim();
          return text ? `- ${text}` : '';
        },
      });
      return picked.map((x) => x.unit).join('\n');
    },

    // T-07：预算装配的唯一实现（recallForPrompt 与 recallContents 共用）。
    // 为什么必须有一份：此前「预算」只写在 recallForPrompt 这条没人调的分支里，
    //   而生产路径（recallContents → 渲染层前缀 → system prompt）**没有任何长度上界**，
    //   两份实现迟早分叉成「测试里成立、生产里没有」。
    //
    // 语义：逐条累积，超预算即停；若**一条都装不下**，装入第一条并按预算截断——
    //   「召回为空」比「截断一条」更糟（主对话会彻底失去记忆上下文）。
    //   format 决定单条的最终注入文本（出口不同、排版不同：文本块带 "- " 前缀，对象出口是原正文）。
    _assembleWithinBudget(hits, { q, includeLowTrust, budgetChars, format }) {
      const kept = includeLowTrust
        ? hits
        : hits.filter((m) => trustOf(m) >= TRUST_THRESHOLD
          || (q && relevance(q, `${m.summary || ''}\n${m.content || ''}`) > 0));
      const budget = Math.max(0, Number(budgetChars) || 0);
      const picked = [];
      let used = 0;
      for (const m of kept) {
        const unit = String(format(m) || '');
        if (!unit) continue;
        if (picked.length === 0) {
          if (unit.length + 1 > budget) {
            // 兜底：首条即超预算 → 截断装入，保证「不为空」与「有上界」同时成立
            picked.push({ memory: m, unit: unit.slice(0, budget) });
            break;
          }
          picked.push({ memory: m, unit });
          used += unit.length + 1;
          continue;
        }
        if (used + unit.length + 1 > budget) break;
        picked.push({ memory: m, unit });
        used += unit.length + 1;
      }
      return picked;
    },

    // 注入格式兼容旧链路（renderer 取 content 列表）
    // P0-2c：域 + 可信度过滤——低可信（trust < TRUST_THRESHOLD，即 external_content）条目
    // 默认不进 system prompt 注入；仅当 query 显式命中（词法相关性 > 0）时才返回
    // （打分侧的 trust 乘子保证其权重仍然低）。
    // 三层记忆 M3：增 scopes/conversationId 分层模式，且输出 scope——渲染层据此加层级前缀
    // （`[个人]/[项目]/[本次会话]`）后注入 system prompt（引擎仍吃 string[]，零改动）。
    // T-07：budgetChars 给出**注入总长上界**（主对话此前无任何长度预算，条目正文最长可达 5 万字符）。
    // topK 缺省 = null（未显式收紧）：单空间路径回落旧的 5 条默认，分层路径只受每层配额约束。
    recallContents({ spaceId, query, topK = null, domains, includeLowTrust = false, scopes = null, conversationId = null, teamId = null, agentId = null, budgetChars = RECALL_CONTENT_BUDGET_CHARS }) {
      const q = String(query || '').trim();
      const hits = this.recall({ spaceId, query, topK, domains, scopes, conversationId, teamId, agentId });
      const picked = this._assembleWithinBudget(hits, {
        q, includeLowTrust, budgetChars,
        format: (m) => String(m.summary || m.content || ''),
      });
      return picked.map(({ memory: m, unit }) => ({
        // content 取**装配后的文本**（可能已被预算截断），不是原始正文——
        // 否则「有上界」只是账面上的：注入的仍是那条 5 万字符的原文。
        id: m.id, content: unit, domain: m.domain, scope: m.scope || 'project', trust: trustOf(m),
        // M5 / T5-5：团队归属透出（宿主据此区分共享/私有并编排召回文案）
        teamId: m.teamId || null, agentId: m.agentId || null,
      }));
    },

    // 词法相关性暴露给外部（Worker 注入时按任务标题查询）
    relevanceFor(query, text) { return relevance(query, text); },
  };
}

module.exports = { createRecallMethods };
