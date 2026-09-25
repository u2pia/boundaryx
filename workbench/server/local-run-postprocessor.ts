import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ControlPlaneDatabase } from './database.ts'
import type { AgentRunPostprocessor, AgentRunPostprocessorInput } from './git-worktree-agent-runner.ts'
import type { LocalEvidenceStore } from './local-evidence-store.ts'
import type { ProjectEvaluationProcess, ProjectEvaluationThreshold } from './project-manifest.ts'
import { seatbeltAvailable, seatbeltCommand } from './seatbelt.ts'
import { mapCriteriaToChecks } from './criteria-coverage.ts'
import { POLICY_PATH_PREFIX } from './local-git-authority.ts'
import { sha256 } from './security.ts'

export type LocalCheckDefinition = {
  name: string
  kind: 'test' | 'evaluation' | 'build'
  executable: string
  args: string[]
  timeoutMs: number
}

/**
 * Where the tests behind a check came from.
 * - `all_tests`: run against the agent's head revision, including tests the run itself authored.
 * - `pre_existing`: run against test files taken from the proposal's base revision, so the agent
 *   could not influence the questions. This is the only conclusion that is independent evidence.
 * - `unverified`: the project manifest declares no `testPaths`, so no independent signal exists.
 * - `isolated`: a holdout evaluation whose grader came from the base revision, whose subject ran sandboxed away from
 *   the holdout, and whose Builder could not read the holdout either. The only independent evaluation result.
 * - `isolated_partial`: a holdout evaluation missing one of those, so the subject or the Builder could have seen it.
 */
export type CheckProvenance = 'all_tests' | 'pre_existing' | 'unverified' | 'isolated' | 'isolated_partial'

type ExecutedCheck = {
  id: string
  name: string
  kind: 'test' | 'evaluation' | 'build' | 'integrity'
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled'
  exitCode?: number
  durationMs: number
  stdoutDigest: string
  stderrDigest: string
  stdoutExcerpt: string
  stderrExcerpt: string
  provenance?: CheckProvenance
  testTreeSha?: string
  agentModifiedTestFiles?: string[]
  metrics?: Record<string, number>
  metricConflicts?: string[]
  thresholdResults?: Array<ProjectEvaluationThreshold & { actual?: number; passed: boolean }>
}

function excerpt(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/gu, '').slice(0, 4000)
}

/**
 * The metrics an evaluation printed. A metric reported twice with different values is a conflict, not "the last one
 * wins": the code under evaluation shares the grader's stdout and could otherwise print a better score after it.
 */
/** Dataset strings shorter than this are too likely to appear in honest code to count as a leak. */
const DATASET_LEAK_MINIMUM_LENGTH = 12

/** The string values of a dataset that are specific enough to be recognised when copied: JSON leaves, else whole lines. */
function datasetLeakCandidates(content: string) {
  const values = new Set<string>()
  const collect = (value: unknown): void => {
    if (typeof value === 'string') { if (value.trim().length >= DATASET_LEAK_MINIMUM_LENGTH) values.add(value.trim()) }
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try { collect(JSON.parse(line)) } catch { collect(line) }
  }
  return [...values]
}

const UNREADABLE_METRICS_LINE = '(unreadable evaluation_metrics line)'

function evaluationMetrics(stdout: string) {
  const metrics: Record<string, number> = {}
  const conflicts = new Set<string>()
  for (const line of stdout.split('\n')) {
    // A metrics record the parser cannot read is not skipped: output glued onto the grader's line (an unterminated
    // write before it) would otherwise hide the grader's score and leave only a later, self-printed one.
    const mentionsMetrics = line.includes('evaluation_metrics')
    let value: Record<string, unknown> | undefined
    try { value = line.trim().startsWith('{') ? JSON.parse(line) as Record<string, unknown> : undefined } catch {}
    if (!value || value.type !== 'evaluation_metrics' || !value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)) {
      if (mentionsMetrics) conflicts.add(UNREADABLE_METRICS_LINE)
      continue
    }
    for (const [name, metric] of Object.entries(value.metrics as Record<string, unknown>)) {
      if (typeof metric !== 'number' || !Number.isFinite(metric)) continue
      if (name in metrics && metrics[name] !== metric) conflicts.add(name)
      metrics[name] = metric
    }
  }
  return { metrics, conflicts: [...conflicts] }
}

function thresholdResultsFor(thresholds: ProjectEvaluationThreshold[], metrics: Record<string, number> | undefined) {
  return thresholds.map((threshold) => { const actual = metrics?.[threshold.metric]; return { ...threshold, actual, passed: actual !== undefined && (threshold.operator === 'gte' ? actual >= threshold.threshold : actual <= threshold.threshold) } })
}

type EvaluationPhase = { phase: 'inputs' | 'subject' | 'score'; exitCode: number | null; durationMs: number; timedOut: boolean; stdoutDigest: string; stderrDigest: string; error?: string }

export class LocalRunPostprocessor implements AgentRunPostprocessor {
  private readonly input: { database: ControlPlaneDatabase; evidenceStore: LocalEvidenceStore }

  constructor(input: { database: ControlPlaneDatabase; evidenceStore: LocalEvidenceStore }) {
    this.input = input
  }

  process(input: AgentRunPostprocessorInput) {
    const checks: ExecutedCheck[] = []
    const manifestChecks = input.projectManifest.manifest.checks
    const testPaths = input.projectManifest.manifest.testPaths
    const agentModifiedTestFiles = testPaths.length ? this.diffFiles(input.worktreePath, input.proposal.baseSha, input.proposal.headSha, testPaths) : []
    const headProvenance: CheckProvenance = !testPaths.length ? 'unverified' : agentModifiedTestFiles.length ? 'all_tests' : 'pre_existing'
    // The grader gets the same treatment as the tests: which revision of it produced each evaluation result.
    const harnessPaths = input.projectManifest.manifest.evaluation.harnessPaths ?? []
    const agentModifiedHarnessFiles = harnessPaths.length ? this.diffFiles(input.worktreePath, input.proposal.baseSha, input.proposal.headSha, harnessPaths) : []
    const harnessProvenance: CheckProvenance = !harnessPaths.length ? 'unverified' : agentModifiedHarnessFiles.length ? 'all_tests' : 'pre_existing'
    const holdout = input.projectManifest.manifest.evaluation.holdout
    const datasetBeforeChecks = input.projectManifest.manifest.evaluation.profile === 'agent_dataset' && !holdout ? this.datasetState(input) : undefined
    if (datasetBeforeChecks) checks.push(this.recordEvaluationDatasetIntegrity(input), this.recordEvaluationDatasetLeakage(input, this.baseDataset(input), input.projectManifest.manifest.evaluation.datasetPath!))
    // A holdout evaluation runs first, before any check has executed code from the head revision that could linger.
    let isolated: ReturnType<LocalRunPostprocessor['executeIsolatedEvaluation']> | undefined
    if (holdout) {
      const content = this.input.database.readEvaluationHoldout(input.proposal.projectId, holdout.digest)
      checks.push(this.recordEvaluationHoldoutIntegrity(input, content !== undefined))
      if (content !== undefined) {
        checks.push(this.recordEvaluationDatasetLeakage(input, content, `holdout:${holdout.digest}`))
        isolated = this.executeIsolatedEvaluation(input, content, harnessProvenance)
        checks.push(isolated.check)
      }
    }
    checks.push(...manifestChecks.map((check) => this.executeCheck({ name: check.name, kind: check.kind, executable: check.command[0], args: check.command.slice(1), timeoutMs: check.timeoutMs }, input, check.kind === 'test' ? { provenance: headProvenance, testTreeSha: input.proposal.headSha, agentModifiedTestFiles } : check.kind === 'evaluation' ? { provenance: harnessProvenance, testTreeSha: input.proposal.headSha, agentModifiedTestFiles: agentModifiedHarnessFiles } : undefined)))
    if (agentModifiedTestFiles.length) checks.push(...this.executeBaselineChecks(input, 'test', testPaths, agentModifiedTestFiles))
    if (agentModifiedHarnessFiles.length) checks.push(...this.executeBaselineChecks(input, 'evaluation', harnessPaths, agentModifiedHarnessFiles))
    if (datasetBeforeChecks) checks.push(this.recordEvaluationDatasetUntouched(input, datasetBeforeChecks))
    const artifacts = this.collectBuildArtifacts(input, checks)
    const allowedArtifactPaths = new Set(artifacts.map((artifact) => artifact.path))
    const dirty = execFileSync('git', ['-C', input.worktreePath, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim().split('\n').filter((line) => line && !allowedArtifactPaths.has(line.slice(3))).join('\n')
    if (dirty) checks.push(this.recordDirtyWorkspace(input, dirty))
    const testChecks = checks.filter((check) => check.kind === 'test')
    const testProvenance = {
      declaredTestPaths: testPaths,
      baseSha: input.proposal.baseSha,
      agentModifiedTestFiles,
      headConclusions: testChecks.filter((check) => check.testTreeSha === input.proposal.headSha).map((check) => ({ name: check.name, conclusion: check.conclusion })),
      baselineConclusions: testChecks.filter((check) => check.testTreeSha === input.proposal.baseSha).map((check) => ({ name: check.name, conclusion: check.conclusion })),
      independent: headProvenance !== 'unverified',
      note: headProvenance === 'unverified'
        ? 'The project manifest declares no testPaths, so no test result in this package is independent of the change under review.'
        : headProvenance === 'pre_existing'
          ? 'The run did not modify any declared test path; every test result is independent of the change under review.'
          : 'The run modified declared test paths, so the head test results are not independent. The @baseline results were produced with the test files reset to the proposal base revision.',
      // Everything else the run changed stayed at head during the @baseline re-runs: the code under test by design,
      // but also any helper or fixture outside testPaths. Listed so the reviewer can see where the baseline ends.
      filesAtHeadDuringBaseline: agentModifiedTestFiles.length ? this.diffFiles(input.worktreePath, input.proposal.baseSha, input.proposal.headSha, ['.']).filter((file) => !agentModifiedTestFiles.includes(file)) : [],
    }
    const evaluationProvenance = holdout ? {
      mode: 'holdout' as const,
      holdoutDigest: holdout.digest,
      declaredHarnessPaths: harnessPaths,
      agentModifiedHarnessFiles,
      graderFromBase: true,
      subjectConfinement: isolated?.subjectConfinement ?? null,
      builderHoldoutReadable: isolated?.builderHoldoutReadable ?? input.attestation.holdoutReadable !== false,
      independent: isolated?.check.provenance === 'isolated',
      note: isolated?.check.provenance === 'isolated'
        ? 'The grader ran from the base revision, in its own directory with the holdout; the code under evaluation ran from the head revision under Seatbelt, with the holdout, the grader, the repository and the Control Plane data unreadable and no network; and the Builder was confined away from the holdout. The evaluation result is independent of the change under review.'
        : !isolated
          ? 'The holdout named by the manifest could not be read, so no evaluation ran.'
          : `The evaluation is not independent: ${[!isolated.subjectConfinement ? 'the code under evaluation ran unconfined and could read the holdout' : '', isolated.builderHoldoutReadable ? 'the Builder ran without confinement and could read the holdout' : ''].filter(Boolean).join('; ')}. A critical model criterion needs a reviewer override.`,
    } : input.projectManifest.manifest.evaluation.profile === 'agent_dataset' ? {
      mode: 'in_worktree' as const,
      declaredHarnessPaths: harnessPaths,
      agentModifiedHarnessFiles,
      graderFromBase: harnessProvenance !== 'unverified',
      // The grader runs the code under evaluation in its own process, and the dataset sits in the worktree, so that code
      // can read the answers at runtime. No local evaluation is independent, whoever wrote the grader.
      independent: false,
      note: (harnessProvenance === 'unverified'
        ? 'The project manifest declares no evaluation.harnessPaths, so the run could have edited the grader.'
        : harnessProvenance === 'pre_existing'
          ? 'The run did not modify the declared grader; the evaluation results come from the base revision of it.'
          : 'The run modified the declared grader, so the head evaluation results are not trustworthy. The @baseline results were produced with the grader reset to the proposal base revision.')
        + ' The code under evaluation runs inside the grader process and can read the hidden dataset, so no evaluation result in this package is independent of the change under review; a critical model criterion needs a reviewer override.',
    } : undefined
    const criteriaCoverage = mapCriteriaToChecks(input.intent, checks)
    const runEvents = this.input.database.listAggregateEvents('agent_run', input.runId)
    const proposalEvents = this.input.database.listAggregateEvents('change_proposal', input.proposal.id)
    // Which project and host this evidence is about. The pull request, if any, is opened after the package is sealed
    // and is linked from the proposal instead.
    const project = this.input.database.getProject(input.proposal.projectId)
    const hosted = project.codeHost === 'github' ? { repository: `${project.codeHostConfig.owner}/${project.codeHostConfig.repo}`, webUrl: `${project.codeHostConfig.webBase}/${project.codeHostConfig.owner}/${project.codeHostConfig.repo}` } : { repository: project.repositoryPath ?? input.proposal.repositoryPath }
    const eventChainHeads = { runEventChainHead: runEvents.at(-1)?.eventDigest ?? 'genesis', proposalEventChainHead: proposalEvents.at(-1)?.eventDigest ?? 'genesis' }
    const stored = this.input.evidenceStore.write({
      schemaVersion: 'aperture.evidence.v1',
      generatedAt: new Date().toISOString(),
      projectManifest: { path: input.projectManifest.path, baseSha: input.projectManifest.baseSha, digest: input.projectManifest.digest, schemaVersion: input.projectManifest.manifest.schemaVersion, policy: input.projectManifest.manifest.policy, evaluation: { ...input.projectManifest.manifest.evaluation, datasetDigest: input.projectManifest.evaluationDatasetDigest }, artifact: input.projectManifest.manifest.artifact },
      workItem: { id: input.workItem.id, title: input.workItem.title, productType: input.workItem.productType },
      intent: { id: input.intent.id, version: input.intent.version, goal: input.intent.goal, riskLevel: input.intent.riskLevel, contentDigest: input.intent.contentDigest, constraints: input.intent.constraints, acceptanceCriteria: input.intent.acceptanceCriteria },
      project: { id: project.id, slug: project.slug },
      codeHost: { provider: project.codeHost, mergeMode: project.mergeMode, defaultBranch: project.defaultBranch, ...hosted },
      git: { repositoryPath: input.proposal.repositoryPath, baseRef: input.proposal.baseRef, baseSha: input.proposal.baseSha, headRef: input.proposal.headRef, headSha: input.proposal.headSha, changedFiles: input.proposal.changedFiles, additions: input.proposal.additions, deletions: input.proposal.deletions },
      run: { id: input.runId, adapterId: input.adapterId, startSha: input.startSha, revisionOfProposalId: input.revisionOfProposalId, isolation: input.attestation.isolation, networkEgress: input.attestation.networkEgress, productionEligible: input.attestation.productionEligible, runtimeAttestationDigest: input.attestation.attestationDigest, stdoutDigest: input.stdoutDigest, stderrDigest: input.stderrDigest, builderStopped: input.builderStopped ?? null },
      checks,
      criteriaCoverage,
      testProvenance,
      ...(evaluationProvenance ? { evaluationProvenance } : {}),
      // DOMAIN_MODEL.md §9.1.1: marked prominently when the run edited the rules that govern it. Every check above ran
      // under the base revision's manifest, so none of them evaluates the new rules.
      policyChanges: { pathPrefix: POLICY_PATH_PREFIX, files: input.proposal.policyFiles ?? [], governedBy: `${input.projectManifest.path}@${input.projectManifest.baseSha}` },
      artifacts,
      provenance: { ...eventChainHeads, generatedBy: 'local-run-postprocessor@0.1' },
    })
    const failedChecks = checks.filter((check) => check.conclusion === 'failure' || check.conclusion === 'cancelled').length
    const evidence = this.input.database.recordEvidence({ proposalId: input.proposal.id, runId: input.runId, headSha: input.proposal.headSha, uri: stored.uri, sha256: stored.sha256, summary: { status: failedChecks ? 'blocked' : checks.length ? 'ready' : 'incomplete', totalChecks: checks.length, failedChecks, testProvenance: headProvenance, independentTestSignal: testProvenance.baselineConclusions.length > 0 || headProvenance === 'pre_existing', agentModifiedTestFileCount: agentModifiedTestFiles.length, evaluationProfile: input.projectManifest.manifest.evaluation.profile, evaluationDatasetDigest: input.projectManifest.evaluationDatasetDigest, artifactCount: artifacts.length, policyFiles: input.proposal.policyFiles ?? [], builderStopped: input.builderStopped ?? null, criteriaCoverage, eventChainHeads, packageSchema: stored.value.schemaVersion, generatedAt: stored.value.generatedAt, trustMode: this.input.database.getIdentityMode() } }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.evidence_packaged', { evidenceId: evidence.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, uri: stored.uri, sha256: stored.sha256, totalChecks: checks.length, failedChecks }, input.actorId)
    return { evidenceId: evidence.id, packageDigest: stored.sha256, checks }
  }

  /** Files under `paths` that differ between two revisions. An unmatched pathspec is not an error. */
  private diffFiles(worktreePath: string, fromSha: string, toSha: string, paths: string[]) {
    return execFileSync('git', ['-C', worktreePath, 'diff', '--name-only', '-z', fromSha, toSha, '--', ...paths], { encoding: 'utf8' }).split('\0').filter(Boolean)
  }

  private treeFiles(worktreePath: string, sha: string, paths: string[]) {
    return execFileSync('git', ['-C', worktreePath, 'ls-tree', '-r', '--name-only', '-z', sha, '--', ...paths], { encoding: 'utf8' }).split('\0').filter(Boolean)
  }

  /**
   * Makes the working tree under `paths` match `sha` exactly: files the target revision does not
   * contain are removed, the rest are checked out. `previousFiles` is the file list of the revision
   * currently materialized, because `git checkout` alone never removes files.
   */
  private materializeTestPaths(worktreePath: string, sha: string, paths: string[], previousFiles: string[]) {
    const target = new Set(this.treeFiles(worktreePath, sha, paths))
    for (const file of previousFiles) if (!target.has(file)) rmSync(resolve(worktreePath, file), { force: true })
    const present = paths.filter((path) => target.has(path) || [...target].some((file) => file.startsWith(`${path}/`)))
    if (present.length) execFileSync('git', ['-C', worktreePath, 'checkout', sha, '--', ...present], { encoding: 'utf8' })
  }

  /**
   * Re-runs every declared check of `kind` with `paths` (the tests, or the grader) reset to the proposal base
   * revision, so that the package carries at least one conclusion the agent could not have authored the questions or
   * the scoring for. The code under test stays at head: that is what is being judged.
   */
  private executeBaselineChecks(input: AgentRunPostprocessorInput, kind: 'test' | 'evaluation', testPaths: string[], agentModifiedTestFiles: string[]): ExecutedCheck[] {
    const definitions = input.projectManifest.manifest.checks.filter((check) => check.kind === kind)
    if (!definitions.length) return []
    const headFiles = this.treeFiles(input.worktreePath, input.proposal.headSha, testPaths)
    const baseFiles = this.treeFiles(input.worktreePath, input.proposal.baseSha, testPaths)
    const results: ExecutedCheck[] = []
    try {
      this.materializeTestPaths(input.worktreePath, input.proposal.baseSha, testPaths, headFiles)
    } catch (error) {
      return [this.recordBaselineUnavailable(input, kind, error instanceof Error ? error.message : String(error))]
    }
    try {
      for (const definition of definitions) results.push(this.executeCheck({ name: `${definition.name}@baseline`, kind: definition.kind, executable: definition.command[0], args: definition.command.slice(1), timeoutMs: definition.timeoutMs }, input, { provenance: 'pre_existing', testTreeSha: input.proposal.baseSha, agentModifiedTestFiles }))
    } finally {
      this.materializeTestPaths(input.worktreePath, input.proposal.headSha, testPaths, baseFiles)
    }
    return results
  }

  private recordBaselineUnavailable(input: AgentRunPostprocessorInput, kind: 'test' | 'evaluation', reason: string): ExecutedCheck {
    const name = kind === 'test' ? 'baseline-tests-available' : 'baseline-evaluation-available'
    const message = `Could not reset declared ${kind === 'test' ? 'test paths' : 'evaluation harness paths'} to base revision ${input.proposal.baseSha}: ${reason}`
    const stdoutDigest = `sha256:${sha256('')}`
    const stderrDigest = `sha256:${sha256(message)}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name, status: 'completed', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, kind === 'test' ? 'agent_run.baseline_tests_unavailable' : 'agent_run.baseline_evaluation_unavailable', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, baseSha: input.proposal.baseSha, reason }, input.actorId)
    return { id: check.id, name, kind: 'integrity', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: '', stderrExcerpt: message }
  }

  private executeCheck(definition: LocalCheckDefinition, input: AgentRunPostprocessorInput, testOrigin?: { provenance: CheckProvenance; testTreeSha: string; agentModifiedTestFiles: string[] }): ExecutedCheck {
    const started = Date.now()
    const command = this.checkCommand(input, definition)
    const result = spawnSync(command.executable, command.args, { cwd: input.worktreePath, encoding: 'utf8', timeout: definition.timeoutMs, maxBuffer: 10 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CI: 'true', NO_COLOR: '1', ...(definition.kind === 'evaluation' && input.projectManifest.manifest.evaluation.datasetPath ? { APERTURE_EVALUATION_DATASET: input.projectManifest.manifest.evaluation.datasetPath, APERTURE_EVALUATION_DATASET_DIGEST: input.projectManifest.evaluationDatasetDigest ?? '' } : {}) } })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const durationMs = Date.now() - started
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    const reported = definition.kind === 'evaluation' ? evaluationMetrics(stdout) : undefined
    const metrics = reported?.metrics
    const metricConflicts = reported?.conflicts.length ? reported.conflicts : undefined
    const thresholdResults = definition.kind === 'evaluation' && input.projectManifest.manifest.evaluation.profile === 'agent_dataset' ? thresholdResultsFor(input.projectManifest.manifest.evaluation.thresholds, metrics) : undefined
    const thresholdFailed = thresholdResults?.some((threshold) => !threshold.passed) ?? false
    const conclusion = timedOut ? 'cancelled' : result.status === 0 && !thresholdFailed && !metricConflicts ? 'success' : 'failure'
    const stdoutDigest = `sha256:${sha256(stdout)}`
    const stderrDigest = `sha256:${sha256(stderr)}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: definition.name, status: 'completed', conclusion, exitCode: result.status ?? undefined, durationMs, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.check_completed', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, name: definition.name, kind: definition.kind, conclusion, exitCode: result.status ?? null, durationMs, stdoutDigest, stderrDigest, provenance: testOrigin?.provenance ?? null, testTreeSha: testOrigin?.testTreeSha ?? null, metrics: metrics ?? null, metricConflicts: metricConflicts ?? null, thresholdResults: thresholdResults ?? null }, input.actorId)
    return { id: check.id, name: definition.name, kind: definition.kind, conclusion, exitCode: result.status ?? undefined, durationMs, stdoutDigest, stderrDigest, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr || result.error?.message || ''), provenance: testOrigin?.provenance, testTreeSha: testOrigin?.testTreeSha, agentModifiedTestFiles: testOrigin?.agentModifiedTestFiles, metrics, metricConflicts, thresholdResults }
  }

  /**
   * With a holdout configured, the checks run head code on the host too, and could read the holdout from the data
   * directory and print it into the evidence package. Where Seatbelt is available they run denied the data directory
   * (their own run directory and the repository's Git directory excepted) and a seal key kept elsewhere.
   */
  private checkCommand(input: AgentRunPostprocessorInput, definition: LocalCheckDefinition) {
    if (!input.projectManifest.manifest.evaluation.holdout || !seatbeltAvailable()) return { executable: definition.executable, args: definition.args }
    const gitCommonDirectory = resolve(input.worktreePath, execFileSync('git', ['-C', input.worktreePath, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim())
    const keyPath = this.input.database.eventSeals.keyPath
    return seatbeltCommand({ denied: [this.input.database.dataDirectory, ...(keyPath ? [keyPath] : [])], allowed: [dirname(input.worktreePath), gitCommonDirectory] }, definition.executable, definition.args)
  }

  private collectBuildArtifacts(input: AgentRunPostprocessorInput, checks: ExecutedCheck[]) {
    const definition = input.projectManifest.manifest.artifact
    if (!definition) return []
    const buildCheck = checks.find((check) => check.name === definition.buildCheck)
    if (!buildCheck || buildCheck.conclusion !== 'success') return []
    const artifacts = definition.outputs.map((path) => {
      const target = resolve(input.worktreePath, path)
      try {
        const stat = statSync(target)
        if (!stat.isFile()) throw new Error('not a file')
        return { path, sizeBytes: stat.size, sha256: `sha256:${sha256(readFileSync(target))}`, generatedByCheck: definition.buildCheck, sourceCommitSha: input.proposal.headSha, productionEligible: false as const }
      } catch {
        checks.push(this.recordArtifactFailure(input, path))
        return undefined
      }
    }).filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.artifacts_attested', { changeProposalId: input.proposal.id, headSha: input.proposal.headSha, manifestDigest: input.projectManifest.digest, buildCheck: definition.buildCheck, artifacts }, input.actorId)
    return artifacts
  }

  private recordArtifactFailure(input: AgentRunPostprocessorInput, path: string): ExecutedCheck {
    const message = `Declared build output is missing or not a file: ${path}`
    const stdoutDigest = `sha256:${sha256('')}`
    const stderrDigest = `sha256:${sha256(message)}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: `artifact-output:${path}`, status: 'completed', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.artifact_attestation_failed', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, path, reason: 'missing_or_not_file' }, input.actorId)
    return { id: check.id, name: `artifact-output:${path}`, kind: 'integrity', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: '', stderrExcerpt: message }
  }

  private recordEvaluationDatasetIntegrity(input: AgentRunPostprocessorInput): ExecutedCheck {
    const datasetPath = input.projectManifest.manifest.evaluation.datasetPath!
    let actualDigest = 'missing'
    try { actualDigest = `sha256:${sha256(readFileSync(resolve(input.worktreePath, datasetPath)))}` } catch {}
    const expectedDigest = input.projectManifest.evaluationDatasetDigest ?? 'missing'
    const passed = actualDigest === expectedDigest
    const stdout = JSON.stringify({ datasetPath, expectedDigest, actualDigest, passed })
    const stdoutDigest = `sha256:${sha256(stdout)}`
    const stderrDigest = `sha256:${sha256('')}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'evaluation-dataset-integrity', status: 'completed', conclusion: passed ? 'success' : 'failure', exitCode: passed ? 0 : 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.evaluation_dataset_verified', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, datasetPath, expectedDigest, actualDigest, passed }, input.actorId)
    return { id: check.id, name: 'evaluation-dataset-integrity', kind: 'integrity', conclusion: passed ? 'success' : 'failure', exitCode: passed ? 0 : 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: stdout, stderrExcerpt: '' }
  }

  private datasetState(input: AgentRunPostprocessorInput) {
    const path = resolve(input.worktreePath, input.projectManifest.manifest.evaluation.datasetPath!)
    try {
      const stat = statSync(path)
      return { digest: `sha256:${sha256(readFileSync(path))}`, inode: stat.ino, changedAtMs: stat.ctimeMs }
    } catch {
      return { digest: 'missing', inode: 0, changedAtMs: 0 }
    }
  }

  /**
   * The integrity check runs before the checks, and the code they run can write the worktree: a dataset swapped for
   * the evaluation and restored on exit has the right digest both times. Its inode change time cannot be set back
   * without root, so any write or replacement while the checks ran fails this.
   */
  private recordEvaluationDatasetUntouched(input: AgentRunPostprocessorInput, before: { digest: string; inode: number; changedAtMs: number }): ExecutedCheck {
    const after = this.datasetState(input)
    const passed = after.digest === before.digest && after.inode === before.inode && after.changedAtMs === before.changedAtMs
    const stdout = JSON.stringify({ datasetPath: input.projectManifest.manifest.evaluation.datasetPath, digestBefore: before.digest, digestAfter: after.digest, replaced: after.inode !== before.inode, written: after.changedAtMs !== before.changedAtMs, passed })
    const stdoutDigest = `sha256:${sha256(stdout)}`
    const stderrDigest = `sha256:${sha256('')}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'evaluation-dataset-untouched', status: 'completed', conclusion: passed ? 'success' : 'failure', exitCode: passed ? 0 : 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.evaluation_dataset_rechecked', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, passed, digestAfter: after.digest }, input.actorId)
    return { id: check.id, name: 'evaluation-dataset-untouched', kind: 'integrity', conclusion: passed ? 'success' : 'failure', exitCode: passed ? 0 : 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: stdout, stderrExcerpt: '' }
  }

  /**
   * The Builder is not given the dataset, but a process runtime can still read it from the worktree. Its answers
   * copied into the change (a lookup table, a hard-coded reply) make any score meaningless, so every dataset value
   * long enough to be specific is looked for in the lines the run added. Only digests of the matches are recorded,
   * so the check does not itself spread the holdout.
   */
  private baseDataset(input: AgentRunPostprocessorInput) {
    try { return execFileSync('git', ['-C', input.worktreePath, 'show', `${input.proposal.baseSha}:${input.projectManifest.manifest.evaluation.datasetPath!}`], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }) } catch { return '' }
  }

  /** `datasetPath` is the repository path of an in-worktree dataset (excluded from the diff), or `holdout:<digest>`. */
  private recordEvaluationDatasetLeakage(input: AgentRunPostprocessorInput, content: string, datasetPath: string): ExecutedCheck {
    const candidates = datasetLeakCandidates(content)
    const excluded = input.projectManifest.manifest.evaluation.datasetPath ? [`:(exclude)${input.projectManifest.manifest.evaluation.datasetPath}`] : []
    const added = new Map<string, string[]>()
    let file = ''
    for (const line of execFileSync('git', ['-C', input.worktreePath, 'diff', '--unified=0', '--no-color', '--no-ext-diff', input.proposal.baseSha, input.proposal.headSha, '--', '.', ...excluded], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).split('\n')) {
      if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//u, '')
      else if (line.startsWith('+')) added.set(file, [...(added.get(file) ?? []), line.slice(1)])
    }
    const leaks = candidates.flatMap((value) => {
      const forms = [value, JSON.stringify(value).slice(1, -1)]
      const files = [...added].filter(([, lines]) => lines.some((line) => forms.some((form) => line.includes(form)))).map(([path]) => path)
      return files.length ? [{ valueDigest: `sha256:${sha256(value)}`, files }] : []
    })
    const passed = leaks.length === 0
    const stdout = JSON.stringify({ datasetPath, candidateCount: candidates.length, minimumLength: DATASET_LEAK_MINIMUM_LENGTH, leakedValueCount: leaks.length, leaks: leaks.slice(0, 20), passed })
    const stdoutDigest = `sha256:${sha256(stdout)}`
    const stderrDigest = `sha256:${sha256('')}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'evaluation-dataset-leakage', status: 'completed', conclusion: passed ? 'success' : 'failure', exitCode: passed ? 0 : 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.evaluation_dataset_leakage_checked', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, datasetPath, candidateCount: candidates.length, leakedValueCount: leaks.length, leakedFiles: [...new Set(leaks.flatMap((leak) => leak.files))], passed }, input.actorId)
    return { id: check.id, name: 'evaluation-dataset-leakage', kind: 'integrity', conclusion: passed ? 'success' : 'failure', exitCode: passed ? 0 : 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: stdout, stderrExcerpt: '' }
  }

  private recordEvaluationHoldoutIntegrity(input: AgentRunPostprocessorInput, passed: boolean): ExecutedCheck {
    const digest = input.projectManifest.manifest.evaluation.holdout!.digest
    const stdout = JSON.stringify({ holdoutDigest: digest, registered: passed, passed })
    const stdoutDigest = `sha256:${sha256(stdout)}`
    const stderrDigest = `sha256:${sha256('')}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'evaluation-holdout-integrity', status: 'completed', conclusion: passed ? 'success' : 'failure', exitCode: passed ? 0 : 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.evaluation_holdout_verified', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, holdoutDigest: digest, passed }, input.actorId)
    return { id: check.id, name: 'evaluation-holdout-integrity', kind: 'integrity', conclusion: passed ? 'success' : 'failure', exitCode: passed ? 0 : 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: stdout, stderrExcerpt: '' }
  }

  /** Extracts `paths` (everything when empty) of a revision into `target`, from the object store rather than the worktree. */
  private extractRevision(input: AgentRunPostprocessorInput, sha: string, paths: string[], target: string) {
    const archive = spawnSync('git', ['-C', input.worktreePath, 'archive', '--format=tar', sha, ...(paths.length ? ['--', ...paths] : [])], { maxBuffer: 512 * 1024 * 1024 })
    if (archive.status !== 0) throw new Error(`git archive ${sha.slice(0, 12)} failed: ${archive.stderr?.toString().trim() || archive.error?.message}`)
    const unpacked = spawnSync('tar', ['-x', '-f', '-', '-C', target], { input: archive.stdout, maxBuffer: 16 * 1024 * 1024 })
    if (unpacked.status !== 0) throw new Error(`tar failed: ${unpacked.stderr?.toString().trim() || unpacked.error?.message}`)
  }

  private runPhase(phase: EvaluationPhase['phase'], definition: ProjectEvaluationProcess, cwd: string, env: Record<string, string>, stdin: string, wrap?: (executable: string, args: string[]) => { executable: string; args: string[] }) {
    const started = Date.now()
    const command = wrap ? wrap(definition.command[0], definition.command.slice(1)) : { executable: definition.command[0], args: definition.command.slice(1) }
    const result = spawnSync(command.executable, command.args, { cwd, input: stdin, encoding: 'utf8', timeout: definition.timeoutMs, maxBuffer: 20 * 1024 * 1024, env })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const summary: EvaluationPhase = { phase, exitCode: result.status, durationMs: Date.now() - started, timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', stdoutDigest: `sha256:${sha256(stdout)}`, stderrDigest: `sha256:${sha256(stderr)}`, ...(result.error ? { error: result.error.message } : {}) }
    return { stdout, stderr, summary }
  }

  /**
   * The isolated evaluator. The grader (the manifest's harnessPaths at the base revision) and the code under evaluation
   * (the head revision) are extracted into separate directories under the data directory, never the worktree. The
   * grader turns the holdout into inputs; the subject answers them on stdout, sandboxed so that it cannot read the
   * holdout, the grader, the repository or the Control Plane's data, cannot write outside its scratch directory and
   * has no network; the grader then scores the answers. Only the grader's final stdout is parsed for metrics.
   */
  private executeIsolatedEvaluation(input: AgentRunPostprocessorInput, holdout: string, harnessProvenance: CheckProvenance) {
    const evaluation = input.projectManifest.manifest.evaluation
    const started = Date.now()
    const confine = seatbeltAvailable()
    const builderHoldoutReadable = input.attestation.holdoutReadable !== false
    const evaluationRoot = join(this.input.database.dataDirectory, 'evaluations')
    mkdirSync(evaluationRoot, { recursive: true, mode: 0o700 })
    chmodSync(evaluationRoot, 0o700)
    const root = mkdtempSync(join(evaluationRoot, `${input.runId}-`))
    const [graderDirectory, subjectDirectory, scratchDirectory] = ['grader', 'subject', 'scratch'].map((name) => join(root, name))
    const holdoutPath = join(root, 'holdout.jsonl')
    const outputsPath = join(root, 'outputs.jsonl')
    const phases: EvaluationPhase[] = []
    let graderStdout = ''
    let stderrExcerpt = ''
    let setupError: string | undefined
    let subjectConfinement: { kind: 'seatbelt'; profileDigest: string } | undefined
    try {
      for (const directory of [graderDirectory, subjectDirectory, scratchDirectory]) mkdirSync(directory, { mode: 0o700 })
      writeFileSync(holdoutPath, holdout, { mode: 0o600 })
      this.extractRevision(input, input.proposal.baseSha, evaluation.harnessPaths!, graderDirectory)
      this.extractRevision(input, input.proposal.headSha, [], subjectDirectory)
      const base = { PATH: process.env.PATH ?? '', CI: 'true', NO_COLOR: '1' }
      const graderEnv = { ...base, HOME: scratchDirectory, TMPDIR: scratchDirectory, APERTURE_EVALUATION_DATASET: holdoutPath, APERTURE_EVALUATION_DATASET_DIGEST: evaluation.holdout!.digest }
      const inputs = this.runPhase('inputs', evaluation.grader!, graderDirectory, { ...graderEnv, APERTURE_EVALUATION_PHASE: 'inputs' }, '')
      phases.push(inputs.summary)
      stderrExcerpt += inputs.stderr
      if (inputs.summary.exitCode === 0) {
        const policy = { denied: [this.input.database.dataDirectory, input.proposal.repositoryPath, dirname(input.worktreePath), root, ...(this.input.database.eventSeals.keyPath ? [this.input.database.eventSeals.keyPath] : [])], allowed: [subjectDirectory, scratchDirectory], writableOnly: [scratchDirectory], denyNetwork: true }
        const subject = this.runPhase('subject', evaluation.subject!, subjectDirectory, { ...base, HOME: scratchDirectory, TMPDIR: scratchDirectory }, inputs.stdout, confine ? (executable, args) => {
          const command = seatbeltCommand(policy, executable, args)
          subjectConfinement = { kind: 'seatbelt', profileDigest: command.profileDigest }
          return command
        } : undefined)
        // The subject's output is the grader's input, never parsed here: a metrics line it prints scores nothing.
        phases.push(subject.summary)
        if (subject.summary.exitCode === 0) {
          writeFileSync(outputsPath, subject.stdout, { mode: 0o600 })
          const score = this.runPhase('score', evaluation.grader!, graderDirectory, { ...graderEnv, APERTURE_EVALUATION_PHASE: 'score', APERTURE_EVALUATION_OUTPUTS: outputsPath }, '')
          phases.push(score.summary)
          graderStdout = score.stdout
          stderrExcerpt += score.stderr
        }
      }
    } catch (error) {
      setupError = error instanceof Error ? error.message : String(error)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    const reported = phases.some((phase) => phase.phase === 'score') ? evaluationMetrics(graderStdout) : undefined
    const metrics = reported?.metrics
    const metricConflicts = reported?.conflicts.length ? reported.conflicts : undefined
    const thresholdResults = thresholdResultsFor(evaluation.thresholds, metrics)
    const timedOut = phases.some((phase) => phase.timedOut)
    const completed = !setupError && phases.length === 3 && phases.every((phase) => phase.exitCode === 0)
    const conclusion = timedOut ? 'cancelled' : completed && !metricConflicts && thresholdResults.every((threshold) => threshold.passed) ? 'success' : 'failure'
    const provenance: CheckProvenance = harnessProvenance !== 'unverified' && subjectConfinement && !builderHoldoutReadable ? 'isolated' : 'isolated_partial'
    const durationMs = Date.now() - started
    const failedPhase = phases.find((phase) => phase.exitCode !== 0)
    const stderr = [setupError, failedPhase ? `phase ${failedPhase.phase} exited ${failedPhase.exitCode ?? 'without status'}${failedPhase.error ? `: ${failedPhase.error}` : ''}` : '', stderrExcerpt].filter(Boolean).join('\n')
    const stdoutDigest = `sha256:${sha256(graderStdout)}`
    const stderrDigest = `sha256:${sha256(stderr)}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'evaluation-isolated', status: 'completed', conclusion, exitCode: completed ? 0 : 1, durationMs, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.check_completed', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'evaluation-isolated', kind: 'evaluation', conclusion, exitCode: completed ? 0 : 1, durationMs, stdoutDigest, stderrDigest, provenance, testTreeSha: input.proposal.baseSha, holdoutDigest: evaluation.holdout!.digest, phases, subjectConfinement: subjectConfinement ?? null, builderHoldoutReadable, setupError: setupError ?? null, metrics: metrics ?? null, metricConflicts: metricConflicts ?? null, thresholdResults }, input.actorId)
    // Only the grader's output is excerpted: the subject's streams carry the holdout's inputs and would spread them.
    return {
      check: { id: check.id, name: 'evaluation-isolated', kind: 'evaluation', conclusion, exitCode: completed ? 0 : 1, durationMs, stdoutDigest, stderrDigest, stdoutExcerpt: excerpt(graderStdout), stderrExcerpt: excerpt(stderr), provenance, testTreeSha: input.proposal.baseSha, metrics, metricConflicts, thresholdResults } satisfies ExecutedCheck,
      subjectConfinement,
      builderHoldoutReadable,
    }
  }

  private recordDirtyWorkspace(input: AgentRunPostprocessorInput, dirty: string): ExecutedCheck {
    const stdoutDigest = `sha256:${sha256('')}`
    const stderrDigest = `sha256:${sha256(dirty)}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'workspace-clean', status: 'completed', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.check_completed', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'workspace-clean', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest }, input.actorId)
    return { id: check.id, name: 'workspace-clean', kind: 'integrity', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: '', stderrExcerpt: excerpt(dirty) }
  }
}
