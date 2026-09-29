# Core / Lab Boundary

> 日期：2026-09-29  
> 状态：Core 聚焦期；Lab 开发暂时冻结

## 目标

默认发行物首先服务 3–8 人团队的 AI Change 治理，不把 Reference Architecture、Mock Provider 和实验性控制面能力同时暴露为日常工作入口。

## 默认 Core 表面

默认工作区保留六个入口：

1. `总览`：待处理事项与当前项目态势。
2. `Intents`：目标、约束、Non-goals、验收标准与批准。
3. `上下文`：同一工作面分别治理 Context Package 与 Skills Catalog；覆盖来源、Revision、注入范围、访问拒绝、声明/实际读取、Skill 内容摘要与实际加载事件。
4. `Agent Runs`：执行、Context、Tool、Runtime 与 Revision。
5. `评审队列`：Decision Brief、Evidence、Review 与 Merge。
6. `发布`：Merge Evidence 与 Release Candidate。

`项目 / 团队 / 集成` 属于管理表面，不计入日常工作入口。

上下文不是实验性辅助能力，而是 Core 治理对象。Core 必须能够回答：某次执行使用了什么上下文、来自哪个 Revision、允许注入到哪里、哪些访问被拒绝、实际读取是否超出声明，以及压缩是否保留了关键决策与证据引用。

Skills 同样属于 Core，但只与 Context 共用工作面，不共享语义：Context 是某次 Run 的输入，Skill 是可复用的执行方法。Core 必须区分“项目声明了某个 Skill”“该 Revision 的 Skill 内容是什么”和“某次 Run 实际加载了该 Skill”三种事实。当前内置 Chat Builder 已支持受控 `load_skill(name)`；Claude Code 的成功 Read 可映射为使用事件。事件进入 Run、Decision Brief 与 Evidence Package，但仍是运行内报告而非 OS 级独立观测；无法观测的 Codex Run 不会伪造加载记录。

## Lab 表面

以下页面默认隐藏，仅在使用 `npm run dev:lab`、`npm run build:lab` 或显式设置 `VITE_APERTURE_LAB=true` 时进入导航和路由：

- 评估
- 证据中心
- 追溯
- 策略
- 反馈闭环
- 度量

这些能力并未删除。Core 页面仍可通过 Run、Decision Brief、Evidence Drawer 等对象详情使用真实治理数据；Lab 页面仅保留为未来研究更完整 Provider、Trace、Telemetry 和 Reference Architecture 的入口，当前不继续开发。

## Phase 1 保证

- 默认导航不再把 15 个页面同时呈现给新用户。
- 直接访问隐藏 Lab Hash 会回到 `总览`。
- Command Palette 与 Demo Notification 只暴露当前发行模式允许的页面。
- `review:alignment` 独立报告 Core Workspace、Administration 与 Lab 页面数量。
- 开关默认关闭，必须由构建或启动环境显式启用。

## Phase 1 不保证

- Lab 代码仍在同一个前端入口中，因此当前只是产品表面和路由边界，不是最终 Bundle 物理隔离。
- Lab Adapter、Store 与页面组件仍可能进入默认 JavaScript Bundle。
- 服务端 Provider Contract 尚未按 Core / Lab 分目录。

## 当前 Core 优先级

1. 明确 Context Management 与 Skills Management 的 Core 合同、页面范围与验收标准。
2. 跑通真实 10-Change 试点，验证 Intent → Context → Run → Evaluation → Evidence → Review → Release 闭环。
3. 建立 Decision Brief → Decision 时间、Evidence 打开率、返工、接受率、缺陷与回滚护栏。
4. 保持 AI 执行、人类审批；不启用自动合并和自动发布。
5. 保持本地 SQLite + Git 可运行，不把 GitHub 作为 Core 成立的前提。

## 暂缓工作

- 不推进 Lab 页面拆包、动态加载或独立发行。
- 不新增 Provider、Trace、Telemetry、Deployment 等实验能力。
- 不以 Lab 完整度作为当前里程碑或发布阻塞条件。
