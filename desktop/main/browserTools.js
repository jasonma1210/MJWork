// T4-1：Browser Use 工具层（主进程侧）——六个浏览器工具的实现 + 审批闸 + 会话管理。
// 执行面（Playwright/浏览器进程）全部在 browserProcess 子进程（T3-6 驻留模式），
// 本模块只做：会话编排（每对话一个浏览器子进程）、审批判定（L3 审批闸）、审计留痕、
// 截图落盘与预览句柄（复用 T3-1 mjpreview:// 协议，字节不过 IPC 消息体）。
// 审批设计（验收「审批覆盖率 100%，无静默放行」）：
//   · browser_navigate / screenshot / extract：L3，可经「始终允许/本对话同类」规则豁免
//     （读页面内容风险低于写操作，规则粒度=完整 URL 前缀，见 approval.matchPattern）；
//   · browser_click / fill / select：恒逐次确认——页面上的点击/输入可能触发支付、
//     登录、发送等真实副作用，任何规则不可静默放行（与 CUA 逐次确认同纪律）。
// 依赖注入 initBrowserTools：{ requestApproval, applyApprovalDecision, getAlwaysRules, conversationRules, userDataDir }
const path = require('path');
const fs = require('fs');
const approval = require('./approval');
const { audit } = require('./audit/auditLog');
const browserProcess = require('./browserProcess/host');

let deps = null;
const sessions = new Map(); // conversationId -> { session, lastUsed }

// 闲置会话回收：30 分钟未用即 dispose（浏览器进程不无限驻留）
const IDLE_TTL_MS = 30 * 60 * 1000;
let sweepTimer = null;

function initBrowserTools(d) {
  deps = d;
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepIdle, 5 * 60 * 1000);
    if (sweepTimer.unref) sweepTimer.unref();
  }
}

function sweepIdle() {
  const now = Date.now();
  for (const [key, rec] of sessions) {
    if (now - rec.lastUsed > IDLE_TTL_MS) {
      try { rec.session.dispose(); } catch { /* 已释放 */ }
      sessions.delete(key);
    }
  }
}

function disposeAll() {
  for (const [, rec] of sessions) {
    try { rec.session.dispose(); } catch { /* 已释放 */ }
  }
  sessions.clear();
}

function getSession(conversationId) {
  // 测试注入面：deps.createSession 提供时用假会话（审批/编排逻辑可脱离真实子进程单测）
  if (typeof deps.createSession === 'function') {
    const key = `fake:${String(conversationId || 'default')}`;
    let rec = sessions.get(key);
    if (!rec) {
      rec = { session: deps.createSession(), lastUsed: Date.now() };
      sessions.set(key, rec);
    }
    rec.lastUsed = Date.now();
    return rec.session;
  }
  if (!browserProcess.isAvailable()) {
    throw Object.assign(
      new Error('浏览器能力不可用（子进程宿主未就绪）：Browser Use 需要 Electron utilityProcess'),
      { browserDegraded: true },
    );
  }
  const key = String(conversationId || 'default');
  let rec = sessions.get(key);
  if (!rec) {
    rec = { session: browserProcess.createSession(), lastUsed: Date.now() };
    sessions.set(key, rec);
  }
  rec.lastUsed = Date.now();
  return rec.session;
}

// 恒逐次确认的写操作通道：不经 needsApproval（规则不可豁免），直接弹卡；
// 审批卡文案（含支付/登录/发送类敏感警示行）由 approval.approvalSummary 统一生成
async function requirePerCallApproval(toolKey, args) {
  const decision = await deps.requestApproval(toolKey, args);
  if (decision === 'deny') {
    audit(toolKey, summarize(toolKey, args), '用户拒绝', 'denied');
    return { ok: false, error: '用户拒绝执行', denied: true };
  }
  // 决策仅本次有效——写操作不沉淀「始终允许」，防止一次批准演变为永久放行
  return null;
}

// L3 可规则豁免通道（navigate/screenshot/extract）
async function gateApproval(toolKey, args) {
  const { approvalMode = 'on-request', conversationId } = args;
  const verdict = approval.needsApproval({
    tool: toolKey, args, approvalMode, conversationId,
    alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules,
  });
  if (verdict.need) {
    const decision = await deps.requestApproval(toolKey, args);
    if (decision === 'deny') {
      audit(toolKey, summarize(toolKey, args), '用户拒绝', 'denied');
      return { ok: false, error: '用户拒绝执行', denied: true };
    }
    deps.applyApprovalDecision(decision, toolKey, args, conversationId);
  }
  return { allowed: true, asked: !!verdict.need, matched: verdict.matched || 'none' };
}

function summarize(toolKey, args = {}) {
  if (toolKey === 'browser_navigate') return String(args.url || '');
  if (toolKey === 'browser_click') return `click ${args.selector || ''}`;
  if (toolKey === 'browser_fill') return `fill ${args.selector || ''} = ${String(args.value || '').slice(0, 40)}`;
  if (toolKey === 'browser_select') return `select ${args.selector || ''} -> ${JSON.stringify(args.value ?? '')}`;
  if (toolKey === 'browser_screenshot') return `screenshot${args.fullPage ? ' (fullPage)' : ''}`;
  if (toolKey === 'browser_extract') return `extract ${args.selector || '(整页)'}`;
  return toolKey;
}

// 统一执行包装：审批 → 子进程调用 → 审计；子进程降级错误转结构化失败（loop 对 error 有兜底）
async function runBrowserTool(toolKey, args, { perCall, channel, channelArgs } = {}) {
  if (!deps) return { ok: false, error: '浏览器工具未初始化' };
  const { conversationId = '', ...rest } = args || {};
  if (perCall) {
    const denied = await requirePerCallApproval(toolKey, rest);
    if (denied) return denied;
  } else {
    const gate = await gateApproval(toolKey, args || {});
    if (gate.ok === false) return gate;
  }
  let result;
  try {
    const session = getSession(conversationId);
    result = await session.call(channel, channelArgs || rest);
  } catch (err) {
    const degraded = !!(err && (err.browserDegraded || err.browserChildDead));
    audit(toolKey, summarize(toolKey, rest), `error: ${err.message}`, degraded ? 'degraded' : 'failed');
    return { ok: false, error: err.message, ...(degraded ? { degraded: true } : {}) };
  }
  audit(toolKey, summarize(toolKey, rest), 'ok', perCall ? 'approved' : 'recorded');
  return { ok: true, ...result };
}

// ── 六个工具实现（agent-core toolHandlers 直挂）──

async function toolBrowserNavigate(args = {}) {
  // 模型面 snake_case → 子进程 camelCase
  return runBrowserTool('browser_navigate', args, {
    perCall: false, channel: 'navigate',
    channelArgs: { url: args.url, waitUntil: args.wait_until || args.waitUntil },
  });
}

async function toolBrowserClick(args = {}) {
  return runBrowserTool('browser_click', args, { perCall: true, channel: 'click' });
}

async function toolBrowserFill(args = {}) {
  return runBrowserTool('browser_fill', args, { perCall: true, channel: 'fill' });
}

async function toolBrowserSelect(args = {}) {
  // 模型面 value 是字符串：多选场景传 JSON 数组字符串（如 '["a","b"]'）时解析为数组
  let value = args.value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { value = JSON.parse(value); } catch { /* 保持原字符串（单选值恰好以 [ 开头） */ }
  }
  return runBrowserTool('browser_select', args, { perCall: true, channel: 'select', channelArgs: { selector: args.selector, value } });
}

async function toolBrowserScreenshot(args = {}) {
  if (!deps) return { ok: false, error: '浏览器工具未初始化' };
  const { conversationId = '' } = args || {};
  const fullPage = !!(args && (args.full_page ?? args.fullPage));
  // 截图先过审批（与 navigate 同闸：可规则豁免），批准后才触页——审批覆盖 100%
  const gate = await gateApproval('browser_screenshot', args);
  if (gate.ok === false) return gate;
  const shotDir = path.join(deps.userDataDir, 'browser-shots');
  try { fs.mkdirSync(shotDir, { recursive: true }); } catch (e) { console.warn('[browser] 截图目录创建失败:', e?.message || e); }
  const outPath = path.join(shotDir, `shot-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`);
  let result;
  try {
    const session = getSession(conversationId);
    result = await session.call('screenshot', { outPath, fullPage: !!fullPage });
  } catch (err) {
    const degraded = !!(err && (err.browserDegraded || err.browserChildDead));
    audit('browser_screenshot', summarize('browser_screenshot', args), `error: ${err.message}`, degraded ? 'degraded' : 'failed');
    return { ok: false, error: err.message, ...(degraded ? { degraded: true } : {}) };
  }
  // 截图证据回渲染层：文件句柄走 mjpreview://（T3-1 同机制），IPC 只带 URL
  let previewUrl = '';
  try {
    const { grantPreviewToken } = require('./previewScheme');
    previewUrl = grantPreviewToken(outPath);
  } catch (e) {
    console.warn('[browserTools] 预览句柄发放失败（截图仍落盘）:', e.message);
  }
  audit('browser_screenshot', `${result.path} (${result.bytes}B)`, 'ok', gate.asked ? 'approved' : 'recorded');
  return { ok: true, path: result.path, bytes: result.bytes, previewUrl };
}

async function toolBrowserExtract(args = {}) {
  return runBrowserTool('browser_extract', args, {
    perCall: false, channel: 'extract',
    channelArgs: { selector: args.selector, limit: args.limit },
  });
}

// 能力探测（设置页/诊断用）：不启动浏览器，只解析可用性
async function browserProbe() {
  if (!browserProcess.isAvailable()) return { ok: false, error: '子进程宿主不可用（非 Electron 环境）' };
  try {
    const session = getSession('probe');
    const r = await session.call('probe', {});
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message, degraded: !!(err.browserDegraded || err.browserChildDead) };
  }
}

module.exports = {
  initBrowserTools, disposeAll, browserProbe,
  toolBrowserNavigate, toolBrowserClick, toolBrowserFill,
  toolBrowserSelect, toolBrowserScreenshot, toolBrowserExtract,
  // 测试注入面
  _sessions: () => sessions,
};
