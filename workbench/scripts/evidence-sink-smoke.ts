import assert from 'node:assert/strict'
import { MockAgentAdapter } from '../src/adapters/mock-agent.ts'
import { InMemoryEvidenceSink } from '../src/adapters/in-memory-evidence-sink.ts'
import type { AgentRunEvent, AgentRunRequest } from '../src/adapters/contracts.ts'
import { computeEventDigest } from '../src/adapters/event-integrity.ts'

const request: AgentRunRequest = {
  runId: 'RUN-EVIDENCE-001',
  modelRef: 'mock-model://reasoning-medium',
  harnessRef: 'harness://control-plane-v0.1',
  sandboxRef: 'sandbox://run-evidence-001',
  sessionRef: 'session://run-evidence-001',
  intentVersionId: 'INT-142-v3',
  contextManifestId: 'CTX-142-v3',
  policyBundleId: 'policy-v12',
  evaluationSuiteIds: ['EVS-014'],
  executionMode: 'orchestrator_workers',
  workspaceRef: 'worktree://run-evidence-001',
  requestedCapabilities: ['repository:read', 'repository:write', 'shell:execute'],
  budget: { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100 },
}

const adapter = new MockAgentAdapter()
const sink = new InMemoryEvidenceSink()
for await (const event of adapter.run(request)) await sink.append(request.runId, event)

const evidencePackage = await sink.finalize(request.runId)
assert.equal(evidencePackage.packageUri, 'memory://evidence/run-evidence-001.json')
assert.match(evidencePackage.packageDigest, /^fnv1a:/)

const validEvents = await Array.fromAsync(adapter.run({ ...request, runId: 'RUN-EVIDENCE-TAMPER', sandboxRef: 'sandbox://run-evidence-tamper', sessionRef: 'session://run-evidence-tamper' }))
const tamperedSink = new InMemoryEvidenceSink()
await tamperedSink.append('RUN-EVIDENCE-TAMPER', validEvents[0])
await assert.rejects(() => tamperedSink.append('RUN-EVIDENCE-TAMPER', { ...validEvents[1], eventDigest: 'fnv1a:tampered' }), /Invalid event chain/)

const protocolSink = new InMemoryEvidenceSink()
for (const event of validEvents.slice(0, 4)) await protocolSink.append('RUN-EVIDENCE-TAMPER', event)
const scopeEvent = validEvents.find((event): event is Extract<AgentRunEvent, { type: 'context_scope_created' }> => event.type === 'context_scope_created')!
const { eventDigest: _discardedDigest, ...scopeEventUnsigned } = scopeEvent
const invalidProtocolUnsigned = { ...scopeEventUnsigned, sequence: 5, previousEventDigest: validEvents[3]!.eventDigest }
const invalidProtocolEvent = { ...invalidProtocolUnsigned, eventDigest: computeEventDigest(invalidProtocolUnsigned) } as AgentRunEvent
await assert.rejects(() => protocolSink.append('RUN-EVIDENCE-TAMPER', invalidProtocolEvent), /Invalid event protocol.*accepted work contract/)

const missingAttestationSink = new InMemoryEvidenceSink()
await missingAttestationSink.append('RUN-EVIDENCE-TAMPER', validEvents[0])
await missingAttestationSink.append('RUN-EVIDENCE-TAMPER', validEvents[1])
const harnessEvent = validEvents.find((event): event is Extract<AgentRunEvent, { type: 'harness_profile_selected' }> => event.type === 'harness_profile_selected')!
const { eventDigest: _harnessDigest, ...harnessUnsigned } = harnessEvent
const unattestedHarnessUnsigned = { ...harnessUnsigned, sequence: 3, previousEventDigest: validEvents[1]!.eventDigest }
const unattestedHarnessEvent = { ...unattestedHarnessUnsigned, eventDigest: computeEventDigest(unattestedHarnessUnsigned) } as AgentRunEvent
await assert.rejects(() => missingAttestationSink.append('RUN-EVIDENCE-TAMPER', unattestedHarnessEvent), /Invalid event protocol.*verified sandbox attestation/)

const incompleteSink = new InMemoryEvidenceSink()
const firstEvent = (await Array.fromAsync(adapter.run({ ...request, runId: 'RUN-EVIDENCE-002', sandboxRef: 'sandbox://run-evidence-002', sessionRef: 'session://run-evidence-002' })))[0]
await incompleteSink.append('RUN-EVIDENCE-002', firstEvent)
await assert.rejects(() => incompleteSink.finalize('RUN-EVIDENCE-002'), /incomplete evidence/)

console.log('evidence sink smoke tests passed')
