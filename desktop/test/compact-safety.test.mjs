// P0-4 回归门禁：上下文压缩的数据安全。
//
// 事故形状（2026-10-22 审查）：
//   `compactContext` 把 `selectedModel` 直接交给 compactHistory，而 context_window 只在 send
//   的 runModel 副本里注入（selectedModel.model 本身不含该字段）⇒ 引擎回落
//   DEFAULT_CONTEXT_WINDOW_FALLBACK = 4096 ⇒ 任何超过约 3.3k token 的会话都被判「激进档」、
//   尾部只保留 15%，然后 replaceMessages **整体覆盖数据库**（不可逆）。
//   同一函数还没有 loading 守卫：运行中压缩会与主进程正在追加的中间消息互相覆盖。
//
// 本门禁分两层：
//   A. 行为：窗口取值真实决定「裁/不裁」（用真函数 compactHistory 跑同一份历史）
//   B. 接线：compactContext 函数体里确实用了运行时窗口、确实有运行中守卫、确实留了撤销出口
//      （形态断言只截函数体、并带片段长度自检——全文 indexOf 会命中无关位置而空过）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactHistory } from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = fs.readFileSync(path.join(HERE, '../renderer/src/hooks/useAgentRun.ts'), 'utf8');
// P0-4 的实现落在 lib/compactSession（hook 贴 800 行软档，逻辑搬家但门禁跟着搬）
const COMPACT_SRC = fs.readFileSync(path.join(HERE, '../renderer/src/lib/compactSession.ts'), 'utf8');
const MODEL_CFG_SRC = fs.readFileSync(path.join(HERE, '../renderer/src/lib/modelConfig.js'), 'utf8');

// 一份约 9k token、8 轮的历史。轮数要够多：引擎的 tailCutByBudget 有
// 「最多保留一半轮」的硬上限（防止紧窗口下 cut=0 而放弃压缩），
// 轮数太少时该上限会掩盖窗口差异，测不出「窗口真的参与决策」。
const chunk = '这是一段用于测试上下文压缩行为的较长中文内容，需要在窗口较小时被摘要化处理。'.repeat(20);
const convo = [{ role: 'system', content: '你是助手' }, { role: 'user', content: '把登录模块重构一下' }];
for (let i = 1; i <= 8; i += 1) {
  convo.push({ role: 'assistant', content: chunk });
  convo.push({ role: 'user', content: `第 ${i} 轮需求` });
}
const chatFn = async () => ({ content: '【早期对话摘要】用户要求重构登录模块。' });

/**
 * 截取 compactSession 的函数体。
 * 刻意不用全文 indexOf：那样会命中文件里其它 compact* 出现位置（例如 import 行），
 * 断言就变成「文件里存在这几个词」而不是「这个函数里这么写」。
 */
function compactContextBody() {
  const start = COMPACT_SRC.indexOf('export async function compactSession(');
  if (start < 0) return '';
  const end = COMPACT_SRC.indexOf('\n}\n', start);
  if (end < 0) return '';
  return COMPACT_SRC.slice(start, end);
}

(async () => {
  // ── A. 行为：窗口取值决定裁不裁 ──
  const noWindow = await compactHistory(convo, { provider: { id: 1 }, model: { model_id: 'test' } }, chatFn, { force: true });
  check('P0-4 无 context_window 时回落小窗口并裁掉历史（事故复现）',
    noWindow.length < convo.length, `len=${noWindow.length}/${convo.length}`);

  const smallWin = await compactHistory(convo, { provider: { id: 1 }, model: { model_id: 'test', context_window: 4096 } }, chatFn, { force: true });
  check('P0-4 4096 窗口下同一份历史被裁', smallWin.length < convo.length, `len=${smallWin.length}`);

  const realWin = await compactHistory(convo, { provider: { id: 1 }, model: { model_id: 'test', context_window: 128000 } }, chatFn, { force: true });
  // 注意：force 语义是「用户主动要求，就按窗口比例裁」，所以大窗口也会压掉最早一两轮。
  // 真正要守住的是**单调关系**：窗口越大 → 尾部预算越大 → 保留越多。
  // 事故版本（窗口回落 4096）恰好把 8 条压到 4 条，用户点一次就永久丢一半。
  check('P0-4 窗口越大保留越多（证明窗口真的参与决策，而非恒按 4096 裁）',
    realWin.length > smallWin.length, `4096→${smallWin.length} / 128k→${realWin.length}`);
  check('P0-4 真实窗口下保留一半以上历史（不误伤工作现场）',
    realWin.length >= convo.length * 0.5, `len=${realWin.length}/${convo.length}`);

  const tiny = [
    { role: 'user', content: '一句问题' },
    { role: 'assistant', content: '一句回答' },
  ];
  const tinyWin = await compactHistory(tiny, { provider: { id: 1 }, model: { model_id: 'test', context_window: 4096 } }, chatFn, { force: true });
  check('P0-4 强制压缩不误伤短会话（引擎内部「不足两轮」闸仍生效）', tinyWin.length === tiny.length);

  // ── B. 接线：实现（lib/compactSession）+ 调用方（hook）都必须真的这么写 ──
  const body = compactContextBody();
  check('P0-4 函数体截取成功（空片段会让下面所有形态断言空过）', body.length > 400, `len=${body.length}`);
  check('P0-4 压缩实现里有运行中守卫（loading）', /if\s*\(\s*loading\s*\)/.test(body));
  check('P0-4 压缩实现走统一口径 buildRunModel（与 send 共用窗口计算）', /buildRunModel\(model\)/.test(body));
  check('P0-4 窗口在调用压缩前确定（buildRunModel 出现在 compactHistory 之前）',
    body.indexOf('buildRunModel(') > 0 && body.indexOf('buildRunModel(') < body.indexOf('compactHistory('));
  const callLine = body.slice(body.indexOf('compactHistory(') - 120, body.indexOf('compactHistory(') + 120);
  check('P0-4 传给 compactHistory 的是 runModel（不是 selectedModel 原样）',
    /compactHistory\(\s*convo\s*,\s*runModel/.test(callLine), callLine.replace(/\s+/g, ' ').slice(0, 90));
  check('P0-4 压缩前留撤销快照（localStorage undoKey）',
    /localStorage\.setItem\(\s*undoKey/.test(body));
  check('P0-4 落库成功后给「撤销」出口（toast actionLabel）', /actionLabel:/.test(body));
  // 窗口口径只能有一处：buildRunModel 里注入 context_window，别处不得再各算一次
  check('P0-4 窗口口径集中在 lib/modelConfig.buildRunModel',
    /export function buildRunModel\(/.test(MODEL_CFG_SRC)
    && /context_window:\s*effectiveContextWindow\(/.test(MODEL_CFG_SRC));
  // 搬家后最容易出的退化：hook 不再调用它（实现还在，但没人用）
  check('P0-4 hook 真的调用 compactSession（搬走实现不等于断开接线）',
    /await compactSession\(\{/.test(HOOK_SRC) && /from '\.\.\/lib\/compactSession'/.test(HOOK_SRC));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
