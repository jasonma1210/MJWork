// main/data/durableWrite.js
// 持久化原子写：在「写 tmp + rename」之外补两处 fsync，对抗掉电与 OS 崩溃。
//
// 背景（审查实证）：全仓 main/ 目录检索 fsync|fdatasync —— 零命中。
// localStore.js 与 db/sqljsDb.js 此前都是 writeFileSync(tmp) + renameSync(tmp, file)，
// 数据可能长时间停留在 OS page cache，连正常退出路径都不抗掉电。
//
// 与「仅 rename」的关键差别在两处 fsync：
//   1) fsync(file) —— 数据真正落盘，而非仅进入 page cache
//   2) fsync(dir)  —— 目录项（重命名结果）落盘，否则掉电后可能回退到旧文件名
//
// 平台差异：Windows 的 Node 无法对目录句柄 fsync（NTFS 元数据日志提供部分保护），
// 显式跳过并返回 false 告知调用方，避免把「没做到」伪装成「做到了」。

const fs = require('fs');
const path = require('path');

/**
 * 对目录做 fsync（POSIX only）。
 * @returns {boolean} 是否成功执行；Windows 恒为 false
 */
function fsyncDir(dir) {
  if (process.platform === 'win32') return false;
  let fd = null;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
    return true;
  } catch (e) {
    // 目录 fsync 失败不影响数据正确性，只降低掉电保护强度；如实上报
    console.warn('[durableWrite] 目录 fsync 失败（掉电保护降级）:', e?.message || e);
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关闭失败无需处理 */ } }
  }
}

/**
 * 持久化原子写。
 * @param {string} file   目标文件路径（父目录不存在时自动创建）
 * @param {string|Buffer} data
 * @param {{mode?: number}} [_opts] 预留形参，当前实现不读取。若需设置文件权限请改用
 *   writeFileDurableWithMode（rename 后 chmod，不受 open 创建时 mode 语义影响）。
 * @returns {{ok: boolean, dirFsynced: boolean, error?: string}}
 */
function writeFileDurable(file, data, _opts = {}) {
  // tmp 带 pid：多实例/多进程并发 flush 时不会互相覆盖对方的临时文件
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd); // ① 数据落盘
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmp, file);

    const dirFsynced = fsyncDir(path.dirname(file)); // ② 目录项落盘
    return { ok: true, dirFsynced };
  } catch (e) {
    // 清理残留 tmp，避免堆积
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清理尽力而为 */ }
    return { ok: false, dirFsynced: false, error: String(e && e.message || e) };
  }
}

/**
 * 持久化原子写，并显式设置目标文件权限（如 0o600 保护加密令牌/密钥文件）。
 *
 * 与 writeFileDurable 的差别：rename 后补一次 chmod。之所以不能只靠
 * `openSync(tmp, 'w', mode)`——Node 的 mode 参数【只在文件创建时应用】，
 * 而 tmp 名带 pid，同 pid 二次写入会复用同名 tmp，此时 mode 被静默忽略，
 * 权限保护会无声丢失。rename 后 chmod 目标文件则不受此影响。
 *
 * @param {string} file
 * @param {string|Buffer} data
 * @param {number} mode 目标权限，如 0o600
 * @returns {{ok: boolean, dirFsynced: boolean, modeApplied: boolean, error?: string}}
 */
function writeFileDurableWithMode(file, data, mode) {
  const res = writeFileDurable(file, data);
  if (!res.ok) return { ...res, modeApplied: false };
  let modeApplied = false;
  try {
    fs.chmodSync(file, mode);
    modeApplied = true;
  } catch (e) {
    // Windows 上 chmod 语义受限；如实上报，不把"没做到"伪装成"做到了"
    return { ...res, modeApplied: false, error: `chmod 失败（权限未设置）：${String(e && e.message || e)}` };
  }
  return { ...res, modeApplied };
}

/**
 * 持久化追加写（意图日志用）。
 * 打开一次、每次 append 后 fsync，保证「已返回的 append」不会因崩溃丢失。
 * @param {number} fd  由 openAppend() 返回的文件描述符
 * @param {string} line 单行内容（调用方负责保证不含换行）
 * @returns {{ok: boolean, error?: string}}
 */
function appendDurable(fd, line) {
  try {
    fs.writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
    fs.fsyncSync(fd);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * 打开用于追加的文件描述符。
 *
 * 用 'a+'（O_RDWR|O_APPEND）而非 'a'（O_WRONLY|O_APPEND）：
 *   · O_APPEND 保证写入永远落在文件尾（多进程安全）
 *   · O_RDWR 允许同一 fd 上 readSync 读尾部窗口、ftruncateSync 截半写残留
 * 实测：macOS 上对 'a' 模式 fd 调 readSync 抛 EBADF——写-only fd 不可读，
 * 这是 POSIX 正确行为。intentLog 的 _recoverTail/_lastSeq/_truncateToWritten
 * 都依赖同一 fd 上的读与截断，故必须 'a+'。
 *
 * @param {string} file
 * @returns {number|null} 失败返回 null
 */
function openAppend(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return fs.openSync(file, 'a+');
  } catch (e) {
    console.error('[durable] 打开追加文件失败:', e && e.message);
    return null;
  }
}

/** 关闭追加文件描述符（幂等）。 */
function closeFd(fd) {
  if (fd === null || fd === undefined) return;
  try { fs.closeSync(fd); } catch { /* 幂等 */ }
}

module.exports = {
  writeFileDurable,
  writeFileDurableWithMode,
  appendDurable,
  openAppend,
  closeFd,
  fsyncDir,
};
