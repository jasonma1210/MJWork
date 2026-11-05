// 测试基线汇总口径（C-04，2026-10-21 从 run-all.mjs 抽出）
//
// 为什么要单独成模块：原来的汇总是一行内联表达式
//     `通过 = suites.length + GATES.length - failed.length`
// 它把「跳过」算进了「通过」——darwin 上 3 个沙箱套件从未真跑，汇总却报「通过 259 · 失败 0」。
// 这正是本项目反复记录的**假绿形态**：用「没验」冒充「验过」。而内联表达式无法被单测覆盖，
// 所以只能靠「读代码发现」；抽成纯函数后可以用真实输入把每种边界都钉住。
//
// 三条口径（改动前只有前两条）：
//   ① 总计 = 套件 + 前置门禁
//   ② 失败 = 非零退出的项（含崩溃/超时）
//   ③ **跳过 = 报告了「⚠ 跳过 / 未执行」的套件**（按套件去重：一个套件可能有多行 ⚠）
//
// 关键取舍：
//   · 跳过 **不影响退出码** —— 平台限制不是缺陷，把 darwin 上跑不了 Linux 沙箱判成失败等于逼人删测试；
//   · 但跳过 **必须从「通过」里扣掉** —— 否则数字在骗人；
//   · 一个套件**既失败又报告跳过**时只算失败（不双重扣减），否则等式 `通过+失败+跳过=总计` 会破。

/**
 * @param {object} input
 * @param {number} input.total  检查项总数（套件 + 前置门禁）
 * @param {string[]} input.failed 失败项标识（套件路径或门禁 label）
 * @param {string[]} input.skipLines 套件输出里匹配「⚠ … 跳过/未执行」的**行**
 * @param {(line:any)=>string} [input.suiteOfLine] 从 skipLine 取套件标识（缺省读 `.suite`）
 * @returns {{total:number, passed:number, failed:number, skipped:number, skippedSuites:string[], ok:boolean}}
 *   ok=false 表示等式自洽校验失败（公式本身坏了，不是被测代码坏了）
 */
export function summarize({ total, failed = [], skipLines = [], suiteOfLine = (l) => l && l.suite } = {}) {
  const failedList = [...new Set(failed.map(String))];
  // 去重：同一套件可能打印多行 ⚠（如多平台各一行），按套件只算一次
  const skippedSuites = [...new Set(skipLines.map((l) => String(suiteOfLine(l) || '')).filter(Boolean))];
  // 既失败又跳过的，只计失败（否则同一项被扣两次，等式会破）
  const skipOnly = skippedSuites.filter((s) => !failedList.includes(s));
  const passed = Number(total) - failedList.length - skipOnly.length;
  const ok = passed >= 0 && passed + failedList.length + skipOnly.length === Number(total);
  return {
    total: Number(total),
    passed,
    failed: failedList.length,
    skipped: skipOnly.length,
    skippedSuites: skipOnly,
    ok,
  };
}

// ── 结构化「沙箱真机状态」解析（2026-11-05，AC-1.4）──────────────────────────
//
// 修的是什么（真缺陷，不是理论风险）：`run-all.mjs` 原靠 `/⚠.*(跳过|未执行)/` 匹配中文措辞
// 来记账「哪些套件没真跑」。但 `test/sandbox.test.js` 打印的是
//     ⚠ Seatbelt 真机探测 BLOCKED（宿主拒绝含 deny 的 profile…）
//     SANDBOX_REAL_STATUS=BLOCKED
// 两行都**不含**「跳过」「未执行」二字 ⇒ 正则全部 MISS ⇒ 该套件 BLOCKED（真机隔离
// **未验证**）却被算进「通过」。于是 `npm test` 报「329 总计 / 327 通过 / 0 失败 / 2 跳过」，
// 读者会以为 327 项都验过了，实际只有 326 项验过。
//
// 这正是本项目反复记录的假绿形态：**靠中文措辞做机器判据**。措辞一改，判据就静默失效，
// 且失效方向是「少扣跳过」= 把没验的算成验过（最危险的方向）。
//
// 改为读**结构化状态行**：`test/sandbox.test.js` 始终打印 `SANDBOX_REAL_STATUS=<状态>`
// （那是给 CI 用的机器契约，`ci.yml:176` 就在读它）。只有 `RUN` 才算「真机已验证」。
//
// 三条判据（fail-safe 方向）：
//   ① 没有状态行 ⇒ 不是「已验证」也不是「已跳过」，返回 verified:false + status:null，
//      由调用方决定怎么记账（本函数不擅自把「没说」判成「通过」）；
//   ② 有多行 ⇒ 取**最后一行**（套件可能先打中间态，末尾才是终态；与 ci.yml 的 `tail -1` 同口径）；
//   ③ **任何非 RUN 的值都算未验证**（含未知值 / 拼错 / 未来新增状态）——宁可多扣一个
//      「通过」，不可少扣。这条是刻意的：未知状态绝不能默认成已验证。

/** @type {readonly string[]} 已知状态，仅供诊断显示；判定不依赖白名单 */
export const SANDBOX_STATUS_KNOWN = ['RUN', 'BLOCKED', 'NOT_RUN', 'ERROR'];

/**
 * 从套件输出里读真机沙箱状态。
 * @param {string} body 套件 stdout + stderr
 * @returns {{status: string|null, verified: boolean, reason: string}}
 *   status: 归一化后的状态（`'NOT RUN'` → `'NOT_RUN'`），无状态行时为 null
 *   verified: **仅** `status === 'RUN'` 时为 true
 *   reason: `verified` | `not-verified` | `no-status-line`
 */
export function readSandboxRealStatus(body) {
  const text = String(body == null ? '' : body);
  const found = [...text.matchAll(/SANDBOX_REAL_STATUS=([A-Za-z_ ]+)/g)];
  if (found.length === 0) return { status: null, verified: false, reason: 'no-status-line' };
  // 末尾一条为准（与 ci.yml:177 的 `grep … | tail -1` 同口径）
  const raw = found[found.length - 1][1].trim();
  // 归一化：历史值 `'NOT RUN'` 带空格，统一成 `NOT_RUN`；判定不受影响
  const status = raw.replace(/\s+/g, '_').toUpperCase();
  return { status, verified: status === 'RUN', reason: status === 'RUN' ? 'verified' : 'not-verified' };
}

