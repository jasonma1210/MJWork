// 设备域 IPC（2026-10-31）——设备面板的两条**只读**数据源。
//
// 为什么需要这一层：device_probe / device_flash 的能力此前**只在工具层**
// （模型能调、人只能看对话里的 JSON）。要让「人」也能看，就必须有渲染层通道；
// 而渲染层的唯一正路是 preload 桥 → 主进程 ipcMain，不能自己在渲染层跑系统命令
// （ui-conventions 的 rawIpc 判据把 `require('electron')`/`ipcRenderer` 直接判死）。
//
// ── 硬约束：本域**只读**，且面板不能成为第二条写入路径 ──
// 这里只开放两条「列现状」的通道：
//   · `device:probe`   → deviceProbeTool 的 probeDevice()（USB 枚举 / 串口 / 桥接 / 通道 / 驱动）
//   · `device:targets` → deviceFlashTool 的 action=list_targets（可烧串口 / UF2 卷 / 物理盘）
// 刻意**不**开放 chip_id / plan / flash / verify / backup / logs：
// 那些动作要么会写设备、要么会独占串口并复位板子。它们必须经 device_flash 走
// `plan → plan_digest → 审批卡 → flash` 这条链——digest 锁住「人确认过的参数」等于
// 「实际执行的参数」，审批卡让用户在动手前看到目标（approvalTarget 只渲染 tool + target，
// 所以那一步的参数必须先在对话里以 plan 结果落地）。
// 在面板上加一个「烧写」按钮 = 从 UI 直接跨过 digest 与审批卡，那正是本设计要防的事。
//
// 复用而不重写：两条通道都直接调用既有工具实现（同一个探测内核、同一份磁盘/卷判定），
// 不另写一套命令。理由与 deviceChannels 同款——同一件事两份实现必然漂移，
// 而漂移的表现是「面板说能烧、工具说不能烧」，用户只能靠猜信哪个。
'use strict';

const { ipcMain } = require('electron');
const { probeDevice } = require('../tools/deviceProbeTool');
const { deviceFlashHandler } = require('../tools/deviceFlashTool');

// 真实实现作为默认值。测试（test/domain-ipc-wiring.test.mjs）注入假实现，
// 避免在门禁里真跑 system_profiler / diskutil（机器相关且慢，断言只能写成形状）。
const DEFAULT_DEPS = {
  probe: () => probeDevice(),
  listTargets: () => deviceFlashHandler({ action: 'list_targets' }),
};

let deps = DEFAULT_DEPS;

// 失败一律转成 { ok:false, error }：面板要能显示「探测失败的原因」，
// 而不是白屏或一行永远转圈的加载中。异常向上抛会让渲染层只拿到一个被 Electron
// 包装过的字符串（错误名与堆栈都丢），排查成本远高于在这里截断。
async function runSafely(fn, what) {
  try {
    const res = await fn();
    return res && typeof res === 'object' ? res : { ok: false, error: `${what}返回了非对象结果` };
  } catch (e) {
    return { ok: false, error: `${what}失败：${String(e && e.message ? e.message : e).slice(0, 300)}` };
  }
}

function register() {
  // 入参一律忽略：两条通道都不接受任何筛选条件。若将来要加（比如「只看某个 VID」），
  // 必须在这里做白名单取值——把 payload 原样转进工具层等于给渲染层开了一个参数注入面。
  ipcMain.handle('device:probe', () => runSafely(deps.probe, '设备探测'));
  ipcMain.handle('device:targets', () => runSafely(deps.listTargets, '可烧目标枚举'));
}

function initDeviceIpc(d) {
  // 只接受函数形态的覆盖，其余字段丢弃（防止把「配置对象」误当实现传进来看起来像成功）
  deps = {
    probe: typeof d?.probe === 'function' ? d.probe : DEFAULT_DEPS.probe,
    listTargets: typeof d?.listTargets === 'function' ? d.listTargets : DEFAULT_DEPS.listTargets,
  };
  register();
}

module.exports = { initDeviceIpc };
