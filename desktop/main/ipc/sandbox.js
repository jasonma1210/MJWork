// P1-4：Windows OS 级沙箱的接线 IPC 域（一次性管理员设置 / 卸载 / 命令清单审计）。
//
// 背景：Windows 沙箱后端（main/sandboxWindows.js）此前「代码在、但无入口」——
// README 自述 OS-level isolation is not yet wired。本域补上 UI 可触达的三个通道：
//   · sandbox:windows/plan      —— 纯读：返回待执行的命令清单（供 UI 展示/审计）
//   · sandbox:windows/setup     —— 写通道：提权执行一次性管理员设置（UAC）
//   · sandbox:windows/teardown  —— 写通道：卸载隔离（删除用户与防火墙规则 + 删除加密凭据）
//
// 三条纪律：
//   ① 平台守卫：非 win32 一律返回 not-supported，不抛栈、不伪造可用；
//   ② 写通道走 payloadGuard 边界校验（与 X14 约定一致）；
//   ③ safeStorage 不可用（DPAPI 缺失）时由 applyWindowsSandboxSetup 在执行前拒绝——
//      绝不把专用用户密码落成明文。
const { ipcMain, app, safeStorage } = require('electron');
const guard = require('./payloadGuard');
const windowsBackend = require('../sandboxWindows');
const logger = require('../logger');

function notSupported() {
  return {
    ok: false,
    supported: false,
    error: 'not-supported',
    reason: `Windows OS 级沙箱仅在 Windows 上可用（当前平台：${process.platform}）`,
  };
}

function initSandboxIpc() {
  ipcMain.handle('sandbox:windows/plan', async () => ({
    ok: true,
    supported: process.platform === 'win32',
    platform: process.platform,
    plan: windowsBackend.windowsSandboxPlan(),
  }));

  // 一次性管理员设置：写系统（建用户/改 ACL/加防火墙规则）→ 属高风险写通道，必须有边界校验。
  ipcMain.handle('sandbox:windows/setup', async (_, payload = {}) => {
    try { guard.assertObject(payload, 'sandboxWindowsSetup'); } catch (e) { logger.warn('[sandbox] windows/setup payload 边界校验失败：', e.message); return { ok: false, error: e.message }; }
    if (process.platform !== 'win32') return notSupported();
    // seal 仅在 DPAPI 可用时提供；缺失时 applyWindowsSandboxSetup 会在执行前如实拒绝（不落明文）。
    const seal = (() => {
      try { return safeStorage.isEncryptionAvailable() ? (plain) => safeStorage.encryptString(plain) : null; } catch (e) { logger.warn('[sandbox] safeStorage 探测失败，seal 退化为 null（setup 会在执行前如实拒绝，不落明文）：', e.message); return null; }
    })();
    return windowsBackend.applyWindowsSandboxSetup({
      seal,
      storageDir: app.getPath('userData'),
      platform: process.platform,
    });
  });

  ipcMain.handle('sandbox:windows/teardown', async (_, payload = {}) => {
    try { guard.assertObject(payload, 'sandboxWindowsTeardown'); } catch (e) { logger.warn('[sandbox] windows/teardown payload 边界校验失败：', e.message); return { ok: false, error: e.message }; }
    if (process.platform !== 'win32') return notSupported();
    return windowsBackend.windowsSandboxTeardown({ storageDir: app.getPath('userData'), platform: process.platform });
  });
}

module.exports = { initSandboxIpc };
