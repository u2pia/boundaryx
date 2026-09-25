import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ControlPlaneDatabase } from './database.ts'
import type { AgentRunPostprocessor, AgentRunPostprocessorInput } from './git-worktree-agent-runner.ts'
import type { LocalEvidenceStore } from './local-evidence-store.ts'
import type { ProjectEvaluationThreshold } from './project-manifest.ts'
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
 */
export type CheckProvenance = 'all_tests' | 'pre_existing' | 'unverified'

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
  thresholdResults?: Array<ProjectEvaluationThreshold & { actual?: number; passed: boolean }>
}

function excerpt(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/gu, '').slice(0, 4000)
}

function evaluationMetrics(stdout: string) {
  const metrics: Record<string, number> = {}
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (value.type !== 'evaluation_metrics' || !value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)) continue
      for (const [name, metric] of Object.entries(value.metrics as Record<string, unknown>)) if (typeof metric === 'number' && Number.isFinite(metric)) metrics[name] = metric
    } catch {}
  }
  return metrics
}

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
    if (input.projectManifest.manifest.evaluation.profile === 'agent_dataset') checks.push(this.recordEvaluationDatasetIntegrity(input))
    checks.push(...manifestChecks.map((check) => this.executeCheck({ name: check.name, kind: check.kind, executable: check.command[0], args: check.command.slice(1), timeoutMs: check.timeoutMs }, input, check.kind === 'test' ? { provenance: headProvenance, testTreeSha: input.proposal.headSha, agentModifiedTestFiles } : undefined)))
    if (agentModifiedTestFiles.length) checks.push(...this.executeBaselineTestChecks(input, testPaths, agentModifiedTestFiles))
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
    }
    const criteriaCoverage = mapCriteriaToChecks(input.intent, checks)
    const runEvents = this.input.database.listAggregateEvents('agent_run', input.runId)
    const proposalEvents = this.input.database.listAggregateEvents('change_proposal', input.proposal.id)
    // Which project and host this evidence is about. The pull request, if any, is opened after the package is sealed
    // and is linked from the proposal instead.
    const project = this.input.database.getProject(input.proposal.projectId)
    const hosted = project.codeHost === 'github' ? { repository: `${project.codeHostConfig.owner}/${project.codeHostConfig.repo}`, webUrl: `${project.codeHostConfig.webBase}/${project.codeHostConfig.owner}/${project.codeHostConfig.repo}` } : { repository: project.repositoryPath ?? input.proposal.repositoryPath }
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
      // DOMAIN_MODEL.md §9.1.1: marked prominently when the run edited the rules that govern it. Every check above ran
      // under the base revision's manifest, so none of them evaluates the new rules.
      policyChanges: { pathPrefix: POLICY_PATH_PREFIX, files: input.proposal.policyFiles ?? [], governedBy: `${input.projectManifest.path}@${input.projectManifest.baseSha}` },
      artifacts,
      provenance: { runEventChainHead: runEvents.at(-1)?.eventDigest ?? 'genesis', proposalEventChainHead: proposalEvents.at(-1)?.eventDigest ?? 'genesis', generatedBy: 'local-run-postprocessor@0.1' },
    })
    const failedChecks = checks.filter((check) => check.conclusion === 'failure' || check.conclusion === 'cancelled').length
    const evidence = this.input.database.recordEvidence({ proposalId: input.proposal.id, runId: input.runId, headSha: input.proposal.headSha, uri: stored.uri, sha256: stored.sha256, summary: { status: failedChecks ? 'blocked' : checks.length ? 'ready' : 'incomplete', totalChecks: checks.length, failedChecks, testProvenance: headProvenance, independentTestSignal: testProvenance.baselineConclusions.length > 0 || headProvenance === 'pre_existing', agentModifiedTestFileCount: agentModifiedTestFiles.length, evaluationProfile: input.projectManifest.manifest.evaluation.profile, evaluationDatasetDigest: input.projectManifest.evaluationDatasetDigest, artifactCount: artifacts.length, policyFiles: input.proposal.policyFiles ?? [], builderStopped: input.builderStopped ?? null, criteriaCoverage, packageSchema: stored.value.schemaVersion, generatedAt: stored.value.generatedAt, trustMode: this.input.database.getIdentityMode() } }, input.actorId)
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
   * Re-runs every declared test check with the test files reset to the proposal base revision, so
   * that the package carries at least one conclusion the agent could not have authored the tests for.
   */
  private executeBaselineTestChecks(input: AgentRunPostprocessorInput, testPaths: string[], agentModifiedTestFiles: string[]): ExecutedCheck[] {
    const definitions = input.projectManifest.manifest.checks.filter((check) => check.kind === 'test')
    if (!definitions.length) return []
    const headFiles = this.treeFiles(input.worktreePath, input.proposal.headSha, testPaths)
    const baseFiles = this.treeFiles(input.worktreePath, input.proposal.baseSha, testPaths)
    const results: ExecutedCheck[] = []
    try {
      this.materializeTestPaths(input.worktreePath, input.proposal.baseSha, testPaths, headFiles)
    } catch (error) {
      return [this.recordBaselineUnavailable(input, error instanceof Error ? error.message : String(error))]
    }
    try {
      for (const definition of definitions) results.push(this.executeCheck({ name: `${definition.name}@baseline`, kind: definition.kind, executable: definition.command[0], args: definition.command.slice(1), timeoutMs: definition.timeoutMs }, input, { provenance: 'pre_existing', testTreeSha: input.proposal.baseSha, agentModifiedTestFiles }))
    } finally {
      this.materializeTestPaths(input.worktreePath, input.proposal.headSha, testPaths, baseFiles)
    }
    return results
  }

  private recordBaselineUnavailable(input: AgentRunPostprocessorInput, reason: string): ExecutedCheck {
    const message = `Could not reset declared test paths to base revision ${input.proposal.baseSha}: ${reason}`
    const stdoutDigest = `sha256:${sha256('')}`
    const stderrDigest = `sha256:${sha256(message)}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'baseline-tests-available', status: 'completed', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.baseline_tests_unavailable', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, baseSha: input.proposal.baseSha, reason }, input.actorId)
    return { id: check.id, name: 'baseline-tests-available', kind: 'integrity', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: '', stderrExcerpt: message }
  }

  private executeCheck(definition: LocalCheckDefinition, input: AgentRunPostprocessorInput, testOrigin?: { provenance: CheckProvenance; testTreeSha: string; agentModifiedTestFiles: string[] }): ExecutedCheck {
    const started = Date.now()
    const result = spawnSync(definition.executable, definition.args, { cwd: input.worktreePath, encoding: 'utf8', timeout: definition.timeoutMs, maxBuffer: 10 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CI: 'true', NO_COLOR: '1', ...(definition.kind === 'evaluation' && input.projectManifest.manifest.evaluation.datasetPath ? { APERTURE_EVALUATION_DATASET: input.projectManifest.manifest.evaluation.datasetPath, APERTURE_EVALUATION_DATASET_DIGEST: input.projectManifest.evaluationDatasetDigest ?? '' } : {}) } })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const durationMs = Date.now() - started
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    const metrics = definition.kind === 'evaluation' ? evaluationMetrics(stdout) : undefined
    const thresholdResults = definition.kind === 'evaluation' && input.projectManifest.manifest.evaluation.profile === 'agent_dataset' ? input.projectManifest.manifest.evaluation.thresholds.map((threshold) => { const actual = metrics?.[threshold.metric]; return { ...threshold, actual, passed: actual !== undefined && (threshold.operator === 'gte' ? actual >= threshold.threshold : actual <= threshold.threshold) } }) : undefined
    const thresholdFailed = thresholdResults?.some((threshold) => !threshold.passed) ?? false
    const conclusion = timedOut ? 'cancelled' : result.status === 0 && !thresholdFailed ? 'success' : 'failure'
    const stdoutDigest = `sha256:${sha256(stdout)}`
    const stderrDigest = `sha256:${sha256(stderr)}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: definition.name, status: 'completed', conclusion, exitCode: result.status ?? undefined, durationMs, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.check_completed', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, name: definition.name, kind: definition.kind, conclusion, exitCode: result.status ?? null, durationMs, stdoutDigest, stderrDigest, provenance: testOrigin?.provenance ?? null, testTreeSha: testOrigin?.testTreeSha ?? null, metrics: metrics ?? null, thresholdResults: thresholdResults ?? null }, input.actorId)
    return { id: check.id, name: definition.name, kind: definition.kind, conclusion, exitCode: result.status ?? undefined, durationMs, stdoutDigest, stderrDigest, stdoutExcerpt: excerpt(stdout), stderrExcerpt: excerpt(stderr || result.error?.message || ''), provenance: testOrigin?.provenance, testTreeSha: testOrigin?.testTreeSha, agentModifiedTestFiles: testOrigin?.agentModifiedTestFiles, metrics, thresholdResults }
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

  private recordDirtyWorkspace(input: AgentRunPostprocessorInput, dirty: string): ExecutedCheck {
    const stdoutDigest = `sha256:${sha256('')}`
    const stderrDigest = `sha256:${sha256(dirty)}`
    const check = this.input.database.recordCheck({ proposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'workspace-clean', status: 'completed', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, source: 'run', runId: input.runId }, input.actorId)
    this.input.database.recordAgentRunEvent(input.runId, 'agent_run.check_completed', { checkId: check.id, changeProposalId: input.proposal.id, headSha: input.proposal.headSha, name: 'workspace-clean', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest }, input.actorId)
    return { id: check.id, name: 'workspace-clean', kind: 'integrity', conclusion: 'failure', exitCode: 1, durationMs: 0, stdoutDigest, stderrDigest, stdoutExcerpt: '', stderrExcerpt: excerpt(dirty) }
  }
}
