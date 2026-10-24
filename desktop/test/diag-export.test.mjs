// T2-6 门禁：诊断包一键导出（main/diagExport.js + main/zipStore.js）
// 核心纪律断言：包内**绝不出现** API Key / 密文 / env / Authorization——用假密钥值全包 grep。
// P0-7（2026-10-17）扩充：非结构化文本密钥扫描 / models.json 白名单 / userData 路径脱敏 /
// 导出前内容清单。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0, total = 0;
// RB-2：helper 必须 async —— 同步 helper 收到 async 回调时 `fn()` 返回 Promise（truthy），
// 断言失败变成 unhandled rejection：先打印 [PASS]、再被 process.exit(pass===total?0:1) 结算成 exit 0。
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 假 userData / home + electron stub ──
// userData 刻意挂在 home 之下（与真实平台一致：~/Library/Application Support/...），
// 以便验证 meta.json 的 HOME 相对路径脱敏。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-diagexport-'));
const tmpHome = path.join(tmp, 'home');
const userData = path.join(tmpHome, 'Library', 'Application Support', 'MJCode');
fs.mkdirSync(path.join(userData, 'traces'), { recursive: true });
fs.mkdirSync(path.join(userData, 'diagnostics'), { recursive: true });
fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, '.mjcode'), { recursive: true });

const FAKE_KEY = 'sk-FAKE-SECRET-1234567890';
const FAKE_ENV_VALUE = 'FAKE-ENV-SECRET-abcdefgh';
const FAKE_AUTH_HEADER = 'Bearer FAKE-AUTH-SECRET-xyz';
// P0-7：非结构化文本里嵌的密钥（命令原文/上游响应体形态）——必须被正则扫描替换
const EMBEDDED_SK = 'sk-abcdefghijklmnopqrst1234';
const EMBEDDED_BEARER = 'Bearer sk-live-abcdef1234567890';
const EMBEDDED_GHP = 'ghp_abcdefghijklmnopqrstuvwx';
const EMBEDDED_AKIA = 'AKIAIOSFODNN7EXAMPLE';

fs.writeFileSync(path.join(userData, 'audit-log.jsonl'),
  `{"action":"shell","target":"curl -H \\"Authorization: ${EMBEDDED_BEARER}\\" https://api.example.com"}\n`
  + `{"action":"shell","target":"export KEY=${EMBEDDED_SK} && ./deploy.sh"}\n`);
fs.writeFileSync(path.join(userData, 'diagnostics', 'crash-2026-10-15.jsonl'),
  `{"kind":"uncaughtException","stack":"fetch failed https://x (token ${EMBEDDED_GHP})"}\n`);
fs.writeFileSync(path.join(userData, 'traces', 'run-1.jsonl'),
  `{"evt":"run_start","req":{"auth":"${EMBEDDED_AKIA}"}}\n`);
fs.writeFileSync(path.join(userData, 'logs', 'main-2026-10-15.log'),
  `[model] 401 response body: {"error":"invalid key ${EMBEDDED_SK}"}\n`);
fs.writeFileSync(path.join(userData, 'local-data.json'), JSON.stringify({
  providers: [{ id: 1, name: 'p', base_url: 'https://x', keyEncrypted: 'enc:'+FAKE_KEY, api_key: FAKE_KEY, model_id: 'm' }],
  threads: [{ id: 't1', title: '用户会话标题不应进包' }],
  messages: [{ id: 'm1', content: '用户消息正文不应进包' }],
  preferences: { 'server.apiBase': 'http://localhost:3001/api' },
  projects: [{ path: '/tmp/proj' }],
}));
fs.writeFileSync(path.join(userData, 'mcp-servers.json'), JSON.stringify([
  { name: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { MY_KEY: FAKE_ENV_VALUE }, headers: { Authorization: FAKE_AUTH_HEADER } },
]));
// models.json：黑名单时代的漏网形态——accessKeyId / secretKey 变体键名（白名单必须剔除）
fs.writeFileSync(path.join(tmpHome, '.mjcode', 'models.json'), JSON.stringify({
  providers: [
    { key: 'g1', name: 'g', base_url: 'https://g', api_key: FAKE_KEY, accessKeyId: 'AKIA-LEAK-ID-123', secretKey: EMBEDDED_SK, models: [{ model_id: 'm1' }] },
    { name: 'g2', url: 'https://g2', channel: 'deepseek', apiKey: FAKE_KEY, models: ['m2', { id: 'm3', name: '模型三' }] },
  ],
}));

const electronStub = {
  app: { getPath: (k) => (k === 'userData' ? userData : k === 'home' ? tmpHome : tmp), getVersion: () => '1.0.0-test' },
  ipcMain: { handle: (ch, h) => electronStub._handlers.set(ch, h), on: () => {} },
  _handlers: new Map(),
};
const mainRequire = createRequire(path.join(DESKTOP, 'main', 'noop.js'));
require.cache[mainRequire.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: electronStub };

const { writeZip, readZip, crc32 } = require(path.join(DESKTOP, 'main/zipStore.js'));
const {
  collectEntries, redact, registerDiagExportIpc, exportDiagnosticsZip,
  redactSecrets, redactModels, redactUserDataPath, previewDiagPackage,
} = require(path.join(DESKTOP, 'main/diagExport.js'));

await check('zipStore：写读 round-trip 与 CRC 正确', () => {
  const entries = [
    { name: 'a.txt', data: 'hello 世界' },
    { name: 'dir/b.json', data: Buffer.from('{"k":1}') },
  ];
  const out = path.join(tmp, 'test.zip');
  writeZip(entries, out);
  const read = readZip(fs.readFileSync(out)).map((e) => ({ name: e.name, text: e.data.toString('utf8') }));
  assert.deepEqual(read.map((r) => r.name), ['a.txt', 'dir/b.json']);
  assert.equal(read[0].text, 'hello 世界');
  assert.equal(read[1].text, '{"k":1}');
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926); // 标准校验值
});

await check('redact：递归剔除敏感字段', () => {
  const r = redact({ a: 1, api_key: 'x', nested: { keyEncrypted: 'y', env: { Z: 1 }, keep: 2 }, list: [{ Authorization: 'z', token: 't', ok: 1 }] });
  assert.deepEqual(r, { a: 1, nested: { keep: 2 }, list: [{ ok: 1 }] });
});

await check('collectEntries：诊断域齐备 + 会话正文不进包', () => {
  const names = collectEntries(userData).map((e) => e.name).sort();
  for (const must of ['meta.json', 'audit/audit-log.jsonl', 'diagnostics/crash-2026-10-15.jsonl', 'traces/run-1.jsonl', 'logs/main-2026-10-15.log', 'config/local-data.json', 'config/models.json', 'config/mcp-servers.json']) {
    assert.ok(names.includes(must), `缺条目 ${must}：${names.join(', ')}`);
  }
  const cfg = collectEntries(userData).find((e) => e.name === 'config/local-data.json').data.toString();
  assert.ok(!cfg.includes('用户会话标题') && !cfg.includes('用户消息正文'), '会话/消息正文泄漏进诊断包');
});

await check('全包 grep：任何假密钥值都不出现（凭证剔除纪律）', () => {
  const all = collectEntries(userData).map((e) => e.data.toString()).join('\n');
  for (const secret of [FAKE_KEY, FAKE_ENV_VALUE, FAKE_AUTH_HEADER, 'keyEncrypted', '"env"', 'enc:']) {
    assert.ok(!all.includes(secret), `诊断包含敏感值 ${secret}`);
  }
});

await check('exportDiagnosticsZip：落盘可读 zip 且 meta 带版本', () => {
  const file = exportDiagnosticsZip();
  assert.ok(fs.existsSync(file), 'zip 未落盘');
  const meta = JSON.parse(readZip(fs.readFileSync(file)).find((e) => e.name === 'meta.json').data.toString());
  assert.equal(meta.appVersion, '1.0.0-test');
  fs.rmSync(file);
});

await check('IPC diag:export 注册且失败不抛', async () => {
  registerDiagExportIpc();
  assert.ok(electronStub._handlers.has('diag:export'), '未注册 diag:export');
});

// ── P0-7 新增断言 ──

await check('P0-7-a：redactSecrets 正则替换四类密钥形态', () => {
  const out = redactSecrets(`a ${EMBEDDED_SK} b ${EMBEDDED_BEARER} c ${EMBEDDED_GHP} d ${EMBEDDED_AKIA} e`);
  assert.ok(!out.includes(EMBEDDED_SK) && !out.includes(EMBEDDED_BEARER)
    && !out.includes(EMBEDDED_GHP) && !out.includes(EMBEDDED_AKIA), '密钥未被替换');
  assert.ok(out.includes('***REDACTED***'), '未见替换标记');
  // 正常文本不误伤
  assert.equal(redactSecrets('sk-short 与 BearerX 普通日志'), 'sk-short 与 BearerX 普通日志');
});

await check('P0-7-a：审计/崩溃/trace/日志里的嵌入密钥全部被扫描剔除', () => {
  const all = collectEntries(userData).map((e) => e.data.toString()).join('\n');
  for (const secret of [EMBEDDED_SK, EMBEDDED_BEARER, EMBEDDED_GHP, EMBEDDED_AKIA]) {
    assert.ok(!all.includes(secret), `非结构化内容泄漏密钥 ${secret}`);
  }
  assert.ok(all.includes('***REDACTED***'), '包内未见密钥替换痕迹');
});

await check('P0-7-b：models.json 白名单——变体键名（accessKeyId/secretKey/apiKey）剔除，业务字段保留', () => {
  const raw = JSON.stringify({
    providers: [
      { name: 'g', base_url: 'https://g', apiKey: 'sk-leak-abcdefghijklmnop', accessKeyId: 'AKIA-LEAK', secretKey: 'topsecret', models: [{ model_id: 'm1' }] },
      { name: 'g2', url: 'https://g2', channel: 'deepseek', api_key: 'sk-leak2', models: ['m2'] },
    ],
  });
  const out = JSON.parse(JSON.stringify(redactModels(JSON.parse(raw))));
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('sk-leak'), 'apiKey/api_key 漏网');
  assert.ok(!flat.includes('AKIA-LEAK'), 'accessKeyId 漏网');
  assert.ok(!flat.includes('topsecret'), 'secretKey 漏网');
  assert.ok(out.providers[0].name === 'g' && out.providers[0].base_url === 'https://g'
    && out.providers[0].models[0].model_id === 'm1', '白名单业务字段被误删');
  assert.ok(out.providers[1].channel === 'deepseek' && out.providers[1].url === 'https://g2', 'channel/url 应在白名单内');
});

await check('P0-7-b：导出包的 config/models.json 只含白名单字段', () => {
  const models = collectEntries(userData).find((e) => e.name === 'config/models.json').data.toString();
  assert.ok(!models.includes(FAKE_KEY) && !models.includes(EMBEDDED_SK) && !models.includes('AKIA-LEAK-ID-123'), 'models.json 泄漏密钥');
  assert.ok(models.includes('"name": "g"') && models.includes('"base_url": "https://g"') && models.includes('m1'), '白名单字段缺失');
  assert.ok(models.includes('deepseek'), 'channel 字段应保留');
});

await check('P0-7-c：meta.json userData 路径脱敏为 HOME 相对表达', () => {
  assert.equal(redactUserDataPath(userData), `~${path.sep}Library${path.sep}Application Support${path.sep}MJCode`);
  const meta = JSON.parse(collectEntries(userData).find((e) => e.name === 'meta.json').data.toString());
  assert.ok(!meta.userData.includes(userData), 'meta.json 仍含绝对 userData 路径');
  assert.ok(meta.userData.startsWith('~'), 'meta.json userData 未脱敏为 HOME 相对表达');
  // 不在 HOME 下的路径原样保留（无权推断）
  assert.equal(redactUserDataPath('/opt/other'), '/opt/other');
});

await check('P0-7-c：diag:preview 返回将包含的内容清单', () => {
  const p = previewDiagPackage(userData);
  assert.ok(p.ok && Array.isArray(p.entries) && p.entries.length > 0, '清单为空');
  const names = p.entries.map((e) => e.name);
  assert.ok(names.includes('meta.json') && names.includes('audit/audit-log.jsonl'), '清单缺条目');
  assert.ok(p.entries.every((e) => typeof e.bytes === 'number' && e.bytes >= 0), '条目缺体积');
  assert.ok(p.totalBytes >= p.entries.reduce((n, e) => n + e.bytes, 0), '总体积不一致');
});

await check('P0-7-c：diag:export 回带 contents 清单', () => {
  registerDiagExportIpc();
  const h = electronStub._handlers.get('diag:export');
  return h({}).then((r) => {
    assert.ok(r.ok && Array.isArray(r.contents) && r.contents.includes('meta.json'), 'export 未回带内容清单');
    fs.rmSync(r.file, { force: true });
  });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ndiag-export: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
