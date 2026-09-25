// An agent system's model criteria are proven by an evaluation: a grader in the repository scores a hidden dataset.
// A verified dataset says nothing about honest scoring when the run can edit the grader or print its own metrics, so
// this drives real runs through each way a Builder could grade itself and checks that none of them reaches `passed`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { LocalRunPostprocessor } from '../server/local-run-postprocessor.ts'
import { useProjectRepository } from './fixtures.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-evaluation-provenance-'))
const repositoryPath = join(root, 'repository')
const agentScript = join(root, 'agent.mjs')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations'))
const git = (...args: string[]) => execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()

// The honest grader: the share of dataset answers the agent's answer() gets right.
const grader = "import { readFileSync } from 'node:fs'\nimport { answer } from '../src/agent.mjs'\nconst rows = readFileSync(process.env.APERTURE_EVALUATION_DATASET, 'utf8').trim().split('\\n').map((line) => JSON.parse(line))\nconst rate = rows.filter((row) => answer(row.input) === row.expected).length / rows.length\nconsole.log(JSON.stringify({ type: 'evaluation_metrics', metrics: { task_success_rate: rate } }))\n"
const lyingGrader = "console.log(JSON.stringify({ type: 'evaluation_metrics', metrics: { task_success_rate: 1 } }))\n"
const wrongAgent = "export function answer() { return 'no idea' }\n"
const rightAgent = "export function answer(input) { return input.toUpperCase() }\n"
// The code under evaluation shares the grader's process, so it can print a score of its own after the grader's.
const boastingAgent = "process.on('exit', () => console.log(JSON.stringify({ type: 'evaluation_metrics', metrics: { task_success_rate: 1 } })))\nexport function answer() { return 'no idea' }\n"

function setUp(harnessPaths?: string[]) {
  rmSync(repositoryPath, { recursive: true, force: true })
  mkdirSync(repositoryPath)
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
  git('config', 'user.name', 'Aperture Test')
  git('config', 'user.email', 'test@aperture.invalid')
  for (const directory of ['.aperture', 'evals', 'src']) mkdirSync(join(repositoryPath, directory))
  writeFileSync(join(repositoryPath, 'README.md'), '# Agent\n')
  writeFileSync(join(repositoryPath, 'evals/dataset.jsonl'), '{"input":"ab","expected":"AB"}\n{"input":"cd","expected":"CD"}\n')
  writeFileSync(join(repositoryPath, 'evals/grade.mjs'), grader)
  writeFileSync(join(repositoryPath, 'src/agent.mjs'), wrongAgent)
  writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'agent_system', context: { required: ['README.md'], allowed: ['README.md', 'src/agent.mjs'] }, checks: [{ name: 'eval', kind: 'evaluation', command: [process.execPath, 'evals/grade.mjs'], timeoutMs: 20_000 }], evaluation: { profile: 'agent_dataset', datasetPath: 'evals/dataset.jsonl', ...(harnessPaths ? { harnessPaths } : {}), thresholds: [{ metric: 'task_success_rate', operator: 'gte', threshold: 0.9 }] }, policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true } }))
  git('add', '-A')
  git('commit', '--quiet', '-m', 'agent skeleton')
  useProjectRepository(database, repositoryPath, owner.id)
}

const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
const builder = database.createActor({ username: 'builder', displayName: 'Builder', role: 'developer', password: 'builder-password-2026' }, owner.id)
const approver = database.createActor({ username: 'approver', displayName: 'Approver', role: 'reviewer', password: 'approver-password-2026' }, owner.id)
const evidenceStore = new LocalEvidenceStore(join(root, 'evidence'))
const runner = new LocalCommandAgentRunner({ database, executable: process.execPath, args: [agentScript], worktreeRoot: join(root, 'runs'), timeoutMs: 60_000, postprocessor: new LocalRunPostprocessor({ database, evidenceStore }) })

/** One run whose Builder writes `files`, and the resulting criterion, readiness and evidence package. */
function runWith(label: string, files: Record<string, string>) {
  writeFileSync(agentScript, `import { writeFileSync } from 'node:fs'\nfor (const [path, content] of Object.entries(${JSON.stringify(files)})) writeFileSync(path, content)\nconsole.log(JSON.stringify({ type: 'message', summary: ${JSON.stringify(label)} }))\n`)
  const workItem = database.createWorkItem({ title: label, description: label, productType: 'agent_system', ownerActorId: builder.id }, builder.id)
  const intent = database.createIntentVersion({ workItemId: workItem.id, goal: 'Answer the hidden dataset correctly', constraints: ['offline'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '隐藏数据集上的成功率不低于 0.9', criticality: 'critical', verificationType: 'model' }] }, builder.id)
  database.approveIntentVersion(intent.id, approver.id, '目标清楚，可以开工。')
  const run = runner.run({ workItemId: workItem.id, intentVersionId: intent.id, baseRef: 'main', declaredContextPaths: ['README.md'] }, builder.id)
  assert.ok(run.changeProposalId, `${label}: ${run.errorMessage ?? run.status}`)
  const readiness = database.getReviewReadiness(run.changeProposalId)
  const evidence = evidenceStore.read(readiness.evidence[0].uri, readiness.evidence[0].sha256)
  return { criterion: readiness.criteria[0], readiness, evidence, check: (name: string) => evidence.checks.find((check) => check.name === name) }
}

try {
  // No harnessPaths: the run could have written the grader, so even an honest pass is only self-graded.
  setUp()
  const undeclared = runWith('undeclared grader', { 'src/agent.mjs': rightAgent })
  assert.equal(undeclared.check('eval')?.conclusion, 'success')
  assert.equal(undeclared.criterion.status, 'self_graded', 'without harnessPaths no evaluation is independent')
  assert.equal(undeclared.readiness.status, 'blocked')
  assert.equal((undeclared.evidence as unknown as { evaluationProvenance: { independent: boolean } }).evaluationProvenance.independent, false)

  setUp(['evals'])
  // The honest case: the run changed only the code under evaluation, and the base grader scored it.
  const honest = runWith('honest fix', { 'src/agent.mjs': rightAgent })
  assert.equal(honest.check('eval')?.provenance, 'pre_existing')
  assert.equal(honest.check('eval@baseline'), undefined, 'an untouched grader needs no baseline re-run')
  assert.equal(honest.criterion.status, 'passed')
  assert.equal(honest.criterion.independent, true)
  assert.equal(honest.readiness.status, 'ready')

  // The run rewrites the grader to report a perfect score: the head result passes, the base grader does not.
  const rewritten = runWith('rewritten grader', { 'evals/grade.mjs': lyingGrader })
  assert.equal(rewritten.check('eval')?.conclusion, 'success')
  assert.equal(rewritten.check('eval')?.provenance, 'all_tests')
  assert.equal(rewritten.check('eval@baseline')?.conclusion, 'failure', 'the base grader scores the unchanged wrong agent')
  assert.equal(rewritten.check('eval@baseline')?.metrics?.task_success_rate, 0)
  assert.equal(rewritten.criterion.status, 'failed')
  assert.equal(rewritten.readiness.status, 'blocked')

  // The code under evaluation prints a score of its own: two values for one metric fail the check.
  const boasting = runWith('boasting agent', { 'src/agent.mjs': boastingAgent })
  assert.deepEqual(boasting.check('eval')?.metricConflicts, ['task_success_rate'])
  assert.equal(boasting.check('eval')?.conclusion, 'failure')
  assert.equal(boasting.criterion.status, 'failed')
  console.log('evaluation provenance smoke passed · undeclared grader self-graded · base grader passes an honest fix · rewritten grader caught by eval@baseline · conflicting metrics fail')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
