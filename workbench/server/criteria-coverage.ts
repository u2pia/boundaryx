import type { IntentVersion } from './types.ts'

export type CheckKind = 'test' | 'evaluation' | 'build' | 'integrity'

/**
 * How one acceptance criterion is evidenced. DOMAIN_MODEL.md §5.6 allows the AC → check mapping to come from a
 * person or from a deterministic rule, never from a model. `declared`: the Intent author named the checks
 * (`verifiedBy`), and a named check that did not run leaves the criterion unmapped rather than falling back to the
 * rule. `rule`: deterministic criteria are covered by the manifest's test, build and evaluation checks (and
 * `@baseline` re-runs), model criteria by its evaluation checks, and human criteria by the approving review itself.
 */
export type CriterionCoverage = {
  criterionId: string
  label: string
  statement: string
  criticality: 'normal' | 'critical'
  verificationType: 'deterministic' | 'model' | 'human'
  mapping: 'rule' | 'declared'
  checkNames: string[]
  /**
   * At least one mapped result does not depend on anything the run authored: a test run on the base revision's test
   * files (`pre_existing`, including `@baseline` re-runs), a build, or an evaluation whose hidden dataset was verified
   * unchanged, or a check reported externally (the author is forbidden from reporting checks on their own proposal).
   * DOMAIN_MODEL.md §5.6: `added_by_run` evidence alone cannot prove a critical criterion.
   */
  independent?: boolean
  /** Why no check could be mapped, so an unmapped criterion is explained rather than silently skipped. */
  unmappedReason?: string
}

export type CriterionStatus = 'passed' | 'self_graded' | 'failed' | 'pending' | 'unmapped' | 'awaiting_review'

// An `evaluation` check scores a dataset against manifest thresholds: the verdict is a deterministic comparison even
// when some metrics were produced by a model grader, so it can evidence either kind of criterion.
const kindsFor = { deterministic: ['test', 'build', 'evaluation'], model: ['evaluation'] } as const

export function mapCriteriaToChecks(intent: IntentVersion, checks: Array<{ name: string; kind: CheckKind; provenance?: string; conclusion?: string }>): CriterionCoverage[] {
  const datasetVerified = checks.some((check) => check.name === 'evaluation-dataset-integrity' && check.conclusion === 'success')
  const isIndependent = (check: { kind: CheckKind; provenance?: string }) => check.kind === 'build' || check.provenance === 'pre_existing' || check.provenance === 'external' || (check.kind === 'evaluation' && datasetVerified)
  return intent.acceptanceCriteria.map((criterion) => {
    const base = { criterionId: criterion.id, label: `AC-${criterion.ordinal}`, statement: criterion.statement, criticality: criterion.criticality, verificationType: criterion.verificationType, mapping: 'rule' as const }
    if (criterion.verificationType === 'human') return { ...base, checkNames: [] }
    if (criterion.verifiedBy?.length) {
      // A named check brings its `@baseline` re-run with it: that is where independence comes from when the run edited tests.
      const declared = { ...base, mapping: 'declared' as const }
      const missing = criterion.verifiedBy.filter((name) => !checks.some((check) => check.name === name))
      if (missing.length) return { ...declared, checkNames: [], unmappedReason: `Declared check ${missing.join(', ')} did not run; the project manifest must declare it.` }
      const mapped = checks.filter((check) => criterion.verifiedBy!.some((name) => check.name === name || check.name === `${name}@baseline`))
      return { ...declared, checkNames: mapped.map((check) => check.name), independent: mapped.some(isIndependent) }
    }
    const kinds: readonly CheckKind[] = kindsFor[criterion.verificationType]
    const mapped = checks.filter((check) => kinds.includes(check.kind))
    const coverage: CriterionCoverage = { ...base, checkNames: mapped.map((check) => check.name) }
    if (!mapped.length) coverage.unmappedReason = criterion.verificationType === 'model' ? 'The project manifest declares no evaluation check, so a model-verified criterion has nothing to run.' : 'The project manifest declares no test, build or evaluation check.'
    if (mapped.length) coverage.independent = mapped.some(isIndependent)
    return coverage
  })
}

export function criterionStatus(coverage: CriterionCoverage, checks: Array<{ name: string; status: string; conclusion?: string }>): CriterionStatus {
  if (coverage.verificationType === 'human') return 'awaiting_review'
  if (!coverage.checkNames.length) return 'unmapped'
  const byName = new Map(checks.map((check) => [check.name, check]))
  const mapped = coverage.checkNames.map((name) => byName.get(name))
  if (mapped.some((check) => !check || check.status !== 'completed')) return 'pending'
  // A neutral (skipped) result proves nothing, so only an unbroken run of successes counts as passing.
  if (!mapped.every((check) => check?.conclusion === 'success')) return 'failed'
  return coverage.independent === false ? 'self_graded' : 'passed'
}

/**
 * A critical human criterion is what the approver signs, so it has to say what they judge: no template placeholder
 * and at least 8 characters, which rules out 「ok」「人工审核通过」 and the like. Deterministic and model criteria have
 * checks to keep them honest; this one only has its wording. Same rule as src/intent-templates.ts, which blocks it
 * before submission.
 */
export function isSubstantiveHumanCriterion(statement: string) {
  const text = statement.trim()
  return !/[<＜][^<>＜＞]+[>＞]/u.test(text) && [...text].length >= 8
}

/** Whether a review comment names criterion `AC-n` (not AC-n0), which is how an approval signs a human criterion. */
export function mentionsCriterion(comment: string, label: string) {
  const ordinal = label.replace(/^AC-/u, '')
  return new RegExp(`(?<![A-Za-z0-9])AC[-－‐ ]?${ordinal}(?!\\d)`, 'iu').test(comment)
}
