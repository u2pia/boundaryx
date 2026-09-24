# AI Native SDLC Control Plane 领域模型

> 状态：Draft v0.2（小团队 · 全周期）
> 日期：2026-09-22
> 目标：定义与实现语言、数据库和具体 Agent 无关的核心领域语义。
> 修订：本版由 **Claude（Opus 5）** 依据 2026-09-22 评审意见改写。v0.1 原稿见 [_original-v0.1/DOMAIN_MODEL.md](_original-v0.1/DOMAIN_MODEL.md)，逐条改动见 [../REVIEW-CHANGES.md](../REVIEW-CHANGES.md)。改动以 `〔C·改〕`、`〔C·新〕`、`〔C·删〕` 标记。
>
> 〔C·说明〕v0.1 的对象集合在个人开发者定位下过度建模，但在小团队定位下**基本成立**：Actor、Capability、Risk Assessment、Work Item、Release、Feedback 都回到了关键路径。因此本版保留其对象结构，主要补齐它缺失的三类语义——**并发与冲突、身份与授权、外部系统的字段所有权**——并修掉一处提权缺陷。

## 1. 建模原则

1. **Intent 是变更起点**：没有 Intent 的生产性变更不能被视为受治理变更。
2. **Run 是执行事实**：计划描述预期，Run 记录实际发生的事情。
3. **Evidence 是交付依据**：Artifact 不是成功证明，Evidence 才是。
4. **Decision 必须具名**：需要判断的批准、拒绝和覆盖必须关联 Actor。
5. **Policy 决策确定性执行**：模型可以建议，最终门禁由确定性引擎判断。
6. **所有核心对象可版本化**：Intent、Specification、Policy、Evaluation 和 Agent Profile 都不能原地静默修改。
7. **外部系统通过引用接入**：GitHub Issue、PR、CI Run 等保留外部 ID，不复制其完整领域模型。
8. 〔C·新〕**外部系统可以是权威来源**：对于团队已有的系统（Issue Tracker、Git 平台），本模型的对象是**附着层**。每个共享字段必须有唯一的所有者，见 §5.2。
9. 〔C·新〕**并发是一等公民**：同一仓库同时存在多个 Run 是常态而非异常。冲突检测与仲裁属于领域语义，不是实现细节。
10. 〔C·新〕**身份不可自证**：Actor 的身份来自外部身份源。本地声明的身份不能作为审批凭据。
11. 〔C·新〕**证明必须可溯源**：每个 Evaluation 必须能回答"这个证明是谁在什么时候造的"。被评估者本次新造的证明，其证明力低于既有证明。

## 2. 有界上下文

### 2.1 Intent Management

管理业务目标、范围、约束、验收标准和风险，并维护与外部 Issue Tracker 的同步。

### 2.2 Context Supply

管理 Agent 使用的上下文来源、选择、版本、敏感性和授权，以及**声明与实际消费的对账**。

### 2.3 Work Orchestration

管理任务分解、依赖、Actor 分配和执行状态。

### 2.4 Execution Control

管理 Workspace、Agent、Tool、Capability、预算和运行时策略。

### 2.5 Evaluation

管理评估定义、执行、结果、门禁、证明来源和残余风险。

### 2.6 Evidence & Decision

管理证明材料、审查、批准、拒绝、覆盖和发布关联。

### 〔C·新〕2.7 Review

管理待审队列、审查者分配、审查负载、退回与返工链。审查是一个有成本、有承载者、会排队、会退化的独立环节，折叠进 Approval 会让它在设计中消失。

### 2.8 Integration

管理 Git、GitHub、Issue Tracker、Agent、CI/CD 和未来企业系统的外部引用。

## 3. 核心对象

| 对象 | 类型 | 责任 |
| --- | --- | --- |
| Intent | Aggregate Root | 描述为什么变更以及成功标准 |
| 〔C·新〕ExternalRef | Value Object | 指向外部系统对象的引用与同步状态 |
| Specification | Entity | 描述系统应表现为什么样 |
| Acceptance Criterion | Value Object | 可验证的完成条件 |
| Risk Assessment | Entity | 描述影响、概率和控制要求 |
| Context Source | Entity | 可提供给 Agent 的信息来源 |
| Context Manifest | Aggregate Root | 一次运行**声明**使用的上下文清单 |
| 〔C·新〕Context Consumption | Entity | 一次运行**实际**读取的上下文记录 |
| Work Graph | Aggregate Root | 工作节点、依赖和责任分配 |
| Work Item | Entity | 可被人、Agent 或程序执行的工作单元 |
| Actor | Entity | 人、Agent 或自动程序的统一身份 |
| 〔C·新〕Identity Binding | Value Object | Actor 与外部身份源主体的绑定 |
| Agent Profile | Entity | Agent 能力、限制和运行配置 |
| Capability | Value Object | Actor 被允许执行的抽象能力 |
| Tool | Entity | 可调用的确定性外部能力 |
| Policy | Aggregate Root | 访问、执行、门禁和审批规则 |
| Policy Decision | Entity | 某次策略判断的输入、结果、理由与**强制类型** |
| Run | Aggregate Root | 一次实际执行及其生命周期 |
| 〔C·新〕Attempt | Entity | Run 内的一次重试；v0.1 提及但未建模 |
| Workspace | Entity | 隔离执行环境 |
| 〔C·新〕Resource Claim | Entity | Run 对分支、路径等可竞争资源的占用声明 |
| Artifact | Entity | 代码、文档、补丁、报告等产物 |
| Evaluation Definition | Aggregate Root | 评估项、阈值和关键性 |
| Evaluation Result | Entity | 实际评估结果、原始证据引用与**证明来源** |
| Evidence Package | Aggregate Root | 支撑交付决策的证据集合 |
| 〔C·新〕Review Assignment | Entity | 某个 Run 的审查责任、时限与状态 |
| Decision | Entity | 批准、拒绝、覆盖、暂停或取消 |
| Release | Aggregate Root | 进入目标环境的变更集合 |
| Feedback | Entity | 运行结果、缺陷、人工修正和用户反馈 |

## 4. 关系模型

```text
Intent 1 ─── 0..1 ExternalRef          〔C·新〕Issue 为权威来源
Intent 1 ─── * Specification
Intent 1 ─── * AcceptanceCriterion
Intent 1 ─── 1 RiskAssessment
Intent 1 ─── 1 WorkGraph

WorkGraph 1 ─── * WorkItem
WorkItem * ─── 0..1 Actor
WorkItem * ─── * Capability

Actor 1 ─── 0..1 IdentityBinding       〔C·新〕人类 Actor 必须有绑定

Intent 1 ─── * Run
Run 1 ─── 1 ContextManifest
Run 1 ─── * ContextConsumption         〔C·新〕声明与事实分离
Run 1 ─── 1 AgentProfileSnapshot
Run 1 ─── 1 Workspace
Run 1 ─── * Attempt                    〔C·新〕
Run 1 ─── * ResourceClaim              〔C·新〕并发仲裁依据
Run 1 ─── * PolicyDecision
Run 1 ─── * Artifact
Run 1 ─── * EvaluationResult

Run 1 ─── 0..1 EvidencePackage
EvidencePackage 1 ─── * EvidenceItem
EvidencePackage 1 ─── * ReviewAssignment   〔C·新〕
EvidencePackage 1 ─── * Decision

EvidencePackage * ─── 0..1 Release
Release 1 ─── * Feedback
EvaluationDefinition * ─── 0..1 Feedback   〔C·改〕derived_from，不再是 m:n
```

〔C·改〕v0.1 的 `Feedback * ─── * EvaluationDefinition` 表达的其实是"这次事故派生出那条回归测试"，是一条派生边而非多对多关联。现改为 EvaluationDefinition 版本上的 `derived_from` 引用。

生产反馈可以转化为新的回归评估定义，也可以触发新的 Intent。

## 5. 关键对象定义

### 5.1 Intent

```yaml
id: 01JBQZ8K3M7Y4V2N            # 〔C·改〕ULID 主键
alias: INT-0001                  # 〔C·改〕可读别名，仅用于展示
version: 1
external:                        # 〔C·新〕权威来源
  system: github
  type: issue
  id: "123"
  url: https://github.com/org/repo/issues/123
  synced_at: 2026-09-22T10:00:00+08:00
title: Prevent duplicate refunds         # owner: external
objective: 同一订单不得发生重复退款        # owner: external
owner: user:wangzhen                      # owner: external
scope:
  include: [refund service]
  exclude: [payment provider reconciliation]
constraints:
  - 不得修改原始支付流水
acceptance_criteria:                      # owner: local
  - id: AC-001
    statement: 相同幂等键的重复请求只产生一次退款
    criticality: critical
risk:                                     # owner: local
  level: high
status: approved
```

#### Intent 不变量

- 必须有 Owner；
- 必须至少有一个验收标准；
- 高风险 Intent 必须定义人工审批要求；
- 执行开始后，Intent 修改必须产生新版本；
- Run 必须固定引用某个 Intent Version；
- 〔C·新〕`external` 存在时，标注为 `owner: external` 的字段不得在本地被覆盖写。

### 〔C·新〕5.2 Intent 与外部 Tracker 的字段所有权

Intent 是 Issue 的结构化附件，不是它的替代品。**制造第二个"我们在做什么"的权威来源是本模型明确禁止的设计。**

| 字段 | 所有者 | 冲突规则 |
| --- | --- | --- |
| 标题、描述、状态、负责人、标签 | 外部 Tracker | 外部胜出，本地只缓存 |
| 验收标准、约束、风险等级 | 本地 | 本地胜出；可选择回写为 Issue 评论 |
| 关联的 Run / Evidence / PR | 本地 | 本地唯一 |

规则：

- 外部对象被删除或关闭时，Intent 进入 `Orphaned`，不得静默消失；
- 同步失败必须是显式状态，不允许"看起来是最新的"；
- 离线模式下允许本地领先，恢复连接时按上表仲裁；
- 不支持 Tracker 的团队可创建纯本地 Intent，但 `external: null` 必须显式。

### 5.3 Context Manifest 与实际消费

```yaml
id: 01JBQZ8M...
alias: CTX-0001
run_id: RUN-0001
declared:
  - type: repository_file
    uri: src/refund/service.ts
    revision: 9b132ab
    reason: 核心退款实现
    sensitivity: internal
  - type: project_rule
    uri: .ainative/project.yaml
    revision: sha256:...
    reason: 项目规则
consumed:                          # 〔C·新〕实际读取
  - uri: src/refund/service.ts
    revision: 9b132ab
    at: 2026-09-22T10:07:11+08:00
  - uri: src/refund/legacy.ts      # 未声明但被读取
    revision: 9b132ab
    at: 2026-09-22T10:07:19+08:00
reconciliation:                    # 〔C·新〕
  undeclared_reads: [src/refund/legacy.ts]
  declared_unread: []
generated_at: 2026-09-22T10:00:00+08:00
```

#### Context 不变量

- 每个来源必须有来源标识和版本；
- 敏感来源必须通过访问策略；
- Run 结束后不得静默改变 Manifest；
- 摘要或脱敏不能替代对原始来源的完整引用；
- 〔C·改〕`declared` 是声明，`consumed` 是事实，二者**不要求相等**，但差异必须被计算并呈现给审查者。

〔C·改〕v0.1 的不变量"Agent 实际收到的上下文应与 Manifest 可对账"在 CLI Agent 自主检索文件的现实下不可达成。把它从"必须相等"改为"必须计算差异"，既可实现，又把差异本身变成审查信息：Agent 读了未声明的文件，往往正是需要看一眼的地方。

### 5.4 Agent Profile

```yaml
id: AGT-coding-default
version: 1
adapter: cli
enforcement: container            # 〔C·新〕none | container | in_loop
capabilities:
  - repository.read
  - repository.write.scoped
  - test.execute
limits:
  duration: 60m
  cost:                           # 〔C·改〕补齐单位与周期
    amount: 20
    currency: USD
    per: run
    source: adapter_reported      # 无法计量时必须显式为 unavailable
  network: denied
approval_required:
  - dependency.add
  - workflow.modify
```

Agent Profile 描述能力和约束，不保存长期凭证。

〔C·新〕`enforcement` 决定该 Agent 下所有 Policy 的强制类型上限：`none` 时所有策略只能是检测性的，证据中必须如实标注。

### 5.5 Run

```yaml
id: 01JBQZ8P...
alias: RUN-0001
intent: {id: ..., version: 1}
agent: {id: AGT-coding-default, version: 1}
workspace: WSP-0001
claims:                            # 〔C·新〕
  - type: branch
    value: feat/dedupe-refund
  - type: path_prefix
    value: src/refund/
status: evaluating
started_by: user:wangzhen
started_at: 2026-09-22T10:05:00+08:00
```

Run 是不可替换的执行事实。重试产生新的 Attempt；策略要求重新开始时产生新的 Run。

### 5.6 Evaluation Definition

```yaml
id: EVL-refund-default            # 〔C·改〕前缀与 §8 对齐（v0.1 表里是 EVL、示例写 EVD）
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
    provenance: pre_existing      # 〔C·新〕pre_existing | added_by_run | modified_by_run
derived_from: null                # 〔C·新〕指向触发它的 Feedback
```

#### Evaluation 不变量

- 每个关键验收标准必须映射至少一个评估项，或记录无法自动评估的原因；
- Critical 评估失败时不得进入 Approved；
- 模型评估不得作为高风险变更的唯一关键证据；
- 覆盖评估失败必须产生显式 Override Decision；
- 〔C·新〕每个评估项必须有 `provenance`。**`added_by_run` 或 `modified_by_run` 的评估项不得作为某条 critical 验收标准的唯一证据**；
- 〔C·新〕AC ↔ 评估项的映射由人或确定性规则建立。若由模型建议，必须标记为未确认，且不得使门禁通过。

〔C·新〕最后两条针对的是 agentic SDLC 最常见的真实失效：Agent 同时编写实现和证明它正确的测试。形式上完全合规，实质上自己判卷。作者本人可能凭直觉察觉，接手审查的同事没有这个直觉。

### 5.7 Evidence Package

逻辑结构：

```text
EvidencePackage
├── Manifest
├── ReviewSummary            〔C·新〕面向审查者的首屏：读什么、看哪里、风险在哪
├── IntentSnapshot
├── SpecificationSnapshot
├── ContextManifest + Reconciliation   〔C·改〕
├── AgentProfileSnapshot
├── WorkspaceReference
├── ChangeSet
├── ToolExecutionSummary
├── PolicyDecisions          含预防性/检测性标注 〔C·改〕
├── EvaluationResults        含 provenance 标注 〔C·改〕
├── ResidualRisks
├── ReviewAssignments        〔C·新〕
├── Decisions
└── Provenance
```

Evidence Package 不是完整运行日志的复制，而是面向交付决策的证明集合。原始日志通过内容摘要和位置引用关联。

〔C·新〕设计约束：**ReviewSummary 必须能在 3 分钟内读完，并且能独立回答"要不要展开看细节"。** 第一阶段的主要呈现形态是 GitHub PR 评论与 Check，而不是本项目自有界面。

### 〔C·新〕5.8 Review Assignment

```yaml
id: RVA-0001
run_id: RUN-0001
assignee: user:bob
assigned_at: ...
due_at: ...
status: pending            # pending | in_review | changes_requested | approved | expired | reassigned
evidence_opened_at: null   # 用于计算证据展开率
time_spent_seconds: null   # 用于计算审查人时
```

不变量：

- 默认 `assignee != Run.started_by`，自审需要显式策略允许并记录理由；
- 同一 Run 的有效 Assignment 至多一个，重新分配产生新记录；
- `evidence_opened_at` 为空的 Approve 决策必须被标记——它是橡皮章审批的直接观测量。

### 〔C·新〕5.9 Resource Claim 与并发仲裁

同一仓库并行多个 Run 是常态。仲裁规则：

| 冲突类型 | 检测 | 处理 |
| --- | --- | --- |
| 同一分支 | 分支名占用 | 拒绝第二个 Run |
| 路径重叠 | path_prefix 交集 | 允许但标记为 `contended`，证据中呈现；合并顺序由人决定 |
| Intent 规格矛盾 | 同一文件被两个 Intent 的约束覆盖且约束冲突 | 阻塞并升级人工 |
| 目标分支已前进 | 基线 revision 与当前 HEAD 不一致 | 要求 rebase 并重跑关键门禁 |

不变量：Claim 在 Run 进入终态时释放；进程异常退出后的 Claim 必须可被超时回收。

### 〔C·新〕5.10 Actor 与身份

```yaml
id: user:wangzhen
kind: human                 # human | agent | system
identity:
  provider: github
  subject: "wangzhen"
  verified_at: ...
capabilities: [intent.approve, run.start, policy.edit]
```

不变量：

- `kind: human` 且参与 Decision 的 Actor 必须有 `identity.provider` 非空；
- 本地配置文件中声明的身份**不能**作为审批凭据（第一阶段用 GitHub OAuth）；
- Agent Actor 不得持有 `*.approve` 类 Capability；
- Capability 的授予本身是需要审批的变更。

## 6. 状态机

### 6.1 Intent 状态

```text
Draft → InReview → Approved → InExecution → Delivered → Observing → Closed
```

补充终态：`Rejected`、`Cancelled`、`Superseded`、〔C·新〕`Orphaned`（外部 Issue 被删除或关闭）。

约束：只有 `Approved` Intent 可以创建生产性 Run。

### 〔C·改〕6.2 Run 状态

```text
Created → Preparing → Running → Evaluating → InReview → Approved
        → PullRequestOpen → Merged → Released
```

异常与分支状态：

```text
Paused  Blocked  Failed  Rejected  Cancelled  Expired
ChangesRequested        退回作者，产生新 Attempt
Contended               与其他 Run 资源竞争，待人工排序
Stale                   基线已前进，需 rebase 并重跑门禁
Reverted                合并后被回滚
```

关键转换：

- `Preparing → Running`：Workspace、Context 和 Policy 已就绪，Resource Claim 已获得；
- `Evaluating → InReview`：所有 required gate 已产生结果，Evidence 已生成并渲染；
- 〔C·新〕`InReview → ChangesRequested`：审查者退回，必须带理由，产生 Feedback 与新 Attempt；
- `InReview → Approved`：关键评估通过且具名非作者批准；
- 〔C·新〕`Approved → PullRequestOpen → Merged`：拆开 v0.1 的 `Published`——它把"PR 已创建"和"已合并"混为一谈，而一个全部产出就是 PR 的产品，恰恰最需要建模 PR 之后发生的事；
- 〔C·新〕`Merged → Released → (Feedback)`：全周期后半段的最小形态；
- 〔C·新〕`Merged → Reverted`：回滚必须是状态而不是删除记录。

### 〔C·新〕6.3 Release 状态

```text
Planned → Deploying → Live → Observing → Stable
异常：Failed、RolledBack
```

v0.1 让 Release 成为聚合根却没有状态机，"全周期"定位下这条不能空缺。

### 6.4 Decision 类型

Approve、Reject、Override、Pause、Resume、Cancel、Escalate、RequestChanges。

每个 Decision 必须包含 Actor、时间、对象、理由和所依据的 Evidence Version。〔C·新〕Approve 类型额外必须包含 `evidence_opened`（布尔）与审查耗时。

## 7. 领域事件

```text
IntentCreated              IntentVersioned           IntentSubmitted
IntentApproved             IntentSyncFailed 〔C·新〕  SpecificationAttached
WorkGraphCreated           RunCreated                ResourceClaimed 〔C·新〕
ResourceContended 〔C·新〕  ContextCompiled           ContextConsumed 〔C·新〕
WorkspacePrepared          AgentStarted              ToolRequested
PolicyEvaluated            ToolExecuted              ToolBlocked 〔C·新〕
ArtifactProduced           AgentCompleted            AttemptStarted 〔C·新〕
EvaluationStarted          EvaluationCompleted       EvidencePackaged
ReviewAssigned 〔C·新〕     EvidenceOpened 〔C·新〕    ChangesRequested 〔C·新〕
ApprovalRequested          DecisionRecorded          PullRequestCreated
PullRequestMerged 〔C·新〕  ReleaseStarted 〔C·新〕     RunPublished
FeedbackReceived           EvaluationDerived 〔C·新〕
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

第一阶段不要求完整 Event Sourcing，但必须保留不可变事件日志。〔C·新〕`EvidenceOpened` 与 `DecisionRecorded` 的配对是证据展开率的数据来源，属于核心指标链路，不是可选埋点。

## 〔C·改〕8. ID 与引用

〔C·改〕v0.1 使用 `INT-0001` 这样的顺序编号，而这些对象存放在 Git 目录中：两个分支各创建一个 Intent 会立刻撞号，且本地 ID 就是文件名，无法靠"导出时再生成全局 ID"补救。

规则：

- **主键**：ULID（时间有序、无需协调、可排序）；
- **可读别名**：`INT-0001` 形式，仅用于展示与人际沟通，不作为引用键；
- 别名在单仓库内由服务分配，合并冲突时允许重号，因为它不承担唯一性职责。

| 对象 | 前缀 | 示例 |
| --- | --- | --- |
| Intent | INT | INT-0001 |
| Context Manifest | CTX | CTX-0001 |
| Work Graph | WKG | WKG-0001 |
| Work Item | WIT | WIT-0001 |
| Run | RUN | RUN-0001 |
| Attempt〔C·新〕 | ATT | ATT-0001 |
| Workspace | WSP | WSP-0001 |
| Evaluation | EVL | EVL-0001 |
| Evidence Package | EVP | EVP-0001 |
| Review Assignment〔C·新〕 | RVA | RVA-0001 |
| Decision | DEC | DEC-0001 |
| Release | REL | REL-0001 |
| Policy〔C·新〕 | POL | POL-0001 |
| Agent Profile〔C·新〕 | AGT | AGT-coding-default |

## 9. 存储分层

### 9.1 Git 管理

Intent、Specification、Acceptance Criteria、Policy Definition、Evaluation Definition、Agent Profile、Evidence 摘要、Schema。

### 〔C·新〕9.1.1 自我提权防护

Policy 与 Agent Profile 存放在 Git 中，而 Agent 具有仓库写权限，因此**Agent 可以修改约束自己的规则**。这是 v0.1 未处理的提权路径。规则：

- `.ainative/policies/`、`.ainative/agents/`、`.ainative/evaluations/` 默认在容器层面对 Agent 只读；
- 对上述路径的任何变更进入独立审批流，且不得由提出变更的同一 Run 的产物自证；
- 策略文件的生效版本由服务端记录哈希，与仓库内容不一致时 Run 拒绝启动；
- 评估定义的修改与实现变更出现在同一个 Run 时，必须在证据中显著标注。

### 9.2 团队状态库（单节点，SQLite）

Run 状态、Event Log、Tool Execution Metadata、外部系统同步状态、审批与审查状态、Resource Claim、内容摘要与索引。

〔C·改〕v0.1 称其为"本地状态库"。团队定位下它是**共享服务的状态库**，运行在团队自己的机器上；见 [PRODUCT_CHARTER.md](PRODUCT_CHARTER.md) §7.1–7.2。第一阶段不引入需要独立运维的基础设施。

### 9.3 外部或对象存储

完整日志、大型测试报告、二进制 Artifact、容器与构建制品、敏感 Trace。

## 10. 必须保持的可追溯链

```text
Intent Version → Acceptance Criterion → Work Item → Run → Attempt
→ Artifact / ChangeSet → Evaluation Result (+provenance)
→ Evidence Package → Review Assignment → Decision
→ Pull Request → Merge → Release → Feedback → (新 Evaluation 或新 Intent)
```

任何环节允许暂时不存在自动化，但不允许通过删除关联来掩盖未知状态。未知、未评估和不适用必须是显式值。

〔C·改〕相比 v0.1 补入 Attempt、provenance、Review Assignment、Merge 与反馈回流闭合——这条链的完整闭合就是"全周期"在领域模型中的定义。

## 11. 后续建模议题

- Work Graph 的补偿与长任务语义（并行已在 §5.9 处理）；
- Agent 能力声明与真实性验证；
- Context 的数据血缘与撤销；
- 人工审批委托与组织身份；
- 模型评估的置信度与校准；
- Evidence 签名与跨组织传递；
- 多仓库 Intent 与跨系统变更；
- 〔C·新〕审查者分配算法（负载、领域熟悉度、风险匹配）；
- 〔C·新〕Schema 版本迁移与向后兼容规范。
