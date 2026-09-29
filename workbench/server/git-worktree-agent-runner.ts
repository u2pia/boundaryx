import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ControlPlaneDatabase } from './database.ts'
import { resolveProjectRepository } from './code-host/index.ts'
import { LocalGitAuthority } from './local-git-authority.ts'
import { applyProjectManifest, loadProjectManifest, type ProjectManifestBinding } from './project-manifest.ts'
import { bindProjectSkills, type ProjectSkillBinding } from './project-skills.ts'
import { progressPathFor, readBuilderSteps } from './run-progress.ts'
import { removeRunWorktree, runRootFor, type PruneOutcome } from './run-worktree-lifecycle.ts'
import { compileDeclaredContext, declaredContextSummary, type DeclaredContextEntry } from './declared-context.ts'
import { sha256 } from './security.ts'
import { GIT_NO_EXEC, worktreeGit, worktreeGitDirectories, type WorktreeGit } from './worktree-git.ts'
import { AppError, type AgentRun, type AgentRunRequest, type AgentRunner, type AgentRunnerDescriptor, type BuilderStopReason, type ChangeProposal, type IntentVersion, type WorkItem } from './types.ts'

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
  /** How the Builder process itself was confined beyond its worktree, when it was; recorded so a reviewer can see what it could read. */
  confinement?: { kind: 'seatbelt'; deniedPaths: string[]; allowedPaths: string[]; readOnlyPaths: string[]; profileDigest: string }
  /** Whether the Builder could read registered evaluation holdouts. A holdout evaluation is independent only when it could not. */
  holdoutReadable?: boolean
  attestationDigest: string
}

export type AgentRuntimeContext = {
  runId: string
  worktreePath: string
  /** The worktree's Git directories as the repository records them, not as the worktree's `.git` file says. */
  git: WorktreeGit
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
}

export type AgentRunPostprocessorInput = {
  runId: string
  actorId: string
  adapterId: string
  worktreePath: string
  git: WorktreeGit
  workItem: WorkItem
  intent: IntentVersion
  projectManifest: ProjectManifestBinding
  startSha: string
  revisionOfProposalId?: string
  proposal: ChangeProposal
  attestation: AgentRuntimeAttestation
  stdoutDigest?: string
  stderrDigest?: string
  /** Set when the Builder reported that it was stopped at its budget rather than finishing. */
  builderStopped?: BuilderStopReason
}

export interface AgentRunPostprocessor {
  process(input: AgentRunPostprocessorInput): unknown
}

/**
 * A read the Builder's side reports. `engine_stream` is a wrapper saying it saw the read in its engine's own event
 * stream (a tool call that returned a result) rather than taking the model's word; it is still reported from inside the
 * run, so it is not independently observed.
 */
type ContextReport = { type: 'context_consumed'; path: string; source: 'agent_protocol' | 'engine_stream'; tool?: string; offset?: number; limit?: number }
type SkillLoadReport = { type: 'skill_loaded'; name: string; path: string; contentDigest: string; source: 'builder_tool' | 'engine_stream' | 'agent_protocol' }
type AgentProtocolMessage = ContextReport | SkillLoadReport | { type: 'message'; summary: string; stopped?: BuilderStopReason }
const builderStopReasons: readonly string[] = ['time_budget', 'step_budget'] satisfies BuilderStopReason[]

function git(repositoryPath: string, args: string[]) {
  try {
    return execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim()
  } catch (error) {
    throw new AppError(400, `Git operation failed: ${error instanceof Error ? error.message : String(error)}`, 'git_operation_failed')
  }
}

function gitIn(worktree: WorktreeGit, args: string[]) {
  try {
    return worktreeGit(worktree, args).trim()
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, `Git operation failed: ${error instanceof Error ? error.message : String(error)}`, 'git_operation_failed')
  }
}

function parseProtocol(stdout: string) {
  const messages: AgentProtocolMessage[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (value.type === 'context_consumed' && typeof value.path === 'string') {
        const count = (field: unknown) => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined
        const offset = count(value.offset)
        const limit = count(value.limit)
        messages.push({ type: 'context_consumed', path: value.path, source: value.source === 'engine_stream' ? 'engine_stream' : 'agent_protocol', ...(typeof value.tool === 'string' ? { tool: value.tool.slice(0, 40) } : {}), ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) })
      }
      if (value.type === 'skill_loaded' && typeof value.name === 'string' && typeof value.path === 'string' && typeof value.contentDigest === 'string') messages.push({ type: 'skill_loaded', name: value.name.slice(0, 80), path: value.path, contentDigest: value.contentDigest, source: value.source === 'engine_stream' ? 'engine_stream' : value.source === 'agent_protocol' ? 'agent_protocol' : 'builder_tool' })
      if (value.type === 'message' && typeof value.summary === 'string') messages.push({ type: 'message', summary: value.summary.slice(0, 1000), ...(typeof value.stopped === 'string' && builderStopReasons.includes(value.stopped) ? { stopped: value.stopped as BuilderStopReason } : {}) })
    } catch {}
  }
  return messages
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
    const projectSkills = bindProjectSkills(repositoryPath, baseSha, projectManifest.manifest.skills)
    const holdout = projectManifest.manifest.evaluation.holdout
    if (holdout && this.input.database.readEvaluationHoldout(workItem.projectId, holdout.digest) === undefined) throw new AppError(422, `The evaluation holdout ${holdout.digest} named by the project manifest is not registered with this Control Plane, or no longer has that digest`, 'evaluation_holdout_missing')
    const declaredContextPaths = applyProjectManifest({ binding: projectManifest, workItem, intent, runtime: this.descriptor, declaredContextPaths: request.declaredContextPaths })
    const declaredContext = compileDeclaredContext(repositoryPath, baseSha, declaredContextPaths, projectManifest.manifest.context.required)
    const runId = `RUN-${randomUUID().slice(0, 8).toUpperCase()}`
    const branchRef = revisionProposal ? `agent/revision-${runId.toLowerCase()}` : `agent/${runId.toLowerCase()}`
    const runRoot = resolve(this.input.worktreeRoot, runId)
    const worktreePath = join(runRoot, 'worktree')
    const requestPath = join(runRoot, 'request.json')
    const timeoutMs = this.input.timeoutMs ?? 10 * 60 * 1000
    mkdirSync(runRoot, { recursive: true })
    let attestation: ReturnType<AgentExecutionRuntime['attest']>
    let run: AgentRun
    try {
      git(repositoryPath, ['worktree', 'add', '-b', branchRef, worktreePath, startSha])
      const worktree = worktreeGitDirectories(repositoryPath, worktreePath)
      gitIn(worktree, ['config', 'user.name', 'BoundaryX Local Agent'])
      gitIn(worktree, ['config', 'user.email', 'local-agent@aperture.invalid'])
      writeFileSync(requestPath, JSON.stringify({ runId, workItem, intent, workspace: worktreePath, projectManifest: { path: projectManifest.path, baseSha: projectManifest.baseSha, digest: projectManifest.digest, skills: projectSkills, evaluation: { profile: projectManifest.manifest.evaluation.profile, datasetPath: projectManifest.manifest.evaluation.datasetPath, holdout: Boolean(holdout), datasetDigest: projectManifest.evaluationDatasetDigest, thresholds: projectManifest.manifest.evaluation.thresholds }, artifact: projectManifest.manifest.artifact ?? null, builder: { allowShell: projectManifest.manifest.builder?.allowShell === true } }, declaredContextPaths, declaredContext: { baseSha, entries: declaredContext.entries.map((entry) => ({ path: entry.path, required: entry.required, fileBytes: entry.fileBytes, truncatedAt: entry.truncatedAt, content: entry.content })), omitted: declaredContext.omitted }, revision: revisionProposal ? { changeProposalId: revisionProposal.id, previousHeadRef: revisionProposal.headRef, previousHeadSha: revisionProposal.headSha, feedback: reviewFeedback } : null }, null, 2))
      const runtimeContext = { runId, worktreePath, git: worktree, requestPath, timeoutMs }
      attestation = this.input.runtime.attest(runtimeContext)
      run = this.input.database.createAgentRun({ id: runId, workItemId: workItem.id, intentVersionId: intent.id, repositoryPath, baseRef: request.baseRef, baseSha, startSha, revisionOfProposalId: revisionProposal?.id, branchRef, worktreePath, adapterId: this.id, isolation: attestation.isolation, runtimeImageRef: attestation.imageRef, runtimeAttestationDigest: attestation.attestationDigest, networkEgress: attestation.networkEgress, productionEligible: attestation.productionEligible, requestKey: request.requestKey, admissionRequestDigest: request.admissionRequestDigest, startedByActorId: actorId, status: 'queued' })
    } catch (error) {
      // Refused before the run row existed (e.g. its Idempotency-Key was taken by a concurrent admission), so
      // nothing in the database points at this checkout or branch and no reconciler would ever remove them.
      removeRunWorktree({ repositoryPath, worktreePath, runRoot })
      try {
        git(repositoryPath, ['branch', '-D', branchRef])
      } catch {}
      throw error
    }
    this.input.database.saveAgentRunPlan({ runId, declaredContextPaths, requestPath, timeoutMs })
    this.input.database.recordAgentRunEvent(runId, 'agent_run.runtime_attested', attestation, actorId)
    if (revisionProposal) this.input.database.recordAgentRunEvent(runId, 'agent_run.revision_feedback_bound', { changeProposalId: revisionProposal.id, previousHeadRef: revisionProposal.headRef, previousHeadSha: revisionProposal.headSha, feedbackReviewIds: reviewFeedback.map((feedback) => feedback.reviewId), feedbackDigest: `sha256:${sha256(JSON.stringify(reviewFeedback))}` }, actorId)
    this.input.database.recordAgentRunEvent(runId, 'agent_run.project_manifest_bound', { path: projectManifest.path, baseSha: projectManifest.baseSha, digest: projectManifest.digest, schemaVersion: projectManifest.manifest.schemaVersion, productType: projectManifest.manifest.productType, requiredContextCount: projectManifest.manifest.context.required.length, allowedContextCount: projectManifest.manifest.context.allowed.length, skills: projectSkills.map((skill) => ({ name: skill.name, path: skill.path, contentDigest: skill.contentDigest, fileBytes: skill.fileBytes })), checks: projectManifest.manifest.checks.map((check) => ({ name: check.name, kind: check.kind })), evaluationProfile: projectManifest.manifest.evaluation.profile, evaluationDatasetPath: projectManifest.manifest.evaluation.datasetPath ?? null, evaluationHoldout: Boolean(holdout), evaluationDatasetDigest: projectManifest.evaluationDatasetDigest ?? null, artifact: projectManifest.manifest.artifact ?? null, policy: projectManifest.manifest.policy, builder: { allowShell: projectManifest.manifest.builder?.allowShell === true } }, actorId)
    this.input.database.recordAgentRunEvent(runId, 'agent_run.context_compiled', declaredContextSummary(declaredContext), actorId)
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
    const worktree = worktreeGitDirectories(repositoryPath, worktreePath)
    const runtimeContext = { runId, worktreePath, git: worktree, requestPath: plan.requestPath, timeoutMs: plan.timeoutMs }
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
    const projectSkills = bindProjectSkills(repositoryPath, baseSha, projectManifest.manifest.skills)
    if (projectManifest.digest !== this.input.database.listAggregateEvents('agent_run', runId).find((event) => event.eventType === 'agent_run.project_manifest_bound')?.payload.digest) {
      this.input.database.recordAgentRunEvent(runId, 'agent_run.project_manifest_drift', { observed: projectManifest.digest }, actorId)
      return this.terminal(runId, repositoryPath, actorId, { status: 'failed', errorMessage: 'Project manifest changed between admission and execution' })
    }

    let exitCode: number | undefined
    let stdoutDigest: string | undefined
    let stderrDigest: string | undefined
    let changeProposalId: string | undefined
    let diagnostic: string | undefined
    try {
      this.recordContextInjection(runId, actorId)
      const result = this.input.runtime.execute(runtimeContext)
      diagnostic = result.diagnostic
      this.recordBuilderProgress(runId, plan.requestPath, actorId)
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      exitCode = result.status ?? undefined
      stdoutDigest = `sha256:${sha256(stdout)}`
      stderrDigest = `sha256:${sha256(stderr)}`
      let builderStopped: BuilderStopReason | undefined
      for (const message of parseProtocol(stdout)) {
        if (message.type === 'message') {
          // The agent's own report; review readiness reads `stopped` from the run behind the current head.
          this.input.database.recordAgentRunEvent(runId, 'agent_run.message', { summary: message.summary, ...(message.stopped ? { stopped: message.stopped } : {}) }, actorId)
          builderStopped = message.stopped ?? builderStopped
        } else if (message.type === 'skill_loaded') this.recordSkillLoad(runId, projectSkills, message, actorId)
        else this.recordContextConsumption(runId, worktreePath, declaredContextPaths, projectSkills, message, actorId)
      }
      if (this.input.database.isAgentRunCancellationRequested(runId)) return this.terminal(runId, repositoryPath, actorId, { status: 'cancelled', exitCode, stdoutDigest, stderrDigest, errorMessage: 'Agent run was cancelled while the agent was generating' })
      if (result.error) throw new AppError((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 408 : 422, `Agent runtime failed: ${result.error.message}`, 'agent_runtime_failed')
      // The message keeps the last few lines; the full tail goes to the failure diagnostic event.
      const lastLines = result.diagnostic?.split('\n').slice(-5).join('\n').slice(-800)
      if (result.status !== 0) throw new AppError(422, `Agent exited with status ${result.status ?? 'unknown'}${lastLines ? `: ${lastLines}` : ''}`, 'agent_execution_failed')
      const changed = gitIn(worktree, ['status', '--porcelain'])
      if (!changed) throw new AppError(422, 'Agent completed without producing a repository change', 'agent_empty_change')
      gitIn(worktree, ['add', '-A'])
      gitIn(worktree, ['commit', '-m', `agent: ${workItem.title.slice(0, 72)}`])
      const authority = new LocalGitAuthority(this.input.database)
      const proposal = revisionProposal
        ? authority.reviseChangeProposal(revisionProposal.id, runId, branchRef, actorId).proposal
        : authority.createChangeProposal({ workItemId: workItem.id, intentVersionId: intent.id, runId, repositoryPath, baseRef: queued.baseRef, headRef: branchRef, authorActorId: actorId }, actorId)
      changeProposalId = proposal.id
      this.input.database.recordAgentRunEvent(runId, revisionProposal ? 'agent_run.change_revised' : 'agent_run.change_proposed', { changeProposalId: proposal.id, previousHeadSha: revisionProposal?.headSha ?? null, headSha: proposal.headSha, changedFiles: proposal.changedFiles, additions: proposal.additions, deletions: proposal.deletions }, actorId)
      this.input.postprocessor?.process({ runId, actorId, adapterId: this.id, worktreePath, git: worktree, workItem, intent, projectManifest, startSha, revisionOfProposalId: revisionProposal?.id, proposal, attestation, stdoutDigest, stderrDigest, builderStopped })
      return this.terminal(runId, repositoryPath, actorId, { status: 'succeeded', changeProposalId: proposal.id, exitCode: result.status ?? 0, stdoutDigest, stderrDigest })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = this.input.database.isAgentRunCancellationRequested(runId)
      // Captured before terminal() prunes the worktree, which would take the uncommitted work with it.
      if (!cancelled) this.recordFailureDiagnostic(runId, worktree, diagnostic, actorId)
      this.terminal(runId, repositoryPath, actorId, { status: cancelled ? 'cancelled' : 'failed', changeProposalId, exitCode, stdoutDigest, stderrDigest, errorMessage: cancelled ? `Agent run was cancelled: ${message}` : message })
      throw error
    }
  }

  /** Keeps the Builder's own step log, which goes with the run directory, as its self-report for later reading. */
  private recordBuilderProgress(runId: string, requestPath: string, actorId: string) {
    const steps = readBuilderSteps(progressPathFor(requestPath), 50)
    if (steps.total) this.input.database.recordAgentRunEvent(runId, 'agent_run.builder_progress', { source: 'builder_self_report', total: steps.total, steps: steps.recent }, actorId)
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
  private recordFailureDiagnostic(runId: string, worktree: WorktreeGit, stderrTail: string | undefined, actorId: string) {
    try {
      let uncommittedChanges: string[] = []
      try {
        uncommittedChanges = worktreeGit(worktree, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).slice(0, 100)
      } catch {}
      // The agent's unfinished work is kept as a patch beside the worktree, so it survives worktree cleanup and can be
      // reviewed or applied by hand. It stays on this machine and is referenced from the event by digest only.
      let uncommittedPatch: { path: string; digest: string; bytes: number } | undefined
      if (uncommittedChanges.length) {
        try {
          worktreeGit(worktree, ['add', '-A'])
          const patch = worktreeGit(worktree, ['diff', '--cached', '--binary'])
          worktreeGit(worktree, ['reset', '-q'])
          const patchPath = resolve(dirname(worktree.worktreePath), 'uncommitted.patch')
          writeFileSync(patchPath, patch)
          uncommittedPatch = { path: patchPath, digest: `sha256:${sha256(patch)}`, bytes: Buffer.byteLength(patch) }
        } catch {}
      }
      this.input.database.recordAgentRunEvent(runId, 'agent_run.failure_diagnostic', { stderrTail: stderrTail ?? null, uncommittedChanges, uncommittedPatch: uncommittedPatch ?? null }, actorId)
    } catch {}
  }

  /**
   * What the Control Plane put in the Builder's prompt, from the compilation recorded at admission. Observed by the
   * Control Plane itself rather than reported by the Builder, and exact down to where a file was cut.
   */
  private recordContextInjection(runId: string, actorId: string) {
    const compiled = this.input.database.listAggregateEvents('agent_run', runId).find((event) => event.eventType === 'agent_run.context_compiled')?.payload as { baseSha: string; entries: Omit<DeclaredContextEntry, 'content'>[] } | undefined
    for (const entry of compiled?.entries ?? []) this.input.database.recordAgentRunEvent(runId, 'agent_run.context_consumed', { path: entry.path, declared: true, required: entry.required, contentDigest: entry.injectedDigest, fileDigest: entry.fileDigest, fileBytes: entry.fileBytes, injectedBytes: entry.injectedBytes, truncatedAt: entry.truncatedAt, revision: compiled!.baseSha, reportSource: 'control_plane_injection', independentlyObserved: true }, actorId)
  }

  private recordSkillLoad(runId: string, projectSkills: ProjectSkillBinding[], report: SkillLoadReport, actorId: string) {
    const skill = projectSkills.find((candidate) => candidate.name === report.name && candidate.path === report.path)
    if (!skill || skill.contentDigest !== report.contentDigest) {
      this.input.database.recordAgentRunEvent(runId, 'agent_run.skill_rejected', { name: report.name, path: report.path, reportedDigest: report.contentDigest, reason: skill ? 'digest_mismatch' : 'not_declared', reportSource: report.source }, actorId)
      return
    }
    this.input.database.recordAgentRunEvent(runId, 'agent_run.skill_loaded', { name: skill.name, path: skill.path, description: skill.description, revision: skill.baseSha, contentDigest: skill.contentDigest, fileBytes: skill.fileBytes, reportSource: report.source, independentlyObserved: false }, actorId)
  }

  private recordContextConsumption(runId: string, worktreePath: string, declaredContextPaths: string[], projectSkills: ProjectSkillBinding[], report: ContextReport, actorId: string) {
    const reported = { reportSource: report.source, ...(report.tool ? { tool: report.tool } : {}), ...(report.offset === undefined ? {} : { offset: report.offset }), ...(report.limit === undefined ? {} : { limit: report.limit }) }
    const candidate = resolve(worktreePath, report.path)
    const insideWorktree = candidate === worktreePath || candidate.startsWith(`${worktreePath}${sep}`)
    const kind = insideWorktree && existsSync(candidate) ? statSync(candidate).isFile() ? 'file' : statSync(candidate).isDirectory() ? 'directory' : undefined : undefined
    if (!kind) {
      this.input.database.recordAgentRunEvent(runId, 'agent_run.context_rejected', { reportedPath: report.path, reason: 'outside_workspace_or_missing', ...reported }, actorId)
      return
    }
    const normalizedPath = relative(worktreePath, candidate).split(sep).join('/') || '.'
    // A search across a directory (Grep in content mode) read the matching lines of files under it, which cannot be
    // named one by one from the report; it is recorded as the directory searched, with nothing to digest.
    const declared = kind === 'file' ? declaredContextPaths.includes(normalizedPath) : false
    const contentDigest = kind === 'file' ? `sha256:${sha256(readFileSync(candidate))}` : undefined
    this.input.database.recordAgentRunEvent(runId, 'agent_run.context_consumed', { path: normalizedPath, declared, ...(contentDigest ? { contentDigest } : { searchedDirectory: true }), ...reported, independentlyObserved: false }, actorId)
    const skill = kind === 'file' ? projectSkills.find((candidateSkill) => candidateSkill.path === normalizedPath) : undefined
    if (skill && contentDigest) this.recordSkillLoad(runId, projectSkills, { type: 'skill_loaded', name: skill.name, path: skill.path, contentDigest, source: report.source }, actorId)
  }

}
