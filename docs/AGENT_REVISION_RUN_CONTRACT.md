# Agent Revision Run Contract

> 版本：`aperture.agent-revision.v1`  
> 日期：2026-09-23  
> 范围：`changes_requested` 后的受治理 Agent 修订

## 目标

把 Review 中的“请求修改”从静态状态变为可执行、可追溯的修订周期：

```text
Review changes_requested
→ Bind Reviewer Feedback
→ Start from Reviewed Head SHA
→ Agent Revision Run
→ New Commit / New Head SHA
→ Invalidate old Review / Check / Evidence
→ Re-run Checks
→ Generate new Evidence
→ Human Review again
```

## 启动门禁

- Change Proposal 必须处于 `changes_requested`。
- 必须存在当前 Head 的有效 `changes_requested` Review。
- Work Item、Intent、Repository 和 Base Ref 必须与原 Proposal 一致。
- Target Base SHA 不得在审查后漂移。
- 被审查 Head Branch 不得在 Revision Run 启动前漂移。
- Developer 只能修订自己创建的 Proposal；Owner/Maintainer 可以代为触发。

## 执行绑定

- Revision Run 的 `startSha` 是被审查的旧 Head SHA，而不是 Target Base SHA。
- 新分支使用 `agent/revision-<run-id>`。
- 原始基线的 `.aperture/project.json` 继续控制 Context、Check 和 Runtime Policy，避免待审变更自行放宽评估规则。
- 当前 Changes Requested 的 Review ID、Reviewer、Comment 和时间写入 Run Request。
- Feedback 集合生成 SHA-256 Digest，并记录 `agent_run.revision_feedback_bound`。
- Builder Prompt 明确列出必须处理的 Reviewer Feedback。

## 修订完成

- 新 Head 必须是旧 Head 的后代。
- Change Proposal ID 保持不变。
- Proposal 的 `runId`、`headRef`、`headSha` 更新到最新 Revision Run。
- 旧 Review、Check、Evidence 标记失效，而不是删除。
- 新 Check 与 Evidence 绑定新 Head SHA。
- Proposal 回到 `review_ready`，必须由人类重新查看 Evidence 并重新决策。

## 当前边界

- Revision Run 当前同步执行，尚未进入持久任务队列。
- Context Consumption 仍包含 Agent Protocol 自报告。
- 尚未采集真实人类 Active Review Time；Smoke Test 只证明治理协议，不冒充人工判断。
- 不允许 Revision Run 自动批准、自动合并或自动发布。
