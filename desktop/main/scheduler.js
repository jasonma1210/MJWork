// 本地定时任务调度器（桌面端，离线可用）
// 设计：
// - 任务与运行记录持久化在 userData/scheduled-tasks.json（随 app 启动加载）
// - 每 20s 轮询 cron（5 字段：分 时 日 月 周），分钟粒度幂等（同分钟只触发一次）
// - P0-D：执行通道为 Agent（agent-core 工具循环 + 审批分级 + 沙箱 + 轮次预算），
//   未提供 runAgentTask 时回落单轮对话（chatOnce，兼容旧调用方）
// - 单任务墙钟超时（默认 10 分钟，startScheduler 可注入 taskTimeoutMs）防无人值守僵死
// - 有效期 valid_until（YYYY-MM-DD）过期后自动跳过；任务执行中不重复触发// - P0-8a：上次触发时刻 last_fired 随 store 持久化（原内存 Map 重启即丢失）；启动时扫描
//   [last_fired, now] 区间，宽限窗口内（与今天同日）补跑一次，否则标记 missed + last_status，
//   绝不静默；回放窗口上限 7 天，超长缺失只标记不补跑
// - P0-8b：runTask 收尾把 status/last_run_at/last_result 写回任务对象（UI 卡片直读，此前主进程从不写）
// - 与服务端 /scheduled-tasks 同构：list 返回任务数组，runs 返回执行历史数组
const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');
const scheduledStore = require('./scheduledStore');
const scheduledOutput = require('./scheduledOutput');
const guard = require('./ipc/payloadGuard');
// 熔断判据是纯函数（连续失败 → 自动暂停），单测覆盖，见 test/scheduled-verify.test.mjs
const { shouldAutoPause } = require('./verifyPolicy');
// 供应商错误 → 人话（内容安全/上下文超限/限流/凭证），原文保留
const { describeRunError } = require('./providerErrors');
// 成败判定（四条并列规则，见该模块头注释）；detectUnfinished/detectExhausted 仍由本文件转导出
const { judgeRun, detectUnfinished, detectExhausted } = require('./scheduledVerdict');

const STORE_FILE = () => path.join(app.getPath('userData'), 'scheduled-tasks.json');
// 归档根目录：Documents（应用外可查阅）。取不到时返回空串，归档会被跳过而不是抛。
function documentsDir() {
  try { return app.getPath('documents') || ''; } catch { return ''; }
}
const MAX_RUNS = 200;          // 全局运行历史上限
const MAX_RUNS_PER_TASK = 50;  // 单任务保留条数
const TICK_MS = 20 * 1000;
// 单任务墙钟上限。2026-10-18：10 → 20 分钟。
// 定时通道补上了 orchestrate_task（此前只有对话能用），并行抓 100 条 + 汇总写文件
// 在 10 分钟内会被从中间掐断，死因只会写成「执行超时」，把真正在做的事掩盖掉。
// 仍是有界值：编排组自己在 agent-core 里还有 30 分钟上限，这里先于它生效。
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
// P0-8a：补跑回放窗口上限（7 天）。应用数周未开时不做全量回放：只按窗口内实际到期的
// 计划执行标记 missed，超长缺失不补跑（补跑数天前的任务没有意义，只是制造误导性执行记录）。
const SCAN_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_RESULT_MAX = 500;   // P0-8b：任务对象上 last_result 的截断长度（运行记录内 output 仍为 20000）

let store = { tasks: [], runs: [] };
let execCtx = { chatOnce: null, runAgentTask: null, replayAction: null, model: null };
let timer = null;
let notifying = null;
let taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS;
const running = new Set();   // 执行中的 taskId

// ── 持久化 ──
// 读写决策与损坏自救已抽到 main/scheduledStore.js（数据韧性），本文件只保留调度语义。
// 历史（2026-10-16）此处修过两处：裸 writeFileSync 会半写、loadStore 把「损坏」当「首次启动」
// 静默清空——现分别是 durableWrite 与 scheduledStore.read() 的 reason 分支。
//
// 2026-10-18 真机事故（用户报「我创建的定时任务不显示了」）的关键守卫在下面 persist() 里：
// ② 未加载完成即写盘 = 用空 store 覆盖用户数据（抢锁失败的第二进程触发）
// 另外两条由 scheduledStore 承担：③ 损坏时先试 .bak ④ 空主文件时给可恢复快照（不自动还原）
let storeLoaded = false;   // 是否已从磁盘判定过存储状态（未判定前禁止写盘）
let recoverable = null;    // 可恢复快照提示：{ tasks, runs, from }

function loadStore() {
  const r = scheduledStore.read(STORE_FILE());
  store = r.store;
  recoverable = r.recoverable;
  storeLoaded = true; // 已判定过磁盘状态（即使文件不存在），此后允许写盘
  convergeInterruptedRuns(); // B：上次进程在任务中途退出时遗留的 running 记录，加载后收敛成 failed
  if (r.reason === 'corrupt-restored') {
    console.error(`[scheduled] 主存储损坏，已从 .bak 恢复 ${r.recoverable.tasks} 个任务`);
    persist(); // 立刻回写，避免下次启动再走一遍恢复
  } else if (r.reason === 'corrupt-unrecoverable') {
    console.error(`[scheduled] 定时任务文件损坏且无可用备份；已保留副本 ${r.corruptCopy}，本次启动定时任务为空`);
  } else if (r.reason === 'empty-main') {
    console.warn(`[scheduled] 主存储为空但备份含 ${r.recoverable.tasks} 个任务：等待用户确认恢复`);
  }
}

// ── B：僵尸 running 收敛 ──
// 真机现场：进程被杀/崩溃后，store.runs 里那条 run 永远停在 status='running'
// （实例 r-1792301285937-1698 在进程早已退出后仍是 running），UI 上「一直运行中」，last_run_at 不更新。
// 终点只能由**下次启动**补齐 —— 进程已经不在，没人能写 finished_at 了。
// 关键：这类 run 的 output:''/tools:0 是**初始化值**，不是「跑了 0 次工具」。tools 置 null（未知），
// 文案里写明「工具调用与输出未收尾」，否则它看起来像一次「0 次调用、空输出」的可信失败。
const INTERRUPTED_MSG = '运行被中断（应用在任务执行期间退出），工具调用与输出未收尾，本次数据不可信';
function convergeInterruptedRuns() {
  // 同进程内正在跑的 run 不算遗留（loadStore 若被中途再调一次，不能把活着的记录判死）
  const stale = store.runs.filter((r) => r && r.status === 'running' && !running.has(r.task_id));
  if (stale.length === 0) return 0;
  const at = new Date().toISOString();
  for (const r of stale) {
    Object.assign(r, { status: 'failed', error: INTERRUPTED_MSG, finished_at: at, interrupted: true, tools: null });
    // 卡片字段同步成同一句（否则「上次状态」还停在 running）；last_run_at 保留原始启动时刻，不假装刚跑过
    const t = store.tasks.find((x) => x.id === r.task_id);
    if (t) Object.assign(t, { last_status: 'failed', last_result: INTERRUPTED_MSG.slice(0, LAST_RESULT_MAX), last_run_at: r.started_at || t.last_run_at });
  }
  console.warn(`[scheduled] 收敛 ${stale.length} 条遗留 running 记录（应用上次在任务执行期间退出，已判失败）`);
  persist(); // 只在确需收敛时写盘：每次启动都 persist 是另一类事故（见下）
  return stale.length;
}

function persist() {
  // fail-closed：没加载完就写盘 = 用内存里的空 store 覆盖用户全部任务。
  // 事故链（2026-10-18，真机复现）：第二实例启动 → requestSingleInstanceLock 失败 →
  // app.quit() → 顶层注册的 will-quit 照样执行 → scheduler.persist() 把模块初始化值
  // { tasks: [], runs: [] } 写盘。persist 又先把旧文件复制成 .bak，所以磁盘上呈现为
  // 「主文件 31 字节空 store + .bak 里数据完好」，且下次启动读到的是**合法 JSON**，
  // 连损坏告警都不会有 —— 用户看到的就是「我创建的任务全没了」。
  // localStore.flushSync() 因为有 _dirty 守卫才没被同样清空（local-data.json 幸存）。
  if (!storeLoaded) {
    console.error('[scheduled] 拒绝写盘：存储尚未加载（否则会清空用户任务）');
    return { ok: false, error: 'store_not_loaded' };
  }
  return scheduledStore.write(STORE_FILE(), store);
}

// 存储状态（供 UI 判断要不要显示「可恢复」横幅）
function storeState() {
  return { loaded: storeLoaded, recoverable };
}

// 从 .bak 恢复（用户点了横幅上的「恢复」才走这条路；覆盖前留一份当前文件便于反悔）
function restoreBackup() {
  const r = scheduledStore.restoreFromBackup(STORE_FILE());
  if (!r.ok) return r;
  store = r.store;
  delete store.cleared_at; // 恢复出来的内容不是「用户主动清空」的结果
  recoverable = null;
  persist();
  notify();
  return { ok: true, tasks: r.tasks, runs: r.runs };
}

// ── cron 匹配（与渲染层 validateCron 同语义；周字段 0=周日）──
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function fieldOk(raw, [min, max]) {
  if (raw === '*' || raw === '') return true;
  return raw.split(',').every((part) => {
    const [rng, stepRaw] = String(part).split('/');
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    if (rng === '*') return true;
    if (rng.includes('-')) {
      const [a, b] = rng.split('-').map(Number);
      return Number.isInteger(a) && Number.isInteger(b) && a >= min && a <= max && b >= min && b <= max && a <= b;
    }
    const v = Number(rng);
    return Number.isInteger(v) && v >= min && v <= max;
  });
}

function cronValid(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  return f.every((raw, i) => fieldOk(raw, FIELD_RANGES[i]));
}

function fieldMatches(raw, value) {
  return String(raw).split(',').some((part) => {
    const [rng, stepRaw] = part.split('/');
    const step = stepRaw ? parseInt(stepRaw, 10) || 1 : 1;
    if (rng === '*' || rng === '') return value % step === 0;
    if (rng.includes('-')) {
      const [a, b] = rng.split('-').map(Number);
      return value >= a && value <= b && (value - a) % step === 0;
    }
    const v = Number(rng);
    if (Number.isNaN(v)) return false;
    return step === 1 ? value === v : value >= v && (value - v) % step === 0;
  });
}

function cronMatches(expr, d) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  return fieldMatches(f[0], d.getMinutes())
    && fieldMatches(f[1], d.getHours())
    && fieldMatches(f[2], d.getDate())
    && fieldMatches(f[3], d.getMonth() + 1)
    && fieldMatches(f[4], d.getDay());
}

// ── P0-8a：错过的计划执行扫描（补跑 / 标记，绝不静默）──

// 分钟的 ISO 键（秒/毫秒归零）：last_fired 的持久化格式，重启后可比较、可回放
function minuteIso(d) {
  const x = new Date(d);
  x.setSeconds(0, 0);
  return x.toISOString();
}

// 区间内逐分钟回放收集命中的分钟。区间为 (from, to]——左开右闭：from 是「已触发至此」的
// 游标（last_fired），该分钟已触发过，不重复计入。上限由调用方通过 SCAN_WINDOW_MAX_MS 控制，
// 7 天 = 10080 次纯内存 cron 判定，启动成本可忽略；区间超过上限时调用方已提前截断。
function collectMatchesBetween(expr, from, to) {
  const hits = [];
  if (!cronValid(expr)) return hits;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // 左开：跳过 from 当分钟（已触发）
  const end = new Date(to).getTime();
  while (d.getTime() <= end) {
    if (cronMatches(expr, d)) hits.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return hits;
}

// 同一自然日（本地时区）：宽限窗口判定——今天日内到期的计划执行允许补跑一次
function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 标记错过：写 missed 三件套 + 人话 last_result，并推进 last_fired 游标（避免重启后重复标记同一次错过）
function markMissed(t, reason, latestMatch) {
  t.missed = true;
  t.last_status = 'missed';
  t.last_result = reason;
  t.missed_at = new Date().toISOString();
  t.last_fired = minuteIso(latestMatch);
  persist();
  notify();
}

// 启动扫描：对每个启用任务回放 [last_fired, now] 区间内到期的分钟。
// - 最近一次到期与今天同日 → 补跑一次（trigger='catchup'）；
// - 否则（昨天及更早到期）→ 标记 missed，不补跑；
// - 距 last_fired 超过 7 天 → 窗口截断，只标记不补跑（超长缺失）；
// - 区间内没有任何到期分钟 → 原样不动（无错过可言）。
async function scanMissedTasks(now = new Date()) {
  for (const t of store.tasks) {
    if (!t.enabled) continue;
    // 事件触发任务不走时钟（由 ingestEvent 驱动），否则会拿空 schedule 去匹配
    if (t.trigger_type === 'event') continue;
    if (t.valid_until && now.getTime() > new Date(`${t.valid_until}T23:59:59`).getTime()) continue;
    if (!cronValid(t.schedule)) continue;
    const rawFrom = t.last_fired || t.last_run_at || t.created_at;
    if (!rawFrom) { t.last_fired = minuteIso(now); persist(); continue; }
    const fromMs = new Date(rawFrom).getTime();
    if (Number.isNaN(fromMs)) { t.last_fired = minuteIso(now); persist(); continue; }
    // 刚触发过（不足一个 tick 间隔）时不扫描：当前分钟由 tick 正常覆盖，避免双触发
    if (now.getTime() - fromMs < TICK_MS) continue;
    let from = fromMs;
    let capped = false;
    if (now.getTime() - from > SCAN_WINDOW_MAX_MS) {
      from = now.getTime() - SCAN_WINDOW_MAX_MS;
      capped = true;
    }
    if (from >= now.getTime()) continue; // 无区间可扫（时钟回拨或刚刚触发过）
    const hits = collectMatchesBetween(t.schedule, new Date(from), now);
    if (hits.length === 0) {
      // 窗口内无到期执行：超长缺失时推进游标，避免每次重启都回放整个 7 天窗口
      if (capped) { t.last_fired = minuteIso(now); persist(); }
      continue;
    }
    const latest = hits[hits.length - 1];
    if (capped) {
      const days = Math.max(1, Math.round((now.getTime() - fromMs) / (24 * 60 * 60 * 1000)));
      markMissed(t, `已超过 ${days} 天未运行，期内到期的执行未安排补跑（仅记录，不补跑）`, latest);
      console.warn(`[scheduled] 任务「${t.name}」超长缺失（>${days} 天）：已标记 missed，未补跑`);
      continue;
    }
    if (isSameLocalDay(latest, now)) {
      // 宽限窗口内：补跑一次（幂等游标先行落盘，补跑异步失败也不重复触发）
      t.last_fired = minuteIso(latest);
      persist();
      console.warn(`[scheduled] 任务「${t.name}」在应用未运行期间到期（${fmtLocal(latest)}），安排补跑一次`);
      try {
        await runTask(t.id, 'catchup');
      } catch (e) {
        console.error('[scheduled] 补跑失败:', e.message);
      }
      continue;
    }
    const n = hits.length;
    markMissed(t, `应用未运行，错过 ${n} 次计划执行（最近一次应为 ${fmtLocal(latest)}）`, latest);
    console.warn(`[scheduled] 任务「${t.name}」错过 ${n} 次计划执行：已标记 missed`);
  }
}

// ── 执行 ──
// 成败判定（未完成措辞 / 引擎闸门 / 零写入 / 交付校验降级）收敛在 main/scheduledVerdict.js 的
// 纯函数里：四条规则并列、命中即失败、文案取第一个命中。为什么搬出去：判定已经长到四条，
// 留在本文件既顶行数门禁，也没法把「同时命中两条时用哪条文案」写成断言。
async function runTask(id, trigger = 'manual') {
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: '任务不存在' };
  if (running.has(id)) return { ok: false, error: '任务正在执行中' };
  const useAgent = typeof execCtx.runAgentTask === 'function';
  if (!useAgent && typeof execCtx.chatOnce !== 'function') {
    return { ok: false, error: '执行通道未就绪（模型凭证未加载）' };
  }
  // 任务级模型优先，其次会话当前模型。任务模型的 provider 可能已被删除 ——
  // 那种情况回落会话模型并留痕，绝不因为一个过期引用让任务永久跑不动。
  const taskModel = normalizeTaskModel(t.model);
  if (t.model && !taskModel) console.warn(`[scheduled] 任务「${t.name || id}」的模型配置形状不全，回落会话模型`);
  const model = taskModel || execCtx.model;
  if (!model || !model.model) {
    return { ok: false, error: '未配置执行模型：请在定时任务里选一个模型，或先在任意会话中选择模型' };
  }
  if (taskModel && !taskModel.baseUrl) {
    // baseUrl 用于直连解析；缺它时凭证层仍可用（resolveSecret 会补），但明确记一笔便于排查
    console.warn(`[scheduled] 任务「${t.name || id}」的模型缺少 baseUrl，按供应商默认地址解析`);
  }

  running.add(id);
  const started = Date.now();
  const run = {
    id: `r-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    task_id: id,
    trigger,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: 0,
    output: '',
    error: '',
    channel: useAgent ? 'agent' : 'chat', // P0-D：执行通道可观测
    execution_mode: t.team_id ? 'team' : 'agent', // 团队化执行（预先声明了 team_id）还是匿名编排
    tools: 0,                              // Agent 通道的工具调用计数
    tokens: null,                          // Agent 通道的 token 用量 {prompt_tokens, completion_tokens}
    writes: null,                          // Agent 通道的写工具成功次数（V 层对账）；null=未知，不能用它判「没写文件」
    shellWrites: null,                     // Agent 通道的 shell 重定向写次数（同上：任一 >0 都算有产出）
    // 待确认动作：只有 Agent 通道会用对外闸门，但字段必须在**所有**路径上都存在
    //（chat 通道与异常路径不写它，缺省会让收尾处的 .length 直接抛，把整个任务变成崩溃）
    pending_actions: [],
  };
  store.runs.unshift(run);
  store.runs = store.runs.slice(0, MAX_RUNS);
  persist();
  notify();

  // 无人值守墙钟超时：到点 abort（runAgent 的 signal 会收敛当前轮）
  const ctl = new AbortController();
  const timeoutTimer = setTimeout(() => ctl.abort(), taskTimeoutMs);
  try {
    if (useAgent) {
      const r = await execCtx.runAgentTask({
        prompt: t.prompt, model, signal: ctl.signal, taskId: id, taskName: String(t.name || ''),
        // 单次运行的唯一 id：待确认动作的幂等键 = `${runId}#序号`，必须按 run 唯一
        runId: run.id,
        // 任务级放行开关：默认（缺省）拦截对外/不可逆动作，转成「待确认动作清单」
        externalPolicy: t.external_policy === 'allow' ? 'allow' : 'block',
        // 军团/会话绑定（可选）：执行通道据此走团队派活语义 / 装入原会话历史
        teamId: t.team_id || null,
        threadId: t.thread_id || null,
      });
      run.output = String(r?.output || '').slice(0, 20000);
      run.tools = Number(r?.toolCalls) || 0;
      run.tokens = r?.usage || null;
      // 被闸门拦下的对外动作：随运行记录 + 归档 md 一起落盘（早上人工确认的唯一入口）
      run.pending_actions = Array.isArray(r?.pendingActions) ? r.pendingActions.slice(0, 20) : [];
      // V 层结论随运行记录落盘：无人值守下这是唯一能回答「这次到底判过没判、判成什么」的地方
      run.verify = r?.verify || null;
      // 四条判定（未完成措辞 / 引擎闸门 / 零产出 / 交付降级）收敛成一次调用，命中即失败、取第一个文案。
      // writes/shellWrites 来自 V 层的确定性对账；hasVerify 为 false 或任一计数未知时不判——不把「没数据」当成「没写文件」。
      const verdict = judgeRun({
        output: run.output, tools: run.tools, writes: r?.writes, shellWrites: r?.shellWrites,
        hasVerify: !!(r?.verify && r.verify.stats), delivery: r?.delivery, dir: r?.workDir,
        expectsFile: t.expects_file !== false,
      });
      run.status = verdict.status;
      if (verdict.error) run.error = verdict.error;
      if (typeof r?.writes === 'number') run.writes = r.writes; // 让「没写文件」这件事进运行记录（UI/排障要看得见）
      if (typeof r?.shellWrites === 'number') run.shellWrites = r.shellWrites;
      run.workDir = r?.workDir || ''; // 产物目录进运行记录：事后要知道文件写在哪
    } else {
      const out = await execCtx.chatOnce({
        messages: [
          { role: 'system', content: '你是定时任务执行器：直接完成任务提示词中的要求并输出精炼结果，不要反问、不要输出无关寒暄。' },
          { role: 'user', content: String(t.prompt || '') },
        ],
      }, model);
      run.output = String(out || '').slice(0, 20000);
      const unfinished = detectUnfinished(run.output, 0);
      if (unfinished) { run.status = 'failed'; run.error = unfinished; } else { run.status = 'success'; }
    }
  } catch (err) {
    run.status = 'failed';
    // 无人值守无用户中止入口，signal.aborted 即墙钟超时
    if (ctl.signal.aborted) {
      run.error = `执行超时（墙钟上限 ${Math.round(taskTimeoutMs / 60000)} 分钟），已中止`;
    } else {
      // 供应商原文直接甩给用户等于没解释：翻译成人话，但原文必须保留（见 providerErrors.js）
      const d = describeRunError(err);
      run.error = d.error;
      run.error_kind = d.kind;
    }
  } finally {
    clearTimeout(timeoutTimer);
  }
  run.finished_at = new Date().toISOString();
  run.duration_ms = Date.now() - started;
  running.delete(id);
  // P0-8b：状态字段写回任务对象（ScheduledTasks.jsx 的卡片直读 last_status/last_run_at/
  // last_result；此前 scheduler 从不写入这三个字段，UI 上「上次状态」恒为空）。
  // last_result 截断到 LAST_RESULT_MAX——任务对象随每次持久化落盘，不塞完整输出。
  t.last_status = run.status;
  t.last_run_at = run.started_at;
  t.last_result = (run.status === 'success'
    ? String(run.output || '')
    : String(run.error || run.output || '')).slice(0, LAST_RESULT_MAX);
  t.missed = false; // 实际执行过（无论成败）即不再是「错过」态
  delete t.missed_at;
  // 待确认动作计数写回任务：UI 卡片据此显示「N 项待确认」（不把清单塞进任务对象，它随 run 走）
  t.pending_count = Array.isArray(run.pending_actions) ? run.pending_actions.length : 0;
  // ── 任务级熔断 ──
  // 无人值守最贵的故障不是「某一次判错」，而是「半夜起每小时挂一次、早上才发现」。
  // 连续失败到阈值就自动暂停任务并留痕，人早上回来再决定是否恢复 —— 与 ChatGPT 定时任务的
  // auto-pause 同一取向（宁可停摆也不静默烧钱/静默失败）。
  t.fail_streak = run.status === 'success' ? 0 : (Number(t.fail_streak) || 0) + 1;
  // 只在**自动触发**（scheduled/catchup/event）时熔断：用户手动点「立即运行」失败三次不该把任务停掉，
  // 那是他在排查问题。trigger 取值见 runTask 的调用点（事件触发同样会自动反复来，必须计入）。
  const autoTrigger = trigger === 'scheduled' || trigger === 'catchup' || trigger === 'event';
  if (autoTrigger && t.enabled && shouldAutoPause({ failStreak: t.fail_streak })) {
    t.enabled = false;
    t.auto_paused_at = new Date().toISOString();
    t.auto_pause_reason = `连续 ${t.fail_streak} 次失败，已自动暂停（最近一次：${String(run.error || '未知原因').slice(0, 200)}）`;
    console.warn(`[scheduled] ${t.name || id} ${t.auto_pause_reason}`);
  }
  // 归档到 ~/Documents/.MJCoder/tasks/<任务名>/<YYYY-MM-DD>.md
  // 无人值守任务在应用外没有任何可查阅的产出，这里落一份按天归档的完整记录。
  // 写盘失败只告警：归档是附加能力，不能反噬任务本身的成败判定。
  try {
    await scheduledOutput.appendRunRecord({
      baseDir: documentsDir(), taskName: t.name, schedule: t.schedule, run,
    });
  } catch (e) {
    console.warn('[scheduled] 输出归档失败（不影响任务结果）:', e.message);
  }
  // 每任务历史上限
  const same = store.runs.filter((r) => r.task_id === id);
  if (same.length > MAX_RUNS_PER_TASK) {
    const drop = new Set(same.slice(MAX_RUNS_PER_TASK).map((r) => r.id));
    store.runs = store.runs.filter((r) => !drop.has(r.id));
  }
  persist();
  notify();
  return { ok: run.status === 'success', output: run.output, error: run.error, pendingActions: run.pending_actions };
}

function tick() {
  const now = new Date();
  const key = minuteIso(now);
  for (const t of store.tasks) {
    if (!t.enabled) continue;
    // 事件触发任务不走时钟（由 ingestEvent 驱动），否则会拿空 schedule 去匹配
    if (t.trigger_type === 'event') continue;
    if (t.valid_until && now.getTime() > new Date(`${t.valid_until}T23:59:59`).getTime()) continue;
    if (!cronValid(t.schedule) || !cronMatches(t.schedule, now)) continue;
    // P0-8a：幂等游标从内存 Map 改为任务对象上的持久化字段（重启后不重复触发，
    // 也是启动补跑扫描的区间起点）
    if (t.last_fired === key) continue;
    t.last_fired = key;
    persist();
    runTask(t.id, 'scheduled').catch((e) => console.error('[scheduled] 触发失败:', e.message));
  }
}

function notify() {
  if (typeof notifying !== 'function') return;
  try { notifying({ tasks: store.tasks, runs: store.runs }); } catch { /* 通知失败不影响调度 */ }
}

// ── 事件触发 ──
// 去重环：同一事件 id 不重复触发（webhook 重投、适配器重连都会重放同一事件）。
// 合并：任务正在跑就直接合掉（不进队列）—— 一个 PR 能连发 opened/synchronize/commented 三条，
// 排队只会把同一件事做三遍、烧三份 token。
const EVENT_SEEN_MAX = 50;

// 纯判定：哪些任务该为此事件 fired（去重 + 合并），抽出来便于单测（不碰 store / 不真跑）
function selectEventTargets(tasks, { source, event, id }, isRunning = () => false) {
  const targets = [];
  const skipped = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || !t.enabled || t.trigger_type !== 'event') continue;
    if (t.event_source !== source || t.event_name !== event) continue;
    const seen = Array.isArray(t.event_seen) ? t.event_seen : [];
    if (seen.includes(id)) { skipped.push({ id: t.id, reason: 'duplicate' }); continue; }
    if (isRunning(t.id)) { skipped.push({ id: t.id, reason: 'busy' }); continue; }
    targets.push(t);
  }
  return { targets, skipped };
}

async function ingestEvent({ source, event, id } = {}) {
  const src = String(source || '').trim();
  const evt = String(event || '').trim();
  if (!src || !evt) return { ok: false, error: 'source 与 event 必填', matched: 0, started: 0, skipped: [] };
  const eid = String(id || '').trim() || cryptoId();
  const { targets, skipped } = selectEventTargets(store.tasks, { source: src, event: evt, id: eid }, (tid) => running.has(tid));
  let started = 0;
  for (const t of targets) {
    const seen = Array.isArray(t.event_seen) ? t.event_seen : [];
    t.event_seen = [...seen, eid].slice(-EVENT_SEEN_MAX);
    t.last_fired = minuteIso(new Date());
    persist();
    runTask(t.id, 'event').catch((e) => console.error('[scheduled] 事件触发失败:', e.message));
    started += 1;
  }
  if (started) notify();
  return { ok: true, eventId: eid, matched: targets.length + skipped.length, started, skipped };
}

function cryptoId() {
  try { return require('node:crypto').randomBytes(6).toString('hex'); } catch { return String(Date.now()); }
}

// ── 对外 API ──
// startScheduler 对执行上下文是权威定义：未提供的通道显式置空（不保留上一次的注入），
// 避免调用方换了通道组合后旧通道仍然生效
function startScheduler({ chatOnce, runAgentTask, replayAction, notify: n, taskTimeoutMs: tt } = {}) {
  loadStore();
  execCtx.chatOnce = typeof chatOnce === 'function' ? chatOnce : null;
  execCtx.runAgentTask = typeof runAgentTask === 'function' ? runAgentTask : null;
  execCtx.replayAction = typeof replayAction === 'function' ? replayAction : null;
  if (Number(tt) > 0) taskTimeoutMs = Number(tt);
  notifying = n || null;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, TICK_MS);
  // P0-8a：启动补跑扫描——应用未运行期间到期的计划执行，补跑一次或标记 missed（绝不静默）。
  // 异步执行不阻塞启动；扫描内部对每个任务 await runTask，任务间串行防止并发踩踏。
  scanMissedTasks().catch((e) => console.error('[scheduled] 启动补跑扫描异常:', e.message));
  const enabled = store.tasks.filter((t) => t.enabled).length;
  const channel = execCtx.runAgentTask ? 'agent' : 'chat';
  console.log(`[scheduled] 调度器已启动：${store.tasks.length} 个任务（${enabled} 启用），执行通道=${channel}`);
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getModel() { return execCtx.model; }
function setModel(model) { execCtx.model = model || null; }

// 任务级模型：形状不全或指向已删除的 provider 时一律返回 null（调用方回落到会话模型）。
// 为什么不在保存时强校验：provider 可以被删/改名，任务存的是快照；运行时再判定更真实。
function normalizeTaskModel(m) {
  if (!m || typeof m !== 'object') return null;
  const providerId = String(m.providerId || '').trim();
  const model = String(m.model || '').trim();
  if (!providerId || !model) return null;
  // cwd 必须保留：任务级模型是运行时快照，丢掉它等于把「用户在这个项目里跑」变成「没有项目」
  //（真机事故的现场 cwd 是 /Users/.../Documents/.MJCoder/20261017-5742，非空）。
  // 可选字段：老快照里没有 cwd 时**不凭空补空串**，保持「未指定」语义（跟随会话）。
  const cwd = typeof m.cwd === 'string' ? m.cwd.slice(0, 1024) : '';
  return { providerId, isGlobal: !!m.isGlobal, baseUrl: String(m.baseUrl || ''), model, ...(cwd ? { cwd } : {}) };
}

// 创建定时任务（IPC 与模型工具共用同一实现，避免两套校验规则漂移）。
// teamId / threadId：可选的**军团绑定**与**会话绑定**（设计文档 §14 P1-6）。
// 无人值守纪律：团队化必须**预先声明**（team_id + 预算），不得在无人值守时静默升级。
function createTask({ name, prompt, schedule, enabled, valid_until: validUntilRaw, external_policy: externalPolicy, trigger_type: triggerType, event_source: eventSource, event_name: eventName, model: taskModel, expects_file: expectsFile, teamId, threadId } = {}) {  const nm = String(name || '').trim();
  const pr = String(prompt || '');
  const sc = String(schedule || '').trim();
  const isEvent = triggerType === 'event';
  if (!nm || !pr) return { ok: false, error: '任务名称与提示词必填' };
  if (isEvent) {
    if (!String(eventSource || '').trim() || !String(eventName || '').trim()) {
      return { ok: false, error: '事件触发任务必须填写事件来源与事件名' };
    }
  } else if (!cronValid(sc)) {
    return { ok: false, error: 'Cron 表达式无效（5 字段：分 时 日 月 周）' };
  }
  const t = {
    id: `t-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    name: nm, prompt: pr,
    // 事件触发任务没有 cron（schedule 留空，tick 会跳过它）
    schedule: isEvent ? '' : sc,
    trigger_type: isEvent ? 'event' : 'cron',
    ...(isEvent ? {
      event_source: String(eventSource).trim().slice(0, 60),
      event_name: String(eventName).trim().slice(0, 60),
      event_seen: [], // 去重环：同一事件 id 不重复触发
    } : {}),
    enabled: enabled !== false,
    // 对外动作放行开关：缺省 block（无人值守默认不产生不可逆副作用）
    external_policy: externalPolicy === 'allow' ? 'allow' : 'block',
    // 是否要求产出文件（默认 true）：关掉后「零产出」不再判失败——只做 git 提交/只做汇报的任务
    // 本来就不该产出文件，硬判会让它连续失败并触发 auto-pause。用户可在任务设置里关。
    expects_file: expectsFile !== false,
    // 任务级模型（null = 跟随会话当前模型）。存快照而不是引用：运行时 provider 可能已被删。
    model: normalizeTaskModel(taskModel),
    // 可选绑定：team_id = 用哪支军团跑（null = 匿名编排，现状）；thread_id = 绑定哪个会话（Codex Thread automation 形态）
    team_id: scheduledStore.optStr(teamId),
    thread_id: scheduledStore.optStr(threadId),
    valid_until: validUntilRaw ? String(validUntilRaw).slice(0, 10) : null,
    created_at: new Date().toISOString(),
  };
  store.tasks.unshift(t);
  // 新建即意味着「用户并没有清空任务」：清掉主动清空标记与可恢复提示，避免 UI 一直挂着横幅
  delete store.cleared_at;
  recoverable = null;
  persist();
  notify();
  return { ok: true, task: t };
}

function registerIpc() {
  // recoverable：主文件为空但备份里还有任务时给 UI 的提示（用户一键恢复，见 scheduled:restoreBackup）
  ipcMain.handle('scheduled:list', async () => ({ ok: true, tasks: store.tasks, runs: store.runs, recoverable }));
  // 从 .bak 一键恢复（事故兜底：写入被异常清空后用户不必手工改文件）
  ipcMain.handle('scheduled:restoreBackup', async () => restoreBackup());
  ipcMain.handle('scheduled:save', async (_, p = {}) => {
    // X14：调度任务会被无人值守执行，名称/提示词/表达式都必须在边界校验。
    // 保持既有信封契约（调用方读 r.ok），故把校验异常转成 {ok:false}
    // P1（2026-10-18 实测）：原来是「三件套必填」，但 UI 的启用/停用开关只发 { id, enabled }
    // → 边界直接拒绝，开关点了没反应（错误还被 UI 吞掉）。改为**部分更新**：
    // 新建仍要求三件套；带 id 时只校验实际提供的字段。
    try {
      guard.assertStrings(p, {
        name: { max: 120, optional: true },
        prompt: { max: 20000, optional: true },
        schedule: { max: 120, optional: true },
        team_id: { max: 128, optional: true }, thread_id: { max: 128, optional: true },
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // expects_file 是布尔（payloadGuard 没有布尔断言）：显式给非布尔值时拒绝，别让 "false" 字符串悄悄变 true
    if (p.expects_file !== undefined && p.expects_file !== null && typeof p.expects_file !== 'boolean') {
      return { ok: false, error: 'expects_file 必须是布尔值（true/false）' };
    }
    const has = (k) => p[k] !== undefined && p[k] !== null;
    // 任务级模型：对象形态，字段边界单独守
    if (p.model !== undefined && p.model !== null) {
      try {
        guard.assertObject(p.model, 'model');
        guard.assertStrings(p.model, {
          model: { max: 200 },
          baseUrl: { max: 2000, optional: true, allowEmpty: true },
          // cwd 是路径字符串（不是 id）：用 assertStrings 的 optional 形态收，最多 1024
          cwd: { max: 1024, optional: true, allowEmpty: true },
        });
        // providerId 两种形态都合法：本机 provider 是自增**数字** id，全局/服务端是字符串
        // （main.js 的 resolveSecret 注释里早就写明这点）。用 assertStrings 会在数字 id 上直接抛
        // 「providerId 必须是字符串（收到 number）」——2026-10-18 用户就在「改模型」时撞到这行。
        guard.assertIdLike(p.model, ['providerId']);
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    if (p.id) {
      const t = store.tasks.find((x) => x.id === p.id);
      if (!t) return { ok: false, error: '任务不存在' };
      const patch = {};
      if (has('name')) patch.name = String(p.name).trim();
      if (has('prompt')) patch.prompt = String(p.prompt);
      if (has('schedule')) {
        const sc = String(p.schedule).trim();
        if (!cronValid(sc)) return { ok: false, error: 'Cron 表达式无效（5 字段：分 时 日 月 周）' };
        patch.schedule = sc;
      }
      if (has('enabled')) patch.enabled = p.enabled !== false;
      if (has('valid_until')) patch.valid_until = p.valid_until ? String(p.valid_until).slice(0, 10) : null;
      if (has('external_policy')) patch.external_policy = p.external_policy === 'allow' ? 'allow' : 'block';
      if (has('expects_file')) patch.expects_file = p.expects_file !== false;
      // 军团/会话绑定（可选）：非字符串一律落 null（fail-closed，见 scheduledStore.optStr）
      if (has('team_id')) patch.team_id = scheduledStore.optStr(p.team_id);
      if (has('thread_id')) patch.thread_id = scheduledStore.optStr(p.thread_id);
      // 用「键存在」判定而不是非空：显式传 model:null 表示**恢复跟随会话模型**
      if (Object.prototype.hasOwnProperty.call(p, 'model')) patch.model = normalizeTaskModel(p.model);
      Object.assign(t, patch);
      persist();
      notify(); // 更新后必须广播：此前 update 分支漏了 notify，其他视图看不到改动
      return { ok: true, task: t };
    }
    const name = String(p.name || '').trim();
    const prompt = String(p.prompt || '');
    const schedule = String(p.schedule || '').trim();
    if (!name || !prompt || !schedule) return { ok: false, error: '任务名称、提示词与 Cron 表达式必填' };
    if (!cronValid(schedule)) return { ok: false, error: 'Cron 表达式无效（5 字段：分 时 日 月 周）' };
    const validUntil = p.valid_until ? String(p.valid_until).slice(0, 10) : null;
    return createTask({ name, prompt, schedule, enabled: p.enabled, valid_until: validUntil, external_policy: p.external_policy, model: p.model, expects_file: p.expects_file, teamId: p.team_id, threadId: p.thread_id });
  });
  ipcMain.handle('scheduled:delete', async (_, { id } = {}) => {
    // X14：id 决定删掉哪条任务及其运行历史——非字符串会 filter 掉全部（id 不匹配任何记录），
    // 用户看到的是「点了删除但任务还在」
    try {
      guard.assertStrings({ id }, { id: 120 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    store.tasks = store.tasks.filter((t) => t.id !== id);
    store.runs = store.runs.filter((r) => r.task_id !== id);
    running.delete(id);
    // 删掉最后一条 = 用户主动清空。打标后下次启动不会把 .bak 里的旧任务当成「可恢复」来打扰用户
    // （.bak 存的是删前状态，误判会变成「删除被自动撤销」）
    if (store.tasks.length === 0) store.cleared_at = new Date().toISOString();
    else delete store.cleared_at;
    persist();
    notify();
    return { ok: true };
  });
  ipcMain.handle('scheduled:run', async (_, { id } = {}) => {
    // X14：手动触发会真的跑一轮 Agent（花 token、可能写文件）——形状先在边界守
    try {
      guard.assertStrings({ id }, { id: 120 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return runTask(id, 'manual');
  });
  ipcMain.handle('scheduled:runs', async (_, { id } = {}) => ({
    ok: true,
    runs: store.runs.filter((r) => r.task_id === id).slice(0, MAX_RUNS_PER_TASK),
  }));
  // 待确认动作的一键执行：幂等（同一条只能执行一次）+ 重放前重新校验（HEAD 变了判 stale）
  ipcMain.handle('scheduled:replayAction', async (_, { runId, actionId } = {}) => {
    try {
      guard.assertStrings({ runId, actionId }, { runId: 120, actionId: 200 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const run = store.runs.find((r) => r.id === runId);
    if (!run) return { ok: false, error: '运行记录不存在（可能已被清理）' };
    const action = (Array.isArray(run.pending_actions) ? run.pending_actions : []).find((a) => a.id === actionId);
    if (!action) return { ok: false, error: '待确认动作不存在' };
    if (action.status !== 'pending') return { ok: false, error: '该动作已处理过（同一动作不能执行两次）' };
    if (typeof execCtx.replayAction !== 'function') return { ok: false, error: '重放执行器未就绪' };
    const r = await execCtx.replayAction({ action, cwd: action.cwd || getModel()?.cwd || '' });
    // 无论成功失败都落状态：失败也要让人看到「试过了、为什么不行」，否则会反复点
    action.status = r.ok ? 'executed' : (r.code === 'stale' || r.code === 'manual' ? r.code : 'failed');
    action.executed_at = new Date().toISOString();
    action.error = String(r.error || '').slice(0, 500);
    if (r.stdout) action.result = String(r.stdout).slice(0, 1000);
    // 任务卡片的计数只反映「还剩几项待处理」
    const taskObj = store.tasks.find((t) => t.id === run.task_id);
    if (taskObj) {
      taskObj.pending_count = store.runs
        .filter((x) => x.task_id === run.task_id)
        .reduce((n, x) => n + (Array.isArray(x.pending_actions) ? x.pending_actions.filter((a) => a.status === 'pending').length : 0), 0);
    }
    persist();
    notify();
    return { ok: r.ok, code: r.code, error: r.error || '', stdout: r.stdout || '' };
  });
  // 事件入口（IPC 版；HTTP 版见 scheduledEventServer.js）。E2：本通道未在 preload 暴露 ⇒ 渲染层调不到
  // （ScheduledTasks.jsx 里那句只是说明性注释），外部事件请走 HTTP 版；保留不删＝预留给本地适配器直连。
  ipcMain.handle('scheduled:ingestEvent', async (_, p = {}) => {
    try {
      guard.assertStrings(p, {
        source: { max: 60, optional: true },
        event: { max: 60, optional: true },
        id: { max: 120, optional: true, allowEmpty: true },
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return ingestEvent(p);
  });
  ipcMain.handle('scheduled:setModel', async (_, model = null) => {    // X14：model 会作为定时任务/编排的执行模型（含凭证解析用的 providerId/baseUrl）——
    // 允许 null（清空），非 null 时必须是对象且关键字段是短字符串
    if (model !== null && model !== undefined) {
      try {
        guard.assertObject(model, 'model');
        guard.assertStrings(model, {
          model: { max: 200, optional: true, allowEmpty: true },
          baseUrl: { max: 2000, optional: true, allowEmpty: true },
          cwd: { max: 1024, optional: true, allowEmpty: true },
        });
        // providerId 是数字（本机自增）或字符串（全局/服务端）——只挡对象/数组/空串
        guard.assertIdLike(model, ['providerId']);
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    setModel(model);
    return { ok: true };
  });
}

module.exports = {
  startScheduler, stopScheduler, registerIpc, getModel, setModel,
  cronValid, cronMatches, runTask, persist,
  // 2026-10-18：存储守卫与自救（未加载禁止写盘 / 从 .bak 恢复 / 可恢复提示）
  loadStore, storeState, restoreBackup, convergeInterruptedRuns,
  // P0-8a：补跑扫描与区间回放导出（测试可注入固定 now 做确定性断言）
  scanMissedTasks, collectMatchesBetween,
  // 2026-10-17:假成功识别（纯函数，单测直调）
  detectUnfinished,
  // 2026-10-18：引擎侧「未完成」收尾（熔断/预算耗尽）识别，与工具调用次数无关
  detectExhausted,
  // 2026-10-17：模型侧 scheduled_create 工具的落地实现（与 IPC 共用同一校验）
  createTask,
  // 2026-10-18：事件触发入口（去重 + 合并），HTTP 适配器见 scheduledEventServer
  ingestEvent, selectEventTargets,
  // 2026-10-18：任务级模型快照归一（provider 可能被删，运行时再判定）
  normalizeTaskModel,
};
