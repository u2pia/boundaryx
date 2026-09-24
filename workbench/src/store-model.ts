import type { IntentItem } from './data'
import type { AgentRunEvent, AttestationVerification, AutonomyDecision, AutonomyDecisionInput, DeploymentResult, EvidenceAttestation, PullRequestCheck, RollbackResult, TelemetryExportBundle, TraceProjection } from './adapters/contracts'
import { verifyEventChain, verifyEventProtocol } from './adapters/event-integrity.ts'
import { verifyTraceProjection } from './adapters/local-trace-provider.ts'
import { verifyTelemetryExportBundle } from './adapters/local-otlp-file-export-provider.ts'
import { LocalAutonomyDecisionProvider } from './adapters/local-autonomy-provider.ts'

export type NotificationTone = 'rose' | 'amber' | 'violet' | 'green' | 'blue'

export type WorkbenchNotification = {
  id: string
  title: string
  detail: string
  page: string
  tone: NotificationTone
}

export type WorkbenchEvent = {
  id: string
  kind: 'approval' | 'review' | 'feedback' | 'intent' | 'evaluation' | 'deployment' | 'telemetry' | 'autonomy'
  title: string
  detail: string
  createdAt: string
}

export type ConvertedSignal = {
  signalId: string
  outputId: string
  outputType: 'intent' | 'regression' | 'research'
  title: string
  sourceRef?: EvidenceSourceRef
}

export type EvidenceSourceRef = {
  kind: 'production_signal' | 'evaluation_failure' | 'trace_span'
  runId?: string
  traceId?: string
  spanId?: string
  projectionDigest?: string
  eventDigest?: string
}

export type RegressionAsset = {
  outputId: string
  sourceSignalId: string
  sourceRef?: EvidenceSourceRef
  fixtureReady: boolean
  graderReady: boolean
  referenceReady: boolean
  trialsRun: number
  baselineCaptured: boolean
  trials: RegressionTrial[]
  passAtK: number
  passPowerK: number
}

export type RegressionTrial = {
  id: string
  batch: number
  seed: string
  result: 'passed' | 'failed'
  durationSeconds: number
  reason: string
}

export type TeamRole = 'owner' | 'maintainer' | 'reviewer' | 'developer'
export type ApprovalCapability = 'manage_team' | 'approve_run' | 'review_change' | 'approve_release' | 'export_telemetry'

export type TelemetryExportRecord = {
  runId: string
  traceId: string
  sourceProjectionDigest: string
  exportDigest: string
  providerId: string
  policyId: string
  policyVersion: string
  exportedSpanCount: number
  droppedSpanCount: number
  destination: 'local_file'
  fileName: string
  exportedBy: string
  exportedAt: string
}

export type AutonomyDecisionRecord = {
  input: AutonomyDecisionInput
  decision: AutonomyDecision
  evaluatedAt: string
}

export type TeamMember = {
  id: string
  initial: string
  name: string
  identity: string
  role: TeamRole
  specialty: string
  seen: string
}

export function roleAllows(role: TeamRole, capability: ApprovalCapability) {
  if (role === 'owner') return true
  if (capability === 'approve_release' || capability === 'manage_team') return false
  if (role === 'maintainer') return true
  if (role === 'reviewer') return capability === 'approve_run' || capability === 'review_change'
  return false
}

export type GitHubImport = {
  externalId: string
  intentId: string
  title: string
  body: string
  state: string
  assignees: string[]
  projectionWritten: boolean
  importedAt: string
}

export type GitHubPullRequestProjection = {
  externalId: string
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
  linkedRunId?: string
  evidenceUri?: string
  projectionWritten: boolean
  importedAt: string
}

export type WorkbenchState = {
  currentActorId: string
  teamMembers: TeamMember[]
  releaseApproved: boolean
  releaseApprovalTarget?: string
  releaseApprovedBy?: string
  deployments: DeploymentResult[]
  rollbacks: RollbackResult[]
  telemetryExports: TelemetryExportRecord[]
  autonomyDecisions: AutonomyDecisionRecord[]
  convertedSignals: ConvertedSignal[]
  regressionAssets: RegressionAsset[]
  githubImports: GitHubImport[]
  githubPullRequests: GitHubPullRequestProjection[]
  derivedIntents: IntentItem[]
  notifications: WorkbenchNotification[]
  events: WorkbenchEvent[]
  liveRun?: {
    runId: string
    label: string
    status: string
    progress: number
    interrupted: boolean
    reviewRequired: boolean
    approved: boolean
    runGateApprovedBy?: string
    reviewDecision?: 'approved' | 'changes_requested'
    reviewDecisionBy?: string
    integrityValid: boolean
    evidencePackage?: {
      uri: string
      digest: string
      finalizedAt: string
      repositoryVerified: boolean
    }
    attestation?: {
      document: EvidenceAttestation
      verification: AttestationVerification
      verifiedAt: string
    }
    traceProjection?: {
      document: TraceProjection
      projectedAt: string
    }
    events: AgentRunEvent[]
  }
}

export type WorkbenchAction =
  | { type: 'switch_actor'; actorId: string }
  | { type: 'approve_release'; targetId: string }
  | { type: 'record_deployment'; deployment: DeploymentResult }
  | { type: 'record_rollback'; rollback: RollbackResult }
  | { type: 'convert_signal'; signalId: string; title: string; outputType: ConvertedSignal['outputType']; sourceRef?: EvidenceSourceRef }
  | { type: 'advance_regression_asset'; outputId: string }
  | { type: 'run_regression_trials'; outputId: string }
  | { type: 'import_github_issue'; issue: Omit<GitHubImport, 'importedAt'> }
  | { type: 'import_github_pull_request'; pullRequest: Omit<GitHubPullRequestProjection, 'importedAt'> }
  | { type: 'finalize_run_evidence'; runId: string; packageUri: string; packageDigest: string; repositoryVerified?: boolean }
  | { type: 'record_run_attestation'; runId: string; attestation: EvidenceAttestation; verification: AttestationVerification }
  | { type: 'record_run_trace'; runId: string; projection: TraceProjection }
  | { type: 'record_telemetry_export'; bundle: TelemetryExportBundle }
  | { type: 'record_autonomy_decision'; input: AutonomyDecisionInput; decision: AutonomyDecision }
  | { type: 'dismiss_notification'; id: string }
  | { type: 'append_run_event'; label: string; event: AgentRunEvent }
  | { type: 'approve_run_review'; runId: string }
  | { type: 'decide_run_review'; runId: string; decision: 'approved' | 'changes_requested' }
  | { type: 'reset' }

export const STORAGE_KEY = 'aperture.workbench-state.v1'

export function releaseId(now = new Date()) {
  return `RC-${new Intl.DateTimeFormat('en-CA').format(now)}-3`
}

export function createInitialState(now = new Date()): WorkbenchState {
  return {
    currentActorId: 'wangzhen',
    teamMembers: [
      { id: 'wangzhen', initial: 'WZ', name: 'Wangzhen', identity: 'github:wangzhen', role: 'owner', specialty: 'Owner · Maintainer', seen: '在线' },
      { id: 'mia-chen', initial: 'MC', name: 'Mia Chen', identity: 'github:mia-chen', role: 'reviewer', specialty: 'Security reviewer', seen: '8 分钟前' },
      { id: 'alex-wu', initial: 'AW', name: 'Alex Wu', identity: 'github:alex-wu', role: 'reviewer', specialty: 'Frontend · Reviewer', seen: '24 分钟前' },
      { id: 'noah-li', initial: 'NW', name: 'Noah Li', identity: 'github:noah-li', role: 'maintainer', specialty: 'Runtime · Maintainer', seen: '1 小时前' },
      { id: 'jason-liu', initial: 'JL', name: 'Jason Liu', identity: 'github:jason-liu', role: 'developer', specialty: 'Backend engineer', seen: '2 小时前' },
    ],
    releaseApproved: false,
    releaseApprovalTarget: undefined,
    releaseApprovedBy: undefined,
    deployments: [],
    rollbacks: [],
    telemetryExports: [],
    autonomyDecisions: [],
    convertedSignals: [],
    regressionAssets: [],
    githubImports: [],
    githubPullRequests: [],
    derivedIntents: [],
    notifications: [
      { id: 'notice-review', title: '高风险变更等待审查', detail: 'INT-142 · 已等待 38 分钟', page: '评审队列', tone: 'rose' },
      { id: 'notice-release', title: '发布门禁等待授权', detail: `${releaseId(now)} · Production`, page: '发布', tone: 'amber' },
      { id: 'notice-eval', title: '评估出现 3 个回归', detail: '2 项正在阻断发布', page: '评估', tone: 'violet' },
    ],
    events: [],
    liveRun: undefined,
  }
}

function createEvent(kind: WorkbenchEvent['kind'], title: string, detail: string, now: Date): WorkbenchEvent {
  return {
    id: `EVT-${now.getTime()}`,
    kind,
    title,
    detail,
    createdAt: new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(now),
  }
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction, now = new Date()): WorkbenchState {
  if (action.type === 'switch_actor') {
    if (state.currentActorId === action.actorId || !state.teamMembers.some((member) => member.id === action.actorId)) return state
    return { ...state, currentActorId: action.actorId }
  }

  if (action.type === 'approve_release') {
    const actor = state.teamMembers.find((member) => member.id === state.currentActorId)
    if (!actor || !roleAllows(actor.role, 'approve_release')) return state
    const authoritativePullRequest = state.githubPullRequests[0]
    const pullRequestReady = !authoritativePullRequest || (authoritativePullRequest.reviewDecision === 'approved' && authoritativePullRequest.checks.every((check) => check.status === 'completed' && check.conclusion !== 'failure' && check.conclusion !== 'cancelled'))
    const proposedContract = state.liveRun?.events.find((event) => event.type === 'work_contract_proposed')
    const contractReady = !proposedContract || state.liveRun?.events.some((event) => event.type === 'work_contract_reviewed' && event.contractId === proposedContract.contractId && event.contractDigest === proposedContract.contractDigest && event.decision === 'accepted' && event.evaluatorRef !== event.generatorRef)
    const managedRun = state.liveRun?.events.some((event) => event.type === 'runtime_bound') ?? false
    const sandboxAttestation = state.liveRun?.events.find((event) => event.type === 'sandbox_attested')
    const sandboxReady = !managedRun || Boolean(sandboxAttestation?.type === 'sandbox_attested' && sandboxAttestation.status === 'verified' && sandboxAttestation.ephemeral && sandboxAttestation.networkEgress !== 'unrestricted' && sandboxAttestation.secretMounts.length === 0)
    const evidenceReady = state.liveRun?.reviewDecision === 'approved'
      ? Boolean(state.liveRun.integrityValid && state.liveRun.evidencePackage?.repositoryVerified && contractReady && sandboxReady)
      : authoritativePullRequest ? Boolean(authoritativePullRequest.evidenceUri) : true
    if (!pullRequestReady || !evidenceReady) return state
    if (state.releaseApproved && state.releaseApprovalTarget === action.targetId) return state
    return {
      ...state,
      releaseApproved: true,
      releaseApprovalTarget: action.targetId,
      releaseApprovedBy: actor.identity,
      notifications: state.notifications.filter((notification) => notification.id !== 'notice-release'),
      events: [createEvent('approval', '生产发布已具名批准', `${action.targetId} · ${actor.identity}`, now), ...state.events],
    }
  }

  if (action.type === 'record_deployment') {
    const deployment = action.deployment
    if (!state.releaseApproved || state.releaseApprovalTarget !== deployment.releaseCandidateId || state.releaseApprovedBy !== deployment.approvedBy) return state
    if (deployment.environment !== 'production' || deployment.status !== 'succeeded' || state.deployments.some((item) => item.deploymentId === deployment.deploymentId)) return state
    const authoritativePullRequest = state.githubPullRequests[0]
    if (authoritativePullRequest && authoritativePullRequest.headSha !== deployment.headSha) return state
    const evidenceUri = state.liveRun?.evidencePackage?.repositoryVerified ? state.liveRun.evidencePackage.uri : authoritativePullRequest?.evidenceUri
    if (evidenceUri && evidenceUri !== deployment.evidenceUri) return state
    return {
      ...state,
      deployments: [deployment, ...state.deployments],
      notifications: [{ id: `notice-deployment-${deployment.deploymentId}`, title: `${deployment.releaseCandidateId} 已部署到 Production`, detail: `${deployment.deploymentId} · ${deployment.headSha.slice(0, 7)} · rollback ready`, page: '发布', tone: 'green' }, ...state.notifications],
      events: [createEvent('deployment', 'Production 部署完成', `${deployment.releaseCandidateId} · ${deployment.deploymentId} · ${deployment.artifactDigest}`, now), ...state.events],
    }
  }

  if (action.type === 'record_rollback') {
    const rollback = action.rollback
    const deployment = state.deployments.find((item) => item.deploymentId === rollback.deploymentId)
    const actor = state.teamMembers.find((member) => member.identity === rollback.requestedBy)
    if (!deployment || !actor || !roleAllows(actor.role, 'approve_release') || rollback.status !== 'succeeded') return state
    if (deployment.releaseCandidateId !== rollback.releaseCandidateId || deployment.rollbackRef !== rollback.rollbackRef || state.rollbacks.some((item) => item.rollbackId === rollback.rollbackId)) return state
    return {
      ...state,
      rollbacks: [rollback, ...state.rollbacks],
      notifications: [{ id: `notice-rollback-${rollback.rollbackId}`, title: `${rollback.releaseCandidateId} 已完成 Production 回滚`, detail: `${rollback.rollbackId} · ${rollback.requestedBy} · restored`, page: '发布', tone: 'amber' }, ...state.notifications],
      events: [createEvent('deployment', 'Production 回滚完成', `${rollback.releaseCandidateId} · ${rollback.rollbackId} · ${rollback.restoredArtifactDigest}`, now), ...state.events],
    }
  }

  if (action.type === 'convert_signal') {
    if (state.convertedSignals.some((signal) => signal.signalId === action.signalId)) return state
    const sequence = state.convertedSignals.length + 143
    const outputId = action.outputType === 'regression' ? `REG-${sequence}` : `INT-${sequence}`
    const converted: ConvertedSignal = { signalId: action.signalId, outputId, outputType: action.outputType, title: action.title, sourceRef: action.sourceRef }
    const derivedIntent: IntentItem | null = action.outputType === 'regression' ? null : {
      id: outputId,
      title: action.title,
      stage: 'Intent',
      risk: action.outputType === 'research' ? '低' : '中',
      owner: 'WZ',
      criteria: '0/3',
      updated: '刚刚',
      source: action.signalId,
    }
    return {
      ...state,
      convertedSignals: [...state.convertedSignals, converted],
      regressionAssets: action.outputType === 'regression' ? [...state.regressionAssets, { outputId, sourceSignalId: action.signalId, sourceRef: action.sourceRef, fixtureReady: false, graderReady: false, referenceReady: false, trialsRun: 0, baselineCaptured: false, trials: [], passAtK: 0, passPowerK: 0 }] : state.regressionAssets,
      derivedIntents: derivedIntent ? [derivedIntent, ...state.derivedIntents] : state.derivedIntents,
      notifications: [
        { id: `notice-${action.signalId}`, title: `${outputId} 已从${action.sourceRef?.kind === 'trace_span' ? '失败 Trace' : '生产信号'}创建`, detail: action.title, page: action.outputType === 'regression' ? '评估' : 'Intents', tone: 'green' },
        ...state.notifications,
      ],
      events: [createEvent(action.outputType === 'regression' ? 'evaluation' : 'intent', `${outputId} 已创建`, `来源 ${action.signalId}${action.sourceRef?.traceId ? ` · Trace ${action.sourceRef.traceId}` : ''} · ${action.title}`, now), ...state.events],
    }
  }

  if (action.type === 'advance_regression_asset') {
    const asset = state.regressionAssets.find((item) => item.outputId === action.outputId)
    if (!asset || (asset.fixtureReady && asset.graderReady && asset.referenceReady)) return state
    const updated = !asset.fixtureReady ? { ...asset, fixtureReady: true } : !asset.graderReady ? { ...asset, graderReady: true } : { ...asset, referenceReady: true }
    const completedPart = !asset.fixtureReady ? 'Fixture' : !asset.graderReady ? 'Deterministic Grader' : 'Reference Solution'
    return {
      ...state,
      regressionAssets: state.regressionAssets.map((item) => item.outputId === action.outputId ? updated : item),
      events: [createEvent('evaluation', `${action.outputId} 已配置 ${completedPart}`, `Evaluation asset · ${action.outputId}`, now), ...state.events],
    }
  }

  if (action.type === 'run_regression_trials') {
    const asset = state.regressionAssets.find((item) => item.outputId === action.outputId)
    if (!asset || !asset.fixtureReady || !asset.graderReady || !asset.referenceReady) return state
    const batch = Math.floor(asset.trialsRun / 3) + 1
    const outcomes: RegressionTrial['result'][] = batch === 1 ? ['passed', 'failed', 'passed'] : ['passed', 'passed', 'passed']
    const seeds = ['a18f', 'bc41', 'd902']
    const durations = [72, 78, 66]
    const trials = outcomes.map((result, index): RegressionTrial => ({
      id: `${action.outputId}-B${batch}-T${index + 1}`,
      batch,
      seed: seeds[index],
      result,
      durationSeconds: durations[index] + (batch - 1) * 3,
      reason: result === 'passed' ? '确定性 Grader 通过，预期失败可复现' : '同一 Seed 下未稳定复现，需检查环境或任务歧义',
    }))
    const passed = trials.filter((trial) => trial.result === 'passed').length
    const passAtK = passed > 0 ? 100 : 0
    const passPowerK = passed === trials.length ? 100 : 0
    return {
      ...state,
      regressionAssets: state.regressionAssets.map((item) => item.outputId === action.outputId ? { ...item, trialsRun: item.trialsRun + trials.length, baselineCaptured: true, trials: [...item.trials, ...trials], passAtK, passPowerK } : item),
      notifications: [
        { id: `notice-${action.outputId}-baseline-${batch}`, title: `${action.outputId} Trial Batch ${batch} 完成`, detail: `pass@3 ${passAtK}% · pass³ ${passPowerK}%`, page: '评估', tone: passPowerK === 100 ? 'green' : 'amber' },
        ...state.notifications,
      ],
      events: [createEvent('evaluation', `${action.outputId} Trial Batch ${batch} 完成`, `${passed} / ${trials.length} passed · pass@3 ${passAtK}% · pass³ ${passPowerK}%`, now), ...state.events],
    }
  }

  if (action.type === 'import_github_issue') {
    if (state.githubImports.some((item) => item.externalId === action.issue.externalId)) return state
    const owner = action.issue.assignees[0]?.split(/[-_]/).map((part) => part[0]?.toUpperCase()).join('') || 'UN'
    const importedAt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(now)
    return {
      ...state,
      githubImports: [{ ...action.issue, importedAt }, ...state.githubImports],
      derivedIntents: [{ id: action.issue.intentId, title: action.issue.title, stage: 'Intent', risk: '中', owner, criteria: '0/3', updated: '刚刚', source: `github:#${action.issue.externalId}` }, ...state.derivedIntents],
      notifications: [
        { id: `notice-github-${action.issue.externalId}`, title: `${action.issue.intentId} 已从 GitHub 导入`, detail: `Issue #${action.issue.externalId} · 权威状态仍由 GitHub 管理`, page: 'Intents', tone: 'green' },
        ...state.notifications,
      ],
      events: [createEvent('intent', `${action.issue.intentId} 已从 GitHub Issue 创建`, `github:#${action.issue.externalId} · projection written`, now), ...state.events],
    }
  }

  if (action.type === 'import_github_pull_request') {
    if (state.githubPullRequests.some((item) => item.externalId === action.pullRequest.externalId && item.headSha === action.pullRequest.headSha)) return state
    const importedAt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(now)
    const failedChecks = action.pullRequest.checks.filter((check) => check.conclusion === 'failure').length
    const currentProjection = state.githubPullRequests[0]
    const candidateChanged = Boolean(currentProjection && (currentProjection.externalId !== action.pullRequest.externalId || currentProjection.headSha !== action.pullRequest.headSha))
    const pullRequestReady = action.pullRequest.reviewDecision === 'approved' && action.pullRequest.checks.every((check) => check.status === 'completed' && check.conclusion !== 'failure' && check.conclusion !== 'cancelled')
    const revokeRelease = candidateChanged || !pullRequestReady
    return {
      ...state,
      releaseApproved: revokeRelease ? false : state.releaseApproved,
      releaseApprovalTarget: revokeRelease ? undefined : state.releaseApprovalTarget,
      releaseApprovedBy: revokeRelease ? undefined : state.releaseApprovedBy,
      githubPullRequests: [{ ...action.pullRequest, importedAt }, ...state.githubPullRequests.filter((item) => item.externalId !== action.pullRequest.externalId)],
      notifications: [
        { id: `notice-github-pr-${action.pullRequest.externalId}-${action.pullRequest.headSha}`, title: `PR #${action.pullRequest.externalId} 权威快照已更新`, detail: `${action.pullRequest.reviewDecision} · ${failedChecks} failed checks`, page: '集成', tone: failedChecks || action.pullRequest.reviewDecision !== 'approved' ? 'amber' : 'green' },
        ...state.notifications,
      ],
      events: [createEvent('review', `PR #${action.pullRequest.externalId} 快照已投影`, `${action.pullRequest.headSha} · ${action.pullRequest.reviewDecision} · ${action.pullRequest.projectionWritten ? 'evidence written' : 'read only'}`, now), ...state.events],
    }
  }

  if (action.type === 'dismiss_notification') {
    return { ...state, notifications: state.notifications.filter((notification) => notification.id !== action.id) }
  }

  if (action.type === 'append_run_event') {
    const progressByEvent: Record<AgentRunEvent['type'], number> = {
      run_started: 5,
      runtime_bound: 8,
      sandbox_attested: 9,
      harness_profile_selected: 10,
      workflow_bound: 10,
      policy_bundle_bound: 10,
      roadmap_created: 11,
      roadmap_updated: 95,
      sprint_planned: 12,
      plan_created: 12,
      work_contract_proposed: 13,
      work_contract_reviewed: 14,
      context_scope_created: 16,
      context_requested: 20,
      context_consumed: 25,
      context_note_written: 30,
      context_reset_decided: 75,
      context_compacted: 76,
      usage_reported: 75,
      activity_attempt_started: 34,
      tool_requested: 38,
      policy_decided: 50,
      activity_failed: 52,
      activity_retry_scheduled: 54,
      activity_completed: 58,
      artifact_created: 68,
      ci_evidence_ingested: 74,
      checkpoint_saved: 78,
      checkpoint_restored: 35,
      evaluation_experiment_bound: 82,
      evaluation_completed: 86,
      evaluation_diagnosed: 90,
      run_completed: 100,
    }
    const statusByEvent: Record<AgentRunEvent['type'], string> = {
      run_started: '启动中',
      runtime_bound: '绑定运行时',
      sandbox_attested: action.event.type === 'sandbox_attested' && action.event.status === 'verified' ? 'Sandbox 已验证' : 'Sandbox 验证失败',
      harness_profile_selected: '选择 Harness',
      workflow_bound: '绑定 Durable Workflow',
      policy_bundle_bound: '绑定 Policy Bundle',
      roadmap_created: '创建 Roadmap',
      roadmap_updated: '更新 Roadmap',
      sprint_planned: '规划 Sprint',
      plan_created: '规划中',
      work_contract_proposed: '协商工作契约',
      work_contract_reviewed: action.event.type === 'work_contract_reviewed' && action.event.decision === 'accepted' && action.event.evaluatorRef !== action.event.generatorRef ? '工作契约已确认' : '工作契约需修订',
      context_scope_created: '隔离上下文',
      context_requested: '请求上下文',
      context_consumed: '编译上下文',
      context_note_written: '写入结构化笔记',
      context_reset_decided: action.event.type === 'context_reset_decided' ? `上下文策略：${action.event.action}` : '核对上下文策略',
      context_compacted: '压缩上下文',
      usage_reported: '核对运行预算',
      activity_attempt_started: action.event.type === 'activity_attempt_started' ? `执行 Activity · attempt ${action.event.attempt}` : '执行 Activity',
      tool_requested: '执行中',
      policy_decided: '策略检查',
      activity_failed: action.event.type === 'activity_failed' && action.event.retryable ? 'Activity 可重试失败' : 'Activity 已阻断',
      activity_retry_scheduled: action.event.type === 'activity_retry_scheduled' ? `重试已调度 · attempt ${action.event.nextAttempt}` : '重试已调度',
      activity_completed: 'Activity 已完成',
      artifact_created: '生成产物',
      ci_evidence_ingested: '采集 CI 证据',
      checkpoint_saved: '保存检查点',
      checkpoint_restored: '恢复检查点',
      evaluation_experiment_bound: '绑定 Evaluation Experiment',
      evaluation_completed: '评估完成',
      evaluation_diagnosed: '评估失败已归因',
      run_completed: action.event.type === 'run_completed' && action.event.status === 'succeeded' ? '已完成' : '已结束',
    }
    const previousEvents = state.liveRun?.runId === action.event.runId ? state.liveRun.events : []
    const events = [...previousEvents, action.event]
    const chainValid = verifyEventChain(events)
    const protocolValid = verifyEventProtocol(events)
    const integrityValid = (state.liveRun?.runId === action.event.runId ? state.liveRun.integrityValid ?? true : true) && chainValid && protocolValid
    const previousReviewRequired = state.liveRun?.runId === action.event.runId ? state.liveRun.reviewRequired ?? false : false
    const reviewRequired = previousReviewRequired
      || (action.event.type === 'evaluation_completed' && action.event.failed > 0)
      || (action.event.type === 'ci_evidence_ingested' && action.event.status === 'failed')
      || (action.event.type === 'usage_reported' && action.event.decision.status === 'exceeded')
      || (action.event.type === 'work_contract_reviewed' && (action.event.decision === 'revision_required' || action.event.evaluatorRef === action.event.generatorRef))
      || (action.event.type === 'sandbox_attested' && action.event.status === 'failed')
    const status = !chainValid ? '事件完整性失败' : !protocolValid ? '运行协议失败' : action.event.type === 'run_completed' && reviewRequired ? '等待人工评审' : statusByEvent[action.event.type]
    return {
      ...state,
      liveRun: {
        runId: action.event.runId,
        label: action.label,
        status,
        progress: integrityValid ? progressByEvent[action.event.type] : state.liveRun?.runId === action.event.runId ? state.liveRun.progress : 0,
        interrupted: false,
        reviewRequired,
        approved: false,
        runGateApprovedBy: undefined,
        reviewDecision: undefined,
        reviewDecisionBy: undefined,
        integrityValid,
        evidencePackage: state.liveRun?.runId === action.event.runId ? state.liveRun.evidencePackage : undefined,
        attestation: state.liveRun?.runId === action.event.runId ? state.liveRun.attestation : undefined,
        traceProjection: state.liveRun?.runId === action.event.runId ? state.liveRun.traceProjection : undefined,
        events,
      },
    }
  }

  if (action.type === 'finalize_run_evidence') {
    if (!state.liveRun || state.liveRun.runId !== action.runId || !state.liveRun.integrityValid || state.liveRun.events.at(-1)?.type !== 'run_completed') return state
    return {
      ...state,
      liveRun: {
        ...state.liveRun,
        attestation: state.liveRun.evidencePackage?.uri === action.packageUri && state.liveRun.evidencePackage.digest === action.packageDigest ? state.liveRun.attestation : undefined,
        evidencePackage: {
          uri: action.packageUri,
          digest: action.packageDigest,
          finalizedAt: new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(now),
          repositoryVerified: action.repositoryVerified ?? false,
        },
      },
      events: [createEvent('evaluation', `${action.runId} Evidence Package 已封存`, `${action.packageDigest} · ${action.packageUri}`, now), ...state.events],
    }
  }

  if (action.type === 'record_run_attestation') {
    if (!state.liveRun || state.liveRun.runId !== action.runId || !state.liveRun.integrityValid || !state.liveRun.evidencePackage?.repositoryVerified) return state
    const statement = action.attestation.statement
    const subject = statement.subject[0]
    const bindingValid = statement.predicate.runId === action.runId && statement.predicate.evidenceUri === state.liveRun.evidencePackage.uri && statement.predicate.repositoryDigest === state.liveRun.evidencePackage.digest && statement.predicate.chainHead === state.liveRun.events.at(-1)?.eventDigest && statement.predicate.eventCount === state.liveRun.events.length && subject?.name === state.liveRun.evidencePackage.uri
    const verification = bindingValid ? action.verification : { ...action.verification, valid: false, reasons: [...action.verification.reasons, 'Attestation predicate does not bind the active Evidence Package'] }
    return {
      ...state,
      liveRun: {
        ...state.liveRun,
        attestation: {
          document: action.attestation,
          verification,
          verifiedAt: new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(now),
        },
      },
      events: [createEvent('evaluation', `${action.runId} Evidence Attestation ${verification.valid ? '已验证' : '复验失败'}`, `${action.attestation.keyId} · identity unanchored`, now), ...state.events],
    }
  }

  if (action.type === 'record_run_trace') {
    if (!state.liveRun || state.liveRun.runId !== action.runId || !state.liveRun.integrityValid || state.liveRun.events.at(-1)?.type !== 'run_completed') return state
    const root = action.projection.spans[0]
    if (!verifyTraceProjection(action.projection) || action.projection.runId !== action.runId || root?.attributes['aperture.event.count'] !== state.liveRun.events.length || root?.attributes['aperture.chain.head'] !== state.liveRun.events.at(-1)?.eventDigest) return state
    return {
      ...state,
      liveRun: { ...state.liveRun, traceProjection: { document: action.projection, projectedAt: new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(now) } },
      events: [createEvent('evaluation', `${action.runId} Trace Projection 已生成`, `${action.projection.traceId} · ${action.projection.spans.length} spans`, now), ...state.events],
    }
  }

  if (action.type === 'record_telemetry_export') {
    const actor = state.teamMembers.find((member) => member.id === state.currentActorId)
    const trace = state.liveRun?.traceProjection?.document
    const bundle = action.bundle
    if (!actor || !roleAllows(actor.role, 'export_telemetry') || !trace || !verifyTelemetryExportBundle(bundle)) return state
    if (bundle.runId !== state.liveRun?.runId || bundle.traceId !== trace.traceId || bundle.sourceProjectionDigest !== trace.projectionDigest) return state
    if (state.telemetryExports.some((record) => record.exportDigest === bundle.exportDigest)) return state
    const exportedAt = now.toISOString()
    const record: TelemetryExportRecord = {
      runId: bundle.runId,
      traceId: bundle.traceId,
      sourceProjectionDigest: bundle.sourceProjectionDigest,
      exportDigest: bundle.exportDigest,
      providerId: bundle.providerId,
      policyId: bundle.policy.policyId,
      policyVersion: bundle.policy.policyVersion,
      exportedSpanCount: bundle.exportedSpanCount,
      droppedSpanCount: bundle.droppedSpanCount,
      destination: bundle.policy.destination,
      fileName: bundle.fileName,
      exportedBy: actor.identity,
      exportedAt,
    }
    return {
      ...state,
      telemetryExports: [record, ...state.telemetryExports],
      notifications: [{ id: `notice-telemetry-${bundle.exportDigest}`, title: `${bundle.runId} Telemetry Bundle 已导出`, detail: `${actor.identity} · ${bundle.exportedSpanCount} exported · ${bundle.droppedSpanCount} dropped`, page: '追溯', tone: 'blue' }, ...state.notifications],
      events: [createEvent('telemetry', 'Telemetry Bundle 已具名导出', `${bundle.fileName} · ${actor.identity} · ${bundle.exportDigest}`, now), ...state.events],
    }
  }

  if (action.type === 'record_autonomy_decision') {
    const verified = new LocalAutonomyDecisionProvider().evaluate(action.input)
    if (verified.decisionDigest !== action.decision.decisionDigest || verified.inputDigest !== action.decision.inputDigest || verified.decision !== action.decision.decision) return state
    if (state.autonomyDecisions.some((record) => record.decision.decisionDigest === action.decision.decisionDigest)) return state
    const record: AutonomyDecisionRecord = { input: structuredClone(action.input), decision: structuredClone(action.decision), evaluatedAt: now.toISOString() }
    return {
      ...state,
      autonomyDecisions: [record, ...state.autonomyDecisions],
      events: [createEvent('autonomy', '自治资格已重新评估', `${action.input.candidateId} · ${action.decision.decision} · ${action.decision.decisionDigest}`, now), ...state.events],
    }
  }

  if (action.type === 'approve_run_review') {
    const actor = state.teamMembers.find((member) => member.id === state.currentActorId)
    if (!actor || !roleAllows(actor.role, 'approve_run') || !state.liveRun || state.liveRun.runId !== action.runId || !state.liveRun.integrityValid || !state.liveRun.reviewRequired || state.liveRun.approved) return state
    return {
      ...state,
      liveRun: { ...state.liveRun, approved: true, runGateApprovedBy: actor.identity, status: '已批准进入评审' },
      notifications: [
        { id: `notice-${action.runId}-approved`, title: `${action.runId} 已完成人工门禁`, detail: '评估失败已被具名审阅，可进入变更评审', page: '评审队列', tone: 'green' },
        ...state.notifications,
      ],
      events: [createEvent('approval', `${action.runId} 已批准进入评审`, `评估异常由 ${actor.identity} 具名确认`, now), ...state.events],
    }
  }

  if (action.type === 'decide_run_review') {
    const actor = state.teamMembers.find((member) => member.id === state.currentActorId)
    if (!actor || !roleAllows(actor.role, 'review_change') || !state.liveRun || state.liveRun.runId !== action.runId || !state.liveRun.integrityValid || !state.liveRun.approved || state.liveRun.reviewDecision === action.decision) return state
    const approved = action.decision === 'approved'
    return {
      ...state,
      liveRun: { ...state.liveRun, reviewDecision: action.decision, reviewDecisionBy: actor.identity, status: approved ? '变更已批准' : '评审要求修改' },
      notifications: [
        { id: `notice-${action.runId}-review-${action.decision}`, title: approved ? `${action.runId} 变更评审已批准` : `${action.runId} 已请求修改`, detail: approved ? '可以准备发布候选' : '返回 Agent Runs 处理评审意见', page: approved ? '发布' : 'Agent Runs', tone: approved ? 'green' : 'amber' },
        ...state.notifications,
      ],
      events: [createEvent('review', approved ? `${action.runId} 变更评审通过` : `${action.runId} 评审要求修改`, `${actor.identity} · ${approved ? 'approved' : 'changes requested'}`, now), ...state.events],
    }
  }

  if (action.type === 'reset') return createInitialState(now)
  return state
}
