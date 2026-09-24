import assert from 'node:assert/strict'
import { LocalWorkflowProvider } from '../src/adapters/local-workflow-provider.ts'
import { MockAgentAdapter } from '../src/adapters/mock-agent.ts'
import type { AgentRunEvent, AgentRunRequest } from '../src/adapters/contracts.ts'

class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  key(index: number) { return [...this.values.keys()][index] ?? null }
}

const request: AgentRunRequest = {
  runId: 'RUN-WORKFLOW-001',
  modelRef: 'mock-model://reasoning-medium',
  harnessRef: 'harness://control-plane-v0.1',
  sandboxRef: 'sandbox://run-workflow-001',
  sessionRef: 'session://run-workflow-001',
  intentVersionId: 'INT-142-v3',
  contextManifestId: 'CTX-142-v3',
  policyBundleId: 'policy-v12',
  evaluationSuiteIds: ['EVS-014'],
  executionMode: 'orchestrator_workers',
  workspaceRef: 'worktree://run-workflow-001',
  requestedCapabilities: ['repository:read', 'repository:write', 'shell:execute'],
  budget: { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100, maxCostUsd: 8 },
}

const events = await Array.fromAsync(new MockAgentAdapter().run(request))
const retryIndex = events.findIndex((event) => event.type === 'activity_retry_scheduled')
assert.ok(retryIndex > 0)

const storage = new MemoryStorage()
const provider = new LocalWorkflowProvider(storage)
const started = provider.start(request, 'Durable workflow recovery test')
assert.equal(started.status, 'running')
assert.equal(provider.verify(request.runId), true)

for (const event of events.slice(0, retryIndex + 1)) provider.append(request.runId, event)
const duplicate = provider.append(request.runId, events[retryIndex]!)
assert.equal(duplicate.events.length, retryIndex + 1, 'same event digest must append idempotently')

const divergent = { ...events[retryIndex]!, eventDigest: 'fnv1a:divergent' } as AgentRunEvent
assert.throws(() => provider.append(request.runId, divergent), /Divergent duplicate/)

provider.interrupt(request.runId, 'simulated browser crash')
const restartedProvider = new LocalWorkflowProvider(storage)
const recoverable = restartedProvider.latestRecoverable()
assert.ok(recoverable && recoverable.runId === request.runId)
assert.equal(recoverable.status, 'interrupted')
assert.equal(restartedProvider.verify(request.runId), true)
assert.throws(() => restartedProvider.append(request.runId, events[retryIndex + 1]!), /must be recovered before append/)

const cursor = restartedProvider.recover(request.runId)
assert.equal(cursor.nextSequence, retryIndex + 2)
assert.equal(cursor.previousEventDigest, events[retryIndex]!.eventDigest)
assert.equal(cursor.recoveryCount, 1)

for (const event of events.slice(retryIndex + 1)) restartedProvider.append(request.runId, event)
const completed = restartedProvider.read(request.runId)
assert.ok(completed && completed.status === 'completed')
assert.equal(completed.events.length, events.length)
assert.equal(restartedProvider.latestRecoverable(), null)
assert.equal(restartedProvider.verify(request.runId), true)

const executionKey = Array.from({ length: storage.length }, (_, index) => storage.key(index)).find((key) => key?.includes('.execution.'))
assert.ok(executionKey)
const tampered = JSON.parse(storage.getItem(executionKey)!)
tampered.events[0].adapterId = 'tampered-adapter'
storage.setItem(executionKey, JSON.stringify(tampered))
assert.equal(restartedProvider.verify(request.runId), false)

restartedProvider.clear()
assert.equal(storage.length, 0)

console.log(`workflow provider smoke passed · ${events.length} replayed events · recovery count ${cursor.recoveryCount}`)
