'use strict';
// P1-2：工具超时的单一事实来源（main 侧「实现层」+ 引擎「看门狗层」的对账基准）
//
// 问题（审查实证）：三处超时数字互不自洽 ——
//   · shell 实现侧默认 60s（exec.js）
//   · web_fetch 实现侧 15s（webTools.js）
//   · 引擎看门狗 shell 600s / web_fetch 60s（agent-core TOOL_TIMEOUT_OVERRIDES）
// 引擎允许 600s，实现侧 60s 就自己断了 ⇒ **引擎的超时表是空转的**，永远轮不到它报错。
//
// 不变式（三层超时的通用约束）：实现侧 < 传输侧 < 任务侧，且上层超时要能拿到下层的真实原因。
// 因此本文件给出成对数值：IMPL（实现侧自断）与 WATCHDOG（引擎看门狗），并保持严格大于关系。
//
// 接线状态：
//   · main/tools/exec.js  ← SHELL_DEFAULT_TIMEOUT_MS（本次接线）
//   · main/webTools.js    ← WEB_FETCH_IMPL_TIMEOUT_MS（本次接线）
//   · agent-core/index.js 的 TOOL_TIMEOUT_OVERRIDES 需引用同名语义值（WP-A 负责接线；
//     引擎不得 require main/，故那边保留同值常量 + 由 test 对账，避免引擎依赖宿主目录）。

/** shell 实现侧默认超时（8min）：覆盖长构建 / 全量测试的最长档，留 2 倍于常见 CI */
const SHELL_DEFAULT_TIMEOUT_MS = 480000;
/** shell 引擎看门狗（10min）：严格大于实现侧，留 120s 余量给「实现层报错 + 结果回收」 */
const SHELL_WATCHDOG_TIMEOUT_MS = 600000;
/** web_fetch 实现侧（30s）：DNS + TLS + 首字节 + 2MB 正文的 P99 */
const WEB_FETCH_IMPL_TIMEOUT_MS = 30000;
/** web_fetch 引擎看门狗（60s）：与实现侧保持 2 倍关系 */
const WEB_FETCH_WATCHDOG_TIMEOUT_MS = 60000;

// ── 工具组实现侧超时（P3 收口：原先 5 处散落在 exec.js 里的字面量）──
// 这些值本身没变，集中到这里是为了「改超时只改一处」——散落字面量的问题是
// 调一个数时永远不知道还有几处需要同步（与 P1-2 的三处不自洽同源）。
/** apply_patch 执行（30s）：本地补丁应用，超时按失败返回而非挂死 */
const PATCH_IMPL_TIMEOUT_MS = 30000;
/** grep 检索（15s）：仓库级单次检索的 P99 */
const GREP_IMPL_TIMEOUT_MS = 15000;
/** find 检索（20s）：比 grep 多 5s（遍历目录树比读文件慢） */
const FIND_IMPL_TIMEOUT_MS = 20000;
/** git 写/网络类（30s）：commit / clone / fetch */
const GIT_IMPL_TIMEOUT_MS = 30000;
/** git 轻量只读（8s）：status / rev-parse 这类本地瞬时命令 */
const GIT_QUICK_TIMEOUT_MS = 8000;

// ── G-doc 文档生成（实现侧 / 看门狗成对）──
// 四个文档工具里 PDF 最慢（Chromium 渲染 + 落临时文件），doc/xlsx/pptx 通常秒级。
// 实现侧按最慢者取 45s，看门狗给 60s（满足「实现侧 < 看门狗」，且上层能拿到真实原因）。
/** 文档生成实现侧（45s）：main/docTools.js 的 PDF 渲染超时 */
const DOC_GEN_IMPL_TIMEOUT_MS = 45000;
/** 文档生成引擎看门狗（60s）：严格大于实现侧，留 15s 余量给「实现层报错 + 结果回收」 */
const DOC_GEN_WATCHDOG_TIMEOUT_MS = 60000;

// ── G-latex LaTeX 编译（实现侧 / 看门狗成对）──
// LaTeX 编译是**多趟**排版（参考文献/目录要重复跑），比文档生成慢一个量级：
// 单文件论文通常十几秒，含 bibtex + 多图的完整项目可到几分钟。实现侧给 5min 覆盖绝大多数项目，
// 看门狗 6min 严格大于实现侧（保证超时原因由实现侧的「已强杀 + 提示」先报出，而不是引擎兜底闸）。
/** LaTeX 编译实现侧（300s）：main/latexTools.js 的子进程强杀上限 */
const LATEX_IMPL_TIMEOUT_MS = 300000;
/** LaTeX 编译引擎看门狗（360s）：严格大于实现侧 */
const LATEX_WATCHDOG_TIMEOUT_MS = 360000;

// ── 编排（orchestrator）两级墙钟（P3 收口）──
// 此前两个 30min 分居 dag.js:50 与 invoke.js:8，互不知情：
//   · TASK_*   = 「一个子任务最多跑多久」（dag 解析时钳制）
//   · GROUP_*  = 「一次 orchestrate_task 调用最多等多久」（invoke 的轮询上限）
// 两者独立叠加时**先撞组等待**：默认 10min/任务时串行 3 层恰好用满 30min，
// 第 4 层起会被组等待强停 —— 这是有意的（单次调用不该无限挂），不是缺陷。
// 不变式：GROUP_WAIT >= TASK_MAX（至少容纳一个满预算任务），由 test/timeouts-contract 断言锁住。
const ORCHESTRATE_TASK_MIN_MS = 30 * 1000;
const ORCHESTRATE_TASK_DEFAULT_MS = 10 * 60 * 1000;
const ORCHESTRATE_TASK_MAX_MS = 30 * 60 * 1000;
const ORCHESTRATE_GROUP_WAIT_MS = 30 * 60 * 1000;

// ── 审批等待（人机协同）──
// 此前 120000 在 ApprovalChannel 的默认值、main.js、cuaHandlers.js 各写一遍（3 处同值）。
// 语义：审批卡最多等多久，超时一律按 deny/timeout 收尾——宁可拒绝也不能让 run 无限挂起。
/** 审批卡等待上限（120s） */
const APPROVAL_WAIT_TIMEOUT_MS = 120000;

module.exports = {
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_WATCHDOG_TIMEOUT_MS,
  WEB_FETCH_IMPL_TIMEOUT_MS,
  WEB_FETCH_WATCHDOG_TIMEOUT_MS,
  PATCH_IMPL_TIMEOUT_MS,
  GREP_IMPL_TIMEOUT_MS,
  FIND_IMPL_TIMEOUT_MS,
  GIT_IMPL_TIMEOUT_MS,
  GIT_QUICK_TIMEOUT_MS,
  DOC_GEN_IMPL_TIMEOUT_MS,
  DOC_GEN_WATCHDOG_TIMEOUT_MS,
  LATEX_IMPL_TIMEOUT_MS,
  LATEX_WATCHDOG_TIMEOUT_MS,
  ORCHESTRATE_TASK_MIN_MS,
  ORCHESTRATE_TASK_DEFAULT_MS,
  ORCHESTRATE_TASK_MAX_MS,
  ORCHESTRATE_GROUP_WAIT_MS,
  APPROVAL_WAIT_TIMEOUT_MS,
};
