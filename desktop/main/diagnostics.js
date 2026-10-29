// T2-5：本地崩溃 / 异常聚合（M2，2026-10-15）
// 背景：此前主进程只有 crash.log 纯文本兜底（M0 前的 M3-5 遗留），渲染层未捕获异常无人接——
// 「应用闪退了但说不清为什么」是用户投诉里最难排障的一类。
// 设计（全部落本机，**不上传任何数据**，与本地优先主张一致）：
//   1) Electron crashReporter：原生崩溃（SIGSEGV 等 JS 兜不住的）dump 到
//      userData/Crashpad，uploadToServer 关闭（submitURL 置空占位）；
//   2) 主进程 uncaughtException / unhandledRejection 统一收口：结构化 JSONL
//      （userData/diagnostics/crash-YYYYMMDD.jsonl），每条含 ts/kind/stack/
//      活跃 runId 列表 + 该 run 的 trace 尾部（T0-5，回查「崩之前最后在干什么」）；
//   3) 渲染层 window error / unhandledrejection 经 preload 'diag:report' 转发到同一文件
//      （渲染层崩溃主进程不感知，此前完全丢失现场）。
// 纪律：诊断写入自身抛错必须吞掉（兜底路径二次抛出 = 把事故升级成崩溃循环）。
// 容量：按日分文件；高频重复异常聚合计数，首次异常必写；日志满时用有界轮转保留最新证据。
const fs = require('fs');
const path = require('path');

const MAX_DIAG_FILE_BYTES = 5 * 1024 * 1024; // 单日主文件上限
const MAX_DIAG_ROTATED_FILES = 3;             // 轮转文件数上限，磁盘总量仍有界
const MAX_DIAG_RECORD_BYTES = 8 * 1024;       // 单条记录上限，防 trace 填满日志
const DUPLICATE_WINDOW_MS = 60 * 1000;         // 同签名高频异常按 1 分钟窗口聚合
const TRACE_TAIL_EVENTS = 20;                 // trace 尾部事件条数

let deps = null; // { app, getActiveRunIds, readTraceEvents }
let diagDir = null;
const recentSignatures = new Map();

function errorSignature(kind, stack) {
  const top = String(stack || '').split('\n').slice(0, 3).join('\n').replace(/:\d+(:\d+)?/g, ':#');
  return `${kind}:${top}`.slice(0, 1000);
}

function appendDiagnosticRecord(file, record) {
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_DIAG_RECORD_BYTES) {
    record = { ...record, traceTail: undefined, stack: String(record.stack || '').slice(0, 4000), truncated: true };
    line = `${JSON.stringify(record)}\n`;
  }
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* 新文件 */ }
  if (size + Buffer.byteLength(line) > MAX_DIAG_FILE_BYTES) {
    for (let i = MAX_DIAG_ROTATED_FILES; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try {
        if (i === MAX_DIAG_ROTATED_FILES && fs.existsSync(to)) fs.unlinkSync(to);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch (e) {
        console.warn('[diagnostics] 日志轮转失败，仍尝试保留新异常:', e.message);
      }
    }
  }
  // 轮转失败/Windows 文件暂不可改名时：不在已满文件上无界追加，改写独立溢出记录。
  let finalSize = 0;
  try { finalSize = fs.statSync(file).size; } catch { /* 新文件 */ }
  if (finalSize + Buffer.byteLength(line) > MAX_DIAG_FILE_BYTES) {
    fs.appendFileSync(`${file}.overflow-${Date.now()}`, line, 'utf8');
    return;
  }
  fs.appendFileSync(file, line, 'utf8');
}

function initDiagnostics(d) {
  deps = d;
  diagDir = path.join(d.app.getPath('userData'), 'diagnostics');
  registerIpc();
}

function diagFile() {
  return path.join(diagDir, `crash-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

// 结构化记录一条异常。任何失败静默（兜底路径绝不二次抛出）。
function reportError(kind, err, extra = {}) {
  try {
    const file = diagFile();
    fs.mkdirSync(diagDir, { recursive: true });
    const stack = String(err?.stack || err?.message || err || '').slice(0, 8000);
    const signature = errorSignature(kind, stack);
    const nowMs = Date.now();
    const previous = recentSignatures.get(signature);
    if (previous && nowMs - previous.lastTs < DUPLICATE_WINDOW_MS) {
      previous.count += 1;
      previous.lastTs = nowMs;
      // 高频重复异常不再写成数千条副本；首次记录仍保留，窗口末写摘要并刷新最近计数。
      if (previous.count % 100 !== 0) return;
      appendDiagnosticRecord(file, {
        ts: new Date(nowMs).toISOString(), kind, signature,
        repeatSummary: true, repeatCount: previous.count,
        firstTs: previous.firstTs, lastTs: new Date(nowMs).toISOString(),
        stack: stack.slice(0, 1200),
      });
      return;
    }
    recentSignatures.set(signature, { count: 1, firstTs: new Date(nowMs).toISOString(), lastTs: nowMs });
    if (recentSignatures.size > 2000) recentSignatures.delete(recentSignatures.keys().next().value);
    const record = {
      ts: new Date(nowMs).toISOString(),
      kind, // uncaughtException | unhandledRejection | rendererError
      signature,
      stack,
      ...extra,
    };
    // 关联活跃运行：崩溃时刻正在跑的 run 是最高价值线索；附各自 trace 尾部
    if (deps?.getActiveRunIds) {
      try {
        const runIds = deps.getActiveRunIds();
        if (runIds.length) {
          record.runIds = runIds;
          record.traceTail = {};
          for (const rid of runIds.slice(0, 3)) { // 最多 3 个 run，防记录膨胀
            record.traceTail[rid] = (deps.readTraceEvents?.(rid) || []).slice(-TRACE_TAIL_EVENTS);
          }
        }
      } catch { /* trace 读取失败不影响异常记录本体 */ }
    }
    appendDiagnosticRecord(file, record);
  } catch {
    // 兜底的兜底：连诊断目录都写不了（磁盘满/权限），只能放弃——绝不抛出
  }
}

// Electron 原生崩溃捕获（dump 落 userData/Crashpad，不上传）。
// 非打包/测试宿主无 crashReporter 时静默跳过。
// 保留 _app 形参以匹配调用方签名；内部直接用 electron.crashReporter，不消费该实例
function startCrashReporter(_app) {
  try {
    const { crashReporter } = require('electron');
    if (!crashReporter || typeof crashReporter.start !== 'function') return false;
    crashReporter.start({
      submitURL: '',            // 无上报地址
      uploadToServer: false,    // 明确不上传（本地优先）
      compress: false,
      globalExtra: { product: 'MJCode', localOnly: 'true' },
    });
    return true;
  } catch (e) {
    console.warn('[diagnostics] crashReporter 启动失败（不影响运行）:', e.message);
    return false;
  }
}

// 渲染层错误转发入口（preload 'diag:report'）。payload 已在渲染层裁剪为纯文本字段。
function registerIpc() {
  const { ipcMain } = require('electron');
  ipcMain.on('diag:report', (_event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const kind = String(payload.kind || 'rendererError');
    reportError(kind, {
      message: String(payload.message || '').slice(0, 2000),
      stack: String(payload.stack || '').slice(0, 8000),
    }, { source: 'renderer' });
  });
}

function diagnosticsDir() {
  return diagDir;
}

module.exports = { initDiagnostics, reportError, startCrashReporter, diagnosticsDir, MAX_DIAG_FILE_BYTES, TRACE_TAIL_EVENTS };
