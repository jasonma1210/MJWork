// P2-1 同轮只读工具并发门禁（2026-10-18 全量修复）
//
// 浪费形态：服务端本来就允许一轮返回多个 tool_calls（OpenAI parallel_tool_calls /
//   Anthropic parallel tool use），客户端却逐个 await——3 个 120ms 的 read_file 串成 360ms。
// 本套件锁三条不变量：
//   ① 只读调用可并发（3×120ms 应远低于串行上界 360ms）；
//   ② **tool 消息必须与 tool_calls 严格同序**——顺序错 = 直接 400。
//      这是本修复唯一的真实风险点，故断言落在「消息顺序」而不是「执行顺序」：
//      慢的先发、快的后完成时，消息仍按 a/b/c 落位；
//   ③ 写工具与 mcp__* 一律串行（审批弹卡顺序、外部系统写依赖顺序）；
//      串行可用总耗时 ≥ 各耗时之和证明。
//
// 陷阱（规格 §7）：别断言执行顺序，也别断言并发数——只断言消息顺序与耗时上界。
import {
  runAgent,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'http://local' },
  model: { id: 1, model_id: 'm', context_window: 200000 },
};

// 跑「一轮多工具 + 收尾」：返回 tool 消息的 tool_call_id 顺序、工具阶段墙钟耗时、每个调用的起止
async function runTools(calls, handlers) {
  let rounds = 0;
  const timeline = new Map();
  const toolMsgs = [];
  const wrap = (name, fn) => async (args, ctx) => {
    const id = args?.id || args?.path || name;
    const started = Date.now();
    const out = await fn(args, ctx);
    timeline.set(`${name}:${id}`, { start: started, end: Date.now() });
    return out;
  };
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) return { content: '【已完成】摘要', usage: { prompt_tokens: 20, completion_tokens: 5 } };
      rounds += 1;
      if (rounds === 1) {
        return {
          content: '并行读几个文件',
          tool_calls: calls,
          usage: { prompt_tokens: 60, completion_tokens: 10 },
        };
      }
      return { content: '全部完成', usage: { prompt_tokens: 60, completion_tokens: 10 } };
    },
  };
  for (const [name, fn] of Object.entries(handlers)) toolHandlers[name] = wrap(name, fn);
  const startedAt = Date.now();
  let doneText = null;
  await runAgent({
    messages: [{ role: 'user', content: '同时读几个文件' }],
    model,
    toolHandlers,
    tokenBudget: 0,
    maxRounds: 4,
    onMessage: (m) => { if (m.role === 'tool') toolMsgs.push(m); },
    onDone: (t) => { doneText = t; },
  });
  const entries = [...timeline.values()];
  const toolPhaseMs = entries.length
    ? Math.max(...entries.map((e) => e.end)) - Math.min(...entries.map((e) => e.start))
    : 0;
  return { toolMsgs, toolPhaseMs, totalMs: Date.now() - startedAt, doneText, timeline };
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// ── ① 3×read_file(120ms) + 1×write_file：并发后远低于串行上界 ──
{
  const calls = [
    call('t1', 'read_file', { id: 'a', path: '/tmp/a' }),
    call('t2', 'read_file', { id: 'b', path: '/tmp/b' }),
    call('t3', 'read_file', { id: 'c', path: '/tmp/c' }),
    call('t4', 'write_file', { id: 'w', path: '/tmp/w' }),
  ];
  const r = await runTools(calls, {
    readFile: async () => { await sleep(120); return { content: 'x' }; },
    writeFile: async () => ({ ok: true }),
  });
  const serialBound = 3 * 120; // 360ms
  // 判据用「执行区间相交」而不是「总耗时 < 上界」（2026-10-18 team-lead 口径）：
  // 绝对墙钟**无法区分「没并发」与「机器忙」**——多 agent 并发跑测试时，上界断言会假红。
  // 区间相交才是这条断言真正想表达的性质，且与机器速度无关。
  const a = r.timeline.get('readFile:a');
  const b = r.timeline.get('readFile:b');
  const c = r.timeline.get('readFile:c');
  const overlaps = (x, y) => !!x && !!y && x.start < y.end && y.start < x.end;
  check('3 个只读调用的执行区间两两相交（真并发，与机器负载无关）',
    overlaps(a, b) && overlaps(b, c) && overlaps(a, c),
    `a=${a?.start}-${a?.end} b=${b?.start}-${b?.end} c=${c?.start}-${c?.end}`);
  check(`并发后工具阶段远低于串行上界 ${serialBound}ms（参考值，非判据）`,
    r.toolPhaseMs > 0 && r.toolPhaseMs < serialBound, `toolPhase=${r.toolPhaseMs}ms`);
  check('只读并发不改消息条数（4 条 tool 消息）', r.toolMsgs.length === 4, `msgs=${r.toolMsgs.length}`);
  check('消息顺序 === tool_calls 顺序（t1,t2,t3,t4）',
    r.toolMsgs.map((m) => m.tool_call_id).join(',') === 't1,t2,t3,t4',
    r.toolMsgs.map((m) => m.tool_call_id).join(','));
  check('并发轮正常收尾', r.doneText === '全部完成', String(r.doneText).slice(0, 20));
}

// ── ② 慢的先发：消息顺序仍按 tool_calls，不按完成顺序（400 的唯一来源）──
{
  const calls = [
    call('c1', 'read_file', { id: 'a', path: '/tmp/a' }),
    call('c2', 'read_file', { id: 'b', path: '/tmp/b' }),
    call('c3', 'read_file', { id: 'c', path: '/tmp/c' }),
  ];
  const r = await runTools(calls, {
    readFile: async (args) => {
      await sleep(args?.id === 'a' ? 150 : 10); // a 最慢，b/c 先完成
      return { content: args?.id };
    },
  });
  const order = r.toolMsgs.map((m) => m.tool_call_id).join(',');
  check('最慢的先发时，tool 消息仍按 tool_calls 顺序落位（c1,c2,c3）', order === 'c1,c2,c3', order);
  // 交叉验证「确实是并发而非碰巧串行」：串行时 b 只能在 a 结束后才开始 → 区间不相交。
  const a = r.timeline.get('readFile:a');
  const b = r.timeline.get('readFile:b');
  const overlaps = !!a && !!b && a.start < b.end && b.start < a.end;
  check('慢调用与快调用区间相交（并发生效；串行时二者必然不相交）', overlaps,
    `a=${a?.start}-${a?.end} b=${b?.start}-${b?.end}`);
}

// ── ③ 写工具串行：两个 80ms 的 write_file 总耗时 ≥160ms ──
{
  const calls = [call('w1', 'write_file', { id: 'p', path: '/tmp/p' }), call('w2', 'write_file', { id: 'q', path: '/tmp/q' })];
  const r = await runTools(calls, {
    writeFile: async () => { await sleep(80); return { ok: true }; },
  });
  check('两个 write_file 串行执行（总耗时 ≥ 160ms）', r.toolPhaseMs >= 160, `toolPhase=${r.toolPhaseMs}ms`);
  check('串行组消息顺序仍按 tool_calls（w1,w2）',
    r.toolMsgs.map((m) => m.tool_call_id).join(',') === 'w1,w2', r.toolMsgs.map((m) => m.tool_call_id).join(','));
}

// ── ④ mcp__* 不进并发批：两个 80ms 的 MCP 调用总耗时 ≥160ms ──
{
  const mcpTools = [
    { type: 'function', function: { name: 'mcp__demo__a', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'mcp__demo__b', parameters: { type: 'object', properties: {} } } },
  ];
  let rounds = 0;
  const stamps = [];
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) return { content: '【已完成】摘要', usage: { prompt_tokens: 20, completion_tokens: 5 } };
      rounds += 1;
      if (rounds === 1) {
        return {
          content: '调两个外部工具',
          tool_calls: [call('m1', 'mcp__demo__a', {}), call('m2', 'mcp__demo__b', {})],
          usage: { prompt_tokens: 60, completion_tokens: 10 },
        };
      }
      return { content: '完成', usage: { prompt_tokens: 60, completion_tokens: 10 } };
    },
    mcpCallTool: async () => {
      stamps.push({ start: Date.now() });
      await sleep(80);
      stamps.push({ end: Date.now() });
      return { ok: true };
    },
  };
  await runAgent({
    messages: [{ role: 'user', content: '调外部工具' }],
    model, mcpTools, toolHandlers, tokenBudget: 0, maxRounds: 4,
    onMessage: () => {},
  });
  const total = stamps.length >= 4 ? stamps[3].end - stamps[0].start : 0;
  check(`两个 mcp__* 调用串行（总耗时 ${total}ms ≥ 160ms，不进并发批）`, total >= 160, `total=${total}ms`);
}

console.log(`\nparallel-readonly-tools: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
