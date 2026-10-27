// DOCX 文本解析（M3 §8.2 的「可解析的 DOCX」）
//
// 为什么自己解 zip 而不引库：仓库 `package.json` 里没有 zip 相关依赖（`jszip`/`unzipper` 只作为
// 其他包的传递依赖存在），直接 require 传递依赖在打包/升级时会静默消失。DOCX 的包结构是
// **固定**的（ZIP + OOXML），用 Node 内置 zlib 读「中央目录 → 局部头 → inflateRaw」足够，
// 且整段逻辑可读、可测、零供应链面。
//
// 诚实边界（写进 capabilities，不假装全能）：
//   · 只取正文 `word/document.xml`（不含页眉页脚/脚注/批注——它们在 `word/header*.xml` 等；
//     需要时按需扩展，而不是把它们混进正文顺序里假装完整）；
//   · 不解析样式（字号/颜色/加粗对检索无意义），只保留段落边界与制表/换行；
//   · 加密的 DOCX（CFB 容器，`D0 CF 11 E0` 魔数）直接报 ENCRYPTED，不尝试破解。
'use strict';

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * 读 ZIP 中央目录并解出指定条目。
 * @returns {Map<string, Buffer>} 文件名 → 解压后内容（只解 deflate/store，其余跳过）
 */
function readZipEntries(buf) {
  // EOCD 从尾部往前找（末尾最多 64KB 注释）
  const maxScan = Math.min(buf.length, 0xffff + 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return new Map();
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(localOff) !== LOC_SIG) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      if (method === 0) out.set(name, Buffer.from(raw));
      else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
      // 其它压缩方法（bzip2/lzma）少见：跳过，由调用方按「解析不到文本」处理
    } catch {
      // 单条目解压失败不整体失败：可能是资源文件（图片）而非正文
    }
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] !== undefined ? ENTITIES[body] : whole;
  });
}

/**
 * OOXML 正文 → 纯文本。
 * 段落边界保留为换行（检索与分块需要段落感，否则整篇糊成一行，bigram 会跨段乱配）。
 */
function documentXmlToText(xml) {
  return decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {Buffer} buf
 * @returns {{ok: boolean, text?: string, code?: string, reason?: string}}
 */
function parseDocx(buf) {
  // 加密的 OOXML 会被包成 CFB（Compound File Binary）：魔数 D0CF11E0 —— 明确报加密，不猜内容
  if (buf.length > 8 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    return { ok: false, code: 'ENCRYPTED', reason: '该 DOCX 已加密（CFB 容器），请先解除密码保护' };
  }
  const entries = readZipEntries(buf);
  if (entries.size === 0) {
    return { ok: false, code: 'PARSE_FAILED', reason: '不是有效的 DOCX（ZIP 目录读取失败）' };
  }
  const main = entries.get('word/document.xml');
  if (!main) {
    return { ok: false, code: 'PARSE_FAILED', reason: 'DOCX 缺少 word/document.xml（可能不是 Word 文档）' };
  }
  const text = documentXmlToText(main.toString('utf8'));
  if (!text) return { ok: false, code: 'EMPTY_CONTENT', reason: 'DOCX 正文为空（可能只有图片或图表）' };
  return { ok: true, text };
}

module.exports = { parseDocx, readZipEntries, documentXmlToText };
