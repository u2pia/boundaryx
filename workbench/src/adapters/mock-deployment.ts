import type { DeploymentProvider, DeploymentRequest, RollbackRequest } from './contracts.ts'
import { digestValue } from './event-integrity.ts'

export class MockDeploymentProvider implements DeploymentProvider {
  readonly id = 'mock-deployment@0.1'
  private readonly now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.now = now
  }

  async deploy(request: DeploymentRequest) {
    if (!request.releaseCandidateId || !request.headSha || !request.evidenceUri || !request.approvedBy) throw new Error('Deployment request is missing release authority or evidence')
    if (request.environment === 'production' && !request.approvedBy.startsWith('github:')) throw new Error('Production deployment requires an external human approval identity')
    if (!request.evidenceUri.startsWith('local://') && !request.evidenceUri.startsWith('memory://')) throw new Error('Deployment requires a verified evidence repository URI')
    const startedAt = this.now().toISOString()
    const artifactDigest = digestValue(JSON.stringify(request))
    return {
      ...request,
      deploymentId: `DEP-${artifactDigest.slice(-8).toUpperCase()}`,
      providerId: this.id,
      status: 'succeeded' as const,
      startedAt,
      completedAt: this.now().toISOString(),
      artifactDigest,
      rollbackRef: `rollback://${request.releaseCandidateId.toLowerCase()}/${request.headSha.slice(0, 7)}`,
    }
  }

  async rollback(request: RollbackRequest) {
    if (!request.deploymentId || !request.releaseCandidateId || !request.rollbackRef || !request.reason) throw new Error('Rollback request is incomplete')
    if (!request.requestedBy.startsWith('github:')) throw new Error('Production rollback requires an external human identity')
    if (!request.rollbackRef.startsWith(`rollback://${request.releaseCandidateId.toLowerCase()}/`)) throw new Error('Rollback reference does not belong to the release candidate')
    const restoredArtifactDigest = digestValue(JSON.stringify(request))
    return {
      ...request,
      rollbackId: `RBK-${restoredArtifactDigest.slice(-8).toUpperCase()}`,
      providerId: this.id,
      status: 'succeeded' as const,
      completedAt: this.now().toISOString(),
      restoredArtifactDigest,
    }
  }
}
