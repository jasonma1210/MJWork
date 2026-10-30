#!/usr/bin/env node
// 探针：T2 修复前后的对照——「一轮里并发多个工具」时压缩还能不能真的压下来。
//
// 事故形态（2026-10-17，用户实测）：
//   旧实现用「条数」选尾部保留区（keepTail=6），切点 cut = body.length - 6；
//   若切点落在 tool 消息上，alignCutToRoundBoundary 会**向后**移动——极端情况下移到 body 末尾，
//   于是 `cut >= body.length` → 放弃压缩、原样返回 convo。
//   而调用方（agent-core 的 compact 分支）只看 gate 判定，不看压缩是否真的发生，
//   仍然「tokenWindowSpent = 0」清零重来 → 每 5 轮白撞一次，上下文一分没省，
//   最终 21 轮烧到 1.6M tokens 触发熔断。
//
// 修复后（尾部按体积预算 + 切点恒落在轮边界）：B/C 场景必须显著下降。
// 本脚本保留为**人工诊断**用途（打印三档对照），回归门禁见 test/compact-tail-budget.test.mjs。
//
// 用法：node scripts/probe-compact-noop.mjs
import { compactHistory, estimateMessagesTokens } from '../agent-core/index.js';

const CTX = 128000;
const model = { provider: { id: 'probe' }, model: { model_id: 'probe-model', context_window: CTX } };

const fill = (n) => '压'.repeat(n); // 中文按 1 字 ≈ 1 token 计（estimateTokens 口径）

// 每条工具结果 800 tokens；一轮 = assistant(tool_calls) + toolsPerRound 条 tool
function makeRound(i, toolsPerRound, perTool = 800) {
  const calls = Array.from({ length: toolsPerRound }, (_, k) => ({
    id: `call-${i}-${k}`,
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}-${k}.js` }) },
  }));
  const assistant = { role: 'assistant', content: `第 ${i} 轮：读取 ${toolsPerRound} 个文件`, tool_calls: calls };
  const tools = calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: fill(perTool) }));
  return [assistant, ...tools];
}

function build(convoyLastRoundTools) {
  const convo = [
    { role: 'system', content: `你是 MJCode 引擎。${fill(9000)}` },
    { role: 'user', content: '把这些文件里的问题都修掉，然后跑测试。' },
  ];
  for (let i = 0; i < 30; i += 1) {
    // 最后一轮故意给多个并发工具调用（真实场景：一次读 8 个文件）
    const n = i === 29 ? convoyLastRoundTools : 3;
    convo.push(...makeRound(i, n));
  }
  return convo;
}

let summaryCalls = 0;
const chatFn = async () => {
  summaryCalls += 1;
  return { content: '【已完成】读取了若干文件。【待办】继续修复。' };
};

async function probe(label, lastRoundTools) {
  const convo = build(lastRoundTools);
  const before = estimateMessagesTokens(convo);
  summaryCalls = 0;
  const out = await compactHistory(convo, model, chatFn, { knownTokens: before, force: true });
  const after = estimateMessagesTokens(out);
  return {
    label,
    msgs: convo.length,
    before,
    after,
    ratio: `窗口 ${Math.round((before / CTX) * 100)}%`,
    sameRef: out === convo,
    saved: before - after,
    summaryCalls,
  };
}

const rows = [];
// A：最后一轮 3 个工具（切点落在 assistant 上，可正常压缩）
rows.push(await probe('A 末轮 3 个工具（正常情形）', 3));
// B：最后一轮 8 个工具 → 尾部连续 8 条 tool，keepTail=6 的切点整体落在 tool 上
rows.push(await probe('B 末轮 8 个工具（并发读文件）', 8));
// C：最后一轮 12 个工具
rows.push(await probe('C 末轮 12 个工具', 12));

console.log('场景'.padEnd(34), '消息数'.padStart(5), '压缩前'.padStart(8), '压缩后'.padStart(8), '省下'.padStart(7), '  实际动作');
for (const r of rows) {
  const action = r.sameRef
    ? `❌ 未压缩（返回原历史，摘要调用 ${r.summaryCalls} 次）`
    : `✅ 已压缩（摘要调用 ${r.summaryCalls} 次）`;
  console.log(r.label.padEnd(34), String(r.msgs).padStart(5), String(r.before).padStart(8), String(r.after).padStart(8), String(r.saved).padStart(7), ' ', action);
}

const pctOf = (r) => (r.before > 0 ? Math.round((r.saved / r.before) * 100) : 0);
const b = rows.find((r) => r.label.startsWith('B'));
const c = rows.find((r) => r.label.startsWith('C'));
console.log('\n判读（修复后预期：三档都应压下来，且 B/C 不得为 0）：');
for (const r of rows) {
  console.log(`  ${r.label}：省 ${r.saved}（${pctOf(r)}%）${r.saved === 0 ? ' ⚠ 未压缩，切点可能又退回条数制' : ''}`);
}
if (b.saved > 0 && c.saved > 0) {
  console.log('  ✅ 并发工具场景已能压缩：体积预算 + 切点落在轮边界生效。');
} else {
  console.log('  ❌ 并发工具场景仍未压缩，T2 修复失效。');
  process.exitCode = 1;
}
