// D-05-B′ 回归门禁：数字员工「招募 → 角色预设生效」事件链逐环守护。
//
// 背景：README 曾一行写「role templates ... not yet wired into the Agent runtime」，
// 另一行又写「数字员工 51 个角色 + rolePreset 运行时落地 + 审批沙箱只收紧不放宽」——
// 同一份文档自相矛盾。实测（第七轮 P3 独立核验）链路是**通的**，错的是那句「未接入」。
//
// 这条链路横跨 5 个文件 + 2 次自定义事件转发，任何一环改名/挪位置都会**静默断链**：
// 招募按钮照常「成功」、界面照常开新会话，只是 rolePreset 恒为空 —— 员工角色不生效，
// 且没有任何报错。静态结构断言是当前唯一能在 CI 里抓到这类断链的手段（本项目既有风格）。
//
// 真实链路（与任务书里的简写不同，以代码为准，已逐环读源码确认）：
//   EcosystemModal.jsx  ecosystem:employeeRuntime → dispatch 'mjcode:recruit-expert'(detail.runtime)
//   App.jsx             listen 'mjcode:recruit-expert' → 开新会话 → dispatch 'mjcode:enable-expert'
//   ChatArea.jsx        listen 'mjcode:enable-expert' → sessionExtras.expert = detail
//   useAgentRun.ts      每轮 agent:run 携带 rolePreset: sessionExtras?.expert?.runtime
//   agentRunner.js      if (payload.rolePreset) → stricterApproval / stricterSandbox
//   agent.js (回退)     applyRoleClamp（F-020 后两条通道同纪律）
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.dirname(DESKTOP);

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
function read(rel) {
  const p = path.join(DESKTOP, rel);
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${rel}（改名后本门禁需同步）`);
  return fs.readFileSync(p, 'utf8');
}
// 剥掉 JS/TS 注释后再做结构断言。
// 为什么必须剥（本轮实证）：不剥的话，把 dispatchEvent 那行**注释掉**仍能通过正则 ——
// 注释里留着同样的文本，门禁变成「只要代码里出现过这串字符就算活着」，
// 正是本项目已踩过的「断言被注释满足」假绿。剥离后断言只对**可执行代码**生效。
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d === undefined ? '' : d; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1; continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}
function readCode(rel) { return stripComments(read(rel)); }
function must(src, re, what) {
  if (!re.test(src)) throw new Error(`未找到：${what}`);
}
function mustNot(src, re, what) {
  if (re.test(src)) throw new Error(`不该出现：${what}`);
}

// ── ① 生态中心：取运行时预设 + 派发招募事件 ──────────────────────────────
check('① EcosystemModal 取 ecosystem:employeeRuntime 并派发 recruit-expert（断了 → 招募拿到空预设，员工整个不生效）', () => {
  const src = readCode('renderer/src/components/EcosystemModal.jsx');
  must(src, /ecosystemEmployeeRuntime\s*\(\s*\{\s*id:/, 'ecosystem:employeeRuntime 桥方法调用');
  must(src, /window\.dispatchEvent\(new CustomEvent\('mjcode:recruit-expert'/, "'mjcode:recruit-expert' 事件派发");
  // detail 必须带 runtime（角色预设本体），否则后续环拿到空壳
  must(src, /'mjcode:recruit-expert'[\s\S]{0,160}runtime:\s*r\.rolePreset/, 'detail.runtime = rolePreset');
  // 反向：桥不可用/预设缺失必须明确报错，不得静默继续（否则「招募成功但无角色」无从察觉）
  must(src, /!r\?\.ok \|\| !r\.rolePreset/, '预设缺失时的 fail-closed 判断');
});

// ── ①b 助理工作台派单：同一链路，但入口是 AssistantDispatch ─────────────
// 为什么单列一条：①守的只有生态中心那一个入口。助理页「派给助手」走的是另一条
// 组装路径（AssistantDispatch → onDispatchAssistant → App.onDispatchEmployee →
// recruit-expert），它与①共用后半段，但**前半段各自组装 detail**。实测（2026-11-04）
// 这条路径两处同时断：dispatchAssistant 拿到 rolePreset 后丢弃，App 又把整个 detail
// 当 ComposerExtras 落档（ChatArea 恢复时 `{...EMPTY_EXTRAS, ...saved}` 摊不出 expert）。
// 结果是「派发成功、会话已建、员工不生效、审批沙箱退回默认档」——比没做更糟。
check('①b 助理页派单同样转发 rolePreset（断了 → 派单成功但员工不生效，且审批/沙箱退回默认档）', () => {
  const disp = readCode('renderer/src/components/AssistantDispatch.tsx');
  must(disp, /ecosystemEmployeeRuntime\?\.\(\s*\{\s*id:/, 'ecosystem:employeeRuntime 桥方法调用');
  must(disp, /!rt\?\.ok \|\| !rt\.rolePreset/, '预设缺失时的 fail-closed 判断');
  must(disp, /onDispatchAssistant\?\.\(\{\s*employee:\s*emp,\s*goal:\s*g,\s*runtime:\s*rt\.rolePreset\s*\}\)/,
    'onDispatchAssistant 携带 runtime: rt.rolePreset');

  const app = readCode('renderer/src/App.jsx');
  must(app, /onDispatchEmployee=\{\(\{\s*employee,\s*goal,\s*runtime\s*\}\)/, 'onDispatchEmployee 解构出 runtime');
  must(app, /'mjcode:recruit-expert',\s*\{\s*detail:\s*\{[^}]*\.\.\.\(runtime/, 'runtime 并入 recruit-expert 的 detail');
  // 新会话分支的第三个实参必须是 ComposerExtras（{ expert: detail }），不是 detail 本体
  must(app, /newThreadInProjectRef\.current\?\.\(null, goal, \{ expert: detail \}\)/,
    '新会话按 ComposerExtras 形状落档 { expert: detail }');
  mustNot(app, /newThreadInProjectRef\.current\?\.\(null, goal, detail\)/,
    '把 detail 本体当 ComposerExtras（expert 会恒为空）');
});

// ── ② App：监听招募 → 切新会话 → 转发 enable-expert ──────────────────────
check("② App.jsx 监听 recruit-expert 并转发 enable-expert（断了 → 招募后 rolePreset 恒为空 → 员工实际不生效）", () => {
  const src = readCode('renderer/src/App.jsx');
  must(src, /addEventListener\('mjcode:recruit-expert'/, "'mjcode:recruit-expert' 监听");
  must(src, /removeEventListener\('mjcode:recruit-expert'/, "'mjcode:recruit-expert' 监听清理（防重复注册叠加注入）");
  must(src, /new CustomEvent\('mjcode:enable-expert',\s*\{\s*detail\s*\}\)/, '把 detail 原样转发为 enable-expert');
});

// ── ③ ChatArea：写 sessionExtras.expert ─────────────────────────────────
check('③ ChatArea 监听 enable-expert 并写入 sessionExtras.expert（断了 → 角色只开了会话，没进会话状态）', () => {
  const src = readCode('renderer/src/components/ChatArea.jsx');
  must(src, /addEventListener\('mjcode:enable-expert'/, "'mjcode:enable-expert' 监听");
  must(src, /expert:\s*e\.detail/, 'sessionExtras.expert = e.detail');
});

// ── ④ useAgentRun：每轮携带 rolePreset ─────────────────────────────────
check('④ useAgentRun 每轮 agent:run 携带 rolePreset（断了 → 预设只停在 state 里，一次都没下发）', () => {
  const src = readCode('renderer/src/hooks/useAgentRun.ts');
  must(src, /rolePreset:\s*sessionExtras\?\.expert\?\.runtime/, 'rolePreset: sessionExtras?.expert?.runtime');
});

// ── ⑤ 主进程：消费 rolePreset 并取更严格者 ─────────────────────────────
check('⑤ agentRunner 消费 payload.rolePreset 并调用钳制（断了 → 角色声明的审批/沙箱被无视，或可反向放宽权限）', () => {
  const src = readCode('main/agentRunner.js');
  // 2026-10-21（第八轮 D-808）：审批/沙箱钳制从内联收敛到 rolePresetApply，
  // 与 Worker 通道共用一份（此前只有主会话接、Worker 完全没接 ⇒ 成员配置不生效）。
  // 断言按新契约拆分：委托在 agentRunner、钳制在 helper —— 两处缺一即红。
  must(src, /applyRolePreset\(engineParams, payload\.rolePreset,/, 'rolePreset 委托给 applyRolePreset');
  must(src, /rolePreset: payload\.rolePreset \|\| undefined/, 'rolePreset 透传进 engineParams');
  const helper = readCode('main/rolePresetApply.js');
  must(helper, /engineParams\.approvalMode = stricterApproval\(engineParams\.approvalMode, rolePreset\.approvalMode\)/, '审批档取更严格者');
  must(helper, /engineParams\.sandboxPolicy = stricterSandbox\(engineParams\.sandboxPolicy, rolePreset\.sandboxPolicy\)/, '沙箱取更严格者');
});

// ── ⑥ 回退通道：同纪律（F-020 的收口点，防止「主通道严、回退通道松」）────
check('⑥ 进程内回退通道同样钳制（断了 → 同产品两条通道行为不一致，回退时权限被放宽）', () => {
  const src = readCode('renderer/src/lib/agent.js');
  must(src, /applyRoleClamp\(/, 'applyRoleClamp 调用');
  must(src, /from '\.\.\/\.\.\/\.\.\/shared\/roleClamp\.mjs'/, 'shared/roleClamp.mjs 引入');
});

// ── ⑦ 反向断言：README 不得再自相矛盾 ──────────────────────────────────
check('⑦ README（英文）不再声称数字员工「not yet wired」，且如实限定为单角色预设（断了 → 文档继续与运行时相反）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  mustNot(src, /role templates\*\* are structured definitions;\s*not yet wired/, '「role templates ... not yet wired」旧句');
  // 精确定位到数字员工那句所在的表格行，避免把别处的 not yet wired 一并算进来
  const row = src.split('\n').find((l) => /digital-employee/.test(l) && /ecosystem\//.test(l)) || '';
  if (!row) throw new Error('README.md 中找不到 ecosystem/ 数字员工那一行');
  mustNot(row, /not yet wired/, '数字员工行内的「not yet wired」');
  must(row, /rolePreset/, '角色预设链路说明（口径必须提到 rolePreset）');
  must(row, /\*\*not\*\* multi-employee orchestration/, '范围限定：不是多员工编排');
  must(row, /can only tighten permissions, never widen/, '角色只能收紧不能放宽');
});

check('⑦ README（中文）同口径（断了 → 中英两侧口径再次分叉）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8');
  const row = src.split('\n').find((l) => /数字员工/.test(l) && /ecosystem\//.test(l)) || '';
  if (!row) throw new Error('README.zh-CN.md 中找不到 ecosystem/ 数字员工那一行');
  mustNot(row, /当前未接入 Agent 运行时/, '「当前未接入 Agent 运行时」旧表述');
  must(row, /rolePreset/, 'rolePreset 链路说明');
  must(row, /\*\*不是\*\*多员工编排/, '范围限定：不是多员工编排');
  must(row, /只能收紧权限、不能放宽/, '角色只能收紧不能放宽');
});

check('⑦-保留 英文 README 里 OS 级隔离那句 not yet wired 仍须存在（本轮只改数字员工口径，不得顺手删除已知限制）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  must(src, /OS-level isolation is not yet wired/, 'OS-level isolation is not yet wired（已知限制，属另一上下文，须保留）');
});

if (process.exitCode === 1) console.error(`\nFAIL：${total - pass}/${total} 项失败`);
else console.log(`\nPASS：${pass}/${total} 项通过`);
