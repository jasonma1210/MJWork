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

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面外壳 | Electron 45（主进程 CommonJS，引擎 ESM） |
| 界面 | React 18 + Vite 5 + TypeScript 5 + Tailwind CSS 3 |
| Agent 引擎 | `agent-core`：自研工具循环、模型适配、token/上下文记账 |
| 存储 | SQLite（`sql.js`），协同缓冲用 Yjs |
| 可选服务端 | Express 4 + PostgreSQL + JWT |
| 质量门禁 | `node --test`（310 套件）、ESLint 警告棘轮、`tsc --noEmit`、文档与源码数字核对 |

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
