# BoundaryX 邦界 · AI Native SDLC Control Plane

本目录保存 AI Native SDLC Control Plane 的产品、架构设计基线与交互式工作台原型。

截至 2026-09-23，当前阶段是**产品定义 + 高保真交互原型 + 本地 Control Plane P1**。已实现 SQLite 服务、Local Authority、服务端 Session Identity、真实本地 Git Revision、Change Proposal Review、追加式领域事件，以及“Builder Agent → Git Worktree → Commit → Change Proposal”的链路。Container Runtime 已具备网络拒绝、只读根文件系统、能力删除、资源限制、镜像证明和显式降级策略；Tool Gateway、Credential Broker 和 GitHub App 尚未实现。

> **版本说明**
> 基线 v0.1 由另一模型撰写，原文完整保留在 [docs/_original-v0.1/](docs/_original-v0.1/)。
> 当前 v0.2 由 **Claude（Opus 5）** 依据 2026-09-22 的评审意见，按「小团队 · 全周期」定位改写。
> 文中所有改动以 `〔C·改〕`、`〔C·新〕`、`〔C·删〕` 标记，逐条理由见 [REVIEW-CHANGES.md](REVIEW-CHANGES.md)。

## 〔C·改〕核心定位

**面向 3–8 人研发团队的 AI Native SDLC 全周期管理平台。**

平台同时支持两类研发目标：普通或 AI 增强的 **Application**，以及以模型、工具、上下文和评估闭环为核心的 **Agent System**。执行研发任务的 Builder Agent 与被开发的 Agent System 是两个独立概念，不能混为同一领域对象。

它不是新的 Coding Agent，也不替代 GitHub、CI/CD、Issue Tracker 或现有研发平台。它是一次变更的**脊椎**：把意图、上下文、执行、评估、审批、发布和反馈串成一条不断的追溯链。

```text
Intent → Context Engineering → Agent / Workflow Execution
       → Tests + Docs → Evaluation → Evidence → Human Review
       → Ship → Observe → Learn / Remediate ↺
```

**「全周期」指的是这条追溯链覆盖全周期，不是每个阶段的功能都自己做。** 每个阶段的深度能力（需求跟踪、编码、测试、CI、发布、监控）一律通过集成获得。平台拥有脊椎，不拥有器官。

## 〔C·新〕一句话价值

> 让一个人能在 8 分钟内，安全地接受另一个人的 Agent 产出的变更。

小团队的真实瓶颈不是治理和合规，是**审查带宽**：编码快了十几倍，审查和上线还按人的速度运行。因此本项目的唯一核心尺子是——

```text
每个被接受的变更所消耗的审查人时
```

任何不能降低这个数的功能，都不进入第一阶段。

## 〔C·新〕适用边界

第一阶段只服务符合以下全部条件的团队：

| 参数 | 约束 |
| --- | --- |
| 团队规模 | 3–8 人，其中 1 名推动者 |
| 平台工程 | 无专职平台工程师 |
| 仓库 | 1 个主仓库（多仓库 Intent 不在第一阶段） |
| 合规 | 无强制审计与合规要求 |
| 现有工具 | 已在用 GitHub + 某个 CI + 某个 Issue Tracker |

不满足这些条件的团队（尤其是有合规审计要求的组织）需要的是另一个产品。

## 〔C·新〕采用路径：个人可安装，团队才生效

```text
1 单人安装，不打扰任何人
  → 他的 PR 上开始出现可审证据

2 其他人发现审这种 PR 更快
  → 价值由审查者体感到，无需说服

3 团队开启共享服务与门禁
  → 评估集、策略、指标成为团队资产
```

这条路径构成一条硬性设计约束：**v1 必须在只有一个人使用时就产生可见价值**，否则团队级采用永远无法启动。

## 〔C·改〕当前共识

1. 最终建设为核心完全开源的项目。
2. 目标用户是小团队；个人是**安装单位**，不是独立的产品阶段（见上节采用路径）。
3. 第一阶段聚焦通用软件研发。
4. 默认支持自托管、私有化、离线环境和模型可替换。
5. 第一阶段采用**按风险分级的人工审批**，而不是全量人审——全量人审在团队场景下必然退化为橡皮章。
6. P0 暂不依赖 GitHub：使用 SQLite + 本地 Git + Local Authority 跑通控制语义；后续通过 Provider Contract 替换为 GitHub/GitLab，而不改领域模型。
7. 六个月内只交付一条端到端纵向链路（Intent → Context → Agent → Evaluation → Evidence → Review → Change），全周期的后半段在核心链路稳定后闭合最小形态。
8. P0 的 Intent 由本地服务管理；接入 Issue Tracker 后，它应成为外部需求的结构化投影和控制附件，避免形成冲突的双重权威来源。
9. SQLite 单实例服务用于验证 3–8 人团队协作语义，不被视为最终多人部署架构；身份、权限、Review 和 Event Log 必须从第一阶段就由服务端强制。
10. 长期目标是形成可被引用的方法论与开放领域模型；标准化是 traction 的产物，不是第一阶段的目标。

## 〔C·改〕设计原则

```text
Review Bandwidth before Governance     审查成本优先于治理形式
Evidence before Trust                  证据优先于声明
Attach before Replace                  附着于既有系统，不替代它
Enforce at the Boundary                策略在可强制的边界上执行
Graduated Autonomy over Blanket Review 分级自治优于全量人审
Deterministic Core                     门禁与状态由确定性程序判定
Repository before Platform             仓库优先于平台
Self-hosted before SaaS                自托管优先于云服务
Protocol before Vendor                 协议优先于厂商
Human Accountability by Default        责任默认归属具名的人
```

## 文档索引

- [GOAL_ALIGNMENT_GOVERNANCE.md](docs/GOAL_ALIGNMENT_GOVERNANCE.md)：固定北极星、双周/月度评审节奏、评分卡、偏航红线与功能准入要求。
- [LOCAL_AGENT_PROTOCOL.md](docs/LOCAL_AGENT_PROTOCOL.md)：P1 外部命令 Builder Agent、Git Worktree、Context 自报告协议、App / Agent System 评估分流与安全限制。
- [ALIGNMENT_REVIEW_2026-09-23_P1_LOCAL_AGENT.md](docs/reviews/ALIGNMENT_REVIEW_2026-09-23_P1_LOCAL_AGENT.md)：新增真实 Agent Run 后的触发式偏航评审、评分卡与下一周期禁区。
- [PLATFORM_DRIFT_REVIEW_2026-09-22.md](docs/PLATFORM_DRIFT_REVIEW_2026-09-22.md)：对当前平台是否偏离最初产品假设的独立审查，并给出类似产品借鉴边界与四周纠偏计划。
- [CONTROL_PLANE_DESIGN_V0.3.md](docs/CONTROL_PLANE_DESIGN_V0.3.md)：融合两轮评审后的总体设计基线，后续 ADR 与原型以此为准。
- [CONTROL_PLANE_DESIGN_V0.4_DELTA.md](docs/CONTROL_PLANE_DESIGN_V0.4_DELTA.md)：基于 Anthropic Agentic SDLC 实践形成的增量设计，覆盖 Evaluation、Context Engineering、三层隔离和反馈闭环。
- [ANTHROPIC_ALIGNMENT_REVIEW_2026-09.md](docs/ANTHROPIC_ALIGNMENT_REVIEW_2026-09.md)：与 Anthropic 官方方法的逐项对齐审查和差距矩阵。
- [VISION.md](docs/VISION.md)：长期愿景、产品原则与两年目标。
- [PRODUCT_CHARTER.md](docs/PRODUCT_CHARTER.md)：目标用户、MVP、成功标准与路线图。
- [DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md)：核心对象、关系、不变量、状态机与事件模型。
- [OPEN_SOURCE_LANDSCAPE.md](docs/OPEN_SOURCE_LANDSCAPE.md)：开源复用策略、候选项目与 Build/Reuse 决策。
- 〔C·新〕[REVIEW-CHANGES.md](REVIEW-CHANGES.md)：v0.1 → v0.2 的逐条改动、关闭的评审问题与待决事项。
- 〔C·新〕[REVIEW-NOTES.md](REVIEW-NOTES.md)：评审意见全文与论证过程，每条附「反驳这条需要什么」，供交叉验证。
- 〔C·新〕[docs/_original-v0.1/](docs/_original-v0.1/)：v0.1 原稿留档，用于比对。

## 工作台原型

```bash
cd workbench
npm install
npm run build
npm run server:start
# 打开 http://127.0.0.1:8787
```

首次访问需创建本地 Owner，系统不提供默认密码。SQLite 数据库位于 `workbench/.aperture/control-plane.db`。

当前 P0 已将 Identity、Intent、Change Proposal Review 和 Event Log 接入本地服务；Context、Agent 编排、Evaluation、Evidence、Release、反馈闭环和多数度量页面仍包含 Lab / Mock 数据，并保留可执行 Mock Agent Adapter 用于方法验证。

## 目标对齐检查

继续开发前运行：

```bash
cd workbench
npm run review:alignment
```

项目每两周进行一次轻量目标对齐评审，每月进行一次深度评审；新增默认页面、Provider、基础设施或自治能力时必须触发专项评审。
