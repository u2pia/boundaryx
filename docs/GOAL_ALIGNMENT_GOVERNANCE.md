# AI Native SDLC 平台目标对齐治理

> 生效日期：2026-09-22  
> 状态：强制执行  
> 目的：定期确认平台仍在解决 AI 原生时代的 SDLC 管理问题，而没有偏移为通用 Coding Agent、项目管理工具、可观测平台或企业治理套件。

## 1. 不可变北极星

本项目的长期目标是：

> 建立 AI 原生时代的 SDLC 管理控制面，把人类意图、Agent 上下文、执行工作流、策略约束、评估结果、证据、身份责任、审查决定和事件历史连接成一条可管理、可验证、可追溯的变更链。

核心管理脊椎固定为：

```text
Intent
→ Context
→ Workflow
→ Policy
→ Evaluation
→ Evidence
→ Identity
→ Review
→ Event Log
```

这九项是平台的核心领域，不代表九个独立后台产品。它们必须共同服务一次软件变更的管理闭环。

## 2. 产品成功定义

平台成功不以页面、Provider、事件类型或 Schema 数量衡量，而以以下结果衡量：

1. 人能够表达业务目标、约束和验收标准，而不是逐行指定实现。
2. Agent 获得足够且受控的上下文，并能证明实际使用了什么。
3. Agent 执行处于可恢复、可限制、可观察的工作流中。
4. 高风险能力在真实执行边界被阻断或要求审批。
5. 每个关键验收标准都有可复验的 Evaluation 或明确的人类判断。
6. 审查者能够使用 Evidence 更快作出接受或退回决定。
7. 所有重要决定都绑定可信身份和确定代码版本。
8. 全过程可以通过 Event Log 追溯因果关系。
9. 平台适用于私有化、离线和模型可替换环境。

## 3. 明确非目标

以下方向即使技术上有价值，也不能成为默认产品主线：

- 自研通用 Coding Agent；
- 替代 Git、GitHub、GitLab、Jira 或现有 Issue Tracker；
- 通用项目管理、Roadmap、Sprint 或资源排期产品；
- 通用 CI/CD、GitOps 或 Deployment 平台；
- 通用 LLM Observability 或 Trace 产品；
- 通用 IAM、RBAC 或企业合规平台；
- 为了架构完整而持续增加 Provider、协议或标准；
- 没有真实用户指标支撑的自动合并和自动发布。

这些能力可以存在于 `Lab / Reference Architecture`，但不能挤占核心纵向链路的优先级。

## 4. 固定评审节奏

### 4.1 双周轻量评审

- 周期：每两周一次；
- 时长：30–45 分钟；
- 下一次：2026-10-06；
- 重点：最近两周新增功能是否强化九项管理脊椎，是否产生范围扩张。

每次必须回答：

1. 新增了什么？
2. 它解决了哪一个真实 SDLC 管理问题？
3. 它改善哪个指标？
4. 它属于 Core 还是 Lab？
5. 如果删除它，核心纵向链路是否受损？

### 4.2 月度深度评审

- 周期：每月一次；
- 时长：1–2 小时；
- 下一次：2026-10-22；
- 重点：重新评分、审查用户证据、调整路线图、暂停偏航能力。

### 4.3 触发式评审

出现以下任一情况，必须在实现前完成目标对齐评审：

- 增加默认导航页面；
- 增加新的 Provider Contract；
- 引入新的基础设施或长期运行服务；
- 增加自动合并、自动发布或生产写入能力；
- 增加与九项核心脊椎无直接关系的领域对象；
- 单项功能预计投入超过两周；
- Core 代码或默认 UI 范围增长超过 20%；
- 真实用户指标连续一个月没有改善。

## 5. 百分制评分卡

| 维度 | 权重 | 核心问题 |
| --- | ---: | --- |
| 北极星一致性 | 20 | 当前工作是否直接服务 AI Native SDLC 管理？ |
| 九项脊椎完整性 | 20 | Intent 到 Event Log 是否形成同一条变更链？ |
| 真实纵向闭环 | 20 | 是否使用真实 Git、Agent、Policy、Eval、Review，而不是静态样例？ |
| 审查带宽价值 | 15 | 是否降低 Active Review Time 或 Decision Latency？ |
| 人类责任治理 | 10 | 身份、禁自批、版本绑定和审批是否可信？ |
| 私有化与可替换性 | 10 | 是否支持本地部署、离线和 Provider 替换？ |
| 范围纪律 | 5 | 是否保持 Control Plane，而不是复制深层工具？ |

判定：

- `80–100`：方向健康，可以继续；
- `60–79`：出现偏移，下一迭代必须安排纠偏；
- `< 60`：停止新增功能，进入产品范围审查；
- 任一硬性红线触发：无论总分多少，都不得继续扩张默认产品。

## 6. 硬性红线

以下情况直接判定为偏航：

1. Intent、Review 或代码版本出现两个并列权威来源。
2. Review Decision 没有绑定确定的 Revision / Head SHA。
3. 作者可以批准自己的变更。
4. Policy 只显示 `deny`，却没有真正阻断执行。
5. Evidence 来自 Mock 或静态数据，却被呈现为真实证明。
6. 团队审批身份可以由浏览器任意切换或由请求参数声明。
7. Event Log 可以被普通业务操作修改或删除。
8. 新增 Provider 早于第一个真实纵向闭环。
9. 默认产品持续增加治理后台，而核心审查指标没有真实采集。
10. 平台开始承担通用 Agent、项目管理、CI/CD 或可观测产品职责。

## 7. 每项功能的准入信息

进入 Core Backlog 前，每项功能必须声明：

```yaml
north_star_dimension: Intent | Context | Workflow | Policy | Evaluation | Evidence | Identity | Review | EventLog
user_problem: string
hypothesis: string
target_metric: string
expected_change: string
authority_boundary: string
evidence_boundary: string
stage: core | lab
stop_condition: string
```

缺少任一字段的功能只能进入研究列表，不能直接实现。

## 8. Review 输出要求

每次评审必须形成一份文档，至少包含：

- 最终判定：健康、轻微偏移、明显偏移或严重偏航；
- 当前评分和上次评分；
- 九项核心能力成熟度；
- 最近周期新增能力及其价值证据；
- 真实集成与 Mock 比例；
- 保留、暂停、移入 Lab 和删除清单；
- 下一周期最多三个优先事项；
- 未满足前禁止开展的事项；
- 下次评审日期。

模板见 `docs/reviews/ALIGNMENT_REVIEW_TEMPLATE.md`。

## 9. 评审记录

| 日期 | 类型 | 判定 | 文档 |
| --- | --- | --- | --- |
| 2026-09-22 | 基线深度评审 | MVP 产品形态明显偏移，需收缩到真实纵向链路 | `PLATFORM_DRIFT_REVIEW_2026-09-22.md` |

后续评审必须追加到该表，不覆盖历史结论。

## 10. 开发流程约束

每次继续开发前：

```bash
cd control-plane/workbench
npm run review:alignment
```

该命令只收集客观范围证据，不能替代人工产品判断。双周和月度评审仍必须使用评分卡与真实用户数据。

