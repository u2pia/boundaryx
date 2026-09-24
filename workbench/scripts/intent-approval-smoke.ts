import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { AppError, type AcceptanceCriterionInput } from '../server/types.ts'

// DOMAIN_MODEL.md §6.1: only an Approved Intent may create a Run. V0.3 §10.1: low risk is approved by rule; medium and
// high risk need a named approver who is not the author, and a newer version supersedes the approval of an older one.
const root = mkdtempSync(join(tmpdir(), 'aperture-intent-approval-'))
const repositoryPath = join(root, 'repository')
const worktreeRoot = join(root, 'runs')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
execFileSync('git', ['-C', repositoryPath, 'config', 'user.name', 'Aperture Test'])
execFileSync('git', ['-C', repositoryPath, 'config', 'user.email', 'aperture@example.test'])
writeFileSync(join(repositoryPath, 'README.md'), '# Intent approval\n')
execFileSync('git', ['-C', repositoryPath, 'add', 'README.md'])
execFileSync('git', ['-C', repositoryPath, 'commit', '--quiet', '-m', 'initial'])

const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
// The agent never runs: every request below must be refused at admission, before a worktree exists.
const runner = new LocalCommandAgentRunner({ database, executable: process.execPath, args: ['-e', 'process.exit(1)'], worktreeRoot })
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code
const criteria: AcceptanceCriterionInput[] = [{ statement: 'imports over 5 MiB return file_too_large', criticality: 'critical', verificationType: 'deterministic' }]

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  const developer = database.createActor({ username: 'developer', displayName: 'Developer', role: 'developer', password: 'developer-password-2026' }, owner.id)
  const reviewer = database.createActor({ username: 'reviewer', displayName: 'Reviewer', role: 'reviewer', password: 'reviewer-password-2026' }, owner.id)
  const workItem = database.createWorkItem({ title: 'size limit', description: 'size limit', ownerActorId: owner.id }, owner.id)
  const start = (intentVersionId: string) => () => runner.prepare({ workItemId: workItem.id, intentVersionId, repositoryPath, baseRef: 'main', declaredContextPaths: ['README.md'] }, owner.id)

  // Low risk: the lightweight rule approves it at creation, and the event log says which rule did.
  const lowRisk = database.createIntentVersion({ workItemId: workItem.id, goal: 'fix a typo', constraints: [], riskLevel: 'low', acceptanceCriteria: criteria }, owner.id)
  assert.equal(lowRisk.status, 'approved')
  assert.deepEqual(lowRisk.approval, { basis: 'low_risk_rule', approvedAt: lowRisk.createdAt })
  assert.ok(database.listAggregateEvents('work_item', workItem.id).some((event) => event.eventType === 'intent.approved' && event.payload.basis === 'low_risk_rule'))

  // Medium risk: a new version starts as draft and supersedes the low risk version before it.
  const draft = database.createIntentVersion({ workItemId: workItem.id, goal: 'enforce a 5 MiB import limit', constraints: ['do not weaken existing tests'], riskLevel: 'medium', acceptanceCriteria: criteria }, owner.id)
  assert.equal(draft.status, 'draft')
  assert.equal(database.getIntentVersion(lowRisk.id).status, 'superseded')
  assert.throws(start(lowRisk.id), failsWith('intent_superseded'), 'an approval does not survive a newer version')
  assert.throws(start(draft.id), failsWith('intent_not_approved'))
  assert.equal(existsSync(worktreeRoot) ? readdirSync(worktreeRoot).length : 0, 0, 'a refused run leaves no worktree behind')

  // Who may approve: not a developer, not the author, and only once.
  assert.throws(() => database.approveIntentVersion(draft.id, developer.id), failsWith('intent_approval_forbidden'))
  assert.throws(() => database.approveIntentVersion(draft.id, owner.id), failsWith('self_intent_approval_forbidden'))
  const approved = database.approveIntentVersion(draft.id, reviewer.id, '  criteria are assertable  ')
  assert.equal(approved.status, 'approved')
  assert.deepEqual(approved.approval, { basis: 'named_approval', actorId: reviewer.id, approvedAt: approved.approval?.approvedAt, comment: 'criteria are assertable' })
  assert.throws(() => database.approveIntentVersion(draft.id, reviewer.id), failsWith('intent_already_approved'))
  const approvalEvent = database.listAggregateEvents('work_item', workItem.id).findLast((event) => event.eventType === 'intent.approved')
  assert.deepEqual([approvalEvent?.actorId, approvalEvent?.payload.contentDigest, approvalEvent?.payload.basis], [reviewer.id, draft.contentDigest, 'named_approval'], 'the approval is bound to the digest that was read')

  // Editing the Intent is a new version, which needs its own approval; the old approval cannot be reused.
  const revised = database.createIntentVersion({ workItemId: workItem.id, goal: 'enforce a 10 MiB import limit', constraints: ['do not weaken existing tests'], riskLevel: 'medium', acceptanceCriteria: criteria }, owner.id)
  assert.equal(database.getIntentVersion(draft.id).status, 'superseded')
  assert.throws(start(draft.id), failsWith('intent_superseded'))
  assert.equal(database.getIntentVersion(draft.id).approval?.actorId, reviewer.id, 'superseding keeps the historical approval on record')
  assert.throws(() => database.approveIntentVersion(draft.id, reviewer.id), failsWith('intent_superseded'))
  assert.throws(start(revised.id), failsWith('intent_not_approved'))
  assert.ok(database.verifyAggregateEventChain('work_item', workItem.id), 'approvals are part of the hash chain')

  console.log('intent approval smoke passed · low risk approved by rule · medium needs a non-author approver · new versions supersede · refused runs leave no worktree')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
