// T4-7：Code Mode 子进程宿主（主进程侧）——每个对话一个代码执行会话（惰性 spawn）。
// 与 cuaProcess/browserProcess 宿主的唯一差异（registry.js 已注明）：
// 【不做透明重启】——代码会话是持久 vm 上下文，子进程死亡即状态丢失，
// 静默重建会让模型在"以为状态还在"的上下文里继续写代码，比直接失败更危险。
// 因此子进程异常（崩溃/调用超时被杀）→ 立即 dispose 并抛 codeDegraded，
// 上层（codeTools）把"会话状态已丢失"如实透出，模型可选择重跑或 restart。
// 业务级失败（代码本身报错）由子进程以 result.ok=false 回传，不走降级链。
// utilityProcess 不可用（单测 stub / 非 Electron 宿主）时 isAvailable()=false。
const path = require('path');
const { attachHost } = require('../engineProcess/transport');

let utilityProcess = null;
try {
  utilityProcess = require('electron').utilityProcess || null;
} catch { /* C-001：非 Electron 宿主（单测/纯 Node）require 不到 electron，能力探测失败=无 utilityProcess，正常 */ utilityProcess = null; }

const CHILD_ENTRY = path.join(__dirname, 'childEntry.js');
// 代码执行会话驻留用户脚本数据（数组/对象/DOM 解析结果等），1GB 堆上限
const MEM_LIMIT_MB = 1024;
// 子进程内 vm 超时上限 120s + 异步等待余量：宿主 150s 兜底（挂死即杀进程）
const CALL_TIMEOUT_MS = 150000;

let customSpawn = null;
let callTimeoutMs = CALL_TIMEOUT_MS;

function initCodeProcess(opts = {}) {
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
  if (child.stderr) child.stderr.on('data', (d) => console.warn(`[code ${child.pid}]`, String(d).trim()));
  return child;
}

// 创建一个代码执行会话（对应一个对话的 Code Mode 生命周期）
function createSession() {
  let child = null;
  let tr = null;
  let dead = false; // 子进程死亡标记：状态已丢，后续调用直接拒绝（不再 spawn 假新会话）
  let callSeq = 0;
  const pending = new Map(); // callId -> {resolve, reject, timer}

  const degradedError = (cause) => Object.assign(
    new Error(`代码执行会话异常终止（${cause}）：会话状态已丢失。可重新执行代码，或传 restart:true 开启新会话`),
    { codeDegraded: true },
  );

  const failAllPending = (cause) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(degradedError(cause));
    }
    pending.clear();
  };

  // spawn 并等 ready（ready 超时/提前退出都算启动失败——尚未有状态，可直接报错）
  const spawn = () => new Promise((resolve, reject) => {
    if (dead) { reject(degradedError('会话已失效')); return; }
    try {
      child = customSpawn ? customSpawn() : defaultSpawn();
    } catch (err) {
      reject(degradedError(`启动失败：${err && err.message || err}`));
      return;
    }
    tr = attachHost(child);
    let opened = false;
    const readyTimer = setTimeout(() => {
      if (opened) return;
      opened = true;
      reject(degradedError('未就绪（ready 超时）'));
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
        else p.reject(Object.assign(new Error(m.error || '调用失败'), { codeCallError: true }));
      }
    });
    tr.onExit(() => {
      clearTimeout(readyTimer);
      dead = true; // 无论是否已 ready，退出即状态丢失
      if (!opened) {
        opened = true;
        reject(degradedError('启动即退出'));
      }
      failAllPending('子进程已退出');
      tr = null;
      child = null;
    });
  });

  const doCall = (name, args) => new Promise((resolve, reject) => {
    const callId = `c${++callSeq}`;
    const timer = setTimeout(() => {
      pending.delete(callId);
      // 挂死即失控：杀进程（exit 回调置 dead 并清 pending），当前调用以降级拒绝
      if (tr) tr.kill();
      reject(degradedError(`调用超时：${name}`));
    }, callTimeoutMs);
    pending.set(callId, { resolve, reject, timer });
    tr.send({ t: 'call', callId, name, args });
  });

  async function call(name, ...args) {
    if (dead) throw degradedError('会话已失效');
    try {
      if (!tr) await spawn();
      return await doCall(name, args);
    } catch (err) {
      if (err && err.codeDegraded) { dispose(); } // 状态已丢：清残留句柄，等待显式 restart
      throw err;
    }
  }

  function dispose() {
    dead = true;
    failAllPending('代码执行会话已结束');
    if (tr) {
      try { tr.send({ t: 'shutdown' }); } catch { /* 尽力而为 */ }
      tr.kill();
    }
    tr = null;
    child = null;
  }

  return { call, dispose, isLive: () => !!tr && !dead, isDead: () => dead };
}

module.exports = { initCodeProcess, isAvailable, createSession, MEM_LIMIT_MB };
