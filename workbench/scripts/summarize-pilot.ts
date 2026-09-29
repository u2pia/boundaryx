import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type CaseReport = {
  caseId: string
  result: string
  pilotEligible?: boolean
  pilotMetrics?: {
    review: {
      assignmentToDecisionSeconds?: number
      briefToDecisionSeconds?: number
      evidenceToDecisionSeconds?: number
      evidenceExpandedBeforeDecision: boolean
      reworkRounds: number
    }
    context: { controlPlaneInjected: number; builderReported: number; undeclared: number; rejected: number; skillsLoaded: number; skillsRejected: number }
  }
}

type PilotOutcomes = {
  pilotId?: string
  baseline?: { medianReviewerActiveMinutes?: number; escapedDefectsPer10Changes?: number; rollbacksPer10Changes?: number }
  outcomes?: Array<{ caseId: string; reviewerActiveMinutes: number; reviewerPageSwitches: number; escapedDefects: number; rollbacks: number; manualRemediations: number; notes?: string }>
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const reportDirectory = resolve(process.env.PILOT_CASE_REPORT_DIR ?? join(repositoryRoot, 'output/pilot-cases'))
const outputDirectory = resolve(process.env.PILOT_REPORT_DIR ?? join(repositoryRoot, 'output/pilot'))
const outcomesPath = resolve(process.env.PILOT_OUTCOMES_FILE ?? join(outputDirectory, 'pilot-outcomes.json'))

const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return undefined
  return sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}

const reports = existsSync(reportDirectory)
  ? readdirSync(reportDirectory).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(join(reportDirectory, name), 'utf8')) as CaseReport)
  : []
const eligible = reports.filter((report) => report.pilotEligible === true && report.result === 'release_approved' && report.pilotMetrics)
const outcomes = existsSync(outcomesPath) ? JSON.parse(readFileSync(outcomesPath, 'utf8')) as PilotOutcomes : {}
const outcomeByCase = new Map((outcomes.outcomes ?? []).map((outcome) => [outcome.caseId, outcome]))
const annotated = eligible.flatMap((report) => {
  const outcome = outcomeByCase.get(report.caseId)
  return outcome ? [{ report, outcome }] : []
})
const sampleSize = eligible.length
const targetSize = 10
const evidenceExpandedCount = eligible.filter((report) => report.pilotMetrics!.review.evidenceExpandedBeforeDecision).length
const evidenceExpandedApprovalRate = sampleSize ? evidenceExpandedCount / sampleSize : undefined
const firstPassApprovalCount = eligible.filter((report) => report.pilotMetrics!.review.reworkRounds === 0).length
const contextIssueCount = eligible.filter((report) => report.pilotMetrics!.context.undeclared > 0 || report.pilotMetrics!.context.rejected > 0 || report.pilotMetrics!.context.skillsRejected > 0).length
const reviewerActiveMedian = median(annotated.map(({ outcome }) => outcome.reviewerActiveMinutes))
const baselineReviewMedian = outcomes.baseline?.medianReviewerActiveMinutes
const reviewEffortReduction = reviewerActiveMedian !== undefined && baselineReviewMedian !== undefined && baselineReviewMedian > 0 ? (baselineReviewMedian - reviewerActiveMedian) / baselineReviewMedian : undefined
const escapedDefects = annotated.reduce((total, { outcome }) => total + outcome.escapedDefects, 0)
const rollbacks = annotated.reduce((total, { outcome }) => total + outcome.rollbacks, 0)
const manualRemediations = annotated.reduce((total, { outcome }) => total + outcome.manualRemediations, 0)
const normalizedEscapedDefects = annotated.length ? escapedDefects * 10 / annotated.length : undefined
const normalizedRollbacks = annotated.length ? rollbacks * 10 / annotated.length : undefined
const evidenceGuardrail = sampleSize < targetSize || evidenceExpandedApprovalRate === undefined ? 'not_evaluable' : evidenceExpandedApprovalRate < 0.5 ? 'failed' : evidenceExpandedApprovalRate >= 0.7 ? 'met' : 'warning'
const reviewEffortTarget = annotated.length < targetSize || reviewEffortReduction === undefined ? 'not_evaluable' : reviewEffortReduction >= 0.3 ? 'met' : 'failed'
const qualityGuardrail = annotated.length < targetSize || normalizedEscapedDefects === undefined || normalizedRollbacks === undefined || outcomes.baseline?.escapedDefectsPer10Changes === undefined || outcomes.baseline?.rollbacksPer10Changes === undefined
  ? 'not_evaluable'
  : normalizedEscapedDefects <= outcomes.baseline.escapedDefectsPer10Changes && normalizedRollbacks <= outcomes.baseline.rollbacksPer10Changes ? 'met' : 'failed'
const recommendation = sampleSize < targetSize
  ? 'continue_collecting'
  : annotated.length < targetSize
    ? 'collect_manual_outcomes'
    : [evidenceGuardrail, reviewEffortTarget, qualityGuardrail].includes('failed')
      ? 'pause_and_reassess'
      : [evidenceGuardrail, reviewEffortTarget, qualityGuardrail].every((status) => status === 'met')
        ? 'continue_pilot'
        : 'inconclusive'

const summary = {
  pilotId: outcomes.pilotId ?? '10-change-pilot',
  generatedAt: new Date().toISOString(),
  sample: { target: targetSize, discoveredReports: reports.length, eligibleReleaseApproved: sampleSize, manualOutcomes: annotated.length, excludedReports: reports.length - sampleSize },
  automated: {
    medianAssignmentToDecisionSeconds: median(eligible.flatMap((report) => report.pilotMetrics!.review.assignmentToDecisionSeconds ?? [])),
    medianBriefToDecisionSeconds: median(eligible.flatMap((report) => report.pilotMetrics!.review.briefToDecisionSeconds ?? [])),
    medianEvidenceToDecisionSeconds: median(eligible.flatMap((report) => report.pilotMetrics!.review.evidenceToDecisionSeconds ?? [])),
    evidenceExpandedApprovalCount: evidenceExpandedCount,
    evidenceExpandedApprovalRate,
    firstPassApprovalCount,
    firstPassApprovalRate: sampleSize ? firstPassApprovalCount / sampleSize : undefined,
    totalReworkRounds: eligible.reduce((total, report) => total + report.pilotMetrics!.review.reworkRounds, 0),
    contextIssueCount,
    contextIssueRate: sampleSize ? contextIssueCount / sampleSize : undefined,
  },
  manual: {
    baselineMedianReviewerActiveMinutes: baselineReviewMedian,
    medianReviewerActiveMinutes: reviewerActiveMedian,
    reviewEffortReduction,
    medianReviewerPageSwitches: median(annotated.map(({ outcome }) => outcome.reviewerPageSwitches)),
    escapedDefects,
    rollbacks,
    manualRemediations,
    escapedDefectsPer10Changes: normalizedEscapedDefects,
    rollbacksPer10Changes: normalizedRollbacks,
  },
  gates: { evidenceGuardrail, reviewEffortTarget, qualityGuardrail },
  recommendation,
  missingOutcomeCaseIds: eligible.filter((report) => !outcomeByCase.has(report.caseId)).map((report) => report.caseId),
}

mkdirSync(outputDirectory, { recursive: true })
writeFileSync(join(outputDirectory, 'pilot-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
writeFileSync(join(outputDirectory, 'pilot-summary.md'), `# 10-Change Pilot Summary\n\n- Recommendation: \`${summary.recommendation}\`\n- Eligible Changes: \`${summary.sample.eligibleReleaseApproved}/${summary.sample.target}\`\n- Manual outcomes: \`${summary.sample.manualOutcomes}/${summary.sample.target}\`\n- Median Brief → Decision: \`${summary.automated.medianBriefToDecisionSeconds ?? 'n/a'}s\`\n- Evidence-expanded approvals: \`${summary.automated.evidenceExpandedApprovalCount}/${summary.sample.eligibleReleaseApproved}\`\n- First-pass approvals: \`${summary.automated.firstPassApprovalCount}/${summary.sample.eligibleReleaseApproved}\`\n- Median reviewer active time: \`${summary.manual.medianReviewerActiveMinutes ?? 'n/a'} min\`\n- Review effort reduction: \`${summary.manual.reviewEffortReduction === undefined ? 'n/a' : `${Math.round(summary.manual.reviewEffortReduction * 100)}%`}\`\n- Escaped defects / rollbacks / manual remediations: \`${summary.manual.escapedDefects} / ${summary.manual.rollbacks} / ${summary.manual.manualRemediations}\`\n- Gates: evidence \`${summary.gates.evidenceGuardrail}\`, review effort \`${summary.gates.reviewEffortTarget}\`, quality \`${summary.gates.qualityGuardrail}\`\n\nAssignment-to-decision and Brief-to-decision are elapsed workflow times, not reviewer active time. Reviewer active time remains a manual pilot measurement.\n`)
console.log(JSON.stringify(summary, null, 2))
