// G-deep-research 门禁（2026-10-19）：原生「多轮检索 → 证据链 → 报告」流水线
//
// 覆盖四层：
//   ① 纯函数——证据去重编号 / 报告确定性装配 / 规划与综合解析（deepResearch.js，零依赖可单测）；
//   ② 引擎接线——BASE_TOOLS 第 47 项 schema、超时表 600000、switch case、handler 映射边界（内建不落宿主）；
//   ③ runDeepResearch 端到端——注入 mock 通道，断言产物形状与各失败分支如实降级；
//   ④ runAgent 分发接线——模型发 deep_research 工具调用后真转发、治理字段透传到写工具。
//
// 不依赖 Electron：runDeepResearch 只经 toolHandlers 通道调用，宿主能力全部以 mock 注入。
import fs from 'node:fs';
import path from 'node:path';
import {
  runAgent, BASE_TOOLS, runDeepResearch,
} from '../agent-core/index.js';
import {
  slugifyTopic, normalizeUrl, classifySource, parseSubquestions,
  buildEvidenceLedger, parseSynthesis, assembleResearchReport,
} from '../agent-core/deepResearch.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'http://local' },
  model: { id: 1, model_id: 'm', context_window: 200000 },
};

// ── ① 纯函数 ──
{
  check('slugifyTopic 折叠非字母数字（含 CJK 保留、大小写归一）',
    slugifyTopic('React 19 vs Vue 3！') === 'react-19-vs-vue-3'
    && slugifyTopic('桌面 Agent 对比') === '桌面-agent-对比');
  check('slugifyTopic 空串回落 research', slugifyTopic('   ') === 'research');

  check('normalizeUrl 去 fragment 与尾斜杠（非法值原样返回）',
    normalizeUrl('https://a.com/x/#frag') === 'https://a.com/x'
    && normalizeUrl('https://a.com/') === 'https://a.com'
    && normalizeUrl('not a url') === 'not a url'
    && normalizeUrl('') === '');

  check('classifySource 按 paper > official > community > media 判定',
    classifySource('https://arxiv.org/abs/2401.1') === 'paper'
    && classifySource('https://docs.example.com/guide') === 'official'
    && classifySource('https://github.com/x/y') === 'community'
    && classifySource('https://example.com/news') === 'media'
    && classifySource('') === 'media');

  check('parseSubquestions 兼容 JSON 与项目符号行，并去重/限长',
    JSON.stringify(parseSubquestions('{"subquestions":["甲","乙"]}')) === '["甲","乙"]'
    && JSON.stringify(parseSubquestions('1. 甲\n2. 乙\n- 甲')) === '["甲","乙"]');
  check('parseSubquestions 按 limit 截断',
    parseSubquestions(['a', 'b', 'c', 'd', 'e'].join('\n'), 3).length === 3);

  const ledger = buildEvidenceLedger([
    { subquestion: '甲', results: [
      { title: 'A', url: 'https://a.com/' },
      { title: 'A dup', url: 'https://a.com' },          // 归一化后同 URL → 去重
      { title: 'B', url: '' },                            // 无 URL → 以标题为键
    ] },
    { subquestion: '乙', results: [{ title: 'C', url: 'https://c.com' }] },
    { subquestion: '丙', error: 'search_all_providers_failed', results: [] },
  ]);
  check('buildEvidenceLedger 去重后自 1 起编号', JSON.stringify(ledger.entries.map((e) => e.id)) === '[1,2,3]');
  check('buildEvidenceLedger 记录失败子问题', ledger.failures.length === 1 && ledger.failures[0].subquestion === '丙');
  check('buildEvidenceLedger 标注来源类型与 host',
    ledger.entries[0].sourceType === 'media' && ledger.entries[0].host === 'a.com');
  check('buildEvidenceLedger 按 max 截断', buildEvidenceLedger([{ subquestion: 'x', results: [{ url: 'u1' }, { url: 'u2' }, { url: 'u3' }] }], { max: 2 }).entries.length === 2);

  const syn = parseSynthesis('{"executive_summary":"摘要","findings":[{"point":"发现","refs":[1,"2"]}],"uncertainty":"不确定","conclusion":"结论"}');
  check('parseSynthesis 解析严格 JSON 并归一 refs 为数字',
    syn.executive_summary === '摘要' && syn.findings[0].point === '发现'
    && JSON.stringify(syn.findings[0].refs) === '[1,2]' && syn.uncertainty === '不确定');
  check('parseSynthesis 非 JSON 降级为整段执行摘要（不伪造小节）',
    parseSynthesis('这是一段普通结论').executive_summary === '这是一段普通结论'
    && parseSynthesis('').findings.length === 0);

  const rep = assembleResearchReport({
    topic: '桌面 Agent 对比',
    subquestions: ['甲'],
    ledger: { entries: [{ id: 1, title: 'A', url: 'https://a.com', sourceType: 'official', snippet: '摘要A', subquestion: '甲' }], failures: [] },
    synthesis: { executive_summary: 'ES', findings: [{ point: 'F1', refs: [1] }], uncertainty: 'U', conclusion: 'C' },
    excerpts: { 1: '精读正文' },
    generatedAt: '2026-10-19',
  });
  const sections = ['# 深度研究：桌面 Agent 对比', '## 执行摘要', '## 关键发现', '## 数据与证据', '## 分歧与不确定性', '## 结论与建议', '## 引用列表'];
  check('报告装配含六段固定结构', sections.every((s) => rep.includes(s)), `缺：${sections.filter((s) => !rep.includes(s))}`);
  check('报告关键发现带编号引用且引用列表带访问日期',
    rep.includes('F1 [1]') && rep.includes('1. A — https://a.com（官方，访问日期 2026-10-19）'));
  const empty = assembleResearchReport({ topic: 'T', ledger: { entries: [], failures: [] } });
  check('空证据报告如实写「无引用可列」与「未取得任何可引用证据」',
    empty.includes('（无引用可列') && empty.includes('（未取得任何可引用证据'));
  // 真机实测缺陷回归：模型把引用号写进结论正文，装配若再追加一次会出现「… [1]。 [1]」重复后缀
  const dedup = assembleResearchReport({
    topic: 'T',
    ledger: { entries: [{ id: 1, title: 'A', url: 'https://a.com', sourceType: 'media', snippet: '', subquestion: '甲' }], failures: [] },
    synthesis: { executive_summary: '', findings: [{ point: '结论带内联引用 [1]', refs: [1] }], uncertainty: '', conclusion: '' },
  });
  const fLine = dedup.split('\n').find((l) => l.startsWith('1. 结论'));
  check('结论正文自带引用号时以 refs 字段渲染、不重复追加', fLine === '1. 结论带内联引用 [1]', `实际：${fLine}`);
  check('无 refs 字段时保留正文内联引用原样（不误删引用）',
    assembleResearchReport({ topic: 'T', ledger: { entries: [], failures: [] }, synthesis: { findings: [{ point: '仅内联 [9]', refs: [] }] } }).includes('1. 仅内联 [9]'));
}

// ── ② 引擎接线 ──
{
  const byName = Object.fromEntries(BASE_TOOLS.map((t) => [t.function.name, t.function]));
  const src = [fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'agent-core/index.js').replace('index.js', 'toolNames.js'), 'utf8')].join('\n'); // 2026-11-03：TOOL_HANDLER_NAMES 已外置到 toolNames.js，两条路径一起读
  check('BASE_TOOLS 含 deep_research', !!byName.deep_research);
  check('deep_research schema required=[topic]',
    JSON.stringify(byName.deep_research?.parameters?.required) === '["topic"]');
  check('deep_research 为引擎内建（TOOL_HANDLER_NAMES 无映射，防重复路由）',
    !/deep_research:\s*'/.test(src));
  check('分发 switch 已接线 case deep_research', /case 'deep_research':/.test(src));
  check('TOOL_TIMEOUT_OVERRIDES 含 deep_research=600000', /deep_research:\s*600000/.test(src));
  const cwdSet = src.match(/const CWD_TOOLS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  const planSet = src.match(/PLAN_MODE_ALLOWED = new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
  check('deep_research 不入 CWD_TOOLS/PLAN_MODE_ALLOWED（治理字段由编排显式透传）',
    !cwdSet.includes('deep_research') && !planSet.includes('deep_research'));
}

// ── ③ runDeepResearch 端到端（mock 通道）──
{
  const written = [];
  const handlers = {
    chat: async (payload) => {
      const sys = String(payload.messages?.[0]?.content || '');
      if (sys.includes('研究规划器')) {
        return { content: JSON.stringify({ subquestions: ['问题A', '问题B', '问题C'] }), usage: {} };
      }
      if (sys.includes('研究分析师')) {
        return { content: JSON.stringify({
          executive_summary: '执行摘要', findings: [{ point: '关键发现', refs: [1] }],
          uncertainty: '不确定', conclusion: '结论',
        }), usage: {} };
      }
      return { content: '', usage: {} };
    },
    webSearch: async ({ query }) => ({ ok: true, results: query === '问题A'
      ? [{ title: 'A1', url: 'https://docs.a.com/x', snippet: 'sa' }, { title: 'A2', url: 'https://arxiv.org/abs/1', snippet: 'sb' }]
      : [{ title: 'B1', url: 'https://github.com/x', snippet: '' }] }),
    webFetch: async ({ url }) => ({ ok: true, content: `正文 ${url}` }),
    writeFile: async (args) => { written.push(args); return { ok: true, path: `/tmp/project/${args.path}` }; },
  };

  const res = await runDeepResearch({
    args: { topic: '桌面 Agent 对比' }, toolHandlers: handlers, model,
    cwd: '/tmp/project', approvalMode: 'on-request', conversationId: 'c1',
  });
  check('端到端成功并返回结构化结果', res.ok === true, JSON.stringify(res).slice(0, 160));
  check('返回报告路径在 research/ 且为 md', String(res.path).includes('research/') && String(res.path).endsWith('-report.md'));
  check('子问题来自规划（3 个）', JSON.stringify(res.subquestions) === '["问题A","问题B","问题C"]');
  check('证据去重编号 = 3（A1/A2/B1，重复 B1 已去重）', res.evidence_count === 3, `got=${res.evidence_count}`);
  check('精读篇数 = 3（全部有 URL 的来源）', res.deep_read_count === 3, `got=${res.deep_read_count}`);
  check('无检索失败', res.search_failures === 0);
  check('写入内容为完整报告（含引用列表）', String(written[0]?.content).includes('## 引用列表'));
  check('治理字段（cwd/审批/会话）透传到写工具',
    written[0]?.cwd === '/tmp/project' && written[0]?.approvalMode === 'on-request' && written[0]?.conversationId === 'c1');

  check('缺 topic → topic_missing',
    (await runDeepResearch({ args: {}, toolHandlers: handlers, model })).error.includes('topic_missing'));
  check('缺 chat/webSearch/writeFile 通道 → unavailable',
    (await runDeepResearch({ args: { topic: 'x' }, toolHandlers: { chat: handlers.chat }, model })).error.includes('unavailable'));
  check('落盘被拒 → save_failed（绝不谎报成功）',
    (await runDeepResearch({
      args: { topic: 'x' },
      toolHandlers: { ...handlers, writeFile: async () => ({ ok: false, error: 'denied' }) },
      model,
    })).error.includes('save_failed'));

  // 检索全失败：报告仍落盘，但如实记录失败子问题与「无引用可列」
  const written2 = [];
  const r4 = await runDeepResearch({
    args: { topic: 'x', max_sources: 5 },
    toolHandlers: { ...handlers, webSearch: async () => ({ ok: false, error: 'search_all_providers_failed' }), writeFile: async (a) => { written2.push(a); return { ok: true, path: a.path }; } },
    model,
  });
  check('检索全失败仍落盘：证据 0、失败数 3', r4.ok === true && r4.evidence_count === 0 && r4.search_failures === 3,
    JSON.stringify({ ok: r4.ok, ev: r4.evidence_count, f: r4.search_failures }));
  check('无证据报告如实写「无引用可列」', String(written2[0]?.content).includes('（无引用可列'));
}

// ── ④ runAgent 分发接线（switch case 真转发）──
{
  const written = [];
  let round = 0;
  const handlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) {
        const sys = String(payload.messages?.[0]?.content || '');
        if (sys.includes('研究规划器')) return { content: JSON.stringify({ subquestions: ['Q1'] }), usage: {} };
        return { content: JSON.stringify({ executive_summary: 'S', findings: [], uncertainty: '', conclusion: '' }), usage: {} };
      }
      round += 1;
      if (round === 1) {
        return {
          content: '开始研究',
          tool_calls: [{ id: 'd1', type: 'function', function: { name: 'deep_research', arguments: JSON.stringify({ topic: '主题X' }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        };
      }
      return { content: '完成', usage: { prompt_tokens: 10, completion_tokens: 2 } };
    },
    webSearch: async () => ({ ok: true, results: [{ title: 'T', url: 'https://docs.x.com/d', snippet: '' }] }),
    webFetch: async () => ({ ok: true, content: 'body' }),
    writeFile: async (args) => { written.push(args); return { ok: true, path: `/tmp/project/${args.path}` }; },
  };
  let drResult = null;
  await runAgent({
    messages: [{ role: 'user', content: '深入研究主题X' }],
    model, cwd: '/tmp/project', approvalMode: 'on-request', conversationId: 'conv-d',
    toolHandlers: handlers, tokenBudget: 0, maxRounds: 4,
    onMessage: () => {},
    onToolCall: (c) => { if (c.name === 'deep_research') drResult = c.result; },
    onDone: () => {},
  });
  check('runAgent 分发 deep_research 并回传 ok:true', drResult?.ok === true, JSON.stringify(drResult).slice(0, 160));
  check('runAgent 路径上报告被写入 research/', written.length === 1 && String(written[0].path).startsWith('research/'));
  check('runAgent 透传 cwd/审批/会话到写工具',
    written[0]?.cwd === '/tmp/project' && written[0]?.approvalMode === 'on-request' && written[0]?.conversationId === 'conv-d');
}

console.log(`\n──── G-deep-research 门禁汇总：通过 ${pass} · 失败 ${fail} ────`);
process.exit(fail === 0 ? 0 : 1);
