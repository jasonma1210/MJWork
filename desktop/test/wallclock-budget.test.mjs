// P1-1 整任务墙钟预算门禁（2026-10-18 全量修复）
//
// 缺口：轮次/token/abort 三闸都只能约束「单次调用」或「累计用量」，模型每次都很"乖"地
//   在 100s 内返回、但一轮接一轮不停，任务可以跑几小时——三闸都不响。
// 本套件锁三件事：
//   ① 命中后走「暂停而非失败」：onSuspend 收到 kind:'wallclock'，断点落盘；
//   ② 收尾文案对用户说清「总时长预算」（不是「轮次预算」，否则用户以为续轮次就能救）；
//   ③ **不得新增 budgetKind 枚举值**——新增会外溢到 workerPool 收尾文案与 main.js humanize，
//      表现为「编排 Worker 静默丢文案」。故 budgetKind 仍为 'rounds'，另以 wallclock:true 区分。
//
// 陷阱（规格 §2）：不要断言「轮次预算」字样——已刻意改为「总时长预算」。
import {
  runAgent, DEFAULT_RUN_WALL_CLOCK_MS,
} from '../agent-core/index.js';
import { wallClockDecision, roundCapDecision, MAX_WALLCLOCK_RENEWS, MAX_ROUND_RENEWS } from '../agent-core/budgetDecision.js';
import { segmentDecision, buildSegmentDigest, MAX_SEGMENTS } from '../agent-core/segmentHandoff.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('DEFAULT_RUN_WALL_CLOCK_MS === 30 分钟', DEFAULT_RUN_WALL_CLOCK_MS === 30 * 60 * 1000, `got=${DEFAULT_RUN_WALL_CLOCK_MS}`);

{
  const traces = [];
  const budgetSnapshots = [];
  const suspends = [];
  let chatCount = 0;
  const toolHandlers = {
    // 每次模型调用都慢 20ms：单轮远低于任何单轮超时，但整体会越过 5ms 的墙钟闸
    chat: async () => {
      chatCount += 1;
      await sleep(20);
      return {
        content: `第 ${chatCount} 步`,
        tool_calls: [{ id: `s${chatCount}`, type: 'function', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
    shell: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
  };
  const model = {
    provider: { id: 1, isGlobal: false, base_url: 'http://local' },
    model: { id: 1, model_id: 'm', context_window: 200000 },
  };
  let finalText = null;
  await runAgent({
    messages: [{ role: 'user', content: '干一长串活' }],
    model,
    toolHandlers,
    runWallClockMs: 5,
    maxRounds: 40,
    tokenBudget: 0,
    onMessage: () => {},
    onTrace: (e) => traces.push(e),
    onBudget: (s) => budgetSnapshots.push({ ...s }),
    onSuspend: (info) => { suspends.push(info); return true; },
    onDone: (t) => { finalText = t; },
  });

  check('墙钟命中后调用 onSuspend 且 kind 为 wallclock',
    suspends.length === 1 && suspends[0].kind === 'wallclock',
    `suspends=${JSON.stringify(suspends.map((s) => s.kind))}`);
  check('onSuspend 收到断点摘要与轮数（宿主可据此落断点）',
    typeof suspends[0]?.summary === 'string' && Number(suspends[0]?.roundsUsed) >= 1,
    `roundsUsed=${suspends[0]?.roundsUsed}`);
  check('收尾文案同时含「总时长预算」与「断点已保存」',
    String(finalText).includes('总时长预算') && String(finalText).includes('断点已保存'),
    String(finalText).slice(-120));
  check('收尾文案不再错误地说「执行轮次预算」',
    !String(finalText).includes('执行轮次预算'), String(finalText).slice(-120));

  const runEnds = traces.filter((e) => e.type === 'run_end');
  // 2026-10-18：**一次 run 只能有一条 run_end**。此前墙钟分支先发 `{wallclock:true}`、
  // break 后统一出口又发一条 → 下游按「最后一条」判断会把超时读成正常结束（实测 true,false）。
  check('墙钟路径只发 1 条 run_end（时间线不出现双尾事件）', runEnds.length === 1,
    `run_end=${runEnds.length} 条，wallclock 标记=${runEnds.map((e) => !!e.wallclock).join(',')}`);
  const runEnd = runEnds[0] || {};
  // 三者必须同时成立（team-lead 2026-10-18 口径）：
  //   wallclock===true 标记命中来源；budgetExhausted===true 标记确实熔断；
  //   budgetKind 仍是 'rounds' —— **刻意复用值**，新增枚举会让 workerPool 与 main.js humanize 静默漏文案。
  check('run_end 同时满足 wallclock===true / budgetExhausted===true / budgetKind===\'rounds\'',
    runEnd.wallclock === true && runEnd.budgetExhausted === true && runEnd.budgetKind === 'rounds',
    `wallclock=${runEnd.wallclock} budgetExhausted=${runEnd.budgetExhausted} budgetKind=${runEnd.budgetKind}`);
  const finalSnap = budgetSnapshots.filter((s) => s.running === false).pop() || {};
  check('收尾快照 budgetKind 未新增枚举值', finalSnap.budgetKind === 'rounds', `kind=${finalSnap.budgetKind}`);
  check('墙钟闸不会每轮都触发（实际只跑了有限轮）', chatCount >= 1 && chatCount < 40, `chat=${chatCount}`);
}

// ── 2026-10-31：到点先「自动续期」，续满才挂起 ──
// 事故形状（用户实测反馈）：任务跑到一半突然停，收尾说「已重试/续期若干次」并要用户手打「继续」。
// 根因不是撞到 20M，而是**墙钟按总时长计**——本来就要跑 40 分钟的任务必然被 30 分钟砍断一次。
// 闸门本意是「别无限跑」，不是「到点交给用户」，所以改成先自动续、续满才停。
check('墙钟判定：未到点 none / 到点续期 renew / 续满 suspend',
  wallClockDecision({ runWallClockMs: 1000, elapsedMs: 500 }) === 'none'
  && wallClockDecision({ runWallClockMs: 1000, elapsedMs: 1500, renews: 0 }) === 'renew'
  && wallClockDecision({ runWallClockMs: 1000, elapsedMs: 1500, renews: MAX_WALLCLOCK_RENEWS }) === 'suspend');
check('墙钟闸可关闭（runWallClockMs=0 时永不触发）',
  wallClockDecision({ runWallClockMs: 0, elapsedMs: 10 ** 9 }) === 'none');
check('轮次判定：未到 cap none / 到 cap 抬高 cap / 续满 suspend',
  roundCapDecision({ roundsUsed: 5, roundCap: 10 }).action === 'none'
  && roundCapDecision({ roundsUsed: 10, roundCap: 10, renews: 0 }).nextCap === 20
  && roundCapDecision({ roundsUsed: 30, roundCap: 20, renews: MAX_ROUND_RENEWS }).action === 'suspend');
{
  // 端到端：连续有进展的任务撞到墙钟后，应当**先续期再继续**，而不是第一次就挂起。
  // 断言点：trace 里出现 2 条 wall_clock_renew（= 续期次数用满），随后才挂起。
  const traces = [];
  let chatCount = 0;
  const suspends = [];
  await runAgent({
    messages: [{ role: 'user', content: '跑一段长任务' }],
    model: { provider: { id: 1, isGlobal: false, base_url: 'http://local' }, model: { id: 1, model_id: 'm', context_window: 200000 } },
    toolHandlers: {
      chat: async () => {
        chatCount += 1;
        await sleep(3);
        return {
          content: `第 ${chatCount} 步`,
          tool_calls: [{ id: `r${chatCount}`, type: 'function', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
      shell: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    },
    runWallClockMs: 5,
    maxRounds: 40,
    tokenBudget: 0,
    onMessage: () => {},
    onTrace: (e) => traces.push(e),
    onSuspend: (info) => { suspends.push(info); return true; },
  });
  const renews = traces.filter((e) => e.type === 'wall_clock_renew');
  check('墙钟到点先自动续期（不是立刻挂起）',
    renews.length === MAX_WALLCLOCK_RENEWS, `renew=${renews.length} 期望=${MAX_WALLCLOCK_RENEWS}`);
  // 关键判据：续期必须**真的买到时间**。每轮 3ms、闸 5ms ⇒ 若不前移锚点，
  // 第 2 轮就该续、第 4 轮就挂；前移锚点后能跑到第 6 轮。用轮数把这两者分开。
  check('续期真的买到时间（锚点前移，轮数显著多于「不续期」的 4 轮）',
    chatCount >= 5 && suspends.length === 1,
    `chat=${chatCount} suspends=${suspends.length}`);
}

// ── 2026-10-31：撞总上限之前先「交付阶段成果 + 自动续段」 ──
// 用户原话：20M 必然撞，那就别硬断开——先输出已完成/剩余，再自动往下做。
// 段判定是纯函数，先把它三分支钉住，再端到端验证「真的没被打断」。
check('段判定：未到 90% 不动 / 到 90% 交接 / 段数用满交给上层真停',
  segmentDecision({ totalCap: 100, segmentSpent: 50 }) === 'none'
  && segmentDecision({ totalCap: 100, segmentSpent: 90 }) === 'handoff'
  && segmentDecision({ totalCap: 100, segmentSpent: 90, segmentsUsed: MAX_SEGMENTS }) === 'exhausted');
check('段判定：runOpts 可覆盖段数与阈值（B3：不再写死）',
  segmentDecision({ totalCap: 100, segmentSpent: 60, ratio: 0.5 }) === 'handoff'
  && segmentDecision({ totalCap: 100, segmentSpent: 99, maxSegments: 0 }) === 'exhausted'
  && segmentDecision({ totalCap: 100, segmentSpent: 99, ratio: 1 }) === 'none');
check('段判定：未启用总闸（cap=0）时永不交接（不假装有段）',
  segmentDecision({ totalCap: 0, segmentSpent: 10 ** 9 }) === 'none');
{
  const d = buildSegmentDigest({
    segmentNo: 2, maxSegments: MAX_SEGMENTS, rounds: 30, toolCalls: 44, spent: 18_000_000, cap: 20_000_000,
    todos: [{ content: '补安装步骤', status: 'pending' }, { content: '跑测试', status: 'completed' }],
    acceptance: { must: ['a', 'b'], must_not: ['c'] }, missing: 2,
    ledger: [{ name: 'edit_file', args: { path: 'src/a.ts' } }, { name: 'shell', args: { command: 'npm test' } }],
  });
  check('阶段小结：段号 / 额度百分比 / 待办未完成项 / 验收缺口 四类事实齐备',
    d.includes('阶段交接 2/3') && d.includes('90%') && d.includes('补安装步骤') && d.includes('尚缺 2 条'),
    d.split('\n')[0]);
  check('阶段小结：无 AC 时明说「未建立基线」，不编造缺项',
    buildSegmentDigest({ segmentNo: 1, spent: 1, cap: 10, acceptance: null }).includes('未建立验收基线'));
  check('阶段小结：明确告知会「自动进入下一段」，不是让用户手动继续',
    d.includes('自动进入下一段'));
}
{
  // 端到端：cap=60、每轮 15 tokens ⇒ 段内 90% 处交接（54），交接 3 段后第 4 段撞顶才挂起。
  // 关键：交接点之后**没有**出现 total-cap 挂起（说明没被打断），且会话里真的收到 3 条阶段小结。
  const traces = [];
  const msgs = [];
  let suspends = 0;
  let stop = '';
  let rounds = 0;
  await runAgent({
    messages: [{ role: 'user', content: '长任务' }],
    model: { provider: { id: 1, isGlobal: false, base_url: 'http://local' }, model: { id: 1, model_id: 'm', context_window: 200000 } },
    toolHandlers: {
      chat: async () => {
        rounds += 1;
        return {
          content: `第 ${rounds} 步`,
          tool_calls: [{ id: `x${rounds}`, type: 'function', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
      shell: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    },
    totalTokenCap: 60, tokenBudget: 60, // tokenBudget 必须给：总上限判定在预算窗口分支内（budget=0 时那道闸不参与）
    maxRounds: 200, maxTotalRounds: 120, // 抬高轮次预算与上限：本用例验证的是「段交接」，别让轮次闸先响
    onMessage: (m) => { if (m?.role === 'assistant' && String(m.content || '').includes('阶段交接')) msgs.push(m); },
    onTrace: (e) => traces.push(e),
    onSuspend: () => { suspends += 1; return true; },
    onBudget: (s) => { if (s?.stopReason !== undefined) stop = String(s.stopReason || ''); },
    onDone: () => {},
  });
  const handoffs = traces.filter((e) => e.type === 'segment_handoff');
  check('撞顶前先交接：实际发生 MAX_SEGMENTS 次（而不是第一次就停）',
    handoffs.length === MAX_SEGMENTS, `handoff=${handoffs.length}`);
  check('每次交接都落一条「【阶段交接】」消息到会话（用户能看到进展）',
    msgs.length === MAX_SEGMENTS && msgs[0].content.includes('【阶段交接 1/'), `msgs=${msgs.length}`);
  check('段数用满后才真停，且停止原因是 total-cap（有断点可续）',
    suspends === 1, `suspends=${suspends} stop=${stop}`);
  // 注意 spent 是**段内**口径（不是任务累计）：每段都用满同一个 cap 才交接，
  // 所以判断「基线真的前移」要看**轮数递增**——若基线不前移，第二轮立刻又会触发交接。
  check('交接会前移段基线（否则下一次立刻又触发，等于没交接）',
    handoffs.length >= 2 && handoffs[1].rounds > handoffs[0].rounds && handoffs[2].rounds > handoffs[1].rounds,
    handoffs.map((h) => `r${h.rounds}@${h.spent}`).join(' '));
  // 更强的一条：每段用量 15/轮、段上限 60、90% 交接 ⇒ 每段恰好 4 轮才该交接一次。
  // 若基线被写成本段用量（而不是累计），第 2 次之后的间隔会塌缩成 1 轮——这条能抓住。
  check('每段间隔一致（4 轮/段）；间隔塌缩说明基线写错了口径',
    handoffs.length === 3 && handoffs[1].rounds - handoffs[0].rounds === 4 && handoffs[2].rounds - handoffs[1].rounds === 4,
    handoffs.map((h) => `r${h.rounds}`).join(' → '));
}

console.log(`\nwallclock-budget: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
