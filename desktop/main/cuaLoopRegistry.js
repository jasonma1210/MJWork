// 界面自动化（CUA）互斥占用表 —— 单窗口只允许一个 CUA/回放任务同时跑。
//
// 事故背景：原先这三处入口（toolComputerUse / cua:run / cua:replay）各自用
// `if (activeCuaLoop || activeReplayLoop) return 忙` 做守卫，然后**跨 await** 把 loop
// 写进模块级变量。守卫读与写入之间隔着建 HUD 窗口、建会话等异步步骤，两个请求并发进来
// 都能通过守卫 ⇒ 后到者覆盖前者的占用，`cua:stop` 停掉的是后到者，先来的循环成了孤儿
// （HUD 常驻、仍在驱动鼠标键盘）。这是真实竞态，不是静态误报。
//
// 收口办法：**占位与释放都在同步函数里完成**（claim 内部无 await），并发安全由
// 「同步读改写」保证；释放句柄带身份令牌，迟到的旧释放不会清掉新任务的占用。
// 顺带把 BUSY 文案收敛到一处（原先三份手抄）。
const BUSY = '已有进行中的界面自动化任务，请先停止';

let currentCua = null;
let currentReplay = null;

// 占用 CUA 通道；已被任何一方占用时返回 null（调用方负责回收自己已创建的资源）。
function claimCua(loop) {
  if (currentCua || currentReplay) return null;
  currentCua = loop;
  return () => { if (currentCua === loop) currentCua = null; };
}

// 占用回放通道；语义同 claimCua（录制回放与 CUA 共用一把锁）。
function claimReplay(loop) {
  if (currentCua || currentReplay) return null;
  currentReplay = loop;
  return () => { if (currentReplay === loop) currentReplay = null; };
}

function hasRunning() {
  return !!(currentCua || currentReplay);
}

// 停止当前占用者，返回被停的是哪一路（'replay' / 'cua' / null=没人跑）。
// 停 CUA 与停回放的收尾差异（是否撤审批卡）留在调用方，这里只管锁与 stop()。
function stopCurrent() {
  if (currentReplay) { currentReplay.stop(); return 'replay'; }
  if (currentCua) { currentCua.stop(); return 'cua'; }
  return null;
}

module.exports = { claimCua, claimReplay, hasRunning, stopCurrent, BUSY };
