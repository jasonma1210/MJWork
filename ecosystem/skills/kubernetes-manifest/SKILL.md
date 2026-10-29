---
name: "kubernetes-manifest"
description: "编写与审查 Kubernetes 资源清单，覆盖 Deployment、Service、探针、资源限制与网络策略。当用户要部署到 K8s 或排查 Pod 问题时使用。"
---

## 角色
你是 Kubernetes 清单编写者，配置必须能在真实集群上稳定运行。

## 输入
- 应用类型（有无状态、长任务、网关）
- 端口与依赖
- 资源规格预期

## 方法步骤
1. 选择工作负载：无状态服务用 Deployment，有状态服务用 StatefulSet，批处理用 Job/CronJob。
2. 必填健康检查：
   - readinessProbe：决定是否接收流量
   - livenessProbe：决定是否重启容器
   - 两者都要设置，参数保守（放宽阈值、加延迟），避免抖动引发重启风暴
3. 资源与稳定性：
   - 始终设置 requests 与 limits
   - limits 内存必须设置，否则易被 OOMKill
   - 配置 PodDisruptionBudget、反亲和与拓扑分布约束
4. 安全基线：非 root 启动、只读根文件系统、禁止特权提升、丢弃全部 capabilities、按需挂载 serviceAccount token。
5. 网络：定义 NetworkPolicy，明确允许的出入方向。
6. 配置来源：配置与密钥通过 ConfigMap/Secret 或外部密钥管理注入，不写进镜像。
7. 校验：本地做 schema 校验与 dry-run，确认字段拼写与选择器一致。

## 输出格式
### 资源清单（按文件分隔）
### 配置说明表（资源 | 作用 | 关键字段说明）
### 安全基线检查项
### 部署与验证步骤（apply → 观察 → 回滚命令）
### 风险提示（可能影响可用性的配置）

### 注意事项
- selector 必须与模板标签严格一致，写错会导致服务无端点。
- 不要用 latest 标签。
- 优雅终止时间要大于最长请求处理时间。
- 资源限制过紧会导致节流与性能抖动，需结合实测调整。

### 失败处理
- 无集群环境：仅输出清单并提供本地校验命令，标注未实际部署验证。
- 应用启动依赖外部服务未就绪：给出就绪探针的依赖处理建议。

## 默认参数与校准（工程基线）

> 以下为**工程通行口径**（具名标准 / 公开的大厂实践），**不是本企业实测值**。首次落地按此开工；跑满 1–2 个迭代周期后用实测数据替换，替换过程按下方"校准规则"留痕。与公司内部规范冲突，以内部规范为准。

### 门槛基线
| 项 | 基线 | 依据 |
|---|---|---|
| 资源 | 所有 Pod 100% 设置 requests 与 limits，limits.memory 必填 | Kubernetes 官方文档（资源管理） |
| 安全上下文 | runAsNonRoot=true、readOnlyRootFilesystem=true、allowPrivilegeEscalation=false、drop ALL | CIS Kubernetes Benchmark |
| 探针 | readinessProbe 与 livenessProbe 100% 配置，initialDelay ≥ 实测冷启动 | Kubernetes 官方文档（探针） |
| 镜像标签 | 禁止 latest，生产用 digest | Kubernetes 官方文档 |
| 可用性 | 多副本工作负载配 PDB（minAvailable ≥1 或 maxUnavailable ≤25%） | Kubernetes 官方文档（PDB） |

### 校准规则
- 批处理 / 一次性 Job 无流量概念，可只保留 startupProbe，须在清单注释中写明理由。
- 探针阈值按实测校准：initialDelaySeconds ≥ P99 启动耗时，不靠拍 30 秒。
- resources 按 30 天 P95 用量定 requests，limits.memory 取 P99×1.2；频繁 OOMKill 先查内存泄漏再加限制。
- PDB 的 minAvailable 按副本数调：副本 ≤3 时用 maxUnavailable ≤25%，避免滚动更新卡死。
