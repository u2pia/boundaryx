import assert from 'node:assert/strict'
import { createInitialState, roleAllows, workbenchReducer } from '../src/store-model.ts'
import type { AgentRunEvent, AttestationVerification, AutonomyDecisionInput, EvidenceAttestation, TelemetryExportBundle, TraceProjection } from '../src/adapters/contracts.ts'
import { computeEventDigest, digestValue } from '../src/adapters/event-integrity.ts'
import { LocalTraceProvider } from '../src/adapters/local-trace-provider.ts'
import { LocalOtlpFileExportProvider } from '../src/adapters/local-otlp-file-export-provider.ts'
import { LocalAutonomyDecisionProvider } from '../src/adapters/local-autonomy-provider.ts'

function signedEvent<T extends AgentRunEvent>(event: Omit<T, 'previousEventDigest' | 'eventDigest'>, previousEventDigest = 'genesis') {
  const unsignedEvent = { ...event, previousEventDigest } as Omit<T, 'eventDigest'>
  return { ...unsignedEvent, eventDigest: computeEventDigest(unsignedEvent as Omit<AgentRunEvent, 'eventDigest'>) } as T
}

function resignTraceProjection(projection: TraceProjection) {
  const { projectionDigest: _projectionDigest, ...unsigned } = projection
  return { ...unsigned, projectionDigest: digestValue(JSON.stringify(unsigned)) }
}

function resignTelemetryExport(bundle: TelemetryExportBundle) {
  const { exportDigest: _exportDigest, ...unsigned } = bundle
  return { ...unsigned, exportDigest: digestValue(JSON.stringify(unsigned)) }
}

const now = new Date('2026-09-22T04:30:00Z')
let state = createInitialState(now)

assert.equal(state.releaseApproved, false)
assert.equal(state.notifications.some((notification) => notification.id === 'notice-release'), true)

state = workbenchReducer(state, { type: 'approve_release', targetId: 'RC-TEST-1' }, now)
assert.equal(state.releaseApproved, true)
assert.equal(state.releaseApprovalTarget, 'RC-TEST-1')
assert.equal(state.releaseApprovedBy, 'github:wangzhen')
assert.equal(state.notifications.some((notification) => notification.id === 'notice-release'), false)
assert.equal(state.events[0]?.kind, 'approval')

const deployment = { releaseCandidateId: 'RC-TEST-1', environment: 'production' as const, headSha: 'local-approved', evidenceUri: 'local://evidence/rc-test-1.json', approvedBy: 'github:wangzhen', deploymentId: 'DEP-TEST0001', providerId: 'mock-deployment@0.1', status: 'succeeded' as const, startedAt: now.toISOString(), completedAt: now.toISOString(), artifactDigest: 'fnv1a:deploy', rollbackRef: 'rollback://rc-test-1/local-a' }
state = workbenchReducer(state, { type: 'record_deployment', deployment }, now)
assert.equal(state.deployments[0]?.deploymentId, 'DEP-TEST0001')
assert.equal(state.events[0]?.kind, 'deployment')
const duplicateDeploymentState = workbenchReducer(state, { type: 'record_deployment', deployment }, now)
assert.equal(duplicateDeploymentState, state, 'deployment projection must be idempotent')
const unapprovedDeploymentState = workbenchReducer(createInitialState(now), { type: 'record_deployment', deployment }, now)
assert.equal(unapprovedDeploymentState.deployments.length, 0, 'production deployment requires a matching release authorization')
const rollback = { deploymentId: deployment.deploymentId, releaseCandidateId: deployment.releaseCandidateId, rollbackRef: deployment.rollbackRef, requestedBy: 'github:wangzhen', reason: 'error rate threshold exceeded', rollbackId: 'RBK-TEST0001', providerId: deployment.providerId, status: 'succeeded' as const, completedAt: now.toISOString(), restoredArtifactDigest: 'fnv1a:rollback' }
state = workbenchReducer(state, { type: 'record_rollback', rollback }, now)
assert.equal(state.rollbacks[0]?.rollbackId, 'RBK-TEST0001')
const duplicateRollbackState = workbenchReducer(state, { type: 'record_rollback', rollback }, now)
assert.equal(duplicateRollbackState, state, 'rollback projection must be idempotent')
const unauthorizedRollback = { ...rollback, rollbackId: 'RBK-REVIEWER', requestedBy: 'github:mia-chen' }
assert.equal(workbenchReducer(state, { type: 'record_rollback', rollback: unauthorizedRollback }, now), state, 'reviewer must not execute production rollback')

assert.equal(roleAllows('developer', 'approve_run'), false)
assert.equal(roleAllows('reviewer', 'approve_run'), true)
assert.equal(roleAllows('reviewer', 'review_change'), true)
assert.equal(roleAllows('reviewer', 'approve_release'), false)
assert.equal(roleAllows('maintainer', 'export_telemetry'), true)
assert.equal(roleAllows('developer', 'export_telemetry'), false)
const autonomyInput: AutonomyDecisionInput = { candidateId: 'RC-STORE-AUTO', programPhase: 'human_approval', riskTier: 'low', repositoryOnly: true, sandboxVerified: true, sessionIntegrityValid: true, evidenceVerified: true, evaluationFailed: 0, ciFailed: 0, unresolvedPolicyDenials: 0, externalEgress: false, destructiveChange: false, productionImpact: false, identityAnchored: false, humanReviewApproved: false }
const autonomyDecision = new LocalAutonomyDecisionProvider().evaluate(autonomyInput)
state = workbenchReducer(state, { type: 'record_autonomy_decision', input: autonomyInput, decision: autonomyDecision }, now)
assert.equal(state.autonomyDecisions[0]?.decision.decision, 'human_review')
assert.equal(state.events[0]?.kind, 'autonomy')
const autonomyRecordedState = state
assert.equal(workbenchReducer(state, { type: 'record_autonomy_decision', input: autonomyInput, decision: autonomyDecision }, now), autonomyRecordedState, 'autonomy decision records must be idempotent')
const forgedAutonomyDecision = { ...autonomyDecision, decision: 'auto_merge_eligible' as const }
assert.equal(workbenchReducer(state, { type: 'record_autonomy_decision', input: autonomyInput, decision: forgedAutonomyDecision }, now), autonomyRecordedState, 'reducer must recompute autonomy decisions instead of trusting the UI')
let roleState = createInitialState(now)
roleState = workbenchReducer(roleState, { type: 'switch_actor', actorId: 'jason-liu' }, now)
const developerReleaseState = workbenchReducer(roleState, { type: 'approve_release', targetId: 'RC-DEVELOPER' }, now)
assert.equal(developerReleaseState, roleState, 'developer must not approve production release')
roleState = workbenchReducer(roleState, { type: 'switch_actor', actorId: 'mia-chen' }, now)
const reviewerReleaseState = workbenchReducer(roleState, { type: 'approve_release', targetId: 'RC-REVIEWER' }, now)
assert.equal(reviewerReleaseState, roleState, 'reviewer must not approve production release')

const approvedState = workbenchReducer(state, { type: 'approve_release', targetId: 'RC-TEST-1' }, now)
assert.equal(approvedState, state, 'release approval must be idempotent')

state = workbenchReducer(state, { type: 'approve_release', targetId: 'RC-TEST-2' }, now)
assert.equal(state.releaseApprovalTarget, 'RC-TEST-2', 'approval must be rebound explicitly for a new candidate')

state = workbenchReducer(state, { type: 'convert_signal', signalId: 'SIG-204', title: '修复 OIDC 回调超时', outputType: 'intent' }, now)
assert.equal(state.convertedSignals.length, 1)
assert.equal(state.derivedIntents[0]?.source, 'SIG-204')
assert.equal(state.derivedIntents[0]?.id, 'INT-143')

const convertedState = workbenchReducer(state, { type: 'convert_signal', signalId: 'SIG-204', title: '重复转换', outputType: 'intent' }, now)
assert.equal(convertedState, state, 'signal conversion must be idempotent')

state = workbenchReducer(state, { type: 'convert_signal', signalId: 'SIG-198', title: '符号链接回归任务', outputType: 'regression' }, now)
assert.equal(state.convertedSignals[1]?.outputId, 'REG-144')
assert.equal(state.regressionAssets[0]?.outputId, 'REG-144')
assert.equal(state.derivedIntents.length, 1, 'regression output must not create an Intent')
assert.equal(state.notifications[0]?.page, '评估')

state = workbenchReducer(state, { type: 'convert_signal', signalId: 'TRACE-RUN-1-SPAN-1', title: '失败 Trace 回归', outputType: 'regression', sourceRef: { kind: 'trace_span', runId: 'RUN-1', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), projectionDigest: 'fnv1a:trace', eventDigest: 'fnv1a:event' } }, now)
assert.equal(state.convertedSignals.at(-1)?.sourceRef?.traceId, 'a'.repeat(32))
assert.equal(state.regressionAssets.at(-1)?.sourceRef?.spanId, 'b'.repeat(16))
const duplicateTraceRegression = workbenchReducer(state, { type: 'convert_signal', signalId: 'TRACE-RUN-1-SPAN-1', title: '重复 Trace 回归', outputType: 'regression', sourceRef: { kind: 'trace_span', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) } }, now)
assert.equal(duplicateTraceRegression, state, 'trace-to-regression conversion must be idempotent')

state = workbenchReducer(state, { type: 'advance_regression_asset', outputId: 'REG-144' }, now)
assert.equal(state.regressionAssets[0]?.fixtureReady, true)
state = workbenchReducer(state, { type: 'advance_regression_asset', outputId: 'REG-144' }, now)
assert.equal(state.regressionAssets[0]?.graderReady, true)
state = workbenchReducer(state, { type: 'advance_regression_asset', outputId: 'REG-144' }, now)
assert.equal(state.regressionAssets[0]?.referenceReady, true)
state = workbenchReducer(state, { type: 'run_regression_trials', outputId: 'REG-144' }, now)
assert.equal(state.regressionAssets[0]?.trialsRun, 3)
assert.equal(state.regressionAssets[0]?.baselineCaptured, true)
assert.deepEqual(state.regressionAssets[0]?.trials.map((trial) => trial.result), ['passed', 'failed', 'passed'])
assert.equal(state.regressionAssets[0]?.passAtK, 100)
assert.equal(state.regressionAssets[0]?.passPowerK, 0)
state = workbenchReducer(state, { type: 'run_regression_trials', outputId: 'REG-144' }, now)
assert.equal(state.regressionAssets[0]?.trialsRun, 6)
assert.deepEqual(state.regressionAssets[0]?.trials.slice(-3).map((trial) => trial.result), ['passed', 'passed', 'passed'])
assert.equal(state.regressionAssets[0]?.passPowerK, 100)

state = workbenchReducer(state, { type: 'reset' }, now)
assert.equal(state.releaseApproved, false)
assert.equal(state.convertedSignals.length, 0)
assert.equal(state.regressionAssets.length, 0)

state = workbenchReducer(state, { type: 'import_github_issue', issue: { externalId: '155', intentId: 'INT-145', title: '同步 GitLab Merge Request 状态', body: 'MR projection', state: 'open', assignees: ['jian-li'], projectionWritten: true } }, now)
assert.equal(state.githubImports[0]?.intentId, 'INT-145')
assert.equal(state.derivedIntents[0]?.source, 'github:#155')
assert.equal(state.derivedIntents[0]?.owner, 'JL')
const importedState = workbenchReducer(state, { type: 'import_github_issue', issue: { externalId: '155', intentId: 'INT-146', title: '重复导入', body: '', state: 'open', assignees: [], projectionWritten: true } }, now)
assert.equal(importedState, state, 'GitHub import must be idempotent by external issue id')

const pullRequestProjection = { externalId: '428', title: 'feat(auth): add enterprise OIDC login', state: 'open' as const, author: 'mia-chen', baseRef: 'main', headRef: 'feat/enterprise-oidc', headSha: '8f3a2c1d90a7', changedFiles: 8, additions: 426, deletions: 118, reviewDecision: 'approved' as const, checks: [{ name: 'tests', status: 'completed' as const, conclusion: 'success' as const, detailsUrl: 'mock://checks/tests' }], linkedRunId: 'RUN-001', evidenceUri: 'local://evidence/run-001.json', projectionWritten: true }
state = workbenchReducer(state, { type: 'import_github_pull_request', pullRequest: pullRequestProjection }, now)
assert.equal(state.githubPullRequests[0]?.externalId, '428')
assert.equal(state.githubPullRequests[0]?.checks[0]?.conclusion, 'success')
const duplicatePullRequestState = workbenchReducer(state, { type: 'import_github_pull_request', pullRequest: pullRequestProjection }, now)
assert.equal(duplicatePullRequestState, state, 'GitHub PR projection must be idempotent by PR and head SHA')

const blockedPullRequestProjection = { ...pullRequestProjection, externalId: '512', headSha: '61ac9e3b172f', reviewDecision: 'changes_requested' as const, checks: [{ name: 'tests', status: 'completed' as const, conclusion: 'failure' as const, detailsUrl: 'mock://checks/tests' }] }
state = workbenchReducer(state, { type: 'import_github_pull_request', pullRequest: blockedPullRequestProjection }, now)
const blockedReleaseState = workbenchReducer(state, { type: 'approve_release', targetId: 'RC-BLOCKED' }, now)
assert.equal(blockedReleaseState, state, 'failed GitHub review or checks must block release approval')

const runStarted = signedEvent<Extract<AgentRunEvent, { type: 'run_started' }>>({ type: 'run_started', runId: 'RUN-001', sequence: 1, occurredAt: now.toISOString(), adapterId: 'mock', requestDigest: 'sha256:test' })
state = workbenchReducer(state, { type: 'append_run_event', label: '测试运行', event: runStarted }, now)
assert.equal(state.liveRun?.progress, 5)
assert.equal(state.liveRun?.events.length, 1)

const runCompleted = signedEvent<Extract<AgentRunEvent, { type: 'run_completed' }>>({ type: 'run_completed', runId: 'RUN-001', sequence: 2, occurredAt: now.toISOString(), status: 'succeeded', outputDigest: 'sha256:done' }, runStarted.eventDigest)
state = workbenchReducer(state, { type: 'append_run_event', label: '测试运行', event: runCompleted }, now)
assert.equal(state.liveRun?.progress, 100)
assert.equal(state.liveRun?.status, '已完成')
state = workbenchReducer(state, { type: 'finalize_run_evidence', runId: 'RUN-001', packageUri: 'memory://evidence/run-001.json', packageDigest: 'fnv1a:package' }, now)
assert.equal(state.liveRun?.evidencePackage?.uri, 'memory://evidence/run-001.json')

const evaluationFailed = signedEvent<Extract<AgentRunEvent, { type: 'evaluation_completed' }>>({ type: 'evaluation_completed', runId: 'RUN-002', sequence: 1, occurredAt: now.toISOString(), suiteId: 'EVS-FAIL', passed: 40, failed: 2, unknown: 0 })
state = workbenchReducer(state, { type: 'append_run_event', label: '评估失败运行', event: evaluationFailed }, now)
const gatedRunCompleted = signedEvent<Extract<AgentRunEvent, { type: 'run_completed' }>>({ type: 'run_completed', runId: 'RUN-002', sequence: 2, occurredAt: now.toISOString(), status: 'succeeded', outputDigest: 'sha256:gated' }, evaluationFailed.eventDigest)
state = workbenchReducer(state, { type: 'append_run_event', label: '评估失败运行', event: gatedRunCompleted }, now)
assert.equal(state.liveRun?.reviewRequired, true)
assert.equal(state.liveRun?.status, '等待人工评审')

state = workbenchReducer(state, { type: 'switch_actor', actorId: 'mia-chen' }, now)
state = workbenchReducer(state, { type: 'approve_run_review', runId: 'RUN-002' }, now)
assert.equal(state.liveRun?.approved, true)
assert.equal(state.liveRun?.runGateApprovedBy, 'github:mia-chen')
assert.equal(state.liveRun?.status, '已批准进入评审')
assert.equal(state.events[0]?.kind, 'approval')

const approvedRunState = workbenchReducer(state, { type: 'approve_run_review', runId: 'RUN-002' }, now)
assert.equal(approvedRunState, state, 'run approval must be idempotent')

state = workbenchReducer(state, { type: 'decide_run_review', runId: 'RUN-002', decision: 'changes_requested' }, now)
assert.equal(state.liveRun?.reviewDecision, 'changes_requested')
assert.equal(state.liveRun?.reviewDecisionBy, 'github:mia-chen')
assert.equal(state.liveRun?.status, '评审要求修改')
assert.equal(state.events[0]?.kind, 'review')

state = workbenchReducer(state, { type: 'decide_run_review', runId: 'RUN-002', decision: 'approved' }, now)
assert.equal(state.liveRun?.reviewDecision, 'approved')
assert.equal(state.liveRun?.reviewDecisionBy, 'github:mia-chen')
assert.equal(state.liveRun?.status, '变更已批准')
assert.equal(state.notifications[0]?.page, '发布')
state = workbenchReducer(state, { type: 'switch_actor', actorId: 'wangzhen' }, now)
assert.equal(state.liveRun?.runGateApprovedBy, 'github:mia-chen', 'switching actor must not rewrite historical run approval identity')
assert.equal(state.liveRun?.reviewDecisionBy, 'github:mia-chen', 'switching actor must not rewrite historical review identity')

const tamperedEvent = signedEvent<Extract<AgentRunEvent, { type: 'run_started' }>>({ type: 'run_started', runId: 'RUN-003', sequence: 2, occurredAt: now.toISOString(), adapterId: 'tampered', requestDigest: 'sha256:bad' })
state = workbenchReducer(state, { type: 'append_run_event', label: '篡改运行', event: tamperedEvent }, now)
assert.equal(state.liveRun?.integrityValid, false)
assert.equal(state.liveRun?.status, '事件完整性失败')
const tamperedApprovalState = workbenchReducer(state, { type: 'approve_run_review', runId: 'RUN-003' }, now)
assert.equal(tamperedApprovalState, state, 'invalid event chain must block human gate approval')

const ciFailure = signedEvent<Extract<AgentRunEvent, { type: 'ci_evidence_ingested' }>>({ type: 'ci_evidence_ingested', runId: 'RUN-CI-FAIL', sequence: 1, occurredAt: now.toISOString(), kind: 'junit', sourceUri: 'artifact://junit.xml', tool: 'vitest', status: 'failed', summary: { tests: 10, passed: 9, failed: 1 }, digest: 'fnv1a:junit' })
state = workbenchReducer(state, { type: 'append_run_event', label: 'CI 失败运行', event: ciFailure }, now)
assert.equal(state.liveRun?.reviewRequired, true, 'failed CI evidence must require review')

const budgetExceeded = signedEvent<Extract<AgentRunEvent, { type: 'usage_reported' }>>({ type: 'usage_reported', runId: 'RUN-BUDGET-FAIL', sequence: 1, occurredAt: now.toISOString(), usage: { inputTokens: 82_000, outputTokens: 4_000, toolCalls: 110, elapsedSeconds: 1_900, estimatedCostUsd: 9 }, budget: { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100, maxCostUsd: 8 }, decision: { status: 'exceeded', action: 'terminate', reasons: ['tokens exceeded'] } })
state = workbenchReducer(state, { type: 'append_run_event', label: '预算超限运行', event: budgetExceeded }, now)
assert.equal(state.liveRun?.reviewRequired, true, 'exceeded runtime budget must require review')

const contractContent = { contractId: 'CTR-FAIL', sprintId: 'SPRINT-FAIL', intentVersionId: 'INT-142:v1', generatorRef: 'harness://generator', objective: '验证工作契约门禁', criteria: [{ id: 'AC-1', statement: '契约必须由独立评估者确认', verifier: 'deterministic' as const, criticality: 'critical' as const }], nonGoals: [] as string[] }
const contractDigest = digestValue(JSON.stringify(contractContent))
const proposedContract = signedEvent<Extract<AgentRunEvent, { type: 'work_contract_proposed' }>>({ type: 'work_contract_proposed', runId: 'RUN-CONTRACT-FAIL', sequence: 1, occurredAt: now.toISOString(), ...contractContent, contractDigest })
state = workbenchReducer(state, { type: 'append_run_event', label: '契约失败运行', event: proposedContract }, now)
const selfReviewedContract = signedEvent<Extract<AgentRunEvent, { type: 'work_contract_reviewed' }>>({ type: 'work_contract_reviewed', runId: 'RUN-CONTRACT-FAIL', sequence: 2, occurredAt: now.toISOString(), contractId: 'CTR-FAIL', contractDigest, generatorRef: 'harness://generator', evaluatorRef: 'harness://generator', decision: 'accepted', findings: ['生成者尝试自我批准'] }, proposedContract.eventDigest)
state = workbenchReducer(state, { type: 'append_run_event', label: '契约失败运行', event: selfReviewedContract }, now)
assert.equal(state.liveRun?.reviewRequired, true, 'self-approved work contract must require human review')
assert.equal(state.liveRun?.integrityValid, false)
assert.equal(state.liveRun?.status, '运行协议失败')

let evidenceState = createInitialState(now)
const evidenceEvaluation = signedEvent<Extract<AgentRunEvent, { type: 'evaluation_completed' }>>({ type: 'evaluation_completed', runId: 'RUN-EVIDENCE-GATE', sequence: 1, occurredAt: now.toISOString(), suiteId: 'EVS-GATE', passed: 9, failed: 1, unknown: 0 })
evidenceState = workbenchReducer(evidenceState, { type: 'append_run_event', label: 'Evidence 门禁', event: evidenceEvaluation }, now)
const evidenceCompleted = signedEvent<Extract<AgentRunEvent, { type: 'run_completed' }>>({ type: 'run_completed', runId: 'RUN-EVIDENCE-GATE', sequence: 2, occurredAt: now.toISOString(), status: 'succeeded', outputDigest: 'fnv1a:output' }, evidenceEvaluation.eventDigest)
evidenceState = workbenchReducer(evidenceState, { type: 'append_run_event', label: 'Evidence 门禁', event: evidenceCompleted }, now)
const evidenceTrace = new LocalTraceProvider().project('RUN-EVIDENCE-GATE', evidenceState.liveRun!.events)
evidenceState = workbenchReducer(evidenceState, { type: 'record_run_trace', runId: 'RUN-EVIDENCE-GATE', projection: evidenceTrace }, now)
assert.equal(evidenceState.liveRun?.traceProjection?.document.traceId, evidenceTrace.traceId)
const telemetryBundle = new LocalOtlpFileExportProvider().prepare({ projection: evidenceTrace, serviceName: 'aperture-control-plane', environment: 'test' })
evidenceState = workbenchReducer(evidenceState, { type: 'record_telemetry_export', bundle: telemetryBundle }, now)
assert.equal(evidenceState.telemetryExports[0]?.exportDigest, telemetryBundle.exportDigest)
assert.equal(evidenceState.telemetryExports[0]?.exportedBy, 'github:wangzhen')
const telemetryRecordedState = evidenceState
assert.equal(workbenchReducer(evidenceState, { type: 'record_telemetry_export', bundle: telemetryBundle }, now), telemetryRecordedState, 'telemetry export audit must be idempotent')
const wrongRunBundle = structuredClone(telemetryBundle)
wrongRunBundle.runId = 'RUN-OTHER'
assert.equal(workbenchReducer(evidenceState, { type: 'record_telemetry_export', bundle: resignTelemetryExport(wrongRunBundle) }, now), telemetryRecordedState, 'telemetry export must bind the active run and resource attributes')
let developerTelemetryState = workbenchReducer(evidenceState, { type: 'switch_actor', actorId: 'jason-liu' }, now)
const developerBeforeExport = developerTelemetryState
developerTelemetryState = workbenchReducer(developerTelemetryState, { type: 'record_telemetry_export', bundle: { ...telemetryBundle, exportDigest: 'fnv1a:new-export' } }, now)
assert.equal(developerTelemetryState, developerBeforeExport, 'developer must not export telemetry bundles')
evidenceState = workbenchReducer(developerTelemetryState, { type: 'switch_actor', actorId: 'wangzhen' }, now)
const traceRecordedState = evidenceState
const wrongRunTrace = resignTraceProjection({ ...structuredClone(evidenceTrace), runId: 'RUN-OTHER' })
assert.equal(workbenchReducer(evidenceState, { type: 'record_run_trace', runId: 'RUN-EVIDENCE-GATE', projection: wrongRunTrace }, now), traceRecordedState, 'trace projection must bind the active run')
const wrongCountTrace = structuredClone(evidenceTrace)
wrongCountTrace.spans[0]!.attributes['aperture.event.count'] = 99
assert.equal(workbenchReducer(evidenceState, { type: 'record_run_trace', runId: 'RUN-EVIDENCE-GATE', projection: resignTraceProjection(wrongCountTrace) }, now), traceRecordedState, 'trace projection must bind the event count')
const wrongHeadTrace = structuredClone(evidenceTrace)
wrongHeadTrace.spans[0]!.attributes['aperture.chain.head'] = 'fnv1a:tampered'
assert.equal(workbenchReducer(evidenceState, { type: 'record_run_trace', runId: 'RUN-EVIDENCE-GATE', projection: resignTraceProjection(wrongHeadTrace) }, now), traceRecordedState, 'trace projection must bind the chain head')
const wrongDigestTrace = structuredClone(evidenceTrace)
wrongDigestTrace.projectionDigest = 'fnv1a:tampered'
assert.equal(workbenchReducer(evidenceState, { type: 'record_run_trace', runId: 'RUN-EVIDENCE-GATE', projection: wrongDigestTrace }, now), traceRecordedState, 'trace projection must reject a modified projection digest')
evidenceState = workbenchReducer(evidenceState, { type: 'finalize_run_evidence', runId: 'RUN-EVIDENCE-GATE', packageUri: 'local://evidence/run-evidence-gate.json', packageDigest: 'fnv1a:package', repositoryVerified: false }, now)
evidenceState = workbenchReducer(evidenceState, { type: 'approve_run_review', runId: 'RUN-EVIDENCE-GATE' }, now)
evidenceState = workbenchReducer(evidenceState, { type: 'decide_run_review', runId: 'RUN-EVIDENCE-GATE', decision: 'approved' }, now)
const unverifiedReleaseState = workbenchReducer(evidenceState, { type: 'approve_release', targetId: 'RC-UNVERIFIED' }, now)
assert.equal(unverifiedReleaseState, evidenceState, 'unverified evidence repository must block release approval')
evidenceState = workbenchReducer(evidenceState, { type: 'finalize_run_evidence', runId: 'RUN-EVIDENCE-GATE', packageUri: 'local://evidence/run-evidence-gate.json', packageDigest: 'fnv1a:package', repositoryVerified: true }, now)
const evidenceAttestation: EvidenceAttestation = {
  schemaVersion: 'aperture.attestation/v0.1',
  providerId: 'attestation://test',
  trustLevel: 'ephemeral_local',
  identity: 'local://ephemeral-key',
  keyId: 'sha256:test-key',
  signedAt: now.toISOString(),
  statement: {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'local://evidence/run-evidence-gate.json', digest: { sha256: 'a'.repeat(64) } }],
    predicateType: 'https://aperture.dev/attestation/evidence-package/v0.1',
    predicate: { runId: 'RUN-EVIDENCE-GATE', evidenceUri: 'local://evidence/run-evidence-gate.json', repositoryDigest: 'fnv1a:package', chainHead: evidenceCompleted.eventDigest, eventCount: 2 },
  },
  envelope: { payloadType: 'application/vnd.in-toto+json', payload: 'payload', signatures: [{ keyid: 'sha256:test-key', sig: 'signature' }] },
  publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
}
const validAttestationVerification: AttestationVerification = { valid: true, signatureValid: true, subjectDigestValid: true, payloadValid: true, identityAnchored: false, reasons: ['identity intentionally unanchored'] }
evidenceState = workbenchReducer(evidenceState, { type: 'record_run_attestation', runId: 'RUN-EVIDENCE-GATE', attestation: evidenceAttestation, verification: validAttestationVerification }, now)
assert.equal(evidenceState.liveRun?.attestation?.verification.valid, true)
assert.equal(evidenceState.liveRun?.attestation?.document.trustLevel, 'ephemeral_local')
const misboundAttestation = structuredClone(evidenceAttestation)
misboundAttestation.statement.predicate.eventCount = 3
evidenceState = workbenchReducer(evidenceState, { type: 'record_run_attestation', runId: 'RUN-EVIDENCE-GATE', attestation: misboundAttestation, verification: validAttestationVerification }, now)
assert.equal(evidenceState.liveRun?.attestation?.verification.valid, false, 'misbound statement must downgrade attestation verification')
evidenceState = workbenchReducer(evidenceState, { type: 'record_run_attestation', runId: 'RUN-EVIDENCE-GATE', attestation: evidenceAttestation, verification: validAttestationVerification }, now)
evidenceState = workbenchReducer(evidenceState, { type: 'approve_release', targetId: 'RC-VERIFIED' }, now)
assert.equal(evidenceState.releaseApprovalTarget, 'RC-VERIFIED')

let headState = createInitialState(now)
headState = workbenchReducer(headState, { type: 'import_github_pull_request', pullRequest: { ...pullRequestProjection, evidenceUri: 'local://evidence/run-001.json' } }, now)
headState = workbenchReducer(headState, { type: 'approve_release', targetId: 'RC-HEAD-1' }, now)
assert.equal(headState.releaseApproved, true)
headState = workbenchReducer(headState, { type: 'import_github_pull_request', pullRequest: { ...pullRequestProjection, headSha: '9b4d7e2f1130' } }, now)
assert.equal(headState.releaseApproved, false, 'new PR head must revoke the previous production authorization')

console.log('store smoke tests passed')
