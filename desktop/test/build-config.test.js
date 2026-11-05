// 打包配置守卫（2026-10-15）
//
// 背景：本地「先打包再跑测试」会整片红——
//   electron-builder 启动时 @electron/rebuild 把 better-sqlite3 重编成 **Electron ABI**，
//   之后 `npm test` 里所有用真实 better-sqlite3 的套件（taskStore/workerPool/sqljsDb/
//   sqlite-electron-probe）直接 ERR_DLOPEN_FAILED。
//   开发版复现不了（dev 走的是 Node ABI），CI 也复现不了（测试 job 与发布 job 各自
//   全新 npm ci，互不影响），所以只有本地连续操作时才暴露。
//
// 结论（依据 main/db/index.js 的驱动选择）：
//   打包版 openDbAsync(isPackaged=true) **不加载任何需要 ABI 重建的原生 npm 模块**
//   （真机事故：better-sqlite3 在主进程 NAPI 注册时 SIGSEGV，无法用子进程金丝雀兜底）。
//   ST2（2026-11-05）后打包版首选 **node:sqlite**——它是编进 Node/Electron 二进制本身的
//   内建模块，没有独立 .node 文件、不做 NAPI 注册，因此上述崩溃根因在结构上不存在，
//   同时拿到 sql.js 没有的真实 WAL；打不开时降级 sql.js（WASM）。
//   better-sqlite3 只是 optionalDependencies，仅服务 dev 与测试，打包版**不再尝试**。
//   → 打包期没有任何原生模块需要重编，`npmRebuild: false` 是正解，
//     既保住本地测试基线，也省掉每次构建的原生编译时间。
//
// 本测试的作用是**防止这个结论被悄悄推翻**：若将来有人给运行时依赖引入真正的原生模块，
// 必须显式处理（re-enable rebuild 或改用 WASM 替代），此测试会失败并说明原因。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// ── 1. 打包期不得重编原生模块 ──
check('build.npmRebuild = false（保住本地 npm test 基线 + 省掉原生编译）',
  pkg.build.npmRebuild === false, String(pkg.build.npmRebuild));

// ── 2. 前置条件：运行时依赖里确实没有原生模块（结论的前提，一旦变化本测试要失败）──
// 原生模块的判定：包内带 .node 预编译产物或依赖 node-gyp。逐一核对已知原生包名单。
const KNOWN_NATIVE = ['better-sqlite3', 'sqlite3', 'keytar', 'node-sass', 'sharp', 'canvas', 'bcrypt', 'grpc', 'cpu-features'];
const runtimeDeps = Object.keys(pkg.dependencies || {});
const nativeInRuntime = runtimeDeps.filter((d) => KNOWN_NATIVE.includes(d));
check('运行时依赖不含原生模块（npmRebuild:false 的前提成立）',
  nativeInRuntime.length === 0, nativeInRuntime.join(',') || `deps=${runtimeDeps.join(',')}`);
check('better-sqlite3 仍是 optionalDependencies（没装也能跑这一保证不被破坏）',
  !!(pkg.optionalDependencies && pkg.optionalDependencies['better-sqlite3']),
  JSON.stringify(pkg.optionalDependencies || {}));
check('better-sqlite3 不在运行时 dependencies（否则 packaged 也会尝试加载原生模块）',
  !(pkg.dependencies || {})['better-sqlite3']);

// ── 3. packaged 不得选用需要 ABI 重建的原生驱动；sql.js 保留为兜底 ──
check('asarUnpack 仍解包 sql.js 的 WASM（兜底引擎必须可加载）',
  Array.isArray(pkg.build.asarUnpack) && pkg.build.asarUnpack.some((p) => /sql-wasm\.wasm/.test(p)),
  JSON.stringify(pkg.build.asarUnpack));
const dbSrc = fs.readFileSync(path.join(root, 'main', 'db', 'index.js'), 'utf8');
check('代码层：MJ_DB_DRIVER 仍可强制指定驱动（排障逃生口未被拆掉）',
  /MJ_DB_DRIVER/.test(dbSrc));

// 「打包版不得加载原生模块」原来是**注释字符串匹配**（要求源码里出现「打包版一律 sql.js」）：
// 把手段当目的——措辞一变就红，而它真正想守的风险（打包版去 require 需要 electron-rebuild 的
// better-sqlite3）一个字都测不到。ST2 之后可选驱动变成 node:sqlite（内建、无 ABI）与
// sql.js（WASM），唯一禁止项仍是 better-sqlite3。所以改成**直接问运行时选了什么**：
// 起一个子进程按 isPackaged=true 真开一次库，读回 __driver。
const PACKAGED_DRIVER_PROBE = [
  "const os=require('os'),fs=require('fs'),path=require('path');",
  "const {openDbAsync}=require('./main/db');",
  "const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mj-packaged-driver-'));",
  'openDbAsync(dir,{isPackaged:true})',
  '  .then((db)=>{process.stdout.write("DRIVER:"+db.__driver);',
  '    try{db.close();}catch{}',
  '    fs.rmSync(dir,{recursive:true,force:true});})',
  '  .catch((e)=>{process.stdout.write("DRIVER:ERR "+e.message);});',
].join('\n');
const packagedDriver = (() => {
  try {
    const out = execFileSync(process.execPath, ['-e', PACKAGED_DRIVER_PROBE], {
      cwd: root, encoding: 'utf8', timeout: 60000,
      // 清掉排障用的强制驱动：本断言要测的是 auto 的**默认选择**
      env: { ...process.env, MJ_DB_DRIVER: '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /DRIVER:(\S+)/.exec(out);
    return m ? m[1] : `(探测无输出: ${out.slice(-120)})`;
  } catch (e) {
    return `(探测崩溃: ${e.message})`;
  }
})();
check('打包版 auto 不得选用需要 ABI 重建的 better-sqlite3（内建 node:sqlite / WASM sql.js 均可）',
  packagedDriver === 'node-sqlite' || packagedDriver === 'sqljs', packagedDriver);

// 上面那条行为断言只覆盖「本机现在的走向」：node:sqlite 几乎总是先成功，打包路径根本
// 走不到 better-sqlite3 那一支 —— 于是「删掉 !isPackaged 守卫」这种最危险的回归可以一路绿。
// 实测确认过（把守卫改掉，行为断言照样通过）。所以再断**候选顺序本身**：
const { driverPlan } = require('../main/db');
// ST2 的核心目的：拿到真实 WAL。若把 node:sqlite 从候选里摘掉，行为断言照样绿
// （打包版会落到 sql.js —— 那也是允许项），但 WAL 会**静默消失**。所以必须单独钉「首选」。
check('auto 在 node:sqlite 可用时必须首选它（ST2 核心目的：真实 WAL，摘掉它是静默退化）',
  driverPlan({ driver: 'auto', isPackaged: true, nodeSqliteOk: true })[0] === 'node-sqlite'
  && driverPlan({ driver: 'auto', isPackaged: false, nodeSqliteOk: true })[0] === 'node-sqlite',
  `packaged=${JSON.stringify(driverPlan({ driver: 'auto', isPackaged: true, nodeSqliteOk: true }))}`
  + ` dev=${JSON.stringify(driverPlan({ driver: 'auto', isPackaged: false, nodeSqliteOk: true }))}`);
check('打包版候选顺序不含 better-sqlite3（即使 node:sqlite 不可用也不回落到原生模块）',
  !driverPlan({ driver: 'auto', isPackaged: true, nodeSqliteOk: false }).includes('better-sqlite3'),
  JSON.stringify(driverPlan({ driver: 'auto', isPackaged: true, nodeSqliteOk: false })));
check('dev 候选顺序保留 better-sqlite3 兜底（开发期性能取舍未被误删）',
  driverPlan({ driver: 'auto', isPackaged: false, nodeSqliteOk: false }).includes('better-sqlite3'),
  JSON.stringify(driverPlan({ driver: 'auto', isPackaged: false, nodeSqliteOk: false })));
check('候选顺序恒以 sqljs 收尾（零原生依赖的终极兜底不可被移除）',
  ['auto'].every((d) => {
    const p = driverPlan({ driver: d, isPackaged: true, nodeSqliteOk: false });
    return p[p.length - 1] === 'sqljs';
  }));
check('显式指定的驱动不受候选顺序影响（排障逃生口）',
  driverPlan({ driver: 'sqljs', isPackaged: true, nodeSqliteOk: true }).join(',') === 'sqljs'
  && driverPlan({ driver: 'better-sqlite3', isPackaged: true, nodeSqliteOk: true }).join(',') === 'better-sqlite3');

// ── 4. 发布目标必须与真实仓库一致（曾因写成 MJCode 导致自动更新 404）──
// 2026-10-28：仓库实际是 jasonma1210/MJWork（`git remote -v` 可核），此前这里钉的 MJCoder
// 是个不存在的仓库名 —— 一旦按它发版，autoUpdater 的 feed 必然 404。钉值随真实仓库更名。
check('publish.owner/repo 指向真实仓库 jasonma1210/MJWork',
  pkg.build?.publish?.owner === 'jasonma1210' && pkg.build?.publish?.repo === 'MJWork',
  `${pkg.build?.publish?.owner}/${pkg.build?.publish?.repo}`);

// ── 5. 打包链本身未被顺手改坏 ──
// 2026-10-27：链上多了「随包 OCR」一步。断言因此改成**顺序敏感**的三段定位：
// 只断言「脚本里有 electron-builder」会同时放过两类回归 —— renderer 构建被删（打出白屏包）、
// bundle:ocr 排到 builder 之后（extraResources 源目录还不存在，打出没有 OCR 的包）。
const buildChain = (() => {
  const cmd = String(pkg.scripts?.build || '');
  const iRenderer = cmd.indexOf('build --prefix renderer');
  const iOcr = cmd.indexOf('bundle:ocr');
  const iBuilder = cmd.indexOf('electron-builder');
  return {
    ok: iRenderer >= 0 && iOcr >= 0 && iBuilder >= 0 && iRenderer < iOcr && iOcr < iBuilder,
    cmd,
  };
})();
check('build 脚本 = renderer 构建 → OCR 随包 → electron-builder（顺序敏感）', buildChain.ok, buildChain.cmd);
// P0-3：macOS 自动更新产物——electron-updater 在 macOS 只消费 zip；dmg 供手动分发。
// 二者必须同时存在，缺 zip 则更新检查恒 not found（曾因此结构性不可用）。
check('macOS 产物含 dmg（分发）+ zip（自动更新消费）',
  Array.isArray(pkg.build?.mac?.target)
  && pkg.build.mac.target.includes('dmg') && pkg.build.mac.target.includes('zip'),
  JSON.stringify(pkg.build?.mac?.target));
check('win/linux 产物保持 nsis / AppImage',
  pkg.build?.win?.target === 'nsis' && pkg.build?.linux?.target === 'AppImage',
  `${pkg.build?.win?.target}/${pkg.build?.linux?.target}`);
// P1-23：更新包签名校验，fail-closed——校验失败拒绝安装。
// 2026-10-17 修正：verifyUpdateCodeSignature 是 **Windows 专有**字段
// （schema: WindowsConfiguration.properties）。原实现写在 build.mac 下，
// electron-builder 25 的 schema 校验会直接失败（unknown property），
// 导致「测试绿、npm run build 红」——整个打包命令跑不起来。
// macOS 侧由 Squirrel.Mac 原生校验更新包签名，没有对应开关，故只保留 Windows 侧断言。
//
// 2026-10-28 修订（B6 打包冒烟发现的真实缺陷）：原断言只要求开关为 true，但
// electron-updater 的 NsisUpdater.verifySignature() 在**读不到 publisherName 时直接 return null
// 跳过校验** —— 于是「true + 无 publisherName」是空转，比 false 更糟：它给了假的满足感。
// 现改为**条件断言**：想开就必须同时具备 publisherName；未签名阶段允许显式关闭。
// ⚠ 签名证书就位后必须改回 true 并补 build.win.publisherName（值须与证书 Subject CN 完全一致），
//   两者缺一都会导致 Windows 更新失效 —— 打包冒烟 R9 会拦住这个组合。
const winVerifyOn = pkg.build?.win?.verifyUpdateCodeSignature === true;
const winHasPublisher = !!pkg.build?.win?.publisherName;
check('Windows 更新签名校验配置自洽（开启则必须有 publisherName，否则校验空转）',
  !winVerifyOn || winHasPublisher,
  winVerifyOn
    ? `verify=on, publisherName=${pkg.build?.win?.publisherName || '缺失 ⇒ 校验被跳过（空转）'}`
    : 'verify=off（未签名阶段；证书就位后须改回 on 并补 publisherName）');
check('macOS 配置不再包含该 Windows 专有字段（否则 schema 校验会拒绝整个构建）',
  !('verifyUpdateCodeSignature' in (pkg.build?.mac || {})));

// 防再入门禁：平台块里的每个字段都必须存在于 electron-builder 的 schema。
// 这条是上面那次事故的直接产物——它能在「跑一次打包」之前就发现配置非法。
const schemaVerdict = (() => {
  const schemePath = path.join(root, 'node_modules', 'app-builder-lib', 'scheme.json');
  if (!fs.existsSync(schemePath)) return { ok: true, detail: 'schema 不可用，跳过（依赖未装）' };
  try {
    const scheme = JSON.parse(fs.readFileSync(schemePath, 'utf8'));
    const MAP = { mac: 'MacConfiguration', win: 'WindowsConfiguration', linux: 'LinuxConfiguration' };
    const bad = [];
    for (const [key, defName] of Object.entries(MAP)) {
      const def = scheme.definitions[defName];
      if (!def) return { ok: true, detail: `${defName} 未在 schema 中（版本差异，跳过）` };
      const allowed = new Set(Object.keys(def.properties || {}));
      for (const field of Object.keys(pkg.build?.[key] || {})) {
        if (!allowed.has(field)) bad.push(`${key}.${field}`);
      }
    }
    return { ok: bad.length === 0, detail: bad.length ? `非法字段：${bad.join(', ')}` : 'mac/win/linux 全部合法' };
  } catch (e) {
    return { ok: false, detail: `schema 校验异常：${e.message}` };
  }
})();
check('build 平台字段均被 electron-builder schema 接受（防 unknown property）',
  schemaVerdict.ok, schemaVerdict.detail);

// X22：更新通道元数据开关必须在 **build 顶级**，不能塞进 build.publish。
// 事故同型于上面的 verifyUpdateCodeSignature：generateUpdatesFilesForAllChannels 是
// RootConfiguration/PlatformSpecificBuildOptions 的字段，而 GithubOptions 的
// additionalProperties = false —— 放进 publish 会被 schema 拒绝，`npm run build` 整个跑不起来，
// 而「只查 mac/win/linux 三块」的旧断言完全看不见它（测试绿、打包红）。
const channelVerdict = (() => {
  const schemePath = path.join(root, 'node_modules', 'app-builder-lib', 'scheme.json');
  const val = pkg.build?.generateUpdatesFilesForAllChannels;
  if (val !== true) return { ok: false, detail: `build.generateUpdatesFilesForAllChannels = ${JSON.stringify(val)}（应为 true：beta 通道需要产出通道 yml）` };
  if ('generateUpdatesFilesForAllChannels' in (pkg.build?.publish || {})) {
    return { ok: false, detail: '该字段被放进了 build.publish —— GithubOptions.additionalProperties=false，打包会失败' };
  }
  if (!fs.existsSync(schemePath)) return { ok: true, detail: 'schema 不可用，跳过（依赖未装）' };
  try {
    const scheme = JSON.parse(fs.readFileSync(schemePath, 'utf8'));
    // ① 顶级 build 的每个字段都必须在 root properties 里
    const rootAllowed = new Set(Object.keys(scheme.properties || {}));
    const badTop = Object.keys(pkg.build).filter((k) => !rootAllowed.has(k));
    // ② publish 块的每个字段都必须在 GithubOptions.properties 里（本仓库 publish.provider=github）
    const gh = scheme.definitions?.GithubOptions;
    if (!gh) return { ok: badTop.length === 0, detail: badTop.length ? `顶级非法字段：${badTop.join(', ')}` : 'GithubOptions 未在 schema 中（版本差异，跳过 publish 块）' };
    const publishAllowed = new Set(Object.keys(gh.properties || {}));
    const badPublish = Object.keys(pkg.build?.publish || {}).filter((k) => !publishAllowed.has(k));
    const bad = [...badTop.map((k) => `build.${k}`), ...badPublish.map((k) => `publish.${k}`)];
    return {
      ok: bad.length === 0,
      detail: bad.length ? `非法字段：${bad.join(', ')}` : 'build 顶级与 publish 块字段全部合法',
    };
  } catch (e) {
    return { ok: false, detail: `schema 校验异常：${e.message}` };
  }
})();
check('build 顶级与 publish 字段均被 schema 接受（X22：通道开关必须在顶级，不在 publish 内）',
  channelVerdict.ok, channelVerdict.detail);
check('publish.channel / releaseType 类型合法（CI 用 -c.publish.* 覆盖，基线须与 schema 一致）',
  typeof pkg.build?.publish?.channel === 'string'
  && ['release', 'prerelease', 'draft'].includes(pkg.build?.publish?.releaseType),
  `channel=${JSON.stringify(pkg.build?.publish?.channel)} releaseType=${JSON.stringify(pkg.build?.publish?.releaseType)}`);

check('ecosystem 目录随包分发（连接器/数字员工目录依赖）',
  Array.isArray(pkg.build?.extraResources) && pkg.build.extraResources.some((r) => /ecosystem/.test(r.from || '')));
check('files 白名单含 main/agent-core/renderer.dist（三者缺一即白屏或无引擎）',
  ['main/**/*', 'agent-core/**/*', 'renderer/dist/**/*'].every((f) => pkg.build.files.includes(f)));
// A1/B1 门禁：shared/ 是跨宿主共享逻辑（不可信内容管道、沙箱说明）；shared-ipc/ 是 IPC 契约。
// 二者任一缺失都会让打包版**静默**失去安全能力（检测规则加载失败 → 拒绝启动运行），
// 因此在打包配置层钉住，避免「改 files 白名单时顺手删掉」。
check('files 白名单含 shared/（不可信内容管道与沙箱说明依赖，缺失会导致运行时拒绝启动）',
  pkg.build.files.includes('shared/**/*'));
check('files 白名单含 shared-ipc/（IPC 契约依赖）',
  pkg.build.files.includes('shared-ipc/**/*'));

// ── 6. 打包期不静默破坏测试链：测试脚本不得依赖打包产物 ──
check('npm test 不依赖 release/ 产物（保证本地任意顺序下测试基线一致）',
  !/release\/|\.dmg/.test(pkg.scripts.test || ''));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);