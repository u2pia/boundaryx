import assert from 'node:assert/strict'
import { LocalEvaluationProvider } from '../src/adapters/local-evaluation-provider.ts'

const provider = new LocalEvaluationProvider()
const experiment = provider.bind({
  experimentId: 'EXP-001',
  suiteId: 'EVS-014',
  datasetRef: 'dataset://enterprise-identity-regressions',
  datasetVersion: '2026-09-22.3',
  candidateRef: 'mock-model://reasoning-medium+orchestrator-workers-v3',
  traceRef: 'session://run-eval/transcript',
  graderRefs: [
    { graderId: 'grader://identity-invariants', version: '3', type: 'deterministic' },
    { graderId: 'grader://review-quality', version: '1', type: 'model' },
  ],
  trialCount: 3,
  environmentDigest: 'fnv1a:environment',
})

assert.equal(experiment.providerRef, provider.id)
assert.match(experiment.experimentDigest, /^fnv1a:/)
assert.equal(experiment.datasetVersion, '2026-09-22.3')
assert.equal(experiment.graderRefs.length, 2)

const unstable = provider.summarize([
  { trialId: 'T-1', taskId: 'TASK-1', result: 'passed' },
  { trialId: 'T-2', taskId: 'TASK-1', result: 'failed' },
  { trialId: 'T-3', taskId: 'TASK-1', result: 'passed' },
])
assert.deepEqual(unstable, { passed: 2, failed: 1, unknown: 0, passAtK: 100, passPowerK: 0 })

const stable = provider.summarize([
  { trialId: 'T-4', taskId: 'TASK-1', result: 'passed' },
  { trialId: 'T-5', taskId: 'TASK-1', result: 'passed' },
  { trialId: 'T-6', taskId: 'TASK-1', result: 'passed' },
])
assert.deepEqual(stable, { passed: 3, failed: 0, unknown: 0, passAtK: 100, passPowerK: 100 })

console.log(`evaluation provider smoke passed · ${experiment.datasetRef}@${experiment.datasetVersion} · pass@3 ${unstable.passAtK}% · pass³ ${unstable.passPowerK}%`)
