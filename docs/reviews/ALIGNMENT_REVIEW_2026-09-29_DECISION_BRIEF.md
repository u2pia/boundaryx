# AI Native SDLC 目标对齐评审：Decision Brief

> 评审日期：2026-09-29  
> 评审类型：触发式  
> 触发原因：采用价值审查要求把 Evidence 原料收敛为 Reviewer 决策体验

## 1. 最终判定

- 判定：**健康，但采用价值尚未被证明**
- 一句话结论：本轮把 Intent、Context、Evaluation、Evidence、Identity 与 Review 压缩到同一个当前 Revision 决策入口；技术方向正确，但必须用真实审查时间与缺陷护栏验证价值。

## 2. 北极星检查

本轮直接强化：

```text
Intent → Context → Evaluation → Evidence → Identity → Review → Event Log
```

- Decision Brief 复用真实 Review Readiness，没有建立第二套 Gate。
- Evidence 展开记录继续进入 Reviewer-specific Evidence View，没有把“摘要已展示”冒充“证据已阅读”。
- Reviewer 权限、作者隔离和确定 Head SHA 绑定由服务端执行。
- 本地 Agent Run、外部 Run 引用和人工提案被显式区分，未知 Runtime 不再被伪装成已验证事实。
- Evidence 的 Status、Artifact Count、独立测试信号与 Criteria Coverage 只从 Digest 校验通过的包派生，请求不能自报升级。
- Gate 状态与当前查看者权限分离，Author、非 Assignee 和已结束 Proposal 不会被提示为可直接决定。
- `nextAction` 是确定性状态提示，不是 AI Approval Recommendation。
- 没有增加默认导航页、Provider、自动合并或自动发布。

## 3. 试点指标

- Decision Brief 首次打开到终态决定的耗时与样本数。
- Evidence 展开后批准率、请求修改率与打回轮次。
- 真实 Change 的逃逸缺陷、回滚和人工补救次数。
- Reviewer 为确认同一 Revision 在页面间切换的次数。
- Context / Skill 拒绝、未声明读取与来源不可观测的比例。

## 4. 九项能力变化

| 能力 | 本期成熟度 | 变化证据 | 最大缺口 |
| --- | ---: | --- | --- |
| Intent | 2.5 | Goal、Non-goal、Risk、Criteria 进入摘要 | 缺少 Intent 变更影响分析 |
| Context | 2.5 | 区分平台注入、Builder 上报、拒绝与未声明读取 | 外部 Run 无 Context 证明 |
| Workflow | 2.5 | Gate 给出当前确定性下一步 | 尚未形成 Inbox 主工作流 |
| Policy | 2 | Policy File 与 Override 进入现有门禁语义 | 缺少统一 Policy Decision 摘要 |
| Evaluation | 2.5 | Check 与 Criteria 状态进入当前 Head 摘要 | 尚缺 Reviewer 友好的关键失败解释 |
| Evidence | 3 | Evidence 元数据、Digest 引用、服务端摘要派生和 Reviewer View 联动 | 摘要仍不能替代内容校验 |
| Identity | 3 | Endpoint 按项目角色和 Session Actor 授权 | 尚缺企业身份联邦 |
| Review | 3 | Assignment、Evidence Open、Review Time 与决定聚合 | 真实采用数据不足 |
| Event Log | 3 | 所有摘要事实继续来源于原事件与领域表 | Decision Brief 本身尚无独立读取事件 |

## 5. 真实价值数据

- Active Review Time：现有字段已明确为 Assignment Cycle Elapsed Time，不再冒充 Active Time；真正 Active Time 尚无前后基线。
- Decision Latency：已记录每个 Reviewer 在当前 Head 首次打开 Decision Brief 的时间，并计算 Brief → Terminal Decision 中位数与样本数。
- Evidence Usefulness：已有 Evidence 展开后批准计数，样本量不足。
- 缺陷或返工护栏：已有 Changes Requested / Reworked / Accepted 计数，尚无 10 个真实 Change。
- 真实任务数量：不足以判断采用价值。
- 结论：本轮只能证明“可测量”，不能证明“已降低审查成本”。

## 6. 风险与偏航信号

- 若继续增加摘要字段而不跑真实试点，Decision Brief 会退化成另一张信息密集仪表盘。
- 若把 `ready` 翻译成“建议批准”，会破坏 Human-governed 原则。
- 若外部 Run 引用被展示为本地受管 Runtime，会产生错误信任。
- 若 Reviewer 不打开底层 Evidence，摘要可能成为新的表面审批入口。
- 上下文曾被错误归入 Lab，导致 Core 的 Intent → Context → Execution 治理链在导航层不完整；产品决策已将上下文恢复为 Core 顶层对象，并在同一工作面纳入 Skills Catalog，同时冻结 Lab 扩展。

## 7. 决策

### 保留并优先

- Decision Brief 作为 Review 的默认入口。
- Reviewer-specific Evidence View 与审查耗时。
- 明确的 Execution Source 和未知值表达。

### 暂停

- 新 Provider、新导航页与更多通用 Dashboard。
- 自动批准、自动合并与自动发布。

### 下一周期

1. 用真实仓库连续运行 10 个 Change，记录 Decision Brief 前后审查时间与返工。
2. 完成 Application Artifact → Release Candidate 的强绑定回归。
3. 继续强化 Core Context / Skills Management 合同：Context 覆盖 Package、来源、Revision、注入范围、访问拒绝、声明/实际读取与压缩边界；Skills 已区分目录声明、内容版本与 Run 实际加载事件，下一步补齐 Codex 可观测性和独立访问审计。
4. 建立 Brief → Decision、Evidence 打开率、Changes Requested、Accepted、缺陷与回滚护栏，不扩张新的治理对象。
