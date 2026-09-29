# AI Native SDLC 目标对齐评审：Failure Recovery & Idempotency

> 评审日期：2026-09-29  
> 评审类型：触发式  
> 触发原因：在真人试点前复查 Workflow 在重试、崩溃与重启下是否会产生重复执行或错误终态

## 1. 最终判定

- 判定：**健康，补强 Core 闭环可靠性，没有扩大产品范围**
- 一句话结论：本轮没有增加页面、Provider 或自治能力，而是保证 Intent 已批准后的 Run 只能被接纳一次、终结一次，并为 Evidence、Review、Merge 与 Release 提供稳定的上游执行事实。

## 2. 闭环位置

```text
Intent → Context → Workflow → Policy → Evaluation
                  ↑          ↓
             Idempotency   Evidence → Review → Merge → Release
                  ↓
              Event Log
```

这是 `Workflow` 的可靠性层，同时向 `Evidence` 和 `Event Log` 提供不重复、可解释的 Run 生命周期。它不替代 Evaluation，也不把“执行成功”误写成“需求已满足”。

## 3. 九项能力影响

| 能力 | 本轮影响 | 证据 | 仍有缺口 |
| --- | --- | --- | --- |
| Intent | 直接保护 | Intent 精确审批重试不重复写决策 | 真实需求质量仍需试点 |
| Context | 间接保护 | 重放返回原 Run，不重新生成另一份 Builder Context | Context 内容正确性仍由 Manifest 与消费记录证明 |
| Workflow | 直接强化 | Run 接纳 Key、原子取消、启动调和、终态幂等 | 外部副作用尚无 Durable Operation Journal |
| Policy | 间接保护 | 重放不绕过原 Run 的接纳策略 | Policy Decision 尚未统一摘要 |
| Evaluation | 间接保护 | 同一 Run 不会因客户端重试生成两套评估事实 | Evaluator 的独立性仍按现有契约判断 |
| Evidence | 直接保护 | 后续 Evidence 绑定唯一 Run 与唯一终态 | 外部成功、本地记录失败仍需调和 |
| Identity | 直接保护 | 幂等作用域绑定 Actor；终态事件保留执行/取消主体 | 企业身份仍依赖现有外部绑定 |
| Review | 直接保护 | 精确 Review 重试不替换记录、不扭曲决策耗时 | 真人 Reviewer 样本仍不足 |
| Event Log | 直接强化 | Worker 丢失、取消和终态以事务方式记录且不重复 | 外部锚定按当前决策为 P3 |

## 4. 关键规则

- Agent Run 的 `Idempotency-Key` 绑定 Actor、操作类型与请求 Digest。
- 相同 Key 与相同请求返回原 Run；相同 Key 与不同请求明确冲突。
- 排队取消在同一事务内记录请求与终态，避免重启后被误判为失败。
- 启动调和将已请求取消的孤儿 Run 归为 `cancelled`，其他孤儿 Run 归为 `failed`。
- Intent、Review、Merge、Release Candidate 与 Release Approval 只对完全相同的终态请求提供幂等重放。
- 首次创建使用 `201/202`，精确重放使用 `200`，调用方可以区分新事实与已有事实。

## 5. 范围与偏航检查

- 默认导航页面：无变化。
- Core / Lab 分界：无变化。
- Provider 数量：无变化。
- 新增领域对象：无，仅为 `agent_runs` 增加接纳 Key 与请求 Digest。
- 部署依赖：无变化，继续支持本地、私有和离线运行。
- 自治等级：无变化，仍为 AI 执行、人审批。
- 攻击者/管理员合谋：不是本轮目标；Event Chain Head 外部锚定降为 P3。
- 结论：本轮直接服务 AI Native SDLC Control Plane 的管理目标，没有转向通用任务队列或 DevOps 平台。

## 6. 验证结果

- `npm run typecheck`：通过。
- `npm run test:run-queue`：通过，覆盖取消重试、队列重复插入防护、重启恢复和 Run 接纳幂等。
- `npm run test:local-control-plane-http`：通过，覆盖终态决策与发布流程的 `201 → 200` 重试语义及冲突请求。
- `npm run test:local-agent`：通过，真实本地 Run 与 Revision 没有回归。
- `npm run test:core-integrity`：通过。

## 7. 下一步决策

### 优先

1. 进入 10-Change 真人试点，观察超时、重试、取消和服务重启是否按契约被团队理解。
2. 为“外部 Host Merge 已成功、本地 Merge Evidence 未落库”设计 Durable Operation Journal，避免外部副作用处于未知状态。
3. 按失败类型记录恢复时间、人工介入次数和重复操作避免次数，而不是增加新 Dashboard。

### 暂停

- 新导航、新 Provider、新 Dashboard。
- 自动重跑可能产生外部副作用的 Run。
- 低风险自动合并与自动发布。
- Event Chain Head 外部锚定；除非威胁模型或客户要求改变，否则维持 P3。

## 8. 试点观察指标

- Run 接纳重试中返回已有 Run 的比例；
- 取消请求到终态的耗时与失败率；
- Worker 丢失后的平均恢复确认时间；
- 因幂等保护避免的重复 Run、重复 Review 和重复发布决定数量；
- 外部操作成功但本地记录失败的次数；
- 恢复过程需要 Owner 手工修复的次数。
