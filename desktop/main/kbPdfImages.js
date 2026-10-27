// PDF 内嵌图像抽取（2026-10-27，配合 OCR：把「扫描版 PDF」变成可检索文本）
//
// 为什么需要它：本机没有 gs / pdftoppm / mutool，`sips` 只能光栅化第一页 ——
// 也就是说「把 PDF 每页渲染成图再 OCR」这条路在这台机器上走不通。
// 但扫描件的页面通常就是**每页一张大图**（DCTDecode 的 JPEG，或 FlateDecode 的原始像素），
// 直接从 PDF 对象里把这些图像流取出来送 OCR，既不需要渲染器，也能逐页覆盖。
//
// 支持与边界（都是显式的）：
//   ✔ /DCTDecode（JPEG）：原样落盘（字节就是完整 JPEG）
//   ✔ /FlateDecode + 8bit + DeviceRGB/DeviceGray：inflate 后编码成 PNG
//   ✔ /ASCII85Decode + /FlateDecode（部分生成器会叠两层）
//   ✘ /JPXDecode（JPEG2000）、/CCITTFaxDecode（多数传真/扫描 TIFF-G4）：不猜解码，跳过并在统计里报 skipped
//   小图（任一边 < 160px）视为图标/装饰，不送 OCR（送了只会把 logo 上的字母当正文）。
'use strict';

const zlib = require('zlib');

const MIN_SIDE = 160;
const MAX_IMAGES = 60;

// ── PNG 编码（只做 OCR 输入用；无压缩优化需求）──
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
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** @param {{width:number,height:number,channels:1|3,pixels:Buffer}} img */
function encodePng({ width, height, channels, pixels }) {
  const colorType = channels === 1 ? 0 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ascii85Decode(input) {
  const s = String(input).replace(/\s+/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    group.push(code);
    if (group.length === 5) {
      let v = 0;
      for (const c of group) v = v * 85 + c;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group = [];
    }
  }
  if (group.length) {
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const c of group) v = v * 85 + c;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, group.length - 1));
  }
  return Buffer.from(out);
}

/**
 * 抽出 PDF 里的候选页面图像。
 * @returns {{ok: boolean, images: Array<{buf: Buffer, ext: string, width: number, height: number, page: number|null}>, skipped: Array<{reason: string, width?: number, height?: number}>}}
 */
function extractImages(buf) {
  const s = buf.toString('latin1');
  const images = [];
  const skipped = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  let order = 0;
  while ((m = re.exec(s)) !== null) {
    const start = m.index;
    const endObj = s.indexOf('endobj', start);
    const segEnd = endObj < 0 ? s.length : endObj;
    const seg = s.slice(start, segEnd);
    if (!/\/Subtype\s*\/Image\b/.test(seg)) continue;
    order += 1;
    const dictEnd = seg.indexOf('stream');
    const dict = dictEnd >= 0 ? seg.slice(0, dictEnd) : seg;
    const num = (key, def) => {
      const r = dict.match(new RegExp(`/${key}\\s+(\\d+)`));
      return r ? Number(r[1]) : def;
    };
    const width = num('Width', 0);
    const height = num('Height', 0);
    const filters = [...dict.matchAll(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/g)]
      .flatMap((f) => [...f[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]));
    const bits = num('BitsPerComponent', 8);
    const colorSpace = (dict.match(/\/ColorSpace\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/) || [])[1] || '';

    if (width < MIN_SIDE || height < MIN_SIDE) { skipped.push({ reason: 'too_small', width, height }); continue; }
    if (images.length >= MAX_IMAGES) { skipped.push({ reason: 'too_many', width, height }); continue; }
    if (dictEnd < 0) { skipped.push({ reason: 'no_stream', width, height }); continue; }
    let dataStart = start + dictEnd + 6;
    if (s[dataStart] === '\r') dataStart += 1;
    if (s[dataStart] === '\n') dataStart += 1;
    const endStream = s.indexOf('endstream', dataStart);
    // 去掉 stream 与 endstream 之间的行尾（PDF 规范允许 CRLF/LF，但字节本身不属于图像数据：
    // JPEG 少了这两个字节还能读，多了就会在尾部带上垃圾，DCTDecode 的字节比对也会失败）
    let dataEnd = endStream < 0 ? segEnd : endStream;
    while (dataEnd > dataStart && (buf[dataEnd - 1] === 0x0a || buf[dataEnd - 1] === 0x0d)) dataEnd -= 1;
    const raw = buf.subarray(dataStart, dataEnd);

    // JPEG：字节本身就是完整图片，直接落盘
    if (filters.includes('DCTDecode')) {
      images.push({ buf: Buffer.from(raw), ext: '.jpg', width, height, page: order });
      continue;
    }
    if (filters.includes('JPXDecode') || filters.includes('CCITTFaxDecode')) {
      skipped.push({ reason: filters.includes('JPXDecode') ? 'jpx_unsupported' : 'ccitt_unsupported', width, height });
      continue;
    }
    // Flate / ASCII85 + Flate → 原始像素：编码成 PNG
    if (filters.includes('FlateDecode') || filters.includes('ASCII85Decode')) {
      try {
        let payload = raw;
        if (filters[0] === 'ASCII85Decode') payload = ascii85Decode(payload.toString('latin1'));
        const inflated = filters.includes('FlateDecode') ? zlib.inflateSync(payload) : payload;
        const channels = /DeviceGray|CalGray/.test(colorSpace) ? 1 : 3;
        if (bits !== 8) { skipped.push({ reason: 'bits_unsupported', width, height }); continue; }
        if (inflated.length < width * height * channels) {
          skipped.push({ reason: 'short_data', width, height });
          continue;
        }
        const png = encodePng({ width, height, channels, pixels: inflated.subarray(0, width * height * channels) });
        images.push({ buf: png, ext: '.png', width, height, page: order });
      } catch {
        skipped.push({ reason: 'inflate_failed', width, height });
      }
      continue;
    }
    skipped.push({ reason: `filter_unsupported:${filters.join('+') || 'none'}`, width, height });
  }
  return { ok: true, images, skipped, candidates: order };
}

module.exports = { extractImages, encodePng, ascii85Decode, MIN_SIDE, MAX_IMAGES };
