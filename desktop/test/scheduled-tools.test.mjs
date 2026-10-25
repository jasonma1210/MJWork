// 定时任务 / Worker 工具集与结果渲染的回归门禁。
//
// 事故（2026-10-17）：定时任务跑「搜索最新 AI 新闻」，模型回「web_search 工具不存在」。
// 根因不是模型撒谎，是宿主没把 Web 工具注入进 scheduledToolHandlers()——
// Worker 路径早已补上，定时任务这条路径漏了，且**两处各维护一份清单**，无法互相校验。
// 现在两条路径共用 main/scheduledTools.js，本文件守住三件事：
//   ① 清单里必须有出网能力（webSearch / webFetch）；
//   ② 清单不得缺核心读写/git/mcp/pr 工具；
//   ③ 结果只渲染一处，且「立即运行」如实透传成功/失败（不再硬编码成功）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

// audit 落盘要 app.getPath()：纯 node 下装最小 electron stub，避免「本地审计落盘失败」刷屏。
// 本文件不验审计写入内容，只要求审计调用不抛。
{
  const Module = require('node:module');
  const electronPath = require.resolve('electron');
  const stub = new Module(electronPath, null);
  stub.filename = electronPath;
  stub.loaded = true;
  stub.exports = {
    app: { getPath: () => '/tmp/mjcode-scheduled-tools-test' },
    ipcMain: { handle() {}, on() {}, once() {} },
  };
  require.cache[electronPath] = stub;
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

/** 从 startIdx 处的开括号起，返回配对闭括号的下标（跳过字符串/模板串/注释里的括号）。 */
function matchBracket(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === quote) break; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const { scheduledToolHandlers } = require(path.join(ROOT, 'main', 'scheduledTools.js'));

// 用假实现填充 deps：本文件只验「清单是否完整」，不验各工具内部逻辑
const stub = () => () => ({ ok: true });
const handlers = scheduledToolHandlers({
  scheduledAgentChat: stub(),
  webTools: { webSearch: stub(), webFetch: stub() },
  toolShell: stub(), toolReadFile: stub(), runWriteTool: stub(),
  toolListDir: stub(), toolGrep: stub(), toolGlob: stub(),
  toolGitStatus: stub(), toolGitDiff: stub(), toolGitLog: stub(),
  toolGitBranch: stub(), toolGitCommit: stub(), toolGitAdd: stub(),
  callMcpTool: stub(),
  prTools: { prList: stub(), prView: stub(), prDiff: stub(), prReview: stub(), prComment: stub() },
});

check('出网能力在清单里（webSearch / webFetch）——本次事故的直接回归点', () => {
  for (const name of ['webSearch', 'webFetch']) {
    assert.equal(typeof handlers[name], 'function', `缺少 ${name}：无人值守任务将无法联网，只能回「工具不存在」`);
  }
});

check('核心工具不缺失（读写 / 检索 / git / mcp / pr）', () => {
  const required = [
    'chat', 'shell', 'readFile', 'writeFile', 'editFile', 'applyPatch',
    'listDir', 'grep', 'glob',
    'gitStatus', 'gitDiff', 'gitLog', 'gitBranch', 'gitCommit', 'gitAdd',
    'mcpCallTool', 'prList', 'prView', 'prDiff', 'prReview', 'prComment',
  ];
  const missing = required.filter((n) => typeof handlers[n] !== 'function');
  assert.deepEqual(missing, [], `清单缺少：${missing.join(', ')}`);
});

check('两条执行路径共用同一份清单（不再各自维护）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/scheduledTools'\)/, 'main.js 未引入 scheduledTools');
  // 两处调用点：交互式 Agent 的 createToolHandlers 与 workerPool 的 createToolHandlers
  assert.ok((main.match(/scheduledToolHandlers\(/g) || []).length >= 2, '至少两处调用点应使用同一清单');
});

check('结果只渲染一处（runResult 优先、last_result 兜底）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/src/components/ScheduledTasks.jsx'), 'utf8');
  assert.match(src, /\{runResult\?\.taskId === task\.id \? \(/, '结果区未按「二选一」渲染（会叠成两个框）');
  assert.match(src, /\) : task\.last_result && \(/, '缺少 last_result 兜底分支');
  // 旧写法：两个独立条件同时成立 → 同一次运行渲染两次
  assert.doesNotMatch(src, /\{task\.last_result && \([\s\S]{0,400}?\)\}\s*\{runResult\?\.taskId === task\.id && \(/,
    '仍存在「last_result 与 runResult 并列渲染」的旧写法');
});

// A10（窗口外扩守卫）：runNow 的抽取窗口必须恰好是它的函数体，
// 不能因为前面插了个同名假标记 / 把 showRuns 挪走而外扩吃掉相邻代码。
// 双路径互证窗口边界：A=括号配对（跳字符串/模板串/注释），B=缩进层级（只看行首）。
check('runNow 抽取窗口未被外扩（函数体闭括号后紧接 showRuns，双路径一致）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/src/components/ScheduledTasks.jsx'), 'utf8');
  const runNowStart = src.indexOf('async function runNow');
  assert.ok(runNowStart > 0, 'ScheduledTasks.jsx 找不到 async function runNow（结构变了要同步本抽取器）');
  const openBrace = src.indexOf('{', runNowStart);
  assert.ok(openBrace > runNowStart, 'runNow 声明后找不到开括号');
  const closeByBracket = matchBracket(src, openBrace);
  assert.ok(closeByBracket > openBrace, 'runNow 函数体括号未配对（窗口一路吃到文件尾了？）');
  const showRunsStart = src.indexOf('async function showRuns');
  assert.ok(showRunsStart > closeByBracket, 'runNow 的闭括号落在 showRuns 之后（窗口错位/外扩）');
  // B 路径：缩进层级算出的闭括号（indexOf 命中的是 \n，需 +1+缩进长 才指到 } 自身，与括号配对口径一致）
  const fnLineStart = src.lastIndexOf('\n', runNowStart) + 1;
  const fnIndent = /^\s*/.exec(src.slice(fnLineStart))[0];
  const closeByIndentAt = src.indexOf(`\n${fnIndent}}`, openBrace);
  assert.ok(closeByIndentAt > openBrace, `找不到缩进层 ${JSON.stringify(fnIndent)} 的闭合花括号（runNow 的缩进层级变了？）`);
  const closeByIndent = closeByIndentAt + 1 + fnIndent.length;
  assert.equal(closeByBracket, closeByIndent,
    `runNow 函数体窗口两条路径不一致：括号配对算到 ${closeByBracket}，缩进层级算到 ${closeByIndent}（多半是配对漏跳了字符串/注释导致窗口外扩）`);
  // 闭括号与 showRuns 之间只允许空白：窗口没吃到相邻函数体（从闭括号之后开始算）
  const between = src.slice(closeByBracket + 1, showRunsStart);
  assert.ok(/^\s*$/.test(between), `runNow 闭括号与 showRuns 之间夹了非空白内容（窗口外扩吃了相邻代码）：${between.slice(0, 120)}`);
});

check('「立即运行」如实透传成功/失败（不再硬编码 ok:true）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/src/components/ScheduledTasks.jsx'), 'utf8');
  const fn = src.slice(src.indexOf('async function runNow'), src.indexOf('async function showRuns'));
  assert.doesNotMatch(fn, /ok: true/, '立即运行仍硬编码成功（失败也会显示成功色）');
  assert.match(fn, /ok: !!r\?\.ok/, '未透传执行器的 ok');
  assert.match(fn, /r\?\.error/, '失败时未展示错误原因');
});

// ── 模型侧 scheduled_create：必须经审批才落地 ──
const { scheduledCreate } = require(path.join(ROOT, 'main', 'scheduledTools.js'));
const approval = require(path.join(ROOT, 'main', 'approval.js'));

function makeCtx(decision, extra = {}) {
  const created = [];
  const applied = [];
  return {
    ctx: {
      approvalMode: 'on-request',
      conversationId: 't1',
      cronValid: () => true,
      createTask: (p) => { created.push(p); return { ok: true, task: { id: 't-x', ...p } }; },
      requestApproval: async () => decision,
      applyApprovalDecision: (d, tool) => { applied.push([d, tool]); },
      ...extra,
    },
    created,
    applied,
  };
}
const ARGS = { name: '每日新闻', schedule: '41 9 * * *', prompt: '搜索并汇总最新 AI 新闻' };

check('agent-core 声明了 scheduled_create（有实现无入口的断链反例）', () => {
  const core = fs.readFileSync(path.join(ROOT, 'agent-core', 'index.js'), 'utf8');
  assert.match(core, /name: 'scheduled_create'/, 'BASE_TOOLS 未声明 scheduled_create：模型看不到这个工具');
  assert.match(core, /required: \['schedule', 'prompt'\]/, '参数必填项缺失');
});

check('scheduled_create 判 L3，auto-safe 也不放行', () => {
  const r = approval.needsApproval({ tool: 'scheduled_create', args: ARGS, approvalMode: 'auto-safe' });
  assert.equal(r.need, true, 'auto-safe 下被静默放行（模型可无提示建出无人值守任务）');
  assert.equal(r.level, 'L3');
});

check('审批卡文案讲清「以后会自己跑」', () => {
  const s = approval.approvalSummary('scheduled_create', ARGS);
  assert.equal(s.level, 'L3');
  assert.match(s.title, /定时任务/, `标题不符：${s.title}`);
  assert.match(s.detail, /41 9 \* \* \*/, '未展示 cron 计划');
  assert.match(s.detail, /无人值守/, '未警示无人值守执行');
  assert.match(s.detail, /搜索并汇总/, '未展示执行内容');
});

// 行为层：拒绝 → 不落地；放行 → 落地但不落规则；never → 按用户设置静默创建
{
  const A = makeCtx('deny');
  const r = await scheduledCreate(ARGS, A.ctx);
  check('用户拒绝 → 任务不创建（拒绝不是建议，是硬约束）', () => {
    assert.equal(r.ok, false);
    assert.equal(r.denied, true);
    assert.equal(A.created.length, 0, '被拒绝却仍然创建了任务');
  });

  const B = makeCtx('once');
  const r2 = await scheduledCreate(ARGS, B.ctx);
  check('审批通过 → 创建成功且返回 taskId', () => {
    assert.equal(r2.ok, true);
    assert.ok(r2.taskId, '未返回 taskId');
    assert.equal(B.created.length, 1);
    assert.equal(B.created[0].schedule, '41 9 * * *');
  });
  check('审批结果不落规则库（每次创建都要问一次）', () => {
    assert.equal(B.applied.length, 0, `applyApprovalDecision 被调用了 ${B.applied.length} 次`);
  });

  const C = makeCtx(null, { approvalMode: 'never' });
  const r3 = await scheduledCreate(ARGS, C.ctx);
  check('approvalMode=never → 尊重用户设置（不弹卡直接创建）', () => {
    assert.equal(r3.ok, true);
    assert.equal(C.created.length, 1);
  });

  const D = makeCtx('once', { requestApproval: undefined });
  const r4 = await scheduledCreate(ARGS, D.ctx);
  check('无审批通道 → fail-closed（不创建）', () => {
    assert.equal(r4.ok, false);
    assert.equal(D.created.length, 0);
  });

  const E = makeCtx('once', { cronValid: () => false });
  const r5 = await scheduledCreate({ ...ARGS, schedule: 'bad' }, E.ctx);
  check('cron 非法 → 直接拒绝且不弹卡', () => {
    assert.equal(r5.ok, false);
    assert.match(r5.error, /Cron/);
    assert.equal(E.created.length, 0);
  });
}

check('main.js 把 scheduledCreate 接进会话工具（tools 有声明、handler 有实现）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  assert.match(main, /scheduledCreate: \(args\) => scheduledCreateTool\(args, \{/, 'handler 未接线');
  assert.match(main, /createTask: scheduler\.createTask/, '未复用 scheduler.createTask（会有两套校验）');
});

check('审批 UI 不提供「记住」选项（否则点了也不生效 = 产品撒谎）', () => {
  assert.ok(approval.NON_REMEMBERABLE.has('scheduled_create'), 'scheduled_create 应属不可记忆工具');
  assert.equal(approval.isRememberable('scheduled_create'), false);
  assert.equal(approval.isRememberable('write_file'), true, '普通工具不应被误设成不可记忆');
  const card = fs.readFileSync(path.join(ROOT, 'renderer/src/components/ApprovalCard.jsx'), 'utf8');
  assert.match(card, /const rememberable = pending\?\.rememberable !== false/, '审批卡未读取 rememberable');
  assert.match(card, /\{rememberable && \([\s\S]*?resolve\('conversation'\)/, '「本会话允许」未按 rememberable 收口');
  assert.match(card, /\{rememberable && \([\s\S]*?resolve\('always'\)/, '「始终允许」未按 rememberable 收口');
  const main = fs.readFileSync(path.join(ROOT, 'main', 'main.js'), 'utf8');
  assert.match(main, /rememberable: approval\.isRememberable\(tool\)/, '主进程未下发 rememberable');
});

console.log(`\nscheduled-tools: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
