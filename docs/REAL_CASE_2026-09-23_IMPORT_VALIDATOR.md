# 真实案例报告：Import Validator

> 执行日期：2026-09-23  
> 案例类型：Application / 本地 Git / 本地 Codex Builder  
> 最终状态：Change Proposal `approved`，未合并到 `main`

## 1. 案例目标

在一个独立 TypeScript Git 仓库中，由真实 Codex Builder 实现导入文件校验：

- 仅允许 CSV 与 JSON；
- 最大文件大小为 5 MiB；
- 拒绝负数、非整数与非有限字节大小；
- 保持确定性的错误顺序；
- 不删除、跳过或弱化既有验收测试。

案例仓库：`control-plane/examples/real-case-import-validator`

## 2. 基线

初始 Commit：`f9d26064f78041d0d188203e27071040d9f0481e`

初始确定性测试结果：

- 1 项通过；
- 3 项失败；
- 失败覆盖不支持格式、超过大小上限和组合错误顺序。

## 3. 实际执行结果

| 对象 | 标识 |
| --- | --- |
| Work Item | `WI-C1924F3E` |
| Intent Version | `WI-C1924F3E:v1` |
| Agent Run | `RUN-640FFC8C` |
| Change Proposal | `CP-D1A98CE5` |
| Agent Branch | `agent/run-640ffc8c` |
| Head SHA | `fa85a0020b3bbaffe9189da909cff816acd2034a` |
| Evidence Digest | `sha256:e013d6f0adfc82e8f4488fe150b30adc70732ec811763efa0c6506f7d9356eaf` |
| Proposal Event Chain Head | `sha256:6cebf507df0dd1a8af38e734e6c1bb8afbe775e61a946f0d5f99618caad481e1` |

Codex 修改：

- `src/import-validator.ts`：实现扩展名、字节大小与上限校验；
- `test/import-validator.test.ts`：增加非有限值、非整数和组合错误顺序测试；
- Git Commit：20 additions、1 deletion、2 files。

自动 Check：

- `node-tests`；
- Exit Code `0`；
- 6/6 测试通过；
- Check 绑定 Head SHA；
- stdout/stderr Digest 已进入 SQLite 与 Evidence Package。

## 4. 治理链

真实事件顺序：

```text
change_proposal.created
→ check.recorded
→ evidence.recorded
→ evidence.viewed
→ review.approved
```

- Agent 作者与 Reviewer 使用不同 Session Actor；
- Reviewer 查看时重新读取本地 Evidence 文件并校验 Package Digest；
- Medium Risk Approval 要求 Check/Evidence 完整且当前 Reviewer 已查看 Evidence；
- Review Decision 绑定确定的 Head SHA、Check ID、Evidence ID 与 Evidence Digest；
- Run Event Chain 与 Change Proposal Event Chain 均通过完整性复验。

## 5. 两次失败及修复

第一次失败：Codex CLI 不允许同时使用 `--sandbox workspace-write` 与 `--approve-for-me`。Wrapper 改为只使用 `--approve-for-me`，由 Codex 自动采用 workspace-write 审批复核。

第二次失败：Process Runtime 只传递 `PATH/HOME`，导致 Codex 必需的 `CODEX_*` 环境丢失。Runtime 改为显式白名单继承，并在 Attestation 中只记录环境变量名和 Secret 类变量名，不记录值。

失败 Run 保留在 SQLite 与 Event Log 中，没有被删除或伪装成成功。

## 6. 已证明

- 真实模型 Agent 修改真实 Git Worktree；
- 真实 Commit、Branch、Base SHA 与 Head SHA；
- 自动执行确定性测试；
- 自动生成并落盘 Evidence Package；
- Evidence Digest 读取时重新验证；
- 独立身份查看 Evidence 后才能批准；
- 完整追加写 Event Log 与摘要链复验；
- 全程没有使用 Docker、Podman Machine 或其他 VM。

## 7. 尚未证明

- Reviewer 操作由可重复案例脚本驱动，验证的是独立身份和治理协议，不等同于真实人类花时间阅读并作出判断；
- Change Proposal 尚未合并到 `main`，也没有 Merge Commit Evidence；
- Process Runtime 仍为 `degraded / unisolated_process / unrestricted`，不能用于生产授权；
- Context Consumption 仍包含 Agent Protocol 自报告，尚无独立文件访问审计；
- 案例执行完成后已实现仓库级 Project Manifest；下一次案例运行需要先把 `.aperture/project.json` 提交到目标基线，Context、Check 与本地 Runtime 许可将绑定该 Manifest Digest。

## 8. 结论

平台已经可以走通一个真实的本地技术案例，边界是：

```text
Intent → Context → Codex Run → Git Commit
→ Check → Evidence Package → Evidence View
→ Revision-bound Review → Event Log
```

当前可以称为“真实本地受治理开发闭环”，不能称为“生产级自主交付闭环”。Project Manifest 已进入实现；下一步应完成真实人工 Review 试用与 Merge Evidence，而不是继续增加 Mock Provider。
