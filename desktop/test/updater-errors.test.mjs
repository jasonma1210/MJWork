// T2-7 门禁：更新失败可诊断文案（main/updater/index.js classifyUpdateError）
// 断言：五类失败模式各有 kind + 可行动 hint；校验类错误必须显式警告（绝不静默）；
//       未知错误指向诊断包（T2-5/T2-6 闭环）。
// P0-3：追加 updater:download IPC 门禁——补上更新回路缺失的一环（此前全仓零调用
//       downloadUpdate，用户看到 available 后没有任何按钮触发下载）。
// 2026-11-04（用户反馈「设置 → 通用 → 版本更新下载到 100% 后又重新开始下载」）：
//       追加下载状态机回归——主进程幂等 + downloaded 终态 + 渲染层终态保护。
//       断言打在**真实 handler 调用点**上：重复触发是否真的没再调 downloadUpdate，
//       而不是只断言「有一个 canStartDownload 函数存在」这种模块级孤儿。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// updater 模块顶层 require('electron')——注入 stub 后再加载。
// ipcMain.handle 捕获注册表（供下方 updater:download 门禁取 handler）；
// app.isPackaged 可变（同一 stub 上翻打包态，不重建模块）。
const handlers = new Map();
const mainRequire = createRequire(path.join(DESKTOP, 'main', 'noop.js'));
const electronAppStub = { isPackaged: false, getPath: () => '/tmp' };
require.cache[mainRequire.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { app: electronAppStub, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } },
};

const { classifyUpdateError, init, canStartDownload, getDownloadState, summarizeReleaseNotes, RELEASE_NOTES_MAX_CHARS } = require(path.join(DESKTOP, 'main/updater/index.js'));

let pass = 0, total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
/** 布尔判定（异步段用；失败时带现场数据，避免只报「不等于」） */
function verify(name, cond, detail = '') {
  total++;
  if (cond) { console.log(`[PASS] ${name}`); pass++; }
  else { console.error(`[FAIL] ${name} — ${detail}`); process.exitCode = 1; }
}

check('断网类 → network：明确不影响当前版本', () => {
  const r = classifyUpdateError({ message: 'Cannot download update: getaddrinfo ENOTFOUND github.com' });
  assert.equal(r.kind, 'network');
  assert.match(r.hint, /检查网络/);
  assert.match(r.hint, /不影响当前版本/);
});

check('校验失败类 → integrity：绝不静默，指向手动下载官方包', () => {
  for (const msg of [
    'SHA512 digest mismatch for file: app.zip',
    'Update signature verification failed',
    'invalid blockmap',
  ]) {
    const r = classifyUpdateError({ message: msg });
    assert.equal(r.kind, 'integrity', `${msg} 应归 integrity`);
    assert.match(r.hint, /校验失败/);
    assert.match(r.hint, /手动下载/);
  }
});

check('更新源缺失类 → notfound', () => {
  const r = classifyUpdateError({ message: '404 Not Found Cannot find update for channel latest' });
  assert.equal(r.kind, 'notfound');
  assert.match(r.hint, /更新源/);
});

check('安装前置失败类 → install', () => {
  const r = classifyUpdateError({ message: 'EPERM: operation not permitted, Installer volume busy' });
  assert.equal(r.kind, 'install');
  assert.match(r.hint, /退出应用后重试|覆盖安装/);
});

check('未知类 → unknown：指向诊断包导出（反馈闭环）', () => {
  const r = classifyUpdateError({ message: 'something exotic happened' });
  assert.equal(r.kind, 'unknown');
  assert.match(r.hint, /诊断包/);
});

check('所有分类都带非空 hint（不静默原则）', () => {
  for (const msg of ['ENOTFOUND x', 'digest fail', '404', 'EPERM', 'weird']) {
    const r = classifyUpdateError({ message: msg });
    assert.ok(r.hint && r.kind, `分类缺失：${msg}`);
  }
});

check('下载状态机纯函数：idle 可下载，downloading / downloaded 幂等拒绝', () => {
  assert.equal(canStartDownload('idle').start, true);
  assert.equal(canStartDownload('downloading').start, false);
  assert.equal(canStartDownload('downloaded').start, false);
  assert.equal(canStartDownload('downloaded').state, 'downloaded');
});

// ── 2026-11-04：启动更新弹窗的「更新内容 ≤40 字」（真跑纯函数，不只查函数存在）──
check('releaseNotes 三种形态都归一成单行摘要（markdown / HTML / 数组）', () => {
  const md = summarizeReleaseNotes('# 0.8.13-beta\n\n- **修复** [下载重复](https://example.com/a)\n- 优化体验');
  assert.equal(md, '0.8.13-beta 修复 下载重复 优化体验', md);
  const html = summarizeReleaseNotes('<h2>Release</h2><p>Fixed &amp; improved</p>');
  assert.equal(html, 'Release Fixed &amp; improved', html);
  const arr = summarizeReleaseNotes([{ version: '1', note: '修复 A' }, { version: '2', note: '修复 B' }]);
  assert.equal(arr, '修复 A 修复 B', arr);
});

check('releaseNotes 任意输入都 ≤40 字，且空值不得抛错 / 不得产出 undefined', () => {
  assert.equal(RELEASE_NOTES_MAX_CHARS, 40);
  for (const input of [
    '修'.repeat(500),
    '# '.repeat(200) + '修复'.repeat(200),
    '😀'.repeat(100),
    [{ note: '长'.repeat(300) }],
    undefined,
    null,
    42,
    { unexpected: true },
  ]) {
    const out = summarizeReleaseNotes(input);
    assert.equal(typeof out, 'string', `非字符串输出：${String(input).slice(0, 20)}`);
    assert.ok([...out].length <= 40, `超过 40 字：${[...out].length} — ${out}`);
  }
  assert.equal(summarizeReleaseNotes('修复若干问题'), '修复若干问题', '短文案不得被误截断');
  assert.equal([...summarizeReleaseNotes('修'.repeat(41))].length, 40, '41 字应截成 40 字（含省略号）');
});

// ── P0-3 + 2026-11-04：updater:download IPC 与下载状态机（注入 electron-updater stub）──
let downloadCalls = 0;
let checkCalls = 0;
let downloadShouldThrow = null;
let downloadHold = null;
const updaterEvents = new Map();
const statusPushes = [];

require.cache[mainRequire.resolve('electron-updater')] = {
  id: 'electron-updater', filename: 'electron-updater', loaded: true,
  exports: {
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      channel: 'latest',
      on: (name, fn) => { updaterEvents.set(name, fn); },
      checkForUpdates: async () => { checkCalls += 1; },
      quitAndInstall: () => {},
      downloadUpdate: async () => {
        downloadCalls += 1;
        if (downloadHold) await downloadHold;
        if (downloadShouldThrow) throw downloadShouldThrow;
      },
    },
  },
};

const emit = (name, payload) => { const fn = updaterEvents.get(name); if (fn) fn(payload); };
const mainWindowStub = {
  isDestroyed: () => false,
  webContents: { send: (_channel, payload) => statusPushes.push(payload) },
};
const getMainWindow = () => mainWindowStub;
init({ getMainWindow });

(async () => {
  const startDownload = () => handlers.get('updater:download')();
  const startCheck = () => handlers.get('updater:check')();
  verify('updater:download / updater:check IPC 均已注册',
    typeof handlers.get('updater:download') === 'function' && typeof handlers.get('updater:check') === 'function');

  // 1. 未打包态：明确错误，不触发下载（不假装在下载）
  const r1 = await startDownload();
  verify('未打包态下载：明确拒绝且不触发 downloadUpdate',
    r1.ok === false && /仅打包后可下载更新/.test(r1.error) && downloadCalls === 0, JSON.stringify(r1));

  // 2. 打包态：调起 downloadUpdate（autoDownload=false 下这是唯一下载入口），完成后进终态
  electronAppStub.isPackaged = true;
  const r2 = await startDownload();
  verify('打包态下载：调起 autoUpdater.downloadUpdate() 并进入 downloaded 终态',
    r2.ok === true && r2.state === 'downloaded' && downloadCalls === 1 && getDownloadState() === 'downloaded',
    `${JSON.stringify(r2)} calls=${downloadCalls} state=${getDownloadState()}`);
  verify('下载完成向渲染层推送 downloaded（事件缺失时由 IPC 兜底补齐）',
    statusPushes.some((s) => s.status === 'downloaded'), JSON.stringify(statusPushes.slice(-3)));

  // 3. 缺陷本体：100% 之后再触发下载，不得再来一轮
  const r3 = await startDownload();
  verify('100% 后重复触发下载：幂等跳过，downloadUpdate 仍只调用 1 次',
    r3.ok === true && r3.skipped === true && r3.state === 'downloaded' && downloadCalls === 1,
    `${JSON.stringify(r3)} calls=${downloadCalls}`);

  // 4. downloaded 后再检查更新：跳过且不会真的 checkForUpdates（防 update-available 打回）
  const r4 = await startCheck();
  verify('downloaded 后检查更新：跳过且不再 checkForUpdates',
    r4.ok === true && r4.skipped === true && checkCalls === 0,
    `${JSON.stringify(r4)} checks=${checkCalls}`);

  // 5. 终态不被迟到事件打回（available 会重新露出「下载更新」按钮）
  const before = statusPushes.length;
  emit('update-available', { version: '9.9.9' });
  emit('download-progress', { percent: 100 });
  emit('error', new Error('late error'));
  verify('downloaded 终态：迟到的 available / 进度 / error 事件一律不推送、不改状态',
    statusPushes.length === before && getDownloadState() === 'downloaded',
    `多推 ${statusPushes.length - before} 条 · state=${getDownloadState()}`);

  // 6. 失败仍可诊断（integrity + 手动下载兜底），且失败后允许重试
  init({ getMainWindow }); // 状态机复位，模拟新一轮会话
  downloadShouldThrow = new Error('SHA512 digest mismatch for file: app.zip');
  const r5 = await startDownload();
  verify('下载失败归类 integrity 并带手动下载兜底链接',
    r5.ok === false && r5.kind === 'integrity' && /手动下载/.test(r5.hint) && !!r5.downloadUrl,
    JSON.stringify(r5));
  verify('下载失败后状态回到 idle（允许重试），不假装已完成',
    getDownloadState() === 'idle', getDownloadState());

  // 7. 连点窗口：第一轮还在 await downloadUpdate 时，第二轮必须被幂等拦下
  downloadShouldThrow = null;
  let releaseDownload = () => {};
  downloadHold = new Promise((resolve) => { releaseDownload = resolve; });
  init({ getMainWindow });
  const callsBefore = downloadCalls;
  const p1 = startDownload();
  const p2 = startDownload();
  releaseDownload();
  const [a, b] = await Promise.all([p1, p2]);
  downloadHold = null;
  verify('连点两次：第二轮被幂等拦下，downloadUpdate 只新增 1 次调用',
    downloadCalls === callsBefore + 1 && a.ok === true && a.state === 'downloaded'
      && b.ok === true && b.skipped === true && b.state === 'downloading',
    `${JSON.stringify([a, b])} calls=${downloadCalls}`);

  // 8. idle 态的正常链路不能被终态保护闷掉
  init({ getMainWindow });
  emit('checking-for-update');
  emit('update-available', { version: '1.2.3' });
  const availPush = statusPushes[statusPushes.length - 1];
  verify('idle 态仍正常推送 available（新版本检查未被误挡）',
    availPush?.status === 'available' && availPush?.version === '1.2.3', JSON.stringify(availPush));
  const checksBefore = checkCalls;
  const rIdle = await startCheck();
  verify('idle 态手动检查真的调用 checkForUpdates',
    rIdle.ok === true && !rIdle.skipped && checkCalls === checksBefore + 1,
    `${JSON.stringify(rIdle)} checks=${checkCalls}`);

  // 9. 事件驱动的状态推进：进度 → 完成 → 终态
  init({ getMainWindow });
  emit('download-progress', { percent: 42 });
  const progressPush = statusPushes[statusPushes.length - 1];
  verify('进度事件推进为 downloading 且带真实百分比',
    getDownloadState() === 'downloading' && progressPush?.percent === 42,
    `${getDownloadState()} / ${JSON.stringify(progressPush)}`);
  emit('update-downloaded');
  const donePush = statusPushes[statusPushes.length - 1];
  verify('update-downloaded 事件置终态并推送 downloaded',
    getDownloadState() === 'downloaded' && donePush?.status === 'downloaded',
    `${getDownloadState()} / ${JSON.stringify(donePush)}`);

  // 9b. 启动更新弹窗：available 载荷带 ≤40 字说明，可补拉，下载开始后不再待提示
  init({ getMainWindow });
  emit('update-available', { version: '0.8.13-beta', releaseNotes: `# 0.8.13\n- ${'修'.repeat(200)}` });
  const startupPush = statusPushes[statusPushes.length - 1];
  verify('startup 的 available 事件真的带 releaseNotes 且 ≤40 字',
    startupPush?.status === 'available' && startupPush?.version === '0.8.13-beta'
      && typeof startupPush?.releaseNotes === 'string'
      && [...startupPush.releaseNotes].length > 0
      && [...startupPush.releaseNotes].length <= 40,
    JSON.stringify(startupPush));
  const lastBefore = await handlers.get('updater:lastAvailable')();
  verify('窗口晚于自动检查加载时：updater:lastAvailable 补拉到同一条待提示且 state=idle',
    lastBefore.ok === true && lastBefore.state === 'idle'
      && lastBefore.info?.version === '0.8.13-beta'
      && lastBefore.info?.releaseNotes === startupPush.releaseNotes,
    JSON.stringify(lastBefore));
  await startDownload();
  const lastAfter = await handlers.get('updater:lastAvailable')();
  verify('点「更新」进入下载后清空待提示：渲染层重挂载不得再弹「取消 / 更新」',
    lastAfter.info === null && lastAfter.state === 'downloaded', JSON.stringify(lastAfter));
  init({ getMainWindow });
  emit('update-not-available');
  const lastNone = await handlers.get('updater:lastAvailable')();
  verify('已是最新时同样清空待提示',
    lastNone.info === null && lastNone.state === 'idle', JSON.stringify(lastNone));

  // 10. 静态钉值：链路里没有运行时测试覆盖的几处（自动检查 / 渲染层）
  const updaterSrc = fs.readFileSync(path.join(DESKTOP, 'main/updater/index.js'), 'utf8');
  verify('autoDownload 保持 false：下载由用户显式触发',
    /autoUpdater\.autoDownload = false/.test(updaterSrc));
  verify('updater:download 走 canStartDownload 幂等门（防守卫被删后行为回归）',
    /const gate = canStartDownload\(\);/.test(updaterSrc) && /if \(!gate\.start\)/.test(updaterSrc));
  verify('启动 10s 自动检查同样跳过非 idle 态',
    /function scheduleAutoUpdateCheck\(\) \{[\s\S]*?if \(downloadState !== 'idle'\) return;[\s\S]*?autoUpdateChecked = true;/.test(updaterSrc));
  const sectionSrc = fs.readFileSync(path.join(DESKTOP, 'renderer/src/components/UpdateSection.tsx'), 'utf8');
  verify('渲染层终态保护：downloaded 后忽略迟到的非 downloaded 事件',
    /downloadedRef\.current && d\.status !== 'downloaded'/.test(sectionSrc));
  verify('渲染层点击后立即乐观置为 downloading（消除可连点窗口）',
    /setUpdaterState\('downloading'\)/.test(sectionSrc) && /if \(downloadedRef\.current\) return;/.test(sectionSrc));

  console.log(`\nupdater-errors: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
