import { execFileSync } from 'node:child_process'
import type { ControlPlaneDatabase } from './database.ts'
import { sha256 } from './security.ts'
import { AppError } from './types.ts'

function git(repositoryPath: string, args: string[]) {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim()
  } catch (error) {
    throw new AppError(400, `Git operation failed: ${error instanceof Error ? error.message : String(error)}`, 'git_operation_failed')
  }
}

export class LocalReleaseAuthority {
  readonly id = 'local-release-authority@0.1'
  private readonly database: ControlPlaneDatabase

  constructor(database: ControlPlaneDatabase) {
    this.database = database
  }

  createReleaseCandidate(proposalId: string, actorId: string) {
    const proposal = this.database.getChangeProposal(proposalId)
    if (proposal.status !== 'merged') throw new AppError(409, 'Release Candidate requires a merged change proposal', 'release_requires_merge')
    const mergeEvidence = this.database.getMergeEvidence(proposalId)
    if (mergeEvidence.mergedSha !== proposal.headSha) throw new AppError(409, 'Merge Evidence does not match the proposal Head SHA', 'release_merge_evidence_mismatch')
    const commitSha = git(proposal.repositoryPath, ['rev-parse', '--verify', `${mergeEvidence.mergedSha}^{commit}`])
    const tree = git(proposal.repositoryPath, ['ls-tree', '-r', '--full-tree', commitSha])
    const sourceTreeDigest = `sha256:${sha256(tree)}`
    const sourceFileCount = tree ? tree.split('\n').length : 0
    const workItem = this.database.getWorkItem(proposal.workItemId)
    const artifactEvidence = mergeEvidence.evidenceIds.map((evidenceId) => this.database.getEvidencePackage(evidenceId)).flatMap((evidence) => {
      const artifactCount = Number(evidence.summary.artifactCount ?? 0)
      return artifactCount > 0 ? [{ evidenceId: evidence.id, packageDigest: evidence.sha256, artifactCount }] : []
    })
    if (workItem.productType === 'application' && artifactEvidence.length === 0) throw new AppError(409, 'Application Release Candidate requires Build Artifact Evidence in Merge Evidence', 'release_application_artifact_missing')
    const artifactClass = artifactEvidence.length ? 'source_with_build_attestation' as const : 'source_snapshot' as const
    return this.database.createReleaseCandidate({ proposalId, mergeEvidenceId: mergeEvidence.id, repositoryPath: proposal.repositoryPath, sourceRef: proposal.baseRef, commitSha, sourceTreeDigest, sourceFileCount, artifactClass, artifactEvidence }, actorId)
  }

  verifyReleaseCandidate(candidateId: string) {
    const candidate = this.database.getReleaseCandidate(candidateId)
    const commitSha = git(candidate.repositoryPath, ['rev-parse', '--verify', `${candidate.commitSha}^{commit}`])
    const tree = git(candidate.repositoryPath, ['ls-tree', '-r', '--full-tree', commitSha])
    const sourceTreeDigest = `sha256:${sha256(tree)}`
    if (commitSha !== candidate.commitSha || sourceTreeDigest !== candidate.sourceTreeDigest) throw new AppError(409, 'Release Candidate source snapshot verification failed', 'release_source_digest_mismatch')
    return candidate
  }
}
