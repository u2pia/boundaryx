# AI Native SDLC Control Plane 领域模型

> 状态：Draft v0.1  
> 日期：2026-09-22  
> 目标：定义与实现语言、数据库和具体 Agent 无关的核心领域语义。

## 1. 建模原则

1. **Intent 是变更起点**：没有 Intent 的生产性变更不能被视为受治理变更。
2. **Run 是执行事实**：计划描述预期，Run 记录实际发生的事情。
3. **Evidence 是交付依据**：Artifact 不是成功证明，Evidence 才是。
4. **Decision 必须具名**：需要判断的批准、拒绝和覆盖必须关联 Actor。
5. **Policy 决策确定性执行**：模型可以建议，最终门禁由确定性引擎判断。
6. **所有核心对象可版本化**：Intent、Specification、Policy、Evaluation 和 Agent Profile 都不能原地静默修改。
7. **外部系统通过引用接入**：GitHub Issue、PR、CI Run 等保留外部 ID，不复制其完整领域模型。

## 2. 有界上下文

### 2.1 Intent Management

管理业务目标、范围、约束、验收标准和风险。

### 2.2 Context Supply

管理 Agent 使用的上下文来源、选择、版本、敏感性和授权。

### 2.3 Work Orchestration

管理任务分解、依赖、Actor 分配和执行状态。

### 2.4 Execution Control

管理 Workspace、Agent、Tool、Capability、预算和运行时策略。

### 2.5 Evaluation

管理评估定义、执行、结果、门禁和残余风险。

### 2.6 Evidence & Decision

管理证明材料、批准、拒绝、覆盖和发布关联。

### 2.7 Integration

管理 Git、GitHub、Agent、CI/CD 和未来企业系统的外部引用。

## 3. 核心对象

| 对象 | 类型 | 责任 |
|---|---|---|
| Intent | Aggregate Root | 描述为什么变更以及成功标准 |
| Specification | Entity | 描述系统应表现为什么样 |
| Acceptance Criterion | Value Object | 可验证的完成条件 |
| Risk Assessment | Entity | 描述影响、概率和控制要求 |
| Context Source | Entity | 可提供给 Agent 的信息来源 |
| Context Manifest | Aggregate Root | 一次运行实际使用的上下文清单 |
| Work Graph | Aggregate Root | 工作节点、依赖和责任分配 |
| Work Item | Entity | 可被人、Agent 或程序执行的工作单元 |
| Actor | Entity | 人、Agent 或自动程序的统一身份 |
| Agent Profile | Entity | Agent 能力、限制和运行配置 |
| Capability | Value Object | Actor 被允许执行的抽象能力 |
| Tool | Entity | 可调用的确定性外部能力 |
| Policy | Aggregate Root | 访问、执行、门禁和审批规则 |
| Policy Decision | Entity | 某次策略判断的输入、结果和理由 |
| Run | Aggregate Root | 一次实际执行及其生命周期 |
| Workspace | Entity | 隔离执行环境 |
| Artifact | Entity | 代码、文档、补丁、报告等产物 |
| Evaluation Definition | Aggregate Root | 评估项、阈值和关键性 |
| Evaluation Result | Entity | 实际评估结果和原始证据引用 |
| Evidence Package | Aggregate Root | 支撑交付决策的证据集合 |
| Decision | Entity | 批准、拒绝、覆盖、暂停或取消 |
| Release | Aggregate Root | 进入目标环境的变更集合 |
| Feedback | Entity | 运行结果、缺陷、人工修正和用户反馈 |

## 4. 关系模型

```text
Intent 1 ─── * Specification
Intent 1 ─── * AcceptanceCriterion
Intent 1 ─── 1 RiskAssessment
Intent 1 ─── 1 WorkGraph

WorkGraph 1 ─── * WorkItem
WorkItem * ─── 0..1 Actor
WorkItem * ─── * Capability

Intent 1 ─── * Run
Run 1 ─── 1 ContextManifest
Run 1 ─── 1 AgentProfileSnapshot
Run 1 ─── 1 Workspace
Run 1 ─── * PolicyDecision
Run 1 ─── * Artifact
Run 1 ─── * EvaluationResult

Run 1 ─── 0..1 EvidencePackage
EvidencePackage 1 ─── * EvidenceItem
EvidencePackage 1 ─── * Decision

EvidencePackage * ─── 0..1 Release
Release 1 ─── * Feedback
Feedback * ─── * EvaluationDefinition
```

生产反馈可以转化为新的回归评估定义，也可以触发新的 Intent。

## 5. 关键对象定义

### 5.1 Intent

最小结构：

```yaml
id: INT-0001
version: 1
title: Prevent duplicate refunds
objective: 同一订单不得发生重复退款
owner: user:wangzhen
scope:
  include:
    - refund service
  exclude:
    - payment provider reconciliation
constraints:
  - 不得修改原始支付流水
acceptance_criteria:
  - id: AC-001
    statement: 相同幂等键的重复请求只产生一次退款
    criticality: critical
risk:
  level: high
status: approved
```

#### Intent 不变量

- 必须有 Owner；
- 必须至少有一个验收标准；
- 高风险 Intent 必须定义人工审批要求；
- 执行开始后，Intent 修改必须产生新版本；
- Run 必须固定引用某个 Intent Version。

### 5.2 Context Manifest

```yaml
id: CTX-0001
run_id: RUN-0001
sources:
  - type: repository_file
    uri: src/refund/service.ts
    revision: 9b132ab
    reason: 核心退款实现
    sensitivity: internal
  - type: project_rule
    uri: .ainative/project.yaml
    revision: sha256:...
    reason: 项目规则
generated_at: 2026-09-22T10:00:00+08:00
```

#### Context 不变量

- 每个来源必须有来源标识和版本；
- 敏感来源必须通过访问策略；
- Run 结束后不得静默改变 Manifest；
- 摘要或脱敏不能替代对原始来源的完整引用；
- Agent 实际收到的上下文应与 Manifest 可对账。

### 5.3 Agent Profile

```yaml
id: AGT-coding-default
version: 1
adapter: cli
capabilities:
  - repository.read
  - repository.write.scoped
  - test.execute
limits:
  duration: 60m
  cost: 20 USD
  network: denied
approval_required:
  - dependency.add
  - workflow.modify
```

Agent Profile 描述能力和约束，不保存长期凭证。

### 5.4 Run

```yaml
id: RUN-0001
intent:
  id: INT-0001
  version: 1
agent:
  id: AGT-coding-default
  version: 1
workspace: WSP-0001
status: evaluating
started_by: user:wangzhen
started_at: 2026-09-22T10:05:00+08:00
```

Run 是不可替换的执行事实。重试应产生新的 Attempt；策略要求重新开始时产生新的 Run。

### 5.5 Evaluation Definition

```yaml
id: EVD-refund-default
version: 1
checks:
  - id: build
    type: command
    command: npm run build
    gate: required
  - id: tests
    type: junit
    source: reports/junit.xml
    gate: required
  - id: AC-001
    type: acceptance
    command: npm test -- duplicate-refund
    gate: critical
```

#### Evaluation 不变量

- 每个关键验收标准必须映射至少一个评估项，或记录无法自动评估的原因；
- Critical 评估失败时不得进入 Approved；
- 模型评估不得作为高风险变更的唯一关键证据；
- 覆盖评估失败必须产生显式 Override Decision。

### 5.6 Evidence Package

建议逻辑结构：

```text
EvidencePackage
├── Manifest
├── IntentSnapshot
├── SpecificationSnapshot
├── ContextManifest
├── AgentProfileSnapshot
├── WorkspaceReference
├── ChangeSet
├── ToolExecutionSummary
├── PolicyDecisions
├── EvaluationResults
├── ResidualRisks
├── Decisions
└── Provenance
```

Evidence Package 不是完整运行日志的复制，而是面向交付决策的证明集合。原始日志通过内容摘要和位置引用关联。

## 6. 状态机

### 6.1 Intent 状态

```text
Draft
→ InReview
→ Approved
→ InExecution
→ Delivered
→ Observing
→ Closed
```

补充终态：`Rejected`、`Cancelled`、`Superseded`。

约束：只有 `Approved` Intent 可以创建生产性 Run。

### 6.2 Run 状态

```text
Created
→ Preparing
→ Running
→ Evaluating
→ AwaitingApproval
→ Approved
→ Published
```

异常状态：

```text
Paused
Blocked
Failed
Rejected
Cancelled
Expired
```

关键转换：

- `Preparing → Running`：Workspace、Context 和 Policy 已就绪；
- `Evaluating → AwaitingApproval`：所有 required gate 已产生结果；
- `AwaitingApproval → Approved`：关键评估通过且具名人类批准；
- `Approved → Published`：外部 Git 或发布操作成功并记录引用。

### 6.3 Decision 类型

- Approve；
- Reject；
- Override；
- Pause；
- Resume；
- Cancel；
- Escalate；
- RequestChanges。

每个 Decision 必须包含 Actor、时间、对象、理由和所依据的 Evidence Version。

## 7. 领域事件

建议第一阶段记录以下事件：

```text
IntentCreated
IntentVersioned
IntentSubmitted
IntentApproved
SpecificationAttached
WorkGraphCreated
RunCreated
ContextCompiled
WorkspacePrepared
AgentStarted
ToolRequested
PolicyEvaluated
ToolExecuted
ArtifactProduced
AgentCompleted
EvaluationStarted
EvaluationCompleted
EvidencePackaged
ApprovalRequested
DecisionRecorded
PullRequestCreated
RunPublished
FeedbackReceived
```

每个事件至少包含：

```yaml
event_id: EVT-...
event_type: EvaluationCompleted
occurred_at: 2026-09-22T10:30:00+08:00
actor_id: system:evaluation-engine
aggregate_type: Run
aggregate_id: RUN-0001
correlation_id: RUN-0001
causation_id: EVT-...
schema_version: 1
payload: {}
```

第一阶段不要求完整 Event Sourcing，但必须保留不可变事件日志，以支持审计和未来迁移。

## 8. ID 与引用

建议可读 ID：

| 对象 | 前缀 | 示例 |
|---|---|---|
| Intent | INT | INT-0001 |
| Context Manifest | CTX | CTX-0001 |
| Work Graph | WKG | WKG-0001 |
| Work Item | WIT | WIT-0001 |
| Run | RUN | RUN-0001 |
| Workspace | WSP | WSP-0001 |
| Evaluation | EVL | EVL-0001 |
| Evidence Package | EVP | EVP-0001 |
| Decision | DEC | DEC-0001 |
| Release | REL | REL-0001 |

对外导出时同时提供全局唯一 ID，避免多个本地项目合并后冲突。

## 9. 存储分层

### 9.1 Git 管理

- Intent；
- Specification；
- Acceptance Criteria；
- Policy Definition；
- Evaluation Definition；
- Agent Profile；
- Evidence 摘要；
- Schema。

### 9.2 本地状态库

- Run 状态；
- Event Log；
- Tool Execution Metadata；
- 外部系统同步状态；
- 本地审批状态；
- 内容摘要和索引。

### 9.3 外部或对象存储

- 完整日志；
- 大型测试报告；
- 二进制 Artifact；
- 容器和构建制品；
- 敏感 Trace。

## 10. 必须保持的可追溯链

```text
Intent Version
→ Acceptance Criterion
→ Work Item
→ Run
→ Artifact / ChangeSet
→ Evaluation Result
→ Evidence Package
→ Decision
→ Pull Request / Release
→ Feedback
```

任何环节允许暂时不存在自动化，但不允许通过删除关联来掩盖未知状态。未知、未评估和不适用必须是显式值。

## 11. 后续建模议题

- Work Graph 的并行、补偿和长任务语义；
- Agent 能力声明与真实性验证；
- Context 的数据血缘和撤销；
- 人工审批委托与组织身份；
- 模型评估的置信度与校准；
- Evidence 签名和跨组织传递；
- Release 与生产 Feedback 的统一模型；
- 多仓库 Intent 和跨系统变更。

