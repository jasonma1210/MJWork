// 入口层产品边界（R-15 / 第九轮 X-1·X-3）守护套件 —— 2026-10-22
//
// 背景：自动编排与 MJ 军团共用 DAG 底座（上下层关系，不拆引擎），能力层已实质分离
// （team_* 工具 / team 层记忆 / per-bot 配置只属于军团）。「太像」的根因在**入口与
// 呈现层未分流**：选不选团队走同一个发送按钮、任务面板不标记军团 run。
// 本套件锁四层分流不被回退：
//   ① Composer：派活目标条（团队名 + 成员数 + 预算 + 退出）+ 发送按钮语义切换；
//   ② ChatArea：relayRef 接线 + 挂起发送走 sendOrDispatch（唯一分流点）；
//   ③ useAgentRun：轮末接力经 relayRef（选中军团时入队消息也派活，闭 R-5）；
//   ④ TaskSummaryPanel：军团 run 徽标（数据走既有 teamsListThreadRuns 桥面）。
//   ⑤ i18n：新增 key 双语都在（行为断言，读 JSON 而不是数引号）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); process.exitCode = 1; }
};
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假'); };

const composer = read('renderer/src/components/Composer.tsx');
const chat = read('renderer/src/components/ChatArea.jsx');
const hook = read('renderer/src/hooks/useAgentRun.ts');
const panel = read('renderer/src/components/TaskSummaryPanel.tsx');

// 片段长度自检：防「截到空串却匹配成功」的空过
const snippet = (src, anchor, len) => {
  const i = src.indexOf(anchor);
  ok(i > 0, `找不到装配点：${anchor}`);
  const seg = src.slice(i, i + len);
  ok(seg.length >= len, `装配片段被截断（长度自检失败）：${anchor}`);
  return seg;
};

// ── ① Composer：派活目标条 ──
check('① 派活目标条：选中团队时常驻一行（团队名 + 成员数 + 预算 + 退出）', () => {
  const i = composer.indexOf('派活目标条');
  ok(i > 0, '找不到目标条注释锚');
  // 2026-10-27 修「字符窗口假红」：原判据是「注释锚之后 1200 个字符内出现 5 个标记」，
  // 实测 onClearTeam 落在 +1326（只差 126 字符就被判缺失），而它明明在同一个 JSX 块里 ——
  // 这是把**位置代理**当成契约：给目标条加一句文案、多一个字段，断言就红，与人无关。
  // 现在按**块边界**取片段：从注释锚到该 JSX 块收尾 `)}`。
  // 失败方向是安全的：若块内新增嵌套 `)}` 导致提前截断，断言会红（假红），不会静默变绿。
  const endRe = /\n\s*\)\}\n/g;
  endRe.lastIndex = i;
  const m = endRe.exec(composer);
  const seg = composer.slice(i, m ? m.index : composer.length);
  ok(seg.length >= 400, `装配片段被截断（长度自检失败）：${seg.length} 字符`);
  ok(/t\('composer\.dispatchTo'\)/.test(seg), '缺少「派活给」前缀');
  ok(/t\('composer\.teamMembers'/.test(seg), '缺少成员数');
  ok(/teamBudgetLabel/.test(seg), '缺少预算摘要');
  ok(/onClearTeam/.test(seg), '缺少退出派活态的入口');
  ok(/activeTeam\.name/.test(seg), '团队名没有完整展示（不再截 10rem 小徽标）');
});

check('① 目标条不再复用 10rem 小徽标（旧形态已移除）', () => {
  ok(!/max-w-\[10rem\]/.test(composer), '旧的 10rem 截断徽标仍在——目标条升级被回退');
});

check('① activeTeam 退出徽标行判定（否则只剩团队时会出现空徽标行）', () => {
  const i = composer.indexOf('const hasTaskBadges');
  ok(i > 0, '找不到 hasTaskBadges');
  const seg = composer.slice(i, i + 400);
  ok(!/planMode \|\| expert \|\| activeTeam/.test(seg), 'hasTaskBadges 仍把 activeTeam 算作徽标——会出现空行');
});

check('① 发送按钮语义切换：派活态用「派活」文案 + IconUsers 图标', () => {
  const i = composer.indexOf('dispatchMode ? t(\'composer.dispatch\')');
  ok(i > 0, '发送按钮没有派活态分支');
  const seg = composer.slice(i - 200, i + 400);
  ok(/dispatchMode \? <IconUsers/.test(seg), '派活态没有切图标（用户看不出这一发发给谁）');
  ok(/composer\.dispatchTip/.test(seg), '派活态缺少解释性 title');
});

// ── ② ChatArea：唯一分流点接线 ──
check('② relayRef 注入 useAgentRun（持最新 sendOrDispatch）', () => {
  ok(/relayRef: sendOrDispatchRef/.test(chat), 'useAgentRun 没有收到 relayRef');
  ok(/sendOrDispatchRef\.current = sendOrDispatch/.test(chat), 'latest-ref 未每次渲染刷新（会拿到过期闭包）');
});

check('② 挂起发送（排队卡片「直接发送」）走 sendOrDispatch，不再直调 send', () => {
  const i = chat.indexOf('if (!pendingRun || loading) return;');
  ok(i > 0, '找不到 pendingRun effect');
  const seg = chat.slice(i, i + 200);
  ok(/sendOrDispatch\(text\)/.test(seg), '挂起发送仍在直调 send——选中军团时立即执行的入队消息会丢派活语义（R-5）');
  ok(!/^\s*send\(text\);/m.test(seg), '仍存在直调 send(text)');
});

// ── ③ useAgentRun：轮末接力分流 ──
check('③ useAgentRun 解构 relayRef 且接力点带分流', () => {
  ok(/onSubagentEvent, relayRef,/.test(hook), 'relayRef 没有进解构（0 行预算内应追加在既有行尾）');
  ok(/relayRef\?\.current \|\| send/.test(hook), '接力点没有 relayRef 分流');
});

// ── ④ TaskSummaryPanel：军团徽标 ──
check('④ 任务面板调 teamsListThreadRuns 取军团归属（复用既有桥面，零新 IPC）', () => {
  ok(/teamsListThreadRuns\?\.\(\{ threadId/.test(panel), '没有调用 teamsListThreadRuns');
  ok(/teamByRun/.test(panel), '没有按 run 建归属映射');
});

check('④ group 行渲染军团徽标（IconUsers + rightPane.teamRunBadge）', () => {
  const i = panel.indexOf('g.teamName &&');
  ok(i > 0, '找不到徽标条件渲染');
  const seg = panel.slice(i, i + 500);
  ok(/IconUsers/.test(seg), '徽标没有图标');
  ok(/t\('rightPane\.teamRunBadge'\)/.test(seg), '徽标文案未走 i18n');
  ok(/teamRunBadgeTip/.test(seg), '徽标缺少归属提示（哪个团队的 run）');
});

// ── ⑤ i18n：新增 key 双语齐备（行为断言：读 JSON） ──
check('⑤ composer / rightPane 新增 key 在 zh-CN 与 en-US 都存在', () => {
  const keys = {
    'renderer/src/i18n/locales/zh-CN/composer.json': ['dispatchTo', 'dispatch', 'dispatchTip', 'dispatchPlaceholder', 'teamMembers', 'teamBudget', 'teamBudgetDefault'],
    'renderer/src/i18n/locales/en-US/composer.json': ['dispatchTo', 'dispatch', 'dispatchTip', 'dispatchPlaceholder', 'teamMembers', 'teamBudget', 'teamBudgetDefault'],
    'renderer/src/i18n/locales/zh-CN/rightPane.json': ['teamRunBadge', 'teamRunBadgeTip'],
    'renderer/src/i18n/locales/en-US/rightPane.json': ['teamRunBadge', 'teamRunBadgeTip'],
  };
  for (const [file, want] of Object.entries(keys)) {
    const obj = JSON.parse(read(file));
    for (const k of want) ok(Object.prototype.hasOwnProperty.call(obj, k), `${file} 缺 key：${k}`);
  }
});

console.log(`\nteam-dispatch-entry: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
