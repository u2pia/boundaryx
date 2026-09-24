import assert from 'node:assert/strict'
import { MockAgentAdapter } from '../src/adapters/mock-agent.ts'
import type { AgentRunRequest, TelemetryExportPolicy } from '../src/adapters/contracts.ts'
import { LocalOtlpFileExportProvider, defaultTelemetryExportPolicy } from '../src/adapters/local-otlp-file-export-provider.ts'
import { LocalTraceProvider } from '../src/adapters/local-trace-provider.ts'
import { digestValue } from '../src/adapters/event-integrity.ts'

function resign<T extends { exportDigest: string }>(bundle: T) {
  const { exportDigest: _exportDigest, ...unsigned } = bundle
  return { ...unsigned, exportDigest: digestValue(JSON.stringify(unsigned)) } as T
}

const request: AgentRunRequest = {
  runId: 'RUN-OTLP-001',
  modelRef: 'mock-model://reasoning-medium',
  harnessRef: 'harness://control-plane-v0.1',
  sandboxRef: 'sandbox://run-otlp-001',
  sessionRef: 'session://run-otlp-001',
  intentVersionId: 'INT-142-v3',
  contextManifestId: 'CTX-142-v3',
  policyBundleId: 'policy-v12',
  evaluationSuiteIds: ['EVS-014'],
  executionMode: 'orchestrator_workers',
  workspaceRef: 'worktree://run-otlp-001',
  requestedCapabilities: ['repository:read', 'repository:write', 'shell:execute'],
  budget: { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100, maxCostUsd: 8 },
}

const events = await Array.fromAsync(new MockAgentAdapter().run(request))
const projection = new LocalTraceProvider().project(request.runId, events)
const provider = new LocalOtlpFileExportProvider()
const priorityOnlyPolicy: TelemetryExportPolicy = { ...structuredClone(defaultTelemetryExportPolicy), routineSampleRate: 0 }
const bundle = provider.prepare({ projection, serviceName: 'aperture-control-plane', environment: 'test', policy: priorityOnlyPolicy })
const spans = bundle.request.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
const exportedAttributes = spans.flatMap((span) => span.attributes)

assert.equal(provider.verify(bundle), true)
assert.equal(bundle.exportedSpanCount + bundle.droppedSpanCount, projection.spans.length)
assert.ok(bundle.droppedSpanCount > 0, 'zero routine sample rate should drop non-priority spans')
assert.ok(spans.some((span) => span.name === 'agent.run' && !span.parentSpanId), 'root span must always be retained')
assert.ok(spans.some((span) => span.attributes.some((attribute) => attribute.key === 'error.type')), 'error spans must always be retained')
assert.ok(spans.some((span) => span.attributes.some((attribute) => attribute.key === 'aperture.policy.decision' && 'stringValue' in attribute.value && attribute.value.stringValue === 'deny')), 'policy denials must always be retained')
assert.ok(spans.some((span) => span.attributes.some((attribute) => attribute.key === 'aperture.evaluation.failed' && 'intValue' in attribute.value && Number(attribute.value.intValue) > 0)), 'failed evaluations must always be retained')
const exportedSpanIds = new Set(spans.map((span) => span.spanId))
assert.equal(spans.every((span) => !span.parentSpanId || exportedSpanIds.has(span.parentSpanId)), true, 'sampled child spans must retain their parent chain')
assert.equal(exportedAttributes.some((attribute) => attribute.key.toLowerCase().includes('prompt')), false)
assert.equal(exportedAttributes.some((attribute) => attribute.key.toLowerCase().includes('content')), false)
assert.equal(JSON.stringify(bundle).includes('config/oauth.internal.yml'), false, 'raw context resource paths must not enter OTLP export')

const tampered = structuredClone(bundle)
tampered.request.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name = 'tampered'
assert.equal(provider.verify(tampered), false)

const unsafeResource = structuredClone(bundle)
unsafeResource.request.resourceSpans[0]!.resource.attributes.push({ key: 'gen_ai.prompt', value: { stringValue: 'secret prompt' } })
assert.equal(provider.verify(resign(unsafeResource)), false, 'semantic verification must reject unsafe resource attributes even with a recomputed digest')

const brokenParent = structuredClone(bundle)
brokenParent.request.resourceSpans[0]!.scopeSpans[0]!.spans.at(-1)!.parentSpanId = '0'.repeat(16)
assert.equal(provider.verify(resign(brokenParent)), false, 'semantic verification must reject missing sampled parents')

assert.throws(() => provider.prepare({ projection, serviceName: 'aperture', environment: 'test', policy: { ...priorityOnlyPolicy, routineSampleRate: 1.1 } }), /sample rate/)
assert.throws(() => provider.prepare({ projection, serviceName: 'aperture', environment: 'test', policy: { ...priorityOnlyPolicy, contentMode: 'metadata_only', destination: 'local_file', allowedAttributePrefixes: [] } }), /allowlist/)

console.log(`telemetry export smoke passed · ${bundle.exportedSpanCount}/${projection.spans.length} spans · ${bundle.fileName}`)
