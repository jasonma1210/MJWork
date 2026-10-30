// G-deep-research（2026-10-19）：原生深度研究流水线的**纯函数层**。
//
// 为什么独立成模块：
//   · agent-core/index.js 已是 God File（eslint max-lines 豁免清单成员），流水线逻辑不再往里堆；
//   · 本模块**零依赖、零副作用、零 node: 内建**——只做文本/数据结构变换，因此既能被引擎
//     （Node utilityProcess）引用，也能被渲染层 Vite 打包；单测无需 mock 网络或模型。
//   · 引擎侧（runDeepResearch）只负责「编排 + 调用既有工具通道」；所有「确定性拼装」都在这里，
//     同样的输入永远产出同样的报告结构——可复现、可断言、可回归。
//
// 与技能 prompt 的分工：SKILL_PROMPTS.deep_research 负责「何时用、怎么引导」；
//   本模块负责「实际怎么做」，共同构成对标 Codex deep-research 的原生「检索→证据链→报告」能力。
//
// 与「子代理 / orchestrate_task」的区别：那条路径是**开放式多 Agent 探索**（结果不可预期）；
//   本流水线是**确定性契约**——固定阶段、固定产物结构、真实引用编号，失败如实降级不编造。

// 上限一律取「常量单一事实来源」：引擎编排与报告装配共用，避免两处各写一个魔数。
export const RESEARCH_MAX_SUBQUESTIONS = 6;
export const RESEARCH_MAX_EVIDENCE = 24;
export const RESEARCH_MAX_DEEP_READ = 6;

// ── 规划提示词（纯文本契约，引擎侧直接作为 system 消息发送）──
export const RESEARCH_PLAN_SYSTEM = `你是研究规划器。把用户给出的研究主题拆成 3-5 个互不重叠、可独立检索的子问题。
要求：
1. 覆盖与主题最相关的维度（定义与现状 / 关键数据 / 代表性案例 / 反方观点与争议 / 趋势），不要平均用力；
2. 每个子问题必须是一句可直接当搜索关键词的具体问句（有时间范围或对比对象时写明）；
3. 只输出严格 JSON：{"subquestions":["子问题1","子问题2","子问题3"]}
禁止输出 JSON 以外的任何解释文字与标题。`;

// ── 综合提示词（把证据台账交给模型，要求可溯源的结构化输出）──
export const RESEARCH_SYNTHESIS_SYSTEM = `你是研究分析师。用户会给出「编号证据条目」（每条含标题、URL、摘要），你要产出可溯源的分析结论。
纪律：
1. 每条结论必须标注证据编号（形如 [1][3]），禁止编造编号或来源；引用不到的结论不要写；
2. 区分事实与观点；证据不足或互相矛盾时如实写入 uncertainty，不要强行下结论；
3. 只输出严格 JSON：
{"executive_summary":"3-5 句执行摘要","findings":[{"point":"一条关键发现","refs":[1,3]}],"uncertainty":"分歧与不确定性","conclusion":"结论与建议"}
4. **引用号只放 refs 数组，禁止写进 point / 摘要 / 结论的正文里**（正文写「[1][2]」会被装配层重复追加，真机实测已复现）。
禁止输出 JSON 以外的任何文字。`;

// 主题 → 文件名 slug。确定性：保留 CJK（macOS/Linux/Windows 均允许中文文件名），
// 其余非字母数字字符折叠为单个 '-'，限长 40，空串回落 'research'。
export function slugifyTopic(topic) {
  const cleaned = String(topic || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const cut = cleaned.slice(0, 40).replace(/-$/, '');
  return cut || 'research';
}

// URL 归一化：去 fragment（#...）、去尾斜杠、保留其余原样。
// 非法 URL 原样返回（不臆测改写）；空串返回空串。
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    const out = u.toString();
    return out.endsWith('/') ? out.slice(0, -1) : out;
  } catch { /* C-001：不是合法 URL（模型偶发给出裸域名/描述文本）⇒ 原样返回，由下游按字符串处理 */ 
    return s;
  }
}

export function hostOf(raw) {
  try {
    return new URL(String(raw || '')).hostname.toLowerCase();
  } catch { /* C-001：取不到 host 返回空串；调用方按「无来源站点」处理（代价是该条不参与同站去重） */ 
    return '';
  }
}

// 来源类型判定（规则化，不调模型）：paper > official > community > media。
// 语义即产品要求的「来源类型：官方/媒体/社区/论文」，顺序固定以保证可复现。
// 判定锚点：主机名规则看 host（URL 总带 scheme，直接对整串匹配 `^docs\.` 永远落空）；
//   路径规则（/docs/、.edu/）看整串。这样 `https://docs.x.com/...` 能正确判为官方。
const PAPER_HOST_RE = /(arxiv\.org|doi\.org|springer|sciencedirect|ieee\.org|acm\.org|nature\.com|jstor|pubmed|ncbi\.nlm\.nih\.gov|ssrn\.com)/i;
const OFFICIAL_HOST_RE = /(^|\.)docs\.|(^|\.)developer\.|readthedocs\.io|\.gov$/i;
const OFFICIAL_PATH_RE = /\/docs\/|\/documentation\/?$/i;
const COMMUNITY_HOST_RE = /(github\.com|stackoverflow\.com|stackexchange\.com|reddit\.com|news\.ycombinator\.com|medium\.com|dev\.to|zhihu\.com|juejin\.cn|segmentfault\.com|csdn\.net|cnblogs\.com)/i;

export function classifySource(url) {
  const s = String(url || '');
  if (!s) return 'media';
  const host = hostOf(s);
  if (PAPER_HOST_RE.test(host) || /\.edu$/i.test(host) || /\.edu\//i.test(s)) return 'paper';
  if (OFFICIAL_HOST_RE.test(host) || OFFICIAL_PATH_RE.test(s)) return 'official';
  if (COMMUNITY_HOST_RE.test(host) || /discourse/i.test(s)) return 'community';
  return 'media';
}

// 规划输出解析：优先严格 JSON 的 subquestions，其次按行/项目符号拆行。
// 去重、去空、限长 200、截断到 cap（默认上限来自常量）。
export function parseSubquestions(text, limit = RESEARCH_MAX_SUBQUESTIONS) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const cap = Math.max(1, Math.min(Number(limit) || RESEARCH_MAX_SUBQUESTIONS, RESEARCH_MAX_SUBQUESTIONS));
  let arr = null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      const j = JSON.parse(body.slice(s, e + 1));
      if (Array.isArray(j?.subquestions)) arr = j.subquestions;
    } catch { /* 非 JSON：走行解析兜底 */ }
  }
  if (!arr) {
    arr = raw.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim()).filter(Boolean);
  }
  const out = [];
  for (const item of arr) {
    const q = typeof item === 'string' ? item : String(item?.question || item?.q || '');
    const t = q.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 200) continue;
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

// 证据链：把「子问题 → 检索结果」折叠为**去重后编号**的台账（编号即报告引用号）。
// 输入形如 [{ subquestion, results:[{ title, url, snippet }], error? }]；
// 输出 { entries:[{id,title,url,host,sourceType,snippet,subquestion}], failures:[{subquestion,error}] }。
// 同 URL（归一化后）只保留首次出现；无 URL 的结果以标题为去重键。
export function buildEvidenceLedger(searchResults, { max = RESEARCH_MAX_EVIDENCE } = {}) {
  const list = Array.isArray(searchResults) ? searchResults : [];
  const cap = Math.max(1, Number(max) || RESEARCH_MAX_EVIDENCE);
  const seen = new Set();
  const entries = [];
  const failures = [];
  for (const group of list) {
    const q = String(group?.subquestion || '').trim();
    if (group?.error) failures.push({ subquestion: q, error: String(group.error) });
    const results = Array.isArray(group?.results) ? group.results : [];
    for (const r of results) {
      const url = normalizeUrl(r?.url || r?.link || '');
      const key = url || String(r?.title || '').replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: entries.length + 1,
        title: String(r?.title || r?.name || url || '（无标题）').replace(/\s+/g, ' ').trim().slice(0, 200),
        url,
        host: hostOf(url),
        sourceType: classifySource(url),
        snippet: String(r?.snippet ?? r?.content ?? r?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        subquestion: q,
      });
      if (entries.length >= cap) return { entries, failures };
    }
  }
  return { entries, failures };
}

// 综合输出解析：优先严格 JSON；解析失败则把整段文本当作执行摘要（诚实降级，不伪造小节）。
export function parseSynthesis(text) {
  const raw = String(text || '').trim();
  const none = { executive_summary: '', findings: [], uncertainty: '', conclusion: '' };
  if (!raw) return none;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      const j = JSON.parse(body.slice(s, e + 1));
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const findings = (Array.isArray(j.findings) ? j.findings : [])
          .map((f) => ({
            point: String(typeof f === 'string' ? f : (f?.point || f?.finding || '')).trim(),
            refs: Array.isArray(f?.refs)
              ? f.refs.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
              : [],
          }))
          .filter((f) => f.point);
        return {
          executive_summary: String(j.executive_summary || j.summary || '').trim(),
          findings,
          uncertainty: String(j.uncertainty || j.divergence || '').trim(),
          conclusion: String(j.conclusion || j.recommendation || '').trim(),
        };
      }
    } catch { /* 非 JSON：整段作为执行摘要 */ }
  }
  return { ...none, executive_summary: raw };
}

// 来源类型 → 报告中的中文标签（台账存稳定 token，渲染层做本地化，便于将来加语言）。
const SOURCE_LABELS = { official: '官方', media: '媒体', community: '社区', paper: '论文' };

// 报告装配：**确定性 markdown**（固定六段 + 编号引用列表）。
// 无论模型综合是否成功，结构都稳定；缺内容处显式写明「未产出」，绝不留空白让人误读。
export function assembleResearchReport({
  topic, subquestions = [], ledger = { entries: [], failures: [] }, synthesis = {}, excerpts = {}, generatedAt = '',
} = {}) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const failures = Array.isArray(ledger?.failures) ? ledger.failures : [];
  const ex = excerpts && typeof excerpts === 'object' ? excerpts : {};
  const s = synthesis && typeof synthesis === 'object' ? synthesis : {};
  const date = String(generatedAt || '');
  const label = (t) => SOURCE_LABELS[t] || t || '未知';
  const lines = [];

  lines.push(`# 深度研究：${String(topic || '').trim()}`);
  lines.push('');
  lines.push(`> 生成时间：${date || '（未记录）'} ｜ 检索子问题：${subquestions.length} 个 ｜ 证据条目：${entries.length} 条 ｜ 精读原文：${Object.keys(ex).length} 篇`);
  lines.push('');
  lines.push('## 执行摘要');
  lines.push(s.executive_summary || '（模型未产出执行摘要——请以下方「数据与证据」与「引用列表」为准）');
  lines.push('');
  lines.push('## 关键发现');
  if (Array.isArray(s.findings) && s.findings.length) {
    s.findings.forEach((f, i) => {
      const refs = (Array.isArray(f.refs) ? f.refs : []).map((n) => `[${n}]`).join('');
      // 模型常把引用号写进结论正文（真机实测 9/9 条复现）；有 refs 字段时以字段为准渲染，
      // 并剥掉正文里自带的 [n]，避免「… [1][2]。 [1][2]」这种重复后缀；无 refs 时保留正文原样。
      const raw = String(f.point || '');
      const point = refs ? raw.replace(/\s*\[\d+\]/g, '').replace(/\s{2,}/g, ' ').trim() : raw.trim();
      lines.push(`${i + 1}. ${point}${refs ? ` ${refs}` : ''}`);
    });
  } else {
    lines.push('（未产出可编号的关键发现——证据见下一节）');
  }
  lines.push('');
  lines.push('## 数据与证据');
  if (entries.length) {
    let current = null;
    for (const en of entries) {
      if (en.subquestion && en.subquestion !== current) {
        current = en.subquestion;
        lines.push('');
        lines.push(`### ${current}`);
      }
      lines.push(`- [${en.id}] ${en.title}${en.url ? ` — ${en.url}` : ''}（${label(en.sourceType)}）`);
      if (en.snippet) lines.push(`  - 摘要：${en.snippet}`);
      const excerpt = ex[en.id];
      if (excerpt) lines.push(`  - 精读摘录：${String(excerpt).replace(/\s+/g, ' ').trim().slice(0, 400)}`);
    }
  } else {
    lines.push('（未取得任何可引用证据——检索可能全部失败或被网络限制）');
  }
  lines.push('');
  lines.push('## 分歧与不确定性');
  lines.push(s.uncertainty || '（未见明显分歧；以上结论受检索来源数量与时效限制，请以官方原始文档为准）');
  if (failures.length) {
    lines.push('');
    lines.push('检索失败的子问题（如实记录——未用先验知识冒充检索结果）：');
    for (const f of failures) lines.push(`- ${f.subquestion || '（未标注子问题）'}：${f.error}`);
  }
  lines.push('');
  lines.push('## 结论与建议');
  lines.push(s.conclusion || '（模型未产出结论——请结合上方证据自行判断）');
  lines.push('');
  lines.push('## 引用列表');
  if (entries.length) {
    for (const en of entries) {
      lines.push(`${en.id}. ${en.title}${en.url ? ` — ${en.url}` : ''}（${label(en.sourceType)}${date ? `，访问日期 ${date}` : ''}）`);
    }
  } else {
    lines.push('（无引用可列——本次研究未取得可溯源来源，禁止编造引用）');
  }
  lines.push('');
  return lines.join('\n');
}
