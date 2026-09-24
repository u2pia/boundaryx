import type { ExecutionMode } from './contracts.ts'

export type ContextResetPolicy = 'continuous' | 'phase_boundary_compaction' | 'fresh_session_per_phase'

export type HarnessCandidate = {
  profileId: string
  executionMode: ExecutionMode
  contextResetPolicy: ContextResetPolicy
  requiresIndependentEvaluator: boolean
  passRate: number
  p95DurationSeconds: number
  estimatedCostUsd: number
  evidenceRef: string
}

export type HarnessSelectionInput = {
  modelRef: string
  maxCostUsd: number
  requireIndependentEvaluator: boolean
}

export type ContextResetInput = {
  policyId: string
  policy: ContextResetPolicy
  usedTokens: number
  maxTokens: number
  phaseBoundary: boolean
  evaluatorFeedbackPending: boolean
}

export class HarnessPolicy {
  select(input: HarnessSelectionInput, candidates: HarnessCandidate[]) {
    const contextBehavior = this.contextBehavior(input.modelRef)
    const eligible = candidates.filter((candidate) => candidate.estimatedCostUsd <= input.maxCostUsd && (!input.requireIndependentEvaluator || candidate.requiresIndependentEvaluator))
    if (!eligible.length) throw new Error('No harness profile satisfies the model, evaluator, and budget constraints')
    const ranked = eligible
      .map((candidate) => ({
        candidate,
        score: candidate.passRate * 100 - (candidate.estimatedCostUsd / input.maxCostUsd) * 5 - (candidate.p95DurationSeconds / 1_800) * 2 + this.contextPolicyAffinity(contextBehavior, candidate.contextResetPolicy),
      }))
      .sort((left, right) => right.score - left.score || left.candidate.profileId.localeCompare(right.candidate.profileId))
    const selected = ranked[0]!.candidate
    return {
      selected,
      considered: candidates,
      modelContextBehavior: contextBehavior,
      selectionReason: `${selected.profileId} has the strongest measured reliability within the evaluator, cost, and ${contextBehavior} context constraints for ${input.modelRef}`,
    }
  }

  decideContextReset(input: ContextResetInput) {
    const utilization = input.usedTokens / Math.max(input.maxTokens, 1)
    if (input.evaluatorFeedbackPending && input.policy === 'fresh_session_per_phase') {
      return { action: 'fresh_session' as const, trigger: 'evaluator_feedback' as const, reason: 'Evaluator feedback starts a clean implementation phase while durable notes preserve state.' }
    }
    if (utilization >= 0.75 && input.policy !== 'continuous') {
      return { action: 'compact' as const, trigger: 'token_pressure' as const, reason: `Context utilization reached ${Math.round(utilization * 100)}%; compact before the next recoverable boundary.` }
    }
    if (input.phaseBoundary && input.policy === 'fresh_session_per_phase') {
      return { action: 'fresh_session' as const, trigger: 'phase_boundary' as const, reason: 'The selected harness isolates each phase in a fresh session.' }
    }
    return { action: 'continue' as const, trigger: 'policy_check' as const, reason: 'Current context remains inside the selected harness policy.' }
  }

  private contextBehavior(modelRef: string) {
    if (/long-context|reasoning-strong/i.test(modelRef)) return 'durable' as const
    if (/reasoning-medium|balanced/i.test(modelRef)) return 'balanced' as const
    return 'fragile' as const
  }

  private contextPolicyAffinity(behavior: 'durable' | 'balanced' | 'fragile', policy: ContextResetPolicy) {
    if (behavior === 'durable' && policy === 'continuous') return 3
    if (behavior === 'balanced' && policy === 'phase_boundary_compaction') return 3
    if (behavior === 'fragile' && policy === 'fresh_session_per_phase') return 4
    return 0
  }
}
