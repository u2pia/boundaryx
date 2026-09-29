import assert from 'node:assert/strict'
import { computeTrustProfile, type TrustFacts } from '../server/trust-profile.ts'

const localFacts: TrustFacts = {
  integrityValid: true,
  integrityCriticalCount: 0,
  identityMode: 'development',
  loopback: true,
  secureCookies: false,
  eventSealKeySource: 'colocated',
  runtime: { id: 'local-process', isolation: 'unisolated_process', status: 'ready', productionEligible: false, networkEgress: 'unrestricted' },
}
const local = computeTrustProfile(localFacts)
assert.equal(local.level, 'local_exploration')
assert.equal(local.capabilities.governedHumanDecisions, false)
assert.equal(local.capabilities.verifiedRecovery, false)

const team = computeTrustProfile({ ...localFacts, identityMode: 'team', loopback: false, secureCookies: true, eventSealKeySource: 'file' })
assert.equal(team.level, 'team_governed')
assert.equal(team.capabilities.governedHumanDecisions, true)
assert.equal(team.capabilities.productionEligibleAgentExecution, false)

const releaseFacts: TrustFacts = { ...localFacts, identityMode: 'team', loopback: false, secureCookies: true, eventSealKeySource: 'env', runtime: { id: 'isolated-runtime', isolation: 'container', status: 'ready', productionEligible: true, networkEgress: 'denied' }, recoveryVerification: { valid: true, verifiedAt: '2026-09-29T00:00:00.000Z' } }
const release = computeTrustProfile(releaseFacts)
assert.equal(release.level, 'release_qualified')
assert.deepEqual(release.capabilities, { governedHumanDecisions: true, productionEligibleAgentExecution: true, verifiedRecovery: true })
assert.equal(release.blockers.length, 0)

const broken = computeTrustProfile({ ...releaseFacts, integrityValid: false, integrityCriticalCount: 2 })
assert.equal(broken.level, 'local_exploration')
assert.equal(broken.blockers.some((blocker) => blocker.startsWith('core_integrity:')), true)

console.log('trust profile smoke passed · local_exploration → team_governed → release_qualified · facts only')
