// 「发布任务」门禁（2026-10-24）
//
// 守护什么：助理里**只有一个**发布面，且三条分支的落点不能被悄悄改掉：
//   ① 复杂任务 + 选了军团 ⇒ 走 `teams:dispatch`（确定性派活）；
//   ② 复杂任务 + 不选军团 ⇒ 走 `onAutoRun` 交回主链路（**不得静默建团**）；
//   ③ 定时任务 ⇒ 用 `api.createScheduledTask`，cron 必须与「定时任务页」同一份实现；
//   ④ 看板数据来自 `teams:listThreadRuns`（不是本地猜的假数据）。
//
// 为什么必须补这个套件：上一轮出现过「代码写了、单测绿、运行期没生效」的假闭环
// （teams:dispatch 的 presetTasks 归一被另一条分支顶掉）。这次对**新界面**先立判据。
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
  // 空表达式交给校验层报错，而不是在这里造一个默认值
  assert.equal(cronOf('custom', '09:00', ''), '');
});

await check('A3 时间解析对非法输入兜底为 09:00（不抛错、不产出 NaN cron）', () => {
  assert.deepEqual(parseHm(''), { h: 9, m: 0 });
  assert.deepEqual(parseHm('xx:yy'), { h: 9, m: 0 });
  assert.deepEqual(parseHm('25:99'), { h: 23, m: 59 });
});

// ── B. 下次运行与计划预览（用户在图里看到的「下次运行 …」）──
await check('B1 nextCronRun 从给定时刻起算，跨天正确', () => {
  const from = new Date(2026, 9, 24, 10, 0, 0); // 2026-10-24 10:00 本地
  const next = nextCronRun('0 9 * * *', from);
  assert.ok(next, '未算出下次运行');
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 9);
  assert.equal(next.getDate(), 25, `应落在 25 日，实际 ${next.getDate()}`);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

await check('B2 nextCronRun 对工作日模板跳过周末', () => {
  const fri = new Date(2026, 9, 23, 10, 0, 0); // 2026-10-23 周五 10:00
  const next = nextCronRun('0 9 * * 1-5', fri);
  assert.ok(next);
  assert.equal(next.getDay(), 1, `应跳到周一，实际 getDay=${next.getDay()}`);
  assert.equal(next.getDate(), 26);
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

await check('B4 planSummary：选了「截止日期」时文案换成带日期的口径（有效期不能被静默忽略）', () => {
  const r = planSummary('daily', '09:00', '', 'until', '2026-12-31', t, new Date(2026, 9, 24, 10, 0, 0));
  assert.equal(r.ok, true);
  assert.match(r.text, /scheduled\.planUntil/, `未用「有效至」口径：${r.text}`);
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
const page = stripComments(read('components/PublishTaskPage.tsx'));

await check('C1 复杂任务 + 选军团 ⇒ 走 teams:dispatch（与军团页同一条通道）', () => {
  assert.match(page, /teamsDispatch\?\.\(\{/, '未调用 teamsDispatch');
  assert.match(page, /teamId,\s*goal:\s*g,\s*threadId/, 'dispatch 载荷不完整（缺 teamId/goal/threadId）');
});

await check('C2 复杂任务 + 不选军团 ⇒ 走 onAutoRun 交回主链路，且**不静默建团**', () => {
  assert.match(page, /onAutoRun\(g\)/, '未走 onAutoRun（自动构建出口）');
  // 反向断言：不选军团时绝不能出现「悄悄建一个军团」的写通道
  assert.ok(!/teamsCreate\?\./.test(page), '不得在发布页静默建团（teams:create 是写通道，不可逆）');
});

await check('C3 定时任务 ⇒ 走既有 createScheduledTask，且 cron 来自共享纯函数', () => {
  assert.match(page, /api\.createScheduledTask\(/, '未调用 createScheduledTask');
  assert.match(page, /plan\.cron/, 'cron 未取自 planSummary（会与定时任务页分叉）');
  // 无人值守默认不外发 + 用户显式选的军团才落库
  assert.match(page, /external_policy:\s*'block'/, '未默认 block 外发');
  assert.match(page, /team_id:\s*teamId\s*\?\s*String\(teamId\)\s*:\s*null/, 'team_id 未按「只提交用户显式选择」处理');
});

await check('C4 看板数据来自 teams:listThreadRuns（不是本地编造的假进度）', () => {
  assert.match(page, /teamsListThreadRuns\?\.\(\{\s*threadId\s*\}\)/, '看板未接 teams:listThreadRuns');
});

await check('C5 类型下拉只有两项：复杂任务（默认）/ 定时任务', () => {
  assert.match(page, /useState<TaskKind>\('complex'\)/, '复杂任务不是默认值');
  assert.match(page, /'complex'\s*\|\s*'scheduled'/, 'TaskKind 联合类型不是两项');
});

await check('C6 定时参数只在选「定时任务」时展开（复杂任务不该被塞一堆定时控件）', () => {
  assert.match(page, /kind === 'scheduled' && \(/, '定时参数未按 kind 条件渲染');
});

await check('C7 零裸 <button>（ui-conventions 棘轮只减不增）', () => {
  assert.ok(!/<button/.test(page), 'PublishTaskPage 含裸 <button>，应改用 ui/Button');
});

// ── D. 助理页只有「一个」发布面 ──
await check('D1 助理页把发布任务作为默认 Tab 的视图挂进去', () => {
  const ap = stripComments(read('components/AssistantPage.tsx'));
  assert.match(ap, /<PublishTaskPage/, '助理页未挂 PublishTaskPage');
  assert.match(ap, /onAutoRun=\{onAutoRun\}/, '助理页未把自动构建出口透传下去');
});

await check('D2 发布任务的中英文案齐全（不会出现裸 key）+ 占位符双侧一致', () => {
  const need = [
    'title', 'subtitle', 'goalLabel', 'goalPlaceholder', 'teamLabel', 'teamAuto',
    'kindLabel', 'kindComplex', 'kindScheduled', 'repeatLabel', 'repeatOption',
    'validLabel', 'timeLabel', 'confirmComplex', 'confirmScheduled',
    'hintTeam', 'hintAuto', 'hintScheduled', 'needGoal', 'needThread',
    'dispatchFailed', 'dispatched', 'scheduledCreated', 'scheduledFailed',
    'boardTitle', 'boardEmpty', 'boardTaskCount', 'statusRunning', 'statusFailed',
  ];
  const zh = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/zh-CN/assistant.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/en-US/assistant.json'), 'utf8'));
  const holders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
  for (const k of need) {
    assert.equal(typeof zh.publish?.[k], 'string', `zh-CN 缺 assistant.publish.${k}`);
    assert.equal(typeof en.publish?.[k], 'string', `en-US 缺 assistant.publish.${k}`);
    assert.equal(holders(zh.publish[k]), holders(en.publish[k]), `占位符不一致：${k}`);
  }
});

await check('D3 定时计划预览的文案键存在（双侧）——「下次运行」不能是硬编码中文', () => {
  const keys = ['planForever', 'planUntil', 'noNextRun'];
  for (const lang of ['zh-CN', 'en-US']) {
    const d = JSON.parse(fs.readFileSync(path.join(SRC, `i18n/locales/${lang}/scheduled.json`), 'utf8'));
    for (const k of keys) assert.equal(typeof d[k], 'string', `${lang} 缺 scheduled.${k}`);
  }
});

// ── E. validateCron 的失败路径（发布页用它把关，不能只测成功路径）──
await check('E1 非法 cron 逐类给出可读错误（字段数 / 字符合法性 / 数值越界）', () => {
  assert.ok(validateCron('0 9 * *', t), '字段数不足应报错');
  assert.ok(validateCron('0 9 * * MON', t), '非数字字符应报错');
  assert.ok(validateCron('99 9 * * *', t), '分钟越界应报错');
  assert.equal(validateCron('0 9 * * *', t), null, '合法表达式不应报错');
});

console.log(`\npublish-task-flow: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
