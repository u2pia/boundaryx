# AI Native SDLC Control Plane 产品实践雷达

> 日期：2026-09-22  
> 状态：Living document  
> 目的：持续吸收同类产品和开源项目中已经被验证的机制，但不复制其产品边界、部署假设或领域模型。

## 1. 使用方式

每个对标对象必须回答六个问题：

1. 它已经验证了什么机制？
2. 这个机制解决 Control Plane 的哪个核心问题？
3. 应该 `Adopt / Integrate / Reference / Build`？
4. 哪些产品假设不适合 3–8 人、私有化优先的小团队？
5. 如何进入 Provider Contract、Evidence Boundary 和可验证 Backlog？
6. 它将改善哪个真实指标：Active Review Time、Decision Latency、Review Cycle、Evidence Usefulness 或缺陷护栏？

产品雷达不是竞品功能清单。只有同时满足以下条件，实践才进入实现：

- 能强化 Intent-driven、Evaluation-driven 或 Human-governed；
- 能通过稳定 Contract 与核心领域解耦；
- 有明确的离线或私有化路径；
- 能定义可验证证据，而不只是增加 UI；
- 小团队的运维和认知成本可接受。

新增硬性约束：**“值得借鉴”不等于“值得现在实现”。** 在第一条真实纵向链路完成前，对标结果默认只能进入 `Reference / Lab`；只有直接服务 GitHub PR 审查、一个真实 Agent、Context Consumption、AC ↔ Eval 或真实价值采集的机制，才能进入 `Now`。

## 2. 总体结论

| 能力域 | 重点参考 | 结论 | 当前动作 |
| --- | --- | --- | --- |
| Review Surface | GitHub Copilot cloud agent、Qodo Merge、Graphite | Adopt / Integrate | 真实 GitHub PR Comment / Check、单一渐进披露 Summary、小变更和审查指标优先 |
| Responsibility | Linear Agents、GitHub Review | Adopt | 人保持 Issue owner，Agent 是 delegated actor；审批继续锚定外部身份 |
| Coding Agent / Runtime | OpenHands、SWE-agent | Integrate one | 只深度接入一个真实 Agent + Container，采集 Context Consumption 与最小轨迹 |
| Eval Evidence | Qodo、现有 CI、Langfuse / Phoenix | Integrate minimal | 先做 AC ↔ Eval、新增测试标注和 PR 可决策证据；Trace Backend 留在 Lab |
| Durable Workflow | Temporal、LangGraph | Reference | 保留 Contract 和研究原型，不作为下一阶段产品优先级 |
| Policy / Attestation | OPA、Cedar、in-toto、Sigstore、SLSA | Reference / Lab | 第一阶段只保留纵向链路需要的确定性门禁，不升级企业治理平台 |
| Project UX | Linear、Plane、GitHub Projects | Reference | 借鉴清晰责任、状态与阻塞关系，不复制通用项目管理 |
| Delivery / Feedback | Sentry Seer、Argo CD、Harness | Reference / Later | 先引用外部结果；真实 Review Spine 稳定后再闭合生产反馈 |

当前优先级不再由“架构缺少哪个 Provider”决定，而由“真实审查链路缺少哪个证据”决定。

## 3. 逐项对标

### 3.1 OpenHands

**借鉴：**

- Agent 与 Runtime/Sandbox 分离；
- 通过运行环境约束目录、网络和执行生命周期；
- 将执行过程视为可恢复的交互，而不是一次 Prompt；
- 对高风险操作提供确认和安全边界。

**不照搬：**

- 不把某个 Agent Runtime 变成唯一执行内核；
- 不把其工具名、事件名或会话格式写入核心领域；
- 不默认所有任务都需要完整 Autonomous Agent。

**对本项目的影响：**

- `AgentAdapter`、`SandboxProvider`、`SandboxAttestor` 分离；
- `runtime_bound` 与 `sandbox_attested` 成为 Managed Run 前置事件；
- Sandbox 证明必须进入 Release Gate 和 Evidence Package。

### 3.2 SWE-agent

**借鉴：**

- 面向软件任务的精简工具界面；
- Trajectory 是理解 Agent 失败的重要资产；
- Agent Harness 应通过任务集和轨迹评估，而不是只看 Demo。

**不照搬：**

- 不将基准任务的成功率直接等同于团队生产可靠性；
- 不把单一 Repo Task 作为完整 SDLC 模型。

**对本项目的影响：**

- Harness Ablation 保存候选可靠性、P95、成本与 Evidence Ref；
- Transcript Review 成为 Evaluation Diagnosis 的必需信息。

### 3.3 GitHub Copilot coding agent / Agentic Workflows

**借鉴：**

- Issue、PR、Checks 和 Review 保持在开发者已有工作流中；
- Agent 产物最终落入可审查的 Pull Request；
- 仓库规则、身份和分支保护继续是外部权威。

**不照搬：**

- 不把 GitHub Cloud 当作唯一部署环境；
- 不让 GitHub 专有对象渗透到 Intent、Evaluation、Evidence 核心模型。

**对本项目的影响：**

- GitHub 先行，但所有能力通过 Provider Contract 接入；
- PR 投影绑定 Head SHA，Head 变化撤销旧授权；
- GitLab/Jira 后续复用相同 authority projection 语义。

### 3.4 Temporal

**借鉴：**

- Durable Execution；
- Workflow 与 Activity 分离；
- Activity Retry Policy、Timeout 和 Idempotency；
- 通过事件历史恢复长任务，而不是依赖原进程存活。

**不照搬：**

- 第一阶段不直接要求小团队维护完整 Temporal 集群；
- 不把 Agent 的非确定性推理伪装成确定性 Workflow Replay；
- Retry 不能掩盖不可重试的策略拒绝、数据错误和权限错误。

**已落地到原型：**

- `workflow_bound` 固化 Workflow ID、Provider、Task Queue、Replay Mode、Human Resume 与 Retry Policy；
- Activity 事件记录 Attempt、Idempotency Key、Timeout、失败类别、退避和完成摘要；
- `LocalWorkflowProvider` 独立保存请求、事件历史、Chain Head、状态、恢复次数和 Record Digest；
- 浏览器进程中断后可从 Workflow Repository 恢复 Sequence、Previous Digest 和最近 Checkpoint；
- 相同 Event Digest 重复追加保持幂等，冲突 Digest、未显式 Recover 的追加和存储篡改会被拒绝；
- 协议拒绝跳号重试、超过最大次数、改变幂等键、并发打开同一 Activity Attempt；
- Policy Denied 等非重试错误不能被标记为可重试；
- 人工 Resume、Checkpoint Restore 与自动 Retry 在 Transcript 和 Evidence 中保持不同语义。

### 3.5 LangGraph

**借鉴：**

- Checkpointer 与 Thread/Run Identity；
- Durable Execution 和 Interrupt；
- 人工介入前后恢复同一状态；
- 将副作用放在可重放边界之外。

**不照搬：**

- 不将 Graph 节点结构暴露为 Control Plane 的通用领域模型；
- 不强制所有 Agent Adapter 使用 LangGraph。

**对本项目的影响：**

- `checkpoint_saved`、`checkpoint_restored` 与 Session Event Log 已进入原型；
- 下一步为副作用 Tool Activity 增加幂等语义。

### 3.6 Langfuse

**借鉴：**

- Trace、Observation、Dataset、Experiment 与 Evaluation 的关联；
- 从生产 Trace 形成评估数据；
- 自托管与开放集成边界；
- Online 与 Offline Evaluation 共用关联键。

**不照搬：**

- 不把 Trace 后端当作审批、发布或责任归属的最终事实来源；
- 不把 LLM-as-a-judge 分数作为高风险门禁的唯一条件。

**已落地到原型：**

- 新增 `EvaluationProvider` 与 `evaluation_experiment_bound`；
- Experiment 固化 Dataset Ref/Version、Candidate、Trace Ref、Grader Inventory、Trial Count 与 Environment Digest；
- Evaluation Result 数量必须与 Bound Trial Count 一致；Diagnosis 的环境摘要必须与 Experiment 一致；
- Experiment Digest、Dataset Version、Trace Ref 和 Grader Version 进入 Evidence Package；
- `LocalEvaluationProvider` 统一计算 `pass@k` 与 `pass^k`，避免把“一次成功”和“持续可靠”混为一谈；
- `TraceProvider` 已从签名事件链生成确定性 OTel 风格投影，并与 Experiment、Evidence 和 Traceability 共用关联键；真实 Collector Export 移入 Lab，等待跨系统诊断需求触发。

### 3.7 Arize Phoenix

**借鉴：**

- 基于 OpenTelemetry 的 Tracing；
- Dataset / Experiment / Evaluator 组合；
- 从错误分析回到实验和评估；
- 本地与自托管分析路径。

**不照搬：**

- 不把可观测页面替代 Run Transcript 和 Evidence Package；
- 不复制第二套任务和发布状态机。

**对本项目的影响：**

- Eval Failure Diagnosis 与 Trace Drill-down 必须互相引用；
- 观测数据是 Evidence Material，不是审批 Actor。

**已落地到原型：**

- `LocalTraceProvider` 将 Run、Activity、Tool、Policy、Evaluation 与 Usage 事件投影为同一 Trace；
- Trace ID、Span Count、Provider 与 Projection Digest 进入评估页、证据中心、追溯页和 Evidence Package；
- Trace Projection 绑定 Run ID、Event Count 与 Chain Head，Store 拒绝错 Run、错事件数、错链头和被篡改的投影摘要；
- Context 仅导出 Digest、Trust 与 Sensitivity，默认不导出 Prompt、Context Resource Path、Tool Output 或原始 Transcript 内容。
- Error 或失败 Evaluation Span 可由人显式提升为 Regression Asset，并保留 Run、Trace、Span、Projection 与 Event Digest；策略拒绝本身不被误当成回归失败。

### 3.8 OpenTelemetry GenAI

**借鉴：**

- 使用开放语义记录 Model、Agent、Tool 和 Token/Cost；
- 通过 Trace/Span 关联跨 Provider 调用；
- 避免每个模型厂商形成独立观测孤岛。

**不照搬：**

- 尚不稳定的语义约定不直接成为不可迁移的持久领域 Schema；
- 敏感 Prompt、Context 和 Tool Output 默认不进入遥测。

**对本项目的影响：**

- Adapter 输出可投影为 OTel，但核心事件保留自有稳定版本；
- Telemetry Export 必须经过敏感性和 Egress 策略。

**已落地到原型：**

- 新增 `TraceProvider` 稳定 Contract 和 `aperture.otel-trace-projection/v0.1`；
- 使用 `gen_ai.request.model`、`gen_ai.tool.name`、`gen_ai.usage.*` 与 `aperture.*` 扩展属性表达运行事实；
- Trace Projection 由已验证事件链派生，核心领域不依赖 Collector 是否在线；
- 新增独立 `TelemetryExportProvider`，将采样、属性 Allowlist、敏感字段删除和 Destination Policy 与 Trace 生成解耦；
- 本地 OTLP/JSON Bundle 始终保留 Root、Error、Policy Deny、失败 Evaluation 及其父链，并记录 Exported/Dropped Count 与 Export Digest；
- 当前只生成本地文件，不声称已连接 OpenTelemetry Collector，也不将仍在演进的 GenAI 语义固化为核心事件 Schema。

### 3.9 Open Policy Agent / Cedar

**借鉴：**

- Policy Decision 与 Enforcement 解耦；
- 输入、策略版本、结果和原因可重放；
- Bundle / Version 支持离线策略分发；
- 授权不依赖 UI 是否隐藏按钮。

**不照搬：**

- 不在 MVP 同时支持多种策略语言；
- 不把业务状态机全部改写为策略代码；
- 不允许策略结果缺少可读原因。

**已落地到原型：**

- 新增 `PolicyDecisionProvider`，Agent 不再自行构造 Allow/Deny；
- Managed Run 在 Workflow 之后、Roadmap 之前产生 `policy_bundle_bound`，固定 Provider、Bundle ID/Version、Rule Inventory、Default Deny 与 Bundle Digest；
- 每个 Tool Activity 的决定记录 Policy ID、Bundle Version、Input Digest、Enforcement 和可读原因；
- 事件协议拒绝缺失 Bundle、Bundle Digest/规则清单不一致或决定版本漂移；
- 本地 Provider 覆盖 Secrets、未信任内容、Egress Allowlist、Repository、Sandbox Shell 和 Production Approval；
- Reducer / Domain Service 仍执行不可绕过的不变量；
- 策略引擎负责可配置授权，领域模型负责结构性约束。

### 3.10 in-toto / Sigstore / SLSA

**借鉴：**

- 主体、材料、步骤、产物和签名的 Provenance；
- Attestation 与验证分离；
- 透明日志或企业内证明仓；
- 从构建来源追踪到发布产物。

**不照搬：**

- 不要求所有本地低风险 Run 上公网透明日志；
- 不将简单摘要、浏览器存储或 FNV 校验和称为签名/WORM；
- 不把供应链等级宣称先于真实执行环境能力。

**对本项目的影响：**

- 已新增 `AttestationProvider` 与本地 ECDSA P-256 原型；
- Evidence Package 使用 in-toto Statement 结构和 DSSE PAE 签名封套，绑定 Package SHA-256、Run、URI、Repository Digest、Chain Head、Event Count 与 Workflow；
- 签名、Subject Digest、Payload 和 Predicate Binding 分别复验；
- 当前 Signer 是随声明生成的本地临时密钥，界面明确标记 `identity unanchored`，不得作为生产身份门禁；
- 后续以企业 PKI、KMS 或 Sigstore 替换临时身份，同时保持相同 Provider Contract；
- Release Candidate 与 Deployment 必须绑定 Artifact Digest。

### 3.11 Backstage

**借鉴：**

- Software Catalog 的声明式实体思想；
- Plugin/Provider 扩展方式；
- Owner、Lifecycle、System/Component 关系；
- 将分散工具组织为统一入口。

**不照搬：**

- 不建设另一个通用开发者门户；
- 不把页面插件当作领域隔离；
- 不让 Catalog 退化为无人维护的静态 Wiki。

**已落地：**

- Workbench 集成页新增 Provider Catalog；
- 每项记录 Stable Contract、Decision、Stage、Deployment Mode、Offline Readiness；
- 强制记录 Borrowed Pattern、Avoid Pattern 与 Evidence Boundary；
- `provider-catalog-smoke.ts` 验证目录完整性和离线部署姿态。

### 3.12 Linear / Plane / GitHub Projects

**借鉴：**

- 高密度、低干扰、键盘优先的工作流；
- 清晰的状态、负责人和阻塞关系；
- 快速从列表进入对象详情；
- 团队协作对象保持简洁。

**不照搬：**

- 不扩张为通用项目管理平台；
- 不用 Story Point、甘特图和自定义字段掩盖 Agent 风险；
- 不把“任务完成”直接等同于“可发布”。

**对本项目的影响：**

- 工作台首屏优先风险、等待决策、证据完整度；
- Roadmap / Sprint / Work Contract 只服务 Agent 长任务治理。

### 3.13 Argo CD / Harness / Spinnaker

**借鉴：**

- Desired/Actual 状态和环境推进；
- Deployment 与 Rollback 是独立、可追踪动作；
- 生产授权、制品、环境和执行结果必须绑定；
- Progressive Delivery 与观察窗口。

**不照搬：**

- Control Plane 不复制完整 CI/CD、GitOps Controller 或 Pipeline Designer；
- 不直接持有集群管理员权限；
- 不让“部署成功”替代生产观察和回滚准备度。

**对本项目的影响：**

- `DeploymentProvider` 只接收已授权 Candidate；
- 部署和回滚结果进入 Traceability、Evidence 与 Learning Loop。

### 3.14 Anthropic Claude Code auto mode

**借鉴：**

- 安全工具通过确定性允许路径减少审批疲劳；
- 项目内、可审查、可回滚的修改与外部副作用分开治理；
- 未知或高风险动作可增加分类器判断，但分类器始终位于 Sandbox 与权限边界内；
- 自治范围随真实使用数据、误判和事故证据逐步扩大。

**不照搬：**

- 不把分类器判断直接等同于自动合并、自动发布或生产授权；
- 不允许 Agent 自己声明任务属于低风险；
- 不绕过 GitHub/GitLab Branch Protection、Merge Queue 和外部身份；
- 不在身份未锚定、Evidence 未复验或 Eval/CI 失败时开放自治。

**已落地到原型：**

- 新增 `AutonomyDecisionProvider`，输入固定 Program Phase、Risk Tier、Repository-only、Sandbox、Session Integrity、Evidence、Eval、CI、Policy、Egress、Destructive、Production Impact 与 Identity Anchoring；
- 决定分为 `blocked / human_review / auto_merge_eligible`，并保存 Reasons、Required Controls、Input Digest 与 Decision Digest；
- 当前 Program Phase 固定为 `human_approval`，即使低风险也必须具名人工审批；
- 任一确定性控制失败直接 `blocked`；中高风险、外部 Egress、破坏性操作、生产影响或身份未锚定保持 `human_review`；
- 只有未来 `low_risk_auto_merge` Phase 且所有边界满足时才返回资格，真正合并仍交给仓库保护与 Merge Queue；
- Reducer 重新求值并持久化决定，防止 UI 伪造 `auto_merge_eligible`。

## 4. Provider Catalog 领域约束

每个 Provider Descriptor 至少包含：

```yaml
id: string
name: string
category: string
contract_ref: string
decision: adopt | integrate | reference | build
stage: prototype | next | research
deployments: [embedded | self_hosted | managed]
offline_ready: boolean
inspiration: string
borrowed_pattern: string
avoid_pattern: string
evidence_boundary: string
```

核心不变量：

- 核心领域依赖 Contract，不依赖具体产品；
- `offline_ready: true` 时必须存在非 Managed 部署方式；
- 可执行 Provider 必须定义 Evidence Boundary；
- 借鉴机制与不照搬项必须同时记录；
- 产品版本、许可证和维护状态在真正引入依赖前重新核验；
- Provider Catalog 的变更应经过 Architecture Decision Review。

## 5. 分阶段落地

### Now：产品纠偏

1. 真实 GitHub Issue / PR / Comment / Check / Review 集成；
2. 一个真实 Agent + Git worktree + 强制 Container；
3. Context Manifest / Consumption 对账；
4. 真实 CI 结果导入、AC ↔ Eval Mapping 和新增测试标注；
5. PR 内单个可更新的 Evidence Summary；
6. Active Review Time、Decision Latency、Review Cycle 和缺陷护栏采集；
7. 最小 Team Service + SQLite，支持两个真实身份和共享状态。

### Lab：保留研究成果但退出默认产品

- Deployment Provider 与 Release / Rollback UI；
- Provider Catalog；
- Durable Workflow Contract、Activity Retry、Replay 与 Human Resume；
- in-toto Statement、DSSE、ECDSA Evidence Attestation；
- OPA / Cedar Policy Provider；
- Dataset / Experiment / Trace / Grader 完整工作台；
- Telemetry Export、OTLP / JSON Bundle 和 Collector Receipt；
- Bounded Autonomy 与自动合并资格判断；
- GitLab Provider 和多 Provider 通用化验证。

### Later：由真实 traction 触发

- 当普通恢复机制无法满足真实长任务时，再产品化 Durable Workflow；
- 当试点团队出现合规或不可抵赖需求时，再引入企业 PKI / KMS / Sigstore；
- 当用户需要跨系统诊断时，再接真实 Trace Backend 与 OpenTelemetry Collector；
- 当 GitHub 纵向链路稳定且出现第二类客户时，再实现 GitLab；
- 当真实低风险样本、误判率和事故数据足够时，再开放自动合并；
- 当生产事故确实能反哺 Eval 时，再闭合 Deployment / Feedback。

## 6. 评审节奏

- 每两周检查一次 `Now` 项是否改善真实审查链路，而不是是否增加 Provider；
- 每月复核产品版本、许可证、活跃度和私有化能力；
- 每次引入新 Provider 前，先提交用户问题、可验证假设、目标指标和停止条件；
- 每个季度删除没有转化为 Decision、Contract 或 Backlog 的“收藏型对标”；
- 任何竞品启发都必须通过 Eval 或小团队真实工作流验证后，才升级为默认能力。
- 在至少一个真实任务完成 Issue → Agent → Evidence → Review → Merge 前，暂停新增 Provider 和默认导航页面。

## 7. 官方资料入口

- OpenHands Repository: https://github.com/OpenHands/OpenHands
- SWE-agent Documentation: https://swe-agent.com/latest/
- GitHub Copilot coding agent: https://docs.github.com/en/copilot/concepts/coding-agent/coding-agent
- Linear Agents: https://linear.app/docs/agents-in-linear
- Qodo Merge custom compliance: https://docs.qodo.ai/qodo-documentation/code-review/qodo-merge/features/custom-compliance
- Graphite Documentation: https://graphite.com/docs
- GitLab Duo Agent Platform: https://docs.gitlab.com/user/duo_agent_platform/
- Sentry Seer: https://docs.sentry.io/product/ai-in-sentry/seer/
- Temporal Documentation: https://docs.temporal.io/
- LangGraph Durable Execution: https://docs.langchain.com/oss/python/langgraph/durable-execution
- Langfuse Documentation: https://langfuse.com/docs
- Arize Phoenix Documentation: https://arize.com/docs/phoenix
- OpenTelemetry GenAI Semantic Conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Open Policy Agent Documentation: https://www.openpolicyagent.org/docs/latest/
- in-toto Documentation: https://in-toto.io/
- Sigstore Documentation: https://docs.sigstore.dev/
- SLSA Specification: https://slsa.dev/spec/
- Backstage Documentation: https://backstage.io/docs/
- Plane Documentation: https://docs.plane.so/
- Argo CD Documentation: https://argo-cd.readthedocs.io/
- Anthropic, *How we built Claude Code auto mode*: https://www.anthropic.com/engineering/claude-code-auto-mode
