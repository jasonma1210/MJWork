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

console.log(`\npackaging-config: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
