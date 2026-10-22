// P1-8：本套件用最小 handler 夹具测引擎核心（含压缩触发），而可用性闸会按通道裁掉工具、
// 连带改变上下文规模，使压缩阈值类断言失真。闸本身由 tool-availability.test.mjs 覆盖。
process.env.MJCODE_TOOL_AVAILABILITY = '0';
// agent-core 直测：toolHandlers 注入式（无 window 依赖）
// 覆盖：中间消息持久化 / cwd 注入 / usage 归属 / abort / 上下文压缩 /
//       AGENTS.md 注入 / 子代理 / 预算 / session.jsonl 落盘 / CLI 冒烟
import { runAgent, BASE_TOOLS, BUILTIN_SKILL_IDS, looksLargeTask, parsePlanResponse, chatWithRetry, isRetryableChatError, compactHistory, alignCutToRoundBoundary, truncateToolResult, AGENT_HARD_ROUND_CAP, resolveCompactPolicy, DEFAULT_COMPACT_POLICY, trimHistoryForRun } from '../agent-core/index.js';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// 注入式 toolHandlers：模型调用走脚本队列，工具调用全部 mock
function makeToolHandlers() {
  return {
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
  };
}

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
    toolHandlers: makeToolHandlers(),
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
  const abortHandlers = makeToolHandlers();
  abortHandlers.shell = async (args) => {
    controller.abort(); // 模拟执行中被用户停止
    return { stdout: 'partial' };
  };
  let abortDone = null;
  await runAgent({
    messages: [{ role: 'user', content: '长任务' }],
    model,
    signal: controller.signal,
    cwd: '/tmp/project',
    toolHandlers: abortHandlers,
    onMessage: () => {},
    onDone: (text, usage, aborted) => { abortDone = { text, usage, aborted }; },
  });
  check('执行中 abort → aborted=true 且收敛', abortDone?.aborted === true);

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
    toolHandlers: makeToolHandlers(),
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
      && firstNonSystem > 0                                  // 前导 system 块存在
      && msgs.slice(0, firstNonSystem).every((m) => m.role === 'system') // 无中部 system
      && msgs.some((m) => m.role === 'system' && String(m.content).includes('压缩摘要'))
      && /第0轮问题/.test(String(msgs[firstNonSystem]?.content || '')); // 用户原始需求仍在
  })());
  check('压缩后正常完成', compactedDone?.t === '基于摘要的回复');
  check('压缩摘要请求带顶层目标（首条用户需求不可丢）',
    /【顶层目标】/.test(String(chatCalls[0]?.messages?.[0]?.content || ''))
    && String(chatCalls[0]?.messages?.[0]?.content || '').includes('第0轮问题'));

  // ── 2026-10-21 P0：上下文策略参数化（DS Bot 式可配置）──
  {
    const pol = resolveCompactPolicy({ triggerRatio: 0.55, keepTailRatio: 99, toolShrinkChars: 10 });
    check('策略：比例越界被夹紧、非法值回落默认',
      pol.triggerRatio === 0.55 && pol.keepTailRatio === 0.5 && pol.toolShrinkChars === 200,
      JSON.stringify(pol));
    check('策略：默认值来自单一事实来源',
      DEFAULT_COMPACT_POLICY.triggerRatio === 0.7 && DEFAULT_COMPACT_POLICY.toolShrinkChars === 2000);

    // 策略 A：大工具输出优先裁剪（保首尾），不丢首条 user 与决策消息
    const trimInput = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '目标：修复报数错误' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'z'.repeat(40000) },
      { role: 'assistant', content: '关键决策：改 A 文件' },
    ];
    const tr = trimHistoryForRun(trimInput, { contextWindow: 1000, policy: { toolShrinkChars: 2000 } });
    check('策略 A：大工具输出优先裁剪（保留首条 user 与决策）',
      tr.trimmed && tr.dropped === 0
      && String(tr.convo.find((m) => m.role === 'tool')?.content || '').includes('工具输出已裁剪')
      && tr.convo.some((m) => String(m.content || '').includes('关键决策')),
      `trimmed=${tr.trimmed} dropped=${tr.dropped}`);
  }

  // ── 测试 4：AGENTS.md 注入 system prompt ──
  reset();
  chatScript = [{ content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } }];
  await runAgent({
    messages: [{ role: 'user', content: 'hi' }],
    model,
    agentsMd: { path: '/tmp/project/AGENTS.md', content: '项目规范：使用 pnpm，禁止 any' },
    toolHandlers: makeToolHandlers(),
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
  let subToolResult = null;
  await runAgent({
    messages: [{ role: 'user', content: '入口文件是哪個？' }],
    model,
    cwd: '/tmp/project',
    toolHandlers: makeToolHandlers(),
    onMessage: () => {},
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
    toolHandlers: makeToolHandlers(),
    onMessage: () => {},
    onToolCall: (tc) => { if (tc.name === 'spawn_subagent') budgetResult = tc.result; },
    onDone: () => {},
  });
  check('预算耗尽标记 budget_exhausted', budgetResult?.budget_exhausted === true);
  check('预算耗尽仍返回部分结论', typeof budgetResult?.result === 'string');

  // ── 测试 7：session.jsonl 落盘 ──
  reset();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-agent-session-'));
  chatScript = [
    { content: '看一眼', tool_calls: [{ id: 's_call', function: { name: 'git_status', arguments: '{}' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    { content: '完成', usage: { prompt_tokens: 13, completion_tokens: 9 } },
  ];
  await runAgent({
    messages: [{ role: 'user', content: '落盘测试' }],
    model,
    cwd: '/tmp/project',
    sessionDir,
    toolHandlers: makeToolHandlers(),
    onMessage: () => {},
    onDone: () => {},
  });
  const sessionPath = path.join(sessionDir, 'session.jsonl');
  check('session.jsonl 已生成', fs.existsSync(sessionPath));
  const lines = fs.readFileSync(sessionPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('落盘条数 = assistant + tool', lines.length === 2, `rows=${lines.length}`);
  check('落盘首行为 assistant 且带 tool_calls 与时间戳', lines[0].role === 'assistant' && Array.isArray(lines[0].tool_calls) && typeof lines[0].ts === 'string');
  check('落盘含 usage 字段', lines[0].usage?.prompt_tokens === 11 && lines[0].usage?.completion_tokens === 7);
  check('落盘第二行为 tool 结果', lines[1].role === 'tool' && lines[1].tool_call_id === 's_call');

  // ── 测试 8：导出完整性 ──
  check('BASE_TOOLS 导出且含 shell/read_file', Array.isArray(BASE_TOOLS) && BASE_TOOLS.some((t) => t.function?.name === 'shell') && BASE_TOOLS.some((t) => t.function?.name === 'read_file'));
  check('BUILTIN_SKILL_IDS 导出', Array.isArray(BUILTIN_SKILL_IDS) && BUILTIN_SKILL_IDS.includes('code_review'));
  check('BUILTIN_SKILL_IDS 含 deep_research（T4-4）', BUILTIN_SKILL_IDS.includes('deep_research'));
  check('BUILTIN_SKILL_IDS 含 latex_compile/latex_doctor（T4-5）',
    BUILTIN_SKILL_IDS.includes('latex_compile') && BUILTIN_SKILL_IDS.includes('latex_doctor'));

  // ── 测试 8b：deep_research 技能提示注入（T4-4）──
  reset();
  chatScript = [{ content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } }];
  await runAgent({
    messages: [{ role: 'user', content: '调研一下主流桌面 Agent 产品' }],
    model,
    cwd: '/tmp/project',
    enabledSkills: ['deep_research'],
    toolHandlers: makeToolHandlers(),
    onMessage: () => {},
    onDone: () => {},
  });
  const sysDr = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('deep_research 启用后 system 含五阶段工作流提示',
    sysDr.includes('深度研究技能') && sysDr.includes('澄清') && sysDr.includes('调和与产出'));
  check('deep_research 提示引用 orchestrate_task 与 todo_write 真实工具名',
    sysDr.includes('orchestrate_task') && sysDr.includes('todo_write'));
  check('deep_research 提示要求报告含引用列表', sysDr.includes('引用列表'));
  // 未启用时不注入（既往行为不变）
  reset();
  chatScript = [{ content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } }];
  await runAgent({
    messages: [{ role: 'user', content: 'hi' }],
    model,
    cwd: '/tmp/project',
    toolHandlers: makeToolHandlers(),
    onMessage: () => {},
    onDone: () => {},
  });
  check('未启用 deep_research 时不注入该提示', !String(chatCalls[0]?.messages?.[0]?.content || '').includes('深度研究技能'));

  // ── 测试 8c：latex 技能提示注入（T4-5）──
  reset();
  chatScript = [{ content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } }];
  await runAgent({
    messages: [{ role: 'user', content: '把这个论文项目编译成 PDF' }],
    model,
    cwd: '/tmp/project',
    enabledSkills: ['latex_compile', 'latex_doctor'],
    toolHandlers: makeToolHandlers(),
    onMessage: () => {},
    onDone: () => {},
  });
  const sysLatex = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('latex 技能启用后 system 含编译与诊断两段提示',
    sysLatex.includes('LaTeX 编译技能') && sysLatex.includes('LaTeX 工具链诊断技能'));
  check('latex 提示改为优先调用原生 latex_compile 工具，并保留 Tectonic/MacTeX 安装指引',
    sysLatex.includes('latex_compile') && sysLatex.includes('Tectonic') && sysLatex.includes('MacTeX'));
  check('latex 诊断提示走 probeOnly 体检', sysLatex.includes('probeOnly'));
  check('latex 提示保留 \\documentclass 反斜杠（模板字符串转义正确）', sysLatex.includes('\\documentclass'));
  check('latex 提示要求产物确认后才宣称完成', sysLatex.includes('禁止没看到') && sysLatex.includes('编译成功'));

  // ── 测试 9：CLI 冒烟 ──
  const cliPath = path.resolve(import.meta.dirname, '../agent-core/cli.js');
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-agent-cli-'));
  const taskPath = path.join(tmpWork, 'task.json');
  const outPath = path.join(tmpWork, 'out', 'report.json');

  // 9.1 --help 退出码 0
  const helpRun = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  check('CLI --help 退出码 0', helpRun.status === 0 && helpRun.stdout.includes('--task'));

  // 9.2 task.json 缺 objective → 退出码非 0
  const badTaskPath = path.join(tmpWork, 'bad-task.json');
  fs.writeFileSync(badTaskPath, JSON.stringify({ provider: { base_url: 'http://x', model_id: 'm' } }));
  const badRun = spawnSync(process.execPath, [cliPath, '--task', badTaskPath, '--out', path.join(tmpWork, 'bad-report.json')], { encoding: 'utf8' });
  check('CLI task.json 缺 objective → 非零退出', badRun.status !== 0 && badRun.stderr.includes('objective'));

  // 9.3 未知参数 → 非零退出
  const unknownRun = spawnSync(process.execPath, [cliPath, '--bogus'], { encoding: 'utf8' });
  check('CLI 未知参数 → 非零退出', unknownRun.status !== 0 && unknownRun.stderr.includes('未知参数'));

  // 9.4 缺 --task/--out → 非零退出
  const missingRun = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
  check('CLI 缺必填参数 → 非零退出', missingRun.status !== 0 && missingRun.stderr.includes('缺少必填参数'));

  // 9.5 mock 模式完整跑：一轮 tool_call + 一轮最终文本 → report.json
  fs.writeFileSync(taskPath, JSON.stringify({
    objective: '冒烟测试：确认环境可用',
    provider: { id: 'mock-p', base_url: 'http://127.0.0.1:1/v1', model_id: 'mock-model' },
    cwd: tmpWork,
    maxRounds: 5,
  }));
  const mockRun = spawnSync(process.execPath, [cliPath, '--task', taskPath, '--out', outPath, '--session-dir', path.join(tmpWork, 'session')], {
    encoding: 'utf8',
    env: { ...process.env, MJ_AGENT_MOCK: '1' },
  });
  check('CLI mock 模式退出码 0', mockRun.status === 0, mockRun.stderr.trim().slice(0, 120));
  let report = null;
  try { report = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* 报告缺失 */ }
  check('CLI 产出 report.json 且 ok=true', report?.ok === true);
  check('CLI report.finalText 为 mock 最终文本', report?.finalText === 'mock 完成：环境确认无误，任务结束。');
  check('CLI report.usage 累计', report?.usage?.prompt_tokens === 25 && report?.usage?.completion_tokens === 13,
    `in=${report?.usage?.prompt_tokens} out=${report?.usage?.completion_tokens}`);
  check('CLI report 含 objective 与 sessionPath', report?.objective === '冒烟测试：确认环境可用' && typeof report?.sessionPath === 'string');
  check('CLI report.diff 为字符串（非 git 仓库时为空串）', typeof report?.diff === 'string');
  // 9.6 mock 会话落盘：session.jsonl 含 assistant(tool_calls) 与 tool 两行
  const mockSessionPath = path.join(tmpWork, 'session', 'session.jsonl');
  const mockLines = fs.existsSync(mockSessionPath)
    ? fs.readFileSync(mockSessionPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
  check('CLI mock 会话落盘 assistant+tool', mockLines.length === 2 && mockLines[0].role === 'assistant' && mockLines[0].tool_calls?.[0]?.function?.name === 'shell' && mockLines[1].role === 'tool');

  // ── 测试 11：大任务拆分——本地启发式 + JSON 解析 ──
  check('小任务不触发拆分（零 token 成本）', looksLargeTask('帮我看看这个文件') === false && looksLargeTask('') === false);
  check('多目标/多文件任务触发拆分', looksLargeTask('请把这个页面重写，同时补充音效、动画和关卡设计，涉及多个组件文件，并更新相关接口') === true);
  check('批量语义触发拆分', looksLargeTask('批量重构全部服务的错误处理，所有模块都要改，并补充单元测试覆盖每种错误分支') === true);
  check('普通短消息即使含目标词也不拆', looksLargeTask('改一下按钮样式') === false);

  check('解析：合法 JSON 拆分为 2-6 步', parsePlanResponse('{"decompose":true,"reason":"涉及多个页面","tasks":[{"title":"首页","prompt":"重写首页"},{"title":"音效","prompt":"补音效"}]}').tasks.length === 2);
  check('解析：markdown 代码围栏兼容', parsePlanResponse('```json\n{"decompose":true,"reason":"x","tasks":[{"title":"a","prompt":"b"},{"title":"c","prompt":"d"}]}\n```').decompose === true);
  check('解析：单步/无任务/非法 JSON 一律不拆（fail-open）',
    parsePlanResponse('{"decompose":true,"tasks":[{"title":"a","prompt":"b"}]}').decompose === false
    && parsePlanResponse('{"decompose":false,"reason":"小任务"}').decompose === false
    && parsePlanResponse('not json at all').decompose === false);
  check('解析：超过 6 步截断到 6', parsePlanResponse(JSON.stringify({ decompose: true, tasks: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` })) })).tasks.length === 6);

  // 清理临时目录
  fs.rmSync(tmpWork, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });

  // ── 测试 10：防提前终止——预算续期 / 硬顶标注 / length 截断续跑 ──
  {
    // 10.1 maxRounds=2 且模型连续 4 轮工具调用：预算自动续期 1 次后正常收尾（不再 15 轮即断）
    reset();
    chatScript = [
      ...Array.from({ length: 4 }, (_, i) => ({
        content: `第${i + 1}步`, tool_calls: [{ id: `c${i}`, function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })),
      { content: '全部完成', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    let extDone = null;
    await runAgent({
      messages: [{ role: 'user', content: '连续干活' }],
      model, cwd: '/tmp/project', maxRounds: 2,
      toolHandlers: makeToolHandlers(),
      onMessage: () => {},
      onDone: (t) => { extDone = t; },
    });
    check('预算续期：maxRounds=2 时 4 轮工具调用仍可完成', extDone === '全部完成', `chat 轮数=${chatCalls.length}`);

    // 10.2 硬顶：maxRounds=1 + 5 轮工具调用（2 次续期共 3 轮后耗尽）→ 收尾并标注未完成
    reset();
    chatScript = [
      ...Array.from({ length: 5 }, (_, i) => ({
        content: `步骤${i + 1}`, tool_calls: [{ id: `d${i}`, function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })),
    ];
    let capDone = null;
    await runAgent({
      messages: [{ role: 'user', content: '干不完的活' }],
      model, cwd: '/tmp/project', maxRounds: 1,
      toolHandlers: makeToolHandlers(),
      onMessage: () => {},
      onDone: (t, u, a) => { capDone = { t, a }; },
    });
    check('预算硬顶：收尾文本明确标注未完成并引导继续',
      capDone?.t?.includes('轮次预算已用尽') && capDone?.t?.includes('继续') && capDone?.a === false,
      String(capDone?.t).slice(-40));

    // 10.3 finish_reason=length：从断点续跑（不终止）
    reset();
    chatScript = [
      { content: '写到一半的输出', finish_reason: 'length', usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { content: '全部完成', usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    let lenDone = null;
    await runAgent({
      messages: [{ role: 'user', content: '长输出任务' }],
      model, toolHandlers: makeToolHandlers(),
      onMessage: () => {},
      onDone: (t) => { lenDone = t; },
    });
    check('length 截断续跑：最终取到完整文本', lenDone === '全部完成', `chat 轮数=${chatCalls.length}`);
  }

  // ── 测试 12：模型调用重试（P0-A / TC-QA-001）──
  {
    // 12.1 429 限流：前 2 次失败、第 3 次成功 → 重试后拿到结果
    let calls = 0;
    const chatFn429 = async () => {
      calls++;
      if (calls <= 2) throw new Error('API 429: rate limit exceeded');
      return { content: 'ok', usage: { prompt_tokens: 7, completion_tokens: 2 } };
    };
    const r429 = await chatWithRetry(chatFn429, {}, undefined, { baseMs: 0 });
    check('429 重试后成功（第 3 次）', r429.content === 'ok' && calls === 3, `calls=${calls}`);

    // 12.2 网络类错误同样重试
    calls = 0;
    const chatFnNet = async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return { content: 'net-ok' };
    };
    const rNet = await chatWithRetry(chatFnNet, {}, undefined, { baseMs: 0 });
    check('网络错误重试后成功', rNet.content === 'net-ok' && calls === 2, `calls=${calls}`);

    // 12.3 重试耗尽后抛出原错误（不静默吞掉）
    calls = 0;
    const chatFn503 = async () => { calls++; throw new Error('API 503: overloaded'); };
    let thrown503 = null;
    try { await chatWithRetry(chatFn503, {}, undefined, { baseMs: 0, maxRetries: 2 }); } catch (e) { thrown503 = e; }
    check('重试耗尽（2 次）后抛出原错误', thrown503?.message.includes('503') && calls === 3, `calls=${calls}`);

    // 12.4 aborted 直穿不重试（用户主动停止不该被重试拖住）
    const ac = new AbortController();
    ac.abort();
    calls = 0;
    const chatFnAbort = async () => { calls++; throw new Error('API 503'); };
    let thrownAbort = null;
    try { await chatWithRetry(chatFnAbort, {}, ac.signal, { baseMs: 0 }); } catch (e) { thrownAbort = e; }
    check('aborted 直穿不重试', thrownAbort !== null && calls === 1, `calls=${calls}`);

    // 12.5 客户端错误（400）不重试
    calls = 0;
    const chatFn400 = async () => { calls++; throw new Error('API 400: param incorrect'); };
    let thrown400 = null;
    try { await chatWithRetry(chatFn400, {}, undefined, { baseMs: 0 }); } catch (e) { thrown400 = e; }
    check('400 客户端错误不重试', thrown400 !== null && calls === 1, `calls=${calls}`);

    // 12.6 KEY_MISSING 不重试（凭证问题重试无意义）
    calls = 0;
    const chatFnKey = async () => { calls++; throw new Error('KEY_MISSING'); };
    let thrownKey = null;
    try { await chatWithRetry(chatFnKey, {}, undefined, { baseMs: 0 }); } catch (e) { thrownKey = e; }
    check('KEY_MISSING 不重试', thrownKey !== null && calls === 1, `calls=${calls}`);

    // 12.7 分类函数边界：undefined / 普通 Error 不重试
    check('isRetryableChatError：undefined 不重试', isRetryableChatError(undefined) === false);
    check('isRetryableChatError：普通错误不重试', isRetryableChatError(new Error('boom')) === false);
    check('isRetryableChatError：502 可重试', isRetryableChatError(new Error('API 502')) === true);
    check('isRetryableChatError：ECONNRESET 可重试', isRetryableChatError(new Error('read ECONNRESET')) === true);

    // 12.8 集成：runAgent 内 chat 前两次 502、第三次成功 → 任务完成，usage 只计成功轮
    let attempts = 0;
    const flakyHandlers = makeToolHandlers();
    flakyHandlers.chat = async () => {
      attempts++;
      if (attempts <= 2) throw new Error('API 502: bad gateway');
      return { content: '重试后完成', usage: { prompt_tokens: 30, completion_tokens: 9 } };
    };
    let retryDone = null;
    await runAgent({
      messages: [{ role: 'user', content: '跑个任务' }],
      model,
      toolHandlers: flakyHandlers,
      chatRetryBaseMs: 0,
      onDone: (text, usage) => { retryDone = { text, usage }; },
    });
    check('runAgent 内瞬时错误重试后完成任务', retryDone?.text === '重试后完成' && attempts === 3, `attempts=${attempts}`);
    check('usage 只统计成功轮', retryDone?.usage.prompt_tokens === 30 && retryDone?.usage.completion_tokens === 9,
      `in=${retryDone?.usage.prompt_tokens} out=${retryDone?.usage.completion_tokens}`);
  }

  // ── 测试 13：shell 沙箱策略 fail-safe 透传（P0-B 引擎侧 / TC-QA-002）──
  {
    reset();
    chatScript = [
      { content: '跑命令', tool_calls: [{ id: 'sr1', function: { name: 'shell', arguments: '{"command":"ls"}' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
      { content: '完成', usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    await runAgent({ messages: [{ role: 'user', content: 'x' }], model, toolHandlers: makeToolHandlers(), onDone: () => {} });
    check('未传 sandboxPolicy 时 shell 默认 read-only（fail-safe）',
      shellCalls[0]?.sandboxPolicy === 'read-only', `got=${shellCalls[0]?.sandboxPolicy}`);

    reset();
    chatScript = [
      { content: '跑命令', tool_calls: [{ id: 'sr2', function: { name: 'shell', arguments: '{"command":"ls"}' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
      { content: '完成', usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    await runAgent({ messages: [{ role: 'user', content: 'x' }], model, sandboxPolicy: 'workspace-write', toolHandlers: makeToolHandlers(), onDone: () => {} });
    check('显式 sandboxPolicy 原样透传', shellCalls[0]?.sandboxPolicy === 'workspace-write', `got=${shellCalls[0]?.sandboxPolicy}`);
  }

  // ── 测试 14：P1 批次——上下文治理 / 截断标记 / 预算双闸（TC-QA-005/006/007/014）──
  {
    // 14.1 轮边界对齐纯函数
    const body = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a1' }] },
      { role: 'tool', tool_call_id: 'a1', content: 'r1' },
      { role: 'tool', tool_call_id: 'a2', content: 'r2' },
      { role: 'assistant', content: 'done' },
    ];
    check('alignCutToRoundBoundary：切点从工具消息中部移到轮尾', alignCutToRoundBoundary(body, 2) === 4);
    check('alignCutToRoundBoundary：安全切点原样返回', alignCutToRoundBoundary(body, 1) === 1 && alignCutToRoundBoundary(body, 4) === 4);
    check('alignCutToRoundBoundary：越界钳制到末尾', alignCutToRoundBoundary(body, 99) === 5);

    // 14.2 压缩不在工具轮中间下刀（长会话 400 根因防线）
    const toolHistory = [
      { role: 'user', content: '开始' },
      ...Array.from({ length: 12 }, (_, i) => [
        { role: 'assistant', content: `第${i}步`, tool_calls: [{ id: `t${i}`, function: { name: 'shell' } }] },
        { role: 'tool', tool_call_id: `t${i}`, content: 'x'.repeat(300) },
      ]).flat(),
    ];
    reset();
    chatScript = [{ content: '压缩摘要内容', usage: { prompt_tokens: 10, completion_tokens: 5 } }];
    const smallWindow = { ...model, model: { ...model.model, context_window: 1000 } };
    const out = await compactHistory(
      [{ role: 'system', content: 'sys' }, ...toolHistory],
      smallWindow,
      async () => chatScript.shift(),
    );
    const seenCallIds = new Set();
    let orphan = false;
    for (const m of out) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) seenCallIds.add(tc.id);
      if (m.role === 'tool' && !seenCallIds.has(m.tool_call_id)) orphan = true;
    }
    check('压缩结果无孤儿 tool 消息（400 根因防线）', !orphan);
    const answered = new Set(out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    const unanswered = out.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => !answered.has(tc.id)));
    check('压缩结果无未应答 tool_calls', !unanswered);
    // 2026-10-17：压缩保留前导 system + 首条 user（原始需求/专家角色不可被摘要掉）。
    // 摘要消息插在 system 块内、首条 user 之前（DeepSeek 系只认首部 system），故下标为
    // [system, 摘要(system), user, ...tail] —— 用固定下标钉住「system 块连续 + user 紧随其后」。
    check('压缩保留 system + 摘要 + 首条 user（原始需求被钉住）',
      out[0].role === 'system'
      && String(out[1].content).includes('压缩摘要内容')
      && out[2]?.role === 'user' && String(out[2].content).includes('开始'));

    // 14.3 双档阈值：85% 以上激进档（更短尾部 + 压力告警），70%~85% 常规档
    reset();
    chatScript = [{ content: '激进摘要', usage: { prompt_tokens: 10, completion_tokens: 5 } }];
    const outAggressive = await compactHistory(
      [{ role: 'system', content: 'sys' }, ...toolHistory],
      smallWindow,
      async () => chatScript.shift(),
    );
    // 2026-10-17：压缩保留前导 system + 首条 user（原始需求/专家角色不可被摘要掉）
    // 激进档的断言移到 outNormal 计算之后（两者要比较；尾部条数不再固定）
    // 2026-10-18（P2-4）：激进档门槛 0.85 → 0.80，同一段历史（估算 1067 tokens）在 window=1300 时
    // 占用 1067/1300 = 0.82 > 0.80 会落进激进档，常规档样本必须后移到 1500（1067/1500 = 0.71，
    // 仍 > 0.70 触发线，所以照样会压缩）。只改样本窗口，不动断言强度。
    reset();
    chatScript = [{ content: '常规摘要', usage: { prompt_tokens: 10, completion_tokens: 5 } }];
    const outNormal = await compactHistory(
      [{ role: 'system', content: 'sys' }, ...toolHistory],
      { ...model, model: { ...model.model, context_window: 1500 } },
      async () => chatScript.shift(),
    );
    // 2026-10-17 T2：尾部保留量改由「体积预算」决定（常规保留窗口 25% / 激进 15%），
    // 不再是固定条数（keepTail=6/3）。守护目标不变：激进档必须裁得更狠且带压力告警，
    // 常规档必须保留更多尾部；固定头（system 块 + 首条 user）两档都要保住。
    // 条数断言退化为「体积断言」的原因：一轮并发 8 个工具时，条数制会把整段都算成尾部。
    check('常规档保留尾部且无压力告警',
      outNormal.length > 3 && !String(outNormal[1].content).includes('上下文压力告警'),
      `len=${outNormal.length}`);
    check('激进档尾部更短且注入压力告警',
      outAggressive.length < outNormal.length && String(outAggressive[1].content).includes('上下文压力告警'),
      `agg=${outAggressive.length} normal=${outNormal.length}`);
    check('激进档比常规档裁得更多', outAggressive.length < outNormal.length);

    // 14.4 真实 usage 驱动压缩：启发式估算低于阈值，但上一轮真实 prompt_tokens 超过 70% → 仍触发
    reset();
    const filler = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    chatScript = [
      { content: '第一轮', tool_calls: [{ id: 'u1', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }], usage: { prompt_tokens: 900, completion_tokens: 10 } },
      { content: '压缩摘要', usage: { prompt_tokens: 20, completion_tokens: 5 } },
      { content: '基于摘要完成', usage: { prompt_tokens: 30, completion_tokens: 5 } },
    ];
    let usageDrivenDone = null;
    await runAgent({
      messages: [{ role: 'user', content: 'x'.repeat(20) }, ...filler],
      model: { ...model, model: { ...model.model, context_window: 1100 } },
      systemPrompt: 'sys', // 缩小 system 体积，隔离估算变量
      toolHandlers: makeToolHandlers(),
      onMessage: () => {},
      onDone: (t) => { usageDrivenDone = t; },
    });
    check('真实 usage 触发压缩（第二轮 chat 为摘要请求）',
      chatCalls[1]?.tools === undefined && chatCalls[1]?.messages?.length === 1, `chat 轮数=${chatCalls.length}`);
    check('真实 usage 驱动后正常完成', usageDrivenDone === '基于摘要完成');

    // 14.5 截断标记与对象结果完整性（P1-B / TC-QA-006）
    const clipped = truncateToolResult('a'.repeat(20000), 15000);
    check('字符串截断带标记', clipped.length < 20000 && clipped.includes('已截断，共 20000 字符') && clipped.includes('offset/limit'));
    check('未超限字符串原样返回', truncateToolResult('short') === 'short');
    const objOut = truncateToolResult({ ok: true, stdout: 'b'.repeat(20000), stderr: '', exitCode: 0 }, 15000);
    let objParsed = null;
    try { objParsed = JSON.parse(objOut); } catch (e) { /* 中间下刀会解析失败 */ }
    check('对象结果 JSON 完整可解析（不在中间下刀）', objParsed?.ok === true && typeof objParsed?.stdout === 'string');
    check('对象结果超限字段带截断标记', String(objParsed?.stdout).includes('已截断'));
    check('小对象原样序列化', truncateToolResult({ a: 1 }) === '{"a":1}');
    reset();
    chatScript = [
      { content: '跑', tool_calls: [{ id: 'tr1', function: { name: 'shell', arguments: '{"command":"cat big"}' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
      { content: '完成', usage: { prompt_tokens: 5, completion_tokens: 1 } },
    ];
    const longShellHandlers = makeToolHandlers();
    longShellHandlers.shell = async () => ({ stdout: 'c'.repeat(20000), stderr: '', exitCode: 0 });
    const toolMsgs = [];
    await runAgent({
      messages: [{ role: 'user', content: '读大文件' }],
      model, cwd: '/tmp/project',
      toolHandlers: longShellHandlers,
      onMessage: (m) => { if (m.role === 'tool') toolMsgs.push(m); },
      onDone: () => {},
    });
    let trParsed = null;
    try { trParsed = JSON.parse(toolMsgs[0]?.content || ''); } catch (e) { /* 截断破坏 JSON 即失败 */ }
    // Phase 3-3：超长输出现走「摘要化」（PASS 折叠 + 头尾保留 + 原文落盘），
    // 落盘后总长约 6k < 15k 截断阈值——断言改为摘要化标记 + JSON 完整 + 原文可取回
    check('循环内超长工具结果带摘要化标记且 JSON 完整', !!trParsed
      && String(trParsed.stdout).includes('长输出摘要化')
      && String(trParsed.stdout).includes('mjcode-tool-outputs'));

    // 14.6 续期指令旁路注入：走**末条 user 消息**，不进 convo（不污染会话历史）
    // 2026-10-18（P1-4）：注入通道从「拼进首条 system」改为「追加末条 user」——
    // 拼 system 会当轮把稳定前缀打废（prompt cache 全失效），且中段 system 是 DeepSeek 系的硬坑。
    // 断言随之改为「末条消息是 user 且含续期文案」+「convo（onMessage 持久化流）内无该文案」。
    reset();
    chatScript = [
      ...Array.from({ length: 4 }, (_, i) => ({
        content: `第${i + 1}步`, tool_calls: [{ id: `n${i}`, function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })),
      { content: '全部完成', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    let noticeDone = null;
    const persistedMsgs = [];
    await runAgent({
      messages: [{ role: 'user', content: '连续干活' }],
      model, cwd: '/tmp/project', maxRounds: 2,
      toolHandlers: makeToolHandlers(),
      onMessage: (m) => { persistedMsgs.push(m); },
      onDone: (t) => { noticeDone = t; },
    });
    const lastMsgIsRenewUser = chatCalls.some((c) => {
      const msgs = c.messages || [];
      const last = msgs[msgs.length - 1];
      return last?.role === 'user' && String(last.content).includes('预算已续期');
    });
    const systemNotice = chatCalls.some((c) => String(c.messages?.[0]?.content || '').includes('预算已续期'));
    const convoHasNotice = persistedMsgs.some((m) => String(m.content || '').includes('预算已续期'));
    check('续期指令走末条 user 消息（不动稳定前缀）', lastMsgIsRenewUser);
    check('续期指令不进 convo（重进线程看不到该旁路文案）', !convoHasNotice);
    check('续期指令不再拼进首条 system（拼进去当轮前缀全失效）', !systemNotice);
    check('旁路注入后任务正常完成', noticeDone === '全部完成');

    // 14.7 token 预算双闸（2026-10-17 语义修正）
    // 旧语义：预算达 70% → 无论上下文多小都强制压缩续跑。
    // 真机事故（用户实测「取 10 条最新新闻」）：27k 上下文被压成 376 tokens 摘要，新闻原文丢失，
    // 模型只能重搜 → 再撞闸再压 → 「后台一直在压缩、还没有任何输出」。
    // 新语义：预算压力 + 上下文不够大（< 窗口 35%）→ **只开新预算窗口，不压缩**，本轮结果照常消费。
    reset();
    chatScript = [
      { content: '第一步', tool_calls: [{ id: 'b1', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }], usage: { prompt_tokens: 70, completion_tokens: 40 } },
      { content: '第二步', tool_calls: [{ id: 'b2', function: { name: 'shell', arguments: '{"command":"echo 2"}' } }], usage: { prompt_tokens: 70, completion_tokens: 40 } },
      { content: '（默认回复）', usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ];
    let tokenDone = null;
    const tokenBudgets = [];
    await runAgent({
      messages: [{ role: 'user', content: '烧 token 的活' }, ...filler],
      model, cwd: '/tmp/project', maxRounds: 10, tokenBudget: 100,
      toolHandlers: makeToolHandlers(),
      onMessage: () => {},
      onBudget: (s) => tokenBudgets.push(s),
      onDone: (t) => { tokenDone = t; },
    });
    check('预算压力下不压缩小上下文（无摘要请求）',
      chatCalls.every((c) => (c.messages || []).length > 1), `chat 轮数=${chatCalls.length}`);
    check('预算窗口重置即触发救援计数（rescues ≥1）',
      Math.max(...tokenBudgets.map((s) => s.rescues || 0)) >= 1, `rescues=${tokenBudgets.map((s) => s.rescues).join(',')}`);
    check('救援后续跑直至正常收尾（不再单次救援即熔断）',
      tokenDone === '（默认回复）' && !String(tokenDone).includes('token 预算已用尽'), String(tokenDone).slice(-50));

    // 14.8 总轮次硬顶：maxRounds 尚有余额也被 maxTotalRounds 拦截
    reset();
    chatScript = [
      ...Array.from({ length: 6 }, (_, i) => ({
        content: `步骤${i + 1}`, tool_calls: [{ id: `h${i}`, function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })),
    ];
    let capDone = null;
    await runAgent({
      messages: [{ role: 'user', content: '干不完' }],
      model, cwd: '/tmp/project', maxRounds: 5, maxTotalRounds: 3,
      toolHandlers: makeToolHandlers(),
      onMessage: () => {},
      onDone: (t) => { capDone = t; },
    });
    check('总轮次硬顶拦截（3 轮后收）',
      chatCalls.length === 3 && String(capDone).includes('轮次预算已用尽'), `chat 轮数=${chatCalls.length}`);
    check('AGENT_HARD_ROUND_CAP 导出且为 120', AGENT_HARD_ROUND_CAP === 120);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
