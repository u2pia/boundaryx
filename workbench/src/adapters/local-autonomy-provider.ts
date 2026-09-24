import type { AutonomyDecision, AutonomyDecisionInput, AutonomyDecisionProvider } from './contracts.ts'
import { digestValue } from './event-integrity.ts'

const policyId = 'autonomy-risk-tier-v1'
const policyVersion = '1'

export class LocalAutonomyDecisionProvider implements AutonomyDecisionProvider {
  readonly id = 'autonomy://local-deterministic-v1'

  evaluate(input: AutonomyDecisionInput): AutonomyDecision {
    const reasons: string[] = []
    const requiredControls: string[] = []
    let decision: AutonomyDecision['decision'] = 'human_review'

    if (!input.sessionIntegrityValid) reasons.push('session integrity is not verified')
    if (!input.sandboxVerified) reasons.push('sandbox attestation is not verified')
    if (!input.evidenceVerified) reasons.push('evidence repository is not verified')
    if (input.evaluationFailed > 0) reasons.push(`${input.evaluationFailed} evaluation results failed`)
    if (input.ciFailed > 0) reasons.push(`${input.ciFailed} CI evidence reports failed`)
    if (input.unresolvedPolicyDenials > 0) reasons.push(`${input.unresolvedPolicyDenials} policy denials remain unresolved`)

    if (reasons.length) {
      decision = 'blocked'
      requiredControls.push('repair failed deterministic controls before any merge decision')
    } else if (input.programPhase === 'human_approval') {
      decision = 'human_review'
      reasons.push('current rollout phase requires named human approval')
      requiredControls.push('owner or reviewer approval')
    } else if (input.riskTier !== 'low' || !input.repositoryOnly || input.externalEgress || input.destructiveChange || input.productionImpact) {
      decision = 'human_review'
      if (input.riskTier !== 'low') reasons.push(`${input.riskTier} risk changes are outside the low-risk autonomy lane`)
      if (!input.repositoryOnly) reasons.push('change is not confined to the repository workspace')
      if (input.externalEgress) reasons.push('change requires external network egress')
      if (input.destructiveChange) reasons.push('change includes a destructive operation')
      if (input.productionImpact) reasons.push('change directly affects production')
      requiredControls.push('named human review for actions outside the deterministic allowlist')
    } else if (!input.identityAnchored) {
      decision = 'human_review'
      reasons.push('attestation identity is not anchored to a trusted issuer')
      requiredControls.push('trusted workload or human identity attestation')
    } else {
      decision = 'auto_merge_eligible'
      reasons.push('low-risk repository-only change satisfies all deterministic controls')
      requiredControls.push('branch protection and merge queue remain authoritative')
    }

    if (decision !== 'auto_merge_eligible' && input.humanReviewApproved) reasons.push('existing human approval is recorded but does not erase failed or out-of-lane controls')
    const inputDigest = digestValue(JSON.stringify(input))
    const unsigned = { providerRef: this.id, policyId, policyVersion, decision, riskTier: input.riskTier, reasons, requiredControls, inputDigest }
    return { ...unsigned, decisionDigest: digestValue(JSON.stringify(unsigned)) }
  }
}
