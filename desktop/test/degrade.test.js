// 批次 B 回归门禁：
// 1) degrade.js —— 可降级错误静默、真错误始终报错
// 2) readFile/listDir —— 文件不存在不得 reject（否则 Electron 在主进程刷错误栈）
// 3) CWD_TOOLS —— 读写类工具必须注入项目 cwd，否则相对路径按主进程 CWD 解析必然失败
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const degrade = require('../main/degrade');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// A10 守卫辅助：括号配对（跳过字符串/模板串/注释），用于锁定函数体边界。
function matchBracket(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === quote) break; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 去除 JS 行/块注释，仅保留「生效」源码，用于判断 token 是否真正参与执行。
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ── 捕获 console 输出，验证日志级别策略 ──
function captureConsole(fn) {
  const out = { error: [], warn: [], log: [] };
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a) => out.error.push(a.join(' '));
  console.warn = (...a) => out.warn.push(a.join(' '));
  try { fn(); } finally {
    console.error = orig.error; console.warn = orig.warn; console.log = orig.log;
  }
  return out;
}

(async () => {
  // ── degrade：可降级判定 ──
  await check('ECONNREFUSED 判定为可降级', () => {
    assert.equal(degrade.isDegradable(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true);
  });

  await check('ENOTFOUND / socket hang up 判定为可降级', () => {
    assert.equal(degrade.isDegradable(new Error('getaddrinfo ENOTFOUND localhost')), true);
    assert.equal(degrade.isDegradable(new Error('socket hang up')), true);
  });

  await check('HTTP 状态异常等真错误判定为不可降级', () => {
    assert.equal(degrade.isDegradable(new Error('私有凭证拉取失败：HTTP 500')), false);
    assert.equal(degrade.isDegradable(new TypeError('x is not a function')), false);
  });

  // ── degrade：日志级别策略 ──
  await check('可降级错误只 warn 一次，后续同签名彻底静默', () => {
    degrade._reset();
    const netErr = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const out = captureConsole(() => {
      degrade.report('audit', netErr(), { silent: true });
      degrade.report('audit', netErr(), { silent: true });
      degrade.report('audit', netErr(), { silent: true });
    });
    assert.equal(out.warn.length, 0, 'silent 模式不应有任何 warn');
    assert.equal(out.error.length, 0, '可降级错误不应打 error');
    assert.equal(degrade.failureCount('audit'), 3, '失败次数仍应计数');
  });

  await check('非 silent 模式的可降级错误仅首条 warn', () => {
    degrade._reset();
    const netErr = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const out = captureConsole(() => {
      degrade.report('secrets', netErr());
      degrade.report('secrets', netErr());
      degrade.report('secrets', netErr());
    });
    assert.equal(out.warn.length, 1, `预期 1 条 warn，实际 ${out.warn.length}`);
    assert.equal(out.error.length, 0);
  });

  await check('真错误始终 console.error，不受静默策略影响', () => {
    degrade._reset();
    const out = captureConsole(() => {
      degrade.report('secrets', new Error('HTTP 500 服务器内部错误'));
      degrade.report('secrets', new Error('HTTP 500 服务器内部错误'));
    });
    assert.equal(out.error.length, 2, '真错误必须每次都报');
    assert.equal(out.warn.length, 0);
  });

  await check('markHealthy 清除跳过状态（服务端恢复后可重试）', () => {
    degrade._reset();
    degrade.report('audit', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), { silent: true });
    assert.equal(degrade.shouldSkip('audit'), true);
    degrade.markHealthy('audit');
    assert.equal(degrade.shouldSkip('audit'), false);
  });

  await check('不同 scope 的去重互不影响', () => {
    degrade._reset();
    const out = captureConsole(() => {
      degrade.report('secrets', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      degrade.report('audit', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    });
    assert.equal(out.warn.length, 2, '两个 scope 各提示一次');
    degrade._reset();
  });

  // ── CWD_TOOLS 覆盖度（真 bug 的防复发门禁）──
  const src = fs.readFileSync(path.join(__dirname, '../agent-core/index.js'), 'utf8');
  const cwdBlock = src.match(/const CWD_TOOLS = new Set\(\[([\s\S]*?)\]\)/);

  await check('CWD_TOOLS 集合声明存在', () => {
    assert.ok(cwdBlock, '未找到 CWD_TOOLS 声明');
  });

  await check('read_file 在 CWD_TOOLS 内（相对路径可解析）', () => {
    assert.match(cwdBlock[1], /'read_file'/);
  });

  await check('write_file / edit_file 在 CWD_TOOLS 内（不会写错位置）', () => {
    assert.match(cwdBlock[1], /'write_file'/);
    assert.match(cwdBlock[1], /'edit_file'/);
  });

  await check('grep / glob / list_dir 在 CWD_TOOLS 内', () => {
    for (const t of ['grep', 'glob', 'list_dir']) {
      assert.ok(cwdBlock[1].includes(`'${t}'`), `${t} 缺失`);
    }
  });

  await check('read_file schema 声明相对路径基准', () => {
    assert.match(src, /相对路径以当前项目目录为基准/);
  });

  // ── 主进程 readFile/listDir：不得裸抛 ──
  // P0-D 起实现提取为命名函数（IPC 与定时任务 Agent 通道共用同一实现），门禁改查实现函数本体
  // T2-1：工具执行层已拆出 main/tools/exec.js，断言随实现走；getSecrets 仍在 main.js
  const toolSrc = fs.readFileSync(path.join(__dirname, '../main/tools/exec.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');

  await check('tool:readFile 处理器不含裸 readFile 抛出', () => {
    const block = toolSrc.match(/async function toolReadFile\([\s\S]*?\n\}/);
    assert.ok(block, '未找到 toolReadFile 实现');
    assert.ok(block[0].includes('try {'), 'readFile 必须包 try/catch');
    assert.ok(block[0].includes('notFound'), 'ENOENT 必须走结构化返回而非 reject');
    assert.ok(block[0].includes('resolveToolPath'), 'readFile 必须做 cwd 贯通');
    assert.match(toolSrc, /ipcMain\.handle\('tool:readFile', \(_, payload\) => toolReadFile\(payload\)\)/, 'IPC 必须委托同一实现');
  });

  await check('tool:listDir 处理器不含裸 readdir 抛出', () => {
    const block = toolSrc.match(/async function toolListDir\([\s\S]*?\n\}/);
    assert.ok(block, '未找到 toolListDir 实现');
    assert.ok(block[0].includes('try {'), 'listDir 必须包 try/catch');
    assert.match(toolSrc, /ipcMain\.handle\('tool:listDir', \(_, payload\) => toolListDir\(payload\)\)/, 'IPC 必须委托同一实现');
  });

  await check('resolveToolPath 存在且以 cwd 为基准', () => {
    // 2026-10-16 resolveToolPath 自 exec.js 移入 execCwd.js（N2 执行契约模块）
    const cwdSrc = fs.readFileSync(path.join(__dirname, '../main/tools/execCwd.js'), 'utf8');
    assert.match(cwdSrc, /function resolveToolPath\(p, cwd\)/);
    assert.match(cwdSrc, /path\.resolve\(cwd \|\| process\.cwd\(\), raw\)/);
  });

  await check('audit 熔断与超时已就位', () => {
    // T2-1：审计域已拆出 main/audit/auditLog.js，熔断与超时断言改指新模块
    const auditSrc = fs.readFileSync(path.join(__dirname, '../main/audit/auditLog.js'), 'utf8');
    assert.match(auditSrc, /auditBreakerUntil/);
    assert.match(auditSrc, /AbortSignal\.timeout\(3000\)/);
  });

  await check('authToken 改为拉取成功后赋值（失败不打开审计门）', () => {
    const block = mainSrc.match(/ipcMain\.handle\('model:getSecrets'[\s\S]*?secretsInFlight = \(async \(\) => \{/);
    assert.ok(block, '未找到 model:getSecrets');
    const tail = mainSrc.slice(mainSrc.indexOf('model:getSecrets'), mainSrc.indexOf('model:getSecrets') + 2000);
    const assignIdx = tail.indexOf('authToken = token');
    const okIdx = tail.indexOf('return { ok: true, count }');
    assert.ok(assignIdx > 0 && okIdx > 0, '未找到 authToken 赋值或成功返回');
    assert.ok(assignIdx < okIdx, 'authToken 必须在成功返回之前赋值');
  });

  // ── A10 守卫：把 authToken 赋值钉在「去注释的 secretsInFlight 异步函数体」内 ──
  // 旧检查只在 2000 字符窗口内比对 token 先后，对「authToken = token 被注释/挪出函数体但仍残留在
  // 窗口」的回归是盲的（假绿）。这里括号配对锁住 secretsInFlight 异步函数体，再剥离注释，
  // 确认 authToken = token 真正作为生效代码落在函数体内、且仍在成功返回之前。
  await check('A10 守卫：secretsInFlight 函数体（去注释）内 authToken = token 在成功返回之前', () => {
    const asyncAt = mainSrc.indexOf('secretsInFlight = (async () => {');
    const bodyOpen = mainSrc.indexOf('{', asyncAt);
    const bodyClose = matchBracket(mainSrc, bodyOpen);
    assert.ok(bodyClose > bodyOpen, '未能括号配对锁定 secretsInFlight 函数体');
    const body = mainSrc.slice(bodyOpen, bodyClose + 1);
    const bodyActive = stripJsComments(body);
    const aIdx = bodyActive.indexOf('authToken = token');
    const oIdx = bodyActive.indexOf('return { ok: true, count }');
    assert.ok(aIdx > 0, '去注释函数体内未找到 authToken = token（已被注释或移除）');
    assert.ok(oIdx > 0, '去注释函数体内未找到成功返回');
    assert.ok(aIdx < oIdx, 'authToken 必须在成功返回之前赋值');
  });

  await check('getSecrets 已加 in-flight 去重', () => {
    assert.match(mainSrc, /secretsInFlight/);
  });

  // ── 死代码已移除（T2-4：.bak 残留一并清理，历史恢复走 git 而非库内备份文件）──
  await check('死代码 desktop/main.js 与 .bak 残留均已移除', () => {
    assert.equal(fs.existsSync(path.join(__dirname, '../main.js')), false);
    assert.equal(fs.existsSync(path.join(__dirname, '../main.js.deprecated.bak')), false);
  });

  fs.rmSync(path.join(os.tmpdir(), 'mjcode-degrade-unused'), { recursive: true, force: true });
  console.log(`\nPASS：${pass}/${total} 项通过`);
})();