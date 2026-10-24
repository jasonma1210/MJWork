// 测试总入口（2026-10-15 门禁加固）
//
// 背景（真机事故）：`npm test` 原为 83 个套件用 `&&` 串联，任一套件**崩溃**（非断言失败，
//   而是 ERR_DLOPEN_FAILED 这类顶层抛错导致进程非零退出）会中断整条链，其后所有套件
//   **静默不执行**。实测 orchestrator.test.js 因 better-sqlite3 与 Node ABI 不匹配崩溃后，
//   其后 41 个套件（含全部 M3/M4 新能力）从未被跑过，而 CI 照样亮绿——门禁假绿。
//
// 改为「发现式 + 全量跑完 + 末尾汇总」：
//   1. 发现式：自动发现 test/*.test.{js,mjs} + 两个 smoke 套件，新增套件**无需注册**即被
//      跑到（此前 role-preset.test.mjs 就是漏注册的活证据）。
//   2. 全量跑完：单套件崩溃只记录，不阻断后续；最后按失败清单以非零退出码报错。
//   3. 汇总输出：FAIL 列表集中在末尾，一眼看到「哪些没过、哪些崩了」，不再被截断在中间。
//   4.（第六轮 G11）前置门禁：把外部命令级门禁（eval --check）也纳入基线，非零退出同套件一样计失败——
//      避免「npm run eval 存在却无人触发」的假绿。
//
// 保留既有的顺序执行（不并发）：多套件共用 tmpdir / 全局 stub，并发会互相污染。
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { summarize } from './helpers/summary.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
// S6-③：每个套件都注入 preload —— 把「被 process.exit(0) 吞掉的 unhandled rejection」变成失败。
// 为什么必须在这里统一注入：产品侧 main.js:476/486 有 uncaughtException/unhandledRejection 兜底，
// 套件级或 `--unhandled-rejections=strict` 都拦不住（实测），只有先于一切的 preload 能判死。
const PRELOAD = path.join(TEST_DIR, 'helpers/unhandled-preload.cjs');

// 套件发现：*.test.js / *.test.mjs（目录自动发现，防漏注册）+ 明确登记的 smoke 套件
// （smoke-*.mjs 不叫 *.test.*，故单独列出；它们是加载冒烟，同样必须进基线）。
const SMOKE = ['smoke-load.mjs', 'render-smoke.mjs'];

function discover() {
  const tests = readdirSync(TEST_DIR)
    .filter((f) => /\.test\.(js|mjs)$/.test(f))
    .sort()
    .map((f) => `test/${f}`);
  const smoke = SMOKE
    .filter((f) => existsSync(path.join(TEST_DIR, f)))
    .map((f) => `test/${f}`);
  // smoke 先跑：加载冒烟挂了说明渲染层/主进程加载即炸，后续套件结果无参考价值，应尽早暴露
  return [...smoke, ...tests];
}

const suites = discover();
const failed = [];   // 非零退出（断言失败 或 崩溃）
const crashed = [];  // 崩溃特指：套件自身进程异常退出（含未捕获异常 / NODE_MODULE_VERSION 不匹配等）
const skipped = [];  // C2（2026-10-16）：套件内明确声明的「跳过/未执行」行（如非 Linux 平台跳过 bwrap 真机探测）

// G11（第六轮）：离线评估自检（eval --check）纳入基线。
// 事故背景：`npm run eval` 存在但无任何自动触发方（CI 与 npm test 都不过它），评估任务集/schema
// 腐化、fail-to-pass 基线失效都无人发现。这里作为「前置门禁」在套件之前跑，零成本（不出网、不调模型），
// 非零退出计入失败清单（与套件同口径）。
//
// 2026-10-20（第七轮收口）新增两项，理由与 G11 完全同型——「只能靠人记得手动跑」等于没有门禁：
//   · doc-fact-check：技术设计文档数字/引用核对。本轮它因文档数字漂移**红了一整轮没人发现**，
//     因为除了我没人记得跑它。
//   · harness-r7:check：第七轮审查的 76 条断言（缺陷存在性 + 结构不变量），是本轮全部修复的
//     契约基线；它退出码为 1 时=有真问题，别静默跳过。
// 已知软点（记账，不硬凑）：harness-r7:check 的 BLOCKED（前置 import 失败）按设计**不判红**——
// 那是「没验成」而非「通过」，判据逻辑见该脚本末尾的判读段。
// 两个脚本都住在 `docs/harness-r7/` 与 `desktop/scripts/`，**刻意不进 `test/`**（发现式扫描会把
// 它们计入套件基线，制造假回归）；这里按绝对路径显式引用，不计入 suites.length。
const REPO_ROOT = path.resolve(ROOT, '..');

// 2026-10-21（第八轮 D-807② / C-03）：i18n 两条检查也属于「存在却无人自动触发」的假绿 ——
//   脚本一直在 `scripts/` 里躺着，CI 与 npm test 都不过它，于是「硬编码中文」「中英键集漂移」
//   只能靠人肉发现。与上面两项完全同型，故一并纳入前置门禁：
//   · i18n-scan：扫「注释剥离后」的裸中文残留（UI 文案必须走 i18n key，不许硬编码）；
//   · i18n-modcheck：中英双侧语言包的键集 / 叶子类型 / `{var}` 插值参数一致性，逐模块查。
// **两条都自证会红**（这是它们能当门禁的前提，别改成恒绿）：无参调用 exit 2（用法错误），
// 有残留或缺键 exit 1。套件 `test/i18n-gates.test.mjs` 对这两条做了变异式反向验证。
// 与上面两项同纪律：脚本刻意不进 `test/`（发现式扫描会把它们计入套件基线），
// 这里按绝对路径显式引用，不计入 suites.length。
const I18N_ZH_DIR = path.join(ROOT, 'renderer/src/i18n/locales/zh-CN');
const i18nModules = readdirSync(I18N_ZH_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

const GATES = [
  { label: 'eval:check（离线评估自检）', args: ['eval/run-eval.mjs', '--check'] },
  { label: 'doc-fact-check（技术设计文档数字核对）', args: [path.join(ROOT, 'scripts/doc-fact-check.mjs')] },
  { label: 'harness-r7:check（第七轮审查判据 76 断言）', args: [path.join(REPO_ROOT, 'docs/harness-r7/04-test/check.mjs'), REPO_ROOT] },
  { label: 'i18n-scan（renderer 裸中文残留）', args: [path.join(ROOT, 'scripts/i18n-scan.mjs'), path.join(ROOT, 'renderer/src')] },
  { label: `i18n-modcheck（${i18nModules.length} 个模块双侧键集）`, args: [path.join(ROOT, 'scripts/i18n-modcheck.mjs'), ...i18nModules] },
];

console.log(`前置门禁 ${GATES.length} 项（外部命令级，非 test/*.test.*）\n`);
for (const g of GATES) {
  const started = Date.now();
  const r = spawnSync(process.execPath, g.args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
  });
  const ms = Date.now() - started;
  if (r.status === 0) {
    console.log(`✅ ${g.label}  (${ms}ms)`);
  } else {
    failed.push(g.label);
    console.log(`❌ ${g.label}  (${ms}ms)`);
    console.log(`${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-8).map((l) => `      ${l}`).join('\n'));
  }
}

console.log(`\n发现 ${suites.length} 个测试套件（发现式，无需注册）\n`);

for (const [i, suite] of suites.entries()) {
  const label = `[${String(i + 1).padStart(2)}/${suites.length}] ${suite}`;
  const started = Date.now();
  // 单套件超时 180s：卡死套件不应拖死整条基线（超时记失败并继续）
  const r = spawnSync(process.execPath, ['--require', PRELOAD, path.join(ROOT, suite)], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    killSignal: 'SIGKILL',
  });
  const ms = Date.now() - started;
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const body = `${r.stdout || ''}${r.stderr || ''}`;
  // 崩溃特征：非断言失败，而是套件进程自身没跑完（加载期抛错 / 信号终止 / 超时）
  const isCrash = timedOut
    || (r.status !== 0 && r.status !== 1)
    || (r.signal != null)
    || /ERR_DLOPEN_FAILED|MODULE_NOT_FOUND|SyntaxError|NODE_MODULE_VERSION/.test(body);

  // C2：把「平台相关未执行」显式记账——套件 PASS 不等于该平台已验证，
  // 汇总里单列这些行，避免「全绿」被误读为「所有平台行为都已覆盖」。
  for (const line of body.split('\n')) {
    if (/⚠.*(跳过|未执行)/.test(line)) skipped.push({ suite, detail: line.trim().slice(0, 160) });
  }

  if (r.status === 0) {
    console.log(`✅ ${label}  (${ms}ms)`);
  } else {
    failed.push(suite);
    if (isCrash) crashed.push({ suite, detail: timedOut ? '超时(>180s)' : (r.signal || `exit ${r.status}`) });
    console.log(`❌ ${label}  (${ms}ms)${isCrash ? '  [崩溃/超时]' : ''}`);
    // 保留失败上下文，便于就地定位（全量跑完 + 失败详情不被中间日志冲掉）
    console.log(body.trim().split('\n').slice(-8).map((l) => `      ${l}`).join('\n'));
  }
}

console.log('\n──────── 测试基线汇总 ────────');
// C-04（2026-10-21）：口径由 `通过 = 总计 − 失败` 改为**三数齐全** —— 跳过从「通过」里扣掉。
// 旧口径把 darwin 上从未真跑的 3 个沙箱套件算成「通过」，属于用「没验」冒充「验过」。
// 跳过不影响退出码（平台限制不是缺陷），但读数时不能再被当成已验证。判定逻辑见 test/helpers/summary.mjs。
const summary = summarize({
  total: suites.length + GATES.length,
  failed,
  skipLines: skipped,
});
if (!summary.ok) {
  console.error(`❌ 汇总等式自洽校验失败：总计=${summary.total} 通过=${summary.passed} 失败=${summary.failed} 跳过=${summary.skipped}`);
  process.exitCode = 1;
}
console.log(`总计 ${summary.total} · 通过 ${summary.passed} · 失败 ${summary.failed} · 跳过 ${summary.skipped}`);
if (failed.length > 0) {
  console.log(`\n失败套件（${failed.length}）：`);
  for (const s of failed) console.log(`  ✗ ${s}`);
}
if (crashed.length > 0) {
  console.log(`\n崩溃/超时（${crashed.length}）—— 这类是套件没跑完，务必修复后重跑基线：`);
  for (const c of crashed) console.log(`  ✗ ${c.suite} — ${c.detail}`);
  console.log('  提示：better-sqlite3 报 NODE_MODULE_VERSION 时，先 `npm rebuild better-sqlite3`');
}
if (skipped.length > 0) {
  console.log(`\n未执行/跳过（${skipped.length}）—— 这些**不代表已验证**，对应平台需单独跑：`);
  for (const s of skipped) console.log(`  ⚠ ${s.suite} — ${s.detail}`);
}
process.exit(failed.length === 0 ? 0 : 1);
