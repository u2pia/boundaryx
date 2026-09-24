# Local Merge Evidence Contract

> 版本：`aperture.merge-evidence.v1`  
> 日期：2026-09-23  
> 范围：本地 Git Authority；显式人工触发；不包含自动合并或自动发布

## 目标

Merge Evidence 用来证明：实际进入目标分支的 Revision 与人类批准的 Head SHA 完全一致，并且该 Revision 的 Check、Evidence Package 和 Review Decision 在合并时仍然有效。

```text
Approved Change Proposal
→ Revalidate Base / Head / Checks / Evidence / Approval
→ Fast-forward Target Branch
→ Verify Target SHA == Approved Head SHA
→ Append Merge Evidence
→ Append change_proposal.merged Event
```

## 合并门禁

- 只能由 `owner` 或 `maintainer` 显式触发。
- Proposal 必须处于 `approved`。
- Head Branch 当前 SHA 必须等于 Approved Head SHA。
- Target Branch 当前 SHA 必须等于 Review 时的 Base SHA；发生漂移必须重新 Refresh、Evaluation 和 Review。
- Approved Head 必须是 Target Base 的 fast-forward 后代。
- 当前 Head 的 Checks 和 Evidence 必须保持 `ready`。
- 必须存在当前 Head 的有效 Approval。
- Target Branch Worktree 如果已检出，必须保持干净。

## 执行语义

- 已检出的目标分支使用 `git merge --ff-only`，确保工作区文件与 HEAD 同步。
- 未检出的目标分支使用带旧 SHA 条件的原子 `git update-ref`。
- 合并后再次解析目标分支；结果必须精确等于 Approved Head SHA。
- Evidence 写入失败时尝试把目标分支补偿回原 Base SHA。
- 重复请求是幂等的：已合并且目标分支未漂移时返回现有 Merge Evidence。

## Evidence 内容

- Change Proposal ID
- Base Ref 与合并前 Base SHA
- Approved Head SHA
- 实际 Merged SHA
- Strategy
- Approval Review IDs
- Check IDs
- Evidence Package IDs
- 合并前 Proposal Event Chain Head
- Merged Actor 与时间
- Merge Evidence SHA-256 Digest

Merge Evidence 表具有禁止更新和删除的 SQLite Trigger；读取时重新计算 Digest。最终合并事件继续进入 Change Proposal 的追加式摘要链。

## 当前边界

- 仅支持本地分支的 fast-forward，不创建额外 Merge Commit。
- 不处理远程 Push、GitHub/GitLab PR 合并或受保护分支 API。
- 不代表发布授权；Release、Artifact 与 Deployment Evidence 仍是后续独立阶段。
- Process Runtime 仍然是非生产隔离，Merge Evidence 不能改变 Runtime 的生产资格。
