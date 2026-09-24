import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { LocalCommandAgentRunner } from '../server/local-command-agent-runner.ts'
import { LocalEvidenceStore } from '../server/local-evidence-store.ts'
import { LocalRunPostprocessor } from '../server/local-run-postprocessor.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-application-build-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const agentScript = join(root, 'application-agent.mjs')
const buildScript = join(root, 'build.mjs')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Build Test')
git('config', 'user.email', 'build-test@aperture.invalid')
writeFileSync(join(repositoryPath, 'README.md'), '# Application Build Fixture\n')
mkdirSync(join(repositoryPath, '.aperture'))
writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'application', context: { required: ['README.md'], allowed: ['README.md'] }, checks: [{ name: 'application-build', kind: 'build', command: [process.execPath, buildScript], timeoutMs: 10_000 }], artifact: { profile: 'application_build', buildCheck: 'application-build', outputs: ['dist/app.js'] }, policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true } }, null, 2))
git('add', 'README.md', '.aperture/project.json')
git('commit', '-m', 'initial application')
writeFileSync(agentScript, `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'\nconst request = JSON.parse(readFileSync(process.env.APERTURE_RUN_REQUEST, 'utf8'))\nmkdirSync('src', { recursive: true })\nwriteFileSync('src/feature.js', request.intent.goal.includes('缺失产物') ? 'export const mode = "missing"\\n' : 'export const mode = "ready"\\n')\n`)
writeFileSync(buildScript, `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'\nconst source = readFileSync('src/feature.js', 'utf8')\nif (source.includes('missing')) process.exit(0)\nmkdirSync('dist', { recursive: true })\nwriteFileSync('dist/app.js', '// built from governed source\\n' + source)\nconsole.log('application build completed')\n`)

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Build Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const approver = database.createActor({ username: 'approver', displayName: 'Intent Approver', role: 'reviewer', password: 'approver-password-2026' }, owner.id)
  const evidenceStore = new LocalEvidenceStore(join(root, 'evidence'))
  const runner = new LocalCommandAgentRunner({ database, executable: process.execPath, args: [agentScript], worktreeRoot: join(root, 'runs'), timeoutMs: 10_000, postprocessor: new LocalRunPostprocessor({ database, evidenceStore }) })

  const runCase = (goal: string) => {
    const workItem = database.createWorkItem({ title: goal, description: '验证 Application Build Provenance。', productType: 'application', ownerActorId: owner.id }, owner.id)
    const intent = database.createIntentVersion({ workItemId: workItem.id, goal, constraints: ['构建输出不提交到源码 Revision'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '构建输出拥有 SHA-256 Provenance', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
    database.approveIntentVersion(intent.id, approver.id)
    const run = runner.run({ workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: 'main', declaredContextPaths: ['README.md'] }, owner.id)
    const readiness = database.getReviewReadiness(run.changeProposalId!)
    const evidence = evidenceStore.read(readiness.evidence[0].uri, readiness.evidence[0].sha256)
    return { run, readiness, evidence }
  }

  const ready = runCase('生成可验证 Application 构建产物')
  assert.equal(ready.readiness.status, 'ready')
  assert.equal(ready.evidence.projectManifest?.artifact?.buildCheck, 'application-build')
  assert.equal(ready.evidence.artifacts?.length, 1)
  assert.equal(ready.evidence.artifacts?.[0].path, 'dist/app.js')
  assert.match(ready.evidence.artifacts?.[0].sha256 ?? '', /^sha256:[0-9a-f]{64}$/u)
  assert.equal(ready.evidence.artifacts?.[0].sourceCommitSha, ready.evidence.git.headSha)
  assert.equal(ready.evidence.artifacts?.[0].productionEligible, false)
  assert.match(readFileSync(join(ready.run.worktreePath, 'dist/app.js'), 'utf8'), /governed source/u)
  const readyEvents = database.listAggregateEvents('agent_run', ready.run.id)
  assert.equal(readyEvents.some((event) => event.eventType === 'agent_run.project_manifest_bound' && (event.payload.artifact as { buildCheck?: string } | null)?.buildCheck === 'application-build'), true)
  assert.equal(readyEvents.some((event) => event.eventType === 'agent_run.artifacts_attested'), true)

  const missing = runCase('缺失产物时阻断审批')
  assert.equal(missing.readiness.status, 'blocked')
  assert.equal(missing.evidence.artifacts?.length, 0)
  assert.equal(missing.evidence.checks.some((check) => check.name === 'artifact-output:dist/app.js' && check.conclusion === 'failure'), true)
  assert.equal(database.listAggregateEvents('agent_run', missing.run.id).some((event) => event.eventType === 'agent_run.artifact_attestation_failed'), true)

  console.log(`application build provenance smoke passed · ${ready.run.id} · artifact digest attested · missing output blocked`)
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
