#!/usr/bin/env node
// 熔断收尾文案回归（2026-10-18）
//
// 背景（用户实测）：任务跑完只看到「单任务 token 预算已用尽（…累计 50097 tokens…）」，
// 于是以为预算是 50k。真实情况是**上下文已到窗口且压不动**（历史里全是必留内容），
// 与「累计花费超预算」是两回事；而且定时任务无人值守，文案还让他「发送继续」——没有人能发。
//
// 判据：把 contextStuck 分支删掉（退回旧文案）、或让 unattended 仍出现「发送继续」、
// 或把窗口压不动说成「预算已用尽」—— 本套件必须变红。
import { buildExhaustedNotice, buildHandoff, runAgent } from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const usage = { prompt_tokens: 48000, completion_tokens: 2097 }; // 用户实测那一次的用量

// ① 上下文压不动 + 无人值守（用户实际场景）
{
  const t = buildExhaustedNotice({ budgetKind: 'tokens', contextStuck: true, unattended: true, usage, tokenRescues: 1 });
  check('说清真实原因：上下文已到模型窗口、压不动',
    /上下文已到模型窗口/.test(t) && /压缩与硬截断/.test(t), t.slice(0, 40));
  check('不再谎称「token 预算已用尽」（用户会被 50k/200k 绕晕）', !/预算已用尽/.test(t));
  check('无人值守不出现「发送继续」（没有人能发）', !/发送「继续」/.test(t));
  check('给出可操作的下一步：分批 / 换窗口更大的模型',
    /分批/.test(t) && /窗口更大的模型/.test(t));
  check('保留累计用量（便于判断是不是真的烧多了）', /50097/.test(t));
  // 2026-10-21 真机事故：contextStuck 分支漏了「任务未完全完成」这个宿主判定标记，
  // 导致 t2/t4 被 workerPool 误判为 done（看板显示完成、实际没有产出）。
  check('上下文压不动必须明示「任务未完全完成」（宿主未完成判定的唯一标记）',
    /任务未完全完成/.test(t), t.slice(0, 120));
}

// ② 同一原因，但有人值守 → 允许提示「继续」
{
  const t = buildExhaustedNotice({ budgetKind: 'tokens', contextStuck: true, unattended: false, usage });
  check('有人值守时保留「继续」这个动作', /「继续」/.test(t));
}

// ③ 真的是预算耗尽（非压不动）+ 无人值守
{
  const t = buildExhaustedNotice({ budgetKind: 'tokens', contextStuck: false, unattended: true, usage, tokenRescues: 2 });
  // 2026-10-30：窗口级预算耗尽改为续期（不再挂起），这条分支只剩「累计撞总上限」一种来源。
  check('总上限分支明说「累计消耗已达防失控总上限」', /累计消耗已达防失控总上限/.test(t));
  check('预算耗尽 + 无人值守：不出现「发送继续」', !/发送「继续」/.test(t));
  check('预算耗尽 + 无人值守：给出缩小范围/调高预算', /缩小任务范围/.test(t));
}

// ④ 墙钟超时
{
  const t = buildExhaustedNotice({ budgetKind: 'rounds', wallClockHit: true, runWallClockMs: 61 * 60 * 1000, usage });
  check('墙钟超时按分钟数说清（不与轮次预算混淆）', /61 分钟/.test(t) && !/轮次预算/.test(t));
}

// ⑤ 轮次预算
{
  const t = buildExhaustedNotice({ budgetKind: 'rounds', unattended: false, usage });
  check('轮次预算耗尽如实说明', /执行轮次预算已用尽/.test(t) && /「继续」/.test(t));
}

// ⑥ 边界
{
  const t = buildExhaustedNotice({});
  check('无参数调用不抛且给出占位文案', typeof t === 'string' && t.length > 0);
  const withText = buildExhaustedNotice({ finalText: '已抓到 12 条', budgetKind: 'tokens', contextStuck: true, unattended: true, usage });
  check('已有部分产出时保留它（不覆盖模型写的正文）', withText.startsWith('已抓到 12 条'));
}

// ⑦ 自动换新窗口续跑（2026-10-18 新增）：交接文本零模型调用、来自台账
{
  const ledger = [
    { name: 'web_search', command: 'AI news 2026-10-18', ok: true },
    { name: 'write_file', paths: ['2026-10-18_news.md'], ok: true },
    { name: 'git_commit', ok: false },
  ];
  const h = buildHandoff({ ledger, roundsUsed: 3, restartNo: 1, maxRestarts: 2 });
  check('交接说明是第几次自动续跑', /第 1\/2 次自动换新窗口/.test(h));
  check('交接带轮数与最近的工具动作（模型据此知道做到哪了）',
    /已执行 3 轮/.test(h) && /write_file/.test(h) && /2026-10-18_news\.md/.test(h));
  check('交接明确告诉模型「不要重做已完成步骤」', /不要重做已完成的步骤/.test(h));
  check('交接自带「自动分批」指令（这正是用户要的：拆活由模型做，不用用户写）',
    /每批不超过 10 条/.test(h) && /立即写入文件/.test(h));
  check('失败的工具动作被标注出来（避免模型以为那步成功了）', /（失败）/.test(h));
  check('台账为空时不炸', buildHandoff({}).length > 0);
  const many = buildHandoff({ ledger: Array.from({ length: 50 }, (_, i) => ({ name: `t${i}` })) });
  check('交接只带最近 20 条（否则新窗口一开始就被塞满）',
    (many.match(/^- t\d+/gm) || []).length === 20, `${(many.match(/^- t\d+/gm) || []).length} 条`);
}
{
  const t = buildExhaustedNotice({ budgetKind: 'tokens', contextStuck: true, unattended: true, usage, autoRestarts: 4 });
  check('续跑额度用尽时如实说「已自动续跑 4 次仍不够」（而不是说压不动）', /已自动换新窗口续跑 4 次/.test(t));
}

console.log(`\nexhausted-notice: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

// ⑧ 真实链路：窗口压不动时**自动换新窗口续跑**（而不是立刻挂起）
{
  const traces = [];
  let doneText = '';
  const model = { provider: { id: 'p', isGlobal: false, base_url: 'https://x' }, model: { model_id: 'tiny', context_window: 800 } };
  const bigUser = '请抓取 100 条新闻并写入文件。'.repeat(200); // ≈ 3000+ chars ≈ 900+ tokens
  await runAgent({
    messages: [{ role: 'user', content: bigUser }],
    model,
    // chat 通道必须挂在 toolHandlers.chat 上（runAgent 的模型调用入口）
    toolHandlers: { chat: async () => ({ content: 'done', tool_calls: [] }) },
    tokenBudget: 0,
    maxRounds: 8,
    unattended: true,
    onMessage: () => {},
    onTrace: (e) => traces.push(e),
    onDone: (t) => { doneText = t; },
  });
  const restarts = traces.filter((e) => e.type === 'auto_restart');
  check('窗口压不动时自动续跑，且有次数上限（不会无限重启）',
    restarts.length === 4, `restarts=${restarts.length}`);
  check('每次续跑都留 trace（可观测，便于事后判断"它偷偷重启了"）',
    restarts.every((e) => typeof e.n === 'number' && e.n >= 1));
  check('续跑额度用尽后如实收尾，不提「发送继续」（无人值守）',
    /自动换新窗口续跑 4 次/.test(doneText) && !/发送「继续」/.test(doneText), doneText.slice(0, 80));
}
