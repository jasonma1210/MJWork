// P2-4 压缩中段轻提示 + 激进档告警门禁（2026-10-18 全量修复）
//
// 问题：0.80~0.90 这段此前是**静默压缩**——模型不知道自己刚被摘过，于是「凭记忆假设」，
//   把已压掉的细节当成还记得，写出与真实文件内容不符的代码。
// 修法：三分支文案写进摘要消息（不能新增 system 消息——DeepSeek 系只认首部 system）：
//   · 0.80~0.90 常规档 → 「[提示] 部分早期对话已压缩」
//   · > 0.90 激进档   → 「[上下文压力告警]」（措辞更强，要求必须重新核实）
//
// 陷阱（规格 §9）：两档必须是**互斥**的——常规档不得出现告警文案，否则告警失去信息量。
import {
  compactHistory, estimateMessagesTokens, AGGRESSIVE_RATIO, clampSummary,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

check('AGGRESSIVE_RATIO === 0.90（0.85 → 0.90）', AGGRESSIVE_RATIO === 0.9, `got=${AGGRESSIVE_RATIO}`);

function buildHistory() {
  const convo = [{ role: 'system', content: 'SYS 你是 MJ Coder' }, { role: 'user', content: '原始需求：审查整个仓库' }];
  for (let i = 0; i < 14; i += 1) {
    convo.push({
      role: 'assistant', content: `第 ${i} 步`, tool_calls: [{ id: `s${i}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: `ls ${i}` }) } }],
    });
    convo.push({ role: 'tool', tool_call_id: `s${i}`, content: 'z'.repeat(360) });
  }
  return convo;
}

const convo = buildHistory();
const est = estimateMessagesTokens(convo);
// 用 estimateMessagesTokens 反推窗口：est / window = 目标占用率
const windowFor = (ratio) => Math.round(est / ratio);
const modelFor = (w) => ({ provider: { id: 1, isGlobal: false, base_url: 'http://local' }, model: { id: 1, model_id: 'm', context_window: w } });
const summaryOf = (out) => String((out.find((m) => m.role === 'system' && String(m.content).includes('[早期对话摘要')) || {}).content || '');

// ── ① ≈85%：常规档（轻提示，无告警）──
{
  const win = windowFor(0.85);
  const out = await compactHistory(convo, modelFor(win), async () => ({ content: clampSummary('【已完成】审查了 main/\n【关键发现】/main/main.js\n【待办】继续\n【约束】只读') }));
  const text = summaryOf(out);
  check(`85% 档确实发生压缩（win=${win} est=${est}）`, text.length > 0, `summary len=${text.length}`);
  check('85% 档摘要含「[提示] 部分早期对话已压缩」', text.includes('[提示] 部分早期对话已压缩'), text.slice(0, 60));
  check('85% 档不含「[上下文压力告警]」', !text.includes('[上下文压力告警]'), text.slice(0, 120));
  check('85% 档摘要标记为常规（非激进裁剪）', text.startsWith('[早期对话摘要]'), text.slice(0, 30));
}

// ── ② ≈95%：激进档（强告警 + 更短尾部）──
{
  const win = windowFor(0.95);
  const out = await compactHistory(convo, modelFor(win), async () => ({ content: clampSummary('【已完成】审查了 main/\n【关键发现】/main/main.js\n【待办】继续\n【约束】只读') }));
  const text = summaryOf(out);
  check(`95% 档确实发生压缩（win=${win} est=${est}）`, text.length > 0, `summary len=${text.length}`);
  check('95% 档摘要含「[上下文压力告警]」', text.includes('[上下文压力告警]'), text.slice(0, 80));
  check('95% 档标记为激进裁剪', text.startsWith('[早期对话摘要·激进裁剪]'), text.slice(0, 40));
  check('激进档要求重新核实而非凭记忆（可行动文案）', text.includes('read_file') || text.includes('grep'),
    text.slice(-80));
}

// ── ③ 两档尾部保留量差异（激进档必须留得更少，否则分档没有意义）──
{
  const normal = await compactHistory(convo, modelFor(windowFor(0.75)), async () => ({ content: clampSummary('【已完成】a\n【关键发现】b\n【待办】c\n【约束】d') }));
  const aggressive = await compactHistory(convo, modelFor(windowFor(0.90)), async () => ({ content: clampSummary('【已完成】a\n【关键发现】b\n【待办】c\n【约束】d') }));
  check('激进档保留的尾部不多于常规档（15% vs 25% 体积预算）',
    estimateMessagesTokens(aggressive) <= estimateMessagesTokens(normal),
    `aggressive=${estimateMessagesTokens(aggressive)} normal=${estimateMessagesTokens(normal)}`);
}

console.log(`\nsummary-notice: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
