// 一级导航门禁（设计文档 §9 P1-8 要求的 `nav-state-dual-entry` 套件）
//
// 守护什么：一级导航的**返回值域**与**收敛规则**不能被悄悄改回去。
//   2026-10-24 第一版：4 项 → 2 项（新建任务 / 助理），定时任务降为助理子 Tab。
//   2026-10-24 第二版（用户实测要求）：**定时任务升回一级入口** ⇒ 3 项
//     （新建任务 / 助理 / 定时任务）；团队编制仍在助理内。
//   本套件随之改写为第二版的判据 —— 这正是它存在的意义：语义变了，门禁必须先红，
//   然后**显式**改成新语义，而不是让旧断言在一片红里被顺手删掉。
//
// 断言范式纪律：
//   · **必须用行为断言**——直接 import `renderer/src/lib/navState.ts` 与
//     `renderer/src/lib/assistantTabs.ts`，穷举视图组合、实调纯函数，断言返回值；
//   · **禁止只做源码正则匹配**当主判据（源码形态会随格式化漂移，且挡不住语义回退）。
//     正则只用在最后几条「连线」检查里，且仅用于「组件真的挂了这个分支」这种结构性事实。
//
// 本套件自己也要能被证伪：删掉 `activeNavOf` 的 scheduled 分支后必须变红。
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

// ── 视图组合穷举器：7 个布尔标志（含两个兼容输入 + 接单台）⇒ 128 组 ──
// 第三版（2026-10-25）：新增一级入口「工作台」⇒ 标志从 6 个变 7 个，组合数 64→128。
// 语义变了就先让旧断言红，再显式改成新语义 —— 这是本套件存在的意义（见文件头）。
const FLAGS = ['showAssistant', 'showScheduled', 'showDashboard', 'showEcosystem', 'showTeams', 'showDesk', 'hasActiveThread'];
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
// 第二版：'scheduled' 是**合法**返回值（一级入口），'teams' 仍不返回（它是助理子 Tab）
// 第三版（2026-10-25）：'desk' 也是合法返回值（工作台/接单台，优先级最高）
const ALLOWED = new Set(['new', 'assistant', 'scheduled', 'ecosystem', 'desk', '']);

// ── A. 一级选中态：行为断言 ──

await check('A1 穷举 128 种视图组合：返回值域收敛为 6 个字面量（穷尽）', () => {
  assert.equal(COMBOS.length, 128, `组合数应为 128，实际 ${COMBOS.length}`);
  for (const c of COMBOS) {
    const got = activeNavOf(c);
    assert.ok(ALLOWED.has(got), `未定义返回值：${JSON.stringify(c)} → ${got}`);
  }
});

await check('A2 兼容别名不泄漏：teams 永不被返回（它是助理子 Tab）；scheduled 仅在 showScheduled 时返回', () => {
  for (const c of COMBOS) {
    const got = activeNavOf(c);
    assert.notEqual(got, 'teams', `仍在返回 'teams'：${JSON.stringify(c)}`);
    if (got === 'scheduled') {
      assert.equal(c.showScheduled, true, `未开定时任务页却返回 'scheduled'：${JSON.stringify(c)}`);
    }
  }
});

await check('A3 互斥（渲染侧）：多视图条件同时为真时，侧栏实际点亮的一级入口恒为 1 个', async () => {
  // ⚠ 原断言是**恒真式**：`['new',…].filter((k) => k === got).length <= 1` ——
  // `activeNavOf` 返回**单值**，命中数恒 ≤ 1，证明不了「不会两个入口同时亮」。
  // 改为真渲染 Sidebar、数 aria-current="page"（这是唯一能证伪的形态）。
  const { renderHtml, countAriaCurrent } = await import('./helpers/render-html.mjs');
  const base = { threads: [], projects: [], activeThread: null, activeProject: null, onSelect: () => {} };
  // 期望值写死，两个方向都验：冲突组合必须**恰好亮 1 个**（0 个＝点了没亮，也是缺陷）；
  // 用量页按设计不点亮任何一级入口（activeNavOf 返回 ''），必须**恰好 0 个**。
  // 只断言「≤1」会漏掉前者，只断言「=1」会误伤后者。
  const cases = [
    { view: { showDesk: true, showScheduled: true, showAssistant: true, showDashboard: true, showEcosystem: true, showTeams: true }, expect: 1 },
    { view: { showDesk: true, showAssistant: true }, expect: 1 },
    { view: { showDesk: true, showScheduled: true }, expect: 1 },
    { view: { showDesk: false, showScheduled: true, showAssistant: true, showTeams: true }, expect: 1 },
    { view: { showAssistant: true, showEcosystem: true }, expect: 1 },
    { view: {}, expect: 1 },
    { view: { showDashboard: true }, expect: 0 },
  ];
  for (const c of cases) {
    const html = renderHtml('components/Sidebar.jsx', { ...base, view: { ...c.view, assistantTab: 'publish' } });
    const n = countAriaCurrent(html);
    assert.equal(n, c.expect, `${JSON.stringify(c.view)} → 点亮 ${n} 个（期望 ${c.expect}）`);
  }
});

await check('A4 助理及团队编制收敛到 assistant；定时任务**不**收敛到 assistant（它是一级入口）', () => {
  for (const c of COMBOS) {
    const shouldAssistant = c.showAssistant || c.showTeams;
    if (!shouldAssistant) continue;
    if (c.showDesk) continue;      // 接单台优先级最高，见 A9
    if (c.showScheduled) continue; // 定时任务优先，见 A8
    assert.equal(activeNavOf(c), 'assistant', `助理子态未收敛：${JSON.stringify(c)}`);
  }
});

await check('A5 单独生效：只开定时任务页 ⇒ scheduled；只开团队编制 ⇒ assistant', () => {
  const base = { showAssistant: false, showDashboard: false, showEcosystem: false, hasActiveThread: false };
  assert.equal(activeNavOf({ ...base, showScheduled: true, showTeams: false }), 'scheduled');
  assert.equal(activeNavOf({ ...base, showScheduled: false, showTeams: true }), 'assistant');
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

await check('A8 定时任务优先于助理（两者同时为真时更具体的那个点亮，避免「点了却亮在别处」）', () => {
  const v = { showAssistant: true, showScheduled: true, showDashboard: false, showEcosystem: false, showTeams: false, hasActiveThread: false };
  assert.equal(activeNavOf(v), 'scheduled');
});

await check('A9 接单台（desk）优先于一切：showDesk 为真时恒返回 desk，且优先于 assistant/scheduled/ecosystem', () => {
  for (const c of COMBOS.filter((x) => x.showDesk)) {
    assert.equal(activeNavOf(c), 'desk', `desk 未优先：${JSON.stringify(c)}`);
  }
  // 反向：desk 不在场时永不返回 desk（否则「什么都没开」会莫名点亮工作台）
  for (const c of COMBOS.filter((x) => !x.showDesk)) {
    assert.notEqual(activeNavOf(c), 'desk', `未开工作台却返回 desk：${JSON.stringify(c)}`);
  }
});

// ── B. 助理子页目录与挂载方式 ──

await check('B1 助理子页目录恰为三个 Tab：发布任务（默认）/ 军团 / AI 建团', () => {
  const ids = ASSISTANT_TABS.map((x) => x.id);
  assert.deepEqual(ids, ['publish', 'teams', 'aiTeam']);
  // 定时任务已升回一级入口 ⇒ 不得再作为助理 Tab（两个并列入口会让「在哪管理」有两个答案）
  assert.ok(!ids.includes('scheduled'), '定时任务不应再是助理子 Tab');
});

await check('B2 每个 Tab 的文案键都存在且指向 assistant 模块（禁硬编码文案的第一道闸）', () => {
  for (const tab of ASSISTANT_TABS) {
    assert.ok(typeof tab.labelKey === 'string' && tab.labelKey.length > 0, `${tab.id} 缺 labelKey`);
    assert.match(tab.labelKey, /^assistant\./, `${tab.id} 的文案键不在 assistant 模块：${tab.labelKey}`);
  }
});

await check('B3 默认 Tab 是「发布任务」；isAssistantTab 对非法输入返回 false（防脏值进视图状态）', () => {
  assert.equal(DEFAULT_ASSISTANT_TAB, 'publish', `默认 Tab 应为 publish，实际 ${DEFAULT_ASSISTANT_TAB}`);
  assert.ok(isAssistantTab(DEFAULT_ASSISTANT_TAB), `默认 Tab 非法：${DEFAULT_ASSISTANT_TAB}`);
  for (const ok of ['publish', 'teams', 'aiTeam']) assert.ok(isAssistantTab(ok), ok);
  for (const bad of ['', null, undefined, 'teams ', 'Teams', 'unknown', 'scheduled', 'complex', 0]) {
    assert.equal(isAssistantTab(bad), false, String(bad));
  }
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

await check('B5 App 把视图标志（含 showScheduled）传给 Sidebar，并按 showScheduled 挂定时任务页', () => {
  const app = stripComments(read('App.jsx'));
  assert.match(app, /view=\{\{\s*showAssistant[^}]*showScheduled[^}]*\}\}/, 'App 未把 showScheduled 传给 Sidebar');
  // 定时任务是一级入口 ⇒ App 直接挂载它是**预期**（第一版这里是反面断言，已按新语义翻转）
  assert.match(app, /showScheduled\s*&&\s*<ScheduledTasks/, 'App 未按 showScheduled 挂载定时任务页');
  // 助理页仍按 tab 挂载（不把四个子页一次性全挂上）
  assert.match(app, /<AssistantPage[^>]*tab=\{assistantTab\}[^>]*onTab=\{setAssistantTab\}/, 'App 未按 tab 挂载 AssistantPage');
  assert.ok(!/<TeamsPage\s*\/>/.test(app), 'App 仍直接挂载 <TeamsPage/>（应留在助理 Tab）');
});

await check('B6 AssistantPage 按 tab 条件挂载三个子视图，且不再有 scheduled/complex 分支', () => {
  const page = stripComments(read('components/AssistantPage.tsx'));
  for (const pair of [
    ["tab === 'publish'", '<PublishTaskPage'],
    ["tab === 'teams'", '<TeamsPage'],
    ["tab === 'aiTeam'", '<AiTeamBuilder'],
  ]) {
    const i = page.indexOf(pair[0]);
    assert.ok(i > 0, `AssistantPage 缺分支 ${pair[0]}`);
    assert.ok(page.slice(i, i + 220).includes(pair[1]), `${pair[0]} 分支未挂载 ${pair[1]}`);
  }
  assert.ok(!page.includes("tab === 'scheduled'"), 'AssistantPage 不应再有 scheduled 分支（已升一级入口）');
  assert.ok(!page.includes('<ScheduledTasks'), 'AssistantPage 不应再挂 ScheduledTasks');
});

await check('B7 Tab 条具备可访问性语义：tabs 原语提供 role/aria，助理页复用它（不再散落裸 button）', () => {
  const page = read('components/AssistantPage.tsx');
  const prim = read('components/ui/TabBar.tsx');
  assert.match(page, /<TabBar/, 'AssistantPage 未使用 ui/TabBar 原语');
  assert.ok(!/<button/.test(stripComments(page)), 'AssistantPage 仍含裸 <button>（应收敛到 ui/TabBar）');
  assert.match(prim, /role="tablist"/);
  assert.match(prim, /role="tab"/);
  assert.match(prim, /aria-selected=\{on\}/);
  assert.match(prim, /aria-label=\{ariaLabel\}/);
});

console.log(`\nnav-state-dual-entry: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
