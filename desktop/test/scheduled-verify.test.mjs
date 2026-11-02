#!/usr/bin/env node
// 定时任务通道 V 层（第三轮审查后的落地项）回归
//
// 三件事必须锁死：
//   ① 触发策略：L1 全量、L3 只在风险门/抽样命中时才跑（否则等于每任务多一次模型调用）
//   ② 无人值守 fail-closed：判不出来（no_chat / 超时 / 解析失败）或守卫型 FLAG
//      **不得宣告成功**；但「闸门判定不值得跑」和「抽样只用于度量」都不许降级交付
//   ③ 任务级熔断：连续失败到阈值自动暂停
//
// 判据：把 shouldRunL3 的 risk 分支删掉、把 decideDelivery 的 triggered 守卫删掉、
// 或把抽样也当守卫 —— 本套件必须变红。
import { readFileSync } from 'node:fs';
import { hasRiskyAction, shouldRunL3, decideDelivery, shouldAutoPause, shellIsExternal } from '../main/verifyPolicy.js';
import { createScheduledVerify } from '../main/scheduledVerify.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① 风险面识别 ──
const led = (...entries) => entries.map((e, i) => ({ i, ok: true, ...e }));

check('本地写文件不算「对外/不可逆」（否则每个编码类定时任务都要付一次 L3）',
  hasRiskyAction(led({ name: 'write_file', paths: ['a.js'] })) === false);
check('同一台账按 scope=any 才算风险（口径显式，不靠猜）',
  hasRiskyAction(led({ name: 'write_file' }), 'any') === true);
check('mcp__ 外部服务的写操作按不可逆处理',
  hasRiskyAction(led({ name: 'mcp__github__create_issue' })) === true);
check('git_commit 属对外动作', hasRiskyAction(led({ name: 'git_commit' })) === true);
check('shell 里的 git push 属对外动作', hasRiskyAction(led({ name: 'shell', command: 'git push origin main' })) === true);
check('shell 里的 npm test 不算对外动作', hasRiskyAction(led({ name: 'shell', command: 'npm test' })) === false);
check('失败的写操作不产生副作用，不触发 L3',
  hasRiskyAction([{ i: 0, ok: false, name: 'git_commit' }]) === false);
check('分隔符后的破坏性命令也能识别（&& rm -rf）', shellIsExternal('npm run build && rm -rf dist') === true);

// ── ② 触发策略 ──
const riskyLedger = led({ name: 'git_commit' });
const safeLedger = led({ name: 'read_file' });

check('l1 档位永不跑 L3（L3 是 opt-in 成本）',
  shouldRunL3({ level: 'l1', verdict: 'PASS', ledger: riskyLedger }) === false
  || shouldRunL3({ level: 'l1', verdict: 'PASS', ledger: riskyLedger }).run === false);
check('l3 + 命中风险门 → 跑，理由是 risk',
  shouldRunL3({ level: 'l3', verdict: 'PASS', ledger: riskyLedger }).why === 'risk');
check('l3 + 无风险 + 未抽样 → 不跑（零成本）',
  shouldRunL3({ level: 'l3', verdict: 'PASS', ledger: safeLedger, trigger: { risk: true, sampleRate: 0 } }).run === false);
check('抽样命中 → 跑，理由是 sample（注入随机源，不靠概率 flaky）',
  shouldRunL3({ level: 'l3', verdict: 'PASS', ledger: safeLedger, trigger: { sampleRate: 0.05 }, rand: () => 0.01 }).why === 'sample');
check('抽样未命中 → 不跑', shouldRunL3({
  level: 'l3', verdict: 'PASS', ledger: safeLedger, trigger: { sampleRate: 0.05 }, rand: () => 0.9,
}).run === false);
check('L1 BLOCK 默认短路（确定性结论不需要第二意见）',
  shouldRunL3({ level: 'l3', verdict: 'BLOCK', ledger: riskyLedger }).why === 'block_short_circuit');
check('显式打开 onBlock 才为 BLOCK 补第二意见',
  shouldRunL3({ level: 'l3', verdict: 'BLOCK', ledger: riskyLedger, trigger: { onBlock: true } }).why === 'on_block');

// ── ③ 交付裁决（fail-closed）──
check('L1 BLOCK → 一律降级（无人值守/有人值守都一样）',
  decideDelivery({ verify: { verdict: 'BLOCK', reason: 'claim_write_no_evidence' } }).downgrade === true);
check('闸门判定「不值得跑」不许当成「没验成」',
  decideDelivery({ verify: { verdict: 'PASS', l3: { triggered: false, skipped: true, why: 'not_triggered' } }, failClosed: true }).downgrade === false);
check('抽样型 L3 判 FLAG 不降级（抽样是度量，不是守卫）',
  decideDelivery({ verify: { verdict: 'PASS', l3: { triggered: true, why: 'sample', verdict: 'FLAG', reasons: ['x'] } }, failClosed: true }).downgrade === false);
check('守卫型 L3 判 FLAG → 降级（守卫才管交付）',
  decideDelivery({ verify: { verdict: 'PASS', l3: { triggered: true, why: 'risk', verdict: 'FLAG', reasons: ['证据不足'] } }, failClosed: true }).downgrade === true);
check('守卫型 L3 没跑成（no_chat）→ 降级（无人值守不认「没验」）',
  decideDelivery({ verify: { verdict: 'PASS', l3: { triggered: true, why: 'risk', skipped: true, reason: 'no_chat' } }, failClosed: true }).downgrade === true);
check('同一份结论在有人值守通道（failClosed=false）不降级',
  decideDelivery({ verify: { verdict: 'PASS', l3: { triggered: true, why: 'risk', skipped: true, reason: 'no_chat' } }, failClosed: false }).downgrade === false);
check('守卫型 L3 PASS → 正常放行',
  decideDelivery({ verify: { verdict: 'PASS', l3: { triggered: true, why: 'risk', verdict: 'PASS' } }, failClosed: true }).downgrade === false);

// ── ④ 熔断 ──
check('连续失败 3 次触发自动暂停', shouldAutoPause({ failStreak: 3 }) === true);
check('失败 2 次不暂停', shouldAutoPause({ failStreak: 2 }) === false);
check('阈值为 0/非法时回落 3（不因配置错把任务永久停摆）', shouldAutoPause({ failStreak: 1, threshold: 0 }) === false);

// ── ⑤ 装配层：真的接上了引擎台账，且子代理事件不污染 ──
{
  const sv = createScheduledVerify({ taskId: 't1', cwd: '', level: 'l1' });
  check('装配层默认档是 l1（L1 全量跑，零成本）', sv.level === 'l1');
  check('父 run 的 verify_ledger 被接收', sv.onTrace({ type: 'verify_ledger', entries: led({ name: 'read_file' }) }) === true);
  check('子代理（sub:true）的台账被拒绝（属于子 run，不污染本任务）',
    sv.onTrace({ type: 'verify_ledger', sub: true, entries: led({ name: 'write_file' }) }) === false);
}
{
  // 没有台账 → N9 必须如实 SKIP(no_ledger)，绝不静默 PASS
  const sv = createScheduledVerify({ taskId: 't2', cwd: '', level: 'l1' });
  const r = await sv.finish('做完了');
  check('无台账时如实 SKIP(no_ledger)（不静默 PASS）',
    r.verify.verdict === 'SKIP' && r.verify.reason === 'no_ledger',
    `verdict=${r.verify.verdict} reason=${r.verify.reason}`);
  check('l1 档位的 SKIP 不降级交付（L1 无判定 ≠ 未验证）', r.delivery.downgrade === false);
}
{
  // l3 档 + 风险台账 + 未注入 chat：必须如实标 no_chat 且降级交付
  const sv = createScheduledVerify({ taskId: 't3', cwd: '', level: 'l3', l3Chat: null });
  sv.onTrace({ type: 'verify_ledger', entries: led({ name: 'git_commit' }) });
  const r = await sv.finish('已提交');
  check('l3 + 风险动作 + 未注入 chat → L3 标记 triggered 且 skipped(no_chat)',
    r.verify.l3?.triggered === true && r.verify.l3?.reason === 'no_chat',
    JSON.stringify(r.verify.l3));
  check('上述情况在无人值守通道必须降级交付（fail-closed）', r.delivery.downgrade === true);
}

// ── ⑥ 熔断触发点与 tick 实际传入的 trigger 字面量必须一致 ──
// 真实踩过：第一版把条件写成 trigger === 'schedule'，而 tick 传的是 'scheduled' ——
// 条件永不成立，熔断静默失效且任何行为测试都不会红（因为根本没有触发路径）。
// 这里从源码里**取出**实际调用字面量再比对，而不是把常量抄一遍。
{
  const src = readFileSync(new URL('../main/scheduler.js', import.meta.url), 'utf8');
  // RQ-07（2026-11-03）：自动触发改由 dispatchRun 统一入口（带并发闸），
  // 字面量提取必须同时认两个入口，否则锚点会「取到 0 个」而自检直接红。
  const fired = [...src.matchAll(/(?:runTask|dispatchRun)\(t\.id,\s*'([^']+)'/g)].map((m) => m[1]);
  check('scheduler 里存在自动触发调用点（锚点自检）', fired.length > 0, fired.join(','));
  const missed = fired.filter((v) => !src.includes(`trigger === '${v}'`));
  check('每个自动 trigger 字面量都被熔断条件覆盖（防拼写不一致导致永不熔断）',
    missed.length === 0, missed.length ? `未覆盖：${missed.join(',')}` : fired.join(','));
}

console.log(`\nscheduled-verify: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
