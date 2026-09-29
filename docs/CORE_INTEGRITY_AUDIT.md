# Core Integrity Auditor

Core Integrity Auditor 是 AI Native SDLC Control Plane 的闭环校验层：

```text
Intent → Context → Workflow → Policy → Evaluation
→ Evidence → Identity → Review → Event Log
→ Integrity Audit → Recovery
```

它不判断一次 Change 是否“值得批准”，而是判断 Control Plane 保存的事实是否仍然自洽、可证明和可恢复。

## 运行

在 `workbench/` 目录执行：

```bash
CONTROL_PLANE_DATA_DIR=.aperture-live npm run audit:verify
```

命令在 `output/audits/` 生成同一时间戳的 JSON 和 Markdown 报告。可以通过 `CONTROL_PLANE_AUDIT_OUTPUT_DIR` 修改输出目录。存在 `critical` Finding 时退出码为非零；只有 `warning` 或 `info` 时报告仍为通过。

建议执行时机：

- 高风险发布前；
- 创建日常备份后；
- 数据库迁移后；
- 怀疑数据库被平台外修改时；
- 每月恢复演练时。

## 检查范围

### 数据库

- SQLite `quick_check`；
- Foreign Key Check；
- Schema 由正常启动迁移到当前版本。

### Event Log

- 所有 Aggregate 的 Hash Chain；
- 每个事件的 HMAC Seal；
- 未知、丢失或不匹配的 Seal Key。

### 状态与事件绑定

- Actor 创建事件和更新事件重放后的当前状态；
- Intent 内容 Digest、版本事件与批准事件；
- Change Proposal 创建、Revision Head 和 Base SHA；
- Check、Evidence、Review Assignment、Review Decision；
- Governance Override / Reject；
- Merge Evidence 与其 Digest、Proposal Chain Head；
- Release Candidate、Artifact Binding 和 Release Approval。

### 文件证据

- 本地 Evidence Package 的内容 Digest；
- Evidence Summary 与 `evidence.recorded` 事件的 Summary Digest；
- 已登记 Holdout 的文件与 Digest。
- Operational Attestation 的 Evidence 文件、摘要、有效期、身份快照、撤销记录及对应事件。

## 严重程度

- `critical`：状态与事件不一致、Digest/Seal 失败、Evidence 缺失、Merge 或 Release 绑定损坏。报告失败。
- `warning`：本机无法验证外部 Evidence、Seal Key 与数据库同目录、网络入口没有 Secure Cookie、历史 Revision 事件缺少旧版字段。报告通过，但必须人工处理。
- `info`：例如仍使用 Development Identity Mode，不代表数据损坏，但不能宣称具备高保证身份。

## 边界

- Auditor 使用当前 Control Plane 持有的 Event Seal Key。Key 丢失时，它只能报告历史 Seal 不可验证，不能恢复信任。
- 整条事件链仍未外部锚定。持有 Seal Key 且能同时修改数据库的人仍可重写状态、事件和 Seal；Auditor 不能证明外部不可抵赖。
- 外部 Evidence URI 只验证数据库与事件引用关系，不能读取的远端字节会标为 `warning`。
- Auditor 不执行 Git Fetch，也不重新运行测试或模型评估；它验证的是已记录的控制面事实，而不是重新证明业务正确性。
- 命令不会写业务记录，但和正常服务启动一样会执行尚未应用的数据库迁移。正式审计前应先备份。

## 与备份的关系

`backup:verify` 会在备份临时副本上调用同一 Core Integrity Auditor。因此，一个备份只有在数据库文件可读还不够；关键状态必须能与 Event Log、Evidence、Holdout 和 Operational Attestation 对账后才算有效。
