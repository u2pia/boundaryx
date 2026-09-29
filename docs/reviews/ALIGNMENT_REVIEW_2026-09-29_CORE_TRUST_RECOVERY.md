# AI Native SDLC 目标对齐评审：Core Trust & Recovery

> 评审日期：2026-09-29  
> 评审类型：触发式  
> 触发原因：在真实团队试点之外复查 Core 的安全、审计与恢复缺口

## 1. 最终判定

- 判定：**健康，Core 信任边界增强，没有扩大产品范围**
- 一句话结论：本轮没有增加导航、Provider 或管理对象，而是让既有 Intent → Release 闭环的身份入口、事件证明和灾难恢复更可信；真实采用价值仍必须由 10-Change 试点证明。

## 2. 北极星检查

本轮直接强化：

```text
Identity → Review → Event Log
Evaluation → Evidence → Event Log
全链路 → Backup → Verified Restore
```

- Event Integrity 由服务端使用 HMAC Seal 验证，不再由试点采集脚本把客户端链连接检查冒充封印验证。
- 密码登录对未知用户执行同等 scrypt 工作，并增加有界的账号/来源失败节流。
- HTTPS 公共入口自动启用 Secure Session Cookie；未初始化实例拒绝直接暴露到局域网，防止首个远程访问者抢占 Owner。
- 备份先创建 SQLite 一致快照，再验证 Event Log、Evidence、Holdout 和迁移兼容性；恢复只写入新目录，不覆盖活动实例。
- 没有新增默认页面、Lab 能力、Provider、自动批准、自动合并或自动发布。

## 3. 九项能力影响

| 能力 | 本轮影响 | 证据 | 仍有缺口 |
| --- | --- | --- | --- |
| Intent | 间接保护 | Intent 与批准记录进入一致数据库快照 | 缺少真实团队采用数据 |
| Context | 间接保护 | Context / Skill 声明随数据库与事件恢复 | 外部 Run 的实际读取仍不可独立观察 |
| Workflow | 间接保护 | Workflow 状态可验证恢复 | 尚无恢复后的自动项目连接检查 |
| Policy | 间接保护 | Policy Decision 与 Override 事件接受 Seal 校验 | 缺少统一 Policy Decision 摘要 |
| Evaluation | 直接保护 | Holdout 内容按 Digest 验证并纳入备份 | 外部 Evaluator 仍未接入 |
| Evidence | 直接保护 | 本地 Evidence Package 逐包复算 Digest | 外部 Evidence URI 只计数，不复制 |
| Identity | 直接强化 | 登录节流、恒定校验成本、Secure Cookie、初始化暴露保护 | 节流为进程内状态；企业身份仍依赖 GitHub |
| Review | 间接保护 | Review 与 Decision Brief 事实可恢复且事件可验 | 真实 Reviewer 时间样本仍为 0/10 |
| Event Log | 直接强化 | 授权 Integrity API、全聚合备份验证 | 链头未外部锚定；持有 Seal Key 的人仍可重写 |

## 4. 信任边界

- `backup.json` 的文件摘要发现损坏与误修改，不是外部签名；能改整个备份目录的人也能重写清单。
- Event Seal Key 与 retired keys 若外置，不进入数据备份，必须在独立访问控制域保存。
- 默认同目录 Seal Key 只防数据库文件被单独复制后篡改，不防整个数据目录被控制。
- 登录节流保存在当前进程内，服务重启后清空；反向代理场景的来源桶默认看到代理地址，因为平台不信任 `X-Forwarded-For`。
- 备份不包含外部项目仓库、托管镜像和临时 Agent Worktree；代码资产必须由 Git 服务或独立仓库备份保护。

## 5. 范围与偏航检查

- 默认导航页面：无变化。
- Core / Lab 分界：无变化，新增能力仅为服务端安全与运维命令。
- Provider 数量：无变化。
- 新增领域对象：无。
- 新增长期基础设施：本地备份格式与恢复命令，属于 Control Plane 必需运维面，不进入产品导航。
- 自动化自治等级：无变化，仍是 AI 执行、人审批。
- 结论：没有偏离 AI Native SDLC Control Plane；本轮减少了“流程看起来完整但控制面本身不可信”的风险。

## 6. 验证结果

- `npm run check`：通过，包括 46+ smoke、前端构建、新增 Backup 与 Security Hardening 测试。
- `npm run review:alignment`：北极星锚点、九项治理、审查指标和范围约束全部 PASS。
- Event Integrity HTTP：未认证请求拒绝，授权请求返回服务端 Seal 校验结果。
- Backup：创建、验证、恢复、Holdout 校验和文件篡改检测通过。
- Authentication：第二次失败触发账号封锁，封锁期间正确密码也不能绕过；Secure Cookie 回归通过。

## 7. 下一步决策

### 保留并优先

- 把 Event Integrity 和恢复验证作为每次试点采集、发布前检查与运维演练的可信基础。
- 保持外置 Event Seal Key、独立备份和恢复演练的明确边界。
- 在不增加页面的前提下，继续拆分 `database.ts`、`http-server.ts` 和 `main.tsx` 的领域边界。

### 暂停

- 新导航、新 Provider、新 Dashboard。
- 在链头外部锚定方案明确前宣称 Event Log 不可抵赖。
- 在真实样本不足前推进低风险自动合并或自动发布。

### 下一周期非真人测试工作

1. 将 Database 与 HTTP 路由按 Identity、Review、Evidence / Audit、Release 分域，降低治理规则回归面。
2. 为备份命令增加可选的外部对象存储适配前，先建立本地保留策略和恢复演练记录格式。
3. 设计 Event Chain Head 外部锚定合同，只做接口与威胁模型，不先引入云依赖。
