# Trust Profile

Trust Profile 描述 Control Plane 当前环境**最多能够证明到什么程度**。它由事实计算，不能由用户手工选择，也不能替代任何 Change 的审批。

```text
Environment Facts
  ├─ Core Integrity
  ├─ Identity Assurance
  ├─ Transport Security
  ├─ Event Seal Separation
  ├─ Runtime Isolation
  └─ Network Policy
          ↓
      Trust Profile
          ↓
可声明的能力上限，而不是 Approval
```

## 查看

CLI：

```bash
CONTROL_PLANE_DATA_DIR=.aperture-live npm run trust:report
```

报告写入 `output/audits/`。服务端为已登录成员提供：

```http
GET /api/trust-profile
```

两者都会先运行 Core Integrity Auditor，再根据身份、传输、Seal Key 和 Agent Runtime 的实际状态计算 Profile。

## 三个等级

### `local_exploration`

适用于单机探索和可信环境试验。出现以下任一情况都会停留在这个等级：

- Core Integrity 有 Critical Finding；
- Identity Mode 仍是 Development；
- 非 Loopback 入口没有 Secure Cookie；
- Event Seal Key 与数据库同目录。

它不代表流程无效，而是说明人类决策身份或控制面防篡改能力仍属于低保证。

### `team_governed`

要求同时满足：

- Core Integrity 通过；
- Team Identity Mode；
- Loopback 或 HTTPS / Secure Cookie；
- Event Seal Key 位于数据库目录之外。

该等级允许声明“终态人类决策经过外部身份和完整性控制”，但不代表 Agent 执行环境具有生产资格。

### `release_qualified`

在 `team_governed` 基础上还要求：

- Agent Runtime `status=ready`；
- `isolation=container`；
- `productionEligible=true`；
- Network Egress 为 `denied` 或显式 Allowlist，而不是 `unrestricted`。

这里的含义是：

> 平台环境具备承载“可进入发布审查的 Agent Change”的条件。

它不表示任意 Run、Proposal 或 Release Candidate 自动合格。每个 Change 仍必须分别通过 Intent、Policy、Evaluation、Evidence、Identity、Review、Merge 和 Release Gate。

## Controls

| Control | 来源 | 影响 |
| --- | --- | --- |
| `core_integrity` | Core Integrity Auditor | 所有等级 |
| `external_identity` | Identity Mode | `team_governed` |
| `transport_security` | Host 与 Secure Cookie | `team_governed` |
| `event_seal_separation` | Event Seal Key Source | `team_governed` |
| `runtime_available` | Agent Runtime Descriptor | `release_qualified` |
| `runtime_isolation` | Isolation 与 Production Eligibility | `release_qualified` |
| `network_egress` | Runtime Network Policy | `release_qualified` |
| `recovery_verification` | 恢复验证证明 | 当前只作为独立能力，不参与等级升级 |

`recovery_verification` 当前通常是 `unknown`。备份和恢复已有验证命令，但尚未把最近一次演练证明注册到运行中的 Control Plane。Profile 因此会明确显示 `verifiedRecovery=false`，不能把 `release_qualified` 误读为灾难恢复已经验证。

## 固定限制

- Trust Profile 是环境能力上限，不是审批建议。
- Profile 不会绕过当前 Revision 的 Evidence、Review 或 Release Approval。
- Event Chain Head 尚未外部锚定；持有 Seal Key 和数据库写权限的人仍可重写历史。
- Runtime 自报的 Descriptor 仍需要部署者保证其实现真实可信；Profile 不会因为字符串写着 `container` 就修改 Runtime 行为。
- Profile 不是合规认证，也不自动映射任何行业监管等级。

## 后续方向

下一阶段可以把经过验证的 Backup / Restore Drill 注册为独立 Operational Attestation，再使 `verifiedRecovery` 成为有时效的事实。实现前必须先定义 Attestation 的签发者、有效期、撤销和 Event Log 绑定，不能仅增加一个用户可勾选的“已备份”字段。
