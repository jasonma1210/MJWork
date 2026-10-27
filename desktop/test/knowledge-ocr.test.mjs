// OCR 门禁（2026-10-27，M3 补强：扫描件 / 图片入库）
//
// 本机实测的工具链事实（决定了实现方式，也决定了这里的断言形态）：
//   · `swift --version` = 5.10，SDK 由 Swift 6.0.3 构建 ⇒ `swift c` 直接报 SDK 不受支持，
//     Apple Vision 方案在本机跑不起来 —— 所以选 tesseract（独立可执行、带 chi_sim/eng）；
//   · 本机没有 gs / pdftoppm / mutool，`sips` 只能光栅化第一页 ⇒ 「PDF→整页图→OCR」走不通，
//     改为**从 PDF 里抽内嵌页面图像**（扫描件通常每页就是一张 JPEG/Flate 位图）。
//
// 断言纪律：
//   · OCR 依赖外部引擎，没装的机器上不允许「静默通过」——统一打印 ⏭ 跳过 并计入 skipped；
//   · 但**凡是与引擎无关的分支**（图像抽取、PNG 编码、文本归一、空图判定）必须无条件跑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { OCR_SAMPLE_PNG_BASE64 } from './fixtures/ocrSample.mjs';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const kb = require(path.join(DESKTOP, 'main/knowledgeBaseQuery.js'));
const ocr = require(path.join(DESKTOP, 'main/ocrEngine.js'));
const { extractImages, encodePng } = require(path.join(DESKTOP, 'main/kbPdfImages.js'));
const { openSqliteJsDb } = require(path.join(DESKTOP, 'main/db/sqljsDb.js'));

let pass = 0;
let fail = 0;
let skipped = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.error(`❌ ${name} — ${e.message}`); }
};
const skip = (name, why) => { skipped += 1; console.log(`⏭ ${name} —— ${why}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ocr-'));
const samplePng = Buffer.from(OCR_SAMPLE_PNG_BASE64, 'base64');
fs.writeFileSync(path.join(TMP, 'sample.png'), samplePng);

const eng = ocr.detect();

// ── 与引擎无关的分支（任何机器都必须跑） ──
await check('① 探测结果是结构化的（可用性 / 引擎 / 语种 都有明确取值）', () => {
  assert.equal(typeof eng.available, 'boolean');
  if (eng.available) {
    assert.equal(eng.engine, 'tesseract');
    assert.ok(Array.isArray(eng.languages) && eng.languages.length > 0, '缺少本次可用语种');
  } else {
    assert.ok(eng.reason, '不可用时必须给出原因（否则界面无法告诉用户该装什么）');
  }
});

await check('② OCR 文本归一：丢掉纯符号行与多余空行，保留内容行', () => {
  const raw = '  ACCEPTANCE  2026  \n\n\n|__|\nRAG knowledge base\n~\n';
  const out = ocr.normalizeOcrText(raw);
  assert.match(out, /ACCEPTANCE  2026/);
  assert.match(out, /RAG knowledge base/);
  assert.doesNotMatch(out, /\|__\|/, '纯符号行未被清掉');
  assert.ok(!/\n{3,}/.test(out), '多余空行未被压缩');
});

await check('③ PNG 编码器自洽：写出的图能被自己的解析路径读回（宽高与像素数一致）', () => {
  const w = 8; const h = 4; const channels = 3;
  const pixels = Buffer.alloc(w * h * channels, 200);
  const png = encodePng({ width: w, height: h, channels, pixels });
  assert.equal(png.readUInt32BE(0), 0x89504e47, 'PNG 魔数不对');
  assert.equal(png.readUInt32BE(16), w, 'IHDR 宽度不对');
  assert.equal(png.readUInt32BE(20), h, 'IHDR 高度不对');
});

await check('④ PDF 图像抽取：Flate 位图被转成可用 PNG；小图被跳过（不当正文 OCR）', () => {
  const w = 40; const h = 30;
  const rawPixels = Buffer.alloc(w * h * 3, 255);
  const flate = zlib.deflateSync(rawPixels);
  const big = { width: 300, height: 200 };
  const bigPixels = Buffer.alloc(big.width * big.height * 3, 255);
  const bigFlate = zlib.deflateSync(bigPixels);
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from(`1 0 obj << /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >> stream\n`, 'latin1'),
    flate,
    Buffer.from('\nendstream endobj\n', 'latin1'),
    Buffer.from(`2 0 obj << /Type /XObject /Subtype /Image /Width ${big.width} /Height ${big.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${bigFlate.length} >> stream\n`, 'latin1'),
    bigFlate,
    Buffer.from('\nendstream endobj\n', 'latin1'),
    Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
  const ex = extractImages(pdf);
  assert.equal(ex.images.length, 1, `应只抽到 1 张「够大」的图，实际 ${ex.images.length}`);
  assert.equal(ex.images[0].ext, '.png');
  assert.equal(ex.images[0].width, big.width);
  assert.ok(ex.skipped.some((s) => s.reason === 'too_small'), '小图没有被跳过');
});

await check('⑤ PDF 图像抽取：DCTDecode（JPEG）原样取出，不解码不猜', () => {
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from(`1 0 obj << /Type /XObject /Subtype /Image /Width 400 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${fakeJpeg.length} >> stream\n`, 'latin1'),
    fakeJpeg,
    Buffer.from('\nendstream endobj\n', 'latin1'),
  ]);
  const ex = extractImages(pdf);
  assert.equal(ex.images.length, 1);
  assert.equal(ex.images[0].ext, '.jpg');
  assert.deepEqual(ex.images[0].buf, fakeJpeg, 'JPEG 字节被改写了（应当原样落盘）');
});

// ── 依赖引擎的分支 ──
if (!eng.available) {
  skip('⑥ 图片 OCR 端到端', `本机无 OCR 引擎：${eng.reason}`);
  skip('⑦ 扫描版 PDF OCR 端到端', `本机无 OCR 引擎：${eng.reason}`);
  skip('⑧ 空白图 → 明确失败', `本机无 OCR 引擎：${eng.reason}`);
} else {
  await check('⑥ 图片 OCR：识别出拉丁文本（数字与字母都要在）', async () => {
    const r = await ocr.ocrImage(path.join(TMP, 'sample.png'));
    assert.equal(r.ok, true, r.reason);
    const text = String(r.text).toUpperCase();
    assert.match(text, /ACCEPTANCE/, `识别结果缺少 ACCEPTANCE：${r.text}`);
    assert.match(text, /2026/, `识别结果缺少 2026：${r.text}`);
    assert.ok(r.ms > 0 && r.ms < 30000, `耗时异常：${r.ms}ms`);
  });

  await check('⑦ 扫描版 PDF 端到端：抽页面图 → OCR → 入库 → 可检索', async () => {
    // 用测试图构造「没有文本层、只有一整页 Flate 位图」的 PDF（正是扫描件的形态）
    const { width, height } = pngSize(samplePng);
    // 夹具图只有 150px 高，低于「视为页面图」的最小边阈值（160）——这是产品侧的规则（防图标当正文）。
    // 所以测试里纵向拼两份凑成页面尺寸：既尊重产品规则，也不用为测试放宽阈值。
    const rgbOne = pngToRgb(samplePng, width, height);
    const rgb = Buffer.concat([rgbOne, rgbOne]);
    const stackedHeight = height * 2;
    const flate = zlib.deflateSync(rgb);
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.from('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n', 'latin1'),
      Buffer.from('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n', 'latin1'),
      Buffer.from('3 0 obj << /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >> endobj\n', 'latin1'),
      Buffer.from(`4 0 obj << /Type /XObject /Subtype /Image /Width ${width} /Height ${stackedHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >> stream\n`, 'latin1'),
      flate,
      Buffer.from('\nendstream endobj\n', 'latin1'),
      // 内容流只画图、不含任何文字算子 —— 与真实扫描件一致
      Buffer.from('5 0 obj << /Length 33 >> stream\nq 600 0 0 150 0 0 cm /Im1 Do Q\nendstream endobj\n', 'latin1'),
      Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]);
    const pdfPath = path.join(TMP, 'scanned.pdf');
    fs.writeFileSync(pdfPath, pdf);

    const db = await openSqliteJsDb(path.join(TMP, 'ocr.sqlite'));
    db.exec(kb.KB_SCHEMA);
    const stages = [];
    const r = await kb.importDocument({
      db, storageDir: path.join(TMP, 'store'), projectId: 'P', filePath: pdfPath, actorId: 'owner',
      onStage: (s) => stages.push(s),
    });
    assert.equal(r.ok, true, r.reason || r.code);
    assert.ok(stages.includes('ocr'), `未经过 ocr 阶段：${stages.join('→')}`);
    const s = kb.search({ db, projectId: 'P', query: 'acceptance' });
    assert.ok(s.items.length > 0, 'OCR 文本没有被检索到');
  });

  await check('⑦b 多页扫描件：逐页 OCR 且保留页码标记', async () => {
    const { width, height } = pngSize(samplePng);
    const rgbOne = pngToRgb(samplePng, width, height);
    const rgb = Buffer.concat([rgbOne, rgbOne]);
    const H = height * 2;
    const flate = zlib.deflateSync(rgb);
    const pages = [1, 2];
    const objs = [
      Buffer.from('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n', 'latin1'),
      Buffer.from('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n', 'latin1'),
      Buffer.from('3 0 obj << /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R /Im2 5 0 R >> >> /Contents 6 0 R >> endobj\n', 'latin1'),
    ];
    pages.forEach((n) => {
      objs.push(Buffer.from(`${3 + n} 0 obj << /Type /XObject /Subtype /Image /Width ${width} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >> stream\n`, 'latin1'));
      objs.push(flate);
      objs.push(Buffer.from('\nendstream endobj\n', 'latin1'));
    });
    objs.push(Buffer.from('6 0 obj << /Length 44 >> stream\nq 300 0 0 150 0 0 cm /Im1 Do Q q 300 0 0 150 300 0 cm /Im2 Do Q\nendstream endobj\n', 'latin1'));
    objs.push(Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'));
    const pdfPath = path.join(TMP, 'multi.pdf');
    fs.writeFileSync(pdfPath, Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), ...objs]));

    const db = await openSqliteJsDb(path.join(TMP, 'multi.sqlite'));
    db.exec(kb.KB_SCHEMA);
    const r = await kb.importDocument({
      db, storageDir: path.join(TMP, 'store3'), projectId: 'P', filePath: pdfPath, actorId: 'owner',
    });
    assert.equal(r.ok, true, r.reason || r.code);
    const text = db.prepare('SELECT text FROM knowledge_chunks ORDER BY ordinal LIMIT 1').get().text;
    assert.match(text, /第 1 页/, '缺少第 1 页标记');
    assert.match(text, /第 2 页/, '缺少第 2 页标记');
  });

  await check('⑧ 空白图 → EMPTY_CONTENT（明确失败，不假装已索引）', async () => {
    const blank = encodePng({ width: 320, height: 200, channels: 3, pixels: Buffer.alloc(320 * 200 * 3, 255) });
    const p = path.join(TMP, 'blank.png');
    fs.writeFileSync(p, blank);
    const db = await openSqliteJsDb(path.join(TMP, 'blank.sqlite'));
    db.exec(kb.KB_SCHEMA);
    const r = await kb.importDocument({
      db, storageDir: path.join(TMP, 'store2'), projectId: 'P', filePath: p, actorId: 'owner',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EMPTY_CONTENT');
    const n = db.prepare('SELECT COUNT(*) AS n FROM knowledge_sources').get().n;
    assert.equal(n, 0, '空白图不该产生 source 行');
  });
}

// ── 能力声明必须与真实探测一致（这条永远跑，防「声明支持但导入必失败」） ──
await check('⑨ capabilities 如实反映 OCR 可用性与图片格式支持', () => {
  const caps = kb.capabilities();
  assert.equal(caps.ocr.available, eng.available);
  const hasImages = caps.supportedExtensions.some((e) => ['.png', '.jpg', '.jpeg'].includes(e));
  assert.equal(hasImages, eng.available, '图片格式的支持声明与 OCR 可用性不一致');
  assert.ok(caps.maxFileBytes >= 15 * 1024 * 1024, `文件上限应放宽到 15MB 以上，实际 ${caps.maxFileBytes}`);
  assert.ok(caps.maxTextChars > 0 && caps.maxIndexPostings > 0, '缺少正文/倒排预算声明');
  assert.equal(caps.partialIndexSupported, true);
});

/** 从 PNG 读宽高（IHDR 数据起始固定偏移 16/20） */
function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
/**
 * PNG 解码（8bit、非隔行、RGB/RGBA）—— 只用于测试里「把夹具图变成 PDF 内嵌位图」。
 * 必须实现全部 5 种行过滤器：夹具图来自 ImageMagick（会写 Paeth/Sub 等），
 * 不是我们自己编码器的「filter 0」形态；初版只处理 filter 0，直接把缓冲区读越界。
 */
function pngToRgb(png, width, height) {
  const colorType = png[25]; // 0=gray 2=RGB 3=palette 6=RGBA
  const srcChannels = colorType === 0 ? 1 : colorType === 6 ? 4 : 3;
  if (colorType !== 0 && colorType !== 2 && colorType !== 6) {
    throw new Error(`夹具 PNG 的颜色类型 ${colorType} 不在本测试解码器支持范围（0/2/6）`);
  }
  let off = 8;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = srcChannels;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const x = src[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else v = x + paeth(a, b, c);
      cur[i] = v & 0xff;
    }
  }
  // 统一展开成 8bit RGB：灰度复制三通道，RGBA 丢 alpha（PDF 的 DeviceRGB 位图必须是 3 通道）
  if (srcChannels === 3) return out;
  const rgb = Buffer.alloc(width * height * 3);
  if (srcChannels === 1) {
    for (let i = 0, j = 0; i < out.length; i += 1, j += 3) { rgb[j] = out[i]; rgb[j + 1] = out[i]; rgb[j + 2] = out[i]; }
    return rgb;
  }
  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    rgb[j] = out[i]; rgb[j + 1] = out[i + 1]; rgb[j + 2] = out[i + 2];
  }
  return rgb;
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\nknowledge-ocr: ${pass} 通过 / ${fail} 失败 / ${skipped} 跳过（跳过 = 本机无 OCR 引擎，不代表已验证）`);
if (fail > 0) process.exitCode = 1;
