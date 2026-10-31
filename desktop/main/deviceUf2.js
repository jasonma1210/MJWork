// UF2 写入通道（L4，2026-10-31，参考 hardware_flash_workflow.md §3「RP2040/RP2350 → UF2 拖拽」/ §6）
//
// UF2 是**最不容易变砖**的通道：bootloader 固化在芯片 ROM 里，由设备自己去写 flash，
// 主机只需把 .uf2 文件扔进它枚举出来的那个 U 盘。写一半拔线也只会重来，不会变砖。
// 正因为「看起来只是拷个文件」，这一层最容易出的事故不是刷坏，而是**拷错地方**：
//   · 把 .uf2 拷到桌面/普通 U 盘 → 什么也没发生，用户以为刷完了；
//   · 把 .uf2 当裸二进制交给 esptool → 写进 flash 的是容器字节，板子起不来；
//   · 把 .bin 改名成 .uf2 拷进去 → bootloader 直接忽略非法块，用户以为刷完了。
// 所以这里的判据全是「怎么证明我真的写对了」：
//   ① 目标卷必须是 UF2 bootloader（靠盘上有 INFO_UF2.TXT，不靠卷名猜——卷名可以改）；
//   ② 源文件必须通过 UF2 结构校验（三个魔数 + 块大小 512 + 块号连续 + 声明块数一致）；
//   ③ 目标卷必须在已知的挂载根下，且不是系统卷；
//   ④ 写完必须等到**卷消失**（设备重启是它自己宣布「写完了」的唯一信号）。
// 缺任意一条，这一层就退化成「拷了个文件」。

const { approvalCard } = require('./deviceFlash');

const UF2_BLOCK = 512;
const UF2_MAGIC0 = 0x0a324655; // "UF2\n"
const UF2_MAGIC1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0fe47c6b;
const UF2_PAYLOAD_MAX = 476;
const UF2_FLAG_FAMILY_ID = 0x00002000;
// RP2040 / nRF52 / Mbed 的 bootloader 盘根目录都会放这个说明文件。
// 用它当判据而不是卷名（RPI-RP2 之类）：卷名可以被随便改，这个文件是 bootloader 自己写的。
const UF2_VOLUME_MARKER = 'INFO_UF2.TXT';

/**
 * 校验 UF2 文件结构（纯函数，输入 Buffer）。
 *
 * 为什么值得逐块校验而不是只看文件头：截断的文件（写入中途被中断）与「改名成 .uf2 的 .bin」
 * 都能通过「头 3 个魔数」这一关，但过不了块号连续性/块数一致性。
 * 提前拒绝 > 让 bootloader 静默忽略 > 用户以为刷成功。
 *
 * @param {Buffer} buf
 * @returns {{ok: boolean, error?: string, blocks?: number, payloadBytes?: number, fileSize?: number, addressRange?: {min:number,max:number}, familyId?: number|null}}
 */
function parseUf2(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!b.length) return { ok: false, error: '文件是空的（0 字节）' };
  if (b.length % UF2_BLOCK !== 0) {
    return { ok: false, error: `文件长度 ${b.length} 不是 512 的整数倍：不是完整的 UF2（可能被截断，或根本不是 UF2）` };
  }
  const total = b.length / UF2_BLOCK;
  let payloadBytes = 0;
  let declared = null;
  let familyId = null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < total; i += 1) {
    const off = i * UF2_BLOCK;
    const m0 = b.readUInt32LE(off);
    const m1 = b.readUInt32LE(off + 4);
    const mEnd = b.readUInt32LE(off + UF2_BLOCK - 4);
    if (m0 !== UF2_MAGIC0 || m1 !== UF2_MAGIC1 || mEnd !== UF2_MAGIC_END) {
      return { ok: false, error: `第 ${i + 1} 块的 UF2 魔数不对：这不是 UF2 文件（或已损坏）。若这是 .bin，请改回 .bin 扩展名` };
    }
    const flags = b.readUInt32LE(off + 8);
    const targetAddr = b.readUInt32LE(off + 12);
    const payloadSize = b.readUInt32LE(off + 16);
    const blockNo = b.readUInt32LE(off + 20);
    const numBlocks = b.readUInt32LE(off + 24);
    if (payloadSize > UF2_PAYLOAD_MAX) {
      return { ok: false, error: `第 ${i + 1} 块声明 payloadSize=${payloadSize}，超过 UF2 上限 ${UF2_PAYLOAD_MAX}` };
    }
    // 块号必须与物理顺序一致：工具链按 blockNo 拼装，乱序/跳号意味着文件拼不回来
    if (blockNo !== i) {
      return { ok: false, error: `第 ${i + 1} 块的 blockNo=${blockNo}，与位置不符：文件块顺序被破坏` };
    }
    if (declared === null) declared = numBlocks;
    else if (declared !== numBlocks) {
      return { ok: false, error: `块数声明前后不一致（${declared} vs ${numBlocks}，第 ${i + 1} 块）：文件已损坏` };
    }
    payloadBytes += payloadSize;
    min = Math.min(min, targetAddr);
    max = Math.max(max, targetAddr + payloadSize);
    // 偏移 28 的含义随 flag 变：带 familyID 标志时它是 familyID，否则是文件总字节数
    if (i === 0 && (flags & UF2_FLAG_FAMILY_ID)) familyId = b.readUInt32LE(off + 28);
  }
  if (declared !== total) {
    // 这条是「截断」的最后一道闸：声明 N 块但文件里只有 M 块
    return { ok: false, error: `文件声明 ${declared} 块，实际只有 ${total} 块：文件被截断` };
  }
  if (payloadBytes === 0) return { ok: false, error: 'UF2 里没有任何 payload（空镜像）' };
  return {
    ok: true, blocks: total, payloadBytes, fileSize: b.length,
    addressRange: { min, max }, familyId,
  };
}

/**
 * 判定一个挂载点是不是 UF2 bootloader 盘（纯函数）。
 * @param {{path: string, files?: string[], isRoot?: boolean}} v files = 卷根目录的文件名列表
 */
function isUf2Volume(v) {
  if (!v || !v.path) return false;
  if (v.isRoot === true) return false; // 系统卷绝不可能是 bootloader 盘
  return Array.isArray(v.files) && v.files.includes(UF2_VOLUME_MARKER);
}

/**
 * 从挂载点列表里挑出唯一的 UF2 目标盘。
 * 多块同时插着时**不猜**：让人指定 volume——挑错就是把 A 的固件写进 B。
 * @returns {{ok: boolean, volume?: string, candidates: string[], error?: string}}
 */
function pickUf2Volume(volumes) {
  const list = Array.isArray(volumes) ? volumes : [];
  const hits = list.filter(isUf2Volume);
  const candidates = hits.map((v) => v.path);
  if (!hits.length) {
    const seen = list.map((v) => v.path).filter(Boolean);
    return {
      ok: false, candidates,
      error: `没找到 UF2 bootloader 盘（当前挂载：${seen.join(' ') || '无'}）。`
        + `判据是卷根有 ${UF2_VOLUME_MARKER}：请让板子进入 BOOTSEL 模式（按住 BOOTSEL 再上电/复位），`
        + '出现 RPI-RP2 之类卷标后重试。',
    };
  }
  if (hits.length > 1) {
    return { ok: false, candidates, error: `同时有 ${hits.length} 个 UF2 盘（${candidates.join(' ')}）：请显式指定 volume，避免把固件写进另一块板` };
  }
  return { ok: true, volume: hits[0].path, candidates };
}

/** UF2 计划的摘要：覆盖「烧什么、写到哪、多大」，不含时间戳等易变量。 */
function uf2PlanDigest({ firmware = '', volume = '', fileSize = 0 } = {}) {
  // 与 deviceFlash.planDigest 分开算：两条通道的参数集不同，混用会让「换了通道」也能复用旧摘要
  const payload = JSON.stringify(['uf2-copy', String(volume), String(firmware), Number(fileSize) || 0]);
  return require('crypto').createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/**
 * 装配 UF2 烧写计划（不执行）。
 * @param {object} p
 * @param {string} p.firmware 源 .uf2 路径
 * @param {string} p.volume 目标卷（如 /Volumes/RPI-RP2）
 * @param {number} p.fileSize 源文件字节数
 * @param {object} [p.parsed] parseUf2 的结果（有则复述块数/载荷）
 * @returns {{ok: boolean, error?: string, digest?: string, card?: object, warnings: string[], next?: string}}
 */
function buildUf2Plan({ firmware = '', volume = '', fileSize = 0, parsed = null, card = null } = {}) {
  const warnings = [];
  const fw = String(firmware || '');
  const vol = String(volume || '');
  if (!fw) return { ok: false, error: '缺少固件路径', warnings };
  if (!vol) return { ok: false, error: '缺少目标卷（如 /Volumes/RPI-RP2）', warnings };
  if (!/\.uf2$/i.test(fw)) {
    // 用 esptoolFormatCheck 之外的独立判据：这里反过来，只有 .uf2 才该走这条通道
    return { ok: false, error: `不是 UF2 文件（${fw}）：UF2 通道只接受 .uf2。裸 .bin 要走串口通道（esptool）`, warnings };
  }
  if (!(Number(fileSize) > 0)) return { ok: false, error: '源文件为空或大小未知：拒绝写入', warnings };
  if (parsed && parsed.ok === false) return { ok: false, error: parsed.error, warnings };
  if (parsed && parsed.blocks) warnings.push(`已校验：${parsed.blocks} 块 / 有效载荷 ${parsed.payloadBytes} 字节，结构合法`);
  const digest = uf2PlanDigest({ firmware: fw, volume: vol, fileSize });
  return {
    ok: true,
    digest,
    warnings,
    // 复用 deviceFlash 的 approvalCard 而不是手搓对象：那张卡有五要素必填与
    // level 推导（reversible=false ⇒ never 档），自己拼一份迟早少一个字段而没人发现。
    card: card || approvalCard({
      action: '把 UF2 固件写入 bootloader 盘',
      target: `${vol} ← ${fw.split('/').pop()}`,
      impact: `覆盖设备 flash 的对应区间（写入 ${(fileSize / 1024).toFixed(1)}KB）`,
      consequence: '写入过程中设备会被 bootloader 重启；拔线会导致本次写入不完整（不砖，可重进 BOOTSEL 重来）',
      rollback: `重新让设备进入 BOOTSEL（出现 ${vol} 后）再拷一次原固件`,
      reversible: false,
    }),
    next: `请把目标卷与文件给人类确认；确认后调用 action=flash 并回传 plan_digest="${digest}"。`
      + '写完后设备会自动重启并卸载该卷——卷消失才算完成。',
  };
}

module.exports = {
  UF2_BLOCK, UF2_MAGIC0, UF2_MAGIC1, UF2_MAGIC_END, UF2_PAYLOAD_MAX, UF2_VOLUME_MARKER,
  parseUf2, isUf2Volume, pickUf2Volume, uf2PlanDigest, buildUf2Plan,
};
