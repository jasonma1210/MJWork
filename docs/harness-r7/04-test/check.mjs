#!/usr/bin/env node
/**
 * harness-r7 事实核验断言集（只读检查器）
 * 用法: node check.mjs <ROOT> [--trace]
 * 退出码: **0 = 全部断言成立**; 1 = 至少一条 FAIL（真问题）或 BLOCKED（没验成）
 * 只读：绝不写入被检查目录。
 *
 * ── 语义（本轮已统一，务必先读这段）────────────────────────────────────────
 *   每条断言一句人话：**PASS = 它成立（好）；FAIL = 它不成立（坏）**。
 *   没有"反向语义"：早期版本把一批断言写成「缺陷存在性」形态（FAIL 反而表示已修复），
 *   结果 exit=1 成了"修好了"的信号，红变成噪声，读到末尾没人敢判断该不该高兴。
 *   现在 exit=0 就是"全部契约成立"，exit=1 就是"有真问题"。颜色与字面同义。
 *   溯源标记 `[F-xxx]` 只说明这条断言当初为哪个发现项而写，**不改变判定方向**。
 *
 * ══ 已知口径（读汇总前必看）════════════════════════════════════════════════
 *
 * 1) 四类结局：
 *      PASS     判据成立。
 *      FAIL     判据**不成立** —— 缺陷仍在 / 发生回归 / 契约被破坏。这是唯一需要动作的红。
 *      BLOCKED  前置失败 → 本条**无法验证**。计入 FAIL 总数与清单（绝不让它消失），
 *               但汇总里与"真缺陷"分行列出，避免把"没验成"读成"缺陷仍在"。
 *      RETIRED  已退役（见下方 RETIRED 登记表与第 4 条台账）。**不进 PASS 也不进 FAIL**：
 *               它的判据理由已消失或被裁决不该跟踪。退役必须留依据，不能只是"删掉"。
 *      （SKIP 保留在工具函数里，当前无使用；其语义同 BLOCKED，出现时必须配 `⚠ 未执行` 行。）
 *
 * 2) 断言总数自检（T01）：`EXPECTED_ASSERTION_TOTAL` 是手写常量，与实际执行数不等即 FAIL。
 *    【该常量的语义】**= 已注册断言条数**，不是「期望通过条数」，也不是任何通过率目标。
 *    改它的**唯一合法理由**是「新增/删除断言」，且**必须与断言增删出现在同一次 diff 里**；
 *    单独一次提交只改这个数字 = 有人在动验收的手脚，按回归处理。
 *    为什么必须有：条件分支里的断言（`if (m) { ok('A02b', ...) }`）在条件不成立时
 *    **既不 PASS 也不 FAIL 也不 SKIP** —— 总数静默变少，读的人只会以为「用例调整了」。
 *    逐条修补挡不住将来新写的条件分支，总数对不上能一次抓住全部。增删断言后**必须同步
 *    本常量**，这是本脚本的强制纪律（SELF-2 证明该闸不是恒真）。
 *
 * 3) 退役判据（A02b/A02c/A09a/A09b/A10b —— 明细见 `RETIRED` 登记表，每条带依据）：
 *    退役的三种正当理由：① 缺陷前提被上游变更消灭（无样本可测）；② 它测的是**代码事实**
 *    而非缺陷（如"兜底行还在"，兜底本就该在）；③ 该项已被裁决为**设计**，不该继续按缺陷跟踪。
 *    **不构成理由的**："它红着不好看""这样汇总能全绿" —— 那是弱化，不是退役。
 *    **缺席的裁决不是批准**：只因"没人排期"就退役，等于退回"靠消失来变绿"的老路。
 *
 * 3b) 【当前真实未修清单】—— 汇总里 FAIL 的每一条都必须能在此查到**接手方式**，
 *     否则它就是"没人管的红"，而不是待办。
 *    · （2026-10-20 D-14 批起**为空**：在册多轮的 A16c 已由 b3-mcp 按用户裁决「第三条路：
 *      校验走结构化、展示走文本」修好，接线在 `desktop/main/ipc/mcp.js` 的 callMcpTool，
 *      详见第 4 条台账末条。）
 *      修好的范围必须**如实收窄**，任何人不得因 A16c 转绿读成「MCP 能力已全接」：
 *        · 已接 = **结构化输出**：`outputSchema` 校验 + `structuredContent` 按「有没有
 *          文本版」剥离（有则剥、无则留）；
 *        · 仍未接 = `execution.taskSupport`（属 D-02-A 中期 B3-B-02 范围）与 `icons`
 *          （UI 元数据，非 tools 调用语义）；
 *        · 程序化消费（结构化结果直接进下游工具/表格）仍未实现 —— 但它已与 D-03 **解耦**
 *          （结构化数据不进上下文、不占预算），不再是 D-03 的前置阻塞。
 *
 * 4) 【契约变更台账】—— 断言口径的每一次变更都必须在此留痕，并注明触发提交。
 *    为什么：本项目吃过「口径过期后，后人把旧期望当回归、去改实现」的亏。台账是唯一解药：
 *    让人先看到"这条为什么变了"，而不是先看到"它红了"。
 *
 *      · B1-B-05（3af9093）MCP 工具名拼名/反解改为**可逆编码**：分隔符从裸 `__` 改为 `%5F%5F`。
 *        → A01b 的原字面量期望 `mcp__my__svc__x` **按设计作废**，改为**行为断言**
 *          （`decodeToolName(toToolDefs(样本,'x')[0].name)` 必须还原 server/tool）。
 *          谁若把它改回"冻结某个具体字符串"，就是把守卫降级成记录现状。
 *        → 新增 A01d：「服务名片段不得含裸 `__`」= 分隔符唯一性的真守卫。
 *        → A02a 由 `expect=true` 的**墓碑**反转为 `expect=false` 的**护栏**（不得再出现手写 split）。
 *        → 原 A02e 与新的 A01b 是同一条，**已并入 A01b**，不再重复计数。
 *      · B1-B-01（F-002）矩阵逐工具覆盖 → A06 翻转（矩阵确已读 TOOL_LEVEL）；
 *        A07 重写为「三覆盖 ⇒ `|| 'L2'` 兜底对模型工具不可达」（原断言测的是"兜底行还在"，
 *        那是代码事实，不是缺陷 —— 兜底本来就该在，关键是它可达不可达）。
 *      · B1-B-04（F-006）补协议版本头 → A08a 翻转为“头里有 MCP-Protocol-Version”；
 *        A09a/A09b 退役（"版本被保存"是前置条件；"未进构造传参"因修复走 setProtocolVersion
 *        注入而至今成立，属口径过期），实质要求由 A09e 正向断言。
 *      · B1-B-06（F-007）定义侧三道闸 → A10a/A10c/A10d 翻转；A10b 退役（schema「只判不截断」
 *        是设计决定，截断 schema = 非法 schema），schema 闸由 A10e 断言。
 *      · B2-B-09（F-013）clientInfo 版本同源 → A15a 翻转。
 *      · D-02-A / B2-B-10（40b24cf，F-014）裁决为「正式声明 MCP tools profile」，
 *        **不是**"去接 resources/prompts"（那是 D-02-B 中期新增能力 B3-B-02）→
 *        A16a 重写为「§5.5 声明在位 且 与实现一致（原语零命中）」；
 *        A16c 保留缺陷形态并翻转（outputSchema/structuredContent/taskSupport 是否被消费）——
 *        该项**没有**被任何裁决放过，故翻转后仍红 = **真实未修**
 *        （后于 2026-10-20 D-14 批修复并升级为行为断言，见本条台账末条）。
 *      · A02b/A02c 退役：前提被 B1-B-05 消灭（旧手写 split 已不存在，无样本可测），
 *        缺陷不存在性由 A02a 直接断言。
 *      · 断言总数随上述增删同步：81 → 76（删 5 条退役项；A07/A16a 为原地重写，不增减）。
 *        D-14 批 A16a/A16c 亦为原地重写，总数仍 76。
 *      · 2026-10-20 用户裁决 D-14/A16c「第三条路：校验走结构化、展示走文本」+
 *        b3-mcp 落地（`mcpToolDefs.mjs` 新增 `validateStructuredOutput` /
 *        `applyStructuredOutputPolicy`，接线 `main/ipc/mcp.js` 的 callMcpTool）→
 *        A16c 由「字面命中」升级为**行为断言**（真实 import 模块 + 四场景真实调用）。
 *        为什么必须行为化：旧判据 `countIn(defs, /outputSchema|structuredContent|…)` 只能
 *        证明"这些词出现在代码正文里"—— 本仓注释密度极高，注释旁边挂个死变量就能骗过它，
 *        那不是假想是上一轮 A02a 实际栽过的坑。四场景 = ①失配检出（ok===false 且带
 *        path/reason）②匹配直通（有文本版 → 剥 structuredContent、无 note、文本一字未动）
 *        ③失配有文本版（note 置最前 + 剥 structuredContent）④失配无文本版
 *        （structuredContent **保留**—— note 伪装文本版 bug 的修复后语义，判定前移被它钉住）。
 *      · 同期 A16a 条件 5/6 按 README **诚实新口径**重写：A16c 修好后两份 README 改为
 *        「已消费但仅用于校验 / 结构化数据不进上下文 / 程序化消费仍未实现」，旧的
 *        「open gap / 未修缺陷」表述失配（A16a 因此红过一轮，属**口径过期**而非回归）
 *        → 改为断言新口径三件事，每份 README 两条窄正则（正向一条管「仅用于校验 +
 *        不进上下文」且两句须按序同段出现，负向/未实现一条管「程序化消费仍未实现」）；
 *        交叉绑定对象从「A16c 红态」改为「实现行为」—— A16c 已修，红态不再是可引用的
 *        对象，而 README 的口径必须与实现行为一致这个要求没有消失。
 *      · 同批汇总行展示口径：PASS/FAIL 计数剔除 T01 自身。全绿时原会打印
 *        「PASS=77 / 断言 76 条」—— 通过数比登记数还大，读者反而要怀疑混进了未登记断言
 *        （那恰是 T01 要防的东西）。仅改展示，判定与 exit 不变。
 *      · M5/T5-5 团队记忆批（2026-10-20，**未提交工作区**）—— 四条口径被裁决变更，均**原地重写**
 *        （总数仍 76，不触发 T01）：
 *        → A18c：LAYER_QUOTA 三作用域 → **四作用域**（新增 team，配额 3），依据
 *          `MJCode-MJ军团团队层设计逻辑-v1-2026-10-20.md` §5 与 `test/memory-team.test.mjs`；
 *        → A17e（原 200±2 带宽）、A17f（原 =219）、A17g（原 =203）：**时点等位 → 下界不变量**
 *          （≥203 / ≥221 / ≥205，只增不减）。理由与 A17d 同：IPC 与桥方法的绝对数随每个
 *          里程碑递增，等位会把"随时点变化的数字"当契约，逼下一个人手改常量；
 *          本批 teams:* 通道（含 T5-5 新增 memory 团队候选/确认通道）即为触发点。
 *          口径放宽的是**上限**，下界仍严——**少于下界才是回归**（源文件被删 / 通道被撤）。
 *        → 变更触发提交：T5-5 数据层 + IPC + UI 同批工作区改动（团队记忆 scope='team'）。
 *      · M5/T5-8 军团协同工具批（2026-10-20，**未提交工作区**）—— 两条等位数字**原地重写**
 *        （总数仍 76，不触发 T01）：
 *        → A17a：TOOL_CHANNELS 52 → **56**（新增 teamListMembers / teamSendMessage / teamBoard / teamWait）；
 *        → A18b：TOOL_HANDLER_NAMES 51 → **55**（新增 team_list_members / team_send_message /
 *          team_board / team_wait 四个映射）。
 *        → BASE_TOOLS 不变（A18a 仍 52）：协同工具属**运行时条件追加**（仅成员任务注入 teamContext
 *          时出现），与 computer_use / load_skill 同纪律，不进静态清单。
 *      · 第八轮收尾批（2026-10-21，含 D-804 / B-04 / B-12）—— 三条等位数字**原地重写**：
 *        → A17a：TOOL_CHANNELS 56 → **57**（B-04 新增 teamReadMessages：模型侧读消息）；
 *        → A18b：TOOL_HANDLER_NAMES 55 → **56**（新增 team_read_messages → teamReadMessages）；
 *        → A18g：LINT_WARNINGS_BASELINE 161 → 159 → **157**（棘轮只降不升：本轮 descriptor/quotaLedger
 *          收口 + 导航接线迁移后实际 warning 降至 157，门禁与 harness 同步下调，基线只降不升）。
 *        → BASE_TOOLS 仍 52（新工具同样属运行时条件追加，不进静态清单）。
 *      · 团队派活拆解修复批（2026-10-21，**未提交工作区**）—— 一条断言**原地重写**（总数仍 76）：
 *        → A14e：`DAG MAX_DEPS = 4` → 「DAG 不再设人工 fan-in 上限（依赖数上限已移除）」。
 *          触发：真机「基于 Spring Boot 的商城系统设计文档」被 `任务 t6 依赖数超过 4` 整份拒掉
 *          （PLAN_FAILED，一个任务都没派）。「汇总任务依赖全部章节」是合法 DAG，fan-in 的自然
 *          上界由 MAX_TASKS（≤7）给出；4 这个数字写进提示词了吗？没有——模型无从遵守，
 *          所以它是**误杀契约**，不是可执行约束。真正保留的校验：依赖存在性 / 自依赖 / 环。
 *          行为守卫改由 `desktop/test/dag.test.js` 的「6 依赖汇总任务通过校验」承担。
 *      · DS Bots T6-6 工件协同工具批（2026-10-22，**未提交工作区**）—— 两条等位数字**原地重写**
 *        （总数仍 76，不触发 T01）：
 *        → A17a：TOOL_CHANNELS 57 → **61**（新增 artifactIndex / artifactGetSection /
 *          artifactPatchSection / artifactGetDiff）；
 *        → A18b：TOOL_HANDLER_NAMES 56 → **60**（新增 artifact_* 四个映射）。
 *        → BASE_TOOLS 仍 52：工件工具属**运行时条件追加**（宿主注入 artifactContext 才通告），
 *          与 team_* / computer_use 同纪律，不进静态清单。
 *      · 0.7.0-beta 发版批（2026-10-22，**未提交工作区**）—— 一条版本钉值**原地重写**（总数仍 76）：
 *        → A15b：desktop/package.json version `0.6.1-beta` → **`0.7.0-beta`**。
 *          触发：发版提升三包版本（desktop / renderer / server 同步，由
 *          `test/release-update.test.js` 的「三包版本一致」守护）；本条的钉值口径不变
 *          （仍与 package.json 实读值严格相等），只随发版推进期望值。A15a/A15c 不受影响
 *          （CLIENT_INFO 与 package.json 同源，无第二版本字面量）。
 *      · 0.9.0-beta 发版批（2026-10-28，品牌更名 MJ Nexus + 三平台首发）—— 同一条版本钉值**原地重写**（总数仍 76）：
 *        → A15b：`0.8.0-beta` → **`0.9.0-beta`**。
 *          触发：产品更名 MJ Nexus 并首次产出 macOS/Windows/Linux 三平台制品（用户可感知），故走 minor；
 *          三包版本同步由 `test/release-update.test.js` 与 `scripts/preflight-release.mjs` 的 P1 双重守护。
 *      · 0.8.0-beta 发版批（2026-10-28，已提交）—— 同样一条版本钉值**原地重写**（总数仍 76）：
 *        → A15b：`0.7.0-beta` → **`0.8.0-beta`**。
 *          触发：本批含 never 档审批行为变更（用户可感知），故走 minor 而非 patch；
 *          三包版本同步由 `test/release-update.test.js` 与
 *          `scripts/preflight-release.mjs` 的 P1 双重守护。
 *          注：本条钉值会随**每次发版**推进，若下次忘记同步，harness-r7 会红 ——
 *          这是刻意的（版本号变更必须显式留痕，不能静默漂移）。
 *
 * 5) 检索类断言一律在 `stripComments()` 后的**代码正文**上计数：注释里出现标识符既能让
 *    「应当成立」的断言假红，也能让「应当不成立」的断言假绿（注释喂饱）。
 *    少数刻意扫全文的断言（如 A16a 读 Markdown 文档）已就地标注 `[全文口径]` 并写明理由。
 *
 * 6) `SIMULATE_DROPPED_ASSERTION` 仅用于**演示**「总数闸能红」，正常必须为 false。
 *    **CI 中禁止设置它为 true**：那等于静默关掉一条断言（A14b），而本脚本存在的意义正是
 *    不让断言被静默关掉。任何人提交时把它留成 true，就是在关掉自己的验收。
 *
 * 7) 【定位：语义反转后，它**可以**当门禁了 —— 但接线仍不归本脚本管】
 *    旧版本是"审计报告不是门禁"，理由是 defect 语义反转（exit=1 表示修好）。本批反转完成后
 *    那个理由**已经消失**：现在 exit=0 = 全部断言成立；有真实未修缺陷时 exit=1 是**正确行为**，
 *    不是"不能当门禁"，而是"门禁现在是准的"。
 *    （事实补充：`run-all.mjs` 的发现范围是 `desktop/test/*.test.{js,mjs}` + 两个 smoke，
 *      `GATES` 只挂 `eval:check`，本文件不在其中。要不要接线由 owner 决定，不在本批范围。）
 *
 * 8) 【下批待办（台账）】
 *    ① ~~defect 断言语义改造~~ **本批已完成**（全部翻转/退役，见第 4 条台账；总数 81→76）。
 *    ② 接入 `npm test`（run-all GATES 或 npm script）：语义已正，接线的**前置条件不再缺失**，
 *       但需要 `desktop/` 写权限，由 owner 决定。
 *    ③ 「源码 `check(` 调用数自洽断言」：根治「有人删了断言又同步改常量」。需要设计，
 *       因为用正则数自己源码里的断言调用时，会把该正则自身也算进去（自指）。
 *    ④ 「不得出现 X」类断言，必须配一条**能匹配 X 任意写法**的检测，否则它守的只是
 *       「上次那个写法」—— 上一轮 A02a 就是这样假绿过一次（详见其就地注释）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) { console.error('usage: node check.mjs <ROOT>'); process.exit(2); }

// ── 来源标记（provenance）与退役登记 ────────────────────────────────────────
//
// 【语义已统一（本轮改造）】所有断言一律：**PASS = 成立（好），FAIL = 不成立（坏）**。
// 不再有「defect 类 FAIL 表示已修复」这种反向语义 —— 那种设计让 exit=1 变成"修好了"的信号，
// 红成了噪声，报告读到最后没人知道该不该高兴。现在 exit=0 = 全部断言成立；exit≠0 = 有真问题。
//
// PROV 只记录「这条断言当初是为哪个发现项写的」，**不参与判定方向**，仅用于溯源显示，
// 让读报告的人能一句话追到缺陷编号（例：`[F-006]`）。
const PROV = {
  'A03': 'F-003', 'A04c': 'F-003',                 // supportsToolCall 无执行层消费
  'A06': 'F-002', 'A07': 'F-002',                  // 工具矩阵未守审批/可补偿
  'A08a': 'F-006',                                 // Streamable HTTP 缺协议版本头
  'A10a': 'F-007', 'A10c': 'F-007', 'A10d': 'F-007', // 定义侧无守卫
  'A15a': 'F-013',                                 // 握手自报版本 '1.0'
  'A16a': 'F-014', 'A16c': 'F-014',                // MCP 能力边界：tools profile 声明 + 结构化输出
};
// 退役登记：这些断言**不再存在**（连同其编号一起停用），此处留痕说明为什么，防止后人
//   以为"漏写了"又把它们加回来，或在台账里查不到依据。退役 ≠ 通过，也 ≠ 失败 ——
//   它是"这个判据的理由已经消失/被裁决不该跟踪"，故不进 PASS 也不进 FAIL。
const RETIRED = {
  'A02b': 'F-005 · 前提被 B1-B-05 消灭（旧手写 split 已不存在，无样本可测）；缺陷不存在性由 A02a 直接断言',
  'A02c': 'F-005 · 同上（toolName 分支），由 A02a 覆盖',
  'A09a': 'F-006 · 「版本被保存」是前置条件不是缺陷；"是否送达传输层"由 A09e 直接断言',
  'A09b': 'F-006 · 修复走 setProtocolVersion 注入，字面量「未进构造传参」至今成立 → 口径过期，由 A09e 覆盖',
  'A10b': 'F-007 · schema「只判不截断」是 B1-B-06 的**设计决定**（截断 schema = 非法 schema）；闸在位由 A10e 断言',
};

let pass = 0, fail = 0, skipped = 0, blocked = 0;
const failures = [];   // 全部失败 id（含 BLOCKED）
const blockedIds = []; // 前置断言失败 → 无法验证（不是通过，也不是普通失败）
let totalCheckOk = true; // T01 结论，供汇总的「判读」引用（T01 自己也算一条断言）

/** 显示用来源标记：有溯源登记的显示 `[F-xxx]`，否则 `[invariant]`。**不参与判定方向**。 */
function typeOf(id) { return PROV[id] ? PROV[id] : 'invariant'; }

function tally(id, good) {
  if (good) pass++; else { fail++; failures.push(id); }
  return typeOf(id);
}

function ok(id, desc, actual, expect) {
  const good = JSON.stringify(actual) === JSON.stringify(expect);
  const t = tally(id, good);
  if (good) console.log(`[PASS] ${id} [${t}] ${desc} | actual=${JSON.stringify(actual)}`);
  else console.log(`[FAIL] ${id} [${t}] ${desc} | actual=${JSON.stringify(actual)} expect=${JSON.stringify(expect)}`);
}
function okTrue(id, desc, cond, info) { ok(id, desc, !!cond, true); if (info !== undefined && !cond) console.log(`       ↳ ${info}`); }
function okAbsent(id, desc, n) { ok(id, desc, n, 0); }
function okPresent(id, desc, n) { const g = n > 0; ok(id, desc, g, true); if (!g) console.log(`       ↳ 实际命中 ${n}（应 >0）`); }
/** 跳过：**不计入 PASS**（避免"无法判定"被读成"通过"）。 */
function skipAssert(id, desc, why) {
  skipped++;
  console.log(`[SKIP] ${id} [${typeOf(id)}] ${desc} | ${why}`);
  // 文件头第 1 条：凡 SKIP/BLOCKED 必须同时出现 `⚠ 未执行` 行，否则等于静默跳过。
  console.log(`⚠ 未执行：${id}（${desc}）—— ${why}；**不等于通过**`);
}
/**
 * 无法验证：前置断言失败（例：读取目标丢失，导致某条判据无从取样）。
 *
 * 为什么不能「不出声」：条件分支里的断言一旦不执行，就**既不 PASS 也不 FAIL 也不 SKIP**，
 *   总数静默变少；读的人看到「PASS 变少」只会以为是用例调整，而实际是检查被悄悄拿掉了。
 *   这是最坏的失效方式 —— 它替一次**没有发生**的检查背书。
 * 为什么也不能记成普通 FAIL：FAIL 现在统一表示「判据不成立 = 有真问题」；
 *   「没验成」不是"有问题"，而是"没结论"。故单列 BLOCKED：计入失败总数与清单（不让它消失），
 *   但在汇总里与「真缺陷」分行列出，避免把"未验证"读成"缺陷仍在"。
 */
function blockedAssert(id, desc, why) {
  blocked++;
  fail++; failures.push(`${id}(BLOCKED)`); blockedIds.push(id);
  console.log(`[FAIL] ${id} [${typeOf(id)}] ${desc} | BLOCKED: 前置断言失败，本条无法验证 → ${why}`);
  // 文件头第 1 条：凡 SKIP/BLOCKED 必须同时出现 `⚠ 未执行` 行，否则等于静默跳过。
  console.log(`⚠ 未执行：${id}（${desc}）—— ${why}；**不等于通过**`);
}

// ══ 顶层容错：跑不完也必须给出「执行中断」汇总，不许只吐一段栈 ══════════════════
//
// 实测过的坏样子：目标文件缺失时，裸 `read()` 在 A05 处抛 ENOENT，进程直接倒掉 ——
//   **汇总行数 = 0**，A06~A18/SELF/T01 一行都没输出。看报告的人只会以为「脚本坏了」，
//   而不是「判据没过」。两者是完全不同的结论，绝不能长得一样。
// 因此：捕获未处理异常 → 仍然输出一行汇总（形如「执行中断（已执行 N 条…）」）+ 一行原因
//   + 一行「这不是判据红」的判读，然后 exit 1。栈默认不打印（栈留给显式 --trace）。
const TRACE = process.argv.includes('--trace');
let interrupted = false;
function emitInterrupt(err) {
  if (interrupted) return;   // 只出一次，避免 uncaughtException + unhandledRejection 双触发
  interrupted = true;
  const reason = String((err && err.message) || err).split('\n')[0];
  console.log('');
  console.log(`=== 汇总: 执行中断（已执行 ${pass + fail + skipped} 条：PASS ${pass} / FAIL ${fail}`
    + `${skipped ? ` / SKIP ${skipped}` : ''}）===`);
  console.log(`[中断原因] ${reason}`);
  console.log('[判读] 这不是判据红，是脚本**没跑完**：中断点之后的断言一条都没执行，'
    + '不能据此判断任何缺陷状态；先修目标文件/路径，再重跑。');
  if (TRACE) console.log(err && err.stack ? err.stack : '');
  else console.log('（要栈请加 --trace；默认不打印，避免被误读成脚本故障）');
  process.exit(1);
}
process.on('uncaughtException', emitInterrupt);
process.on('unhandledRejection', emitInterrupt);

const P = (...p) => path.join(ROOT, ...p);
const read = (rel) => fs.readFileSync(P(rel), 'utf8');
const exists = (rel) => fs.existsSync(P(rel));

function walk(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (/^(node_modules|dist|build|\.git)$/.test(e.name)) continue; rec(p); }
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  })(dir);
  return out;
}
/** 在给定根目录集合中统计正则唯一命中（第一捕获组） */
function uniqMatch(dirs, re, exts = ['.js', '.mjs', '.jsx', '.ts', '.tsx']) {
  const set = new Set();
  for (const d of dirs) for (const f of walk(d, exts)) {
    for (const m of read_(f).matchAll(re)) set.add(m[1]);
  }
  return set;
}
/**
 * 跨文件统计命中数。scope='code' 时先过 stripComments（**默认**：断言对象是代码）；
 * scope='raw' 仅用于刻意要连注释一起扫的断言。
 * 返回 { n, files } —— files>0 是「本次真的读到了文件」的证据，供非空前置断言用。
 */
function countMatches(dirs, re, exts = ['.js', '.mjs', '.jsx', '.ts', '.tsx'], scope = 'code') {
  let n = 0, files = 0;
  for (const d of dirs) for (const f of walk(d, exts)) {
    files++;
    const src = read_(f);
    const c = (scope === 'code' ? stripComments(src) : src).match(re);
    if (c) n += c.length;
  }
  return { n, files };
}
function read_(abs) { return fs.readFileSync(abs, 'utf8'); }
/**
 * 读文件并**显式断言其非空**（前置断言）。
 *
 * 为什么必须显式：`okAbsent` 在「文件读不到/是空的」时会读到空串 → 命中数 0 → 直接 PASS。
 *   于是「被检查对象整个消失」反而让缺陷断言变绿。非空前置让这种情况变成 FAIL。
 * 返回去注释正文（scope='code'）或原文（scope='raw'）。
 */
function readGuarded(id, rel, scope = 'code') {
  const p = P(rel);
  let src = '';
  if (fs.existsSync(p)) src = read_(p);
  okTrue(id, `前置：${rel} 存在且非空（空/缺 = FAIL，不是「没有匹配所以通过」）`,
    src.trim().length > 0, `实际 ${src.length} 字符`);
  return scope === 'code' ? stripComments(src) : src;
}

/**
 * 去掉 `//` 与 `/* *\/` 注释（保留换行），只留代码正文。
 *
 * 为什么需要：本仓注释密度很高，注释里大量出现断言要搜的标识符（例如 mcpToolDefs.mjs 的
 * 段首注释就写着 `detectPromptInjection`、「不加 MCP-Protocol-Version」）。若在原文上计数，
 * 一条「改前无守卫」的缺陷断言会被**注释**喂成 FAIL —— 那等于用注释判定事实。
 * 所有"检索类"断言一律在去注释后的正文上计数。
 *
 * 已知边界（不影响本仓现状）：不做正则字面量识别，正则里出现未转义的 `//` 会被误判为注释。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    out += c; i++;
  }
  return out;
}
/**
 * 在**代码正文**（自动去掉注释）上统计正则命中数。
 *
 * 修正记录：本函数此前名叫「代码正文」但**根本没去注释**（`src.match` 直接跑在原文上），
 * 于是 A10c/A10d 这两条「definition 侧无守卫」的缺陷断言其实是被段首注释喂成 FAIL 的 ——
 * 结论恰好对、理由完全是错的。现在真去注释（A10c 25→17、A10d 16→9，结论不变）。
 * 参数一律传**原文**；已持有去注释正文的调用方用 countIn()，避免二次 strip。
 */
function countCode(rawSrc, re) { return (stripComments(String(rawSrc).replace(/^\uFEFF/, '')).match(re) || []).length; }
/** 在**已去注释**的正文上计数（调用方已持有 code，不再二次 strip）。 */
function countIn(codeSrc, re) { return (String(codeSrc).match(re) || []).length; }
/** desktop/main 下全部 JS/MJS 源码（rel + 去注释正文），供"跨文件存在性"断言用。 */
function mainSources() {
  return walk(MAIN, ['.js', '.mjs']).map((f) => ({
    rel: path.relative(ROOT, f),
    raw: read_(f),
    code: stripComments(read_(f)),
  }));
}

const MAIN = P('desktop/main');
const REND = P('desktop/renderer/src');
const TEST = P('desktop/test');
const agentCore = 'desktop/agent-core/index.js';
const matrixRel = 'desktop/test/tool-registration-matrix.test.mjs';

console.log(`=== harness-r7 事实核验断言集 | ROOT=${ROOT} ===\n`);

// ══ 断言总数闸（结构性加固的核心）═══════════════════════════════════════════
//
// 为什么需要：「断言消失」（`if (cond) { ok('X', ...) }` 条件不成立 → 该断言不进输出、
//   不算 PASS 也不算 SKIP）**无法靠逐条修补根治** —— 补完 A02、A17，下一个人还会写出新的
//   条件分支。逐条盯着防不住，但「实际执行数 ≠ 登记数」能一次性抓住全部消失。
// 纪律：增删断言后**必须**同步本常量。若你正想「改常量太麻烦，先放着」—— 那正是它要拦的人。
const EXPECTED_ASSERTION_TOTAL = 76; // 实测回填：76 条（含 SKIP，不含 T01 自身）。81→76 = 退役并删除 A02b/A02c/A09a/A09b/A10b 五条
// 演示开关（正常跑必须 false）：设 true 则 A14b 不执行，用于实测 T01 真的会红。
const SIMULATE_DROPPED_ASSERTION = false;
/** 总数闸判定（抽成纯函数，SELF-2 才能证明它不是恒真表达式）。 */
function totalMatches(executed, expected) { return executed === expected; }

// ── A01/A02  F-005 MCP 名称往返（真跑 ESM） ─────────────────────────────
//
// 口径变更见文件头【契约变更台账】。这里只重复一句最重要的：
//   A01b 的原字面量期望 `mcp__my__svc__x` 已随 B1-B-05（3af9093）**按设计作废**，
//   它退役为**行为断言**；A02a 由「（改前）存在手写 split」的墓碑反转为「不得存在」的护栏。
const SAMPLE_SERVER = 'my__svc';   // 全文件唯一来源，A01b/A01d/A01z 共用，避免字面量各自漂移
let toToolDefs = null, codec = null, impErr = null, codecErr = null;
try {
  toToolDefs = (await import(P('desktop/shared/mcpToolDefs.mjs'))).toToolDefs;
} catch (e) { impErr = e.message.split('\n')[0]; }
try {
  codec = await import(P('desktop/shared/mcpNameCodec.mjs'));
} catch (e) { codecErr = e.message.split('\n')[0]; }

// 断言移到 try 之外：原先 A01a/A01b/A01c 挤在同一个 try 里，A01b 抛错会触发 catch **再记一次
//   A01a** → A01a 被重复计数、总数被污染。拆开后 A01a 只可能记一次（顺带修掉，未额外加断言）。
ok('A01a', 'toToolDefs 可导入', typeof toToolDefs, 'function');
if (impErr) console.log(`       ↳ import 失败：${impErr}`);

// A01z [invariant] 前置：样本名必须被**当前**名称闸接受。
//   为什么必须有：名称闸刚从入口下移到 connectMcpServer 单点（B3#12）。任何一次收紧都可能让
//   A01b/A01d 的样本名**失效**；那时它们不是「红」，而是「无意义」——必须在组变空之前先红。
const sampleBuilt = (() => { try { return codec.buildToolName(SAMPLE_SERVER, 't'); } catch { return null; } })();
const sampleSafe = (() => { try { return !!sampleBuilt && codec.isEncodedNameSafe(sampleBuilt); } catch { return false; } })();
okTrue('A01z', `前置：样本服务名 '${SAMPLE_SERVER}' 必须被当前名称闸接受`
  + "（isEncodedNameSafe(buildToolName(样本,'t'))）",
  sampleSafe, `buildToolName → ${sampleBuilt}；闸拒绝或抛错（${codecErr || 'n/a'}）→ A01b/A01d 成立与否无意义`);

// A01b [invariant] 行为断言：真实拼名 → 真实反解 → 必须还原。
//   为什么不再冻结字面量：字面量只能记录"当时长这样"，编码一演进就过期；往返可逆才是契约本身。
const roundTrip = (() => {
  if (!toToolDefs || !codec) return null;
  try {
    const nm = toToolDefs(SAMPLE_SERVER, [{ name: 'x' }])[0].function.name;
    const dec = codec.decodeToolName(nm);
    return dec ? [dec.server, dec.tool] : null;
  } catch { return null; }
})();
ok('A01b', `拼名 ↔ 反解往返可逆：decodeToolName(toToolDefs('${SAMPLE_SERVER}','x')[0].name) 还原 server/tool`,
  roundTrip, [SAMPLE_SERVER, 'x']);

// A01c 正常名（不含 `__`）仍往返 —— 证明编码没把普通名字改坏（回归保护）
ok('A01c', '正常名 mySvc 往返可逆',
  toToolDefs ? toToolDefs('mySvc', [{ name: 'x' }])[0].function.name : 'IMPORT_FAILED',
  'mcp__mySvc__x');

// A01d [invariant] 分隔符唯一：服务名**片段**里不得残留裸 `__`（否则 `mcp__<s>__<t>` 的切分歧义回归）
const encSeg = (() => { try { return codec.encodeServerSegment(SAMPLE_SERVER); } catch { return 'ERR'; } })();
okTrue('A01d', `服务名片段不得含裸 \`__\`：encodeServerSegment('${SAMPLE_SERVER}') ≠ 原值且不匹配 /__/`,
  encSeg !== SAMPLE_SERVER && !/__/.test(encSeg), `实际片段 = ${encSeg}`);

// ── A02  agent-core 侧反解：护栏 + 回滚时才取样 ──────────────────────────
{
  const src = stripComments(exists(agentCore) ? read(agentCore) : '');
  // 检测器必须匹配**断言声称的东西**，否则就是「措辞比检测宽」的假绿。
  //   实测教训（本轮）：最初只认旧句式 `/const server = ..., toolName = ...;/`，于是按裁决注入
  //   `const [sx, ...tx] = name.split('__');` 时 **A02a 仍 PASS** —— 断言说"不得出现手写 split"，
  //   检测器却只认一种历史写法。现在两条都查：
  //     ① 旧句式（历史形状，便于回滚时取样）
  //     ② 任何手写 `.split('__')`（不限定变量名、写法）
  const legacyExpr = src.match(/const server = ([^,]+), toolName = ([^;]+);/);
  const bareSplit = src.match(/\.split\(\s*(['"])__\1\s*\)/g) || [];
  // A02a [invariant] 护栏，不是墓碑：
  //   原写法 `okTrue('A02a', '（改前）存在手写 split', !!m)` —— expect=true 记的是**修复前**的状态，
  //   修复后它永远只能红，除了逼人改断言以外没有任何守卫作用。
  //   反转成 expect=false 之后：将来谁把手写 split 加回来（回滚、或在新文件里重写一份），它会红。
  okTrue('A02a', "agent-core 不得再出现手写 `split('__')` 反解（B1-B-05 已由 mcpNameCodec.decodeToolName 取代）",
    !legacyExpr && bareSplit.length === 0,
    `旧句式命中 = ${!!legacyExpr}；手写 .split('__') 命中 ${bareSplit.length} 处`
    + `${bareSplit.length ? `（${bareSplit.slice(0, 3).join(' , ')}）` : ''} —— 任一为真即回滚，先查 agent-core 最近改动`);
  // A02b/A02c **已退役并删除**（见文件头 RETIRED）：它们取样的是"旧手写反解会解出什么"，
  //   而旧实现已被 B1-B-05 消灭，正常态下永无样本可测。留着它只能二选一：
  //     记 BLOCKED → 永久 FAIL → exit 永远非 0 → 报告不可能成为门禁（上次已证明"永久红=没人看"）；
  //     记 SKIP    → 计数稳定但等于承认这条判据长期不产生信息。
  //   两者都不如直接删掉：**缺陷不存在性已由 A02a 正向断言**（不得再出现手写 split('__')），
  //   覆盖是完整的，且 A02a 在回滚时确实会红（已用变异验证过）。
  if (legacyExpr) {
    // 回滚现场：A02a 已经会红（上面那条）。这里额外把"会解成什么错值"打出来，方便定位，
    //   但**不再计入断言数** —— 它是诊断输出，不是判据（判据是 A02a）。
    const parts = 'mcp__my__svc__x'.split('__');
    console.log(`[INFO] A02a' 回滚取样：server=${JSON.stringify(eval(legacyExpr[1]))}`
      + ` toolName=${JSON.stringify(eval(legacyExpr[2]))}（正确应为 my__svc / x）`);
  }
}

// ── A03/A04  F-003 supportsToolCall 无执行层消费 ─────────────────────────
//
// 口径：断言对象是**代码**（「agent-core 是否消费 supportsToolCall」）。此前读原文，
//   于是 agent-core 段首写着「supportsToolCall 全仓只出现在…」的大段注释也在计数里（16 命中，
//   去注释后 15）。方向后果：把实现**注释掉**而不删，原文计数仍 >0 → 缺陷断言 FAIL →
//   被读成「已修复」。这正是用注释判定事实，必须去注释。
{
  const ac = readGuarded('A03n', agentCore);   // 空/缺文件 → 前置 FAIL，A03 不再是「没匹配所以通过」
  // 语义统一（本轮）：断言「缺陷已消失」。PASS = 修好了，FAIL = 缺陷仍在。
  okPresent('A03', '已修复：agent-core 已消费 supportsToolCall（能力门真的接上了，不再是"只解析不消费"）',
    countIn(ac, /supportsToolCall/g));
  okTrue('A04a', 'agent-core 仍构造 allTools', /let allTools\s*=/.test(ac));
  okTrue('A04b', 'agent-core 仍每轮发送 tools: allTools', /tools:\s*allTools/.test(ac));
  const pilot = [];
  for (const d of [P('desktop')]) for (const f of walk(d, ['.js', '.mjs', '.jsx', '.ts', '.tsx'])) {
    if (/supportsToolCall/.test(stripComments(read_(f)))) pilot.push(path.relative(ROOT, f));
  }
  okTrue('A04c', '已修复：supportsToolCall 已进入 agent-core（消费方在位）',
    pilot.some((x) => x.includes('agent-core')), `命中文件: ${pilot.join(' | ') || '(无)'}`);
  console.log(`[INFO] A04c' supportsToolCall 命中文件（去注释口径） = ${pilot.join(' , ')}`);
}

// ── A05  F-004 数字员工：renderer 是否真的有 rolePreset 消费（我方的反向断言） ──
// 口径：全部按**代码**计。这一组是「链路每一环都真的接了」的阳性断言，读原文时
//   一句「// 由 ChatArea 监听 mjcode:enable-expert 写入 sessionExtras」就能把 A05c/A05d 喂饱。
{
  const engineChain = [
    read('desktop/renderer/src/components/EcosystemModal.jsx'),
    read('desktop/renderer/src/App.jsx'),
    read('desktop/renderer/src/components/ChatArea.jsx'),
    read('desktop/renderer/src/hooks/useAgentRun.ts'),
  ].map(stripComments).join('\n');
  okTrue('A05a', 'EcosystemModal 真的调用 bridge ecosystemEmployeeRuntime',
    /api\?\.ecosystemEmployeeRuntime|ecosystemEmployeeRuntime\(\{/.test(engineChain));
  okTrue('A05b', '→ dispatch mjcode:recruit-expert', /mjcode:recruit-expert/.test(engineChain));
  okTrue('A05c', '→ App dispatch mjcode:enable-expert', /mjcode:enable-expert/.test(engineChain));
  okTrue('A05d', '→ ChatArea 监听写入 sessionExtras', /mjcode:enable-expert/.test(engineChain) && /setSessionExtras|sessionExtras/.test(engineChain));
  okTrue('A05e', '→ useAgentRun 把 rolePreset 放进 agent:run payload',
    /rolePreset:\s*sessionExtras\?\.expert\?\.runtime/.test(engineChain));
  const ar = stripComments(read('desktop/main/agentRunner.js'));
  okTrue('A05f', '→ agentRunner 消费 payload.rolePreset', /payload\.rolePreset/.test(ar));
  okTrue('A05g', '→ preload 暴露 ecosystemEmployeeRuntime',
    /ecosystemEmployeeRuntime/.test(stripComments(read('desktop/main/preload.js'))));
  okTrue('A05h', '→ 主进程 handle ecosystem:employeeRuntime',
    /ipcMain\.handle\(\s*'ecosystem:employeeRuntime'/.test(stripComments(read('desktop/main/ipc/ecosystem.js'))));
}

// ── A06/A07  F-002 工具矩阵守审批/可补偿 ─────────────────────────────────
{
  // 前置：矩阵文件存在且非空。否则 A06 会在空串上得 0 → 假绿（「没有匹配所以通过」）。
  const mx = readGuarded('A06n', matrixRel);
  okPresent('A06', '已修复：矩阵已读 TOOL_LEVEL/REVERSIBILITY/toolLevel（逐工具守审批分级，不再是只查孤儿的假闭环）',
    countIn(mx, /TOOL_LEVEL|REVERSIBILITY|toolLevel/g));
  // A07 已**重写**（原「approval.js 未登记一律默认 L2」是**代码事实**，不是缺陷判据）：
  //   F-002 的真缺陷是「漏登记 → 静默落 L2 → auto-safe 档直接放行」，其判据是**三覆盖**：
  //   每个模型工具必须落在 TOOL_LEVEL ∪ SPECIAL_CASED_TOOLS ∪ READONLY_TOOLS 之一，
  //   于是 toolLevel() 末行的 `TOOL_LEVEL[tool] || 'L2'` 对模型工具**不可达**。
  //   测「兜底代码还在不在」没有意义（它就该在，作为兜底）；测「兜底是否可达」才是守卫。
  let uncovered = null, covInfo = 'n/a';
  try {
    const { createRequire } = await import('node:module');
    const rq = createRequire(import.meta.url);
    const ap = rq(P('desktop/main/approval.js'));
    const core = await import(P(agentCore));
    const drive = [...new Set([
      ...(core.BASE_TOOLS || []).map((t) => (t.function ? t.function.name : (t.name || t))),
      ...Object.keys(core.TOOL_HANDLER_NAMES || {}),
    ])];
    const TL = ap.TOOL_LEVEL || {};
    const SP = ap.SPECIAL_CASED_TOOLS || new Set();
    const RO = ap.READONLY_TOOLS || new Set();
    uncovered = drive.filter((t) => !(t in TL) && !SP.has(t) && !RO.has(t));
    covInfo = `驱动集 ${drive.length} 个（TOOL_LEVEL ${Object.keys(TL).length} / 特判 ${SP.size} / 只读 ${RO.size}）`;
  } catch (e) { uncovered = null; covInfo = `加载失败：${e.message.split('\n')[0]}`; }
  if (uncovered === null) {
    blockedAssert('A07', "已修复：零模型工具依赖 `|| 'L2'` 兜底（三覆盖）", covInfo);
  } else {
    ok('A07', "已修复：零模型工具依赖 `|| 'L2'` 兜底（TOOL_LEVEL ∪ 特判 ∪ 只读 三覆盖）", uncovered, []);
    console.log(`[INFO] A07' ${covInfo}；未覆盖 ${uncovered.length} 个`);
  }
  // 阳性对照也走代码口径：注释里写满 approval 字样同样能把这条喂绿。
  okPresent('A06p', '阳性对照：矩阵确实引用了 approval 相关（APPROVAL_TOOLS 等）',
    countIn(mx, /APPROVAL_TOOLS|approval/gi));
}

// ── A08/A09  F-006 Streamable HTTP 缺 MCP-Protocol-Version ───────────────
//
// 本块是第七轮修复中**空过（vacuous pass）最严重**的一处，修法记在这里备查：
//
//   原实现把扫描片段钉死在「mcpClient.js 里 `async send(payload, requestId)` 之后 900 字符」。
//   B1-B-04 把整个 HTTP 传输族（createHttpTransport / consumeSse / createSseTransport）
//   搬到了 mcpHttpTransport.js，mcpClient.js 里**已不存在**该签名 →
//   `indexOf` 返回 -1 → `slice(-1, 899)` 得到空串（实测 length=0）→
//     · A08a 断言「头里**没有** MCP-Protocol-Version」，对一个空串当然成立 → **假绿**；
//     · A08b/A08c（阳性对照）因空串而红 —— 说明「防止 A08a 读错位置空过」的机制本身坏了。
//   这是最坏的一种绿灯：它替一次**根本没有发生**的检查背书，比没有校验更危险。
//
// 修法不是「把路径改到新文件」（下次再拆分就再坏一次），而是三件事：
//   ① **自动发现**扫描范围：desktop/main 下任何出现 streamable-HTTP POST 标记
//      （`application/json, text/event-stream`）的文件都纳入，不再写死文件名清单；
//   ② 定位锚点从「具体函数签名」换成「**结构**」：抽出 `headers: { ... }` 对象字面量
//      （大括号配对、跳过字符串与注释），只保留含该 Accept 标记的那一个 ——
//      它**就是**「HTTP 请求头组装段」本身，跟函数怎么命名、放哪个文件无关；
//   ③ 新增自检 A08z/A08y：「扫描片段非空且 >200 字符」「含标记的文件都必须抽到 header 段」。
//      片段为空 = 扫描再次失效 → **直接 FAIL**。这样下一次重构把代码搬走时，坏的是自检，
//      不会再伪装成 A08a 的绿灯。
const HTTP_ACCEPT_MARKER = /application\/json,\s*text\/event-stream/;
// 自检开关：临时设为 ['desktop/main/mcpClient.js'] 可复现"只读老文件"的空过（验证 A08z 真会红）。
// 正常跑必须保持 null（= 全目录自动发现）。
const HTTP_SCAN_FILES = null;

/** 从 `{` 处向后做大括号配对，返回对象字面量文本（跳过字符串与注释）。 */
function extractBalancedObject(src, openBraceIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openBraceIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(openBraceIdx, i + 1); }
  }
  return src.slice(openBraceIdx);
}

function httpHeaderSegments() {
  const files = HTTP_SCAN_FILES
    ? HTTP_SCAN_FILES.map((f) => P(f)).filter((f) => fs.existsSync(f))
    : walk(MAIN, ['.js', '.mjs']);
  const segs = [];
  const markerFiles = [];
  const segFiles = [];
  for (const f of files) {
    const raw = read_(f);
    if (!HTTP_ACCEPT_MARKER.test(raw)) continue;
    const rel = path.relative(ROOT, f);
    markerFiles.push(rel);
    for (const m of raw.matchAll(/\bheaders\s*:\s*\{/g)) {
      const obj = extractBalancedObject(raw, m.index + m[0].length - 1);
      if (!HTTP_ACCEPT_MARKER.test(obj)) continue; // 别的 fetch 的 headers，不是 streamable-HTTP 那个
      segs.push(`/* ${rel} */\n${obj}`);
      if (!segFiles.includes(rel)) segFiles.push(rel);
    }
  }
  return { hdrSeg: segs.join('\n'), markerFiles, segFiles };
}

{
  const { hdrSeg, markerFiles, segFiles } = httpHeaderSegments();
  console.log(`[INFO] A08' HTTP 请求头组装段来源 = ${segFiles.join(' , ') || '(空)'}；片段 ${hdrSeg.length} 字符`);

  // ── 自检（本任务核心交付）：空过必须变成失败，而不是变成绿灯 ──
  okTrue('A08z', '自检：HTTP 头扫描片段非空且 >200 字符（片段空 = 扫描失效，直接 FAIL）',
    hdrSeg.length > 200, `片段长度 ${hdrSeg.length}；含标记的文件 = ${markerFiles.join(' , ') || '(无)'}`);
  okTrue('A08y', '自检：含 streamable-HTTP 标记的文件均已抽到 header 段（防再次拆分后漏扫）',
    markerFiles.length >= 1 && markerFiles.every((f) => segFiles.includes(f)),
    `含标记文件 ${markerFiles.length} 个，抽到 header 段 ${segFiles.length} 个`);

  // 口径：抽出的 header 对象里可能夹注释，一律去注释后再判（注释里写一句
  //   「这里不加 MCP-Protocol-Version」不该影响判定，两个方向都一样）。
  const hdrCode = stripComments(hdrSeg);

  // [F-006] 语义统一后的正向判据：请求头必须带 MCP-Protocol-Version（协商值）。
  //   历史提醒（保留，防复发）：本条的**反面**写法（断言"头里没有该字段"）曾在扫描片段为空时
  //   假绿 —— 空串上"没有"当然成立。现在的正向写法（必须 >0 命中）+ A08z 的片段非空自检
  //   构成双保险：扫描失效时 A08z 先红，不会再伪装成本条绿灯。
  okPresent('A08a', '已修复：HTTP transport 请求头带 MCP-Protocol-Version（协商值）',
    countIn(hdrCode, /MCP-Protocol-Version|Mcp-Protocol-Version/gi));
  // 阳性对照：A08a 必须"读到了真正的 header 区块"，否则它的 PASS 毫无意义。
  okTrue('A08b', '阳性对照：请求头确有 Mcp-Session-Id（证明读到的是 header 区块）', /Mcp-Session-Id/.test(hdrCode));
  okTrue('A08c', '阳性对照：请求头确有 Accept: application/json, text/event-stream',
    /Accept\s*:\s*['"`]?application\/json,\s*text\/event-stream/.test(hdrCode));

  // A09a / A09b 已退役（见文件头 RETIRED）：
  //   A09a「版本被保存」是**前置条件**不是缺陷；A09b「未进构造传参」在修复走 setProtocolVersion
  //   注入后**依旧成立**，属口径过期。两者原本想表达的"版本是否真的送达传输层"，
  //   由下面这条 A09e 用**正向**判据直接断言 —— 这才是 F-006 的实质要求。
  const main = mainSources();
  okTrue('A09e', '已修复（F-006）：协商版本确有到达 transport 的路径（构造传参 或 setProtocolVersion 注入）',
    main.some(({ code }) => /setProtocolVersion\s*\(\s*peerVersion\s*\)/.test(code)
      || /createHttpTransport\(\{[^}]*protocolVersion/s.test(code)),
    '两条路径都不存在 → 版本仍到不了传输层，F-006 未修');
  const proto = stripComments(read('desktop/main/mcpProtocol.js'));
  okTrue('A09c', 'mcpProtocol 声明支持 2025-11-25', /2025-11-25/.test(proto));
  okTrue('A09d', 'mcpProtocol 声明支持 2025-06-18', /2025-06-18/.test(proto));
}

// ── A10/A11  F-007 定义侧无守卫 / 结果侧有守卫 ───────────────────────────
{
  const defs = read('desktop/shared/mcpToolDefs.mjs');
  const defsCode = stripComments(defs);
  // 语义统一（本轮）：断言「缺陷已消失」。
  //   A10a → description 不再原样透传（截断/预算闸接管）；
  //   A10b 已退役（见文件头 RETIRED）：schema「只判不截断」是 B1-B-06 的**设计决定**
  //     （截断 schema = 非法 schema = 调用必失败），`parameters: t.inputSchema` 保留是**对的**；
  //     把它当缺陷会让这条永远红 —— 那是墓碑不是守卫。schema 闸在位由 A10e 断言。
  okTrue('A10a', '已修复：definition 侧 description 不再原样透传（改由截断/预算闸接管）',
    !/description:\s*t\.description/.test(defsCode));
  // 判定面必须跟上**实现的实际命名**，否则闸加上了断言也不会红（上一轮就是这样假绿的）：
  //   旧正则只认 guardUntrusted|detectInjection|.slice(0,NNN)|maxLength|MAX_DESC；
  //   B1-B-06 用的是 detectPromptInjection / MAX_TOOL_DESCRIPTION_CHARS / MAX_INPUT_SCHEMA_BYTES /
  //   contextBudget / __untrusted__ / truncateDescription / inspectToolDefinition —— 一个都没命中。
  const GATE_RE = new RegExp([
    'guardUntrusted', 'detectInjection', 'detectPromptInjection',
    '\\.slice\\(\\s*0,\\s*\\d{3,}', 'maxLength', 'MAX_DESC\\b',
    'MAX_TOOL_DESCRIPTION_CHARS', 'MAX_INPUT_SCHEMA_BYTES', 'MAX_INPUT_SCHEMA_DEPTH',
    'contextBudget', '__untrusted__', 'truncateDescription', 'inspectToolDefinition',
    'isBlockedToolDef', '__blocked__',
  ].join('|'), 'g');
  // 注：这两条此前用 countCode 但该函数**没去注释**（见函数注释的修正记录），
  //   实际是被 mcpToolDefs 段首那段「本段讨论 detectPromptInjection / __untrusted__ …」的
  //   注释喂成 FAIL 的 —— 结论碰巧对，理由完全错。现在真去注释：A10c 25→17、A10d 16→9，
  //   结论不变（F-007 确已修，真证据是 A10e）。
  okPresent('A10c', '已修复：definition 侧有守卫/长度闸/不可信标记', countCode(defs, GATE_RE));
  const cache = read('desktop/main/mcpToolCache.js');
  okPresent('A10d', '已修复：mcpToolCache 有不可信守卫 / 定义预算闸', countCode(cache, GATE_RE));
  const ac = read(agentCore);
  okPresent('A11', '阳性对照：工具结果侧确有 detectInjection', countIn(stripComments(ac), /detectInjection/g));
  // F-007 修复的正向证据：三道闸（描述截断 / schema 只判不截断 / 不可信标记）都在位。
  okTrue('A10e', '定义侧确有预算闸：description 截断 + schema 只判不截断 + __untrusted__ 标记',
    /truncateDescription\s*\(/.test(defsCode) && /inspectToolDefinition\s*\(/.test(defsCode)
      && /__untrusted__/.test(defsCode),
    '三道闸缺任一 → F-007 未完整修');
}

// ── A12  F-009 run-all 的 suite/gate 结构 ────────────────────────────────
{
  const ra = stripComments(read('desktop/test/run-all.mjs'));
  okTrue('A12a', "SMOKE = ['smoke-load.mjs','render-smoke.mjs'] 两项",
    /const SMOKE = \[\s*'smoke-load\.mjs',\s*'render-smoke\.mjs'\s*\]/.test(ra), 'SMOKE 字面量不匹配');
  okTrue('A12b', 'GATES 只有 eval:check 一项（门不是套件）',
    /const GATES = \[\s*\{ label: 'eval:check/.test(ra) && countIn(ra, /eval:check/g) >= 1);
  okTrue('A12c', '套件发现用 /\\.test\\.(js|mjs)$/', /\\\.test\\\.\(js\|mjs\)|\\\.test\\\.\(js/.test(ra) || /\.test\.\(js\|mjs\)/.test(ra));
  const smokes = ['smoke-load.mjs', 'render-smoke.mjs'].filter((f) => exists(`desktop/test/${f}`));
  ok('A12d', '两个 smoke 文件真实存在', smokes.length, 2);
}

// ── A13  F-010 生态资产数量（注意 JSON 顶层结构） ────────────────────────
{
  const c = JSON.parse(read('ecosystem/mcp-connectors.json'));
  const w = JSON.parse(read('ecosystem/mcp-connectors-workbuddy.json'));
  const e = JSON.parse(read('ecosystem/digital-employees.json'));
  const sk = fs.readdirSync(P('ecosystem/skills'), { withFileTypes: true }).filter((x) => x.isDirectory());
  okTrue('A13a', 'mcp-connectors.json 顶层是 Object（不是数组）', !Array.isArray(c));
  // 2026-10-28：77→78 —— 精选目录新增 `mcp-codegraph`（见 docs/MJCode-CodeGraph集成方案-2026-10-28.md，
  // 属**有意新增**的生态资产，不是重复条目），故同步上调；本条仍是「目录规模变更即红」的探测器。
  ok('A13b', '精选 connectors = 78', Array.isArray(c) ? c.length : c.connectors.length, 78);
  ok('A13c', 'workbuddy connectors = 214', Array.isArray(w) ? w.length : w.connectors.length, 214);
  ok('A13d', 'digital employees = 51', e.length, 51);
  ok('A13e', 'skills 目录 = 100', sk.length, 100);
}

// ── A14  F-011 三处可证伪（证据 1 / 3 可自动化） ─────────────────────────
{
  const sp = JSON.parse(read('server/package.json'));
  okTrue('A14a', 'server 依赖含 express', !!(sp.dependencies && sp.dependencies.express));
  // A14b 是本文件的「演示靶子」：SIMULATE_DROPPED_ASSERTION=true 时它不执行，
  //   用来实测文件末尾的 T01 总数闸真的会红（见该常量注释）。正常跑恒为 false。
  if (!SIMULATE_DROPPED_ASSERTION) {
    okAbsent('A14b', 'server 依赖无 spring', JSON.stringify(sp.dependencies).toLowerCase().split('spring').length - 1);
  }
  const dag = stripComments(read('desktop/main/orchestrator/dag.js'));
  okTrue('A14c', 'DAG MAX_TASKS = 8', /const MAX_TASKS = 8;/.test(dag));
  okTrue('A14d', 'DAG MIN_TASKS = 2', /const MIN_TASKS = 2;/.test(dag));
  okTrue('A14e', 'DAG 不再设人工 fan-in 上限（依赖数上限已移除）',
    (dag.match(/MAX_DEPS|依赖数超过/g) || []).length === 0);
}

// ── A15  F-013 握手自报版本 ──────────────────────────────────────────────
{
  const proto = stripComments(read('desktop/main/mcpProtocol.js'));
  okTrue('A15a', "已修复：CLIENT_INFO version 不再硬编码 '1.0'（与 package.json 同源）",
    !/CLIENT_INFO\s*=\s*Object\.freeze\(\{[^}]*version:\s*'1\.0'/s.test(proto));
  ok('A15b', 'desktop/package.json version', JSON.parse(read('desktop/package.json')).version, '0.9.0-beta');
  okTrue('A15c', 'mcpClient 每次 initialize 都发 clientInfo',
    /clientInfo:\s*\{\s*\.\.\.CLIENT_INFO\s*\}/.test(stripComments(read('desktop/main/mcpClient.js'))));
}

// ── A16  F-014 MCP 能力边界（裁决 D-02-A：声明 tools profile） ────────────
{
  const reNeg = /resources\/list|resources\/read|prompts\/list|prompts\/get|tasks\/get/g;
  const scan1 = countMatches([MAIN, REND], reNeg);
  // 前置：扫描面非空。目录改名/删掉时命中恒为 0，A16a 的"声明与实现一致"就会空过
  //   （「什么都没读到」被读成「什么都没命中」）。阳性对照 A16b 只能证明"读到了一些文件"，
  //   不能证明"扫的是该扫的地方"，所以这里单独把文件数钉成断言。
  okTrue('A16n', '前置：A16 扫描面非空（desktop/main + renderer/src 源文件 ≥ 100）',
    scan1.files >= 100, `实际扫到 ${scan1.files} 个源文件；为 0 说明 A16a 的一致性判定毫无意义`);
  // A16a 已**重写**：F-014 的裁决是 D-02-A「正式声明 tools profile」（B2-B-10，40b24cf），
  //   不是"把 resources/prompts 接上"（那是 D-02-B 中期**新增能力** B3-B-02，不是缺陷）。
  //   所以这里断言的是**声明在位 + 声明与实现一致**：
  //     · 技术文档 §5.5 必须显式写明 MCP tools profile；
  //     · 代码里确实仍未接 resources/prompts 原语（与声明一致）。
  //   若将来 D-02-B 落地，本条会因"实现超前"而红 —— 那时应改成"只读面已接入且声明同步更新"，
  //   而不是删断言（保持这条能提醒两处必须同步改）。
  // 口径说明：这里是**文档全文口径**（Markdown 不是代码，不能过 stripComments —— 那会把
  //   含 `//` 的 URL 当注释切掉），已按文件头第 5 条要求就地标注。
  //
  // A16a 已**重写 + 扩一条**（裁决 D-02-A / B2-B-10）：
  //   ① 声明必须在**三处**都到位：技术文档 §5.5 + README.md + README.zh-CN.md。
  //      为什么 README 也算：B2-B-10 的验收原文就是「README 与技术文档**均**命中」，
  //      而当时只兑现了技术文档（两份 README 都是 0 命中）—— 那是**超额声称**。
  //      技术文档的读者是维护者，README 的读者才是决定要不要装的人；只在技术文档里声明，
  //      等于"对内部诚实、对外部不诚实"。
  //   ② 交叉校验：README 的结构化输出口径必须与**实现行为**一致（2026-10-20 重写）。
  //      历史形态（已作废）：曾要求 README 把 structured output 写成「open gap / 未修缺陷」，
  //      与 A16c 的红**状态**绑定。A16c 已由 b3-mcp 按 D-14 裁决第三条路修好后，该表述失配
  //      （README 改成诚实新口径，A16a 因此红过一轮 —— 口径过期，不是回归），且「红态」
  //      不再是可引用的对象。但「README 口径 ↔ 实现行为不得各自漂移」这个要求没有消失，
  //      故改绑**实现行为**：新口径三件事必须同时成立，每份 README 两条窄正则 ——
  //        ① 已消费但仅用于校验 + ② 结构化数据本身不进上下文（一条正向正则，两句须按序
  //           同段出现：拆散/改序/删任一句即红，防「留一句改两句」式漂移）；
  //        ③ 程序化消费仍未实现（一条正则）。
  //      为什么用窄正则而不是单个关键词：B2-B-10 的教训是「命中一个词」≠「口径没变」——
  //      老 README 里 outputSchema 一词长期存在，说的却是 "not consumed yet"。
  //      为了不造第四份 stripComments，这里直接读文档原文匹配（文档不是代码，不需去注释）。
  const techDoc = read('MJcoder-技术流程功能文档.md');
  const readmeEn = read('README.md');
  const readmeZh = read('README.zh-CN.md');
  const declConds = [
    ['技术文档 §5.5 声明', /###\s*5\.5[^\n]*tools profile/.test(techDoc)],
    ['README.md 声明', /tools profile/.test(readmeEn)],
    ['README.zh-CN.md 声明', /tools profile/.test(readmeZh)],
    ['实现与声明一致（resources/prompts 原语零命中）', scan1.n === 0],
    ['README.md 口径与实现行为一致：已消费但仅用于校验 + 结构化数据不进上下文',
      /consumed for\s+validation only[\s\S]{1,600}?is \*\*not\*\* fed into the\s+context/i.test(readmeEn)],
    ['README.md 口径与实现行为一致：程序化消费仍未实现',
      /programmatic consumption[\s\S]{1,300}?still not implemented/i.test(readmeEn)],
    ['README.zh-CN.md 口径与实现行为一致：已消费但仅用于校验 + 结构化数据不进上下文',
      /已消费，但仅用于校验[\s\S]{1,600}?结构化数据本身\*\*不进上下文\*\*/.test(readmeZh)],
    ['README.zh-CN.md 口径与实现行为一致：程序化消费仍未实现',
      /程序化消费[\s\S]{1,300}?仍未实现/.test(readmeZh)],
  ];
  const declFailed = declConds.filter(([, good]) => !good).map(([name]) => name);
  ok('A16a', '已修复（F-014/D-02-A）：MCP tools profile 声明到位（技术文档 §5.5 + 两份 README），'
    + '实现与声明一致，且两份 README 的结构化输出口径（仅用于校验 / 不进上下文 / '
    + '程序化消费仍未实现）与实现行为一致',
  declFailed, []);
  const scan2 = countMatches([MAIN, REND], /tools\/list|tools\/call/g);
  okPresent('A16b', '阳性对照：同一批文件确有 tools/list|tools/call', scan2.n);
  readGuarded('A16o', 'desktop/shared/mcpToolDefs.mjs'); // 前置：行为断言的取样对象必须在
  // A16c 升级为**行为断言**（2026-10-20，D-14 裁决第三条路 + b3-mcp 落地后）。
  //   旧形态是字面命中：countIn(defs, /outputSchema|structuredContent|taskSupport|icons/g) > 0
  //   —— 只能证明「这些词出现在代码正文里」。本仓注释密度极高，注释旁边挂个死变量就能骗过它；
  //   那不是假想，是上一轮 A02a 实际栽过的坑（检测器只认历史句式，注入新写法仍绿）。
  //   行为断言**真实 import 模块并调用**：懒校验 / 直通 / 判定前移被改回，都会立即转红。
  //   接线事实（证明这是真消费而不是自嗨）：`desktop/main/ipc/mcp.js` 的 callMcpTool
  //   （tools/call 的唯一执行路径）在结果落库/回传前调用
  //   `policy.applyStructuredOutputPolicy(result, outputSchema)`（ipc/mcp.js:347）。
  //   范围声明（标题如实收窄）：本条只覆盖**结构化输出**。`execution.taskSupport`
  //   （D-02-A 中期 B3-B-02）与 `icons`（UI 元数据）**仍未接** —— 不得因本条绿读成
  //   「MCP 能力已全接」（见文件头 3b 的范围边界）。
  let structMod = null, structErr = null;
  try {
    structMod = await import(P('desktop/shared/mcpToolDefs.mjs'));
  } catch (e) { structErr = e.message.split('\n')[0]; }
  if (structErr || typeof structMod.validateStructuredOutput !== 'function'
    || typeof structMod.applyStructuredOutputPolicy !== 'function') {
    blockedAssert('A16c', '结构化输出消费四场景行为断言',
      `mcpToolDefs.mjs import 失败或未导出 validateStructuredOutput/applyStructuredOutputPolicy：`
      + `${structErr || `typeof=${typeof structMod.validateStructuredOutput}/${typeof structMod.applyStructuredOutputPolicy}`}`);
  } else {
    const { validateStructuredOutput, applyStructuredOutputPolicy } = structMod;
    // 四场景共用一个 schema：required 数字属性 a。{a:'x'}/{a:'坏'} 失配，{a:1} 匹配。
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'number' } } };
    const NOTE = /^\[MJCode\] 结构化输出未通过/;
    const scen = [];
    const run = (fn) => { try { return { v: fn() }; } catch (e) { return { err: e.message.split('\n')[0] }; } };
    // 场景① 失配必须被检出：ok===false 且带 path/reason。恒返回 {ok:true} 的懒校验在此转红。
    const s1 = run(() => validateStructuredOutput(schema, { a: 'x' }));
    if (s1.err || !(s1.v && s1.v.ok === false && typeof s1.v.path === 'string' && typeof s1.v.reason === 'string')) {
      scen.push(`① validateStructuredOutput(schema,{a:'x'}) 应判失配并带 path/reason，实际 ${s1.err ? `抛错：${s1.err}` : JSON.stringify(s1.v)}`);
    }
    // 场景② 匹配 + 有文本版 → 剥 structuredContent、无 note、content 文本一字未动。
    const src2 = { content: [{ type: 'text', text: 'rows: 2' }], structuredContent: { a: 1 } };
    const s2 = run(() => applyStructuredOutputPolicy(src2, schema));
    if (s2.err || !(s2.v && s2.v.structuredContent === undefined && Array.isArray(s2.v.content)
      && s2.v.content.length === 1 && s2.v.content[0].type === 'text' && s2.v.content[0].text === 'rows: 2')) {
      scen.push(`② 匹配且有文本版应剥 structuredContent 且 content 原样，实际 ${s2.err ? `抛错：${s2.err}` : JSON.stringify(s2.v)}`);
    }
    // 场景③ 失配 + 有文本版 → note 置最前、原文紧随其后、structuredContent 被剥。
    const s3 = run(() => applyStructuredOutputPolicy({ content: [{ type: 'text', text: 'rows: 2' }], structuredContent: { a: '坏' } }, schema));
    if (s3.err || !(s3.v && Array.isArray(s3.v.content) && s3.v.content.length === 2
      && s3.v.content[0].type === 'text' && NOTE.test(s3.v.content[0].text)
      && s3.v.content[1].text === 'rows: 2' && s3.v.structuredContent === undefined)) {
      scen.push(`③ 失配且有文本版应 note 置前 + 剥 structuredContent，实际 ${s3.err ? `抛错：${s3.err}` : JSON.stringify(s3.v)}`);
    }
    // 场景④ 失配 + **无文本版** → structuredContent **保留**（fail-open 朝向可用性）。
    //   这是 note 伪装文本版 bug 的修复后语义：判定前移到插 note 之前。若判定被改回插入后，
    //   我们自己的 note 会伪装成「有文本版」→ 数据被剥 → 模型只剩一句提示，场景④转红。
    const s4 = run(() => applyStructuredOutputPolicy({ structuredContent: { a: '坏' } }, schema));
    if (s4.err || !(s4.v && JSON.stringify(s4.v.structuredContent) === JSON.stringify({ a: '坏' })
      && Array.isArray(s4.v.content) && s4.v.content.length === 1
      && s4.v.content[0].type === 'text' && NOTE.test(s4.v.content[0].text))) {
      scen.push(`④ 失配且无文本版应保留 structuredContent（bug 修复后语义），实际 ${s4.err ? `抛错：${s4.err}` : JSON.stringify(s4.v)}`);
    }
    okTrue('A16c', '结构化输出按裁决第三条路消费（行为断言四场景）：outputSchema 真校验；'
      + 'structuredContent 有文本版则剥、无文本版则留；失配时 note 置前'
      + '（execution.taskSupport / icons 仍未接，本条不覆盖，见文件头 3b）',
      scen.length === 0, scen.join('；'));
  }
}

// ── A17  §1.2 契约数量 ───────────────────────────────────────────────────
{
  let TOOL_CHANNELS, NOTIFY_CBS, REQUEST_CBS, regErr = null;
  try {
    const { createRequire } = await import('node:module');
    const require2 = createRequire(import.meta.url);
    const reg = require2(P('desktop/main/engineProcess/registry.js'));
    TOOL_CHANNELS = reg.TOOL_CHANNELS; NOTIFY_CBS = reg.NOTIFY_CBS; REQUEST_CBS = reg.REQUEST_CBS;
  } catch (e) { regErr = e.message.split('\n')[0]; }
  // 清扫记录（本轮）：原先 else 分支只补了一条 A17a —— registry require 失败时
  //   A17b/A17c **既不出现也不计 SKIP**，总数静默少 2。同样的病，同样的治法：BLOCKED 出声。
  if (!regErr) {
    ok('A17a', 'TOOL_CHANNELS = 61', TOOL_CHANNELS.length, 61);
    ok('A17b', 'NOTIFY_CBS = 8', NOTIFY_CBS.length, 8);
    ok('A17c', 'REQUEST_CBS = 1', REQUEST_CBS.length, 1);
  } else {
    ok('A17a', 'registry.js 可 require（=61 的值因此无从判定）', `ERR: ${regErr}`, 61);
    blockedAssert('A17b', 'NOTIFY_CBS = 8', `registry require 失败：${regErr}`);
    blockedAssert('A17c', 'REQUEST_CBS = 1', `registry require 失败：${regErr}`);
  }

  const mainFiles = walk(MAIN, ['.js', '.mjs']);
  // A17d 原为硬等位「= 137」。它每新增一个源文件就失效一次（B1-B-04 抽出 mcpHttpTransport.js
  // 就把它从绿打红），等于把一个**随时点变化的数字**当成契约，逼下一个人手改常量。
  // 换成两条不假绿、也不需手改数字的检查（数字一律**现算**，绝不回抄成常量）：
  //   A17d  [invariant] 现算文件数 ≥ 137 —— 只增不减；减少说明有源文件被删/被挪走，须解释。
  //   A17d2 [invariant] git 已追踪的源文件在工作树中**无缺失** —— 防「文件被误删但计数仍够」。
  // 注意：`git ls-files` 不含未追踪文件（本轮 mcpHttpTransport.js 就是未追踪），
  //   所以它只能做「不得缺失」的下界，不能当"文件数基线"用 —— 那会变成从 git 现算再跟 git 比。
  okTrue('A17d', 'desktop/main JS/MJS 文件数 ≥ 137（只增不减；减少须解释）',
    mainFiles.length >= 137, `现算 ${mainFiles.length}`);
  let tracked = null;
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('git', ['ls-files', '-z', '--', 'desktop/main'], { cwd: ROOT, encoding: 'utf8' });
    tracked = out.split('\0').filter((f) => /\.(js|mjs)$/.test(f));
  } catch { tracked = null; }
  if (tracked && tracked.length) {
    ok('A17d2', 'git 已追踪的 desktop/main 源文件在工作树中无缺失', tracked.filter((rel) => !fs.existsSync(P(rel))), []);
  } else {
    skipAssert('A17d2', 'git 已追踪源文件在工作树中无缺失', 'git 不可用或非 git 仓库 —— 不计入 PASS');
  }
  console.log(`[INFO] A17d' 现算文件数 = ${mainFiles.length}；git 追踪 = ${tracked ? tracked.length : 'N/A'}（时点值，勿抄成常量）`);
  const ipcSet = new Set();
  for (const f of mainFiles) for (const m of stripComments(read_(f)).matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) ipcSet.add(m[1]);
  console.log(`[INFO] A17e' ipcMain.handle 唯一字面量 = ${ipcSet.size}（简报称 186，见正文口径说明）`);
  // M5/T5-5（2026-10-20）：本节四条口径由**时点等位**改为**只增不减的下界不变量**，
  //   与 A17d 同一理由——IPC / 桥方法的绝对数随每个里程碑递增，等位会把"随时点变化的数字"
  //   当契约，逼下一个人手改常量（详见文件头第 4 条「契约变更台账」）。
  //   A17e 的 200±2 带宽同理废止，改为以 203 为下界的量级不变量。
  okTrue('A17e', 'ipcMain.handle 唯一字面量 ≥ 203（只增不减；减少须解释）', ipcSet.size >= 203, `实测 ${ipcSet.size}`);

  const pre = stripComments(read('desktop/main/preload.js'));
  const seg = pre.slice(pre.indexOf("exposeInMainWorld('mjcode'"));
  const keys = new Set();
  for (const m of seg.matchAll(/^  ([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/gm)) keys.add(m[1]);
  okTrue('A17f', 'preload bridge 顶层键 ≥ 221（只增不减；减少须解释）', keys.size >= 221, `实测 ${keys.size}`);
  const inv = new Set();
  for (const m of pre.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)) inv.add(m[1]);
  okTrue('A17g', 'preload invoke 唯一通道 ≥ 205（只增不减；减少须解释）', inv.size >= 205, `实测 ${inv.size}`);
}

// ── A18  §1.3 关键常量 ───────────────────────────────────────────────────
{
  let baseTools = null, handlerNames = null;
  try {
    const m = await import(P(agentCore));
    baseTools = m.BASE_TOOLS; handlerNames = m.TOOL_HANDLER_NAMES;
  } catch (e) { /* ignore */ }
  if (baseTools) ok('A18a', 'BASE_TOOLS = 52（真实 ESM import）', baseTools.length, 52);
  else ok('A18a', 'BASE_TOOLS 可导入', 'IMPORT_FAILED', 52);
  if (handlerNames) ok('A18b', 'TOOL_HANDLER_NAMES = 60', Object.keys(handlerNames).length, 60);
  else ok('A18b', 'TOOL_HANDLER_NAMES 可导入', 'IMPORT_FAILED', 60);

  // A18c~g 全是「常量是否按契约写」的**代码**事实：注释里抄一遍同样的字面量
  //   就能把任何一条喂绿，故统一去注释。
  const mem = stripComments(read('desktop/main/memory/index.js'));
  // M5/T5-5（2026-10-20）：LAYER_QUOTA 由三作用域（session/project/global）扩为**四作用域**
  //    —— 新增 team（配额 3，见 `MJCode-MJ军团团队层设计逻辑-v1-2026-10-20.md` §5 与
  //       `desktop/test/memory-team.test.mjs`）。这是**被裁决的契约变更**，不是漂移。
  okTrue('A18c', 'LAYER_QUOTA = {session:2, team:3, project:3, global:2}（四作用域）',
    /LAYER_QUOTA\s*=\s*\{\s*session:\s*2,\s*team:\s*3,\s*project:\s*3,\s*global:\s*2\s*\}/.test(mem));
  const pw = stripComments(read('desktop/main/mcpPrewarm.js'));
  okTrue('A18d', "PREWARM_NAMES = time/fetch 两个（A-04 收口：filesystem 已移出 auto-start）",
    /PREWARM_NAMES\s*=\s*new Set\(\['time',\s*'fetch'\]\)/.test(pw));
  const ar = stripComments(read('desktop/main/agentRunner.js'));
  okTrue('A18e', 'PREWARM_CONNECT_TIMEOUT_MS = 6000', /PREWARM_CONNECT_TIMEOUT_MS\s*=\s*6000/.test(ar));
  const ap = stripComments(read('desktop/main/approval.js'));
  ok('A18f', '审批四档齐全',
    ['never', 'auto-safe', 'on-request', 'always'].filter((x) => new RegExp(`'${x}'`).test(ap)).length, 4);
  const lr = stripComments(read('desktop/test/lint-ratchet.test.mjs'));
  okTrue('A18g', 'LINT_WARNINGS_BASELINE = 157', /LINT_WARNINGS_BASELINE\s*=\s*157/.test(lr));
}

// ══ 结构性加固：自检 + 断言总数闸 ═══════════════════════════════════════════
//
// 上面的 ①②③ 是「逐条修补」，挡不住下一个人写出新的条件分支（`if (cond) { ok(...) }`）。
// 这里加两层兜底：
//   SELF-1/1b  证明 stripComments 真的在去注释（不是恒等函数）—— 否则①的全部改动都是空转；
//   SELF-2     证明总数闸对「少 1 条 / 多 1 条」都会红（不是恒真表达式）；
//   T01        断言总数必须等于 EXPECTED_ASSERTION_TOTAL —— 任何断言「静默消失/未登记新增」都红。
{
  const probe = 'a /* b */ c';
  okTrue('SELF-1', "自检：stripComments('a /* b */ c') 真的去掉块注释（不是恒等函数）",
    stripComments(probe).replace(/\s+/g, ' ').trim() === 'a c',
    `实际产出 ${JSON.stringify(stripComments(probe))}；若返回原文则「去注释」是空转`);
  const probe2 = "const u = 'x//y'; // tail\nconst z = 1;";
  const out2 = stripComments(probe2);
  okTrue('SELF-1b', "自检：stripComments 去行注释、且不破坏字符串里的 //",
    out2.includes("'x//y'") && !/tail/.test(out2),
    `实际产出 ${JSON.stringify(out2)}；丢了 'x//y' 说明它会吃掉字符串里的 //（那会让所有检索类断言失真）`);

  // 演示开关（正常跑必须 false）：设 true 会让 A14b 不执行，用于**实测**总数闸真的会红。
  //   更彻底的做法是临时注释掉任意一条断言 —— 两种方式都验过（见测试报告）。

  okTrue('SELF-2', '自检：总数闸对「少 1 条 / 多 1 条」都会报红（机制非恒真）',
    totalMatches(EXPECTED_ASSERTION_TOTAL - 1, EXPECTED_ASSERTION_TOTAL) === false
      && totalMatches(EXPECTED_ASSERTION_TOTAL + 1, EXPECTED_ASSERTION_TOTAL) === false
      && totalMatches(EXPECTED_ASSERTION_TOTAL, EXPECTED_ASSERTION_TOTAL) === true,
    'totalMatches 对 expected±1 仍返回 true → 总数闸是恒真的，等于没装');

  const executed = pass + fail + skipped;   // 不含 T01 自身
  totalCheckOk = totalMatches(executed, EXPECTED_ASSERTION_TOTAL);
  okTrue('T01', `断言总数 = ${EXPECTED_ASSERTION_TOTAL}（防「断言静默消失/未登记新增」）`,
    totalCheckOk,
    `实际执行 ${executed}（PASS ${pass} + FAIL ${fail} + SKIP ${skipped}），期望 ${EXPECTED_ASSERTION_TOTAL}。`
    + ' 有断言被静默跳过，或新增了未登记的断言；若确实增删，请同步 EXPECTED_ASSERTION_TOTAL（这是强制纪律）');
}

// 汇总口径：T01 是总数闸**自身**（元检查），上面已用「T01 计时前」的 executed 完成判定，
//   这里把它从 PASS/FAIL 展示里剔除 —— 否则全绿时会打印「PASS=77 / 断言 76 条」，
//   通过数比登记数还大，读的人反而要怀疑是不是混进了一条未登记断言（那正是 T01 要防的
//   东西）。仅影响展示，不动任何判定与 exit。
const t01InPass = totalCheckOk;                 // T01 绿 → 它被 okTrue 计进了 pass
const sumPass = pass - (t01InPass ? 1 : 0);
const sumFail = fail - (t01InPass ? 0 : 1);     // T01 红 → 它被计进了 fail
console.log(`\n=== 汇总: PASS=${sumPass} FAIL=${sumFail} SKIP=${skipped} BLOCKED=${blocked} `
  + `(断言 ${sumPass + sumFail + skipped} 条 / 登记 ${EXPECTED_ASSERTION_TOTAL}；T01 自身不计入) ===`);
// 语义已统一：PASS = 成立，FAIL = 不成立。四类清单如下（不再有"反转读法"）。
const realFails = failures.filter((id) => !id.endsWith('(BLOCKED)'));
console.log(`[失败（真缺陷）] ${realFails.length}` +
  (realFails.length ? `   ← 每条都指向一个**真实未修**的问题：${realFails.join(', ')}` : '   ← 全部断言成立'));
if (blocked) console.log(`[无法验证]       ${blocked}   ← 前置断言失败，没结论（不是通过，也不是缺陷）：${blockedIds.join(', ')}`);
console.log(`[通过]           ${sumPass}`);
const retiredIds = Object.keys(RETIRED);
console.log(`[退役]           ${retiredIds.length}   ← 判据理由已消失/被裁决不该跟踪，**不进 PASS 也不进 FAIL**：${retiredIds.join(', ')}`);
if (failures.length) console.log(`失败项（全部，含无法验证）: ${failures.join(', ')}`);
if (realFails.length) {
  console.log('[判读] 有 FAIL = 有**真问题**（缺陷仍在 / 回归 / 判据不成立）。exit=1 是正确的，别把它读成"还不能发布"之外的东西。');
} else if (blocked) {
  console.log('[判读] 无 FAIL，但有 BLOCKED：有判据没验成。先修前置，别把"没验成"当"通过"。');
} else {
  console.log('[判读] exit=0：全部断言成立（退役项不计）。这份报告可作为发布前的契约基线。');
}
if (!totalCheckOk) {
  console.log('[判读] 另有 T01 红：断言总数与登记值不符，上面某条断言可能根本没执行。');
}
process.exit(fail ? 1 : 0);
