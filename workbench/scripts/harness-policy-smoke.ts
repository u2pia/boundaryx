import assert from 'node:assert/strict'
import { HarnessPolicy, type HarnessCandidate } from '../src/adapters/harness-policy.ts'

const candidates: HarnessCandidate[] = [
  { profileId: 'single', executionMode: 'prompt_chain', contextResetPolicy: 'continuous', requiresIndependentEvaluator: false, passRate: 0.8, p95DurationSeconds: 400, estimatedCostUsd: 2, evidenceRef: 'eval://single' },
  { profileId: 'evaluator', executionMode: 'evaluator_optimizer', contextResetPolicy: 'fresh_session_per_phase', requiresIndependentEvaluator: true, passRate: 0.93, p95DurationSeconds: 650, estimatedCostUsd: 4.8, evidenceRef: 'eval://evaluator' },
  { profileId: 'workers', executionMode: 'orchestrator_workers', contextResetPolicy: 'phase_boundary_compaction', requiresIndependentEvaluator: true, passRate: 0.96, p95DurationSeconds: 680, estimatedCostUsd: 5.4, evidenceRef: 'eval://workers' },
]

const policy = new HarnessPolicy()
const selection = policy.select({ modelRef: 'mock-model://reasoning-medium', maxCostUsd: 8, requireIndependentEvaluator: true }, candidates)
assert.equal(selection.selected.profileId, 'workers')
assert.equal(selection.considered.length, 3)
assert.equal(selection.modelContextBehavior, 'balanced')

const constrainedSelection = policy.select({ modelRef: 'mock-model://reasoning-medium', maxCostUsd: 5, requireIndependentEvaluator: true }, candidates)
assert.equal(constrainedSelection.selected.profileId, 'evaluator')
assert.throws(() => policy.select({ modelRef: 'mock-model://reasoning-medium', maxCostUsd: 1, requireIndependentEvaluator: true }, candidates))

const fragileSelection = policy.select({ modelRef: 'mock-model://fast-small', maxCostUsd: 8, requireIndependentEvaluator: true }, candidates)
assert.equal(fragileSelection.modelContextBehavior, 'fragile')
assert.equal(fragileSelection.selected.profileId, 'evaluator')

const compact = policy.decideContextReset({ policyId: 'workers:reset', policy: 'phase_boundary_compaction', usedTokens: 62_400, maxTokens: 80_000, phaseBoundary: true, evaluatorFeedbackPending: false })
assert.equal(compact.action, 'compact')
assert.equal(compact.trigger, 'token_pressure')

const fresh = policy.decideContextReset({ policyId: 'evaluator:reset', policy: 'fresh_session_per_phase', usedTokens: 20_000, maxTokens: 80_000, phaseBoundary: false, evaluatorFeedbackPending: true })
assert.equal(fresh.action, 'fresh_session')
assert.equal(fresh.trigger, 'evaluator_feedback')

const continued = policy.decideContextReset({ policyId: 'single:reset', policy: 'continuous', usedTokens: 70_000, maxTokens: 80_000, phaseBoundary: true, evaluatorFeedbackPending: false })
assert.equal(continued.action, 'continue')

console.log('harness policy smoke tests passed')
