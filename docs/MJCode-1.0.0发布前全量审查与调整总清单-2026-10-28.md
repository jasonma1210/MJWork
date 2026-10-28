# MJCode 桌面端 1.0.0 发布前全量审查与调整总清单

> 审查日期：2026-10-28　｜　审查对象：`/Users/jianma/Desktop/MJCode`（主体为 desktop 子项目 v0.7.0-beta → 1.0.0）
> 代码规模：主进程 203 文件 / 46,320 行；渲染层 155 文件 / 25,364 行；测试 316 文件
> 方法：五路并行源码审查（主进程链路 / 剩余模块补审 / 渲染层可靠性 / 视觉设计系统 / 发布工程）+ 实测基线 + 关键锚点人工复核
> 本报告中所有 `文件:行` 锚点均经 Grep/Read 二次复核确认，未复核的一律标注「待验证」

---

## 零、结论先行

**不建议现在发 1.0.0。** 卡点不在代码质量，在两件事：

| 维度 | 判定 |
|---|---|
| **代码质量与测试门禁** | 已达发版水平（312 套件 / 309 通过 / 0 失败 / 3 平台性跳过；lint 0 error） |
| **发布工程** | 未就绪（签名公证从未真机跑过、CI 与本地双轨打包、产物零冒烟） |
| **核心链路设计** | 多数模块达行业主流（4/5 以上），但存在 **8 个 P0 级「安全边界谎报」** |
| **界面可靠性** | 存在 **4 个 P0 白屏/误删路径**，均由「无局部边界 + 无请求序号」引起 |
| **视觉一致性** | Token 层专业级，但**消费方大规模逃逸**，按钮出现 5 种圆角/5 种高度 |

一句话：**代码底座已经过关，卡住 1.0 的是发布工程本身，加上一批「安全边界谎报」型缺陷。** 距 1.0.0 的实际工作量估计：安全边界与界面止血约 3 人日，发布工程梗阻约 3–5 人日，健壮性与打磨约 3 人日 — 合计两个迭代窗口。

---

## 一、审查覆盖度（诚实标注）

| 状态 | 范围 |
|---|---|
| **逐行通读** | agentRunner、exec 全家族、approval 全家族、writeGuard、ssrfGuard、streamGuard、checkpointStore、preload、orchestrator、db 全系列、localStore、taskStore、workerPool、workerIsolation、groupBudget、memory 核心、nativeTools、codeTools、artifactStore、zipStore |
| **二轮补审通读** | MCP 全系列（12 文件）、沙箱三平台、nativeSandbox、团队编排剩余（12 文件）、调度全系列（11 文件）、配额（4 文件）、knowledgeBaseQuery、pluginMarket、ecosystem、browserTools、computerUse、entryPolicy、updater |
| **抽样** | scheduler 持久化段、waveEngine 探活段、memory 写锁段 |
| **未覆盖** | `chrome-extension/` 完整链路、`agent-core/` CLI 入口、部分 `ipc/*.js` 处理器薄层、`shared/` 类型契约 |

---

## 二、Part A — 模块业务逻辑 × 主流技术设计符合度

### 2.1 符合度总评分

| 链路 | 分 | 对标 | 一句话理由 |
|---|:--:|---|---|
| 审批与安全策略 | **4.5** | Codex / Claude Code | 分级 + 不可记忆集 + 前缀规则语义 + 未登记兜底 L3 + 决策枚举校验。本项目最成熟模块 |
| Agent 执行主循环 | **4** | Codex | IPC fail-closed、durable 落盘确认、双路径引擎。扣分：无并发上限、装配段在 try 之外 |
| 流式与取消 | **4** | Claude Code | 首字节/空闲/总时长三层 + abort 事件。扣分：取消只覆盖交互式通道一条路径 |
| 记忆体系 | **4** | Mem0 / Zep | 五域四层 + 来源可信度 + 容量闸 + 提名制晋升。扣分：后台任务无崩溃恢复 |
| 持久化 | **4** | 成熟桌面应用 | 16 级迁移链 + 迁移前快照 + 损坏隔离三级恢复 + corrupt-blocked 拒绝写入 |
| 多 Agent 编排 | **4** | Devin / CrewAI | 状态机 + 环检测 + 副作用账本 + worktree 隔离。扣分：pump 异常只落日志、无组级看门狗 |
| 工具执行与治理 | **3.5** | Codex | 三平台沙箱 + 写白名单 + 审计齐全。扣分：apply_patch 无 error 监听、写文件非原子 |
| MCP 集成 | **3** | Cursor | 版本协商与会话恢复纪律好。扣分：SSE 流不释放、stdio 无 stdin 错误通道、sse 传输死代码 |
| 沙箱实现 | **2.5** | — | macOS 分支仍 fail-open；**vm 沙箱可被一行逃逸**（Node 官方明确声明 vm 非安全边界） |
| 配额与熔断 | **3** | Resilience4j | 组级三键闸语义清晰。扣分：熔断把前台一起挡了，与自身规格相反 |

### 2.2 P0 — 安全边界谎报（共同根因：守卫判定与执行判定不同源）

#### A-P0-1　熔断开启时连前台请求一起挡死，与自身规格相反
- **现象**：任一 provider 连续 5 次错误 → 主会话 / Worker / 定时任务的所有模型请求在 5 分钟内每次干等 30s 后抛「资源槽位等待超时…熔断中」。表现为应用整体卡死。
- **锚点**：`main/resourceQuotaCenter.js:74-85` `acquire()` —— `if (!breakerOpen) { if (isFg) {...} }`，isFg 分支被包在熔断判定内
- **反证**：同文件第 11 行规格明写「overload … bg 全停，**fg 照常**（用户自己会看到错误）」
- **主流做法**：熔断器只降级可牺牲的那一路，高优先流量放行并通过错误码暴露
- **修复**：把 fg 分支移出 `!breakerOpen`；fg 仅受 `providerLimit` 约束

#### A-P0-2　macOS 沙箱分支仍是 fail-open：30 条危险命令黑名单同时失效
- **现象**：在嵌套沙箱环境（被其他 Agent 平台包住）或 CI 容器中，`seatbeltUsable()` 返回不可用 → `exec.js` 落到 `runFallback` 以宿主权限直跑；而 `checkCommandGuard` 仍认为「OS 级沙箱可用」→ 跳过 30 条危险模式拦截。**两层守卫同时失效**，`rm -rf` 以宿主权限执行。
- **锚点**：`main/sandbox.js:65-69`（darwin 分支 `return !!execExists`）+ `:80-83`
- **关键**：Linux 分支（`:67`）已改为读真探测缓存，macOS 未同步；本文件 52-58 行注释完整描述了此缺陷形态，但只修了 Linux
- **修复**：darwin 分支改读 `seatbeltProbe` 缓存，首次未探测时保守返回 false

#### A-P0-3　`sandbox_code_run` 的 vm 沙箱可被一行逃逸
- **现象**：对外宣称「强沙盒：无文件/无网络、仅纯计算」，实际 `Buffer.constructor.constructor('return process')()` 即可拿到宿主 `process`，进而 `require('child_process')` 任意执行。
- **锚点**：`main/nativeSandbox/childEntry.js:71-83` 把宿主 realm 的 `Buffer`（:74）、宿主 `require` 返回值（:73）直接注入 vm context
- **加重情节**：`nativeTools.js:255-262` 用 `utilityProcess.fork` 起的子进程**未再套 seatbelt/bwrap**，逃逸即等于当前用户身份任意执行
- **主流做法**：Node 官方文档明确「vm is not a security mechanism」；应用 `isolated-vm` 或系统级沙箱
- **修复**：①最小改动——删除 Buffer 注入、process 换纯字面量对象、require 返回值走 structuredClone 边界；②根治——放弃 vm 作为边界，子进程套 seatbelt/bwrap，vm 只做防误用

#### A-P0-4　`apply_patch` 缺 `error` 监听，Windows 上可崩主进程
- **锚点（已复核）**：`main/tools/execWrite.js:106-136` —— 只有 `stdout/stderr data`、`timeout timer`、`child.on('close')`，**无 `child.on('error')`**
- **现象**：Windows 默认无 GNU `patch` → `spawn('patch')` 触发 ENOENT → 无监听器 → EventEmitter 抛未捕获异常 → 主进程崩溃，全部会话丢失
- **对照**：同项目的 `execFileDetached.js:59` 已正确处理 `error`，此处是裸 spawn 未沿用同一纪律
- **修复**：补 `child.on('error', ...)` 转结构化失败；Windows 直接返回「本机缺少 GNU patch」的可行动提示

#### A-P0-5　Windows 沙箱分支 Promise 可能永不结算
- **锚点**：`main/tools/exec.js:222-260` —— `new Promise((resolve) => { sandbox.windowsBackend.windowsSandboxReady().then(async (st) => {...}) })` **无 `.catch`**，async 回调内无 try/catch
- **现象**：三种异常路径都让 Promise 永不 settle → IPC `tool:shell` 永久挂起 → 只能等引擎 600s 看门狗，且报的是「执行超时」，真因被掩盖
- **对照**：同文件非 Windows 路径（:262）已正确写了 `.catch`，仅此分支漏
- **修复**：补 `.catch` 转结构化失败，并给 `windowsSandboxReady()` 加超时

#### A-P0-6　`never` 审批档没有 L1 硬地板：交互路径比无人值守路径更松
- **锚点（已复核）**：`main/approval.js:436` `if (approvalMode === 'never') return { need: false };` —— **排在 `toolLevel()` 之前**（`:437`）
- **现象**：用户选「全不询问」后，`rm -rf`、`curl x | sh`、`git push --force` 等 L1 命令零确认直接执行。而 Worker 路径因 `workerPool.js:394` 强制 `stricterApproval(..., 'auto-safe')` 反而会先询问
- **矛盾点**：本文件 443 行明写「L1 危险命令不接受任何规则豁免」，`auto-safe` 档（:454）只对 L2 放行——唯独 `never` 变成了总开关短路
- **主流做法**：Claude Code 的危险命令 denylist 不可被档位绕过，档位只影响提示强度
- **修复**：把 L1 判定提到 `never` 短路之前：`if (level === 'L1') return { need: true, level }`

#### A-P0-7　`http_request` 走 `fetch()`，SSRF 双判据只接了一半
- **锚点**：`main/nativeTools.js:139-164` 用全局 `fetch({ redirect:'manual' })`，每跳只做字面量 `isPrivateHost`；而 `ssrfGuard.js:183` 的 `guardedLookup`（resolve-then-validate）**只在 `webTools.js:62` 的 `http.request` 上接线**
- **现象**：DNS rebinding —— 首次解析为公网 IP 通过字面量检查，`fetch` 内部重连时落到 127.0.0.1 → SSRF
- **自相矛盾**：`ssrfGuard.js:27` 注释写「字面量主机名与解析后地址两处都已判」，但 fetch 通道未兑现
- **修复**：改走 `webTools.httpRequest`（已接 guardedLookup），或 fetch 前 `dns.lookup(all:true)` 全量预检并标注残余窗口风险

#### A-P0-8　checkpoint 全文件读改写无互斥 → 并发 Worker 断点互相覆盖
- **锚点**：`main/checkpointStore.js:88-108` `saveCheckpoint()` = loadAll → 改内存 → saveAll（全量写）
- **现象**：团队派活多 Worker 并行收尾，两次 save 交错时后写覆盖先写 → 成员跨 run 记忆随机失效
- **对照**：同项目 `memory/index.js:217 _serialized` 已有串行化模式，checkpoint 未沿用
- **修复**：加 `writeChain = Promise.resolve()` 串行化写操作

### 2.3 P1 — 逻辑错误导致功能不可用或真因被掩盖

| # | 缺陷 | 锚点 | 现象 | 修复要点 |
|---|---|---|---|---|
| A-P1-1 | Worker/定时通道子进程未登记 | `agentRunner.js:523` 有 runScope，`workerPool.js:344` 未包 | 强制关闭/超时后 detached 进程继续跑，下个任务同 cwd 撞车 | `workerPool.dispatch()` 用 `runScope.run({runId},…)` 包裹；收尾调 `killChildrenForRun` |
| A-P1-2 | `depends_on` 解析失败静默降级 `[]` | `taskStore.js:775 safeParse` catch→null；`:760 \|\| []` | 依赖丢失 → 下游乱序派发 → 并行写互相覆盖，无任何告警 | `rowToTask` 加 `parseDepends`，失败打 `corruptDeps`，`enqueueReady` 跳过并置 failed |
| A-P1-3 | 记忆后台任务 running 行无崩溃恢复 | `memory/bgScheduler.js:122 _claim` 只选 queued | 压缩期崩溃 → 该行永 running → 后续压缩**永不入队**，全局周期维护停摆 | `start()` 先回置 running→queued（attempts<3），≥3 置 failed |
| A-P1-4 | sql.js `run()` 不返回 lastInsertRowid | `db/sqljsDb.js:148-153` 只 return `{changes}`；`taskStore.js:715` 期望归一 | 打包版 `appendEvent()` 恒返回 null → dev/生产行为不一致 | `run()` 内补 `sqldb.exec("SELECT last_insert_rowid()")` |
| A-P1-5 | 市场「网络技能安装」硬编码关闭签名闸 | `ipc/plugins.js:126` policy 硬编码 `allowUnsigned:true` | 用户真正会点的那条路**无签名保护**，且合成权限为 `filesystem:*`，安装后热加载 | policy 改 `resolveSignaturePolicy()`；权限收敛为最小集；审批卡强制带「未签名来源」 |
| A-P1-6 | 意图预热无 tier 闸 | `intentMcpPrewarm.js:111-127` 无 `classifyTier` | 对话提一句「发个 slack」即自动连接 manual 档连接器（带密钥/写外部系统） | 复用 `mcpPrewarm.js:52-77` 的 MANUAL 红线字典作为单一判据 |
| A-P1-7 | 团队派活启动失败被吞 | `scheduledTeam.js:119-132` `.catch()` 只 console.warn | 真因被「等待超时」文案永久掩盖 | 保存 runGroup Promise，`waitGroupSettled` 前先 await 启动确认 |
| A-P1-8 | sqlite 连接缓存毒化 | `nativeTools.js:189-197` 失败项不入缓存删除 | 一次失败 → 该路径永久失败直到重启；且无容量上限 | catch 中 `sqliteDbs.delete(absPath)`；加 MAX_OPEN_DBS + TTL |
| A-P1-9 | 组预算 timeoutMs 缺下限 | `groupBudget.js:125-137` 无预算分支无 clamp | 数据被写为 0 → `setTimeout(0)` 立即 abort，任务一启动就超时 | `Math.max(1000, taskTimeout)`，与有预算分支（:151）对称 |
| A-P1-10 | 超时只发一次 SIGTERM 不整组杀 | `execFileDetached.js:48-52` | npm run build 类进程树子存父亡，`close` 不触发 → 工具挂到 600s | `kill(-pgid, SIGTERM)` → 5s 后 `SIGKILL` |
| A-P1-11 | grep/glob 超时静默返回部分结果 | `tools/exec.js:414-431` 忽略 error 参数 | 模型拿到截断结果当作完整，据此下错误结论 | 回传 `error:'timeout'` + `killed:true`；改用 execFileDetached + registerChild |
| A-P1-12 | SSE 响应流永不释放 | `mcpHttpTransport.js:140-143 / 189-198` | 每次 tools/call 残留挂起 reader，句柄堆积 | 加 `shouldStop(msg)`（命中 id 即 `reader.cancel()`）+ idle/total 上限 |

### 2.4 P2/P3 精选（完整清单见附录）

- **P2**：sql.js 每次写触发全库 export + fsync（写放大，`sqljsDb.js:88-115`）；写用户文件非原子（`execWrite.js:48/88` 未走 durableWrite，崩溃即半成品源码）；checkpoint「LRU」实为 FIFO（`checkpointStore.js:93-97`）；cron 的日/周用 AND 与 Vixie cron OR 语义不符（`scheduler.js:173-181`）；`scheduled-tasks.json` 未设 0600（`scheduledStore.js:114`）；团队调试日志热路径同步 appendFileSync（`teamDebugLog.js:130`）；`consumeStall` 依赖缺失时返回 true 致任务永久悬空（`waveEngine.js:262-298`）
- **P3**：`TOOL_LEVEL` 仍含不可达的 `mcp__: 'L3'`（`approval.js:235`，正是本文件批判过的形态）；`localStore.js:320` 恒 undefined 死表达式；`sqljsDb.transaction()` 不支持嵌套；`mcpClient.js:462` 默认 `env={}` 会让子进程拿空环境

---

## 三、Part B — 界面逻辑正确性与崩溃风险

### 3.1 P0 — 白屏 / 数据误操作

#### B-P0-1　除右栏外全应用零局部边界：任一子树渲染异常 → 整棵 App 被替换为错误页
- **现象**：侧栏点「定时任务」时任一条数据缺字段 → 渲染抛错 → **整个应用**（含正在跑的会话、输入框、命令面板）被根边界换成错误页，`messages`/`streamingText`/`runSummary` 全部丢失
- **锚点**：`main.jsx:26`（唯一根边界）、`App.jsx:642-679`（唯一局部边界，只包 RightPane）
- **裸奔子树**：Sidebar、ChatArea、Dashboard、AssistantPage、ScheduledTasks、DeskPage、StudioPage、LedgerPage、CommandPalette、SettingsModal、EcosystemModal、ProjectPicker、ArchiveModal、ApprovalCard
- **修复**：
  1. 按路由包壳 `<ErrorBoundary compact key={route.page}>`，包住 `App.jsx:572-636` 各页面分支；三个 Modal 各包一层
  2. 边界加自动复位，否则切页不恢复：
     ```jsx
     componentDidUpdate(prev) {
       if (this.state.error && prev.children !== this.props.children) this.setState({ error: null });
     }
     ```

#### B-P0-2　`ScheduledTasks` 渲染期裸取 `task.prompt.slice()`
- **锚点（已复核）**：`components/ScheduledTasks.jsx:568` — `{task.prompt.slice(0, 100)}`
- **现象**：定时任务缺 `prompt`（模型侧 `scheduledCreate` 写入或用户手改 json）→ 点开页面立即抛 `Cannot read properties of undefined` → 叠加 B-P0-1 全应用白屏
- **根因**：`main/scheduledStore.js normalTask()` 只归一 team_id/thread_id，其余字段原样保留
- **修复**：`{String(task?.prompt || '').slice(0, 100)}`；入 state 前统一归一 `tasks.map(t => ({...t, prompt: String(t?.prompt||'')}))`

#### B-P0-3　DiffReviewPanel 无请求序号 → 旧回包覆盖新状态（可致误删他项目改动）
- **现象**：项目 A（大仓库 diff 慢）打开「变更」→ 立刻切到 B → A 的 diff 后到覆盖 state → **面板标题写 B、内容却是 A 的改动** → 点「全部放弃」会对 A 的路径执行 gitDiscardFiles
- **锚点**：`components/DiffReviewPanel.jsx:48-69`（load 无 seq）
- **修复**：加 `loadSeqRef`，每个 setState 前判 `if (seq !== loadSeqRef.current) return`，`finally` 同样加判定

#### B-P0-4　快速连发两次「发送」创建两个会话 + 两次模型调用
- **现象**：输入框有内容时连按两次 Enter → 两次都通过 `if (loading && !opts.force) return`，因为 `setLoading(true)` 在 `await createThread` **之后**才执行 → 双花 token
- **锚点**：`hooks/useAgentRun.ts:243`（判据）、`:353`（setLoading 太晚）
- **修复**：函数首行加同步闩锁 `sendingRef`，`finally` 释放（须覆盖所有 return 分支）

### 3.2 P1 — 状态错误 / 功能不可用

| # | 缺陷 | 锚点 | 现象 | 修复 |
|---|---|---|---|---|
| B-P1-1 | 全局单例 confirm 被后到者覆盖 | `feedback.jsx:14` 单槽、`:53` 覆盖、`:117` 只 resolve 当前 | 前一个 `await confirm` **永不返回** → `setBusy(true)` 永不复位 → 变更面板所有按钮永久 disabled | 改 FIFO 队列 + 5min 超时兜底 resolve(false) |
| B-P1-2 | `loadData()` 无请求序号 | `App.jsx:358-382` | 600ms 内新建会话后被旧回包覆盖 → 刚创建的会话从侧栏消失，用户以为失败而重复创建 | 照抄 `ChatArea` 的 `msgReqRef` 模式加 seq |
| B-P1-3 | 定时任务新建无防重复提交 | `ScheduledTasks.jsx:151-202` | 双击确认 → 创建两条同名任务，cron 到点执行两次 | 加 `saving` 态 + `disabled` |
| B-P1-4 | 定时任务 4 处写操作裸 await | `:224 / :258 / :275 / :303` | 写失败 → 开关弹回、无反馈、unhandled rejection | 统一 try/catch + setError |
| B-P1-5 | `setThreadStatus().then(loadData)` 无 catch | `App.jsx:621-623, 783` | 每次运行状态上报失败都 unhandled rejection，线程状态与徽标静默不同步 | `.catch(e => console.warn(...))` |
| B-P1-6 | ApprovalCard resolve 无 `?.` 无 try | `ApprovalCard.jsx:109-111` | 桥重建期间点「允许」→ TypeError 在事件处理器抛出（**ErrorBoundary 捕获不到**）→ 决策丢失，卡片挂到主进程 120s 超时 | try/catch + toast + **失败时不乐观出队** |
| B-P1-7 | 删除会话用渲染期闭包 threads | `App.jsx:537` | await 期间并发刷新 → 已删会话「复活」或新会话消失 | `setThreads(prev => prev.filter(...))` |
| B-P1-8 | 本地库不可用时列表静默为空 | `ipc/localData.js:191/220` + `App.jsx:358-375` | DB 未就绪 → `Promise.allSettled` 全 fulfilled 不弹 toast → 用户看到「会话凭空消失」 | 渲染层补空值判定并提示，或主进程返回 `{ok:false, error:'store-not-ready'}` |

### 3.3 Guard 缺失汇总（10 个裸调用点，成本极低收益直接）

`ApprovalCard.jsx:109`｜`SettingsModal.jsx:752`｜`App.jsx:621/783/100`｜`ScheduledTasks.jsx:224/258/275/303`｜`hooks/useAgentRun.ts:787`

统一写法：`try { await window.mjcode?.xxx?.(p) } catch (e) { console.warn(...); toast(...); return; }`

### 3.4 P2 精选

- 聊天消息流无虚拟滚动（`MessageStream.tsx:80-103`，3000 条会话连点「加载更早」可卡死）→ 改条数封顶 + 双向窗口
- `ChatArea` revert 监听 useEffect **无依赖数组**（`:658-662`）→ 每次输入字符都 remove+add
- `subagentsByThread` 只增不减（`App.jsx:617-620`）→ 每桶上限 200 条
- ThreadList 分组 key 用 `project.path` 可重复/空（`ThreadList.jsx:64`）→ `path || id || 'p-'+i`
- 快捷键不判输入焦点（`App.jsx:183-209`）→ 设置项输入框里按 ⌘B 会折叠侧栏
- `FileTree` 单目录无条目上限（`:79-96`）→ `slice(0,300)` + 显示更多；IGNORED 补 `.next/.venv/target/build`
- 明确 밝혀：**以下Idらの실제로 잘되었다** — `ChatArea` 的 `msgReqRef` 竞态守卫、`ui/Modal` 的焦点陷阱/栈/归还、`PlusMenu` 捕获阶段 Esc、`AgentDock` 乐观更新回滚、`lib/compactSession` 撤销带。**勿在重构中误伤**

---

## 四、Part C — 视觉审美与设计系统

### 4.1 总体判断：**良好（Good），未达专业级**

先说做得好的（洞察 BigDecimal hard：比其他项目好）：99 个组件文件**硬编码色值 0 处**；60 枚图标共用同一 `S()` 包装器（24 viewBox / stroke 1.5 / currentColor）；去注释后硬编码中文仅 2 处；`ui/Modal.tsx` 完整实现 WAI-ARIA Dialog Pattern；正文对比度 5 套主题全部 AAA。

**最大短板：有「系统」之名，无「系统」之实——原语存在但收不住消费方。** 因果链：

> `ui/Button.tsx:70` 基础类写死 `inline-flex` + `whitespace-nowrap` + 固定 `h-*` + `text-xs`
> → 消费方覆盖不了（Tailwind 同名类由样式表顺序决胜）
> → 被迫 `!important` 逃逸（`ArtifactPanel.tsx:301` 单个 className 里 **9 个 `!`**）
> → 或绕开 Button 手写（33 处）→ 同一个「主按钮」出现 **5 种圆角、5 种高度、2 种字号、3 种 hover、4 种禁用透明度**

`AssistantDirectory.tsx:171` 与 `ScenarioCards.tsx:45` 的注释里作者亲笔承认了这个困境。

### 4.2 P1 — 直接影响品质感

| # | 问题 | 证据（已实测） | 修改建议 |
|---|---|---|---|
| C-P1-1 | Button 基础类不可覆盖 | 全仓 Tailwind `!` 类 **21 处 / 7 文件**，几乎全部指向此根因 | 布局类下沉进 SIZE_CLASS，新增 `size="card"` 档；或引入 `tailwind-merge` 的 `cn()`。修完 21 处 `!` 全可删 |
| C-P1-2 | 按钮参数发散 | 圆角 6/8/10/14 px 四档（`rounded-lg` 21 处、`rounded-xl` 4 处）；高度 24/28/32/36/40 五档；hover 三套且 5 处完全无 hover；禁用 opacity 30/40/50/60 | 圆角统一 `rounded-md`(8)；高度只允许 h-7/h-8；字号统一 `text-xs`；hover 统一 `hover:brightness-110`；禁用统一 `opacity-50` |
| C-P1-3 | **三套主题选中态是蓝色**（已复核） | `theme.css:89/113/137` 全是 `rgba(96,140,255,...)`，select-fg 三套完全相同 `#c7d8ff`；而 `:40` 注释明写「绝不出蓝」。forest 全绿界面里选中项是蓝色，最刺眼 | midnight→`rgba(129,140,248,.20)/#a5b4fc`；forest→`rgba(34,197,94,.18)/#86efac`；sunset→`rgba(249,115,22,.20)/#fdba74` |
| C-P1-4 | 卡片无统一定义 | 同为卡片容器：圆角 10/14/16 三种，内边距 8/12/16/20 四种 | 卡片统一 `rounded-xl`(14) + `p-4`(16)；模态保留 `rounded-2xl`(16) |
| C-P1-5 | 输入框圆角 10px vs 按钮 8px | `ui/Input.tsx:14` 用 `rounded-lg`(10)；`AssistantDirectory.tsx:184/191` 用 `bg-bg`+`text-sm`+无 h-8（高度 ≈24 vs 标准 32） | Input 改 `rounded-md`；所有输入框底色统一 `bg-input`（现 bg-raise 3 处、bg-bg 2 处） |
| C-P1-6 | **焦点环对比度不达标** | light 主题 `--sem-focus: rgba(46,75,60,0.5)` 合成后 **2.49:1**（WCAG 非文本阈值 3.0）；dark 勉强 3.25:1 | light→`#2E4B3C`（≈9.6:1）；dark→`#A8C9B5`（≈9.25:1）；sunset 改与 accent 同色系 `#fdba74`（现是复制来的 `#93c5fd`） |

### 4.3 P2 — 细节毛刺

- **11px 正文过多（313 处 text-caption + 9 处 text-[11px] / 57 文件）**：其中 `StudioPage.tsx:64`、`KnowledgeScope.tsx:166` 承担的是正文描述。徽章类 6 处 `leading-none` 让 11px CJK 行间几乎无空隙。→ 原则：**11px 只给角标/计数/时间戳，任何超过一行的中文文案不低于 12px**
- **图标尺寸 12 档**：`size={11}`(45)、`size={13}`(69) 等奇数档会让矢量描边落在半像素上变虚 → 收敛为 **12/14/16/20/24** 五档
- **禁用语义色零消费**：`text-disabled` 命中 0 次，全靠 opacity；且 5 套主题中 4 套 disabled 对比度 < 4.5:1
- **裸 z-index 7 处**：违反 `theme.css:319` 自己立的「禁止裸 z-index」
- **动效 token 全部为死代码**：`--dur-fast/base/slow` 定义了但 tailwind.config 没有 transitionDuration 扩展，消费 0 次
- **`transition-all` 4 处**（`Switch.tsx:73`/`Bar.tsx:13` 等高频组件有掉帧风险）
- **`focus:outline-none` 3 处**抹掉模态面板焦点环（键盘用户开弹窗看不到焦点）
- **空态原语 `PanelEmpty` 仅 3 处采用**，其余面板各自手写居中占位

### 4.4 Token 收敛建议表

| 类别 | 现状 | 收敛目标 |
|---|---|---|
| **圆角** | 7 个值在跑 | 控件 `rounded-md`(8) ／ 卡片 `rounded-xl`(14) ／ 模态 `rounded-2xl`(16) ／ `rounded-full` 仅图标按钮 |
| **字阶** | 11 个值 | caption 11 ／ code 12 ／ xs 13（UI 默认正文） ／ sm 14 ／ base 16 ／ xl 20。`text-2xl`(2处)、`text-3xl`(2处)、`text-[15px]`(1处) 并入邻近档 |
| **字重** | medium 103 / semibold 38 / normal 9 | 保留三档，禁 600 以上 |
| **图标** | 12 个值 | 12 / 14 / 16 / 20 / 24 |
| **间距** | 96% 已达标 | 卡片 `p-3`→`p-4`、`p-5`→`p-4`；非 4 倍数仅允许 `h-1.5/w-1.5` 圆点，`py-[2px]/[3px]` 3 处→`py-1` |
| **动效** | token 为死代码 | config 补 transitionDuration/TimingFunction 映射，三档：fast 100 / base 150 / slow 250 |

> **加分项（保持不动）**：`backdrop-blur` 0 处、自定义 keyframes 仅 2 个、`prefers-reduced-motion` 全局降级 —— 无大面积动画掉帧风险。对话正文 15px/1.75 与 markdown 14px/1.7 属**阅读态**，与 UI chrome 有意分层，建议保留但写入规范。

---

## 五、Part D — 1.0.0 发布门禁清单

### 5.1 发布就绪度评分

| 维度 | 分 | 关键判断 |
|---|:--:|---|
| 数据迁移与兼容 | **4** | 16 级迁移链 + 迁移前快照 + 幂等加列。缺口：无独立测试、**无降级保护** |
| 测试与门禁 | **4** | 312 套件 0 失败、无 `.only/.skip` 残留、lint 棘轮与 God-File 门禁真实有效。缺口：基线 **157/157 顶格零余量** |
| 安全与合规 | **4** | 主窗 nodeIntegration:false + contextIsolation + CSP + 凭证双轨加密。扣分：CUA HUD 窗全开 node 权限 |
| 打包配置 | **3** | files 白名单有 21 条断言守卫。扣分：CI 与本地**双轨**，CI 绕过含 bundle:ocr 的 build 脚本 |
| 自动更新 | **3** | 实现质量高（错误分类/手动兜底/通道 fail-closed）。扣分：**从未真机跑通** |
| 可观测性 | **3** | crashGuard 设计完整、diagExport 脱敏双保险。扣分：日志无轮转、**无崩溃上报** |
| 发布物料 | **2** | 版本仍 0.7.0-beta；CHANGELOG 无 1.0.0 段；产品名 `MJ Coder` 与 UI 里 13 处 `MJ Nexus` 冲突 |
| 签名与公证 | **1** | `grep notarize/appleId/CSC_` 全仓零命中；Runbook 演练记录只有一行「未执行」 |
| 性能基线 | **1** | **完全没有**冷启动/内存/体积基线脚本 |

### 5.2 BLOCKER（不清不能发）

#### D-B1　版本号三处均未提升 + CHANGELOG 无 1.0.0 段
- 证据：`desktop/package.json:3` / `renderer/package.json` / `server/package.json` 均为 `0.7.0-beta`；`CHANGELOG.md:6` 最新为 `[0.7.0-beta] - 2026-10-22`
- 阻塞理由：`build.publish.releaseType="release"` + `resolve-update-channel.mjs` 会把 `v0.7.0-beta` 判为 beta/prerelease，**1.0 正式版在物理上不存在**
- 做法：三处 `npm version 1.0.0 --no-git-tag-version`；CHANGELOG 增 `[1.0.0]` 段且必须含「从 0.7.0-beta 升级」说明；tag 不带预发布后缀

#### D-B2　macOS 未签名未公证、Windows 未签名；且 Windows 校验实际空转
- 证据：`grep notarize|appleId|CSC_|afterSign` 在配置与 CI 中**零命中**；`docs/签名公证更新演练Runbook.md:97` 仅一行「未执行」
- 隐藏陷阱：`package.json:100` 有 `verifyUpdateCodeSignature:true`，但缺 `win.publisherName` → electron-updater 的 `NsisUpdater.verifySignature()` **直接 return null 跳过**（`node_modules/electron-updater/out/NsisUpdater.js:84-99`）。即被 `test/build-config.test.js:94` 断言为 fail-closed 的门禁，**一行都不执行**
- 做法：GitHub Secrets 补 7 个签名变量（CI 已就位无需改工作流）；`build.win` 补 `publisherName`（必须等于证书 CN）；**不要**照 Runbook 加 `notarize:{teamId}` 硬编码（见 S2）；发版前必须真机 `spctl -a -vv` 并写回演练表

#### D-B3　发布目标仓库（MJCoder）与代码仓库（MJWork）不一致
- 证据：`git remote` → `jasonma1210/MJWork`；`package.json:44-45` → `owner: jasonma1210, repo: MJCoder`；`ci.yml:177` 用 `secrets.GITHUB_TOKEN`
- 阻塞理由：`GITHUB_TOKEN` 作用域**仅限当前仓库**。若 MJCoder 是另一仓库，`--publish always` 会 403/404，包打好但发不出去。README 历史显示此前全是手工 `gh release create`，**CI 发布路径从未验证**
- 做法：新增 `RELEASE_TOKEN`（对 MJCoder 有 repo 写权限的 PAT），`ci.yml:177` 改 `${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}`；先用 rc tag 空跑验证

#### D-B4　CI 打包的 macOS 包必然拿不到 OCR
- 证据：`.gitignore:165` 排除 `desktop/build/ocr/`；`package.json:89-94` 的 `mac.extraResources` 源为该目录；CI Package step（`ci.yml:277-283`）**直接** `npx electron-builder`，不执行含 `bundle:ocr` 的 `build` 脚本
- 阻塞理由：Runbook 明文「生产包只从 CI 产出」。CI 上该目录不存在 → 官方包必缺 OCR（`ocrEngine.js:45-47` 候选路径找不到即不可用）
- 做法：CI 中仅 macOS 增加 `brew install tesseract tesseract-lang && node scripts/bundle-ocr.mjs --force`；并把三平台打包命令统一为 `npm run dist:{mac,win,linux}` 消除双轨；补断言进 `test/build-config.test.js`

#### D-B5　`npm run build` 在非 macOS 必然失败
- 证据：`scripts/bundle-ocr.mjs:32-35` 非 darwin 直接 `process.exit(1)`，而 `npm run build` 无条件串联
- 阻塞理由：非 mac runner 第一步即红，无法演练排障；且 `test/build-config.test.js:68-78` 只断言 `scripts.build` 顺序，**对 CI 走的路径完全无效**（测试绿、生产无人守）
- 做法：改为非 darwin **退出 0 + 明确 warning**（OCR 是可选能力，不该阻断构建）

#### D-B6　打包产物零冒烟
- 证据：`ci.yml:285-298` 只 upload-artifact，无任何一步打开/挂载/执行产物
- 阻塞理由：本项目历史事故几乎**全部是打包态才出现**（better-sqlite3 打包版 SIGSEGV、safeStorage 打包版不可用、`node --check` 假绿）。**源码级 312 个套件一条都拦不住**
- 做法：新建 `scripts/smoke-packaged.mjs`，fail-closed 断言 5 项：app.asar 存在 → 解包确认 main/main.js + renderer/dist/index.html + preload.js + sql-wasm.wasm → ocr/tesseract 存在 → app-update.yml 的 publisherName 非空 → Info.plist 版本 == VERSION

### 5.3 SHOULD（发版前强烈建议）

| # | 项 | 锚点 | 做法 |
|---|---|---|---|
| S1 | Windows 更新签名校验真正生效 | `package.json:96-101` | 补 `publisherName`，未签名时**先移除** `verifyUpdateCodeSignature`，否则补了反致 100% 更新失败 |
| S2 | 签名公证 Runbook 已过期（照做引入回归） | `docs/…Runbook.md:19-40` | electron-builder 26 直接读 env `APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID` 自动公证，`hardenedRuntime` 默认开。删除「补 notarize:{teamId}」片段 |
| S3 | 2048×2048 PNG 现场转图标 | `package.json:85/98/104` | 预生成 `build/icon.icns` + `build/icon.ico`（多尺寸）+ linux 512 png。单张 PNG 转 ico 是 electron-builder 常见失败点 |
| S4 | dev-only better-sqlite3 进包体 | `package.json:133-135` | `files` 增 `"!**/node_modules/better-sqlite3/**"` + 加断言防止被人挪回 dependencies |
| S5 | 日志无轮转 | `lifecycle/window.js:102-122` | 启动时保留最近 7 个 `main-YYYYMMDD.log`（与 localStore DAILY_BACKUP_KEEP_DAYS 同口径） |
| S6 | 零远端崩溃可见性 | 全仓 grep `setCrashReporter\|Sentry` 零命中 | 显式二选一并写进 README：隐私优先（本地 Crashpad dmp + 明示不上传，作为卖点）或自建 Sentry + 默认关开关 |
| S7 | CUA HUD 窗全开 node 权限 | `computerUse.js:973-979` | 改 `contextIsolation:true + preload + contextBridge`，HTML 不再 `require('electron')` |
| S8 | `webviewTag:true` 无附加约束 | `lifecycle/window.js:52` | 加 `will-attach-webview` 剥离 nodeIntegration/preload + `setWindowOpenHandler` deny |
| S9 | 品牌名双轨 | `package.json:41` vs `window.js:47`/`index.html:37` 等 13 处 | 统一为 `MJ Coder`；加断言锁 `window.js` title == productName |
| S10 | 迁移链无独立测试 + 无降级保护 | `db/index.js:37-511`（16 级） | 新建 `test/db-migration.test.mjs`（v0→v16 逐级 + 幂等 + 快照）；`migrate()` 遇 `current > target` **必须告警而非静默跳过**（现 :655 会让用户看到数据「莫名少东西」） |
| S11 | lint 基线顶格零余量 | 实测 157/157，与 `lint-ratchet.test.mjs:25` 完全相等 | 发版前清一批 `no-unused-vars`（参数改名 `_e`）降至 ≤140 留余量；CI 加 `format:check`；顺手修正 `ci.yml:125` 过期注释 161 |
| S12 | 发布物料缺失 | — | CHANGELOG 增 1.0.0 段；新建 `docs/发布说明模板.md`（五段：更新/升级前备份 `~/.mjcode/local-data.json`/已知限制/回滚/反馈）；README 加版本徽章与下载区 |
| S13 | 别直接 latest | `resolve-update-channel.mjs:52-64` | 先 `v1.0.0-rc.1` 发 beta 通道（.github provider 下不会污染 latest.yml），内测 3–5 天再转正 |
| S14 | Linux 元数据不完整 | `package.json:102-106` | 补 `category: Development` / `maintainer` / `artifactName` |
| S15 | 诊断导出把用户正文写进可导出包 | `teamWorkerTrace.js:105`、`teamDebugLog.js:243` | prompt 默认截断 200 字符或只记长度；导出时提供「含/不含用户正文」开关 |

### 5.4 建议增补的工程能力（发布后立即做）

1. **性能基线**：`scripts/perf-baseline.mjs` 采集冷启动到 ready-to-show 耗时、稳态 RSS、产物体积；与上一版 diff 超 15% 告警。当前唯一体积证据是本地旧产物 151MB
2. **体积预算门禁**：dmg ≤ 180MB / asar ≤ 60MB 写成断言，防 `playwright-core` 之类无感膨胀
3. **发布审批闸门**：引入 GitHub Environment + required reviewer，避免误打 tag 即全网推送

### 5.5 发布 Runbook（摘要版）

**T-3 天准备**：S11 清 lint 至 ≤140（须同步改 `package.json:21` 与 `lint-ratchet.test.mjs:25`，两者被棘轮测试强制一致）→ S10 补迁移测试 → B6 建冒烟脚本 → B4 统一 CI 打包路径 → 改 package.json（S1/S3/S4/S9/S14）→ 补签名 secrets 与 RELEASE_TOKEN → 本地全绿 + git status 干净

**T-1 天 rc**：三处 version → `1.0.0-rc.1` → tag → 三平台矩阵全绿 → 确认产出 prerelease 且含 `beta-mac.yml`（不是 latest）→ **真机验收四项留痕**：macOS `spctl -a -vv` 通过 / Windows 无 SmartScreen / AppImage 可启动 / 用 0.7.0-beta 的 `~/.mjcode/` 启动后线程+消息+凭证（加密轨不断）+16 级迁移全部完成 → 写入 Runbook 演练表

**发布当天**：version → 1.0.0 → CHANGELOG 落 `[1.0.0]` → 确认 `vars.PUBLISH_RELEASE=true` → tag v1.0.0 → CI 三平台 → **逐项核对 Release 资产**（`MJCode-1.0.0-mac-arm64.{dmg,zip}`，**zip 必须有**，mac 更新器只消费 zip）→ 用装了 beta 的机器走完整更新流程（应提示 1.0.0 且不自动下载）→ 发 Release Notes

**回滚预案（按优先级）**：
| 场景 | 动作 |
|---|---|
| 元数据发错 | `gh release upload` 覆盖回上一版 `latest-mac.yml`/`latest.yml`，客户端下次 check 即回旧版 |
| 1.0.0 有致命 bug | 覆盖 latest*.yml 指回旧版；已升级用户需 `MJ_ALLOW_DOWNGRADE=1` 才能回退（`updater/index.js:109-111` 默认关）——**此路径至今未真机演练，发版前必须验证** |
| 资产损坏 | `gh release delete` + 删 tag + 覆盖 yml；用户侧 `classifyUpdateError` 会收到 integrity 提示，不会静默装坏包 |
| 数据损坏（最坏） | localStore 三级防线（.bak → 7 日副本 → corrupt 隔离 + 拒绝写入）+ SQLite `.pre-v{n}.bak`。**Runbook 必须写明让用户先复制整个 `~/.mjcode/`** |

---

## 六、统一修复排期（按批次）

| 批次 | 内容 | 预估 | 判据 |
|---|---|---|---|
| **批次 1（安全边界）** | A-P0-1/2/3/6/7（全是「守卫谎报」）+ A-P0-4/5 | 2 天 | 每个补一条「预期红」反向用例 |
| **批次 2（界面止血）** | B-P0-1/2/3/4 + Guard 表 10 项 | 1 天 | 路由全包壳；变性测试：随机删字段不白屏 |
| **批次 3（视觉观感）** | C-P1-1 ~ C-P1-6 | 1.5 天 | 21 处 `!` 归零；5 套主题焦点环 ≥ 3:1 |
| **批次 4（发布工程）** | D-B1 ~ D-B6 + S1/S3/S4/S9/S10/S11 | 3 天 | CI 打包后冒烟绿；macOS `spctl` 通过 |
| **批次 5（健壮性）** | A-P1-1~12 + B-P1-1~8 | 3 天 | 每条补端到端断言 |
| **批次 6（打磨）** | 剩余 P2/P3 + 性能基线 | 迭代消化 | — |

---

## 七、给团队的三条方法论提醒

1. **守卫判定与执行判定必须同源**——本次 8 个 P0 里有 5 个根因是这一条。Codex / Claude Code 都用「实际 apply 一次 profile」作为唯一判据，而不是问 OS 有没有这个二进制文件。判不出来时按「无沙箱」处理，保留命令级兜底。
2. **静默降级比崩溃危险。** `|| []`、`?.`、整个文件的 try-catch 会让失败伪装成成功——`depends_on` 解析失败导致任务乱序派发、`toolListDir` 吞错导致模型判定「目录不存在」、`checkpoint` 覆盖导致记忆随机失效，都是这个形态。关键调度字段解析失败应 fail-closed（拒绝派发 + 落 needs_review），而不是返回空值。
3. **312 套件全绿 ≠ 产品能跑。** 现有测试全部运行在源码级，而本项目历史事故几乎清一色是「打包态才出现」（better-sqlite3 打包版 SIGSEGV、safeStorage 打包版不可用、`node --check` 假绿）。在补上 B6 的打包产物冒烟之前，这套测试对发布风险的实际覆盖率是零。

---

*本报告基于静态源码审查 + 实测基线（darwin/arm64）。所有锚点已二次复核；标注「待验证」的条目需团队在修复前用 Read 确认行号未位移。*
