// 独立对抗性验证（2026-10-18 全量修复 · 测试工程师自建，非规格 §1-13 的一部分）
//
// 目的：用**与规格不同的构造**再验一次高危修复，证明功能真的生效，而不是「测试自证」
//   （只跑 spec 给的构造 = 用实现者挑的例子验证实现者写的代码）。
// 三个高危点：
//   ① P0-1 窗口接线：不 grep 源码，而是用**差分实验**证明引擎拿到的兜底窗口真是 4096——
//      同一段历史、同一段 usage，只有兜底档会触发压缩；若是 128000 则永不触发。
//   ② P0-5 凭证权限：真实建文件、真实 stat，断言 0600；并且覆盖「文件已存在且是 0644」
//      与「同 pid 二次写复用 tmp」两个真实事故形态（Node 的 mode 只在创建时生效）。
//   ③ P1-10 角色裁剪闭环：不走 MCP（规格用的是 MCP），改用**内置工具**验证运行时白名单守卫，
//      并直接数 handler 调用次数——「报了错但已经执行」是这里唯一的真风险。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  runAgent, effectiveWindowOf, DEFAULT_CONTEXT_WINDOW_FALLBACK,
} from '../agent-core/index.js';

const require = createRequire(import.meta.url);
const { writeFileDurableWithMode } = require(path.resolve(import.meta.dirname, '../main/data/durableWrite.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const CHAT_BASE = { provider: { id: 1, isGlobal: false, base_url: 'http://local' } };

// ── ① P0-1 窗口接线：差分实验（4096 兜底 vs 128000 高估）──
// 同一段历史、同一段 usage：声明窗口 4096 → 3500 tokens 已占 85% → 必须压缩；
// 声明 128000 → 3500 tokens 只占 2.7% → 一次都不该压。两边行为必须不同。
async function windowDifferential(declaredWindow) {
  const summaryCalls = [];
  let rounds = 0;
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) { summaryCalls.push(1); return { content: '【已完成】a\n【关键发现】b\n【待办】c\n【约束】d', usage: { prompt_tokens: 30, completion_tokens: 10 } }; }
      rounds += 1;
      if (rounds <= 3) {
        return {
          content: `第 ${rounds} 步`,
          tool_calls: [{ id: `d${rounds}`, type: 'function', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        };
      }
      if (rounds === 4) {
        // provider 接受了 3500 tokens 的 prompt（对 4096 窗口而言已占 85%，越过 0.80 压缩线）
        return {
          content: '第 4 步',
          tool_calls: [{ id: 'd4', type: 'function', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }],
          usage: { prompt_tokens: 3500, completion_tokens: 10 },
        };
      }
      return { content: '完成', usage: { prompt_tokens: 100, completion_tokens: 10 } };
    },
    shell: async () => ({ stdout: 'x'.repeat(4000), stderr: '', exitCode: 0 }),
  };
  const model = {
    ...CHAT_BASE,
    // 关键：完全不提供 context_window（模拟宿主探测失败 / 老宿主），必须走引擎兜底
    model: { id: 1, model_id: 'unprobed', ...(declaredWindow === undefined ? {} : { context_window: declaredWindow }) },
  };
  const traces = [];
  const budgets = [];
  await runAgent({
    messages: [{ role: 'user', content: '长任务' }],
    model, toolHandlers, tokenBudget: 0, maxRounds: 10,
    onMessage: () => {}, onTrace: (e) => traces.push(e), onBudget: (s) => budgets.push({ ...s }),
  });
  return { summaryCalls: summaryCalls.length, maxRewrites: Math.max(0, ...budgets.map((b) => Number(b.rewrites) || 0)), traces };
}
{
  check('effectiveWindowOf 未声明窗口时返回 4096（而非 128000）',
    effectiveWindowOf(undefined, 0) === 4096 && DEFAULT_CONTEXT_WINDOW_FALLBACK === 4096,
    `got=${effectiveWindowOf(undefined, 0)}`);

  const fallbackRun = await windowDifferential(undefined);
  const highRun = await windowDifferential(128000);

  check('【差分组 A】未声明窗口（兜底 4096）⇒ 3500 tokens prompt 触发压缩', fallbackRun.summaryCalls >= 1,
    `摘要请求=${fallbackRun.summaryCalls} rewrites=${fallbackRun.maxRewrites}`);
  check('【差分组 A】兜底档下历史被真实改写（rewrites ≥ 1）', fallbackRun.maxRewrites >= 1,
    `rewrites=${fallbackRun.maxRewrites}`);
  check('【差分组 B】声明 128000 ⇒ 同一段 3000 tokens 历史一次都不压（高估的代价）',
    highRun.summaryCalls === 0, `摘要请求=${highRun.summaryCalls}`);
  check('两组行为确实不同（证明引擎真的按兜底值 4096 在算，不是「反正都会压」）',
    fallbackRun.summaryCalls > highRun.summaryCalls,
    `fallback=${fallbackRun.summaryCalls} vs 128000=${highRun.summaryCalls}`);
  check('兜底档未产生 window_inferred（4096 已够装，不需要反推抬窗）',
    fallbackRun.traces.filter((t) => t.type === 'window_inferred').length === 0);
}

// ── ② P0-5 凭证权限：真实文件 + 真实 stat ──
// 真实事故形态：历史版本以 0644 落盘（实测 11 个 MCP 服务的配置文件就是 0644），
// 而 Node 的 openSync(mode) **只在创建时生效**，同 pid 二次写复用同名 tmp 时 mode 被静默忽略。
// 因此必须验证「文件已存在且是 0644」与「同 pid 二次写」两个场景都收敛到 0600。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-cred-'));
  const file = path.join(dir, 'mcp.json');

  // 场景 1：目标不存在 → 新建后必须是 0600
  const r1 = writeFileDurableWithMode(file, JSON.stringify([{ name: 's', env: { TOKEN: 'secret' } }]), 0o600);
  const mode1 = fs.statSync(file).mode & 0o777;
  check('新建凭证文件权限为 0600（modeApplied 且 stat 一致）',
    r1.ok && r1.modeApplied && mode1 === 0o600, `mode=${mode1.toString(8)} modeApplied=${r1.modeApplied}`);

  // 场景 2：历史遗留 0644 文件被覆盖写 → 必须收紧回 0600
  fs.chmodSync(file, 0o644);
  check('（前置）已构造出历史遗留 0644 文件', (fs.statSync(file).mode & 0o777) === 0o644);
  const r2 = writeFileDurableWithMode(file, JSON.stringify([{ name: 's2' }]), 0o600);
  const mode2 = fs.statSync(file).mode & 0o777;
  check('覆盖写历史 0644 文件后收紧为 0600（不因文件已存在而失效）',
    r2.ok && mode2 === 0o600, `mode=${mode2.toString(8)}`);

  // 场景 3：同 pid 二次写（复用同名 tmp）仍为 0600
  const r3 = writeFileDurableWithMode(file, JSON.stringify([{ name: 's3' }]), 0o600);
  const mode3 = fs.statSync(file).mode & 0o777;
  check('同 pid 二次写（tmp 名复用）后权限仍为 0600',
    r3.ok && mode3 === 0o600, `mode=${mode3.toString(8)}`);

  // 场景 4：不得残留 tmp 文件（写坏的下一个隐患）
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  check('写入后无 .tmp 残留（原子写收尾干净）', leftovers.length === 0, leftovers.join(','));

  // 场景 5：内容确实被替换（不是只改权限不改数据）
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('内容为最后一次写入（原子替换生效，无半写）',
    Array.isArray(content) && content[0]?.name === 's3', JSON.stringify(content).slice(0, 60));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ③ P1-10 角色裁剪闭环：用**内置工具**验运行时守卫（规格用的是 MCP 工具）──
{
  let shellCalls = 0;
  let readCalls = 0;
  let advertised = [];
  let rounds = 0;
  const toolResults = [];
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) return { content: '【已完成】摘要', usage: { prompt_tokens: 20, completion_tokens: 5 } };
      rounds += 1;
      if (rounds === 1) {
        advertised = (payload.tools || []).map((t) => t.function?.name);
        return {
          // 模型「谎报」一个被裁掉的内置写工具（越权尝试）
          content: '我要执行命令',
          tool_calls: [{ id: 'x1', type: 'function', function: { name: 'shell', arguments: '{"command":"rm -rf /tmp/nothing"}' } }],
          usage: { prompt_tokens: 40, completion_tokens: 10 },
        };
      }
      if (rounds === 2) {
        return {
          content: '改用只读',
          tool_calls: [{ id: 'x2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' } }],
          usage: { prompt_tokens: 40, completion_tokens: 10 },
        };
      }
      return { content: '完成', usage: { prompt_tokens: 40, completion_tokens: 10 } };
    },
    shell: async () => { shellCalls += 1; return { stdout: 'should-not-happen', stderr: '', exitCode: 0 }; },
    readFile: async () => { readCalls += 1; return { content: 'file' }; },
  };
  const model = { ...CHAT_BASE, model: { id: 1, model_id: 'm', context_window: 200000 } };
  await runAgent({
    messages: [{ role: 'user', content: '只读审查' }],
    model,
    rolePreset: { name: 'readonly', systemPrompt: '只读审查员', toolNames: ['read_file'], allowMcp: false },
    toolHandlers,
    tokenBudget: 0,
    maxRounds: 5,
    onMessage: () => {},
    onToolCall: (c) => toolResults.push({ name: c.name, result: c.result }),
  });

  check('角色裁剪后 shell 未被通告', !advertised.includes('shell'), `advertised=[${advertised.join(',')}]`);
  const shellRes = toolResults.find((r) => r.name === 'shell')?.result || {};
  check('越权调 shell 被运行时守卫拒（notInAllowlist）', shellRes.notInAllowlist === true,
    JSON.stringify(shellRes).slice(0, 120));
  check('被拒的 shell 一次都没进入 handler（不是「报错但已执行」）', shellCalls === 0, `shellCalls=${shellCalls}`);
  check('通告内的 read_file 正常放行（不是一刀切全拒）', readCalls === 1,
    `readCalls=${readCalls} result=${JSON.stringify(toolResults.find((r) => r.name === 'read_file')?.result)?.slice(0, 40)}`);
}

// ── ④ P0-1① 宿主侧接线：Ollama 未探测是否真的落到 4096 且标明未确认 ──
// 这是「高估=击穿 / 低估=浪费」里代价不对称最尖锐的一条：Ollama 官方代码默认
// OLLAMA_CONTEXT_LENGTH=0（未指定，运行时按显存自适应），所以**禁止**在表里写死档位。
// 断言三态返回，而不是只断言数字——UI 需要靠 confirmed 区分「查表命中」与「估算」。
{
  const { resolveWindow, DEFAULT_CONTEXT_WINDOW, OLLAMA_UNKNOWN_NUM_CTX } = require(path.resolve(import.meta.dirname, '../main/modelWindows.js'));
  const ollamaNoProbe = resolveWindow({ baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3.1:8b' });
  check('Ollama 未探测 ⇒ window 4096（官方最小档）', ollamaNoProbe.window === 4096, JSON.stringify(ollamaNoProbe));
  check('Ollama 未探测 ⇒ confirmed:false + source:default（UI 可标「估算」）',
    ollamaNoProbe.confirmed === false && ollamaNoProbe.source === 'default', JSON.stringify(ollamaNoProbe));
  const ollamaProbed = resolveWindow({ baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3.1:8b', probedNumCtx: 32768 });
  check('Ollama 探测到 num_ctx ⇒ 用探测值且 confirmed:true',
    ollamaProbed.window === 32768 && ollamaProbed.confirmed === true && ollamaProbed.source === 'ollama-probe',
    JSON.stringify(ollamaProbed));
  check('引擎兜底常量与宿主 Ollama 最小档一致（4096 单点，不各写一个数）',
    DEFAULT_CONTEXT_WINDOW_FALLBACK === OLLAMA_UNKNOWN_NUM_CTX,
    `engine=${DEFAULT_CONTEXT_WINDOW_FALLBACK} host=${OLLAMA_UNKNOWN_NUM_CTX}`);
  check('表外未知 provider 走 32768 且 confirmed:false（不是 128000）',
    DEFAULT_CONTEXT_WINDOW === 32768
    && resolveWindow({ providerId: 'x', baseUrl: 'https://weird.example', modelId: 'weird' }).window === 32768,
    `default=${DEFAULT_CONTEXT_WINDOW}`);
  // 反例：若有人把 128000 塞回默认档，这里必须变红
  check('默认档不为 128000（高估=压缩永不触发）', DEFAULT_CONTEXT_WINDOW !== 128000, `default=${DEFAULT_CONTEXT_WINDOW}`);
}

console.log(`\nindependent-verification: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
