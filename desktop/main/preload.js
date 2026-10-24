const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mjcode', {
  // App / Features
  getFlags: () => ipcRenderer.invoke('app:flags'),
  getUserDataPath: () => ipcRenderer.invoke('app:userDataPath'),
  // C2：上次渲染进程崩溃的通知（取完即清；正常情况下是空数组）
  getCrashNotice: () => ipcRenderer.invoke('app:crash-notice'),
  // T6：三层流式超时的生效值 / 来源 / 可调区间（写入走 localSetPreference）
  getStreamTimeouts: () => ipcRenderer.invoke('app:stream-timeouts'),
  // X4：本地库状态（失败时状态条显式提示，不静默）
  dbStatus: () => ipcRenderer.invoke('db:status'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  openInIDE: (payload) => ipcRenderer.invoke('app:openInIDE', payload),
  // Model
  chat: (payload) => ipcRenderer.invoke('model:chat', payload),
  abortChat: () => ipcRenderer.invoke('model:abort'),
  getSecrets: (payload) => ipcRenderer.invoke('model:getSecrets', payload),
  onDelta: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('model:delta', handler);
    return () => ipcRenderer.removeListener('model:delta', handler);
  },
  // 推理模型思考流（reasoning_content，仅展示不落库）
  onReasoning: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('model:reasoning', handler);
    return () => ipcRenderer.removeListener('model:reasoning', handler);
  },
  // Tools
  shell: (payload) => ipcRenderer.invoke('tool:shell', payload),
  readFile: (payload) => ipcRenderer.invoke('tool:readFile', payload),
  writeFile: (payload) => ipcRenderer.invoke('tool:writeFile', payload),
  editFile: (payload) => ipcRenderer.invoke('tool:editFile', payload),
  applyPatch: (payload) => ipcRenderer.invoke('tool:applyPatch', payload),
  // 文件预览（md/代码/图片/PDF/音视频）与「在系统中打开」
  previewFile: (payload) => ipcRenderer.invoke('file:preview', payload),
  // T3-1：大载荷句柄分页拉取（超限工具结果落盘后按 offset/limit 取回展示）
  bigPayloadFetch: (payload) => ipcRenderer.invoke('bigPayload:fetch', payload),
  openPath: (payload) => ipcRenderer.invoke('shell:openPath', payload),
  revealPath: (payload) => ipcRenderer.invoke('shell:reveal', payload),
  openExternal: (payload) => ipcRenderer.invoke('shell:openExternal', payload),
  // Git 环境信息（设置页 Git 面板：只读探测，不修改任何配置）
  gitConfig: (payload) => ipcRenderer.invoke('tool:gitConfig', payload),
  listDir: (payload) => ipcRenderer.invoke('tool:listDir', payload),
  grep: (payload) => ipcRenderer.invoke('tool:grep', payload),
  glob: (payload) => ipcRenderer.invoke('tool:glob', payload),
  // Git
  gitStatus: (payload) => ipcRenderer.invoke('tool:gitStatus', payload),
  gitDiff: (payload) => ipcRenderer.invoke('tool:gitDiff', payload),
  gitApplyHunkCached: (payload) => ipcRenderer.invoke('tool:gitApplyHunkCached', payload),
  gitApplyHunkUnstage: (payload) => ipcRenderer.invoke('tool:gitApplyHunkUnstage', payload),
  gitLog: (payload) => ipcRenderer.invoke('tool:gitLog', payload),
  gitBranch: (payload) => ipcRenderer.invoke('tool:gitBranch', payload),
  gitCommit: (payload) => ipcRenderer.invoke('tool:gitCommit', payload),
  gitAdd: (payload) => ipcRenderer.invoke('tool:gitAdd', payload),
  gitCheckout: (payload) => ipcRenderer.invoke('tool:gitCheckout', payload),
  gitDiscardFiles: (payload) => ipcRenderer.invoke('tool:gitDiscardFiles', payload),
  // P1：「撤回本轮」的基线（run 开始前的工作区快照 SHA；工作区干净时为空串，撤回=回到 HEAD）
  runCreateBaseline: (payload) => ipcRenderer.invoke('run:createBaseline', payload),
  gitRestoreStaged: (payload) => ipcRenderer.invoke('tool:gitRestoreStaged', payload),
  gitApplyHunk: (payload) => ipcRenderer.invoke('tool:gitApplyHunk', payload),
  // P0-E：GitHub 最小闭环（gh CLI）
  githubStatus: () => ipcRenderer.invoke('github:status'),
  githubCreatePr: (payload) => ipcRenderer.invoke('github:createPr', payload),
  sandboxStatus: () => ipcRenderer.invoke('sandbox:status'),
  // P1-4：Windows OS 级沙箱接线（命令清单审计 / 一次性管理员设置 / 卸载隔离）
  sandboxWindowsPlan: () => ipcRenderer.invoke('sandbox:windows/plan'),
  sandboxWindowsSetup: (payload) => ipcRenderer.invoke('sandbox:windows/setup', payload || {}),
  sandboxWindowsTeardown: (payload) => ipcRenderer.invoke('sandbox:windows/teardown', payload || {}),
  // Git Worktree 隔离工作区
  createWorktree: (payload) => ipcRenderer.invoke('worktree:create', payload),
  listWorktrees: (payload) => ipcRenderer.invoke('worktree:list', payload),
  promoteWorktree: (payload) => ipcRenderer.invoke('worktree:promote', payload),
  syncWorktree: (payload) => ipcRenderer.invoke('worktree:sync', payload),
  removeWorktree: (payload) => ipcRenderer.invoke('worktree:remove', payload),
  // Dialog / Project
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  probeProject: (payload) => ipcRenderer.invoke('tool:probeProject', payload),
  // A12：拖拽文件路径解析（Electron ≥32 移除 File.path，须在 preload 用 webUtils）
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  // A5：语音本地转写（whisper.cpp）
  transcribeVoice: (payload) => ipcRenderer.invoke('voice:transcribe', payload),
  // A12：粘贴/无路径文件落盘
  saveUpload: (payload) => ipcRenderer.invoke('files:saveUpload', payload),
  // 本地项目工作区（~/Documents/.MJCoder）
  getWorkspaceInfo: () => ipcRenderer.invoke('project:workspaceInfo'),
  createProject: (payload) => ipcRenderer.invoke('project:create', payload),
  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  getSkill: (payload) => ipcRenderer.invoke('skills:get', payload),
  installEcosystemSkill: (payload) => ipcRenderer.invoke('skills:installEcosystem', payload),
  importSkillsFromDir: (payload) => ipcRenderer.invoke('skills:importFromDir', payload),
  // 插件市场（M6）
  marketRefresh: () => ipcRenderer.invoke('market:refresh'),
  marketSearch: (payload) => ipcRenderer.invoke('market:search', payload),
  // P0-S2 修复：字段白名单，不再原样透传整个 payload。
  // 事故背景：原实现 (payload) => invoke(..., payload) 把调用方传入的任何字段
  // 全部送进主进程，其中包括 allowUnsigned / allowUnsafeInjection 这类安全降级开关
  // —— 渲染层一旦有 XSS 即可关闭签名校验与提示注入扫描。
  // 现在只放行安装 Git 仓库所必需的三个字段，其余一律丢弃（纵深防御：主进程侧
  // market:installGit 也会再剥离一次，两层独立生效）。
  marketInstallGit: (payload) => ipcRenderer.invoke('market:installGit', {
    url: String(payload?.url || ''),
    ref: payload?.ref == null ? undefined : String(payload.ref),
  }),
  marketListInstalled: () => ipcRenderer.invoke('market:listInstalled'),
  marketInspect: (payload) => ipcRenderer.invoke('market:inspect', payload),
  marketSetEnabled: (payload) => ipcRenderer.invoke('market:setEnabled', payload),
  marketUninstall: (payload) => ipcRenderer.invoke('market:uninstall', payload),
  marketCheckPermission: (payload) => ipcRenderer.invoke('market:checkPermission', payload),
  // 协同（P4/P5）：主进程侧 Yjs 本地优先快照层
  collabOpen: (payload) => ipcRenderer.invoke('collab:open', payload),
  collabDocId: (payload) => ipcRenderer.invoke('collab:docId', payload),
  collabPersist: (payload) => ipcRenderer.invoke('collab:persist', payload),
  collabEncodePush: (payload) => ipcRenderer.invoke('collab:encodePush', payload),
  collabApplyUpdate: (payload) => ipcRenderer.invoke('collab:applyUpdate', payload),
  collabListLocal: () => ipcRenderer.invoke('collab:listLocal'),
  collabCloseAll: () => ipcRenderer.invoke('collab:closeAll'),
  // 生态资产目录（M7）：数字员工 / MCP 连接器 / Skill
  ecosystemSummary: () => ipcRenderer.invoke('ecosystem:summary'),
  ecosystemEmployees: (payload) => ipcRenderer.invoke('ecosystem:employees', payload),
  ecosystemConnectors: (payload) => ipcRenderer.invoke('ecosystem:connectors', payload),
  ecosystemSkills: () => ipcRenderer.invoke('ecosystem:skills'),
  // T4-3：数字员工运行时预设（角色模板=系统提示+工具子集+审批档）
  ecosystemEmployeeRuntime: (payload) => ipcRenderer.invoke('ecosystem:employeeRuntime', payload),
  // P1-7a：自定义数字员工写通道（主进程侧 main/ipc/ecosystem.js:419/439/461，此处补齐 contextBridge）
  // 缺这三个桥接时，渲染层员工表单点了只会提示「通道缺失」——后端实现了但功能不可用。
  ecosystemEmployeeCreate: (payload) => ipcRenderer.invoke('ecosystem:employeeCreate', payload),
  ecosystemEmployeeUpdate: (payload) => ipcRenderer.invoke('ecosystem:employeeUpdate', payload),
  ecosystemEmployeeDelete: (payload) => ipcRenderer.invoke('ecosystem:employeeDelete', payload),
  // 网络配置（web_search 提供方）：设置 → 网络配置
  webSearchGetConfig: () => ipcRenderer.invoke('websearch:getConfig'),
  webSearchSetConfig: (providers) => ipcRenderer.invoke('websearch:setConfig', { providers }),
  // Updater
  checkUpdates: () => ipcRenderer.invoke('updater:check'),
  // P0-3：应用内下载更新（available 态按钮；autoDownload=false 下唯一下载入口）
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  // P0-8c：开机自启（定时任务不错过的根因治理）
  autoLaunchGet: () => ipcRenderer.invoke('app:autoLaunchGet'),
  autoLaunchSet: (payload) => ipcRenderer.invoke('app:autoLaunchSet', payload),
  onUpdaterStatus: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
  // Local-first（离线模式）
  serverHealth: () => ipcRenderer.invoke('server:health'),
  localThreads: (payload) => ipcRenderer.invoke('local:threads/list', payload || {}),
  localCreateThread: (payload) => ipcRenderer.invoke('local:threads/create', payload),
  localSetThreadStatus: (payload) => ipcRenderer.invoke('local:threads/set-status', payload),
  localDeleteThread: (payload) => ipcRenderer.invoke('local:threads/delete', payload),
  // A1：重命名 / A3：归档恢复 / B1：归组
  localRenameThread: (payload) => ipcRenderer.invoke('local:threads/rename', payload),
  localArchivedThreads: () => ipcRenderer.invoke('local:threads/archived'),
  localRestoreThread: (payload) => ipcRenderer.invoke('local:threads/restore', payload),
  localPurgeThread: (payload) => ipcRenderer.invoke('local:threads/purge', payload),
  localSetThreadProject: (payload) => ipcRenderer.invoke('local:threads/set-project', payload),
  // P1-6：会话分支（从某条历史消息点 fork 出新会话）
  localForkThread: (payload) => ipcRenderer.invoke('local:threads/fork', payload),
  localMessages: (payload) => ipcRenderer.invoke('local:messages/list', payload),
  localAddMessage: (payload) => ipcRenderer.invoke('local:messages/add', payload),
  // /compact 落库：压缩摘要历史整体替换（P2-6 收口）
  localReplaceMessages: (payload) => ipcRenderer.invoke('local:messages/replace', payload),
  localProviders: () => ipcRenderer.invoke('local:providers/list'),
  localAddProvider: (payload) => ipcRenderer.invoke('local:providers/add', payload),
  localSetProviderModel: (payload) => ipcRenderer.invoke('local:providers/set-model', payload),
  // 多模型：模型条目增删
  localAddProviderModel: (payload) => ipcRenderer.invoke('local:providers/add-model', payload),
  localRemoveProviderModel: (payload) => ipcRenderer.invoke('local:providers/remove-model', payload),
  localDeleteProvider: (payload) => ipcRenderer.invoke('local:providers/delete', payload),
  // B2：供应商编辑与测试连接
  localUpdateProvider: (payload) => ipcRenderer.invoke('local:providers/update', payload),
  testConnection: (payload) => ipcRenderer.invoke('model:testConnection', payload),
  // 自定义模型配置文件（~/.mjcode/models.json，对标 WorkBuddy models.json）
  localModelsFileStatus: () => ipcRenderer.invoke('local:models-file/status'),
  localModelsFileOpen: () => ipcRenderer.invoke('local:models-file/open'),
  // UI 对 file 来源 provider 的写回（删除/添加模型会修改配置文件）
  localModelsFileRemoveModel: (payload) => ipcRenderer.invoke('local:models-file/remove-model', payload),
  localModelsFileRemoveProvider: (payload) => ipcRenderer.invoke('local:models-file/remove-provider', payload),
  localModelsFileAddModel: (payload) => ipcRenderer.invoke('local:models-file/add-model', payload),
  // N1：模型能力位（图像/工具/推理）写回
  localModelsFileUpdateModelCaps: (payload) => ipcRenderer.invoke('local:models-file/update-model-caps', payload),
  localUpdateProviderModelCaps: (payload) => ipcRenderer.invoke('local:providers/update-model-caps', payload),
  // B1：项目一等实体
  localProjects: () => ipcRenderer.invoke('local:projects/list'),
  localAddProject: (payload) => ipcRenderer.invoke('local:projects/add', payload),
  localRemoveProject: (payload) => ipcRenderer.invoke('local:projects/remove', payload),
  localRenameProject: (payload) => ipcRenderer.invoke('local:projects/rename', payload),
  // A7：审批规则管理
  listApprovalRules: () => ipcRenderer.invoke('approval:listRules'),
  deleteApprovalRule: (payload) => ipcRenderer.invoke('approval:deleteRule', payload),
  // A2：DiffReview 磁盘快照（放弃修改的撤销出口）
  createBackup: (payload) => ipcRenderer.invoke('backup:create', payload),
  restoreBackup: (payload) => ipcRenderer.invoke('backup:restore', payload),
  localGetPreference: (payload) => ipcRenderer.invoke('local:preferences/get', payload),
  localSetPreference: (payload) => ipcRenderer.invoke('local:preferences/set', payload),
  localAddMemory: (payload) => ipcRenderer.invoke('local:memories/add', payload),
  localListMemories: (payload) => ipcRenderer.invoke('local:memories/list', payload),
  // MCP
  mcpConnect: (payload) => ipcRenderer.invoke('mcp:connect', payload),
  mcpCallTool: (payload) => ipcRenderer.invoke('mcp:callTool', payload),
  mcpDisconnect: (payload) => ipcRenderer.invoke('mcp:disconnect', payload),
  mcpListServers: () => ipcRenderer.invoke('mcp:listServers'),
  mcpListTools: () => ipcRenderer.invoke('mcp:listTools'),
  mcpGetConfig: () => ipcRenderer.invoke('mcp:getConfig'),
  mcpSetConfig: (payload) => ipcRenderer.invoke('mcp:setConfig', payload),
  // 按名重连已保存的服务（env 由主进程从磁盘读取，不经此桥）
  mcpReconnect: (payload) => ipcRenderer.invoke('mcp:reconnect', payload),
  // T7：OAuth 浏览器授权（令牌主进程闭环，此桥只回状态）
  mcpAuthorize: (payload) => ipcRenderer.invoke('mcp:authorize', payload),
  mcpAuthStatus: (payload) => ipcRenderer.invoke('mcp:authStatus', payload),
  // 期 2：MCP 三层治理（档位 profile / 文件能力 fsMode / 沙盒网络开关）读写
  mcpGovernanceGet: () => ipcRenderer.invoke('mcp:governance/get'),
  mcpGovernanceSet: (payload) => ipcRenderer.invoke('mcp:governance/set', payload),
  // 定时任务（桌面端本地调度器）
  scheduledList: () => ipcRenderer.invoke('scheduled:list'),
  scheduledSave: (payload) => ipcRenderer.invoke('scheduled:save', payload),
  scheduledDelete: (payload) => ipcRenderer.invoke('scheduled:delete', payload),
  scheduledRun: (payload) => ipcRenderer.invoke('scheduled:run', payload),
  scheduledRuns: (payload) => ipcRenderer.invoke('scheduled:runs', payload),
  // 待确认动作的一键执行（幂等：同一 actionId 只能执行一次）
  scheduledReplayAction: (payload) => ipcRenderer.invoke('scheduled:replayAction', payload),
  // 存储被异常清空后从 .bak 一键恢复（事故兜底，见 main/scheduler.js 的 persist 守卫）
  scheduledRestoreBackup: () => ipcRenderer.invoke('scheduled:restoreBackup'),
  scheduledSetModel: (payload) => ipcRenderer.invoke('scheduled:setModel', payload),
  onScheduledChanged: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('scheduled:changed', handler);
    return () => ipcRenderer.removeListener('scheduled:changed', handler);
  },
  // Approval
  onApprovalRequest: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('tool:approval-request', handler);
    return () => ipcRenderer.removeListener('tool:approval-request', handler);
  },
  // P0-2：决策负载携带 approvalId 回传（payload: { approvalId, decision }），
  // 主进程按 id 精确分发，并发审批不再串扰
  resolveApproval: (payload) => ipcRenderer.send('tool:approval-response', payload),
  // 差集 A：Diff 行内评论 → 主进程按线程存储，返回包装好的回灌 user 消息
  diffComment: (payload) => ipcRenderer.invoke('diff:comment', payload),
  // 审批结束回执：已决策 / 超时 / 窗口销毁时主进程广播，渲染层据此撤下卡片
  // （否则卡片常驻，用户事后点击 → 主进程已无该 pending → 「无法匹配的审批响应」）
  onApprovalEnd: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('tool:approval-end', handler);
    return () => ipcRenderer.removeListener('tool:approval-end', handler);
  },
  // P0-4：主进程 Agent 运行通道——循环在主进程执行，渲染层发起/订阅/中止
  agentRun: (payload) => ipcRenderer.invoke('agent:run', payload),
  agentAbort: (runId) => ipcRenderer.invoke('agent:abort', { runId }),
  onAgentEvent: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  // P1：任务编排通道（拆解/执行/查询/取消/重试/并发配置 + 实时事件）
  tasksAutoRun: (payload) => ipcRenderer.invoke('tasks:autoRun', payload),
  tasksPlan: (payload) => ipcRenderer.invoke('tasks:plan', payload),
  tasksExecute: (groupId) => ipcRenderer.invoke('tasks:execute', { groupId }),
  tasksList: (opts) => ipcRenderer.invoke('tasks:list', opts),
  tasksGet: (groupId) => ipcRenderer.invoke('tasks:get', { groupId }),
  tasksCancel: (groupId) => ipcRenderer.invoke('tasks:cancel', { groupId }),
  tasksAbortTask: (groupId, taskId) => ipcRenderer.invoke('tasks:abortTask', { groupId, taskId }),
  tasksAbortGroup: (groupId) => ipcRenderer.invoke('tasks:abortGroup', { groupId }),
  memoryStats: () => ipcRenderer.invoke('memory:stats'),
  // N9：治理命中率只读出口（hook / 意图预热 / 技能按需加载）
  governanceStats: () => ipcRenderer.invoke('governance:stats'),
  memoryBgTasks: (opts) => ipcRenderer.invoke('memory:bgTasks', opts),
  // P0-2：记忆管理（列表 / 单条作废 / global_knowledge 转长期留存）——MemorySection 消费
  memoryList: (opts) => ipcRenderer.invoke('memory:list', opts),
  memoryInvalidate: (payload) => ipcRenderer.invoke('memory:invalidate', payload),
  memoryPromote: (payload) => ipcRenderer.invoke('memory:promote', payload),
  // 三层记忆 M3：记忆文件双通道同步（打开项目时导入外部变更 + 落盘当前视图）
  memorySyncFile: (payload) => ipcRenderer.invoke('local:memories/syncFile', payload),
  // 三层记忆 M3：按作用域清空（设置页「记忆」分区高级管理）
  memoryResetScope: (payload) => ipcRenderer.invoke('memory:resetScope', payload),
  // M5 / T5-5：团队记忆待晋升候选（只读）与一键确认晋升（团队 → 项目级）
  memoryTeamPromotionCandidates: (opts) => ipcRenderer.invoke('memory:teamPromotionCandidates', opts),
  memoryConfirmTeamPromotion: (payload) => ipcRenderer.invoke('memory:confirmTeamPromotion', payload),
  quotaSnapshot: () => ipcRenderer.invoke('quota:snapshot'),
  // P1-5：用户自定义生命周期 hooks（preToolUse / postToolUse）——HooksSection 消费
  hooksGetConfig: () => ipcRenderer.invoke('hooks:getConfig'),
  hooksSetConfig: (payload) => ipcRenderer.invoke('hooks:setConfig', payload),
  serverBase: (payload) => ipcRenderer.invoke('local:server/base', payload),
  // 网络插件发现（市场弹窗/调试用；对话内安装走 agent 工具通道）
  marketSearchNetwork: (payload) => ipcRenderer.invoke('market:searchNetwork', payload),
  // Phase 3-1：断点持久化（「继续」时取回并清除；保存由主进程在熔断时自动完成）
  checkpointGet: (threadKey) => ipcRenderer.invoke('checkpoint:get', threadKey),
  checkpointClear: (threadKey) => ipcRenderer.invoke('checkpoint:clear', threadKey),
  // Phase 3-4：token 仪表盘数据源（最近一次运行的逐轮用量快照）
  tokenState: () => ipcRenderer.invoke('agent:token/state'),
  // T2-5：渲染层未捕获异常转发主进程聚合（fire-and-forget，诊断落本机不上传）
  diagReport: (payload) => ipcRenderer.send('diag:report', payload),
  // T2-6：诊断包一键导出（zip 落 userData/diagnostics/，返回路径）
  diagExport: () => ipcRenderer.invoke('diag:export'),
  // A5：confirmReview 用于「该任务留有未确认副作用」时的显式确认（重试前置核对）
  tasksRetryTask: (groupId, taskId, confirmReview = false) => ipcRenderer.invoke('tasks:retryTask', { groupId, taskId, confirmReview }),
  tasksDeleteGroup: (groupId) => ipcRenderer.invoke('tasks:deleteGroup', { groupId }),
  tasksConfig: (payload) => ipcRenderer.invoke('tasks:config', payload),
  onTasksEvent: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('tasks:event', handler);
    return () => ipcRenderer.removeListener('tasks:event', handler);
  },
  // M5 / T5-1：MJ 军团团队层（团队编制 CRUD + 生态招募 + 自定义成员 + AI 角色草稿）
  teamsList: (payload) => ipcRenderer.invoke('teams:list', payload || {}),
  teamsGet: (teamId) => ipcRenderer.invoke('teams:get', { teamId }),
  teamsCreate: (payload) => ipcRenderer.invoke('teams:create', payload),
  teamsUpdate: (teamId, patch) => ipcRenderer.invoke('teams:update', { teamId, patch }),
  teamsArchive: (teamId, archived = true) => ipcRenderer.invoke('teams:archive', { teamId, archived }),
  teamsRecruit: (payload) => ipcRenderer.invoke('teams:recruit', payload),
  teamsDraftMember: (payload) => ipcRenderer.invoke('teams:draftMember', payload),
  // 双入口 P1-5：AI 建团草案（一次 N 个成员 · 目录优先 · 带覆盖度报告）。
  // 与 teamsDraftMember 同语义：**只出草稿不落库**，落库仍走既有 addCustomMember / recruit。
  teamsDraftTeam: (payload) => ipcRenderer.invoke('teams:draftTeam', payload || {}),
  // 2026-10-20 需求①：数字员工列表右上角「新建员工」→ 模型自动出员工草稿（不落盘，
  // 由渲染层表单预填，保存仍走 ecosystem:employeeCreate）
  teamsDraftEmployee: (payload) => ipcRenderer.invoke('teams:draftEmployee', payload || {}),
  teamsAddCustomMember: (payload) => ipcRenderer.invoke('teams:addCustomMember', payload),
  teamsUpdateMember: (teamId, memberId, patch) => ipcRenderer.invoke('teams:updateMember', { teamId, memberId, patch }),
  teamsSetMemberEnabled: (teamId, memberId, enabled) => ipcRenderer.invoke('teams:setMemberEnabled', { teamId, memberId, enabled }),
  teamsRemoveMember: (teamId, memberId) => ipcRenderer.invoke('teams:removeMember', { teamId, memberId }),
  teamsSetLead: (teamId, memberId) => ipcRenderer.invoke('teams:setLead', { teamId, memberId }),
  // M5 / T5-4：缺统筹补位 + 派活（§6 F1/F2）
  // createLead 只在缺统筹时可用（`teams:get` 返回的 leadMissing 是渲染层预检的单一判据）；
  // dispatch 是派活唯一入口，失败时返回 { ok:false, code, error }，code=LEAD_MISSING 触发「一键创建」引导。
  teamsCreateLead: (payload) => ipcRenderer.invoke('teams:createLead', payload || {}),
  teamsDispatch: (payload) => ipcRenderer.invoke('teams:dispatch', payload || {}),
  // M5 / T5-2：军团消息总线（只读历史 + 落库后事件广播）。
  // 不提供写桥：发言由主进程按护栏仲裁（G1），用户不能自由发言，故此处只有读与订阅。
  teamsListMessages: (payload) => ipcRenderer.invoke('teams:listMessages', payload || {}),
  // M5 / T5-6：对话内团队协同事件流——按会话取「团队 run + 总线消息 + 看板任务」，
  // 由渲染层投影为折叠卡片。只读；关联键是 task_groups.thread_id，不新增会话列。
  teamsListThreadRuns: (payload) => ipcRenderer.invoke('teams:listThreadRuns', payload || {}),
  onTeamsEvent: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('teams:event', handler);
    return () => ipcRenderer.removeListener('teams:event', handler);
  },
  // M5 / T5-11：重置成员会话（§13.3「对话即容器，成员会话是隔离工作台」）。
  // 语义 = 清该成员工作台：清 `agent:{memberId}` 断点 + 该成员私有记忆降权（不删记忆）。
  // 位置参数风格与其余 teams* 一致；键格式与降权语义都在主进程一处实现，渲染层不拼键。
  teamsResetMemberSession: (teamId, memberId) => ipcRenderer.invoke('teams:resetMemberSession', { teamId, memberId }),
  // M5 / T5-10：中断任务 / 成员范围中断（§9.2）。权限矩阵与留痕在主进程 teamInterrupt 单一入口，
  // 渲染层只传定位参数；失败返回 { ok:false, code, error }，界面必须提示，不得静默。
  teamsInterrupt: (payload) => ipcRenderer.invoke('teams:interrupt', payload || {}),
  // 2026-10-21 团队调试日志（排查「任务无人认领 / 假完成」的全链路事实来源）
  // 只读状态 + 开关 + 最近日志 + 导出；日志本体始终留在主进程，渲染层不持有文件句柄。
  teamsDebugSet: (payload) => ipcRenderer.invoke('teams:debugSet', payload || {}),
  teamsDebugTail: (limit) => ipcRenderer.invoke('teams:debugTail', { limit }),
  teamsDebugAppend: (entry) => ipcRenderer.invoke('teams:debugAppend', entry || {}),
  teamsDebugExport: () => ipcRenderer.invoke('teams:debugExport'),
  teamsDebugOpenDir: () => ipcRenderer.invoke('teams:debugOpenDir'),
  // ── 双入口路由判定（P1-4/P1-7）──
  // 判定结果只走 UI 事件（**不进 system 段**：system 是前缀稳定区，加内容会每轮重写前缀）。
  // entry:route   —— 路由类别 + 升级/降级提示 + 成本倍数 + 确认档
  // entry:confirm —— C1 确认卡（含已拆好的子任务清单）
  onEntryRoute: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('entry:route', handler);
    return () => ipcRenderer.removeListener('entry:route', handler);
  },
  onEntryConfirm: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('entry:confirm', handler);
    return () => ipcRenderer.removeListener('entry:confirm', handler);
  },
  // 用户对确认卡的答复：'single' = 改成单 Agent（本轮不升级且不重复追问）；'confirm' = 按团队执行
  entryChoice: (payload) => ipcRenderer.invoke('entry:choice', payload || {}),
  // 当前入口策略配置（阈值/开关全在主进程，渲染层不复制一份）
  entryPolicy: () => ipcRenderer.invoke('entry:policy'),
  // DS Bots / T6-2：项目空间（项目身份唯一事实来源）。
  // get 支持二选一定位：projectId 直取，threadId 反查（跨天回到同一会话时的入口）。
  projectsCreate: (payload) => ipcRenderer.invoke('projects:create', payload || {}),
  // T6-9：完整项目空间初始化（项目 + 工件 + 配额桶 + 会话 + 团队 + 首条系统消息）
  projectsCreateSpace: (payload) => ipcRenderer.invoke('projects:createSpace', payload || {}),
  // T6-9：模板角色只读投影（渲染层展示「模板时只读」的角色清单，避免另存一份导致漂移）
  projectsRoleTemplates: () => ipcRenderer.invoke('projects:roleTemplates'),
  projectsList: (payload) => ipcRenderer.invoke('projects:list', payload || {}),
  projectsGet: (payload) => ipcRenderer.invoke('projects:get', payload || {}),
  projectsUpdateStatus: (projectId, status) => ipcRenderer.invoke('projects:updateStatus', { projectId, status }),
  // T6-10：配额水位只读快照（运行卡徽标）。未绑定项目的会话返回 quota=null，不视为错误。
  projectsQuota: (payload) => ipcRenderer.invoke('projects:quota', payload || {}),
  // T6-10：工件只读域（侧面板）——写通道只有模型经 artifact_* 原生工具，渲染层无写入能力
  artifactsForProject: (payload) => ipcRenderer.invoke('artifacts:forProject', payload || {}),
  artifactsIndex: (payload) => ipcRenderer.invoke('artifacts:index', payload || {}),
  artifactsSection: (payload) => ipcRenderer.invoke('artifacts:section', payload || {}),
  artifactsVersions: (payload) => ipcRenderer.invoke('artifacts:versions', payload || {}),
  // Computer Use（M4-C）
  cuaStatus: () => ipcRenderer.invoke('cua:status'),
  cuaPermissionHelp: (payload) => ipcRenderer.invoke('cua:permission-help', payload),
  cuaRun: (payload) => ipcRenderer.invoke('cua:run', payload),
  cuaStop: () => ipcRenderer.invoke('cua:stop'),
  onCuaEvent: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('cua:event', handler);
    return () => ipcRenderer.removeListener('cua:event', handler);
  },
  onCuaApprovalRequest: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('cua:approval-request', handler);
    return () => ipcRenderer.removeListener('cua:approval-request', handler);
  },
  // 2026-10-16：审批响应回带 approvalId（与 tool: 通道同款）。
  // 原实现只发裸 decision，主进程无法区分是哪个并发请求的响应 ⇒ 张冠李戴。
  // approvalId 缺省时仍发裸串，由主进程走 dispatchLegacy（仅单一挂起时生效）。
  resolveCuaApproval: (decision, approvalId) => ipcRenderer.send(
    'cua:approval-response',
    approvalId ? { approvalId, decision } : decision,
  ),
  // 超时/任意方式收尾后主进程主动撤下卡片，避免卡片常驻导致「点了没反应」
  onCuaApprovalSettled: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('cua:approval-settled', handler);
    return () => ipcRenderer.removeListener('cua:approval-settled', handler);
  },
  // T4-6：操作录制与回放（录制数据仅存本机 userData/recordings/）
  cuaReplay: (payload) => ipcRenderer.invoke('cua:replay', payload),
  cuaRecordingsList: () => ipcRenderer.invoke('cua:recordings:list'),
  cuaRecordingsDelete: (payload) => ipcRenderer.invoke('cua:recordings:delete', payload),
});
