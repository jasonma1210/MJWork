// 期 3（2026-10-18）：sandbox_code_run 子进程入口——**一次性隔离执行**（无状态，跑完即退出）。
//
// 与 code_exec（Code Mode，持久 cell 会话、可 require 任意模块）的分工：
//   · code_exec      —— 开发者工具：持久状态、完整 Node 能力（风险由 L3/L1 审批闸把关）；
//   · sandbox_code_run —— 强沙盒：**一次一进程**、默认无文件/无网络、仅纯计算 + console。
//
// 能力边界（fail-closed）：默认注入的 require 只放行纯计算类内置模块；
//   fs / child_process / vm / worker_threads / cluster / module / os / dgram 恒拒绝；
//   net/http/https/tls/http2/dns 仅在 allowNetwork=true（治理开关）时放行；
//   allowFs=true 时额外放行 fs/fs.promises（只读语义由治理层约束，此处不做写拦截——见 nativeTools）。
// process 仅暴露只读子集（不改宿主进程行为）。
// 超时：vm 内 timeout + 宿主兜底 kill（见 nativeTools.js）。
const vm = require('vm');
const { attachChildSide } = require('../engineProcess/transport');

const SAFE_MODULES = new Set([
  'path', 'url', 'util', 'crypto', 'buffer', 'string_decoder', 'querystring',
  'events', 'assert', 'zlib', 'timers', 'stream', 'readline', 'perf_hooks',
]);
const NETWORK_MODULES = new Set(['net', 'http', 'https', 'tls', 'http2', 'dns']);
const FS_MODULES = new Set(['fs', 'fs/promises']);
const BLOCKED_ALWAYS = new Set(['child_process', 'worker_threads', 'cluster', 'vm', 'module', 'os', 'dgram', 'inspector', 'repl']);

const RESULT_MAX_CHARS = 20000;

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
  } catch { /* 这是**日志格式化器**本身：在里面再打日志会自递归；退化成 String(value) 至少保住「有个值」这条信息 */ return String(value); }
}

function fmtConsoleArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  return safeStringify(a, undefined);
}

function makeRestrictedRequire({ allowNetwork, allowFs }) {
  return (name) => {
    const n = String(name || '');
    if (BLOCKED_ALWAYS.has(n)) throw new Error(`沙盒禁止加载模块：${n}`);
    if (NETWORK_MODULES.has(n) && !allowNetwork) throw new Error(`沙盒网络已关闭：${n}（如需联网请在治理设置中开启沙盒网络）`);
    if (FS_MODULES.has(n) && !allowFs) throw new Error(`沙盒禁止文件访问：${n}（如需文件能力请使用 code_exec）`);
    if (!SAFE_MODULES.has(n) && !(NETWORK_MODULES.has(n) && allowNetwork) && !(FS_MODULES.has(n) && allowFs)) {
      throw new Error(`沙盒未放行的模块：${n}`);
    }
    return require(n);
  };
}

// 一次性执行：入参 { code, timeoutMs, allowNetwork, allowFs }
async function run(opts = {}) {
  const code = String(opts.code == null ? '' : opts.code);
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 10000, 100), 60000);
  const allowNetwork = opts.allowNetwork === true;
  const allowFs = opts.allowFs === true;
  const stdoutBuf = [];
  const push = (...args) => { stdoutBuf.push(args.map(fmtConsoleArg).join(' ')); };
  // P0-3（2026-10-28）：**不得注入宿主 realm 的对象/函数**。
  // 此前注入了宿主 Buffer 与 process.hrtime.bigint，逃逸只需一行：
  //   Buffer.constructor.constructor('return process')()   // Buffer.constructor 是宿主的 Function
  // 拿到宿主 process 后即可 process.mainModule.require('child_process')，绕过全部模块白名单。
  // 现改为：Buffer 不再注入（需要二进制就用上下文原生的 Uint8Array），hrtime 换成纯函数。
  // ⚠ 残余风险（如实标注，不粉饰）：vm **不是**安全边界（Node 官方明确声明）。只要 require
  // 白名单还放行任何模块，`require('path').join.constructor.constructor('return process')()`
  // 这类通路就依然存在（已实测）。本模块的定位因此是「防误用 + 抬高门槛」，真正的隔离边界
  // 必须由 OS 级沙箱（seatbelt/bwrap）承担，见 docs 审查报告 A-P0-3 的后续项。
  const sandbox = {
    console: { log: push, info: push, warn: push, error: push, debug: push, trace: push },
    require: makeRestrictedRequire({ allowNetwork, allowFs }),
    process: {
      platform: process.platform,
      version: process.version,
      env: {},              // 沙盒内不暴露宿主环境变量（防凭证泄漏）
      cwd: () => '/',
      hrtime: () => BigInt(Date.now()) * 1000000n, // 纯函数，不注入宿主 hrtime
    },
  };
  const ctx = vm.createContext(sandbox);
  const t0 = Date.now();
  let value;
  let error = null;
  try {
    value = vm.runInContext(code, ctx, { timeout: timeoutMs, filename: 'sandbox_code_run' });
    if (value && typeof value.then === 'function') {
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
  if (!error && value !== undefined) {
    const text = typeof value === 'string' ? value : safeStringify(value, 2);
    if (text.length > RESULT_MAX_CHARS) { result = text.slice(0, RESULT_MAX_CHARS); truncated = true; }
    else result = text;
  }
  return { ok: !error, error, stdout: stdoutBuf.join('\n'), result, resultTruncated: truncated, elapsedMs };
}

const transport = attachChildSide();
transport.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'shutdown') process.exit(0);
  if (msg.t !== 'call') return;
  if (msg.name !== 'run') {
    transport.send({ t: 'callRes', callId: msg.callId, ok: false, error: `未知通道：${msg.name}` });
    return;
  }
  try {
    const result = await run(msg.args && msg.args[0] ? msg.args[0] : {});
    transport.send({ t: 'callRes', callId: msg.callId, ok: true, result });
  } catch (err) {
    transport.send({ t: 'callRes', callId: msg.callId, ok: false, error: String((err && err.message) || err) });
  }
  // 一次性语义：回执发出后立即退出（宿主亦会 kill 兜底）
  setTimeout(() => process.exit(0), 10).unref();
});

transport.send({ t: 'ready' });
