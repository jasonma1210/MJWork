// M5 / T5-12：批次（wave）运行时引擎（设计稿 v1.5 §13.4）——批次状态 + 探活定时器 + 撤员降级。
//
// 拆分背景（2026-10-20）：T5-12 的批次运行时落在 workerPool.js 后使其越过 800 行软档
// （God File 门禁 max-lines.test.js）。按「先拆再合入」纪律抽出本文件：
//   · workerPool 只保留**接入点**（attach / detach / allowOf / preferredOwnerOf / takeStall）；
//   · 本文件持有全部批次运行时状态与定时器，通过宿主注入的回调（emit / schedule / 并发档读写）
//     与 workerPool 交互——**不反向 require workerPool**，避免循环依赖。
//
// 设计取舍（唯一权威，workerPool 侧只留接入说明）：
//   · 批次计划只在派活时算一次并随 dag_json 落库，运行期不重算（可复现、可审计）；
//   · 批间串行 = 入队门控（allowedTaskIds → taskStore.enqueueReady 的 allowIds），不改状态机；
//   · 探活 = 三通道（trace 计数 / team_messages 序号 / 子任务状态签名）连续无变化才判停滞；
//   · 撤员 = 中止本批最早在役 run + 记重派意图（真正的 requeue 由 workerPool 收尾消费，避免竞争）。

const teamWaves = require('./teamWaves');
// 2026-10-21 团队调试日志：批次推进 / 探活判定 / 撤员重派（「任务卡住不动」的第一现场）。
const teamDebug = require('./teamDebugLog');

/**
 * @param {object} host 宿主回调（workerPool 在 initWorkerPool 时注入）
 *   · getDeps: () => 池的 deps（store / getTeamMessageSeq / resolveTeamRoster）
 *   · activeRuns: Map<runKey, entry>（在役 run；探活撤员需挑受害者并触发其 abort）
 *   · emit: (evt) => void（事件出口 = workerPool 的 emitTask，兼作探活第一通道计数）
 *   · schedule: () => void（撤员后推进调度）
 *   · broadcastWoken / discardIso: 撤员收尾复用池侧既有实现（避免本文件重复实现等待唤醒/isolation 清理）
 *   · **并发降档（B-15 收口）**：
 *       - `lowerGroupConcurrency(groupId)`：优先使用——只降**本组**并发档，不波及其它 run；
 *       - `restoreGroupConcurrency(groupId)`：本组收尾时还原；
 *       - `getMaxConcurrent / setMaxConcurrent`：保留为旧宿主注入的兼容回退（无分组函数时才用）。
 *   · **时序注入（2026-10-21 新增，为探活撤员的端到端测试）**：
 *       - `now: () => number`：时钟（默认 `Date.now`）。撤员的判据含「真实静默超窗
 *         `WAVE_PROBE_IDLE_MS=120000`」，测试不可能真等 2 分钟。
 *       - `autoTimer: boolean`：是否自建 `setInterval`（默认 true）。测试传 false，
 *         改用返回的 `probeOnce()` 手动推进——真实定时器在 unref 后还可能因进程退出而不触发，
 *         靠真实等待来测这类逻辑既慢又不稳。
 *       - `probeIntervalMs`：探活间隔（默认 `WAVE_PROBE_INTERVAL_MS=5000`）。
 */
function createWaveEngine(host) {
  const {
    getDeps, activeRuns, emit, schedule, broadcastWoken, discardIso, getMaxConcurrent, setMaxConcurrent,
    lowerGroupConcurrency, restoreGroupConcurrency,
    now = () => Date.now(),
    autoTimer = true,
    probeIntervalMs = teamWaves.WAVE_PROBE_INTERVAL_MS,
  } = host;

  // groupId -> { waves, probe, traceSeq, lastActivityAt, reassign:Map, lowered, retired, pendingReassign }
  const runtimes = new Map();
  let timer = null;
  let concurrencyBefore = null; // 降档前并发基线（全部批次收尾后还原，避免持续拖慢其它 run）

  // 探活第一通道：所有 task_* 事件都经 workerPool 的 emit 出口统一累加，
  // 因此不需要改动既有的二十余处 emit 调用点（少一处改动就少一分漂移风险）。
  function countTrace(evt) {
    if (!evt || !evt.groupId) return;
    if (!String(evt.type || '').startsWith('task_')) return;
    const rt = runtimes.get(evt.groupId);
    if (!rt) return;
    rt.traceSeq += 1;
    // 任何任务事件（工具调用 / 状态推进 / 消息）都算「活着」，刷新静止窗口基准。
    rt.lastActivityAt = now();
  }

  // 探活第三通道：子任务状态签名
  function statusSignature(groupId) {
    try {
      return (getDeps()?.store?.listTasks?.(groupId) || []).map((t) => `${t.taskId}:${t.status}`).join(',');
    } catch { return ''; }
  }

  function sampleSignals(groupId) {
    const rt = runtimes.get(groupId);
    let messageSeq = 0;
    try { messageSeq = Number(getDeps()?.getTeamMessageSeq?.(groupId)) || 0; } catch { messageSeq = 0; }
    // 静止时长：距本组最后一次 task_* 事件（含工具调用）的毫秒数。
    // 无运行时（未装配）时给 0 —— 探活器只在有运行时才会被调用。
    const idleMs = rt ? Math.max(0, now() - (Number(rt.lastActivityAt) || 0)) : 0;
    return { traceSeq: rt ? rt.traceSeq : 0, messageSeq, statusSignature: statusSignature(groupId), idleMs };
  }

  /**
   * 撤员（§13.4 降级协议）：探活连续 3 次无进展**且真实静默超窗** ⇒ 中止本批**最早**的在役任务，
   * 交回 queued 并改派同类型备用成员；无同类型备用则按失败收尾（并入汇总卡）。
   * 两条防雪崩闸（2026-10-21 真机事故）：
   *   ① 单任务最多撤 1 次（MAX_REASSIGN_PER_TASK）——撤过的任务再静默，交给墙钟超时这一权威兜底，
   *      不再「反复撤同一人 → 同类型备用耗尽 → 任务误判失败」；
   *   ② 并发降档每组只做一次——此前每次撤员都减半，连续撤员把并发压到 1，吞吐崩塌。
   */
  function handleStall(groupId) {
    const rt = runtimes.get(groupId);
    if (!rt) return false;
    const running = [...activeRuns.entries()]
      .filter(([runKey]) => runKey.startsWith(`${groupId}/`))
      .map(([runKey, entry]) => ({ runKey, taskId: runKey.slice(groupId.length + 1), entry }));
    if (!running.length) return false;

    // 只挑「还没被撤过」的任务；全部撤过 ⇒ 本轮放弃撤员（不判 failed，避免误杀）。
    const victim = running.find((r) => (rt.reassign.get(r.taskId) || 0) < teamWaves.MAX_REASSIGN_PER_TASK);
    if (!victim) return false;

    const deps = getDeps();
    const task = deps?.store?.getTask?.(groupId, victim.taskId);
    // T5-9：撤员改派也读**本 run 快照**（而非实时名册）——快照在 dag_json 里，需要组对象；
    // 拿不到组时退回实时反查（diff 语义只在快照缺失的旧数据上出现）。
    const group = deps?.store?.getGroup?.(groupId);
    const roster = deps?.resolveTeamRoster?.(group || { group_id: groupId }) || [];
    const ownerId = String(task?.ownerMemberId || '');
    const owner = roster.find((m) => String(m.id) === ownerId) || null;
    const typeKey = owner ? teamWaves.memberTypeOf(owner) : null;
    const busy = new Set(running.map((r) => String(deps?.store?.getTask?.(groupId, r.taskId)?.ownerMemberId || '')));
    const backup = typeKey
      ? teamWaves.pickBackupMember({ members: roster, typeKey, excludeIds: [...rt.retired, ownerId], busyIds: [...busy] })
      : null;
    teamDebug.log('wave', 'stall_retire', {
      groupId,
      victimTaskId: victim.taskId,
      victimOwner: owner?.name || ownerId || null,
      typeKey,
      backup: backup || null,
      sameMember: !backup,
      retireCount: rt.reassign.get(victim.taskId) || 0,
      running: running.map((r) => r.taskId),
      rosterSize: roster.length,
    });
    if (ownerId) rt.retired.add(ownerId);
    rt.reassign.set(victim.taskId, (rt.reassign.get(victim.taskId) || 0) + 1);

    // 并发降档（B-15）：只降**本组**（每组一次），不再动全局 maxConcurrent ——
    // 此前某个组静默撤员会把所有并行 run 一起拖慢，属于放大故障的全局副作用。
    if (!rt.lowered) {
      rt.lowered = true;
      if (typeof lowerGroupConcurrency === 'function') {
        lowerGroupConcurrency(groupId);
      } else if (typeof setMaxConcurrent === 'function') {
        // 兼容回退：旧宿主只提供了全局读写（单测/旧装配），行为与改前一致。
        if (concurrencyBefore == null) concurrencyBefore = getMaxConcurrent();
        const next = Math.max(1, Math.floor(getMaxConcurrent() / 2));
        if (next < getMaxConcurrent()) setMaxConcurrent(next);
      }
    }

    emit({
      type: 'task_activity', groupId, taskId: victim.taskId, name: victim.entry.name, kind: 'stall',
      textKey: 'runtime.workerStalled',
      textParams: { name: victim.entry.name, member: owner?.name || ownerId || '—' },
    });
    // 记重派意图：真正的 requeue 在 workerPool 的 runWorkerTask 收尾里执行（此时 run 尚未退出，
    // 直接 setTaskStatus 会与它的终态落库竞争，出现「先 queued 又被覆盖成 failed」）。
    // 无同类型备用时**不判失败**，而是把任务重新排队给原成员再跑一次（captured by reassign 上限）——
    // 单次探活误判不该把任务打成终态，真正的兜底是任务墙钟超时。
    rt.pendingReassign.set(victim.runKey, {
      memberId: backup || ownerId || null,
      sameMember: !backup,
      fromMember: owner?.name || ownerId || null,
      // fromMemberId 与 fromMember **不能合并**：前者是主键（setMemberState 的 WHERE id=?），
      // 后者是展示名（活动流文案）。混用会写出 `WHERE id='慢成员'` —— 匹配 0 行，静默空过。
      fromMemberId: ownerId || null,
    });
    victim.entry.controller.abort(new Error('探活判定无进展：撤员重派'));
    return true;
  }

  // 单拍探活：对每个在跑的团队组各采样一次，命中停滞即撤员。
  // 抽成独立函数（2026-10-21）：定时器只是它的驱动方式之一 —— 测试用注入时钟 + 手动
  // `probeOnce()` 推进，既能精确构造「静默超窗 + 连续三拍无变化」，又不必真等 15s~2min。
  // 正文逻辑与原 setInterval 回调**逐字等价**（不是重写），保证测试验的就是生产路径。
  function probeOnce() {
    const stalledGroups = [];
    for (const gid of [...runtimes.keys()]) {
      const rt = runtimes.get(gid);
      if (!rt) continue;
      let r = null;
      try { r = rt.probe.sample(sampleSignals(gid)); } catch { continue; }
      if (!r.stalled) continue;
      teamDebug.log('wave', 'probe_stalled', { groupId: gid, waves: rt.waves?.length || 0, result: r }, { level: 'verbose' });
      rt.probe.reset(); // 先复位：撤员动作本身可能不被三通道捕捉，避免下一拍连杀
      try { if (handleStall(gid)) stalledGroups.push(gid); }
      catch (e) { console.warn('[waveEngine] 探活撤员失败:', e?.message || e); }
    }
    return stalledGroups;
  }

  // 单一定时器覆盖所有在跑的团队组（每组各自采样）
  function ensureTimer() {
    if (!autoTimer) return; // 测试模式：由调用方手动 probeOnce()
    if (timer || typeof setInterval !== 'function') return;
    timer = setInterval(probeOnce, probeIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function detach(groupId) {
    if (!runtimes.has(groupId)) return;
    runtimes.delete(groupId);
    if (runtimes.size === 0 && timer) { clearInterval(timer); timer = null; }
    // B-15：组级降档随组收尾还原（只影响本组；不会覆盖其它组的并发档）。
    if (typeof restoreGroupConcurrency === 'function') {
      restoreGroupConcurrency(groupId);
    } else if (runtimes.size === 0 && concurrencyBefore != null) {
      // 兼容回退：旧全局语义（全部批次收尾后还原）。
      setMaxConcurrent(concurrencyBefore);
      concurrencyBefore = null;
    }
  }

  /** 装配一个团队组的批次运行时（重复装配先卸旧，避免状态跨 run 泄漏）。 */
  function attach(groupId, waves) {
    if (runtimes.has(groupId)) detach(groupId);
    runtimes.set(groupId, {
      waves,
      // 探活：连续 3 拍签名不变 **且** 真实静默超过 WAVE_PROBE_IDLE_MS 才判停滞。
      probe: teamWaves.createWaveProbe({ idleWindow: teamWaves.WAVE_PROBE_IDLE_MS }),
      traceSeq: 0,
      lastActivityAt: now(),
      reassign: new Map(), // taskId -> 已被探活撤员的次数（上限 MAX_REASSIGN_PER_TASK）
      lowered: false, // 本组是否已降过并发档（每组只降一次）
      retired: new Set(),
      pendingReassign: new Map(),
    });
    teamDebug.log('wave', 'attach', { groupId, waves });
    ensureTimer();
  }

  function detachAll() { for (const gid of [...runtimes.keys()]) detach(gid); }

  function waveCount(groupId) { return runtimes.get(groupId)?.waves?.length || 0; }

  /** 当前批次允许入队的任务 id；无批次计划返回 null（= 不限制，保持既有 DAG 调度）。 */
  function allowOf(group) {
    const rt = runtimes.get(group?.group_id);
    if (!rt) return null;
    try { return teamWaves.allowedTaskIds(rt.waves, getDeps()?.store?.listTasks?.(group.group_id) || []); }
    catch { return null; }
  }

  /** 批次计划的指派执行者；已被撤员的成员不再参与指派（§13.4「撤员后不得派回同一人」）。 */
  function preferredOwnerOf(group, task) {
    const wanted = group?.dag?.assignments?.[task?.taskId];
    if (!wanted) return null;
    const rt = runtimes.get(group.group_id);
    if (rt && rt.retired.has(String(wanted))) return null;
    return String(wanted);
  }

  /** 剔除已撤员成员后的名册（防「计划缺失 → seq 取模」回退把刚撤下的人派回来）。 */
  function eligibleRoster(groupId, roster) {
    const rt = runtimes.get(groupId);
    if (!rt || !Array.isArray(roster)) return roster;
    return roster.filter((m) => m && !rt.retired.has(String(m.id)));
  }

  /** 消费撤员重派意图（一次性；workerPool 在 runWorkerTask 收尾处取用）。 */
  function takeStall(groupId, runKey) {
    const rt = runtimes.get(groupId);
    if (!rt) return null;
    const s = rt.pendingReassign.get(runKey) || null;
    if (s) rt.pendingReassign.delete(runKey);
    return s;
  }

  /**
   * 落地撤员意图（§13.4）：run 已经退出、终态尚未落库的**唯一安全窗口**。
   * 必须早于失败分支消费——否则 abortReason 分支会把撤员当成「超时失败」，撤员就白撤了。
   * @returns {Promise<boolean>} true = 本 run 已由撤员处置接管（调用方直接 return）
   */
  async function consumeStall(group, task, runKey, { iso = null, workerName = '' } = {}) {
    const stall = takeStall(group?.group_id, runKey);
    if (!stall) return false;
    const store = getDeps()?.store;
    // 本轮隔离副本不再有意义（重派会以新副本重跑；无备用则任务已终态）——丢弃不泄漏。
    if (iso) { try { await discardIso?.(iso); } catch { /* 清理失败不阻断撤员 */ } }
    if (stall.memberId) {
      // 换人不换任务：回 queued + owner 覆盖为备用成员（reassignTask 语义）。
      // 无备用时 owner 不变（同人重跑一次），不再「探活一次即判死」。
      store?.reassignTask?.(group.group_id, task.taskId, stall.memberId, {
        error: stall.sameMember
          ? '探活判定长时间无进展：已重新排队重跑（无同类型备用成员可改派）'
          : '探活判定无进展：已撤员并改派同类型备用成员',
      });
      emit({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'queued' });
      emit({
        type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name: workerName,
        kind: 'reassign',
        textKey: stall.sameMember ? 'runtime.workerRequeued' : 'runtime.workerReassigned',
        textParams: { name: workerName, from: stall.fromMember || '—' },
      });
      // D4-03：本函数返回 true 后 workerPool 在「终态→idle」回写之前就 return 了，被撤掉的成员
      // 会永久停在 busy（名册里留着僵尸、派活还会再选中它）。撤员（非同人重跑）必须显式置 offline；
      // 同人重跑不动状态（它马上还会被派同一任务）。fail-open：回写失败不阻断撤员。
      if (!stall.sameMember && stall.fromMemberId) { try { getDeps()?.setMemberState?.(stall.fromMemberId, 'offline'); } catch { /* 状态回写失败不阻断撤员 */ } }
    } else {
      // 没有任何成员归属（理论上不会发生在团队组）→ 只能按失败收尾。
      store?.setTaskStatus?.(group.group_id, task.taskId, 'failed', {
        error: '探活判定无进展，且任务没有可重跑的认领成员', skipRetryCount: true,
      });
      emit({
        type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed',
        error: '探活判定无进展，且任务没有可重跑的认领成员',
      });
      // D4-03 同源：任务按失败终态收尾，认领成员也必须从 busy 放回 idle（否则永久占位）。
      if (task.ownerMemberId) { try { getDeps()?.setMemberState?.(task.ownerMemberId, 'idle'); } catch { /* 状态回写失败不阻断撤员 */ } }
    }
    // 无备用（任务已 failed 终态）时需级联唤醒等它的任务；重派（回 queued）时为无害空操作。
    try { broadcastWoken?.(group.group_id, store?.settleWaitingTasks?.(group.group_id, task.taskId) || []); }
    catch (e) { console.warn('[waveEngine] 撤员后的等待唤醒失败:', e?.message || e); }
    schedule();
    return true;
  }

  return {
    countTrace, attach, detach, detachAll, waveCount, allowOf, preferredOwnerOf, eligibleRoster, takeStall, consumeStall,
    // 时序注入配套：手动推进一拍探活（生产由 setInterval 驱动，测试传 autoTimer:false 后用它）
    probeOnce,
  };
}

module.exports = { createWaveEngine };
