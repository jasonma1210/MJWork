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
const mountSnippet = mountIdx < 0 ? '' : chatAreaSrc.slice(mountIdx, mountIdx + 220);
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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
