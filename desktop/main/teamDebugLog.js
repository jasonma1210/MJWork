// 团队操作全链路调试日志（2026-10-21）
//
// 为什么需要它：
//   团队派活的问题（任务无人认领 / 看板显示完成但没有产出 / 成员空转烧 token）都发生在
//   「渲染层点一下 → IPC → 编排拆解 → 批次计划 → Worker 认领 → 引擎运行 → 终态落库」这条长链上。
//   任何一环断了，用户界面只会看到一张结果卡，开发者却拿不到中间态。
//   本模块把这条链上的关键事实写成可导出的 JSONL，用户操作完点「导出日志」即可发给开发者。
//
// 设计纪律：
//   · 单一事实来源：所有团队链路埋点统一走 `log(scope, event, data)`，不在各模块各写一套文件通道；
//   · 默认开启、详细模式默认开启（用户就是要「全打出来」），但单条字符串截断 8KB、数组截断 30 项，
//     防止某次模型输出把日志文件瞬间撑爆；
//   · 按日切文件 + 单文件 20MB 轮转（.1 覆盖写），只保留最近 7 个文件；
//   · 日志会被用户主动发给他人，写入前统一做密钥脱敏（sk- / Bearer / ghp_ / AKIA）与敏感键剔除；
//   · 纯 Node 依赖（fs/path/zipStore），不 require electron —— 单测可直接在 node 环境跑。
const fs = require('fs');
const path = require('path');
const { writeZip } = require('./zipStore');

const FILE_PREFIX = 'team-debug-';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_STRING = 8000;
const MAX_ARRAY = 30;
const MAX_DEPTH = 6;
const RING_SIZE = 2000;
const KEEP_FILES = 7;

// 与 diagExport 的 SECRET_SCAN_RE 同口径（这里独立一份是为了让本模块零 electron 依赖）
const SECRET_SCAN_RE = /(sk-[A-Za-z0-9]{16,}|Bearer\s+\S+|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/g;
const REDACTED = '***REDACTED***';
const SENSITIVE_KEY_RE = /(api[_-]?key|token|secret|password|authorization|credential|cookie)/i;

let cfg = {
  dir: '',        // 日志目录（主进程传 userData/logs；单测传临时目录）
  meta: {},       // 版本/平台等，导出时随包写入 meta.json
  enabled: true,
  verbose: true,
};
let ring = [];
let seq = 0;
let currentDay = '';
let fileBytes = 0;

function redactText(text) {
  return String(text == null ? '' : text).replace(SECRET_SCAN_RE, REDACTED);
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactText(value).slice(0, MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return '[function]';
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: redactText(String(value.stack || '')).slice(0, MAX_STRING) };
  }
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1, seen));
      if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : sanitize(v, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

function ensureDir() {
  if (!cfg.dir) return false;
  try {
    fs.mkdirSync(cfg.dir, { recursive: true });
    return true;
  } catch { /* C-001：建目录失败 ⇒ 返回 false 让调用方按「本轮不落盘」处理。
      日志设施自身故障时无处可记（记给谁都会走同一条路），因此这里只能以返回值表达，且绝不影响团队任务 */
    return false;
  }
}

function dayStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fileForToday() {
  const day = dayStamp();
  return { day, file: path.join(cfg.dir, `${FILE_PREFIX}${day}.jsonl`) };
}

// 单文件超过上限 → 轮转为 `.1`（覆盖上一份 .1）。轮转是「保留最近一段」而不是无限追加。
function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_FILE_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch { /* 文件还不存在或不可读：无需轮转 */ }
}

function pruneOldFiles() {
  try {
    const names = fs.readdirSync(cfg.dir)
      .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith('.jsonl'))
      .map((n) => ({ n, mtime: fs.statSync(path.join(cfg.dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { n } of names.slice(KEEP_FILES)) {
      try { fs.unlinkSync(path.join(cfg.dir, n)); } catch { /* 忽略 */ }
    }
  } catch { /* 目录不可读：忽略 */ }
}

function appendLine(line) {
  if (!ensureDir()) return;
  try {
    const { day, file } = fileForToday();
    if (day !== currentDay) {
      currentDay = day;
      fileBytes = 0;
      pruneOldFiles();
    }
    rotateIfNeeded(file);
    if (!fileBytes) {
      try { fileBytes = fs.statSync(file).size; } catch { /* C-001：读不到大小按 0 计 —— 代价是本轮不触发轮转；
          下一拍仍会重试 stat，不改写入路径，也绝不让调试日志影响团队任务 */ fileBytes = 0; }
    }
    fs.appendFileSync(file, `${line}\n`);
    fileBytes += Buffer.byteLength(line) + 1;
  } catch { /* 日志落盘失败绝不能影响团队任务本身 */ }
}

/**
 * 写一条调试日志。
 * @param {string} scope 模块域：ipc / orchestrator / dispatchPlan / wave / worker / teamTool / renderer ...
 * @param {string} event 事件名：dispatch_in / plan_raw / task_claim / task_settle / ...
 * @param {object} [data] 结构化事实（会被脱敏与截断）
 * @param {{level?: 'basic'|'verbose'}} [opts] verbose 条目在「详细模式」关闭时丢弃
 * @returns {object|null} 写入的条目（被禁用或过滤时为 null）
 */
function log(scope, event, data, opts = {}) {
  if (!cfg.enabled) return null;
  const level = opts.level || 'basic';
  if (level === 'verbose' && !cfg.verbose) return null;
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    seq: ++seq,
    scope: String(scope || 'unknown'),
    event: String(event || 'unknown'),
    level,
    data: sanitize(data === undefined ? null : data),
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE);
  appendLine(JSON.stringify(entry));
  // 终端/打包版 main-*.log 同步可见（截断 400 字符，避免刷屏）
  try {
    const brief = JSON.stringify(entry.data);
    console.log(`[team-debug] ${entry.scope}/${entry.event} ${String(brief).slice(0, 400)}`);
  } catch { /* 序列化失败忽略 */ }
  return entry;
}

function initTeamDebugLog({ dir, meta } = {}) {
  if (dir) cfg.dir = dir;
  if (meta && typeof meta === 'object') cfg.meta = meta;
  ensureDir();
  log('session', 'debug_started', {
    meta: cfg.meta,
    enabled: cfg.enabled,
    verbose: cfg.verbose,
    pid: process.pid,
  });
}

function setEnabled(v) {
  cfg.enabled = !!v;
  log('session', 'debug_toggled', { enabled: cfg.enabled });
  return cfg.enabled;
}

function setVerbose(v) {
  cfg.verbose = !!v;
  log('session', 'verbose_toggled', { verbose: cfg.verbose });
  return cfg.verbose;
}

function isEnabled() { return cfg.enabled; }
function isVerbose() { return cfg.verbose && cfg.enabled; }

function status() {
  let file = '';
  let bytes = 0;
  if (cfg.dir) {
    const t = fileForToday();
    file = t.file;
    try { bytes = fs.statSync(file).size; } catch { /* C-001：同上——状态查询里的字节数取不到就报 0，纯展示 */ bytes = 0; }
  }
  return {
    ok: true,
    enabled: cfg.enabled,
    verbose: cfg.verbose,
    dir: cfg.dir,
    file,
    bytes,
    entries: ring.length,
    meta: cfg.meta,
  };
}

function tail(n = 200) {
  const limit = Math.max(1, Math.min(Number(n) || 200, RING_SIZE));
  return ring.slice(-limit);
}

/**
 * 导出日志包：把最近的 team-debug-*.jsonl 与 meta.json 打成 zip。
 * 落点：`<userData>/diagnostics/team-debug-<时间戳>.zip`（与诊断包同目录，便于用户找到）。
 * @returns {{ok:boolean, path?:string, files?:number, error?:string}}
 */
function exportBundle() {
  if (!cfg.dir) return { ok: false, error: '日志目录未初始化' };
  try {
    ensureDir();
    // 把内存里尚未落盘的最新条目也写进去（正常每条都同步落盘，这里只是兜底）
    const names = fs.readdirSync(cfg.dir)
      .filter((n) => n.startsWith(FILE_PREFIX) && (n.endsWith('.jsonl') || n.endsWith('.jsonl.1')))
      .map((n) => ({ n, mtime: fs.statSync(path.join(cfg.dir, n)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
      .slice(-KEEP_FILES * 2);
    const entries = names.map(({ n }) => ({ name: n, data: fs.readFileSync(path.join(cfg.dir, n)) }));
    const meta = {
      ...cfg.meta,
      exportedAt: new Date().toISOString(),
      enabled: cfg.enabled,
      verbose: cfg.verbose,
      files: names.map((x) => x.n),
      entriesInMemory: ring.length,
      // 提示接收方：这些日志已做密钥脱敏，但用户输入内容按原样保留
      note: 'team debug bundle: secrets redacted; user text kept verbatim',
    };
    entries.push({ name: 'meta.json', data: JSON.stringify(meta, null, 2) });
    const outDir = path.join(path.dirname(cfg.dir), 'diagnostics');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `team-debug-${Date.now()}.zip`);
    writeZip(entries, outPath);
    log('session', 'export_bundle', { path: outPath, files: names.length });
    return { ok: true, path: outPath, files: names.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 渲染层操作埋点（用户点击/看板打开等），与主进程日志同一文件、同一时间线。 */
function appendFromRenderer(entry = {}) {
  const safe = {
    action: String(entry.action || '').slice(0, 120),
    detail: entry.detail == null ? null : entry.detail,
    threadId: entry.threadId == null ? null : String(entry.threadId).slice(0, 128),
  };
  if (!safe.action) return null;
  return log('renderer', safe.action, { detail: safe.detail, threadId: safe.threadId });
}

module.exports = {
  initTeamDebugLog,
  log,
  setEnabled,
  setVerbose,
  isEnabled,
  isVerbose,
  status,
  tail,
  exportBundle,
  appendFromRenderer,
  // 单测用：清空内存环（不影响已落盘文件）
  _resetRing: () => { ring = []; seq = 0; },
};
