// Guards the anti-self-grading invariant from DOMAIN_MODEL.md: a change may not be accepted on
// the strength of tests the change itself authored. The Control Plane re-runs every declared test
// check with the manifest's testPaths reset to the proposal base revision, and the independent
// conclusion is what decides review readiness.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { LocalRunPostprocessor } from '../server/local-run-postprocessor.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-test-provenance-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const agentScript = join(root, 'fixture-agent.mjs')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

const projectTests = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add } from '../src/adder.ts'

test('adds positive numbers', () => { assert.equal(add(2, 3), 5) })
test('adds negative numbers', () => { assert.equal(add(-1, -2), -3) })
`

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Provenance Test')
git('config', 'user.email', 'provenance-test@aperture.invalid')
mkdirSync(join(repositoryPath, '.aperture'))
mkdirSync(join(repositoryPath, 'src'))
mkdirSync(join(repositoryPath, 'test'))
writeFileSync(join(repositoryPath, 'README.md'), '# Adder\n')
writeFileSync(join(repositoryPath, 'src/adder.ts'), 'export function add(_a: number, _b: number): number {\n  throw new Error(\'not implemented\')\n}\n')
writeFileSync(join(repositoryPath, 'test/adder.test.ts'), projectTests)
writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({
  schemaVersion: 'aperture.project.v1',
  productType: 'application',
  context: { required: ['README.md', 'src/adder.ts', 'test/adder.test.ts'], allowed: ['README.md', 'src/adder.ts', 'test/adder.test.ts'] },
  checks: [{ name: 'node-tests', kind: 'test', command: [process.execPath, '--experimental-strip-types', '--test', 'test/**/*.test.ts'], timeoutMs: 60_000 }],
  testPaths: ['test'],
  policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true },
}, null, 2))
git('add', '-A')
git('commit', '-m', 'initial')

// Three agent behaviours selected by the intent goal: an honest implementation that also adds its own
// tests, an implementation that passes only because it rewrote the tests, and one that leaves the
// project's tests untouched.
writeFileSync(agentScript, `import { readFileSync, writeFileSync } from 'node:fs'
const request = JSON.parse(readFileSync(process.env.APERTURE_RUN_REQUEST, 'utf8'))
const goal = request.intent.goal
console.log(JSON.stringify({ type: 'message', summary: 'Implemented add().' }))
const working = 'export function add(a: number, b: number): number {\\n  return a + b\\n}\\n'
const broken = 'export function add(_a: number, _b: number): number {\\n  return 0\\n}\\n'
if (goal.includes('自己改测试')) {
  // The agent never implements add() correctly; it replaces the project's tests with its own.
  writeFileSync('src/adder.ts', broken)
  writeFileSync('test/adder.test.ts', "import assert from 'node:assert/strict'\\nimport { test } from 'node:test'\\nimport { add } from '../src/adder.ts'\\n\\ntest('add returns a number', () => { assert.equal(typeof add(1, 1), 'number') })\\n")
} else if (goal.includes('不碰测试')) {
  writeFileSync('src/adder.ts', working)
} else {
  writeFileSync('src/adder.ts', working)
  writeFileSync('test/adder.test.ts', readFileSync('test/adder.test.ts', 'utf8') + "\\ntest('adds zero', () => { assert.equal(add(0, 0), 0) })\\n")
}
`)

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const approver = database.createActor({ username: 'approver', displayName: 'Intent Approver', role: 'reviewer', password: 'approver-password-2026' }, owner.id)
  const evidenceStore = new LocalEvidenceStore(join(root, 'evidence'))
  const postprocessor = new LocalRunPostprocessor({ database, evidenceStore })
  const runner = new LocalCommandAgentRunner({ database, executable: process.execPath, args: [agentScript], worktreeRoot: join(root, 'runs'), timeoutMs: 60_000, postprocessor })

  const runGoal = (goal: string) => {
    const workItem = database.createWorkItem({ title: goal, description: '验证测试来源判定。', productType: 'application', ownerActorId: owner.id }, owner.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal, constraints: ['不得修改 main 工作区'], riskLevel: 'medium', acceptanceCriteria: [{ statement: 'add() 必须通过项目自有测试', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
    database.approveIntentVersion(intent.id, approver.id)
    const run = runner.run({ workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: 'main', declaredContextPaths: ['README.md', 'src/adder.ts', 'test/adder.test.ts'] }, owner.id)
    const readiness = database.getReviewReadiness(run.changeProposalId!)
    return { run, readiness, package: evidenceStore.read(readiness.evidence[0].uri, readiness.evidence[0].sha256) }
  }

  // 1. Honest implementation that also contributes tests: both conclusions are green, and the package
  //    still separates the agent's tests from the project's.
  const honest = runGoal('实现 add 并补充测试')
  const honestHead = honest.package.checks.find((check) => check.name === 'node-tests')
  const honestBaseline = honest.package.checks.find((check) => check.name === 'node-tests@baseline')
  assert.equal(honest.run.status, 'succeeded')
  assert.equal(honestHead?.conclusion, 'success')
  assert.equal(honestHead?.provenance, 'all_tests')
  assert.equal(honestBaseline?.conclusion, 'success')
  assert.equal(honestBaseline?.provenance, 'pre_existing')
  assert.equal(honestBaseline?.testTreeSha, honest.package.git.baseSha)
  assert.deepEqual(honest.package.testProvenance.agentModifiedTestFiles, ['test/adder.test.ts'])
  assert.equal(honest.package.testProvenance.independent, true)
  assert.equal(honest.readiness.status, 'ready')
  // The baseline check is a run-produced result like any other, so it cannot be overwritten via the API.
  assert.equal(honest.readiness.checks.find((check) => check.name === 'node-tests@baseline')?.source, 'run')
  assert.equal(honest.readiness.checks.find((check) => check.name === 'node-tests@baseline')?.runId, honest.run.id)
  // Restoring the head test files must leave no trace: a dirty worktree would have been recorded.
  assert.equal(honest.readiness.checks.some((check) => check.name === 'workspace-clean'), false)
  assert.equal(readFileSync(join(honest.run.worktreePath, 'test/adder.test.ts'), 'utf8').includes('adds zero'), true)

  // 2. The failure this invariant exists for: the agent rewrote the tests so its own head run is green,
  //    but the project's own tests still fail. Review must be blocked.
  const selfGraded = runGoal('自己改测试让它变绿')
  const selfGradedHead = selfGraded.package.checks.find((check) => check.name === 'node-tests')
  const selfGradedBaseline = selfGraded.package.checks.find((check) => check.name === 'node-tests@baseline')
  assert.equal(selfGradedHead?.conclusion, 'success')
  assert.equal(selfGradedHead?.provenance, 'all_tests')
  assert.equal(selfGradedBaseline?.conclusion, 'failure')
  assert.equal(selfGraded.readiness.status, 'blocked')
  assert.equal(selfGraded.readiness.blockers.some((blocker) => blocker.includes('failed')), true)
  assert.equal(database.listAggregateEvents('agent_run', selfGraded.run.id).some((event) => event.eventType === 'agent_run.check_completed' && event.payload.name === 'node-tests@baseline' && event.payload.provenance === 'pre_existing'), true)

  // 3. No test file touched: the head result is already independent, so no second run is spent.
  const untouched = runGoal('不碰测试只实现 add')
  assert.equal(untouched.package.checks.find((check) => check.name === 'node-tests')?.provenance, 'pre_existing')
  assert.equal(untouched.package.checks.some((check) => check.name === 'node-tests@baseline'), false)
  assert.deepEqual(untouched.package.testProvenance.agentModifiedTestFiles, [])
  assert.equal(untouched.readiness.status, 'ready')

  console.log(`test provenance smoke passed · self-graded run ${selfGraded.run.id} blocked by node-tests@baseline · ${untouched.run.id} needed no baseline re-run`)
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
