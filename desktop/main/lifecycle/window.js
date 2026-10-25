// T2-1：窗口生命周期域（自主进程 main.js 原样搬移，行为不变）
// 覆盖：窗口状态持久化（bounds 记忆）/ 主窗口创建（dev 走 vite、打包走 file://）/
//       打包版 console tee 到 userData/logs。
//
// 依赖注入：mainWindow 归属 main.js（whenReady 接线与各域广播都要用），
// 经 getMainWindow/setMainWindow 读写；本模块负责创建与状态落盘。
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

let getMainWindow = () => null;
let setMainWindow = () => {};

function init(deps) {
  getMainWindow = deps.getMainWindow;
  setMainWindow = deps.setMainWindow;
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
  } catch (e) {
    return null; // 首次启动或文件损坏时回落默认值
  }
}

function saveWindowState() {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;
  try {
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify(mainWindow.getBounds()));
  } catch (e) {
    console.warn('[window] 状态保存失败:', e.message);
  }
}

function createWindow() {
  const state = loadWindowState();
  const mainWindow = new BrowserWindow({
    width: state?.width || 1600,
    height: state?.height || 1000,
    x: state?.x,
    y: state?.y,
    minWidth: 1200, minHeight: 700,
    title: 'MJ Nexus', backgroundColor: '#0d0d0d', titleBarStyle: 'hiddenInset',
    // 首帧闪烁修复（2026-10-17）：默认 show:true 时窗口先以纯色底显示，
    // 浅色主题用户会先看到一帧深色再跳到白底（比黑屏更刺眼）。
    // 改为等 ready-to-show（渲染进程首帧已绘制）再显示，外观由启动页接管。
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), nodeIntegration: false, contextIsolation: true, webviewTag: true },
  });
  setMainWindow(mainWindow);

  // 揭示时机：ready-to-show 为准；极端情况（渲染进程异常）该事件可能不触发，
  // 用 1.5s 兜底强制显示——宁可闪一下，也不能出现「窗口不出现」。
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    try { mainWindow.show(); } catch (e) { console.warn('[window] show failed:', e.message); }
  };
  mainWindow.once('ready-to-show', reveal);
  setTimeout(reveal, 1500);
  // 生产构建走 file:// 加载打包产物；开发走 vite dev server
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'dist', 'index.html'));
  } else {
    mainWindow.loadURL('http://localhost:5173');
    if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools();
  }
  // 新窗口/弹窗：一律 deny 并交给系统浏览器（target=_blank、window.open）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // 2026-10-17 真机修复（用户实测：点 MCP 里需要跳转的条目，返回后变成「新建会话界面」）：
  // setWindowOpenHandler 只拦 target=_blank / window.open，**拦不住同窗口导航**——
  // `<a href="https://...">`（无 target）、`location.href=`、表单提交都会让渲染进程整页跳走，
  // SPA 被卸载；返回/后退时应用重新加载，activeThread 回到 null，用户看到的就是新建会话。
  // 这里做最后一道兜底：非应用自身的导航一律取消并交给系统浏览器。
  // 渲染层（MessageStream 的 markdown 链接）已同步改为显式 openExternal，这里是防再犯。
  const isInternalUrl = (raw) => {
    try {
      const u = new URL(raw);
      if (app.isPackaged) return u.protocol === 'file:';
      // 开发态：只放行本地 dev server（端口可能变，按 host 判断）
      return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    } catch {
      return false;
    }
  };
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    try { shell.openExternal(url); } catch (e) { console.warn('[window] 外链打开失败:', e.message); }
  });
  mainWindow.on('close', saveWindowState);
}

// 打包版诊断日志：console 全量 tee 到 userData/logs/main-YYYYMMDD.log。
// 背景：连续三起打包版问题（SIGSEGV/凭证加密/运行中停止）都因「主进程日志不可见」只能靠猜。
// dev 模式终端可见，不 tee（避免双写）；打包版启用。崩溃类另有 uncaughtException → crash.log。
function setupFileLogging() {
  if (!app.isPackaged) return;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `main-${new Date().toISOString().slice(0, 10)}.log`);
    const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
    const tee = (level) => (...args) => {
      orig[level](...args);
      try {
        const body = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${body.slice(0, 4000)}\n`);
      } catch { /* 日志落盘失败不影响主流程 */ }
    };
    console.log = tee('log');
    console.warn = tee('warn');
    console.error = tee('error');
  } catch (e) {
    console.warn('[logging] 文件日志初始化失败:', e.message);
  }
}

module.exports = { init, loadWindowState, saveWindowState, createWindow, setupFileLogging };
