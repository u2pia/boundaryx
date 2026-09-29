import { execFileSync } from 'node:child_process'
import { resolveProjectRepository } from './code-host/index.ts'
import { CONTEXT_PROMPT_BUDGET_BYTES } from './declared-context.ts'
import { loadProjectManifest, PROJECT_MANIFEST_PATH } from './project-manifest.ts'
import { PROJECT_SKILL_MAX_BYTES } from './project-skills.ts'
import { sha256 } from './security.ts'
import { AppError, type Project } from './types.ts'
import { GIT_NO_EXEC } from './worktree-git.ts'

/**
 * Files an agent engine may read by itself from the worktree root, outside the declared context and its reconciliation:
 * Codex reads AGENTS.md. Claude Code runs with `--setting-sources user`, which per its documentation leaves project
 * CLAUDE.md files out; that is not verified against a live engine, so they are still flagged.
 */
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

export type ProjectSkill = {
  name: string
  path: string
  description: string
  exists: boolean
  sizeBytes?: number
  contentDigest?: string
  lastCommit?: { sha: string; author: string; committedAt: string; subject: string }
  editUrl?: string
}

export type ProjectContext = {
  projectId: string
  branch: string
  baseSha: string
  manifestPath: string
  manifestFound: boolean
  manifestError?: string
  files: ProjectContextFile[]
  skills: ProjectSkill[]
  requiredBytes: number
  budgetBytes: number
  /** Whether the chat engine gets a shell (`run_command`); only an aperture.project.v2 manifest can allow one. */
  builder: { schemaVersion?: string; allowShell: boolean }
  issues: ProjectContextIssue[]
}

/** The head of a project's default branch in its working repository; `undefined` when the project has no repository yet. */
export function projectDefaultBranchHead(database: Database, projectId: string) {
  const project = database.getProject(projectId)
  if (project.codeHost === 'local' && !project.repositoryPath) return undefined
  const { host, repositoryPath } = resolveProjectRepository(database, projectId)
  host.prepareForRun()
  try {
    const baseSha = execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'rev-parse', '--verify', `${project.defaultBranch}^{commit}`], { encoding: 'utf8' }).trim()
    return { project, repositoryPath, baseSha }
  } catch {
    throw new AppError(409, `Project ${project.slug} has no branch ${project.defaultBranch}`, 'project_default_branch_missing')
  }
}

function git(repositoryPath: string, args: string[]) {
  try {
    return execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }).trim()
  } catch {
    return undefined
  }
}

function blobSize(repositoryPath: string, baseSha: string, path: string) {
  if (git(repositoryPath, ['cat-file', '-t', `${baseSha}:${path}`]) !== 'blob') return undefined
  return Number(git(repositoryPath, ['cat-file', '-s', `${baseSha}:${path}`]))
}

function blobContent(repositoryPath: string, baseSha: string, path: string) {
  try {
    return execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'show', `${baseSha}:${path}`], { maxBuffer: 4 * 1024 * 1024 })
  } catch {
    return undefined
  }
}

function editUrl(project: Project, path: string) {
  const { owner, repo, webBase } = project.codeHostConfig
  if (project.codeHost !== 'github' || !owner || !repo) return undefined
  return `${(webBase ?? 'https://github.com').replace(/\/+$/u, '')}/${owner}/${repo}/edit/${project.defaultBranch}/${path}`
}

/** The manifest's context lists as written, for a manifest that does not validate; nothing else in it is trusted. */
function rawProjectConfiguration(repositoryPath: string, baseSha: string) {
  try {
    const raw = JSON.parse(git(repositoryPath, ['show', `${baseSha}:${PROJECT_MANIFEST_PATH}`]) ?? '')
    const context = raw.context
    const paths = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
    const skills = Array.isArray(raw.skills) ? raw.skills.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const skill = entry as Record<string, unknown>
      return typeof skill.name === 'string' && typeof skill.path === 'string' && typeof skill.description === 'string'
        ? [{ name: skill.name, path: skill.path, description: skill.description }]
        : []
    }) : []
    return { required: paths(context?.required), allowed: paths(context?.allowed), skills }
  } catch {
    return { required: [], allowed: [], skills: [] }
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
  let declaredSkills: Array<{ name: string; path: string; description: string }> = []
  let manifestFound = true
  let manifestError: string | undefined
  let builder: ProjectContext['builder'] = { allowShell: false }
  try {
    const { manifest } = loadProjectManifest(repositoryPath, baseSha)
    ;({ required, allowed } = manifest.context)
    declaredSkills = manifest.skills ?? []
    builder = { schemaVersion: manifest.schemaVersion, allowShell: manifest.builder?.allowShell === true }
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    if (error.code === 'project_manifest_missing') {
      manifestFound = false
      issues.push({ severity: 'error', code: 'manifest_missing', message: `${project.defaultBranch} 上没有 ${PROJECT_MANIFEST_PATH}，Run 无法启动` })
    } else {
      manifestError = error.message
      issues.push({ severity: 'error', code: 'manifest_invalid', message: `${PROJECT_MANIFEST_PATH} 无法通过校验，Run 会被拒绝：${error.message}` })
      ;({ required, allowed, skills: declaredSkills } = rawProjectConfiguration(repositoryPath, baseSha))
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
    if (!file.exists) issues.push({ severity: file.required ? 'error' : 'warning', code: 'file_missing', path: file.path, message: file.required ? `必需上下文 ${file.path} 在 ${project.defaultBranch} 上不存在，Run 会被拒绝` : `可追加的上下文 ${file.path} 在 ${project.defaultBranch} 上不存在` })
    if (file.required && !allowedSet.has(file.path)) issues.push({ severity: 'error', code: 'required_not_allowed', path: file.path, message: `${file.path} 在 required 中但不在 allowed 中` })
  }
  const requiredBytes = files.filter((file) => file.required).reduce((total, file) => total + (file.sizeBytes ?? 0), 0)
  if (requiredBytes > CONTEXT_PROMPT_BUDGET_BYTES) issues.push({ severity: 'error', code: 'budget_exceeded', message: `必需上下文合计 ${requiredBytes} 字节，超过 ${CONTEXT_PROMPT_BUDGET_BYTES} 字节的提示词预算，Run 会被拒绝；把部分文件移到 allowed 或缩短它们` })
  for (const path of AGENT_INSTRUCTION_FILES) {
    if (!allowedSet.has(path) && blobSize(repositoryPath, baseSha, path) !== undefined) issues.push({ severity: 'warning', code: 'undeclared_instructions', path, message: `${path} 可能被 Agent 引擎自动读取，但没有在 manifest 中声明，读取不会进入上下文对账` })
  }
  const skills = declaredSkills.map((skill): ProjectSkill => {
    const content = blobContent(repositoryPath, baseSha, skill.path)
    const [sha, author, committedAt, subject] = (git(repositoryPath, ['log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s', baseSha, '--', skill.path]) ?? '').split('\x1f')
    return {
      ...skill,
      exists: content !== undefined,
      sizeBytes: content?.length,
      contentDigest: content ? `sha256:${sha256(content)}` : undefined,
      lastCommit: sha ? { sha, author, committedAt, subject } : undefined,
      editUrl: editUrl(project, skill.path),
    }
  })
  for (const skill of skills) {
    if (!skill.exists) issues.push({ severity: 'error', code: 'skill_missing', path: skill.path, message: `Skill ${skill.name} 声明的文件 ${skill.path} 在 ${project.defaultBranch} 上不存在，无法被加载` })
    if ((skill.sizeBytes ?? 0) > PROJECT_SKILL_MAX_BYTES) issues.push({ severity: 'error', code: 'skill_too_large', path: skill.path, message: `Skill ${skill.name} 为 ${skill.sizeBytes} 字节，超过 ${PROJECT_SKILL_MAX_BYTES} 字节的单文件上限` })
  }
  return { projectId, branch: project.defaultBranch, baseSha, manifestPath: PROJECT_MANIFEST_PATH, manifestFound, manifestError, files, skills, requiredBytes, budgetBytes: CONTEXT_PROMPT_BUDGET_BYTES, builder, issues }
}

/** One declared context or Skill file at the default branch head. */
export function projectContextFile(database: Database, projectId: string, path: string) {
  const context = projectContext(database, projectId)
  const file = context?.files.find((entry) => entry.path === path) ?? context?.skills.find((entry) => entry.path === path)
  if (!context || !file) throw new AppError(404, `${path} is not declared as context or a Skill of this project`, 'context_file_not_declared')
  if (!file.exists) throw new AppError(404, `${path} does not exist on ${context.branch}`, 'context_file_missing')
  const { repositoryPath } = resolveProjectRepository(database, projectId)
  const content = execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'show', `${context.baseSha}:${path}`], { maxBuffer: 64 * 1024 * 1024 })
  return { path, baseSha: context.baseSha, sizeBytes: content.length, truncated: content.length > PREVIEW_LIMIT_BYTES, content: content.subarray(0, PREVIEW_LIMIT_BYTES).toString('utf8') }
}
