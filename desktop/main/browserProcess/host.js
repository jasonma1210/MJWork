// T4-1：Browser Use 子进程宿主（主进程侧）——每个浏览器会话一个子进程（惰性 spawn）。
// 与 cuaProcess/host.js 同驻留模式，差异在重启语义（见 registry 注释）：
//   · 幂等通道（probe/navigate/screenshot/extract）：子进程崩溃/挂起 → 透明重启重试（上限 1 次）；
//   · 有副作用通道（click/fill/select）：崩溃后绝不自动重试（可能已提交表单），
//     直接抛 browserChildDead 错误，由模型决策是否重做；下次调用照常惰性重建新进程。
// 超限/不可恢复时抛 browserDegraded——工具层按 error 透出「能力降级」提示，主会话不崩。
// utilityProcess 不可用（单测 stub / 非 Electron 宿主）时 isAvailable()=false，
// browserTools 层给出明确「浏览器能力不可用」错误（不回退主进程直调：Playwright 出界是本任务目的）。
const path = require('path');
const { attachHost } = require('../engineProcess/transport');
const { RETRYABLE_CHANNELS } = require('./registry');

let utilityProcess = null;
try {
  utilityProcess = require('electron').utilityProcess || null;
} catch { /* C-001：非 Electron 宿主（单测/纯 Node）require 不到 electron，能力探测失败=无 utilityProcess，正常 */ utilityProcess = null; }

const CHILD_ENTRY = path.join(__dirname, 'childEntry.js');
// 子进程只承载 Playwright 驱动（浏览器是它再 spawn 的独立进程），512MB 堆上限足够
const MEM_LIMIT_MB = 512;
// 页面加载/选择器等待最长 30s（childEntry 内 Playwright timeout）；宿主侧留 60s 余量，
// 超时视为失控 → 杀进程重建
const CALL_TIMEOUT_MS = 60000;
const RESTART_MAX = 1; // 幂等通道单次调用透明重启上限（超限即降级）

let customSpawn = null;
let callTimeoutMs = CALL_TIMEOUT_MS;

function initBrowserProcess(opts = {}) {
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
  if (child.stderr) child.stderr.on('data', (d) => console.warn(`[browser ${child.pid}]`, String(d).trim()));
  return child;
}

// 创建一个浏览器执行会话（对应一个对话的浏览器生命周期）
function createSession() {
  let tr = null;
  let callSeq = 0;
  const pending = new Map(); // callId -> {resolve, reject, timer}

  const failAllPending = (message) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(message), { browserChildDead: true }));
    }
    pending.clear();
  };

  // spawn 并等 ready（ready 超时/提前退出都算启动失败，带 browserChildDead 触发重启）
  const spawn = () => new Promise((resolve, reject) => {
    let child;
    try {
      child = customSpawn ? customSpawn() : defaultSpawn();
    } catch (err) {
      reject(Object.assign(new Error(`Browser 子进程启动失败：${err?.message || err}`), { browserChildDead: true }));
      return;
    }
    tr = attachHost(child);
    // 身份守卫（同 cua host）：透明重启后旧子进程的 exit 可能晚于新 spawn 到达，
    // 不校验实例归属会把新进程引用误置空导致泄漏
    const myTr = tr;
    let opened = false;
    const readyTimer = setTimeout(() => {
      if (opened) return;
      opened = true;
      reject(Object.assign(new Error('Browser 子进程未就绪（ready 超时）'), { browserChildDead: true }));
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
        else p.reject(Object.assign(new Error(m.error || '调用失败'), { browserCallError: true }));
      }
    });
    tr.onExit(() => {
      clearTimeout(readyTimer);
      if (!opened) {
        opened = true;
        reject(Object.assign(new Error('Browser 子进程启动即退出'), { browserChildDead: true }));
      }
      failAllPending('Browser 子进程已退出');
      if (tr === myTr) tr = null;
    });
  });

  const doCall = (name, args) => new Promise((resolve, reject) => {
    const callId = `b${++callSeq}`;
    const timer = setTimeout(() => {
      pending.delete(callId);
      // 挂起即失控：杀进程触发重建（exit 回调会清 pending，此处先拒绝当前调用）
      if (tr) tr.kill();
      reject(Object.assign(new Error(`Browser 调用超时：${name}`), { browserChildDead: true }));
    }, callTimeoutMs);
    pending.set(callId, { resolve, reject, timer });
    tr.send({ t: 'call', callId, name, args });
  });

  async function call(name, args = {}) {
    const retryable = RETRYABLE_CHANNELS.has(name);
    const maxAttempt = retryable ? RESTART_MAX : 0;
    for (let attempt = 0; attempt <= maxAttempt; attempt++) {
      try {
        if (!tr) await spawn();
        return await doCall(name, args);
      } catch (err) {
        if (!err || !err.browserChildDead) throw err; // 业务错误（选择器/URL/浏览器缺失）原样上抛，不重启
        dispose();
        if (!retryable) {
          throw Object.assign(
            new Error(`Browser 子进程异常退出，浏览器会话已中断（${name} 未确认完成，切勿盲目重试以免重复提交）：下次操作将自动重建会话，请先 navigate 恢复页面状态`),
            { browserChildDead: true },
          );
        }
      }
    }
    throw Object.assign(
      new Error('Browser 子进程连续异常退出，浏览器能力降级：请检查系统浏览器是否可用后重试'),
      { browserDegraded: true },
    );
  }

  function dispose() {
    failAllPending('Browser 会话已结束');
    if (tr) {
      try { tr.send({ t: 'shutdown' }); } catch { /* 尽力而为 */ }
      tr.kill();
    }
    tr = null;
  }

  return { call, dispose, isLive: () => !!tr };
}

module.exports = { initBrowserProcess, isAvailable, createSession, MEM_LIMIT_MB };
