# 对抗检查：Intent 模版与验收标准标注（2026-09-23）

对象：当天落地的 `src/intent-templates.ts`、`server/database.ts` 的 `createIntentVersion` 校验、`IntentsPage` 表单改造，约 400 行改动面。

**范围声明：这不是平台级对抗检查。** 平台其余部分（`server/` 16 个模块约 2757 行、`src/` 29 个文件约 6545 行）未被检查。风险最高而尚未覆盖的依次是：Evidence / Provenance 摘要链、Agent Run 隔离与 `.aperture/project.json` 的信任模型、Review 失效与批准状态机、认证与会话、明文密钥的爆炸半径。F2 的全仓 grep 只回答了"这个字段有没有消费者"这一个问题。

## 修复状态（2026-09-24）

| 项 | 状态 |
| --- | --- |
| F1 未识别标注被删掉 | **已修**：遇到第一个未识别方括号即停止解析，原样保留为语句 |
| F2.1 `[参考][人工]` 能满足高风险 | **已修**：承载人工审批的那条必须是 critical（服务端 + 前端） |
| F2.2 `[人工] ok` 能解锁高风险 | 未修：仍只有"语句过短"告警 |
| F2.3 界面把声明呈现为已生效 | **已修措辞**：预览与 Evidence 视图写明"声明"，Evidence 去掉了表示通过的绿色对勾；README 表格不再声称 critical 门禁已生效 |
| F2 根因：批准路径不读这两个字段 | **未修**，独立工作项，需先定义"签署一条 human 标准"的动作与事件 |
| F3 全部降级为 `[参考]` | **已修**：中、高风险必须至少一条 critical，错误码 `intent_requires_critical_criterion` |
| F4 语句无上限 | **已修**：300 字，服务端 + 前端 |
| F5 模糊词表偏中文 | 不修，接受为启发式代价，保持只告警 |
| F6「稳定」被排除 | **已修**：恢复进词表；real-case 那条标准改写为测试里的真实断言 `file_name_required → invalid_file_size → unsupported_file_type` |

每条已修项都有一个在回退时会变红的断言，F2.1 / F3 / F4 的服务端校验已逐一注掉验证过。

方法：不看自己的意图，只问「一个想走捷径的起草人能做什么」「哪条声明在代码里没有对应的执行」。每条结论都由探测确认，不靠印象。探测脚本见文末。

结论先说：**改动本身是净正向的（停止了伪造字段），但它引入的最大问题是一个诚实性缺口——界面和 Evidence 现在会显示「人工验证」，而系统并不保证那件事发生过。** 另有一处真实的静默数据丢失。

---

## F1（严重）未识别标注被**删掉**，不是保留

`parseAcceptanceCriteria` 对未识别标注执行 `rest = rest.slice(tagMatch[0].length)`，即把它从语句里切掉。

实测：

```
输入: [POST /api/import] 上传 6 MiB 文件返回 file_too_large
落库: "上传 6 MiB 文件返回 file_too_large"   ← 方法与路径消失
输入: [边界情况] 超过 5 MiB 返回 file_too_large
落库: "超过 5 MiB 返回 file_too_large"        ← 中文小标题消失
```

两处与实现不符的说明必须一并修正，否则以后没人知道哪个才是意图：

- `src/intent-templates.ts` 的函数注释写的是「未识别的标注**会保留为语句的一部分**并产生告警」——与代码相反；
- `README.md` 写的是「打错的标注会产生可见告警，而不是静默按默认值处理」——没说语句内容也会被吃掉。

为什么严重：被删掉的文本会进 `contentDigest`、Evidence Package 和 Builder Agent 的 prompt。Agent 看到的标准与人写下的标准不是同一句话，而这恰恰是这次改动想消灭的那类谎话，只是换了个位置。方括号在技术语境里太常见（HTTP 方法、路径、数组下标、`[边界]` 这类小标题），把整个行首方括号命名空间独占下来的代价当初估低了。

建议：识别失败时**不要 slice**，把原文整行保留并告警。告警文案改成「行首的 `[xxx]` 不是已知标注，已作为语句内容保留；若想声明验证方式请用 …」。判定「这是一个打错的标注」和「这是语句的一部分」在语法上不可区分，所以应当选择不丢信息的那一侧。

## F2（严重）`[人工]` 标签没有任何消费者，高风险不变量只强制了标签存在

全仓 grep：`criticality` / `verificationType` 的去向只有四个——SQLite 列、`contentDigest`、Evidence Package 的展示、Agent prompt 的一行文本。**审查与批准路径完全不读这两个字段。**

由此：

- `DOMAIN_MODEL.md` 的「Critical 评估失败时不得进入 Approved」（L301）在代码里**依然没有实现**。这次没有让它变好也没有变坏，但现在有了一个看起来像在治理它的字段，更容易被误认为已经解决。
- 新加的高风险不变量强制的是「存在一条 `verificationType === 'human'` 的记录」，不是「存在一个人工审批要求」，更不是「有人真的签过字」。实测 `[人工] ok` 即可解锁高风险提交，只有一条「语句过短」的告警，不阻塞。
- 校验里没有要求那条 human 标准是 `critical`。`[参考][人工] ok` 同样通过——用一条明确声明为「不阻塞合并」的标准，满足了「必须定义人工审批要求」。这是当前实现里最自相矛盾的一处。

建议（按性价比排序）：

1. 立刻可做：要求承载高风险的那条 human 标准必须是 `critical`。一行判断，消除上面第三点的自相矛盾。
2. 短期：给 human 标准最小实质性要求（长度下限比现在的 6 更高，或要求非占位符），并把它从 warning 升级为 blocker。启发式误报的代价在这里低于「假的人工审批」的代价。
3. 真正的修法：让 Review / Release 的批准路径读这两个字段——存在未签署的 `human` 关键标准时不得 Approved。在那之前，**任何界面上都不应该把 `[人工]` 呈现得像一个已生效的门禁**。现在的预览用绿/黄/紫三色徽章展示它，视觉上像是一个状态，实际只是一个意图声明。这一点建议尽快调整措辞。

## F3（中）新引入的降级能力是一个留给未来的后门

改动之前所有标准被硬编码成 `critical`，起草人无法降级。现在可以把整份 Intent 写成 `[参考]`，linter 只给一条 warning（「没有任何关键标准，这个 Intent 不会阻塞任何审批」），不阻塞。

由于 F2 里说的「没有消费者」，今天这不产生实际影响。风险在于时序：等哪天有人实现 L301 门禁，**今天起草的全 `[参考]` Intent 会静默绕过它**，而且那时不会有人回头审计历史 Intent。

当初选择「默认 `critical`、降级需显式」的理由是对的，但只解决了「忘记标注」，没解决「故意全部降级」。建议：非 low 风险的 Intent 至少要有一条 `critical` 标准，改为 blocker。

## F4（中）语句没有长度上限

`statement.length < 6` 有下限，没上限。实测 5000 字符的单条标准照常落库，并整条进入 Agent prompt。没有上限意味着 prompt 长度由起草人任意决定，也意味着 Evidence Package 的可读性不受控。建议加一个上限（如 300 字符）并作为 blocker——超长本身就是「这条标准其实是三条」的信号。

## F5（轻）模糊词表是中文优先的启发式，会系统性偏袒英文起草人

`vagueTerms` 有 17 个中文词、6 个英文词根。英文起草人写 `make the importer more reliable` 不会触发任何告警（`reliable` 不在表里），中文写「让导入更可靠」也不会。词表扩充没有终点，这是启发式的固有代价，接受即可——但**不要**因此把它升级成 blocker。当前「只告警」的设计在这一点上是对的，应保持。

## F6（轻）`稳定` 被刻意排除在模糊词之外

为了让 real-case 那条「无效输入返回稳定且可测试的错误顺序」不告警而排除了「稳定」。这是拿检查器去适配一条已有数据，方向反了。那条标准里真正提供可验证性的是「可测试的错误顺序」，不是「稳定」。建议恢复「稳定」进词表，并把 real-case 的那条标准改写得更具体——它本来就该更具体。

---

## 对这次改动的总体意见

值得肯定的是把问题定位成数据问题而不是表单体验问题，并且做了反向探测（注掉校验确认测试会红）。发现「去掉枚举校验后 SQLite CHECK 约束会以未分类 500 冒出」这一点证明了应用层校验的价值，这类验证应该继续做。

需要修正的思维习惯有两条：

1. **把「字段存在」当成「不变量已实现」。** F2 是这次最大的问题，而它在实现时是可以发现的——只要问一句「谁读这个字段」。以后给领域不变量写实现，必须同时指出消费者；没有消费者的不变量应当在文档和界面上明确标为「尚未生效」。
2. **为了让检查通过而修改检查的判据（F6）。** 数据先于检查的场景下，正确的顺序是改数据或明确记录例外，而不是悄悄把词从表里删掉。

---

## 明天的 review 从这里开始

优先级：F1 → F2.1 → F2.3 的措辞调整 → F3 → F4。F1 和 F2.1 都是几行代码加一条测试，应当先做完再谈其他。F2.3（让批准路径真正读这两个字段）是独立的一块工作，需要先确定 Review 流程里「签署一条 human 标准」是什么动作、留什么事件。

未完成的遗留项（与本次对抗检查无关，但同属 Intent→Agent 链路）：

- 浏览器端的视觉验收还没做（QA.md 已加两条），需要能登录 `.aperture-live` 的账号；
- 失败 Agent Run 的 stdout/stderr 摘要仍未持久化，provider 429 之类的失败在界面上看不到原因；
- Provider 表单里还没填可达的 provider + key，`npm run case:real` 未重跑。

## 探测脚本

```ts
import { parseAcceptanceCriteria, lintIntentDraft } from '<workbench>/src/intent-templates.ts'
const show = (label: string, text: string) => {
  const parsed = parseAcceptanceCriteria(text)
  console.log(`\n### ${label}`)
  for (const c of parsed) console.log(`  ${c.criticality}/${c.verificationType} | "${c.statement}" | warn=${c.warnings.join(' ;; ') || '(none)'}`)
}
show('合法的方括号开头语句', '[POST /api/import] 上传 6 MiB 文件返回 file_too_large')
show('中括号里是中文说明', '[边界情况] 超过 5 MiB 返回 file_too_large')
show('一个字满足高风险不变量', '[人工] ok')
show('全部降级为参考', '[参考] 超过 5 MiB 返回 file_too_large')
show('超长语句', '[确定性] ' + 'x'.repeat(5000))
```

配合一次全仓 grep 确认消费者：

```bash
grep -rn "verificationType\|criticality" --include="*.ts" --include="*.tsx" --include="*.mjs" server/ src/ scripts/
```
