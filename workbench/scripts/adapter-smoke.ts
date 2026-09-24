import assert from 'node:assert/strict'
import { MockAgentAdapter } from '../src/adapters/mock-agent.ts'
import type { AgentRunEvent, AgentRunRequest } from '../src/adapters/contracts.ts'
import { verifyEventChain, verifyEventProtocol } from '../src/adapters/event-integrity.ts'

const adapter = new MockAgentAdapter()
const request: AgentRunRequest = {
  runId: 'RUN-TEST-001',
  modelRef: 'mock-model://reasoning-medium',
  harnessRef: 'harness://control-plane-v0.1',
  sandboxRef: 'sandbox://run-test-001',
  sessionRef: 'session://run-test-001',
  intentVersionId: 'INT-142-v3',
  contextManifestId: 'CTX-142-v3',
  policyBundleId: 'policy-v12',
  evaluationSuiteIds: ['EVS-014'],
  executionMode: 'orchestrator_workers',
  workspaceRef: 'worktree://run-test-001',
  requestedCapabilities: ['repository:read', 'repository:write', 'shell:execute'],
  budget: { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100 },
}

const events: AgentRunEvent[] = []
for await (const event of adapter.run(request)) events.push(event)

assert.equal(events[0]?.type, 'run_started')
assert.equal(events.at(-1)?.type, 'run_completed')
assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1))
assert.equal(events.every((event) => event.runId === request.runId), true)
assert.equal(verifyEventChain(events), true)
assert.equal(verifyEventProtocol(events), true)

const runtime = events.find((event) => event.type === 'runtime_bound')
assert.ok(runtime && runtime.sessionRef === request.sessionRef && runtime.appendOnlyLog)
const sandboxAttestation = events.find((event) => event.type === 'sandbox_attested')
assert.ok(sandboxAttestation && sandboxAttestation.status === 'verified' && sandboxAttestation.ephemeral)
assert.equal(sandboxAttestation.sandboxRef, request.sandboxRef)
assert.equal(sandboxAttestation.networkEgress, 'allowlist')
assert.equal(sandboxAttestation.secretMounts.length, 0)
assert.ok(events.findIndex((event) => event.type === 'runtime_bound') < events.findIndex((event) => event.type === 'sandbox_attested'))
assert.ok(events.findIndex((event) => event.type === 'sandbox_attested') < events.findIndex((event) => event.type === 'harness_profile_selected'))
const harnessSelection = events.find((event) => event.type === 'harness_profile_selected')
assert.ok(harnessSelection && harnessSelection.executionMode === request.executionMode)
assert.equal(harnessSelection.contextResetPolicy, 'phase_boundary_compaction')
assert.equal(harnessSelection.candidates.length, 3)
assert.equal(harnessSelection.candidates.find((candidate) => candidate.profileId === harnessSelection.profileId)?.passRate, 0.96)
assert.ok(events.findIndex((event) => event.type === 'harness_profile_selected') < events.findIndex((event) => event.type === 'plan_created'))
const workflow = events.find((event) => event.type === 'workflow_bound')
assert.ok(workflow && workflow.replayMode === 'event_history')
assert.equal(workflow.retryPolicy.maxAttempts, 3)
assert.ok(events.findIndex((event) => event.type === 'harness_profile_selected') < events.findIndex((event) => event.type === 'workflow_bound'))
assert.ok(events.findIndex((event) => event.type === 'workflow_bound') < events.findIndex((event) => event.type === 'roadmap_created'))
const policyBundle = events.find((event) => event.type === 'policy_bundle_bound')
assert.ok(policyBundle && policyBundle.bundleId === request.policyBundleId && policyBundle.bundleVersion === '12')
assert.equal(policyBundle.defaultDecision, 'deny')
assert.equal(policyBundle.ruleCount, policyBundle.ruleIds.length)
assert.ok(events.findIndex((event) => event.type === 'workflow_bound') < events.findIndex((event) => event.type === 'policy_bundle_bound'))
assert.ok(events.findIndex((event) => event.type === 'policy_bundle_bound') < events.findIndex((event) => event.type === 'roadmap_created'))

const roadmap = events.find((event) => event.type === 'roadmap_created')
const sprint = events.find((event) => event.type === 'sprint_planned')
assert.ok(roadmap && sprint && sprint.roadmapId === roadmap.roadmapId)
assert.ok(events.findIndex((event) => event.type === 'roadmap_created') < events.findIndex((event) => event.type === 'sprint_planned'))
assert.ok(events.findIndex((event) => event.type === 'sprint_planned') < events.findIndex((event) => event.type === 'plan_created'))

const proposedContract = events.find((event) => event.type === 'work_contract_proposed')
const contractReview = events.find((event) => event.type === 'work_contract_reviewed')
assert.ok(proposedContract && proposedContract.criteria.length === 3)
assert.equal(proposedContract.sprintId, sprint.sprintId)
assert.ok(contractReview && contractReview.decision === 'accepted')
assert.equal(contractReview.contractId, proposedContract.contractId)
assert.equal(contractReview.contractDigest, proposedContract.contractDigest)
assert.notEqual(contractReview.evaluatorRef, contractReview.generatorRef, 'the generator must not self-approve its work contract')
assert.ok(events.findIndex((event) => event.type === 'work_contract_reviewed') < events.findIndex((event) => event.type === 'context_scope_created'), 'the work contract must be accepted before scoped execution begins')

const contextScopes = events.filter((event) => event.type === 'context_scope_created')
assert.equal(contextScopes.length, 3)
assert.deepEqual(contextScopes.map((event) => event.type === 'context_scope_created' ? event.worker : null), ['Code Worker', 'Test Worker', 'Docs Worker'])
assert.ok(events.findLastIndex((event) => event.type === 'context_scope_created') < events.findIndex((event) => event.type === 'context_consumed'))

const contextNotes = events.filter((event) => event.type === 'context_note_written')
assert.deepEqual(contextNotes.map((event) => event.type === 'context_note_written' ? event.category : null), ['plan', 'finding', 'decision'])

const denied = events.find((event) => event.type === 'policy_decided' && event.decision.decision === 'deny')
assert.ok(denied, 'undeclared sensitive context must be denied')
const testAttempts = events.filter((event) => event.type === 'activity_attempt_started' && event.activityType === 'test.execute')
assert.deepEqual(testAttempts.map((event) => event.attempt), [1, 2])
assert.equal(new Set(testAttempts.map((event) => event.idempotencyKey)).size, 1, 'retries must preserve the activity idempotency key')
const retry = events.find((event) => event.type === 'activity_retry_scheduled')
assert.ok(retry && retry.failedAttempt === 1 && retry.nextAttempt === 2 && retry.backoffSeconds === 2)
assert.ok(events.some((event) => event.type === 'activity_failed' && event.activityId.endsWith('test-suite') && event.retryable))
assert.ok(events.some((event) => event.type === 'activity_completed' && event.activityId.endsWith('test-suite') && event.attempt === 2))
assert.equal(events.some((event) => event.type === 'activity_retry_scheduled' && event.activityId.endsWith('read-secret')), false, 'policy denials must remain non-retryable')
assert.equal(events.filter((event) => event.type === 'policy_decided').every((event) => event.decision.policyVersion === policyBundle.bundleVersion), true)

const invalidRetryEvents = events.map((event) => event.type === 'activity_retry_scheduled' ? { ...event, nextAttempt: 4 } : event) as AgentRunEvent[]
assert.equal(verifyEventProtocol(invalidRetryEvents), false, 'retry schedules must respect consecutive attempts and max-attempt policy')
const invalidPolicyEvents = events.map((event) => event.type === 'policy_decided' ? { ...event, decision: { ...event.decision, policyVersion: '11' } } : event) as AgentRunEvent[]
assert.equal(verifyEventProtocol(invalidPolicyEvents), false, 'policy decisions must bind the active bundle version')
const invalidExperimentEvents = events.map((event) => event.type === 'evaluation_experiment_bound' ? { ...event, trialCount: event.trialCount + 1 } : event) as AgentRunEvent[]
assert.equal(verifyEventProtocol(invalidExperimentEvents), false, 'evaluation results must match the bound experiment and canonical digest')
assert.ok(events.some((event) => event.type === 'context_requested' && !event.declared), 'undeclared context request must be observable')
assert.equal(events.some((event) => event.type === 'context_consumed' && !event.declared), false, 'denied context must never be recorded as consumed')
assert.ok(events.some((event) => event.type === 'context_requested' && event.trust === 'untrusted'), 'external content trust must be observable')
assert.equal(events.some((event) => event.type === 'context_consumed' && event.trust === 'untrusted'), false, 'untrusted external content must be isolated before consumption')
assert.ok(events.some((event) => event.type === 'policy_decided' && event.decision.policyId === 'POL-EXTERNAL-CONTENT-ISOLATE'))

const artifacts = events.filter((event) => event.type === 'artifact_created')
assert.deepEqual(artifacts.map((event) => event.type === 'artifact_created' ? event.artifactType : null), ['patch', 'test', 'documentation'])

const ciEvidence = events.filter((event) => event.type === 'ci_evidence_ingested')
assert.deepEqual(ciEvidence.map((event) => event.type === 'ci_evidence_ingested' ? event.kind : null), ['junit', 'sarif', 'coverage'])
assert.equal(ciEvidence.find((event) => event.type === 'ci_evidence_ingested' && event.kind === 'junit')?.status, 'failed')
assert.equal(ciEvidence.find((event) => event.type === 'ci_evidence_ingested' && event.kind === 'coverage')?.summary.lineCoverage, 92.5)

const checkpointIndex = events.findIndex((event) => event.type === 'checkpoint_saved')
const evaluationIndex = events.findIndex((event) => event.type === 'evaluation_completed')
const compactionIndex = events.findIndex((event) => event.type === 'context_compacted')
const resetDecisionIndex = events.findIndex((event) => event.type === 'context_reset_decided')
const usageIndex = events.findIndex((event) => event.type === 'usage_reported')
assert.ok(checkpointIndex > events.findLastIndex((event) => event.type === 'artifact_created'))
assert.ok(checkpointIndex > events.findLastIndex((event) => event.type === 'ci_evidence_ingested'))
assert.ok(compactionIndex > events.findLastIndex((event) => event.type === 'context_note_written'))
assert.ok(usageIndex < compactionIndex, 'budget guard must request checkpoint before compaction and checkpoint save')
assert.ok(resetDecisionIndex < compactionIndex, 'context reset policy must decide before compaction executes')
assert.ok(compactionIndex < checkpointIndex, 'context must be compacted before the recoverable evaluation checkpoint')
assert.ok(checkpointIndex < evaluationIndex, 'checkpoint must make the pre-evaluation state recoverable')

const compaction = events.find((event) => event.type === 'context_compacted')
assert.ok(compaction && compaction.afterTokens < compaction.beforeTokens && compaction.preservedNoteRefs.length === 3)
const resetDecision = events.find((event) => event.type === 'context_reset_decided')
assert.ok(resetDecision && resetDecision.action === 'compact' && resetDecision.trigger === 'token_pressure')
const usage = events.find((event) => event.type === 'usage_reported')
assert.ok(usage && usage.decision.status === 'warning' && usage.decision.action === 'checkpoint')

const evaluation = events.find((event) => event.type === 'evaluation_completed')
assert.ok(evaluation && evaluation.failed === 2)
const experiment = events.find((event) => event.type === 'evaluation_experiment_bound')
assert.ok(experiment && experiment.suiteId === evaluation.suiteId)
assert.equal(experiment.trialCount, evaluation.passed + evaluation.failed + evaluation.unknown)
assert.equal(experiment.datasetVersion, '2026-09-22.3')
assert.equal(experiment.graderRefs.length, 3)
assert.ok(events.findIndex((event) => event.type === 'checkpoint_saved') < events.findIndex((event) => event.type === 'evaluation_experiment_bound'))
assert.ok(events.findIndex((event) => event.type === 'evaluation_experiment_bound') < events.findIndex((event) => event.type === 'evaluation_completed'))
const diagnosis = events.find((event) => event.type === 'evaluation_diagnosed')
assert.ok(diagnosis && diagnosis.transcriptReviewed && diagnosis.failures.length === evaluation.failed)
assert.equal(diagnosis.environment.imageDigest, experiment.environmentDigest)
assert.deepEqual(diagnosis.failures.map((failure) => failure.category), ['agent', 'infrastructure'])
assert.ok(diagnosis.environment.cleanStart && diagnosis.environment.sharedStateDetected)
assert.ok(events.findIndex((event) => event.type === 'evaluation_completed') < events.findIndex((event) => event.type === 'evaluation_diagnosed'))
const roadmapUpdate = events.find((event) => event.type === 'roadmap_updated')
assert.ok(roadmapUpdate && roadmapUpdate.previousRoadmapDigest === roadmap.roadmapDigest)
assert.ok(roadmapUpdate.feedbackRefs.length >= diagnosis.failures.length)
assert.ok(events.findIndex((event) => event.type === 'evaluation_diagnosed') < events.findIndex((event) => event.type === 'roadmap_updated'))
assert.ok(events.findIndex((event) => event.type === 'roadmap_updated') < events.findIndex((event) => event.type === 'run_completed'))

const resumedEvents: AgentRunEvent[] = []
for await (const event of adapter.run({
  ...request,
  runId: 'RUN-TEST-RESUME',
  sandboxRef: 'sandbox://run-test-resume',
  resumeFrom: { parentRunId: request.runId, checkpointRef: `${request.sessionRef}/checkpoints/pre-eval`, workspaceDigest: 'fnv1a:checkpoint' },
})) resumedEvents.push(event)

assert.ok(resumedEvents.some((event) => event.type === 'checkpoint_restored'))
assert.ok(resumedEvents.some((event) => event.type === 'work_contract_reviewed' && event.decision === 'accepted'))
assert.equal(verifyEventChain(resumedEvents), true)
assert.equal(verifyEventProtocol(resumedEvents), true)
assert.equal(resumedEvents.some((event) => event.type === 'tool_requested'), false, 'resume must not replay completed implementation tools')
assert.equal(resumedEvents.some((event) => event.type === 'artifact_created'), false, 'resume must reuse checkpoint artifacts')
assert.equal(resumedEvents.find((event) => event.type === 'evaluation_completed')?.failed, 1)
assert.equal(resumedEvents.find((event) => event.type === 'evaluation_diagnosed')?.failures[0]?.category, 'agent')
assert.ok(resumedEvents.some((event) => event.type === 'roadmap_updated'))

console.log('adapter smoke tests passed')
