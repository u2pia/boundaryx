import assert from 'node:assert/strict'
import { MockDeploymentProvider } from '../src/adapters/mock-deployment.ts'

const now = () => new Date('2026-09-22T08:00:00Z')
const provider = new MockDeploymentProvider(now)
const deployment = await provider.deploy({ releaseCandidateId: 'RC-2026-09-22-3', environment: 'production', headSha: '8f3a2c1d9e', evidenceUri: 'local://evidence/run-001.json', approvedBy: 'github:wangzhen' })

assert.equal(deployment.providerId, 'mock-deployment@0.1')
assert.equal(deployment.status, 'succeeded')
assert.equal(deployment.startedAt, '2026-09-22T08:00:00.000Z')
assert.match(deployment.deploymentId, /^DEP-[0-9A-F]{8}$/)
assert.match(deployment.artifactDigest, /^fnv1a:/)
assert.equal(deployment.rollbackRef, 'rollback://rc-2026-09-22-3/8f3a2c1')

await assert.rejects(() => provider.deploy({ releaseCandidateId: 'RC-FAIL', environment: 'production', headSha: '8f3a2c1', evidenceUri: 'https://unverified.example/evidence.json', approvedBy: 'github:wangzhen' }), /verified evidence repository URI/)
await assert.rejects(() => provider.deploy({ releaseCandidateId: 'RC-FAIL', environment: 'production', headSha: '8f3a2c1', evidenceUri: 'local://evidence/run.json', approvedBy: 'agent:autonomous' }), /external human approval identity/)

const rollback = await provider.rollback({ deploymentId: deployment.deploymentId, releaseCandidateId: deployment.releaseCandidateId, rollbackRef: deployment.rollbackRef, requestedBy: 'github:wangzhen', reason: 'Production error rate exceeded the rollback threshold' })
assert.equal(rollback.status, 'succeeded')
assert.match(rollback.rollbackId, /^RBK-[0-9A-F]{8}$/)
assert.match(rollback.restoredArtifactDigest, /^fnv1a:/)
await assert.rejects(() => provider.rollback({ deploymentId: deployment.deploymentId, releaseCandidateId: 'RC-OTHER', rollbackRef: deployment.rollbackRef, requestedBy: 'github:wangzhen', reason: 'mismatch' }), /does not belong/)
await assert.rejects(() => provider.rollback({ deploymentId: deployment.deploymentId, releaseCandidateId: deployment.releaseCandidateId, rollbackRef: deployment.rollbackRef, requestedBy: 'agent:autonomous', reason: 'unauthorized' }), /external human identity/)

console.log('deployment provider smoke tests passed')
