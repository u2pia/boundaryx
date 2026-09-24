# Code Host Contract

> 版本：`aperture.code-host.v1`  
> 日期：2026-09-24  
> 范围：本地 Git 与 GitHub（含 Enterprise）；轮询同步；一个项目对应一个仓库

## 目标

Code Host 是项目仓库所在的地方。控制平面始终是 Intent、门禁、审查和 Merge Evidence 的权威；托管方只负责三件事：存放代码、展示 Pull Request，以及在 `host_protected` 模式下按自己的分支保护执行合并。

所有托管方都要给 Runner 和 Authority 提供同一种东西：一个本地 Git 目录。这样 Runner 和门禁逻辑不需要按托管方写分支。

```text
Project ──► codeHostFor(project) ──► CodeHost
                                      ├─ workingRepository()   Run / Merge 操作的本地 Git 目录
                                      ├─ prepareForRun()       同步默认分支
                                      ├─ publishMerge()        control_plane 模式：推送平台合并结果
                                      ├─ publishProposal?()    推分支 + 开/更新 PR
                                      └─ testConnection()      只返回布尔与缺失权限名
```

## 接口

实现位于 `workbench/server/code-host/types.ts`。

| 成员 | 约定 |
| --- | --- |
| `descriptor` | `provider`、`repository`（本地是绝对路径，GitHub 是 `owner/repo`）、`mergeMode`，可选 `webUrl`。 |
| `workingRepository()` | 返回本地 Git 目录；没有配置仓库时抛 `project_repository_unconfigured`。 |
| `prepareForRun()` | 在 Run 被接纳、提案被创建或刷新之前，让默认分支与托管方一致。本地实现什么都不做。 |
| `ensureRef?(ref, refresh?)` | 把托管方上已有的分支取到本地，用于从远程分支手工创建提案。 |
| `publishMerge({ baseRef, baseShaBefore, mergedSha })` | 平台已在本地 fast-forward 后调用。发布失败必须抛错，Authority 会把本地 ref 回滚，保证平台和托管方不出现分歧。 |
| `publishProposal?({ proposal, title, body, externalId? })` | 推送提案 head 并开或更新 PR，返回 `{ externalId, url, publishedRef, headShaPublished }`。没有 PR 概念的托管方不实现。 |
| `testConnection()` | 返回 `{ ok, repositoryReachable, defaultBranchFound, credentialPresent, missingPermissions, message }`，其中永远不能出现凭据或托管方的原始响应。 |

### 注册与配置校验

`workbench/server/code-host/index.ts` 为每种托管方维护两样东西：

- 工厂 `CodeHostFactory(project, { dataDirectory, env })`；
- 规范化函数 `normalize(input, { dataDirectory, projectId })`：在创建或配置项目时校验输入，返回 `{ codeHost, codeHostConfig, repositoryPath, defaultBranch, mergeMode }`。

新增托管方时调用 `registerCodeHost(kind, factory, normalize)`，并在迁移里扩展 `projects.code_host` 的 CHECK 约束。`normalizeProjectHost` 会先统一校验默认分支名，再交给各托管方。托管方不支持的合并方式必须在规范化阶段拒绝，错误码为 `merge_mode_unsupported`；例如本地仓库只能是 `control_plane`。

`resolveProjectRepository(database, projectId, requestedPath?)` 是 Run 与提案唯一的仓库来源。浏览器不再提交路径；内部调用方如果带了路径，这个路径必须就是项目仓库，否则返回 `repository_project_mismatch`。

## 凭据规则

- 项目配置里只保存环境变量名（`tokenEnv`），不保存 Token 本身。每次使用时从服务进程环境中读取；变量缺失时返回 `code_host_credential_missing`。
- Git 通过 `GIT_CONFIG_COUNT / GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0` 环境变量注入 `http.extraheader`，并且只对 http(s) 远程注入。Token 不进入 argv、`.git/config`、数据库、日志、Evidence 或浏览器。设置 `GIT_TERMINAL_PROMPT=0`。
- API 调用使用 `Authorization: Bearer`。错误信息只写状态码和变量名。
- Run 的 Worker 从不持有托管凭据。推送、开 PR 和同步都由主进程的同步器完成。
- 规范化阶段只接受环境变量名格式 `^[A-Z_][A-Z0-9_]*$`，错误码为 `invalid_token_env`。Token 本身（如 `ghp_…`、`github_pat_…`）含小写字母，粘贴进来会被拒绝。

## 同步器

实现位于 `workbench/server/code-host/syncer.ts`。同步器用轮询：服务默认监听 loopback，托管方打不进来，所以不用 Webhook。

- 触发方式有三种：
  - 定时轮询，默认 30 秒，由 `CONTROL_PLANE_CODE_HOST_SYNC_SECONDS` 控制，设为 `0` 关闭；
  - 手动调用 `POST /api/projects/:id/sync`，限 Owner / Maintainer；
  - 审批等决策发生后的 `nudge`。
- 同一项目同一时刻只跑一次同步；并发调用方等待正在进行的那一次。
- 每一轮依次处理：
  1. `prepareForRun()`；
  2. 对每个可同步的提案：head 变化时重新发布 PR；
  3. 读取 PR 状态，识别已合并或已关闭；
  4. 导入检查；
  5. 当门禁状态、描述或 head 变化时回写 `aperture/gate`。
- 托管方报告的事实（检查、合并、关闭）一律以系统 Actor `system:code-host`（`ACT-SYSTEM-CODE-HOST`，禁用登录、不能审查）的名义记录。这样审计链能区分「托管方报告的」和「人决定的」。
- 导入的检查命名为 `<provider>/<name>`，`source='external'`，`evidenceRef` 为 PR 地址。只有状态或结论变化时才写一条新记录，并且不覆盖 Run 自己产生的同名检查。用户不能手工记录以 `github/` 开头的检查，会返回 `check_name_reserved`。
- 同步状态保存在 `code_host_links` 表（迁移 020）里，不往 `change_proposals` 加托管方字段。

### 门禁状态 `aperture/gate`

| 状态 | 条件 |
| --- | --- |
| `success` | 提案 `approved`，且当前 head 的 readiness 为 `ready`。这正是平台自己合并所需的全部条件。 |
| `failure` | 提案 `closed`、`changes_requested`，或 readiness 为 `blocked`，描述中附带第一条阻塞原因。 |
| `pending` | 其他所有情况，例如等待审查或等待证据。 |

`host_protected` 项目必须在托管方的分支保护中把 `aperture/gate` 设为必需检查。否则托管方的合并不受平台门禁约束，只能事后审计。

## 合并方式

| `merge_mode` | 谁合并 | 流程 |
| --- | --- | --- |
| `control_plane` | 平台 | 1. 平台先复核门禁。<br>2. 本地 fast-forward。<br>3. 调用 `publishMerge`（GitHub 用 `push --force-with-lease=<base>:<baseShaBefore>`）。<br>4. 远程已前进时返回 `remote_base_moved`，被分支保护拒绝时返回 `host_rejected_push`；两种情况都回滚本地 ref，提案保持 `approved`。 |
| `host_protected` | 托管方 | 平台的合并接口返回 `merge_on_host`。同步器发现 PR 已合并后调用 `recordHostMerge`，写入 `strategy='host_merge'` 的 Merge Evidence。 |

PR 在托管方被关闭且未合并时，同步器调用 `closeProposalOnHost`，等同 Reject，理由为 `closed_on_host: <url>`。

### `host_merge` 证据字段

`MergeEvidence.hostMerge` 纳入 `evidenceDigest` 计算：

| 字段 | 含义 |
| --- | --- |
| `provider` / `externalId` / `url` | 托管方与 PR。 |
| `mergedBy` / `hostMergedAt` | 托管方报告的合并人与时间，仅作参考，不作为平台身份。 |
| `contentCheck` | `ancestor`：合并结果包含已批准的 head。<br>`tree_equal`：树完全相同。<br>`patch_equal`：squash / rebase 后补丁相同。<br>`mismatch`：以上都不是。 |
| `hostHeadSha` | 合并时 PR 的 head；如果不等于已批准的 head，说明有未审查的提交进入了默认分支。 |
| `gateStateAtMerge` | 平台为已批准 head 发布的 `aperture/gate` 状态：`success`、`pending`、`failure` 或 `unpublished`。 |
| `outsideGate` / `outsideGateReasons` | 以下任一成立即为绕过门禁：<br>- 提案不是 `approved`；<br>- 没有有效 Approval；<br>- readiness 不是 `ready`；<br>- `contentCheck = mismatch`；<br>- `hostHeadSha` 与已批准 head 不同；<br>- `gateStateAtMerge ≠ success`。 |

`outsideGate = true` 时，除了 `change_proposal.merged`，还会追加一条 `change_proposal.merged_outside_gate` 事件，界面会标红。合并已经发生，平台不会假装它没发生；这条事件是分支保护没配好时的审计兜底。

## 为后续托管方预留

本期不实现 GitLab / 通用 Git 远程。新托管方需要完成：

1. 在 `types.ts` 的 `CodeHostKind` 和 `projects.code_host` 的 CHECK 约束中加入新值。
2. 实现 `CodeHost`：
   - 托管克隆放在 `<dataDir>/repositories/<projectId>.git`；
   - `workingRepository()` 返回该目录；
   - 凭据遵守上面的规则。
3. 实现规范化函数，至少校验：
   - 仓库坐标；
   - `tokenEnv` 是变量名而不是 Token；
   - 合并方式是否支持。
4. 同步器目前按 `GithubCodeHost` 判断能否同步。接入第二个同步型托管方时，把 `getPullRequest / listChecks / setGateStatus / compareMergedContent` 提升为接口上的可选能力，同步器改为按能力判断，门禁语义与证据字段保持不变。
5. 参照 `workbench/scripts/github-code-host-smoke.ts` 写一个假托管方 smoke：凭据缺失、发布、门禁、检查导入、两种合并方式、绕过门禁、关闭，最后扫描数据目录确认 Token 没有落盘。

## 非目标

Webhook、多仓库 Intent、把托管方的 PR Review 导入为平台审批（平台始终是审批权威）、按项目的信任模式。
