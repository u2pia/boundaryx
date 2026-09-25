import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ControlPlaneDatabase } from './database.ts'
import { resolveProjectRepository } from './code-host/index.ts'
import { LocalGitAuthority } from './local-git-authority.ts'
import { applyProjectManifest, loadProjectManifest, type ProjectManifestBinding } from './project-manifest.ts'
import { removeRunWorktree, runRootFor, type PruneOutcome } from './run-worktree-lifecycle.ts'
import { sha256 } from './security.ts'
import { AppError, type AgentRun, type AgentRunRequest, type AgentRunner, type AgentRunnerDescriptor, type ChangeProposal, type IntentVersion, type WorkItem } from './types.ts'

export type AgentRuntimeAttestation = {
  runtimeId: string
  isolation: AgentRun['isolation']
  imageRef?: string
  imageDigest?: string
  engineVersion?: string
  networkEgress: AgentRun['networkEgress']
  readonlyRoot: boolean
  capDropAll: boolean
  noNewPrivileges: boolean
  ephemeral: boolean
  cpuLimit?: string
  memoryLimit?: string
  pidsLimit?: number
  secretMounts: string[]
  environmentKeys?: string[]
  secretEnvironmentKeys?: string[]
  productionEligible: boolean
  attestationDigest: string
}

export type AgentRuntimeContext = {
  runId: string
  worktreePath: string
  requestPath: string
  timeoutMs: number
}

export type AgentRuntimeResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
  /** The end of stderr with every secret the runtime passed in removed, safe to store and show; the full stream is only digested. */
  diagnostic?: string
}

export interface AgentExecutionRuntime {
  readonly descriptor: AgentRunnerDescriptor
  attest(context: AgentRuntimeContext): AgentRuntimeAttestation
  execute(context: AgentRuntimeContext): AgentRuntimeResult
  /** Removes every secret this runtime passed to the agent from a text the agent produced. */
  redact?(text: string): string
}

export type AgentRunPostprocessorInput = {
  runId: string
  actorId: string
  adapterId: string
  worktreePath: string
  workItem: WorkItem
  intent: IntentVersion
  projectManifest: ProjectManifestBinding
  startSha: string
  revisionOfProposalId?: string
  proposal: ChangeProposal
  attestation: AgentRuntimeAttestation
  stdoutDigest?: string
  stderrDigest?: string
  /** Absent when the builder did not report usage (Codex and Claude Code wrappers today). */
  modelUsage?: AgentModelUsage
  toolSteps?: ReturnType<typeof summarizeToolSteps>
}

export interface AgentRunPostprocessor {
  process(input: AgentRunPostprocessorInput): unknown
}

/** One tool call as the builder reported it: tool, path or command, outcome. Never file content or command output. */
export type AgentToolStep = { step: number; tool: string; path?: string; command?: string; outcome: 'ok' | 'failed' | 'error' | 'not_run'; exitCode?: number | null; error?: string }

/** What the builder's model calls cost, as the provider reported it on each response. */
export type AgentModelUsage = { modelCalls: number; httpRequests: number; callsWithUsage: number; promptTokens: number; completionTokens: number; totalTokens: number; peakContextTokens: number; contextBudgetTokens?: number }

export type AgentContextBudgetExceeded = { step: number; estimatedTokens: number; budgetTokens: number; basis: string }

type AgentProtocolMessage =
  | { type: 'context_consumed'; path: string }
  | { type: 'message'; summary: string }
  | ({ type: 'tool_step' } & AgentToolStep)
  | ({ type: 'usage' } & AgentModelUsage)
  | ({ type: 'context_budget_exceeded' } & AgentContextBudgetExceeded)

/** The file beside the run request where a builder appends its steps while it runs, for the live view. */
export function runProgressPath(requestPath: string) {
  return join(dirname(requestPath), 'progress.jsonl')
}

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
const bounded = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : undefined
const toolOutcomes = new Set(['ok', 'failed', 'error', 'not_run'])

/**
 * Parses the builder's JSON lines. Every field is re-bounded here rather than trusted, because the builder is the
 * party being audited; `redact` removes any secret the runtime passed in before a value reaches an event.
 */
export function parseProtocol(stdout: string, redact: (text: string) => string = (text) => text) {
  const messages: AgentProtocolMessage[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const value = JSON.parse(redact(line)) as Record<string, unknown>
      if (value.type === 'context_consumed' && typeof value.path === 'string') messages.push({ type: 'context_consumed', path: value.path })
      if (value.type === 'message' && typeof value.summary === 'string') messages.push({ type: 'message', summary: value.summary.slice(0, 1000) })
      if (value.type === 'tool_step' && typeof value.tool === 'string') {
        const path = bounded(value.path, 300)
        const command = bounded(value.command, 200)
        const error = bounded(value.error, 200)
        messages.push({
          type: 'tool_step',
          step: count(value.step),
          tool: value.tool.slice(0, 64),
          ...(path !== undefined ? { path } : {}),
          ...(command !== undefined ? { command } : {}),
          outcome: toolOutcomes.has(String(value.outcome)) ? value.outcome as AgentToolStep['outcome'] : 'error',
          ...(typeof value.exitCode === 'number' || value.exitCode === null ? { exitCode: value.exitCode as number | null } : {}),
          ...(error !== undefined ? { error } : {}),
        })
      }
      if (value.type === 'usage') messages.push({ type: 'usage', modelCalls: count(value.modelCalls), httpRequests: count(value.httpRequests), callsWithUsage: count(value.callsWithUsage), promptTokens: count(value.promptTokens), completionTokens: count(value.completionTokens), totalTokens: count(value.totalTokens), peakContextTokens: count(value.peakContextTokens), ...(value.contextBudgetTokens !== undefined ? { contextBudgetTokens: count(value.contextBudgetTokens) } : {}) })
      if (value.type === 'context_budget_exceeded') messages.push({ type: 'context_budget_exceeded', step: count(value.step), estimatedTokens: count(value.estimatedTokens), budgetTokens: count(value.budgetTokens), basis: bounded(value.basis, 64) ?? 'unknown' })
    } catch {}
  }
  return messages
}

/** Tool steps a running builder has reported so far. The event log is the record; this is only the live view. */
export function readLiveToolSteps(requestPath: string, redact?: (text: string) => string) {
  const path = runProgressPath(requestPath)
  if (!existsSync(path)) return { steps: [] as AgentToolStep[], usage: undefined as AgentModelUsage | undefined }
  const messages = parseProtocol(readFileSync(path, 'utf8').slice(-2_000_000), redact)
  const steps = messages.flatMap((message) => message.type === 'tool_step' ? [stripType(message)] : []).slice(-500)
  const usage = messages.flatMap((message) => message.type === 'usage' ? [stripType(message)] : []).at(-1)
  return { steps, usage }
}

function stripType<T extends { type: string }>(message: T): Omit<T, 'type'> {
  const { type: _type, ...rest } = message
  return rest
}

/** Totals for the Evidence Package: how many steps, of which tools, and how many did not succeed. */
export function summarizeToolSteps(steps: AgentToolStep[]) {
  const byTool: Record<string, number> = {}
  for (const step of steps) byTool[step.tool] = (byTool[step.tool] ?? 0) + 1
  return { total: steps.length, byTool, unsuccessful: steps.filter((step) => step.outcome !== 'ok').length, reportSource: 'agent_protocol' as const, independentlyObserved: false }
}

function git(repositoryPath: string, args: string[]) {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim()
  } catch (error) {
    throw new AppError(400, `Git operation failed: ${error instanceof Error ? error.message : String(error)}`, 'git_operation_failed')
  }
}

export class GitWorktreeAgentRunner implements AgentRunner {
  readonly id: string
  readonly descriptor: AgentRunnerDescriptor
  private readonly input: { database: ControlPlaneDatabase; runtime: AgentExecutionRuntime; worktreeRoot: string; timeoutMs?: number; postprocessor?: AgentRunPostprocessor }

  constructor(input: { database: ControlPlaneDatabase; runtime: AgentExecutionRuntime; worktreeRoot: string; timeoutMs?: number; postprocessor?: AgentRunPostprocessor }) {
    this.input = input
    this.id = input.runtime.descriptor.id
    this.descriptor = input.runtime.descriptor
  }

  /** Synchronous convenience path used by tests and by the worker: admit, then execute in place. */
  run(request: AgentRunRequest, actorId: string) {
    const prepared = this.prepare(request, actorId)
    return this.execute(prepared.id)
  }

  /**
   * Admits a run: validates the request, binds the Project Manifest, creates the isolated worktree and
   * leaves the run `queued`. Everything here is fast and must stay inside the caller's request, because
   * a rejected run has to answer with a status code rather than a queued run that fails later.
   */
  prepare(request: AgentRunRequest, actorId: string): AgentRun {
    const workItem = this.input.database.getWorkItem(request.workItemId)
    const intent = this.input.database.getIntentVersion(request.intentVersionId)
    if (intent.workItemId !== workItem.id) throw new AppError(400, 'Intent version does not belong to the work item', 'intent_work_item_mismatch')
    // Checked again in createAgentRun; checking here as well means a refused run never leaves a worktree behind.
    this.input.database.assertIntentRunnable(intent)
    const revisionProposal = request.changeProposalId ? this.input.database.getChangeProposal(request.changeProposalId) : undefined
    if (revisionProposal) {
      if (revisionProposal.status !== 'changes_requested') throw new AppError(409, 'Agent revision requires an active changes_requested decision', 'revision_not_requested')
      if (revisionProposal.workItemId !== workItem.id || revisionProposal.intentVersionId !== intent.id) throw new AppError(409, 'Revision proposal does not match the requested Work Item and Intent', 'revision_intent_mismatch')
    }
    // The repository comes from the work item's project; a caller never chooses which directory a run edits.
    const { host, repositoryPath } = resolveProjectRepository(this.input.database, workItem.projectId, request.repositoryPath)
    host.prepareForRun()
    if (git(repositoryPath, ['rev-parse', '--is-inside-work-tree']) !== 'true' && git(repositoryPath, ['rev-parse', '--is-bare-repository']) !== 'true') throw new AppError(400, 'Project repository is not a Git repository', 'invalid_repository')
    if (revisionProposal && (revisionProposal.repositoryPath !== repositoryPath || revisionProposal.baseRef !== request.baseRef)) throw new AppError(409, 'Revision repository or base ref does not match the change proposal', 'revision_repository_mismatch')
    const baseSha = git(repositoryPath, ['rev-parse', '--verify', `${request.baseRef}^{commit}`])
    if (revisionProposal && baseSha !== revisionProposal.baseSha) throw new AppError(409, 'Target branch changed after review; refresh before starting a revision', 'revision_base_drift')
    if (revisionProposal && git(repositoryPath, ['rev-parse', '--verify', `${revisionProposal.headRef}^{commit}`]) !== revisionProposal.headSha) throw new AppError(409, 'Reviewed Head branch changed before the revision run', 'revision_head_drift')
    const startSha = revisionProposal?.headSha ?? baseSha
    const reviewFeedback = revisionProposal ? this.input.database.listCurrentChangeRequests(revisionProposal.id) : []
    if (revisionProposal && !reviewFeedback.length) throw new AppError(409, 'Revision run requires current changes_requested feedback', 'revision_feedback_missing')
    const projectManifest = loadProjectManifest(repositoryPath, baseSha)
    const declaredContextPaths = applyProjectManifest({ binding: projectManifest, workItem, intent, runtime: this.descriptor, declaredContextPaths: request.declaredContextPaths })
    const runId = `RUN-${randomUUID().slice(0, 8).toUpperCase()}`
    const branchRef = revisionProposal ? `agent/revision-${runId.toLowerCase()}` : `agent/${runId.toLowerCase()}`
    const runRoot = resolve(this.input.worktreeRoot, runId)
    const worktreePath = join(runRoot, 'worktree')
    const requestPath = join(runRoot, 'request.json')
    const timeoutMs = this.input.timeoutMs ?? 10 * 60 * 1000
    mkdirSync(runRoot, { recursive: true })
    git(repositoryPath, ['worktree', 'add', '-b', branchRef, worktreePath, startSha])
    git(worktreePath, ['config', 'user.name', 'BoundaryX Local Agent'])
    git(worktreePath, ['config', 'user.email', 'local-agent@aperture.invalid'])
    writeFileSync(requestPath, JSON.stringify({ runId, workItem, intent, workspace: worktreePath, projectManifest: { path: projectManifest.path, baseSha: projectManifest.baseSha, digest: projectManifest.digest, evaluation: { profile: projectManifest.manifest.evaluation.profile, datasetPath: projectManifest.manifest.evaluation.datasetPath, datasetDigest: projectManifest.evaluationDatasetDigest, thresholds: projectManifest.manifest.evaluation.thresholds }, artifact: projectManifest.manifest.artifact ?? null }, declaredContextPaths, revision: revisionProposal ? { changeProposalId: revisionProposal.id, previousHeadRef: revisionProposal.headRef, previousHeadSha: revisionProposal.headSha, feedback: reviewFeedback } : null }, null, 2))
    const runtimeContext = { runId, worktreePath, requestPath, timeoutMs }
    const attestation = this.input.runtime.attest(runtimeContext)
    const run = this.input.database.createAgentRun({ id: runId, workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: request.baseRef, baseSha, startSha, revisionOfProposalId: revisionProposal?.id, branchRef, worktreePath, adapterId: this.id, isolation: attestation.isolation, runtimeImageRef: attestation.imageRef, runtimeAttestationDigest: attestation.attestationDigest, networkEgress: attestation.networkEgress, productionEligible: attestation.productionEligible, startedByActorId: actorId, status: 'queued' })
    this.input.database.saveAgentRunPlan({ runId, declaredContextPaths, requestPath, timeoutMs })
    this.input.database.recordAgentRunEvent(runId, 'agent_run.runtime_attested', attestation, actorId)
    if (revisionProposal) this.input.database.recordAgentRunEvent(runId, 'agent_run.revision_feedback_bound', { changeProposalId: revisionProposal.id, previousHeadRef: revisionProposal.headRef, previousHeadSha: revisionProposal.headSha, feedbackReviewIds: reviewFeedback.map((feedback) => feedback.reviewId), feedbackDigest: `sha256:${sha256(JSON.stringify(reviewFeedback))}` }, actorId)
    this.input.database.recordAgentRunEvent(runId, 'agent_run.project_manifest_bound', { path: projectManifest.path, baseSha: projectManifest.baseSha, digest: projectManifest.digest, schemaVersion: projectManifest.manifest.schemaVersion, productType: projectManifest.manifest.productType, requiredContextCount: projectManifest.manifest.context.required.length, allowedContextCount: projectManifest.manifest.context.allowed.length, checks: projectManifest.manifest.checks.map((check) => ({ name: check.name, kind: check.kind })), evaluationProfile: projectManifest.manifest.evaluation.profile, evaluationDatasetPath: projectManifest.manifest.evaluation.datasetPath ?? null, evaluationDatasetDigest: projectManifest.evaluationDatasetDigest ?? null, artifact: projectManifest.manifest.artifact ?? null, policy: projectManifest.manifest.policy }, actorId)
    this.input.database.recordAgentRunEvent(runId, 'agent_run.workspace_prepared', { worktreePath, branchRef, requestDigest: `sha256:${sha256(readFileSync(requestPath))}`, isolation: attestation.isolation, productionEligible: attestation.productionEligible }, actorId)
    return run
  }

  /**
   * Executes an admitted run. Safe to call from a separate process: every input is reconstructed from
   * the database, the persisted plan and Git, and the runtime attestation is recomputed and compared so
   * a run cannot silently execute under a different runtime than the one it was admitted under.
   */
  execute(runId: string): AgentRun {
    const queued = this.input.database.getAgentRun(runId)
    const actorId = queued.startedByActorId
    const plan = this.input.database.getAgentRunPlan(runId)
    const workItem = this.input.database.getWorkItem(queued.workItemId)
    const intent = this.input.database.getIntentVersion(queued.intentVersionId)
    const revisionProposal = queued.revisionOfProposalId ? this.input.database.getChangeProposal(queued.revisionOfProposalId) : undefined
    const { repositoryPath, baseSha, startSha, branchRef, worktreePath } = queued
    const declaredContextPaths = plan.declaredContextPaths
    const runtimeContext = { runId, worktreePath, requestPath: plan.requestPath, timeoutMs: plan.timeoutMs }
    const attestation = this.input.runtime.attest(runtimeContext)
    if (!this.input.database.claimAgentRun(runId, process.pid, actorId)) {
      this.input.database.recordAgentRunEvent(runId, 'agent_run.cancelled_before_start', { worktreePath }, actorId)
      return this.terminal(runId, queued.repositoryPath, actorId, { status: 'cancelled', errorMessage: 'Agent run was cancelled before execution started' })
    }
    if (attestation.attestationDigest !== queued.runtimeAttestationDigest) {
      this.input.database.recordAgentRunEvent(runId, 'agent_run.runtime_attestation_mismatch', { admitted: queued.runtimeAttestationDigest ?? null, observed: attestation.attestationDigest }, actorId)
      return this.terminal(runId, repositoryPath, actorId, { status: 'failed', errorMessage: 'Runtime attestation changed between admission and execution' })
    }
    const projectManifest = loadProjectManifest(repositoryPath, baseSha)
    if (projectManifest.digest !== this.input.database.listAggregateEvents('agent_run', runId).find((event) => event.eventType === 'agent_run.project_manifest_bound')?.payload.digest) {
      this.input.database.recordAgentRunEvent(runId, 'agent_run.project_manifest_drift', { observed: projectManifest.digest }, actorId)
      return this.terminal(runId, repositoryPath, actorId, { status: 'failed', errorMessage: 'Project manifest changed between admission and execution' })
    }

    let exitCode: number | undefined
    let stdoutDigest: string | undefined
    let stderrDigest: string | undefined
    let changeProposalId: string | undefined
    let diagnostic: string | undefined
    let postprocessorUsage: Pick<AgentRunPostprocessorInput, 'modelUsage' | 'toolSteps'> = {}
    try {
      const result = this.input.runtime.execute(runtimeContext)
      diagnostic = result.diagnostic
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      exitCode = result.status ?? undefined
      stdoutDigest = `sha256:${sha256(stdout)}`
      stderrDigest = `sha256:${sha256(stderr)}`
      const toolSteps: AgentToolStep[] = []
      let modelUsage: AgentModelUsage | undefined
      let budgetExceeded: AgentContextBudgetExceeded | undefined
      for (const message of parseProtocol(stdout, (text) => this.input.runtime.redact?.(text) ?? text)) {
        if (message.type === 'message') this.input.database.recordAgentRunEvent(runId, 'agent_run.message', { summary: message.summary }, actorId)
        else if (message.type === 'context_consumed') this.recordContextConsumption(runId, worktreePath, declaredContextPaths, message.path, actorId)
        else if (message.type === 'tool_step') {
          const { type: _type, ...step } = message
          toolSteps.push(step)
          this.input.database.recordAgentRunEvent(runId, 'agent_run.tool_step', { ...step, reportSource: 'agent_protocol', independentlyObserved: false }, actorId)
        } else if (message.type === 'usage') {
          // A builder reports its running total; the last report is the run's.
          const { type: _type, ...reported } = message
          modelUsage = reported
        } else {
          const { type: _type, ...exceeded } = message
          budgetExceeded = exceeded
          this.input.database.recordAgentRunEvent(runId, 'agent_run.context_budget_exceeded', exceeded, actorId)
        }
      }
      if (modelUsage) this.input.database.recordAgentRunEvent(runId, 'agent_run.model_usage', { ...modelUsage, reportSource: 'agent_protocol', independentlyObserved: false }, actorId)
      if (this.input.database.isAgentRunCancellationRequested(runId)) return this.terminal(runId, repositoryPath, actorId, { status: 'cancelled', exitCode, stdoutDigest, stderrDigest, errorMessage: 'Agent run was cancelled while the agent was generating' })
      if (result.error) throw new AppError((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 408 : 422, `Agent runtime failed: ${result.error.message}`, 'agent_runtime_failed')
      // Said in the Control Plane's own words, so the reason does not depend on how the builder phrased its stderr.
      if (budgetExceeded && result.status !== 0) throw new AppError(422, `Context budget exceeded: at step ${budgetExceeded.step} the conversation was about ${budgetExceeded.estimatedTokens} tokens, over the ${budgetExceeded.budgetTokens}-token budget; the builder stopped before sending it to the provider`, 'agent_context_budget_exceeded')
      // The message keeps the last few lines; the full tail goes to the failure diagnostic event.
      const lastLines = result.diagnostic?.split('\n').slice(-5).join('\n').slice(-800)
      if (result.status !== 0) throw new AppError(422, `Agent exited with status ${result.status ?? 'unknown'}${lastLines ? `: ${lastLines}` : ''}`, 'agent_execution_failed')
      postprocessorUsage = { modelUsage, toolSteps: toolSteps.length ? summarizeToolSteps(toolSteps) : undefined }
      const changed = git(worktreePath, ['status', '--porcelain'])
      if (!changed) throw new AppError(422, 'Agent completed without producing a repository change', 'agent_empty_change')
      git(worktreePath, ['add', '-A'])
      git(worktreePath, ['commit', '-m', `agent: ${workItem.title.slice(0, 72)}`])
      const authority = new LocalGitAuthority(this.input.database)
      const proposal = revisionProposal
        ? authority.reviseChangeProposal(revisionProposal.id, runId, branchRef, actorId).proposal
        : authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId, repositoryPath, baseRef: queued.baseRef, headRef: branchRef, authorActorId: actorId }, actorId)
      changeProposalId = proposal.id
      this.input.database.recordAgentRunEvent(runId, revisionProposal ? 'agent_run.change_revised' : 'agent_run.change_proposed', { changeProposalId: proposal.id, previousHeadSha: revisionProposal?.headSha ?? null, headSha: proposal.headSha, changedFiles: proposal.changedFiles, additions: proposal.additions, deletions: proposal.deletions }, actorId)
      this.input.postprocessor?.process({ runId, actorId, adapterId: this.id, worktreePath, workItem, intent, projectManifest, startSha, revisionOfProposalId: revisionProposal?.id, proposal, attestation, stdoutDigest, stderrDigest, ...postprocessorUsage })
      return this.terminal(runId, repositoryPath, actorId, { status: 'succeeded', changeProposalId: proposal.id, exitCode: result.status ?? 0, stdoutDigest, stderrDigest })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = this.input.database.isAgentRunCancellationRequested(runId)
      // Captured before terminal() prunes the worktree, which would take the uncommitted work with it.
      if (!cancelled) this.recordFailureDiagnostic(runId, worktreePath, diagnostic, actorId)
      this.terminal(runId, repositoryPath, actorId, { status: cancelled ? 'cancelled' : 'failed', changeProposalId, exitCode, stdoutDigest, stderrDigest, errorMessage: cancelled ? `Agent run was cancelled: ${message}` : message })
      throw error
    }
  }

  /**
   * Removes the worktree a Run created. Called when the run reaches a terminal state, and again by the
   * reconciler for any run whose worker died without getting there. Idempotent, and safe to call for a
   * run whose checkout is already gone.
   */
  cleanUpWorktree(run: AgentRun, actorId: string = run.startedByActorId) {
    return this.pruneWorktree(run, run.repositoryPath, actorId)
  }

  /**
   * Writes the terminal state and then removes the run's worktree. The order matters and the cleanup is
   * outside the try: the run's conclusion is decided by the agent and its checks, never by whether a
   * checkout could be deleted, and the event log must already say how the run ended when the cleanup is
   * recorded. Failures are recorded as events (`agent_run.worktree_pruned` with `pruned: false`), so a
   * cleanup that could not finish is visible instead of silently dropping the directory.
   */
  private terminal(runId: string, repositoryPath: string, actorId: string, input: { status: 'succeeded' | 'failed' | 'cancelled'; changeProposalId?: string; exitCode?: number; stdoutDigest?: string; stderrDigest?: string; errorMessage?: string }) {
    const run = this.input.database.completeAgentRun({ runId, actorId, ...input })
    this.pruneWorktree(run, repositoryPath, actorId)
    return run
  }

  private pruneWorktree(run: AgentRun, repositoryPath: string, actorId: string): PruneOutcome {
    const outcome = removeRunWorktree({ repositoryPath, worktreePath: run.worktreePath, runRoot: runRootFor(run.worktreePath, this.input.worktreeRoot) })
    this.input.database.recordAgentRunEvent(run.id, 'agent_run.worktree_pruned', {
      worktreePath: run.worktreePath,
      branchRef: run.branchRef,
      repositoryPath,
      pruned: outcome.removed,
      skippedPaths: outcome.skipped,
      error: outcome.error ?? null,
      // Stated explicitly because the whole point of the cleanup is that these survive it.
      proposalBranchPreserved: true,
      evidencePreserved: true,
    }, actorId)
    return outcome
  }

  /**
   * What someone diagnosing a failed run needs beyond the error message: the agent's redacted stderr tail and the
   * files it had changed but the Control Plane never committed. Best effort; it never masks the original failure.
   */
  private recordFailureDiagnostic(runId: string, worktreePath: string, stderrTail: string | undefined, actorId: string) {
    try {
      let uncommittedChanges: string[] = []
      try {
        uncommittedChanges = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).split('\n').filter(Boolean).slice(0, 100)
      } catch {}
      // The agent's unfinished work is kept as a patch beside the worktree, so it survives worktree cleanup and can be
      // reviewed or applied by hand. It stays on this machine and is referenced from the event by digest only.
      let uncommittedPatch: { path: string; digest: string; bytes: number } | undefined
      if (uncommittedChanges.length) {
        try {
          execFileSync('git', ['-C', worktreePath, 'add', '-A'])
          const patch = execFileSync('git', ['-C', worktreePath, 'diff', '--cached', '--binary'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
          execFileSync('git', ['-C', worktreePath, 'reset', '-q'])
          const patchPath = resolve(dirname(worktreePath), 'uncommitted.patch')
          writeFileSync(patchPath, patch)
          uncommittedPatch = { path: patchPath, digest: `sha256:${sha256(patch)}`, bytes: Buffer.byteLength(patch) }
        } catch {}
      }
      this.input.database.recordAgentRunEvent(runId, 'agent_run.failure_diagnostic', { stderrTail: stderrTail ?? null, uncommittedChanges, uncommittedPatch: uncommittedPatch ?? null }, actorId)
    } catch {}
  }

  private recordContextConsumption(runId: string, worktreePath: string, declaredContextPaths: string[], reportedPath: string, actorId: string) {
    const candidate = resolve(worktreePath, reportedPath)
    const insideWorktree = candidate === worktreePath || candidate.startsWith(`${worktreePath}${sep}`)
    if (!insideWorktree || !existsSync(candidate) || !statSync(candidate).isFile()) {
      this.input.database.recordAgentRunEvent(runId, 'agent_run.context_rejected', { reportedPath, reason: 'outside_workspace_or_missing', reportSource: 'agent_protocol' }, actorId)
      return
    }
    const normalizedPath = relative(worktreePath, candidate).split(sep).join('/')
    this.input.database.recordAgentRunEvent(runId, 'agent_run.context_consumed', { path: normalizedPath, declared: declaredContextPaths.includes(normalizedPath), contentDigest: `sha256:${sha256(readFileSync(candidate))}`, reportSource: 'agent_protocol', independentlyObserved: false }, actorId)
  }
}
