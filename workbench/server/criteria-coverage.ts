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
   * files (`pre_existing`, including `@baseline` re-runs), a check reported externally (the author is forbidden from
   * reporting checks on their own proposal), or an isolated holdout evaluation: see `independenceOf`. A build only
   * counts for a criterion that explicitly names nothing but builds: it shows the code builds, not how it behaves.
   * DOMAIN_MODEL.md §5.6: `added_by_run` evidence alone cannot prove a critical criterion.
   */
  independent?: boolean
  /**
   * The only independent result is the base revision's tests re-run (`@baseline`) while the run changed the tests.
   * That shows the old tests still pass, not that anything but tests the run wrote exercises this criterion, so the
   * approving reviewer confirms it by name after reading those tests (`needs_test_review`).
   */
  regressionOnly?: boolean
  /** Why no check could be mapped, so an unmapped criterion is explained rather than silently skipped. */
  unmappedReason?: string
}

export type CriterionStatus = 'passed' | 'self_graded' | 'needs_test_review' | 'failed' | 'pending' | 'unmapped' | 'awaiting_review'

// An `evaluation` check scores a dataset against manifest thresholds: the verdict is a deterministic comparison even
// when some metrics were produced by a model grader, so it can evidence either kind of criterion.
const kindsFor = { deterministic: ['test', 'build', 'evaluation'], model: ['evaluation'] } as const

export function mapCriteriaToChecks(intent: IntentVersion, checks: Array<{ name: string; kind: CheckKind; provenance?: string; conclusion?: string }>): CriterionCoverage[] {
  // An in-worktree evaluation is never independent: the grader imports the code under evaluation into its own process,
  // so that code can read the hidden dataset (it is in the worktree) and answer from it, and the leakage check only sees
  // answers copied into the change. A passing one is self-graded and a critical model criterion needs an override. Only
  // the isolated evaluator's result (`evaluation-isolated` with provenance `isolated`: holdout outside the repository,
  // subject sandboxed, Builder confined) is independent. The dataset guards still count: a dataset the run touched or
  // copied, or a holdout that could not be read, fails the criterion outright.
  const evaluationGuards = checks.filter((check) => ['evaluation-dataset-integrity', 'evaluation-dataset-leakage', 'evaluation-dataset-untouched', 'evaluation-holdout-integrity'].includes(check.name)).map((check) => check.name)
  const withGuards = (names: string[]) => checks.some((check) => check.kind === 'evaluation' && names.includes(check.name)) ? [...names, ...evaluationGuards] : names
  const isIndependent = (check: { kind: CheckKind; provenance?: string }) => check.kind === 'evaluation' ? check.provenance === 'isolated' : check.kind !== 'build' && (check.provenance === 'pre_existing' || check.provenance === 'external')
  const independenceOf = (mapped: Array<{ name: string; kind: CheckKind; provenance?: string }>, declared: boolean): Pick<CriterionCoverage, 'independent' | 'regressionOnly'> => {
    const behavioural = mapped.filter((check) => check.kind !== 'build')
    // The build command comes from the base revision's manifest, so a criterion its author says is about building
    // (it names only builds) is evidenced by it. Mapped by rule, a build says nothing about the criterion.
    if (!behavioural.length) return { independent: declared }
    const independent = behavioural.filter(isIndependent)
    const runEditedTests = behavioural.some((check) => check.kind === 'test' && check.provenance === 'all_tests')
    const regressionOnly = runEditedTests && independent.length > 0 && independent.every((check) => check.kind === 'test' && check.name.endsWith('@baseline'))
    return { independent: independent.length > 0, ...(regressionOnly ? { regressionOnly } : {}) }
  }
  return intent.acceptanceCriteria.map((criterion) => {
    const base = { criterionId: criterion.id, label: `AC-${criterion.ordinal}`, statement: criterion.statement, criticality: criterion.criticality, verificationType: criterion.verificationType, mapping: 'rule' as const }
    if (criterion.verificationType === 'human') return { ...base, checkNames: [] }
    if (criterion.verifiedBy?.length) {
      // A named check brings its `@baseline` re-run with it: that is where independence comes from when the run edited tests.
      const declared = { ...base, mapping: 'declared' as const }
      const missing = criterion.verifiedBy.filter((name) => !checks.some((check) => check.name === name))
      if (missing.length) return { ...declared, checkNames: [], unmappedReason: `Declared check ${missing.join(', ')} did not run; the project manifest must declare it.` }
      const mapped = checks.filter((check) => criterion.verifiedBy!.some((name) => check.name === name || check.name === `${name}@baseline`))
      return { ...declared, checkNames: withGuards(mapped.map((check) => check.name)), ...independenceOf(mapped, true) }
    }
    const kinds: readonly CheckKind[] = kindsFor[criterion.verificationType]
    const mapped = checks.filter((check) => kinds.includes(check.kind))
    const coverage: CriterionCoverage = { ...base, checkNames: withGuards(mapped.map((check) => check.name)) }
    if (!mapped.length) coverage.unmappedReason = criterion.verificationType === 'model' ? 'The project manifest declares no evaluation check, so a model-verified criterion has nothing to run.' : 'The project manifest declares no test, build or evaluation check.'
    if (mapped.length) Object.assign(coverage, independenceOf(mapped, false))
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
  if (coverage.independent === false) return 'self_graded'
  return coverage.regressionOnly ? 'needs_test_review' : 'passed'
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
