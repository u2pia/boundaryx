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
- `evaluation.datasetPath`（仓库内 Dataset）与 `evaluation.holdout`（隔离评估，见下文）二选一。
- `datasetPath` 指向 Base Revision 中已提交的仓库相对路径，且至少一个 `kind: evaluation` 的 Check。
- 至少一个 Metric Threshold，支持 `gte` 与 `lte`。
- Dataset 不得出现在 Builder 的 `context.required` 或 `context.allowed` 中。
- 可选 `evaluation.harnessPaths`：评分器所在的仓库路径。未声明时，Run 可能改过评分器（见下文「评分器溯源」）。

Application 继续使用 `application_checks`，不会被错误要求提供 Agent Dataset。

## Dataset 隔离与完整性

- Dataset 从 `baseSha` 读取并计算 SHA-256 Digest。
- Dataset Path 与 Digest 写入 Run Request、Project Manifest Binding、Event Log 和 Evidence Package。
- Dataset 不进入 Builder Context，避免 Agent 直接读取 holdout 答案。
- Postprocessor 在 Worktree 中重新计算 Dataset Digest。
- Dataset 缺失或被 Agent 修改时，`evaluation-dataset-integrity` Check 失败，Review Readiness 为 `blocked`。
- Dataset（取自 `baseSha`）中长度 ≥ 12 的字符串值原样或 JSON 转义后出现在 Run 新增的行里（Dataset 文件除外）时，`evaluation-dataset-leakage` Check 失败。完整性与泄漏两个 Check 并入由 Evaluation 证明的标准的映射检查，任一失败则标准为 `failed`。输出只含命中值的 SHA-256 与所在文件。

当前隔离只实现“Context Contract + Digest 检测 + 原样拷贝检测”，改写或编码后的答案识别不出，Process Runtime 仍可直接访问 Worktree 文件，因此不能声称实现强安全隔离。

## 评分器溯源

Dataset 未被改动只说明题目没变，不说明评分诚实：评分器同样在 Worktree 里，Run 可以改它。`harnessPaths` 让评分器获得与 `testPaths` 对等的溯源：

- Run 未改动 `harnessPaths` → Evaluation Check 的 `provenance` 为 `pre_existing`，评分器取自 Base。
- Run 改动了 `harnessPaths` → Head 结论为 `all_tests`（不可信），Postprocessor 把这些路径重置回 `baseSha` 后再跑一次 `<name>@baseline`，被测代码保持 Head。
- 未声明 → `unverified`。

以上三种情况下 Evaluation 都**不是独立证据**（`evaluationProvenance.independent` 恒为 `false`，`graderFromBase` 记录评分器是否取自 Base）。评分器把被测代码导入同一进程，Dataset 在 Worktree 里，被测代码可以在运行时读取 Dataset 作答、或篡改评分器输出，这两种都不在 Diff 中留下拷贝。因此通过的 Evaluation 使标准为 `self_graded`，关键 `model` 标准阻塞批准，需要 Owner 审阅变更后带理由推翻。要取消这条限制，需要隔离评估器：被测代码在无法访问 Dataset 的沙箱中运行，并由外部上报结果。

Evidence Package 的 `evaluationProvenance` 记录声明的路径、Run 改动的评分器文件与结论。

## 隔离评估（`evaluation.holdout`）

仓库内的 Dataset 对 Builder 始终可读，所以上面的做法最多得到 `self_graded`。隔离评估把 Dataset 移出仓库：

```json
"evaluation": {
  "profile": "agent_dataset",
  "holdout": { "digest": "sha256:<64 hex>" },
  "harnessPaths": ["evals"],
  "grader": { "command": ["node", "evals/grade.mjs"], "timeoutMs": 60000 },
  "subject": { "command": ["node", "src/main.mjs"], "timeoutMs": 60000 },
  "thresholds": [{ "metric": "task_success_rate", "operator": "gte", "threshold": 0.9 }]
}
```

- **登记**：Owner 或 Maintainer 调 `POST /api/projects/:id/evaluation-holdouts`（JSON `{ "content": "<JSONL>" }`，上限 1 MB）。文件存到数据目录 `holdouts/<projectId>/<hex>.holdout`（目录 0700、文件 0600），事件 `project.evaluation_holdout_registered` 只记录 Digest、大小与行数。`GET` 同一路径只列出 Digest，内容永不返回。Manifest 按 Digest 引用，所以用哪一份 Holdout 仍由评审过的提交决定。
- **准入**：Holdout 未登记、或文件内容已不符合 Digest，Run 在建 Worktree 前被拒（`evaluation_holdout_missing`）。声明了 `holdout` 时不得再有 `kind: evaluation` 的 Check，必须声明 `harnessPaths`、`grader` 与 `subject`。
- **运行**（Builder 结束后、其他 Check 之前）：在数据目录的 `evaluations/` 下建临时目录，用 `git archive` 从对象库取出 Base 的 `harnessPaths` 到 `grader/`，Head 的整棵树到 `subject/`，二者都保持仓库内的相对路径。三个阶段依次执行：
  1. 评分器 `APERTURE_EVALUATION_PHASE=inputs`，`APERTURE_EVALUATION_DATASET` 指向 Holdout，stdout 输出题目；
  2. 被测代码在 `subject/` 下运行，stdin 为题目，stdout 为作答。macOS 上它运行在 Seatbelt 中：数据目录、仓库、Run 目录、评估临时目录与封印密钥均不可读写（只重新放开 `subject/` 与 `scratch/`，它们的上级目录只能列目录项），只能写 `scratch/`，没有网络，`HOME`/`TMPDIR` 指向 `scratch/`；
  3. 评分器 `APERTURE_EVALUATION_PHASE=score`，`APERTURE_EVALUATION_OUTPUTS` 指向作答文件，stdout 输出 `evaluation_metrics`。
  只解析第 3 步的 stdout；被测代码自己打印的指标只是它的「作答」。结果记为 Check `evaluation-isolated`（kind `evaluation`），临时目录随后删除。Evidence 只摘录评分器输出，被测代码的 stdout/stderr 只记 Digest，避免把题目扩散到证据包里。
- **守卫**：`evaluation-holdout-integrity`（Holdout 可读且 Digest 相符）与 `evaluation-dataset-leakage`（以 Holdout 内容为准）并入映射，任一失败即标准失败。
- **其他 Check**：声明了 Holdout 时，Manifest 里的 test/build Check 同样在 Seatbelt 中运行，读不到数据目录（Run 目录与仓库 Git 目录除外），否则 Head 代码可以把 Holdout 打印进证据包。
- **独立性**：只有同时满足以下三条，`evaluation-isolated` 的 provenance 才是 `isolated`，即独立证据，关键 `model` 标准无需推翻即可 `passed`：
  - 评分器取自 Base；
  - 被测代码运行在 Seatbelt 中；
  - Builder 读不到 Holdout，即 Runtime Attestation 的 `holdoutReadable: false`。满足它的是容器 Runtime（只挂载 Worktree），或设置 `CONTROL_PLANE_BUILDER_SANDBOX=seatbelt` 的进程 Runtime：数据目录与封印密钥被拒，只放开本 Run 目录与仓库 Git 目录。Attestation 的 `confinement` 记录拒绝的路径与 Profile Digest。
  缺任何一条，provenance 为 `isolated_partial`，标准为 `self_graded`，与仓库内 Dataset 相同。`evaluationProvenance` 记录 `mode: holdout`、`subjectConfinement`、`builderHoldoutReadable` 与 `independent`。

隔离评估的边界：

- 被测代码必须在 Head 树内自足：`subject/` 里没有 `node_modules` 或其他未提交的依赖。
- 非 macOS 上没有被测代码沙箱，结论只能是 `isolated_partial`。
- 自带沙箱的 Builder（Codex CLI）无法再套一层 Seatbelt（`sandbox_apply: Operation not permitted`），所以 Builder 隔离需要显式开启，Codex 场景要用容器 Runtime。
- 同一 OS 用户的未隔离 Builder 可以读 `holdouts/`，也可以留下守护进程篡改 `evaluations/` 下的评分器；这正是它只得 `isolated_partial` 的原因。
- Seatbelt 按路径拒绝，不是完整的系统调用边界：被测代码仍能读数据目录以外、同一用户可读的文件，只是写不出去、也没有网络。Holdout 的题目会作为 stdin 交给被测代码，多次运行后题目本身会被见过，Holdout 需要定期轮换。

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

- 仓库内 Dataset（`datasetPath`）的 Evaluation 不构成独立证据（见「评分器溯源」），它对 Builder 的隔离只是治理约束与篡改检测；文件系统级的隔离只有 `evaluation.holdout` 配合隔离的 Builder 才有（见「隔离评估」）。
- 尚未提供多 Trial、置信区间、污染检测或人类校准集。
- Process Runtime 保持 `degraded / unisolated_process / productionEligible=false`。
- Evaluation 通过不产生自动批准、自动合并或自动发布权限。

