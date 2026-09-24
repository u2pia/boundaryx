import { execFileSync } from 'node:child_process'
import { resolveProjectRepository } from './code-host/index.ts'
import type { ControlPlaneDatabase } from './database.ts'
import { AppError } from './types.ts'

function git(repositoryPath: string, args: string[]) {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AppError(400, `Git operation failed: ${message}`, 'git_operation_failed')
  }
}

function resolveCommit(repositoryPath: string, ref: string) {
  return git(repositoryPath, ['rev-parse', '--verify', `${ref}^{commit}`])
}

function diffStats(repositoryPath: string, baseSha: string, headSha: string) {
  const output = git(repositoryPath, ['diff', '--numstat', `${baseSha}...${headSha}`])
  if (!output) return { changedFiles: 0, additions: 0, deletions: 0 }
  return output.split('\n').reduce((summary, line) => {
    const [added, deleted] = line.split('\t')
    return { changedFiles: summary.changedFiles + 1, additions: summary.additions + (added === '-' ? 0 : Number(added)), deletions: summary.deletions + (deleted === '-' ? 0 : Number(deleted)) }
  }, { changedFiles: 0, additions: 0, deletions: 0 })
}

/** Repository prefix for the files that govern runs: the Project Manifest and anything placed beside it. */
export const POLICY_PATH_PREFIX = '.aperture/'

function policyFiles(repositoryPath: string, baseSha: string, headSha: string) {
  return git(repositoryPath, ['diff', '--name-only', '-z', `${baseSha}...${headSha}`, '--', POLICY_PATH_PREFIX]).split('\0').filter(Boolean).sort()
}

function isAncestor(repositoryPath: string, ancestorSha: string, descendantSha: string) {
  try {
    execFileSync('git', ['-C', repositoryPath, 'merge-base', '--is-ancestor', ancestorSha, descendantSha], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function findBranchWorktree(repositoryPath: string, fullRef: string) {
  const blocks = git(repositoryPath, ['worktree', 'list', '--porcelain']).split('\n\n')
  for (const block of blocks) {
    const lines = block.split('\n')
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length)
    if (path && branch === fullRef) return path
  }
  return undefined
}

export class LocalGitAuthority {
  readonly id = 'local-authority@0.1'
  private readonly database: ControlPlaneDatabase

  constructor(database: ControlPlaneDatabase) {
    this.database = database
  }

  /** The repository is the work item's project repository; a path that is passed must be that repository. */
  createChangeProposal(input: { workItemId: string; intentVersionId: string; runId?: string; repositoryPath?: string; baseRef: string; headRef: string; authorActorId: string }, actorId: string) {
    const { host, repositoryPath } = resolveProjectRepository(this.database, this.database.getWorkItem(input.workItemId).projectId, input.repositoryPath)
    // A run's branch is already in the working repository, and a run's worker holds no host credential. Only a
    // proposal opened by hand — from a branch someone pushed to the host — needs the host.
    if (!input.runId) {
      host.prepareForRun()
      host.ensureRef?.(input.headRef)
    }
    const baseSha = resolveCommit(repositoryPath, input.baseRef)
    const headSha = resolveCommit(repositoryPath, input.headRef)
    if (baseSha === headSha) throw new AppError(400, 'Change proposal must contain at least one commit beyond the base revision', 'empty_change')
    const stats = diffStats(repositoryPath, baseSha, headSha)
    return this.database.insertChangeProposal({ ...input, repositoryPath, baseSha, headSha, ...stats, policyFiles: policyFiles(repositoryPath, baseSha, headSha) }, actorId)
  }

  refreshChangeProposal(proposalId: string, actorId: string) {
    const proposal = this.database.getChangeProposal(proposalId)
    // The host is the truth for the target branch, so a refresh sees commits that landed there after review.
    const { host } = resolveProjectRepository(this.database, proposal.projectId)
    host.prepareForRun()
    if (!proposal.runId) host.ensureRef?.(proposal.headRef, true)
    const baseSha = resolveCommit(proposal.repositoryPath, proposal.baseRef)
    const headSha = resolveCommit(proposal.repositoryPath, proposal.headRef)
    return this.database.refreshChangeProposal(proposalId, { baseSha, headSha, ...diffStats(proposal.repositoryPath, baseSha, headSha), policyFiles: policyFiles(proposal.repositoryPath, baseSha, headSha) }, actorId)
  }

  reviseChangeProposal(proposalId: string, runId: string, headRef: string, actorId: string) {
    const proposal = this.database.getChangeProposal(proposalId)
    if (proposal.status !== 'changes_requested') throw new AppError(409, 'Agent revision requires an active changes_requested decision', 'revision_not_requested')
    const baseSha = resolveCommit(proposal.repositoryPath, proposal.baseRef)
    if (baseSha !== proposal.baseSha) throw new AppError(409, 'Target branch changed after review; refresh before starting a revision', 'revision_base_drift')
    const headSha = resolveCommit(proposal.repositoryPath, headRef)
    if (headSha === proposal.headSha) throw new AppError(422, 'Revision run did not produce a new Head SHA', 'revision_empty_change')
    if (!isAncestor(proposal.repositoryPath, proposal.headSha, headSha)) throw new AppError(409, 'Revision Head must descend from the reviewed Head SHA', 'revision_history_mismatch')
    return this.database.refreshChangeProposal(proposalId, { runId, baseSha, headRef, headSha, ...diffStats(proposal.repositoryPath, baseSha, headSha), policyFiles: policyFiles(proposal.repositoryPath, baseSha, headSha) }, actorId)
  }

  mergeChangeProposal(proposalId: string, actorId: string) {
    const proposal = this.database.getChangeProposal(proposalId)
    if (proposal.status === 'merged') {
      const evidence = this.database.getMergeEvidence(proposalId)
      if (resolveCommit(proposal.repositoryPath, proposal.baseRef) !== evidence.mergedSha) throw new AppError(409, 'Merged proposal no longer matches the target branch', 'merged_ref_drift')
      return { proposal, evidence, changed: false }
    }
    if (proposal.status !== 'approved') throw new AppError(409, 'Only an approved change proposal can be merged', 'merge_not_approved')
    const { project, host } = resolveProjectRepository(this.database, proposal.projectId)
    // In host_protected mode the host merges under its own branch protection and the platform records what it did.
    if (project.mergeMode === 'host_protected') throw new AppError(409, `Project ${project.slug} merges on ${project.codeHost}; merge the pull request there`, 'merge_on_host')
    const baseFullRef = git(proposal.repositoryPath, ['rev-parse', '--symbolic-full-name', proposal.baseRef])
    const headFullRef = git(proposal.repositoryPath, ['rev-parse', '--symbolic-full-name', proposal.headRef])
    if (!baseFullRef.startsWith('refs/heads/') || !headFullRef.startsWith('refs/heads/')) throw new AppError(409, 'Local merge requires branch refs for base and head', 'merge_requires_local_branches')
    const currentBaseSha = resolveCommit(proposal.repositoryPath, baseFullRef)
    const currentHeadSha = resolveCommit(proposal.repositoryPath, headFullRef)
    if (currentBaseSha !== proposal.baseSha) throw new AppError(409, 'Target branch changed after review; refresh and review again', 'merge_base_drift')
    if (currentHeadSha !== proposal.headSha) throw new AppError(409, 'Head branch changed after approval; refresh and review again', 'merge_head_drift')
    if (!isAncestor(proposal.repositoryPath, proposal.baseSha, proposal.headSha)) throw new AppError(409, 'Approved Head is not a fast-forward descendant of the target branch', 'merge_not_fast_forward')
    if (this.database.getReviewReadiness(proposalId).status !== 'ready') throw new AppError(409, 'Merge requires complete successful checks and evidence', 'merge_evidence_incomplete')

    const baseWorktreePath = findBranchWorktree(proposal.repositoryPath, baseFullRef)
    if (baseWorktreePath) {
      if (git(baseWorktreePath, ['status', '--porcelain'])) throw new AppError(409, 'Target branch worktree must be clean before merge', 'merge_target_worktree_dirty')
      git(baseWorktreePath, ['merge', '--ff-only', proposal.headSha])
      if (git(baseWorktreePath, ['status', '--porcelain'])) throw new AppError(500, 'Target worktree became dirty after fast-forward merge', 'merge_target_worktree_inconsistent')
    } else {
      git(proposal.repositoryPath, ['update-ref', baseFullRef, proposal.headSha, proposal.baseSha])
    }
    const mergedSha = resolveCommit(proposal.repositoryPath, baseFullRef)
    if (mergedSha !== proposal.headSha) {
      if (baseWorktreePath) git(baseWorktreePath, ['reset', '--hard', proposal.baseSha])
      else git(proposal.repositoryPath, ['update-ref', baseFullRef, proposal.baseSha, mergedSha])
      throw new AppError(500, 'Target branch did not resolve to the approved Head SHA', 'merge_verification_failed')
    }
    try {
      // Publishing comes before the record, so a host that refuses the push leaves no Merge Evidence behind. The
      // record's own checks were all made above, so a failure after a successful publish is not expected.
      host.publishMerge({ baseRef: proposal.baseRef, baseShaBefore: proposal.baseSha, mergedSha })
      const evidence = this.database.recordMergeEvidence({ proposalId, baseRef: proposal.baseRef, baseShaBefore: proposal.baseSha, approvedHeadSha: proposal.headSha, mergedSha, strategy: 'fast_forward' }, actorId)
      return { proposal: this.database.getChangeProposal(proposalId), evidence, changed: true }
    } catch (error) {
      try {
        if (baseWorktreePath) git(baseWorktreePath, ['reset', '--hard', proposal.baseSha])
        else git(proposal.repositoryPath, ['update-ref', baseFullRef, proposal.baseSha, proposal.headSha])
      } catch {
        throw new AppError(500, 'Merge evidence recording failed and target branch rollback also failed', 'merge_compensation_failed')
      }
      throw error
    }
  }
}
