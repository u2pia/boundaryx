import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'aperture-pilot-report-'))
const cases = join(root, 'cases')
const output = join(root, 'output')
const outcomesPath = join(root, 'outcomes.json')
mkdirSync(cases)

try {
  for (let index = 1; index <= 10; index += 1) writeFileSync(join(cases, `case-${index}.json`), JSON.stringify({
    caseId: `case-${index}`,
    result: 'release_approved',
    pilotEligible: true,
    pilotMetrics: {
      review: { assignmentToDecisionSeconds: 120 + index, briefToDecisionSeconds: 60 + index, evidenceToDecisionSeconds: 30 + index, evidenceExpandedBeforeDecision: true, reworkRounds: index === 10 ? 1 : 0 },
      context: { controlPlaneInjected: 5, builderReported: 1, undeclared: 0, rejected: 0, skillsLoaded: 1, skillsRejected: 0 },
    },
  }))
  writeFileSync(outcomesPath, JSON.stringify({
    pilotId: 'smoke-pilot',
    baseline: { medianReviewerActiveMinutes: 20, escapedDefectsPer10Changes: 1, rollbacksPer10Changes: 0 },
    outcomes: Array.from({ length: 10 }, (_, index) => ({ caseId: `case-${index + 1}`, reviewerActiveMinutes: 10, reviewerPageSwitches: 2, escapedDefects: 0, rollbacks: 0, manualRemediations: 0 })),
  }))
  execFileSync(process.execPath, ['--experimental-strip-types', resolve(dirname(fileURLToPath(import.meta.url)), 'summarize-pilot.ts')], { env: { ...process.env, PILOT_CASE_REPORT_DIR: cases, PILOT_OUTCOMES_FILE: outcomesPath, PILOT_REPORT_DIR: output }, stdio: 'pipe' })
  const summary = JSON.parse(readFileSync(join(output, 'pilot-summary.json'), 'utf8')) as { sample: { eligibleReleaseApproved: number; manualOutcomes: number }; automated: { evidenceExpandedApprovalRate: number; totalReworkRounds: number }; gates: Record<string, string>; recommendation: string }
  assert.equal(summary.sample.eligibleReleaseApproved, 10)
  assert.equal(summary.sample.manualOutcomes, 10)
  assert.equal(summary.automated.evidenceExpandedApprovalRate, 1)
  assert.equal(summary.automated.totalReworkRounds, 1)
  assert.deepEqual(summary.gates, { evidenceGuardrail: 'met', reviewEffortTarget: 'met', qualityGuardrail: 'met' })
  assert.equal(summary.recommendation, 'continue_pilot')
  console.log('pilot report smoke passed · 10 Changes · automated and manual gates evaluated')
} finally {
  rmSync(root, { recursive: true, force: true })
}
