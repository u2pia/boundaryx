# AI Native SDLC 目标对齐评审：Operational Attestation

> 评审日期：2026-09-29
> 评审类型：触发式
> 触发原因：把恢复演练从外部运维建议升级为可验证、可撤销的 Control Plane 事实

## 1. 最终判定

- 判定：**健康，补齐了 Event Log → Integrity Audit → Recovery 的运行保障缺口**
- 一句话结论：本轮没有增加业务功能页或自治权限，而是让“备份可恢复”从口头声明变成由真实演练、Evidence、Identity 和密封事件共同证明的事实。

## 2. 在闭环中的位置

```text
Intent → Context → Workflow → Policy → Evaluation
→ Evidence → Identity → Review → Event Log
→ Integrity Audit → Recovery Attestation
```

- Intent 到 Review 保证一次 Change 为什么做、如何做、是否满足标准以及谁批准。
- Event Log 与 Integrity Audit 保证控制面记录仍然自洽、未出现可检测的旁路写入。
- Recovery Attestation 保证这些记录曾在一个具体时间点从一个具体备份中恢复并重新通过完整性审计。
- Trust Profile 只消费满足时效、证据、事件和外部身份要求的 Attestation，不允许人工勾选升级。

## 3. 偏航检查

- 默认导航：无变化。
- 新页面：无。
- Provider：无变化。
- Core 数据模型：新增追加式 Operational Attestation 与 Revocation。
- 权限：只有平台 Owner 可执行、查看和撤销；未提升 Agent 权限。
- 自治：仍为 AI 执行、人审批；未增加自动合并或自动发布。
- 部署：使用本地 SQLite、文件 Evidence 和操作系统临时目录，不要求 VM 或容器。
- 真实团队采用数据：没有增加，本轮不宣称改善交付速度或缺陷率。

## 4. 信任与风险边界

- Self-asserted Owner 可以证明演练技术执行成功，但不能令 `verifiedRecovery=true`。
- 有效期最长 45 天；过期或撤销后不再是当前证明。
- 演练默认发生在同一主机，不能替代异地或跨机器灾备测试。
- Attestation 证明过去一次演练，不承诺未来备份成功。
- Event Chain Head 尚未外部锚定；同时控制数据库和 Seal Key 的主体仍可能重写历史。
- Backup Path 被记录在本地 Evidence 中，因此接口仅对 Owner 开放。

## 5. 可验证结果

- Smoke 覆盖真实备份验证、临时恢复、恢复库 Core Integrity、Evidence Digest、Self-asserted 不升级、撤销和篡改检测。
- HTTP Smoke 覆盖未认证拒绝、非 Owner 拒绝、Owner 执行、列表与撤销。
- Backup Smoke 保持通过，且含 Operational Attestation 的后续备份会携带其 Evidence。
- Core Integrity 和 Trust Profile 回归测试保持通过。

## 6. 下一步

1. 不新增页面，先用 10-Change 试点同时记录至少一次真实恢复演练的操作成本和失败模式。
2. 设计 Event Chain Head 外部锚定，使平台管理员与 Seal Key 持有者不能无痕重写全部历史。
3. 为跨机器恢复定义环境差异检查，包括外置 Seal Key、Git 服务连接和运行时配置。

在真实试点完成前，不把 `verifiedRecovery`、`release_qualified` 或单次演练解释为生产可用性认证。
