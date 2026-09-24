# Anthropic AI Native SDLC 对齐审查

> 审查日期：2026-09-22  
> 审查对象：AI Native SDLC Control Plane v0.3 与 Workbench v0.1

## 1. 结论

当前产品主干与 Anthropic 的 Agentic SDLC 方向**基本契合，但并不完整**。

已经契合的部分：

- `Intent → Context → Execution → Evaluation → Review → Release → Feedback` 生命周期主线；
- 人描述目标和约束，Agent 执行，人负责关键判断；
- Context Manifest、实际读取对账和上下文预算；
- 强制容器、工具权限、网络和目录策略；
- Acceptance Criteria、Evaluation Provenance 和 Evidence Package；
- 风险分级、具名审批、审查队列和全过程追溯。

需要修正的部分：

1. **Evaluation 不应只作为 Run 的一个结果页。** 它需要独立的 Task、Trial、Grader、Dataset、Transcript 和 Regression 生命周期。
2. **Context 不应只是静态清单。** 需要支持 Just-in-time Retrieval、Compaction、Structured Notes 和 Sub-agent Context Isolation。
3. **执行不应默认只有单 Agent。** 需要明确 Workflow、Agent、Orchestrator-Worker、Evaluator-Optimizer 等模式，并让复杂度按需增加。
4. **安全不应只表现为策略列表。** 需要同时表达 Environment、Model、External Content 三层防线和实际 Blast Radius。
5. **Release 之后不能只停留在指标。** Production Signal、User Feedback、Incident 和 Eval Failure 必须能够派生 Remediation Proposal 或新 Intent。
6. **Tests + Docs 应是实现阶段的并行产物。** 文档完整性与变更同步需要进入 Evidence 和 Review。
7. **托管 Agent 不能把模型、工具执行和状态混成一个黑盒进程。** 需要显式解耦 Model、Harness、Sandbox 与 Session，并让 Session 成为可恢复、可重放的追加写事件日志。
8. **高层 Intent 不能直接落到生成代码。** 长任务需要由 Planner 拆解工作，再由 Generator 与独立 Evaluator 先确认可测试的工作契约；生成者不能自我批准完成定义。

因此产品信息架构调整为：

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

## 2. Anthropic Agentic SDLC 的核心部分

### 2.1 生命周期变化

Anthropic 2026 Agentic Coding Trends Report 将新的软件开发流描述为：

```text
Express intent
→ Agent understands
→ Agent implements
→ Agent tests + docs
→ Human review
→ Deploy and ship
→ Monitoring and observability
→ Learn and iterate
```

对应的组织变化包括：

- 顺序交接转为流动的 Agent 工作流；
- 人从编写全部代码转为指导和编排 Agent；
- 文档从事后补充转为实现过程中生成；
- 事故响应从纯人工处理转向 Agent-assisted remediation。

### 2.2 Agent 架构模式

Anthropic 建议从最简单方案开始，只在收益可测量时增加复杂度：

- Augmented LLM；
- Prompt Chaining；
- Routing；
- Parallelization；
- Orchestrator-Workers；
- Evaluator-Optimizer；
- Autonomous Agent。

Control Plane 不应强迫所有任务采用同一种 Agent 结构，而应把这些模式作为可观察、可治理的 Execution Strategy。

### 2.3 Context Engineering

上下文是有限的注意力预算，不是“越多越好”。关键机制包括：

- 最小高信号上下文；
- Just-in-time retrieval 与 progressive disclosure；
- Compaction；
- Structured note-taking / memory；
- Sub-agent context isolation；
- 实际读取、声明来源和敏感性对账。

截至 2026-09-22，Workbench 已把上述机制落为可执行事件：三个 Worker Context Scope、JIT 请求/消费分离、plan/finding/decision Structured Notes，以及在 Evaluation Checkpoint 前发生的 Token Compaction。它们共同进入 Session 摘要链、Evidence Repository、Transcript 与上下文中心，不再只是静态 UI 标签。

### 2.4 Evaluation-driven Development

Evaluation 需要成为持续维护的产品资产：

- 从真实失败中建立初始 20–50 个任务；
- 每个 Task 有明确成功条件和 Reference Solution；
- 每个 Task 运行多个独立 Trial；
- 优先确定性 Grader，必要时使用模型和人工 Grader；
- 同时观察 `pass@k` 与 `pass^k`；
- 阅读 Transcript，区分 Agent 失败、任务歧义、Grader Bug 和环境噪声；
- 把生产失败持续转化为 Regression Task。

Workbench 已把这项要求落为 `evaluation_diagnosed` 一等事件：每个失败记录 `agent / task / grader / harness / infrastructure` 分类、置信度与 Evidence Refs，同时保存 Transcript Review 状态及 Eval 环境的 Clean Start、Shared State 和 Image Digest。Evaluation 页面、Release Gate、Transcript 与 Regression 回流读取同一诊断证据，避免把 Grader 或基础设施噪声误记为 Agent 能力回归。

### 2.5 三层 Agent 安全

安全控制应覆盖三个组件：

1. **Environment**：容器、VM、文件系统边界、凭证隔离、Egress Control；
2. **Model**：System Prompt、Classifier、Probe、行为策略；
3. **External Content**：MCP、插件、网页、仓库内容和工具输出的信任与注入风险。

审批不能代替边界。高频权限提示会产生 Approval Fatigue，低风险动作应由确定性边界或可靠分类器自动处理，高风险动作才进入人工决策。

Workbench 的 Human Governance 已进一步落为角色能力与外部身份：Developer 无审批权，Reviewer 可处理 Run/Review 但不能授权生产，Owner 才能批准 Production；所有限制在 Reducer 中再次执行，避免“按钮禁用但 API 可绕过”。每个 Run Gate、Review 和 Production 决策都固化决策时的外部 Identity，并同步投影到界面、追溯事件和 Evidence Package，避免切换当前操作者后产生错误归因。

Workbench 现已加入 `AutonomyDecisionProvider` 对应 Auto Mode 的边界化思路。截至 2026-09-22，Program Phase 固定为 `human_approval`；Provider 先检查 Session、Sandbox、Evidence、Eval、CI 和 Policy 等确定性控制，再判断 Risk Tier、Egress、破坏性操作、生产影响和身份锚定。失败控制返回 `blocked`，不确定或越界动作返回 `human_review`。只有未来 Phase、低风险 Repository-only 任务且全部边界满足时才返回 `auto_merge_eligible`，且该结果仍不能绕过仓库保护和 Merge Queue。Reducer 会重新求值并保存 Decision Digest，防止 UI 或 Agent 伪造自治资格。

### 2.6 长任务 Harness：Planner、Generator、Evaluator 与 Work Contract

Anthropic 在 2026 年 3 月 24 日发布的 *Designing AI agent harnesses for long-running applications* 中，将长任务 Harness 明确拆成 Planner、Generator 和 Evaluator 三种职责，并强调：

- Planner 把高层目标拆成可执行 Sprint；
- Generator 与独立 Evaluator 在实现前协商可测试的 Sprint Contract；
- Evaluator 必须与 Generator 分离，避免生成者自我判断“已经完成”；
- 长期状态应通过文件、提交和结构化反馈持久化，而不是依赖无限增长的上下文；
- Context Reset 的节奏取决于模型能力，Harness 架构必须通过 Eval 和消融实验持续校准，而不是固化为永久模板。

Workbench 已新增 `work_contract_proposed` 与 `work_contract_reviewed` 一等事件。每次新 Run 在 Worker Scope 和实现产物之前固化目标、验收标准、非目标与 Contract Digest，并要求不同的 Generator / Evaluator Identity 对同一摘要达成 `accepted`。自我批准、要求修订或摘要不一致会进入人工门禁，未独立确认的契约不能获得生产授权；契约同时进入 Transcript、Run 概览和 Evidence Package。`validateEventProtocol` 已在 Store 与 Evidence Repository 强制这些顺序不变量，因此重新计算合法 Digest 也不能绕过 Work Contract 或 Context Reset 控制。

Planner 也已从一次性 `plan_created` 升级为长期规划链：`roadmap_created` 保存目标、里程碑与 Digest，`sprint_planned` 把当前 Run 绑定到 Roadmap，Work Contract 再绑定 Sprint；Evaluation Diagnosis 之后必须通过 `roadmap_updated` 引用反馈证据、更新里程碑并提出下一 Sprint 目标。这样 Roadmap 会随生成—评估循环演进，而不是把所有跨 Run 状态塞进上下文窗口。

Workbench 已进一步增加确定性 `HarnessPolicy`：根据模型上下文保持能力、独立 Evaluator 要求、成本上限和候选 Eval 可靠性选择 Profile，并把执行模式、Reset Policy 与 Evidence Ref 写入 `harness_profile_selected`；Context Reset Controller 再根据 Token 压力、阶段边界与 Evaluator Feedback 产生 `context_reset_decided`。这消除了“所有模型永久使用同一 Harness”的硬编码，但候选分数仍是 Mock Ablation 数据，尚需接入真实可重复 Trial。

## 3. 产品差距矩阵

| Anthropic 实践 | 当前状态 | 判断 | 调整动作 |
|---|---|---|---|
| Express Intent | 已有 Intent 和 AC | 契合 | 保持 |
| Agent Understands | JIT、Scope、Notes、Compaction 已事件化 | 原型契合 | 接入真实检索与企业知识源 |
| Agent Implements | Harness 选择、Roadmap、Sprint、Workers 已事件化 | 原型契合 | 接入真实模型、工具执行与 Sandbox |
| Tests + Docs | Patch、Tests、Docs、JUnit、SARIF、LCOV 已进入 Evidence | 原型契合 | 接入真实 CI 与文档完整性 Grader |
| Human Review | 风险队列、Transcript、Evidence 与具名审批已闭环 | 契合 | 增加真实 SSO / SCIM 与审批策略管理 |
| Deploy and Ship | Release Gate、部署 Provider 与具名回滚已闭环 | 原型契合 | 接入真实部署系统与制品签名 |
| Monitor | 已有生产信号、指标和反馈页面 | 部分契合 | 接入真实 Telemetry / Incident Provider |
| Learn and Iterate | Signal 可派生 Intent / Regression，Roadmap 可按评估更新 | 原型契合 | 接入真实生产信号与策略变更回流 |
| Eval-driven Development | Task、Trial、Grader、Transcript、Regression、Diagnosis 已产品化 | 原型契合 | 接入真实数据集、Trial Runner 与统计置信度 |
| Multi-agent Coordination | Orchestrator、Worker Scope 与独立 Evaluator 已表达 | 原型契合 | 接入真实并行执行与冲突合并 |
| Three-layer Containment | 三层策略与 Sandbox Attestation 协议已表达 | 部分契合 | 接入真实容器 / VM Attestor 与 Egress Enforcement |
| Managed Agent Runtime | Model / Harness / Sandbox / Session 已解耦并可恢复 | 原型契合 | 接入真实运行时与跨环境 Session 迁移 |
| Planner / Generator / Evaluator | Roadmap → Sprint → Contract → Diagnosis → Roadmap Update 已闭环 | 原型契合 | 接入真实 Planner / Evaluator Adapter |
| Model-adaptive Harness | 已有确定性选择与 Reset 事件 | 部分契合 | 接入真实 Harness Ablation Trial 与统计置信度 |

## 4. Workbench 调整顺序

### P0

- 总览生命周期改为 Anthropic 八阶段；
- 新增 Evaluation 页面；
- 新增 Feedback / Remediation 页面；
- Context 页面增加动态上下文策略；
- Policy 页面增加三层防线状态。

### P1

- Agent Run 增加 Orchestrator / Worker 拓扑；
- Evaluation 增加 Trial 和 Transcript Drill-down；
- Review 增加 Plan、Transcript 和 Tests + Docs 证据；
- Feedback 可一键派生 Intent 或 Regression Task。

### P2

- 接入真实 GitHub 数据；
- 接入一个 Agent Adapter；
- 接入 JUnit、SARIF、Coverage 和自定义 Grader；
- 持久化 Event、Trace、Evidence 与 Policy Decision。

### 追加审查：Managed Agent Runtime

Anthropic 在 *Scaling managed agents: decoupling the “brain” from the “hands”* 中进一步强调，托管 Agent 平台需要拆分：

- **Model / Brain**：负责推理，可独立替换模型和推理策略；
- **Harness / Hands**：负责工具循环、提示注入、压缩、超时和恢复；
- **Sandbox**：负责文件、进程、网络和凭证的隔离边界；
- **Session**：保存追加写事件日志，使长任务可以恢复、审计和跨执行环境迁移。

这不是纯基础设施细节。Control Plane 必须能够证明某次 Run 绑定了哪个模型、哪版 Harness、哪个 Sandbox 和哪个 Session，否则同一个 Intent 的结果无法可靠复现，也无法区分模型问题、Harness 问题和环境问题。

Workbench 已增加 `sandbox_attested`：Runtime Binding 之后必须由独立 Attestor 固化隔离模式、Workspace Root、读写路径、Egress、Allowed Hosts、Secret Mounts、Ephemeral 状态与 Digest。Managed Run 在 Attestation 未验证、网络无限制、环境非临时或挂载 Secrets 时不能进入 Harness Selection、Evidence 封存或生产授权。当前 Attestor 是 Mock 协议实现，真实容器 / VM Enforcement 仍是下一阶段集成项。

Workbench 进一步把 Runtime Budget 落为确定性 Guard：Harness 上报 Token、工具调用、时长与成本；80% 阈值触发 Checkpoint，硬上限超出触发 Terminate 和人工门禁。该决策进入追加写 Session 与 Evidence，不依赖模型自律。

长任务 Harness 也已覆盖非正常中断：重新加载时识别缺少终态的 Session，阻断审批，先封存父 Run，再从 Checkpoint 恢复或安全重启，避免“刷新后永远卡在运行中”。

### 追加审查：Trace 与出口边界

Anthropic 的 Managed Agent Runtime 强调 Model、Harness、Sandbox 与 Session 通过稳定接口解耦，而不是让某个运行框架拥有全部状态。Workbench 将同一原则延伸到 Observability：

- `AgentRunEvent` 与 Session 摘要链保持权威事实；
- `TraceProvider` 只生成可替换的 OTel 风格投影；
- `TelemetryExportProvider` 独立处理采样、内容脱敏和 Destination；
- 当前 Local Exporter 只生成本地文件，不隐式获得网络 Egress；
- Prompt、Message、Context 内容和 Tool Output 默认不进入 Telemetry。

这使未来替换 Harness、模型或 Trace Backend 时，不需要改写核心事件协议，也不会因接入观测产品而扩大 Agent 的网络权限或敏感数据暴露面。后续真实 Collector Adapter 必须继续受 Sandbox Egress Allowlist、Policy Decision 和 Evidence Receipt 约束。

## 5. 官方依据

- Anthropic, *2026 Agentic Coding Trends Report*: https://resources.anthropic.com/2026-agentic-coding-trends-report
- Anthropic, *Building effective agents*: https://www.anthropic.com/research/building-effective-agents
- Anthropic, *Effective context engineering for AI agents*: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, *Demystifying evals for AI agents*: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic, *How we contain Claude across products*: https://www.anthropic.com/engineering/how-we-contain-claude
- Anthropic, *How we built Claude Code auto mode*: https://www.anthropic.com/engineering/claude-code-auto-mode
- Anthropic, *Scaling managed agents: decoupling the “brain” from the “hands”*: https://www.anthropic.com/engineering/scaling-managed-agents
- Anthropic, *Effective harnesses for long-running agents*: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic, *Designing AI agent harnesses for long-running applications*: https://www.anthropic.com/engineering/harness-design-long-running-apps
