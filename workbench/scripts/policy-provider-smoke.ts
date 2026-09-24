import assert from 'node:assert/strict'
import { LocalPolicyDecisionProvider } from '../src/adapters/local-policy-provider.ts'

const provider = new LocalPolicyDecisionProvider('policy-v12')
const descriptor = provider.describe()
assert.equal(descriptor.providerRef, provider.id)
assert.equal(descriptor.bundleVersion, '12')
assert.equal(descriptor.defaultDecision, 'deny')
assert.equal(descriptor.ruleCount, descriptor.ruleIds.length)
assert.match(descriptor.bundleDigest, /^fnv1a:/)

const repositoryRead = provider.evaluate({ runId: 'RUN-POLICY-001', tool: 'read_file', capability: 'repository:read', resourceRef: 'src/auth/session.ts', declared: true, trust: 'trusted', sensitivity: 'internal' })
assert.equal(repositoryRead.decision, 'allow')
assert.equal(repositoryRead.policyId, 'POL-REPOSITORY-READ')
assert.equal(repositoryRead.policyVersion, '12')

const secretRead = provider.evaluate({ runId: 'RUN-POLICY-001', tool: 'read_file', capability: 'secrets:read', resourceRef: 'config/oauth.internal.yml', declared: false, trust: 'trusted', sensitivity: 'sensitive' })
assert.equal(secretRead.decision, 'deny')
assert.equal(secretRead.policyId, 'POL-SECRETS-DENY')

const externalContent = provider.evaluate({ runId: 'RUN-POLICY-001', tool: 'mcp_fetch', capability: 'network:egress', resourceRef: 'mcp://community/guide', trust: 'untrusted', networkHost: 'community.example', allowedHosts: ['api.github.com'] })
assert.equal(externalContent.decision, 'deny')
assert.equal(externalContent.policyId, 'POL-EXTERNAL-CONTENT-ISOLATE')

const allowedEgress = provider.evaluate({ runId: 'RUN-POLICY-001', tool: 'github_api', capability: 'network:egress', resourceRef: 'https://api.github.com/repos', trust: 'trusted', networkHost: 'api.github.com', allowedHosts: ['api.github.com'] })
assert.equal(allowedEgress.decision, 'allow')
assert.equal(allowedEgress.policyId, 'POL-EGRESS-ALLOWLIST')

const productionWithoutApproval = provider.evaluate({ runId: 'RUN-POLICY-001', tool: 'deploy', capability: 'deployment:write', resourceRef: 'production' })
assert.equal(productionWithoutApproval.decision, 'require_approval')
const productionApproved = provider.evaluate({ runId: 'RUN-POLICY-001', tool: 'deploy', capability: 'deployment:write', resourceRef: 'production', approvedBy: 'github:wangzhen' })
assert.equal(productionApproved.decision, 'allow')
assert.notEqual(productionWithoutApproval.inputDigest, productionApproved.inputDigest)

console.log(`policy provider smoke passed · ${descriptor.bundleId}@${descriptor.bundleVersion} · ${descriptor.ruleCount} rules · default deny`)
