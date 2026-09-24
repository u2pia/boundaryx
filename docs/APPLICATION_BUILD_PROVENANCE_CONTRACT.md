# Application Build Provenance Contract

> 版本：`aperture.application-build.v1`  
> 日期：2026-09-23  
> 范围：Application 的本地 Build Output Attestation

## 目标

把“测试通过的源码 Revision”与“由该 Revision 生成的构建输出”显式关联：

```text
Intent → Agent Run → Source Commit → Manifest Build Check
→ Declared Output → SHA-256 Attestation → Evidence → Human Review
```

## Manifest 契约

Application 可声明 `artifact.profile: application_build`、一个 `kind: build` 的 `buildCheck` 和至少一个仓库相对输出路径。`buildCheck` 必须引用同一 Manifest 中具名的 Build Check。

Agent System 不得声明 Application Artifact Profile，避免混淆 Agent Dataset Evaluation 与应用构建证明。

## Attestation

- Build Check 在已提交的 Proposal Head Worktree 上执行。
- 只有 Build Check 成功后才读取声明输出。
- 每个输出记录 Path、Size、SHA-256、Source Commit SHA 和 Build Check Name。
- 声明输出缺失或不是普通文件时，生成失败 Check 并阻断 Review Readiness。
- 声明输出允许保持为未提交文件；其他非声明修改仍触发 `workspace-clean` 失败。
- Artifact 与 Manifest Binding、Checks、Runtime Attestation 一起进入 Evidence Package 和 Event Log。

## 当前边界

- 当前 Evidence 只保存 Artifact Metadata 与 Digest，不保存 Artifact Blob。
- Build 在 `unisolated_process` 中运行，`productionEligible=false`。
- 尚无可复现构建、SBOM、签名、SLSA Provenance 或 Artifact Repository。
- Build Attestation 不等同于 Release Candidate、Deployment 或生产发布授权。
- 任何发布批准仍必须由独立人类 Actor 执行。

