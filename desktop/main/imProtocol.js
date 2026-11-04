'use strict';

// IM OAuth 深链回落：平台授权完成后把 `mjcode://im-oauth?platform=…&state=…&code=…` 交给本应用。
//
// 为什么必须在主进程收口：换 token 要用 appSecret（只在主进程解密），且 code 一次性、
// state 一次性——渲染层拿不到密钥也不该碰这些值。故链路是
//   渲染层 imOauthStart → 浏览器授权 → 深链(macOS open-url / 其它平台 second-instance argv)
//   → 本模块 dispatch → imConfig.oauthCallback（主进程换 token，落 enc: 密文）
//   → `im:oauth-result` 通知渲染层刷新（preload 的 imOnOAuthResult）。
//
// 三种回落路径并联，任一可用即可完成授权（平台对 redirect_uri 的校验规则不一致，
// 自建应用多数只允许已登记的回调地址，故渲染层还提供「把浏览器地址栏 URL 粘回来」的手工通道，
// 落到 IPC `im:oauthCallback`）：
//   ① macOS：`open-url` 事件；
//   ② Windows / Linux：协议客户端把 URL 作为 argv 追加到新实例 → `second-instance`；
//   ③ 手工回填：渲染层 imOauthCallback({ platform, params: { state, code } })。
const path = require('node:path');

const OAUTH_PROTOCOL = 'mjcode';
const OAUTH_URL_PREFIX = `${OAUTH_PROTOCOL}://im-oauth`;

// 解析深链。返回 null 的语义是「这不是一条 OAuth 回落链接」，不是错误——
// 同一条 argv 里可能混着文件路径等其它参数，给它们刷日志只会淹没真实失败。
function parseOAuthUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== `${OAUTH_PROTOCOL}:` || url.hostname !== 'im-oauth') return null;
    const platform = url.searchParams.get('platform');
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!platform || !state || !code) return null;
    return { platform, params: { state, code, error: url.searchParams.get('error') || '' } };
  } catch {
    // 非法 URL / 空串：按「不是我们的链接」处理（与上面的 hostname 不匹配同一语义）。
    // 不写日志：命令行里每个普通参数都会走到这里，记日志等于噪声。
    return null;
  }
}

// 注册 `mjcode://` 协议客户端。开发态（非打包）Electron 需要显式给 execPath + 脚本路径，
// 否则系统把 `mjcode://…` 指到 Electron 二进制、丢掉入口参数。
function registerProtocolClient(app) {
  if (!app || typeof app.setAsDefaultProtocolClient !== 'function') return 'unsupported';
  try {
    const ok = process.defaultApp && process.argv.length >= 2
      ? app.setAsDefaultProtocolClient(OAUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
      : app.setAsDefaultProtocolClient(OAUTH_PROTOCOL);
    return ok ? 'registered' : 'refused';
  } catch (e) {
    console.warn('[im] protocol client registration failed:', e?.message ?? e);
    return 'failed';
  }
}

function createImProtocolHandler({ app, getWindows, oauthCallback, cryptoAdapter }) {
  if (!app || typeof oauthCallback !== 'function') throw new Error('IM 协议处理器依赖 app/oauthCallback');
  const windows = () => (typeof getWindows === 'function' ? getWindows() : []);
  const notify = (result) => {
    for (const win of windows()) {
      try { win?.webContents?.send('im:oauth-result', result); }
      catch (e) { console.warn('[im] oauth result delivery failed:', e?.message ?? e); }
    }
  };
  const dispatch = (raw) => {
    const parsed = parseOAuthUrl(raw);
    if (!parsed) return false;
    const adapter = typeof cryptoAdapter === 'function' ? cryptoAdapter() : cryptoAdapter;
    Promise.resolve(oauthCallback(parsed.platform, parsed.params, { cryptoAdapter: adapter }))
      .then((result) => notify(result && typeof result === 'object' ? result : { ok: false, error: 'oauth-callback-failed' }))
      .catch((error) => {
        notify({ ok: false, error: 'oauth-callback-failed' });
        console.warn('[im] oauth callback failed:', error?.message ?? error);
      });
    return true;
  };
  // ① macOS：协议链接通过 open-url 送达（必须 preventDefault，否则系统按未处理处置）
  if (process.platform === 'darwin' && typeof app.on === 'function') {
    app.on('open-url', (event, url) => { event.preventDefault(); dispatch(url); });
  }
  // ② Windows / Linux：新实例启动时 URL 在 argv 里。独立监听，不改 main.js 既有的
  // second-instance（专注窗口恢复）——Electron 允许多个监听器并存。
  if (process.platform !== 'darwin' && typeof app.on === 'function') {
    app.on('second-instance', (_event, argv) => {
      const hit = (Array.isArray(argv) ? argv : []).find((a) => String(a).startsWith(OAUTH_URL_PREFIX));
      if (hit) dispatch(hit);
    });
  }
  // 注册协议客户端要等 ready 之后（打包前 Info.plist / 注册表写入依赖 app 就绪）
  const ready = typeof app.whenReady === 'function' ? app.whenReady() : Promise.resolve();
  Promise.resolve(ready).then(() => {
    const r = registerProtocolClient(app);
    if (r !== 'registered') console.warn(`[im] protocol client ${r}; deep-link callback may need manual paste`);
  }).catch((e) => console.warn('[im] protocol client registration deferred:', e?.message ?? e));
  return { dispatch };
}

module.exports = { OAUTH_PROTOCOL, OAUTH_URL_PREFIX, parseOAuthUrl, registerProtocolClient, createImProtocolHandler };
