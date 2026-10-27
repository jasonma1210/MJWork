// PDF/DOCX 解析 + 导入阶段/取消门禁（M3 §8.2 / §8.4，2026-10-27）
//
// 为什么自己造夹具而不是放二进制样本：仓库不留二进制测试资产（历史约定），
// 而 DOCX/PDF 的结构都是**自描述**的（ZIP + OOXML / PDF 对象流），
// 用手写夹具反而能把「哪种形态必须成功、哪种必须明确失败」逐条钉住。
//
// ⚠ 诚实边界：这些夹具证明的是「解析器的判定分支正确」，**不等于**在真实语料上都对。
// 真实 PDF 的版面/字体矩阵远比夹具复杂；本实现把不确定的情形统一导向明确错误码
// （ENCRYPTED / EMPTY_CONTENT / UNSUPPORTED_ENCODING / PARSE_FAILED），
// 而不是产出乱码后宣称「已索引」——后者会让检索永久失真且无人察觉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(import.meta.dirname, '..');
const kb = require(path.join(DESKTOP, 'main/knowledgeBaseQuery.js'));
const { parseDocx } = require(path.join(DESKTOP, 'main/kbDocx.js'));
const { parsePdf } = require(path.join(DESKTOP, 'main/kbPdf.js'));
const { openSqliteJsDb } = require(path.join(DESKTOP, 'main/db/sqljsDb.js'));

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.error(`❌ ${name} — ${e.message}`); }
};

// ── 最小 ZIP 写入器（store / deflate 两种，用来造 DOCX 夹具）──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const method = e.method === 8 ? 8 : 0;
    const data = method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const documentXml = (paragraphs) => `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('\n')}
</w:body></w:document>`;

// ── DOCX ──
await check('DOCX（store）→ 正文按段落抽取', () => {
  const buf = makeZip([{ name: 'word/document.xml', data: Buffer.from(documentXml(['第一段：验收标准', '第二段：交付口径']), 'utf8') }]);
  const r = parseDocx(buf);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /第一段：验收标准/);
  assert.match(r.text, /第二段：交付口径/);
  assert.match(r.text, /\n/, '段落边界丢失（整篇糊成一行会让 bigram 跨段乱配）');
});

await check('DOCX（deflate）→ 正文同样抽出（走 inflateRaw 分支）', () => {
  const buf = makeZip([{ name: 'word/document.xml', data: Buffer.from(documentXml(['压缩段落里的中文内容']), 'utf8'), method: 8 }]);
  const r = parseDocx(buf);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /压缩段落里的中文内容/);
});

await check('DOCX 实体解码与制表/换行', () => {
  const xml = '<w:body><w:p><w:r><w:t>a&amp;b</w:t><w:tab/><w:t>c</w:t><w:br/><w:t>d</w:t></w:r></w:p></w:body>';
  const buf = makeZip([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf8') }]);
  const r = parseDocx(buf);
  assert.equal(r.ok, true);
  assert.match(r.text, /a&b/);
  assert.match(r.text, /\t/, '制表符丢失');
  assert.match(r.text, /c\nd/, '换行未保留');
});

await check('加密 DOCX（CFB 魔数）→ ENCRYPTED，不猜内容', () => {
  const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
  const r = parseDocx(cfb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENCRYPTED');
});

await check('缺 word/document.xml → PARSE_FAILED（不是「空文档」）', () => {
  const buf = makeZip([{ name: 'docProps/core.xml', data: Buffer.from('<x/>') }]);
  const r = parseDocx(buf);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PARSE_FAILED');
});

// ── PDF ──
function makePdf({ content, toUnicode = null, compress = false, encrypt = false, composite = false }) {
  const enc = Buffer.from(content, 'latin1');
  const body = compress ? zlib.deflateSync(enc) : enc;
  const filter = compress ? ' /Filter /FlateDecode' : '';
  const font = toUnicode
    ? `<< /Type /Font /Subtype /${composite ? 'Type0' : 'Type1'} ${composite ? '/Encoding /Identity-H ' : ''}/BaseFont /F1 /ToUnicode 6 0 R >>`
    : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const objs = [];
  objs.push(Buffer.from('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n', 'latin1'));
  objs.push(Buffer.from('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n', 'latin1'));
  objs.push(Buffer.from(`3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n`, 'latin1'));
  objs.push(Buffer.from(`4 0 obj ${font} endobj\n`, 'latin1'));
  objs.push(Buffer.concat([
    Buffer.from(`5 0 obj << /Length ${body.length}${filter} >> stream\n`, 'latin1'),
    body, Buffer.from('\nendstream endobj\n', 'latin1'),
  ]));
  if (toUnicode) {
    const cmap = Buffer.from(toUnicode, 'latin1');
    objs.push(Buffer.concat([
      Buffer.from(`6 0 obj << /Length ${cmap.length} >> stream\n`, 'latin1'),
      cmap, Buffer.from('\nendstream endobj\n', 'latin1'),
    ]));
  }
  const trailer = `trailer << /Root 1 0 R ${encrypt ? '/Encrypt 9 0 R ' : ''}>>\n%%EOF\n`;
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'), ...objs, Buffer.from(trailer, 'latin1'),
  ]);
}

await check('PDF（未压缩、ASCII）→ 抽取 Tj 文本', () => {
  const buf = makePdf({ content: 'BT /F1 12 Tf 72 720 Td (Hello PDF world) Tj ET' });
  const r = parsePdf(buf);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /Hello PDF world/);
});

await check('PDF（FlateDecode）→ 解压后抽取', () => {
  const buf = makePdf({ content: 'BT /F1 12 Tf 72 720 Td (Compressed stream text) Tj ET', compress: true });
  const r = parsePdf(buf);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /Compressed stream text/);
});

await check('PDF（TJ 数组 + 括号嵌套）→ 文本拼接正确', () => {
  // PDF 字面量字符串里的 `\(` `\)` 是**转义括号**（不是 JS 转义）：PDF 侧要看到反斜杠，
  // 所以 JS 源码里必须写 `\\(`。这样才真的测到 unescapePdfString 的转义分支。
  const buf = makePdf({ content: 'BT /F1 12 Tf 72 720 Td [(A) -120 (B \\(nested\\)) ] TJ ET' });
  const r = parsePdf(buf);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /AB/);
  assert.match(r.text, /nested/);
});

await check('PDF（复合字体 + ToUnicode）→ 按 CMap 映射为中文', () => {
  const cmap = `begincmap
1 beginbfchar
<0048> <4E2D>
endbfchar
1 beginbfchar
<0069> <6587>
endbfchar
endcmap`;
  const buf = makePdf({ content: 'BT /F1 12 Tf 72 720 Td <00480069> Tj ET', toUnicode: cmap, composite: true });
  const r = parsePdf(buf);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /中文/);
});

await check('加密 PDF（/Encrypt）→ ENCRYPTED', () => {
  const buf = makePdf({ content: 'BT /F1 12 Tf (x) Tj ET', encrypt: true });
  const r = parsePdf(buf);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENCRYPTED');
});

await check('无文本层 PDF（扫描件）→ EMPTY_CONTENT（明确失败，不假装已索引）', () => {
  const buf = makePdf({ content: 'q 72 0 0 72 0 0 cm /Im1 Do Q' });
  const r = parsePdf(buf);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EMPTY_CONTENT');
});

await check('高位字节但无 ToUnicode → UNSUPPORTED_ENCODING（拒绝产出乱码）', () => {
  const content = `BT /F1 12 Tf 72 720 Td (caf${String.fromCharCode(0xe9)}) Tj ET`;
  const buf = makePdf({ content });
  const r = parsePdf(buf);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNSUPPORTED_ENCODING');
});

await check('非 PDF 文件 → PARSE_FAILED', () => {
  const r = parsePdf(Buffer.from('not a pdf at all'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PARSE_FAILED');
});

// ── 端到端：经 importDocument 落库并可检索 ──
(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-parse-'));
  const db = await openSqliteJsDb(path.join(TMP, 'p.sqlite'));
  db.exec(kb.KB_SCHEMA);
  const storageDir = path.join(TMP, 'store');

  const docxPath = path.join(TMP, 'spec.docx');
  fs.writeFileSync(docxPath, makeZip([{
    name: 'word/document.xml',
    data: Buffer.from(documentXml(['DOCX 里的验收口径：中文检索必须命中']), 'utf8'),
    method: 8,
  }]));
  const rDocx = await kb.importDocument({ db, storageDir, projectId: 'P', filePath: docxPath, actorId: 'owner' });
  await check('端到端：DOCX 可导入并可被中文检索命中', () => {
    assert.equal(rDocx.ok, true, rDocx.reason || rDocx.code);
    assert.ok(rDocx.chunks > 0);
    const s = kb.search({ db, projectId: 'P', query: '验收口径' });
    assert.ok(s.items.length > 0, 'DOCX 导入后检索无命中');
  });

  const pdfPath = path.join(TMP, 'spec.pdf');
  fs.writeFileSync(pdfPath, makePdf({ content: 'BT /F1 12 Tf 72 720 Td (PDF acceptance criteria text) Tj ET', compress: true }));
  const rPdf = await kb.importDocument({ db, storageDir, projectId: 'P', filePath: pdfPath, actorId: 'owner' });
  await check('端到端：PDF 可导入并可被英文词元检索命中', () => {
    assert.equal(rPdf.ok, true, rPdf.reason || rPdf.code);
    const s = kb.search({ db, projectId: 'P', query: 'acceptance' });
    assert.ok(s.items.length > 0, 'PDF 导入后检索无命中');
  });

  await check('端到端：加密 PDF 不落库（source 数不增加）', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM knowledge_sources').get().n;
    const encPath = path.join(TMP, 'enc.pdf');
    fs.writeFileSync(encPath, makePdf({ content: 'BT (x) Tj ET', encrypt: true }));
    const r = await kb.importDocument({ db, storageDir, projectId: 'P', filePath: encPath, actorId: 'owner' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ENCRYPTED');
    const after = db.prepare('SELECT COUNT(*) AS n FROM knowledge_sources').get().n;
    assert.equal(after, before, '解析失败的文件被写进了 knowledge_sources（会把失败伪装成已索引）');
  });

  // ── 阶段顺序 + 取消（§8.4）──
  const bigPath = path.join(TMP, 'big.txt');
  fs.writeFileSync(bigPath, '这是一段用于验证分阶段与取消的正文。'.repeat(3000), 'utf8'); // ~60k 字符 → 约 60 分块
  const stages = [];
  const rStages = await kb.importDocument({
    db, storageDir, projectId: 'P', filePath: bigPath, actorId: 'owner',
    onStage: (s) => stages.push(s),
  });
  await check('导入阶段顺序 = parsing → chunking → indexing → ready', () => {
    assert.equal(rStages.ok, true, rStages.code);
    assert.deepEqual(stages, ['parsing', 'chunking', 'indexing', 'ready'], `实际：${stages.join(' → ')}`);
  });

  let cancelled = false;
  // 用「导入前后的全库快照差」判定残留，而不是比较倒排表与 chunk 的总数：
  // 一个 chunk 会产生多条 postings（每个词元一条），两者天然不相等 —— 那个比较是错的判据。
  const snap = () => ({
    sources: db.prepare('SELECT COUNT(*) AS n FROM knowledge_sources').get().n,
    chunks: db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get().n,
    postings: db.prepare('SELECT COUNT(*) AS n FROM knowledge_index_postings').get().n,
    terms: db.prepare('SELECT COUNT(*) AS n FROM knowledge_index_terms').get().n,
  });
  const beforeCancel = snap();
  const rCancel = await kb.importDocument({
    db, storageDir, projectId: 'P', filePath: bigPath, actorId: 'owner', yieldEvery: 1,
    onStage: (s) => { if (s === 'indexing') cancelled = false; },
    // 第 2 次检查时取消（即前 2 个分块已写入后再取消）——真正的「中途取消」形态
    shouldCancel: (() => { let n = 0; return () => { n += 1; return n >= 2; }; })(),
  });
  await check('取消返回 CANCELED 且清理未提交资产（全库快照回到导入前，原文件保留）', () => {
    assert.equal(rCancel.ok, false);
    assert.equal(rCancel.code, 'CANCELED');
    const after = snap();
    assert.deepEqual(after, beforeCancel, `取消后仍有残留：${JSON.stringify(after)} vs ${JSON.stringify(beforeCancel)}`);
    assert.ok(fs.existsSync(bigPath), '取消竟然删除了用户原始文件');
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log(`\nknowledge-parsers: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => { console.error(`知识解析门禁异常：${e && e.message}`); process.exitCode = 1; });