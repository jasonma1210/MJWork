// 第八轮 C-04：测试基线汇总口径 —— 「跳过」不得计进「通过」
//
// 缺陷形态（第八轮 C-04 实测）：`run-all.mjs` 的汇总是一行内联表达式
//     `通过 = 套件数 + 门禁数 − 失败数`
// 于是 darwin 上从未真跑的 3 个沙箱套件被算成「通过」，汇总报「通过 259 · 失败 0」。
// 这是本项目最忌讳的一种假绿：**用「没验」冒充「验过」**。它比红更危险，
// 因为红会被人处理，而「全绿」会让人停止复核。
//
// 本套件锁五件事：
//   ① 无跳过时口径不变（零回归）；
//   ② 有跳过时从「通过」里扣掉，且 `通过+失败+跳过 === 总计` 恒成立（等式自洽）；
//   ③ 同一套件打印多行 ⚠ 只算一次（按套件去重，不按行数）；
//   ④ 既失败又报告跳过的项**只计失败**（否则同一项被扣两次，等式会破）；
//   ⑤ run-all.mjs 真的调用了这个口径，且旧的一行公式已不存在（防回退）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { summarize, readSandboxRealStatus } from './helpers/summary.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const line = (suite) => ({ suite, detail: '⚠ 本节未执行' });

// ── ① 无跳过：与旧口径一致（零回归）──
{
  const r = summarize({ total: 259, failed: [], skipLines: [] });
  check('① 无跳过：通过 = 总计（旧行为不变）', r.passed === 259 && r.skipped === 0 && r.ok);
  const r2 = summarize({ total: 259, failed: ['test/a.test.js'], skipLines: [] });
  check('① 有失败：通过 = 总计 − 失败', r2.passed === 258 && r2.failed === 1);
}

// ── ② 有跳过：必须从「通过」里扣掉，且等式自洽 ──
{
  const r = summarize({ total: 259, failed: [], skipLines: [line('s1'), line('s2'), line('s3')] });
  check('② 三个套件跳过 ⇒ 通过 = 259 − 3 = 256（不再是 259）', r.passed === 256, String(r.passed));
  check('② 跳过数单列上报', r.skipped === 3);
  check('② 等式自洽：通过 + 失败 + 跳过 === 总计',
    r.passed + r.failed + r.skipped === r.total, `${r.passed}+${r.failed}+${r.skipped}`);
  check('② ok=true（公式自身没坏）', r.ok === true);
}

// ── ③ 同一套件多行 ⚠ 只算一次 ──
{
  const r = summarize({
    total: 100, failed: [],
    skipLines: [line('sandbox-linux'), line('sandbox-linux'), line('sandbox-linux'), line('sandbox-mac')],
  });
  check('③ 同一套件 3 行 ⚠ 只扣 1（按套件去重，不按行数）', r.skipped === 2, `skipped=${r.skipped}`);
  check('③ 去重后仍满足等式', r.passed + r.failed + r.skipped === r.total);
  check('③ skippedSuites 不含重复项', new Set(r.skippedSuites).size === r.skippedSuites.length);
}

// ── ④ 既失败又跳过：只计失败，不双扣 ──
{
  const r = summarize({ total: 50, failed: ['s1'], skipLines: [line('s1'), line('s2')] });
  check('④ 既失败又跳过 ⇒ 失败计 1、跳过只计另 1 个', r.failed === 1 && r.skipped === 1,
    `failed=${r.failed} skipped=${r.skipped}`);
  check('④ 通过 = 50 − 1 − 1 = 48（没有把 s1 扣两次）', r.passed === 48, String(r.passed));
  check('④ 等式仍自洽（这就是「只计失败」的理由）', r.passed + r.failed + r.skipped === r.total);
}

// ── ⑤ 边界：全跳过 / 扣成负数时 ok=false（公式坏了要报）──
{
  const all = summarize({ total: 3, failed: [], skipLines: [line('a'), line('b'), line('c')] });
  check('⑤ 全部跳过 ⇒ 通过 0、仍 ok（平台限制不是缺陷）', all.passed === 0 && all.ok === true);
  const bad = summarize({ total: 1, failed: ['a', 'b'], skipLines: [] });
  check('⑤ 失败数超过总数 ⇒ ok=false（公式自洽校验生效，不静默给负数）',
    bad.ok === false, `passed=${bad.passed}`);
}

// ── ⑥ 接线：run-all.mjs 用新口径，且旧的一行公式已不存在 ──
{
  const src = fs.readFileSync(path.join(ROOT, 'test/run-all.mjs'), 'utf8');
  check('⑥ run-all 引入了汇总口径模块', /from '\.\/helpers\/summary\.mjs'/.test(src));
  check('⑥ 汇总行打印四项（总计/通过/失败/跳过）',
    /总计 \$\{summary\.total\} · 通过 \$\{summary\.passed\} · 失败 \$\{summary\.failed\} · 跳过 \$\{summary\.skipped\}/.test(src));
  check('⑥ 旧公式「通过 = 套件+门禁−失败」已删除（防回退）',
    !/通过 \$\{suites\.length \+ GATES\.length - failed\.length\}/.test(src));
  check('⑥ 等式不自洽时会显式报错并置非零退出码', /summary\.ok/.test(src) && /汇总等式自洽校验失败/.test(src));
}

// ── ⑦ 结构化沙箱状态解析（2026-11-05 AC-1.4：中文措辞匹配的假绿）──
//
// 缺陷形态：`run-all.mjs` 原靠 `/⚠.*(跳过|未执行)/` 记账「未验证」。
// `test/sandbox.test.js` 打的是 `SANDBOX_REAL_STATUS=BLOCKED` 与「⚠…BLOCKED」，
// **不含「跳过/未执行」**⇒ 正则全部 MISS ⇒ darwin 上 Seatbelt 真机未验证却被算作「通过」。
// 本组用真实输出片段锁住新判据，并刻意包含「未知状态」这条 fail-safe 方向。
{
  // 真实的 macOS 输出形态（宿主拒绝 sandbox_apply）
  const blockedBody = [
    '⚠ Seatbelt 真机探测 BLOCKED（宿主拒绝含 deny 的 profile：最小 deny-default profile 亦无法 apply）',
    '⚠ 真机隔离未验证（BLOCKED）：宿主拒绝 sandbox_apply，本轮只证明静态 profile 断言通过',
    'SANDBOX_REAL_STATUS=BLOCKED',
    'PASS：17/17 项通过',
  ].join('\n');
  const r1 = readSandboxRealStatus(blockedBody);
  check('⑦ BLOCKED ⇒ verified=false（这就是被算进「通过」的那个）', r1.verified === false && r1.status === 'BLOCKED');
  check('⑦ 旧中文正则对该输出确实全 MISS（证明缺陷真实存在，非臆测）',
    !/⚠.*(跳过|未执行)/.test(blockedBody), '该 body 不含「跳过」二字');

  const r2 = readSandboxRealStatus('SANDBOX_REAL_STATUS=RUN');
  check('⑦ 只有 RUN 才算真机已验证', r2.verified === true && r2.status === 'RUN');

  // 历史值带空格，必须归一化（否则 status 会是 'NOT RUN' 两个 token）
  const r3 = readSandboxRealStatus('SANDBOX_REAL_STATUS=NOT RUN');
  check('⑦ 历史空格写法归一化为 NOT_RUN 且未验证', r3.status === 'NOT_RUN' && r3.verified === false);

  const r4 = readSandboxRealStatus('SANDBOX_REAL_STATUS=ERROR');
  check('⑦ ERROR 不算已验证（隔离可能真有问题，更不能绿）', r4.verified === false);

  // fail-safe 方向：未知/拼错/未来新增的状态绝不能默认成已验证
  const r5 = readSandboxRealStatus('SANDBOX_REAL_STATUS=SOME_FUTURE_STATE');
  check('⑦ 未知状态 ⇒ verified=false（宁可多扣一个「通过」，不可少扣）', r5.verified === false);

  // 「没说」不等于「验过」：无状态行时 status=null，由调用方决定，函数不擅自判通过
  const r6 = readSandboxRealStatus('PASS：10/10 项通过');
  check('⑦ 无状态行 ⇒ status=null 且 verified=false，不冒充已验证',
    r6.status === null && r6.verified === false && r6.reason === 'no-status-line');

  // 多行取末尾（与 ci.yml:177 `tail -1` 同口径）；崩溃/中途打中间态时不能以中间态为准
  const r7 = readSandboxRealStatus('SANDBOX_REAL_STATUS=NOT_RUN\nSANDBOX_REAL_STATUS=RUN');
  check('⑦ 多行取最后一条（与 CI tail -1 同口径）', r7.status === 'RUN' && r7.verified === true);
  const r8 = readSandboxRealStatus('SANDBOX_REAL_STATUS=RUN\nSANDBOX_REAL_STATUS=ERROR');
  check('⑦ 末条为 ERROR ⇒ 不因前面出现过 RUN 而绿', r8.verified === false && r8.status === 'ERROR');

  // 接线：run-all 必须真的用它，否则上面全是对空函数的自娱自乐
  const runAll = fs.readFileSync(path.join(ROOT, 'test/run-all.mjs'), 'utf8');
  check('⑦ run-all 已接入结构化解析器', /readSandboxRealStatus/.test(runAll));
  check('⑦ run-all 对「非 RUN」显式记入跳过（不只打印）',
    /sandboxReal\.status !== null && !sandboxReal\.verified/.test(runAll));
  // 反向：套件里必须始终打印状态行，否则解析器永远拿不到（回到「没说当验过」）
  const sbTest = fs.readFileSync(path.join(ROOT, 'test/sandbox.test.js'), 'utf8');
  check('⑦ 状态行始终打印（无论 RUN/BLOCKED/NOT_RUN）', /SANDBOX_REAL_STATUS=\$\{realSandboxStatus\}/.test(sbTest));
  check('⑦ 状态初值为 NOT_RUN（归一化后单 token，可稳定解析）', /realSandboxStatus = 'NOT_RUN'/.test(sbTest));
}

void assert;
console.log(`\nsummary-math: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
