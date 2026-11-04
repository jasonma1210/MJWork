// 第四阶段（发布基建）门禁：P1-N 更新链路默认值 + 版本规范 + CI 制品纪律 + 回滚 Runbook
// 静态断言为主（electron-updater 仅打包态可用，无法在 node 直测）；同时锁死
// 「autoUpdater 作用域」这个曾让手动检查链路从未工作的 bug 不复发。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const DESKTOP = path.join(ROOT, 'desktop');
const read = (p) => fs.readFileSync(p, 'utf8');

// ── T3-2 i18n 适配 helper ──
// 组件源码里的中文 UI 文案已抽取到 zh-CN 语言包，断言改为两段式：
// ① 文案值存在于 zh-CN/<mod>.json（递归深搜）；② 组件源码引用了对应 key（t / tGlobal）
const ZH_DIR = path.join(DESKTOP, 'renderer/src/i18n/locales/zh-CN');
function zhKeys(mod, substr) {
  const j = JSON.parse(fs.readFileSync(path.join(ZH_DIR, mod + '.json'), 'utf8'));
  const hits = [];
  (function walk(o, prefix) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') { if (v.includes(substr)) hits.push(prefix + k); }
      else if (v && typeof v === 'object') walk(v, prefix + k + '.');
    }
  })(j, '');
  return hits;
}
function refsKey(src, mod, keys) {
  return keys.some((k) => new RegExp(`t(Global)?\\(['"\`]${mod}\\.${k.replace(/\./g, '\\.')}['"\`]`).test(src));
}
function assertI18nCopy(src, mod, substr, msg) {
  const keys = zhKeys(mod, substr);
  assert.ok(keys.length > 0, `${msg}（zh-CN/${mod}.json 中找不到文案「${substr}」）`);
  assert.ok(refsKey(src, mod, keys), `${msg}（组件未引用「${substr}」对应 key：${keys.join(', ')}）`);
}

const mainSrc = read(path.join(DESKTOP, 'main/main.js'));
// T2-1：自动更新域已拆出 main/updater/index.js——更新链路断言改指新模块；
// main.js 仍断言接线点（whenReady 调 updater.scheduleAutoUpdateCheck()）。
const updaterSrc = read(path.join(DESKTOP, 'main/updater/index.js'));
// 2026-10-15：账户页移除后更新区块拆出 components/UpdateSection.tsx（断言随实现走）
const settings = read(path.join(DESKTOP, 'renderer/src/components/SettingsModal.jsx'))
  + read(path.join(DESKTOP, 'renderer/src/components/UpdateSection.tsx'));
const ci = read(path.join(ROOT, '.github/workflows/ci.yml'));
const pkg = JSON.parse(read(path.join(DESKTOP, 'package.json')));
const serverPkg = JSON.parse(read(path.join(ROOT, 'server/package.json')));
const rendererPkg = JSON.parse(read(path.join(DESKTOP, 'renderer/package.json')));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

check('autoUpdater 为模块作用域声明（修复手动检查 ReferenceError）', () => {
  assert.match(updaterSrc, /^let autoUpdater = null;$/m, 'autoUpdater 未在模块作用域声明');
  assert.ok(!/const \{ autoUpdater \} = require\('electron-updater'\)/.test(updaterSrc),
    'autoUpdater 又被收回函数作用域：IPC handler 会抛 ReferenceError');
});

check('initUpdater 返回实例且 IPC handler 使用返回值', () => {
  assert.match(updaterSrc, /function initUpdater\(\) \{[\s\S]*?return autoUpdater;/);
  assert.match(updaterSrc, /const up = initUpdater\(\);\s*\n\s*if \(!up\)/,
    'IPC handler 未使用 initUpdater 返回值（再次引用裸 autoUpdater 会炸）');
});

check('启动延迟 10s 自动检查（保持手动下载）', () => {
  assert.match(updaterSrc, /const UPDATE_CHECK_DELAY_MS = 10 \* 1000;/);
  assert.match(updaterSrc, /function scheduleAutoUpdateCheck\(\) \{[\s\S]*?if \(!app\.isPackaged\) return;/);
  assert.match(mainSrc, /updater\.scheduleAutoUpdateCheck\(\);/, 'whenReady 未接线延迟检查');
  assert.match(updaterSrc, /autoDownload = false/, 'autoDownload 必须保持 false：下载由用户确认');
  assert.match(updaterSrc, /autoUpdateChecked/, '缺少自动检查去重标志');
});

check('检查失败附手动下载降级链接（build.publish 推导）', () => {
  assert.match(updaterSrc, /function resolveManualDownloadUrl\(\)/);
  assert.match(updaterSrc, /github\.com\/\$\{pub\.owner\}\/\$\{pub\.repo\}\/releases/,
    '手动下载链接未由 publish owner/repo 推导');
  // T2-7：error 事件附分类 hint（kind/hint），手动下载兜底链接保持
  assert.match(updaterSrc, /send\('error', \{ message: err\.message, kind, hint, downloadUrl: MANUAL_DOWNLOAD_URL \}\)/);
  assert.match(updaterSrc, /send\('available', lastAvailable\)/);
  assert.match(updaterSrc, /return \{ ok: false, error: err\.message, kind, hint, downloadUrl: MANUAL_DOWNLOAD_URL \};/,
    '手动检查失败未带回 downloadUrl');
});

check('更新通道支持 beta 灰度（MJ_UPDATE_CHANNEL）', () => {
  assert.match(updaterSrc, /const UPDATE_CHANNEL = process\.env\.MJ_UPDATE_CHANNEL \|\| 'latest';/);
  assert.match(updaterSrc, /autoUpdater\.channel = UPDATE_CHANNEL;/);
  assert.equal(pkg.build.publish.channel, 'latest', 'publish.channel 应为 latest');
});

check('设置页渲染手动下载链接（error/available 态）', () => {
  assert.match(settings, /updateDownloadUrl/, '设置页无 downloadUrl 状态');
  // T3-2 i18n：「手动下载最新版本」文案已抽取到 zh-CN/settings.json（manualDownload），改为两段式验证
  assertI18nCopy(settings, 'settings', '手动下载最新版本', '未渲染手动下载入口');
  assert.match(settings, /setUpdateDownloadUrl\(r\.downloadUrl/, '手动检查失败未降级到下载链接');
  assert.match(settings, /d\.status === 'error' \|\| d\.status === 'available'/,
    'downloadUrl 仅在 error/available 态展示');
});

check('三包版本一致（desktop/server/renderer）', () => {
  assert.equal(pkg.version, serverPkg.version, `server ${serverPkg.version} ≠ desktop ${pkg.version}`);
  assert.equal(pkg.version, rendererPkg.version, `renderer ${rendererPkg.version} ≠ desktop ${pkg.version}`);
});

check('CHANGELOG 存在且含当前版本段', () => {
  const cl = read(path.join(ROOT, 'CHANGELOG.md'));
  assert.match(cl, /## \[1\.0\.0\] - \d{4}-\d{2}-\d{2}/, 'CHANGELOG 缺少当前版本段（日期格式 YYYY-MM-DD）');
  assert.match(cl, /Keep a Changelog/, 'CHANGELOG 未声明格式基线');
});

check('CI 制品纪律（P0-G 回归：tag 触发 + matrix + commit 绑定 + 发布开关）', () => {
  assert.match(ci, /tags: \['v\*'\]/, 'CI 未配置 tag 触发');
  assert.match(ci, /runs-on: \$\{\{ matrix\.os \}\}/, 'release job 未用 matrix 三平台');
  // X22：制品名在 sha 前插入了通道（区分 latest / beta 产物），故不再是一个连续字面量。
  // 断言改为按**意图**校验：制品名必须同时绑定 os、通道、commit sha 三项。
  assert.match(ci, /MJCode-\$\{\{ matrix\.os \}\}-\$\{\{ steps\.channel\.outputs\.channel \}\}-\$\{\{ github\.sha \}\}/,
    '制品名未绑定 commit sha 或未带通道（X22：需 os + 通道 + sha）');
  assert.match(ci, /--publish \$\{\{ vars\.PUBLISH_RELEASE/, '缺少受控的发布开关');
  assert.match(ci, /Sync version from tag/, 'release job 未从 tag 同步版本');
});

check('回滚 Runbook 就位', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/发布回滚Runbook.md')), '缺少 docs/发布回滚Runbook.md');
  const rb = read(path.join(ROOT, 'docs/发布回滚Runbook.md'));
  assert.match(rb, /回滚步骤/);
  assert.match(rb, /latest\.yml/, 'Runbook 未说明 latest.yml 是更新源真值');
  assert.match(rb, /演练记录/);
});

// ── 2026-11-04：启动自动更新弹窗（用户反馈「启动 app 后自动扫描并弹窗提示」）──
// 断言分两层：本文件锁「接线 + 调用点」，updater-errors.test.mjs 锁「40 字截断的真实运行行为」。
// 只断言「存在一个 summarizeReleaseNotes 函数」是模块级孤儿，等于没测到事件载荷。
const promptSrc = read(path.join(DESKTOP, 'renderer/src/components/UpdatePrompt.tsx'));
const appSrc = read(path.join(DESKTOP, 'renderer/src/App.jsx'));
const preloadSrc = read(path.join(DESKTOP, 'main/preload.js'));
const zhPrompt = JSON.parse(read(path.join(DESKTOP, 'renderer/src/i18n/locales/zh-CN/updatePrompt.json')));
const enPrompt = JSON.parse(read(path.join(DESKTOP, 'renderer/src/i18n/locales/en-US/updatePrompt.json')));

check('available 事件载荷带 ≤40 字更新说明，且截断函数真的在调用点上', () => {
  assert.match(updaterSrc, /const RELEASE_NOTES_MAX_CHARS = 40;/);
  assert.match(updaterSrc, /function summarizeReleaseNotes\(/);
  assert.match(updaterSrc, /autoUpdater\.on\('update-available'[\s\S]{0,600}?releaseNotes: summarizeReleaseNotes\(info\?\.releaseNotes\)/,
    'update-available 未把截断后的 releaseNotes 塞进事件载荷');
  assert.match(updaterSrc, /send\('available', lastAvailable\)/, '事件未推送完整载荷');
});

check('主进程缓存 lastAvailable + 补拉通道 + 下载开始后清缓存', () => {
  assert.match(updaterSrc, /ipcMain\.handle\('updater:lastAvailable', \(\) => \(\{ ok: true, info: lastAvailable, state: downloadState \}\)\)/);
  assert.match(updaterSrc, /lastAvailable = null; \/\/ 用户已点「更新」/,
    '开始下载后未清待提示，渲染层重挂载会再弹一次');
  assert.match(updaterSrc, /autoUpdater\.on\('update-not-available'[\s\S]{0,200}?lastAvailable = null/);
  assert.match(preloadSrc, /getLastUpdate: \(\) => ipcRenderer\.invoke\('updater:lastAvailable'\)/);
});

check('启动弹窗常驻挂载于 App 根部，且设置页仍保留手动更新入口', () => {
  assert.match(appSrc, /import UpdatePrompt from '\.\/components\/UpdatePrompt';/);
  assert.match(appSrc, /<UpdatePrompt \/>/, 'App 未挂载启动更新弹窗');
  assert.match(mainSrc, /updater\.scheduleAutoUpdateCheck\(\);/, '启动自动检查接线丢了');
  assert.match(settings, /downloadUpdate/, '设置页手动下载入口丢了');
});

check('弹窗文案双侧齐备且默认更新说明不超过 40 字', () => {
  const keys = Object.keys(zhPrompt).sort().join(',');
  assert.equal(keys, Object.keys(enPrompt).sort().join(','), 'zh-CN / en-US 键集不一致');
  assert.ok(zhPrompt.cancel && zhPrompt.update, '缺少「取消 / 更新」文案');
  assert.ok([...zhPrompt.defaultNotes].length <= 40, 'zh-CN 默认更新说明超过 40 字');
  assert.ok([...enPrompt.defaultNotes].length <= 40, 'en-US 默认更新说明超过 40 字');
  assert.match(promptSrc, /t\('updatePrompt\.cancel'\)/);
  assert.match(promptSrc, /t\('updatePrompt\.update'\)/);
  assert.match(promptSrc, /t\('updatePrompt\.version', \{ version \}\)/, '弹窗未展示版本号');
});

check('只有点「更新」才下载；取消不持久化，下次启动会再提示', () => {
  assert.equal((promptSrc.match(/downloadUpdate\?\.\(\)/g) || []).length, 1,
    'downloadUpdate 调用点必须且只能有一个');
  assert.match(promptSrc, /async function startDownload\(\)[\s\S]{0,600}?downloadUpdate\?\.\(\)/);
  assert.match(promptSrc, /onUpdate=\{startDownload\}/, '「更新」按钮未接到 startDownload');
  assert.match(promptSrc, /onCancel=\{dismiss\}/, '「取消」按钮未接到 dismiss');
  assert.match(promptSrc, /if \(dismissedRef\.current \|\| acceptedRef\.current\) return;/,
    '取消后本次会话内仍会被 available 事件反复打扰');
  // 剥注释后再判：文件头注释里本就写了「刻意不写 localStorage」，不剥会假红。
  // 自检：原文里必须能搜到这个词（证明探测器有效），代码里必须搜不到。
  const promptCode = promptSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/localStorage/.test(promptSrc), '自检失败：否定式断言的探测器已失效');
  assert.ok(!/localStorage|sessionStorage/.test(promptCode),
    '取消不应写持久化忽略标记，否则下次启动不会再提示');
  assert.match(promptSrc, /getLastUpdate\?\.\(\)/, '窗口晚于自动检查加载时没有补拉');
  assert.match(promptSrc, /const mj = window\.mjcode;/, '缺少整桥别名（bridge-parity 会误报死桥）');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
process.exit(pass === total ? 0 : 1);
