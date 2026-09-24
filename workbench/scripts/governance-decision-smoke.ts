import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mapCriteriaToChecks } from '../server/criteria-coverage.ts'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { AppError, type AcceptanceCriterionInput } from '../server/types.ts'

// DOMAIN_MODEL.md §5.6 / §6.4: bypassing a failed gate needs an explicit, named, reasoned Override Decision, and
// Reject ends a proposal outright. Both are bound to the head revision and the evidence they were judged against.
const root = mkdtempSync(join(tmpdir(), 'aperture-governance-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

function commitOn(branch: string, file: string) {
  git('checkout', '--quiet', branch)
  writeFileSync(join(repositoryPath, file), `${file}\n`)
  git('add', file)
  git('commit', '--quiet', '-m', file)
  git('checkout', '--quiet', 'main')
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Test')
git('config', 'user.email', 'aperture@example.test')
writeFileSync(join(repositoryPath, 'README.md'), '# Governance\n')
git('add', 'README.md')
git('commit', '--quiet', '-m', 'initial')
for (const branch of ['override', 'shared-check', 'integrity', 'reject']) {
  git('branch', `agent/${branch}`, 'main')
  commitOn(`agent/${branch}`, `${branch}.txt`)
}

const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const authority = new LocalGitAuthority(database)
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
const reason = 'flaky upstream fixture, tracked in ISSUE-42; behaviour verified by hand'

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const secondOwner = database.createActor({ username: 'owner2', displayName: 'Second Owner', role: 'owner', password: 'owner2-password-2026' }, owner.id)
  const reviewer = database.createActor({ username: 'reviewer', displayName: 'Reviewer', role: 'reviewer', password: 'reviewer-password-2026' }, owner.id)

  function proposalFor(branch: string, acceptanceCriteria: AcceptanceCriterionInput[]) {
    const workItem = database.createWorkItem({ title: branch, description: branch, ownerActorId: owner.id }, owner.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal: branch, constraints: [], riskLevel: 'low', acceptanceCriteria }, owner.id)
    const proposal = authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId: `RUN-${branch}`, repositoryPath, baseRef: 'main', headRef: `agent/${branch}`, authorActorId: owner.id }, owner.id)
    return { intent, proposal }
  }
  const deterministic = (statement: string): AcceptanceCriterionInput => ({ statement, criticality: 'critical', verificationType: 'deterministic' })

  // One failed criterion: only a non-author owner with a reason can override it, and the override dies with the head.
  {
    const { intent, proposal } = proposalFor('override', [deterministic('imports reject malformed rows')])
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'failure' }, reviewer.id)
    database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-override', headSha: proposal.headSha, uri: 'local://evidence/o.json', sha256: 'sha256:o', summary: {} }, reviewer.id)
    const criterionId = intent.acceptanceCriteria[0].id
    const input = { proposalId: proposal.id, headSha: proposal.headSha, criterionId, reason }
    assert.throws(() => database.recordOverride(input, reviewer.id), failsWith('override_forbidden'))
    assert.throws(() => database.recordOverride(input, owner.id), failsWith('self_override_forbidden'))
    assert.throws(() => database.recordOverride({ ...input, reason: 'ok' }, secondOwner.id), failsWith('override_reason_required'))
    assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: '' }), failsWith('review_blocked_by_failed_checks'))

    const decision = database.recordOverride(input, secondOwner.id)
    assert.equal(decision.overriddenStatus, 'failed')
    assert.deepEqual(decision.evidenceSha256, ['sha256:o'], 'the decision names the evidence version it judged')
    assert.throws(() => database.recordOverride(input, secondOwner.id), failsWith('override_exists'))
    const readiness = database.getReviewReadiness(proposal.id)
    assert.equal(readiness.criteria[0].status, 'overridden')
    assert.equal(readiness.criteria[0].override?.actorDisplayName, 'Second Owner')
    assert.deepEqual([readiness.failedCheckCount, readiness.waivedCheckCount, readiness.status], [0, 1, 'ready'])
    database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'accepting the override' })
    const approval = database.listAggregateEvents('change_proposal', proposal.id).findLast((event) => event.eventType === 'review.approved')
    assert.deepEqual(approval?.payload.criteria, [{ criterionId, status: 'overridden', overrideDecisionId: decision.id }])

    commitOn('agent/override', 'override-2.txt')
    const refreshed = authority.refreshChangeProposal(proposal.id, owner.id)
    assert.equal(refreshed.invalidated.overrides, 1)
    database.recordCheck({ proposalId: proposal.id, headSha: refreshed.proposal.headSha, name: 'unit', status: 'completed', conclusion: 'failure' }, reviewer.id)
    assert.equal(database.getReviewReadiness(proposal.id).criteria[0].status, 'failed', 'a new head needs a new decision')
  }

  // Rule mapping points every deterministic criterion at the same checks, so overriding one of them must not waive
  // a failure the other still rests on.
  {
    const { intent, proposal } = proposalFor('shared-check', [deterministic('rejects malformed rows'), deterministic('reports the row number')])
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'failure' }, reviewer.id)
    database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-shared', headSha: proposal.headSha, uri: 'local://evidence/s.json', sha256: 'sha256:s', summary: {} }, reviewer.id)
    database.recordOverride({ proposalId: proposal.id, headSha: proposal.headSha, criterionId: intent.acceptanceCriteria[0].id, reason }, secondOwner.id)
    let readiness = database.getReviewReadiness(proposal.id)
    assert.deepEqual(readiness.criteria.map((item) => item.status), ['overridden', 'failed'])
    assert.deepEqual([readiness.failedCheckCount, readiness.status], [1, 'blocked'])
    database.recordOverride({ proposalId: proposal.id, headSha: proposal.headSha, criterionId: intent.acceptanceCriteria[1].id, reason }, secondOwner.id)
    readiness = database.getReviewReadiness(proposal.id)
    assert.deepEqual([readiness.failedCheckCount, readiness.waivedCheckCount, readiness.status], [0, 1, 'ready'])
  }

  // Integrity checks map to no criterion, so no override can waive them.
  {
    const { intent, proposal } = proposalFor('integrity', [deterministic('rejects malformed rows')])
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'failure', source: 'run', runId: 'RUN-integrity' }, reviewer.id)
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'workspace-clean', status: 'completed', conclusion: 'failure', source: 'run', runId: 'RUN-integrity' }, reviewer.id)
    const criteriaCoverage = mapCriteriaToChecks(intent, [{ name: 'unit', kind: 'test', provenance: 'pre_existing', conclusion: 'failure' }, { name: 'workspace-clean', kind: 'integrity', conclusion: 'failure' }])
    database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-integrity', headSha: proposal.headSha, uri: 'local://evidence/i.json', sha256: 'sha256:i', summary: { criteriaCoverage } }, reviewer.id)
    database.recordOverride({ proposalId: proposal.id, headSha: proposal.headSha, criterionId: intent.acceptanceCriteria[0].id, reason }, secondOwner.id)
    const readiness = database.getReviewReadiness(proposal.id)
    assert.deepEqual([readiness.failedCheckCount, readiness.waivedCheckCount, readiness.status], [1, 1, 'blocked'])
  }

  // Reject is terminal: no review, check, refresh or override afterwards.
  {
    const { intent, proposal } = proposalFor('reject', [deterministic('rejects malformed rows')])
    const input = { proposalId: proposal.id, headSha: proposal.headSha, reason: '' }
    assert.throws(() => database.rejectChangeProposal({ ...input, reason: 'wrong approach' }, owner.id), failsWith('self_review_forbidden'))
    assert.throws(() => database.rejectChangeProposal(input, reviewer.id), failsWith('reject_reason_required'))
    const decision = database.rejectChangeProposal({ ...input, reason: 'solves the wrong problem; see the intent goal' }, reviewer.id)
    assert.equal(database.getChangeProposal(proposal.id).status, 'closed')
    assert.equal(database.listGovernanceDecisions(proposal.id).at(-1)?.id, decision.id)
    assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'commented', comment: 'late' }), failsWith('proposal_closed'))
    assert.throws(() => database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, reviewer.id), failsWith('proposal_closed'))
    assert.throws(() => authority.refreshChangeProposal(proposal.id, owner.id), failsWith('proposal_closed'))
    assert.throws(() => database.recordOverride({ proposalId: proposal.id, headSha: proposal.headSha, criterionId: intent.acceptanceCriteria[0].id, reason }, secondOwner.id), failsWith('proposal_closed'))
    assert.ok(database.verifyAggregateEventChain('change_proposal', proposal.id), 'the rejection is part of the hash chain')
  }

  console.log('governance decision smoke passed · override named, reasoned, head-bound · shared checks need every dependent overridden · integrity never waived · reject is terminal')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
