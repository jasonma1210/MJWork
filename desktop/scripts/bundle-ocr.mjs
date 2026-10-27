#!/usr/bin/env node
// 把本机 tesseract 打成「自包含目录」（随包发布用）
//
// 为什么需要这一步：Homebrew 装的 tesseract 链接的是 /opt/homebrew/... 的绝对路径 dylib。
// 直接复制二进制到 App 里会立刻 `dyld: Library not loaded` —— 不是路径问题，是**加载指令**问题。
// 所以这里做三件事：① 递归拷贝依赖闭包；② 用 install_name_tool 把对外引用改写成
// @executable_path/lib / @loader_path；③ 逐个重签名（改了 Mach-O 签名即失效，不重签会被 Gatekeeper 拦）。
//
// 两个容易栽的细节（首版都踩过，留档）：
//   · 依赖表的键必须是**引用名**（install name 的 basename），不是真实文件名：
//     Homebrew 里 libwebp.7.dylib 的真实文件常叫 libwebp.7.2.0.dylib，
//     按真实名建表会让 `@rpath/libwebp.7.dylib` 这类引用找不到。
//   · 别的 dylib 会用 `@rpath/xxx` 引用，必须按引用方的 LC_RPATH 自行解析，不能让 dyld 去猜。
//
// 产物：desktop/build/ocr/{tesseract, lib/*.dylib, tessdata/*.traineddata}
// 用法：node scripts/bundle-ocr.mjs [--langs chi_sim,chi_tra,eng,osd] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DESKTOP = path.resolve(import.meta.dirname, '..');
const OUT = path.join(DESKTOP, 'build', 'ocr');
const FORCE = process.argv.includes('--force');
const langArg = (() => {
  const i = process.argv.indexOf('--langs');
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : 'chi_sim,chi_tra,eng,osd';
})();
const LANGS = langArg.split(',').map((s) => s.trim()).filter(Boolean);

// 只在 macOS 上有意义：otool / install_name_tool / codesign 都是 Darwin 工具，
// dylib 路径改写这套做法在别的平台根本不成立。提前说清楚，别让 dist:win/linux 撞上来才报「命令不存在」。
if (process.platform !== 'darwin') {
  console.error(`❌ bundle-ocr 仅支持 macOS（当前 ${process.platform}）。其他平台请走各自的分发方式。`);
  process.exit(1);
}

const isSystem = (p) => p.startsWith('/usr/lib/') || p.startsWith('/System/');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
function must(cmd, args, what) {
  const r = run(cmd, args);
  if (r.status !== 0) throw new Error(`${what || cmd} 失败：${r.stderr || r.stdout}`);
  return r.stdout;
}

function which(bin) {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/bin', ...String(process.env.PATH || '').split(':')];
  for (const d of dirs) {
    const p = path.join(d, bin);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* 跳过 */ }
  }
  return null;
}

const tessBin = which('tesseract');
if (!tessBin) {
  console.error('❌ 本机没有 tesseract，先跑 npm run setup:ocr');
  process.exit(1);
}

/** otool -L 的非系统依赖（保留 @rpath 形式） */
function depsOf(file) {
  const out = must('/usr/bin/otool', ['-L', file], `otool -L ${file}`);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' ')[0])
    .filter((p) => p && (p.startsWith('/') || p.startsWith('@rpath/')) && !isSystem(p));
}

/** 该文件的 LC_RPATH 目录列表 */
function rpathsOf(file) {
  const out = run('/usr/bin/otool', ['-l', file]).stdout || '';
  const dirs = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*path (\S+) \(offset \d+\)/);
    if (m) dirs.push(m[1]);
  }
  return dirs;
}

/** 解析 @rpath/xxx：引用方自己的 LC_RPATH → Homebrew 默认 → 同目录 */
function resolvePath(file, ref) {
  if (!ref.startsWith('@rpath/')) return ref;
  const base = path.basename(ref);
  const dirs = [...rpathsOf(file), '/opt/homebrew/lib', '/usr/local/lib', path.dirname(file)];
  for (const d of dirs) {
    const cand = path.join(d, base);
    try { if (fs.existsSync(cand)) return cand; } catch { /* 继续 */ }
  }
  return null;
}

// ① 依赖闭包（键 = 引用名）
const queue = [fs.realpathSync(tessBin)];
const libs = new Map();
const unresolved = [];
while (queue.length) {
  const f = queue.shift();
  for (const dep of depsOf(f)) {
    const key = path.basename(dep);
    if (libs.has(key)) continue;
    const resolved = resolvePath(f, dep);
    if (!resolved) { unresolved.push({ from: f, dep }); continue; }
    let real;
    try { real = fs.realpathSync(resolved); } catch { unresolved.push({ from: f, dep }); continue; }
    libs.set(key, real);
    queue.push(real);
  }
}
if (unresolved.length) {
  console.error('❌ 有依赖解析不到（打包会缺库）：');
  for (const u of unresolved) console.error(`   ${path.basename(u.from)} 需要 ${u.dep}`);
  process.exit(1);
}
console.log(`tesseract: ${tessBin}`);
console.log(`依赖库 ${libs.size} 个：${[...libs.keys()].join(' ')}`);

// ② 铺目录
if (FORCE && fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'tessdata'), { recursive: true });
const binOut = path.join(OUT, 'tesseract');
fs.copyFileSync(fs.realpathSync(tessBin), binOut);
fs.chmodSync(binOut, 0o755);
for (const [refName, src] of libs) fs.copyFileSync(src, path.join(OUT, 'lib', refName));

// ③ 改写加载路径 + 重签名
function rewrite(file, prefix) {
  for (const dep of depsOf(file)) {
    const base = path.basename(dep);
    if (!libs.has(base)) continue;
    must('/usr/bin/install_name_tool', ['-change', dep, `${prefix}/${base}`, file], `install_name_tool -change ${base}`);
  }
  must('/usr/bin/codesign', ['-f', '-s', '-', file], `codesign ${path.basename(file)}`);
}
rewrite(binOut, '@executable_path/lib');
for (const [refName] of libs) {
  const f = path.join(OUT, 'lib', refName);
  must('/usr/bin/install_name_tool', ['-id', `@loader_path/${refName}`, f], `install_name_tool -id ${refName}`);
  rewrite(f, '@loader_path');
}

// ④ 语言包（只带用得上的；全量 tessdata 676MB 没必要）
const tessdataSrc = ['/opt/homebrew/share/tessdata', '/usr/local/share/tessdata', '/usr/share/tesseract-ocr/5/tessdata']
  .find((d) => { try { return fs.existsSync(path.join(d, 'eng.traineddata')); } catch { return false; } });
if (!tessdataSrc) {
  console.error('❌ 找不到 tessdata 目录');
  process.exit(1);
}
let dataBytes = 0;
for (const lang of LANGS) {
  const src = path.join(tessdataSrc, `${lang}.traineddata`);
  if (!fs.existsSync(src)) { console.error(`⚠ 缺少语言包 ${lang}`); continue; }
  const dst = path.join(OUT, 'tessdata', `${lang}.traineddata`);
  fs.copyFileSync(fs.realpathSync(src), dst);
  dataBytes += fs.statSync(dst).size;
}
console.log(`语言包 ${LANGS.join('+')}：${(dataBytes / 1048576).toFixed(1)}MB（源 ${tessdataSrc}）`);

// ⑤ 独立验证：清空 PATH 与 DYLD_*，只靠包内文件跑起来并真识别一段字
const cleanEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME || '/tmp' };
const v = spawnSync(binOut, ['--version'], { encoding: 'utf8', env: cleanEnv });
if (v.status !== 0) {
  console.error('❌ 自包含验证失败（--version 起不来）：', v.error?.message, String(v.stderr || '').slice(0, 400));
  process.exit(1);
}
console.log(`独立运行：${String(v.stdout).split('\n')[0]}`);

const fixture = path.join(DESKTOP, 'test', 'fixtures', 'ocrSample.mjs');
let ocrOk = true;
if (fs.existsSync(fixture)) {
  const { OCR_SAMPLE_PNG_BASE64 } = await import(fixture);
  const tmp = path.join(OUT, 'selftest.png');
  fs.writeFileSync(tmp, Buffer.from(OCR_SAMPLE_PNG_BASE64, 'base64'));
  const r = spawnSync(binOut, [tmp, 'stdout', '-l', 'eng', '--psm', '3', '--tessdata-dir', path.join(OUT, 'tessdata')], {
    encoding: 'utf8', env: cleanEnv,
  });
  fs.rmSync(tmp, { force: true });
  ocrOk = r.status === 0 && /ACCEPTANCE/i.test(String(r.stdout || ''));
  console.log(`独立识别自检：${ocrOk ? '✅' : '❌'} ${JSON.stringify(String(r.stdout || '').slice(0, 40))}`);
}

const sizeOf = (p) => {
  let total = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else total += fs.statSync(q).size;
    }
  })(p);
  return total;
};
const total = sizeOf(OUT);
console.log(`\n产物：${path.relative(DESKTOP, OUT)}  合计 ${(total / 1048576).toFixed(1)}MB`);
if (!ocrOk) { console.error('❌ 自检未通过'); process.exit(1); }
