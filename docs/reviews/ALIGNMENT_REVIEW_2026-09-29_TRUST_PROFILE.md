# AI Native SDLC 目标对齐评审：Trust Profile

> 评审日期：2026-09-29  
> 评审类型：触发式  
> 触发原因：把安全、身份、事件完整性与 Agent Runtime 事实收敛为可解释的环境信任上限

## 1. 最终判定

- 判定：**健康，没有把 Trust Profile 变成可手工授予的认证标签**
- 一句话结论：Profile 只根据 Core Integrity、Identity、Transport、Event Seal 与 Runtime 事实计算，明确不批准任何 Change，也不替代 Revision 级门禁。

## 2. 北极星位置

```text
Identity + Policy + Evaluation + Evidence + Event Log
                         ↓
                 Environment Trust Profile
                         ↓
          可声明的能力上限，不是 Approval
```

- `local_exploration`：允许低保证本地探索，不隐藏 Self-asserted Identity、同目录 Seal Key 或未隔离 Runtime。
- `team_governed`：要求 Integrity、外部身份、安全入口和外置 Seal Key同时成立。
- `release_qualified`：在团队治理基础上要求 Runtime Ready、容器隔离、Production Eligible 和受限网络。
- 每个 Change 仍必须独立通过 Intent、Policy、Evaluation、Evidence、Review、Merge 与 Release Gate。
- Recovery Verification 单独显示，当前没有注册证明时保持 `unknown`，不会被 Profile 名称掩盖。

## 3. 偏航检查

- 默认导航：无变化。
- 新页面：无。
- Provider：无变化。
- 数据库表：无变化。
- 可手工编辑的“生产级”字段：无。
- 自动批准、自动合并、自动发布：无变化。
- API 只对已登录成员开放；未认证读取返回 401。
- 真实团队采用数据：仍未增加，本轮不宣称降低了审查时间。

## 4. 风险边界

- `release_qualified` 表示环境有资格承载生产资格审查，不表示所有 Run 或 Release Candidate 合格。
- Runtime Descriptor 来源于平台配置和运行时探测，但 Profile 不对 Runtime 实现本身做远程认证。
- Event Chain Head 尚未外部锚定。
- `verifiedRecovery=false` 时，Profile 不证明灾难恢复能力。
- Profile 不是行业合规认证，不映射监管等级。

## 5. 验证

- 纯计算测试覆盖 `local_exploration → team_governed → release_qualified` 和 Integrity 降级。
- 真实 HTTP 链路确认未认证访问拒绝、Development + 同目录 Key + 未隔离 Runtime 保持 `local_exploration`。
- `npm run check`：通过。
- `npm run review:alignment`：全部自动锚点 PASS。
- 默认页面数、Provider 数和 Lab 开关无变化。

## 6. 下一步

1. 定义 Operational Attestation 合同，把恢复演练作为有签发者、有效期和撤销语义的事实注册，而不是用户勾选框。
2. 设计 Event Chain Head 外部锚定合同和离线友好的锚定介质。
3. 开始无行为变化的领域拆分，优先 Audit / Evidence 与 Identity。

在真实 10-Change 试点完成前，继续暂停新导航、新 Provider 和自治升级。
