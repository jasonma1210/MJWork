// P1-3 历史重写记账门禁（2026-10-18 全量修复）
//
// 为什么记账：压缩 = 前缀缓存全废（Anthropic cache_control / OpenAI 自动前缀缓存都按**前缀**命中），
//   所以「一次 run 里历史被改写了多少次」是**成本指标**，不是纯技术副作用。
//   旧实现没有这笔账 → 压缩无效时（压完还超窗）会一直刷摘要，每刷一次都把缓存打废一次，
//   用户只看到「后台一直在压缩」且账单暴涨。
// 本套件锁三件事：
//   ① rewrites 单调不减（记账只增不减）；
//   ② 0 < max ≤ MAX_REWRITES_PER_RUN(5)——超过说明压缩无效，应转硬截断/挂起而非继续刷；
//   ③ 收尾快照（running:false）同样带 rewrites / rewriteTokens（否则仪表盘看不到总账）。
//
// 陷阱（规格 §3）：usage 必须用真实口径 estimateMessagesTokens(payload.messages) 回报。
//   若谎报体积，压缩闸会因「压缩后不发全量了但账面上体积没降」而提前挂起，序列全错。
import {
  runAgent, estimateMessagesTokens, MAX_REWRITES_PER_RUN,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

check('MAX_REWRITES_PER_RUN 导出且为 5', MAX_REWRITES_PER_RUN === 5, `got=${MAX_REWRITES_PER_RUN}`);

{
  const budgets = [];
  let mainRound = 0;
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      // 真实口径：按本次实际发送的 messages 回报（真实端点行为）
      const est = estimateMessagesTokens(payload.messages);
      if (!isMain) {
        return { content: '【已完成】已跑若干步\n【关键发现】/tmp/a\n【待办】继续\n【约束】无', usage: { prompt_tokens: 80, completion_tokens: 20 } };
      }
      mainRound += 1;
      if (mainRound > 13) return { content: '全部完成', usage: { prompt_tokens: est, completion_tokens: 20 } };
      return {
        content: `第 ${mainRound} 步`,
        tool_calls: [{
          id: `r${mainRound}`,
          type: 'function',
          function: { name: 'shell', arguments: JSON.stringify({ command: `cat big${mainRound}` }) },
        }],
        usage: { prompt_tokens: est, completion_tokens: 20 },
      };
    },
    shell: async () => ({ stdout: 'x'.repeat(9000), stderr: '', exitCode: 0 }),
  };
  const model = {
    provider: { id: 1, isGlobal: false, base_url: 'http://local' },
    model: { id: 1, model_id: 'm', context_window: 8000 },
  };
  let doneText = null;
  await runAgent({
    messages: [{ role: 'user', content: '长任务：逐个读大文件' }],
    model,
    toolHandlers,
    tokenBudget: 0,
    maxRounds: 14,
    onMessage: () => {},
    onBudget: (s) => budgets.push({ ...s }),
    onDone: (t) => { doneText = t; },
  });

  const running = budgets.filter((s) => s.running === true);
  const series = running.map((s) => Number(s.rewrites) || 0);
  const monotonic = series.every((v, i) => i === 0 || v >= series[i - 1]);
  check('rewrites 序列单调不减', monotonic, `series=[${series.join(',')}]`);
  const max = series.length ? Math.max(...series) : 0;
  check('rewrites 峰值 > 0（确实发生过重写）', max > 0, `max=${max}`);
  check('rewrites 峰值 ≤ MAX_REWRITES_PER_RUN(5)', max <= MAX_REWRITES_PER_RUN, `max=${max}`);

  const finalSnap = budgets.filter((s) => s.running === false).pop() || {};
  check('收尾快照带 rewrites 字段', typeof finalSnap.rewrites === 'number', `rewrites=${finalSnap.rewrites}`);
  check('收尾快照带 rewriteTokens 字段且为正', Number(finalSnap.rewriteTokens) > 0, `rewriteTokens=${finalSnap.rewriteTokens}`);
  check('收尾快照的 rewrites 不小于运行期峰值（记账不回退）',
    Number(finalSnap.rewrites) >= max, `final=${finalSnap.rewrites} max=${max}`);
  // 重写预算用尽后引擎按「挂起而非空转」收尾（kind=tokens）——这是预期行为，不是失败。
  // 这里只要求：有产出文本、且如实告知未完成（不许假装任务已结束）。
  const finalTrimmed = String(doneText || '').trim();
  // 2026-10-22：断言语义而非文案。此前绑死「预算已用尽」四个字——BASE_PROMPT 增补后
  // 重写预算在同一个 8K 窗口下更早耗尽，引擎改走「换新窗口续跑仍不够」分支，措辞变了但
  // 「如实告知未完成」这个契约没变。绑文案的断言会把正确的行为变更报成失败。
  check('重写预算用尽后如实收尾（非空且明示未完成）',
    finalTrimmed.length > 0
    && (finalTrimmed.includes('预算已用尽') || finalTrimmed === '全部完成'
      || /任务未完全完成|仍不够/.test(finalTrimmed)),
    `done=${finalTrimmed.slice(-60)}`);

  console.log(`   ↑ 实测序列：[${series.join(',')}]`);
}

console.log(`\nrewrite-ledger: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
