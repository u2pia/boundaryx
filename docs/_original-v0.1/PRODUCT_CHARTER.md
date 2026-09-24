# AI Native SDLC Control Plane 产品章程

> 状态：Draft v0.1  
> 日期：2026-09-22  
> 目标版本：v0.1.0 研究原型

## 1. 产品摘要

AI Native SDLC Control Plane 是一个核心完全开源、本地优先、Agent 中立的研发控制层。第一阶段面向个人开发者，规范从需求意图到 GitHub Pull Request 的 AI 软件变更过程。

首个产品闭环：

```text
创建 Intent
→ 形成 Specification 和 Acceptance Criteria
→ 编译 Agent Context
→ 在隔离 Workspace 执行 Agent
→ 运行 Evaluation
→ 生成 Evidence Package
→ 人工审批
→ 创建 GitHub Pull Request
```

## 2. 产品目标

### G1：规范需求意图

让个人开发者能够用结构化方式描述目标、范围、约束、验收标准和风险，而不是直接把模糊 Prompt 交给 Agent。

### G2：提供可复现上下文

记录 Agent 实际使用的文件、规则、知识和版本，使一次执行可以解释和重放。

### G3：提供受控执行

通过 Workspace、命令、目录、网络、凭证、时间和费用预算约束 Agent 行为。

### G4：建立评估门禁

把编译、测试、安全、业务场景和策略检查组织为统一 Evaluation Contract。

### G5：形成完整证据

为每次运行生成可携带、可签名、可关联 Pull Request 的 Evidence Package。

### G6：渐进式自治

第一阶段坚持 AI 执行、人审批，后续仅对证据充分的低风险任务开放自动合并和自动发布。

## 3. 非目标

v0.1.0 不建设：

- 大型 Web 管理后台；
- 多租户企业平台；
- 通用多 Agent 编排器；
- 自研 Coding Agent；
- 自研向量数据库；
- Jira、GitLab 和 ServiceNow 集成；
- 自动生产发布；
- Agent Marketplace；
- 企业级组织与计费系统；
- 完整知识图谱。

## 4. 目标用户

### 4.1 首要 Persona

**AI 增强型个人开发者**

- 使用一个或多个 Coding Agent；
- 维护真实软件项目，而不仅是演示项目；
- 需要保留对代码、权限和合并决策的控制；
- 希望提升需求、上下文和验证质量；
- 可以接受 CLI 和 Git 工作流；
- 可能处于离线、私有仓库或本地模型环境。

### 4.2 核心 Job to Be Done

> 当我把一个真实开发任务交给 AI 时，我希望它在明确要求和受限权限下完成工作，并给出足够证据，让我可以快速、安全地决定是否接受这次变更。

### 4.3 后续 Persona

- 小型研发团队负责人；
- 平台工程师；
- 企业架构师；
- 研发效能负责人；
- AI 治理与安全负责人。

## 5. MVP 用户旅程

### 5.1 初始化

```bash
ainative init
```

生成：

```text
.ainative/
├── project.yaml
├── intents/
├── specifications/
├── policies/
├── evaluations/
├── agents/
└── evidence/
```

### 5.2 创建意图

```bash
ainative intent create
```

至少采集：

- Objective；
- Scope；
- Constraints；
- Acceptance Criteria；
- Risk Level；
- Owner；
- 可选 GitHub Issue。

### 5.3 形成规格和计划

```bash
ainative spec generate INT-0001
ainative plan INT-0001
```

规格和计划必须由人批准后才能进入执行阶段。

### 5.4 编译上下文

```bash
ainative context build INT-0001
```

输出可编辑的 Context Manifest，列出文件、规则、来源、原因、敏感性和估算规模。

### 5.5 执行 Agent

```bash
ainative run INT-0001 --agent default
```

系统创建独立 Git worktree 和可选容器，应用策略后调用外部 Coding Agent。

### 5.6 执行评估

```bash
ainative evaluate RUN-0001
```

至少支持：

- 命令退出状态；
- JUnit；
- SARIF；
- Coverage；
- 自定义 JSON Assertion；
- 验收标准映射。

### 5.7 审查证据

```bash
ainative evidence show RUN-0001
ainative approve RUN-0001
```

用户审查变更、评估、策略决策和残余风险，批准或拒绝。

### 5.8 创建 Pull Request

```bash
ainative pr create RUN-0001
```

PR 包含 Evidence Summary，并通过 GitHub Check 显示是否满足门禁。

## 6. MVP 功能范围

| 能力 | v0.1 范围 |
|---|---|
| Intent | 本地创建、校验、版本管理、关联 Issue |
| Specification | 支持外部 SDD 工具导入和本地规范格式 |
| Context | 显式文件、规则、Git 历史和相关代码清单 |
| Agent | CLI Adapter、Mock Adapter、一个参考集成 |
| Workspace | Git worktree，Docker 为可选增强 |
| Policy | YAML 目录、命令、网络、预算和审批规则 |
| Evaluation | 命令、JUnit、SARIF、Coverage、JSON |
| Evidence | 本地 Evidence Package 和摘要 |
| Approval | 具名本地审批记录 |
| GitHub | Issue 关联、PR 创建、Check 状态 |
| Observability | 结构化事件和可选 OpenTelemetry Exporter |

## 7. 非功能要求

### 7.1 Local First

核心流程不依赖外部 SaaS。联网能力必须可关闭。

### 7.2 Agent Neutral

核心状态机不包含特定 Agent 的专有字段。专有能力通过 Adapter 扩展。

### 7.3 Model Neutral

规格生成、评估和 Agent 执行允许使用不同模型，也允许完全不使用远程模型。

### 7.4 Deterministic Core

状态转换、策略门禁、证据打包、ID 生成和审批判断必须由确定性程序执行，不交给模型自行决定。

### 7.5 Private by Default

源代码、上下文和完整 Trace 默认留在本地。外发内容必须显式配置并可审计。

### 7.6 Recoverable

运行必须支持取消、失败恢复和保留 Workspace。不得因 CLI 退出而丢失关键状态。

### 7.7 Portable Evidence

Evidence Package 使用开放格式，不要求依赖本项目 UI 才能读取。

## 8. 成功标准

### 8.1 六个月产品成功标准

1. 外部用户可在 30 分钟内安装并初始化示例项目；
2. 至少支持一个真实 Coding Agent 和一个 Mock Agent；
3. 在真实 GitHub 仓库完成一次端到端 Issue-to-PR；
4. 未通过关键验收标准的变更无法进入批准状态；
5. 每次运行都能生成完整、机器可读的 Evidence Package；
6. Agent 不能修改策略明确禁止的目录；
7. 离线模式可以完成除 GitHub 同步外的全部核心流程；
8. 至少一名外部使用者可以在没有作者协助的情况下完成示例流程。

### 8.2 不采用的成功指标

- AI 生成代码比例；
- Prompt 数量；
- Agent 调用次数；
- 代码行数；
- 单纯的 GitHub Star 数量；
- 未说明质量前提的开发速度提升。

## 9. 六个月路线图

### 月 1：方法与领域模型

- 固化 Intent、Run、Policy、Evaluation 和 Evidence Schema；
- 完成威胁模型初稿；
- 建立架构决策记录；
- 完成开源项目复用评估。

### 月 2：最小纵向链路

- Intent 创建；
- 调用 Agent Command；
- 收集 Git Diff；
- 执行测试；
- 生成 Evidence Package。

### 月 3：上下文与隔离

- Context Manifest；
- Git worktree；
- Docker 可选沙箱；
- 命令、目录、时间和费用限制；
- Agent Adapter Contract。

### 月 4：评估与策略

- Evaluation Contract；
- JUnit、SARIF、Coverage；
- YAML Policy；
- 人工覆盖及理由记录；
- 门禁状态机。

### 月 5：GitHub 工作流

- GitHub Issue 导入；
- Pull Request 创建；
- GitHub Check；
- Evidence Summary；
- 人工批准。

### 月 6：开源发布

- 安装和升级体验；
- 示例项目；
- 架构、威胁模型和贡献文档；
- Adapter 开发指南；
- Demo；
- v0.1.0 发布。

## 10. 12-24 个月方向

### 6-12 个月

- Team Server；
- 共享策略和评估集；
- GitLab Adapter；
- Jira Adapter；
- 多 Agent Adapter；
- Evidence 签名；
- OpenTelemetry 语义扩展；
- 低风险自动合并试验。

### 12-24 个月

- 完全私有化团队平台；
- 企业身份和短期凭证；
- OPA 等外部策略引擎；
- Durable Workflow Runtime；
- 组织级 Intent/Evidence Graph；
- AI Native SDLC Metrics；
- 受限自动发布；
- 插件和 Adapter 生态。

## 11. 开源策略

建议方向：

- 核心、Schema、CLI、Adapter SDK 和治理能力全部开源；
- 优先评估 Apache-2.0；
- 采用公开 RFC 和 Architecture Decision Record；
- 发布公开 Roadmap 和兼容性承诺；
- 商标和兼容性认证独立于代码许可证管理；
- 不以隐藏核心治理能力的 Open Core 作为第一阶段策略。

许可证在发布首个代码版本前正式决定，并完成所有引入依赖的许可证审计。

## 12. 主要风险

| 风险 | 影响 | 缓解策略 |
|---|---|---|
| 范围过大 | 个人六个月无法交付 | 只做一个 Issue-to-PR 纵向闭环 |
| Agent 生态变化快 | Adapter 很快失效 | 保持运行时契约小而稳定 |
| 规格流程增加负担 | 用户绕开系统 | 支持轻量任务和渐进式字段 |
| Evidence 过于庞大 | 难以阅读和存储 | 摘要与原始证据分层保存 |
| 策略给出虚假安全感 | 风险被掩盖 | 明确策略覆盖范围并提供逃逸测试 |
| 过早依赖大型基础设施 | 安装复杂 | v0.1 使用 Git、文件和 SQLite |
| 模型评估不稳定 | 门禁结果不可复现 | 关键门禁优先使用确定性评估 |
| 开源项目重复建设 | 缺少差异化 | 坚持 Reuse/Integrate/Build 决策机制 |

## 13. 发布 v0.1.0 前必须决定

- 项目正式名称；
- 实现语言与打包方式；
- 代码许可证；
- 首个正式支持的 Coding Agent；
- Evidence Package v0 Schema；
- 是否默认启用 Docker；
- 本地敏感 Trace 的保留和脱敏策略。

