import type { AgentRunEvent, TraceAttribute, TraceProjection, TraceProvider, TraceSpan } from './contracts.ts'
import { digestValue, verifyEventChain, verifyEventProtocol } from './event-integrity.ts'

type UnsignedTraceProjection = Omit<TraceProjection, 'projectionDigest'>

function hexDigest(value: string) {
  return digestValue(value).replace('fnv1a:', '')
}

function traceIdFor(runId: string) {
  return [0, 1, 2, 3].map((index) => hexDigest(`${runId}:${index}`)).join('')
}

function spanIdFor(value: string) {
  return `${hexDigest(`${value}:a`)}${hexDigest(`${value}:b`)}`
}

function eventAttributes(event: AgentRunEvent): Record<string, TraceAttribute> {
  const base: Record<string, TraceAttribute> = { 'aperture.event.type': event.type, 'aperture.event.sequence': event.sequence, 'aperture.event.digest': event.eventDigest }
  if (event.type === 'runtime_bound') return { ...base, 'gen_ai.request.model': event.modelRef, 'aperture.harness.ref': event.harnessRef, 'aperture.sandbox.ref': event.sandboxRef, 'aperture.session.ref': event.sessionRef }
  if (event.type === 'workflow_bound') return { ...base, 'aperture.workflow.id': event.workflowId, 'aperture.workflow.provider': event.providerRef, 'aperture.workflow.replay_mode': event.replayMode }
  if (event.type === 'policy_bundle_bound') return { ...base, 'aperture.policy.bundle_id': event.bundleId, 'aperture.policy.version': event.bundleVersion, 'aperture.policy.digest': event.bundleDigest }
  if (event.type === 'context_requested' || event.type === 'context_consumed') return { ...base, 'aperture.context.digest': event.digest, 'aperture.context.trust': event.trust, 'aperture.context.sensitivity': event.sensitivity, 'aperture.context.declared': event.declared }
  if (event.type === 'activity_attempt_started') return { ...base, 'aperture.activity.id': event.activityId, 'aperture.activity.type': event.activityType, 'aperture.activity.attempt': event.attempt, 'aperture.activity.side_effect': event.sideEffect }
  if (event.type === 'tool_requested') return { ...base, 'gen_ai.tool.name': event.tool, 'aperture.tool.capability': event.capability, 'aperture.tool.input_digest': event.inputDigest, 'aperture.activity.id': event.activityId, 'aperture.activity.attempt': event.attempt }
  if (event.type === 'policy_decided') return { ...base, 'aperture.policy.id': event.decision.policyId, 'aperture.policy.version': event.decision.policyVersion, 'aperture.policy.decision': event.decision.decision, 'aperture.policy.input_digest': event.decision.inputDigest }
  if (event.type === 'activity_failed') return { ...base, 'aperture.activity.id': event.activityId, 'aperture.activity.attempt': event.attempt, 'error.type': event.errorType, 'error.retryable': event.retryable, 'error.digest': event.errorDigest }
  if (event.type === 'activity_retry_scheduled') return { ...base, 'aperture.activity.id': event.activityId, 'aperture.activity.failed_attempt': event.failedAttempt, 'aperture.activity.next_attempt': event.nextAttempt, 'aperture.activity.backoff_seconds': event.backoffSeconds }
  if (event.type === 'activity_completed') return { ...base, 'aperture.activity.id': event.activityId, 'aperture.activity.attempt': event.attempt, 'aperture.output.digest': event.outputDigest }
  if (event.type === 'evaluation_experiment_bound') return { ...base, 'aperture.evaluation.experiment_id': event.experimentId, 'aperture.evaluation.suite_id': event.suiteId, 'aperture.evaluation.dataset_ref': event.datasetRef, 'aperture.evaluation.dataset_version': event.datasetVersion, 'aperture.evaluation.trial_count': event.trialCount, 'aperture.evaluation.trace_ref': event.traceRef }
  if (event.type === 'evaluation_completed') return { ...base, 'aperture.evaluation.suite_id': event.suiteId, 'aperture.evaluation.passed': event.passed, 'aperture.evaluation.failed': event.failed, 'aperture.evaluation.unknown': event.unknown }
  if (event.type === 'evaluation_diagnosed') return { ...base, 'aperture.evaluation.suite_id': event.suiteId, 'aperture.evaluation.failure_count': event.failures.length, 'aperture.evaluation.environment_digest': event.environment.imageDigest }
  if (event.type === 'usage_reported') return { ...base, 'gen_ai.usage.input_tokens': event.usage.inputTokens, 'gen_ai.usage.output_tokens': event.usage.outputTokens, 'aperture.usage.tool_calls': event.usage.toolCalls, 'aperture.usage.estimated_cost_usd': event.usage.estimatedCostUsd }
  if (event.type === 'run_completed') return { ...base, 'aperture.run.status': event.status, 'aperture.output.digest': event.outputDigest }
  return base
}

export class LocalTraceProvider implements TraceProvider {
  readonly id = 'trace://local-otel-projection-v1'

  project(runId: string, events: AgentRunEvent[]): TraceProjection {
    if (!events.length || events.some((event) => event.runId !== runId) || !verifyEventChain(events) || !verifyEventProtocol(events)) throw new Error(`Cannot project invalid run trace: ${runId}`)
    const traceId = traceIdFor(runId)
    const rootSpanId = spanIdFor(`${runId}:root`)
    const activityParents = new Map<string, string>()
    const experimentParents = new Map<string, string>()
    const root: TraceSpan = {
      traceId,
      spanId: rootSpanId,
      name: 'agent.run',
      kind: 'internal',
      startedAt: events[0]!.occurredAt,
      endedAt: events.at(-1)!.occurredAt,
      attributes: { 'aperture.run.id': runId, 'aperture.event.count': events.length, 'aperture.chain.head': events.at(-1)!.eventDigest },
    }
    const spans = events.map((event): TraceSpan => {
      const spanId = spanIdFor(event.eventDigest)
      let parentSpanId = rootSpanId
      let name = event.type.replaceAll('_', '.')
      let kind: TraceSpan['kind'] = 'internal'
      if (event.type === 'activity_attempt_started') activityParents.set(`${event.activityId}:${event.attempt}`, spanId)
      if (event.type === 'tool_requested' || event.type === 'policy_decided') parentSpanId = activityParents.get(`${event.activityId}:${event.attempt}`) ?? rootSpanId
      if (event.type === 'tool_requested') { name = `gen_ai.tool.${event.tool}`; kind = 'client' }
      if (event.type === 'evaluation_experiment_bound') experimentParents.set(event.suiteId, spanId)
      if (event.type === 'evaluation_completed' || event.type === 'evaluation_diagnosed') parentSpanId = experimentParents.get(event.suiteId) ?? rootSpanId
      return { traceId, spanId, parentSpanId, name, kind, startedAt: event.occurredAt, endedAt: event.occurredAt, attributes: eventAttributes(event) }
    })
    const unsigned: UnsignedTraceProjection = { schemaVersion: 'aperture.otel-trace-projection/v0.1', providerId: this.id, runId, traceId, spans: [root, ...spans] }
    return { ...unsigned, projectionDigest: digestValue(JSON.stringify(unsigned)) }
  }

  verify(projection: TraceProjection) {
    const { projectionDigest, ...unsigned } = projection
    if (projection.schemaVersion !== 'aperture.otel-trace-projection/v0.1' || projection.providerId !== this.id || projection.spans.length < 2) return false
    if (projection.spans.some((span) => span.traceId !== projection.traceId)) return false
    if (projection.spans[0]?.name !== 'agent.run' || projection.spans[0]?.parentSpanId) return false
    return projectionDigest === digestValue(JSON.stringify(unsigned))
  }
}

export function verifyTraceProjection(projection: TraceProjection) {
  return new LocalTraceProvider().verify(projection)
}
