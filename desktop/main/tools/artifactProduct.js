// P0-2：工件 → 产物桥（artifactId → .docx/.xlsx/.pptx）
//
// 问题（审计 P0-2）：工件库与产物工具之间没有通道——`doc_create` 等工具的参数里没有
//   `artifactId`，模型在工件库写完 V0.07 后想交付只能把全文再吐一遍，于是
//   ① token 翻倍；② docx 与工件库不是同一份；③ 每次改稿要双写两处。
//
// 本模块只做三件事：
//   ① 按 `artifactId` + `version`（缺省 = 最新版本）从工件库取**该版本**的章节正文；
//   ② 把章节正文确定性地渲染成产物内容模型（docx 的扁平块 / pptx 的页），不二次摘要；
//   ③ 类型不匹配时 fail-closed：工件 `kind` 必须声明支持该产物形态，否则返回结构化错误，
//      **绝不**把叙述正文摊成一张假表格或静默降级。
//
// 三条边界：
//   · 只读工件库：本模块不写库、不写盘（产物落盘仍走 docTools 的既有写闸与 L2 审批）；
//   · 不新增网络请求、不改审批档位与凭证逻辑；
//   · 渲染是纯函数（sectionsToDocBlocks / sectionsToPptxSlides），可被单测直接断言。

const { versionValue } = require('../artifactStore');

// 产物形态（与三个文档工具一一对应）
const PRODUCTS = { DOCX: 'docx', XLSX: 'xlsx', PPTX: 'pptx' };

// 工件 kind → 可渲染的产物形态（单一事实来源）。
// 现状：工件库的 kind 词汇表是「叙述型文档的子类」（document/spec/plan/custom），
// 四个都是长文正文，因此都能成文（docx）与成稿（pptx）；**没有**任何一个 kind 表达
// 表格型内容，故 xlsx 不在任何 kind 的白名单里 —— 给 xlsx 传工件一律 fail-closed，
// 而不是把段落硬塞进单元格。要真正支持表格工件，需要工件库先引入表格型 kind。
const KIND_PRODUCTS = {
  document: ['docx', 'pptx'],
  spec: ['docx', 'pptx'],
  plan: ['docx', 'pptx'],
  custom: ['docx', 'pptx'],
};

// pptx 单页要点上限：超过会让版式溢出（pptxgenjs 不会自动分页），余下内容转演讲者备注
const PPTX_MAX_BULLETS = 10;

// ── store 解析：生产装配点在 main/ipc/artifacts.js（main.js 已在那里注入 getArtifactStore），
// 单测可直接调 setArtifactStoreProvider 或给 docTools 注入 deps.getArtifactStore。──
let storeProvider = null;

function setArtifactStoreProvider(fn) {
  storeProvider = typeof fn === 'function' ? fn : null;
}

function resolveArtifactStore(explicit) {
  if (explicit) return explicit;
  if (!storeProvider) return null;
  try { return storeProvider() || null; } catch { return null; }
}

function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

function textLines(content) {
  return String(content == null ? '' : content)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/**
 * 取工件某版本的章节正文。
 * @param {{artifactId?:string, version?:string, product:string, store?:object}} p
 * @returns {{ok:true, artifactId:string, version:string, title:string, kind:string,
 *            sections:Array<{key:string,title:string,level:number,content:string}>, chars:number}
 *          | {ok:false, code:string, error:string}}
 */
function loadArtifactForProduct({ artifactId, version, product, store } = {}) {
  const id = String(artifactId || '').trim();
  if (!id) return fail('ARTIFACT_ID_REQUIRED', 'artifactId 不能为空');
  if (!product) return fail('PRODUCT_REQUIRED', '未指定产物形态');
  const st = resolveArtifactStore(store);
  if (!st) return fail('ARTIFACT_STORE_UNAVAILABLE', '工件库不可用（项目空间未初始化）');

  let art = null;
  try {
    art = st.getArtifact(id);
  } catch (e) {
    return fail('ARTIFACT_ERROR', `读取工件失败：${(e && e.message) || e}`);
  }
  if (!art) return fail('ARTIFACT_NOT_FOUND', `工件不存在：${id}`);

  // ① 类型闸：工件 kind 必须声明支持该产物（fail-closed，不静默降级）
  const allowed = KIND_PRODUCTS[art.kind] || [];
  if (!allowed.includes(product)) {
    return fail(
      'ARTIFACT_FORMAT_MISMATCH',
      `工件类型不匹配：${id} 是「${art.kind}」类型，不能渲染为 .${product}`
        + `（该类型支持的产物：${allowed.length ? allowed.map((x) => `.${x}`).join(' / ') : '无'}）。`
        + '请改用匹配的工具，或按 blocks/sheets/slides 直接传内容。',
      { artifactKind: art.kind, product, supportedProducts: allowed },
    );
  }

  // ② 版本闸：缺省取最新版本；显式版本必须存在且不超过当前版本（否则会静默拿到别的版本正文）
  const want = String(version == null ? '' : version).trim();
  const target = want || art.currentVersion;
  const targetValue = versionValue(target);
  if (targetValue < 0) {
    return fail('ARTIFACT_INVALID_VERSION', `版本号非法：${target}（应形如 V0.07）`);
  }
  if (targetValue > versionValue(art.currentVersion)) {
    return fail(
      'ARTIFACT_VERSION_AHEAD',
      `版本不存在：${id} 当前版本是 ${art.currentVersion}，请求的是 ${target}`,
      { currentVersion: art.currentVersion, requestedVersion: target },
    );
  }

  // ③ 版本重建：取「version ≤ 目标」的最新历史行（与 artifact_get_section 同一语义）
  let rebuilt = null;
  try {
    rebuilt = st.rebuildVersion({ artifactId: id, version: target });
  } catch (e) {
    return fail((e && e.code) || 'ARTIFACT_ERROR', (e && e.message) || String(e));
  }
  const at = (rebuilt && rebuilt.sections) || {};
  const sections = art.outline.map((s) => ({
    key: s.key,
    title: s.title,
    level: Number(s.level) || 1,
    content: (at[s.key] && at[s.key].content) || '',
  }));
  const chars = sections.reduce((n, s) => n + Array.from(s.content).length, 0);
  if (!sections.some((s) => textLines(s.content).length > 0)) {
    return fail(
      'ARTIFACT_EMPTY',
      `工件 ${id}@${target} 还没有正文（所有章节为空），没有可渲染的内容`,
      { version: target },
    );
  }
  return { ok: true, artifactId: id, version: target, title: art.title, kind: art.kind, sections, chars };
}

/**
 * 章节 → docx 扁平块（render 规则确定性：章节标题 = heading(level)，正文按**非空行**逐行成段）。
 * 不做 markdown 解析：产物必须能与工件正文逐行对齐，任何二次加工都会让「产物 == 工件」不可验证。
 */
function sectionsToDocBlocks(sections) {
  const blocks = [];
  for (const s of Array.isArray(sections) ? sections : []) {
    blocks.push({ type: 'heading', level: Math.min(3, Math.max(1, Number(s.level) || 1)), text: String(s.title || '') });
    for (const line of textLines(s.content)) blocks.push({ type: 'paragraph', text: line });
  }
  return blocks;
}

/** 章节 → pptx 内容页（一页一章：页标题 = 章节标题，要点 = 正文非空行；溢出转备注） */
function sectionsToPptxSlides(sections) {
  const slides = [];
  for (const s of Array.isArray(sections) ? sections : []) {
    const lines = textLines(s.content);
    const bullets = lines.slice(0, PPTX_MAX_BULLETS);
    const overflow = lines.slice(PPTX_MAX_BULLETS);
    const slide = { title: String(s.title || '') };
    if (bullets.length) slide.bullets = bullets;
    if (overflow.length) slide.notes = overflow.join('\n');
    slides.push(slide);
  }
  return slides;
}

module.exports = {
  PRODUCTS, KIND_PRODUCTS, PPTX_MAX_BULLETS,
  setArtifactStoreProvider, resolveArtifactStore,
  loadArtifactForProduct, sectionsToDocBlocks, sectionsToPptxSlides,
};
