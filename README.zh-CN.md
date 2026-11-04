# MJ Nexus

> 本地优先的桌面 AI Agent 工作台。你的文件、凭证与命令执行都留在本机——只有推理请求会发出去，
> 且发往你自己配置的模型服务。

[English](./README.md) · **简体中文** · [更新日志](./CHANGELOG.md) · [发行版](https://github.com/jasonma1210/MJWork/releases)

---

## 仓库构成

| 目录 | 作用 |
|---|---|
| `desktop/` | Electron 应用本体。`main/` 主进程（窗口、IPC、工具、沙箱、审批），`agent-core/` 无头 Agent 引擎（工具循环、模型适配、上下文预算），`renderer/` React 界面 |
| `desktop/shared/`、`shared-ipc/` | IPC 契约的唯一事实来源（通道名 + 载荷校验） |
| `ecosystem/` | 随包分发的产品资产：136 个技能、78 个 MCP 连接器、51 个数字员工角色模板；合计：51 个数字员工角色模板 = 265 项生态资产（136 技能 / 78 MCP 连接器 / 51 数字员工角色模板）。另有 214 条 WorkBuddy 原始清单仅作参考随包分发，**不计入**上述合计，且与精选清单**零重叠**。数字员工走 `rolePreset` 链路（目录预设 → 会话 → 每轮 agent:run 下发 → 宿主钳制），**不是**多员工编排；角色只能收紧权限、不能放宽。 |
| `server/` | 可选的自治服务端（Express + PostgreSQL）：账号、多端同步、云端委派 |
| `chrome-extension/` | 浏览器接管桥（CDP），每次连接都需在应用内单独授权 |
| `miniprogram/` | 微信小程序（配套入口） |
| `docs/` | 门禁实际读取、发版也确实要用的文档：技术设计文档、打包与安装指南、发布回滚与签名公证更新演练 Runbook |

## 已实现的功能

- **会真的动手的对话式 Agent** — 多轮工具调用，覆盖读写文件、Shell、补丁、网页抓取/搜索、Git；流式输出，可随时取消。
- **默认有护栏** — 四档审批，危险命令永远有硬地板；按平台沙箱隔离（macOS `sandbox-exec`、Linux bubblewrap、Windows 受限），判定不确定时一律按更严的一侧走（fail-closed）。
- **数字员工与团队派单** — 派一个目标，由角色 Agent 组执行任务组；项目级滑动配额 + 每一笔消耗都有台账可查。
- **用量工作台** — 按模型、按会话、按任务看 token 消耗，另有「用量流水」逐条对账。
- **本地知识库** — 导入 PDF/DOCX（扫描件走 OCR），本机分块建索引，回答时可引用。
- **产物生成** — 直接从对话里产出 `.docx` / `.xlsx` / `.pptx`。
- **定时任务** — cron 式定时执行并归档产出，不需要窗口开着。
- **MCP + 技能** — 可接 MCP 服务器，也可用内置 136 个技能，均按工作区隔离。
- **本地优先存储** — 会话、凭证、设置都在系统应用数据目录下的本地 SQLite 里。

## 浏览器接管（Chrome 会话）

除了自带的独立浏览器自动化（`browser_*`，起一个干净的无头环境），应用还能接管你本机**已登录**的 Chrome 标签页。

| 组成 | 位置 |
|---|---|
| 主进程工具 | `main/chromeTools.js` |
| 中继服务 | `main/chromeRelay/server.js`、`protocol.js` |
| 浏览器扩展 | `chrome-extension/`（Manifest V3，`tabs` + `debugger` 权限） |

- **逐次授权**：每次连接都要在应用内确认，没有「装一次就长期常驻」的隐式授权。
- **怎么选**：要复用登录态（企业内网、已登录的 SaaS、后台系统）用 `chrome_*`；要干净可复现的自动化环境用 `browser_*`。
- 云侧 Agent 拿不到你本机的浏览器会话——这是本地优先架构的结果，不是配置差异。

## 权限与审批分级

三层动作分级 + 四档审批模式 + 三档沙箱；判定不确定时一律取更严的一侧（fail-closed）。

**动作分级（`main/approval.js`）**

| 级别 | 含义 | 典型场景 |
|---|---|---|
| L1 `danger-command` | 高危 / 不可逆命令 | Shell 命中危险模式、代码执行里的逃逸原语 |
| L2 `file-write` | 本机文件写入 | `write_file` / `edit_file` / `apply_patch` |
| L3 `mcp-tool` | MCP 外部工具 | 全部 `mcp__*` |

- 只读工具（`READONLY_TOOLS`）直接放行，不弹卡。
- **未登记的工具按 L2 处理**——fail-closed，不存在「没登记就默认放行」。
- 可补偿性（`REVERSIBILITY`）单独判定：外部副作用与本机销毁类动作一律按不可逆对待。
- **卡面文案本身属于安全面**：所有会落到 L1 或不可记忆的工具，`approvalSummary()` 里必须有专门撰写的说明；退化成原始 JSON dump 视为缺陷，由 `test/approval.test.js` 的门禁拦截。动作不可逆时，卡面是用户唯一能知道「接下来要发生什么」的地方。

**审批模式（严格度递增）**：`never` < `auto-safe` < `on-request`（默认）< `always`

- `auto-safe`：L2 自动放行，L1 / L3 仍询问。
- `never`：除 L1 与不可逆 / 不可记忆的 L3 外不询问。
- 「执行后告知」（`approvalNotice`）是与档位**正交**的布尔偏好，不改变任何询问行为。

**沙箱三档**：`read-only` / `workspace-write` / `full-access`

- `full-access` **只能**经会话运行链路由宿主绑定；IPC 直连会被钳制回 `workspace-write`（`main/tools/execGovernance.js`）。
- 角色模板只能收紧权限、不能放宽。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面外壳 | Electron 45（主进程 CommonJS，引擎 ESM） |
| 界面 | React 18 + Vite 5 + TypeScript 5 + Tailwind CSS 3 |
| Agent 引擎 | `agent-core`：自研工具循环、模型适配、token/上下文记账 |
| 存储 | SQLite（`sql.js`），协同缓冲用 Yjs |
| 可选服务端 | Express 4 + PostgreSQL + JWT |
| 质量门禁 | `node test/run-all.mjs`（323 套件）、ESLint 警告棘轮、`tsc --noEmit`、文档与源码数字核对 |

## 如何运行（开发）

需要 **Node.js 22+** 与 npm。

```bash
cd desktop
npm install
cd renderer && npm install && cd ..

npm run dev          # 启动 Vite（:5173）并拉起 Electron 窗口
```

首次启动请到 **设置 → 模型** 添加一个服务商（API Base + Key）。其余功能离线可用；
`server/` 后端是可选的，只在需要账号 / 多端同步时才部署。

## 如何打包

```bash
cd desktop
npm run dist:mac     # .dmg + .zip（Apple Silicon；会内置自带 OCR 二进制）
npm run dist:win     # NSIS .exe（x64，在 Windows 上打包，或交给 CI）
npm run dist:linux   # .AppImage（x64，在 Linux 上打包，或交给 CI）
```

产物输出到 `desktop/release/`。`dist:mac` 需要本机装有 `tesseract`
（`brew install tesseract tesseract-lang`）以便内置 OCR；Windows 与 Linux 制品由 CI 产出，
这也是发布制品的正规路径。

## 自检

```bash
cd desktop
npm test                          # 完整测试套件
npm run lint                      # 0 error + 警告棘轮
npm run typecheck                 # 渲染层 tsc --noEmit
node scripts/doc-fact-check.mjs    # 设计文档里的数字必须与源码一致
```

推送 `v*` tag 会触发 `.github/workflows/ci.yml` 的三平台矩阵打包并发版。

## 已知限制

- **Windows 沙箱** — OS 级后端已随包分发，但需要先跑一次管理员设置；未执行前 OS 级隔离尚未接线，
  命令执行回落为命令级黑名单。
- **代码签名** — 包内 `.app` 用 Apple Development 标识签名但**未公证**，`.dmg` 容器本身无签名；
  在他人机器上首次启动仍可能被 Gatekeeper 拦下（右键 → 打开）。Windows / Linux 制品由 CI 产出，
  未配置签名密钥时同样未签名，SmartScreen 也会提示。

## MCP tools profile 口径

MCP 服务器可能声明 `outputSchema`。该 schema 已消费，但仅用于校验：校验失败会把出错的路径回传给模型，
而结构化数据本身**不进上下文**——进上下文的只有它的文本版。程序化消费（把结构化结果直接喂给下游工具或表格）
仍未实现，因此结构化数据不会挤占上下文预算。

## 许可

[MIT](./LICENSE)
