#!/usr/bin/env node
// 打包产物冒烟（审查清单 B6）
//
// 为什么必须存在：本项目历史事故几乎全部是「**打包态才出现**」的——
//   · better-sqlite3 在打包版主进程 SIGSEGV（源码测试全绿）
//   · safeStorage 在打包版不可用（凭证轨断掉）
//   · `node --check` 对某些语法假绿
// 源码级 300+ 套件一条都拦不住这些。没有本脚本，「1.0 能发」这个结论没有证据。
//
// 设计纪律：
//   1. **fail-closed**：任何一项不满足 → exit 1；**找不到产物同样计失败**。
//      唯一例外是显式 `--allow-missing`（只给脚本自测用，CI 绝不允许）。
//   2. **跨平台统一抽象**：不按 `.app` 组织，统一抽象成「resources 目录」——
//      mac 是 `Contents/Resources`，win/linux 是 `resources`，后续断言只认 resources 内部结构。
//   3. **断言内容而不只是存在性**：版本号要真读、publisherName 要真解析，
//      不接受「文件在就算过」。
//   4. **条件断言优于硬断言**：`verifyUpdateCodeSignature` 与 `publisherName` 的一致性才有意义，
//      单看任何一个都会误判（详见 publisherName 那一段的注释）。
//
// 用法：
//   node scripts/smoke-packaged.mjs                    # 自动在 release/ 下发现产物
//   node scripts/smoke-packaged.mjs --artifact <path>  # 指定 .app / resources / dmg
//   node scripts/smoke-packaged.mjs --allow-missing    # 仅自测：无产物时不判红
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
// --pkg：允许指定另一份 package.json（自证伪测试用它验证 R9 的条件分支；CI 用默认值）
const PKG = JSON.parse(fs.readFileSync(argOf('--pkg') || path.join(ROOT, 'package.json'), 'utf8'));
const PLATFORM = process.platform;
const ARTIFACT_ARG = argOf('--artifact');
const ALLOW_MISSING = argv.includes('--allow-missing');

// ── 断言框架 ──────────────────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (e) {
    results.push({ ok: false, name, detail: e?.message || String(e) });
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// 挂载清理登记：dmg 挂载必须在任何退出路径上卸载，否则 CI 磁盘残留挂载点
const mounts = [];
function detachAll() {
  for (const m of mounts) {
    try { execFileSync('hdiutil', ['detach', m, '-force'], { stdio: 'ignore' }); } catch { /* 尽力而为 */ }
    try { fs.rmSync(m, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
  mounts.length = 0;
}
process.on('exit', detachAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { detachAll(); process.exit(1); });

// ── 产物发现 ──────────────────────────────────────────────────────────────────
// 返回 { kind, path } —— kind ∈ 'app' | 'resources' | 'dmg' | null
function discoverArtifact() {
  if (ARTIFACT_ARG) {
    const p = path.resolve(ARTIFACT_ARG);
    if (!fs.existsSync(p)) return { kind: null, path: p, why: `指定的产物不存在：${p}` };
    if (p.endsWith('.dmg')) return { kind: 'dmg', path: p };
    if (p.endsWith('.app')) return { kind: 'app', path: p };
    return { kind: 'resources', path: p };
  }
  if (!fs.existsSync(RELEASE)) return { kind: null, path: RELEASE, why: 'release/ 目录不存在（还没打包）' };
  // 优先取 unpacked 目录（冒烟最省事，不必挂载 dmg）：mac-*/ 下找 .app，win/linux 下找 resources
  const dirs = fs.readdirSync(RELEASE, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const base = path.join(RELEASE, d.name);
    if (PLATFORM === 'darwin') {
      const appName = (fs.readdirSync(base) || []).find((f) => f.endsWith('.app'));
      if (appName) return { kind: 'app', path: path.join(base, appName) };
    }
    if (fs.existsSync(path.join(base, 'resources'))) return { kind: 'resources', path: path.join(base, 'resources') };
  }
  // 退而求其次：最新 dmg
  const dmgs = fs.readdirSync(RELEASE).filter((f) => f.endsWith('.dmg'))
    .map((f) => ({ f, t: fs.statSync(path.join(RELEASE, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (dmgs.length) return { kind: 'dmg', path: path.join(RELEASE, dmgs[0].f) };
  return { kind: null, path: RELEASE, why: '未找到 .app / resources / .dmg 产物' };
}

// 把产物解析成 resources 目录（mac: Contents/Resources；win/linux: resources）
function resolveResources(a) {
  if (a.kind === 'resources') return a.path;
  if (a.kind === 'app') return path.join(a.path, 'Contents', 'Resources');
  if (a.kind === 'dmg') {
    const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-smoke-'));
    try {
      execFileSync('hdiutil', ['attach', a.path, '-nobrowse', '-readonly', '-mountpoint', mnt], { stdio: 'ignore' });
    } catch (e) {
      fs.rmSync(mnt, { recursive: true, force: true });
      throw new Error(`dmg 挂载失败：${e?.message || e}`);
    }
    mounts.push(mnt);
    const appName = fs.readdirSync(mnt).find((f) => f.endsWith('.app'));
    assert(appName, `dmg 内未找到 .app（内容：${fs.readdirSync(mnt).join(', ')}）`);
    return path.join(mnt, appName, 'Contents', 'Resources');
  }
  throw new Error('产物类型未知');
}

// ── 代码载体：app.asar 或 app/ 目录（两种形态都要支持）──────────────────────────
// 现状说明：当前 release/ 里的 0.7.0-beta dmg 是**解包**形态（Resources/app/），
// 而 package.json 未设 asar:false、默认应为 asar。二者不一致本身就是要暴露的信息，
// 所以这里不假设某一种，而是「两者必须至少有一个」并把实际形态打印出来。
function readCarrier(resources) {
  const asar = path.join(resources, 'app.asar');
  const dir = path.join(resources, 'app');
  if (fs.existsSync(asar)) {
    let entries = null;
    try { entries = require('@electron/asar').listPackage(asar); } catch { entries = null; }
    return { kind: 'asar', path: asar, entries };
  }
  if (fs.existsSync(dir)) return { kind: 'dir', path: dir, entries: null };
  return { kind: null, path: null, entries: null };
}

const carrierHas = (carrier, rel) => {
  if (carrier.kind === 'dir') return fs.existsSync(path.join(carrier.path, rel));
  if (carrier.kind === 'asar') {
    if (!carrier.entries) throw new Error('无法枚举 app.asar 内容（@electron/asar 不可用）');
    const needle = rel.replace(/\\/g, '/');
    return carrier.entries.some((e) => e.replace(/\\/g, '/').replace(/^\//, '') === needle);
  }
  return false;
};
const carrierReadJson = (carrier, rel) => {
  if (carrier.kind === 'dir') return JSON.parse(fs.readFileSync(path.join(carrier.path, rel), 'utf8'));
  if (carrier.kind === 'asar') return JSON.parse(require('@electron/asar').extractFile(carrier.path, rel).toString('utf8'));
  throw new Error('无代码载体');
};

// ══════════════════════════ 断言开始 ══════════════════════════
const found = discoverArtifact();
if (!found.kind) {
  if (ALLOW_MISSING) {
    console.log(`⚠ 未找到打包产物（${found.why}）；--allow-missing 已指定，本次跳过断言。`);
    console.log('   ⚠ 这只说明"没检查"，不代表产物健康 —— CI 不允许使用该开关。');
    process.exit(0);
  }
  console.error(`❌ 未找到打包产物：${found.why}`);
  console.error('   打包产物冒烟必须针对真实产物运行。先执行 `npm run dist:dir`（或 dist:mac）再跑本脚本。');
  process.exit(1);
}
console.log(`产物：${found.path}（kind=${found.kind}, platform=${PLATFORM}）`);

let resources = null;
check('R0 产物可解析出 resources 目录', () => {
  resources = resolveResources(found);
  assert(fs.existsSync(resources), `resources 目录不存在：${resources}`);
  return resources;
});

let carrier = { kind: null, path: null, entries: null };
if (resources) {
  check('R1 代码载体存在（app.asar 或 app/ 目录）', () => {
    carrier = readCarrier(resources);
    assert(carrier.kind, `resources 下既无 app.asar 也无 app/：${fs.readdirSync(resources).join(', ')}`);
    return `${carrier.kind}（${carrier.kind === 'asar' ? 'asar 打包' : '解包目录'}）`;
  });

  // 关键入口：缺任何一个，应用启动即炸
  const ENTRIES = [
    ['main/main.js', '主进程入口（package.json 的 main 指向它）'],
    ['main/preload.js', 'preload 桥（缺则 window.mjcode 全部 undefined）'],
    ['renderer/dist/index.html', '渲染层入口（缺则白屏）'],
    ['agent-core/index.js', '引擎内核（CLI 与工具层依赖）'],
  ];
  check(`R2 ${ENTRIES.length} 个关键入口齐备`, () => {
    const missing = ENTRIES.filter(([rel]) => !carrierHas(carrier, rel)).map(([rel, why]) => `${rel}（${why}）`);
    assert(missing.length === 0, `缺失：${missing.join('；')}`);
    return ENTRIES.map(([r]) => r).join(', ');
  });

  // asarUnpack 目标：sql.js 的 wasm 必须落在 unpacked（在 asar 内无法被 WebAssembly 实例化）
  check('R3 sql-wasm.wasm 在 asarUnpack 位置（可被原生加载）', () => {
    const candidates = carrier.kind === 'asar'
      ? [path.join(resources, 'app.asar.unpacked', 'node_modules/sql.js/dist/sql-wasm.wasm')]
      : [path.join(resources, 'app', 'node_modules/sql.js/dist/sql-wasm.wasm')];
    const hit = candidates.find((p) => fs.existsSync(p));
    assert(hit, `未找到 sql-wasm.wasm。期望位置：${candidates[0]}`
      + `\n     （asarUnpack 未生效 ⇒ 打包版 SQLite 起不来，db/index.js 会退回内存库、数据不落盘）`);
    const size = fs.statSync(hit).size;
    assert(size > 10000, `sql-wasm.wasm 体积异常（${size} bytes），疑似被截断`);
    return `${size} bytes`;
  });

  // 版本一致性：包内 package.json 必须等于仓库 package.json
  check('R4 包内版本号 === 仓库 package.json 版本', () => {
    const inner = carrierReadJson(carrier, 'package.json');
    assert(inner.version === PKG.version,
      `包内 ${inner.version} ≠ 仓库 ${PKG.version}（产物是用旧代码打的？）`);
    return inner.version;
  });

  // macOS 专属：Info.plist 版本（Gatekeeper / 更新器读的是这个，不是包内 package.json）
  if (PLATFORM === 'darwin' && found.kind === 'app') {
    check('R5 Info.plist 版本 === 仓库版本（更新器按此判定新旧）', () => {
      const plist = path.join(found.path, 'Contents', 'Info.plist');
      assert(fs.existsSync(plist), `Info.plist 不存在：${plist}`);
      const out = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8' }).trim();
      assert(out === PKG.version, `Info.plist ${out} ≠ 仓库 ${PKG.version}`);
      return out;
    });
  }

  // extraResources：ecosystem（技能/连接器资产），缺则生态中心空白
  check('R6 extraResources/ecosystem 已随包', () => {
    const p = path.join(resources, 'ecosystem');
    assert(fs.existsSync(p), `未找到 ${p}（顶层 extraResources 的 ../ecosystem 未生效）`);
    const n = fs.readdirSync(p).length;
    assert(n > 0, 'ecosystem 目录为空');
    return `${n} 个条目`;
  });

  // macOS 专属：随包 OCR（build/ocr → Resources/ocr）
  if (PLATFORM === 'darwin') {
    check('R7 随包 OCR 可用（二进制可执行 + traineddata 齐备）', () => {
      const ocrDir = path.join(resources, 'ocr');
      assert(fs.existsSync(ocrDir), `未找到 ${ocrDir}（CI 若未执行 bundle:ocr，macOS 包必然缺 OCR）`);
      const bin = path.join(ocrDir, 'tesseract');
      assert(fs.existsSync(bin), `缺 tesseract 可执行文件：${bin}`);
      // 可执行位：文件存在但没有 x 位时 spawn 会 EACCES，比"文件缺失"更难排查
      try { fs.accessSync(bin, fs.constants.X_OK); } catch { throw new Error(`tesseract 无执行权限（chmod +x 丢失）：${bin}`); }
      // traineddata 实测位于 ocr/tessdata/ 子目录 —— 只在顶层找会误报（本条曾因此假红一次）
      const dataFiles = [];
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.traineddata')) dataFiles.push(e.name);
        }
      })(ocrDir);
      assert(dataFiles.length > 0, '未找到任何 .traineddata（只有二进制，识别结果恒空）');
      return `tesseract（可执行）+ ${dataFiles.length} 份 traineddata：${dataFiles.join(', ')}`;
    });
  }

  // 更新通道配置 + 签名校验一致性（条件断言，见注释）
  check('R8 更新配置 app-update.yml 存在且 provider/owner/repo 齐备', () => {
    const yml = path.join(resources, 'app-update.yml');
    assert(fs.existsSync(yml), `未找到 ${yml}（electron-builder 未生成更新配置 ⇒ 检查更新恒失败）`);
    const text = fs.readFileSync(yml, 'utf8');
    for (const k of ['provider', 'owner', 'repo']) {
      assert(new RegExp(`^${k}:\\s*\\S`, 'm').test(text), `app-update.yml 缺 ${k}`);
    }
    return text.split('\n').filter(Boolean).slice(0, 3).join(' / ');
  });

  // 一致性断言：verifyUpdateCodeSignature=true 却没有 publisherName ⇒ 校验实际空转。
  // 为什么不硬性要求 publisherName：未签名阶段填它反而会让 Windows 更新 100% 失败
  // （NsisUpdater.verifySignature 在 publisherName 存在但签名不匹配时直接拒绝）。
  // 所以这里守护的是**两者的一致性**，而不是「必须有 publisherName」。
  check('R9 verifyUpdateCodeSignature 与 publisherName 一致（不空转、不误拒）', () => {
    const verify = PKG.build?.win?.verifyUpdateCodeSignature === true;
    const pnCfg = PKG.build?.win?.publisherName;
    const ymlText = fs.existsSync(path.join(resources, 'app-update.yml'))
      ? fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8') : '';
    const ymlPn = /^publisherName:\s*(\S+)/m.exec(ymlText)?.[1] || '';
    if (!verify) {
      // 未开启校验：允许没有 publisherName，但要显式说明这是"关着"的状态
      return 'verify=off（未签名阶段，Windows 更新不做签名校验 —— 发布带签名包时必须改为 on）';
    }
    assert(pnCfg || ymlPn,
      'verifyUpdateCodeSignature=true 但既无 build.win.publisherName 也无 app-update.yml 的 publisherName'
      + '\n     ⇒ electron-updater 的 verifySignature() 会直接 return null 跳过校验（门禁空转），'
      + '\n     而一旦补上 publisherName 但包未签名，Windows 更新会 100% 失败。二者必须同时满足。');
    return `verify=on，publisherName=${pnCfg || ymlPn}`;
  });
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log('');
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail.split('\n')[0]}` : ''}`);
  if (!r.ok && r.detail.includes('\n')) console.log(r.detail.split('\n').slice(1).join('\n'));
}
console.log(`\nsmoke-packaged: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error(`\n❌ 打包产物冒烟失败 ${failed.length} 项 —— 该产物不应发布。`);
  process.exit(1);
}
console.log('✅ 打包产物冒烟通过');
