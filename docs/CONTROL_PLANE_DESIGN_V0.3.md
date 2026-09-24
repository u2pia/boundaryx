# AI Native SDLC Control Plane 总体设计

> 版本：Draft v0.3  
> 日期：2026-09-22  
> 状态：设计基线，尚未进入实现  
> 目标用户：3–8 人、无专职平台工程师的软件研发团队  
> 目标版本：v0.1.0 开源研究原型

## 1. 文档目的

本文整合以下输入，形成可进入架构评审和纵向原型阶段的单一设计基线：

- v0.1 的愿景、产品章程、领域模型和开源复用方案；
- v0.2 对小团队定位、审查带宽、身份、并发和证据来源的评审修订；
- 对 v0.2 的二次审查，包括指标可采集性、生命周期边界、离线模式和六个月范围修正；
- 已确认的产品目标：从个人开发工具调整为小团队开发管理平台。

本文不替代后续 ADR、威胁模型、Schema 和 API 规范。它负责回答：

1. 产品解决什么问题；
2. 第一阶段服务谁；
3. 系统边界在哪里；
4. 核心组件如何协作；
5. 哪些能力进入 v0.1.0；
6. 哪些决策仍需在编码前冻结。

## 2. 信息充分性结论

### 2.1 已经足够开始的工作

当前信息足以开始：

- 总体架构设计；
- 领域 Schema 草案；
- GitHub Issue-to-PR 纵向原型；
- Evidence Summary 原型；
- Context Manifest 原型；
- Evaluation 与 Acceptance Criteria 映射原型；
- Agent 执行隔离和权限验证实验；
- 三个目标团队的需求访谈与指标基线采集。

### 2.2 尚不足以直接冻结的实现决策

以下事项不阻塞设计，但必须在相应编码开始前通过 ADR 决定：

| 决策 | 最晚时点 |
|---|---|
| 首个深度集成的 Coding Agent | 第一个纵向原型前 |
| 实现语言与打包方式 | 建立代码仓库前 |
| GitHub App、OAuth App 或 GitHub Actions 的集成形态 | GitHub 集成前 |
| Review 指标的采集协议 | 试点团队接入前 |
| Connected 与 Air-gapped 身份实现 | 团队服务前 |
| 容器执行环境与降级模式 | Agent 写权限开放前 |
| 开源许可证 | 首次公开发布前 |

### 2.3 当前最大未知

当前最大未知不是技术，而是核心产品假设是否成立：

> 结构化意图、上下文和评估证据，能否降低小团队接受 AI 变更所需的验证与决策成本，同时不提高缺陷逃逸率？

这个问题不能只通过自测回答，必须在至少一个非作者团队中验证。

## 3. 产品定位

### 3.1 一句话定义

AI Native SDLC Control Plane 是一个开源、可自托管、Agent 中立的小团队研发管理平台，把 AI 参与的软件变更从意图、上下文、执行、评估、审查、合并、发布到反馈串成可控制、可验证、可追溯的链路。

### 3.2 产品不是什么

它不是：

- Coding Agent；
- IDE；
- Git 托管平台；
- Issue Tracker；
- CI/CD 系统；
- 通用多 Agent 编排平台；
- 基础模型或模型网关；
- 企业合规套件。

它附着在这些系统之上，提供跨系统的控制与证据脊椎。

### 3.3 “全周期”的含义

“全周期”表示追溯链覆盖完整生命周期：

```text
Intent → Context → Execution → Evaluation → Review
→ Change Proposal → Merge → Release → Feedback ↺
```

不表示项目自行实现每个阶段的深度能力。需求、代码、测试、发布和监控能力优先通过集成获得。

### 3.4 目标团队

第一阶段团队画像：

| 维度 | 目标范围 |
|---|---|
| 团队规模 | 3–8 人 |
| 项目 | 一个主仓库、一个真实生产项目 |
| Agent 使用 | 已经使用至少一个 Coding Agent |
| 平台能力 | 无专职平台工程师 |
| 现有工具 | GitHub、CI、Issue Tracker |
| 部署偏好 | 自托管、低运维、可离线 |
| 合规 | 第一阶段不承诺法规合规认证 |

个人是安装和推动单位，团队是价值生效单位：一个人安装后生成 Evidence，第二个人审查时开始体现团队价值。

## 4. 核心价值假设

### 4.1 首要问题

Coding Agent 提高变更产生速度后，人的验证和决策能力可能成为新的约束：

- 审查者无法快速理解大量 AI 变更；
- 验收标准没有被明确写下；
- Agent 使用了什么上下文不可见；
- 测试可能由 Agent 与实现同时生成；
- 权限和执行边界难以验证；
- 审查可能退化为形式化批准。

### 4.2 产品假设

如果系统能够自动提供以下材料：

- 结构化 Intent 和 Acceptance Criteria；
- Context Manifest 与实际读取差异；
- Agent、工具和权限记录；
- Acceptance Criteria 与 Evaluation 的映射；
- Evaluation Provenance；
- 风险、失败和残余未知；

那么审查者可以用更少的认知成本做出更可靠的接受或退回决策。

### 4.3 产品价值表达

第一阶段不把“治理”和“合规”作为面向小团队的主要宣传语，而使用：

> 让团队更快、更有把握地接受或拒绝 AI 产出的软件变更。

治理、权限和证据是实现该价值的机制。

## 5. 设计原则

```text
Attach before Replace             附着既有系统，不替代它
Evidence before Trust             证据优先于声明
Enforce at the Boundary           只在可强制边界上声称阻止
Review Cost as a Hypothesis       审查成本是待验证假设，不是既定事实
Deterministic Core                状态与门禁由确定性程序执行
Graduated Autonomy                自治按风险逐步开放
Reuse before Build                优先复用标准和开源能力
Self-hosted First                 默认自托管并支持离线
Protocol before Vendor            核心模型不绑定单一厂商
Explicit Unknowns                 未知、未评估和不适用必须显式
```

## 6. 关键角色

### 6.1 变更作者

负责：

- 关联或创建 Intent；
- 确认 Acceptance Criteria；
- 选择 Agent 和执行范围；
- 处理评估失败和审查退回；
- 说明无法自动验证的内容。

### 6.2 变更审查者

负责：

- 阅读 Review Summary；
- 检查高风险证据和残余未知；
- 判断 Evidence 是否足以支持接受；
- 批准、拒绝或请求修改；
- 对需要人工判断的决策负责。

### 6.3 团队推动者

负责：

- 部署共享服务；
- 配置项目规则、Agent 和风险等级；
- 维护评估资产；
- 观察采用、返工和交付质量；
- 决定是否扩大自治范围。

### 6.4 Agent

Agent 是受控执行主体，不是责任主体。Agent 不得持有批准自身变更的能力。

## 7. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                       Experience Layer                       │
│ CLI │ GitHub Issue/PR │ Checks │ Review Summary │ Metrics   │
└──────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────┐
│                        Control Plane                         │
│ Intent │ Context │ Workflow │ Policy │ Evaluation │ Evidence│
│ Identity │ Review │ Integration │ Event Log                  │
└──────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────┐
│                        Execution Plane                       │
│ Agent Runner │ Workspace │ Container │ Tools │ CI │ Git      │
└──────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────┐
│                        External Systems                      │
│ GitHub │ CI │ Issue Tracker │ Coding Agent │ Release/Monitor │
└──────────────────────────────────────────────────────────────┘
```

### 7.1 Control Plane 职责

- 保存和版本化 Intent 扩展信息；
- 编译并记录 Context；
- 控制 Agent 执行边界；
- 运行或接收 Evaluation；
- 生成 Evidence Package 和 Review Summary；
- 记录审查、决策和外部状态；
- 维护端到端关联和事件日志。

### 7.2 Execution Plane 职责

- 创建 Workspace；
- 启动和停止 Agent；
- 执行命令和工具调用；
- 读取和修改代码；
- 运行测试、扫描和构建；
- 输出 Artifact、日志和结果。

Control Plane 不信任 Agent 的完成声明，只接收事实、Artifact 和 Evaluation Result。

## 8. 部署模式

### 8.1 Connected Mode

首个正式支持模式：

```text
GitHub Issue
→ Self-hosted Team Service
→ Containerized Agent Runner
→ GitHub Pull Request + Checks
```

特征：

- GitHub 作为首个 Git、Issue、Review 和身份提供者；
- 共享服务部署在团队环境；
- SQLite 作为第一阶段状态库；
- 完整代码和 Trace 默认不上传项目外部服务。

### 8.2 Air-gapped Mode

架构必须允许：

```text
Repository Intent
→ Local/Private Identity Provider
→ Private Git or GitLab
→ Local Agent and Model
```

v0.1.0 不要求完整实现所有 Air-gapped Adapter，但核心 Schema 不能把 GitHub ID、URL 或 OAuth 字段设为必填。

### 8.3 信任模式

| 模式 | 身份保证 | 执行保证 |
|---|---|---|
| Development | 本地身份，可自证 | Host 或容器，允许检测模式 |
| Team Connected | GitHub 等外部身份 | 容器强制模式 |
| Private Team | OIDC/GitLab/企业身份 | 容器或更强沙箱 |

低保证模式必须在 Evidence 中显式标记，不得伪装成高保证结果。

## 9. 组件设计

### 9.1 CLI

主要命令草案：

```bash
ainative init
ainative link <issue>
ainative intent validate <intent>
ainative context build <intent>
ainative run <intent>
ainative evaluate <run>
ainative evidence render <run>
ainative review request <run>
ainative decision record <proposal>
ainative status
ainative metrics
ainative serve
```

CLI 既可以连接 Team Service，也可以在开发模式下本地运行。

### 9.2 Team Service

第一阶段是单节点、自托管服务，负责：

- 状态机；
- SQLite 数据；
- 事件日志；
- GitHub webhook；
- 身份绑定；
- Policy Decision；
- Evaluation 汇总；
- Evidence 渲染；
- 外部系统同步。

不引入外部数据库集群、消息队列或 Kubernetes。

“单命令部署”表示单个二进制或一个 `docker compose up`。升级允许自动迁移，但不要求用户手工修改数据库。

### 9.3 Intent Manager

Intent 由两部分组成：

```text
External Work Item
  标题、描述、状态、负责人、讨论

Control Plane Extension
  Acceptance Criteria、Constraints、Risk、Evaluation Mapping
```

第一阶段字段所有权：

| 字段 | 权威来源 |
|---|---|
| 标题、描述、状态、负责人 | GitHub Issue |
| Acceptance Criteria | Control Plane |
| Constraints | Control Plane |
| Risk | Control Plane |
| Evaluation Mapping | Control Plane |

第一阶段不做通用双向字段同步。Control Plane 只向 Issue 回写摘要、状态提示和证据链接。

Air-gapped 模式允许 Repository Intent 成为权威来源。

### 9.4 Context Compiler

Context Compiler 输出两份对象：

1. `ContextManifest`：执行前声明准备提供给 Agent 的上下文；
2. `ContextConsumption`：运行时实际读取、检索或访问的上下文。

系统计算：

```text
Declared but not consumed
Consumed but not declared
Version mismatch
Sensitive source access
```

这些差异进入 Evidence，而不是要求两者必须完全相同。

### 9.5 Agent Port

第一阶段只深度集成一个 Agent，但核心中保留最小内部 Port：

```text
prepare(run)
start(run)
observe(run)
cancel(run)
collect(run)
```

第一阶段不承诺稳定公共 Adapter SDK。第二个 Agent 接入后再冻结公共契约。

Agent 专有的 Hook、权限模式和工具拦截能力封装在实现内部，不进入核心领域对象。

### 9.6 Workspace 与 Sandbox

执行层级：

| 层级 | 描述 | Evidence 标记 |
|---|---|---|
| Host | 本机直接执行 | detective-only |
| Container | Git worktree + 容器 + 只读挂载 | enforced-basic |
| Hardened | Rootless、VM、短期凭证、更强网络控制 | enforced-hardened |

v0.1.0 的团队模式默认要求 Container。

以下目录默认对 Agent 只读：

```text
.ainative/policies/
.ainative/agents/
.ainative/evaluations/
```

这些目录的变更必须进入独立审查，且不能由同一 Run 自证。

### 9.7 Policy Engine

第一阶段使用简单 YAML Policy，但冻结统一 Decision Contract：

```yaml
decision: allow | deny | require_approval
enforcement: preventive | detective
reason: string
policy_id: string
policy_version: string
input_digest: string
```

第一阶段策略范围：

- 可写路径；
- 禁止修改路径；
- 命令；
- 网络；
- 时间预算；
- 成本预算；
- 凭证；
- 高风险操作审批。

OPA 或 Cedar 只有在 YAML 表达力不足时引入。

### 9.8 Evaluation Engine

支持接入：

- Command Exit Code；
- JUnit XML；
- SARIF；
- Coverage；
- JSON Assertion；
- 外部 CI Check；
- 人工评估。

每个 Evaluation Result 必须包含：

```yaml
criterion_id: AC-001
evaluation_id: EVL-001
status: passed | failed | unknown | not_applicable
criticality: critical | required | advisory
provenance: pre_existing | added_by_run | modified_by_run | external
source_digest: string
```

规则：

- Critical 验收标准必须有证据或显式 Unknown；
- 模型评估不能成为高风险变更的唯一关键证据；
- `added_by_run` 和 `modified_by_run` 不能成为 Critical AC 的唯一证据；
- AC 与 Evaluation 的映射若由模型建议，必须由人或确定性规则确认。

### 9.9 Evidence Manager

Evidence 分三层：

```text
Review Summary
  面向人，目标是快速决定是否需要展开

Evidence Package
  完整、机器可读、可移植、可追溯

Raw Artifacts
  日志、Trace、测试报告、扫描结果、二进制制品
```

Review Summary 至少回答：

1. 这次变更要解决什么？
2. 哪些文件和系统受到影响？
3. 每条关键 AC 由什么证明？
4. 哪些证明是本次运行新增或修改的？
5. Agent 访问了哪些未声明上下文？
6. 哪些策略真正被强制？
7. 有哪些失败、Unknown 和残余风险？
8. 审查者最应该展开看什么？

### 9.10 Review Manager

Review 是独立概念，但第一阶段尽量使用 GitHub PR 作为交互界面。

`ReviewAssignment` 支持多个并行 Assignment：

```yaml
id: RVA-...
proposal_id: CHP-...
assignee: user:bob
scope: code | security | domain | release
required: true
status: pending | in_review | changes_requested | approved | dismissed
external_ref: github-review-id
```

策略可以表达：

```text
普通变更：至少一名非作者批准
高风险变更：代码审查者 + 指定领域审查者批准
Policy 变更：maintainer 批准
```

GitHub 是 Review Assignment 和 Decision 的首个外部权威来源，Control Plane 保存投影和领域扩展信息。

### 9.11 Integration Layer

第一阶段 Adapter：

- GitHub Provider；
- 一个 Coding Agent；
- Evaluation Result Importer；
- 一个通知通道或 GitHub 原生通知。

第一阶段不建设完整插件市场。内部 Port 保持清晰，公共插件 SDK 在第二个实现出现后冻结。

## 10. 生命周期模型

### 10.1 Intent

```text
Draft → Ready → InExecution → Delivered → Observing → Closed
```

补充：`Rejected`、`Cancelled`、`Superseded`、`Orphaned`。

低风险 Intent 可以通过轻量规则直接进入 Ready；不要求所有任务经过重型审批。

### 10.2 Run

Run 只描述一次执行，不承担 PR 和发布生命周期：

```text
Created → Preparing → Running → Evaluating
→ EvidenceReady → Completed
```

异常状态：

```text
Paused | Blocked | Failed | Cancelled | Expired | Stale
```

重试在同一 Run 中形成 Attempt；若 Intent、Policy、Agent Profile 或关键 Context Version 改变，应创建新 Run。

### 10.3 Change Proposal

```text
Draft → Open → InReview → ChangesRequested
→ Approved → Merged
```

补充：`Closed`、`Rejected`、`Reverted`。

第一阶段 Change Proposal 映射 GitHub Pull Request。

### 10.4 Release

```text
Planned → Deploying → Live → Observing → Stable
```

异常状态：`Failed`、`RolledBack`。

v0.1.0 只要求能够引用外部 Release 和接收最小 Feedback，不实现通用部署编排。

### 10.5 Feedback

Feedback 可以派生：

- 新 Intent；
- 新 Evaluation Definition；
- Risk 调整；
- Policy 调整；
- Revert Proposal。

## 11. 核心领域对象

```text
Intent
Specification
AcceptanceCriterion
RiskAssessment
ExternalRef

ContextSource
ContextManifest
ContextConsumption

Actor
IdentityBinding
AgentProfile
Capability
Tool
Policy
PolicyDecision

Run
Attempt
Workspace
ResourceClaim
Artifact

EvaluationDefinition
EvaluationResult

EvidencePackage
ChangeProposal
ReviewAssignment
Decision
Release
Feedback
```

### 11.1 必须保持的追溯链

```text
Intent Version
→ Acceptance Criterion
→ Run / Attempt
→ Context Manifest / Consumption
→ Artifact / Change Set
→ Evaluation Result
→ Evidence Package
→ Change Proposal
→ Review Assignment / Decision
→ Merge
→ Release
→ Feedback
```

## 12. 数据与存储

### 12.1 Git

保存：

- Intent Extension；
- Specification；
- Acceptance Criteria；
- Policy Definition；
- Evaluation Definition；
- Agent Profile；
- Schema；
- Evidence Summary 或摘要引用。

### 12.2 SQLite

保存：

- Run 和 Attempt；
- Event Log；
- Workspace Metadata；
- Policy Decision；
- Review Projection；
- External Sync State；
- Evidence Index；
- Resource Claim；
- 指标原始事件。

### 12.3 文件或对象存储

保存：

- Raw Trace；
- 日志；
- 大型测试报告；
- 扫描结果；
- Artifact；
- Evidence Package。

### 12.4 事件模型

首批事件：

```text
IntentLinked
IntentReady
ContextCompiled
ContextConsumed
RunCreated
WorkspacePrepared
AgentStarted
ToolRequested
PolicyEvaluated
ToolExecuted
ToolBlocked
ArtifactProduced
EvaluationCompleted
EvidencePackaged
ChangeProposalOpened
ReviewAssigned
ChangesRequested
DecisionRecorded
ChangeProposalMerged
ReleaseObserved
FeedbackReceived
```

v0.1.0 不要求完整 Event Sourcing，但事件日志必须不可静默修改。

## 13. 身份、权限与安全

### 13.1 身份

Actor 身份通过 `IdentityProvider` 绑定：

```text
github
gitlab
oidc
local-development
```

生产团队模式不接受本地自声明字符串作为最终批准凭据。

### 13.2 权限

Agent 默认不得：

- 批准自身变更；
- 修改生效 Policy；
- 修改自身 Agent Profile；
- 修改关键 Evaluation 并用它自证；
- 合并主分支；
- 使用长期生产凭证；
- 直接发布生产环境。

### 13.3 威胁模型最小范围

首版威胁模型至少覆盖：

- Issue、代码注释、文档和 PR 评论中的 Prompt Injection；
- Agent 修改 Policy、Evaluation 或 Agent Profile；
- 凭证泄漏；
- 网络数据外发；
- 恶意依赖安装；
- Tool 参数注入；
- 日志和 Evidence 泄露敏感信息；
- GitHub webhook 重放与伪造；
- 身份冒用；
- 评估结果伪造；
- 容器逃逸和宿主机风险。

## 14. 指标设计

### 14.1 指标原则

- 指标必须说明数据来源；
- 自动采集与人工采集必须区分；
- 不把代理指标当作质量本身；
- 目标值必须在基线之后确定；
- 速度指标必须有质量 Guardrail。

### 14.2 第一阶段自动指标

| 指标 | 定义 | 来源 |
|---|---|---|
| Decision Latency | PR Ready 到首个有效决策 | GitHub / Event Log |
| Review Cycle Count | Changes Requested 循环次数 | GitHub / Event Log |
| First Evaluation Pass Rate | 首次 Run 通过 Required Gates 比例 | Evaluation Result |
| Critical AC Coverage | Critical AC 有有效证据的比例 | AC/Evaluation Mapping |
| Policy Block Rate | Tool 请求被阻止的比例 | Policy Decision |
| Post-merge Revert Rate | 合并后进入 Reverted 的比例 | GitHub / Feedback |

### 14.3 需要额外协议的指标

| 指标 | 采集限制 |
|---|---|
| Active Review Time | 需要显式 start/stop、IDE 插件或抽样自报 |
| Evidence Usefulness | 需要审查后反馈，不可由点击直接推断 |
| Cognitive Load | 只能通过访谈或问卷近似 |
| Defect Escape Rate | 需要稳定的生产缺陷归因 |

“证据展开率”暂时作为实验指标，不作为 v0.1.0 硬性成败条件。

### 14.4 试点成功判断

第一个试点先采集基线，再设目标。初始判断框架：

```text
Decision Latency 或 Active Review Time 有下降
AND Review Cycle Count 不上升
AND Revert / Defect Guardrail 不恶化
AND 至少两名非推动者持续使用
```

不在缺乏基线时承诺固定的 30%、70% 或 8 分钟。

## 15. MVP 范围

### 15.1 必须交付

- GitHub Issue → Intent Extension；
- Acceptance Criteria；
- Context Manifest 与 Consumption；
- 一个 Coding Agent 深度集成；
- Git worktree + Container Runner；
- YAML Policy 和 Decision Contract；
- JUnit、SARIF、Command、JSON Evaluation；
- AC ↔ Evaluation Mapping；
- Evaluation Provenance；
- Evidence Package 和 Review Summary；
- GitHub PR、Comment 和 Check；
- 多审查者 Decision 投影；
- 单节点 Team Service + SQLite；
- Connected Mode；
- 结构化事件和基础指标；
- 离线核心 Schema 与降级运行路径。

### 15.2 Stretch Goal

- Air-gapped 完整身份 Adapter；
- 自动审查者分配；
- Slack 通知；
- 低风险自动合并；
- Release Webhook；
- Feedback 自动派生 Evaluation；
- OPA/Cedar；
- OpenTelemetry Exporter。

### 15.3 明确不做

- Web 审批后台；
- 多租户与 RBAC；
- 多仓库事务；
- 通用多 Agent 编排；
- 自研 Coding Agent；
- 自研 CI/CD；
- 自动生产发布；
- 企业合规认证；
- 插件市场；
- 外部数据库集群和消息队列。

## 16. 六个月路线图

### 月 1：价值原型

- 找到 1–3 个试点团队；
- 采集当前 Review 基线；
- 手工或半自动生成 Review Summary；
- 完成 Intent、AC、Evaluation、Evidence Schema；
- 在 GitHub PR 展示 AC ↔ Evaluation 和 Provenance；
- 完成首版威胁模型。

退出条件：至少一名非作者审查者认为 Summary 对真实决策有帮助。

### 月 2：Agent 纵向链路

- 确定首个 Agent；
- 实现内部 Agent Port；
- Git worktree + Container Runner；
- Context Manifest / Consumption；
- Agent Diff、Artifact 和 Evaluation 收集。

退出条件：真实任务可以从 Intent 运行到 Evidence Package。

### 月 3：团队共享服务

- 单节点 Team Service；
- SQLite + Event Log；
- GitHub 集成和身份绑定；
- Change Proposal、Review 和 Decision 投影；
- 自动迁移框架。

退出条件：两名不同身份的团队成员可以完成一次作者与审查者流程。

### 月 4：策略和恢复

- YAML Policy；
- 目录、命令、网络和预算控制；
- 自我提权防护；
- Run 恢复；
- Resource Claim 和基础冲突检测；
- Policy 逃逸测试。

退出条件：可以证明至少一组禁止操作在 Container 模式下被阻止。

### 月 5：真实团队试点

- 持续运行试点；
- 收集 Decision Latency、Cycle Count 和质量 Guardrail；
- 修正 Review Summary；
- 修正 Schema 和流程摩擦；
- 决定是否需要自动合并、通知和高级策略。

退出条件：非推动者持续使用，且核心指标方向没有恶化。

### 月 6：收敛发布

- 安装、升级和迁移体验；
- 示例项目；
- 架构、威胁模型和贡献文档；
- Schema 版本策略；
- Adapter 指南；
- v0.1.0 发布。

Release 和 Feedback 只保留外部引用及手工/简单 Webhook 接入，不建设通用部署平台。

## 17. 开源复用决策

| 能力 | 决策 |
|---|---|
| Git、GitHub、JUnit、SARIF、Coverage、JSON Schema | Adopt |
| Docker / Podman | Adopt，Docker 先行 |
| OpenTelemetry | 接口预留，可选 Integrate |
| Spec Kit、OpenSpec、SpecD | Reference / 后续 Integrate |
| OpenHands、SWE-agent、CLI Coding Agent | 选择一个 Integrate |
| Promptfoo、DeepEval、Langfuse | 可选 Integrate |
| OPA、Cedar | 决策契约先行，按需 Integrate |
| Temporal | 第一阶段不采用，保留评估点 |
| SLSA、in-toto、Sigstore | Reference，第一阶段不作为交付要求 |
| Backstage | Reference 插件与平台组织方式 |

必须自研：

- Intent Extension；
- Context Reconciliation；
- Evaluation Provenance；
- Evidence Package / Review Summary；
- Risk-adjusted Decision；
- Traceability Graph；
- Review 与 Change Proposal 领域模型。

## 18. v0.1.0 验收标准

### 18.1 产品能力

1. 一个真实团队可在 30 分钟内完成 Connected Mode 部署；
2. 作者可从 GitHub Issue 启动真实 Agent Run；
3. Agent 在 Container 模式执行并受目录与命令策略限制；
4. 系统生成 Context Reconciliation、AC Mapping 和 Evaluation Provenance；
5. Evidence Summary 渲染到 GitHub PR；
6. 非作者可以批准或请求修改；
7. Critical AC 缺乏有效证据时不能通过门禁；
8. 每次 Decision 都可追溯到具体 Evidence Version；
9. 服务重启后 Run、Review 和同步状态可恢复；
10. 离线环境可完成除 GitHub 交互外的核心执行与证据生成。

### 18.2 产品价值

1. 至少一个非作者团队持续使用；
2. Review Summary 被审查者评价为对真实决策有帮助；
3. Decision Latency 或抽样 Active Review Time 相比基线改善；
4. Review Cycle Count 和质量 Guardrail 没有明显恶化；
5. 试点结果包含失败案例和不成立的假设，而不是只发布成功案例。

## 19. 编码前必须完成的 ADR

建议首批 ADR：

```text
ADR-001 Implementation Language and Packaging
ADR-002 First Coding Agent Integration
ADR-003 GitHub Integration Model
ADR-004 Identity Provider and Trust Modes
ADR-005 SQLite State and Automatic Migration
ADR-006 Container Enforcement Model
ADR-007 Intent Field Ownership
ADR-008 Review Metrics Collection Protocol
ADR-009 Evidence Package Storage and Redaction
ADR-010 Schema Versioning
```

## 20. 下一步

在写核心代码前，按以下顺序推进：

1. 对本文进行一次人工架构评审；
2. 找到至少一个外部试点团队；
3. 用手工方式生成一次 Review Summary，验证审查价值；
4. 完成 ADR-001、ADR-002、ADR-003 和 ADR-008；
5. 再创建代码仓库并实现月 1 纵向原型。

如果手工 Evidence Summary 都不能帮助审查者做决定，不应继续建设 Team Service；应先重新定义产品价值。
