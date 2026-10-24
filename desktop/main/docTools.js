// G-doc（2026-10-19）：文档生成原生工具层——Word(.docx) / Excel(.xlsx) / PPT(.pptx) / PDF 四类产出。
//
// 为什么走「原生内置工具」而不是 MCP 连接器（用户决策 + 架构红线）：
//   · 项目红线「本地系统原生能力一律做内置原生工具」——文档生成是纯本地能力（无外部服务、无鉴权），
//     且用户要求「输入时即生成」= 默认自启；落 whitelist 档的连接器满足不了该要求；
//   · 用户点名的 mcp-pptx / mcp-docx / html-pdf-mcp 三个包经核实**并不存在**
//     （npm/PyPI 均无此包名，html-pdf 只是早已废弃的 phantomjs 库）；真实存在的替代包需要
//     npx 联网拉取 + Node 版本约束，离线不可用、失败面大。
//
// 实现选型（依赖见 desktop/package.json）：
//   · .docx → docx（纯 JS，无原生模块）
//   · .xlsx → exceljs（纯 JS）
//   · .pptx → pptxgenjs（纯 JS）
//   · .pdf  → Electron 自带 Chromium 的 webContents.printToPDF()（零额外依赖、完整 CSS、系统中文字体）
//
// 分级 / 摘要 / 可补偿性统一在 main/approval.js 单一事实来源；
// 写路径策略（白名单根 / 受保护路径 / 只读能力档）复用 main/writeGuard.js（SSOT），不另起一套判定。
//
// Electron 能力按需解析（不在模块顶层硬绑定）：非 Electron 宿主（单测）下 PDF 渲染 fail-closed，
// 其余三个工具仍可真实产出，因此本模块可在 Node 里被真实单测。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { audit } = require('./audit/auditLog');
// 本机产物写闸：单一事实来源（G-latex 的 latex_compile 与本模块四工具共用）
const { gateArtifactWrite } = require('./tools/artifactWriteGate');
// 超时数值单一事实来源（与引擎 TOOL_TIMEOUT_OVERRIDES 对账，见 main/tools/timeouts.js 头注释）
const { DOC_GEN_IMPL_TIMEOUT_MS } = require('./tools/timeouts');
// P0-2：工件 → 产物桥（artifactId + version → 章节正文 → 产物内容模型）
const artifactProduct = require('./tools/artifactProduct');

let electron = null;
try { electron = require('electron'); } catch { electron = null; }
const BrowserWindow = electron?.BrowserWindow || null;

let deps = null;
const pdfWindows = new Set();     // 在渲染中的 PDF 窗口（退出时兜底销毁，避免残留隐藏窗口）
const PDF_RENDER_TIMEOUT_MS = DOC_GEN_IMPL_TIMEOUT_MS; // 实现侧渲染上限（引擎看门狗 60000，满足「实现侧 < 看门狗」）

function initDocTools(d) {
  deps = d;
}

// ── 工具名 → 审批 key（引擎侧 tool 名与审批表 key 一致，此处仅作显式声明，避免拼写漂移）──
const TOOL_KEYS = {
  doc_create: 'doc_create',
  xlsx_create: 'xlsx_create',
  pptx_create: 'pptx_create',
  pdf_generate: 'pdf_generate',
};

function summarize(tool, args = {}) {
  const p = String(args.path || '').slice(0, 160);
  // P0-2：传了 artifactId 时正文来自工件库，摘要要写来源而不是「0 个内容块」
  const art = String(args.artifactId || '').trim();
  if (art) return `${p}（来源工件 ${art}@${String(args.version || '').trim() || '最新版本'}）`;
  if (tool === 'doc_create') return `${p}（${Array.isArray(args.blocks) ? args.blocks.length : 0} 个内容块）`;
  if (tool === 'xlsx_create') return `${p}（${Array.isArray(args.sheets) ? args.sheets.length : 0} 个工作表）`;
  if (tool === 'pptx_create') return `${p}（${Array.isArray(args.slides) ? args.slides.length : 0} 页）`;
  if (tool === 'pdf_generate') return `${p}（HTML ${String(args.html || '').length} 字符）`;
  return p;
}

// ── 输出路径解析与写闸（策略全部下沉到 writeGuard，本模块不自建判定）──
function ensureExt(absPath, ext) {
  return absPath.toLowerCase().endsWith(ext) ? absPath : `${absPath}${ext}`;
}

function resolveOutPath(raw, cwd, ext) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const base = String(cwd || '').trim() || process.cwd();
  const abs = path.isAbsolute(s) ? path.resolve(s) : path.resolve(base, s);
  return ensureExt(abs, ext);
}

/**
 * 写闸：本机产物落盘统一纪律，实现已抽到 main/tools/artifactWriteGate.js（单一事实来源）。
 * 这里只做一次转投，保持本模块调用点的可读性（工具键 + 参数 + 绝对路径）。
 */
function gateWrite(toolKey, args, absPath) {
  return gateArtifactWrite(deps, toolKey, args, absPath);
}

// 库按需加载（缺失时给出明确错误，而不是模块加载期崩溃）
function loadLib(name) {
  try { return require(name); } catch (e) { return { __loadError: e.message }; }
}

// 统一的收尾：mkdir + 写盘 + 审计。任何工具实现抛错都转成结构化失败（不冒泡成 IPC rejection）。
async function writeArtifact(toolKey, args, absPath, buf, asked, meta) {
  try {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, buf);
  } catch (e) {
    audit(toolKey, absPath, `write error: ${e.message}`, 'error');
    return { ok: false, error: `写入文件失败：${e.message}` };
  }
  const bytes = Buffer.isBuffer(buf) ? buf.length : (buf?.byteLength || 0);
  audit(toolKey, summarize(toolKey, args), `ok ${bytes}B`, asked ? 'approved' : 'recorded');
  return { ok: true, path: absPath, bytes, ...(meta || {}) };
}

// ═══ doc_create（Word .docx）═══
// 内容模型：blocks[] 一维数组，每块按 type 分派。刻意保持「扁平块」而不是嵌套树——
// 模型生成嵌套结构容易丢层级，扁平块（heading/paragraph/bullet/numbered/table/quote/pagebreak/code）
// 已能覆盖日报、周报、方案、预算说明等绝大多数文档形态。
const DOC_HEADING = { 1: 'HEADING_1', 2: 'HEADING_2', 3: 'HEADING_3' };

function buildDocxBlocks(docxLib, blocks) {
  const { Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, PageBreak } = docxLib;
  const out = [];
  for (const raw of Array.isArray(blocks) ? blocks : []) {
    const b = raw && typeof raw === 'object' ? raw : {};
    const type = String(b.type || 'paragraph').toLowerCase();
    if (type === 'heading') {
      const lvl = DOC_HEADING[Number(b.level) || 1] || 'HEADING_1';
      out.push(new Paragraph({ text: String(b.text ?? ''), heading: HeadingLevel[lvl] }));
    } else if (type === 'bullet') {
      for (const it of Array.isArray(b.items) ? b.items : []) {
        out.push(new Paragraph({ text: String(it ?? ''), bullet: { level: 0 } }));
      }
    } else if (type === 'numbered') {
      for (const it of Array.isArray(b.items) ? b.items : []) {
        out.push(new Paragraph({ text: String(it ?? ''), numbering: { reference: 'mj-ordered', level: 0 } }));
      }
    } else if (type === 'table') {
      const headers = Array.isArray(b.headers) ? b.headers.map((h) => String(h ?? '')) : [];
      const rows = (Array.isArray(b.rows) ? b.rows : []).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')]));
      const all = headers.length ? [headers, ...rows] : rows;
      out.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: all.map((cells, ri) => new TableRow({
          children: cells.map((c) => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: c, bold: ri === 0 && headers.length > 0 })] })],
          })),
        })),
      }));
      out.push(new Paragraph({ text: '' })); // 表格后留一行空段，避免与后续标题粘连
    } else if (type === 'quote') {
      out.push(new Paragraph({
        children: [new TextRun({ text: String(b.text ?? ''), italics: true })],
        indent: { left: 480 },
        alignment: AlignmentType.LEFT,
      }));
    } else if (type === 'code') {
      out.push(new Paragraph({
        children: [new TextRun({ text: String(b.text ?? ''), font: 'Menlo' })],
        shading: { fill: 'F3F4F6' },
      }));
    } else if (type === 'pagebreak') {
      out.push(new Paragraph({ children: [new PageBreak()] }));
    } else {
      out.push(new Paragraph({
        children: b.bold
          ? [new TextRun({ text: String(b.text ?? ''), bold: true })]
          : undefined,
        text: b.bold ? undefined : String(b.text ?? ''),
      }));
    }
  }
  return out;
}

async function toolDocCreate(args = {}) {
  const docxLib = loadLib('docx');
  if (docxLib.__loadError) return { ok: false, error: `docx 库不可用：${docxLib.__loadError}` };
  const absPath = resolveOutPath(args.path, args.cwd, '.docx');
  if (!absPath) return { ok: false, error: 'path 必填（输出 .docx 的路径）' };
  let blocks = Array.isArray(args.blocks) ? args.blocks : [];
  let title = args.title;
  let artMeta = null;
  // P0-2：给了 artifactId 就从工件库取该版本正文渲染，模型不再重复传全文。
  // 类型/版本不符 → 结构化失败（不落盘、不弹审批），绝不静默降级成空文档。
  // 歧义闸：artifactId 与 blocks 同时给 ⇒ 正文有两个真源，必须报错而不是「谁优先看运气」
  //（空数组不算给了内容，避免历史调用方补 `blocks: []` 占位时被误伤）。
  if (String(args.artifactId || '').trim() && blocks.length) {
    return {
      ok: false,
      code: 'ARTIFACT_SOURCE_CONFLICT',
      error: 'artifactId 与 blocks 不能同时给：正文只能有一个来源。要按工件渲染就删掉 blocks，要手写正文就删掉 artifactId。',
    };
  }
  if (String(args.artifactId || '').trim()) {
    const src = artifactProduct.loadArtifactForProduct({
      artifactId: args.artifactId,
      version: args.version,
      product: artifactProduct.PRODUCTS.DOCX,
      store: deps?.getArtifactStore?.(),
    });
    if (src.ok !== true) return src;
    blocks = artifactProduct.sectionsToDocBlocks(src.sections);
    title = String(args.title || src.title || '');
    artMeta = { artifactId: src.artifactId, version: src.version };
  }
  if (!blocks.length && !title) return { ok: false, error: '请提供 title 或 blocks（至少一个内容块）' };

  const gate = await gateWrite(TOOL_KEYS.doc_create, args, absPath);
  if (gate.ok === false) return gate;

  try {
    const { Document, Packer, Paragraph, HeadingLevel, AlignmentType } = docxLib;
    const children = [];
    if (title) children.push(new Paragraph({ text: String(title), heading: HeadingLevel.TITLE }));
    if (args.subtitle) children.push(new Paragraph({ text: String(args.subtitle), alignment: AlignmentType.CENTER }));
    children.push(...buildDocxBlocks(docxLib, blocks));
    const doc = new Document({
      numbering: {
        config: [{
          reference: 'mj-ordered',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }],
        }],
      },
      sections: [{ children }],
    });
    const buf = await Packer.toBuffer(doc);
    // 返回体带 artifactId/version：调用方可据此核对「产物 == 工件该版本」
    return await writeArtifact(TOOL_KEYS.doc_create, args, absPath, buf, gate.asked, { title: title || null, ...(artMeta || {}) });
  } catch (e) {
    audit(TOOL_KEYS.doc_create, absPath, `error: ${e.message}`, 'error');
    return { ok: false, error: `生成 Word 文档失败：${e.message}` };
  }
}

// ═══ xlsx_create（Excel .xlsx）═══
// 内容模型：sheets[]，每表可有 header（加粗表头 + 冻结首行）与 rows（二维数组）。列宽可显式给，
// 也可由 autoWidth 按内容长度估算（日报/预算这类表列少，自动估算足够）。
function applyAutoWidth(ws, colCount) {
  const widths = [];
  for (let c = 1; c <= colCount; c += 1) {
    let max = 8;
    ws.getColumn(c).eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value == null ? '' : cell.value).length;
      if (len + 2 > max) max = len + 2;
    });
    widths.push(Math.min(max, 60));
  }
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

async function toolXlsxCreate(args = {}) {
  const ExcelJS = loadLib('exceljs');
  if (ExcelJS.__loadError) return { ok: false, error: `exceljs 库不可用：${ExcelJS.__loadError}` };
  const absPath = resolveOutPath(args.path, args.cwd, '.xlsx');
  if (!absPath) return { ok: false, error: 'path 必填（输出 .xlsx 的路径）' };
  const sheets = Array.isArray(args.sheets) ? args.sheets.filter((s) => s && typeof s === 'object') : [];
  // 二选一的三个边界（schema 的 required 表达不了互斥，故必填性下沉到 handler，逐条钉住）：
  //   ① 都不给 → 结构化报错；② 都给 → 歧义，明确报错（不靠参数顺序碰运气）；③ 只给 artifactId → 见下。
  if (String(args.artifactId || '').trim() && sheets.length) {
    return {
      ok: false,
      code: 'ARTIFACT_SOURCE_CONFLICT',
      error: 'artifactId 与 sheets 不能同时给：工作表只能有一个来源。要按工件渲染就删掉 sheets，要手写表格就删掉 artifactId。',
    };
  }
  // P0-2：工件 → 表格的桥只对「声明支持 xlsx 的 kind」开放。当前工件库的 kind 全是叙述型，
  // 因此这里必然 fail-closed —— 这是刻意的：把段落硬摊进单元格是静默降级，宁可明确拒绝。
  if (String(args.artifactId || '').trim()) {
    const src = artifactProduct.loadArtifactForProduct({
      artifactId: args.artifactId,
      version: args.version,
      product: artifactProduct.PRODUCTS.XLSX,
      store: deps?.getArtifactStore?.(),
    });
    if (src.ok !== true) return src;
    // 走到这里说明工件库新增了表格型 kind，但表格渲染尚未实现：明确报错，不返回「成功但没落盘」
    return {
      ok: false,
      code: 'ARTIFACT_PRODUCT_NOT_IMPLEMENTED',
      error: `工件 ${src.artifactId}@${src.version} 可渲染为表格，但表格渲染尚未实现；请改用 sheets 直接传内容`,
    };
  }
  if (!sheets.length) return { ok: false, error: 'sheets 必填（至少一个工作表；或改用 artifactId 从工件渲染）' };

  const gate = await gateWrite(TOOL_KEYS.xlsx_create, args, absPath);
  if (gate.ok === false) return gate;

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'MJ Code';
    wb.created = new Date();
    let rowsTotal = 0;
    sheets.forEach((s, i) => {
      const ws = wb.addWorksheet(String(s.name || `Sheet${i + 1}`).slice(0, 31));
      const header = Array.isArray(s.header) ? s.header.map((h) => String(h ?? '')) : null;
      const rows = Array.isArray(s.rows) ? s.rows : [];
      if (header) {
        const hr = ws.addRow(header);
        hr.font = { bold: true };
        hr.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }; });
      }
      rows.forEach((r) => {
        const vals = Array.isArray(r) ? r : [r];
        const row = ws.addRow(vals.map((v) => (v && typeof v === 'object' && !(v instanceof Date) ? String(v.text ?? JSON.stringify(v)) : v)));
        if (typeof s.numFmt === 'string') row.eachCell((cell) => { if (typeof cell.value === 'number') cell.numFmt = s.numFmt; });
      });
      rowsTotal += rows.length;
      if (header) ws.views = [{ state: 'frozen', ySplit: 1 }];
      const widths = Array.isArray(s.widths) ? s.widths : null;
      if (widths) widths.forEach((w, ci) => { ws.getColumn(ci + 1).width = Number(w) || 12; });
      else if (s.autoWidth !== false) applyAutoWidth(ws, Math.max((header || []).length, ...rows.map((r) => (Array.isArray(r) ? r.length : 1)), 1));
    });
    const buf = await wb.xlsx.writeBuffer();
    return await writeArtifact(TOOL_KEYS.xlsx_create, args, absPath, Buffer.from(buf), gate.asked, { sheets: sheets.length, rows: rowsTotal });
  } catch (e) {
    audit(TOOL_KEYS.xlsx_create, absPath, `error: ${e.message}`, 'error');
    return { ok: false, error: `生成 Excel 表格失败：${e.message}` };
  }
}

// ═══ pptx_create（PPT .pptx）═══
// 内容模型：可选 title（生成封面页）+ slides[]（每页 title / bullets / body / notes）。
// 版式为 16:9；配色刻意走中性灰阶（与产品「性冷淡」视觉一致），不引入花哨主题。
const PPT_COLORS = { title: '1F2937', body: '374151', accent: '111827' };

async function toolPptxCreate(args = {}) {
  const PptxGenJS = loadLib('pptxgenjs');
  if (PptxGenJS.__loadError) return { ok: false, error: `pptxgenjs 库不可用：${PptxGenJS.__loadError}` };
  const Lib = PptxGenJS.default || PptxGenJS;
  const absPath = resolveOutPath(args.path, args.cwd, '.pptx');
  if (!absPath) return { ok: false, error: 'path 必填（输出 .pptx 的路径）' };
  let slides = Array.isArray(args.slides) ? args.slides.filter((s) => s && typeof s === 'object') : [];
  let title = args.title;
  let artMeta = null;
  // P0-2：传 artifactId 时由工件章节生成内容页（一页一章，页标题 = 章节标题），模型不再重复传全文
  // 歧义闸同 doc/xlsx：artifactId 与 slides 同时给 ⇒ 两个真源，报错而不是挑一个。
  if (String(args.artifactId || '').trim() && slides.length) {
    return {
      ok: false,
      code: 'ARTIFACT_SOURCE_CONFLICT',
      error: 'artifactId 与 slides 不能同时给：内容页只能有一个来源。要按工件渲染就删掉 slides，要手写页面就删掉 artifactId。',
    };
  }
  if (String(args.artifactId || '').trim()) {
    const src = artifactProduct.loadArtifactForProduct({
      artifactId: args.artifactId,
      version: args.version,
      product: artifactProduct.PRODUCTS.PPTX,
      store: deps?.getArtifactStore?.(),
    });
    if (src.ok !== true) return src;
    slides = artifactProduct.sectionsToPptxSlides(src.sections);
    title = String(args.title || src.title || '');
    artMeta = { artifactId: src.artifactId, version: src.version };
  }
  if (!slides.length && !title) return { ok: false, error: '请提供 title 或 slides（至少一页）' };

  const gate = await gateWrite(TOOL_KEYS.pptx_create, args, absPath);
  if (gate.ok === false) return gate;

  try {
    const pptx = new Lib();
    pptx.layout = 'LAYOUT_16x9';
    if (args.author) pptx.author = String(args.author);
    pptx.subject = String(title || '');
    if (title) {
      const s = pptx.addSlide();
      s.addText(String(title), { x: 0.6, y: 2.1, w: 8.8, h: 1.2, fontSize: 36, bold: true, color: PPT_COLORS.accent, align: 'left' });
      if (args.subtitle) s.addText(String(args.subtitle), { x: 0.6, y: 3.3, w: 8.8, h: 0.7, fontSize: 18, color: PPT_COLORS.body });
    }
    for (const raw of slides) {
      const s = pptx.addSlide();
      if (raw.title) s.addText(String(raw.title), { x: 0.6, y: 0.5, w: 8.8, h: 0.9, fontSize: 28, bold: true, color: PPT_COLORS.title });
      const bodyLines = [];
      if (raw.body) bodyLines.push({ text: String(raw.body), options: { breakLine: true } });
      for (const b of Array.isArray(raw.bullets) ? raw.bullets : []) {
        bodyLines.push({ text: String(b ?? ''), options: { bullet: true, breakLine: true } });
      }
      if (bodyLines.length) s.addText(bodyLines, { x: 0.6, y: 1.5, w: 8.8, h: 3.9, fontSize: 16, color: PPT_COLORS.body, valign: 'top' });
      if (raw.notes) s.addNotes(String(raw.notes));
    }
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await pptx.writeFile({ fileName: absPath });
    const bytes = (await fsp.stat(absPath)).size;
    audit(TOOL_KEYS.pptx_create, summarize(TOOL_KEYS.pptx_create, args), `ok ${bytes}B`, gate.asked ? 'approved' : 'recorded');
    return { ok: true, path: absPath, bytes, pages: slides.length + (title ? 1 : 0), ...(artMeta || {}) };
  } catch (e) {
    audit(TOOL_KEYS.pptx_create, absPath, `error: ${e.message}`, 'error');
    return { ok: false, error: `生成 PPT 失败：${e.message}` };
  }
}

// ═══ pdf_generate（HTML → PDF，Electron 自带 Chromium 渲染）═══
const HTML_TEMPLATE = (body) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width, initial-scale=1">`
  + `<style>
    /* 中性排版基线：报表/日报/预算类文档默认即可用；模型可在 html 里覆盖任意样式 */
    @page { margin: 0; }
    body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
           color: #1f2937; font-size: 12pt; line-height: 1.6; margin: 0; padding: 0; }
    h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 14pt; }
    table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
    th, td { border: 1px solid #d1d5db; padding: 6pt 8pt; text-align: left; font-size: 10.5pt; }
    th { background: #f3f4f6; }
    .page { padding: 18mm 16mm; }
    pre, code { font-family: Menlo, Consolas, monospace; font-size: 10pt; }
    pre { background: #f9fafb; border: 1px solid #e5e7eb; padding: 8pt; border-radius: 4px; white-space: pre-wrap; }
  </style></head><body><div class="page">${body}</div></body></html>`;

function htmlWithTimeout(win, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`PDF 渲染超时（超过 ${Math.round(PDF_RENDER_TIMEOUT_MS / 1000)}s）`));
    }, PDF_RENDER_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    win.webContents.printToPDF(options).then(
      (buf) => { if (!settled) { settled = true; clearTimeout(timer); resolve(buf); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
    );
  });
}

async function toolPdfGenerate(args = {}) {
  const absPath = resolveOutPath(args.path, args.cwd, '.pdf');
  if (!absPath) return { ok: false, error: 'path 必填（输出 .pdf 的路径）' };
  const html = String(args.html == null ? '' : args.html);
  if (!html.trim()) return { ok: false, error: 'html 必填（要渲染成 PDF 的 HTML 正文，可用片段或整页）' };
  if (!BrowserWindow) {
    return { ok: false, error: 'PDF 渲染能力不可用（当前宿主未提供 Electron BrowserWindow，无法用 Chromium 渲染）' };
  }

  const gate = await gateWrite(TOOL_KEYS.pdf_generate, args, absPath);
  if (gate.ok === false) return gate;

  // 渲染前先把 HTML 落到临时文件再 loadFile——data: URL 对长正文有长度上限，
  // 且临时文件让相对资源（本地图片等）可被解析，与模型「写整页 HTML」的习惯一致。
  const tmpFile = path.join(os.tmpdir(), `mjcode-pdf-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
  const full = /<html[\s>]/i.test(html) ? html : HTML_TEMPLATE(html);
  let win = null;
  try {
    await fsp.writeFile(tmpFile, full, 'utf8');
    win = new BrowserWindow({
      show: false,
      width: 1240,
      height: 1754,
      webPreferences: { javascript: args.allowScript === true, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    pdfWindows.add(win);
    await win.loadFile(tmpFile);
    const margins = args.margins && typeof args.margins === 'object' ? args.margins : { top: 0.59, bottom: 0.59, left: 0.63, right: 0.63 };
    const buf = await htmlWithTimeout(win, {
      printBackground: args.printBackground !== false,
      pageSize: String(args.pageSize || 'A4'),
      landscape: args.landscape === true,
      margins,
    });
    return await writeArtifact(TOOL_KEYS.pdf_generate, args, absPath, buf, gate.asked, { pageSize: String(args.pageSize || 'A4') });
  } catch (e) {
    audit(TOOL_KEYS.pdf_generate, absPath, `error: ${e.message}`, 'error');
    return { ok: false, error: `生成 PDF 失败：${e.message}` };
  } finally {
    if (win) {
      pdfWindows.delete(win);
      try { win.destroy(); } catch { /* 已销毁 */ }
    }
    try { await fsp.unlink(tmpFile); } catch { /* 临时文件已清理 */ }
  }
}

// 应用退出清理：销毁残留的隐藏渲染窗口
function disposeDocTools() {
  for (const win of pdfWindows) {
    try { win.destroy(); } catch { /* 已销毁 */ }
  }
  pdfWindows.clear();
}

module.exports = {
  initDocTools, disposeDocTools,
  toolDocCreate, toolXlsxCreate, toolPptxCreate, toolPdfGenerate,
  _pdfWindows: () => pdfWindows,
};
