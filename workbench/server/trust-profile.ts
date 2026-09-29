import type { AgentRunnerDescriptor } from './types.ts'
import type { ControlPlaneDatabase } from './database.ts'
import { auditCoreIntegrity, type CoreIntegrityReport } from './core-integrity-auditor.ts'

export type TrustProfileLevel = 'local_exploration' | 'team_governed' | 'release_qualified'
export type TrustControlStatus = 'pass' | 'fail' | 'unknown'

export type TrustControl = {
  id: 'core_integrity' | 'external_identity' | 'transport_security' | 'event_seal_separation' | 'runtime_available' | 'runtime_isolation' | 'network_egress' | 'recovery_verification'
  status: TrustControlStatus
  evidence: string
  remediation?: string
}

export type TrustProfile = {
  schemaVersion: 'aperture.trust-profile.v1'
  generatedAt: string
  level: TrustProfileLevel
  controls: TrustControl[]
  capabilities: {
    governedHumanDecisions: boolean
    productionEligibleAgentExecution: boolean
    verifiedRecovery: boolean
  }
  blockers: string[]
  limitations: string[]
}

export type TrustFacts = {
  integrityValid: boolean
  integrityCriticalCount: number
  identityMode: 'development' | 'team'
  loopback: boolean
  secureCookies: boolean
  eventSealKeySource: 'env' | 'file' | 'colocated'
  runtime?: AgentRunnerDescriptor
  recoveryVerification?: { valid: boolean; verifiedAt: string; reason?: string }
}

export function computeTrustProfile(facts: TrustFacts): TrustProfile {
  const controls: TrustControl[] = [
    facts.integrityValid
      ? { id: 'core_integrity', status: 'pass', evidence: 'Core Integrity Auditor reported no critical findings.' }
      : { id: 'core_integrity', status: 'fail', evidence: `Core Integrity Auditor reported ${facts.integrityCriticalCount} critical finding(s).`, remediation: 'Run npm run audit:verify and resolve every critical finding.' },
    facts.identityMode === 'team'
      ? { id: 'external_identity', status: 'pass', evidence: 'Identity mode is Team; terminal decisions require externally verified sessions.' }
      : { id: 'external_identity', status: 'fail', evidence: 'Identity mode is Development; password decisions are self-asserted.', remediation: 'Configure external identity and switch to Team mode.' },
    facts.loopback || facts.secureCookies
      ? { id: 'transport_security', status: 'pass', evidence: facts.loopback ? 'The service is bound to a loopback host.' : 'Secure session cookies are enabled for the public HTTPS entry point.' }
      : { id: 'transport_security', status: 'fail', evidence: 'The service is reachable beyond loopback without Secure session cookies.', remediation: 'Use an HTTPS entry point and enable CONTROL_PLANE_SECURE_COOKIES.' },
    facts.eventSealKeySource !== 'colocated'
      ? { id: 'event_seal_separation', status: 'pass', evidence: `The active Event Seal Key comes from ${facts.eventSealKeySource} and is not stored beside the database.` }
      : { id: 'event_seal_separation', status: 'fail', evidence: 'The Event Seal Key is stored beside the database.', remediation: 'Move the key outside the data directory with APERTURE_EVENT_SEAL_KEY_FILE or a secret environment variable.' },
    facts.runtime?.status === 'ready'
      ? { id: 'runtime_available', status: 'pass', evidence: `Agent Runtime ${facts.runtime.id} is ready.` }
      : { id: 'runtime_available', status: 'fail', evidence: facts.runtime ? `Agent Runtime ${facts.runtime.id} is ${facts.runtime.status}.` : 'No Agent Runtime is configured.', remediation: 'Configure and successfully probe an Agent Runtime.' },
    facts.runtime?.productionEligible === true && facts.runtime.isolation === 'container'
      ? { id: 'runtime_isolation', status: 'pass', evidence: `Agent Runtime ${facts.runtime.id} reports container isolation and production eligibility.` }
      : { id: 'runtime_isolation', status: 'fail', evidence: facts.runtime ? `Agent Runtime isolation is ${facts.runtime.isolation}; productionEligible=${facts.runtime.productionEligible}.` : 'No isolated Agent Runtime is configured.', remediation: 'Use a production-eligible isolated runtime.' },
    facts.runtime && facts.runtime.networkEgress !== 'unrestricted'
      ? { id: 'network_egress', status: 'pass', evidence: `Agent Runtime network egress is ${facts.runtime.networkEgress}.` }
      : { id: 'network_egress', status: 'fail', evidence: facts.runtime ? 'Agent Runtime network egress is unrestricted.' : 'Agent Runtime network policy is unavailable.', remediation: 'Deny network egress or use an explicit allowlist.' },
    facts.recoveryVerification?.valid
      ? { id: 'recovery_verification', status: 'pass', evidence: `A current externally attested recovery drill completed at ${facts.recoveryVerification.verifiedAt}.` }
      : { id: 'recovery_verification', status: 'unknown', evidence: facts.recoveryVerification?.reason ?? 'No current recovery verification is registered in the Trust Profile.', remediation: 'Run an Owner-authorized recovery drill from an externally authenticated Team-mode session.' },
  ]
  const passed = (id: TrustControl['id']) => controls.find((control) => control.id === id)?.status === 'pass'
  const governedHumanDecisions = ['core_integrity', 'external_identity', 'transport_security', 'event_seal_separation'].every((id) => passed(id as TrustControl['id']))
  const productionEligibleAgentExecution = governedHumanDecisions && ['runtime_available', 'runtime_isolation', 'network_egress'].every((id) => passed(id as TrustControl['id']))
  const level: TrustProfileLevel = productionEligibleAgentExecution ? 'release_qualified' : governedHumanDecisions ? 'team_governed' : 'local_exploration'
  const required = level === 'local_exploration'
    ? ['core_integrity', 'external_identity', 'transport_security', 'event_seal_separation']
    : level === 'team_governed'
      ? ['runtime_available', 'runtime_isolation', 'network_egress']
      : []
  const blockers = required.flatMap((id) => {
    const control = controls.find((item) => item.id === id)
    return control && control.status !== 'pass' ? [`${control.id}: ${control.evidence}`] : []
  })
  return {
    schemaVersion: 'aperture.trust-profile.v1',
    generatedAt: new Date().toISOString(),
    level,
    controls,
    capabilities: { governedHumanDecisions, productionEligibleAgentExecution, verifiedRecovery: passed('recovery_verification') },
    blockers,
    limitations: [
      'This profile describes the maximum trust posture of the platform environment; it does not approve any Change, Run, Merge or Release.',
      'Every Change still needs its own Intent, Policy, Evaluation, Evidence, Identity and Review gates on the exact revision.',
      'Event Chain Heads are not externally anchored; a holder of the Event Seal Key and database write access can still rewrite history.',
      ...(passed('recovery_verification') ? [] : ['Disaster recovery readiness is not currently proven by this profile.']),
    ],
  }
}

export function trustProfileForControlPlane(input: { database: ControlPlaneDatabase; integrity?: CoreIntegrityReport; evidenceDirectory?: string; runtime?: AgentRunnerDescriptor; secureCookies: boolean; host?: string; recoveryVerification?: TrustFacts['recoveryVerification'] }) {
  const integrity = input.integrity ?? auditCoreIntegrity({ database: input.database, evidenceDirectory: input.evidenceDirectory })
  const host = input.host ?? '127.0.0.1'
  const attestation = input.database.listOperationalAttestations().find((item) => item.attestationType === 'backup_restore_drill' && item.active)
  const recoveryVerification = input.recoveryVerification ?? (attestation
    ? attestation.identity.assurance === 'external' && integrity.valid
      ? { valid: true, verifiedAt: attestation.performedAt }
      : { valid: false, verifiedAt: attestation.performedAt, reason: attestation.identity.assurance !== 'external' ? `The recovery drill completed at ${attestation.performedAt}, but its signer identity was self-asserted.` : 'The recorded recovery drill cannot be trusted while Core Integrity has critical findings.' }
    : undefined)
  return computeTrustProfile({
    integrityValid: integrity.valid,
    integrityCriticalCount: integrity.summary.critical,
    identityMode: input.database.getIdentityMode(),
    loopback: ['127.0.0.1', '::1', 'localhost'].includes(host),
    secureCookies: input.secureCookies,
    eventSealKeySource: input.database.getEventSealStatus().keySource,
    runtime: input.runtime,
    recoveryVerification,
  })
}

export function trustProfileMarkdown(profile: TrustProfile) {
  return [
    '# Trust Profile',
    '',
    `Generated: ${profile.generatedAt}`,
    `Level: ${profile.level}`,
    '',
    '## Capabilities',
    '',
    `- Governed human decisions: ${profile.capabilities.governedHumanDecisions ? 'yes' : 'no'}`,
    `- Production-eligible Agent execution: ${profile.capabilities.productionEligibleAgentExecution ? 'yes' : 'no'}`,
    `- Verified recovery: ${profile.capabilities.verifiedRecovery ? 'yes' : 'no'}`,
    '',
    '## Controls',
    '',
    ...profile.controls.map((control) => `- **${control.status.toUpperCase()} · ${control.id}**: ${control.evidence}${control.remediation ? ` Remediation: ${control.remediation}` : ''}`),
    '',
    '## Limitations',
    '',
    ...profile.limitations.map((limitation) => `- ${limitation}`),
    '',
  ].join('\n')
}
