import { useEffect, useReducer, useRef, type ReactNode } from 'react'
import { createInitialState, roleAllows, STORAGE_KEY, workbenchReducer, type RegressionAsset, type WorkbenchState } from './store-model'
import { MockAgentAdapter } from './adapters/mock-agent'
import { MockGitHubIssueProvider, MockGitHubPullRequestProvider } from './adapters/mock-github'
import { MockDeploymentProvider } from './adapters/mock-deployment.ts'
import { LocalEvidenceRepository } from './adapters/local-evidence-repository'
import { LocalWorkflowProvider } from './adapters/local-workflow-provider'
import { LocalEphemeralAttestationProvider } from './adapters/local-attestation-provider'
import { LocalTraceProvider, verifyTraceProjection } from './adapters/local-trace-provider'
import type { AgentRunEvent, AgentRunRequest } from './adapters/contracts'
import { computeEventDigest, digestValue, verifyEventChain, verifyEventProtocol } from './adapters/event-integrity'
import { WorkbenchContext } from './workbench-context'

function recoveredProgress(events: AgentRunEvent[]) {
  if (events.at(-1)?.type === 'run_completed') return 100
  return Math.min(95, Math.max(5, Math.round((events.length / 54) * 95)))
}

function readInitialState(): WorkbenchState {
  const initialState = createInitialState()
  try {
    const evidenceRepository = new LocalEvidenceRepository(window.localStorage)
    const workflowProvider = new LocalWorkflowProvider(window.localStorage)
    const recoverable = workflowProvider.latestRecoverable()
    const interruptedWorkflow = recoverable ? workflowProvider.interrupt(recoverable.runId, 'browser reload detected') : null
    const persisted = window.localStorage.getItem(STORAGE_KEY)
    const parsed = persisted ? JSON.parse(persisted) as Partial<WorkbenchState> : {}
    const persistedLiveRun = parsed.liveRun
    const recoveredEvents = interruptedWorkflow?.events
    const liveRunEvents = recoveredEvents && (!persistedLiveRun || interruptedWorkflow.runId === persistedLiveRun.runId || recoveredEvents.length >= persistedLiveRun.events.length)
      ? recoveredEvents
      : persistedLiveRun?.events
    const liveRunId = interruptedWorkflow && liveRunEvents === recoveredEvents ? interruptedWorkflow.runId : persistedLiveRun?.runId
    const liveRunLabel = interruptedWorkflow && liveRunEvents === recoveredEvents ? interruptedWorkflow.label : persistedLiveRun?.label
    const convertedSignals = parsed.convertedSignals ?? []
    const storedRegressionAssets = parsed.regressionAssets ?? []
    const migratedRegressionAssets: RegressionAsset[] = [
      ...storedRegressionAssets.map((asset) => {
        const trials = asset.trials ?? Array.from({ length: asset.trialsRun ?? 0 }, (_, index) => ({ id: `${asset.outputId}-LEGACY-${index + 1}`, batch: Math.floor(index / 3) + 1, seed: ['a18f', 'bc41', 'd902'][index % 3], result: 'passed' as const, durationSeconds: 72, reason: '由旧版聚合 Trial 记录迁移' }))
        return { ...asset, trials, passAtK: asset.passAtK ?? (trials.length ? 100 : 0), passPowerK: asset.passPowerK ?? (trials.length ? 100 : 0) }
      }),
      ...convertedSignals.filter((signal) => signal.outputType === 'regression' && !storedRegressionAssets.some((asset) => asset.outputId === signal.outputId)).map((signal) => ({ outputId: signal.outputId, sourceSignalId: signal.signalId, sourceRef: signal.sourceRef, fixtureReady: false, graderReady: false, referenceReady: false, trialsRun: 0, baselineCaptured: false, trials: [], passAtK: 0, passPowerK: 0 })),
    ]
    return {
      ...initialState,
      ...parsed,
      notifications: parsed.notifications ?? initialState.notifications,
      events: parsed.events ?? [],
      convertedSignals,
      deployments: parsed.deployments ?? [],
      rollbacks: parsed.rollbacks ?? [],
      telemetryExports: parsed.telemetryExports ?? [],
      autonomyDecisions: parsed.autonomyDecisions ?? [],
      regressionAssets: migratedRegressionAssets,
      githubImports: parsed.githubImports ?? [],
      githubPullRequests: parsed.githubPullRequests ?? [],
      derivedIntents: parsed.derivedIntents ?? [],
      liveRun: liveRunEvents && liveRunId && liveRunLabel ? {
        ...persistedLiveRun,
        runId: liveRunId,
        label: liveRunLabel,
        status: liveRunEvents.at(-1)?.type === 'run_completed' ? persistedLiveRun?.status ?? '已完成' : '运行已中断',
        progress: liveRunEvents.at(-1)?.type === 'run_completed' ? 100 : recoveredProgress(liveRunEvents),
        interrupted: liveRunEvents.at(-1)?.type !== 'run_completed',
        reviewRequired: persistedLiveRun?.reviewRequired ?? liveRunEvents.some((event) => (event.type === 'evaluation_completed' && event.failed > 0) || (event.type === 'ci_evidence_ingested' && event.status === 'failed')),
        approved: persistedLiveRun?.approved ?? false,
        integrityValid: verifyEventChain(liveRunEvents) && verifyEventProtocol(liveRunEvents),
        evidencePackage: persistedLiveRun?.runId === liveRunId && persistedLiveRun.evidencePackage ? { ...persistedLiveRun.evidencePackage, repositoryVerified: evidenceRepository.verifyPackage(persistedLiveRun.evidencePackage.uri) } : undefined,
        attestation: persistedLiveRun?.runId === liveRunId ? persistedLiveRun.attestation : undefined,
        traceProjection: persistedLiveRun?.runId === liveRunId
          && persistedLiveRun.traceProjection
          && persistedLiveRun.traceProjection.document.runId === liveRunId
          && verifyTraceProjection(persistedLiveRun.traceProjection.document)
          && persistedLiveRun.traceProjection.document.spans[0]?.attributes['aperture.event.count'] === liveRunEvents.length
          && persistedLiveRun.traceProjection.document.spans[0]?.attributes['aperture.chain.head'] === liveRunEvents.at(-1)?.eventDigest
          ? persistedLiveRun.traceProjection
          : undefined,
        events: liveRunEvents,
      } : undefined,
    }
  } catch {
    return initialState
  }
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer((current: WorkbenchState, action: Parameters<typeof workbenchReducer>[1]) => workbenchReducer(current, action), undefined, readInitialState)
  const activeRunRef = useRef<{ runId: string; controller: AbortController; discardOnAbort: boolean } | null>(null)
  const evidenceRepositoryRef = useRef<LocalEvidenceRepository | null>(null)
  const workflowProviderRef = useRef<LocalWorkflowProvider | null>(null)
  const attestationProviderRef = useRef<LocalEphemeralAttestationProvider | null>(null)
  const traceProviderRef = useRef<LocalTraceProvider | null>(null)
  const verifiedAttestationsRef = useRef(new Set<string>())
  if (!evidenceRepositoryRef.current) evidenceRepositoryRef.current = new LocalEvidenceRepository(window.localStorage)
  if (!workflowProviderRef.current) workflowProviderRef.current = new LocalWorkflowProvider(window.localStorage)
  if (!attestationProviderRef.current) attestationProviderRef.current = new LocalEphemeralAttestationProvider()
  if (!traceProviderRef.current) traceProviderRef.current = new LocalTraceProvider()

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  useEffect(() => {
    const liveRun = state.liveRun
    if (!liveRun?.attestation || !liveRun.evidencePackage) return
    const verificationKey = `${liveRun.runId}:${liveRun.evidencePackage.digest}:${liveRun.attestation.document.keyId}`
    if (verifiedAttestationsRef.current.has(verificationKey)) return
    verifiedAttestationsRef.current.add(verificationKey)
    const record = evidenceRepositoryRef.current!.readPackage(liveRun.evidencePackage.uri)
    if (!record) return
    void attestationProviderRef.current!.verify(liveRun.attestation.document, JSON.stringify(record)).then((verification) => {
      dispatch({ type: 'record_run_attestation', runId: liveRun.runId, attestation: liveRun.attestation!.document, verification })
    })
  }, [state.liveRun?.runId, state.liveRun?.evidencePackage?.digest, state.liveRun?.attestation?.document.keyId])

  const attestEvidence = async (runId: string, packageUri: string, packageDigest: string) => {
    const record = evidenceRepositoryRef.current!.readPackage(packageUri)
    if (!record) return
    const workflow = record.events.find((event): event is Extract<AgentRunEvent, { type: 'workflow_bound' }> => event.type === 'workflow_bound')
    const content = JSON.stringify(record)
    const attestation = await attestationProviderRef.current!.attest({
      runId,
      evidenceUri: packageUri,
      repositoryDigest: packageDigest,
      chainHead: record.events.at(-1)?.eventDigest ?? 'genesis',
      eventCount: record.events.length,
      workflowId: workflow?.workflowId,
      content,
    })
    const verification = await attestationProviderRef.current!.verify(attestation, content)
    verifiedAttestationsRef.current.add(`${runId}:${packageDigest}:${attestation.keyId}`)
    dispatch({ type: 'record_run_attestation', runId, attestation, verification })
  }

  const projectTrace = (runId: string, packageUri: string) => {
    const record = evidenceRepositoryRef.current!.readPackage(packageUri)
    if (!record) return
    const projection = traceProviderRef.current!.project(runId, record.events)
    dispatch({ type: 'record_run_trace', runId, projection })
  }

  const executeMockRun = async (resumeFrom?: NonNullable<AgentRunRequest['resumeFrom']>) => {
    if (activeRunRef.current || (state.liveRun && state.liveRun.progress < 100 && !state.liveRun.interrupted)) return
    const runId = `RUN-${String(Date.now()).slice(-6)}`
    const label = resumeFrom ? `从 ${resumeFrom.parentRunId} 检查点恢复评估` : '验证 Context、Policy 与 Evaluation 闭环'
    const sessionRef = resumeFrom ? resumeFrom.checkpointRef.split('/checkpoints/')[0] : `session://${runId.toLowerCase()}`
    const request: AgentRunRequest = {
      runId,
      modelRef: 'mock-model://reasoning-medium',
      harnessRef: 'harness://control-plane-v0.1',
      sandboxRef: `sandbox://${runId.toLowerCase()}`,
      sessionRef,
      intentVersionId: 'INT-142-v3',
      contextManifestId: 'CTX-142-v3',
      policyBundleId: 'policy-v12',
      evaluationSuiteIds: ['EVS-014'],
      executionMode: 'orchestrator_workers',
      workspaceRef: `worktree://${runId.toLowerCase()}`,
      requestedCapabilities: ['repository:read', 'repository:write', 'shell:execute'],
      budget: { maxTokens: 80_000, maxDurationSeconds: 1_800, maxToolCalls: 100, maxCostUsd: 8 },
      resumeFrom,
    }
    const adapter = new MockAgentAdapter()
    const evidenceRepository = evidenceRepositoryRef.current!
    const workflowProvider = workflowProviderRef.current!
    workflowProvider.start(request, label)
    const controller = new AbortController()
    activeRunRef.current = { runId, controller, discardOnAbort: false }
    let lastSequence = 0
    let lastEventDigest = 'genesis'
    let terminalEventSeen = false
    try {
      for await (const event of adapter.run(request, controller.signal)) {
        if (controller.signal.aborted) break
        workflowProvider.append(runId, event)
        await evidenceRepository.append(runId, event)
        dispatch({ type: 'append_run_event', label, event })
        lastSequence = event.sequence
        lastEventDigest = event.eventDigest
        terminalEventSeen = event.type === 'run_completed'
        await new Promise<void>((resolve) => {
          const finish = () => {
            window.clearTimeout(timer)
            controller.signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = window.setTimeout(finish, 160)
          controller.signal.addEventListener('abort', finish, { once: true })
        })
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Mock Agent Run failed', error)
    } finally {
      const discardOnAbort = activeRunRef.current?.runId === runId && activeRunRef.current.discardOnAbort
      if (!terminalEventSeen && !discardOnAbort) {
        const unsignedTerminalEvent = {
          type: 'run_completed',
          runId,
          sequence: lastSequence + 1,
          occurredAt: new Date().toISOString(),
          previousEventDigest: lastEventDigest,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          outputDigest: digestValue(controller.signal.aborted ? `cancelled:${runId}` : `failed:${runId}`),
        } as Omit<Extract<AgentRunEvent, { type: 'run_completed' }>, 'eventDigest'>
        const terminalEvent: AgentRunEvent = { ...unsignedTerminalEvent, eventDigest: computeEventDigest(unsignedTerminalEvent) }
        workflowProvider.append(runId, terminalEvent)
        await evidenceRepository.append(runId, terminalEvent)
        dispatch({ type: 'append_run_event', label, event: terminalEvent })
      }
      if (discardOnAbort) {
        evidenceRepository.discardDraft(runId)
        workflowProvider.discard(runId)
      }
      else {
        const evidencePackage = await evidenceRepository.finalize(runId)
        dispatch({ type: 'finalize_run_evidence', runId, packageUri: evidencePackage.packageUri, packageDigest: evidencePackage.packageDigest, repositoryVerified: evidenceRepository.verifyPackage(evidencePackage.packageUri) })
        projectTrace(runId, evidencePackage.packageUri)
        await attestEvidence(runId, evidencePackage.packageUri, evidencePackage.packageDigest)
      }
      if (activeRunRef.current?.runId === runId) activeRunRef.current = null
    }
  }

  const sealInterruptedRun = async (runId: string) => {
    const interruptedRun = state.liveRun
    if (!interruptedRun?.interrupted || interruptedRun.runId !== runId) return
    evidenceRepositoryRef.current!.restoreDraft(runId, interruptedRun.events)
    const lastEvent = interruptedRun.events.at(-1)
    const unsignedTerminalEvent = {
      type: 'run_completed',
      runId,
      sequence: (lastEvent?.sequence ?? 0) + 1,
      occurredAt: new Date().toISOString(),
      previousEventDigest: lastEvent?.eventDigest ?? 'genesis',
      status: 'cancelled',
      outputDigest: digestValue(`interrupted:${runId}`),
    } as Omit<Extract<AgentRunEvent, { type: 'run_completed' }>, 'eventDigest'>
    const terminalEvent: AgentRunEvent = { ...unsignedTerminalEvent, eventDigest: computeEventDigest(unsignedTerminalEvent) }
    const workflowRecord = workflowProviderRef.current!.read(runId)
    if (workflowRecord && workflowRecord.status !== 'completed') workflowProviderRef.current!.append(runId, terminalEvent)
    await evidenceRepositoryRef.current!.append(runId, terminalEvent)
    dispatch({ type: 'append_run_event', label: interruptedRun.label, event: terminalEvent })
    const evidencePackage = await evidenceRepositoryRef.current!.finalize(runId)
    dispatch({ type: 'finalize_run_evidence', runId, packageUri: evidencePackage.packageUri, packageDigest: evidencePackage.packageDigest, repositoryVerified: evidenceRepositoryRef.current!.verifyPackage(evidencePackage.packageUri) })
    projectTrace(runId, evidencePackage.packageUri)
    await attestEvidence(runId, evidencePackage.packageUri, evidencePackage.packageDigest)
  }

  return (
    <WorkbenchContext.Provider value={{
      ...state,
      switchActor: (actorId) => dispatch({ type: 'switch_actor', actorId }),
      canCurrentActor: (capability) => {
        const actor = state.teamMembers.find((member) => member.id === state.currentActorId)
        return actor ? roleAllows(actor.role, capability) : false
      },
      approveRelease: (targetId) => dispatch({ type: 'approve_release', targetId }),
      deployRelease: async (targetId) => {
        if (!state.releaseApproved || state.releaseApprovalTarget !== targetId || !state.releaseApprovedBy) return
        if (state.deployments.some((deployment) => deployment.releaseCandidateId === targetId && deployment.status === 'succeeded')) return
        const authoritativePullRequest = state.githubPullRequests[0]
        const evidenceUri = state.liveRun?.evidencePackage?.repositoryVerified ? state.liveRun.evidencePackage.uri : authoritativePullRequest?.evidenceUri ?? `local://evidence/${targetId.toLowerCase()}.json`
        const provider = new MockDeploymentProvider()
        const deployment = await provider.deploy({ releaseCandidateId: targetId, environment: 'production', headSha: authoritativePullRequest?.headSha ?? 'local-approved', evidenceUri, approvedBy: state.releaseApprovedBy })
        dispatch({ type: 'record_deployment', deployment })
      },
      rollbackDeployment: async (deploymentId, reason) => {
        const deployment = state.deployments.find((item) => item.deploymentId === deploymentId)
        const actor = state.teamMembers.find((member) => member.id === state.currentActorId)
        if (!deployment || !actor || !roleAllows(actor.role, 'approve_release') || state.rollbacks.some((rollback) => rollback.deploymentId === deploymentId && rollback.status === 'succeeded')) return
        const provider = new MockDeploymentProvider()
        const rollback = await provider.rollback({ deploymentId, releaseCandidateId: deployment.releaseCandidateId, rollbackRef: deployment.rollbackRef, requestedBy: actor.identity, reason })
        dispatch({ type: 'record_rollback', rollback })
      },
      convertSignal: (signalId, title, outputType, sourceRef) => dispatch({ type: 'convert_signal', signalId, title, outputType, sourceRef }),
      recordTelemetryExport: (bundle) => dispatch({ type: 'record_telemetry_export', bundle }),
      recordAutonomyDecision: (input, decision) => dispatch({ type: 'record_autonomy_decision', input, decision }),
      dismissNotification: (id) => dispatch({ type: 'dismiss_notification', id }),
      resetPrototype: () => {
        if (activeRunRef.current) {
          activeRunRef.current.discardOnAbort = true
          activeRunRef.current.controller.abort()
        }
        evidenceRepositoryRef.current?.clear()
        workflowProviderRef.current?.clear()
        dispatch({ type: 'reset' })
      },
      approveLiveRun: (runId) => dispatch({ type: 'approve_run_review', runId }),
      decideLiveReview: (runId, decision) => dispatch({ type: 'decide_run_review', runId, decision }),
      advanceRegressionAsset: (outputId) => dispatch({ type: 'advance_regression_asset', outputId }),
      runRegressionTrials: (outputId) => dispatch({ type: 'run_regression_trials', outputId }),
      importGitHubIssue: async (externalId) => {
        const normalized = externalId.trim().replace(/^#/, '')
        if (state.githubImports.some((item) => item.externalId === normalized)) return
        const provider = new MockGitHubIssueProvider()
        const issue = await provider.readIssue(normalized)
        const intentId = `INT-${145 + state.githubImports.length}`
        await provider.writeIntentProjection(normalized, `${intentId} · Acceptance Criteria managed by Control Plane`)
        dispatch({ type: 'import_github_issue', issue: { externalId: normalized, intentId, ...issue, projectionWritten: true } })
      },
      importGitHubPullRequest: async (externalId) => {
        const normalized = externalId.trim().replace(/^#/, '')
        const provider = new MockGitHubPullRequestProvider()
        const pullRequest = await provider.readPullRequest(normalized)
        const evidenceUri = state.liveRun?.evidencePackage?.repositoryVerified ? state.liveRun.evidencePackage.uri : undefined
        const linkedRunId = state.liveRun?.runId
        await provider.writeEvidenceProjection(normalized, `${linkedRunId ?? 'no-run'} · ${evidenceUri ?? 'evidence-not-finalized'} · Control Plane projection only`)
        dispatch({ type: 'import_github_pull_request', pullRequest: { externalId: normalized, ...pullRequest, linkedRunId, evidenceUri, projectionWritten: true } })
      },
      cancelLiveRun: (runId) => {
        if (activeRunRef.current?.runId === runId) activeRunRef.current.controller.abort()
        else if (state.liveRun?.interrupted && state.liveRun.runId === runId) void sealInterruptedRun(runId)
      },
      startMockRun: () => executeMockRun(),
      resumeMockRun: async (parentRunId, checkpointRef, workspaceDigest) => {
        const workflowRecord = workflowProviderRef.current!.read(parentRunId)
        if (workflowRecord && workflowRecord.status !== 'completed') workflowProviderRef.current!.recover(parentRunId)
        await sealInterruptedRun(parentRunId)
        await executeMockRun({ parentRunId, checkpointRef, workspaceDigest })
      },
      restartInterruptedRun: async (parentRunId) => {
        await sealInterruptedRun(parentRunId)
        await executeMockRun()
      },
    }}>
      {children}
    </WorkbenchContext.Provider>
  )
}
