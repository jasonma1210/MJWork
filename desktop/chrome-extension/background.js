// T4-2：MJ Code Chrome 接管扩展（MV3 service worker）。
// 职责：与本机 MJ Code 桌面端的 WebSocket 中继保持连接；收到 call 后用 chrome.debugger（CDP）
// 操作用户真实标签页并回传结果。授权纪律在桌面端侧（每次连接逐次弹审批卡），
// 本扩展不存储任何凭证；断开即无残留。
// 安装：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择本目录。
// 中继地址默认 ws://127.0.0.1:49813；如需改端口，在扩展 Service Worker 控制台执行：
//   chrome.storage.local.set({ relayUrl: 'ws://127.0.0.1:<端口>' })
const DEFAULT_RELAY = 'ws://127.0.0.1:49813';
const EXTENSION_ID = 'mjcode-chrome-takeover';

let ws = null;
let reconnectDelay = 2000;
let helloNonce = '';

function relayUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['relayUrl'], (r) => resolve(String(r.relayUrl || DEFAULT_RELAY)));
  });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const url = await relayUrl();
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  ws.onopen = () => { reconnectDelay = 2000; };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      helloNonce = String(msg.nonce || '');
      ws.send(JSON.stringify({
        t: 'identify',
        extension: EXTENSION_ID,
        version: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        nonce: helloNonce,
      }));
      return;
    }
    if (msg.t === 'call') {
      let res;
      try {
        const result = await handleCall(msg.method, msg.args || {});
        res = { t: 'callRes', callId: msg.callId, ok: true, result };
      } catch (err) {
        res = { t: 'callRes', callId: msg.callId, ok: false, error: String(err && err.message || err) };
      }
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
    }
  };
  ws.onclose = scheduleReconnect;
  ws.onerror = () => { try { ws.close(); } catch { /* 已关闭 */ } };
}

function scheduleReconnect() {
  ws = null;
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000); // 指数退避封顶 30s：桌面端未启动时不狂重连
}

// MV3 service worker 可能被回收：alarm 周期性确保连接存活（回收后由本回调重新拉起）
chrome.alarms.create('mjcode-relay-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'mjcode-relay-keepalive') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ── 目标标签页解析与守卫 ──
async function resolveTab(tabId) {
  let tab;
  if (tabId != null) {
    tab = await chrome.tabs.get(Number(tabId));
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  }
  if (!tab) throw new Error('未找到目标标签页（tab 可能已关闭）');
  // 只接管 http/https 页面：chrome:// 设置页/扩展页是浏览器特权面，绝不开放
  if (!/^https?:/i.test(String(tab.url || ''))) {
    throw new Error(`仅允许接管 http/https 标签页（当前：${String(tab.url || '空白页').slice(0, 60)}）`);
  }
  return tab;
}

// CDP 会话包装：attach → fn → detach（Chrome 地址栏会显示调试横幅，操作对用户全程可见）
async function withCdp(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    return await fn({
      send: (method, params) => chrome.debugger.sendCommand(target, method, params || {}),
    });
  } finally {
    try { await chrome.debugger.detach(target); } catch { /* 已分离 */ }
  }
}

// Runtime.evaluate 取返回值（returnByValue：只回传 JSON 可序列化结果）
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`页面脚本执行失败：${r.exceptionDetails.text || '未知异常'}`);
  return r.result && r.result.value;
}

async function tabMeta(tabId) {
  const t = await chrome.tabs.get(tabId);
  return { url: t.url || '', title: t.title || '' };
}

// ── 各 method 实现（与桌面端 RELAY_METHODS 一一对应）──
async function handleCall(method, args) {
  switch (method) {
    case 'listTabs': {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs
          .filter((t) => /^https?:/i.test(String(t.url || '')))
          .map((t) => ({ id: t.id, title: t.title || '', url: t.url, active: !!t.active, windowId: t.windowId })),
      };
    }
    case 'navigate': {
      const raw = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(raw)) throw new Error('仅允许打开 http/https 地址');
      const tab = await resolveTab(args.tabId);
      await chrome.tabs.update(tab.id, { url: raw });
      await waitForComplete(tab.id, 30000);
      return await tabMeta(tab.id);
    }
    case 'click': {
      if (!args.selector) throw new Error('selector 不能为空');
      const tab = await resolveTab(args.tabId);
      await withCdp(tab.id, async (cdp) => {
        const sel = JSON.stringify(String(args.selector));
        const box = await evaluate(cdp, `(() => {
          const el = document.querySelector(${sel});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        if (!box) throw new Error(`未找到可点击元素：${args.selector}`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      });
      await sleep(500); // 点击可能触发导航：等页面稳定再回显
      return await tabMeta(tab.id);
    }
    case 'fill': {
      if (!args.selector) throw new Error('selector 不能为空');
      const tab = await resolveTab(args.tabId);
      const value = String(args.value ?? '');
      await withCdp(tab.id, async (cdp) => {
        const sel = JSON.stringify(String(args.selector));
        const val = JSON.stringify(value);
        // 用原生 setter + input/change 事件：兼容 React 等受控组件（直接赋 .value 不触发状态更新）
        const ok = await evaluate(cdp, `(() => {
          const el = document.querySelector(${sel});
          if (!el) return false;
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, ${val}); else el.value = ${val};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        if (!ok) throw new Error(`未找到输入元素：${args.selector}`);
      });
      return { ok: true, selector: String(args.selector), length: value.length };
    }
    case 'screenshot': {
      const tab = await resolveTab(args.tabId);
      const dataBase64 = await withCdp(tab.id, async (cdp) => {
        await cdp.send('Page.enable');
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        return shot.data;
      });
      const meta = await tabMeta(tab.id);
      return { dataBase64, ...meta };
    }
    case 'extract': {
      const tab = await resolveTab(args.tabId);
      const limit = Math.min(Math.max(Number(args.limit) || 15000, 1), 40000);
      const text = await withCdp(tab.id, async (cdp) => {
        if (args.selector) {
          const sel = JSON.stringify(String(args.selector));
          return await evaluate(cdp, `(() => {
            const el = document.querySelector(${sel});
            return el ? el.innerText : null;
          })()`);
        }
        return await evaluate(cdp, `(() => {
          const clone = document.body ? document.body.cloneNode(true) : null;
          if (!clone) return '';
          clone.querySelectorAll('nav,header').forEach((n) => n.remove());
          const tmp = document.createElement('div');
          tmp.appendChild(clone);
          return (tmp.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
        })()`);
      });
      if (text === null) throw new Error(`未找到元素：${args.selector}`);
      const body = String(text || '');
      const meta = await tabMeta(tab.id);
      return { ...meta, text: body.slice(0, limit), truncated: body.length > limit, totalChars: body.length };
    }
    default:
      throw new Error(`未知 method：${method}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 等待标签页加载完成（status=complete）或超时
function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // 超时不失败：慢站也允许后续操作（模型可用 extract 确认现状）
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
