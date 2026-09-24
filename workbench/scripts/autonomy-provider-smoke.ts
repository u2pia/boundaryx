import assert from 'node:assert/strict'
import { LocalAutonomyDecisionProvider } from '../src/adapters/local-autonomy-provider.ts'
import type { AutonomyDecisionInput } from '../src/adapters/contracts.ts'

const provider = new LocalAutonomyDecisionProvider()
const safe: AutonomyDecisionInput = {
  candidateId: 'RC-LOW-RISK-1',
  programPhase: 'low_risk_auto_merge',
  riskTier: 'low',
  repositoryOnly: true,
  sandboxVerified: true,
  sessionIntegrityValid: true,
  evidenceVerified: true,
  evaluationFailed: 0,
  ciFailed: 0,
  unresolvedPolicyDenials: 0,
  externalEgress: false,
  destructiveChange: false,
  productionImpact: false,
  identityAnchored: true,
  humanReviewApproved: false,
}

const eligible = provider.evaluate(safe)
assert.equal(eligible.decision, 'auto_merge_eligible')
assert.match(eligible.inputDigest, /^fnv1a:/)
assert.match(eligible.decisionDigest, /^fnv1a:/)

const phaseOne = provider.evaluate({ ...safe, programPhase: 'human_approval' })
assert.equal(phaseOne.decision, 'human_review')
assert.ok(phaseOne.reasons.some((reason) => reason.includes('rollout phase')))

const unanchored = provider.evaluate({ ...safe, identityAnchored: false })
assert.equal(unanchored.decision, 'human_review')
assert.ok(unanchored.reasons.some((reason) => reason.includes('not anchored')))

const risky = provider.evaluate({ ...safe, riskTier: 'medium', externalEgress: true })
assert.equal(risky.decision, 'human_review')
assert.ok(risky.reasons.some((reason) => reason.includes('external network')))

const failed = provider.evaluate({ ...safe, evaluationFailed: 1, ciFailed: 2, humanReviewApproved: true })
assert.equal(failed.decision, 'blocked')
assert.ok(failed.reasons.some((reason) => reason.includes('does not erase')))

assert.notEqual(eligible.decisionDigest, phaseOne.decisionDigest)
console.log(`autonomy provider smoke passed · ${phaseOne.decision} phase one · ${eligible.decision} future lane`)
