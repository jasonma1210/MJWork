// T2-1：审计域（自主进程 main.js 原样搬移，行为不变）
// 审计上报：可丢失遥测。服务端不可达时熔断并静默，仅保留计数，绝不刷屏。
// 本地审计（P0-C）：无服务端令牌时落盘 userData/audit-log.jsonl（可丢失遥测，滚动上限 10MB）——
// 「本地优先」产品的最基本合规基线：纯本地场景（shell/写文件/git/MCP/审批放行）也必须留痕，
// 否则误操作或安全事件发生时无任何事后追溯材料。
//
// 依赖注入（沿用 orchestrator/memory 的 initXxx(deps) 模式）：
//   initAudit({ getAuthToken, serverBase }) —— main.js 在启动时接线；
//   authToken 归属 main.js（model:getSecrets 拉取成功后赋值），本模块只读。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const degrade = require('../degrade');

const AUDIT_BREAKER_THRESHOLD = 3;
let auditFailures = 0;
let auditBreakerUntil = 0;

const AUDIT_LOG_FILE = () => path.join(app.getPath('userData'), 'audit-log.jsonl');
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;
let auditLogBytes = -1; // 懒加载：首次写入时探测现有体积

let deps = null;
function initAudit(d) { deps = d; } // { getAuthToken: () => string, serverBase: () => string }

// ── 第八轮 L-3：审计链（把「不可改写」从口头承诺变成可核对的属性）─────────────
// 核查结论（改前）：本地审计**只有 append**（`appendFileSync`，模块不导出 update/delete），
// 写入侧确实不可改写；但**文件本身没有任何防篡改证据** —— 任何人用编辑器改一行、删一行，
// 事后完全看不出来，而「审计」的全部价值恰恰建立在「事后能证明它没被动过」上。
// 所以补一条哈希链：每行带 `seq`（单调）+ `prev`（上一行哈希）+ `hash`（本行内容 + prev）。
//   · 只加字段、不改语义：老行（无 hash）照样能读，`verifyAuditChain` 把它们记为 legacy；
//   · 写侧成本 = 一次 SHA-256（审计是低频动作，且本来就要落盘）；
//   · 滚动（10MB → .1）会让链在代际边界断开：此时 prev 重新起链，`verifyAuditChain`
//     以「每代一条独立链」判定，不把正常的滚动当成篡改。
// 明确**不做**签名/远程锚定：那需要密钥管理与服务端配合，属于产品决策（已记入第八轮台账）。
let chainPrev = null; // null = 尚未从磁盘恢复；'' = 已知为空（新文件/滚动后）
let chainSeq = 0;

/** 参与哈希的字段（写入与校验共用同一份顺序定义，避免两侧对不上）。 */
function chainBodyOf(rec) {
  return {
    ts: rec.ts,
    seq: rec.seq,
    action: rec.action,
    target: rec.target,
    detail: rec.detail,
    approval_result: rec.approval_result,
    mode: rec.mode,
  };
}

function chainHashOf(body, prev) {
  return crypto.createHash('sha256').update(prev).update('\u0000').update(JSON.stringify(body)).digest('hex');
}

/** 从磁盘恢复链尾状态（懒一次）。读不到就按「新文件」起链，绝不因此阻塞审计。 */
function ensureChain() {
  if (chainPrev !== null) return;
  chainPrev = '';
  chainSeq = 0;
  try {
    const file = AUDIT_LOG_FILE();
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec && typeof rec.hash === 'string') { chainPrev = rec.hash; chainSeq = Number(rec.seq) || 0; return; }
      } catch { /* 坏行跳过，继续往前找 */ }
    }
  } catch { /* 读不到按新文件处理 */ }
}

/**
 * 校验审计链完整性。
 * @param {string} [filePath] 缺省用当前 userData 的 audit-log.jsonl
 * @returns {{ok:boolean, lines:number, hashed:number, legacy:number, reason:string, atSeq:number|null}}
 */
function verifyAuditChain(filePath = AUDIT_LOG_FILE()) {
  const res = { ok: true, lines: 0, hashed: 0, legacy: 0, reason: '', atSeq: null, missing: false };
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    // 「没有文件」不等于「链完好」：校验器不该在**没有证据**的情况下给 ok。
    // 区分 missing（从没审计过，正常）与不可读（权限/损坏，异常）——两者都 ok:false。
    const missing = e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
    return { ...res, ok: false, missing: !!missing, reason: missing ? '文件不存在（无审计记录可校验）' : `不可读：${e.message}` };
  }
  const lines = text.split('\n').filter((l) => l.trim());
  res.lines = lines.length;
  let prevHash = '';
  let sawHashed = false;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { res.ok = false; res.reason = '存在无法解析的行（被截断或手工插入）'; return res; }
    if (typeof rec.hash !== 'string') {
      // 老版本行：只允许出现在链开始之前；链中间出现无 hash 行 = 有人插入/替换过内容
      if (sawHashed) { res.ok = false; res.reason = `seq=${rec.seq ?? '?'} 附近出现无 hash 的行`; res.atSeq = rec.seq ?? null; return res; }
      res.legacy += 1;
      continue;
    }
    sawHashed = true;
    if (String(rec.prev || '') !== prevHash) {
      res.ok = false; res.reason = `seq=${rec.seq} 的 prev 与上一行哈希不连续（中间有行被删/被换）`; res.atSeq = rec.seq;
      return res;
    }
    if (chainHashOf(chainBodyOf(rec), rec.prev) !== rec.hash) {
      res.ok = false; res.reason = `seq=${rec.seq} 内容与哈希不符（行被改写）`; res.atSeq = rec.seq;
      return res;
    }
    prevHash = rec.hash;
    res.hashed += 1;
  }
  return res;
}

function auditLocal(action, target, detail, approvalResult) {
  try {
    const file = AUDIT_LOG_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true }); // userData 理论上恒存在，防御性确保
    ensureChain();
    const body = chainBodyOf({
      ts: new Date().toISOString(),
      seq: chainSeq + 1,
      action,
      target: String(target || '').slice(0, 500),
      detail: String(detail || '').slice(0, 2000),
      approval_result: approvalResult || 'auto',
      mode: 'local',
    });
    const line = JSON.stringify({ ...body, prev: chainPrev, hash: chainHashOf(body, chainPrev) }) + '\n';
    if (auditLogBytes < 0) {
      try { auditLogBytes = fs.statSync(file).size; } catch { auditLogBytes = 0; }
    }
    if (auditLogBytes + Buffer.byteLength(line) > AUDIT_LOG_MAX_BYTES) {
      // 滚动：旧文件转 .1（只保留一代），重新计数
      try { fs.renameSync(file, `${file}.1`); } catch (e) { console.warn('[audit] 审计日志滚动失败（按新链继续）:', e?.message || e); }
      auditLogBytes = 0;
      // 滚动后旧文件整体搬走，新代从空链起（每代一条独立链；见 verifyAuditChain 注释）
      chainPrev = '';
      chainSeq = 0;
    }
    fs.appendFileSync(file, line);
    auditLogBytes += Buffer.byteLength(line);
    chainPrev = JSON.parse(line).hash;
    chainSeq = body.seq;
  } catch (e) {
    console.warn('[audit] 本地审计落盘失败:', e.message); // 审计失败绝不阻塞主流程
  }
}

function audit(action, target, detail, approvalResult) {
  // deps 未注入（initAudit 尚未调用 / 单测环境）时按「无令牌」处理：本地落盘，绝不抛。
  // 审计是「可丢失遥测」，它崩掉不该把业务调用一起带走。
  if (!deps?.getAuthToken?.()) { auditLocal(action, target, detail, approvalResult); return; } // 本地优先：无令牌时落盘留痕
  if (Date.now() < auditBreakerUntil) { auditFailures++; return; } // 熔断期内不再发起连接
  fetch(`${deps.serverBase()}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.getAuthToken()}` },
    body: JSON.stringify({
      action,
      target: String(target || '').slice(0, 500),
      detail: String(detail || '').slice(0, 2000),
      approval_result: approvalResult || 'auto',
    }),
    signal: AbortSignal.timeout(3000),
  }).then(() => {
    if (auditFailures) degrade.markHealthy('audit');
    auditFailures = 0;
    auditBreakerUntil = 0;
  }).catch((err) => {
    auditFailures++;
    const degradable = degrade.report('audit', err, { silent: true });
    if (degradable && auditFailures >= AUDIT_BREAKER_THRESHOLD) {
      auditBreakerUntil = Date.now() + 5 * 60 * 1000; // 连续失败 → 熔断 5 分钟
      console.warn(`[audit] 审计上报连续失败 ${auditFailures} 次（服务端不可达），已熔断 5 分钟`);
    }
  });
}

// verifyAuditChain：第八轮 L-3 —— 哈希链校验入口（排障/合规检查可随时调用；
// 主进程没有自动调用它：篡改检测的价值在「有人要证明时能证明」，而不是每写一行都自检一遍）。
module.exports = { initAudit, audit, auditLocal, verifyAuditChain };
