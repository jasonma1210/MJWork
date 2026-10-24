// 消息字段命名一致性门禁：防止驼峰/蛇形不一致导致模型接口 400
//
// 背景（真实事故）：重载历史线程后发消息，服务端返回
//   `400 Param Incorrect: tool_call_id is not set`
//
// 根因是「两套命名并存」：
//   - 本机数据库（localStore.addMessage）与渲染层用驼峰：toolCallId / toolCalls
//   - OpenAI 兼容接口要求蛇形：tool_call_id / tool_calls
//   - agent-core 直接把 messages 拼进请求体，无归一化 → 历史消息原样透传即报错
//
// 已加 normalizeMessages 兜底，但那只解决运行时。本门禁防的是「新引入同类不一致」：
//   任何直接把 DB / 渲染层消息塞进请求体的路径，都必须先过归一化。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const CORE = path.join(DESKTOP, 'agent-core/index.js');

let pass = 0;
let total = 0;
// RB-2：helper 必须 async —— 同步 helper 收到 async 回调时 `fn()` 返回 Promise（truthy）并 `pass++`，
// 断言失败退化成 unhandled rejection ⇒ 汇总先打印「PASS：N/N 项通过」，随后进程才崩（输出骗人）。
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const src = fs.readFileSync(CORE, 'utf8');

// RB-2：本文件是 CJS（无 top-level await），所有用例包进 async IIFE；
// 任何漏网异常一律置 exitCode=1，不允许出现「打印了 PASS 却崩在最后」。
// 块内刻意不重新缩进：否则整段 60+ 行都会进 diff，掩盖「只改了 await」这个事实。
(async () => {
await check('normalizeMessages 已导出', () => {
  assert.match(src, /export function normalizeMessages/);
});

await check('convo 拼装必须经过归一化', () => {
  // 曾经的 bug：const convo = [{...}, ...messages] —— 历史消息原样透传
  assert.ok(
    !/\.\.\.messages\]/.test(src),
    'agent-core 仍在直接把 messages 展开进 convo，必须先经normalizeMessages',
  );
  assert.match(src, /\.\.\.normalizeMessages\(messages\)\]/, 'convo 应使用 normalizeMessages(messages)');
});

await check('归一化同时处理 tool_call_id 与 tool_calls 两组字段', () => {
  assert.match(src, /raw\.tool_call_id \|\| raw\.toolCallId/, '未兼容 tool_call_id / toolCallId');
  assert.match(src, /raw\.tool_calls \|\| raw\.toolCalls/, '未兼容 tool_calls / toolCalls');
});

await check('孤立 tool_calls 有补链逻辑', () => {
  assert.match(src, /answered\.has\(tc\.id\)/, '缺少补链去重判断');
  assert.match(src, /tool_call_id: tc\.id/, '补链时未写入 tool_call_id');
});

await check('无 id 的 tool 消息被丢弃（fail-closed）', () => {
  assert.match(src, /if \(!id\) continue/, '缺少 id 的 tool 消息应直接丢弃，避免再次触发 400');
});

// 行为验证：直接跑一遍归一化逻辑
let normalize;
await check('行为验证：驼峰 toolCallId 被转为蛇形', async () => {
  const mod = await import(CORE);
  normalize = mod.normalizeMessages;
  assert.equal(typeof normalize, 'function', 'normalizeMessages 不可用');
  const out = normalize([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', toolCallId: 'call_1', content: 'ok' },
  ]);
  const tool = out.find((m) => m.role === 'tool');
  assert.equal(tool.tool_call_id, 'call_1', 'toolCallId 未转为 tool_call_id');
  const asst = out.find((m) => m.role === 'assistant');
  assert.ok(Array.isArray(asst.tool_calls), 'toolCalls 未转为 tool_calls');
});

await check('行为验证：孤立 tool_calls 补占位结果', async () => {
  const mod = await import(CORE);
  const normalize = mod.normalizeMessages;
  const out = normalize([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_9', function: { name: 'x', arguments: '{}' } }] },
  ]);
  const tool = out.find((m) => m.role === 'tool');
  assert.ok(tool, '未补出占位 tool 结果');
  assert.equal(tool.tool_call_id, 'call_9', '占位结果的 tool_call_id 不匹配');
});

await check('行为验证：已有结果时不重复补链', async () => {
  const mod = await import(CORE);
  const normalize = mod.normalizeMessages;
  const out = normalize([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'done' },
  ]);
  assert.equal(out.filter((m) => m.role === 'tool').length, 1, '重复补链了');
});

await check('行为验证：多个 tool_calls 各自配对（不串号）', async () => {
  const mod = await import(CORE);
  const normalize = mod.normalizeMessages;
  const out = normalize([
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a', function: { name: 'x', arguments: '{}' } },
      { id: 'b', function: { name: 'y', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'a', content: 'ra' },
  ]);
  const tools = out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(tools.sort(), ['a', 'b'], 'tool_call_id 配对错乱');
});

await check('行为验证：非数组/空输入不崩', async () => {
  const mod = await import(CORE);
  const normalize = mod.normalizeMessages;
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize(undefined), []);
  assert.deepEqual(normalize([]), []);
});

await check('行为验证：丢弃无 id 的 tool 消息', async () => {
  const mod = await import(CORE);
  const normalize = mod.normalizeMessages;
  const out = normalize([{ role: 'tool', content: 'orphan' }]);
  assert.equal(out.length, 0, '无 id 的 tool 消息应被丢弃');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
})().catch((e) => { console.error(`[FAIL] 未捕获异常 — ${e && e.message}`); process.exitCode = 1; });