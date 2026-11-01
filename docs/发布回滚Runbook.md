# MJ Code 发布与回滚 Runbook

> 版本：v1.0（2026-10-13，第四阶段发布基建收尾时建立）
> 适用范围：desktop（electron-builder 三平台）/ server / renderer 统一版本节奏
> 核心纪律：**生产制品只从 CI 产出**；本地 build 仅限紧急抢修且必须在 Runbook 第 6 节流程内执行并留痕。

---

## 1. 版本与 tag 规范

| 项 | 规范 |
|---|---|
| 版本号 | 语义化版本 `主.次.修订`（如 `1.2.0`），三处 package.json（desktop / server / renderer）必须一致 |
| git tag | `v主.次.修订`（如 `v1.2.0`），**只打 tag 不直接推分支发版**；tag 即发布触发器 |
| CHANGELOG | 根目录 `CHANGELOG.md`（Keep a Changelog），发版前把「未发布」段落改版本号 + 日期 |
| 制品名 | `MJCode-${version}-${os}-${arch}.${ext}`（版本-平台-架构三元组可追溯） |
| CI 制品命名 | `MJCode-<runner-os>-<commit-sha>`（含 commit，绑定源码） |

---

## 2. 标准发版流程

```text
1. 三处 package.json version 同步提升（npm version --no-git-tag-version 或手动）
2. CHANGELOG.md「未发布」→ 版本号 + 日期，摘要面向用户价值
3. git commit + push main
4. git tag v1.2.0 && git push origin v1.2.0     ← 唯一发布触发器
5. CI release job（macOS/Windows/Linux matrix）自动打包：
   - 版本从 tag 同步 → 三平台 artifactName 带版本
   - 签名 secrets 就位则签名/公证，未配置则产出未签名包（CI 仍绿）
   - 制品上传 GitHub Actions Artifacts（名含 commit sha）
6. 仓库变量 PUBLISH_RELEASE=true 时，electron-builder --publish always
   自动创建/更新 GitHub Release 并上传 latest.yml（自动更新源）
7. Release 页核对：三平台制品齐全 + latest(-beta).yml 存在 + CHANGELOG 链接
```

> **本机推送前置（否则第 3/4 步 `git push` 会 502）**
> 若 `~/.gitconfig` 配了 `[url "https://gh-proxy.com/https://github.com/"] insteadOf = https://github.com/`，
> 它会把**所有** github 请求改写成走 gh-proxy 只读镜像 ⇒ `git push` 报
> `CONNECT tunnel failed, response 502` 或 `No anonymous write access`（读镜像偶发 502，写一律拒绝）。
> 两种解法，任选其一：
> 1. **仓库本地（推荐，持久、不动全局）**：
>    `git config --local 'url.https://github.com/.pushInsteadOf' 'https://github.com/'`
>    `git config --local http.version HTTP/1.1`
> 2. **一次性**：`GIT_CONFIG_GLOBAL=<去掉 gh-proxy 段的 gitconfig> GIT_HTTP_VERSION=1.1 git push origin <ref>`
>
> 注：`gh release view` / `gh run list` 走 GitHub API，不受该改写影响，可用来独立核验发布结果。

签名 secrets（GitHub → Settings → Secrets）：

| 平台 | 变量 |
|---|---|
| macOS | `CSC_LINK`（p12 base64）、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`（公证） |
| Windows | `CSC_LINK`（pfx base64）、`CSC_KEY_PASSWORD` |

未配置 = 未签名包（Gatekeeper/SmartScreen 会拦，仅供内部/测试分发）。

---

## 3. 更新链路（客户端侧）

| 机制 | 行为 |
|---|---|
| 启动自动检查 | 打包态启动后延迟 10s 自动 `checkForUpdates`；`autoDownload=false`，下载始终由用户确认 |
| 手动检查 | 设置 → 账户 → 版本更新 →「检查更新」 |
| 失败降级 | 检查失败时设置页展示「手动下载最新版本」链接（`https://github.com/{owner}/{repo}/releases`，由 `build.publish` 推导） |
| 更新通道 | 默认 `latest`（对应 `publish.channel`）；灰度通道 `MJ_UPDATE_CHANNEL=beta`（electron-updater channel，读取 `latest-beta.yml`） |
| 安装 | 下载完成后 `quitAndInstall`（`autoInstallOnAppQuit=true`） |

---

## 4. checkForUpdates 冒烟清单（每个候选发布版必过）

- [ ] 打包态冷启动 10s 后自动触发检查（日志无异常，状态流转 checking → up-to-date/available）
- [ ] 设置页手动「检查更新」返回 ok（曾因 autoUpdater 作用域 bug 手动链路从未工作，已修复并加门禁）
- [ ] 拔网/断代理启动：error 态出现且「手动下载最新版本」链接可点开
- [ ] 上一稳定版（latest.yml 指向版本）可正常获取并完成更新闭环
- [ ] beta 通道包（如发布）只被 `MJ_UPDATE_CHANNEL=beta` 的构建发现，latest 用户无感

---

## 5. 回滚步骤

### 场景 A：新版本发现阻断性缺陷，需回退自动更新源

1. 在 GitHub Release 页把问题版本的制品 **撤回/删除**（或整个 Release 删 tag）
2. 重新上传**上一稳定版**制品 + 其 `latest.yml`（yml 必须指向旧版本号——这是更新源的真值）
3. 已验证：客户端下次检查即拿到旧版本；已下载未安装的用户重启后仍装新版（`autoInstallOnAppQuit`），需在 Release notes 明示「先卸载再装旧版」
4. 热修复分支从上一个 tag 切出，修完按第 2 节流程发 `v1.2.1`

### 场景 B：CI 制品损坏/缺失，急发

1. 删除问题 tag（本地 + 远端），修正后**重打同号 tag**（CI 全量重跑，禁止手工补传单平台制品造成矩阵不全）
2. 若必须本地应急出包：仅限维护者本机、完整留痕（构建日志 + sha256 + 分发范围），并在 24h 内用 CI 制品替换

### 场景 C：数据库/配置回归（server 侧）

1. server 回退到上一 tag 镜像/进程
2. 客户端兼容性以「主.次」对齐：次版本内客户端/服务端可混跑；主版本不混跑

---

## 6. 演练记录（2026-10-13，第四阶段收尾）

| 演练项 | 状态 | 说明 |
|---|---|---|
| publish 真实 owner/repo + channel | ✅ 就绪 | `jasonma1210/MJCode`（**仓库名待仓库实际创建后核对**，不同只需改 `desktop/package.json` `build.publish`） |
| CI tag 触发三平台打包 job | ✅ 就绪 | `.github/workflows/ci.yml` release job，matrix + 签名条件启用 + 制品含 commit |
| artifactName 版本绑定 | ✅ 就绪 | `MJCode-${version}-${os}-${arch}.${ext}` |
| 启动延迟自动检查 + 手动检查链路 | ✅ 就绪 | 修复 autoUpdater 作用域 bug；10s 延迟；手动下载降级链接 |
| beta 灰度通道 | ✅ 就绪 | `MJ_UPDATE_CHANNEL=beta` 环境变量切换 |
| 真实 tag 试发（v1.0.0） | ⏳ 待仓库创建 | 需 GitHub 仓库 + （可选）签名 secrets；就绪后按第 2 节执行并在本表记录结果 |
| 回滚场景 A 实测 | ⏳ 依赖上一稳定版存在 | 首个版本发布后，用「删 Release + 重传旧制品 + latest.yml」完整走一遍并记录 |

---

## 7. 值守约定

- 发布后 72 小时观察窗：盯 GitHub Issues / 更新失败率（`updater:status` error 事件）/ 崩溃日志（`crash.log`）
- 强更仅用于安全或阻断性缺陷；功能性回退一律走「重新指向上一稳定版」
- 每次发版/回滚在本文件第 6 节追加一行记录（日期、版本、操作人、结果）
