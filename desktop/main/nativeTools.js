// 期 3（2026-10-18）：原生内置工具层——本地系统能力一律原生实现，不经 MCP 连接器。
//
// 落地五个工具（对齐 agent-core 工具名）：
//   · clipboard        —— 系统剪贴板读/写（读只读；写 L2）
//   · notify           —— 系统通知（L2）
//   · http_request     —— 全方法 HTTP 客户端（GET/HEAD 只读；其余方法 L3，且沿用 webTools 的 SSRF 单一实现）
//   · sqlite           —— SQLite 读写（复用 sql.js 驱动；query 只读，exec 写 L2，受 fsMode 只读档约束）
//   · sandbox_code_run —— 强沙盒一次性代码执行（独立子进程 + vm 受限上下文；默认无文件/无网络，网络由治理开关放行）
//
// 架构红线（见 project_memory）：
//   · 默认自启能力只能是「原生工具 + 少量无密钥 MCP」——这五个工具即原生工具的实现载体；
//   · 代码执行必须独立沙盒，禁止复用宿主机进程——sandbox_code_run 走独立 utilityProcess 子进程；
//   · Web Fetch 与 Web Search 已拆分为独立能力，http_request 是额外的「全方法」通道，默认按需审批。
//
// 依赖注入 initNativeTools：{ requestApproval, applyApprovalDecision, getAlwaysRules,
//                              conversationRules, getGovernance, userDataDir }
//
// Electron 能力按需解析（不在模块顶层 require 硬绑定）：非 Electron 宿主（单测）下
// 各能力置 null，调用时返回明确不可用错误——本模块因此可在 Node 里被真实单测。
let electron = null;
try { electron = require('electron'); } catch { electron = null; }
const clipboard = electron?.clipboard || null;
const Notification = electron?.Notification || null;
const utilityProcess = electron?.utilityProcess || null;

const path = require('path');
const { audit } = require('./audit/auditLog');
const approval = require('./approval');
const writeGuard = require('./writeGuard');
const { isPrivateHost } = require('./webTools');
const { guardedLookup } = require('./ssrfGuard');
const { openSqliteJsDb } = require('./db/sqljsDb');

let deps = null;
const sqliteDbs = new Map();        // resolvedPath -> { path, db, promise }
const SANDBOX_CHILD = path.join(__dirname, 'nativeSandbox', 'childEntry.js');
const SANDBOX_MEM_LIMIT_MB = 256;   // 沙盒堆上限（一次性任务，无需持久大状态）
const SANDBOX_KILL_MS = 70000;      // 宿主兜底 kill（vm 内 timeout 上限 60s + 余量）

function initNativeTools(d) {
  deps = d;
}

// ── 审批闸（与 codeTools.gateApproval 同形）：分级/摘要/目标/可补偿性统一由 approval.js 单一事实来源 ──
async function gateApproval(toolKey, args) {
  const { approvalMode = 'on-request', conversationId } = args || {};
  const verdict = approval.needsApproval({
    tool: toolKey, args: args || {}, approvalMode, conversationId,
    alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules,
  });
  if (verdict.need) {
    const decision = await deps.requestApproval(toolKey, args || {});
    if (decision === 'deny') {
      audit(toolKey, summarize(toolKey, args), '用户拒绝', 'denied');
      return { ok: false, error: '用户拒绝执行', denied: true };
    }
    deps.applyApprovalDecision(decision, toolKey, args || {}, conversationId);
  }
  return { allowed: true, asked: !!verdict.need, matched: verdict.matched || 'none' };
}

function summarize(tool, args = {}) {
  if (tool === 'http_request') return `${String(args.method || 'GET').toUpperCase()} ${String(args.url || '').slice(0, 200)}`;
  if (tool === 'sqlite') return `${String(args.action || 'query')} ${String(args.path || '')}`.slice(0, 200);
  if (tool === 'clipboard') return String(args.action || 'read');
  if (tool === 'notify') return String(args.title || '').slice(0, 120);
  if (tool === 'sandbox_code_run') return String(args.code || '').split('\n')[0].slice(0, 80);
  return tool;
}

// ═══ clipboard ═══
async function toolClipboard(args = {}) {
  const action = String(args.action || 'read').toLowerCase();
  if (!clipboard) return { ok: false, error: '剪贴板能力不可用（当前宿主未提供 Electron clipboard）' };
  const gate = await gateApproval('clipboard', args);
  if (gate.ok === false) return gate;
  try {
    if (action === 'read') {
      const text = clipboard.readText() || '';
      audit('clipboard', 'read', `${text.length} 字符`, 'recorded');
      return { ok: true, text, length: text.length };
    }
    if (action === 'write') {
      const text = String(args.text == null ? '' : args.text);
      clipboard.writeText(text);
      audit('clipboard', 'write', `${text.length} 字符`, gate.asked ? 'approved' : 'auto');
      return { ok: true, length: text.length };
    }
    return { ok: false, error: `未知 action：${action}（支持 read / write）` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══ notify（系统通知）═══
async function toolNotify(args = {}) {
  if (!Notification) return { ok: false, error: '系统通知能力不可用（当前宿主未提供 Electron Notification）' };
  const gate = await gateApproval('notify', args);
  if (gate.ok === false) return gate;
  const title = String(args.title || 'MJ Code').slice(0, 120);
  const body = String(args.body || '').slice(0, 500);
  try {
    if (!Notification.isSupported()) return { ok: false, error: '当前系统不支持桌面通知' };
    new Notification({ title, body }).show();
    audit('notify', title, '系统通知已发送', gate.asked ? 'approved' : 'auto');
    return { ok: true, title, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══ http_request（全方法 HTTP；SSRF 防护沿用 webTools.isPrivateHost 单一实现）═══
const HTTP_TIMEOUT_MS = 30000;
const HTTP_MAX_BYTES = 5 * 1024 * 1024;
const HTTP_MAX_REDIRECTS = 5;
// 出网单跳校验：协议 + 私网。**每一跳（含重定向后）都要复检**——否则公网 302 跳 127.0.0.1
// 就能绕过 SSRF 防护。纪律与 webTools.httpRequest 的重定向复检一致（SSRF 单一判据 isPrivateHost）。
function outboundBlock(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `仅支持 http/https 协议，收到：${u.protocol}`;
  if (isPrivateHost(u.hostname)) return `出于安全考虑禁止访问内网/本机地址：${u.hostname}`;
  return null;
}
// P0-7：DNS 层复检。fetch（undici）不支持 lookup 钩子，所以上面的 outboundBlock 只看得见
// 字面量主机名 —— evil.com 首次解析公网、实际连接时落到 127.0.0.1 这类 DNS rebinding 挡不住。
// 这里在每一跳 fetch 之前做 resolve-then-validate，与 webTools 走 guardedLookup 是同一判据
// （SSRF 单一事实来源），语义为「全部解析结果都通过才放行」。
// 诚实标注残余风险：预检与实际连接之间理论上仍有权威应答轮换的窗口，故这是纵深防御而非绝对边界；
// 要彻底关闭需换成 http.request + lookup 钩子（webTools 已这样实现），属后续重构项。
function assertResolvedPublic(hostname) {
  return new Promise((resolve, reject) => {
    guardedLookup(hostname, { all: true }, (err) => (err ? reject(err) : resolve()));
  });
}
async function toolHttpRequest(args = {}) {
  let method = String(args.method || 'GET').toUpperCase();
  const rawUrl = String(args.url || '').trim();
  if (!rawUrl) return { ok: false, error: 'url 必填' };
  let current;
  try { current = new URL(rawUrl); } catch { return { ok: false, error: `URL 格式非法：${rawUrl}` }; }
  const blocked0 = outboundBlock(current);
  if (blocked0) return { ok: false, error: blocked0 };
  const gate = await gateApproval('http_request', { ...args, method, url: rawUrl });
  if (gate.ok === false) return gate;

  const timeoutMs = Math.min(Math.max(Number(args.timeout) || HTTP_TIMEOUT_MS, 1000), 120000);
  const headers = args.headers && typeof args.headers === 'object' ? args.headers : {};
  let body;
  if (args.body !== undefined && args.body !== null && method !== 'GET' && method !== 'HEAD') {
    body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // 手动跟随重定向：每一跳都过 outboundBlock 复检（redirect:'follow' 会静默跳过校验，是旁路）。
    for (let hop = 0; ; hop += 1) {
      // P0-7：每一跳都先做 DNS 复检（含重定向后的新主机），字面量检查不足以挡 rebinding。
      try { await assertResolvedPublic(current.hostname); }
      catch (e) { return { ok: false, error: `${e.message}（DNS 层拦截）` }; }
      const res = await fetch(current.toString(), { method, headers, body, redirect: 'manual', signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        if (hop >= HTTP_MAX_REDIRECTS) return { ok: false, error: `重定向次数超过 ${HTTP_MAX_REDIRECTS}，已停止` };
        let next;
        try { next = new URL(loc, current); } catch { return { ok: false, error: `重定向目标非法：${loc}` }; }
        const blocked = outboundBlock(next);
        if (blocked) return { ok: false, error: `重定向目标不安全（已拒绝）：${blocked}` };
        if (res.status === 303) { method = 'GET'; body = undefined; } // 303 语义：改 GET 且丢弃 body
        current = next;
        continue;
      }
      const text = await readLimited(res, HTTP_MAX_BYTES);
      audit('http_request', `${method} ${current.toString()}`, `status=${res.status}`, gate.asked ? 'approved' : 'auto');
      return {
        ok: res.status >= 200 && res.status < 400,
        status: res.status,
        headers: Object.fromEntries([...res.headers.entries()]),
        body: text.body,
        truncated: text.truncated,
      };
    }
  } catch (e) {
    audit('http_request', `${method} ${rawUrl}`, `error: ${e.message}`, 'error');
    return { ok: false, error: `请求失败：${e.message}` };
  }
}

async function readLimited(res, maxBytes) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return { body: '', truncated: false };
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { truncated = true; try { await reader.cancel(); } catch { /* 忽略 */ } break; }
    chunks.push(value);
  }
  return { body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

// ═══ sqlite（复用 sql.js 驱动；query 只读 / exec 写，受 fsMode 约束）═══
// 连接按「绝对路径」缓存（同一文件复用同一内存库，避免每次调用重复加载 WASM / 丢未落盘变更）。
async function sqliteConn(absPath) {
  let rec = sqliteDbs.get(absPath);
  if (!rec) {
    rec = { path: absPath, db: null, promise: openSqliteJsDb(absPath) };
    sqliteDbs.set(absPath, rec);
  }
  if (!rec.db) rec.db = await rec.promise;
  return rec.db;
}

async function toolSqlite(args = {}) {
  const action = String(args.action || 'query').toLowerCase();
  const filePath = String(args.path || '').trim();
  if (!filePath) return { ok: false, error: 'path 必填（SQLite 文件的绝对路径）' };
  if (!path.isAbsolute(filePath)) return { ok: false, error: 'path 必须是绝对路径' };
  // 写判定必须以 **SQL 语句本身**为准，不能只看 action：sql.js 的 all()/step() 对
  // DELETE/UPDATE 同样会真实执行，按 action 分流等于给模型留了绕过审批的口子。
  // 判定实现与 approval.toolLevel('sqlite') 共用 isReadonlySql（单一事实来源）。
  const sqlText = String(args.sql || '').trim();
  const isWrite = action === 'exec' || (!!sqlText && !approval.isReadonlySql(sqlText));
  const gate = await gateApproval('sqlite', { ...args, action: isWrite ? 'exec' : action });
  if (gate.ok === false) return gate;
  if (isWrite && action !== 'exec') {
    audit('sqlite', filePath, `只读动作收到写语句（${sqlText.slice(0, 60)}），已拒绝`, 'blocked');
    return { ok: false, error: '该语句会写库（非 SELECT/PRAGMA/EXPLAIN/WITH），请改用 action=exec（会走审批）' };
  }
  // 能力降级：治理设为只读时拒绝写操作（模型侧得到明确拒绝，而非静默失败）。
  // 判定单一事实来源在 writeGuard.isReadonlyFs，与 exec.js 写工具闸口共用。
  if (isWrite && writeGuard.isReadonlyFs(deps.getGovernance())) {
    audit('sqlite', filePath, '只读档拒绝写库', 'blocked');
    return { ok: false, error: '当前为只读文件能力档，已拒绝写入 SQLite（可在治理设置中切换为读写）' };
  }
  let db;
  try {
    db = await sqliteConn(path.resolve(filePath));
  } catch (e) {
    audit('sqlite', filePath, `open error: ${e.message}`, 'error');
    return { ok: false, error: `打开数据库失败：${e.message}` };
  }
  const params = Array.isArray(args.params) ? args.params : [];
  try {
    if (action === 'tables') {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      audit('sqlite', filePath, `tables=${rows.length}`, 'recorded');
      return { ok: true, tables: rows.map((r) => r.name) };
    }
    if (!sqlText) return { ok: false, error: 'sql 必填' };
    const stmt = db.prepare(sqlText);
    if (isWrite) {
      const r = params.length ? stmt.run(...params) : stmt.run();
      if (typeof db.flush === 'function') db.flush();
      audit('sqlite', filePath, `exec changes=${r.changes}`, gate.asked ? 'approved' : 'auto');
      return { ok: true, changes: r.changes };
    }
    const rows = params.length ? stmt.all(...params) : stmt.all();
    audit('sqlite', filePath, `query rows=${rows.length}`, 'recorded');
    return { ok: true, rows, count: rows.length };
  } catch (e) {
    audit('sqlite', filePath, `error: ${e.message}`, 'error');
    return { ok: false, error: `SQL 执行失败：${e.message}` };
  }
}

// ═══ sandbox_code_run（强沙盒一次性执行：独立子进程 + vm 受限上下文）═══
// 与 code_exec 的分工见 nativeSandbox/childEntry.js 头注释。宿主侧只负责：
// 起子进程 → 发 run → 收结果 → kill；超时/异常一律 kill 并如实回错，绝不静默重启。
function sandboxSpawn() {
  const child = utilityProcess.fork(SANDBOX_CHILD, [], {
    execArgv: [`--max-old-space-size=${SANDBOX_MEM_LIMIT_MB}`],
    stdio: 'pipe',
  });
  if (child.stderr) child.stderr.on('data', (d) => console.warn(`[sandbox ${child.pid}]`, String(d).trim()));
  return child;
}

function runSandboxChild(payload) {
  return new Promise((resolve, reject) => {
    if (!utilityProcess) { reject(new Error('沙盒执行能力不可用（Electron utilityProcess 缺失）')); return; }
    let child;
    try { child = sandboxSpawn(); } catch (e) { reject(new Error(`沙盒启动失败：${e.message}`)); return; }
    let settled = false;
    const done = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退出 */ }
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => done(new Error('沙盒执行超时（宿主兜底 kill）')), SANDBOX_KILL_MS);
    if (timer.unref) timer.unref();
    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ready') {
        child.postMessage({ t: 'call', callId: 'run1', name: 'run', args: [payload] });
        return;
      }
      if (m.t === 'callRes' && m.callId === 'run1') {
        if (m.ok) done(null, m.result);
        else done(new Error(m.error || '沙盒调用失败'));
      }
    });
    child.on('exit', (code) => {
      // 正常一次性退出：回执已发出后子进程即退出，若无回执则视为异常
      if (!settled) done(new Error(`沙盒进程提前退出（code=${code}）`));
    });
  });
}

async function toolSandboxCodeRun(args = {}) {
  const code = String(args.code == null ? '' : args.code);
  if (!code.trim()) return { ok: false, error: 'code 不能为空' };
  const gate = await gateApproval('sandbox_code_run', { ...args, code });
  if (gate.ok === false) return gate;
  const g = deps.getGovernance();
  try {
    const result = await runSandboxChild({
      code,
      timeoutMs: args.timeout,
      allowNetwork: g.sandboxNetwork === true,
      allowFs: false,
    });
    if (!result.ok) {
      audit('sandbox_code_run', summarize('sandbox_code_run', args), `code error: ${result.error}`, 'failed');
      return { ok: false, error: result.error, stdout: result.stdout };
    }
    audit('sandbox_code_run', summarize('sandbox_code_run', args), gate.asked ? 'approved' : 'recorded');
    return {
      ok: true,
      stdout: result.stdout,
      result: result.result,
      ...(result.resultTruncated ? { resultTruncated: true } : {}),
      elapsedMs: result.elapsedMs,
    };
  } catch (e) {
    audit('sandbox_code_run', summarize('sandbox_code_run', args), `error: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  }
}

// 应用退出清理：关库（flush 落盘）+ 清缓存
function disposeNativeTools() {
  for (const [, rec] of sqliteDbs) {
    try { rec.db && rec.db.close && rec.db.close(); } catch { /* 已关闭 */ }
  }
  sqliteDbs.clear();
}

module.exports = {
  initNativeTools, disposeNativeTools,
  toolClipboard, toolNotify, toolHttpRequest, toolSqlite, toolSandboxCodeRun,
  _sqliteDbs: () => sqliteDbs,
};
