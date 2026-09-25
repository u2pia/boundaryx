# AI Native SDLC Workbench

面向 3–8 人研发团队的 AI Native SDLC 项目管理工作台高保真原型。

## 原型范围

- 研发态势总览
- Intent 管理
- Agent Run 运行中心
- Workflow / Agent 编排拓扑与 Transcript
- Planner 维护的 Roadmap、Sprint 边界与 Evaluator 反馈更新
- Generator 与 Independent Evaluator 协商的可测试 Work Contract
- 基于模型上下文能力、Eval 可靠性与成本约束的 Harness Policy
- 借鉴 Temporal / LangGraph 的 Durable Workflow Contract、Activity Attempt、Retry、Idempotency 与 Human Resume 语义
- 独立于 UI Store 和 Evidence Repository 的 Local Workflow Repository，支持幂等事件追加、Reload 恢复游标和篡改检测
- in-toto Statement + DSSE PAE + ECDSA P-256 Evidence Attestation，分别验证签名、Payload、Subject Digest 与 Package Binding
- OPA 风格的 Policy Decision Provider、Default Deny Bundle Binding、输入摘要与决定版本校验
- Langfuse / Phoenix 风格的 Dataset、Experiment、Candidate、Trace、Grader 和环境关联
- 从签名事件链派生的本地 OTel 风格 Trace Projection，绑定 Run、Event Count、Chain Head 与独立 Projection Digest
- 可执行的 Mock Agent Adapter、实时事件流与 JSONL 导出
- Model / Harness / Sandbox / Session 四层托管运行时绑定
- Sandbox Attestation、Egress Allowlist 与最小凭证挂载证明
- 风险优先的评审队列
- Release Gate、环境推进与回滚计划
- 受具名生产授权约束的 Deployment Provider 与部署证据
- 显式 Owner/Maintainer 触发的本地 fast-forward Merge Evidence，确保目标分支精确等于 Approved Head SHA
- `changes_requested` 后绑定 Reviewer Feedback 的 Agent Revision Run，并自动失效旧 Review、Check 与 Evidence
- 从 Merge Evidence 创建 Source Snapshot Release Candidate，并要求独立 Owner/Maintainer 发布批准
- Eval Suite、Trial、Grader 与 Regression
- Evidence 证据中心
- Intent-to-Production 追溯链与事件账本
- 三层 Agent 隔离与执行策略管理
- 生产信号、修复建议与反馈闭环
- GitHub、Agent、CI、通知与模型集成中心
- 借鉴 Backstage 模式但面向控制面的 Provider Catalog，记录稳定契约、部署形态、离线就绪度、借鉴与不照搬项
- 服务端 Session Identity、团队成员管理与具名授权
- 跨页面共享状态、领域事件与本地持久化
- Agent Adapter / Evaluation Contract 与可执行 Mock Adapter
- 团队与审查负载
- 审查成本与决策质量度量

## 设计方向

- 高信息密度，但避免传统企业后台的表格堆叠
- 优先表达风险、等待决策和证据完整度
- 使用一致的状态色，而不是依赖大面积装饰色
- 将常用操作保留在首屏，并支持 `⌘ K` 命令菜单
- 桌面端优先，同时提供平板和移动端响应式降级
- 不依赖外部字体、图片或在线资源，便于私有化部署

### 可读性约束

高信息密度不等于把字号压到 7px。界面以中文为主，CJK 在同一字号下笔画密度是拉丁字母的 2–3 倍，因此以下几条由 `npm run check:legibility` 机器校验，不靠人工 review 维持：

- 字号下限 12px，`font:` 简写与 `font-size:` 同等对待（早期 7–9px 的等宽 ID 就藏在简写里）；
- 正文颜色在最深表面 `#13151d` 上不低于 4.5:1（WCAG 1.4.3 AA）。次级层次由 `--text-2` / `--text-dim` / `--faint` 三档承载，而不是一百多个彼此难以区分、且全部低于 3.5:1 的灰；
- 表单控件边框用 `--field-line`（实测 3.1:1，满足 WCAG 1.4.11），`--line` 只用于分隔线和面板边缘——分隔只需要"分开"，控件边框需要"能被找到"；
- 所有 `var(--…)` 必须有定义。未定义的 token 会让整条声明静默失效，此前就导致两处输入框边框和一处失败阈值颜色完全不可见；
- 固定高度不小于其字号的 1.7 倍，避免行盒裁掉 CJK 字形；
- 文字颜色不使用 `rgba()`：半透明文字的对比度取决于它恰好落在什么背景上，无法校验。
- 键盘焦点只由全局 `:focus-visible` 规则负责（`--focus-ring`，在各表面上 8.7:1 以上），组件内禁止 `outline: 0` / `outline: none`——此前 7 处这样的写法让所有输入框、下拉框、文本框在键盘操作时看不到焦点；
- 单列栅格写 `minmax(0,1fr)`，不写裸 `1fr`：裸 `1fr` 的最小宽度等于内容宽度，一条 8 段的流程条就把 390px 视口下每个面板撑到 718px。

以下几条不能由脚本校验，靠 review 维持（来自 [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) 与 [hallmark](https://github.com/Nutlope/hallmark) 的规则）：

- **不展示无来源的数字。** 演示数据必须带演示标注；侧栏曾硬编码导航计数和「本月 Agent 额度 68%」，在每个页面上无标注地出现，已删除。这是一个管证据的平台，界面自己不能编数；
- 纯图标按钮必须有 `aria-label`，`title` 只在悬停时出现，不算可访问名称；
- 表单错误用 `role="alert"`，异步进度提示用 `role="status"`，不抢焦点；
- **演示内容放进 `<DemoRegion>`，不另起标签。** 它带虚线外框和「演示数据」标记，只在默认项目（`PRJ-DEFAULT`，项目切换器里标「演示」，所有成员都在其中且不能移出、项目不能归档）和未登录时展开显示；在其他项目里只剩一行说明和「切换到演示项目」，右上角的原型通知也一并隐藏，真实项目的页面只展示真实数据；在它内部 `--green` / `--green-text` / `--green-rgb` 被重定义为中性灰，所以演示数据不会显示「通过」的绿色。这依赖绿色一律走 token——新的状态绿请用 `var(--green-text)` 或 `rgba(var(--green-rgb), …)`，写死的色值会漏出这个作用域；
- 页头的主操作位只放真实可执行的操作。演示操作（如「播放演示 Run」）放在对应 `DemoRegion` 的 `actions` 里，未接入的原型按钮不放进页头；
- 小标题（`.eyebrow`）只在携带信息时出现，例如区分「真实数据」与演示数据，不做装饰；不用全大写英文，也不加宽字距；
- 每个输入框都要有可访问名称（可见 label 或 `aria-label`），不能只靠 placeholder；登录与初始化的密码框分别标 `autoComplete="current-password"` / `"new-password"`。
- 可点击目标不小于 24×24px；同一屏只放一个 `primary-button`，演示区里的操作一律用 `secondary-button`。
- 图表要带直接数值标签和 `role="img"` + `aria-label` 摘要，不用渐变表达数值。
- 切换页面后焦点移到 `#main-content`，首次加载除外。
- 字号只用 `--text-xs/sm/md/lg/xl/2xl`（12/13/14/16/20/28px）六档，`check:legibility` 会拒绝写死的字号；圆角只用 `--radius-sm/md/lg`（3/4/6px），圆形和胶囊除外。
- 科技感来自 HUD 细节而不是换皮：`.panel` 四角 12px 角标和顶边光线用背景层绘制（子类自设 background 即自动退出，不要在文件末尾再覆盖 `.panel` 的 background）；分区标题左侧 3px 蓝条；辉光只给有状态的元素（当前导航、主按钮、关键数字、进度、图表）。圆角 2/3/4px，全局 `tabular-nums`；指标标签比数值暗一级（三级信号层次）。动效只回应真实事件：路由切换扫描一次，只有运行中的 Agent Run 条持续扫光，`prefers-reduced-motion` 下全部关闭。
- 底色是深海军蓝：`--bg` #071224、`--panel` #0b1b37、`--panel-2` #0e2142，分隔线用蓝色调 `--line`；`check:legibility` 以 #0e2142 为基准面校验文字对比度。新增表面色不要再用中性黑灰。
- 主色是科技蓝 `--accent` (#2f7bff)，文字用 `--accent-text` (#7fb2ff)，主按钮实底 #1d64f2（白字约 5:1）；紫色已整体移除，新增强调色不要再引入紫色系。
- 视觉方向是「精密仪表」：32px 淡网格背景加平面面板，数值、ID、耗时用 `--font-mono`，青色 `--cyan` 只给实时状态，不做装饰性渐变和发光。
- 颜色优先引用 token。与 token 同值或近似重复的色值已合并（约 340 处），新增颜色先进 `:root` 再引用。

`line-height: 1.55` 是全局基线，同样出于 CJK 行距需求。

方法论对齐与增量设计见：

- `../docs/ANTHROPIC_ALIGNMENT_REVIEW_2026-09.md`
- `../docs/CONTROL_PLANE_DESIGN_V0.4_DELTA.md`
- `../docs/PRODUCT_PRACTICE_RADAR_2026-09.md`

产品名为 **BoundaryX（邦界）**。代码与协议中的 `aperture` 标识（`.aperture/project.json`、`aperture.project.v1`、`APERTURE_*` 环境变量、`aperture/gate` 状态、`.aperture*` 数据目录）暂时保留，以免已接入的仓库、启动命令和分支保护失效；之后会做新旧并存的迁移。

P1 的 Builder Agent 协议见 `../docs/LOCAL_AGENT_PROTOCOL.md`。当前阶段不依赖 Docker Desktop、Podman Machine 或其他本地 VM；Process Runtime 始终标记为 `degraded / unisolated_process` 且不能获得生产资格。OCI Runtime 仅保留为 Lab 参考，不进入默认启动路径。

2026-09-23 已完成首个真实本地案例：Codex 在独立 Git Worktree 中修改 TypeScript 应用，自动测试 6/6 通过，生成可复验 Evidence Package，由独立 Reviewer 身份查看 Evidence 后批准确定 Head SHA。案例报告见 `../docs/REAL_CASE_2026-09-23_IMPORT_VALIDATOR.md`；目标分支保持未合并，避免把脚本审批冒充真实人工合并授权。

## 本地运行

推荐使用 Local Control Plane 模式：

```bash
npm install
npm run build
npm run server:start
```

完成首次初始化（创建 Owner）后，`npm run seed:demo` 给默认项目写入一套演示：在数据目录下建一个发票服务示例仓库并接到默认项目，由一个脚本化 Builder（不调模型、不联网）走真实流水线——Run、仓库声明的 Check、`@baseline` 复跑、证据包、审查与合并——留下五条工作项：已合并、待审查、被失败测试阻塞、到时间预算交出的部分变更（批准需书面确认）、Intent 待批准。演示成员（`demo-*`）用随机密码创建、写完即停用，没人能以它们登录；待审查那条留给真实成员来审。默认项目已有工作项时脚本什么都不做；`npm run test:seed-demo` 在临时库上验证这套结果。

真实案例驱动脚本为 `npm run case:real`。它需要显式提供 Owner、Reviewer 密码与目标仓库路径，并要求服务已配置 `CONTROL_PLANE_AGENT_EXECUTABLE` 和 `CONTROL_PLANE_AGENT_ARGS_JSON`。Check、Context 与项目执行策略不再由服务启动变量提供，而是从目标仓库基线 Revision 的 `.aperture/project.json` 加载。脚本不保存明文密码。

## Agent Runner 启动

推荐只配置一个入口 `scripts/agents/builder.mjs`，执行引擎由集成页保存的 LLM Provider 在每次 Run 时自动选择，切换模型无需重启服务：

| Provider 配置 | 引擎 | 前提 |
| --- | --- | --- |
| Wire API `chat` | 内置 `chat-builder.mjs`：直接调用 `<Base URL>/chat/completions` 的工具调用循环（列目录、读写文件、替换、在 Worktree 内运行命令） | 无需任何 Agent CLI；DeepSeek、Qwen、OpenAI、vLLM、Ollama 等 OpenAI 兼容接口均可 |
| Wire API `responses` | `codex-builder.mjs` | 启动参数含 `--codex <路径>`；新版 Codex 已不支持 `wire_api = "chat"` |
| Provider `anthropic` | `claude-builder.mjs` | 启动参数含 `--claude <路径>` |

```bash
CONTROL_PLANE_AGENT_EXECUTABLE="$(command -v node)" \
CONTROL_PLANE_AGENT_ARGS_JSON="[\"$PWD/scripts/agents/builder.mjs\",\"--codex\",\"/path/to/codex\"]" \
npm run server:start
```

内置引擎的文件工具限定在 Worktree 内（拒绝 `..`、符号链接逃逸和 `.git`），拒绝会改写历史或分支的 git 命令，运行命令时不注入 Provider 密钥与 `APERTURE_AGENT_*` 变量；需要代理时沿用服务进程的 `HTTPS_PROXY`。它同样是 `degraded / unisolated_process`。

内置引擎有两道预算，用完都会先交出阶段性结果，而不是被直接杀掉、连同改动一起丢弃：

- **步数**：`APERTURE_BUILDER_MAX_STEPS`，默认 120 步。
- **时间**：Runner 在启动 Agent 时通过 `APERTURE_RUN_DEADLINE`（epoch 毫秒）告诉它自己何时会被杀，默认是 10 分钟后；可用 `CONTROL_PLANE_AGENT_TIMEOUT_MS` 调整（10000–7200000 的整数，写错时服务拒绝启动）。

从截止时间往回留出三段，按 10 分钟计：约 15 秒用于退出，约 90 秒用于最后一次写总结的模型调用，再往前约 2 分钟会提醒模型收尾。之后只提供 `finish`；`run_command` 和模型调用都会被截断，占不到这段预留时间。因时间停下的总结以 `Stopped at the time budget` 开头，标明改动可能不完整；连总结都来不及写时，引擎会代写一条。无论哪种情况，改动都会照常提交并跑完全部检查，再交给评审。

`codex-builder` 和 `claude-builder` 没法让外部 CLI 收尾，因此它们在截止时间前（留出 10%，最多 30 秒）直接停掉 CLI，把 worktree 里已有的改动照常交出，总结同样以 `Stopped at the time budget` 开头；Codex 最后一条消息会附在后面。

停下的原因（`time_budget` 或 `step_budget`）随 `agent_run.message` 事件记录，写进证据包的 `run.builderStopped`，并出现在当前 Head 的 Review Readiness（`builderStop`）里。评审页会把这类提案标为「部分变更」；批准时必须在审查意见里写明为什么接受它（否则返回 `409 review_partial_change_unacknowledged`），批准事件记录 `partialChangeAcknowledged`。之后由完整跑完的 Run 产生的新 Revision 不再带这个标记。

也可以直接指定单个包装器：
`scripts/agents/*.mjs` 是 Builder Agent 包装器，不是可执行文件：它们没有 shebang 也没有执行位，必须由 `node` 调用，包装器的第一个参数才是真实 Agent CLI。因此 Codex 的启动形式是 `node <wrapper> <codex>`：

```bash
CONTROL_PLANE_AGENT_EXECUTABLE="$(command -v node)" \
CONTROL_PLANE_AGENT_ARGS_JSON="[\"$PWD/scripts/agents/codex-builder.mjs\",\"/path/to/codex\"]" \
npm run server:start
```

直接把包装器路径写进 `CONTROL_PLANE_AGENT_EXECUTABLE` 会让 Run 以 `EACCES` 失败。Process Runtime 无隔离边界，启用即代表接受 `degraded / unisolated_process` 且不具备生产资格。

## LLM Provider 配置

Builder Agent 使用哪个模型由控制面决定，不由操作者本机的 CLI 配置决定。集成页的 `BUILDER AGENT LLM PROVIDER` 表单中手动填写 Provider ID、Model、Base URL、Wire API、Reasoning Effort 与 API Key 后保存即可，无需重启服务：Runner 在准入与执行时各自从数据库读取当前 Provider，两次 Attestation 一致（服务启动时构建的 Runner 也不会沿用旧 Provider）。

- 只有 Owner 可以修改；Owner、Maintainer、Developer 可以读取；Reviewer 无权读取，表单对其隐藏。
- API Key 只写不读。读接口只返回是否持有密钥；留空表示保留已存密钥，显式清空表示删除。密钥以明文存于本地 SQLite——本地测试阶段接受这一取舍，但它是显式的技术债：进入多人或生产部署前必须换成操作系统密钥链或 KMS 封装，不能默认它安全。
- 也可以不把密钥交给控制面：清空密钥并填写 `API Key 环境变量`，服务进程中的该变量会被放行给 Agent 进程。
- 保存与清除都会写入 `agent_provider.configured` 事件，只记录是否持有密钥与变量名，永不记录密钥值。
- 模型、Provider、Base URL、Wire API、Reasoning Effort 与密钥来源变量名进入 Runtime Attestation 并参与 `attestationDigest`，因此 Evidence 可以回答"这次变更由哪个模型产出"。
- `npm run test:agent-provider` 验证角色边界、密钥不外泄、保留与清除语义，以及 Provider 设置确实进入 Agent 进程环境、Attestation 与 codex `-c` 覆盖参数。

## Intent 起草

Intent 页的表单按 `PRODUCT_CHARTER.md` 的定义补三样东西：验收标准、约束、风险等级。这三样会进入 `contentDigest`、Evidence Package，以及 Builder Agent 的 prompt（`scripts/agents/codex-builder.mjs` 会把每条标准渲染成 `- [criticality/verificationType] statement`），所以它们必须由起草人声明，不能由界面代填——代填出来的"全部确定性关键"是一句谎话，会让 Agent 以为"界面更好看"是一条可以确定性验证的关键标准。

「套用模版」按钮按当前产品类型（App / Agent System）填充目标、约束与验收标准。模版故意保留 `<...>` 占位符：套用之后解析预览会立刻提示"还有未替换的模版占位符"，模版因此是一份必须逐项填完的清单，而不是一段可以直接提交的空话。

验收标准一行一条，行首可带任意数量、任意顺序的方括号标注：

| 标注 | 含义 |
| --- | --- |
| `[确定性]` / `[deterministic]` | 由测试、退出码、错误码等确定性检查证明（默认） |
| `[模型]` / `[model]` | 由模型评估证明 |
| `[人工]` / `[human]` | 必须由人判断 |
| `[关键]` / `[critical]` | 关键项（默认）。未被证明或证据失败时不得进入 Approved，见下文「验收标准证据门禁」 |
| `[参考]` / `[normal]` | 非关键项，不阻塞合并 |
| 行尾 `[验证: node-tests, lint]` / `[verify: …]` | 起草人显式声明这条标准由哪些检查证明（`verifiedBy`），见下文。不能用于 `[人工]` 标准 |

不写标注时默认按「关键 · 确定性」处理。**默认成 `critical` 是有意的**：`DOMAIN_MODEL.md` 规定"Critical 评估失败时不得进入 Approved"，若无标注的行默认成 `normal`，习惯直接敲纯文本的人会在不知情的情况下把审批门禁关掉。安全默认值必须是 `critical`，降级必须显式写 `[参考]`。遇到第一个未识别的方括号（如打错的 `[确定]`，或语句本身以 `[POST /api/import]`、`[边界]` 开头）就停止解析标注，把它**连同其后内容原样保留为语句**并给出告警。这两种情况在语法上无法区分，只能选不丢信息的一侧——被切掉的文字会进入 `contentDigest` 与 Agent prompt，Agent 看到的就不再是起草人写下的那句话。单条标准上限 300 字，超长通常意味着几条标准写在了一行里。

文本框下方实时显示每行被解析成了什么，以及逐条的模糊度提示：语句含"优化 / 提升 / 更好 / 尽量 / 合理"等词却没有任何数值、阈值或错误码时，标为 `[确定性]` 却没有可断言的具体值时，都会提示。**这些提示不阻塞提交**，因为模糊度判断靠启发式，误报的代价应该由人承担而不是由门禁承担。

硬拦截只有以下几条，全部在服务端执行：

- `DOMAIN_MODEL.md` 的"高风险 Intent 必须定义人工审批要求"：`riskLevel` 为 `high` 时必须至少有一条**关键的** `[人工]` 标准。用一条自己声明"不阻塞合并"的 `[参考][人工]` 来满足它是自相矛盾的，所以不算；
- 关键 `[人工]` 标准必须写清由谁判断什么：含 `<占位符>` 或少于 8 个字（如「人工审核通过」「ok」）的语句被拒绝（`human_criterion_not_substantive`）。模版里的 `[人工] <谁> 确认 <什么>` 必须改写后才能提交；
- 中、高风险必须至少有一条关键标准。全部写成 `[参考]` 的 Intent 会在审批门禁开始读取 `criticality` 的那天静默绕过它；低风险允许，但会告警；
- 枚举值合法、语句非空、单条不超过 300 字；`verifiedBy` 最多 8 个合法检查名，不能写 `@baseline`（独立性由平台判定，不由起草人声明）。

**验收标准证据门禁**：审查与批准路径逐条读取 `criticality` / `verificationType`（实现在 `server/criteria-coverage.ts`，由 `getReviewReadiness` 与 `recordReview` 调用）。`DOMAIN_MODEL.md` 要求 AC → 检查的映射来自人或确定性规则、不能来自模型；写了 `[验证: …]` 的标准用人声明的映射（`mapping: 'declared'`），其余用规则映射（`mapping: 'rule'`）：

- `[确定性]` 映射到 manifest 的 test / build / evaluation 检查（evaluation 的判定是阈值比较，本身是确定性的）。只靠 Run 自己可能写出来的测试通过的标准，状态是 `self_graded`（"仅自带测试"）：对关键标准它和"证据失败"一样阻塞批准。能解除它的是独立证据：`@baseline` 检查（把测试文件重置回 Base 后重跑）、manifest 声明了 `testPaths` 且 Agent 未改动这些文件，或外部上报的检查。本地 Evaluation 永远不算独立（见下文 Agent System 一节）。`@baseline` 只重置 `testPaths`，测试依赖的 helper / fixture 若不在其中，重跑时仍是 Head 版本：Evidence Package 的 `testProvenance.filesAtHeadDuringBaseline` 列出这些文件，`testPaths` 应覆盖测试运行所需的全部输入；
- `[模型]` 只映射到 evaluation 检查，manifest 没有声明 evaluation 时标为"无可映射检查"并给出原因；
- 声明映射只采信所列检查（及其 `@baseline`）；任一所列检查没有运行，标准为"无可映射检查"并写明是哪个，不会退回规则映射去找别的检查凑数；
- `[人工]` 由批准本身证明：存在人工标准时，批准意见必须**逐条点名**每条人工标准的编号（`AC-2：已与安全负责人核对威胁模型`），缺哪条就拒绝哪条（`review_human_criteria_unsigned`），事件里记录 `humanCriteriaSignedOff`。一句「ok」不再能签署任何人工标准，界面也不自动填充默认意见；
- 任一关键标准处于"待证据 / 证据失败 / 仅自带测试 / 无可映射检查"时，任何风险等级都不能批准（`review_blocked_by_criteria`），合并证据也随之被阻塞；请求修改始终允许。`neutral`（跳过）不算通过；
- 高风险变更若全部关键标准都是 `[模型]`，就绪状态为 blocked——模型评估不得作为高风险的唯一关键证据。

映射在 Run 后处理时写入 Evidence Package（`criteriaCoverage`），审查时按当前检查结果重新计算状态；没有打包映射的外部提案退回到"全部非 `@baseline` 检查视为 test"。外部附加 Evidence 时，包的 headSha / Intent / Run 必须与该提案一致（`evidence_package_mismatch`），`criteriaCoverage` 只取自经摘要校验的包文件，请求体里声称的映射一律丢弃。`verifiedBy` 存在 `acceptance_criteria.verified_by_json`（迁移 023），参与 `contentDigest`；未写 `verifiedBy` 的标准规范化后与旧版本一致，已有摘要不变。

这些校验都在 `server/database.ts` 的 `createIntentVersion` 里，而不是 HTTP 边界——smoke 脚本与 real-case 都直接调用这个方法，只在 HTTP 层校验会留下一个绕过口。前端只是提前显示同一条规则，避免用户提交后才撞到 400。

## 审查治理

以下规则都在 `server/database.ts` 执行，HTTP 与界面只是同一条规则的投影。

**Intent 先批准才能启动 Run**（`DOMAIN_MODEL.md` §6.1，V0.3 §10.1）。每个 Intent Version 有 `draft / approved / superseded` 三种状态：

- 低风险在创建时由轻量规则直接批准（`approval.basis = low_risk_rule`）；
- 中、高风险创建为 `draft`，需要一名 Owner / Maintainer / Reviewer 在 Intents 页点「批准 Intent」（`named_approval`）。起草人不能批准自己的 Intent（`self_intent_approval_forbidden`）；
- 新版本会把同一 Work Item 的旧版本置为 `superseded`，旧批准不能沿用到新内容上，但仍保留在历史里；
- `intent.approved` 事件绑定批准时读到的 `contentDigest`；
- 未批准或已被取代的版本在 Run 准入时就被拒绝（`intent_not_approved` / `intent_superseded`），不会创建 worktree。

迁移 015 把存量低风险 Intent 回填为已批准，中、高风险回填为 `draft`，需要各批准一次。

**Override / Reject 决策**（§5.6 / §6.4）。推翻门禁和拒绝提案都不是 Review，而是单独记录的 Governance Decision，包含 Actor、时间、理由，以及当时依据的 Evidence 摘要：

- Override 一次只推翻一条关键标准、只对当前 Head 有效。只有非作者的 Owner 能做，理由至少 10 个字。新 Head 会让它失效；
- 多条标准共用同一个失败检查时，要每条都推翻才算豁免这个检查。完整性检查（workspace-clean 等）不对应任何标准，永远不能被推翻；
- Reject 需要理由，提案随即关闭：之后不能再审查、记录检查、刷新或推翻。

**策略文件改动打标记**（§9.1.1）。Agent 可以写到治理它自己的 `.aperture/` 文件：

- 创建或刷新提案时用 `git diff base...head -- .aperture/` 计算 `policyFiles`，写进提案、创建事件、Readiness 和 Evidence Package（`policyChanges`，附带本次 Run 实际依据的 `manifest@baseSha`）；
- 审查队列用琥珀色横幅列出这些文件；
- 这类提案只有 Owner 能批准（`review_policy_change_requires_owner`），且批准意见必须写明为什么接受新策略（`review_policy_change_unacknowledged`）。事件里记录 `policyFilesAcknowledged`；
- 如果后续 Head 把策略文件改回原样，标记随之消失。

迁移 016 之前创建的提案 `policyFiles` 为空，刷新一次 Revision 即可补上。

**审查人分配**（§5.8，V0.3 §9.10）。Review Assignment 记录谁负责、截止时间、是否先展开证据再决策，以及用时：

- Owner / Maintainer 可以指定审查人，也可以选「按负载自动分配」：取待审数最少的合格者，负载只统计 `pending / in_review`；
- Reviewer 可以认领尚未分配的提案；
- 作者永远不能被分配。策略文件改动只能分配给 Owner；
- 一个提案同时最多一条有效分配。有分配时，只有被分配人能批准或请求修改（`review_not_assigned`），其他人仍可评论；
- 重新分配需要理由：旧记录置为 `reassigned` 并保留，新记录用 `reassignedFrom` 指向它；
- 新 Head 保留审查人，但会把状态、证据展开时间和用时清零；
- 逾期由 `dueAt` 在读取时推导，默认截止时间是 24 小时。
- 没有展开证据就批准（低风险轻量路径允许这样做）的，会在 `review.approved` 事件里标记 `unopenedApproval`，这是橡皮章审批的直接观测量；
- 没有分配时，任何有审查权限的非作者都可以决策，兼容存量提案。

## 外部身份

`DOMAIN_MODEL.md` 不变量 10「身份不可自证」：本地密码账号是自己声明的，账本里的「谁批准的」只有在外部身份提供方证明过之后才可信。

**信任模式**（V0.3 §8.3），保存在数据库，不在环境变量里：

- **Development**（默认）：密码 Session 可以做决策，但每个决策事件都冻结 `identity: { provider: 'local', assurance: 'self_asserted' }`，一眼可见是低保证身份；
- **Team**：批准 Intent、审查决策、合并、批准发布、Override / Reject、分配审查人、创建成员、配置 Agent Provider，都必须来自 GitHub 证明过的 Session，事件冻结 `{ provider: 'github', subject: <数字 ID>, login, assurance: 'external' }`。密码 Session 只能查看和评论（`external_identity_required`）。审查人分配只会选中已验证 GitHub 身份的成员（`assignee_identity_unbound`）；
- 切换模式本身是决策：只有 Owner 可以切，两个方向都需要 Owner 当前的 Session 由 GitHub 证明，所以密码 Session 不能把 Team 降回 Development。切换会记录 `identity.mode_changed` 事件。

**绑定流程**：

1. Owner 在团队页为成员「声明 GitHub 账号」（`identity.declared`）。一个登录名只能声明给一名成员；
2. 成员点「使用 GitHub 登录」，走 OAuth 授权码 + PKCE S256，`scope=read:user`。第一次登录名匹配时（不区分大小写）钉住 GitHub 数字 ID（`identity.verified`）；
3. 之后按数字 ID 匹配：GitHub 改名会被跟随（`identity.login_changed`），别人回收旧登录名不会继承绑定（`identity_not_bound`）；
4. 重新声明会撤销已验证的绑定，并让该成员所有 GitHub Session 失效。

OAuth 的 `state` 是一次性的，库里只存哈希，10 分钟过期，换取授权码之前就作废。Access Token 只用一次读取 `/user`，不落库、不写日志、不返回给前端。Client Secret 只从环境变量读取。

**配置**：在 GitHub → Settings → Developer settings → OAuth Apps 新建应用，Authorization callback URL 填 `http://127.0.0.1:8787/api/auth/github/callback`，然后启动服务前设置：

```bash
export CONTROL_PLANE_GITHUB_CLIENT_ID=...
export CONTROL_PLANE_GITHUB_CLIENT_SECRET=...
# 可选：
# CONTROL_PLANE_PUBLIC_URL=http://127.0.0.1:8787   回调地址的前缀
# CONTROL_PLANE_UI_URL=http://127.0.0.1:5173        回调结束后浏览器回到哪里（用 Vite 开发时需要设置）
# CONTROL_PLANE_GITHUB_OAUTH_BASE / CONTROL_PLANE_GITHUB_API_BASE   GitHub Enterprise
```

未配置时登录页不显示 GitHub 按钮，系统停留在 Development 模式。迁移 018 新增 `identity_bindings`、`identity_settings`、`oauth_states`，并给 `sessions` 增加 `auth_method` 列（存量 Session 都视为密码登录）。

已知边界：

- Owner 可以把自己控制的 GitHub 账号声明给别的成员。这个操作会以 Owner 自己的身份记入 `identity.declared` 事件，但系统无法阻止；
- 合并证据只冻结合并人的身份，不会把各次批准的身份复制进去，要查批准身份需要去看各条 `review.*` 事件。

## 项目与代码托管

**一个项目 = 一个仓库 + 一种代码托管 + 一组按项目授予的角色。** Work Item、Run、Change Proposal、Release Candidate 与事件都归属于项目。侧栏的项目切换器决定当前加载哪个项目；「设置与集成 → 项目」页负责创建、配置、测试连接、同步和管理成员。

**角色**

- 平台 Owner（`actors.role = 'owner'`）隐式拥有每个项目的 Owner 能力，只有平台 Owner 能创建、配置、归档项目和授予项目角色；
- 其他成员的角色按项目授予（`maintainer` / `reviewer` / `developer`），同一个人可以在 A 项目审查、在 B 项目只开发。账号上的角色只作为「加入新项目时的默认角色」；
- 非成员请求项目内任何数据都得到 404 `project_not_found`，不暴露项目存在与否。审查人自动分配只在项目成员中选人；
- 授予、变更、移除项目角色都是决策，事件 `project.member_added / member_role_changed / member_removed` 冻结操作人身份。

**仓库只来自项目**：浏览器不再提交 `repositoryPath`（带了会返回 400 `repository_path_not_accepted`）。本地项目的路径在配置时校验：必须是绝对路径、Git 工作树顶层、存在默认分支，且不在 `CONTROL_PLANE_DATA_DIR` 管理的目录内。

**代码托管方式**

| | 本地 Git（`local`） | GitHub / GitHub Enterprise（`github`） |
| --- | --- | --- |
| 工作仓库 | 配置的本机仓库 | 平台管理的裸克隆 `<dataDir>/repositories/<projectId>.git` |
| 提案发布 | 无 | 推送到平台专用分支 `aperture/<proposal id>`，开 PR（修订时同一个 PR 更新） |
| 门禁 | 平台内 | 平台内 + 在 Head 上发布 commit status `aperture/gate` |
| 外部检查 | 手工 `POST /checks` | 自动导入 GitHub check runs 与 commit statuses，命名 `github/<name>`，记录人为系统 Actor `system:code-host` |
| 合并方式 | 只能 `control_plane` | 按项目选择 `control_plane` 或 `host_protected` |

`aperture/gate` 只有在提案于平台内 `approved` 且 Evidence readiness 为 `ready` 时才是 `success`；请求修改、拒绝、证据阻断为 `failure`，其余为 `pending`，描述里写明在等什么。人工上报的检查不能以 `github/` 开头（`check_name_reserved`），只有同步器能写这些名字。

**两种合并方式**

- `control_plane`：平台在托管克隆里 fast-forward，再以 `--force-with-lease=<默认分支>:<审查时的 Base SHA>` 推送。GitHub 上的默认分支在审查后前进过 → `remote_base_moved`；被分支保护拒绝 → `host_rejected_push`。两种情况都会回滚本地分支、不写 Merge Evidence，提案保持 approved，刷新后重新审查即可；
- `host_protected`：平台里的合并按钮变成「在 GitHub 上合并」链接，合并由 GitHub 在分支保护下完成。同步器发现 PR 已合并后写 Merge Evidence（`strategy = host_merge`），记录合并提交与已批准 Head 的关系（`ancestor` / `tree_equal` / `patch_equal`，即 merge、同树、squash 或 rebase；否则为 `mismatch`）、合并时 `aperture/gate` 的状态、PR 实际 Head。任何一项不满足门禁时，证据标记 `outsideGate` 并列出原因，另发 `change_proposal.merged_outside_gate` 事件，界面标红。这是分支保护没配好时的审计兜底，不是拦截。

在 GitHub 上关闭 PR 会把平台提案关闭（等同 Reject，理由 `closed_on_host: <PR 地址>`）。平台内被拒绝但 PR 仍开着的提案会继续被同步（门禁为 `failure`），所以之后若仍被合并也会记录下来。

**配置 GitHub 项目**

1. 创建 fine-grained PAT，只授权目标仓库：Contents 读写、Pull requests 读写、Commit statuses 读写、Checks 只读（Metadata 只读是默认项）；
2. 在启动服务的环境里设置它，例如 `export APERTURE_GITHUB_TOKEN=github_pat_...`。项目配置里**只保存变量名**（`tokenEnv`），填入看起来像 Token 的值会被拒绝（`invalid_token_env`）；
3. Owner 在项目页新建 GitHub 项目：owner / repo、默认分支、合并方式、Token 变量名；GitHub Enterprise 填 API 地址（如 `https://ghe.example.com/api/v3`）和网页地址。点「测试连接」确认仓库可见、默认分支存在、Token 可以推送；
4. 选 `host_protected` 时，在 GitHub 仓库 Settings → Branches（或 Rulesets）里给默认分支开启「Require status checks to pass」，把 `aperture/gate` 设为必需检查，并禁止直接推送。选 `control_plane` 时，分支保护需要允许这个 Token 推送，否则合并会得到 `host_rejected_push`。

Token 在每次使用时从环境变量读取：API 请求用 `Authorization: Bearer`，git 通过 `GIT_CONFIG_COUNT / GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0` 环境变量注入限定到远程 origin 的 `http.extraheader`，不出现在命令行参数、克隆的 `config`、数据库、日志或浏览器里。`transport: ssh` 时 git 使用本机 SSH key，Token 只用于 API。Agent 的 Worker 进程不持有 Token：Run 在托管克隆里工作，推送与开 PR 都由主进程的同步器完成。

**同步**：主进程内定时轮询（默认 30 秒），另有项目页「立即同步」（`POST /api/projects/:id/sync`，Owner / Maintainer）；审查、检查、合并等决策之后也会立即触发一次。用轮询而不是 Webhook，因为服务默认只监听 127.0.0.1，GitHub 连不进来。

```bash
# 可选：
# CONTROL_PLANE_CODE_HOST_SYNC_SECONDS=30          同步间隔；0 关闭定时同步（仍可手动同步）
# CONTROL_PLANE_PUBLIC_URL=http://127.0.0.1:8787   写进 PR 正文和 aperture/gate 的回链
```

**迁移**：`019_projects.sql` 新增 `projects`、`project_members`，给各聚合加 `project_id`；存量数据按不同的 `repository_path` 各回填一个本地项目，没有仓库的 Work Item 归入 `default` 项目，现有非 Owner 成员以原角色加入每个回填项目，行为与迁移前一致。`020_code_host_links.sql` 新增 `code_host_links`，重建 `merge_evidence` 以允许 `host_merge` 策略并增加 `host_merge_json`（存量行原样复制，只追加触发器照旧），并创建系统 Actor `system:code-host`（禁用、不能登录、不在成员列表中）。接口契约见 `../docs/CODE_HOST_CONTRACT.md`。

已知边界：不支持 GitLab 与通用 Git 远程、Webhook、一个 Intent 跨多个仓库；GitHub 上的 PR Review 不会导入为平台审批，平台仍是审批权威；信任模式是全平台的，不按项目区分。

## Project Manifest

每个允许 Agent 执行的 Git 基线必须提交 `.aperture/project.json`：

```json
{
  "schemaVersion": "aperture.project.v1",
  "productType": "application",
  "context": {
    "required": ["README.md", "package.json"],
    "allowed": ["README.md", "package.json", "src/app.ts", "test/app.test.ts"]
  },
  "checks": [
    {
      "name": "node-tests",
      "command": ["npm", "test"],
      "timeoutMs": 300000
    },
    {
      "name": "application-build",
      "kind": "build",
      "command": ["npm", "run", "build"],
      "timeoutMs": 300000
    }
  ],
  "artifact": {
    "profile": "application_build",
    "buildCheck": "application-build",
    "outputs": ["dist/app.js"]
  },
  "policy": {
    "maximumRisk": "high",
    "allowUnisolatedRuntime": true
  }
}
```

Control Plane 从 `baseSha` 读取并规范化 Manifest，生成 SHA-256 Digest。Run 声明的 Context 必须包含全部 `required` 路径且不得超出 `allowed`；Work Item 类型、Intent 风险和 Runtime 隔离必须满足 Manifest Policy；Check 命令只使用该基线 Manifest 中的定义。Manifest 路径、基线、Digest 和策略会进入 Run Request、Event Log 与 Evidence Package。`allowUnisolatedRuntime` 只用于当前本地探索，不能使 Process Runtime 获得生产资格。

Application 可以通过 `artifact.profile: application_build` 把 Build Check 与预期输出绑定。Build 成功后，Control Plane 对输出文件记录路径、大小、SHA-256、Source Commit 和生成 Check；声明输出缺失会新增失败门禁。当前只封存 Build Provenance，不持久保存 Artifact Blob，也不代表制品可部署或达到生产资格。契约见 `../docs/APPLICATION_BUILD_PROVENANCE_CONTRACT.md`。

Agent System 必须额外声明版本化 Dataset 和 Metric Threshold，并至少配置一个 `kind: evaluation` 的 Check：

```json
{
  "productType": "agent_system",
  "context": {
    "required": ["README.md"],
    "allowed": ["README.md", "src/agent.ts"]
  },
  "checks": [
    {
      "name": "agent-eval",
      "kind": "evaluation",
      "command": ["node", "evals/run.mjs"],
      "timeoutMs": 300000
    }
  ],
  "evaluation": {
    "profile": "agent_dataset",
    "datasetPath": "evals/dataset.jsonl",
    "harnessPaths": ["evals"],
    "thresholds": [
      { "metric": "task_success_rate", "operator": "gte", "threshold": 0.9 }
    ]
  }
}
```

Dataset 必须存在于 Base Revision，且不能列入 Builder Context。Control Plane 会复验 Dataset Digest，从 Evaluation stdout 读取 `evaluation_metrics`，按阈值生成确定性门禁，并把实际指标与 Threshold Result 封存到 Evidence Package。

「Dataset 没被改」不等于「评分诚实」：评分器也在 Builder 的 worktree 里。`harnessPaths` 声明评分器所在路径，是 evaluation 版的 `testPaths`：

- Run 没改这些路径 → Evaluation 结论为 `pre_existing`（评分器取自 Base）；
- Run 改了 → 头版本结论不可信，另跑一次 `<name>@baseline`，评分器重置回 Base、被测代码留在 Head；
- 未声明 `harnessPaths` → Run 可能改过评分器，结论同样只算自评；
- 同一指标在 stdout 里出现两个不同的值（被测代码在评分器之后自己打印一个满分）→ 该 Check 失败，而不是"最后一个算数"；
- Dataset 里长度 ≥ 12 的字符串值（JSON 叶子，非 JSON 则整行）原样或 JSON 转义后出现在 Run 新增的行里（Dataset 文件本身除外）→ `evaluation-dataset-leakage` 失败。它和 `evaluation-dataset-integrity` 一起并入该标准的映射检查，任一失败即标准"证据失败"（推翻不了成"自评"）。Builder 读了 worktree 里的 Dataset 并把答案写成查表，评分器再诚实也只是在考它抄的答案。Check 输出只记录命中值的 Digest 与文件，不外泄 Dataset。

**本地 Runtime 下没有任何 Evaluation 结论是独立证据。** 评分器把被测代码导入自己的进程，Dataset 就在 worktree 里：被测代码可以在运行时读取 Dataset 直接答题（不留任何拷贝，泄漏检测看不见），也可以篡改评分器的输出。所以即便评分器取自 Base、Dataset 完好、没有泄漏，关键 `[模型]` 标准也只是 `self_graded`（界面显示"评测未隔离"），阻塞批准，需要 Owner 看过变更后带理由推翻（`decision.override_recorded`）。上面这些检查的作用是把能自动识别的作弊变成"证据失败"，而不是证明分数可信。要让 Evaluation 成为独立证据，需要隔离的评估器：被测代码在拿不到 Dataset 的沙箱里运行，由外部评分；目前没有。泄漏检测只认原样拷贝，改写、拆分、编码后的答案或短答案识别不出来。契约见 `../docs/AGENT_SYSTEM_EVALUATION_CONTRACT.md`。

Change Proposal 获得独立批准后，只有 Owner 或 Maintainer 可以显式执行本地 fast-forward 合并。Control Plane 会复验 Base、Approved Head、Check、Evidence 和 Approval，要求实际目标分支 SHA 精确等于 Approved Head SHA，再生成不可更新、不可删除并带 Digest 的 Merge Evidence。合并前还会重算该 Proposal 以及产出其证据的每个 Run 的事件哈希链；有一条对不上（例如绕过平台直接 INSERT 进来的伪造批准事件）就拒绝合并（`event_chain_broken`），且在目标分支移动之前拒绝。整条链从 genesis 重算一遍也能自洽，所以还要求每个 Evidence Package 生成时记录的链头（`eventChainHeads`，写入证据摘要和 `evidence.recorded` 事件，外部附加的证据取自包文件）仍在当前链上；Merge Evidence 读取时同样核对其 `proposalEventChainHead`（`merge_evidence_chain_mismatch`）。`host_protected` 模式下合并已经发生，链校验失败会作为绕过门禁的原因记录。契约见 `../docs/MERGE_EVIDENCE_CONTRACT.md`。该能力不是自动合并，也不代表发布授权。

Reviewer 请求修改后，Proposal 作者或 Owner/Maintainer 可以启动 Agent Revision Run。新 Run 从被审查 Head SHA 开始，绑定当前 Reviewer Feedback，沿用原始基线 Manifest；完成后更新同一个 Proposal，并使旧 Review、Check、Evidence 失效。契约见 `../docs/AGENT_REVISION_RUN_CONTRACT.md`。

Merged Proposal 可以生成本地 Release Candidate。当前候选只封存 Commit、Source Tree Digest、文件数、Merge Evidence Binding 和 Candidate Content Digest，并要求不同的 Owner/Maintainer 批准。契约见 `../docs/RELEASE_CANDIDATE_CONTRACT.md`。它不是二进制 Artifact、Deployment 或生产发布证明。

访问 `http://127.0.0.1:8787`。首次访问时创建本地 Owner；系统没有默认密码。SQLite 数据库保存在 `.aperture/control-plane.db`，本地 Git 仓库保存真实代码版本。

开发模式需要两个终端：

```bash
npm run server:dev
npm run dev
```

`npm run dev` 单独启动时只提供 Lab / Mock UI，不具备 SQLite 身份、Intent、Change Proposal Review 和 Event Log 的服务端控制边界。

完整检查：

```bash
npm run check
```

交互与响应式验收清单见 `QA.md`。

其中：

- `npm run check:legibility` 校验 `src/styles.css` 的字号下限、文字对比度、控件边框对比度和 token 完整性（见"可读性约束"）；
- `npm run test:criteria-gate` 验证逐条验收标准门禁：无可映射检查的关键模型标准阻塞批准但不阻塞请求修改、低风险无检查时为待证据、`neutral` 视为失败、打包映射识别独立证据，人工标准必须在批准意见里逐条点名 AC 编号、高风险占位人工标准被拒，以及 `verifiedBy` 声明映射与其摘要规范化；
- `npm run test:intent-approval` 验证低风险按规则批准、中风险需非作者批准、新版本取代旧批准，以及被拒绝的 Run 不留下 worktree；
- `npm run test:policy-files` 验证 `.aperture/` 改动被写入提案、事件与 Readiness，批准需要 Owner 与理由，刷新会重新计算标记；
- `npm run test:review-assignment` 验证作者不可被分配、按负载选人、只有被分配人能决策、重新分配需要理由并保留历史、新 Head 重置分配、未展开证据的批准被标记，以及策略改动只分配给 Owner；
- `npm run test:external-identity` 用假 GitHub（校验 Client 凭据、一次性授权码、回调地址和 PKCE）验证：Owner 声明、GitHub 证明、数字 ID 跟随改名并拒绝回收登录名、伪造 / 过期 / 重放的 state 被拒、Team 模式拒绝密码 Session 的决策、切换模式需要 GitHub Session、决策事件冻结身份，以及库文件里没有 Token 和 Client Secret；
- `npm run test:project-scope` 验证项目隔离：非成员看不到也改不了其他项目（404）、同一人在不同项目角色各自生效、审查人只从项目成员中分配、浏览器传入的仓库路径被拒、本地路径校验，以及 019 在旧库上的回填；
- `npm run test:github-code-host` 用假 GitHub API（校验 Bearer Token）加 `file://` 裸仓库验证：配置里拒绝 Token 与带凭据的地址、Token 缺失 / 错误 / 无推送权限时的连接测试、托管克隆跟随远程默认分支、推送平台分支并开 PR、`aperture/gate` 随审批与 readiness 变化、GitHub checks 以系统 Actor 导入并参与 readiness、`github/` 检查名保留、`control_plane` 推送成功以及远程前进 / 分支保护拒绝时回滚、`host_protected` 下 squash 合并记为 `patch_equal`、绕过门禁的合并（未批准、检查失败、PR 被追加提交）被标记、手工提案从远程分支创建、PR 关闭同步为拒绝，以及数据目录里任何文件都不含 Token；
- `npm run test:github-e2e`（手动，不在 `check` 里）对真实 GitHub 仓库跑同样的流程，需要 `APERTURE_GITHUB_TOKEN` 与 `GITHUB_E2E_REPO=owner/repo`。仓库须是可丢弃的测试仓库，并在 `pull_request` 上用 Actions 跑测试。覆盖 GitHub Actions 检查导入、GitHub 上显示的 `aperture/gate`、平台合并推送、远程前进时拒绝并回滚、PR 关闭、`host_protected` 下的 squash 合并和绕过门禁的合并。结果留在 `.aperture-github-e2e/` 供界面查看；
- `npm run test:governance-decisions` 验证 Override 的角色、作者、理由与 Head 绑定，共享检查需要每条依赖标准都推翻，完整性检查不可推翻，以及 Reject 的终局性；
- `npm run test:intent-template` 验证验收标准标注的解析与默认值、模版本身带显式标注且套用后仍被标为待补充、模糊度提示只告警不拦截，以及服务端的枚举校验、高风险人工审批不变量和 `criticality` / `verificationType` 按输入落库并参与 `contentDigest`；
- `npm run test:local-control-plane` 验证 SQLite、Local Authority、真实 Git Revision、Review 失效和追加式 Domain Event Log；
- `npm run test:local-control-plane-http` 验证初始化、登录、成员、Intent、Change Proposal、Check、Evidence、Review 和 Event API 的 HTTP 契约；
- `npm run test:agent-provider` 验证 LLM Provider 设置的 Owner 边界、API Key 只写不读、保留与清除语义，以及模型进入 Agent 进程环境、Runtime Attestation 与 codex `-c` 覆盖；
- `npm run test:store` 验证发布审批和生产信号回流的状态机不变量；
- `npm run test:adapter` 验证 Agent 事件顺序、Workflow/Activity 幂等重试、策略阻断和 Tests + Docs 产物；
- `npm run test:github` 验证 GitHub Issue 读取、投影回写和错误路径；
- `npm run test:ci` 验证 JUnit、SARIF 与 LCOV 的归一化、状态判定和无效报告拒绝；
- `npm run test:evidence` 验证 Evidence Sink 的逐事件摘要链校验、终态封存和无效输入拒绝；
- `npm run test:repository` 验证离线 Evidence Repository 的刷新恢复、重新复验、篡改检测和清理。
- `npm run test:budget` 验证 Token、工具调用、时长与成本的确定性预算判定，以及 Warning/Exceeded 对应的 Checkpoint/Terminate 动作。
- `npm run test:harness` 验证 Harness 候选排名、模型上下文能力权重、预算降级与 Adaptive Context Reset 决策。
- `npm run test:deployment` 验证生产部署必须绑定 Release Candidate、Head SHA、Evidence URI 与外部人类审批身份，并拒绝无权或无证据请求。
- `npm run test:catalog` 验证 Provider ID、Stable Contract、Evidence Boundary、离线部署姿态及关键对标来源完整。
- `npm run test:workflow` 验证 Workflow Request/Event 持久化、重复追加幂等、中断恢复游标、显式 Recover 门禁、完成态与篡改检测。
- `npm run test:attestation` 验证 in-toto Statement、DSSE PAE、ECDSA 签名、Package SHA-256 以及内容、Statement 和 Signature 篡改检测。
- `npm run test:policy` 验证 Policy Bundle、Default Deny、Secrets/External Content 阻断、Egress Allowlist 与 Production Approval 路由。
- `npm run test:evaluation` 验证 Experiment Binding、Dataset Version、Grader Inventory 以及 `pass@k` / `pass^k` 可靠性计算。
- `npm run test:trace` 验证 Run / Activity / Tool / Policy / Evaluation / Usage Span 投影、敏感字段脱敏与 Projection Digest 篡改检测。
- `npm run test:telemetry` 验证本地 OTLP/JSON Bundle、优先 Span 与父链保留、确定性采样、Attribute Allowlist、Resource Binding 和 Export Digest 篡改检测。

在 `Agent Runs` 页面点击“启动 Mock Run”，可验证从 Context 读取、Tool Request、Policy Decision、Artifact、Evaluation 到 Run Complete 的完整事件链。运行详情中的计划进度、边界指标、Transcript 和 Evidence 都由同一事件流派生，不再依赖独立静态数据。

运行过程中可从详情抽屉执行取消；取消会写入 `run_completed(cancelled)` 终态事件。若 Evaluation 存在失败项，Run 完成后进入“等待人工评审”，必须通过具名批准才能进入评审队列。

上下文中心与 Agent Run 共用事件流：`context_requested` 表示访问意图，只有策略允许后才产生 `context_consumed`。被阻断的敏感资源会显示为“已阻断”，不会误计为模型已经读取。Mock Run 还会创建 Code/Test/Docs 三个隔离 `context_scope_created`，把计划、发现和决策写成持久 `context_note_written`，并在 Evaluation 前通过 `context_compacted` 将 62.4K tokens 压缩到 23.8K，同时保留三个 Note 引用。上下文中心和 Transcript 均直接消费这些真实事件。

长任务在 Evaluation 前写入 `checkpoint_saved`。详情抽屉可从该检查点启动新 Run：复用原 Session，绑定新的 Sandbox，产生 `checkpoint_restored`，跳过已完成的工具和产物步骤，仅继续后续 Evaluation 与人工门禁。

页面刷新后，任何缺少 `run_completed` 的持久 Session 会被识别为 `运行已中断`，不会继续伪装成活动 Run，也不能进入审批。若已有 Checkpoint，可先为旧 Run 追加 `cancelled` 终态、封存其 Evidence，再启动恢复 Run；若尚无 Checkpoint，则安全封存旧草稿并从头重启。Repository 可从 Store 中的合法摘要链重建升级前草稿。

Managed Runtime 会通过 `usage_reported` 上报累计 Token、工具调用、时长和估算成本。独立 `RuntimeBudgetGuard` 不依赖模型自我判断：低于 80% 继续，达到预警阈值要求先 Checkpoint，任一上限超出则要求 Terminate 并进入人工门禁。Run 详情、Policy、Transcript 与 Evidence Package 从同一预算事件读取。

运行门禁通过后，Run 自动投影到评审队列；“请求修改 / 批准变更”会写入 Review Decision、通知和追溯账本。批准的变更自动形成 Release Candidate。生产授权同时绑定候选 ID、GitHub Head SHA 与已复验 Evidence Package：PR Head 变化、Review/Check 失败或 Repository 复验失败都会阻断或撤销旧授权。

生产授权完成后，Mock Deployment Provider 才能接收部署请求。请求必须携带 Release Candidate、Production 环境、Head SHA、已验证 Evidence URI 与 `github:*` 审批身份；部署结果记录 Provider、Deployment ID、时间、Artifact Digest 与 Rollback Ref，并进入 Release 环境推进、通知和追溯账本。部署后只有具备 Production 权限的外部人类身份可以按原 Deployment / Candidate / Rollback Ref 执行回滚，结果保留 Rollback ID 与 Restored Artifact Digest。当前 Provider 不连接真实部署系统。

证据中心从当前 Session 事件流聚合 Context、Policy、Artifact、Checkpoint、Evaluation 与 Review 状态。运行期间，每个事件先由 `LocalEvidenceRepository` 校验摘要链再进入 Store；只有合法终态 Run 才会生成 `local://` Package URI 和 Repository Digest。仓库内容独立保存在浏览器本地存储中，刷新后会重新加载事件、验证摘要链并核对包摘要；Run Drawer、证据中心和追溯页共享该复验状态。浏览器导出的 JSON Evidence Package 另带 SHA-256 内容摘要；当前 Repository Digest 仍是 FNV-1a 原型校验和，不是密码学签名，也不是 WORM 存储。

Run 终态封存后，`LocalTraceProvider` 会从已验证事件链生成 OTel 风格的脱敏 Trace Projection。评估页显示真实 Trace ID 与 Span Count，证据中心、追溯页和导出的 Evidence Package 复用同一投影。当前不连接 OpenTelemetry Collector、Langfuse 或 Phoenix；Prompt、Context 内容、Context Resource Path 和 Tool Output 默认不导出。

Trace Explorer 中的 Error 或失败 Evaluation Span 可以由人显式创建 Regression Asset。资产保存 Run ID、Trace ID、Span ID、Projection Digest 与 Event Digest，并在评估抽屉中展示来源；相同 Span 的重复转换保持幂等。Policy Denied 作为预防性控制成功，不会自动转成失败回归。

Trace Explorer 还可通过 `TelemetryExportProvider` 生成受治理的本地 OTLP/JSON Bundle。默认策略采用 metadata-only、25% Routine Sampling，并始终保留 Root、Error、Policy Deny、失败 Evaluation 及父链。导出包保存完整 Policy、源 Projection Digest、Exported/Dropped Count 与 Export Digest；当前不会向 Collector 或任何网络端点发送数据。

Telemetry Bundle 导出仅允许 Owner 与 Maintainer。合法导出会保存操作者身份、时间、Provider、Policy、Destination、文件名、Exported/Dropped Count 与 Export Digest，并进入持久事件账本和 Provenance；Reviewer、Developer、错 Run/Trace/Projection、无效 Bundle 与重复 Digest 均由 Reducer 拒绝。

发布页通过独立 `AutonomyDecisionProvider` 展示 Bounded Autonomy Posture。当前 Phase 固定为 `human_approval`：确定性控制失败返回 `blocked`，中高风险、外部 Egress、破坏性操作、生产影响或身份未锚定返回 `human_review`。未来只有低风险 Repository-only 任务满足全部控制时才可获得 `auto_merge_eligible` 资格，真正合并仍由 Source Provider、Branch Protection 与 Merge Queue 执行。每次不同决定都由 Reducer 重新求值并写入事件账本。

实时 Run 的 Evaluation 失败会进入“需要诊断”，详情直接读取该 Session Transcript。用户可以把聚合失败固化为 Regression，再补充独立 Trial、Fixture、Seed、确定性 Grader 和 Reference Solution。每次执行产生三个带 Batch、Seed、耗时、结果和失败原因的 Trial，并分别计算 `pass@3`（至少一次成功）与 `pass³`（三次全部成功），用可靠性差距识别“偶尔能做对”而非稳定能力。

Evaluation 结果之后会产生 `evaluation_diagnosed`：逐项记录 `agent / task / grader / harness / infrastructure` 归因、置信度、Evidence Refs、Transcript 是否已检查，以及 Eval 环境的 Clean Start、Shared State 与 Image Digest。Evaluation、Release Gate、Transcript 和回流动作消费同一诊断事件；Agent、Task、Grader 失败可固化为 Regression，Harness 与 Infrastructure 失败则创建平台修复 Intent，避免把基础设施噪声错误算成模型能力回归。

Context 事件同时记录来源信任等级和敏感性。Mock Run 会自动阻断未声明 Secrets 与未信任 MCP 内容；Policy 页面从真实决策计算 Environment、Model、External Content 状态，以及自动策略决策与人工门禁的 Approval Load。

Managed Run 在 Runtime Binding 后必须产生 `sandbox_attested`，证明 Sandbox Ref、隔离模式、Workspace Root、读写路径、Egress 模式、允许主机、Secret Mounts、Ephemeral 属性与 Attestor Digest。只有 `verified + ephemeral + 非 unrestricted egress + 0 secret mounts` 才能进入 Harness Selection、规划、Evidence 封存和生产授权。当前 Attestor 仍为本地 Mock，尚未连接真实容器或 VM Runtime。

每个新 Run 在进入 Scoped Execution 前先生成 Work Contract，明确目标、可验证验收标准与非目标，再由独立 Evaluator 确认同一 Contract Digest。生成者自我批准、要求修订或摘要不一致会触发人工门禁；未被独立确认的契约不能获得生产授权。契约提议与评审同时进入 Transcript 和 Evidence Package。

Planner 在 Plan 之前建立带 Digest 的长期 Roadmap，再把当前工作绑定为 Sprint，最后由 Work Contract 固化本次完成定义。Evaluation Diagnosis 之后必须追加 `roadmap_updated`，引用 Transcript / Eval Feedback，更新里程碑并给出下一 Sprint 目标；Managed Run 在诊断后若未更新 Roadmap 就不能合法结束。这样长期状态由追加写规划资产承载，而不是依赖单个会话记忆。

`HarnessPolicy` 不再把 Orchestrator–Workers 固定为唯一答案，而是根据模型的上下文保持能力、独立 Evaluator 要求、成本上限和历史 Eval 结果对候选 Profile 排名。候选 Profile 的可靠性、P95 时延、成本、Reset Policy 与 Evidence Ref，以及最终选择原因，均以 `harness_profile_selected` 进入事件链并展示在 Evaluation 的 Harness Ablation 面板；Context Reset Controller 再按 Token 压力、阶段边界和 Evaluator Feedback 产生 `continue / compact / fresh_session` 确定性决策。当前候选 Eval 仍为 Mock 数据，下一步需接入真实 Harness Ablation 运行。

团队页的 Core 区域使用服务端 Session Actor，不允许在 UI 中任意切换身份。Owner 可创建本地成员；Change Proposal Review 同时由界面和服务端执行权限判断，作者自批会被服务端拒绝。真实 Review 投影记录 Reviewer、角色、Head SHA、决策首响时间与失效时间；同一 Reviewer 改判会使旧决策失效，多人决策冲突时 `changes_requested` 优先。评审队列直接展示待评审数量、最老积压、首个决策中位数、有效/失效决策和活跃 Reviewer。每个当前 Head 还会聚合 Check 与 Evidence Package，Review Event 固化决策使用的 Check ID、Evidence ID 和就绪状态；存在失败或取消的 Check 时，服务端拒绝批准。缺少 Check 或 Evidence 会显示 `incomplete`，但当前阶段仅作为显式风险提示。原型中的 Run Gate 与 Production 演示仍使用 Lab / Mock 身份数据，不能视为真实授权边界。

集成页提供可执行的 Mock GitHub Issue 与 Pull Request Provider。输入 `#142` 或 `#155` 可读取权威 Issue、创建内部 Intent 投影并模拟回写摘要；输入 `#428` 或 `#512` 可同步 PR Head SHA、Review Decision 和 Checks，并回写当前 Run / Evidence 引用。GitHub 继续拥有代码、PR 状态和评审结论的权威；Control Plane 只保存按 Head SHA 绑定的快照与 Evidence 投影。失败 Check 或 Changes Requested 会在状态机层阻断生产授权，Head SHA 变化会撤销旧授权。`npm run test:github` 独立验证读取、回写、幂等和错误路径。

Session 事件使用 `previousEventDigest + eventDigest` 构成追加写摘要链。Reducer 不仅验证序号、前序摘要和事件摘要，还执行运行协议验证：Harness Selection 必须位于 Runtime 与 Plan 之间，Managed Execution 必须等待独立确认的 Work Contract，Contract Digest 必须匹配规范内容，Compaction 必须由先前的 `context_reset_decided(compact)` 授权。摘要链或运行协议任一失败时，Run、Evidence 封存、检查点恢复、人工门禁、评审与发布路径全部阻断。Evidence Package 同时记录链头，并额外提供 SHA-256 包级摘要。

CI Evidence Adapter 会把 JUnit XML、SARIF JSON 和 LCOV 文本归一化为 `ci_evidence_ingested` 事件，保留来源 URI、工具、摘要、状态和内容 Digest。失败报告会像 Evaluation 失败一样触发人工运行门禁；Run Drawer、发布门禁与证据中心均从同一事件读取，不再依赖静态 CI 数字。

## 后续需要的产品资源

进入正式 UI 设计与实现阶段后，以下资料会显著提升准确度：

1. 最终产品名称、Logo 与品牌色偏好。
2. 2–3 个真实 GitHub Issue、PR 和 CI/Evidence 样例，可先脱敏。
3. 团队角色与权限矩阵，例如 Maintainer、Reviewer、Developer。
4. 典型的一次 Agent 任务执行记录，包括上下文、工具和评估结果。
5. 首批用户最常使用的三条工作流及当前耗时。
6. 是否需要同时支持浅色主题，以及目标屏幕分辨率。

首轮信息架构和视觉方向不依赖这些资源，可以先通过原型评审。
