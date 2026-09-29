# AI Native SDLC Control Plane：采用价值审查

> 日期：2026-09-29  
> 视角：小团队负责人 / 产品投资人 / 平台采用决策者  
> 审查对象：当前 Workbench、Local Control Plane、产品文档与治理机制  
> 与既有评审的区别：不重点判断协议是否完整，而判断用户是否会持续使用、是否能证明价值

## 1. 最终判定

- 判定：**技术方向健康，产品采用存在明显偏移风险**
- 技术治理成熟度：`88/100`
- 小团队采用准备度：`62/100`
- 综合判定：`74/100`
- 一句话结论：项目已经接近一个可信的 AI Change Governance 内核，但默认产品仍像“把未来平台能力全部展开的控制台”，尚未收敛为 3–8 人团队每天愿意使用的决策工作流。

## 2. 换一个问题定义

当前项目经常用以下问题描述自己：

> 如何管理 AI Native 时代完整的软件研发生命周期？

这个问题太大，容易自然扩张到项目管理、Agent 平台、CI/CD、可观测、IAM、评估平台和发布平台。

更适合作为首个产品楔子的表达是：

> **团队如何在 10 分钟内安全地接受或拒绝一次 AI 生成的软件变更？**

因此第一阶段真正应交付的不是“完整 SDLC 平台”，而是：

> **AI Change Governance Gateway**：把 Intent、上下文边界、执行事实、评估结果、人工责任和最终 Revision 组合成一个可信的 Change Decision。

这并没有缩小最终愿景，而是给最终 Control Plane 找到一个可被真实团队采用的入口。

## 3. 当前最强的部分

### 3.1 治理对象开始形成同一条脊椎

- Intent、Run、Change Proposal、Review、Merge Evidence、Release Candidate 和 Event Log 已经不是独立演示对象。
- Review Decision 绑定确定 Head SHA，旧 Review、Check 和 Evidence 会随 Revision 失效。
- Builder Context、Manifest、Evaluation Dataset、Artifact 输出和 Reviewer Feedback 都逐步进入 Digest 与 Evidence。

### 3.2 对“事实”和“自述”的区分明显领先普通原型

- 项目持续标记 Mock、自报告 Context、未隔离 Runtime 和不可验证边界。
- 对抗性审查能够推翻原设计，而不是只为既有方案背书。
- Git Hook、fsmonitor、Event Seal、Holdout Dataset 等问题说明项目已开始处理真实攻击面。

### 3.3 Human-governed 不是口号

- 禁止作者自批。
- Merge 与 Release 是两个独立决定。
- 低风险自动化仍被限制在未来车道，没有提前引入自动合并和自动发布。

## 4. 主要问题

### P0：技术完成度正在掩盖产品价值尚未被证明

现有评审经常得到 `95–96/100`，但分数主要证明架构一致性和边界意识，并不证明真实团队获得了价值。

当前缺少的权威证据包括：

- 真实团队从 Intent 到 Merge 的周期是否缩短；
- Reviewer Active Time 是否下降；
- Changes Requested 后的返工轮次是否减少；
- Evidence 是否帮助 Reviewer 更快发现缺陷；
- Policy Block 是否真正避免了一次高风险操作；
- 团队是否愿意连续两周把真实变更放进平台。

在这些数据出现前，不应继续使用 95 分以上的综合产品评分。技术评分和采用评分必须分开。

### P0：默认产品认知负担过高

当前客观范围为：

- `15` 个默认页面；
- `34` 个服务端 TypeScript 文件；
- `27` 个数据库迁移；
- `43` 个 Smoke Test；
- `38` 份 Markdown 文档；
- `src/main.tsx` 超过 `3000` 行。

这些数字不代表代码质量差，但说明一个 3–8 人团队需要理解的概念增长过快。Intent、上下文、Runs、评审、发布、评估、证据、追溯、策略、反馈、集成、项目、团队、度量同时成为一级页面，用户很难判断“现在最需要我做什么”。

### P0：Core 与 Lab 仍然像两个产品叠在一起

真实 Local Control Plane 已经具有 SQLite Identity、Git Revision、Review、Merge 和 Evidence；同时 README 与 UI 仍保留大量 Mock Provider、Deployment、Trace、Telemetry、Harness、Regression 和 Catalog 叙事。

虽然演示区域已有标识，但从项目定位和代码维护角度，仍会造成三个问题：

1. 新用户难以判断哪些能力可以用于真实工作；
2. 开源贡献者不知道应该加强 Core 还是扩展 Lab；
3. 产品团队容易把“页面存在”误当成“能力完成”。

### P1：Evidence 在增长，但 Decision Experience 没有同步收敛

平台已经拥有大量 Digest、事件链、Seal、Attestation 和 Threshold。对平台开发者而言这是可信度；对 Reviewer 而言，这些只是原材料。

Reviewer 真正需要的是一个稳定的 Decision Brief：

- 这个变更为什么存在；
- AI 实际看了什么、改了什么；
- 哪些风险被策略阻止；
- 哪些验收标准已经证明，哪些仍需要人判断；
- 与上一 Revision 相比发生了什么；
- 当前唯一需要 Reviewer 决定的问题是什么。

如果没有这一层压缩，Evidence 越完整，人工审查成本可能越高。

### P1：权威边界仍可能与未来 GitHub / GitLab 集成冲突

当前本地模式中 Control Plane 是 Intent、Review Decision、Merge Evidence 和 Release Approval 的权威来源。这在离线环境中合理，但接入 GitHub/GitLab 后必须提前决定：

- Code Review Decision 的最终权威在哪里；
- 平台 Approval 与 PR Approval 是否要求双重操作；
- 外部系统漂移时谁阻断谁；
- 哪些对象是 Authority，哪些只是 Projection。

否则平台会成为额外审批层，而不是减少管理成本。

### P1：未隔离 Runtime 限制了可信使用场景

项目对 `degraded / unisolated_process / productionEligible=false` 的标记是正确的，但从采用视角，这意味着当前最可信的产品用户不是企业生产团队，而是：

- 单机探索者；
- 可信仓库的小团队；
- 用于评估治理流程的内部试点。

应把这一点变成明确的 Trust Profile，而不是散落在文档中的免责声明。

### P2：架构开始出现“治理单体”风险

- `src/main.tsx` 同时承担大量页面与状态表达；
- `database.ts` 逐渐承担多个 Aggregate 的业务规则；
- Migration 数量快速增长；
- Provider、Lab 与真实本地链路共存。

当前不需要微服务，但需要按产品脊椎拆分模块边界，否则每次增加治理规则都会扩大回归面。

## 5. 推荐的产品收敛

### 5.1 默认工作区只保留五个工作入口

1. **Inbox**：等待人类处理的 Intent、Policy Exception、Review、Release Decision。
2. **Intent**：目标、Non-goals、Examples、Acceptance Criteria 和批准状态。
3. **Runs**：Agent 执行、Context、Tool、Policy 和 Revision。
4. **Review**：Decision Brief、Diff、Evaluation、Evidence 与 Reviewer Action。
5. **Audit**：Event Log、Evidence Package、Merge / Release Provenance。

项目、团队和策略进入设置；评估、上下文、证据和追溯成为上述对象的详情视图；集成、Provider、Trace、Telemetry、Deployment 全部保留在 Lab 或 Reference Architecture。

### 5.2 建立唯一的核心成功指标

建议北极星指标改为：

> **每个被接受 AI Change 所消耗的可信人工审查分钟数。**

配套护栏指标：

- 合并后回滚率；
- Changes Requested 轮次；
- Critical AC 未覆盖率；
- Policy Block 后仍发生的绕过次数；
- Evidence 打开到 Decision 的时间；
- 无效或过期 Evidence 数量。

### 5.3 用 Trust Profile 代替模糊的“可用 / 不可用”

- `local_exploration`：本地 SQLite、Process Runtime、可信仓库，不具备生产资格。
- `team_governed`：受隔离 Runner、外部密钥、具名身份、独立 Evaluator。
- `enterprise_controlled`：外部 Identity、Git Authority、Artifact Store、Policy Bundle 和审计锚定。

每个 Profile 明确可以证明什么、不能证明什么，以及升级条件。

## 6. 接下来三个优先事项

### 1. Decision Brief / Review Packet

把 Intent、Revision Diff、Context、Policy、Evaluation、Artifact 和 Reviewer Feedback 压缩成一页可决策信息；所有详情仍可展开，但默认不要求 Reviewer 阅读事件原料。

目标指标：Evidence 打开到 Review Decision 的中位时间下降。

### 2. 真实团队试点与基线测量

选一个真实仓库连续运行至少 10 个 Change，而不是继续增加演示能力。记录未使用 Control Plane 时的 Review Time 和返工轮次，形成前后对照。

停止条件：如果 10 个 Change 后没有降低审查时间或提高缺陷发现率，暂停新增功能，重新审查产品楔子。

### 3. Core / Lab 物理分界

不仅在 UI 标记 Demo，还要在代码、路由、构建配置和文档中形成清晰目录边界。默认发行物只包含 Core；Lab 通过显式开关启用。

## 7. 暂停事项

在完成上述三项之前，建议暂停：

- 新 Provider Contract；
- 新的默认导航页面；
- 通用 Roadmap / Sprint / Resource Management；
- 更多 Trace、Telemetry 或 Dashboard；
- 自动合并、自动发布；
- 通用 Skills Marketplace；
- 与真实审查指标无关的治理对象。

## 8. 最终观点

这个项目现在最大的风险已经不是“技术做不出来”，而是：

> **把一个有机会成为新品类的 AI Change Governance 产品，做成一个能力极强但使用频率很低的平台控制台。**

下一阶段应少证明“平台还能管理什么”，多证明“一个 Reviewer 为什么离不开它”。
