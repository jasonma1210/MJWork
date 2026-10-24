// S6 ①② 门禁的接入套件（批次 3-2）：把两个 audit 脚本接进 `npm test`。
//
// 为什么需要这个套件：两个脚本只有被人「记得跑」才有意义。本轮已经证明过这类失效——
// `doc-fact-check` 曾红了一整轮没人发现，就是因为没人记得跑。所以判据必须进基线。
//
// 本套件只做「接线 + 断言口径」，不复制脚本逻辑（避免两份实现漂移）：
//   ① `scripts/audit-exit-following.cjs`：process.exit 之后不得还有会被执行的代码（祖先链口径）
//   ② `scripts/audit-check-await.cjs`：helper 异步能力 + 裸 promise 语句 ratchet
// 两者都要求 exit 0，且**输出里必须带计数口径行**——只有 exit 0 不够：
//   脚本若因 bug 变成「扫到 0 个文件也 exit 0」，只看退出码是抓不到的（这也是本轮反复出现的形式）。
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 跑一个脚本，返回 {status, out} */
function run(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(DESKTOP, 'scripts', script), ...args], {
    cwd: DESKTOP,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ── ① exit-following（祖先链口径）──
{
  const r = run('audit-exit-following.cjs');
  check('audit-exit-following 退出码 0', r.status === 0, `status=${r.status}`);
  check('输出含祖先链口径计数（process.exit 调用 N 处）', /process\.exit 调用 \d+ 处/.test(r.out));
  check('输出含「之后仍有代码」计数（证明用的是祖先链而非同块口径）', /之后仍有代码 \d+ 处/.test(r.out));
  check('输出含「可能为 0 且之后有代码」已审登记计数', /「可能为 0 且之后有代码」\d+ 处/.test(r.out));
}

// ── ② check-await（① helper 硬红 + ② ratchet）──
{
  const r = run('audit-check-await.cjs');
  check('audit-check-await 退出码 0', r.status === 0, `status=${r.status}`);
  check('输出含 helper 判据两子类分列（async-capable N 处 = async 关键字型 + promise 返回型）',
    /async-capable \d+ 处（async 关键字型 \d+ \/ promise 返回型 \d+）/.test(r.out));
  check('promise 返回型（checkAsync 类）被检数 > 0（防这类被整类漏检）',
    /promise 返回型 ([1-9]\d*)/.test(r.out));
  check('输出含 ratchet 分档口径（真裸 / 已兜住）', /真裸 \d+/.test(r.out) && /已兜住/.test(r.out));
  check('① 无违规（或明确列出违规）', /① 无违规/.test(r.out) || /① 违规 \d+ 处/.test(r.out));
}

// ── 两个脚本的自身反向用例（防判据退化：只在这些自检通过时，上面两条绿灯才有意义）──
{
  const r1 = run('audit-exit-following.cjs', ['--self-test']);
  check('audit-exit-following --self-test 通过', r1.status === 0 && /\[self-test\] PASS/.test(r1.out), `status=${r1.status}`);

  const r2 = run('audit-check-await.cjs', ['--self-test']);
  check('audit-check-await --self-test 通过', r2.status === 0 && /\[self-test\] PASS/.test(r2.out), `status=${r2.status}`);
}

// ── 参数防护：未知参数必须 exit 2（防「参数写错但 exit 0」的空过）──
{
  const a = run('audit-exit-following.cjs', ['--nope']);
  const b = run('audit-check-await.cjs', ['--nope']);
  check('两个脚本对未知参数都 exit 2', a.status === 2 && b.status === 2, `exit-following=${a.status} check-await=${b.status}`);
}

assert.ok(pass + fail > 0);
console.log(`\naudit-gates：${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
