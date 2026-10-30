// 排队任务卡片回归门禁（对标 Codex 的排队指令）
//
// 为什么需要：运行中发出的消息必须「排队等下一轮」，而不是立刻并发跑；卡片上三个动作
// （立即执行 / 编辑 / 删除）任一接错，用户会遇到「点了没反应」「当前任务被第二条消息顶掉」
// 「编辑后原文丢了」——这三种都只在运行时暴露，靠肉眼看代码很难发现。
//
// 断言分三层：
//   ① 行为契约：入队条件、接力时机、立即执行的时序（停 → 等空闲 → 发）都在源码里可判定；
//   ② 组件契约：三个按钮各自绑到对应回调，缺一个就是死按钮；
//   ③ 文案契约：四个新 key 在 zh-CN / en-US 都存在（i18n key 缺失会原样显示给用户）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

const composer = read('renderer/src/components/Composer.tsx');
const chatArea = read('renderer/src/components/ChatArea.jsx');
const hook = read('renderer/src/hooks/useAgentRun.ts');

// ── ① 行为契约 ──
check('运行中发送 → 入队（不并发执行）', () => {
  assert.match(hook, /if \(loading\) queueNext\(text\)/, 'send 未在 loading 时入队');
  // F-005（2026-10-30）：queueNext 参数补了类型标注（`text: string | null | undefined`），故不再锁 `(text)` 字面量。
  // 断言意图不变：参数名仍是 text，且函数体把 t **追加**进队列（`[...q, t]`，不是覆盖 q）。
  assert.match(hook, /function queueNext\(text[^)]*\)[\s\S]{0,200}setQueued\(\(q\) => \[\.\.\.q, t\]\)/,
    'queueNext 未把指令追加到队列');
});

check('本轮正常结束后自动接力下一条（中止不接力）', () => {
  // R-15/R-5：接力调用形态为 `(relayRef?.current || send)(next, currentThread)`——
  // 选中军团时经 sendOrDispatch 派活，未注入时回落 send；两种形态都满足「正常收尾才接力」。
  const relay = hook.match(/if \(!aborted\) \{[\s\S]*?setQueued\(\(q\) => \{[\s\S]{0,200}?(?:relayRef\?\.current \|\| )?send\)?\(next, currentThread\)/);
  assert.ok(relay, '未找到「正常收尾才接力」的实现');
  // 中止分支不该接力：中止后用户可能还要看现场，自动开新任务会打断
  const abortedBranch = hook.match(/\} else \{\s*\/\/ 用户中止后线程状态必须收敛[\s\S]{0,200}?\}/);
  assert.ok(abortedBranch, '未找到中止分支');
  assert.doesNotMatch(abortedBranch[0], /send\(next/, '中止分支不应自动接力');
});

check('立即执行：先 stop，再等 loading 归零后发送（不用定时器猜时长）', () => {
  assert.match(chatArea, /function runQueuedNow\(i\)[\s\S]{0,300}?stop\(\);\s*setPendingRun\(text\)/,
    'runQueuedNow 未按「先停、后挂起」的顺序实现');
  // R-15/R-5：挂起项发送改走 sendOrDispatch（选中军团时派活；未选中时内部回落 send）
  assert.match(chatArea, /if \(!pendingRun \|\| loading\) return;[\s\S]{0,160}?send(?:OrDispatch)?\(text\)/,
    '缺少「挂起项就绪且已空闲才发送」的闸门');
  assert.doesNotMatch(chatArea, /runQueuedNow[\s\S]{0,200}?setTimeout\(/, '立即执行不该用定时器猜收尾时长');
});

check('编辑：摘出队列并回填输入框（已有内容时追加，不覆盖）', () => {
  assert.match(chatArea, /function editQueued\(i\)[\s\S]{0,400}?setInput\(\(prev\) => \(String\(prev \|\| ''\)\.trim\(\) \? `\$\{prev\}\\n\$\{text\}` : text\)\)/,
    'editQueued 未做「有内容则追加」的回填');
});

// ── ② 组件契约 ──
check('排队卡片三个动作各自绑到对应回调', () => {
  for (const [handler, label] of [['onRunNow', '立即执行'], ['onEdit', '编辑'], ['onRemove', '删除']]) {
    const re = new RegExp(`onClick=\\{\\(\\) => ${handler}\\?\\.\\(i\\)\\}`);
    assert.match(composer, re, `第 ${label} 个按钮未绑 ${handler}`);
  }
  assert.match(composer, /<QueuedTasks[\s\S]{0,200}?onRunNow=\{onQueueRunNow\}[\s\S]{0,120}?onEdit=\{onQueueEdit\}[\s\S]{0,120}?onRemove=\{onQueueRemove\}/,
    'Composer 未把三个回调接到 QueuedTasks');
  assert.match(chatArea, /onQueueRunNow: runQueuedNow, onQueueEdit: editQueued/, 'ChatArea 未下发 runQueuedNow / editQueued');
});

check('排队卡片位于输入框上方（不再用「已排队 N」浮层）', () => {
  const tasksIdx = composer.indexOf('<QueuedTasks');
  const consoleIdx = composer.indexOf('任务控制台');
  assert.ok(tasksIdx > 0 && consoleIdx > 0 && tasksIdx < consoleIdx, 'QueuedTasks 未排在输入控制台之前');
  assert.doesNotMatch(composer, /function QueuedList/, '旧的 QueuedList 浮层未移除（会出现两套入口）');
});

// ── ③ 文案契约 ──
check('四个排队动作文案在 zh-CN / en-US 都存在', () => {
  const keys = ['queueRunNow', 'queueRunNowTip', 'queueEdit', 'queueEditTip', 'queueDelete', 'queueDeleteTip'];
  for (const loc of ['zh-CN', 'en-US']) {
    const dict = JSON.parse(read(`renderer/src/i18n/locales/${loc}/composer.json`));
    for (const k of keys) {
      assert.ok(dict[k], `${loc}/composer.json 缺少 ${k}`);
    }
  }
});

console.log(`\nqueue-tasks: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
