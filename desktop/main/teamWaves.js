// M5 / T5-12：Chief 运行期批次编排与降级（设计稿 v1.5 §13.4）——wave 计划 / 人数闸 / 类型闸 / 探活。
//
// 定位：**纯策略层**。不碰数据库、不碰 Worker 池、不调模型，全部输入由调用方给：
//   · planWaves   拆解完成后由宿主（ipc/teams.js）调用，产出批次计划并随 dag_json 落库；
//   · 当前批次门控（currentWave / allowedTaskIds）由 workerPool.pump 消费，只放行本批任务入队；
//   · 探活（createWaveProbe / startWaveProbe）由 workerPool 的定时器驱动，命中连续 3 次无进展
//     时回调宿主撤员重派。
// 之所以抽成纯模块：批次分配与探活判定是最需要「确定性单测」的部分，纯函数 + 注入时钟即可
// 不依赖真实计时；混进 workerPool 后只能靠真跑定时器，必然变成 flaky 测试。
//
// 依赖注入（仅探活定时器）：{ setIntervalFn, clearIntervalFn } —— 单测注入可控时钟。

// ── 常量（单一事实来源，§13.4 表）──
// 注意：MAX_MEMBERS_PER_TEAM（在册 20）住在 teamStore.js，二者语义不同——
// 在册是「可招募名录」，参与是「一次 run 实际调度的人数」。此处只定义参与侧。
const MAX_ACTIVE_MEMBERS = 10;
const MAX_PER_TYPE_IN_RUN = 2;
const WAVE_PROBE_INTERVAL_MS = 5000;
const WAVE_PROBE_MAX_MISSES = 3;
// 静止时间窗（2026-10-21 真机事故修复）：三通道签名在「模型推理等待期」天然无变化——
// 首字节 8s+ 时既没有 task_* 事件、也没有 team_messages、任务状态也不会变。
// 只看「连续 3 拍签名不变」（15s）会把正常推理判成停滞，进而撤员/降并发/最终无备用可改派。
// 因此停滞必须同时满足「签名无变化」且「整组真实静默超过本窗口」。
const WAVE_PROBE_IDLE_MS = 120000;
const MAX_WAVES = 3;
// 单任务最多被探活撤员改派次数：超过后不再撤（交给墙钟超时这一权威兜底），
// 避免「同一任务被反复撤下 → 同类型备用耗尽 → 误判失败」的雪崩。
const MAX_REASSIGN_PER_TASK = 1;

// 组内任务终态（与 taskStore.TERMINAL_TASK_STATUSES 同义；此处不 import 以免策略层耦合存储层）
const TERMINAL_TASK_STATUSES = ['done', 'failed', 'skipped'];

/**
 * 成员类型判据（§13.4「类型判据」）：
 *   ① 优先 `template_ref`——同一生态员工＝同类型（可取证，最可靠）；
 *   ② `source='custom'` 回落能力标签聚类（工具白名单排序后作为签名）；
 *   ③ 无标签时按 `role_kind` 粗分。
 * 返回字符串签名，仅用于比较相等性，不参与展示。
 */
function memberTypeOf(member) {
  const m = member || {};
  const tpl = String(m.templateRef == null ? '' : m.templateRef).trim();
  if (tpl) return `tpl:${tpl}`;
  const tools = (Array.isArray(m.toolNames) ? m.toolNames : [])
    .map((t) => String(t || '').trim()).filter(Boolean).sort();
  if (tools.length) return `tools:${tools.join(',')}`;
  return `role:${String(m.roleKind || 'member')}`;
}

/**
 * 参与成员筛选：人数硬闸 MAX_ACTIVE_MEMBERS + 同类型软闸 MAX_PER_TYPE_IN_RUN。
 * 超出类型闸的成员进入 deferred（reason='typeCap'），超出人数闸的进入 deferred（reason='memberCap'）。
 * 顺序遵循入参名册序（teamStore 按 created_at ASC），保证重放同一团队得到同一名单。
 */
function selectActiveMembers(members, { maxActive = MAX_ACTIVE_MEMBERS, maxPerType = MAX_PER_TYPE_IN_RUN } = {}) {
  const list = (Array.isArray(members) ? members : []).filter((m) => m && m.id);
  const active = [];
  const deferred = [];
  const byType = new Map();
  for (const m of list) {
    if (active.length >= maxActive) { deferred.push({ id: String(m.id), reason: 'memberCap' }); continue; }
    const type = memberTypeOf(m);
    const used = byType.get(type) || 0;
    if (used >= maxPerType) { deferred.push({ id: String(m.id), reason: 'typeCap', type }); continue; }
    byType.set(type, used + 1);
    active.push(m);
  }
  return { active, deferred };
}

/** 拓扑层级（纯函数）：level(t) = 1 + max(level(deps))；缺失依赖按 0 计（不阻塞，交给运行期判断）。 */
function computeLevels(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const visiting = new Set();
  const levelOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0; // 成环时截断（validateDag 已在前置阶段拒绝成环）
    const t = byId.get(id);
    if (!t) return 0;
    visiting.add(id);
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    let lv = 0;
    for (const d of deps) if (byId.has(d)) lv = Math.max(lv, levelOf(d) + 1);
    visiting.delete(id);
    memo.set(id, lv);
    return lv;
  };
  for (const t of tasks) levelOf(t.id);
  return memo;
}

/**
 * 批次计划（§13.4「wave 生成」）：
 *   · wave1 = 可立刻开始的最小子集（按拓扑层分批，每批不超过「参与成员数」）；
 *   · 层内任务均分到多个批次，避免一次铺满（用户口径：先起一小批，看进展再放下一批）；
 *   · 批次数上限 MAX_WAVES：超出时把尾部批次**合并进最后一批**（依赖仍由 taskStore 按
 *     depends_on 强制，合并只放宽派发门控，不会让后置任务提前跑）。
 * assignments：任务 → 成员（批内轮转，按名册序），仅在名册非空时产出。
 *
 * @returns {{ok:boolean, waves:Array<{index:number,level:number,taskIds:string[]}>, assignments:Object,
 *   activeMemberIds:string[], deferredMembers:Array, reason?:string}}
 */
function planWaves({ tasks, members, maxWaves = MAX_WAVES, maxPerType = MAX_PER_TYPE_IN_RUN } = {}) {
  const list = (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.id)
    .map((t, i) => ({ ...t, __order: i }));
  if (!list.length) {
    return { ok: false, reason: 'empty_tasks', waves: [], assignments: {}, activeMemberIds: [], deferredMembers: [] };
  }
  const { active, deferred } = selectActiveMembers(members, { maxPerType });
  const levels = computeLevels(list);
  const byLevel = new Map();
  for (const t of list) {
    const lv = levels.get(t.id) || 0;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(t);
  }

  // 批大小 = 参与成员数；名册为空（理论上不会发生：dispatch 已校验 Lead 存在）时按人数硬闸兜底，
  // 否则 max(0,0) 会让分批退化成一个任务一批，把 MAX_WAVES 瞬间用光。
  const chunkSize = Math.max(1, active.length || MAX_ACTIVE_MEMBERS);
  let waves = [];
  for (const lv of [...byLevel.keys()].sort((a, b) => a - b)) {
    const items = byLevel.get(lv).sort((a, b) => a.__order - b.__order);
    for (let i = 0; i < items.length; i += chunkSize) {
      waves.push({ level: lv, taskIds: items.slice(i, i + chunkSize).map((t) => String(t.id)) });
    }
  }
  // 批次数兜底：尾部合并（R7：MAX_WAVES ＋ G2 max_wall_ms 双闸）
  if (waves.length > maxWaves) {
    const head = waves.slice(0, maxWaves - 1);
    const tail = waves.slice(maxWaves - 1);
    head.push({ level: tail[tail.length - 1].level, taskIds: tail.flatMap((w) => w.taskIds), merged: true });
    waves = head;
  }
  waves = waves.map((w, i) => ({
    index: i + 1,
    level: w.level,
    taskIds: w.taskIds,
    ...(w.merged ? { merged: true } : {}),
  }));

  // 任务 → 成员：批内轮转（每批从批序号起偏移，避免每批都从同一个人开始）。
  const assignments = {};
  for (let wi = 0; wi < waves.length; wi += 1) {
    const w = waves[wi];
    if (!active.length) break;
    for (let i = 0; i < w.taskIds.length; i += 1) {
      assignments[w.taskIds[i]] = String(active[(wi + i) % active.length].id);
    }
  }

  return {
    ok: true,
    waves,
    assignments,
    activeMemberIds: active.map((m) => String(m.id)),
    deferredMembers: deferred,
    // 第八轮 B-05：把「闸门取值」随计划一起返回，让落库的 deferred 名单旁边就有可解释的口径
    // （否则界面只能说「3 人未参与」，说不出「因为同类型上限 2」）。
    caps: { maxActive: MAX_ACTIVE_MEMBERS, maxPerType: MAX_PER_TYPE_IN_RUN },
  };
}

/**
 * 归一化落库的 waves（dag_json.waves）。非法条目整条丢弃——批次计划是**加速与限流**，
 * 读不到时应退化为「无分批」（既有 DAG 调度），绝不能因为脏数据让组卡住。
 */
function normalizeWaves(group) {
  const raw = group && group.dag && Array.isArray(group.dag.waves) ? group.dag.waves : null;
  if (!raw || !raw.length) return null;
  const out = [];
  for (const w of raw) {
    if (!w || !Array.isArray(w.taskIds) || !w.taskIds.length) continue;
    out.push({
      index: out.length + 1,
      taskIds: w.taskIds.map((x) => String(x)).filter(Boolean),
    });
  }
  return out.length ? out : null;
}

/** 当前批次 = 含「未终态任务」的第一个批次；全部终态时返回 null（组即将收尾）。 */
function currentWave(waves, tasks) {
  if (!Array.isArray(waves) || !waves.length) return null;
  const live = new Set((Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && !TERMINAL_TASK_STATUSES.includes(t.status))
    .map((t) => String(t.taskId)));
  for (const w of waves) {
    if (w.taskIds.some((id) => live.has(id))) return w;
  }
  return null;
}

/** 本批允许入队的任务 id 列表；无批次计划返回 null（= 不限制，保持既有 DAG 调度）。 */
function allowedTaskIds(waves, tasks) {
  const w = currentWave(waves, tasks);
  return w ? w.taskIds : null;
}

/**
 * 探活器（§13.4「降级协议」）。判据 = **三通道全无变化 + 真实静默超窗**：
 *   ① 无新 trace/活动事件（traceSeq）
 *   ② 无新 team_messages（messageSeq）
 *   ③ 子任务状态未变（statusSignature）
 * 任一变化即视为「有进展」并清零计数；连续 maxMisses 次无变化 ⇒ 候选停滞。
 * idleMs：整组距最后一次活动事件的毫秒数。小于 idleWindow 时一律视为「仍在推理/执行」，
 * 直接清零——这是 2026-10-21 真机事故（8s TTFB 被 15s 无事件判死）的修复点。
 * 默认 idleWindow=0 保持纯签名语义（既有确定性单测不受影响）。
 */
function createWaveProbe({ maxMisses = WAVE_PROBE_MAX_MISSES, idleWindow = 0 } = {}) {
  let last = null;
  let misses = 0;
  return {
    sample(signals) {
      const sig = [
        Number(signals?.traceSeq) || 0,
        Number(signals?.messageSeq) || 0,
        String(signals?.statusSignature || ''),
      ].join('|');
      // 静止时间窗：窗口内一律不算停滞（推理期不是停滞）。
      if ((Number(signals?.idleMs) || 0) < idleWindow) {
        last = sig;
        misses = 0;
        return { stalled: false, misses, idleMs: Number(signals?.idleMs) || 0 };
      }
      if (last === null || sig !== last) {
        last = sig;
        misses = 0;
        return { stalled: false, misses, idleMs: Number(signals?.idleMs) || 0 };
      }
      misses += 1;
      return { stalled: misses >= maxMisses, misses, idleMs: Number(signals?.idleMs) || 0 };
    },
    reset() { last = null; misses = 0; },
    get misses() { return misses; },
  };
}

/**
 * 启动批次探活定时器。定时器与时钟均可注入（单测手动触发 tick，不依赖真实等待）。
 * onStall 触发后自动 reset——撤员重派本身会让状态签名变化，但主动 reset 更稳妥，
 * 避免「重派动作没被观察通道捕捉」时下一拍立刻又判一次停滞（连杀两名成员）。
 */
function startWaveProbe({
  sample,
  onStall,
  intervalMs = WAVE_PROBE_INTERVAL_MS,
  maxMisses = WAVE_PROBE_MAX_MISSES,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const probe = createWaveProbe({ maxMisses });
  // 采样抛错 ⇒ 本拍直接 return：若采样器坏掉，**停滞永远不会被判定** ⇒ 团队卡死且无人撤员。
  // 探活 5s 一拍，逐拍告警会刷爆日志，故只告警一次（含错误原文，够定位）。
  let sampleWarned = false;
  const timer = setIntervalFn(() => {
    let r = null;
    try { r = probe.sample(typeof sample === 'function' ? sample() : {}); } catch (e) { if (!sampleWarned) { sampleWarned = true; console.warn('[teamWaves] 探活采样抛错，停滞检测失效（团队可能卡死无人撤员）：', e?.message || e); } return; }
    if (!r.stalled) return;
    probe.reset();
    try { onStall?.(r); } catch { /* 撤员失败不阻断后续探活 */ }
  }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    probe,
    stop() { try { clearIntervalFn(timer); } catch { /* 已停止 */ } },
  };
}

/**
 * 备用成员（撤员后重派）：同类型优先，排除刚被撤下的人与当前在役者。
 * 无同类型备用返回 null ⇒ 调用方按「标 failed 并进汇总卡」处置（§13.4 降级协议）。
 */
function pickBackupMember({ members, typeKey, excludeIds = [], busyIds = [] } = {}) {
  const skip = new Set([...(excludeIds || []), ...(busyIds || [])].map(String));
  const list = (Array.isArray(members) ? members : []).filter((m) => m && m.id && !skip.has(String(m.id)));
  const same = list.filter((m) => memberTypeOf(m) === typeKey);
  return same.length ? String(same[0].id) : null;
}

module.exports = {
  MAX_ACTIVE_MEMBERS,
  MAX_PER_TYPE_IN_RUN,
  WAVE_PROBE_INTERVAL_MS,
  WAVE_PROBE_MAX_MISSES,
  WAVE_PROBE_IDLE_MS,
  MAX_REASSIGN_PER_TASK,
  MAX_WAVES,
  memberTypeOf,
  selectActiveMembers,
  computeLevels,
  planWaves,
  normalizeWaves,
  currentWave,
  allowedTaskIds,
  createWaveProbe,
  startWaveProbe,
  pickBackupMember,
};
