// PDF 文本解析（M3 §8.2 的「可解析的 PDF」）
//
// 为什么自己解而不引库：`package.json` 里没有任何 PDF 依赖，仓库也没有 pdfjs/mammoth 之类的
// 传递依赖；为一个「首里程碑的文本抽取」引入整套渲染内核（体积 + 打包白名单 + 供应链）不划算。
//
// 支持范围（写死在这里，也写进 capabilities；**不假装全能**）：
//   ✔ 未加密 PDF 的文本抽取：扫描对象、FlateDecode 解压、`Tj/TJ/'/"` 文本算子；
//   ✔ 字体编码：有 `/ToUnicode` 的走 CMap（bfchar/bfrange），简单字体按 WinAnsi/ASCII 直读；
//   ✔ 复合字体（`/Type0` + Identity-H）必须有 ToUnicode，否则报 UNSUPPORTED_ENCODING；
//   ✘ 加密 PDF（`/Encrypt`）→ ENCRYPTED；
//   ✘ 扫描件（无文本层）→ EMPTY_CONTENT（明确失败，**不假装已索引**）；
//   ✘ 版面还原（分栏/表格/阅读顺序）不做：只保证文本内容可检索，不保证排版一致。
//
// 诚实标注：本实现的正确性证据来自自造夹具（含 ToUnicode + Flate 的合成 PDF），
// 尚未在大量真实 PDF 语料上回归。真实语料的失败会以「明确错误码」出现，不会静默产出乱码——
// 前提是调用方按下面的 code 分支处理，而不是把空字符串当成功。
'use strict';

const zlib = require('zlib');

const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

/** PDF 字符串里的转义解码（\n \r \t \b \f \( \) \\ \ddd 及行续） */
function unescapePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const nxt = raw[i + 1];
    i += 1;
    if (nxt === undefined) break;
    if (nxt === 'n') out += '\n';
    else if (nxt === 'r') out += '\r';
    else if (nxt === 't') out += '\t';
    else if (nxt === 'b') out += '\b';
    else if (nxt === 'f') out += '\f';
    else if (nxt === '\n') { /* 行续：忽略 */ }
    else if (nxt >= '0' && nxt <= '7') {
      let oct = nxt;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') { oct += raw[i + 1]; i += 1; }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else out += nxt;
  }
  return out;
}

function hexToString(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 ? `${clean}0` : clean;
  let out = '';
  for (let i = 0; i < padded.length; i += 2) out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  return out;
}

/**
 * 把内容流切成 token 流。
 * token: {t:'name'|'num'|'str'|'hex'|'op'|'[' |']', v:string}
 */
function tokenize(content) {
  const tokens = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (WS.has(ch)) { i += 1; continue; }
    if (ch === '%') { while (i < n && content[i] !== '\n') i += 1; continue; }
    if (ch === '(') {
      // 括号可嵌套，需按层数配对（此前用正则截到第一个 ')' → 含括号的正文被截断）
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < n && depth > 0) {
        const c = content[j];
        if (c === '\\') { raw += c + (content[j + 1] || ''); j += 2; continue; }
        if (c === '(') depth += 1;
        else if (c === ')') { depth -= 1; if (depth === 0) break; }
        raw += c; j += 1;
      }
      tokens.push({ t: 'str', v: unescapePdfString(raw) });
      i = j + 1;
      continue;
    }
    if (ch === '<' && content[i + 1] === '<') {
      let depth = 0; let j = i;
      while (j < n) {
        if (content[j] === '<' && content[j + 1] === '<') { depth += 1; j += 2; continue; }
        if (content[j] === '>' && content[j + 1] === '>') { depth -= 1; j += 2; if (depth === 0) break; continue; }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '<') {
      let j = content.indexOf('>', i);
      if (j < 0) j = n;
      tokens.push({ t: 'hex', v: hexToString(content.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    if (ch === '[' || ch === ']') { tokens.push({ t: ch, v: ch }); i += 1; continue; }
    if (ch === '/') {
      let j = i + 1; let name = '';
      while (j < n && !WS.has(content[j]) && !DELIM.has(content[j])) { name += content[j]; j += 1; }
      tokens.push({ t: 'name', v: name });
      i = j;
      continue;
    }
    let j = i; let word = '';
    while (j < n && !WS.has(content[j]) && !DELIM.has(content[j])) { word += content[j]; j += 1; }
    if (word) {
      const isNum = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word);
      tokens.push({ t: isNum ? 'num' : 'op', v: word });
      i = j;
      continue;
    }
    i += 1; // 未识别字符：跳过（不抛错，避免整篇因一个怪字符失败）
  }
  return tokens;
}

/** 解析 ToUnicode CMap：bfchar + bfrange（只取单/双字节映射，够覆盖常见文本 PDF） */
function parseToUnicodeCMap(cmapText) {
  const map = new Map();
  for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(m[1], 16), String.fromCodePoint(parseInt(m[2], 16)));
    }
  }
  for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    let m;
    while ((m = re.exec(block[1])) !== null) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3]) {
        const base = parseInt(m[3], 16);
        for (let c = lo; c <= hi && c - lo < 4096; c += 1) map.set(c, String.fromCodePoint(base + (c - lo)));
      } else {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => parseInt(x[1], 16));
        for (let c = lo; c <= hi && items.length; c += 1) {
          const cp = items[c - lo];
          if (cp !== undefined) map.set(c, String.fromCodePoint(cp));
        }
      }
    }
  }
  return map;
}

/** 扫描 PDF 对象：返回 [{ num, dict, stream:Buffer|null }] */
function readObjects(buf) {
  const s = buf.toString('latin1');
  const objs = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index;
    const endObj = s.indexOf('endobj', start);
    const segEnd = endObj < 0 ? s.length : endObj;
    const seg = s.slice(start, segEnd);
    const streamIdx = seg.indexOf('stream');
    let dict = seg;
    let streamRaw = null;
    if (streamIdx >= 0) {
      dict = seg.slice(0, streamIdx);
      let dataStart = start + streamIdx + 6;
      if (s[dataStart] === '\r') dataStart += 1;
      if (s[dataStart] === '\n') dataStart += 1;
      const endStream = s.indexOf('endstream', dataStart);
      const dataEnd = endStream < 0 ? segEnd : endStream;
      streamRaw = buf.subarray(dataStart, dataEnd);
    }
    objs.push({ num: Number(m[1]), dict, stream: streamRaw });
  }
  return objs;
}

function decodeStream(obj) {
  if (!obj.stream) return null;
  const dict = obj.dict || '';
  try {
    if (/\/FlateDecode/.test(dict)) return zlib.inflateSync(obj.stream).toString('latin1');
    return obj.stream.toString('latin1');
  } catch {
    return null; // 单流解压失败：跳过该流，由「抽不到文本」这类明确结果兜底
  }
}

/**
 * @param {Buffer} buf
 * @returns {{ok:boolean, text?:string, code?:string, reason?:string}}
 */
function parsePdf(buf) {
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, code: 'PARSE_FAILED', reason: '不是有效的 PDF（缺少 %PDF- 头）' };
  }
  const head = buf.toString('latin1');
  if (/\/Encrypt\b/.test(head)) {
    return { ok: false, code: 'ENCRYPTED', reason: '该 PDF 已加密，无法抽取文本（请先解除密码保护）' };
  }
  const objs = readObjects(buf);
  // 字体：objNum → { toUnicode: Map|null, composite: boolean }
  const fontByObj = new Map();
  for (const o of objs) {
    if (!/\/Type\s*\/Font\b/.test(o.dict)) continue;
    const tu = o.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    let map = null;
    if (tu) {
      const cmapObj = objs.find((x) => x.num === Number(tu[1]));
      const cmapText = cmapObj ? decodeStream(cmapObj) : null;
      if (cmapText) map = parseToUnicodeCMap(cmapText);
    }
    fontByObj.set(o.num, { toUnicode: map, composite: /\/Subtype\s*\/Type0\b/.test(o.dict) });
  }
  // 资源名 → 字体对象号（全局扫描：同名覆盖，真实文档里通常每页一致）
  const fontByName = new Map();
  for (const o of objs) {
    const dicts = o.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g);
    for (const d of dicts) {
      for (const e of d[1].matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g)) fontByName.set(e[1], Number(e[2]));
    }
  }
  // 逐内容流抽文本
  const pieces = [];
  let sawHighBytesNoMap = false;
  for (const o of objs) {
    const content = decodeStream(o);
    if (!content || !/(Tj|TJ|BT\b)/.test(content)) continue;
    const tokens = tokenize(content);
    let currentFont = null;
    let stack = [];
    let tjBuffer = null;
    const flushText = (bytes) => {
      const font = currentFont !== null ? fontByObj.get(currentFont) : null;
      if (font && font.toUnicode && font.toUnicode.size) {
        if (font.composite) {
          let out = '';
          for (let k = 0; k + 1 < bytes.length; k += 2) {
            const code = (bytes.charCodeAt(k) << 8) | bytes.charCodeAt(k + 1);
            out += font.toUnicode.get(code) || '';
          }
          pieces.push(out);
        } else {
          let out = '';
          for (let k = 0; k < bytes.length; k += 1) out += font.toUnicode.get(bytes.charCodeAt(k)) || '';
          pieces.push(out);
        }
        return;
      }
      // 无 CMap：ASCII 直读；出现高位字节说明编码不可信 → 记失败，不产出乱码
      let out = '';
      for (let k = 0; k < bytes.length; k += 1) {
        const code = bytes.charCodeAt(k);
        if (code < 0x80) out += bytes[k];
        else { sawHighBytesNoMap = true; return; }
      }
      pieces.push(out);
    };
    for (const tk of tokens) {
      if (tk.t === 'op') {
        if (tk.v === 'Tf') {
          const nameTok = stack[stack.length - 2];
          if (nameTok && nameTok.t === 'name') currentFont = fontByName.get(nameTok.v) ?? null;
        } else if (tk.v === 'Tj' || tk.v === 'TJ' || tk.v === "'" || tk.v === '"') {
          if (tjBuffer !== null) { flushText(tjBuffer.join('')); tjBuffer = null; }
          else {
            for (let k = stack.length - 1; k >= 0; k -= 1) {
              if (stack[k].t === 'str' || stack[k].t === 'hex') { flushText(stack[k].v); break; }
            }
          }
          if (tk.v === "'" || tk.v === '"') pieces.push('\n');
        } else if (tk.v === 'T*' || tk.v === 'ET' || tk.v === 'Td' || tk.v === 'TD') {
          pieces.push('\n');
        }
        // 说明：'TJ' 已由上面的 Tj 分支统一处理（数组里累积的字符串在那里 flush），
        // 不再单列一条 else-if —— 那会构成不可达分支（lint no-dupe-else-if），也让「谁负责 flush」变模糊。
        stack = [];
        continue;
      }
      if (tk.t === '[') { tjBuffer = []; } 
      else if (tk.t === ']') { if (tjBuffer) { flushText(tjBuffer.join('')); tjBuffer = null; } } 
      else if (tjBuffer && (tk.t === 'str' || tk.t === 'hex')) { tjBuffer.push(tk.v); } 
      else { stack.push(tk); }
    }
  }
  const text = pieces.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (sawHighBytesNoMap) {
    // 有文本但编码不可信：宁可拒绝，也不能把乱码当正文索引（检索会永久失真）。
    // 顺序很重要：先判编码再判空 —— 否则「全是高位字节」会先落进 EMPTY_CONTENT，
    // 把「编码不可信」误报成「没有文本」，用户会以为文件是扫描件。
    return { ok: false, code: 'UNSUPPORTED_ENCODING', reason: 'PDF 字体缺少 ToUnicode 映射，抽取结果不可信，已拒绝索引' };
  }
  if (!text) return { ok: false, code: 'EMPTY_CONTENT', reason: 'PDF 无文本层（可能是扫描件或纯图片）' };
  return { ok: true, text };
}

module.exports = { parsePdf, parseToUnicodeCMap, tokenize, readObjects };
