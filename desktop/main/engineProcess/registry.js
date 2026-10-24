// T3-7：引擎子进程 RPC 协议——两端共享的通道登记表（单一事实来源）。
// 消息形状（structured clone，均为纯数据）：
//   主→子  {t:'run', id, params}            启动一次 runAgent（params 全可序列化）
//   主→子  {t:'abort', id}                  中止（子进程侧 AbortController 级联）
//   主→子  {t:'toolRes', callId, ok, result|error}   工具通道调用回执
//   主→子  {t:'cbRes', callId, result}      请求-响应型回调回执（onSuspend）
//   子→主  {t:'ready'}                      子进程引擎加载完成
//   子→主  {t:'evt', id, cb, args}          通知型回调透出（args 为回调实参数组，onDone 多参）
//   子→主  {t:'cbReq', id, callId, cb, args} 请求-响应型回调（onSuspend 需返回值）
//   子→主  {t:'toolReq', callId, name, args} 工具通道调用请求（依赖方向反转的核心）
//   子→主  {t:'runDone', id, finalText}     引擎正常收尾
//   子→主  {t:'runError', id, message}      引擎异常终止
// 工具通道登记表 = 子进程「可经 RPC 回调主进程」的 handler 名白名单（单一事实来源）。
// ⚠️ 维护规则：agent-core 的 TOOL_HANDLER_NAMES（模型工具名 → camelCase 通道名）是 SSOT，
// 主进程 createToolHandlers 里注册的每个通道名都必须在此登记——引擎走到 default 分支时用
// resolveChannel(toolHandlers, camelName) 取通道，而子进程的 toolHandlers 只由本名单构建；
// 漏登记 → resolveChannel 返回 null → `未知工具: xxx`（G-doc 真机回归的直接根因：
// pdf_generate/pptx_create 因 pdfGenerate/pptxCreate 未登记，即便主进程 handler 已就绪也不可达）。
// 例外：todoWrite 由引擎显式 case 内置处理（纯状态、不出网不触盘），不经 RPC，故不登记。
const TOOL_CHANNELS = [
  // 核心工具循环（chat = 模型调用通道，非模型可见工具；mcpCallTool = mcp__* 统一入口）
  'chat', 'shell', 'readFile', 'writeFile', 'editFile', 'applyPatch', 'listDir', 'grep', 'glob',
  'gitStatus', 'gitDiff', 'gitLog', 'gitBranch', 'gitCommit', 'gitAdd', 'mcpCallTool',
  'orchestrateTask', 'searchPlugins', 'installPlugin', 'webSearch', 'webFetch',
  'prList', 'prView', 'prDiff', 'prReview', 'prComment',
  // 2026-10-17：模型侧创建定时任务（有声明无通道就会出现「未知工具」）
  'scheduledCreate',
  // T4-1 Browser Use 六工具
  'browserNavigate', 'browserClick', 'browserFill', 'browserSelect', 'browserScreenshot', 'browserExtract',
  // T4-2 Chrome 接管七工具
  'chromeStatus', 'chromeTabs', 'chromeNavigate', 'chromeClick', 'chromeFill', 'chromeScreenshot', 'chromeExtract',
  // T4-7 Code Mode
  'codeExec',
  // 期 3 原生内置工具
  'clipboard', 'notify', 'httpRequest', 'sqlite', 'sandboxCodeRun',
  // G-doc 文档生成原生工具
  'docCreate', 'xlsxCreate', 'pptxCreate', 'pdfGenerate',
  // G-CUA 桌面自动化（模型 opt-in 调用；漏登记 → 子进程「未知工具: computer_use」）
  'computerUse',
  // G-latex LaTeX 编译原生工具（漏登记 → 子进程「未知工具: latex_compile」）
  'latexCompile',
  // M5 / T5-8 军团协同工具（漏登记 → 子进程「未知工具: team_*」）
  // B-04（2026-10-21）补入 teamReadMessages：模型侧读消息
  'teamListMembers', 'teamSendMessage', 'teamBoard', 'teamWait', 'teamReadMessages',
  // DS Bots / T6-6 工件协同四工具（漏登记 → 子进程「未知工具: artifact_*」）
  'artifactIndex', 'artifactGetSection', 'artifactPatchSection', 'artifactGetDiff',
];
// ── 作用域登记（第八轮 A-03）────────────────────────────────────────────────
// 缺陷：三处登记（TOOL_CHANNELS / TOOL_HANDLER_NAMES / createToolHandlers）**全都有**，
//   而交互式运行时**一个都没有**——四个 team_* 键在 `scheduledTools.js` 里由
//   `...(teamTools ? {...} : {})` 条件展开，交互式调用 `scheduledToolHandlers()` 时不带 teamTools，
//   于是键根本不出现。可登记矩阵第③环节是「在 handler 源码区间里 grep 通道名」，
//   条件展开的字面量照样命中 ⇒ **判全绿**。这是「假闭环」的第三种形态：
//   不是漏登记、也不是孤儿，而是「条件注册被当成无条件注册」。
//
// 修法不是改矩阵的匹配串（那只会在下一次条件展开时再骗一次），而是把「作用域」变成
//   **机器可读事实**：哪些通道只在「成员任务」形态下存在。矩阵据此**按调用形态求值**
//   （实跑 `scheduledToolHandlers()` 的两种入参，比对键集合），而不是 grep 源码文本。
// 维护规则：新增条件展开的工具时，必须把它加进本表——否则矩阵会按「交互式也应该有」判红
//   （这是想要的失败方向：宁愿被门禁问一句，也不要再出现「登记了但调不到」）。
const MEMBER_TASK_ONLY_CHANNELS = [
  // M5 / T5-8 / B-04：军团协同五工具，只在成员任务（注入 teamTools + teamContext）时出现。
  'teamListMembers', 'teamSendMessage', 'teamBoard', 'teamWait', 'teamReadMessages',
];
// 引擎内部显式分支处理的工具（模型侧名称）：不经 RPC、无通道义务。
// A-08 收口：这是**机器可读标注**，由 tool-registration-matrix 断言
//   ① 与 agent-core 导出的 ENGINE_BUILTIN_TOOL_NAMES 完全一致（**双向**相等）；
//   ② 不与 TOOL_CHANNELS 相交（内置工具不该同时登记宿主通道）。
// T-04：清单曾只列 todo_write，漏了同为「引擎内部 switch 分支处理、无宿主通道」的
//   spawn_subagent 与 deep_research（二者在 TOOL_HANDLER_NAMES 里映射为 undefined）。
//   与 agent-core 那份必须逐字一致——它是同一事实的两处落点，不是两份独立配置。
const ENGINE_BUILTIN_TOOLS = ['todo_write', 'spawn_subagent', 'deep_research'];
// 通知型回调（fire-and-forget，单向序列化即可）
const NOTIFY_CBS = ['onStream', 'onToolCall', 'onMessage', 'onTodos', 'onSubagentEvent', 'onBudget', 'onTrace', 'onDone'];
// 请求-响应型回调（需要返回值语义：onSuspend 返回断点是否保存成功）
const REQUEST_CBS = ['onSuspend'];

module.exports = {
  TOOL_CHANNELS, MEMBER_TASK_ONLY_CHANNELS, ENGINE_BUILTIN_TOOLS, NOTIFY_CBS, REQUEST_CBS,
};
