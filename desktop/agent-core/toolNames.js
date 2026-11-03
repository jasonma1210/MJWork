// 工具名映射表（模型侧工具名 → 宿主通道名 camelCase）——从 agent-core/index.js 外置。
//
// 为什么单独一个文件：引擎主文件已顶在 code 行豁免上限（BASELINE_800 快照 + eslint max-lines
// 豁免双向绑定），而这张表是**纯数据**、零依赖、改动频率低，属于最该搬出去的一块。
// 搬出去不改变任何行为：index.js 仍以同名导入并原样 re-export，宿主侧
// （engineProcess/registry.js、main/toolHooks.js）的引用点一个都不用改。
//
// 维护规则（与 engineProcess/registry.js 头顶那段一致，别只改一处）：
//   新增模型工具时，模型名 → 通道名的映射写这里，**同时**把通道名登记进 TOOL_CHANNELS，
//   否则子进程路径会报「未知工具: xxx」。

export const TOOL_HANDLER_NAMES = {
  shell: 'shell',
  read_file: 'readFile',
  write_file: 'writeFile',
  edit_file: 'editFile',
  apply_patch: 'applyPatch',
  list_dir: 'listDir',
  grep: 'grep',
  glob: 'glob',
  git_status: 'gitStatus',
  git_diff: 'gitDiff',
  git_log: 'gitLog',
  git_commit: 'gitCommit',
  git_add: 'gitAdd',
  git_branch: 'gitBranch',
  orchestrate_task: 'orchestrateTask',
  search_plugins: 'searchPlugins',
  install_plugin: 'installPlugin',
  web_search: 'webSearch',
  web_fetch: 'webFetch',
  scheduled_create: 'scheduledCreate', // 2026-10-17：漏了这一行工具就"有声明无通道"
  pr_list: 'prList',
  pr_view: 'prView',
  pr_diff: 'prDiff',
  pr_review: 'prReview',
  pr_comment: 'prComment',
  todo_write: 'todoWrite',
  browser_navigate: 'browserNavigate',
  browser_click: 'browserClick',
  browser_fill: 'browserFill',
  browser_select: 'browserSelect',
  browser_screenshot: 'browserScreenshot',
  browser_extract: 'browserExtract',
  chrome_status: 'chromeStatus',
  chrome_tabs: 'chromeTabs',
  chrome_navigate: 'chromeNavigate',
  chrome_click: 'chromeClick',
  chrome_fill: 'chromeFill',
  chrome_screenshot: 'chromeScreenshot',
  chrome_extract: 'chromeExtract',
  code_exec: 'codeExec',
  // 期 3：原生内置工具通道（主进程 createToolHandlers / 渲染层 window.mjcode 同名方法）
  clipboard: 'clipboard',
  notify: 'notify',
  http_request: 'httpRequest',
  sqlite: 'sqlite',
  sandbox_code_run: 'sandboxCodeRun',
  // G-doc：文档生成原生工具通道
  doc_create: 'docCreate',
  xlsx_create: 'xlsxCreate',
  pptx_create: 'pptxCreate',
  pdf_generate: 'pdfGenerate',
  // G-CUA：桌面自动化（opt-in，主进程 createToolHandlers 注入；同时须在 engineProcess/registry.js
  // 的 TOOL_CHANNELS 登记，否则子进程路径会报「未知工具」）
  computer_use: 'computerUse',
  // G-latex：LaTeX 编译原生工具通道
  latex_compile: 'latexCompile', device_flash: 'deviceFlash',
  // 2026-10-31：设备探测（只读）——通道实现落在 main/scheduledTools.js（交互式/定时/Worker 同源），
  // 且须同步登记到 engineProcess/registry.js 的 TOOL_CHANNELS，否则子进程路径报「未知工具」
  device_probe: 'deviceProbe',
  // M5 / T5-8：军团协同工具（成员任务才注入；通道名须同步登记到 engineProcess/registry.js，
  // 否则子进程路径会报「未知工具: team_*」）
  team_list_members: 'teamListMembers',
  team_send_message: 'teamSendMessage',
  team_board: 'teamBoard',
  team_wait: 'teamWait',
  // B-04（2026-10-21）：模型侧读消息——补上总线的「读」半边，question/handoff 才不是死语义
  team_read_messages: 'teamReadMessages',
  // DS Bots / T6-6：工件协同四工具（通道名须同步登记到 engineProcess/registry.js，
  // 否则子进程路径会报「未知工具: artifact_*」）
  artifact_index: 'artifactIndex',
  artifact_get_section: 'artifactGetSection',
  artifact_patch_section: 'artifactPatchSection',
  artifact_get_diff: 'artifactGetDiff',
};
