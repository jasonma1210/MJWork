// 正文解析与 OCR（2026-10-27 从 main/knowledgeBaseQuery.js 抽出）
//
// 为什么单独成文件：检索核已经贴到 800 行红线（God File 门禁），而「正文怎么从各种格式里抠出来」
// 与「索引/授权/快照怎么算」本来是两件事：
//   · 本文件只依赖 fs / path / 内置 zlib / 可选的外部 OCR 引擎；
//   · 检索核不需要知道进来的是 PDF 还是 DOCX，它只要一段文本。
// 拆开后解析器可以单独测（test/knowledge-parsers / knowledge-ocr），检索核也能保持可读。
//
// 失败一律返回**明确错误码**，绝不返回「空字符串 + ok」——
// 那会把「解析不了」伪装成「已索引但没内容」（§8.2 明令禁止）。
'use strict';

const fs = require('fs');
const path = require('path');
const ocrEngine = require('./ocrEngine');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.text']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const SUPPORTED_MIME = new Set([
  'text/plain', 'text/markdown', 'application/json', 'text/csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tiff',
]);
const EXT_MIME = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

/** OCR 引擎状态（capabilities 与导入共用同一份判定，避免两处口径不一致） */
function ocrStatus() {
  return ocrEngine.detect();
}

/**
 * 图片是否算「支持」取决于本机有没有 OCR 引擎（运行时探测）。
 * 声明支持但导入必失败，比不支持更糟——用户会以为是自己文件的问题。
 */
function supportedExt() {
  const set = new Set([...TEXT_EXT, '.pdf', '.docx']);
  if (ocrStatus().available) for (const e of IMAGE_EXT) set.add(e);
  return set;
}

/**
 * 按扩展名解析出可索引正文（async：OCR 是外部进程调用）。
 * @param {string} ext
 * @param {Buffer} buf
 * @param {{filePath?: string|null, onStage?: Function|null, shouldCancel?: Function|null}} ctx
 */
async function parseContent(ext, buf, ctx = {}) {
  const { filePath = null, onStage = null, shouldCancel = null } = ctx;
  const stage = (n) => { try { if (onStage) onStage(n); } catch { /* 进度回调异常不影响解析 */ } };
  // 取消判定抛错 ⇒ 返回「未取消」= 用户点了取消但解析照跑（OCR/PDF 是长任务），且无痕迹。
  // 只在首次留痕，避免逐块刷屏。
  let cancelProbeWarned = false;
  const cancelled = () => { try { return !!(shouldCancel && shouldCancel()); } catch (e) { if (!cancelProbeWarned) { cancelProbeWarned = true; console.warn('[kbParse] 取消判定抛错，本次解析将无法中途取消：', e?.message || e); } return false; } };

  if (TEXT_EXT.has(ext)) {
    // 文本类：带 BOM 的按 UTF-8 去 BOM；不做智能编码猜测（猜错比报错更坏）
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, text };
  }
  if (ext === '.docx') return require('./kbDocx').parseDocx(buf);
  if (IMAGE_EXT.has(ext)) return ocrSingleImage(filePath, stage);
  if (ext === '.pdf') {
    const parsed = require('./kbPdf').parsePdf(buf);
    // 有文本层：直接用（PDF 内插图不做 OCR——正文已在，OCR 插图只会引入噪声）；
    // 没文本层（扫描件）：抽页面图像送 OCR，这是「PDF 里全是图」的唯一可行路径。
    if (parsed.ok) return { ...parsed, ocrApplied: false };
    if (parsed.code !== 'EMPTY_CONTENT') return parsed; // 加密/编码不可信：OCR 也救不了（流是加密的）
    return ocrPdfImages(buf, stage, cancelled);
  }
  return { ok: false, code: 'UNSUPPORTED_TYPE', reason: `不支持的扩展名 ${ext}` };
}

/** 单张图片：直接对文件跑 OCR（不复制到临时目录，省一次 IO） */
async function ocrSingleImage(filePath, stage) {
  const eng = ocrStatus();
  if (!eng.available) return { ok: false, code: 'OCR_UNAVAILABLE', reason: eng.reason };
  if (!filePath) return { ok: false, code: 'INVALID_PATH' };
  stage('ocr');
  const r = await ocrEngine.ocrImage(filePath);
  if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
  if (!r.text) return { ok: false, code: 'EMPTY_CONTENT', reason: '图片里没有识别到文字（可能不是文档截图）' };
  return { ok: true, text: r.text, ocrApplied: true, ocrLanguage: r.language, ocrPages: 1, ocrCandidates: 1 };
}

/**
 * 扫描版 PDF：抽内嵌页面图像 → 逐张 OCR。
 * 为什么逐页保留页码：OCR 文本丢了页码就无法定位，用户搜到一句话也不知道在原 PDF 第几页。
 */
async function ocrPdfImages(buf, stage, cancelled) {
  const eng = ocrStatus();
  const { extractImages } = require('./kbPdfImages');
  const ex = extractImages(buf);
  if (ex.images.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_CONTENT',
      reason: eng.available
        ? 'PDF 无文本层，且未找到可识别的页面图像（可能是矢量描边或非常规压缩的图像）'
        : `PDF 无文本层（扫描件），本机也没有 OCR 引擎：${eng.reason}`,
    };
  }
  if (!eng.available) {
    return {
      ok: false, code: 'NEEDS_OCR',
      reason: `PDF 是扫描件（${ex.images.length} 张页面图），本机无 OCR 引擎：${eng.reason}`,
    };
  }
  stage('ocr');
  const parts = [];
  const tmpFiles = [];
  try {
    for (const img of ex.images) {
      if (cancelled()) return { ok: false, code: 'CANCELED' };
      const tmp = ocrEngine.writeTempImage(img.buf, img.ext);
      tmpFiles.push(tmp);
      // 逐页串行：OCR 是 CPU 密集的外部进程，并发只会互相拖慢，也让取消更难收拾
      const r = await ocrEngine.ocrImage(tmp);
      if (r.ok && r.text) parts.push(`【第 ${img.page} 页】\n${r.text}`);
    }
  } finally {
    for (const f of tmpFiles) {
      try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* 临时文件清理失败不影响结果 */ }
    }
  }
  if (parts.length === 0) {
    return { ok: false, code: 'EMPTY_CONTENT', reason: '扫描版 PDF 的页面图像里没有识别到文字' };
  }
  // 页数被上限掐掉时必须显式标记：只 OCR 前 N 页却报告「已索引」，
  // 用户搜不到后面的内容会以为文档里没有 —— 这类「静默少索引」比失败更难发现。
  const droppedByLimit = ex.skipped.some((x) => x.reason === 'too_many');
  return {
    ok: true, text: parts.join('\n\n'), ocrApplied: true,
    ocrPages: parts.length, ocrCandidates: ex.candidates, ocrSkipped: ex.skipped.length,
    ocrTruncated: droppedByLimit || parts.length < ex.candidates,
  };
}

module.exports = {
  TEXT_EXT, IMAGE_EXT, SUPPORTED_MIME, EXT_MIME,
  supportedExt, ocrStatus, parseContent, ocrSingleImage, ocrPdfImages,
};
