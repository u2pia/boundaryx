# Builder 上下文、工具与 Skills 设计方案（草案 v0.1）

日期：2026-09-26 · 状态：已审查，**不按原样实施**，见 `ADVERSARIAL_REVIEW_2026-09-26_BUILDER_CONTEXT_TOOLS.md`；修订后的 P1（3.7、3.8、`builder.allowShell` 随 `aperture.project.v2` 引入）已实施，3.2、3.3 砍掉。2026-09-29 已把 Skills Catalog 作为 Core 治理面实施：manifest 声明、Revision、文件健康、32 KB 大小检查、内容摘要和只读预览已接入；内置 Chat Builder 支持受控 `load_skill(name)`，Claude Code 的成功 Read 会映射为 Skill 使用事件，事件进入 Run、Decision Brief 与 Evidence Package。当前事件仍来自运行内工具流、不是 OS 级独立观测；Codex 尚无可靠读取事件，不得把目录声明当作 Run 使用证明。 · 适用分支：builder-time-budget

## 1. 背景与目标

Builder（执行 Run 的 AI）现在拿到的上下文只有三样：Intent、manifest 中 `context` 声明的仓库文件、修订时的评审意见。生成 App 或 Agent 时还需要以下能力，本方案补上：

1. Builder 能在 Run 中自己跑项目声明的检查，边做边验证。
2. 可复用的操作步骤（skills），按需加载。
3. 多个项目共用的规范，只维护一份。
4. Intent 能写明"不做什么"和输入输出示例。
5. Builder 使用的工具（MCP 等）要声明、限定范围、留审计记录。

**原则（沿用平台现有做法）**

- 上下文来源必须**可复现**：固定到某个提交，并记录内容哈希。
- 修改上下文要**走评审**：规则、skill、manifest 都在仓库里，通过 PR 修改。
- 事实和自述分开：Builder 自报的内容标为自述，平台观测到的标为观测，评审时两者都能看到。
- Builder 的自检**不算证据**：合并前平台独立执行的检查仍是唯一依据。

## 2. 现状与差距（基于代码核实）

| # | 现状 | 位置 | 问题 |
|---|---|---|---|
| G1 | Claude 引擎只开放 `Read,Write,Edit,Glob,Grep` 这几个工具，提示词明确写着"不能运行命令" | `scripts/agents/claude-builder.mjs:74` | 不能自己跑测试和构建，只能写完后等平台检查 |
| G2 | chat 引擎的 `run_command` 可以执行任意 shell，只拦截了会改 Git 状态的命令 | `scripts/agents/chat-builder.mjs:153` | 权限过宽；在未隔离运行时下能读到工作目录外的文件 |
| G3 | "实际读取"只记录 wrapper 主动注入的声明文件；Claude Code 用 Read 工具读了什么，没有记录 | `claude-builder.mjs:18-27`、`git-worktree-agent-runner.ts:227` | 上下文对账对 Claude 引擎等于自证，看不出未声明的读取 |
| G4 | Claude Code 会自动加载仓库里的 `CLAUDE.md`、`.claude/skills` 等 | 引擎行为 | 不进入对账；换成 chat 或 codex 引擎后行为又不一样 |
| G5 | manifest 只能声明本仓库的文件 | `project-manifest.ts` | 共享规范只能在每个仓库各复制一份 |
| G6 | Intent 只有 goal、constraints、acceptanceCriteria 三类内容 | `types.ts` | 没法写"不做什么"和输入输出示例 |
| G7 | manifest 解析器会忽略未知字段 | `parseManifest` | 新增字段向后兼容；但旧版本服务器会静默忽略它们，包括权限类字段 |

## 3. 总体设计

### 3.1 manifest 扩展（全部可选，`schemaVersion` 不变）

> 审查后修订（M3）：权限类字段必须随 `aperture.project.v2` 引入。已实施的只有 `builder.allowShell`（默认 false）。

```json
{
  "schemaVersion": "aperture.project.v1",
  "builder": {
    "runnableChecks": ["node-tests", "application-build"],
    "maxCheckRuns": 12
  },
  "skills": [
    { "name": "add-validation-rule", "path": ".aperture/skills/add-validation-rule.md",
      "description": "给 KYC 输入新增一条格式校验：规则、错误信息、测试的写法" }
  ],
  "sharedContext": [
    { "repository": "u2pia/engineering-standards", "commit": "<40 位 SHA>",
      "paths": ["security/baseline.md", "typescript/style.md"], "required": true }
  ],
  "tools": [
    { "name": "kyc-regulations", "server": "kyc-regulations", "allow": ["search", "read"] }
  ]
}
```

- **权限类字段**（`builder`、`tools`）遇到当前版本不支持的字段时，服务器必须**拒绝启动 Run**，不能静默忽略（解决 G7）。
- 所有新增内容都算进 manifest 的哈希，按 Run 的 base commit 读取，所以 Run 期间修改 manifest 不会生效（沿用现有的 `project_manifest_drift` 检查）。

### 3.2 平台工具服务（aperture-tools）

Run 期间，平台为 Builder 提供一个本地 MCP 服务，通过 stdio 连接，由 wrapper 启动。所有平台提供的工具都从这里走：

| 工具 | 作用 | 审计事件 |
|---|---|---|
| `run_check(name)` | 按 manifest 中定义的参数原样执行检查，不经过 shell | `agent_run.builder_check_ran` |
| `load_skill(name)` | 返回 skill 的全文 | `agent_run.context_consumed`（`kind: skill`） |
| `read_shared_context(path)` | 读取共享上下文中的文件 | `agent_run.context_consumed`（`kind: shared`） |

- Claude 引擎：通过 `--mcp-config` 接入，`--allowedTools` 在原有列表上增加 `mcp__aperture__*`，**不开放 Bash**。
- chat 引擎：同样三个工具以 function 的形式提供。`run_command` 改为由 manifest 控制，默认关闭，见 3.3。
- codex 引擎：通过 MCP 接入，另开任务确认兼容性。

每次工具调用由服务本身记录，写到 Run 目录下的 `tool-calls.jsonl`，而不是通过 Builder 的 stdout 协议上报。Run 结束后由 runner 读取并写入事件。这样记录来自平台代码，Builder 无法伪造。

### 3.3 Builder 运行检查（解决 G1、G2）

- 只能运行 `builder.runnableChecks` 中列出、且 `kind` 为 `test` 或 `build` 的检查。**`evaluation` 类检查永远不开放**，防止 Builder 反复试探评估结果。
- 执行环境与平台正式检查相同：只传 `PATH`、`HOME`、`CI`、`NO_COLOR` 这几个环境变量。配置了隐藏评估数据集时，同样用 Seatbelt 禁止读取数据目录。
- 次数受 `maxCheckRuns` 限制，时间计入 Run 的总时间预算，超时的检查直接终止。
- 返回给 Builder 的输出截断为 12 KB，事件中只记录输出的哈希。
- **这些结果不进入证据包，也不影响门禁**。评审界面会单独显示"Builder 自检 N 次，最后一次通过或失败"，作为参考。
- chat 引擎的 `run_command` 改为 `builder.allowShell: true` 时才开放，默认关闭。现有项目的迁移方式见第 6 节。

### 3.4 Skills（解决 G4 的一部分）

- 位置：仓库内 `.aperture/skills/<name>.md`，在 manifest 中声明。
- 内容：纯文本的操作步骤，v1 **不执行任何脚本**。
- 提示词里只放 skill 列表（名称和描述，每条不超过 200 字），全文通过 `load_skill` 按需加载。
- 单个 skill 不超过 32 KB；每次 Run 加载的 skill、注入的上下文、共享上下文，合计共用 200 KB 预算。
- 对账时新增一类"已加载 skill"，显示名称、提交、哈希。
- **为什么不用 Claude Code 自带的 `.claude/skills`**：它只在 Claude 引擎里有效，而且加载过程不可审计。项目上下文面板会把仓库中的 `.claude/skills` 和 `CLAUDE.md` 一起标成"未声明的指令文件"。wrapper 以 `--setting-sources` 等方式尽量不让引擎自动加载项目设置；做不到时，在 Run 的证据中明确记录"引擎可能自动加载了以下文件"。

### 3.5 共享上下文（解决 G5）

- manifest 中引用其他仓库时，**必须写 40 位的提交 SHA**，不接受分支名。这样每次 Run 可复现，更新规范也需要在本项目里提交一次改动、经过评审。
- 平台用服务端 token 拉取到 `.aperture-live/context-cache/<owner>/<repo>.git`，只读取声明的路径。
- `required: true` 的文件像本仓库的必需文件一样直接注入；其余通过 `read_shared_context` 按需读取。
- 项目上下文面板显示来源仓库和提交；如果来源仓库的默认分支有更新，提示"有新版本"，但不会自动升级。
- 权限：拉取失败，或 token 无权访问来源仓库时，拒绝启动 Run（`shared_context_unavailable`）。

### 3.6 外部工具（MCP 服务）

- 外部 MCP 服务由 Owner 在「集成」页登记：名称、启动命令、所需密钥所在的环境变量名、是否需要联网。**manifest 只能按名称引用**已登记的服务，不能写启动命令或密钥。
- manifest 中的 `allow` 列出允许调用的工具名，其余一律拒绝。
- 调用由 aperture-tools 转发并记录：`agent_run.tool_called { server, tool, argsDigest, resultDigest, durationMs, decision }`。
- 容器运行时禁止联网（`--network none`），需要联网的服务 v1 只在未隔离运行时下开放，运行证明中记录 `externalTools: [...]`。
- 这一项风险最高，放在最后一期。

### 3.7 观测 Claude 引擎的实际读取（解决 G3）

- wrapper 解析 Claude Code 的 `stream-json` 输出，遇到 `Read` 的 `tool_use`，记录 `context_consumed { reportSource: 'engine_stream', declared }`；遇到 `Grep` 和 `Glob`，记录 `context_searched { pattern }`。
- 这仍然是在 Builder 同一台机器上的观测，所以标记 `independentlyObserved: false`。但它来自引擎的事件流，不是模型自己的说法，比现在强。
- 对账界面区分"平台注入"和"引擎读取"，未声明的读取会高亮显示。

### 3.8 Intent 增加两个字段（解决 G6）

- `nonGoals: string[]`：明确不做什么，比如"不修改 `bankAiCases.ts`""不引入依赖"。
- `examples: { input: string; expected: string }[]`：输入输出示例。
- 两者都计入 Intent 的内容哈希，批准 Intent 即表示批准了它们，并写入 Builder 的提示词。
- 示例**不会自动变成验收标准**。需要强制的，仍要写成验收标准并配测试。

## 4. 审计与界面

| 界面 | 新增内容 |
|---|---|
| 项目上下文面板 | skills、共享上下文、工具列表及其健康检查（SHA 固定、文件是否存在、大小预算、是否有新版本） |
| Run 的上下文对账 | 平台注入 / 引擎读取 / 已加载 skill / 共享上下文 / 工具调用 / Builder 自检，每一项都带哈希 |
| 评审队列 | Builder 自检结果（仅供参考）；提案改动了 `.aperture/` 目录时高亮提示 |
| 证据包 | 记录本次 Run 实际使用的 skill、共享上下文（仓库和提交）、工具调用摘要 |

## 5. 分期

| 期 | 内容 | 规模 |
|---|---|---|
| P1 | 3.7 观测实际读取、3.3 Builder 运行检查（含 aperture-tools 的最小实现）、3.8 Intent 字段 | 中 |
| P2 | 3.4 skills | 小 |
| P3 | 3.5 共享上下文 | 中 |
| P4 | 3.6 外部工具 | 大 |

## 6. 兼容与迁移

- 所有新增字段都可选；不写就和现在一样，唯一例外是 chat 引擎的 `run_command`。
- chat 引擎的 `run_command` 从"默认开放"变为"默认关闭"，这是**行为变更**。迁移方式：发布时，平台对已有项目在项目上下文面板中提示"本项目的 chat 引擎将失去 shell 权限，如需保留请在 manifest 中加 `builder.allowShell: true`"，过渡期为一个版本。
- 旧版本服务器会忽略新字段。所以新字段中的权限类配置只能**收紧**权限，放宽权限的配置（`allowShell`、`tools`）必须在新版本服务器上才生效。

## 7. 待决问题

1. `run_check` 是否允许 Builder 传参数，比如只跑某个测试文件？v1 倾向不允许。
2. skill 放在 `.aperture/skills/` 下，还是兼容社区的 `SKILL.md` 目录格式？
3. 共享上下文仓库是否要求在平台登记为项目，以便复用成员权限？
4. Builder 自检失败次数是否要作为评审提示，比如"自检 12 次全部失败"？
