# AI Native SDLC Control Plane v0.4 增量设计

> 日期：2026-09-22  
> 基线：`CONTROL_PLANE_DESIGN_V0.3.md`  
> 状态：原型验证中

## 1. 变更原因

v0.3 已经建立 Intent、Context、Run、Evaluation、Evidence、Review、Release 和 Feedback 的领域主干，但产品界面仍然偏向“一次变更的治理记录”。

结合 Anthropic 2026 Agentic Coding Trends、Context Engineering、Agent Evals 和 Containment 实践，v0.4 将产品进一步调整为：

> 管理人类意图、Agent 工作流、有限上下文、可重复评估和生产学习闭环的研发控制平面。

## 2. 生命周期修订

```text
Intent
→ Context Engineering
→ Agent / Workflow Execution
→ Tests + Docs
→ Evaluation
→ Evidence
→ Human Review
→ Ship
→ Observe
→ Learn / Remediate ↺
```

重要变化：

- `Context` 从静态输入对象升级为动态工程过程；
- `Execution` 同时覆盖简单 Workflow 与 Autonomous Agent；
- `Tests + Docs` 成为独立产物阶段；
- `Evaluation` 从 Run 附属结果升级为团队级资产；
- `Observe` 与 `Learn / Remediate` 成为正式产品路径；
- `Feedback` 必须可以派生 Intent、Regression Task、Policy Change 或 Revert Proposal。

## 3. 新增领域能力

### 3.1 Context Engineering

新增概念：

```text
ContextStrategy
ContextBudget
ContextCompaction
ContextNote
ContextRetrieval
ContextIsolation
```

必须记录：

- 为什么加载某项上下文；
- 何时加载；
- 原始内容摘要与 Digest；
- 是否经过压缩；
- 哪个 Agent / Worker 可见；
- 实际消费与声明差异；
- 敏感性与信任等级。

### 3.2 Execution Strategy

新增 `ExecutionStrategy`：

```yaml
mode: prompt_chain | routing | parallel | orchestrator_workers | evaluator_optimizer | autonomous_agent
selection_reason: string
workers:
  - role: code | test | docs | security | research
    context_scope: string
    tools: []
    budget: {}
```

原则：从最简单结构开始，只有在 Eval 证明收益时增加 Agent 和编排复杂度。

### 3.3 Evaluation System

Evaluation 领域拆分为：

```text
EvalSuite
EvalTask
Trial
Grader
GraderResult
Transcript
ReferenceSolution
Regression
```

失败结果必须额外产生 `EvaluationDiagnosis`，不能直接把 `failed` 等同于 Agent 能力不足：

```yaml
category: agent | task | grader | harness | infrastructure
confidence: 0..1
evidence_refs: []
transcript_reviewed: boolean
environment:
  clean_start: boolean
  shared_state_detected: boolean
  image_digest: string
```

诊断必须跟随同一 Suite 的 `evaluation_completed`，置信度必须有界且每项归因必须引用证据；Release Gate 与 Regression 回流只能消费该统一诊断事件。

核心指标：

- `pass@k`：k 次尝试至少一次成功；
- `pass^k`：k 次尝试全部成功；
- Grader false positive / false negative；
- Regression escape rate；
- Transcript review rate；
- Task ambiguity rate。

当前原型已把 Regression Trial 从聚合计数升级为可追溯记录：每个 Trial 保留 Batch、Seed、耗时、结果和失败原因。首批结果用于暴露 `pass@3` 与 `pass³` 的可靠性差距，后续批次用于验证修复是否从“至少一次成功”提升为“连续稳定成功”；历史批次不得被新结果覆盖。

### 3.3.1 Context Operations

Context Engineering 已从页面配置升级为追加写事件：

- `context_scope_created` 为 Code、Test、Docs Worker 分配独立 Allowed Sources 与 Token Budget；
- `context_requested` 与 `context_consumed` 区分访问意图和真实模型消费；
- `context_note_written` 持久化 plan、finding、decision 与 open question；
- `context_compacted` 记录压缩前后 Token、策略、保留 Note 引用与摘要 Digest；
- Compaction 必须发生在可恢复 Checkpoint 和 Evaluation 之前，确保长任务恢复时使用高信号状态而不是完整历史回放。

### 3.4 Three-layer Containment

Policy 不再只是一组 YAML 规则，必须映射到：

1. Environment；
2. Model；
3. External Content。

### 3.5 GitHub 权威投影

GitHub 集成遵循“权威不复制”原则：

- Issue 标题、状态、负责人和讨论由 GitHub 持有，Control Plane 维护 Intent、AC、Eval 与 Evidence 投影；
- PR Head SHA、代码、Checks 与 Review Decision 由 GitHub 持有，Control Plane 保存按 Head SHA 绑定的只读快照；
- Control Plane 可向 PR 回写 Run ID 与 Evidence Package URI，但不得用内部状态覆盖 GitHub Review Decision；
- 任一失败 Check、未完成 Check 或 Changes Requested 都必须阻断生产授权；
- Head SHA 变化意味着候选内容变化，旧生产授权自动失效，必须重新评估和具名批准；
- 生产授权同时要求 Evidence Repository 复验成功；Candidate ID、Head SHA 与 Evidence Package 三者必须形成同一不可复用授权目标。

### 3.6 Human Governance 与权限边界

Human-governed 不能退化为“页面上有一个审批按钮”。当前原型采用外部身份绑定的角色权限模型：

- Owner 可管理团队、批准 Run、评审变更并授权生产；
- Maintainer 可处理 Run Gate 与变更评审，但生产授权仍需 Owner；
- Reviewer 可处理 Run Gate 与变更评审，不可修改治理边界或授权生产；
- Developer 可启动和执行研发工作，不可产生任何具名审批决定；
- UI 禁用状态仅用于解释，Reducer 必须再次校验角色能力，防止绕过前端；
- 审批账本记录 `github:*` 外部 Identity，Agent 身份不能替代人类责任主体；Run Gate、Review、Production 授权均保存决策时 Identity，界面切换当前操作者不得改写历史责任主体；Evidence Package 必须投影同一审批身份链。

### 3.7 Deterministic Runtime Budget

Model / Harness / Sandbox / Session 解耦之后，资源预算也必须从提示词约束升级为确定性 Guard：

- Harness 通过 `usage_reported` 上报累计 Input/Output Tokens、Tool Calls、Elapsed Time 与 Estimated Cost；
- 低于阈值继续执行，达到 80% 预警阈值要求 Checkpoint，任一硬上限超出要求 Terminate；
- Budget Decision、原因和动作进入 Session 摘要链与 Evidence Package；
- Exceeded 状态进入人工门禁，Agent 无权通过文本声明忽略预算；
- Policy、Run Detail 与 Transcript 必须消费同一 Usage Event，避免多套数字。

### 3.8 Interrupted Session Recovery

长任务恢复必须覆盖浏览器、Harness 或执行进程在终态前消失的情况：

- 持久状态中缺少 `run_completed` 的 Run 在重新加载时标记为 Interrupted，而不是继续显示为活动中；
- Interrupted Run 禁止进入运行门禁、变更评审或发布；
- 有 Checkpoint 时，先为父 Run 追加 `cancelled` 终态并封存 Evidence，再启动绑定新 Sandbox 的恢复 Run；
- 无 Checkpoint 时，同样先安全封存父 Run，再从 Intent/Context 重新开始；
- Evidence Repository 可用 Store 中的合法事件链重建 Draft，以兼容升级前未写入独立 Repository 的 Session。

### 3.9 Work Contract 与独立 Evaluator

Intent 进入执行前，Control Plane 必须建立可验证的 Work Contract，而不是让 Agent 直接从自然语言目标跳到实现：

其上游规划链为：

```text
Roadmap(goal, milestones, digest)
→ Sprint(objective, milestone_ids, task_ids, reset_boundary)
→ Execution Plan
→ Work Contract
→ Generate / Evaluate
→ Roadmap Update(feedback refs, milestone updates, next sprint objective)
```

Managed Run 必须按上述顺序执行；Evaluation Diagnosis 之后必须更新 Roadmap 才能结束。Roadmap Update 使用独立 Digest 链绑定前一版本与当前反馈，防止 Planner 在不同 Run 之间无痕改写长期目标。

```yaml
contract_id: string
intent_version_id: string
generator_ref: string
objective: string
criteria:
  - id: string
    statement: string
    verifier: deterministic | model | human
    criticality: critical | required | advisory
non_goals: []
contract_digest: string
review:
  evaluator_ref: string
  decision: accepted | revision_required
  findings: []
```

控制不变量：

- Work Contract 必须在 Worker Scope、工具执行和产物生成之前确认；
- Generator 与 Evaluator 必须是不同责任主体，生成者不得自我批准；
- 提议与评审必须引用同一 Contract ID 和 Digest；
- `revision_required`、自我批准或摘要不一致进入人工门禁；
- 未独立确认的契约不得获得生产授权；
- Contract 提议、评审与最终责任主体进入 Transcript、Evidence Package 和追溯链。

这些约束不能只依赖 Adapter 自觉。`validateEventProtocol` 与摘要链校验并列成为 Store、内存 Evidence Sink 和离线 Evidence Repository 的强制入口：即使攻击者重新计算了每个 Event Digest，只要 Harness Selection、Work Contract、Execution 或 Context Reset 的语义顺序非法，事件仍被拒绝且不能封存 Evidence。

Harness 复杂度与 Context Reset 策略现已进入控制面：`HarnessPolicy` 使用模型上下文能力、独立 Evaluator 约束、成本上限和候选 Eval 可靠性选择 Profile；`harness_profile_selected` 固化全部候选的可靠性、P95、成本、Reset Policy、Evidence Ref 以及最终选择原因，Evaluation 页面提供可审计 Ablation 对比；`context_reset_decided` 再按 Token 压力、阶段边界和 Evaluator Feedback 选择 `continue / compact / fresh_session`。当前候选分数仍是 Mock Ablation 数据，后续必须由真实 Trial 聚合替换，避免把某个当前有效的 Harness 永久硬编码为平台真理。

每次 Run 记录：

```yaml
blast_radius: workspace | repository | organization | staging | production
production_write: denied | approval_required | allowed
external_content_trust: trusted | mixed | untrusted
model_guard_status: passed | warned | blocked
environment_enforcement: container | vm | hardened
```

Context Request / Consumption 必须额外记录：

```yaml
trust: trusted | mixed | untrusted
sensitivity: public | internal | restricted | sensitive
```

被拒绝的请求只能产生 `context_requested + policy_decided(deny)`，不能产生 `context_consumed`。Approval Load 需要作为治理指标，低风险确定性决策自动执行，只把不可逆、高影响动作路由给人。

### 3.5 Learning Loop

新增：

```text
ProductionSignal
FeedbackCluster
Incident
RemediationProposal
LearningOutcome
```

允许的回流动作：

- 创建新 Intent；
- 添加或更新 Regression Task；
- 修改 Context Source；
- 修改 Policy；
- 生成 Revert Proposal；
- 关闭噪声信号。

Agent 可以自动收集证据、提出归因和准备修复，但生产写操作仍遵循风险策略和具名审批。

### 3.5.1 Deployment Provider

Production 授权不能停留在“可以部署”标签。部署请求必须绑定：

```yaml
release_candidate_id: string
environment: production
head_sha: string
evidence_uri: string
approved_by: github:*
```

Deployment Provider 返回 Deployment ID、Provider ID、状态、开始/完成时间、Artifact Digest 与 Rollback Ref。Reducer 再次校验 Candidate、Head、Evidence 和历史审批身份，避免绕过 Release Gate 直接写生产。回滚请求必须绑定原 Deployment、Candidate 与 Rollback Ref，并由具备 Production 权限的 `github:*` 身份发起；结果保留 Rollback ID 与 Restored Artifact Digest。当前实现是 Mock Provider，真实系统需通过独立 Adapter 接入。

### 3.6 Managed Agent Runtime

运行时拆分为四个可独立替换、审计和恢复的绑定：

```text
Model / Brain
Harness / Hands
Sandbox
Session / Append-only Event Log
```

每次 Run 启动时必须产生 `runtime_bound` 事件，记录：

```yaml
model_ref: string
harness_ref: string
sandbox_ref: string
session_ref: string
append_only_log: true
```

设计约束：

- 模型升级不能隐式改变 Harness、工具权限或 Sandbox；
- Harness 升级必须可独立回归评估；
- Sandbox 是实际执行边界，不能用 Prompt 或审批替代；
- Session 不依赖单个进程，应支持恢复、重放、迁移和完整性验证；
- Transcript、Evidence 和审计事件都从同一 Session 事件流派生。

Managed Run 在 `runtime_bound` 后必须追加 `sandbox_attested`：

```yaml
sandbox_ref: string
attestor_ref: string
isolation: container | vm | hardened_process
workspace_root: string
writable_paths: []
readonly_paths: []
network_egress: denied | allowlist | unrestricted
allowed_hosts: []
secret_mounts: []
ephemeral: boolean
status: verified | failed
attestation_digest: string
```

只有 `verified + ephemeral + 非 unrestricted egress + 0 secret mounts` 才满足原型最小环境边界。Attestation 必须位于 Runtime Binding 与 Harness Selection 之间，并进入 Policy、Release、Transcript 和 Evidence；当前实现使用 Mock Attestor，后续需由真实容器 / VM Runtime 生成并签名。

Session Event 使用摘要链：

```yaml
sequence: integer
previous_event_digest: string
event_digest: string
```

任何序列跳跃、前序摘要不一致或事件摘要不匹配，都必须使 Run 进入完整性失败状态，并阻断检查点恢复、人工门禁、变更评审和发布。

## 4. Workbench 信息架构

```text
工作区
├── 总览
├── Intents
├── 上下文
├── Agent Runs
├── 评审队列
└── 发布

控制面
├── 评估
├── 证据中心
├── 追溯
├── 策略
├── 反馈闭环
├── 集成
├── 团队
└── 度量
```

## 5. v0.4 原型验收标准

- 总览能够表达十阶段学习闭环；
- Context 页面同时展示静态 Manifest 与动态策略；
- Run 页面表达 Orchestrator / Worker / Evaluator；
- Run Detail 能阅读 Plan、Transcript、Tests、Docs 和 Evidence；
- Run 页面能显示 Model、Harness、Sandbox 和 Session 的绑定关系；
- Evaluation 页面区分 Suite、Task、Trial、Grader、Transcript 与 Regression；
- Policy 页面展示三层边界与 Blast Radius；
- Feedback 页面能把信号转换为 Intent 或 Regression；
- Release 页面能表达门禁、具名授权、环境推进和回滚计划；
- Traceability 页面能串联对象关系、Actor、Policy Decision、Digest 和领域事件；
- Integration 页面能表达 GitHub、Agent、CI、通知、模型和离线边界；
- Feedback 创建的 Intent / Regression 能跨页面出现，并产生领域事件与通知；
- 发布审批、信号回流和通知状态能够持久化并通过状态机测试；
- 所有高风险动作保留明确人工批准入口。

## 6. Adapter Contract 原型

工作台已增加可执行的 `AgentAdapter` 合同，覆盖：

- Execution Mode 与 Capability 声明；
- Run Request、预算与 Workspace 引用；
- Context Consumption 与 Tool Request；
- Policy Decision；
- Patch、Test、Documentation 和 Report Artifact；
- JUnit、SARIF 与 LCOV 的归一化 CI Evidence；
- Evaluation Completion；
- 顺序化、可追溯的 Run Event。

Mock Adapter 测试验证：

- Run 必须以 `run_started` 开始，以 `run_completed` 结束；
- Event Sequence 连续且 Run ID 不漂移；
- 未声明的敏感上下文读取被预防性阻断；
- Tests 与 Documentation 作为一等 Artifact；
- CI 报告保留来源、工具、归一化摘要、状态与内容 Digest，失败状态触发人工运行门禁；
- Harness Profile 必须基于候选 Eval 证据选择，并在规划前产生；
- Roadmap、Sprint、Plan 与 Work Contract 按受控顺序绑定；
- Generator 不能自我批准 Work Contract，Managed Execution 必须等待独立确认；
- Evaluation Result 与 Failure Diagnosis 在 Run 完成前产生；
- Planner 必须在 Diagnosis 后、Run 完成前更新 Roadmap；
- Context Compaction 必须由确定性 Reset Decision 授权；
- `runtime_bound` 在规划与工具执行前产生，Session 使用追加写日志。

### Evidence Repository 原型

事件证据不直接写入工作台状态。当前原型先经过 `LocalEvidenceRepository`：

- 对每个追加事件验证 Run ID、Sequence、`previousEventDigest` 与 `eventDigest`；
- 同时验证 Harness、Roadmap、Sprint、Work Contract、Context Reset、Evaluation Diagnosis 与 Roadmap Update 的运行协议；
- 摘要链无效时拒绝追加，避免 UI、门禁和审计账本消费被篡改事件；
- 仅在 `run_completed` 终态且整条链再次验证通过后生成 `local://` Package URI 与 Digest；
- Package 独立保存在浏览器本地仓库，刷新后重新加载事件、验证摘要链并核对包摘要；
- 仓库内容或摘要被篡改时，已持久化的可信状态必须降级为复验失败；
- Run Drawer、证据中心与 Traceability 共享同一个封存投影；
- 浏览器导出的可移植 Evidence Package 使用 SHA-256 内容摘要；内存 Sink 当前使用 FNV-1a 原型校验和，不代表密码学签名。

当前本地仓库用于验证离线恢复和仓库边界，并不具备真正不可变或 WORM 语义。后续将通过同一合同替换为对象存储、WORM Bucket、企业制品库或企业离线 Evidence Repository，而不改变 Run 状态机和页面消费方式。

## 7. 不变原则

- 不替代 GitHub、Issue Tracker、CI/CD 和可观测平台；
- 不用 Agent 自我声明代替确定性证据；
- 不把模型评分作为高风险变更的唯一证据；
- 不因多 Agent 更先进而默认使用多 Agent；
- 不用高频审批掩盖边界缺失；
- 不自动执行未经策略授权的生产写操作。

## 8. 同类产品借鉴与 Provider Catalog

Control Plane 将同类产品对标从阶段性调研升级为持续治理机制，详细雷达见 `PRODUCT_PRACTICE_RADAR_2026-09.md`。

当前首先落地 Backstage 式声明目录，但不建设通用开发者门户。Provider Catalog 记录：

- 稳定 Provider Contract；
- `Adopt / Integrate / Reference / Build` 决策；
- `prototype / next / research` 生命周期；
- Embedded、Self-hosted、Managed 部署方式；
- Offline Readiness；
- 借鉴机制与明确不照搬项；
- 每种 Provider 必须产生的 Evidence Boundary。

Workbench 集成页展示同一 Catalog，并用独立 Smoke Test 防止目录退化为静态展示。首轮覆盖 GitHub/GitLab、Agent Runtime、Sandbox、Durable Workflow、Eval/Trace、Policy、Evidence/Attestation 与 Deployment。

Temporal 与 LangGraph 的 Durable Workflow 实践已经进入原型：Managed Run 在 Harness Selection 后、Roadmap 前产生 `workflow_bound`，固定 Workflow ID、Provider、Task Queue、Replay Mode、Human Resume、Idempotency Key 与 Retry Policy。Tool Side Effect 被包装为 Activity Attempt；失败、重试调度和完成均是事件协议的一部分。

协议不变量包括：

- 第一次 Activity 必须从 Attempt 1 开始；
- Retry 必须由可重试失败显式授权，Attempt 连续且不超过 Policy 上限；
- 所有 Attempt 必须保持相同 Idempotency Key；
- Policy Denied、Permission Denied 与 Invalid Input 不得重试；
- Run 结束时不能存在 Open 或 Scheduled Activity；
- Workflow、Activity 与 Retry 进入 Transcript 和 Evidence Package。

当前已新增 `LocalWorkflowProvider`，与 Evidence Repository 和 UI Store 分离：

- Workflow Repository 保存原始 Run Request、Event History、Chain Head、Workflow/Provider Ref、运行状态、恢复次数与独立 Record Digest；
- 相同 Event Digest 的重复追加幂等，Sequence 相同但 Digest 不同的冲突追加被拒绝；
- 浏览器 Reload 会把仍为 Running 的记录标记为 Interrupted，并以 Workflow Repository 中较新的事件历史恢复 UI 投影；
- `recover()` 返回 Next Sequence、Previous Event Digest 和最近 Checkpoint，且未显式 Recover 的 Interrupted Workflow 不允许继续追加；
- 完成态、开放态和被篡改记录均由独立测试验证。

当前持久化仍基于浏览器 `localStorage`，不具备多进程并发、锁、租约、原子事务或真正跨机器故障恢复。下一步通过同一 `WorkflowProvider` Contract 替换为 SQLite / Durable Queue；Temporal 或 LangGraph 仍保持 Adapter 选择，而不是核心依赖。

### 8.1 Evidence Attestation

参考 in-toto 与 Sigstore 的“声明、签名、验证、身份信任分层”后，原型新增 `AttestationProvider`：

- Statement 使用 in-toto v1 结构；
- Subject 使用 Evidence Repository Record 的 SHA-256，而不是 FNV 原型校验和；
- Predicate 绑定 Run ID、Evidence URI、Repository Digest、Chain Head、Event Count 与 Workflow ID；
- Envelope 使用 DSSE 预认证编码，签名算法为 Web Crypto ECDSA P-256 / SHA-256；
- Reducer 再次验证 Statement 是否绑定当前 Evidence Package，防止“签名有效但签错对象”；
- Signature、Subject Digest、Payload 与 Predicate Binding 任一失败都会降级为 Attestation 复验失败。

当前签名身份为 `local://ephemeral-key`，公钥随 Attestation 一起保存，因此只能证明“该 Payload 与该临时密钥一致”，不能证明企业身份、构建服务身份或透明日志存在。界面必须显示 `identity unanchored`，生产发布门禁暂不依赖该签名。后续通过相同 Contract 接入企业 KMS/PKI 或 Sigstore，并补充 Certificate Chain、OIDC Identity 和 Transparency Log Proof。

### 8.2 Policy Decision Provider

参考 OPA/Cedar 的 Policy Decision / Enforcement 分离，策略判断已从 `MockAgentAdapter` 中移出：

- `PolicyDecisionProvider` 接收标准化输入并返回 Allow、Deny 或 Require Approval；
- `policy_bundle_bound` 固化 Provider、Bundle ID、Version、规则清单、Default Deny 与 Bundle Digest；
- Managed Planning 缺少有效 Bundle 时，运行协议直接失败；
- 每个 Tool Activity 的 Policy Decision 必须绑定当前 Bundle Version，并保存完整输入摘要；
- Secrets、Sensitive Context 与 Untrusted External Content 预防性拒绝；
- Network Egress 使用 Sandbox Allowlist；
- Production Write 缺少 `github:*` 具名身份时返回 `require_approval`；
- Reducer 继续承担 Work Contract、Evidence、审批身份等结构性不变量，不把整个业务状态机改写成策略规则。

当前 Provider 是内置确定性规则集，尚未执行 Rego/Cedar，也没有 Bundle Distribution、Decision Log Export 或企业 Policy Authoring。后续可通过相同 Contract 接入 OPA 或 Cedar，并使用当前 Smoke Test 作为兼容基线。

### 8.3 Evaluation Experiment Binding

参考 Langfuse 与 Phoenix 的 Dataset / Experiment / Trace 关联方式，Managed Evaluation 不再只产生聚合通过率：

- `EvaluationProvider` 绑定版本化 Dataset、Candidate、Trace、Grader Inventory、Trial Count 与 Environment Digest；
- `evaluation_experiment_bound` 必须发生在 Evaluation Result 之前；
- Experiment Digest 使用规范化内容计算并进入事件链；
- Result 的 Passed/Failed/Unknown 总数必须等于 Bound Trial Count；
- Evaluation Diagnosis 的 Image Digest 必须与 Experiment Environment Digest 一致；
- Dataset、Experiment、Trace 与 Grader 进入 Evidence Package 和评估页面；
- `pass@k` 表达至少一次成功，`pass^k` 表达连续全部成功，由同一 Provider 计算。

当前 Provider 仍使用 Mock Dataset 和 Trial Result，未连接 Langfuse、Phoenix 或 OpenTelemetry Backend。`TraceProvider` 已能导出同一 Run 的本地脱敏投影；下一步连接真实 Collector，并从经过策略筛选的生产 Trace 创建 Regression Dataset。

### 8.4 Trace Projection Provider

参考 Langfuse、Phoenix 与 OpenTelemetry 的 Trace / Span 关联方式，原型新增 `TraceProvider`，但保持事件账本为权威来源：

- `LocalTraceProvider` 从已通过摘要链和事件协议校验的 Run Events 确定性生成 Trace；
- Root Span 绑定 Run ID、Event Count 与 Chain Head，子 Span 覆盖 Activity、Tool、Policy、Evaluation 与 Usage；
- Trace Projection 具备独立 Projection Digest，Reducer 拒绝错 Run、错事件数、错链头和被篡改摘要；
- Evaluation 页面优先显示真实 Trace ID 与 Span Count，Evidence Package 保存同一 Projection；
- Evidence 与 Traceability 页面明确标识该对象是“从签名事件派生的脱敏投影”，不是新的事实源；
- 默认不导出 Prompt、Context 内容、Context Resource Path 或 Tool Output，只保留 Digest、Trust、Sensitivity 与结构化运行属性。

当前实现以浏览器内的 OTel 风格投影为事实来源，并已支持受治理的本地 OTLP/JSON Bundle；仍不连接 Collector、Langfuse 或 Phoenix，也不提供跨服务 Trace 传播、网络发送或长期 Trace Store。OpenTelemetry GenAI 语义仍可能演进，因此 `gen_ai.*` 只属于可替换投影层，`AgentRunEvent` 继续作为稳定核心协议。

### 8.5 Telemetry Export Provider

为避免把 Trace 生成、隐私策略和网络发送耦合到同一组件，原型新增独立 `TelemetryExportProvider`：

- `TraceProvider` 只负责从权威事件链生成可验证投影；
- `LocalOtlpFileExportProvider` 只准备本地 OTLP/JSON Bundle，不发起网络请求；
- Export Policy 固化 Policy ID/Version、Destination、Content Mode、Routine Sample Rate、Always Keep 规则、Attribute Allowlist、Denied Fragments 与字符串长度上限；
- Root、Error、Policy Deny 和失败 Evaluation Span 始终保留，Routine Span 使用确定性采样；任何被保留子 Span 的父链必须一并保留；
- Span 与 Resource Attributes 分别执行 Allowlist，禁止 Prompt、Message、Content、Context Path、Tool Output 与 Retrieval Query 等内容字段；
- Bundle 绑定 Run ID、Trace ID、Source Projection Digest、Exported/Dropped Count、完整 Policy 与独立 Export Digest；
- 即使攻击者重新计算 Export Digest，Unsafe Resource Attribute、丢失父 Span 或策略绑定漂移仍会被语义验证拒绝。
- 导出能力只授予 Owner/Maintainer；Reducer 再次绑定当前 Run、Trace 与 Projection，并将操作者、时间、Provider、Policy、Destination、文件名和 Export Digest 写入审计账本；
- Reviewer、Developer、重复 Digest、错 Run/Trace/Projection 或未通过语义验证的 Bundle 均不能形成导出记录。

下一阶段通过相同 Contract 增加经过 Egress Policy 授权的 Collector Adapter。网络 Endpoint、TLS、认证、Retry、Queue、Backpressure 与 Collector Receipt 必须成为新的 Evidence，而不能复用本地文件导出的信任结论。

### 8.6 Bounded Autonomy Decision Provider

参考 Anthropic Claude Code auto mode 的分层安全思路，Control Plane 不把“是否自动执行/合并”交给 Agent 自我判断，而是新增 `AutonomyDecisionProvider`：

- Program Phase 明确区分当前 `human_approval` 与未来 `low_risk_auto_merge`；
- 输入包括 Risk Tier、Repository-only、Sandbox Attestation、Session Integrity、Evidence Verification、Eval/CI 失败数、未解决 Policy Denial、External Egress、Destructive Change、Production Impact、Identity Anchoring 与 Human Review；
- `blocked` 表示确定性控制失败，人工批准不能覆盖这些失败；
- `human_review` 表示当前阶段、风险边界或身份信任仍要求具名人员判断；
- `auto_merge_eligible` 只是一项资格，不执行 Merge，也不替代 Branch Protection、Merge Queue 或外部 Source Provider；
- Provider 输出 Reasons、Required Controls、Input Digest 与 Decision Digest；Reducer 使用同一 Provider 重新求值后才允许持久化；
- 发布页展示当前决定，并将每次不同 Decision Digest 写入事件账本。

截至 2026-09-22，原型固定为 Phase 1 `human_approval`。即使测试输入可得到 `auto_merge_eligible`，产品运行态也不会自动触发合并或发布。下一阶段需要真实风险数据集、误判回放、Shadow Mode、审批节省量和事故率指标，才能考虑逐步开放低风险 Lane。
