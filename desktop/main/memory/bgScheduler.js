// P2-5：MemoryBgScheduler——记忆后台任务调度器
// 任务队列持久化到 memory_bg_tasks 表（重启恢复：queued 任务继续跑）；
// 60s 轮询驱动，按优先级取任务（1 最高）；前台任务不受阻塞（所有调用均异步且低频）。
// 处理器（文档③第六节裁剪为当前可落地 5 类）：
//   compress      优先级 1  Tier1 批量合并摘要（LLM，经写锁串行）
//   promote       优先级 3  高频 Tier2 → Tier3 固化
//   promote-scope 优先级 3  跨层晋升：L1 命中≥3→L2；L2 命中≥5 且 user_input→L3（三层记忆 M2）
//   decay         优先级 4  importance 时间衰减 + 低分失效
//   cleanup       优先级 5  失效/过期记忆物理删除（防膨胀）
//   embed         优先级 2  （预留：embedding 端点配置后启用，未配置直接跳过）
const crypto = require('crypto');

const DEFAULT_DONE_RETENTION_MS = 7 * 24 * 3600 * 1000; // 7 天保留期
const DEFAULT_MAX_HISTORY_ROWS = 500;                   // 终态行容量上限
// P3-3：每日本地压缩配额——LLM 压缩是后台唯一付费调用，按本地计数（memory_bg_tasks
// 当日 done 行）设上限；超限则压缩任务留队次日再跑。上限可经 localStore preference
// 'memory.bgDailyQuota' 覆盖（main.js 经 deps.getDailyQuota 注入）。
const DEFAULT_DAILY_COMPRESS_QUOTA = 20;

const PROCESSORS = {
  compress: async (payload, deps) => {
    const model = deps.resolveModel?.() || null;
    // P3-3：后台压缩走 bg 槽位（预算隔离：不吃前台预留槽，前台繁忙时最多 1 个并发）。
    // 槽位经 deps.acquireSlot 注入（main.js: quota.acquire）；未注入（测试）时退化为无槽位直跑。
    const slot = typeof deps.acquireSlot === 'function'
      ? await deps.acquireSlot('bg', model?.providerId || 'default')
      : null;
    try {
      return await deps.memory.compress({
        spaceId: payload.spaceId,
        domain: payload.domain || 'session',
        batchSize: payload.batchSize || 10,
        // 槽位类型随调用透传：scheduledAgentChat(payload, 'bg') 占用 bg 槽位而非 fg
        chatOnce: (p) => (deps.chatOnce ? deps.chatOnce(p, 'bg') : null),
        model,
      });
    } finally {
      slot?.release?.();
    }
  },
  promote: async (_payload, deps) => ({ promoted: deps.memory.promoteByHits(3) }),
  // 三层记忆 M2：跨层晋升（纯本地 SQL，无 LLM 成本）——L1 命中≥3→L2；L2 命中≥5 且 user_input→L3
  'promote-scope': async (_payload, deps) => deps.memory.promoteScopeByHits({}),
  decay: async (_payload, deps) => deps.memory.decayJob({}),
  cleanup: async (_payload, deps) => deps.memory.cleanupJob({}),
  embed: async () => ({ skipped: 'embedding 端点未配置（P3 LocalBackend/向量就绪后启用）' }),
};

class MemoryBgScheduler {
  // deps: { db, memory, chatOnce?, resolveModel?, emit? }
  constructor(deps) {
    this.deps = deps;
    this.timer = null;
    this.running = false;
  }

  _id() { return `bg-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`; }

  enqueue(type, payload = {}, { priority = 3 } = {}) {
    const now = Date.now();
    const task = { id: this._id(), type, payload, priority, status: 'queued', attempts: 0, created_at: now, updated_at: now };
    this.deps.db.prepare(`INSERT INTO memory_bg_tasks (id, type, payload, priority, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, task.type, JSON.stringify(task.payload), task.priority, task.status, task.attempts, now, now);
    return task;
  }

  // 周期性自检：自动产生维护任务（compress/decay/cleanup 按需入队，避免空转）
  autoEnqueue({ compressMinBatch = 3 } = {}) {
    const db = this.deps.db;
    const spaces = db.prepare(`SELECT space_id, domain, COUNT(*) AS n FROM memories
      WHERE tier = 1 AND compressed = 0 AND is_valid = 1 GROUP BY space_id, domain`).all();
    let enqueued = 0;
    for (const s of spaces) {
      if (s.n >= compressMinBatch) {
        const dup = db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks
          WHERE type = 'compress' AND status IN ('queued','running') AND payload LIKE ?`).get(`%"spaceId":"${s.space_id}"%`);
        if (!dup.n) { this.enqueue('compress', { spaceId: s.space_id, domain: s.domain }, { priority: 1 }); enqueued += 1; }
      }
    }
    const hasDecay = db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE type = 'decay' AND status IN ('queued','running')`).get();
    if (!hasDecay.n) { this.enqueue('decay', {}, { priority: 4 }); enqueued += 1; }
    // 三层记忆 M2：跨层晋升（纯本地 SQL 维护任务，与 decay/cleanup 同为周期性自检项）
    const hasPromoteScope = db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE type = 'promote-scope' AND status IN ('queued','running')`).get();
    if (!hasPromoteScope.n) { this.enqueue('promote-scope', {}, { priority: 3 }); enqueued += 1; }
    const hasCleanup = db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE type = 'cleanup' AND status IN ('queued','running')`).get();
    if (!hasCleanup.n) { this.enqueue('cleanup', {}, { priority: 5 }); enqueued += 1; }
    // P0-19（2026-10-16）：定期清理已终态（done/failed）历史行，消除约 952 行/天的无限膨胀
    this.purgeHistory();
    return enqueued;
  }

  /**
   * 清理已终态（done / failed）的后台任务历史记录（P0-19 表生命周期治理）。
   * 规则：
   *   1) 超过 retentionMs（默认 7 天）的 done/failed 行物理删除；
   *   2) 若终态行总数仍超过 maxRows（默认 500），按 updated_at 保留最新 maxRows 条，其余物理删除；
   *   3) 绝不触碰 queued / running 在途任务。
   */
  purgeHistory({ retentionMs = DEFAULT_DONE_RETENTION_MS, maxRows = DEFAULT_MAX_HISTORY_ROWS } = {}) {
    const db = this.deps.db;
    const cutoff = Date.now() - Math.max(0, Number(retentionMs) || 0);
    const r1 = db.prepare(`DELETE FROM memory_bg_tasks
      WHERE status IN ('done','failed') AND updated_at < ?`).run(cutoff);
    let trimmed = 0;
    const cap = Math.max(1, Number(maxRows) || DEFAULT_MAX_HISTORY_ROWS);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE status IN ('done','failed')`).get();
    if (total && total.n > cap) {
      const r2 = db.prepare(`DELETE FROM memory_bg_tasks
        WHERE status IN ('done','failed') AND id NOT IN (
          SELECT id FROM memory_bg_tasks WHERE status IN ('done','failed')
          ORDER BY updated_at DESC, created_at DESC LIMIT ?
        )`).run(cap);
      trimmed = r2.changes || 0;
    }
    return { expired: r1.changes || 0, trimmed, purged: (r1.changes || 0) + trimmed };
  }

  // 取一个可执行任务（优先级 1 最高，FIFO 同级）；attempts>=3 直接判死（卡死防线）
  // P3-3：压缩任务受每日本地配额约束——当日已 done 的压缩数达上限时跳过不 claim
  // （任务留队、不消耗 attempts），让位给 decay/cleanup 等无成本维护任务。
  _claim() {
    const dead = this.deps.db.prepare(`UPDATE memory_bg_tasks SET status = 'failed', error = '超过 3 次尝试上限', updated_at = ?
      WHERE status = 'queued' AND attempts >= 3`).run(Date.now());
    if (dead.changes) this.deps.emit?.({ type: 'memory_bg_failed', purged: dead.changes });
    const rows = this.deps.db.prepare(`SELECT * FROM memory_bg_tasks WHERE status = 'queued'
      ORDER BY priority ASC, created_at ASC LIMIT 10`).all();
    for (const row of rows) {
      if (row.type === 'compress' && this._dailyQuotaExceeded()) continue; // 配额用尽：今天不再派发压缩
      this.deps.db.prepare(`UPDATE memory_bg_tasks SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`)
        .run(Date.now(), row.id);
      // payload 坏掉时给 {} 会让任务「空参执行」，而这一行此刻已被置 running 且 attempts+1 ⇒
      // 反复空跑 3 次后以「超过尝试上限」落 failed，错误原因与真因（数据损坏）完全不符，故必须留痕。
      return { ...row, payload: (() => { try { return JSON.parse(row.payload || '{}'); } catch (e) { console.warn('[memoryBg] 后台任务 payload 损坏，按空参数执行：', row.id, row.type, e?.message || e); return {}; } })() };
    }
    return null;
  }

  // P3-3：当日压缩配额是否已用尽（本地计数 + 可配置上限，无需新增配额子系统）
  _dailyQuotaExceeded() {
    const limit = Math.max(1, Number(this.deps.getDailyQuota?.()) || DEFAULT_DAILY_COMPRESS_QUOTA);
    const d = new Date();
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const n = this.deps.db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks
      WHERE type = 'compress' AND status = 'done' AND updated_at >= ?`).get(dayStart).n;
    return n >= limit;
  }

  async runOne() {
    // P3-3 节流联动：bgGate（ResourceQuotaCenter.bgAllowed）返回 false = 前台过载/熔断中，
    // 后台 LLM 作业全部让路（任务留在队列里，下轮再试；不 claim 不消耗 attempts）
    if (typeof this.deps.bgGate === 'function' && !this.deps.bgGate()) return null;
    const task = this._claim();
    if (!task) return null;
    const processor = PROCESSORS[task.type];
    try {
      if (!processor) throw new Error(`未知任务类型：${task.type}`);
      const result = await processor(task.payload, this.deps);
      this.deps.db.prepare(`UPDATE memory_bg_tasks SET status = 'done', error = NULL, updated_at = ? WHERE id = ?`)
        .run(Date.now(), task.id);
      this.deps.emit?.({ type: 'memory_bg_done', taskType: task.type, result });
      return { task, result };
    } catch (e) {
      this.deps.db.prepare(`UPDATE memory_bg_tasks SET status = 'queued', error = ?, updated_at = ? WHERE id = ?`)
        .run(String(e.message || e).slice(0, 300), Date.now(), task.id); // 回队重试（attempts 上限兜底）
      this.deps.emit?.({ type: 'memory_bg_retry', taskType: task.type, error: String(e.message || e) });
      return { task, error: String(e.message || e) };
    }
  }

  async drain(max = 10) {
    const results = [];
    for (let i = 0; i < max; i += 1) {
      const r = await this.runOne();
      if (!r) break;
      results.push(r);
    }
    return results;
  }

  start({ intervalMs = 60 * 1000 } = {}) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // 上一轮未完不叠加（防堆积）
      this.running = true;
      (async () => {
        this.autoEnqueue({});
        await this.drain(5);
      })().catch(() => {}).finally(() => { this.running = false; });
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  listTasks({ limit = 30 } = {}) {
    return this.deps.db.prepare('SELECT * FROM memory_bg_tasks ORDER BY created_at DESC LIMIT ?').all(limit);
  }
}

module.exports = { MemoryBgScheduler, PROCESSORS };
