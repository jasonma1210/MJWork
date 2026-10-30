// G-CUA 门禁（2026-10-19）：模型可调用的桌面自动化工具（computer_use）接线完整性。
//
// 背景：CUA 此前只有「设置页录制/回放」入口，模型的工具调用面看不到它（差距审查项）。
// 本次按项目「新增原生工具 8 处接线规范」把 computer_use 补进模型面，采用 opt-in 强门控：
//   ① 引擎 schema：COMPUTER_USE_TOOL 条件追加（复刻 LOAD_SKILL_TOOL 范式，不进 BASE_TOOLS）
//      + APPROVAL_TOOLS + TOOL_HANDLER_NAMES + TOOL_TIMEOUT_OVERRIDES + computerUseEnabled 参数；
//   ② 子进程 RPC 白名单（registry.TOOL_CHANNELS）——漏登记即「未知工具」（G-doc 真机同源坑）；
//   ③ 主进程接线：agentRunner 白名单放行 computerUseEnabled + 透传 model；main.js 的
//      createToolHandlers 注册 computerUse → toolComputerUse（复用 ComputerUseLoop/cuaProcess，
//      顶层与逐次动作都走标准审批中心，逐次动作复用 cua_action）；
//   ④ opt-in 开关：approvalSettings.getComputerUseEnabled（缺省 false）+ 设置页开关；
//   ⑤ 审批分级：approval.js 单一事实来源（L1 逐次、不可记忆、不可补偿、审批卡文案）；
//   ⑥ 渲染层标签 + i18n 双语 key。
//
// 不依赖 Electron：仅做纯模块 import 与源码静态断言（main.js 无法 require，与
// engine-process.test.mjs 的主进程接线断言同款做法）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BASE_TOOLS, TOOL_HANDLER_NAMES } from '../agent-core/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
}

const coreSrc = read('agent-core/index.js');
const approval = require(path.join(ROOT, 'main/approval.js'));
const registry = require(path.join(ROOT, 'main/engineProcess/registry.js'));
const approvalSettings = require(path.join(ROOT, 'main/approvalSettings.js'));

// ── ① 引擎 schema 与通道接线 ──
{
  const byName = Object.fromEntries(BASE_TOOLS.map((t) => [t.function.name, t.function]));
  check('computer_use 不在 BASE_TOOLS（必须 opt-in 条件追加，否则默认暴露给所有用户）',
    !byName.computer_use);
  check('TOOL_HANDLER_NAMES：computer_use → computerUse 通道名',
    TOOL_HANDLER_NAMES.computer_use === 'computerUse', `got=${TOOL_HANDLER_NAMES.computer_use}`);
  check('COMPUTER_USE_TOOL schema：required=[objective, app_name]，且 max_steps 上限文案在列',
    /name: 'computer_use'/.test(coreSrc)
    && /required: \['objective', 'app_name'\]/.test(coreSrc));
  // T6-6：APPROVAL_TOOLS 尾部新增了 artifact_patch_section，原先「'computer_use']) 必须在集合末尾」
  // 的写法随之失效。改为在**集合字面量内部**检索，仍能守住「computer_use 在审批面里」这条事实。
  check('APPROVAL_TOOLS 含 computer_use（治理字段可注入）',
    /APPROVAL_TOOLS = new Set\(\[[\s\S]*?'computer_use'[\s\S]*?\]\)/.test(coreSrc));
  check('TOOL_TIMEOUT_OVERRIDES：computer_use = 900000（15min 兜底）',
    /computer_use: 900000,/.test(coreSrc));
  check('runAgent 新增 computerUseEnabled 参数并条件追加 COMPUTER_USE_TOOL',
    /computerUseEnabled = false/.test(coreSrc)
    && /if \(computerUseEnabled && !customTools\)[\s\S]{0,120}COMPUTER_USE_TOOL/.test(coreSrc));
  check('CUA 能力说明仅在 computerUseEnabled 时并入 base system',
    /computerUseEnabled && !customSystemPrompt \? CUA_PROMPT_SECTION/.test(coreSrc));
}

// ── ② 子进程 RPC 白名单（漏登记 → 子进程「未知工具」）──
{
  check('registry.TOOL_CHANNELS 含 computerUse',
    registry.TOOL_CHANNELS.includes('computerUse'),
    `len=${registry.TOOL_CHANNELS.length}`);
  const expected = Object.values(TOOL_HANDLER_NAMES).filter((n) => n !== 'todoWrite');
  const missing = expected.filter((n) => !registry.TOOL_CHANNELS.includes(n));
  check('TOOL_CHANNELS 覆盖 TOOL_HANDLER_NAMES 全部通道（防漏登记）',
    missing.length === 0, missing.length ? `漏=${missing.join(', ')}` : '');
}

// ── ③ 主进程接线（源码静态断言：main.js 无法在纯 Node 下 require）──
{
  const runnerSrc = read('main/agentRunner.js');
  check('agentRunner 白名单放行 computerUseEnabled（仅 macOS + 用户开启）',
    /computerUseEnabled: process\.platform === 'darwin' && approvalSettings\.getComputerUseEnabled\(\)/.test(runnerSrc));
  check('agentRunner 向 createToolHandlers 透传 model（CUA 凭证来源）',
    /model: payload\.model,\s*\}\);/.test(runnerSrc));

  const mainSrc = read('main/main.js');
  // 2026-10-30：toolComputerUse 的实现已整段抽到 main/cuaHandlers.js。下面两类断言
  // 数据源必须分开——「谁注册了这个 handler」在 main.js，「handler 内部怎么做」在
  // cuaHandlers.js。混读一个文件会出现「断言恒真/恒假」的假绿（抽取前它们都在 main.js）。
  const cuaSrc = read('main/cuaHandlers.js');
  check('main.js createToolHandlers 注册 computerUse handler',
    /computerUse: \(args\) => toolComputerUse\(args, \{/.test(mainSrc));
  check('main.js createToolHandlers 接收 model 参数',
    // R2（2026-10-20）：签名新增 projectPath（编排建组落记忆空间键），model 仍在列
    /createToolHandlers: \(\{ sender, signal, runId, emitSubagent, approvalMode: runApprovalMode, conversationId, model, projectPath \}\)/.test(mainSrc));
  check('toolComputerUse 顶层授权走标准审批中心（computer_use，仅 once 放行）',
    /requestApproval\('computer_use'/.test(cuaSrc) && /topDecision !== 'once'/.test(cuaSrc));
  check('toolComputerUse 逐次动作确认走标准审批中心（复用 cua_action）',
    /requestApproval: \(summary, action, node\) => requestApproval\('cua_action'/.test(cuaSrc));
  check('toolComputerUse 复用 ComputerUseLoop + cuaProcess + 凭证解析',
    /new cua\.ComputerUseLoop\(/.test(cuaSrc)
    && /cuaProcess\.isAvailable\(\) \? cuaProcess\.createSession\(\)/.test(cuaSrc)
    && /resolveSecret\(providerId, isGlobal\)/.test(cuaSrc));
  check('toolComputerUse 平台门控（仅 darwin）',
    /if \(process\.platform !== 'darwin'\) return \{ ok: false, error: '界面自动化仅支持 macOS' \}/.test(cuaSrc));

  const cuSrc = read('main/computerUse.js');
  check('computerUse.js requestConfirm 把 action/node 透给审批出口（标准通道可用）',
    /this\.approval\.requestApproval\(summary, action, node\)/.test(cuSrc));
}

// ── ④ opt-in 开关（approvalSettings，缺省 false）──
{
  const withPref = (pref) => {
    approvalSettings.initApprovalSettings({ getLocalStore: () => ({ getPreference: () => pref }) });
    return approvalSettings.getComputerUseEnabled();
  };
  check('computer_use_enabled 缺省（无偏好）→ false', withPref({}) === false);
  check('computer_use_enabled === true → 开启', withPref({ computer_use_enabled: true }) === true);
  check("字符串 'true' 不算开启（拒绝类型漂移放大权限）", withPref({ computer_use_enabled: 'true' }) === false);
  // 归零：避免影响其它套件（同进程内模块单例）
  approvalSettings.initApprovalSettings({ getLocalStore: () => null });

  const modalSrc = read('renderer/src/components/SettingsModal.jsx');
  check('设置页开关写 computer_use_enabled（默认关闭）',
    /computer_use_enabled: v/.test(modalSrc) && /Switch[\s\S]{0,200}computer_use_enabled/.test(modalSrc));
}

// ── ⑤ 审批分级（单一事实来源）──
{
  check('toolLevel(computer_use) = L1（恒逐次确认，不接受规则豁免）',
    approval.toolLevel('computer_use', {}) === 'L1', `got=${approval.toolLevel('computer_use', {})}`);
  check('NON_REMEMBERABLE 含 computer_use（不落「始终允许」规则）',
    approval.NON_REMEMBERABLE.has('computer_use') && approval.isRememberable('computer_use') === false);
  check('NON_REMEMBERABLE 含 cua_action（逐次动作 IDE 不得提供「始终允许」）',
    approval.NON_REMEMBERABLE.has('cua_action') && approval.isRememberable('cua_action') === false);
  check('computer_use 不可补偿（桌面副作用无法回滚）',
    approval.reversibilityOf('computer_use', 'L1').reversible === false);
  const sum = approval.approvalSummary('computer_use', { objective: '打开设置页', app_name: 'Safari', max_steps: 5 });
  check('approvalSummary(computer_use)：L1 + 标题含「界面自动化」+ 详情含目标应用',
    sum.level === 'L1' && /界面自动化/.test(sum.title) && /Safari/.test(sum.detail) && /打开设置页/.test(sum.detail),
    JSON.stringify({ level: sum.level, title: sum.title }));
  check('approvalSummary(cua_action) 仍可用（逐次动作卡片）',
    approval.approvalSummary('cua_action', { action: 'click', target: '购买' }).title.includes('界面操作'));
  const target = approval.approvalTarget('computer_use', { app_name: 'Safari', objective: 'x' });
  check('approvalTarget(computer_use) 粒度含目标应用', /Safari/.test(target), target);
}

// ── ⑥ 渲染层标签 + i18n（双语）──
{
  const tt = read('renderer/src/components/tools/ToolTrace.tsx');
  check('ToolTrace 映射 computer_use → toolTrace.computerUse',
    /computer_use: 'toolTrace\.computerUse'/.test(tt));
  for (const loc of ['zh-CN', 'en-US']) {
    const trace = JSON.parse(read(`renderer/src/i18n/locales/${loc}/toolTrace.json`));
    const settings = JSON.parse(read(`renderer/src/i18n/locales/${loc}/settings.json`));
    check(`i18n[${loc}] toolTrace.computerUse 存在`, typeof trace.computerUse === 'string' && trace.computerUse.length > 0);
    check(`i18n[${loc}] settings.computerUseEnable / computerUseEnableDesc 存在`,
      typeof settings.computerUseEnable === 'string' && typeof settings.computerUseEnableDesc === 'string'
      && settings.computerUseEnable.length > 0 && settings.computerUseEnableDesc.length > 0);
  }
}

console.log(`\ncomputer-use-wiring: ${pass} 条断言通过`);
