# 对抗检查：Evidence 与 Provenance 链（2026-09-25）

对象：BoundaryX / Aperture Control Plane 的证据与溯源链。具体覆盖 `server/local-run-postprocessor.ts`、`server/criteria-coverage.ts`、`server/local-evidence-store.ts`、`server/git-worktree-agent-runner.ts`、`server/local-command-agent-runner.ts` / `server/container-agent-runner.ts` 的 attestation、`server/database.ts` 的 `recordCheck` / `recordEvidence` / `recordEvidenceView` / `getReviewReadiness` / `recordMergeEvidence` / 事件哈希链、以及 `server/http-server.ts` 的 checks / evidence / review / merge 处理器。

**范围声明：这不是平台级对抗检查。** 认证与会话、Review 分派状态机、GitHub 同步器（code-host）、Release Candidate 审批链、`.aperture/project.json` 的完整信任模型、前端 `src/` 的呈现层，均未逐条覆盖，只在与证据链相交处顺带提及。按任务约定，以下三项属**已知的并行工作项，不作为本报告发现**：`server/agent-runner-factory.ts` 启动期读取的 provider attestation、criteria 的人工签署（F2.2）、以及 `verifiedBy` 映射。

方法：只问「一个控制自己 worktree / stdout 协议 / 所写文件（含测试）的 Builder Agent、一个非 owner 成员、或一个持有 HTTP API 的人，能否伪造 / 篡改 / 重放 / 绕过证据，使一个变更以不反映真实的证据被 approved / merged」。每条关键结论都用 `/tmp` 下的一次性探测脚本反向验证，未改动任何代码、配置、数据库，未触碰 8787 端口与 `.aperture-live`。

先说结论：**测试来源（test provenance）这条线做得扎实**——`@baseline` 重跑 + `check_run_result_immutable` + 数字摘要，`test-provenance-smoke` 里那条「自己改测试让它变绿」确实被 `node-tests@baseline` 挡住了。但**评估（evaluation）这条平行线没有等价的防线**，而 Evidence Package 落库的 `summary` 是不受约束的自由字段却被审批门禁直接采信。这两点都用探测确认为真。

---

## 状态表

| 编号 | 严重度 | 一句话 | 是否探测确认 |
| --- | --- | --- | --- |
| F1 | 高 | evaluation check 无 `@baseline` 等价防线，Builder 控制的评分器随便打分即可让 critical model 标准以 `independent` 通过 | 是（`/tmp/probe-eval.ts`）· **已修复**：`evaluation.harnessPaths` + `eval@baseline`（评分器重置回 Base 重跑）；independent 需 Dataset 校验**且**评分器 `pre_existing`；同一指标冲突值使 Check 失败。`test:evaluation-provenance` 覆盖。原样拷贝 Dataset 由 `evaluation-dataset-leakage` 检出（≥12 字符）。**复查后降级**（见 `ADVERSARIAL_REVIEW_2026-09-25_EVALUATION_AND_CHAIN.md` E-H1）：被测代码可在运行时读取 Dataset，本地 Evaluation 不再算独立，关键 model 标准需 Owner 推翻 |
| F2 | 高 | `evidence_packages.summary`（含 `criteriaCoverage`）是自由 JSON，未与已校验的包内容绑定，却被 `getReviewReadiness` 直接采信 | 是（`/tmp/probe-summary.ts`）· **已修复**：HTTP evidence 路由要求包的 headSha / intent / run 与本 proposal 一致（`evidence_package_mismatch`），`criteriaCoverage` 只取自已校验的包，请求体里的一律丢弃；http-smoke 覆盖 |
| F3 | 中 | 事件哈希链（`previous_event_digest`/`event_digest`、`proposalEventChainHead`）除 smoke 外无任何运行时消费者，门禁从不校验链 | 是（grep 全仓）· **已修复**：合并前校验 Proposal 与其证据 Run 的事件链（`event_chain_broken`，在分支移动前拒绝；host merge 记为绕过门禁原因）；证据包记录的链头须仍在当前链上（防整链重算），Merge Evidence 读取时核对其链头（`merge_evidence_chain_mismatch`）。残余：同时持有数据库与证据文件者可一并重写；链头未外部锚定 |
| F4 | 中 | `@baseline` 只把 `testPaths` 重置回 base，测试依赖的 base 外文件仍停在 head，"独立"结论可被 Builder 从旁路架空 | 否（据代码推定）· **部分处理**：Evidence 的 `testProvenance.filesAtHeadDuringBaseline` 列出 baseline 时停在 Head 的文件，文档要求 `testPaths` 覆盖全部测试输入；未强制 |
| F5 | 低 | `productionEligible` / `isolation` 在审批 / 合并门禁无消费者；Builder 少报 `stopped` 可静默跳过部分变更告警 | 否（据代码推定）· **接受**：本地运行时永不 productionEligible，强制会阻断全部本地工作；待引入生产合并时再加门禁 |

---

## F1（高）evaluation 是自评的，没有 `@baseline` 那样的独立防线

**位置**
- `server/criteria-coverage.ts:38-39` — `datasetVerified` 只检查 `evaluation-dataset-integrity` 成功；`isIndependent` 里 `check.kind === 'evaluation' && datasetVerified` 即判为「独立」。
- `server/local-run-postprocessor.ts:79-80` — manifest 里的 test check 会额外做 `@baseline` 重跑，**evaluation check 只在 head 跑一次**，没有任何重置回 base 的对照。
- `server/local-run-postprocessor.ts:186,192` — 阈值判定读的是 `evaluationMetrics(stdout)`，即评分器进程 stdout 里的 `{"type":"evaluation_metrics",...}`。
- `server/local-run-postprocessor.ts:231-243` — `recordEvaluationDatasetIntegrity` 只证明「数据集文件未被改动」，不证明「评分诚实」。
- `server/project-manifest.ts:119` — 唯一的既有缓解是「数据集不得暴露进 Builder Context」，即假设 agent 没看过题目。

**攻击场景**：`agent_system` 项目的一条 critical `model` 验收标准由 evaluation check 覆盖。评分器（无论在仓库里还是 import 被测代码）都在 Builder 的 worktree 中运行、由 Builder 控制。Builder 只要让评分器无视数据集、直接打印 `task_success_rate: 1`，就能：数据集完整性 check 通过（文件确实没动）→ `criteriaCoverage` 因 `datasetVerified` 把该标准标为 `independent: true` → 状态判为 `passed`（而非 `self_graded`）→ readiness = ready。「数据集是隐藏且未改动的」这一前提**挡不住评分器说谎**，因为产出指标的代码本身归 Builder 所有。这正是 test 侧用 `@baseline` 消灭、却在 evaluation 侧原样存在的自评漏洞。

**确认方法**：`/tmp/probe-eval.ts`。medium 风险、一条 critical `model` 标准；`grade.mjs` 恒定打印 `task_success_rate: 1`；agent 只写一个 `garbage` 文件、从不碰数据集。结果：`run.status=succeeded`、`readiness.status=ready`、`criterion status=passed independent=true`、`dataset-integrity=success`、`blockers=[]`。

**建议**：
1. 给 evaluation 建立与测试对等的溯源。最小做法：把评分器 / 评估 harness 的路径也纳入一个「评估器路径」集合，若 head 相对 base 改动了这些文件，则该 evaluation 结论标为**非独立**（等同 `all_tests`），不能单独支撑 critical 标准；或提供 evaluation 的 `@baseline` 重跑（评估器重置回 base、被测产物留在 head）。
2. 在此之前，`criteria-coverage.ts:39` 不应仅凭 `datasetVerified` 就把 evaluation 判为 `independent`——「数据集未改」与「评分独立」是两回事，措辞与判定都需下调。

## F2（高）Evidence 的 `summary` 是自由 JSON，未与已校验的包绑定，却被审批门禁采信

**位置**
- `server/database.ts:1426-1429` — `getReviewReadiness` 取 `evidence.summary.criteriaCoverage` 作为 `packagedCoverage`，并以它（含每条的 `independent`）驱动 `criterionStatus`，进而决定 `self_graded` / `passed` 与 readiness。
- `server/database.ts:1040-1051` — `recordEvidence` 只校验 `proposal.headSha === input.headSha`，**不读包内容**，`summary` 原样落库。
- `server/local-evidence-store.ts:44-53` — `read(uri, digest)` 只验证「文件内部摘要自洽」，不验证该包属于本 proposal / headSha。
- `server/http-server.ts:526-527` — evidence POST 仅调 `store.read(uri, digest)` 验摘要，`body.summary` 未经任何校验直接入库。

**攻击场景**：一个非作者的 maintainer（在威胁模型内的「非 owner 成员 / HTTP API 使用者」）为一个 proposal 附证据时，可引用**任意一个曾生成过的合法包**的 `uri + sha256`（`read()` 只看文件自洽，不看它是否对应本变更），同时在 POST body 里手写一份 `summary.criteriaCoverage`，把所有 critical 标准标成 `checkNames` 指向已存在的成功 check、`independent: true`。门禁读 `summary` 而非包内容，于是标准翻为 `passed`、readiness 翻为 `ready`——**绕过了反自评 / criteria 门禁，且没有留下任何 override 决策的审计记录**（正常的豁免路径 `recordOverride` 会留事件）。reviewer 事后 `view` 的那个包甚至可以是另一个变更的包。

**确认方法**：`/tmp/probe-summary.ts`。一条 critical `model` 标准，起初 `readiness=blocked / criteria=[unmapped]`；maintainer 报一个成功外部 check，写一个内容与本变更无关的合法包，再用手写的 `summary.criteriaCoverage`（`independent:true`）落 evidence。结果：`readiness=ready`、`criterion status=passed independent=true`、`blockers=[]`。

**建议**：
1. `summary` 不应被信任为门禁输入。`getReviewReadiness` 消费 `criteriaCoverage` 时，应从 `store.read()` 得到的**已校验包**里取，而非从 DB 的 `summary_json`；或把 `criteriaCoverage`（及 `testProvenance` / `independentTestSignal`）纳入包摘要覆盖的范围并在消费点重算，DB `summary` 仅作展示缓存。
2. `recordEvidence` 应把 `store.read()` 出来的包内容与 proposal 绑定校验：包的 `git.headSha` 必须等于 `proposal.headSha`、`run.id` 必须是本 proposal 名下的 run，否则拒绝——杜绝「引用他处合法包」。
3. 对外部（无 run）证据路径，`criteriaCoverage` 的 `independent` 不应可由提交者声明；无 run 溯源时应回退到服务端 `mapCriteriaToChecks` 的保守判定（现在有 run 包时反而被 `summary` 覆盖）。

## F3（中）事件哈希链没有运行时消费者

**位置**
- `server/database.ts:1503-1516` — `verifyAggregateEventChain` 已实现，但全仓仅被 `scripts/*-smoke.ts` 调用，任何 HTTP 处理器、审批 / 合并门禁、证据消费路径都**不调用**它。
- `server/database.ts:856,889` — merge evidence 把 `proposalEventChainHead` 写入并纳入 `evidenceDigest`；但 `verifyMergeEvidence`（`server/database.ts:1570`）只重算 `evidenceDigest`，**从不重算事件链**去核对那个链头。
- `server/local-run-postprocessor.ts:123` — Evidence Package 里的 `provenance.runEventChainHead` / `proposalEventChainHead` 同理：记录了，消费点从不回验。

**评估**：`domain_events` 有 append-only 触发器（`001_initial.sql:151-160`）阻止 UPDATE / DELETE，`merge_evidence` / `release_approvals` 亦然，这是主要防线。因此「字段存在、无消费者」在纯 SQL 篡改面上被触发器兜底；但链本身的完整性在门禁时从不被验证——一条被 INSERT 进来、`previous_event_digest` 对不上的伪造事件、或一条链头与实际链不符的 merge evidence，运行时无人发现。属「不变量以字段形式存在但无强制消费者」（沿用上次教训：字段存在 ≠ 不变量被强制）。

**建议**：在合并 / 发布这类终局动作里，对相关 aggregate 调用一次 `verifyAggregateEventChain`，并把 evidence / merge evidence 里记录的链头与当场重算的链头比对，不符即拒绝；或提供一个 `/api/.../verify` 端点让审阅方能主动核对，而不是只在测试里跑。

## F4（中）`@baseline` 只重置 `testPaths`，测试依赖的旁路文件仍在 head

**位置**
- `server/local-run-postprocessor.ts:145-150,159-171` — `materializeTestPaths` 只把 `testPaths` 下的文件重置回 base；`executeBaselineTestChecks` 之外的一切（被测 `src/`、测试引用的共享 helper / fixture / conftest、若不在 `testPaths` 下的话）在 baseline 重跑时仍是 head 版本。

**攻击场景**：把被测代码留在 head 是设计意图（baseline 就是要用原始题目考 agent 的实现）。但如果项目的测试依赖 `testPaths` 之外的支撑文件（如 `test-helpers/`、共享断言库、数据 fixture），Builder 可以只改这些旁路文件，让「重置回 base 的题目」在 agent 的实现下也变绿——`@baseline` 结论仍显示 `pre_existing / 独立`，而它其实已被架空。防线的强度完全取决于 `testPaths` 是否覆盖了全部测试依赖，而 manifest 校验（`server/project-manifest.ts`）并不检查这种完整性。

**建议**：文档明确「`testPaths` 必须覆盖测试运行所需的全部输入（含 helper / fixture）」；更稳的做法是 baseline 重跑时对「非被测源码的测试支撑目录」也一并重置，或至少在 Evidence Package 里显式列出「baseline 运行时停留在 head 的文件集合」，让审阅方看得见这条边界。

## F5（低）`productionEligible` / `isolation` 无审批门禁消费者；`stopped` 可被 Builder 省略

**位置**
- `server/types.ts:392,421`、`server/local-run-postprocessor.ts:115` — `productionEligible` / `isolation` / `networkEgress` 记入 attestation、agent_run 行与 Evidence Package。
- 唯一的强制点是准入期的 manifest 门禁 `server/project-manifest.ts:191`（`unisolated_process` 需 `allowUnisolatedRuntime`）。审批（`recordReview`）与合并（`mergeChangeProposal` / `recordMergeEvidence`）**不读**这些字段——没有「高风险变更必须来自 production-eligible / 隔离运行时」这类门禁。
- `server/git-worktree-agent-runner.ts:96,217-218` — `stopped` 预算原因来自 agent 自报的 `message`。Builder 不报即视为未被截断，`recordReview` 的「部分变更需说明」门禁（`server/database.ts:1274` 一带）随之静默跳过。

**评估**：本地开发默认用非隔离进程运行时（`productionEligible:false`）是既定取舍，故列为低。但「运行时可信度」目前完全不进入终局门禁，值得在引入生产合并时补一条：非 low 风险或 production 合并要求 attestation 的 `productionEligible`。`stopped` 省略只是让审阅方少一个信号，check 门禁仍在，危害有限。

---

## 附：确认为「无问题 / 设计良好」的点

- **测试来源链**：`@baseline` 重跑（`local-run-postprocessor.ts:156-173`）+ `check_run_result_immutable`（`database.ts:1027` 一带，run 来源的 check 不可被 API 覆盖）+ stdout/stderr 摘要，配合 `test-provenance-smoke` 的三条断言，确实挡住了「改测试让它变绿」。
- **包摘要自校验**：`local-evidence-store.read`（`local-evidence-store.ts:44-53`）对包文件本身的 `packageDigest` 双向校验有效；HTTP evidence 路径对伪造 digest 返回 409（http-smoke 已覆盖）。问题只在 F2 的 DB `summary` 旁路，不在包文件本身。
- **合并门禁**：`mergeChangeProposal`（`local-git-authority.ts:101-151`）+ `recordMergeEvidence`（`database.ts:832-` 一带）双重复核 readiness、active approval、fast-forward、base/head 漂移，且发布先于记账，逻辑闭合。
- **context_consumed**：`independentlyObserved:false` / `reportSource:'agent_protocol'`（`git-worktree-agent-runner.ts:321`）诚实标注为「未独立观测」，仅作展示，不进门禁——是标注而非伪装，非发现。
- **作者自证禁令**：checks / evidence 的 `authorActorId === actor.id` 拦截（`http-server.ts:508,521`）以及 `self_review_forbidden` 有效。
