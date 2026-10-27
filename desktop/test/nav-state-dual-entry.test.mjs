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
const { STUDIO_TABS, DEFAULT_STUDIO_TAB, isStudioTab } = await import('../renderer/src/lib/studioTabs.ts');

// ── 视图组合穷举器：9 个布尔标志（含两个兼容输入 + 接单台 + 账本）⇒ 512 组 ──
// 第三版（2026-10-25）：新增一级入口「工作台」⇒ 标志从 6 个变 7 个，组合数 64→128。
// 第四版（2026-10-26）：新增一级入口「工作室」⇒ 8 个标志，组合数 128→256。
// 第五版（2026-10-27）：新增一级入口「账本」⇒ 9 个标志，组合数 256→512。
// 语义变了就先让旧断言红，再显式改成新语义 —— 这是本套件存在的意义（见文件头）。
const FLAGS = ['showAssistant', 'showScheduled', 'showDashboard', 'showEcosystem', 'showTeams', 'showDesk', 'showStudio', 'showLedger', 'hasActiveThread'];
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
// 第四版（2026-10-26）：新增一级入口「工作室」⇒ 'studio' 也是合法返回值
// 第五版（2026-10-27）：新增一级入口「账本」⇒ 'ledger' 也是合法返回值
const ALLOWED = new Set(['new', 'assistant', 'scheduled', 'ecosystem', 'desk', 'studio', 'ledger', '']);

// ── A. 一级选中态：行为断言 ──

await check('A1 穷举 512 种视图组合：返回值域收敛为 8 个字面量（穷尽）', () => {
  assert.equal(COMBOS.length, 512, `组合数应为 512，实际 ${COMBOS.length}`);
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
    if (c.showStudio) continue;    // 工作室优先（一级入口），见 A10
    if (c.showLedger) continue;    // 账本优先（一级入口），见 A11
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

await check('A10 工作室（studio）优先于定时任务/助理/生态中心，但低于接单台（desk）', () => {
  for (const c of COMBOS.filter((x) => x.showStudio && !x.showDesk)) {
    assert.equal(activeNavOf(c), 'studio', `studio 未优先：${JSON.stringify(c)}`);
  }
  // 反向：studio 不在场时永不返回 studio（否则「什么都没开」会莫名点亮工作室）
  for (const c of COMBOS.filter((x) => !x.showStudio)) {
    assert.notEqual(activeNavOf(c), 'studio', `未开工作室却返回 studio：${JSON.stringify(c)}`);
  }
  // desk 仍压过 studio（接单台优先级最高的语义不能被新入口破坏）
  assert.equal(
    activeNavOf({ showDesk: true, showStudio: true, showScheduled: true, showAssistant: true }),
    'desk',
  );
  // studio 压过 ledger（固化顺序 desk > studio > ledger > scheduled > assistant > ecosystem）
  assert.equal(activeNavOf({ showStudio: true, showLedger: true, showScheduled: true }), 'studio');
});

await check('A11 账本（ledger）优先于定时任务/助理/生态中心，但低于 desk 与 studio', () => {
  for (const c of COMBOS.filter((x) => x.showLedger && !x.showDesk && !x.showStudio)) {
    assert.equal(activeNavOf(c), 'ledger', `ledger 未优先：${JSON.stringify(c)}`);
  }
  // 反向：ledger 不在场时永不返回 ledger（否则「什么都没开」会莫名点亮账本）
  for (const c of COMBOS.filter((x) => !x.showLedger)) {
    assert.notEqual(activeNavOf(c), 'ledger', `未开账本却返回 ledger：${JSON.stringify(c)}`);
  }
  // 只开账本 ⇒ ledger（单独生效，不依赖其它标志）
  assert.equal(activeNavOf({ showLedger: true }), 'ledger');
  // desk / studio 都压过 ledger
  assert.equal(activeNavOf({ showDesk: true, showLedger: true }), 'desk');
  assert.equal(activeNavOf({ showStudio: true, showLedger: true }), 'studio');
});

// ── B. 助理子页目录与挂载方式 ──

await check('B1 助理子页目录恰为三个 Tab：助手目录（默认）/ 发布任务 / AI 建团', () => {
  const ids = ASSISTANT_TABS.map((x) => x.id);
  // 第五版（2026-10-27）：默认页从 publish 改为 directory（§5.2 目录是发现入口）
  assert.deepEqual(ids, ['directory', 'publish', 'aiTeam']);
  assert.ok(!ids.includes('teams'), '军团编制不应再是助理子 Tab（已迁入工作室）');
  // 定时任务已升回一级入口 ⇒ 不得再作为助理 Tab
  assert.ok(!ids.includes('scheduled'), '定时任务不应再是助理子 Tab');
});

await check('B2 每个 Tab 的文案键都存在且指向 assistant 模块（禁硬编码文案的第一道闸）', () => {
  for (const tab of ASSISTANT_TABS) {
    assert.ok(typeof tab.labelKey === 'string' && tab.labelKey.length > 0, `${tab.id} 缺 labelKey`);
    assert.match(tab.labelKey, /^assistant\./, `${tab.id} 的文案键不在 assistant 模块：${tab.labelKey}`);
  }
});

await check('B3 默认 Tab 是「助手目录」；isAssistantTab 对非法输入返回 false（防脏值进视图状态）', () => {
  assert.equal(DEFAULT_ASSISTANT_TAB, 'directory', `默认 Tab 应为 directory，实际 ${DEFAULT_ASSISTANT_TAB}`);
  assert.ok(isAssistantTab(DEFAULT_ASSISTANT_TAB), `默认 Tab 非法：${DEFAULT_ASSISTANT_TAB}`);
  for (const ok of ['directory', 'publish', 'aiTeam']) assert.ok(isAssistantTab(ok), ok);
  // 'teams' 现已**不是**助理 Tab（迁去工作室）⇒ 必须判为非法，防止脏值把编制塞回助理
  for (const bad of ['', null, undefined, 'teams', 'teams ', 'Teams', 'unknown', 'scheduled', 'complex', 0]) {
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
  // 助理页仍按 tab 挂载，且 onTab 走 navDispatch 单一来源（2026-10-27：page 态迁 route）
  assert.match(app, /<AssistantPage[^>]*tab=\{assistantTab\}[^>]*onTab=\{\(t\)\s*=>\s*navDispatch/, 'App 未按 tab 挂载 AssistantPage（且 onTab 应走 navDispatch 单一来源）');
  assert.ok(!/<TeamsPage\s*\/>/.test(app), 'App 仍直接挂载 <TeamsPage/>（应留在助理 Tab）');
});

await check('B6 AssistantPage 按 tab 条件挂载三个子视图，且不再有 scheduled/complex/teams 分支', () => {
  const page = stripComments(read('components/AssistantPage.tsx'));
  for (const pair of [
    ["tab === 'directory'", '<AssistantDirectory'],
    ["tab === 'publish'", '<PublishTaskPage'],
    ["tab === 'aiTeam'", '<AiTeamBuilder'],
  ]) {
    const i = page.indexOf(pair[0]);
    assert.ok(i > 0, `AssistantPage 缺分支 ${pair[0]}`);
    assert.ok(page.slice(i, i + 220).includes(pair[1]), `${pair[0]} 分支未挂载 ${pair[1]}`);
  }
  assert.ok(!page.includes("tab === 'scheduled'"), 'AssistantPage 不应再有 scheduled 分支（已升一级入口）');
  assert.ok(!page.includes('<ScheduledTasks'), 'AssistantPage 不应再挂 ScheduledTasks');
  // 第四版（2026-10-27）：编制迁入工作室 ⇒ AssistantPage 不得再挂 TeamsPage（否则双入口）
  assert.ok(!page.includes('<TeamsPage'), 'AssistantPage 仍挂 TeamsPage（编制已迁工作室，会形成双入口）');
});

// ── C. 工作室（Studio）子页目录与挂载方式 ──

await check('C1 工作室子页目录恰为四个 Tab：项目空间（默认）/ 编制 / 看板 / 工件', () => {
  const ids = STUDIO_TABS.map((x) => x.id);
  // 2026-10-27：补齐「看板」Tab（D-03：完整看板从 ArtifactPanel 内嵌提升为独立 Tab）
  assert.deepEqual(ids, ['space', 'roster', 'board', 'artifacts']);
  assert.equal(DEFAULT_STUDIO_TAB, 'space');
  for (const ok of ['space', 'roster', 'board', 'artifacts']) assert.ok(isStudioTab(ok), ok);
  for (const bad of ['', null, undefined, 'teams', 'unknown', 0]) {
    assert.equal(isStudioTab(bad), false, String(bad));
  }
});

await check('C4 项目上下文（IA-02）：StudioPage 不再写死 spaceId="default"，且按 tab 挂载看板', () => {
  // 用 stripComments：注释里会**复述**这次修掉的缺陷（"此前写死 spaceId="default""），
  // 不剥离注释的话，断言会命中注释而永远为真 —— 那正是「注释当成代码证据」的空转。
  const page = stripComments(read('components/StudioPage.tsx'));
  // 串项目缺陷的**形态判据**：写死 default 会让切项目后资产不变。
  // 断言锚定「没有把字面量 default 当空间键传下去」这一事实，而不是匹配某一行注释。
  assert.ok(!/spaceId\s*=\s*["']default["']/.test(page), 'StudioPage 仍写死 spaceId="default"（串项目）');
  // 空间键必须来自 props（projectPath），且无项目时不挂载任何数据面
  assert.match(page, /spaceId=\{projectPath\}/, 'StudioPage 未把 projectPath 作为空间键传给 TeamSpace');
  assert.match(page, /if\s*\(!projectPath\)/, 'StudioPage 缺少「无项目空态」分支（会静默读写 default）');
  assert.match(page, /<StudioBoard/, 'StudioPage 未挂载看板 Tab（D-03）');
});

await check('C5 看板数据源是真实项目级读取，不是前端伪造', () => {
  const board = read('components/StudioBoard.tsx');
  assert.match(board, /studioProjectRuns/, 'StudioBoard 未走 studio:projectRuns（真实数据源）');
  // 无 projectPath 时不得回落全局列表（§6.3）
  assert.match(board, /if\s*\(!projectPath\)/, 'StudioBoard 缺少无项目空态（会串到别的项目）');
  // 状态机完整：loading / error / empty 都要有出口（§4.5）
  for (const token of ["'loading'", "'error'", "'empty'"]) {
    assert.ok(board.includes(token), `StudioBoard 缺 ${token} 状态`);
  }
  // 主进程侧：项目级查询必须**在 SQL 里过滤后再 LIMIT**（先截断再过滤会漏本项目老 run）。
  // 过滤发生在 taskStore.listGroupsByProject；studio.js 只做通道与投影装配。
  const store = fs.readFileSync(path.join(ROOT, 'main', 'taskStore.js'), 'utf8');
  const q = store.slice(store.indexOf('listGroupsByProject'), store.indexOf('listGroupsByProject') + 900);
  assert.ok(q.length > 200, '未定位到 listGroupsByProject（片段为空 ⇒ 断言空过）');
  assert.match(q, /WHERE\s+project_path\s*=\s*\?/, 'listGroupsByProject 未按 project_path 过滤');
  assert.match(q, /LIMIT\s+\?/, 'listGroupsByProject 的 LIMIT 未参数化');
  // 渲染层传入的 projectPath 绝不能拼进 SQL
  const injected = q.slice(q.indexOf('SELECT'), q.indexOf('.all('));
  assert.ok(!/\$\{/.test(injected), '项目查询出现模板字符串拼接（SQL 注入面）');
  // 空 projectPath 必须短路返回，不得回落全局列表
  assert.match(q, /if\s*\(!p\)\s*return\s*\[\]/, 'listGroupsByProject 未对空 projectPath 短路');
});

await check('C2 工作室文案键双侧齐全，且指向 studio 模块（禁硬编码文案）', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/zh-CN/studio.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/en-US/studio.json'), 'utf8'));
  for (const tab of STUDIO_TABS) {
    assert.match(tab.labelKey, /^studio\./, `${tab.id} 的文案键不在 studio 模块：${tab.labelKey}`);
    const leaf = tab.labelKey.replace(/^studio\./, '');
    assert.equal(typeof zh[leaf], 'string', `zh-CN 缺 ${tab.labelKey}`);
    assert.equal(typeof en[leaf], 'string', `en-US 缺 ${tab.labelKey}`);
  }
});

await check('C3 编制由工作室挂载（助理已摘除）⇒ StudioPage 渲染 TeamsPage，且复用 ui/TabBar', () => {
  const page = read('components/StudioPage.tsx');
  assert.match(page, /<TeamsPage/, 'StudioPage 未挂载 TeamsPage（编制无落点）');
  assert.match(page, /<TabBar/, 'StudioPage 未使用 ui/TabBar 原语');
  assert.ok(!/<button/.test(stripComments(page)), 'StudioPage 仍含裸 <button>（应收敛到 ui/TabBar）');
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

// ── D. 助手目录（AST）：真实数据源 + 卡片点击不执行 ──

await check('D1 目录走真实数字员工通道，且只在选中时查 runtime（不做无界 N+1）', () => {
  const dir = stripComments(read('components/AssistantDirectory.tsx'));
  // 真实数据源：主进程 ecosystem:employees（内置 + 自定义合并），不是前端编造
  assert.match(dir, /ecosystemEmployees/, '目录未走 ecosystem:employees（真实目录）');
  assert.match(dir, /ecosystemEmployeeRuntime/, '目录未查运行条件');
  // N+1 判据：runtime 查询必须落在「选中项」的 effect 里，而不是对列表做 map 并发打
  assert.match(dir, /if\s*\(!selected\s*\|\|\s*runtime\[selected\.id\]\)/, 'runtime 未按选中项+缓存查询（会 N+1）');
  // 无数据字段就省略 ⇒ 不得出现评分/价格类编造字段
  for (const fake of ['score', 'rating', 'price', 'cost', 'salesCount']) {
    assert.ok(!new RegExp(`\\b${fake}\\b`).test(dir), `目录出现编造字段 ${fake}`);
  }
});

await check('D2 卡片点击只选中、不执行：执行出口有且只有「提交任务」', () => {
  const dir = stripComments(read('components/AssistantDirectory.tsx'));
  // 卡片 onClick 只能是 setSelectedId（选中），不能是任何派活/运行调用
  const cardBlock = dir.slice(dir.indexOf('filtered.map'), dir.indexOf('filtered.map') + 1200);
  assert.ok(cardBlock.length > 200, '未定位到目录卡片渲染段（片段为空 ⇒ 断言空过）');
  assert.match(cardBlock, /onClick=\{\(\) => setSelectedId\(e\.id\)\}/, '卡片 onClick 不是纯选中');
  assert.ok(!/onDispatch|agentRun|recruit/i.test(cardBlock), '卡片点击路径里出现了执行调用');
  // 全组件内 onDispatch 只能出现在 submit() 里（用户显式提交）
  const dispatchUses = dir.match(/onDispatch\?\.\(/g) || [];
  assert.equal(dispatchUses.length, 1, `onDispatch 调用点应为 1 处（提交按钮），实际 ${dispatchUses.length}`);
  // 空目标必须拦截：不允许「没填目标就提交」
  assert.match(dir, /if\s*\(!g\)\s*\{/, '提交前未校验任务目标');
});

await check('D3 运行条件不猜 ready：通道失败/员工缺失一律 unavailable，绝不显示可运行', () => {
  const dir = stripComments(read('components/AssistantDirectory.tsx'));
  // 成功分支才置 ready，其余两处（!ok、catch）都必须置 unavailable
  const ready = (dir.match(/state: 'ready'/g) || []).length;
  const unavail = (dir.match(/state: 'unavailable'/g) || []).length;
  assert.equal(ready, 1, `置 ready 的分支应恰好 1 处，实际 ${ready}`);
  assert.ok(unavail >= 2, `失败/异常分支都应置 unavailable，实际 ${unavail}`);
  // 不可用时应禁用提交按钮（不是「看着能点、点了才报错」）
  assert.match(dir, /disabled=\{dispatching \|\| rt === 'unavailable'\}/, 'runtime 不可用时未禁用提交');
});

console.log(`\nnav-state-dual-entry: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
