// N2（第六轮）门禁：lint 警告棘轮——基线只降不升。
//
// 事故背景：`npm run lint` 长期是 `--max-warnings=9999`，等于「0 error 是门禁的全部强度」，
// 新引入的未用参数 / 空 catch / 依赖数组漏项被噪声淹没，质量退化无感（实测存量 161 条 warning）。
// 第六轮把 CI 切到实测基线 161：新增 warning 即红；警告被清掉后必须同步下调基线（棘轮只降不升）。
//
// 本套件锁三件事：
//   ① package.json 的 lint 脚本 --max-warnings 必须等于本文件的基线常量（单一事实来源，防有人调回 9999）；
//   ② 实际 eslint 警告数 ≤ 基线（真跑 eslint，不是读包脚本自证）；
//   ③ 基线本身不得是「假大值」（< 9999 且 > 0 区间合理）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// 单一事实来源：2026-10-19 实测 161 条（no-unused-vars 122 / require-atomic-updates 32 /
// react-hooks/exhaustive-deps 5 / 其它 2）。**只允许下调**：清理一批后同步把这里与 package.json 一起改小。
// 2026-10-21（第八轮收尾）实测 159：D-804 双栈那批赋值改用 Object.assign 后不再触发
// require-atomic-updates，团队记忆开关改用 ui/Button 原语也不再新增 unused 告警 ⇒ 161 → 159。
// 2026-10-27 复测 157：artifacts/studio/ledger 三个只读域 IPC 收口到 registerDomains.js 后，
// 原 main.js 内的若干 unused 告警随冗余装配代码一并消失 ⇒ 159 → 157（棘轮只降不升）。
const LINT_WARNINGS_BASELINE = 157;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lintScript = String((pkg.scripts && pkg.scripts.lint) || '');
const m = lintScript.match(/--max-warnings=(\d+)/);
const scriptMax = m ? Number(m[1]) : null;
check('① package.json lint 脚本 --max-warnings 等于基线常量', scriptMax === LINT_WARNINGS_BASELINE,
  `script=${scriptMax} baseline=${LINT_WARNINGS_BASELINE}`);
check('③ 基线不是「假大值」（已脱离 9999 假绿）', LINT_WARNINGS_BASELINE < 9999 && LINT_WARNINGS_BASELINE > 0,
  `baseline=${LINT_WARNINGS_BASELINE}`);

// ② 真跑 eslint（本地二进制），按 severity 统计
const bin = path.join(ROOT, 'node_modules', '.bin', 'eslint');
let warnings = null;
let errors = null;
if (fs.existsSync(bin)) {
  const r = spawnSync(bin, ['main/', 'agent-core/', 'renderer/src/', 'chrome-extension/', '--format', 'json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
  });
  try {
    const arr = JSON.parse(r.stdout || '[]');
    warnings = 0; errors = 0;
    for (const f of arr) for (const msg of (f.messages || [])) { if (msg.severity === 2) errors += 1; else warnings += 1; }
  } catch { /* eslint 未产出 JSON（配置错误等）→ 视为门禁失败 */ }
} else {
  check('② 本地 eslint 二进制存在', false, bin);
}

check('② 真跑 eslint 且 0 error', errors === 0 && warnings !== null, `errors=${errors} warnings=${warnings}`);
check('② 实际 warning 数 ≤ 基线（新增 warning 即红）', warnings !== null && warnings <= LINT_WARNINGS_BASELINE,
  `actual=${warnings} baseline=${LINT_WARNINGS_BASELINE}`);
if (warnings !== null && warnings < LINT_WARNINGS_BASELINE) {
  console.log(`ℹ 提示：实际 warning（${warnings}）已低于基线（${LINT_WARNINGS_BASELINE}），请把本常量与 package.json 的 --max-warnings 同步下调。`);
}

console.log(`\nlint-ratchet: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
