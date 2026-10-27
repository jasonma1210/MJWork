// 「派活」门禁（2026-10-27，接替原 publish-task-flow）
//
// 背景：原来的「发布任务」页只能派给军团或"自动"，与助手无关；目录与建团又各有自己的提交。
// 收敛后**只有一个提交出口**：`AssistantDispatch`（派活面板），三种主体 × 两种运行方式。
// 本套件守的就是这套分派规则，别再退回"三处各自发布"。
//
// 三条分支的落点不能被悄悄改掉：
//   ① 主体=助手 ⇒ 提交前必须查 runtime，通过后走 onDispatchAssistant（落当前会话）；
//   ② 主体=团队 ⇒ 走 onDispatchTeam（App 注入 teams:dispatch，与军团页同一条通道）；
//   ③ 主体=系统 ⇒ 走 onAutoRun 交回主链路（**不得静默建团**）；
//   ④ 运行=定时 ⇒ api.createScheduledTask，cron 与「定时任务页」同一份实现；且**助手主体被禁用**。
//
// 断言范式：cron/计划预览是纯函数 ⇒ 直接行为断言；接线是结构性事实 ⇒ 源码断言（辅助），
// 但必须剥注释后再匹配（否则注释里的同名文本会误判为已接线）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); process.exitCode = 1; }
};

const {
  REPEATS, VALID_TYPES, cronOf, parseHm, nextCronRun, formatDateTime, planSummary, validateCron,
} = await import('../renderer/src/lib/schedulePresets.ts');

/** 假 t：把 key 与其插值原样拼出来，供断言检查「用到了哪个 key、带了什么变量」 */
const t = (k, vars) => (vars ? `${k}(${Object.keys(vars).sort().join(',')})` : k);

// ── A. 重复模板 → cron（与定时任务页共用同一份实现）──
await check('A1 每天 / 工作日 / 每周一 的 cron 映射正确（09:00 起算）', () => {
  assert.equal(cronOf('daily', '09:00'), '0 9 * * *');
  assert.equal(cronOf('weekday', '09:00'), '0 9 * * 1-5');
  assert.equal(cronOf('weekly', '09:00'), '0 9 * * 1');
  assert.equal(cronOf('daily', '23:05'), '5 23 * * *');
});

await check('A2 自定义表达式原样透传（不 trim 内部空白、不擅自改写）', () => {
  assert.equal(cronOf('custom', '09:00', '*/15 8-18 * * 1-5'), '*/15 8-18 * * 1-5');
  assert.equal(cronOf('custom', '09:00', ''), '');
});

await check('A3 时间解析对非法输入兜底为 09:00（不抛错、不产出 NaN cron）', () => {
  assert.deepEqual(parseHm(''), { h: 9, m: 0 });
  assert.deepEqual(parseHm('xx:yy'), { h: 9, m: 0 });
  assert.deepEqual(parseHm('25:99'), { h: 23, m: 59 });
});

// ── B. 下次运行与计划预览 ──
await check('B1 nextCronRun 从给定时刻起算，跨天正确', () => {
  const from = new Date(2026, 9, 24, 10, 0, 0);
  const next = nextCronRun('0 9 * * *', from);
  assert.ok(next, '未算出下次运行');
  assert.equal(next.getDate(), 25);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

await check('B2 nextCronRun 对工作日模板跳过周末', () => {
  const fri = new Date(2026, 9, 23, 10, 0, 0);
  const next = nextCronRun('0 9 * * 1-5', fri);
  assert.ok(next);
  assert.equal(next.getDay(), 1, `应跳到周一，实际 getDay=${next.getDay()}`);
});

await check('B3 planSummary：合法 cron ⇒ ok 且文案带「下次运行」；非法 ⇒ ok=false 且给错误文案', () => {
  const ok = planSummary('daily', '09:00', '', 'forever', '', t, new Date(2026, 9, 24, 10, 0, 0));
  assert.equal(ok.ok, true);
  assert.equal(ok.cron, '0 9 * * *');
  assert.match(ok.text, /scheduled\.planForever/, `未用「长期有效」口径：${ok.text}`);
  const bad = planSummary('custom', '09:00', 'not-a-cron', 'forever', '', t);
  assert.equal(bad.ok, false);
  assert.ok(bad.text.length > 0, '非法 cron 必须给可读原因，不能空白');
});

await check('B4 选了「截止日期」时文案换成带日期的口径（有效期不能被静默忽略）', () => {
  const r = planSummary('daily', '09:00', '', 'until', '2026-12-31', t, new Date(2026, 9, 24, 10, 0, 0));
  assert.equal(r.ok, true);
  assert.match(r.text, /scheduled\.planUntil/);
});

await check('B5 formatDateTime 与既有展示口径一致（YYYY/MM/DD HH:mm）', () => {
  assert.equal(formatDateTime(new Date(2026, 0, 5, 8, 7)), '2026/01/05 08:07');
  assert.equal(formatDateTime(null), '');
});

await check('B6 契约完整性：REPEATS / VALID_TYPES 的文案键都用 scheduled.* 命名空间（不新造一套）', () => {
  for (const r of REPEATS) assert.match(r.labelKey, /^scheduled\./, r.labelKey);
  for (const v of VALID_TYPES) assert.match(v.labelKey, /^scheduled\./, v.labelKey);
});

// ── C. 界面接线（结构性事实；剥注释后再匹配）──
const panel = stripComments(read('components/AssistantDispatch.tsx'));
const sheet = panel.slice(panel.indexOf('async function submit('), panel.indexOf('const SUBJECTS'));

await check('C1 主体=助手 ⇒ 提交前查 runtime，通过后走 onDispatchAssistant', () => {
  assert.match(panel, /ecosystemEmployeeRuntime\?\.\(\{\s*id:\s*emp\.id\s*\}\)/,
    '派给助手前未查 runtime（不能只信目录页的旧结论）');
  assert.match(panel, /onDispatchAssistant\?\.\(\{\s*employee:\s*emp,\s*goal:\s*g\s*\}\)/,
    'onDispatchAssistant 载荷不完整（缺 employee/goal）');
});

await check('C2 主体=团队 ⇒ 走 onDispatchTeam（App 注入 teams:dispatch），载荷含 teamId/goal', () => {
  assert.match(panel, /onDispatchTeam\?\.\(\{\s*teamId,\s*goal:\s*g\s*\}\)/, '未调用 onDispatchTeam');
  const app = stripComments(read('App.jsx'));
  assert.match(app, /teamsDispatch\?\.\(\{/, 'App 未把 onDispatchTeam 接到 teams:dispatch');
  assert.match(app, /teamId,\s*goal,\s*threadId:\s*activeThreadId/, 'App 的 dispatch 载荷缺 teamId/goal/threadId');
});

await check('C3 主体=系统 ⇒ 走 onAutoRun 交回主链路，且**不静默建团**', () => {
  assert.match(panel, /onAutoRun\(g\)/, '未走 onAutoRun（判定器出口）');
  assert.ok(!/teamsCreate\?\./.test(panel), '不得在派活面板静默建团（teams:create 是不可逆写通道）');
});

await check('C4 运行=定时 ⇒ 走既有 createScheduledTask，cron 来自共享纯函数', () => {
  assert.match(panel, /api\.createScheduledTask\(/, '未调用 createScheduledTask');
  assert.match(panel, /plan\.cron/, 'cron 未取自 planSummary（会与定时任务页分叉）');
  assert.match(panel, /external_policy:\s*'block'/, '未默认 block 外发');
  assert.match(panel, /team_id:\s*subject === 'team' && teamId \? String\(teamId\) : null/,
    'team_id 未按「只提交用户显式选择的团队」处理');
});

await check('C5 三种主体必须都在同一个 submit() 里分派（不允许各自一套提交）', () => {
  assert.ok(sheet.length > 200, '提交段截取过短，断言会空过');
  for (const branch of ['dispatchAssistant(g)', 'dispatchTeam(g)', 'onAutoRun(g)']) {
    assert.ok(sheet.includes(branch), `submit() 内缺少分派分支 ${branch}`);
  }
});

await check('C6 运行方式只有两项：立即（默认）/ 定时', () => {
  assert.match(panel, /useState<Kind>\('now'\)/, '立即不是默认值');
  assert.match(panel, /type Kind = 'now' \| 'scheduled'/, 'Kind 联合类型不是两项');
});

await check('C7 定时参数只在「定时」且主体允许时展开（立即不该被塞一堆定时控件）', () => {
  assert.match(panel, /kind === 'scheduled' && !assistantBlockedBySchedule && \(/, '定时参数未按条件渲染');
});

await check('C8 零裸 <button>（ui-conventions 棘轮只减不增）', () => {
  assert.ok(!/<button/.test(panel), 'AssistantDispatch 含裸 <button>，应改用 ui/Button');
});

// ── D. 助理页只有「一个」提交面 ──
await check('D1 助理页把派活面板作为首个 Tab 挂进去，并透传三个出口', () => {
  const ap = stripComments(read('components/AssistantPage.tsx'));
  assert.match(ap, /<AssistantDispatch/, '助理页未挂 AssistantDispatch');
  assert.match(ap, /onAutoRun=\{onAutoRun\}/, '未把自动构建出口透传下去');
  assert.match(ap, /onDispatchTeam=\{onDispatchTeam\}/, '未把团队派活出口透传下去');
  assert.match(ap, /onDispatchAssistant=\{onDispatchEmployee\}/, '未把助手派活出口透传下去');
  assert.ok(!ap.includes('PublishTaskPage'), '助理页仍引用已下线的 PublishTaskPage');
});

await check('D2 派活文案齐全（不会出现裸 key）+ 占位符双侧一致', () => {
  const need = [
    'title', 'subtitle', 'subjectLabel', 'subjectAssistant', 'subjectTeam', 'subjectSystem',
    'goalLabel', 'goalPlaceholder', 'kindLabel', 'kindNow', 'kindScheduled',
    'confirmNow', 'confirmScheduled', 'hintAssistant', 'hintTeam', 'hintSystem', 'hintScheduled',
    'needGoal', 'needThread', 'needAssistant', 'assistantUnavailable', 'assistantDispatched',
    'dispatchFailed', 'dispatched', 'scheduledCreated', 'scheduledFailed',
    'scheduledNoAssistant', 'boardTitle', 'boardEmpty', 'boardTaskCount', 'statusRunning', 'statusFailed',
  ];
  const zh = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/zh-CN/assistant.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/en-US/assistant.json'), 'utf8'));
  const holders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
  for (const k of need) {
    assert.equal(typeof zh.dispatch?.[k], 'string', `zh-CN 缺 assistant.dispatch.${k}`);
    assert.equal(typeof en.dispatch?.[k], 'string', `en-US 缺 assistant.dispatch.${k}`);
    assert.equal(holders(zh.dispatch[k]), holders(en.dispatch[k]), `占位符不一致：${k}`);
  }
  // 旧命名空间必须清干净：留着 publish 块说明还有地方在按老口径取文案
  assert.equal(zh.publish, undefined, 'zh-CN 仍残留 assistant.publish 块');
  assert.equal(en.publish, undefined, 'en-US 仍残留 assistant.publish 块');
});

await check('D3 定时计划预览的文案键存在（双侧）——「下次运行」不能是硬编码中文', () => {
  for (const lang of ['zh-CN', 'en-US']) {
    const d = JSON.parse(fs.readFileSync(path.join(SRC, `i18n/locales/${lang}/scheduled.json`), 'utf8'));
    for (const k of ['planForever', 'planUntil', 'noNextRun']) {
      assert.equal(typeof d[k], 'string', `${lang} 缺 scheduled.${k}`);
    }
  }
});

// ── E. validateCron 的失败路径（提交用它把关，不能只测成功路径）──
await check('E1 非法 cron 逐类给出可读错误（字段数 / 字符合法性 / 数值越界）', () => {
  assert.ok(validateCron('0 9 * *', t), '字段数不足应报错');
  assert.ok(validateCron('0 9 * * MON', t), '非数字字符应报错');
  assert.ok(validateCron('99 9 * * *', t), '分钟越界应报错');
  assert.equal(validateCron('0 9 * * *', t), null, '合法表达式不应报错');
});

console.log(`\nassistant-dispatch-flow: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
