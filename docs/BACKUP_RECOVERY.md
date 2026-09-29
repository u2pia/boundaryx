# Control Plane 备份与恢复

这套流程保护 AI Native SDLC 的控制面记录：Intent、Context/Skill 声明、Run、Policy、Evaluation、Evidence 索引、Identity、Review、Release 与 Event Log。它不是代码仓库备份，也不备份临时 Agent Worktree。

## 创建备份

在 `workbench/` 目录执行：

```bash
CONTROL_PLANE_DATA_DIR=.aperture-live npm run backup:create -- ../output/backups/team-$(date +%F)
```

命令先用 SQLite `VACUUM INTO` 生成一致数据库快照，再复制不可变的 Evidence 与 Holdout 文件，最后验证：

- SQLite `quick_check`；
- 数据库能迁移到当前程序支持的版本；
- 每个 Event Log 聚合的 Digest 与 HMAC Seal；
- Actor、Intent、Proposal、Review、Merge 与 Release 的关键状态和事件绑定；
- 数据库引用的本地 Evidence Package Digest；
- 已登记 Holdout 的内容 Digest；
- 备份中每个文件的大小与 SHA-256。

任一项失败，临时目录会被删除，命令以失败状态退出。备份目录已经存在时也会拒绝覆盖。

## 备份内容与边界

包含：

- `control-plane.db`；
- `evidence/`；
- `holdouts/`；
- 使用默认同目录 Event Seal Key 时的 `event-seal.key`；
- `backup.json` 文件清单和创建时验证摘要。

不包含：

- `agent-runs/` 临时 Worktree；
- `repositories/` GitHub 托管镜像；
- `demo/` 示例仓库；
- 本地项目指向的外部 Git 仓库；
- `APERTURE_EVENT_SEAL_KEY`、外置 `APERTURE_EVENT_SEAL_KEY_FILE` 和 retired key 文件。

代码仓库应由 Git 服务或独立仓库备份保护。外置 Event Seal Key 必须与数据备份分开保存；验证和恢复时需要提供原 key 与全部仍被历史事件使用的 retired keys。丢失它们时，数据库可以读，但历史事件无法证明未被篡改，验证会失败。

`backup.json` 的文件摘要用于发现损坏或误修改，不是外部签名；能修改整个备份目录的人也能重写清单。事件 HMAC 仍依赖独立保存的 Seal Key。链头尚未外部锚定，持有 Seal Key 的人仍可重写历史，这个边界没有因备份功能而改变。

## 验证备份

```bash
npm run backup:verify -- ../output/backups/team-2026-09-29
```

验证在临时副本上打开数据库和执行迁移，不修改备份本身。建议每次备份后自动执行，并定期在另一台机器上做恢复演练。

## 恢复

先停止旧 Control Plane，再恢复到一个**不存在的新目录**：

```bash
npm run backup:restore -- ../output/backups/team-2026-09-29 ../recovery/control-plane-data
CONTROL_PLANE_DATA_DIR=../recovery/control-plane-data npm run server:start
```

恢复命令会先完整验证源备份，再逐文件复制和复算摘要；不会覆盖已有目录。确认新实例、项目仓库连接和外部密钥均正常后，再切换入口。不要直接覆盖仍在运行的数据库目录。

## 建议节奏

- 每日自动创建一次，至少保留 7 个日备份和 4 个周备份；
- 高风险发布前额外创建一次；
- 每月至少做一次恢复演练，并记录验证结果；
- 将备份、活动 Seal Key、retired keys 放在不同的访问控制域；
- 恢复演练后检查 Event Log、Evidence、Holdout 和至少一个已发布 Change 的可追溯链。
