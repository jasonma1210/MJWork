// 可烧磁盘目标枚举（只读）—— device_flash 选盘的**唯一**数据源（2026-10-31）。
//
// 为什么解析 `diskutil list` 的**文本**而不是 -plist：
//   · -plist 的 AllDisksAndPartitions 里没有「内置 / 外置 / 虚拟」标记。要拿它必须对每个盘
//     再跑一次 `diskutil info -plist`（N+1 次命令）；而且实测该字段对内置 SSD 返回
//     VirtualOrPhysical=Unknown，无法作为判据。
//   · 文本首行的 `/dev/disk0 (internal, physical):` 恰好就是我们要的介质分类，
//     一条命令拿全，且**不引入 plist 解析器**（本仓无该依赖，手写递归下降不值得）。
//   · 全只读：不 mount / unmount / erase / partition，纯列举。
//
// 判据是 **fail-closed**：只有 `external, physical` 才可能进入候选；不认识的类型一律按虚拟盘
// 排除。方向选择理由：把一张真实的卡漏掉，用户重插一次就能发现；把系统盘或磁盘映像列进候选，
// 用户点一次「确认」就没了。
//
// 实测（macOS 15 / M4 Pro）四种类型都会出现：internal,physical（内置 SSD）、
// external,physical（USB/SD 卡，唯一可烧）、synthesized（APFS 容器）、disk image（DMG/模拟器）。

const UNIT = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };

// 段头：`/dev/disk4 (disk image):`
const HEAD_RE = /^\/dev\/(disk\d+)\s+\(([^)]*)\):\s*$/;
// 整盘行：`   0:      GUID_partition_scheme                        *18.4 GB    disk4`
// 两处 `\s{2,}` 都不可放宽成 `\s+`：TYPE 列与 SIZE 列之间靠**多空格**对齐，放宽会把
// `Apple_APFS_ISC Container disk1` 这类含单空格的类型名连同后面的 size 一起吞进类型名。
const ROW_RE = /^\s*(\d+):\s+(.*?)\s{2,}[*+]?([\d.]+)\s+([KMGTP]?B)\s+(disk\d+(?:s\d+)*)\s*$/;

/** `*4.0` + `TB` → 字节数。diskutil 用十进制单位（4.0 TB ≈ 4002222325760），不是 2^40。 */
function parseSize(numText, unit) {
  const n = Number(numText);
  const mul = UNIT[unit];
  if (!Number.isFinite(n) || !mul) return 0;
  return Math.round(n * mul);
}

/**
 * 介质分类。返回 `{ internal, virtual, kind }`；未登记的类型按虚拟盘处理（fail-closed）。
 * @param {string} typeText 括号内的原文，如 `external, physical`
 */
function classify(typeText) {
  const t = String(typeText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (t === 'external, physical') return { internal: false, virtual: false, kind: '外接物理盘' };
  if (t === 'internal, physical') return { internal: true, virtual: false, kind: '内置物理盘' };
  if (t === 'synthesized') return { internal: false, virtual: true, kind: 'APFS 合成容器' };
  if (t === 'disk image') return { internal: false, virtual: true, kind: '磁盘映像' };
  return { internal: false, virtual: true, kind: `未知介质（${t || '类型缺失'}）` };
}

/**
 * 解析 `diskutil list` 文本 → 整盘列表（不含分区）。
 * @param {string} stdout
 * @returns {Array<{id:string, kind:string, internal:boolean, virtual:boolean, sizeBytes:number, mediaName:string, mountpoints:string[]}>}
 */
function parseDiskutilListText(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout || '').split('\n')) {
    const head = HEAD_RE.exec(line.trim());
    if (head) {
      const cls = classify(head[2]);
      cur = { id: head[1], ...cls, sizeBytes: 0, mediaName: '', mountpoints: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!line.trim()) { cur = null; continue; } // 空行 = 该盘块结束
    const row = ROW_RE.exec(line);
    if (!row) continue;
    // 只认 identifier 与段头相同的行（即索引 0 的整盘行）；`disk0s1` 那类是分区，跳过
    if (row[5] !== cur.id) continue;
    cur.sizeBytes = parseSize(row[3], row[4]);
    const sizeText = `${row[3]} ${row[4]}`;
    cur.mediaName = `${cur.kind} · ${sizeText}`;
  }
  return out;
}

/** 默认执行器：只读列举。5s 自断——盘很多时也不该拖住一轮对话。 */
function makeDefaultExec() {
  const { exec } = require('child_process');
  return (cmd) => new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve({ stdout });
    });
  });
}

/**
 * 列举本机整盘（只读）。
 * 目前只实现 darwin：linux 的 lsblk / win32 的 Get-Disk 字段与判据都不同，
 * 先明确拒绝而不是给一份「看起来能烧、其实没校验过」的列表。
 * @returns {Promise<{ok:boolean, platform:string, disks:Array, notes:string[], error?:string}>}
 */
async function listDisks({ exec, platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    return {
      ok: false, platform, disks: [],
      notes: [`磁盘枚举暂只支持 macOS（当前 ${platform}）：可在已知串口的情况下直接用 action=flash 烧固件。`],
    };
  }
  const run = typeof exec === 'function' ? exec : makeDefaultExec();
  try {
    const r = await run('diskutil list');
    return { ok: true, platform, disks: parseDiskutilListText(r?.stdout), notes: [] };
  } catch (e) {
    // C-001：枚举失败与「没有可烧盘」必须能分开——上层据此决定是「重插设备」还是「diskutil 不可用」
    return { ok: false, platform, disks: [], notes: [`diskutil list 失败：${String(e?.message || e).slice(0, 120)}`], error: 'DISKUTIL_FAILED' };
  }
}

module.exports = { UNIT, parseSize, classify, parseDiskutilListText, listDisks, makeDefaultExec };
