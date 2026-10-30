// 统一日志层（C-001 错误可观测性 / C-003 日志规范）。
//
// 为什么需要它：全仓 console.log×51 / console.warn×478 无统一出口——生产无法按级别静默、
// 也无从落盘检索；且部分 catch 只 return {error} 不打日志，故障不可观测。
// 本模块提供单一出口：分级（debug/info/warn/error/silent）+ 密钥脱敏 + 可选落盘。
//
// 迁移纪律（分批进行，别一把梭）：
//   · 每批只改一个模块内的 console.* / 静默 catch，改完跑 `npm test`；
//   · 高危路径（DB / MCP / 沙箱 / 审批）优先；
//   · 日志文案不要包含密钥材料（本模块兜底脱敏，但别依赖它）。
//
// 级别可用环境变量 MJCODE_LOG_LEVEL 覆盖（默认 info；设 silent 关闭 console 输出）。
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let minLevel = LEVELS[process.env.MJCODE_LOG_LEVEL] ?? LEVELS.info;
let sinkPath = null;

// 常见密钥形态兜底脱敏（sk- / ghp_ / AKIA / Bearer）。只保留前 4 字符，避免日志泄露。
// 注意：判据用非全局正则，replace 用全局正则——避免 /g 的 lastIndex 状态在 test() 间串扰。
const SECRET_TEST = /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{10,})/;
const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{10,})/g;

function redact(s) {
  const str = String(s);
  return SECRET_TEST.test(str) ? str.replace(SECRET_RE, (m) => `${m.slice(0, 4)}***`) : str;
}

function stringify(v) {
  if (typeof v === 'string') return redact(v);
  if (v instanceof Error) return redact(v.stack || v.message || String(v));
  try { return redact(JSON.stringify(v)); } catch { /* C-001：序列化失败退化成 String —— 日志层最后一道兜底，绝不能抛 */ return redact(String(v)); }
}

function emit(level, args) {
  if (LEVELS[level] < minLevel) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${args.map(stringify).join(' ')}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
  try { fn(line); } catch { /* 日志失败不得影响主流程 */ }
  if (sinkPath) { try { fs.appendFileSync(sinkPath, `${line}\n`); } catch { /* 落盘失败静默，避免递归 */ } }
}

const logger = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  redact,
  setLevel(level) { if (LEVELS[level] != null) minLevel = LEVELS[level]; },
  // 落盘：传日志文件绝对路径即启用（目录不存在会自动建）；传 null 关闭。
  setSink(filePath) {
    if (!filePath) { sinkPath = null; return; }
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); sinkPath = filePath; }
    catch (e) { /* C-001：设了 sink 却没生效 = 用户以为在落盘其实没有 */
      // 这里直接走 console（不是 emit）——emit 会连带写 sink，此时 sink 正处于不可用状态。
      console.warn('[logger] 日志落盘目录创建失败，sink 已关闭（仅保留 console 输出）:', e?.message || e);
      sinkPath = null;
    }
  },
};

module.exports = logger;
