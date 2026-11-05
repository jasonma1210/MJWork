// ST2：node:sqlite（Node/Electron 内建 SQLite）驱动适配层 —— 原生驱动 + 真实 WAL，且零外部 .node
//
// ── 为什么不继续用 better-sqlite3 ────────────────────────────────────────────
// 2026-10-14 真机事故：打包版 DMG 主进程启动 ~7s 即 SIGSEGV，栈落在
// node_module_register / napi_register_module_v1，崩溃前 prebuild 已加载、金丝雀探测已放行。
// 结论是「主进程内的原生模块加载无法用子进程探测兜底」，于是打包版退回 sql.js（WASM）。
// 但 sql.js 是「内存库 + 全量 export 落盘」，没有 WAL、没有增量持久化——
// 每次写入要拷贝整个内存库（历史事故：2MB 高熵文本导入被 OS 杀掉，exit 137）。
//
// node:sqlite 是把 SQLite 编进 Node/Electron **二进制本身**的内建模块：没有独立 .node 文件、
// 不做 NAPI 注册，因此那一类崩溃的根因在结构上不存在，同时拿到真实 WAL。
//
// 2026-11-05 实测矩阵（用 electron-builder 打出的 `--dir` 包，Electron 45.0.0 / Node 24.22.0 / ABI 150）：
//   node:sqlite   savepoint ✓  foreignKeys ✓  WAL ✓  reopenReadback ✓   ← 本适配层
//   better-sqlite3 不可用（ABI 127 ≠ 150）——即 dev 那条「原生更快」的分支在本机从未生效，
//                  一直在静默降级到 sql.js。这条实测已写进 doc 的驱动 ADR。
//   测试形态：在打包后的二进制上以 ELECTRON_RUN_AS_NODE 加载 asar 内的真实模块，
//   并以 isPackaged:true 调用 openDbAsync（走生产分支选择）。二进制与 ABI 与 GUI 进程一致，
//   只是不启窗口——因为宿主环境本身有沙箱，GUI 进程会先在 Chromium 沙箱初始化处失败。
//
// ── 与 sql.js 适配层的语义差异（都在这里归一，调用方无需感知）────────────────
//   ① undefined 参数：sql.js 兼容层转 null；node:sqlite **两个 Node 版本都抛**「cannot be bound」
//      —— 这是本条归一真正承重的地方（不归一，所有可选字段写入直接失败）。
//   ② **布尔参数**：sql.js 接受 true/false 并落成 0/1；node:sqlite 的行为**随 Node 版本变**——
//      Node 22.22（本仓 `npm test` 的运行时）**抛** cannot be bound，
//      Node 24.22 / Electron 45（生产运行时）**已接受**并落成 integer 1。
//      两种运行时都跑得通，才叫「同一份代码行为一致」，故仍显式转 0/1。
//      ⚠️ 方向别写反：不归一时是**单测炸、生产不炸**（旧 Node 更严格），不是「生产全炸、单测全绿」。
//      ⚠️ 由此带出一条更要紧的事实：**单测运行时 ≠ 生产运行时**（Node 22.22 vs 24.22）。
//      测试跑在更严格的一侧，所以「测试绿 ⇒ 生产绿」这个方向是安全的；反过来不成立。
//   ③ 行对象原型：node:sqlite 返回 **null 原型**对象（Electron 45 实测确认），sql.js 的 getAsObject
//      返回普通对象。不归一，`assert.deepStrictEqual(row, {...})` 会因原型不同而失败，
//      且直接 `row.hasOwnProperty` 会抛 TypeError（本仓库现有调用都写
//      `Object.prototype.hasOwnProperty.call`，是安全的，但这属于「恰好没踩到」，不该靠运气）。
//   ④ run() 返回值：node:sqlite 多给 lastInsertRowid（taskStore 已在消费），统一带上。
//
// ── 持久化语义 ───────────────────────────────────────────────────────────────
// 原生驱动每次提交即落盘，不需要防抖 export，故 flush() / suspendPersist() 都是 no-op，
// 但**必须保留**：main.js 的 will-quit 与 knowledgeBaseQuery 的批量导入会按存在性调用它们。
// close() 里显式 wal_checkpoint(TRUNCATE)：异常退出时残留的 -wal 对 sql.js 是不可见的
// （sql.js 只读主文件），一旦降级回 sql.js 就会「看不见最近写入」。干净关闭时清掉 WAL，
// 让跨驱动切换至少不会丢已提交数据。
const fs = require('fs');
const path = require('path');

// 极轻探测：sqlite 打开时不解析内容，坏库要到首次查询才抛「file is not a database」
const PROBE_SQL = 'PRAGMA schema_version';

const WAL_SUFFIXES = ['', '-wal', '-shm'];

function normalizeParams(params) {
  return (params || []).map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

const asPlainRow = (row) => (row ? { ...row } : row);

// X5 的三级处置（与 sqljsDb 同语义，但对象是文件而非内存库）：
// ①隔离坏文件（改名保留，绝不删）②用迁移前快照恢复 ③都失败才建空库。
// 每一步结果都经 `__openWarning` 上交，由状态条显式提示，不静默重建。
function recoverCorruptFile(DatabaseSync, filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const corrupt = `${filePath}.corrupt-${stamp}`;
  for (const suffix of WAL_SUFFIXES) {
    const src = filePath + suffix;
    if (!fs.existsSync(src)) continue;
    try {
      fs.renameSync(src, corrupt + suffix);
    } catch (e) {
      console.warn('[db] 坏文件隔离失败（继续尝试从快照恢复）：', e.message);
    }
  }
  console.warn(`[db] 库文件损坏，已隔离保留：${path.basename(corrupt)}`);

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let candidates = [];
  try {
    candidates = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.pre-v`) && f.endsWith('.bak'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch (e) {
    console.warn('[db] 快照目录读取失败，跳过恢复：', e.message);
  }

  for (const bak of candidates) {
    try {
      for (const suffix of WAL_SUFFIXES) {
        if (fs.existsSync(bak + suffix)) fs.copyFileSync(bak + suffix, filePath + suffix);
      }
      const db = new DatabaseSync(filePath);
      db.exec(PROBE_SQL);
      console.log(`[db] 已从迁移前快照恢复：${path.basename(bak)}`);
      return {
        db,
        warning: `本地库损坏，已从快照恢复（${path.basename(bak)}；坏文件保留为 ${path.basename(corrupt)}）`,
      };
    } catch (e) {
      console.warn(`[db] 快照恢复失败（${path.basename(bak)}）：`, e.message);
    }
  }

  return {
    db: new DatabaseSync(filePath),
    warning: `本地库损坏且无可用快照，已重建空库（坏文件保留为 ${path.basename(corrupt)}）`,
  };
}

// ── ST3 退出兜底 ──
// main.js 的 will-quit 对本驱动只调 `db.flush()`，而 node:sqlite 的 flush 是空操作；
// 真正把 WAL 并回主文件的是 close()。检索全仓：生产路径此前**没有一处**调 db.close()
// （只有 main/db/index.js 的自检脚本调）——即「干净退出」实际依赖 SQLite 在进程结束时
// 自己 checkpoint，这是隐含行为、不是契约。这里挂一次性 exit 钩子（同步、尽力而为）。
// 诚实边界：SIGKILL / 掉电捕获不到；但那种情况下 WAL 会在下次打开时重放，已提交数据不丢。
const openDbs = new Set();
let exitHookInstalled = false;
function runExitClose() {
  let closed = 0;
  for (const db of openDbs) {
    try { db.close(); closed += 1; } catch (e) {
      console.warn('[db] 退出 checkpoint 失败（数据仍在 -wal，下次打开会重放）：', e && e.message);
    }
  }
  openDbs.clear();
  return closed;
}

/**
 * 打开 node:sqlite 库，返回与 sqljsDb 同形状的句柄。
 * 加载失败（旧运行时没有该内建模块）直接抛错，由 db/index.js 决定降级——不在本层吞掉。
 */
async function openNodeSqliteDb(filePath) {  const { DatabaseSync } = require('node:sqlite');

  let sqlite;
  let openWarning = '';
  if (fs.existsSync(filePath)) {
    try {
      sqlite = new DatabaseSync(filePath);
      sqlite.exec(PROBE_SQL);
    } catch (e) {
      console.error(`[db] 既有库文件损坏：${e.message}`);
      try { sqlite?.close(); } catch { /* 已不可用，忽略 */ }
      const recovered = recoverCorruptFile(DatabaseSync, filePath);
      sqlite = recovered.db;
      openWarning = recovered.warning;
      console.error(`[db] ${openWarning}`);
    }
  } else {
    sqlite = new DatabaseSync(filePath);
  }

  // WAL：多 Worker 并发读 + 单写不阻塞（这是换掉 sql.js 的主要目的）。
  // busy_timeout：WAL 允许并发连接，但没有等待窗口时第二个写者会立刻拿到 SQLITE_BUSY。
  // 本应用当前是单连接，但备份/外部查看工具或未来的 DB host 进程都会开第二连接。
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  // synchronous=FULL：WAL 下这次提交要 fsync 日志，慢一点，但「已提交」= 「掉电后还在」。
  //
  // 为什么不写也行、还是写了：SQLite 的默认值本来就是 FULL（2），所以这一行**不改变
  // 任何现有行为**。但「默认值」不是契约——将来有人为了吞吐把它改成 NORMAL（WAL 下很常见），
  // 掉电就会丢掉最后若干已提交事务，而**所有测试照样绿**（丢数据只在进程外发生）。
  // 写死它 + 在 test/sqljsDb.test.js 断言 synchronous=2，是把隐式默认变成可回归的契约。
  sqlite.exec('PRAGMA synchronous = FULL');

  // 事务嵌套用 SAVEPOINT：sqljsDb 的 transaction 用裸 BEGIN，嵌套时会抛
  // 「cannot start a transaction within a transaction」。原生驱动没理由保留那个缺陷。
  let txDepth = 0;

  function transaction(fn) {
    return (...args) => {
      const nested = txDepth > 0;
      const sp = `mj_sp_${txDepth}`;
      sqlite.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN');
      txDepth += 1;
      try {
        const out = fn(...args);
        sqlite.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
        return out;
      } catch (e) {
        try { sqlite.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK'); } catch { /* 已回滚/连接异常 */ }
        throw e;
      } finally {
        txDepth -= 1;
      }
    };
  }

  const db = {
    // 标识符：main.js 的 will-quit 与原 sql.js 分支据此判断是否需要 flush
    __driver: 'node-sqlite',
    __openWarning: openWarning,

    // 原生驱动每次提交即落盘，无防抖窗口可挂起；保留接口是因为调用方按存在性调用
    suspendPersist() {},
    resumePersist() {},

    exec(sql) {
      sqlite.exec(sql);
    },

    prepare(sql) {
      return {
        run(...params) {
          const info = sqlite.prepare(sql).run(...normalizeParams(params));
          return {
            changes: Number(info?.changes ?? 0),
            lastInsertRowid: Number(info?.lastInsertRowid ?? 0),
          };
        },
        get(...params) {
          return asPlainRow(sqlite.prepare(sql).get(...normalizeParams(params)));
        },
        all(...params) {
          return sqlite.prepare(sql).all(...normalizeParams(params)).map(asPlainRow);
        },
      };
    },

    pragma(source, opts = {}) {
      if (/[=]/.test(source)) {
        sqlite.exec(`PRAGMA ${source}`);
        return undefined;
      }
      const row = sqlite.prepare(`PRAGMA ${source}`).get();
      const value = row ? Object.values(row)[0] : undefined;
      // 与 sqljsDb 一致：simple 与否都返回标量（调用方只取单值）
      return opts.simple ? value : value;
    },

    transaction,

    // 无落盘可做：写事务在 COMMIT 时已交给 SQLite/WAL
    flush() {},

    close() {
      openDbs.delete(db);
      try {
        // 把 WAL 并回主文件，保证之后即使降级到 sql.js（它只读主文件、不认 -wal）也能看到全部已提交数据。
        // 诚实标注：单连接**干净关闭**时 SQLite 本来就会自己 checkpoint 并删除 -wal，
        // 故这一行在常规路径上是冗余的（实测：删掉它，跨驱动读回断言照样通过 —— 等价变异）。
        // 保留它是因为「最后一个连接」这个前提在将来未必成立（DB host 进程 / 外部查看工具），
        // 显式写出来比依赖隐含行为更可靠。
        sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (e) {
        console.warn('[db] close 前 checkpoint 失败（数据仍在 -wal，下次打开会重放）：', e.message);
      }
      try { sqlite.close(); } catch { /* 幂等 */ }
    },
  };

  // 注册到退出兜底集合；exit 钩子只装一次，不随开库次数累积监听器。
  openDbs.add(db);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', runExitClose);
  }

  return db;
}

module.exports = { openNodeSqliteDb, __runExitCloseForTest: runExitClose };
