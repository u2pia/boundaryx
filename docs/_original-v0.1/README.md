# AI Native SDLC Control Plane

本目录保存 AI Native SDLC Control Plane 的产品与架构设计基线。

当前阶段是**研究与产品定义**，尚未进入技术实现。文档日期统一以 2026-09-22 为基准。

## 核心定位

AI Native SDLC Control Plane 不是新的 Coding Agent，也不替代 GitHub、CI/CD 或现有研发平台。它负责统一管理：

```text
Intent
→ Context
→ Agent Execution
→ Evaluation
→ Human Approval
→ Evidence
→ Pull Request
→ Feedback
```

目标是让每一次 AI 软件变更都可说明、可约束、可验证、可审批、可追溯、可回滚。

## 文档索引

- [VISION.md](docs/VISION.md)：长期愿景、产品原则与两年目标。
- [PRODUCT_CHARTER.md](docs/PRODUCT_CHARTER.md)：目标用户、MVP、成功标准与路线图。
- [DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md)：核心对象、关系、不变量、状态机与事件模型。
- [OPEN_SOURCE_LANDSCAPE.md](docs/OPEN_SOURCE_LANDSCAPE.md)：开源复用策略、候选项目与 Build/Reuse 决策。

## 当前共识

1. 最终建设为核心完全开源的项目。
2. 先服务个人开发者，再扩展到团队和企业平台。
3. 第一阶段聚焦通用软件研发。
4. 默认支持本地运行、私有化、离线环境和模型可替换。
5. 第一阶段采用“AI 执行、人审批”。
6. 首个外部集成优先支持 GitHub。
7. 六个月内只验证一条端到端纵向链路，不建设大而全的平台。
8. 长期目标是形成可被引用的方法论、开放领域模型和治理标准。

## 设计原则

```text
Reuse before Build
Evidence before Trust
Policy before Autonomy
Repository before Platform
Local before Cloud
Protocol before Vendor
Human Accountability by Default
```

