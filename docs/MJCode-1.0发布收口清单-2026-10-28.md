# MJCode 1.0 发布收口清单（2026-10-28 状态）

> 本清单**不是**手写勾选框 —— 机器可判的部分已做成 `desktop/scripts/preflight-release.mjs`，
> 每次运行都会给出当时的真实状态。本文记录「现在跑到什么结果 + 还差什么 + 需要谁决策」。

---

## 一、当前机器判定结果（刚跑）

```
$ cd desktop && node scripts/preflight-release.mjs
发布前置检查（版本 0.7.0-beta）

✅ P1 三处 package.json 版本一致 — 0.7.0-beta（3 处）
✅ P2 版本号格式合法 — 0.7.0-beta
✅ P3 CHANGELOG 含当前版本条目且内容非空 — 435 行
❌ P4 工作区干净 — 有未提交改动 41 处
❌ P5 git tag v<version> 未被占用 — tag v0.7.0-beta 已存在
✅ P6 从 main 分支发布 — main
✅ P7 打包冒烟脚本存在 — scripts/smoke-packaged.mjs
✅ P8 关键安全门禁套件存在 — security-guards / renderer-guards / checkpointStore
```

**8 项里 6 项绿、2 项红。两个红都是「流程没走完」，不是代码问题。**

---

## 二、两个阻塞项及处置

### P4　41 处未提交改动

这三轮（批次 2 / 批次 1 / A-P0-8 / B6）的全部改动都还在工作区。发布必须基于确定提交 —— 脏工作区打出的包无法用 commit 回溯，出问题也没法复现。

**建议拆 4 个提交**（每批独立、各自可回溯、方便单独 revert）：

| # | 范围 | 涉及文件 |
|---|---|---|
| 1 | 批次 2 界面止血 | `App.jsx` / `ErrorBoundary.jsx` / `ScheduledTasks.jsx` / `DiffReviewPanel.jsx` / `ApprovalCard.jsx` / `SettingsModal.jsx` / `useAgentRun.ts` + 4 个 i18n + `renderer-guards.test.mjs` |
| 2 | 批次 1 安全边界 | `approval.js` / `dangerousPatterns.js` / `sandbox.js` / `resourceQuotaCenter.js` / `nativeTools.js` / `exec.js` / `execWrite.js` / `childEntry.js` + `security-guards.test.mjs` |
| 3 | A-P0-8 断点存储 | `checkpointStore.js` + `checkpointStore.test.js` |
| 4 | B6 打包冒烟 + B4/B5 | `scripts/smoke-packaged.mjs` / `scripts/preflight-release.mjs` / `bundle-ocr.mjs` / `package.json` / `build-config.test.js` / `ci.yml` |

> 为什么不合成一个提交：这四批的失败模式完全不同（渲染 / 安全 / 数据 / 发布），
> 将来任何一批需要回滚时，合成提交会连带撤掉其余三批已验证的修复。

### P5　tag `v0.7.0-beta` 已存在

当前版本号 `0.7.0-beta` 已经打过 tag。要发就必须升版本 —— **这一项需要你决定**。

**我的建议：`0.7.1-beta`**（下一节说明理由）。

---

## 三、需要你决策的一件事：版本号

| 选项 | 适用判断 | 影响 |
|---|---|---|
| **`0.7.1-beta`**（建议） | 本次全是修复，无新功能 | 符合 semver patch 语义；`-beta` 保持预发布通道 |
| `0.8.0-beta` | 若认为审批档语义变更（never 档 L1 硬地板）属**行为破坏性变更** | 更保守；对外可解释为「审批行为有变」 |
| `1.0.0` | 若这批就是 1.0 发布候选 | 需同时清掉 CHANGELOG 里那个早已存在的 `[1.0.0] - 2026-10-13` 历史段（当前它与 0.7.0-beta 并存，版本序混乱） |

**我倾向 `0.7.1-beta`**，因为：
- 唯一的行为变更（`never` 档下危险命令现在会弹卡）是**安全修复**，不是接口破坏
- 但它确实改变用户感知，CHANGELOG 必须显式写出来，不能埋在「修复」里

选定后要同步改 **3 处** `package.json`（desktop / renderer / server），P1 会强制校验一致。

---

## 四、CHANGELOG 条目草稿（选定版本号后可直接用）

```markdown
## [0.7.1-beta] - 2026-10-28

### 安全（本版重点，建议置顶）

- **`never`（全不询问）档不再豁免危险命令**。此前该档下 `rm -rf` / `curl | sh` /
  `git push --force` 零确认直接执行，而无人值守路径因强制 `auto-safe` 反而会问 ——
  交互路径比无人值守更松。现 L1 为硬地板，任何档位都询问；文件写入等 L2 行为不变。
  设置页文案已同步（不再声称「不弹出任何确认」）。
- **修掉四处「守卫谎报」**：macOS 沙箱在「真探测判定不可用」时仍被当作可用（导致危险命令
  黑名单被跳过）；Windows 沙箱异常会让命令执行永久挂起；`apply_patch` 在缺少 GNU patch 时
  直接崩主进程；熔断开启后前台请求也被挡（表现为「应用整体卡死」）。
- **`http_request` 补 DNS 层复检**：此前只校验字面量主机名，`127.0.0.1.nip.io` 这类
  解析到内网的域名可绕过。
- **代码执行沙盒逃逸原语现在判 L1**：`constructor.constructor` / `__proto__` / `.mainModule`
  这类原型链自救写法此前被当普通计算放行。同时不再向沙盒上下文注入宿主 `Buffer`。
  （说明：vm 不是安全边界，本版做的是抬高门槛与要求确认，未做 OS 级隔离。）

### 修复（界面稳定性）

- 定时任务列表在任务缺 `prompt` 字段时整屏白屏 —— 现于数据入口归一并做取值兜底。
- 每个路由页面各自包裹错误边界，单页渲染异常不再拖垮整屏（含正在跑的会话）。
- 会话区请求加序号，切换项目后迟到的旧响应不再覆盖当前内容（此前会误显示上一个项目的 diff，
  点「全部放弃」甚至会对旧项目路径执行丢弃）。
- 连按两次 Enter 不再创建两个会话 / 双花 token。

### 修复（数据可靠性）

- 全新安装后首次保存断点，不再被误判为「存储损坏」并弹出告警（ENOENT 与真损坏区分）。
- 断点淘汰改为按最后更新时间（此前按首次创建时间，长期活跃的会话会被优先淘汰）。

### 工程

- 新增**打包产物冒烟**：对真实产物校验关键入口、asarUnpack、随包 OCR、版本一致性、
  更新配置等 10 项，接进 CI 发布流水线（此前 CI 只上传产物，从不开箱检查）。
- CI 的 macOS 构建补上随包 OCR 步骤（此前本地包有、CI 包没有）。
- 非 macOS 上 `npm run build` 不再因 OCR 步骤直接失败。
- 修正 Windows 更新签名校验配置：原先开启了校验却没有 `publisherName`，实际一行校验都不执行。
  未签名阶段改为显式关闭；证书就位后须同时补两个字段。
```

---

## 五、发布执行序列（选定版本号后照此走）

```bash
# 0) 前置：确认测试基线绿
cd desktop && npm test          # 期望 314 · 通过 311 · 失败 0 · 跳过 3

# 1) 改 3 处版本号（P1 会校验一致）
#    desktop/package.json, desktop/renderer/package.json, server/package.json

# 2) 写 CHANGELOG（用上面草稿）

# 3) 分 4 个提交（见第二节表格）
git add -A && git commit -m "fix(renderer): 界面止血四件套 + 局部错误边界"
# ...其余三个

# 4) 本地跑前置检查 —— 应只剩 P5（tag 未占用 → 这次应该绿）
cd desktop && node scripts/preflight-release.mjs

# 5) 打 tag 并推送（触发 CI release job）
git tag v0.7.1-beta && git push origin main --tags

# 6) 观察 CI
#    release job 顺序：preflight → Sync version → build → OCR → Package → **冒烟** → Upload
#    ⚠ 若冒烟失败且 PUBLISH_RELEASE=true，坏包已上架，需人工下架（B6 报告 5.3）
```

---

## 六、人工确认项（机器判不了，不给假勾选）

| # | 项 | 为什么机器判不了 |
|---|---|---|
| ① | tag 必须打在 `main` 上 | CI checkout 是 detached HEAD，校验 `origin/main` 需额外 fetch，会引入新失败点 |
| ② | macOS 真机装一次 dmg：能启动 / 能建会话 / OCR 可用 | 需要人看界面 |
| ③ | Windows / Linux 产物核验 | 两者尚未纳入自动冒烟（B6 报告 5.4），首次发这两平台前需人工开箱 |
| ④ | CHANGELOG 面向用户的措辞审校 | 不能暴露内部代号与未定事项 |
| ⑤ | 签名证书就位时：`verifyUpdateCodeSignature` 改回 `true` + 补 `publisherName`（值须等于证书 Subject CN） | 需要证书信息 |

---

## 七、本次新增的可执行门禁

| 脚本 | 作用 | 自证伪 |
|---|---|---|
| `scripts/preflight-release.mjs` | 8 项发布前置断言（版本/CHANGELOG/tag/分支/门禁齐备），接进 CI release job | P3/P5 已实证双向（见本文第一节与 patch 记录） |
| `scripts/smoke-packaged.mjs` | 10 项打包产物断言 | `test/manual/smoke-packaged-selftest.mjs` 15/15 |

---

## 八、尚未解决、但不阻塞本次发布

1. **vm 沙箱不是安全边界**（A-P0-3）—— 本版只抬高门槛 + 要求确认，未做 OS 级隔离。
2. **`http_request` 的 DNS 预检存在理论窗口** —— 彻底解决需换 `http.request` + `lookup` 钩子。
3. **三个 God File 顶死 800 行**（`App.jsx` / `useAgentRun.ts` / `approval.js`）—— 下次加任何功能都会撞线。
4. **发布流水线里冒烟晚于 publish** —— 需把 publish 拆成独立 step。
5. **写用户文件非原子**（审查清单 A-P2）—— 崩溃可能留半成品源码。
