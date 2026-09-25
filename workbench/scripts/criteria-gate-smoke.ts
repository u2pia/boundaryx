import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mapCriteriaToChecks } from '../server/criteria-coverage.ts'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { AppError, type AcceptanceCriterionInput, type IntentVersion } from '../server/types.ts'

// DOMAIN_MODEL.md §5.6: every critical acceptance criterion needs mapped evidence, a failed or unevidenced critical
// criterion cannot reach Approved, and model evaluation cannot be the only critical evidence for high risk.
const root = mkdtempSync(join(tmpdir(), 'aperture-criteria-gate-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Test')
git('config', 'user.email', 'aperture@example.test')
writeFileSync(join(repositoryPath, 'README.md'), '# Criteria gate\n')
git('add', 'README.md')
git('commit', '--quiet', '-m', 'initial')
for (const branch of ['model-unmapped', 'low-risk', 'high-risk', 'self-graded']) {
  git('checkout', '--quiet', '-b', `agent/${branch}`, 'main')
  writeFileSync(join(repositoryPath, `${branch}.txt`), `${branch}\n`)
  git('add', `${branch}.txt`)
  git('commit', '--quiet', '-m', branch)
}
git('checkout', '--quiet', 'main')

const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const authority = new LocalGitAuthority(database)
const blockedBy = (code: string) => (error: unknown) => error instanceof AppError && error.code === code

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const author = database.createActor({ username: 'author', displayName: 'Author', role: 'developer', password: 'author-password-2026' }, owner.id)
  const reviewer = database.createActor({ username: 'reviewer', displayName: 'Reviewer', role: 'reviewer', password: 'reviewer-password-2026' }, owner.id)

  function proposalFor(branch: string, riskLevel: IntentVersion['riskLevel'], acceptanceCriteria: AcceptanceCriterionInput[]) {
    const workItem = database.createWorkItem({ title: branch, description: branch, ownerActorId: author.id }, owner.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal: branch, constraints: [], riskLevel, acceptanceCriteria }, owner.id)
    const proposal = authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId: `RUN-${branch}`, repositoryPath, baseRef: 'main', headRef: `agent/${branch}`, authorActorId: author.id }, author.id)
    return { intent, proposal }
  }

  // Externally recorded checks carry no kind, so a model-verified criterion has nothing it can be mapped to.
  {
    const { proposal } = proposalFor('model-unmapped', 'medium', [
      { statement: 'unit suite passes', criticality: 'critical', verificationType: 'deterministic' },
      { statement: 'answers stay grounded', criticality: 'critical', verificationType: 'model' },
    ])
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, author.id)
    const evidence = database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-model-unmapped', headSha: proposal.headSha, uri: 'local://evidence/a.json', sha256: 'sha256:a', summary: {} }, author.id)
    const readiness = database.getReviewReadiness(proposal.id)
    assert.deepEqual(readiness.criteria.map((item) => item.status), ['passed', 'unmapped'])
    assert.equal(readiness.status, 'blocked')
    assert.ok(readiness.blockers.some((blocker) => blocker.startsWith('AC-2 is critical but no check maps to it')))
    database.recordEvidenceView(evidence.id, reviewer.id, evidence.sha256)
    assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'looks fine' }), blockedBy('review_blocked_by_criteria'))
    // Requesting changes is always allowed: the gate only guards the path into Approved.
    database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'changes_requested', comment: 'add a grounded-answer evaluation' })
  }

  // The low risk light path skips evidence viewing, not the criteria: zero checks means nothing is proven yet.
  {
    const { proposal } = proposalFor('low-risk', 'low', [{ statement: 'copy renders', criticality: 'critical', verificationType: 'deterministic' }])
    assert.equal(database.getReviewReadiness(proposal.id).criteria[0].status, 'pending')
    assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'trivial' }), blockedBy('review_blocked_by_criteria'))
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'neutral' }, author.id)
    assert.equal(database.getReviewReadiness(proposal.id).criteria[0].status, 'failed', 'a skipped check proves nothing')
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, author.id)
    assert.equal(database.getReviewReadiness(proposal.id).criteria[0].status, 'passed')
    database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: '' })
    assert.equal(database.getChangeProposal(proposal.id).status, 'approved')
  }

  // A run-packaged mapping knows check kinds. The human criterion is evidenced by the approval itself, which
  // therefore has to record the reviewer's judgement; an unmapped normal criterion is reported but does not block.
  {
    const { intent, proposal } = proposalFor('high-risk', 'high', [
      { statement: 'revoked sessions are rejected', criticality: 'critical', verificationType: 'deterministic' },
      { statement: 'security owner accepts the threat model', criticality: 'critical', verificationType: 'human' },
      { statement: 'error copy reads naturally', criticality: 'normal', verificationType: 'model' },
    ])
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success' }, author.id)
    const criteriaCoverage = mapCriteriaToChecks(intent, [{ name: 'unit', kind: 'test', provenance: 'pre_existing' }])
    const evidence = database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-high-risk', headSha: proposal.headSha, uri: 'local://evidence/c.json', sha256: 'sha256:c', summary: { criteriaCoverage } }, author.id)
    const readiness = database.getReviewReadiness(proposal.id)
    assert.deepEqual(readiness.criteria.map((item) => item.status), ['passed', 'awaiting_review', 'unmapped'])
    assert.equal(readiness.criteria[0].independent, true)
    assert.equal(readiness.status, 'ready')
    database.recordEvidenceView(evidence.id, reviewer.id, evidence.sha256)
    assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: '  ' }), blockedBy('review_human_criteria_unsigned'))
    // The approval signs each human criterion by label: a comment that names none of them signs none of them.
    assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'ok' }), blockedBy('review_human_criteria_unsigned'))
    assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'AC-20 and AC-12 look fine' }), blockedBy('review_human_criteria_unsigned'))
    database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'AC-2: threat model reviewed with security owner' })
    const approval = database.listAggregateEvents('change_proposal', proposal.id).findLast((event) => event.eventType === 'review.approved')
    assert.deepEqual(approval?.payload.humanCriteriaSignedOff, [`${intent.id}:AC-2`])
  }

  // DOMAIN_MODEL.md §5.6 provenance: tests the run could have authored cannot be the only proof of a critical criterion.
  {
    const { intent, proposal } = proposalFor('self-graded', 'medium', [
      { statement: 'imports reject malformed rows', criticality: 'critical', verificationType: 'deterministic' },
      { statement: 'summaries stay grounded', criticality: 'normal', verificationType: 'model' },
    ])
    const unverified = mapCriteriaToChecks(intent, [{ name: 'unit', kind: 'test', provenance: 'unverified', conclusion: 'success' }, { name: 'grader', kind: 'evaluation', conclusion: 'success' }])
    assert.deepEqual(unverified.map((item) => item.independent), [false, false], 'no testPaths and no verified dataset: nothing is independent')
    const withBaseline = mapCriteriaToChecks(intent, [{ name: 'unit', kind: 'test', provenance: 'all_tests' }, { name: 'unit@baseline', kind: 'test', provenance: 'pre_existing' }])
    assert.equal(withBaseline[0].independent, true, 'a re-run on the base test files is independent')
    const datasetVerified = mapCriteriaToChecks(intent, [{ name: 'evaluation-dataset-integrity', kind: 'integrity', conclusion: 'success' }, { name: 'grader', kind: 'evaluation', conclusion: 'success' }])
    assert.equal(datasetVerified[1].independent, true, 'a verified hidden dataset makes the evaluation independent')

    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success', source: 'run', runId: 'RUN-self-graded' }, owner.id)
    database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'grader', status: 'completed', conclusion: 'success', source: 'run', runId: 'RUN-self-graded' }, owner.id)
    const evidence = database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-self-graded', headSha: proposal.headSha, uri: 'local://evidence/d.json', sha256: 'sha256:d', summary: { criteriaCoverage: unverified } }, author.id)
    const readiness = database.getReviewReadiness(proposal.id)
    assert.deepEqual(readiness.criteria.map((item) => item.status), ['self_graded', 'self_graded'])
    assert.equal(readiness.status, 'blocked')
    assert.equal(readiness.blockers.filter((blocker) => blocker.includes('only passed tests the run could have authored')).length, 1, 'only the critical criterion blocks')
    database.recordEvidenceView(evidence.id, reviewer.id, evidence.sha256)
    assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'tests pass' }), blockedBy('review_blocked_by_criteria'))
  }

  // F2.2: the human criterion a high risk Intent rests on has to say what the approver judges.
  {
    const workItem = database.createWorkItem({ title: 'placeholder', description: 'placeholder', ownerActorId: author.id }, owner.id)
    const deterministic = { statement: 'revoked sessions are rejected', criticality: 'critical' as const, verificationType: 'deterministic' as const }
    for (const statement of ['ok', '人工审核通过', '<谁> 确认 <什么>']) assert.throws(() => database.createIntentVersion({ workItemId: workItem.id, goal: 'g', constraints: [], riskLevel: 'high', acceptanceCriteria: [deterministic, { statement, criticality: 'critical', verificationType: 'human' }] }, owner.id), blockedBy('human_criterion_not_substantive'), statement)
    // A normal human criterion signs nothing, so its wording is left to the linter's warnings.
    database.createIntentVersion({ workItemId: workItem.id, goal: 'g', constraints: [], riskLevel: 'low', acceptanceCriteria: [deterministic, { statement: 'ok', criticality: 'normal', verificationType: 'human' }] }, owner.id)
  }

  // DOMAIN_MODEL.md §5.6: a person may name the checks that prove a criterion; the name replaces the rule.
  {
    const workItem = database.createWorkItem({ title: 'declared', description: 'declared', ownerActorId: author.id }, owner.id)
    const criteria = [
      { statement: 'imports reject malformed rows', criticality: 'critical' as const, verificationType: 'deterministic' as const, verifiedBy: ['import-tests'] },
      { statement: 'the lint suite stays clean', criticality: 'critical' as const, verificationType: 'deterministic' as const, verifiedBy: ['lint'] },
      { statement: 'rows are counted', criticality: 'critical' as const, verificationType: 'deterministic' as const },
    ]
    assert.throws(() => database.createIntentVersion({ workItemId: workItem.id, goal: 'g', constraints: [], riskLevel: 'medium', acceptanceCriteria: [{ statement: 'copy reads naturally to a reviewer', criticality: 'critical', verificationType: 'human', verifiedBy: ['unit'] }] }, owner.id), blockedBy('invalid_acceptance_criteria'), 'a human criterion is signed, not checked')
    assert.throws(() => database.createIntentVersion({ workItemId: workItem.id, goal: 'g', constraints: [], riskLevel: 'medium', acceptanceCriteria: [{ ...criteria[0], verifiedBy: ['unit@baseline'] }] }, owner.id), blockedBy('invalid_acceptance_criteria'), 'baseline re-runs follow their check')
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal: 'g', constraints: [], riskLevel: 'medium', acceptanceCriteria: criteria }, owner.id)
    assert.deepEqual(database.getIntentVersion(intent.id).acceptanceCriteria.map((item) => item.verifiedBy), [['import-tests'], ['lint'], undefined], 'stored and read back')
    const coverage = mapCriteriaToChecks(intent, [{ name: 'import-tests', kind: 'test', provenance: 'all_tests' }, { name: 'import-tests@baseline', kind: 'test', provenance: 'pre_existing' }, { name: 'unit', kind: 'test', provenance: 'pre_existing' }])
    assert.deepEqual(coverage.map((item) => [item.mapping, item.checkNames]), [['declared', ['import-tests', 'import-tests@baseline']], ['declared', []], ['rule', ['import-tests', 'import-tests@baseline', 'unit']]])
    assert.equal(coverage[0].independent, true, 'the named check brings its baseline re-run')
    assert.match(coverage[1].unmappedReason ?? '', /Declared check lint did not run/u, 'a named check that never ran does not fall back to the rule')
    // The declaration is part of what the approver read, and an Intent without one hashes as it did before verifiedBy
    // existed; keys a caller adds on top of the declared fields change nothing.
    const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
    assert.equal(intent.contentDigest, hash({ workItemId: workItem.id, version: 1, goal: 'g', constraints: [], riskLevel: 'medium', acceptanceCriteria: criteria }))
    const plain = criteria.map(({ verifiedBy: _verifiedBy, ...criterion }) => criterion)
    const undeclared = database.createIntentVersion({ workItemId: workItem.id, goal: 'g', constraints: [], riskLevel: 'medium', acceptanceCriteria: plain.map((criterion) => ({ ...criterion, note: 'ignored' })) }, owner.id)
    assert.equal(undeclared.contentDigest, hash({ workItemId: workItem.id, version: 2, goal: 'g', constraints: [], riskLevel: 'medium', acceptanceCriteria: plain }))
  }

  console.log('criteria gate smoke passed · unmapped model criterion blocked · low risk needs evidence · human criteria signed off by label · placeholder human criteria refused · declared verifiedBy replaces the rule · self-graded tests blocked')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
