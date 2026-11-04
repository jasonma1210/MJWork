// IM 对接 IPC（钉钉 / 飞书 / 企微）：配置 CRUD + OAuth 授权 + 消息发送。
// 密钥加解密由注入的 credentialCrypto（safeStorage 双轨）承担，本层只做参数转发与形状收口。
// 渲染层只拿脱敏配置（imConfig.maskConfig 保证密钥不回明文）。
const {
  saveConfig, deleteConfig, createPairing, status, PLATFORM_IDS, IM_PLATFORMS, oauthStart, oauthCallback, sendMessage,
} = require('../imConfig');
const { createImProtocolHandler } = require('../imProtocol');

function initImIpc({ ipcMain, getCredentialCrypto, app, getWindows }) {
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
  ipcMain.handle('im:oauthStart', async (_, payload = {}) => oauthStart(payload.platform, { cryptoAdapter: cryptoOf(), redirectUri: payload.redirectUri }));
  ipcMain.handle('im:oauthCallback', async (_, payload = {}) => oauthCallback(payload.platform, payload.params, { cryptoAdapter: cryptoOf(), fetch: payload.fetch }));
  ipcMain.handle('im:send', async (_, payload = {}) => sendMessage(payload.platform, payload.message, { cryptoAdapter: cryptoOf(), fetch: payload.fetch, endpoint: payload.endpoint }));

  // OAuth 深链回落（mjcode://im-oauth）：注册协议客户端 + 收 open-url / second-instance。
  // 无 app（纯 Node 测试宿主）时返回 null，IPC 面照常可用。
  return app ? createImProtocolHandler({ app, getWindows, oauthCallback, cryptoAdapter: cryptoOf }) : null;
}

module.exports = { initImIpc };
