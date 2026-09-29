# Agent Run 故障恢复与幂等契约

本文定义 Control Plane 在正常运行故障下如何保持 Workflow 状态可信。目标不是处理数据库管理员与密钥持有者合谋攻击，而是处理客户端重试、响应丢失、Worker 异常退出、Control Plane 重启和超时等小团队日常故障。

## 1. 在 SDLC 闭环中的位置

```text
Intent → Context → Workflow → Policy → Evaluation
                  ↑          ↓
             Admission     Evidence → Review → Merge → Release
```

本契约保护 `Workflow` 到 `Evidence` 的交接：一个 Run 只能被接纳一次、终结一次，并且它的终态必须能解释后续 Change Proposal、Evidence 和 Review 所依据的执行事实。

## 2. Run 接纳幂等性

`POST /api/agent-runs` 与 `POST /api/change-proposals/:id/revise` 接受可选的 `Idempotency-Key` 请求头。

- Key 长度为 1–128，只允许字母、数字、点、下划线、冒号和连字符。
- Key 的作用域是当前 Actor；不同 Actor 可以使用相同 Key。
- Control Plane 将操作类型和规范化后的接纳请求计算为 `admissionRequestDigest`。
- 同一 Actor、同一 Key、同一 Digest 返回原 Run，HTTP 状态为 `200`，并返回 `idempotentReplay: true`。
- 同一 Actor、同一 Key、不同 Digest 返回 `409 idempotency_key_reused`。
- 首次异步接纳返回 `202`；无队列的测试路径返回 `201`。
- `requestKey` 与 `admissionRequestDigest` 写入 Run 和初始事件，但不写入交给 Builder 的请求文档。

客户端应为一次逻辑操作生成一个稳定 Key，并在网络超时或响应丢失后复用它；不要跨不同需求或不同修订复用。

## 3. 队列与取消

- 同一 Run 不会被重复加入内存队列。
- 只有 `queued` Run 可以进入队列；终态或已运行 Run 的重复入队被拒绝。
- 等待中的取消请求在一个数据库事务内同时记录取消请求和 `cancelled` 终态。
- 运行中的取消先持久化取消请求，再向 Worker 发送终止信号；Worker 的终结路径记录最终状态。
- 对已经取消的 Run 重试取消，返回原 Run，不追加第二个取消、终态或 Worktree 清理事件。

## 4. Worker 丢失与服务重启

启动时，队列调和所有仍为 `queued` 或 `running` 的 Run：

- 已持久化取消请求的 Run 终结为 `cancelled`；
- 其他孤儿 Run 终结为 `failed`；
- `agent_run.worker_lost` 与终态在同一事务中记录；
- 终结时清除陈旧的 `worker_pid`；
- 已终结 Run 的残留 Worktree 由清理调和器处理。

当前选择是保守失败而不是自动重跑。自动重跑可能重复执行外部副作用，必须等 Durable Operation Journal 能证明安全后再引入。

## 5. 终态与决策重试

- `completeAgentRun` 对完全一致的终态重试返回原 Run，不追加第二个终态事件。
- 同一 Intent 审批人以相同评论重试，返回原批准；不同决策返回冲突。
- 同一 Reviewer 对同一 Head、相同决定和评论重试，返回原 Review，不重算决策耗时或替换记录。
- 同一已合并 Proposal 重试合并，返回现有 Merge Evidence。
- 同一 Proposal 与 Commit 重试创建 Release Candidate，返回现有候选。
- 同一发布审批人以相同评论重试，返回原批准；不同审批人或不同评论返回 `409 release_already_approved`。

首次创建型请求返回 `201`，精确重试返回 `200`。

## 6. 可观测事实

Run 初始事件记录接纳 Key 与请求 Digest；取消、Worker 丢失和终态均进入 Event Log。运维人员可以区分：

- 客户端重放；
- 排队时取消；
- 运行时取消；
- 服务重启导致的 Worker 丢失；
- Worker 正常产生的成功或失败。

## 7. 已知限制

- 当前幂等 Key 只覆盖 Agent Run 接纳；其他普通写接口依靠领域级精确重试规则。
- 进程在外部代码托管平台完成合并后、写入本地 Merge Evidence 前崩溃，仍可能出现外部成功、本地未知。周期同步通常能恢复合并事实，但请求者归属可能退化为系统 Actor。
- 后续应为 Git Host Merge、发布和部署等外部副作用增加 Durable Operation Journal，再考虑自动恢复或自动重试。
- Event Chain Head 外部锚定属于管理员与密钥同时被控制的威胁模型，当前按产品决策列为 P3，不阻塞正常故障恢复。

## 8. 验证

- `npm run test:run-queue`：队列响应性、运行中取消、排队取消、取消重试、启动调和、终态幂等和接纳 Key。
- `npm run test:local-control-plane-http`：Intent、Review、Merge、Release Candidate 与 Release Approval 的首次/重试 HTTP 语义。
- `npm run test:local-agent`：真实本地 Agent Run 与 Revision 闭环回归。
- `npm run test:core-integrity`：恢复与重试没有破坏 Core 事实一致性。
