import type { AgentAdapter, AgentRunEvent, AgentRunRequest, Capability } from './contracts'
import { LocalCiEvidenceAdapter } from './ci-evidence.ts'
import { computeEventDigest, digestValue } from './event-integrity.ts'
import { RuntimeBudgetGuard } from './runtime-budget.ts'
import { HarnessPolicy, type HarnessCandidate } from './harness-policy.ts'
import { LocalPolicyDecisionProvider } from './local-policy-provider.ts'
import { LocalEvaluationProvider } from './local-evaluation-provider.ts'

type AgentRunEventInput = {
  [EventType in AgentRunEvent['type']]: Omit<Extract<AgentRunEvent, { type: EventType }>, 'runId' | 'sequence' | 'occurredAt' | 'previousEventDigest' | 'eventDigest'>
}[AgentRunEvent['type']]

export class MockAgentAdapter implements AgentAdapter {
  readonly id = 'mock-agent@0.1'
  readonly supportedModes = ['prompt_chain', 'parallel', 'orchestrator_workers', 'evaluator_optimizer'] as const
  readonly supportedCapabilities: Capability[] = ['repository:read', 'repository:write', 'shell:execute', 'network:egress']

  async *run(request: AgentRunRequest, signal?: AbortSignal): AsyncIterable<AgentRunEvent> {
    const occurredAt = () => new Date().toISOString()
    let sequence = 1
    let previousEventDigest = 'genesis'
    const next = (event: AgentRunEventInput): AgentRunEvent => {
      const unsignedEvent = { ...event, runId: request.runId, sequence: sequence++, occurredAt: occurredAt(), previousEventDigest } as Omit<AgentRunEvent, 'eventDigest'>
      const eventDigest = computeEventDigest(unsignedEvent)
      previousEventDigest = eventDigest
      return { ...unsignedEvent, eventDigest } as AgentRunEvent
    }
    const ensureActive = () => {
      if (signal?.aborted) throw new DOMException('Run aborted', 'AbortError')
    }

    ensureActive()
    yield next({ type: 'run_started', adapterId: this.id, requestDigest: digestValue(JSON.stringify(request)) })
    yield next({ type: 'runtime_bound', modelRef: request.modelRef, harnessRef: request.harnessRef, sandboxRef: request.sandboxRef, sessionRef: request.sessionRef, appendOnlyLog: true })
    const sandboxAttestation = { sandboxRef: request.sandboxRef, attestorRef: 'attestor://local-sandbox-policy-v1', isolation: 'container' as const, workspaceRoot: request.workspaceRef, writablePaths: [request.workspaceRef], readonlyPaths: ['repo://baseline', 'policy://bundle/v12'], networkEgress: 'allowlist' as const, allowedHosts: ['api.github.com'], secretMounts: [] as string[], ephemeral: true, status: 'verified' as const }
    yield next({ type: 'sandbox_attested', ...sandboxAttestation, attestationDigest: digestValue(JSON.stringify(sandboxAttestation)) })
    const harnessCandidates: HarnessCandidate[] = [
      { profileId: 'single-session-v1', executionMode: 'prompt_chain', contextResetPolicy: 'continuous', requiresIndependentEvaluator: false, passRate: 0.78, p95DurationSeconds: 520, estimatedCostUsd: 2.1, evidenceRef: 'eval://harness-ablation/2026-09/single-session' },
      { profileId: 'evaluator-loop-v2', executionMode: 'evaluator_optimizer', contextResetPolicy: 'fresh_session_per_phase', requiresIndependentEvaluator: true, passRate: 0.93, p95DurationSeconds: 690, estimatedCostUsd: 4.8, evidenceRef: 'eval://harness-ablation/2026-09/evaluator-loop' },
      { profileId: 'orchestrator-workers-v3', executionMode: 'orchestrator_workers', contextResetPolicy: 'phase_boundary_compaction', requiresIndependentEvaluator: true, passRate: 0.96, p95DurationSeconds: 680, estimatedCostUsd: 5.42, evidenceRef: 'eval://harness-ablation/2026-09/orchestrator-workers' },
    ]
    const harnessPolicy = new HarnessPolicy()
    const harnessSelection = harnessPolicy.select({ modelRef: request.modelRef, maxCostUsd: request.budget.maxCostUsd ?? 8, requireIndependentEvaluator: true }, harnessCandidates)
    yield next({ type: 'harness_profile_selected', profileId: harnessSelection.selected.profileId, modelRef: request.modelRef, modelContextBehavior: harnessSelection.modelContextBehavior, executionMode: harnessSelection.selected.executionMode, contextResetPolicy: harnessSelection.selected.contextResetPolicy, evidenceRef: harnessSelection.selected.evidenceRef, candidateCount: harnessSelection.considered.length, candidates: harnessSelection.considered.map(({ profileId, executionMode, contextResetPolicy, passRate, p95DurationSeconds, estimatedCostUsd, evidenceRef }) => ({ profileId, executionMode, contextResetPolicy, passRate, p95DurationSeconds, estimatedCostUsd, evidenceRef })), selectionReason: harnessSelection.selectionReason })
    const workflowId = `workflow://${request.resumeFrom?.parentRunId ?? request.runId}`
    const workflowIdempotencyKey = `${request.intentVersionId}:${request.contextManifestId}`
    yield next({ type: 'workflow_bound', workflowId, providerRef: 'workflow://local-storage-v1', taskQueue: 'agent-runs', idempotencyKey: workflowIdempotencyKey, replayMode: request.resumeFrom ? 'checkpoint' : 'event_history', humanResume: 'approval_required', retryPolicy: { maxAttempts: 3, initialBackoffSeconds: 2, maxBackoffSeconds: 30, nonRetryableErrors: ['PolicyDenied', 'InvalidInput', 'PermissionDenied'] } })
    const policyProvider = new LocalPolicyDecisionProvider(request.policyBundleId)
    yield next({ type: 'policy_bundle_bound', ...policyProvider.describe() })
    const evaluationProvider = new LocalEvaluationProvider()
    const roadmapId = `${request.intentVersionId}:roadmap:v1`
    const roadmap = {
      roadmapId,
      intentVersionId: request.intentVersionId,
      plannerRef: `${request.harnessRef}/planner`,
      goal: '交付可审计的企业身份绑定变更，并形成可持续回归资产。',
      milestones: [
        { id: 'MS-1', title: '建立身份绑定安全边界', status: 'active' as const, dependsOn: [] },
        { id: 'MS-2', title: '验证冲突与撤销行为', status: 'planned' as const, dependsOn: ['MS-1'] },
        { id: 'MS-3', title: '形成发布与回归证据', status: 'planned' as const, dependsOn: ['MS-2'] },
      ],
    }
    const roadmapDigest = digestValue(JSON.stringify(roadmap))
    yield next({ type: 'roadmap_created', ...roadmap, roadmapDigest })
    const sprintId = `${request.runId}:sprint:1`
    yield next({ type: 'sprint_planned', sprintId, roadmapId, plannerRef: roadmap.plannerRef, objective: '完成身份绑定实现、边界测试、文档与独立评估。', milestoneIds: ['MS-1', 'MS-2'], taskIds: ['TASK-CODE-1', 'TASK-TEST-1', 'TASK-DOCS-1'], contextResetBoundary: 'after_evaluation' })
    yield next({ type: 'plan_created', steps: ['compile context', 'implement change', 'run tests', 'update docs', 'evaluate'] })
    const contractId = `${request.runId}:contract:v1`
    const generatorRef = `${request.harnessRef}/generator`
    const contract = {
      contractId,
      sprintId,
      intentVersionId: request.intentVersionId,
      generatorRef,
      objective: '实现身份绑定变更，并以测试、文档和策略证据证明验收标准。',
      criteria: [
        { id: 'AC-1', statement: '身份绑定变更通过确定性测试', verifier: 'deterministic' as const, criticality: 'critical' as const },
        { id: 'AC-2', statement: '未声明敏感上下文被预防性阻断', verifier: 'deterministic' as const, criticality: 'critical' as const },
        { id: 'AC-3', statement: '文档与实现同步更新', verifier: 'human' as const, criticality: 'required' as const },
      ],
      nonGoals: ['读取生产 Secrets', '执行生产部署'],
    }
    const contractDigest = digestValue(JSON.stringify(contract))
    yield next({ type: 'work_contract_proposed', ...contract, contractDigest })
    yield next({ type: 'work_contract_reviewed', contractId, contractDigest, generatorRef, evaluatorRef: `${request.harnessRef}/independent-evaluator`, decision: 'accepted', findings: ['验收标准可测试', '生成与评估职责已分离'] })
    yield next({ type: 'context_scope_created', scopeId: `${request.runId}:code`, worker: 'Code Worker', allowedSources: ['src/auth/**', 'docs/security/identity-binding.md'], maxTokens: 32_000 })
    yield next({ type: 'context_scope_created', scopeId: `${request.runId}:test`, worker: 'Test Worker', allowedSources: ['tests/auth/**', 'src/auth/public-api.ts'], maxTokens: 20_000 })
    yield next({ type: 'context_scope_created', scopeId: `${request.runId}:docs`, worker: 'Docs Worker', allowedSources: ['docs/**', 'CHANGELOG.md'], maxTokens: 12_000 })
    yield next({ type: 'context_note_written', noteRef: `${request.sessionRef}/notes/plan.md`, category: 'plan', contentDigest: digestValue('plan:compile-implement-test-docs-evaluate'), durable: true })

    if (request.resumeFrom) {
      yield next({ type: 'checkpoint_restored', checkpointRef: request.resumeFrom.checkpointRef, parentRunId: request.resumeFrom.parentRunId, workspaceDigest: request.resumeFrom.workspaceDigest })
      const usage = { inputTokens: 12_800, outputTokens: 2_100, toolCalls: 1, elapsedSeconds: 96, estimatedCostUsd: 0.84 }
      yield next({ type: 'usage_reported', usage, budget: request.budget, decision: new RuntimeBudgetGuard().evaluate(request.budget, usage) })
      const resumedExperiment = evaluationProvider.bind({ experimentId: `${request.runId}:experiment:resume`, suiteId: request.evaluationSuiteIds[0] ?? 'EVS-MOCK', datasetRef: 'dataset://enterprise-identity-regressions', datasetVersion: '2026-09-22.3', candidateRef: `${request.modelRef}+${harnessSelection.selected.profileId}`, traceRef: `${request.sessionRef}/transcript`, graderRefs: [{ graderId: 'grader://identity-invariants', version: '3', type: 'deterministic' }, { graderId: 'grader://security-policy', version: '2', type: 'deterministic' }, { graderId: 'grader://review-quality', version: '1', type: 'model' }], trialCount: 42, environmentDigest: digestValue('eval-image:resumed-clean') })
      yield next({ type: 'evaluation_experiment_bound', ...resumedExperiment })
      yield next({ type: 'evaluation_completed', suiteId: request.evaluationSuiteIds[0] ?? 'EVS-MOCK', passed: 41, failed: 1, unknown: 0 })
      yield next({ type: 'evaluation_diagnosed', suiteId: request.evaluationSuiteIds[0] ?? 'EVS-MOCK', transcriptReviewed: true, environment: { cleanStart: true, sharedStateDetected: false, imageDigest: digestValue('eval-image:resumed-clean') }, failures: [{ taskId: 'TASK-SSO-018', category: 'agent', confidence: 0.91, summary: '恢复后仍未处理跨租户身份冲突。', evidenceRefs: [`${request.sessionRef}/transcript`, 'workspace://junit.xml'] }] })
      const resumedRoadmapUpdate = { roadmapId, plannerRef: roadmap.plannerRef, basedOnRunId: request.runId, previousRoadmapDigest: roadmapDigest, milestoneUpdates: [{ id: 'MS-1', status: 'done' as const }, { id: 'MS-2', status: 'active' as const }], nextSprintObjective: '修复跨租户身份冲突并重新运行稳定性 Trials。', feedbackRefs: [`${request.sessionRef}/transcript`, 'eval://EVS-014/TASK-SSO-018'] }
      yield next({ type: 'roadmap_updated', ...resumedRoadmapUpdate, roadmapDigest: digestValue(JSON.stringify(resumedRoadmapUpdate)) })
      yield next({ type: 'run_completed', status: 'succeeded', outputDigest: digestValue(`${request.runId}:resumed`) })
      return
    }

    yield next({ type: 'context_consumed', source: 'src/auth/session.ts', declared: true, trust: 'trusted', sensitivity: 'internal', digest: digestValue('src/auth/session.ts') })
    yield next({ type: 'context_note_written', noteRef: `${request.sessionRef}/notes/findings.md`, category: 'finding', contentDigest: digestValue('finding:session-revocation-boundary'), durable: true })

    const sourceReadActivity = `${request.runId}:activity:read-session`
    const sourceReadKey = `${workflowIdempotencyKey}:read-session`
    yield next({ type: 'activity_attempt_started', activityId: sourceReadActivity, activityType: 'repository.read', attempt: 1, idempotencyKey: sourceReadKey, sideEffect: 'read', timeoutSeconds: 30 })
    yield next({ type: 'tool_requested', activityId: sourceReadActivity, attempt: 1, idempotencyKey: sourceReadKey, tool: 'read_file', capability: 'repository:read', inputDigest: digestValue('src/auth/session.ts') })
    yield next({ type: 'policy_decided', activityId: sourceReadActivity, attempt: 1, tool: 'read_file', decision: policyProvider.evaluate({ runId: request.runId, tool: 'read_file', capability: 'repository:read', resourceRef: 'src/auth/session.ts', declared: true, trust: 'trusted', sensitivity: 'internal' }) })
    yield next({ type: 'activity_completed', activityId: sourceReadActivity, attempt: 1, outputDigest: digestValue('src/auth/session.ts:content') })

    yield next({ type: 'context_requested', source: 'config/oauth.internal.yml', declared: false, trust: 'trusted', sensitivity: 'sensitive', digest: digestValue('config/oauth.internal.yml') })
    const secretReadActivity = `${request.runId}:activity:read-secret`
    const secretReadKey = `${workflowIdempotencyKey}:read-secret`
    yield next({ type: 'activity_attempt_started', activityId: secretReadActivity, activityType: 'secret.read', attempt: 1, idempotencyKey: secretReadKey, sideEffect: 'read', timeoutSeconds: 15 })
    yield next({ type: 'tool_requested', activityId: secretReadActivity, attempt: 1, idempotencyKey: secretReadKey, tool: 'read_file', capability: 'secrets:read', inputDigest: digestValue('config/oauth.internal.yml') })
    yield next({ type: 'policy_decided', activityId: secretReadActivity, attempt: 1, tool: 'read_file', decision: policyProvider.evaluate({ runId: request.runId, tool: 'read_file', capability: 'secrets:read', resourceRef: 'config/oauth.internal.yml', declared: false, trust: 'trusted', sensitivity: 'sensitive' }) })
    yield next({ type: 'activity_failed', activityId: secretReadActivity, attempt: 1, errorType: 'PolicyDenied', retryable: false, errorDigest: digestValue('policy-denied:secrets-read') })

    yield next({ type: 'context_requested', source: 'mcp://community/oauth-migration-guide', declared: true, trust: 'untrusted', sensitivity: 'public', digest: digestValue('mcp://community/oauth-migration-guide') })
    const externalFetchActivity = `${request.runId}:activity:mcp-fetch`
    const externalFetchKey = `${workflowIdempotencyKey}:mcp-fetch`
    yield next({ type: 'activity_attempt_started', activityId: externalFetchActivity, activityType: 'external.fetch', attempt: 1, idempotencyKey: externalFetchKey, sideEffect: 'external', timeoutSeconds: 20 })
    yield next({ type: 'tool_requested', activityId: externalFetchActivity, attempt: 1, idempotencyKey: externalFetchKey, tool: 'mcp_fetch', capability: 'network:egress', inputDigest: digestValue('mcp://community/oauth-migration-guide') })
    yield next({ type: 'policy_decided', activityId: externalFetchActivity, attempt: 1, tool: 'mcp_fetch', decision: policyProvider.evaluate({ runId: request.runId, tool: 'mcp_fetch', capability: 'network:egress', resourceRef: 'mcp://community/oauth-migration-guide', declared: true, trust: 'untrusted', sensitivity: 'public', networkHost: 'community.example', allowedHosts: sandboxAttestation.allowedHosts }) })
    yield next({ type: 'activity_failed', activityId: externalFetchActivity, attempt: 1, errorType: 'PolicyDenied', retryable: false, errorDigest: digestValue('policy-denied:untrusted-mcp') })

    const testActivity = `${request.runId}:activity:test-suite`
    const testActivityKey = `${workflowIdempotencyKey}:test-suite`
    yield next({ type: 'activity_attempt_started', activityId: testActivity, activityType: 'test.execute', attempt: 1, idempotencyKey: testActivityKey, sideEffect: 'write', timeoutSeconds: 240 })
    yield next({ type: 'tool_requested', activityId: testActivity, attempt: 1, idempotencyKey: testActivityKey, tool: 'run_tests', capability: 'shell:execute', inputDigest: digestValue('npm:test:identity-binding') })
    yield next({ type: 'policy_decided', activityId: testActivity, attempt: 1, tool: 'run_tests', decision: policyProvider.evaluate({ runId: request.runId, tool: 'run_tests', capability: 'shell:execute', resourceRef: 'npm:test:identity-binding' }) })
    yield next({ type: 'activity_failed', activityId: testActivity, attempt: 1, errorType: 'SandboxTransientError', retryable: true, errorDigest: digestValue('sandbox:worker-evicted') })
    yield next({ type: 'activity_retry_scheduled', activityId: testActivity, failedAttempt: 1, nextAttempt: 2, backoffSeconds: 2, reason: 'transient sandbox worker eviction' })
    yield next({ type: 'activity_attempt_started', activityId: testActivity, activityType: 'test.execute', attempt: 2, idempotencyKey: testActivityKey, sideEffect: 'write', timeoutSeconds: 240 })
    yield next({ type: 'tool_requested', activityId: testActivity, attempt: 2, idempotencyKey: testActivityKey, tool: 'run_tests', capability: 'shell:execute', inputDigest: digestValue('npm:test:identity-binding') })
    yield next({ type: 'policy_decided', activityId: testActivity, attempt: 2, tool: 'run_tests', decision: policyProvider.evaluate({ runId: request.runId, tool: 'run_tests', capability: 'shell:execute', resourceRef: 'npm:test:identity-binding' }) })
    yield next({ type: 'activity_completed', activityId: testActivity, attempt: 2, outputDigest: digestValue('junit:42-tests:2-failures') })

    ensureActive()
    yield next({ type: 'artifact_created', artifactType: 'patch', uri: 'workspace://patch.diff', digest: digestValue('patch') })
    yield next({ type: 'artifact_created', artifactType: 'test', uri: 'workspace://junit.xml', digest: digestValue('junit') })
    yield next({ type: 'artifact_created', artifactType: 'documentation', uri: 'workspace://docs/identity.md', digest: digestValue('docs') })
    yield next({ type: 'context_note_written', noteRef: `${request.sessionRef}/notes/decisions.md`, category: 'decision', contentDigest: digestValue('decision:deny-undeclared-and-untrusted-context'), durable: true })
    const ciEvidence = new LocalCiEvidenceAdapter()
    const reports = [
      { kind: 'junit' as const, sourceUri: 'workspace://junit.xml', tool: 'vitest', content: '<testsuites tests="42" failures="2" errors="0" skipped="0"></testsuites>' },
      { kind: 'sarif' as const, sourceUri: 'workspace://security.sarif', tool: 'semgrep', content: JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Semgrep' } }, results: [{ level: 'warning' }, { level: 'note' }] }] }) },
      { kind: 'coverage' as const, sourceUri: 'workspace://coverage/lcov.info', tool: 'istanbul', content: 'TN:\nSF:src/auth/session.ts\nLF:80\nLH:74\nBRF:20\nBRH:17\nend_of_record' },
    ]
    for (const report of reports) {
      const evidence = await ciEvidence.ingest(report)
      yield next({ type: 'ci_evidence_ingested', ...evidence })
    }
    const usage = { inputTokens: 58_000, outputTokens: 7_000, toolCalls: 7, elapsedSeconds: 742, estimatedCostUsd: 5.42 }
    const budgetDecision = new RuntimeBudgetGuard().evaluate(request.budget, usage)
    yield next({ type: 'usage_reported', usage, budget: request.budget, decision: budgetDecision })
    if (budgetDecision.action === 'terminate') {
      yield next({ type: 'run_completed', status: 'failed', outputDigest: digestValue(`${request.runId}:budget-exceeded`) })
      return
    }
    const resetDecision = harnessPolicy.decideContextReset({ policyId: `${harnessSelection.selected.profileId}:context-reset`, policy: harnessSelection.selected.contextResetPolicy, usedTokens: 62_400, maxTokens: request.budget.maxTokens, phaseBoundary: true, evaluatorFeedbackPending: false })
    yield next({ type: 'context_reset_decided', policyId: `${harnessSelection.selected.profileId}:context-reset`, ...resetDecision, usedTokens: 62_400, maxTokens: request.budget.maxTokens })
    yield next({ type: 'context_compacted', beforeTokens: 62_400, afterTokens: 23_800, strategy: 'summary_and_pointers', preservedNoteRefs: [`${request.sessionRef}/notes/plan.md`, `${request.sessionRef}/notes/findings.md`, `${request.sessionRef}/notes/decisions.md`], summaryDigest: digestValue('compacted-context:plan-findings-decisions') })
    yield next({ type: 'checkpoint_saved', checkpointRef: `${request.sessionRef}/checkpoints/pre-eval`, completedSteps: ['compile context', 'implement change', 'run tests', 'collect ci evidence', 'update docs'], nextStep: 'evaluate', workspaceDigest: digestValue(`${request.workspaceRef}:pre-eval`) })
    const experiment = evaluationProvider.bind({ experimentId: `${request.runId}:experiment:1`, suiteId: request.evaluationSuiteIds[0] ?? 'EVS-MOCK', datasetRef: 'dataset://enterprise-identity-regressions', datasetVersion: '2026-09-22.3', candidateRef: `${request.modelRef}+${harnessSelection.selected.profileId}`, traceRef: `${request.sessionRef}/transcript`, graderRefs: [{ graderId: 'grader://identity-invariants', version: '3', type: 'deterministic' }, { graderId: 'grader://security-policy', version: '2', type: 'deterministic' }, { graderId: 'grader://review-quality', version: '1', type: 'model' }], trialCount: 42, environmentDigest: digestValue('eval-image:isolated-with-resource-pressure') })
    yield next({ type: 'evaluation_experiment_bound', ...experiment })
    yield next({ type: 'evaluation_completed', suiteId: request.evaluationSuiteIds[0] ?? 'EVS-MOCK', passed: 40, failed: 2, unknown: 0 })
    yield next({ type: 'evaluation_diagnosed', suiteId: request.evaluationSuiteIds[0] ?? 'EVS-MOCK', transcriptReviewed: true, environment: { cleanStart: true, sharedStateDetected: true, imageDigest: digestValue('eval-image:isolated-with-resource-pressure') }, failures: [
      { taskId: 'TASK-SSO-018', category: 'agent', confidence: 0.94, summary: 'Agent 在账号冲突后重复创建 IdentityBinding。', evidenceRefs: [`${request.sessionRef}/transcript`, 'workspace://junit.xml'] },
      { taskId: 'TASK-INF-004', category: 'infrastructure', confidence: 0.87, summary: '共享缓存与资源压力造成相关性失败，结果不能直接归因于模型能力。', evidenceRefs: ['workspace://eval-environment.json', 'workspace://junit.xml'] },
    ] })
    const roadmapUpdate = { roadmapId, plannerRef: roadmap.plannerRef, basedOnRunId: request.runId, previousRoadmapDigest: roadmapDigest, milestoneUpdates: [{ id: 'MS-1', status: 'done' as const }, { id: 'MS-2', status: 'active' as const }], nextSprintObjective: '隔离基础设施噪声，并修复跨租户身份冲突后重新运行 Trials。', feedbackRefs: [`${request.sessionRef}/transcript`, 'eval://EVS-014/TASK-SSO-018', 'eval://EVS-014/TASK-INF-004'] }
    yield next({ type: 'roadmap_updated', ...roadmapUpdate, roadmapDigest: digestValue(JSON.stringify(roadmapUpdate)) })
    yield next({ type: 'run_completed', status: 'succeeded', outputDigest: digestValue(`${request.runId}:complete`) })
  }

}
