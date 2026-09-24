# Local Development Agent Protocol

日期：2026-09-23  
状态：P1 Container Runtime 已实现；真实引擎与镜像仍需部署环境验证

## 1. 概念边界

平台中的两个 Agent 概念必须分开：

- **Builder Agent**：执行研发任务的外部命令行 Agent；
- **Agent System**：团队正在开发和交付的目标产品之一；另一类目标产品是 Application。

同一个 Builder Agent 既可以开发 Application，也可以开发 Agent System。目标类型记录在 Work Item 上，后续决定 Evaluation Profile，而不是决定使用哪个 Builder Agent。

## 2. 当前执行链路

```text
Intent Version
→ 创建独立 Git Worktree 与 agent/<run-id> Branch
→ 启动服务端配置的外部 Agent 命令
→ 接收最小 JSONL 协议
→ Control Plane 提交真实 Git Commit
→ 创建绑定 Base / Head SHA 的 Change Proposal
→ 写入追加式 Agent Run Event Log
```

浏览器只能提交 Work Item、Intent、仓库、Base Ref 和声明 Context，不能提交任意 Shell 命令。可执行文件和参数必须由服务端运维者配置：

```bash
CONTROL_PLANE_AGENT_EXECUTABLE=/absolute/path/to/agent-wrapper \
CONTROL_PLANE_AGENT_ARGS_JSON='["--non-interactive"]' \
npm run server:start
```

Agent 进程会收到：

- `APERTURE_RUN_REQUEST`：只读请求 JSON 路径，包含 Intent、AC、约束、Worktree 和声明 Context；
- `APERTURE_WORKTREE`：本次运行的独立工作区；进程当前目录也位于该 Worktree。

仓库包含一个 Codex CLI 示例 Adapter：

```bash
CONTROL_PLANE_AGENT_EXECUTABLE="$(command -v node)" \
CONTROL_PLANE_AGENT_ARGS_JSON='["/absolute/path/to/scripts/agents/codex-builder.mjs","/absolute/path/to/codex"]' \
npm run server:start
```

该 Adapter 使用 `codex exec` 的非交互模式、`workspace-write` Sandbox、自动审批复核和 JSONL 输出。模型与 Provider 不在代码中硬编码，可继续通过 Codex 配置或附加参数选择。Process Runtime 仍会被标记为 `degraded / unisolated_process`。

## 3. 当前 Runtime 决策：不依赖虚拟机

2026-09-23 起，个人探索阶段停止把 Docker Desktop、Podman Machine 或其他本地 VM 作为运行前提，也不允许 Control Plane 自动初始化 VM、下载 VM 镜像或拉取 Agent 镜像。

当前默认路线是：

1. 本地 Git Worktree 隔离代码 Revision；
2. 服务端白名单配置 Agent 可执行文件，浏览器不能提交任意 Shell；
3. Process Runtime 明确标记为 `degraded / unisolated_process / unrestricted`；
4. 所有结果进入 Change Proposal，由独立 Reviewer 绑定 Head SHA 审批；
5. 在没有可验证的 OS 级边界前，Run 始终 `productionEligible = false`。

已有 OCI Container Runtime 代码保留为 Lab 参考和协议兼容测试，但不进入当前默认产品路径，不再继续配置 Podman VM。后续如继续强化隔离，优先研究不依赖 VM 的原生 OS Sandbox Adapter；在真实边界完成前，不得把 Process Runtime 冒充生产级 Sandbox。

## 4. 最小输出协议

Agent 可在标准输出中逐行写入 JSON：

```json
{"type":"context_consumed","path":"src/auth/session.ts"}
{"type":"message","summary":"Implemented session expiry validation."}
```

当前 `context_consumed` 是 **Agent Protocol 自报告**。Control Plane 会验证路径仍位于 Worktree、文件存在并记录内容摘要，但无法独立证明进程确实读取过该文件。因此事件明确记录：

```text
reportSource = agent_protocol
independentlyObserved = false
```

在接入独立文件访问审计前，该信息不能作为高保证审计证据。

## 5. App 与 Agent System 的评估分流

| 目标类型 | 最小确定性证据 | 后续重点证据 |
| --- | --- | --- |
| Application | Build、Unit / Integration Test、SARIF、Coverage、运行结果 | 性能、可用性、发布与生产反馈 |
| Agent System | Schema / Contract Test、工具权限、数据集版本、基础回归 | Trace、Grader、可靠性、Prompt / Model / Harness 组合、非确定性统计 |

两类目标共享 Intent、Context、Change、Identity、Review 和 Event Log，只在 Evaluation Profile 和 Evidence Summary 上分流。

## 6. 当前硬限制

- 同步 HTTP 执行，只适合短任务；
- 没有独立观察的 Context Consumption；
- 没有自动运行测试或生成 Evidence Package；
- Worktree 暂时保留，尚未实现回收策略。
- Container Runtime 没有 Secrets Mount；需要凭证的 Agent 必须等待后续 Credential Broker；
- `network none` 只支持完全离线 Agent；外部模型必须等待 Tool Gateway / Egress Proxy，而不是直接开放容器网络。

下一阶段必须增加 Tool Gateway、Credential Broker 和独立 Context Observation，才允许该 Runner 处理真实团队的敏感任务。
