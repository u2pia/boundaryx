export type ExecutionMode =
  | 'prompt_chain'
  | 'routing'
  | 'parallel'
  | 'orchestrator_workers'
  | 'evaluator_optimizer'
  | 'autonomous_agent'

export type Capability =
  | 'repository:read'
  | 'repository:write'
  | 'shell:execute'
  | 'network:egress'
  | 'secrets:read'
  | 'deployment:write'

export type RunBudget = {
  maxTokens: number
  maxDurationSeconds: number
  maxToolCalls: number
  maxCostUsd?: number
}

export type RunUsage = {
  inputTokens: number
  outputTokens: number
  toolCalls: number
  elapsedSeconds: number
  estimatedCostUsd: number
}

export type BudgetDecision = {
  status: 'within' | 'warning' | 'exceeded'
  action: 'continue' | 'checkpoint' | 'terminate'
  reasons: string[]
}

export type AgentRunRequest = {
  runId: string
  modelRef: string
  harnessRef: string
  sandboxRef: string
  sessionRef: string
  intentVersionId: string
  contextManifestId: string
  policyBundleId: string
  evaluationSuiteIds: string[]
  executionMode: ExecutionMode
  workspaceRef: string
  requestedCapabilities: Capability[]
  budget: RunBudget
  resumeFrom?: {
    parentRunId: string
    checkpointRef: string
    workspaceDigest: string
  }
}

export type PolicyDecision = {
  decision: 'allow' | 'deny' | 'require_approval'
  enforcement: 'preventive' | 'detective'
  policyId: string
  policyVersion: string
  reason: string
  inputDigest: string
}

export type PolicyDecisionInput = {
  runId: string
  tool: string
  capability: Capability
  resourceRef: string
  declared?: boolean
  trust?: ContextTrust
  sensitivity?: ContextSensitivity
  networkHost?: string
  allowedHosts?: string[]
  approvedBy?: string
}

export type PolicyBundleDescriptor = {
  providerRef: string
  bundleId: string
  bundleVersion: string
  bundleDigest: string
  defaultDecision: 'deny'
  ruleCount: number
  ruleIds: string[]
}

export interface PolicyDecisionProvider {
  readonly id: string
  describe(): PolicyBundleDescriptor
  evaluate(input: PolicyDecisionInput): PolicyDecision
}

export type AutonomyProgramPhase = 'human_approval' | 'low_risk_auto_merge'
export type AutonomyRiskTier = 'low' | 'medium' | 'high'

export type AutonomyDecisionInput = {
  candidateId: string
  programPhase: AutonomyProgramPhase
  riskTier: AutonomyRiskTier
  repositoryOnly: boolean
  sandboxVerified: boolean
  sessionIntegrityValid: boolean
  evidenceVerified: boolean
  evaluationFailed: number
  ciFailed: number
  unresolvedPolicyDenials: number
  externalEgress: boolean
  destructiveChange: boolean
  productionImpact: boolean
  identityAnchored: boolean
  humanReviewApproved: boolean
}

export type AutonomyDecision = {
  providerRef: string
  policyId: string
  policyVersion: string
  decision: 'blocked' | 'human_review' | 'auto_merge_eligible'
  riskTier: AutonomyRiskTier
  reasons: string[]
  requiredControls: string[]
  inputDigest: string
  decisionDigest: string
}

export interface AutonomyDecisionProvider {
  readonly id: string
  evaluate(input: AutonomyDecisionInput): AutonomyDecision
}

export type ContextTrust = 'trusted' | 'mixed' | 'untrusted'
export type ContextSensitivity = 'public' | 'internal' | 'restricted' | 'sensitive'
export type CiEvidenceKind = 'junit' | 'sarif' | 'coverage'
export type CiEvidenceStatus = 'passed' | 'warning' | 'failed'
export type EvaluationFailureCategory = 'agent' | 'task' | 'grader' | 'harness' | 'infrastructure'

export type EvaluationGraderRef = {
  graderId: string
  version: string
  type: 'deterministic' | 'model' | 'human'
}

export type EvaluationExperimentDescriptor = {
  providerRef: string
  experimentId: string
  suiteId: string
  datasetRef: string
  datasetVersion: string
  candidateRef: string
  traceRef: string
  graderRefs: EvaluationGraderRef[]
  trialCount: number
  environmentDigest: string
  experimentDigest: string
}

export type EvaluationTrial = {
  trialId: string
  taskId: string
  result: 'passed' | 'failed' | 'unknown'
}

export type EvaluationReliability = {
  passed: number
  failed: number
  unknown: number
  passAtK: number
  passPowerK: number
}

export interface EvaluationProvider {
  readonly id: string
  bind(input: Omit<EvaluationExperimentDescriptor, 'providerRef' | 'experimentDigest'>): EvaluationExperimentDescriptor
  summarize(trials: EvaluationTrial[]): EvaluationReliability
}

export type TraceAttribute = string | number | boolean

export type TraceSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'internal' | 'client'
  startedAt: string
  endedAt: string
  attributes: Record<string, TraceAttribute>
}

export type TraceProjection = {
  schemaVersion: 'aperture.otel-trace-projection/v0.1'
  providerId: string
  runId: string
  traceId: string
  spans: TraceSpan[]
  projectionDigest: string
}

export interface TraceProvider {
  readonly id: string
  project(runId: string, events: AgentRunEvent[]): TraceProjection
  verify(projection: TraceProjection): boolean
}

export type TelemetryExportPolicy = {
  policyId: string
  policyVersion: string
  destination: 'local_file'
  routineSampleRate: number
  contentMode: 'metadata_only'
  alwaysKeep: Array<'root' | 'error' | 'policy_deny' | 'evaluation_failure'>
  allowedAttributePrefixes: string[]
  deniedAttributeFragments: string[]
  maxStringLength: number
}

export type TelemetryExportRequest = {
  projection: TraceProjection
  serviceName: string
  environment: string
  policy?: TelemetryExportPolicy
}

export type OtlpAnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }

export type OtlpKeyValue = {
  key: string
  value: OtlpAnyValue
}

export type OtlpJsonSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpKeyValue[]
  status: { code: number }
}

export type OtlpTraceRequest = {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] }
    scopeSpans: Array<{
      scope: { name: string; version: string }
      spans: OtlpJsonSpan[]
    }>
  }>
}

export type TelemetryExportBundle = {
  schemaVersion: 'aperture.otlp-json-export/v0.1'
  providerId: string
  runId: string
  traceId: string
  sourceProjectionDigest: string
  policy: TelemetryExportPolicy
  contentType: 'application/json'
  fileName: string
  exportedSpanCount: number
  droppedSpanCount: number
  request: OtlpTraceRequest
  exportDigest: string
}

export interface TelemetryExportProvider {
  readonly id: string
  prepare(request: TelemetryExportRequest): TelemetryExportBundle
  verify(bundle: TelemetryExportBundle): boolean
}

export type WorkContractCriterion = {
  id: string
  statement: string
  verifier: 'deterministic' | 'model' | 'human'
  criticality: 'critical' | 'required' | 'advisory'
}

export type WorkflowRetryPolicy = {
  maxAttempts: number
  initialBackoffSeconds: number
  maxBackoffSeconds: number
  nonRetryableErrors: string[]
}

export type CiEvidenceRecord = {
  kind: CiEvidenceKind
  sourceUri: string
  tool: string
  status: CiEvidenceStatus
  summary: Record<string, number>
  digest: string
}

export type CiEvidenceInput = {
  kind: CiEvidenceKind
  sourceUri: string
  content: string
  tool?: string
}

export type AgentRunEventEnvelope = {
  runId: string
  sequence: number
  occurredAt: string
  previousEventDigest: string
  eventDigest: string
}

export type AgentRunEvent = AgentRunEventEnvelope & (
  | { type: 'run_started'; adapterId: string; requestDigest: string }
  | { type: 'runtime_bound'; modelRef: string; harnessRef: string; sandboxRef: string; sessionRef: string; appendOnlyLog: boolean }
  | { type: 'sandbox_attested'; sandboxRef: string; attestorRef: string; isolation: 'container' | 'vm' | 'hardened_process'; workspaceRoot: string; writablePaths: string[]; readonlyPaths: string[]; networkEgress: 'denied' | 'allowlist' | 'unrestricted'; allowedHosts: string[]; secretMounts: string[]; ephemeral: boolean; status: 'verified' | 'failed'; attestationDigest: string }
  | { type: 'harness_profile_selected'; profileId: string; modelRef: string; modelContextBehavior: 'durable' | 'balanced' | 'fragile'; executionMode: ExecutionMode; contextResetPolicy: 'continuous' | 'phase_boundary_compaction' | 'fresh_session_per_phase'; evidenceRef: string; candidateCount: number; candidates: Array<{ profileId: string; executionMode: ExecutionMode; contextResetPolicy: 'continuous' | 'phase_boundary_compaction' | 'fresh_session_per_phase'; passRate: number; p95DurationSeconds: number; estimatedCostUsd: number; evidenceRef: string }>; selectionReason: string }
  | { type: 'workflow_bound'; workflowId: string; providerRef: string; taskQueue: string; idempotencyKey: string; replayMode: 'event_history' | 'checkpoint'; humanResume: 'allowed' | 'approval_required'; retryPolicy: WorkflowRetryPolicy }
  | ({ type: 'policy_bundle_bound' } & PolicyBundleDescriptor)
  | { type: 'roadmap_created'; roadmapId: string; intentVersionId: string; plannerRef: string; goal: string; milestones: Array<{ id: string; title: string; status: 'planned' | 'active' | 'done'; dependsOn: string[] }>; roadmapDigest: string }
  | { type: 'roadmap_updated'; roadmapId: string; plannerRef: string; basedOnRunId: string; previousRoadmapDigest: string; milestoneUpdates: Array<{ id: string; status: 'planned' | 'active' | 'done' }>; nextSprintObjective: string; feedbackRefs: string[]; roadmapDigest: string }
  | { type: 'sprint_planned'; sprintId: string; roadmapId: string; plannerRef: string; objective: string; milestoneIds: string[]; taskIds: string[]; contextResetBoundary: 'after_evaluation' | 'after_sprint' }
  | { type: 'plan_created'; steps: string[] }
  | { type: 'work_contract_proposed'; contractId: string; sprintId: string; intentVersionId: string; generatorRef: string; objective: string; criteria: WorkContractCriterion[]; nonGoals: string[]; contractDigest: string }
  | { type: 'work_contract_reviewed'; contractId: string; contractDigest: string; generatorRef: string; evaluatorRef: string; decision: 'accepted' | 'revision_required'; findings: string[] }
  | { type: 'context_scope_created'; scopeId: string; worker: string; allowedSources: string[]; maxTokens: number }
  | { type: 'context_requested'; source: string; declared: boolean; trust: ContextTrust; sensitivity: ContextSensitivity; digest: string }
  | { type: 'context_consumed'; source: string; declared: boolean; trust: ContextTrust; sensitivity: ContextSensitivity; digest: string }
  | { type: 'context_note_written'; noteRef: string; category: 'plan' | 'finding' | 'decision' | 'open_question'; contentDigest: string; durable: boolean }
  | { type: 'context_reset_decided'; policyId: string; action: 'continue' | 'compact' | 'fresh_session'; trigger: 'policy_check' | 'token_pressure' | 'phase_boundary' | 'evaluator_feedback'; usedTokens: number; maxTokens: number; reason: string }
  | { type: 'context_compacted'; beforeTokens: number; afterTokens: number; strategy: 'summary_and_pointers' | 'structured_notes'; preservedNoteRefs: string[]; summaryDigest: string }
  | { type: 'usage_reported'; usage: RunUsage; budget: RunBudget; decision: BudgetDecision }
  | { type: 'activity_attempt_started'; activityId: string; activityType: string; attempt: number; idempotencyKey: string; sideEffect: 'read' | 'write' | 'external'; timeoutSeconds: number }
  | { type: 'tool_requested'; activityId: string; attempt: number; idempotencyKey: string; tool: string; capability: Capability; inputDigest: string }
  | { type: 'policy_decided'; activityId: string; attempt: number; tool: string; decision: PolicyDecision }
  | { type: 'activity_failed'; activityId: string; attempt: number; errorType: string; retryable: boolean; errorDigest: string }
  | { type: 'activity_retry_scheduled'; activityId: string; failedAttempt: number; nextAttempt: number; backoffSeconds: number; reason: string }
  | { type: 'activity_completed'; activityId: string; attempt: number; outputDigest: string }
  | { type: 'artifact_created'; artifactType: 'patch' | 'test' | 'documentation' | 'report'; uri: string; digest: string }
  | ({ type: 'ci_evidence_ingested' } & CiEvidenceRecord)
  | { type: 'checkpoint_saved'; checkpointRef: string; completedSteps: string[]; nextStep: string; workspaceDigest: string }
  | { type: 'checkpoint_restored'; checkpointRef: string; parentRunId: string; workspaceDigest: string }
  | ({ type: 'evaluation_experiment_bound' } & EvaluationExperimentDescriptor)
  | { type: 'evaluation_completed'; suiteId: string; passed: number; failed: number; unknown: number }
  | { type: 'evaluation_diagnosed'; suiteId: string; transcriptReviewed: boolean; environment: { cleanStart: boolean; sharedStateDetected: boolean; imageDigest: string }; failures: Array<{ taskId: string; category: EvaluationFailureCategory; confidence: number; summary: string; evidenceRefs: string[] }> }
  | { type: 'run_completed'; status: 'succeeded' | 'failed' | 'cancelled'; outputDigest: string }
)

export type EvaluationTaskContract = {
  taskId: string
  suiteId: string
  description: string
  fixtureRef: string
  referenceSolutionRef?: string
  successCriteria: Array<{
    id: string
    type: 'deterministic' | 'model' | 'human'
    criticality: 'critical' | 'required' | 'advisory'
    weight: number
  }>
  trials: number
}

export interface AgentAdapter {
  readonly id: string
  readonly supportedModes: readonly ExecutionMode[]
  readonly supportedCapabilities: readonly Capability[]
  run(request: AgentRunRequest, signal?: AbortSignal): AsyncIterable<AgentRunEvent>
}

export type WorkflowExecutionStatus = 'running' | 'interrupted' | 'completed'

export type WorkflowExecutionRecord = {
  schemaVersion: 'aperture.workflow-execution/v0.1'
  runId: string
  label: string
  request: AgentRunRequest
  requestDigest: string
  workflowId?: string
  providerRef?: string
  status: WorkflowExecutionStatus
  recoveryCount: number
  interruptReason?: string
  startedAt: string
  updatedAt: string
  events: AgentRunEvent[]
  chainHead: string
  recordDigest: string
}

export type WorkflowRecoveryCursor = {
  runId: string
  workflowId?: string
  nextSequence: number
  previousEventDigest: string
  checkpoint?: Extract<AgentRunEvent, { type: 'checkpoint_saved' }>
  recoveryCount: number
}

export interface WorkflowProvider {
  readonly id: string
  start(request: AgentRunRequest, label: string): WorkflowExecutionRecord
  append(runId: string, event: AgentRunEvent): WorkflowExecutionRecord
  interrupt(runId: string, reason: string): WorkflowExecutionRecord
  recover(runId: string): WorkflowRecoveryCursor
  read(runId: string): WorkflowExecutionRecord | null
  latestRecoverable(): WorkflowExecutionRecord | null
  verify(runId: string): boolean
  discard(runId: string): void
  clear(): void
}

export interface IssueProvider {
  readonly id: string
  readIssue(externalId: string): Promise<{ title: string; body: string; state: string; assignees: string[] }>
  writeIntentProjection(externalId: string, summary: string): Promise<void>
}

export type PullRequestCheck = {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | null
  detailsUrl: string
}

export type PullRequestSnapshot = {
  title: string
  state: 'open' | 'closed' | 'merged'
  author: string
  baseRef: string
  headRef: string
  headSha: string
  changedFiles: number
  additions: number
  deletions: number
  reviewDecision: 'approved' | 'changes_requested' | 'review_required'
  checks: PullRequestCheck[]
}

export interface PullRequestProvider {
  readonly id: string
  readPullRequest(externalId: string): Promise<PullRequestSnapshot>
  writeEvidenceProjection(externalId: string, summary: string): Promise<void>
}

export interface EvidenceSink {
  append(runId: string, event: AgentRunEvent): Promise<void>
  finalize(runId: string): Promise<{ packageUri: string; packageDigest: string }>
}

export type InTotoStatement = {
  _type: 'https://in-toto.io/Statement/v1'
  subject: Array<{ name: string; digest: { sha256: string } }>
  predicateType: 'https://aperture.dev/attestation/evidence-package/v0.1'
  predicate: {
    runId: string
    evidenceUri: string
    repositoryDigest: string
    chainHead: string
    eventCount: number
    workflowId?: string
  }
}

export type EvidenceAttestation = {
  schemaVersion: 'aperture.attestation/v0.1'
  providerId: string
  trustLevel: 'ephemeral_local'
  identity: string
  keyId: string
  signedAt: string
  statement: InTotoStatement
  envelope: {
    payloadType: 'application/vnd.in-toto+json'
    payload: string
    signatures: Array<{ keyid: string; sig: string }>
  }
  publicKeyJwk: JsonWebKey
}

export type AttestationRequest = {
  runId: string
  evidenceUri: string
  repositoryDigest: string
  chainHead: string
  eventCount: number
  workflowId?: string
  content: string
}

export type AttestationVerification = {
  valid: boolean
  signatureValid: boolean
  subjectDigestValid: boolean
  payloadValid: boolean
  identityAnchored: boolean
  reasons: string[]
}

export interface AttestationProvider {
  readonly id: string
  attest(request: AttestationRequest): Promise<EvidenceAttestation>
  verify(attestation: EvidenceAttestation, content: string): Promise<AttestationVerification>
}

export interface CiEvidenceAdapter {
  ingest(input: CiEvidenceInput): Promise<CiEvidenceRecord>
}

export type DeploymentRequest = {
  releaseCandidateId: string
  environment: 'staging' | 'production'
  headSha: string
  evidenceUri: string
  approvedBy: string
}

export type DeploymentResult = DeploymentRequest & {
  deploymentId: string
  providerId: string
  status: 'succeeded' | 'failed'
  startedAt: string
  completedAt: string
  artifactDigest: string
  rollbackRef: string
}

export type RollbackRequest = {
  deploymentId: string
  releaseCandidateId: string
  rollbackRef: string
  requestedBy: string
  reason: string
}

export type RollbackResult = RollbackRequest & {
  rollbackId: string
  providerId: string
  status: 'succeeded' | 'failed'
  completedAt: string
  restoredArtifactDigest: string
}

export interface DeploymentProvider {
  readonly id: string
  deploy(request: DeploymentRequest): Promise<DeploymentResult>
  rollback(request: RollbackRequest): Promise<RollbackResult>
}
