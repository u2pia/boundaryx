# AI Native SDLC Control Plane 开源生态与复用策略

> 状态：Draft v0.2（小团队 · 全周期）
> 日期：2026-09-22
> 说明：本文件是架构选型基线，不构成最终依赖承诺。项目版本、许可证和维护状态必须在引入代码前再次核验。
> 修订：本版由 **Claude（Opus 5）** 依据 2026-09-22 评审意见改写。v0.1 原稿见 [_original-v0.1/OPEN_SOURCE_LANDSCAPE.md](_original-v0.1/OPEN_SOURCE_LANDSCAPE.md)，逐条改动见 [../REVIEW-CHANGES.md](../REVIEW-CHANGES.md)。改动以 `〔C·改〕`、`〔C·新〕`、`〔C·删〕` 标记。
>
> 〔C·说明〕v0.1 的选型判断大体成立，本版的改动集中在**定位变化带来的时点前移**：团队共享服务进入 MVP（[PRODUCT_CHARTER.md](PRODUCT_CHARTER.md) §6 阶段 1），于是身份、通知、Issue Tracker 集成、持久化工作流和策略引擎从"以后再说"变成"第一阶段就要有答案"。

## 1. 决策原则

采用四级决策：

| 决策 | 含义 |
| --- | --- |
| Adopt | 直接采用开放标准或稳定组件 |
| Integrate | 通过 Adapter 接入，不成为核心领域依赖 |
| Reference | 借鉴架构和实践，不直接形成运行依赖 |
| Build | 自研构成项目差异化的领域能力 |

优先级：

```text
Adopt → Integrate → Extend → Build
```

不以"是否热门"作为选型依据，而以开放性、可替换性、私有化、安全性、成熟度和领域匹配为依据。

〔C·新〕补两条小团队专属的否决条件：

- **运维成本一票否决**：需要团队额外维护一个服务进程或数据库的组件，第一阶段不引入。3–8 人团队没有专职平台工程师。
- **单命令部署可行性**：任何候选项目必须能被 `ainative serve` 一条命令带起，或作为进程内库使用。

## 2. 能力版图

| 能力 | 候选项目或标准 | 初步决策 |
| --- | --- | --- |
| 规格驱动开发 | GitHub Spec Kit、OpenSpec、SpecD、Spec Kitty | Integrate / Reference |
| Coding Agent | OpenHands、SWE-agent、Aider 及外部 CLI Agent | Integrate（〔C·改〕第一阶段只做一个） |
| Agent 工具协议 | MCP | Adopt at boundary |
| Agent 间协作 | A2A | Observe / future Adopt |
| Durable Workflow | Temporal、〔C·新〕River / 进程内队列 | 〔C·改〕月 3 前给出结论 |
| Policy as Code | Open Policy Agent、〔C·新〕Cedar | 〔C·改〕月 4 决策，先定 Decision Contract |
| AI 可观测性 | OpenTelemetry、Langfuse | Adopt / Integrate |
| AI 评估 | Promptfoo、DeepEval 等 | Integrate |
| 开发者平台 | Backstage | Reference |
| 软件供应链 | SLSA、in-toto、Sigstore、SBOM | 〔C·改〕Reference；第一阶段只做内容摘要 |
| 安全结果格式 | SARIF | Adopt |
| 测试结果格式 | JUnit XML、Coverage 标准格式 | Adopt |
| Git 平台 | GitHub，后续 GitLab | Integrate |
| 执行隔离 | 〔C·改〕Docker（必需）+ Git worktree | Adopt |
| 〔C·新〕Issue Tracker | GitHub Issues/Projects、Linear、Jira | Integrate（GitHub 先行） |
| 〔C·新〕身份与授权 | GitHub OAuth App / OIDC | Adopt |
| 〔C·新〕审查界面 | GitHub PR Comments + Checks API | Adopt（**不自研 Web 审批界面**） |
| 〔C·新〕通知 | Slack Incoming Webhook、GitHub 通知 | Integrate |
| 〔C·新〕指标 | 自有 SQLite 查询 + CSV 导出 | Build minimal |

## 3. 规格与意图层

### 3.1 GitHub Spec Kit

值得借鉴：

- Specification-first；
- 从 Specify、Plan、Tasks 到 Implement 的显式过程；
- 规格、计划和任务位于仓库中；
- 支持不同 Coding Agent；
- 扩展和工作流机制。

不直接复制：

- 不把其命令结构作为 Control Plane 核心状态机；
- 不假设所有任务都需要同样重量的规格过程；
- 不把某个 Agent 的 Prompt 模板当作稳定协议。

初步决策：`Integrate / Reference`。

〔C·新〕小团队补充判断：Spec Kit 类工具解决的是"如何让 Agent 写对"，本项目解决的是"如何让另一个人敢接受它写的"。二者互补而非竞争，因此规格层优先集成而非自研——项目的差异化不在这一层。

### 3.2 OpenSpec

值得借鉴：

- 面向既有项目的轻量 Spec-driven Workflow；
- Proposal、Specification、Design、Tasks、Apply、Verify、Archive；
- 可定制制品和项目规则；
- 规格变更与代码共同版本化。

初步决策：优先研究其仓库原生体验，作为第一个规格导入 Adapter 候选。

### 3.3 SpecD

值得借鉴：

- Context Compilation；
- 规格、源码和依赖关系；
- 变更影响分析；
- 防止长任务中的规格漂移。

初步决策：`Reference`，重点吸收 Context Manifest 和影响分析思想。

### 3.4 Spec Kitty

值得借鉴：

- Spec、Plan、Tasks、Review、Accept、Merge 的完整过程；
- Git worktree 隔离；
- 多 Agent 工作包；
- Review 与 Accept 分离。

初步决策：`Reference`。〔C·改〕多 Agent 不进入第一阶段，但它的 **Review 与 Accept 分离**是本项目审查模型的直接参照，优先级从"以后看看"提到"月 1 前读完"。

## 4. Agent 执行层

### 4.1 OpenHands

值得借鉴：

- Agent SDK 与服务端分离；
- Workspace 抽象；
- 工具与运行环境；
- 本地、容器和远程执行模式；
- 可构建自定义软件工程 Agent。

Control Plane 的关系：

- OpenHands 是执行平面候选；
- Control Plane 管理 Intent、Policy、Evaluation 和 Evidence；
- 〔C·改〕第一阶段做**一个深度集成**，Adapter Contract 推迟到接第二个 Agent 时再抽象。过早定义适配契约会得到一个只适配了一个实现的契约。

初步决策：`Integrate`，不 Fork 核心代码作为项目基础。

### 4.2 SWE-agent

值得借鉴：

- Issue-to-code-change 的聚焦任务模型；
- Agent/Environment 接口；
- 软件工程任务评估方法；
- 适合建立 Adapter 测试样例。

初步决策：`Reference / optional Integrate`。

### 4.3 Aider 与外部 CLI Agent

值得借鉴：

- Git-native 交互；
- 低部署成本；
- 〔C·改〕适合作为**单人安装阶段**的接入对象——这正是采用路径的第一级台阶（见 [README.md](../README.md) 采用路径）。

初步决策：〔C·改〕第一阶段选定一个 CLI Agent 做深度集成并跑通端到端；通用 CLI Adapter 在第二个 Agent 出现时抽象。

### 〔C·新〕4.4 隔离与强制边界

v0.1 把 Docker 列为"可选"，并在选型问题中留了"Docker 是否默认启用"。在团队定位下这条不能悬置：

- Git worktree 只隔离文件，不隔离网络、进程和凭证；
- 没有容器边界，`.ainative/policies/` 的只读约束无法强制（见 [DOMAIN_MODEL.md](DOMAIN_MODEL.md) §9.1.1）；
- 没有强制边界，所有策略只能是检测性的，产品不得声称"阻止"。

决策：**容器为默认且必需**。无容器模式保留为显式降级选项，且此时证据中必须标注所有策略为检测性。候选：Docker 优先；后续评估 Podman（rootless）与 Kubernetes（非第一阶段）。

## 5. 工作流与状态恢复

### 5.1 Temporal

值得借鉴：

- Durable Execution；
- Workflow 与 Activity 分离；
- 重试、超时、Signal、Timer；
- 长时间等待人工审批；
- 失败后恢复执行状态。

〔C·改〕不在第一阶段直接采用的原因（理由已变）：

- 原因不再是"对个人 CLI 过重"，而是**违反运维成本一票否决**：Temporal 需要独立服务与数据库；
- 但团队场景下它的价值显著上升：等待人工审批本质上就是一个可能持续数天的挂起工作流，Run 的状态机（[DOMAIN_MODEL.md](DOMAIN_MODEL.md) §6.2）现在有 14 个状态和跨天挂起点。

〔C·改〕决策与时点：

- 月 1–2：文件 + SQLite + 事件日志；
- **月 3 团队服务上线时给出明确结论**（v0.1 写的是"Team Server 阶段再评估"，而团队服务已进入 MVP，评估时点必须落到具体月份）；
- 结论的判据：单进程 + SQLite 能否正确处理"进程被杀死时 Run 处于 Running/Evaluating"的恢复，以及 Resource Claim 的超时回收；
- 〔C·新〕若需要持久化队列但不想要 Temporal 的运维成本，优先评估进程内方案（如基于 SQLite 的任务表 + 领导者选举，或 River 一类嵌入式队列）；
- 领域模型避免依赖任何工作流引擎的专有语义。

## 6. 策略与权限

### 6.1 Open Policy Agent

值得借鉴：

- Policy Decision 与 Enforcement 分离；
- 声明式 Policy as Code；
- 结构化输入输出；
- 可嵌入 CI/CD 和服务端。

〔C·改〕第一阶段策略：

- 使用简单 YAML Policy 提供低门槛体验；
- **先冻结内部 Decision Contract**（输入、结果、理由、强制类型 preventive/detective），引擎可替换；
- 月 4 引入策略与沙箱时决定是否接 OPA，判据是 YAML 表达力是否已经不够（v0.1 把这个时点写成"后续"，没有决策点）；
- 不把 Rego 暴露为必需技能；
- 〔C·新〕同时评估 Cedar：策略语言更小、可嵌入、适合"谁能批准什么"这类授权判断，而授权在团队定位下是新增的真实需求（[DOMAIN_MODEL.md](DOMAIN_MODEL.md) §5.10）。

### 〔C·新〕6.2 身份与授权

团队定位引入的新能力域。v0.1 完全没有覆盖，而没有身份就没有审批。

- **身份源**：GitHub OAuth App（团队已有 GitHub 账号，零额外账号管理成本）；
- **为什么不自建用户表**：3–8 人团队不会愿意维护第二套账号，且本地字符串身份不能作为审批凭据；
- **授权**：第一阶段用固定角色（member / maintainer），不做 RBAC；
- **不自签名**：Evidence 签名（Sigstore）推迟，第一阶段用内容摘要 + GitHub 身份即可满足"谁批的"这个问题；
- 后续方向：OIDC 以支持 GitLab/自建 IdP。

## 7. 可观测性与评估

### 7.1 OpenTelemetry

采用方向：

- 使用 Trace、Metric、Log 的开放传输能力；
- 将 Run、Agent、Tool、Evaluation 映射为 Span；
- 领域对象保留自己的 Schema，不直接绑定仍在演进的 GenAI 字段；
- 提供可选 OTLP Exporter，离线模式默认关闭外发。

初步决策：`Adopt`。〔C·新〕但第一阶段不依赖它计算产品核心指标——审查人时与证据展开率来自领域事件（`EvidenceOpened` / `DecisionRecorded`），必须在没有任何可观测性后端时也能算出来。

### 7.2 Langfuse

值得借鉴：

- LLM 和 Agent Trace；
- Prompt、模型、成本和延迟观测；
- Evaluation 和人工反馈；
- 自托管能力。

初步决策：`Integrate`，作为可选观测后端，不成为本地核心状态存储。〔C·新〕受运维成本一票否决约束：默认不启用。

### 7.3 Promptfoo 与其他 Evaluation 工具

值得借鉴：

- 评估用例与断言；
- 模型和 Prompt 对比；
- 安全与红队测试；
- CI/CD 集成。

初步决策：通过 Evaluation Adapter 接入。Control Plane 负责门禁语义和 Evidence，不重写所有评估执行器。

〔C·新〕无论用哪个执行器，`provenance` 字段（这个证明是既有的，还是本次运行新造的）必须由 Control Plane 自己判定——它依赖 Git diff，而不是执行器的报告。这是不可外包的一段逻辑。

### 〔C·新〕7.4 指标

产品的成功标准是三个可被伪证的数字（[PRODUCT_CHARTER.md](PRODUCT_CHARTER.md) §8）。实现方式：

- 数据源：SQLite 中的事件日志；
- 计算：`ainative metrics` 直接 SQL 聚合，不引入指标后端；
- 导出：CSV / JSON，便于团队自行对比与对外公布；
- 决策：`Build minimal`。这一层数据量在小团队场景下是数千行级别，引入任何指标基础设施都是过度工程。

## 8. 开发者平台与插件

### 8.1 Backstage

值得借鉴：

- 小型核心与独立插件；
- Extension Point；
- 前端、后端和公共模型分离；
- 平台负责组装，不包办所有业务能力；
- 通过 Software Catalog 统一资源身份。

初步决策：`Reference`。

〔C·改〕插件类型是**目标形态而非第一阶段交付**。第一阶段只有 Git Provider 与 Evaluation 两处需要真实的可替换点，其余全部硬编码：

```text
第一阶段实现：Git Provider Adapter、Evaluation Adapter
第一阶段硬编码：Agent（一个深度集成）、Issue Tracker（GitHub）、Notification（Slack webhook）
后续：Spec Adapter、Policy Adapter、Evidence Exporter、Observability Exporter
```

〔C·新〕理由：插件体系的价值随第二个实现的出现才显现。只有一个实现时，抽象层是纯成本。

### 〔C·新〕8.2 Issue Tracker 集成

- **GitHub Issues + Projects**：第一阶段唯一支持目标。Issue 是 Intent 的权威来源（[DOMAIN_MODEL.md](DOMAIN_MODEL.md) §5.2）；
- **Linear**：第二优先，小团队占有率高，API 质量好；
- **Jira**：需要时再做，字段模型复杂度显著高于前两者；
- 决策：`Integrate`。同步必须是显式状态，失败不得静默。

### 〔C·新〕8.3 通知

审查带宽的一半问题是"没人知道有东西要审"。

- **Slack Incoming Webhook**：实现成本最低，覆盖大多数小团队；
- **GitHub 通知**：PR 评论天然触发，零成本，优先依赖；
- 决策：`Integrate`，月 3 随团队服务交付；不自建通知系统。

## 9. 软件供应链与证据

### 9.1 SLSA 与 in-toto

值得借鉴：

- Provenance；
- Builder、Build Process、Input 和 Artifact 的可验证关系；
- Attestation；
- 软件供应链证据可以独立传递和验证。

扩展方向：

```text
Software Provenance
+ Intent Snapshot
+ Agent Identity and Profile
+ Model Reference
+ Context Manifest
+ Tool Execution Summary
+ Evaluation Results
+ Human Decision
```

〔C·改〕初步决策：Evidence Schema 的**结构**参考 in-toto Statement（subject / predicate 分离），但第一阶段不产出 attestation，也不承诺兼容导出。理由：目标团队没有合规要求，供应链证明解决的是跨组织信任问题，而小团队的问题是同事之间的审查成本。把它列为第一阶段目标会挤占唯一核心尺子的预算。

### 9.2 Sigstore

值得借鉴：

- Artifact 和 Attestation 签名；
- 短期身份凭证；
- 可验证的签名和透明性机制。

〔C·改〕初步决策：**不在 12 个月路线图内**。v0.1 把它放在"Team Server 阶段"，而团队服务已提前到月 3，容易被误读为月 3 就要签名。签名的价值出现在有外部审计方或跨组织交付时，那是另一个产品阶段。第一阶段用内容摘要 + 不可变引用 + GitHub 身份。

### 9.3 SARIF、JUnit 和 Coverage

这些格式用于吸收现有工程工具结果：

- SARIF：静态分析和安全结果；
- JUnit XML：测试结果；
- Coverage：覆盖率；
- JSON Schema：项目领域对象校验。

初步决策：`Adopt`，不创建不必要的替代格式。

〔C·新〕这一条是第一阶段价值密度最高的选型：团队的 CI 已经在产出这些文件，读取它们并映射到验收标准，是"零新增工作量就得到可审证据"的唯一路径。月 1 必须完成。

## 10. 协议边界

### 10.1 MCP

适合用于：

- Agent 访问工具；
- Agent 获取受控上下文；
- 将现有系统暴露为标准能力。

Control Plane 不应把所有内部领域 API 都改造成 MCP。MCP 位于 Agent/Tool 边界，核心状态和策略仍通过确定性服务管理。

〔C·新〕安全约束：MCP 工具的输入可能来自 Issue 正文、PR 评论等不可信文本，存在提示注入路径（见 [PRODUCT_CHARTER.md](PRODUCT_CHARTER.md) §11 风险表）。因此 MCP 侧的每次工具调用都必须经过 Policy 判断，且判断不得由模型完成。

### 10.2 A2A

适合未来多 Agent 协作、任务委托和跨运行时通信。

第一阶段不依赖 A2A，因为只需要一个主执行 Agent 和若干确定性工具。保留未来 Adapter 位置即可。

## 11. 自研核心

以下能力构成项目差异化，应由项目维护自己的稳定模型：

### 11.1 Intent Graph

连接目标、约束、验收标准、工作任务和实际变更。

### 11.2 Context Supply Chain

管理上下文来源、版本、权限、时效、敏感性和实际消费记录。〔C·新〕含声明与实际消费的对账（[DOMAIN_MODEL.md](DOMAIN_MODEL.md) §5.3）——这是 v0.2 认定的两项真实增量之一。

### 11.3 Risk-adjusted Autonomy

根据任务、环境、Agent、证据和风险决定允许的自治等级。

### 11.4 Evaluation Contract

把确定性测试、场景评估、模型评估和人工判断统一映射为发布门禁。〔C·新〕含验收标准 ↔ 评估项的映射与 `provenance` 标注——另一项真实增量。

### 11.5 Evidence Graph

连接执行事实、评估结果、策略决策、人工审批和发布对象。

### 11.6 Intent-to-Production Traceability

提供从生产变更反向追溯到 Intent 的稳定链路。

### 〔C·新〕11.7 Review Bandwidth Model

审查任务的分配、排队、耗时与展开行为的建模。这是本项目**唯一核心尺子**的载体，也是市面上现有工具都不做的部分：Git 平台管 PR 但不管审查成本，DORA 类工具管交付速度但不管单次审查的人时。

### 〔C·删〕11.8 AI Native SDLC Metrics

〔C·删〕原 §11.7「AI Native SDLC Metrics」（Intent Lead Time、首次评估通过率、人工介入率、Agent 返工率、Evidence 完整率、缺陷逃逸率、单位可信交付成本）**从自研差异化核心中移除**。理由：一套七项指标体系不是差异化来源，是 traction 的产物；把它列为自研核心会诱导在没有用户数据前先建指标框架。保留其中三项进入产品成功标准（[PRODUCT_CHARTER.md](PRODUCT_CHARTER.md) §8），实现方式见 §7.4 的 `Build minimal`。

## 12. 初步 Build/Reuse 决策

| 能力 | 决策 | 第一阶段实现方式 |
| --- | --- | --- |
| Intent Schema | Build | JSON Schema + Git 文件 |
| 〔C·新〕Issue Tracker 同步 | Integrate | GitHub Issues API，字段所有权见领域模型 §5.2 |
| Specification | Integrate | 内置最小格式 + 外部导入 |
| Context Manifest | Build | 开放 Schema + 消费对账 |
| Coding Agent | 〔C·改〕Integrate | 一个深度集成；Adapter Contract 延后 |
| Workspace | 〔C·改〕Adopt | **Docker 必需** + Git worktree |
| Workflow | Build minimal | SQLite 状态机 + 事件日志；月 3 复评 Temporal |
| Policy | Build minimal | YAML + 冻结的 Decision Contract（含 preventive/detective） |
| Evaluation | Integrate | 命令、JUnit、SARIF、JSON；provenance 自判 |
| Evidence | Build | 开放 Evidence Package Schema |
| 〔C·新〕审查界面 | Adopt | GitHub PR Comments + Checks API，不自研 |
| 〔C·新〕身份 | Adopt | GitHub OAuth App |
| 〔C·新〕通知 | Integrate | Slack Webhook + GitHub 通知 |
| 〔C·新〕指标 | Build minimal | SQLite 聚合 + CSV 导出 |
| GitHub | Integrate | 〔C·改〕GitHub App/API（CLI 无法承载 OAuth 与 Checks） |
| Observability | Adopt | 结构化事件 + 可选 OTLP（默认关闭） |
| Provenance | 〔C·改〕Reference | 内容摘要；in-toto/SLSA 不在 12 个月内 |

## 13. 引入依赖前的评估清单

每个外部项目必须回答：

1. 是否解决当前版本的真实问题？
2. 是否能够完全自托管或离线运行？
3. API、Schema 和扩展点是否稳定？
4. 是否绑定单一模型、云厂商或商业平台？
5. 是否能输出完整 Trace 和机器可读结果？
6. 安全边界和凭证模型是否清晰？
7. 许可证是否兼容项目目标？
8. 社区是否持续维护？
9. 替换成本和数据迁移方式是什么？
10. 是运行时依赖、可选集成，还是仅借鉴设计？
11. 〔C·新〕**是否需要目标团队额外运维一个进程或数据库？** 若是，第一阶段否决。
12. 〔C·新〕**它降低的是审查人时，还是只增加了功能？** 若是后者，不进第一阶段。

## 14. 需进一步验证的选型

〔C·改〕每项补上决策时点——v0.1 的清单没有截止时间，等于没有决策。

| 待定项 | 决策时点 |
| --- | --- |
| 第一个深度集成的 Coding Agent | 月 1 前 |
| Spec Kit 与 OpenSpec 哪个作为首个规格 Adapter | 不在第一阶段，延后 |
| ~~Docker 是否默认启用~~ | 〔C·改〕已决策：必需，见 §4.4 |
| SQLite 与纯文件状态的边界 | 月 1（领域模型 §9 已给出分层） |
| GitHub CLI 与 GitHub App/API | 〔C·改〕已倾向 App/API，月 1 确认 |
| 本地 Trace 的格式、压缩和脱敏 | 月 2 |
| Evidence Package 与 in-toto Statement 的兼容路径 | 延后至有外部审计需求时 |
| OPA / Cedar 的引入时点 | 月 4 |
| 团队服务是否采用 Temporal 或嵌入式队列 | 月 3 |
| 〔C·新〕Slack 之外是否需要第二个通知渠道 | 月 3 后按用户反馈 |
| 〔C·新〕Linear 集成时点 | 有第二个试点团队时 |

## 15. 研究依据

本文件应与仓库现有研究材料共同阅读：

- `AI-Native-SDLC-研究简报.md`
- `research/anthropic-ai-native-sdlc-brief.md`

后续对任何项目形成正式依赖前，应新增独立 ADR，记录版本、许可证、评估日期、采用理由、替换方案和退出策略。
