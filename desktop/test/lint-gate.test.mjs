// X14 回归门禁：让「npm test 全绿」≡「CI 的 lint 门禁绿」。
//
// 为什么必须单独一条（2026-10-18 第二次被同一类问题咬）：
//   `.github/workflows/*.yml` 里 lint 是 **error 门禁**（`eslint ... --quiet`，0 error 才过），
//   而 `npm test`（test/run-all.mjs）跑的是各测试套件——两者口径不同。于是出现了这种状态：
//   120+ 套件全绿、`npm test` 退出码 0，但 `npm run lint` 是红的，CI 直接红，release job 连启动
//   机会都没有（needs: verify 卡死）。具体触发事件是 X14 把 tasks:* 搬进 ipc/tasks.js 时漏改
//   main.js 里 `hostPolicySnapshot` 的调用点，`node --check` 抓不到跨作用域引用，只有 no-undef 报错。
//
// 本用例把 lint 纳入测试面：跑与 npm 脚本**同一范围**、**同一份配置**，断言 0 error。
// 注意：
//   · 用 `--quiet`（只报 error）——0 error 是硬门禁；用 `--max-warnings=0` 会被存量 warning 常年判红；
//   · **环境里没有 eslint 时判红（fail-closed）**，不跳过。2026-10-30 改：
//     原实现打印 [SKIP] 并 exit 0，等于把「判定不了」记账成「通过」——离线 clone / 依赖装歪时
//     整个 lint 门禁静默失效，而这正是 CI 卡点最需要它工作的时候。判定不了就是不知道，
//     不知道不能算通过。
//   · 直接 spawn 本地 node_modules/.bin/eslint，避免 npx 在缺依赖时联网下载。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// 与 package.json 的 `lint` 脚本同范围（main/ agent-core/ renderer/src/ chrome-extension/），
// 加 --quiet 对齐 CI 的 error 门禁口径
const LINT_ARGS = ['main/', 'agent-core/', 'renderer/src/', 'chrome-extension/', '--quiet'];

function resolveEslintBin() {
  const candidates = [
    path.join(DESKTOP, 'node_modules/.bin/eslint'),
    path.join(DESKTOP, '..', 'node_modules/.bin/eslint'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// 探针模式：父进程用它反向验证「缺二进制时真的 exit 1」。走的是**同一份**判定代码，
// 不是另写一个 if 假装通过——否则自测证明的是副本，不是被测机制。
const PROBE_MISSING = process.argv.includes('--probe-missing-bin');
const bin = PROBE_MISSING ? null : resolveEslintBin();

if (!bin) {
  // fail-closed：判定不了 ≠ 通过。
  //
  // ⚠ 别只给 resolveEslintBin 加 `statSync(p).isFile()`：目录冒充 eslint 时 existsSync
  // 为 true，加了类型校验会让它返回 null → 落到这里 → 判红（这是对的）；
  // 但反过来，「路径存在但不是常规文件」若只靠这里兜，报错信息会误导成「没装依赖」。
  // 要加类型校验，必须连带把「路径存在但不是常规文件」单独判红并说明成因。
  check('eslint 二进制必须可用（缺依赖时判红，不再 SKIP）', () => {
    throw new Error(
      '未找到本地 eslint（node_modules/.bin/eslint 与 ../node_modules/.bin/eslint 均不存在）。\n'
      + '  本门禁采用 fail-closed：判定不了就不算通过，避免离线/依赖缺失时静默失效。\n'
      + `  修复：在 ${DESKTOP} 下执行 npm install（或 npm ci --ignore-scripts）。\n`
      + '  若确认当前环境确实无法安装依赖，请显式跳过本套件并记录原因，不要指望它自动变绿。',
    );
  });
} else {
  const res = spawnSync(bin, LINT_ARGS, {
    cwd: DESKTOP,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const stdout = `${res.stdout || ''}${res.stderr || ''}`;
  const status = res.status;

  check('eslint 可执行为 0 error（= CI 的 lint 门禁口径，--quiet）', () => {
    if (status === 0) return;
    // 逐条列出 error 行，把「哪一行」直接摊在测试输出里——跑一次就能定位，不必再手动复跑
    const errors = stdout.split('\n').filter((l) => /\serror\s/.test(l));
    // 退出码语义必须区分，否则排查方向会跑偏（实测踩过：沙箱 broker socket 故障让 eslint 返回 2，
    // 差点被当成「代码里还有 lint error」。2 在 ESLint 里是配置/用法错误，与 lint 失败是两回事）
    // status 可能是 null（被信号终止），故模板串里只输出一次，避免「退出码 null … 退出码 null」
    //
    // status === null 的两种成因必须分开说，否则又是同一种「方向跑偏」：
    //   A 进程跑起来后被信号杀     → res.signal = 'SIGKILL' 等
    //   B 进程根本没被创建          → res.signal = null，res.error.code 见下
    // 注意：本处用 spawnSync 直连可执行文件、不经 shell，所以**永远看不到 127**——
    // 127 是 shell 的「command not found」，spawnSync 只会给 status=null + error.code。
    //
    // 覆盖边界（重要）：**自动化只覆盖 exit 0 那一支**。1 / 2 / null 三支是 2026-10-17
    // 用 /tmp 假 bin 人工沙箱验证的（exit 1 / exit 2 / kill -9 / 坏 shebang / 目录冒充），
    // 没做成自动化——构造它们要 chmod、坏 shebang，在 Windows runner 上语义完全不同，
    // 会变成平台相关的 flaky 门禁，比没有更糟（教人习惯性忽略红灯）。
    // 所以：**这几支若被人改动，测试不会红**。别据「lint-gate 绿」推断五支都验过。
    const execDiag = res.signal
      ? `被信号终止（signal=${res.signal}）`
      : res.error?.code
        // 实测（2026-10-17，/tmp 探针）：
        //   ENOENT → 坏 shebang 或文件不存在（缺的都是解释器）
        //   EACCES → 无执行权限；**目录**冒充 eslint 也是这个码
        //   ENOEXEC→ 空文件 / 截断 / 架构不匹配（「npm ci 被中断」就是这形态）
        // 注：上面 resolveEslintBin 的 existsSync **只保证路径存在、不校验类型**，
        // 所以拿到 ENOENT 别照字面理解成「eslint 没装」。
        ? `进程未能执行（${res.error.code}）—— ENOENT=解释器缺失，EACCES=无执行权限，ENOEXEC=文件损坏/架构不匹配`
        : '状态未知（无 signal 也无 error）';
    const why = status === 1
      ? '1 = 确有 lint error（见下方条目，改代码即可）'
      : status === 2
        ? '2 = ESLint 配置/用法错误或运行环境故障（**不是** lint error：先查 eslint.config.mjs、依赖安装、沙箱/网络，别急着改代码）'
        : `既非 0 也非 1/2：${execDiag}`;
    throw new Error(
      `eslint 退出码 ${status}：${why}\n(${errors.length} 条 error)\n`
      + (errors.length ? errors.slice(0, 30).join('\n') : stdout.slice(0, 4000)),
    );
  });
  // ── 自测：反向验证「缺二进制 ⇒ exit 1」真的成立 ──────────────────────────────
  // 为什么必须真起子进程：只断言「某个函数返回 false」证明的是函数，不是门禁的退出码。
  // 2026-10-30 之前这里就是 fail-open，而全套件一直绿——因为没有任何断言看过退出码。
  check('自测：缺 eslint 时本门禁必须 exit 1（fail-closed 生效）', () => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe-missing-bin'], {
      cwd: DESKTOP,
      encoding: 'utf8',
      timeout: 30000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    // 断言两件事：退出码 + 失败形态（是 [FAIL] 报错，不是崩溃/语法错误蒙混）
    if (r.status !== 1) throw new Error(`期望 exit 1，实际 ${r.status}\n${out.slice(0, 800)}`);
    if (!/\[FAIL\]/.test(out)) throw new Error(`退出码对但不是判定失败形态（[FAIL] 缺失，疑似崩溃）\n${out.slice(0, 800)}`);
  });
}

console.log(`\nlint-gate: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
