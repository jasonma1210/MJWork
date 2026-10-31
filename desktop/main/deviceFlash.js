// 刷机 / 烧盘的「参数装配 + 审批卡」纯逻辑（2026-10-31）。
//
// 为什么单独成模块、且坚持纯函数：
//   用户裁决是「全自动执行，但每一步都要确认授权 + 给出警告」。这套机制能不能站得住，
//   取决于**卡里的参数由工具算出来，而不是模型口述**——模型说「刷 /dev/disk4」而实际
//   那块盘是系统盘，就是灾难。所以：
//     · 目标盘候选由 `partitionCandidates` 从系统枚举结果里筛出，**显式排除系统卷**；
//     · 刷机命令由 `buildFlashPlan` 按芯片装配，模型只能选，不能拼；
//     · 审批卡由 `approvalCard` 统一生成，强制带上「影响面 + 失败后果 + 回滚方式」。
//   全部纯函数 ⇒ 可用固定样本回归，不依赖真机。
//
// 边界：本模块**不执行**任何命令（不 require child_process），只产出「要执行什么 + 卡上写什么」。

// 各芯片的 esptool 参数差异（只列与烧写有关的项）。
// 依据 esptool 的 chip 名：esp32 / esp32s2 / esp32s3 / esp32c3 / esp32c6 …
const CHIP_ARGS = {
  esp32: { baud: 460800, before: 'default_reset', after: 'hard_reset' },
  esp32s2: { baud: 460800, before: 'default_reset', after: 'hard_reset' },
  esp32s3: { baud: 921600, before: 'default_reset', after: 'hard_reset' },
  esp32c3: { baud: 460800, before: 'default_reset', after: 'hard_reset' },
  esp32c6: { baud: 460800, before: 'default_reset', after: 'hard_reset' },
};

const MIN_CANDIDATE_BYTES = 1 * 1024 * 1024 * 1024; // 1GB：小于这个不可能是可烧镜像的卡

/**
 * 从系统枚举出的磁盘里筛出「可安全烧写」的候选，并给出被排除的原因。
 * @param {Array<{id:string,sizeBytes:number,mediaName?:string,mountpoints?:string[],removable?:boolean,internal?:boolean}>} disks
 * @returns {{candidates:Array, rejected:Array}}
 */
function partitionCandidates(disks) {
  const list = Array.isArray(disks) ? disks : [];
  const candidates = [];
  const rejected = [];
  for (const d of list) {
    const id = String(d?.id || '').trim();
    if (!id) continue;
    const size = Number(d?.sizeBytes) || 0;
    const mps = Array.isArray(d?.mountpoints) ? d.mountpoints.map((m) => String(m)) : [];
    const label = [d?.mediaName || '未知介质', size ? `${(size / 1024 ** 3).toFixed(0)}GB` : '容量未知'].join(' · ');
    const reject = (why) => rejected.push({ id, label, why });
    // ① 系统盘一律排除：根挂载点、或挂着系统卷
    if (mps.includes('/') || mps.some((m) => m.startsWith('/System'))) { reject('系统盘（挂着根或系统卷）'); continue; }
    // ② 内置盘默认排除：烧镜像的目标应是可移动介质（外接硬盘可显式放行，见 allowInternal）
    if (d?.internal === true) { reject('内置磁盘（如需烧外接硬盘请显式允许）'); continue; }
    // ③ 太小
    if (size > 0 && size < MIN_CANDIDATE_BYTES) { reject(`容量过小（${(size / 1024 ** 2).toFixed(0)}MB）`); continue; }
    candidates.push({ id, label, sizeBytes: size, removable: d?.removable === true });
  }
  return { candidates, rejected };
}

/**
 * 装配 esptool 烧写命令（不执行）。
 * @param {object} p
 * @param {string} p.port 串口（如 /dev/cu.wchusbserial110）
 * @param {string} p.firmware 固件本地路径
 * @param {string} [p.chip] 芯片族（esp32 / esp32s3 / …），缺省按 esp32
 * @param {string} [p.offset] 烧写偏移，缺省 0x0（整包）/ 0x10000（Arduino app）
 * @returns {{ok:boolean, argv?:string[], warnings:string[], error?:string}}
 */
function buildFlashPlan({ port = '', firmware = '', chip = 'esp32', offset = '0x0' } = {}) {
  const warnings = [];
  if (!port) return { ok: false, argv: [], warnings, error: '缺少串口：请先 probe 确认接到哪个 /dev/cu.*' };
  if (!firmware) return { ok: false, argv: [], warnings, error: '缺少固件路径' };
  const base = CHIP_ARGS[String(chip).toLowerCase()];
  if (!base) {
    // 未知芯片：不猜参数，退到 esptool 默认值并明确告警
    warnings.push(`未登记芯片 \`${chip}\`：按 esptool 默认波特率/复位方式执行，若失败请改用 \`--chip\` 显式指定。`);
  }
  const argv = [
    'esptool.py', '--chip', String(chip).toLowerCase(), '--port', port,
    '--baud', String(base?.baud || 460800), '--before', base?.before || 'default_reset', '--after', base?.after || 'hard_reset',
    'write_flash', String(offset), firmware,
  ];
  // 固件不存在的检查交给调用方（本模块不碰 fs）；这里只提示风险面
  warnings.push('刷写会覆盖目标地址原有内容；中断可能导致无法启动（可重新进 bootloader 重刷，一般可恢复）。');
  return { ok: true, argv, warnings };
}

/**
 * 生成审批卡（强制三要素：影响面 / 失败后果 / 回滚方式）。
 * 缺任一项直接抛错——不允许出现「没有回滚说明的不可逆操作卡」。
 */
function approvalCard({ action = '', target = '', impact = '', consequence = '', rollback = '', reversible = false } = {}) {
  const missing = [];
  if (!action) missing.push('action');
  if (!target) missing.push('target');
  if (!impact) missing.push('impact');
  if (!consequence) missing.push('consequence');
  if (!rollback) missing.push('rollback');
  if (missing.length) throw new Error(`审批卡缺少必填项：${missing.join(', ')}（不可逆操作必须写清回滚方式）`);
  return { action, target, impact, consequence, rollback, reversible: reversible === true, level: reversible === true ? 'high' : 'never' };
}

module.exports = { CHIP_ARGS, MIN_CANDIDATE_BYTES, partitionCandidates, buildFlashPlan, approvalCard };
