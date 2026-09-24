import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { AppError, type CodeHostKind, type GithubHostConfig, type MergeMode, type Project } from '../types.ts'
import { GithubCodeHost, normalizeGithubHost } from './github.ts'
import { LocalCodeHost, validateLocalRepository } from './local.ts'
import type { CodeHost, CodeHostFactory, CodeHostFactoryContext } from './types.ts'

export type ProjectHostInput = {
  codeHost: CodeHostKind
  repositoryPath?: string | null
  codeHostConfig?: Record<string, unknown>
  defaultBranch?: string
  mergeMode?: MergeMode
}

export type NormalizedProjectHost = { codeHost: CodeHostKind; codeHostConfig: Partial<GithubHostConfig>; repositoryPath: string | null; defaultBranch: string; mergeMode: MergeMode }

const hostFactories: Partial<Record<CodeHostKind, CodeHostFactory>> = {
  local: (project, context) => new LocalCodeHost(project, context),
  github: (project, context) => new GithubCodeHost(project, context),
}
const hostNormalizers: Partial<Record<CodeHostKind, (input: ProjectHostInput, context: { dataDirectory: string; projectId: string }) => NormalizedProjectHost>> = {
  local: (input, context) => {
    const defaultBranch = input.defaultBranch?.trim() || 'main'
    const mergeMode = input.mergeMode ?? 'control_plane'
    // Nothing but the control plane can merge into a repository on this machine.
    if (mergeMode !== 'control_plane') throw new AppError(400, 'A local repository can only be merged by the control plane', 'merge_mode_unsupported')
    const path = input.repositoryPath?.trim()
    return { codeHost: 'local', codeHostConfig: {}, repositoryPath: path ? validateLocalRepository(path, defaultBranch, context.dataDirectory) : null, defaultBranch, mergeMode }
  },
  github: (input, context) => normalizeGithubHost(input, context),
}

/** Lets another module add a host (a test double, a future GitLab) without this file importing it. */
export function registerCodeHost(kind: CodeHostKind, factory: CodeHostFactory, normalize: NonNullable<(typeof hostNormalizers)[CodeHostKind]>) {
  hostFactories[kind] = factory
  hostNormalizers[kind] = normalize
}

export function normalizeProjectHost(input: ProjectHostInput, context: { dataDirectory: string; projectId: string }): NormalizedProjectHost {
  const branch = input.defaultBranch?.trim() || 'main'
  if (!/^[\w][\w./-]{0,199}$/u.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) throw new AppError(400, 'defaultBranch is not a valid branch name', 'invalid_default_branch')
  const normalize = hostNormalizers[input.codeHost]
  if (!normalize) throw new AppError(400, `Unsupported code host ${String(input.codeHost)}`, 'unsupported_code_host')
  return normalize(input, context)
}

export function codeHostFor(project: Project, context: CodeHostFactoryContext): CodeHost {
  const factory = hostFactories[project.codeHost]
  if (!factory) throw new AppError(500, `No code host implementation for ${project.codeHost}`, 'unsupported_code_host')
  return factory(project, context)
}

/**
 * The project's host and its working repository, with the one check every caller that used to accept a path still
 * needs: a path that is given has to be that repository, so no caller can point a run or proposal somewhere else.
 */
export function resolveProjectRepository(database: { getProject(projectId: string): Project; dataDirectory: string }, projectId: string, requestedPath?: string) {
  const project = database.getProject(projectId)
  if (project.status === 'archived') throw new AppError(409, `Project ${project.slug} is archived`, 'project_archived')
  const host = codeHostFor(project, { dataDirectory: database.dataDirectory, env: process.env })
  const repositoryPath = host.workingRepository()
  if (requestedPath !== undefined && canonical(requestedPath) !== canonical(repositoryPath)) throw new AppError(409, `Repository ${requestedPath} is not the repository of project ${project.slug}`, 'repository_project_mismatch')
  return { project, host, repositoryPath }
}

function canonical(path: string) {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

export type { CodeHost, CodeHostConnection, CodeHostDescriptor, CodeHostFactoryContext } from './types.ts'
