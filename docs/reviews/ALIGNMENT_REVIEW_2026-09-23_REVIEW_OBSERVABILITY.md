# AI Native SDLC 目标对齐评审：Review Observability

> 评审日期：2026-09-23  
> 评审类型：触发式  
> 触发原因：停止本地 VM 路线，转向其他 Control Plane 核心能力

## 1. 最终判定

- 判定：健康
- 本期总分：`92/100`
- 一句话结论：本轮没有扩展通用 Agent 编排，而是把真实 Change Proposal 的 Identity、Review、Revision、Metrics 与 Event Log 收紧为一条可验证闭环。

## 2. 北极星检查

本轮直接强化：

```text
Intent → Evidence → Identity → Review → Event Log
```

- Review 决策继续绑定可信 Session Actor 与确定 Head SHA。
- 同一 Reviewer 的新决策会显式失效旧决策，不覆盖历史。
- 多 Reviewer 冲突时 `changes_requested` 优先，避免单个批准绕过阻断意见。
- Revision 变化会失效当前 Review、Check 与 Evidence，并重新开始审查周期。
- 决策首响时间、积压年龄、有效/失效决策数来自 SQLite 真实数据，不来自 Mock。
- Reviewer 可直接看到当前 Head 的 Check 与 Evidence Package 就绪状态；失败 Check 由服务端阻止批准。
- Review Event 固化本次决策使用的 Check ID、Evidence ID、阻断原因与就绪状态。
- 已使用真实 Codex、真实 Git Worktree 和确定性测试完成首个 `Intent → Review` 案例，而非仅依赖 Smoke Fixture。

## 3. 九项能力变化

| 能力 | 上期 | 本期 | 变化证据 | 最大缺口 |
| --- | ---: | ---: | --- | --- |
| Intent | 2 | 2 | Review 继续绑定 Intent Version | 尚缺 Intent 变更影响分析 |
| Context | 2 | 2 | 无范围扩张 | 文件消费仍含自报告成分 |
| Workflow | 2 | 2 | Revision 刷新形成明确审查周期 | 尚缺持久任务调度 |
| Policy | 2 | 2 | 作者自批与角色约束由服务端执行 | 尚缺外部 Policy Bundle |
| Evaluation | 2 | 2 | 无范围扩张 | 真实 Trial 数据仍不足 |
| Evidence | 2 | 2.5 | 当前 Head 的 Check 与 Evidence Package 已进入真实 Review 详情 | 尚缺 Evidence 内容预览与签名验证入口 |
| Identity | 2 | 2.5 | Review 投影带 Reviewer 名称与角色 | 尚缺企业身份联邦 |
| Review | 2 | 3 | 首响时间、冲突优先级、改判失效；真实案例要求 Evidence View 后批准 | Reviewer 操作仍由案例脚本驱动，尚缺真实团队连续使用数据 |
| Event Log | 2 | 3 | 真实 Run、Check、Evidence View 与 Review 事件链完成摘要复验 | 尚缺外部不可篡改存储 |

## 4. 范围纪律

- 本地 VM / Podman Machine 路线暂停，不再下载或初始化 VM。
- OCI Runtime 代码仅保留为 Lab 参考，不进入默认产品路径。
- 当前 Process Runtime 必须保持 `degraded` 与 `productionEligible = false`。
- 本轮没有增加新导航页、第二 Agent Provider、自动合并或自动发布。

## 5. 下一周期建议

1. 将 Agent、Check 和 Context 配置收敛为每仓库受治理的 Project Manifest。
2. 让真实人类 Reviewer 完成下一次 Evidence 阅读、请求修改和再次批准，收集实际审查时间。
3. 增加 Merge Evidence，确认合并 Commit 与被批准 Head SHA 完全一致。

在获得真实团队任务数据前，禁止把更多 Mock Provider 移入默认产品区域。
