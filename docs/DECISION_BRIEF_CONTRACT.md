# Decision Brief Contract

> 版本：`aperture.decision-brief.v1`  
> 日期：2026-09-29  
> 范围：Change Proposal 人工审查；只读投影；不包含自动批准、自动合并或自动发布

## 目标

Decision Brief 把一次 AI Change 的 Intent、Revision、Context、Skills、Execution、Evaluation、Evidence 与 Review Responsibility 压缩成 Reviewer 可以先读的一页信息。

```text
Intent + Current Head Revision + Review Readiness
+ Context / Skills / Runtime Boundary + Evidence Views + Assignment
→ Reviewer-specific Decision Brief
→ Human opens underlying evidence when needed
→ Human approves, requests changes, comments or rejects
```

它是 Control Plane 对现有事实的即时投影，不是新的事实源，也不是 AI 给出的批准建议。

## 权限与绑定

- 只有项目 `owner`、`maintainer`、`reviewer` 可以读取。
- `developer` 和 Proposal 作者不会因为是作者而获得审查摘要权限。
- 所有 Gate、Check、Acceptance Criterion、Evidence 与既有 Review Decision 都绑定当前 `headSha`。
- Revision 变化后，旧 Check、Evidence 与 Review 的失效规则仍由原有 Review Readiness 负责；Decision Brief 不绕过失效逻辑。
- `viewedByReviewer` 按发起当前请求的 Reviewer Actor 计算，不代表其他人已经阅读。
- Assignment 的 Evidence 打开时间和审查耗时属于被分配 Reviewer，不一定属于当前查看摘要的人。
- `viewer` 单独表达当前查看者是 Author、Assignee 还是 Observer，以及是否能提交终态决定；Gate 就绪不自动赋予决定权限。

## 确定性下一步

`gate.nextAction` 只表达 Proposal / Gate 的确定性状态，不代表当前查看者有权限执行：

| 值 | 含义 |
| --- | --- |
| `resolve_blockers` | 当前 Head 的 Check、Evidence 或关键验收标准尚未满足门禁。 |
| `review_human_judgement` | 自动证据已足够进入审查，但仍有 Human Criterion 或 Test Review 需要人判断。 |
| `review_and_decide` | 门禁已就绪，Reviewer 可以开始审查并作出自己的决定。 |
| `already_decided` | 当前 Revision 已存在批准等终态决定。 |
| `await_revision` | 已请求修改，等待新 Revision。 |
| `completed` | Proposal 已合并或关闭，不再需要当前审查动作。 |

`ready` 和 `review_and_decide` 均不等于“应该批准”。Reviewer 仍需对 Diff、风险与证据承担责任。

## 数据来源边界

| 区域 | 权威来源 | 不作出的声明 |
| --- | --- | --- |
| Intent | SQLite 中已绑定的 Intent Version | 不判断目标本身是否正确。 |
| Revision | Change Proposal 的 Base / Head SHA 与 Git 投影 | 不替代代码 Diff 阅读。 |
| Gate | `getReviewReadiness` 的当前 Head 结果 | 不预测合并后的生产行为。 |
| Context | Agent Run 事件中的平台注入、Builder 上报、拒绝和未声明读取 | Builder 自报告不升级为平台验证事实。 |
| Skills | Manifest 绑定的 Catalog、`skill_loaded` 与 `skill_rejected` 事件 | Catalog 声明不等于实际加载；运行内工具事件不冒充 OS 级独立观测。 |
| Execution | 本地 Agent Run 或外部 Run 引用 | 外部引用没有本地 Runtime Attestation 时，不推断隔离或生产资格。 |
| Evidence | 当前 Head 的 Evidence Package 元数据与 Evidence View | 摘要不替代打开并校验证据包。 |
| Review | 当前 Head 的 Review Decision 与 Review Assignment | 不代表系统替 Reviewer 作出批准。 |

## Execution Source

`execution.source` 必须明确区分三种来源：

- `local_agent_run`：存在本地受管 Agent Run，可以投影 Adapter、Status、Isolation 与 `productionEligible`。
- `external_run_reference`：Proposal 只保存外部 `runId`，没有本地 Agent Run；Runtime 字段保持未知，不能显示为人工提案，也不能伪造 Attestation。
- `manual`：Proposal 没有任何 `runId`；不声称存在 Agent Execution。

Process Runtime 的真实值仍必须保持 `unisolated_process` 与 `productionEligible=false`。未知值必须显示为 `unknown`，不能用 `false` 冒充已验证结论。

没有本地 Agent Run 时，`context.observation=unavailable`。此时 Context 与 Skills 的六个计数为投影默认值，不表示平台验证了“零次访问或加载”。

## Evidence Summary Derivation

外部请求只能提交 Evidence Package 的 URI、Digest、Run ID 与 Head SHA。以下影响门禁、Decision Brief 或 Release 的字段必须从 Digest 校验通过的包内容派生，忽略请求中的同名声明：

- `status`、`totalChecks`、`passed`、`failed`；
- `artifactCount`；
- `independentTestSignal`；
- `criteriaCoverage`；
- Event Chain Heads；
- Policy Files、Builder Stop、Package Schema 与 Generated Time。

包中不存在独立测试来源时，Decision Brief 必须显示 `unknown` 并进入 Attention，不能把未知当作通过。

## API

```http
GET /api/change-proposals/:proposalId/decision-brief
POST /api/change-proposals/:proposalId/decision-brief
```

`GET` 只读取当前投影，不写数据库、不追加事件。只有 `viewer.canRecordTerminalDecision=true` 的 Actor 在实际打开摘要后，UI 才调用 `POST` 记录首次查看；作者、旁观者、预取和刷新不进入采用指标。`POST` 按 `Proposal + Head SHA + Reviewer` 幂等。

返回：

- `generatedAt`
- `proposal`、`workItem`、`intent`
- `gate` 与确定性 `nextAction`
- `context` 统计，包括平台注入、Builder 上报、拒绝、未声明读取、Skill 加载和 Skill 拒绝
- `execution` 来源与已知 Runtime 边界
- 当前 Head 的 `evidence`
- `review` Assignment、当前 Decision、Evidence 打开时间与 Assignment Cycle Elapsed Time
- 当前请求 Actor 的 `viewer` 权限与限制原因
- 需要 Reviewer 注意的 `attention`

Decision Brief 当前不单独持久化；每次读取都从 Control Plane 当前状态重新生成。显式 `POST` 只持久化第一次打开时间；该记录是采用测量，不是 Review Decision，也不会自动改变 Proposal 状态。

## UI 规则

- 默认先显示“为什么存在、需要决定什么、当前阻断是什么”。
- Evidence 只显示摘要和当前 Reviewer 是否展开，并保留打开原始 Evidence Package 的入口。
- 外部 Run 必须显示为“外部 Run 引用 / Runtime 未验证”。
- Context / Skills 来源不可用时必须明确说明计数不是已验证的零次访问或加载。
- `productionEligible` 未知时显示 `unknown`，不能默认显示 `false` 或 `true`。
- 禁止使用“AI 建议批准”“自动批准概率”等措辞。
- Assignment Cycle Elapsed Time 包含排队和等待，不得标记为 Reviewer Active Time。

## 价值验证

Decision Brief 是否成功，不以字段数量判断，而以真实 Reviewer 行为判断：

- Evidence 打开到 Decision 的中位时间是否下降；
- Decision Brief 首次打开到终态 Decision 的中位时间及其样本数；
- 每个被接受 AI Change 的可信人工审查分钟数是否下降；
- Evidence 展开后批准的比例及样本数；
- Changes Requested 轮次与合并后回滚率是否恶化；
- Reviewer 是否仍需在多个页面搜索同一 Revision 的基础事实。

至少连续记录 10 个真实 Change 后再判断采用价值。若只缩短时间却提高回滚、漏审或错误批准，不视为成功。

## 当前边界

- 尚未内嵌代码 Diff；Reviewer 仍需进入代码宿主或仓库查看变更内容。
- 尚未形成与上一 Revision 的语义差异摘要。
- Policy 目前主要通过 Policy File、门禁结果和 Criterion Override 间接呈现，尚未形成统一 Policy Decision 摘要。
- 外部 GitHub/GitLab Run 只有引用时，不具备本地 Runtime、Context 或 Attestation 证明。
- 当前没有真实团队连续 10 个 Change 的前后对照数据。
