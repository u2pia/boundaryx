import type { PolicyBundleDescriptor, PolicyDecision, PolicyDecisionInput, PolicyDecisionProvider } from './contracts.ts'
import { digestValue } from './event-integrity.ts'

type RuleResult = Omit<PolicyDecision, 'policyVersion' | 'inputDigest'>

const rules = [
  'deny-secrets',
  'isolate-untrusted-external-content',
  'allow-declared-repository-read',
  'allow-sandbox-shell',
  'allow-repository-write',
  'gate-deployment-write',
  'default-deny',
] as const

export class LocalPolicyDecisionProvider implements PolicyDecisionProvider {
  readonly id = 'policy://local-deterministic-v1'
  private readonly descriptor: PolicyBundleDescriptor

  constructor(bundleId = 'policy-v12') {
    const bundleVersion = bundleId.match(/v(\d+)$/u)?.[1] ?? '1'
    const bundle = { providerRef: this.id, bundleId, bundleVersion, defaultDecision: 'deny' as const, rules }
    this.descriptor = { ...bundle, bundleDigest: digestValue(JSON.stringify(bundle)), ruleCount: rules.length, ruleIds: [...rules] }
  }

  describe() {
    return this.descriptor
  }

  evaluate(input: PolicyDecisionInput): PolicyDecision {
    const result = this.evaluateRules(input)
    return { ...result, policyVersion: this.descriptor.bundleVersion, inputDigest: digestValue(JSON.stringify(input)) }
  }

  private evaluateRules(input: PolicyDecisionInput): RuleResult {
    if (input.capability === 'secrets:read' || input.sensitivity === 'sensitive') {
      return { decision: 'deny', enforcement: 'preventive', policyId: 'POL-SECRETS-DENY', reason: 'sensitive resources are outside the approved blast radius' }
    }
    if (input.capability === 'network:egress' && input.trust === 'untrusted') {
      return { decision: 'deny', enforcement: 'preventive', policyId: 'POL-EXTERNAL-CONTENT-ISOLATE', reason: 'untrusted external content requires isolation and content scanning before model consumption' }
    }
    if (input.capability === 'network:egress') {
      const allowed = Boolean(input.networkHost && input.allowedHosts?.includes(input.networkHost))
      return allowed
        ? { decision: 'allow', enforcement: 'preventive', policyId: 'POL-EGRESS-ALLOWLIST', reason: `${input.networkHost} is present in the sandbox egress allowlist` }
        : { decision: 'deny', enforcement: 'preventive', policyId: 'POL-EGRESS-ALLOWLIST', reason: 'network host is absent from the sandbox egress allowlist' }
    }
    if (input.capability === 'repository:read' && input.declared !== false) {
      return { decision: 'allow', enforcement: 'preventive', policyId: 'POL-REPOSITORY-READ', reason: 'declared repository context is readable inside the workspace' }
    }
    if (input.capability === 'shell:execute') {
      return { decision: 'allow', enforcement: 'preventive', policyId: 'POL-SHELL-EXECUTE', reason: 'sandboxed shell execution is allowed for the bound work contract' }
    }
    if (input.capability === 'repository:write') {
      return { decision: 'allow', enforcement: 'preventive', policyId: 'POL-REPOSITORY-WRITE', reason: 'workspace writes are allowed inside the attested writable paths' }
    }
    if (input.capability === 'deployment:write') {
      return input.approvedBy?.startsWith('github:')
        ? { decision: 'allow', enforcement: 'preventive', policyId: 'POL-PRODUCTION-APPROVAL', reason: `production write approved by ${input.approvedBy}` }
        : { decision: 'require_approval', enforcement: 'preventive', policyId: 'POL-PRODUCTION-APPROVAL', reason: 'production writes require a named external human identity' }
    }
    return { decision: 'deny', enforcement: 'preventive', policyId: 'POL-DEFAULT-DENY', reason: `${input.capability} has no explicit allow rule in the active policy bundle` }
  }
}
