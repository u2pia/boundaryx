# 对抗性审查：Builder 上下文、工具与 Skills 设计（v0.1）

日期：2026-09-26 · 审查对象：`docs/BUILDER_CONTEXT_TOOLS_SKILLS_DESIGN.md` v0.1

审查方式：独立审查 agent 对照代码逐条挑错，作者再逐条核实。标"已核实"的项，作者已对照代码确认；标"推断"的项，未实际复现。

## 结论

**v0.1 不能按原样实施。** 核心问题是方案里的 `run_check` 名义上"不开放 Bash"，实际上让 Builder 能以宿主权限执行它自己写的代码，并把输出拿回模型。这就在 Run 中间开了一条交互式的数据泄露通道。

审查还发现了几个与本方案无关、**现在就存在**的问题，应当先修：H2、M4、M5。

## 第 2 节事实核对

| 项 | 结论 | 补充 |
|---|---|---|
| G1 | 正确 | codex 引擎在自己的沙箱里本来就能跑命令（`codex-builder.mjs:68`），所以"跑不了测试"只对 Claude 成立 |
| G2 | 正确，但说轻了 | 拦截 git 的正则可以被 `git -C . commit`、`g""it` 这类写法绕过 |
| G3 | 正确 | chat 引擎的 `read_file` 已经会上报读取。另外，digest 是在 Run 结束后对文件的**最终内容**算的，不是读取当时的内容（`git-worktree-agent-runner.ts:335`） |
| G4 | 部分正确 | 漏了用户级配置：Builder 继承运维人员的 `HOME`，`~/.claude` 下的 hooks、plugins、MCP 配置、CLAUDE.md 也会带进 Run |
| G5 | 正确 | — |
| G6 | 正确 | — |
| G7 | 正确，影响更大 | digest 是对解析后的对象算的，旧服务器上新字段不计入 digest。3.1 把"Run 期间改 manifest 不生效"归功于 drift 检查，这不对：真正起作用的是 manifest 通过 `git show baseSha` 读取 |

## 发现

### 高

**H1 `run_check` 等于给了 Claude Bash，输出还会回到模型**（推断，依据代码路径）
- Builder 可以写一个测试文件，让它读 `~/.ssh`、控制面数据库或封印密钥，再把内容打印出来。检查命令（`npm test`）会执行这个文件，输出最多 12 KB 返回给模型，于是内容进入第三方 LLM。
- 没有配置隐藏评估数据集的项目，检查完全不加 Seatbelt（`local-run-postprocessor.ts:310`）。
- 赛后检查的输出只进证据包，Builder 看不到；中途检查把它变成了交互式的通道。
- 修改：v1 不开放 `run_check`。以后要开放，前提是容器运行时，或者强制 Seatbelt，拒绝数据目录、密钥、`$HOME` 下的凭据目录，并禁止联网。

**H2 沙箱内的代码可以通过 Git 公共目录，在控制面进程里执行**（已核实，**现有漏洞**）
- Seatbelt 放行了 Git 公共目录的读写（`local-command-agent-runner.ts:51`、`local-run-postprocessor.ts:313`），平台调用 git 时也没有禁用 hooks 和 fsmonitor。
- 沙箱内的代码可以写 `.git/hooks/*`，或在公共 config 里设 `core.fsmonitor` / `core.hooksPath`。之后平台执行 `git status` / `git commit` 时，这段代码会在控制面进程里运行，拿到完整的环境变量（包括 GitHub token）和数据目录。
- 今天 chat 引擎的 `run_command`，以及正式检查中执行的 head 代码，都能走这条路。
- 修改：平台所有 git 调用统一加 `-c core.hooksPath=/dev/null -c core.fsmonitor=false`。Seatbelt 对公共目录只放行 `worktrees/<id>` 的写权限。

**H3 "evaluation 类检查永远不开放"做不到**（推断）
- `node-tests` 会按 glob 收集测试文件。Builder 新写一个测试，在里面调用 grader、读取仓库内的数据集并打印指标，就能在 Run 中反复试探评估结果。
- 修改：数据集放在仓库内的 agent_system 项目禁用 `run_check`；或者 `run_check` 只跑 base 版本的 `testPaths`。

**H4 "平台记录、Builder 无法伪造"不成立**（推断，依据代码路径）
- `tool-calls.jsonl` 写在 Run 目录下，而这个目录正是 Seatbelt 放行的范围，同一个 uid 可以改写它。
- stdio 形式的 MCP 服务由 Claude Code 拉起，不是 wrapper，所以会继承 Claude 的环境变量，包括 `ANTHROPIC_API_KEY`。
- 容器运行时只挂载了工作区，日志只能写进 `/workspace`，然后会被 `git add -A` 提交进提案。
- 修改：工具服务放到 Builder 的信任边界之外，由 runner 托管（例如 unix socket），记录直接写数据库。在做到之前，所有这类记录一律标为 Builder 侧的自述。

### 中

**M1 中途执行的检查破坏了"holdout 最先运行"的前提**（推断）
- postprocessor 依赖"head 代码还没执行过"（`local-run-postprocessor.ts:129`）。
- 中途检查可以留下常驻子进程：`spawnSync` 超时只杀直接子进程，runner 超时只杀 wrapper。这个进程可以在评估时改写 grader，或在 baseline 重跑时把测试文件换回 head 版本。
- 修改：按进程组终止；进入 postprocess 前确认 Run 的进程树已经清空。这一条对现有的 chat `run_command` 同样适用。

**M2 中途 build 的产物会被提交进提案**（已核实：`git add -A`，`git-worktree-agent-runner.ts:236`）
- 没被 gitignore 的构建输出、覆盖率报告、缓存都会进入 head。
- 修改：提交前清理检查产物，或者只提交 Builder 写过的文件。

**M3 兼容规则方向写反了**（已核实：`project-manifest.ts:115` 会拒绝不认识的 `schemaVersion`）
- 旧服务器忽略新字段时，被悄悄丢掉的是"收紧"类配置；"放宽"类配置被忽略反而是安全的。
- 修改：只要新增权限类字段，就把 `schemaVersion` 升到 `aperture.project.v2`，旧服务器会直接拒绝。

**M4 修订 Run 注入的上下文来自未经评审的 head**（已核实，**现有问题**）
- 修订 Run 的工作区从上一次提案的 head 开始（`git-worktree-agent-runner.ts:148`），wrapper 从工作区读取声明的上下文（`claude-builder.mjs:19-23`）。上一轮 Builder 改过的规则文件，会被当作"声明上下文"注入。
- `.aperture/` 改动需要 Owner 审批（`database.ts:1174-1177`），但这只管合并，不管修订 Run。
- 修改：上下文、skill、共享上下文一律从 `git show baseSha:<path>` 读取，由 runner 写进 `request.json`，不再由 wrapper 从工作区读。

**M5 预算按字符截断、按字节计数，截断后还记成完整读取**（已核实，**现有问题**）
- 三个 wrapper 都按字符截断（`.slice`），却按字节累加。中文内容一个字符约 3 字节，第一个文件就能注入约 600 KB，还可能切断代理对。
- 截断后仍然记录 `context_consumed`，而 digest 是对整个文件算的，对账会显示"完整读取"。超出预算的 required 文件被静默跳过。
- 修改：按字节截断；事件中记录 `truncatedAt` 和实际注入部分的 digest；required 内容超出预算时拒绝启动 Run。

**M6 观测 stream-json 有盲区**（推断）
- `Grep` 在 content 模式下会直接返回文件内容，却被记成"搜索"。
- Read 带 offset/limit 时只读了一部分；被拒绝的 tool_use 也会被当成已读；子 agent（Task）的调用可能看不到。
- 修改：以 `tool_result` 为准；Grep 的 content 模式也算读取；记录读取的范围。

### 低

**L1 共享上下文的保密性和可用性没有设计**
- 服务端 token 可能能读到项目成员无权看的仓库，私有规范可能进入 LLM，甚至进入公开 PR。被固定的 SHA 在 force-push 或 GC 后可能消失。
- 修改：只允许已登记为项目、且成员集合相容的来源仓库；缓存按 SHA 永久保留。

**L2 迁移过渡期**
- 一个版本的过渡期对单一试点意义不大。直接默认关闭 shell，试点项目需要时手动加 `allowShell`。

## 待验证（涉及 Claude Code 引擎行为）

- `--allowedTools` 是**自动批准列表，不是限制列表**。不需要审批的工具（Task、TodoWrite 等）可能仍然可用；要真正限制，可能需要 `--tools` / `--disallowedTools`。另外 `configuredArgs` 排在后面，可能覆盖前面的参数。
- `--setting-sources` 是否能同时阻止 CLAUDE.md 和 skills 的自动加载；用户级 hooks 需要另外处理。`--strict-mcp-config` 可以阻止加载项目和用户的 MCP 配置。
- Claude 的 Read/Write 在 `--print` 模式下能否访问工作区之外的绝对路径。

## 对方案的修订建议

**先修现有问题（与新功能无关，建议立即做）**
1. H2：git 调用禁用 hooks 和 fsmonitor；Git 公共目录收窄写权限。
2. M4：上下文改为从 `baseSha` 读取，由 runner 注入。
3. M5：按字节计算预算，记录截断，required 超预算时拒绝启动 Run。
4. Claude 引擎启动参数加固：`--strict-mcp-config`、`--setting-sources`，并隔离 `HOME` / `CLAUDE_CONFIG_DIR`。先核实上面"待验证"中的参数行为。

**新功能的 P1 调整为**
- 保留：3.8 Intent 字段（`nonGoals`、`examples`）；3.7 引擎读取观测，按 M6 修正。
- 砍掉：3.3 `run_check` 和 3.2 aperture-tools，等 H1、H3、H4、M1 有了隔离方案再议。chat 引擎的 `run_command` 按 L2 改为默认关闭。
- 前置条件：任何权限类字段都随 `schemaVersion` v2 一起引入（M3）。

**后移**
- 3.4 skills 可以放 P2，但必须从 `baseSha` 读取（M4），并计入按字节的预算（M5）。
- 3.5 共享上下文、3.6 外部 MCP：试点只有一个 KYC 仓库，没有需求，等有第二个项目时再做。

## 实施记录（2026-09-26，分支 builder-time-budget）

| 项 | 状态 | 落点 |
|---|---|---|
| H2 | 已修 | `server/worktree-git.ts`：控制面的所有 git 调用带 `core.hooksPath=/dev/null`、`core.fsmonitor=false`；worktree 上的 git 走仓库登记的 Git 目录（`--git-dir`、`GIT_COMMON_DIR`），不读 worktree 的 `.git` 文件，不读全局和系统配置；`commondir` 被改写时 Run 失败（`worktree_git_tampered`）。Seatbelt 下 Git 公共目录只读。测试：`test:git-escalation` |
| M4 | 已修 | `server/declared-context.ts`：上下文由 runner 从 `baseSha` 编译并写进 request.json，引擎包装脚本不再读 worktree；记为 `reportSource: control_plane_injection`、`independentlyObserved: true`。测试：`test:declared-context`、`test:local-control-plane-http`（修订 Run 拿到的是 base 版本，不是上一轮 Builder 改写后的） |
| M5 | 已修 | 预算 200 000 UTF-8 字节，按字符边界截断，记录 `truncatedAt`、注入部分的摘要；required 缺失或超预算返回 422 `required_context_missing` / `required_context_over_budget`；可选文件被截断或记为 `omitted`（`budget` / `missing`）。上下文抽屉分开显示平台注入和 Builder 上报 |
| M6 / 3.7 | 已做 | `scripts/agents/claude-builder.mjs`：以 `tool_result` 为准，`is_error` 或没有结果的调用不算读取；Read 记录 `offset` / `limit`；Grep 只有 `output_mode: content` 算读取，搜索目录记为 `searchedDirectory`；重复读取去重；工作区外的路径由 runner 记为 `context_rejected`。来源记为 `engine_stream`，仍是未独立观测 |
| 3.8 | 已做 | Intent 增加 `nonGoals`、`examples`（迁移 026）；只在非空时进入 canonical，旧 Intent 的摘要不变；进入 Builder 提示词、证据包和界面 |
| M3 / L2 | 已做 | manifest 支持 `aperture.project.v2`，新增 `builder.allowShell`（仅 v2；v1 写了会被拒绝；未知键被拒绝；v2 默认值写入解析结果，因此进入摘要）。chat 引擎没有 `allowShell` 时不提供、不提及、也不执行 `run_command`，没有过渡期。项目上下文面板显示 chat 引擎是否有 shell。测试：`test:project-manifest`、`test:chat-builder` |
| Claude 参数加固 | 已做 | `--setting-sources user --settings '{"disableAllHooks":true}' --strict-mcp-config --tools Read,Write,Edit,Glob,Grep --allowedTools 同上 --disallowedTools mcp__* --disable-slash-commands`，环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。配置参数里出现任何一个加固相关参数（含 `--permission-mode`、`--dangerously-skip-permissions`、`--add-dir`、`--mcp-config`、`--plugin-dir`、`--agents`、`--bare`、`--safe-mode`、`--restricted`）时拒绝启动（exit 2），不依赖参数顺序。测试：`test:codex-wrapper` |
| 3.2 / 3.3 | 砍掉 | 按本审查建议暂不做 |

### 残余风险

- **未隔离运行时**：Builder 或检查不在 Seatbelt / 容器里运行时，拥有控制面进程所属用户的全部权限，可以改写 Git 公共目录、`commondir` 以外的一切（`commondir` 被改写会被发现并拒绝）。只有 `policy.allowUnisolatedRuntime: true` 的项目允许这种运行时。
- **Seatbelt 下仍可写 `$HOME`**：沙箱只收窄了数据目录和 Git 公共目录；`~/.gitconfig` 等可被改写。控制面的 git 调用已不读全局配置，但同一用户的其他程序会读。
- **本地项目的主检出目录可写**：`codeHost: local` 的项目，仓库工作目录本身不在只读列表里。
- **Claude 用户级配置仍会加载**：`--setting-sources user` 保留了 `~/.claude/settings.json`（网关和凭据在这里），因此用户级 `CLAUDE.md`、用户 skills 仍可能进入 Claude 的上下文；自动记忆已用环境变量关闭；用户级 hooks 被 `disableAllHooks` 关闭。没有隔离 `HOME` / `CLAUDE_CONFIG_DIR`，因为那样会丢掉网关配置；运行控制面的账号应当保持干净的 `~/.claude`。
- **参数语义来自官方文档，未经实机验证**：Claude Code 2.1.282 下 `--setting-sources user` 是否确实不加载项目 `CLAUDE.md` 和 `.claude/skills`、`--tools` 是否确实移除 Task 等工具，没有在真实引擎上验证。项目上下文面板因此仍把根目录的 `CLAUDE.md` 标为"可能被自动读取"。
- **读取观测仍是自报**：`engine_stream` 来自引擎自己的输出，由包装脚本在 Run 内转写；子 agent 的读取、以及 Glob 列出的文件名不计入。工作区外的绝对路径读取只被记录和拒绝入账，并不被阻止（Seatbelt 下被拒绝的目录除外）。
