# Operational Attestation：恢复演练证明

Operational Attestation 把一次真实发生的恢复演练登记为有证据、有签发身份、有时效、可撤销且受 Event Log 保护的控制面事实。它不是“已备份”复选框，也不保证未来任何备份必然可恢复。

```text
Backup Directory
  → 文件与 Digest 验证
  → 临时隔离目录恢复
  → 打开恢复后的 SQLite
  → Core Integrity Audit
  → Recovery Evidence JSON
  → Owner Identity + Expiry
  → Sealed Event Log
  → Trust Profile
```

它位于 AI Native SDLC 闭环的运行保障层：

```text
Intent → Context → Workflow → Policy → Evaluation
→ Evidence → Identity → Review → Event Log
→ Integrity Audit → Recovery Attestation
```

## 执行契约

只有平台 `owner` 可以触发或撤销演练。服务端收到请求后：

1. 调用备份验证器检查清单、SQLite、事件链与 Seal、Evidence 和 Holdout；
2. 将备份恢复到操作系统临时目录，不接触在线数据目录；
3. 打开恢复后的 `control-plane.db`；
4. 对恢复数据重新运行 Core Integrity Auditor；
5. 在在线数据目录的 `operational-evidence/recovery/` 写入只读语义的 JSON 证据，文件权限为 `0600`；
6. 记录 Evidence URI、SHA-256、摘要、执行时间、到期时间和当时的决策身份；
7. 追加并密封 `operational_attestation.recorded` 事件；
8. 无论成功或失败，都删除临时恢复目录。

最长有效期为 45 天。默认请求可以使用 30 天。有效状态始终由“未撤销且未过期”实时计算，不存储可被单独篡改的 `active` 字段。

## API

```http
GET /api/operational-attestations
```

```http
POST /api/operational-attestations/recovery-drill
Content-Type: application/json

{
  "backupDirectory": "/secure/backups/team-2026-09-29",
  "validDays": 30
}
```

```http
POST /api/operational-attestations/{id}/revoke
Content-Type: application/json

{
  "reason": "Superseded by the October recovery drill"
}
```

三个接口都要求登录；当前只允许平台 Owner 使用。撤销是追加式记录，会生成 `operational_attestation.revoked` 事件，不会删除原证明。

## Trust Profile 规则

`verifiedRecovery=true` 必须同时满足：

- 存在未过期且未撤销的 `backup_restore_drill`；
- Evidence 文件存在且 Digest 匹配；
- Attestation、撤销记录与密封事件一致；
- 整体 Core Integrity 无 Critical Finding；
- 签发时的身份保证为 `external`。

Development Mode 下由密码会话签发的演练仍可证明技术步骤执行成功，但身份是 `self_asserted`，因此 Trust Profile 保持 `verifiedRecovery=false`。Team Mode 下必须通过外部身份会话执行终态决定。

`verifiedRecovery` 是独立能力，不参与 `local_exploration`、`team_governed`、`release_qualified` 的等级计算，防止把环境等级误读为灾难恢复认证。

## 证据与审计

Core Integrity Auditor 会检查：

- Evidence 文件存在、URI 位于受管目录且 SHA-256 匹配；
- Evidence Schema、执行时间和有效期与数据库记录一致；
- Evidence 文档与数据库摘要一致；
- `recorded` 与 `revoked` 事件精确绑定对应状态和身份快照；
- 事件链与 HMAC Seal 继续有效。

备份现在也包含 `operational-evidence/`。否则一个含有效证明的数据库恢复后会丢失其证据，无法通过完整性审计。

## 明确边界

- 一次成功演练只证明特定备份在特定时间通过了特定版本的恢复与审计流程。
- 它不证明下一份备份、另一台机器、外部 Git 服务或外置密钥一定可用。
- 默认演练在同一主机的临时目录中完成；跨主机、跨存储域演练仍需运维流程补充。
- Evidence 与数据库由同一 Control Plane 管理。Event Chain Head 尚未外部锚定；同时持有数据库写权限和 Seal Key 的攻击者仍可能重写历史。
- 本功能不改变“AI 执行、人审批”，也不授予自动合并或自动发布权限。
