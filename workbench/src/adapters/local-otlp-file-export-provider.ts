import type { OtlpAnyValue, OtlpJsonSpan, OtlpKeyValue, TelemetryExportBundle, TelemetryExportPolicy, TelemetryExportProvider, TelemetryExportRequest, TraceAttribute, TraceSpan } from './contracts.ts'
import { digestValue } from './event-integrity.ts'
import { verifyTraceProjection } from './local-trace-provider.ts'

type UnsignedTelemetryExportBundle = Omit<TelemetryExportBundle, 'exportDigest'>

export const defaultTelemetryExportPolicy: TelemetryExportPolicy = {
  policyId: 'telemetry-metadata-only',
  policyVersion: '1',
  destination: 'local_file',
  routineSampleRate: 0.25,
  contentMode: 'metadata_only',
  alwaysKeep: ['root', 'error', 'policy_deny', 'evaluation_failure'],
  allowedAttributePrefixes: ['aperture.', 'gen_ai.request.model', 'gen_ai.tool.name', 'gen_ai.usage.', 'error.'],
  deniedAttributeFragments: ['prompt', 'content', 'message', 'system_instruction', 'tool.output', 'input.value', 'output.value', 'retrieval.query', 'resource.path'],
  maxStringLength: 256,
}

function nanos(timestamp: string) {
  return (BigInt(Date.parse(timestamp)) * 1_000_000n).toString()
}

function isPrioritySpan(span: TraceSpan, rootSpanId: string, policy: TelemetryExportPolicy) {
  if (policy.alwaysKeep.includes('root') && span.spanId === rootSpanId) return true
  if (policy.alwaysKeep.includes('error') && typeof span.attributes['error.type'] === 'string') return true
  if (policy.alwaysKeep.includes('policy_deny') && span.attributes['aperture.policy.decision'] === 'deny') return true
  return policy.alwaysKeep.includes('evaluation_failure') && Number(span.attributes['aperture.evaluation.failed'] ?? 0) > 0
}

function sampleRoutineSpan(span: TraceSpan, sampleRate: number) {
  if (sampleRate >= 1) return true
  if (sampleRate <= 0) return false
  const bucket = Number.parseInt(digestValue(span.spanId).replace('fnv1a:', ''), 16) / 0xffffffff
  return bucket < sampleRate
}

function selectedSpans(spans: TraceSpan[], policy: TelemetryExportPolicy) {
  const rootSpanId = spans[0]?.spanId ?? ''
  const byId = new Map(spans.map((span) => [span.spanId, span]))
  const selected = new Set(spans.filter((span) => isPrioritySpan(span, rootSpanId, policy) || sampleRoutineSpan(span, policy.routineSampleRate)).map((span) => span.spanId))
  for (const spanId of [...selected]) {
    let parentSpanId = byId.get(spanId)?.parentSpanId
    while (parentSpanId) {
      selected.add(parentSpanId)
      parentSpanId = byId.get(parentSpanId)?.parentSpanId
    }
  }
  return spans.filter((span) => selected.has(span.spanId))
}

function attributeAllowed(key: string, policy: TelemetryExportPolicy) {
  const normalized = key.toLowerCase()
  return policy.allowedAttributePrefixes.some((prefix) => key.startsWith(prefix))
    && !policy.deniedAttributeFragments.some((fragment) => normalized.includes(fragment.toLowerCase()))
}

function anyValue(value: TraceAttribute, maxStringLength: number): OtlpAnyValue {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  return { stringValue: value.slice(0, maxStringLength) }
}

function attributes(record: Record<string, TraceAttribute>, policy: TelemetryExportPolicy): OtlpKeyValue[] {
  return Object.entries(record)
    .filter(([key]) => attributeAllowed(key, policy))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value: anyValue(value, policy.maxStringLength) }))
}

function otlpSpan(span: TraceSpan, policy: TelemetryExportPolicy): OtlpJsonSpan {
  const failed = typeof span.attributes['error.type'] === 'string' || Number(span.attributes['aperture.evaluation.failed'] ?? 0) > 0
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.kind === 'client' ? 3 : 1,
    startTimeUnixNano: nanos(span.startedAt),
    endTimeUnixNano: nanos(span.endedAt),
    attributes: attributes(span.attributes, policy),
    status: { code: failed ? 2 : 1 },
  }
}

function validatePolicy(policy: TelemetryExportPolicy) {
  if (policy.destination !== 'local_file' || policy.contentMode !== 'metadata_only') throw new Error('Local OTLP exporter only supports metadata-only local files')
  if (policy.routineSampleRate < 0 || policy.routineSampleRate > 1) throw new Error('Telemetry sample rate must be between 0 and 1')
  if (!policy.allowedAttributePrefixes.length || policy.maxStringLength < 1) throw new Error('Telemetry export policy requires an allowlist and positive string limit')
}

export class LocalOtlpFileExportProvider implements TelemetryExportProvider {
  readonly id = 'telemetry-export://local-otlp-json-v1'

  prepare(input: TelemetryExportRequest): TelemetryExportBundle {
    if (!verifyTraceProjection(input.projection)) throw new Error(`Cannot export invalid trace projection: ${input.projection.runId}`)
    const policy = structuredClone(input.policy ?? defaultTelemetryExportPolicy)
    validatePolicy(policy)
    const exportedSpans = selectedSpans(input.projection.spans, policy).map((span) => otlpSpan(span, policy))
    const resourceAttributes: OtlpKeyValue[] = [
      { key: 'service.name', value: { stringValue: input.serviceName.slice(0, policy.maxStringLength) } },
      { key: 'deployment.environment.name', value: { stringValue: input.environment.slice(0, policy.maxStringLength) } },
      { key: 'aperture.run.id', value: { stringValue: input.projection.runId } },
      { key: 'aperture.telemetry.policy', value: { stringValue: `${policy.policyId}@${policy.policyVersion}` } },
      { key: 'aperture.trace.projection_digest', value: { stringValue: input.projection.projectionDigest } },
    ]
    const unsigned: UnsignedTelemetryExportBundle = {
      schemaVersion: 'aperture.otlp-json-export/v0.1',
      providerId: this.id,
      runId: input.projection.runId,
      traceId: input.projection.traceId,
      sourceProjectionDigest: input.projection.projectionDigest,
      policy,
      contentType: 'application/json',
      fileName: `${input.projection.runId.toLowerCase()}-otlp-export-bundle.json`,
      exportedSpanCount: exportedSpans.length,
      droppedSpanCount: input.projection.spans.length - exportedSpans.length,
      request: { resourceSpans: [{ resource: { attributes: resourceAttributes }, scopeSpans: [{ scope: { name: 'aperture.control-plane', version: '0.1' }, spans: exportedSpans }] }] },
    }
    return { ...unsigned, exportDigest: digestValue(JSON.stringify(unsigned)) }
  }

  verify(bundle: TelemetryExportBundle) {
    const { exportDigest, ...unsigned } = bundle
    if (bundle.schemaVersion !== 'aperture.otlp-json-export/v0.1' || bundle.providerId !== this.id || bundle.contentType !== 'application/json') return false
    try { validatePolicy(bundle.policy) } catch { return false }
    const resources = bundle.request.resourceSpans
    const spans = resources.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
    if (spans.length !== bundle.exportedSpanCount || bundle.exportedSpanCount < 1 || bundle.droppedSpanCount < 0) return false
    if (bundle.exportedSpanCount + bundle.droppedSpanCount < bundle.exportedSpanCount || !bundle.fileName.endsWith('-otlp-export-bundle.json')) return false
    if (spans.some((span) => span.traceId !== bundle.traceId || !/^[a-f0-9]{32}$/i.test(span.traceId) || !/^[a-f0-9]{16}$/i.test(span.spanId))) return false
    const spanIds = new Set(spans.map((span) => span.spanId))
    if (spans.some((span) => span.parentSpanId && !spanIds.has(span.parentSpanId))) return false
    if (spans.flatMap((span) => span.attributes).some((attribute) => !attributeAllowed(attribute.key, bundle.policy))) return false
    if (spans.flatMap((span) => span.attributes).some((attribute) => 'stringValue' in attribute.value && attribute.value.stringValue.length > bundle.policy.maxStringLength)) return false
    const resourceAttributes = resources.flatMap((resource) => resource.resource.attributes)
    const allowedResourceKeys = new Set(['service.name', 'deployment.environment.name', 'aperture.run.id', 'aperture.telemetry.policy', 'aperture.trace.projection_digest'])
    if (resourceAttributes.some((attribute) => !allowedResourceKeys.has(attribute.key) || ('stringValue' in attribute.value && attribute.value.stringValue.length > bundle.policy.maxStringLength))) return false
    const resourceValues = new Map(resourceAttributes.map((attribute) => [attribute.key, 'stringValue' in attribute.value ? attribute.value.stringValue : '']))
    if (resourceValues.get('aperture.run.id') !== bundle.runId || resourceValues.get('aperture.trace.projection_digest') !== bundle.sourceProjectionDigest || resourceValues.get('aperture.telemetry.policy') !== `${bundle.policy.policyId}@${bundle.policy.policyVersion}`) return false
    return exportDigest === digestValue(JSON.stringify(unsigned))
  }
}

export function verifyTelemetryExportBundle(bundle: TelemetryExportBundle) {
  return new LocalOtlpFileExportProvider().verify(bundle)
}
