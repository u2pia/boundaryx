// The isolated evaluator: a holdout registered with the Control Plane rather than committed, a grader taken from the
// base revision, and the code under evaluation run from the head revision under Seatbelt, unable to read the holdout.
// Drives real runs through it and checks that an honest change reaches `passed` without an override only when the
// Builder was confined too, and that a subject which peeks, boasts or reads the Control Plane's data gains nothing.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase, DEFAULT_PROJECT_ID } from '../server/database.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { LocalRunPostprocessor } from '../server/local-run-postprocessor.ts'
import { seatbeltAvailable } from '../server/seatbelt.ts'
import { useProjectRepository } from './fixtures.ts'

if (!seatbeltAvailable()) {
  console.log('isolated evaluation smoke skipped: needs macOS sandbox-exec')
  process.exit(0)
}

// The data directory holds the database, the holdouts and the evaluation directories; the Builder script lives
// outside it, because a confined Builder cannot read anything beneath it except its own run.
const root = mkdtempSync(join(tmpdir(), 'aperture-isolated-evaluation-'))
const scripts = mkdtempSync(join(tmpdir(), 'aperture-isolated-evaluation-agent-'))
const repositoryPath = join(root, 'repository')
const agentScript = join(scripts, 'agent.mjs')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations'))
const git = (...args: string[]) => execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()

const holdoutRows = [{ input: 'quarterly revenue report', expected: 'QUARTERLY REVENUE REPORT' }, { input: 'customer churn summary', expected: 'CUSTOMER CHURN SUMMARY' }]
const holdout = holdoutRows.map((row) => JSON.stringify(row)).join('\n') + '\n'
// Inputs phase: the questions only. Score phase: the subject's answers against the expected ones.
const grader = "import { readFileSync } from 'node:fs'\nconst rows = readFileSync(process.env.APERTURE_EVALUATION_DATASET, 'utf8').trim().split('\\n').map((line) => JSON.parse(line))\nif (process.env.APERTURE_EVALUATION_PHASE === 'inputs') { for (const row of rows) console.log(JSON.stringify({ input: row.input })) }\nelse {\n  const outputs = readFileSync(process.env.APERTURE_EVALUATION_OUTPUTS, 'utf8').split('\\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })\n  const rate = rows.filter((row, index) => outputs[index]?.output === row.expected).length / rows.length\n  console.log(JSON.stringify({ type: 'evaluation_metrics', metrics: { task_success_rate: rate } }))\n}\n"
// The subject's entry point: one answer line per input line.
const subjectMain = "import { readFileSync } from 'node:fs'\nimport { answer } from './agent.mjs'\nfor (const line of readFileSync(0, 'utf8').split('\\n').filter(Boolean)) console.log(JSON.stringify({ output: answer(JSON.parse(line).input) }))\n"
const wrongAgent = "export function answer() { return 'no idea' }\n"
const rightAgent = "export function answer(input) { return input.toUpperCase() }\n"
// Looks for the holdout wherever it could be: beside its own directory, in the Control Plane's holdout store, and
// through the repository. Answers from it when found.
const peekingAgent = (holdoutDirectory: string) => `import { readdirSync, readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nlet rows = []\nfor (const path of ['../holdout.jsonl', ...(() => { try { return readdirSync(${JSON.stringify(join(holdoutDirectory, DEFAULT_PROJECT_ID))}).map((name) => join(${JSON.stringify(join(holdoutDirectory, DEFAULT_PROJECT_ID))}, name)) } catch { return [] } })()]) {\n  try { rows = readFileSync(path, 'utf8').trim().split('\\n').map((line) => JSON.parse(line)); break } catch {}\n}\nexport function answer(input) { return rows.find((row) => row.input === input)?.expected ?? 'no idea' }\n`
// Prints a perfect score of its own, on stdout and stderr: neither is parsed for metrics.
const boastingAgent = "console.log(JSON.stringify({ type: 'evaluation_metrics', metrics: { task_success_rate: 1 } }))\nconsole.error(JSON.stringify({ type: 'evaluation_metrics', metrics: { task_success_rate: 1 } }))\nexport function answer() { return 'no idea' }\n"
// Tries the network: the subject has none.
const phoningAgent = "import { execFileSync } from 'node:child_process'\nlet reached = 'no'\ntry { execFileSync('/usr/bin/curl', ['-sS', '-m', '3', 'https://example.com'], { stdio: 'pipe' }); reached = 'yes' } catch {}\nexport function answer(input) { return reached === 'yes' ? input.toUpperCase() : 'no idea' }\n"

const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
const builder = database.createActor({ username: 'builder', displayName: 'Builder', role: 'developer', password: 'builder-password-2026' }, owner.id)
const approver = database.createActor({ username: 'approver', displayName: 'Approver', role: 'reviewer', password: 'approver-password-2026' }, owner.id)
const evidenceStore = new LocalEvidenceStore(join(root, 'evidence'))
const postprocessor = new LocalRunPostprocessor({ database, evidenceStore })
const runnerFor = (confined: boolean) => new LocalCommandAgentRunner({ database, executable: process.execPath, args: [agentScript], worktreeRoot: join(root, 'runs'), timeoutMs: 60_000, postprocessor, ...(confined ? { confinement: { kind: 'seatbelt' as const, denied: [root] } } : {}) })
const confinedRunner = runnerFor(true)
const unconfinedRunner = runnerFor(false)

function setUp(holdoutDigest: string) {
  rmSync(repositoryPath, { recursive: true, force: true })
  mkdirSync(repositoryPath)
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repositoryPath])
  git('config', 'user.name', 'Aperture Test')
  git('config', 'user.email', 'test@aperture.invalid')
  for (const directory of ['.aperture', 'evals', 'src']) mkdirSync(join(repositoryPath, directory))
  writeFileSync(join(repositoryPath, 'README.md'), '# Agent\n')
  writeFileSync(join(repositoryPath, 'evals/grade.mjs'), grader)
  writeFileSync(join(repositoryPath, 'src/main.mjs'), subjectMain)
  writeFileSync(join(repositoryPath, 'src/agent.mjs'), wrongAgent)
  // The test check runs head code on the host: it reports whether it could list the holdout store.
  const probe = `try { require('node:fs').readdirSync(${JSON.stringify(database.holdoutDirectory)}); console.log('holdouts readable') } catch (error) { console.log('holdouts ' + error.code) }`
  writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'agent_system', context: { required: ['README.md'], allowed: ['README.md', 'src/agent.mjs'] }, checks: [{ name: 'unit', kind: 'test', command: [process.execPath, '-e', probe], timeoutMs: 20_000 }], evaluation: { profile: 'agent_dataset', holdout: { digest: holdoutDigest }, harnessPaths: ['evals'], grader: { command: [process.execPath, 'evals/grade.mjs'], timeoutMs: 20_000 }, subject: { command: [process.execPath, 'src/main.mjs'], timeoutMs: 20_000 }, thresholds: [{ metric: 'task_success_rate', operator: 'gte', threshold: 0.9 }] }, policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true } }))
  git('add', '-A')
  git('commit', '--quiet', '-m', 'agent skeleton')
  useProjectRepository(database, repositoryPath, owner.id)
}

function start(label: string, files: Record<string, string>, runner: LocalCommandAgentRunner, probePath?: string) {
  // The Builder writes its files and, when asked, records whether it could read `probePath`.
  const probe = probePath ? `let seen = 'readable'\ntry { readdirSync(${JSON.stringify(probePath)}) } catch (error) { seen = error.code }\nwriteFileSync('builder-probe.txt', seen + '\\n')\n` : ''
  writeFileSync(agentScript, `import { readdirSync, writeFileSync } from 'node:fs'\nfor (const [path, content] of Object.entries(${JSON.stringify(files)})) writeFileSync(path, content)\n${probe}console.log(JSON.stringify({ type: 'message', summary: ${JSON.stringify(label)} }))\n`)
  const workItem = database.createWorkItem({ title: label, description: label, productType: 'agent_system', ownerActorId: builder.id }, builder.id)
  const intent = database.createIntentVersion({ workItemId: workItem.id, goal: 'Answer the hidden dataset correctly', constraints: ['offline'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '隐藏数据集上的成功率不低于 0.9', criticality: 'critical', verificationType: 'model' }] }, builder.id)
  database.approveIntentVersion(intent.id, approver.id, '目标清楚，可以开工。')
  return () => runner.run({ workItemId: workItem.id, intentVersionId: intent.id, baseRef: 'main', declaredContextPaths: ['README.md'] }, builder.id)
}

function runWith(label: string, files: Record<string, string>, runner = confinedRunner, probePath?: string) {
  const run = start(label, files, runner, probePath)()
  assert.ok(run.changeProposalId, `${label}: ${run.errorMessage ?? run.status}`)
  const readiness = database.getReviewReadiness(run.changeProposalId)
  const evidence = evidenceStore.read(readiness.evidence[0].uri, readiness.evidence[0].sha256)
  const provenance = (evidence as unknown as { evaluationProvenance: { mode: string; independent: boolean; builderHoldoutReadable: boolean; subjectConfinement: { kind: string } | null } }).evaluationProvenance
  return { run, criterion: readiness.criteria[0], readiness, evidence, provenance, check: (name: string) => evidence.checks.find((check) => check.name === name) }
}

try {
  // Registering a holdout is an owner or maintainer decision; the file is kept 0600 under a 0700 store.
  assert.throws(() => database.registerEvaluationHoldout(DEFAULT_PROJECT_ID, holdout, builder.id), /evaluation_holdout_forbidden|owner/u)
  const registered = database.registerEvaluationHoldout(DEFAULT_PROJECT_ID, holdout, owner.id)
  assert.equal(database.registerEvaluationHoldout(DEFAULT_PROJECT_ID, holdout, owner.id).digest, registered.digest, 'registering twice is idempotent')
  assert.equal(database.listEvaluationHoldouts(DEFAULT_PROJECT_ID).length, 1)
  assert.equal(statSync(database.holdoutDirectory).mode & 0o777, 0o700)
  const storedHoldout = join(database.holdoutDirectory, DEFAULT_PROJECT_ID, readdirSync(join(database.holdoutDirectory, DEFAULT_PROJECT_ID))[0])
  assert.equal(statSync(storedHoldout).mode & 0o777, 0o600)
  assert.equal(database.readEvaluationHoldout(DEFAULT_PROJECT_ID, registered.digest), holdout)

  // A manifest naming a holdout this Control Plane does not hold is refused before any worktree exists.
  setUp(`sha256:${'0'.repeat(64)}`)
  assert.throws(start('unregistered holdout', { 'src/agent.mjs': rightAgent }, confinedRunner), /evaluation_holdout_missing|not registered/u)

  setUp(registered.digest)
  // The honest case with a confined Builder: independent, so the critical model criterion passes with no override.
  const honest = runWith('honest fix', { 'src/agent.mjs': rightAgent }, confinedRunner, database.holdoutDirectory)
  const attested = database.listAggregateEvents('agent_run', honest.run.id).find((event) => event.eventType === 'agent_run.runtime_attested')?.payload as { holdoutReadable?: boolean; confinement?: { kind: string } }
  assert.deepEqual([attested.holdoutReadable, attested.confinement?.kind], [false, 'seatbelt'])
  assert.equal(execFileSync('git', ['-C', repositoryPath, 'show', `${database.getChangeProposal(honest.run.changeProposalId!).headSha}:builder-probe.txt`], { encoding: 'utf8' }).trim(), 'EPERM', 'a confined Builder cannot read the holdout store')
  assert.equal(honest.check('evaluation-holdout-integrity')?.conclusion, 'success')
  assert.equal(honest.check('evaluation-dataset-leakage')?.conclusion, 'success')
  assert.equal(honest.check('evaluation-isolated')?.conclusion, 'success', honest.check('evaluation-isolated')?.stderrExcerpt)
  assert.equal(honest.check('evaluation-isolated')?.metrics?.task_success_rate, 1)
  assert.equal(honest.check('evaluation-isolated')?.provenance, 'isolated')
  assert.equal(honest.check('evaluation-dataset-integrity'), undefined, 'no dataset in the worktree to check')
  assert.equal(honest.check('unit')?.stdoutExcerpt.trim(), 'holdouts EPERM', 'checks run on the host cannot read the holdout store either')
  assert.deepEqual(honest.criterion.checkNames, ['evaluation-isolated', 'evaluation-holdout-integrity', 'evaluation-dataset-leakage'])
  assert.equal(honest.criterion.independent, true)
  assert.equal(honest.criterion.status, 'passed')
  assert.equal(honest.readiness.status, 'ready', honest.readiness.blockers.join(' | '))
  assert.deepEqual([honest.provenance.mode, honest.provenance.independent, honest.provenance.builderHoldoutReadable, honest.provenance.subjectConfinement?.kind], ['holdout', true, false, 'seatbelt'])
  assert.ok(!JSON.stringify(honest.evidence).includes('QUARTERLY'), 'the evidence package carries no holdout answers')
  assert.deepEqual(readdirSync(join(root, 'evaluations')), [], 'the evaluation directory is removed afterwards')

  // The wrong agent scores 0 and fails, independently.
  const wrong = runWith('wrong agent', { 'README.md': '# Agent\n\nStill guessing.\n' })
  assert.equal(wrong.check('evaluation-isolated')?.metrics?.task_success_rate, 0)
  assert.equal(wrong.criterion.status, 'failed')

  // The subject looks for the holdout beside its directory and in the holdout store: both are denied.
  const peeking = runWith('peeking agent', { 'src/agent.mjs': peekingAgent(database.holdoutDirectory) })
  assert.equal(peeking.check('evaluation-isolated')?.metrics?.task_success_rate, 0, 'the sandboxed subject never saw the answers')
  assert.equal(peeking.criterion.status, 'failed')

  // A subject printing its own perfect score only fills its answers with junk.
  const boasting = runWith('boasting agent', { 'src/agent.mjs': boastingAgent })
  assert.equal(boasting.check('evaluation-isolated')?.metrics?.task_success_rate, 0)
  assert.equal(boasting.check('evaluation-isolated')?.metricConflicts, undefined)
  assert.equal(boasting.criterion.status, 'failed')

  const phoning = runWith('phoning agent', { 'src/agent.mjs': phoningAgent })
  assert.equal(phoning.check('evaluation-isolated')?.metrics?.task_success_rate, 0, 'the subject has no network')

  // Rewriting the grader changes nothing: it is taken from the base revision.
  const rewritten = runWith('rewritten grader', { 'evals/grade.mjs': "console.log(JSON.stringify({ type: 'evaluation_metrics', metrics: { task_success_rate: 1 } }))\n" })
  assert.equal(rewritten.check('evaluation-isolated')?.metrics?.task_success_rate, 0)
  assert.equal(rewritten.criterion.status, 'failed')

  // Copying the holdout's answers into the change is still caught, although the holdout is not in the repository.
  const memorised = runWith('memorised answers', { 'src/agent.mjs': `const answers = ${JSON.stringify(Object.fromEntries(holdoutRows.map((row) => [row.input, row.expected])))}\nexport function answer(input) { return answers[input] }\n` })
  assert.equal(memorised.check('evaluation-isolated')?.metrics?.task_success_rate, 1)
  assert.equal(memorised.check('evaluation-dataset-leakage')?.conclusion, 'failure')
  assert.equal(memorised.criterion.status, 'failed')

  // An unconfined Builder could have read the holdout store: the same honest change is only self-graded.
  const unconfined = runWith('honest fix, unconfined Builder', { 'src/agent.mjs': rightAgent }, unconfinedRunner, database.holdoutDirectory)
  assert.equal(execFileSync('git', ['-C', repositoryPath, 'show', `${database.getChangeProposal(unconfined.run.changeProposalId!).headSha}:builder-probe.txt`], { encoding: 'utf8' }).trim(), 'readable')
  assert.equal(unconfined.check('evaluation-isolated')?.conclusion, 'success')
  assert.equal(unconfined.check('evaluation-isolated')?.provenance, 'isolated_partial')
  assert.equal(unconfined.criterion.status, 'self_graded')
  assert.equal(unconfined.readiness.status, 'blocked')
  assert.ok(unconfined.readiness.blockers.some((blocker) => blocker.includes('Declare evaluation.holdout')), unconfined.readiness.blockers.join(' | '))
  assert.deepEqual([unconfined.provenance.independent, unconfined.provenance.builderHoldoutReadable], [false, true])

  // A holdout file altered on disk no longer reads, and a new run is refused.
  writeFileSync(storedHoldout, holdout.replace('QUARTERLY', 'QUARTERLX'))
  assert.equal(database.readEvaluationHoldout(DEFAULT_PROJECT_ID, registered.digest), undefined)
  assert.throws(start('altered holdout', { 'src/agent.mjs': rightAgent }, confinedRunner), /evaluation_holdout_missing|not registered/u)

  console.log('isolated evaluation smoke passed · honest fix passes with no override · confined Builder and host checks cannot read holdouts · peeking, boasting and networked subjects score 0 · grader from base · copied answers caught · unconfined Builder self-graded · altered or unregistered holdout refused')
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(scripts, { recursive: true, force: true })
}
