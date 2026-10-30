// T3-6：Computer Use 子进程宿主（主进程侧）——每个 cua:run 一个会话（惰性 spawn，dispose 即杀）。
// 崩溃重启策略（验收核心）：子进程退出/卡死（调用超时）→ 透明重建重试（上限 RESTART_MAX 次）；
// 原生调用全部无状态（每次独立 osascript），透明重试安全。超限后抛 cuaDegraded——
// 循环侧按既有 error 事件透出「能力降级」提示，主会话不崩（loop 对 toolHandlers 异常有 catch）。
// utilityProcess 不可用（单测 stub / 非 Electron 宿主）时 isAvailable()=false，
// main.js 回退主进程直调 computerUse（与 T3-7 降级链同纪律）。
const path = require('path');
const { attachHost } = require('../engineProcess/transport');

let utilityProcess = null;
try {
  utilityProcess = require('electron').utilityProcess || null;
} catch { /* C-001：非 Electron 宿主（单测/纯 Node）require 不到 electron，能力探测失败=无 utilityProcess，正常 */ utilityProcess = null; }

const CHILD_ENTRY = path.join(__dirname, 'childEntry.js');
// 原生执行子进程只做 osascript/screencapture 包装，512MB 堆上限足够（独立限额=验收②）
const MEM_LIMIT_MB = 512;
// osascript 对无响应目标应用可能永久挂起：超时视为失控，杀进程重建
const CALL_TIMEOUT_MS = 30000;
const RESTART_MAX = 1; // 单次调用透明重启上限（超限即降级）

let customSpawn = null;
let callTimeoutMs = CALL_TIMEOUT_MS;

function initCuaProcess(opts = {}) {
  if (typeof opts.spawnChild === 'function') customSpawn = opts.spawnChild;
  if (Number.isFinite(opts.callTimeoutMs) && opts.callTimeoutMs > 0) callTimeoutMs = opts.callTimeoutMs;
}

function isAvailable() {
  return !!customSpawn || !!utilityProcess;
}

function defaultSpawn() {
  const child = utilityProcess.fork(CHILD_ENTRY, [], {
    execArgv: [`--max-old-space-size=${MEM_LIMIT_MB}`],
    stdio: 'pipe',
  });
  if (child.stderr) child.stderr.on('data', (d) => console.warn(`[cua ${child.pid}]`, String(d).trim()));
  return child;
}

// 创建一个 CUA 执行会话（对应一次 cua:run 的生命周期）
function createSession() {
  let child = null;
  let tr = null;
  let callSeq = 0;
  const pending = new Map(); // callId -> {resolve, reject, timer}

  const failAllPending = (message) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(message), { cuaChildDead: true }));
    }
    pending.clear();
  };

  // spawn 并等 ready（ready 超时/提前退出都算启动失败，带 cuaChildDead 触发重启）
  const spawn = () => new Promise((resolve, reject) => {
    try {
      child = customSpawn ? customSpawn() : defaultSpawn();
    } catch (err) {
      reject(Object.assign(new Error(`Computer Use 子进程启动失败：${err?.message || err}`), { cuaChildDead: true }));
      return;
    }
    tr = attachHost(child);
    // 身份守卫：透明重启后旧子进程的 exit 事件可能晚于新 spawn 到达，
    // 若不校验实例归属就清空共享 tr/child，会把新进程引用误置空导致泄漏（杀不掉）
    const myTr = tr;
    let opened = false;
    const readyTimer = setTimeout(() => {
      if (opened) return;
      opened = true;
      reject(Object.assign(new Error('Computer Use 子进程未就绪（ready 超时）'), { cuaChildDead: true }));
    }, callTimeoutMs);
    tr.onMessage((m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ready') {
        if (opened) return;
        opened = true;
        clearTimeout(readyTimer);
        resolve();
        return;
      }
      if (m.t === 'callRes') {
        const p = pending.get(m.callId);
        if (!p) return;
        pending.delete(m.callId);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(Object.assign(new Error(m.error || '调用失败'), { cuaCallError: true }));
      }
    });
    tr.onExit(() => {
      clearTimeout(readyTimer);
      if (!opened) {
        opened = true;
        reject(Object.assign(new Error('Computer Use 子进程启动即退出'), { cuaChildDead: true }));
      }
      failAllPending('Computer Use 子进程已退出');
      if (tr === myTr) {
        tr = null;
        child = null;
      }
    });
  });

  const doCall = (name, args) => new Promise((resolve, reject) => {
    const callId = `c${++callSeq}`;
    const timer = setTimeout(() => {
      pending.delete(callId);
      // 挂起即失控：杀进程触发重建（exit 回调会清 pending，此处先拒绝当前调用）
      if (tr) tr.kill();
      reject(Object.assign(new Error(`Computer Use 调用超时：${name}`), { cuaChildDead: true }));
    }, callTimeoutMs);
    pending.set(callId, { resolve, reject, timer });
    tr.send({ t: 'call', callId, name, args });
  });

  async function call(name, ...args) {
    for (let attempt = 0; attempt <= RESTART_MAX; attempt++) {
      try {
        if (!tr) await spawn();
        return await doCall(name, args);
      } catch (err) {
        if (!err || !err.cuaChildDead) throw err; // 业务错误（权限/脚本）原样上抛，不重启
        dispose();
      }
    }
    throw Object.assign(
      new Error('Computer Use 子进程连续异常退出，能力降级：请检查系统权限与目标应用状态后重试'),
      { cuaDegraded: true },
    );
  }

  function dispose() {
    failAllPending('Computer Use 会话已结束');
    if (tr) {
      try { tr.send({ t: 'shutdown' }); } catch { /* 尽力而为 */ }
      tr.kill();
    }
    tr = null;
    child = null;
  }

  return { call, dispose, isLive: () => !!tr };
}

module.exports = { initCuaProcess, isAvailable, createSession, MEM_LIMIT_MB };
