// T0-5：本地结构化运行 trace（M0/P0，2026-10-15）
// 背景：引擎此前只有 console 散日志，「跑到一半卡住」「为什么熔断」无法事后还原。
// 设计：每次 Agent 运行落一个 JSONL（userData/traces/<runId>.jsonl），逐行一条引擎
// trace 事件（run_start/model/model_error/tool/run_end，含耗时与用量）——本地可观测性，
// **不上报任何数据**（与本地优先主张一致），供 M2 诊断包导出（T2-6）与人工排障使用。
// 纪律：写失败只告警，绝不影响运行主流程（与 checkpointStore 的 fail-open 同语义）。
// 容量：按文件数 LRU 淘汰（按 mtime 删最旧），默认保留最近 50 次运行。

const MAX_TRACE_FILES = 50;

let traceDir = null; // userData/traces

function initRunTrace(userDataPath) {
  traceDir = userDataPath ? `${userDataPath}/traces`.replace(/\/+/g, '/') : null;
}

// 追加一条 trace 事件；evt 由引擎 onTrace 透出，宿主补 ts 保证每条事件带绝对时间戳。
function appendTraceEvent(runId, evt) {
  if (!traceDir || !runId) return false;
  const fs = require('fs');
  const file = `${traceDir}/${sanitizeRunId(runId)}.jsonl`;
  try {
    fs.mkdirSync(traceDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ...evt, ts: Date.now() })}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn(`[runTrace] trace 落盘失败 runId=${runId}:`, e.message);
    return false;
  }
}

// runId 可能来自渲染层 payload，必须清洗为安全文件名（防路径穿越/非法字符）。
function sanitizeRunId(runId) {
  return String(runId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

// LRU 淘汰：目录内 jsonl 超过上限时按 mtime 删最旧。返回删除数。
// 只在写入路径顺带触发（低频），不做定时器。
function evictOldTraces(max = MAX_TRACE_FILES) {
  if (!traceDir) return 0;
  const fs = require('fs');
  try {
    const files = fs.readdirSync(traceDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = `${traceDir}/${f}`;
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch { /* 竞态删除：排最旧 */ }
        return { p, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    while (files.length - removed > max) {
      try { fs.rmSync(files[removed].p); } catch { break; }
      removed += 1;
    }
    return removed;
  } catch {
    return 0; // 目录不存在等：无需淘汰
  }
}

// 读取一次运行的全部事件（诊断/测试用）；文件不存在返回空数组。
function readTraceEvents(runId) {
  if (!traceDir || !runId) return [];
  const fs = require('fs');
  try {
    const raw = fs.readFileSync(`${traceDir}/${sanitizeRunId(runId)}.jsonl`, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

module.exports = { initRunTrace, appendTraceEvent, evictOldTraces, readTraceEvents, sanitizeRunId, MAX_TRACE_FILES };
