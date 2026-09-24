import assert from 'node:assert/strict'
import { MockAgentAdapter } from '../src/adapters/mock-agent.ts'
import { LocalTraceProvider } from '../src/adapters/local-trace-provider.ts'
import type { AgentRunRequest } from '../src/adapters/contracts.ts'

const request: AgentRunRequest = {
  runId: 'RUN-TRACE-001',
  modelRef: 'mock-model://reasoning-medium',
  harnessRef: 'harness://control-plane-v0.1',
  sandboxRef: 'sandbox://run-trace-001',
  sessionRef: 'session://run-trace-001',
  intentVersionId: 'INT-142-v3',
  contextManifestId: 'CTX-142-v3',
  policyBundleId: 'policy-v12',
  evaluationSuiteIds: ['EVS-014'],
  executionMode: 'orchestrator_workers',
  workspaceRef: 'worktree://run-trace-001',
  requestedCapabilities: ['repository:read', 'repository:write', 'shell:execute'],
  budget: { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100, maxCostUsd: 8 },
}

const events = await Array.fromAsync(new MockAgentAdapter().run(request))
const provider = new LocalTraceProvider()
const trace = provider.project(request.runId, events)

assert.equal(provider.verify(trace), true)
assert.equal(trace.spans.length, events.length + 1)
assert.match(trace.traceId, /^[a-f0-9]{32}$/)
assert.equal(trace.spans[0]?.name, 'agent.run')
assert.equal(trace.spans[0]?.attributes['aperture.chain.head'], events.at(-1)?.eventDigest)
assert.ok(trace.spans.some((span) => span.name === 'gen_ai.tool.run_tests' && span.kind === 'client'))
assert.ok(trace.spans.some((span) => span.attributes['aperture.policy.decision'] === 'deny'))
assert.ok(trace.spans.some((span) => span.attributes['aperture.evaluation.dataset_version'] === '2026-09-22.3'))
assert.equal(trace.spans.some((span) => Object.values(span.attributes).includes('config/oauth.internal.yml')), false, 'raw context resource paths must not be exported as trace attributes')

const tampered = structuredClone(trace)
tampered.spans[0]!.attributes['aperture.event.count'] = 999
assert.equal(provider.verify(tampered), false)

console.log(`trace provider smoke passed · ${trace.traceId} · ${trace.spans.length} sanitized spans`)
