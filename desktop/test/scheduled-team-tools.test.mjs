// 定时 / 无人值守通道的团队能力（FIX-P04）
//
// 审计原文：「定时通道里没有 team_*、没有名册，orchestrate_task 建的是匿名 Worker 组
// ⇒ 团队只在你坐在电脑前点派活时才存在」。
//
// 实测定位到两处断点：
//  ① 引擎只认 `runAgent({ teamContext })` 才通告 TEAM_TOOLS（agent-core/index.js:2828
//     `if (teamContext && !customTools)`）；而定时通道的 runParams 只有 { messages, memories }
//     ⇒ 模型连 team_* 的 schema 都看不到。
//  ② main.js 定时 runAgent 的 toolHandlers 把 teamTools 当成了**映射里的一级键**
//     （`...(schedCtx.teamTools ? { teamTools: schedCtx.teamTools } : {})`），而 scheduledToolHandlers
//     的契约是把它当**入参**再展开成 5 个工具名 ⇒ 映射里只有无用的 `teamTools` 对象，
//     teamListMembers 等五个键一个都不存在。
//
// RB-1 / D1（2026-10-24 返工）：本套件对断点②的断言已从「实参里有没有 teamTools: 这个键名」
// 改为**行为断言**——直接执行 main.js 里那段真实的 toolHandlers 装配源码（抽取对象字面量 +
// 注入依赖求值），再把产出的工具表交给 agent-core 的 runAgent，断言：
//   · 产出的映射里 5 个 team_* 都是可调用函数；
//   · 引擎通告给模型的 tools 列表里真的出现这 5 个 schema（可用性闸按 handler 判定，缺 handler 会被剔除）；
//   · 模型发起 team_list_members 调用时**能穿透到 handler**拿到名册（而不是「通道不可用」）。
// 这样把 main.js 的 `teamTools: schedCtx.teamTools` 改成 `null`，本套件必红（已实测，见报告）。
//
// 本套件同时守住安全不变量：**没声明 team_id 就不得静默升级为团队执行**
// （无人值守纪律③，见 main/scheduledTeam.js 头注释）。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scheduledTeam = require(path.join(DESKTOP, 'main/scheduledTeam.js'));
const { scheduledToolHandlers } = require(path.join(DESKTOP, 'main/scheduledTools.js'));
const { createTeamToolHandlers } = require(path.join(DESKTOP, 'main/teamTools.js'));
const { runAgent } = await import(path.join(DESKTOP, 'agent-core/index.js'));

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const TEAM = {
  id: 'team-1', name: '内容军团', description: '写作与审核',
  defaultMode: 'lead', budget: { max_rounds: 12, max_tokens: 200000 },
  archivedAt: null,
  leadMemberId: 'm1',
  members: [
    { id: 'm1', name: '主管', roleKind: 'lead', tools: [], skills: [] },
    { id: 'm2', name: '写手', roleKind: 'member', tools: [], skills: [] },
  ],
};
const stubTeamStore = { getTeam: (id) => (id === TEAM.id ? TEAM : null) };
// scheduledToolHandlers 构造期就会解引用 prTools.*（其余工具在调用期才用），故给最小桩
const STUB_PR = {
  prList: async () => ({ ok: true }), prView: async () => ({ ok: true }), prDiff: async () => ({ ok: true }),
  prReview: async () => ({ ok: true }), prComment: async () => ({ ok: true }),
};
const baseDeps = (teamTools) => ({
  prTools: STUB_PR, teamTools,
  // 引擎会用到的通道：只给最小可运行集（本套件只关心 team_*）
  toolShell: async () => ({ stdout: '' }),
  toolReadFile: async () => ({ content: '' }),
  runWriteTool: async () => ({ ok: true }),
  toolListDir: async () => [],
  toolGrep: async () => ({ matches: '' }),
  toolGlob: async () => ({ files: [] }),
  toolGitStatus: async () => ({ stdout: '' }),
  toolGitDiff: async () => ({ stdout: '' }),
  toolGitLog: async () => ({ stdout: '' }),
  toolGitBranch: async () => ({ stdout: '' }),
  toolGitCommit: async () => ({ stdout: '' }),
  toolGitAdd: async () => ({ stdout: '' }),
  callMcpTool: async () => ({ content: [] }),
  webTools: { webSearch: async () => ({}), webFetch: async () => ({}) },
});
const handlersOf = (teamTools) => scheduledToolHandlers({ unattended: true, contextCwd: '/tmp/out', ...baseDeps(teamTools) });

function prepare(extra = {}) {
  return scheduledTeam.prepareScheduledRun({
    prompt: '写一份周报', taskId: 'tk1', taskName: '周报', outputDir: '/tmp/out',
    getTeamStore: () => stubTeamStore,
    localStore: null, memoryManager: null,
    orchestrator: {}, workerPool: { waitTask: () => ({}) }, taskStore: {},
    waitGroupSettled: null, humanizeGroupResult: null,
    createTeamToolHandlers, postTeamMessage: () => ({}),
    ...extra,
  });
}

// ── 从 main.js 抽真实装配源码 ────────────────────────────────────────────
// 为什么抽源码求值：本套件要能「被 main.js 的改动杀死」。若自己照抄一份装配，
// 把 main.js 改成 teamTools: null 也不会红——那就又变成自指判据。
const MAIN_SRC = fs.readFileSync(path.join(DESKTOP, 'main/main.js'), 'utf8');
const TEAM_HANDLER_KEYS = ['teamListMembers', 'teamSendMessage', 'teamBoard', 'teamWait', 'teamReadMessages'];
const TEAM_TOOL_NAMES = ['team_list_members', 'team_send_message', 'team_board', 'team_wait', 'team_read_messages'];

/** 从 startIdx 处的开括号起，返回配对闭括号的下标（跳过字符串/模板串/注释里的括号）。 */
function matchBracket(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { // 跳过字符串/模板串
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { // 行注释
      const nl = src.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') { // 块注释
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 取出 runScheduledAgentTask 里 toolHandlers 的对象字面量源码。 */
function extractScheduledToolHandlersLiteral() {
  const start = MAIN_SRC.indexOf('async function runScheduledAgentTask(');
  assert.ok(start > 0, 'main.js 里找不到 runScheduledAgentTask（结构变了就要同步本抽取器）');
  const bodyEnd = matchBracket(MAIN_SRC, MAIN_SRC.indexOf('{', MAIN_SRC.indexOf(')', start)));
  const body = MAIN_SRC.slice(start, bodyEnd > 0 ? bodyEnd : undefined);
  // ── 外层窗口（runScheduledAgentTask 的函数体）同样要两条路径互证 ────────────
  // 只有内层字面量的守卫不够：这个窗口是「在里面找 marker」的搜索范围，它一旦外扩，
  // body 就不再是这个函数自己的体 —— 后面 indexOf(marker) 命中的可能是**被吞进来的
  // 别的函数**里的同款装配，那时「定时通道的装配被删了」也照样绿。
  // OVR-3b 实测：外层窗口外扩（掉到文件尾 matchBracket 返回 -1，或落到文件内某个 }）
  // ⇒ 无本守卫时 exit=0 / 5/5 **静默放行**；有本守卫才红（括号配对算到 61336 vs 缩进层级 61025）。
  const fnLineStart = MAIN_SRC.lastIndexOf('\n', start) + 1;
  const fnIndent = /^\s*/.exec(MAIN_SRC.slice(fnLineStart))[0];
  const fnCloseAt = MAIN_SRC.indexOf(`\n${fnIndent}}`, start);
  assert.ok(bodyEnd > 0, 'runScheduledAgentTask 的函数体括号未配对（窗口一路吃到文件尾了？）');
  assert.ok(fnCloseAt > start, `找不到缩进层 ${JSON.stringify(fnIndent)} 的闭合花括号（runScheduledAgentTask 的缩进层级变了？）`);
  const fnEndByIndent = fnCloseAt + 1 + fnIndent.length;
  assert.equal(bodyEnd, fnEndByIndent,
    `runScheduledAgentTask 函数体窗口的两条路径不一致：括号配对算到 ${bodyEnd}，缩进层级算到 ${fnEndByIndent}`
    + `（多半是配对漏跳了字符串/注释导致窗口外扩，body 已经不是这个函数自己的体）`);
  const marker = 'toolHooks.wrap(sguard.wrap(';
  const at = body.indexOf(marker);
  assert.ok(at > 0, '定时通道里找不到 toolHooks.wrap(sguard.wrap(...)) 装配（结构变了就要同步本抽取器）');
  const objStart = body.indexOf('{', at + marker.length);
  assert.ok(objStart > 0, 'toolHandlers 装配不是对象字面量形态');
  const objEnd = matchBracket(body, objStart);
  assert.ok(objEnd > objStart, 'toolHandlers 对象字面量括号未配对');
  // ── 窗口边界的形态不变量：必须由两条**互相独立**的路径算出来并一致（与 stop-thread-work 同款）──
  // A = 括号配对（跳字符串/模板串/注释）；B = 缩进层级（不跳任何东西，只看行首）。
  // A 漏跳字符串或注释 ⇒ 深度溢出 ⇒ 配对点滑到后面某个 `}` ⇒ 窗口外扩吃到相邻键/相邻代码。
  // 注意：外扩后 `new Function` 会**不会**炸取决于片段凑巧语法合不合法 —— OVR-3 实测是炸了
  // （`Unexpected token ')'`）才红的。**那是被求值崩溃拦住的（第 2 类），不是被断言拦住的**；
  // 换个布局让外扩片段语法仍合法就全绿。故必须补这条形态不变量。
  const objLineStart = body.lastIndexOf('\n', objStart) + 1;
  const objIndent = /^\s*/.exec(body.slice(objLineStart))[0];
  const objCloseAt = body.indexOf(`\n${objIndent}}`, objStart);
  assert.ok(objCloseAt > objStart, `找不到缩进层 ${JSON.stringify(objIndent)} 的闭合花括号（toolHandlers 的缩进层级变了？）`);
  const objEndByIndent = objCloseAt + 1 + objIndent.length;
  assert.equal(objEnd, objEndByIndent,
    `toolHandlers 字面量的两条路径不一致：括号配对算到 ${objEnd}，缩进层级算到 ${objEndByIndent}`
    + `（多半是配对漏跳了字符串/注释导致窗口外扩，抽到的已经不是这个对象字面量本身）`);
  const literal = body.slice(objStart, objEnd + 1);
  // 直接表达「窗口没吃到相邻键 / 相邻顶层声明」：字面量内部（去掉两端花括号）不得出现
  // 与外层**同一缩进层**的 `key:` 行 —— 本字面量的属性在下一层，出现同层键说明吃进外层去了。
  const inner = literal.slice(1, -1);
  const siblingKeyRe = new RegExp(`^${objIndent}[A-Za-z_$][\\w$]*\\s*:`, 'm');
  assert.ok(!siblingKeyRe.test(inner),
    `抽到的 toolHandlers 字面量里混进了外层同缩进层的键（窗口吃到相邻键了）：${inner.slice(0, 160)}`);
  assert.ok(literal.includes('scheduledToolHandlers('), `抽到的装配里没有 scheduledToolHandlers：${literal.slice(0, 120)}`);
  return literal;
}

/**
 * 执行 main.js 的真实装配，得到定时通道最终交给 runAgent 的工具表。
 * 依赖全部由调用方注入（不连 Electron、不连 DB）。
 */
function buildHandlersFromMainJs({ schedCtx, schedModel = { cwd: '/tmp/out' }, rc = { dir: '/tmp/out' }, taskId = 'tk1', signal, scheduledAgentChat, toolOrchestrateTask }) {
  const literal = extractScheduledToolHandlersLiteral();
  const make = new Function(
    'scheduledToolHandlers', 'scheduledAgentChat', 'signal', 'schedCtx', 'schedModel', 'rc', 'taskId', 'toolOrchestrateTask',
    `return (${literal});`,
  );
  return make(
    (deps = {}) => scheduledToolHandlers({ unattended: true, contextCwd: schedModel.cwd, ...baseDeps(deps.teamTools) }),
    scheduledAgentChat, signal, schedCtx, schedModel, rc, taskId,
    toolOrchestrateTask || (async () => ({ ok: true })),
  );
}

(async () => {
  // ── ① 引擎通告面：runParams 是否带 teamContext ──────────────────────────
  await check('声明了 team_id：runParams 必须带 teamContext（否则引擎不通告 TEAM_TOOLS）', () => {
    const ctx = prepare({ teamId: TEAM.id });
    assert.ok(ctx.runParams && ctx.runParams.teamContext,
      `runParams 缺 teamContext —— 引擎不会追加 team_* schema（当前键：${Object.keys(ctx.runParams || {}).join(',')}）`);
    assert.equal(ctx.runParams.teamContext.teamId, TEAM.id);
    assert.ok(ctx.runParams.teamContext.runId, 'teamContext 需要 runId');
    assert.ok(ctx.runParams.teamContext.taskId, 'teamContext 需要 taskId');
  });

  // ── ② main.js 真实装配 → 工具表里有 5 个可调用的 team_* ─────────────────
  await check('main.js 定时装配产出：5 个 team_* handler 存在且真能取到名册', () => {
    const ctx = prepare({ teamId: TEAM.id });
    const handlers = buildHandlersFromMainJs({ schedCtx: ctx, scheduledAgentChat: async () => ({ content: 'x' }) });

    for (const key of TEAM_HANDLER_KEYS) {
      assert.equal(typeof handlers[key], 'function', `main.js 装配产出的工具表缺 ${key}（模型看不到也调不到）`);
    }
    // 反向：不得再有「把整个 teamTools 对象当成一个工具名」的残留键
    assert.equal(handlers.teamTools, undefined, '工具表里不应存在名为 teamTools 的键（那是缺陷形态）');

    // 真调用一次：名册必须能读出来（不是只有函数壳子）
    const roster = handlers.teamListMembers();
    assert.equal(roster.ok, true, `teamListMembers 应成功：${JSON.stringify(roster)}`);
    assert.deepEqual(roster.members.map((m) => m.name).sort(), ['主管', '写手'].sort(), '名册成员应与团队一致');
  });

  // ── ③ 端到端到「模型可见工具表」：schema 通告 + 调用穿透 ─────────────────
  await check('引擎通告面：5 个 team_* schema 出现在下发给模型的 tools 里，且调用能穿透到 handler', async () => {
    const ctx = prepare({ teamId: TEAM.id });
    const chatCalls = [];
    const script = [
      { content: '', tool_calls: [{ id: 'c1', function: { name: 'team_list_members', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { content: '已拿到名册', usage: { prompt_tokens: 12, completion_tokens: 6 } },
    ];
    const handlers = buildHandlersFromMainJs({
      schedCtx: ctx,
      scheduledAgentChat: async (payload) => { chatCalls.push(payload); return script.shift() || { content: '（结束）', usage: {} }; },
    });

    const emitted = [];
    await runAgent({
      messages: ctx.runParams.messages,
      model: { provider: { id: 'p1', isGlobal: false, base_url: 'https://gw.example/v1' }, model: { id: 1, model_id: 'stub-model', context_window: 128000 } },
      cwd: '/tmp/out',
      approvalMode: 'auto-safe',
      conversationId: 'scheduled:tk1',
      maxRounds: 4,
      toolHandlers: handlers,
      teamContext: ctx.runParams.teamContext,
      onMessage: (m) => emitted.push(m),
    });

    const advertised = (chatCalls[0] && Array.isArray(chatCalls[0].tools)) ? chatCalls[0].tools.map((t) => t.function.name) : [];
    const missing = TEAM_TOOL_NAMES.filter((n) => !advertised.includes(n));
    assert.deepEqual(missing, [], `模型可见工具表缺 team_* schema：${missing.join(',')}（实际 ${advertised.length} 个工具）`);

    // 调用真的穿透到 handler：tool 消息里应带名册内容，而不是「通道不可用」
    const toolMsg = emitted.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '没有产生 tool 结果消息：调用没有落到任何 handler');
    const content = String(toolMsg.content || '');
    assert.ok(!/通道不可用|未知工具|no_handler/i.test(content), `调用没穿透到 handler：${content.slice(0, 200)}`);
    assert.ok(content.includes('主管') && content.includes('写手'), `tool 结果里没有名册内容：${content.slice(0, 200)}`);
  });

  // ── ④ 安全不变量：没声明 team_id 不得静默团队化 ──────────────────────────
  await check('未声明 team_id：不注入 teamTools / teamContext（不静默升级为团队执行）', () => {
    const ctx = prepare({});
    assert.equal(ctx.teamTools, null, '未声明 team_id 时不应产出 teamTools');
    assert.equal(ctx.teamHandler, null, '未声明 team_id 时不应产出团队派活通道');
    assert.equal(ctx.runParams.teamContext || null, null, '未声明 team_id 时不应带 teamContext');
    const handlers = handlersOf(ctx.teamTools);
    for (const key of TEAM_HANDLER_KEYS) {
      assert.equal(handlers[key], undefined, `未声明 team_id 时不应出现 ${key}`);
    }
  });

  // ── ⑤ 团队不可用 ⇒ fail-closed（不悄悄跑成匿名组）───────────────────────
  await check('team_id 指向不存在的团队：直接抛错（不悄悄跑成匿名组）', () => {
    assert.throws(() => prepare({ teamId: 'no-such-team' }), /军团不可用/);
  });

  console.log(`\n${pass}/${total} 通过`);
})();
