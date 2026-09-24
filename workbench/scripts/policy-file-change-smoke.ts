import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { AppError } from '../server/types.ts'

// DOMAIN_MODEL.md §9.1.1: an agent can write to the files that govern it. A proposal that touches `.aperture/` is
// marked, and only an owner who records why the new rules are acceptable can approve it.
const root = mkdtempSync(join(tmpdir(), 'aperture-policy-files-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

function commitOn(branch: string, file: string, content: string) {
  git('checkout', '--quiet', branch)
  mkdirSync(dirname(join(repositoryPath, file)), { recursive: true })
  writeFileSync(join(repositoryPath, file), content)
  git('add', file)
  git('commit', '--quiet', '-m', file)
  git('checkout', '--quiet', 'main')
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Test')
git('config', 'user.email', 'aperture@example.test')
mkdirSync(join(repositoryPath, '.aperture'))
writeFileSync(join(repositoryPath, '.aperture/project.json'), '{"policy":{"maximumRisk":"medium"}}\n')
writeFileSync(join(repositoryPath, 'README.md'), '# Policy files\n')
git('add', '.')
git('commit', '--quiet', '-m', 'initial')
git('branch', 'agent/code-only', 'main')
commitOn('agent/code-only', 'src/feature.ts', 'export const feature = 1\n')
git('branch', 'agent/loosen-policy', 'main')
commitOn('agent/loosen-policy', 'src/feature.ts', 'export const feature = 1\n')
commitOn('agent/loosen-policy', '.aperture/project.json', '{"policy":{"maximumRisk":"high"}}\n')

const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const authority = new LocalGitAuthority(database)
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const author = database.createActor({ username: 'author', displayName: 'Author', role: 'developer', password: 'author-password-2026' }, owner.id)
  const reviewer = database.createActor({ username: 'reviewer', displayName: 'Reviewer', role: 'reviewer', password: 'reviewer-password-2026' }, owner.id)

  function proposalFor(branch: string) {
    const workItem = database.createWorkItem({ title: branch, description: branch, ownerActorId: author.id }, owner.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal: branch, constraints: [], riskLevel: 'low', acceptanceCriteria: [{ statement: 'unit suite passes', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
    const proposal = authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId: `RUN-${branch}`, repositoryPath, baseRef: 'main', headRef: `agent/${branch}`, authorActorId: author.id }, author.id)
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, reviewer.id)
    return proposal
  }

  // A code-only change is unmarked and follows the ordinary path.
  {
    const proposal = proposalFor('code-only')
    assert.deepEqual(proposal.policyFiles, [])
    assert.deepEqual(database.getReviewReadiness(proposal.id).policyFiles, [])
    database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: '' })
    assert.equal(database.getChangeProposal(proposal.id).status, 'approved')
  }

  // Loosening the manifest is marked on the proposal, in its creation event and in readiness, and tightens approval.
  {
    const proposal = proposalFor('loosen-policy')
    assert.deepEqual(proposal.policyFiles, ['.aperture/project.json'])
    assert.deepEqual(database.getChangeProposal(proposal.id).policyFiles, ['.aperture/project.json'], 'the mark is persisted, not recomputed')
    const created = database.listAggregateEvents('change_proposal', proposal.id).find((event) => event.eventType === 'change_proposal.created')
    assert.deepEqual(created?.payload.policyFiles, ['.aperture/project.json'])
    assert.deepEqual(database.getReviewReadiness(proposal.id).policyFiles, ['.aperture/project.json'])

    const approve = (actorId: string, comment: string) => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: actorId, decision: 'approved', comment })
    assert.throws(() => approve(reviewer.id, 'looks fine'), failsWith('review_policy_change_requires_owner'))
    assert.throws(() => approve(owner.id, '  '), failsWith('review_policy_change_unacknowledged'))
    // Requesting changes stays open to any reviewer: only the path into Approved is tightened.
    database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'commented', comment: 'why raise maximumRisk?' })
    approve(owner.id, 'raising maximumRisk to high is intended for the migration epic')
    const approval = database.listAggregateEvents('change_proposal', proposal.id).findLast((event) => event.eventType === 'review.approved')
    assert.deepEqual(approval?.payload.policyFilesAcknowledged, ['.aperture/project.json'])

    // A later head that reverts the policy file clears the mark on refresh.
    commitOn('agent/loosen-policy', '.aperture/project.json', '{"policy":{"maximumRisk":"medium"}}\n')
    const refreshed = authority.refreshChangeProposal(proposal.id, owner.id)
    assert.deepEqual(refreshed.proposal.policyFiles, [], 'the net diff against base no longer touches .aperture/')
    const revisionEvent = database.listAggregateEvents('change_proposal', proposal.id).findLast((event) => event.eventType === 'change_proposal.revision_changed')
    assert.deepEqual(revisionEvent?.payload.policyFiles, [])
  }

  // Proposals created before the scan existed report null, and a no-op refresh fills the list in.
  {
    const proposal = proposalFor('code-only')
    database.db.prepare('UPDATE change_proposals SET policy_files_json = NULL WHERE id = ?').run(proposal.id)
    assert.equal(database.getReviewReadiness(proposal.id).policyFiles, null)
    const refreshed = authority.refreshChangeProposal(proposal.id, owner.id)
    assert.equal(refreshed.changed, false)
    assert.deepEqual(refreshed.proposal.policyFiles, [])
  }

  console.log('policy file change smoke passed · .aperture/ edits marked on proposal, event and readiness · approval needs an owner and a reason · refresh recomputes')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
