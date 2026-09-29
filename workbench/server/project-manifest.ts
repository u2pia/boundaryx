import { execFileSync } from 'node:child_process'
import { posix } from 'node:path'
import { sha256 } from './security.ts'
import { AppError, type AgentRunnerDescriptor, type IntentVersion, type WorkItem } from './types.ts'
import { GIT_NO_EXEC } from './worktree-git.ts'

export const PROJECT_MANIFEST_PATH = '.aperture/project.json'
export const PROJECT_SKILLS_PATH_PREFIX = '.aperture/skills/'

export type ProjectManifestCheck = {
  name: string
  kind: 'test' | 'evaluation' | 'build'
  command: string[]
  timeoutMs: number
}

export type ProjectEvaluationProcess = {
  command: string[]
  timeoutMs: number
}

export type ProjectEvaluationThreshold = {
  metric: string
  operator: 'gte' | 'lte'
  threshold: number
}

export type ProjectManifestSkill = {
  name: string
  path: string
  description: string
}

export const PROJECT_MANIFEST_VERSIONS = ['aperture.project.v1', 'aperture.project.v2'] as const

export type ProjectManifest = {
  schemaVersion: (typeof PROJECT_MANIFEST_VERSIONS)[number]
  productType: WorkItem['productType']
  context: {
    required: string[]
    allowed: string[]
  }
  /** Versioned, repository-owned operating instructions that a Builder may load explicitly. */
  skills?: ProjectManifestSkill[]
  checks: ProjectManifestCheck[]
  /**
   * Repository paths that hold the project's own acceptance tests. Files under these paths
   * are owned by the project, not by an agent run: the Control Plane re-runs every test check
   * against the base revision of these paths so that a change cannot pass on tests it authored
   * itself. Empty means no independent baseline signal is available.
   */
  testPaths: string[]
  evaluation: {
    profile: 'application_checks' | 'agent_dataset'
    datasetPath?: string
    /**
     * Repository paths of the grader: the code that reads the dataset and prints the metrics. An unchanged dataset
     * says nothing about honest scoring when the run can edit the scorer, so an evaluation is independent evidence
     * only when the run left these paths untouched, and is re-run with them reset to the base revision when it did
     * not. Undeclared means no evaluation result in the package is independent.
     */
    harnessPaths?: string[]
    /**
     * A dataset registered with the Control Plane instead of committed to the repository, so the Builder never sees it.
     * The grader (`harnessPaths` at the base revision) and the code under evaluation (the head revision) run in
     * separate directories outside the worktree; the subject runs sandboxed, reading the grader's inputs on stdin and
     * answering on stdout, and only the grader reads the dataset and prints `evaluation_metrics`.
     */
    holdout?: { digest: string }
    grader?: ProjectEvaluationProcess
    subject?: ProjectEvaluationProcess
    thresholds: ProjectEvaluationThreshold[]
  }
  artifact?: {
    profile: 'application_build'
    buildCheck: string
    outputs: string[]
  }
  policy: {
    maximumRisk: IntentVersion['riskLevel']
    allowUnisolatedRuntime: boolean
  }
  /**
   * What the Builder may do beyond reading and editing files (v2 only). `allowShell` gives the chat engine its
   * `run_command` tool, which runs any command in the worktree; without it the chat engine only reads and writes files.
   */
  builder?: { allowShell: boolean }
}

export type ProjectManifestBinding = {
  path: typeof PROJECT_MANIFEST_PATH
  baseSha: string
  digest: string
  manifest: ProjectManifest
  evaluationDatasetDigest?: string
}

function requireObject(value: unknown, path: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(422, `${path} must be an object`, 'invalid_project_manifest')
  return value as Record<string, unknown>
}

function normalizeRepositoryPath(value: unknown, path: string) {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(422, `${path} must be a non-empty repository-relative path`, 'invalid_project_manifest')
  const candidate = value.trim().replaceAll('\\', '/')
  const normalized = posix.normalize(candidate)
  if (candidate.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized !== candidate) throw new AppError(422, `${path} must be a normalized repository-relative path`, 'invalid_project_manifest')
  return normalized
}

function stringArray(value: unknown, path: string) {
  if (!Array.isArray(value)) throw new AppError(422, `${path} must be an array`, 'invalid_project_manifest')
  return [...new Set(value.map((item, index) => normalizeRepositoryPath(item, `${path}[${index}]`)))]
}

function evaluationProcess(value: unknown, path: string): ProjectEvaluationProcess {
  const configured = requireObject(value, path)
  if (!Array.isArray(configured.command) || configured.command.length === 0 || configured.command.some((item) => typeof item !== 'string' || !item)) throw new AppError(422, `${path}.command must be a non-empty string array`, 'invalid_project_manifest')
  const timeoutMs = configured.timeoutMs === undefined ? 5 * 60 * 1000 : Number(configured.timeoutMs)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60 * 1000) throw new AppError(422, `${path}.timeoutMs must be between 1000 and 1800000`, 'invalid_project_manifest')
  return { command: configured.command as string[], timeoutMs }
}

function parseManifest(raw: string): ProjectManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError(422, `${PROJECT_MANIFEST_PATH} is not valid JSON`, 'invalid_project_manifest')
  }
  const root = requireObject(parsed, PROJECT_MANIFEST_PATH)
  const schemaVersion = PROJECT_MANIFEST_VERSIONS.find((version) => version === root.schemaVersion)
  if (!schemaVersion) throw new AppError(422, `Unsupported project manifest schemaVersion; use ${PROJECT_MANIFEST_VERSIONS.join(' or ')}`, 'unsupported_project_manifest')
  if (root.productType !== 'application' && root.productType !== 'agent_system') throw new AppError(422, 'productType must be application or agent_system', 'invalid_project_manifest')

  const context = requireObject(root.context, 'context')
  const required = stringArray(context.required, 'context.required')
  const allowed = stringArray(context.allowed, 'context.allowed')
  const allowedSet = new Set(allowed)
  for (const requiredPath of required) if (!allowedSet.has(requiredPath)) throw new AppError(422, `Required context path is not allowed: ${requiredPath}`, 'invalid_project_manifest')

  let skills: ProjectManifestSkill[] | undefined
  if (root.skills !== undefined) {
    if (!Array.isArray(root.skills)) throw new AppError(422, 'skills must be an array', 'invalid_project_manifest')
    const names = new Set<string>()
    const paths = new Set<string>()
    skills = root.skills.map((item, index) => {
      const skill = requireObject(item, `skills[${index}]`)
      if (typeof skill.name !== 'string' || !skill.name.trim()) throw new AppError(422, `skills[${index}].name is required`, 'invalid_project_manifest')
      const name = skill.name.trim()
      if (name.length > 80) throw new AppError(422, `skills[${index}].name must be at most 80 characters`, 'invalid_project_manifest')
      if (names.has(name)) throw new AppError(422, `Duplicate skill name: ${name}`, 'invalid_project_manifest')
      names.add(name)
      const path = normalizeRepositoryPath(skill.path, `skills[${index}].path`)
      if (!path.startsWith(PROJECT_SKILLS_PATH_PREFIX)) throw new AppError(422, `skills[${index}].path must be under ${PROJECT_SKILLS_PATH_PREFIX}`, 'invalid_project_manifest')
      if (paths.has(path)) throw new AppError(422, `Duplicate skill path: ${path}`, 'invalid_project_manifest')
      paths.add(path)
      if (typeof skill.description !== 'string' || !skill.description.trim()) throw new AppError(422, `skills[${index}].description is required`, 'invalid_project_manifest')
      const description = skill.description.trim()
      if (description.length > 200) throw new AppError(422, `skills[${index}].description must be at most 200 characters`, 'invalid_project_manifest')
      return { name, path, description }
    })
  }

  if (!Array.isArray(root.checks) || root.checks.length === 0) throw new AppError(422, 'checks must contain at least one deterministic check', 'invalid_project_manifest')
  const checkNames = new Set<string>()
  const checks = root.checks.map((item, index) => {
    const check = requireObject(item, `checks[${index}]`)
    if (typeof check.name !== 'string' || !check.name.trim()) throw new AppError(422, `checks[${index}].name is required`, 'invalid_project_manifest')
    const name = check.name.trim()
    if (checkNames.has(name)) throw new AppError(422, `Duplicate check name: ${name}`, 'invalid_project_manifest')
    checkNames.add(name)
    if (!Array.isArray(check.command) || check.command.length === 0 || check.command.some((value) => typeof value !== 'string' || !value)) throw new AppError(422, `checks[${index}].command must be a non-empty string array`, 'invalid_project_manifest')
    const timeoutMs = check.timeoutMs === undefined ? 5 * 60 * 1000 : Number(check.timeoutMs)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60 * 1000) throw new AppError(422, `checks[${index}].timeoutMs must be between 1000 and 1800000`, 'invalid_project_manifest')
    const kind = check.kind === undefined ? 'test' : check.kind
    if (kind !== 'test' && kind !== 'evaluation' && kind !== 'build') throw new AppError(422, `checks[${index}].kind must be test, evaluation or build`, 'invalid_project_manifest')
    return { name, kind, command: check.command as string[], timeoutMs }
  })

  const testPaths = root.testPaths === undefined ? [] : stringArray(root.testPaths, 'testPaths')
  if (root.testPaths !== undefined && !testPaths.length) throw new AppError(422, 'testPaths must contain at least one path when declared', 'invalid_project_manifest')

  let evaluation: ProjectManifest['evaluation']
  let artifact: ProjectManifest['artifact']
  if (root.productType === 'agent_system') {
    const configured = requireObject(root.evaluation, 'evaluation')
    if (configured.profile !== 'agent_dataset') throw new AppError(422, 'Agent systems require evaluation.profile agent_dataset', 'invalid_project_manifest')
    if ((configured.datasetPath === undefined) === (configured.holdout === undefined)) throw new AppError(422, 'Agent systems declare exactly one of evaluation.datasetPath and evaluation.holdout', 'invalid_project_manifest')
    let datasetPath: string | undefined
    let holdout: { digest: string } | undefined
    if (configured.holdout !== undefined) {
      const declared = requireObject(configured.holdout, 'evaluation.holdout')
      if (typeof declared.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(declared.digest)) throw new AppError(422, 'evaluation.holdout.digest must be sha256:<64 hex>', 'invalid_project_manifest')
      holdout = { digest: declared.digest }
    } else {
      datasetPath = normalizeRepositoryPath(configured.datasetPath, 'evaluation.datasetPath')
      if (required.includes(datasetPath) || allowed.includes(datasetPath)) throw new AppError(422, 'Evaluation dataset must not be exposed through Builder Context', 'evaluation_dataset_context_exposed')
    }
    if (!Array.isArray(configured.thresholds) || !configured.thresholds.length) throw new AppError(422, 'Agent systems require at least one evaluation threshold', 'invalid_project_manifest')
    const thresholds = configured.thresholds.map((item, index) => {
      const threshold = requireObject(item, `evaluation.thresholds[${index}]`)
      if (typeof threshold.metric !== 'string' || !threshold.metric.trim()) throw new AppError(422, `evaluation.thresholds[${index}].metric is required`, 'invalid_project_manifest')
      if (threshold.operator !== 'gte' && threshold.operator !== 'lte') throw new AppError(422, `evaluation.thresholds[${index}].operator must be gte or lte`, 'invalid_project_manifest')
      if (typeof threshold.threshold !== 'number' || !Number.isFinite(threshold.threshold)) throw new AppError(422, `evaluation.thresholds[${index}].threshold must be finite`, 'invalid_project_manifest')
      return { metric: threshold.metric.trim(), operator: threshold.operator, threshold: threshold.threshold }
    })
    const harnessPaths = configured.harnessPaths === undefined ? undefined : stringArray(configured.harnessPaths, 'evaluation.harnessPaths')
    if (harnessPaths && !harnessPaths.length) throw new AppError(422, 'evaluation.harnessPaths must contain at least one path when declared', 'invalid_project_manifest')
    if (holdout) {
      // The holdout run is the evaluation: an in-worktree evaluation check would need the dataset beside the code under test.
      if (checks.some((check) => check.kind === 'evaluation')) throw new AppError(422, 'An evaluation.holdout replaces evaluation checks; remove checks of kind evaluation', 'invalid_project_manifest')
      if (!harnessPaths) throw new AppError(422, 'evaluation.holdout requires evaluation.harnessPaths: the grader is taken from them at the base revision', 'invalid_project_manifest')
      const grader = evaluationProcess(configured.grader, 'evaluation.grader')
      const subject = evaluationProcess(configured.subject, 'evaluation.subject')
      evaluation = { profile: 'agent_dataset', holdout, harnessPaths, grader, subject, thresholds }
    } else {
      if (configured.grader !== undefined || configured.subject !== undefined) throw new AppError(422, 'evaluation.grader and evaluation.subject apply only to evaluation.holdout', 'invalid_project_manifest')
      if (!checks.some((check) => check.kind === 'evaluation')) throw new AppError(422, 'Agent systems require at least one evaluation check', 'invalid_project_manifest')
      evaluation = { profile: 'agent_dataset', datasetPath, ...(harnessPaths ? { harnessPaths } : {}), thresholds }
    }
  } else {
    if (root.evaluation !== undefined) {
      const configured = requireObject(root.evaluation, 'evaluation')
      if (configured.profile !== 'application_checks') throw new AppError(422, 'Applications require evaluation.profile application_checks', 'invalid_project_manifest')
    }
    evaluation = { profile: 'application_checks', thresholds: [] }
    if (root.artifact !== undefined) {
      const configured = requireObject(root.artifact, 'artifact')
      if (configured.profile !== 'application_build') throw new AppError(422, 'Applications require artifact.profile application_build', 'invalid_project_manifest')
      if (typeof configured.buildCheck !== 'string' || !configured.buildCheck.trim()) throw new AppError(422, 'artifact.buildCheck is required', 'invalid_project_manifest')
      const buildCheck = configured.buildCheck.trim()
      if (!checks.some((check) => check.name === buildCheck && check.kind === 'build')) throw new AppError(422, 'artifact.buildCheck must reference a build check', 'invalid_project_manifest')
      const outputs = stringArray(configured.outputs, 'artifact.outputs')
      if (!outputs.length) throw new AppError(422, 'artifact.outputs must contain at least one path', 'invalid_project_manifest')
      artifact = { profile: 'application_build', buildCheck, outputs }
    }
  }
  if (root.productType === 'agent_system' && root.artifact !== undefined) throw new AppError(422, 'Agent systems cannot declare application build artifacts', 'invalid_project_manifest')

  const policy = requireObject(root.policy, 'policy')
  if (!['low', 'medium', 'high'].includes(String(policy.maximumRisk))) throw new AppError(422, 'policy.maximumRisk must be low, medium or high', 'invalid_project_manifest')
  if (typeof policy.allowUnisolatedRuntime !== 'boolean') throw new AppError(422, 'policy.allowUnisolatedRuntime must be boolean', 'invalid_project_manifest')

  // A v1 manifest has no builder section: one there would look like a setting the Control Plane ignores. A v2 manifest
  // without one gets the defaults written out, so its digest records what the Builder was allowed.
  let builder: ProjectManifest['builder']
  if (schemaVersion === 'aperture.project.v1') {
    if (root.builder !== undefined) throw new AppError(422, 'builder requires schemaVersion aperture.project.v2', 'invalid_project_manifest')
  } else {
    const configured = root.builder === undefined ? {} : requireObject(root.builder, 'builder')
    const unknown = Object.keys(configured).filter((key) => key !== 'allowShell')
    if (unknown.length) throw new AppError(422, `Unknown builder settings: ${unknown.join(', ')}`, 'invalid_project_manifest')
    if (configured.allowShell !== undefined && typeof configured.allowShell !== 'boolean') throw new AppError(422, 'builder.allowShell must be boolean', 'invalid_project_manifest')
    builder = { allowShell: configured.allowShell === true }
  }

  return {
    schemaVersion,
    productType: root.productType,
    context: { required, allowed },
    ...(skills ? { skills } : {}),
    checks,
    testPaths,
    evaluation,
    artifact,
    policy: { maximumRisk: policy.maximumRisk as IntentVersion['riskLevel'], allowUnisolatedRuntime: policy.allowUnisolatedRuntime },
    ...(builder ? { builder } : {}),
  }
}

export function loadProjectManifest(repositoryPath: string, baseSha: string): ProjectManifestBinding {
  let raw: string
  try {
    raw = execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'show', `${baseSha}:${PROJECT_MANIFEST_PATH}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  } catch {
    throw new AppError(422, `Base revision must contain ${PROJECT_MANIFEST_PATH}`, 'project_manifest_missing')
  }
  const manifest = parseManifest(raw)
  let evaluationDatasetDigest: string | undefined = manifest.evaluation.holdout?.digest
  if (manifest.evaluation.datasetPath) {
    try {
      const dataset = execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'show', `${baseSha}:${manifest.evaluation.datasetPath}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
      evaluationDatasetDigest = `sha256:${sha256(dataset)}`
    } catch {
      throw new AppError(422, `Evaluation dataset is missing from the base revision: ${manifest.evaluation.datasetPath}`, 'evaluation_dataset_missing')
    }
  }
  return { path: PROJECT_MANIFEST_PATH, baseSha, digest: `sha256:${sha256(JSON.stringify(manifest))}`, manifest, evaluationDatasetDigest }
}

export function validateIntentVerifiedBy(manifest: ProjectManifest, intent: IntentVersion) {
  const checks = new Map(manifest.checks.map((check) => [check.name, check]))
  const compatibleKinds: Record<IntentVersion['acceptanceCriteria'][number]['verificationType'], Set<ProjectManifestCheck['kind']>> = {
    deterministic: new Set(['test', 'evaluation', 'build']),
    model: new Set(['evaluation']),
    human: new Set(),
  }
  const invalid = intent.acceptanceCriteria.flatMap((criterion) => (criterion.verifiedBy ?? []).flatMap((name) => {
    const check = checks.get(name)
    if (!check) return [`AC-${criterion.ordinal} declares missing check ${name}`]
    if (!compatibleKinds[criterion.verificationType].has(check.kind)) return [`AC-${criterion.ordinal} (${criterion.verificationType}) cannot be verified by ${name} (${check.kind})`]
    return []
  }))
  if (invalid.length) throw new AppError(409, `Intent verifiedBy does not match ${PROJECT_MANIFEST_PATH}@${intent.id}: ${invalid.join('; ')}`, 'intent_verified_by_invalid')
}

export function applyProjectManifest(input: { binding: ProjectManifestBinding; workItem: WorkItem; intent: IntentVersion; runtime: AgentRunnerDescriptor; declaredContextPaths: string[] }) {
  const { manifest } = input.binding
  if (manifest.productType !== input.workItem.productType) throw new AppError(409, `Work item product type does not match the project manifest: the work item is ${input.workItem.productType}, .aperture/project.json declares ${manifest.productType}. Rebuild the Intent with the project's type (Intents → 详情 → 按项目类型重建).`, 'project_manifest_product_mismatch')
  validateIntentVerifiedBy(manifest, input.intent)
  const riskRank = { low: 0, medium: 1, high: 2 }
  if (riskRank[input.intent.riskLevel] > riskRank[manifest.policy.maximumRisk]) throw new AppError(409, `Intent risk ${input.intent.riskLevel} exceeds project maximum ${manifest.policy.maximumRisk}`, 'project_manifest_risk_exceeded')
  if (input.runtime.isolation === 'unisolated_process' && !manifest.policy.allowUnisolatedRuntime) throw new AppError(409, 'Project policy forbids the configured unisolated process runtime', 'project_manifest_runtime_forbidden')

  // Required context is always part of the run, so a declaration only adds to it; what it may add is still bounded by `allowed`.
  const requested = [...new Set([...manifest.context.required, ...input.declaredContextPaths.map((value, index) => normalizeRepositoryPath(value, `declaredContextPaths[${index}]`))])]
  const allowedSet = new Set(manifest.context.allowed)
  for (const requestedPath of requested) if (!allowedSet.has(requestedPath)) throw new AppError(409, `Context path is not allowed by the project manifest: ${requestedPath} (allowed: ${manifest.context.allowed.join(', ')})`, 'project_manifest_context_forbidden')
  return requested
}
