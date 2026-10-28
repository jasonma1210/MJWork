// smoke-packaged 的自证伪测试：证明每条断言都有判别力。
//
// 为什么需要它：一个「只会在产物健康时打印 ✅」的脚本，和没有脚本是一样的。
// 本测试造一个**可控的最小合法产物**，先证基线全绿，再逐条破坏，确认对应断言变红。
//
// 做法说明：真实挂载的 dmg 是只读的，无法就地破坏；所以造一个结构等价的假产物。
// 它验证的是「断言逻辑」而非「真实产物健康度」——后者由 CI 上的真产物冒烟负责。
//
// 运行：node test/manual/smoke-packaged-selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SMOKE = path.join(ROOT, 'scripts', 'smoke-packaged.mjs');

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${PKG.version}</string>
</dict></plist>
`;

/** 造一个结构合法的 .app；overrides 用于在 return 前做破坏性改动 */
function makeApp(name, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mj-app-${name}-`));
  const app = path.join(root, 'MJ Coder.app');
  const res = path.join(app, 'Contents', 'Resources');
  const w = (rel, content, mode) => {
    const p = path.join(res, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    if (mode) fs.chmodSync(p, mode);
    return p;
  };
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), PLIST);
  // 代码载体（解包形态）
  w('app/main/main.js', '/* entry */');
  w('app/main/preload.js', '/* bridge */');
  w('app/renderer/dist/index.html', '<html></html>');
  w('app/agent-core/index.js', '/* kernel */');
  w('app/package.json', JSON.stringify({ version: PKG.version }));
  w('app/node_modules/sql.js/dist/sql-wasm.wasm', Buffer.alloc(20000, 1));
  // extraResources
  w('ecosystem/skills/demo.md', '# demo');
  // OCR（mac 专属）：二进制可执行 + tessdata 子目录
  w('ocr/tesseract', '#!/bin/sh\n', 0o755);
  w('ocr/tessdata/eng.traineddata', Buffer.alloc(2000, 2));
  // 更新配置
  w('app-update.yml', 'owner: jasonma1210\nrepo: MJCoder\nprovider: github\n');
  if (mutate) mutate({ root, app, res, w });
  return { root, app };
}

/** 跑冒烟，返回 { code, out } */
function run(target) {
  try {
    const out = execFileSync(process.execPath, [SMOKE, '--artifact', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

let ok = 0;
let bad = 0;
const cleanup = [];
const report = (name, pass, detail) => {
  if (pass) { ok++; console.log(`✅ ${name}`); } else { bad++; console.error(`❌ ${name} — ${detail}`); }
};

// ── 基线：结构合法 ⇒ R0-R9 必须全绿 ──
{
  const { root, app } = makeApp('base');
  cleanup.push(root);
  const { code, out } = run(app);
  // R9 读仓库 package.json 的 build.win.verifyUpdateCodeSignature。
  // 2026-10-28：该值已由 true（空转）改为 false（未签名阶段明确关闭），故 R9 应绿。
  const allGreen = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']
    .every((k) => out.includes(`✅ ${k}`));
  report('基线：R0-R9 全绿（R9 = verify off，未签名阶段不假装有校验）', allGreen && code === 0,
    `code=${code} 未通过项=${['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'].filter((k) => !out.includes(`✅ ${k}`)).join(',') || '无'}`);
}

// ── 逐条破坏 ──
const cases = [
  ['R2 缺 preload 必须红', 'R2', (m) => fs.unlinkSync(path.join(m.res, 'app/main/preload.js'))],
  ['R3 删 sql-wasm.wasm 必须红', 'R3', (m) => fs.unlinkSync(path.join(m.res, 'app/node_modules/sql.js/dist/sql-wasm.wasm'))],
  ['R3 wasm 被截断（体积过小）必须红', 'R3', (m) => fs.writeFileSync(path.join(m.res, 'app/node_modules/sql.js/dist/sql-wasm.wasm'), Buffer.alloc(100))],
  ['R4 包内版本与仓库不一致必须红', 'R4', (m) => fs.writeFileSync(path.join(m.res, 'app/package.json'), JSON.stringify({ version: '0.0.1-old' }))],
  ['R5 Info.plist 版本不一致必须红', 'R5', (m) => fs.writeFileSync(path.join(m.app, 'Contents/Info.plist'), PLIST.replace(PKG.version, '9.9.9'))],
  ['R6 缺 ecosystem 必须红', 'R6', (m) => fs.rmSync(path.join(m.res, 'ecosystem'), { recursive: true, force: true })],
  ['R7 OCR 缺 traineddata 必须红', 'R7', (m) => fs.rmSync(path.join(m.res, 'ocr/tessdata'), { recursive: true, force: true })],
  ['R7 tesseract 无可执行位必须红', 'R7', (m) => fs.chmodSync(path.join(m.res, 'ocr/tesseract'), 0o644)],
  ['R8 缺 app-update.yml 必须红', 'R8', (m) => fs.unlinkSync(path.join(m.res, 'app-update.yml'))],
  ['R1 既无 asar 也无 app/ 必须红', 'R1', (m) => fs.rmSync(path.join(m.res, 'app'), { recursive: true, force: true })],
];

for (const [name, expect, mutate] of cases) {
  const m = makeApp(name.replace(/[^\w]/g, ''), mutate);
  cleanup.push(m.root);
  const { code, out } = run(m.app);
  const hit = out.includes(`❌ ${expect}`);
  report(name, code !== 0 && hit, `code=${code} 命中=${hit}`);
}

// ── 找不到产物时必须红（防「CI 没产物但脚本绿」）──
{
  const { code, out } = run(path.join(os.tmpdir(), 'mj-definitely-not-here-404'));
  report('无产物且未加 --allow-missing 必须红（fail-closed）',
    code !== 0 && /指定的产物不存在|未找到/.test(out), `code=${code}`);
}

// ── --allow-missing 时明确跳过（打印"没检查"而非"健康"）──
{
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [SMOKE, '--artifact', path.join(os.tmpdir(), 'nope-404'), '--allow-missing'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status ?? 1; out = `${e.stdout || ''}`; }
  report('--allow-missing 时跳过且明确声明"没检查"',
    code === 0 && /不代表产物健康/.test(out), `code=${code}`);
}

// ── R9 条件断言：verify=true 却无 publisherName 必须红（校验恒空转）──
// 用 --pkg 指向一份伪造的 package.json，不动仓库文件。
{
  const m = makeApp('r9', () => {});
  cleanup.push(m.root);
  const fakePkg = path.join(m.root, 'pkg-verify-on.json');
  fs.writeFileSync(fakePkg, JSON.stringify({
    version: PKG.version,
    build: { win: { verifyUpdateCodeSignature: true } }, // 故意不写 publisherName
  }));
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [SMOKE, '--artifact', m.app, '--pkg', fakePkg],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status ?? 1; out = `${e.stdout || ''}${e.stderr || ''}`; }
  report('R9 verify=true 且无 publisherName 必须红（否则门禁空转）',
    code !== 0 && out.includes('❌ R9'), `code=${code}`);
  // 反向：verify=true 且给了 publisherName ⇒ 应绿（不能一补 publisherName 就永远红）
  const fakePkg2 = path.join(m.root, 'pkg-verify-on-ok.json');
  fs.writeFileSync(fakePkg2, JSON.stringify({
    version: PKG.version,
    build: { win: { verifyUpdateCodeSignature: true, publisherName: 'Jason Ma' } },
  }));
  let code2 = 0;
  try {
    execFileSync(process.execPath, [SMOKE, '--artifact', m.app, '--pkg', fakePkg2],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code2 = e.status ?? 1; }
  report('R9 verify=true 且 publisherName 齐备 ⇒ 放行（不能过度收紧）', code2 === 0, `code=${code2}`);
}

for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }

console.log(`\n自证伪：${ok} 条成立 / ${bad} 条异常`);
if (bad > 0) process.exitCode = 1;
