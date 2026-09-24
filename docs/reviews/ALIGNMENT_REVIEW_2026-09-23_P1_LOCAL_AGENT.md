# AI Native SDLC 目标对齐评审

> 评审日期：2026-09-23  
> 评审类型：触发式——新增默认 Agent Run 能力与长期执行基础设施  
> 上次评审：[PLATFORM_DRIFT_REVIEW_2026-09-22.md](../PLATFORM_DRIFT_REVIEW_2026-09-22.md)  
> 下次评审：2026-10-06

## 1. 最终判定

- 判定：轻微偏移
- 本期总分：`76/100`
- 上期总分：未采用同一评分卡，不做伪精确比较
- 一句话结论：P1 首个真实执行纵切直接强化管理脊椎，但执行能力已经领先于真实审查价值数据，下一步必须转向 Container、可复验证据和审查时间采集，禁止继续扩张通用 Agent 编排能力。

## 2. 北极星检查

本周期仍在建设：

```text
Intent → Context → Workflow → Policy → Evaluation
→ Evidence → Identity → Review → Event Log
```

- 直接强化的核心能力：Intent 绑定 Work Item；Builder Agent 在独立 Git Worktree 执行；声明 Context 与自报告消费进入事件链；真实 Commit 自动形成 Change Proposal；Identity、Head SHA 与 Review 继续由服务端约束。
- 没有直接强化核心能力的工作：未新增导航、Provider Catalog、部署控制台或自治能力。
- Core 与 Lab 的范围变化：真实 Local Agent Run 进入 Core；Mock Orchestration、Attestation、Deployment、Telemetry 和 Autonomy 仍属于 Lab。

## 3. 评分卡

| 维度 | 权重 | 得分 | 证据 |
| --- | ---: | ---: | --- |
| 北极星一致性 | 20 | 19 | Run 必须绑定 Work Item、Intent Version、Actor 和真实 Git Revision |
| 九项脊椎完整性 | 20 | 16 | Intent、Context、Workflow、Identity、Review、Event Log 已进入服务端；Policy、Eval 仍弱 |
| 真实纵向闭环 | 20 | 13 | 外部进程、Worktree、Commit、Change Proposal 已真实执行；尚未完成真实 AI 任务与人工审查 |
| 审查带宽价值 | 15 | 4 | 没有 Active Review Time、Decision Latency 与 Evidence Usefulness 数据 |
| 人类责任治理 | 10 | 9 | 具名 Session、作者自批禁止、Review 绑定 Head SHA |
| 私有化与可替换性 | 10 | 10 | SQLite、本地 Git、外部命令协议，可替换 Codex / Ollama / 企业 Agent |
| 范围纪律 | 5 | 5 | 没有新页面和通用编排器，只增加一条纵向链路 |

## 4. 九项能力成熟度

成熟度：`0 不存在 / 1 模型或 UI / 2 本地原型 / 3 真实团队集成 / 4 生产级`

| 能力 | 上期 | 本期 | 变化证据 | 最大缺口 |
| --- | ---: | ---: | --- | --- |
| Intent | 2 | 2 | 新增 Application / Agent System 目标类型 | 尚无真实团队模板与变更流程 |
| Context | 1 | 2 | 声明 Context 注入、路径校验、摘要和未声明标记 | 消费仍是 Agent 自报告，非独立观察 |
| Workflow | 1 | 2 | 外部命令、Worktree、Branch、Commit、Proposal 形成真实链路 | 同步 HTTP、无恢复与取消 |
| Policy | 1 | 1 | 浏览器不能传 Shell，角色限制启动 | 无 Container、Egress、Tool Gateway 强制边界 |
| Evaluation | 1 | 1 | 明确 App / Agent System 分流原则 | 未运行真实测试、数据集与 Grader |
| Evidence | 2 | 2 | stdout / stderr 摘要、Context 摘要和 Git Diff 进入事件 | 尚无 Run Evidence Package |
| Identity | 2 | 2 | 服务端 Session Actor 启动 Run | 尚未接企业身份 Provider |
| Review | 2 | 2 | Agent 产出自动进入 Revision-bound Review | 尚无真实审查者价值数据 |
| Event Log | 2 | 2 | Agent Run 进入 SHA-256 追加事件链 | 尚无外部时间戳或不可变存储 |

## 5. 真实价值数据

- Active Review Time：未采集
- Decision Latency：未采集
- Review Cycle Count：未采集
- Evidence Usefulness：未采集
- 缺陷或返工护栏：自动测试尚未接入
- 真实任务数量：0；当前仅确定性外部进程与 Codex Adapter 契约测试
- 真实作者 / 审查者数量：0

## 6. 范围与偏航信号

- 默认导航页面数：14，未增加
- Provider 数量：未增加 Catalog Provider
- Mock 与真实集成比例：Core 增加 1 条真实本地执行链；大部分高级运行视图仍为 Mock / Lab
- `localStorage` 与服务端状态比例：Identity、Intent、Agent Run、Change Proposal、Review、Event Log 已服务端化
- 新增领域对象：`AgentRun`；Work Item 新增 `productType`
- 新增长期基础设施：本地外部命令 Runner 与 Git Worktree 目录
- 是否触发硬性红线：否；没有自动合并、作者自批、伪造 Evidence 或新增默认治理页面

## 7. 决策

### 保留并优先

- 一个 Builder Agent 的深度纵向集成；
- Application / Agent System 两类目标的 Evaluation 分流；
- Context 声明、消费差异和真实 Git Change Evidence。

### 暂停

- 第二个 Agent Adapter；
- Durable Workflow、跨机器调度和多 Agent 编排；
- 新 Provider、新默认导航和自动合并。

### 移入 Lab

- 复杂 Orchestrator–Workers 拓扑；
- Attestation、Telemetry、Deployment 和 Autonomy 控制台。

### 删除或合并

- 暂无；后续应把默认 Agent Runs 页面继续收缩为真实 Local Run，Mock 内容明确保持 Lab 分区。

## 8. 下一周期

最多三个优先事项：

1. 增加 Container Runtime、资源限制与 Egress Deny，替换 `unisolated_process`；
2. 增加 Tool Gateway 与独立观察的 Context Consumption；
3. 为 Application / Agent System 分别执行一组真实 Eval，并生成面向审查者的 Evidence Summary 与时间指标。

在以下条件满足前禁止开展：

- 第二个 Agent Provider、自动合并、发布编排和新治理页面；
- 将 Agent 自报告 Context 宣称为独立审计证据；
- 将当前 Runner 标记为生产级或允许其处理 Secrets。
