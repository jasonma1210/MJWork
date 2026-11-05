// 「库已就绪」的发布/订阅点。
//
// 为什么需要它：`LocalStore` 在 main.js 模块顶层就构造好了（那里取 `app.getPath('userData')`），
// 而 SQLite 句柄要等 `openDbAsync()` 异步完成后才有。两者顺序天然是「先 store 后 db」。
// 把它们接起来有三条路：
//   ① main.js 里加一行 `store.attachMirror(db)` —— main.js 已钉死在 1157 code 行（max-lines 棘轮），
//      加一行即红；
//   ② db 层直接 require store 层 —— 方向反了（数据库不该认识某个业务 store），且容易埋循环依赖；
//   ③ 双方各自 require 一个中立的小模块 —— 本文件。
//
// 本文件只有「谁就绪了」这一个事实，不含任何业务判断，因此不构成新的抽象层。
// 库关闭时不需要 publish(null)：进程退出路径由 LocalStore.flushSync 兜底，
// 而镜像失败本来就是 fail-open（见 localStore.flush）。
let currentDb = null;
const listeners = new Set();

function publish(db) {
  currentDb = db || null;
  for (const fn of listeners) {
    try { fn(currentDb); } catch (e) {
      // 订阅方抛错不能连累发布方（库本身是好的），但必须留痕：否则「镜像没接上」
      // 会表现成「一切正常，只是 SQLite 里悄悄是空的」。
      console.warn('[liveDb] 订阅者处理『库就绪』时抛错:', e && e.message);
    }
  }
}

// 订阅时若库已就绪，立刻回调一次——否则先建的 LocalStore 会永远等不到事件。
function subscribe(fn) {
  listeners.add(fn);
  if (currentDb) {
    try { fn(currentDb); } catch (e) {
      console.warn('[liveDb] 订阅者初始化时抛错:', e && e.message);
    }
  }
  return () => listeners.delete(fn);
}

function currentDbOrNull() { return currentDb; }

// 仅测试用：清空注册表，避免套件之间通过模块状态互相污染。
function _reset() { currentDb = null; listeners.clear(); }

module.exports = { publish, subscribe, currentDbOrNull, _reset };
