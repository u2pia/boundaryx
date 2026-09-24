# Local Release Candidate Contract

> 版本：`aperture.release-candidate.v1`  
> 日期：2026-09-23  
> 当前 Artifact Class：`source_snapshot`

## 目标

把 Merge 和 Release 明确分成两个独立的人类治理阶段：

```text
Merged Change Proposal
→ Verify Merge Evidence
→ Resolve Merged Commit
→ Compute Source Tree Digest
→ Create Release Candidate
→ Independent Release Approval
→ Approved Release Candidate
```

Release Candidate 不是 Deployment，也不是生产授权。当前阶段只证明“准备发布的源代码快照是什么”，不声称已经生成、签名或部署二进制制品。

## 创建门禁

- 只能由 Owner 或 Maintainer 创建。
- Change Proposal 必须处于 `merged`。
- Merge Evidence 必须通过 Digest 复验。
- Merge Evidence 的 Merged SHA 必须等于 Proposal Head SHA。
- Git Commit 必须仍可解析。
- 使用 `git ls-tree -r --full-tree` 生成稳定 Source Tree 投影并计算 SHA-256 Digest。

## Candidate 内容

- Change Proposal ID
- Merge Evidence ID 与 Digest Binding
- Repository Path 与 Source Ref
- Commit SHA
- Source Tree Digest
- Source File Count
- Candidate Content Digest
- Candidate Creator 与创建时间
- Status：`review_ready / approved / cancelled`

## 发布批准

- 创建者不能批准自己的 Release Candidate。
- 只有 Owner 或 Maintainer 可以批准。
- 批准前重新读取 Git Commit 并复验 Source Tree Digest。
- Approval 绑定 Candidate Content Digest。
- Release Approval 记录禁止更新和删除。
- `release_candidate.created` 与 `release_candidate.approved` 进入独立追加式 Event Log。

## 当前边界

- `source_snapshot` 不是构建产物；尚无 SBOM、Provenance、签名包或 Binary Digest。
- 尚未连接真实 Artifact Repository。
- Approved Release Candidate 不会自动部署。
- 发布页下方的 Deployment/Rollback 仍属于 Lab，不使用本地候选作为生产授权。
