import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { requestContext } from '../server/request-context.ts'
import { AppError } from '../server/types.ts'

// DOMAIN_MODEL.md §5.8: a Review Assignment names who owns a review and by when. The author is never assigned, at most
// one assignment is active, reassigning leaves a record, and an approval by someone who never opened the evidence is
// flagged. V0.3 §9.10: a policy change goes to someone who can approve it.
const root = mkdtempSync(join(tmpdir(), 'aperture-review-assignment-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

function commitOn(branch: string, file: string) {
  git('checkout', '--quiet', branch)
  mkdirSync(dirname(join(repositoryPath, file)), { recursive: true })
  writeFileSync(join(repositoryPath, file), `${branch}:${file}\n`)
  git('add', file)
  git('commit', '--quiet', '-m', file)
  git('checkout', '--quiet', 'main')
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Test')
git('config', 'user.email', 'aperture@example.test')
writeFileSync(join(repositoryPath, 'README.md'), '# Review assignment\n')
git('add', 'README.md')
git('commit', '--quiet', '-m', 'initial')
for (const branch of ['load-owner', 'load-maintainer', 'load-reviewer-a', 'main-change', 'claimed', 'policy', 'rejected', 'team-mode']) {
  git('branch', `agent/${branch}`, 'main')
  commitOn(`agent/${branch}`, branch === 'policy' ? '.aperture/project.json' : `${branch}.txt`)
}

const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const authority = new LocalGitAuthority(database)
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
const assignedEvents = (proposalId: string) => database.listAggregateEvents('change_proposal', proposalId).filter((event) => event.eventType === 'review.assigned')

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const maintainer = database.createActor({ username: 'maintainer', displayName: 'Maintainer', role: 'maintainer', password: 'maintainer-password-2026' }, owner.id)
  const reviewerA = database.createActor({ username: 'reviewer-a', displayName: 'Reviewer A', role: 'reviewer', password: 'reviewer-a-password-2026' }, owner.id)
  const reviewerB = database.createActor({ username: 'reviewer-b', displayName: 'Reviewer B', role: 'reviewer', password: 'reviewer-b-password-2026' }, owner.id)
  const author = database.createActor({ username: 'author', displayName: 'Author', role: 'developer', password: 'author-password-2026' }, owner.id)

  function proposalFor(branch: string) {
    const workItem = database.createWorkItem({ title: branch, description: branch, ownerActorId: author.id }, owner.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal: branch, constraints: [], riskLevel: 'low', acceptanceCriteria: [{ statement: 'unit suite passes', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
    const proposal = authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId: `RUN-${branch}`, repositoryPath, baseRef: 'main', headRef: `agent/${branch}`, authorActorId: author.id }, author.id)
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, owner.id)
    return proposal
  }

  // Load: Owner, Maintainer and Reviewer A each hold one open review, so Reviewer B is the least loaded.
  database.assignReviewer({ proposalId: proposalFor('load-owner').id, assigneeActorId: owner.id }, owner.id)
  database.assignReviewer({ proposalId: proposalFor('load-maintainer').id, assigneeActorId: maintainer.id }, owner.id)
  database.assignReviewer({ proposalId: proposalFor('load-reviewer-a').id, assigneeActorId: reviewerA.id }, maintainer.id)
  assert.deepEqual(database.listReviewerLoad().map((item) => [item.displayName, item.openAssignmentCount]), [['Maintainer', 1], ['Owner', 1], ['Reviewer A', 1], ['Reviewer B', 0]], 'developers carry no review load')

  const proposal = proposalFor('main-change')
  // Who may assign, and to whom.
  assert.throws(() => database.assignReviewer({ proposalId: proposal.id, assigneeActorId: reviewerA.id }, author.id), failsWith('review_assignment_forbidden'))
  assert.throws(() => database.assignReviewer({ proposalId: proposal.id, assigneeActorId: reviewerB.id }, reviewerA.id), failsWith('review_assignment_forbidden'), 'a reviewer may only claim for themselves')
  assert.throws(() => database.assignReviewer({ proposalId: proposal.id, assigneeActorId: author.id }, owner.id), failsWith('assignee_not_reviewer'))
  assert.throws(() => database.assignReviewer({ proposalId: proposal.id, dueHours: 0 }, owner.id), failsWith('invalid_due_hours'))

  const balanced = database.assignReviewer({ proposalId: proposal.id }, owner.id)
  assert.deepEqual([balanced.assigneeActorId, balanced.basis, balanced.status, balanced.headSha], [reviewerB.id, 'load_balanced', 'pending', proposal.headSha])
  assert.equal(Date.parse(balanced.dueAt) - Date.parse(balanced.assignedAt), 24 * 3600_000, 'default due window is one day')
  assert.equal(assignedEvents(proposal.id).at(-1)?.payload.assigneeOpenLoad, 0)

  // Only the assignee decides; anyone may comment; claiming an assigned review is not possible.
  assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewerA.id, decision: 'approved', comment: '' }), failsWith('review_not_assigned'))
  assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: owner.id, decision: 'changes_requested', comment: 'no' }), failsWith('review_not_assigned'), 'the role does not bypass the assignment')
  database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewerA.id, decision: 'commented', comment: 'drive-by note' })
  assert.throws(() => database.assignReviewer({ proposalId: proposal.id, assigneeActorId: reviewerA.id }, reviewerA.id), failsWith('review_assignment_forbidden'))
  assert.throws(() => database.assignReviewer({ proposalId: proposal.id, assigneeActorId: reviewerB.id, reason: 'again' }, owner.id), failsWith('already_assigned'))

  // Opening the evidence moves the assignment into review; deciding records the time spent.
  const evidence = database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-main-change', headSha: proposal.headSha, uri: 'local://evidence/m.json', sha256: 'sha256:m', summary: {} }, owner.id)
  database.recordEvidenceView(evidence.id, reviewerA.id, evidence.sha256)
  assert.equal(database.listReviewAssignments(proposal.id)[0].status, 'pending', 'a non-assignee viewing evidence does not open the assignment')
  database.recordEvidenceView(evidence.id, reviewerB.id, evidence.sha256)
  let active = database.listReviewAssignments(proposal.id)[0]
  assert.equal(active.status, 'in_review')
  assert.ok(active.evidenceOpenedAt)
  database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewerB.id, decision: 'approved', comment: 'checked' })
  active = database.listReviewAssignments(proposal.id)[0]
  assert.equal(active.status, 'approved')
  assert.equal(typeof active.timeSpentSeconds, 'number')
  const approval = database.listAggregateEvents('change_proposal', proposal.id).findLast((event) => event.eventType === 'review.approved')
  assert.deepEqual([approval?.payload.assignmentId, approval?.payload.evidenceOpenedBeforeDecision, approval?.payload.unopenedApproval], [balanced.id, true, false])

  // A new head keeps the assignee but resets everything they did on the old one.
  commitOn('agent/main-change', 'main-change-2.txt')
  const refreshed = authority.refreshChangeProposal(proposal.id, author.id)
  active = database.listReviewAssignments(proposal.id)[0]
  assert.deepEqual([active.id, active.status, active.headSha, active.evidenceOpenedAt, active.decidedAt], [balanced.id, 'pending', refreshed.proposal.headSha, undefined, undefined])
  assert.equal(database.listAggregateEvents('change_proposal', proposal.id).findLast((event) => event.eventType === 'change_proposal.revision_changed')?.payload.assignmentReset, balanced.id)

  // Reassigning needs a reason and ends the old record instead of rewriting it.
  assert.throws(() => database.assignReviewer({ proposalId: proposal.id, assigneeActorId: reviewerA.id }, maintainer.id), failsWith('reassign_reason_required'))
  const reassigned = database.assignReviewer({ proposalId: proposal.id, assigneeActorId: reviewerA.id, reason: 'Reviewer B is out this week', dueHours: 4 }, maintainer.id)
  const history = database.listReviewAssignments(proposal.id)
  assert.deepEqual(history.map((item) => [item.assigneeActorId, item.status]), [[reviewerB.id, 'reassigned'], [reviewerA.id, 'pending']])
  assert.ok(history[0].endedAt)
  assert.equal(reassigned.reassignedFrom, balanced.id)
  assert.deepEqual([assignedEvents(proposal.id).at(-1)?.payload.previousAssigneeActorId, assignedEvents(proposal.id).at(-1)?.payload.reason], [reviewerB.id, 'Reviewer B is out this week'])
  assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: refreshed.proposal.headSha, reviewerActorId: reviewerB.id, decision: 'approved', comment: '' }), failsWith('review_not_assigned'), 'the previous assignee lost the decision')

  // Overdue is derived, not stored: past due and still undecided.
  database.db.prepare('UPDATE review_assignments SET due_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', reassigned.id)
  assert.equal(database.listReviewAssignments(proposal.id)[1].overdue, true)

  // A reviewer claims an unassigned proposal; approving it on the light path without opening evidence is flagged.
  const claimed = proposalFor('claimed')
  assert.equal(database.assignReviewer({ proposalId: claimed.id, assigneeActorId: reviewerA.id }, reviewerA.id).basis, 'self_claim')
  database.recordReview({ proposalId: claimed.id, headSha: claimed.headSha, reviewerActorId: reviewerA.id, decision: 'approved', comment: '' })
  assert.equal(database.listAggregateEvents('change_proposal', claimed.id).findLast((event) => event.eventType === 'review.approved')?.payload.unopenedApproval, true)

  // A policy change goes only to an owner, by hand or by load.
  const policy = proposalFor('policy')
  assert.deepEqual(policy.policyFiles, ['.aperture/project.json'])
  assert.throws(() => database.assignReviewer({ proposalId: policy.id, assigneeActorId: reviewerB.id }, owner.id), failsWith('assignee_cannot_approve_policy_change'))
  assert.equal(database.assignReviewer({ proposalId: policy.id }, maintainer.id).assigneeActorId, owner.id)

  // A closed proposal takes no assignment.
  const rejected = proposalFor('rejected')
  database.rejectChangeProposal({ proposalId: rejected.id, headSha: rejected.headSha, reason: 'superseded by the policy change' }, reviewerA.id)
  assert.throws(() => database.assignReviewer({ proposalId: rejected.id }, owner.id), failsWith('proposal_closed'))
  assert.ok(database.verifyAggregateEventChain('change_proposal', proposal.id), 'assignments are part of the hash chain')

  // Team mode: an assignee without a verified GitHub identity could never decide, so they are neither assignable nor
  // picked by load. Only Owner is bound here, so the load pick falls to Owner even though others carry less load.
  const teamProposal = proposalFor('team-mode')
  database.db.prepare("INSERT INTO identity_bindings(actor_id, provider, expected_login, subject, login, verified_at, declared_by_actor_id, declared_at) VALUES (?, 'github', 'octo-owner', '1001', 'octo-owner', ?, ?, ?)").run(owner.id, new Date().toISOString(), owner.id, new Date().toISOString())
  database.db.prepare("UPDATE identity_settings SET mode = 'team'").run()
  assert.throws(() => database.assignReviewer({ proposalId: teamProposal.id }, owner.id), failsWith('external_identity_required'), 'an in-process call has no GitHub session')
  requestContext.run({ authMethod: 'github' }, () => {
    assert.throws(() => database.assignReviewer({ proposalId: teamProposal.id, assigneeActorId: reviewerB.id }, owner.id), failsWith('assignee_identity_unbound'))
    const teamAssignment = database.assignReviewer({ proposalId: teamProposal.id }, owner.id)
    assert.equal(teamAssignment.assigneeActorId, owner.id)
    assert.equal(assignedEvents(teamProposal.id).at(-1)?.payload.identity.login, 'octo-owner')
  })
  database.db.prepare("UPDATE identity_settings SET mode = 'development'").run()

  console.log('review assignment smoke passed · author never assigned · least-loaded pick · only the assignee decides · reassign needs a reason · new head resets · unopened approvals flagged · policy changes go to owners')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
