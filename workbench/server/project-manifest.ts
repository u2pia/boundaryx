import { execFileSync } from 'node:child_process'
import { posix } from 'node:path'
import { sha256 } from './security.ts'
import { AppError, type AgentRunnerDescriptor, type IntentVersion, type WorkItem } from './types.ts'

export const PROJECT_MANIFEST_PATH = '.aperture/project.json'

export type ProjectManifestCheck = {
  name: string
  kind: 'test' | 'evaluation' | 'build'
  command: string[]
  timeoutMs: number
}

export type ProjectEvaluationThreshold = {
  metric: string
  operator: 'gte' | 'lte'
  threshold: number
}

export type ProjectManifest = {
  schemaVersion: 'aperture.project.v1'
  productType: WorkItem['productType']
  context: {
    required: string[]
    allowed: string[]
  }
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

function parseManifest(raw: string): ProjectManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError(422, `${PROJECT_MANIFEST_PATH} is not valid JSON`, 'invalid_project_manifest')
  }
  const root = requireObject(parsed, PROJECT_MANIFEST_PATH)
  if (root.schemaVersion !== 'aperture.project.v1') throw new AppError(422, 'Unsupported project manifest schemaVersion', 'unsupported_project_manifest')
  if (root.productType !== 'application' && root.productType !== 'agent_system') throw new AppError(422, 'productType must be application or agent_system', 'invalid_project_manifest')

  const context = requireObject(root.context, 'context')
  const required = stringArray(context.required, 'context.required')
  const allowed = stringArray(context.allowed, 'context.allowed')
  const allowedSet = new Set(allowed)
  for (const requiredPath of required) if (!allowedSet.has(requiredPath)) throw new AppError(422, `Required context path is not allowed: ${requiredPath}`, 'invalid_project_manifest')

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
    const datasetPath = normalizeRepositoryPath(configured.datasetPath, 'evaluation.datasetPath')
    if (required.includes(datasetPath) || allowed.includes(datasetPath)) throw new AppError(422, 'Evaluation dataset must not be exposed through Builder Context', 'evaluation_dataset_context_exposed')
    if (!Array.isArray(configured.thresholds) || !configured.thresholds.length) throw new AppError(422, 'Agent systems require at least one evaluation threshold', 'invalid_project_manifest')
    const thresholds = configured.thresholds.map((item, index) => {
      const threshold = requireObject(item, `evaluation.thresholds[${index}]`)
      if (typeof threshold.metric !== 'string' || !threshold.metric.trim()) throw new AppError(422, `evaluation.thresholds[${index}].metric is required`, 'invalid_project_manifest')
      if (threshold.operator !== 'gte' && threshold.operator !== 'lte') throw new AppError(422, `evaluation.thresholds[${index}].operator must be gte or lte`, 'invalid_project_manifest')
      if (typeof threshold.threshold !== 'number' || !Number.isFinite(threshold.threshold)) throw new AppError(422, `evaluation.thresholds[${index}].threshold must be finite`, 'invalid_project_manifest')
      return { metric: threshold.metric.trim(), operator: threshold.operator, threshold: threshold.threshold }
    })
    if (!checks.some((check) => check.kind === 'evaluation')) throw new AppError(422, 'Agent systems require at least one evaluation check', 'invalid_project_manifest')
    evaluation = { profile: 'agent_dataset', datasetPath, thresholds }
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

  return {
    schemaVersion: 'aperture.project.v1',
    productType: root.productType,
    context: { required, allowed },
    checks,
    testPaths,
    evaluation,
    artifact,
    policy: { maximumRisk: policy.maximumRisk as IntentVersion['riskLevel'], allowUnisolatedRuntime: policy.allowUnisolatedRuntime },
  }
}

export function loadProjectManifest(repositoryPath: string, baseSha: string): ProjectManifestBinding {
  let raw: string
  try {
    raw = execFileSync('git', ['-C', repositoryPath, 'show', `${baseSha}:${PROJECT_MANIFEST_PATH}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  } catch {
    throw new AppError(422, `Base revision must contain ${PROJECT_MANIFEST_PATH}`, 'project_manifest_missing')
  }
  const manifest = parseManifest(raw)
  let evaluationDatasetDigest: string | undefined
  if (manifest.evaluation.datasetPath) {
    try {
      const dataset = execFileSync('git', ['-C', repositoryPath, 'show', `${baseSha}:${manifest.evaluation.datasetPath}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
      evaluationDatasetDigest = `sha256:${sha256(dataset)}`
    } catch {
      throw new AppError(422, `Evaluation dataset is missing from the base revision: ${manifest.evaluation.datasetPath}`, 'evaluation_dataset_missing')
    }
  }
  return { path: PROJECT_MANIFEST_PATH, baseSha, digest: `sha256:${sha256(JSON.stringify(manifest))}`, manifest, evaluationDatasetDigest }
}

export function applyProjectManifest(input: { binding: ProjectManifestBinding; workItem: WorkItem; intent: IntentVersion; runtime: AgentRunnerDescriptor; declaredContextPaths: string[] }) {
  const { manifest } = input.binding
  if (manifest.productType !== input.workItem.productType) throw new AppError(409, `Work item product type does not match the project manifest: the work item is ${input.workItem.productType}, .aperture/project.json declares ${manifest.productType}`, 'project_manifest_product_mismatch')
  const riskRank = { low: 0, medium: 1, high: 2 }
  if (riskRank[input.intent.riskLevel] > riskRank[manifest.policy.maximumRisk]) throw new AppError(409, `Intent risk ${input.intent.riskLevel} exceeds project maximum ${manifest.policy.maximumRisk}`, 'project_manifest_risk_exceeded')
  if (input.runtime.isolation === 'unisolated_process' && !manifest.policy.allowUnisolatedRuntime) throw new AppError(409, 'Project policy forbids the configured unisolated process runtime', 'project_manifest_runtime_forbidden')

  const requested = input.declaredContextPaths.length ? [...new Set(input.declaredContextPaths.map((value, index) => normalizeRepositoryPath(value, `declaredContextPaths[${index}]`)))] : manifest.context.required
  const requestedSet = new Set(requested)
  for (const requiredPath of manifest.context.required) if (!requestedSet.has(requiredPath)) throw new AppError(409, `Required context path was not declared: ${requiredPath}`, 'project_manifest_context_required')
  const allowedSet = new Set(manifest.context.allowed)
  for (const requestedPath of requested) if (!allowedSet.has(requestedPath)) throw new AppError(409, `Context path is not allowed by the project manifest: ${requestedPath}`, 'project_manifest_context_forbidden')
  return requested
}
