// DS Bots / T6-3：项目级滑动配额账本（设计稿 §8）——**唯一**配额判定入口。
//
// 与既有 groupBudget 的分工（§7.2，两者不可混用）：
//   · 本模块 = 项目配额：跨 run / 跨天的成本额度，滑动窗口老化，超限 → 暂停新推理、任务保留；
//   · groupBudget = 单次派活的成本信封：token 软告警、墙钟/轮次硬闸，run 结束即清。
// 派发预算取三者最小值（见 grant 的 clamp），不是谁覆盖谁。
//
// 口径（§8.1）：
//   available = total_limit − Σ(窗口内消耗) − Σ(内存预留)
//   · 老化是**查询口径**不是数据操作：消耗记录永不删除（保留审计），只按 created_at 过滤；
//   · 预留防超发：grant 即扣预留，settle 释放并写入实际值；
//   · 预留是内存态，进程重启归零——最多短暂超发一个任务预算，换掉「预留也要落库」的第二事实源。
//
// 时钟回拨（§8.5）：查询用传入 now，写入用 Date.now()；若 now 早于库内最新扣费时间，
//   以最新扣费时间为基准，避免「拨表把额度凭空恢复」。不做系统时间纠偏，只保证账本单调。
const DEFAULT_GRANT = 200000; // 单任务预算上限（§7.2 tokenBudget = min(项目剩余, 组剩余, 200k)）
const MIN_AVAILABLE = 1000;    // 绝对下限：低于此值一律视为不可派发

const QUOTA_STATES = ['ok', 'warn', 'throttle', 'suspended'];

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function rowToBucket(r) {
  if (!r) return null;
  return {
    projectId: r.project_id,
    totalLimit: safeNum(r.total_limit),
    windowSeconds: safeNum(r.window_seconds, 21600),
    warnRatio: safeNum(r.warn_ratio, 0.7),
    throttleRatio: safeNum(r.throttle_ratio, 0.9),
    resumeMinTokens: safeNum(r.resume_min_tokens, 100000),
    resumeHysteresisRatio: safeNum(r.resume_hysteresis_ratio, 0.85),
    tier: r.tier || 'standard',
    createdAt: safeNum(r.created_at),
    updatedAt: safeNum(r.updated_at),
  };
}

class QuotaLedger {
  constructor(db) {
    this.db = db;
    // taskId → { projectId, tokens }：授予但未结算的在途预算（进程内，单线程无竞态）
    this._reserved = new Map();
  }

  /** 桶不存在则按迁移默认值补建（3M / 6h）。幂等，可并发调用。 */
  ensureBucket(projectId, overrides = {}) {
    const id = String(projectId || '').trim();
    if (!id) throw new Error('projectId 必填');
    const now = Date.now();
    this.db.prepare(`INSERT OR IGNORE INTO quota_buckets (project_id, created_at, updated_at)
                     VALUES (?, ?, ?)`).run(id, now, now);
    if (overrides && Object.keys(overrides).length) this.updateBucket(id, overrides);
    return this.getBucket(id);
  }

  getBucket(projectId) {
    const id = String(projectId || '').trim();
    if (!id) return null;
    return rowToBucket(this.db.prepare('SELECT * FROM quota_buckets WHERE project_id = ?').get(id));
  }

  /** 调整桶配置（额度上限 / 窗口 / 水位）。只允许白名单字段，避免把整行写脏。 */
  updateBucket(projectId, patch = {}) {
    const map = {
      totalLimit: 'total_limit', windowSeconds: 'window_seconds',
      warnRatio: 'warn_ratio', throttleRatio: 'throttle_ratio',
      resumeMinTokens: 'resume_min_tokens', resumeHysteresisRatio: 'resume_hysteresis_ratio',
      tier: 'tier',
    };
    const sets = [];
    const args = [];
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] === undefined || patch[k] === null) continue;
      sets.push(`${col} = ?`);
      args.push(k === 'tier' ? String(patch[k]) : safeNum(patch[k]));
    }
    if (!sets.length) return this.getBucket(projectId);
    sets.push('updated_at = ?');
    args.push(Date.now(), String(projectId || '').trim());
    this.db.prepare(`UPDATE quota_buckets SET ${sets.join(', ')} WHERE project_id = ?`).run(...args);
    return this.getBucket(projectId);
  }

  /**
   * 删除配额桶及其消费流水——**仅用于初始化失败补偿**（T6-9）。
   * 账本本身不提供用户可见的删除（流水是审计事实），故不暴露给 IPC。
   */
  deleteBucket(projectId) {
    const id = String(projectId || '').trim();
    if (!id) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM quota_consumptions WHERE project_id = ?').run(id);
      return this.db.prepare('DELETE FROM quota_buckets WHERE project_id = ?').run(id).changes;
    });
    return !!tx();
  }

  /** 库内最新一笔扣费时间——时钟回拨的基准（§8.5）。 */
  latestConsumptionAt(projectId) {
    const r = this.db.prepare('SELECT MAX(created_at) AS ts FROM quota_consumptions WHERE project_id = ?')
      .get(String(projectId || '').trim());
    return safeNum(r && r.ts);
  }

  /** 有效 now：绝不早于库内最新扣费时间，防止拨表恢复额度。 */
  effectiveNow(projectId, now = Date.now()) {
    const n = safeNum(now, Date.now());
    return Math.max(n, this.latestConsumptionAt(projectId));
  }

  /** 窗口内已消耗 token（单一求和口径；老化=过滤，不删数据）。
   *  仅计团队任务的 round/settle 源——'chat'（单人对话收尾记账）不计入，避免闲聊挤占派发额度。 */
  usedInWindow(projectId, now = Date.now()) {
    const b = this.getBucket(projectId);
    if (!b) return 0;
    const anchor = this.effectiveNow(projectId, now);
    const from = anchor - b.windowSeconds * 1000;
    const r = this.db.prepare(`SELECT SUM(tokens) AS s FROM quota_consumptions
      WHERE project_id = ? AND created_at > ? AND source <> 'chat'`).get(String(projectId || '').trim(), from);
    return safeNum(r && r.s);
  }

  /** 某成员在窗口内的消耗（单 Bot 熔断的唯一数据源 §5.3）。
   *  同样排除 'chat' 源（单人对话未绑定成员，本就多为 null，此处按口径一并过滤）。 */
  memberUsed(projectId, memberId, windowMs, now = Date.now()) {
    const anchor = this.effectiveNow(projectId, now);
    const r = this.db.prepare(`SELECT SUM(tokens) AS s FROM quota_consumptions
      WHERE project_id = ? AND member_id = ? AND created_at > ? AND source <> 'chat'`)
      .get(String(projectId || '').trim(), String(memberId || '').trim(), anchor - safeNum(windowMs, 600000));
    return safeNum(r && r.s);
  }

  /** 该任务已按轮记账的 token（结算补差用；settle 记录不参与，避免重复补差）。 */
  roundsOf(taskId) {
    const r = this.db.prepare(`SELECT SUM(tokens) AS s FROM quota_consumptions
      WHERE task_id = ? AND source = 'round'`).get(String(taskId || '').trim());
    return safeNum(r && r.s);
  }

  /**
   * 账本视图（2026-10-27 新增）：窗口内**按成员聚合**的真实 token 消耗。
   *
   * 只读取 `quota_consumptions`（每次 recordRound/settle 都落一行，见 _insert），
   * 不改动任何配额状态 —— 前端据此渲染「用量账本」，无记录时返回空数组
   * （前端整块卸载，不画空表、不编造数字）。
   *
   * ⚠ 口径：这是 **token 消耗**，不是金额。全仓没有任何价格/汇率数据，
   * 故本方法**不提供**「花了多少钱」——账单（¥）必须有真实定价源才能做，不可折算。
   */
  ledgerByMember(projectId, windowMs = 30 * 24 * 3600 * 1000, now = Date.now()) {
    const anchor = this.effectiveNow(projectId, now);
    const from = anchor - safeNum(windowMs, 30 * 24 * 3600 * 1000);
    return this.db.prepare(`SELECT member_id AS memberId, SUM(tokens) AS tokens, COUNT(*) AS rounds
      FROM quota_consumptions
      WHERE project_id = ? AND created_at > ? AND source <> 'chat'
      GROUP BY member_id
      ORDER BY tokens DESC`)
      .all(String(projectId || '').trim(), from)
      .map((r) => ({ memberId: String(r.memberId || ''), tokens: safeNum(r.tokens), rounds: safeNum(r.rounds) }));
  }

  reservedOf(projectId) {
    let sum = 0;
    for (const v of this._reserved.values()) {
      if (v.projectId === String(projectId || '').trim()) sum += v.tokens;
    }
    return sum;
  }

  available(projectId, now = Date.now()) {
    const b = this.getBucket(projectId);
    if (!b) return 0;
    const used = this.usedInWindow(projectId, now);
    return Math.max(0, b.totalLimit - used - this.reservedOf(projectId));
  }

  /** 水位快照：70% 告警 / 90% 限流 / 100% 熔断（§8.3）。 */
  state(projectId, now = Date.now()) {
    const b = this.getBucket(projectId);
    if (!b) return { state: 'suspended', used: 0, available: 0, util: 1, bucket: null, throttle: true };
    const used = this.usedInWindow(projectId, now);
    const avail = Math.max(0, b.totalLimit - used - this.reservedOf(projectId));
    // 利用率按「已消耗 + 已预留」对总量计——预留也算已承诺成本，否则并发派发会越过水位
    const committed = b.totalLimit > 0 ? (b.totalLimit - avail) / b.totalLimit : 1;
    let st = 'ok';
    if (avail < Math.max(b.resumeMinTokens, MIN_AVAILABLE)) st = 'suspended';
    else if (committed >= b.throttleRatio) st = 'throttle';
    else if (committed >= b.warnRatio) st = 'warn';
    return { state: st, used, available: avail, util: committed, bucket: b, throttle: st === 'throttle' };
  }

  /**
   * 派发前置判定（§8.2）。**唯一**允许调用 quota 判定的地方。
   * 返回 { allow, reason, grant, state, throttle }：
   *   · allow=false + reason='quota' → 任务转 quota_suspend；
   *   · throttle=true（90% 水位）→ 允许增量任务，调用方可据此拒绝 full_rewrite 或下调预算。
   */
  beforeDispatch(projectId, now = Date.now()) {
    const b = this.getBucket(projectId);
    if (!b) return { allow: false, reason: 'quota', grant: 0, state: 'suspended', throttle: true };
    const avail = this.available(projectId, now);
    const min = Math.max(b.resumeMinTokens, MIN_AVAILABLE);
    if (avail < min) return { allow: false, reason: 'quota', grant: 0, state: 'suspended', throttle: true };
    const throttle = avail < b.totalLimit * (1 - b.throttleRatio);
    return { allow: true, reason: null, grant: Math.min(avail, DEFAULT_GRANT), state: throttle ? 'throttle' : 'ok', throttle };
  }

  /**
   * 预留授予：把「准备花掉」的额度先扣掉，防并发任务同抢（§8.5）。
   * 返回实际授予额；低于下限返回 0（调用方应转 quota_suspend）。
   * 同一 taskId 重复授予返回既有预留，不叠加。
   */
  grant(projectId, taskId, requested = DEFAULT_GRANT, now = Date.now()) {
    const pid = String(projectId || '').trim();
    const tid = String(taskId || '').trim();
    if (!pid || !tid) return 0;
    if (this._reserved.has(tid)) return this._reserved.get(tid).tokens;
    const avail = this.available(pid, now);
    const tokens = Math.min(Math.max(0, safeNum(requested, DEFAULT_GRANT)), avail);
    if (tokens < Math.max(MIN_AVAILABLE, 1)) return 0;
    this._reserved.set(tid, { projectId: pid, tokens });
    return tokens;
  }

  /** 释放预留（任务未结算就退出 / 取消时必须调用，否则额度永久泄漏）。 */
  release(taskId) {
    this._reserved.delete(String(taskId || '').trim());
  }

  resetReservations() {
    this._reserved.clear();
  }

  /**
   * 记一轮消耗（引擎每轮上报）。source='round'。
   * 冷启动/异常情况下也允许补记历史时间戳（时钟回拨测试与导入用）。
   */
  recordRound({ projectId, runId, taskId, memberId, tokens, at }) {
    return this._insert({ projectId, runId, taskId, memberId, tokens, source: 'round', at });
  }

  /**
   * 单人对话运行收尾的消耗记账（source='chat'）。
   * 与 recordRound 的区别：团队任务运行由 quotaGate 另走 recordRound/settle（task_id 非空、
   * 走 workerPool，不经过 finishRun），此处只补「普通派单对话」这条此前完全不落账本的缺口，
   * 让「用量流水」对账本页能看到单人对话的真实消耗；workerPool 直跑 runAgent 不会触发本方法，故无双写。
   *
   * ⚠ 口径：'chat' 源**不计入**项目配额窗口（usedInWindow/memberUsed 均按 source 过滤），
   * 否则单人闲聊会无端挤占团队任务的派发额度；它只服务于用量展示，不改变配额判定。
   */
  recordChat({ projectId, runId, memberId, tokens, model, at }) {
    return this._insert({ projectId, runId, taskId: null, memberId, tokens, model, source: 'chat', at });
  }

  _insert({ projectId, runId, taskId, memberId, tokens, source, model, at }) {
    const pid = String(projectId || '').trim();
    const n = Math.max(0, Math.trunc(safeNum(tokens)));
    if (!pid || n <= 0) return 0;
    this.db.prepare(`INSERT INTO quota_consumptions
      (project_id, run_id, task_id, member_id, tokens, source, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(pid, String(runId || '') || null, String(taskId || '') || null,
        String(memberId || '') || null, n, String(source || 'round'),
        String(model || '').trim() || null, safeNum(at, Date.now()));
    return n;
  }

  /**
   * 任务结算补差（§8.2）：释放预留，按「实际 − 已按轮记账」补一条 settle 记录。
   * 只补正差、不冲减（实际小于按轮记账说明按轮高估，记 settle 负值会污染滑动求和口径）。
   */
  settle({ projectId, runId, taskId, memberId, actual }) {
    const pid = String(projectId || '').trim();
    const tid = String(taskId || '').trim();
    this.release(tid);
    const rounds = this.roundsOf(tid);
    const delta = Math.max(0, Math.trunc(safeNum(actual)) - rounds);
    if (delta > 0) {
      this._insert({ projectId: pid, runId, taskId: tid, memberId, tokens: delta, source: 'settle' });
    }
    return { delta, rounds, actual: Math.max(0, Math.trunc(safeNum(actual))) };
  }

  /**
   * 恢复判定（§8.2 tick）：可用额度回到下限以上，且「已承诺」回落到迟滞水位以下。
   * 迟滞防抖动：没有它就会出现「恢复→立刻打满→再暂停」的循环。
   * 只做判定与批量上限，真正的状态迁移由调用方（workerPool/main）执行——账本不碰任务表。
   */
  resumeDecision(projectId, now = Date.now(), limit = 2) {
    const st = this.state(projectId, now);
    const b = st.bucket;
    if (!b) return { resume: false, limit: 0, state: st };
    const min = Math.max(b.resumeMinTokens, MIN_AVAILABLE);
    const okToResume = st.available >= min && st.util < b.resumeHysteresisRatio;
    return { resume: okToResume, limit: okToResume ? Math.max(1, Math.trunc(limit)) : 0, state: st };
  }

  /**
   * 后台轮询入口（每 60s 由宿主调用）：判定 + 交回调执行恢复。
   * resumeTasks(projectId, limit) 由宿主注入（通常= TaskStore.resumeSuspendedTasks）。
   */
  tick(projectId, { now = Date.now(), limit = 2, resumeTasks } = {}) {
    const d = this.resumeDecision(projectId, now, limit);
    if (!d.resume || typeof resumeTasks !== 'function') return { ...d, resumed: 0 };
    let resumed = 0;
    try {
      resumed = safeNum(resumeTasks(String(projectId || '').trim(), d.limit));
    } catch (e) {
      // 恢复失败不改变判定（下一轮 tick 重试），但不能静默——额度已恢复却没人知道
      console.warn('[quota] 恢复暂停任务失败：', e.message);
    }
    return { ...d, resumed };
  }
}

module.exports = { QuotaLedger, DEFAULT_GRANT, MIN_AVAILABLE, QUOTA_STATES };
