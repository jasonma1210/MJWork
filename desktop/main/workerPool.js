// P1-5/P1-7：Agent Worker 池——并发执行子任务（信号量限流）+ 组级失败策略
// 设计（计划文档 P1-5/P1-7）：
//   · Worker = 一次 runAgent 调用（复用 agent-core 引擎与主进程工具实现），无状态；
//     并发上限 = 配置项（默认 2），由本池信号量控制——本地/云端资源瓶颈统一入口。
//   · 每任务独立 AbortController + 墙钟超时；失败按 maxRetry 重试（queued 回队）。
//   · 组级策略：非关键失败降级继续；关键失败且阻塞下游 → 组 paused（等待重规划/人工处置）。
//   · 组收尾：无待执行任务 → 聚合 → done（带 warnings）；全部关键失败 → failed。
// 依赖注入（initWorkerPool）：{ loadAgentCore, createToolHandlers, chatOnce, store, emit }
//   loadAgentCore/创建工具处理器/chat 与 main.js 定时任务通道同源。

const { aggregateGroup } = require('./aggregator/merge');
const workerIsolation = require('./workerIsolation');
const { toAgentModel } = require('./modelShape');
const { stricterApproval, sandboxTierForCwd } = require('./approvalPolicy');
// 第八轮 B-01 / D-808：军团成员的运行期配置（DS Bot 的 per-bot 特性）在此落地。
// 宿主侧应用逻辑与主会话通道共用 rolePresetApply —— 单一事实来源，不再各写一套。
const { applyMemberRuntimeConfig } = require('./rolePresetApply');
const { resolveOwnerMember, buildWorkerSystemPrompt } = require('./workerIdentity');
// 第八轮 B-02 / D-809：组级三键预算闸（此前三键只进提示词文案，运行期零强制点）。
const groupBudget = require('./groupBudget');
const path = require('path');
// P2-8 / V-L1：V 层宿主侧编排，本通道默认 l1（零网络确定性对账）；L3 仅在风险门放行时触发。
const { createWorkerVerifyRun } = require('./workerVerify');
// M5 / T5-11：成员断点读写门面（内部复用 checkpointStore 单例——与主对话「继续」共用同一存储、
// 同一 `checkpoint:clear` 清理入口、同一 50 条 LRU 上限，不新起第二套持久化）。
const { createMemberSession } = require('./workerSession');
// M5 / T5-12：批次编排（§13.4）——读 dag_json.waves 做批次门控（批间串行）+ 5s×3 探活撤员。
const teamWaves = require('./teamWaves');
const { createWaveEngine } = require('./waveEngine');
const { createGroupConcurrency } = require('./groupConcurrency');
const { pauseOnCriticalFailure } = require('./workerCritical');
const { broadcastWaitSweep, broadcastWoken } = require('./taskBroadcast');
// 活动流文本工具（参数摘要 / 产物路径粗提取）——纯函数，已抽出到 workerText.js
const { summarizeArgs, extractPaths } = require('./workerText');
// 2026-10-21 团队调试日志：认领/派发/引擎/终态的事实装配（内联会越过 800 行软档，故抽出）。
const teamTrace = require('./teamWorkerTrace');

let deps = null;
let maxConcurrent = 4; // 默认并发 4：主流大模型服务普遍支持 4 路并发请求
// runKey `${groupId}/${taskId}` -> { controller, name, manual }
const activeRuns = new Map();
let pumping = false;
// M5 / T5-12：批次运行时（实现见 main/waveEngine.js）。本文件只保留接入点：
// attach / detach / allowOf / preferredOwnerOf / takeStall；未装配时全部退化为空操作。
let waveEngine = null;
// M5 / T5-3：等待态心跳——全组都在 waiting 时没有 run 触发 schedule，等待超时永远判不到。
// 本定时器只负责定期踢一脚调度，超时判定仍收敛在 pump 顶部的 sweepWaitTimeouts。
const WAIT_SWEEP_INTERVAL_MS = 30 * 1000;
let waitSweepTimer = null;

// Worker 可爱命名（Agent 胶囊显示用）：按序分配，避免与在役重名
const WORKER_NAMES = ['布丁', '团子', '芝麻', '汤圆', '糯米', '豆豆', '泡泡', '小橘', '奶盖', '丸子', '椰果', '薯条', '布蕾', '雪饼', '米糕', '茶茶'];
let nameSeq = 0;
function pickWorkerName() {
  const used = new Set([...activeRuns.values()].map((r) => r.name));
  for (let i = 0; i < WORKER_NAMES.length; i += 1) {
    const n = WORKER_NAMES[(nameSeq + i) % WORKER_NAMES.length];
    if (!used.has(n)) { nameSeq = (nameSeq + i + 1) % WORKER_NAMES.length; return n; }
  }
  nameSeq += 1;
  return `小助手${nameSeq}`;
}

function initWorkerPool(d) {
  // M5 / T5-12：把 emit 收口到 emitTask（批次探活的第一通道靠它计数）。
  // 重新 init（单测/热重启）时先清掉上一轮的批次运行时，避免定时器与状态跨实例泄漏。
  waveEngine?.detachAll();
  rawEmit = typeof d.emit === 'function' ? d.emit : null;
  deps = { ...d, emit: rawEmit ? emitTask : undefined };
  maxConcurrent = Math.min(Math.max(Number(d.maxConcurrent) || 4, 1), 8);
  // M5 / T5-12：按宿主回调装配批次引擎（引擎不反向 require 本文件，避免循环依赖）。
  waveEngine = createWaveEngine({
    getDeps: () => deps,
    activeRuns,
    emit: emitTask,
    schedule,
    broadcastWoken: (groupId, woken) => broadcastWoken(deps, groupId, woken),
    discardIso: (iso) => workerIsolation.discardIsolated({ iso }),
    getMaxConcurrent: () => maxConcurrent,
    setMaxConcurrent: (n) => setMaxConcurrent(n),
    // B-15：组级降档/还原（优先于全局读写；waveEngine 检测到回调存在时不再动全局）
    lowerGroupConcurrency: (groupId) => groupConc.lower(groupId),
    restoreGroupConcurrency: (groupId) => groupConc.restore(groupId),
  });
  // M5 / T5-11：按 deps 装配成员会话门面（单测可注入假断点存储；生产缺省回落 checkpointStore）
  memberSession = createMemberSession({ getCheckpoint: d.getCheckpoint, saveCheckpoint: d.saveCheckpoint });
  // M5 / T5-3：等待态心跳（见 waitSweepTimer 注释）。只建一次，重复 init 不叠加定时器。
  if (!waitSweepTimer && typeof setInterval === 'function') {
    waitSweepTimer = setInterval(() => { try { schedule(); } catch { /* 心跳仅尽力而为 */ } }, WAIT_SWEEP_INTERVAL_MS);
    if (typeof waitSweepTimer.unref === 'function') waitSweepTimer.unref();
  }
}

function setMaxConcurrent(n) {
  maxConcurrent = Math.min(Math.max(Number(n) || 2, 1), 8);
  return maxConcurrent;
}

// ── B-15 收口（2026-10-21）：组级并发档（实现见 main/groupConcurrency.js）──
// 探活撤员的降档只作用于**出问题的那一组**，不再改全局 maxConcurrent。
const groupConc = createGroupConcurrency({
  activeRuns,
  getMaxConcurrent: () => maxConcurrent,
});

// ═══ M5 / T5-11：成员持久会话（会话键 / 确定性指派 / 成员断点读写）已抽出 ═══
//
// 实现迁至 `main/workerSession.js`（2026-10-20：补齐认领者落库 + 断点恢复 + 完成落断点后
// 本文件越过 800 行软档，按「先拆再合入」纪律抽出）。本文件只保留绑定与消费：
//   · pump() 认领后补写 owner_member_id（pickOwnerMember，名册经 deps.resolveTeamRoster 反查）；
//   · runWorkerTask 取 sessionKey（memberSessionKey）并读 resumeContext（read）；
//   · 任务 done 后写回成员断点（save，仅成员任务）。
// 会话键固定 `agent:{memberId}`：确定性、不加列、不迁移（同级 key 见 §13.2 四级 key 表）。
let memberSession = null; // initWorkerPool 时按 deps 装配（缺省回落 checkpointStore 单例）

// ═══ M5 / T5-12：批次（wave）接入点 ═══
//
// 设计取舍（完整说明见 waveEngine.js 文件头）：批次计划**只在派活时算一次**并随 dag_json 落库，
// 运行期不重算；批间串行刻意选在「入队门控」而非「状态机」——pump 每拍只把当前批次的 pending
// 任务入队（enqueueReady 的 allowIds），后批保持 pending 不占槽位，当前批全部终态后自然前移。
//
// 组内「任务事件」计数（探活第一通道）。所有 task_* 事件都经 initWorkerPool 装配的出口统一累加，
// 因此不需要改动既有的二十余处 deps.emit 调用点（少一处改动就少一分漂移风险）。
let rawEmit = null;

function emitTask(evt) {
  waveEngine?.countTrace(evt);
  try { rawEmit?.(evt); } catch (e) { console.warn('[workerPool] 事件广播失败:', e?.message || e); }
}

// 引擎接入点的空安全包装（未装配/普通组 → 全部退化为既有 DAG 调度行为）
function waveAttach(groupId, waves) { waveEngine?.attach(groupId, waves); }
function waveDetach(groupId) { waveEngine?.detach(groupId); }
function waveCountOf(groupId) { return waveEngine?.waveCount(groupId) || 0; }
function waveAllowOf(group) { return waveEngine?.allowOf(group) || null; }
function preferredOwnerOf(group, task) { return waveEngine?.preferredOwnerOf(group, task) || null; }
function eligibleRoster(groupId, roster) { return waveEngine?.eligibleRoster(groupId, roster) || roster; }

function getMaxConcurrent() { return maxConcurrent; }
function activeCount() { return activeRuns.size; }

// 启动/推进一个组：循环调度直到组收尾或资源耗尽（后台执行，立即返回组状态）
async function runGroup(groupId) {
  if (!deps) throw new Error('WorkerPool 未初始化');
  const g = deps.store.getGroup(groupId);
  if (!g) throw new Error(`任务组不存在：${groupId}`);
  // M5 / T5-12：团队派活组（dag_json.waves 存在）装配批次运行时 + 探活定时器。
  // 普通编排组没有 waves ⇒ 不装配任何东西，调度行为与 T5-12 之前完全一致（零回归面）。
  const waves = teamWaves.normalizeWaves(g);
  teamTrace.runGroup(g, waves);
  if (waves) {
    waveAttach(groupId, waves);
    deps.emit?.({ type: 'wave_started', groupId, waveIndex: 1, waves: waves.length });
  }
  deps.store.setGroupStatus(groupId, 'running');
  deps.emit?.({ type: 'group_update', groupId, status: 'running' });
  // 第八轮 B-02 / D-809：组起跑即登记预算计时（只登记不判定 —— 判定属派发决策，在泵里做）。
  groupBudget.beginIfBudgeted(g);
  schedule(); // 异步泵；不 await（调用方立即拿回控制权）
  return deps.store.getGroup(groupId);
}

// 调度泵：只要有空闲槽位且组内有 queued 任务就派发；全部槽位占满/无任务则停止。
// 多组并存：从所有 running 组中轮流领取（简单轮转，先到先得）。
function schedule() {
  if (pumping) return;
  pumping = true;
  setImmediate(() => { pumping = false; pump(); });
}

// M5 / T5-3 事件广播（等待超时清扫 / 终态唤醒）：实现已抽出至 `main/taskBroadcast.js`
// （2026-10-20，T5-12 接入后本文件越过 800 行软档）。抽出的另一收益是 waveEngine 的撤员
// 级联唤醒可复用同一份事件映射，避免两处措辞/字段漂移。

async function pump() {
  if (!deps) return;
  try {
    // M5 / T5-3：等待超时清扫（§7 规则 2）——必须**先于派发**执行：到点的等待任务要及时判 failed
    // 并级联唤醒等它的其它任务，否则那些任务会白等到自己的超时（级联滞后一拍）。
    // 超时任务的唤醒级联由 sweepWaitTimeouts 内部完成，这里只负责把新状态广播给 UI。
    // 位置放在泵顶部（而非独立定时器）的理由：泵是所有调度路径的共同汇聚点，超时判定与
    // 重新派发在同一拍完成，被唤醒的重跑任务本轮即可被领取，不需要多等一个心跳周期。
    broadcastWaitSweep(deps, deps.store.sweepWaitTimeouts?.() || []);
    while (activeRuns.size < maxConcurrent) {
      const groups = deps.store.listGroups({ limit: 50 }).filter((g) => g.status === 'running');
      if (groups.length === 0) break;
      let dispatched = false;
      let allIdle = true;
      for (const g of groups) {
        // B-15：组级并发上限（探活撤员只降本组；未降档的组等于全局上限）。
        // 必须在 claimNext **之前**判定——认领会把任务置 running，提前退出会留下「已认领未派发」。
        if (groupConc.activeCountFor(g.group_id) >= groupConc.limitOf(g.group_id)) continue;
        // 第八轮 B-02 / D-809：预算越界即确定性停派（只处置未开始的任务，不动在途）。
        if (groupBudget.tripIfExhausted(deps, g)) continue;
        // 先把依赖已满足的 pending 入队
        // M5 / T5-12：团队派活组只放行**当前批次**（批间串行）；普通组 allow 为 null = 不限制。
        const allow = waveAllowOf(g);
        deps.store.enqueueReady(g.group_id, allow ? { allowIds: allow } : {});
        // T6-7（§7.1）：入队后、认领前过配额闸——只把 queued 转 quota_suspend，不碰在途 running。
        if (deps.quotaGate?.blocked(g)) continue;
        let task = deps.store.claimNext(g.group_id, `w-${Date.now().toString(36)}`);
        // M5 / T5-11：owner_member_id 必须**落库**——T5-5 团队记忆归属（agent_id）与 buildTaskPrompt
        // 的成员私有记忆召回都读它，不落库两条链恒退化成「团队共享」。claimNext 先占位 running，
        // 此处按认领者补写；running→running 属合法同态迁移，COALESCE 语义保证重跑/续跑不覆盖原认领者。
        // M5 / T5-12：团队组优先用批次计划的指派，计划缺失（旧组/手工建组）才回落 seq 取模。
        if (task && !task.ownerMemberId) {
          try {
            const planned = preferredOwnerOf(g, task);
            // 批次运行时存在时，已被撤员的成员从名册里剔除——否则「计划缺失 → 回落 seq 取模」
            // 这条回退路径会把刚撤下的人重新派回来（形成撤员/重派的死循环）。
            const roster = deps.resolveTeamRoster?.(g);
            const owner = memberSession.resolveOwnerMember(
              g, task, eligibleRoster(g.group_id, roster), planned,
            );
            if (owner) {
              task = deps.store.setTaskStatus(g.group_id, task.taskId, 'running',
                { workerId: task.workerId, ownerMemberId: owner }) || task;
            }
            teamTrace.claim(g, task, { planned, owner, roster });
          } catch (e) {
            teamTrace.claimFailed(g, task, e);
            console.warn('[workerPool] 认领者落库失败（本轮按无成员身份运行）:', e.message);
          }
        } else if (task) {
          teamTrace.claimReused(g, task, preferredOwnerOf(g, task));
        }
        // T6-8（§5.3）：单成员熔断在 owner 落库之后判定——只拦本成员的任务，其他成员照常派发。
        if (task && deps.quotaGate?.breakerBlocked(g, task)) continue;
        if (task) {
          allIdle = false;
          dispatch(g, task);
          dispatched = true;
          if (activeRuns.size >= maxConcurrent) break;
        }
      }
      if (!dispatched) break; // 无可派发任务（可能都在跑或被阻塞）
      if (allIdle) break;
    }
    // 收尾检查：running 组若已无待执行任务 → 聚合收尾；关键失败阻塞 → 暂停
    const groups = deps.store.listGroups({ limit: 50 }).filter((g) => g.status === 'running');
    for (const g of groups) {
      if (deps.store.isGroupSettled(g.group_id)) {
        // M5 / T5-12：批次全部终态、组即将收尾 → 补一条 wave_completed，让看板批次进度条收口。
        const n = waveCountOf(g.group_id);
        if (n) deps.emit?.({ type: 'wave_completed', groupId: g.group_id, waves: n });
        finalizeGroup(g.group_id);
      } else if (deps.store.groupHasBlockingFailure(g.group_id)) {
        // M5 / T5-12：组暂停即停探活——批次运行已中断，继续探活只会对着一批已停的任务空转撤员。
        waveDetach(g.group_id);
        deps.store.setGroupStatus(g.group_id, 'paused', { error: '关键任务失败且阻塞下游任务，组已暂停（可重试失败任务或取消）' });
        deps.emit?.({ type: 'group_update', groupId: g.group_id, status: 'paused' });
      }
    }
  } catch (e) {
    console.error('[workerPool] 调度异常:', e.message);
  }
}

function dispatch(group, task) {
  const runKey = `${group.group_id}/${task.taskId}`;
  const controller = new AbortController();
  const name = pickWorkerName();
  activeRuns.set(runKey, { controller, name, manual: false, iso: null });
  deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'running', title: task.title, name });
  // A1（2026-10-16）：活动流文案改 textKey/textParams，由渲染层按用户语言翻译。
  // 此前五处裸中文经 tasks:event 直出 ⇒ 英文界面漏中文，且 i18n 门禁只扫 renderer/src 抓不到。
  // textParams 携带的是非语言性数据（name/标题/错误详情），title 属用户内容按原样插值。
  deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'start', textKey: 'runtime.workerTakeOver', textParams: { name, title: task.title } });

  // P1 遗留项落地：真并行隔离——可写任务在独立 worktree 中执行，结束后合并回主目录。
  // 非 git 仓库/创建失败自动回落主目录（不阻塞）；写沙箱为只读时不隔离（无写冲突可能）。
  // V04：沙箱档读组内快照（建组时刻的父上下文）；旧组无快照列时按 cwd 推导（兼容旧行为）。
  // D-13：旧组无快照列时的回落走 approvalPolicy 的单点 sandboxTierForCwd（档名唯一出处是
  // shared/rolePolicyData.json）——此前是第三处手抄的 `group.cwd ? 'workspace-write' : 'read-only'`。
  const groupSandboxPolicy = group.sandbox_policy || sandboxTierForCwd(group.cwd);
  const wantsIsolation = !!group.cwd && groupSandboxPolicy !== 'read-only';
  teamTrace.dispatch(runKey, group, task, name, groupSandboxPolicy, wantsIsolation, activeRuns.size, maxConcurrent);
  (async () => {
    let iso = null;
    if (wantsIsolation) {
      iso = await workerIsolation.createIsolated({ cwd: group.cwd, groupId: group.group_id, taskId: task.taskId });
      if (iso) {
        const entry = activeRuns.get(runKey);
        if (entry) entry.iso = iso;
        deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'start', textKey: 'runtime.workerInWorktree', textParams: { name, worktree: path.basename(iso.worktreePath) } });
      }
    }
    const runCwd = iso?.worktreePath || group.cwd || '';
    // N5 副作用账本：领取即记 uncertain（该任务可能产生副作用），终态时 resolveEffect。
    // 重启恢复后 uncertain 记录保留 = 「副作用无法确认」清单，随 needsReview 供人工核对。
    deps.store.markEffectUncertain(group.group_id, task.taskId);
    // V06：iso 的后续处置全部经 activeRuns 中的 entry.iso（成功合并/失败归档/显式丢弃），
    // 本函数不再直接持有 iso 形参——避免两处引用漂移。
    await runWorkerTask({ group, task, runKey, controller, name, runCwd, groupSandboxPolicy });
  })().catch((e) => {
    // P0-C 修复：此前这个IIFE 是「浮动 Promise」且无 .catch()。
    // runWorkerTask 之外抛出的异常（典型：workerIsolation.createIsolated 失败、
    // deps.emit 抛错等）没有任何人接住 → 冒泡成 unhandledRejection →
    // Electron 主进程默认行为是**直接退出**，用户的全部会话与正在跑的任务一起丢失。
    // 这里兜住：把异常降级为该任务 failed + 组暂停，让用户看到可操作的信息，
    // 而不是整个应用无声消失。
    const msg = String(e?.message || e);
    console.error(`[workerPool] 任务派发异常（任务「${task?.title || task?.taskId}」）:`, msg);
    try {
      activeRuns.delete(runKey);
      deps.store?.setTaskStatus?.(group.group_id, task.taskId, 'failed', { error: `任务执行异常：${msg}` });
      deps.emit?.({
        type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name,
        kind: 'error', textKey: 'runtime.workerError', textParams: { msg },
      });
      // 不静默：组状态置为paused，用户可读可重试；绝不让主进程带病退出
      deps.store?.setGroupStatus?.(group.group_id, 'paused', { error: `任务「${task?.title || task.taskId}」执行异常：${msg}` });
      deps.emit?.({ type: 'group_update', groupId: group.group_id, status: 'paused' });
    } catch (inner) {
      // 连降级处理都失败时只记日志——此处绝不能再抛，否则又回到 unhandledRejection
      console.error('[workerPool] 异常降级处理失败:', String(inner?.message || inner));
    }
  });
}

async function runWorkerTask({ group, task, runKey, controller, name, runCwd, groupSandboxPolicy }) {
  {
    let result = null;
    let errorMsg = null;
    // P1-9：runAgent 被中止后可能带部分产出**正常返回**；只看 summary 正则会把超时伪装成 done。
    let abortReason = null;
    // M5 / T5-11：成员会话键（`agent:{memberId}`）——工具 hooks / V 层 / 引擎 runOpts 三处共用。
    const sessionKey = memberSession.memberSessionKey(group, task);
    // 断点在**运行前**读取：恢复上下文只注入本轮 system（agent-core 的 resumeContext 通道），
    // 不进持久化历史 —— 成员跨 run 复用的正是这一段摘要（§13.3）。
    const resumeContext = memberSession.read(sessionKey);
    // M5 / T5-8：军团协同上下文（成员任务才非空）；团队↔run 反查在宿主（findTeamByRun 为唯一事实来源）。
    const teamContext = typeof deps.resolveTeamContext === 'function'
      ? deps.resolveTeamContext(group, task) : null;
    // 2026-10-21 对话型目标（团队「报数」等）：必须**实际**收掉工具与轮次——提示词挡不住模型。
    const chatOnly = !!(group && group.dag && group.dag.runMeta && group.dag.runMeta.chatOnly);
    let budgetPlan = null; // 在 try 内装配、在 finally 结算（异常路径也必须把实际用量入账）
    // T6-7（§7.1）：开跑前配额预留授予；无项目组为 null（普通编排组零回归）。授予失败已被闸置 quota_suspend。
    const qrun = deps.quotaGate?.beginRun(group, task) || null;
    if (qrun && !qrun.ok) { activeRuns.delete(runKey); schedule(); return; }
    try {
      const core = await deps.loadAgentCore();
      // T6-6：threadId 透传——工件项目上下文由宿主按会话反查（project_spaces 单一事实源），池不读项目表。
      const rawHandlers = deps.createToolHandlers({
        signal: controller.signal, cwd: runCwd, teamContext,
        threadId: (group && group.thread_id) || '',
      });
      // P1-5/T5-11：Worker 同样过用户 hooks（无人值守≠可绕过规则）；会话 id = 成员会话键 ⇒ 同类审批按成员记忆。
      const handlers = deps.toolHooks
        ? deps.toolHooks.wrap(rawHandlers, { cwd: runCwd || '', conversationId: sessionKey })
        : rawHandlers;
      // P2-8 / V-L1 + P1-2：Worker 通道 V 层装配（判定来源/默认 l1/L3 风险门全在 main/workerVerify.js，语义逐字等价）
      const vrun = createWorkerVerifyRun({ deps, runKey, sessionKey, runCwd });
      controller.signal.addEventListener('abort', () => { abortReason = controller.signal.reason?.message || String(controller.signal.reason || '运行已中止'); }, { once: true });
      // 第八轮 B-02：单任务预算计划（无预算组 maxRounds 回退 20、timeout 用任务值、settle 空操作）。
      // 2026-10-21：预算只做组级成本记账（软上限），不再按人头切份额——硬闸是轮次与墙钟。
      budgetPlan = groupBudget.planForTask(deps.store.getGroup?.(group.group_id) || group, task, { maxRoundsFallback: 20 });
      // 墙钟超时：到点中止本轮 Agent（工具调用在下一轮 chat 才感知，符合设计取舍）
      const timer = setTimeout(() => controller.abort(new Error(`任务超时（${Math.round(budgetPlan.timeoutMs / 60000)} 分钟）`)), budgetPlan.timeoutMs);
      // 活动流：工具调用 → task_activity 事件（Agent 胶囊/面板实时展示执行流程）
      const onToolCall = (tc) => {
        vrun.onToolCall(tc); // V 层旁路（off 时为空操作）：缓存最近一次测试命令输出
        deps.emit?.({
          type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name,
          kind: 'tool', text: `${tc?.name || ''} ${summarizeArgs(tc?.args)}`.trim(),
        });
      };
      // T1-3/T1-4：子任务 token 用量累计（result.tokensUsed）；2026-10-21 起只记账，不再按人均额度硬中止。
      let usedTokens = 0;
      const onUsage = (m) => { const n = teamTrace.messageTokens(m); usedTokens += n; qrun?.note(n); };
      try {
        // P1-11b：任务-模型分档（可选 + 回落）——缺省/形状不全/异常 → 静默回落主模型（分档绝不能把整组弄崩）。
        // 基线**必须**保持 `model: toAgentModel(deps.resolveModel())` 这一行（test/model-shape.test.js 源码护栏即此语义）。
        let workerOv = null;
        if (typeof deps.getModelOverrides === 'function') {
          const slot = (deps.getModelOverrides() || {}).worker;
          if (slot && slot.model) {
            if (slot.providerId) workerOv = slot;
            else console.warn('[workerPool] modelOverrides.worker 缺少 providerId，已回落主模型');
          }
        }
        // X-2（R-16）：成员身份前置解析（与 applyMemberRuntimeConfig 同反查口径；未认领 ⇒ null ⇒ 通用串字节不变）。
        const ownerMember = resolveOwnerMember({ group, task, deps });
        const runOpts = {
          // 对话型目标直接用任务 prompt（不注入总体目标/前置摘要，避免把模型推向「做产物」）
          messages: [{ role: 'user', content: chatOnly ? String(task.prompt || '') : await deps.buildTaskPrompt(group, task) }],
          // 2026-10-15 修复：扁平形 resolveModel() 会让 runAgent 第 1 轮即崩；转换统一走 modelShape.js。
          model: toAgentModel(deps.resolveModel()),
          cwd: runCwd,
          signal: controller.signal,
          // P0 治理修复：取「建组时刻的组内快照」（getApprovalMode 仅作旧组兼容回退），中途改档不串到排队组；
          // 再与 auto-safe 地板取更严者（never/full-access 是危险组合，有意抬升，UI 需明示生效值）。
          // V04 沙箱：读组内快照，且不允许 worktree 存在把只读父组抬成 workspace-write。
          approvalMode: stricterApproval(group.approval_mode || deps.getApprovalMode?.() || 'on-request', 'auto-safe'),
          sandboxPolicy: runCwd ? groupSandboxPolicy : 'read-only',
          conversationId: sessionKey,
          resumeContext, // M5/T5-11：跨 run 复用；空串 = 首轮，引擎自然忽略
          agentsMd: require('./agentsMd').readAgentsMd(runCwd), // P1-11：Worker 也吃 AGENTS.md
          // P0：上下文策略（宿主可按团队/任务下发；缺省 null ⇒ 引擎默认）
          compactPolicy: typeof deps.getCompactPolicy === 'function' ? deps.getCompactPolicy() : null,
          // M5 / T5-8：协同工具与提示词段的条件开关（null ⇒ 引擎不追加任何 team_* schema）
          teamContext,
          // 说明：thread_id 不随 runOpts 下发——agent-core 只认白名单键，对话级归属已落在断点元数据。
          // 第八轮 B-02 / D-809：引擎侧真实闸门；对话型目标压到 2 轮（一句话没有第二步）。
          maxRounds: chatOnly ? Math.min(budgetPlan.maxRounds || 2, 2) : budgetPlan.maxRounds,
          // A-06 收口：墙钟显式下发，与宿主 setTimeout 同一个预算值（任一侧先到都「暂停 + 断点」）。
          runWallClockMs: budgetPlan.timeoutMs,
          chatRetryBaseMs: 2000,
          // 组预算：单任务取**组剩余额度**（成本信封，不按人头切份额）；有项目配额时再夹到授予额（§7.2 取最小值）。
          tokenBudget: qrun?.grant ? Math.min(budgetPlan.tokenBudget, qrun.grant) : budgetPlan.tokenBudget,
          // Worker 也是无人值守：收尾文案不能出现「发送继续」
          unattended: true,
          toolHandlers: handlers,
          onToolCall,
          // P2-8 / V-L1：只为收 verify_ledger；sub:true 的子代理事件不得混进 worker 台账（R2 假绿）。
          onTrace: (evt) => {
            if (!evt || evt.sub) return;
            vrun.onLedger(evt);
            // T6-11（§10.2）：压缩摘要交宿主落 project_runs.summary_json（实现自带 fail-open）。
            if (evt.type === 'memory_saved' && String(evt.summary || '').trim()) deps.saveProjectSummary?.(group, String(evt.summary));
          },
          onMessage: onUsage,
          // 对话型目标下发空工具表（引擎对 customTools=[] 直接生效 ⇒ 本轮无任何工具可调用）。
          ...(chatOnly ? { tools: [] } : {}),
          // X-2（R-16）：首条 system 原样保留两条分支，仅在有名册归属时追加成员身份段。
          systemPrompt: buildWorkerSystemPrompt({ chatOnly, ownerMember }),
        };
        // P1-11b：分档覆盖基线模型（形状异常 → 保持主模型）
        if (workerOv) {
          try {
            runOpts.model = toAgentModel(workerOv);
          } catch (e) {
            console.warn('[workerPool] modelOverrides.worker 形状不可用，已回落主模型:', e.message);
            workerOv = null;
          }
        }
        // 第八轮 B-01 / D-808：军团成员 per-bot 配置（模型/人格/技能/工具集/治理档取更严）。
        // 放在最后：per-bot 意图优先于 modelOverrides.worker 通用分档；治理档只会更严。
        // 未认领 / 无名册 → 空操作，非军团路径零回归（判定口径见 rolePresetApply 注释）。
        applyMemberRuntimeConfig(runOpts, { group, task, deps });
        teamTrace.engineStart({ runKey, group, task, sessionKey, runOpts, runCwd, resumeContext });
        // P0-3①：思考强度随模型透传——agent-core 从 `model.model.reasoning_effort` 取，再下发到
        // 非流式通道的 `reasoning_effort`。分档自带则用分档的，否则沿用主模型（resolveModel 是纯 getter）。
        const effortSrc = workerOv || deps.resolveModel();
        const effort = effortSrc.reasoningEffort || effortSrc.reasoning_effort || '';
        if (effort) runOpts.model = { ...runOpts.model, model: { ...runOpts.model.model, reasoning_effort: effort } };
        const finalText = await core.runAgent(runOpts);
        // P2-8 / V-L1：off 时 finish 直接返回原文（零行为变化）；开启后 BLOCK 只在
        // summary 末尾追加对账提示——**不改变任务成败判据**（改判据会让无人值守任务
        // 因为一句自述措辞反复重试，成本远大于收益；是否升级为失败留给后续批次决定）。
        // try/catch 是硬要求：V 层任何故障都绝不能把任务翻成 failed（那等于让「评估器」
        // 有权判死一个其实已完成的任务，是本次改造最不能接受的副作用）。
        let summaryText = finalText;
        try {
          const vr = await vrun.finish(finalText);
          if (typeof vr?.finalText === 'string') summaryText = vr.finalText;
        } catch (e) {
          console.warn('[workerPool] V 层判定异常（不影响任务结果）:', e?.message || e);
        }
        result = { summary: String(summaryText || ''), artifacts: extractPaths(summaryText), tokensUsed: usedTokens };
      } finally {
        clearTimeout(timer);
        // 第八轮 B-02 / D-809：组级 token 结算。T6-7（§7.1）：项目配额同时补差并释放预留。放在 finally ——
        // 抛错/中止/超时同样要入账并释放预留，否则一次异常就会让账本永久少一份额度（后续任务被误判「预算不足」而跳过）。
        try { budgetPlan?.settle(usedTokens); qrun?.settle(usedTokens); } catch (e) { console.warn('[workerPool] 结算失败（不阻塞）:', e?.message || e); }
      }
    } catch (err) {
      // 装配阶段就抛错（尚未进入 run 的 finally）时预留无人释放——配额会永久泄漏，必须在此兜住
      errorMsg = String(err?.message || err); try { qrun?.release(); } catch (e2) { console.warn('[workerPool] 配额预留释放失败:', e2?.message || e2); }
    }

    const entry = activeRuns.get(runKey);
    activeRuns.delete(runKey);

    teamTrace.engineDone({ runKey, group, task, abortReason, errorMsg, result });

    // M5 / T5-3：动态等待 defer（§7 L2）。任务在运行中被 team_wait 登记为 waiting（store 状态为准），
    // waitTask 会主动 abort 当前 run 以释放槽位——这个 abort 是 **defer 语义而非失败**，
    // 必须在所有失败分支之前拦截：否则会走 abortReason → failed（把「正在合理等待」误判成「超时失败」）。
    // 判据取 store 的 waiting 状态（单一事实来源），entry.deferred 仅作运行期提示。
    const deferred = (() => {
      try { return deps.store.getTask?.(group.group_id, task.taskId); } catch { return null; }
    })();
    if (deferred?.status === 'waiting') {
      deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'waiting', name,
        waitingOn: deferred.waitingOn || [], waitDeadlineAt: deferred.waitDeadlineAt || null });
      deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'wait',
        textKey: 'runtime.workerWaiting', textParams: { name, deps: (deferred.waitingOn || []).join(', ') } });
      // 隔离副本不再有意义（唤醒后新副本重跑），清理不泄漏；不 resolveEffect（任务未终态）。
      if (entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso }).catch(() => {});
      memberSession.saveWaiting(sessionKey, group, task, deferred, result); // P1：等待即打轻量断点
      schedule(); // 槽位已释放，让泵立刻去领别的任务
      return;
    }

    // M5 / T5-12：探活撤员的重派消费（§13.4）。**必须**早于下面的失败分支拦截——否则 abortReason
    // 分支会把撤员当成「超时失败」落库，备用成员永远等不到重派。处置细节见 waveEngine.consumeStall。
    if (await waveEngine?.consumeStall(group, task, runKey, { iso: entry?.iso, workerName: name })) return;

    try {
      if (entry?.manual) {
        // 强制关闭：不重试，直接终态（用户意图 = 不再跑；不计入自动重试次数）
        deps.store.setTaskStatus(group.group_id, task.taskId, 'failed', { error: '已手动强制关闭', skipRetryCount: true });
        deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'stop', textKey: 'runtime.workerForceStopped', textParams: { name } });
        deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: '已手动强制关闭' });
        // V06：强制关闭也先归档——有改动保留现场，无改动才清理
        await archiveIsoIfNeeded(entry, group, task, '已手动强制关闭');
      } else if (errorMsg != null && result == null) {
        const { retried } = deps.store.handleFailure(group.group_id, task.taskId, errorMsg);
        deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: retried ? 'queued' : 'failed', error: errorMsg });
        maybePauseOnCritical(group.group_id, task, retried);
        // V06：不再无条件丢弃隔离副本——将重试（新副本覆盖）才清理；终态失败先归档保留产物
        if (retried) { if (entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso }).catch(() => {}); }
        else await archiveIsoIfNeeded(entry, group, task, errorMsg);
      } else if (abortReason != null) {
        // P1-9：超时/外部中止不得判 done——带部分产出正常返回也按失败落库（不重试：
        // 墙钟超时自动重试会再烧一整轮，改由用户核对后手动重试；重试次数不消耗）。
        deps.store.setTaskStatus(group.group_id, task.taskId, 'failed', {
          error: abortReason, skipRetryCount: true,
          result: result ? { summary: result.summary, artifacts: result.artifacts, tokensUsed: result.tokensUsed, partial: true } : null,
        });
        deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: abortReason });
        maybePauseOnCritical(group.group_id, task, false); // 关键任务超时同样按失败暂停组（下游不再空跑）
        await archiveIsoIfNeeded(entry, group, task, abortReason);
      } else {
        // Agent 引擎的「未完成收尾」标记（重复失败熔断 / 预算耗尽）→ 任务判 failed，
        // 走失败处置（重试回队 / 关键失败暂停组），不得伪装成 done
        // 2026-10-21 真机事故修复：上下文压不动的收尾文案历史上是「任务尚未完成。」，
        // 而这里只认「任务未完全完成」——于是 t2/t4 在看板显示「完成」、产出却是空。
        // 引擎侧已统一补上规范标记，这里同时接受两种措辞，避免旧文案/新文案任一侧再漏判。
        const incomplete = /已主动停止|任务未完全完成|任务尚未完成/.test(String(result.summary || ''));
        if (incomplete) {
          const { retried } = deps.store.handleFailure(group.group_id, task.taskId, 'Agent 未完成收尾（重复失败熔断或预算耗尽）', { summary: result.summary, artifacts: result.artifacts });
          teamTrace.incomplete({ runKey, group, task, retried, result });
          deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: retried ? 'queued' : 'failed', error: 'Agent 未完成收尾' });
          maybePauseOnCritical(group.group_id, task, retried);
          if (retried) { if (entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso }).catch(() => {}); }
          else await archiveIsoIfNeeded(entry, group, task, 'Agent 未完成收尾');
        } else {
          // 成功：worktree 改动合并回主目录
          let mergeInfo = null;
          if (entry?.iso) {
            mergeInfo = await workerIsolation.mergeBackIsolated({ cwd: group.cwd, iso: entry.iso });
          }
          // V06：合并成功（或无隔离）才允许 done；冲突/失败 → needs_review 语义
          //（终态 failed + error 指明补丁与 worktree 位置），绝不「清理后标完成」。
          if (mergeInfo && !mergeInfo.ok) {
            const detail = mergeInfo.error || '隔离工作区改动合并失败';
            deps.store.setTaskStatus(group.group_id, task.taskId, 'failed', {
              error: `成果待人工审查（needs_review）：${detail}`,
              result: {
                summary: result.summary,
                artifacts: result.artifacts,
                tokensUsed: result.tokensUsed,
                needsReview: true,
                patchFile: mergeInfo.patchFile || null,
                worktreePath: mergeInfo.worktreePath || null,
              },
              skipRetryCount: true, // 合并失败不是 Agent 失败，不消耗自动重试次数（避免重跑覆盖已有成果）
            });
            deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: `成果待人工审查：${detail}`, needsReview: true });
            maybePauseOnCritical(group.group_id, task, false);
          } else {
            if (mergeInfo?.applied) {
              result.warnings = [...(result.warnings || []), '隔离工作区改动已合并回主目录'];
            }
            deps.store.setTaskStatus(group.group_id, task.taskId, 'done', { result });
            deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'done' });
          }
        }
      }
    } catch (e) {
      console.error('[workerPool] 结果落库失败:', e.message);
      // V06：落库失败也不静默销毁产物——先归档再吞异常
      await archiveIsoIfNeeded(entry, group, task, `结果落库失败：${e.message}`).catch(() => {});
    }
    // M5 / T5-5：团队记忆沉淀（仅成功任务）。开关/归属/归档判定全在宿主 rememberTeamMemory 内，
    // worker 只透传事实（runId=groupId / 认领成员 / 标题 / 结论摘要）；fail-open，不阻塞收尾。
    try {
      const st = deps.store.getTask?.(group.group_id, task.taskId);
      if (st?.status === 'done' && deps.rememberTeamMemory) {
        deps.rememberTeamMemory({
          runId: group.group_id,
          ownerMemberId: task.ownerMemberId || null,
          title: task.title || '',
          text: st.result?.summary || '',
          cwd: group.project_path || group.cwd || '',
        });
      }
    } catch (e) { console.warn('[workerPool] 团队记忆沉淀调用失败（不阻塞）:', e.message); }
    // M5 / T5-11：成员会话的断点落库（普通完成路径）。**仅成员任务**写——非军团组用的
    // `agent:anon:...` 键是一次性隔离语义（与原 `task:...` 等价），写进去只会挤占
    // checkpointStore 的 50 条 LRU，把主对话断点淘汰掉，属于负收益。
    // 时机在终态落库之后、resolveEffect 之前：状态已确定 ⇒ 写入的是「本次确实收尾了」。
    try {
      const st = deps.store.getTask?.(group.group_id, task.taskId);
      if (st?.status === 'done' && task.ownerMemberId) {
        memberSession.save(sessionKey, group, task, st.result);
      }
    } catch (e) { console.warn('[workerPool] 成员断点落库失败（不阻塞）:', e.message); }
    // N5 副作用账本：任务到达终态（done / failed / skipped，含 needsReview 分支）→ resolved。
    // needsReview 的 needsReview 标记在任务 result 里，账本只管「该任务已终态、副作用清单已定」。
    try { deps.store.resolveEffect(group.group_id, task.taskId); } catch (e) { console.warn('[workerPool] 副作用账本 resolve 失败:', e.message); }

    // M5 / T5-3：任务终态 → 幂等唤醒等它的任务（§7 规则 4）。必须发生在 schedule() 之前：
    // 唤醒 = waiting → queued，紧随其后的 schedule 让被唤醒者本轮即可被领取（不用多等一拍）。
    // 非终态（defer 已 return / 落库失败）时 settleWaitingTasks 天然空操作——它按依赖状态重判，
    // 只有「全部 waiting_on 目标都已终态」的等待者才被放行（部分满足不提前放行）。
    let settledStatus = null;
    try {
      const finalTask = deps.store.getTask?.(group.group_id, task.taskId);
      settledStatus = finalTask?.status || null;
      if (settledStatus === 'failed' || settledStatus === 'skipped') teamTrace.cascadeSkip(deps, group, task, finalTask?.error || '依赖任务未完成，已跳过');
      teamTrace.settle({ runKey, group, task, finalTask, status: settledStatus });
      const woken = deps.store.settleWaitingTasks?.(group.group_id, task.taskId) || [];
      broadcastWoken(deps, group.group_id, woken);
      if (settledStatus && ['done', 'failed', 'skipped'].includes(settledStatus)) {
        deps.emit?.({ type: 'board_task_settled', groupId: group.group_id, taskId: task.taskId, status: settledStatus });
      }
    } catch (e) {
      console.warn('[workerPool] 等待唤醒失败:', e.message);
    }
    schedule(); // 任务结束后推进调度
  }
}

// V06：失败/中止路径的隔离副本归档——有改动保留现场（worktree+补丁路径写进任务结果），无改动才清理
async function archiveIsoIfNeeded(entry, group, task, reason) {
  if (!entry?.iso) return;
  try {
    const archived = await workerIsolation.archiveIsolated({ iso: entry.iso });
    if (!archived.empty) {
      try {
        deps.store.setTaskStatus(group.group_id, task.taskId, 'failed', {
          error: `${reason}（改动未丢失，待人工审查：补丁 ${archived.patchFile || '未生成'}，worktree ${archived.worktreePath}）`,
          result: { needsReview: true, patchFile: archived.patchFile || null, worktreePath: archived.worktreePath || null },
          skipRetryCount: true,
        });
      } catch (e) {
        // 状态已终态/迁移非法时保留日志：产物仍在 worktree 与补丁目录，不因落库失败而销毁
        console.warn('[workerPool] needs_review 状态写入失败（产物已保留）:', e.message);
      }
      deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: reason, needsReview: true });
    }
  } catch (e) {
    console.warn('[workerPool] 隔离副本归档失败（保留现场）:', e.message);
  }
}

// 工具参数摘要（活动流展示用）：实现见 workerText.js（本文件不再维护第二份截断口径）

// 强制关闭指定任务（Agent 胶囊「强制关闭」入口）：中止运行且不重试
// M5 / T5-3：等待中的任务**不在** activeRuns（槽位已释放）——此前这里直接 return false，
// 用户对等待中任务点「强制关闭」静默无效。现补 waiting 分支：置 skipped（终态）+ 级联唤醒，
// 否则组收尾判定会因残留的 waiting 任务永远不成立（界面永久转圈）。
function abortTask(groupId, taskId) {
  const runKey = `${groupId}/${taskId}`;
  const entry = activeRuns.get(runKey);
  if (entry) {
    entry.manual = true;
    entry.controller.abort(new Error('已手动强制关闭'));
    return true;
  }
  try {
    const t = deps.store?.getTask?.(groupId, taskId);
    if (t?.status === 'waiting') {
      deps.store.setTaskStatus(groupId, taskId, 'skipped', { error: '等待中的任务已被手动强制关闭', force: true });
      deps.emit?.({ type: 'task_update', groupId, taskId, status: 'skipped' });
      broadcastWoken(deps, groupId, deps.store.settleWaitingTasks?.(groupId, taskId) || []);
      deps.emit?.({ type: 'board_task_settled', groupId, taskId, status: 'skipped' });
      schedule();
      return true;
    }
    // T6-4（§5.1）：quota_suspend 不在 activeRuns，强制关闭直接落 skipped（状态机合法边）。
    if (t?.status === 'quota_suspend') {
      deps.store.setTaskStatus(groupId, taskId, 'skipped', { error: '配额暂停中的任务已被手动强制关闭' });
      deps.emit?.({ type: 'task_update', groupId, taskId, status: 'skipped' });
      deps.emit?.({ type: 'board_task_settled', groupId, taskId, status: 'skipped' });
      schedule();
      return true;
    }
  } catch (e) {
    console.warn('[workerPool] 等待中任务强制关闭失败:', e.message);
  }
  return false;
}

// 组级强停（AgentDock「全部停止」/对话中止联动）：中止该组全部在役任务
// P1-8：排队中的任务一并处置——此前只中止在役 run，queued/pending 任务再无 Worker
// 认领却永远留在 queued，组收尾判定「无待执行任务」永不成立，「全部停止」后界面永久转圈。
// 统一置 skipped（终态、错误信息可读），组置 cancelled；返回值保持为在役中止数（IPC 兼容）。
function abortGroup(groupId) {
  let n = 0;
  for (const [runKey, entry] of activeRuns.entries()) {
    if (runKey.startsWith(`${groupId}/`)) {
      entry.manual = true;
      entry.controller.abort(new Error('已手动强制关闭'));
      n += 1;
    }
  }
  let skipped = 0;
  try {
    // M5 / T5-3：**先**取消等待中的任务——cancelWaiting 会 waiting → skipped 并级联唤醒等待者（→ queued）；
    // 若顺序反过来，被唤醒的任务不在本轮 queued/pending 快照里，会残留成永不派发的孤儿。
    // 放在前面则它们变成 queued 后，正好被下面的清扫一并置 skipped。
    const cancelledWaiting = deps.store.cancelWaiting?.(groupId, { error: '组已被用户强制停止' }) || [];
    for (const c of cancelledWaiting) {
      deps.emit?.({ type: 'task_update', groupId, taskId: c.taskId, status: 'skipped' });
      // T5-9（§9.1 级联中断语义②）：被中断的等待任务必须向等待者发 settled 事件，
      // 否则对方会白等到墙钟超时才继续。settled 是看板推进的权威信号，不能只改状态。
      deps.emit?.({ type: 'board_task_settled', groupId, taskId: c.taskId, status: 'skipped' });
    }
    for (const t of deps.store.listTasks(groupId)) {
      // T6-4（§5.1）：quota_suspend 必须一并落 skipped，否则组收尾判定（计入该态）永不成立。
      if (t.status === 'queued' || t.status === 'pending' || t.status === 'quota_suspend') {
        try {
          deps.store.setTaskStatus(groupId, t.taskId, 'skipped', { error: '组已被用户强制停止', force: true });
          skipped += 1;
          deps.emit?.({ type: 'board_task_settled', groupId, taskId: t.taskId, status: 'skipped' });
        } catch (e) {
          console.warn(`[workerPool] 组停时任务 ${t.taskId} 置 skipped 失败:`, e.message);
        }
      }
    }
    deps.store.setGroupStatus(groupId, 'cancelled', { error: '已被用户强制停止' });
    deps.emit?.({ type: 'group_update', groupId, status: 'cancelled', error: '已被用户强制停止' });
  } catch (e) {
    console.warn(`[workerPool] 组 ${groupId} 强停收尾失败:`, e.message);
  }
  // M5 / T5-12：强停后停探活并还原并发基线（放在 try 之外：收尾异常也不能让探活定时器常驻）。
  waveDetach(groupId);
  if (skipped > 0) console.warn(`[workerPool] 组 ${groupId} 强停：在役中止 ${n}，排队跳过 ${skipped}`);
  return n;
}

// 当前在役 Worker 快照（Agent 面板兜底刷新用）
function listActive() {
  return [...activeRuns.entries()].map(([runKey, r]) => {
    const [groupId, taskId] = runKey.split('/');
    return { groupId, taskId, name: r.name };
  });
}

// M5 / T5-3：动态等待接缝（§7 L2）。这是 T5-8 `team_wait` 工具的**唯一**入口——
// 工具侧只负责把「我方要等谁」交上来，建边/环检测/状态迁移全部在 taskStore 内闭环完成，
// 池侧只做一件事：登记成功后 **中止当前 run 以释放槽位**（把「占着 4 个槽位干等」变成「让出槽位」）。
//
// 返回值语义（调用方据此决定 Agent 如何继续）：
//   · ok=false → 建边被拒（自等/成环/超上限/目标不存在），error 是可读原因，Lead 应改派而非重试；
//   · ok=true, waiting=false, reason='deps_already_settled' → 目标已终态，无需挂起，当前 run 继续跑；
//   · ok=true, waiting=true → 已挂起，槽位即将/已释放，本 run 会在 runWorkerTask 的 defer 分支收尾。
function waitTask(groupId, taskId, onTaskIds, opts = {}) {
  if (!deps?.store) return { ok: false, error: 'WorkerPool 未初始化', waiting: false, waitingOn: [], deadlineAt: null };
  const r = deps.store.waitOnTasks(groupId, taskId, onTaskIds, opts);
  if (!r.ok || !r.waiting) return r; // 被拒 / 无需挂起：不触碰在役 run
  // 已成等待：标记 run 为 defer 并中止它。runWorkerTask 会优先识别 store 的 waiting 状态并提前收尾，
  // 不会把这次 abort 当成失败（这正是「abort 语义必须可区分」的设计要点）。
  const entry = activeRuns.get(`${groupId}/${taskId}`);
  if (entry) {
    entry.deferred = true;
    entry.controller.abort(new Error('任务进入等待：依赖未就绪'));
  }
  return r;
}

// 关键失败处理已抽至 main/workerCritical.js（B-15 补线后本文件越过 800 行软档）。
// 保留空安全包装：调用点语义与抽走前一致（非关键任务 / 无阻塞失败均为 no-op）。
function maybePauseOnCritical(groupId, task, retried) {
  if (!task.critical || retried) return;
  pauseOnCriticalFailure(deps, groupId, task);
}

// 组收尾：聚合（代码聚合 v1）→ done / failed
function finalizeGroup(groupId) {
  // M5 / T5-12：组收尾即停探活（幂等；普通组无运行时为 no-op）。
  waveDetach(groupId);
  // 第八轮 B-02 / D-809：组收尾即清预算账本（防 Map 随长会话无限增长）。
  groupBudget.clear(groupId);
  const g = deps.store.getGroup(groupId);
  if (!g) return;
  const subResults = g.tasks.map((t) => ({ taskId: t.taskId, title: t.title, critical: t.critical, ok: t.status === 'done', result: t.result, error: t.error }));
  const anyCriticalFailed = subResults.some((r) => r.critical && !r.ok);
  const aggregation = aggregateGroup(subResults);
  const result = {
    summary: aggregation.merged.summary, artifacts: aggregation.merged.artifacts, warnings: aggregation.warnings,
    failed: aggregation.failed.map((f) => ({ taskId: f.taskId, title: f.title, error: f.error })),
  };
  // 2026-10-21 真机事故：预算跳过 / 任一任务失败都不得用 done 掩盖（含非关键失败）。
  const skippedError = teamTrace.finalizeNote(g, result);
  const status = (anyCriticalFailed || skippedError) ? 'failed' : 'done';
  const finalizeError = anyCriticalFailed ? `存在失败的关键任务（${result.failed.length} 个）` : skippedError;
  teamTrace.finalize({ groupId, status, error: finalizeError, subResults, g, result, skippedNote: skippedError });
  deps.store.setGroupStatus(groupId, status, { error: finalizeError, result });
  deps.emit?.({ type: 'group_update', groupId, status, result });
  // 终态事件：main 层据此触发 auto 组的自动重规划
  deps.emit?.({ type: 'group_finalized', groupId, status });
}

module.exports = { initWorkerPool, runGroup, setMaxConcurrent, getMaxConcurrent, activeCount, finalizeGroup, schedule, abortTask, abortGroup, listActive, waitTask };
