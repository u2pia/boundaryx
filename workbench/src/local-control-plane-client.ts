export type LocalActor = {
  id: string
  username: string
  displayName: string
  role: 'owner' | 'maintainer' | 'reviewer' | 'developer'
  status?: 'active' | 'disabled'
  createdAt?: string
  /** Present on the session actor: how this session was proven. */
  authMethod?: 'password' | 'github'
  identity?: LocalIdentityBinding | null
}

export type LocalActorUpdate = { displayName?: string; role?: Exclude<LocalActor['role'], 'owner'>; status?: 'active' | 'disabled'; password?: string }

export type LocalIdentityMode = 'development' | 'team'

export type LocalIdentityBinding = {
  provider: 'github'
  expectedLogin: string
  status: 'declared' | 'verified'
  subject?: string
  login?: string
  verifiedAt?: string
  declaredByActorId: string
  declaredAt: string
}

export type LocalCodeHostKind = 'local' | 'github'
export type LocalMergeMode = 'control_plane' | 'host_protected'
export type LocalProjectRole = 'maintainer' | 'reviewer' | 'developer'

/** One repository under one code host, and the unit of access. The host config never holds a secret, only env var names. */
/** The project every install starts with and every member belongs to: it holds the workbench's sample data and, after `npm run seed:demo`, a worked example from the real pipeline. */
export const DEMO_PROJECT_ID = 'PRJ-DEFAULT'

export type LocalProject = {
  id: string
  slug: string
  name: string
  description: string
  codeHost: LocalCodeHostKind
  codeHostConfig: { apiBase?: string; webBase?: string; owner?: string; repo?: string; tokenEnv?: string; transport?: 'https' | 'ssh'; remoteUrl?: string }
  repositoryPath?: string
  defaultBranch: string
  mergeMode: LocalMergeMode
  status: 'active' | 'archived'
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export type LocalProjectMember = { projectId: string; actorId: string; username: string; displayName: string; role: LocalProjectRole; addedByActorId?: string; addedAt: string }

/** How a proposal appears on its code host. Written only by the server's syncer; the token never reaches the browser. */
export type LocalCodeHostLink = { changeProposalId: string; projectId: string; provider: 'github'; externalId: string; url: string; publishedRef: string; headShaPublished: string; state: 'open' | 'merged' | 'closed'; gateStatePublished?: 'pending' | 'success' | 'failure'; gateShaPublished?: string; gateDescriptionPublished?: string; lastError?: string; syncedAt: string }

export type LocalCodeHostSyncReport = { projectId: string; syncedAt: string; published: number; checksImported: number; gateUpdates: number; merged: number; closed: number; errors: Array<{ proposalId?: string; code: string; message: string }> }

export type LocalCodeHostConnection = { ok: boolean; repositoryReachable: boolean; defaultBranchFound: boolean; credentialPresent: boolean; missingPermissions: string[]; message: string }

export type LocalProjectInput = {
  slug?: string
  name?: string
  description?: string
  codeHost?: LocalCodeHostKind
  repositoryPath?: string | null
  codeHostConfig?: LocalProject['codeHostConfig']
  defaultBranch?: string
  mergeMode?: LocalMergeMode
}

export type LocalWorkItem = {
  id: string
  projectId: string
  /** Number within the project, shown as #N; assigned at creation and never reused. */
  sequence: number
  title: string
  description: string
  productType: 'application' | 'agent_system'
  status: 'draft' | 'ready' | 'active' | 'review' | 'done' | 'cancelled'
  ownerActorId: string
  authorityProvider: string
  authorityRef: string
  createdAt: string
  updatedAt: string
}

export type LocalIntentVersion = {
  id: string
  workItemId: string
  version: number
  goal: string
  constraints: string[]
  riskLevel: 'low' | 'medium' | 'high'
  contentDigest: string
  createdBy: string
  createdAt: string
  /** Only an approved version can start a Run; low risk is approved by rule, medium and high by a non-author. */
  status: 'draft' | 'approved' | 'superseded'
  approval?: { basis: 'low_risk_rule' | 'named_approval'; actorId?: string; approvedAt: string; comment?: string }
  acceptanceCriteria: Array<{ id: string; ordinal: number; statement: string; criticality: 'normal' | 'critical'; verificationType: 'deterministic' | 'model' | 'human'; verifiedBy?: string[] }>
}

export type LocalChangeProposal = {
  id: string
  projectId: string
  workItemId: string
  intentVersionId: string
  runId?: string
  repositoryPath: string
  baseRef: string
  baseSha: string
  headRef: string
  headSha: string
  authorActorId: string
  status: 'draft' | 'review_ready' | 'changes_requested' | 'approved' | 'merged' | 'closed'
  changedFiles: number
  additions: number
  deletions: number
  reviewCycleStartedAt: string
  // Files under `.aperture/` the head changes relative to base; absent until the proposal is scanned.
  policyFiles?: string[]
  createdAt: string
  updatedAt: string
}

export type LocalMergeEvidence = {
  id: string
  changeProposalId: string
  baseRef: string
  baseShaBefore: string
  approvedHeadSha: string
  mergedSha: string
  strategy: 'fast_forward' | 'host_merge'
  hostMerge?: { provider: 'github'; externalId: string; url: string; mergedBy?: string; hostMergedAt?: string; contentCheck: 'ancestor' | 'tree_equal' | 'patch_equal' | 'mismatch'; hostHeadSha?: string; gateStateAtMerge: 'pending' | 'success' | 'failure' | 'unpublished'; outsideGate: boolean; outsideGateReasons: string[] }
  approvalReviewIds: string[]
  checkIds: string[]
  evidenceIds: string[]
  proposalEventChainHead: string
  evidenceDigest: string
  mergedByActorId: string
  mergedAt: string
}

export type LocalReleaseCandidate = {
  id: string
  projectId: string
  changeProposalId: string
  mergeEvidenceId: string
  repositoryPath: string
  sourceRef: string
  commitSha: string
  sourceTreeDigest: string
  sourceFileCount: number
  artifactClass: 'source_snapshot' | 'source_with_build_attestation'
  artifactEvidence: Array<{ evidenceId: string; packageDigest: string; artifactCount: number }>
  artifactBindingDigest?: string
  contentDigest: string
  status: 'review_ready' | 'approved' | 'cancelled'
  createdByActorId: string
  createdAt: string
  approvedAt?: string
  approval?: { id: string; approverActorId: string; comment: string; candidateContentDigest: string; approvedAt: string }
}

export type LocalReviewRecord = {
  id: string
  changeProposalId: string
  headSha: string
  reviewerActorId: string
  reviewerDisplayName: string
  reviewerRole: LocalActor['role']
  decision: 'approved' | 'changes_requested' | 'commented'
  comment: string
  decisionLatencySeconds: number
  invalidatedAt?: string
  createdAt: string
}

export type LocalReviewMetrics = {
  pendingCount: number
  changesRequestedCount: number
  approvedCount: number
  currentDecisionCount: number
  invalidatedDecisionCount: number
  medianDecisionLatencySeconds: number
  oldestPendingSeconds: number
  activeReviewerCount: number
  approvalDecisionCount: number
  evidenceExpandedApprovalCount: number
  decidedProposalCount: number
  firstPassApprovalCount: number
  reworkedProposalCount: number
  acceptedChangeCount: number
}

export type LocalCriterionOverride = { decisionId: string; actorId: string; actorDisplayName: string; overriddenStatus: 'failed' | 'self_graded' | 'unmapped'; reason: string; createdAt: string }

export type LocalGovernanceDecision = { id: string; changeProposalId: string; headSha: string; decisionType: 'override' | 'reject'; criterionId?: string; actorId: string; reason: string; evidenceSha256: string[]; createdAt: string }

export type LocalReviewAssignment = { id: string; changeProposalId: string; assigneeActorId: string; assigneeDisplayName: string; assignedByActorId: string; basis: 'manual' | 'self_claim' | 'load_balanced'; reason: string; status: 'pending' | 'in_review' | 'changes_requested' | 'approved' | 'reassigned'; headSha: string; reassignedFrom?: string; assignedAt: string; dueAt: string; cycleStartedAt: string; evidenceOpenedAt?: string; decidedAt?: string; timeSpentSeconds?: number; endedAt?: string; overdue: boolean }

export type LocalReviewerLoad = { actorId: string; displayName: string; role: LocalActor['role']; openAssignmentCount: number; identityVerified?: boolean; githubLogin?: string }

export type LocalReviewReadiness = {
  changeProposalId: string
  headSha: string
  status: 'ready' | 'blocked' | 'incomplete'
  checks: Array<{ id: string; name: string; status: 'queued' | 'in_progress' | 'completed'; conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled'; evidenceRef?: string; exitCode?: number; durationMs?: number; stdoutDigest?: string; stderrDigest?: string; source: 'run' | 'external'; runId?: string; startedAt: string; completedAt?: string }>
  evidence: Array<{ id: string; runId: string; uri: string; sha256: string; summary: Record<string, unknown>; viewCount: number; createdAt: string }>
  successfulCheckCount: number
  failedCheckCount: number
  waivedCheckCount: number
  pendingCheckCount: number
  invalidatedCheckCount: number
  invalidatedEvidenceCount: number
  criteria: Array<{ criterionId: string; label: string; statement: string; criticality: 'normal' | 'critical'; verificationType: 'deterministic' | 'model' | 'human'; mapping: 'rule' | 'declared'; checkNames: string[]; independent?: boolean; unmappedReason?: string; status: 'passed' | 'self_graded' | 'failed' | 'pending' | 'unmapped' | 'awaiting_review' | 'overridden'; override?: LocalCriterionOverride }>
  blockers: string[]
  policyFiles: string[] | null
  builderStop: { runId: string; reason: 'time_budget' | 'step_budget'; summary: string } | null
}

export type LocalEvidencePackageView = {
  evidence: { id: string; changeProposalId: string; runId: string; headSha: string; uri: string; sha256: string; summary: Record<string, unknown>; createdAt: string }
  evidencePackage: {
    schemaVersion: 'aperture.evidence.v1'
    generatedAt: string
    projectManifest?: { path: string; baseSha: string; digest: string; schemaVersion: string; policy: { maximumRisk: 'low' | 'medium' | 'high'; allowUnisolatedRuntime: boolean }; evaluation?: { profile: 'application_checks' | 'agent_dataset'; datasetPath?: string; datasetDigest?: string; thresholds: Array<{ metric: string; operator: 'gte' | 'lte'; threshold: number }> }; artifact?: { profile: 'application_build'; buildCheck: string; outputs: string[] } }
    workItem: { id: string; title: string; productType: 'application' | 'agent_system' }
    intent: { id: string; version: number; goal: string; riskLevel: 'low' | 'medium' | 'high'; contentDigest: string; constraints: string[]; acceptanceCriteria: Array<{ id: string; statement: string; criticality: 'normal' | 'critical'; verificationType: 'deterministic' | 'model' | 'human'; ordinal: number }> }
    git: { repositoryPath: string; baseRef: string; baseSha: string; headRef: string; headSha: string; changedFiles: number; additions: number; deletions: number }
    run: { id: string; adapterId: string; startSha?: string; revisionOfProposalId?: string; isolation: 'unisolated_process' | 'container'; networkEgress: 'denied' | 'allowlist' | 'unrestricted'; productionEligible: boolean; runtimeAttestationDigest?: string; stdoutDigest?: string; stderrDigest?: string }
    checks: Array<{ id: string; name: string; kind?: 'test' | 'evaluation' | 'build' | 'integrity'; conclusion: 'success' | 'failure' | 'neutral' | 'cancelled'; exitCode?: number; durationMs: number; stdoutDigest: string; stderrDigest: string; stdoutExcerpt: string; stderrExcerpt: string; metrics?: Record<string, number>; thresholdResults?: Array<{ metric: string; operator: 'gte' | 'lte'; threshold: number; actual?: number; passed: boolean }>; provenance?: 'all_tests' | 'pre_existing' | 'unverified'; testTreeSha?: string; agentModifiedTestFiles?: string[] }>
    /** Which test conclusions the change under review could have authored the tests for. */
    testProvenance?: { declaredTestPaths: string[]; baseSha: string; agentModifiedTestFiles: string[]; headConclusions: Array<{ name: string; conclusion: string }>; baselineConclusions: Array<{ name: string; conclusion: string }>; independent: boolean; note: string }
    artifacts?: Array<{ path: string; sizeBytes: number; sha256: string; generatedByCheck: string; sourceCommitSha: string; productionEligible: false }>
    provenance: { runEventChainHead: string; proposalEventChainHead: string; generatedBy: string }
    packageDigest: string
  }
  view: { id: string; evidenceId: string; reviewerActorId: string; viewedSha256: string; viewedAt: string }
}

export type LocalAgentRun = {
  id: string
  projectId: string
  workItemId: string
  intentVersionId: string
  repositoryPath: string
  baseRef: string
  baseSha: string
  startSha: string
  revisionOfProposalId?: string
  branchRef: string
  worktreePath: string
  adapterId: string
  isolation: 'unisolated_process' | 'container'
  runtimeImageRef?: string
  runtimeAttestationDigest?: string
  networkEgress: 'denied' | 'allowlist' | 'unrestricted'
  productionEligible: boolean
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedByActorId: string
  changeProposalId?: string
  exitCode?: number
  errorMessage?: string
  startedAt: string
  queuedAt?: string
  workerPid?: number
  cancellationRequestedAt?: string
  completedAt?: string
}

/** A single run plus its event log and the Context it declared at admission, for declared-vs-actual review. */
export type LocalAgentRunDetail = {
  agentRun: LocalAgentRun
  events: LocalDomainEvent[]
  declaredContextPaths: string[]
}

export type LocalAgentRuntimeDescriptor = {
  id: string
  isolation: LocalAgentRun['isolation']
  status: 'ready' | 'degraded' | 'unavailable'
  productionEligible: boolean
  networkEgress: LocalAgentRun['networkEgress']
  imageRef?: string
  reason?: string
  model?: string
  modelProvider?: string
}

/** The LLM the Builder Agent will use. The API key is write-only: reads report only whether one is held. */
export type LocalAgentProviderSettings = {
  providerId: string
  model: string
  baseUrl: string
  wireApi: 'responses' | 'chat'
  apiKeySet: boolean
  apiKeyEnv?: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  updatedByActorId: string
  updatedAt: string
}

export type LocalAgentProviderInput = {
  providerId: string
  model: string
  baseUrl: string
  wireApi: 'responses' | 'chat'
  /** Omit to keep the stored key, pass an empty string to clear it. */
  apiKey?: string
  apiKeyEnv?: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}

export type LocalDomainEvent = {
  id: string
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  eventType: string
  actorId?: string
  payload: Record<string, unknown>
  previousEventDigest: string
  eventDigest: string
  occurredAt: string
  recordedAt: string
}

export class LocalControlPlaneApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const sessionExpiredListeners = new Set<() => void>()
/** Called when any request finds the session gone (expired, signed out elsewhere, password reset), so the UI returns to sign-in. */
export function onSessionExpired(listener: () => void) {
  sessionExpiredListeners.add(listener)
  return () => { sessionExpiredListeners.delete(listener) }
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const text = await response.text()
  const payload = text ? JSON.parse(text) as T & { error?: { code: string; message: string } } : undefined
  if (response.status === 401 && payload?.error?.code === 'authentication_required') for (const listener of sessionExpiredListeners) listener()
  if (!response.ok) throw new LocalControlPlaneApiError(response.status, payload?.error?.code ?? 'request_failed', payload?.error?.message ?? `Request failed with ${response.status}`)
  return payload as T
}

function scoped(path: string, projectId?: string) {
  if (!projectId) return path
  return `${path}${path.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`
}

function post<T>(path: string, body?: Record<string, unknown>) {
  return request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
}

export const localControlPlaneClient = {
  health: () => request<{ status: string; provider: string; storage: string; agentRunner: string | null; agentRuntime: LocalAgentRuntimeDescriptor | null; time: string }>('/api/health'),
  setupStatus: () => request<{ required: boolean }>('/api/setup/status'),
  session: () => request<{ actor: LocalActor; identityMode: LocalIdentityMode }>('/api/session'),
  authProviders: () => request<{ identityMode: LocalIdentityMode; github: { configured: boolean } }>('/api/auth/providers'),
  declareIdentity: (actorId: string, githubLogin: string) => post<{ identity: LocalIdentityBinding }>(`/api/actors/${encodeURIComponent(actorId)}/identity`, { githubLogin }),
  setIdentityMode: (mode: LocalIdentityMode) => post<{ identityMode: LocalIdentityMode }>('/api/settings/identity-mode', { mode }),
  setup: (input: { username: string; displayName: string; password: string }) => post<{ actor: LocalActor; expiresAt: string }>('/api/setup', input),
  login: (input: { username: string; password: string }) => post<{ actor: LocalActor; expiresAt: string }>('/api/auth/login', input),
  logout: () => post<void>('/api/auth/logout'),
  listActors: () => request<{ actors: LocalActor[] }>('/api/actors'),
  createActor: (input: { username: string; displayName: string; role: LocalActor['role']; password: string; projectIds?: string[] }) => post<{ actor: LocalActor }>('/api/actors', input),
  updateActor: (actorId: string, input: LocalActorUpdate) => post<{ actor: LocalActor }>(`/api/actors/${encodeURIComponent(actorId)}`, input),
  listProjects: () => request<{ projects: LocalProject[]; roles: Record<string, LocalActor['role'] | undefined> }>('/api/projects'),
  getProject: (projectId: string) => request<{ project: LocalProject; role: LocalActor['role']; members: LocalProjectMember[]; lastSync: LocalCodeHostSyncReport | null }>(`/api/projects/${encodeURIComponent(projectId)}`),
  createProject: (input: LocalProjectInput & { slug: string; name: string }) => post<{ project: LocalProject }>('/api/projects', input as Record<string, unknown>),
  updateProject: (projectId: string, input: LocalProjectInput) => post<{ project: LocalProject }>(`/api/projects/${encodeURIComponent(projectId)}/settings`, input as Record<string, unknown>),
  archiveProject: (projectId: string) => post<{ project: LocalProject }>(`/api/projects/${encodeURIComponent(projectId)}/archive`, {}),
  testProjectConnection: (projectId: string) => post<{ connection: LocalCodeHostConnection }>(`/api/projects/${encodeURIComponent(projectId)}/test-connection`, {}),
  syncProject: (projectId: string) => post<{ report: LocalCodeHostSyncReport }>(`/api/projects/${encodeURIComponent(projectId)}/sync`, {}),
  setProjectMember: (projectId: string, input: { actorId: string; role: LocalProjectRole }) => post<{ member: LocalProjectMember }>(`/api/projects/${encodeURIComponent(projectId)}/members`, input),
  removeProjectMember: (projectId: string, actorId: string) => post<void>(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(actorId)}/remove`, {}),
  getAgentProviderSettings: () => request<{ settings: LocalAgentProviderSettings | null; apiKeyVariable: string }>('/api/settings/agent-provider'),
  saveAgentProviderSettings: (input: LocalAgentProviderInput) => post<{ settings: LocalAgentProviderSettings }>('/api/settings/agent-provider', input as unknown as Record<string, unknown>),
  listWorkItems: (projectId?: string) => request<{ workItems: LocalWorkItem[] }>(scoped('/api/work-items', projectId)),
  getWorkItem: (workItemId: string) => request<{ workItem: LocalWorkItem; intentVersions: LocalIntentVersion[] }>(`/api/work-items/${workItemId}`),
  createWorkItem: (input: { title: string; description: string; productType: LocalWorkItem['productType']; ownerActorId?: string; projectId: string }) => post<{ workItem: LocalWorkItem }>('/api/work-items', input),
  createIntentVersion: (workItemId: string, input: { goal: string; constraints: string[]; riskLevel: LocalIntentVersion['riskLevel']; acceptanceCriteria: Array<{ statement: string; criticality: 'normal' | 'critical'; verificationType: 'deterministic' | 'model' | 'human'; verifiedBy?: string[] }> }) => post<{ intentVersion: LocalIntentVersion }>(`/api/work-items/${workItemId}/intent-versions`, input),
  approveIntentVersion: (intentVersionId: string, input: { comment: string }) => post<{ intentVersion: LocalIntentVersion }>(`/api/intent-versions/${encodeURIComponent(intentVersionId)}/approve`, input),
  listAgentRuns: (projectId?: string) => request<{ agentRuns: LocalAgentRun[] }>(scoped('/api/agent-runs', projectId)),
  startAgentRun: (input: { workItemId: string; intentVersionId: string; baseRef?: string; declaredContextPaths: string[]; changeProposalId?: string }) => post<{ agentRun: LocalAgentRun; queuePosition?: number }>('/api/agent-runs', input),
  cancelAgentRun: (runId: string) => post<{ agentRun: LocalAgentRun }>(`/api/agent-runs/${runId}/cancel`, {}),
  getAgentRun: (runId: string) => request<LocalAgentRunDetail>(`/api/agent-runs/${runId}`),
  listChangeProposals: (projectId?: string) => request<{ changeProposals: LocalChangeProposal[]; codeHostLinks: LocalCodeHostLink[] }>(scoped('/api/change-proposals', projectId)),
  listReleaseCandidates: (projectId?: string) => request<{ releaseCandidates: LocalReleaseCandidate[] }>(scoped('/api/release-candidates', projectId)),
  listReviews: (projectId?: string) => request<{ reviews: LocalReviewRecord[]; metrics: LocalReviewMetrics; readiness: LocalReviewReadiness[]; assignments: LocalReviewAssignment[]; reviewerLoad: LocalReviewerLoad[] }>(scoped('/api/reviews', projectId)),
  createChangeProposal: (input: { workItemId: string; intentVersionId: string; baseRef?: string; headRef: string; runId?: string }) => post<{ changeProposal: LocalChangeProposal }>('/api/change-proposals', input),
  refreshChangeProposal: (proposalId: string) => post<{ proposal: LocalChangeProposal; changed: boolean; invalidated: { reviews: number; checks: number; evidence: number } }>(`/api/change-proposals/${proposalId}/refresh`),
  reviewChangeProposal: (proposalId: string, input: { headSha: string; decision: 'approved' | 'changes_requested' | 'commented'; comment: string }) => post<{ review: { id: string } }>(`/api/change-proposals/${proposalId}/reviews`, input),
  overrideCriterion: (proposalId: string, input: { headSha: string; criterionId: string; reason: string }) => post<{ decision: LocalGovernanceDecision }>(`/api/change-proposals/${proposalId}/overrides`, input),
  assignReviewer: (proposalId: string, input: { assigneeActorId?: string; dueHours?: number; reason?: string }) => post<{ assignment: LocalReviewAssignment }>(`/api/change-proposals/${proposalId}/assignments`, input),
  rejectChangeProposal: (proposalId: string, input: { headSha: string; reason: string }) => post<{ decision: LocalGovernanceDecision }>(`/api/change-proposals/${proposalId}/reject`, input),
  mergeChangeProposal: (proposalId: string) => post<{ proposal: LocalChangeProposal; evidence: LocalMergeEvidence; changed: boolean }>(`/api/change-proposals/${proposalId}/merge`, {}),
  reviseChangeProposal: (proposalId: string) => post<{ agentRun: LocalAgentRun }>(`/api/change-proposals/${proposalId}/revise`, {}),
  createReleaseCandidate: (proposalId: string) => post<{ releaseCandidate: LocalReleaseCandidate }>(`/api/change-proposals/${proposalId}/release-candidates`, {}),
  approveReleaseCandidate: (candidateId: string, comment: string) => post<{ releaseCandidate: LocalReleaseCandidate }>(`/api/release-candidates/${candidateId}/approve`, { comment }),
  viewEvidence: (evidenceId: string) => post<LocalEvidencePackageView>(`/api/evidence/${evidenceId}/view`),
  listEvents: (limit = 200, projectId?: string) => request<{ events: LocalDomainEvent[] }>(scoped(`/api/events?limit=${limit}`, projectId)),
}
