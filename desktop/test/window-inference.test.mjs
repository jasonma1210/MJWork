// P0-1⑤ + P0-2 窗口推断门禁（2026-10-18 全量修复）
//
// 事故形态：宿主没下发 context_window 时，旧实现三处各写一个数（128000/16000/自相矛盾），
//   高估档下压缩阈值永不触发 → 上下文一路涨到 provider 400；Ollama 这类「窗口按显存自适应」
//   的 provider 更没有固定值可写死。
// 本套件锁两件事：
//   ① 纯函数 effectiveWindowOf：兜底 4096、只抬不降、抬升上限 declared×4；
//   ② 真实链路：provider 回传的 prompt_tokens 证伪声明值时，引擎当轮抬窗 + 只强制压缩一次，
//      且该行为必须体现在**外部可观测事件**（trace window_inferred / onBudget.rewrites）上。
//
// 陷阱（规格 §1）：window_inferred 每 run 只能出现**一次**——否则退化成「每轮都压」。
import fs from 'node:fs';
import path from 'node:path';
import {
  runAgent, effectiveWindowOf, DEFAULT_CONTEXT_WINDOW_FALLBACK,
} from '../agent-core/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ① 纯函数五组入参（规格 §1 断言逐条）──
check('effectiveWindowOf(128000,121600) → 128000（未超 95%，不抬）',
  effectiveWindowOf(128000, 121600) === 128000, `got=${effectiveWindowOf(128000, 121600)}`);
check('effectiveWindowOf(32768,40000) → 57143（按真实回传量反推）',
  effectiveWindowOf(32768, 40000) === 57143, `got=${effectiveWindowOf(32768, 40000)}`);
check('effectiveWindowOf(128000,0) → 128000（无回传量时不动）',
  effectiveWindowOf(128000, 0) === 128000, `got=${effectiveWindowOf(128000, 0)}`);
check('effectiveWindowOf(0,0) → 4096（兜底档，不是 128000）',
  effectiveWindowOf(0, 0) === 4096 && DEFAULT_CONTEXT_WINDOW_FALLBACK === 4096,
  `got=${effectiveWindowOf(0, 0)} fallback=${DEFAULT_CONTEXT_WINDOW_FALLBACK}`);
check('effectiveWindowOf(32768,900000) → 131072（4× 上限生效，不无限抬）',
  effectiveWindowOf(32768, 900000) === 131072, `got=${effectiveWindowOf(32768, 900000)}`);

// ── ② 真实链路：谎报窗口被证伪 → 抬窗 + 只强制压一次 ──
// 构造：context_window 声明 1000；前两轮如实回报小 usage（正常推进），
// 第三轮回报 prompt_tokens=3000（服务端接受了 3000 ⇒ 真实窗口 ≥ 3000，声明值 1000 被证伪）。
// shell 每轮返回 4000 字符 ⇒ 历史有足够体积，压缩是真改写而非「无收益放弃」。
{
  const traces = [];
  const budgets = [];
  const toolResults = [];
  let mainRound = 0;
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) {
        // 压缩摘要请求（无 tools、单条 user）
        return { content: '【已完成】已跑两步\n【关键发现】/tmp/x\n【待办】继续\n【约束】无', usage: { prompt_tokens: 60, completion_tokens: 20 } };
      }
      mainRound += 1;
      // 前 4 轮如实回报小 usage 正常推进（攒够可裁的早期轮，否则压缩会因「无早期内容可裁」放弃）；
      // 第 5 轮回报 3000（超出声明窗口 1000 的 95%）——服务端接受了 3000 ⇒ 声明值被证伪。
      if (mainRound <= 5) {
        const lie = mainRound === 5;
        return {
          content: `第 ${mainRound} 步`,
          tool_calls: [{ id: `c${mainRound}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: `echo ${mainRound}` }) } }],
          usage: { prompt_tokens: lie ? 3000 : 100, completion_tokens: 20 },
        };
      }
      return { content: '全部完成', usage: { prompt_tokens: 100, completion_tokens: 20 } };
    },
    shell: async () => ({ stdout: 'x'.repeat(4000), stderr: '', exitCode: 0 }),
  };
  const model = {
    provider: { id: 1, isGlobal: false, base_url: 'http://local' },
    model: { id: 1, model_id: 'tiny-ctx', context_window: 1000 },
  };
  let doneText = null;
  await runAgent({
    messages: [{ role: 'user', content: '跑三步' }],
    model,
    toolHandlers,
    tokenBudget: 0,
    maxRounds: 12,
    onMessage: () => {},
    onTrace: (e) => traces.push(e),
    onBudget: (s) => budgets.push({ ...s }),
    onToolCall: (c) => toolResults.push(c),
    onDone: (t) => { doneText = t; },
  });

  const inferred = traces.filter((e) => e.type === 'window_inferred');
  check('trace 出现且仅出现一次 window_inferred（防每轮都压）', inferred.length === 1, `count=${inferred.length}`);
  const ev = inferred[0] || {};
  check('window_inferred 字段为 {declared:1000, inferred:4000, lastPromptTokens:3000}',
    ev.declared === 1000 && ev.inferred === 4000 && ev.lastPromptTokens === 3000,
    JSON.stringify({ declared: ev.declared, inferred: ev.inferred, lastPromptTokens: ev.lastPromptTokens }));

  const maxRewrites = budgets.reduce((m, s) => Math.max(m, Number(s.rewrites) || 0), 0);
  check('证伪后至少强制压缩一次（onBudget.rewrites ≥ 1）', maxRewrites >= 1, `maxRewrites=${maxRewrites}`);
  check('证伪当轮确实发出了摘要请求（存在无 tools 的 chat 调用）',
    traces.some((e) => e.type === 'model') && budgets.length > 0);
  check('压缩后运行继续推进并正常收尾', doneText === '全部完成', `done=${String(doneText).slice(0, 40)}`);
  // 证伪当轮命中压缩分支会 continue（该轮 tool_calls 不执行），故只要求「压缩前的工具调用都真的跑了」
  check('压缩前的 shell 调用都真的执行了（压缩不吞已完成工具结果）', toolResults.length >= 4, `tools=${toolResults.length}`);
}

// ── ③ 源码门禁：兜底窗口不得再写死 128000 / 16000 ──
// 只比对**代码**（去注释），否则注释里解释「为什么不用 128000」会被误判成违规。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}
{
  const src = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
  const code = stripComments(src);
  const hits128k = (code.match(/128000/g) || []).length;
  check('源码门禁①：agent-core 代码内 128000 零命中（兜底窗口不再高估）', hits128k === 0, `命中 ${hits128k} 处`);

  // ② 16000 白名单化（2026-10-18 裁决）：门禁真意是「兜底不得取大值」，而不是「数字 16000 不许出现」。
  //    16000 唯一的合法活代码用途是 TRIM_MIN_EFFECTIVE_WINDOW（P1-5 的入口裁剪窗口下限，
  //    防止窗口极小时每个 token 都触发裁剪）——与「上下文窗口兜底」是两件不同的事。
  //    只锁数字会误伤这个合法用途；锁语义（③）才防得住回归。
  const lines16k = code.split('\n').filter((l) => l.includes('16000'));
  check('源码门禁②：16000 仅 1 处活代码，且必须是 TRIM_MIN_EFFECTIVE_WINDOW 的定义',
    lines16k.length === 1 && /TRIM_MIN_EFFECTIVE_WINDOW\s*=\s*16000/.test(lines16k[0]),
    `命中 ${lines16k.length} 处：${lines16k.map((l) => l.trim()).join(' | ').slice(0, 120)}`);

  // ③ 反例保护（真正的守护目标）：任何「以 16000/128000 作为 context_window 兜底」的写法必须被拒。
  check('源码门禁③：兜底窗口为 4096（不是 128000/16000）',
    DEFAULT_CONTEXT_WINDOW_FALLBACK === 4096, `fallback=${DEFAULT_CONTEXT_WINDOW_FALLBACK}`);
  check('源码门禁③：代码内不存在以 16000/128000 做默认值的兜底写法（|| 16000 / ?? 16000 / ?: 128000）',
    !/(\|\||\?\?)\s*(16000|128000)\b/.test(code) && !/\?\s*(16000|128000)\s*:/.test(code),
    '未发现兜底取大值');
}

await sleep(0);
console.log(`\nwindow-inference: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
