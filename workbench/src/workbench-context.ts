import { createContext, type Context } from 'react'
import type { AutonomyDecision, AutonomyDecisionInput, TelemetryExportBundle } from './adapters/contracts'
import type { ApprovalCapability, ConvertedSignal, EvidenceSourceRef, WorkbenchState } from './store-model'

export type WorkbenchContextValue = WorkbenchState & {
  approveRelease: (targetId: string) => void
  deployRelease: (targetId: string) => Promise<void>
  rollbackDeployment: (deploymentId: string, reason: string) => Promise<void>
  convertSignal: (signalId: string, title: string, outputType: ConvertedSignal['outputType'], sourceRef?: EvidenceSourceRef) => void
  recordTelemetryExport: (bundle: TelemetryExportBundle) => void
  recordAutonomyDecision: (input: AutonomyDecisionInput, decision: AutonomyDecision) => void
  dismissNotification: (id: string) => void
  resetPrototype: () => void
  startMockRun: () => Promise<void>
  resumeMockRun: (parentRunId: string, checkpointRef: string, workspaceDigest: string) => Promise<void>
  restartInterruptedRun: (parentRunId: string) => Promise<void>
  cancelLiveRun: (runId: string) => void
  approveLiveRun: (runId: string) => void
  decideLiveReview: (runId: string, decision: 'approved' | 'changes_requested') => void
  advanceRegressionAsset: (outputId: string) => void
  runRegressionTrials: (outputId: string) => void
  importGitHubIssue: (externalId: string) => Promise<void>
  importGitHubPullRequest: (externalId: string) => Promise<void>
  switchActor: (actorId: string) => void
  canCurrentActor: (capability: ApprovalCapability) => boolean
}

const globalContext = globalThis as typeof globalThis & {
  __apertureWorkbenchContext?: Context<WorkbenchContextValue | null>
}

export const WorkbenchContext = globalContext.__apertureWorkbenchContext
  ?? createContext<WorkbenchContextValue | null>(null)
globalContext.__apertureWorkbenchContext = WorkbenchContext
