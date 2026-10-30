// T4-7：Code Mode 代码执行子进程入口——持久 vm 上下文（cell 语义）。
// 每个子进程 = 一个对话的代码执行会话：多次 exec 在同一 context 里跑，
// 顶层 var/let/const/function 声明跨调用保留（vm 的 global 词法环境随 context 存活）。
// 语言选型：Node vm（零外部依赖；Python 运行时在用户机器上不可假设存在）。
// 沙箱注入面：require（真实模块——这是「执行任意代码」工具，风险由 L3/L1 审批闸把关，
// 不在沙箱层假装隔离）、console（捕获回传）、process（只读子集）、display/saveImage 辅助。
// saveImage 落盘目录由主进程每次 exec 传入（outDir），图片字节不过 IPC——
// 只回文件路径，预览句柄由主进程 grantPreviewToken 发放（T3-1 同机制）。
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { attachChildSide } = require('../engineProcess/transport');
const { CODE_CHANNELS } = require('./registry');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const RESULT_MAX_CHARS = 20000;   // 返回值序列化上限（stdout 不截断——大载荷由主进程 bigPayload 卸载）
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

// ── 序列化辅助：循环引用/函数/BigInt 全兜底，绝不让 JSON.stringify 抛穿 ──
function safeStringify(value, indent) {
  const seen = new Set();
  try {
    return JSON.stringify(value, (k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'symbol') return String(v);
      return v;
    }, indent);
  } catch { /* C-001：不可序列化（循环引用等）⇒ 退回 String(value) 展示，控制台输出不能因格式化而丢 */ 
    return String(value);
  }
}

function fmtConsoleArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  return safeStringify(a, undefined);
}

// ── 会话状态（exec 之间存活；reset 重建）──
let stdoutBuf = [];   // 本次 exec 的 console 输出（每次 exec 开头清空）
let images = [];      // 本次 exec 的 saveImage 产物
let currentOutDir = '';
let ctx = null;

function makeConsole() {
  const push = (...args) => { stdoutBuf.push(args.map(fmtConsoleArg).join(' ')); };
  return { log: push, info: push, warn: push, error: push, debug: push, trace: push };
}

// saveImage(名称, base64 或 dataURL) → 落盘 outDir，返回相对文件名；渲染层经 previewUrl 展示
function saveImage(name, data) {
  if (!currentOutDir) throw new Error('saveImage 只能在 exec 内调用（未指定输出目录）');
  const raw = String(data || '');
  const b64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('saveImage：base64 数据为空或非法');
  if (buf.length > IMAGE_MAX_BYTES) throw new Error(`saveImage：图片超过 ${IMAGE_MAX_BYTES / 1024 / 1024}MB 上限`);
  // 文件名消毒：只保留安全字符并强制图片扩展名（防路径穿越/防写入可执行文件）
  let base = path.basename(String(name || 'image')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'image';
  if (!/\.(png|jpe?g|svg|gif|webp)$/i.test(base)) base += '.png';
  const file = path.join(currentOutDir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${base}`);
  fs.writeFileSync(file, buf);
  const entry = { name: base, file, bytes: buf.length };
  images.push(entry);
  return base;
}

function newContext() {
  stdoutBuf = [];
  images = [];
  const sandbox = {
    console: makeConsole(),
    require,
    Buffer, // Node 全局不进 vm 上下文，需显式注入（saveImage/二进制处理常用）
    display: (v) => { stdoutBuf.push(safeStringify(v, 2)); },
    saveImage,
    // process 只暴露只读子集：代码模式不需要改宿主进程行为
    process: {
      env: { ...process.env },
      platform: process.platform,
      version: process.version,
      argv: [...process.argv],
      cwd: () => process.cwd(),
      hrtime: process.hrtime.bigint,
    },
    // 其余全局（globalThis/Math/Date/JSON/Promise/Buffer 等）由 vm.createContext 原生提供
  };
  ctx = vm.createContext(sandbox);
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

// thenable 探测：顶层写 await/返回 Promise 的代码也要能拿到值（同步预算用完后走异步等待）
function isThenable(v) {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

// 单对象入参（与 browserProcess 通道同形）：{ code, timeoutMs, outDir }
async function exec(opts = {}) {
  const timeoutMs = clampTimeout(opts.timeoutMs);
  currentOutDir = String(opts.outDir || '');
  if (currentOutDir) { try { fs.mkdirSync(currentOutDir, { recursive: true }); } catch { /* 已存在 */ } }
  stdoutBuf = [];
  images = [];
  const t0 = Date.now();
  let value;
  let error = null;
  try {
    value = vm.runInContext(String(opts.code == null ? '' : opts.code), ctx, { timeout: timeoutMs, filename: 'code_exec' });
    // 异步结果：剩余预算内等待 Promise（超时预算复用 vm timeout 的同一数值，简单可预期）
    if (isThenable(value)) {
      const remaining = Math.max(1000, timeoutMs - (Date.now() - t0));
      value = await Promise.race([
        value,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`异步执行超时（${timeoutMs}ms）`)), remaining).unref()),
      ]);
    }
  } catch (err) {
    error = `${err && err.name ? err.name : 'Error'}: ${String((err && err.message) || err)}`;
  }
  const elapsedMs = Date.now() - t0;
  let result = '';
  let truncated = false;
  if (!error) {
    if (value === undefined) { result = ''; }
    else {
      const text = typeof value === 'string' ? value : safeStringify(value, 2);
      if (text.length > RESULT_MAX_CHARS) { result = text.slice(0, RESULT_MAX_CHARS); truncated = true; }
      else result = text;
    }
  }
  return { ok: !error, error, stdout: stdoutBuf.join('\n'), result, resultTruncated: truncated, images, elapsedMs };
}

function reset() {
  newContext();
  return { ok: true };
}

function probe() {
  return { ok: true, hasContext: !!ctx };
}

const IMPL = { exec, reset, probe };
if (CODE_CHANNELS.some((name) => typeof IMPL[name] !== 'function')) {
  throw new Error('codeProcess/childEntry: 通道实现与 registry 不一致');
}

const transport = attachChildSide();

transport.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'shutdown') process.exit(0);
  if (msg.t !== 'call') return;
  const fn = IMPL[msg.name];
  if (!fn) {
    transport.send({ t: 'callRes', callId: msg.callId, ok: false, error: `未知通道：${msg.name}` });
    return;
  }
  try {
    const result = await fn(...(msg.args || []));
    transport.send({ t: 'callRes', callId: msg.callId, ok: true, result });
  } catch (err) {
    // 业务错误（未知参数/落盘失败）原样回传——宿主按调用失败处理；
    // exec 自身的代码错误走 result.ok=false（部分 stdout 仍要回传），不在此列
    transport.send({ t: 'callRes', callId: msg.callId, ok: false, error: String(err && err.message || err) });
  }
});

newContext();
transport.send({ t: 'ready' });
