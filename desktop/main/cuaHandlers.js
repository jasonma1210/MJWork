// CUA（计算机使用）：IPC 通道 + 工具实现 —— 2026-10-30 从 main.js L1839-2262 整段抽出。
//
// 为什么抽：main.js code 行数 1500，正好压在 eslint max-lines 的 1500 硬档上（余量 0），
//   任何功能新增都必须先腾行数。这一段自带 `COMPUTER USE (M4-C) … END COMPUTER USE` 边界标记，
//   对外只暴露两个出口，是 main.js 里内聚度最高的可抽单元。
//
// 形态：工厂 + 依赖注入（与 memory/recall.js 的 createRecallMethods 同款纪律——不 require
//   main.js，避免循环依赖）。8 个外部符号全部来自 main.js 的模块级作用域。
//
// ⚠ getMainWindow 必须传 getter，不能传 mainWindow 的值：后者是 main.js 的模块级 let，
//   窗口关闭重建后会换对象，传值会拿到旧窗口快照，send 静默失效。本文件内所有窗口访问
//   一律经 getMainWindow() 现取。
const path = require('path');
const { ipcMain, app, BrowserWindow, shell } = require('electron');

module.exports = function createCuaHandlers(deps = {}) {
  const {
    getMainWindow, guard, agentRunner, approvalSettings, audit, requestApproval, resolveSecret, ApprovalChannel,
  } = deps;
  if (typeof getMainWindow !== 'function') {
    throw new Error('createCuaHandlers: getMainWindow 必须是函数（传 mainWindow 的值会在窗口重建后失效）');
  }

  // 统一投递出口：窗口可能已销毁或已重建，每次现取。返回是否投递成功。
  function sendToWindow(channel, payload) {
    const win = getMainWindow();
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    win.webContents.send(channel, payload);
    return true;
  }

// ═══════════════════════════════════════════
//  COMPUTER USE (M4-C)：macOS AX 结构化界面自动化
//  事件契约与实现细节见 computerUse.js 头部注释
// ═══════════════════════════════════════════
const cua = require('./computerUse');
// T3-6：高风险原生执行下沉独立子进程——osascript 键鼠执行/AX 采集不再跑在主进程里，
// 崩溃或挂起只影响单步：宿主透明重启重试，超限抛能力降级错误经 cua:event 提示（主会话不崩）。
// utilityProcess 不可用（单测 stub 环境）时 isAvailable()=false，回退主进程直调（T3-7 同纪律）。
const cuaProcess = require('./cuaProcess/host');
cuaProcess.initCuaProcess({});
// T4-6：操作录制与回放——LLM 跑通的任务录成确定性 AX 脚本，回放不调模型
const cuaRecorder = require('./cuaRecorder');
const cuaRecordingsDir = () => path.join(app.getPath('userData'), 'recordings');
// CUA / 回放的互斥占用表：占用与释放在模块内同步完成（跨 await 的读改写会把并发请求放进来）
const cuaLoopRegistry = require('./cuaLoopRegistry');

// CUA 逐次确认弹窗：独立通道，避免与并行工具审批（tool:approval-response）互相串扰
// 决策不进入 applyApprovalDecision 规则库 —— 敏感动作必须逐次确认，不可会话/永久放行
//
// P0 修复（2026-10-16）：原实现是 `ipcMain.once('cua:approval-response')`——
// 即 main.js:54 注释所述 P0-2 缺陷在 CUA 通道的重演（tool: 通道早已用
// ApprovalChannel 按 approvalId 精确分发修掉，此处漏改）。后果：
//   ① 每次请求都注册一个新的一次性监听器，并发两个 CUA 确认时，
//      先到的响应被「先注册的那个」消费 ⇒ 决策张冠李戴。CUA 要求逐次确认，
//      张冠李戴的后果比工具审批更严重（把「允许」发给另一条敏感动作）；
//   ② 超时分支只 resolve 不摘监听器 ⇒ 监听器残留，可能吃掉后续无关响应。
// 现与 tool: 通道同款：生成 approvalId → 按 id 精确分发；无 id 的旧响应走
// dispatchLegacy（仅在恰有一个挂起时按唯一挂起处理，多于一个则拒绝猜测、按超时 deny）。
const cuaApprovalChannel = new ApprovalChannel({ timeoutMs: 120000 });
ipcMain.on('cua:approval-response', (_, payload) => {
  const hasId = payload && typeof payload === 'object' && payload.approvalId;
  const dispatched = hasId
    ? cuaApprovalChannel.dispatch(payload.approvalId, payload.decision, payload.reason)
    : cuaApprovalChannel.dispatchLegacy(null, payload && payload.decision !== undefined ? payload.decision : payload); // P2-3：无 id 一律拒绝并告警
  if (!dispatched) {
    console.warn('[cua] 收到无法匹配的审批响应，已忽略（fail-closed，按 deny 收尾）');
  }
});

function requestCuaApproval(summary) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return Promise.resolve('deny');
  const approvalId = cuaApprovalChannel.nextId();
  // 无论以何种方式收尾（含超时）都通知渲染层撤下卡片——否则卡片常驻，
  // 用户再点时主进程已无挂起项，表现为「点了没反应」
  const settled = cuaApprovalChannel.wait(approvalId, () => {
    try { win?.webContents?.send('cua:approval-settled', { approvalId }); }
    catch { /* 窗口已销毁 */ }
  });
  win.webContents.send('cua:approval-request', { ...summary, approvalId });
  return settled;
}

// CUA 循环用非流式 chat（复用 model:chat 同款凭证解析结果）
async function cuaChat(root, apiKey, model, messages) {
  const res = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

// ═══════════════════════════════════════════
//  G-CUA：模型可调用的 computer_use 工具
//  把既有的 CUA 循环接到「模型的工具调用面」上——此前 CUA 只能由设置页的录制/回放面板触发，
//  模型（Agent 对话）无法直接调用（差距审查：有实现、有设置页入口，缺模型可调用入口）。
//
//  与 cua:run 的三点关键差异：
//   ① 本函数是**阻塞式**的（await loop.run() 后把结果回填给模型），不是 fire-and-forget；
//   ② 顶层授权 + 逐次动作确认都走**标准审批中心**（tool:approval-request → 全局 ApprovalCard），
//      因为模型发起的调用发生在对话里，用户在对话界面必须能看到卡片；
//      cua:approval-request 的 UI 只在设置页录制面板里，对话中不可见 → 走自有通道会「卡死无卡」；
//   ③ 门控：仅 macOS + 用户已在设置中开启「界面自动化」时，引擎才会把该工具放进 tools 数组
//      （见 agent-core 的 computerUseEnabled + V02 白名单守卫）；此处再做平台/权限/凭证兜底。
async function toolComputerUse(args = {}, ctx = {}) {
  const objective = String(args.objective || '').trim();
  const appName = String(args.app_name || args.appName || '').trim();
  if (!objective || !appName) return { ok: false, error: 'objective 与 app_name 必填' };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  // 同一时刻只允许一个 CUA 循环（与 cua:run / cua:replay 共用同一把锁）——模型与设置页不并发操作桌面
  if (cuaLoopRegistry.hasRunning()) return { ok: false, error: cuaLoopRegistry.BUSY };
  // 顶层授权：L1 逐次确认（任何审批档都弹卡），决策不落规则库（NON_REMEMBERABLE）。
  // 由本 handler 自行把关——引擎的 APPROVAL_TOOLS 仅注入治理字段，不代为弹卡。
  // fail-closed：仅 'once'（允许一次）放行；'deny'/超时/其他一律视为拒绝。
  const topDecision = await requestApproval('computer_use', {
    objective,
    app_name: appName,
    max_steps: args.max_steps,
    allowed_apps: args.allowed_apps,
  });
  if (topDecision !== 'once') return { ok: false, error: '用户未批准界面自动化调用（已按 fail-closed 拒绝）' };
  // 原生执行会话（每 run 一个子进程，惰性 spawn，finally dispose）——与 cua:run 同纪律
  const cuaSession = cuaProcess.isAvailable() ? cuaProcess.createSession() : null;
  const cuaExec = (name, ...a) => (cuaSession ? cuaSession.call(name, ...a) : cua[name](...a));
  const dispose = () => { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } };
  if (!(await cuaExec('isAccessibilityGranted'))) {
    dispose();
    return { ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' };
  }
  // 凭证解析：与 model:chat 同款（本地优先）。ctx.model 为引擎侧嵌套形（provider/model 分离）
  const m = ctx.model || {};
  const providerId = m.provider?.id;
  const isGlobal = !!m.provider?.isGlobal;
  const modelId = m.model?.model_id || m.model || '';
  const secret = resolveSecret(providerId, isGlobal);
  if (!secret || !secret.api_key) { dispose(); return { ok: false, error: 'KEY_MISSING: 模型凭证未加载，请在本机模型设置中重新填写 API Key' }; }
  const root = (m.provider?.base_url || secret.base_url || '').replace(/\/+$/, '');
  if (!root) { dispose(); return { ok: false, error: 'BASE_URL_MISSING: 模型服务地址为空' }; }
  if (!modelId) { dispose(); return { ok: false, error: 'MODEL_MISSING: 当前会话未指定模型' }; }

  const maxSteps = Math.min(15, Math.max(1, Number(args.max_steps) || 15));
  const allowedApps = Array.isArray(args.allowed_apps) && args.allowed_apps.length
    ? args.allowed_apps.map((x) => String(x))
    : [appName];
  const loop = new cua.ComputerUseLoop({
    objective,
    appName,
    maxSteps,
    model: modelId,
    // 审批档入参钳制：取「本 run 档 与 用户设置档」中更严者（与本项目 no-unattended-weaker 纪律一致）
    approvalMode: agentRunner.stricterApproval(ctx.approvalMode || 'on-request', approvalSettings.getUserApprovalMode()),
    allowedApps,
    toolHandlers: {
      // chat 留主进程（凭证不出界）；原生执行面全部经子进程会话（T3-6）
      chat: (messages) => cuaChat(root, secret.api_key, modelId, messages),
      collectAx: (name) => cuaExec('collectAxTree', name || appName),
      perform: (action, node) => cuaExec('performAction', action, node, { appName: appName || node?.name || '' }),
      isLocked: () => cuaExec('isScreenLocked'),
      captureScreen: () => cuaExec('captureScreen'), // M6 视觉兜底（AX 覆盖不足时）
    },
    approval: {
      // 逐次动作确认 → **标准审批中心**（tool:approval-request → 全局 ApprovalCard 在对话中可见）。
      // 决策不调 applyApprovalDecision ⇒ 敏感动作逐次确认、不落「始终允许」规则（与设计一致）。
      requestApproval: (summary, action, node) => requestApproval('cua_action', {
        action: action?.action || '',
        text: action?.text,
        key: action?.key,
        label: action?.label,
        target: node?.name || node?.value || action?.target || '',
      }),
      // 全部动作脱敏审计上报（审批结果随行）
      audit: (step, actionText, result) => audit('cua', appName, `step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    hud: cua.createHudWindow(BrowserWindow),
    onEvent: (evt) => {
      sendToWindow('cua:event', evt);
    },
  });
  // 占用必须在这里拿而不是靠上面的守卫：守卫与本行之间隔着建 HUD / 建会话等 await，
  // 并发请求会双双穿过守卫。占用失败要把本函数已创建的资源收干净再返回。
  const releaseCua = cuaLoopRegistry.claimCua(loop);
  if (!releaseCua) { cua.destroyHud(); dispose(); return { ok: false, error: cuaLoopRegistry.BUSY }; }
  // 运行中止（用户点停止/切会话）→ 立即中断循环（与 cua:run 的 cua:stop 同源）
  if (ctx.signal) ctx.signal.addEventListener('abort', () => loop.stop(), { once: true });

  let res;
  try {
    res = await loop.run();
  } catch (err) {
    return { ok: false, error: `界面自动化执行失败：${err.message}${err.cuaDegraded ? '（能力降级）' : ''}` };
  } finally {
    releaseCua();
    cua.destroyHud();
    dispose();
  }
  if (res && res.completed) {
    return { ok: true, completed: true, steps: res.step, summary: `界面自动化已完成目标「${objective}」（应用：${appName}，共 ${res.step} 步）` };
  }
  if (res && res.maxStepsReached) {
    return { ok: false, completed: false, maxStepsReached: true, error: `已达最大步数上限（${res.step} 步），目标未确认完成` };
  }
  return { ok: false, stopped: true, error: '界面自动化任务被用户停止/拒绝，未完成' };
}

ipcMain.handle('cua:status', async () => {
  // 能力矩阵：截图/屏幕尺寸已跨平台（win32 PowerShell / linux scrot 链），
  // AX 树与键鼠执行仍 macOS 独有。UI 据此只隐藏不可用的部分，不再笼统报「仅 macOS」。
  const support = cua.cuaSupport();
  if (!support.automation) {
    return {
      available: false,
      granted: false,
      ...support,
      message: support.message,
    };
  }
  const granted = await cua.isAccessibilityGranted();
  return {
    available: true,
    granted,
    ...support,
    message: granted
      ? ''
      : '未授予辅助功能权限：请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用后重试',
  };
});

// 授权引导（2026-10-19）：按操作系统分派「去哪里授权 / 为什么当前不可用」。
// 只有 macOS 存在真正的系统授权项（辅助功能 Accessibility），用官方深链直达该面板；
// Windows 的键鼠执行需等 UIA 实现、Linux 依赖截图工具链，均无系统授权项 → 返回结构化 code，
// 由渲染层按平台展示分步指引（i18n 文案留在渲染层，IPC 只回结构化结果，不传文案载荷）。
// 深链协议不走 shell:openExternal（exec.js 只放行 http/https），此处用主进程 shell 直连。
const CUA_MAC_ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
ipcMain.handle('cua:permission-help', async (_, payload = {}) => {
  const platform = process.platform;
  if (platform !== 'darwin') {
    return {
      ok: true,
      platform,
      code: platform === 'win32' ? 'win_uia_pending' : 'linux_deps',
      canOpen: false,
      opened: false,
    };
  }
  if (payload?.open !== true) {
    return { ok: true, platform, code: 'mac_accessibility', canOpen: true, opened: false };
  }
  try {
    // 固定常量深链，不接受渲染层传入地址（防协议注入）
    await shell.openExternal(CUA_MAC_ACCESSIBILITY_URL);
    return { ok: true, platform, code: 'mac_accessibility', canOpen: true, opened: true };
  } catch (e) {
    return { ok: false, platform, code: 'mac_accessibility', canOpen: true, opened: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('cua:run', async (_, { objective, appName, approvalMode = 'on-request', conversationId, model, providerId, isGlobal = false, baseUrl, allowedApps, maxSteps, record = false, recordingName = '' }) => {
  if (cuaLoopRegistry.hasRunning()) return { ok: false, error: cuaLoopRegistry.BUSY };
  if (!objective || !appName) return { ok: false, error: 'objective 与 appName 必填' };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  // X14：objective/appName 会进模型上下文并被审计落盘，allowedApps 是执行白名单——
  // 形状与长度先在边界守住（非字符串 allowedApps 会让 ComputerUseLoop 以为带了白名单）。
  // 注意 providerId 不在此列：本机 provider 是数字 id、服务端是 's...' 前缀串，两种形态都合法。
  try {
    guard.assertStrings({ objective, appName, model, baseUrl, conversationId, recordingName }, {
      objective: 20000,
      appName: 200,
      model: { max: 200, optional: true, allowEmpty: true },
      baseUrl: { max: 2000, optional: true, allowEmpty: true },
      conversationId: { max: 200, optional: true, allowEmpty: true },
      recordingName: { max: 200, optional: true, allowEmpty: true },
    });
    if (allowedApps !== undefined) guard.assertArray({ allowedApps }, 'allowedApps', { max: 50 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // T3-6：原生执行会话（每 run 一个子进程，惰性 spawn，finally dispose）
  const cuaSession = cuaProcess.isAvailable() ? cuaProcess.createSession() : null;
  const cuaExec = (name, ...args) => (cuaSession ? cuaSession.call(name, ...args) : cua[name](...args));
  const bail = async (result) => { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } return result; };
  if (!(await cuaExec('isAccessibilityGranted'))) {
    return bail({ ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' });
  }
  // 凭证解析：与 model:chat 同款（本地优先）
  const secret = resolveSecret(providerId, isGlobal);
  if (!secret || !secret.api_key) return bail({ ok: false, error: 'KEY_MISSING: 模型凭证未加载，请在本机模型设置中重新填写 API Key' });
  const root = (baseUrl || secret.base_url || '').replace(/\/+$/, '');
  if (!root) return bail({ ok: false, error: 'BASE_URL_MISSING: 模型服务地址为空' });

  const send = (evt) => {
    sendToWindow('cua:event', evt);
  };
  // T4-6 录制模式：累积实际执行成功的 AX 步骤（每步截图），run 完成后整体落盘；
  // 视觉兜底步骤（node=null）不可确定性回放，不入录制。
  const rec = record ? {
    id: cuaRecorder.newRecordingId(),
    name: String(recordingName || objective).slice(0, 80),
    steps: [],
  } : null;
  let recChain = Promise.resolve(); // 截图串行链：保证步骤序号与落盘顺序一致
  let recCounter = 0; // 步骤序号独立计数（截图异步，不能依赖 steps.length——链未 flush 时会重复）
  const onEvent = (evt) => {
    if (rec && evt.type === 'step' && evt.mode !== 'vision' && evt.node && evt.result?.ok) {
      const index = ++recCounter;
      const step = cuaRecorder.sanitizeStep(evt, index);
      recChain = recChain.then(async () => {
        try {
          const shot = await cua.captureScreen();
          if (shot && shot.dataUrl) {
            step.screenshotFile = cuaRecorder.writeScreenshot(rec.id, index, shot.dataUrl, { dir: cuaRecordingsDir() });
          }
        } catch (e) { console.warn('[cua] 录制截图失败（不影响步骤）:', e.message); }
        rec.steps.push(step);
      });
    }
    send(evt);
  };
  const hud = cua.createHudWindow(BrowserWindow);
  const loop = new cua.ComputerUseLoop({
    objective,
    appName,
    maxSteps,
    model,
    // P1-2：审批档入参钳制——取「调用方传入 与 用户当前档」中更严者（地板语义），
    // 渲染层被注入脚本传弱档（never）不再生效；敏感动作逐次确认不受档位影响（设计不变）
    approvalMode: agentRunner.stricterApproval(approvalMode || 'on-request', approvalSettings.getUserApprovalMode()),
    allowedApps: allowedApps || [appName],
    toolHandlers: {
      // chat 留主进程（凭证不出界）；原生执行面全部经子进程会话（T3-6）
      chat: (messages) => cuaChat(root, secret.api_key, model, messages),
      collectAx: (name) => cuaExec('collectAxTree', name || appName),
      perform: (action, node) => cuaExec('performAction', action, node, { appName: appName || node?.name || '' }),
      isLocked: () => cuaExec('isScreenLocked'),
    },
    approval: {
      requestApproval: (summary) => requestCuaApproval(summary),
      // 全部动作脱敏审计上报（审批结果随行）
      audit: (step, actionText, result) => audit('cua', appName, `step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    hud,
    onEvent,
  });
  // 同上：占用在等待之后才拿得到，守卫单独用不足以防并发
  const releaseCua = cuaLoopRegistry.claimCua(loop);
  if (!releaseCua) { cua.destroyHud(); try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } return { ok: false, error: cuaLoopRegistry.BUSY }; }
  loop.run()
    // T4-6：任务成功完成且有已执行步骤 → 录制落盘；中途失败/停止 → 清理半成品截图不留脏数据
    .then(async (res) => {
      if (!rec) return;
      await recChain;
      if (res && res.completed && rec.steps.length) {
        const saved = cuaRecorder.saveRecording(
          { version: 1, id: rec.id, name: rec.name, objective, appName, createdAt: Date.now(), steps: rec.steps },
          { dir: cuaRecordingsDir() },
        );
        if (saved.ok) send({ type: 'recorded', recordingId: rec.id, stepCount: rec.steps.length });
        else send({ type: 'error', message: saved.error });
      } else if (rec.steps.length) {
        cuaRecorder.deleteRecording(rec.id, { dir: cuaRecordingsDir() });
      }
    })
    // cuaDegraded：子进程重启超限——消息本身即能力降级提示（degraded 标记供渲染层区分展示）
    .catch((err) => send({ type: 'error', message: err.message, degraded: !!err.cuaDegraded }))
    .finally(() => {
      releaseCua();
      cua.destroyHud();
      try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); }
    });
  return { ok: true };
});

ipcMain.handle('cua:stop', async () => {
  const stopped = cuaLoopRegistry.stopCurrent();
  // 停回放不撤审批卡（保持原语义：回放路径本就不弹 CUA 确认卡）
  if (stopped === 'replay') return { ok: true };
  if (stopped !== 'cua') return { ok: false, error: '没有进行中的界面自动化任务' };
  // P1-24：停止运行时统一撤下挂起的 CUA 确认卡（按 deny 收尾）——
  // 此前卡残留：循环已死、卡还在，用户点「允许」打到已无消费者的通道上
  try { cuaApprovalChannel.disposeAll(); } catch (e) { console.warn('[cua] 撤卡失败:', e.message); }
  return { ok: true };
});

// T4-6：确定性回放——不调模型，按录制步骤逐一「定位节点→（敏感则逐次确认）→执行」；
// 节点定位失败 fail-closed 中止；审批/审计与录制路径共用同一套通道（requestCuaApproval/audit）
ipcMain.handle('cua:replay', async (_, { recordingId, approvalMode = 'on-request' } = {}) => {
  if (cuaLoopRegistry.hasRunning()) return { ok: false, error: cuaLoopRegistry.BUSY };
  if (process.platform !== 'darwin') return { ok: false, error: '界面自动化仅支持 macOS' };
  // X14：recordingId 会拼成录制文件路径（cuaRecorder 内部另有净化），边界先守类型与长度
  try {
    guard.assertStrings({ recordingId }, { recordingId: { max: 200, optional: true, allowEmpty: true } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const loaded = cuaRecorder.loadRecording(String(recordingId || ''), { dir: cuaRecordingsDir() });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const recording = loaded.recording;
  const cuaSession = cuaProcess.isAvailable() ? cuaProcess.createSession() : null;
  const cuaExec = (name, ...args) => (cuaSession ? cuaSession.call(name, ...args) : cua[name](...args));
  const bail = (result) => { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } return result; };
  if (!(await cuaExec('isAccessibilityGranted'))) {
    return bail({ ok: false, error: 'NEED_ACCESSIBILITY: 未授予辅助功能权限，请在 系统设置 > 隐私与安全性 > 辅助功能 中允许本应用' });
  }
  const send = (evt) => {
    sendToWindow('cua:event', { mode: 'replay', ...evt });
  };
  const loop = new cuaRecorder.ReplayLoop({
    recording,
    // P1-2：同 cua:run——审批档入参钳制（更严者生效）
    approvalMode: agentRunner.stricterApproval(approvalMode || 'on-request', approvalSettings.getUserApprovalMode()),
    toolHandlers: {
      collectAx: (name) => cuaExec('collectAxTree', name || recording.appName),
      perform: (action, node) => cuaExec('performAction', action, node, { appName: recording.appName || node?.name || '' }),
    },
    approval: {
      requestApproval: (summary) => requestCuaApproval(summary),
      audit: (step, actionText, result) => audit('cua', recording.appName, `replay step${step}: ${actionText} -> ${result}`, result === 'denied' ? 'denied' : 'approved'),
    },
    onEvent: send,
  });
  const releaseReplay = cuaLoopRegistry.claimReplay(loop);
  if (!releaseReplay) { try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); } return { ok: false, error: cuaLoopRegistry.BUSY }; }
  loop.run()
    .catch((err) => send({ type: 'error', message: err.message, degraded: !!err.cuaDegraded }))
    .finally(() => {
      releaseReplay();
      try { cuaSession?.dispose(); } catch (e) { console.warn('[cua] 会话释放失败:', e.message); }
    });
  return { ok: true };
});

// 录制列表/删除（数据仅存本机 userData/recordings/，不上传）
ipcMain.handle('cua:recordings:list', async () => ({
  ok: true,
  recordings: cuaRecorder.listRecordings({ dir: cuaRecordingsDir() }),
}));
ipcMain.handle('cua:recordings:delete', async (_, { recordingId } = {}) => {
  // X14：删除录制会真的 unlink 用户文件，recordingId 走文件路径拼接——先守形状与长度
  try {
    guard.assertStrings({ recordingId }, { recordingId: { max: 200, optional: true, allowEmpty: true } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const r = cuaRecorder.deleteRecording(String(recordingId || ''), { dir: cuaRecordingsDir() });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
});
// ═══════════════════════════════════════════
//  END COMPUTER USE (M4-C)
// ═══════════════════════════════════════════
  return {
    toolComputerUse,
    disposeCuaApprovals: () => { try { cuaApprovalChannel.disposeAll(); } catch (e) { console.warn('[cuaApproval] 清理异常:', e.message); } },
    // 仅为可测性导出：cua-recorder 第 9 节用它验证「每次现取窗口」的 getter 语义
    // （传值 vs getter 的差别在静态断言里看不出来，坏掉也不报错——只是事件投到旧窗口）。
    // 生产代码只用上面两个出口。
    sendToWindow,
  };
};
