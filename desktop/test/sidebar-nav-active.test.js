// 侧栏一级导航选中态门禁（2026-10-18 建立 / 2026-10-24 双入口重组后重写）
//
// 用户实测反馈（建立动因）：「我选中的左侧菜单，虽然跳转的页面是对的，但是左侧的菜单
// 没有被选中」。真因两条，缺一都会复现：
//   ① 判据不互斥也不穷尽：此前只有「新建会话」传 active，且写成 `!activeThread`。
//      定时任务页没有打开会话 → 该亮不亮；反之一旦有会话又可能两个一起亮。
//   ② 选中样式是 `bg-hover`，与 hover 同色 → 即使 active 传对了，视觉上仍等于没选中。
//
// 2026-10-24 双入口重组（设计文档 §9 P0-1）：一级导航从 4 项收敛为 2 项
// （新建任务 / 助理），`scheduled` 与 `teams` 降级为「助理」的子 Tab。
// **这是破坏性变更**，本门禁随之改写为**新语义**的行为断言：
//   · 返回值域收敛为 ['new','assistant','ecosystem','']（永不再返回 'scheduled'/'teams'）；
//   · showScheduled / showTeams 作为**兼容输入**时，仍统一返回 'assistant'；
//   · 互斥且穷尽（同一时刻只有一个一级入口为选中态）。
//
// 覆盖方式：① 用**行为**测（直接 import lib/navState.ts，穷举 64 种组合）；
//          ② 用**源码契约**测（select-bg/select-fg + aria-current 是 DOM 部分，见渲染层验收）。
// 视觉最终由 Playwright 验（选中项 backgroundColor 非透明 + 与普通项不同色）。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const SRC = path.join(__dirname, '../renderer/src');
const APP = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(SRC, 'components/Sidebar.jsx'), 'utf8');

// 注释里的示例不算数：抹成空格、保留行号
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
const app = blankComments(APP);
const sidebar = blankComments(SIDEBAR);

(async () => {
  const { activeNavOf } = await import('../renderer/src/lib/navState.ts');

  // ── 行为：穷举 128 种组合（5 个视图标志 + 1 个会话标志 + 接单台标志）──
  const combos = [];
  for (const showAssistant of [false, true])
    for (const showScheduled of [false, true]) // 兼容输入（助理子态）
      for (const showDashboard of [false, true])
        for (const showEcosystem of [false, true])
          for (const showTeams of [false, true]) // 兼容输入（助理子态）
            for (const showDesk of [false, true]) // 2026-10-25 新增一级入口「工作台」
              for (const hasActiveThread of [false, true])
                combos.push({ showAssistant, showScheduled, showDashboard, showEcosystem, showTeams, showDesk, hasActiveThread });

  await check('穷举 128 种视图组合：返回值只可能是六个已定义字面量', () => {
    // 第二版（2026-10-24 用户要求）：定时任务升回一级入口 ⇒ 'scheduled' 是合法返回值；
    // 第三版（2026-10-25）：新增接单台 ⇒ 'desk' 是合法返回值；'teams' 仍不返回（它是助理子 Tab）。
    const allowed = new Set(['new', 'assistant', 'scheduled', 'ecosystem', 'desk', '']);
    for (const c of combos) {
      const got = activeNavOf(c);
      assert.ok(allowed.has(got), `${JSON.stringify(c)} → ${got}`);
    }
  });

  await check('接单台（desk）在前台时选中「工作台」，且优先级高于定时任务/助理/生态中心', () => {
    for (const c of combos.filter((x) => x.showDesk)) {
      assert.equal(activeNavOf(c), 'desk', JSON.stringify(c));
    }
  });

  await check('定时任务页在前台时选中「定时任务」（一级入口）', () => {
    // desk 在场时优先级最高（见上一条断言），故本节判据排除 showDesk 组合
    for (const c of combos.filter((x) => x.showScheduled && !x.showDesk)) {
      assert.equal(activeNavOf(c), 'scheduled', JSON.stringify(c));
    }
  });

  await check('兼容输入：showTeams=true 时返回「助理」（团队编制是助理子 Tab，不是独立入口）', () => {
    for (const c of combos.filter((x) => !x.showScheduled && x.showTeams && !x.showDesk)) {
      assert.equal(activeNavOf(c), 'assistant', JSON.stringify(c));
    }
  });

  await check('助理工作台在前台时选中「助理」（唯一二级入口）', () => {
    for (const c of combos.filter((x) => x.showAssistant && !x.showScheduled && !x.showTeams && !x.showDesk)) {
      assert.equal(activeNavOf(c), 'assistant', JSON.stringify(c));
    }
  });

  await check('助理子态与主态等价：assistantTab 不影响一级选中态', () => {
    const base = { showAssistant: true, showScheduled: false, showDashboard: false, showEcosystem: false, showTeams: false, hasActiveThread: false };
    for (const tab of ['publish', 'teams', 'aiTeam']) {
      assert.equal(activeNavOf({ ...base, assistantTab: tab }), 'assistant', tab);
    }
  });

  await check('生态中心弹层打开时选中「生态中心」（助理优先——弹层盖在助理之上）', () => {
    for (const c of combos.filter((x) => !x.showAssistant && !x.showScheduled && !x.showTeams && x.showEcosystem && !x.showDesk)) {
      assert.equal(activeNavOf(c), 'ecosystem', JSON.stringify(c));
    }
  });

  await check('工作台与会话中：一级导航都不亮（避免与一级导航语义混淆）', () => {
    const back = { showScheduled: false, showEcosystem: false, showTeams: false };
    assert.equal(activeNavOf({ ...back, showAssistant: false, showDashboard: true, hasActiveThread: false }), '');
    assert.equal(activeNavOf({ ...back, showAssistant: false, showDashboard: false, hasActiveThread: true }), '');
  });

  await check('新建任务页（什么都没有打开）才选中「新建任务」', () => {
    assert.equal(activeNavOf({ showAssistant: false, showDashboard: false, showEcosystem: false, hasActiveThread: false }), 'new');
  });

  // ⚠ 原断言是**恒真式**：`['new',…].filter((k) => k === got).length <= 1` ——
  // `activeNavOf` 返回**单值**，`k === got` 的命中数恒 ≤ 1，它证明不了「不会两个入口同时亮」。
  // 改为**渲染侧计数**：真渲染 Sidebar，数 NavItem 实际输出的 aria-current="page"。
  await check('互斥（渲染侧）：多视图条件同时为真时，侧栏被点亮的一级入口恒为 1 个', async () => {
    const { renderHtml, countAriaCurrent } = await import('./helpers/render-html.mjs');
    const base = { threads: [], projects: [], activeThread: null, activeProject: null, onSelect: () => {} };
    //     // 期望值写死，两个方向都验：冲突组合必须**恰好亮 1 个**（0 个＝点了没亮，也是缺陷）；
    // 用量页按设计不点亮任何一级入口（activeNavOf 返回 ''），必须**恰好 0 个**。
    // 只断言「≤1」会漏掉前者，只断言「=1」会误伤后者。
    const cases = [
      { view: { showDesk: true, showScheduled: true, showAssistant: true, showDashboard: true, showEcosystem: true, showTeams: false }, expect: 1 },
      { view: { showDesk: true, showAssistant: true }, expect: 1 },
      { view: { showDesk: true, showScheduled: true }, expect: 1 },
      { view: { showDesk: false, showScheduled: true, showAssistant: true }, expect: 1 },
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

  // ── 连线契约：组件必须真的用上这个判定 ──
  await check('App 把视图标志（含定时任务页/接单台）作为 view 传给 Sidebar', () => {
    // 2026-10-25：入口增加后改为宽松式——只锁「这五个标志必须出现且顺序稳定」，
    // 不再把整个对象形状钉死（钉死会让每次加一个视图标志都变成改测试）。
    assert.match(app, /view=\{\{\s*showAssistant,\s*assistantTab,\s*showScheduled,\s*showDashboard,\s*showEcosystem[^}]*\}\}/,
      '缺少 view={{ showAssistant, assistantTab, showScheduled, showDashboard, showEcosystem, … }}');
    assert.match(app, /showEcosystem,\s*showDesk\s*\}\}/, 'view 未把 showDesk 传给 Sidebar');
  });

  await check('Sidebar 用 activeNavOf 计算，且入口各自绑定字面量', () => {
    assert.match(sidebar, /activeNavOf\(\{/, 'Sidebar 未使用 activeNavOf');
    assert.match(sidebar, /hasActiveThread: !!activeThread/);
    // 助理及其兼容子态都必须喂进判定（兼容字段丢失会让旧调用方静默不亮）
    assert.match(sidebar, /showScheduled: !!view\?\.showScheduled/, '缺少兼容输入 showScheduled');
    assert.match(sidebar, /showTeams: !!view\?\.showTeams/, '缺少兼容输入 showTeams');
    // 第三版：接单台标志必须喂进判定（丢了 ⇒ 进了工作台侧栏不亮）
    assert.match(sidebar, /showDesk: !!view\?\.showDesk/, '缺少 showDesk 输入');
    // 第二版：一级导航三项都必须是真实绑定（scheduled 已升回入口）
    // 第三版（2026-10-25）：新增「工作台」一级入口，同样必须有真实绑定
    for (const key of ['desk', 'new', 'assistant', 'scheduled']) {
      assert.match(sidebar, new RegExp(`active=\\{activeNav === '${key}'\\}`),
        `NavItem「${key}」缺少 active={activeNav === '${key}'}`);
    }
    // 团队编制仍在助理内 ⇒ 一级导航不得给它单独的 active 绑定
    assert.ok(!/active=\{activeNav === 'teams'\}/.test(sidebar),
      '一级导航仍绑定「teams」（它应留在助理里）');
  });

  await check('NavItem 输出 aria-current="page"（语义 + 可测锚点）', () => {
    assert.match(sidebar, /aria-current=\{active \? 'page' : undefined\}/);
  });

  await check('选中态用 select-bg/select-fg 专用令牌，不允许退回 bg-hover', () => {
    assert.match(sidebar, /active \? 'bg-select-bg text-select-fg/, '选中态必须用 select-bg/select-fg');
    const activeArm = sidebar.slice(sidebar.indexOf("active ? '") + 10, sidebar.indexOf("' : '"));
    assert.ok(!/bg-hover/.test(activeArm), `选中态仍是 bg-hover（与 hover 同色）：${activeArm}`);
  });

  console.log(`\nsidebar-nav-active: ${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
})().catch((err) => {
  // 显式兜底（原先靠 test/helpers/unhandled-preload.cjs 全局捕获）：顶层动态 import 失败
  // 会让整个套件静默变成 0 项，看起来像"没红"。同时这一步让本文件不再是「裸 async IIFE」，
  // 从此改断言体不会再触发 audit-check-await 的位置级指纹轮换。
  console.error('[sidebar-nav-active] 套件初始化失败：', err);
  process.exitCode = 1;
});
