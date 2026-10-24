// P0-2 门禁（2026-10-24）：工件 → 产物桥（doc_create / xlsx_create / pptx_create 的 artifactId + version）
//
// 缺陷（审计原文）：工件库与产物工具之间没有通道——`doc_create` 等工具的参数里没有 artifactId，
//   模型在工件库写完 V0.07 后想交付只能把全文再吐一遍 ⇒ token 翻倍、docx 与工件库不是同一份、
//   每次改稿要双写两处。
//
// 本套件全部是**行为级**断言：真实工件库（sql.js）+ 真实调用 + 解包产物核对文本，
//   **不读源码文本**当判据。判据四条：
//   ① 传 artifactId 即产出 docx，且 docx 的段落序列与工件该版本的章节正文**逐行相等**；
//   ② version 缺省取**最新版本**（写两版：V0.01 / V0.02，缺省必须得到 V0.02）；
//   ③ 返回体带 artifactId/version/path/bytes，调用方可核对「产物 == 工件」；
//   ④ 类型不匹配（xlsx 工具收叙述型工件）、版本越界、工件不存在、空工件一律 fail-closed，
//      且**不落盘**（不留半成品文件）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

// electron 最小 stub（docTools 的 audit 依赖 app.getPath；ipc/artifacts 的 registerHandlers 依赖 ipcMain）
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
stub.exports = {
  app: { getPath: () => path.join(os.tmpdir(), 'mjcode-p02-electron'), on: () => {}, whenReady: () => Promise.resolve() },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {} },
};
require.cache[electronPath] = stub;

const { openDbAsync } = require(path.join(ROOT, 'main/db'));
const { ProjectStore } = require(path.join(ROOT, 'main/projectStore'));
const { ArtifactStore } = require(path.join(ROOT, 'main/artifactStore'));
const docTools = require(path.join(ROOT, 'main/docTools.js'));
const artifactProduct = require(path.join(ROOT, 'main/tools/artifactProduct.js'));
const JSZip = require('jszip');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 从 OOXML 解出「每个 w:p 的纯文本」（跨 run 合并，避免同段被拆成多个 w:t 造成假红）
async function docxParagraphs(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('word/document.xml').async('string');
  const out = [];
  for (const pm of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const texts = [...pm[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
    const text = texts.join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (text !== '') out.push(text);
  }
  return out;
}

async function pptxSlideTexts(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const pages = [];
  for (const n of names) {
    const xml = await zip.file(n).async('string');
    pages.push([...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('\n'));
  }
  return pages;
}

const V1_LINES = ['初版结论：总价 12 万元。', '维护期三年。'];
const V2_LINES = ['修订结论：总价 15 万元（含税）。', '维护期改为两年。'];
const SECTION_TITLE = '报价结论';
const EMPTY_SECTION = '风险提示';
const ART_TITLE = '客户报价单';

function initDeps({ store } = {}) {
  const calls = [];
  docTools.initDocTools({
    requestApproval: async (tool) => { calls.push(tool); return 'allow-once'; },
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    getGovernance: () => ({ profile: 'normal', fsMode: 'read-write', sandboxNetwork: false }),
    userDataDir: path.join(os.tmpdir(), 'mjcode-p02-data'),
    // 生产装配由 ipc/artifacts 发布 resolver；这里显式注入用于「依赖注入路径」的用例
    ...(store ? { getArtifactStore: () => store } : {}),
  });
  return calls;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-p02-'));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-p02-db-'));
const db = await openDbAsync(dbDir, { driver: 'sqljs' });
const projects = new ProjectStore(db);
const store = new ArtifactStore(db);
projects.createProject({ projectId: 'prj_p02', name: '报价项目', objective: '出一份报价单' });

const art = store.createArtifact({
  projectId: 'prj_p02',
  title: ART_TITLE,
  outline: [
    { key: 'goal', title: SECTION_TITLE, order: 0 },
    { key: 'risk', title: EMPTY_SECTION, order: 1 },
  ],
});
// 真写两版：V0.01（初版）→ V0.02（客户改稿）
store.patchSection({ artifactId: art.artifactId, sectionKey: 'goal', content: V1_LINES.join('\n'), baseVersion: 'V0.0', changeSummary: '初版' });
store.patchSection({ artifactId: art.artifactId, sectionKey: 'goal', content: V2_LINES.join('\n'), baseVersion: 'V0.01', changeSummary: '客户改稿' });
const current = store.getArtifact(art.artifactId).currentVersion;

// 空工件（V0.0，从未写入）
const emptyArt = store.createArtifact({ projectId: 'prj_p02', title: '空工件', outline: [{ key: 's1', title: '概述' }] });

try {
  // ── ① 工件 → docx：内容相等 + 元信息 ──
  {
    initDeps({ store });
    const docxPath = path.join(tmp, 'from-artifact.docx');
    const r = await docTools.toolDocCreate({ path: docxPath, cwd: tmp, artifactId: art.artifactId });
    check('doc_create({artifactId}) 直接产出 .docx（无需 blocks）',
      r.ok === true && fs.existsSync(docxPath), JSON.stringify(r).slice(0, 160));

    const paras = r.ok ? await docxParagraphs(docxPath) : [];
    // 严格相等：标题（取工件标题）+ 章节标题 + 该版本正文逐行，顺序与大纲一致；空章节只出标题
    const expected = [ART_TITLE, SECTION_TITLE, ...V2_LINES, EMPTY_SECTION];
    check('docx 段落序列与工件「最新版本」正文逐行相等（产物 == 工件）',
      JSON.stringify(paras) === JSON.stringify(expected),
      `got=${JSON.stringify(paras)}`);

    check('返回体带 artifactId/version/path/bytes，可核对「产物 == 工件」',
      r.ok === true && r.artifactId === art.artifactId && r.version === current
      && typeof r.path === 'string' && r.bytes === fs.statSync(docxPath).size,
      `version=${r.version} current=${current} bytes=${r.bytes}`);

    check('version 缺省 = 该工件最新版本（两版中取到 V0.02，含修订行、不含初版行）',
      r.ok === true && current === 'V0.02'
      && paras.includes(V2_LINES[0]) && !paras.includes(V1_LINES[0])
      && !paras.some((p) => p.includes('12 万元')));

    // 同行序：正文两行必须按工件里的先后顺序出现（不是集合相等）
    const i1 = paras.indexOf(V2_LINES[0]);
    const i2 = paras.indexOf(V2_LINES[1]);
    check('docx 正文顺序与工件一致（第 1 行在第 2 行之前）', i1 >= 0 && i2 > i1, `i1=${i1} i2=${i2}`);

    // ── ② 显式 version：取历史版本，且与默认版本内容不同（证明 version 真的生效） ──
    const oldPath = path.join(tmp, 'from-artifact-v1.docx');
    const rOld = await docTools.toolDocCreate({ path: oldPath, cwd: tmp, artifactId: art.artifactId, version: 'V0.01' });
    const oldParas = rOld.ok ? await docxParagraphs(oldPath) : [];
    check('doc_create 传 version=V0.01 → 渲染该历史版本正文（含初版行、不含修订行）',
      rOld.ok === true && rOld.version === 'V0.01'
      && oldParas.includes(V1_LINES[0]) && !oldParas.includes(V2_LINES[0]),
      `got=${JSON.stringify(oldParas)}`);

    // ── ③ 向后兼容：不传 artifactId 时走 blocks 路径，行为与返回体不变 ──
    const legacyPath = path.join(tmp, 'legacy.docx');
    const legacy = await docTools.toolDocCreate({
      path: legacyPath, cwd: tmp, title: '旧路径',
      blocks: [{ type: 'heading', level: 1, text: '章节' }, { type: 'paragraph', text: '正文' }],
    });
    const legacyParas = legacy.ok ? await docxParagraphs(legacyPath) : [];
    check('blocks 旧路径完全兼容（不传 artifactId 时行为不变，返回体不带 artifactId/version）',
      legacy.ok === true && legacy.artifactId === undefined && legacy.version === undefined
      && JSON.stringify(legacyParas) === JSON.stringify(['旧路径', '章节', '正文']),
      JSON.stringify(legacy).slice(0, 140));
  }

  // ── ④ pptx：同一工件 → 一页一章 ──
  {
    initDeps({ store });
    const pptxPath = path.join(tmp, 'from-artifact.pptx');
    const r = await docTools.toolPptxCreate({ path: pptxPath, cwd: tmp, artifactId: art.artifactId });
    const pages = r.ok ? await pptxSlideTexts(pptxPath) : [];
    check('pptx_create({artifactId}) 产出 .pptx（封面 + 一页一章）',
      r.ok === true && pages.length === 3 && r.version === current,
      `pages=${pages.length} ${JSON.stringify(r).slice(0, 120)}`);
    check('pptx 页面文本与工件该版本一致（章节标题 + 正文要点）',
      pages.some((t) => t.includes(ART_TITLE))
      && pages.some((t) => t.includes(SECTION_TITLE) && t.includes(V2_LINES[0]) && t.includes(V2_LINES[1]))
      && pages.some((t) => t.includes(EMPTY_SECTION)),
      JSON.stringify(pages).slice(0, 240));
  }

  // ── ⑤ 二选一的三个边界（schema 表达不了互斥 ⇒ 必填性下沉到 handler，必须逐条钉住）──
  {
    initDeps({ store });
    // (a) 都不给：结构化报错（不是抛异常、不是静默产出空表）
    const nonePath = path.join(tmp, 'neither.xlsx');
    const neither = await docTools.toolXlsxCreate({ path: nonePath, cwd: tmp });
    check('(a) xlsx 既无 sheets 也无 artifactId → 结构化失败（未抛异常、error 指明 sheets、不落盘）',
      neither.ok === false && typeof neither.error === 'string' && /sheets/.test(neither.error)
      && !fs.existsSync(nonePath),
      JSON.stringify(neither).slice(0, 160));

    // (b) 都给：歧义必须显式处理（不能靠参数顺序/覆盖碰运气），且不落盘
    const bothPath = path.join(tmp, 'both.xlsx');
    const both = await docTools.toolXlsxCreate({
      path: bothPath, cwd: tmp, artifactId: art.artifactId,
      sheets: [{ name: '预算', header: ['项目'], rows: [['服务器']] }],
    });
    check('(b) xlsx 同时给 sheets 与 artifactId → ARTIFACT_SOURCE_CONFLICT（不静默挑一个）',
      both.ok === false && both.code === 'ARTIFACT_SOURCE_CONFLICT' && !fs.existsSync(bothPath),
      JSON.stringify(both).slice(0, 160));

    // (b') doc / pptx 同一条纪律（三工具一套语义，避免各写各的）
    const docBoth = await docTools.toolDocCreate({
      path: path.join(tmp, 'both.docx'), cwd: tmp, artifactId: art.artifactId,
      blocks: [{ type: 'paragraph', text: '手写正文' }],
    });
    const pptBoth = await docTools.toolPptxCreate({
      path: path.join(tmp, 'both.pptx'), cwd: tmp, artifactId: art.artifactId,
      slides: [{ title: '手写页' }],
    });
    check('(b) doc_create/pptx_create 同时给内容参数与 artifactId → 同样 ARTIFACT_SOURCE_CONFLICT',
      docBoth.code === 'ARTIFACT_SOURCE_CONFLICT' && pptBoth.code === 'ARTIFACT_SOURCE_CONFLICT'
      && !fs.existsSync(path.join(tmp, 'both.docx')) && !fs.existsSync(path.join(tmp, 'both.pptx')),
      `${docBoth.code} / ${pptBoth.code}`);

    // 空数组不算「给了内容」：历史调用方补 blocks: [] 占位不应被误伤
    const emptyBlocks = await docTools.toolDocCreate({ path: path.join(tmp, 'empty-blocks.docx'), cwd: tmp, artifactId: art.artifactId, blocks: [] });
    check('(b) blocks: [] 视为未给内容，仍按工件渲染（不误伤占位写法）',
      emptyBlocks.ok === true && emptyBlocks.version === current, JSON.stringify(emptyBlocks).slice(0, 120));
  }

  // ── ⑥ 类型不匹配 fail-closed（xlsx 工具收叙述型工件）──
  {
    initDeps({ store });
    const xlsxPath = path.join(tmp, 'mismatch.xlsx');
    const r = await docTools.toolXlsxCreate({ path: xlsxPath, cwd: tmp, artifactId: art.artifactId });
    check('xlsx_create 收到叙述型工件 → ARTIFACT_FORMAT_MISMATCH（结构化失败，不静默降级）',
      r.ok === false && r.code === 'ARTIFACT_FORMAT_MISMATCH' && r.artifactKind === 'document',
      JSON.stringify(r).slice(0, 200));
    check('类型不匹配时不落盘（没有半成品 .xlsx）', !fs.existsSync(xlsxPath));
  }

  // ── ⑦ 其余 fail-closed 分支 ──
  {
    initDeps({ store });
    const ahead = await docTools.toolDocCreate({ path: path.join(tmp, 'ahead.docx'), cwd: tmp, artifactId: art.artifactId, version: 'V0.99' });
    check('版本超过当前版本 → ARTIFACT_VERSION_AHEAD（不静默拿当前正文顶替）',
      ahead.ok === false && ahead.code === 'ARTIFACT_VERSION_AHEAD', JSON.stringify(ahead).slice(0, 160));

    const missing = await docTools.toolDocCreate({ path: path.join(tmp, 'missing.docx'), cwd: tmp, artifactId: 'art_not_exist' });
    check('工件不存在 → ARTIFACT_NOT_FOUND', missing.ok === false && missing.code === 'ARTIFACT_NOT_FOUND');

    const empty = await docTools.toolDocCreate({ path: path.join(tmp, 'empty.docx'), cwd: tmp, artifactId: emptyArt.artifactId });
    check('空工件（V0.0 无正文）→ ARTIFACT_EMPTY，不产出空文档',
      empty.ok === false && empty.code === 'ARTIFACT_EMPTY' && !fs.existsSync(path.join(tmp, 'empty.docx')),
      JSON.stringify(empty).slice(0, 160));

    const badVer = await docTools.toolDocCreate({ path: path.join(tmp, 'badver.docx'), cwd: tmp, artifactId: art.artifactId, version: 'v2' });
    check('版本号格式非法 → ARTIFACT_INVALID_VERSION', badVer.ok === false && badVer.code === 'ARTIFACT_INVALID_VERSION');

    // store 不可用：清掉 resolver 且不注入 getter → fail-closed（而不是崩或产出空文件）
    artifactProduct.setArtifactStoreProvider(null);
    initDeps();
    const noStore = await docTools.toolDocCreate({ path: path.join(tmp, 'nostore.docx'), cwd: tmp, artifactId: art.artifactId });
    check('工件库不可用 → ARTIFACT_STORE_UNAVAILABLE（fail-closed）',
      noStore.ok === false && noStore.code === 'ARTIFACT_STORE_UNAVAILABLE' && !fs.existsSync(path.join(tmp, 'nostore.docx')));
  }

  // ── ⑧ 生产装配路径：main.js 不注入 docTools.getArtifactStore，靠 ipc/artifacts 发布 resolver ──
  {
    const { initArtifactsIpc } = require(path.join(ROOT, 'main/ipc/artifacts.js'));
    initArtifactsIpc({ getArtifactStore: () => store, getProjectStore: () => projects });
    initDeps(); // 刻意不注入 getArtifactStore
    const p = path.join(tmp, 'wired.docx');
    const r = await docTools.toolDocCreate({ path: p, cwd: tmp, artifactId: art.artifactId });
    const paras = r.ok ? await docxParagraphs(p) : [];
    check('生产装配（ipc/artifacts 发布 resolver、docTools 未注入 getter）下桥仍可用',
      r.ok === true && paras.includes(V2_LINES[0]) && r.version === current,
      JSON.stringify(r).slice(0, 140));
  }
} finally {
  docTools.disposeDocTools();
  for (const d of [tmp, dbDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } }
}

console.log(`\n总计 ${pass + fail} · 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
