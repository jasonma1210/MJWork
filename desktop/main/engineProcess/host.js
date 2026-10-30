// T3-7：引擎子进程宿主（主进程侧）——每个 run 一个子进程，RPC 回调工具通道，崩溃半径隔离。
// 生产用 Electron utilityProcess（独立 Node 进程：引擎 OOM/死循环/崩溃不拖垮主进程与 UI）；
// 测试经 initEngineHost({ spawnChild }) 注入 child_process.fork，用真实子进程跑全协议。
// 可用性判定：utilityProcess 缺失（单测 electron stub / 非 Electron 宿主）时 isAvailable()=false，
// agentRunner 自动回退主进程 in-process 路径——这既是测试通道，也是生产降级链。
const path = require('path');
const { attachHost } = require('./transport');

let utilityProcess = null;
try {
  utilityProcess = require('electron').utilityProcess || null;
} catch { /* C-001：非 Electron 宿主（单测/纯 Node）require 不到 electron，能力探测失败=无 utilityProcess，正常 */ utilityProcess = null; }

const CHILD_ENTRY = path.join(__dirname, 'childEntry.js');
// 引擎内存护栏（A-09 收口）：
//   · HEAP_LIMIT_MB 只约束 **V8 堆**——`--max-old-space-size` 不会限制 ArrayBuffer / WASM /
//     原生模块等堆外内存，因此不能把「2GB」当作进程 RSS 上限；
//   · RSS 由子进程自监控（childEntry.js 的 `RSS_LIMIT_MB` 看门狗，超限主动 exit），
//     两层合起来才是「失控任务最多吃掉 RSS_LIMIT_MB」。
const HEAP_LIMIT_MB = 2048;

let customSpawn = null; // initEngineHost({ spawnChild }) 注入（测试用真实 fork）
const active = new Map(); // runId -> 宿主传输句柄（abort 转发与在役查询）

function initEngineHost(opts = {}) {
  if (typeof opts.spawnChild === 'function') customSpawn = opts.spawnChild;
}

function isAvailable() {
  return !!customSpawn || !!utilityProcess;
}

function defaultSpawn() {
  const child = utilityProcess.fork(CHILD_ENTRY, [], {
    execArgv: [`--max-old-space-size=${HEAP_LIMIT_MB}`],
    stdio: 'pipe',
  });
  // 子进程 stderr 转发主进程日志：引擎内部告警/异常可回查（不转发则彻底失联）
  if (child.stderr) child.stderr.on('data', (d) => console.warn(`[engine ${child.pid}]`, String(d).trim()));
  return child;
}

// 跑一次引擎。语义与 core.runAgent 对齐：resolve 回 finalText，异常 reject。
// opts: { toolHandlers, onEvent(cbName, argsArray), onSuspend(info) }
function runEngine(runId, params, opts = {}) {
  const { toolHandlers = {}, onEvent, onSuspend } = opts;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = customSpawn ? customSpawn(runId, params) : defaultSpawn();
    } catch (err) {
      reject(new Error(`引擎子进程启动失败：${err?.message || err}`));
      return;
    }
    const tr = attachHost(child);
    active.set(runId, tr);
    let settled = false;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      active.delete(runId);
      tr.kill(); // 用后即杀：不做常驻池，下一次运行重新 spawn（多会话互不影响的前提）
      fn(arg);
    };

    tr.onMessage((msg) => {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'ready':
          tr.send({ t: 'run', id: runId, params });
          break;
        case 'evt':
          try { onEvent?.(msg.cb, msg.args || []); }
          catch (e) { console.warn('[engineHost] 事件回调异常:', e.message); }
          break;
        case 'cbReq': {
          // 请求-响应回调（onSuspend）：主进程执行并回执；run 已收尾则不回（子进程即将退出）
          Promise.resolve()
            .then(() => (msg.cb === 'onSuspend' ? onSuspend?.(...(msg.args || [])) : undefined))
            .then((result) => { if (!settled) tr.send({ t: 'cbRes', callId: msg.callId, result: result === undefined ? false : result }); })
            .catch((e) => {
              console.warn('[engineHost] 回调执行失败:', e.message);
              if (!settled) tr.send({ t: 'cbRes', callId: msg.callId, result: false });
            });
          break;
        }
        case 'toolReq': {
          const handler = toolHandlers[msg.name];
          if (typeof handler !== 'function') {
            if (!settled) tr.send({ t: 'toolRes', callId: msg.callId, ok: false, error: `工具通道不存在：${msg.name}` });
            break;
          }
          // handler 在主进程执行：审批卡、流式 chat 直推窗口、凭证解析全部就地完成——
          // 模型 Key 与用户交互不跨越进程边界（依赖方向反转的安全收益）
          Promise.resolve()
            .then(() => handler(msg.args === null ? undefined : msg.args))
            .then((result) => { if (!settled) tr.send({ t: 'toolRes', callId: msg.callId, ok: true, result }); })
            .catch((e) => { if (!settled) tr.send({ t: 'toolRes', callId: msg.callId, ok: false, error: String(e?.message || e) }); });
          break;
        }
        case 'runDone': settle(resolve, msg.finalText || ''); break;
        case 'runError': settle(reject, new Error(msg.message || '引擎运行失败')); break;
        default: break;
      }
    });

    // 进程退出但未收尾 = 引擎崩溃/被杀：主进程与 UI 存活，reject 带 engineExited 标记，
    // 上层 agentRunner 据此保存断点并提示「可继续断点续跑」（验收①）
    tr.onExit((code) => {
      settle(reject, Object.assign(new Error(`引擎进程已退出（code=${code}），本次运行中断`), { engineExited: true }));
    });
    tr.onError((err) => {
      settle(reject, Object.assign(new Error(`引擎进程异常：${err?.message || err}`), { engineExited: true }));
    });
  });
}

// 中止指定运行：转发 {t:'abort'} 给子进程（子进程侧 AbortController 级联引擎循环；
// 主进程侧在途工具 fetch 由 agentRunner 的 controller 同步中止，两路各自收敛）
function abortEngine(runId) {
  const tr = active.get(runId);
  if (!tr) return false;
  tr.send({ t: 'abort', id: runId });
  return true;
}

module.exports = { initEngineHost, isAvailable, runEngine, abortEngine, listActiveRunIds: () => [...active.keys()], _active: active };
