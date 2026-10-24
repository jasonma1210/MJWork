// 定时任务能不能像对话一样并行？（2026-10-18）
//
// 用户实测：同一句「抓 100 篇娱乐八卦，输出 md」丢进**新建对话**能跑（4 个 Agent 并行、web_search/web_fetch
// 一路在走），放进**定时任务**却跑不动。原因不是模型、也不是窗口，而是**工具表缺一个工具**：
//   对话通道 = scheduledToolHandlers() + orchestrateTask + searchPlugins + installPlugin …
//   定时通道 = 只有 23 个（web/shell/读写/git/pr/mcp），**没有 orchestrate_task**
// 模型拿不到这个工具，就只能串行抓 100 条 —— 这就是差别。
//
// 本门禁守三件事：
//   ① 定时通道确实暴露 orchestrate_task，且 cwd 被强制成产出目录（不让模型自选路径，
//      否则子 Agent 会写到无处可寻的地方，写白名单也会把它拦掉）；
//   ② 契约提示词真的告诉模型「条目多就并行」，且明确要求子任务**不要写文件**（子任务并发写同一文件会互相覆盖）；
//   ③ 墙钟够长（并行抓 100 条 + 汇总，10 分钟会被从中间掐断，而死因只会写成「执行超时」）。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const mainSrc = read('main/main.js');
const schedSrc = read('main/scheduler.js');
const { buildScheduledPrompt } = require(path.join(ROOT, 'main', 'scheduledOutput.js'));

check('定时通道暴露 orchestrate_task（对话有、定时也要有）', () => {
  // 窗口从 80 放宽到 600（2026-10-21，D-805）。原窗口是「两个键在源码里位置相近」的**代理**，
  // 而它们同属一个对象字面量：本轮在同处插入 `chat` 覆盖（取消信号透传）+ 4 行说明注释后，
  // orchestrateTask 就被推到 80 字符之外，断言假红——**代码更正确了，门禁却响了**。
  // 放宽窗口不改变断言语义（仍要求「同一个工具表里既有基础 spread、又有 orchestrateTask 覆盖」），
  // 但去掉了「插入注释即红」这个与意图无关的脆弱点。若哪天有人把 orchestrateTask 搬到别处，
  // 只要它仍落在这段装配内，本断言该绿；搬出装配范围就会红（窗口比整段装配短）。
  // FIX-P04（2026-10-24）：定时通道的实参新增 teamTools: schedCtx.teamTools，原先「恰好两键
  // + 立即闭括号」的形状代理会假红。这里同样只放宽括号位置，窗口与语义不变：
  // 仍要求「同一段装配里既有基础 spread、又有 orchestrateTask 覆盖」。
  assert.match(
    mainSrc,
    /scheduledToolHandlers\(\{[^}]*unattended: true, contextCwd: schedModel\.cwd[^}]*\}\)[\s\S]{0,600}orchestrateTask:/,
    'runScheduledAgentTask 的工具表里没有 orchestrateTask —— 模型看不到这个工具就只能串行',
  );
});

check('orchestrate 的 cwd 被强制为产出目录（不让模型自选）', () => {
  assert.match(
    mainSrc,
    /orchestrateTask: \(a\) => toolOrchestrateTask\(\{ \.\.\.a, cwd: rc\.dir \}/,
    'orchestrate 必须把 cwd 覆盖成 rc.dir：子 Agent 的写入要落在产出目录，模型自选路径会被写白名单拦掉',
  );
  // 反向：不能出现让模型 cwd 透传的写法
  assert.ok(
    !/orchestrateTask: \(a\) => toolOrchestrateTask\(a[,)]/.test(mainSrc),
    'orchestrate 直接透传 args 会让模型的 cwd 生效，必须覆盖',
  );
});

check('orchestrate 绑定本次运行（signal + conversationId），可被停止/可归属', () => {
  // R2（2026-10-20）：随 projectPath 一并下发（记忆召回空间键统一为项目路径，而非产出目录/临时 worktree）
  assert.match(mainSrc, /toolOrchestrateTask\(\{ \.\.\.a, cwd: rc\.dir \}, \{ signal, conversationId: `scheduled:\$\{taskId\}`, projectPath: rc\.dir \}\)/);
});

const prompt = buildScheduledPrompt({ dir: '/tmp/out-x', contextCwd: '/tmp/proj-x' });

check('契约提示模型「条目多就并行」并给出拆分方式', () => {
  assert.match(prompt, /orchestrate_task/);
  assert.match(prompt, /超过 30 条/);
  assert.match(prompt, /3–5 个互不重复的子任务/);
});

check('契约明确子任务不要写文件（并发写同一文件会互相覆盖）', () => {
  assert.match(prompt, /不要让子任务写文件/);
  assert.match(prompt, /汇总成一份文件写入 \/tmp\/out-x/);
});

check('产物目录仍出现在契约里，且不被编排条款顶掉', () => {
  assert.match(prompt, /必须把产物写成文件/);
  assert.match(prompt, /\/tmp\/out-x/);
});

check('墙钟 ≥ 20 分钟（10 分钟会在并行抓取的中途掐断）', () => {
  const m = schedSrc.match(/DEFAULT_TASK_TIMEOUT_MS = (\d+) \* 60 \* 1000/);
  assert.ok(m, '找不到墙钟常量');
  const minutes = Number(m[1]);
  assert.ok(minutes >= 20, `墙钟 ${minutes} 分钟偏短：并行抓 100 条 + 汇总会被砍在中途，死因只会写成「执行超时」`);
});

check('墙钟仍是有界的（不是无限等待）', () => {
  const m = schedSrc.match(/DEFAULT_TASK_TIMEOUT_MS = (\d+) \* 60 \* 1000/);
  const minutes = Number(m[1]);
  assert.ok(minutes <= 60, `墙钟 ${minutes} 分钟过长：无人值守僵死的代价太高`);
});

console.log(`\nscheduled-orchestrate: ${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;
