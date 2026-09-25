import type { CriterionCoverage, CriterionStatus } from './criteria-coverage.ts'
export type TeamRole = 'owner' | 'maintainer' | 'reviewer' | 'developer'
export type RiskLevel = 'low' | 'medium' | 'high'
export type ReviewDecision = 'approved' | 'changes_requested' | 'commented'

export class AppError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = 'request_failed') {
    super(message)
    this.status = status
    this.code = code
  }
}

export type Actor = {
  id: string
  username: string
  displayName: string
  role: TeamRole
  status: 'active' | 'disabled'
  createdAt: string
  identity?: IdentityBinding
}

export type IdentityMode = 'development' | 'team'
export type AuthMethod = 'password' | 'github'

/** DOMAIN_MODEL.md Actor 1 ─── 0..1 IdentityBinding. `declared` until the provider proves the expected login. */
export type IdentityBinding = {
  provider: 'github'
  expectedLogin: string
  status: 'declared' | 'verified'
  subject?: string
  login?: string
  verifiedAt?: string
  declaredByActorId: string
  declaredAt: string
}

/** The identity a decision was made under, frozen into its event. `self_asserted` is the Development mode marker. */
export type DecisionIdentity =
  | { provider: 'github'; subject: string; login: string; assurance: 'external'; authMethod: AuthMethod | 'internal' }
  | { provider: 'local'; subject: string; login: string; assurance: 'self_asserted'; authMethod: AuthMethod | 'internal' }

export type SessionActor = Pick<Actor, 'id' | 'username' | 'displayName' | 'role'> & { authMethod?: AuthMethod }

/** A platform owner holds `owner` in every project implicitly; everyone else is granted one of these per project. */
export type ProjectRole = Exclude<TeamRole, 'owner'>
export type CodeHostKind = 'local' | 'github'
/** `control_plane`: the platform merges and publishes the result. `host_protected`: the host merges under branch protection and the platform records what happened. */
export type MergeMode = 'control_plane' | 'host_protected'

/** Never holds a secret: the token is referenced by the name of the environment variable that carries it. */
export type GithubHostConfig = {
  apiBase: string
  webBase: string
  owner: string
  repo: string
  tokenEnv: string
  transport: 'https' | 'ssh'
  /** Overrides the clone URL derived from webBase/owner/repo, e.g. for GitHub Enterprise with a custom SSH host. */
  remoteUrl?: string
}

export type Project = {
  id: string
  slug: string
  name: string
  description: string
  codeHost: CodeHostKind
  codeHostConfig: Partial<GithubHostConfig>
  /** The Git directory runs and merges operate on; undefined until configured. */
  repositoryPath?: string
  defaultBranch: string
  mergeMode: MergeMode
  status: 'active' | 'archived'
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export type ProjectMember = {
  projectId: string
  actorId: string
  username: string
  displayName: string
  role: ProjectRole
  addedByActorId?: string
  addedAt: string
}

export type WorkItem = {
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

export type AcceptanceCriterionInput = {
  statement: string
  criticality: 'normal' | 'critical'
  verificationType: 'deterministic' | 'model' | 'human'
}

export type IntentVersion = {
  id: string
  workItemId: string
  version: number
  goal: string
  constraints: string[]
  riskLevel: RiskLevel
  contentDigest: string
  createdBy: string
  createdAt: string
  acceptanceCriteria: Array<AcceptanceCriterionInput & { id: string; ordinal: number }>
  /** DOMAIN_MODEL.md §6.1: only an approved version may start a Run; a newer version supersedes older ones. */
  status: 'draft' | 'approved' | 'superseded'
  approval?: { basis: 'low_risk_rule' | 'named_approval'; actorId?: string; approvedAt: string; comment?: string }
}

export type ChangeProposal = {
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
  /**
   * Files under `.aperture/` that the head changes relative to the base (DOMAIN_MODEL.md §9.1.1: an agent must not
   * quietly rewrite the rules that govern it). Undefined for proposals created before the scan existed.
   */
  policyFiles?: string[]
  reviewCycleStartedAt: string
  createdAt: string
  updatedAt: string
}

export type MergeEvidence = {
  id: string
  changeProposalId: string
  baseRef: string
  baseShaBefore: string
  approvedHeadSha: string
  mergedSha: string
  strategy: 'fast_forward' | 'host_merge'
  /** Present for `host_merge` only: what the host reported, and why the merge falls outside the gate if it does. */
  hostMerge?: HostMergeRecord
  approvalReviewIds: string[]
  checkIds: string[]
  evidenceIds: string[]
  proposalEventChainHead: string
  evidenceDigest: string
  mergedByActorId: string
  mergedAt: string
}

export type HostMergeRecord = {
  provider: CodeHostKind
  externalId: string
  url: string
  mergedBy?: string
  hostMergedAt?: string
  /** How the merged revision relates to the approved head: contains it, same tree, same patch (squash/rebase), or none. */
  contentCheck: 'ancestor' | 'tree_equal' | 'patch_equal' | 'mismatch'
  /** The pull request's head when it merged; anything but the approved head means unreviewed commits went in. */
  hostHeadSha?: string
  /** The `aperture/gate` status the platform had published for the approved head when the host merged. */
  gateStateAtMerge: 'pending' | 'success' | 'failure' | 'unpublished'
  outsideGate: boolean
  outsideGateReasons: string[]
}

export type CodeHostLink = {
  changeProposalId: string
  projectId: string
  provider: 'github'
  externalId: string
  url: string
  publishedRef: string
  headShaPublished: string
  state: 'open' | 'merged' | 'closed'
  gateStatePublished?: 'pending' | 'success' | 'failure'
  gateShaPublished?: string
  gateDescriptionPublished?: string
  lastError?: string
  syncedAt: string
}

export type ReleaseCandidate = {
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
  approval?: {
    id: string
    approverActorId: string
    comment: string
    candidateContentDigest: string
    approvedAt: string
  }
}

export type ReviewRecord = {
  id: string
  changeProposalId: string
  headSha: string
  reviewerActorId: string
  reviewerDisplayName: string
  reviewerRole: TeamRole
  decision: ReviewDecision
  comment: string
  decisionLatencySeconds: number
  invalidatedAt?: string
  createdAt: string
}

export type ReviewAssignment = {
  id: string
  changeProposalId: string
  assigneeActorId: string
  assigneeDisplayName: string
  assignedByActorId: string
  basis: 'manual' | 'self_claim' | 'load_balanced'
  reason: string
  status: 'pending' | 'in_review' | 'changes_requested' | 'approved' | 'reassigned'
  headSha: string
  reassignedFrom?: string
  assignedAt: string
  dueAt: string
  cycleStartedAt: string
  evidenceOpenedAt?: string
  decidedAt?: string
  timeSpentSeconds?: number
  endedAt?: string
  /** Derived at read time: still undecided past due_at on an open proposal. DOMAIN_MODEL.md §5.8 `expired`. */
  overdue: boolean
}

export type ReviewerLoad = { actorId: string; displayName: string; role: TeamRole; openAssignmentCount: number; identityVerified: boolean; githubLogin?: string }

export type ReviewMetrics = {
  pendingCount: number
  changesRequestedCount: number
  approvedCount: number
  currentDecisionCount: number
  invalidatedDecisionCount: number
  medianDecisionLatencySeconds: number
  oldestPendingSeconds: number
  activeReviewerCount: number
  /**
   * Counts behind the product's falsification criteria, reported as counts rather than rates so that a
   * reader can see the sample size: a 100% expansion rate over one approval is not evidence of anything.
   * `evidenceExpandedApprovalCount` only counts approvals where the approving reviewer had opened the
   * evidence package bound to that revision *before* deciding.
   */
  approvalDecisionCount: number
  evidenceExpandedApprovalCount: number
  decidedProposalCount: number
  firstPassApprovalCount: number
  reworkedProposalCount: number
  acceptedChangeCount: number
}

export type ReviewCheckRecord = {
  id: string
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled'
  evidenceRef?: string
  exitCode?: number
  durationMs?: number
  stdoutDigest?: string
  stderrDigest?: string
  source: 'run' | 'external'
  runId?: string
  startedAt: string
  completedAt?: string
}

export type ReviewEvidenceRecord = {
  id: string
  runId: string
  uri: string
  sha256: string
  summary: Record<string, unknown>
  viewCount: number
  createdAt: string
}

/** Why a Builder was made to stop before it considered the change done. */
export type BuilderStopReason = 'time_budget' | 'step_budget'

export type ReviewReadiness = {
  changeProposalId: string
  headSha: string
  status: 'ready' | 'blocked' | 'incomplete'
  checks: ReviewCheckRecord[]
  evidence: ReviewEvidenceRecord[]
  successfulCheckCount: number
  /** Failed or cancelled checks that still block; a failure waived by an Override Decision is counted in waivedCheckCount instead. */
  failedCheckCount: number
  waivedCheckCount: number
  pendingCheckCount: number
  invalidatedCheckCount: number
  invalidatedEvidenceCount: number
  /** Per acceptance criterion, so the gate can say which promise is unproven rather than only that a check failed. */
  criteria: ReviewCriterionReadiness[]
  blockers: string[]
  /** `.aperture/` files the head changes; approving them needs an owner and a reason. Null: not scanned yet (refresh). */
  policyFiles: string[] | null
  /** The run that produced the current head was stopped at its budget, so the change may be partial; approving it needs a reason. */
  builderStop: { runId: string; reason: BuilderStopReason; summary: string } | null
}

export type CriterionOverride = {
  decisionId: string
  actorId: string
  actorDisplayName: string
  overriddenStatus: 'failed' | 'self_graded' | 'unmapped'
  reason: string
  createdAt: string
}

export type ReviewCriterionReadiness = CriterionCoverage & { status: CriterionStatus | 'overridden'; override?: CriterionOverride }

/** DOMAIN_MODEL.md §6.4 Reject / Override: named, reasoned, and bound to the head revision and evidence it judged. */
export type GovernanceDecision = {
  id: string
  changeProposalId: string
  headSha: string
  decisionType: 'override' | 'reject'
  criterionId?: string
  overriddenStatus?: CriterionOverride['overriddenStatus']
  actorId: string
  reason: string
  evidenceSha256: string[]
  createdAt: string
}

export type AgentRun = {
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
  queuedAt?: string
  workerPid?: number
  cancellationRequestedAt?: string
  startedByActorId: string
  changeProposalId?: string
  exitCode?: number
  stdoutDigest?: string
  stderrDigest?: string
  errorMessage?: string
  startedAt: string
  completedAt?: string
}

export type AgentRunRequest = {
  workItemId: string
  intentVersionId: string
  /** Resolved from the work item's project when omitted; when given it must be that project's repository. */
  repositoryPath?: string
  baseRef: string
  declaredContextPaths: string[]
  changeProposalId?: string
}

export type AgentRunnerDescriptor = {
  id: string
  isolation: AgentRun['isolation']
  status: 'ready' | 'degraded' | 'unavailable'
  productionEligible: boolean
  networkEgress: AgentRun['networkEgress']
  imageRef?: string
  reason?: string
  /** The configured LLM, so the workbench can show what the next run would actually use. */
  model?: string
  modelProvider?: string
}

export interface AgentRunner {
  readonly id: string
  readonly descriptor: AgentRunnerDescriptor
  /** Admits a run and leaves it `queued`. Fast enough to stay inside an HTTP request. */
  prepare(request: AgentRunRequest, actorId: string): AgentRun
  /** Executes an admitted run. Long-running; the Control Plane calls this from a worker process. */
  execute(runId: string): AgentRun
  /** prepare + execute in the calling process. */
  run(request: AgentRunRequest, actorId: string): AgentRun
  /**
   * Removes the worktree this Run created and prunes the administrative entry for it. Idempotent, so the
   * queue can call it again for a run whose worker died before cleaning up. Optional because a runtime that
   * does not create a worktree has nothing to remove.
   */
  cleanUpWorktree?(run: AgentRun, actorId?: string): unknown
}

export type DomainEvent = {
  id: string
  aggregateType: string
  aggregateId: string
  aggregateVersion: number
  eventType: string
  actorId?: string
  payload: Record<string, unknown>
  previousEventDigest: string
  eventDigest: string
  correlationId?: string
  causationId?: string
  occurredAt: string
  recordedAt: string
}

/**
 * The LLM the Builder Agent must use, owned by the Control Plane rather than by the agent CLI's own
 * user-level config. `apiKey` is only ever read on the way to the agent process: it is never returned
 * by the read API and never enters an event, attestation or evidence package.
 */
export type AgentProviderSettings = {
  providerId: string
  model: string
  baseUrl: string
  wireApi: 'responses' | 'chat'
  apiKey?: string
  apiKeyEnv?: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  updatedByActorId: string
  updatedAt: string
}

/** What the API and the UI may see: the same settings with the secret replaced by whether one exists. */
export type AgentProviderSettingsView = Omit<AgentProviderSettings, 'apiKey'> & { apiKeySet: boolean }
