// T3-1：大文件预览不再把二进制 base64 塞进 IPC 消息体。
// 背景：file:preview 对 ≤24MB 图片/PDF/音视频返回 dataUrl（base64 字符串），
// 24MB 文件 → 约 32MB 字符串单条 IPC 直达渲染层，主渲染两进程都被结构化克隆拖卡。
// 策略：注册自定义流式协议 mjpreview://p/<token>，渲染层 <img>/<video>/<iframe>
// 的 src 直接指向该 URL——字节由 Chromium 网络栈流式加载，完全不经过 IPC 消息体。
// 安全：token 为一次性随机值，只映射「主进程已校验过的绝对路径」；URL 里不含路径，
// 无穿越面；TTL 10 分钟，过期即 404；渲染层无法凭 URL 猜测或构造其他文件。
// 用法：main.js 顶层调 registerPreviewSchemePrivileges()（必须早于 app ready），
// whenReady 后调 initPreviewScheme()；file:preview 超限路径调 grantPreviewToken()。
const { protocol, net } = require('electron');
const crypto = require('crypto');

const TOKEN_TTL_MS = 10 * 60 * 1000;
const tokens = new Map(); // token -> { file, expires }

function registerPreviewSchemePrivileges() {
  // 标准 scheme 特权：支持 fetch API 与流式读取，且按安全上下文对待
  // 可选链：测试环境 electron stub 无 protocol，跳过（该路径不参与测试断言）
  protocol?.registerSchemesAsPrivileged?.([
    { scheme: 'mjpreview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function initPreviewScheme() {
  protocol?.handle?.('mjpreview', async (request) => {
    // URL 形如 mjpreview://p/<token>
    let token = '';
    try {
      const u = new URL(request.url);
      token = u.pathname.replace(/^\//, '');
    } catch { /* 非法 URL 走 404 */ }
    const h = tokens.get(token);
    if (!h || h.expires <= Date.now()) {
      if (h) tokens.delete(token);
      return new Response('preview token expired or unknown', { status: 404 });
    }
    try {
      // net.fetch(file://) 由 Chromium 文件流实现，天然分块、不整读进内存
      return await net.fetch(`file://${encodeURI(h.file).replace(/#/g, '%23').replace(/\?/g, '%3F')}`);
    } catch (e) {
      // 404 是明确形态（门禁不算静默），但成因被丢掉了：文件被删 / 权限不足 / 路径编码问题
      // 在 iframe 里都只显示「文件无法读取」，而排查只能从主进程日志看。取一次上下文值一行日志。
      console.warn('[preview] 预览文件读取失败：', h.file, e?.code || '', e?.message || e);
      return new Response('file not readable', { status: 404 });
    }
  });
  // 周期清扫（unref 不阻止退出）
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of tokens) if (v.expires <= now) tokens.delete(k);
  }, 5 * 60 * 1000);
  if (t.unref) t.unref();
}

// 授予一次性预览 URL（绝对路径由调用方 resolveToolPath 校验后传入）
function grantPreviewToken(absPath) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { file: absPath, expires: Date.now() + TOKEN_TTL_MS });
  return `mjpreview://p/${token}`;
}

module.exports = { registerPreviewSchemePrivileges, initPreviewScheme, grantPreviewToken };
