import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { AppError, type Project } from '../types.ts'
import type { CodeHost, CodeHostConnection, CodeHostFactoryContext } from './types.ts'

/** Directories the control plane writes itself. A project pointing into one could make a run edit platform state. */
export const MANAGED_DATA_SUBDIRECTORIES = ['agent-runs', 'repositories', 'evidence']

function gitOrUndefined(repositoryPath: string, args: string[]) {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function inside(child: string, parent: string) {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

/**
 * The only way a local path enters a project. It must be absolute (a relative path would resolve against wherever the
 * server happened to start), exist, be the top of a Git work tree, have the default branch, and not sit inside the
 * directories the control plane manages. Returns the canonical top-level path.
 */
export function validateLocalRepository(repositoryPath: string, defaultBranch: string, dataDirectory: string) {
  if (!isAbsolute(repositoryPath)) throw new AppError(400, 'Repository path must be absolute', 'repository_path_not_absolute')
  let real: string
  try {
    real = realpathSync(repositoryPath)
  } catch {
    throw new AppError(400, 'Repository path does not exist', 'invalid_repository')
  }
  if (gitOrUndefined(real, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw new AppError(400, 'Repository path is not a Git work tree', 'invalid_repository')
  const topLevel = realpathSync(gitOrUndefined(real, ['rev-parse', '--show-toplevel']) ?? real)
  let dataReal: string
  try {
    dataReal = realpathSync(dataDirectory)
  } catch {
    dataReal = resolve(dataDirectory)
  }
  if (topLevel === dataReal || MANAGED_DATA_SUBDIRECTORIES.some((name) => inside(topLevel, resolve(dataReal, name)))) throw new AppError(400, 'Repository path is inside a directory the control plane manages', 'repository_inside_data_directory')
  if (!gitOrUndefined(topLevel, ['rev-parse', '--verify', '--quiet', `refs/heads/${defaultBranch}^{commit}`])) throw new AppError(400, `Default branch ${defaultBranch} does not exist in the repository`, 'default_branch_not_found')
  return topLevel
}

/** A repository on this machine. Runs, proposals and merges operate on it directly; nothing is published anywhere. */
export class LocalCodeHost implements CodeHost {
  readonly descriptor
  private readonly project: Project
  private readonly context: CodeHostFactoryContext

  constructor(project: Project, context: CodeHostFactoryContext) {
    this.project = project
    this.context = context
    this.descriptor = { provider: 'local' as const, repository: project.repositoryPath ?? '', mergeMode: project.mergeMode }
  }

  workingRepository() {
    if (!this.project.repositoryPath) throw new AppError(409, `Project ${this.project.slug} has no repository configured yet`, 'project_repository_unconfigured')
    return this.project.repositoryPath
  }

  prepareForRun() {}

  publishMerge() {}

  async testConnection(): Promise<CodeHostConnection> {
    try {
      validateLocalRepository(this.workingRepository(), this.project.defaultBranch, this.context.dataDirectory)
      return { ok: true, repositoryReachable: true, defaultBranchFound: true, credentialPresent: true, missingPermissions: [], message: 'Local repository is a Git work tree with the default branch.' }
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'invalid_repository'
      return { ok: false, repositoryReachable: code !== 'invalid_repository' && code !== 'project_repository_unconfigured', defaultBranchFound: false, credentialPresent: true, missingPermissions: [], message: error instanceof Error ? error.message : String(error) }
    }
  }
}
