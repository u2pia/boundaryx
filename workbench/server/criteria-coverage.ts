import type { IntentVersion } from './types.ts'

export type CheckKind = 'test' | 'evaluation' | 'build' | 'integrity'

/**
 * How one acceptance criterion is evidenced. DOMAIN_MODEL.md §5.6 allows the AC → check mapping to come from a
 * person or from a deterministic rule, never from a model. Intents do not carry explicit mappings yet, so every
 * entry here is `rule`: deterministic criteria are covered by the manifest's test, build and evaluation checks
 * (and `@baseline` re-runs), model criteria by its evaluation checks, and human criteria by the approving review itself.
 */
export type CriterionCoverage = {
  criterionId: string
  label: string
  statement: string
  criticality: 'normal' | 'critical'
  verificationType: 'deterministic' | 'model' | 'human'
  mapping: 'rule'
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
