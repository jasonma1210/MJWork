// IM 对接 IPC（钉钉 / 飞书 / 企微）：配置 CRUD + 配对码脚手架。
// 密钥加解密由注入的 credentialCrypto（safeStorage 双轨）承担，本层只做参数转发与形状收口。
// 渲染层只拿脱敏配置（imConfig.maskConfig 保证密钥不回明文）。
const {
  saveConfig, deleteConfig, createPairing, status, PLATFORM_IDS, IM_PLATFORMS,
} = require('../imConfig');

function initImIpc({ ipcMain, getCredentialCrypto }) {
  if (!ipcMain) throw new Error('initImIpc 需要 ipcMain');
  const cryptoOf = () => {
    const c = getCredentialCrypto ? getCredentialCrypto() : null;
    return c && typeof c.encrypt === 'function' ? c : null;
  };

  // schema 暴露字段键/密钥位/必填位（无任何密钥值），渲染层据此动态渲染表单，键名单一来源不漂移。
  ipcMain.handle('im:list', async () => ({ ok: true, platforms: PLATFORM_IDS, schema: IM_PLATFORMS, items: status() }));
  ipcMain.handle('im:save', async (_, payload = {}) => saveConfig(payload.platform, payload.fields, cryptoOf()));
  ipcMain.handle('im:delete', async (_, payload = {}) => deleteConfig(payload.platform));
  ipcMain.handle('im:pair', async (_, payload = {}) => createPairing(payload.platform));
}

module.exports = { initImIpc };
