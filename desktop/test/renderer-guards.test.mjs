// 渲染层可靠性门禁（批次 2「界面止血」）：锁住四条修复，防重构静默回退。
//
// 为什么是源码级断言而不是渲染测试：本仓库没有 jsdom / testing-library 环境
// （见 ui-conventions.test.js 与 nav-state-dual-entry.test.mjs 的同款说明），
// 渲染层的既有门禁范式就是「剥离注释后做结构性断言」。
//
// 断言的选型遵循 nav-state 套件的纪律：只锁**标识符与结构性事实**（sendingRef /
// loadSeqRef / componentDidUpdate / ErrorBoundary 装配位置），不锁散文与格式。
// 因此注释怎么改写都不该影响本套件，但把实现删掉必须变红。
//
// 本套件自己也要能被证伪（逐条变异验证过，见 docs 交付报告）：
//   删 sendingRef 赋值 → G5 红；删 loadSeqRef 判定 → G4 红；去掉某个页面的
//   ErrorBoundary → G2 红；把 String(task?.prompt) 改回 task.prompt.slice → G1 红。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
// 注释剥离（与 ui-conventions / nav-state 同一口径）：注释里提到标识符不该算数，
// 否则「注释里写了 sendingRef」就会让断言空过 —— 那是本套件最需要防的假绿。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); }
};

// ── G1（B-P0-2）定时任务列表不得在渲染期裸取 prompt ───────────────────────────
// 事故形态：任务缺 prompt（模型侧 scheduledCreate 写入 / 用户手改 scheduled.json）
// ⇒ task.prompt.slice() 抛 TypeError ⇒ 当时全应用只有根边界，整屏白屏（含正在跑的会话）。
check('G1 定时任务渲染期不裸取 prompt，且入口做了归一', () => {
  const src = stripComments(read('components/ScheduledTasks.jsx'));
  const naked = /\btask\s*\.\s*prompt\s*\.\s*(slice|substring|substr|trim|toLowerCase)/;
  assert.ok(!naked.test(src), '仍在渲染期裸取 task.prompt.*（缺字段即抛 TypeError）');
  assert.ok(/String\(\s*task\s*\?\.\s*prompt\s*\|\|\s*''\s*\)/.test(src),
    '取值处未用 String(task?.prompt || "") 守卫');
  assert.ok(/normalizeTask/.test(src), '缺少 normalizeTask 入口归一（渲染处兜底只能算第二道）');
});

// ── G2（B-P0-1）每个路由页面必须有各自的局部 ErrorBoundary ─────────────────────
// 数点位数的纪律：不能只断言「App.jsx 里出现过 ErrorBoundary」——那会在
// 只给其中一个页面包壳时通过。逐个页面检查它**自己的**装配段。
check('G2 每个路由页面各自被局部 ErrorBoundary 包裹（数点位，不是查存在）', () => {
  const app = stripComments(read('App.jsx'));
  // 不含 RightPane：它原本就有 compact 边界（P1-18），这里只锁本轮新增的页面区
  const pages = ['Sidebar', 'Dashboard', 'AssistantPage', 'ScheduledTasks',
    'StudioPage', 'LedgerPage', 'DeskPage', 'ChatArea'];
  const missing = [];
  for (const name of pages) {
    const i = app.indexOf(`<${name}`);
    if (i < 0) { missing.push(`${name}(未挂载)`); continue; }
    // 只回看本装配段（同一 JSX 表达式内的开标签），窗口放 320 字符以容纳长 props 块
    if (!/<ErrorBoundary/.test(app.slice(Math.max(0, i - 320), i))) missing.push(name);
  }
  assert.deepEqual(missing, [], `以下页面没有被局部边界包裹（一处渲染异常即整屏白屏）：${missing.join(', ')}`);
});

// ── G3（B-P0-1 配套）边界必须能自动复位 ───────────────────────────────────────
// 否则错误状态会粘住：用户切到正常页面后仍看到错误界面，只能手点「重试」。
check('G3 ErrorBoundary 在 children 变化时自动复位', () => {
  const src = stripComments(read('components/ErrorBoundary.jsx'));
  assert.ok(/componentDidUpdate\s*\(/.test(src), '缺 componentDidUpdate（错误状态会粘住不恢复）');
  assert.ok(/this\.setState\(\s*\{\s*error:\s*null\s*\}/.test(src), '复位逻辑缺失');
});

// ── G4（B-P0-3）diff 面板必须有请求序号 ───────────────────────────────────────
// 事故形态：切项目后旧请求后到，覆盖新项目的 diff 内容；此时点「全部放弃」
// 会对**上一个项目**的路径执行 gitDiscardFiles。
check('G4 diff 面板按请求序号丢弃迟到回包（含 finally 分支）', () => {
  const src = stripComments(read('components/DiffReviewPanel.jsx'));
  assert.ok(/loadSeqRef/.test(src), '缺少 loadSeqRef 请求序号');
  assert.ok(/\+\+\s*loadSeqRef\.current/.test(src), '请求序号未自增');
  // finally 也必须判 seq：否则旧请求会把新请求的 loading 提前压掉（表现为闪一下空白）。
  // 两种写法都接受：`seq === ...` 时才 setLoading(false)，或 `seq !== ...` 时提前 return。
  assert.ok(/finally\s*\{[\s\S]{0,160}seq\s*[!=]==\s*loadSeqRef\.current[\s\S]{0,80}setLoading/.test(src),
    'finally 分支未按 seq 判定 loading');
});

// ── G5（B-P0-4）发送必须有同步闩锁 ────────────────────────────────────────────
// 事故形态：setLoading(true) 在 await createThread 之后才执行，连按两次 Enter
// 两次调用都落在 loading=false 窗口内 ⇒ 两个会话 + 两次模型调用（双花 token）。
check('G5 发送路径有同步闩锁，且在 finally 释放（覆盖所有 return 分支）', () => {
  const src = stripComments(read('hooks/useAgentRun.ts'));
  assert.ok(/sendingRef/.test(src), '缺少 sendingRef 同步闩锁');
  assert.ok(/sendingRef\.current\s*=\s*true/.test(src), '闩锁未置位');
  assert.ok(/\.finally\(\s*\(\)\s*=>\s*sendingRef\.current\s*=\s*false\s*\)/.test(src),
    '闩锁未在 .finally 释放（提前 return 会永久锁死发送）');
  // 判据必须在 doSend 之前：闩锁包住的调用不得是 doSend 自身之外的旁路
  assert.ok(/doSend\s*\(/.test(src), 'send 未委托给 doSend（闩锁包裹关系断裂）');
});

console.log(`\nrenderer-guards: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
