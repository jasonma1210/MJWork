// T1 回归门禁：流式超时必须是「空闲语义」，不能是「总时长语义」。
//
// 事故形态（2026-10-17，用户实测）：mimo（推理模型）思考阶段长时间没有正文，
//   单轮总时长 >120s 就被 withTimeout/AbortSignal.timeout 杀掉，文案还写「无响应」——
//   模型明明在正常思考。表现为「打字打到一半整轮作废」。
//
// 本门禁两层：
//   ① 行为：createStreamGuard 的三层计时各自成立，且 touch() 能续命；
//   ② 源码：main.js 不得退回 AbortSignal.timeout 一把尺，且读流循环必须 touch。
//
// 反向用例设计（关键）：用例「持续有数据不触发」只有在 touch 真的重置计时时才绿。
// 若有人把 touch 写成空实现，这条会红——这是本文件唯一的有效自检点。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const {
  createStreamGuard, streamTimeoutMessage, resolveDefaults, DEFAULTS, LOCAL_DEFAULTS,
  isLocalEndpoint, ttfbTargetFor, TTFB_TARGET_MS, TTFB_TARGET_LOCAL_MS,
} = require(path.join(ROOT, 'main/streamGuard.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.log(`[FAIL] ${name}\n       ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.log(`[FAIL] ${name}\n       ${e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// A10 守卫辅助：去除 JS 行/块注释，仅保留「生效」源码，用于判断 token 是否真正参与执行。
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// 起一个守卫，记录触发原因与次数
function arm(opts) {
  const fired = [];
  const guard = createStreamGuard({ tickMs: 10, ...opts, onFire: (r) => fired.push(r) });
  return { guard, fired };
}

await checkAsync('首字节超时：连接建立但一个字节都不回 → first-byte', async () => {
  const { guard, fired } = arm({ firstByteMs: 40, idleMs: 10000, totalMs: 10000 });
  guard.start();
  await sleep(90);
  guard.stop();
  assert(fired.length === 1, `应触发 1 次，实际 ${fired.length}`);
  assert(fired[0] === 'first-byte', `应为 first-byte，实际 ${fired[0]}`);
});

await checkAsync('首字节达成后不再因首字节计时被杀', async () => {
  const { guard, fired } = arm({ firstByteMs: 40, idleMs: 10000, totalMs: 10000 });
  guard.start();
  guard.firstByte();
  await sleep(80);
  guard.stop();
  assert(fired.length === 0, `不应触发，实际 ${fired.join(',')}`);
});

await checkAsync('持续有数据不触发（touch 必须真的续命）——反向自检点', async () => {
  const { guard, fired } = arm({ firstByteMs: 10000, idleMs: 60, totalMs: 10000 });
  guard.start();
  guard.firstByte();
  // 每 15ms 一个 chunk，总时长 150ms 远超 idle 60ms
  for (let i = 0; i < 10; i += 1) { await sleep(15); guard.touch(); }
  guard.stop();
  assert(fired.length === 0, `持续有数据时不应触发，实际触发 ${fired.join(',')}`);
});

await checkAsync('真挂起（无任何数据）→ idle', async () => {
  const { guard, fired } = arm({ firstByteMs: 10000, idleMs: 60, totalMs: 10000 });
  guard.start();
  guard.firstByte();
  await sleep(120);
  guard.stop();
  assert(fired[0] === 'idle', `应为 idle，实际 ${fired.join(',')}`);
});

await checkAsync('总时长优先于空闲（同一时刻命中时归因更硬的那层）', async () => {
  const { guard, fired } = arm({ firstByteMs: 10000, idleMs: 10000, totalMs: 60 });
  guard.start();
  guard.firstByte();
  for (let i = 0; i < 10; i += 1) { await sleep(12); guard.touch(); }
  guard.stop();
  assert(fired[0] === 'total', `应为 total，实际 ${fired.join(',')}`);
});

await checkAsync('只触发一次（多个定时器不得重复回调）', async () => {
  const { guard, fired } = arm({ firstByteMs: 30, idleMs: 30, totalMs: 30 });
  guard.start();
  await sleep(100);
  guard.stop();
  assert(fired.length === 1, `只应触发 1 次，实际 ${fired.length} 次`);
});

await checkAsync('stop 之后不再触发（请求已结束，不能误杀下一次）', async () => {
  const { guard, fired } = arm({ firstByteMs: 30, idleMs: 30, totalMs: 30 });
  guard.start();
  guard.stop();
  await sleep(80);
  assert(fired.length === 0, `stop 后不应触发，实际 ${fired.join(',')}`);
});

await checkAsync('传 <=0 视为禁用该层（直连路径不加总时长上限）', async () => {
  const { guard, fired } = arm({ firstByteMs: 0, idleMs: 0, totalMs: 0 });
  guard.start();
  guard.firstByte();
  await sleep(80);
  guard.stop();
  assert(fired.length === 0, `全禁用时不应触发，实际 ${fired.join(',')}`);
});

await checkAsync('默认值符合方案（首字节 90s / 空闲 300s / 总 15min）', async () => {
  assert(DEFAULTS.firstByteMs === 90000, `firstByteMs=${DEFAULTS.firstByteMs}`);
  assert(DEFAULTS.idleMs === 300000, `idleMs=${DEFAULTS.idleMs}`);
  assert(DEFAULTS.totalMs === 900000, `totalMs=${DEFAULTS.totalMs}`);
});

await checkAsync('环境变量可覆盖，非法值回落默认', async () => {
  const d = resolveDefaults({ MJ_STREAM_IDLE_MS: '60000', MJ_STREAM_TOTAL_MS: 'oops' });
  assert(d.idleMs === 60000, `idleMs 应被覆盖为 60000，实际 ${d.idleMs}`);
  assert(d.totalMs === DEFAULTS.totalMs, `非法值应回落默认，实际 ${d.totalMs}`);
});

await checkAsync('文案说人话：三种原因互不混淆，且不再声称「无响应」', async () => {
  const fb = streamTimeoutMessage('first-byte', { firstByteMs: 90000 });
  const idle = streamTimeoutMessage('idle', { idleMs: 300000 });
  const total = streamTimeoutMessage('total', { totalMs: 900000 });
  assert(fb.includes('没有收到任何数据') && fb.includes('排队'), `首字节文案不准确：${fb}`);
  assert(idle.includes('没有收到任何数据') && idle.includes('继续'), `空闲文案不准确：${idle}`);
  assert(total.includes('总上限'), `总时长文案不准确：${total}`);
  for (const m of [fb, idle, total]) {
    assert(!m.includes('无响应'), `不应再出现「无响应」这种把「在思考」说成「死了」的措辞：${m}`);
  }
});

check('源码：main.js 不再用 AbortSignal.timeout 一把尺', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  // 只匹配「调用形态」（timeout(125000)] 出现在 signal 数组里），注释里提到历史值不算
  assert(!/AbortSignal\.timeout\(125000\)\s*\]/.test(src), 'main.js 仍存在 AbortSignal.timeout(125000) 调用');
  assert(src.includes('createStreamGuard'), 'main.js 未接入 createStreamGuard');
});

check('源码：读流循环里每个 chunk 都必须 touch（漏掉就会在思考阶段误杀）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  const i = src.indexOf('const { done, value } = await reader.read();');
  assert(i > 0, '未找到读流循环');
  const seg = src.slice(i, i + 400);
  assert(/streamGuard\.touch\(\)/.test(seg), 'read() 之后未见 streamGuard.touch()');
});

check('源码：读流循环里每个 chunk 都必须 touch（去注释，A10 守卫）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  const i = src.indexOf('const { done, value } = await reader.read();');
  assert(i > 0, '未找到读流循环');
  const seg = src.slice(i, i + 400);
  const segActive = stripJsComments(seg);
  assert(/streamGuard\.touch\(\)/.test(segActive), 'read() 之后（去注释）未见生效的 streamGuard.touch()');
});

check('源码：catch 里先判守卫原因，避免把超时当成用户主动中止', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  const i = src.indexOf('streamGuard.reason()');
  const j = src.indexOf("err.name === 'AbortError' && externalSignal?.aborted");
  assert(i > 0 && j > 0, '未找到守卫原因判定或用户中止判定');
  assert(i < j, '守卫原因判定必须在「用户主动中止」之前（否则超时被吞成 aborted）');
});

check('源码：引擎级兜底必须晚于主进程守卫（否则报不出具体原因）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
  const m = src.match(/DEFAULT_MODEL_TIMEOUT_MS\s*=\s*(\d+)/);
  assert(m, '未找到 DEFAULT_MODEL_TIMEOUT_MS');
  const engineMs = Number(m[1]);
  assert(engineMs > DEFAULTS.totalMs, `引擎兜底 ${engineMs}ms 必须大于主进程总上限 ${DEFAULTS.totalMs}ms`);
});

// ── 2026-11-03：本机推理端点（ollama）的超时档位 ──
// 事故实证：model=flint（localhost:11434，29GB）在 7.7 万 token prompt 上 prefill 未完成，
// 90014ms 被首字节守卫杀掉（prompt_tokens=0），用户看到「本次请求失败」并误判成"输出限制"。
await checkAsync('本地端点判定：只认回环地址，局域网/云端/非法一律按云端', async () => {
  assert(isLocalEndpoint('http://localhost:11434/v1') === true, 'localhost 应判本地');
  assert(isLocalEndpoint('http://127.0.0.1:8000/v1') === true, '127.0.0.1 应判本地');
  assert(isLocalEndpoint('http://[::1]:11434/v1') === true, '[::1] 应判本地');
  assert(isLocalEndpoint('https://api.deepseek.com') === false, '云端应判非本地');
  assert(isLocalEndpoint('http://192.168.1.5:11434/v1') === false, '局域网服务器不算本机端点');
  assert(isLocalEndpoint('') === false && isLocalEndpoint(null) === false, '空值不得判本地');
  assert(isLocalEndpoint('not-a-url') === false, '非法 URL 不得判本地（保守）');
});

await checkAsync('本地档位显著大于云端档位（否则 90s 误杀会复发）', async () => {
  assert(LOCAL_DEFAULTS.firstByteMs === 300000, `本地 firstByte=${LOCAL_DEFAULTS.firstByteMs}`);
  assert(LOCAL_DEFAULTS.firstByteMs > DEFAULTS.firstByteMs * 3, '本地首字节必须至少是云端的 3 倍');
  assert(LOCAL_DEFAULTS.idleMs > DEFAULTS.idleMs, '本地空闲上限应更宽');
  assert(LOCAL_DEFAULTS.totalMs > DEFAULTS.totalMs, '本地总上限应更宽');
});

await checkAsync('resolveDefaults 按 local 切换基准，环境变量仍可覆盖', async () => {
  const cloud = resolveDefaults({});
  const local = resolveDefaults({}, { local: true });
  assert(cloud.firstByteMs === DEFAULTS.firstByteMs, '云端默认不应被改动');
  assert(local.firstByteMs === LOCAL_DEFAULTS.firstByteMs, `本地默认未生效：${local.firstByteMs}`);
  const overridden = resolveDefaults({ MJ_STREAM_FIRST_BYTE_MS: '45000' }, { local: true });
  assert(overridden.firstByteMs === 45000, `环境变量必须优先于本地默认，实际 ${overridden.firstByteMs}`);
});

await checkAsync('首字节告警目标分档：本地 15s / 云端 3s（只影响日志）', async () => {
  assert(TTFB_TARGET_MS === 3000 && TTFB_TARGET_LOCAL_MS === 15000, '目标档位被改动');
  assert(ttfbTargetFor('http://localhost:11434/v1') === 15000, '本地端点应放宽到 15s');
  assert(ttfbTargetFor('https://api.deepseek.com') === 3000, '云端应维持 3s');
});

await checkAsync('streamSettings 按 baseUrl 选档（本机端点拿 300s，云端拿 90s）', async () => {
  const streamSettings = require(path.join(ROOT, 'main/streamSettings.js'));
  // 测试环境没有 localStore（未初始化）⇒ 读不到用户设置，走默认档
  const local = streamSettings.getStreamTimeouts({ baseUrl: 'http://localhost:11434/v1' });
  const cloud = streamSettings.getStreamTimeouts({ baseUrl: 'https://api.deepseek.com' });
  assert(local.firstByteMs === LOCAL_DEFAULTS.firstByteMs, `本机端点应拿 ${LOCAL_DEFAULTS.firstByteMs}，实际 ${local.firstByteMs}`);
  assert(cloud.firstByteMs === DEFAULTS.firstByteMs, `云端应拿 ${DEFAULTS.firstByteMs}，实际 ${cloud.firstByteMs}`);
  // 视图里要能说清两档默认值（否则设置页只显示 90s，用户以为本地也是 90s）
  const view = streamSettings.getStreamSettingsView();
  assert(view.localDefaults && view.localDefaults.firstByteMs === LOCAL_DEFAULTS.firstByteMs, '视图缺 localDefaults');
});

console.log(`\n结果：${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;
