// 审批中心：分级判定 + 规则匹配（纯函数部分，可单测）
// 档位（**四档**，互斥枚举）：on-request（默认，写操作询问）/ auto-safe（L2 自动，L1/L3 询问）/
//                              always（全部询问）/ never（全不询问）
// P2-7「执行后告知」：**正交布尔偏好 `approvalNotice`**，可叠加在上述任意档位上（见下方说明）
// 规则：{ tool, pattern, scope: 'always' } —— 「始终允许」持久化于 userData/approval-rules.json
//      { tool, pattern, scope: 'conversation', conversationId } —— 「本对话同类」主进程内存

const LEVELS = { L1: 'danger-command', L2: 'file-write', L3: 'mcp-tool' };

// ── P2-7：「执行后告知」为什么是正交布尔，而不是第五档（team-lead 2026-10-17 裁决，记录偏离）──
//
// checklist 的四档是「自动执行 / 执行后告知 / 执行前确认 / 直接阻断」，字面上像是一个五档阶梯。
// 本项目**刻意**把它实现成「四档枚举 + 正交布尔 `approvalNotice`」，偏离理由（按权重）：
//   1) 档位枚举是**跨 5 处契约**（shared-ipc/contract.mjs 的 zod enum、main/approvalPolicy.js、
//      main/approvalSettings.js、main/ecosystem.js、渲染层 UI）。任何一处漏改，表现是
//      **渲染层一下发就被契约拒绝、整个 run 失败**，且只能在运行时暴露、测试覆盖不到。
//   2) 正交设计在语义上更正确：用户完全可能想要「always 档 + 每次执行后也告知」
//      （既逐次确认、又留一条用户可见的记录）。互斥枚举表达不了这个组合。
//   3) 改一处布尔偏好即可上线，不碰任何契约。
//
// ⚠️ 后人对齐 checklist 时别搞混：`approvalNotice` **不是「更严格」**，它不改变任何询问行为。
//    严格度阶梯始终是 never < auto-safe < on-request < always
//    （注：若将来真做成第五档，它应排在 never 与 auto-safe **之间**——因为它从不询问，
//      而 auto-safe 对 L3 仍会询问，所以「执行后告知档」比 auto-safe 更松。别把它误解成更严。）
//
// 三条纪律（缺一条就是假治理）：
//   1) **与 audit 解耦**：审计是无条件留痕的治理底线，不随本偏好开关；通知是「用户可见的补充」，
//      绝不等于「有 audit 就算告知」。
//   2) **不替代阻断**：L1 高危/不可逆动作照旧要求执行前确认（或按档位阻断），不发「执行后告知」——
//      把不可逆高危动作放到事后告知 = 取消治理（用户知道时已经晚了）。
//   3) **默认关闭**：`approvalNotice` 缺省 false，为 false 时行为与改造前**逐字节一致**。
const APPROVAL_MODES = Object.freeze({
  NEVER: 'never',             // 全不询问
  AUTO_SAFE: 'auto-safe',     // L2 自动，L1/L3 询问
  ON_REQUEST: 'on-request',   // 默认：写操作询问
  ALWAYS: 'always',           // 全部询问
});

// 可补偿性（P2-7 通知内容的核心）：告知的价值就在于「用户知道晚了，但至少知道能不能修」。
// 判定原则：**外部副作用与本机销毁类动作按不可补偿对待**（保守：说不清就当不可逆）。
//   · 本机文件写/暂存 → 可补偿（有 git 历史或内容仍在）；
//   · 外部系统（MCP/浏览器/Chrome/CUA）、对外可见（PR 评论/审查）、持久化注册（插件/定时任务）、
//     内容销毁（丢弃工作区改动）→ 不可补偿，通知里必须明确标注。
const REVERSIBILITY = {
  write_file: { reversible: true, note: '文件内容可再次编辑覆盖' },
  edit_file: { reversible: true, note: '可用 git 或再次编辑回退' },
  apply_patch: { reversible: true, note: '可用 git 或反向补丁回退' },
  git_add: { reversible: true, note: '可 git restore --staged 撤销' },
  git_restore_staged: { reversible: true, note: '工作区改动仍在，可重新暂存' },
  git_commit: { reversible: true, note: '未推送时可用 git reset 回退；已推送则需改写远端历史' },
  // Diff 面板的 hunk 级操作（toolKey 见 ipc/gitHunks.js）：都只动工作区/索引，git 可回退
  git_apply_hunk: { reversible: true, note: 'hunk 已写入工作区，可用 git checkout/反向补丁回退' },
  git_apply_hunk_cached: { reversible: true, note: 'hunk 已暂存，可用 git restore --staged 撤销' },
  git_apply_hunk_unstage: { reversible: true, note: '仅取消暂存，工作区改动仍在' },
  scheduled_create: { reversible: true, note: '可删除该定时任务停止后续执行' },
  git_checkout: { reversible: false, note: '未提交改动已被永久丢弃（面板 5 秒快照仅覆盖当次操作）' },
  unconfined_exec: { reversible: false, note: '以应用完整权限直接执行，副作用不受沙箱约束' },
  install_plugin: { reversible: false, note: '已下载落盘并注册服务，需手动卸载' },
  pr_review: { reversible: false, note: '结论已对协作方可见（可再发一次覆盖，但对方已看到原结论）' },
  pr_comment: { reversible: false, note: '评论已对外发出且通知已推送；删掉本方评论也撤不回对方已收到的通知' },
  browser_click: { reversible: false, note: '页面上可能已触发提交/支付/发送' },
  browser_fill: { reversible: false, note: '可能已改变页面表单的真实状态' },
  browser_select: { reversible: false, note: '可能已触发页面联动副作用' },
  chrome_click: { reversible: false, note: '在你真实浏览器（含登录态）里可能已触发提交/支付/发送' },
  chrome_fill: { reversible: false, note: '在你真实浏览器里可能已改变表单真实状态' },
  cua_action: { reversible: false, note: '界面操作可能已产生真实副作用（支付/删除/发送）' },
  shell: { reversible: false, note: '命令副作用（文件/进程/网络）无法自动回滚，请核对输出与 git 状态' },
  code_exec: { reversible: false, note: '代码副作用（文件/进程/网络）无法自动回滚，请核对输出与 git 状态' },
  // 期 3：原生工具的可补偿性
  //   · clipboard 写：覆盖用户原剪贴板内容，被覆盖的内容无从取回 → 不可补偿；
  //   · http_request：请求已发往外部系统，其副作用（写入/删除/发送）本机无法回滚 → 不可补偿；
  //   · sqlite 写：改动已落盘，且可能是 DROP/DELETE 这类**内容销毁**，本机无 git 历史可退 → 不可补偿；
  //   · notify / sandbox_code_run：纯本地提示与沙盒内纯计算（无文件/网络副作用）→ 可补偿。
  clipboard: { reversible: false, note: '用户原剪贴板内容已被覆盖，无从取回' },
  http_request: { reversible: false, note: '请求已发往外部系统，其副作用本机无法回滚' },
  sqlite: { reversible: false, note: '数据库改动已落盘；DROP/DELETE 类语句直接销毁内容，本机无历史可回退' },
  notify: { reversible: true, note: '仅弹出本地系统通知，无持久副作用' },
  sandbox_code_run: { reversible: true, note: '沙盒内纯计算（默认无文件/无网络），无外部副作用' },
  // G-doc：文档生成写的是**本机文件** → 可补偿（可重新生成 / 删除）。
  // 与 write_file 同纪律：若目标文件已存在，原内容会被新文档替换，note 里如实说明。
  doc_create: { reversible: true, note: '文档已写入磁盘，可重新生成或删除（目标已存在时原内容会被替换）' },
  xlsx_create: { reversible: true, note: '表格已写入磁盘，可重新生成或删除（目标已存在时原内容会被替换）' },
  pptx_create: { reversible: true, note: '演示文稿已写入磁盘，可重新生成或删除（目标已存在时原内容会被替换）' },
  pdf_generate: { reversible: true, note: 'PDF 已写入磁盘，可重新生成或删除（目标已存在时原内容会被替换）' },
  // G-latex：LaTeX 编译写出的是**本机 PDF 文件** → 可补偿（可重新编译或删除）；
  // probeOnly 体检模式不写文件，本就不进审批面（见 toolLevel 特判）。
  latex_compile: { reversible: true, note: 'PDF 已写入磁盘，可重新编译或删除（目标已存在时原内容会被替换）' },
  // G-CUA：模型发起的桌面自动化顶层调用——会真实操作用户桌面上的原生应用，
  // 一次 computer_use 内部可执行多步点击/输入（可能已触发支付/删除/发送），
  // 本机无法回滚 → 不可补偿（与 cua_action 同纪律）。
  computer_use: { reversible: false, note: '桌面自动化直接操作用户真实应用，可能已产生支付/删除/发送等不可回滚的副作用' },
  // M5 / T5-8：军团协同——名册/看板只读，可逆；总线消息一旦落库即被其它成员读取并可能驱动动作，
  // 本机无法「撤回对方已看到的信息」⇒ 不可逆；等待边可被依赖完成/超时自然消解 ⇒ 可逆。
  team_list_members: { reversible: true, note: '只读查询，无任何副作用' },
  team_board: { reversible: true, note: '只读查询，无任何副作用' },
  // B-04（2026-10-21）：模型侧读消息工具——纯读取，无副作用
  team_read_messages: { reversible: true, note: '只读查询，无任何副作用' },
  team_send_message: { reversible: false, note: '消息已进入团队总线，其它成员可能已读取并据此行动' },
  team_wait: { reversible: true, note: '仅登记本任务的等待边，依赖完成或超时后自动消解' },
  artifact_index: { reversible: true, note: '只读查询，无任何副作用' },
  artifact_get_section: { reversible: true, note: '只读查询，无任何副作用' },
  artifact_get_diff: { reversible: true, note: '只读查询，无任何副作用' },
  artifact_patch_section: { reversible: true, note: '章节历史版本仍在工件库中，可读取旧版本或再次写入覆盖回退' },
};

/**
 * 本次动作的可补偿性。
 * @returns {{reversible: boolean, note: string}}
 */
function reversibilityOf(tool, level) {
  const t = String(tool || '');
  const hit = REVERSIBILITY[t];
  if (hit) return { ...hit };
  if (t.startsWith('mcp__')) {
    // MCP 工具名不可枚举，语义未知：写的是**外部系统**，本机无法回滚 → 一律按不可补偿
    return { reversible: false, note: 'MCP 工具写的是外部系统，本机无法回滚' };
  }
  // 未登记的工具：按分级语义给结论，**说法与 reversible 必须一致**
  //（曾经的错法：note 写「通常可回退」但 reversible=false —— 通知里会变成
  //  「不可补偿（可回退）」，自相矛盾，等于给用户假信息）。
  //   · L2 的语义就是 file-write（见 LEVELS）：本机文件写，git 可回退 → 可补偿，但注明未登记具体工具；
  //   · L1/L3/未知 → 保守按不可补偿（外部副作用或销毁类，说不清就不许诺能修）。
  if (level === 'L2') {
    return { reversible: true, note: '本机写入类动作（未登记具体工具），通常可用 git 回退' };
  }
  return { reversible: false, note: '未登记的动作类型，按不可补偿对待' };
}

/**
 * 构造「执行后告知」的可见通知（纯函数，便于单测；发出去由宿主注入的 sink 负责）。
 *
 * 为什么带 textKey/textParams：渲染层文案必须走 i18n（项目纪律），主进程不能硬编码用户可见文案。
 * text 只作为日志/兜底的可读形态，UI 应以 textKey 为准（key 需 WP-D 侧补齐）。
 */
function buildExecutionNotice({ tool, args = {}, level, ok, ms, error } = {}) {
  const t = String(tool || '(未知动作)');
  const cost = Number.isFinite(Number(ms)) ? Math.max(0, Math.round(Number(ms))) : null;
  const rv = reversibilityOf(t, level);
  return {
    type: 'approval_notice',
    tool: t,
    level: level || null,
    ok: !!ok,
    ms: cost,
    reversible: rv.reversible,
    reversibleNote: rv.note,
    textKey: 'approval.notice.executed',
    textParams: { tool: t, level: level || '', ok: !!ok, ms: cost == null ? 0 : cost, reversible: rv.reversible },
    // 兜底可读文案（日志/无 i18n 场景）；缺少耗时就不编造数字
    text: `已执行 ${t}（分级 ${level || '-'}）：${ok ? '成功' : '失败'}${cost == null ? '' : `，耗时 ${cost}ms`}`,
    ...(error ? { error: String(error).slice(0, 200) } : {}),
  };
}

// ── 通知出口（P2-7）：宿主注入 sink，approval.js 不 require 任何事件/electron 依赖 ──
// 这样本文件仍是纯函数模块（可单测），而「怎么发」由宿主决定（走现有事件通道，不新开 IPC）。
let noticeSink = null;
function setNoticeSink(fn) { noticeSink = typeof fn === 'function' ? fn : null; }

/**
 * 发出「执行后告知」通知。绝不抛（通知失败不能影响已经发生的执行）。
 * sink 未注入时**不静默**：落一条 warn 说明「偏好已开启但通知通道未接线」。
 */
function emitExecutionNotice(payload) {
  const notice = buildExecutionNotice(payload || {});
  try {
    if (typeof noticeSink === 'function') noticeSink(notice);
    else console.warn(`[approval] 「执行后告知」通知通道未接线，本次通知仅此日志：${notice.text}`);
  } catch (e) {
    console.warn('[approval] 执行后告知通知发送失败（不影响主流程）:', e.message);
  }
  return notice;
}

/**
 * P2-7 的统一入口（**正交布尔**语义，见文件头说明）：动作执行完后按需发一条用户可见通知。
 *
 * 四条不发的理由（每条都对应一个必须守住的边界）：
 *   1) `enabled === false`（默认）→ 什么都不做，行为与改造前一致（零破坏）。
 *   2) 只读动作（level=null）→ 不发，否则每个 read_file/grep 都刷一条，通知立刻变噪声。
 *   3) **L1 高危** → 不发，且留日志说明；L1 的正解是执行前确认/阻断，不是事后告知
 *      （通知绝不能替代阻断——这是本档位的红线）。
 *   4) 本次**弹过卡**（need=true）→ 不发：用户刚刚亲自点过确认，再发一条是重复打扰。
 *      因此本函数只覆盖「没弹卡就执行了」的那些动作（规则豁免 / auto-safe 的 L2 / never 档），
 *      而这恰恰是用户最需要事后知情的一类。
 *
 * 为什么这里要重算一次 `needsApproval`：调用点的「最终返回」往往在很深的异步分支里
 * （见 tools/exec.js 的沙箱三平台 + 兜底），把 verdict 一路透传会污染所有分支且容易漏；
 * 而入参是同一份（tool/args/mode/rules），纯函数重算结果必然一致。语义单点仍是 needsApproval。
 *
 * @returns {object|null} 发出的通知；未发则 null（便于调用点与单测断言）
 */
function notifyExecuted({
  enabled, tool, args = {}, approvalMode = 'on-request', conversationId,
  alwaysRules = [], conversationRules = [], ok, ms, error,
}) {
  if (!enabled) return null;
  const level = toolLevel(tool, args);
  if (!level) return null;
  if (level === 'L1') {
    console.warn(`[approval] ${tool} 命中 L1 高危/不可逆：不适用「执行后告知」，仍按审批档要求执行前确认（通知不替代阻断）`);
    return null;
  }
  const verdict = needsApproval({ tool, args, approvalMode, conversationId, alwaysRules, conversationRules });
  if (verdict.need) return null; // 已弹卡确认过
  return emitExecutionNotice({ tool, args, level, ok, ms, error });
}

// 不可「记住」的工具：审批 UI 不得给出「本会话允许 / 始终允许」——
// 这两类决策对它们无效（实现侧不调用 applyApprovalDecision），给了就是产品对用户撒谎。
//   · unconfined_exec：非沙箱执行是单次逃生口，不可沉淀为长期规则；
//   · scheduled_create：创建定时任务 = 持久化 + 未来无人值守执行，一次点击不该授权任意多次。
//   · G-CUA computer_use：桌面自动化的顶层调用（授权模型操作真实应用界面）——
//     一次点击授权的是「一整段 GUI 操作」，且其内部逐次动作另有独立确认，不可沉淀为长期规则；
//   · G-CUA cua_action：逐次界面动作——CUA 的敏感动作设计上恒逐次确认（决策不落规则库），
//     若 UI 仍给「本会话/始终允许」按钮，用户点了却对后续动作无效 → 即为产品撒谎，
//     故与顶层调用一并标记为不可记忆（ApprovalCard 只显示「允许一次 / 拒绝」）。
const NON_REMEMBERABLE = new Set(['unconfined_exec', 'scheduled_create', 'computer_use', 'cua_action', 'install_plugin', 'pr_review', 'pr_comment']); // P0-1: 三者恒 L3 不可记忆
const isRememberable = (tool) => !NON_REMEMBERABLE.has(tool);

// 工具 → 默认分级
// ── 以下 4 个工具**不走本表**，分级由 toolLevel() 特判分支决定 ──────────────────────
// 它们曾以「文档性条目」留在本表，但对 toolLevel() **不可达**：特判分支在末行 `|| 'L2'`
// 之前就 return，表里的值永远不会被读到 → 只制造「登记了以为生效」的错觉（改表不生效）。
// 门禁 test/tool-registration-matrix.test.mjs 断言 TOOL_LEVEL ∩ SPECIAL_CASED_TOOLS === ∅。
//   · shell         由 DANGEROUS_PATTERNS 判定：命中危险模式 L1（才实际询问，见 needsApproval），否则 null
//   · code_exec     由 isDangerousCode 判定：危险代码 L1，否则 L3
//                   T4-7：普通代码 L3（可规则豁免，代码全文进审批卡摘要）；危险代码（child_process /
//                   危险 shell 命令内嵌）L1，恒逐次确认不可豁免——与 shell 危险命令同纪律
//   · latex_compile 由 args.probeOnly 判定：探测 null（不进审批面），否则 L2
//                   G-latex：实际编译产出**本机 PDF 文件**，对齐「文件写类」；probeOnly 不写文件
//   · sandbox_code_run 由 isDangerousCode 判定：命中逃逸/子进程原语 L1，否则 L2
//                   P0-3（2026-10-28）：vm 不是安全边界（见 nativeSandbox/childEntry.js），
//                   一行 constructor.constructor 即可取回宿主 process ⇒ 逃逸 payload 必须升 L1，
//                   否则 auto-safe 档下它比 code_exec（普通代码 L3）还松，属安全反转。
const TOOL_LEVEL = {
  git_commit: 'L2', git_add: 'L2', apply_patch: 'L2',
  write_file: 'L2', edit_file: 'L2',
  mcp__: 'L3',
  // 对话内插件安装 = 给模型「装软件」的能力（网络下载 + 落盘 + 注册服务），
  // 恒为 L3：任何审批档位都弹卡确认，且不可经「本对话同类」规则静默放行
  install_plugin: 'L3',
  // PR 审查结论（APPROVE / REQUEST_CHANGES）对外可见、影响协作方判断，
  // 恒为 L3：不可经「本对话同类」规则静默放行（评论同理，防止误发）
  pr_review: 'L3', pr_comment: 'L3',
  // T4-1 Browser Use：全部纳入 L3 审批闸。navigate/screenshot/extract 可经规则豁免
  // （规则粒度=完整 URL/选择器前缀）；click/fill/select 由 browserTools 层恒逐次确认，
  // 不经 needsApproval——页面上的点击/输入可能触发支付、登录、发送等真实副作用。
  browser_navigate: 'L3', browser_screenshot: 'L3', browser_extract: 'L3',
  browser_click: 'L3', browser_fill: 'L3', browser_select: 'L3',
  // T4-2 Chrome 接管：连接授权 + 页面操作全部 L3。
  // chrome_connect 由 chromeRelay 恒逐次弹卡（授权只对当次连接有效，不经规则豁免）；
  // chrome_click/fill 由 chromeTools 层恒逐次确认——操作对象是用户真实浏览器（含登录态），
  // 风险高于 T4-1 的受控沙箱浏览器；tabs/navigate/screenshot/extract 走 L3 可规则豁免。
  // chrome_status 不进审批面由 toolLevel() 的 chrome_status 特判承担（与 notify/todo_write 同纪律）：
  // 本表刻意不含该条目——特判早返回之后表项不可达，见下方同名注释块。
  chrome_connect: 'L3',
  chrome_tabs: 'L3', chrome_navigate: 'L3', chrome_screenshot: 'L3', chrome_extract: 'L3',
  chrome_click: 'L3', chrome_fill: 'L3',
  // T4-7 Code Mode：见上方「不走本表」块（code_exec 分级由 toolLevel 特判 isDangerousCode 决定）
  // V03（2026-10-16）：受限沙箱不可用时的单次非沙箱执行审批（显式逃生口，非隔离能力）。
  // L1：任何档位、任何规则都不可豁免；该审批只取 'once' 决策，从不进入 always/conversation 规则库。
  unconfined_exec: 'L1',
  // 2026-10-17：破坏性 git 操作分级（按「是否会静默销毁内容」而不是「是否写磁盘」）：
  //   · git_checkout（丢弃工作区改动）判 L3：内容是**真的没了**，任何档位都弹卡；
  //     可经「本对话同类」豁免（level !== L1），用户点过一次后不再打扰。
  //   · git_restore_staged（取消暂存）判 L2：内容仍在工作区，只是索引回退，属可逆操作；
  //     判 L3 会让「取消暂存」每点一次弹一次卡——用户为了省事会转去用更危险的「放弃修改」，
  //     把可逆操作逼成不可逆操作，是安全设计上的反效果。
  //   · 判 L2 的反面（auto-safe 静默放行）在这里可接受：auto-safe 的语义正是「文件写类自动放行」。
  git_checkout: 'L3',
  git_restore_staged: 'L2',
  // 2026-10-17：模型创建定时任务（scheduled_create）——持久化 + 未来无人值守自动执行，
  // 等价于「给 AI 一个以后自己动手的长期授权」，判 L3：任何审批档位都弹卡。
  // 实现侧（main/scheduledTools.js）刻意不落规则库，所以 L3 的「可豁免」对本工具实际不生效。
  scheduled_create: 'L3',
  // G-doc：文档生成四工具产出的是**本机文件**，分级对齐「文件写类」→ L2
  // （auto-safe 档下自动放行，on-request/always 逐次确认；写路径白名单外的目标另由
  //  main/docTools.js 的写闸强制弹一次且不落地规则，与本表的分级正交）。
  doc_create: 'L2', xlsx_create: 'L2', pptx_create: 'L2', pdf_generate: 'L2',
  // G-latex：见上方「不走本表」块（latex_compile 分级由 toolLevel 特判 args.probeOnly 决定）
  // G-CUA：模型侧桌面自动化顶层调用（computer_use）——启动一整段 GUI 任务、可执行任意多步
  // 点击/输入/按键（含支付/删除/发送类真实副作用），判 L1：任何审批档都逐次弹卡。
  // 与 unconfined_exec 同纪律：L1 硬地板不可经规则豁免，且（见 NON_REMEMBERABLE）不落规则库；
  // 其内部的逐次动作另由 cua_action 的 L1/L2 分级独立把关。
  computer_use: 'L1',
  // ── F-002（第七轮）：把「隐式兜底 L2」显式化 ───────────────────────────────
  // 下列 11 个工具此前既不在本表、也未被 toolLevel() 特判，级别实际来自**唯一兜底**
  // `return TOOL_LEVEL[tool] || 'L2'`（见 toolLevel 末行）。危险在于 auto-safe 档对 L2 直接放行
  // （见 needsApproval），于是「新工具漏登记」＝「默认自动批准」—— 一个新增的写文件/外发工具
  // 会在无人值守档位静默过闸。本轮纪律：11 条一律显式写 'L2'，与兜底值**完全相同**，
  // 实际审批行为逐字节不变（不升 L3、不移出审批面 —— 那些属产品行为变更，另案评估）。
  // 门禁：test/tool-registration-matrix.test.mjs 断言每个模型工具「不得依赖末行兜底」。
  //
  // 第八轮 D-801（2026-10-21）：**兜底方向已由 'L2' 改为 'L3'**。
  // 原先「漏登记 ⇒ 级别取自 L2 ⇒ auto-safe 档静默放行」是一条结构性风险：新增的写文件/外发
  // 工具只要忘了登记，就会在无人值守档位自动过闸。改成 L3 后，未知工具按「需审批、可被显式
  // 规则豁免」处置（与 code_exec 的普通代码、mcp__ 工具同档），失败方向从 fail-open 翻成
  // fail-closed。上表这 11 条仍保持**显式登记**：显式登记优于依赖兜底——读代码的人不必去猜末行。
  search_plugins: 'L2', // 市场检索只读，但会向外部 registry 发起查询（外发数据）→ 不放宽到 null
  pr_list: 'L2', // 只读 GitHub API；但涉及用户 token 与私有仓库元数据，故不并入
  pr_view: 'L2', //   READONLY_TOOLS（并入后 on-request 档不再提示），保持 L2 = 维持现状
  pr_diff: 'L2', //   同 pr_list / pr_view（diff 内容含私有仓库代码）
  web_search: 'L2', // 读取外部内容且外发查询词 → 留 L2；后续收紧应与 web_fetch 统一评估
  web_fetch: 'L2', // 可拉任意 URL（SSRF 风险由 webTools 侧守卫承担）→ 分级保持 L2 维持现状
  deep_research: 'L2', // 多轮外部检索（web_search 的上层聚合）→ 与 web_search/web_fetch 同档
  // chrome_status：2026-10-20 产品裁决（D-14）「退出审批面」——判据在 toolLevel() 的特判分支
  // （早返回 null）。此处**刻意不留条目**，理由同 todo_write：特判提前 return 后该条目永不被末行
  // 读到，属「不可达配置」，与门禁「TOOL_LEVEL ∩ SPECIAL_CASED_TOOLS === ∅」直接冲突。
  // 顺带纠正一处失实登记：本行的 'L2' 从未驱动过弹卡——chrome_status 既不在 agent-core 的
  // APPROVAL_TOOLS（:1011），其 handler（chromeTools.toolChromeStatus）也不经 needsApproval。
  // 删掉它让「登记值」与「实现行为」一致；真正起保护作用的是 toolLevel 特判（见下）。
  // todo_write：2026-10-20 产品裁决「退出审批面」——判据在 toolLevel() 的特判分支（早返回 null）。
  // 此处**刻意不留 'L2' 条目**：特判会提前 return，条目永不被末行读到 ⇒ 属「不可达配置」，
  // 与门禁「TOOL_LEVEL ∩ SPECIAL_CASED_TOOLS === ∅」直接冲突（读者会以为改表能改分级）。
  // 它并非「无分级」，而是「分级由特判承担」——覆盖率门禁认 SPECIAL_CASED 这条路径。
  spawn_subagent: 'L2', // 间接执行：子代理只用只读工具集，但消耗预算且可多轮循环 → 保留 L2 而非 null
  // orchestrate_task：2026-10-20 产品裁决「**不升 L3**，钉在 L2」。理由（防止后人重开这个话题）：
  //   · Worker 池内**每一次工具调用都另有独立审批**（内层逐工具闸），外层再判 L3 等于对同一动作
  //     二次确认：用户要连点两次「同意」，而第二次不携带任何新信息，纯属摩擦。
  //   · 真正的风险控制点在「子 Agent 能调什么工具」，这已由能力闸 + 角色子集三级钳制守住，
  //     不靠外层档位。
  //   · 若将来要升 L3，**必须先回答「内层逐工具审批是否同时降级」**——否则只是把弹卡数量翻倍。
  orchestrate_task: 'L2', // 见上方裁决块：刻意**不升 L3**（2026-10-20）
  // M5 / T5-8：军团协同——总线发言写的是**团队内部总线**（不触盘、不出网、不外发），
  // 但会被其它成员读到并驱动后续动作 ⇒ L2（auto-safe 放行，on-request/always 逐次确认）。
  // 体积闸在 teamStore.appendMessage 内部，审批层不重复判断。
  team_send_message: 'L2',
  // 动态等待只改本任务自己的等待边（登记后立刻收尾让出槽位），无外部副作用 ⇒ L2。
  team_wait: 'L2',
  // T6-6：工件章节写入。设计稿 §7 的 L1 与本项目 L1（高危不可逆）语义相反，照字面登记会让无人
  // 值守成员任务每次 patch 都被 deny；按本项目语义译为 L2（可撤销写、限本项目工件，同 write_file）。
  artifact_patch_section: 'L2',
};

// 只读工具：任何档位都不询问
const READONLY_TOOLS = new Set([
  'read_file', 'list_dir', 'grep', 'glob',
  'git_status', 'git_diff', 'git_log', 'git_branch',
  // M5 / T5-8：军团协同——列表查询是只读，不触发审批询问
  'team_list_members', 'team_board',
  // B-04 / T6-6：读消息与工件读取三工具均为只读查询（读总线不改变任何状态）
  'team_read_messages', 'artifact_index', 'artifact_get_section', 'artifact_get_diff',
]);

// toolLevel() 在 `|| 'L2'` 兜底**之前**按工具名特判的工具（须与 toolLevel 分支同步，漏一个即门禁误判）：
//   漏登记 → 门禁把该工具误判成「依赖 || 'L2' 兜底」；多登记 → 门禁放过一个其实没特判的工具。
//   故 test/tool-registration-matrix.test.mjs 会从 toolLevel() 源码反解 `tool === 'x'` 分支做交叉校验。
// 为什么不含 read_file 等 8 个只读工具：它们由上面的 READONLY_TOOLS 承担（toolLevel 第 1 个分支就是
//   `READONLY_TOOLS.has(tool)`）。两表刻意**不重叠**，否则「三选一」覆盖断言失效、无法区分谁在生效。
// 也没有 mcp__：它是前缀通配（toolLevel 用 startsWith 判），不是可枚举的工具名。
const SPECIAL_CASED_TOOLS = new Set([
  'notify', 'todo_write', 'chrome_status', 'clipboard', 'http_request', 'sqlite',
  'shell', 'code_exec', 'cua_action', 'latex_compile', 'sandbox_code_run',
]);

// P0-S1：危险命令规则统一从 dangerousPatterns.js 导入（单一事实来源）。事故背景：本文件原有
// 一份 10 条副本且注释声称与主进程同步，而 sandbox.js 实际 12 条已漂移 ⇒ 审批层比沙箱层更宽松，
// `curl xxx | sh` / `rm --recursive --force` 在 on-request 档下不弹审批直接执行。
// P1-2 / P2-8：Code Mode 危险代码与 CUA 强确认类目同样收敛到该模块（原各一份手抄副本）。
const {
  DANGEROUS_PATTERNS, isDangerousCommand, matchDangerousPattern, isDangerousCode, cuaStrongConfirm,
} = require('./dangerousPatterns');

// 期 3：SQL 只读判定（单一事实来源）——2026-10-21 抽至 main/sqlReadonly.js
//（为 D-801 的注释腾出 800 行软档余量，语义逐字等价）；本文件继续 re-export，消费方零改动。
const { isReadonlySql } = require('./sqlReadonly');

function toolLevel(tool, args = {}) {
  if (READONLY_TOOLS.has(tool)) return null;
  // 期 3：notify 不进审批面——它是「告知用户」的原语（长任务完成时提醒用户回来看），
  // 对它逐次弹卡等于废掉这个工具；且无持久副作用（与 todo_write 同纪律）。
  if (tool === 'notify') return null;
  // 2026-10-20 产品裁决：todo_write 退出审批面（不弹卡）。真正动机是「审批脱敏」而非「它无害」：
  // 一次 run 能触发十几次清单更新（deep_research 五阶段、长任务分步都要刷清单），逐次弹卡
  // 会让用户对审批卡麻木——而真正需要看的审批（写文件 / 执行命令 / 外发数据）就被稀释了。
  // 其次才是无害性：它是引擎内纯状态工具，只更新本应用自己的会话清单并经 onTodos 推给 UI，
  // 不出网、不触盘、不出项目目录、无持久副作用，与 notify 同纪律（notify 已于期 3 退出审批面）。
  if (tool === 'todo_write') return null;
  // 2026-10-20 产品裁决（D-14）：chrome_status 退出审批面。动机是**审批脱敏**而非无害性——一次
  // 浏览器任务里模型会反复确认连接状态 2–5 次，这些零后果卡与「允许写文件 / 执行命令」同形，
  // 用户点习惯后会把真正危险的那张也顺手点过。返回字段只有 {connected, relayListening, relayPort,
  // relayError, connectedSince, browser}，**不含任何页面信息**（无 URL/标题/标签页），拿不到浏览内容。
  // 反转条件：若将来给它加「顺便重连」等有副作用语义，必须重新评估并移回审批面。
  if (tool === 'chrome_status') return null;
  // 期 3：clipboard 读只读（不询问）；写覆盖用户剪贴板原内容 → L2。
  if (tool === 'clipboard') return String(args.action || 'read') === 'write' ? 'L2' : null;
  // 期 3：http_request——GET/HEAD 只读；其余方法改动外部系统状态，判 L3（可经规则豁免，
  // 规则粒度=URL 前缀，与 browser_navigate 同纪律）。
  if (tool === 'http_request') {
    const m = String(args.method || 'GET').toUpperCase();
    return (m === 'GET' || m === 'HEAD') ? null : 'L3';
  }
  // 期 3：sqlite——只读语句（SELECT/PRAGMA/EXPLAIN/WITH）不询问；写语句判 L3。
  // 为什么写库是 L3 而不是 L2：DROP/TRUNCATE/DELETE 会**静默销毁内容**且本机没有 git 可回退，
  // 与 git_checkout（丢工作区改动）同一分级纪律——按「是否会静默销毁内容」而非「是否写磁盘」。
  if (tool === 'sqlite') {
    if (String(args.action || 'query').toLowerCase() === 'tables') return null;
    return isReadonlySql(args.sql) ? null : 'L3';
  }
  if (tool === 'shell') {
    return DANGEROUS_PATTERNS.some((p) => p.test(String(args.command || ''))) ? 'L1' : null;
  }
  // T4-7：Code Mode 危险代码判 L1（恒逐次、规则不可豁免），普通代码 L3（可豁免）
  if (tool === 'code_exec') return isDangerousCode(args.code) ? 'L1' : 'L3';
  // P0-3：沙盒代码命中逃逸/子进程原语时升 L1 —— 否则 auto-safe 下「一行 constructor.constructor 取宿主 process」免审批执行，比 code_exec 还松。
  if (tool === 'sandbox_code_run') return isDangerousCode(args.code) ? 'L1' : 'L2';
  // P1-2（2026-10-17）：CUA 界面动作——命中强确认类目（支付/删除/发送/验证码）判 L1
  // （恒逐次确认、规则不可豁免，与 shell 危险命令同纪律）；其余界面动作判 L2
  // （按审批档语义：on-request/always 逐次确认、auto-safe 放行——含「确认」类通用
  // 敏感词，与视觉路径 needsVisionConfirmation 的 soft 分层一致：强确认才不可放行）。
  // 此前 CUA 自建「mustConfirm || mode === 'on-request'」判定逻辑，与审批中心双份实现；
  // 现判定统一走本模块，类目规则单一事实来源在 dangerousPatterns.js。
  if (tool === 'cua_action') {
    const ctx = [args.text, args.key, args.label, args.target].filter(Boolean).join(' ');
    return cuaStrongConfirm(ctx).strong ? 'L1' : 'L2';
  }
  // G-latex：latex_compile 的 probeOnly（工具链体检）只探测不写文件、无副作用 → 不进审批面；
  // 实际编译写 PDF 判 L2（见 TOOL_LEVEL）。
  if (tool === 'latex_compile') return args.probeOnly === true ? null : 'L2';
  if (tool.startsWith('mcp__')) return 'L3';
  // 兜底只兜「未登记的原生/插件工具」（mcp__ 已在上面返回 L3）。第八轮 D-801 由 'L2' 改为 'L3'：
  // 未登记 ≠ 自动批准 —— 'L2' 在 auto-safe 档直接放行（漏登记即静默过闸），'L3' 需审批且可被
  // 「始终允许/本对话同类」豁免，与 code_exec 普通代码同档。当前全部工具都已被显式覆盖，故零行为变化；
  // 它锁的是「将来新增工具忘了登记」这一条路径。
  return TOOL_LEVEL[tool] || 'L3';
}

// P0-S1 / P2-8：Code Mode 危险代码判定已收敛至 dangerousPatterns.js（单一事实来源），
// 此处仅做转投，保持既有导出面不断裂。

// 综合判定：该次工具调用是否需要弹审批
function needsApproval({ tool, args = {}, approvalMode = 'on-request', conversationId, alwaysRules = [], conversationRules = [] }) {
  const level = toolLevel(tool, args);
  // P0-6：L1 是硬地板，任何档位都弹卡（含 never）—— 此前 never 短路在首行，导致「全不询问」下 rm -rf 零确认执行，比 Worker 的 auto-safe 还松。
  if (level === 'L1') return { need: true, level };
  if (!level || approvalMode === 'never') return { need: false };

  // 规则豁免（始终允许 / 本对话同类）
  // P1-C：L1 危险命令不接受任何规则豁免——「始终允许」也不可覆盖危险命令，fail-closed。
  // 原实现下 pattern='*' 或宽松正则可让 rm -rf / 之类永久放行，是审批中心最大的缺口。
  if (level !== 'L1') {
    const target = approvalTarget(tool, args);
    if (alwaysRules.some((r) => r.tool === tool && matchPattern(r.pattern, target))) {
      return { need: false, matched: 'always' };
    }
    if (conversationRules.some((r) => r.tool === tool && r.conversationId === conversationId && matchPattern(r.pattern, target))) {
      return { need: false, matched: 'conversation' };
    }
  }

  if (approvalMode === 'always') return { need: true, level };
  if (approvalMode === 'auto-safe' && level === 'L2') return { need: false };
  return { need: true, level };
}

// 规则匹配对象：shell 取 command，文件类取 path，mcp 取 server/tool
function approvalTarget(tool, args = {}) {
  if (tool === 'shell') return String(args.command || '');
  if (tool === 'install_plugin') return String(args.url || args.pkg || args.name || '');
  if (tool === 'browser_navigate') return String(args.url || '');
  if (tool === 'browser_screenshot') return 'page';
  if (tool === 'browser_extract') return String(args.selector || 'page');
  // T4-2 Chrome 接管：规则粒度与 browser_* 对齐（URL 前缀/选择器/固定面）
  if (tool === 'chrome_connect') return String(args.userAgent || '');
  if (tool === 'chrome_navigate') return String(args.url || '');
  if (tool === 'chrome_screenshot') return 'page';
  if (tool === 'chrome_extract') return String(args.selector || 'page');
  if (tool === 'chrome_tabs') return 'tabs';
  // T4-7 Code Mode：规则粒度=代码前缀（matchPattern 前缀语义——批准过 200 字符前缀，
  // 后续代码只有以该前缀开头且边界为空白才豁免，防止「批准短代码后长代码静默放行」）
  if (tool === 'code_exec') return String(args.code || '').slice(0, 200);
  // 期 3：原生工具的规则粒度（与 code_exec 同一纪律——批准短操作不得让长操作静默放行）：
  //   clipboard 按动作（读不在审批面，只有写需要粒度）、http_request 按 URL 前缀、
  //   sqlite 按「库路径 + SQL 前缀」、sandbox_code_run 按代码前缀。
  if (tool === 'clipboard') return String(args.action || 'read');
  if (tool === 'http_request') return String(args.url || '');
  if (tool === 'sqlite') return `${String(args.path || '')} ${String(args.sql || '').slice(0, 120)}`;
  if (tool === 'sandbox_code_run') return String(args.code || '').slice(0, 200);
  // P1-2：CUA 界面动作——规则粒度为动作上下文（CUA 决策本就不落规则库，此处仅为
  // needsApproval 的豁免检查提供一致的目标形态）
  if (tool === 'cua_action') return [args.text, args.key, args.label, args.target].filter(Boolean).join(' ').slice(0, 200);
  // G-CUA：顶层桌面自动化调用——规则粒度=目标应用 + 目标描述（本工具 L1 不可豁免，
  // 此处仅为 needsApproval 的豁免检查提供一致的目标形态，与 cua_action 同款纪律）。
  if (tool === 'computer_use') return `${String(args.app_name || args.appName || '')} ${String(args.objective || '')}`.trim().slice(0, 200);
  if (tool.startsWith('mcp__')) return tool;
  // 2026-10-17：破坏性 git 操作按「受影响文件列表」做规则粒度——
  // 用户对 a.js 允许「本会话同类」后，b.js 仍会再问一次（不做全工具一次放行）。
  if (tool === 'git_checkout' || tool === 'git_restore_staged') return String(args.files || '').slice(0, 200);
  return String(args.path || args.patch?.slice(0, 80) || args.message || '');
}

// P1-C：规则匹配改「前缀白名单」语义
// 背景：原实现把 pattern 当正则做子串匹配——规则 'pnpm test' 会命中 'pnpm test && rm -rf /'
// 这类夹带命令；pattern='*' 更是等同于全放行。规则一律由审批时捕获的完整命令/路径字面量生成
// （见 main.js applyApprovalDecision），因此按「已批准前缀」匹配：整串相等，或后续字符为空白
// （命令参数），跨段夹带（&&/;/|）不命中。
function matchPattern(pattern, target) {
  const p = String(pattern ?? '').trim();
  const t = String(target ?? '').trim();
  if (!p || p === '*') return false; // 空/通配模式不再等同于全放行
  if (t === p) return true;
  if (!t.startsWith(p)) return false;
  const next = t.slice(p.length)[0];
  return next === ' ' || next === '\t';
}

// T4-1：浏览器操作敏感意图探测——URL/选择器/输入值命中支付、登录、发送类词，
// 审批卡加醒目警示行（词表刻意保守：宁可多警示，不可漏警示）
const BROWSER_SENSITIVE_RE = /(pay|payment|checkout|order|purchase|login|signin|sign[- ]?in|password|send|submit|transfer|withdraw|删除|支付|付款|下单|购买|登录|发送|提交|转账|提现)/i;
function browserSensitive(text) {
  return BROWSER_SENSITIVE_RE.test(String(text || ''))
    ? '\n\n⚠ 该操作可能触发支付/登录/发送类真实副作用，请确认页面与目标元素无误后再批准。'
    : '';
}

// G-doc：文档生成审批卡的内容概览——取前若干块的文本，让用户在点批准前看到「这份文件大概是什么」，
// 而不是只给一个路径（只给路径时用户无法判断内容是否是自己要的，只能盲批）。
function docPreview(blocks, max = 6) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue;
    const items = Array.isArray(b.items) ? b.items.map((x) => String(x)).join(' / ') : '';
    const heads = Array.isArray(b.headers) ? b.headers.map((x) => String(x)).join(' | ') : '';
    const t = String(b.text || '').trim() || items || heads;
    if (t) out.push(`· [${String(b.type || 'paragraph')}] ${t.slice(0, 80)}`);
    if (out.length >= max) break;
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

// 审批摘要（供弹窗展示）
function approvalSummary(tool, args = {}) {
  switch (tool) {
    case 'shell':
      return { level: 'L1', title: '危险命令执行', detail: String(args.command || '').slice(0, 500) };
    case 'write_file':
      return { level: 'L2', title: '写入文件', detail: `${args.path || ''}\n\n${String(args.content || '').slice(0, 500)}` };
    case 'edit_file':
      return { level: 'L2', title: '编辑文件', detail: `${args.path || ''}\n查找：${String(args.search || '').slice(0, 200)}\n替换：${String(args.replace || '').slice(0, 200)}` };
    case 'apply_patch':
      return { level: 'L2', title: '应用补丁', detail: String(args.patch || '').slice(0, 800) };
    case 'git_commit':
      return { level: 'L2', title: 'Git 提交', detail: String(args.message || '').slice(0, 300) };
    case 'git_add':
      return { level: 'L2', title: 'Git 暂存', detail: String(args.files || '.') };
    // 2026-10-17：Diff 面板的破坏性动作——文案必须写明「不可撤销」，否则用户会当成普通暂存点掉
    case 'git_checkout':
      return {
        level: 'L3',
        title: '丢弃工作区改动',
        detail: `将还原以下文件到上次提交状态：\n${String(args.files || '').slice(0, 300)}\n\n`
          + '⚠ 这些文件里未提交的修改会**永久丢失，无法撤销**（面板内的 5 秒撤销快照仅覆盖刚才那一次）。'
          + '确认要丢弃吗？',
      };
    case 'git_restore_staged':
      return {
        level: 'L2',
        title: '移出暂存区',
        detail: `将把以下文件移出暂存区（工作区改动保留）：\n${String(args.files || '').slice(0, 300)}`,
      };
    // 2026-10-17：模型侧创建定时任务——文案必须讲清「以后会自己跑」，否则用户会当成一次性动作
    case 'scheduled_create':
      return {
        level: 'L3',
        title: '创建定时任务',
        detail: `任务名：${args.name || '(未命名)'}\n计划：${String(args.schedule || '')}\n`
          + `执行内容：${String(args.prompt || '').slice(0, 300)}\n\n`
          + '⚠ 该任务会按上述计划**无人值守自动执行**——你不在场时它也会跑。请确认内容与频率无误。',
      };
    case 'install_plugin': {
      const what = args.kind === 'mcp'
        ? `MCP 服务（npm 包 ${args.pkg || ''}，npx 启动）`
        : `技能（仓库 ${args.url || ''}）`;
      return {
        level: 'L3',
        title: '安装网络插件',
        detail: `将要安装：${what}\n来源：${args.url || args.pkg || ''}\n`
          + '安装动作含网络下载与本地落盘；技能内容会进入模型上下文（已做提示注入检测）。确认允许？',
      };
    }
    // ── T4-1 Browser Use（L3 审批卡文案）──
    case 'browser_navigate':
      return {
        level: 'L3', title: '浏览器打开页面',
        detail: `将要访问：${String(args.url || '').slice(0, 300)}${browserSensitive(String(args.url || ''))}`,
      };
    case 'browser_click':
      return {
        level: 'L3', title: '浏览器点击',
        detail: `将在页面点击元素：${String(args.selector || '').slice(0, 200)}${browserSensitive(String(args.selector || ''))}`,
      };
    case 'browser_fill':
      return {
        level: 'L3', title: '浏览器填写表单',
        detail: `将在元素 ${String(args.selector || '').slice(0, 200)} 输入：${String(args.value || '').slice(0, 120)}${browserSensitive(`${args.selector || ''} ${args.value || ''}`)}`,
      };
    case 'browser_select':
      return {
        level: 'L3', title: '浏览器选择下拉项',
        detail: `将在元素 ${String(args.selector || '').slice(0, 200)} 选择：${JSON.stringify(args.value ?? '').slice(0, 120)}${browserSensitive(`${args.selector || ''} ${JSON.stringify(args.value ?? '')}`)}`,
      };
    case 'browser_screenshot':
      return { level: 'L3', title: '浏览器页面截图', detail: args.fullPage ? '截取整页（含未滚动区域）' : '截取当前视口' };
    case 'browser_extract':
      return {
        level: 'L3', title: '浏览器读取页面内容',
        detail: args.selector ? `读取元素：${String(args.selector).slice(0, 200)}` : '读取整页正文文本',
      };
    // ── T4-2 Chrome 接管（L3 审批卡文案）──
    case 'chrome_connect':
      return {
        level: 'L3', title: 'Chrome 接管连接请求',
        detail: `浏览器：${String(args.userAgent || '未知').slice(0, 160)}\n扩展：${String(args.extension || '')} v${String(args.version || '')}\n`
          + '批准后，MJ Code 可读取并操作你 Chrome 中的 http/https 标签页（包括登录态页面）。'
          + '点击/填写等写操作仍会逐次确认；本授权只对当前连接有效，断开后需重新批准。',
      };
    case 'chrome_tabs':
      return { level: 'L3', title: '读取 Chrome 标签页列表', detail: '将读取所有打开的 http/https 标签页的标题与地址（不读取页面内容）' };
    case 'chrome_navigate':
      return {
        level: 'L3', title: '在 Chrome 中打开页面',
        detail: `将在你的浏览器${args.tab_id != null ? `标签页 ${args.tab_id}` : '当前标签页'}访问：${String(args.url || '').slice(0, 300)}${browserSensitive(String(args.url || ''))}`,
      };
    case 'chrome_click':
      return {
        level: 'L3', title: 'Chrome 页面点击',
        detail: `将在你的浏览器页面点击元素：${String(args.selector || '').slice(0, 200)}${browserSensitive(String(args.selector || ''))}`,
      };
    case 'chrome_fill':
      return {
        level: 'L3', title: 'Chrome 页面填写',
        detail: `将在元素 ${String(args.selector || '').slice(0, 200)} 输入：${String(args.value || '').slice(0, 120)}${browserSensitive(`${args.selector || ''} ${args.value || ''}`)}`,
      };
    case 'chrome_screenshot':
      return {
        level: 'L3', title: 'Chrome 标签页截图',
        detail: `截取${args.tab_id != null ? `标签页 ${args.tab_id}` : '当前标签页'}视口（画面可能包含登录态、私人内容，请确认）`,
      };
    case 'chrome_extract':
      return {
        level: 'L3', title: '读取 Chrome 页面内容',
        detail: args.selector ? `读取元素：${String(args.selector).slice(0, 200)}` : '读取整页正文文本（登录态页面的内容也会回传给模型）',
      };
    // ── T4-7 Code Mode（L3/L1 审批卡文案：代码文本进摘要，危险代码额外警示行）──
    case 'code_exec': {
      const code = String(args.code || '');
      const danger = isDangerousCode(code);
      const shown = code.slice(0, 600) + (code.length > 600 ? '\n…（完整代码见工具参数）' : '');
      return {
        level: danger ? 'L1' : 'L3',
        title: danger ? '执行代码（命中危险模式）' : '执行代码（Code Mode）',
        detail: `代码执行会话跨调用保留状态${args.restart ? '；本次将先重置会话（旧状态丢弃）' : ''}。将要执行：\n${shown}`
          + (danger ? '\n注意：代码包含 child_process/危险命令等模式，恒逐次确认，不可被「始终允许」规则豁免。' : ''),
      };
    }
    // ── 期 3：原生内置工具审批卡文案 ──
    case 'clipboard':
      return {
        level: 'L2', title: '写入系统剪贴板',
        detail: `将把以下内容写入剪贴板（${String(args.text || '').length} 字符）：\n${String(args.text || '').slice(0, 500)}\n\n`
          + '⚠ 你当前的剪贴板内容会被**覆盖且无法恢复**，请确认没有还没粘贴的东西。',
      };
    case 'http_request': {
      const method = String(args.method || 'GET').toUpperCase();
      const headers = args.headers && typeof args.headers === 'object' ? Object.keys(args.headers) : [];
      return {
        level: (method === 'GET' || method === 'HEAD') ? 'L2' : 'L3',
        title: `HTTP 请求（${method}）`,
        detail: `${method} ${String(args.url || '').slice(0, 300)}\n`
          + (headers.length ? `请求头：${headers.slice(0, 12).join(', ')}\n` : '')
          + (args.body ? `请求体：${String(args.body).slice(0, 300)}\n` : '')
          + (method === 'GET' || method === 'HEAD'
            ? '（只读请求，不改动外部系统状态）'
            : '⚠ 该请求会改变外部系统的状态（创建/修改/删除），其副作用本机无法回滚。'),
      };
    }
    case 'sqlite': {
      const action = String(args.action || 'query').toLowerCase();
      if (action === 'tables') {
        return { level: null, title: '读取 SQLite 表清单', detail: `数据库：${String(args.path || '')}` };
      }
      const readonly = isReadonlySql(args.sql);
      return {
        level: readonly ? null : 'L3',
        title: readonly ? 'SQLite 只读查询' : 'SQLite 写入',
        detail: `数据库：${String(args.path || '')}\nSQL：${String(args.sql || '').slice(0, 500)}`
          + (readonly ? '' : '\n\n⚠ 这是写语句，可能包含 DROP/DELETE 这类**直接销毁内容**的操作，'
            + '且本机没有可回退的历史版本。请确认语句与目标库无误。'),
      };
    }
    case 'sandbox_code_run': {
      const code = String(args.code || '');
      const shown = code.slice(0, 600) + (code.length > 600 ? '\n…（完整代码见工具参数）' : '');
      // P0-3：展示档必须与 toolLevel 同源，否则命中逃逸原语时卡片仍按 L2（普通色）渲染，安全信息失真。
      const lvl = isDangerousCode(code) ? 'L1' : 'L2';
      return {
        level: lvl,
        title: '执行代码（强沙盒）',
        detail: `在一次性隔离子进程中执行以下代码（默认无文件访问、默认无网络）：\n${shown}\n`
          + '需要文件/网络/持久状态时请改用 code_exec（会另行走逐次确认）。',
      };
    }
    // ── G-doc 审批卡（写明输出路径 + 体量概览）；P0-2：传 artifactId 时写「来源工件@版本」而非「0 个内容块」（本文件顶 800 行，三处均一行换一行）──
    case 'doc_create':
      return {
        level: 'L2', title: '生成 Word 文档',
        detail: `输出：${String(args.path || '')}\n标题：${String(args.title || (args.artifactId ? '（取工件标题）' : '（无）'))}\n`
          + (args.artifactId ? `来源工件：${String(args.artifactId)}@${String(args.version || '最新版本')}（正文取自工件库，不再由工具参数重复传入）` : `内容块：${Array.isArray(args.blocks) ? args.blocks.length : 0} 个\n\n${docPreview(args.blocks)}`),
      };
    case 'xlsx_create':
      return {
        level: 'L2', title: '生成 Excel 表格',
        detail: `输出：${String(args.path || '')}\n${args.artifactId ? `来源工件：${String(args.artifactId)}@${String(args.version || '最新版本')}` : `工作表：${Array.isArray(args.sheets) ? args.sheets.length : 0} 个\n\n`}`
          + (Array.isArray(args.sheets) ? args.sheets.slice(0, 6).map((s, i) => {
            const heads = Array.isArray(s?.header) ? s.header.map((h) => String(h)).join(' | ') : '';
            return `· [${String(s?.name || `Sheet${i + 1}`)}] 表头：${heads.slice(0, 80) || '（无）'} / ${Array.isArray(s?.rows) ? s.rows.length : 0} 行`;
          }).join('\n') : ''),
      };
    case 'pptx_create':
      return {
        level: 'L2', title: '生成 PPT 演示文稿',
        detail: `输出：${String(args.path || '')}\n主标题：${String(args.title || '（无）')}\n${args.artifactId ? `来源工件：${String(args.artifactId)}@${String(args.version || '最新版本')}（一页一章）\n\n` : `内容页：${Array.isArray(args.slides) ? args.slides.length : 0} 页\n\n`}`
          + (Array.isArray(args.slides) ? args.slides.slice(0, 6).map((s) => `· ${String(s?.title || '（无标题）').slice(0, 60)}`).join('\n') : ''),
      };
    case 'pdf_generate':
      return {
        level: 'L2', title: '生成 PDF 文档',
        detail: `输出：${String(args.path || '')}\n纸张：${String(args.pageSize || 'A4')}${args.landscape ? '（横向）' : ''}\n`
          + `HTML 正文：${String(args.html || '').length} 字符（用应用自带 Chromium 排版渲染）`,
      };
    // ── G-latex：LaTeX 编译审批卡（写明入口文件 + 输出 PDF + 所用引擎，避免用户盲批）──
    case 'latex_compile':
      return {
        level: 'L2', title: '编译 LaTeX 为 PDF',
        detail: `入口文件：${String(args.path || '')}\n输出：同目录同名 .pdf\n`
          + `编译引擎：${String(args.engine || '自动选择（中文文档优先 xelatex，否则优先 tectonic）')}`,
      };
    // ── V03：受限沙箱不可用时的单次非沙箱执行审批卡 ──
    case 'unconfined_exec':
      return {
        level: 'L1',
        title: '非沙箱执行命令（单次）',
        detail: String(args.command || '').slice(0, 500)
          + '\n\n⚠ 当前环境无法提供 OS 级沙箱隔离。批准后该命令将以应用完整权限直接执行（无文件/网络边界）。'
          + '本批准仅对这一次命令有效，不会沉淀为「始终允许」规则。',
      };
    // ── G-CUA：模型侧桌面自动化顶层调用审批卡（computer_use）──
    // 与 cua_action 同结构；文案必须讲清「这是真实操作你的桌面应用」，否则用户会当成只读预览。
    case 'computer_use': {
      const app = String(args.app_name || args.appName || '').slice(0, 120);
      const allowed = Array.isArray(args.allowed_apps) && args.allowed_apps.length
        ? args.allowed_apps.map((x) => String(x)).join(' / ').slice(0, 200)
        : app;
      const maxSteps = Math.min(15, Math.max(1, Number(args.max_steps) || 15));
      return {
        level: 'L1',
        title: '启动界面自动化（Computer Use）',
        detail: `目标应用：${app || '(未指定)'}\n操作目标：${String(args.objective || '').slice(0, 300)}\n`
          + `可操作应用：${allowed || '(默认仅目标应用)'}\n最大步数：${maxSteps}\n\n`
          + '⚠ 模型将通过辅助功能树真实操作你的桌面应用：点击按钮、输入文本、按键、滚动，'
          + '可能触发支付/删除/发送等无法回滚的真实副作用。'
          + '批准仅对本次调用有效（不落「始终允许」规则）；其中的敏感动作仍会逐步再次征求确认。',
      };
    }
    // ── P1-2：CUA 界面动作审批卡（与 computerUse 的 cuApprovalSummary 同结构；
    // CUA 当前走自有确认通道，此分支供统一通道接线后直接复用）──
    case 'cua_action': {
      const target = String(args.target || '').slice(0, 120);
      const extra = [];
      if (args.text !== undefined) extra.push(`内容：${String(args.text).slice(0, 200)}`);
      if (args.key) extra.push(`按键：${args.key}`);
      if (args.label) extra.push(`目标描述：${String(args.label).slice(0, 120)}`);
      const danger = toolLevel('cua_action', args) === 'L1';
      return {
        level: danger ? 'L1' : 'L2',
        title: `界面操作：${String(args.action || '未知动作')}`,
        detail: [`动作：${String(args.action || '')}`, target ? `目标：${target}` : '', ...extra].filter(Boolean).join('\n')
          + (danger ? '\n\n⚠ 命中敏感动作白名单（支付/删除/发送/验证码类），每次操作都会重新询问，不可被「始终允许」覆盖。' : ''),
      };
    }
    default:
      if (tool.startsWith('mcp__')) {
        return { level: 'L3', title: `MCP 工具 ${tool}`, detail: JSON.stringify(args).slice(0, 500) };
      }
      return { level: 'L2', title: tool, detail: JSON.stringify(args).slice(0, 500) };
  }
}

module.exports = {
  LEVELS, toolLevel, needsApproval, approvalTarget, matchPattern, approvalSummary, DANGEROUS_PATTERNS, READONLY_TOOLS, isDangerousCode, NON_REMEMBERABLE, isRememberable,
  // 期 3：SQL 只读判定（approval.toolLevel 与 nativeTools.toolSqlite 共用同一份实现）
  isReadonlySql,
  // P2-7：执行后告知（正交布尔偏好；纯函数 + 通知出口）
  APPROVAL_MODES, reversibilityOf, buildExecutionNotice, notifyExecuted, setNoticeSink, emitExecutionNotice,
  // F-002：把「工具分级登记面」导出，供 test/tool-registration-matrix.test.mjs 做逐工具门禁
  //（此前只有 toolLevel() 可调用，门禁无法区分「显式登记」与「落 || 'L2' 兜底」，漏登记只能靠人眼）。
  TOOL_LEVEL, REVERSIBILITY, SPECIAL_CASED_TOOLS,
};
