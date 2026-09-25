/**
 * Intent 起草辅助：模版、验收标准解析与模糊度检查。
 *
 * 这里的动机不是表单体验。验收标准的 `criticality` 与 `verificationType` 会进入 `contentDigest`、Evidence
 * Package 和 Builder Agent 的 prompt（见 scripts/agents/codex-builder.mjs），所以「这条标准怎么被证明」必须由
 * 起草人声明，不能由 UI 代填。纯 TS 无框架依赖，因此 scripts/ 下的 smoke 可以直接导入。
 */

export type Criticality = 'normal' | 'critical'
export type VerificationType = 'deterministic' | 'model' | 'human'
export type ProductType = 'application' | 'agent_system'
export type RiskLevel = 'low' | 'medium' | 'high'

export type ParsedCriterion = {
  statement: string
  criticality: Criticality
  verificationType: VerificationType
  /** 行尾 `[验证: node-tests]` 点名的 Check（Project Manifest 里的名字）；不写则由规则映射。 */
  verifiedBy?: string[]
  /** 逐条建议，永不阻塞提交：模糊度判断靠启发式，误报的代价必须由人承担而不是由门禁承担。 */
  warnings: string[]
}

export type IntentDraft = {
  goal: string
  constraints: string[]
  riskLevel: RiskLevel
  criteria: ParsedCriterion[]
}

export type IntentDraftLint = {
  warnings: string[]
  /** 会被服务端以 400 拒绝的问题，前端提前显示，避免用户提交后才撞到。 */
  blockers: string[]
}

const verificationTags = new Map<string, VerificationType>([
  ['确定性', 'deterministic'],
  ['deterministic', 'deterministic'],
  ['模型', 'model'],
  ['model', 'model'],
  ['人工', 'human'],
  ['human', 'human'],
])

const criticalityTags = new Map<string, Criticality>([
  ['关键', 'critical'],
  ['critical', 'critical'],
  ['参考', 'normal'],
  ['一般', 'normal'],
  ['normal', 'normal'],
])

export const verificationLabels: Record<VerificationType, string> = {
  deterministic: '确定性',
  model: '模型',
  human: '人工',
}

export const criticalityLabels: Record<Criticality, string> = {
  critical: '关键',
  normal: '参考',
}

/**
 * 默认值是 `critical` + `deterministic`。默认成 `critical` 是有意的：DOMAIN_MODEL.md「Critical 评估失败时
 * 不得进入 Approved」意味着降级会关掉审批门禁，所以降级必须显式写 `[参考]`，不能由「忘记标注」触发。
 */
export const defaultCriticality: Criticality = 'critical'
export const defaultVerificationType: VerificationType = 'deterministic'

/**
 * 单条标准的长度上限，服务端同值校验。整条语句会进入 Agent prompt 与 Evidence Package，所以长度不能由起草人
 * 任意决定；而且超长本身就是「这条标准其实是好几条」的信号，应当拆开而不是放行。
 */
export const maximumStatementLength = 300

const vagueTerms = ['优化', '提升', '改进', '更好', '更快', '更强', '尽量', '尽可能', '合理', '稳定', '友好', '美观', '完善', '易用', '清晰', '大幅', '显著', '差不多', 'improve', 'better', 'optimi', 'faster', 'nicer', 'robust']

/** 一条标准能被确定性验证，得先有个能断言的东西：数值、阈值符号、单位，或者错误码 / 测试名这类标识符。 */
function hasVerifiableAnchor(statement: string) {
  if (/\d/.test(statement)) return true
  if (/[≥≤<>=%]/.test(statement)) return true
  if (/`[^`]+`/.test(statement)) return true
  return /[A-Za-z][A-Za-z0-9_.-]{2,}/.test(statement)
}

function findVagueTerms(statement: string) {
  const lowered = statement.toLowerCase()
  return vagueTerms.filter((term) => lowered.includes(term.toLowerCase()))
}

const checkNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** 至少 8 字且没有 `<...>` 占位符。与 server/criteria-coverage.ts 同值，服务端同样拒绝。 */
export function isSubstantiveHumanCriterion(statement: string) {
  const text = statement.trim()
  return !/[<＜][^<>＜＞]+[>＞]/u.test(text) && [...text].length >= 8
}

/** Mirrors the server: approving signs a human criterion only when the comment names its label (AC-2, ac 2, AC－2). */
export function mentionsCriterion(comment: string, label: string) {
  const ordinal = label.replace(/^AC-/u, '')
  return new RegExp(`(?<![A-Za-z0-9])AC[-－‐ ]?${ordinal}(?!\\d)`, 'iu').test(comment)
}

export function inspectStatement(statement: string, verificationType: VerificationType) {
  const warnings: string[] = []
  const placeholders = statement.match(/[<＜][^<>＜＞]+[>＞]/g)
  if (placeholders) warnings.push(`还有未替换的模版占位符 ${placeholders.join('、')}`)
  if (statement.length < 6) warnings.push('语句过短，看不出要验证什么')
  if (statement.length > maximumStatementLength) warnings.push(`语句 ${statement.length} 字，超过 ${maximumStatementLength} 字上限；这通常是几条标准写在了一行里`)
  const vague = findVagueTerms(statement)
  if (vague.length > 0 && !hasVerifiableAnchor(statement)) {
    warnings.push(`「${vague.join('、')}」无法判定通过与否，补一个数值、阈值或错误码`)
  }
  if (verificationType === 'deterministic' && !hasVerifiableAnchor(statement) && !placeholders) {
    warnings.push('标注为确定性验证，但语句里没有可断言的具体值；若本就要人判断，改用 [人工]')
  }
  return warnings
}

/**
 * 逐行解析验收标准。行首可以带任意数量、任意顺序的方括号标注。
 *
 * 遇到第一个未识别的方括号就停止解析标注，并把它连同其后的内容原样保留为语句。「打错字的标注」和「语句本身
 * 就以方括号开头」（`[POST /api/import] …`、`[边界] …`）在语法上无法区分，所以只能选不丢信息的那一侧：
 * 被切掉的文字会进入 contentDigest 与 Agent prompt，Agent 看到的就不再是起草人写下的那句话。
 */
export function parseAcceptanceCriteria(text: string): ParsedCriterion[] {
  const criteria: ParsedCriterion[] = []
  const seen = new Map<string, number>()

  for (const rawLine of text.split('\n')) {
    let rest = rawLine.trim()
    if (!rest) continue

    let criticality: Criticality | undefined
    let verificationType: VerificationType | undefined
    const warnings: string[] = []

    for (;;) {
      const tagMatch = rest.match(/^[[［]\s*([^\]］]{1,24}?)\s*[\]］]\s*/u)
      if (!tagMatch) break
      const tag = tagMatch[1].toLowerCase()
      const verification = verificationTags.get(tag)
      const criticalityTag = criticalityTags.get(tag)
      if (!verification && !criticalityTag) {
        warnings.push(`行首的 [${tagMatch[1]}] 不是已知标注，已作为语句内容保留；若想声明验证方式，把 [确定性] [模型] [人工] [参考] 写在它前面`)
        break
      }
      if (verification) {
        if (verificationType && verificationType !== verification) warnings.push(`同一行出现了两种验证方式，按最后一个 [${tagMatch[1]}] 处理`)
        verificationType = verification
      }
      if (criticalityTag) {
        if (criticality && criticality !== criticalityTag) warnings.push(`同一行出现了两种关键性标注，按最后一个 [${tagMatch[1]}] 处理`)
        criticality = criticalityTag
      }
      rest = rest.slice(tagMatch[0].length)
    }

    // 行尾的 [验证: a, b] 由人点名证明这条标准的 Check，替代按类型的规则映射（DOMAIN_MODEL.md §5.6）。
    const verifiedMatch = rest.match(/\s*[[［]\s*(?:验证|verify|verified by)\s*[:：]\s*([^\]］]*)[\]］]\s*$/iu)
    const verifiedBy = verifiedMatch ? verifiedMatch[1].split(/[,，、\s]+/u).filter(Boolean) : undefined
    if (verifiedMatch) rest = rest.slice(0, verifiedMatch.index)
    const statement = rest.trim()
    if (!statement) {
      criteria.push({ statement: '', criticality: criticality ?? defaultCriticality, verificationType: verificationType ?? defaultVerificationType, warnings: [...warnings, '只有标注没有语句'] })
      continue
    }

    const resolvedVerification = verificationType ?? defaultVerificationType
    const duplicateOf = seen.get(statement)
    if (duplicateOf !== undefined) warnings.push(`与第 ${duplicateOf} 条重复`)
    else seen.set(statement, criteria.length + 1)

    criteria.push({
      statement,
      criticality: criticality ?? defaultCriticality,
      verificationType: resolvedVerification,
      ...(verifiedBy ? { verifiedBy } : {}),
      warnings: [...warnings, ...inspectStatement(statement, resolvedVerification)],
    })
  }

  return criteria
}

/** 把一行一条的文本框内容拆成数组，约束与上下文路径都用这个。 */
export function splitLines(text: string) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

export function lintIntentDraft(draft: IntentDraft): IntentDraftLint {
  const warnings: string[] = []
  const blockers: string[] = []

  if (draft.criteria.length === 0) {
    blockers.push('至少需要一条验收标准')
  }
  // 空语句会被服务端拒绝。宁可在这里拦住，也不要在提交时悄悄丢掉一行——起草人会以为它被收下了。
  const emptyStatements = draft.criteria.filter((criterion) => !criterion.statement.trim()).length
  if (emptyStatements > 0) blockers.push(`有 ${emptyStatements} 行只写了标注没有语句`)

  const tooLong = draft.criteria.filter((criterion) => criterion.statement.length > maximumStatementLength).length
  if (tooLong > 0) blockers.push(`有 ${tooLong} 条标准超过 ${maximumStatementLength} 字，请拆成多条`)

  // 与 server/criteria-coverage.ts 的 isSubstantiveHumanCriterion 同一条规则：关键 [人工] 标准是批准人签署的那句话，
  // 「ok」「人工审核通过」签下去什么也没说。
  const placeholderHuman = draft.criteria.filter((criterion) => criterion.statement.trim() && criterion.verificationType === 'human' && criterion.criticality === 'critical' && !isSubstantiveHumanCriterion(criterion.statement))
  if (placeholderHuman.length > 0) blockers.push(`关键 [人工] 标准要写清批准人判断什么（至少 8 字、不含 <占位符>）：${placeholderHuman.map((criterion) => `「${criterion.statement.trim()}」`).join('、')}`)
  const declared = draft.criteria.filter((criterion) => criterion.verifiedBy)
  if (declared.some((criterion) => criterion.verificationType === 'human')) blockers.push('[人工] 标准由批准意见签署，不能再用 [验证: …] 点名 Check')
  const badNames = declared.flatMap((criterion) => criterion.verifiedBy ?? []).filter((name) => !checkNamePattern.test(name))
  if (declared.some((criterion) => !criterion.verifiedBy?.length)) blockers.push('[验证: …] 里没有写 Check 名')
  if (badNames.length > 0) blockers.push(`[验证: …] 里的 ${badNames.join('、')} 不是合法的 Check 名（字母、数字、. _ -；不写 @baseline，基线复跑会自动跟随）`)

  // 以下两条与 server/database.ts 的同名不变量一致。前端只是提前显示，真正的拒绝在服务端，绕过前端也拦得住。
  //
  // DOMAIN_MODEL.md：高风险 Intent 必须定义人工审批要求。承载它的那条 [人工] 标准必须是关键项——
  // 用一条自己声明「不阻塞合并」的 [参考][人工] 来满足「必须有人工审批」是自相矛盾的。
  if (draft.riskLevel === 'high' && !draft.criteria.some((criterion) => criterion.verificationType === 'human' && criterion.criticality === 'critical')) {
    blockers.push('高风险 Intent 必须至少有一条关键的 [人工] 验收标准（不能是 [参考]），用来承载人工审批要求')
  }

  // 非低风险必须至少有一条关键标准。全部写成 [参考] 的 Intent 今天不产生影响，但等审批门禁读取 criticality
  // 的那天，它会静默绕过门禁，而那时不会有人回头审计历史 Intent。
  const criticalCriteria = draft.criteria.filter((criterion) => criterion.criticality === 'critical')
  if (draft.criteria.length > 0 && criticalCriteria.length === 0) {
    if (draft.riskLevel === 'low') warnings.push('没有任何关键标准，这个 Intent 不会阻塞任何审批')
    else blockers.push('中、高风险 Intent 至少要有一条关键标准；全部写成 [参考] 等于声明这次变更不需要任何门禁')
  }
  if (draft.riskLevel !== 'low' && criticalCriteria.length > 0 && criticalCriteria.every((criterion) => criterion.verificationType === 'model')) {
    warnings.push('关键标准全部依赖模型评估；模型评估不应成为高风险变更的唯一关键证据')
  }

  const goal = draft.goal.trim()
  if (goal.length > 0 && goal.length < 15) warnings.push('目标过短，写清楚「改完之后系统的可观察行为是什么」')
  else if (goal.length > 0 && !hasVerifiableAnchor(goal)) warnings.push('目标里没有具体数值、错误码或标识符，Agent 只能靠猜')
  const vagueGoalTerms = findVagueTerms(goal)
  if (vagueGoalTerms.length > 0 && !hasVerifiableAnchor(goal)) warnings.push(`目标里的「${vagueGoalTerms.join('、')}」需要换成可观察的描述`)

  if (draft.constraints.length === 0) warnings.push('没有声明约束；Agent 会默认可以改任何文件、加任何依赖')

  const withWarnings = draft.criteria.filter((criterion) => criterion.warnings.length > 0).length
  if (withWarnings > 0) warnings.push(`${withWarnings} 条验收标准仍有待补充，见下方逐条提示`)

  return { warnings, blockers }
}

export type IntentTemplate = {
  label: string
  hint: string
  goal: string
  constraints: string
  criteria: string
}

/**
 * 模版故意留着 `<...>` 占位符：套用之后 linter 会立刻报「还有未替换的模版占位符」，把模版从「可以直接提交的
 * 空话」变成一份必须逐项填完的清单。约束部分沿用 scripts/run-real-case.ts 里那组真实跑通过的约束。
 */
export const intentTemplates: Record<ProductType, IntentTemplate> = {
  application: {
    label: '开发 App',
    hint: '功能、质量与运行结果',
    goal: '实现 <功能>：<正常输入> 时 <可观察结果>，<边界条件> 时 <具体错误码>。',
    constraints: [
      '不得删除、跳过或弱化既有测试',
      '不得新增外部依赖或使用网络',
      '只修改当前 Git Worktree',
      '保持对外返回结构兼容',
    ].join('\n'),
    criteria: [
      '[确定性] 正常路径：给定 <输入>，返回 <可断言的输出>',
      '[确定性] 边界：<超出阈值的输入> 返回 <错误码>',
      '[确定性] 回归：既有测试 <测试文件或用例名> 仍然全部通过',
      '[人工] <需要人判断的部分，例如错误文案是否符合产品语气>',
      '[参考] <希望做到但不阻塞合并的部分>',
    ].join('\n'),
  },
  agent_system: {
    label: '开发 Agent System',
    hint: '数据集、轨迹、工具策略与可靠性',
    goal: '让 <Agent> 在 <数据集或输入分布> 上达到 <指标> ≥ <阈值>，且不得 <明确禁止的行为>。',
    constraints: [
      '不得访问 holdout 数据集',
      '不得调用工具白名单以外的工具',
      '单次运行的 token 与时长不超过 <预算>',
      '所有外部调用必须留下可回放轨迹',
    ].join('\n'),
    criteria: [
      '[确定性] 在 <数据集> 上 <指标> ≥ <阈值>，评估脚本可重复运行',
      '[确定性] 工具调用全部落在白名单内，越权调用被拒绝并记录',
      '[确定性] 轨迹可回放，包含每次工具调用的输入输出摘要',
      '[模型] <主观质量维度> 评分不低于 <分数>（模型评估不得作为高风险变更的唯一关键证据）',
      '[人工] 失败模式抽样审查：<抽样规模> 条中无不可接受行为',
      '[参考] <希望观察但不阻塞合并的指标，例如单条平均 token 消耗与 p95 时延>',
    ].join('\n'),
  },
}

/** 语法说明，表单和 README 共用一份文案。 */
export const criteriaSyntaxHint = '行首可标注 [确定性] [模型] [人工] 声明如何验证，[参考] 表示不阻塞合并；不写标注默认按「关键 · 确定性」处理。行尾写 [验证: node-tests] 可点名由哪个 Check 证明，不写则按类型规则映射。'
