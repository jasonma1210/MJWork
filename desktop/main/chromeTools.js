// T4-2：Chrome 接管工具层（主进程侧）——七个 chrome_* 工具的实现 + 审批闸 + 审计。
// 与 T4-1 browserTools 同纪律（风控沿用），差异在执行面：操作对象是用户真实 Chrome
// （登录态/已开标签页），经 chromeRelay 中继转发给扩展（CDP），本模块不直接碰浏览器。
// 审批设计：
//   · chrome_status：不进审批面的权威在 approval.js 的 toolLevel() 特判（2026-10-20 产品裁决 D-14，
//     与 notify/todo_write 同纪律），本文件**不自我豁免**——它和 toolChromeStatus 都不调用
//     needsApproval，故「不弹卡」靠的是上游分级判定，不是本层漏接；
//   · chrome_tabs / navigate / screenshot / extract：L3，可经规则豁免（粒度=URL 前缀/选择器）；
//   · chrome_click / chrome_fill：恒逐次确认——用户浏览器带真实登录态，
//     点击/输入可能直接触发支付、发送等不可逆操作，任何规则不可静默放行。
// 依赖注入 initChromeTools：{ requestApproval, applyApprovalDecision, getAlwaysRules,
//   conversationRules, userDataDir, relay }（relay=chromeRelay server 模块，测试可注入假中继）
const path = require('path');
const fs = require('fs');
const { isPrivateHost } = require('./ssrfGuard');
const approval = require('./approval');
const { audit } = require('./audit/auditLog');

let deps = null;

function initChromeTools(d) { deps = d; }

// 恒逐次确认通道：直接弹卡，决策不沉淀（与 browserTools 同实现纪律）
async function requirePerCallApproval(toolKey, args) {
  const decision = await deps.requestApproval(toolKey, args);
  if (decision === 'deny') {
    audit(toolKey, summarize(toolKey, args), '用户拒绝', 'denied');
    return { ok: false, error: '用户拒绝执行', denied: true };
  }
  return null;
}

// L3 可规则豁免通道
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
  return { allowed: true, asked: !!verdict.need };
}

function summarize(toolKey, args = {}) {
  if (toolKey === 'chrome_navigate') return `${String(args.url || '')} @tab ${args.tab_id ?? '(当前)'}`;
  if (toolKey === 'chrome_click') return `click ${args.selector || ''} @tab ${args.tab_id ?? '(当前)'}`;
  if (toolKey === 'chrome_fill') return `fill ${args.selector || ''} = ${String(args.value || '').slice(0, 40)}`;
  if (toolKey === 'chrome_screenshot') return `screenshot @tab ${args.tab_id ?? '(当前)'}`;
  if (toolKey === 'chrome_extract') return `extract ${args.selector || '(整页)'}`;
  if (toolKey === 'chrome_tabs') return 'listTabs';
  return toolKey;
}

// 中继错误统一转结构化失败：未连接不标 degraded（是「尚未建立接管」的正常前置状态）
function relayFail(toolKey, args, err) {
  const notConnected = !!(err && err.chromeNotConnected);
  audit(toolKey, summarize(toolKey, args), `error: ${err.message}`, notConnected ? 'not_connected' : 'failed');
  return { ok: false, error: err.message, ...(notConnected ? { notConnected: true } : {}) };
}

// 统一执行包装：审批 → 中继调用 → 审计
async function runChromeTool(toolKey, args, { perCall, method, methodArgs } = {}) {
  if (!deps) return { ok: false, error: 'Chrome 接管工具未初始化' };
  // conversationId 仅标识会话归属，按设计从审批/中继入参中剥离，工具调用不消费
  const { conversationId: _conversationId = '', ...rest } = args || {};
  if (perCall) {
    const denied = await requirePerCallApproval(toolKey, rest);
    if (denied) return denied;
  } else {
    const gate = await gateApproval(toolKey, args || {});
    if (gate.ok === false) return gate;
  }
  let result;
  try {
    result = await deps.relay.call(method, methodArgs || rest);
  } catch (err) {
    return relayFail(toolKey, rest, err);
  }
  audit(toolKey, summarize(toolKey, rest), 'ok', perCall ? 'approved' : 'recorded');
  return { ok: true, ...result };
}

// ── 七个工具实现（agent-core toolHandlers 直挂）──

// 连接状态：只读本地中继状态，不触页面、不弹卡
async function toolChromeStatus() {
  if (!deps) return { ok: false, error: 'Chrome 接管工具未初始化' };
  const s = deps.relay.status();
  return {
    ok: true,
    connected: !!s.connected,
    relayListening: !!s.listening,
    relayPort: s.port || null,
    relayError: s.error || null,
    connectedSince: s.since || null,
    browser: s.browser || null,
  };
}

async function toolChromeTabs(args = {}) {
  return runChromeTool('chrome_tabs', args, { perCall: false, method: 'listTabs' });
}

async function toolChromeNavigate(args = {}) {
  // C6：chrome_navigate 必须过私网守卫——否则可让真实 Chrome 打开 http://127.0.0.1:<port>
  // 再用 chrome_extract 读回内存态（browser_navigate 已有守卫，此路径此前缺失）。
  try {
    const u = new URL(String(args.url || ''));
    if (isPrivateHost(u.hostname)) return { ok: false, error: `拒绝访问内网/本机地址：${u.hostname}` };
  } catch { return { ok: false, error: `URL 非法：${String(args.url || '')}` }; }
  return runChromeTool('chrome_navigate', args, {
    perCall: false, method: 'navigate',
    methodArgs: { url: args.url, tabId: args.tab_id, waitUntil: args.wait_until || 'complete' },
  });
}

async function toolChromeClick(args = {}) {
  return runChromeTool('chrome_click', args, {
    perCall: true, method: 'click',
    methodArgs: { selector: args.selector, tabId: args.tab_id },
  });
}

async function toolChromeFill(args = {}) {
  return runChromeTool('chrome_fill', args, {
    perCall: true, method: 'fill',
    methodArgs: { selector: args.selector, value: args.value, tabId: args.tab_id },
  });
}

async function toolChromeScreenshot(args = {}) {
  if (!deps) return { ok: false, error: 'Chrome 接管工具未初始化' };
  // conversationId 仅标识会话归属，按设计从审批/中继入参中剥离，工具调用不消费
  const { conversationId: _conversationId = '', ...rest } = args || {};
  // 截图先过审批（可规则豁免），批准后才触页——审批覆盖 100%
  const gate = await gateApproval('chrome_screenshot', args);
  if (gate.ok === false) return gate;
  let result;
  try {
    result = await deps.relay.call('screenshot', { tabId: args.tab_id });
  } catch (err) {
    return relayFail('chrome_screenshot', rest, err);
  }
  // 证据落盘 + 预览句柄（T3-1 同机制）：base64 不过 IPC 消息体
  const shotDir = path.join(deps.userDataDir, 'chrome-shots');
  try { fs.mkdirSync(shotDir, { recursive: true }); } catch (e) { console.warn('[chrome] 截图目录创建失败:', e?.message || e); }
  const outPath = path.join(shotDir, `chrome-shot-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`);
  let previewUrl = '';
  let bytes = 0;
  try {
    const buf = Buffer.from(String(result.dataBase64 || ''), 'base64');
    fs.writeFileSync(outPath, buf);
    bytes = buf.length;
    const { grantPreviewToken } = require('./previewScheme');
    previewUrl = grantPreviewToken(outPath);
  } catch (e) {
    console.warn('[chromeTools] 截图落盘/句柄发放失败:', e.message);
  }
  audit('chrome_screenshot', `${outPath} (${bytes}B)`, 'ok', gate.asked ? 'approved' : 'recorded');
  return { ok: true, url: result.url || '', title: result.title || '', path: outPath, bytes, previewUrl };
}

async function toolChromeExtract(args = {}) {
  return runChromeTool('chrome_extract', args, {
    perCall: false, method: 'extract',
    methodArgs: { selector: args.selector, limit: args.limit, tabId: args.tab_id },
  });
}

module.exports = {
  initChromeTools,
  toolChromeStatus, toolChromeTabs, toolChromeNavigate, toolChromeClick,
  toolChromeFill, toolChromeScreenshot, toolChromeExtract,
};
