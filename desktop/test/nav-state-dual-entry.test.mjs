// 双入口导航门禁（设计文档 §9 P1-8 要求的 `nav-state-dual-entry` 套件）
//
// 守护什么：一级导航从 4 项重组为 2 项（新建任务 / 助理）后，
//   `activeNavOf` 的**新语义**与**兼容别名**都不能被悄悄改回去。
//
// 断言范式纪律（tester 变异验证结论，见设计文档 §9 P1-8）：
//   · **必须用行为断言**——直接 import `renderer/src/lib/navState.ts` 与
//     `renderer/src/lib/assistantTabs.ts`，穷举视图组合、实调纯函数，断言返回值；
//   · **禁止只做源码正则匹配**当主判据（源码形态会随格式化漂移，且挡不住语义回退）。
//     正则只在最后两条「连线」检查里用，且仅用于「组件真的调了这个判定」这种结构性事实。
//
// 本套件自己也要能被证伪：删掉 `activeNavOf` 的 assistant 分支后必须变红（见实施报告
// 的变异验证记录：变异 → 具体哪条断言红 → 恢复）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
// 注释剥离（与 ui-conventions / i18n-scan 同一口径）：注释里提到 `<button>` 不该算数
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); process.exitCode = 1; }
};

const { activeNavOf } = await import('../renderer/src/lib/navState.ts');
const { ASSISTANT_TABS, DEFAULT_ASSISTANT_TAB, isAssistantTab } = await import('../renderer/src/lib/assistantTabs.ts');

// ── 视图组合穷举器：6 个布尔标志（含两个兼容输入）⇒ 64 组 ──
const FLAGS = ['showAssistant', 'showScheduled', 'showDashboard', 'showEcosystem', 'showTeams', 'hasActiveThread'];
function allCombos() {
  const out = [];
  for (let mask = 0; mask < (1 << FLAGS.length); mask++) {
    const v = {};
    FLAGS.forEach((f, i) => { v[f] = (mask & (1 << i)) !== 0; });
    out.push(v);
  }
  return out;
}
const COMBOS = allCombos();
const ALLOWED = new Set(['new', 'assistant', 'ecosystem', '']);

// ── A. 一级选中态：行为断言 ──

await check('A1 穷举 64 种视图组合：返回值域收敛为 4 个字面量（穷尽）', () => {
  assert.equal(COMBOS.length, 64, `组合数应为 64，实际 ${COMBOS.length}`);
  for (const c of COMBOS) {
    const got = activeNavOf(c);
    assert.ok(ALLOWED.has(got), `未定义返回值：${JSON.stringify(c)} → ${got}`);
  }
});

await check('A2 兼容别名不再泄漏到返回值：scheduled / teams 永不被返回', () => {
  for (const c of COMBOS) {
    const got = activeNavOf(c);
    assert.notEqual(got, 'scheduled', `仍在返回 'scheduled'：${JSON.stringify(c)}`);
    assert.notEqual(got, 'teams', `仍在返回 'teams'：${JSON.stringify(c)}`);
  }
});

await check('A3 互斥：被点亮的一级入口恒不超过一个（含兼容输入）', () => {
  for (const c of COMBOS) {
    const got = activeNavOf(c);
    const lit = ['new', 'assistant', 'ecosystem'].filter((k) => k === got);
    assert.ok(lit.length <= 1, `多个入口同时点亮：${JSON.stringify(c)} → ${got}`);
  }
});

await check('A4 助理子态统一返回 assistant：showAssistant / showScheduled / showTeams 三者任一为真', () => {
  for (const c of COMBOS) {
    const shouldAssistant = c.showAssistant || c.showScheduled || c.showTeams;
    if (!shouldAssistant) continue;
    assert.equal(activeNavOf(c), 'assistant', `助理子态未收敛：${JSON.stringify(c)}`);
  }
});

await check('A5 兼容输入单独生效：只有 showScheduled（旧定时任务页）也返回 assistant', () => {
  const v = { showAssistant: false, showScheduled: true, showDashboard: false, showEcosystem: false, showTeams: false, hasActiveThread: false };
  assert.equal(activeNavOf(v), 'assistant');
  const w = { ...v, showScheduled: false, showTeams: true };
  assert.equal(activeNavOf(w), 'assistant');
});

await check('A6 助理优先于生态中心（弹层盖在助理之上，底层入口应保持点亮）', () => {
  const v = { showAssistant: true, showScheduled: false, showDashboard: false, showEcosystem: true, showTeams: false, hasActiveThread: false };
  assert.equal(activeNavOf(v), 'assistant');
  // 助理不在场时，生态中心仍然是可点亮的过渡态
  const w = { ...v, showAssistant: false };
  assert.equal(activeNavOf(w), 'ecosystem');
});

await check('A7 工作台与会话中不点亮一级导航；空白新建任务页点亮 new', () => {
  const base = { showAssistant: false, showScheduled: false, showEcosystem: false, showTeams: false, hasActiveThread: false };
  assert.equal(activeNavOf({ ...base, showDashboard: true }), '');
  assert.equal(activeNavOf({ ...base, hasActiveThread: true }), '');
  assert.equal(activeNavOf({ ...base, showDashboard: true, hasActiveThread: true }), '');
  assert.equal(activeNavOf(base), 'new');
});

// ── B. 助理子页目录与挂载方式 ──

await check('B1 助理子页目录恰为设计文档 §7.7 的四个 Tab', () => {
  const ids = ASSISTANT_TABS.map((x) => x.id);
  assert.deepEqual(ids, ['teams', 'aiTeam', 'scheduled', 'complex']);
});

await check('B2 每个 Tab 的文案键都存在且指向 assistant 模块（禁硬编码文案的第一道闸）', () => {
  for (const tab of ASSISTANT_TABS) {
    assert.ok(typeof tab.labelKey === 'string' && tab.labelKey.length > 0, `${tab.id} 缺 labelKey`);
    assert.match(tab.labelKey, /^assistant\./, `${tab.id} 的文案键不在 assistant 模块：${tab.labelKey}`);
  }
});

await check('B3 默认 Tab 合法；isAssistantTab 对非法输入返回 false（防脏值进视图状态）', () => {
  assert.ok(isAssistantTab(DEFAULT_ASSISTANT_TAB), `默认 Tab 非法：${DEFAULT_ASSISTANT_TAB}`);
  for (const ok of ['teams', 'aiTeam', 'scheduled', 'complex']) assert.ok(isAssistantTab(ok), ok);
  for (const bad of ['', null, undefined, 'teams ', 'Teams', 'unknown', 0]) assert.equal(isAssistantTab(bad), false, String(bad));
});

await check('B4 文案键在 zh-CN 与 en-US 双侧都存在（Tab 条不会出现裸 key）', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/zh-CN/assistant.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/en-US/assistant.json'), 'utf8'));
  for (const tab of ASSISTANT_TABS) {
    const leaf = tab.labelKey.replace(/^assistant\./, '');
    assert.equal(typeof zh[leaf], 'string', `zh-CN 缺 ${tab.labelKey}`);
    assert.equal(typeof en[leaf], 'string', `en-US 缺 ${tab.labelKey}`);
  }
});

await check('B5 App 只挂一个助理工作台，且不再直接挂 TeamsPage / ScheduledTasks（按 tab 挂载）', () => {
  const app = read('App.jsx');
  assert.match(app, /<AssistantPage[^>]*tab=\{assistantTab\}[^>]*onTab=\{setAssistantTab\}/, 'App 未按 tab 挂载 AssistantPage');
  assert.ok(!/<TeamsPage\s*\/>/.test(app), 'App 仍直接挂载 <TeamsPage/>（应搬入助理 Tab1）');
  assert.ok(!/<ScheduledTasks\s*\/>/.test(app), 'App 仍直接挂载 <ScheduledTasks/>（应搬入助理 Tab3）');
});

await check('B6 AssistantPage 按 tab 条件挂载四个子视图（不是同时挂载）', () => {
  const page = read('components/AssistantPage.tsx');
  for (const pair of [
    ["tab === 'teams'", '<TeamsPage'],
    ["tab === 'aiTeam'", '<AiTeamBuilder'],
    ["tab === 'scheduled'", '<ScheduledTasks'],
    ["tab === 'complex'", '<ComplexTaskLauncher'],
  ]) {
    const i = page.indexOf(pair[0]);
    assert.ok(i > 0, `AssistantPage 缺分支 ${pair[0]}`);
    assert.ok(page.slice(i, i + 200).includes(pair[1]), `${pair[0]} 分支未挂载 ${pair[1]}`);
  }
});

await check('B7 Tab 条具备可访问性语义：tabs 原语提供 role/aria，助理页复用它（不再散落裸 button）', () => {
  const page = read('components/AssistantPage.tsx');
  const prim = read('components/ui/TabBar.tsx');
  // 助理页必须用原语（否则又会新增一段裸 <button>，抬高 ui-conventions 棘轮）
  assert.match(page, /<TabBar/, 'AssistantPage 未使用 ui/TabBar 原语');
  assert.ok(!/<button/.test(stripComments(page)), 'AssistantPage 仍含裸 <button>（应收敛到 ui/TabBar）');
  // 语义在**原语内唯一一处**实现
  assert.match(prim, /role="tablist"/);
  assert.match(prim, /role="tab"/);
  assert.match(prim, /aria-selected=\{on\}/);
  assert.match(prim, /aria-label=\{ariaLabel\}/);
});

console.log(`\nnav-state-dual-entry: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
