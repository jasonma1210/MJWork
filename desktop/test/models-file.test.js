// 自定义模型配置文件（modelsFile.js）测试：解析校验 / WorkBuddy 格式兼容 / 同步对账幂等 / 剪除
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalStore } = require('../main/store/localStore');
const {
  fileKeyFor, toBaseUrl, parseModelsFile, templateContent, ensureModelsFile, syncFileModels,
  serializeProviders, migrateLocalProviders, removeModelFromRaw, removeProviderFromRaw, addModelToRaw,
} = require('../main/modelsFile');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 最小加密桩：与 LocalStore 解耦（sync 只要求 encrypt(plain)->cipher 可逆性由真实 CredentialCrypto 保证）
const encrypt = (k) => `enc(${k})`;

function makeStore() {
  return new LocalStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-mf-')));
}

(async () => {
  // ── 1. 解析：合法条目 + url 归一 + 能力字段 ──
  const raw1 = JSON.stringify([
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4 Flash', vendor: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-test-1', supportsToolCall: true, supportsImages: false, supportsReasoning: true },
  ]);
  const r1 = parseModelsFile(raw1);
  check('解析：1 个 provider / 0 错误', r1.providers.length === 1 && r1.errors.length === 0);
  check('解析：完整端点剥成 base_url', r1.providers[0].base_url === 'https://api.deepseek.com');
  check('解析：模型 id/显示名/能力归一',
    r1.providers[0].models[0].modelId === 'deepseek-v4-flash'
    && r1.providers[0].models[0].displayName === 'DeepSeek-V4 Flash'
    && r1.providers[0].models[0].caps.supportsToolCall === true
    && r1.providers[0].models[0].caps.supportsReasoning === true);
  check('解析：provider 名取 vendor', r1.providers[0].name === 'DeepSeek');

  // ── 2. 同 url+Key 归并多模型；不同 Key 分provider ──
  const raw2 = JSON.stringify([
    { id: 'm1', url: 'http://127.0.0.1:1234/v1', apiKey: 'demo' },
    { id: 'm2', name: '模型二', url: 'http://127.0.0.1:1234/v1', apiKey: 'demo' },
    { id: 'm3', url: 'http://127.0.0.1:1234/v1', apiKey: 'other' },
  ]);
  const r2 = parseModelsFile(raw2);
  check('归并：同 url+Key 合为一个 provider（2 模型），不同 Key 分开（共 2 provider）',
    r2.providers.length === 2
    && r2.providers[0].models.length === 2
    && r2.providers[1].models.length === 1,
    JSON.stringify(r2.providers.map((p) => p.models.length)));

  // ── 3. apiKeyEnv 间接引用 + 环境变量缺失告警 ──
  const raw3 = JSON.stringify([{ id: 'env-model', url: 'https://api.x.com/v1', apiKeyEnv: 'MY_TEST_KEY_X' }]);
  const r3a = parseModelsFile(raw3, { env: { MY_TEST_KEY_X: 'sk-from-env' } });
  check('apiKeyEnv：从环境变量取 Key', r3a.providers[0].apiKey === 'sk-from-env' && r3a.errors.length === 0);
  const r3b = parseModelsFile(raw3, { env: {} });
  check('apiKeyEnv：变量缺失仍导入但告警', r3b.providers.length === 1 && r3b.providers[0].apiKey === '' && r3b.errors.length === 1);

  // ── 4. 非法输入：坏 JSON / 非数组 / 缺 id / 缺 url ──
  check('校验：坏 JSON 报错', parseModelsFile('{oops').errors.length === 1);
  check('校验：非数组报错', parseModelsFile('{"a":1}').errors.length === 1);
  const r4 = parseModelsFile(JSON.stringify([{ url: 'https://x.com' }, { id: 'ok', url: 'not-a-url' }, { id: 'good', url: 'https://y.com/v1' }]));
  check('校验：坏条目逐条报错，好条目照常导入', r4.errors.length === 2 && r4.providers.length === 1 && r4.providers[0].models[0].modelId === 'good');

  // ── 5. 同步对账：新增 → 更新 → 剪除 → 幂等 ──
  const store = makeStore();
  const vault = new Map();
  const sync = (raw) => syncFileModels({ store, encrypt, vault, raw, filePath: '/tmp/never-written.json' });

  const first = sync(JSON.stringify([
    { id: 'm1', url: 'https://a.com/v1', apiKey: 'k1' },
    { id: 'm2', url: 'https://a.com/v1', apiKey: 'k1' },
  ]));
  check('同步：首次导入 1 provider（2 模型）', first.synced === 1 && first.removed.length === 0 && store.listProviders().length === 1);
  const p1 = store.listProviders()[0];
  check('同步：provider 带 source=file 标记与 models 列表', p1.source === 'file' && p1.models.length === 2);
  check('同步：Key 注入 vault（明文不出现在 store）', vault.get(p1.id)?.api_key === 'k1' && p1.keyEncrypted === undefined);
  check('同步：store 内加密形态正确', store.getProviderKey(p1.id) === 'enc(k1)');

  // 文件改动：m1/m2 改名 + 新增 m3 → 同一 fileKey 复用同一 provider，不产生重复
  const second = sync(JSON.stringify([
    { id: 'm1', name: '改名一', url: 'https://a.com/v1', apiKey: 'k1' },
    { id: 'm2', url: 'https://a.com/v1', apiKey: 'k1' },
    { id: 'm3', url: 'https://a.com/v1', apiKey: 'k1' },
  ]));
  check('同步：文件改动后仍是 1 个 provider（复用身份）', store.listProviders().length === 1 && second.synced === 1);
  const p1b = store.listProviders()[0];
  check('同步：模型列表整体更新（3 个，含改名）', p1b.models.length === 3 && p1b.models.some((m) => m.displayName === '改名一'));

  // 条目从文件消失 → provider 剪除；vault 同步清理由调用方（main）负责，此处验证 store 侧
  const third = sync(JSON.stringify([{ id: 'm9', url: 'https://b.com/v1', apiKey: 'k2' }]));
  check('同步：消失条目被剪除（旧 1 删、新 1 入）', third.removed.length === 1 && store.listProviders().length === 1 && store.listProviders()[0].base_url === 'https://b.com/v1');

  // 幂等：同内容重复 sync 不再增删
  const fourth = sync(JSON.stringify([{ id: 'm9', url: 'https://b.com/v1', apiKey: 'k2' }]));
  check('同步：重复 sync 幂等（无新增无剪除）', fourth.synced === 1 && fourth.removed.length === 0 && store.listProviders().length === 1);

  // 手工添加的 provider 不受剪除影响
  store.addProvider({ name: '手工', base_url: 'https://c.com', keyEncrypted: 'enc(x)', modelId: 'mm' });
  sync(JSON.stringify([{ id: 'm9', url: 'https://b.com/v1', apiKey: 'k2' }]));
  check('同步：UI 手工添加的 provider 不被文件同步误删', store.listProviders().length === 2);

  // ── 6. 模板与 ensureModelsFile ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-mf-tpl-'));
  const tplPath = path.join(dir, 'models.json');
  const created = ensureModelsFile(tplPath);
  check('模板：文件创建成功且 JSON 可解析为数组', created.created === true && Array.isArray(JSON.parse(fs.readFileSync(tplPath, 'utf8'))));
  const again = ensureModelsFile(tplPath);
  check('模板：已存在时不覆盖', again.created === false);
  check('模板：内容不含真实 Key（占位符）', templateContent().includes('请替换成你的Key'));
  const mode = fs.statSync(tplPath).mode & 0o777;
  check('模板：文件权限 0600（含 Key 的文件不组/众可读）', mode === 0o600, `mode=${mode.toString(8)}`);

  // ── 7. fileKey 稳定性 ──
  check('fileKey：同输入同输出、异输入异输出',
    fileKeyFor('https://a.com', 'k1') === fileKeyFor('https://a.com', 'k1')
    && fileKeyFor('https://a.com', 'k1') !== fileKeyFor('https://a.com', 'k2'));

  // ── 8. 分组格式（v2）：一个 base_url + 一个 Key + 多 ModelId ──
  const rawGrouped = JSON.stringify([
    { name: 'deepseek', url: 'https://api.deepseek.com', apiKey: 'sk-g1', models: ['deepseek-flash', { id: 'deepseek-v4-pro', name: 'V4 Pro' }] },
    { name: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1/', apiKeyEnv: 'G2_KEY', models: ['mimo-v2.6-flash'] },
  ]);
  const rg = parseModelsFile(rawGrouped, { env: { G2_KEY: 'sk-g2' } });
  check('分组解析：2 个 provider，主组 2 个模型', rg.providers.length === 2 && rg.providers[0].models.length === 2);
  check('分组解析：模型对象项保留 displayName', rg.providers[0].models[1].displayName === 'V4 Pro');
  check('分组解析：baseUrl 别名 + 尾斜杠归一', rg.providers[1].base_url === 'https://api.xiaomimimo.com/v1');
  check('分组解析：apiKeyEnv 生效', rg.providers[1].apiKey === 'sk-g2');
  const rgCaps = parseModelsFile(JSON.stringify([
    { url: 'https://x.com/v1', models: [{ id: 'm1', supportsToolCall: false, supportsReasoning: true }] },
  ]));
  check('分组解析：模型项能力字段生效', rgCaps.providers[0].models[0].caps.supportsToolCall === false && rgCaps.providers[0].models[0].caps.supportsReasoning === true);

  // 混合：分组条目 + 扁平条目共存；扁平条目同 url+Key 归并进分组组
  const rMixed = parseModelsFile(JSON.stringify([
    { name: 'g', url: 'https://a.com/v1', apiKey: 'k', models: ['m1'] },
    { id: 'm2', url: 'https://a.com/v1', apiKey: 'k' },
  ]));
  check('混合格式：扁平条目归并进同 url+Key 分组', rMixed.providers.length === 1 && rMixed.providers[0].models.length === 2);

  // ── 9. Key 含非 ASCII（模板占位中文）→ 解析告警 ──
  const rCjk = parseModelsFile(JSON.stringify([{ url: 'https://x.com/v1', apiKey: 'sk-请替换成你的Key', models: ['m1'] }]));
  check('非 ASCII Key：产生解析告警且仍导入', rCjk.errors.length === 1 && rCjk.providers.length === 1);

  // ── 10. 序列化往返 ──
  const round = parseModelsFile(serializeProviders(rg.providers));
  check('序列化往返：分组格式写出后可无损解析回 2 provider / 3 模型',
    round.providers.length === 2 && round.providers[0].models.length === 2 && round.providers[1].models.length === 1
    && round.providers[0].apiKey === 'sk-g1');

  // ── 11. 迁移：UI provider → 配置文件（并入已有组 / 新增组 / 模型去重）──
  const store2 = makeStore();
  const uiA = store2.addProvider({ name: 'deepseek', base_url: 'https://api.deepseek.com', keyEncrypted: 'enc(k-ds)', modelId: 'deepseek-flash' });
  store2.addProviderModel(uiA.id, { model_id: 'deepseek-v4-pro' });
  const uiB = store2.addProvider({ name: 'mimo', base_url: 'https://api.xiaomimimo.com/v1', keyEncrypted: 'enc(k-mimo)', modelId: 'mimo-v2.6-flash' });
  const dec = (enc) => ({ 'enc(k-ds)': 'sk-ds', 'enc(k-mimo)': 'sk-mimo' }[enc] || '');
  const fileRaw = serializeProviders(parseModelsFile(JSON.stringify([
    { name: 'deepseek', url: 'https://api.deepseek.com', apiKey: 'sk-ds', models: ['deepseek-flash'] },
  ])).providers);
  const mig = migrateLocalProviders({ raw: fileRaw, providers: store2.listProviders().map((p) => ({ ...p, keyEncrypted: store2.getProviderKey(p.id) })), decrypt: dec });
  const migratedStore = makeStore();
  const migSync = syncFileModels({ store: migratedStore, encrypt, vault: new Map(), raw: mig.raw });
  check('迁移：deepseek 并入已有组（同 url+Key），mimo 新增组',
    mig.migrated.length === 2 && mig.migrated[0].matched === true && mig.migrated[1].matched === false);
  check('迁移：文件承载 2 provider / 3 模型（deepseek 两模型并入，模型去重）',
    migSync.synced === 2 && migratedStore.listProviders().reduce((n, p) => n + p.models.length, 0) === 3);

  // ── 12. 文件写回：删模型 / 删组 / 加模型 ──
  const gKey = parseModelsFile(mig.raw).providers.find((g) => g.base_url === 'https://api.deepseek.com').fileKey;
  const rm1 = removeModelFromRaw(mig.raw, gKey, 'deepseek-v4-pro');
  check('写回：删除组内一个模型', rm1.ok && parseModelsFile(rm1.raw).providers.find((g) => g.base_url === 'https://api.deepseek.com').models.length === 1);
  const rmAll = removeModelFromRaw(rm1.raw, gKey, 'deepseek-flash');
  check('写回：删掉组内最后一个模型时整组移除', rmAll.ok && !parseModelsFile(rmAll.raw).providers.some((g) => g.base_url === 'https://api.deepseek.com'));
  const rmErr = removeModelFromRaw(mig.raw, 'f-notexist', 'x');
  check('写回：fileKey 不存在报错', rmErr.ok === false && !!rmErr.error);
  const add1 = addModelToRaw(rm1.raw, gKey, 'deepseek-new', '新模型');
  check('写回：添加模型（含显示名）', add1.ok && parseModelsFile(add1.raw).providers.find((g) => g.base_url === 'https://api.deepseek.com').models.some((m) => m.modelId === 'deepseek-new' && m.displayName === '新模型'));
  const addDup = addModelToRaw(add1.raw, gKey, 'deepseek-new', '');
  check('写回：重复模型报错', addDup.ok === false);
  const rmProvider = removeProviderFromRaw(mig.raw, parseModelsFile(mig.raw).providers.find((g) => g.base_url === 'https://api.xiaomimimo.com/v1').fileKey);
  check('写回：删除整组 provider', rmProvider.ok && parseModelsFile(rmProvider.raw).providers.length === 1);

  // ── 13. P1-14：明文 Key 文件原子写 + .bak 备份 + 防级联清空 ──
  const { writeModelsFile, readModelsFile } = require('../main/modelsFile');
  const atomicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-mf-atomic-'));
  const atomicPath = path.join(atomicDir, 'models.json');
  const content1 = serializeProviders(parseModelsFile(JSON.stringify([
    { name: 'svc-a', url: 'https://a.com/v1', apiKey: 'sk-a', models: ['m1'] },
  ])).providers);
  const content2 = serializeProviders(parseModelsFile(JSON.stringify([
    { name: 'svc-b', url: 'https://b.com/v1', apiKey: 'sk-b', models: ['m2'] },
  ])).providers);

  writeModelsFile(content1, atomicPath);
  check('P1-14 原子写：首次写入内容正确', readModelsFile(atomicPath) === content1);
  check('P1-14 原子写：无残留 tmp 文件',
    !fs.readdirSync(atomicDir).some((f) => f.endsWith('.tmp')), fs.readdirSync(atomicDir).join(','));
  check('P1-14 原子写：文件权限 0600',
    (fs.statSync(atomicPath).mode & 0o777) === 0o600, `mode=${(fs.statSync(atomicPath).mode & 0o777).toString(8)}`);

  writeModelsFile(content2, atomicPath);
  check('P1-14 备份：二次写入后 .bak 保留上一次内容',
    fs.existsSync(`${atomicPath}.bak`) && fs.readFileSync(`${atomicPath}.bak`, 'utf8') === content1);
  check('P1-14 备份：目标文件为新内容', readModelsFile(atomicPath) === content2);

  // 写失败（目标路径被占为目录）→ 抛错且 .bak 不被动
  const blockDir = path.join(atomicDir, 'blocked');
  fs.mkdirSync(blockDir);
  let writeErr = null;
  try { writeModelsFile(content2, blockDir); } catch (e) { writeErr = e; }
  check('P1-14 写失败：如实抛错（不静默吞）', !!writeErr && /写入失败/.test(writeErr.message));
  check('P1-14 写失败：错误信息指引 .bak 恢复', !!writeErr && writeErr.message.includes('.bak'));

  // 防级联：解析失败时保留 store 内全部文件来源模型，不清空
  const cascadeStore = makeStore();
  const cascadeVault = new Map();
  const goodRaw = JSON.stringify([{ id: 'keep-1', url: 'https://keep.com/v1', apiKey: 'k-keep' }]);
  const firstSync = syncFileModels({ store: cascadeStore, encrypt, vault: cascadeVault, raw: goodRaw, filePath: '/tmp/never-written.json' });
  check('P1-14 防级联：正常同步先导入 1 个 provider', firstSync.synced === 1 && cascadeStore.listProviders().length === 1);
  const badSync = syncFileModels({ store: cascadeStore, encrypt, vault: cascadeVault, raw: '{broken json!!', filePath: '/tmp/never-written.json' });
  check('P1-14 防级联：坏 JSON 同步返回 parseFailed 且 ok=false',
    badSync.parseFailed === true && badSync.ok === false && badSync.errors.length > 0);
  check('P1-14 防级联：坏 JSON 不清空模型来源（provider 仍在）',
    cascadeStore.listProviders().length === 1 && cascadeStore.listProviders()[0].base_url === 'https://keep.com/v1');
  check('P1-14 防级联：坏 JSON 不产生剪除记录', badSync.removed.length === 0);

  // 条目全非法（非对象/缺 url）同样不清空
  const allBadSync = syncFileModels({ store: cascadeStore, encrypt, vault: cascadeVault, raw: JSON.stringify([{ nope: 1 }, { id: 'x' }]), filePath: '/tmp/never-written.json' });
  check('P1-14 防级联：条目全非法也不清空（parseFailed）',
    allBadSync.parseFailed === true && cascadeStore.listProviders().length === 1);

  // 用户主动清空文件（合法空数组）仍按剪除语义生效——防级联不伤害「有意删除」
  const emptySync = syncFileModels({ store: cascadeStore, encrypt, vault: cascadeVault, raw: '[]', filePath: '/tmp/never-written.json' });
  check('P1-14 防级联：合法空数组仍执行剪除（用户有意删除不受影响）',
    emptySync.parseFailed === undefined && emptySync.removed.length === 1 && cascadeStore.listProviders().length === 0);

  fs.rmSync(atomicDir, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
