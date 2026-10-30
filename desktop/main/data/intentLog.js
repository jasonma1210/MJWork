// main/data/intentLog.js
// 追加式意图日志：sql.js 驱动期的持久化地基（真值源）。
//
// LIFECYCLE: 'sqljs-driver-period'
// RETIRES_AT: 'C4'（node:sqlite 落地、驱动切换后退役）
//
// 定位：sql.js 是内存库 + 全量导出，自身没有持久化能力。在 C1–C3 窗口内，
//       本模块作为唯一真值源（durable truth），sql.js 内存库作为派生索引，
//       compact() 周期把内存态全量导出为快照。崩溃恢复 = 读快照 + replay 日志。
//
//       C4 切到 node:sqlite 后，SQLite 的 WAL 本身即引擎内意图日志（带原子提交
//       与崩溃恢复，比应用层实现更完整），本模块【整体退役、不留 Shim】。
//       请勿在其上建立跨 C4 的长期依赖。
//
// 遥测/审计型 JSONL（如编排决策日志）不使用本模块——那种日志不复现状态、
// 不 compact、丢一条只是少一条遥测。它应直接用 durableWrite 的 appendDurable
// 原语逐条 fsync 写入，不进 intentLogRegistry、不进 will-quit 清单。
//
// ── 设计要点 ──
//   · O(1) 追加，替代「每次全量 export()」的 O(n) 写放大
//   · T1 组提交：满 groupCommitMax 条或 groupCommitMs 到时一次 fsync（摊销 0.5ms/条）
//   · T0 appendNow：单条 writeSync + fsyncSync 后返回，失败抛错（fail-closed）
//   · replay 用单调 seq 幂等去重，可重复执行；容忍半行
//   · compact：先原子落盘快照，再清空日志（顺序不可颠倒）
//   · 字节账 writeBytes/syncedBytes：只在 writeSync 完整成功后推进，
//     杜绝"过计导致下次跳过写入"的静默丢数据
//
// ── 三个必须守住的坑（均导致静默数据丢失，见文件内注释）──
//   坑 1：appendNow 必须先 flush() 排空 T1 缓冲，否则文件内 seq 乱序会被
//         replay 的 `rec.seq <= last` 去重跳过（永久丢失且无报错）
//   坑 2：ftruncate 只允许出现在写失败路径，且 writeBytes 必须由
//         _recoverTail() 在 open 时初始化为文件大小——否则一次截断即全库归零
//   坑 3：open 时必须截掉末尾半行，否则下次 _commit 会把新 blob 接在半行后，
//         两行粘成一行导致新记录丢失（半行容忍只对"末尾半行"有效）

const fs = require('fs');
const { writeFileDurable, appendDurable, openAppend, closeFd } = require('./durableWrite');

const DEFAULT_GROUP_COMMIT_MS = 20;
const DEFAULT_GROUP_COMMIT_MAX = 10;
const DEFAULT_TAIL_WINDOW_BYTES = 65536;
const DEFAULT_MAX_BUFFER_RECORDS = 1000; // T1 缓冲上限：超出即抛错，防写不进去时内存无限增长

class IntentLog {
  /**
   * @param {string} file 日志文件路径（如 userData/mjcode-intent.jsonl）
   * @param {Object} [opts]
   * @param {number} [opts.groupCommitMs=20]      T1 组提交时间窗
   * @param {number} [opts.groupCommitMax=10]     T1 组提交条数上限
   * @param {number} [opts.tailWindowBytes=65536] open 时取 maxSeq / 判半行的尾部窗口
   * @param {number} [opts.maxBufferRecords=1000] T1 缓冲条数上限
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.groupCommitMs = opts.groupCommitMs ?? DEFAULT_GROUP_COMMIT_MS;
    this.groupCommitMax = opts.groupCommitMax ?? DEFAULT_GROUP_COMMIT_MAX;
    this.tailWindowBytes = opts.tailWindowBytes ?? DEFAULT_TAIL_WINDOW_BYTES;
    this.maxBufferRecords = opts.maxBufferRecords ?? DEFAULT_MAX_BUFFER_RECORDS;

    this.fd = null;
    this._buffer = [];
    this._commitTimer = null;
    this._residual = 0; // 本进程自上次 compact 以来追加的条数

    // seq 双计数器（实现期发现的问题，v2.0 契约里的 `this.seq + 1` 写法有 bug）：
    //   this.seq     = 已确认持久（fsync 成功）的最高 seq
    //   this._nextSeq = 下一条待分配 seq
    // 若两处都用 this.seq + 1，则连续两次 append() 在未提交前会分配到同一个 seq。
    // append() 立即分配并推进 _nextSeq（记录进缓冲，需保留其 seq）；
    // appendNow() 先算候选 seq，写入成功才推进 _nextSeq（失败不消耗，不留空洞）。
    this.seq = 0;
    this._nextSeq = 1;

    // 字节账（缺陷 3 的核心）。恒有不变量：syncedBytes <= writeBytes <= 文件实际大小
    //   writeBytes  = 已【完整】写入 OS 的字节数（writeSync 成功返回后才推进）
    //   syncedBytes = 已 fsync 的字节数
    // writeBytes 过计比不记字节账更危险：磁盘满时过计 → 下次 syncedBytes !== writeBytes
    // 跳过写入 → 直接 fsync + 清 buffer → 记录静默丢失。
    this.writeBytes = 0;
    this.syncedBytes = 0;

    this._stats = {
      appended: 0, fsyncs: 0, groupCommits: 0, bytesWritten: 0,
      shortWrites: 0, truncations: 0, tailRecoveries: 0, commitFailures: 0,
    };
  }

  // ── 生命周期 ──

  /**
   * 打开日志并恢复到最新 seq（不重放，仅定位）。
   * @returns {{ok: boolean, error?: string, maxSeq?: number, logSizeBytes?: number}}
   */
  open() {
    if (this.fd !== null) return { ok: true, maxSeq: this.seq, logSizeBytes: this.logSizeBytes() };
    this.fd = openAppend(this.file);
    if (this.fd === null) return { ok: false, error: '打开追加文件失败' };
    // ★ 顺序不可颠倒：_recoverTail 必须先做——它初始化字节账并截掉末尾半行
    this._recoverTail();
    this.seq = this._lastSeq();
    this._nextSeq = this.seq + 1;
    return { ok: true, maxSeq: this.seq, logSizeBytes: this.logSizeBytes() };
  }

  /** 幂等关闭：先尽力 flush，再关 fd。 */
  close() {
    if (this.fd === null) return;
    if (this._commitTimer) { clearTimeout(this._commitTimer); this._commitTimer = null; }
    try { this.flush(); } catch (e) { console.error('[intentLog] close 前 flush 失败:', e.message); }
    closeFd(this.fd);
    this.fd = null;
  }

  // ── 写入 ──

  /**
   * T1 追加：进缓冲，满条数或到时后一次 fsync。
   * 返回值【不代表已落盘】——durable 恒为 false，调用方不得据此做"已持久"假设。
   *
   * 组提交失败时不抛错：记录留在缓冲里等待下次重试，返回 durable:false。
   * 这是有意的分层——消息热路径不该被一次磁盘抖动打断。但缓冲超过
   * maxBufferRecords 时抛错（防磁盘持续不可写导致内存无限增长）。
   */
  append(op) {
    this._assertOpen();
    if (this._buffer.length >= this.maxBufferRecords) {
      throw new Error(`[intentLog] T1 缓冲已达上限 ${this.maxBufferRecords} 条（磁盘持续不可写？），拒绝继续堆积`);
    }
    const rec = { seq: this._nextSeq++, t: Date.now(), ...op };
    this._buffer.push(rec);
    this._stats.appended += 1;
    if (this._buffer.length >= this.groupCommitMax) {
      try { this._commit(); } catch (e) { this._onCommitFailure(e); }
    } else {
      this._scheduleCommit();
    }
    return { seq: rec.seq, durable: false };
  }

  /**
   * T0 追加：writeSync + fsyncSync 成功后返回。失败抛错（fail-closed）。
   *
   * 选抛错而非返回 {durable:false} 的理由：返回假阴性要求每个 T0 调用方都写
   * `if (!r.durable)` 分支，漏一处的后果和没有这个字段一样；抛错在调用方漏接时
   * 会向上传播到 unhandledRejection/uncaughtException，至少留痕。
   * T0 承载凭证密文与 OAuth 令牌——宁可打断也不能假装成功。
   *
   * ★ 坑 1：第一行必须 flush() 排空 T1 缓冲。否则文件内 seq 乱序，重启 replay 时
   *   先应用较大的 seq（last 被推高），再遇到较小的 seq 时 `rec.seq <= last`
   *   成立 → 被跳过 → 那条记录永久丢失且无任何报错。
   */
  appendNow(op) {
    this._assertOpen();
    this.flush(); // ★ 坑 1
    const rec = { seq: this._nextSeq, t: Date.now(), ...op };
    const line = JSON.stringify(rec);
    const res = appendDurable(this.fd, line); // L1 原语：writeSync + fsyncSync
    if (!res.ok) {
      // 失败即回滚到调用前状态：appendDurable 是"先 writeSync 再 fsyncSync"，
      // fsync 失败时字节【已经写进文件】但字节账未推进。若不截回，会同时导致：
      //   a) 文件里留下一条"上报失败"的记录，调用方重试 → 重复记录
      //   b) 字节账与文件实际大小脱节，后续某次写失败时 _truncateToWritten()
      //      会按过小的 writeBytes 截断，反而删掉这条其实已写入的记录
      // 截回 writeBytes 让文件状态与"上报失败"严格一致，调用方可安全重试。
      this._truncateToWritten();
      throw new Error(`[intentLog] T0 追加失败（已回滚，seq 未消耗）：${res.error}`);
    }
    this._nextSeq = rec.seq + 1;
    this.seq = rec.seq;
    this.writeBytes += Buffer.byteLength(line + '\n');
    this.syncedBytes = this.writeBytes;
    this._stats.fsyncs += 1;
    this._stats.appended += 1;
    this._stats.bytesWritten += Buffer.byteLength(line + '\n');
    return { seq: rec.seq, durable: true };
  }

  /**
   * 同步排空 T1 缓冲。失败抛错（调用方显式要求持久，就不该被静默满足）。
   * @returns {{records: number, durable: boolean, bytesWritten: number}}
   *   records    = 本次调用前排空的条数
   *   durable    = 调用后缓冲是否已空（will-quit 可直接断言"无挂起记录"）
   */
  flush() {
    this._assertOpen();
    const n = this._buffer.length;
    this._commit();
    return { records: n, durable: this._buffer.length === 0, bytesWritten: this._stats.bytesWritten };
  }

  _commit() {
    if (this._buffer.length === 0) return;
    if (this._commitTimer) { clearTimeout(this._commitTimer); this._commitTimer = null; }

    if (this.syncedBytes === this.writeBytes) {
      // 无未同步残留，才追加新 blob
      const blob = this._buffer.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const expected = Buffer.byteLength(blob);
      let written = 0;
      try {
        written = fs.writeSync(this.fd, blob);
      } catch (e) {
        // 写失败：截掉半写残留，避免重复行与中间半行污染
        this._truncateToWritten();
        throw e; // fail-closed：缓冲保留，调用方知晓
      }
      if (written !== expected) {
        // 缺陷 3：短写按失败处理。此时文件里已有部分字节，必须先截回再抛，
        // 否则下次重试会写出重复行。
        this._stats.shortWrites += 1;
        this._truncateToWritten();
        throw new Error(`[intentLog] 短写：期望 ${expected} 实写 ${written}，拒绝推进字节账`);
      }
      this.writeBytes += written; // ★ 必须在 writeSync 完整成功之后
      this._stats.bytesWritten += written;
    }
    // 此处两种合法状态：
    //   a) writeBytes > syncedBytes：刚写入未同步 → 只需补 fsync，不重写
    //   b) writeBytes === syncedBytes：无需再写
    fs.fsyncSync(this.fd);
    this.syncedBytes = this.writeBytes;
    const n = this._buffer.length;
    this._buffer = []; // ★ 仅 fsync 成功后清空
    this._residual += n;
    this.seq = this._nextSeq - 1;
    this._stats.groupCommits += 1;
    this._scheduleCommit();
  }

  _scheduleCommit() {
    if (this._commitTimer || this._buffer.length === 0) return;
    this._commitTimer = setTimeout(() => {
      this._commitTimer = null;
      try { this._commit(); }
      catch (e) { this._onCommitFailure(e); }
    }, this.groupCommitMs);
    // unref：不阻止进程退出（退出路径由 close/flush 兜底）
    if (typeof this._commitTimer.unref === 'function') this._commitTimer.unref();
  }

  /** 定时组提交失败：记录留缓冲等待下次写入时重试，不在此处立即重试。 */
  _onCommitFailure(e) {
    this._stats.commitFailures += 1;
    // 若磁盘持续不可写，20ms 一次重试只会加速写垃圾；下次 append() 会重新排程，
    // will-quit 的 flush() 会最后再试一次并把结果交给 registry。
    console.error('[intentLog] 组提交失败（缓冲保留，待下次写入重试）:', e.message);
  }

  /**
   * 把文件截回"已完整写入"长度，丢掉半写残留。
   * ★ 坑 2：仅在写失败路径调用。writeBytes 必须已由 _recoverTail() 初始化为
   *   文件实际大小——若为 0 而文件有历史数据，这里会把整个日志截成 0 字节。
   */
  _truncateToWritten() {
    try {
      const actual = fs.fstatSync(this.fd).size;
      if (actual > this.writeBytes) {
        fs.ftruncateSync(this.fd, this.writeBytes);
        this._stats.truncations += 1;
      }
    } catch (e) {
      console.error('[intentLog] 截断半写残留失败:', e.message);
    }
  }

  // ── 崩溃恢复 ──

  /**
   * ★ 坑 3：open 时截掉末尾半行 + 初始化字节账。
   * 这是 redo log 的标准恢复步骤，也是 writeBytes 初始化的唯一位置。
   * 若不清半行，第一次 _commit() 会把新 blob 接在半行后面，两行粘成一行 →
   * replay parse 失败 → 新记录丢失。半行容忍只对"文件末尾的半行"有效。
   */
  _recoverTail() {
    const size = fs.fstatSync(this.fd).size;
    if (size === 0) { this.writeBytes = 0; this.syncedBytes = 0; return; }
    const win = Math.min(size, this.tailWindowBytes);
    const buf = Buffer.alloc(win);
    fs.readSync(this.fd, buf, 0, win, size - win);
    const text = buf.toString('utf8');
    if (text.endsWith('\n')) {
      this.writeBytes = size;
      this.syncedBytes = size; // 完整收尾：全部视为已持久
      return;
    }
    // 不以 '\n' 结尾 ⇒ 上次崩溃写在追加中途，截到最后一个完整行
    const lastNl = text.lastIndexOf('\n');
    const keep = lastNl === -1 ? 0 : (size - win) + lastNl + 1;
    fs.ftruncateSync(this.fd, keep);
    this._stats.tailRecoveries += 1;
    this.writeBytes = keep;
    this.syncedBytes = keep;
  }

  /**
   * 取文件内最大 seq。seq 在文件内单调递增 ⇒ 末条即 maxSeq，故只需读尾部窗口，
   * 无需全文件扫描（实测：200k 条时 4ms vs 全扫描 51ms，13 倍差距）。
   */
  _lastSeq() {
    const size = fs.fstatSync(this.fd).size;
    if (size === 0) return 0;
    const win = Math.min(size, this.tailWindowBytes);
    const buf = Buffer.alloc(win);
    fs.readSync(this.fd, buf, 0, win, size - win);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    // _recoverTail 已保证末行完整；仍向前多试几条以兼容历史遗留的中间半行
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (Number.isFinite(r.seq)) return r.seq;
      } catch { /* 中间半行/历史损坏行，继续往前 */ }
    }
    return 0;
  }

  // ── 查询 ──

  /** 本进程自上次 compact 以来追加的条数（进程内计数，重启归零）。 */
  residualCount() { return this._residual; }

  /**
   * 当前日志字节数，O(1)。boot 时判断是否触发恢复性 compact 的真实依据——
   * replay 成本正比于字节数而非条数。建议阈值：> 4MB 即 compact。
   */
  logSizeBytes() { return this.fd === null ? 0 : fs.fstatSync(this.fd).size; }

  /**
   * 运行统计。方法名与内部计数器对象刻意分开命名（_stats）——
   * 若把计数器也命名为 this.stats，实例属性会遮蔽原型方法，`log.stats()` 直接
   * 报 "is not a function"（实现期实测踩到）。
   */
  stats() {
    return { ...this._stats, buffered: this._buffer.length, seq: this.seq, nextSeq: this._nextSeq,
             writeBytes: this.writeBytes, syncedBytes: this.syncedBytes };
  }

  /**
   * 重放日志。幂等：seq 不大于已应用最大值的一律跳过。
   * @param {(rec: Object) => void} apply 应用单条记录（必须可重放）
   * @param {number} [startSeq=0] 已从快照应用过的最大 seq。
   *   崩溃恢复的标准流程是「先应用快照、再 replay 日志」——若不传 startSeq，
   *   replay 会从 0 开始判定，把快照里已有的记录再应用一遍。
   * @returns {{applied: number, skipped: number, maxSeq: number}}
   */
  replay(apply, startSeq = 0) {
    if (!fs.existsSync(this.file)) return { applied: 0, skipped: 0, maxSeq: startSeq };
    const lines = fs.readFileSync(this.file, 'utf8').split('\n');
    let applied = 0;
    let skipped = 0;
    let last = startSeq;
    for (const l of lines) {
      if (!l) continue;
      let rec;
      try { rec = JSON.parse(l); } catch { /* 半行：崩溃写在追加中途——计入返回值里的 skipped，属于可观测统计而非丢弃 */ skipped++; continue; }
      if (rec.seq <= last) { skipped++; continue; }               // 幂等去重
      apply(rec);
      last = rec.seq;
      applied++;
    }
    this.seq = Math.max(this.seq, last);
    this._nextSeq = Math.max(this._nextSeq, last + 1);
    return { applied, skipped, maxSeq: last };
  }

  /**
   * 折叠：先原子落盘快照，成功后才清空日志。顺序不可颠倒——若先清日志再写快照，
   * 中间崩溃会同时失去两者。
   * @param {*} snapshotData 快照内容（通常是当前完整内存态）
   * @param {string} snapshotFile 快照落点
   */
  compact(snapshotData, snapshotFile) {
    const res = writeFileDurable(snapshotFile, JSON.stringify(snapshotData)); // ① 快照先落盘
    if (!res.ok) return { ok: false, error: res.error };                      // 快照失败 → 绝不清日志

    // 快照已原子落盘，现在可以安全清空日志
    closeFd(this.fd);
    // ② 修订点：原用 fs.writeFileSync，清空动作本身无 fsync，掉电可能回退成
    //    「日志没清成、快照又旧」。改走 writeFileDurable。
    const clr = writeFileDurable(this.file, '');
    this.seq = 0;
    this._nextSeq = 1;
    this._buffer = [];
    this._residual = 0;
    this.writeBytes = 0;
    this.syncedBytes = 0;
    this.fd = openAppend(this.file);
    // 清空失败不致命：replay 的幂等去重会自然跳过已进快照的记录
    return clr.ok ? { ok: true } : { ok: false, error: '日志清空失败（幂等重放可容忍）' };
  }

  _assertOpen() {
    if (this.fd === null) throw new Error('[intentLog] 未 open()，拒绝写入');
  }
}

module.exports = { IntentLog, DEFAULT_GROUP_COMMIT_MS, DEFAULT_GROUP_COMMIT_MAX, DEFAULT_TAIL_WINDOW_BYTES };
