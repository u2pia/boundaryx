import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LocalControlPlaneApiError, localControlPlaneClient, onSessionExpired, type LocalActor, type LocalActorUpdate, type LocalIdentityMode, type LocalAgentProviderInput, type LocalAgentProviderSettings, type LocalAgentRun, type LocalAgentRunDetail, type LocalAgentRuntimeDescriptor, type LocalChangeProposal, type LocalDomainEvent, type LocalEvidencePackageView, type LocalCodeHostConnection, LocalCodeHostLink, LocalCodeHostSyncReport, type LocalIntentVersion, type LocalMergeEvidence, type LocalProject, type LocalProjectInput, type LocalProjectMember, type LocalProjectRole, type LocalReleaseCandidate, type LocalReviewMetrics, type LocalReviewAssignment, type LocalReviewerLoad, type LocalReviewReadiness, type LocalReviewRecord, type LocalWorkItem } from './local-control-plane-client'

export type LocalControlPlaneStatus = 'connecting' | 'offline' | 'setup_required' | 'unauthenticated' | 'ready' | 'error'

type IntentBundleInput = {
  title: string
  description: string
  productType: LocalWorkItem['productType']
  goal: string
  constraints: string[]
  riskLevel: LocalIntentVersion['riskLevel']
  // 起草人声明每条标准如何被证明。这两个字段进入 contentDigest、Evidence Package 和 Builder Agent 的
  // prompt，所以不能由这一层代填——代填出来的「全部确定性关键」是一句谎话。
  // verifiedBy 是起草人声明的「这条标准由哪些 check 证明」，同样进入 contentDigest。
  acceptanceCriteria: Array<{ statement: string; criticality: 'normal' | 'critical'; verificationType: 'deterministic' | 'model' | 'human'; verifiedBy?: string[] }>
}

// The repository is never named here: the server resolves it from the work item's project.
type ChangeProposalInput = {
  workItemId: string
  intentVersionId: string
  baseRef?: string
  headRef: string
}

type AgentRunInput = {
  workItemId: string
  intentVersionId: string
  baseRef?: string
  declaredContextPaths: string[]
}

const PROJECT_STORAGE_KEY = 'aperture.currentProjectId'

type LocalControlPlaneContextValue = {
  status: LocalControlPlaneStatus
  agentRunnerId?: string
  agentRuntime?: LocalAgentRuntimeDescriptor
  actor?: LocalActor
  actors: LocalActor[]
  /** Projects this actor can see; every list below is scoped to `currentProjectId`. */
  projects: LocalProject[]
  projectRoles: Record<string, LocalActor['role'] | undefined>
  currentProjectId?: string
  currentProject?: LocalProject
  /** The caller's role in the current project — what the UI should gate on, not `actor.role`. */
  currentProjectRole?: LocalActor['role']
  projectMembers: LocalProjectMember[]
  workItems: LocalWorkItem[]
  intentVersions: LocalIntentVersion[]
  agentRuns: LocalAgentRun[]
  changeProposals: LocalChangeProposal[]
  codeHostLinks: LocalCodeHostLink[]
  lastSync?: LocalCodeHostSyncReport
  releaseCandidates: LocalReleaseCandidate[]
  reviews: LocalReviewRecord[]
  reviewMetrics: LocalReviewMetrics
  reviewReadiness: LocalReviewReadiness[]
  reviewAssignments: LocalReviewAssignment[]
  reviewerLoad: LocalReviewerLoad[]
  events: LocalDomainEvent[]
  agentProvider?: LocalAgentProviderSettings
  /** Environment variable the agent process receives the stored key under, shown so operators can trace it. */
  agentProviderKeyVariable: string
  /** False for roles that may not read the provider setting, so the UI can hide the form instead of erroring. */
  agentProviderReadable: boolean
  identityMode: LocalIdentityMode
  githubConfigured: boolean
  /** Outcome of the last GitHub round trip, read once from the callback's query string. */
  identityNotice?: { tone: 'success' | 'error'; code: string }
  /** The last session ended on its own (8 h lifetime, reset password, disabled account) rather than by signing out. */
  sessionExpired: boolean
  error?: string
  refresh: () => Promise<void>
  declareIdentity: (actorId: string, githubLogin: string) => Promise<void>
  setIdentityMode: (mode: LocalIdentityMode) => Promise<void>
  setup: (input: { username: string; displayName: string; password: string }) => Promise<void>
  login: (input: { username: string; password: string }) => Promise<void>
  logout: () => Promise<void>
  createActor: (input: { username: string; displayName: string; role: LocalActor['role']; password: string; projectIds?: string[] }) => Promise<void>
  updateActor: (actorId: string, input: LocalActorUpdate) => Promise<void>
  selectProject: (projectId: string) => Promise<void>
  createProject: (input: LocalProjectInput & { slug: string; name: string }) => Promise<LocalProject>
  updateProject: (projectId: string, input: LocalProjectInput) => Promise<void>
  archiveProject: (projectId: string) => Promise<void>
  testProjectConnection: (projectId: string) => Promise<LocalCodeHostConnection>
  syncProject: (projectId: string) => Promise<LocalCodeHostSyncReport>
  setProjectMember: (projectId: string, actorId: string, role: LocalProjectRole) => Promise<void>
  removeProjectMember: (projectId: string, actorId: string) => Promise<void>
  createIntentBundle: (input: IntentBundleInput) => Promise<void>
  startAgentRun: (input: AgentRunInput) => Promise<number | undefined>
  cancelAgentRun: (runId: string) => Promise<void>
  getAgentRunDetail: (runId: string) => Promise<LocalAgentRunDetail>
  saveAgentProvider: (input: LocalAgentProviderInput) => Promise<void>
  createChangeProposal: (input: ChangeProposalInput) => Promise<void>
  refreshChangeProposal: (proposalId: string) => Promise<{ changed: boolean; invalidated: { reviews: number; checks: number; evidence: number } }>
  reviewChangeProposal: (proposal: LocalChangeProposal, decision: 'approved' | 'changes_requested', comment: string) => Promise<void>
  overrideCriterion: (proposal: LocalChangeProposal, criterionId: string, reason: string) => Promise<void>
  rejectChangeProposal: (proposal: LocalChangeProposal, reason: string) => Promise<void>
  assignReviewer: (proposalId: string, input: { assigneeActorId?: string; dueHours?: number; reason?: string }) => Promise<void>
  approveIntentVersion: (intentVersionId: string, comment: string) => Promise<void>
  mergeChangeProposal: (proposalId: string) => Promise<LocalMergeEvidence>
  reviseChangeProposal: (proposalId: string) => Promise<void>
  createReleaseCandidate: (proposalId: string) => Promise<void>
  approveReleaseCandidate: (candidateId: string, comment: string) => Promise<void>
  viewEvidence: (evidenceId: string) => Promise<LocalEvidencePackageView>
}

const LocalControlPlaneContext = createContext<LocalControlPlaneContextValue | null>(null)

export function LocalControlPlaneProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LocalControlPlaneStatus>('connecting')
  const [agentRunnerId, setAgentRunnerId] = useState<string>()
  const [agentRuntime, setAgentRuntime] = useState<LocalAgentRuntimeDescriptor>()
  const [actor, setActor] = useState<LocalActor>()
  const [actors, setActors] = useState<LocalActor[]>([])
  const [projects, setProjects] = useState<LocalProject[]>([])
  const [projectRoles, setProjectRoles] = useState<Record<string, LocalActor['role'] | undefined>>({})
  const [projectMembers, setProjectMembers] = useState<LocalProjectMember[]>([])
  // The ref is what loads read (so a reload never races a stale closure); the state is what renders.
  const projectIdRef = useRef<string | undefined>(window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? undefined)
  const [currentProjectId, setCurrentProjectId] = useState<string | undefined>(projectIdRef.current)
  const [workItems, setWorkItems] = useState<LocalWorkItem[]>([])
  const [intentVersions, setIntentVersions] = useState<LocalIntentVersion[]>([])
  const [agentRuns, setAgentRuns] = useState<LocalAgentRun[]>([])
  const [changeProposals, setChangeProposals] = useState<LocalChangeProposal[]>([])
  const [codeHostLinks, setCodeHostLinks] = useState<LocalCodeHostLink[]>([])
  const [lastSync, setLastSync] = useState<LocalCodeHostSyncReport>()
  const [releaseCandidates, setReleaseCandidates] = useState<LocalReleaseCandidate[]>([])
  const [reviews, setReviews] = useState<LocalReviewRecord[]>([])
  const [reviewMetrics, setReviewMetrics] = useState<LocalReviewMetrics>({ pendingCount: 0, changesRequestedCount: 0, approvedCount: 0, currentDecisionCount: 0, invalidatedDecisionCount: 0, medianDecisionLatencySeconds: 0, oldestPendingSeconds: 0, activeReviewerCount: 0, approvalDecisionCount: 0, evidenceExpandedApprovalCount: 0, decidedProposalCount: 0, firstPassApprovalCount: 0, reworkedProposalCount: 0, acceptedChangeCount: 0 })
  const [reviewReadiness, setReviewReadiness] = useState<LocalReviewReadiness[]>([])
  const [reviewAssignments, setReviewAssignments] = useState<LocalReviewAssignment[]>([])
  const [reviewerLoad, setReviewerLoad] = useState<LocalReviewerLoad[]>([])
  const [events, setEvents] = useState<LocalDomainEvent[]>([])
  const [agentProvider, setAgentProvider] = useState<LocalAgentProviderSettings>()
  const [agentProviderKeyVariable, setAgentProviderKeyVariable] = useState('APERTURE_AGENT_PROVIDER_API_KEY')
  const [agentProviderReadable, setAgentProviderReadable] = useState(false)
  const [identityMode, setIdentityModeState] = useState<LocalIdentityMode>('development')
  const [githubConfigured, setGithubConfigured] = useState(false)
  const [identityNotice] = useState<{ tone: 'success' | 'error'; code: string } | undefined>(() => {
    const query = new URLSearchParams(window.location.search)
    const code = query.get('identity_error') ?? (query.get('identity') === 'github' ? 'github' : undefined)
    if (!code) return undefined
    query.delete('identity_error')
    query.delete('identity')
    window.history.replaceState(null, '', `${window.location.pathname}${query.size ? `?${query}` : ''}${window.location.hash}`)
    return { tone: code === 'github' ? 'success' : 'error', code }
  })
  const [error, setError] = useState<string>()

  // Reading the provider needs Owner, Maintainer or Developer, so a Reviewer session simply has none and
  // the settings form stays hidden rather than the whole page failing to load.
  const loadAgentProvider = useCallback(async () => {
    try {
      const result = await localControlPlaneClient.getAgentProviderSettings()
      setAgentProvider(result.settings ?? undefined)
      setAgentProviderKeyVariable(result.apiKeyVariable)
      setAgentProviderReadable(true)
    } catch (caught) {
      if (caught instanceof LocalControlPlaneApiError && caught.status === 403) setAgentProviderReadable(false)
      else throw caught
    }
  }, [])

  const loadAuthenticatedData = useCallback(async () => {
    // A remembered project the actor can no longer see (removed, or another user on this browser) falls back to the
    // first active one, so the page never asks the server for a project it would answer with 404.
    const projectResult = await localControlPlaneClient.listProjects()
    let projectId = projectIdRef.current
    if (!projectId || !projectResult.projects.some((project) => project.id === projectId)) projectId = (projectResult.projects.find((project) => project.status === 'active') ?? projectResult.projects[0])?.id
    projectIdRef.current = projectId
    if (projectId) window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId)
    setProjects(projectResult.projects)
    setProjectRoles(projectResult.roles)
    setCurrentProjectId(projectId)
    const [actorResult, workItemResult, runResult, proposalResult, releaseResult, reviewResult, eventResult, projectDetail] = await Promise.all([
      localControlPlaneClient.listActors(),
      localControlPlaneClient.listWorkItems(projectId),
      localControlPlaneClient.listAgentRuns(projectId),
      localControlPlaneClient.listChangeProposals(projectId),
      localControlPlaneClient.listReleaseCandidates(projectId),
      localControlPlaneClient.listReviews(projectId),
      localControlPlaneClient.listEvents(200, projectId),
      projectId ? localControlPlaneClient.getProject(projectId) : Promise.resolve(undefined),
    ])
    setProjectMembers(projectDetail?.members ?? [])
    setActors(actorResult.actors)
    setWorkItems(workItemResult.workItems)
    const intentResults = await Promise.all(workItemResult.workItems.map((item) => localControlPlaneClient.getWorkItem(item.id)))
    setIntentVersions(intentResults.flatMap((result) => result.intentVersions))
    setAgentRuns(runResult.agentRuns)
    setChangeProposals(proposalResult.changeProposals)
    setCodeHostLinks(proposalResult.codeHostLinks ?? [])
    setLastSync(projectDetail?.lastSync ?? undefined)
    setReleaseCandidates(releaseResult.releaseCandidates)
    setReviews(reviewResult.reviews)
    setReviewMetrics(reviewResult.metrics)
    setReviewReadiness(reviewResult.readiness)
    setReviewAssignments(reviewResult.assignments)
    setReviewerLoad(reviewResult.reviewerLoad)
    setEvents(eventResult.events)
    await loadAgentProvider()
  }, [loadAgentProvider])

  // The login and setup responses carry a bare actor; the session view adds how it was proven and the binding.
  const loadSession = useCallback(async () => {
    const session = await localControlPlaneClient.session()
    setActor(session.actor)
    setIdentityModeState(session.identityMode)
  }, [])

  const refresh = useCallback(async () => {
    try {
      await loadAuthenticatedData()
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [loadAuthenticatedData])

  // Agent Runs finish in a worker process, so nothing pushes their outcome to the browser. Poll only
  // while at least one run is in flight; once every run is terminal the UI goes quiet again.
  const runInFlight = agentRuns.some((run) => run.status === 'queued' || run.status === 'running')
  useEffect(() => {
    if (status !== 'ready' || !runInFlight) return
    let active = true
    const timer = setInterval(() => {
      if (active) void refresh()
    }, 3_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [status, runInFlight, refresh])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const health = await localControlPlaneClient.health()
        setAgentRunnerId(health.agentRunner ?? undefined)
        setAgentRuntime(health.agentRuntime ?? undefined)
        const [setupState, providers] = await Promise.all([localControlPlaneClient.setupStatus(), localControlPlaneClient.authProviders()])
        if (!active) return
        setIdentityModeState(providers.identityMode)
        setGithubConfigured(providers.github.configured)
        if (setupState.required) {
          setStatus('setup_required')
          return
        }
        try {
          const session = await localControlPlaneClient.session()
          if (!active) return
          setActor(session.actor)
          setIdentityModeState(session.identityMode)
          await loadAuthenticatedData()
          if (active) setStatus('ready')
        } catch (caught) {
          if (caught instanceof LocalControlPlaneApiError && caught.status === 401) setStatus('unauthenticated')
          else throw caught
        }
      } catch (caught) {
        if (!active) return
        setError(caught instanceof Error ? caught.message : String(caught))
        setStatus(caught instanceof TypeError ? 'offline' : 'error')
      }
    })()
    return () => { active = false }
  }, [loadAuthenticatedData])

  const setup = useCallback(async (input: { username: string; displayName: string; password: string }) => {
    await localControlPlaneClient.setup(input)
    await loadSession()
    await loadAuthenticatedData()
    setStatus('ready')
    setError(undefined)
  }, [loadAuthenticatedData, loadSession])

  const login = useCallback(async (input: { username: string; password: string }) => {
    await localControlPlaneClient.login(input)
    setSessionExpired(false)
    await loadSession()
    await loadAuthenticatedData()
    setStatus('ready')
    setError(undefined)
  }, [loadAuthenticatedData, loadSession])

  const declareIdentity = useCallback(async (actorId: string, githubLogin: string) => {
    await localControlPlaneClient.declareIdentity(actorId, githubLogin)
    await loadSession()
    await loadAuthenticatedData()
  }, [loadAuthenticatedData, loadSession])

  const setIdentityMode = useCallback(async (mode: LocalIdentityMode) => {
    await localControlPlaneClient.setIdentityMode(mode)
    await loadSession()
    await loadAuthenticatedData()
  }, [loadAuthenticatedData, loadSession])

  const [sessionExpired, setSessionExpired] = useState(false)
  const clearSession = useCallback(() => {
    setActor(undefined)
    setActors([])
    setProjects([])
    setProjectRoles({})
    setProjectMembers([])
    setWorkItems([])
    setIntentVersions([])
    setAgentRuns([])
    setChangeProposals([])
    setCodeHostLinks([])
    setLastSync(undefined)
    setReviews([])
    setReviewMetrics({ pendingCount: 0, changesRequestedCount: 0, approvedCount: 0, currentDecisionCount: 0, invalidatedDecisionCount: 0, medianDecisionLatencySeconds: 0, oldestPendingSeconds: 0, activeReviewerCount: 0, approvalDecisionCount: 0, evidenceExpandedApprovalCount: 0, decidedProposalCount: 0, firstPassApprovalCount: 0, reworkedProposalCount: 0, acceptedChangeCount: 0 })
    setReviewReadiness([])
    setReviewAssignments([])
    setReviewerLoad([])
    setEvents([])
    setAgentProvider(undefined)
    setAgentProviderReadable(false)
    setStatus('unauthenticated')
  }, [])

  const logout = useCallback(async () => {
    await localControlPlaneClient.logout()
    setSessionExpired(false)
    clearSession()
  }, [clearSession])

  useEffect(() => onSessionExpired(() => {
    setSessionExpired(true)
    clearSession()
  }), [clearSession])

  const createActor = useCallback(async (input: { username: string; displayName: string; role: LocalActor['role']; password: string; projectIds?: string[] }) => {
    await localControlPlaneClient.createActor(input)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const updateActor = useCallback(async (actorId: string, input: LocalActorUpdate) => {
    await localControlPlaneClient.updateActor(actorId, input)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const selectProject = useCallback(async (projectId: string) => {
    projectIdRef.current = projectId
    window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId)
    setCurrentProjectId(projectId)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const createProject = useCallback(async (input: LocalProjectInput & { slug: string; name: string }) => {
    const result = await localControlPlaneClient.createProject(input)
    await loadAuthenticatedData()
    return result.project
  }, [loadAuthenticatedData])

  const updateProject = useCallback(async (projectId: string, input: LocalProjectInput) => {
    await localControlPlaneClient.updateProject(projectId, input)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const archiveProject = useCallback(async (projectId: string) => {
    await localControlPlaneClient.archiveProject(projectId)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const testProjectConnection = useCallback(async (projectId: string) => (await localControlPlaneClient.testProjectConnection(projectId)).connection, [])

  const syncProject = useCallback(async (projectId: string) => {
    const { report } = await localControlPlaneClient.syncProject(projectId)
    await loadAuthenticatedData()
    return report
  }, [loadAuthenticatedData])

  const setProjectMember = useCallback(async (projectId: string, actorId: string, role: LocalProjectRole) => {
    await localControlPlaneClient.setProjectMember(projectId, { actorId, role })
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const removeProjectMember = useCallback(async (projectId: string, actorId: string) => {
    await localControlPlaneClient.removeProjectMember(projectId, actorId)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const createIntentBundle = useCallback(async (input: IntentBundleInput) => {
    const projectId = projectIdRef.current
    if (!projectId) throw new Error('当前没有可用的项目，请先让 Owner 把你加入一个项目')
    const created = await localControlPlaneClient.createWorkItem({ title: input.title, description: input.description, productType: input.productType, ownerActorId: actor?.id, projectId })
    await localControlPlaneClient.createIntentVersion(created.workItem.id, {
      goal: input.goal,
      constraints: input.constraints,
      riskLevel: input.riskLevel,
      acceptanceCriteria: input.acceptanceCriteria,
    })
    await loadAuthenticatedData()
  }, [actor?.id, loadAuthenticatedData])

  const createChangeProposal = useCallback(async (input: ChangeProposalInput) => {
    await localControlPlaneClient.createChangeProposal(input)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  // The Control Plane only admits the run here; a worker process executes it. The returned queue position
  // is what the caller can show while waiting, and the in-flight poll below picks up the outcome.
  const startAgentRun = useCallback(async (input: AgentRunInput) => {
    const result = await localControlPlaneClient.startAgentRun(input)
    await loadAuthenticatedData()
    return result.queuePosition
  }, [loadAuthenticatedData])

  /**
   * Saving the provider takes effect on the next admitted run, not on runs already in flight. The health
   * probe is repeated afterwards so the runtime banner stops showing the model that was just replaced.
   */
  const saveAgentProvider = useCallback(async (input: LocalAgentProviderInput) => {
    const result = await localControlPlaneClient.saveAgentProviderSettings(input)
    setAgentProvider(result.settings)
    const health = await localControlPlaneClient.health()
    setAgentRuntime(health.agentRuntime ?? undefined)
  }, [])

  /** Run detail is fetched on demand: the declared-versus-actual Context reconciliation lives in the run's events. */
  const getAgentRunDetail = useCallback((runId: string) => localControlPlaneClient.getAgentRun(runId), [])

  const cancelAgentRun = useCallback(async (runId: string) => {
    await localControlPlaneClient.cancelAgentRun(runId)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const refreshChangeProposal = useCallback(async (proposalId: string) => {
    const result = await localControlPlaneClient.refreshChangeProposal(proposalId)
    await loadAuthenticatedData()
    return { changed: result.changed, invalidated: result.invalidated }
  }, [loadAuthenticatedData])

  const reviewChangeProposal = useCallback(async (proposal: LocalChangeProposal, decision: 'approved' | 'changes_requested', comment: string) => {
    await localControlPlaneClient.reviewChangeProposal(proposal.id, { headSha: proposal.headSha, decision, comment })
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const overrideCriterion = useCallback(async (proposal: LocalChangeProposal, criterionId: string, reason: string) => {
    await localControlPlaneClient.overrideCriterion(proposal.id, { headSha: proposal.headSha, criterionId, reason })
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const rejectChangeProposal = useCallback(async (proposal: LocalChangeProposal, reason: string) => {
    await localControlPlaneClient.rejectChangeProposal(proposal.id, { headSha: proposal.headSha, reason })
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const assignReviewer = useCallback(async (proposalId: string, input: { assigneeActorId?: string; dueHours?: number; reason?: string }) => {
    await localControlPlaneClient.assignReviewer(proposalId, input)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const approveIntentVersion = useCallback(async (intentVersionId: string, comment: string) => {
    await localControlPlaneClient.approveIntentVersion(intentVersionId, { comment })
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const mergeChangeProposal = useCallback(async (proposalId: string) => {
    const result = await localControlPlaneClient.mergeChangeProposal(proposalId)
    await loadAuthenticatedData()
    return result.evidence
  }, [loadAuthenticatedData])

  const reviseChangeProposal = useCallback(async (proposalId: string) => {
    await localControlPlaneClient.reviseChangeProposal(proposalId)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const createReleaseCandidate = useCallback(async (proposalId: string) => {
    await localControlPlaneClient.createReleaseCandidate(proposalId)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const approveReleaseCandidate = useCallback(async (candidateId: string, comment: string) => {
    await localControlPlaneClient.approveReleaseCandidate(candidateId, comment)
    await loadAuthenticatedData()
  }, [loadAuthenticatedData])

  const viewEvidence = useCallback(async (evidenceId: string) => {
    const result = await localControlPlaneClient.viewEvidence(evidenceId)
    await loadAuthenticatedData()
    return result
  }, [loadAuthenticatedData])

  const currentProject = projects.find((project) => project.id === currentProjectId)
  const currentProjectRole = currentProjectId ? projectRoles[currentProjectId] : undefined
  const value = useMemo<LocalControlPlaneContextValue>(() => ({ status, agentRunnerId, agentRuntime, actor, actors, projects, projectRoles, currentProjectId, currentProject, currentProjectRole, projectMembers, selectProject, createProject, updateProject, archiveProject, testProjectConnection, syncProject, setProjectMember, removeProjectMember, workItems, intentVersions, agentRuns, changeProposals, codeHostLinks, lastSync, releaseCandidates, reviews, reviewMetrics, reviewReadiness, reviewAssignments, reviewerLoad, events, agentProvider, agentProviderKeyVariable, agentProviderReadable, identityMode, githubConfigured, identityNotice, sessionExpired, error, refresh, declareIdentity, setIdentityMode, setup, login, logout, createActor, updateActor, createIntentBundle, startAgentRun, cancelAgentRun, getAgentRunDetail, saveAgentProvider, createChangeProposal, refreshChangeProposal, reviewChangeProposal, overrideCriterion, rejectChangeProposal, assignReviewer, approveIntentVersion, mergeChangeProposal, reviseChangeProposal, createReleaseCandidate, approveReleaseCandidate, viewEvidence }), [status, agentRunnerId, agentRuntime, actor, actors, projects, projectRoles, currentProjectId, currentProject, currentProjectRole, projectMembers, selectProject, createProject, updateProject, archiveProject, testProjectConnection, syncProject, setProjectMember, removeProjectMember, workItems, intentVersions, agentRuns, changeProposals, codeHostLinks, lastSync, releaseCandidates, reviews, reviewMetrics, reviewReadiness, reviewAssignments, reviewerLoad, events, agentProvider, agentProviderKeyVariable, agentProviderReadable, identityMode, githubConfigured, identityNotice, sessionExpired, error, refresh, declareIdentity, setIdentityMode, setup, login, logout, createActor, updateActor, createIntentBundle, startAgentRun, cancelAgentRun, getAgentRunDetail, saveAgentProvider, createChangeProposal, refreshChangeProposal, reviewChangeProposal, overrideCriterion, rejectChangeProposal, assignReviewer, approveIntentVersion, mergeChangeProposal, reviseChangeProposal, createReleaseCandidate, approveReleaseCandidate, viewEvidence])
  return <LocalControlPlaneContext.Provider value={value}>{children}</LocalControlPlaneContext.Provider>
}

export function useLocalControlPlane() {
  const context = useContext(LocalControlPlaneContext)
  if (!context) throw new Error('useLocalControlPlane must be used inside LocalControlPlaneProvider')
  return context
}
