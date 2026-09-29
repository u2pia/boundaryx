# Local Release Candidate Contract

> 版本：`aperture.release-candidate.v1`  
> 日期：2026-09-29
> Artifact Class：`source_snapshot / source_with_build_attestation`

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

Release Candidate 不是 Deployment，也不是生产授权。它始终绑定合并后的 Source Tree；Application 还必须绑定 Merge Evidence 中由 Digest 校验包派生的 Build Artifact Evidence，但当前仍不声称已生成可部署、签名或进入 Artifact Repository 的生产制品。

## 创建门禁

- 只能由 Owner 或 Maintainer 创建。
- Change Proposal 必须处于 `merged`。
- Merge Evidence 必须通过 Digest 复验。
- Merge Evidence 的 Merged SHA 必须等于 Proposal Head SHA。
- Git Commit 必须仍可解析。
- 使用 `git ls-tree -r --full-tree` 生成稳定 Source Tree 投影并计算 SHA-256 Digest。
- `application` Work Item 必须至少有一个由 Merge Evidence 引用的 Evidence Package；其中 Manifest 声明的 Build Check 必须成功，每个 Artifact 必须有 SHA-256 Digest，并绑定产生它的 approved Head SHA。
- 当代码托管平台生成新的 merge/squash commit 时，Merged Commit Tree 必须与 approved Head Tree 一致，才能继承 `source_with_build_attestation`；Tree 不一致时拒绝创建候选。
- `agent_system` 可以保留 `source_snapshot`，因为其交付物可能就是受治理的源码与评估结果。

## Candidate 内容

- Change Proposal ID
- Merge Evidence ID 与 Digest Binding
- Repository Path 与 Source Ref
- Commit SHA
- Source Tree Digest
- Source File Count
- Artifact Class
- Artifact Evidence：Evidence ID、Package Digest、Build Check、Artifact Count、Artifact Digests 与 Source Commit SHA
- Artifact Binding Digest
- Candidate Content Digest
- Candidate Creator 与创建时间
- Status：`review_ready / approved / cancelled`

## 发布批准

- 创建者不能批准自己的 Release Candidate。
- 只有 Owner 或 Maintainer 可以批准。
- 批准前重新读取 Git Commit 并复验 Source Tree Digest。
- Application Candidate 的 Artifact Binding Digest 进入 Candidate Content Digest，批准绑定两者。
- Approval 绑定 Candidate Content Digest。
- Release Approval 记录禁止更新和删除。
- `release_candidate.created` 与 `release_candidate.approved` 进入独立追加式 Event Log。

## 当前边界

- `source_with_build_attestation` 只证明已校验 Evidence Package 中记录了构建输出及其 Digest；当前没有把二进制复制进 Release Candidate。
- `source_snapshot` 不是构建产物；两种 Artifact Class 都尚无 SBOM、签名包、Binary Repository Receipt 或部署证明。
- 尚未连接真实 Artifact Repository。
- Approved Release Candidate 不会自动部署。
- 发布页下方的 Deployment/Rollback 仍属于 Lab，不使用本地候选作为生产授权。
