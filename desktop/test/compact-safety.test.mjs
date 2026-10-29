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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compactHistory } from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A10 守卫辅助：去除 JS/TS 行/块注释（保留 `://` 不被误删），仅保留「生效」源码。
function stripTsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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

  // ── A10 守卫：关键接线 token 必须作为「去注释生效代码」落在函数体 / 调用片段内 ──
  // 旧检查只在函数体文本内比对 token 存在，对「if (loading) / buildRunModel(model) / compactHistory 调用
  // 被注释或失效但仍残留在文本」的回归是盲的（假绿）。这里剥离注释后断言这些 token 真正作为生效代码存在。
  {
    const bodyActive = stripTsComments(body);
    check('A10 守卫：compactSession 函数体（去注释）仍有运行中 loading 守卫',
      /if\s*\(\s*loading\s*\)/.test(bodyActive));
    check('A10 守卫：compactSession 函数体（去注释）仍以 buildRunModel(model) 现算窗口',
      /buildRunModel\(model\)/.test(bodyActive));
    const ci = body.indexOf('compactHistory(');
    const callLineActive = stripTsComments(body.slice(ci - 120, ci + 120));
    check('A10 守卫：传给 compactHistory 的仍是 runModel（去注释生效代码）',
      /compactHistory\(\s*convo\s*,\s*runModel/.test(callLineActive));
  }

  // ── C. 记账守恒（2026-10-29 事故）：压缩不得抹掉 token / 模型名 ──
  // 事故：compactSession 把消息映射成 {role, content} 再交给引擎，引擎产出（同样只有
  //   role/content/tool_calls）**整体覆盖**数据库 ⇒ 该会话 tokensInput/modelName 全清零。
  //   真机结果：两次 /compact 抹掉 11,878,938 tokens，工作台三张表当天全空。
  // 这里断言的是**行为**（真跑 carryLedger），不是「文件里有没有某个词」——
  //   只做形态断言时，把 carryLedger 改成 `return next` 依然全绿，等于没测。
  const LEDGER_TS = path.join(HERE, '../renderer/src/lib/ledgerCarry.ts');
  check('C 记账守恒模块存在（ledgerCarry.ts）', fs.existsSync(LEDGER_TS));
  {
    const script = `
      import { carryLedger } from ${JSON.stringify(pathToFileURL(LEDGER_TS).href)};
      const prev = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1', tokensInput: 1000, tokensOutput: 100, modelName: 'flint', createdAt: 111 },
        { role: 'assistant', content: 'a2', tokensInput: 2000, tokensOutput: 200, modelName: 'flint', createdAt: 222 },
        { role: 'user', content: 'q2' },
      ];
      const next = [
        { role: 'assistant', content: '[早期对话摘要] 摘要' },
        { role: 'assistant', content: 'a2' },
      ];
      const out = carryLedger(prev, next, 'fallback-model');
      const sum = (a) => a.reduce((s, m) => s + (Number(m.tokensInput) || 0) + (Number(m.tokensOutput) || 0), 0);
      console.log(JSON.stringify({
        prevSum: sum(prev), outSum: sum(out),
        headIn: Number(out[0].tokensInput) || 0, headOut: Number(out[0].tokensOutput) || 0,
        headModel: String(out[0].modelName || ''),
        tailIn: Number(out[1].tokensInput) || 0, tailOut: Number(out[1].tokensOutput) || 0,
        tailModel: String(out[1].modelName || ''), tailAt: Number(out[1].createdAt) || 0,
      }));
    `;
    let raw = '';
    let spawnErr = '';
    try {
      raw = execFileSync(process.execPath,
        ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
        { encoding: 'utf8' });
    } catch (e) {
      spawnErr = String(e?.stderr || e?.message || e).slice(0, 300);
    }
    // 空过守卫：子进程失败时全部子断言必须红，不能因为「没输出」而静默跳过
    check('C 记账守恒行为用例可执行（TS 模块被真正加载）', raw.trim().length > 0, spawnErr || 'ok');
    let r = {};
    try { r = JSON.parse(raw.trim().split('\n').pop() || '{}'); } catch { /* 解析失败 → 下面全红 */ }
    check('C 压缩后 token 总量守恒（不因摘要而变小）',
      r.prevSum > 0 && r.prevSum === r.outSum, `prev=${r.prevSum} out=${r.outSum}`);
    check('C 保留的尾部消息原样带回 token（不是 0）',
      r.tailIn === 2000 && r.tailOut === 200, `in=${r.tailIn} out=${r.tailOut}`);
    check('C 保留的尾部消息带回原模型名', r.tailModel === 'flint', `got=${r.tailModel}`);
    check('C 保留的尾部消息保留原时间戳（不许改写成压缩时刻）', r.tailAt === 222, `got=${r.tailAt}`);
    check('C 被摘要吃掉的历史 token 归到摘要条（1000/100）',
      r.headIn === 1000 && r.headOut === 100, `in=${r.headIn} out=${r.headOut}`);
    check('C 摘要条无原模型时用 fallbackModel 兜底', r.headModel === 'fallback-model', `got=${r.headModel}`);
  }
  {
    // 接线形态（去注释后）：落库必须用 carryLedger 的结果，撤销带必须存带字段的原始消息
    const bodyActive = stripTsComments(body);
    check('C 落库用的是 carryLedger 处理后的结果（不是引擎裸输出）',
      /replaceMessages\(\s*threadId\s*,\s*withLedger\s*\)/.test(bodyActive));
    check('C 撤销带存原始 messages（带记账字段），不是只有 role/content 的 convo',
      /localStorage\.setItem\(\s*undoKey\s*,\s*JSON\.stringify\(\s*messages/.test(bodyActive));
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
