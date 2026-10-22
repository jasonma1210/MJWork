// T0-2 回归门禁：IPC/Agent 边界契约（shared-ipc/contract.mjs 单一事实来源）
// 覆盖：7 类 agent:event 合法形状 / 非法形状逐类拒收 / 降级信封 / agent:run 载荷校验
import {
  validateAgentEvent, safeAgentEventEnvelope, validateAgentRunPayload, AGENT_EVENT_SCHEMAS,
} from '../shared-ipc/contract.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const R = 'run-1';
const valid = (type, data) => ({ runId: R, type, data });

(async () => {
  // ── 7 类事件合法形状全部放行（与 agentRunner 真实发送形状一一对应）──
  check('message 事件合法', validateAgentEvent(valid('message', { role: 'assistant', content: 'hi', tool_calls: [{ id: 'c1' }], tokens_input: 5, tokens_output: 2 })).ok);
  check('stream 事件合法', validateAgentEvent(valid('stream', '')).ok);
  check('tool_call 事件合法', validateAgentEvent(valid('tool_call', { name: 'shell', args: { command: 'ls' }, result: { stdout: 'ok' } })).ok);
  check('todos 事件合法', validateAgentEvent(valid('todos', { todos: [{ content: 'a', status: 'pending' }], doneCount: 0, total: 1 })).ok);
  check('suspended 事件合法', validateAgentEvent(valid('suspended', { saved: true, kind: 'tokens', summary: 's', roundsUsed: 3, rescues: 1, windowSpent: 9, budget: 10 })).ok);
  // P0-3（2026-10-22）：整任务墙钟触顶必须合法。引擎侧真实发送 kind:'wallclock'
  //（agent-core/index.js），枚举缺它 ⇒ 事件被安全降级成 error ⇒ 渲染层 reject 整轮
  // ⇒ 任何超过默认 30 分钟的任务必现「IPC 契约校验失败」。这条钉住枚举与生产方对齐。
  check('suspended 事件合法（kind=wallclock，整任务墙钟）',
    validateAgentEvent(valid('suspended', { saved: true, kind: 'wallclock', summary: 's', roundsUsed: 3, rescues: 1, windowSpent: 9, budget: 10 })).ok);
  check('done 事件合法（含 usage/mainPersisted）', validateAgentEvent(valid('done', { finalText: '完成', usage: { prompt_tokens: 1, completion_tokens: 1 }, aborted: false, mainPersisted: true })).ok);
  check('error 事件合法（字符串载荷）', validateAgentEvent(valid('error', '炸了')).ok);
  // T1-3：subagent 事件（spawn_subagent / orchestrate_task 生命周期）
  check('subagent spawn 事件合法', validateAgentEvent(valid('subagent', { tool: 'spawn_subagent', phase: 'spawn', objective: '找入口', taskType: 'explore', tokens: 0, round: 0 })).ok);
  check('subagent done 事件合法（tokens/summary/ms）', validateAgentEvent(valid('subagent', { tool: 'spawn_subagent', phase: 'done', objective: 'x', tokens: 120, budgetKind: 'normal', round: 2, ms: 3400, summary: '结论' })).ok);
  check('subagent 编排事件合法（groupId/taskId/title）', validateAgentEvent(valid('subagent', { tool: 'orchestrate_task', groupId: 'g1', taskId: 't1', title: '子任务', phase: 'failed', error: '超时' })).ok);
  check('subagent 非法 phase 被拒', !validateAgentEvent(valid('subagent', { tool: 'orchestrate_task', phase: 'running' })).ok);
  check('subagent 非法 tool 被拒', !validateAgentEvent(valid('subagent', { tool: 'unknown_tool', phase: 'spawn' })).ok);
  // 登记表完整性：用**名称集合**断言，不用 `.length === N`。
  // 为什么：数量断言只会告诉你「数字不对」，容易被顺手把 8 改成 9/10 了事；
  // 名称集合会在新增事件时强制审视「这个新事件是否该被登记、消费方是否已适配」——
  // 那正是 mcp_status 死信的同型风险（有生产方、没人核对登记完整性）。
  // 2026-10-18：V 层 N7 注册补入 verify / verify_ledger（未注册会被 safeAgentEventEnvelope
  // 降级成用户可见的 error 事件），故期望集合由 8 类扩为 10 类。
  const eventNames = Object.keys(AGENT_EVENT_SCHEMAS).sort();
  const EXPECTED_EVENT_TYPES = [
    'done', 'error', 'message', 'stream', 'subagent',
    'suspended', 'todos', 'tool_call', 'verify', 'verify_ledger',
  ].sort();
  check('事件类型登记表完整（名称集合，10 类）',
    JSON.stringify(eventNames) === JSON.stringify(EXPECTED_EVENT_TYPES),
    `实际=[${eventNames.join(',')}]`);

  // ── 非法形状逐类拒收 + 可读原因 ──
  const bad1 = validateAgentEvent(valid('message', { content: '缺 role' }));
  check('message 缺 role 被拒', !bad1.ok && /role/.test(bad1.error), bad1.error);
  const bad2 = validateAgentEvent(valid('done', { finalText: 'x' })); // 缺 aborted
  check('done 缺 aborted 被拒（漂移即拦截）', !bad2.ok && /aborted/.test(bad2.error), bad2.error);
  const bad3 = validateAgentEvent({ runId: R, type: 'delta', data: 'x' });
  check('未登记事件类型被拒（防漂移设计）', !bad3.ok && /type/.test(bad3.error), bad3.error);
  const bad4 = validateAgentEvent({ type: 'stream', data: '' }); // 缺 runId
  check('缺 runId 信封被拒', !bad4.ok);
  const bad5 = validateAgentEvent(valid('tool_call', { name: '', args: {}, result: {} }));
  check('tool_call 空 name 被拒', !bad5.ok);
  const bad6 = validateAgentEvent(valid('suspended', { saved: true, kind: 'weird', summary: '', roundsUsed: 0, rescues: 0, windowSpent: 0, budget: 0 }));
  check('suspended 非法 kind 被拒', !bad6.ok && /kind/.test(bad6.error));

  // ── 降级信封：非法 → 同 runId error 事件（绝不静默丢弃）──
  const down = safeAgentEventEnvelope(valid('done', { finalText: 'x' }));
  check('非法事件降级为 error 信封', down.type === 'error' && /契约校验失败/.test(down.data), String(down.data).slice(0, 60));
  check('降级保留原 runId', down.runId === R);
  const downNoRun = safeAgentEventEnvelope({ type: 'done', data: {} });
  check('连 runId 都缺失时降级仍给出信封', downNoRun.type === 'error' && downNoRun.runId === 'unknown-run');

  // ── agent:run 启动载荷 ──
  const goodPayload = {
    runId: R,
    messages: [{ role: 'user', content: 'hi' }],
    model: { provider: { id: 1, isGlobal: false, base_url: 'https://x' }, model: { id: 1, model_id: 'deepseek-chat', context_window: 128000 } },
    cwd: '/tmp/p', conversationId: 'c1', approvalMode: 'on-request', sandboxPolicy: 'workspace-write',
    planMode: false, tokenBudget: 600000, resumeContext: '', mcpTools: [], enabledSkills: [], skills: [], memories: [],
  };
  check('真实形状启动载荷放行', validateAgentRunPayload(goodPayload).ok);
  check('passthrough 允许未知可选字段透传', validateAgentRunPayload({ ...goodPayload, futureField: 1 }).ok);
  check('空 messages 被拒', !validateAgentRunPayload({ ...goodPayload, messages: [] }).ok);
  const flat = validateAgentRunPayload({ ...goodPayload, model: { providerId: 1, baseUrl: 'x', model: 'm' } });
  check('扁平形 model 被拒（引擎入口 TypeError 历史根因）', !flat.ok && /model/.test(flat.error), flat.error);
  check('非法 approvalMode 被拒', !validateAgentRunPayload({ ...goodPayload, approvalMode: 'yolo' }).ok);
  check('非法 sandboxPolicy 被拒', !validateAgentRunPayload({ ...goodPayload, sandboxPolicy: 'no-sandbox' }).ok);
  check('负 tokenBudget 被拒', !validateAgentRunPayload({ ...goodPayload, tokenBudget: -1 }).ok);
  // P1-4 回归（2026-10-18 第二轮审查）：内层 model schema 必须 passthrough。
  // 引擎真正消费的 context_window / reasoning_effort 就挂在 model.model 上；
  // 若内层 strip，validateAgentRunPayload 返回的 data 会静默丢掉窗口 —— 今天 agentRunner
  // 只用 v.ok 继续用原始 payload 所以无害，但任何人改成消费 r.data 就会复现
  // 「128K 模型按 4K 频繁压缩」事故（P0-1①）。
  {
    const withWin = validateAgentRunPayload({
      ...goodPayload,
      model: { provider: { id: 1 }, model: { model_id: 'deepseek-chat', context_window: 128000, reasoning_effort: 'high' } },
    });
    check('校验结果的 data 保留 context_window / reasoning_effort（内层 passthrough）',
      withWin.ok
      && withWin.data?.model?.model?.context_window === 128000
      && withWin.data?.model?.model?.reasoning_effort === 'high',
      `实际=${JSON.stringify(withWin.data?.model?.model)}`);
  }

  // ── X8：契约未就绪不再放行（源码级反回归）──
  // 事故形态：`if (contract) { validate }` 在 ESM 动态 import 未完成的窗口里
  // 直接跳过校验，畸形载荷可穿透；且这条分支「看起来」是防御代码，很难在评审里发现。
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const MAIN = pathMod.join(pathMod.dirname(pathMod.dirname(new URL(import.meta.url).pathname)), 'main');
  const runnerSrc = fs.readFileSync(pathMod.join(MAIN, 'agentRunner.js'), 'utf8');
  check('agentRunner 不含「契约未就绪则放行」的旧分支', !/if \(contract\) \{\s*const v = contract\.validateAgentRunPayload/.test(runnerSrc));
  check('未就绪时明确拒绝（fail-closed 文案）', /IPC 契约尚未就绪，已拒绝启动/.test(runnerSrc));
  const mainSrc = fs.readFileSync(pathMod.join(MAIN, 'main.js'), 'utf8');
  // T6-6：agent:run 需要先注入 artifactContext 再转交运行器，故从单表达式改为块体。
  // 判据仍锚定「最终交给 startAgentRunWhenReady」这一事实，不锁具体写法。
  check('agent:run 经 startAgentRunWhenReady（先等契约就绪）',
    /agent:run'[\s\S]{0,500}?startAgentRunWhenReady\(/.test(mainSrc));

  console.log(`\nipc-contract: ${pass}/${pass + fail} 通过`);
  if (fail) process.exitCode = 1;
})();
