import { execFileSync } from 'node:child_process'
import { resolveProjectRepository } from './code-host/index.ts'
import { loadProjectManifest, PROJECT_MANIFEST_PATH } from './project-manifest.ts'
import { AppError, type Project } from './types.ts'

/** What the builders in scripts/agents inline into the prompt across all declared context; the rest is cut off. */
export const CONTEXT_PROMPT_BUDGET_BYTES = 200_000
/** Files an agent engine reads by itself from the worktree root, outside the declared context and its reconciliation. */
const AGENT_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md']
const PREVIEW_LIMIT_BYTES = 256 * 1024

type Database = { getProject(projectId: string): Project; dataDirectory: string }

export type ProjectContextFile = {
  path: string
  required: boolean
  exists: boolean
  sizeBytes?: number
  lastCommit?: { sha: string; author: string; committedAt: string; subject: string }
  editUrl?: string
}

export type ProjectContextIssue = { severity: 'error' | 'warning'; code: string; message: string; path?: string }

export type ProjectContext = {
  projectId: string
  branch: string
  baseSha: string
  manifestPath: string
  manifestFound: boolean
  manifestError?: string
  files: ProjectContextFile[]
  requiredBytes: number
  budgetBytes: number
  issues: ProjectContextIssue[]
}

/** The head of a project's default branch in its working repository; `undefined` when the project has no repository yet. */
export function projectDefaultBranchHead(database: Database, projectId: string) {
  const project = database.getProject(projectId)
  if (project.codeHost === 'local' && !project.repositoryPath) return undefined
  const { host, repositoryPath } = resolveProjectRepository(database, projectId)
  host.prepareForRun()
  try {
    const baseSha = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--verify', `${project.defaultBranch}^{commit}`], { encoding: 'utf8' }).trim()
    return { project, repositoryPath, baseSha }
  } catch {
    throw new AppError(409, `Project ${project.slug} has no branch ${project.defaultBranch}`, 'project_default_branch_missing')
  }
}

function git(repositoryPath: string, args: string[]) {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }).trim()
  } catch {
    return undefined
  }
}

function blobSize(repositoryPath: string, baseSha: string, path: string) {
  if (git(repositoryPath, ['cat-file', '-t', `${baseSha}:${path}`]) !== 'blob') return undefined
  return Number(git(repositoryPath, ['cat-file', '-s', `${baseSha}:${path}`]))
}

function editUrl(project: Project, path: string) {
  const { owner, repo, webBase } = project.codeHostConfig
  if (project.codeHost !== 'github' || !owner || !repo) return undefined
  return `${(webBase ?? 'https://github.com').replace(/\/+$/u, '')}/${owner}/${repo}/edit/${project.defaultBranch}/${path}`
}

/** The manifest's context lists as written, for a manifest that does not validate; nothing else in it is trusted. */
function rawContext(repositoryPath: string, baseSha: string) {
  try {
    const context = JSON.parse(git(repositoryPath, ['show', `${baseSha}:${PROJECT_MANIFEST_PATH}`]) ?? '').context
    const paths = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
    return { required: paths(context?.required), allowed: paths(context?.allowed) }
  } catch {
    return { required: [], allowed: [] }
  }
}

/**
 * The context a Run started now would be given: the manifest's lists on the default branch, whether each file is there,
 * what it costs of the prompt budget and who last changed it. Read-only. The files are changed in the repository through
 * review, so what this shows is what a Run binds, not a copy that could drift from it.
 */
export function projectContext(database: Database, projectId: string): ProjectContext | undefined {
  const head = projectDefaultBranchHead(database, projectId)
  if (!head) return undefined
  const { project, repositoryPath, baseSha } = head
  const issues: ProjectContextIssue[] = []
  let required: string[] = []
  let allowed: string[] = []
  let manifestFound = true
  let manifestError: string | undefined
  try {
    ;({ required, allowed } = loadProjectManifest(repositoryPath, baseSha).manifest.context)
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    if (error.code === 'project_manifest_missing') {
      manifestFound = false
      issues.push({ severity: 'error', code: 'manifest_missing', message: `${project.defaultBranch} 上没有 ${PROJECT_MANIFEST_PATH}，Run 无法启动` })
    } else {
      manifestError = error.message
      issues.push({ severity: 'error', code: 'manifest_invalid', message: `${PROJECT_MANIFEST_PATH} 无法通过校验，Run 会被拒绝：${error.message}` })
      ;({ required, allowed } = rawContext(repositoryPath, baseSha))
    }
  }

  const requiredSet = new Set(required)
  const allowedSet = new Set(allowed)
  const files = [...new Set([...required, ...allowed])].map((path): ProjectContextFile => {
    const sizeBytes = blobSize(repositoryPath, baseSha, path)
    const [sha, author, committedAt, subject] = (git(repositoryPath, ['log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s', baseSha, '--', path]) ?? '').split('\x1f')
    return { path, required: requiredSet.has(path), exists: sizeBytes !== undefined, sizeBytes, lastCommit: sha ? { sha, author, committedAt, subject } : undefined, editUrl: editUrl(project, path) }
  })
  for (const file of files) {
    if (!file.exists) issues.push({ severity: file.required ? 'error' : 'warning', code: 'file_missing', path: file.path, message: file.required ? `必需上下文 ${file.path} 在 ${project.defaultBranch} 上不存在，Agent 拿不到它` : `可追加的上下文 ${file.path} 在 ${project.defaultBranch} 上不存在` })
    if (file.required && !allowedSet.has(file.path)) issues.push({ severity: 'error', code: 'required_not_allowed', path: file.path, message: `${file.path} 在 required 中但不在 allowed 中` })
  }
  const requiredBytes = files.filter((file) => file.required).reduce((total, file) => total + (file.sizeBytes ?? 0), 0)
  if (requiredBytes > CONTEXT_PROMPT_BUDGET_BYTES) issues.push({ severity: 'warning', code: 'budget_exceeded', message: `必需上下文合计 ${requiredBytes} 字节，超过 ${CONTEXT_PROMPT_BUDGET_BYTES} 字节的提示词预算，超出部分会被截断` })
  for (const path of AGENT_INSTRUCTION_FILES) {
    if (!allowedSet.has(path) && blobSize(repositoryPath, baseSha, path) !== undefined) issues.push({ severity: 'warning', code: 'undeclared_instructions', path, message: `${path} 会被 Agent 引擎自动读取，但没有在 manifest 中声明，读取不会进入上下文对账` })
  }
  return { projectId, branch: project.defaultBranch, baseSha, manifestPath: PROJECT_MANIFEST_PATH, manifestFound, manifestError, files, requiredBytes, budgetBytes: CONTEXT_PROMPT_BUDGET_BYTES, issues }
}

/** One declared context file at the default branch head. Only paths the manifest lists can be read through here. */
export function projectContextFile(database: Database, projectId: string, path: string) {
  const context = projectContext(database, projectId)
  const file = context?.files.find((entry) => entry.path === path)
  if (!context || !file) throw new AppError(404, `${path} is not declared as context of this project`, 'context_file_not_declared')
  if (!file.exists) throw new AppError(404, `${path} does not exist on ${context.branch}`, 'context_file_missing')
  const { repositoryPath } = resolveProjectRepository(database, projectId)
  const content = execFileSync('git', ['-C', repositoryPath, 'show', `${context.baseSha}:${path}`], { maxBuffer: 64 * 1024 * 1024 })
  return { path, baseSha: context.baseSha, sizeBytes: content.length, truncated: content.length > PREVIEW_LIMIT_BYTES, content: content.subarray(0, PREVIEW_LIMIT_BYTES).toString('utf8') }
}
