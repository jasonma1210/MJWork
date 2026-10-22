# 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
版本号规范：`主版本.次版本.修订号`（语义化版本），配套 git tag `v主.次.修订`（如 `v1.0.0`）。
desktop / server / renderer 三个 package.json 的 version 必须保持一致，发版时同步提升。

## [0.7.0-beta] - 2026-10-22

### 修复（工具选择偏差：该用 edit_file 却拼 sed、窄任务到处翻，2026-10-22）

真机反馈：明明能 `edit_file`，模型用 `shell` 拼 `sed`；一个窄任务把一堆无关工具过一遍（大量 shell 与读写调用）。排查后确认**与工具数量无关，是描述信息不对称 + 系统提示在反向鼓励**：

- **信息不对称（主因）**：`shell` 的 description 有 417 字符（还教 argv 怎么用），而 `edit_file` 只有 8 个字「搜索并替换文件中的文本」、`write_file` 11 个字。模型自然挑信息更充分、看起来更能干的那个。现在四个文件工具的描述都写清「何时用我 / 何时别用我 / 失败怎么办」：`edit_file` 145 字符（首选、search 须逐字唯一、找不到要重新读而不是改用 sed），`write_file` 划清与 edit 的边界（改局部别用它、覆盖前必读），`read_file` 点明不要用 `shell cat`（会被截断且无分段/缓存），`apply_patch` 说明与 edit 的分工；`shell` 末尾补上反模式清单（`sed -i` / 重定向 / `tee` 一律不要用于改文件）。
- **系统提示在反向鼓励（同因）**：`BASE_PROMPT` 原原则 1「先探索代码库结构，理解项目后再动手」——这正是窄任务到处翻的直接指令；原则 3「修改文件后用 shell 命令验证」进一步强化 shell 的存在感。现在改为「先定位再读，不要先浏览全库」（并写明「一个只改一处的任务不该读十个文件」）与「改文件用 edit_file / apply_patch / write_file，**不要用 shell 修改文件内容**，shell 只用来执行命令本身」；另新增「只跑与改动直接相关的验证，不要无差别跑全量」。
- **守护测试**：`tool-availability` 追加 12 项（E 段）：四个工具的关键约束、`shell` 反模式清单、**描述长度的信息对称性**（edit_file 不得显著短于 shell 的 1/4）、以及两条被修掉的原则不得回归。做了反向变异（把描述与原则改回旧文案 → 5 条变红）。
- **连带修正两处脆弱断言**：`trim-trigger` 的夹具原按 31 条消息贴着 70% 触发线，`BASE_PROMPT` 增补（2376→2776 字符）把它顶到 ~69% 后越线，下调为 27 条留出余量；`rewrite-ledger` 的收尾断言原本绑死「预算已用尽」四个字，prompt 变长后重写预算在同一个 8K 窗口下更早耗尽、引擎改走「换新窗口续跑仍不够」分支——措辞变了但「如实告知未完成」的契约没变，故改为**断言语义而非文案**。

### 修复（P1 八项 + 工具面重构：分层激活 / run 基线 / 验收回路，2026-10-22）

接 P0 批之后的第二批。核心是一次**取舍反转**：工具面问题的第一诉求不是"省 token"，而是"让低窗口模型能用"——因为没有上下文窗口能装下 59 个工具（实测 **10,809 token**，`estimateTokens` 口径，平均每工具 183）。

- **工具可用性闸（P1-8）**：引擎默认把 `BASE_TOOLS` 全量通告，而宿主 handler 是按通道给子集的（交互 / Worker / 定时 / 团队各不相同）⇒ Worker 通道能看到 28 个调不了的工具，模型调一个报「未知工具」、白烧轮次。新增 `agent-core/toolAvailability.js`：按 `TOOL_HANDLER_NAMES` 与 handler 求交集，引擎内置实现（`todo_write`/`read_file`/`spawn_subagent`/`load_skill`/`deep_research`/`activate_tools`）豁免，MCP 工具要求 `mcpCallTool` 通道；**空集保护**（全裁光视为判定异常，回落原集合并告警）。排障开关 `MJCODE_TOOL_AVAILABILITY=0`。
- **工具三档分层 + 窗口自适应（讨论方案）**：新增 `agent-core/toolTiers.js`。分层依据不是"原生 vs 外部"，而是「感知成本 vs 执行成本」——`core`（15 个常开）/ `catalog`（目录在场、schema 按需）/ `ondemand`（完全按需）。窗口 < 32K 时只通告 core（1,634 token）并把能力目录（140 token / 12 行）写进 system prompt；窗口未知或 ≥32K **完全不动**（默认零行为变化）。
- **`activate_tools` 按需申请**：模型在真实上下文里申请能力分组，而不是靠前置调用猜意图（后者看不到真实需求）。只加不减（单调累积）是刻意的——工具表位于 messages 之前，**每轮变动会让上下文前缀缓存整段失效**，估算下"衰减式"反而贵约 4 倍；「用完自动关闭」由 run 级回收实现。system prompt 里的指引写成**行为约束**（"不要因为工具不在列表里就假设它不存在"），机制与文案缺一不可。
- **「撤回本轮」（diff 验收的地基）**：新增 `run:createBaseline`（`git stash create` 取 SHA，不改工作区、不需审批）+ `lib/runBaseline.ts`；收尾条新增「撤回本轮」，恢复源是**本轮开始前的基线**而非 HEAD —— 后者会把用户 run 之前自己的未提交改动一起丢掉。恢复走 `gitDiscardFiles` 的审批闸 + `createBackup` 的 5 秒撤销。
- **diff 面板三态与刷新（P1-9）**：加加载三态（此前「没有未提交的改动」与「还在读」共用一句文案，打开面板第一眼永远是"没有改动"）；`load` 依赖本轮产出文件变化（此前面板开着时永远显示旧内容）。
- **工具超时真取消（P1-10）**：此前 `withTimeout` 超时后只是"不再等"，底层 promise 照跑 —— 长命令/浏览器操作继续产生副作用，模型看到"超时失败"于是重试，同一写操作执行两遍。现在每次工具调用有自己的 `AbortController`，run 中止或本次超时都真正打断底层；`finally` 摘除 run 级监听（防 MaxListeners 累积）。同时 run 结束**无条件**杀本 run 子进程（此前只有用户主动 abort 才杀）。
- **无人值守通道守项目规范（P1-11）**：新增 `main/agentsMd.js`。项目规范此前**只有渲染层**读 ⇒ 同一项目里主会话的 Agent 守规矩、团队成员的 Agent 不守。口径与渲染层一致（向上 5 级、近者优先、截断 8000 字符、fail-open），已接到 Worker 与定时任务两条通道。
- **跨会话状态隔离（P1-13）**：附件 chips / 排队消息 / AgentDock 三处此前按「组件实例」而非「会话」存活 —— 切到"无会话"空白态时不清，A 项目拖入的附件会出现在 B 会话输入框；点「新建会话」会把正在跑的任务坞清空且拉不回来。
- **静默失败补出口（P1-14）**：会话删除（裸 await，失败时列表纹丝不动）、消息加载失败（呈现为空会话）、loadData 部分失败（侧栏与模型选择器安静变空）、记忆模块异常（显示"0 条记忆、开关全关"）四处补上 UI 出口。
- **P1-12 的诚实取舍**：自动压缩**不落库**。`replaceMessages` 是「全删再插」，而引擎与宿主之间没有共同的索引基准，错位即不可逆；收益只是长会话每轮省一次压缩调用。本轮只在 trace 里补 `totalBefore`/`keptCount`（诊断可见、也是将来安全落库的对账依据），手动 `/compact` 已落库。
- **守护测试**：新增 `tool-availability`（32 项：闸行为 / 引擎接线含"结果被采纳" / 窗口自适应 / 名单与源码 case 分支对账 / 分组无重叠）。**踩到并修掉一个空转断言**：B1 起初只断言"调用了闸"，把 `allTools = av.kept` 改成 no-op 时仍全绿——补成"调用并采纳结果"后才对变异变红。
- **拆薄（守行数硬档）**：`agent-core/toolAvailability.js`、`agent-core/toolTiers.js`、`main/agentsMd.js`、`renderer/src/lib/appWindowEvents.ts`、`renderer/src/lib/runBaseline.ts`；`App.jsx` 799 / `useAgentRun.ts` 800 / `workerPool.js` 800 全部回到软档内。技术设计文档五个数字同步现算（280 套件 / 230 通道 / 241 桥 / 180 模块 / raw 2230）。

### 修复（P0 运行链路七项：历史单一真源 / 中止双写 / 墙钟契约 / 压缩数据安全 / 审批归属 / 待办接线 / 运行可见性，2026-10-22）

用户视角审查（`docs/MJCode-业务逻辑与前端展现审查-用户视角-2026-10-22.md`）给出的七条 P0。前三条是「同一轮运行里两个写者 / 两个真源」的同类缺陷，后四条是「事件发了没人收」的接线断裂；共同判据都是**用户能感知**：历史错乱、停止后两条回复、长任务必崩、压缩毁历史、审批亮错会话、进度永不可见、改动无落点。

- **历史单一真源**（`main/agentRunner.js` 新增 `resolveRunHistory`，`main.js` 注入 `listMessages`）：历史此前取渲染层内存 `messagesRef`，而它只含「用户消息 + 最终总结」——中间 `assistant(tool_calls)` 与 `tool` 结果虽由主进程落库，但 `message` 事件不转发。于是同一会话「不刷新」时模型看不到自己上一轮读过什么、跑过什么；「刷新一次」历史又完整了：同一会话两种行为，且问题不可复现。现在只要宿主提供 `listMessages` 就一律从会话库装配；本轮 user 消息用 payload 版**原位替换**（保留 vision 部件，库里那条恒为纯文本）；读库异常 fail-open 回落载荷。
- **中止单一写者**（`renderer/src/lib/agent.js` + `useAgentRun` 新增 `onAborted`）：点「停止」时该文件立刻 `onDone('', null, true)`（不带 meta），`finalizeRun` 因缺 `mainPersisted` 判定「非主进程模式」→ 落一条「（已停止）」；主进程同时也把**真实**总结落库 ⇒ 同一轮两条 assistant，其中一条是假的，用户再发一句时两条都进上下文。现在中止只做两件事：通知主进程 + 立即收敛 UI；真实收尾交给主进程这个唯一写者，另加 20s 兜底（主进程失联才本地收尾）。
- **墙钟事件契约对齐**（`shared-ipc/contract.mjs` + `lib/agent.js`）：引擎墙钟触顶时发 `kind:'wallclock'`，契约枚举只有 `tokens|rounds|timeout` ⇒ 被 `safeAgentEventEnvelope` 降级成 error ⇒ 渲染层 reject 整轮。**任何超过默认 30 分钟的任务必现「IPC 契约校验失败」**，而主进程仍在收尾落库（界面报错、库里却有总结）。契约补 `wallclock`；渲染层新增 `suspended` 消费分支（此前四类挂起全部被 `default` 丢弃）。
- **压缩数据安全**（新增 `renderer/src/lib/compactSession.ts`）：`/compact` 此前拿 `selectedModel` 直接压，而 `context_window` 只在 send 的 runModel 副本里注入 ⇒ 引擎回落 4096 ⇒ 超过约 3.3k token 的会话全被判激进档、只留 15% 尾部，随后 `replaceMessages` **整体覆盖数据库**；同一函数还没有 `loading` 守卫，运行中压缩会与主进程正在追加的中间消息互相覆盖。现在窗口走统一口径 `buildRunModel`（新增于 `lib/modelConfig.js`，send 与压缩共用一份）、加运行中守卫、压缩前留撤销带（toast 一键撤回）。
- **审批归属**（新增 `main/approvalOrigin.js`，`ApprovalCard` + `App.jsx`）：审批载荷此前只有 tool/cwd，后台会话（本产品支持切走继续跑）弹出的审批与当前会话长得一模一样；`onPendingChange` 一律写 `activeThread` ⇒ 亮错会话、真正在等的会话不亮，卡结束后还把没有 run 的会话置成 `running`。现在载荷带 `threadId`/`threadTitle`，卡片显示「来自会话」并可点击跳转，状态按来源会话写；无归属的无人值守审批不写任何会话状态（宁可少一个徽标，不写错会话）。
- **待办清单接线**（`ChatArea.jsx` 传 `activeRunId`）：`TodoPanel` 首行 `if (!runId) return undefined`，而两处挂载都是裸挂载 ⇒ 订阅从未建立、组件恒返回 null ⇒ `todo_write` 那套「长任务进度可见」等于没上线（引擎在发事件、界面一个字看不到）。现在 hook 以 **state** 暴露在役 runId（ref 不触发重渲染，这是原来的坑）、按会话 key 强制重挂以清上一轮清单；欢迎页那处恒空挂载移除。
- **运行可见性**（`MessageStream.tsx`）：`ToolTraceGroup` 的 `defaultOpen` 默认 false，注释写着「运行态本轮传 true」但两处调用都没传 ⇒ 用户发起任务只看到一行「N 次调用 · 点击展开」。现在运行中的最后一轮强制展开；收尾条新增「查看 N 个改动」（`Button` 原语 + `mjcode:open-diff` 直达右栏变更面板）——此前任务说「已修改 3 个文件」而界面没有任何落点。
- **守护测试**：新增 4 个套件 —— `agent-abort-suspend`（15 项：中止不伪造 / 真实 done 仍接收 / 四类挂起全部消费 / 非法 kind 仍被拒）、`compact-safety`（14 项：窗口取值真实决定裁不裁 + 实现与接线双层）、`todo-panel-wiring`（14 项：生产端 / 消费端 / 挂载 / 裸挂载清零）、`run-visibility`（15 项：两处挂载都传 `defaultOpen` 的**点位数**断言）；`agentRunner` 追加 11 项（库历史装配 / vision 保留 / 失败回落 / 归属反查与清理）、`ipc-contract` 补 `wallclock`、`approval-queue` 追加 7 项归属三段接线。四条形态类断言做了**反向变异验证**（把实现改回旧行为后确认变红，避免「断言没读文件」的空转）。
- **拆薄（守行数硬档，未新增基线条目）**：`main/approvalOrigin.js`（main.js code 1513→1498，回到 eslint `max-lines` 1500 以内）、`lib/compactSession.ts` 与 `lib/runLifecycle.ts`（`useAgentRun` 883→795）、`hooks/useWindowEventBus.ts`（App 819→798，收敛 6 个 window 事件 `useEffect`）。技术设计文档的套件 / 模块 / 行数三个数字同步到现算值（279 / 179 / 2227）。

### 调整（R-15 派活入口分流：目标条 + 发送按钮语义切换，2026-10-22）
第九轮产品边界审查的落地修复——审查结论：单会话 / 自动编排 / MJ 军团三线在能力层已实质分离，但**入口层共用同一个发送按钮**让用户感到「太像」。本版不改引擎结构（共用 `orchestrator.planGoal → workerPool` DAG 底座是上下层关系，不拆），只修入口与呈现：
- **派活目标条**（`Composer.tsx`）：选中团队后输入区上方出现常驻目标条——团队名 + 成员数 + 预算档 + ✕ 一键取消，替代原 10rem 截断小 chip（成员一多即被截断看不见）；发送按钮军团态切换为派活语义（`IconUsers` 图标 + 专用提示），placeholder 同步切换。不新增按钮、不弹表单、不建页面（军团设计文档 v1.5「对话内协同」定稿）
- **轮末接力分流**（`useAgentRun.ts` + `ChatArea.jsx`）：`relayRef` latest-ref 模式，排队消息在轮末按「当前是否选中团队」分流到 `teamsDispatch` 或普通发送——闭 R-5「入队消息归属」
- **Worker 成员身份段**（新增 `main/workerIdentity.js`，从 `workerPool.js` 拆出以守 800 行软档）：有成员归属的 worker system prompt 追加「你是「成员名」」身份段，两条原文逐字保留；非军团路径字节不变
- **任务面板军团徽标**（`TaskSummaryPanel.tsx`）：group 行加 `IconUsers` 徽标（复用既有 `mj.teamsListThreadRuns` 桥，零新 IPC），「这是军团 run」在任务面板可辨
- **守护测试**：新增 `worker-identity`（13 项：零回归字节判据逐字锁死两条原文 + 身份段行为 + 接线 + 长度自检）与 `team-dispatch-entry`（10 项：四层分流 + i18n 双语 JSON 行为断言）；`queued-message` 接力断言升 relayRef 口径；`layout-tokens` 半档收敛（1.5→2 / 0.5→1，含存量 `PlusMenu.jsx` 一处）

### 修复（建项目后团队不开工 + 组摘要 `[object Object]` + 预算误报 100%，T6-13…T6-16，2026-10-22）
- **建项目「0 token 直接结束」（T6-13，用户真机）**：内置团队新建项目后只出现一条「项目已创建，目标已锁定」的系统消息、标注 0 tokens，`teams:listThreadRuns` 返回 `runs: 0`——团队从未开工。根因：创建链路只落 system 消息、不落 user 消息也不触发派活（团队 run 本身不产 assistant 消息）。修复：`ProjectCreateModal.onCreated` 回传 `{thread, team, project}`，宿主先落 user 消息 → 切会话 → `teamsDispatch`（失败 toast）；system 消息改渲染为居中提示条（notice），不再混入 assistant 轮次显示「MJ Coder · 0 tokens」；派活工作目录优先级改为「本次会话项目目录优先」（`payload.projectPath || team.projectPath`），避免老团队自带旧目录吞掉新项目目录
- **组摘要 `[object Object]`（T6-16，用户真机）**：`aggregator/merge.js` 的 `merged.summary` 是 `[{taskId,title,text}]` 对象数组，投影层 `String()` 后变成 `[object Object]`。修复：投影层新增 `summaryTextOf()` 统一归一（字符串 / 对象数组 / 字符串数组三种历史形态），组摘要与任务摘要都走它；`orchestrator/invoke.js` 重规划提示词同口径归一；存储结构不动，历史 run 无需迁移即修复
- **结果落页（T6-16）**：最新一次 run 无论终态与否默认展开，卡片顶部新增「最终交付」区（限高滚动）——此前终态即折叠，用户看到 5/5 完成却看不到任何结论
- **预算软上限语义（T6-16）**：超额时显示实际倍数（`4.2×`）与「Token 为软上限，任务继续执行」，不再画红色 100% + 「剩余 0」——token 越界只告警一次并继续派发（2026-10-21 裁决），硬闸只有墙钟与 `max_rounds`，1.2M/256k 属设计内超限
- **命名收敛（T6-14/T6-15）**：「军团」全站统一改名为「团队编制」（英文 `Team roster`）：+ 菜单入口（新增副标题「管理数字员工与编队」）、侧边栏一级入口、团队页标题、指路文案、设置页团队记忆开关。仅改用户可见文案，`teams:*` 通道、数据表与代码标识不动
- **守护测试**：`project-store` 新增 createSpace 自建目录 3 条；`project-switch` 断言改按轮次编号；`team-stream` 新增结构化摘要归一 2 条 + 展开策略与最终交付区断言

### 新增（DS Bots 项目空间 / 工件库 / 滑动配额协同：T6-1…T6-12，2026-10-22）
参照 DS Bot 插件的多 Bot 长期协同能力落地：把「单项目 = 单会话、多角色同会话、工件与消息解耦、跨 run 成本配额」四件事包进既有编排层——**agent-core 零改动**，压缩仍走 `compactHistory`，调度仍走 `orchestrator → workerPool`。设计稿：`docs/MJCode-DSBots项目空间与配额工件协同-设计与落地-2026-10-22.md`（17 章 + 3 附录）。
- **项目空间（T6-1/T6-2，迁移 v14）**：新增 `project_spaces` 表，项目身份用稳定 ID（`prj_...`）而非 cwd/thread——记忆归档曾因拿临时工作目录当空间键导致项目级记忆无法召回，`project_id` 是唯一关联键，cwd / thread_id / team_id / artifact_id 都只是它的属性；一项目一 thread 由数据库 UNIQUE 约束兜底，约束异常翻译成结构化错误码，不用有竞态的「先查后插」
- **工件库（T6-5/T6-6）**：`project_artifacts` / `artifact_sections` / `artifact_section_versions` 四表 + 四个原生工具 `artifact_index` / `artifact_get_section` / `artifact_patch_section` / `artifact_get_diff`。三条硬语义全部收敛在 `artifactStore.js`：① 章节正文只进库不进消息链（写回执只给 `{version, chars}`）；② 版本 = 只存变更章节的增量快照（`Vn` 由「version ≤ Vn 的最新历史行」重建，不存全文副本，超 `retain_versions` 置 archived 可恢复）；③ 并发 = `base_version` 乐观锁（CAS），版本不等一律 409 语义并附 diff，事务外不做任何写入。工具侧四道闸：单次 patch ≤16000 字符、单章节 ≤64KB、全工件 ≤2MB、单次读取 ≤8000 字符；项目上下文缺失 → `NO_PROJECT_CONTEXT`，跨项目读取 → `PROJECT_FORBIDDEN`
- **滑动配额账本（T6-3）**：新增 `quota_buckets` / `quota_consumptions`，`available = total_limit − Σ(窗口内消耗) − Σ(内存预留)`——**唯一**判定入口 `quotaLedger.beforeDispatch`。老化是查询口径不是数据操作（消耗永不删除、保留审计）；预留防超发（grant 即扣、settle 释放写实际值）；时钟回拨以库内最新扣费时间为基准保证账本单调。与既有 `groupBudget` 分工：本模块 = 跨 run / 跨天的项目额度，groupBudget = 单次派活的成本信封，派发预算取三者最小值（项目剩余 / 组剩余 / 200k）
- **暂停是状态不是失败（T6-4/T6-7）**：任务状态新增非终态 `quota_suspend`；`quotaGate.js` 只做三件接线（泵前置闸把 queued 转暂停、开跑前 `beginRun` 预留、后台 60s 老化 + 每轮 ≤2 小批量恢复），不新增任何判定规则；暂停不消耗重试次数、不改任务内容、文档/任务/消息全部保留；无项目绑定的普通编排组一律 fail-open，调度行为与之前完全一致
- **单 Bot 熔断（T6-8）**：`memberBreaker.js` 按 `projectId × memberId` 聚合 10 分钟窗口（≥30% 桶量且 ≥100k → open），half-open 单探针；**不建 breaker 表**——状态可由消耗流水推导，落表就是第二事实源；某成员熔断只锁它自己的任务，同组其他成员照常派发
- **项目创建与初始化（T6-9）**：`projectSpaceInit.js` 七步初始化（项目 → 工件 → 配额桶 → 会话 → 团队 → 首条系统消息 → 快照）+ LIFO 补偿栈，任一步失败逆序回放不留半成品；配额档位 1M/2h、3M/6h、10M/24h 与自定义；`ProjectCreateModal.tsx` 就地表单 + 内联校验，cwd 留空时自建 `~/Documents/.MJCoder/<日期戳>`，建不出来明确失败
- **侧面板与上下文装配（T6-10/T6-11）**：`ipc/artifacts.js` 四条只读通道（越权校验 + 正文按章节分页）；`ArtifactPanel.tsx` 文档/版本/待办三视图；`projectContext.js` 跨天冷启动只装配四项——固定目标 ≤800 字符 + 上次迭代摘要 ≤1500 字符 + 未完成待办 ≤40 条 + 工件索引 ≤1200 字符（≈1.2k tokens），**工件正文永不进装配**，模型需要内容时按需调 `artifact_get_section`；引擎压缩只发 `memory_saved` 事件，摘要由宿主落 `project_runs.summary_json`，读写同源
- **端到端演练（T6-12）**：`project-e2e.test.js` 用「自定义小额度 + 可注入时钟」把 3M/6h 寿命压缩到毫秒级（判定链路一字不改）：落 V0.01/V0.02 → 消耗 190k 打满 → 全部任务转 `quota_suspend`（无 failed、重试 0、任务 id 不变）→ 写摘要 → 时钟 +61s → 两批放行 → 续写 V0.03 版本连续 → 装配含四段且不含正文哨兵
- **守护测试**：新增 `artifact-store` / `artifact-tools`(36) / `project-store` / `project-context`(23) / `project-space-schema` / `project-e2e`(29) / `quota-gate` / `quota-ledger` / `task-quota-suspend` 九套；`tool-registration-matrix` 改实跑工厂取键集；`MJcoder-技术流程功能文档.md` 工具数同步（`TOOL_CHANNELS` 56→61、`TOOL_HANDLER_NAMES` 55→60、工具并集 57→62）
- **验证**：`npm test` **275 套件全绿**（总计 280 · 通过 277 · 失败 0 · 跳过 3，3 项为 Linux/macOS 沙箱平台限制）；`typecheck` 0 error；`lint` 0 error / 158 warning（阈值 159）；`doc-fact-check` / `harness-r7`（76/76）/ `legacy-ledger`（20/20）全绿

### 修复（移除 DAG 人工 fan-in 上限 + 团队派活拆解自动修复重试，2026-10-21）
- **现象（用户真机）**：目标「各位帮我设计一份基于 Java Spring Boot 的商城系统的设计文档来」派活失败——`dispatch/plan_failed {"error":"任务 t6 依赖数超过 4"}` → `teams:dispatch` 返回 `PLAN_FAILED`，`tasks:0`，一个任务都没派
- **根因 1**：`main/orchestrator/dag.js` 的 `MAX_DEPS = 4` 把「汇总任务依赖 5 个章节任务」判为非法并**整份拒绝**；该上限从未写进拆解提示词，模型无从遵守，属误杀契约
- **根因 2**：团队派活只调一次 `planGoal`，与 `autoOrchestrate` 的「校验失败带 `repairHint` 自动修复重试一次」策略不一致，一次非法拆解即整次失败
- **修复**：
  - `main/orchestrator/dag.js`：删除 `MAX_DEPS` 与「依赖数超过 N」拒绝分支；保留依赖存在性 / 自依赖 / 环三类真校验（fan-in 的自然上界由 `MAX_TASKS=8` 给出，≤7）
  - `main/ipc/teams.js`：入参提为 `planOpts` 复用；首次 `planGoal` 返回 `ok:false` 且带 `raw` 且非预设任务时，带 `repairHint` 重试一次并记 `dispatch/plan_retry`；两次都失败才落 `PLAN_FAILED`（重试结果用独立变量承接，避免 `require-atomic-updates` 告警）
  - `docs/harness-r7/04-test/check.mjs`：A14e 原地重写为「不再设人工 fan-in 上限」，文件头【契约变更台账】留痕（总数仍 76）
- **守护测试**：`dag` 17/17（新增 6 依赖汇总任务通过校验 + 拓扑落层）；`orchestrator` 10/10；`team-lead-dispatch` 39/39；`team-e2e-invariants` 14/14；`team-waves` 56/56；`lint` 0 error / 158 warning（阈值 159）；`max-lines` 3/3（`ipc/teams.js` 795 行）；`doc-fact-check` 绿；`harness-r7` PASS=76 / FAIL=0

### 修复（组预算回归主流软上限：删除「人均 token 份额」硬杀，2026-10-21）
- **现象（用户真机，4 名成员全员失败）**：看板 4 个任务全 failed，文案均为「组预算额度已用尽（本任务 58273 ≥ 授予 44000 tokens）」「25490 ≥ 20881」「28690 ≥ 26770」——每个成员都在自己的额度处被宿主掐断
- **根因**：上一版 `groupBudget.planForTask` 按「组剩余额度 ÷ 未终态任务数 × 余量系数」给每个任务切一份**人均硬份额**，`workerPool.onUsage` 每轮累加用量，一旦达到该份额即 `controller.abort()`，任务直接落 failed。组预算被误当成「人均配额」，导致成员越多、单人额度越小，最后没人能写完
- **修复（主流口径：组预算是成本信封，不是人均配额）**：
  - `main/groupBudget.js`：删除 `MIN_TASK_TOKENS` / `TASK_TOKEN_HEADROOM` / `reserved` / `usageAbort` / `tokenLimit`；`planForTask` 不再按人头切分，单任务引擎预算取**组剩余额度**（耗尽回落历史默认值 200000，避免拿 0 额度被立刻掐断）；`settle` 改为幂等结算；`max_tokens` 越界仅发一次告警并继续派发（软上限）；`max_wall_ms` 保留为**硬闸**（停派 + 未开始任务置 skipped），避免泵以 1s 超时续派把剩余任务全拖成超时失败
  - `main/workerPool.js`：删除 `budgetAbort` 与逐轮 `controller.abort()` 分支，`onUsage` 只记账（写入 `result.tokensUsed` 供看板角标）；硬闸收敛为引擎侧 `maxRounds` 与 `runWallClockMs`
  - `main/teamWorkerTrace.js`：删除随之失效的 `settleBudgetAbort`
- **守护测试**：`group-budget` 21/21（新增「无 `tokenLimit` 字段」「`tokenBudget` 取组剩余额度」「token 越界不停派不跳任务」「墙钟越界停派且只跳未开始任务」「全员 done、组 done」）；全量 267 总 / 264 通过 / 0 失败 / 3 跳过；`typecheck` 0 error；`lint` 0 error / 158 warning（阈值 159）；`max-lines` 3/3（`workerPool.js` 791 行 / `groupBudget.js` 213 行）

### 修复（新建任务默认目录 + 团队「报数」过度工程化 + 顶栏图2化，2026-10-21）
- **新建任务默认目录**（`renderer/src/components/ChatArea.jsx`）：团队派活路径此前直接用残留 `activeProject` 的 `cwd` / `project_path`，导致不选文件夹时落到旧工作区（界面「工作区 10-13」）。现与单 bot 路径对齐：新会话且未主动选目录时先 `window.mjcode.createProject({ name: '' })` 建时间戳目录，成功则同时用于 `createThread` 与 `teamsDispatch.projectPath`；创建失败直接阻断派活并给出可见错误，不回落旧目录
- **顶栏按图2 简化**（`renderer/src/App.jsx`）：移除筛选状态（`threadFilter` / `filterOpen` / `filterRef`）、点击外部关闭 effect、筛选按钮与下拉菜单、工作区名文字及 `IconCheck` / `IconFilter` 导入；顶栏只保留交通灯位、左右侧栏开关与搜索
- **对话型目标旁路**（`main/teamDispatchPlan.js`）：新增窄规则判据 `isChatOnlyGoal`（报数 / 轮流说 / 每人各说一句 / 一人一句）与反向排除词表（程序/脚本/代码/实现/开发/命令行/文件/项目/应用）；新增 `buildChatTasks({ roster })`，按名册序为每人生成「角色名：序号」任务，prompt 明确禁工具/文件/命令；`buildDispatchPlan` 增加 `chatOnly`，写入 `runMeta.chatOnly`，对话型放宽类型闸并在 `select` 模式仍保留预置指派
- **编排器预设旁路**（`main/orchestrator/index.js`）：新增 `normalizePresetTasks` 与 `presetTasks` 入参，给定清单时跳过 LLM 拆解与工具能力门，直接按预设任务建组
- **派活接线**（`main/ipc/teams.js`）：`isChatOnlyGoal(goal)` → `buildChatTasks({ roster })` → `planGoal({ presetTasks })` → `buildDispatchPlan({ chatOnly })`
- **Worker 真实收口**（`main/workerPool.js`）：读取 `runMeta.chatOnly` 后直用任务 prompt、下发 `tools: []`、`maxRounds` 压到 ≤2、切换为「只说一句话」系统提示词；同时压缩注释使文件回到 799 行（< 800 软档）
- **守护测试**：`team-dispatch-plan` 29/29（新增 ⑦ 对话型旁路块与 Worker/IPC 接线断言）；全量 267 总 / **264 通过 / 0 失败** / 3 跳过；`typecheck` 0 error；`lint` 0 error / 158 warning（阈值 159）；`doc-fact-check` 绿；`legacy-ledger` 20/20（裸 button 基线 258→256）

### 调整（团队 Token 优化：任务粒度 + 精简 Prompt + 预算可视化，2026-10-21）
- **粒度按轮次收敛**（`main/orchestrator/index.js`）：`ORCHESTRATOR_SYSTEM` 规则 2 重写——任务数由复杂度决定，**单任务必须能在 8 轮工具调用内完成**；简单查询/计数/单文件改动 2~3 个任务；超规模时按「核心实现 → 补边界与参数 → 运行验证」拆串行子任务并用 `dependsOn` 串联；明确禁止协议定义、QA 复核、终检等仪式性步骤
- **Prompt 四段 + 禁自检**（同文件）：新增规则 5（只写目标/要求/输出格式含路径与长度上限/一条验收标准，禁止重复组级公共上下文）、规则 6（禁止每写完一步 `ls` 确认或回读全文，验收只做最后一次）、规则 7（跨任务产物用工作区文件路径传递，禁止全文抄进 prompt）；原 JSON 输出规则顺延为 8
- **组级同口径**（`main/ipc/teams.js`）：`buildTeamContext` 追加「公共上下文已在本块给出，子任务 prompt 不得重复；产物用文件路径传递」，与编排器提示词对齐
- **预算可视化（数据层）**：`shared/teamStream.mjs` 新增 `budgetInfoOf(full, live)` —— 上限取 `dag.runMeta.budget`，已用取任务 `result.tokensUsed` 汇总并与内存账本 `live.tokens` 取大，输出剩余/百分比/耗时/按任务分项；新增 `normalizeBudgetView` 做类型归一与 0~100 夹紧；`assembleThreadRuns` 新增 `getBudgetLive` 注入口
- **预算可视化（主进程）**：`ipc/teams.js` 注入 `getBudgetLive: (runId) => groupBudget.snapshotOf(runId)`（复用既有内存账本，不新增持久化）
- **预算可视化（界面）**：`TeamRunStream.tsx` 新增 `BudgetMeter`、折叠态预算 chip、任务行 token 数；`TeamBoard.tsx` 头部新增预算条与任务 token chip，`ml-auto` 按 token 存在与否条件生效；两处阈值统一 70% warn / 90% danger
- **展示口径**：`shared/teamTrace.mjs` 新增 `formatTokens`（M / k / 原值，刻意不用「万」以适配中英共用）
- **i18n**：`zh-CN` / `en-US` 的 `teams.json` 各新增 `streamBudget`、`budgetLabel`、`budgetUsed`、`budgetRemaining`、`taskTokens`
- **守护测试**：`team-stream` 83/83（新增预算投影、账本取大、超额夹紧、非法上限、装配透传、`formatTokens` 档位、双语 key 与双界面静态断言）；全量 267 总 / 264 通过 / 0 失败 / 3 跳过；`typecheck` 0 error；`lint` 158 warning（阈值 159）

### 修复（macOS 27 沙箱导致 shell 全 SIGABRT + 组用 done 掩盖失败任务 + 成员参与不足，2026-10-21）
- **现象（用户实测 run `tg-mvi4pm4r-3bf9ec`）**：「再来一次每人轮流报数」两个任务，t1 定位完成、t2 反复尝试 shell 全部失败，最终 99,380 + 71,494 tokens 后失败；组仍落 `done`；团队 4 人只启动了 2 个
- **根因 1（macOS 27 沙箱不兼容）**：`(deny default)` 的 allowlist Seatbelt profile 在 macOS 27 上会让任何子进程**启动即 SIGABRT**（实测 `/usr/bin/sandbox-exec -f profile /bin/echo` 退出码 134）；旧探测用 `(allow default)` 探测，属于假阳性
- **根因 2（假 done）**：`finalizeGroup` 只在关键任务失败时落 failed；非关键的 t2 失败后组仍是 `done`
- **根因 3（成员闲置）**：DAG 只拆了 2 个任务，派活计划只用到 2 名成员，其余 2 人未参与
- **修复**：
  - `main/sandbox.js`：新增 **写限制档（deny-list）** `buildSeatbeltProfileDenyList` —— `allow default` + `deny network*` + 全盘 `deny file-write*` + 仅工作区/临时目录/`/dev/null` 可写 + `.git/.mjcode` carve-out；`seatbeltUsable()` 先探 allowlist、失败自动切 denylist（reason 写入诊断）；`buildSeatbeltProfileAuto` 供执行路径统一选择
  - `main/tools/exec.js`：改用 `buildSeatbeltProfileAuto`，macOS 27 上 shell/python 恢复可用（实测 zsh + python3 正常，工作区外写入被拒）
  - `main/teamWorkerTrace.js` + `main/workerPool.js`：组收尾由 `skippedNote` 改为 `finalizeNote` —— **任一任务 failed 或 skipped 都落 group failed**，并把失败任务写进 warnings
  - `main/ipc/teams.js`：团队上下文新增「成员参与要求」——目标含每人/全员/轮流/各自/逐个时，任务数不得少于成员数
- **守护测试**：`sandbox` 24/24（新增 denylist 四类断言）；`group-budget` 17/17（新增非关键失败→失败原因）；`workerPool` 28/28（更新为非关键失败/强制关闭/未完成收尾均落 group failed）；`team-e2e-invariants` 14/14

### 新增（上下文策略参数化 + 等待即断点：P0 / P1，2026-10-21）
- **P0 上下文策略参数化**（`agent-core`）：新增 `DEFAULT_COMPACT_POLICY` / `resolveCompactPolicy`，把此前散落的压缩阈值收口为一份可覆盖策略——触发比例（0.7）、激进比例（0.8）、尾部保留（0.25/0.15）、硬截断目标（0.45）、保留轮数（8）、工具输出裁剪阈值（2000 字符）；所有比例夹紧安全区间，非法值静默回落默认
- **P0 目标锚定**：压缩摘要模板新增【顶层目标】，并把首条用户消息原文（≤1200 字）单独送入摘要请求——此前 `toCompact` 不含固定头，摘要器其实看不到原始目标
- **P0 大工具输出优先裁剪**（策略 A）：硬截断前先把超长 tool 结果裁成「首 800 + 尾 400 字符 + 已裁剪标记」；裁完回到预算内则不再丢整轮，保留更多决策上下文
- **P0 压缩事件可审计**：`onCompacted` 新增 `droppedMessages` / `keptTailTokens`，便于宿主与调试日志还原「压了多少、留了多少」
- **P1 等待即打轻量断点**（`workerSession` + `workerPool`）：`team_wait` 导致任务中止并释放槽位时，写入 `kind='member-wait'` 断点（阶段结论 ≤4000 字 + waitingOn + 截止时刻）；唤醒重跑时经 `resumeContext` 接续，不再从零重跑；非成员任务不写，避免挤占 50 条 LRU
- **断点恢复文案**：由「上一任务因预算触顶暂停」改为「已暂停：预算触顶或等待依赖」，让等待恢复不再被误述为预算中断
- **守护测试**：`agent-core` 103/103（新增策略夹紧、默认值单一来源、策略 A 裁剪、摘要含顶层目标）；`worker-session` 19/19（等待断点 kind/等待边/阶段结论、非成员不写、唤醒可读）

### 调整（团队预算改为 256k 软上限 + 可配置 + 工具失败快速熔断，2026-10-21）
- **预算默认值**：`BUDGET_DEFAULTS.max_tokens` 200000 → **256000**（仍可在团队卡片「预算」入口调整）
- **软上限语义**：`max_tokens` 越界后不再跳过剩余任务，只发一次可读告警并继续派发；单任务仍按授予份额逐轮硬中止，避免一个任务再次吃穿整组
- **预算可配置（UI）**：团队卡片新增「预算」按钮，可编辑 `max_tokens`（1000~2000000）与 `max_rounds`（1~50），经既有 `teams:update` 落库（该桥由死转活）
- **工具失败快速熔断**：`agent-core` 新增 `TOOL_FAIL_STOP = 6` —— 同一工具连续失败 6 次（**不看参数**）即收尾；解决「换命令/换路径重试导致签名熔断永不触发」的 20 轮空转（t2 事故形态）。收尾文案区分「同参数」与「同工具」
- **依赖级联**：`taskStore.skipDependentsOf` —— 前置 failed/skipped 时把传递依赖置 skipped 并广播，避免依赖任务永久 pending、组悬挂转圈
- **守护测试**：`group-budget` 16/16（软上限继续派发、授予份额、依赖级联）；`agent-core` 99/99；`bridge-parity` 7/7（`teamsUpdate` 移出死桥白名单）；存量台账同步为 49/229

### 修复（组预算被单任务烧穿 + 组用 done 掩盖未执行任务，2026-10-21）
- **现象（用户实测 run `tg-mvhz79es-8d4adc`）**：5 个任务的「报数」目标，t1/t2 显示完成，随后提示「组预算耗尽：token 已用 268161 ≥ 上限 200000，不再派生新任务」，t3/t4/t5 全部未执行；组最终落库 `done`，用户拿到的答案是错的
- **根因 1（预算只停派生、不限在途）**：`groupBudget` 只在任务**结束后**入账、只在**派发前**判定；单个 t2 跑了 20 轮、烧掉 257688 tokens，把整组额度吃穿。引擎侧 `tokenBudget` 的救援/续窗口机制（最多 3 次救援 + 2 次自动重启）会让单任务实际用量远超授予值，宿主侧没有任何硬中止
- **根因 2（假 done）**：`finalizeGroup` 只检查「关键任务失败」，被预算 skip 的非关键任务既不进 failed 也不影响状态 ⇒ 3 个任务没跑、组仍落 `done`
- **根因 3（过度拆解）**：一个「每人报数 10 次」的简单目标被拆成 5 个任务（协议定义 / 脚本实现 / QA / 汇总 / 终检），把 200k 预算摊成每任务 40k
- **修复**：
  - `main/groupBudget.js`：新增**公平份额 + 在途预留**——派发时按「剩余额度 ÷ 未终态任务数 × 1.1 收尾余量」授予单任务份额并登记 `reserved`；`assess` 把「已结算 + 在途预留」一起纳入判定；新增 `usageAbort` 逐轮守卫
  - `main/workerPool.js`：`tokenBudget` 改用授予份额（不再硬编码 200000）；`onUsage` 逐轮累计，达份额即 `controller.abort`；预算中止走 `failed + skipRetryCount`（不重试）、保留部分产出；结算移入 `finally`（异常/中止路径同样释放预留）
  - `main/workerPool.js` + `main/teamWorkerTrace.js`：组收尾有任务 `skipped` 即落 `failed`，并把「有 N 个任务未执行：…」写进 `error` / `warnings` / 调试日志
  - `main/orchestrator/index.js`：拆解提示新增「按目标实际复杂度取最小任务数」，禁止为凑数拆出协议定义/QA/终检等仪式性步骤
- **守护测试**：`group-budget.test.js` 16/16（新增「单任务 tokenBudget 取授予份额」「超份额在途任务硬中止」「有未执行任务组落 failed」等 4 项断言）

### 新增（团队操作全链路 Debug 日志 + 一键导出，2026-10-21）
- **日志内核 `main/teamDebugLog.js`**：JSONL 按日切分（`team-debug-YYYY-MM-DD.jsonl`），单文件 20MB 轮转（`.1`）、保留 7 个文件；内存环形缓冲 2000 条供界面预览；默认开启且默认详细模式；密钥脱敏（`sk-` / `Bearer` / `ghp_` / `AKIA` 与敏感键名）；字符串 8KB / 数组 30 项 / 深度 6 层截断
- **全链路埋点**：
  - IPC 层（`main/teamIpcTrace.js`）：`teams:*` 请求 / 响应 / 异常，读接口 2s 节流
  - 拆解层（`main/orchestrator/index.js`）：DAG 调用失败、原始输出（详细模式）、非法结构、组创建（tasks / levels / waves / assignments / roster）
  - 执行层（`main/teamWorkerTrace.js`）：认领、派发、引擎启动与结果、未完成判定、终态、组收尾
  - 批次层（`main/waveEngine.js`）：探活失败、撤员、等待挂接
  - 协同工具（`main/teamTools.js`）：`team_*` 调用参数 / 耗时 / 结果
  - 渲染层（`ChatArea.jsx`）：派活点击与派活返回，与主进程同一时间线
- **IPC 与界面**：新增 `teams:debugSet/Tail/Append/Export/OpenDir` 五个通道（`main/ipc/teamDebug.js`）；团队页头部新增「调试日志」按钮，面板展示开关、详细模式、落盘路径与大小、最近 120 条预览（3s 自刷新），支持打开日志目录与导出 ZIP（`userData/diagnostics/team-debug-<ts>.zip`，导出后自动定位文件）
- **架构纪律**：为守住 800 行软档，抽出 `main/teamIpcTrace.js`（`ipc/teams.js` 826 → 763）与 `main/teamWorkerTrace.js`（`workerPool.js` 919 → 798）；`teamsDebugStatus` 无渲染层调用方，合入前直接删除，不留死桥
- **门禁与文档**：新增 `test/team-debug-log.test.mjs`（11 项）；`bridge-parity`（229 桥）/ `layout-tokens` / `max-lines` / `untracked-deps` / `legacy-ledger`（50/229）全绿；技术设计文档五项数字同步（262 套件 / 218 通道 / 229 桥 / 167 模块 / main.js raw 2049）

### 修复（军团任务「看板显示完成、实际没有产出」+ 成员技能全量注入导致上下文耗尽，2026-10-21）
- **现象（用户实测 run `tg-mvhjxx0j-d44c21`）**：看板 4 个任务全部显示「完成」，但其中 2 个任务的结果是「任务尚未完成（上下文已到模型窗口，累计 69401 / 72889 tokens）」；数据库核对显示 4 个任务**都有 owner_member_id**（并非真的无人认领）
- **根因 1（误判完成）**：引擎 `buildExhaustedNotice` 的「上下文压不动」分支只输出「任务尚未完成。」，而 `workerPool` 的未完成判定只认「已主动停止|任务未完全完成」——标记不一致 ⇒ 上下文耗尽的空产出被落库为 `done`
- **根因 2（上下文耗尽）**：军团成员挂载了 12 个技能（SKILL.md 合计约 127KB ≈ 数万 tokens），`applyRolePreset` 走 full 模式把所有正文拼进 system 并每轮重发；一个「报数」级子任务 2 轮即烧到 69k tokens
- **修复**：
  - `main/rolePresetApply.js`：装载成员技能后默认 `skillDisclosure='summary'`（system 只留 name/description，正文经引擎 `load_skill` 从已装载内容按需读取；调用方显式指定 full 时尊重显式值）
  - `agent-core/index.js`：`buildExhaustedNotice` 的 context-stuck 分支补「任务未完全完成」，三种收尾分支统一带宿主判定标记
  - `main/workerPool.js`：未完成判定同时接受「任务未完全完成」与历史文案「任务尚未完成」，避免任一侧再漏判
- **守护测试**：`member-runtime-config` 增「装载技能必须 summary / 未装载不得强加」；`exhausted-notice` 增「上下文压不动必须明示任务未完全完成」；`workerPool` 场景 8 增用户实测原文案的回归用例
- **验证**：受影响的 4 个套件全通过；`typecheck` 0 error；`lint` 159 warning / 0 error；全量 `npm test` **266 总 / 263 通过 / 0 失败 / 3 跳过**

### 变更（运行时升级：Electron 33.4.11 → 45.0.0 + electron-builder 25 → 26.15.3，2026-10-21）
- **运行时**：Electron `45.0.0`（Chromium `156.0.8078.48` / 内置 Node `24.22.0` / ABI `150`）；产物 `LSMinimumSystemVersion=13.0`，macOS 12 及更早不再支持
- **打包**：electron-builder `26.15.3`。按「先升打包器、再升运行时」分两步：先用 Electron 33 跑 `--dir` 确认打包链未坏，再升 Electron，避免两个变量同时变化无法归因
- **验收证据**：
  - `npm run typecheck` 0 error；`npm run lint` **159 warning / 0 error**（棘轮 161 内）
  - `npm test` 总计 **266** · 通过 **263** · 失败 **0** · 跳过 **3**（跳过项与升级前一致：Linux bwrap / macOS sandbox-exec 环境限制）
  - Electron 45 内置 Node 24.22.0 下复跑 `agent-engine` / `engine-process` / `localStore` / `credentialCrypto` / `memory` / `taskStore` / `checkpointStore` 关键套件，全部通过
  - `utilityProcess` 实测：Electron 45 中 `runEngine` 成功动态 import `agent-core`（ESM），返回参数校验错误而非 `ERR_REQUIRE_ESM`
  - `safeStorage` 跨版本：Electron 33 写入的 2 条 `v10` 密文在 Electron 45 打包应用中解密成功（`[local] 加密轨：safeStorage`）；首次需在 macOS 钥匙串弹窗输入登录密码授权
  - `<webview>` 在 45 下 `dom-ready` 正常；打包应用启动日志 `electron 45.0.0 · node 24.22.0`，sql.js、MCP tier 分级、调度器、任务编排均正常
  - 开发模式：旧 ABI 的 `better-sqlite3` 金丝雀探测失败后自动降级 `sql.js`，符合既有 fail-safe 设计
  - **CI 门禁**：首跑暴露 `team-store` / `memory-salvage` 在 Linux runner 上退出期 sql.js flush 卡死 180s（升级前 main 同样复现，非本次引入）；两个套件改为退出前显式 `close()`，复跑 CI `266 总 / 265 通过 / 0 失败 / 1 跳过`，两个套件耗时降至 208ms / 214ms
- **已知风险 / 待办**：
  - `safeStorage` 同步 API（`isEncryptionAvailable` / `encryptString` / `decryptString`）在 45 标记 deprecated，需后续迁移 async 变体
  - 升级后首次启动会触发钥匙串重新授权；授权弹窗阻塞主进程期间曾出现一次黑屏，重载/二次启动恢复。发布说明需提示用户输入密码并选择「始终允许」
  - macOS 12 及更早用户无法运行新版本；`electron-updater` 不支持降级，回退需发布更高版本号的 33 构建（见备份 tag `v0.6.1-beta-e33-backup`）
  - electron-builder 26 在 CI 环境会打印「Implicit publishing triggered by CI detection」提示；发布流程已显式传 `--publish always/never`，无需处理（v27 将改为硬错误）

### 变更（M5/T5-5 团队记忆模块：scope=team + per-agent 私有 + 提名制晋升，2026-10-20）
- **数据层（迁移 v11，`main/db/index.js`）**：`memories` 表新增 `team_id` / `agent_id` 两列 + `idx_memories_team` 索引；`_ensureScopeColumns` 惰性列补齐同步登记，**不新建存储**
- **归属判定（单一事实来源）**：团队共享 = `scope='team' AND team_id=X AND agent_id IS NULL`；成员私有 = `scope='team' AND team_id=X AND agent_id=Y`；可见范围 = 团队共享 ∪ 自身私有，跨团队严格隔离
- **`main/memory/index.js` 团队感知**：`SCOPES` 由三作用域扩为**四作用域** `['session','team','project','global']`；`LAYER_QUOTA` 新增 `team: 3`；`resolveScope` 增 `team` 分支（**缺 `teamId` 一律拒绝**，回落 project，避免团队记忆挂空键）；去重键随 scope 分化（team 含 `team_id` + `agent_id`）；新增 `MAX_TEAM_MEMORIES = 200` 与 `_enforceTeamCap`，纳入 `_enforceCap` 统一淘汰口径（空间闸 / 全局闸 / 团队闸共用一套实现）
- **半衰期**：`scorer.HALF_LIFE_DAYS_BY_SCOPE` 增 `team: 30`（**与 project 同档**），`halfLifeDaysFor` 与 `decayJob` 经同一函数取值，无第二套规则
- **提名制晋升（U5 定案）**：`PROMOTE_TEAM_MIN_HITS = 3`；新增 `listTeamPromotionCandidates`（命中≥3 且 `is_valid=1` 且**未被归档团队**的条目进候选；含团队专有名（团队名 / Lead 名）的条目由宿主注入 `excludeNames` 直接排除，本模块不认识军团实体）+ `promoteTeamMemoryToProject`（**一键确认后**才写 L2，团队→项目默认不自动晋升，防止团队专有约定污染跨项目上下文）
- **`main/teamStore.js`**：新增 `findTeamByRun`（由 `runId` 反查团队 + 成员身份），供运行期召回与沉淀定位
- **运行期集成（`main/agentRunner.js` / `main/workerPool.js`）**：worker 子任务 prompt 装配时按「团队共享 ∪ 自身私有」注入团队层召回；子任务结论沉淀团队记忆走宿主侧 `autoCapture` 开关，**归档团队不写入**
- **IPC / 桥（`main/ipc/localData.js`、`main/preload.js`）**：`memory:list` 支持 `scope` / `teamId` / `agentId` 过滤；新增 `memory:teamPromotionCandidates` 与 `memory:confirmTeamPromotion` 两通道 + `memoryTeamPromotionCandidates` / `memoryConfirmTeamPromotion` 两桥（写入走既有 `ipc-write-guard` 清单登记）；`resetScope` 白名单纳入 `'team'`
- **UI / i18n（`renderer/src/components/MemorySection.tsx`）**：记忆面板补 team 域筛选与「待晋升候选」区块（含「提升为项目记忆」按钮，一键确认），`teams.json` / `settings.json` 双语 key 双向一致
- **模块拆分守 800 行阈值**：`main/memory/index.js` 因本轮膨胀越过 raw 800 行门禁，按「先拆再合入」抽出 `main/memory/recall.js`（召回族）与 `main/memory/team.js`（团队记忆族）；子模块经依赖注入工厂（`createRecallMethods(deps)` / `createTeamMethods(deps)`）装配到 `MemoryManager.prototype`，**不 require 主模块**，避免循环依赖；index.js 由 953 降至 **767** raw 行
- **回归门禁口径同步（被裁决的契约变更，非漂移）**：`docs/harness-r7/04-test/check.mjs` 的 A18c `LAYER_QUOTA` 改四作用域；A17e/A17f/A17g 由**时点等位**改**只增不减的下界不变量**（≥203 / ≥221 / ≥205，理由与 A17d 同：IPC 与桥方法绝对数随里程碑递增，等位会逼后人手改常量），并在文件头「契约变更台账」留痕
- **权威数字同步**：`docs/MJCode-技术设计文档-2026-10-17.md` 套件 237→**238**、主进程通道 208→**210**、preload 桥 219→**221**、主进程 JS 模块 141→**143**、`main.js` raw 1820→**1863**；`docs/harness-r7/legacy-ledger.json` + `存量收敛台账.md` 重生成——死 bridge **48/219 → 50/221**（`teamsArchive` 因移除归档 UI、`teamsCreateLead` 因派活简化而失去调用方），裸 `<button>` **258 不变**；`test/docs-consistency.test.mjs` 的 `REFERENCE_COUNT_BASELINE` 28→**29**（文档新增 `memory-team.test.mjs` 引用）
- **守护测试**：新增 `test/memory-team.test.mjs`（**10/10**）——resolveScope 的 team 约束、`HALF_LIFE_DAYS_BY_SCOPE.team=30`、迁移 v11 两列与索引、共享/私有可见范围、去重键分化、团队容量闸 200、提名候选（阈值 + 团队专有名反例 + 归档排除）、`promoteTeamMemoryToProject`、`listScope`/`resetScope` 的 team 分支、`findTeamByRun`
- **验证**：`typecheck` 0 error、`lint` **160 warning / 0 error**（棘轮 161 内）、`npm test` **241/241 通过 0 失败**、`doc-fact-check` 一致、`harness-r7:check` **76 PASS / 0 FAIL**、`legacy-ledger` 20/20、`max-lines` 3/3、渲染层 `vite build` 成功

### 变更（M5 军团界面形态五条修正：必填 / 工作目录下拉 / 标签化招募 / 去归档 / 派活简化，2026-10-20）
- **新建团队必填 + 弹窗内联报错**：`TeamsPage.tsx` 的 `submitCreate()` 拆出两条精确校验（`name` / `description` 空白即拒），错误写入新增的 `createErr` state 并由弹窗内 `<InlineAlert type="error">` 就地渲染；`Field` 增 `required` prop 渲染必填星号。此前校验只写页面级 `error`、被 Modal 遮住 ⇒ 真机表现为「点创建没反应」
- **「工作目录（可选）」改下拉**：新增 `projects` state + `window.mjcode.localProjects()` effect（过滤无 path 项）；`<select>` 首项＝`projectGlobalOption`（留空＝全局团队），其余＝本机最近项目。顺序直接采用主进程 `localStore.listProjects()` 的 `lastOpenedAt` 倒序（渲染层不再排序，避免第二份排序实现漂移）；已删除项目被物理移除、天然不入候选
- **加成员弹窗标签化（需求③）**：`MemberModal` 增 `roster` + `maxMembers`（由 `teams:get` 下发，渲染层不硬编码上限）；招募/自定义落库后**不关窗**，成员以标签就地累积；统筹头像 `bg-danger-bg text-danger`（红）、其余成员 `bg-success-bg text-success`（绿）；「设为统筹」只出现在非统筹标签上（全局唯一由 `setLead` 保证）；成员上限 `MAX_MEMBERS_PER_TEAM` **8 → 20**（`main/teamStore.js`）；「新建员工」保存后 `loadEmployees()` + 自动 `recruit(payload.id)` ⇒ 新建员工自动成标签
- **招募失败同样改为弹窗内联错误**：`MemberModal` 移除 `onError` prop、改用本地 `err` state（同「被 Modal 遮住」根因），调用处同步删除 `onError={setError}`
- **移除归档 UI 入口（需求④）**：`TeamsPage.tsx` 删除 `setTeamArchived()`、`showArchived` 开关与卡片归档/取消归档按钮，`load()` 不再传 `includeArchived`。**后端语义全部保留**：`archived_at` 列、`teams:archive` IPC、`setTeamArchived`、`dispatchGate` 的 `TEAM_ARCHIVED` 分支与既有单测不动
- **派活面板简化（需求⑤）**：`TeamDispatchPanel.tsx` 整体重写为「选团队」单职责（props 收敛为 `onClose / activeTeamId / onSelectTeam`，列表项显示名称 + 描述 + 成员数，缺统筹项带 `bg-warn-bg text-warn` 警示；删除 本次任务目标 / 协作模式 / 预算上限 / 参与成员 四块表单与「一键创建 Lead」入口）；`PlusMenu.jsx` 改为透传 `activeTeamId` / `onSelectTeam`；`Composer.tsx` 新增**团队名徽标**（`IconUsers` + 可点 × 取消）与 `teamErr` 错误条；`ChatArea.jsx` 新增 `activeTeam` / `teamErr` / `teamBusy` state 与 `sendOrDispatch()`——**发送即自动派活**（调 `teams:dispatch`，`LEAD_MISSING` 时回写徽标警示），成功后回显「已派活，N 个任务已进入看板」
- **后端配合**：`main/ipc/teams.js` 的 `teams:list` / `teams:get` 增下发 `maxMembers: MAX_MEMBERS_PER_TEAM`；`teams:dispatch` 删除 `MISSING_MODE` / `MISSING_BUDGET` 强校验，改为缺省回落（模式回落 `team.defaultMode`、预算回落 `team.budget || {}` 经 `normalizeBudget`）
- **文件拆分守阈值**：新增 `renderer/src/components/TeamMemberModal.tsx`（`MemberModal` default 导出 + `Field` / `initial` 命名导出；私有 `CAP_KEYS` / `APPROVAL_LABEL` / `SANDBOX_LABEL`），把约 300 行从 `TeamsPage.tsx`（原 ~880 行、触发 max-lines）抽出，该页降至 527 行
- **i18n 双语**：`teams.json` 增 `projectGlobalOption` / `nameRequired` / `descRequired` / `dispatchPickHint` / `dispatched` / `needLeadFirst` / `noDescription` / `rosterTitle` / `rosterCount` / `rosterEmpty` / `rosterFull` / `membersFull` / `done`（zh-CN 与 en-US 双向一致）；`composer.json` 增 `teamTip` / `removeTeam`
- **权威数字同步**：`legacy-ledger.json` 与 `docs/harness-r7/存量收敛台账.md` 重生成——死 bridge **48/219 → 50/219**（`teams:archive`、`teams:createLead` 失去渲染层引用），裸 `<button>` **258 不变**
- **验证**：`typecheck` 0 error、`lint` **159 warning**（棘轮 161 内）、`npm test` **240/240 通过 0 失败**（`untracked-deps` 在 `git add` 新文件后转绿）、`doc-fact-check` 一致、`harness-r7:check` **76 PASS / 0 FAIL**、`legacy-ledger` 20/20、`max-lines` 3/3、`layout-tokens` 2/2、渲染层 `vite build` 成功

### 变更（M5 军团前置修正 + AI 自动创建员工，2026-10-20）
- **军团去项目强制绑定（用户反馈修正）**：`teamStore.createTeam` 删除「归属项目必填」校验（`projectPath` 降级为可选「工作目录」）；`listTeams({ includeArchived })` 去掉 `project_path` 过滤，军团**全局可见**——任意对话 `+` → 军团均能列出全部未归档团队。`ipc/teams.js` 的 `teams:create` 校验放宽为 `projectPath: { max:1024, optional:true, allowEmpty:true }`、`teams:list` 不再透传 `projectPath`；`teams:dispatch` 取 `team.projectPath || payload.projectPath` 做工作目录回落（全局团队靠当前会话项目兜底），`Composer.tsx → PlusMenu.jsx → TeamDispatchPanel.tsx` 逐级透传 `projectPath`
- **AI 自动创建员工**：`ipc/teams.js` 新增 `EMPLOYEE_DRAFT_SYSTEM` 提示词与 `teams:draftEmployee` handler（复用与编排/定时任务同源的 `chatOnce`/`resolveModel`/`extractJson`，返回 `{id,name,system_prompt,tools}`；`tools` 按 `ROLE_TOOL_ALIASES` 白名单过滤）；`preload.js` 新增 `teamsDraftEmployee` 桥；`EmployeeFormModal.tsx`（`!isEdit` 时）顶部新增「AI 自动创建」面板（描述输入 + 生成草稿按钮 + 错误提示），回填 name / id（置 `idTouched` 防被 `slugify(中文名)=''` 覆盖）/ system_prompt / tools
- **数字员工列表右上角「新建员工」**：`TeamsPage.tsx` 招募弹窗（`MemberModal` 的 `recruit` 模式）经 `titleNode` 在标题右侧渲染「新建员工」按钮，内嵌 `EmployeeFormModal`（`onSaved` 后重载员工列表）；员工列表加载抽为 `loadEmployees`（useCallback）+ 按 mode 触发的 effect
- **军团卡片交互补齐**：`TeamsPage.tsx` 移除 `project` prop 与项目过滤；`archiveTeam` 重构为统一入口 `setTeamArchived(team, archived)`，归档卡片新增「取消归档」按钮（`variant="secondary" size="xs"`）+ 成功提示；卡片副标题按 `team.projectPath` 条件渲染；新建表单不再预填项目
- **i18n 双语**：`teams.json` 删 `noProject`、改写 `subtitle`/`projectLabel`/`projectHint`，新增 `projectPlaceholder`/`newEmployee`/`unarchive`/`unarchiveTitle`/`unarchiveMessage`/`unarchiveFailed`/`unarchivedNotice`；`settings.json` 新增 `employeeAiLabel`/`employeeAiPlaceholder`/`employeeAiHint`/`employeeAiBtn`/`employeeAiBusy`/`employeeAiDescRequired`/`employeeAiFailed`
- **守护测试**：`test/team-store.test.js` 反转「缺归属项目被拒」→「项目留空可建（全局团队）」，项目过滤断言改为全局可见断言，归档段补「取消归档后重新可见」并复位归档态
- **权威数字同步**：`docs/MJCode-技术设计文档-2026-10-17.md` 通道 207→**208**、桥方法 218→**219**；`docs/harness-r7/04-test/check.mjs` 的 A17f `218`→`219`、A17g `202`→`203`；`legacy-ledger.json` 重生成 + 台账文档死桥 48/218→**48/219**
- **验证**：`typecheck` 0 error、`lint` 159 warning（棘轮 161 内）、`npm test` **240/240 通过 0 失败**、`doc-fact-check` 一致、`harness-r7:check` 76 PASS/0 FAIL、`legacy-ledger` 20/20、渲染层 `vite build` 成功

### 新增（生态中心统一入口重构 T7：通用 OAuth 2.1 引擎，2026-10-16）
- **`main/mcpAuth.js`（核心引擎，electron 无关可测）**：`McpAuthManager({storeFile, credentialCrypto, openAuthWindow, fetchImpl, log})` 实现三级回落授权——①标准发现：未认证探测 MCP 端点，401 `WWW-Authenticate resource_metadata`（缺省 `/.well-known/oauth-protected-resource`）→ `authorization_servers` → AS 元数据（RFC 8414，openid-configuration 兜底）→ DCR 动态注册（RFC 7591，`token_endpoint_auth_method=none` 公共客户端）；②目录 `oauth_preset`（authorization_endpoint/token_endpoint/client_id，公共客户端 + PKCE S256）；③两者皆不可用如实返回中文错误（永不臆造端点、永不捆绑厂商机密）。loopback 回调（RFC 8252 §7.3：127.0.0.1 随机端口 `/callback`）、state 随机校验、120s 超时、授权完成即关窗；令牌经 CredentialCrypto 加密落 `userData/mcp-oauth.json`（0600），过期自动 refresh 续期，重启免授权
- **`main/mcpClient.js` 接线**：`createHttpTransport`/`connectMcpServer` 增可选 `auth={getHeader, refresh}` 钩子——发送前注入 Bearer；401 强制续期重试一次，仍失败抛 `mcpAuthRequired` 标记错误；`mcpRpc` 重包装不丢标记；`connectMcpServer` 失败返回 `needsAuth:true`
- **`main/ipc/mcp.js`**：懒建 `McpAuthManager`（凭证加密就绪才可用）；授权窗口用独立沙箱化 `BrowserWindow`（900×700、无 preload）；http 连接自动挂 OAuth 钩子（令牌全程主进程闭环，渲染层不经手）；新 IPC `mcp:authorize`（只回状态与级别，绝不回传令牌）+ `mcp:authStatus`，authorize 结果入审计日志；`initMcpIpc` 增 `getCredentialCrypto` 依赖（`main.js` 注入）
- **`main/preload.js`**：MCP 桥区增 `mcpAuthorize`/`mcpAuthStatus` 两通道
- **`ConnectorConfigDialog.tsx` oauth×remote 分支改造**：挂载查 `mcpAuthStatus`——已授权显示「已授权」态 + 测试连接按钮；未授权「打开浏览器完成授权」按钮 → `mcpAuthorize`（透传 `oauth_preset`）→ 成功自动试连；失败如实显示主进程中文错误；authorizing 期间禁用按钮；`ConnectorEntry` 接口增 `oauth_preset` 字段
- **i18n `ecosystem.json` 双语**：删 `oauthPending`（T7 交付即死键），增 `oauthAuthorize`/`oauthAuthorizeHint`/`oauthAuthorized`/`authorizing`/`oauthFailed` 五键
- **`eslint.config.mjs`**：main 块 globals 补 `URLSearchParams`（Node 17+ 全局，此前无消费方未声明）；新增 `test/**/*.mjs`/`eval/**/*.mjs` 的 `sourceType: 'module'` 覆盖块（.mjs 按 Node 规范恒为 ESM，此前被第一块 commonjs 解析即报 error，因 test/ 不在门禁扫描范围而未暴露）；test/ 放宽块补 `no-script-url`/`no-regex-spaces` off（安全夹具字符串与源码匹配正则为刻意写法）并声明 `global` 全局；修复后 `npx eslint test/` 0 error、门禁口径 0 error/137 warning、全量 87/87
- **测试**：新增 `test/mcp-auth.test.mjs`（21 项，全真实 http mock）——发现链+DCR+PKCE 全流程、加密落盘 roundtrip（文件无明文令牌）、过期自动续期、Bearer 注入握手、401 续期重试序列、needsAuth 标记、mcpRpc 标记透传、preset 二级回落、三级如实披露（无发现/无 DCR 两分支）、免授权服务挂钩子匿名直连不回退（deepwiki 真机场景）、参数校验；假授权窗口 fetch 跟随 302 等价浏览器行为
- **验证**：lint 0 error/137 warning（基线内）、typecheck 0 error、vite build 通过、全量 87 套件 87 通过 0 失败（含 mcp-auth 21/21）；`npm run dev` 真机启动冒烟通过（主进程稳定运行无崩溃，已持久化 http/stdio 服务自动重连正常）；至此生态中心统一入口重构计划 T1-T7 全部交付

### 变更（生态中心统一入口重构 T4-T5：「+」菜单启用模型，2026-10-16）
- **T4 员工 tab 去下载化回归**：招募链路（`ecosystemEmployeeRuntime` → `mjcode:recruit-expert` → App 开新会话注入角色）不依赖任何下载登记，既有断言全绿
- **「+」菜单改启用模型（T5，`PlusMenu.jsx`）**：连接器面板只列「目录 ∩ 启用清单」（关闭项不可见不可搜），打开时按 `connectorValuesForLocal` 回填已存 values、点击即直连，就地表单提交时 `saveConnectorValueLocal` 持久化；技能面板 = 磁盘技能 ∩ 全局启用集（`enabledSkills` 经 ChatArea→Composer→PlusMenu 透传）；员工面板改目录全量（`ecosystemEmployees` IPC）；删除 `MCP_PRESETS` 内置三预设（目录已含 mcp-playwright/mcp-fetch/mcp-filesystem 且 `recommended:true` 默认启用）
- **技能单选**：`toggleSkill` 改替换式（`skillIds` 字段保留数组兼容旧存档，读时以首个为选中态，再点首个=清空）；ChatArea `mjcode:enable-skill` 监听同步改替换式写入；`useAgentRun` 消费逻辑不动
- **三面板懒加载**：新增 `useLazyList` hook（IntersectionObserver 底部哨兵，每页 15，关键词/面板切换重置），避免长目录全量渲染卡顿
- **manual 连接器引导改跳生态中心**：「前往设置」→「前往生态中心」（新 `mjcode:open-ecosystem` 事件，App 监听打开 `EcosystemModal`；设置页 MCP tab 已在 T3 删除，旧指引指向不存在的位置）
- **删除 `lib/ecosystemLocal.js`**：下载清单 API 整体下线（旧连接器清单已在 T1 迁移并入启用清单），`no-new-jsx.test.js` 豁免项同步移除；`EcosystemModal` 招募不再调用 `downloadEmployee`
- **i18n `plusMenu.json` 双语**：删 7 键（preset×3、downloaded、downloadedPending、authPending、openSettings）、增 4 键（needsConfig/needsAuth/openEcosystem/noConnectors）、改写 5 键（noExperts/noSkills/skillsFooter/manualHint/connectorsFooter，去「下载/设置页」语义）
- **验证**：lint 0 error/138 warning（基线内）、typecheck 0 error、vite build 通过、全量 86 套件 86 通过 0 失败；undef-ident TDZ 门禁对 `useLazyList` 参数名与组件后置 `const` 同名误报，参数更名 `pageKey` 消除

### 变更（生态中心统一入口重构 T1-T3 + MCP 授权二维分流，2026-10-16）
- **入口收敛（T1-T3）**：新增 `lib/ecosystemEnabled.ts` 启用清单/values/旧下载清单迁移纯函数；生态中心连接器 tab「下载」→启用开关 + `ConnectorConfigDialog` 就地配置弹窗 + `LocalMcpSection` 本机服务区（承接已连管理/手动添加/JSON 编辑）；技能 tab「下载」→启用开关（开=未物化则 `installEcosystemSkill` 物化并并入 enabledSkills，关=仅摘启用态保留磁盘文件，非破坏可逆）+ `LocalSkillsSection` 本地技能区（内置/文件技能开关自设置页迁入）；连接/断开/保存派发 `mjcode:mcp-tools-dirty` 事件，App 监听重建工具集（替代已删的设置页回调链，`mergeMcpTools` 随之删除）
- **设置页 skills/mcp 两个 tab 整体删除**：`SettingsModal.jsx` 移除 NAV 两项、McpTab 函数体、MCP_PRESETS/BUILTIN_SKILLS 常量与全部关联 state/handler（1445→996 行），生态中心成为唯一管理入口；内嵌 `EcosystemModal` 透传 `enabledSkills/onSkillsChange`
- **MCP 授权二维分流（专家修订，用户确认后落地）**：按目录 104 条实测分布，`auth_mode` 单轨制存在结构性死路（paste_key×manual 22 条无处注入、oauth×manual 12 条无 URL 无从发现、oauth×npm/docker 3 条由服务自身授权）。`ConnectorConfigDialog` 路由改为 `auth_mode × install.type` 组合分流：仅 oauth×remote（25 条）显示「T7 浏览器授权」如实状态；oauth×npm/docker/uvx 提示服务自行完成授权；oauth/paste_key×manual 只给文档指引不出现输入框；paste_key×stdio 并入变量表单。T7 通用 OAuth 2.1 引擎方案同步修订为**三级发现回落**（401 规范发现+DCR → 目录 `oauth_preset` 公共客户端 PKCE → 如实披露），令牌主进程闭环加密落盘、永不进渲染进程
- **settings.json 死键清理**：双语各删 94 键（310→216），含本轮 McpTab/技能区下线键与历史会话遗留（账户/审计/诊断/旧更新文案）；`skillXxx` 系列保留（LocalSkillsSection 仍消费）；新增 `ecosystem.dialog.oauthSelfAuth` 双语键
- **验证**：lint 0 error/138 warning（基线内）、typecheck 0 error、vite build 通过、全量 86 套件 86 通过 0 失败

### 修复（测试基线与 better-sqlite3 解耦，2026-10-16）
- **测试不再依赖 better-sqlite3 / Xcode CLT**：4 个 DB 型套件（taskStore/memory/orchestrator/workerPool）此前硬依赖 `openDb()`（better-sqlite3 原生模块），在未编译好原生模块或缺 Xcode CLT 的机器上一跑即 `ERR_DLOPEN_FAILED` 崩溃。改为走 `openDbAsync(dir, { driver: 'sqljs' })`——`main/db/index.js` 的 `openDbAsync` 新增 `driver` 覆写入参（显式指定驱动，测试用 `'sqljs'` 强制零原生），业务层仅用 `prepare/get/all/run`、`transaction`、`exec`、`pragma`，sql.js 适配层全覆盖，两驱动等价
- **taskStore 测试持久化语义对齐**：sql.js 为防抖落盘（非 WAL 即时），重开读回前加 `db.flush()` 主动落盘；orchestrator 的 `store` 因被 IIFE 外 makeDeps 闭包引用改为模块级 `let` + IIFE 内 await 初始化
- **验证**：全量基线 **85 套件 85 通过 0 失败**（此前 4 失败全绿，无 CLT/rebuild 依赖）；taskStore 24/24、orchestrator 7/7、memory 7/7、workerPool 21/21；typecheck 0 error、lint 0 error/140 warning（基线内）。`npm rebuild better-sqlite3` 与 Xcode CLT 从此与测试、打包均无关

### 新增（MCP 连接器「下载即连」+ 就地引导配置，2026-10-15）
- **根因修复——下载≠配置**：此前生态中心下载连接器只写 localStorage 清单，「+」菜单永远停在「已下载 · 待配置」且无任何入口；而目录数据 `ecosystem/mcp-connectors.json` 本就携带完整启动信息（install.type/transport/env_vars/auth_type），信息从未被消费。新增 `renderer/src/lib/ecosystemConnectorLaunch.ts` 纯函数启动计划：npm→`npx -y pkg`、uvx→`uvx pkg`、docker→`docker args`、remote→`http url(+headers)`，`${VAR}` 占位符与必填 env_vars 由表单收集回填
- **「+」菜单连接器面板交互化**（`PlusMenu.jsx`）：点击行按启动计划四态分流——`ready` 直接经 `mcp:connect` 连接（成功即持久化、重启自动重连）；`needs-config` 展开就地表单（逐变量输入框 + 官方文档链接，填齐即连）；`needs-auth`（remote+oauth/api_key/token）引导粘贴 Authorization 令牌、可留空匿名直连；`manual` 给出「前往设置 → MCP 服务」跳转 + 官方文档指引。旧注释「目录数据无启动信息」系过时误判，已纠正
- **目录新增 4 个连接器**（接入方式均经官方文档核实）：飞书 `@larksuiteoapi/lark-mcp`（npm，AppID/AppSecret 占位符引导）、腾讯 ima（manual + IMA_CLIENT_ID/IMA_API_KEY 必填 env 引导，社区 server 需本机部署）、腾讯 Ardot 云端（remote https://ardot.tencent.com/mcp，oauth 引导）与 Ardot 本地（remote http://127.0.0.1:50501，需客户端打开设计稿，匿名直连）；Notion 目录原有条目（remote oauth + local npm）自动受益
- **完整 OAuth 弹窗登录（BrowserWindow + loopback 回调 + token 持久化注入 headers）为下一步架构方案**，本轮先落地「官网授权后粘贴令牌」的引导式授权

### 测试（MCP 连接器启动计划）
- 新增 `test/connector-launch.test.mjs`（18 项）：四态计划全分支 + 占位符回填 + env 注入 + 真实目录四新连接器可识别断言；发现式 runner 自动纳入基线
- 修复门禁真报：`PlusMenu.jsx` 局部 `const open` 遮蔽 props `open` 触发 TDZ 门禁——更名 `cfgOpen`（`undef-ident.test.js` 13/13）
- 全量 85 套件：81 绿 + 4 套已知 better-sqlite3 DLOPEN 环境失败；lint 0 error/140 warning、typecheck、vite build 通过

### 修复（测试门禁假绿 + 离线 CSP 噪声，2026-10-15）
- **测试门禁 `&&` 串联盲区（假绿）**：`npm test` 原为 83 套件 `&&` 手动串联，任一套件**崩溃**（如 better-sqlite3 ABI 不匹配的 ERR_DLOPEN_FAILED 顶层抛错）即中断整条链，其后套件静默不执行而 CI 照样绿——实测 orchestrator.test.js 崩溃后其后 41 套件（含全部 M3/M4 新能力）从未被跑。新增 `test/run-all.mjs` 发现式 runner：自动发现 `test/*.test.{js,mjs}` + 2 个 smoke 套件（新增套件免注册即入基线），单套件崩溃/超时（180s）只记录不阻断，全量跑完后末尾汇总「失败清单 + 崩溃/超时清单」并以非零退出码收口；`package.json` test 脚本改为 `node test/run-all.mjs`。顺带发现 `role-preset.test.mjs` 此前**从未注册**进手动链（漏注册），现被自动发现纳入（5/5 绿）。`browser-process.test.mjs` 的「测试链必须注册本套件」断言随语义改为「test 指向 run-all + 本套件位于 test/ 可被发现」
- **离线模式 CSP 噪声**：App 启动恒 `localMode(true)`，但 `api.globalProviders()` 仍裸 `fetch localhost:3001` → 被 `index.html` CSP connect-src 拦截，每次启动打印无意义报错。`renderer/src/lib/api.js` globalProviders 离线态直接静默返回 `[]`（零 fetch）；在线态照常拉取、失败 `console.warn` 后回空数组（与 providers() 同款降级，不阻断界面）。`providerStorage.test.mjs` 新增 2 项防回归断言（离线零 fetch / 在线能力未误砍）+ fetch 桩记录
- **验证**：全量基线 84 套件 80 通过（原 43 即断）；4 个失败（memory/orchestrator/taskStore/workerPool）确认同为 better-sqlite3 `NODE_MODULE_VERSION 127 vs 147` 环境问题（`npm rebuild better-sqlite3` 可修），与本次改动无关且被 runner 明确暴露不再掩盖；真机（vite + playwright）确认 CSP connect-src 报错归零（仅余无关的 frame-ancestors meta 警告）；providerStorage 11/11、build-config 13/13、browser-process 17/17、typecheck 0 error、lint 0 error/140 warning（基线内）

### 变更（生态中心「招募」重设计 + 头部裁切修复，2026-10-15）
- **数字员工卡改「详情 + 招募」**：删除「用此角色开会话」与「下载/已下载」双按钮（目录数据本就存本机，下载按钮语义多余），合并为单个实心主按钮「招募」（zh:招募 / en:Recruit）；`handleUseRole`/`handleDownloadEmployee` 删除，`handleRecruit` 取角色预设后派发 `mjcode:recruit-expert` 事件
- **招募即开新会话注入角色**：App 监听 `mjcode:recruit-expert` → 新建会话（setActiveThread(null)）+ 关闭设置/生态页 → 待 ChatArea 切会话 effect 落定后（setTimeout 宏任务，顺序不可颠倒否则被「切会话清空 extras」覆盖）派发 `mjcode:enable-expert` → 角色 chip 出现在输入框上方，首条消息建线程后 expert 随每轮 agent:run 注入并持久化到新线程
- **ChatArea extras 恢复时序修复**：新建会话（thread null→id）且该线程无 localStorage 存档时跳过恢复，保住招募注入的 expert；曾访问线程必有存档，判定精确不误伤正常切换
- **头部各行裁切修复**：embedded 容器 `max-h-[72vh]` flex-col 下，顶栏/tab 栏/搜索行/分类行缺 `shrink-0` 被压缩裁切（「横向分类被遮挡」真因），四行统一加 `shrink-0`
- **死代码清理**：`ecosystemLocal.js` 删除无消费方的 `isEmployeeDownloaded`；语言包删 `useRole`/`downloadedEmployee`，`useRoleFailed` 更名 `recruitFailed`；连接器/技能 tab 下载能力保留不动

### 变更（i18n 全量补齐 + 移除登录系统，2026-10-15）
- **生态中心（Ecosystem）布局疏朗化**：卡片内边距 p-3→p-5、网格间距 gap-3→gap-4、描述文案 `line-clamp-2` 限两行（全文进「查看详情」展开区）、标签/按钮行间距统一加大、操作按钮 `shrink-0 whitespace-nowrap` 修复「Chat as this role」竖排换行、顶栏/搜索/分类栏左右留白 px-5→px-6——仅调排布样式，组件与功能零删减
- **移除登录系统**：应用启动直进主页面，删除 LoginPage 与 token 门控；设置页「账户与更新」tab 整体移除（用户配置/退出登录/设备绑定内容页下线），`locales/*/login.json` 随消费方删除
- **版本更新入口迁移**：账户页移除后，检查更新/手动下载兜底链接/重启安装能力不丢——拆出 `renderer/src/components/UpdateSection.tsx`（新 TS 组件，符合 no-new-jsx 门禁）挂到设置页「通用」tab 末尾；`release-update.test.js` 设置页断言随实现改指新文件
- **i18n UI 文案全量补齐**（设置/审批/运行时/生态/协作等域，zh-CN+en-US 双语）：
  - 新增语言包模块：`search.json`（8 个搜索提供方 label/note/extra 字段占位）、`runtime.json`（38 键：IPC/Agent/错误可读化/压缩/工作树等运行时提示）、`approval.json` 补齐审批卡 13 键（按 git 原文恢复：危险命令/文件写入/MCP 工具标题、第 1/N 条、允许一次等按钮、键盘快捷键提示）
  - 顶层常量防「冻结翻译」：`constants/approval.js` 档位、`lib/modelConfig.js` 推理/上下文选项改渲染期函数（`getPermissionOptions`/`getReasoningOptions` 等），label map 改存 key 消费点翻译（`lib/market.js`、`TeamSpace.jsx` 看板列名、`MarketModal.jsx`）
  - 纯 Node 测试宿主兼容：`lib/agent.js`/`lib/api.js` 被 Node 测试静态导入无法引 TS i18n——`i18n/index.ts` 模块加载时置位 `globalThis.__MJ_T__`，消费方经该运行时通道取翻译（未置位回落返回 key）；`providerStorage.test.mjs` 按同款规则注入 zh-CN 翻译函数保持断言语义
  - console 诊断信息中文一律改英文（开发者面向，不进 UI 语言包）；prompt 注入文案（数字员工模板/断点恢复/继续指令匹配等）逐行 `i18n-literal` 豁免——改动会影响模型行为
- **i18n 门禁扩面**：`test/i18n.test.mjs` 扫描目标从 components+App+main 扩展到 `renderer/src` 全量（排除 i18n 基础设施目录），裸中文 113 行 → 0
- **max-lines 豁免清单收缩**：SettingsModal.jsx 移除账户页后降至 1445 行（<1500），按「只减不增」规则移出 eslint 豁免清单，`test/max-lines.test.js` 期望集合同步

### 测试（i18n 补齐验证）
- `thread-composer.test.js` 两条断言随 i18n 实现更名（改匹配渲染期函数名 + zh-CN 语言包内容双重校验）
- 全量 83 套件：79 绿 + 4 套已知 better-sqlite3 DLOPEN 环境失败；lint 0 error/140 warning、typecheck、vite build 通过；i18n 门禁 5/5


### 新增（M4 里程碑：通用桌面 Agent 能力扩展，2026-10-15）
- **T4-1 Browser Use**：`main/browserProcess/{host,childEntry,registry}.js`——Playwright 下沉独立 utilityProcess（T3-6 驻留模式，崩溃透明重启→browserDegraded 降级）；`main/browserTools.js`——navigate/click/fill/select/screenshot/extract 六工具 + 审批双闸（navigate/screenshot/extract 走 L3 可规则豁免；click/fill/select 恒逐次确认——页面点击可能触发支付/登录/发送真实副作用，规则不可静默放行）；截图落盘 `userData/browser-shots/` 经 `mjpreview://` 回轨迹卡证据图；每对话一个浏览器会话（30 分钟闲置回收）
- **T4-2 Chrome 接管**：`main/chromeRelay/server.js`（仅监听 127.0.0.1 的 WebSocket 中继）+ `chrome-extension/`（CDP 操作用户真实浏览器）+ `main/chromeTools.js` 七工具；chrome_connect 恒逐次授权卡——拒绝/超时即断开、授权不沉淀；click/fill 恒逐次（登录态页面风险高于 T4-1 沙箱浏览器）
- **T4-3 Visualize 工作流（角色模板接入运行时）**：`agent-core/index.js` rolePreset 接线——数字员工 `{systemPrompt, toolNames}` 拼进 system 提示并对 BASE_TOOLS 取白名单交集（空交集回落全量），`ecosystem/digital-employees.json` de-visualize 角色为首个样板；「角色模板=系统提示+工具子集+审批档」机制落地
- **T4-4 Deep Research 工作流**：`agent-core/index.js` deep_research 技能提示——澄清→计划→广度→深度→调和五阶段，基于 orchestrate_task 子任务树全程可见，报告落 `research/<slug>-report.md`（执行摘要/关键发现带出处/分歧与不确定性/编号引用列表）
- **T4-5 LaTeX 编译插件**：latex_compile / latex-doctor 技能模板接入运行时——Tectonic 首选（单命令、按需拉包）、系统 TeX Live（latexmk/xelatex）探测、中文文档强制 xelatex；工具链缺失时给可行动安装指引（brew install tectonic / MacTeX），禁止未见编译成功输出即宣称完成；PDF 产物进预览 tab
- **T4-6 Record-and-Replay**：`main/cuaRecorder.js`——AX 事件录制（sanitizeStep 丢弃 ref/depth、截图独立计数落盘）+ 回放三级节点匹配（role+name→path→位置就近≤40px）+ fail-closed 录制校验（版本/序号连续/参数完整）+ 敏感步骤复用 needsCUAConfirmation 逐次确认；数据仅存 `userData/recordings/`，删除级联清截图；`main.js` cua:replay/recordings:list/delete IPC；`renderer/src/components/RecordReplayPanel.tsx` 设置页面板（录制表单/回放审批档/事件时间线）
- **T4-7 Code Mode**：`main/codeProcess/{host,childEntry,registry}.js`——每对话一个持久 vm 上下文子进程（cell 语义：顶层声明跨 exec 保留；vm 超时掐停死循环但不杀进程=状态仍在；**有意不做透明重启**——状态丢失必须如实透出 codeDegraded）；`main/codeTools.js`——code_exec 工具（会话 Map + 30 分钟闲置回收 + restart 显式清状态 + saveImage 产物经 `mjpreview://` 回图片卡 + 大 stdout 走 T3-1 bigPayload 自动卸载）；`approval.js` isDangerousCode 双档——危险代码（child_process/exec/spawn/内嵌危险命令）判 L1 恒逐次不可豁免，普通代码 L3 可豁免、规则粒度=代码前缀（防短代码批准后长代码静默放行）；agent-core 三表 + main.js createToolHandlers + ToolTrace code_exec 卡全链路接线

### 变更（M4）
- browser/chrome/code 工具仅主会话注入（Worker/定时任务无审批通道语义，不允许触碰浏览器/执行代码）
- `web-todo-tools.test.js` 工具计数断言随能力演进 39→40；`package.json` test 链补注册 cua-recorder（修复 M4 期间套件未注册问题）与 code-mode 两套件

### 测试（M4）
- 新增 `browser-process.test.mjs`、`chrome-relay.test.mjs`、`role-preset.test.mjs`、`cua-recorder.test.mjs`(14)、`code-mode.test.mjs`(20)；真实 fork 子进程跑全 RPC 协议（exec 往返/cell 跨调用状态/saveImage 落盘/降级链不透明重启）+ 审批编排（fake 会话注入面）+ L1/L3 双档 + 接线静态断言
- 全量 83 套件：79 绿 + 4 套已知 better-sqlite3 DLOPEN 环境失败（memory/orchestrator/taskStore/workerPool，与改动无关）

### 修复（M4 真机验收发现的 T3-2 回归，2026-10-15）
- **i18n 真机全界面显示原始 key**：`renderer/src/i18n/index.ts` 曾用 `typeof import.meta.glob === 'function'` 做 Vite/Node 宿主判定——Vite 只在编译期替换 glob **调用点**，typeof 表达式原样留在产物中，而浏览器运行时 `import.meta.glob` 恒 undefined，真实应用误走空语言包分支（构建产物残留 4 处 typeof 判定可证）。改为「直接调用 + try/catch 兜底」（Vite 宿主替换后恒成功；非 Vite 宿主调用抛 TypeError 落 `globalThis.__MJ_I18N_PACKS__` 注入分支），PACKS 以「glob 是否拿到模块」判定宿主。单测恰因走 esbuild 注入分支而测不到此路径，属门禁盲区
- 门禁补强：`test/i18n.test.mjs` 新增第 5 项断言——剥注释后禁止 `typeof import.meta.glob` 反模式回流，并强制 glob 收集保持「调用 + try/catch」形态；修复后产物 typeof 残留 0、中文字符串确认已内联进主 chunk

### 新增（M3 里程碑：体验打磨 + 引擎驻留隔离，2026-10-15）
- **T3-1 大消息 IPC 可靠传输**：`main/bigPayload.js`——工具结果超 256KB 的顶层字段落盘 `userData/bigpayload/`，IPC 只传句柄 `{__bigStr/__bigJson, id, bytes}`，渲染层 `lib/bigPayload.ts` 按需分页拉取（128KB/页）+ ToolTrace 句柄分流虚拟滚动；句柄 TTL 30 分钟、run 结束即删、启动清残留、写失败降级原样透传（宁退旧行为不丢事件）。`main/previewScheme.js`——注册流式协议 `mjpreview://p/<token>`，≤24MB 媒体预览不再 base64 进 IPC 消息体，字节走 Chromium 网络栈；token 一次性随机、URL 不含路径、TTL 10 分钟
- **T3-7 agent-core 引擎独立子进程驻留**：`main/engineProcess/{host,childEntry,transport,registry}.js`——每个 run 一个 Electron `utilityProcess`（`--max-old-space-size=2048`），引擎经 childEntry 在子进程内跑 `runAgent`，工具调用经 RPC 回调主进程实现（依赖方向反转，零重写）；引擎崩溃/OOM 只杀子进程，主会话收到 `engineExited` 断点事件可「继续」恢复；utilityProcess 不可用时自动回退 in-process 路径（测试通道 + 生产降级链）；agentRunner 双路径接线
- **T3-6 Computer Use 高风险能力子进程化**：`main/cuaProcess/{host,childEntry,registry}.js`——cua 会话独立 utilityProcess（512MB 独立限额），osascript 调用 30s 超时视为失控即杀即重建；透明重启上限 1 次（原生调用无状态，重试安全），超限抛 `cuaDegraded` 走 error 事件降级提示，主会话不崩；修复重启竞态（旧子进程 exit 晚到误清新进程引用的身份守卫）
- **T3-2 i18n（仅 zh-CN + en-US）**：`renderer/src/i18n/index.ts` 零依赖轻量实现——`import.meta.glob` eager 收集语言包（按模块拆分 31 个 JSON×2）、`LanguageProvider` + `useI18n()` hook + `tGlobal()` 命令式通道、localStorage 持久化 + setState 热切换免重启、缺失回落 zh-CN、`{var}` 插值；30+ 组件全部文案抽取（约 1100 行裸中文进包）；设置页语言下拉；门禁 `test/i18n.test.mjs`（零裸中文扫描/zh-en key 双向一致/引用 key 存在/切换接线）+ `scripts/i18n-scan.mjs`（状态机剥注释 + `i18n-literal` 豁免）+ `scripts/i18n-modcheck.mjs`（单模块 key 与参数一致性）

### 变更（M3）
- 非 hook/顶层常量文案改存 key 渲染期求值（`MODE_OPTIONS`→`getModeOptions()`、MCP 连接态/更新态改状态码、Onboarding 测试结果显示结构改 `{ok,text}`、AgentDock 去中文字符串判断）；console 日志统一英文不进语言包
- 11 个受影响测试适配 i18n（render-smoke/message-meta/subtask-tree 改 globalThis 语言包注入 + wrapper entry 渲染模式；8 个静态断言测试两段式改「zh 包值 + key 引用」断言，契约语义不变）
- `renderer/src/env.d.ts` 补 vite/client 类型引用；`main.jsx` 挂 `LanguageProvider`（Provider>ErrorBoundary>App）

### 测试（M3）
- 新增 4 个测试文件 34 项断言：`big-payload.test.mjs`(15：卸载阈值/句柄生命周期/分页/降级透传/渲染消费链)、`engine-process.test.mjs`(8：全协议真实子进程/崩溃断点/降级回退/主进程接线)、`cua-process.test.mjs`(7：超时重建/透明重启/降级/通道登记)、`i18n.test.mjs`(4：门禁)；全部注册进 npm test 链

### 新增（M2 里程碑：工程可维护性 + 发布信任，2026-10-15）
- **T2-1 main.js 按域拆分（只搬移不改行为）**：3040 行 God File 降至 1101 行（≤1200 验收）——拆出 `ipc/{localData,ecosystem,plugins,project,mcp}.js`、`tools/exec.js`（shell/读写/预览/git 全工具层）、`lifecycle/window.js`、`updater/index.js`、`audit/auditLog.js`；模块经 `initXxx(deps)` 注入接线（沿用 orchestrator/memory 既有模式）
- **T2-2 ChatArea.jsx 组件拆分**：1809 行降至 442 行（≤600 验收）——拆出 `Composer.tsx`（输入区）、`MessageStream.tsx`（消息流域：窗口切片/智能滚底 useMessageWindow/轮次重放/本轮概览）、`WelcomePage.tsx`（欢迎页）、`hooks/useAgentRun.ts`（发送/中止/引导/排队/压缩全流程）、`lib/runRegistry.ts`、`lib/chatHelpers.ts`；欢迎页与对话页共享 composerProps 接线
- **T2-3 God File 门禁**：eslint `max-lines` error >1500（存量两个 >1500 文件进豁免清单）+ `test/max-lines.test.js` 800 行基线清单只减不增；顺带补注册 M1 遗漏的 subagent-events/subtask-tree 两套件进 test 链
- **T2-5 本地崩溃/异常聚合**：`main/diagnostics.js`——主进程 uncaughtException/unhandledRejection 结构化 JSONL（`userData/diagnostics/crash-YYYYMMDD.jsonl`，含 stack + 活跃 runId + trace 尾部）；渲染层 window error/unhandledrejection 经 preload `diagReport` 转发同一文件；Electron crashReporter 本地 dump（uploadToServer:false）；写失败绝不二次抛出
- **T2-6 诊断包一键导出**：设置 → 账户与更新 →「问题诊断」→ 导出 zip（审计/崩溃/trace/主进程日志/脱敏配置）；`zipStore.js` 零依赖 store-method ZIP；`diagExport.js` 递归剔除 api_key/keyEncrypted/env/headers/authorization——会话与消息正文不进包；测试用假密钥全包 grep 断言零泄漏
- **T2-7 更新失败可诊断文案**：`classifyUpdateError` 五类归因（断网/包校验失败/更新源缺失/安装前置失败/未知），error 事件与手动检查返回均附 kind+hint，设置页展示；校验失败绝不静默并指向手动下载官方包；《docs/签名公证更新演练Runbook.md》沉淀 macOS 公证配置片段、Windows 签名方案（Azure Trusted Signing/EV）、0.x→0.x+1 真机演练步骤与异常场景清单
- **T2-4 .bak 清理与防再入**：删除 `main.js.deprecated.bak`、`ApprovalDialog.jsx.deprecated.bak`；.gitignore 收紧 `*.bak`/`*.deprecated*`；CI verify 首步 git ls-files 检查（绕过 .gitignore 的 force-add 也会被拒）

### 变更（M2）
- 渲染层新文件按 T0-3 门禁全部 `.tsx/.ts`（存量代码原样搬移期以 @ts-nocheck 过渡，文件头注明后续补类型）；`contract.d.mts` 修复非法 `interface {} | {}` 声明（新 .ts import 链拉入 tsc 才暴露）
- 大量测试静态断言随实现重定向（degrade/release-update/settings-coverage/thread-composer/project-switch/plan-worktree-context/run-footer-restore/plugin-bypass-hardening），契约语义不变、断言随实现走

### 测试（M2）
- 新增 4 个测试文件 22 项断言：`max-lines.test.js`(3)、`diagnostics.test.mjs`(7)、`diag-export.test.mjs`(6)、`updater-errors.test.mjs`(6)；全部注册进 npm test 链

### 新增（M1 里程碑：过程可信度，2026-10-15）
- **T1-1 工具轨迹语义化渲染**：新增 `components/tools/ToolTrace.tsx`——12 类工具按型渲染卡片（edit_file/apply_patch 内联迷你 diff、shell 折叠输出+退出码徽标、read_file/list_dir/glob 路径 chip、web_search 来源链接、git_* 状态徽标、spawn_subagent 预算/结论），失败原因恒显、无需展开；废除参数 JSON.stringify 裸截断
- **T1-2 轨迹按轮次分组**：对话按「第 N 轮」分组渲染（RoundBlock），当前轮默认展开、历史轮折叠为一行摘要；同轮多工具调用经 `ToolTraceGroup` 并列，兼容窗口切片（effStart 回退）不切断 tool_calls 与结果配对
- **T1-3 子代理事件透出**：`spawn_subagent`（引擎侧 spawn/progress/done/failed + tokens/结论/耗时）与 `orchestrate_task`（编排侧逐任务状态 diff 轮询上报）统一经 IPC 契约 `subagent` 事件到渲染层；契约登记表扩至 8 类事件
- **T1-4 子任务树/DAG 可视化**：右栏新增「子任务」tab——`SubtaskTree.tsx` 按 dependsOn 分层建 DAG（上游在上、同层并行）、节点状态色（待运行/运行中/完成/失败）、tokens 角标、点击就地展开结论摘要（非模态）；spawn 事件透出 dependsOn 依赖边；事件按会话分桶存储，后台会话切回仍可见
- **T1-5 本轮概览与思考流打磨**：RunFooter 升级为 live/summary 双态「本轮概览」卡（运行中实时展示耗时/本轮 tokens 消耗/上下文用量/模型，每秒刷新）；思考流改 Markdown 渐进渲染并移除「（N 字，点击折叠）」文案；统一加载态（spinner + 文案）
- **T1-6 验收清单**：新增《MJCode-M1手工验收清单-2026-10-15.md》（六批次 18 项，均带操作/期望/代码依据）

### 变更（M1）
- 编排 diff 逻辑抽为 `invoke.js` 导出的纯函数 `diffGroupEvents`（可单测：状态机映射 + 幂等去重 + 首帧终态补发）；`waitGroupSettled` 支持 `pollIntervalMs` 注入
- `workerPool` 任务结果新增 `tokensUsed` 字段（子任务节点角标数据源），并以 onMessage 累计 usage
- 渲染层 Tailwind content 扫描补 `ts/tsx`（修复 .tsx 新文件类名不进产物的问题）；测试管线 esbuild loader 补 `.tsx`

### 测试（M1）
- 新增 2 个测试文件 25 项断言：`subagent-events.test.mjs`(19：引擎事件序列/预算 failed/轮询时序/diff 状态机)、`subtask-tree.test.mjs`(6：空态/分层/合并/单代理归并/DAG 顺序)；`ipc-contract.test.mjs` 扩至 29 项（+5 subagent 用例）；`message-meta.test.mjs` 扩至 9 项（+RunFooter live 双态）；`run-footer-restore`/`project-switch` 断言更新至 T1 新实现（契约语义不变）

### 新增（M0 里程碑：工程诚实性 + 卡死防线，2026-10-15）
- **T0-4 wall-clock 看门狗**：引擎单轮模型调用（默认 120s，含重试链）与每个工具执行（默认 120s；shell 10min、web 60s、子代理/编排按自身预算放宽）新增超时硬顶——半开连接/僵死子进程不再让「跑到一半卡住」；工具超时计入重复失败熔断，模型超时如实终止并带明确原因（`agent-core` 导出 `withTimeout`/`TOOL_TIMEOUT_OVERRIDES`，超时均可配置）
- **T0-5 本地结构化运行 trace**：引擎透出 `run_start/model/model_error/tool/run_end` 事件（含逐轮耗时与用量），主进程落 `userData/traces/<runId>.jsonl`（不上报，文件级 LRU 保留 50 次运行）；run_end 双出口闭合（正常收尾/熔断/异常终止均有尾事件）
- **T0-2 IPC/Agent 边界契约**：新增 `shared-ipc/contract.mjs`（zod，主渲染单一事实来源）——agent:run 启动载荷 fail-closed 校验（缺 messages/扁平 model 直接拒绝并给出期望形状）、agent:event 七类事件逐型校验；主进程发送前非法载荷降级为同 runId 的 error 事件（绝不静默丢弃），渲染层接收前二次校验
- **T0-3 渐进 TS 门禁**：desktop 根新增 `npm run typecheck`（renderer tsc --noEmit，当前 0 error，CI 既有门禁）；新增 `no-new-jsx` 基线测试——渲染层 37 个 .jsx + 13 个 .js 冻结，新文件强制 `.ts/.tsx`，存量只减不增

### 变更（M0）
- **T0-1 README 技术栈如实表述**：中英双语 README 明确「UI 组件层 JavaScript(JSX)、IPC/Agent 边界契约 TypeScript + zod」，移除与实际不符的表述与过期测试套数

### 测试
- 新增 4 个测试文件共 49 项断言：`agent-watchdog.test.mjs`(18)、`runTrace.test.js`(5)、`ipc-contract.test.mjs`(22)、`no-new-jsx.test.js`(4)；`agentRunner.test.js` 扩至 23 项（+契约拒绝/事件降级用例）；既有引擎回归 87/40/10/23/18 全绿不受影响

### 计划中（V1.1+）
- Ask 模式（闲聊与写操作分离，常驻工具过滤）
- `/init` 生成 AGENTS.md + 全局个人指令层（`~/.mjcode/AGENTS.md`）
- 内置 web 搜索工具（默认启用 fetch MCP 预设）
- 服务端归档 API（统一本地/在线删除语义）
- 结构化日志（JSON + trace_id）与本地用量报表
- MCP HTTP/SSE transport、自身作为 MCP server 暴露

## [1.0.0] - 2026-10-13

首个开源发布版本。本地优先 AI 编码工作台：Agent 主链路（工具循环 + 审批分级 + 沙箱隔离）、
定时任务 Agent 化、GitHub PR 最小闭环、跨平台安全兜底与完整发布基建。

### 安全与稳定性
- 模型调用重试：429/5xx/网络类错误指数退避重试（最多 3 次），瞬时故障不再摧毁整轮任务
- 沙箱 fail-safe：未显式指定策略时默认 read-only；无项目目录时强制只读并明示
- 本地审计：未登录服务端时 shell/写文件/MCP/审批放行全部落盘 `userData/audit-log.jsonl`（10MB 滚动）
- 跨平台兜底：非 macOS 无 OS 级沙箱时硬拦截危险命令（rm -rf / sudo / git push / 管道执行远程脚本等），审批不可绕过；设置页明示「非 OS 级隔离」
- 审批规则收紧：L1 危险命令不接受「始终允许」豁免；规则匹配改前缀白名单，废除正则子串（防 `pnpm test && rm -rf /` 夹带）
- 定时任务执行通道升级为完整 Agent（工具循环 + auto-safe 审批 + 沙箱 + 墙钟超时 + 并发互斥）
- 本地数据韧性：local-data.json 损坏先 .bak 恢复、按日副本保留 7 天、schemaVersion 迁移链，不再静默重置丢数据
- MCP 配置出口剥离 env，用户配置的密钥不跨 IPC 进入渲染层

### Agent 引擎
- 上下文治理：压缩切点对齐完整轮边界（修复长会话 400）、双档阈值（70% 摘要 / 85% 激进裁剪并告知模型）、真实 usage 驱动估算
- 工具结果截断带标记（「已截断，共 X 字符」），对象结果逐字段裁剪保持 JSON 完整可解析
- 轮次预算 token 化：单段轮次 + 总轮次硬顶（120）双闸；token 预算超限先自动压缩续跑；续期指令旁路注入不污染会话历史
- 大任务自动拆分 + 分步确认；finish_reason=length 断点续跑

### 产品闭环
- 待审批状态闭环：审批挂起侧栏徽标可点，直达审批卡
- 401 登出闭环：token 失效自动回退登录页；设置页提供「退出登录」
- 切会话即时清空消息，消除旧会话串显与快速切换竞态
- 隔离工作区（worktree）收口：合并回主目录 / 提升为分支 / 清理工作区
- GitHub 最小闭环：diff 审查面板一键创建 PR（依赖本机 gh CLI 登录态）
- 在线模式隐藏未实现的归档入口，统一文案

### 发布基建
- publish 配置指向真实仓库 + channel latest；三平台 artifactName 含版本
- CI：tag 触发三平台 matrix 打包，签名以 secrets 条件启用（未配置自动跳过），制品名含 commit
- 更新链路：启动延迟 10s 自动检查（保持手动下载）；检查失败附手动下载链接；支持 MJ_UPDATE_CHANNEL=beta 灰度通道
- 测试门禁 29 个套件全绿；renderer typecheck 0 错误

[未发布]: https://github.com/jasonma1210/MJCode/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jasonma1210/MJCode/releases/tag/v1.0.0
