// 第八轮 L-3 门禁：「审计不可改写」与「工具定义钉定」两项未核项
//
// 这两条此前是台账里的 ❓（「未核」= 没人去看过）。核查结论：
//   · **审计不可改写**：写入侧确实只有 append（模块不导出 update/delete），但文件本身
//     没有任何防篡改证据 —— 改一行、删一行事后看不出来。本轮补哈希链（`seq`/`prev`/`hash`）。
//   · **工具定义钉定**：清单缓存只存 `{tools, updatedAt}`，服务端静默改定义时磁盘清单被直接
//     覆盖、无事件可查，而模型侧看到的是**变了字节的工具表**（打掉前缀缓存、行为也可能变）。
//     本轮补指纹 + 漂移事件（只在指纹变化时记）。
//   · **幂等键**：核查为「不存在」（全仓 0 命中），本轮**明确不做**（属产品决策，见报告 §8.7）。
//
// 判据设计要点：篡改检测必须能用**真实篡改**触发（改内容 / 删中间行 两种），
// 否则「链校验通过」只是因为它什么都没检。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(path.join(path.resolve(import.meta.dirname, '..'), 'main', 'noop.js'));
const DESKTOP = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── electron stub（auditLog 顶层 require electron 并用 app.getPath('userData')）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-auditchain-'));
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => TMP }, shell: {}, clipboard: {} },
};
const auditLog = require(path.join(DESKTOP, 'main', 'audit', 'auditLog.js'));
const LOG = path.join(TMP, 'audit-log.jsonl');

// ── ① 写入形态：必须是 append-only 且每行带链字段 ──
{
  check('L-3 审计模块不导出 update / delete（写入侧不可改写）',
    !Object.keys(auditLog).some((k) => /update|delete|remove|truncate/i.test(k)),
    Object.keys(auditLog).join(','));
  auditLog.auditLocal('shell', 'rm -rf x', '演示', 'auto');
  auditLog.auditLocal('write_file', 'a.txt', '演示2', 'denied');
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('L-3 每行带 seq / prev / hash（哈希链字段）',
    lines.length === 2 && lines.every((r) => Number.isInteger(r.seq) && typeof r.prev === 'string' && /^[0-9a-f]{64}$/.test(r.hash)),
    `lines=${lines.length}`);
  check('L-3 seq 单调递增', lines[1].seq === lines[0].seq + 1, `${lines[0].seq}→${lines[1].seq}`);
  check('L-3 第一行 prev 为空串 / 第二行 prev === 第一行 hash',
    lines[0].prev === '' && lines[1].prev === lines[0].hash);
  check('L-3 既有字段一个不少（向后兼容）',
    ['ts', 'action', 'target', 'detail', 'approval_result', 'mode'].every((k) => k in lines[0]));
}

// ── ② 完好文件：校验通过 ──
{
  const r = auditLog.verifyAuditChain(LOG);
  check('L-3 未篡改时链校验通过', r.ok === true && r.hashed === 2, JSON.stringify(r));
}

// ── ③ 篡改检测（两种真实篡改，必须都红）──
{
  // 3a：改内容
  const orig = fs.readFileSync(LOG, 'utf8');
  const tampered = orig.replace('"detail":"演示"', '"detail":"已改成别的"');
  const p1 = path.join(TMP, 'tamper-content.jsonl');
  fs.writeFileSync(p1, tampered);
  const r1 = auditLog.verifyAuditChain(p1);
  check('L-3 改一行内容 ⇒ 校验失败且指到具体 seq',
    r1.ok === false && r1.atSeq === 1, JSON.stringify(r1));

  // 3b：删中间行
  const lines = orig.split('\n').filter(Boolean);
  const p2 = path.join(TMP, 'tamper-delete.jsonl');
  fs.writeFileSync(p2, `${lines[0]}\n${lines[2] || ''}\n`);
  // 只有两行时「删中间」等价于删尾行——用三行构造才真正测到 prev 断链
  auditLog.auditLocal('git_commit', 'm', '第三条', 'auto');
  const three = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(p2, `${three[0]}\n${three[2]}\n`);
  const r2 = auditLog.verifyAuditChain(p2);
  check('L-3 删中间行 ⇒ 校验失败（prev 断链，不是「少了一行也照样过」）',
    r2.ok === false && /prev/.test(r2.reason), JSON.stringify(r2));

  // 3c：插入一行无 hash 的伪造记录到链中间
  const p3 = path.join(TMP, 'tamper-insert.jsonl');
  fs.writeFileSync(p3, `${three[0]}\n${JSON.stringify({ seq: 99, action: 'fake' })}\n${three[1]}\n`);
  const r3 = auditLog.verifyAuditChain(p3);
  check('L-3 链中间插入无 hash 行 ⇒ 校验失败', r3.ok === false, JSON.stringify(r3));

  // 3d：老版本文件（全是无 hash 行）不被判成篡改
  const p4 = path.join(TMP, 'legacy.jsonl');
  fs.writeFileSync(p4, `${JSON.stringify({ ts: 'x', action: 'legacy1' })}\n${JSON.stringify({ ts: 'y', action: 'legacy2' })}\n`);
  const r4 = auditLog.verifyAuditChain(p4);
  check('L-3 老格式文件（无 hash）判为 legacy 而非篡改（升级不误报）',
    r4.ok === true && r4.legacy === 2 && r4.hashed === 0, JSON.stringify(r4));
  check('L-3 文件不存在时如实报不可读（不静默给 ok）',
    auditLog.verifyAuditChain(path.join(TMP, 'nope.jsonl')).ok === false);
}

// ── ④ 工具定义指纹（mcpToolCache）──
{
  const { fingerprintOf, createMcpToolCache } = require(path.join(DESKTOP, 'main', 'mcpToolCache.js'));
  const manifestPath = path.join(TMP, 'manifests.json');
  const audits = [];
  const cache = createMcpToolCache({
    filePath: manifestPath,
    log: () => {},
    audit: (event, payload) => audits.push({ event, payload }),
  });
  const t1 = [
    { name: 'read_file', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'list_dir', description: '列目录', inputSchema: { type: 'object', properties: {} } },
  ];
  check('L-3 指纹：同一份定义（顺序不同）得到同一指纹',
    fingerprintOf(t1) === fingerprintOf([...t1].reverse()));
  check('L-3 指纹：描述变化即变化',
    fingerprintOf(t1) !== fingerprintOf([{ ...t1[0], description: '改过的描述' }, t1[1]]));
  check('L-3 指纹：schema 变化即变化（加一个必填参数这种最隐蔽的漂移）',
    fingerprintOf(t1) !== fingerprintOf([{ ...t1[0], inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, t1[1]]));
  check('L-3 指纹：空清单也返回确定的 64 位十六进制',
    /^[0-9a-f]{64}$/.test(fingerprintOf([])) && fingerprintOf([]) === fingerprintOf(null));

  await cache.saveManifest('filesystem', t1);
  const first = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).filesystem;
  check('L-3 清单落盘带 fingerprint 字段', typeof first.fingerprint === 'string' && first.fingerprint.length === 64);
  check('L-3 首次写入不产生漂移事件（新服务不算漂移）',
    audits.filter((a) => a.event === 'mcp_tool_defs_changed').length === 0);

  // 定义漂移：加一个工具 + 改一个描述
  await cache.saveManifest('filesystem', [...t1, { name: 'move_file', description: '移动', inputSchema: { type: 'object' } }]);
  const drift = audits.filter((a) => a.event === 'mcp_tool_defs_changed');
  check('L-3 定义变化 ⇒ 产生一条漂移审计（含新增工具名）',
    drift.length === 1 && drift[0].payload.added.includes('move_file'), JSON.stringify(drift[0]?.payload || {}));
  check('L-3 漂移审计带前后指纹且不相同',
    drift[0].payload.before !== drift[0].payload.after);

  // 只有描述变（工具名集合不变）→ 事件必须标 schemaOnly，否则排障时会去数工具而看不出问题
  const before = audits.filter((a) => a.event === 'mcp_tool_defs_changed').length;
  await cache.saveManifest('filesystem', [
    t1[0], t1[1], { name: 'move_file', description: '移动（改过）', inputSchema: { type: 'object' } },
  ]);
  const drift2 = audits.filter((a) => a.event === 'mcp_tool_defs_changed').slice(before);
  check('L-3 仅描述/schema 变化时标 schemaOnly=true（工具名集合未变）',
    drift2.length === 1 && drift2[0].payload.schemaOnly === true, JSON.stringify(drift2[0]?.payload || {}));

  // 定义不变 → 不得产生噪声
  const before2 = audits.filter((a) => a.event === 'mcp_tool_defs_changed').length;
  await cache.saveManifest('filesystem', [
    t1[0], t1[1], { name: 'move_file', description: '移动（改过）', inputSchema: { type: 'object' } },
  ]);
  check('L-3 定义未变 ⇒ 不再产生漂移事件（不把审计刷成清单副本）',
    audits.filter((a) => a.event === 'mcp_tool_defs_changed').length === before2);
}

// ── ⑤ 幂等键：明确「不存在」，把这条记成已知缺口而不是默默假设有 ──
{
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
      if (!/\.(js|mjs|ts|tsx)$/.test(name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/idempotency[_-]?key|idempotent/i.test(text)) hits.push(path.relative(DESKTOP, full));
    }
  };
  for (const root of ['main', 'agent-core', 'shared']) walk(path.join(DESKTOP, root));
  check('L-3 幂等键：全仓确认不存在（结论写进台账，不是「没查」）', hits.length === 0, hits.join(','));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
