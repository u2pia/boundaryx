# AI Native SDLC Control Plane 开源生态与复用策略

> 状态：Draft v0.1  
> 日期：2026-09-22  
> 说明：本文件是架构选型基线，不构成最终依赖承诺。项目版本、许可证和维护状态必须在引入代码前再次核验。

## 1. 决策原则

采用四级决策：

| 决策 | 含义 |
|---|---|
| Adopt | 直接采用开放标准或稳定组件 |
| Integrate | 通过 Adapter 接入，不成为核心领域依赖 |
| Reference | 借鉴架构和实践，不直接形成运行依赖 |
| Build | 自研构成项目差异化的领域能力 |

优先级：

```text
Adopt → Integrate → Extend → Build
```

不以“是否热门”作为选型依据，而以开放性、可替换性、私有化、安全性、成熟度和领域匹配为依据。

## 2. 能力版图

| 能力 | 候选项目或标准 | 初步决策 |
|---|---|---|
| 规格驱动开发 | GitHub Spec Kit、OpenSpec、SpecD、Spec Kitty | Integrate / Reference |
| Coding Agent | OpenHands、SWE-agent、Aider 及外部 CLI Agent | Integrate |
| Agent 工具协议 | MCP | Adopt at boundary |
| Agent 间协作 | A2A | Observe / future Adopt |
| Durable Workflow | Temporal | Reference，团队版再评估 Adopt |
| Policy as Code | Open Policy Agent | Reference，后续 Integrate |
| AI 可观测性 | OpenTelemetry、Langfuse | Adopt / Integrate |
| AI 评估 | Promptfoo、DeepEval 等 | Integrate |
| 开发者平台 | Backstage | Reference |
| 软件供应链 | SLSA、in-toto、Sigstore、SBOM | Adopt progressively |
| 安全结果格式 | SARIF | Adopt |
| 测试结果格式 | JUnit XML、Coverage 标准格式 | Adopt |
| Git 平台 | GitHub，后续 GitLab | Integrate |
| 执行隔离 | Git worktree、Docker，后续 Kubernetes | Adopt |

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

初步决策：`Reference`，多 Agent 能力不进入 v0.1 关键路径。

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
- 两者通过 Agent Adapter Contract 解耦。

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
- 适合作为个人开发者阶段的接入对象。

初步决策：优先定义通用 CLI Adapter，而不是为每个 Agent 在核心代码中建立专有逻辑。

## 5. 工作流与状态恢复

### 5.1 Temporal

值得借鉴：

- Durable Execution；
- Workflow 与 Activity 分离；
- 重试、超时、Signal、Timer；
- 长时间等待人工审批；
- 失败后恢复执行状态。

v0.1 不直接采用的原因：

- 对个人本地 CLI 过重；
- 增加部署、运行和调试成本；
- 当前只需要单机可恢复状态机。

初步决策：

- v0.1：文件、SQLite 和事件日志；
- Team Server：重新评估 Temporal；
- 领域模型避免依赖 Temporal 专有语义。

## 6. 策略与权限

### 6.1 Open Policy Agent

值得借鉴：

- Policy Decision 与 Enforcement 分离；
- 声明式 Policy as Code；
- 结构化输入输出；
- 可嵌入 CI/CD 和服务端。

v0.1 策略：

- 使用简单 YAML Policy 提供低门槛体验；
- Policy Engine 定义稳定的内部 Decision Contract；
- 后续提供 OPA/Rego Adapter；
- 不把 Rego 暴露为个人用户的必需技能。

## 7. 可观测性与评估

### 7.1 OpenTelemetry

采用方向：

- 使用 Trace、Metric、Log 的开放传输能力；
- 将 Run、Agent、Tool、Evaluation 映射为 Span；
- 领域对象保留自己的 Schema，不直接绑定仍在演进的 GenAI 字段；
- 提供可选 OTLP Exporter，离线模式默认关闭外发。

初步决策：`Adopt`。

### 7.2 Langfuse

值得借鉴：

- LLM 和 Agent Trace；
- Prompt、模型、成本和延迟观测；
- Evaluation 和人工反馈；
- 自托管能力。

初步决策：`Integrate`，作为可选观测后端，不成为本地核心状态存储。

### 7.3 Promptfoo 与其他 Evaluation 工具

值得借鉴：

- 评估用例与断言；
- 模型和 Prompt 对比；
- 安全与红队测试；
- CI/CD 集成。

初步决策：通过 Evaluation Adapter 接入。Control Plane 负责门禁语义和 Evidence，不重写所有评估执行器。

## 8. 开发者平台与插件

### 8.1 Backstage

值得借鉴：

- 小型核心与独立插件；
- Extension Point；
- 前端、后端和公共模型分离；
- 平台负责组装，不包办所有业务能力；
- 通过 Software Catalog 统一资源身份。

初步决策：`Reference`。

Control Plane 插件类型可以包括：

```text
Spec Adapter
Agent Adapter
Git Provider Adapter
Evaluation Adapter
Policy Adapter
Evidence Exporter
Observability Exporter
Notification Adapter
```

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

初步决策：v0.1 Evidence Schema 参考其结构，后续提供兼容导出。

### 9.2 Sigstore

值得借鉴：

- Artifact 和 Attestation 签名；
- 短期身份凭证；
- 可验证的签名和透明性机制。

初步决策：Evidence 签名在 Team Server 阶段引入，v0.1 先保证内容摘要和不可变引用。

### 9.3 SARIF、JUnit 和 Coverage

这些格式用于吸收现有工程工具结果：

- SARIF：静态分析和安全结果；
- JUnit XML：测试结果；
- Coverage：覆盖率；
- JSON Schema：项目领域对象校验。

初步决策：`Adopt`，不创建不必要的替代格式。

## 10. 协议边界

### 10.1 MCP

适合用于：

- Agent 访问工具；
- Agent 获取受控上下文；
- 将现有系统暴露为标准能力。

Control Plane 不应把所有内部领域 API 都改造成 MCP。MCP 位于 Agent/Tool 边界，核心状态和策略仍通过确定性服务管理。

### 10.2 A2A

适合未来多 Agent 协作、任务委托和跨运行时通信。

v0.1 不依赖 A2A，因为第一阶段只需要一个主执行 Agent 和若干确定性工具。保留未来 Adapter 位置即可。

## 11. 自研核心

以下能力构成项目差异化，应由项目维护自己的稳定模型：

### 11.1 Intent Graph

连接目标、约束、验收标准、工作任务和实际变更。

### 11.2 Context Supply Chain

管理上下文来源、版本、权限、时效、敏感性和实际消费记录。

### 11.3 Risk-adjusted Autonomy

根据任务、环境、Agent、证据和风险决定允许的自治等级。

### 11.4 Evaluation Contract

把确定性测试、场景评估、模型评估和人工判断统一映射为发布门禁。

### 11.5 Evidence Graph

连接执行事实、评估结果、策略决策、人工审批和发布对象。

### 11.6 Intent-to-Production Traceability

提供从生产变更反向追溯到 Intent 的稳定链路。

### 11.7 AI Native SDLC Metrics

衡量 Intent Lead Time、首次评估通过率、人工介入率、Agent 返工率、Evidence 完整率、缺陷逃逸率和单位可信交付成本。

## 12. 初步 Build/Reuse 决策

| 能力 | 决策 | v0.1 实现方式 |
|---|---|---|
| Intent Schema | Build | JSON Schema + Git 文件 |
| Specification | Integrate | 内置最小格式 + 外部导入 |
| Context Manifest | Build | 开放 Schema |
| Coding Agent | Integrate | CLI Adapter |
| Workspace | Adopt | Git worktree，可选 Docker |
| Workflow | Build minimal | SQLite 状态机 + 事件日志 |
| Policy | Build minimal | YAML + 稳定 Decision Contract |
| Evaluation | Integrate | 命令、JUnit、SARIF、JSON |
| Evidence | Build | 开放 Evidence Package Schema |
| GitHub | Integrate | GitHub CLI/API Adapter |
| Observability | Adopt | 结构化事件 + 可选 OTLP |
| Provenance | Reference/Adopt later | 内容摘要，后续 in-toto/SLSA |

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

## 14. 需进一步验证的选型

- v0.1 的首个 Coding Agent；
- Spec Kit 与 OpenSpec 哪个更适合作为首个规格 Adapter；
- Docker 是否默认启用；
- SQLite 与纯文件状态的边界；
- GitHub CLI 与 GitHub App/API 的第一阶段选择；
- 本地 Trace 的格式、压缩和脱敏；
- Evidence Package 与 in-toto Statement 的兼容路径；
- OPA Adapter 的引入时点；
- Team Server 是否采用 Temporal。

## 15. 研究依据

本文件应与仓库现有研究材料共同阅读：

- `AI-Native-SDLC-研究简报.md`
- `research/anthropic-ai-native-sdlc-brief.md`

后续对任何项目形成正式依赖前，应新增独立 ADR，记录版本、许可证、评估日期、采用理由、替换方案和退出策略。

