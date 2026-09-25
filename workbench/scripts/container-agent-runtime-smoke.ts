import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConfiguredAgentRunner } from '../server/agent-runner-factory.ts'
import { ContainerAgentRunner } from '../server/container-agent-runner.ts'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-container-agent-'))
const repositoryPath = join(root, 'repository')
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../server/migrations')
const database = new ControlPlaneDatabase(join(root, 'control-plane.db'), migrationDirectory)
const enginePath = join(root, 'fake-container-engine')
const callsPath = join(root, 'engine-calls.jsonl')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

mkdirSync(repositoryPath)
execFileSync('git', ['init', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Container Test')
git('config', 'user.email', 'container-test@aperture.invalid')
writeFileSync(join(repositoryPath, 'README.md'), '# Container Fixture\n')
mkdirSync(join(repositoryPath, '.aperture'))
writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({ schemaVersion: 'aperture.project.v1', productType: 'application', context: { required: ['README.md'], allowed: ['README.md'] }, checks: [{ name: 'container-fixture', command: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 10_000 }], policy: { maximumRisk: 'high', allowUnisolatedRuntime: false } }, null, 2))
git('add', 'README.md', '.aperture/project.json')
git('commit', '-m', 'initial')
writeFileSync(enginePath, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
if (args[0] === 'version') { console.log('26.1.0'); process.exit(0) }
if (args[0] === 'image' && args[1] === 'inspect') { console.log('sha256:fixture-image-digest'); process.exit(0) }
if (args[0] === 'run') {
  const mounts = args.flatMap((value, index) => value === '--mount' ? [args[index + 1]] : []).filter(Boolean)
  const workspace = mounts.find((value) => value.includes('dst=/workspace')).split(',').find((value) => value.startsWith('src=')).slice(4)
  const requestPath = mounts.find((value) => value.includes('dst=/run/request.json')).split(',').find((value) => value.startsWith('src=')).slice(4)
  const request = JSON.parse(readFileSync(requestPath, 'utf8'))
  writeFileSync(workspace + '/container-feature.ts', 'export const containerRun = ' + JSON.stringify(request.runId) + '\\n')
  console.log(JSON.stringify({ type: 'context_consumed', path: 'README.md' }))
  console.log(JSON.stringify({ type: 'message', summary: 'Container execution completed.' }))
  process.exit(0)
}
process.exit(4)
`)
chmodSync(enginePath, 0o755)

try {
  const owner = database.createActor({ username: 'owner', displayName: 'Owner', role: 'owner', password: 'owner-password-2026' })
  useProjectRepository(database, repositoryPath, owner.id)
  const approver = database.createActor({ username: 'approver', displayName: 'Intent Approver', role: 'reviewer', password: 'approver-password-2026' }, owner.id)
  const workItem = database.createWorkItem({ title: '验证容器运行边界', description: '使用受限容器生成真实变更。', productType: 'application', ownerActorId: owner.id }, owner.id)
  const intent = database.createIntentVersion({ workItemId: workItem.id, goal: '在无网络、只读根文件系统和资源限制下修改代码', constraints: ['network denied', 'no secrets'], riskLevel: 'medium', acceptanceCriteria: [{ statement: '容器运行证明绑定镜像摘要', criticality: 'critical', verificationType: 'deterministic' }] }, owner.id)
  database.approveIntentVersion(intent.id, approver.id)
  const runner = new ContainerAgentRunner({ database, worktreeRoot: join(root, 'runs'), runtime: { engineExecutable: enginePath, imageRef: 'aperture-agent:fixture', command: ['node', '/agent.mjs'], cpuLimit: '1.5', memoryLimit: '2g', pidsLimit: 128, user: '65532:65532', tmpfsSize: '128m' } })
  const run = runner.run({ workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: 'main', declaredContextPaths: ['README.md'] }, owner.id)

  assert.equal(run.status, 'succeeded')
  assert.equal(run.isolation, 'container')
  assert.equal(run.networkEgress, 'denied')
  assert.equal(run.productionEligible, true)
  assert.equal(run.runtimeImageRef, 'aperture-agent:fixture')
  assert.match(run.runtimeAttestationDigest ?? '', /^sha256:[0-9a-f]{64}$/u)
  // The checkout is removed when the run ends; what the agent wrote is read from the committed branch.
  assert.match(git('show', `${run.branchRef}:container-feature.ts`), /containerRun/u)
  const events = database.listAggregateEvents('agent_run', run.id)
  assert.equal(events.some((event) => event.eventType === 'agent_run.project_manifest_bound'), true)
  const attestation = events.find((event) => event.eventType === 'agent_run.runtime_attested')
  assert.equal(attestation?.payload.imageDigest, 'sha256:fixture-image-digest')
  assert.equal(attestation?.payload.readonlyRoot, true)
  assert.equal(attestation?.payload.capDropAll, true)
  assert.equal(attestation?.payload.noNewPrivileges, true)
  assert.equal(attestation?.payload.secretMounts instanceof Array && attestation.payload.secretMounts.length, 0)

  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
  const runArgs = calls.find((args) => args[0] === 'run')!
  for (const expected of ['--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '2g', '--cpus', '1.5', '--user', '65532:65532']) assert.equal(runArgs.includes(expected), true, `missing ${expected}`)
  assert.equal(runArgs.some((value) => value.includes('dst=/workspace')), true)
  assert.equal(runArgs.some((value) => value.includes('dst=/run/request.json') && value.includes('readonly')), true)
  assert.equal(runArgs.includes('aperture-agent:fixture'), true)

  const unavailable = createConfiguredAgentRunner({ database, dataDirectory: join(root, 'unavailable'), env: { CONTROL_PLANE_CONTAINER_ENGINE: join(root, 'missing-engine'), CONTROL_PLANE_AGENT_IMAGE: 'missing:image', CONTROL_PLANE_CONTAINER_COMMAND_JSON: '["agent"]' } })
  assert.equal(unavailable.runner, undefined)
  assert.equal(unavailable.descriptor.status, 'unavailable')
  assert.match(unavailable.descriptor.reason ?? '', /Container configured but unavailable/u)

  const fallback = createConfiguredAgentRunner({ database, dataDirectory: join(root, 'fallback'), env: { CONTROL_PLANE_CONTAINER_ENGINE: join(root, 'missing-engine'), CONTROL_PLANE_AGENT_IMAGE: 'missing:image', CONTROL_PLANE_CONTAINER_COMMAND_JSON: '["agent"]', CONTROL_PLANE_ALLOW_PROCESS_FALLBACK: 'true', CONTROL_PLANE_AGENT_EXECUTABLE: process.execPath, CONTROL_PLANE_AGENT_ARGS_JSON: '[]' } })
  assert.equal(fallback.runner?.descriptor.isolation, 'unisolated_process')
  assert.equal(fallback.descriptor.status, 'degraded')
  assert.match(fallback.descriptor.reason ?? '', /explicit process fallback/u)

  console.log(`container agent runtime smoke passed · ${run.id} · network denied · ${events.length} events`)
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
