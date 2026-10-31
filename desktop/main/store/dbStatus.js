// 本地数据库状态（X4）：初始化失败不静默。
//
// 背景：`initTaskOrchestration` 的 catch 原来只 console.error 一行就把 taskStore 置空，
// 界面上毫无提示——用户只会觉得「任务编排/记忆突然不能用了」。状态需要跨模块共享
//（主进程 catch 写入、IPC 读出、编排工具拼进错误），故独立成模块——状态需要单一持有者，
// 与 main.js 的体量无关。
let unavailable = null;
// 降级但可用（库损坏后已重建/已从快照恢复）：任务编排能跑，但用户必须知道数据被动过
let warning = '';

function markUnavailable(reason) {
  unavailable = { reason: String(reason || 'unknown'), at: Date.now() };
}

function markWarning(message) {
  warning = String(message || '');
}

// 注意：markReady 只清「不可用」，不清 warning——warning 描述的是本次打开时的既成事实
function markReady() {
  unavailable = null;
}

function snapshot(tasksReady) {
  return {
    ok: !unavailable,
    reason: unavailable ? unavailable.reason : '',
    warning,
    tasksReady: !!tasksReady,
  };
}

// 编排工具不可用时的错误文案：把真实原因带出去，别让用户只看到「初始化失败」
function toolFailure() {
  return unavailable && unavailable.reason
    ? `任务编排子系统不可用（本地数据库初始化失败：${unavailable.reason}）`
    : '任务编排子系统不可用（初始化失败）';
}

function register(ipcMain, isTasksReady) {
  ipcMain.handle('db:status', () => snapshot(isTasksReady()));
}

module.exports = { markUnavailable, markWarning, markReady, snapshot, toolFailure, register };
