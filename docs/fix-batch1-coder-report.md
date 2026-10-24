# 第一批修复 — 编码工程师交付报告（FIX-P07 / FIX-P04）

- 日期：2026-10-24
- 仓库：`/Users/jianma/Desktop/MJCode`，基线 HEAD `7c477bd`（工作区另有他人改动的 docs 报告，未触碰）
- 本轮只做两条：FIX-P07（本地模式首聊无可用模型）、FIX-P04（定时/无人值守通道拿不到团队能力）
- 未提交 git（按要求交主理人统一处理）
- 判定权不在本报告：红→绿证据全部可复跑，结论请以测试工程师独立验证为准

---

## 1. 真实调用链（行号已按当前工作区重新定位）

### FIX-P07：本地模式「配置模型」步没有可选项

| 环节 | 位置 | 一句话说明 |
|---|---|---|
| ① 共享模型数据源 | `desktop/renderer/src/lib/api.js:203-204` | `globalProviders()` 在 `localMode` 下**恒返回 `[]`**（离线静默降级，设计如此） |
| ② 本机 provider 数据源 | `desktop/renderer/src/lib/api.js:157-159` | `providers()` → `localProviders()` → 本机数据库 / `~/.mjcode/models.json`，本地模式只返回这一份 |
| ③ App 层引用 | `desktop/renderer/src/App.jsx:52-53`、`:363-370` | `loadData()` 把 `providers()` 结果存进 `userProviders` |
| ④ App → 向导传参 | `desktop/renderer/src/App.jsx:392` | `<Onboarding userProviders={userProviders} …>` 已把本机 provider 列表传进向导 |
| ⑤ 向导消费（缺陷点） | `desktop/renderer/src/components/Onboarding.jsx:41`（修复前） | `userProviders` **只出现在函数入参解构里**，组件体内零引用；模型步的可选项只从 `globalProviders` 派生 |
| ⑥ 后果 | 同上，模型步渲染分支 | 本地模式下可点选模型 = 0，只剩 Name / Base URL / API Key / Model ID 四个手填字段 |

> 审计原文的 `api.js:204` 仍准确（本文件未被此前的行号漂移影响）；`Onboarding.jsx` 侧的缺陷是「传了但不用」，不是「入口为空」——入口已由 P1-22 收敛为离线隐藏。

修复前实测（可复跑）：

```bash
cd desktop && rg -n "userProviders" renderer/src/components/Onboarding.jsx
# 41:export default function Onboarding({ globalProviders, userProviders, onFinish, ... })
# （仅此 1 处 —— 组件体内零消费）
```

### FIX-P04：定时 / 无人值守通道拿不到团队能力

| 环节 | 位置 | 一句话说明 |
|---|---|---|
| ① 任务声明 | `desktop/main/scheduler.js:352` | 到点执行时把 `t.team_id` 作为 `teamId` 传给 `runAgentTask` |
| ② 装配入口 | `desktop/main/main.js:1208` | `scheduledTeam.prepareScheduledRun({...})` 统一装配军团/会话/记忆 |
| ③ 团队上下文 | `desktop/main/scheduledTeam.js:257-272`（修复后） | 修复前：context 只给工具工厂、**不回传 runAgent** |
| ④ 引擎通告开关 | `desktop/agent-core/index.js:2828` | `if (teamContext && !customTools) → effectiveBaseTools = [... , ...TEAM_TOOLS]`（**只在 runAgent 收到 teamContext 时**才通告 `team_list_members` 等 schema） |
| ⑤ 工具表装配 | `desktop/main/main.js:1247`（修复后） | 修复前写成 `...(schedCtx.teamTools ? { teamTools: schedCtx.teamTools } : {})` —— 这是往映射里塞一个**没人认识的键** `teamTools`，而不是把工厂的 5 个工具名展开进映射 |
| ⑥ 工厂契约 | `desktop/main/scheduledTools.js:97-107`、`:25` | `scheduledToolHandlers({ teamTools })` 才会展开 `teamListMembers / teamSendMessage / teamBoard / teamWait / teamReadMessages` 五个键 |

两处断点叠加的后果：`team_*` **schema 不出现**（引擎侧）+ **handler 也不存在**（映射侧）⇒ 定时任务里的模型既不知道也不调不到团队协同；`orchestrate_task` 只有在声明了 `team_id` 时才走 `schedCtx.teamHandler`（团队语义），否则走匿名 Worker 组——与审计描述一致。

---

## 2. 修复前失败实测（红）

### FIX-P07

```bash
cd desktop && node test/onboarding-local-models.test.mjs
```

```
[FAIL] 本地模式：本机已配置的 2 个模型可直接点选（不再只有 4 个手填字段） — 可点选模型条目应为 2，实际 0
0 !== 2
[PASS] 本机无 provider 时：手填表单仍在（全新安装不被卡死）
[PASS] 有共享模型时：共享模型入口仍渲染（不回归在线态）
[FAIL] 共享模型与本机模型并存时：本机 2 条可选，共享入口仍在 — 本机可点选模型应为 2，实际 0
2/4 通过
```

该套件用**真实 SSR 渲染**（esbuild 打 bundle + `react-dom/server`，无 jsdom），把 `Onboarding`
的 `step` 初值种到 1（配置模型步）再数可点选条目——不是源码 grep 的间接证明。

### FIX-P04

```bash
cd desktop && node test/scheduled-team-tools.test.mjs
```

```
[FAIL] 声明了 team_id：runParams 必须带 teamContext（否则引擎不通告 TEAM_TOOLS）
       — runParams 缺 teamContext —— 引擎不会追加 team_* schema（当前键：messages,memories）
[FAIL] main.js 定时通道：teamTools 传入 scheduledToolHandlers，而不是当映射键
       — 定时通道调 scheduledToolHandlers 时必须传 teamTools（否则 5 个 team_* 键永远不会出现在映射里）
[PASS] 声明了 team_id：握手后 handler 映射含 5 个 team_* 键，且名册可读   ← 工厂本身没坏，坏在接线
[PASS] 未声明 team_id：不注入 teamTools / teamContext（不静默升级为团队执行）
[PASS] team_id 指向不存在的团队：直接抛错（不悄悄跑成匿名组）
3/5 通过
```

---

## 3. 修复内容（diff 概要）

### FIX-P07（4 文件，净增约 105 行）

| 文件:行 | 改动 |
|---|---|
| `desktop/renderer/src/components/Onboarding.jsx:50-56` | 新增 `selectedLocal` / `showNewForm` 两个状态 |
| `…/Onboarding.jsx:108-123` | `localChoices`：把 `userProviders` 拍平成 `{providerId, providerName, baseUrl, modelId, displayName}`（兼容 `model_id` / `modelId` 双轨字段）；零新增网络请求 |
| `…/Onboarding.jsx:196-207` | `confirmLocal()`：连通测试 → `rememberModel()` → 下一步（不重复落库，不碰凭证存储） |
| `…/Onboarding.jsx:172-178` | 手填路径保存成功后同样 `rememberModel()` + 记为已选（两条路径语义一致） |
| `…/Onboarding.jsx:259-261` | `onFinish` 回传 `model: { providerId, modelId }` |
| `…/Onboarding.jsx:348-410` | 模型步（`mode==='custom'`）改为：本机模型**单选组**（`input[type=radio]` + `label`，`data-onboarding-model-option` 供门禁读取）→ 有则默认展开；手填表单降级为「改用新的 API Key」次级入口；无本机模型时手填仍是主路径 |
| `desktop/renderer/src/lib/appState.ts:82-100` | 新增 `pickOnboardingModel(providers, {providerId, modelId})` 纯函数：解析不到就返回 null（绝不构造半截模型）。放在这里而不是 App.jsx 内联，是因为 `App.jsx` 已贴着 800 行软档（`max-lines` 门禁） |
| `desktop/renderer/src/App.jsx:396` | `onFinish` 消费 `extras.model` → `setSelectedModel(... || selectedModel)`，让向导里选的模型成为**首聊的当前模型**（否则只是界面高亮）。净增 1 行，App.jsx 799 raw 行 |
| `desktop/renderer/src/i18n/locales/{zh-CN,en-US}/onboarding.json` | 新增 6 个键（`localModel` / `localModelHint` / `useNewProvider` / `useExistingModel` / `newProviderHint` / `pickLocalModel` / `localModelTestFailed`，两侧同键集） |

设计取舍：
- **不新增任何外部网络请求**：选项全部来自 App 已加载的 `api.providers()`（本机数据库 / models.json）。
- **不动审批与凭证存储**：选的只是已存在的 provider，连接测试沿用既有 `window.mjcode.chat` 直连。
- 用 `label + input[type=radio]` 而非一排 `<button>`：单选集合的语义由原生控件承载（键盘/读屏可用），
  也不用为「新增 5 个裸 button」去抬高 `ui-conventions` 的 ratchet 基线。
- 顺带把该步原有的 3 个裸 `<button>` 收敛到 `ui/Button` 原语（同一处 UI 重构的自然产物）：
  `ui-conventions` 的裸 button 计数 255 → **252**（只降不升）。

### FIX-P04（2 文件 + 2 处测试断言放宽，净增约 20 行）

| 文件:行 | 改动 |
|---|---|
| `desktop/main/scheduledTeam.js:253-272` | 把团队上下文提为具名 `teamContext`，同时交给工具工厂与 `runParams`——**同一份对象**，不复制第二份实现 |
| `desktop/main/scheduledTeam.js:284` | `runParams: { messages, memories, teamContext }`（引擎据此通告 `TEAM_TOOLS` 与协同提示段） |
| `desktop/main/main.js:1243-1247` | 删掉把 `teamTools` 当映射一级键的写法；改为 `scheduledToolHandlers({ unattended: true, contextCwd: schedModel.cwd, teamTools: schedCtx.teamTools })` |
| `desktop/test/scheduled-tool-surfaces.test.mjs:121-131` | 源码形状断言放宽括号位置（原因见 §5），并**新增**一条「定时通道必须把 teamTools 传给工厂」 |
| `desktop/test/scheduled-orchestrate.test.js:39-45` | 同上（窗口 600 与语义不变，只允许实参多一个键） |

---

## 4. 修复后通过实测（绿）

```bash
cd desktop && node test/onboarding-local-models.test.mjs
```
```
[PASS] 本地模式：本机已配置的 2 个模型可直接点选（不再只有 4 个手填字段）
[PASS] 本机无 provider 时：手填表单仍在（全新安装不被卡死）
[PASS] 有共享模型时：共享模型入口仍渲染（不回归在线态）
[PASS] 共享模型与本机模型并存时：本机 2 条可选，共享入口仍在
4/4 通过
```

```bash
cd desktop && node test/scheduled-team-tools.test.mjs
```
```
[PASS] 声明了 team_id：runParams 必须带 teamContext（否则引擎不通告 TEAM_TOOLS）
[PASS] 声明了 team_id：握手后 handler 映射含 5 个 team_* 键，且名册可读
[PASS] main.js 定时通道：teamTools 传入 scheduledToolHandlers，而不是当映射键
[PASS] 未声明 team_id：不注入 teamTools / teamContext（不静默升级为团队执行）
[PASS] team_id 指向不存在的团队：直接抛错（不悄悄跑成匿名组）
5/5 通过
```

第二条套件里 `teamListMembers()` 的真实返回（证明名册可读，不是空壳）：

```
{"ok":true,"team":{"teamId":"team-1","name":"内容军团","description":"写作与审核"},
 "me":null,"leadMemberId":"m1",
 "members":[{"memberId":"m1","name":"主管","roleKind":"lead","isLead":true,"enabled":true,"toolNames":[]},
            {"memberId":"m2","name":"写手","roleKind":"member","isLead":false,"enabled":true,"toolNames":[]}]}
```

---

## 5. 受影响的既有测试及其状态

| 套件 | 结果 | 说明 |
|---|---|---|
| `test/onboarding-local-models.test.mjs` | 4/4（新增） | 本轮回归门禁（修复前 2/4） |
| `test/scheduled-team-tools.test.mjs` | 5/5（新增） | 本轮回归门禁（修复前 3/5） |
| `test/ui-conventions.test.js` | 13/13 | 裸 button 255 → 252（只降不升，未改基线） |
| `test/i18n.test.mjs` / `i18n-placeholder` / `i18n-gates` | 7/7 · 3/3 · 11/11 | 新增 6 键两侧同键集、零裸中文残留 |
| `test/no-new-jsx.test.js` | 4/4 | — |
| `test/scheduled-tools.test.mjs` | 16/16 | — |
| `test/tool-registration-matrix.test.mjs` | 164/164 | 登记矩阵未受影响 |
| `test/scheduled-tool-surfaces.test.mjs` | 11/11 | 断言调整见下 |
| `test/scheduled-orchestrate.test.js` | 8/8 | 断言调整见下 |
| `test/team-tools.test.mjs` | 85/85 | — |
| `renderer npx tsc --noEmit` | 通过（无输出） | — |
| `eslint`（改动文件） | 0 error | 仅 1 条**既有** warning：`Onboarding.jsx:2 'api' is defined but never used`（本轮前就存在，未扩大） |
| `desktop/test` 全量 `npm test` | **295 · 通过 292 · 失败 0 · 跳过 3** | 见文末「全量套件读数」 |

**关于改动两处既有断言（必须明说的判断依据）**：
`scheduled-tool-surfaces` 与 `scheduled-orchestrate` 里两条断言是**源码形状代理**——它们要求
`scheduledToolHandlers({ unattended: true, contextCwd: schedModel.cwd })` 的字面形态（实参恰好两个键、
紧接闭括号）。FIX-P04 必须在该实参里再加一个 `teamTools`，因此这两条会假红。

判断依据（是否「把缺陷固化成了预期」）：
- 这两条守的是「定时通道传了 unattended/contextCwd」「工具表里有 orchestrateTask」，**不是**守
  「团队工具不存在」——缺陷（teamTools 被当成映射键）从未被它们表达过。
- 因此处理方式不是放宽语义，而是：括号位置放宽为 `[^}]*`（允许实参多键）+ `scheduled-orchestrate`
  保留 600 字符窗口与「同段装配内既有基础 spread 又有 orchestrateTask」的语义 + `scheduled-tool-surfaces`
  **新增**一条更强的断言「定时通道必须把 teamTools 传给工厂」。
- 如果谁把 `teamTools` 又搬回映射一级键，`test/scheduled-team-tools.test.mjs` 的第 2/3 条会直接判红
  （它读的是真实 `prepareScheduledRun` 返回值与 `runScheduledAgentTask` 的实参括号，不依赖这两条形状断言）。

**另外三处机械同步（不改语义，均为仓库既有流程要求的）**：

| 门禁 | 触发原因 | 处置 |
|---|---|---|
| `test/ui-conventions.test.js` 的 `rawButton` 基线 255 → **252** | 我把该步裸 button 收敛到 `ui/Button` 后实际计数降到 252，而 `legacy-ledger` 要求「台账总数 === 基线」 | **向下**调基线（ratchet 只降不升，属允许方向），并在基线注释里追加本轮说明 |
| `docs/harness-r7/legacy-ledger.json` + `存量收敛台账.md` | 裸 button 255→252、`Onboarding.jsx` 分组 31→28 | 按仓库流程 `node scripts/gen-legacy-ledger.mjs --write` 现算写入，并在「变更记录」追加一行说明本批处置、§4 目标里的 255/31 同步改 252/28 |
| `docs/MJCode-技术设计文档-2026-10-17.md`（4 处数字） | 新增 2 个套件（288→290）、`main.js` raw 2236→2239（+3 行注释）、`npm test` 总计/通过数 | 按 `doc-fact-check` 报出的漂移逐条更新（不碰其它 288 等无关数字） |

---

## 6. 装配点核对表（FIX-P04 要求）

「同一能力常有 2+ 装配点」——本轮把 `team_*` 的全部落点核了一遍：

| # | 装配点（文件:行） | 通道 | 团队工具注入 | 引擎 teamContext | 结论 |
|---|---|---|---|---|---|
| 1 | `main/main.js:1095` `createToolHandlers` → `...scheduledToolHandlers()` | 交互式会话（`agent:run`） | 不注入（无参） | 由渲染层 payload 决定，不带 teamContext | **不需要改**：交互主会话不是团队成员 run；团队协同工具按设计 fail-closed 到「成员上下文」（`teamTools.js:151-156`）。改它会放开「无成员身份的 run 读写总线」，与设计约束 §9.1 冲突 |
| 2 | `main/main.js:1247`（`runScheduledAgentTask` 的 `runAgent.toolHandlers`） | **定时 / 无人值守** | **本轮修**：`teamTools: schedCtx.teamTools` | **本轮修**：经 `runParams.teamContext` | ✅ 覆盖 |
| 3 | `main/main.js:1525`（Worker 工厂 `createToolHandlers`） | 编排 Worker（成员任务） | 已有：`teamTools: teamContext ? createTeamToolHandlers(...) : null` | 已有：`workerPool.js:402` `teamContext` 进 `runOpts` | ✅ 早已覆盖（本轮只做核对，未改） |
| 4 | `main/main.js:923` `createScheduledReplay({ getHandlers: scheduledToolHandlers })` | 待确认动作重放 | 不注入 | 不涉及 | **不需要改**：`scheduledReplay.js:12,27` 只重放 `git_commit / git_add / shell` 三个审核过的子集，团队工具不在待确认动作里 |
| 5 | `main/engineProcess/childEntry.js:108`（子进程引擎 `runAgent`） | 子进程引擎宿主 | 由主进程 `toolHandlers` RPC 提供 | `...params` 原样透传 | **当前不需改**：定时通道走 in-process `agentCore.runAgent`（`main.js:1217`），不经子进程。若将来把定时通道切到 `engineHost`，`teamContext` 是纯可序列化对象，`...params` 会原样带过去 —— 记为观察项 |
| 6 | `main/agentRunner.js:642/654`（交互 run 引擎入口） | 交互式 | 见 #1 | 由 payload 决定 | 不需要改（同 #1） |

「成员名册」两个层面均已具备：prompt 层 = `buildTeamBrief(resolved)`（`scheduledTeam.js:68-80`，P1-6 既有）；
工具层 = `team_list_members`（`teamTools.js:169-181`，本轮修好通路后才真正对模型可见）。

---

## 7. 剩余风险与未做项

1. **FIX-P07 的浏览器视觉未实机核验**：本轮证据是 SSR 静态 HTML + 门禁，没有 Electron 真机截图。
   风险点：`max-h-[228px] overflow-y-auto` 在多 provider 情况下的滚动表现、`Button size="md"`（h-8）
   与相邻文本按钮的行高观感。建议测试工程师在真机上点一次「配置模型」步（有 1~2 个本机 provider 的情形）。
2. **FIX-P07 只覆盖「已有本机 provider 的用户」**：全新安装（0 provider、0 共享模型）仍是手填表单 ——
   这是**有意保留**（没有可选项就不该造假选单）。审计里「首聊无可用模型」对全新用户依然成立，
   但那是「没配置过模型」的正常状态，不是缺陷；若产品要求内置免 Key 默认模型，属另一条需求。
3. **`selectedLocal` 不随 provider 列表刷新复位**：若用户在向导里选了一个模型后，主进程侧该 provider
   被删除（极端并发），`extras.model` 会在 App 侧 `find` 不到而被静默忽略（回落启动默认模型）。
   行为安全（不会崩），但属可观测性缺口，未加提示。
4. **定时通道的 `teamContext.memberId = ''`**：`team_send_message` 的作者为匿名（`me: null`）。
   `teamListMembers / teamBoard / teamWait / teamReadMessages` 不受影响；发言留痕会缺作者 id。
   这属于「定时任务没有单一成员身份」的语义问题（应记为本任务所属成员还是「宿主」），
   需要产品决策，本轮未擅自改动（改错会污染总线的作者归属与审计链）。
5. **未跑真机端到端**：没有创建真实定时任务 + 团队 + `team_id` 跑一轮来观察 trace 里是否出现
   `team_list_members` 调用。可复现路径：建一个团队 → 建定时任务并绑 `team_id` → 手动 `runScheduledTask`
   → 看 `runTrace` 是否含 team 工具事件。**这是最值得测试工程师补的一条**（本轮只到装配层）。
6. **未提交 git**：按要求留给主理人统一处理。工作区当前改动文件见 §3；另有一份 `docs/…-2026-10-24.md`
   的改动**不是本人工件**（他人并行修改，未触碰）。

---

## 附：本轮改动文件清单

```
M desktop/main/main.js                                   （FIX-P04 接线）
M desktop/main/scheduledTeam.js                          （FIX-P04 teamContext）
M desktop/renderer/src/App.jsx                           （FIX-P07 回灌选择，净 +1 行：799 raw，守住 800 软档）
M desktop/renderer/src/lib/appState.ts                   （FIX-P07 新增 pickOnboardingModel 纯函数）
M desktop/renderer/src/components/Onboarding.jsx         （FIX-P07 主体）
M desktop/renderer/src/i18n/locales/zh-CN/onboarding.json
M desktop/renderer/src/i18n/locales/en-US/onboarding.json
M desktop/test/scheduled-tool-surfaces.test.mjs          （形状断言放宽 + 收紧一条，理由见 §5）
M desktop/test/scheduled-orchestrate.test.js             （同上）
M desktop/test/ui-conventions.test.js                    （rawButton 基线 255→252，向下）
M docs/harness-r7/legacy-ledger.json                     （生成器 --write）
M docs/harness-r7/存量收敛台账.md                        （变更记录 + §4 目标同步）
M docs/MJCode-技术设计文档-2026-10-17.md                  （doc-fact-check 报出的 4 处数字漂移）
A desktop/test/onboarding-local-models.test.mjs          （新增回归门禁；RB-1 后计数口径改为 radio）
A desktop/test/scheduled-team-tools.test.mjs             （新增回归门禁；RB-1 后改为行为断言）
A desktop/test/onboarding-model-apply.test.mjs           （RB-1 新增：pickOnboardingModel + App 回写接线）
A docs/fix-batch1-coder-report.md                        （本报告）
```

> RB-1 返工对**实现代码**的净改动只有两处：`appState.ts` 的 `pickOnboardingModel` 加数组判定（修崩溃）、
> `App.jsx` 的回写写法改为「解析到才 set」（行数不变）；`Onboarding.jsx` 删掉无消费者的 `data-*` 属性一行。
> `main/main.js` 在 RB-1 期间**零改动**。

> 说明：`git status` 里还有一份 `docs/MJCode-深度审查流水线-…-2026-10-24.md` 的改动，
> **不是本人工件**（并行会话在改），我未触碰、也未纳入上面的清单。

## 全量套件读数（2026-10-24 本轮最终，含 RB-1 返工）

```bash
cd desktop && npm test
```
```
──────── 测试基线汇总 ────────
总计 296 · 通过 293 · 失败 0 · 跳过 3
```
四元组：**总 296 = 过 293 + 败 0 + 跳 3**（跳过 3 条为平台限制：非 Linux 无 bwrap / sandbox-exec 探测，与本批改动无关）。

```bash
cd desktop && npm run typecheck     # → tsc --noEmit，退出码 0
```

> 曾出现的三条失败（`doc-fact-check` / `legacy-ledger` / `max-lines`）已按 §5 的机械同步转绿；
> RB-1 返工新增 1 个套件（`onboarding-model-apply`）后套件数 290→291、`npm test` 295→296，
> 设计文档数字已再次同步（`doc-fact-check` 现算 → 绿）。

---

# RB-1 返工记录（2026-10-24，来源：独立验证报告）

实现未被判错，返工只针对 **D1 断言强度** 与 **D2 覆盖缺口**。以下每条都附变异实测。

## RB-1 / D1：`scheduled-team-tools` 改为行为断言

### 改了什么（文件:`desktop/test/scheduled-team-tools.test.mjs`）

| 旧（被验证方证伪） | 新 |
|---|---|
| 一条正则式断言：检查 `main.js` 的实参文本里是否出现 `teamTools:` **键名**，不校验值 ⇒ `teamTools: null` 仍然绿 | ① 从 `main.js` 的 `runScheduledAgentTask` 里**抽出真实的 toolHandlers 对象字面量源码**（括号配对扫描，跳过字符串/注释），用 `new Function` 注入依赖求值，得到生产代码自己产出的工具表；② 断言 5 个 `team_*` handler 是**可调用函数**且 `teamListMembers()` 真能取到 2 名成员名册；③ 把该表交给 `agent-core` 的 `runAgent({ teamContext })`，用脚本化 chat 桩抓下发给模型的 `tools` 列表，断言 5 个 `team_*` schema **确实在模型可见工具表里**（可用性闸按 handler 是否存在剔除，缺 handler 会被下架）；④ 让模型真发起 `team_list_members` 调用，断言 `tool` 消息里带出名册内容、且**不含**「通道不可用/未知工具」 |

为什么用「抽源码求值」而不是「照抄一份装配」：照抄就是自指判据——`main.js` 改成 `teamTools: null` 也不会红。抽取器有 fail-loud 守卫（找不到 `runScheduledAgentTask` / `toolHooks.wrap(sguard.wrap(` / `scheduledToolHandlers(` 任一处即报「结构变了，需同步抽取器」），不会静默空过。

### 变异实测（D1）

```bash
# 1) 变异：把 main.js 的 teamTools 实参改成 null（团队能力全灭）
cd /Users/jianma/Desktop/MJCode && python3 -c "..."   # s/teamTools: schedCtx.teamTools/teamTools: null/
cd desktop && node test/scheduled-team-tools.test.mjs
```
```
[FAIL] main.js 定时装配产出：5 个 team_* handler 存在且真能取到名册 — main.js 装配产出的工具表缺 teamListMembers（模型看不到也调不到）
[FAIL] 引擎通告面：5 个 team_* schema 出现在下发给模型的 tools 里，且调用能穿透到 handler — 模型可见工具表缺 team_* schema：team_list_members,team_send_message,team_board,team_wait,team_read_messages（实际 25 个工具）
3/5 通过
```

```bash
# 2) 还原后：套件回绿，且 main.js 的 diff 与本轮修复前完全一致（无变异残留）
cd /Users/jianma/Desktop/MJCode && cp /tmp/main.js.bak desktop/main/main.js
git diff --numstat -- desktop/main/main.js      # 变异前 = 6 3；还原后 = 6 3（同一份 FIX-P04 diff）
cd desktop && node test/scheduled-team-tools.test.mjs   # → 5/5 通过
```

> 关于「还原后 numstat 为 0」：`main.js` 在本批里本来就有 FIX-P04 的合法改动（6 增 3 删 = 净 +3 行注释，
> 未新增代码行），因此 numstat 不可能是 0；我用「变异前/还原后 numstat 完全一致 + `git diff -U0` 里只有
> FIX-P04 那三处」来证明变异无残留。若主理人要求 main.js 对本批零 diff，需要把装配抽到独立模块——那会
> 引入比缺陷更大的重构面，本轮不做（S3 也要求返工不再动 main.js 行数）。

## RB-1 / D2：补「选定值回写 `selectedModel`」覆盖

### 新增 `desktop/test/onboarding-model-apply.test.mjs`（8/8）

① `pickOnboardingModel` 纯函数 6 类边界（`appState.ts` 用渲染层 esbuild 打 CJS 后直测）：
1. 本地模式有 `userProviders` → 命中并返回 `selectedModel` 形状；
2. 无 provider（`null` / `[]` / `undefined`）→ `null`；
3. 模型列表为空 / 字段缺失 / `models` 非数组 → `null`（**顺带修掉实现里一处真 bug**：原写法
   `(p?.models || []).find(...)` 在 `models` 是字符串时直接抛 `find is not a function`，首启流程会崩；
   已改为 `Array.isArray(p?.models) ? ... : []`，由本套件第 3 条守住）；
4. 选中值不在列表内 → `null`，且**不得跨 provider 捞同名模型**（`providerId=p2 + modelId=p1 的模型` 必须 `null`）；
5. 多 provider 按 id 命中，列表顺序颠倒结果一致；
6. 空字符串 / 缺字段的选择 → `null`（不把 `""` 当有效 id）。

② App.jsx 回写接线：从 `App.jsx` **抽出那条真实语句**（去行尾注释后整体求值，允许一行两条语句），
注入 `extras / userProviders / selectedModel / setSelectedModel / pickOnboardingModel` 执行，断言：
- `extras.model` 有效 ⇒ `setSelectedModel` 被调用 **1 次**且拿到的是解析出的 `{provider, model}`；
- 解析不到（未选 / `model:null` / provider 不存在 / 模型不存在 / 本机无 provider）⇒ **完全不调用**
  `setSelectedModel`（保持原选择，不切到 `null`，也不跨 provider 乱命中）。
- 抽取器带守卫：正则式校验「取值来源仍是 `extras?.model` 经 `pickOnboardingModel` 解析」，否则报红。

> 这条也顺手改了接线写法本身：原为 `setSelectedModel(pick(...) || selectedModel)`——解析不到时会用
> **同一个值**再 setState 一次（React 会 bail out，但语义上「调了但没变」不好断言，也容易掩盖错值）。
> 现为 `const pickedModel = pick(...); if (pickedModel) setSelectedModel(pickedModel);`（同行两条语句，
> `App.jsx` 行数不变：799 raw），于是测试可以断言「不调用」这个更强性质。

### 变异实测（D2）

```bash
cd /Users/jianma/Desktop/MJCode && cp desktop/renderer/src/App.jsx /tmp/App.jsx.bak
# 删掉回写那一行
cd desktop && node test/onboarding-model-apply.test.mjs
```
```
[FAIL] ② 接线：extras.model 有效 ⇒ 真的调用 setSelectedModel（新模型生效） — App.jsx 里找不到 `setSelectedModel(pickOnboardingModel(...))` —— 向导选定的模型不会成为首聊模型
[FAIL] ② 接线：解析不到 ⇒ 不调用 setSelectedModel（保持原选择，不切到 null） — 同上
6/8 通过
```
```bash
# 还原
cd /Users/jianma/Desktop/MJCode && cp /tmp/App.jsx.bak desktop/renderer/src/App.jsx
git diff --numstat -- desktop/renderer/src/App.jsx     # 变异前 2 1；还原后 2 1（同一份 FIX-P07 diff）
cd desktop && node test/onboarding-model-apply.test.mjs  # → 8/8 通过
```

## RB-1 / S1：计数口径去自指（改 `onboarding-local-models.test.mjs`）

`countOptions` 从「数本轮自己加的 `data-onboarding-model-option` 属性」改为「数 `<input type="radio">` 原生单选控件」
（= 用户真实的可选项个数），并把组件里的 `data-*` 属性**删除**（它已无消费者）。

变异实测（证明新口径不自指）：

```bash
# 删除组件里的单选控件（模拟「选项退化成不可选文本」）
cd desktop && node test/onboarding-local-models.test.mjs
```
```
[FAIL] 本地模式：本机已配置的 2 个模型可直接点选（不再只有 4 个手填字段） — 可点选模型条目应为 2，实际 0
[FAIL] 共享模型与本机模型共存时：本机 2 条可选，共享入口仍在 — 本机可点选模型应为 2，实际 0
2/4 通过
```
还原后 4/4 通过，`Onboarding.jsx` numstat 变异前后同为 `102 18`（无残留）。

## RB-1 约束遵守情况

| 约束 | 结论 |
|---|---|
| **S1** 不依赖新增 `data-*` 属性 | ✅ 改为数 `input[type="radio"]`，并删除该属性；变异实测 2/4 |
| **S3** 返工不增加 `main.js` 行数 | ✅ 本轮返工对 `main.js` **零改动**（变异后已完整还原，`wc -l` 仍 2239 raw；`git diff --numstat` 恒为 6/3，与返工前一致） |
| **禁止改既有断言期望值来让新测试变绿** | ✅ 本轮未修改任何既有断言；`ui-conventions` 基线仍 252（未再下调），`legacy-ledger` 20/20 未动 |
| 跑 `npm test` + `npm run typecheck` 并报四元组 | ✅ 总 296 = 过 293 + 败 0 + 跳 3；typecheck 退出码 0 |
| 不提交 git | ✅ 未提交 |

## RB-1 期间的额外产出（都是测试自己逼出来的，不是主动扩范围）

1. **修掉 `pickOnboardingModel` 一处真崩溃**：`models` 为上架外形状（字符串）时 `.find` 抛异常 ⇒ 首启流程崩。
   由 D2 第 3 条用例暴露，已改为数组判定（`appState.ts`）。
2. **接线写法改成「解析到才 set」**：让「不调用」这一性质可断言（详见 D2 说明），`App.jsx` 行数不变。
3. 新增套件使套件数 290→291，设计文档 3 处数字再次同步（`doc-fact-check` 现算绿）。

## RB-1b（收到复验判据清单后的加固，2026-10-24）

验证方给了「复验时会怎么打」的 4 条判据，逐条对齐后补了两处：

### 补齐 D2 的三个覆盖点
1. **对象引用**（原缺）：`pickOnboardingModel` 命中时必须返回列表里的**同一引用**（不是副本），
   已加 `assert.equal(r.provider, PROVIDERS[0])` / `assert.equal(r.model, PROVIDERS[0].models[1])`。
   理由：副本会让「选中态」与列表项脱钩，`rememberModel` 的记忆键也对不上。
2. **`Onboarding.finish()` 出口**（原缺，属真空白）：新增 2 条——抽出 `finish()` 源码求值（注入
   `pickedSkills/pickedConnectors/employees/selectedLocal/onFinish/...` 全部绑定），断言
   `onFinish` 收到的 `extras.model === {providerId, modelId}`；未选模型时 `=== null`（不回写半截值）。
3. **App 接线**：形态说明——为了能断言「解析不到 ⇒ **完全不调用** setter」这一更强性质，接线写成
   同一行两条语句：`const pickedModel = pickOnboardingModel(userProviders, extras?.model); if (pickedModel) setSelectedModel(pickedModel);`
   。按字面 grep `setSelectedModel(pickOnboardingModel(` 搜不到（这是有意的，不是漏）。判据按「删掉/改成不调用必红」验：
   - 删整行 → `8/10`，exit=1
   - 保留 pick、去掉 setter 调用 → `8/10`，exit=1
   - 删掉 `finish()` 的 `model` 字段 → `8/10`，exit=1
   - 还原 → `10/10`，exit=0（App.jsx numstat 恒 2/1，Onboarding 恒 102/18）

### 顺手修掉的一处测试自身假绿（重要）
本套件的 `check()` 原本是**同步**函数，async 用例的 reject 会漏成 unhandled rejection：
实测「删掉 finish 的 model 字段」时，先打印 `10/10 通过`、之后进程才崩（汇总已假绿）。
已改为 `async function check()` + 全部 `await check(...)`。现在任何 async 断言失败都当场 `[FAIL]` 且 exit=1。

## RB-1b 复验命令与读数（可直接复跑）

```bash
cd desktop && npx eslint main/main.js \
  --rule '{"max-lines":["error",{"max":1,"skipBlankLines":true,"skipComments":true}]}'
# → File has too many lines (1500)   ← 与本批 HEAD 一致（HEAD 版实测同为 1500），本轮净增代码行 = 0
```
```bash
cd /Users/jianma/Desktop/MJCode && git diff --numstat -- desktop/main/main.js
# → 6	3	desktop/main/main.js   （= FIX-P04 三处：3 行注释 + 2 处替换，代码行净 0）
```

## RB-1b 观察到的一次环境性假红（非代码问题）

13:41 的全量跑里 `harness-r7:check` 判红，但：
- 手动单跑 `node docs/harness-r7/04-test/check.mjs <repo>` → `PASS=76 FAIL=0`，**exit=0**（与 run-all 同 cwd / 同参数复现）；
- 紧接着 13:45 全量重跑 → `总 296 · 过 293 · 败 0 · 跳 3`；
- 该轮跑前/跑后对 5 个关键文件做 `shasum -c` 全部 `OK`（跑期间未被外部改动）。

最可能的原因：**并行会话在同一工作区做变异**，gate 扫描到瞬时被改的源码（**此归因已被下方订正推翻，勿单独引用本段**）。建议：全量跑与变异实验不要同时进行
（否则任何 gate 都可能随机红，读数不可信）。

> **订正（2026-10-24 22:0x，主理人，依据验证方证据）**：以上归因**不成立**。真实机制是
> **两个 `npm test` 同时在跑**，不是「变异撞扫描」。证据：① 该窗口内验证方未改动仓库任何文件
> （其探针走 esbuild `stdin`，零落盘）；② 报错是 `ENOENT .../renderer/src/__i18n_probe_7.jsx`，
> 而 `__i18n_probe_*` 由 `test/render-smoke.mjs:163` 生成——两个 run-all 并发时，
> 后启动的实例会删掉先启动实例正在用的探针文件，`legacy-ledger` 的「现算」与 `lint-gate`
> 的目录枚举因此失真。
> **正确纪律**：全量测试必须**单一 owner**，同一时刻只允许一个 `npm test`；隔离不同工具的
> 并发是本条的必要条件，不是充分条件。根治项见 S5（探针改 `os.tmpdir()` 或 esbuild `stdin` 零落盘）。

## RB-1 后仍存在的风险

1. `scheduled-team-tools` 的抽取器依赖 `main.js` 里 `toolHooks.wrap(sguard.wrap({...}))` 的书写形态：
   若将来把这段装配抽成独立模块或改写成变量，抽取器会 **fail-loud 报红**（报「结构变了，需同步抽取器」），
   不会静默空过——但需要改测试，属于可预期的维护成本。
2. `onboarding-model-apply` 的接线断言同样是「抽源码求值」：改成两行 if 块（而非一行两条语句）也能过
   （抽取器按行匹配 + 去注释 + 检查 `;` 结尾），但若改成多行块语句，需要更新抽取器（同样 fail-loud）。
3. 真机端到端仍缺口（同前一批遗留）：建团队 → 定时任务绑 `team_id` → 跑一轮 → 看 trace 里
   `team_list_members` 是否被调用。本轮证据到「装配 + 引擎通告 + 调用穿透」为止，未起 Electron。

---

# RB-2 现存假绿（2026-10-24，来源：验证方 espree AST 扫描 + 主理人开单）

这三条不是 spec 争议，是**可复现缺陷**：`check` helper 是同步函数却接收 async 回调 ⇒ `fn()` 返回 Promise（truthy）
⇒ 断言体里的失败退化成 unhandled rejection，而 `pass++` 已经发生。两个套件因此**连退出码都是 0**。

## 改前实测（三处探针，全部按验证方给的「原失败位置」插入 `assert.ok(false,'__PROBE__')`）

| 套件 | 探针插入点 | 改前输出 | 改前 EXIT |
|---|---|---|---|
| `test/diag-export.test.mjs` | `:127` async 回调体首行 | `[PASS] IPC diag:export 注册且失败不抛` + `diag-export: 13/13 通过` | **0**（完全假绿） |
| `test/web-todo-tools.test.js` | `:157` async 回调体首行 | `✅ P0-A 仅允许 http/https（拒绝 file:// 等协议）` + `PASS：25/25 项通过` | **0**（完全假绿） |
| `test/message-schema.test.js` | `:59` async 回调体首行 | `[PASS] 行为验证：驼峰 toolCallId 被转为蛇形` + `PASS：11/11 项通过` + 随后 `AssertionError` | 1（退出码兜住，但**汇总撒谎**） |

## 改动概要（只改 helper 与调用形态，零断言改动）

| 文件:行 | 改动 |
|---|---|
| `diag-export.test.mjs:18` | `function check` → `async function check`，`fn()` → `await fn()` |
| `diag-export.test.mjs` 13 处调用点 | 全部 `check(` → `await check(`（ESM，支持 top-level await） |
| `web-todo-tools.test.js:18` | 同上（`✅/❌` 方言） |
| `web-todo-tools.test.js:23` | `import(...).then((m) => {` → `.then(async (m) => {`，17 处调用点全部 `await check(` |
| `web-todo-tools.test.js:171` | 未改：`process.exit(fail === 0 ? 0 : 1)` —— await 到位后它读到的 `fail` 已可信 |
| `message-schema.test.js:24` | 同上（`[PASS]/[FAIL]` 方言） |
| `message-schema.test.js:35-132` | **CJS 无 top-level await** ⇒ 11 处调用点包进 `(async () => { … })().catch(...)`（`:132`）；catch 置 `process.exitCode = 1` |
| 三文件 diff 合计 | `17/15`、`22/20`、`20/14`（含注释），**未改任何 `assert.*` 期望值**（`git diff | rg "^[+-].*assert\."` 为空） |

## 改后实测（同一探针、同一位置）

```
diag-export.test.mjs      EXIT=1   [FAIL] IPC diag:export 注册且失败不抛 — __PROBE__
web-todo-tools.test.js    EXIT=1   ❌ P0-A 仅允许 http/https（拒绝 file:// 等协议） — __PROBE__
message-schema.test.js    EXIT=1   [FAIL] 行为验证：驼峰 toolCallId 被转为蛇形 — __PROBE__
```
⇒ 三处全部由「假绿」转为「当场红且 exit≠0」。

## RB-2-A 验收（主理人转达的 4 条判据，逐条实测）

| 判据 | diag-export | web-todo-tools | message-schema |
|---|---|---|---|
| ① `[FAIL]/❌ … __PROBE__` 出现 | ✔ | ✔ | ✔ |
| ① 同一条**不得**再出现 `[PASS]/✅` | ✔（0 次） | ✔（0 次） | ✔（0 次） |
| ② **汇总计数少一条** | `12/13 通过` | `FAIL：24/25 项通过` | `FAIL：10/11 项通过` |
| ③ 退出码 1 | ✔ | ✔ | ✔ |
| ④ 还原后与快照逐字节一致 | ✔（`shasum -c` OK） | ✔ | ✔ |

> 判据②比「exit≠0」更狠，它抓的是「打了 FAIL 但计数仍 +1」。本轮三处都是 `pass++` 只在成功分支，天然满足；
> `message-schema` 原本没 `fail` 变量、汇总前缀硬编码 `PASS：`，已补 `let fail` + `fail++` + 前缀改为
> `${fail === 0 ? 'PASS' : 'FAIL'}`（否则失败时计数对、**前缀撒谎**，主理人复核时点出的正是这条）。

## 三套件单跑（探针已删，不跑 run-all —— 批次 2 正占全量窗口）

```
diag-export.test.mjs      EXIT=0   diag-export: 13/13 通过        （条数与改前一致）
web-todo-tools.test.js    EXIT=0   PASS：25/25 项通过              （条数与改前一致）
message-schema.test.js    EXIT=0   PASS：11/11 项通过              （条数与改前一致）
```

## 还原证据（按主理人要求：不用 numstat）

每个探针文件还原后校验 `git hash-object <file>` == `git rev-parse HEAD:<path>`：
- 改前探针三次还原：`YES / YES / YES`
- 改后探针：见下方「一次自我纠错」——`git checkout --` 会把**修复一起还原**，故改为「重放修复」而非 checkout 还原

## 一次自我纠错（写进报告以免后人踩）

做「改后探针」时我用 `git checkout -- <三文件>` 收尾，结果把**刚做完的修复也一起还原了**（checkout 是无差别还原，
不是「只还原探针」）。发现后重新按同一脚本重放修复（幂等断言：`assert s.count(old)==1`），再复跑至 13/13、25/25、11/11。
⇒ 教训：**探针与修复在同一文件里时，还原手段必须是「反向替换探针」或「重放修复脚本」，不能用 checkout**。
（改前探针阶段用 checkout 是正确的——那时文件里只有探针。）

## 未做/留给后续

1. 未跑全量（按调度纪律：批次 2 占用窗口；且 `run-all` 单一 owner）。
2. 另有两类「抹掉证据」的结算写法**尚未修**，已在 S6 spec 里登记，属批次 3：无条件 `process.exit(0)`（10 个套件）、
   `process.exit(pass === total ? 0 : 1)`（约 25 个套件，只看计数不看 fail）。
3. S6 门禁本身（espree AST + 条件式判据 + `--unhandled-rejections=strict`）未落地，本单只做「修现存」。

## 交付期事件：三文件被外部 `git checkout` 还原过一次（2026-10-24 22:08）

修完并三套件全绿后，我发现三文件内容**回到 HEAD 原始版**（mtime `22:08:18`/`22:08:19`，`git hash-object == git rev-parse HEAD:<path>`），
HEAD 同时前进到 `336f931`（docs 提交）。判断是并行会话按「变异还原」习惯执行了 `git checkout -- <这些文件>`——
与 RB-1 期同型事故（**checkout 是无差别还原**）。

处理：用同一份幂等脚本**重放修复**（`SKIP(已修复)` 守卫，避免二次应用），随后在**交付版上重做改后探针**（三处仍 `EXIT=1`），
探针用**反向替换**删除（不用 checkout），删除后 blob 与交付指纹**逐字节一致**：

```
515360d8d96255d234bbfa168cbca45d886278c4  desktop/test/diag-export.test.mjs
c2fd1449939fbc06c53ced4577481f2e720d7492  desktop/test/web-todo-tools.test.js
1ac41b6cd6a4f4d4b10b2c5ca951a6ab70099bb4  desktop/test/message-schema.test.js
```

三套件终态：`13/13`、`25/25`、`11/11`，全部 `EXIT=0`。

⇒ 给并行会话的规则（再次）：**要还原探针，请反向替换或重放脚本；`git checkout --` 会连别人的修复一起抹掉。**
若要在这三个文件上做变异验证，请先看 mtime / blob 是否等于上面三个指纹，不相等说明有人的修复正躺在工作区。

---

## RB-2-B：无条件 `process.exit(0)` 归一（10 个真实目标）

`rg -l 'process\.exit\(0\)' test/*.test.*` 得 11 个，**`docs-consistency.test.mjs:21` 是注释**
（原文「改前写法：… `process.exit(0);`」），属正则假阳性 ⇒ 真实目标 **10 个**。

改法两阶段（**最终形态是两行式**，理由见下方「有效范围实测」）：
1. 先按主理人指定的单点改法：`process.exit(0)` → `process.exit(process.exitCode || 0)`（不动断言/计数/其它行）；
2. 实测发现单点改法**抓不住浮动 rejection** ⇒ 为满足验收③（「插浮动 rejection 后 exit 必须变 1」），
   10 个文件统一升级为两行式：`process.exitCode = process.exitCode || 0; setTimeout(() => process.exit(process.exitCode || 0), 0);`
   （保留强制退出语义——这些套件有开着的句柄/子进程，直接删 `exit()` 有挂死风险）。

| 文件 | 改点行 | 单跑（改后） |
|---|---|---|
| `memory-m4-hardening.test.mjs` | 122 | EXIT=0 · 6 组全部通过（改前同） |
| `memory.test.js` | 276 | EXIT=0 · 16 项全部通过（改前同） |
| `orchestrator-invoke.test.js` | 155 | EXIT=0 · 10 项全部通过（改前同） |
| `tools-cwd.test.js` | 203 | EXIT=0 · 全部通过（改前同） |
| `mcp-handshake.test.js` | 99 | EXIT=0 · 全部通过（改前同） |
| `memory-team.test.mjs` | 153 | EXIT=0 · 11/11（改前同） |
| `memory-scope.test.mjs` | 181 | EXIT=0 · 13 项全部通过（改前同） |
| `memory-salvage.test.mjs` | 177 | EXIT=0 · 7 组全部通过（改前同） |
| `orchestrator.test.js` | 211 | EXIT=0 · 10 项全部通过（改前同） |
| `memory-mem-command.test.mjs` | 103 | EXIT=0 · 5 项全部通过（改前同） |

### ⚠ 该改法的有效范围实测（重要：它**抓不住浮动 rejection**）

在 `memory-scope.test.mjs` 里插一条浮动 rejection（`(async () => { await new Promise(r => setTimeout(r, 0)); throw … })();`，模拟「被吞掉的 async check」），三种结算形态：

| 结算写法 | 浮动 rejection 下的 EXIT | 结论 |
|---|---|---|
| 改前 `process.exit(0)` | **0** | 被骗 |
| 改后 `process.exit(process.exitCode \|\| 0)`（指令指定） | **0** | **仍被骗**：`exit()` 会在 rejection 上报前截断进程 |
| 两行式 `process.exitCode = process.exitCode \|\| 0; setTimeout(() => process.exit(process.exitCode \|\| 0), 0);` | **1** | 抓住（先让事件循环跑完，再强制退出） |

> 最小复现（Node 22，与仓库同版本）：
> `printf 'Promise.reject(new Error("x"));\nprocess.exit(process.exitCode || 0);' > t.mjs && node t.mjs; echo $?` → **0**
> 换成 `process.exitCode = process.exitCode || 0;` → **1**
>
> ⇒ 指令里的单点改法**修复的是「exitCode 已被设为 1 却被 exit(0) 覆盖」这一类**（真实收益），
> 但对「漏网的异步失败」无效——那需要两行式或直接去掉 `exit()`。
> 两行式仍保留「强制退出」语义（这些套件有开着的句柄/子进程，直接删 `exit()` 有挂死风险），故推荐两行式。
> 已按验收③的要求铺开两行式（10 个文件各 +1 行）。若主理人更倾向「保留单点改法、把浮动 rejection 这条从验收划掉」，
> 回退成本为 10 处单行替换，随时可做。

### 最终读数（两行式，全部单跑，未跑 run-all）
| 文件 | EXIT | 条数（与改前一致） |
|---|---|---|
| memory-m4-hardening | 0 | 6 组全部通过 |
| memory.test.js | 0 | 16 项全部通过 |
| orchestrator-invoke | 0 | 10 项全部通过 |
| tools-cwd | 0 | 全部通过 |
| mcp-handshake | 0 | 全部通过 |
| memory-team | 0 | 11/11 |
| memory-scope | 0 | 13 项全部通过 |
| memory-salvage | 0 | 7 组全部通过 |
| orchestrator.test.js | 0 | 10 项全部通过 |
| memory-mem-command | 0 | 5 项全部通过 |

**剩余未改的无条件 `exit(0)`：0 个**（`docs-consistency.test.mjs:21` 命中在注释里，属正则假阳）。

### 两处浮动 rejection 前后对比（复核用；插法：`(async () => { await new Promise(r => setTimeout(r, 0)); throw new Error('__FLOAT__'); })();`）

| 套件 | 改前一版（`process.exit(0)`） | 两行式（交付版） |
|---|---|---|
| `memory-scope.test.mjs` | **EXIT=0**（被骗） | **EXIT=1** ✔ |
| `memory-team.test.mjs` | **EXIT=0**（被骗） | **EXIT=1** ✔ |

两处的还原均用快照回写 + `shasum -c` 校验；`memory-team` 还原后 blob `bf72404013a0` 与交付值逐字节一致，终态单跑 `11/11 EXIT=0`。

### 三种写法对照（含"为什么不选另外两种"）

| 写法 | 浮动 rejection 下 | 备注 |
|---|---|---|
| `process.exit(0)` | **0**（被骗） | 无条件结算，抹掉一切 |
| `process.exit(process.exitCode \|\| 0)` | **0**（仍被骗） | 同步 `exit()` 在 rejection 上报前截断进程；只修「exitCode 已是 1 却被 exit(0) 覆盖」这一类 |
| `process.exitCode = 0`（不删 exit，只置码） | **1** ✔ | 但依赖自然退出；这些套件有开着的句柄/子进程 ⇒ 有挂死风险 |
| **两行式** `process.exitCode = process.exitCode \|\| 0; setTimeout(() => process.exit(process.exitCode \|\| 0), 0);` | **1** ✔ | 先让事件循环跑完（rejection 得以上报），再强制退出（不挂死）——**采用** |

### 工具纪律（本轮全程遵守）
变异/探针**一律用内容快照**（`cp file /tmp/x.snap` + `shasum -a 1` 留底），还原用 `cp` 回写 + `shasum -c` 校验；
`git checkout --` 仅在 `git status --porcelain -- <file>` 为空时使用。原因：交付期三个套件曾被并行会话用 `git checkout --` 还原（见上文事件），
而 checkout 恢复的是 HEAD、不是「变异前状态」。
