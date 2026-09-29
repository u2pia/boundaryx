// Agent Runs execute in worker processes. This asserts the two properties that motivated the change:
// the Control Plane keeps answering requests while an agent is generating, and a run in flight can be
// cancelled. Before the queue existed, /api/health timed out for the entire duration of every run.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRunQueue } from '../server/agent-run-queue.ts'
import { createConfiguredAgentRunner } from '../server/agent-runner-factory.ts'
import { ControlPlaneDatabase } from '../server/database.ts'
import { useProjectRepository } from './fixtures.ts'
import { createControlPlaneServer } from '../server/http-server.ts'

const root = mkdtempSync(join(tmpdir(), 'aperture-run-queue-'))
const repositoryPath = join(root, 'repository')
const dataDirectory = join(root, 'data')
const databasePath = join(dataDirectory, 'control-plane.db')
const migrationDirectory = join(import.meta.dirname, '../server/migrations')
const agentScript = join(root, 'slow-agent.mjs')

function git(...args: string[]) {
  return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8' }).trim()
}

mkdirSync(repositoryPath)
mkdirSync(dataDirectory, { recursive: true })
execFileSync('git', ['init', '--initial-branch=main', repositoryPath])
git('config', 'user.name', 'Aperture Queue Test')
git('config', 'user.email', 'queue-test@aperture.invalid')
mkdirSync(join(repositoryPath, '.aperture'))
writeFileSync(join(repositoryPath, 'README.md'), '# Queue fixture\n')
writeFileSync(join(repositoryPath, '.aperture/project.json'), JSON.stringify({
  schemaVersion: 'aperture.project.v1',
  productType: 'application',
  context: { required: ['README.md'], allowed: ['README.md'] },
  checks: [{ name: 'noop', kind: 'test', command: [process.execPath, '-e', '0'], timeoutMs: 30_000 }],
  policy: { maximumRisk: 'medium', allowUnisolatedRuntime: true },
}, null, 2))
git('add', '-A')
git('commit', '-m', 'initial')

// The agent blocks synchronously, exactly like a real CLI agent does, for a duration taken from the goal.
writeFileSync(agentScript, `import { readFileSync, writeFileSync } from 'node:fs'
const request = JSON.parse(readFileSync(process.env.APERTURE_RUN_REQUEST, 'utf8'))
const ms = Number(request.intent.goal.match(/(\\d+)ms/)[1])
console.log(JSON.stringify({ type: 'message', summary: 'Working for ' + ms + 'ms.' }))
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
writeFileSync('feature.txt', request.runId + '\\n')
`)

const database = new ControlPlaneDatabase(databasePath, migrationDirectory)
const env = { ...process.env, CONTROL_PLANE_AGENT_EXECUTABLE: process.execPath, CONTROL_PLANE_AGENT_ARGS_JSON: JSON.stringify([agentScript]) }
const configured = createConfiguredAgentRunner({ database, dataDirectory, env })
assert.ok(configured.runner, 'expected a process Agent Runner')
// Concurrency 1 so the queue-position and cancel-before-start paths are actually reachable.
const agentRunQueue = new AgentRunQueue({ database, databasePath, dataDirectory, concurrency: 1, env })
const server = createControlPlaneServer({ database, agentRunner: configured.runner, agentRunQueue, agentRuntimeDescriptor: configured.descriptor, evidenceStore: configured.evidenceStore })

let cookie = ''

async function request<T>(path: string, options: { method?: string; body?: unknown; idempotencyKey?: string } = {}) {
  const { port } = server.address() as AddressInfo
  const started = Date.now()
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}), ...(cookie ? { cookie } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  return { status: response.status, latencyMs: Date.now() - started, body: response.status === 204 ? undefined : (await response.json() as T) }
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function poll(runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await request<{ agentRun: { status: string; errorMessage?: string } }>(`/api/agent-runs/${runId}`)
    if (!['queued', 'running'].includes(current.body!.agentRun.status)) return current.body!.agentRun
    await sleep(100)
  }
  throw new Error(`Agent run ${runId} did not reach a terminal state within ${timeoutMs}ms`)
}

try {
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
  const setup = await request<{ actor: { id: string } }>('/api/setup', { body: { username: 'owner', displayName: 'Owner', password: 'owner-password-2026' } })
  useProjectRepository(database, repositoryPath, setup.body!.actor.id)
  const approver = database.createActor({ username: 'approver', displayName: 'Intent Approver', role: 'reviewer', password: 'approver-password-2026' }, setup.body!.actor.id)
  const workItem = await request<{ workItem: { id: string } }>('/api/work-items', { body: { projectId: 'PRJ-DEFAULT', title: '队列化 Agent Run', description: '验证控制面在生成期间保持可用。' } })
  const workItemId = workItem.body!.workItem.id

  const createIntent = async (goal: string) => (await request<{ intentVersion: { id: string } }>(`/api/work-items/${workItemId}/intent-versions`, { body: { goal, constraints: [], riskLevel: 'medium', acceptanceCriteria: [{ statement: '产生真实 commit', criticality: 'critical', verificationType: 'deterministic' }] } })).body!.intentVersion.id
  const createApprovedIntent = async (goal: string) => {
    const intentVersionId = await createIntent(goal)
    database.approveIntentVersion(intentVersionId, approver.id)
    return intentVersionId
  }
  const startRun = async (intentVersionId: string, requestKey?: string) => request<{ agentRun: { id: string; status: string }; queuePosition?: number; idempotentReplay: boolean }>('/api/agent-runs', { body: { workItemId, intentVersionId, baseRef: 'main', declaredContextPaths: ['README.md'] }, idempotencyKey: requestKey })

  // 1. Starting a run returns immediately with a queued run, and the control plane answers throughout.
  const slowIntent = await createApprovedIntent('生成变更，耗时 2500ms')
  const slowRun = await startRun(slowIntent, 'queue-run-retry-001')
  assert.equal(slowRun.status, 202)
  assert.equal(slowRun.body!.agentRun.status, 'queued')
  assert.ok(slowRun.latencyMs < 2_000, `admitting a run took ${slowRun.latencyMs}ms`)
  const replayedSlowRun = await startRun(slowIntent, 'queue-run-retry-001')
  assert.equal(replayedSlowRun.status, 200)
  assert.equal(replayedSlowRun.body!.agentRun.id, slowRun.body!.agentRun.id)
  assert.equal(replayedSlowRun.body!.idempotentReplay, true)
  const conflictingReplay = await startRun(await createApprovedIntent('另一个请求，耗时 1000ms'), 'queue-run-retry-001')
  assert.equal(conflictingReplay.status, 409)

  const probes: number[] = []
  let sawRunningInQueue = false
  const runId = slowRun.body!.agentRun.id
  while (true) {
    const health = await request<{ status: string; agentRunQueue: { running: Array<{ runId: string }> } }>('/api/health')
    assert.equal(health.status, 200)
    probes.push(health.latencyMs)
    if (health.body!.agentRunQueue.running.some((entry) => entry.runId === runId)) sawRunningInQueue = true
    const current = await request<{ agentRun: { status: string } }>(`/api/agent-runs/${runId}`)
    if (!['queued', 'running'].includes(current.body!.agentRun.status)) break
    await sleep(100)
  }
  const worstProbe = Math.max(...probes)
  assert.ok(probes.length >= 8, `expected repeated health probes during the run, got ${probes.length}`)
  assert.ok(worstProbe < 1_000, `the control plane blocked for ${worstProbe}ms during a run`)
  assert.equal(sawRunningInQueue, true, 'expected /api/health to report the run as executing')
  const succeeded = await poll(runId, 60_000)
  assert.equal(succeeded.status, 'succeeded')

  // 2. A run in flight can be cancelled, and cancelling is recorded rather than inferred.
  const longRun = await startRun(await createApprovedIntent('生成变更，耗时 60000ms'))
  const longRunId = longRun.body!.agentRun.id
  const cancelDeadline = Date.now() + 20_000
  while (Date.now() < cancelDeadline && (await request<{ agentRun: { status: string } }>(`/api/agent-runs/${longRunId}`)).body!.agentRun.status !== 'running') await sleep(50)
  const cancel = await request<{ agentRun: { status: string } }>(`/api/agent-runs/${longRunId}/cancel`, { method: 'POST' })
  assert.equal(cancel.status, 200)
  assert.ok(cancel.latencyMs < 1_000, `cancelling took ${cancel.latencyMs}ms`)
  const cancelled = await poll(longRunId, 30_000)
  assert.equal(cancelled.status, 'cancelled')
  const cancelEvents = (await request<{ events: Array<{ eventType: string }> }>(`/api/agent-runs/${longRunId}`)).body!.events.map((event) => event.eventType)
  assert.equal(cancelEvents.includes('agent_run.cancellation_requested'), true)
  assert.equal(cancelEvents.at(-1), 'agent_run.cancelled')
  // A client can safely retry after losing the first response; no second cancellation event is written.
  const repeatedCancel = await request<{ agentRun: { status: string } }>(`/api/agent-runs/${longRunId}/cancel`, { method: 'POST' })
  assert.equal(repeatedCancel.status, 200)
  assert.equal(repeatedCancel.body!.agentRun.status, 'cancelled')
  const repeatedCancelEvents = (await request<{ events: Array<{ eventType: string }> }>(`/api/agent-runs/${longRunId}`)).body!.events.map((event) => event.eventType)
  assert.equal(repeatedCancelEvents.filter((event) => event === 'agent_run.cancellation_requested').length, 1)
  assert.equal(repeatedCancelEvents.filter((event) => event === 'agent_run.cancelled').length, 1)

  // 3. A run still waiting in line is cancelled without ever executing.
  const blocking = await startRun(await createApprovedIntent('生成变更，耗时 8000ms'))
  const waiting = await startRun(await createApprovedIntent('生成变更，耗时 8000ms'))
  assert.equal(waiting.body!.queuePosition, 1)
  const waitingCancel = await request<{ agentRun: { status: string } }>(`/api/agent-runs/${waiting.body!.agentRun.id}/cancel`, { method: 'POST' })
  assert.equal(waitingCancel.status, 200)
  assert.equal(waitingCancel.body!.agentRun.status, 'cancelled')
  const waitingEvents = (await request<{ events: Array<{ eventType: string }> }>(`/api/agent-runs/${waiting.body!.agentRun.id}`)).body!.events.map((event) => event.eventType)
  assert.equal(waitingEvents.includes('agent_run.started'), false, 'a cancelled queued run must never have started')
  await request(`/api/agent-runs/${blocking.body!.agentRun.id}/cancel`, { method: 'POST' })
  await poll(blocking.body!.agentRun.id, 30_000)

  // 4. Startup recovery is atomic and preserves an accepted cancellation instead of misclassifying it as failure.
  const recoveryIntent = await createApprovedIntent('生成变更，耗时 1000ms')
  const orphanCancelled = configured.runner!.prepare({ workItemId, intentVersionId: recoveryIntent, baseRef: 'main', declaredContextPaths: ['README.md'] }, setup.body!.actor.id)
  database.requestAgentRunCancellation(orphanCancelled.id, setup.body!.actor.id)
  const recoveryQueue = new AgentRunQueue({ database, databasePath, dataDirectory, concurrency: 1, env, runner: configured.runner })
  assert.deepEqual(recoveryQueue.reconcile(), [orphanCancelled.id])
  assert.equal(database.getAgentRun(orphanCancelled.id).status, 'cancelled')
  const recoveredCancellationEvents = database.listAggregateEvents('agent_run', orphanCancelled.id).map((event) => event.eventType)
  assert.equal(recoveredCancellationEvents.filter((event) => event === 'agent_run.worker_lost').length, 1)
  assert.equal(recoveredCancellationEvents.filter((event) => event === 'agent_run.cancelled').length, 1)

  const orphanFailed = configured.runner!.prepare({ workItemId, intentVersionId: recoveryIntent, baseRef: 'main', declaredContextPaths: ['README.md'] }, setup.body!.actor.id)
  assert.deepEqual(recoveryQueue.reconcile(), [orphanFailed.id])
  const recoveredFailure = database.getAgentRun(orphanFailed.id)
  assert.equal(recoveredFailure.status, 'failed')
  const failureEventCount = database.listAggregateEvents('agent_run', orphanFailed.id).filter((event) => event.eventType === 'agent_run.failed').length
  database.completeAgentRun({ runId: orphanFailed.id, status: 'failed', actorId: setup.body!.actor.id, errorMessage: recoveredFailure.errorMessage })
  assert.equal(database.listAggregateEvents('agent_run', orphanFailed.id).filter((event) => event.eventType === 'agent_run.failed').length, failureEventCount)

  // 5. An admission refused at insert time — here the unique Idempotency-Key index, as when another Control Plane
  // process on the same database won the race — leaves neither a worktree nor an agent branch behind.
  const keyedRequest = { workItemId, intentVersionId: recoveryIntent, baseRef: 'main', declaredContextPaths: ['README.md'], requestKey: 'raced-key-001', admissionRequestDigest: 'sha256:raced' }
  const keyedRun = configured.runner!.prepare(keyedRequest, setup.body!.actor.id)
  const worktreesBefore = git('worktree', 'list', '--porcelain')
  const branchesBefore = git('branch', '--list', 'agent/*')
  assert.throws(() => configured.runner!.prepare(keyedRequest, setup.body!.actor.id))
  assert.equal(git('worktree', 'list', '--porcelain'), worktreesBefore)
  assert.equal(git('branch', '--list', 'agent/*'), branchesBefore)
  recoveryQueue.cancel(keyedRun.id, setup.body!.actor.id)

  // 6. A run executing outside this queue (another process owns its worker) is not refused: the cancellation is
  // recorded once, and recovery closes the run as cancelled.
  const foreignRun = configured.runner!.prepare({ workItemId, intentVersionId: recoveryIntent, baseRef: 'main', declaredContextPaths: ['README.md'] }, setup.body!.actor.id)
  assert.equal(database.claimAgentRun(foreignRun.id, 999_999, setup.body!.actor.id), true)
  const foreignCancel = recoveryQueue.cancel(foreignRun.id, setup.body!.actor.id)
  assert.equal(foreignCancel.status, 'running')
  assert.ok(foreignCancel.cancellationRequestedAt)
  recoveryQueue.cancel(foreignRun.id, setup.body!.actor.id)
  assert.equal(database.listAggregateEvents('agent_run', foreignRun.id).filter((event) => event.eventType === 'agent_run.cancellation_requested').length, 1)
  assert.deepEqual(recoveryQueue.reconcile(), [foreignRun.id])
  assert.equal(database.getAgentRun(foreignRun.id).status, 'cancelled')

  console.log(`agent run queue smoke passed · worst /api/health latency during a run: ${worstProbe}ms over ${probes.length} probes · cancellation retry and restart recovery are idempotent`)
} finally {
  agentRunQueue.close()
  await new Promise<void>((closed) => server.close(() => closed()))
  database.close()
  rmSync(root, { recursive: true, force: true })
}
