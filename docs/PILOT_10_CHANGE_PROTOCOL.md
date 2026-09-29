# 10-Change 真实团队试点协议

日期：2026-09-29

## 1. 目的

本试点验证的不是“Agent 能否写代码”，而是 **AI Native SDLC Control Plane 是否降低可信审查成本，同时不恶化质量**。

试点固定观察同一真实仓库、同一小团队连续进入条件的 10 个 Change，覆盖 Intent → Context → Run → Evaluation → Evidence → Review → Merge → Release → Event Log。不得只挑成功概率高的任务，也不得用同一演示任务重复十次代替真实样本。

## 2. 进入条件

- 来自团队真实待办，且按进入时间连续纳入；
- Product Type 为 Application 或 Agent；
- Risk 为 low / medium，第一轮不纳入紧急生产修复；
- 有可执行 Check，Application 还必须有构建产物绑定；
- 作者、Reviewer、Release Approver 身份可区分；
- 合并后至少观察 7 天，记录逃逸缺陷、回滚和人工补救。

不满足条件的任务记录排除原因，但不计入 10 个有效样本。

## 3. 基线

开始前，从同一仓库最近 10 个可比 Change 记录：

- Reviewer Active Minutes 中位数；
- 每 10 个 Change 的逃逸缺陷数；
- 每 10 个 Change 的回滚数；
- Reviewer 为确认同一 Revision 的页面切换次数（若历史数据不可得，从试点开始记录但不做前后比较）。

Assignment → Decision、Decision Brief → Decision 都是流程经过时间，不是 Reviewer Active Minutes。Reviewer Active Minutes 由 Reviewer 在终态决定后人工记录。

## 4. 每个 Change 的记录

`npm run case:real` 是脚本化闭环验收，不计入真实试点样本。真实成员完成 Intent、Run、Reviewer 决定、合并和 Release Approval 后，用只读采集命令生成样本：

```bash
cd workbench
PILOT_CHANGE_PROPOSAL_ID=CP-... \
PILOT_USERNAME=pilot-observer \
PILOT_PASSWORD='...' \
PILOT_HUMAN_ATTESTATION=true \
PILOT_ATTESTED_BY='pilot-owner' \
npm run pilot:capture
```

Team Identity 模式可改为提供已有只读会话：`PILOT_SESSION_COOKIE='aperture_session=...'`。采集账号必须能读取该项目的 Decision Brief、Release Candidate 和 Event Log；脚本不会写入审批或修改业务状态。`PILOT_HUMAN_ATTESTATION` 是显式治理声明：声明人确认 Reviewer 与 Release Approver 的决定由真人完成，而不是 `case:real` 或其他自动客户端代点。缺少声明时报告自动排除。

`pilot:capture` 写入 `output/pilot-cases/<case-id>.json`，包含：

- Decision Brief、Evidence 和终态决定的时间关系；
- 是否在批准前展开 Evidence；
- Changes Requested / 返工轮次；
- Context 注入、Builder 上报、未声明读取和拒绝次数；
- Skill 加载与拒绝次数；
- Evidence、Merge Evidence、Artifact、Release Candidate 和 Event Chain 摘要。

Reviewer 在观察窗口结束后补录：

- `reviewerActiveMinutes`；
- `reviewerPageSwitches`；
- `escapedDefects`；
- `rollbacks`；
- `manualRemediations`；
- 必要的定性说明。

只有同时满足独立 Reviewer、Decision Brief / Evidence 在决定前打开、Merge / Release 摘要连续且 Event Chain 完整的 Change 才标记为 `pilotEligible=true`。不满足的报告保留排除原因，但不进入有效样本。

复制 `workbench/scripts/fixtures/pilot-outcomes.example.json` 为 `output/pilot/pilot-outcomes.json`，用真实 `caseId` 填写。

## 5. 汇总

```bash
cd workbench
npm run pilot:report
```

产物：

- `output/pilot/pilot-summary.json`
- `output/pilot/pilot-summary.md`

汇总器只读取 `output/pilot-cases/`，并只把 `pilotEligible=true`、`result=release_approved` 且含试点指标的报告计为有效样本；`case:real` 产出的脚本化验收报告不会混入。缺少人工结果时会列出 `missingOutcomeCaseIds`，不会把未知值当作零。

## 6. 判断门槛

达到 10 个有效 Change 且 10 个都完成观察后再作结论：

1. **审查投入**：Reviewer Active Minutes 中位数相对基线下降至少 30%；
2. **Evidence 护栏**：批准前展开 Evidence 的比例至少 70%；低于 50% 直接判定为橡皮章风险；
3. **质量护栏**：每 10 个 Change 的逃逸缺陷和回滚均不得高于基线；
4. **返工可解释**：Changes Requested 必须能追溯到确定 Revision、Evidence 和 Reviewer；
5. **治理可观察**：Context / Skill 拒绝与未声明读取必须进入报告，不能静默丢失。

任一核心门槛失败，暂停新增功能，回到 Intent、Evidence 或 Review 工作流复盘产品楔子。样本不足或人工结果不全时，结论只能是继续收集，不能宣布成功。

## 7. 试点边界

- 不因试点新增默认导航页、Provider 或通用项目管理功能；
- 不开启自动合并或自动发布；
- 不把脚本化 Reviewer 当作真实采用数据；
- 不以生成代码量、Prompt 数量或 Agent 调用次数作为成功指标；
- 失败案例、打回和中止都保留，不从样本中删除。
