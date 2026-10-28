// P3-1/P3-2/P3-3 ResourceQuotaCenter 单元测试：
// fg 槽位预占与释放 / bg 预算隔离（limit - fgReserve）/ busy 态 bg 让路（cap=1）/
// 错误连击熔断（≥5 次开 5 分钟）/ bgAllowed / throttleState / snapshot 结构
const { ResourceQuotaCenter, OVERLOAD_THRESHOLD } = require('../main/resourceQuotaCenter');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── fg 槽位预占：拿到即占用，释放即归还 ──
  const q = new ResourceQuotaCenter({ providerLimit: 3, fgReserve: 1 });
  const s1 = await q.acquire('fg', 'p1');
  check('fg acquire 占用 1 槽', q.snapshot().providers.p1.fg === 1);
  const s2 = await q.acquire('fg', 'p1');
  const s3 = await q.acquire('fg', 'p1');
  check('limit=3 时第 4 个 fg 请求被阻塞', await Promise.race([
    q.acquire('fg', 'p1').then(() => false).catch(() => false),
    sleep(400).then(() => true),
  ]));
  s3.release();
  const s4 = await q.acquire('fg', 'p1');
  check('释放后新 fg 请求立即获得槽位', q.snapshot().providers.p1.fg === 3);
  s1.release(); s2.release(); s4.release();
  check('全部释放后 fg 归零', q.snapshot().providers.p1.fg === 0);

  // ── bg 预算隔离：bg 上限 = limit - fgReserve ──
  const q2 = new ResourceQuotaCenter({ providerLimit: 4, fgReserve: 2 });
  await q2.acquire('bg', 'p1'); // 1
  await q2.acquire('bg', 'p1'); // 2 = ceiling
  const bgBlocked = await Promise.race([
    q2.acquire('bg', 'p1').then(() => false),
    sleep(400).then(() => true),
  ]);
  check('bg 槽位达到 ceiling（4-2=2）后不再放行', bgBlocked === true);
  check('bg 超时抛错（含 limit 信息）', await q2.acquire('bg', 'p1', { timeoutMs: 200 })
    .then(() => false)
    .catch((e) => String(e.message).includes('资源槽位等待超时')));

  // ── busy 态 bg 让路：fg 在飞 > 0 时 bg cap = 1 ──
  const q3 = new ResourceQuotaCenter({ providerLimit: 8, fgReserve: 2 });
  await q3.acquire('fg', 'p1'); // fg 在飞 → busy
  await q3.acquire('bg', 'p1');
  const blocked = await Promise.race([
    q3.acquire('bg', 'p1').then(() => false),
    sleep(300).then(() => true),
  ]);
  check('busy 态第二个 bg 请求被让路阻塞', blocked === true);
  check('busy 态可见于 throttleState', q3.throttleState() === 'busy');
  // fg 释放后仍 busy=false？不：还有一个 bg 在飞，throttle 只看 fg → idle
  // （throttle 只统计 fg，bg 在飞不算 busy——语义正确：bg 自己让路自己）

  // ── 错误连击熔断 ──
  const q4 = new ResourceQuotaCenter({ providerLimit: 8, fgReserve: 2 });
  for (let i = 0; i < OVERLOAD_THRESHOLD; i += 1) q4.reportError('p1');
  check(`连续 ${OVERLOAD_THRESHOLD} 次错误后熔断开启`, q4.throttleState() === 'overloaded');
  check('熔断期间 bg 全停（bgAllowed=false）', q4.bgAllowed() === false);
  // P0-1 修订（2026-10-28）：原断言「熔断期间 fg 也被阻塞」**锁的正是缺陷本身**。
  // provider 连续报错后，用户主会话 / 手动派活 / 定时任务会在 5 分钟里每次干等 30s
  // 再抛「资源槽位等待超时…熔断中」——用户感知是「应用整体卡死」。
  // 而本模块文件头的规格写的是「overload … bg 全停，**fg 照常**（用户自己会看到错误）」。
  // 现语义：熔断只降级可牺牲的后台流量，前台照常拿到槽位（并发仍受 providerLimit 约束）。
  check('熔断期间 fg acquire 不受影响（只降级 bg）', await Promise.race([
    q4.acquire('fg', 'p1').then(() => true),
    sleep(300).then(() => false),
  ]));
  // 反向守护：不能为了「让 fg 通」把熔断整体关掉——bg 必须仍然被挡（见上面 bgAllowed 断言）
  check('熔断期间 bg 仍被挡（熔断机制本身未被削弱）', q4.bgAllowed() === false);
  const q5 = new ResourceQuotaCenter({ providerLimit: 8, fgReserve: 2 });
  q5.reportError('p1'); q5.reportError('p1');
  q5.reportSuccess('p1');
  q5.reportError('p1'); q5.reportError('p1'); q5.reportError('p1'); q5.reportError('p1');
  check('reportSuccess 重置连击（未达阈值不熔断）', q5.throttleState() === 'idle' && q5.bgAllowed() === true);

  // ── provider 隔离 + snapshot 结构 ──
  const q6 = new ResourceQuotaCenter({ providerLimit: 2, fgReserve: 1 });
  await q6.acquire('fg', 'a');
  await q6.acquire('bg', 'b');
  const snap = q6.snapshot();
  check('多 provider 各自记账', snap.providers.a.fg === 1 && snap.providers.b.bg === 1);
  check('snapshot 结构完整（providers/throttle/localBackend/ts）',
    typeof snap.throttle === 'string' && 'localBackend' in snap && typeof snap.ts === 'number');

  // ── bgAllowed：无熔断即放行（含零 provider 场景）──
  const q7 = new ResourceQuotaCenter({});
  check('无任何 provider 记录时 bg 放行', q7.bgAllowed() === true);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
