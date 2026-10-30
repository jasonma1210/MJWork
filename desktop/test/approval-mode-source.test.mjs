// P1-1 回归门禁：无人值守路径的审批档必须来自「用户设置」，不是「最后一次交互 run」。
//
// 事故形态（2026-10-17 审查确认）：
//   `agentRunner.getCurrentApprovalMode()` 返回模块级「最后一次 startAgentRun 写入的档」。
//   而审批档可**按会话覆盖**（useAgentRun.ts:527 = thread.approval_mode || 设置）。
//   于是：会话 A 设「每条都问」，在会话 B（「从不问」）发过消息后再回 A 发起编排，
//   组快照会记成「从不问」——比用户设置更松，且无任何提示。
//
// 两个层次都测：
//   ① 行为：approvalSettings.getUserApprovalMode() 的取值与回落；
//   ② 源码：无人值守消费点不得再出现 getCurrentApprovalMode（防止改回去）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { initApprovalSettings, getUserApprovalMode, getUserSandboxPolicy, clampWithSettings } =
  require(path.join(ROOT, 'main/approvalSettings.js'));
const { stricterApproval } = require(path.join(ROOT, 'main/approvalPolicy.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.error(`[FAIL] ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}
const eq = (a, b, msg = '') => {
  if (a !== b) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

function withStore(pref, fn) {
  initApprovalSettings({ getLocalStore: () => ({ getPreference: () => pref }) });
  try { fn(); } finally { initApprovalSettings({ getLocalStore: () => null }); }
}

// ── ① 行为 ──
check('没有 localStore（启动早期）→ 回落 on-request', () => {
  initApprovalSettings({ getLocalStore: () => null });
  eq(getUserApprovalMode(), 'on-request');
});

check('设置里没有 approval_settings → 回落 on-request', () => {
  withStore(undefined, () => eq(getUserApprovalMode(), 'on-request'));
});

check('用户选 always → 读到 always（这才是「用户设置」）', () => {
  withStore({ approval_mode: 'always', sandbox_policy: 'read-only' }, () => eq(getUserApprovalMode(), 'always'));
});

check('用户选 never → 读到 never', () => {
  withStore({ approval_mode: 'never' }, () => eq(getUserApprovalMode(), 'never'));
});

check('非法档位（历史值 auto / always-ask）→ 回落 on-request，不透传', () => {
  withStore({ approval_mode: 'auto' }, () => eq(getUserApprovalMode(), 'on-request'));
});

check('沙箱档同样可从设置读取，非法值回落 workspace-write', () => {
  withStore({ sandbox_policy: 'full-access' }, () => eq(getUserSandboxPolicy(), 'full-access'));
  withStore({ sandbox_policy: 'bogus' }, () => eq(getUserSandboxPolicy(), 'workspace-write'));
});

check('读设置抛错 → 回落默认值且不崩（失败不得放宽权限）', () => {
  initApprovalSettings({ getLocalStore: () => ({ getPreference: () => { throw new Error('store 未就绪'); } }) });
  eq(getUserApprovalMode(), 'on-request');
  initApprovalSettings({ getLocalStore: () => null });
});

check('入参钳制：模型传更松的 never，用户选 always → 取更严者 always', () => {
  withStore({ approval_mode: 'always' }, () => eq(clampWithSettings('never', stricterApproval), 'always'));
});

check('入参钳制：模型传更严的 always，用户选 never → 仍取更严者 always', () => {
  withStore({ approval_mode: 'never' }, () => eq(clampWithSettings('always', stricterApproval), 'always'));
});

// ── ② 源码级防回归 ──
function readMain(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function codeLines(src) {
  // 去掉整行注释，避免把说明文字算成调用点
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

check('main.js 不再用 getCurrentApprovalMode() 取无人值守档位', () => {
  const hits = codeLines(readMain('main/main.js')).filter((l) => l.includes('agentRunner.getCurrentApprovalMode'));
  if (hits.length) throw new Error(`仍有 ${hits.length} 处：${hits[0].trim().slice(0, 80)}`);
});

check('main.js 的无人值守消费点已切到 approvalSettings.getUserApprovalMode()（≥4 处）', () => {
  const n = codeLines(readMain('main/main.js')).filter((l) => l.includes('approvalSettings.getUserApprovalMode()')).length;
  if (n < 4) throw new Error(`只有 ${n} 处，预期至少 4 处`);
});

check('编排组快照按 runId 取档，取不到才回落设置', () => {
  const src = readMain('main/main.js');
  if (!src.includes('agentRunner.getApprovalModeFor(orchestratorRunId)')) {
    throw new Error('hostPolicySnapshot 未按发起 run 取档');
  }
});

check('agentRunner 按 runId 登记并在 run 结束时清理（不泄漏）', () => {
  const src = readMain('main/agentRunner.js');
  if (!src.includes('runApprovalModes.set(runId, runApprovalMode)')) throw new Error('缺少登记');
  if (!src.includes('runApprovalModes.delete(runId)')) throw new Error('缺少清理');
});

check('gitHunks 的档位判断不再依赖「最后一次 run」', () => {
  const src = readMain('main/ipc/gitHunks.js');
  if (codeLines(src).some((l) => l.includes('getCurrentApprovalMode'))) {
    throw new Error('gitHunks 仍读 getCurrentApprovalMode');
  }
});

check('渲染层把设置同步给主进程（否则无人值守永远拿不到用户设置）', () => {
  // F-004：同步逻辑随偏好持久化外置到 hooks/useUiPreferences.ts。判据跟到新家，
  // 并按「接线必须数点位数」补齐：只查 hook 内部，删掉 App.jsx 的 useUiPreferences() 调用也照样绿。
  const src = readMain('renderer/src/hooks/useUiPreferences.ts');
  if (!src.includes("key: 'approval_settings'")) throw new Error('useUiPreferences 未同步 approval_settings 到主进程');
  const app = readMain('renderer/src/App.jsx');
  if (!/} = useUiPreferences\(\)/.test(app)) throw new Error('App 未接线 useUiPreferences（同步成了孤儿代码）');
});

console.log(`\n结果：${pass}/${total} 通过`);
