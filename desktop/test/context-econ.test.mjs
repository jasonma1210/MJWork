// 上下文经济学回归门禁（2026-10-17 实施轮）
// 背景（真机审计）：同一段上下文被反复全价重算，症状是 10k↔220k 抖动与「停止后仍在烧 token」。
// 本套件锁住三条实现事实：
//   ① 估算器必须计入 tool_calls.arguments（write_file/apply_patch 的正文全在那里）；
//   ② 压缩结果必须回写 convo（否则下一轮又发全量）；
//   ③ 入口裁剪 trimHistoryForRun：必留 system + 用户原始需求、不产生孤儿 tool 消息、裁到目标内。
import {
  runAgent, trimHistoryForRun, compactHistory, estimateMessagesTokens, estimateTokens,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const model = (contextWindow) => ({
  provider: { id: 1, isGlobal: false, base_url: 'https://api.deepseek.com/v1' },
  model: { id: 1, model_id: 'deepseek-chat', context_window: contextWindow },
});

// ── ① 估算器必须计入 tool_calls.arguments ──
// 旧实现只统计 content：thread 138 的 write_file 正文 161,440 字符被整段忽略，
// 同一历史估 70,894 / 实际 217,238（低估 3.06 倍）→ 压缩阈值永不触发。
{
  const args = JSON.stringify({ path: '/tmp/a.js', content: 'x'.repeat(20000) });
  const msg = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: args } }],
  };
  const est = estimateMessagesTokens([msg]);
  check('估算计入 tool_calls.arguments（20,000 字符 → ≥5000 tokens）', est >= 5000, `est=${est}`);
  // 基准改为 arguments 字符数本身（不留余量）：est 必须 ≥ ceil(len/4)，否则换更短的工具名会逼近阈值
  check('估算 ≥ arguments 字符数/4（不再退化为常数 ~6）',
    est >= Math.ceil(args.length / 4), `est=${est} args=${args.length}`);
  // 纯文本消息口径不变（回归：不要把 content 口径改坏）
  check('纯文本消息估算不变（1000 ASCII ≈ 250）',
    estimateMessagesTokens([{ role: 'user', content: 'y'.repeat(1000) }]) === estimateTokens('y'.repeat(1000)) + 4);
}

// ── ② 压缩结果回写 convo：压缩后不得又涨回全量 ──
// 复现方式：假 provider 按「实际发出去的消息」回报 prompt_tokens（真实端点行为），
// 于是 knownTokens 口径与 outbound 一致。未回写时：压缩轮发 10k → 下一轮按 10k 判阈值
// → 跳过压缩 → 又发全量 20k+（10k↔220k 抖动）；回写后 convo 已被替换，不再回涨。
const BIG_ARG_CHARS = 12000; // ≈3000 tokens/轮（assistant.arguments）
const CONTEXT_WINDOW = 24000;
{
  // 注意：必须**在调用时刻**快照体积——未压缩轮次的 outbound 与 convo 是同一个数组引用，
  // 轮后 push 会把它一起改大，事后测量会把所有历史读数都算成最终值（假绿/假红都出现过）。
  const calls = [];
  let round = 0;
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      const est = estimateMessagesTokens(payload.messages);
      calls.push({ isMain, est });
      // 压缩摘要请求：无 tools、单条 user 消息
      if (!isMain) {
        return { content: `【已完成】摘要占位\n【待办】继续写文件\n${'摘要内容'.repeat(40)}`, usage: { prompt_tokens: 120, completion_tokens: 60 } };
      }
      round += 1;
      if (round > 12) return { content: '全部完成', usage: { prompt_tokens: 100, completion_tokens: 40 } };
      return {
        content: `第 ${round} 步：写入大文件`,
        tool_calls: [{
          id: `c${round}`,
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: `/tmp/big${round}.js`, content: 'x'.repeat(BIG_ARG_CHARS) }) },
        }],
        // 真实端点按「本次实际发送的 messages」回报 prompt_tokens
        usage: { prompt_tokens: est, completion_tokens: 40 },
      };
    },
    writeFile: async () => ({ ok: true }),
  };
  await runAgent({
    messages: [{ role: 'user', content: '把大文件逐个写出来' }],
    model: model(CONTEXT_WINDOW),
    toolHandlers,
    tokenBudget: 0, // 关掉 token 预算闸，只验证上下文压缩路径
    maxRounds: 14,
    onMessage: () => {},
    onDone: () => {},
  });

  const mainCalls = calls.filter((c) => c.isMain);
  const summaryIdx = calls.findIndex((c) => !c.isMain);
  check('本轮确实触发了上下文压缩（存在摘要请求）', summaryIdx > 0, `summaryIdx=${summaryIdx} calls=${calls.length}`);

  // calls 下标切分：摘要之前 / 之后的主请求体积序列
  const before = [];
  const after = [];
  calls.forEach((c, i) => {
    if (!c.isMain) return;
    (i < summaryIdx ? before : after).push(c.est);
  });
  const preMax = Math.max(...before, 0);
  check('压缩当轮体积明显下降', after.length > 0 && after[0] < preMax * 0.85,
    `after0=${after[0]} preMax=${preMax}`);
  // 关键判别：压缩后的**下一轮**若仍按全量发送（未回写），体积会直接弹回并超过压缩前
  check('压缩后下一轮不再发全量（压缩结果已回写 convo）', after.length > 1 && after[1] < preMax,
    `after1=${after[1]} preMax=${preMax}`);
  check('压缩后不再出现 10k↔220k 抖动（所有轮次 ≤ 压缩前峰值 1.05 倍）',
    after.every((s) => s <= preMax * 1.05), `afterMax=${Math.max(...after)} preMax=${preMax}`);
  check('压缩后仍继续推进（不是一次压缩就结束运行）', mainCalls.length >= 3, `主请求 ${mainCalls.length} 次`);
}

// ── ③④⑤⑥ 入口裁剪 trimHistoryForRun ──
// 构造：system + 用户原始需求 + 若干工具轮（每轮 assistant(tool_calls)+tool，正文较大）
function buildLongConvo(rounds = 30) {
  const convo = [
    { role: 'system', content: 'SYSTEM-PROMPT 你是 MJ Coder' },
    { role: 'user', content: 'USER-RAW-REQUEST 把整个仓库审查一遍并给出修复方案' },
  ];
  for (let i = 0; i < rounds; i += 1) {
    convo.push({
      role: 'assistant',
      content: `第 ${i} 步`,
      tool_calls: [{
        id: `t${i}`, type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: `/tmp/f${i}.js`, content: 'z'.repeat(2000) }) },
      }],
    });
    convo.push({ role: 'tool', tool_call_id: `t${i}`, content: `写入完成 ${i}` });
  }
  return convo;
}
{
  const convo = buildLongConvo(30);
  const before = estimateMessagesTokens(convo);
  const r = trimHistoryForRun(convo, { contextWindow: CONTEXT_WINDOW });
  const budget = Math.floor(CONTEXT_WINDOW * 0.45);
  check('超阈值时确实裁剪（trimmed=true 且 dropped>0）', r.trimmed === true && r.dropped > 0,
    `trimmed=${r.trimmed} dropped=${r.dropped} before=${before} after=${r.afterTokens}`);
  check('保留 system 在首位', r.convo[0]?.role === 'system' && String(r.convo[0].content).includes('SYSTEM-PROMPT'));
  check('保留首条用户原始需求', r.convo.some((m) => m.role === 'user' && String(m.content).includes('USER-RAW-REQUEST')));
  check('裁剪结果无孤儿 tool 消息（组首不得是 tool）',
    (() => {
      const answered = new Set();
      for (const m of r.convo) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) answered.add(tc.id);
        if (m.role === 'tool' && !answered.has(m.tool_call_id)) return false;
      }
      return true;
    })());
  check('裁剪后估算 ≤ 目标预算', r.afterTokens <= budget, `after=${r.afterTokens} budget=${budget}`);
  check('裁剪结果带占位说明（引导重新读取而非凭记忆）',
    r.convo.some((m) => m.role === 'system' && String(m.content).includes('历史已裁剪') && String(m.content).includes('read_file')));
  check('未超阈值时原样返回（同一引用 + trimmed=false）', (() => {
    const small = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '短问题' },
      { role: 'assistant', content: '短回答' },
    ];
    const out = trimHistoryForRun(small, { contextWindow: CONTEXT_WINDOW });
    return out.trimmed === false && out.convo === small && out.dropped === 0;
  })());
  // 下限 16000 是刻意的：5 轮 ≈ 2.6k tokens 超过 1000*0.45(450) 但远低于 16000*0.45(7200)
  // ⇒ 必须不裁（否则单测里 1000~1300 的小窗口永远先被入口裁剪抢跑，压缩路径测不到）
  check('小窗口不被入口裁剪抢跑（下限 16000）', (() => {
    const mid = buildLongConvo(5);
    const out = trimHistoryForRun(mid, { contextWindow: 1000 });
    return out.trimmed === false && out.convo === mid;
  })());
}

// ── 前导 system 全保留（渲染层会把专家角色提示作为一条 role=system 插在 messages 首位）──
// 回归场景：旧实现只保留 convo[0]，convo[1] 的专家 system 被静默丢弃 → 角色/技能约束全线失效。
{
  const convo = [
    { role: 'system', content: 'SYSTEM-PROMPT 基础提示' },
    { role: 'system', content: 'EXPERT-PROMPT 专家角色：代码审查员，只做只读分析' },
    { role: 'user', content: 'USER-RAW-REQUEST 原始需求：审查这个仓库' },
    ...buildLongConvo(20).slice(2),
  ];
  const r = trimHistoryForRun(convo, { contextWindow: 20000 });
  check('多前导 system 时仍触发裁剪', r.trimmed === true && r.dropped > 0,
    `trimmed=${r.trimmed} dropped=${r.dropped} before=${r.beforeTokens} after=${r.afterTokens}`);
  check('前两条仍是 system 且专家提示未丢',
    r.convo[0]?.role === 'system' && r.convo[1]?.role === 'system'
    && String(r.convo[1].content).includes('EXPERT-PROMPT'),
    `roles=${r.convo.slice(0, 3).map((m) => m.role).join(',')}`);
  // 占位（`[历史已裁剪]`）恒放在前导 system 块内、首条 user 之前（system 块必须连续）：
  // 部分 OpenAI 兼容端点（DeepSeek 系）只认首部 system，messages 中部出现 system 会被忽略甚至报错。
  // 因此索引是固定的 [sys, sys(expert), sys(占位), user, ...]：用固定下标钉住
  // 「system 块连续 + user 紧随其后」这个不变量，不要放宽成 some(...)。
  check('占位之后仍是用户原始需求（保持 system 块连续）', r.convo[3]?.role === 'user' && String(r.convo[3].content).includes('USER-RAW-REQUEST'),
    `roles=${r.convo.slice(0, 5).map((m) => m.role).join(',')}`);
  check('占位文案出现在 system 消息里',
    r.convo.some((m) => m.role === 'system' && String(m.content).includes('[历史已裁剪]')));
  check('多前导 system 场景下仍无孤儿 tool 消息', (() => {
    const answered = new Set();
    for (const m of r.convo) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) answered.add(tc.id);
      if (m.role === 'tool' && !answered.has(m.tool_call_id)) return false;
    }
    return true;
  })());
}

// ── 压缩路径同样不得丢固定头（C2 回写后丢一次就永久丢）──
// 事故形态：compactHistory 只保留 convo[0]，压缩结果回写 convo 后「专家 system + 用户原始需求」
// 在后续每一轮都消失（探针实测 7/15 轮缺原始需求）。这里直接打压缩路径。
{
  const convo = [
    { role: 'system', content: 'SYSTEM-PROMPT 基础提示' },
    { role: 'system', content: 'EXPERT-PROMPT 专家角色：expert-auditor' },
    { role: 'user', content: 'USER-RAW-REQUEST 原始需求：审查这个仓库' },
    ...buildLongConvo(20).slice(2),
  ];
  // context_window 12000：该历史 ≈10.6k tokens > 70%(8400) → 真触发压缩（不改数据构造，只调窗口）
  const out = await compactHistory(convo, model(12000), async () => ({ content: '压缩摘要内容 ABCD' }));
  const firstNonSystem = out.findIndex((m) => m.role !== 'system');
  check('compactHistory 确实压缩了（消息数下降）', out.length < convo.length, `len=${out.length} < ${convo.length}`);
  check('compactHistory 保留全部前导 system（专家提示不丢）',
    out[0]?.role === 'system' && out[1]?.role === 'system' && String(out[1].content).includes('EXPERT-PROMPT'),
    `roles=${out.slice(0, 4).map((m) => m.role).join(',')}`);
  check('compactHistory 保留用户原始需求且紧跟前导 system 之后',
    firstNonSystem > 0 && String(out[firstNonSystem].content).includes('USER-RAW-REQUEST'));
  check('compactHistory 的摘要也在前导 system 块内（无中部 system）',
    out.slice(0, firstNonSystem).some((m) => String(m.content).includes('压缩摘要内容'))
    && out.slice(0, firstNonSystem).every((m) => m.role === 'system'));
  check('compactHistory 输出无孤儿 tool 消息', (() => {
    const answered = new Set();
    for (const m of out) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) answered.add(tc.id);
      if (m.role === 'tool' && !answered.has(m.tool_call_id)) return false;
    }
    return true;
  })());
}

// ── G2：头部摘要不得无界累积（紧窗口 + 长任务）──
// 事故背景：F1 把每次摘要都塞进前导 system 块后，旧摘要既不合并也不淘汰 —— 6k 窗口 41 轮实测
// head 涨到 37 条、摘要调用 35 次、末轮上下文 4.56 倍窗口（比修复前更贵）。
// 修法是滚动摘要（旧摘要并进本次摘要输入、产出后只留一条）+ 「无收益即放弃」闸。
{
  const WINDOW = 6000;
  const calls = [];
  let round = 0;
  const handlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      const est = estimateMessagesTokens(payload.messages);
      const headSummaries = payload.messages
        .filter((m) => m.role === 'system' && String(m.content).startsWith('[早期对话摘要')).length;
      calls.push({ isMain, est, headSummaries });
      if (!isMain) {
        return { content: '【已完成】摘要占位\n【待办】继续', usage: { prompt_tokens: 50, completion_tokens: 20 } };
      }
      round += 1;
      if (round > 40) return { content: '全部完成', usage: { prompt_tokens: 50, completion_tokens: 20 } };
      return {
        content: `第 ${round} 步`,
        tool_calls: [{
          id: `h${round}`,
          type: 'function',
          function: { name: 'shell', arguments: JSON.stringify({ command: `echo ${'a'.repeat(2000)}` }) },
        }],
        usage: { prompt_tokens: est, completion_tokens: 20 },
      };
    },
    shell: async () => ({ stdout: 'b'.repeat(3000), stderr: '', exitCode: 0 }),
  };
  await runAgent({
    messages: [{ role: 'user', content: '长任务：逐个处理' }],
    model: model(WINDOW), toolHandlers: handlers, tokenBudget: 0,
    maxRounds: 42, onMessage: () => {}, onDone: () => {},
  });
  const mains = calls.filter((c) => c.isMain);
  const sumCalls = calls.filter((c) => !c.isMain);
  const last = mains[mains.length - 1];
  check('紧窗口长任务不发散（末轮 ≤ 1.5× 窗口）', !!last && last.est <= WINDOW * 1.5,
    `last=${last?.est} window=${WINDOW}`);
  check('头部摘要有界（≤2 条，滚动摘要已合并旧摘要）', !!last && last.headSummaries <= 2,
    `head=${last?.headSummaries}`);
  // 次数不是正确指标：6k 窗口下每轮都会越过 70%，压缩频繁是「守住窗口」的必然代价。
  // 要守的是**成本占比**——单次摘要只喂有界 transcript，所以次数多也不该吃掉大头。
  const sumMain = mains.reduce((s, c) => s + c.est, 0);
  const sumSummary = sumCalls.reduce((s, c) => s + c.est, 0);
  check('摘要开销占比 ≤15%（次数可多，成本必须小）',
    sumMain > 0 && sumSummary <= sumMain * 0.15,
    `summary=${sumSummary} main=${sumMain} ratio=${(sumSummary / sumMain * 100).toFixed(1)}%`);
  check('压缩次数不超过轮数（不出现一次运行内重复压缩同一段）',
    sumCalls.length <= mains.length, `summaries=${sumCalls.length} mains=${mains.length}`);
}

// ── G3：触发只看体积，不被「条数 ≤ 8」门槛挡住 ──
// 旧实现 `if (... || convo.length <= 8) return convo`：8 条消息但已 7.5k tokens（窗口 8k 的 94%）
// 也不压缩——形如「/compact 压平后」或「早期一轮产生超大工具结果」的会话会一直顶在窗口边缘。
{
  const model8k = (w) => ({ provider: { id: 1, is_base: false, base_url: 'http://x' }, model: { model_id: 'm', context_window: w } });
  const convo = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '需求' },
    { role: 'assistant', content: 'y'.repeat(30000) }, // 单轮超大输出
    { role: 'user', content: '继续0' },
    { role: 'assistant', content: 'ok1' },
    { role: 'user', content: '继续1' },
    { role: 'assistant', content: 'ok2' },
    { role: 'user', content: '继续2' },
  ];
  const before = estimateMessagesTokens(convo);
  let calls = 0;
  const out = await compactHistory(convo, model8k(8000), async () => {
    calls += 1;
    return { content: '【已完成】摘要占位', usage: { prompt_tokens: 10, completion_tokens: 5 } };
  });
  const after = estimateMessagesTokens(out);
  check('8 条消息但体积超阈值时仍压缩（不再被条数门槛挡住）',
    calls === 1 && after < before * 0.6, `calls=${calls} before=${before} after=${after}`);
  check('压缩后仍保留 system 与用户原始需求', out[0]?.role === 'system'
    && out.some((m) => m.role === 'user' && String(m.content).includes('需求')));
}

// ── 闸门语义（2026-10-17 事故回归）──
// 用户实测「取 10 条最新新闻」：5 轮累计 143k（每轮重发 ~27k 上下文），旧逻辑拿累计花费
// 判「上下文过长」，把 27k 上下文 force 压成 376 tokens 摘要 → 新闻原文丢失 → 模型重搜 →
// 再撞闸再压，表现为「后台一直在压缩、还没有任何输出」。压缩看体积，暂停才看花费。
{
  const { budgetDecision } = await import('../agent-core/index.js');
  check('事故场景（27k 上下文 / 143k 累计 / 200k 预算）只换窗口、不压缩',
    budgetDecision({ ctxEst: 27071, ctxWindow: 128000, spent: 143923, budget: 200000, rescues: 0 }) === 'new-window',
    '小上下文被压缩 → 会把模型还需要的内容压成摘要，逼它重搜');
  check('预算压力 + 上下文够大（≥ 窗口 35%）才值得压缩',
    budgetDecision({ ctxEst: 60000, ctxWindow: 128000, spent: 143923, budget: 200000, rescues: 0 }) === 'compact');
  check('上下文真的接近窗口上限才压缩',
    budgetDecision({ ctxEst: 100000, ctxWindow: 128000, spent: 1000, budget: 200000, rescues: 0 }) === 'compact');
  check('压缩救援用尽且上下文仍过大 → 暂停（不再无限压缩）',
    budgetDecision({ ctxEst: 100000, ctxWindow: 128000, spent: 1000, budget: 200000, rescues: 3 }) === 'suspend-context');
  // 2026-10-30 语义变更：窗口级预算耗尽不再挂起（'suspend-tokens'），改为续期（'renew'）。
  // 理由：长途任务必然多次撞窗口级预算（每轮重发上下文），把它当终点等于把任务废在半路；
  // 真正的终点只剩「累计消耗撞到 TASK_TOTAL_TOKEN_CAP」。两条分支都要锁，缺一条就会
  // 让「续期」悄悄退化成「无限跑」或「又变回挂起」。
  check('救援用尽且窗口预算耗尽 → 续期（不再中途停任务）',
    budgetDecision({ ctxEst: 27071, ctxWindow: 128000, spent: 210000, budget: 200000, rescues: 3 }) === 'renew');
  check('救援用尽 + 窗口预算耗尽 + 累计撞总上限 → 才真停',
    budgetDecision({ ctxEst: 27071, ctxWindow: 128000, spent: 210000, budget: 200000, rescues: 3, totalSpent: 20_000_000, totalCap: 20_000_000 }) === 'suspend-tokens',
    '总上限没生效 → 跑飞的任务能无限续期，烧穿额度');
  check('未传总上限（旧调用方）时按不设限处理，只续期不挂起',
    budgetDecision({ ctxEst: 27071, ctxWindow: 128000, spent: 210000, budget: 200000, rescues: 3, totalSpent: 9e9 }) === 'renew');
  check('预算为 0 视为不设限，但体积闸仍生效',
    budgetDecision({ ctxEst: 27071, ctxWindow: 128000, spent: 9e9, budget: 0, rescues: 0 }) === 'ok'
    && budgetDecision({ ctxEst: 100000, ctxWindow: 128000, spent: 0, budget: 0, rescues: 0 }) === 'compact');
  // P1-1 回归（2026-10-18 第二轮审查）：窗口校准**只能在调用方做一次**。
  // 旧实现 budgetDecision 内部又对「已抬高的 ctxWindow」用同一个 lastPromptTokens
  // 反推一遍：declared=32768 → 上游抬到 131072 → 内部算成 285715（≈8.7×），
  // 0.7×285715≈200000 恰好不过线 → 返回 'ok'，压力闸永久失敏。
  check('已抬高的窗口不得被二次反推绕过 4× 封顶',
    budgetDecision({ ctxEst: 200000, ctxWindow: 131072, lastPromptTokens: 200000, budget: 0, rescues: 0 }) === 'compact',
    '旧实现：二次反推后 win≈285715 → 误判 ok（闸门失敏）');
  check('窗口校准不影响未传 lastPromptTokens 的既有调用',
    budgetDecision({ ctxEst: 200000, ctxWindow: 131072, budget: 0, rescues: 0 }) === 'compact');
}

// ── 窗口口径单点：压缩器必须接收调用方给定的有效窗口，不许自己反推（第三轮审查 P1）──
// 缺陷形态（实测）：声明 32768 的模型被证伪抬到 131072 后，压缩成功会把 lastPromptTokens 清成 null；
// 下一轮 pre-call 压缩拿不到 knownTokens，只能反推回**声明值 32768** →
// 闸门认为 90k 没事，压缩器认为 90k 是 2.7 倍超标并进 aggressive 档（尾部只留 15%），
// 刚读过的文件内容被抹掉 → 重读 → 再压。这里锁死「同一次运行内窗口只有一个真值」。
{
  const convo = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'USER 原始需求' },
    ...buildLongConvo(20).slice(2),
  ];
  let calls = 0;
  const chatFn = async () => { calls += 1; return { content: '摘要' }; };
  const est = estimateMessagesTokens(convo);
  // 90k 量级的历史 + 已抬高的 131072 窗口：0.7×131072=91750 > est ⇒ 不该压
  await compactHistory(convo, model(32768), chatFn, { knownTokens: est, window: 131072 });
  check('给定有效窗口时压缩器按它判定（不再反推回声明值）', calls === 0, `chat 调用 ${calls} 次`);
  // 反证：不传 window 时，est 会被反推成 est*1.2（上限 declared*4），阈值更低 ⇒ 仍然不压？
  // 用更接近阈值的量说明两者判别不同：这里只断言「传 window 的行为是早期返回」，
  // 否则这条用例会与「压缩器该压就压」的既有用例互相矛盾。
  const small = model(32768);
  let calls2 = 0;
  await compactHistory(convo, small, async () => { calls2 += 1; return { content: '摘要' }; },
    { knownTokens: est, window: 4096 });
  check('给定更小窗口时仍然压缩（window 是生效参数，不是被忽略的摆设）', calls2 === 1, `chat 调用 ${calls2} 次`);
}

console.log(`\ncontext-econ: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);