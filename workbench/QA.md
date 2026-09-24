# Workbench QA Checklist

## Build

```bash
npm install
npm run check
npm run dev
```

`npm run check` 依次执行 TypeScript 检查、领域 Store 状态机测试、Agent Adapter 事件流测试和生产构建。

## Navigation

- `/\#/overview`：总览与八阶段变更流。
- `/\#/intents`：Intent 搜索与详情抽屉。
- `/\#/context`：Manifest、实际读取、动态 Context Engineering。
- `/\#/runs`：Execution Strategy、Run 列表与 Transcript。
- `/\#/reviews`：风险优先审查队列。
- `/\#/releases`：Release Gate、生产授权、环境推进、回滚。
- `/\#/evaluations`：Suite、Task、Trial、Grader、Transcript、Regression。
- `/\#/evidence`：证据健康与验收标准映射。
- `/\#/traceability`：Intent-to-Production 追溯链、事件账本和 Provenance。
- `/\#/policies`：三层 Containment 和 Blast Radius。
- `/\#/feedback`：Production Signal、Remediation 和学习回流。
- `/\#/integrations`：GitHub、Agent、CI、通知、模型与离线部署。
- `/\#/team`：成员、审查负载和角色权限矩阵。
- `/\#/metrics`：审查、可靠性、上下文、审批和反馈指标。

## Keyboard

- `⌘ K` / `Ctrl K` 打开命令菜单。
- 命令菜单支持输入筛选、`↑` / `↓` 选择、`Enter` 跳转。
- `Esc` 关闭命令菜单、通知和详情抽屉。

## Interaction

- 点击 Intent 行打开 Intent 详情。
- Intent 页点击“套用模版”应按当前产品类型填充目标、约束与验收标准；已有内容时先二次确认再覆盖；切换产品类型后套用的是另一份内容。
- Intent 页中、高风险 Intent 应显示 `draft` 与「批准 Intent」；起草人按钮禁用并说明原因，Reviewer 批准后变为 `approved`；Agent Run 表单在 Intent 为 draft / superseded 时禁用启动并说明原因。
- 本地审查队列中改动 `.aperture/` 的提案应显示琥珀色「改动策略文件」横幅并列出文件；Reviewer 的批准按钮禁用，Owner 需先写审查意见才能批准。
- 本地审查队列每个提案都有审查人行：Owner / Maintainer 可指定或按负载分配，重新分配要求先写意见作为理由；Reviewer 只能认领未分配的提案；分配给他人时，自己的批准 / 请求修改按钮禁用并提示被分配人；逾期显示琥珀色「逾期」。
- 解析预览应逐条显示「关键|参考 · 确定性|模型|人工」与语句；把一条标准改成“界面优化一下”应出现模糊度提示但仍可提交；风险等级改为高风险并删掉 `[人工]` 那条后，提交按钮必须禁用并说明原因。
- 点击 Agent Run 打开 Plan、Transcript 和 Evidence。
- 在 Agent Runs 点击“启动 Mock Run”，确认顶部实时条从启动推进到完成，期间不可重复启动。
- 打开该 Run，确认 Plan 步骤、上下文读取、工具调用、策略拒绝、Tests + Docs 产物和 Evaluation 均来自实时事件。
- Transcript 应包含 `run_started` 到 `run_completed` 的有序事件，并可导出与事件数一致的 JSONL 文件。
- Evidence 应显示 Patch、Test、Documentation 三类签名产物，以及一次阻断未授权 Secrets 读取的策略决策。
- Managed Agent Runtime 应显示 Model、Harness、Sandbox 与 Session；启动 Mock Run 后四项引用切换为该 Run 的实时绑定。
- Runtime Binding 后、Harness Selection 前必须产生 `sandbox_attested`；Agent Runs、Policy、Release 与 Evidence Package 应显示同一隔离模式、Workspace、Egress、Secret Mounts、Attestor 与 Digest。
- 即使重新计算合法 Event Digest，缺失 Attestation、`unrestricted` Egress、非 Ephemeral 环境或 Secret Mounts 非空都必须触发运行协议失败，并阻断 Evidence 与生产授权。
- Transcript 中 `runtime_bound` 必须早于计划、上下文和工具事件，Session 标记为追加写日志。
- Mock Run 应产生 `usage_reported`：65K / 80K tokens 触发 `warning + checkpoint`，并在 Context Compaction 与 Checkpoint 保存之前出现；Policy 与 Run 详情显示同一 Usage 和限制。
- 超出 Token、工具调用、时长或成本任一预算时，Budget Guard 必须返回 `exceeded + terminate`，Run 进入人工门禁，不能由模型自行忽略。
- 在 Run 完成前点击“取消 Run”，确认事件流以 `run_completed(cancelled)` 结束，且状态不进入人工批准。
- 正常完成后因 2 个失败 Trial 进入“等待人工评审”；点击“批准进入评审”后状态、通知和追溯事件同步更新，重复批准保持幂等。
- Mock Run 产生未声明敏感上下文请求后，上下文中心应显示“已阻断”，而不是“已读取”；Context Match、消费数和未使用资源随事件实时变化。
- Mock Run 应在读取上下文前创建 Code/Test/Docs 三个隔离 Scope，每个 Scope 显示 Allowed Sources 与 Token Budget；不得把完整父上下文默认复制给所有 Worker。
- Session 应写入 plan、finding、decision 三类持久 Structured Notes；Evaluation 前产生一次 Compaction，将 62.4K tokens 压缩到 23.8K，并保留三个 Note 引用。
- 上下文预算、策略卡、Session Context Operations、Transcript 和导出 Evidence Package 必须从同一 Scope/Note/Compaction 事件计算。
- 正常 Run 的 Evidence 应包含 Evaluation 前检查点；点击“从检查点恢复”后，新 Run 复用原 Session、使用新 Sandbox，并只产生恢复、评估和完成事件，不重复工具调用或 Artifact。
- 在 Run 非终态时刷新页面，状态应变为“运行已中断”，审批按钮禁用；已有 Checkpoint 时显示“恢复中断 Run”，无 Checkpoint 时显示“封存并重新开始”。
- 恢复前旧 Run 必须先追加 `run_completed(cancelled)` 并封存独立 Evidence Package；从本地状态重建 Draft 后，摘要链与 Package Digest 仍应验证通过。
- Run 门禁批准后，评审队列顶部出现该 Run；“请求修改”和“批准变更”更新状态、通知与追溯事件。
- 批准变更后，发布页切换为该 Run 的 Release Candidate，并显示实时 Evaluation、Artifact 和 Policy 证据。
- 生产授权必须绑定当前 Candidate ID；创建或切换到新候选后，不得沿用旧候选的授权状态。
- 生产授权还必须要求当前 GitHub Head SHA 对应的 Review/Checks 通过，并且关联 Evidence Package 已由 Repository 复验；任一条件缺失时，页面按钮与 Reducer 均要阻断。
- 证据中心应随当前 Run 更新四类证据卡；导出的 Evidence Package 包含完整 Transcript 和 `integrity.algorithm = SHA-256`，页面显示最近导出的摘要前后缀。
- Run 终态后，详情 Evidence、证据中心和 Traceability 必须显示同一个 `local://` Package URI 与 Repository Digest；运行未结束时显示“等待终态封存”。
- Evidence Sink 应在 Store 接收前逐事件验证摘要链；Run ID 不一致、Sequence/前序摘要/事件摘要被篡改时拒绝追加，非终态 Run 拒绝封存。
- 刷新页面后，本地 Evidence Repository 应重新加载封存包并显示“已复验”；篡改仓库事件或包摘要后必须显示“复验失败”，不能沿用旧的可信状态。
- Mock Run 应产生 JUnit、SARIF 和 Coverage 三类 `ci_evidence_ingested` 事件；Run Evidence 显示报告来源、工具、归一化摘要、状态与 Digest，证据中心显示实时报告数量。
- JUnit/SARIF/LCOV 无效输入必须由 CI Adapter 拒绝；任一 CI Evidence 状态为 `failed` 时，即使尚未产生 Evaluation，也要标记 Run 需要人工门禁。
- 当前 Run 有 Evaluation 失败时，“需要诊断”顶部出现实时失败项；详情 Transcript 必须来自该 Run 事件流。
- 点击“创建 Regression”后生成唯一 REG 对象，重复点击保持幂等；详情明确提示后续仍需独立 Trial、Fixture、Seed、Grader 和 Reference Solution。
- Regression 详情可依次准备 Fixture、Deterministic Grader 和 Reference Solution；三项完整前不得运行 Trial，完成后可运行三个独立 Trial 并捕获基线。
- 首批 Regression Trials 应保留 Batch、Seed、耗时、结果与失败原因，并显示 `pass@3 = 100%`、`pass³ = 0%` 的可靠性差距；再次运行稳定批次后 `pass³` 更新为 `100%`，历史 Trial 仍保留。
- 刷新包含旧版 `trialsRun` 数据的本地状态时，应迁移为可审计 Trial 记录，不得丢失已捕获基线。
- Context Manifest 表格显示 Trust 与 Sensitivity；未信任 MCP 内容应显示为“未信任 / 已阻断”，且不能出现对应 `context_consumed`。
- Policy 页面三层状态、自动策略决策数、人工门禁数和 Approval Load 应随当前 Run 事件变化。
- 集成页输入 `#155` 后应创建 Intent、记录 GitHub Import 和 Projection；重复导入不得创建第二个 Intent，未知 Issue 显示错误提示。
- 集成页输入 `#428` 后应投影批准状态、Head SHA 和三个成功 Checks，并回写当前 Run / Evidence 引用；重复同步同一 Head SHA 保持幂等。
- 输入 `#512` 后应显示 Changes Requested 和失败 Check；发布页 GitHub 门禁变为等待，批准生产发布按钮禁用，Reducer 直接调用也不得绕过。
- 同一 PR 的 Head SHA 变化后，旧 Release Candidate 的生产授权必须撤销，要求基于新快照重新评估和批准。
- Run 执行中点击“重置 Mock 原型状态”应中止并丢弃后台 Run，重置后不得被迟到事件重新污染；快速重复启动也只能产生一个活动 Run。
- Agent 事件必须形成从 `genesis` 开始的摘要链；修改 Sequence、`previousEventDigest` 或事件内容后，Store 应标记“事件完整性失败”并禁用恢复和批准按钮。
- Evidence Package 的 Run Manifest 应包含 `sessionIntegrity` 与 `chainHead`；Traceability 页面同步显示 Chain verified / failed。
- 浏览器导出的 SHA-256 内容摘要与原型 Sink Digest 必须明确区分，界面不得把 FNV 原型校验和描述为签名。
- 点击 Review 项打开证据审查抽屉。
- Release 页面批准后，所有 Gate 变为通过，Production 进入可部署。
- Release 批准后点击“部署到 Production”，应生成唯一 Deployment ID、Provider、Artifact Digest 与 Rollback Ref；重复点击不得创建第二条部署，未授权候选、Head/Evidence 不匹配或非 `github:*` 审批身份必须被拒绝。
- 部署完成后仅 Owner 可执行 Production 回滚；回滚必须绑定原 Deployment、Candidate 与 Rollback Ref，生成唯一 Rollback ID 和 Restored Artifact Digest，Reviewer 或不匹配引用不得改变状态。
- Feedback 页面可以把信号转换为 Intent 或 Regression；生成结果会出现在 Intent 或 Evaluation 页面。
- Evaluation 页面可以切换全部、回归和发布门禁。
- Evaluation 失败项可展开 Task、Trials、Graders 和 Transcript。
- Traceability 页面随发布批准和 Feedback 回流更新事件账本。
- 侧栏支持折叠，并在本地保存偏好。
- 团队页切换到 Developer 后，Run Gate、Review 和 Production 审批按钮应禁用，直接调用 Reducer 也不得产生决策；切换到 Reviewer 后可批准 Run/Review，但仍不能授权生产。
- 切换回 Owner 后可批准生产，追溯事件必须记录 `github:*` 外部身份；Agent 身份不得出现在人类审批 Actor 中。
- Reviewer 完成 Run Gate 或变更评审后再切换操作者，Run/Review 抽屉仍应显示原审批人的 `github:*` Identity；Owner 完成生产授权后切换操作者，发布门禁也不得改写历史审批人。
- 导出的 Evidence Package `run` manifest 应包含 `runGateApprovedBy` 与 `reviewDecisionBy`，并与界面和追溯账本中的责任主体一致。
- 启动 Mock Run 后，Transcript 中的 Work Contract 提议与独立评审应出现在任何 Worker Scope 和实现产物之前；Generator 与 Evaluator 引用必须不同，Contract Digest 必须一致。
- Managed Run 应严格按 `roadmap_created → sprint_planned → plan_created → work_contract_proposed → work_contract_reviewed` 发生；Run 概览和 Evidence Package 应展示相同 Roadmap、Sprint 与 Digest。
- `evaluation_diagnosed` 之后、`run_completed` 之前必须出现 `roadmap_updated`，引用评估反馈、更新已知里程碑并给出下一 Sprint 目标；缺失或 Digest 链不一致时协议校验必须失败。
- Run 概览应显示 Work Contract 的目标、标准数量、非目标数量、Evaluator 和 Digest；导出的 Evidence Package 应包含同一提议与评审记录。
- Mock Run 应在 Plan 前产生 `harness_profile_selected`，展示候选数量、模型上下文能力、执行模式、Reset Policy 与 Eval Evidence Ref；Evidence Package 必须保存同一选择记录。
- Mock Run 应在 Harness Selection 后、Roadmap 前产生 `workflow_bound`；Run 概览和 Evidence Package 应显示相同 Workflow ID、Provider、Replay Mode、Retry Policy 与 Human Resume 设置。
- Test Activity 的 Attempt 1 应产生可重试瞬态失败，再以同一 Idempotency Key 调度 Attempt 2 并完成；Attempt 不连续、改变幂等键、超过最大次数或没有可重试失败时，协议校验必须拒绝。
- Secrets 与未信任 MCP 的 Policy Denied Activity 必须以不可重试失败结束，不得出现 Retry Scheduled。
- Run 执行中刷新页面后，Workflow Repository 中较新的事件历史应恢复为“运行已中断”；继续追加前必须显式 Recover，并保持原 Next Sequence、Previous Digest 与最近 Checkpoint。
- 相同事件重复写入 Workflow Repository 应保持幂等；同 Sequence 不同 Digest、Record Digest 篡改或完成态继续追加必须被拒绝。
- Evidence Package 封存后应出现 Evidence Attestation 状态，显示 in-toto Statement、DSSE Envelope、ECDSA Key ID、`ephemeral_local` 与 `identity unanchored`。
- 修改 Package 内容、Statement Predicate、DSSE Payload、Signature 或 Package Binding 后，Attestation 必须显示复验失败；签名有效但 Run/URI/Chain Head/Event Count 不匹配同样不得显示已验证。
- Managed Run 应在 Workflow Binding 后、Roadmap 前产生 `policy_bundle_bound`；策略页和 Evidence Package 应显示相同 Provider、Bundle ID/Version、Rule Count、Default Deny 与 Bundle Digest。
- Policy Decision 的 Version 必须与 Bound Bundle 一致，Input Digest 必须存在；缺失 Bundle、Bundle Digest/规则清单被修改或版本漂移时，协议校验必须失败。
- Repository Read 与 Sandboxed Shell 应由确定性规则自动允许；Secrets、Sensitive Context 与 Untrusted External Content 应自动拒绝；Production Write 无具名 `github:*` 身份时应返回 Require Approval。
- Evaluation 页面应显示当前 Experiment、Dataset Version、Trace Ref、Grader Count、Trial Count 与 Environment Digest；相同信息必须进入 Evidence Package。
- Managed Evaluation 缺少 `evaluation_experiment_bound`、Experiment Digest 被修改、Result Count 与 Trial Count 不一致或 Diagnosis Environment 不匹配时，协议校验必须失败。
- Run 终态后，Evaluation、Evidence 与 Traceability 应显示同一个 Trace ID、Span Count 和 Provider；导出的 Evidence Package 必须包含同一 Trace Projection。
- Trace Projection 必须绑定当前 Run ID、Event Count 与 Chain Head；任一不匹配或 Projection Digest 被修改时，Reducer 必须拒绝写入。
- Trace Span 不得包含 Prompt、Context 内容、Context Resource Path 或 Tool Output；Context 只允许导出 Digest、Trust 和 Sensitivity 等脱敏属性。
- Traceability 的 Sanitized Trace Explorer 应能按全部、Tool、Policy、Evaluation 筛选 Span，并始终显示 Trace ID、Projection Digest、Span ID、Event Type 和 Event Sequence。
- Error 或失败 Evaluation Span 应允许人工创建 Regression；创建后的资产必须保留 Run ID、Trace ID、Span ID、Projection Digest 与 Event Digest，重复点击不得创建第二份资产。
- “导出 OTLP Bundle”只能生成本地 JSON 文件，不得发起网络请求；导出后页面应显示 Exported/Dropped Span 数量与 Export Digest。
- Telemetry Export 必须始终保留 Root、Error、Policy Deny 与失败 Evaluation Span，同时保留这些 Span 的父链；Routine Span 按确定性采样率处理。
- OTLP Bundle 必须绑定源 Projection Digest、Policy ID/Version、Sampling Rate、Content Mode 与独立 Export Digest；Prompt、Message、Content、Context Path 和 Tool Output 属性必须被出口 Allowlist 拒绝。
- Telemetry Export 仅允许 Owner/Maintainer；Developer/Reviewer、错 Run、错 Trace、错 Projection Digest、无效 Bundle 或重复 Export Digest 都必须被 Reducer 拒绝。
- 合法导出应保存 `exportedBy`、时间、Provider、Policy、Destination、Exported/Dropped Count、文件名与 Export Digest，并出现在事件账本和 Provenance。
- 发布页必须显示 `AutonomyDecisionProvider` 的 Phase、Risk Tier、Decision、Reasons、Required Controls 与 Decision Digest；第一阶段固定为 `human_approval`，不得展示为自动合并已启用。
- Session/Evidence/Sandbox/CI/Evaluation 任一确定性控制失败时自治决定必须为 `blocked`；中高风险、外部 Egress、破坏性操作、生产影响或未锚定身份必须保持 `human_review`。
- 仅在未来 `low_risk_auto_merge` Phase、低风险、Repository-only、无外部 Egress/破坏/生产影响、身份已锚定且所有确定性控制通过时，Provider 才能返回 `auto_merge_eligible`；最终合并仍由仓库保护和 Merge Queue 执行。
- Evaluation 的 Harness Ablation 表应逐项展示候选 Profile 的 Mode、Reset、可靠性、P95、成本和 Evidence Ref，并突出与 Agent Runs 页面一致的 Selected Profile。
- Evaluation 失败后应出现 `evaluation_diagnosed` 归因面板，区分 Agent 与 Infrastructure 等类别，并显示置信度、Transcript Review、Clean Start、Shared State 和 Image Digest；Release Gate 应展示相同归因摘要。
- Agent / Task / Grader 归因的回流按钮应创建 Regression；Harness / Infrastructure 归因应创建修复 Intent，并出现在 Intent 页面而不是回归资产列表。
- 上下文中心应展示 Adaptive Reset 状态；当 Token 使用达到策略阈值时，`context_reset_decided(compact)` 必须先于 `context_compacted`，并在 Transcript 中解释触发原因。
- 即使重新计算了合法事件摘要，若 Managed Run 在 Work Contract 独立确认前创建 Worker Scope / Tool / Artifact，或未经过 `compact` 决策直接压缩，Store 与 Evidence Repository 仍必须以“运行协议失败”拒绝该序列。
- 页面 Hash 可以直接收藏和刷新恢复。
- 发布批准、Feedback 转换、通知和活动事件保存在 `localStorage`，刷新后保持一致。
- 集成页面提供“重置 Mock 原型状态”，用于恢复初始测试数据。
- 集成页 Provider Catalog 应显示稳定 Contract、借鉴机制、部署形态和阶段；“原型接入 / 下一阶段 / 研究中”筛选只改变目录行，不影响已配置集成状态。
- 每个 Provider 应同时具备 Borrowed Pattern、Avoid Pattern 和 Evidence Boundary；Offline 条目不能只提供 Managed 部署形态。
- 团队页顶部显示信任模式面板；Development 下顶栏徽标为琥珀色「本地身份 · 可自证」，Team 下密码 Session 显示红色「只读 · 需 GitHub 登录」，GitHub Session 显示绿色 `github:<login>`。
- Owner 在成员行「声明 GitHub 账号」后，该行显示「待验证 github:<login>」；成员用 GitHub 登录后变为「已验证 github:<login> · #<id>」。非 Owner 看不到声明按钮。
- 用未声明的 GitHub 账号登录，应回到登录页并显示「这个 GitHub 账号没有被 Owner 声明给任何成员…」，且没有创建 Session；地址栏中的 `identity_error` 参数应被清掉。
- Owner 用密码登录时「切换到 Team 模式」按钮禁用并说明原因；用 GitHub 登录后可切换。Team 模式下用密码登录的 Reviewer 批准 Intent 应失败并提示 `external_identity_required`。
- 未配置 `CONTROL_PLANE_GITHUB_CLIENT_ID` / `SECRET` 时登录页不出现 GitHub 按钮，信任模式面板提示服务端未配置。
- 侧栏项目切换器列出你所在的项目（显示 slug 与托管方式），末尾是「管理项目」；切换后 Work Item、Run、提案、事件都只显示该项目的数据，刷新页面仍停留在所选项目。
- Owner 建两个本地项目，只把某成员加入其一：该成员的切换器只出现一个项目；直接请求另一个项目的 `/api/work-items?projectId=` 返回 404 `project_not_found`。
- 团队页成员行同时显示「默认」角色与「本项目」角色；在项目页改成员角色后，该成员在这个项目里的按钮（批准、合并、认领审查）随之变化，其他项目不受影响。
- Run 与提案表单没有仓库路径输入，只读显示「项目仓库 · 默认分支」；本地项目配置一个相对路径、非 Git 目录或数据目录内的路径时，保存失败并提示原因。
- 新建 GitHub 项目时在「Token 变量名」里粘贴 Token（如 `ghp_…`）应被拒绝并提示只填变量名；项目卡片只显示变量名。服务进程没有该变量时「测试连接」提示变量未设置。
- GitHub 项目卡片有「立即同步」（Owner / Maintainer），同步后提示发布、导入检查、门禁更新、合并、关闭的数量；「最近同步」显示时间与错误。
- 同步后提案行出现「PR #n」链接、状态和 `aperture/gate`；批准且 Evidence 就绪后门禁变为 success（边框变绿），GitHub 上 PR 的 Checks 里出现同名状态；GitHub Actions 的检查以 `github/<name>` 出现在 readiness 中。
- `control_plane` 的 GitHub 项目合并按钮文字为「合并并推送」；先在 GitHub 上给默认分支推一个提交再合并，应提示远程已前进且提案仍为 approved。
- `host_protected` 项目没有平台合并按钮，而是「在 GitHub 上合并」链接；在 GitHub 合并后下次同步提案变为 merged，Merge Evidence 显示「GitHub 合并 · ancestor / patch_equal」。未批准就在 GitHub 上合并的提案显示红色「绕过门禁的合并」及原因。
- 在 GitHub 上关闭 PR，下次同步后提案显示已拒绝，理由为 `closed_on_host: <PR 地址>`。

## Responsive

- 宽屏：完整双栏和多列信息密度。
- 1100px 以下：复杂工作区降为单列。
- 760px 以下：移动侧栏、表格降级和横向滚动。
- 520px 以下：抽屉与 Evidence 内容重排。
- `prefers-reduced-motion` 下关闭非必要动画。

## Known Prototype Boundaries

- 所有外部系统数据都是 Mock；Agent Runs 已通过本地 Mock Adapter 执行真实异步事件流，但不连接真实模型或执行环境。
- Local Workflow Repository 基于 `localStorage`，用于验证浏览器 Reload 恢复语义，不具备多进程锁、租约、原子事务或跨机器故障恢复能力。
- Evidence Attestation 使用本地临时 ECDSA 密钥，尚未锚定企业 PKI、KMS、OIDC 身份或 Sigstore Transparency Log，因此不作为生产身份门禁。
- Trace Provider 当前只生成浏览器内的 OTel 风格脱敏投影，未连接真实 Collector、Langfuse、Phoenix 或长期 Trace Store；OpenTelemetry GenAI 语义仍可能演进。
- 批准、发布和回流按钮只修改当前页面状态，不产生外部操作。
- 浏览器自动视觉验收服务当前不可用，需要人工检查最终像素表现。
