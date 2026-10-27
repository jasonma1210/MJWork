// P1 降级驱动：sql.js（SQLite 编译为 WASM，零原生模块）的 better-sqlite3 兼容适配层
// 背景：better-sqlite3（原生 .node）在本沙箱环境的 Electron 内 SIGSEGV（v11/v13 均复现，
//       崩溃点在 new Database()，且 SIGSEGV 不可捕获）。按调整计划既定降级方案落地本适配层。
// 覆盖 API 面（仅 db/index.js 与 taskStore.js 实际用到的子集）：
//   db.exec(sql)                        多语句 DDL/PRAGMA
//   db.prepare(sql).run/get/all(...p)   参数绑定查询（undefined → null 归一）
//   db.pragma(src[, {simple:true}])     读/写 PRAGMA（WAL 在内存库上无害降级）
//   db.transaction(fn)                  BEGIN/COMMIT/ROLLBACK 包装
//   db.flush() / db.close()             持久化：写入防抖 150ms 导出落盘 + 退出强刷
const fs = require('fs');
const path = require('path');
const { writeFileDurable } = require('../data/durableWrite');

const PERSIST_DEBOUNCE_MS = 150;

// X5：库文件损坏时的处置顺序 —— ①隔离坏文件（改名保留，绝不删）②用迁移前快照恢复
// ③都失败才建空库。任何一步的结果都通过 warning 上交，由状态条显式提示，
// 而不是像原来那样「静默重建一个空库，用户以为数据自己没了」。
function recoverCorruptDb(SQL, filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const corrupt = `${filePath}.corrupt-${stamp}`;
  try {
    fs.renameSync(filePath, corrupt);
    console.warn(`[db] 库文件损坏，已隔离保留：${path.basename(corrupt)}`);
  } catch (e) {
    console.warn('[db] 坏文件隔离失败（继续尝试从快照恢复）：', e.message);
  }

  // 迁移前快照：<file>.pre-v{N}.bak（db/index.js 在升级前生成），按时间从新到旧尝试
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
      fs.copyFileSync(bak, filePath);
      const db = new SQL.Database(fs.readFileSync(filePath));
      console.log(`[db] 已从迁移前快照恢复：${path.basename(bak)}`);
      return { db, warning: `本地库损坏，已从快照恢复（${path.basename(bak)}；坏文件保留为 ${path.basename(corrupt)}）` };
    } catch (e) {
      console.warn(`[db] 快照恢复失败（${path.basename(bak)}）：`, e.message);
    }
  }

  return {
    db: new SQL.Database(),
    warning: `本地库损坏且无可用快照，已重建空库（坏文件保留为 ${path.basename(corrupt)}）`,
  };
}

async function openSqliteJsDb(filePath) {
  const initSqlJs = require('sql.js');
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });

  // 载入既有库文件（断点续跑：重启后恢复全部状态）。
  // 损坏时走「隔离 → 快照恢复 → 建空库」三级处置，并留下 openWarning 供状态条提示（X5）。
  let sqldb;
  let openWarning = '';
  if (fs.existsSync(filePath)) {
    try {
      sqldb = new SQL.Database(fs.readFileSync(filePath));
      // 关键：sql.js 构造时**不解析**内容，坏文件要到第一次查询才抛「file is not a database」。
      // 这里立刻做一次极轻的 PRAGMA 探测，把损坏暴露在这个 try 里，才能进入恢复流程。
      sqldb.exec('PRAGMA schema_version;');
    } catch (e) {
      console.error(`[db] 既有库文件损坏：${e.message}`);
      const recovered = recoverCorruptDb(SQL, filePath);
      sqldb = recovered.db;
      openWarning = recovered.warning;
      console.error(`[db] ${openWarning}`);
    }
  } else {
    sqldb = new SQL.Database();
  }

  let dirty = false;
  let timer = null;

  function flush() {
    if (!dirty) return;
    try {
      const data = Buffer.from(sqldb.export());
      // P0-持久化（2026-10-16）：原实现 writeFileSync(tmp)+renameSync 无 fsync，
      // 数据可能停留在 page cache。改走 writeFileDurable（fsync 文件 + fsync 目录）。
      const res = writeFileDurable(filePath, data);
      if (!res.ok) {
        // dirty 保持 true：下次 flush 会重试。若在此清 dirty，这次变更就永久丢了。
        console.error('[db] sql.js 落盘失败:', res.error);
        return;
      }
      dirty = false;
    } catch (e) {
      console.error('[db] sql.js 落盘异常:', e.message);
    }
  }

  function schedulePersist() {
    dirty = true;
    // 批量写入保护（2026-10-27）：`flush()` 会 `export()` **整个内存库**（全量拷贝）。
    // 知识库导入是「几千次写入」的批量场景，若每次写入都重排一次落盘，
    // 导入期间会出现反复的全库拷贝 —— 实测 2MB 高熵文本即被操作系统杀掉（exit 137）。
    // 挂起期间只置 dirty，不安排定时器；恢复时补一次即可（数据不丢：dirty 仍为 true）。
    if (suspendDepth > 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  }
  let suspendDepth = 0;

  // 一次性注册 exit 兜底：防抖窗口内进程退出也不丢数据（flush 幂等）
  process.on('exit', () => { try { flush(); } catch { /* 退出期尽力而为 */ } });

  function norm(params) {
    return (params || []).map((p) => (p === undefined ? null : p));
  }

  const db = {
    // 标识符：main.js will-quit 判断是否需要 flush
    __driver: 'sqljs',
    // 打开期的降级说明（库损坏/已重建/已从快照恢复）——由 db/index.js 转交 dbStatus
    __openWarning: openWarning,

    /**
     * 挂起/恢复落盘调度（批量写入用）。可嵌套；恢复后若仍有未落盘变更，安排一次 flush。
     * 只影响「何时落盘」，不影响任何写入语义 —— 挂起期间数据仍在内存库里可读可写。
     */
    suspendPersist() { suspendDepth += 1; },
    resumePersist() {
      suspendDepth = Math.max(0, suspendDepth - 1);
      if (suspendDepth === 0 && dirty) schedulePersist();
    },

    exec(sql) {
      sqldb.exec(sql);
      schedulePersist();
    },

    prepare(sql) {
      return {
        run(...params) {
          sqldb.run(sql, norm(params));
          const changes = sqldb.getRowsModified();
          schedulePersist();
          return { changes };
        },
        get(...params) {
          const stmt = sqldb.prepare(sql);
          try {
            stmt.bind(norm(params));
            return stmt.step() ? stmt.getAsObject() : undefined;
          } finally {
            stmt.free();
          }
        },
        all(...params) {
          const stmt = sqldb.prepare(sql);
          const rows = [];
          try {
            stmt.bind(norm(params));
            while (stmt.step()) rows.push(stmt.getAsObject());
          } finally {
            stmt.free();
          }
          return rows;
        },
      };
    },

    pragma(source, opts = {}) {
      const isSet = /[=]/.test(source);
      if (!isSet) {
        const res = sqldb.exec(`PRAGMA ${source}`);
        const v = res[0]?.values?.[0]?.[0];
        return opts.simple ? v : v;
      }
      // 写式 PRAGMA：WAL/foreign_keys 在内存实现上无害降级，user_version 真实生效
      sqldb.run(`PRAGMA ${source}`);
      schedulePersist();
      return undefined;
    },

    transaction(fn) {
      return (...args) => {
        sqldb.run('BEGIN');
        try {
          const out = fn(...args);
          sqldb.run('COMMIT');
          schedulePersist();
          return out;
        } catch (e) {
          try { sqldb.run('ROLLBACK'); } catch { /* 已回滚/连接异常 */ }
          throw e;
        }
      };
    },

    flush,
    close() {
      if (timer) clearTimeout(timer);
      flush();
      try { sqldb.close(); } catch { /* 幂等 */ }
    },
  };

  return db;
}

module.exports = { openSqliteJsDb, PERSIST_DEBOUNCE_MS };
