// T2 回归门禁：尾部「按条数」保留会让压缩静默失效。
//
// 事故形态（2026-10-17）：keepTail=6 是条数制，切点 body.length-6。
//   长任务里模型一轮并发读 8 个文件 → 末尾连续 8 条 tool 消息 → 切点落在 tool 上
//   → alignCutToRoundBoundary 向**后**移到末尾 → cut >= body.length → 放弃压缩。
//   调用方又不检查结果，照样清零预算窗口 → 每 5 轮空转一次，21 轮烧掉 1.6M tokens。
//
// 本门禁锁三件事：
//   ① 并发工具（8/12 个）场景必须真的压下来（省 >25%）；
//   ② 压缩结果不得出现孤儿 tool 消息（服务端会直接 400）；
//   ③ 调用方必须先确认「压缩真的发生了」才准清零窗口（源码断言，防改回去）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compactHistory, estimateMessagesTokens } from '../agent-core/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.log(`[FAIL] ${name}\n       ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.log(`[FAIL] ${name}\n       ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// A10 守卫辅助：去除 JS 行/块注释（保留 `://` 不被误删），仅保留「生效」源码。
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 预算窗口清零的两种合法写法：① 直接赋值（历史形态）；② `commitBudget({ windowSpent: 0 })`
// 单次提交（2026-10-30 lint 清零时引入——窗口消耗/救援次数/熔断标记收敛到唯一提交点）。
// 两种都认，才能继续锁住「清零必须发生在『压缩真的发生』校验之后」这条不变量：
// 只认旧写法时，改写本身会让 indexOf 返回 -1，报出的是误导性红；只认新写法又会放过历史形态。
const RESET_PATTERNS = [/tokenWindowSpent = 0/, /commitBudget\(\{\s*windowSpent: 0/];
function firstResetIdx(s) {
  return RESET_PATTERNS.reduce((min, re) => {
    const i = s.search(re);
    return i >= 0 && (min < 0 || i < min) ? i : min;
  }, -1);
}

const CTX = 128000;
const model = { provider: { id: 'probe' }, model: { model_id: 'probe-model', context_window: CTX } };
const fill = (n) => '压'.repeat(n);

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

function build(lastRoundTools, rounds = 30) {
  const convo = [
    { role: 'system', content: `你是 MJCode 引擎。${fill(9000)}` },
    { role: 'user', content: '把这些文件里的问题都修掉，然后跑测试。' },
  ];
  for (let i = 0; i < rounds; i += 1) convo.push(...makeRound(i, i === rounds - 1 ? lastRoundTools : 3));
  return convo;
}

const shortSummaryChat = async () => ({ content: '【已完成】读取文件。【待办】继续修复。' });

// 孤儿 tool 检测：每条 tool 消息的 tool_call_id 必须能在它之前的 assistant.tool_calls 里找到
function hasOrphanTool(msgs) {
  const seen = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) seen.add(tc.id);
    } else if (m.role === 'tool' && !seen.has(m.tool_call_id)) {
      return true;
    }
  }
  return false;
}

for (const n of [3, 8, 12]) {
  await checkAsync(`并发 ${n} 个工具的末轮：压缩必须真的把体积降下来（>25%）`, async () => {
    const convo = build(n);
    const before = estimateMessagesTokens(convo);
    const out = await compactHistory(convo, model, shortSummaryChat, { knownTokens: before, force: true });
    assert(out !== convo, `未发生压缩（返回原历史），正是 keepTail 条数制的旧缺陷`);
    const after = estimateMessagesTokens(out);
    const savedPct = Math.round(((before - after) / before) * 100);
    assert(savedPct > 25, `压缩收益仅 ${savedPct}%（${before} → ${after}），应 >25%`);
    assert(!hasOrphanTool(out), '压缩结果出现孤儿 tool 消息（服务端会 400）');
  });
}

await checkAsync('不足两轮时原样返回（调用方据此判定「无收益」，不得清零窗口）', async () => {
  const convo = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
  ];
  const out = await compactHistory(convo, model, shortSummaryChat, { knownTokens: CTX * 0.9, force: true });
  assert(out === convo, '没有可裁内容时必须返回同一引用，供调用方识别「无收益」');
});

check('源码：压缩无收益时不得清零预算窗口（必须校验引用变化）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
  const start = src.indexOf("if (gate === 'compact')");
  assert(start > 0, '未找到 compact 分支');
  const block = src.slice(start, start + 2600);
  const guardIdx = block.indexOf('if (convo !== beforeConvo)');
  assert(guardIdx > 0, 'compact 分支缺少「压缩是否真的发生」的校验');
  const firstReset = firstResetIdx(block);
  assert(firstReset >= 0, 'compact 分支内找不到预算窗口清零点（写法又变了？）');
  assert(firstReset > guardIdx, 'tokenWindowSpent = 0 出现在校验之前——压不动也会清零窗口（旧缺陷）');
  assert(block.includes('trimHistoryForRun'), '缺少压不动时的硬截断降级');
});

// ── A10 守卫：compact 分支的「先校验压缩真的发生再清零窗口」必须作为「去注释生效代码」存在 ──
// 旧检查只在 2600 字符窗口内比对 token 有无+顺序，对「if (convo !== beforeConvo) 被注释/失效但仍
// 残留在窗口文本」的回归是盲的（假绿）。这里剥离注释后断言该校验真正作为生效代码存在、且仍在清零之前。
check('A10 守卫：compact 分支去注释后仍先校验「压缩真的发生」才清零窗口', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
  const start = src.indexOf("if (gate === 'compact')");
  assert(start > 0, '未找到 compact 分支');
  const block = src.slice(start, start + 2600);
  const blockActive = stripJsComments(block);
  const guardIdx = blockActive.indexOf('if (convo !== beforeConvo)');
  const firstReset = firstResetIdx(blockActive);
  assert(guardIdx > 0, '去注释 compact 分支内未找到「压缩是否真的发生」的校验（已被注释或移除）');
  assert(firstReset >= 0, '去注释 compact 分支内找不到预算窗口清零点（写法又变了？）');
  assert(firstReset > guardIdx, 'tokenWindowSpent = 0 出现在校验之前——压不动也会清零窗口（旧缺陷）');
  assert(blockActive.includes('trimHistoryForRun'), '缺少压不动时的硬截断降级');
});

check('源码：切点不再用「消息条数」推尾部（body.length - keepTail 已移除）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
  // 只看代码行：注释里保留历史说明（"事故现场：body.length - 6"）是刻意的
  const codeLines = src.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .filter((l) => l.trim());
  const bad = codeLines.filter((l) => /body\.length\s*-\s*keepTail\b/.test(l));
  assert(bad.length === 0, `仍存在条数制切点：${bad[0]?.trim()}`);
  assert(src.includes('tailCutByBudget'), '未使用按体积预算的 tailCutByBudget');
  // 更精确的一条：compactHistory 函数体内不得再调用 alignCutToRoundBoundary
  // （它只能用于「切点对齐」的通用场景，压缩的切点必须由体积预算决定）
  const start = src.indexOf('export async function compactHistory');
  assert(start > 0, '未找到 compactHistory');
  const body = src.slice(start, start + 4000);
  assert(!/alignCutToRoundBoundary\s*\(/.test(body), 'compactHistory 内仍在用 alignCutToRoundBoundary 推切点');
});

console.log(`\n结果：${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;
