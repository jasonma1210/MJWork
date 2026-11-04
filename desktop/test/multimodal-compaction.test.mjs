// N6 门禁：多模态数组 content 与压缩/摘要链路的适配（第六轮）
//
// 问题（第六轮审查 N6）：图像经 OpenAI 兼容 image_url 部件（data URL + base64）进入 user 消息的
//   数组 content，但此前：
//     ① `estimateMessagesTokens` 对数组 content 直接 `JSON.stringify` → **把 base64 字符当 token**，
//        一张几百 KB 的图被算成十几万 token（估算严重失真，还会误触发压缩）；
//     ② 压缩摘要 transcript 同样 `JSON.stringify` → 整段 base64 被**再传一次**给摘要模型
//        （长会话重复消耗上下文与费用）。
// 修法：新增 contentToPlainText / estimateContentTokens，图片部件降为占位符 `[图片]` 与固定成本
//   IMAGE_PART_TOKEN_COST；压缩 transcript 与子代理父上下文一律走纯文本化。
//
// 本套件锁：① 估算不再被 base64 撑爆；② 摘要调用的入参**不含任何 base64/data:image**。
import {
  compactHistory, estimateMessagesTokens, estimateContentTokens,
  contentToPlainText, isImagePart, IMAGE_PART_TOKEN_COST, IMAGE_PLACEHOLDER, estimateTokens,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 一张「大图」：base64 长度 20 万字符（旧口径约 5 万 token 的失真量级）
const BIG_B64 = 'A'.repeat(200000);
const IMG_PART = { type: 'image_url', image_url: { url: `data:image/png;base64,${BIG_B64}`, detail: 'auto' } };
const TEXT_PART = { type: 'text', text: '这是我截的报错图' };

// ── A. 单元：估算与纯文本化 ──
{
  check('isImagePart 识别 image_url 部件', isImagePart(IMG_PART) === true && isImagePart(TEXT_PART) === false);

  const n = estimateContentTokens([TEXT_PART, IMG_PART]);
  const expected = estimateTokens(TEXT_PART.text) + IMAGE_PART_TOKEN_COST;
  check('estimateContentTokens：图片按固定成本、不按 base64 字符', n === expected, `got=${n} expected=${expected}`);
  check('estimateContentTokens：绝不随 base64 长度膨胀（< 10000）', n < 10000, `got=${n}`);

  const msg = { role: 'user', content: [TEXT_PART, IMG_PART] };
  const estMsg = estimateMessagesTokens([msg]);
  check('estimateMessagesTokens：带大图的消息估算不膨胀（< 10000）', estMsg < 10000, `got=${estMsg}`);

  const plain = contentToPlainText([TEXT_PART, IMG_PART]);
  check('contentToPlainText：图片降为占位符', plain.includes(IMAGE_PLACEHOLDER), plain.slice(0, 60));
  check('contentToPlainText：保留文本部件', plain.includes(TEXT_PART.text));
  check('contentToPlainText：绝不含 base64/data:image',
    !plain.includes('base64') && !plain.includes('data:image') && !plain.includes(BIG_B64));
  check('contentToPlainText：字符串 content 原样返回', contentToPlainText('hi') === 'hi');

  // 反例守卫：证明旧口径确实会膨胀（若不膨胀说明测试的构造无效）
  const naive = estimateTokens(JSON.stringify([TEXT_PART, IMG_PART]));
  check('（对照）旧口径 JSON.stringify 会严重膨胀（> 40000）', naive > 40000, `naive=${naive}`);
}

// ── B. 端到端：压缩摘要调用不含 base64 ──
{
  const convo = [
    { role: 'system', content: 'SYS 你是 MJ Coder' },
    { role: 'user', content: '原始需求：照着这张报错图审查整个仓库' },
    { role: 'user', content: [TEXT_PART, IMG_PART] },
  ];
  for (let i = 0; i < 14; i += 1) {
    convo.push({
      role: 'assistant',
      content: `第 ${i} 步`,
      tool_calls: [{ id: `s${i}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: `ls ${i}` }) } }],
    });
    convo.push({ role: 'tool', tool_call_id: `s${i}`, content: 'z'.repeat(360) });
  }
  const est = estimateMessagesTokens(convo);
  const win = Math.round(est / 0.85); // 反推窗口 → 落在常规压缩档（>0.80 触发、<0.90 非激进）
  const model = { provider: { id: 1, isGlobal: false, base_url: 'http://local' }, model: { id: 1, model_id: 'm', context_window: win } };

  let captured = null;
  const out = await compactHistory(convo, model, async (params) => {
    captured = params;
    return { content: '【已完成】看了图\n【关键发现】/main/main.js\n【待办】继续\n【约束】只读' };
  });

  check(`带图历史确实触发压缩（win=${win} est=${est}）`,
    String((out.find((m) => m.role === 'system' && String(m.content).includes('[早期对话摘要')) || {}).content || '').length > 0);

  const sent = JSON.stringify(captured && captured.messages || []);
  check('摘要调用入参不含 base64', !sent.includes('base64') && !sent.includes(BIG_B64), `len=${sent.length}`);
  check('摘要调用入参不含 data:image', !sent.includes('data:image'));
  check('摘要调用入参含图片占位符（表明图被识别并降采样）', sent.includes(IMAGE_PLACEHOLDER));
  check('压缩结果回写后原始图片消息已被移除（不再重复传图）',
    !JSON.stringify(out).includes(BIG_B64));
}

console.log(`\nmultimodal-compaction: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
