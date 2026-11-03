// P0-6 回归门禁：任务清单（todo_write）必须真的出现在界面上。
//
// 事故形状（2026-10-22 审查）：
//   `TodoPanel` 首行是 `if (!runId) return undefined;`（不传 runId 就不建立订阅），
//   而两处挂载点都写成 `<TodoPanel />` ⇒ 订阅从未建立、组件恒返回 null。
//   引擎侧的 onTodos → agentRunner emit('todos') 全部正常，**整条链路只差最后 10 个字符**。
//   这类「事件发了没人收」的缺陷人肉审查抓不住（代码看起来完全正常），所以由门禁兜。
//
// 本门禁守四层，缺一层就等于没接：
//   A. 事件生产端存在（agentRunner emit('todos')）
//   B. 事件消费端匹配（TodoPanel 只认 evt.type === 'todos'，且按 runId 过滤）
//   C. 视图层真的把在役 runId 传下去（且全仓不得再有裸 <TodoPanel /> 挂载）
//   D. runId 的来源可用（useAgentRun 以 state 暴露 activeRunId 并在 run 起止时维护）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todosDataSchema } from '../shared-ipc/contract.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const rendererSrc = (...p) => read('renderer', 'src', ...p);

const agentRunnerSrc = read('main', 'agentRunner.js');
const todoPanelSrc = rendererSrc('components', 'TodoPanel.jsx');
const chatAreaSrc = rendererSrc('components', 'ChatArea.jsx');
const welcomeSrc = rendererSrc('components', 'WelcomePage.tsx');
const hookSrc = rendererSrc('hooks', 'useAgentRun.ts');

// ── A. 生产端 ──
check('P0-6 主进程确实发出 todos 事件（onTodos → emit）',
  /onTodos:\s*\([^)]*\)\s*=>\s*emit\('todos'/.test(agentRunnerSrc));

// ── B. 消费端 ──
check('P0-6 TodoPanel 按 type 过滤 todos 事件', /evt\.type !== 'todos'/.test(todoPanelSrc));
check('P0-6 TodoPanel 保留 runId 守卫（不传就不订阅，防跨 run 串数据）',
  /if \(!runId\) return undefined;/.test(todoPanelSrc));
check('P0-6 TodoPanel 按 runId 过滤事件归属', /evt\.runId && runId && evt\.runId !== runId/.test(todoPanelSrc));

// ── C. 视图层接线 ──
// 只截挂载那一段（不是全文 indexOf：全文会命中注释里的示例而空过）
const mountIdx = chatAreaSrc.indexOf('<TodoPanel');
// 2026-11-03：挂载改成多行（threadId / running 两个新参数 + 说明注释），窗口从 220 放到 520，
// 否则 runId 那行落在窗口外 ⇒ 断言假红（不是接线坏了，是截取太短）。
const mountSnippet = mountIdx < 0 ? '' : chatAreaSrc.slice(mountIdx, mountIdx + 520);
check('P0-6 ChatArea 挂载片段截取成功（空片段会让下面断言空过）', mountSnippet.length > 40, `len=${mountSnippet.length}`);
check('P0-6 ChatArea 把在役 runId 传给 TodoPanel', /runId=\{activeRunId\}/.test(mountSnippet), mountSnippet.slice(0, 80).replace(/\s+/g, ' '));
check('P0-6 ChatArea 按会话 key 强制重挂（切会话清上一轮清单）', /key=\{thread\?\.id/.test(mountSnippet));
// 全仓不得再出现裸挂载：这正是当初的退化形态，加回去必须让门禁红
const bareMounts = [chatAreaSrc, welcomeSrc].filter((s) => /<TodoPanel\s*\/>/.test(s)).length;
check('P0-6 全仓无裸 <TodoPanel /> 挂载（防「加了挂载但忘了传参」复发）', bareMounts === 0, `裸挂载=${bareMounts}`);
check('P0-6 欢迎页（无会话态）不再挂 TaskPanel 空壳', !/<TodoPanel/.test(welcomeSrc));

// ── D. runId 来源 ──
check('P0-6 useAgentRun 以 state 暴露 activeRunId（ref 不触发重渲染）',
  /const \[activeRunId, setActiveRunId\] = useState/.test(hookSrc));
check('P0-6 run 启动时登记 activeRunId', /setActiveRunId\(runSeqLocal\)/.test(hookSrc));
check('P0-6 run 结束后清空 activeRunId（且仅当自己仍是活跃 run）',
  /activeRunIdRef\.current === rs\.runId\) \{ activeRunIdRef\.current = null; setActiveRunId\(null\); \}/.test(hookSrc));
check('P0-6 ChatArea 确实从 hook 解构 activeRunId', /compactContext, activeRunId[,\s}]/.test(chatAreaSrc));

// ── 事件形状对账：生产端的字段必须能被契约接受 ──
const sample = { todos: [{ content: '读代码', status: 'in_progress' }], doneCount: 0, total: 1 };
check('P0-6 todos 事件形状符合契约（UI 读的字段名与 schema 一致）', todosDataSchema.safeParse(sample).success);

// ── E. 任务组（2026-11-03 用户反馈：可折叠 / 完成项样式 / 右侧按组逆序汇总）──
check('E0 TodoPanel 折叠：有手动状态 + aria-expanded 的图标按钮（默认全部完成时收起）',
  /manualOpen/.test(todoPanelSrc) && /ariaExpanded=\{open\}/.test(todoPanelSrc) && /const open = manualOpen \?\? !allDone/.test(todoPanelSrc));
check('E0 完成项样式：浅灰 + 斜体 + 贯穿删除线',
  /fontStyle: done \? 'italic' : 'normal'/.test(todoPanelSrc) && /textDecoration: done \? 'line-through' : 'none'/.test(todoPanelSrc));
check('E0 todos 事件同时落会话级快照（右侧任务摘要的数据源）',
  /recordTodoGroup\(/.test(todoPanelSrc) && /running: runningRef\.current/.test(todoPanelSrc));
check('E0a 停止后不再转圈：左侧按 running 叠加、右侧按组活性叠加', 
  /const active = running && t\.status === 'in_progress'/.test(todoPanelSrc)
  && /const spinning = live && status === 'in_progress'/.test(rendererSrc('components', 'TaskSummaryPanel.tsx')));
check('E0b run 结束后补一次收尾快照（否则右侧任务组永远停在「进行中」）',
  /if \(running\) return;/.test(todoPanelSrc) && /running: false/.test(todoPanelSrc));
check('E0 ChatArea 把 threadId 与运行态传给 TodoPanel',
  /threadId=\{thread\?\.id != null \? String\(thread\.id\) : null\}/.test(mountSnippet) && /running=\{loading\}/.test(mountSnippet));

// 行为断言：快照存储的排序 / 合并 / 上限 / 状态派生（纯函数 + localStorage，Node 侧可直跑）
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const tg = await import('../renderer/src/lib/todoGroups.ts');

  check('E1 状态派生：全完成=done；有失败=error；运行中有未完成=running；非运行有未完成=partial',
    tg.deriveGroupState([{ content: 'a', status: 'completed' }], 1, 1, true) === 'done'
    && tg.deriveGroupState([{ content: 'a', status: 'error' }], 0, 1, true) === 'error'
    && tg.deriveGroupState([{ content: 'a', status: 'pending' }], 0, 1, true) === 'running'
    && tg.deriveGroupState([{ content: 'a', status: 'pending' }], 0, 1, false) === 'partial');

  tg.recordTodoGroup('t1', 'run-old', [{ content: '旧任务', status: 'completed' }], { at: 1000 });
  tg.recordTodoGroup('t1', 'run-new', [{ content: '新任务', status: 'pending' }, { content: '新任务2', status: 'completed' }], { at: 2000 });
  const list = tg.listTodoGroups('t1');
  check('E2 按时间逆序（最新在前）', list.length === 2 && list[0].runId === 'run-new' && list[1].runId === 'run-old',
    JSON.stringify(list.map((g) => g.runId)));

  tg.recordTodoGroup('t1', 'run-new', [{ content: '新任务', status: 'completed' }], { at: 3000 });
  const after = tg.listTodoGroups('t1');
  check('E3 同一 run 合并为一组并覆盖为最新快照',
    after.length === 2 && after[0].runId === 'run-new' && after[0].total === 1 && after[0].doneCount === 1 && after[0].state === 'done');

  let notified = 0;
  const off = tg.subscribeTodoGroups((tid) => { if (tid === 't1') notified += 1; });
  tg.recordTodoGroup('t1', 'run-third', [{ content: '第三批', status: 'pending' }], { at: 4000 });
  off();
  tg.recordTodoGroup('t1', 'run-fourth', [{ content: '第四批', status: 'pending' }], { at: 5000 });
  check('E4 订阅收到写入通知，退订后不再收到', notified === 1, `notified=${notified}`);

  for (let i = 0; i < 30; i++) tg.recordTodoGroup('t1', `bulk-${i}`, [{ content: `批量 ${i}`, status: 'pending' }], { at: 10000 + i });
  check('E5 每组上限 20（长会话不撑爆 localStorage）', tg.listTodoGroups('t1').length === 20, String(tg.listTodoGroups('t1').length));

  const before = tg.listTodoGroups('t1').length;
  tg.recordTodoGroup('t1', 'empty-one', [], { at: 99999 });
  check('E6 空清单不产生组（清空 todos 不留空卡片）', tg.listTodoGroups('t1').length === before);

  tg.clearTodoGroups('t1');
  check('E7 删会话时清理该会话的任务组', tg.listTodoGroups('t1').length === 0);

  // ── E12 续跑去重（2026-11-03 用户实测：#1 与 #2 同样的 6 项、差两分钟）──
  // 同一任务被打断后继续会拿到新 runId：内容一模一样却多一张卡片 = 「任务重复了」。
  const list1 = [{ content: '第一部', status: 'pending' }, { content: '第二部', status: 'pending' }];
  const list2 = [{ content: '第一部', status: 'in_progress' }, { content: '第二部', status: 'pending' }];
  tg.recordTodoGroup('t2', 'run-A', list1, { at: 1000 });
  tg.recordTodoGroup('t2', 'run-B', list1, { at: 2000 }); // 同内容 + 上一组未完成 ⇒ 合并
  const merged = tg.listTodoGroups('t2');
  check('E12 同内容且上一组未完成 ⇒ 合并成一组（续跑不再多一张卡片）',
    merged.length === 1 && merged[0].runId === 'run-B' && merged[0].todos.length === 2,
    JSON.stringify(merged.map((g) => g.runId)));

  tg.recordTodoGroup('t2', 'run-B', list2, { at: 3000 }); // 同 runId 继续更新
  check('E13 合并后同 runId 的后续更新仍能命中该组',
    tg.listTodoGroups('t2').length === 1 && tg.listTodoGroups('t2')[0].doneCount === 0);

  // 已完成的组不合并：用户可能真的想再跑一遍同样的清单
  const done = [{ content: '第一部', status: 'completed' }, { content: '第二部', status: 'completed' }];
  tg.recordTodoGroup('t3', 'run-D', done, { at: 1000, running: false });
  tg.recordTodoGroup('t3', 'run-E', done, { at: 2000, running: true });
  check('E14 上一组已完成 ⇒ 不合并（保留历史，用户可能真要再跑一遍）',
    tg.listTodoGroups('t3').length === 2, JSON.stringify(tg.listTodoGroups('t3').map((g) => g.runId)));

  // 内容不同 ⇒ 一定是两组（这不是"同一任务"）
  tg.recordTodoGroup('t4', 'run-F', [{ content: 'A 任务', status: 'pending' }], { at: 1000 });
  tg.recordTodoGroup('t4', 'run-G', [{ content: 'B 任务', status: 'pending' }], { at: 2000 });
  check('E15 内容不同 ⇒ 各自成组（不误合并）', tg.listTodoGroups('t4').length === 2);
  // 存量重复（旧版本按 runId 建组留下的）：展示侧也要折叠，不能只靠写入时合并
  {
    const store = globalThis.localStorage;
    const legacy = [
      { runId: 'old-2', threadId: 't5', startedAt: 2000, updatedAt: 2000, todos: [{ content: 'X', status: 'pending' }], state: 'partial' },
      { runId: 'old-1', threadId: 't5', startedAt: 1000, updatedAt: 1000, todos: [{ content: 'X', status: 'pending' }], state: 'partial' },
    ];
    store.setItem('mj_todo_groups_t5', JSON.stringify(legacy));
    check('E16 存量重复组在展示侧折叠成最新一条（不动存储，不清用户数据）',
      tg.listTodoGroups('t5').length === 1 && tg.listTodoGroups('t5')[0].runId === 'old-2',
      JSON.stringify(tg.listTodoGroups('t5').map((g) => g.runId)));
    // 已完成的两组不折叠（那是真实的两次执行历史）
    store.setItem('mj_todo_groups_t5', JSON.stringify([
      { runId: 'd-2', threadId: 't5', startedAt: 2000, updatedAt: 2000, todos: [{ content: 'X', status: 'completed' }], state: 'done' },
      { runId: 'd-1', threadId: 't5', startedAt: 1000, updatedAt: 1000, todos: [{ content: 'X', status: 'completed' }], state: 'done' },
    ]));
    check('E17 已完成的历史组不折叠（保留真实执行记录）', tg.listTodoGroups('t5').length === 2);
    tg.clearTodoGroups('t5');
  }

  tg.clearTodoGroups('t2'); tg.clearTodoGroups('t3'); tg.clearTodoGroups('t4');
}

// 右侧面板：订阅 + 逆序 + 可折叠 + 空态合并（结构事实）
{
  const summarySrc = rendererSrc('components', 'TaskSummaryPanel.tsx');
  check('E8 任务摘要读会话任务组并订阅变化', /subscribeTodoGroups/.test(summarySrc) && /listTodoGroups/.test(summarySrc));
  check('E9 组可折叠（aria-expanded + 默认最新一组展开）',
    /ariaExpanded=\{open\}/.test(summarySrc) && /openMap\[g\.runId\] \?\? i === 0/.test(summarySrc));
  check('E10 组内完成项与对话内同款样式（斜体 + 删除线）',
    /italic line-through/.test(summarySrc));
  check('E11 空态不再是「暂无任务组 + 暂无子任务」两段堆叠',
    !/noSubtask'\}\)\}<\/div>/.test(summarySrc) && /totalGroups === 0/.test(summarySrc));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
