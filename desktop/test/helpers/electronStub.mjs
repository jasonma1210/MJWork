// 统一的 electron 打桩入口（2026-10-27）
//
// 为什么要抽出来：原有两个套件（`entry-ipc-eager` / `localdata-id-guard`）各自写
// `path.join(ROOT, 'node_modules/electron/index.js')` 当 `require.cache` 的键，这个写法只在
// 「node_modules 是实体目录」或「运行时开了 --preserve-symlinks」时成立。本仓库用 pnpm，
// `node_modules/electron` 是**指向 .pnpm 的符号链接**，Node 默认解析走 realpath，
// 于是手工拼的键与真实键不一致 —— stub 静默失效、真实 electron 被加载（其 `ipcMain` 在
// 非 Electron 运行时里是 undefined），测试以 `Cannot read properties of undefined (reading 'handle')`
// 崩掉。表现出来像产品缺陷，实际是打桩没生效：**同一份 HEAD 在干净检出里绿、在工作区里红**。
//
// 正确做法：用 `require.resolve('electron')` 拿 Node **实际会用的**文件名（是否 realpath 由
// Node 决定，不由我们猜），再用它当 cache 键。这样无论仓库哪天换回 npm/yarn、无论有没有
// --preserve-symlinks，桩都命中同一个键。
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * 把 `electron` 模块替换成给定导出对象。
 * @param {Record<string, unknown>} exports 假模块的导出（至少含 `ipcMain.handle`）
 * @returns {string} 被占位的模块文件名（便于测试自检「桩真的按这个键生效」）
 */
export function installElectronStub(exports) {
  const electronPath = require.resolve('electron');
  const stub = new Module(electronPath, null);
  stub.filename = electronPath;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[electronPath] = stub;
  return electronPath;
}
