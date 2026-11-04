// T2-1：自动更新域（自主进程 main.js 原样搬移，行为不变）
// electron-updater，仅打包态生效；延迟 require 避免非 electron 环境崩溃。
//
// P1-N：更新链路默认值三件套——
//   1) 启动延迟 10s 自动 checkForUpdates（autoDownload 保持 false，下载仍需用户确认）；
//   2) error/available 态附手动下载链接（GitHub Releases 页），检查失败也能降级自助；
//   3) 更新通道：MJ_UPDATE_CHANNEL=beta 走预发布通道（默认 latest，与 publish.channel 对齐）。
// 修复潜在 bug（历史）：autoUpdater 原在 initUpdater 内 const 声明，却被模块级 IPC handler
// 引用，打包态点「检查更新」必抛 ReferenceError（手动检查链路从未真正工作过）。
//
// 依赖注入（沿用 initXxx(deps) 模式）：initUpdater 需要读当前主窗口（状态推送目标），
// 窗口生命周期归 main.js，本模块经 getMainWindow 只读取。
const { app, ipcMain } = require('electron');

const UPDATE_CHECK_DELAY_MS = 10 * 1000;
const UPDATE_CHANNEL = process.env.MJ_UPDATE_CHANNEL || 'latest';
let autoUpdater = null;
let updaterInitialized = false;
let autoUpdateChecked = false;

// 2026-11-04（用户反馈「通用 → 版本更新下载到 100% 后又重新开始下载」）：
// 此前 updater:download **无条件**调用 autoUpdater.downloadUpdate()，去重只靠渲染层按钮
// disabled，而该 disabled 依赖异步的 download-progress 事件 ⇒ 事件到达前按钮仍可点，
// 连点即产生两轮下载；更常见的是下载完成后再次 checkForUpdates（手动「检查更新」或
// 启动 10s 自动检查）触发 update-available，把状态机打回 available，UI 又露出
// 「下载更新」按钮 ⇒ 100% 之后重新开始第二轮。
// 现在主进程持有下载状态的**唯一真源**：任何重复下载/重复检查都被幂等拦下，
// 且 downloaded 是终态，update-available 不得把它打回。
let downloadState = 'idle'; // idle | downloading | downloaded

/** 纯函数：是否允许发起一轮新下载（供单测直接断言三态，不依赖 IPC 环境）。 */
function canStartDownload(state = downloadState) {
  if (state === 'downloading') return { start: false, state: 'downloading' };
  if (state === 'downloaded') return { start: false, state: 'downloaded' };
  return { start: true, state: 'idle' };
}

function getDownloadState() {
  return downloadState;
}

let getMainWindow = () => null;
let lastDownloadPercent = 0;

/** 状态推送唯一出口：IPC 跳过分支与 autoUpdater 事件共用，保证渲染层总能对齐主进程真值。 */
function send(status, data = {}) {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { status, ...data });
  }
}

// 手动下载兜底链接：由 build.publish 推导（owner/repo 缺失时为空串，前端隐藏链接）
function resolveManualDownloadUrl() {
  try {
    const pub = require('../../package.json').build?.publish;
    if (pub?.owner && pub?.repo) return `https://github.com/${pub.owner}/${pub.repo}/releases`;
  } catch { /* package.json 读取失败不影响主流程 */ }
  return '';
}
const MANUAL_DOWNLOAD_URL = resolveManualDownloadUrl();

function init(deps) {
  getMainWindow = deps.getMainWindow;
  downloadState = 'idle';
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return { ok: false, error: '仅打包后可检查更新' };
    const up = initUpdater();
    if (!up) return { ok: false, error: '更新器初始化失败' };
    // 下载中/已下载时不再检查：checkForUpdates 会再次发 update-available，
    // 把已完成态打回 available，UI 又露出「下载更新」按钮 ⇒ 第二轮下载。
    if (downloadState !== 'idle') {
      // 重推当前真值：设置页可能已重挂载、本地状态丢了也能立刻对回终态
      if (downloadState === 'downloaded') send('downloaded');
      else send('downloading', { percent: lastDownloadPercent });
      return { ok: true, skipped: true, state: downloadState };
    }
    try {
      await up.checkForUpdates();
      return { ok: true };
    } catch (err) {
      const { kind, hint } = classifyUpdateError(err);
      return { ok: false, error: err.message, kind, hint, downloadUrl: MANUAL_DOWNLOAD_URL };
    }
  });

  // P0-3：补上更新回路缺失的一环——此前全仓零调用 downloadUpdate、无 updater:download IPC，
  // 用户看到 available 后没有任何按钮触发下载，updater:install 因前置状态永不满足而成死代码。
  // autoDownload 已为 false：下载必须由用户显式点击「下载更新」触发。
  // download-progress 事件在 initUpdater 内已推送（downloading + percent），此处接上即可。
  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) return { ok: false, error: '仅打包后可下载更新' };
    const up = initUpdater();
    if (!up) return { ok: false, error: '更新器初始化失败' };
    const gate = canStartDownload();
    if (!gate.start) {
      // 幂等：重复点击 / 100% 之后再来一轮，一律不再调 downloadUpdate。
      // 同时把当前真值推给渲染层（可能刚打开设置页或状态已丢失），避免按钮永远停在进度态。
      if (gate.state === 'downloaded') send('downloaded');
      else send('downloading', { percent: lastDownloadPercent });
      return { ok: true, skipped: true, state: gate.state };
    }
    // 同步置位：await 之前连点两次也不会各自进入下载分支
    downloadState = 'downloading';
    lastDownloadPercent = 0;
    try {
      await up.downloadUpdate();
      // 正常情况下 update-downloaded 事件已置终态；这里兜住「事件未发但 Promise 已 resolve」
      if (downloadState === 'downloading') {
        downloadState = 'downloaded';
        lastDownloadPercent = 100;
        send('downloaded'); // 事件未达时也把终态补齐，避免渲染层停在进度态
      }
      // 成功响应回带真值：渲染层不依赖「状态事件一定先于 IPC 响应到达」
      return { ok: true, state: downloadState };
    } catch (err) {
      // 失败允许重试；但已经完成过下载的终态不许被一次迟到异常打回
      if (downloadState !== 'downloaded') downloadState = 'idle';
      const { kind, hint } = classifyUpdateError(err);
      return { ok: false, error: err.message, kind, hint, downloadUrl: MANUAL_DOWNLOAD_URL };
    }
  });

  ipcMain.handle('updater:install', async () => {
    if (!app.isPackaged) return { ok: false, error: '仅打包后可安装更新' };
    const up = initUpdater();
    if (!up) return { ok: false, error: '更新器初始化失败' };
    up.quitAndInstall();
    return { ok: true };
  });
}

// T2-7：更新失败可诊断文案——把 electron-updater 的原始错误按失败模式归类，
// 给用户「下一步做什么」而不是天书堆栈（断网 / 包校验失败 / 下载中断 / 安装前置失败）。
// 校验类错误绝不静默：签名/digest 不匹配意味着包损坏或中间人替换，必须显式警告。
function classifyUpdateError(err) {
  const msg = String(err?.message || err || '');
  if (/ECONNREFUSED|getaddrinfo|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|offline|Could not connect/i.test(msg)) {
    return { kind: 'network', hint: '无法连接更新服务器：请检查网络后重试；不影响当前版本使用' };
  }
  if (/digest|checksum|signature|verification|SHA512|not valid|blockmap/i.test(msg)) {
    return { kind: 'integrity', hint: '更新包校验失败（可能下载损坏或被篡改）：请勿继续安装，前往发布页手动下载官方包' };
  }
  if (/404|Cannot find update|no published/i.test(msg)) {
    return { kind: 'notfound', hint: '未找到可用的更新发布（更新源未就绪或通道配置有误）' };
  }
  if (/EPERM|EACCES|busy|locked|Installer (error|volume)/i.test(msg)) {
    return { kind: 'install', hint: '安装前置失败（权限/磁盘占用）：请退出应用后重试，或手动下载覆盖安装' };
  }
  return { kind: 'unknown', hint: '更新失败：可稍后重试；若持续失败请导出诊断包（设置 → 问题诊断）反馈' };
}

function initUpdater() {
  if (!app.isPackaged || updaterInitialized) return autoUpdater;
  updaterInitialized = true;
  // electron-updater 体积大且仅打包后需要：按需加载，避免开发态启动开销
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  if (UPDATE_CHANNEL && UPDATE_CHANNEL !== 'latest') {
    try { autoUpdater.channel = UPDATE_CHANNEL; } catch (e) { console.warn('[updater] 更新通道设置失败:', e.message); }
    // 非 latest 通道必须允许预发布：GitHub provider 默认只认正式 Release，
    // 只设 channel 而不设 allowPrerelease 时，beta 通道实际上永远「已是最新」（技术设计文档 X22）。
    try { autoUpdater.allowPrerelease = true; } catch (e) { console.warn('[updater] allowPrerelease 设置失败:', e.message); }
  }
  // 降级只在显式开启时允许：默认 false，避免某个通道的旧 metadata 把用户静默回退。
  // 需要回滚演练时设 MJ_ALLOW_DOWNGRADE=1（卸载重装之外的第二条路径）。
  if (process.env.MJ_ALLOW_DOWNGRADE === '1') {
    try { autoUpdater.allowDowngrade = true; } catch (e) { console.warn('[updater] allowDowngrade 设置失败:', e.message); }
  }
  autoUpdater.on('checking-for-update', () => { if (downloadState === 'idle') send('checking'); });
  autoUpdater.on('update-available', (info) => {
    // downloaded 是终态；downloading 中也不许把进度面打回 available（会再露出「下载更新」按钮）
    if (downloadState !== 'idle') return;
    send('available', { version: info.version, downloadUrl: MANUAL_DOWNLOAD_URL });
  });
  autoUpdater.on('update-not-available', () => { if (downloadState === 'idle') send('up-to-date'); });
  autoUpdater.on('download-progress', (p) => {
    if (downloadState === 'downloaded') return; // 忽略迟到的进度事件（100% 后又被显示成「下载中」）
    downloadState = 'downloading';
    lastDownloadPercent = Math.round(p.percent);
    send('downloading', { percent: lastDownloadPercent });
  });
  autoUpdater.on('update-downloaded', () => {
    downloadState = 'downloaded';
    lastDownloadPercent = 100;
    send('downloaded');
  });
  autoUpdater.on('error', (err) => {
    if (downloadState === 'downloaded') return; // 终态不被错误事件打回
    if (downloadState === 'downloading') downloadState = 'idle'; // 失败后允许重试
    const { kind, hint } = classifyUpdateError(err);
    send('error', { message: err.message, kind, hint, downloadUrl: MANUAL_DOWNLOAD_URL });
  });
  return autoUpdater;
}

// P1-N：启动延迟自动检查（不打扰首启；失败仅提示，不阻断使用）
function scheduleAutoUpdateCheck() {
  if (!app.isPackaged) return;
  setTimeout(() => {
    if (autoUpdateChecked) return;
    // 启动后 10s 的检查若撞上正在下载/已下载，同样跳过：否则 update-available 会重启一轮
    if (downloadState !== 'idle') return;
    autoUpdateChecked = true;
    const up = initUpdater();
    up?.checkForUpdates().catch((err) => console.warn('[updater] 启动自动检查失败（忽略，用户可手动检查）:', err.message));
  }, UPDATE_CHECK_DELAY_MS).unref?.();
}

module.exports = { init, initUpdater, scheduleAutoUpdateCheck, resolveManualDownloadUrl, classifyUpdateError, canStartDownload, getDownloadState, UPDATE_CHECK_DELAY_MS, UPDATE_CHANNEL };
