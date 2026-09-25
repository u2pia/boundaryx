# Agent System Evaluation Contract

> 版本：`aperture.agent-evaluation.v1`  
> 日期：2026-09-23  
> 范围：本地 Agent System 的版本化 Dataset、Metric Threshold 与 Evidence

## 目标

Agent System 不能只用进程退出码证明“足够好”。Control Plane 必须把评估对象、评估输入、指标、阈值和结论绑定到同一个基线与 Revision：

```text
Base Revision
→ Project Manifest
→ Holdout Dataset Digest
→ Agent Run / Change Proposal
→ Evaluation Command
→ Metrics + Threshold Results
→ Evidence Package
→ Human Review
```

## Manifest 契约

`productType: agent_system` 必须声明：

- `evaluation.profile` 为 `agent_dataset`。
- `evaluation.datasetPath` 指向 Base Revision 中已提交的仓库相对路径。
- 至少一个 Metric Threshold，支持 `gte` 与 `lte`。
- 至少一个 `kind: evaluation` 的 Check。
- Dataset 不得出现在 Builder 的 `context.required` 或 `context.allowed` 中。
- 可选 `evaluation.harnessPaths`：评分器所在的仓库路径。未声明时，没有任何 Evaluation 结论被视为独立证据（见下文「评分器溯源」）。

Application 继续使用 `application_checks`，不会被错误要求提供 Agent Dataset。

## Dataset 隔离与完整性

- Dataset 从 `baseSha` 读取并计算 SHA-256 Digest。
- Dataset Path 与 Digest 写入 Run Request、Project Manifest Binding、Event Log 和 Evidence Package。
- Dataset 不进入 Builder Context，避免 Agent 直接读取 holdout 答案。
- Postprocessor 在 Worktree 中重新计算 Dataset Digest。
- Dataset 缺失或被 Agent 修改时，`evaluation-dataset-integrity` Check 失败，Review Readiness 为 `blocked`。

当前隔离只实现“Context Contract + Digest 检测”，Process Runtime 仍可直接访问 Worktree 文件，因此不能声称实现强安全隔离。

## 评分器溯源

Dataset 未被改动只说明题目没变，不说明评分诚实：评分器同样在 Worktree 里，Run 可以改它。`harnessPaths` 让评分器获得与 `testPaths` 对等的溯源：

- Run 未改动 `harnessPaths` → Evaluation Check 的 `provenance` 为 `pre_existing`；与通过的 `evaluation-dataset-integrity` 一起，才构成独立证据。
- Run 改动了 `harnessPaths` → Head 结论为 `all_tests`（不独立），Postprocessor 把这些路径重置回 `baseSha` 后再跑一次 `<name>@baseline`，被测代码保持 Head。
- 未声明 → `unverified`，关键 `model` 标准为 `self_graded`，阻塞批准。

Evidence Package 的 `evaluationProvenance` 记录声明的路径、Run 改动的评分器文件与结论。

## Metric 协议

Evaluation Check 通过 stdout 输出单行 JSON：

```json
{
  "type": "evaluation_metrics",
  "metrics": {
    "task_success_rate": 0.95,
    "tool_call_accuracy": 0.98
  }
}
```

Control Plane 只接受有限数值。缺失指标、非有限数值、未达到阈值，或同一指标在 stdout 中出现两个不同的值（`metricConflicts`，被测代码与评分器共用 stdout，可以在评分器之后自己打印一个分数），都会使 Evaluation Check 失败。命令退出码为零不能覆盖阈值失败。

## Evidence 与 Review

Evidence Package 必须包含：

- Evaluation Profile、Dataset Path 与 Dataset Digest。
- Check Kind、stdout/stderr Digest 与有限摘要。
- 评估指标实际值。
- 每个阈值的 Operator、Threshold、Actual 与 Pass/Block 结果。

Evidence Drawer 必须让 Reviewer 直接看到 Dataset Binding、Metric 和 Threshold，不要求 Reviewer 从原始日志推断结论。

## 当前边界

- Evaluator 当前是本地命令，不是独立受隔离服务。评分器与被测代码同进程时，被测代码仍可篡改评分器的输出；应让评分器在子进程中调用被测代码。
- Dataset 对 Builder 的隔离是治理约束与篡改检测，不是文件系统级保密边界。
- 尚未提供多 Trial、置信区间、污染检测或人类校准集。
- Process Runtime 保持 `degraded / unisolated_process / productionEligible=false`。
- Evaluation 通过不产生自动批准、自动合并或自动发布权限。

