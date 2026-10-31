// 期 3 门禁（2026-10-18）：原生内置工具（clipboard / notify / http_request / sqlite / sandbox_code_run）
//
// 覆盖五层：
//   ① schema 与引擎通道接线（BASE_TOOLS / TOOL_HANDLER_NAMES / APPROVAL_TOOLS / 超时表）；
//   ② 审批分级（approval.js 单一事实来源：分级、needsApproval、可补偿性）；
//   ③ isReadonlySql 边界（sqlite 只读判定，approval 与 nativeTools 共用）；
//   ④ nativeTools 工具行为——Electron 能力缺失时 fail-closed、SSRF/协议拦截、sqlite 真实读写、
//      「query+写语句」绕过防护、只读文件能力档拒绝写；
//   ⑤ 主进程接线 + 渲染层降级开关 + i18n 双语 key。
//
// 不依赖 Electron：模块顶层按需解析 Electron 能力（Node 宿主下为 null），故能力缺失路径可真实单测。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { BASE_TOOLS } from '../agent-core/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const NATIVE = ['clipboard', 'notify', 'http_request', 'sqlite', 'sandbox_code_run'];

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① schema 与引擎接线 ──
{
  const byName = Object.fromEntries(BASE_TOOLS.map((t) => [t.function.name, t.function]));
  const missing = NATIVE.filter((n) => !byName[n]);
  check('BASE_TOOLS 含 5 个原生工具', missing.length === 0, missing.length ? `缺=${missing}` : '');
  // 精确条数钉在这里的理由：它是「工具面体积」的 coarse 哨兵，一旦变动就该有人确认。
  // 2026-10-31：52 → 53，新增 device_probe（只读设备探测，schema 外置在 agent-core/deviceToolSchema.js）。
  check('BASE_TOOLS.length === 54（期 3 新增 5 个 + G-deep-research 1 个 + G-doc 4 个 + G-latex 1 个 + device 2 个）', BASE_TOOLS.length === 54, `got=${BASE_TOOLS.length}`);
  check('clipboard schema required=[action]、action 枚举 read/write',
    JSON.stringify(byName.clipboard?.parameters?.required) === '["action"]'
    && JSON.stringify(byName.clipboard?.parameters?.properties?.action?.enum) === '["read","write"]');
  check('notify schema required=[body]', JSON.stringify(byName.notify?.parameters?.required) === '["body"]');
  check('http_request schema required=[url]', JSON.stringify(byName.http_request?.parameters?.required) === '["url"]');
  check('sqlite schema required=[path]、action 枚举 query/exec/tables',
    JSON.stringify(byName.sqlite?.parameters?.required) === '["path"]'
    && JSON.stringify(byName.sqlite?.parameters?.properties?.action?.enum) === '["query","exec","tables"]');
  check('sandbox_code_run schema required=[code]',
    JSON.stringify(byName.sandbox_code_run?.parameters?.required) === '["code"]');

  const src = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
  check('TOOL_HANDLER_NAMES 映射 5 工具到 camelCase handler',
    /clipboard:\s*'clipboard'/.test(src) && /notify:\s*'notify'/.test(src)
    && /http_request:\s*'httpRequest'/.test(src) && /sqlite:\s*'sqlite'/.test(src)
    && /sandbox_code_run:\s*'sandboxCodeRun'/.test(src));
  check('APPROVAL_TOOLS 纳入 5 工具（透传 approvalMode/conversationId 进主进程审批闸）',
    // 断言「集合内含这 5 个名字」而不是匹配整行字面量——新增工具时整行会换行重排，
    // 字面量断言会假失败（G-doc 加入时就撞上过），按名字逐个断言更稳。
    NATIVE.every((n) => new RegExp(`'${n}'`).test(src)));
  check('TOOL_TIMEOUT_OVERRIDES 含 http_request=45000 / sandbox_code_run=90000',
    /http_request:\s*45000/.test(src) && /sandbox_code_run:\s*90000/.test(src));
}

// ── ② 审批分级（approval.js 单一事实来源）──
{
  const approval = require(path.join(ROOT, 'main/approval.js'));
  const lvl = (tool, args) => approval.toolLevel(tool, args || {});

  check('clipboard 读不询问（null）', lvl('clipboard', { action: 'read' }) === null);
  check('clipboard 写判 L2（覆盖用户原剪贴板不可恢复）', lvl('clipboard', { action: 'write' }) === 'L2');
  check('notify 不进审批面（null，与 todo_write 同纪律）', lvl('notify', {}) === null);
  check('http_request GET/HEAD 只读（null）',
    lvl('http_request', { method: 'GET' }) === null && lvl('http_request', { method: 'HEAD' }) === null);
  check('http_request 缺省方法按 GET 只读', lvl('http_request', { url: 'https://x' }) === null);
  check('http_request POST/DELETE 判 L3',
    lvl('http_request', { method: 'POST' }) === 'L3' && lvl('http_request', { method: 'DELETE' }) === 'L3');
  check('sqlite tables 不询问', lvl('sqlite', { action: 'tables' }) === null);
  check('sqlite 只读语句不询问', lvl('sqlite', { action: 'query', sql: 'SELECT 1' }) === null);
  check('sqlite 写语句判 L3（销毁内容且本机无 git 可退）',
    lvl('sqlite', { action: 'exec', sql: 'DELETE FROM t' }) === 'L3');
  check('sandbox_code_run 判 L2（强沙盒变体，与 code_exec 的 L3 形成分层）',
    lvl('sandbox_code_run', {}) === 'L2');

  const need = (mode, tool, args) => approval.needsApproval({
    tool, args, approvalMode: mode, alwaysRules: [], conversationRules: [],
  }).need;
  check('on-request：http_request GET 不弹卡 / POST 弹卡',
    need('on-request', 'http_request', { method: 'GET' }) === false
    && need('on-request', 'http_request', { method: 'POST' }) === true);
  check('auto-safe：sandbox_code_run（L2）放行、sqlite 写（L3）仍弹卡',
    need('auto-safe', 'sandbox_code_run', {}) === false
    && need('auto-safe', 'sqlite', { action: 'exec', sql: 'UPDATE t SET a=1' }) === true);

  const ro = approval.isReadonlySql;
  check('isReadonlySql：SELECT/PRAGMA/EXPLAIN/WITH/VALUES 为只读',
    ro('SELECT 1') && ro('PRAGMA table_info(t)') && ro('EXPLAIN SELECT 1')
    && ro('WITH x AS (SELECT 1) SELECT * FROM x') && ro('VALUES (1)'));
  check('isReadonlySql：剥离前导空白与 SQL 注释后仍判只读',
    ro('  \n-- 注释\nSELECT 1') === true && ro('/* c */ WITH q AS (SELECT 1) SELECT * FROM q') === true);
  check('isReadonlySql：写语句判非只读',
    !ro('DELETE FROM t') && !ro('UPDATE t SET a=1') && !ro('INSERT INTO t VALUES(1)') && !ro('DROP TABLE t'));
  check('isReadonlySql：空/纯空白判非只读（fail-closed）', !ro('') && !ro('   '));

  const rv = approval.reversibilityOf;
  check('可补偿性：sqlite/http_request/clipboard 不可补偿',
    rv('sqlite').reversible === false && rv('http_request').reversible === false
    && rv('clipboard').reversible === false);
  check('可补偿性：notify/sandbox_code_run 可补偿',
    rv('notify').reversible === true && rv('sandbox_code_run').reversible === true);
}

// ── ③ nativeTools：Electron 能力缺失路径（fail-closed）+ SSRF/协议拦截 ──
{
  const nativeTools = require(path.join(ROOT, 'main/nativeTools.js'));
  nativeTools.initNativeTools({
    requestApproval: async () => 'allow-once',
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    getGovernance: () => ({ profile: 'normal', fsMode: 'read-write', sandboxNetwork: false }),
  });

  const c = await nativeTools.toolClipboard({ action: 'read' });
  check('clipboard 无 Electron 宿主 fail-closed',
    c.ok === false && String(c.error).includes('剪贴板能力不可用'), JSON.stringify(c).slice(0, 120));
  const n = await nativeTools.toolNotify({ body: 'hi' });
  check('notify 无 Electron 宿主 fail-closed',
    n.ok === false && String(n.error).includes('系统通知能力不可用'), JSON.stringify(n).slice(0, 120));
  const s = await nativeTools.toolSandboxCodeRun({ code: 'return 1 + 1' });
  check('sandbox_code_run 无 Electron 宿主 fail-closed（拒绝而非宿主进程代跑）',
    s.ok === false && String(s.error).includes('沙盒执行能力不可用'), JSON.stringify(s).slice(0, 120));
  const s2 = await nativeTools.toolSandboxCodeRun({ code: '   ' });
  check('sandbox_code_run 空 code 被拒', s2.ok === false && String(s2.error).includes('不能为空'));

  const inner = await nativeTools.toolHttpRequest({ url: 'http://127.0.0.1:8080/x' });
  check('http_request 拒绝本机地址（SSRF 单一实现）',
    inner.ok === false && String(inner.error).includes('内网/本机'), JSON.stringify(inner).slice(0, 120));
  const meta = await nativeTools.toolHttpRequest({ url: 'http://169.254.169.254/latest/meta-data' });
  check('http_request 拒绝云元数据端点（SSRF）',
    meta.ok === false && String(meta.error).includes('内网/本机'));
  const bad = await nativeTools.toolHttpRequest({ url: 'file:///etc/passwd' });
  check('http_request 拒绝非 http/https 协议', bad.ok === false && String(bad.error).includes('http/https'));
  const nous = await nativeTools.toolHttpRequest({ url: 'not a url' });
  check('http_request 非法 URL 被拒', nous.ok === false && String(nous.error).includes('URL 格式非法'));
  const nourl = await nativeTools.toolHttpRequest({});
  check('http_request 缺 url 被拒', nourl.ok === false && String(nourl.error).includes('url 必填'));
  // 重定向复检：公网 302 跳内网必须被拒（redirect:'follow' 会静默跳过校验 ⇒ SSRF 旁路）。
  // 用 stub fetch 返回 302→127.0.0.1 的响应（初始 host 用公网名，才能绕过首跳校验进入重定向分支）。
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  try {
    const redir = await nativeTools.toolHttpRequest({ url: 'http://example.com/x' });
    check('http_request 重定向跳内网被拒（每一跳复检 SSRF）',
      redir.ok === false && /127\.0\.0\.1|内网|本机/.test(String(redir.error)), JSON.stringify(redir).slice(0, 140));
  } finally { globalThis.fetch = origFetch; }
}

// ── ④ sqlite：真实读写 + 写绕过防护 + 只读文件能力档拒绝写 ──
{
  const nativeTools = require(path.join(ROOT, 'main/nativeTools.js'));
  const gov = { profile: 'normal', fsMode: 'read-write', sandboxNetwork: false };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-p3-'));
  const dbPath = path.join(tmp, 'agent-test.sqlite');
  nativeTools.initNativeTools({
    requestApproval: async () => 'allow-once',
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    getGovernance: () => ({ ...gov }),
  });
  try {
    const mk = await nativeTools.toolSqlite({ action: 'exec', path: dbPath, sql: 'CREATE TABLE t(a INTEGER, b TEXT)' });
    check('sqlite exec 建表成功', mk.ok === true, JSON.stringify(mk).slice(0, 120));
    const ins = await nativeTools.toolSqlite({ action: 'exec', path: dbPath, sql: 'INSERT INTO t(a,b) VALUES(?,?)', params: [1, 'x'] });
    check('sqlite exec 插入成功（changes>=1）', ins.ok === true && ins.changes >= 1, JSON.stringify(ins).slice(0, 120));
    const q = await nativeTools.toolSqlite({ action: 'query', path: dbPath, sql: 'SELECT * FROM t' });
    check('sqlite query 读回数据', q.ok === true && Array.isArray(q.rows) && q.rows.length === 1, JSON.stringify(q).slice(0, 160));
    const tb = await nativeTools.toolSqlite({ action: 'tables', path: dbPath });
    check('sqlite tables 列出表名', tb.ok === true && (tb.tables || []).includes('t'), JSON.stringify(tb).slice(0, 120));

    const bypass = await nativeTools.toolSqlite({ action: 'query', path: dbPath, sql: 'DELETE FROM t' });
    check('sqlite 写绕过防护：action=query + 写语句被拒（sql.js 的 step 会真实执行）',
      bypass.ok === false && String(bypass.error).includes('会写库'), JSON.stringify(bypass).slice(0, 160));

    gov.fsMode = 'read-only';
    const ro = await nativeTools.toolSqlite({ action: 'exec', path: dbPath, sql: 'DELETE FROM t' });
    check('sqlite 只读文件能力档拒绝写操作',
      ro.ok === false && String(ro.error).includes('只读文件能力档'), JSON.stringify(ro).slice(0, 160));
    const roRead = await nativeTools.toolSqlite({ action: 'query', path: dbPath, sql: 'SELECT * FROM t' });
    check('sqlite 只读档下读查询仍可用', roRead.ok === true, JSON.stringify(roRead).slice(0, 120));
    gov.fsMode = 'read-write';

    check('sqlite 相对路径被拒',
      (await nativeTools.toolSqlite({ action: 'query', path: 'rel.sqlite', sql: 'SELECT 1' })).ok === false);
    check('sqlite 缺 path 被拒', (await nativeTools.toolSqlite({ sql: 'SELECT 1' })).ok === false);
  } finally {
    try { nativeTools.disposeNativeTools(); } catch { /* 清理异常不影响断言 */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}

// ── ⑤ 主进程接线 + 渲染层降级开关 + i18n 双语 key ──
{
  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  check('main.js 注入 initNativeTools', /nativeTools\.initNativeTools\(\{/.test(main));
  check('main.js createToolHandlers 接线 5 个原生 handler',
    /clipboard:\s*nativeTools\.toolClipboard/.test(main) && /notify:\s*nativeTools\.toolNotify/.test(main)
    && /httpRequest:\s*nativeTools\.toolHttpRequest/.test(main)
    && /sqlite:\s*nativeTools\.toolSqlite/.test(main)
    && /sandboxCodeRun:\s*nativeTools\.toolSandboxCodeRun/.test(main));
  check('main.js 退出时 disposeNativeTools 清理（flush 落盘 + 关库）',
    /disposeNativeTools\(\)/.test(main));

  const preload = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');
  check('原生工具仅主进程路径：preload 不暴露 tool:* 通道（无渲染层回退，属既有降级）',
    !/tool:(clipboard|notify|httpRequest|sqlite|sandboxCodeRun)/.test(preload));

  const ui = fs.readFileSync(path.join(ROOT, 'renderer/src/components/LocalMcpSection.tsx'), 'utf8');
  check('渲染层治理开关走部分更新语义（mcpGovernanceSet(partial)）',
    /mcpGovernanceSet\?\.\(partial\)/.test(ui));
  check('渲染层有文件能力与沙盒网络两个控件',
    /applyGovernance\(\{ fsMode/.test(ui) && /applyGovernance\(\{ sandboxNetwork/.test(ui));
  check('渲染层 load 读取 fsMode/sandboxNetwork',
    /setFsMode\(cfg\.governance/.test(ui) && /setSandboxNetwork\(cfg\.governance/.test(ui));

  // 文件能力档真实约束写工具（write_file/edit_file/apply_patch 单一闸口在 exec.runWriteTool）
  check('main.js 向 initToolExec 注入 getGovernance（写工具受文件能力档约束）',
    /getGovernance: \(\) => mcpIpc\.getGovernance\(\)/.test(main));

  const keys = ['fsModeLabel', 'fsReadOnly', 'fsReadWrite', 'sandboxNetLabel', 'sandboxNetOn', 'sandboxNetOff'];
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/src/i18n/locales/zh-CN/localMcp.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/src/i18n/locales/en-US/localMcp.json'), 'utf8'));
  check('i18n 双语治理开关 key 齐备',
    keys.every((k) => typeof zh[k] === 'string' && typeof en[k] === 'string'),
    `zh缺=${keys.filter((k) => !zh[k])} en缺=${keys.filter((k) => !en[k])}`);
}

// ── ⑥ 只读文件能力档：写工具在 exec.runWriteTool 单一闸口被拒（fail-closed）──
{
  // exec.js 顶层解构 electron（app/ipcMain/shell）——纯 Node 下 require('electron') 返回的是
  // 二进制路径字符串而非对象，解构得 undefined ⇒ initToolExec 内的 registerIpc 会崩。
  // 装最小 electron stub（同 r2-exec-cwd-contract 先例）后再 require，让 runWriteTool 可被真实调用。
  const electronPath = require.resolve('electron');
  const stub = new Module(electronPath, null);
  stub.filename = electronPath;
  stub.loaded = true;
  stub.exports = {
    app: { getPath: () => '/tmp/mjcode-p3-electron', on: () => {}, whenReady: () => Promise.resolve() },
    ipcMain: { handle: () => {}, on: () => {} },
    shell: { openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {} },
  };
  require.cache[electronPath] = stub;

  const toolExec = require(path.join(ROOT, 'main/tools/exec.js'));
  toolExec.initToolExec({
    requestApproval: async () => 'allow-once',
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    registerChild: () => {},
    getGovernance: () => ({ profile: 'normal', fsMode: 'read-only', sandboxNetwork: false }),
  });
  const blocked = await toolExec.runWriteTool('writeFile', { path: '/tmp/mjcode-p3-readonly.txt', text: 'x' });
  check('只读文件能力档：runWriteTool 拒绝写入（blocked 且 readOnly 标记）',
    blocked.ok === false && blocked.readOnly === true && blocked.blocked === true,
    JSON.stringify(blocked).slice(0, 160));
  check('只读档拒写错误文案指向治理开关',
    String(blocked.error || '').includes('只读文件能力'), String(blocked.error || '').slice(0, 80));
}

console.log(`\n总计 ${pass + fail} · 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
