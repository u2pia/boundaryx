# AI Native SDLC 目标对齐评审：Project Manifest

> 评审日期：2026-09-23  
> 评审类型：触发式  
> 上次评审：`ALIGNMENT_REVIEW_2026-09-23_REVIEW_OBSERVABILITY.md`  
> 下次评审：完成一次真实人工请求修改与重新批准后

## 1. 最终判定

- 判定：健康
- 本期总分：`93/100`
- 上期总分：`92/100`
- 一句话结论：本轮把 Context、Check 和项目执行策略从服务启动环境收敛到 Git 基线中的受治理 Manifest，并将其 Digest 贯穿 Run、Evidence 和 Event Log，没有扩张通用 Agent 编排范围。

## 2. 北极星检查

本周期直接强化：

```text
Context → Workflow → Policy → Evaluation → Evidence → Event Log
```

- Context 的 required/allowed 边界由基线 Revision 中的 Manifest 决定。
- Work Item 类型、Intent 风险和 Runtime 隔离必须满足项目策略。
- Check 命令绑定 Manifest Digest，不再依赖 Control Plane 启动变量。
- Run Request、`agent_run.project_manifest_bound` 和 Evidence Package 使用同一 Manifest Binding。
- Manifest 不能把 Process Runtime 提升为生产资格；平台级作者自批、Evidence View 和 Revision 绑定规则不可被仓库配置削弱。
- UI 只在现有 Evidence Drawer 中增加 Manifest 可见性，没有增加新导航页或独立配置平台。

## 3. 评分卡

| 维度 | 权重 | 得分 | 证据 |
| --- | ---: | ---: | --- |
| 北极星一致性 | 20 | 20 | 直接强化 Context 到 Event Log 的治理链 |
| 九项脊椎完整性 | 20 | 19 | Intent/Identity/Review 无退化；Manifest 补齐项目级 Context/Check |
| 真实纵向闭环 | 20 | 18 | Local/HTTP/Container Run 均验证 Manifest；真实案例仍待基线提交后重跑 |
| 审查带宽价值 | 15 | 13 | Reviewer 可知道证据由哪个项目配置产生，但尚无真实审查时间数据 |
| 人类责任治理 | 10 | 10 | Manifest 不可取消作者自批和 Evidence View 门禁 |
| 私有化与可替换性 | 10 | 9 | 纯本地 Git/JSON/SQLite；命令仍依赖本机工具链 |
| 范围纪律 | 5 | 4 | 无新 Provider/页面；新增一个必要治理对象 |

## 4. 九项能力成熟度

| 能力 | 上期 | 本期 | 变化证据 | 最大缺口 |
| --- | ---: | ---: | --- | --- |
| Intent | 2 | 2 | Intent Risk 受项目最大风险约束 | 尚缺 Intent 影响分析 |
| Context | 2 | 2.5 | required/allowed 路径绑定基线 Manifest | 文件消费仍含 Agent 自报告 |
| Workflow | 2 | 2.5 | Run 创建前执行 Manifest Gate | 尚缺持久任务调度 |
| Policy | 2 | 2.5 | Product Type、Risk、Runtime 策略进入真实执行边界 | 尚缺审批数量等项目策略 |
| Evaluation | 2 | 2.5 | Check Profile 由版本化 Manifest 驱动 | 尚缺 Agent System Dataset Profile |
| Evidence | 2.5 | 3 | Evidence 固化 Manifest Digest、基线与策略 | 尚缺外部签名与 Merge Evidence |
| Identity | 2.5 | 2.5 | 无范围变化 | 尚缺企业身份联邦 |
| Review | 3 | 3 | Reviewer 可查看 Manifest Binding | 尚缺真实人工请求修改周期 |
| Event Log | 3 | 3 | 新增 project_manifest_bound 事件 | 尚缺外部不可篡改存储 |

## 5. 真实价值数据

- Active Review Time：尚未采集真实人工数据。
- Decision Latency：已有 SQLite 指标，本轮未产生新的真实人工样本。
- Review Cycle Count：本轮 Smoke 覆盖 Run 与 Evidence，未冒充人工审查周期。
- Evidence Usefulness：Reviewer 可确认 Check 与 Context 由哪个 Manifest Digest 产生。
- 缺陷或返工护栏：错误 Product Type、超出风险、禁用 Runtime、缺失/越界 Context 会在 Agent 执行前阻断。
- 真实任务数量：历史真实案例 1；Manifest 版本尚待基线提交后重跑。
- 真实作者 / 审查者数量：历史案例 2 个独立 Session Actor；Reviewer 操作仍由脚本驱动。

## 6. 范围与偏航信号

- 新增领域对象：Project Manifest Binding，不新增独立数据库聚合。
- 新增长期基础设施：无。
- 新增默认导航：无。
- 新增 Provider：无。
- 是否触发硬性红线：否。
- 风险提示：仓库 Check 命令在 Process Runtime 中运行本机进程；只有显式允许的非生产本地项目可使用。

## 7. 决策

### 保留并优先

- Git 基线绑定的 `.aperture/project.json`。
- Context、Risk、Runtime 的执行前门禁。
- Manifest Digest 进入 Evidence 和 Event Log。

### 暂停

- 自动发现任意仓库配置格式。
- 可视化 Manifest 编辑器。
- 允许仓库策略降低平台级 Review 门禁。

### 移入 Lab

- OCI/VM Runtime 实验继续保持非默认路径。

## 8. 下一周期

1. 把真实案例 Manifest 提交到独立案例仓库基线并重新执行。
2. 由真实人类完成一次请求修改、重新执行和再次批准。
3. 实现显式人工触发的 Merge Evidence，验证目标 Commit 等于 Approved Head SHA。

在真实人工审查周期完成前，禁止自动合并、自动发布或新增第二 Agent Provider。
