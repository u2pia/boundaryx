import { execFileSync } from 'node:child_process'
import type { ControlPlaneDatabase } from './database.ts'
import { sha256 } from './security.ts'
import { AppError } from './types.ts'
import { GIT_NO_EXEC } from './worktree-git.ts'

function git(repositoryPath: string, args: string[]) {
  try {
    return execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim()
  } catch (error) {
    throw new AppError(400, `Git operation failed: ${error instanceof Error ? error.message : String(error)}`, 'git_operation_failed')
  }
}

export function releaseArtifactEvidence(evidence: { id: string; sha256: string; summary: Record<string, unknown> }, approvedHeadSha: string) {
  const artifactCount = Number(evidence.summary.artifactCount ?? 0)
  if (artifactCount <= 0) return []
  const buildCheckName = typeof evidence.summary.buildCheckName === 'string' ? evidence.summary.buildCheckName : undefined
  if (!buildCheckName || evidence.summary.buildCheckConclusion !== 'success') throw new AppError(409, 'Application artifact evidence requires its declared build check to succeed', 'release_application_build_failed')
  const artifactDigests = Array.isArray(evidence.summary.artifactDigests) ? evidence.summary.artifactDigests.filter((value): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)) : []
  const sourceCommitShas = Array.isArray(evidence.summary.artifactSourceCommitShas) ? evidence.summary.artifactSourceCommitShas.filter((value): value is string => typeof value === 'string') : []
  if (artifactDigests.length !== artifactCount || sourceCommitShas.length !== artifactCount) throw new AppError(409, 'Application artifact evidence must bind every artifact digest and source commit', 'release_application_artifact_digest_missing')
  if (sourceCommitShas.some((sourceSha) => sourceSha !== approvedHeadSha)) throw new AppError(409, 'Application artifact evidence was not built from the approved Head SHA', 'release_application_artifact_source_mismatch')
  return [{ evidenceId: evidence.id, packageDigest: evidence.sha256, artifactCount, artifactDigests, sourceCommitSha: approvedHeadSha, buildCheckName }]
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
    if (mergeEvidence.strategy === 'host_merge') {
      // The host made its own merge or squash commit, so the merged revision is never the approved head itself. It is
      // releasable when the platform checked, at merge time, that it carries the approved change behind a green gate.
      const hostMerge = mergeEvidence.hostMerge
      if (!hostMerge || hostMerge.contentCheck === 'mismatch') throw new AppError(409, 'The revision merged on the host does not contain the approved change', 'release_merge_evidence_mismatch')
      if (hostMerge.outsideGate) throw new AppError(409, `The host merged this proposal outside the gate (${hostMerge.outsideGateReasons.join('; ')}); it cannot be released`, 'release_merge_outside_gate')
    } else if (mergeEvidence.mergedSha !== proposal.headSha) throw new AppError(409, 'Merge Evidence does not match the proposal Head SHA', 'release_merge_evidence_mismatch')
    const commitSha = git(proposal.repositoryPath, ['rev-parse', '--verify', `${mergeEvidence.mergedSha}^{commit}`])
    const mergedTreeSha = git(proposal.repositoryPath, ['rev-parse', '--verify', `${commitSha}^{tree}`])
    const approvedTreeSha = git(proposal.repositoryPath, ['rev-parse', '--verify', `${mergeEvidence.approvedHeadSha}^{tree}`])
    const tree = git(proposal.repositoryPath, ['ls-tree', '-r', '--full-tree', commitSha])
    const sourceTreeDigest = `sha256:${sha256(tree)}`
    const sourceFileCount = tree ? tree.split('\n').length : 0
    const workItem = this.database.getWorkItem(proposal.workItemId)
    const artifactEvidence = mergeEvidence.evidenceIds.map((evidenceId) => this.database.getEvidencePackage(evidenceId)).flatMap((evidence) => releaseArtifactEvidence(evidence, mergeEvidence.approvedHeadSha))
    if (workItem.productType === 'application' && artifactEvidence.length === 0) throw new AppError(409, 'Application Release Candidate requires Build Artifact Evidence in Merge Evidence', 'release_application_artifact_missing')
    if (artifactEvidence.length && mergedTreeSha !== approvedTreeSha) throw new AppError(409, 'Merged source tree differs from the approved Head tree that produced the build artifacts', 'release_build_source_tree_mismatch')
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
