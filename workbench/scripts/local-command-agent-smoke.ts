import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { LocalRunPostprocessor } from '../server/local-run-postprocessor.ts'
import { loadProjectManifest } from '../server/project-manifest.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-local-agent-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const agentScript = join(root, 'fixture-agent.mjs')
const checkScript = join(root, 'fixture-check.mjs')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Agent Test')
git('config', 'user.email', 'agent-test@aperture.invalid')
writeFileSync(join(repositoryPath, 'README.md'), '# Agent Fixture\n')
mkdirSync(join(repositoryPath, '.aperture'))
mkdirSync(join(repositoryPath, 'evals'))
writeFileSync(join(repositoryPath, 'evals/dataset.jsonl'), '{"id":"task-1","input":"generate a feature","expected":"feature.ts exists"}\n')
writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'agent_system', context: { required: ['README.md'], allowed: ['README.md'] }, testPaths: ['tests'], checks: [{ name: 'feature-test', kind: 'test', command: [process.execPath, 'tests/feature.test.mjs'], timeoutMs: 10_000 }, { name: 'feature-check', kind: 'evaluation', command: [process.execPath, checkScript], timeoutMs: 10_000 }], evaluation: { profile: 'agent_dataset', datasetPath: 'evals/dataset.jsonl', harnessPaths: ['evals'], thresholds: [{ metric: 'task_success_rate', operator: 'gte', threshold: 0.9 }] }, policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true } }, null, 2))
// The deterministic criterion needs a test the run did not write: an evaluation is never independent evidence.
mkdirSync(join(repositoryPath, 'tests'))
writeFileSync(join(repositoryPath, 'tests/feature.test.mjs'), "import { readFileSync } from 'node:fs'\nif (!readFileSync('feature.ts', 'utf8').includes('generatedByAgent')) process.exit(1)\n")
git('add', 'README.md', '.aperture/project.json', 'evals/dataset.jsonl', 'tests/feature.test.mjs')
git('commit', '-m', 'initial')
const validManifest = readFileSync(join(repositoryPath, '.aperture/project.json'), 'utf8')
const initialSha = git('rev-parse', 'HEAD')
writeFileSync(join(repositoryPath, '.aperture/project.json'), validManifest.replace('"allowed": [\n      "README.md"\n    ]', '"allowed": [\n      "README.md",\n      "evals/dataset.jsonl"\n    ]'))
git('add', '.aperture/project.json')
git('commit', '-m', 'invalid exposed evaluation dataset')
assert.throws(() => loadProjectManifest(repositoryPath, git('rev-parse', 'HEAD')), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'evaluation_dataset_context_exposed')
git('reset', '--hard', initialSha)
writeFileSync(agentScript, `import { readFileSync, writeFileSync } from 'node:fs'\nconst request = JSON.parse(readFileSync(process.env.APERTURE_RUN_REQUEST, 'utf8'))\nreadFileSync('README.md', 'utf8')\nconsole.log(JSON.stringify({ type: 'context_consumed', path: 'README.md' }))\nconsole.log(JSON.stringify({ type: 'context_consumed', path: '../outside.txt' }))\nconsole.log(JSON.stringify({ type: 'message', summary: 'Implemented the requested local change.' }))\nconst untilDeadline = Number(process.env.APERTURE_RUN_DEADLINE) - Date.now()\nconsole.log(JSON.stringify({ type: 'message', summary: untilDeadline > 0 && untilDeadline <= 10000 ? 'deadline ahead' : 'deadline missing' }))\nconst goal = request.intent.goal\nif (goal.includes('时间预算') && !request.revision) console.log(JSON.stringify({ type: 'message', summary: 'Stopped at the time budget; feature.ts only.', stopped: 'time_budget' }))\nconst mode = goal.includes('缺失指标') ? 'missing' : goal.includes('低于阈值') ? 'below' : goal.includes('篡改数据集') ? 'tamper' : 'pass'\nif (mode !== 'pass') writeFileSync('evaluation-mode.txt', mode + '\\n')\nif (mode === 'tamper') writeFileSync('evals/dataset.jsonl', '{"id":"tampered"}\\n')\nwriteFileSync('feature.ts', 'export const generatedByAgent = ' + JSON.stringify(request.runId) + '\\n')\n`)
writeFileSync(checkScript, `import { existsSync, readFileSync } from 'node:fs'\nif (!readFileSync('feature.ts', 'utf8').includes('generatedByAgent')) process.exit(1)\nconst mode = existsSync('evaluation-mode.txt') ? readFileSync('evaluation-mode.txt', 'utf8').trim() : 'pass'\nif (mode !== 'missing') console.log(JSON.stringify({ type: 'evaluation_metrics', metrics: { task_success_rate: mode === 'below' ? 0.5 : 1, tool_call_accuracy: 1 } }))\nconsole.log('feature evaluation completed')\n`)

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const reviewer = database.createActor({ username: 'reviewer', displayName: 'Revision Reviewer', role: 'reviewer', password: 'reviewer-password-2026' }, owner.id)
  const workItem = database.createWorkItem({ title: '执行真实本地 Agent', description: '外部进程在独立 worktree 中生成变更。', productType: 'agent_system', ownerActorId: owner.id }, owner.id)
  assert.equal(workItem.productType, 'agent_system')
  const intent = database.createIntentVersion({ workItemId: workItem.id, goal: '在隔离分支中生成可审查代码变更', constraints: ['不得修改 main 工作区'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '产生真实 Git commit', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
  const evidenceStore = new LocalEvidenceStore(join(root, 'evidence'))
  const postprocessor = new LocalRunPostprocessor({ database, evidenceStore })
  const runner = new LocalCommandAgentRunner({ database, executable: process.execPath, args: [agentScript], worktreeRoot: join(root, 'runs'), timeoutMs: 10_000, postprocessor })
  // DOMAIN_MODEL.md §6.1: a medium risk Intent cannot start a Run until someone other than its author approves it.
  assert.throws(() => runner.run({ workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: 'main', declaredContextPaths: ['README.md'] }, owner.id), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'intent_not_approved')
  database.approveIntentVersion(intent.id, reviewer.id)
  assert.throws(() => runner.run({ workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: 'main', declaredContextPaths: ['README.md', 'AGENTS.md'] }, owner.id), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'project_manifest_context_forbidden')
  // An empty declaration still carries the manifest's required context.
  const run = runner.run({ workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: 'main', declaredContextPaths: [] }, owner.id)
  assert.deepEqual(database.getAgentRunPlan(run.id).declaredContextPaths, ['README.md'])

  assert.equal(run.status, 'succeeded')
  assert.equal(run.isolation, 'unisolated_process')
  assert.ok(run.changeProposalId)
  assert.equal(git('branch', '--show-current'), 'main')
  assert.equal(git('status', '--porcelain'), '')
  const proposal = database.getChangeProposal(run.changeProposalId!)
  assert.equal(proposal.runId, run.id)
  assert.equal(proposal.changedFiles, 1)
  const events = database.listAggregateEvents('agent_run', run.id)
  // The agent is told when the runner will kill it, within the run's timeout.
  assert.ok(events.some((event) => event.eventType === 'agent_run.message' && event.payload.summary === 'deadline ahead'))
  assert.equal(events.some((event) => event.eventType === 'agent_run.project_manifest_bound'), true)
  assert.equal(events.some((event) => event.eventType === 'agent_run.context_consumed' && event.payload.declared === true), true)
  assert.equal(events.some((event) => event.eventType === 'agent_run.context_rejected'), true)
  assert.equal(events.some((event) => event.eventType === 'agent_run.check_completed'), true)
  assert.equal(events.some((event) => event.eventType === 'agent_run.evidence_packaged'), true)
  // The terminal state is written first, so the cleanup event is the last thing in the run's chain.
  assert.deepEqual(events.slice(-2).map((event) => event.eventType), ['agent_run.succeeded', 'agent_run.worktree_pruned'])
  assert.equal(events.at(-1)?.payload.pruned, true)
  assert.equal(events.at(-1)?.payload.error, null, 'the cleanup finished without an error')
  assert.equal(existsSync(dirname(run.worktreePath)), false, 'the run directory is removed with its checkout')
  assert.equal(database.verifyAggregateEventChain('agent_run', run.id), true)
  const attestation = events.find((event) => event.eventType === 'agent_run.runtime_attested')
  assert.equal(Array.isArray(attestation?.payload.environmentKeys), true)
  assert.equal((attestation?.payload.environmentKeys as string[]).includes('PATH'), true)
  const readiness = database.getReviewReadiness(proposal.id)
  assert.equal(readiness.status, 'ready')
  assert.equal(readiness.successfulCheckCount, 5, 'dataset integrity, leakage and untouched, the test and the evaluation')
  assert.equal(readiness.evidence.length, 1)
  const evidencePackage = evidenceStore.read(readiness.evidence[0].uri, readiness.evidence[0].sha256)
  assert.match(evidencePackage.projectManifest?.digest ?? '', /^sha256:[0-9a-f]{64}$/u)
  assert.equal(evidencePackage.git.headSha, proposal.headSha)
  assert.equal(evidencePackage.projectManifest?.evaluation?.profile, 'agent_dataset')
  assert.match(evidencePackage.projectManifest?.evaluation?.datasetDigest ?? '', /^sha256:[0-9a-f]{64}$/u)
  assert.equal(evidencePackage.checks.find((check) => check.kind === 'evaluation')?.metrics?.task_success_rate, 1)
  assert.equal(evidencePackage.checks.find((check) => check.kind === 'evaluation')?.thresholdResults?.[0].passed, true)
  assert.equal(evidencePackage.checks.every((check) => check.conclusion === 'success'), true)
  assert.equal(evidencePackage.checks.find((check) => check.name === 'evaluation-dataset-leakage')?.conclusion, 'success')

  assert.equal(readiness.builderStop, null, 'a Builder that finished is not flagged')
  assert.equal(evidencePackage.run.builderStopped, null)

  // A Builder that ran out of time hands over a partial change: readiness names it, the evidence package records it,
  // and approving it takes a written acknowledgement bound to that run. The next revision's own run clears it.
  const partialWorkItem = database.createWorkItem({ title: '时间预算内交付部分变更', description: '验证部分变更的审批门禁。', productType: 'agent_system', ownerActorId: owner.id }, owner.id)
  const partialIntent = database.createIntentVersion({ workItemId: partialWorkItem.id, goal: '在时间预算内生成变更', constraints: ['不得修改 main 工作区'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '产生真实 Git commit', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
  database.approveIntentVersion(partialIntent.id, reviewer.id)
  const partialRun = runner.run({ workItemId: partialWorkItem.id, intentVersionId: partialIntent.id, repositoryPath, baseRef: 'main', declaredContextPaths: [] }, owner.id)
  assert.equal(partialRun.status, 'succeeded', 'a stopped Builder still hands over its worktree')
  const partialProposal = database.getChangeProposal(partialRun.changeProposalId!)
  const partialReadiness = database.getReviewReadiness(partialProposal.id)
  assert.deepEqual(partialReadiness.builderStop, { runId: partialRun.id, reason: 'time_budget', summary: 'Stopped at the time budget; feature.ts only.' })
  assert.equal(partialReadiness.status, 'ready', 'a partial change is judged by its checks, not blocked outright')
  const partialPackage = evidenceStore.read(partialReadiness.evidence[0].uri, partialReadiness.evidence[0].sha256)
  assert.equal(partialPackage.run.builderStopped, 'time_budget')
  assert.equal(partialReadiness.evidence[0].summary.builderStopped, 'time_budget')
  assert.equal(database.listAggregateEvents('agent_run', partialRun.id).find((event) => event.eventType === 'agent_run.message' && event.payload.stopped)?.payload.stopped, 'time_budget')
  assert.throws(() => database.recordReview({ proposalId: partialProposal.id, headSha: partialProposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: '  ' }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'review_partial_change_unacknowledged')
  database.recordReview({ proposalId: partialProposal.id, headSha: partialProposal.headSha, reviewerActorId: reviewer.id, decision: 'changes_requested', comment: 'Finish the change.' })
  const partialRevision = runner.run({ workItemId: partialWorkItem.id, intentVersionId: partialIntent.id, repositoryPath, baseRef: 'main', declaredContextPaths: [], changeProposalId: partialProposal.id }, owner.id)
  assert.equal(partialRevision.status, 'succeeded')
  assert.equal(database.getReviewReadiness(partialProposal.id).builderStop, null, 'the stop belongs to the run that produced the old head')
  const secondPartial = runner.run({ workItemId: partialWorkItem.id, intentVersionId: partialIntent.id, repositoryPath, baseRef: 'main', declaredContextPaths: [] }, owner.id)
  const secondProposal = database.getChangeProposal(secondPartial.changeProposalId!)
  const secondEvidence = database.getReviewReadiness(secondProposal.id).evidence[0]
  database.recordEvidenceView(secondEvidence.id, reviewer.id, secondEvidence.sha256)
  database.recordReview({ proposalId: secondProposal.id, headSha: secondProposal.headSha, reviewerActorId: reviewer.id, decision: 'approved', comment: 'feature.ts alone meets the criterion; the rest is not needed.' })
  const acknowledged = database.listAggregateEvents('change_proposal', secondProposal.id).find((event) => event.eventType === 'review.approved')
  assert.equal(acknowledged?.payload.partialChangeAcknowledged, secondPartial.id)

  const runBlockedEvaluation = (goal: string) => {
    const negativeWorkItem = database.createWorkItem({ title: goal, description: '验证 Agent System 评估负路径。', productType: 'agent_system', ownerActorId: owner.id }, owner.id)
    const negativeIntent = database.createIntentVersion({ workItemId: negativeWorkItem.id, goal, constraints: ['不得暴露 holdout dataset'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '评估失败必须阻止审批', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
    database.approveIntentVersion(negativeIntent.id, reviewer.id)
    const negativeRun = runner.run({ workItemId: negativeWorkItem.id, intentVersionId: negativeIntent.id, repositoryPath, baseRef: 'main', declaredContextPaths: ['README.md'] }, owner.id)
    const negativeReadiness = database.getReviewReadiness(negativeRun.changeProposalId!)
    assert.equal(negativeReadiness.status, 'blocked')
    return { negativeRun, negativeReadiness, package: evidenceStore.read(negativeReadiness.evidence[0].uri, negativeReadiness.evidence[0].sha256) }
  }

  const missingMetrics = runBlockedEvaluation('缺失指标时阻断审批')
  assert.equal(missingMetrics.package.checks.find((check) => check.kind === 'evaluation')?.thresholdResults?.[0].actual, undefined)
  assert.equal(missingMetrics.package.checks.find((check) => check.kind === 'evaluation')?.conclusion, 'failure')

  const belowThreshold = runBlockedEvaluation('指标低于阈值时阻断审批')
  assert.equal(belowThreshold.package.checks.find((check) => check.kind === 'evaluation')?.metrics?.task_success_rate, 0.5)
  assert.equal(belowThreshold.package.checks.find((check) => check.kind === 'evaluation')?.thresholdResults?.[0].passed, false)

  const tamperedDataset = runBlockedEvaluation('篡改数据集时阻断审批')
  assert.equal(tamperedDataset.package.checks.find((check) => check.name === 'evaluation-dataset-integrity')?.conclusion, 'failure')
  assert.equal(database.listAggregateEvents('agent_run', tamperedDataset.negativeRun.id).some((event) => event.eventType === 'agent_run.evaluation_dataset_verified' && event.payload.passed === false), true)

  database.recordReview({ proposalId: proposal.id, headSha: proposal.headSha, reviewerActorId: reviewer.id, decision: 'changes_requested', comment: 'Regenerate feature.ts from a follow-up Agent Run.' })
  const revisionRun = runner.run({ workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: 'main', declaredContextPaths: [], changeProposalId: proposal.id }, owner.id)
  assert.equal(revisionRun.status, 'succeeded')
  assert.equal(revisionRun.revisionOfProposalId, proposal.id)
  assert.equal(revisionRun.startSha, proposal.headSha)
  assert.equal(revisionRun.changeProposalId, proposal.id)
  const revisedProposal = database.getChangeProposal(proposal.id)
  assert.equal(revisedProposal.runId, revisionRun.id)
  assert.equal(revisedProposal.status, 'review_ready')
  assert.notEqual(revisedProposal.headSha, proposal.headSha)
  assert.match(revisedProposal.headRef, /^agent\/revision-run-/u)
  const revisionEvents = database.listAggregateEvents('agent_run', revisionRun.id)
  assert.equal(revisionEvents.some((event) => event.eventType === 'agent_run.revision_feedback_bound'), true)
  assert.equal(revisionEvents.some((event) => event.eventType === 'agent_run.change_revised'), true)
  const revisedReadiness = database.getReviewReadiness(proposal.id)
  assert.equal(revisedReadiness.status, 'ready')
  assert.equal(revisedReadiness.invalidatedCheckCount, 5)
  assert.equal(revisedReadiness.invalidatedEvidenceCount, 1)
  const revisionEvidencePackage = evidenceStore.read(revisedReadiness.evidence[0].uri, revisedReadiness.evidence[0].sha256)
  assert.equal(revisionEvidencePackage.run.startSha, proposal.headSha)
  assert.equal(revisionEvidencePackage.run.revisionOfProposalId, proposal.id)

  // The worktree is gone for both runs and for every negative run above, while the proposal branches and the
  // evidence packages they produced are still readable — the revision run in between proved the latter on its
  // own, because it started from the reviewed Head SHA of the first run's branch.
  for (const cleaned of [run, revisionRun, missingMetrics.negativeRun, belowThreshold.negativeRun, tamperedDataset.negativeRun]) {
    assert.equal(existsSync(cleaned.worktreePath), false, `${cleaned.id} should not leave a worktree behind`)
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').some((line) => line.startsWith('worktree ')), true, 'the primary worktree remains')
    assert.equal(git('worktree', 'list').includes(cleaned.worktreePath), false, `${cleaned.id} should not be listed as a worktree`)
    assert.equal(readdirSync(join(root, 'runs')).includes(cleaned.id), false, `${cleaned.id} should not leave a run directory behind`)
    assert.equal(git('rev-parse', '--verify', `${cleaned.branchRef}^{commit}`).length, 40, `${cleaned.branchRef} must survive the cleanup`)
  }
  assert.equal(git('worktree', 'list', '--porcelain').includes('prunable'), false, 'no administrative entry outlives its worktree')
  assert.equal(git('rev-parse', '--verify', `${revisedProposal.headRef}^{commit}`), revisedProposal.headSha, 'the revised Head branch still resolves to the reviewed SHA')

  console.log(`local command agent smoke passed · ${run.id} → ${revisionRun.id} · ${proposal.headSha.slice(0, 7)} → ${revisedProposal.headSha.slice(0, 7)} · revision governed`)
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
