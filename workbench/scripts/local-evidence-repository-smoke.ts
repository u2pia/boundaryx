import assert from 'node:assert/strict'
import { MockAgentAdapter } from '../src/adapters/mock-agent.ts'
import { LocalEvidenceRepository } from '../src/adapters/local-evidence-repository.ts'
import type { AgentRunRequest } from '../src/adapters/contracts.ts'

class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  key(index: number) { return [...this.values.keys()][index] ?? null }
}

const request: AgentRunRequest = {
  runId: 'RUN-LOCAL-001',
  modelRef: 'mock-model://reasoning-medium',
  harnessRef: 'harness://control-plane-v0.1',
  sandboxRef: 'sandbox://run-local-001',
  sessionRef: 'session://run-local-001',
  intentVersionId: 'INT-142-v3',
  contextManifestId: 'CTX-142-v3',
  policyBundleId: 'policy-v12',
  evaluationSuiteIds: ['EVS-014'],
  executionMode: 'orchestrator_workers',
  workspaceRef: 'worktree://run-local-001',
  requestedCapabilities: ['repository:read', 'repository:write', 'shell:execute'],
  budget: { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100 },
}

const storage = new MemoryStorage()
const repository = new LocalEvidenceRepository(storage)
for await (const event of new MockAgentAdapter().run(request)) await repository.append(request.runId, event)
const sealed = await repository.finalize(request.runId)
assert.equal(sealed.packageUri, 'local://evidence/run-local-001.json')
assert.equal(repository.verifyPackage(sealed.packageUri), true)

const restoredRepository = new LocalEvidenceRepository(storage)
assert.equal(restoredRepository.verifyPackage(sealed.packageUri), true, 'sealed package must survive repository recreation')
assert.ok(restoredRepository.readPackage(sealed.packageUri)?.events.some((event) => event.type === 'ci_evidence_ingested'))

const interruptedRequest = { ...request, runId: 'RUN-LOCAL-INTERRUPTED', sandboxRef: 'sandbox://run-local-interrupted', sessionRef: 'session://run-local-interrupted' }
const interruptedEvents = await Array.fromAsync(new MockAgentAdapter().run(interruptedRequest))
const restoredDraftRepository = new LocalEvidenceRepository(storage)
restoredDraftRepository.restoreDraft(interruptedRequest.runId, interruptedEvents.slice(0, 8))
for (const event of interruptedEvents.slice(8)) await restoredDraftRepository.append(interruptedRequest.runId, event)
const restoredDraftPackage = await restoredDraftRepository.finalize(interruptedRequest.runId)
assert.equal(restoredDraftRepository.verifyPackage(restoredDraftPackage.packageUri), true, 'restored draft must preserve the original event chain')

const packageKey = Array.from({ length: storage.length }, (_, index) => storage.key(index)).find((key) => key?.includes('.package.'))
assert.ok(packageKey)
const tampered = JSON.parse(storage.getItem(packageKey)!)
tampered.events[0].adapterId = 'tampered-adapter'
storage.setItem(packageKey, JSON.stringify(tampered))
assert.equal(restoredRepository.verifyPackage(sealed.packageUri), false)

restoredRepository.clear()
assert.equal(storage.length, 0)

console.log('local evidence repository smoke tests passed')
