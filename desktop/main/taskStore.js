// P1-3：任务持久化队列——SQLite 状态机 + 断点续跑（计划文档「本地任务队列」目标）
// 状态机：
//   group: ready → running → done | failed | paused | cancelled
//   task : pending → queued → running → done | failed | skipped
//          failed --(retry, retry_count<max_retry)--> queued
//          running --(M5/T5-3 动态等待)--> waiting --(依赖就绪)--> queued | --(超时/取消)--> failed | skipped
// 关键失败 → 组 paused（等待重新规划/人工处置）；非关键失败 → 降级继续（聚合附警告）。
// 写入全部经由本模块的同步 better-sqlite3 事务（主进程单线程，天然串行，无并发写脏数据）。

const TASK_TRANSITIONS = {
  pending: ['queued', 'skipped'],
  // T6-4（§5.1）：quota_suspend 是派发前被配额闸拦下的落点——任务退出可派发集合但**不是失败**。
  queued: ['running', 'pending', 'skipped', 'quota_suspend'], // pending：取消排队回退
  running: ['done', 'failed', 'queued', 'waiting', 'quota_suspend'], // queued：崩溃恢复 / 重试；waiting：T5-3 动态等待
  // M5 / T5-3（§7 L2）：waiting 是调度器的**唯一状态侵入点**。三条出边各有唯一语义：
  //   waiting → queued「被等待方终态唤醒，重新入队可派发」；→ failed「等待超时」；→ skipped「被取消」。
  waiting: ['queued', 'failed', 'skipped'],
  // T6-4（§5.1）：恢复唯一入口 = queued（回到同一调度路径续跑）；取消 = skipped。
  // 刻意不提供 → failed：配额不足不是执行失败，不允许消耗自动重试次数、不允许触发组 paused。
  quota_suspend: ['queued', 'skipped'],
  done: [],
  failed: ['queued'],                        // 手动重试入口
  skipped: [],
};

// 终态集合：等待图环检测与唤醒判定都以此为准（单一事实来源，别处不得手写列表）
const TERMINAL_TASK_STATUSES = ['done', 'failed', 'skipped'];

// ── M5 / T5-3 运行期等待边界（§7 五条硬规则）──
// 规则 3「等待不叠加」：单个任务的等待边上限。设 3 是为了避免「等待树」爆炸——
// 一条任务等 3 个已足够表达「等 A 产出 + 等 B 产出 + 等 C 产出」，再多说明拆解本身有问题。
const MAX_WAIT_DEPS = 3;
// 规则 2「等待必须超时」：缺省 10 分钟。过短会把正常的长任务误判为超时；
// 过长则等待方在池外干等、用户看到「等待中」半天不动。上限 1 小时与单任务墙钟同量级。
const WAIT_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000;
const WAIT_TIMEOUT_MIN_MS = 1000;
const WAIT_TIMEOUT_MAX_MS = 60 * 60 * 1000;

const GROUP_TRANSITIONS = {
  ready: ['running', 'cancelled'],
  running: ['done', 'failed', 'paused', 'cancelled'],
  paused: ['running', 'cancelled'],
  done: [], failed: [], cancelled: [],
};

function canTransition(kind, from, to) {
  const table = kind === 'group' ? GROUP_TRANSITIONS : TASK_TRANSITIONS;
  return (table[from] || []).includes(to);
}

class TaskStore {
  constructor(db) {
    this.db = db;
  }

  now() { return Date.now(); }

  // ── 组 ──
  // meta：{ auto, replanDepth, replanOf } 自动编排元数据（auto 组失败后由主进程自动重规划）
  // V04（2026-10-16）：approvalMode/sandboxPolicy 是「建组时刻」的宿主治理快照，
  // 由调用方（main.js 从用户当前设置取值）传入并持久化——Worker 执行时读组内快照，
  // 不再读取全局最近一次会话设置（否则会话中途改审批档会串到已在排队的组）。
  // R6（2026-10-16，用户实测反馈）：threadId = 创建组的会话——组绑定会话而非全局可见。
  createGroup({ groupId, goal, cwd, projectPath, dag, tasks, auto, replanDepth, replanOf, approvalMode, sandboxPolicy, threadId }) {
    const now = this.now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO task_groups (group_id, goal, cwd, status, dag_json, auto, replan_depth, replan_of, approval_mode, sandbox_policy, thread_id, project_path, created_at, updated_at)
                       VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(groupId, goal, cwd || '', JSON.stringify(dag || null),
          auto ? 1 : 0, Number(replanDepth) || 0, replanOf || null,
          approvalMode || null, sandboxPolicy || null, threadId || null, projectPath || null, now, now);
      tasks.forEach((t, i) => {
        this.db.prepare(`INSERT INTO sub_tasks
          (task_id, group_id, seq, title, prompt, depends_on, critical, max_retry, timeout_ms, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(t.id, groupId, i, t.title, t.prompt, JSON.stringify(t.dependsOn || []), t.critical ? 1 : 0, t.maxRetry || 0, t.timeoutMs || 600000);
      });
    });
    tx();
    return this.getGroup(groupId);
  }

  getGroup(groupId) {
    const g = this.db.prepare('SELECT * FROM task_groups WHERE group_id = ?').get(groupId);
    if (!g) return null;
    return { ...g, dag: safeParse(g.dag_json), result: safeParse(g.result_json), tasks: this.listTasks(groupId) };
  }

  listGroups({ limit = 30 } = {}) {
    // R-16（2026-10-26）：组列表附带子任务真实计数（total/done/failed），供工作台运行卡渲染
    // 「任务进度」——计数来自 sub_tasks 表（按 group_id 关联、每行含 status），是真实数据，
    // 绝非编造百分比。关联子查询走 group_id 索引，开销可忽略；既有调用方只取组级字段，新增字段向后兼容。
    return this.db.prepare(`
      SELECT g.*,
        (SELECT COUNT(*) FROM sub_tasks s WHERE s.group_id = g.group_id) AS total_tasks,
        (SELECT COUNT(*) FROM sub_tasks s WHERE s.group_id = g.group_id AND s.status = 'done') AS done_tasks,
        (SELECT COUNT(*) FROM sub_tasks s WHERE s.group_id = g.group_id AND s.status = 'failed') AS failed_tasks
      FROM task_groups g
      ORDER BY g.created_at DESC
      LIMIT ?`).all(limit)
      .map((g) => ({
        ...g,
        totalTasks: g.total_tasks,
        doneTasks: g.done_tasks,
        failedTasks: g.failed_tasks,
        dag: safeParse(g.dag_json),
        result: safeParse(g.result_json),
      }));
  }

  /**
   * M5 / T5-6：按会话归属列任务组（对话内团队事件流的 run 关联事实源）。
   *
   * 关联键是 `task_groups.thread_id`（T5-11 已把 threadId 贯穿到建组），不是 team_messages：
   * team_messages 只有 run_id，没有会话列；若在此另加一列就出现「会话归属」的第二事实源。
   * 故「某个团队 run 属于哪个对话」= 建组时写入的 thread_id，单一判据。
   * 返回结构与 listGroups 一致（含 dag/result），便于调用方直接取状态与聚合摘要。
   */
  listGroupsByThread(threadId, { limit = 50 } = {}) {
    const t = String(threadId == null ? '' : threadId).trim();
    if (!t) return [];
    const cap = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 50)));
    return this.db.prepare('SELECT * FROM task_groups WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(t, cap)
      .map((g) => ({ ...g, dag: safeParse(g.dag_json), result: safeParse(g.result_json) }));
  }

  // R6（2026-10-16，用户实测反馈）：删除任务组——否则终态组永远留在任务面板。
  // fail-closed：running 组不可直接删（先取消/强制关闭，避免账目悬空）；
  // 事务级联清理 side_effects + sub_tasks + 组本体。
  deleteGroup(groupId) {
    const g = this.db.prepare('SELECT status FROM task_groups WHERE group_id = ?').get(groupId);
    if (!g) return { ok: false, error: `任务组不存在：${groupId}` };
    if (g.status === 'running') return { ok: false, error: '任务组正在运行，请先取消再删除' };
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM side_effects WHERE group_id = ?').run(groupId);
      this.db.prepare('DELETE FROM task_events WHERE group_id = ?').run(groupId);
      this.db.prepare('DELETE FROM sub_tasks WHERE group_id = ?').run(groupId);
      this.db.prepare('DELETE FROM task_groups WHERE group_id = ?').run(groupId);
    });
    tx();
    return { ok: true };
  }

  setGroupStatus(groupId, status, { error, result } = {}) {
    const g = this.db.prepare('SELECT status FROM task_groups WHERE group_id = ?').get(groupId);
    if (!g) return null;
    if (g.status !== status && !canTransition('group', g.status, status)) {
      throw new Error(`非法组状态迁移：${g.status} → ${status}`);
    }
    this.db.prepare('UPDATE task_groups SET status = ?, error = ?, result_json = ?, updated_at = ? WHERE group_id = ?')
      .run(status, error ?? null, result != null ? JSON.stringify(result) : null, this.now(), groupId);
    return this.getGroup(groupId);
  }

  // ── 任务 ──
  listTasks(groupId) {
    return this.db.prepare('SELECT * FROM sub_tasks WHERE group_id = ? ORDER BY seq ASC').all(groupId)
      .map(rowToTask);
  }

  getTask(groupId, taskId) {
    const r = this.db.prepare('SELECT * FROM sub_tasks WHERE group_id = ? AND task_id = ?').get(groupId, taskId);
    return r ? rowToTask(r) : null;
  }

  // force: 终态强制落位（workerPool.js:382 组收尾场景）——非法迁移但目标是终态
  // （done/failed/skipped）时放行并留痕。此前签名无 force：调用方传了也被忽略，
  // 迁移被拒 → 任务卡在 queued → 组「无待执行任务」判定永不成立 → 界面永久转圈（P0-10）。
  // M5 / T5-3：ownerMemberId = 被动认领者（军团成员 id），仅进入 running 时写入并留 claimed_at。
  // 终态统一清空等待边（waiting_on_json / wait_deadline_at）——否则一个已终态的任务仍带着
  // 「我在等 T3」的陈旧边，会让 settleWaitingTasks 的剩余判定失真。清空必须收敛在此单一落点，
  // 不散落到各调用分支（否则总有分支漏清）。
  setTaskStatus(groupId, taskId, status, { error, result, workerId, skipRetryCount, force, ownerMemberId } = {}) {
    const t = this.getTask(groupId, taskId);
    if (!t) throw new Error(`子任务不存在：${groupId}/${taskId}`);
    const transitionLegal = t.status === status || canTransition('task', t.status, status);
    if (!transitionLegal) {
      const terminal = status === 'done' || status === 'failed' || status === 'skipped';
      if (force && terminal) {
        console.warn(`[taskStore] force 强制落位：${t.status} → ${status}（${groupId}/${taskId}）——组收尾需要`);
      } else {
        throw new Error(`非法任务状态迁移：${t.status} → ${status}（${groupId}/${taskId}）`);
      }
    }
    const now = this.now();
    const isTerminal = TERMINAL_TASK_STATUSES.includes(status);
    // retry_count 语义 = 自动重试次数：强制关闭（skipRetryCount）不计入
    this.db.prepare(`UPDATE sub_tasks SET status = ?, error = ?, result_json = ?, worker_id = ?,
      retry_count = CASE WHEN ? = 'failed' AND ? = 0 THEN retry_count + 1 ELSE retry_count END,
      started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
      finished_at = CASE WHEN ? IN ('done','failed','skipped') THEN ? ELSE finished_at END,
      owner_member_id = CASE WHEN ? = 'running' THEN COALESCE(?, owner_member_id) ELSE owner_member_id END,
      claimed_at = CASE WHEN ? = 'running' THEN COALESCE(?, claimed_at) ELSE claimed_at END,
      waiting_on_json = CASE WHEN ? = 1 THEN '[]' ELSE waiting_on_json END,
      wait_deadline_at = CASE WHEN ? = 1 THEN NULL ELSE wait_deadline_at END
      WHERE group_id = ? AND task_id = ?`)
      .run(status, error ?? null, result != null ? JSON.stringify(result) : null, workerId ?? null,
        status, skipRetryCount ? 1 : 0, status, now, status, now,
        status, ownerMemberId ?? null, status, status === 'running' ? now : null,
        isTerminal ? 1 : 0, isTerminal ? 1 : 0, groupId, taskId);
    this.touchGroup(groupId);
    return this.getTask(groupId, taskId);
  }

  /**
   * 依赖级联（2026-10-21）：某任务终态 failed/skipped 时，把（传递）依赖它的未终态任务置 skipped。
   * 为什么必须做：依赖集只认 done/skipped，failed 的前置永远不会让后续入队 ⇒ 后续任务永久 pending
   * ⇒ isGroupSettled 永不成立 ⇒ 组悬挂转圈（预算软上限后 t2 失败、t3/t4 卡住就是这个形态）。
   * 返回被跳过的 taskId 列表（调用方负责广播事件）。
   */
  skipDependentsOf(groupId, taskId, reason) {
    const tasks = this.listTasks(groupId);
    const dead = new Set([taskId]);
    const out = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tasks) {
        if (['done', 'failed', 'skipped', 'cancelled'].includes(t.status) || dead.has(t.taskId)) continue;
        if (!(t.dependsOn || []).some((d) => dead.has(d))) continue;
        dead.add(t.taskId);
        out.push(t.taskId);
        changed = true;
        try {
          this.setTaskStatus(groupId, t.taskId, 'skipped', { error: reason, force: true });
        } catch (e) {
          console.warn(`[taskStore] 级联跳过失败（${t.taskId}）:`, e.message);
        }
      }
    }
    return out;
  }

  // 入队：pending 且全部依赖已 done 的任务 → queued
  // M5 / T5-12：allowIds 是**批次门控**（wave）的唯一接入点——给定时只放行本批任务入队，
  // 后批任务保持 pending（不占槽位、不会被 claimNext 领走），批间因此天然串行。
  // 依赖判定仍在此处强制：门控只「收紧」可派发集合，绝不放宽 depends_on。
  enqueueReady(groupId, { allowIds = null } = {}) {
    const tasks = this.listTasks(groupId);
    const allow = Array.isArray(allowIds) ? new Set(allowIds.map(String)) : null;
    const doneIds = new Set(tasks.filter((t) => t.status === 'done' || t.status === 'skipped').map((t) => t.taskId));
    const ready = tasks.filter((t) => t.status === 'pending' && t.dependsOn.every((d) => doneIds.has(d))
      && (!allow || allow.has(t.taskId)));
    for (const t of ready) this.setTaskStatus(groupId, t.taskId, 'queued');
    return ready.map((t) => t.taskId);
  }

  // 领取一个 queued 任务（占位 running，带 workerId）——由 WorkerPool 循环调用
  // M5 / T5-3「看板被动认领」：ownerMemberId 记录**谁认领的**（军团成员 id）。
  // 语义上仍是「被动认领」——任务不会主动找人，而是由主管指派 / 队员按看板认领后落到此处；
  // 普通（非军团）run 不传 owner，列保持 NULL（不发明身份）。
  claimNext(groupId, workerId, { ownerMemberId = null } = {}) {
    const row = this.db.prepare(`SELECT task_id FROM sub_tasks
      WHERE group_id = ? AND status = 'queued' ORDER BY seq ASC LIMIT 1`).get(groupId);
    if (!row) return null;
    return this.setTaskStatus(groupId, row.task_id, 'running', { workerId, ownerMemberId });
  }

  // M5 / T5-12：探活撤员后的**重派**（§13.4 降级协议）。语义 = 换人不换任务：
  //   · 状态回 queued（running/waiting/failed/pending → queued 均在状态机内）；
  //   · owner_member_id 直写新成员——不能复用 setTaskStatus 的 COALESCE 语义（那是
  //     「重跑不覆盖原认领者」的保护），撤员场景要的正是覆盖；
  //   · 不清 retry_count：探活撤员不算 Agent 失败重试，也不消耗自动重试次数。
  // 已完成/已跳过返回 null（撤员只能作用于还在生命周期内的任务）。
  reassignTask(groupId, taskId, ownerMemberId, { error = null } = {}) {
    const t = this.getTask(groupId, taskId);
    if (!t) return null;
    if (t.status === 'done' || t.status === 'skipped') return null;
    if (t.status !== 'queued') this.setTaskStatus(groupId, taskId, 'queued', { error });
    this.db.prepare('UPDATE sub_tasks SET owner_member_id = ? WHERE group_id = ? AND task_id = ?')
      .run(String(ownerMemberId), groupId, taskId);
    this.touchGroup(groupId);
    return this.getTask(groupId, taskId);
  }

  /**
   * T6-4（§5.1）：配额暂停——把可派发任务移出调度，但**不改写成失败**。
   *
   * 三条边界：
   *   ① 只从 queued / running 进入（pending 尚未入队、waiting 在等别人、终态不可逆）；
   *   ② 不消耗 retry_count、不写 finished_at（setTaskStatus 只对终态写）；
   *   ③ result_json 不写——暂停不是产出，产出字段留给真正的执行结果。
   * reason 只做二值语义：'quota'（窗口额度耗尽）/ 'breaker'（单成员熔断），落 error 列供界面解释。
   * 幂等：已是 quota_suspend 时原样返回，避免同一任务被多轮 tick 反复迁移。
   */
  suspendTask(groupId, taskId, { reason = 'quota' } = {}) {
    const t = this.getTask(groupId, taskId);
    if (!t) return null;
    if (t.status === 'quota_suspend') return t;
    if (t.status !== 'queued' && t.status !== 'running') return null;
    return this.setTaskStatus(groupId, taskId, 'quota_suspend', {
      error: reason === 'breaker'
        ? '配额熔断暂停（该成员消耗超限，其他成员不受影响）'
        : '配额不足暂停（等待滑动窗口释放额度后自动续跑）',
    });
  }

  /**
   * T6-4（§5.1）：配额恢复——quota_suspend → queued，按 seq 升序**小批量**。
   *
   * 为什么带 limit：一次性把全部暂停任务放回队列，会瞬间抢空刚释放出的额度并再次触发暂停
   * （恢复/暂停抖动）。小批量放行让额度随老化稳定释放，符合 §8「恢复要迟滞」的口径。
   * 恢复只回队列，不直接派发：下一拍 pump 仍要过配额闸，闸不放行就再次暂停（不会绕过检查）。
   *
   * T6-8（§5.3）：allow(row) 用于跳过「成员仍在熔断中」的暂停任务——不能只按 seq 取前 N 个，
   * 否则被熔断成员占住队首时，后面的正常任务永远轮不到恢复（SQL LIMIT 会把它们截掉）。
   */
  resumeSuspendedTasks(groupId, { limit = 2, allow } = {}) {
    const cap = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 2)));
    const rows = this.db.prepare(`SELECT task_id, owner_member_id FROM sub_tasks
      WHERE group_id = ? AND status = 'quota_suspend' ORDER BY seq ASC`).all(groupId);
    const out = [];
    for (const r of rows) {
      if (out.length >= cap) break;
      if (typeof allow === 'function' && !allow(r)) continue;
      try {
        // error 置空：恢复后不该继续展示「配额不足暂停」的旧理由
        this.setTaskStatus(groupId, r.task_id, 'queued', { error: null });
        out.push(r.task_id);
      } catch (e) {
        console.warn(`[taskStore] 配额恢复失败（${r.task_id}）:`, e.message);
      }
    }
    return out;
  }

  // 失败处置：可重试 → 回 queued；不可重试 → failed（调用方决定组级动作）
  // result：部分结果（如 Agent 未完成收尾时已有的产出摘要），失败也保留供 UI/重规划参考
  // P1-13：自动重试前查副作用核对闸（hasPriorUncertainEffects）——账本里残留更早运行的
  // uncertain 记录（崩溃/强杀恢复）时，自动回 queued 会重复执行同一批写操作/发请求。
  // 此时置 failed 并在错误信息中说明核对入口，重试交人工触发（IPC 层带 confirmReview）。
  handleFailure(groupId, taskId, errorMsg, result) {
    const t = this.getTask(groupId, taskId);
    this.setTaskStatus(groupId, taskId, 'failed', { error: errorMsg, result: result || null });
    if (t.retryCount < t.maxRetry) {
      if (this.hasPriorUncertainEffects(groupId, taskId)) {
        console.warn(`[taskStore] 任务 ${groupId}/${taskId} 自动重试被副作用核对闸拦截（残留更早运行的 uncertain 账本），置 failed 待人工重试`);
        this.setTaskStatus(groupId, taskId, 'failed', {
          error: `${errorMsg}；检测到上次未确认的副作用记录，自动重试已拦截——请先核对副作用后手动重试`,
          result: result || null, force: true,
        });
        return { retried: false, blockedByReview: true };
      }
      this.setTaskStatus(groupId, taskId, 'queued');
      return { retried: true };
    }
    return { retried: false };
  }

  // ── M5 / T5-3：跨成员依赖与防死锁（设计稿 §7，「防死锁核心」）──
  //
  // 分层处理依赖（v1.1 定案，**不是**「加一个状态就完事」）：
  //   · L1 依赖前置（首选，零侵入）：静态 `depends_on` + enqueueReady/claimNext 只派发就绪任务，
  //     等待根本不会成为运行期状态 —— 已在既有实现中成立，本轮不改；
  //   · L2 运行期 `waiting`（兜底，唯一侵入点）：执行中才发现的**新**依赖走本节；
  //   · L3 轮询：不进默认路径（4 槽位的池里两个任务互等，有效并发就腰斩）。
  //
  // 本节只做 L2 —— 也就是「拆解阶段消解不掉的那部分」。度量口径见 waitStats()（R2）。

  /**
   * 等待图环检测（Kahn，纯函数）。两条规则来自 §7 规则 1 / R3：
   *
   *   ① 图 = 静态 depends_on ∪ 运行期 waiting_on。只查 waiting_on 会漏掉
   *      「A 动态等 B、而 B 静态依赖 A」这类互等（等价于成环）——必须合并成一张图才判得对；
   *   ② 只在**未终态**节点上建图。已 done/failed/skipped 的任务无法再被任何人阻塞，
   *      把它们算作节点会制造假环（例：A 已 done，B 动态等 A 之外的 C —— A 不该参与判环）。
   *
   * @param {Array} tasks 组内任务快照（含 dependsOn / waitingOn / status）
   * @param {Array<[string,string]>} extraEdges 待加入的边 [waiter, waitedOn]
   * @returns {boolean} true = 加入这些边后会成环
   */
  _wouldCycle(tasks, extraEdges) {
    const live = tasks.filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status));
    const liveIds = new Set(live.map((t) => t.taskId));
    const out = new Map(live.map((t) => [t.taskId, new Set()])); // 被等待者 → 等待者
    const indeg = new Map(live.map((t) => [t.taskId, 0]));
    const addEdge = (waiter, waitedOn) => {
      // 自环（waiter === waitedOn）**不**在此静默跳过：它同样是环，交给 Kahn 判出来
      if (!liveIds.has(waiter) || !liveIds.has(waitedOn)) return;
      const set = out.get(waitedOn);
      if (set.has(waiter)) return;
      set.add(waiter);
      indeg.set(waiter, indeg.get(waiter) + 1);
    };
    for (const t of live) {
      for (const d of t.dependsOn) addEdge(t.taskId, d);
      for (const d of t.waitingOn || []) addEdge(t.taskId, d);
    }
    for (const [waiter, waitedOn] of extraEdges) addEdge(waiter, waitedOn);
    let queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length) {
      const next = [];
      for (const id of queue) {
        visited += 1;
        for (const nxt of out.get(id)) {
          indeg.set(nxt, indeg.get(nxt) - 1);
          if (indeg.get(nxt) === 0) next.push(nxt);
        }
      }
      queue = next;
    }
    return visited !== live.length;
  }

  /**
   * 为**运行中**的任务登记动态等待边（§7 L2）。建边、环检测、状态迁移三者**同一临界区**。
   *
   * 为什么必须同临界区（§7 规则 1 / R3）：并发两次建边时，若「读等待图 → 判环 → 写边」被拆开，
   * 两个各自无环的请求叠起来可能成环（A 等 B 与 B 等 A 各自通过判环）。SQLite 单写事务天然串行化，
   * 把整段放进 this.db.transaction() 即闭环——且环检测读的是**事务内**的最新快照，而非调用前的外部快照。
   *
   * @returns {{ok:boolean,error?:string,waiting:boolean,reason?:string,waitingOn:string[],deadlineAt:number|null}}
   *   · ok=false + error：建边被拒（自等待 / 成环 / 超上限 / 目标不存在）→ Lead 据此改派，**不静默**；
   *   · ok=true, waiting=false, reason='deps_already_settled'：目标已终态，无需挂起（调用方继续跑）；
   *   · ok=true, waiting=true：已挂起，槽位可由调用方（WorkerPool）释放。
   */
  waitOnTasks(groupId, taskId, onTaskIds, { timeoutMs } = {}) {
    const t = this.getTask(groupId, taskId);
    if (!t) return { ok: false, error: `子任务不存在：${groupId}/${taskId}`, waiting: false, waitingOn: [], deadlineAt: null };
    const fail = (error) => ({ ok: false, error, waiting: false, waitingOn: [], deadlineAt: null });
    if (t.status !== 'running') {
      return fail(`仅运行中的任务可进入等待（当前 ${t.status}）——可预见的依赖请写进拆解阶段的 dependsOn（§7 L1 首选）`);
    }

    const targets = [...new Set((Array.isArray(onTaskIds) ? onTaskIds : [])
      .map((v) => String(v == null ? '' : v).trim()).filter(Boolean))];
    if (targets.length === 0) return fail('等待目标为空');
    if (targets.includes(t.taskId)) return fail('任务不能等待自身（§7 规则 1：等待图必须无环）');

    const before = this.listTasks(groupId);
    const byId = new Map(before.map((x) => [x.taskId, x]));
    for (const d of targets) if (!byId.has(d)) return fail(`等待了不存在的任务：${d}`);

    const merged = [...new Set([...(t.waitingOn || []), ...targets])];
    if (merged.length > MAX_WAIT_DEPS) {
      return fail(`等待目标数 ${merged.length} 超过上限 ${MAX_WAIT_DEPS}（§7 规则 3：等待不叠加）`);
    }
    // 已终态的目标不构成等待；若已无可等待对象 ⇒ 无需挂起（省一次「挂起再唤醒」的空往返）
    const unmetTargets = merged.filter((d) => !TERMINAL_TASK_STATUSES.includes(byId.get(d).status));
    if (unmetTargets.length === 0) {
      return { ok: true, waiting: false, reason: 'deps_already_settled', waitingOn: merged, deadlineAt: null };
    }

    const ms = clampInt(timeoutMs, WAIT_TIMEOUT_MIN_MS, WAIT_TIMEOUT_MAX_MS, WAIT_TIMEOUT_DEFAULT_MS);
    const deadlineAt = this.now() + ms;
    let cycle = false;
    const tx = this.db.transaction(() => {
      // 事务内重读快照：判环与建边共用同一份 —— 两次并发建边无法各自通过（R3）
      const live = this.listTasks(groupId);
      cycle = this._wouldCycle(live, unmetTargets.map((d) => [taskId, d]));
      if (cycle) return;
      this.db.prepare(`UPDATE sub_tasks SET status = 'waiting', waiting_on_json = ?,
        wait_deadline_at = ?, wait_count = wait_count + 1 WHERE group_id = ? AND task_id = ?`)
        .run(JSON.stringify(merged), deadlineAt, groupId, taskId);
      this.touchGroup(groupId);
    });
    tx();
    if (cycle) return fail(`等待会成环：${taskId} → ${unmetTargets.join(', ')}（§7 规则 1：等待图必须无环）`);
    return { ok: true, waiting: true, waitingOn: merged, deadlineAt };
  }

  /**
   * 被等待任务到达终态后唤醒等待者（§7 规则 4：唤醒必须幂等）。
   *
   * 幂等由「按当前状态重判」天然成立：每次调用都重算一遍，`waiting → queued` 只会成功一次——
   * 完成事件重复投递时，第二次调用已找不到 waiting 任务，是空操作（即 (waiter, settled) 组合去重）。
   *
   * 部分满足**不**提前放行：只有「全部 waiting_on 目标都已终态」的等待者才唤醒，
   * 否则原地继续等（等 A 和 B 的任务，在 A 完成时不该立刻跑）。
   *
   * @param {string|null} settledTaskId 刚终态的任务 id；null = 扫描组内全部 waiting 任务
   * @returns {Array<{taskId:string,waitingOn:string[]}>} 本次被唤醒的任务
   */
  settleWaitingTasks(groupId, settledTaskId = null) {
    const tasks = this.listTasks(groupId);
    const byId = new Map(tasks.map((x) => [x.taskId, x]));
    const woken = [];
    const tx = this.db.transaction(() => {
      for (const t of tasks) {
        if (t.status !== 'waiting') continue;
        const waitingOn = t.waitingOn || [];
        if (settledTaskId && !waitingOn.includes(settledTaskId)) continue;
        const remaining = waitingOn.filter((d) => {
          const dep = byId.get(d);
          return dep && !TERMINAL_TASK_STATUSES.includes(dep.status);
        });
        if (remaining.length > 0) continue; // 还有未满足的依赖，保持等待
        this.db.prepare(`UPDATE sub_tasks SET status = 'queued', waiting_on_json = '[]',
          wait_deadline_at = NULL WHERE group_id = ? AND task_id = ?`).run(groupId, t.taskId);
        woken.push({ taskId: t.taskId, waitingOn });
      }
      if (woken.length) this.touchGroup(groupId);
    });
    tx();
    return woken;
  }

  /**
   * 等待超时唤醒（§7 规则 2）。到点仍未满足 ⇒ 判 failed(wait_timeout)，
   * 并把「被等待任务未完成」作为**结构化事实**写进 result 交 Lead 决策（绝不静默挂死）。
   *
   * 级联：超时任务自身成为终态 ⇒ 立即唤醒等它的其它任务（否则对方会白等到自己的超时 ——
   * 与 §9.1「级联中断必须主动发 settled 事件」同型）。
   * 不消耗自动重试次数：等待超时不是 Agent 失败，重跑由人工/重规划决定。
   *
   * @returns {Array<{groupId:string,taskId:string,waitingOn:string[],unmet:string[],woken:string[]}>}
   */
  sweepWaitTimeouts(now = Date.now()) {
    const rows = this.db.prepare(`SELECT group_id, task_id FROM sub_tasks
      WHERE status = 'waiting' AND wait_deadline_at IS NOT NULL AND wait_deadline_at <= ?`).all(now);
    const out = [];
    for (const r of rows) {
      const t = this.getTask(r.group_id, r.task_id);
      if (!t || t.status !== 'waiting') continue; // 竞态：期间已被正常唤醒
      const tasks = this.listTasks(r.group_id);
      const byId = new Map(tasks.map((x) => [x.taskId, x]));
      const unmet = (t.waitingOn || []).filter((d) => {
        const dep = byId.get(d);
        return dep && !TERMINAL_TASK_STATUSES.includes(dep.status);
      });
      this.db.prepare(`UPDATE sub_tasks SET status = 'failed', error = ?, result_json = ?,
        waiting_on_json = '[]', wait_deadline_at = NULL, finished_at = ?
        WHERE group_id = ? AND task_id = ?`)
        .run(`等待超时：依赖任务未在期限内完成（${unmet.join(', ') || '未知'}）`,
          JSON.stringify({ waitTimeout: true, waitingOn: t.waitingOn || [], unmet }),
          this.now(), r.group_id, t.taskId);
      this.touchGroup(r.group_id);
      const woken = this.settleWaitingTasks(r.group_id, t.taskId).map((w) => w.taskId);
      out.push({ groupId: r.group_id, taskId: t.taskId, waitingOn: t.waitingOn || [], unmet, woken });
    }
    return out;
  }

  /**
   * 取消组内等待中的任务（组强停 / 用户取消路径）。
   * 为什么必须显式处理：`waiting` 任务**不在** Worker 池的 activeRuns 里（槽位已释放），
   * 组级强停若只扫 queued/pending 会漏掉它们 ⇒ 组永远不结算、界面一直转圈。
   * 取消即终态 ⇒ 级联唤醒等它们的任务（否则那些任务会白等到自己的超时）。
   *
   * @returns {Array<{taskId:string,waitingOn:string[]}>} 被取消的任务
   */
  cancelWaiting(groupId, { error = '等待中的任务已被取消', exclude = [] } = {}) {
    const skip = new Set(exclude);
    const targets = this.listTasks(groupId).filter((t) => t.status === 'waiting' && !skip.has(t.taskId));
    const cancelled = [];
    for (const t of targets) {
      this.db.prepare(`UPDATE sub_tasks SET status = 'skipped', error = ?,
        waiting_on_json = '[]', wait_deadline_at = NULL, finished_at = ?
        WHERE group_id = ? AND task_id = ?`).run(error, this.now(), groupId, t.taskId);
      cancelled.push({ taskId: t.taskId, waitingOn: t.waitingOn || [] });
    }
    if (cancelled.length) {
      this.touchGroup(groupId);
      this.settleWaitingTasks(groupId);
    }
    return cancelled;
  }

  /**
   * R2 观测口径：动态等待占比 = 进入过 L2 等待的任务数 / 组内任务总数。
   * 意义：§7 的正解是把绝大多数依赖在**拆解阶段**用 L1（dependsOn）消解掉；该比值持续偏高
   * ⇒ Lead 拆不出跨成员依赖（R2），应从拆解提示词侧收敛，而不是继续给运行期等待路径加压。
   * `waiting` 为当前仍挂起的实时数量。
   */
  waitStats(groupId) {
    const tasks = this.listTasks(groupId);
    const waited = tasks.filter((t) => (t.waitCount || 0) > 0).length;
    const waiting = tasks.filter((t) => t.status === 'waiting').length;
    return { total: tasks.length, waited, waiting, ratio: tasks.length ? waited / tasks.length : 0 };
  }

  // 组是否已无待执行任务（收尾判定）
  // M5 / T5-3：`waiting` 必须计入「未结算」——等待中的任务尚未有结果，若把它当已结算，
  // 组会被提前聚合收尾，唤醒后的重跑就成了孤儿任务（永远不会再被调度）。
  // T6-4（§5.1）：`quota_suspend` 同理必须计入——它是**非终态**，配额老化后会被恢复重跑；
  // 若在收尾判定里漏掉，组会在暂停期间被误判完成并 finalize，恢复出来的任务成为孤儿。
  isGroupSettled(groupId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM sub_tasks
      WHERE group_id = ? AND status IN ('pending','queued','running','waiting','quota_suspend')`).get(groupId);
    return row.n === 0;
  }

  groupHasBlockingFailure(groupId) {
    const tasks = this.listTasks(groupId);
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    // 关键任务失败，且任何「未完结」任务（直接或传递）依赖它 → 阻塞，组需要暂停
    const unfinished = (t) => !['done', 'failed', 'skipped'].includes(t.status);
    return tasks
      .filter((t) => t.status === 'failed' && t.critical)
      .some((failed) => tasks.some((x) => x.taskId !== failed.taskId && unfinished(x)
        && dependsTransitively(byId, x, failed.taskId, new Set())));
  }

  // 崩溃恢复：running → queued（Electron 重启后 WorkerPool 重新领取）
  // V14（2026-10-16，方案 §11 / R4-N5）：重启恢复**不再盲目重放**。
  // 原实现 running → queued 直接回队 + 组自动续跑——被中断任务可能已完成部分副作用
  //（写文件/发请求/安装包），重放 = 同一操作执行两次且用户不知情；副作用账本
  //（pending/committed/uncertain）就位前，执行状态不可确认的任务一律不自动重放（fail-closed）。
  // 现契约：running → failed（needsReview：中断原因写入 error，不消耗自动重试次数）；
  //         运行中的组 → paused（等待用户人工核对后手动续跑）；
  //         queued 保持原状（从未启动，无副作用，无风险）。
  recoverInterrupted() {
    const now = this.now();
    const interrupted = this.db.prepare(`SELECT group_id, task_id FROM sub_tasks WHERE status = 'running'`).all();
    const runningGroups = this.db.prepare(`SELECT group_id FROM task_groups WHERE status = 'running'`).all();
    const tx = this.db.transaction(() => {
      for (const r of interrupted) {
        this.db.prepare(`UPDATE sub_tasks SET status = 'failed',
          error = ?, result_json = ?, worker_id = NULL, finished_at = ?
          WHERE group_id = ? AND task_id = ?`)
          .run('应用重启导致执行中断（不自动重放：已执行的副作用无法确认，请人工核对后重试）',
            JSON.stringify({ needsReview: true, interruptedByRestart: true }),
            now, r.group_id, r.task_id);
      }
      for (const g of runningGroups) {
        this.db.prepare(`UPDATE task_groups SET status = 'paused', updated_at = ? WHERE group_id = ?`).run(now, g.group_id);
      }
    });
    tx();
    return {
      recoveredTasks: interrupted.map((r) => ({ groupId: r.group_id, taskId: r.task_id })),
      pausedGroups: runningGroups.map((g) => g.group_id),
    };
  }

  // ── 副作用账本（N5，方案 §11）──
  // V14「不自动重放」的可审计地基：Worker 领取任务即记 uncertain（可能产生副作用），
  // 任务终态时 resolved。重启恢复时 uncertain 记录原样保留——它们正是「副作用无法确认」
  // 的清单，随 needsReview 一起供人工核对（UI 消费在 R6 编排波次）。
  markEffectUncertain(groupId, taskId) {
    const existing = this.db.prepare('SELECT id FROM side_effects WHERE group_id = ? AND task_id = ?').get(groupId, taskId);
    if (existing) {
      // 重试重新领取：回到 uncertain（resolved_at 清空）
      this.db.prepare(`UPDATE side_effects SET state = 'uncertain', resolved_at = NULL WHERE id = ?`).run(existing.id);
      return;
    }
    this.db.prepare('INSERT INTO side_effects (group_id, task_id, state, created_at) VALUES (?, ?, ?, ?)')
      .run(groupId, taskId, 'uncertain', this.now());
  }

  resolveEffect(groupId, taskId) {
    this.db.prepare(`UPDATE side_effects SET state = 'resolved', resolved_at = ? WHERE group_id = ? AND task_id = ?`)
      .run(this.now(), groupId, taskId);
  }

  // 组内副作用仍为 uncertain 的任务清单（needsReview 人工核对的输入）
  listUncertainEffects(groupId) {
    return this.db.prepare(`SELECT task_id FROM side_effects WHERE group_id = ? AND state = 'uncertain'`).all(groupId).map((r) => r.task_id);
  }

  // P1-13：是否存在「早于最近一次领取」的未闭合副作用记录。
  // 正常运行到达终态时账本会被 resolveEffect 闭合；残留的更早记录只可能来自
  // 崩溃/强杀恢复（那次运行没走到终态，副作用是否落盘不可知）。自动重试前必须人工核对，
  // 否则重复执行同一批写操作/发请求（重复 pr / 重复转账类事故面）。
  // 注意不能用 needsRetryReview（它把**本次领取**刚记的 uncertain 也算进去——
  // 每次失败都会命中，自动重试功能整体失效）。
  hasPriorUncertainEffects(groupId, taskId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM side_effects
      WHERE group_id = ? AND task_id = ? AND state = 'uncertain'
      AND created_at < (SELECT MAX(created_at) FROM side_effects WHERE group_id = ? AND task_id = ?)`)
      .get(groupId, taskId, groupId, taskId);
    return (row?.n || 0) > 0;
  }

  // A5（2026-10-16）：重试前置核对的判定——纯查询，供 IPC 层与测试共用。
  // 语义：该任务上次运行留下了「副作用无法确认」的记录（可能已写文件/已发请求），
  // 且调用方尚未显式确认（confirmReview !== true）→ 必须先核对再重试，避免重复执行同一批操作。
  // 提取为方法而非内联在 IPC handler 里，是为了让它可被单测直接驱动（handler 依赖 electron，不可单测）。
  needsRetryReview(groupId, taskId, confirmReview = false) {
    if (confirmReview === true) return false;
    return this.listUncertainEffects(groupId).includes(taskId);
  }

  // ── 任务活动轨迹（M5 / T5-6，2026-10-21）──
  // 为什么持久化：task_activity 此前只走 IPC 实时广播，刷新/重进会话即丢，
  // 看板与对话卡只能显示「执行中」，用户无法回答「这个员工到底做了什么、为什么被撤下」。
  // 写入只收关键事件（start/tool/stall/reassign/wait/stop/error/report），
  // payload 在调用侧裁剪（工具参数 80 字符上限），不写 prompt/文件正文。
  appendEvent({ groupId, taskId = null, type, payload = null } = {}) {
    const gid = String(groupId || '');
    if (!gid) return null;
    const t = String(type || '');
    if (!t) return null;
    const info = this.db.prepare(
      'INSERT INTO task_events (group_id, task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(gid, taskId == null ? null : String(taskId), t, payload ? JSON.stringify(payload) : null, this.now());
    // better-sqlite3 给 lastInsertRowid；sql.js 的 run 返回 [{ lastID }] 由兼容层归一
    return Number(info?.lastInsertRowid || info?.lastID || 0) || null;
  }

  // 组内活动轨迹（按 id 升序 = 发生顺序）。limit 为**每组**上限，取最近 N 条后升序返回。
  listEventsByGroup(groupId, { limit = 500 } = {}) {
    const gid = String(groupId || '');
    if (!gid) return [];
    const cap = Math.min(2000, Math.max(1, Math.trunc(Number(limit) || 500)));
    const rows = this.db.prepare(
      'SELECT * FROM task_events WHERE group_id = ? ORDER BY id DESC LIMIT ?',
    ).all(gid, cap);
    return rows.reverse().map((r) => ({
      id: Number(r.id) || 0,
      groupId: r.group_id,
      taskId: r.task_id || null,
      type: r.type,
      payload: safeParse(r.payload_json),
      createdAt: Number(r.created_at) || 0,
    }));
  }

  // 组删除时级联清理轨迹（与 side_effects 同事务，避免孤儿行无限增长）
  clearEvents(groupId) {
    this.db.prepare('DELETE FROM task_events WHERE group_id = ?').run(String(groupId || ''));
  }

  touchGroup(groupId) {
    this.db.prepare('UPDATE task_groups SET updated_at = ? WHERE group_id = ?').run(this.now(), groupId);
  }
}

function dependsTransitively(byId, task, targetId, visiting) {
  if (visiting.has(task.taskId)) return false;
  visiting.add(task.taskId);
  for (const d of task.dependsOn) {
    if (d === targetId) return true;
    const dep = byId.get(d);
    if (dep && dependsTransitively(byId, dep, targetId, visiting)) return true;
  }
  return false;
}

function rowToTask(r) {
  return {
    taskId: r.task_id, groupId: r.group_id, seq: r.seq, title: r.title, prompt: r.prompt,
    dependsOn: safeParse(r.depends_on) || [], critical: !!r.critical,
    maxRetry: r.max_retry, timeoutMs: r.timeout_ms, status: r.status, retryCount: r.retry_count,
    result: safeParse(r.result_json), error: r.error, workerId: r.worker_id,
    startedAt: r.started_at, finishedAt: r.finished_at,
    // M5 / T5-3：等待态与被动认领的读取面。必须在此暴露，否则 _wouldCycle 读 t.waitingOn、
    // settleWaitingTasks 读 t.waitingOn、waitStats 读 t.waitCount 全部恒为 undefined，
    // 环检测与唤醒判定集体失真（静默失效，不报错——最危险的那种）。
    ownerMemberId: r.owner_member_id, claimedAt: r.claimed_at,
    waitingOn: safeParse(r.waiting_on_json) || [],
    waitDeadlineAt: r.wait_deadline_at, waitCount: r.wait_count || 0,
  };
}

function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// M5 / T5-3：等待时长入参的边界收敛（单一事实来源）。非法/缺省一律回落 fallback，
// 再夹到 [min, max]。teamStore.js 有同名函数，但两模块无导入关系，就地复制以免跨模块耦合。
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

module.exports = {
  TaskStore, canTransition, TASK_TRANSITIONS, GROUP_TRANSITIONS,
  TERMINAL_TASK_STATUSES, MAX_WAIT_DEPS,
  WAIT_TIMEOUT_DEFAULT_MS, WAIT_TIMEOUT_MIN_MS, WAIT_TIMEOUT_MAX_MS,
};
