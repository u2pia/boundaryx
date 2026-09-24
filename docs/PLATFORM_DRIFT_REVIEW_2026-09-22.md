# AI Native SDLC Control Plane 产品偏航审查

> 审查日期：2026-09-22  
> 审查角色：产品与架构独立评审  
> 审查对象：`README`、产品与设计文档、Workbench 原型、Provider Contract 与专项测试  
> 核心问题：当前平台是否仍在验证最初的产品假设，以及如何在借鉴类似产品时避免继续扩大范围。

## 1. 执行摘要

最终判定：

| 维度 | 判定 | 说明 |
| --- | --- | --- |
| 战略方向 | 基本一致 | Intent-driven、Evaluation-driven、Human-governed、自托管和开放领域模型仍然成立 |
| MVP 产品形态 | 明显偏离 | 默认产品已经成为多页面治理工作台，而不是附着在 GitHub 上的审查加速器 |
| 工程优先级 | 严重偏离 | Attestation、Telemetry、Durable Workflow、Deployment、Autonomy 等早于真实 GitHub、Agent 和团队链路 |
| 方法论研究价值 | 显著增强 | 领域对象、事件、不变量和 Provider 边界已经形成有价值的参考架构资产 |
| 真实用户价值证据 | 基本缺失 | 尚无真实审查者、真实 PR、真实 Agent Run 和真实 Review Time 数据 |

一句话结论：

> 项目没有偏离“AI Native SDLC”的长期方向，但已经偏离第一阶段要验证的产品——让小团队更快、更安全地接受 Agent 变更。

因此，下一阶段不应继续增加控制面能力，而应把默认产品收缩成一条 **AI Change Review Spine**：

```text
GitHub Issue + AC
→ 一个真实 Agent + Container
→ Context Manifest / Consumption
→ CI / Eval + 新增测试标注
→ PR Evidence Summary
→ GitHub Human Review
→ Review Time / Decision Latency / Defect Guardrail
```

## 2. 最初不可违背的产品假设

原始定位已经给出足够明确的约束：

1. 服务 3–8 人、无专职平台工程师的小团队。
2. 一句话价值是让审查者在约 8 分钟内安全接受 Agent 变更。
3. 唯一核心尺子是“每个被接受变更所消耗的审查人时”。
4. 平台只拥有全周期的追溯脊椎，深层能力通过集成获得。
5. GitHub 是 v1 的 Issue、身份、PR、Review 与 Decision 权威来源。
6. v1 明确不做 Web 审批后台，不建立第二套工作管理系统。
7. 六个月只闭合一条纵向链路：`Issue → Agent → Evidence → Review → PR → Merge`。
8. Intent 是外部 Issue 的结构化附件，不是新的需求权威来源。
9. 团队协作需要真实 Team Service + SQLite，本地浏览器状态不构成团队产品。
10. 标准、协议和通用 Provider 应由真实 traction 反向提炼，而不是先验设计。

这些不是普通设计偏好，而是防止项目变成“大而全平台”的边界条件。

## 3. 当前平台事实

截至本次审查，Workbench 已经覆盖：

- Intent、Context、Agent Run、Evaluation、Evidence、Review、Release 和 Feedback；
- Durable Workflow、Policy Decision、Attestation、Trace、Telemetry Export 和 Bounded Autonomy；
- 14 个默认导航页面；
- 17 个专项 Smoke Test；
- 约 6,200 行 TypeScript / TSX 核心代码；
- 多个 Local 或 Mock Provider，但 GitHub、Agent 与 Deployment 仍未形成真实纵向链路；
- 以 `localStorage` 为主的单浏览器状态，而不是可被小团队共享的服务；
- 审查时长、证据展开率、返工率等价值指标仍是静态演示数据。

当前原型证明了“这套控制面概念可以被表达”，但还没有证明“审查者因此更快作出更好的决定”。

## 4. 偏航评分

评分含义：`0 = 未开始`，`1 = 概念或 Mock`，`2 = 可用但未验证`，`3 = 真实用户验证`。

| 产品原则 | 当前分 | 评审 |
| --- | ---: | --- |
| 小团队用户定位 | 1 | UI 呈现为平台运营后台，尚无真实小团队使用证据 |
| 降低审查人时 | 0 | 指标未采集，核心价值仍不可证伪 |
| Attach before Replace | 1 | GitHub 权威原则保留，但默认交互已经转入自研 Workbench |
| 一条纵向链路 | 1 | 对象齐全，真实 GitHub + Agent + CI + Review 未闭合 |
| Context Consumption | 2 | 模型与事件已较完整，缺真实运行读取数据 |
| AC ↔ Evaluation Mapping | 2 | 原型较完整，缺真实 PR 中对审查决策的贡献验证 |
| Human Accountability | 2 | 具名身份与禁自批模型明确，仍是本地模拟身份 |
| Team Shared Service | 0 | `localStorage` 无法支持多人并发、身份和持久化 |
| Evidence Portability | 2 | Schema、Repository、摘要链和导出机制较丰富 |
| 方法论资产 | 3 | 文档、领域模型、约束和决策边界已经具备公开讨论价值 |

## 5. 直接冲突

### 5.1 “不做 Web 审批后台”与 14 页控制台冲突

当前默认导航包含评审队列、发布、证据中心、追溯、策略、团队、度量等完整后台能力。它们作为参考架构可以保留，但不能继续被呈现为 v1 默认产品。

### 5.2 “Review Bandwidth before Governance”与工程投入冲突

项目已经深入实现治理、遥测、证明、工作流和自治决策，却没有先实现：

- 真实 GitHub PR Comment / Check；
- 一个真实 Agent Adapter；
- 一个真实容器执行边界；
- 两个真实身份的作者—审查者闭环；
- Active Review Time 的开始、暂停、结束和基线采集。

### 5.3 “平台拥有脊椎，不拥有器官”与 Provider 扩张冲突

Provider Contract 本应从第二个真实集成中提炼，现在却在第一个真实集成前形成了较大的抽象面。结果是接口越来越完整，产品价值仍未被验证。

### 5.4 “团队产品”与浏览器本地状态冲突

团队成员、权限、审查队列和度量如果只存在于单个浏览器，就只能证明 UI 概念，不能证明协作语义、身份边界或并发行为。

## 6. 类似产品：借鉴什么，不借鉴什么

借鉴同类产品是必要的，但对象应该是**已验证的行为机制**，而不是完整功能目录。

| 对标产品 | 已验证机制 | 当前应借鉴 | 不应照搬 |
| --- | --- | --- | --- |
| GitHub Copilot cloud agent | Issue / Chat 委派、隔离环境执行、Branch / PR 交付、人审、PR 生命周期指标 | GitHub 作为主工作面；一个任务一个分支和 PR；日志透明；以 time-to-merge 和 PR outcome 观测结果 | GitHub-only 云运行假设；把 Agent 实现和控制面绑定为单一产品 |
| Linear Agents | 人仍是 Issue owner，Agent 是被委派的执行者；活动历史保留责任链 | `human owner + delegated agent` 责任模型；Intent 不脱离现有 Issue | 重建 Linear 式通用项目管理、Inbox、Roadmap 和团队工作台 |
| Qodo Merge | 在 PR 内提供结构化 Review / Compliance Summary、Ticket 对齐、持久评论和审查工作量提示 | 单个可更新的 Evidence Summary；AC / Ticket 对齐；按风险突出需要人看的内容 | 以模型判断直接充当确定性门禁；过早建设企业级规则中心 |
| Graphite | 小而可审的变更、Review Queue、Merge Readiness、减少审查等待 | 鼓励 Agent 输出更小的 PR；队列中优先暴露阻塞和风险；复用 GitHub Merge Queue | 自研第二套完整 PR Review UI 和 Merge Queue |
| OpenHands | Agent 与 Runtime / Sandbox 分离，可观察执行轨迹 | 选择一个真实 Agent + Container；保存最小结构化轨迹和实际 Context Consumption | 在 MVP 前支持多 Agent Runtime、通用 Session 平台和复杂编排 |
| GitLab Duo Agent Platform | Agent / Flow 嵌入现有 SDLC；支持工具审批、审计和自托管形态 | 长期参考 Agent Flow、工具级审批和 GitLab 私有化适配 | 与 GitLab 一样覆盖完整 DevSecOps 生命周期；第一阶段复制治理仪表盘 |
| Sentry Seer | 从生产问题和根因分析派生修复工作并回到代码变更 | 在真实 Review Spine 稳定后，把生产故障转成新 Intent / Regression | 第一阶段建设完整 AIOps、部署和事故响应平台 |

### 6.1 最值得立即采用的四个模式

1. **工作留在现有系统。** Issue、PR、Review、Merge 和身份仍由 GitHub 承载。
2. **人拥有责任，Agent 接受委派。** Agent 可以执行，但不能成为业务责任主体。
3. **证据在 PR 内渐进披露。** 默认先给可决策摘要，需要时再展开 Context、Eval 和 Trace。
4. **以审查结果而不是功能数量衡量。** 记录 Active Review Time、Decision Latency、Review Cycle 和缺陷护栏。

### 6.2 借鉴机制的准入公式

任何类似产品的启发，必须依次经过：

```text
Observed Pattern
→ Product Hypothesis
→ Small-team Experiment
→ Measurable Review Outcome
→ Adopt / Reject / Keep in Lab
```

如果不能说明它将如何降低审查时间、提高证据可信度或降低缺陷风险，就不能进入默认产品。

## 7. 保留、暂停与移出默认产品

| 处理 | 能力 | 决策理由 |
| --- | --- | --- |
| 保留并优先 | GitHub Issue / PR authority projection | v1 的工作面与真实身份来源 |
| 保留并优先 | Context Manifest / Consumption | AI 变更相对传统 CI 的关键新增证据 |
| 保留并优先 | AC ↔ Eval Mapping + 新增测试标注 | 直接帮助审查者判断“是否满足意图” |
| 保留并优先 | PR Evidence Summary | 最直接的用户可见价值载体 |
| 保留并优先 | Human owner、禁自批、风险分级 | Human-governed 的最小责任闭环 |
| 保留但简化 | 结构化事件、确定性门禁、Evidence Schema | 只保留纵向链路实际用到的字段 |
| 移入 Lab | Provider Catalog、Trace Explorer、Telemetry Export | 有方法论价值，当前不影响审查结果 |
| 移入 Lab | Attestation、DSSE、透明日志 | 面向更高合规等级，不是第一阶段用户痛点 |
| 移入 Lab | Durable Workflow 管理和 Replay UI | 真实执行稳定性出现需求后再产品化 |
| 移入 Lab | Deployment、Rollback、Production Feedback UI | 先通过 Provider 引用外部结果，不自研交付平台 |
| 移入 Lab | Team RBAC、Policy Console、Autonomy Console | MVP 使用 GitHub 身份、仓库规则和少量配置 |
| 暂停新增 | 新 Provider、新治理页面、新标准化协议 | 直到第一条真实纵向链路满足退出条件 |

“移入 Lab”不等于删除代码。它意味着：

- 不出现在默认导航；
- 不进入 MVP 完成度统计；
- 不作为下一阶段优先事项；
- 只作为 Reference Architecture、方法论示例和未来 Contract 素材维护。

## 8. 四周纠偏计划

### Week 1：真实 GitHub 审查面

- 建立 GitHub App 或最小 API 集成；
- 从真实 Issue 读取 Intent 与 AC；
- 在真实 PR 写入单个可更新的 Evidence Summary；
- 用 Check Run 表达确定性通过、失败和证据过期；
- Head SHA 变化时撤销旧 Evidence 与 Approval。

### Week 2：真实 Agent 与 Context Consumption

- 只选择一个 Agent 做深度集成；
- 使用 Git worktree + 强制 Container；
- 采集声明 Context、实际读取 Context、未声明读取和未消费声明；
- 生成真实 Diff、Test、Artifact 和最小 Transcript 引用。

### Week 3：真实 AC ↔ Eval 证据

- 导入现有 CI 的 JUnit / SARIF / Coverage / Command 结果；
- 区分既有测试与 Agent 新增测试；
- 将每个 Critical AC 映射到可复验 Eval；
- 在 PR Summary 中只突出缺口、失败、风险和需要人判断的部分。

### Week 4：真实小团队验证

- 邀请 1–3 个符合边界的小团队；
- 至少由两个真实身份完成作者—审查者流程；
- 采集使用前后的 Active Review Time、Decision Latency、Review Cycle；
- 记录证据展开、被忽略证据、错误信号和审查者主观帮助度；
- 根据数据决定继续、收缩或转向，而不是根据原型完整度决定。

## 9. 下一阶段停止条件

以下条件全部满足前，不增加新的 Provider 或控制台页面：

1. 至少一个真实任务从 GitHub Issue 运行到 Evidence Package 和 PR Review。
2. 至少两个真实身份完成作者与审查者职责分离。
3. 至少一名非作者审查者确认 Evidence Summary 对真实决策有帮助。
4. Active Review Time 或 Decision Latency 相对基线出现改善。
5. 缺陷、返工或安全风险护栏没有恶化。
6. 团队状态由共享服务保存，而不是只存在于单浏览器。

如果四周后仍无法获得第 3、4 项，应优先修改 Evidence Summary 和任务边界，而不是增加治理能力。

## 10. 最终产品建议

默认产品不再被描述为一个全功能“AI Native SDLC 管理后台”，而应被描述为：

> 一个附着在现有 Issue、Agent、CI 和 Git Review 之间的 AI Change Review Control Plane；它把意图、上下文消费、评估和责任证据压缩成审查者可快速决策的 PR 摘要。

Workbench 可以继续存在，但角色需要改变：

- 默认模式：仅展示真实纵向链路的运行状态和诊断；
- Lab 模式：展示完整 Reference Architecture、Provider、Attestation、Trace 和自治研究；
- GitHub：仍是 v1 的日常审查与批准界面；
- 文档：继续沉淀 AI Native SDLC 方法论、领域模型和开放 Schema。

这既保留了当前研究成果，也恢复了最初产品假设的可验证性。

## 11. 参考入口

- GitHub Copilot cloud agent: https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
- Linear issue delegation: https://linear.app/docs/assigning-issues
- Qodo custom compliance and PR review: https://docs.qodo.ai/qodo-documentation/code-review/qodo-merge/features/custom-compliance
- Graphite documentation: https://graphite.com/docs
- OpenHands: https://github.com/OpenHands/OpenHands
- GitLab Duo Agent Platform: https://docs.gitlab.com/user/duo_agent_platform/
- Sentry Seer: https://docs.sentry.io/product/ai-in-sentry/seer/

