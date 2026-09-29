# Trust Profile

Trust Profile 描述 Control Plane 当前环境**最多能够证明到什么程度**。它由事实计算，不能由用户手工选择，也不能替代任何 Change 的审批。

```text
Environment Facts
  ├─ Core Integrity
  ├─ Identity Assurance
  ├─ Transport Security
  ├─ Event Seal Separation
  ├─ Runtime Isolation
  ├─ Network Policy
  └─ Recovery Attestation
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
| `recovery_verification` | 有效的恢复演练 Operational Attestation | 独立能力，不参与等级升级 |

`recovery_verification` 只有在未过期、未撤销、Evidence 与事件绑定均通过 Core Integrity，且签发身份为 `external` 时才是 `pass`。Development Mode 的 Self-asserted Owner 可以完成技术演练，但不会把 `verifiedRecovery` 升级为 `true`。详细合同见 `OPERATIONAL_ATTESTATION.md`。

## 固定限制

- Trust Profile 是环境能力上限，不是审批建议。
- Profile 不会绕过当前 Revision 的 Evidence、Review 或 Release Approval。
- Event Chain Head 尚未外部锚定；持有 Seal Key 和数据库写权限的人仍可重写历史。
- Runtime 自报的 Descriptor 仍需要部署者保证其实现真实可信；Profile 不会因为字符串写着 `container` 就修改 Runtime 行为。
- Profile 不是合规认证，也不自动映射任何行业监管等级。

## 后续方向

下一阶段应设计 Event Chain Head 的外部锚定合同，并验证离线、私有化环境可采用的锚定介质。Operational Attestation 已解决“恢复事实如何登记”，但尚未解决“平台管理员与 Seal Key 持有者合谋重写全部历史”这一信任边界。
