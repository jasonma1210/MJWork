// 定时任务存储：原子写 + 上一完好版本备份 + 损坏自救（纯 IO 决策，不含调度逻辑）
//
// 为什么单独成模块：调度器 830+ 行顶破 800 软档（test/max-lines.test.js），而「怎么把任务
// 安全地写进磁盘 / 写坏了怎么救回来」与「什么时候该跑」是两个正交问题——前者是数据韧性，
// 后者是调度语义。拆开后本模块可以脱离 electron 调度栈单测（只依赖 fs）。
//
// 事故史（2026-10-18，用户报「我创建的定时任务不显示了」）：
//   磁盘现场 = 主文件 31 字节 {"tasks":[],"runs":[]} + .bak 2851 字节（1 任务 + 2 条运行），
//   两者 mtime 相同。根因不在本模块的写入顺序，而在调用方：
//   第二实例抢锁失败 → app.quit() → 顶层注册的 will-quit 照样执行 → scheduler.persist()
//   把模块初始化值（空 store）写了进去；write() 又「先备份再写」，于是呈现为「空主文件 +
//   完好备份」，下次启动读到的是**合法 JSON 空库**，连损坏告警都不会有。
//   修复分两层：① 调用方未加载完成时禁止写盘（scheduler.persist 的 storeLoaded 守卫）
//              ② 本模块在「主文件合法但为空、且非用户主动清空」时给出可恢复快照（不自动还原）
const fs = require('fs');
const { writeFileDurable } = require('./data/durableWrite');

function empty() { return { tasks: [], runs: [] }; }
const corruptCopyPath = (file) => `${file}.corrupt-${Date.now()}`;

/**
 * 可选列的归一（fail-closed）：`team_id` / `thread_id` 必须是字符串或 null。
 * 非字符串（对象/数组/数字/空串）一律落 null —— 定时任务是**无人值守执行面**，
 * 脏值会让「这次到底跑哪支军团 / 回写哪个会话」变得不可预期。
 */
function optStr(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, 128) : null;
}

/** 任务对象归一：只碰新增的两条可选列，其余字段原样保留（不猜、不改写）。 */
function normalizeTask(t) {
  if (!t || typeof t !== 'object') return t;
  if (!('team_id' in t) && !('thread_id' in t)) return t;
  return { ...t, team_id: optStr(t.team_id), thread_id: optStr(t.thread_id) };
}

// 读一个文件为 store 形状；不存在/损坏/结构非法一律返回 null（不抛、不猜）
function parse(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !Array.isArray(j.tasks)) return null;
    return {
      tasks: j.tasks.map(normalizeTask),
      runs: Array.isArray(j.runs) ? j.runs : [],
      cleared_at: typeof j.cleared_at === 'string' ? j.cleared_at : '',
    };
  } catch {
    return null;
  }
}

/**
 * 读盘并给出「该用哪份数据」的决策。**不写盘**，是否回写由调用方决定。
 *
 * reason 取值（调用方据此打日志/决定是否回写）：
 *   first-run            首次启动，无文件
 *   ok                   主文件可用
 *   empty-main           主文件合法但为空，且不是用户主动清空 → recoverable（不自动还原，
 *                        否则会把「用户删掉最后一条任务」这个操作悄悄撤销掉）
 *   corrupt-restored     主文件损坏，已从 .bak 取回 → needsRewrite=true（调用方应立即回写）
 *   corrupt-unrecoverable 主文件损坏且无备份 → 保留副本，以空库开工（并显著告警）
 *
 * @param {string} file 主文件绝对路径
 * @returns {{store: {tasks: Array, runs: Array}, recoverable: null|{tasks:number,runs:number,from:string}, needsRewrite: boolean, reason: string, corruptCopy?: string}}
 */
function read(file) {
  const bak = `${file}.bak`;
  if (!fs.existsSync(file)) {
    return { store: empty(), recoverable: null, needsRewrite: false, reason: 'first-run' };
  }

  const main = parse(file);
  if (main) {
    const store = { tasks: main.tasks, runs: main.runs };
    if (main.cleared_at) store.cleared_at = main.cleared_at;
    if (main.tasks.length === 0 && !main.cleared_at) {
      const snap = parse(bak);
      if (snap && snap.tasks.length > 0) {
        return {
          store,
          recoverable: { tasks: snap.tasks.length, runs: snap.runs.length, from: 'bak' },
          needsRewrite: false,
          reason: 'empty-main',
        };
      }
    }
    return { store, recoverable: null, needsRewrite: false, reason: 'ok' };
  }

  const snap = parse(bak);
  if (snap && snap.tasks.length > 0) {
    try { fs.copyFileSync(file, corruptCopyPath(file)); } catch { /* 保留坏文件尽力而为 */ }
    return {
      store: { tasks: snap.tasks, runs: snap.runs },
      recoverable: { tasks: snap.tasks.length, runs: snap.runs.length, from: 'bak-restored' },
      needsRewrite: true,
      reason: 'corrupt-restored',
    };
  }

  let kept = '';
  try { kept = corruptCopyPath(file); fs.copyFileSync(file, kept); } catch { kept = ''; }
  return { store: empty(), recoverable: null, needsRewrite: false, reason: 'corrupt-unrecoverable', corruptCopy: kept };
}

/**
 * 写盘：先把当前文件复制成 .bak（上一完好版本），再原子写。
 * ⚠️ 正因为「先备份再写」，一次错误的空写会同时污染主文件**和**备份——调用方必须先确认
 * 内存 store 真的是从磁盘加载来的（见 scheduler.persist 的 storeLoaded 守卫）。
 * @returns {{ok: boolean, dirFsynced?: boolean, error?: string}}
 */
function write(file, store) {
  try {
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, `${file}.bak`); } catch { /* 备份失败不阻断主写入 */ }
    }
    const res = writeFileDurable(file, JSON.stringify(store, null, 2));
    if (!res.ok) console.error('[scheduled] 持久化失败:', res.error);
    return res;
  } catch (e) {
    console.error('[scheduled] 持久化异常:', e.message);
    return { ok: false, dirFsynced: false, error: String(e && e.message || e) };
  }
}

/**
 * 从 .bak 取回快照。覆盖前把当前文件另存一份（`.before-restore-*`），让恢复本身可反悔。
 * @returns {{ok: boolean, error?: string, store?: object, tasks?: number, runs?: number}}
 */
function restoreFromBackup(file) {
  const snap = parse(`${file}.bak`);
  if (!snap || snap.tasks.length === 0) return { ok: false, error: '备份里没有可恢复的任务' };
  try { fs.copyFileSync(file, `${file}.before-restore-${Date.now()}`); } catch { /* 反悔副本尽力而为 */ }
  return { ok: true, store: { tasks: snap.tasks, runs: snap.runs }, tasks: snap.tasks.length, runs: snap.runs.length };
}

module.exports = { parse, read, write, restoreFromBackup, normalizeTask, optStr };
