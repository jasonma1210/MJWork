// Agent 引擎测试：中间消息持久化 / cwd 注入 / usage 归属 / abort / 上下文压缩
import { runAgent } from '../renderer/src/lib/agent.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const shellCalls = [];
const gitStatusCalls = [];
let chatScript = [];
let chatCalls = [];

globalThis.window = {
  mjcode: {
    chat: async (payload) => {
      chatCalls.push(payload);
      const next = chatScript.shift();
      return next || { content: '（默认回复）', usage: { prompt_tokens: 5, completion_tokens: 3 } };
    },
    shell: async (args) => { shellCalls.push(args); return { stdout: 'shell-ok', stderr: '', exitCode: 0 }; },
    gitStatus: async (args) => { gitStatusCalls.push(args); return { stdout: ' M a.js' }; },
    readFile: async () => ({ content: 'file' }),
    writeFile: async () => ({ ok: true }),
    editFile: async () => ({ ok: true }),
    applyPatch: async () => ({ stdout: 'patched' }),
    listDir: async () => [],
    grep: async () => ({ matches: '' }),
    glob: async () => ({ files: [] }),
    gitDiff: async () => ({ stdout: 'diff' }),
    gitLog: async () => ({ stdout: 'abc123 init' }),
    gitCommit: async () => ({ stdout: 'committed' }),
    mcpCallTool: async () => ({ content: [] }),
  },
};

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.deepseek.com/v1' },
  model: { id: 1, model_id: 'deepseek-chat', context_window: 128000 },
};

function reset() { chatScript = []; chatCalls = []; shellCalls.length = 0; gitStatusCalls.length = 0; }

(async () => {
  // ── 测试 1：多轮工具循环的持久化顺序 + cwd + usage ──
  reset();
  chatScript = [
    { content: '先看下状态', tool_calls: [{ id: 'call_1', function: { name: 'git_status', arguments: '{}' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    { content: '再跑个命令', tool_calls: [{ id: 'call_2', function: { name: 'shell', arguments: '{"command":"ls"}' } }], usage: { prompt_tokens: 150, completion_tokens: 25 } },
    { content: '全部完成', usage: { prompt_tokens: 200, completion_tokens: 30 } },
  ];
  const emitted = [];
  let doneArgs = null;
  await runAgent({
    messages: [{ role: 'user', content: '看看仓库' }],
    model,
    cwd: '/tmp/project',
    onMessage: (m) => emitted.push(m),
    onDone: (text, usage, aborted) => { doneArgs = { text, usage, aborted }; },
  });
  const roles = emitted.map((m) => m.role);
  check('持久化顺序 = assistant(tool_calls) → tool → assistant(tool_calls) → tool',
    JSON.stringify(roles) === JSON.stringify(['assistant', 'tool', 'assistant', 'tool']), roles.join(','));
  check('中间 assistant 消息携带 tool_calls', emitted[0].tool_calls?.[0]?.id === 'call_1' && emitted[2].tool_calls?.[0]?.id === 'call_2');
  check('tool 消息携带 tool_call_id 与结果', emitted[1].tool_call_id === 'call_1' && emitted[1].content.includes('shell-ok') === false && emitted[3].tool_call_id === 'call_2');
  check('git_status 自动注入 cwd', gitStatusCalls.length === 1 && gitStatusCalls[0].cwd === '/tmp/project');
  check('shell 工具注入 cwd', shellCalls.length === 1 && shellCalls[0].cwd === '/tmp/project' && shellCalls[0].command === 'ls');
  check('逐轮 usage 归属中间消息', emitted[0].tokens_input === 100 && emitted[2].tokens_input === 150);
  check('总 usage 累计', doneArgs.usage.prompt_tokens === 450 && doneArgs.usage.completion_tokens === 75,
    `in=${doneArgs.usage.prompt_tokens} out=${doneArgs.usage.completion_tokens}`);
  check('最终文本', doneArgs.text === '全部完成' && doneArgs.aborted === false);

  // ── 测试 2：工具执行中 abort ──
  reset();
  chatScript = [
    { content: '', tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{"command":"sleep 100"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const controller = new AbortController();
  globalThis.window.mjcode.shell = async (args) => {
    controller.abort(); // 模拟执行中被用户停止
    return { stdout: 'partial' };
  };
  let abortDone = null;
  await runAgent({
    messages: [{ role: 'user', content: '长任务' }],
    model,
    signal: controller.signal,
    cwd: '/tmp/project',
    onMessage: () => {},
    onDone: (text, usage, aborted) => { abortDone = { text, usage, aborted }; },
  });
  check('执行中 abort → aborted=true 且收敛', abortDone?.aborted === true);
  // 恢复 shell mock
  globalThis.window.mjcode.shell = async (args) => { shellCalls.push(args); return { stdout: 'shell-ok' }; };

  // ── 测试 3：上下文压缩 ──
  reset();
  const bigHistory = [];
  for (let i = 0; i < 20; i++) {
    bigHistory.push({ role: 'user', content: `第${i}轮问题：${'x'.repeat(3000)}` });
    bigHistory.push({ role: 'assistant', content: `第${i}轮回答：${'y'.repeat(3000)}` });
  }
  chatScript = [
    { content: '这是压缩摘要：关键决策与文件路径', usage: { prompt_tokens: 50, completion_tokens: 40 } }, // 摘要请求
    { content: '基于摘要的回复', usage: { prompt_tokens: 60, completion_tokens: 20 } }, // 主请求
  ];
  let compactedDone = null;
  await runAgent({
    messages: bigHistory,
    model: { ...model, model: { ...model.model, context_window: 1000 } }, // 小窗口强制触发压缩
    cwd: '/tmp/project',
    onMessage: () => {},
    onDone: (t, u, a) => { compactedDone = { t, u, a }; },
  });
  check('压缩：首次 chat 为摘要请求（无 tools）', chatCalls[0]?.tools === undefined && chatCalls[0]?.messages?.length === 1);
  check('压缩：主请求消息数大幅缩减', chatCalls[1]?.messages?.length < bigHistory.length + 1,
    `${chatCalls[1]?.messages?.length} < ${bigHistory.length + 1}`);
  // 入口裁剪（C3）会先插一条 system 占位，故摘要不再固定在下标 1——改为「system 全在前导块内、
  // 摘要存在、首条非 system 是用户原始需求」：比锁死下标更强（同时守住「无中部 system」）。
  check('压缩：保留 system + 摘要 + 尾部', (() => {
    const msgs = chatCalls[1]?.messages || [];
    const firstNonSystem = msgs.findIndex((m) => m.role !== 'system');
    return msgs[0]?.role === 'system'
      && firstNonSystem > 0
      && msgs.slice(0, firstNonSystem).every((m) => m.role === 'system')
      && msgs.some((m) => m.role === 'system' && String(m.content).includes('压缩摘要'))
      && /第0轮问题/.test(String(msgs[firstNonSystem]?.content || ''));
  })());
  check('压缩后正常完成', compactedDone?.t === '基于摘要的回复');

  // ── 测试 4：AGENTS.md 注入 system prompt ──
  reset();
  chatScript = [{ content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } }];
  await runAgent({
    messages: [{ role: 'user', content: 'hi' }],
    model,
    agentsMd: { path: '/tmp/project/AGENTS.md', content: '项目规范：使用 pnpm，禁止 any' },
    onMessage: () => {},
    onDone: () => {},
  });
  check('AGENTS.md 注入首轮 system prompt', String(chatCalls[0]?.messages?.[0]?.content || '').includes('项目规范：使用 pnpm'));

  // ── 测试 5：spawn_subagent 真实现（嵌套只读循环 + 预算）──
  reset();
  chatScript = [
    // 父代理第 1 轮：派生子代理
    { content: '派生子代理探索', tool_calls: [{ id: 'p1', function: { name: 'spawn_subagent', arguments: JSON.stringify({ objective: '找出入口文件', task_type: 'explore' }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    // 子代理第 1 轮：只读探索
    { content: '看下目录', tool_calls: [{ id: 's1', function: { name: 'list_dir', arguments: '{"path":"/tmp/project"}' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
    // 子代理第 2 轮：结论
    { content: '结论：入口文件是 src/index.js', usage: { prompt_tokens: 80, completion_tokens: 30 } },
    // 父代理第 2 轮：汇总
    { content: '子代理确认入口为 src/index.js', usage: { prompt_tokens: 200, completion_tokens: 40 } },
  ];
  const subEmitted = [];
  let subToolResult = null;
  await runAgent({
    messages: [{ role: 'user', content: '入口文件是哪個？' }],
    model,
    cwd: '/tmp/project',
    onMessage: (m) => subEmitted.push(m),
    onToolCall: (tc) => { if (tc.name === 'spawn_subagent') subToolResult = tc.result; },
    onDone: () => {},
  });
  check('子代理返回结构化结果', subToolResult?.ok === true && String(subToolResult?.result || '').includes('src/index.js'));
  check('子代理记录 token 用量', typeof subToolResult?.tokens_used === 'number' && subToolResult.tokens_used > 0, `used=${subToolResult?.tokens_used}`);
  check('子代理未耗尽预算', subToolResult?.budget_exhausted === false);

  // ── 测试 6：子代理预算耗尽自动停止 ──
  reset();
  chatScript = [
    { content: '派生子代理', tool_calls: [{ id: 'p1', function: { name: 'spawn_subagent', arguments: JSON.stringify({ objective: '大扫描', token_budget: 10 }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    { content: '扫描中', tool_calls: [{ id: 's1', function: { name: 'list_dir', arguments: '{}' } }], usage: { prompt_tokens: 500, completion_tokens: 100 } },
    { content: '（默认回复）', usage: { prompt_tokens: 1, completion_tokens: 1 } },
    { content: '父代理汇总', usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  let budgetResult = null;
  await runAgent({
    messages: [{ role: 'user', content: '扫描' }],
    model,
    cwd: '/tmp/project',
    onMessage: () => {},
    onToolCall: (tc) => { if (tc.name === 'spawn_subagent') budgetResult = tc.result; },
    onDone: () => {},
  });
  check('预算耗尽标记 budget_exhausted', budgetResult?.budget_exhausted === true);
  check('预算耗尽仍返回部分结论', typeof budgetResult?.result === 'string');

  // ── 测试 N：token 预算闸——窗口预算耗尽后**续期**（不中途停任务）；真终点是累计撞总上限 ──
  // 2026-10-30 语义变更：旧实现「救援 3 次用尽 + 超预算」即熔断收尾，用户必须手发「继续」。
  // 实测长途任务必然多次撞窗口级预算（每轮重发上下文），把它当终点等于把任务废在半路。
  // 现在窗口级耗尽 → budgetDecision 返回 'renew'（重置窗口继续跑），
  // 只有**累计**消耗撞到 TASK_TOTAL_TOKEN_CAP 才挂起（runOpts.totalTokenCap 可注入）。
  // 两段都测：只测续期会放过「总上限失效 ⇒ 跑飞任务无限烧」，只测熔断会放过「又变回中途停」。
  reset();
  // 每轮消耗 70（60 in + 10 out），预算 100：轮1 70 → 轮2 140 触发救援 … 每 2 轮续期一次。
  // 8 条带工具的脚本 + 第 9 条无工具收尾；总上限远大于实际消耗（不熔断）。
  chatScript = Array.from({ length: 8 }, (_, i) => ({
    content: `干活（第 ${i + 1} 条脚本）`,
    tool_calls: [{ id: `b${i + 1}`, function: { name: 'git_status', arguments: '{}' } }],
    usage: { prompt_tokens: 60, completion_tokens: 10 },
  })).concat([{ content: '收尾：任务做完了', usage: { prompt_tokens: 60, completion_tokens: 10 } }]);
  let renewDone = null;
  let renewSuspended = null;
  const renewReports = [];
  await runAgent({
    messages: [{ role: 'user', content: '长任务' }],
    model,
    cwd: '/tmp/project',
    tokenBudget: 100,
    totalTokenCap: 1_000_000,
    onMessage: () => {},
    onSuspend: (info) => { renewSuspended = { ...info }; return true; },
    onBudget: (s) => renewReports.push(s),
    onDone: (text, usage) => { renewDone = { text, usage }; },
  });
  const renewRoundCalls = chatCalls.filter((c) => Array.isArray(c.tools) && c.tools.length > 0);
  // 9 次 = 8 轮工具调用 + 1 次收尾请求。收尾请求同样带 tools 参数（请求级注入），
  // 所以不能像旧版那样靠「有无 tools」区分摘要调用——旧版能区分是因为触发过强制压缩，
  // 而续期路径（'renew'）刻意**不压缩**（重置窗口即可），本场景不会产生摘要请求。
  check('窗口预算耗尽后继续跑满 8 轮工具调用 + 收尾（不再中途熔断）', renewRoundCalls.length === 9,
    `模型请求 ${renewRoundCalls.length} 次（含收尾；摘要 0 次）`);
  check('续期路径不触发挂起（onSuspend 未被调用）', renewSuspended === null, JSON.stringify(renewSuspended));
  check('未撞总上限时收尾文案正常结束、不含预算告警',
    renewDone?.text === '收尾：任务做完了' && !String(renewDone?.text).includes('预算'));
  check('usage 全程累计如实上报（9×70=630，摘要调用不计入）',
    renewDone?.usage?.prompt_tokens === 540 && renewDone?.usage?.completion_tokens === 90,
    `in=${renewDone?.usage?.prompt_tokens} out=${renewDone?.usage?.completion_tokens}`);
  check('onBudget 逐轮上报（≥8 条运行中 + 1 条收尾定格）',
    renewReports.filter((r) => r.running === true).length >= 8
    && renewReports[renewReports.length - 1]?.running === false,
    `共 ${renewReports.length} 条`);

  // ── 测试 N2：累计撞总上限 → 真挂起（防失控的最后一道线）──
  reset();
  chatScript = Array.from({ length: 20 }, (_, i) => ({
    content: `干活（第 ${i + 1} 条脚本）`,
    tool_calls: [{ id: `c${i + 1}`, function: { name: 'git_status', arguments: '{}' } }],
    usage: { prompt_tokens: 60, completion_tokens: 10 },
  }));
  let capDone = null;
  let capSuspended = null;
  await runAgent({
    messages: [{ role: 'user', content: '跑飞任务' }],
    model,
    cwd: '/tmp/project',
    tokenBudget: 100,
    totalTokenCap: 200,
    onMessage: () => {},
    onSuspend: (info) => { capSuspended = { ...info }; return true; },
    onDone: (text) => { capDone = { text }; },
  });
  check('累计消耗撞总上限时挂起（kind=tokens，带用量与轮数）',
    capSuspended?.kind === 'tokens' && capSuspended?.roundsUsed >= 3 && capSuspended?.usage?.prompt_tokens >= 180,
    `kind=${capSuspended?.kind} rounds=${capSuspended?.roundsUsed} in=${capSuspended?.usage?.prompt_tokens}`);
  check('总上限收尾文案说「累计消耗已达防失控总上限」并标注断点',
    String(capDone?.text).includes('防失控总上限') === true
    && String(capDone?.text).includes('断点已保存') === true,
    String(capDone?.text).slice(-160));

  // ── 测试 O：断点恢复注入——resumeContext 进 system 消息（不进持久化历史）──
  reset();
  chatScript = [{ content: '恢复完成', usage: { prompt_tokens: 5, completion_tokens: 3 } }];
  let resumeFirstSystem = '';
  await runAgent({
    messages: [{ role: 'user', content: '继续' }],
    model,
    cwd: '/tmp/project',
    resumeContext: '断点标记XYZ：已完成A，待办B',
    onMessage: () => {},
    onDone: () => {},
  });
  resumeFirstSystem = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('resumeContext 注入 system（含断点恢复标识与摘要原文）',
    resumeFirstSystem.includes('断点恢复') && resumeFirstSystem.includes('断点标记XYZ'));

  // ── 测试 P：read_file run 内缓存——mtime/size 未变的重复全量读取命中缓存 ──
  reset();
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const cacheFile = pathMod.join(fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mjcode-fc-')), 'big.js');
  const bigContent = `// 大文件内容\n${'const x = 1;\n'.repeat(600)}`; // ≈ 7800 字符 > FILE_CACHE_MIN_CHARS(4000)
  fsMod.writeFileSync(cacheFile, bigContent);
  let readFileCalls = 0;
  const prevReadFile = globalThis.window.mjcode.readFile;
  globalThis.window.mjcode.readFile = async (args) => {
    readFileCalls += 1;
    return { ok: true, path: args.path, content: bigContent, totalLines: bigContent.split('\n').length };
  };
  try {
    chatScript = [
      { content: '读一次', tool_calls: [{ id: 'r1', function: { name: 'read_file', arguments: JSON.stringify({ path: cacheFile }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: '再读一次', tool_calls: [{ id: 'r2', function: { name: 'read_file', arguments: JSON.stringify({ path: cacheFile }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: '读完', usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ];
    const toolMsgs = [];
    await runAgent({
      messages: [{ role: 'user', content: '读两次同一个大文件' }],
      model,
      cwd: '/tmp/project',
      onMessage: (m) => { if (m.role === 'tool') toolMsgs.push(m); },
      onDone: () => {},
    });
    check('第二次未变更读取命中缓存（通道只被调用 1 次）', readFileCalls === 1, `readFile 调用 ${readFileCalls} 次`);
    check('缓存命中返回提示而非重复全文', String(toolMsgs[1]?.content || '').includes('缓存命中')
      && !String(toolMsgs[1]?.content || '').includes('const x = 1;'));
    check('首次读取仍返回完整内容', String(toolMsgs[0]?.content || '').includes('const x = 1;'));
  } finally {
    globalThis.window.mjcode.readFile = prevReadFile;
  }

  // ── 测试 Q：长输出摘要化（Phase 3-3）——PASS 折叠 + 头尾保留 + 原文落盘 ──
  const { collapsePassLines, summarizeToolOutput } = await import('../agent-core/index.js');
  const passRun = Array.from({ length: 30 }, (_, i) => `✓ test ${i + 1} passed`).join('\n');
  const collapsed = collapsePassLines(`header\n${passRun}\nfooter`);
  check('连续 PASS 行折叠（30 行 → 3 行，含汇总提示，上下文行保留原位）',
    collapsed.split('\n').length === 5
    && collapsed.includes('28 行通过用例日志已折叠') === true
    && collapsed.startsWith('header') === true
    && collapsed.endsWith('footer') === true,
    `折叠后 ${collapsed.split('\n').length} 行`);
  check('PASS 行数未超阈值不折叠', collapsePassLines(Array.from({ length: 10 }, (_, i) => `✓ t${i}`).join('\n')).split('\n').length === 10);

  const hugeOutput = 'x'.repeat(20000);
  const summarized = await summarizeToolOutput(hugeOutput, 'shell');
  check('超长输出触发摘要化（头尾保留 + 标记 + 落盘路径）',
    summarized.includes('长输出摘要化') === true && summarized.includes('mjcode-tool-outputs') === true
    && summarized.length < 8000, `摘要后 ${summarized.length} 字符`);
  const savedPath = (summarized.match(/(\/[^\s]+mjcode-tool-outputs\/[^\s（]+)/) || [])[1];
  check('落盘原文可读回（内容与原文一致）', !!savedPath && fsMod.readFileSync(savedPath, 'utf8') === hugeOutput,
    savedPath || '未取到路径');
  const smallSum = await summarizeToolOutput('short', 'shell');
  check('短输出原样返回', smallSum === 'short');
  const objSum = await summarizeToolOutput({ ok: true, stdout: 'y'.repeat(12000), stderr: '' }, 'shell');
  check('对象结果仅摘要化超长字段（结构完整可解析）',
    JSON.parse(JSON.stringify(objSum)).ok === true && objSum.stdout.includes('长输出摘要化') && objSum.stderr === '');

  // ── 测试 R：空收尾守卫（2026-10-15）——空响应轮不再被当成任务完成 ──
  // R1：第 1 轮空响应 → 旁路注入续跑指令 → 第 2 轮正常输出 → 正常收尾
  reset();
  chatScript = [
    { content: '', usage: { prompt_tokens: 10, completion_tokens: 0 } },
    { content: '任务已完成：改了 a.js 并通过测试', usage: { prompt_tokens: 20, completion_tokens: 10 } },
  ];
  let emptyNudgeDone = null;
  await runAgent({
    messages: [{ role: 'user', content: '做个任务' }],
    model,
    cwd: '/tmp/project',
    onMessage: () => {},
    onDone: (t, u, a) => { emptyNudgeDone = { t, u, a }; },
  });
  check('空收尾守卫：空响应后注入续跑指令再请求（共 2 次 chat）', chatCalls.length === 2, `chat ${chatCalls.length} 次`);
  // 2026-10-18（P1-4）：续跑/续期/截断三种旁路指令统一改为追加**末条 user 消息**，
  // 不再拼进首条 system（拼 system 会当轮把稳定前缀打废；中段 system 是 DeepSeek 系硬坑）。
  // 断言改为「末条消息 role=user 且含续跑文案」，而不是「首条 system 含」。
  const nudgeMsgs = chatCalls[1]?.messages || [];
  const nudgeLast = nudgeMsgs[nudgeMsgs.length - 1];
  check('空收尾守卫：续跑指令走末条 user 消息（不污染会话历史、不动前缀）',
    nudgeLast?.role === 'user' && String(nudgeLast.content || '').includes('空响应'),
    `lastRole=${nudgeLast?.role} text=${String(nudgeLast?.content || '').slice(-60)}`);
  check('空收尾守卫：续跑后正常返回总结文本', emptyNudgeDone?.t === '任务已完成：改了 a.js 并通过测试');

  // R2：连续 3 轮空响应（超过 2 次续跑上限）→ 返回「任务未完全完成」兜底文案
  reset();
  chatScript = [
    { content: '', usage: { prompt_tokens: 10, completion_tokens: 0 } },
    { content: '', usage: { prompt_tokens: 10, completion_tokens: 0 } },
    { content: '', usage: { prompt_tokens: 10, completion_tokens: 0 } },
  ];
  let emptyFallbackDone = null;
  await runAgent({
    messages: [{ role: 'user', content: '做个任务' }],
    model,
    cwd: '/tmp/project',
    onMessage: () => {},
    onDone: (t, u, a) => { emptyFallbackDone = { t, u, a }; },
  });
  check('空收尾守卫：连续空响应在 2 次续跑后收尾（共 3 次 chat）', chatCalls.length === 3, `chat ${chatCalls.length} 次`);
  check('空收尾守卫：兜底文案明示「任务未完全完成」且非空',
    String(emptyFallbackDone?.t || '').includes('任务未完全完成') && String(emptyFallbackDone?.t || '').trim().length > 0,
    String(emptyFallbackDone?.t || '').slice(0, 50));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
