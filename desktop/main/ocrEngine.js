// OCR 引擎（2026-10-27，M3 补强：扫描件/图片入库）
//
// 为什么是 tesseract 而不是自研或 Apple Vision：
//   · 本机实测 `swift --version` 是 5.10，而 SDK 是 Swift 6.0.3 构建的 →
//     `swift c` 直接报「this SDK is not supported by the compiler」，Vision 方案在本机**跑不起来**；
//     它还会把「必须装 Xcode CLT」变成产品的隐性前置条件。故不采用。
//   · tesseract 是独立可执行文件，不引入 npm 依赖；本机已装且带 chi_sim/chi_tra/eng 语种。
//
// 设计要点（全部是「失败要显式」的具体化）：
//   ① 引擎是**运行时探测**的：找不到就返回 `available:false` + 原因，能力位如实声明，
//      绝不在导入时静默产出空文本；
//   ② 语种按「本机实际装了的」挑，不硬写 chi_sim+eng（没装 chi_sim 时会直接报错）；
//   ③ 每次调用都有超时（大图慢，但不能无限挂住导入），超时按 `OCR_TIMEOUT` 明确失败；
//   ④ 输出只取 stdout 文本，不解析 tesseract 的中间格式（降低版本差异面）。
'use strict';

const { spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OCR_TIMEOUT_MS = 120000;
const PREFERRED_LANGS = ['chi_sim', 'eng'];

let cached = null;

/**
 * 找可执行文件。不能只查 PATH：
 * 打包后的 .app 由 Finder 启动时，继承的是 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
 * **不包含** /opt/homebrew/bin —— 于是「本机明明装了 tesseract，App 里却显示 OCR 不可用」。
 * 这是本地优先产品最典型的假故障，所以这里按「显式指定 → PATH → 常见安装位置 → 随应用打包位置」依次找。
 */
function which(bin) {
  const candidates = [];
  const envKey = `MJCODE_${bin.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`;
  if (process.env[envKey]) candidates.push(process.env[envKey]);
  for (const d of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(d, bin));
  }
  // Homebrew(Apple Silicon / Intel)、MacPorts、系统目录
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']) {
    candidates.push(path.join(d, bin));
  }
  // 随应用打包的位置（将来若把二进制塞进 resources 也能直接用，无需改这里）
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ocr', bin));
    candidates.push(path.join(process.resourcesPath, 'tesseract', bin));
  }
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* 权限/悬空链接：跳过 */ }
  }
  return null;
}

/** 数据目录：随应用打包的 tessdata 优先（保证版本一致），否则交给 tesseract 自己的默认查找 */
function tessdataDir() {
  const candidates = [];
  if (process.env.TESSDATA_PREFIX) candidates.push(process.env.TESSDATA_PREFIX);
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ocr', 'tessdata'));
    candidates.push(path.join(process.resourcesPath, 'tesseract', 'tessdata'));
  }
  for (const d of candidates) {
    try {
      if (d && fs.existsSync(path.join(d, 'eng.traineddata'))) return d;
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 安装提示（界面与 capabilities 共用同一份文案，避免「提示里写的命令和实际不一致」） */
const INSTALL_HINT = 'macOS: brew install tesseract tesseract-lang（Debian/Ubuntu: apt install tesseract-ocr tesseract-ocr-chi-sim）';

/**
 * 探测 OCR 引擎（结果缓存；能力位与导入共用同一份判定，避免两处口径不一致）。
 * @returns {{available: boolean, engine: string|null, bin?: string, langs?: string[], languages?: string[], reason?: string}}
 */
function detect({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const bin = which('tesseract');
  if (!bin) {
    cached = {
      available: false, engine: null,
      reason: `本机未找到 tesseract（OCR 需要它）。${INSTALL_HINT}`,
      installHint: INSTALL_HINT,
      searchedPath: true,
    };
    return cached;
  }
  let langs = [];
  try {
    const r = spawnSync(bin, ['--list-langs'], { encoding: 'utf8', timeout: 10000 });
    langs = String(r.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^List of available/i.test(l));
  } catch (e) {
    // 关键：langs 空会让下面报「tesseract 未安装任何语言包」——但 tesseract 明明在（bin 已找到）。
    // 探测崩了与没有语言包是两件事，混一起会让用户去装错东西。本函数结果有缓存，不会刷屏。
    console.warn('[ocr] tesseract --list-langs 探测失败，语言包判定将失真：', bin, e?.message || e);
    langs = [];
  }
  const preferred = PREFERRED_LANGS.filter((l) => langs.includes(l));
  const fallback = preferred.length ? preferred : (langs.includes('eng') ? ['eng'] : langs.slice(0, 1));
  if (fallback.length === 0) {
    cached = { available: false, engine: 'tesseract', bin, reason: 'tesseract 未安装任何语言包（tesseract-lang）' };
    return cached;
  }
  cached = {
    available: true,
    engine: 'tesseract',
    bin,
    tessdataDir: tessdataDir(),
    langs,                 // 本机全部语种
    languages: fallback,   // 本次会用到的语种
    reason: null,
  };
  return cached;
}

/**
 * 识别单张图片（**异步**：用 execFile 而不是 spawnSync —— 后者会把主进程事件循环
 * 钉住整个 OCR 时长，进度事件发不出去、取消信号也收不到，等于把「可取消导入」变回不可取消）。
 * @returns {Promise<{ok: boolean, text?: string, code?: string, reason?: string, ms?: number}>}
 */
function ocrImage(filePath, { languages } = {}) {
  const eng = detect();
  if (!eng.available) return Promise.resolve({ ok: false, code: 'OCR_UNAVAILABLE', reason: eng.reason });
  if (!fs.existsSync(filePath)) return Promise.resolve({ ok: false, code: 'FILE_NOT_FOUND' });
  const langArg = (languages && languages.length ? languages : eng.languages).join('+');
  const dataDirArg = eng.tessdataDir ? ['--tessdata-dir', eng.tessdataDir] : [];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      eng.bin,
      [filePath, 'stdout', '-l', langArg, '--psm', '3', ...dataDirArg],
      { encoding: 'utf8', timeout: OCR_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, _stderr) => {
        const ms = Date.now() - started;
        if (err) {
          const code = err.killed || err.signal === 'SIGTERM' ? 'OCR_TIMEOUT' : 'OCR_FAILED';
          resolve({ ok: false, code, reason: `OCR 执行失败：${err.message}`, ms });
          return;
        }
        const text = normalizeOcrText(stdout);
        // 空结果不是错误，但也**不能**算成功：图片里可能确实没有文字（照片/图表）
        if (!text) { resolve({ ok: true, text: '', empty: true, ms }); return; }
        resolve({ ok: true, text, ms, language: langArg });
      },
    );
  });
}

/** 清理 OCR 噪声：行尾空白、孤立符号行、过多空行 */
function normalizeOcrText(raw) {
  return String(raw || '')
    .split('\n')
    .map((l) => l.replace(/[\s\u00a0]+$/g, '').replace(/^\s+/g, ''))
    // 纯符号行（如 "|"、"~~"、"_"）是版式噪声，不是内容
    .filter((l) => l && !/^[^\p{L}\p{N}]+$/u.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 写临时图片文件（调用方负责清理）；返回路径 */
function writeTempImage(buf, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-ocr-'));
  const p = path.join(dir, `page${ext || '.png'}`);
  fs.writeFileSync(p, buf);
  return p;
}

module.exports = { detect, ocrImage, normalizeOcrText, writeTempImage, tessdataDir, which, INSTALL_HINT, OCR_TIMEOUT_MS };
