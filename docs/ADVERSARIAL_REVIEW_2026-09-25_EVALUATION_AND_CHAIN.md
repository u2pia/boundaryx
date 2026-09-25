# 对抗检查（复查）：Evaluation 独立性与事件链绑定（2026-09-25）

对象：上一轮 `ADVERSARIAL_REVIEW_2026-09-25_EVIDENCE_PROVENANCE.md` 修复后的两条线。

- **Evaluation**：`harnessPaths`、`eval@baseline`、`metricConflicts`、`evaluation-dataset-leakage`。
- **事件链**：`assertMergeEventChainsIntact`、`eventChainHeads`、`merge_evidence_chain_mismatch`。

方法沿用上一轮，只问一件事：Builder、非作者成员、或持有数据库文件的人，能否让不真实的证据走到 `passed`、`ready` 或 `merged`。

所有结论都用 `/tmp` 下的一次性探测脚本反向验证过：

- 事件链：`/tmp/chainprobe/probe.ts`
- Evaluation：`/tmp/evalprobe/p1`–`p7`

**范围声明**：这次只复查上述两条线，不是平台级检查。

先说结论。上一轮把 Evaluation 修成了「评分器取自 Base + Dataset 完好 + 无泄漏 ⇒ 独立」，这个结论本身不成立：被测代码与评分器在同一进程，可以在运行时读取 Dataset 作答（E-H1）。事件链上，门禁读取的是状态行，不是事件，只校验链自洽拦不住直接写行的伪造（C-H1）。这两条都已修复，修复方式与残余见下表。

---

## 状态表

### Evaluation

| 编号 | 严重度 | 一句话 | 状态 |
| --- | --- | --- | --- |
| E-H1 | 高 | 被测代码在运行时读取 worktree 里的 Dataset（`APERTURE_EVALUATION_DATASET` 或 `git show`）逐题作答。Diff 里没有拷贝，泄漏检测看不见，关键 model 标准以 `independent` 通过 | **已修复（降级）**：本地 Evaluation 永不算独立。通过的 Evaluation 使标准为 `self_graded`（界面「评测未隔离」），关键标准阻塞，需 Owner 带理由推翻。`evaluationProvenance.independent` 恒为 `false`，`graderFromBase` 记录评分器来源。Dataset 的三个守卫 Check 并入该标准的映射检查，任一失败则标准为 `failed`，推翻不能把它当作「自评」。`test:evaluation-provenance` 覆盖 peeking agent。**之后**：隔离评估器 `evaluation.holdout`（见下文「下一步」第 2 项）恢复了独立性，前提是 Holdout 在仓库外、被测代码在 Seatbelt 中、Builder 读不到 Holdout；仓库内 Dataset 维持降级 |
| E-H2 | 高 | 被测代码先写一个不带换行的字符，评分器那行被粘成不可解析的行后被跳过，只剩被测代码自己在 exit 时打印的满分，`metricConflicts` 形同虚设 | **已修复**：任何含 `evaluation_metrics` 却解析不出的行记为冲突 `(unreadable evaluation_metrics line)`，Check 失败 |
| E-H3 | 高 | Dataset 完整性只在 Check 之前校验一次。被测代码导入时把 Dataset 换成自己会答的题，exit 时换回，前后 Digest 一致 | **已修复**：新增 `evaluation-dataset-untouched`，在所有 Check（含 `@baseline`）之后比对 Dataset 的 Digest、inode、ctime。ctime 非 root 无法回拨，写过即失败 |
| E-H4 | 中→低 | Builder 留下守护进程，在 Control Plane 提交 Head 之后替换评分器，退出前再换回 | **隔离评估下已缓解**：评分器与被测代码从 Git 对象库取出到数据目录 `evaluations/`，隔离的 Builder（及其子进程）读写不到那里；未隔离 Builder 只得 `isolated_partial`。仓库内 Dataset 的 Check 仍是残余：全新 checkout 与杀进程组见下一步第 3 项 |
| E-M1 | 中→低 | 泄漏检测可被绕过：内容以 `++ ` 开头的新增行被当成文件头；`.gitignore` 或 `.git/info/exclude` 里的文件不进 Diff；还有拼接或编码后的答案 | **残余，接受**：仓库内 Dataset 下只影响 `failed` 与 `self_graded` 的区别。隔离评估下，隔离的 Builder 根本读不到 Holdout，无从拷贝；泄漏检测改为以 Holdout 内容为准，只作兜底。README 与契约已写明「只认原样拷贝」 |
| E-M2 | 低 | Dataset 值恰为常见短语时，诚实代码会误报泄漏 | **残余**：阈值 12 字符，只匹配 JSON 字符串叶子；误报时由 Owner 推翻 |
| E-L1 | 低 | 评分器依赖 `harnessPaths` 之外的 helper，或被忽略的同名文件遮蔽 | **残余**：契约要求 `harnessPaths` 覆盖评分器全部输入。E-H1 后同样不影响 `passed` |

### 事件链

| 编号 | 严重度 | 一句话 | 状态 |
| --- | --- | --- | --- |
| C-H1 | 高 | 门禁与合并读取状态行（`change_proposals`、`review_decisions`、`check_runs`、`evidence_packages`、`governance_decisions`），而这些表没有触发器。复制一个已批准的 Proposal 行、把它指向未审查的分支，再复制 Review、Check、Evidence 行，Proposal 没有任何事件，也能合并 | **已修复**：`assertMergeEventChainsIntact` 把合并依据的每一行绑定到链上的事件，详见下文。迁移 024 使这些表只能追加，唯一允许的更新是把 `invalidated_at` 从空置为非空；外部 Check 可原地更新，但其绑定取最新事件 |
| C-M1 | 中 | 重写整条链后，把 `evidence_packages.summary_json` 里的 `eventChainHeads` 删掉或改成 `genesis`，链头校验就被跳过 | **已修复**：`evidence.recorded` 事件记录 `summaryDigest`，合并校验时比对；链头取自事件 payload，不取自 `summary_json`；`summary_json` 另受触发器保护 |
| C-M2 | 中 | `host_protected` 模式下 GitHub 只看 `aperture/gate`，而 `gateFor` 不校验事件链：伪造的批准照样亮绿灯 | **已修复**：`gateFor` 在给出 `success` 前调用 `assertMergeEventChainsIntact`，失败则发布 `failure`（Audit trail altered）。`test:github-code-host` 覆盖 |
| C-L1 | 低 | 附加证据时不校验包里的链头是否属于本 Proposal 与 Run，错误要到合并时才暴露 | **已修复**：`recordEvidence` 在写入前拒绝不在链上的链头（`evidence_chain_mismatch`） |
| C-H2 | 高 | 事件 Digest 是无密钥 SHA-256：持有数据库文件的人可以按规则追加一串自洽的伪造事件，同时插入对应的状态行，上述绑定会全部通过 | **已修复（部分）**：迁移 025 `event_seals`，每个事件带 HMAC-SHA256（事件 ID + Digest）封印，密钥来自 `APERTURE_EVENT_SEAL_KEY` / `_KEY_FILE`，缺省时在数据目录生成 0600 的 `event-seal.key`。合并（`event_chain_broken`）、GitHub 门禁与 Merge Evidence 读取（`merge_evidence_chain_mismatch`）都校验封印。迁移时已有事件一次性补封（`backfilled = 1`），此后无封印即平台外写入。轮换用 `APERTURE_EVENT_SEAL_RETIRED_KEY_FILES`；密钥丢失时所有合并被拒，并点名缺失的 key id。**残余**：密钥缺省与数据库同目录，同 OS 用户的本地 Builder 可读；持有密钥者仍可重写，链头未外部锚定 |
| C-L2 | 低 | 链校验失败后没有隔离流程，只是拒绝合并 | 计划中 |
| C-L3 | 低 | 列表接口遇到单条损坏数据时整体失败，而不是逐行降级 | 计划中 |

---

## C-H1 的绑定规则

合并前（本地合并与 host 门禁都适用），对 Proposal 做以下检查：

1. Proposal 的链与每条产出证据的 Run 的链都能从 genesis 重算。
2. 首个事件是 `change_proposal.created`。
3. 最近一次 `created` 或 `revision_changed` 事件的 `headSha` 等于当前行。
4. 当前 Head 的每条有效批准都有匹配的 `review.approved` 事件（reviewId、headSha、actorId 一致）。
5. readiness 里的每个 Check 都有匹配的 `check.recorded` 事件（checkId、headSha、conclusion 一致）。外部 Check 可原地更新，因此取最新的那个事件。
6. 每个 Evidence 行都有匹配的 `evidence.recorded` 事件（sha256、uri、runId 一致；有 `summaryDigest` 时再比对摘要）。
7. 每个 override 都有对应的 `decision.override_recorded` 事件。

任一条不满足即报 `event_chain_broken`，且在目标分支移动之前拒绝。

`/tmp/chainprobe/probe.ts` 复验结果：

| 探测 | 攻击 | 结果 |
| --- | --- | --- |
| [A] | 纯 INSERT 伪造的 Proposal | 拒绝，报出缺失的创建事件与各行 |
| [B] | 重写链，并删除或改写 `summary_json` 链头 | 拒绝；删掉 evidence 触发器后仍被 `summaryDigest` 拒绝 |
| [C] | 按规则追加一个自洽的伪造事件 | 拒绝：该事件没有封印（C-H2） |

回归测试：`test:local-control-plane`，覆盖以下四种情形：

- 原地改 Review、Evidence 行，被触发器拒绝；
- 删 Check 行，被触发器拒绝；
- 去掉触发器后改 `summary_json`，合并被拒；
- 没有事件的批准行，合并被拒。
- C-H2：Digest 正确的伪造事件报 `has no seal`；随手编的封印报 `seal does not verify`；换密钥后报 `does not hold`，列入退役密钥后恢复；重写整条链后每个事件都报封印不符。

## 下一步（按优先级）

1. ~~C-H2 密钥封印~~（已做，见状态表）。剩余：链头外部锚定（例如定期把各链头签名后推到代码托管或独立存储），以及把默认密钥位置移出数据目录。
2. ~~**隔离评估器**~~（已做）：`evaluation.holdout` + `POST /api/projects/:id/evaluation-holdouts`，评分器取自 Base、被测代码取自 Head，二者分目录运行，被测代码在 Seatbelt 中（`server/seatbelt.ts`），Builder 隔离用容器或 `CONTROL_PLANE_BUILDER_SANDBOX=seatbelt`，回归 `test:isolated-evaluation`。残余：
   - 非 macOS 没有被测代码沙箱；
   - Codex 无法嵌套 Seatbelt；
   - 被测代码须在 Head 树内自足；
   - 题目经 stdin 暴露给被测代码，Holdout 需轮换；
   - Seatbelt 只是路径级拒绝。
3. 在全新 checkout 中运行 Check，并杀掉 Builder 的进程组（E-H4）。
4. C-L2 隔离流程、C-L3 列表逐行降级。
