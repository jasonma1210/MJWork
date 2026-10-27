// 打包配置门禁（2026-10-27）
//
// 为什么这条要进门禁：体积裁剪全是「排除规则」，而排除规则一旦写宽，**打出来的包会在用户机器上
// 缺文件**——本地 npm run dev 一切正常（node_modules 齐全），打包后运行时才炸。
// 本套件只守两件事，但都是「打包后才能发现、发现时已经发版」的那类：
//   ① 运行时真正需要的文件**不得**被任何排除规则命中（尤其 sql.js 的 dist/sql-wasm.js + wasm）；
//   ② 关键的减体积规则必须还在（否则一次「顺手清空 files」就把 60MB 的冗余带回来了）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DESKTOP = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const files = pkg.build?.files || [];
const negatives = files.filter((f) => f.startsWith('!'));
const positives = files.filter((f) => !f.startsWith('!'));

/** 把 electron-builder 的 glob 子集转成正则（** / * / ? / {a,b}） */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1; // `**/` 也可匹配零层目录
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      out += `(?:${alts.join('|')})`;
      i = end;
    } else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`✅ ${name}`); }
  catch (e) { fail += 1; console.error(`❌ ${name} — ${e.message}`); }
};

// 运行时必需（缺了这些，打包版直接跑不起来）
const MUST_KEEP = [
  'main/main.js',
  'main/knowledgeBaseQuery.js',
  'main/kbParse.js',
  'main/ocrEngine.js',
  'agent-core/index.js',
  'shared-ipc/contract.mjs',
  'renderer/dist/index.html',
  'node_modules/sql.js/dist/sql-wasm.js',
  'node_modules/sql.js/dist/sql-wasm.wasm',
  'node_modules/zod/index.js',
  'node_modules/docx/build/index.js',
];

check('① 排除规则不会命中运行时必需文件（逐条 glob 求值，不靠肉眼）', () => {
  const regs = negatives.map((n) => globToRegExp(n.slice(1)));
  const hit = MUST_KEEP.filter((f) => regs.some((r) => r.test(f)));
  assert.deepEqual(hit, [], `以下必需文件被排除规则命中（打包后会缺失）：\n  ${hit.join('\n  ')}`);
});

check('① 反向自检：排除规则确实能命中该被排除的文件（否则这条门禁是空转）', () => {
  const regs = negatives.map((n) => globToRegExp(n.slice(1)));
  const shouldExclude = [
    'node_modules/sql.js/dist/sql-asm-debug.js',
    'node_modules/sql.js/dist/sqljs-all.zip',
    'node_modules/sql.js/dist/worker.sql-wasm.js',
    'node_modules/zod/src/index.ts',
    'node_modules/docx/README.md',
  ];
  const missed = shouldExclude.filter((f) => !regs.some((r) => r.test(f)));
  assert.deepEqual(missed, [], `以下文件应被排除却没被命中（体积会白白涨回去）：\n  ${missed.join('\n  ')}`);
});

check('② 正向清单必须完整覆盖运行时目录（漏一个目录 = 打包版缺整块功能）', () => {
  for (const dir of ['main', 'agent-core', 'shared', 'shared-ipc', 'renderer/dist']) {
    assert.ok(positives.some((p) => p.startsWith(`${dir}/`)), `files 缺少 ${dir}/**`);
  }
  assert.ok(positives.includes('package.json'), 'files 缺少 package.json');
});

check('③ sql-wasm.wasm 必须留在 asar 之外（sql.js 用 fs 读 wasm，asar 内路径它读不到）', () => {
  const unpack = pkg.build?.asarUnpack || [];
  assert.ok(unpack.some((u) => /sql-wasm\.wasm$/.test(u)), `asarUnpack 未包含 sql-wasm.wasm：${JSON.stringify(unpack)}`);
});

check('④ OCR 安装脚本存在且可从 npm scripts 调用（本地依赖要能被用户一键装好）', () => {
  const script = pkg.scripts?.['setup:ocr'];
  assert.ok(script, '缺少 npm run setup:ocr');
  const m = String(script).match(/scripts\/([\w.-]+)/);
  assert.ok(m, `setup:ocr 未指向 scripts/ 下的脚本：${script}`);
  assert.ok(fs.existsSync(path.join(DESKTOP, 'scripts', m[1])), `脚本文件不存在：scripts/${m[1]}`);
});

// ── ⑤⑥ 随包 OCR：三个位置必须是**同一个目录名**，且打包顺序不能颠倒 ──────────────
//
// 为什么这三方要一起断言：OCR 随包是三处独立写的字面量 ——
//   生成方 scripts/bundle-ocr.mjs 写进 build/ocr；
//   声明方 package.json 的 mac.extraResources 把 build/ocr 映射成 resources/<to>；
//   使用方 main/ocrEngine.js 去 process.resourcesPath/<dir> 找可执行文件与 tessdata。
// 任意一处改名，另外两处都不会报错：本地 dev 走 Homebrew 的 tesseract 一切正常，
// 只有**打包后的 App**才显示「OCR 不可用」—— 又是「本地绿、发版炸」那一类。
// 所以这里不变量测 package.json 自己，而是把 ocrEngine 源码里的实际查找目录读出来做交叉比对。
check('⑤ 随包 OCR 三方目录一致（生成方 == 声明方 == 使用方）', () => {
  const engine = fs.readFileSync(path.join(DESKTOP, 'main', 'ocrEngine.js'), 'utf8');
  // 使用方：ocrEngine 里所有 process.resourcesPath/<dir> 探测
  const lookupDirs = [...engine.matchAll(/path\.join\(process\.resourcesPath,\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(
    new Set(lookupDirs).size >= 1,
    `ocrEngine 里没解析出任何 resourcesPath 探测（命中 ${lookupDirs.length} 处）—— 这条断言已空转`,
  );

  // 声明方
  const macRes = pkg.build?.mac?.extraResources || [];
  const entry = macRes.find((e) => e && typeof e.to === 'string' && /ocr/i.test(String(e.to)));
  assert.ok(entry, `mac.extraResources 未声明 OCR 随包目录（当前 ${JSON.stringify(macRes)}）`);
  assert.ok(
    lookupDirs.includes(entry.to),
    `package.json 把 OCR 放到 resources/${entry.to}，而 ocrEngine 只查 resources/{${[...new Set(lookupDirs)].join(',')}} —— 打包版会显示 OCR 不可用`,
  );

  // 使用方还必须找 tessdata（只拷二进制不拷语言包 = 引擎能起来但识别报「找不到语言」）
  assert.ok(
    engine.includes(`path.join(process.resourcesPath, '${entry.to}', 'tessdata')`),
    `ocrEngine 未在 resources/${entry.to}/tessdata 找语言包`,
  );

  // 生成方
  const bundleSrc = fs.readFileSync(path.join(DESKTOP, 'scripts', 'bundle-ocr.mjs'), 'utf8');
  const m = bundleSrc.match(/path\.join\(DESKTOP,\s*'([^']+)',\s*'([^']+)'\)/);
  assert.ok(m, 'bundle-ocr.mjs 里找不到产物目录定义（DESKTOP/build/ocr）');
  const produced = path.posix.join(m[1], m[2]);
  assert.equal(
    path.posix.normalize(String(entry.from)).replace(/\/$/, ''),
    produced,
    `extraResources.from=${entry.from} 与 bundle-ocr 的产物目录 ${produced} 不一致（打包会缺整个 OCR 目录）`,
  );
});

check('⑤ 反向自检：改名后这条断言确实会红（否则它只是在读两个自己写的常量）', () => {
  const engine = fs.readFileSync(path.join(DESKTOP, 'main', 'ocrEngine.js'), 'utf8');
  const dirs = [...engine.matchAll(/path\.join\(process\.resourcesPath,\s*'([^']+)'/g)].map((m) => m[1]);
  const bogus = 'ocr-renamed';
  assert.ok(!dirs.includes(bogus), '反例目录名居然真的被 ocrEngine 使用，换一个反例');
  const macRes = pkg.build?.mac?.extraResources || [];
  assert.ok(
    !macRes.some((e) => e && e.to === bogus),
    '把 resources 目录改成反例名竟然也通过 —— 说明断言没在比对这个值',
  );
});

check('⑥ 打包脚本必须先 bundle:ocr 再 electron-builder（顺序颠倒 = 打进空目录）', () => {
  for (const key of ['build', 'dist:dir', 'dist:mac']) {
    const cmd = String(pkg.scripts?.[key] || '');
    const iBundle = cmd.indexOf('bundle:ocr');
    const iBuilder = cmd.indexOf('electron-builder');
    assert.ok(iBundle >= 0, `${key} 未调用 bundle:ocr（OCR 不会被重建，冷机器上 extraResources 源目录不存在）`);
    assert.ok(iBundle < iBuilder, `${key} 里 bundle:ocr 必须在 electron-builder 之前：${cmd}`);
  }
  const bundleScript = String(pkg.scripts?.['bundle:ocr'] || '');
  assert.ok(/scripts\/bundle-ocr\.mjs/.test(bundleScript), `bundle:ocr 未指向 scripts/bundle-ocr.mjs：${bundleScript}`);
  assert.ok(fs.existsSync(path.join(DESKTOP, 'scripts', 'bundle-ocr.mjs')), 'scripts/bundle-ocr.mjs 不存在');
  // 只有 mac 需要它：写到 mac.extraResources，其他平台 target 不该被这条字符串污染
  assert.ok(
    !(pkg.build?.extraResources || []).some((e) => e && /ocr/.test(String(e.to))),
    'OCR 应只挂在 mac.extraResources（dylib 改写是 Darwin 专有），不要写进跨平台 extraResources',
  );
});

console.log(`\npackaging-config: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
