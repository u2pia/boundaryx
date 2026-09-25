import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { LocalGitAuthority } from '../server/local-git-authority.ts'
import { AppError } from '../server/types.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-local-control-plane-'))
const repositoryPath = join(root, 'repository')
const databasePath = join(root, 'control-plane.db')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Test')
git('config', 'user.email', 'aperture@example.test')
writeFileSync(join(repositoryPath, 'README.md'), '# Local Authority\n')
git('add', 'README.md')
git('commit', '-m', 'initial')
git('checkout', '-b', 'agent/local-authority')
writeFileSync(join(repositoryPath, 'feature.txt'), 'first revision\n')
git('add', 'feature.txt')
git('commit', '-m', 'agent change')

const database = new ControlPlaneDatabase(databasePath, migrationDirectory)
const authority = new LocalGitAuthority(database)

/** Rewrites a proposal's events from genesis with every digest recomputed (UPDATE trigger dropped); returns the undo. */
function rewriteProposalChain(database: ControlPlaneDatabase, forger: DatabaseSync, proposalId: string) {
  const updateTrigger = forger.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'domain_events' AND sql LIKE '%UPDATE%'").get() as { name: string; sql: string }
  const originals = forger.prepare("SELECT id, payload_json, previous_event_digest, event_digest FROM domain_events WHERE aggregate_type = 'change_proposal' AND aggregate_id = ? ORDER BY aggregate_version").all(proposalId) as Array<{ id: string; payload_json: string; previous_event_digest: string; event_digest: string }>
  const update = () => forger.prepare('UPDATE domain_events SET payload_json = ?, previous_event_digest = ?, event_digest = ? WHERE id = ?')
  forger.exec(`DROP TRIGGER ${updateTrigger.name}`)
  let previousDigest = 'genesis'
  for (const [index, event] of database.listAggregateEvents('change_proposal', proposalId).entries()) {
    const payload = index === 0 ? { ...event.payload, rewritten: true } : event.payload
    const eventDigest = `sha256:${createHash('sha256').update(JSON.stringify({ aggregateType: event.aggregateType, aggregateId: event.aggregateId, aggregateVersion: event.aggregateVersion, eventType: event.eventType, actorId: event.actorId ?? null, payload, previousEventDigest: previousDigest, occurredAt: event.occurredAt })).digest('hex')}`
    update().run(JSON.stringify(payload), previousDigest, eventDigest, event.id)
    previousDigest = eventDigest
  }
  return () => {
    for (const original of originals) update().run(original.payload_json, original.previous_event_digest, original.event_digest, original.id)
    forger.exec(updateTrigger.sql)
  }
}

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Local Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const author = database.createActor({ username: 'author', displayName: 'Agent Author', role: 'developer', password: 'author-password-2026' }, owner.id)
  const reviewer = database.createActor({ username: 'reviewer', displayName: 'Human Reviewer', role: 'reviewer', password: 'reviewer-password-2026' }, owner.id)

  assert.equal(database.authenticate('reviewer', 'reviewer-password-2026').id, reviewer.id)
  assert.throws(() => database.authenticate('reviewer', 'wrong-password'), (error) => error instanceof AppError && error.status === 401)

  const workItem = database.createWorkItem({ title: '建立本地 Authority', description: '使用真实 Git revision 模拟 Change Proposal。', ownerActorId: author.id }, owner.id)
  const intent = database.createIntentVersion({ workItemId: workItem.id, goal: '在无 GitHub 环境下完成可追溯审查', constraints: ['完全离线', '禁止作者自批'], riskLevel: 'medium', acceptanceCriteria: [
    { statement: 'Change Proposal 绑定真实 Head SHA', criticality: 'critical', verificationType: 'deterministic' },
    { statement: '新 Commit 使旧审查失效', criticality: 'critical', verificationType: 'deterministic' },
  ] }, owner.id)

  const proposal = authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId: 'RUN-LOCAL-001', repositoryPath, baseRef: 'main', headRef: 'agent/local-authority', authorActorId: author.id }, author.id)
  assert.equal(proposal.changedFiles, 1)
  assert.equal(proposal.status, 'review_ready')
  assert.match(proposal.baseSha, /^[0-9a-f]{40}$/u)
  assert.match(proposal.headSha, /^[0-9a-f]{40}$/u)

  database.recordCheck({ proposalId: proposal.id, headSha: proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success', evidenceRef: 'artifact://unit.json' }, author.id)
  const evidence = database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-LOCAL-001', headSha: proposal.headSha, uri: 'local://evidence/run-local-001.json', sha256: 'sha256:test-evidence', summary: { passed: 12, failed: 0 } }, author.id)
  const initialReadiness = database.getReviewReadiness(proposal.id)
  assert.equal(initialReadiness.status, 'ready')
  assert.equal(initialReadiness.successfulCheckCount, 1)
  assert.equal(initialReadiness.evidence.length, 1)

  assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: author.id, decision: 'approved', comment: 'self approval' }), (error) => error instanceof AppError && error.code === 'self_review_forbidden')
  database.recordEvidenceView(evidence.id, owner.id, evidence.sha256)
  database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: owner.id, decision: 'approved', comment: 'owner evidence verified' })
  const requestedChanges = database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'changes_requested', comment: 'add a regression check' })
  assert.equal(requestedChanges.reviewerActorId, reviewer.id)
  assert.equal(database.getChangeProposal(proposal.id).status, 'changes_requested')
  assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'approve without viewing evidence' }), (error) => error instanceof AppError && error.code === 'review_evidence_not_viewed')
  database.recordEvidenceView(evidence.id, reviewer.id, evidence.sha256)
  const review = database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'regression evidence verified' })
  assert.equal(review.reviewerActorId, reviewer.id)
  assert.equal(database.getChangeProposal(proposal.id).status, 'approved')
  const reviewsBeforeRefresh = database.listReviews()
  assert.equal(reviewsBeforeRefresh.length, 3)
  assert.equal(reviewsBeforeRefresh.filter((item) => Boolean(item.invalidatedAt)).length, 1)
  assert.equal(database.getReviewMetrics().currentDecisionCount, 2)
  assert.equal(database.getReviewMetrics().approvedCount, 1)
  const reviewEvent = database.listAggregateEvents('change_proposal', proposal.id).findLast((event) => event.eventType === 'review.approved')
  assert.equal(reviewEvent?.payload.evidenceReadiness, 'ready')
  assert.equal((reviewEvent?.payload.checkIds as unknown[]).length, 1)
  assert.equal((reviewEvent?.payload.evidenceIds as unknown[]).length, 1)

  writeFileSync(join(repositoryPath, 'feature.txt'), 'second revision\n')
  git('add', 'feature.txt')
  git('commit', '-m', 'agent follow-up')
  const refresh = authority.refreshChangeProposal(proposal.id, author.id)
  assert.equal(refresh.changed, true)
  assert.deepEqual(refresh.invalidated, { reviews: 2, checks: 1, evidence: 1, overrides: 0 })
  assert.equal(refresh.proposal.status, 'review_ready')
  assert.notEqual(refresh.proposal.headSha, proposal.headSha)
  assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'stale review' }), (error) => error instanceof AppError && error.code === 'stale_head')
  const metricsAfterRefresh = database.getReviewMetrics()
  assert.equal(metricsAfterRefresh.pendingCount, 1)
  assert.equal(metricsAfterRefresh.currentDecisionCount, 0)
  assert.equal(metricsAfterRefresh.invalidatedDecisionCount, 3)
  const refreshedReadiness = database.getReviewReadiness(proposal.id)
  assert.equal(refreshedReadiness.status, 'incomplete')
  assert.equal(refreshedReadiness.invalidatedCheckCount, 1)
  assert.equal(refreshedReadiness.invalidatedEvidenceCount, 1)
  database.recordCheck({ proposalId: proposal.id, headSha: refresh.proposal.headSha, name: 'unit', status: 'completed', conclusion: 'failure' }, author.id)
  assert.equal(database.getReviewReadiness(proposal.id).status, 'blocked')
  assert.throws(() => database.recordReview({ proposalId: proposal.id, headSha: refresh.proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'approve despite failure' }), (error) => error instanceof AppError && error.code === 'review_blocked_by_failed_checks')
  assert.throws(() => authority.mergeChangeProposal(proposal.id, owner.id), (error) => error instanceof AppError && error.code === 'merge_not_approved')

  database.recordCheck({ proposalId: proposal.id, headSha: refresh.proposal.headSha, name: 'unit', status: 'completed', conclusion: 'success', evidenceRef: 'artifact://unit-v2.json' }, author.id)
  const recordedProposalHead = database.listAggregateEvents('change_proposal', proposal.id).at(-1)!.eventDigest
  const refreshedEvidence = database.recordEvidence({ proposalId: proposal.id, runId: 'RUN-LOCAL-001', headSha: refresh.proposal.headSha, uri: 'local://evidence/run-local-001-v2.json', sha256: 'sha256:test-evidence-v2', summary: { passed: 14, failed: 0, eventChainHeads: { runEventChainHead: 'genesis', proposalEventChainHead: recordedProposalHead } } }, author.id)
  database.recordEvidenceView(refreshedEvidence.id, reviewer.id, refreshedEvidence.sha256)
  database.recordReview({ proposalId: proposal.id, headSha: refresh.proposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'follow-up evidence verified' })
  git('checkout', 'main')
  // An event inserted around the Control Plane (INSERT is not blocked by the append-only triggers) breaks the hash
  // chain, and the merge refuses before the branch moves.
  const forger = new DatabaseSync(databasePath)
  const last = forger.prepare("SELECT * FROM domain_events WHERE aggregate_type = 'change_proposal' AND aggregate_id = ? ORDER BY aggregate_version DESC LIMIT 1").get(proposal.id) as Record<string, string | number>
  forger.prepare("INSERT INTO domain_events(id, project_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, payload_json, previous_event_digest, event_digest, occurred_at, recorded_at) VALUES ('EVT-FORGED', ?, 'change_proposal', ?, ?, 'review.approved', ?, '{}', ?, 'sha256:forged', ?, ?)").run(last.project_id, proposal.id, Number(last.aggregate_version) + 1, reviewer.id, last.event_digest, String(last.occurred_at), String(last.recorded_at))
  const mainBefore = git('rev-parse', 'main')
  assert.throws(() => authority.mergeChangeProposal(proposal.id, owner.id), (error) => error instanceof AppError && error.code === 'event_chain_broken')
  assert.equal(git('rev-parse', 'main'), mainBefore, 'a broken chain refuses before the branch moves')
  // Undoing the forgery takes dropping a trigger, which only someone with the database file can do.
  const deleteTrigger = forger.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'domain_events' AND sql LIKE '%DELETE%'").get() as { name: string; sql: string }
  forger.exec(`DROP TRIGGER ${deleteTrigger.name}; DELETE FROM domain_events WHERE id = 'EVT-FORGED'; ${deleteTrigger.sql};`)
  // A chain rewritten from genesis with every digest recomputed verifies on its own; the head the evidence package
  // recorded is what no longer matches.
  const restoreChain = rewriteProposalChain(database, forger, proposal.id)
  assert.equal(database.verifyAggregateEventChain('change_proposal', proposal.id), true, 'the rewritten chain is self-consistent')
  assert.throws(() => authority.mergeChangeProposal(proposal.id, owner.id), (error) => error instanceof AppError && error.code === 'event_chain_broken' && /head recorded by/u.test(error.message))
  assert.equal(git('rev-parse', 'main'), mainBefore)
  restoreChain()
  forger.close()
  assert.equal(database.verifyAggregateEventChain('change_proposal', proposal.id), true)
  const merged = authority.mergeChangeProposal(proposal.id, owner.id)
  assert.equal(merged.changed, true)
  assert.equal(merged.proposal.status, 'merged')
  assert.equal(merged.evidence.approvedHeadSha, refresh.proposal.headSha)
  assert.equal(merged.evidence.mergedSha, refresh.proposal.headSha)
  assert.match(merged.evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(git('rev-parse', 'main'), refresh.proposal.headSha)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(database.getWorkItem(workItem.id).status, 'done')
  const repeatedMerge = authority.mergeChangeProposal(proposal.id, owner.id)
  assert.equal(repeatedMerge.changed, false)
  assert.equal(repeatedMerge.evidence.evidenceDigest, merged.evidence.evidenceDigest)
  assert.throws(() => database.db.prepare("UPDATE merge_evidence SET merged_sha = 'tampered' WHERE change_proposal_id = ?").run(proposal.id), /append-only/u)
  // Merge evidence names the proposal chain head it was decided on; a rewritten chain no longer contains it.
  const postMergeForger = new DatabaseSync(databasePath)
  const restoreAfterMerge = rewriteProposalChain(database, postMergeForger, proposal.id)
  assert.throws(() => database.getMergeEvidence(proposal.id), (error) => error instanceof AppError && error.code === 'merge_evidence_chain_mismatch')
  restoreAfterMerge()
  postMergeForger.close()

  assert.equal(database.verifyAggregateEventChain('work_item', workItem.id), true)
  assert.equal(database.verifyAggregateEventChain('change_proposal', proposal.id), true)
  assert.throws(() => database.db.prepare("UPDATE domain_events SET event_type = 'tampered' WHERE aggregate_id = ?").run(proposal.id), /append-only/u)

  console.log(`local control plane smoke passed · ${proposal.id} · ${proposal.headSha.slice(0, 7)} → ${refresh.proposal.headSha.slice(0, 7)} · merged · ${database.listEvents().length} events`)
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
