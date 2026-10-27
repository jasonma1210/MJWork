// 导航路由单一事实来源（navRoute.ts）门禁
//
// 守护设计文档 §4.3「用单一 page 字段替代布尔叠加」的不可变式：
//   1. 切主页面 ⇒ 清空 overlay，tab 归位到新页面默认值（不串台）；
//   2. 开 overlay ⇒ 底层 page 保留（§4.4）；
//   3. 关 overlay ⇒ page 不变；
//   4. reset ⇒ 回到 INITIAL_ROUTE。
// 另验：page 集合含 ledger、不含 teams（teams 已迁 Studio）；非法 page 被忽略；
//       routeToLegacyView / legacyViewToRoute 与布尔 view 双向一致（迁移期适配器）。
import assert from 'node:assert/strict';

const {
  INITIAL_ROUTE, NAV_PAGES, HIGHLIGHTABLE_PAGES, isNavPage, isThreadRoute,
  navReducer, routeToLegacyView, legacyViewToRoute,
} = await import('../renderer/src/lib/navRoute.ts');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); process.exitCode = 1; }
};

check('R1 page 集合含 ledger/desk/studio/scheduled/assistant，且不含 teams', () => {
  for (const p of ['ledger', 'desk', 'studio', 'scheduled', 'assistant', 'dashboard', 'thread']) {
    assert.ok(NAV_PAGES.includes(p), `NAV_PAGES 应含 ${p}`);
  }
  assert.ok(!NAV_PAGES.includes('teams'), 'teams 不应是独立 page（已迁入 Studio）');
  assert.ok(NAV_PAGES.includes('ledger'), '2026-10-27 新增的账本必须是一级 page');
  // 2026-10-27：'new'（新建任务落地页）已下线 —— 它的输入框与工作台「接一单」是同一个
  // 输入框出现在两处。落地页改为工作台，新会话直接建真实会话并进对话页。
  assert.ok(!NAV_PAGES.includes('new'), 'new 已下线，不应再是合法 page');
});

check('R2 isNavPage：合法 page 为 true，teams/未知为 false', () => {
  assert.equal(isNavPage('ledger'), true);
  assert.equal(isNavPage('teams'), false, 'teams 不是 page');
  assert.equal(isNavPage('unknown'), false);
  assert.equal(isNavPage(''), false);
});

check('R3 可点亮页面集合含 ledger（侧栏高亮用）', () => {
  assert.ok(HIGHLIGHTABLE_PAGES.includes('ledger'), '账本应可点亮一级导航');
  assert.ok(HIGHLIGHTABLE_PAGES.includes('studio'));
});

check('R4 切主页面 ⇒ 清空 overlay 且与新页面 tab 归位', () => {
  let s = { ...INITIAL_ROUTE, overlay: 'ecosystem', overlayPayload: { x: 1 } };
  s = navReducer(s, { type: 'page', page: 'studio', tab: 'board' });
  assert.equal(s.page, 'studio', 'page 应切到 studio');
  assert.equal(s.overlay, 'none', '切页面必须清空 overlay');
  assert.equal(s.overlayPayload, null, 'overlay payload 一并清空');
  assert.equal(s.studioTab, 'board', '显式给的 studio tab 应用上');
  assert.equal(s.assistantTab, 'directory', '未指定助理 tab ⇒ 回落默认（directory），不串台');
});

check('R5 非法 page 被忽略（外部输入不可信）', () => {
  const before = { ...INITIAL_ROUTE };
  const after = navReducer(before, { type: 'page', page: 'teams' });
  assert.deepEqual(after, before, '非法 page 不应改变状态');
});

check('R6 开 overlay 保留底层 page（§4.4）', () => {
  let s = navReducer(INITIAL_ROUTE, { type: 'page', page: 'ledger' });
  s = navReducer(s, { type: 'overlay', overlay: 'ecosystem' });
  assert.equal(s.page, 'ledger', '开生态弹层不应改变底层 page');
  assert.equal(s.overlay, 'ecosystem');
});

check('R7 关 overlay 保留 page', () => {
  let s = navReducer(INITIAL_ROUTE, { type: 'page', page: 'assistant', tab: 'aiTeam' });
  s = navReducer(s, { type: 'overlay', overlay: 'settings' });
  s = navReducer(s, { type: 'closeOverlay' });
  assert.equal(s.page, 'assistant', '关弹层后回到原 page');
  assert.equal(s.overlay, 'none');
  assert.equal(s.assistantTab, 'aiTeam', '关弹层不影响已选 tab');
});

check('R8 reset ⇒ INITIAL_ROUTE', () => {
  let s = navReducer(INITIAL_ROUTE, { type: 'page', page: 'studio', tab: 'roster' });
  s = navReducer(s, { type: 'overlay', overlay: 'ecosystem' });
  s = navReducer(s, { type: 'reset' });
  assert.deepEqual(s, INITIAL_ROUTE, 'reset 必须回到初始路由（含清空 overlay）');
});

check('R9 isThreadRoute：只有 thread 是对话态（new 已下线）', () => {
  assert.equal(isThreadRoute({ ...INITIAL_ROUTE, page: 'thread' }), true);
  assert.equal(isThreadRoute({ ...INITIAL_ROUTE, page: 'ledger' }), false);
  assert.equal(isThreadRoute({ ...INITIAL_ROUTE, page: 'desk' }), false, '工作台是独立一屏，不是对话态');
  assert.equal(INITIAL_ROUTE.page, 'desk', '落地页必须是工作台');
});

check('R10 routeToLegacyView：page=ledger ⇒ showLedger=true，其余 page 互斥', () => {
  const v = routeToLegacyView({ ...INITIAL_ROUTE, page: 'ledger' });
  assert.equal(v.showLedger, true, '账本页应点亮 showLedger');
  assert.equal(v.showStudio, false);
  assert.equal(v.showAssistant, false);
  assert.equal(v.showTeams, false, 'teams 恒为 false（已迁 Studio）');
  const desk = routeToLegacyView({ ...INITIAL_ROUTE, page: 'desk' });
  assert.equal(desk.showDesk, true);
});

check('R11 legacyViewToRoute：固化顺序 desk>studio>ledger>scheduled>assistant', () => {
  // 固化顺序见 navState.ts 文件头；ledger 高于 scheduled/assistant，但低于 desk/studio
  assert.equal(legacyViewToRoute({ showLedger: true, showScheduled: true }).page, 'ledger', 'ledger 高于 scheduled');
  assert.equal(legacyViewToRoute({ showLedger: true, showAssistant: true }).page, 'ledger', 'ledger 高于 assistant');
  assert.equal(legacyViewToRoute({ showStudio: true, showLedger: true }).page, 'studio', 'studio 高于 ledger');
  assert.equal(legacyViewToRoute({ showDesk: true, showStudio: true, showLedger: true }).page, 'desk', 'desk 最高');
});

check('R12 切页面时 assistantTab 不串入 studio（不变式 1 的 tab 隔离）', () => {
  let s = navReducer(INITIAL_ROUTE, { type: 'page', page: 'assistant', tab: 'aiTeam' });
  s = navReducer(s, { type: 'page', page: 'studio' }); // 不给 tab
  assert.equal(s.assistantTab, 'aiTeam', '助理 tab 值保留在内存（不污染 studio）');
  assert.equal(s.studioTab, 'space', '进入 studio 时 studioTab 回落默认 space');
});

console.log(`\nnav-route-single-page: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
